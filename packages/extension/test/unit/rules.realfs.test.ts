import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedRulesCore } from '../../src/rules/core';
import { nodeRulesFs } from '../../src/rules/service';
import { FakeMemento, fakeValidateRule, mock } from './rules.fakes';

// service.ts imports vscode; only its node fs adapter is used here
vi.mock('vscode', () => ({}));

let tmp: string;
let ws: string;
let outside: string;
let core: SharedRulesCore;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-rules-')));
  ws = path.join(tmp, 'app');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, 'pubspec.yaml'), 'name: app\n');
  fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":1}');
  core = new SharedRulesCore({ folders: () => [{ name: 'app', path: ws }], fs: nodeRulesFs, validateRule: fakeValidateRule, memento: new FakeMemento() });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fileJson = (rules: unknown[]) => JSON.stringify({ version: 1, rules });

describe('real file system', () => {
  it('reads a body file through a symlink inside the workspace, refuses one pointing outside', async () => {
    fs.writeFileSync(path.join(ws, 'real.json'), '{"ok":true}');
    fs.symlinkSync(path.join(ws, 'real.json'), path.join(ws, 'inside.json'));
    fs.symlinkSync(path.join(outside, 'secret.json'), path.join(ws, 'escape.json'));
    fs.symlinkSync(outside, path.join(ws, 'linkdir'));
    expect(await core.readBodyFile('inside.json', ws)).toBe('{"ok":true}');
    await expect(core.readBodyFile('escape.json', ws)).rejects.toThrow('body file escape.json must be inside the workspace');
    await expect(core.readBodyFile('linkdir/secret.json', ws)).rejects.toThrow('body file linkdir/secret.json must be inside the workspace');
    await expect(core.readBodyFile('../outside/secret.json', ws)).rejects.toThrow('must be inside the workspace');
  });

  it('refuses a shared file that is a symlink to outside the folder', async () => {
    fs.mkdirSync(path.join(ws, '.vscode'));
    fs.writeFileSync(path.join(outside, 'rules.json'), fileJson([mock('a')]));
    fs.symlinkSync(path.join(outside, 'rules.json'), path.join(ws, '.vscode', 'flutter-intercept.json'));
    await core.reload();
    expect(core.state().rules).toEqual([]);
    expect(core.state().problems).toEqual(['.vscode/flutter-intercept.json: points outside the workspace folder (symbolic link); ignored']);
  });

  it('does not write through a .vscode symlink that leaves the folder', async () => {
    fs.symlinkSync(outside, path.join(ws, '.vscode'));
    await core.reload();
    await expect(core.save([mock('a')])).rejects.toThrow('.vscode points outside the workspace folder (symbolic link); not written');
    await expect(core.createBodyFile(mock('a'), '{}')).rejects.toThrow(/points outside the workspace folder/);
    expect(fs.readdirSync(outside).sort()).toEqual(['secret.json']);
  });

  it('writes atomically (no temp files left) and reads back what it wrote', async () => {
    await core.reload();
    await core.save([mock('a'), mock('b')]);
    expect(fs.readdirSync(path.join(ws, '.vscode'))).toEqual(['flutter-intercept.json']);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:a', 'shared:b']);
    const rel = await core.createBodyFile(mock('a', { name: 'Profile' }), '{"x":1}');
    expect(fs.readFileSync(path.join(ws, rel), 'utf8')).toBe('{"x":1}');
    expect(await core.readBodyFile(rel, ws)).toBe('{"x":1}');
  });
});
