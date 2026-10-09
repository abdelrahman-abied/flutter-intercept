/**
 * Follows the Mac's network while the LAN listener is open (review 2, #5). Every `intervalMs`
 * (default 5 s) it takes a cheap fingerprint of the listener's interface:
 *  - its IPv4 from os.networkInterfaces() (no process): gone or different → close;
 *  - the default gateway on that interface and the gateway's MAC (`route -n get default`,
 *    `arp -n <gw>`, ~10 ms each): a different router means a different network even when DHCP
 *    handed out the same IP (e.g. 192.168.1.23 at home and at a café) → close.
 * A signal that can't be read (no default route for a moment, arp miss) is treated as unknown,
 * not as a change; only the interface address disappearing is a change on its own.
 */
import { execFile } from 'child_process';
import * as os from 'os';
import { ipv4Of, parseRouteGetDefault } from './lanAddress';

export interface NetFingerprint {
  address?: string;
  gateway?: string;
  gatewayMac?: string;
}

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function parseGateway(routeOut: string): string | undefined {
  return /^\s*gateway:\s*(\d+\.\d+\.\d+\.\d+)/m.exec(routeOut)?.[1];
}

/** `? (192.168.1.1) at 3c:84:6a:aa:bb:cc on en0 ifscope [ethernet]` → MAC (lower case). */
export function parseArpMac(arpOut: string): string | undefined {
  const m = /\bat\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i.exec(arpOut);
  return m ? m[1].toLowerCase() : undefined;
}

export async function netFingerprint(
  iface: string,
  opts: { exec?: Exec; interfaces?: () => ReturnType<typeof os.networkInterfaces>; platform?: NodeJS.Platform } = {},
): Promise<NetFingerprint> {
  const address = ipv4Of((opts.interfaces ?? os.networkInterfaces)(), iface);
  if (!address || (opts.platform ?? process.platform) !== 'darwin') return { address };
  const exec = opts.exec ?? defaultExec;
  try {
    const route = (await exec('route', ['-n', 'get', 'default'], 2000)).stdout;
    if (parseRouteGetDefault(route) !== iface) return { address };
    const gateway = parseGateway(route);
    if (!gateway) return { address };
    let gatewayMac: string | undefined;
    try {
      gatewayMac = parseArpMac((await exec('arp', ['-n', gateway], 2000)).stdout);
    } catch {
      gatewayMac = undefined;
    }
    return { address, gateway, gatewayMac };
  } catch {
    return { address };
  }
}

/** The reason the network no longer matches the baseline, or undefined. */
export function networkChange(host: string, base: NetFingerprint, now: NetFingerprint): string | undefined {
  if (!now.address) return 'the network interface the iPhone used went away';
  if (now.address !== host) return `this Mac's LAN address changed (${host} → ${now.address})`;
  if (base.gateway && now.gateway && base.gateway !== now.gateway) return `the router changed (${base.gateway} → ${now.gateway})`;
  if (base.gatewayMac && now.gatewayMac && base.gatewayMac !== now.gatewayMac) return 'the Mac joined a different network (router changed)';
  return undefined;
}

export interface LanNetworkWatcherOptions {
  snapshot: (iface: string) => Promise<NetFingerprint>;
  onChange: (reason: string) => void;
  /** Called every tick while watching (e.g. to refresh the pinned peer for the status). */
  onTick?: () => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
}

export class LanNetworkWatcher {
  private timer: unknown;
  private watching?: { host: string; iface: string; base: NetFingerprint };
  private busy = false;

  constructor(private readonly opts: LanNetworkWatcherOptions) {}

  get active(): boolean {
    return !!this.watching;
  }

  /** Starts watching `iface` for the listener on `host` (no-op if already watching it). */
  async start(host: string, iface: string): Promise<void> {
    if (this.watching?.host === host && this.watching.iface === iface) return;
    this.stop();
    const base = await this.opts.snapshot(iface);
    this.watching = { host, iface, base };
    const change = networkChange(host, base, base);
    if (change) return this.fire(change);
    const set = this.opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = set(() => void this.tick(), this.opts.intervalMs ?? 5000);
  }

  async tick(): Promise<void> {
    const w = this.watching;
    if (!w || this.busy) return;
    this.busy = true;
    try {
      const now = await this.opts.snapshot(w.iface);
      if (this.watching !== w) return;
      // Fill in signals the baseline could not read yet (e.g. arp warmed up later).
      if (!w.base.gateway && now.gateway && now.address === w.host) w.base = { ...w.base, gateway: now.gateway };
      if (!w.base.gatewayMac && now.gatewayMac && now.gateway === w.base.gateway) w.base = { ...w.base, gatewayMac: now.gatewayMac };
      const change = networkChange(w.host, w.base, now);
      if (change) this.fire(change);
      else this.opts.onTick?.();
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    if (this.timer !== undefined) (this.opts.clearInterval ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = undefined;
    this.watching = undefined;
  }

  private fire(reason: string): void {
    this.stop();
    this.opts.onChange(reason);
  }
}
