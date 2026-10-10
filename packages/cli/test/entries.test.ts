import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { combinedSha, findTestFiles, isIntegrationTestPath, prepareEntries, renderWrapper, resolveRunTargets, resolveTestTargets, WRAPPER_DIR, wrapperPathFor } from '../src/entries';

const CERT = `-----BEGIN CERTIFICATE-----
MIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhdGVGb3JUZXN0czAKBggqhkjOPQQDAjAA
-----END CERTIFICATE-----`;

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-cli-entries-')));
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  for (const f of ['integration_test/app_test.dart', 'integration_test/flows/login_test.dart', 'integration_test/helpers.dart', 'integration_test/.hidden/x_test.dart', 'lib/main.dart']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'void main() {}\n');
  }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('targets', () => {
  it('finds *_test.dart files, skipping hidden directories', () => {
    expect(findTestFiles(path.join(dir, 'integration_test')).map((f) => path.relative(dir, f))).toEqual([
      path.join('integration_test', 'app_test.dart'),
      path.join('integration_test', 'flows', 'login_test.dart'),
    ]);
  });

  it('defaults to integration_test/ and accepts files and directories', () => {
    expect(resolveTestTargets([], dir, dir)).toHaveLength(2);
    expect(resolveTestTargets(['integration_test/app_test.dart', 'integration_test'], dir, dir)).toHaveLength(2);
    expect(resolveTestTargets(['app_test.dart'], dir, path.join(dir, 'integration_test'))).toEqual([path.join(dir, 'integration_test', 'app_test.dart')]);
    // not found from the cwd: relative to the project (--project from elsewhere)
    expect(resolveTestTargets(['integration_test/app_test.dart'], dir, os.tmpdir())).toEqual([path.join(dir, 'integration_test', 'app_test.dart')]);
  });

  it('refuses targets that are missing, outside the project, generated or not Dart', () => {
    expect(() => resolveTestTargets(['nope_test.dart'], dir, dir)).toThrow(/not found/);
    expect(() => resolveTestTargets(['pubspec.yaml'], dir, dir)).toThrow(/not a \.dart file/);
    expect(() => resolveTestTargets([os.tmpdir()], dir, dir)).toThrow(/outside the Flutter project/);
    expect(() => resolveTestTargets(['lib'], dir, dir)).toThrow(/no \*_test\.dart files/);
    fs.mkdirSync(path.join(dir, WRAPPER_DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, WRAPPER_DIR, 'w.dart'), '');
    expect(() => resolveTestTargets([path.join(WRAPPER_DIR, 'w.dart')], dir, dir)).toThrow(/generated file/);
    fs.rmSync(path.join(dir, 'integration_test'), { recursive: true });
    expect(() => resolveTestTargets([], dir, dir)).toThrow(/no integration_test\/ directory/);
  });

  it('run defaults to lib/main.dart', () => {
    expect(resolveRunTargets([], dir, dir)).toEqual([path.join(dir, 'lib', 'main.dart')]);
    expect(() => resolveRunTargets(['lib/other.dart'], dir, dir)).toThrow(/not found/);
  });
});

describe('wrappers', () => {
  it('flutter_tools treats only paths under integration_test as device tests', () => {
    expect(isIntegrationTestPath(dir, path.join(dir, WRAPPER_DIR, 'x_fi.dart'))).toBe(true);
    expect(isIntegrationTestPath(dir, path.join(dir, '.dart_tool', 'flutter_intercept', 'entry_x.dart'))).toBe(false);
  });

  it('calls the entry main without arguments and is never a *_test.dart file', () => {
    const entry = path.join(dir, '.dart_tool', 'flutter_intercept', 'entry_integration_test__app_test.dart');
    const w = wrapperPathFor(dir, entry);
    expect(path.basename(w)).toBe('entry_integration_test__app_test_fi.dart');
    expect(w.endsWith('_test.dart')).toBe(false);
    const text = renderWrapper(w, entry);
    expect(text).toContain("import '../../.dart_tool/flutter_intercept/entry_integration_test__app_test.dart' as entry;");
    expect(text).toContain('Future<void> main() async => entry.main(const <String>[]);');
  });

  it('combines entry shas', () => {
    expect(combinedSha([{ sha: 'aaaaaaaaaaaa' }])).toBe('aaaaaaaaaaaa');
    expect(combinedSha([{ sha: 'a' }, { sha: 'b' }])).toMatch(/^[0-9a-f]{12}$/);
    expect(combinedSha([{ sha: 'a' }, { sha: 'b' }])).not.toBe(combinedSha([{ sha: 'b' }, { sha: 'a' }]));
  });

  it('writes entries + wrappers (gitignored) and removes the wrappers afterwards', async () => {
    const programs = resolveTestTargets([], dir, dir);
    const p = await prepareEntries({ programs, projectRoot: dir, proxyPort: 4567, caCertPem: CERT, wrap: true });
    expect(p.files).toHaveLength(2);
    for (const f of p.files) expect(fs.readFileSync(f, 'utf8')).toContain('entry.main(const <String>[])');
    for (const plan of p.plans) {
      const text = fs.readFileSync(plan.entryPath, 'utf8');
      expect(text).toContain('localhost:4567');
      expect(text).toContain(CERT.split('\n')[1]);
    }
    expect(fs.readFileSync(path.join(dir, WRAPPER_DIR, '.gitignore'), 'utf8')).toContain('*');
    p.cleanup();
    expect(fs.existsSync(path.join(dir, WRAPPER_DIR))).toBe(false);
    expect(fs.existsSync(p.plans[0].entryPath)).toBe(true);
  });

  it('never writes through planted symbolic links (REVIEW-7 #13)', async () => {
    if (process.platform === 'win32') return;
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-cli-outside-')));
    try {
      const victim = path.join(outside, 'victim.txt');
      fs.writeFileSync(victim, 'keep');
      const programs = resolveTestTargets(['integration_test/app_test.dart'], dir, dir);
      // a link where the wrapper and the entry go: replaced, the target untouched
      fs.mkdirSync(path.join(dir, WRAPPER_DIR), { recursive: true });
      fs.symlinkSync(victim, path.join(dir, WRAPPER_DIR, 'entry_integration_test__app_test_fi.dart'));
      fs.symlinkSync(victim, path.join(dir, WRAPPER_DIR, '.gitignore'));
      fs.mkdirSync(path.join(dir, '.dart_tool', 'flutter_intercept'), { recursive: true });
      fs.symlinkSync(victim, path.join(dir, '.dart_tool', 'flutter_intercept', 'entry_integration_test__app_test.dart'));
      const p = await prepareEntries({ programs, projectRoot: dir, proxyPort: 1, caCertPem: CERT, wrap: true });
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
      expect(fs.lstatSync(p.files[0]).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(p.plans[0].entryPath).isSymbolicLink()).toBe(false);
      p.cleanup();
      // a symlinked wrapper folder is refused
      fs.symlinkSync(outside, path.join(dir, WRAPPER_DIR));
      await expect(prepareEntries({ programs, projectRoot: dir, proxyPort: 1, caCertPem: CERT, wrap: true })).rejects.toThrow();
      expect(fs.readdirSync(outside)).toEqual(['victim.txt']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('run mode uses the entries directly', async () => {
    const p = await prepareEntries({ programs: resolveRunTargets([], dir, dir), projectRoot: dir, proxyPort: 1, caCertPem: CERT, wrap: false });
    expect(p.files).toEqual([path.join(dir, '.dart_tool', 'flutter_intercept', 'entry_lib__main.dart')]);
    expect(fs.readFileSync(p.files[0], 'utf8')).toContain("import 'package:app/main.dart' as target;");
    p.cleanup();
    expect(fs.existsSync(p.files[0])).toBe(true);
  });
});
