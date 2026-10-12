/**
 * CONTRACTS §19.3: opt-in trust of the Flutter Intercept CA on a booted iOS Simulator, so apps using the OS roots
 * (grpc-dart's default `ChannelCredentials.secure()`, which builds `SecurityContext(withTrustedRoots: true)` → SecTrust)
 * accept the proxy's certificates and TLS gRPC can be decrypted. docs/spikes/ios-sim-trust.md (measured on iOS 26.5):
 *  - `xcrun simctl keychain <udid> add-root-cert <pem>` adds ONE row to
 *    `<dataPath>/private/var/protected/trustd/private/TrustStore.sqlite3`, table `tsettings`, keyed by the sha256 of
 *    the certificate DER; it takes effect at the next TLS handshake (no reboot, no app restart). Booted only.
 *  - simctl has no remove action (`reset` wipes everything: never used). Deleting exactly that row with sqlite3
 *    removes the trust, booted or shut down, and stays removed across boots; other rows are untouched.
 * Rules: booted iOS simulators only (physical devices are never in `simctl list`); read-only check first; a row that
 * was there before us (no record of ours or of another live window) is `pre-existing` and never removed; the record is
 * written before the add (crash → `recover()`); the add gets a certificate-only PEM in a 0600 file in a private temp
 * directory, deleted afterwards; only our row is deleted, by sha256, with a busy timeout. No shell: execFile with
 * argument arrays and absolute tool paths. Never throws.
 *
 * Ownership mirrors AndroidGlobalProxy (src/adb.ts, REVIEW-8 #7): the store is shared by every VS Code window (and
 * the sidecar / CLI), each record names its owner (random per instance), pid and heartbeat (refreshed every 30 s);
 * the row is deleted only when no live owner still holds a record for the same simulator + certificate.
 *
 * No `vscode` import: unit-tested with fakes (test/unit/iosSimTrust.test.ts).
 */
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

export const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The file operations used (injected in tests). */
export interface SimTrustFs {
  exists(p: string): Promise<boolean>;
  /** `fs.mkdtemp` (the directory is created 0700). */
  mkdtemp(prefix: string): Promise<string>;
  /** Creates a new file (fails if it exists) with `mode`. */
  writeFile(p: string, data: string, mode: number): Promise<void>;
  /** Removes a file or directory tree; no error when missing. */
  rm(p: string): Promise<void>;
}

export const nodeFs: SimTrustFs = {
  exists: async (p) => {
    try {
      await fs.promises.stat(p);
      return true;
    } catch {
      return false;
    }
  },
  mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
  writeFile: (p, data, mode) => fs.promises.writeFile(p, data, { mode, flag: 'wx' }),
  rm: (p) => fs.promises.rm(p, { recursive: true, force: true }),
};

export const XCRUN = '/usr/bin/xcrun';
export const SQLITE3 = '/usr/bin/sqlite3';
/** The trust store, relative to the device's `dataPath` (iOS 26.x layout). */
export const TRUST_STORE_SEGMENTS = ['private', 'var', 'protected', 'trustd', 'private', 'TrustStore.sqlite3'] as const;
export const SIM_TRUST_HEARTBEAT_MS = 30_000;
export const SIM_TRUST_STALE_MS = 120_000;
/** sqlite3 waits this long for trustd's lock. */
export const SQLITE_BUSY_MS = 5000;
const MAX_RECORDS = 20;
const LIST_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 20_000;
const SQLITE_TIMEOUT_MS = 10_000;

const SIM_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const SHA256_HEX = /^[0-9A-F]{64}$/;

/** One simulator whose trust store we added our CA to (persisted so a crash can be repaired). */
export interface SimTrustRecord {
  udid: string;
  /** The device's `dataPath` (from `simctl list devices -j`). */
  dataPath: string;
  /** sha256 (upper-case hex) of the CA certificate DER = the `tsettings.sha256` key. */
  sha256: string;
  owner: string;
  pid: number;
  /** Epoch ms, refreshed every 30 s while held. */
  heartbeat: number;
}

/** Persistence (the host passes `context.globalState`-backed get / set; the sidecar / CLI a JSON file). */
export interface SimTrustStore {
  get(): SimTrustRecord[] | undefined;
  set(records: SimTrustRecord[]): void | PromiseLike<void>;
}

export type SimTrustState = 'trusted' | 'pre-existing' | 'failed';

/** `Status.grpc.simulatorTrust.devices[]` (CONTRACTS §19.3). */
export interface SimTrustDevice {
  udid: string;
  name?: string;
  state: SimTrustState;
  problem?: string;
}

export type SimTrustResult =
  | { udid: string; name?: string; state: SimTrustState; problem?: string }
  | { udid: string; state: 'not-simulator'; problem: string };

export interface IosSimTrustOptions {
  /** The Flutter Intercept CA certificate (PEM; only the certificate is ever used). A function is read on each ensure. */
  caCertPem: string | (() => string | undefined | Promise<string | undefined>);
  exec?: Exec;
  fs?: SimTrustFs;
  store?: SimTrustStore;
  /** Owner id of this instance (default: random). */
  ownerId?: string;
  /** This process's pid (default `process.pid`). */
  pid?: number;
  /** Whether a pid is alive (default `process.kill(pid, 0)`). */
  pidAlive?(pid: number): boolean;
  now?(): number;
  /** Heartbeat period while holding a trust, ms (default 30 s; 0 = no timer, tests call `tick()`). */
  heartbeatMs?: number;
  /** A record whose heartbeat is older than this belongs to a gone owner, ms (default 2 min). */
  staleMs?: number;
  /** Directory for the temporary certificate file (default `os.tmpdir()`). */
  tmpDir?: string;
  /** Default `process.platform`; anything but darwin does nothing. */
  platform?: NodeJS.Platform;
  log?(msg: string): void;
}

/** A simulator from `xcrun simctl list devices -j` (iOS runtimes only). */
export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  dataPath?: string;
  runtime: string;
}

/** iOS simulators in `simctl list devices -j` output (watchOS / tvOS / visionOS runtimes are skipped). */
export function parseSimulators(json: string): SimDevice[] {
  const out: SimDevice[] = [];
  try {
    const data = JSON.parse(json) as { devices?: Record<string, { udid?: unknown; name?: unknown; state?: unknown; dataPath?: unknown }[]> };
    for (const [runtime, list] of Object.entries(data.devices ?? {})) {
      if (!/SimRuntime\.iOS-/.test(runtime) || !Array.isArray(list)) continue;
      for (const d of list) {
        if (typeof d?.udid !== 'string') continue;
        out.push({
          udid: d.udid.toUpperCase(),
          name: typeof d.name === 'string' ? d.name : '',
          state: typeof d.state === 'string' ? d.state : '',
          dataPath: typeof d.dataPath === 'string' ? d.dataPath : undefined,
          runtime,
        });
      }
    }
  } catch {
    // unparsable: no simulators
  }
  return out;
}

/** A device data path we are willing to write under: absolute, normalized, ending in `/<udid>/data`. */
export function validDataPath(dataPath: string | undefined, udid: string): dataPath is string {
  if (typeof dataPath !== 'string' || dataPath.length > 1024 || !path.isAbsolute(dataPath)) return false;
  if (path.normalize(dataPath) !== dataPath || dataPath.split(path.sep).includes('..')) return false;
  return dataPath.toUpperCase().endsWith(`${path.sep}${udid.toUpperCase()}${path.sep}DATA`);
}

export function trustStorePath(dataPath: string): string {
  return path.join(dataPath, ...TRUST_STORE_SEGMENTS);
}

/** sha256 (upper-case hex) of the certificate DER and its PEM (the certificate alone), or a problem. */
export function caFingerprint(pem: string | undefined): { sha256: string; certPem: string } | { problem: string } {
  if (!pem) return { problem: "The Flutter Intercept CA isn't available yet." };
  try {
    const x = new crypto.X509Certificate(pem);
    if (!x.ca) return { problem: "The Flutter Intercept certificate isn't a CA certificate." };
    return { sha256: x.fingerprint256.replace(/:/g, '').toUpperCase(), certPem: x.toString() };
  } catch (e) {
    return { problem: `The Flutter Intercept CA certificate can't be read (${errorText(e).slice(0, 120)}).` };
  }
}

/**
 * Read-only check of one trust store: whether it has the expected shape and our row. Never writes (sqlite3
 * `-readonly`, and never run on a path that doesn't exist, which sqlite3 would create).
 */
export async function readTrustRow(
  exec: Exec,
  files: Pick<SimTrustFs, 'exists'>,
  storePath: string,
  sha256: string,
): Promise<{ present: boolean } | { problem: string }> {
  if (!SHA256_HEX.test(sha256)) return { problem: 'invalid certificate fingerprint' };
  if (!(await files.exists(storePath))) return { problem: UNKNOWN_STORE };
  try {
    const sql =
      "SELECT COUNT(*) FROM pragma_table_info('tsettings') WHERE name IN ('sha256','data','uuid');" +
      ` SELECT COUNT(*) FROM tsettings WHERE sha256 = x'${sha256}';`;
    const { stdout } = await exec(SQLITE3, ['-readonly', '-bail', '-cmd', `.timeout ${SQLITE_BUSY_MS}`, storePath, sql], SQLITE_TIMEOUT_MS);
    const lines = stdout.trim().split(/\r?\n/).map((l) => l.trim());
    if (lines.length !== 2 || lines[0] !== '3' || !/^\d+$/.test(lines[1])) return { problem: UNKNOWN_STORE };
    return { present: Number(lines[1]) > 0 };
  } catch (e) {
    return { problem: `${UNKNOWN_STORE} (${errorText(e).slice(0, 160)})` };
  }
}

const UNKNOWN_STORE =
  "This Simulator's certificate trust store isn't in the layout Flutter Intercept knows (iOS 26), so the change couldn't be undone safely. Nothing was changed.";

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errorText(e: unknown): string {
  const any = e as { stderr?: string; message?: string };
  return (any?.stderr || any?.message || String(e)).toString().trim().split('\n')[0];
}

function isValidRecord(r: unknown): r is SimTrustRecord {
  const o = r as SimTrustRecord;
  return (
    !!o &&
    typeof o.udid === 'string' &&
    SIM_UDID.test(o.udid) &&
    typeof o.sha256 === 'string' &&
    SHA256_HEX.test(o.sha256) &&
    validDataPath(o.dataPath, o.udid) &&
    typeof o.owner === 'string' &&
    o.owner.length > 0 &&
    o.owner.length <= 100 &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    Number.isFinite(o.heartbeat)
  );
}

interface Entry {
  udid: string;
  name?: string;
  state: SimTrustState;
  problem?: string;
  /** trusted: the row we hold a record for (added by us, or shared with / adopted from another owner). */
  sha256?: string;
  dataPath?: string;
  /** Sessions using it (`''` = no session id given). */
  holders: Set<string>;
}

/** Per-simulator CA trust, reference-counted per session and shared safely between windows. Never throws. */
export class IosSimTrust {
  private readonly entries = new Map<string, Entry>(); // udid → entry
  private chain: Promise<unknown> = Promise.resolve();
  private readonly owner: string;
  private readonly pid: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: IosSimTrustOptions) {
    this.owner = opts.ownerId ?? `fi-${crypto.randomBytes(6).toString('hex')}${Date.now().toString(36)}`;
    this.pid = opts.pid ?? process.pid;
  }

  /** Simulators this instance touched, for `Status.grpc.simulatorTrust.devices`. */
  state(): SimTrustDevice[] {
    return [...this.entries.values()].map((e) => ({ udid: e.udid, ...(e.name ? { name: e.name } : {}), state: e.state, ...(e.problem ? { problem: e.problem } : {}) }));
  }

  /** Whether `udid` is a booted iOS Simulator (physical devices never are). */
  async isSimulator(udid: string | undefined): Promise<boolean> {
    const id = udid?.toUpperCase();
    if (!id || !SIM_UDID.test(id) || this.platform() !== 'darwin') return false;
    return (await this.booted(id)) !== undefined;
  }

  /** Read-only: whether this simulator's trust store has the current CA (undefined: unknown / not a simulator). */
  async isTrusted(udid: string | undefined): Promise<boolean | undefined> {
    const id = udid?.toUpperCase();
    if (!id || !SIM_UDID.test(id) || this.platform() !== 'darwin') return undefined;
    const ca = caFingerprint(await this.caPem());
    if ('problem' in ca) return undefined;
    const dev = (await this.list())?.find((d) => d.udid === id);
    if (!dev || !validDataPath(dev.dataPath, id)) return undefined;
    const r = await readTrustRow(this.exec, this.files, trustStorePath(dev.dataPath), ca.sha256);
    return 'present' in r ? r.present : undefined;
  }

  /** Makes the booted simulator `udid` trust the CA for `sessionId` (session start). */
  ensure(udid: string, opts: { name?: string; sessionId?: string } = {}): Promise<SimTrustResult> {
    return this.serial(() => this.doEnsure(udid, opts));
  }

  /**
   * The session ended: when no other session of this instance holds `udid`, removes our row (unless another live
   * window still holds it). Without `sessionId` (the "Remove it" command), drops every session's hold at once.
   */
  release(udid: string, sessionId?: string): Promise<void> {
    return this.serial(async () => {
      const id = udid.toUpperCase();
      const e = this.entries.get(id);
      if (!e) return;
      if (sessionId !== undefined) {
        e.holders.delete(sessionId);
        if (e.holders.size > 0) return;
      }
      await this.drop(e);
    });
  }

  /** Releases a session on whichever simulator it holds (session end when the host only knows the session id). */
  releaseSession(sessionId: string): Promise<void> {
    return this.serial(async () => {
      for (const e of [...this.entries.values()]) {
        if (!e.holders.delete(sessionId)) continue;
        if (e.holders.size === 0) await this.drop(e);
      }
    });
  }

  /** Releases everything this instance holds (proxy stop, deactivate). */
  releaseAll(): Promise<void> {
    return this.serial(async () => {
      for (const e of [...this.entries.values()]) await this.drop(e);
    });
  }

  /** Repairs trust left by a gone owner (crash, killed window). Returns how many rows were removed. */
  recover(): Promise<number> {
    return this.serial(async () => {
      if (this.platform() !== 'darwin') return 0;
      let n = 0;
      const done = new Set<string>();
      for (const r of this.stored()) {
        const key = `${r.udid}/${r.sha256}`;
        if (done.has(key)) continue;
        const group = this.stored().filter((x) => x.udid === r.udid && x.sha256 === r.sha256);
        const held = group.some((x) => this.isLive(x));
        if (held) continue; // a live window (or this instance) still uses it
        done.add(key);
        if (await this.removeRow(r.udid, r.dataPath, r.sha256)) {
          await this.save(this.stored().filter((x) => !(x.udid === r.udid && x.sha256 === r.sha256)));
          n++;
        }
      }
      return n;
    });
  }

  /** Heartbeat (the timer calls it; tests may call it directly). */
  tick(): Promise<void> {
    return this.serial(async () => {
      const held = new Set([...this.entries.values()].filter((e) => e.state === 'trusted' && e.sha256).map((e) => `${e.udid}/${e.sha256}`));
      if (!held.size) return;
      const t = this.now();
      await this.save(this.stored().map((r) => (r.owner === this.owner && held.has(`${r.udid}/${r.sha256}`) ? { ...r, heartbeat: t } : r)));
    });
  }

  // ------------------------------------------------------------------------------------------------- internals

  private get exec(): Exec {
    return this.opts.exec ?? defaultExec;
  }

  private get files(): SimTrustFs {
    return this.opts.fs ?? nodeFs;
  }

  private platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform;
  }

  private now(): number {
    try {
      return this.opts.now ? this.opts.now() : Date.now();
    } catch {
      return Date.now();
    }
  }

  private async caPem(): Promise<string | undefined> {
    try {
      const c = this.opts.caCertPem;
      return typeof c === 'function' ? await c() : c;
    } catch {
      return undefined;
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private log(msg: string): void {
    try {
      this.opts.log?.(`simulator trust: ${msg}`);
    } catch {
      /* ignore */
    }
  }

  private async list(): Promise<SimDevice[] | undefined> {
    try {
      return parseSimulators((await this.exec(XCRUN, ['simctl', 'list', 'devices', '-j'], LIST_TIMEOUT_MS)).stdout);
    } catch (e) {
      this.log(`xcrun simctl list failed (${errorText(e).slice(0, 200)})`);
      return undefined;
    }
  }

  private async booted(udid: string): Promise<SimDevice | undefined> {
    return (await this.list())?.find((d) => d.udid === udid && d.state === 'Booted');
  }

  /** A record held by a live owner: ours while we hold that simulator + certificate, or another live instance's. */
  private isLive(r: SimTrustRecord): boolean {
    if (r.owner === this.owner) {
      const e = this.entries.get(r.udid);
      return !!e && e.state === 'trusted' && e.sha256 === r.sha256;
    }
    if (this.now() - r.heartbeat > (this.opts.staleMs ?? SIM_TRUST_STALE_MS)) return false;
    try {
      return (this.opts.pidAlive ?? defaultPidAlive)(r.pid);
    } catch {
      return false;
    }
  }

  private stored(): SimTrustRecord[] {
    try {
      const v = this.opts.store?.get();
      return Array.isArray(v) ? v.filter(isValidRecord) : [];
    } catch {
      return [];
    }
  }

  private async save(records: SimTrustRecord[]): Promise<boolean> {
    try {
      await this.opts.store?.set(records.slice(-MAX_RECORDS));
      return true;
    } catch (e) {
      this.log(`could not save the simulator trust state (${errorText(e)})`);
      return false;
    }
  }

  private updateTimer(): void {
    const ms = this.opts.heartbeatMs ?? SIM_TRUST_HEARTBEAT_MS;
    const holding = [...this.entries.values()].some((e) => e.state === 'trusted' && e.sha256);
    if (holding && !this.timer && ms > 0) {
      this.timer = setInterval(() => void this.tick(), ms);
      this.timer.unref?.();
    } else if (!holding && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private result(e: Entry): SimTrustResult {
    return { udid: e.udid, ...(e.name ? { name: e.name } : {}), state: e.state, ...(e.problem ? { problem: e.problem } : {}) };
  }

  private fail(udid: string, name: string | undefined, holder: string, problem: string): SimTrustResult {
    const e: Entry = { udid, name, state: 'failed', problem, holders: new Set([holder]) };
    this.entries.set(udid, e);
    this.log(`${name || udid}: ${problem}`);
    return this.result(e);
  }

  private async doEnsure(udid: string, opts: { name?: string; sessionId?: string }): Promise<SimTrustResult> {
    const id = (udid ?? '').toUpperCase();
    const holder = opts.sessionId ?? '';
    if (this.platform() !== 'darwin') return { udid: id, state: 'not-simulator', problem: 'iOS Simulators only exist on macOS. Nothing was changed.' };
    if (!SIM_UDID.test(id)) return { udid: id, state: 'not-simulator', problem: `${udid} isn't an iOS Simulator. Nothing was changed.` };
    const ca = caFingerprint(await this.caPem());
    const dev = await this.booted(id);
    if (!dev) return { udid: id, state: 'not-simulator', problem: `${opts.name ?? udid} isn't a booted iOS Simulator. Nothing was changed.` };
    const name = opts.name ?? (dev.name || undefined);
    const prev = this.entries.get(id);
    if (prev && prev.state !== 'failed' && !('problem' in ca) && (prev.state === 'pre-existing' || prev.sha256 === ca.sha256)) {
      prev.holders.add(holder);
      return this.result(prev);
    }
    // A failed attempt is retried; a hold on an older CA (regenerated meanwhile) is released first.
    const holders = new Set([...(prev?.holders ?? []), holder]);
    if (prev) await this.drop(prev);
    if ('problem' in ca) return this.withHolders(this.fail(id, name, holder, ca.problem), holders);
    if (!validDataPath(dev.dataPath, id)) return this.withHolders(this.fail(id, name, holder, UNKNOWN_STORE), holders);
    const store = trustStorePath(dev.dataPath);
    const before = await readTrustRow(this.exec, this.files, store, ca.sha256);
    if ('problem' in before) return this.withHolders(this.fail(id, name, holder, before.problem), holders);

    const same = (r: SimTrustRecord) => r.udid === id && r.sha256 === ca.sha256;
    const records = this.stored().filter(same);
    const mine: SimTrustRecord = { udid: id, dataPath: dev.dataPath, sha256: ca.sha256, owner: this.owner, pid: this.pid, heartbeat: this.now() };
    if (before.present) {
      if (!records.length) {
        // Not added by Flutter Intercept (the user, a script, another tool): theirs to keep.
        const e: Entry = { udid: id, name, state: 'pre-existing', holders };
        this.entries.set(id, e);
        this.log(`${name ?? id} already trusts the Flutter Intercept CA (added outside Flutter Intercept); it will be left as is`);
        return this.result(e);
      }
      // Added by Flutter Intercept: shared with a live window, or left by a gone one (adopted).
      const live = records.filter((r) => r.owner !== this.owner && this.isLive(r));
      await this.save([...this.stored().filter((r) => !same(r) || (r.owner !== this.owner && this.isLive(r))), mine]);
      const e: Entry = { udid: id, name, state: 'trusted', sha256: ca.sha256, dataPath: dev.dataPath, holders };
      this.entries.set(id, e);
      this.updateTimer();
      this.log(`${name ?? id} trusts the Flutter Intercept CA (${live.length ? 'shared with another window' : 'left by an earlier run'})`);
      return this.result(e);
    }

    // Record first: a crash between the add and the next save must still be repairable.
    if (!(await this.save([...this.stored().filter((r) => !same(r) || (r.owner !== this.owner && this.isLive(r))), mine]))) {
      return this.withHolders(this.fail(id, name, holder, "Flutter Intercept couldn't save what it is about to change, so it changed nothing."), holders);
    }
    let addError: string | undefined;
    let dir: string | undefined;
    try {
      dir = await this.files.mkdtemp(path.join(this.opts.tmpDir ?? os.tmpdir(), 'fi-simtrust-'));
      const file = path.join(dir, 'flutter-intercept-ca.pem');
      await this.files.writeFile(file, ca.certPem, 0o600);
      await this.exec(XCRUN, ['simctl', 'keychain', id, 'add-root-cert', file], KEYCHAIN_TIMEOUT_MS);
    } catch (e) {
      addError = errorText(e).slice(0, 200);
    } finally {
      if (dir) await this.files.rm(dir).catch(() => undefined);
    }
    const after = await readTrustRow(this.exec, this.files, store, ca.sha256);
    if ('present' in after && after.present) {
      const e: Entry = { udid: id, name, state: 'trusted', sha256: ca.sha256, dataPath: dev.dataPath, holders };
      this.entries.set(id, e);
      this.updateTimer();
      this.log(`${name ?? id} now trusts the Flutter Intercept CA until the session ends${addError ? ` (simctl reported: ${addError})` : ''}`);
      return this.result(e);
    }
    await this.save(this.stored().filter((r) => !(same(r) && r.owner === this.owner)));
    const why = addError ?? ('problem' in after ? after.problem : 'the certificate is not in the trust store afterwards');
    return this.withHolders(this.fail(id, name, holder, `xcrun simctl couldn't add the Flutter Intercept CA to this Simulator (${why}).`), holders);
  }

  private withHolders(r: SimTrustResult, holders: Set<string>): SimTrustResult {
    const e = this.entries.get(r.udid);
    if (e) for (const h of holders) e.holders.add(h);
    return r;
  }

  /** Forgets the entry; for a trust we hold, removes the row unless another live window still holds it. */
  private async drop(e: Entry): Promise<void> {
    this.entries.delete(e.udid);
    this.updateTimer();
    if (e.state !== 'trusted' || !e.sha256 || !e.dataPath) return;
    const same = (r: SimTrustRecord) => r.udid === e.udid && r.sha256 === e.sha256;
    const others = this.stored().filter((r) => same(r) && r.owner !== this.owner && this.isLive(r));
    if (others.length) {
      await this.save(this.stored().filter((r) => !(same(r) && r.owner === this.owner)));
      this.log(`${e.name ?? e.udid}: still used by another window; its trust is kept until that session ends`);
      return;
    }
    if (await this.removeRow(e.udid, e.dataPath, e.sha256, e.name)) {
      await this.save(this.stored().filter((r) => !same(r) || (r.owner !== this.owner && this.isLive(r))));
    }
    // else: the record stays for recover() on the next start.
  }

  /** Deletes exactly our row. True when it is gone (or the simulator itself is gone). */
  private async removeRow(udid: string, dataPath: string, sha256: string, name?: string): Promise<boolean> {
    if (this.platform() !== 'darwin' || !SHA256_HEX.test(sha256) || !validDataPath(dataPath, udid)) return false;
    const label = name ?? udid;
    if (!(await this.files.exists(dataPath))) {
      this.log(`${label}: the Simulator no longer exists; nothing to remove`);
      return true;
    }
    const store = trustStorePath(dataPath);
    const before = await readTrustRow(this.exec, this.files, store, sha256);
    if ('problem' in before) {
      this.log(`${label}: couldn't check the trust store (${before.problem}); will retry on the next start`);
      return false;
    }
    if (!before.present) {
      this.log(`${label}: the Flutter Intercept CA was already removed`);
      return true;
    }
    try {
      await this.exec(SQLITE3, ['-bail', '-cmd', `.timeout ${SQLITE_BUSY_MS}`, store, `DELETE FROM tsettings WHERE sha256 = x'${sha256}';`], SQLITE_TIMEOUT_MS);
    } catch (e) {
      this.log(`${label}: couldn't remove the Flutter Intercept CA (${errorText(e).slice(0, 200)}); will retry on the next start`);
      return false;
    }
    const after = await readTrustRow(this.exec, this.files, store, sha256);
    if ('present' in after && !after.present) {
      this.log(`${label} no longer trusts the Flutter Intercept CA`);
      return true;
    }
    this.log(`${label}: the Flutter Intercept CA is still in the trust store after removing it; will retry on the next start`);
    return false;
  }
}
