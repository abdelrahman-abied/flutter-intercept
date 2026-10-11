/** Physical-iOS launch preparation (CONTRACTS §7). No `vscode` import: unit-tested. */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withSoftTimeout } from '../adb';
import { isOurDefinesFile, LAN_DEFINES_PREFIX } from './rewrite';
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


// ---------------------------------------------------------------------------------------------------------------
// REVIEW-9: LAN define files. The token-bearing FLUTTER_INTERCEPT_PROXY of a physical-iPhone session is passed with
// `--dart-define-from-file` (src/debug/rewrite.ts), never on the command line. The file lives in the host's private
// storage (VS Code globalStorage / the sidecar's dataDir — never the project): `<storage>/lan-defines/` (0700),
// `flutter-intercept-lan-<32 hex>.json` (0600, created exclusively). Delete it when the session ends or the LAN
// listener closes, and sweep stale ones at startup. flutter_tools still copies defines (base64) into gitignored
// generated build files (ios/Flutter/Generated.xcconfig, flutter_export_environment.sh): accepted residual, the
// token is per LAN opening.
// ---------------------------------------------------------------------------------------------------------------

export const LAN_DEFINES_DIR = 'lan-defines';

/** A fresh path for a LAN define file under `storageDir` (nothing is written). */
export function newLanDefinesPath(storageDir: string): string {
  return path.join(path.resolve(storageDir), LAN_DEFINES_DIR, `${LAN_DEFINES_PREFIX}${randomBytes(16).toString('hex')}.json`);
}

/** Writes a LAN define file: its folder 0700 (never through a symlink), the file 0600, never overwriting. */
export async function writeLanDefines(file: string, content: string): Promise<void> {
  if (!isOurDefinesFile(file)) throw new Error('not a Flutter Intercept LAN define file path');
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.promises.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to write the LAN define file through ${dir} (not a plain folder)`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
  await fs.promises.writeFile(file, content, { mode: 0o600, flag: 'wx' });
}

/** Deletes one of our LAN define files (anything else is left alone). Never throws. */
export async function removeLanDefines(file: string | undefined): Promise<void> {
  if (!isOurDefinesFile(file)) return;
  await fs.promises.unlink(file).catch(() => undefined);
}

/** Deletes every LAN define file under `storageDir` (startup sweep, LAN listener closed). Never throws; returns the count. */
export async function cleanupLanDefines(storageDir: string): Promise<number> {
  const dir = path.join(path.resolve(storageDir), LAN_DEFINES_DIR);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    if (!isOurDefinesFile(file)) continue;
    try {
      await fs.promises.unlink(file);
      n++;
    } catch {
      // gone already
    }
  }
  return n;
}
