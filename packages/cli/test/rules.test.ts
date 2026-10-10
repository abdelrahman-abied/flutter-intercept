import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDefaultRulesFile, loadRules, rulesLocation, unsafeRulesLocation, workspaceRootFor } from '../src/rules';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-cli-rules-')));
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(rel: string, data: unknown) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

const RULES = {
  version: 1,
  rules: [
    { id: 'mock', name: 'Mock user', match: { url: 'https://api.example.com/users/1' }, action: { kind: 'mock', status: 200, body: '{"id":1}' } },
    { id: 'file', name: 'From file', match: { url: 'https://api.example.com/items' }, action: { kind: 'mock', status: 200, bodyFile: '.vscode/flutter-intercept/mocks/items.json' } },
    { id: 'staging', name: 'Staging', match: { url: 'https://api.example.com/*' }, action: { kind: 'mapRemote', to: 'https://staging.example.com' } },
    { id: 'local', name: 'Local backend', match: { url: 'https://api.example.com/v2/*' }, action: { kind: 'mapRemote', to: 'http://localhost:8080' } },
    { id: 'script', name: 'Script', match: { url: 'https://api.example.com/s' }, action: { kind: 'script', code: 'function onRequest(r) { return r; }' } },
    { id: 'pause', name: 'Pause', match: { url: 'https://api.example.com/p' }, action: { kind: 'breakpoint', phase: 'request' } },
    { id: 'bad', match: { url: 'https://api.example.com/x' }, action: { kind: 'mock', status: 99, body: '' } },
  ],
};

describe('loadRules', () => {
  it('skips rules that need approval, with their reasons (scripts always need it)', async () => {
    write('.vscode/flutter-intercept.json', RULES);
    write('.vscode/flutter-intercept/mocks/items.json', '[1,2]');
    const r = await loadRules({ approve: false, projectRoot: dir, cwd: dir });
    expect(r.file).toBe(path.join(dir, '.vscode', 'flutter-intercept.json'));
    expect(r.rules.map((x) => x.name)).toEqual(['Mock user', 'From file', 'Local backend']);
    expect(r.rules.every((x) => x.shared)).toBe(true);
    const items = r.rules[1].action;
    expect(items.kind === 'mock' && items.body).toBe('[1,2]');
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0]).toMatch(/Rule "Staging" .*sends the app's requests to https:\/\/staging\.example\.com/);
    expect(r.skipped[1]).toMatch(/Rule "Script" .*runs JavaScript that can read, change and redirect every matching request/);
    expect(r.approved).toEqual([]);
    expect(r.problems.join('\n')).toMatch(/rule 7/);
    expect(r.problems.join('\n')).toMatch(/Rule "Pause" is off: breakpoints need the editor/);
  });

  it('applies them with --approve-shared-rules', async () => {
    write('.vscode/flutter-intercept.json', RULES);
    write('.vscode/flutter-intercept/mocks/items.json', '[1,2]');
    const r = await loadRules({ approve: true, projectRoot: dir, cwd: dir });
    expect(r.rules.map((x) => x.name)).toEqual(['Mock user', 'From file', 'Staging', 'Local backend', 'Script']);
    expect(r.skipped).toEqual([]);
    expect(r.approved).toHaveLength(2);
  });

  it('a missing body file turns only that rule off', async () => {
    write('.vscode/flutter-intercept.json', RULES);
    const r = await loadRules({ approve: false, projectRoot: dir, cwd: dir });
    expect(r.rules.map((x) => x.name)).toEqual(['Mock user', 'Local backend']);
    expect(r.problems.join('\n')).toMatch(/Rule "From file" is off/);
  });

  it('--no-rules and no file mean no rules', async () => {
    write('.vscode/flutter-intercept.json', RULES);
    expect((await loadRules({ rules: false, approve: true, projectRoot: dir, cwd: dir })).rules).toEqual([]);
    fs.rmSync(path.join(dir, '.vscode'), { recursive: true });
    expect(await loadRules({ approve: false, projectRoot: dir, cwd: dir })).toEqual({ rules: [], skipped: [], approved: [], problems: [] });
  });

  it('reads a custom rules file inside the project; refuses one outside', async () => {
    const custom = write('ci/rules.json', { version: 1, rules: [RULES.rules[0], RULES.rules[2]] });
    const r = await loadRules({ rules: 'ci/rules.json', approve: false, projectRoot: dir, cwd: dir });
    expect(r.file).toBe(custom);
    expect(r.rules.map((x) => x.name)).toEqual(['Mock user']);
    expect(r.skipped).toHaveLength(1);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-cli-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'r.json'), JSON.stringify(RULES));
      const o = await loadRules({ rules: path.join(outside, 'r.json'), approve: true, projectRoot: dir, cwd: dir });
      expect(o.rules).toEqual([]);
      expect(o.problems.join('\n')).toMatch(/outside the workspace folder/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    await expect(loadRules({ rules: 'nope.json', approve: false, projectRoot: dir, cwd: dir })).rejects.toThrow(/rules file nope\.json not found/);
  });

  it('a custom file elsewhere in the repository resolves body files against the repository root', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    const app = path.join(dir, 'apps', 'mobile');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'pubspec.yaml'), 'name: app\n');
    write('ci/mocks/items.json', '[3]');
    write('ci/rules.json', { version: 1, rules: [{ ...RULES.rules[1], action: { kind: 'mock', status: 200, bodyFile: 'ci/mocks/items.json' } }] });
    const r = await loadRules({ rules: path.join(dir, 'ci', 'rules.json'), approve: false, projectRoot: app, cwd: app });
    expect(r.problems).toEqual([]);
    const a = r.rules[0].action;
    expect(a.kind === 'mock' && a.body).toBe('[3]');
    expect(workspaceRootFor(app)).toBe(dir);
  });

  it('reports a broken file', async () => {
    write('.vscode/flutter-intercept.json', '{ "version": 1, "rules": [ ');
    const r = await loadRules({ approve: false, projectRoot: dir, cwd: dir });
    expect(r.rules).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });
});

describe('rules file location', () => {
  it('finds the file in the project or above it, not above the repository', () => {
    const files = new Set(['/repo/.git', '/repo/.vscode/flutter-intercept.json']);
    const exists = (p: string) => files.has(p.split(path.sep).join('/'));
    if (path.sep === '/') {
      expect(findDefaultRulesFile('/repo/apps/mobile', exists)).toBe('/repo/.vscode/flutter-intercept.json');
      files.delete('/repo/.vscode/flutter-intercept.json');
      files.add('/.vscode/flutter-intercept.json');
      expect(findDefaultRulesFile('/repo/apps/mobile', exists)).toBeUndefined();
      // REVIEW-7 #12: outside a git work tree only the project's own file counts (never /tmp/.vscode/…)
      const tmp = new Set(['/tmp/.vscode/flutter-intercept.json']);
      const inTmp = (p: string) => tmp.has(p);
      expect(findDefaultRulesFile('/tmp/build/app', inTmp)).toBeUndefined();
      tmp.add('/tmp/build/app/.vscode/flutter-intercept.json');
      expect(findDefaultRulesFile('/tmp/build/app', inTmp)).toBe('/tmp/build/app/.vscode/flutter-intercept.json');
    }
  });

  it('refuses rules files another user could change (REVIEW-7 #12)', () => {
    const modes: Record<string, { mode: number; uid: number }> = {
      '/w/.vscode/flutter-intercept.json': { mode: 0o100644, uid: 501 },
      '/w/.vscode': { mode: 0o40755, uid: 501 },
      '/w': { mode: 0o40755, uid: 501 },
    };
    const stat = (p: string) => modes[p.split(path.sep).join('/')] ?? { mode: 0o40755, uid: 0 };
    const file = path.join('/w', '.vscode', 'flutter-intercept.json');
    if (path.sep !== '/') return;
    expect(unsafeRulesLocation(file, '/w', stat, 501, 'darwin')).toBeUndefined();
    modes['/w/.vscode'].mode = 0o40777;
    expect(unsafeRulesLocation(file, '/w', stat, 501, 'darwin')).toMatch(/\/w\/\.vscode is writable by every user/);
    modes['/w/.vscode'].mode = 0o40755;
    modes['/w/.vscode/flutter-intercept.json'].uid = 777;
    expect(unsafeRulesLocation(file, '/w', stat, 501, 'darwin')).toMatch(/owned by another user/);
    // running as root (CI containers own nothing of the checkout): only the world-writable check
    expect(unsafeRulesLocation(file, '/w', stat, 0, 'linux')).toBeUndefined();
    expect(unsafeRulesLocation(file, '/w', stat, 501, 'win32')).toBeUndefined();
    // folders above the workspace folder are not checked
    modes['/w/.vscode/flutter-intercept.json'].uid = 501;
    modes['/'] = { mode: 0o41777, uid: 0 };
    expect(unsafeRulesLocation(file, '/w', stat, 501, 'darwin')).toBeUndefined();
  });

  it('loadRules refuses a world-writable rules folder', async () => {
    write('.vscode/flutter-intercept.json', RULES);
    if (process.platform === 'win32') return;
    fs.chmodSync(path.join(dir, '.vscode'), 0o777);
    await expect(loadRules({ approve: false, projectRoot: dir, cwd: dir })).rejects.toThrow(/refusing the rules file .*writable by every user/);
  });

  it('uses the folder of a canonical file, else redirects', () => {
    const canonical = path.join(dir, '.vscode', 'flutter-intercept.json');
    expect(rulesLocation(canonical, '/elsewhere')).toEqual({ folder: dir });
    const custom = path.join(dir, 'ci', 'rules.json');
    expect(rulesLocation(custom, dir)).toEqual({ folder: dir, redirect: { from: canonical, to: custom } });
  });
});
