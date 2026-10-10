import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lanIPv4Addresses } from '@flutter-intercept/proxy';
import { flutterExecutable, flutterTestArgs, networkProfileFor, runCli, SetupError, stripOwnDefines, type ChildLike, type RunDeps } from '../src/run';
import type { CliOptions } from '../src/types';

let server: http.Server;
let origin: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-cli-run-')));
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  integration_test:\n    sdk: flutter\n');
  fs.mkdirSync(path.join(dir, 'integration_test'));
  fs.writeFileSync(path.join(dir, 'integration_test', 'app_test.dart'), 'void main() {}\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** GET `url` through the proxy at host:port (absolute-form request, like dart:io with PROXY host:port). */
function viaProxy(proxy: string, url: string): Promise<number> {
  const [host, port] = proxy.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: host === 'localhost' ? '127.0.0.1' : host, port: Number(port), path: url, headers: { host: new URL(url).host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Fake {
  deps: RunDeps;
  exitHooks: (() => void)[];
  calls: { cmd: string; args: string[]; cwd: string }[];
  logs: string[];
  out: string[];
  signals: EventEmitter;
}

function fake(behaviour: (args: string[], child: FakeChild) => void, devices = [{ id: 'macos', targetPlatform: 'darwin' }]): Fake {
  const calls: Fake['calls'] = [];
  const logs: string[] = [];
  const out: string[] = [];
  const signals = new EventEmitter();
  const exitHooks: (() => void)[] = [];
  return {
    exitHooks,
    calls,
    logs,
    out,
    signals,
    deps: {
      cwd: dir,
      env: {},
      log: (m) => logs.push(m),
      out: (m) => out.push(m),
      version: 'test',
      listDevices: async () => devices,
      spawn: (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        const c = new FakeChild();
        setImmediate(() => behaviour(args, c));
        return c;
      },
      signals: signals as unknown as RunDeps['signals'],
      killGraceMs: { forward: 10, kill: 50 },
      onExit: (fn) => {
        exitHooks.push(fn);
        return () => exitHooks.splice(exitHooks.indexOf(fn), 1);
      },
    },
  };
}

class FakeChild extends EventEmitter implements ChildLike {
  exitCode: number | null = null;
  killed: string[] = [];
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    this.emit('exit', code, signal);
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    setImmediate(() => this.exit(null, signal));
    return true;
  }
}

const proxyOf = (args: string[]) => args.find((a) => a.startsWith('--dart-define=FLUTTER_INTERCEPT_PROXY='))!.split('=')[2];
const base = (o: Partial<CliOptions> = {}): CliOptions => ({ command: 'test', targets: [], flutterArgs: [], device: 'macos', ...o });

describe('runCli (fake flutter)', () => {
  it('runs flutter test on the wrapper with the device define, applies rules, writes outputs, checks assertions', async () => {
    fs.mkdirSync(path.join(dir, '.vscode'));
    fs.writeFileSync(
      path.join(dir, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({ version: 1, rules: [{ id: 'm', name: 'Mock', match: { url: 'http://mocked.test/*' }, action: { kind: 'mock', status: 201, body: '{"mocked":true}' } }] }),
    );
    fs.writeFileSync(
      path.join(dir, 'expect.json'),
      JSON.stringify([
        { name: 'real', url: `${origin}/users/*`, expect: { status: 200, json: [{ path: '$.ok', equals: true }] } },
        { name: 'mocked', url: 'http://mocked.test/*', expect: { status: 201 } },
      ]),
    );
    let wrapperSeen = false;
    const f = fake(async (args, child) => {
      wrapperSeen = fs.existsSync(path.join(dir, args[1]));
      const proxy = proxyOf(args);
      await viaProxy(proxy, `${origin}/users/1`);
      await viaProxy(proxy, 'http://mocked.test/a');
      child.exit(0);
    });
    const r = await runCli(base({ har: 'out/run.har', junit: 'out/junit.xml', assert: 'expect.json', record: 'out/rec.json', flutterArgs: ['--flavor', 'dev', '--dart-define=FLUTTER_INTERCEPT_PROXY=evil:1'] }), f.deps);
    expect(r).toEqual({
      exitCode: 0,
      exchanges: 2,
      assertions: { passed: 2, failed: 0 },
      outputs: { har: path.join(dir, 'out/run.har'), record: path.join(dir, 'out/rec.json'), junit: path.join(dir, 'out/junit.xml') },
    });
    const { cmd, args, cwd } = f.calls[0];
    expect(cmd).toBe('flutter');
    expect(cwd).toBe(dir);
    expect(args.slice(0, 4)).toEqual(['test', path.join('integration_test', '.flutter_intercept', 'entry_integration_test__app_test_fi.dart'), '-d', 'macos']);
    expect(args).toContain('--flavor');
    expect(args.filter((a) => a.includes('FLUTTER_INTERCEPT_PROXY'))).toEqual([expect.stringMatching(/^--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:\d+$/)]);
    expect(args.some((a) => /^--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=[0-9a-f]{12}$/.test(a))).toBe(true);
    expect(f.logs.some((l) => l.startsWith('ignored --dart-define=FLUTTER_INTERCEPT_PROXY=evil:1'))).toBe(true);
    expect(wrapperSeen).toBe(true);
    expect(fs.existsSync(path.join(dir, 'integration_test', '.flutter_intercept'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.dart_tool', 'flutter_intercept', 'entry_integration_test__app_test.dart'))).toBe(true);
    const har = JSON.parse(fs.readFileSync(path.join(dir, 'out/run.har'), 'utf8'));
    expect(har.log.entries).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, 'out/junit.xml'), 'utf8')).toContain('tests="2" failures="0"');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'out/rec.json'), 'utf8')).entries).toHaveLength(2);
    expect(f.out.join('\n')).toMatch(/2 request\(s\), 2 route\(s\), 1 answered by rules/);
    expect(f.out.join('\n')).toMatch(/2\/2 assertion\(s\) passed/);
  });

  it('exit code: flutter failure wins, then failed assertions', async () => {
    fs.writeFileSync(path.join(dir, 'expect.json'), JSON.stringify([{ url: 'http://never.test/*', expect: {} }]));
    const failing = fake((_a, c) => c.exit(3));
    expect((await runCli(base({ assert: 'expect.json' }), failing.deps)).exitCode).toBe(3);
    const passing = fake((_a, c) => c.exit(0));
    const r = await runCli(base({ assert: 'expect.json' }), passing.deps);
    expect(r.exitCode).toBe(1);
    expect(r.assertions).toEqual({ passed: 0, failed: 1 });
  });

  it('maps the Android emulator to 10.0.2.2 and refuses web devices before starting anything', async () => {
    const f = fake((_a, c) => c.exit(0));
    await runCli(base({ device: 'emulator-5554' }), f.deps);
    expect(proxyOf(f.calls[0].args)).toMatch(/^10\.0\.2\.2:\d+$/);
    const web = fake((_a, c) => c.exit(0), [{ id: 'chrome', targetPlatform: 'web-javascript' }]);
    await expect(runCli(base({ device: 'chrome' }), web.deps)).rejects.toThrow(/web device/);
    expect(web.calls).toHaveLength(0);
  });

  it('stops flutter and cleans up on SIGTERM', async () => {
    let child: FakeChild | undefined;
    const f = fake((_a, c) => {
      child = c;
      f.signals.emit('SIGTERM');
    });
    const r = await runCli(base(), f.deps);
    expect(r.exitCode).toBe(143);
    expect(child!.killed).toEqual(['SIGTERM']);
    expect(fs.existsSync(path.join(dir, 'integration_test', '.flutter_intercept'))).toBe(false);
    expect(f.signals.listenerCount('SIGTERM')).toBe(0);
    expect(f.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('SIGHUP stops like SIGTERM (flutter gets SIGTERM), exit 129 (REVIEW-7 #13)', async () => {
    let child: FakeChild | undefined;
    const f = fake((_a, c) => {
      child = c;
      f.signals.emit('SIGHUP');
    });
    const r = await runCli(base(), f.deps);
    expect(r.exitCode).toBe(129);
    expect(child!.killed).toEqual(['SIGTERM']);
    expect(f.signals.listenerCount('SIGHUP')).toBe(0);
  });

  it('the exit hook removes the wrappers and the temp CA if the process ends mid-run, and is removed after a normal end', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('flutter-intercept-run-')));
    let seen: { wrapper: boolean; tmp: string[] } | undefined;
    const f = fake((_a, c) => {
      const created = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('flutter-intercept-run-') && !before.has(n));
      expect(f.exitHooks).toHaveLength(1);
      f.exitHooks[0](); // what process.on('exit') would run
      seen = {
        wrapper: fs.existsSync(path.join(dir, 'integration_test', '.flutter_intercept')),
        tmp: created.filter((n) => fs.existsSync(path.join(os.tmpdir(), n))),
      };
      c.exit(0);
    });
    await runCli(base(), f.deps);
    expect(seen).toEqual({ wrapper: false, tmp: [] });
    expect(f.exitHooks).toHaveLength(0);
  });

  it('never prints user dart-define values (REVIEW-7 #10)', async () => {
    const f = fake((_a, c) => c.exit(0));
    await runCli(base({ flutterArgs: ['--dart-define=API_KEY=s3cret-value', '--dart-define', 'OTHER=hidden-too'] }), f.deps);
    expect(f.calls[0].args).toContain('--dart-define=API_KEY=s3cret-value');
    const printed = [...f.logs, ...f.out].join('\n');
    expect(printed).not.toContain('s3cret-value');
    expect(printed).not.toContain('hidden-too');
    expect(printed).toContain('--dart-define=API_KEY=***');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n');
    const g = fake(() => undefined);
    const p = runCli({ command: 'run', targets: [], flutterArgs: ['--dart-define=API_KEY=s3cret-value'] }, g.deps);
    await new Promise((r) => setTimeout(r, 300));
    g.signals.emit('SIGINT');
    await p;
    expect([...g.logs, ...g.out].join('\n')).not.toContain('s3cret-value');
  });

  it('run: prints the flutter command and waits for Ctrl-C', async () => {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n');
    const f = fake(() => undefined);
    const p = runCli({ command: 'run', targets: [], flutterArgs: [] }, f.deps);
    await new Promise((r) => setTimeout(r, 300));
    const line = f.out.find((l) => l.startsWith('--dart-define='))!;
    expect(line).toMatch(/^--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:\d+$/);
    expect(await viaProxy(line.split('=')[2], `${origin}/x`)).toBe(200);
    f.signals.emit('SIGINT');
    const r = await p;
    expect(r.exitCode).toBe(0);
    expect(r.exchanges).toBe(1);
    expect(f.calls).toHaveLength(0);
    expect(f.out.join('\n')).toContain('flutter run -t .dart_tool/flutter_intercept/entry_lib__main.dart');
  });

  it('setup errors come before the build', async () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '[{"url": 1}]');
    const f = fake((_a, c) => c.exit(0));
    await expect(runCli(base({ assert: 'bad.json' }), f.deps)).rejects.toBeInstanceOf(SetupError);
    await expect(runCli(base({ replay: 'nothing-saved' }), f.deps)).rejects.toThrow(/recording "nothing-saved" not found/);
    await expect(runCli(base({ targets: ['integration_test/missing_test.dart'] }), f.deps)).rejects.toThrow(/not found/);
    await expect(runCli(base({ project: os.tmpdir() }), f.deps)).rejects.toThrow(/no pubspec\.yaml/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('physical iPhone: LAN listener (CONTRACTS §7, §14.1)', () => {
  const IPHONE = [{ id: 'IPHONE', name: 'Test iPhone', targetPlatform: 'ios', emulator: false }];
  const lanIp = lanIPv4Addresses().find((a) => !a.startsWith('169.254.'));

  /** GET through the LAN listener, with `auth` as Proxy-Authorization (or none). */
  function viaLan(host: string, port: number, url: string, auth?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: new URL(url).host };
      if (auth) headers['proxy-authorization'] = auth;
      const req = http.request({ host, port, path: url, headers, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('refuses without a LAN address, before anything starts', async () => {
    const f = fake((_a, c) => c.exit(0), IPHONE);
    f.deps.lanAddress = async () => undefined;
    await expect(runCli(base({ device: 'IPHONE' }), f.deps)).rejects.toThrow(/physical iPhone: this machine has no LAN address/);
    f.deps.lanAddress = async () => ({ problem: "this Mac's network address 100.64.0.2 (en0) is not a private (RFC 1918) LAN address" });
    await expect(runCli(base({ device: 'IPHONE' }), f.deps)).rejects.toThrow(/not a private \(RFC 1918\) LAN address/);
    expect(f.calls).toHaveLength(0);
    expect(f.exitHooks).toHaveLength(0);
  });

  it('`run` is refused (it would have to print the token)', async () => {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'main.dart'), 'void main() {}\n');
    const f = fake(() => undefined, IPHONE);
    f.deps.lanAddress = async () => ({ address: '192.168.1.20', iface: 'en0' });
    await expect(runCli({ command: 'run', targets: [], flutterArgs: [], device: 'IPHONE' }, f.deps)).rejects.toThrow(/only works with `test`/);
  });

  it.skipIf(!lanIp)('opens a token-gated LAN listener for the run, never prints or writes the token, closes it after', async () => {
    fs.mkdirSync(path.join(dir, '.vscode'));
    fs.writeFileSync(
      path.join(dir, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({ version: 1, rules: [{ id: 'm', name: 'Mock', match: { url: 'http://mocked.test/*' }, action: { kind: 'mock', status: 201, body: '{}' } }] }),
    );
    const token = crypto.randomBytes(32).toString('base64url');
    let seen: { define: string; noAuth: number; wrong: number; ok: number } | undefined;
    let lanPort = 0;
    const f = fake(async (args, child) => {
      const define = args.find((a) => a.startsWith('--dart-define=FLUTTER_INTERCEPT_PROXY='))!.slice('--dart-define=FLUTTER_INTERCEPT_PROXY='.length);
      const m = /^flutter-intercept:([^@]+)@([\d.]+):(\d+)$/.exec(define)!;
      lanPort = Number(m[3]);
      const basic = (t: string) => `Basic ${Buffer.from(`flutter-intercept:${t}`).toString('base64')}`;
      seen = {
        define,
        noAuth: await viaLan(m[2], lanPort, 'http://mocked.test/none'),
        wrong: await viaLan(m[2], lanPort, 'http://mocked.test/wrong', basic('nope-nope-nope-nope')),
        ok: await viaLan(m[2], lanPort, 'http://mocked.test/ok', basic(m[1])),
      };
      child.exit(0);
    }, IPHONE);
    f.deps.lanAddress = async () => ({ address: lanIp!, iface: 'en0' });
    f.deps.newToken = () => token;
    const r = await runCli(base({ device: 'IPHONE', har: 'out/run.har', noRedact: true, record: 'out/rec.json', flutterArgs: ['-v'] }), f.deps);

    expect(seen).toEqual({ define: `flutter-intercept:${token}@${lanIp}:${lanPort}`, noAuth: 407, wrong: 407, ok: 201 });
    expect(r.exitCode).toBe(0);
    const printed = [...f.logs, ...f.out].join('\n');
    expect(printed).not.toContain(token);
    expect(printed).toContain(`--dart-define=FLUTTER_INTERCEPT_PROXY=flutter-intercept:***@${lanIp}:${lanPort}`);
    expect(f.logs.filter((l) => l.includes('Local Network'))).toHaveLength(1);
    expect(printed).toMatch(/flutter -v prints dart-define values/);
    const b64 = Buffer.from(`flutter-intercept:${token}`).toString('base64');
    for (const out of ['out/run.har', 'out/rec.json']) {
      const text = fs.readFileSync(path.join(dir, out), 'utf8');
      expect(text).toContain('mocked.test/ok');
      expect(text).not.toContain(token);
      expect(text).not.toContain(b64);
    }
    // the listener is gone with the run
    await expect(
      new Promise<void>((resolve, reject) => {
        const s = net.connect(lanPort, lanIp!, () => (s.destroy(), resolve()));
        s.on('error', reject);
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('helpers', () => {
  it('strips our own defines from the passthrough args', () => {
    expect(stripOwnDefines(['--flavor', 'dev', '--dart-define=FLUTTER_INTERCEPT_PROXY=x:1', '--dart-define', 'FLUTTER_INTERCEPT_ENTRY_SHA=abc', '--dart-define=A=1'])).toEqual({
      args: ['--flavor', 'dev', '--dart-define=A=1'],
      dropped: ['--dart-define=FLUTTER_INTERCEPT_PROXY=x:1', '--dart-define FLUTTER_INTERCEPT_ENTRY_SHA=abc'],
    });
  });

  it('builds the flutter test command with our defines last', () => {
    expect(flutterTestArgs(['w.dart'], 'macos', 'localhost:1', 'abc', ['--flavor', 'x'])).toEqual([
      'test', 'w.dart', '-d', 'macos', '--flavor', 'x', '--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:1', '--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=abc',
    ]);
  });

  it('finds flutter', () => {
    expect(flutterExecutable({ flutter: '/x/flutter' }, {})).toBe('/x/flutter');
    const exe = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
    expect(flutterExecutable({}, { FLUTTER_ROOT: '/sdk' }, () => true)).toBe(path.join('/sdk', 'bin', exe));
    expect(flutterExecutable({}, { FLUTTER_ROOT: '/sdk' }, () => false)).toBe(exe);
  });

  it('network profiles', () => {
    expect(networkProfileFor('offline')).toEqual({ kind: 'offline' });
    expect(networkProfileFor('slow-3g')).toMatchObject({ kind: 'throttle', preset: 'slow-3g' });
  });
});
