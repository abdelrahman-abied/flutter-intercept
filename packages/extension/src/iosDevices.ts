/**
 * Physical iOS device detection (CONTRACTS §7).
 *
 * Method (fast first, authoritative where it matters, never slow on the launch path):
 *  1. Format of the Flutter device id, which for iOS is the Apple UDID:
 *     - physical, 2018+ (A12 and later):  8 hex, '-', 16 hex   e.g. 00008110-000A1B2C3D4E5F60
 *     - physical, older devices:           40 hex               e.g. 2b6f0cc904d137be2e1730235f5664094b831186
 *     - simulator (CoreSimulator):         RFC 4122 UUID 8-4-4-4-12  e.g. 5A3F2C1E-7B4D-4E8A-9C6B-1D2E3F4A5B6C
 *     Android serials (`emulator-5554`, `R58M...`), `macos`, `chrome`, `linux`, `windows`,
 *     `web-server` never match the two physical shapes.
 *  2. Cross-check against `xcrun simctl list devices --json` (local, ~100-300 ms): an id that
 *     is a simulator is never treated as physical, whatever its shape. Cached; refreshed at most
 *     every 30 s and only when the id is not already known; bounded by a 3 s timeout. If simctl is
 *     unavailable (no Xcode) the format decides.
 *  `flutter devices --machine` (`"emulator": false`, `"targetPlatform": "ios"`) would also work
 *  but takes seconds (it rediscovers wireless devices), so it is not used on the launch path.
 */
import { execFile } from 'child_process';

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const PHYSICAL_NEW = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/;
const PHYSICAL_OLD = /^[0-9A-Fa-f]{40}$/;
const SIM_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export type DeviceKind = 'ios-physical' | 'ios-simulator' | 'other';

/** Step 1 only (pure). */
export function kindFromId(deviceId: string | undefined): DeviceKind {
  if (!deviceId) return 'other';
  if (PHYSICAL_NEW.test(deviceId) || PHYSICAL_OLD.test(deviceId)) return 'ios-physical';
  if (SIM_UUID.test(deviceId)) return 'ios-simulator';
  return 'other';
}

/** UDIDs of all simulators in `xcrun simctl list devices --json` output. */
export function parseSimctl(json: string): Set<string> {
  const ids = new Set<string>();
  try {
    const data = JSON.parse(json) as { devices?: Record<string, { udid?: string }[]> };
    for (const list of Object.values(data.devices ?? {})) for (const d of list ?? []) if (d?.udid) ids.add(d.udid.toUpperCase());
  } catch {
    // unparsable: treat as unknown
  }
  return ids;
}

export interface IosDeviceClassifierOptions {
  exec?: Exec;
  platform?: NodeJS.Platform;
  now?: () => number;
  refreshMs?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export class IosDeviceClassifier {
  private simulators?: Set<string>;
  private loadedAt = 0;
  private loading?: Promise<Set<string> | undefined>;

  constructor(private readonly opts: IosDeviceClassifierOptions = {}) {}

  private async simulatorIds(): Promise<Set<string> | undefined> {
    if ((this.opts.platform ?? process.platform) !== 'darwin') return undefined;
    const now = (this.opts.now ?? Date.now)();
    if (this.simulators && now - this.loadedAt < (this.opts.refreshMs ?? 30_000)) return this.simulators;
    if (!this.loading) {
      this.loading = (this.opts.exec ?? defaultExec)('xcrun', ['simctl', 'list', 'devices', '--json'], this.opts.timeoutMs ?? 3000)
        .then(({ stdout }) => {
          this.simulators = parseSimctl(stdout);
          this.loadedAt = (this.opts.now ?? Date.now)();
          return this.simulators;
        })
        .catch((e) => {
          this.opts.log?.(`xcrun simctl unavailable (${String((e as Error)?.message ?? e).split('\n')[0]}); classifying iOS devices by id format`);
          return this.simulators;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.loading;
  }

  async classify(deviceId: string | undefined): Promise<DeviceKind> {
    const byFormat = kindFromId(deviceId);
    if (byFormat === 'other' || !deviceId) return 'other';
    const cachedSim = this.simulators?.has(deviceId.toUpperCase());
    if (cachedSim) return 'ios-simulator';
    const sims = await this.simulatorIds();
    if (sims?.has(deviceId.toUpperCase())) return 'ios-simulator';
    return byFormat;
  }
}
