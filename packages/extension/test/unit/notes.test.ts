// CONTRACTS §19.4: `Exchange.notes` reach agents (list_requests / get_request), HAR (`_notes`) and recordings, redacted
// like other free text when redaction is on.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../src/agent/api';
import { buildHar } from '../../src/agent/har';
import type { AppLauncher } from '../../src/agent/types';
import { createRecordingService } from '../../src/recordings/store';
import { validateRecording } from '../../src/recordings/validate';

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJl'].join('.');
const ex = (over: Partial<Exchange> = {}): Exchange => ({
  id: 'n1',
  startedAt: 1_760_000_000_000,
  method: 'GET',
  url: 'https://api.example.com/x',
  requestHeaders: {},
  state: 'completed',
  status: 200,
  notes: ['mutate: no schema for /a.B/C', `token ${JWT} seen`],
  ...over,
});

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('Exchange.notes (CONTRACTS §19.4)', () => {
  it('agents see them in list_requests and get_request, redacted', async () => {
    const host = Object.assign(new EventEmitter(), { running: true, port: 1, getExchanges: () => [ex()], getRules: () => [], resume() {}, abort() {} });
    const api = createAgentApi({
      host: host as unknown as AgentApiDeps['host'],
      applyRules: () => undefined,
      clear: () => undefined,
      getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
      launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
      projectRoot: () => '/ws/app',
    });
    const list = (await api.call('list_requests', {})) as any;
    expect(list.items[0].notes).toEqual(['mutate: no schema for /a.B/C', 'token [redacted] seen']);
    expect(((await api.call('get_request', { id: 'n1' })) as any).notes).toEqual(['mutate: no schema for /a.B/C', 'token [redacted] seen']);
    expect(((await api.call('get_request', { id: 'n1' })) as any)).not.toHaveProperty('error');
  });

  it('HAR carries _notes (redacted on request)', () => {
    expect((buildHar([ex()], { redact: false }) as any).log.entries[0]._notes).toEqual(['mutate: no schema for /a.B/C', `token ${JWT} seen`]);
    expect((buildHar([ex()], { redact: true }) as any).log.entries[0]._notes[1]).toBe('token [redacted] seen');
    expect((buildHar([ex({ notes: undefined })], { redact: false }) as any).log.entries[0]).not.toHaveProperty('_notes');
  });

  it('recordings keep them (redacted when saved redacted) and validate them', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-notes-')));
    roots.push(root);
    const s = createRecordingService({ root: () => root });
    const plain = await s.load((await s.save('p', [ex()])).id);
    expect(plain.entries[0].notes).toEqual(['mutate: no schema for /a.B/C', `token ${JWT} seen`]);
    const red = await s.load((await s.save('r', [ex()], { redact: true })).id);
    expect(red.entries[0].notes?.[1]).toBe('token [redacted] seen');
    const file = JSON.parse(fs.readFileSync(path.join(root, '.dart_tool/flutter_intercept/recordings/p.json'), 'utf8'));
    file.entries[0].notes = ['x'.repeat(301)];
    expect(() => validateRecording(file, 'p', '/p.json')).toThrow(/notes must be at most 20 strings of at most 300 characters/);
  });
});
