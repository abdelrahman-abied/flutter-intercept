/**
 * Guards for the device suite (devices.ts) so a dead build or a hung device costs seconds, not hours:
 *  - waitForMarker: waits for the app's marker line (`DEMO_BATCH done`, …) but ends at once when the debug
 *    session ended or the tool output shows a build / launch failure, quoting the session's last lines;
 *  - checkDeviceHealth: one quick round trip to the device (adb / simctl) before its cases run;
 *  - withTimeout / runWithWatchdog: outer bounds for calls into Dart-Code / flutter that have none;
 *  - killDeviceTools: kills `simctl …<udid>` / `adb -s <serial>` processes left hanging (CoreSimulator wedged).
 * No `vscode` import: the pure parts are unit-tested (test/unit/deviceGuard.test.ts).
 */
import { spawn } from 'child_process';

export const TAIL_LINES = 20;
export const TAIL_BYTES = 2048;

/** The app's own output (never a tool failure, even when it prints "Exception: …" in a result body). */
const APP_LINE = /DEMO_[A-Z]+|\[flutter_intercept\]|^\s*(?:[IEWD]\/)?flutter\s*(?:\(\s*\d+\))?:/;

/** Lines the flutter tool / Gradle / Xcode print when the app cannot be built, installed or launched. */
const START_FAILURE: RegExp[] = [
  /Gradle task \S+ failed/,
  /^\s*FAILURE: Build failed/,
  /^\s*BUILD FAILED\b/,
  /Could not build the (?:precompiled )?application/,
  /^\s*Could not build\b/,
  /Xcode build failed/i,
  /^\s*Failed to build (?:iOS|macOS) app/,
  /^\s*Error \(Xcode\):/,
  /^\s*Error launching application/,
  /^\s*Error waiting for a debug connection/,
  /^\s*Unable to (?:install|launch|start|terminate) /,
  /^\s*Error: /,
  /^\s*Exception: /,
  /^\S+\.dart:\d+:\d+: Error: /,
];

/**
 * The first build / launch failure line in `text` (trimmed, ≤ 300 chars), or undefined. Only the part before
 * the app's first `DEMO_START` is scanned: once the app runs, nothing it prints can be a build failure.
 */
export function detectStartFailure(text: string): string | undefined {
  const start = text.search(/DEMO_START/);
  const head = start < 0 ? text : text.slice(0, start);
  for (const line of head.split(/\r?\n/)) {
    if (APP_LINE.test(line)) continue;
    if (START_FAILURE.some((re) => re.test(line))) return line.trim().slice(0, 300);
  }
  return undefined;
}

/** The last `lines` non-empty lines of `text`, cut to the last `bytes` bytes (UTF-8). */
export function tailOf(text: string, lines = TAIL_LINES, bytes = TAIL_BYTES): string {
  let tail = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join('\n');
  if (Buffer.byteLength(tail, 'utf8') <= bytes) return tail;
  const buf = Buffer.from(tail, 'utf8');
  tail = buf.subarray(buf.length - (bytes - 3)).toString('utf8').replace(/^�+/, '');
  return `…${tail}`;
}

export type WaitFailure = 'ended' | 'start-failed' | 'timeout' | 'aborted';

export class WaitError extends Error {
  constructor(
    readonly kind: WaitFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WaitError';
  }
}

export interface WaitForMarkerOptions {
  /** Everything the session printed so far. */
  output: () => string;
  /** True once the debug session terminated. */
  ended: () => boolean;
  /** A reason when the case was aborted (watchdog), else undefined. */
  aborted?: () => string | undefined;
  marker: RegExp;
  /** Human name of what is awaited, e.g. "DEMO_BATCH done". */
  label: string;
  /** Only output after this offset counts (hot restart). */
  from?: number;
  /** Outer bound only: normally the marker, the session end or a failure line ends the wait first. */
  timeoutMs: number;
  pollMs?: number;
  /** After the session ended: time for trailing output events before giving up on the marker. */
  endGraceMs?: number;
  /** After a failure line: time for the session to end / the error to finish printing (for the quoted tail). */
  failureGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves with the output after `from` once `marker` is in it; rejects with a WaitError quoting the tail. */
export async function waitForMarker(o: WaitForMarkerOptions): Promise<string> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? realSleep;
  const from = o.from ?? 0;
  const poll = o.pollMs ?? 250;
  const start = now();
  const text = () => o.output().slice(from);
  const fail = (kind: WaitFailure, why: string): never => {
    throw new WaitError(kind, `${why} before "${o.label}" (after ${Math.round((now() - start) / 1000)} s); last output:\n${tailOf(text()) || '<no output>'}`);
  };
  for (;;) {
    if (o.marker.test(text())) return text();
    const abort = o.aborted?.();
    if (abort) fail('aborted', abort);
    if (o.ended()) {
      for (const end = now() + (o.endGraceMs ?? 1500); now() < end; ) {
        await sleep(Math.min(poll, 250));
        if (o.marker.test(text())) return text();
      }
      fail('ended', 'the debug session ended');
    }
    const failure = detectStartFailure(text());
    if (failure) {
      for (const end = now() + (o.failureGraceMs ?? 10_000); now() < end && !o.ended(); ) await sleep(poll);
      if (o.marker.test(text())) return text();
      fail('start-failed', `the app failed to build or start ("${failure}")`);
    }
    if (now() - start > o.timeoutMs) fail('timeout', `timed out after ${Math.round(o.timeoutMs / 1000)} s`);
    await sleep(poll);
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** `p`, or a TimeoutError after `ms` (the call itself keeps running; its late rejection is swallowed). */
export function withTimeout<T>(p: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const pp = Promise.resolve(p);
  pp.catch(() => undefined);
  return Promise.race([
    pp,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`${what} did not return within ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export type WatchdogResult<T> = { ok: true; value: T } | { ok: false; error: unknown; timedOut: boolean };

/**
 * Runs `body` with an outer bound. On expiry `state.aborted` is set (waits in the body then stop at their next
 * poll), `onTimeout` runs (stop the session …) and the result is returned without waiting for the body.
 */
export async function runWithWatchdog<T>(
  ms: number,
  body: (state: { aborted?: string }) => Promise<T>,
  onTimeout: (reason: string) => Promise<void>,
): Promise<WatchdogResult<T>> {
  const state: { aborted?: string } = {};
  let timer: NodeJS.Timeout | undefined;
  const run = body(state).then(
    (value): WatchdogResult<T> => ({ ok: true, value }),
    (error: unknown): WatchdogResult<T> => ({ ok: false, error, timedOut: false }),
  );
  const expired = new Promise<'expired'>((r) => {
    timer = setTimeout(() => r('expired'), ms);
  });
  const first = await Promise.race([run, expired]);
  clearTimeout(timer);
  if (first !== 'expired') return first;
  const reason = `watchdog: the case did not finish within ${Math.round(ms / 60_000)} min`;
  state.aborted = reason;
  await onTimeout(reason).catch(() => undefined);
  return { ok: false, error: new TimeoutError(reason), timedOut: true };
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command with a hard bound: SIGKILL at `timeoutMs`, and the promise settles at the bound even if the
 * process never exits (a process stuck in CoreSimulator can outlive a SIGKILL'd wait).
 */
export function hardExec(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      f();
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish(() => reject(new TimeoutError(`${[file, ...args].join(' ')} did not return within ${Math.round(timeoutMs / 1000)} s`)));
    }, timeoutMs);
    p.stdout?.on('data', (d) => (stdout += d));
    p.stderr?.on('data', (d) => (stderr += d));
    p.on('error', (e) => finish(() => reject(e)));
    p.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

export type DeviceKind = 'android' | 'ios-simulator' | 'other';
export type HealthExec = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

export const ANDROID_HEALTH_MS = 10_000;
export const SIM_HEALTH_MS = 30_000;

/** undefined when the device answers; otherwise "device not responding: …". macOS / others: always healthy. */
export async function checkDeviceHealth(kind: DeviceKind, id: string, tools: { adb: string; xcrun: string }, exec: HealthExec = hardExec): Promise<string | undefined> {
  const probe =
    kind === 'android'
      ? { file: tools.adb, args: ['-s', id, 'shell', 'echo', 'ok'], ms: ANDROID_HEALTH_MS, ok: (out: string) => /\bok\b/.test(out) }
      : kind === 'ios-simulator'
        ? { file: tools.xcrun, args: ['simctl', 'getenv', id, 'HOME'], ms: SIM_HEALTH_MS, ok: (out: string) => out.trim().length > 0 }
        : undefined;
  if (!probe) return undefined;
  const cmd = [probe.file === tools.adb ? 'adb' : 'xcrun', ...probe.args].join(' ');
  try {
    const r = await exec(probe.file, probe.args, probe.ms);
    if (r.code === 0 && probe.ok(r.stdout)) return undefined;
    return `device not responding: ${cmd} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300) || '<no output>'}`;
  } catch (e) {
    return `device not responding: ${e instanceof TimeoutError ? e.message.replace(/^.*did not/, `${cmd} did not`) : `${cmd}: ${String(e).slice(0, 300)}`}`;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `pkill -f` patterns for the device tool processes a hung stop leaves behind (flutter's `simctl terminate`, adb). */
export function deviceToolPatterns(kind: DeviceKind, id: string): string[] {
  if (kind === 'ios-simulator') return [`simctl .*${escapeRe(id)}`];
  if (kind === 'android') return [`adb -s ${escapeRe(id)} `];
  return [];
}

/** Kills (SIGKILL) the device tool processes matching deviceToolPatterns; returns what was found, for the log. */
export async function killDeviceTools(kind: DeviceKind, id: string, exec: HealthExec = hardExec): Promise<string[]> {
  const killed: string[] = [];
  for (const pattern of deviceToolPatterns(kind, id)) {
    const found = await exec('pgrep', ['-lf', pattern], 5_000).catch(() => undefined);
    const lines = (found?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    killed.push(...lines);
    await exec('pkill', ['-KILL', '-f', pattern], 5_000).catch(() => undefined);
  }
  return killed;
}
