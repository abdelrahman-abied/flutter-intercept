import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;

describe('npm package (CONTRACTS §14.1: npm-ready, not published)', () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(root, 'dist', 'cli.js'))) execFileSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, stdio: 'pipe' });
  }, 120_000);

  it('package.json is publishable', () => {
    expect(pkg.name).toBe('flutter-intercept-cli');
    expect(pkg.private).toBeUndefined();
    expect(pkg.license).toBe('MIT');
    expect(pkg.bin).toEqual({ 'flutter-intercept': 'dist/cli.js' });
    expect(pkg.files).toEqual(['dist/cli.js']);
    expect(pkg.engines).toEqual({ node: '>=18' });
    expect(pkg.repository).toMatchObject({ type: 'git', url: 'git+https://github.com/abdelrahman-abied/flutter-intercept.git', directory: 'packages/cli' });
    expect((pkg.scripts as Record<string, string>).prepublishOnly).toMatch(/node build\.mjs/);
    // the bundle is self-contained: nothing to install at run time (the workspace proxy is bundled, and private)
    expect(pkg.dependencies).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8')).toBe(fs.readFileSync(path.join(root, '..', '..', 'LICENSE'), 'utf8'));
  });

  it('npm pack contains only dist/cli.js, README.md, LICENSE and package.json', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const [info] = JSON.parse(out.slice(out.indexOf('['))) as { name: string; files: { path: string; mode: number }[] }[];
    expect(info.name).toBe('flutter-intercept-cli');
    expect(info.files.map((f) => f.path).sort()).toEqual(['LICENSE', 'README.md', 'dist/cli.js', 'package.json']);
    if (process.platform !== 'win32') expect(info.files.find((f) => f.path === 'dist/cli.js')!.mode & 0o111).not.toBe(0);
  }, 60_000);

  it('the bundle carries no source map reference (the map is not published)', () => {
    expect(fs.readFileSync(path.join(root, 'dist', 'cli.js'), 'utf8')).not.toMatch(/sourceMappingURL=/);
  });
});
