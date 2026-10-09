import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DebugConfig,
  proxyHostFor,
  rewriteDebugConfig,
  RewriteContext,
  selectDebuggerType,
  stripDefines,
  stripShaDefine,
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
