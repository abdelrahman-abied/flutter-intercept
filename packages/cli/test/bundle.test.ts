import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
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
});
