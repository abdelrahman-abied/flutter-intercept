import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_SESSION_NAME, createAppLauncher, LauncherVscode } from '../../src/agent/launch';
import { AgentToolError } from '../../src/agent/types';

let ws: string;
let flutterApp: string;
let dartCli: string;
let empty: string;
beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-launch-'));
  flutterApp = path.join(ws, 'app');
  dartCli = path.join(ws, 'cli');
  empty = path.join(ws, 'empty');
  for (const d of [flutterApp, dartCli, empty]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(flutterApp, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.mkdirSync(path.join(flutterApp, 'lib'));
  fs.writeFileSync(path.join(flutterApp, 'lib', 'main_dev.dart'), 'void main() {}');
  fs.writeFileSync(path.join(dartCli, 'pubspec.yaml'), 'name: cli\n');
});
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

type Listener = (s: any) => void;
interface FakeOpts {
  folders?: string[];
  dartCode?: boolean;
  selected?: string;
  /** What our provider + Dart-Code do with the config: returns the started session's config, or null = never starts. */
  resolve?: (config: Record<string, any>) => Record<string, any> | null;
  startOk?: boolean;
  hotRestart?: (id: string) => Promise<void>;
}

function fake(o: FakeOpts = {}) {
  const start: Listener[] = [];
  const term: Listener[] = [];
  const launched: Record<string, any>[] = [];
  const stopped: string[] = [];
  const restarted: string[] = [];
  let n = 0;
  const on = (arr: Listener[]) => (l: Listener) => {
    arr.push(l);
    return { dispose: () => arr.splice(arr.indexOf(l), 1) };
  };
  const mkSession = (config: Record<string, any>) => ({
    id: `s${++n}`,
    type: 'dart',
    name: config.name ? `${config.name} (device)` : 'x',
    configuration: config,
    customRequest: async (cmd: string) => {
      if (cmd !== 'hotRestart') throw new Error('unexpected ' + cmd);
      await (o.hotRestart?.(`s${n}`) ?? Promise.resolve());
      restarted.push(cmd);
    },
  });
  const sessions: any[] = [];
  const vs: LauncherVscode = {
    debug: {
      startDebugging: async (_f, config) => {
        launched.push(config);
        if (o.startOk === false) return false;
        const resolved =
          o.resolve === undefined
            ? { ...config, program: '/x/.dart_tool/flutter_intercept/entry_lib__main.dart', flutterInterceptOriginalProgram: path.join(flutterApp, 'lib', 'main.dart'), debuggerType: 2 }
            : o.resolve(config);
        if (resolved) {
          const s = mkSession(resolved);
          sessions.push(s);
          setTimeout(() => start.forEach((l) => l(s)), 5);
        }
        return true;
      },
      stopDebugging: async (s: any) => {
        stopped.push(s.id);
        setTimeout(() => term.forEach((l) => l(s)), 5);
      },
      onDidStartDebugSession: on(start),
      onDidTerminateDebugSession: on(term),
    },
    workspace: { workspaceFolders: (o.folders ?? [flutterApp]).map((p) => ({ uri: { fsPath: p }, name: path.basename(p) })) },
    extensions: { getExtension: (id: string) => (o.dartCode === false ? undefined : id === 'Dart-Code.dart-code' ? {} : undefined) },
    commands: { executeCommand: async (cmd: string) => (cmd === 'flutter.getSelectedDeviceId' ? o.selected : undefined) as any },
  };
  const externalStart = (config: Record<string, any>) => {
    const s = mkSession(config);
    start.forEach((l) => l(s));
    return s;
  };
  return { vs, launched, stopped, restarted, externalStart };
}

describe('AppLauncher.launch', () => {
  it('starts an F5-like Dart-Code session and resolves with the session id once it starts', async () => {
    const f = fake();
    const l = createAppLauncher({ vscode: f.vs });
    const r = await l.launch({ deviceId: 'emulator-5554' });
    expect(f.launched[0]).toEqual({ type: 'dart', request: 'launch', name: AGENT_SESSION_NAME, cwd: flutterApp, deviceId: 'emulator-5554', flutterMode: 'debug', flutterInterceptAgentLaunch: expect.any(String) });
    expect(r).toMatchObject({ sessionId: 's1', intercepted: true, deviceId: 'emulator-5554', mode: 'debug', program: path.join(flutterApp, 'lib', 'main.dart') });
    expect(l.sessions()).toEqual([{ id: 's1', deviceId: 'emulator-5554', program: path.join(flutterApp, 'lib', 'main.dart'), mode: 'debug' }]);
    l.dispose();
  });

  it('passes program and profile mode; uses the selected device when none is given', async () => {
    const f = fake({ selected: 'macos' });
    const l = createAppLauncher({ vscode: f.vs });
    await l.launch({ program: 'lib/main_dev.dart', flutterMode: 'profile' });
    expect(f.launched[0]).toMatchObject({ program: 'lib/main_dev.dart', deviceId: 'macos', flutterMode: 'profile', cwd: flutterApp });
    l.dispose();
  });

  it('plain Dart projects need no device and no flutterMode', async () => {
    const f = fake({ folders: [dartCli] });
    const l = createAppLauncher({ vscode: f.vs });
    await l.launch({});
    expect(f.launched[0]).toEqual({ type: 'dart', request: 'launch', name: AGENT_SESSION_NAME, cwd: dartCli, flutterInterceptAgentLaunch: expect.any(String) });
    l.dispose();
  });

  it.each<[string, FakeOpts, Record<string, string>, RegExp]>([
    ['no folder', { folders: [] }, {}, /No folder is open/],
    ['no Flutter project', { folders: ['__EMPTY__'] }, {}, /No Flutter project is open/],
    ['Dart-Code missing', { dartCode: false }, { deviceId: 'x' }, /Dart-Code/],
    ['no device', {}, {}, /No device/],
    ['release', {}, { deviceId: 'x', flutterMode: 'release' }, /Release builds are never intercepted/],
    ['bad mode', {}, { deviceId: 'x', flutterMode: 'jit' }, /debug" or "profile/],
    ['program outside', {}, { deviceId: 'x', program: '/nowhere/main.dart' }, /not inside/],
    ['startDebugging false', { startOk: false }, { deviceId: 'x' }, /did not start the debug session/],
  ])('clear error: %s', async (_n, o, opts, re) => {
    // it.each rows are built before beforeAll: resolve the temp folder lazily.
    if (o.folders) o = { ...o, folders: o.folders.map((f) => (f === '__EMPTY__' ? empty : f)) };
    const l = createAppLauncher({ vscode: fake(o).vs });
    const p = l.launch(opts as any);
    await expect(p).rejects.toBeInstanceOf(AgentToolError);
    await expect(p).rejects.toThrow(re);
    l.dispose();
  });

  it('times out if the session never starts, and a later launch still works', async () => {
    let first = true;
    const f = fake({
      resolve: (c) => {
        if (first) {
          first = false;
          return null;
        }
        return { ...c, flutterInterceptOriginalProgram: 'p', debuggerType: 2 };
      },
    });
    const l = createAppLauncher({ vscode: f.vs, startTimeoutMs: 50 });
    await expect(l.launch({ deviceId: 'x' })).rejects.toThrow(/did not start within/);
    await expect(l.launch({ deviceId: 'x' })).resolves.toMatchObject({ sessionId: 's1' });
    l.dispose();
  });

  it('reports intercepted=false when the provider did not rewrite (e.g. interception off)', async () => {
    const f = fake({ resolve: (c) => ({ ...c, program: '/app/lib/main.dart' }) });
    const l = createAppLauncher({ vscode: f.vs });
    expect(await l.launch({ deviceId: 'x' })).toMatchObject({ intercepted: false });
    expect(l.sessions()).toEqual([]);
    l.dispose();
  });

  it('serializes concurrent launches so each resolves with its own session', async () => {
    const f = fake();
    const l = createAppLauncher({ vscode: f.vs });
    const [a, b] = await Promise.all([l.launch({ deviceId: 'a' }), l.launch({ deviceId: 'b' })]);
    expect([a.sessionId, b.sessionId]).toEqual(['s1', 's2']);
    expect(l.sessions().map((s) => s.deviceId)).toEqual(['a', 'b']);
    l.dispose();
  });
});

describe('AppLauncher sessions / stop / hotRestart', () => {
  it('tracks intercepted Dart sessions started any way (F5 too) with the lan flag', () => {
    const f = fake();
    const l = createAppLauncher({ vscode: f.vs });
    f.externalStart({ name: 'F5', flutterInterceptOriginalProgram: '/a/lib/main.dart', debuggerType: 2, deviceId: '0000-PHONE', flutterInterceptLan: true, flutterMode: 'Profile' });
    f.externalStart({ name: 'not ours', program: '/a/lib/main.dart' });
    expect(l.sessions()).toEqual([{ id: 's1', deviceId: '0000-PHONE', program: '/a/lib/main.dart', mode: 'profile', lan: true }]);
    l.dispose();
  });

  it('stop() stops one or all intercepted sessions and waits for termination', async () => {
    const f = fake();
    const l = createAppLauncher({ vscode: f.vs });
    const a = await l.launch({ deviceId: 'a' });
    await l.launch({ deviceId: 'b' });
    expect(await l.stop(a.sessionId)).toEqual({ stopped: 1 });
    expect(l.sessions().map((s) => s.deviceId)).toEqual(['b']);
    expect(await l.stop()).toEqual({ stopped: 1 });
    expect(f.stopped).toEqual(['s1', 's2']);
    expect(await l.stop()).toEqual({ stopped: 0 });
    await expect(l.stop('nope')).rejects.toThrow(/No running intercepted session nope/);
    l.dispose();
  });

  it('hotRestart() sends the Dart-Code hotRestart request; refuses profile sessions and empty state', async () => {
    const f = fake();
    const l = createAppLauncher({ vscode: f.vs });
    await expect(l.hotRestart()).rejects.toThrow(/launch_app first/);
    const a = await l.launch({ deviceId: 'a' });
    expect(await l.hotRestart(a.sessionId)).toEqual({ restarted: 1 });
    expect(f.restarted).toEqual(['hotRestart']);
    await l.launch({ deviceId: 'b', flutterMode: 'profile' });
    const all = await l.hotRestart();
    expect(all).toMatchObject({ restarted: 1, errors: [expect.stringContaining('profile')] });
    await expect(l.hotRestart('s2')).rejects.toThrow(/debug-mode Flutter session/);
    l.dispose();
  });

  it('hotRestart() surfaces adapter errors', async () => {
    const f = fake({ hotRestart: async () => Promise.reject(new Error('app not started yet')) });
    const l = createAppLauncher({ vscode: f.vs });
    await l.launch({ deviceId: 'a' });
    await expect(l.hotRestart()).rejects.toThrow('Hot restart failed: s1: app not started yet');
    l.dispose();
  });
});
