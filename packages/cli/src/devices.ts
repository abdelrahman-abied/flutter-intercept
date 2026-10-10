/**
 * Which device a run targets and how the app there reaches the proxy on 127.0.0.1 (CONTRACTS §2).
 * Pure except `listFlutterDevices` (runs `flutter devices --machine`).
 */
import { execFile } from 'child_process';
import { spawnPlan } from './command';

/** One entry of `flutter devices --machine`. */
export interface FlutterDevice {
  id: string;
  name?: string;
  targetPlatform?: string;
  emulator?: boolean;
}

export type DeviceKind = 'android-emulator' | 'android-physical' | 'ios-simulator' | 'ios-physical' | 'desktop' | 'web' | 'unknown';

const DESKTOP_IDS = new Set(['macos', 'linux', 'windows']);
const WEB_IDS = new Set(['chrome', 'edge', 'web-server']);

/** Device kinds we can tell from the id alone (no `flutter devices` call needed), else undefined. */
export function kindFromId(id: string): DeviceKind | undefined {
  if (DESKTOP_IDS.has(id)) return 'desktop';
  if (WEB_IDS.has(id)) return 'web';
  if (/^emulator-\d+$/.test(id)) return 'android-emulator';
  return undefined;
}

export function classifyDevice(d: FlutterDevice): DeviceKind {
  const fromId = kindFromId(d.id);
  if (fromId) return fromId;
  const p = (d.targetPlatform ?? '').toLowerCase();
  // CONTRACTS §2: only `emulator-*` serials get 10.0.2.2. Other Android emulators (Genymotion, …) have other host
  // aliases; adb reverse works on any adb device, so they are handled like physical devices.
  if (p.startsWith('android')) return 'android-physical';
  if (p === 'ios') return d.emulator ? 'ios-simulator' : 'ios-physical';
  if (p === 'darwin' || p.startsWith('linux') || p.startsWith('windows')) return 'desktop';
  if (p.startsWith('web')) return 'web';
  return 'unknown';
}

export type ProxyRoute =
  | { ok: true; host: string; adbReverse: boolean; note?: string }
  | { ok: false; reason: string };

/** `PROXY_HOST` for the dart-define and whether an adb reverse is needed (CONTRACTS §2). */
export function proxyRouteFor(kind: DeviceKind, deviceId: string): ProxyRoute {
  switch (kind) {
    case 'android-emulator':
      return { ok: true, host: '10.0.2.2', adbReverse: false };
    case 'android-physical':
      return { ok: true, host: 'localhost', adbReverse: true };
    case 'ios-simulator':
    case 'desktop':
      return { ok: true, host: 'localhost', adbReverse: false };
    case 'ios-physical':
      return {
        ok: false,
        reason: `${deviceId} is a physical iOS device: not supported headless (it would need LAN mode, which is editor-only). Use an iOS simulator, macOS or Android.`,
      };
    case 'web':
      return { ok: false, reason: `${deviceId} is a web device: Flutter Web runs are not supported headless yet. Use macOS, an iOS simulator or Android.` };
    default:
      return { ok: false, reason: `don't know how ${deviceId} reaches this machine (unknown device type)` };
  }
}

/** Parses `flutter devices --machine` output (JSON array, possibly after log lines). */
export function parseFlutterDevices(stdout: string): FlutterDevice[] {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: FlutterDevice[] = [];
  for (const d of data) {
    if (!d || typeof d !== 'object' || typeof (d as FlutterDevice).id !== 'string') continue;
    const r = d as Record<string, unknown>;
    out.push({
      id: r.id as string,
      ...(typeof r.name === 'string' ? { name: r.name } : {}),
      ...(typeof r.targetPlatform === 'string' ? { targetPlatform: r.targetPlatform } : {}),
      ...(typeof r.emulator === 'boolean' ? { emulator: r.emulator } : {}),
    });
  }
  return out;
}

export function listFlutterDevices(flutter: string, timeoutMs = 120_000): Promise<FlutterDevice[]> {
  return new Promise((resolve, reject) => {
    const plan = spawnPlan(flutter, ['devices', '--machine']);
    execFile(plan.file, plan.args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsVerbatimArguments: plan.windowsVerbatimArguments }, (err, stdout) => {
      const devices = parseFlutterDevices(String(stdout ?? ''));
      if (err && !devices.length) reject(new Error(`\`flutter devices --machine\` failed: ${err.message}`));
      else resolve(devices);
    });
  });
}

export interface PickedDevice {
  id: string;
  kind: DeviceKind;
  name?: string;
}

/**
 * The device to run on: `requested` (looked up in `devices` unless its id says what it is), or the only connected
 * non-web device. Throws a readable Error otherwise.
 */
export function pickDevice(requested: string | undefined, devices: FlutterDevice[] | undefined): PickedDevice {
  if (requested) {
    const fromId = kindFromId(requested);
    const found = devices?.find((d) => d.id === requested) ?? devices?.find((d) => d.name !== undefined && d.name.toLowerCase() === requested.toLowerCase());
    if (found) return { id: found.id, kind: classifyDevice(found), ...(found.name ? { name: found.name } : {}) };
    if (fromId) return { id: requested, kind: fromId };
    throw new Error(`device ${requested} not found. Connected: ${describeDevices(devices ?? [])}`);
  }
  const usable = (devices ?? []).filter((d) => classifyDevice(d) !== 'web');
  if (usable.length === 1) return { id: usable[0].id, kind: classifyDevice(usable[0]), ...(usable[0].name ? { name: usable[0].name } : {}) };
  if (!usable.length) throw new Error('no device found: start an emulator or simulator, or pass --device (e.g. -d macos)');
  throw new Error(`several devices are connected: pass --device (-d). Connected: ${describeDevices(usable)}`);
}

function describeDevices(devices: FlutterDevice[]): string {
  return devices.length ? devices.map((d) => `${d.id}${d.name ? ` (${d.name})` : ''}`).join(', ') : 'none';
}
