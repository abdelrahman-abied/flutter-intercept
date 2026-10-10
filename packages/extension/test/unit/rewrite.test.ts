import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockttpCaGenerator, spkiPin } from '../../src/ca';
import {
  DebugConfig,
  HOST_KEY,
  isBrowserProxyFlag,
  isUserProfileFlag,
  LAN_KEY,
  MARKER_KEY,
  ORIGINAL_PROGRAM_KEY,
  proxyHostFor,
  rewriteDebugConfig,
  RewriteContext,
  selectDebuggerType,
  stripDefines,
  stripShaDefine,
  stripWebFlags,
  TRACE_DEFINE,
  WEB_FLAGS_KEY,
  WEB_KEY,
  isOurPacUrl,
  webBrowserDebugPortOf,
  webBrowserFlags,
  webDebugPortArg,
  webInterceptFlags,
  withInterceptDefines,
  withShaDefine,
} from '../../src/debug/rewrite';

// Only shape-checked by the generator (embedded in a Dart raw string); real CAs are tested in ca/generator tests.
const FAKE_CA = '-----BEGIN CERTIFICATE-----\nTUlJQ0FBQUE=\n-----END CERTIFICATE-----\n';

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

let ws: string;
let flutterApp: string;
let dartCli: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-rw-'));
  flutterApp = path.join(ws, 'flutter_app');
  dartCli = path.join(ws, 'dart_cli');
  write(path.join(flutterApp, 'pubspec.yaml'), 'name: flutter_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(flutterApp, 'lib', 'main.dart'), 'void main() {}');
  write(path.join(flutterApp, 'lib', 'main_dev.dart'), 'Future<void> main() async {}');
  write(path.join(flutterApp, 'test', 'widget_test.dart'), 'void main() {}');
  write(path.join(flutterApp, 'integration_test', 'app_test.dart'), 'void main() {}');
  write(path.join(flutterApp, 'bin', 'tool.dart'), 'void main() {}');
  write(path.join(dartCli, 'pubspec.yaml'), 'name: dart_cli\n');
  write(path.join(dartCli, 'bin', 'main.dart'), 'void main(List<String> args) {}');
  write(path.join(dartCli, 'web', 'main.dart'), 'void main() {}');
});
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

const ctx = (over: Partial<RewriteContext> = {}): RewriteContext => ({
  enabled: true,
  caCertPem: FAKE_CA,
  proxyPort: 9555,
  folder: flutterApp,
  workspaceFolders: [flutterApp],
  ...over,
});

const entry = (root: string, base: string) => path.join(root, '.dart_tool', 'flutter_intercept', `entry_${base}.dart`);

describe('rewriteDebugConfig: "after" Dart-Code (normal F5 ordering)', () => {
  const resolved = (over: DebugConfig = {}): DebugConfig => ({
    type: 'dart',
    request: 'launch',
    program: path.join(flutterApp, 'lib', 'main.dart'),
    cwd: flutterApp,
    debuggerType: 2,
    toolEnv: {},
    deviceId: 'emulator-5554',
    ...over,
  });

  it('swaps only the program and records the original', () => {
    const r = rewriteDebugConfig(resolved(), ctx());
    expect(r.kind).toBe('rewrite');
    if (r.kind !== 'rewrite') return;
    expect(r.mode).toBe('after');
    expect(r.config.program).toBe(entry(flutterApp, 'lib__main'));
    expect(r.config.flutterInterceptOriginalProgram).toBe(path.join(flutterApp, 'lib', 'main.dart'));
    expect(r.config.debuggerType).toBe(2);
    expect(r.config.deviceId).toBe('emulator-5554');
    expect(r.plan.content).toContain("import 'package:flutter_app/main.dart' as target;");
    expect(r.debuggerType).toBe('Flutter');
  });

  it('skips test debugger types and web devices', () => {
    expect(rewriteDebugConfig(resolved({ debuggerType: 3 }), ctx())).toMatchObject({ kind: 'skip' });
    expect(rewriteDebugConfig(resolved({ deviceId: 'chrome' }), ctx())).toMatchObject({ kind: 'skip' });
    expect(rewriteDebugConfig(resolved({ deviceId: 'web-server' }), ctx())).toMatchObject({ kind: 'skip' });
    expect(rewriteDebugConfig(resolved({ deviceId: 'edge' }), ctx())).toMatchObject({ kind: 'skip' });
  });
});

describe('rewriteDebugConfig: "before" Dart-Code (provider order reversed)', () => {
  it('resolves a relative program and pins debuggerType=Flutter', () => {
    const r = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/main_dev.dart' }, ctx());
    expect(r).toMatchObject({ kind: 'rewrite', mode: 'before' });
    if (r.kind !== 'rewrite') return;
    expect(r.config.program).toBe(entry(flutterApp, 'lib__main_dev'));
    expect(r.config.debuggerType).toBe('Flutter');
    expect(r.config.cwd).toBe(flutterApp);
  });

  it('defaults to lib/main.dart when no program is given', () => {
    const r = rewriteDebugConfig({ type: 'dart', request: 'launch' }, ctx());
    expect(r).toMatchObject({ kind: 'rewrite' });
    if (r.kind === 'rewrite') expect(r.config.flutterInterceptOriginalProgram).toBe(path.join(flutterApp, 'lib', 'main.dart'));
  });

  it('defaults to bin/main.dart for a Dart CLI and pins debuggerType=Dart', () => {
    const r = rewriteDebugConfig({ type: 'dart', request: 'launch', cwd: dartCli }, ctx({ folder: undefined, workspaceFolders: [ws] }));
    expect(r).toMatchObject({ kind: 'rewrite' });
    if (r.kind !== 'rewrite') return;
    expect(r.config.program).toBe(entry(dartCli, 'bin__main'));
    expect(r.config.debuggerType).toBe('Dart');
    expect(r.debuggerType).toBe('Dart'); // host VM: no adb reverse
    expect(r.plan.targetImport).toBe('../../bin/main.dart');
  });

  it('prefers an open entry-point file like Dart-Code', () => {
    const r = rewriteDebugConfig({ type: 'dart', request: 'launch' }, ctx({ activeFile: path.join(flutterApp, 'bin', 'tool.dart') }));
    expect(r).toMatchObject({ kind: 'rewrite' });
    if (r.kind === 'rewrite') {
      expect(r.config.flutterInterceptOriginalProgram).toBe(path.join(flutterApp, 'bin', 'tool.dart'));
      expect(r.config.debuggerType).toBe('Dart'); // bin/ in a Flutter project runs on the Dart VM
    }
  });

  it('keeps a user-specified debuggerType', () => {
    const r = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/main.dart', debuggerType: 'flutter' }, ctx());
    expect(r).toMatchObject({ kind: 'rewrite' });
    if (r.kind === 'rewrite') expect(r.config.debuggerType).toBe('flutter');
  });
});

describe('rewriteDebugConfig: idempotency', () => {
  it('does not double-wrap, regenerates with the new port', () => {
    const first = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/main.dart' }, ctx());
    if (first.kind !== 'rewrite') throw new Error('expected rewrite');
    const second = rewriteDebugConfig(first.config, ctx({ proxyPort: 9777 }));
    expect(second).toMatchObject({ kind: 'rewrite', mode: 'already' });
    if (second.kind !== 'rewrite') return;
    expect(second.config.program).toBe(first.config.program);
    expect(second.config.flutterInterceptOriginalProgram).toBe(path.join(flutterApp, 'lib', 'main.dart'));
    expect(second.plan.content).toContain("defaultValue: 'localhost:9777'");
    expect(second.config.toolArgs).toContain('--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:9777');
    // And Dart-Code resolving the already-rewritten config afterwards changes nothing for us.
    const third = rewriteDebugConfig({ ...second.config, debuggerType: 2, toolEnv: {} }, ctx());
    expect(third).toMatchObject({ kind: 'rewrite', mode: 'already' });
  });

  it('restores the original program when interception no longer applies', () => {
    const first = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/main.dart' }, ctx());
    if (first.kind !== 'rewrite') throw new Error('expected rewrite');
    const off = rewriteDebugConfig(first.config, ctx({ enabled: false }));
    expect(off.kind).toBe('restore');
    if (off.kind !== 'restore') return;
    expect(off.config.program).toBe(path.join(flutterApp, 'lib', 'main.dart'));
    expect(off.config.flutterInterceptOriginalProgram).toBeUndefined();
  });

  it('skips a generated entry whose original is unknown', () => {
    expect(rewriteDebugConfig({ type: 'dart', request: 'launch', program: entry(flutterApp, 'lib__main') }, ctx())).toMatchObject({ kind: 'skip' });
  });
});

describe('rewriteDebugConfig: no-op cases', () => {
  it.each<[string, DebugConfig, Partial<RewriteContext>?]>([
    ['disabled', { type: 'dart', request: 'launch', program: 'lib/main.dart' }, { enabled: false }],
    ['attach', { type: 'dart', request: 'attach' }],
    ['other type', { type: 'node', request: 'launch', program: 'lib/main.dart' }],
    ['test file', { type: 'dart', request: 'launch', program: 'test/widget_test.dart' }],
    ['test folder', { type: 'dart', request: 'launch', program: 'test' }],
    ['integration test', { type: 'dart', request: 'launch', program: 'integration_test/app_test.dart' }],
    ['test query', { type: 'dart', request: 'launch', program: 'lib/main.dart?line=3' }],
    ['test name filter', { type: 'dart', request: 'launch', program: 'lib/main.dart', args: ['--name', 'x'] }],
    ['web device', { type: 'dart', request: 'launch', program: 'lib/main.dart', deviceId: 'chrome' }],
    ['missing program', { type: 'dart', request: 'launch', program: 'lib/nope.dart' }],
    ['omitTargetFlag', { type: 'dart', request: 'launch', program: 'lib/main.dart', omitTargetFlag: true }],
    ['dart web', { type: 'dart', request: 'launch', program: path.join(ws ?? '', 'dart_cli', 'web', 'main.dart') }],
  ])('%s', (_name, config, over) => {
    // `ws` is only known after beforeAll; rebuild the dart-web path lazily.
    const c = { ...config };
    if (_name === 'dart web') c.program = path.join(dartCli, 'web', 'main.dart');
    expect(rewriteDebugConfig(c, ctx(over ?? {}))).toMatchObject({ kind: 'skip' });
  });
});

describe('release builds are never intercepted', () => {
  const after = (over: DebugConfig): DebugConfig => ({
    type: 'dart',
    request: 'launch',
    program: path.join(flutterApp, 'lib', 'main.dart'),
    cwd: flutterApp,
    debuggerType: 2,
    toolEnv: {},
    deviceId: 'emulator-5554',
    ...over,
  });
  it.each<[string, () => DebugConfig, Partial<RewriteContext>?]>([
    ['flutterMode release (after Dart-Code)', () => after({ flutterMode: 'release', toolArgs: ['-d', 'emulator-5554', '--release'] })],
    ['flutterMode Release, before Dart-Code', () => ({ type: 'dart', request: 'launch', program: 'lib/main.dart', flutterMode: 'Release' })],
    ['--release in toolArgs', () => ({ type: 'dart', request: 'launch', program: 'lib/main.dart', toolArgs: ['--release'] })],
    ['--release from dart.flutterRunAdditionalArgs', () => ({ type: 'dart', request: 'launch', program: 'lib/main.dart' }), { settingsToolArgs: ['--release'] }],
  ])('%s', (_n, config, over) => {
    const r = rewriteDebugConfig(config(), ctx(over ?? {}));
    expect(r).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/release/) });
  });

  it('restores the original program if a release relaunch carries our entry', () => {
    const first = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/main.dart' }, ctx());
    if (first.kind !== 'rewrite') throw new Error(first.kind);
    const rel = rewriteDebugConfig({ ...first.config, flutterMode: 'release' }, ctx());
    expect(rel.kind).toBe('restore');
    if (rel.kind === 'restore') expect(rel.config.program).toBe(path.join(flutterApp, 'lib', 'main.dart'));
  });

  it('profile and debug stay intercepted', () => {
    for (const flutterMode of ['profile', 'debug', undefined]) {
      expect(rewriteDebugConfig(after({ flutterMode }), ctx()).kind).toBe('rewrite');
    }
  });
});

describe('selectDebuggerType mirrors Dart-Code', () => {
  it('classifies', () => {
    expect(selectDebuggerType('/p/lib/main.dart', '/p', true)).toBe('Flutter');
    expect(selectDebuggerType('/p/bin/x.dart', '/p', true)).toBe('Dart');
    expect(selectDebuggerType('/p/web/main.dart', '/p', false)).toBe('Web');
    expect(selectDebuggerType('/p/lib/main.dart', '/p', false)).toBe('Dart');
  });
});

describe('device-dependent proxy host (CONTRACTS §2) and entry SHA define (§1)', () => {
  const flutterResolved = (deviceId: string | undefined, over: DebugConfig = {}): DebugConfig => ({
    type: 'dart',
    request: 'launch',
    program: path.join(flutterApp, 'lib', 'main.dart'),
    cwd: flutterApp,
    debuggerType: 2,
    toolEnv: {},
    toolArgs: ['-d', deviceId ?? 'x'],
    ...(deviceId ? { deviceId } : {}),
    ...over,
  });
  const shaArgs = (args: unknown) => (args as string[]).filter((a) => a.includes('FLUTTER_INTERCEPT_ENTRY_SHA'));

  it('emulator -> 10.0.2.2, no adb reverse', () => {
    const r = rewriteDebugConfig(flutterResolved('emulator-5554'), ctx());
    if (r.kind !== 'rewrite') throw new Error(r.kind);
    expect(r.proxyHost).toBe('10.0.2.2');
    expect(r.needsAdbReverse).toBe(false);
    expect(r.config.toolArgs).toContain('--dart-define=FLUTTER_INTERCEPT_PROXY=10.0.2.2:9555');
    expect(r.plan.content).not.toContain('10.0.2.2'); // the entry itself is device independent
    expect(r.config.flutterInterceptProxyHost).toBe('10.0.2.2');
  });

  it('physical Android / iOS simulator / macOS -> localhost (+ reverse request for Android to filter)', () => {
    for (const id of ['R58M123ABC', '5A3F2C1E-7B4D-4E8A-9C6B-1D2E3F4A5B6C', 'macos']) {
      const r = rewriteDebugConfig(flutterResolved(id), ctx());
      if (r.kind !== 'rewrite') throw new Error(r.kind);
      expect(r.proxyHost).toBe('localhost');
      expect(r.needsAdbReverse).toBe(true); // adbReverse ignores ids adb does not list
      expect(r.deviceId).toBe(id);
    }
  });

  it('before Dart-Code: uses the selected device, else localhost', () => {
    const sel = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/main.dart' }, ctx({ selectedDeviceId: 'emulator-5556' }));
    if (sel.kind !== 'rewrite') throw new Error(sel.kind);
    expect(sel.proxyHost).toBe('10.0.2.2');
    const none = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/main.dart' }, ctx());
    if (none.kind !== 'rewrite') throw new Error(none.kind);
    expect(none.proxyHost).toBe('localhost');
    expect(none.deviceId).toBeUndefined();
    expect(none.needsAdbReverse).toBe(true);
  });

  it('appends exactly one FLUTTER_INTERCEPT_ENTRY_SHA define and replaces stale ones', () => {
    const r = rewriteDebugConfig(flutterResolved('emulator-5554', { toolArgs: ['--dart-define', 'FLUTTER_INTERCEPT_ENTRY_SHA=old', '--dart-define=FOO=1'] }), ctx());
    if (r.kind !== 'rewrite') throw new Error(r.kind);
    expect(shaArgs(r.config.toolArgs)).toEqual([`--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=${r.plan.sha}`]);
    expect(r.config.toolArgs).toContain('--dart-define=FOO=1');
    const again = rewriteDebugConfig(r.config, ctx({ proxyPort: 9600 }));
    if (again.kind !== 'rewrite') throw new Error(again.kind);
    expect(again.plan.sha).not.toBe(r.plan.sha); // content changed (port) -> new hash
    expect(shaArgs(again.config.toolArgs)).toEqual([`--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=${again.plan.sha}`]);
  });

  it('no define for plain Dart programs (the VM rejects --dart-define)', () => {
    const r = rewriteDebugConfig({ type: 'dart', request: 'launch', cwd: dartCli }, ctx({ folder: undefined, workspaceFolders: [ws] }));
    if (r.kind !== 'rewrite') throw new Error(r.kind);
    expect(r.config.toolArgs).toBeUndefined();
    expect(r.proxyHost).toBe('localhost');
    expect(r.needsAdbReverse).toBe(false);
  });

  it('restore strips the define', () => {
    const r = rewriteDebugConfig(flutterResolved('emulator-5554'), ctx());
    if (r.kind !== 'rewrite') throw new Error(r.kind);
    const off = rewriteDebugConfig(r.config, ctx({ enabled: false }));
    if (off.kind !== 'restore') throw new Error(off.kind);
    expect(shaArgs(off.config.toolArgs)).toEqual([]);
    expect((off.config.toolArgs as string[]).some((a) => a.includes('FLUTTER_INTERCEPT_PROXY'))).toBe(false);
    expect(off.config.flutterInterceptProxyHost).toBeUndefined();
  });

  it('helpers', () => {
    expect(proxyHostFor('emulator-5554')).toBe('10.0.2.2');
    expect(proxyHostFor(undefined)).toBe('localhost');
    expect(proxyHostFor('emulator-5554', '192.168.1.5')).toBe('192.168.1.5');
    expect(stripShaDefine(['a', '--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=1', '--dart-define', 'FLUTTER_INTERCEPT_ENTRY_SHA=2', 'b'])).toEqual(['a', 'b']);
    expect(withShaDefine(undefined, 'abc')).toEqual(['--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=abc']);
    expect(stripDefines(['--dart-define', 'FLUTTER_INTERCEPT_PROXY=a:1', '--dart-define=FLUTTER_INTERCEPT_PROXY_X=keep', 'x'])).toEqual([
      '--dart-define=FLUTTER_INTERCEPT_PROXY_X=keep',
      'x',
    ]);
    expect(withInterceptDefines(['--dart-define=FLUTTER_INTERCEPT_PROXY=old:1'], 'abc', '10.0.2.2:8899')).toEqual([
      '--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=abc',
      '--dart-define=FLUTTER_INTERCEPT_PROXY=10.0.2.2:8899',
    ]);
  });
});

describe('device-independent entry content (REVIEW-1 #2)', () => {
  it('an emulator session and a simulator session produce the same entry file and bytes', () => {
    const base: DebugConfig = { type: 'dart', request: 'launch', program: path.join(flutterApp, 'lib', 'main.dart'), cwd: flutterApp, debuggerType: 2, toolEnv: {} };
    const emu = rewriteDebugConfig({ ...base, deviceId: 'emulator-5554' }, ctx());
    const sim = rewriteDebugConfig({ ...base, deviceId: '5A3F2C1E-7B4D-4E8A-9C6B-1D2E3F4A5B6C' }, ctx());
    if (emu.kind !== 'rewrite' || sim.kind !== 'rewrite') throw new Error('expected rewrites');
    expect(emu.plan.entryPath).toBe(sim.plan.entryPath);
    expect(emu.plan.content).toBe(sim.plan.content);
    expect(emu.config.toolArgs).toContain('--dart-define=FLUTTER_INTERCEPT_PROXY=10.0.2.2:9555');
    expect(sim.config.toolArgs).toContain('--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:9555');
  });

  it('flavor targets with the same basename get different entries', () => {
    write(path.join(flutterApp, 'lib', 'flavors', 'dev', 'main.dart'), 'void main() {}');
    write(path.join(flutterApp, 'lib', 'flavors', 'prod', 'main.dart'), 'void main() {}');
    const dev = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/flavors/dev/main.dart' }, ctx());
    const prod = rewriteDebugConfig({ type: 'dart', request: 'launch', program: 'lib/flavors/prod/main.dart' }, ctx());
    if (dev.kind !== 'rewrite' || prod.kind !== 'rewrite') throw new Error('expected rewrites');
    expect(dev.config.program).toBe(entry(flutterApp, 'lib__flavors__dev__main'));
    expect(prod.config.program).toBe(entry(flutterApp, 'lib__flavors__prod__main'));
  });
});

describe('captureSource (CONTRACTS §9.1)', () => {
  it('adds FLUTTER_INTERCEPT_TRACE=0 only when source capture is off', () => {
    expect(withInterceptDefines([], 'abc', 'localhost:1')).not.toContain(`--dart-define=${TRACE_DEFINE}=0`);
    expect(withInterceptDefines([], 'abc', 'localhost:1', false)).toContain(`--dart-define=${TRACE_DEFINE}=0`);
  });

  it('strips an earlier trace define', () => {
    const args = withInterceptDefines([`--dart-define=${TRACE_DEFINE}=0`, '--verbose'], 'abc', 'localhost:1');
    expect(args).toEqual(['--verbose', '--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=abc', '--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:1']);
  });
});

describe('Flutter Web (CONTRACTS §11.3): browser flags, program untouched', () => {
  let caPem: string;
  let pin: string;
  beforeAll(async () => {
    caPem = (await mockttpCaGenerator('web-test')).cert;
    pin = spkiPin(caPem);
  }, 60_000);
  const main = () => path.join(flutterApp, 'lib', 'main.dart');
  const webCtx = (over: Partial<RewriteContext> = {}) => ctx({ caCertPem: caPem, webEnabled: true, ...over });
  const resolved = (over: DebugConfig = {}): DebugConfig => ({
    type: 'dart',
    request: 'launch',
    program: main(),
    cwd: flutterApp,
    debuggerType: 2,
    toolEnv: {},
    deviceId: 'chrome',
    toolArgs: ['--dart-define=A=1'],
    ...over,
  });
  const flags = () => [
    '--web-browser-flag=--proxy-server=http://127.0.0.1:9555',
    `--web-browser-flag=--ignore-certificate-errors-spki-list=${pin}`,
  ];

  it('chrome: adds the proxy + CA SPKI flags, keeps program, records host/port', () => {
    const r = rewriteDebugConfig(resolved(), webCtx());
    expect(r.kind).toBe('web');
    if (r.kind !== 'web') return;
    expect(r.mode).toBe('after');
    expect(r.deviceId).toBe('chrome');
    expect(r.config.program).toBe(main());
    expect(r.config.toolArgs).toEqual(['--dart-define=A=1', ...flags()]);
    expect(r.flags).toEqual(flags());
    expect(r.config[WEB_FLAGS_KEY]).toEqual(flags());
    expect(r.config[WEB_KEY]).toBe(true);
    expect(r.config[HOST_KEY]).toBe('127.0.0.1');
    expect(r.config[MARKER_KEY]).toBe(9555);
    expect(r.config[ORIGINAL_PROGRAM_KEY]).toBe(main());
    expect(r.config.debuggerType).toBe(2);
    // flutter_tools splits --web-browser-flag values on commas.
    for (const f of r.flags) expect(f).not.toContain(',');
  });

  it('v0.8.0 PAC URL (DIRECT fallback) + browser debug port: comma-free, recorded, replaced on re-resolve', () => {
    const pacUrl = 'http://127.0.0.1:41234/flutter-intercept-9555.pac';
    const r = rewriteDebugConfig(resolved(), webCtx({ webPacUrl: pacUrl, webDebugPort: 41235 }));
    if (r.kind !== 'web') throw new Error(r.kind);
    const want = [`--web-browser-flag=--proxy-pac-url=${pacUrl}`, flags()[1], '--web-browser-debug-port=41235'];
    expect(r.flags).toEqual(want);
    expect(r.config.toolArgs).toEqual(['--dart-define=A=1', ...want]);
    for (const f of r.flags) expect(f).not.toContain(',');
    expect(webBrowserDebugPortOf(r.config)).toBe(41235);
    // Re-resolve with a new PAC server / debug port: only ours are replaced.
    const again = rewriteDebugConfig({ ...r.config }, webCtx({ webPacUrl: 'http://127.0.0.1:5/flutter-intercept-9555.pac', webDebugPort: 6 }));
    if (again.kind !== 'web') throw new Error(again.kind);
    expect(again.config.toolArgs).toEqual(['--dart-define=A=1', '--web-browser-flag=--proxy-pac-url=http://127.0.0.1:5/flutter-intercept-9555.pac', flags()[1], '--web-browser-debug-port=6']);
    // Off: everything of ours goes, including the debug port.
    const off = rewriteDebugConfig({ ...r.config }, webCtx({ webEnabled: false }));
    expect(off.kind).toBe('restore');
    if (off.kind === 'restore') expect(off.config.toolArgs).toEqual(['--dart-define=A=1']);
  });

  it('a PAC URL that is not our loopback one is ignored (falls back to --proxy-server)', () => {
    for (const bad of ['http://10.0.0.2:1/x.pac', 'data:application/x-ns-proxy-autoconfig,x', 'http://127.0.0.1:1/a,b.pac', 'file:///tmp/x.pac']) {
      expect(isOurPacUrl(bad)).toBe(false);
      const r = rewriteDebugConfig(resolved(), webCtx({ webPacUrl: bad }));
      if (r.kind !== 'web') throw new Error(r.kind);
      expect(r.flags).toEqual(flags());
    }
    expect(() => webInterceptFlags(9555, pin, { pacUrl: 'http://evil:1/x.pac' })).toThrow(/PAC/);
    expect(() => webInterceptFlags(9555, pin, { debugPort: 70000 })).toThrow(/debug port/);
  });

  it("the user's own --web-browser-debug-port (toolArgs or settings) wins; parsing", () => {
    const r = rewriteDebugConfig(resolved({ toolArgs: ['--web-browser-debug-port=9222'] }), webCtx({ webDebugPort: 41235 }));
    if (r.kind !== 'web') throw new Error(r.kind);
    expect(r.flags).toEqual(flags());
    expect(webBrowserDebugPortOf(r.config)).toBe(9222);
    const s = rewriteDebugConfig(resolved(), webCtx({ webDebugPort: 41235, settingsToolArgs: ['--web-browser-debug-port', '9223'] }));
    if (s.kind !== 'web') throw new Error(s.kind);
    expect(s.flags).toEqual(flags());
    expect(webDebugPortArg(['--web-browser-debug-port', '1', '--web-browser-debug-port=2'])).toBe(2);
    expect(webDebugPortArg(['--web-browser-debug-port=0', '--web-browser-debug-port=x', '--web-browser-debug-port'])).toBeUndefined();
    expect(webBrowserDebugPortOf({ deviceId: 'emulator-5554', toolArgs: ['--web-browser-debug-port=3'] })).toBeUndefined();
    expect(webBrowserDebugPortOf({ deviceId: 'edge', toolArgs: ['--web-browser-debug-port=3'] })).toBe(3);
    expect(webBrowserDebugPortOf(undefined)).toBeUndefined();
  });

  it('edge works the same way', () => {
    expect(rewriteDebugConfig(resolved({ deviceId: 'edge' }), webCtx())).toMatchObject({ kind: 'web', deviceId: 'edge' });
  });

  it('is idempotent and follows a port change / new CA on re-resolve', () => {
    const first = rewriteDebugConfig(resolved(), webCtx());
    if (first.kind !== 'web') throw new Error(first.kind);
    const again = rewriteDebugConfig({ ...first.config }, webCtx());
    if (again.kind !== 'web') throw new Error(again.kind);
    expect(again.config.toolArgs).toEqual(['--dart-define=A=1', ...flags()]);
    const moved = rewriteDebugConfig({ ...first.config }, webCtx({ proxyPort: 9600 }));
    if (moved.kind !== 'web') throw new Error(moved.kind);
    expect(moved.config.toolArgs).toEqual(['--dart-define=A=1', '--web-browser-flag=--proxy-server=http://127.0.0.1:9600', flags()[1]]);
    expect(moved.config[MARKER_KEY]).toBe(9600);
  });

  it('removes the flags and our keys when interception is off (re-resolve / rerun)', () => {
    const first = rewriteDebugConfig(resolved(), webCtx());
    if (first.kind !== 'web') throw new Error(first.kind);
    for (const over of [{ enabled: false }, { webEnabled: false }]) {
      const r = rewriteDebugConfig({ ...first.config }, webCtx(over));
      expect(r.kind).toBe('restore');
      if (r.kind !== 'restore') return;
      expect(r.config.toolArgs).toEqual(['--dart-define=A=1']);
      expect(r.config.program).toBe(main());
      for (const k of [ORIGINAL_PROGRAM_KEY, MARKER_KEY, HOST_KEY, WEB_KEY, WEB_FLAGS_KEY]) expect(r.config).not.toHaveProperty(k);
    }
  });

  it('removes only the exact flags we added (two-token form too), never the user\'s', () => {
    const ours = flags();
    const args = ['--web-browser-flag', ours[0].slice('--web-browser-flag='.length), '--web-browser-flag=--disable-gpu', ours[1], '-v'];
    expect(stripWebFlags(args, ours)).toEqual(['--web-browser-flag=--disable-gpu', '-v']);
    expect(stripWebFlags(args, undefined)).toEqual(args);
    expect(webBrowserFlags(['--web-browser-flag', '--a', '--web-browser-flag=--b', '--c'])).toEqual(['--a', '--b']);
  });

  it('a mobile rerun on Chrome: original program back, entry defines removed', () => {
    const mobile = rewriteDebugConfig(resolved({ deviceId: 'emulator-5554' }), webCtx());
    if (mobile.kind !== 'rewrite') throw new Error(mobile.kind);
    const r = rewriteDebugConfig({ ...mobile.config, deviceId: 'chrome' }, webCtx());
    expect(r.kind).toBe('web');
    if (r.kind !== 'web') return;
    expect(r.mode).toBe('already');
    expect(r.config.program).toBe(main());
    expect(r.config.toolArgs).toEqual(['--dart-define=A=1', ...flags()]);
    // ...and back to the emulator: the browser flags go, the entry comes back.
    const back = rewriteDebugConfig({ ...r.config, deviceId: 'emulator-5554' }, webCtx());
    if (back.kind !== 'rewrite') throw new Error(back.kind);
    expect(back.config.program).toBe(entry(flutterApp, 'lib__main'));
    expect(webBrowserFlags(back.config.toolArgs)).toEqual([]);
    expect(back.config).not.toHaveProperty(WEB_KEY);
    expect(back.config).not.toHaveProperty(WEB_FLAGS_KEY);
  });

  it('a LAN marker from an earlier iPhone session does not survive', () => {
    const r = rewriteDebugConfig(resolved({ [LAN_KEY]: true }), webCtx());
    expect(r.kind).toBe('web');
    if (r.kind === 'web') expect(r.config).not.toHaveProperty(LAN_KEY);
  });

  it('before Dart-Code: the selected device decides; program is left for Dart-Code', () => {
    const r = rewriteDebugConfig({ type: 'dart', request: 'launch', name: 'x' }, webCtx({ selectedDeviceId: 'chrome' }));
    expect(r.kind).toBe('web');
    if (r.kind !== 'web') return;
    expect(r.mode).toBe('before');
    expect(r.config.program).toBeUndefined();
    expect(r.config.debuggerType).toBeUndefined();
    expect(r.config[ORIGINAL_PROGRAM_KEY]).toBe(main());
    expect(r.config.toolArgs).toEqual(flags());
  });

  it('first pass without the CA asks for it (needsCa) instead of launching unpinned', () => {
    expect(rewriteDebugConfig(resolved(), webCtx({ caCertPem: '' }))).toMatchObject({ kind: 'skip', needsCa: true });
    expect(rewriteDebugConfig(resolved(), webCtx({ caCertPem: FAKE_CA }))).toMatchObject({ kind: 'skip' });
  });

  it('web-server (and unknown web* devices): skipped with a one-time notice reason', () => {
    for (const deviceId of ['web-server', 'web-javascript']) {
      const r = rewriteDebugConfig(resolved({ deviceId }), webCtx());
      expect(r).toMatchObject({ kind: 'skip', webServer: true });
      if (r.kind === 'skip') expect(r.reason).toMatch(/Flutter does not start the browser/);
    }
  });

  it('the user\'s own browser proxy wins (toolArgs or Dart-Code settings)', () => {
    for (const own of ['--proxy-server=http://127.0.0.1:8888', '--proxy-pac-url=http://x/p.pac', '--no-proxy-server']) {
      expect(rewriteDebugConfig(resolved({ toolArgs: [`--web-browser-flag=${own}`] }), webCtx())).toMatchObject({ kind: 'skip' });
      expect(rewriteDebugConfig(resolved({ toolArgs: ['--web-browser-flag', own] }), webCtx())).toMatchObject({ kind: 'skip' });
    }
    expect(rewriteDebugConfig(resolved(), webCtx({ settingsToolArgs: ['--web-browser-flag=--proxy-server=socks5://h:1'] }))).toMatchObject({ kind: 'skip' });
    expect(isBrowserProxyFlag('--proxy-bypass-list=x')).toBe(false);
  });

  it('REVIEW-5 #10: the user\'s own --user-data-dir (toolArgs or Dart-Code settings) is never intercepted', () => {
    for (const toolArgs of [
      ['--web-browser-flag=--user-data-dir=/Users/me/chrome-dev'],
      ['--web-browser-flag', '--user-data-dir=/Users/me/chrome-dev'],
      ['--web-browser-flag=--user-data-dir'],
    ]) {
      const r = rewriteDebugConfig(resolved({ toolArgs }), webCtx());
      expect(r).toMatchObject({ kind: 'skip', webUserProfile: true });
      if (r.kind === 'skip') expect(r.reason).toMatch(/your own profile.*--user-data-dir/);
    }
    expect(rewriteDebugConfig(resolved(), webCtx({ settingsToolArgs: ['--web-browser-flag=--user-data-dir=/p'] }))).toMatchObject({ kind: 'skip', webUserProfile: true });
    // Re-resolve of an intercepted config after the user added it: our flags and keys go, theirs stay.
    const first = rewriteDebugConfig(resolved(), webCtx());
    if (first.kind !== 'web') throw new Error(first.kind);
    const r = rewriteDebugConfig({ ...first.config, toolArgs: [...first.config.toolArgs, '--web-browser-flag=--user-data-dir=/p'] }, webCtx());
    expect(r.kind).toBe('restore');
    if (r.kind === 'restore') {
      expect(r.config.toolArgs).toEqual(['--dart-define=A=1', '--web-browser-flag=--user-data-dir=/p']);
      expect(r.config).not.toHaveProperty(WEB_FLAGS_KEY);
    }
  });

  it('--profile-directory alone stays inside flutter\'s temp user-data-dir: intercepted', () => {
    expect(isUserProfileFlag('--profile-directory=Default')).toBe(false);
    expect(isUserProfileFlag('--user-data-dir=/x')).toBe(true);
    expect(rewriteDebugConfig(resolved({ toolArgs: ['--web-browser-flag=--profile-directory=Profile 1'] }), webCtx())).toMatchObject({ kind: 'web' });
  });

  it('release, tests and disabled web stay untouched', () => {
    expect(rewriteDebugConfig(resolved({ flutterMode: 'release' }), webCtx())).toMatchObject({ kind: 'skip' });
    expect(rewriteDebugConfig(resolved({ debuggerType: 3 }), webCtx())).toMatchObject({ kind: 'skip' });
    expect(rewriteDebugConfig(resolved({ program: path.join(flutterApp, 'test', 'widget_test.dart') }), webCtx())).toMatchObject({ kind: 'skip' });
    expect(rewriteDebugConfig(resolved(), webCtx({ webEnabled: false }))).toMatchObject({ kind: 'skip', reason: 'flutterIntercept.web.enabled is false' });
    expect(rewriteDebugConfig(resolved({ flutterMode: 'profile' }), webCtx())).toMatchObject({ kind: 'web' });
  });

  it('webInterceptFlags validates its inputs', () => {
    expect(webInterceptFlags(9555, pin)).toEqual(flags());
    expect(() => webInterceptFlags(0, pin)).toThrow();
    expect(() => webInterceptFlags(9555, 'a,b')).toThrow();
  });
});
