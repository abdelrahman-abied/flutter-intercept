/**
 * Headless run (CONTRACTS §13.9): run CA in a temp dir → InterceptProxy on 127.0.0.1 → shared rules / replay /
 * network profile → generated entries → flutter (inherited stdio) → HAR / recording / assertions / JUnit → summary.
 * Every step after the proxy starts is undone in `finally` (proxy stopped, adb reverse removed, wrappers and the CA
 * deleted), also on Ctrl-C (SIGINT / SIGTERM / SIGHUP); `onExit` removes the temp CA, wrappers and adb reverse if the
 * process ends any other way (REVIEW-7 #13).
 */
import { execFileSync, spawn as nodeSpawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InterceptProxy, type Exchange } from '@flutter-intercept/proxy';
import { presetProfile, type NetworkPresetId, type NetworkProfile } from '@flutter-intercept/proxy/network';
import { loadOrCreateCa } from '../../extension/src/ca';
import { findPubspecRoot, hasPubspec, PROXY_DEFINE, readPubspec } from '../../extension/src/entry/generator';
import { locateAdb, ReverseTracker } from '../../extension/src/adb';
import { displayCommand, spawnPlan } from './command';
import { redactUrl } from '../../extension/src/agent/redact';
import { evaluateExpectations, readExpectations, type AssertionResult, type Expectation } from './assertions';
import { kindFromId, listFlutterDevices, pickDevice, proxyRouteFor, type FlutterDevice, type PickedDevice } from './devices';
import { isIntegrationTestPath, prepareEntries, resolveRunTargets, resolveTestTargets, type PreparedEntries } from './entries';
import { toJunitXml } from './junit';
import { loadReplay, writeHarFile, writeOutput, writeRecording } from './outputs';
import { loadRules } from './rules';
import { assertionsTable, trafficTable } from './summary';
import type { CliOptions, CliResult } from './types';

export const ENTRY_SHA_DEFINE = 'FLUTTER_INTERCEPT_ENTRY_SHA';
const FINAL = new Set<Exchange['state']>(['completed', 'mocked', 'blocked', 'aborted', 'error']);

/** A setup problem (bad option, missing file, unsupported device): exit code 2, nothing ran. */
export class SetupError extends Error {
  readonly name = 'SetupError';
}

export interface ChildLike {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (e: Error) => void): unknown;
}

export interface SignalSource {
  on(event: Signal, listener: () => void): unknown;
  off(event: Signal, listener: () => void): unknown;
}

export interface RunDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Progress and problems (stderr). */
  log(msg: string): void;
  /** Results: summary, the `run` command line (stdout). */
  out(msg: string): void;
  version: string;
  listDevices(flutter: string): Promise<FlutterDevice[]>;
  spawn(cmd: string, args: string[], cwd: string): ChildLike;
  signals: SignalSource;
  /** Registers a synchronous last-chance cleanup for when the process exits (`process.on('exit')`); returns its remover. */
  onExit?(fn: () => void): () => void;
  /** Grace period before a signal is forwarded to flutter, and before it is killed. */
  killGraceMs?: { forward: number; kill: number };
}

export function defaultDeps(version: string): RunDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    log: (m) => process.stderr.write(`[flutter-intercept] ${m}\n`),
    out: (m) => process.stdout.write(`${m}\n`),
    version,
    listDevices: (flutter) => listFlutterDevices(flutter),
    spawn: (cmd, args, cwd) => {
      // REVIEW-7 #11: never a shell; flutter.bat goes through cmd.exe with every argument quoted
      const plan = spawnPlan(cmd, args);
      return nodeSpawn(plan.file, plan.args, { cwd, stdio: 'inherit', windowsVerbatimArguments: plan.windowsVerbatimArguments });
    },
    signals: process,
    onExit: (fn) => {
      process.on('exit', fn);
      return () => process.off('exit', fn);
    },
  };
}

/** `--flutter`, else `$FLUTTER_ROOT/bin/flutter` when it exists, else `flutter` on PATH. */
export function flutterExecutable(o: Pick<CliOptions, 'flutter'>, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string {
  if (o.flutter) return o.flutter;
  const exe = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
  if (env.FLUTTER_ROOT) {
    const p = path.join(env.FLUTTER_ROOT, 'bin', exe);
    if (exists(p)) return p;
  }
  return exe;
}

/** The user's flutter args without our own defines (ours always win), and what was dropped. */
export function stripOwnDefines(args: string[]): { args: string[]; dropped: string[] } {
  const out: string[] = [];
  const dropped: string[] = [];
  const own = (v: string) => v.startsWith(`${PROXY_DEFINE}=`) || v.startsWith(`${ENTRY_SHA_DEFINE}=`);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--dart-define=') && own(a.slice('--dart-define='.length))) {
      dropped.push(a);
      continue;
    }
    if (a === '--dart-define' && i + 1 < args.length && own(args[i + 1])) {
      dropped.push(`${a} ${args[i + 1]}`);
      i++;
      continue;
    }
    out.push(a);
  }
  return { args: out, dropped };
}

export function flutterTestArgs(files: string[], deviceId: string, proxy: string, sha: string, extra: string[]): string[] {
  return ['test', ...files, '-d', deviceId, ...extra, `--dart-define=${PROXY_DEFINE}=${proxy}`, `--dart-define=${ENTRY_SHA_DEFINE}=${sha}`];
}


export function networkProfileFor(id: string): NetworkProfile {
  return id === 'offline' ? { kind: 'offline' } : presetProfile(id as NetworkPresetId);
}

function resolveProject(o: CliOptions, cwd: string): string {
  if (o.project) {
    const root = path.resolve(cwd, o.project);
    if (!hasPubspec(root)) throw new SetupError(`no pubspec.yaml in ${root}`);
    return root;
  }
  const first = o.targets[0] ? path.resolve(cwd, o.targets[0]) : cwd;
  const root = findPubspecRoot(fs.existsSync(first) ? first : cwd);
  if (!root) throw new SetupError('no Flutter project found (no pubspec.yaml in or above the current directory); pass --project');
  return root;
}

export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
const SIGNALS: Record<Signal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

export async function runCli(o: CliOptions, deps: RunDeps): Promise<CliResult> {
  const { log } = deps;
  const projectRoot = resolveProject(o, deps.cwd);
  const pubspec = readPubspec(projectRoot);
  if (!pubspec.isFlutter) throw new SetupError(`${projectRoot} is not a Flutter project (pubspec.yaml has no flutter dependency)`);
  const flutter = flutterExecutable(o, deps.env);
  const redact = !o.noRedact;

  // Everything that can fail fast is checked before the proxy starts and the (slow) build runs.
  const notes: string[] = [];
  let expectations: Expectation[] | undefined;
  try {
    if (o.assert) expectations = readExpectations(path.resolve(deps.cwd, o.assert), notes);
  } catch (e) {
    throw new SetupError((e as Error).message);
  }
  for (const n of notes) log(n);
  let programs: string[];
  try {
    programs = o.command === 'test' ? resolveTestTargets(o.targets, projectRoot, deps.cwd) : resolveRunTargets(o.targets, projectRoot, deps.cwd);
  } catch (e) {
    throw new SetupError((e as Error).message);
  }
  if (o.command === 'test' && !/^\s*integration_test\s*:/m.test(safeRead(path.join(projectRoot, 'pubspec.yaml')))) {
    log('pubspec.yaml has no integration_test dev dependency: flutter test on a device will refuse to run (add `integration_test: {sdk: flutter}` to dev_dependencies)');
  }

  let device: PickedDevice | undefined;
  if (o.device || o.command === 'test') {
    const fast = o.device ? kindFromId(o.device) : undefined;
    let devices: FlutterDevice[] | undefined;
    if (!fast || fast === 'web') {
      try {
        devices = await deps.listDevices(flutter);
      } catch (e) {
        throw new SetupError((e as Error).message);
      }
    }
    try {
      device = o.device && fast && fast !== 'web' ? { id: o.device, kind: fast } : pickDevice(o.device, devices);
    } catch (e) {
      throw new SetupError((e as Error).message);
    }
  }
  const route = device ? proxyRouteFor(device.kind, device.id) : { ok: true as const, host: 'localhost', adbReverse: false };
  if (!route.ok) throw new SetupError(route.reason);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-intercept-run-'));
  fs.chmodSync(tmp, 0o700);
  let proxy: InterceptProxy | undefined;
  let entries: PreparedEntries | undefined;
  const adb = new ReverseTracker({ log });
  let evicted = 0;
  let interrupted: Signal | undefined;
  let reversedOn: string | undefined;
  let child: ChildLike | undefined;
  let stopWaiting: (() => void) | undefined;
  let forwardTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const grace = deps.killGraceMs ?? { forward: 2000, kill: 10_000 };
  const onSignal = (sig: Signal) => {
    if (interrupted) {
      // second Ctrl-C: stop now
      log(`${sig} again: stopping flutter now`);
      child?.kill('SIGKILL');
      stopWaiting?.();
      return;
    }
    interrupted = sig;
    log(`${sig}: stopping${child ? ' flutter, then' : ''} the proxy (press Ctrl-C again to force)`);
    stopWaiting?.();
    if (child && child.exitCode === null) {
      // A terminal Ctrl-C already reached flutter (same process group); CI runners signal only us.
      forwardTimer = setTimeout(() => {
        if (child && child.exitCode === null) child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig);
        killTimer = setTimeout(() => child?.exitCode === null && child.kill('SIGKILL'), grace.kill);
      }, grace.forward);
    }
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  const onHup = () => onSignal('SIGHUP');
  deps.signals.on('SIGINT', onInt);
  deps.signals.on('SIGTERM', onTerm);
  deps.signals.on('SIGHUP', onHup);
  // The process may still end without `finally` (an uncaught error, process.exit elsewhere): best-effort, synchronous.
  const removeExitHook = deps.onExit?.(() => {
    try {
      entries?.cleanup();
    } catch {
      // best effort
    }
    if (reversedOn && proxy) adbRemoveSync(reversedOn, proxy.port);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  let flutterCode: number | undefined;
  let exchanges: Exchange[] = [];
  try {
    const ca = await loadOrCreateCa(tmp);
    proxy = new InterceptProxy({ port: o.port ?? 0, host: '127.0.0.1', ca: { key: ca.key, cert: ca.cert }, maxExchanges: 20_000 });
    proxy.on('removed', (ids: string[]) => (evicted += ids.length));
    try {
      await proxy.start();
    } catch (e) {
      throw new SetupError(`could not start the proxy${o.port ? ` on port ${o.port}` : ''}: ${(e as Error).message}`);
    }
    const port = proxy.port;
    log(`proxy on 127.0.0.1:${port}${device ? `, device ${device.id} (${device.kind}) reaches it at ${route.host}:${port}` : ''}`);

    let loaded;
    try {
      loaded = await loadRules({ rules: o.rules, approve: o.approveSharedRules === true, projectRoot, cwd: deps.cwd, log });
    } catch (e) {
      throw new SetupError((e as Error).message);
    }
    if (loaded.file) log(`rules: ${loaded.rules.length} from ${path.relative(deps.cwd, loaded.file) || loaded.file}`);
    for (const p of loaded.problems) log(`rules: ${p}`);
    for (const s of loaded.skipped) log(`rules: skipped (needs approval; pass --approve-shared-rules to apply): ${s}`);
    for (const s of loaded.approved) log(`rules: applied with --approve-shared-rules: ${s}`);
    if (loaded.rules.length) proxy.setRules(loaded.rules);

    if (o.replay) {
      let replay;
      try {
        replay = await loadReplay(o.replay, projectRoot, deps.cwd, o.replayFallback ?? 'passthrough');
      } catch (e) {
        throw new SetupError((e as Error).message);
      }
      const n = proxy.setReplay(replay.entries, { ...replay.options, name: replay.name });
      log(`replaying "${replay.name}" (${n} responses; unmatched requests: ${replay.options.fallback})`);
    }
    if (o.networkProfile) {
      proxy.setNetworkProfile(networkProfileFor(o.networkProfile));
      log(`network profile: ${o.networkProfile}`);
    }

    if (route.adbReverse && device) {
      const r = await adb.reverse(port, device.id);
      if (!r.reversed.includes(device.id)) {
        const why = r.failed.find((f) => f.serial === device!.id)?.error ?? r.skipped ?? (r.userManaged.length ? `a reverse for tcp:${port} already exists` : 'unknown error');
        throw new SetupError(`adb reverse tcp:${port} on ${device.id} failed: ${why}`);
      }
      reversedOn = device.id;
    }

    entries = await prepareEntries({ programs, projectRoot, proxyPort: port, caCertPem: ca.cert, wrap: o.command === 'test' });
    const proxyAddr = `${route.host}:${port}`;
    const { args: extra, dropped } = stripOwnDefines(o.flutterArgs);
    for (const d of dropped) log(`ignored ${d} (set by flutter-intercept)`);

    if (o.command === 'test') {
      for (const f of entries.files) if (!isIntegrationTestPath(projectRoot, f)) throw new SetupError(`internal: ${f} would not run as an integration test`);
      const args = flutterTestArgs(entries.files.map((f) => path.relative(projectRoot, f)), device!.id, proxyAddr, entries.sha, extra);
      log(displayCommand(path.basename(flutter), args));
      if (!interrupted) {
        flutterCode = await new Promise<number>((resolve, reject) => {
          const c = deps.spawn(flutter, args, projectRoot);
          child = c;
          c.once('error', (e) => reject(new SetupError(`could not run ${flutter}: ${e.message}`)));
          c.once('exit', (code, signal) => resolve(code ?? (signal && signal in SIGNALS ? 128 + SIGNALS[signal as Signal] : 1)));
        });
        child = undefined;
      }
    } else {
      const shown = device ? `-d ${device.id} ` : '';
      deps.out('Run your app through the proxy with:');
      for (const e of entries.plans) {
        const cmd = ['flutter', 'run', '-t', path.relative(deps.cwd, e.entryPath) || e.entryPath, ...(shown ? ['-d', device!.id] : []), ...extra, `--dart-define=${PROXY_DEFINE}=${proxyAddr}`, `--dart-define=${ENTRY_SHA_DEFINE}=${e.sha}`];
        deps.out(`  ${displayCommand(cmd[0], cmd.slice(1))}`);
      }
      if (!device) deps.out(`(Android emulator: ${PROXY_DEFINE}=10.0.2.2:${port}; physical Android: adb reverse tcp:${port} tcp:${port})`);
      deps.out(`--dart-define=${PROXY_DEFINE}=${proxyAddr}`);
      log('waiting; press Ctrl-C to stop and write the results');
      if (!interrupted) await new Promise<void>((resolve) => (stopWaiting = resolve));
    }

    // let the last responses finish recording
    await settle(proxy, 2000);
    exchanges = proxy.getExchanges();
  } finally {
    clearTimeout(forwardTimer);
    clearTimeout(killTimer);
    deps.signals.off('SIGINT', onInt);
    deps.signals.off('SIGTERM', onTerm);
    deps.signals.off('SIGHUP', onHup);
    entries?.cleanup();
    await adb.removeAll().catch(() => undefined);
    reversedOn = undefined;
    await proxy?.stop().catch((e) => log(`proxy stop: ${(e as Error).message}`));
    fs.rmSync(tmp, { recursive: true, force: true });
    removeExitHook?.();
  }

  if (evicted) log(`${evicted} older exchange(s) were dropped from memory during the run; outputs and assertions see the rest`);
  const done = exchanges.filter((e) => FINAL.has(e.state));
  const result: CliResult = { exitCode: 0, exchanges: done.length, assertions: { passed: 0, failed: 0 }, outputs: {} };

  if (o.har) {
    const file = path.resolve(deps.cwd, o.har);
    const n = writeHarFile(file, exchanges, { redact, version: deps.version });
    result.outputs.har = file;
    log(`HAR: ${n} entries → ${file}${redact ? '' : ' (not redacted)'}`);
  }
  if (o.record) {
    try {
      const r = await writeRecording(o.record, exchanges, projectRoot, deps.cwd);
      result.outputs.record = r.path;
      log(`recording: ${r.exchanges} exchanges → ${r.path}${r.id ? ` (replay with --replay ${r.id})` : ''}`);
    } catch (e) {
      log(`recording not saved: ${(e as Error).message}`);
    }
  }
  let results: AssertionResult[] = [];
  if (expectations) {
    results = await evaluateExpectations(expectations, exchanges, { redact });
    result.assertions = { passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length };
    if (o.junit) {
      const file = path.resolve(deps.cwd, o.junit);
      writeOutput(file, toJunitXml(results));
      result.outputs.junit = file;
      log(`JUnit: ${results.length} assertion(s) → ${file}`);
    }
  }

  deps.out('');
  deps.out(trafficTable(done, { urlView: redact ? redactUrl : undefined }));
  const inFlight = exchanges.length - done.length;
  if (inFlight) deps.out(`${inFlight} request(s) were still in flight when the run ended`);
  if (expectations) deps.out(`\n${assertionsTable(results)}`);

  if (interrupted && o.command === 'test') result.exitCode = 128 + SIGNALS[interrupted];
  else if (flutterCode !== undefined && flutterCode !== 0) result.exitCode = flutterCode;
  else if (result.assertions.failed) result.exitCode = 1;
  deps.out(`\n${o.command === 'test' ? `flutter test exit code ${flutterCode ?? '-'}; ` : ''}flutter-intercept exit code ${result.exitCode}`);
  return result;
}

/** `adb -s <serial> reverse --remove tcp:<port>`, synchronously (exit hook). Never throws. */
function adbRemoveSync(serial: string, port: number): void {
  try {
    const adb = locateAdb();
    if (adb) execFileSync(adb, ['-s', serial, 'reverse', '--remove', `tcp:${port}`], { timeout: 3000, stdio: 'ignore' });
  } catch {
    // best effort
  }
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Waits until no exchange is pending (or `maxMs`). */
async function settle(proxy: InterceptProxy, maxMs: number): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until && proxy.getExchanges().some((e) => !FINAL.has(e.state))) await new Promise((r) => setTimeout(r, 100));
}
