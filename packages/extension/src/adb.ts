/**
 * `adb reverse tcp:<port> tcp:<port>` so `localhost:<port>` on an Android device/emulator reaches
 * the proxy on the host. Never throws; every failure is reported through `log`.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

export const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface LocateEnv {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
}

const defaultLocateEnv = (): LocateEnv => ({
  env: process.env,
  home: os.homedir(),
  platform: process.platform,
  exists: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
});

/** ANDROID_HOME, ANDROID_SDK_ROOT, the default SDK location for the OS, then PATH. */
export function locateAdb(le: LocateEnv = defaultLocateEnv()): string | undefined {
  const exe = le.platform === 'win32' ? 'adb.exe' : 'adb';
  const join = le.platform === 'win32' ? path.win32.join : path.posix.join;
  const sdkDirs = [le.env.ANDROID_HOME, le.env.ANDROID_SDK_ROOT].filter((d): d is string => !!d);
  if (le.platform === 'darwin') sdkDirs.push(join(le.home, 'Library', 'Android', 'sdk'));
  else if (le.platform === 'win32') sdkDirs.push(join(le.env.LOCALAPPDATA ?? join(le.home, 'AppData', 'Local'), 'Android', 'Sdk'));
  else sdkDirs.push(join(le.home, 'Android', 'Sdk'));
  for (const dir of sdkDirs) {
    const candidate = join(dir, 'platform-tools', exe);
    if (le.exists(candidate)) return candidate;
  }
  const sep = le.platform === 'win32' ? ';' : ':';
  for (const dir of (le.env.PATH ?? le.env.Path ?? '').split(sep).filter(Boolean)) {
    const candidate = join(dir, exe);
    if (le.exists(candidate)) return candidate;
  }
  return undefined;
}

/** Serials of devices in state `device` from `adb devices` output. */
export function parseAdbDevices(stdout: string): string[] {
  const serials: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+device\b/.exec(line.trim());
    if (m && !line.startsWith('List of devices')) serials.push(m[1]);
  }
  return serials;
}

export interface AdbReverseResult {
  adb?: string;
  /** Serials where tcp:<port> is now reversed by us (newly, or already ours). */
  reversed: string[];
  /** Serials that already had a reverse for tcp:<port> that we did not create: left untouched. */
  userManaged: string[];
  failed: { serial: string; error: string }[];
  skipped?: string;
}

export interface AdbOptions {
  exec?: Exec;
  adbPath?: string | null; // null = force "not found" (tests)
  log?: (msg: string) => void;
  timeoutMs?: number;
  /** With no deviceId: skip emulators (`emulator-*`), which reach the host via 10.0.2.2 (CONTRACTS §2). */
  physicalOnly?: boolean;
  /**
   * Whether an existing reverse for (serial, port) is one we created. Existing reverses that are
   * not ours are "user-managed": never overwritten and never removed. Default: none are ours.
   */
  isOurs?: (serial: string, port: number) => boolean;
}

/** Local ports (`tcp:<n>`) that `adb reverse --list` reports, e.g. `host-23 tcp:8899 tcp:8899`. */
export function parseReverseList(stdout: string): number[] {
  const ports: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /(?:^|\s)tcp:(\d+)\s+\S+/.exec(line.trim());
    if (m) ports.push(Number(m[1]));
  }
  return ports;
}

/**
 * Reverses `port` on `deviceId` if it is a connected Android device, or on every connected
 * Android device when `deviceId` is undefined. Device ids that adb doesn't know (iOS, macOS,
 * chrome...) are ignored.
 */
export async function adbReverse(port: number, deviceId: string | undefined, opts: AdbOptions = {}): Promise<AdbReverseResult> {
  const log = opts.log ?? (() => undefined);
  const exec = opts.exec ?? defaultExec;
  const timeout = opts.timeoutMs ?? 5000;
  const result: AdbReverseResult = { reversed: [], userManaged: [], failed: [] };
  try {
    const adb = opts.adbPath === null ? undefined : opts.adbPath ?? locateAdb();
    result.adb = adb;
    if (!adb) {
      result.skipped = 'adb not found';
      log('adb not found (ANDROID_HOME, ANDROID_SDK_ROOT, default SDK dir, PATH); skipping adb reverse');
      return result;
    }
    const { stdout } = await exec(adb, ['devices'], timeout);
    const connected = parseAdbDevices(stdout);
    const targets = deviceId
      ? connected.filter((s) => s === deviceId)
      : connected.filter((s) => !(opts.physicalOnly && /^emulator-\d+$/.test(s)));
    if (targets.length === 0) {
      result.skipped = deviceId ? `device ${deviceId} is not a connected Android device` : 'no Android devices connected';
      log(`adb reverse skipped: ${result.skipped}`);
      return result;
    }
    await Promise.all(
      targets.map(async (serial) => {
        try {
          // Never take over a reverse someone else set up for this port (it would also be removed later).
          let existing: number[] | undefined;
          try {
            existing = parseReverseList((await exec(adb, ['-s', serial, 'reverse', '--list'], timeout)).stdout);
          } catch (e) {
            log(`adb -s ${serial} reverse --list failed (${errorText(e)}); reversing anyway`);
          }
          if (existing?.includes(port)) {
            if (opts.isOurs?.(serial, port)) {
              result.reversed.push(serial); // already ours: nothing to do
              return;
            }
            result.userManaged.push(serial);
            log(`adb: ${serial} already has a reverse for tcp:${port} that Flutter Intercept did not create; treating it as user-managed (not overwritten, never removed)`);
            return;
          }
          await exec(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], timeout);
          result.reversed.push(serial);
          log(`adb -s ${serial} reverse tcp:${port} tcp:${port}`);
        } catch (e) {
          const error = errorText(e);
          result.failed.push({ serial, error });
          log(`adb reverse failed on ${serial}: ${error}`);
        }
      }),
    );
  } catch (e) {
    result.skipped = `adb failed: ${errorText(e)}`;
    log(result.skipped);
  }
  return result;
}

function errorText(e: unknown): string {
  const any = e as { stderr?: string; message?: string };
  return (any?.stderr || any?.message || String(e)).toString().trim();
}

/** Resolves with the result, or with undefined after `ms` (the work continues in the background). */
export function withSoftTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

/**
 * Remembers the reverses we created so they can be removed when the last intercepted session
 * ends or the proxy stops (CONTRACTS §2: a stale reverse with no proxy breaks plain-http).
 */
export class ReverseTracker {
  private readonly active = new Map<string, { serial: string; port: number }>();
  private readonly inFlight = new Set<Promise<unknown>>();
  constructor(private readonly opts: AdbOptions = {}) {}

  reverse(port: number, deviceId: string | undefined, extra: Pick<AdbOptions, 'physicalOnly'> = {}): Promise<AdbReverseResult> {
    const p = adbReverse(port, deviceId, { ...this.opts, ...extra, isOurs: (serial, prt) => this.active.has(`${serial}:${prt}`) }).then((r) => {
      for (const serial of r.reversed) this.active.set(`${serial}:${port}`, { serial, port });
      return r;
    });
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p)).catch(() => undefined);
    return p;
  }

  get size(): number {
    return this.active.size;
  }

  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * `adb -s <serial> reverse --remove tcp:<port>` for everything we reversed. Waits for reverses
   * still in flight first, so one that completes after the session ended is removed too.
   * User-managed reverses are never in the list. Never throws.
   */
  async removeAll(): Promise<string[]> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    const entries = [...this.active.values()];
    this.active.clear();
    if (entries.length === 0) return [];
    const log = this.opts.log ?? (() => undefined);
    const exec = this.opts.exec ?? defaultExec;
    const adb = this.opts.adbPath === null ? undefined : this.opts.adbPath ?? locateAdb();
    if (!adb) return [];
    const removed: string[] = [];
    await Promise.all(
      entries.map(async ({ serial, port }) => {
        try {
          await exec(adb, ['-s', serial, 'reverse', '--remove', `tcp:${port}`], this.opts.timeoutMs ?? 5000);
          removed.push(`${serial}:${port}`);
          log(`adb -s ${serial} reverse --remove tcp:${port}`);
        } catch (e) {
          log(`adb reverse --remove failed on ${serial}: ${errorText(e)}`);
        }
      }),
    );
    return removed;
  }
}
