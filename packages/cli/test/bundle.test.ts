import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const bundle = path.join(root, 'dist', 'cli.js');

describe('dist/cli.js', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'pipe' });
  }, 120_000);

  it('is one executable file with a shebang', () => {
    const text = fs.readFileSync(bundle, 'utf8');
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(bundle).mode & 0o111).not.toBe(0);
  });

  it('never loads vscode (CONTRACTS §13.9)', () => {
    const text = fs.readFileSync(bundle, 'utf8');
    expect(text).not.toMatch(/require\(\s*["'`]vscode["'`]\s*\)/);
    expect(text).not.toMatch(/from\s*["']vscode["']/);
  });

  it('keeps mockttp admin / remote-client code out', () => {
    const map = JSON.parse(fs.readFileSync(`${bundle}.map`, 'utf8')) as { sources: string[] };
    expect(map.sources.filter((s) => /mockttp\/dist\/(admin|client|pluggable-admin-api)\//.test(s))).toEqual([]);
  });

  it('runs: --help, --version, usage errors exit 2', () => {
    const help = spawnSync(process.execPath, [bundle, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: flutter-intercept <command>');
    const version = spawnSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' });
    expect(version.stdout.trim()).toMatch(/^flutter-intercept \d+\.\d+\.\d+$/);
    const bad = spawnSync(process.execPath, [bundle, 'test', '--nope'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unknown option --nope');
  });

  it.skipIf(process.platform === 'win32')('dist/action.js (the GitHub Action entry) runs dist/cli.js with the FI_INPUT_* inputs and writes the outputs', () => {
    const action = path.join(root, 'dist', 'action.js');
    expect(fs.statSync(action).size).toBeLessThan(200 * 1024); // loads cli.js at run time, doesn't bundle it
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-action-e2e-')));
    try {
      fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  integration_test:\n    sdk: flutter\n');
      fs.mkdirSync(path.join(dir, 'integration_test'));
      fs.writeFileSync(path.join(dir, 'integration_test', 'app_test.dart'), 'void main() {}\n');
      fs.writeFileSync(path.join(dir, 'expect.json'), JSON.stringify([{ name: 'never', url: 'http://never.test/*', expect: {} }]));
      fs.mkdirSync(path.join(dir, 'sdk', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sdk', 'bin', 'flutter'), '#!/bin/sh\necho "fake flutter $*" > "$FAKE_LOG"\nexit 0\n', { mode: 0o755 });
      const outFile = path.join(dir, 'github_output');
      const r = spawnSync(process.execPath, [action], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          FLUTTER_ROOT: path.join(dir, 'sdk'),
          FAKE_LOG: path.join(dir, 'flutter.log'),
          GITHUB_OUTPUT: outFile,
          FI_INPUT_DEVICE: 'macos',
          FI_INPUT_HAR: 'build/t.har',
          FI_INPUT_ASSERT: 'expect.json',
          FI_INPUT_JUNIT: 'build/j.xml',
          FI_INPUT_FLUTTER_ARGS: '--flavor dev',
        },
      });
      expect(r.status).toBe(1); // the expectation fails → the step fails
      expect(fs.readFileSync(path.join(dir, 'flutter.log'), 'utf8')).toMatch(/^fake flutter test integration_test\/\.flutter_intercept\/\S+_fi\.dart -d macos --flavor dev --dart-define=FLUTTER_INTERCEPT_PROXY=localhost:\d+ /);
      expect(fs.existsSync(path.join(dir, 'build', 't.har'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'build', 'j.xml'), 'utf8')).toContain('failures="1"');
      const outputs = fs.readFileSync(outFile, 'utf8');
      expect(outputs).toMatch(/^exit-code<<(\S+)\n1\n\1$/m);
      expect(outputs).toContain(`${path.join(dir, 'build', 't.har')}\n${path.join(dir, 'build', 'j.xml')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
