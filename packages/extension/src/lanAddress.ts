/**
 * The Mac's LAN IPv4 for LAN mode (CONTRACTS §7): the IPv4 of the interface that carries the
 * default route. macOS: `route -n get default` → `interface: en0`; Linux: `ip -4 route show
 * default` → `dev wlan0`. The address comes from os.networkInterfaces() (non-internal IPv4,
 * not link-local). No default route / no IPv4 on it → undefined (caller does not intercept).
 * A VPN tunnel holding the default route is skipped in favour of the first en/eth/wl interface
 * with a private IPv4.
 */
import { execFile } from 'child_process';
import * as os from 'os';

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function parseRouteGetDefault(stdout: string): string | undefined {
  return /^\s*interface:\s*(\S+)/m.exec(stdout)?.[1];
}

export function parseIpRouteDefault(stdout: string): string | undefined {
  return /^default\b.*\bdev\s+(\S+)/m.exec(stdout)?.[1];
}

type Interfaces = ReturnType<typeof os.networkInterfaces>;

export function ipv4Of(ifaces: Interfaces, name: string): string | undefined {
  for (const a of ifaces[name] ?? []) {
    const fam = a.family as unknown;
    if ((fam === 'IPv4' || fam === 4) && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  }
  return undefined;
}

export interface LanAddressOptions {
  exec?: Exec;
  platform?: NodeJS.Platform;
  interfaces?: () => Interfaces;
  timeoutMs?: number;
}

export type LanAddress = { address: string; iface: string } | { problem: string } | undefined;

/**
 * The LAN address for LAN mode, or a `problem` when the default-route address is not an RFC 1918
 * private IPv4 (public, CGNAT 100.64/10, …): LAN mode is refused then (review 2, #5).
 */
export async function lanAddressForIphone(opts: LanAddressOptions = {}): Promise<LanAddress> {
  const r = await defaultRouteIPv4(opts);
  if (!r) return undefined;
  if (!isPrivateIPv4(r.address)) {
    return { problem: `this Mac's network address ${r.address} (${r.iface}) is not a private (RFC 1918) LAN address, so the proxy will not listen on it` };
  }
  return r;
}

export async function defaultRouteIPv4(opts: LanAddressOptions = {}): Promise<{ address: string; iface: string } | undefined> {
  const exec = opts.exec ?? defaultExec;
  const platform = opts.platform ?? process.platform;
  const timeout = opts.timeoutMs ?? 2000;
  let iface: string | undefined;
  try {
    if (platform === 'darwin') iface = parseRouteGetDefault((await exec('route', ['-n', 'get', 'default'], timeout)).stdout);
    else if (platform === 'linux') iface = parseIpRouteDefault((await exec('ip', ['-4', 'route', 'show', 'default'], timeout)).stdout);
  } catch {
    iface = undefined; // `route` exits non-zero when there is no default route
  }
  if (!iface) return undefined;
  const ifaces = (opts.interfaces ?? os.networkInterfaces)();
  // A full-tunnel VPN owns the default route (utun/ipsec/ppp/tun/wg): its address is not reachable
  // from the iPhone. Fall back to the first Ethernet/Wi-Fi interface with a private IPv4.
  if (TUNNEL.test(iface)) {
    for (const name of Object.keys(ifaces).filter((n) => /^(en|eth|wl)/.test(n)).sort()) {
      const a = ipv4Of(ifaces, name);
      if (a && isPrivateIPv4(a)) return { address: a, iface: name };
    }
    return undefined;
  }
  const address = ipv4Of(ifaces, iface);
  return address ? { address, iface } : undefined;
}

const TUNNEL = /^(utun|ipsec|ppp|tun|tap|wg)\d*/;

export function isPrivateIPv4(a: string): boolean {
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}
