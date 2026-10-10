// CONTRACTS §12.7: recordings (save / list / replay / diff), get_auth_flows, add_sequence, expire_token,
// add_map_remote (loopback only), add_rewrite (no credential headers, no [redacted], no body probes while redacted),
// shared rules (list redaction, remove_rule refusal), annotations and confirmations.
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, ReplayEntry, ReplayOptions, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { confirmationText, invocationMessage } from '../../../src/agent/lmTools';
import { toolAnnotations } from '../../../src/agent/mcp/server';
import { redactUrl } from '../../../src/agent/redact';
import { parseToolInput } from '../../../src/agent/schema';
import { AgentToolError, isWriteTool, type AgentAccess, type AppLauncher } from '../../../src/agent/types';
import type { AuthAnalysis } from '../../../src/analysis/types';
import type { Recording, RecordingDiffEntry, RecordingMeta, RecordingService } from '../../../src/recordings/types';
import { validateRules } from '../../../src/ui/controller';

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  replay?: { id?: string; recording: string; fallback: 'passthrough' | 'fail' };
  replayCalls: unknown[][] = [];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  resume() {}
  abort() {}
  setReplay(entries: ReplayEntry[] | undefined, opts?: ReplayOptions, meta?: { id?: string; name: string }) {
    this.replayCalls.push([entries, opts, meta]);
    this.replay = entries ? { ...(meta?.id ? { id: meta.id } : {}), recording: meta!.name, fallback: opts!.fallback } : undefined;
  }
}

let seq = 0;
const ex = (over: Partial<Exchange> = {}): Exchange => ({
  id: `x${++seq}`,
  startedAt: 1000 + seq,
  method: 'GET',
  url: `https://api.example.com/v1/users/${seq}`,
  requestHeaders: { authorization: 'Bearer SECRET_H' },
  state: 'completed',
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: { text: '{"id":1}', encoding: 'utf8' },
  ...over,
});

class FakeRecordings implements RecordingService {
  recs = new Map<string, Recording>();
  saves: { name: string; ids: string[]; redact?: boolean }[] = [];
  diffResult: RecordingDiffEntry[] = [];
  async list(): Promise<RecordingMeta[]> {
    return [...this.recs.values()].map(({ entries: _e, version: _v, ...m }) => m);
  }
  async save(name: string, exchanges: Exchange[], opts?: { redact?: boolean }): Promise<RecordingMeta> {
    this.saves.push({ name, ids: exchanges.map((e) => e.id), redact: opts?.redact });
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const rec: Recording = { id, name, createdAt: 7, exchanges: exchanges.length, path: `/ws/app/.dart_tool/flutter_intercept/recordings/${id}.json`, redacted: !!opts?.redact, version: 1, entries: exchanges };
    this.recs.set(id, rec);
    const { entries: _e, version: _v, ...meta } = rec;
    return meta;
  }
  async load(id: string): Promise<Recording> {
    const r = this.recs.get(id);
    if (!r) throw new Error('ENOENT');
    return r;
  }
  async remove(id: string) {
    this.recs.delete(id);
  }
  async export(_id: string, dest: string) {
    return dest;
  }
  toReplay(rec: Recording): ReplayEntry[] {
    return rec.entries.map((e) => ({ method: e.method, url: e.url, status: e.status ?? 0, headers: e.responseHeaders ?? {} }));
  }
  diff(): RecordingDiffEntry[] {
    return this.diffResult;
  }
  diffText(rec: Recording) {
    return rec.name;
  }
}

function setup(opts: { access?: AgentAccess; redact?: boolean; analyzeAuth?: AgentApiDeps['analyzeAuth']; noServices?: boolean } = {}) {
  const host = new FakeHost();
  const recordings = new FakeRecordings();
  const changed = vi.fn();
  const launcher = { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher;
  let idn = 0;
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: opts.access ?? 'readWrite', redactSecrets: opts.redact ?? true, interceptEnabled: true }),
    launcher,
    projectRoot: () => '/ws/app',
    newRuleId: () => `agent_${++idn}`,
    now: () => 50_000,
    ...(opts.noServices ? {} : { recordings, recordingsChanged: changed, analyzeAuth: opts.analyzeAuth }),
  };
  return { api: createAgentApi(deps), host, recordings, changed };
}

async function rejects(p: Promise<unknown>, code: AgentToolError['code'], re?: RegExp) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AgentToolError);
  expect((err as AgentToolError).code).toBe(code);
  if (re) expect((err as Error).message).toMatch(re);
}

describe('save_recording / list_recordings / replay_recording (CONTRACTS §12.4)', () => {
  it('saves finished HTTP exchanges, redacted by default, filtered by url / sinceMs; path project-relative', async () => {
    const { api, host, recordings, changed } = setup();
    const a = ex();
    const b = ex({ url: 'https://cdn.example.com/x.png' });
    // CONTRACTS §14.5: finished WebSocket / SSE streams are recorded since 0.8.0 (see api.v080.test.ts); tunnels never.
    host.exchanges = [a, b, ex({ kind: 'websocket', state: 'pending' }), ex({ kind: 'tunnel', method: 'CONNECT' }), ex({ captured: 'vm-profile' }), ex({ state: 'pending', status: undefined }), ex({ browserInternal: true })];
    const r = (await api.call('save_recording', { name: 'Happy path' })) as any;
    expect(r).toEqual({ id: 'happy-path', name: 'Happy path', exchanges: 2, redacted: true, path: '.dart_tool/flutter_intercept/recordings/happy-path.json' });
    expect(recordings.saves[0]).toEqual({ name: 'Happy path', ids: [a.id, b.id], redact: true });
    expect(changed).toHaveBeenCalledTimes(1);
    await api.call('save_recording', { name: 'api only', url: 'https://api.example.com/*', redact: false });
    expect(recordings.saves[1]).toEqual({ name: 'api only', ids: [a.id], redact: false });
    await rejects(api.call('save_recording', { name: 'none', sinceMs: 999_999 }), 'not_found', /no finished HTTP request/);
    await rejects(api.call('save_recording', { name: '  ' }), 'invalid');
  });

  it('the url filter sees the redacted URL (no oracle on redacted query values)', async () => {
    const { api, host } = setup();
    host.exchanges = [ex({ url: 'https://api.example.com/x?access_token=abc' })];
    await rejects(api.call('save_recording', { name: 'p', url: '*access_token=abc*' }), 'not_found');
    await expect(api.call('save_recording', { name: 'p', url: '*access_token=*' })).resolves.toMatchObject({ exchanges: 1 });
  });

  it('list_recordings shows the list and what is replayed; replay_recording starts and stops', async () => {
    const { api, host, changed } = setup();
    host.exchanges = [ex()];
    await api.call('save_recording', { name: 'Demo' });
    const started = (await api.call('replay_recording', { id: 'demo', fallback: 'fail' })) as any;
    expect(started).toEqual({ replaying: true, id: 'demo', name: 'Demo', entries: 1, fallback: 'fail', note: expect.stringMatching(/redacted/) });
    expect(host.replayCalls[0][1]).toEqual({ fallback: 'fail', matchTemplates: true });
    expect(await api.call('list_recordings', {})).toEqual({
      recordings: [{ id: 'demo', name: 'Demo', createdAt: 7, exchanges: 1, redacted: true }],
      replaying: { id: 'demo', name: 'Demo', fallback: 'fail' },
    });
    expect(await api.call('get_status', {})).toMatchObject({ replaying: { id: 'demo', name: 'Demo', fallback: 'fail' } });
    expect(await api.call('replay_recording', {})).toEqual({ replaying: false, stopped: 'Demo' });
    expect(host.replay).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(3);
    await rejects(api.call('replay_recording', { id: 'nope' }), 'not_found', /no recording "nope"/);
    await rejects(api.call('replay_recording', { id: 'demo', fallback: 'maybe' }), 'invalid');
  });

  it('read-only access may list but not save or replay; without the service the tools say so', async () => {
    const ro = setup({ access: 'readOnly' });
    await expect(ro.api.call('list_recordings', {})).resolves.toEqual({ recordings: [] });
    await rejects(ro.api.call('save_recording', { name: 'x' }), 'access');
    await rejects(ro.api.call('replay_recording', {}), 'access');
    const none = setup({ noServices: true });
    await rejects(none.api.call('list_recordings', {}), 'state', /not available/);
  });
});

describe('diff_recordings (CONTRACTS §12.5)', () => {
  it('returns entries with details redacted, whatever the setting, and caps them', async () => {
    const { api, host, recordings } = setup({ redact: false });
    host.exchanges = [ex()];
    await api.call('save_recording', { name: 'Before' });
    await api.call('save_recording', { name: 'After' });
    recordings.diffResult = [
      { route: 'GET /users/{id}', change: 'status', detail: '200 → 500' },
      { route: 'GET /login', change: 'body', detail: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXg changed at https://a.dev/cb?token=SECRETCODE1234' },
      ...Array.from({ length: 250 }, (_, i) => ({ route: `GET /r${i}`, change: 'count' as const, detail: '1 → 2 calls' })),
    ];
    const r = (await api.call('diff_recordings', { a: 'before', b: 'after' })) as any;
    expect(r.a).toEqual({ id: 'before', name: 'Before', exchanges: 1 });
    expect(r.entries).toHaveLength(200);
    expect(r.total).toBe(252);
    expect(r.more).toBe(52);
    expect(r.entries[0]).toEqual({ route: 'GET /users/{id}', change: 'status', detail: '200 → 500' });
    expect(r.entries[1].detail).not.toMatch(/eyJ|SECRETCODE/);
    await rejects(api.call('diff_recordings', { a: 'before', b: 'before' }), 'invalid', /two different/);
    await rejects(api.call('diff_recordings', { a: 'before', b: 'zzz' }), 'not_found');
    expect(toolAnnotations('diff_recordings')).toMatchObject({ readOnlyHint: true });
  });
});

describe('get_auth_flows (CONTRACTS §12.3)', () => {
  it('enriches steps with method, redacted URL and status', async () => {
    const seen: number[] = [];
    const analyze = (list: Exchange[]): AuthAnalysis => {
      seen.push(list.length);
      return { flows: [{ steps: [{ exchangeId: list[0].id, role: 'unauthorized', at: 1 }, { exchangeId: 'gone', role: 'refresh', at: 2 }], stampede: { refreshCalls: 3, windowMs: 2000 }, problem: 'retry got 401 at https://a.dev/x?token=abc' }] };
    };
    const { api, host } = setup({ analyzeAuth: analyze });
    const u = ex({ status: 401, url: 'https://api.example.com/me?access_token=abc' });
    host.exchanges = [u, ex({ browserInternal: true })];
    const r = (await api.call('get_auth_flows', {})) as any;
    expect(seen).toEqual([1]);
    expect(r.total).toBe(1);
    expect(r.flows[0].steps[0]).toEqual({ exchangeId: u.id, role: 'unauthorized', at: 1, method: 'GET', url: redactUrl(u.url), status: 401 });
    expect(r.flows[0].steps[0].url).not.toContain('abc');
    expect(r.flows[0].steps[1]).toEqual({ exchangeId: 'gone', role: 'refresh', at: 2 });
    expect(r.flows[0].stampede).toEqual({ refreshCalls: 3, windowMs: 2000 });
    expect(r.flows[0].problem).not.toContain('abc');
  });
  it('sinceMs filters, an empty result says how to provoke one, no analyzer → state error', async () => {
    const { api, host } = setup({ analyzeAuth: () => ({ flows: [] }) });
    host.exchanges = [ex()];
    expect(await api.call('get_auth_flows', { sinceMs: 1 })).toEqual({ flows: [], total: 0, note: expect.stringMatching(/expire_token/) });
    await rejects(setup().api.call('get_auth_flows', {}), 'state');
  });
});

describe('add_sequence / expire_token (CONTRACTS §12.3)', () => {
  it('add_sequence builds validated steps, inserted first', async () => {
    const { api, host } = setup();
    host.rules = [{ id: 'old', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    const r = (await api.call('add_sequence', {
      url: 'https://api.example.com/v1/feed*',
      method: 'get',
      steps: [{ kind: 'mock', status: 500, body: { error: 'x' }, count: 2 }, { kind: 'block', mode: 'reset' }, { kind: 'fault', fault: 'timeout' }, { kind: 'throttle', latencyMs: 300 }, { kind: 'passthrough' }],
      then: 'loop',
    })) as any;
    expect(r.ruleId).toBe('agent_1');
    expect(host.rules.map((x) => x.id)).toEqual(['agent_1', 'old']);
    const rule = host.rules[0];
    expect(rule.name).toBe('[agent] sequence get https://api.example.com/v1/feed*: 500×2 → block → fault → throttle → passthrough');
    expect(rule.match).toEqual({ url: 'https://api.example.com/v1/feed*', method: 'GET' });
    expect(rule.action).toEqual({
      kind: 'sequence',
      then: 'loop',
      steps: [
        { action: { kind: 'mock', status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"x"}' }, count: 2 },
        { action: { kind: 'block', mode: 'reset' } },
        { action: { kind: 'fault', fault: 'timeout' } },
        { action: { kind: 'throttle', latencyMs: 300 } },
        { action: { kind: 'passthrough' } },
      ],
    });
  });
  it('add_sequence input limits', async () => {
    const { api } = setup();
    await rejects(api.call('add_sequence', { url: 'https://a.dev/*', steps: [] }), 'invalid');
    await rejects(api.call('add_sequence', { url: 'https://a.dev/*', steps: Array.from({ length: 51 }, () => ({ kind: 'passthrough' })) }), 'invalid');
    await rejects(api.call('add_sequence', { url: 'https://a.dev/*', steps: [{ kind: 'breakpoint' }] }), 'invalid');
    await rejects(api.call('add_sequence', { url: 'https://a.dev/*', steps: [{ kind: 'mock', count: 1001 }] }), 'invalid');
    await rejects(api.call('add_sequence', { url: '/a.dev/', steps: [{ kind: 'passthrough' }] }), 'invalid', /globs/);
    await rejects(api.call('add_sequence', { url: '*access_token=abc*', steps: [{ kind: 'passthrough' }] }), 'invalid', /access_token/);
  });
  it('expire_token: 401 × count, then the real server; default count 1', async () => {
    const { api, host } = setup();
    const r = (await api.call('expire_token', { url: 'https://api.example.com/v1/*', count: 2 })) as any;
    expect(r).toEqual({ ruleId: 'agent_1', count: 2, match: 'https://api.example.com/v1/*' });
    const rule = host.rules[0];
    expect(rule.name).toBe('[agent] Expire token: https://api.example.com/v1/*');
    expect(rule.action).toMatchObject({ kind: 'sequence', then: 'last', steps: [{ action: { kind: 'mock', status: 401, body: '{"error":"token_expired"}' }, count: 2 }, { action: { kind: 'passthrough' } }] });
    await api.call('expire_token', { url: 'https://api.example.com/v1/me' });
    expect(host.rules[0].match.url).toBe('https://api.example.com/v1/me*');
    expect((host.rules[0].action as any).steps[0].count).toBe(1);
    await rejects(api.call('expire_token', { url: 'https://a.dev/*', count: 0 }), 'invalid');
  });
});

describe('add_map_remote (CONTRACTS §12.7: loopback only)', () => {
  it.each(['http://localhost:8080', 'http://127.0.0.1:3000/api/v2', 'http://[::1]:9000/', 'https://LOCALHOST:8443', 'http://127.1:5000'])('maps to %s', async (to) => {
    const { api, host } = setup();
    await api.call('add_map_remote', { url: 'https://api.example.com/v1/*', to, method: 'post' });
    expect(host.rules[0].action).toEqual({ kind: 'mapRemote', to });
    expect(host.rules[0].match).toEqual({ url: 'https://api.example.com/v1/*', method: 'POST' });
    expect(host.rules[0].name).toMatch(/^\[agent\] map post https:\/\/api\.example\.com\/v1\/\* → https?:\/\//);
  });
  it.each([
    ['https://staging.example.com', /local server/],
    ['http://localhost.evil.dev:80', /local server/],
    ['http://127.0.0.2:80', /local server/],
    ['http://10.0.2.2:8080', /local server/],
    ['http://user:pw@localhost:8080', /user info/],
    ['http://localhost:8080/#x', /fragment/],
    ['http://localhost\\@evil.dev/', /backslash|user info/],
    ['localhost:8080', /absolute|http/],
    ['file:///etc/passwd', /http\(s\)/],
  ])('refuses to=%s', async (to, re) => {
    await rejects(setup().api.call('add_map_remote', { url: 'https://api.example.com/*', to }), 'invalid', re);
  });
  it('refuses match-all urls', async () => {
    await rejects(setup().api.call('add_map_remote', { url: '*', to: 'http://localhost:1' }), 'invalid', /with a host/);
  });
});

describe('add_rewrite (CONTRACTS §12.7)', () => {
  it('adds request/response header and status changes', async () => {
    const { api, host } = setup();
    await api.call('add_rewrite', {
      url: 'https://api.example.com/*',
      request: { setHeaders: { 'x-feature-flags': 'new-checkout' }, removeHeaders: ['authorization'] },
      response: { status: 503, setHeaders: { 'retry-after': '5' } },
      times: 2,
    });
    expect(host.rules[0]).toMatchObject({
      name: '[agent] rewrite * https://api.example.com/*',
      times: 2,
      action: { kind: 'rewrite', request: { setHeaders: { 'x-feature-flags': 'new-checkout' }, removeHeaders: ['authorization'] }, response: { status: 503, setHeaders: { 'retry-after': '5' } } },
    });
  });
  it.each(['Authorization', 'cookie', 'X-Api-Key', 'x-session-id', 'X-Auth-Token', 'proxy-authorization'])('refuses setting request header %s', async (name) => {
    await rejects(setup().api.call('add_rewrite', { url: 'https://a.dev/*', request: { setHeaders: { [name]: 'v' } } }), 'invalid', /carries credentials/);
  });
  it('refuses [redacted] values, body find/replace while redacted, empty changes, no host, framing headers', async () => {
    const { api } = setup();
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', response: { setHeaders: { 'x-a': '[redacted]' } } }), 'invalid', /placeholder/);
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', response: { replaceBody: [{ find: '"token":"a', replace: 'x' }] } }), 'invalid', /add_mutation/);
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', request: { replaceBody: [{ find: 'a', replace: 'b' }] } }), 'invalid', /request\.replaceBody is not available/);
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*' }), 'invalid', /request and\/or response/);
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', request: {} }), 'invalid', /request and\/or response/);
    await rejects(api.call('add_rewrite', { url: '*', response: { status: 500 } }), 'invalid', /with a host/);
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', request: { setHeaders: { host: 'evil.dev' } } }), 'invalid', /agents can't set "host"/);
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', request: { setHeaders: { 'content-length': '1' } } }), 'invalid', /can't be set/);
  });
  it('allows body find/replace when the user turned redaction off (still no [redacted])', async () => {
    const { api, host } = setup({ redact: false });
    await api.call('add_rewrite', { url: 'https://a.dev/*', response: { replaceBody: [{ find: '"premium":false', replace: '"premium":true', all: true }] } });
    expect((host.rules[0].action as any).response.replaceBody).toEqual([{ find: '"premium":false', replace: '"premium":true', all: true }]);
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', response: { replaceBody: [{ find: 'x', replace: '[redacted]' }] } }), 'invalid', /placeholder/);
  });
});

describe('shared rules and rule views (CONTRACTS §12.1, §12.7)', () => {
  const shared: Rule = {
    id: 's1',
    enabled: true,
    shared: true,
    match: { url: 'https://api.example.com/*' },
    action: { kind: 'rewrite', request: { setHeaders: { Authorization: 'Bearer team-staging-token-123', 'x-env': 'staging' } } },
  };
  it('list_rules redacts credential headers and map targets; off when redaction is off', async () => {
    const { api, host } = setup();
    host.rules = [
      shared,
      { id: 'm', enabled: true, match: { url: '*' }, action: { kind: 'mapRemote', to: 'https://staging.example.com/?api_key=abc' } },
      { id: 'q', enabled: true, match: { url: '*' }, action: { kind: 'sequence', steps: [{ action: { kind: 'mock', status: 200, body: '', headers: { 'set-cookie': 'sid=1' } } }] } },
    ];
    const r = (await api.call('list_rules', {})) as { rules: any[] };
    expect(r.rules[0].action.request.setHeaders).toEqual({ Authorization: '[redacted]', 'x-env': 'staging' });
    expect(r.rules[0].shared).toBe(true);
    expect(r.rules[1].action.to).toBe(redactUrl('https://staging.example.com/?api_key=abc'));
    expect(r.rules[1].action.to).not.toContain('abc');
    expect(r.rules[2].action.steps[0].action.headers).toEqual({ 'set-cookie': '[redacted]' });
    expect(host.rules[0]).toBe(shared); // never mutated
    const open = setup({ redact: false });
    open.host.rules = [shared];
    expect(((await open.api.call('list_rules', {})) as any).rules[0]).toBe(shared);
  });
  it('remove_rule refuses shared rules; agent rules still go first after them', async () => {
    const { api, host } = setup();
    host.rules = [shared];
    await rejects(api.call('remove_rule', { ruleId: 's1' }), 'invalid', /shared rule/);
    expect(await api.call('get_status', {})).toMatchObject({ sharedRules: 1 });
  });
});

describe('annotations, messages, confirmations (CONTRACTS §12.7)', () => {
  it('read and write tools', () => {
    for (const t of ['list_recordings', 'diff_recordings', 'get_auth_flows'] as const) {
      expect(isWriteTool(t)).toBe(false);
      expect(toolAnnotations(t)).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    for (const t of ['save_recording', 'add_sequence', 'expire_token', 'add_rewrite'] as const) {
      expect(isWriteTool(t)).toBe(true);
      expect(toolAnnotations(t)).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    }
    // REVIEW-6 #12
    expect(toolAnnotations('replay_recording')).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(toolAnnotations('add_map_remote')).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(toolAnnotations('replay_recording').idempotentHint).toBe(true);
    expect(toolAnnotations('expire_token').idempotentHint).toBe(false);
  });
  it('confirmations name the targets', () => {
    expect(confirmationText('add_map_remote', { url: 'https://api.example.com/*', to: 'http://localhost:8080' }).message).toMatch(/`http:\/\/localhost:8080`.*including credentials/s);
    expect(confirmationText('expire_token', { url: 'https://api.example.com/*', count: 3 }).message).toMatch(/next \*\*3\*\* request\(s\) matching `https:\/\/api\.example\.com\/\*` get \*\*401\*\*/);
    expect(confirmationText('add_sequence', { url: 'https://a.dev/*', steps: [{ kind: 'mock', status: 500, count: 2 }, { kind: 'passthrough' }] }).message).toMatch(/mock \*\*500\*\* ×2, then the real server; the last step keeps answering/);
    expect(confirmationText('add_rewrite', { url: 'https://a.dev/*', request: { setHeaders: { 'x-env': 'staging' } }, response: { status: 503 } }).message).toMatch(/Request: set `x-env`: `staging`\. Response: status → \*\*503\*\*/);
    expect(confirmationText('save_recording', { name: 'p', redact: false }).message).toMatch(/with secrets unredacted/);
    expect(confirmationText('save_recording', { name: 'p' }).message).toMatch(/secrets redacted/);
    expect(confirmationText('replay_recording', { id: 'demo', fallback: 'fail' }).message).toMatch(/`demo`.*fail like offline/s);
    expect(confirmationText('replay_recording', {}).title).toBe('Stop replaying');
    expect(invocationMessage('diff_recordings', { a: 'x', b: 'y' })).toBe('Comparing recordings x and y');
    expect(invocationMessage('add_map_remote', { url: 'https://a.dev/*', to: 'http://localhost:1' })).toBe('Mapping https://a.dev/* to http://localhost:1');
  });
  it('schema defaults: save_recording redacts, replay falls back to passthrough, expire_token count 1', () => {
    expect(parseToolInput('save_recording', { name: 'x' })).toEqual({ name: 'x', redact: true });
    expect(parseToolInput('replay_recording', {})).toEqual({ fallback: 'passthrough' });
    expect(parseToolInput('expire_token', { url: 'https://a.dev/*' })).toEqual({ url: 'https://a.dev/*', count: 1 });
    expect(() => parseToolInput('add_rewrite', { url: 'https://a.dev/*', request: { status: 200 } })).toThrow();
  });
});

describe('REVIEW-6 #4: agent mocks and rewrites can not redirect, inject or poison', () => {
  it.each(['Location', 'refresh', 'Set-Cookie', 'content-security-policy', 'Content-Security-Policy-Report-Only', 'Access-Control-Allow-Origin', 'x-forwarded-host', 'X-Forwarded-Proto', 'forwarded', 'X-Original-URL', 'x-http-method-override'])(
    'add_rewrite refuses setting %s (request and response)',
    async (name) => {
      const { api } = setup({ redact: false });
      await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', response: { setHeaders: { [name]: 'https://evil.example/' } } }), 'invalid', /agents can't set/);
      if (!/cookie/i.test(name)) await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', request: { setHeaders: { [name]: 'evil.example' } } }), 'invalid', /agents can't set/);
    },
  );
  it('add_rewrite refuses an HTML / JavaScript content-type and markup in replacements; removing headers is fine', async () => {
    const { api, host } = setup({ redact: false });
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', response: { setHeaders: { 'Content-Type': 'text/html; charset=utf-8' } } }), 'invalid', /browser would run it/);
    await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', response: { setHeaders: { 'content-type': 'application/javascript' } } }), 'invalid', /browser would run it/);
    for (const replace of ['<script>x()</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '< iframe src=x>']) {
      await rejects(api.call('add_rewrite', { url: 'https://a.dev/*', response: { replaceBody: [{ find: '</body>', replace }] } }), 'invalid', /markup or script/);
    }
    await api.call('add_rewrite', { url: 'https://a.dev/*', response: { removeHeaders: ['location', 'set-cookie'], setHeaders: { 'content-type': 'application/json' } } });
    expect(host.rules).toHaveLength(1);
  });

  it.each([
    ['https://api.example.com/v1/*', 302, { location: '/login' }],
    ['https://api.example.com/v1/*', 301, { Location: 'https://api.example.com/v2/x' }],
    ['https://api.example.com/v1/*', 307, { location: 'http://localhost:8080/cb' }],
    ['*/v1/*', 302, { location: 'http://127.0.0.1:3000/' }],
    ['*/v1/*', 302, { location: 'relative/path' }],
    ['https://api.example.com/*', 304, {}],
    ['https://api.example.com/*', 200, { location: 'https://evil.example/' }],
  ])('add_mock allows %s %i %j', async (url, status, headers) => {
    const { api, host } = setup();
    await api.call('add_mock', { url, status, headers, body: '' });
    expect(host.rules).toHaveLength(1);
  });

  it.each([
    ['https://api.example.com/v1/*', { location: 'https://evil.example/collect' }],
    ['https://api.example.com/v1/*', { location: '//evil.example/x' }],
    ['https://api.example.com/v1/*', { location: '/\\evil.example/x' }],
    ['https://api.example.com/v1/*', { location: 'http://api.example.com/v1/' }], // other scheme = other origin
    ['https://*.example.com/*', { location: 'https://api.example.com/' }], // no literal origin to compare with
    ['https://api.example.com/*', { location: 'javascript:alert(1)' }],
  ])('add_mock refuses a 302 for %s to %j', async (url, headers) => {
    await rejects(setup().api.call('add_mock', { url, status: 302, headers, body: '' }), 'invalid', /redirect|not a valid URL/);
  });

  it('add_mock refuses HTML / JavaScript / SVG content (typed or untyped HTML bodies)', async () => {
    const { api } = setup();
    await rejects(api.call('add_mock', { url: 'https://accounts.example.com/*', headers: { 'content-type': 'text/html' }, body: 'hi' }), 'invalid', /browser would run it/);
    await rejects(api.call('add_mock', { url: 'https://a.dev/app.js', headers: { 'Content-Type': 'text/javascript' }, body: 'x()' }), 'invalid', /browser would run it/);
    await rejects(api.call('add_mock', { url: 'https://a.dev/i.svg', headers: { 'content-type': 'image/svg+xml' }, body: '<svg/>' }), 'invalid', /browser would run it/);
    await rejects(api.call('add_mock', { url: 'https://a.dev/*', body: '  <!DOCTYPE html><html></html>' }), 'invalid', /looks like HTML/);
    await expect(api.call('add_mock', { url: 'https://a.dev/*', headers: { 'content-type': 'text/plain' }, body: '<html>' })).resolves.toMatchObject({ ruleId: expect.any(String) });
  });

  it('add_sequence applies the same limits to mock steps', async () => {
    const { api } = setup();
    await rejects(
      api.call('add_sequence', { url: 'https://api.example.com/*', steps: [{ kind: 'passthrough' }, { kind: 'mock', status: 302, headers: { location: 'https://evil.example/' } }] }),
      'invalid',
      /step 2.*redirect/,
    );
    await rejects(api.call('add_sequence', { url: 'https://a.dev/*', steps: [{ kind: 'mock', body: '<html><script></script></html>' }] }), 'invalid', /step 1.*HTML/);
  });

  it('expire_token is unchanged', async () => {
    const { api, host } = setup();
    await api.call('expire_token', { url: 'https://api.example.com/*' });
    expect(host.rules).toHaveLength(1);
  });
});

describe('REVIEW-6 #1: get_status shows the upstream proxy (host:port only)', () => {
  it('upstreamProxy and upstreamProxyInsecure', async () => {
    const { api, host } = setup();
    expect(await api.call('get_status', {})).not.toHaveProperty('upstreamProxy');
    (host as any).upstreamProxyInfo = { display: 'proxy.corp:3128', ignoreCertErrors: false };
    const r = (await api.call('get_status', {})) as any;
    expect(r.upstreamProxy).toBe('proxy.corp:3128');
    expect(r).not.toHaveProperty('upstreamProxyInsecure');
    (host as any).upstreamProxyInfo = { display: '127.0.0.1:8888', ignoreCertErrors: true };
    expect(await api.call('get_status', {})).toMatchObject({ upstreamProxy: '127.0.0.1:8888', upstreamProxyInsecure: true });
  });
});
