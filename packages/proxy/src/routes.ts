// Routing table for the LAN SSRF guard: which interface would this Mac send a packet out of?
// Parsed from `netstat -rn` (macOS; physical iOS devices need a Mac anyway), longest-prefix match,
// cached and refreshed in the background — never a subprocess per connection.
import { execFile } from 'child_process';
import * as net from 'net';
import * as os from 'os';

export interface RouteTable {
  /** Interface the packet to `ip` would leave through, or undefined if no route. */
  lookup(ip: string): string | undefined;
  readonly size: number;
}

// ---------------------------------------------------------------- address math

function expandV6(a: string): string {
  if (!a.includes('::')) return a;
  const [l, r] = a.split('::');
  const left = l ? l.split(':') : [];
  const right = r ? r.split(':') : [];
  const fill = new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...fill, ...right].join(':');
}

export function ipToBig(ip: string): { v6: boolean; n: bigint } | undefined {
  if (net.isIPv4(ip)) return { v6: false, n: ip.split('.').reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n) };
  if (net.isIPv6(ip)) {
    // dotted tail (::ffff:1.2.3.4) is normalised by the caller; plain hex groups here
    return { v6: true, n: expandV6(ip).split(':').reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
  }
  return undefined;
}

const maskOf = (n: bigint, bits: number, width: number) => (bits === 0 ? 0n : (n >> BigInt(width - bits)) << BigInt(width - bits));

// ---------------------------------------------------------------- parsing

/** netstat's IPv4 destinations: "default", "10.1.2.3", "192.168.0" (= /24), "127" (= /8), "10.0/16", "0/1". */
function parseV4Dest(dest: string, isHost: boolean): { addr: string; bits: number } | undefined {
  if (dest === 'default') return { addr: '0.0.0.0', bits: 0 };
  const [a, b] = dest.split('/');
  const parts = a.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p) || Number(p) > 255)) return undefined;
  const addr = [...parts, '0', '0', '0'].slice(0, 4).join('.');
  const bits = b !== undefined ? Number(b) : isHost || parts.length === 4 ? 32 : parts.length * 8;
  return Number.isInteger(bits) && bits >= 0 && bits <= 32 ? { addr, bits } : undefined;
}

function parseV6Dest(dest: string, isHost: boolean): { addr: string; bits: number } | undefined {
  if (dest === 'default') return { addr: '::', bits: 0 };
  if (dest.includes('%')) return undefined; // link-local, interface-scoped: hard-forbidden anyway
  const [a, b] = dest.split('/');
  if (!net.isIPv6(a)) return undefined;
  const bits = b !== undefined ? Number(b) : isHost ? 128 : 128;
  return Number.isInteger(bits) && bits >= 0 && bits <= 128 ? { addr: a, bits } : undefined;
}

class LpmTable implements RouteTable {
  // bits → (masked network → interface), searched from the longest prefix down
  private readonly v4 = new Map<number, Map<bigint, string>>();
  private readonly v6 = new Map<number, Map<bigint, string>>();
  private v4Bits: number[] = [];
  private v6Bits: number[] = [];
  size = 0;

  add(v6: boolean, addr: string, bits: number, netif: string): void {
    const b = ipToBig(addr);
    if (!b || b.v6 !== v6) return;
    const table = v6 ? this.v6 : this.v4;
    let m = table.get(bits);
    if (!m) table.set(bits, (m = new Map()));
    const key = maskOf(b.n, bits, v6 ? 128 : 32);
    if (!m.has(key)) {
      m.set(key, netif); // first wins: netstat lists the preferred route first
      this.size++;
    }
  }

  seal(): this {
    this.v4Bits = [...this.v4.keys()].sort((x, y) => y - x);
    this.v6Bits = [...this.v6.keys()].sort((x, y) => y - x);
    return this;
  }

  lookup(ip: string): string | undefined {
    const b = ipToBig(ip);
    if (!b) return undefined;
    const width = b.v6 ? 128 : 32;
    const table = b.v6 ? this.v6 : this.v4;
    for (const bits of b.v6 ? this.v6Bits : this.v4Bits) {
      const hit = table.get(bits)!.get(maskOf(b.n, bits, width));
      if (hit) return hit;
    }
    return undefined;
  }
}

/**
 * Parse `netstat -rn -f inet` and/or `-f inet6` output (concatenated is fine). Interface-scoped
 * routes (flag I: per-interface defaults of VPNs, ARP entries) only apply to sockets bound to that
 * interface, so they are skipped; the unscoped table is what an ordinary connect() uses.
 */
export function parseNetstatRoutes(text: string): RouteTable {
  const t = new LpmTable();
  let family: 'v4' | 'v6' | undefined;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (/^Internet:$/.test(l)) {
      family = 'v4';
      continue;
    }
    if (/^Internet6:$/.test(l)) {
      family = 'v6';
      continue;
    }
    if (!family || !l || l.startsWith('Destination') || l.startsWith('Routing')) continue;
    const cols = l.split(/\s+/);
    if (cols.length < 4) continue;
    const [dest, , flags, netif] = cols;
    if (!flags.includes('U') || flags.includes('I')) continue; // not up, or interface-scoped
    const isHost = flags.includes('H');
    const d = family === 'v4' ? parseV4Dest(dest, isHost) : parseV6Dest(dest, isHost);
    if (d) t.add(family === 'v6', d.addr, d.bits, netif);
  }
  return t.seal();
}

// ---------------------------------------------------------------- cache

const REFRESH_MS = 10_000;
const IFACE_CHECK_MS = 1_000;

export const routesTesting: {
  /** Use this table (or `null` = "unreadable") instead of the system's. */
  table?: RouteTable | null;
} = {};

let cache: { table: RouteTable | null; at: number; ifSig: string } | undefined;
let refreshing: Promise<void> | undefined;
let lastIfCheck = 0;
let ifChangePending = false;
let warned = false;

function ifaceSignature(): string {
  return JSON.stringify(
    Object.entries(os.networkInterfaces()).map(([n, l]) => [n, (l ?? []).map((i) => i.cidr ?? i.address)]),
  );
}

function netstat(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('/usr/sbin/netstat', args, { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );
}

/** (Re)load the system routing table. Never throws; an unreadable table is cached as null. */
export function refreshRoutes(): Promise<void> {
  refreshing ??= (async () => {
    const ifSig = ifaceSignature();
    let table: RouteTable | null = null;
    try {
      if (process.platform !== 'darwin') throw new Error(`unsupported platform ${process.platform}`);
      const [v4, v6] = await Promise.all([netstat(['-rn', '-f', 'inet']), netstat(['-rn', '-f', 'inet6'])]);
      table = parseNetstatRoutes(`${v4}\n${v6}`);
      if (table.size === 0) throw new Error('empty routing table');
    } catch (e) {
      table = null;
      if (!warned) {
        warned = true;
        console.warn(
          `Flutter Intercept: cannot read the routing table (${(e as Error).message}); LAN clients are ` +
            "limited to the Wi-Fi subnet and public addresses (private ranges elsewhere are refused).",
        );
      }
    }
    cache = { table, at: Date.now(), ifSig };
    ifChangePending = false;
  })().finally(() => (refreshing = undefined));
  return refreshing;
}

/**
 * The current table, synchronously (checks run on hot paths). Kicks off a background refresh when
 * it is older than 10 s or the interfaces changed. null = unreadable (callers fail closed);
 * undefined = never loaded yet (also treated as unreadable).
 */
export function currentRoutes(): RouteTable | null {
  if (routesTesting.table !== undefined) return routesTesting.table;
  const now = Date.now();
  if (cache && !ifChangePending && now - lastIfCheck > IFACE_CHECK_MS) {
    lastIfCheck = now;
    // Interfaces changed (VPN up/down, new network): the old table can't be trusted. Fail closed
    // (null) until the fresh one is in.
    if (ifaceSignature() !== cache.ifSig) ifChangePending = true;
  }
  if (!cache || ifChangePending || now - cache.at > REFRESH_MS) void refreshRoutes();
  return ifChangePending ? null : cache?.table ?? null;
}
