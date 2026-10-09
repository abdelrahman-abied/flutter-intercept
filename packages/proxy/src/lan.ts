// LAN mode (CONTRACTS §7): a second, token-gated listener on one LAN IPv4 for physical iOS
// devices, plus the SSRF guard that stops LAN clients reaching this machine's own services or the
// other networks it is attached to (VPN, VMs, bridges).
//
// Design (see docs/spikes/proxy.md, "LAN mode"):
// - LanGate is a plain net.Server bound to exactly the LAN IPv4. It reads the FIRST request head of
//   every connection (absolute deadline, size cap, connection caps), checks Proxy-Authorization and
//   the pinned peer IP, and then hands the socket (head unshifted) to mockttp's own connection
//   handler — the same thing mockttp does with CONNECT tunnels. mockttp answers CONNECT itself,
//   with no hook, hence the gate.
// - Every guard is keyed on the SOCKET: a socket accepted by a gate stays a LAN socket forever and
//   carries its gate (token, pinned peer, listener host, guarded agents). If the gate is closed, the
//   socket is refused everywhere (407 / 403 / no upstream agent), whether or not LAN mode is on.
// - Later requests on a plain keep-alive connection are checked by InterceptProxy's per-instance
//   preprocessRequest hook (the header is still in the raw request there; mockttp strips it after).
// - SSRF: the ONLY place that opens upstream connections is mockttp's getAgent → our agents. LAN
//   sockets get their gate's guarded agents, whose createConnection checks the address actually
//   connected to (DNS-rebinding safe). The 403 is decided earlier by a rule (lanTargetDenial).
import { createHash, timingSafeEqual } from 'crypto';
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import { currentRoutes, type RouteTable } from './routes';
import { isTraceHost } from './trace';

export const LAN_USERNAME = 'flutter-intercept';
export const SSRF_MARKER = "Flutter Intercept: blocked a LAN client's request";
const MAX_HEAD_BYTES = 64 * 1024;
/**
 * Two-phase head deadline (regression fix, physical iPhone debug cold start):
 * - a SILENT socket (connected, no byte yet) may wait SILENT_DEADLINE_MS. A Dart isolate paused by
 *   the debugger on a cold start connects and then sends nothing for ~20 s; killing it made Dart
 *   fall back DIRECT (CONNECT) or fail with "Connection closed before full header was received".
 *   Silent sockets cost no buffer, and the per-IP pending cap and the total cap bound their number.
 * - once the FIRST byte arrives, the whole head must be in within HEAD_DEADLINE_MS, absolute: a
 *   trickling (slowloris) client can't extend it, and a real client writes its head in one go.
 */
export const SILENT_DEADLINE_MS = 120_000;
export const HEAD_DEADLINE_MS = 10_000;
/**
 * Connection caps. dart:io opens a NEW tunnel for every HTTPS request through a proxy, and an app's
 * cold start easily has 20–40 requests in flight (images, API fan-out), so the per-IP cap is sized
 * for that; heads still being read (the slowloris vector) have their own, small, per-IP cap.
 */
export const LAN_MAX_CONNECTIONS = 128;
export const LAN_MAX_PER_IP = 64;
export const LAN_MAX_PENDING_PER_IP = 32;

type IfaceTable = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** Test seams. Never set outside tests. */
export const lanTesting: {
  /** Bind the LAN listener here instead of the requested host (to test the fail-closed check). */
  bindHostOverride?: string;
  /** Skip the "is an address of a local interface" validation of openLan's host. */
  allowAnyHost?: boolean;
  /** Exempt a resolved target from the SSRF guard (tests need a local upstream). */
  allowTarget?: (ip: string, port: number) => boolean;
  /** Replace os.networkInterfaces() (synthetic VPN/VM interface tables). */
  interfaces?: () => IfaceTable;
  /** Pretend a socket comes from another peer IP (pinning tests on a single machine). */
  peerOf?: (socket: net.Socket) => string | undefined;
  /** Override HEAD_DEADLINE_MS (from the first byte). */
  headDeadlineMs?: number;
  /** Override SILENT_DEADLINE_MS (from accept, until the first byte). */
  silentDeadlineMs?: number;
  /** Simulate the old close race: leave accepted sockets alive on close (guards must still hold). */
  keepSocketsOnClose?: boolean;
} = {};

const interfaces = (): IfaceTable => lanTesting.interfaces?.() ?? os.networkInterfaces();

// ---------------------------------------------------------------- auth

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time check of a Proxy-Authorization value against the token. */
export function proxyAuthOk(value: string | string[] | undefined, token: string): boolean {
  if (typeof value !== 'string') return false; // missing or repeated header
  const m = /^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(value);
  const got = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
  // Compare fixed-length digests so neither length nor content leaks through timing.
  return timingSafeEqual(digest(got), digest(`${LAN_USERNAME}:${token}`)) && m !== null;
}

export function rawHeaderValue(rawHeaders: string[], name: string): string | string[] | undefined {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) values.push(rawHeaders[i + 1]);
  }
  return values.length === 0 ? undefined : values.length === 1 ? values[0] : values;
}

export const RESPONSE_407 =
  'HTTP/1.1 407 Proxy Authentication Required\r\n' +
  'Proxy-Authenticate: Basic realm="proxy"\r\n' +
  'Content-Length: 0\r\nConnection: close\r\n\r\n';
const RESPONSE_403 = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const RESPONSE_400 = 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

export function refuse(socket: net.Socket, response: string): void {
  if (socket.destroyed) return;
  socket.end(response);
  socket.once('finish', () => socket.destroy());
  setTimeout(() => socket.destroy(), 1000).unref?.();
}

// ---------------------------------------------------------------- addresses

/** Lower-case, no zone id, IPv4-mapped/compatible IPv6 → IPv4. */
export function normalizeIp(ip: string): string {
  let a = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^(?:0{0,4}:){0,5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped && net.isIPv4(mapped[1]) && a.includes(':')) return mapped[1];
  if (net.isIPv6(a)) {
    // ::ffff:7f00:1 (hex-form IPv4-mapped)
    const hex = /^(?:0{0,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(expandV6(a));
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  return a;
}

function expandV6(a: string): string {
  if (!a.includes('::')) return a;
  const [l, r] = a.split('::');
  const left = l ? l.split(':') : [];
  const right = r ? r.split(':') : [];
  const fill = new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...fill, ...right].join(':');
}

interface Prefix {
  v6: boolean;
  base: bigint;
  bits: number;
}

function toBig(ip: string): { v6: boolean; n: bigint } | undefined {
  const a = normalizeIp(ip);
  if (net.isIPv4(a)) return { v6: false, n: a.split('.').reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n) };
  if (net.isIPv6(a)) {
    return { v6: true, n: expandV6(a).split(':').reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
  }
  return undefined;
}

function prefix(cidr: string): Prefix | undefined {
  const [ip, bitsS] = cidr.split('/');
  const b = toBig(ip);
  if (!b) return undefined;
  const width = b.v6 ? 128 : 32;
  const bits = Math.min(width, Math.max(0, Number(bitsS ?? width)));
  return { v6: b.v6, base: mask(b.n, bits, width), bits };
}

function mask(n: bigint, bits: number, width: number): bigint {
  if (bits === 0) return 0n;
  return (n >> BigInt(width - bits)) << BigInt(width - bits);
}

function inPrefix(ip: string, p: Prefix): boolean {
  const b = toBig(ip);
  if (!b || b.v6 !== p.v6) return false;
  return mask(b.n, p.bits, p.v6 ? 128 : 32) === p.base;
}

const HARD: Array<[string, string]> = [
  ['127.0.0.0/8', 'loopback'],
  ['0.0.0.0/8', 'unspecified'],
  ['169.254.0.0/16', 'link-local'],
  ['224.0.0.0/4', 'multicast'],
  ['255.255.255.255/32', 'broadcast'],
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['fe80::/10', 'link-local'],
  ['ff00::/8', 'multicast'],
].map(([c, r]) => [c, r] as [string, string]);
const HARD_P = HARD.map(([c, r]) => [prefix(c)!, r] as const);

/** Ranges that are never "the internet": VPNs (incl. CGNAT tailnets), VMs, corporate nets. */
const PRIVATE_P = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '198.18.0.0/15', 'fc00::/7'].map(
  (c) => prefix(c)!,
);

function ifaceCidr(i: os.NetworkInterfaceInfo): string {
  return i.cidr ?? `${i.address}/${i.family === 'IPv4' ? 32 : 128}`;
}

/** Concrete, non-internal, non-link-local IPv4 addresses of this machine's interfaces. */
export function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
    }
  }
  return out;
}

const PRIVATE_NET =
  "a private network that is not this machine's Wi-Fi subnet (the routing table is unavailable, so only the Wi-Fi subnet and public addresses are allowed)";

/**
 * Why `ip` must not be reached by a LAN client, or undefined if it may.
 * Always: loopback, unspecified, link-local, multicast/broadcast, any address of this machine.
 * With `listenerHost` (the LAN listener's IPv4), ROUTE-based (review 2 follow-up): refuse a target
 * this Mac would send out of an interface OTHER than the listener's — utun/ipsec/ppp/bridge/vmnet/
 * vboxnet/docker…, i.e. a network the phone isn't on (VPN peers, full-tunnel VPN, VMs). Targets
 * routed through the listener's interface (its subnet, or its gateway: the internet, corporate
 * routed nets like a dev backend at 10.20.30.40) are allowed.
 * If the routing table can't be read (`routes` null), fail closed: only the listener's subnet and
 * non-private addresses are allowed.
 */
export function forbiddenReason(
  ipIn: string,
  listenerHost?: string,
  table: IfaceTable = interfaces(),
  routes: RouteTable | null = listenerHost ? currentRoutes() : null,
): string | undefined {
  const ip = normalizeIp(ipIn);
  if (!net.isIP(ip)) return 'not an IP address';
  for (const [p, reason] of HARD_P) if (inPrefix(ip, p)) return reason;
  let listenerIface: string | undefined;
  for (const [name, list] of Object.entries(table)) {
    for (const i of list ?? []) {
      if (normalizeIp(i.address) === ip) return "an address of this machine's own interfaces";
      if (listenerHost && normalizeIp(i.address) === listenerHost) listenerIface = name;
    }
  }
  if (!listenerHost) return undefined;

  if (routes) {
    const via = routes.lookup(ip);
    if (via === undefined) return 'not routable from this machine';
    if (via !== listenerIface) {
      return `routed through ${via}, not the Wi-Fi interface ${listenerIface ?? '(unknown)'} — a network the phone isn't on (VPN, VM or bridge)`;
    }
    return undefined;
  }

  // Fallback without a routing table: the listener interface's subnets and public space only.
  const own: Prefix[] = [];
  for (const i of (listenerIface && table[listenerIface]) || []) {
    const p = prefix(ifaceCidr(i));
    if (p && p.bits > 0) own.push(p);
  }
  if (own.some((p) => inPrefix(ip, p))) return undefined;
  for (const [name, list] of Object.entries(table)) {
    if (name === listenerIface) continue;
    for (const i of list ?? []) {
      const p = i.internal ? undefined : prefix(ifaceCidr(i));
      if (p && p.bits > 0 && inPrefix(ip, p)) return `on the subnet of ${name}, a network the phone isn't on (VPN, VM or bridge)`;
    }
  }
  if (PRIVATE_P.some((p) => inPrefix(ip, p))) return PRIVATE_NET;
  return undefined;
}

export class SsrfError extends Error {
  readonly code = 'E_FI_LAN_TARGET_FORBIDDEN';
  readonly statusCode = 403;
  readonly statusMessage = 'Forbidden';
  constructor(host: string, ip: string, reason: string) {
    super(`${SSRF_MARKER} to ${host}${host === ip ? '' : ` (${ip})`}: ${reason}. LAN clients can't reach this machine's own services or networks.`);
  }
}

function checkIp(host: string, ip: string, port: number, listenerHost?: string): void {
  if (lanTesting.allowTarget?.(normalizeIp(ip), port)) return;
  const reason = forbiddenReason(ip, listenerHost);
  if (reason) throw new SsrfError(host, ip, reason);
}

/** Pre-check before connecting: resolves names (so `localhost` and friends count). */
export async function precheckTarget(hostIn: string, port: number, listenerHost?: string): Promise<void> {
  const host = hostIn.replace(/^\[|\]$/g, '');
  // The trace sink (CONTRACTS §9.2) is answered by the proxy itself and never contacted. Requests inside
  // a tunnel to it still pass the per-request 403 rule and the connect-time guard (an absolute-form
  // request in the tunnel names its own target), so this exemption can't reach anything else.
  if (isTraceHost(host)) return;
  if (net.isIP(host)) return checkIp(host, host, port, listenerHost);
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    if (!lanTesting.allowTarget?.('127.0.0.1', port)) throw new SsrfError(host, '127.0.0.1', 'loopback');
  }
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    return; // unresolvable: the connection itself will fail (502)
  }
  for (const a of addrs) checkIp(host, a.address, port, listenerHost);
}

/**
 * Why a LAN client's request must be refused (403), or undefined. Uses the URL the CLIENT asked
 * for (before mockttp's "localhost means the client's machine" rewrite), resolving names.
 */
export async function lanTargetDenial(url: string, listenerHost?: string): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const port = Number(u.port) || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80);
  try {
    await precheckTarget(u.hostname, port, listenerHost);
    return undefined;
  } catch (e) {
    return e instanceof SsrfError ? e.message : undefined;
  }
}

type LookupFn = (hostname: string, options: dns.LookupOptions, cb: (...a: any[]) => void) => void;

/** Wrap a dns.lookup-style function so the address actually connected to is checked. */
export function guardedLookup(original: LookupFn, port: number, listenerHost?: string): LookupFn {
  return (hostname, options, cb) => {
    if (typeof options === 'function') {
      cb = options as unknown as typeof cb;
      options = {};
    }
    original(hostname, options, (err: Error | null, address: string | dns.LookupAddress[], family?: number) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address : [{ address, family: family ?? 0 }];
      try {
        for (const a of list) checkIp(hostname, a.address, port, listenerHost);
      } catch (e) {
        return cb(e);
      }
      cb(null, address, family);
    });
  };
}

function guardOptions(options: any, listenerHost: string | undefined): any {
  const port = Number(options.port);
  const host = String(options.host ?? options.hostname ?? '').replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    checkIp(host, host, port, listenerHost); // literal: no lookup happens
    return options;
  }
  return { ...options, lookup: guardedLookup(options.lookup ?? (dns.lookup as unknown as LookupFn), port, listenerHost) };
}

/** Upstream agents for LAN-originated requests: every new connection is SSRF-checked. */
export class GuardedHttpAgent extends http.Agent {
  constructor(
    opts?: http.AgentOptions,
    private readonly listenerHost?: string,
  ) {
    super(opts);
  }
  override createConnection(options: any, cb?: any): any {
    let guarded: any;
    try {
      guarded = guardOptions(options, this.listenerHost);
    } catch (e) {
      process.nextTick(() => cb?.(e));
      return undefined;
    }
    return (http.Agent.prototype as any).createConnection.call(this, guarded, cb);
  }
}

export class GuardedHttpsAgent extends https.Agent {
  constructor(
    opts?: https.AgentOptions,
    private readonly listenerHost?: string,
  ) {
    super(opts);
  }
  override createConnection(options: any, cb?: any): any {
    let guarded: any;
    try {
      guarded = guardOptions(options, this.listenerHost);
    } catch (e) {
      process.nextTick(() => cb?.(e));
      return undefined;
    }
    return (https.Agent.prototype as any).createConnection.call(this, guarded, cb);
  }
}

// ---------------------------------------------------------------- socket identity (permanent)

type GateState = 'reading' | 'plain-handing' | 'plain' | 'connect-handing' | 'connect';

interface LanSocketInfo {
  gate: LanGate;
  state: GateState;
  peer: string;
}

/** Every socket a LAN gate ever accepted, with its gate. Entries live as long as the socket. */
const lanSockets = new WeakMap<object, LanSocketInfo>();

function walk(s: any): LanSocketInfo | undefined {
  for (let i = 0; s && i < 8; i++) {
    const info = lanSockets.get(s);
    if (info) return info;
    s = s._parent ?? s.stream ?? s._handle?._parentWrap?.stream;
  }
  return undefined;
}

/** The gate that accepted this downstream connection (or the raw socket under a TLS-in-tunnel socket). */
export function lanGateOf(connection: unknown): LanGate | undefined {
  return walk(connection)?.gate;
}

export function isLanConnection(connection: unknown): boolean {
  return walk(connection) !== undefined;
}

function peerOf(socket: net.Socket): string {
  return normalizeIp(lanTesting.peerOf?.(socket) ?? socket.remoteAddress ?? '');
}

/**
 * Per-request check for requests on a LAN socket (mockttp's preprocessRequest).
 * false = refuse (407); true = allowed; undefined = not a LAN socket.
 * Plain keep-alive requests must each carry the token from the pinned peer; requests inside a
 * gate-checked CONNECT tunnel need no header. A closed gate refuses everything.
 */
export function checkLanRequest(req: http.IncomingMessage): boolean | undefined {
  const raw = lanSockets.get(req.socket as object);
  const info = raw ?? walk(req.socket);
  if (!info) return undefined;
  if (info.gate.closed) return false;
  if (raw && (info.state === 'plain' || info.state === 'plain-handing')) {
    return info.gate.admits(rawHeaderValue(req.rawHeaders, 'proxy-authorization'), info.peer);
  }
  return info.state === 'connect' || info.state === 'connect-handing';
}

/**
 * mockttp re-emits a socket after answering a CONNECT on it. Only allowed when the CONNECT was the
 * first (gate-checked) request; a CONNECT after plain requests never went through the gate.
 */
export function onComboConnection(socket: net.Socket): void {
  const info = lanSockets.get(socket);
  if (!info) return;
  if (info.gate.closed || info.state === 'plain') socket.destroy();
}

// ---------------------------------------------------------------- gate

export interface LanGateCallbacks {
  /** Give an authenticated socket (first head unshifted) to mockttp. */
  handoff(socket: net.Socket): void;
  /** A CONNECT to a forbidden target was refused (record it). */
  onBlockedConnect(target: string, reason: string): void;
  /** The first authenticated peer IP was pinned for this token. */
  onPeerPinned?(ip: string): void;
}

export class LanGate {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  /** Connected but no byte yet, oldest first (evictable when the gate is full). */
  private readonly silent = new Set<net.Socket>();
  private readonly perIp = new Map<string, number>();
  private readonly pendingPerIp = new Map<string, number>();
  private _address?: { host: string; port: number };
  private _closed = false;
  private _peer?: string;
  /** Guarded upstream agents for this gate's sockets (destroyed with the gate). */
  readonly agents: { http: GuardedHttpAgent; https: GuardedHttpsAgent };

  constructor(
    private readonly token: string,
    readonly host: string,
    private readonly cb: LanGateCallbacks,
  ) {
    this.agents = {
      http: new GuardedHttpAgent({ keepAlive: true }, host),
      https: new GuardedHttpsAgent({ keepAlive: true }, host),
    };
  }

  get address(): { host: string; port: number } | undefined {
    return this._address;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** The peer IP pinned by the first successful authentication (for this token). */
  get peer(): string | undefined {
    return this._peer;
  }

  /** Fresh guarded agent for a websocket upgrade (not pooled). */
  wsAgent(secure: boolean): http.Agent {
    return secure ? new GuardedHttpsAgent({}, this.host) : new GuardedHttpAgent({}, this.host);
  }

  /** Valid token AND the pinned peer (pins on the first success). */
  admits(authorization: string | string[] | undefined, peer: string): boolean {
    if (this._closed) return false;
    if (!proxyAuthOk(authorization, this.token)) return false;
    if (this._peer === undefined) {
      this._peer = peer;
      this.cb.onPeerPinned?.(peer);
      return true;
    }
    return this._peer === peer;
  }

  async listen(port: number): Promise<{ host: string; port: number }> {
    const host = this.host;
    const server = net.createServer({ pauseOnConnect: false }, (s) => this.onConnection(s));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, lanTesting.bindHostOverride ?? host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    // Fail CLOSED, like the loopback bind: exactly the requested IPv4, nothing wider.
    if (!addr || typeof addr === 'string' || addr.address !== host) {
      await new Promise<void>((r) => server.close(() => r()));
      const got = addr && typeof addr !== 'string' ? addr.address : String(addr);
      throw new Error(`Flutter Intercept: LAN listener bound to ${got} instead of ${host}; refusing to run`);
    }
    this.server = server;
    this._address = { host, port: addr.port };
    return this._address;
  }

  /**
   * Close order matters (review 2, #1): mark closed and stop accepting FIRST, so nothing accepted
   * during the shutdown can be handed to mockttp; then destroy every socket and wait for it.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    const server = this.server;
    this.server = undefined;
    this._address = undefined;
    const stopped = server ? new Promise<void>((r) => server.close(() => r())) : Promise.resolve();
    if (!lanTesting.keepSocketsOnClose) {
      // Wait for every LAN socket to be fully closed: mockttp's connection tracking (shared with
      // these sockets, which we handed to it) must see the 'close' events before it shuts down.
      const closing = [...this.sockets].map(
        (s) => new Promise<void>((r) => (s.closed ? r() : (s.once('close', () => r()), s.destroy()))),
      );
      this.sockets.clear();
      await Promise.all(closing);
      await stopped;
    }
    this.agents.http.destroy();
    this.agents.https.destroy();
  }

  private count(map: Map<string, number>, ip: string, delta: number): number {
    const n = (map.get(ip) ?? 0) + delta;
    if (n <= 0) map.delete(ip);
    else map.set(ip, n);
    return n;
  }

  private onConnection(socket: net.Socket): void {
    socket.on('error', () => socket.destroy());
    if (this._closed) return void socket.destroy();
    const ip = peerOf(socket);
    if ((this.perIp.get(ip) ?? 0) >= LAN_MAX_PER_IP || (this.pendingPerIp.get(ip) ?? 0) >= LAN_MAX_PENDING_PER_IP) {
      return void socket.destroy();
    }
    if (this.sockets.size >= LAN_MAX_CONNECTIONS) {
      // Full. Silent sockets may wait long (debugger pauses), so don't let other hosts' idle
      // connections lock the phone out: evict the oldest silent socket that isn't the pinned peer's.
      const victim = [...this.silent].find(
        (s) => !s.destroyed && (this._peer === undefined || lanSockets.get(s)?.peer !== this._peer),
      );
      if (!victim || ip === lanSockets.get(victim)?.peer) return void socket.destroy();
      victim.destroy();
    }
    const info: LanSocketInfo = { gate: this, state: 'reading', peer: ip };
    lanSockets.set(socket, info);
    this.sockets.add(socket);
    this.count(this.perIp, ip, +1);
    this.count(this.pendingPerIp, ip, +1);
    let pending = true;
    const settlePending = () => {
      if (pending) {
        pending = false;
        this.count(this.pendingPerIp, ip, -1);
      }
    };
    // Silent phase: generous (debugger-paused clients). Replaced by the short, absolute head
    // deadline at the first byte; trickling bytes after that doesn't extend it.
    let deadline = setTimeout(() => {
      if (info.state === 'reading') socket.destroy();
    }, lanTesting.silentDeadlineMs ?? SILENT_DEADLINE_MS);
    deadline.unref?.();
    let gotFirstByte = false;
    this.silent.add(socket);
    socket.on('close', () => {
      this.silent.delete(socket);
      clearTimeout(deadline);
      settlePending();
      this.count(this.perIp, ip, -1);
      this.sockets.delete(socket);
    });

    // Incremental search for the end of the head: each chunk is scanned once (plus the 3 bytes of
    // overlap with the previous one); the head is concatenated only once, when complete.
    const chunks: Buffer[] = [];
    let size = 0;
    let tail = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      if (!gotFirstByte) {
        gotFirstByte = true;
        this.silent.delete(socket);
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          if (info.state === 'reading') socket.destroy();
        }, lanTesting.headDeadlineMs ?? HEAD_DEADLINE_MS);
        deadline.unref?.();
      }
      const probe = tail.length ? Buffer.concat([tail, d]) : d;
      const idx = probe.indexOf('\r\n\r\n');
      const probeStart = size - tail.length;
      chunks.push(d);
      size += d.length;
      if (idx < 0) {
        if (size > MAX_HEAD_BYTES) {
          socket.off('data', onData);
          settlePending();
          refuse(socket, RESPONSE_400);
          return;
        }
        tail = Buffer.from(probe.subarray(Math.max(0, probe.length - 3)));
        return;
      }
      // Stop the flow before detaching, so no byte after the head is lost.
      socket.pause();
      socket.off('data', onData);
      settlePending();
      const buf = Buffer.concat(chunks, size);
      const end = probeStart + idx;
      void this.onHead(socket, info, buf, buf.subarray(0, end).toString('latin1'), () => clearTimeout(deadline));
    };
    socket.on('data', onData);
  }

  private async onHead(socket: net.Socket, info: LanSocketInfo, buffered: Buffer, head: string, clearDeadline: () => void): Promise<void> {
    if (this._closed) return void socket.destroy();
    const lines = head.split('\r\n');
    const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
    if (!m) return refuse(socket, RESPONSE_400);
    const [, method, target] = m;
    const raw: string[] = [];
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) raw.push(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    // Token AND pinned peer: another IP with the right token is refused like a wrong token.
    if (!this.admits(rawHeaderValue(raw, 'proxy-authorization'), info.peer)) return refuse(socket, RESPONSE_407);

    const isConnect = method === 'CONNECT';
    if (isConnect) {
      const t = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
      if (!t) return refuse(socket, RESPONSE_400);
      try {
        await precheckTarget(t[1], Number(t[2]), this.host);
      } catch (e) {
        if (e instanceof SsrfError) {
          this.cb.onBlockedConnect(target, e.message);
          return refuse(socket, RESPONSE_403);
        }
        return refuse(socket, RESPONSE_400);
      }
    }
    // The gate may have closed during the (async) target check.
    if (this._closed || socket.destroyed) return void socket.destroy();
    clearDeadline();
    socket.unshift(buffered);
    info.state = isConnect ? 'connect-handing' : 'plain-handing';
    this.cb.handoff(socket);
    info.state = isConnect ? 'connect' : 'plain';
    socket.resume();
  }
}
