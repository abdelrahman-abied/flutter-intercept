// CONTRACTS §13.3 against a real Dart VM + DDS (`dart run --pause-isolates-on-start`): the installer holds every new
// isolate at start, installs the template-v5 overrides in Isolate.run / Isolate.spawn isolates, leaves an
// Isolate.spawnUri isolate alone, and never leaves anything paused (the program runs to the end).
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockttpCaGenerator } from '../../src/ca';
import { planEntry, writeEntry } from '../../src/entry/generator';
import { createIsolateInstaller } from '../../src/vm/isolates';
import { connectWsTransport, defaultWebSocketCtor, toWsUri } from '../../src/vm/transport';

const hasDart = spawnSync('dart', ['--version']).status === 0;
const WebSocketCtor = defaultWebSocketCtor();

const MAIN = `import 'dart:io';
import 'dart:isolate';

String _where() => '\${HttpOverrides.current.runtimeType}';

void _spawned(SendPort reply) => reply.send(_where());

Future<void> main() async {
  print('RESULT main \${_where()}');
  print('RESULT run \${await Isolate.run(_where, debugName: 'fi_run')}');
  final port = ReceivePort();
  await Isolate.spawn(_spawned, port.sendPort, debugName: 'fi_spawn');
  print('RESULT spawn \${await port.first}');
  final port2 = ReceivePort();
  await Isolate.spawnUri(Uri.file('\${Directory.current.path}/bin/other.dart'), const [], port2.sendPort, debugName: 'fi_spawnuri');
  print('RESULT spawnuri \${await port2.first}');
  print('RESULT done');
}
`;
const OTHER = `import 'dart:io';
import 'dart:isolate';

void main(List<String> args, SendPort reply) => reply.send('\${HttpOverrides.current.runtimeType}');
`;

describe.skipIf(!hasDart || !WebSocketCtor)('background-isolate install (real dart + DDS)', () => {
  let app: string;
  let entry: string;
  let child: ChildProcess | undefined;
  beforeAll(async () => {
    const ca = await mockttpCaGenerator('Flutter Intercept CA isolate-test');
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-iso-'));
    fs.mkdirSync(path.join(app, 'bin'));
    fs.writeFileSync(path.join(app, 'pubspec.yaml'), 'name: iso_app\nenvironment:\n  sdk: ^3.0.0\n');
    fs.writeFileSync(path.join(app, 'bin', 'main.dart'), MAIN);
    fs.writeFileSync(path.join(app, 'bin', 'other.dart'), OTHER);
    execFileSync('dart', ['pub', 'get', '--offline'], { cwd: app, stdio: 'pipe' });
    const plan = planEntry({ program: path.join(app, 'bin', 'main.dart'), proxyPort: 9, caCertPem: ca.cert })!;
    await writeEntry(plan);
    entry = plan.entryPath;
  }, 120_000);
  afterAll(() => {
    child?.kill();
    if (app) fs.rmSync(app, { recursive: true, force: true });
  });

  it('installs in Isolate.run / Isolate.spawn isolates, not in spawnUri ones; every isolate resumes', async () => {
    child = spawn('dart', ['run', '--enable-vm-service=0', '--pause-isolates-on-start', entry], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => (out += String(d)));
    child.stderr!.on('data', (d) => (out += String(d)));
    const exited = new Promise<number | null>((resolve) => child!.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 30_000;
    let uri: string | undefined;
    while (!uri && Date.now() < deadline) {
      uri = /listening on (http:\/\/127\.0\.0\.1:\d+\/[^/\s]+\/)/.exec(out)?.[1];
      if (!uri) await new Promise((r) => setTimeout(r, 50));
    }
    expect(uri, out).toBeDefined();
    const logs: string[] = [];
    const installer = createIsolateInstaller('real-session', { log: (m) => logs.push(m) });
    const t = await connectWsTransport(toWsUri(uri!), WebSocketCtor!, { streams: ['Debug'] });
    // What Dart-Code's debug adapter does at launch: DDS needs no "user" resume for isolates paused at start
    // (it launched the VM with --pause-isolates-on-start itself). With the DAP, it also approves each isolate.
    await t.call('requireUserPermissionToResume', { onPauseStart: false, onPauseExit: false });
    // The main isolate is paused at start: the installer's scan must release it.
    expect(await installer.start(t)).toBe(true);
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 30_000))]);
    installer.stop();
    expect(code, out).toBe(0);
    expect(out).toContain('RESULT main _FlutterInterceptOverrides');
    expect(out).toContain('RESULT run _FlutterInterceptOverrides');
    expect(out).toContain('RESULT spawn _FlutterInterceptOverrides');
    expect(out).toContain('RESULT spawnuri Null');
    expect(out).toContain('RESULT done');
    // Isolate.run, Isolate.spawn and the main isolate (paused at start; idempotent with the entry's main).
    expect(installer.stats.installed).toBe(3);
    expect(installer.stats.maxHeldMs).toBeLessThan(2000);
    expect(logs.join('\n')).toMatch(/"fi_run" go through the proxy/);
    expect(logs.join('\n')).toMatch(/"fi_spawnuri" runs another program/);
  }, 60_000);
});
