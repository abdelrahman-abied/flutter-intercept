import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksLikePath, writeOutput } from '../src/outputs';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-cli-out-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('writeOutput (REVIEW-7 #13)', () => {
  it('writes atomically with the mode, leaving no temp file', () => {
    const file = path.join(dir, 'a', 'b.har');
    writeOutput(file, 'one', 0o600);
    writeOutput(file, 'two', 0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['b.har']);
  });

  it('replaces a planted link instead of writing through it; the old predictable temp name is not used', () => {
    if (process.platform === 'win32') return;
    const victim = path.join(dir, 'victim');
    fs.writeFileSync(victim, 'keep');
    const file = path.join(dir, 'out.har');
    fs.symlinkSync(victim, file);
    fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
    writeOutput(file, 'new');
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });

  it('tells paths from recording names', () => {
    expect(looksLikePath('ci-run')).toBe(false);
    expect(looksLikePath('build/run.json')).toBe(true);
    expect(looksLikePath('run.json')).toBe(true);
  });
});
