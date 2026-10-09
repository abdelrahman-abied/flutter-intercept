/** Physical-iOS launch preparation (CONTRACTS §7). No `vscode` import: unit-tested. */
import { withSoftTimeout } from '../adb';
import type { DeviceKind } from '../iosDevices';
import type { LanOpening } from '../proxyHost';

export interface LanDeps {
  classify: (deviceId: string | undefined) => Promise<DeviceKind>;
  /** IPv4 of the default-route interface, or undefined (no Wi-Fi/LAN). */
  /** RFC 1918 IPv4 of the default-route interface, a `problem` (e.g. not private), or undefined (no LAN). */
  address: () => Promise<{ address: string; iface: string } | { problem: string } | undefined>;
  /** Opens (or reuses) the token-protected LAN listener. */
  open: (host: string) => Promise<LanOpening>;
  /** Called once the listener is open for a launch (one-time notice, grace timer, network watch). */
  opened?: (lan: { host: string; port: number; iface: string }) => void;
  /** Physical iOS but no LAN: tell the user this session runs without interception. */
  unavailable?: (message: string) => void;
  /**
   * Runs (bounded, never blocking for long) before a physical-iOS launch proceeds — e.g. the
   * Apple Silicon/Rosetta/USB iproxy diagnosis. Must not throw; the launch continues regardless.
   */
  beforePhysicalLaunch?: (deviceId: string, flutterSdkHint: string | undefined) => Promise<unknown> | unknown;
}

/** Physical-iOS handling for one launch: classify the device, find the LAN IP, open the listener. */
export async function prepareLan(
  lanDeps: LanDeps | undefined,
  deviceId: string | undefined,
  log: (m: string) => void,
  flutterSdkHint?: string,
): Promise<{ physicalIos: boolean; lan?: LanOpening; problem?: string }> {
  if (!lanDeps || !deviceId) return { physicalIos: false };
  const kind = (await withSoftTimeout(lanDeps.classify(deviceId), 4000)) ?? 'other';
  if (kind !== 'ios-physical') return { physicalIos: false };
  // USB or Wi-Fi paired alike: nothing below assumes a transport (LAN mode works for both).
  if (lanDeps.beforePhysicalLaunch) {
    await withSoftTimeout(Promise.resolve().then(() => lanDeps.beforePhysicalLaunch!(deviceId, flutterSdkHint)), 3000);
  }
  const addr = await lanDeps.address().catch(() => undefined);
  if (!addr) {
    return { physicalIos: true, problem: 'this Mac has no Wi-Fi/Ethernet IPv4 address (default route) the iPhone could reach' };
  }
  if ('problem' in addr) return { physicalIos: true, problem: addr.problem };
  try {
    const lan = await lanDeps.open(addr.address);
    log(`physical iOS device ${deviceId}: LAN listener ${lan.host}:${lan.port} (${addr.iface})`);
    lanDeps.opened?.({ host: lan.host, port: lan.port, iface: addr.iface });
    return { physicalIos: true, lan };
  } catch (e) {
    return { physicalIos: true, problem: `the LAN listener could not be opened on ${addr.address}: ${(e as Error)?.message ?? e}` };
  }
}

