import { execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InterceptProxy } from '@flutter-intercept/proxy';
import { mockttpCaGenerator } from '../../src/ca';
import {
  entryNameFor,
  entryPathFor,
  entrySha,
  ENTRY_TEMPLATE,
  findPubspecRoot,
  isGeneratedEntry,
  parsePubspec,
  planEntry,
  renderEntry,
  targetImportFor,
  writeEntry,
} from '../../src/entry/generator';

const FAKE_CA = '-----BEGIN CERTIFICATE-----\nTUlJQ0FBQUE=\n-----END CERTIFICATE-----\n';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('parsePubspec', () => {
  it('reads name and flutter deps', () => {
    expect(parsePubspec('name: my_app # comment\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.0.0\n')).toEqual({
      name: 'my_app',
      isFlutter: true,
    });
    expect(parsePubspec("name: 'quoted'\ndependencies:\n  http: any\n")).toEqual({ name: 'quoted', isFlutter: false });
    expect(parsePubspec('name: x\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n').isFlutter).toBe(true);
    expect(parsePubspec('name: x\nflutter:\n  uses-material-design: true\n').isFlutter).toBe(false);
  });
});

describe('paths and imports', () => {
  let root: string;
  beforeAll(() => {
    root = tmpDir('fi-gen-');
    write(path.join(root, 'app', 'pubspec.yaml'), 'name: my_app\n');
    write(path.join(root, 'app', 'lib', 'main_dev.dart'), 'void main() {}');
    write(path.join(root, 'app', 'lib', 'src', 'my file.dart'), 'void main() {}');
    write(path.join(root, 'app', 'bin', 'cli.dart'), 'void main(List<String> a) {}');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds the nearest pubspec upward', () => {
    expect(findPubspecRoot(path.join(root, 'app', 'lib', 'src', 'my file.dart'))).toBe(path.join(root, 'app'));
    expect(findPubspecRoot(path.join(root, 'app', 'lib'))).toBe(path.join(root, 'app'));
    expect(findPubspecRoot(path.join(root, 'elsewhere.dart'))).toBeUndefined();
  });

  it('names the entry after the full project-relative path (no flavor collisions)', () => {
    const app = path.join(root, 'app');
    expect(entryPathFor(app, path.join(app, 'lib', 'main_dev.dart'))).toBe(path.join(app, '.dart_tool', 'flutter_intercept', 'entry_lib__main_dev.dart'));
    expect(isGeneratedEntry(path.join(app, '.dart_tool', 'flutter_intercept', 'entry_lib__main_dev.dart'))).toBe(true);
    expect(isGeneratedEntry(path.join(app, 'lib', 'main.dart'))).toBe(false);
    const name = (rel: string) => entryNameFor(app, path.join(app, rel));
    expect(name('lib/main.dart')).toBe('entry_lib__main.dart');
    expect(name('lib/flavors/dev/main.dart')).toBe('entry_lib__flavors__dev__main.dart');
    expect(name('lib/flavors/prod/main.dart')).toBe('entry_lib__flavors__prod__main.dart');
    expect(name('bin/main.dart')).toBe('entry_bin__main.dart');
    expect(name('tool/gen/run.dart')).toBe('entry_tool__gen__run.dart');
    // Lossy mappings get a hash so they can never collide.
    expect(name('lib/src/app/main-dev.dart')).toMatch(/^entry_lib__src__app__main_dev_[0-9a-f]{8}\.dart$/);
    expect(name('lib/a__b.dart')).not.toBe(name('lib/a/b.dart'));
    expect(name('lib/main-dev.dart')).not.toBe(name('lib/main_dev.dart'));
    expect(entryNameFor(app, path.join(root, 'outside.dart'))).toMatch(/^entry_outside_[0-9a-f]{8}\.dart$/);
    expect(entryNameFor(app, path.join(root, 'x', 'outside.dart'))).not.toBe(entryNameFor(app, path.join(root, 'outside.dart')));
  });

  it('uses package: imports under lib/ and relative imports elsewhere', () => {
    const app = path.join(root, 'app');
    const entry = entryPathFor(app, 'x.dart');
    expect(targetImportFor(app, 'my_app', path.join(app, 'lib', 'main_dev.dart'), entry)).toBe('package:my_app/main_dev.dart');
    expect(targetImportFor(app, 'my_app', path.join(app, 'lib', 'src', 'my file.dart'), entry)).toBe('package:my_app/src/my%20file.dart');
    expect(targetImportFor(app, 'my_app', path.join(app, 'bin', 'cli.dart'), entry)).toBe('../../bin/cli.dart');
    expect(targetImportFor(app, undefined, path.join(app, 'lib', 'main_dev.dart'), entry)).toBe('../../lib/main_dev.dart');
  });

  it('plans an entry that matches the contract template', () => {
    const app = path.join(root, 'app');
    const plan = planEntry({ program: path.join(app, 'lib', 'main_dev.dart'), proxyPort: 9123, caCertPem: FAKE_CA })!;
    expect(plan.projectRoot).toBe(app);
    expect(plan.content).toContain("import 'package:my_app/main_dev.dart' as target;");
    expect(plan.content).toContain("String.fromEnvironment('FLUTTER_INTERCEPT_PROXY', defaultValue: 'localhost:9123')");
    expect(plan.content).toContain("const _caCertificate = r'''\n-----BEGIN CERTIFICATE-----\nTUlJQ0FBQUE=\n-----END CERTIFICATE-----\n''';");
    expect(plan.content).not.toContain('{{');
    // Never accept-any: no callback returning true is installed by the entry.
    expect(plan.content).not.toMatch(/=>\s*true/);
    expect(plan.sha).toMatch(/^[0-9a-f]{12}$/);
    expect(plan.sha).toBe(entrySha(plan.content));
  });

  it('ENTRY_TEMPLATE is the CONTRACTS.md §1 template verbatim', () => {
    const contracts = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'CONTRACTS.md'), 'utf8');
    const block = /## 1\.[\s\S]*?```dart\n([\s\S]*?)```/.exec(contracts)![1];
    expect(ENTRY_TEMPLATE).toBe(block);
  });

  it('falls back to the given root when there is no pubspec', () => {
    const loose = tmpDir('fi-loose-');
    write(path.join(loose, 'tool.dart'), 'void main() {}');
    const plan = planEntry({ program: path.join(loose, 'tool.dart'), fallbackRoot: loose, proxyPort: 1, caCertPem: FAKE_CA })!;
    expect(plan.projectRoot).toBe(loose);
    expect(plan.targetImport).toBe('../../tool.dart');
    fs.rmSync(loose, { recursive: true, force: true });
  });

  it('only ever embeds a single certificate (never a key) and refuses to write without one', async () => {
    expect(() => renderEntry({ targetImport: 'x.dart', proxyPort: 1, caCertPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----' })).toThrow();
    expect(() => renderEntry({ targetImport: 'x.dart', proxyPort: 1, caCertPem: FAKE_CA + FAKE_CA })).toThrow();
    const app = path.join(root, 'app');
    const plan = planEntry({ program: path.join(app, 'lib', 'main_dev.dart'), proxyPort: 1, caCertPem: '' })!;
    await expect(writeEntry(plan)).rejects.toThrow(/CA certificate/);
  });
});

// Compiles and runs generated entries with the real Dart SDK (skipped when `dart` is absent).
const hasDart = spawnSync('dart', ['--version']).status === 0;

describe.skipIf(!hasDart)('generated entries compile and run for every main signature (real dart)', () => {
  let app: string;
  const variants: Record<string, string> = {
    'lib/v_void.dart': "void main() { print('CALLED v_void'); }",
    'lib/v_void_async.dart':
      "import 'dart:io';\nvoid main() async { await Future<void>.delayed(const Duration(milliseconds: 5)); print('CALLED v_void_async \${HttpOverrides.current.runtimeType}'); }",
    'lib/v_future_args.dart': "Future<void> main(List<String> args) async { print('CALLED v_future_args \$args'); }",
    'lib/v_untyped.dart': "main(args) { print('CALLED v_untyped \$args'); }",
    'lib/src/real_main.dart': "void main(List<String> args) { print('CALLED reexport \$args'); }",
    'lib/v_reexport.dart': "export 'src/real_main.dart' show main;",
    'lib/v_optional.dart': "void main([List<String>? args]) { print('CALLED v_optional \$args'); }",
    'lib/v_replaces_global.dart':
      "import 'dart:io';\nclass Mine extends HttpOverrides {}\nvoid main() { HttpOverrides.global = Mine(); print('CALLED v_replaces_global \${HttpOverrides.current.runtimeType}'); }",
    'bin/v_bin.dart': "import 'package:sample_app/v_void.dart' as other;\nvoid main(List<String> args) { print('CALLED v_bin \$args \${other.main.runtimeType}'); }",
  };
  const expected: Record<string, string> = {
    'lib/v_void.dart': 'CALLED v_void',
    'lib/v_void_async.dart': 'CALLED v_void_async _FlutterInterceptOverrides',
    'lib/v_future_args.dart': 'CALLED v_future_args [a, b]',
    'lib/v_untyped.dart': 'CALLED v_untyped [a, b]',
    'lib/v_reexport.dart': 'CALLED reexport [a, b]',
    'lib/v_optional.dart': 'CALLED v_optional [a, b]',
    'lib/v_replaces_global.dart': 'CALLED v_replaces_global _FlutterInterceptOverrides',
    'bin/v_bin.dart': 'CALLED v_bin [a, b]',
  };
  const entries: Record<string, string> = {};

  let realCa: { key: string; cert: string };
  beforeAll(async () => {
    realCa = await mockttpCaGenerator('Flutter Intercept CA unit-test');
    app = tmpDir('fi-dart-');
    write(path.join(app, 'pubspec.yaml'), 'name: sample_app\nenvironment:\n  sdk: ^3.0.0\n');
    for (const [rel, src] of Object.entries(variants)) write(path.join(app, rel), src + '\n');
    execFileSync('dart', ['pub', 'get', '--offline'], { cwd: app, stdio: 'pipe' });
    for (const rel of Object.keys(expected)) {
      const plan = planEntry({ program: path.join(app, rel), proxyPort: 9, caCertPem: realCa.cert })!;
      await writeEntry(plan);
      entries[rel] = plan.entryPath;
    }
  }, 120_000);
  afterAll(() => app && fs.rmSync(app, { recursive: true, force: true }));

  it('dart analyze reports no errors for any generated entry', () => {
    const r = spawnSync('dart', ['analyze', '--no-fatal-warnings', ...Object.values(entries)], { cwd: app, encoding: 'utf8' });
    expect(r.stdout + r.stderr).not.toMatch(/\berror\b -/);
    expect(r.status).toBe(0);
  }, 120_000);

  it.each(Object.keys(expected))('%s runs main through the entry', (rel) => {
    const r = spawnSync('dart', ['run', entries[rel], 'a', 'b'], { cwd: app, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain(expected[rel]);
  }, 60_000);
});

// REVIEW-1 #1: the entry must never accept an untrusted certificate, on the proxy path or on
// the `; DIRECT` fallback, and must intercept HTTPS through a proxy signing with *this* CA.
describe.skipIf(!hasDart)('certificate trust (real dart + real InterceptProxy)', () => {
  let app: string;
  let entryFile: string;
  let evil: https.Server;
  let evilPort: number;
  let ca: { key: string; cert: string };
  let proxy: InterceptProxy | undefined;
  let proxyPort: number;

  const runEntry = (url: string) =>
    new Promise<string>((resolve) => {
      const p = spawn('dart', ['run', entryFile, url], { cwd: app });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', () => resolve(out));
    });

  beforeAll(async () => {
    ca = await mockttpCaGenerator('Flutter Intercept CA trust-test');
    // The attack server: self-signed CN=evil.example.
    const evilCert = await mockttpCaGenerator('evil.example');
    evil = https.createServer({ key: evilCert.key, cert: evilCert.cert }, (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"evil":true}');
    });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', () => r()));
    evilPort = (evil.address() as AddressInfo).port;
    // A port nothing listens on: "proxy down".
    const probe = https.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    proxyPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    app = tmpDir('fi-trust-');
    write(path.join(app, 'pubspec.yaml'), 'name: trust_app\nenvironment:\n  sdk: ^3.0.0\n');
    write(
      path.join(app, 'lib', 'fetch.dart'),
      [
        "import 'dart:convert';",
        "import 'dart:io';",
        'Future<void> main(List<String> args) async {',
        '  try {',
        '    final res = await (await HttpClient().getUrl(Uri.parse(args.first))).close();',
        "    print('RESULT \${res.statusCode} \${await res.transform(utf8.decoder).join()}');",
        '  } catch (e) {',
        "    print('REJECTED \$e');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    execFileSync('dart', ['pub', 'get', '--offline'], { cwd: app, stdio: 'pipe' });
    const plan = planEntry({ program: path.join(app, 'lib', 'fetch.dart'), proxyPort, caCertPem: ca.cert })!;
    await writeEntry(plan);
    entryFile = plan.entryPath;
  }, 120_000);

  afterAll(async () => {
    await proxy?.stop();
    evil?.close();
    if (app) fs.rmSync(app, { recursive: true, force: true });
  });

  it('proxy down: the DIRECT fallback rejects a self-signed server', async () => {
    const out = await runEntry(`https://localhost:${evilPort}/`);
    expect(out).toContain('REJECTED');
    expect(out).toContain('CERTIFICATE_VERIFY_FAILED');
    expect(out).not.toContain('"evil":true');
  }, 60_000);

  it('proxy up with this CA: HTTPS is intercepted (mocked) with normal verification', async () => {
    proxy = new InterceptProxy({ port: proxyPort, ca });
    await proxy.start();
    proxy.setRules([
      { id: 'm', enabled: true, match: { url: 'https://intercept.test/*' }, action: { kind: 'mock', status: 200, body: '{"mocked":true}' } },
    ]);
    const out = await runEntry('https://intercept.test/x');
    expect(out).toContain('RESULT 200 {"mocked":true}');
  }, 60_000);

  it('proxy up: the self-signed server is still rejected (by the proxy upstream, never accepted)', async () => {
    const out = await runEntry(`https://localhost:${evilPort}/`);
    expect(out).not.toContain('"evil":true');
  }, 60_000);

  it('proxy up but signing with a different CA: the app does not trust it', async () => {
    await proxy?.stop();
    proxy = new InterceptProxy({ port: proxyPort, ca: await mockttpCaGenerator('Some other CA') });
    await proxy.start();
    proxy.setRules([
      { id: 'm', enabled: true, match: { url: 'https://intercept.test/*' }, action: { kind: 'mock', status: 200, body: '{"mocked":true}' } },
    ]);
    const out = await runEntry('https://intercept.test/x');
    expect(out).not.toContain('{"mocked":true}');
    expect(out).toContain('REJECTED'); // TLS to the proxy fails; DIRECT cannot resolve intercept.test either
  }, 60_000);
});
