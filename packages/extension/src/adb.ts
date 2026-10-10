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

// ---------------------------------------------------------------------------------------------------------------
// CONTRACTS §14.7 (docs/spikes/native-proxy.md): `flutterIntercept.nativeClients: "proxy"` on an Android EMULATOR
// routes the platform's own HTTP stack (cronet_http, ok_http, HttpURLConnection) through the proxy with the
// emulator-wide global proxy `settings put global http_proxy 10.0.2.2:<port>`, for the session only.
// Measured: cronet honours it at once; HTTPS then works only when the app trusts the Flutter Intercept CA (a debug
// `network_security_config`), which no adb command can arrange on a Play Store image (no root, user CAs need the
// Settings UI and are ignored by apps without that config).
// Revert = `put :0` (clears ConnectivityService's global proxy; a bare `delete` leaves it active), then `delete`
// when the key was unset before, or the previous value. Every applied value is written to the store first, so a
// crash is repaired by `recover()` on the next activation (or the next apply on that emulator).
// REVIEW-8 #7: the store (globalState) is shared by every VS Code window, so each record names its owner (a random
// id per instance + its pid) and carries a heartbeat refreshed every 30 s while routed; `recover()` only reverts
// records whose owner is gone (pid dead, or heartbeat older than 2 min). The emulator's actual `http_proxy` is
// re-read every 30 s (and on demand, ≤ 1 per 10 s): a route someone else reverted or replaced is dropped.
// ---------------------------------------------------------------------------------------------------------------

/** The emulator's alias for the host loopback (CONTRACTS §2). */
export const EMULATOR_HOST_ALIAS = '10.0.2.2';
const EMULATOR_SERIAL = /^emulator-\d{1,5}$/;
const CLEARED = ':0';
const MAX_PROXY_RECORDS = 20;

/** One emulator whose global proxy we set (persisted so a crash can be repaired). */
export interface GlobalProxyRecord {
  serial: string;
  /** What we put (`10.0.2.2:<port>`). */
  value: string;
  /** `http_proxy` before we touched it (`null` = unset). */
  previous: string | null;
  /** REVIEW-8 #7: the instance that set it (random per extension host), its pid and its last heartbeat (epoch ms). */
  owner?: string;
  pid?: number;
  heartbeat?: number;
}

/** Persistence for crash recovery (the host passes `context.globalState`-backed get / set). */
export interface GlobalProxyStore {
  get(): GlobalProxyRecord[];
  set(records: GlobalProxyRecord[]): void | PromiseLike<void>;
}

export type GlobalProxyResult =
  | { applied: true; serial: string; value: string }
  | { applied: false; reason: 'not-emulator' | 'adb-missing' | 'not-connected' | 'user-proxy' | 'failed'; detail?: string };

export interface AndroidGlobalProxyOptions extends AdbOptions {
  store?: GlobalProxyStore;
  /** Owner id of this instance (default: random). */
  ownerId?: string;
  /** This process's pid (default `process.pid`). */
  pid?: number;
  /** Whether a pid is alive (default `process.kill(pid, 0)`). */
  pidAlive?(pid: number): boolean;
  now?(): number;
  /** Heartbeat + re-check period while routed, ms (default 30 s; 0 = no timer, tests drive `tick()`). */
  heartbeatMs?: number;
  /** A record whose heartbeat is older than this belongs to a gone owner, ms (default 2 min). */
  staleMs?: number;
  /** `isRouted()` re-reads `http_proxy` at most this often, ms (default 10 s). */
  recheckMs?: number;
}

export const GLOBAL_PROXY_HEARTBEAT_MS = 30_000;
export const GLOBAL_PROXY_STALE_MS = 120_000;
const RECHECK_MS = 10_000;

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `settings get` output → value, `null` when unset. */
export function parseSettingValue(stdout: string): string | null {
  const v = stdout.trim();
  return v === '' || v === 'null' ? null : v;
}

function isValidRecord(r: unknown): r is GlobalProxyRecord {
  const o = r as GlobalProxyRecord;
  return (
    !!o &&
    typeof o.serial === 'string' &&
    EMULATOR_SERIAL.test(o.serial) &&
    typeof o.value === 'string' &&
    /^10\.0\.2\.2:\d{1,5}$/.test(o.value) &&
    (o.previous === null || (typeof o.previous === 'string' && o.previous.length <= 300)) &&
    (o.owner === undefined || (typeof o.owner === 'string' && o.owner.length <= 100)) &&
    (o.pid === undefined || (Number.isInteger(o.pid) && o.pid > 0)) &&
    (o.heartbeat === undefined || Number.isFinite(o.heartbeat))
  );
}

/**
 * Per-session global proxy on Android emulators. Reference-counted per emulator (two sessions on one emulator
 * share it); reverted when the last session on it is released, on `releaseAll()` (deactivate) and by `recover()`.
 * Never touches a proxy someone else set (a non-empty `http_proxy`, or a global proxy from a device policy), and on
 * release never overwrites a value that changed meanwhile. Never throws.
 */
export class AndroidGlobalProxy {
  private readonly sessions = new Map<string, string>(); // sessionId → serial
  private readonly active = new Map<string, GlobalProxyRecord>(); // serial → record (applied by this process)
  private chain: Promise<unknown> = Promise.resolve();
  private readonly owner: string;
  private readonly pid: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly lastCheck = new Map<string, number>(); // serial → epoch ms
  private checking = false;

  constructor(private readonly opts: AndroidGlobalProxyOptions = {}) {
    this.owner = opts.ownerId ?? `fi-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    this.pid = opts.pid ?? process.pid;
  }

  /**
   * Whether this session's emulator is routed through the proxy right now. Re-reads the emulator's `http_proxy` in
   * the background at most every `recheckMs` (REVIEW-8 #7); a route that is no longer ours is dropped then.
   */
  isRouted(sessionId: string): boolean {
    const serial = this.sessions.get(sessionId);
    if (serial === undefined || !this.active.has(serial)) return false;
    if (this.now() - (this.lastCheck.get(serial) ?? 0) >= (this.opts.recheckMs ?? RECHECK_MS)) void this.recheck();
    return this.active.has(serial);
  }

  /** Heartbeat + re-check (the timer calls it; tests may call it directly). */
  tick(): Promise<void> {
    return this.serial(async () => {
      await this.recheckNow();
      if (this.active.size === 0) return;
      const t = this.now();
      await this.save(this.stored().map((r) => (this.active.has(r.serial) && r.owner === this.owner ? { ...r, heartbeat: t } : r)));
    });
  }

  /** Emulators currently routed by us. */
  get routed(): string[] {
    return [...this.active.keys()];
  }

  /** Routes `serial` through `10.0.2.2:<port>` for this session. */
  apply(sessionId: string, serial: string | undefined, port: number): Promise<GlobalProxyResult> {
    return this.serial(() => this.doApply(sessionId, serial, port));
  }

  /** The session ended (or routing failed): reverts the emulator when no other session uses it. */
  release(sessionId: string): Promise<void> {
    return this.serial(async () => {
      const serial = this.sessions.get(sessionId);
      if (serial === undefined) return;
      this.sessions.delete(sessionId);
      if ([...this.sessions.values()].includes(serial)) return;
      const rec = this.active.get(serial);
      if (rec) await this.revert(rec);
    });
  }

  /** Reverts everything this process applied (extension deactivate). */
  releaseAll(): Promise<void> {
    return this.serial(async () => {
      this.sessions.clear();
      for (const rec of [...this.active.values()]) await this.revert(rec);
    });
  }

  /** Repairs emulators left routed by a previous run (crash / killed window). Returns how many were reverted. */
  recover(): Promise<number> {
    return this.serial(async () => {
      const adb = this.adb();
      if (!adb) return 0;
      let connected: string[];
      try {
        connected = parseAdbDevices((await this.exec(adb, ['devices'])).stdout);
      } catch {
        return 0;
      }
      let n = 0;
      for (const rec of this.stored()) {
        if (this.active.has(rec.serial) || !connected.includes(rec.serial)) continue; // offline: kept for later
        if (this.ownerAlive(rec)) continue; // REVIEW-8 #7: another window's live session
        if (await this.revert(rec)) n++;
      }
      return n;
    });
  }

  // ------------------------------------------------------------------------------------------------- internals

  private now(): number {
    try {
      return this.opts.now ? this.opts.now() : Date.now();
    } catch {
      return Date.now();
    }
  }

  /** Someone else's live record: owner differs, pid alive and heartbeat fresh. */
  private ownerAlive(r: GlobalProxyRecord): boolean {
    if (!r.owner || r.owner === this.owner || r.pid === undefined || r.heartbeat === undefined) return false;
    if (this.now() - r.heartbeat > (this.opts.staleMs ?? GLOBAL_PROXY_STALE_MS)) return false;
    try {
      return (this.opts.pidAlive ?? defaultPidAlive)(r.pid);
    } catch {
      return false;
    }
  }

  private recheck(): Promise<void> {
    if (this.checking) return Promise.resolve();
    this.checking = true;
    return this.serial(() => this.recheckNow()).finally(() => (this.checking = false));
  }

  /** Drops routes whose emulator no longer has our value (reverted by another window, the user, a script). */
  private async recheckNow(): Promise<void> {
    const adb = this.adb();
    if (!adb) return;
    for (const rec of [...this.active.values()]) {
      this.lastCheck.set(rec.serial, this.now());
      let current: string | null;
      try {
        current = await this.get(adb, rec.serial, 'http_proxy');
      } catch {
        continue; // offline for a moment: keep it
      }
      if (current === rec.value) continue;
      this.active.delete(rec.serial);
      for (const [sid, s] of this.sessions) if (s === rec.serial) this.sessions.delete(sid);
      await this.save(this.stored().filter((r) => !(r.serial === rec.serial && r.owner === this.owner)));
      this.log(`native proxy: ${rec.serial} http_proxy changed outside this window (${current ?? 'unset'}); no longer routed`);
    }
    this.updateTimer();
  }

  private updateTimer(): void {
    const ms = this.opts.heartbeatMs ?? GLOBAL_PROXY_HEARTBEAT_MS;
    if (this.active.size > 0 && !this.timer && ms > 0) {
      this.timer = setInterval(() => void this.tick(), ms);
      this.timer.unref?.();
    } else if (this.active.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private log(msg: string): void {
    try {
      this.opts.log?.(msg);
    } catch {
      /* ignore */
    }
  }

  private adb(): string | undefined {
    return this.opts.adbPath === null ? undefined : this.opts.adbPath ?? locateAdb();
  }

  private exec(adb: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return (this.opts.exec ?? defaultExec)(adb, args, this.opts.timeoutMs ?? 5000);
  }

  private async get(adb: string, serial: string, key: string): Promise<string | null> {
    return parseSettingValue((await this.exec(adb, ['-s', serial, 'shell', 'settings', 'get', 'global', key])).stdout);
  }

  private stored(): GlobalProxyRecord[] {
    try {
      const v = this.opts.store?.get();
      return Array.isArray(v) ? v.filter(isValidRecord) : [];
    } catch {
      return [];
    }
  }

  private async save(records: GlobalProxyRecord[]): Promise<void> {
    try {
      await this.opts.store?.set(records.slice(-MAX_PROXY_RECORDS));
    } catch (e) {
      this.log(`native proxy: could not save the emulator proxy state (${errorText(e)})`);
    }
  }

  private async doApply(sessionId: string, serial: string | undefined, port: number): Promise<GlobalProxyResult> {
    if (!serial || !EMULATOR_SERIAL.test(serial)) return { applied: false, reason: 'not-emulator' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { applied: false, reason: 'failed', detail: `invalid port ${port}` };
    const adb = this.adb();
    if (!adb) return { applied: false, reason: 'adb-missing' };
    const value = `${EMULATOR_HOST_ALIAS}:${port}`;
    const mine = this.active.get(serial);
    try {
      const connected = parseAdbDevices((await this.exec(adb, ['devices'])).stdout);
      if (!connected.includes(serial)) return { applied: false, reason: 'not-connected' };
      const current = await this.get(adb, serial, 'http_proxy');
      let previous: string | null;
      if (mine) {
        if (current !== mine.value) {
          // Changed behind our back: it isn't ours any more.
          this.active.delete(serial);
          await this.save(this.stored().filter((r) => r.serial !== serial));
          this.log(`native proxy: ${serial} http_proxy changed outside Flutter Intercept; leaving it alone`);
          return { applied: false, reason: 'user-proxy' };
        }
        previous = mine.previous;
      } else {
        const stale = this.stored().find((r) => r.serial === serial);
        if (stale && current === stale.value && this.ownerAlive(stale)) {
          this.log(`native proxy: ${serial} is routed by another VS Code window; not changing it`);
          return { applied: false, reason: 'user-proxy' };
        }
        if (stale && current === stale.value) {
          previous = stale.previous; // left by a previous run: its `previous` is the real one
        } else if (current !== null && current !== CLEARED) {
          this.log(`native proxy: ${serial} already has a global proxy; not changing it`);
          return { applied: false, reason: 'user-proxy' };
        } else {
          const host = await this.get(adb, serial, 'global_http_proxy_host');
          const pac = await this.get(adb, serial, 'global_proxy_pac_url');
          if (host || pac) {
            this.log(`native proxy: ${serial} has a global proxy from a device policy; not changing it`);
            return { applied: false, reason: 'user-proxy' };
          }
          previous = current;
        }
      }
      const rec: GlobalProxyRecord = { serial, value, previous, owner: this.owner, pid: this.pid, heartbeat: this.now() };
      // Persist first: a crash between `put` and the next save must still be repairable.
      await this.save([...this.stored().filter((r) => r.serial !== serial), rec]);
      if (current !== value) await this.exec(adb, ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', value]);
      const now = await this.get(adb, serial, 'http_proxy');
      if (now !== value) {
        await this.revert(rec);
        return { applied: false, reason: 'failed', detail: `http_proxy reads ${now ?? 'null'} after the change` };
      }
      this.active.set(serial, rec);
      this.sessions.set(sessionId, serial);
      this.lastCheck.set(serial, this.now());
      this.updateTimer();
      if (!mine) this.log(`native proxy: ${serial} http_proxy → ${value} (previously ${previous ?? 'unset'})`);
      return { applied: true, serial, value };
    } catch (e) {
      const detail = errorText(e).slice(0, 300);
      this.log(`native proxy: could not route ${serial} (${detail})`);
      return { applied: false, reason: 'failed', detail };
    }
  }

  /** Puts the previous value back if the current one is still ours. True when the emulator no longer uses ours. */
  private async revert(rec: GlobalProxyRecord): Promise<boolean> {
    this.active.delete(rec.serial);
    for (const [sid, s] of this.sessions) if (s === rec.serial) this.sessions.delete(sid);
    this.updateTimer();
    const adb = this.adb();
    if (!adb) return false;
    try {
      const current = await this.get(adb, rec.serial, 'http_proxy');
      if (current === rec.value) {
        const put = (v: string) => this.exec(adb, ['-s', rec.serial, 'shell', 'settings', 'put', 'global', 'http_proxy', v]);
        await put(CLEARED);
        if (rec.previous === null) await this.exec(adb, ['-s', rec.serial, 'shell', 'settings', 'delete', 'global', 'http_proxy']);
        else if (rec.previous !== CLEARED) await put(rec.previous);
        this.log(`native proxy: ${rec.serial} http_proxy restored (${rec.previous ?? 'unset'})`);
      } else {
        this.log(`native proxy: ${rec.serial} http_proxy is no longer ours; left as is`);
      }
      await this.save(this.stored().filter((r) => r.serial !== rec.serial));
      return true;
    } catch (e) {
      this.log(`native proxy: could not restore ${rec.serial} (${errorText(e).slice(0, 300)}); will retry on the next start`);
      return false;
    }
  }
}
