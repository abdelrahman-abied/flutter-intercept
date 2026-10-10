import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SECTION, applyInstructions, projectRoots, SECTION_END, SECTION_START, summarize, upsertSection,
  type InstructionsFs,
} from '../../src/agent/instructions';
import { READ_TOOLS, WRITE_TOOLS } from '../../src/agent/types';

function fakeFs(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const writes: string[] = [];
  const dirs: string[] = [];
  const fs: InstructionsFs = {
    readFile: (f) => store.get(f),
    writeFile: (f, t) => { store.set(f, t); writes.push(f); },
    mkdirp: (d) => { dirs.push(d); },
  };
  return { fs, store, writes, dirs };
}

const ROOT = path.join(path.sep, 'ws', 'app');
const at = (rel: string) => path.join(ROOT, ...rel.split('/'));

describe('agent section content', () => {
  it('is short, wrapped in markers, and only names real tools', () => {
    const lines = AGENT_SECTION.split('\n');
    expect(lines[0]).toBe(SECTION_START);
    expect(lines.at(-1)).toBe(SECTION_END);
    expect(lines.length).toBeLessThanOrEqual(60);
    const known = new Set<string>([...READ_TOOLS, ...WRITE_TOOLS]);
    const mentioned = [...AGENT_SECTION.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(known, `unknown tool ${name}`).toContain(name);
    for (const must of ['launch_app', 'wait_for_request', 'get_request', 'add_mock', 'remove_rule', 'add_breakpoint',
      'list_paused', 'resume_request', 'clear_requests', 'get_request_source', 'get_body_shape', 'simulate_network', 'resend_request',
      'check_contract', 'add_mutation', 'generate_model', 'generate_fixture_test', 'assert_traffic',
      // CONTRACTS §12.7
      'add_sequence', 'expire_token', 'get_auth_flows', 'save_recording', 'replay_recording', 'diff_recordings', 'add_map_remote', 'add_rewrite']) expect(mentioned).toContain(must);
    expect(AGENT_SECTION).toContain('`times: 1`'); // CONTRACTS §9.5: times/ttlMs cleanup
    expect(AGENT_SECTION).toContain('`ttlMs`');
    expect(AGENT_SECTION).toContain('delayMs');
    expect(AGENT_SECTION).toContain('[redacted]');
    expect(AGENT_SECTION).toMatch(/Release builds are never intercepted/);
    expect(AGENT_SECTION).toContain('[agent]');
  });
});

describe('upsertSection', () => {
  it('creates a missing file with just the section', () => {
    expect(upsertSection(undefined)).toEqual({ text: `${AGENT_SECTION}\n`, action: 'created' });
  });

  it('appends after existing content with one blank line, preserving it', () => {
    const before = '# My agents file\n\nUse pnpm.\n';
    const r = upsertSection(before);
    expect(r.action).toBe('appended');
    expect(r.text).toBe(`${before}\n${AGENT_SECTION}\n`);
    expect(upsertSection('no newline at end').text).toBe(`no newline at end\n\n${AGENT_SECTION}\n`);
    expect(upsertSection('ends with blank\n\n').text).toBe(`ends with blank\n\n${AGENT_SECTION}\n`);
    expect(upsertSection('').text).toBe(`${AGENT_SECTION}\n`);
  });

  it('updates the marked block in place and keeps everything around it byte for byte', () => {
    const old = `${SECTION_START}\nold guidance\n${SECTION_END}`;
    const before = `# Top\n\nintro\n\n${old}\n\n## After\nkeep me\n`;
    const r = upsertSection(before);
    expect(r.action).toBe('updated');
    expect(r.text).toBe(`# Top\n\nintro\n\n${AGENT_SECTION}\n\n## After\nkeep me\n`);
  });

  it('is idempotent', () => {
    const once = upsertSection('# Notes\n').text;
    const twice = upsertSection(once);
    expect(twice).toEqual({ text: once, action: 'unchanged' });
    expect(once.split(SECTION_START)).toHaveLength(2);
  });

  it('preserves CRLF files', () => {
    const before = '# Win\r\nline\r\n';
    const r = upsertSection(before);
    expect(r.text).toBe(`${before}\r\n${AGENT_SECTION.replace(/\n/g, '\r\n')}\r\n`);
    expect(r.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(upsertSection(r.text).action).toBe('unchanged');
  });

  it('refuses to guess with a broken marker pair', () => {
    for (const broken of [`a\n${SECTION_START}\nhalf`, `a\n${SECTION_END}\nb`]) {
      expect(upsertSection(broken)).toEqual({ text: broken, action: 'conflict' });
    }
  });
});

describe('applyInstructions (fake fs)', () => {
  it('creates, appends and updates only the selected files', () => {
    const { fs, store, writes, dirs } = fakeFs({
      [at('CLAUDE.md')]: '# Claude\n',
      [at('AGENTS.md')]: `x\n${SECTION_START}\nold\n${SECTION_END}\ny\n`,
    });
    const res = applyInstructions(ROOT, ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'], fs);
    expect(res.map((r) => r.action)).toEqual(['updated', 'appended', 'created']);
    expect(store.get(at('AGENTS.md'))).toBe(`x\n${AGENT_SECTION}\ny\n`);
    expect(store.get(at('CLAUDE.md'))).toBe(`# Claude\n\n${AGENT_SECTION}\n`);
    expect(store.get(at('.github/copilot-instructions.md'))).toBe(`${AGENT_SECTION}\n`);
    expect(dirs).toEqual([path.join(ROOT, '.github')]);
    expect(writes).toHaveLength(3);
  });

  it('never touches unselected files and does not rewrite unchanged ones', () => {
    const { fs, writes } = fakeFs({ [at('CLAUDE.md')]: 'keep' });
    applyInstructions(ROOT, ['AGENTS.md'], fs);
    expect(writes).toEqual([at('AGENTS.md')]);
    const second = applyInstructions(ROOT, ['AGENTS.md'], fs);
    expect(second[0].action).toBe('unchanged');
    expect(writes).toEqual([at('AGENTS.md')]);
  });

  it('leaves a conflicting file alone', () => {
    const broken = `${SECTION_START}\nno end`;
    const { fs, store, writes } = fakeFs({ [at('AGENTS.md')]: broken });
    expect(applyInstructions(ROOT, ['AGENTS.md'], fs)[0].action).toBe('conflict');
    expect(store.get(at('AGENTS.md'))).toBe(broken);
    expect(writes).toEqual([]);
  });

  it('summarize', () => {
    expect(summarize([
      { target: 'AGENTS.md', file: '', action: 'created' },
      { target: 'CLAUDE.md', file: '', action: 'updated' },
      { target: '.github/copilot-instructions.md', file: '', action: 'unchanged' },
    ])).toBe('Flutter Intercept agent instructions: created AGENTS.md; updated CLAUDE.md; .github/copilot-instructions.md already up to date.');
  });
});

describe('projectRoots', () => {
  it('finds folders with pubspec.yaml at the root or one level down', () => {
    const exists = (p: string) => ['/a/pubspec.yaml', '/b/app/pubspec.yaml'].includes(p.split(path.sep).join('/'));
    const subdirs = (d: string) => (d.endsWith('b') ? ['app', 'docs'] : []);
    expect(projectRoots(['/a', '/b', '/c'].map((p) => path.join(p)), exists, subdirs)).toEqual(['/a', '/b'].map((p) => path.join(p)));
  });
});
