import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule, SendRequest } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
import { AGENT_RULE_PREFIX, createAgentApi, restoreRedactedHeaders, restoreRedactedQuery, type AgentApiDeps, type ResolvedFrame } from '../../../src/agent/api';
import { buildHar } from '../../../src/agent/har';
import { REDACTED } from '../../../src/agent/redact';
import { AgentAccess, AgentToolError, type AppLauncher, type ToolName } from '../../../src/agent/types';
import { validateRules } from '../../../src/ui/controller';

const tmpRoots: string[] = [];
afterAll(() => tmpRoots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  resumed: unknown[] = [];
  aborted: string[] = [];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  resume(id: string, edit?: unknown) {
    this.resumed.push([id, edit]);
  }
  abort(id: string) {
    this.aborted.push(id);
  }
  sent: SendRequest[] = [];
  async send(req: SendRequest) {
    this.sent.push(req);
    if (req.url.includes('unreachable')) throw new Error('ECONNREFUSED');
    const id = `sent${this.sent.length}`;
    this.exchanges.push({ id, startedAt: Date.now(), method: req.method, url: req.url, requestHeaders: req.headers ?? {}, state: 'pending', initiator: req.initiator, resentFrom: req.resentFrom });
    return { id };
  }
  networkProfile: NetworkProfile = { kind: 'none' };
  setNetworkProfile(p: NetworkProfile) {
    this.networkProfile = p;
  }
  push(e: Exchange) {
    const i = this.exchanges.findIndex((x) => x.id === e.id);
    if (i >= 0) this.exchanges[i] = e;
    else this.exchanges.push(e);
    this.emit('exchange', { ...e });
  }
}

let seq = 0;
const ex = (over: Partial<Exchange> = {}): Exchange => ({
  id: `e${++seq}`,
  startedAt: 1000 + seq,
  method: 'GET',
  url: `https://api.example.com/v1/items/${seq}?page=1&access_token=SECRET1`,
  requestHeaders: { authorization: 'Bearer SECRET2', accept: 'application/json' },
  state: 'completed',
  status: 200,
  durationMs: 12,
  responseHeaders: { 'content-type': 'application/json', 'set-cookie': ['sid=SECRET3', 'x=1'] },
  responseBody: { text: '{"id":12345678901234567890,"token":"SECRET4","name":"Ann"}', encoding: 'utf8' },
  ...over,
});

function setup(opts: { access?: AgentAccess; redact?: boolean; now?: number; root?: string | null; extra?: Partial<AgentApiDeps> } = {}) {
  const host = new FakeHost();
  let access: AgentAccess = opts.access ?? 'readWrite';
  let redact = opts.redact ?? true;
  const applied: Rule[][] = [];
  let cleared = 0;
  const launcher: AppLauncher = {
    launch: vi.fn(async () => ({ sessionId: 's1' })),
    stop: vi.fn(async () => ({ stopped: 1 })),
    hotRestart: vi.fn(async () => ({ restarted: 1 })),
    sessions: () => [{ id: 's1', deviceId: 'emulator-5554', program: '/app/lib/main.dart', mode: 'debug' }],
  };
  let root: string | undefined;
  if (opts.root !== null) {
    root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fi-agent-'));
    tmpRoots.push(root);
  }
  let idn = 0;
  const deps: AgentApiDeps = {
    host,
    applyRules: (rules) => {
      host.rules = validateRules(rules); // the real controller validates too
      applied.push(host.rules);
    },
    clear: () => {
      cleared++;
      host.exchanges = host.exchanges.filter((e) => e.state === 'pending' || e.state.startsWith('paused'));
    },
    getSettings: () => ({ access, redactSecrets: redact, interceptEnabled: true }),
    launcher,
    projectRoot: () => root,
    version: '0.2.0',
    newRuleId: () => `agent_${++idn}`,
    now: () => opts.now ?? Date.now(),
    ...opts.extra,
  };
  const api = createAgentApi(deps);
  return { api, host, launcher, applied, cleared: () => cleared, root, setAccess: (a: AgentAccess) => (access = a), setRedact: (r: boolean) => (redact = r) };
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

describe('access gating', () => {
  it('off: nothing works', async () => {
    const { api } = setup({ access: 'off' });
    await rejects(api.call('get_status', {}), 'access', /access is off/);
    await rejects(api.call('add_mock', { url: '*', body: 'x' }), 'access');
  });

  it('readOnly: read tools work, write tools are refused with a clear error', async () => {
    const { api, host } = setup({ access: 'readOnly' });
    host.push(ex());
    await expect(api.call('list_requests', {})).resolves.toMatchObject({ total: 1 });
    for (const t of ['add_mock', 'add_block', 'add_breakpoint', 'remove_rule', 'resume_request', 'abort_request', 'clear_requests', 'launch_app', 'stop_app', 'hot_restart', 'simulate_network', 'resend_request'] as ToolName[]) {
      await rejects(api.call(t, { url: '*', body: 'x', ruleId: 'r', id: 'x' }), 'access', /read-only/);
    }
    expect(host.rules).toEqual([]);
  });

  it('access is live (setting changes apply to the next call)', async () => {
    const t = setup();
    expect(t.api.access).toBe('readWrite');
    t.setAccess('off');
    await rejects(t.api.call('list_rules', {}), 'access');
  });

  it('invalid input → invalid tool error, never thrown raw; onDidCall fires with ok', async () => {
    const { api } = setup();
    const calls: unknown[] = [];
    const sub = api.onDidCall((e) => calls.push(e));
    await rejects(api.call('get_request', {}), 'invalid', /id/);
    await api.call('get_status', {});
    expect(calls).toMatchObject([{ tool: 'get_request', ok: false }, { tool: 'get_status', ok: true }]);
    sub.dispose();
    await api.call('get_status', {});
    expect(calls).toHaveLength(2);
  });

  it('unexpected exceptions become internal tool errors', async () => {
    const { api, host } = setup();
    host.getExchanges = () => {
      throw new Error('boom');
    };
    await rejects(api.call('list_requests', {}), 'internal', /list_requests failed: boom/);
  });
});

describe('read tools', () => {
  it('get_status', async () => {
    const { api, host } = setup();
    host.push(ex());
    host.push(ex({ state: 'paused-response' }));
    expect(await api.call('get_status', {})).toEqual({
      proxyRunning: true,
      port: 8899,
      interceptEnabled: true,
      sessions: [{ id: 's1', deviceId: 'emulator-5554', program: '/app/lib/main.dart', mode: 'debug' }],
      pausedCount: 1,
      exchangeCount: 2,
      agentAccess: 'readWrite',
      networkProfile: { kind: 'none', label: 'No throttling' },
    });
  });

  it('list_requests: filters, newest first, limit, total, redacted URLs, summary fields', async () => {
    const { api, host } = setup();
    const a = ex({ url: 'https://api.example.com/users/1?token=T', startedAt: 10 });
    const b = ex({ url: 'https://api.example.com/users/2', startedAt: 30, method: 'POST', status: 201 });
    const c = ex({ url: 'https://cdn.example.com/x.png', startedAt: 20, status: 404 });
    const d = ex({ url: 'https://api.example.com/fail', startedAt: 40, state: 'error', status: undefined, responseBody: undefined });
    [a, b, c, d].forEach((e) => host.push(e));
    const all = (await api.call('list_requests', {})) as { items: { id: string }[]; total: number };
    expect(all.items.map((i) => i.id)).toEqual([d.id, b.id, c.id, a.id]);
    expect(((await api.call('list_requests', { url: 'https://api.example.com/users/*' })) as { total: number }).total).toBe(2);
    // REVIEW-4 #2: globs only
    await rejects(api.call('list_requests', { url: '/users\\/\\d$/' }), 'invalid', /globs .*regex\/ patterns are not accepted/);
    await rejects(api.call('list_requests', { url: '*'.repeat(17) }), 'invalid', /at most 16/);
    expect(((await api.call('list_requests', { method: 'post' })) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([b.id]);
    expect(((await api.call('list_requests', { status: '4xx' })) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([c.id]);
    expect(((await api.call('list_requests', { status: 201 })) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([b.id]);
    expect(((await api.call('list_requests', { status: 'error' })) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([d.id]);
    expect(((await api.call('list_requests', { sinceMs: 25 })) as { total: number }).total).toBe(2);
    expect(((await api.call('list_requests', { state: 'error' })) as { total: number }).total).toBe(1);
    const lim = (await api.call('list_requests', { limit: 1 })) as { items: unknown[]; total: number };
    expect(lim.items).toHaveLength(1);
    expect(lim.total).toBe(4);
    const first = all.items.find((i) => i.id === a.id) as Record<string, unknown>;
    expect(first).toEqual({ id: a.id, method: 'GET', url: `https://api.example.com/users/1?token=${REDACTED}`, status: 200, state: 'completed', durationMs: 12, startedAt: 10, responseBytes: Buffer.byteLength(a.responseBody!.text), });
  });

  it('get_request: redacted headers/bodies, big ints preserved, body cap, binary summary, not_found', async () => {
    const { api, host, setRedact } = setup();
    const e = ex({ requestBody: { text: 'grant_type=password&password=hunter2', encoding: 'utf8' }, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer X' } });
    host.push(e);
    const r = (await api.call('get_request', { id: e.id })) as Record<string, any>;
    expect(r.url).toContain(`access_token=${REDACTED}`);
    expect(r.requestHeaders.authorization).toBe(REDACTED);
    expect(r.responseHeaders['set-cookie']).toEqual([REDACTED, REDACTED]);
    expect(r.requestBody.text).toBe(`grant_type=password&password=${REDACTED}`);
    expect(r.responseBody.text).toBe(`{"id":12345678901234567890,"token":"${REDACTED}","name":"Ann"}`);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|hunter2/);

    const capped = (await api.call('get_request', { id: e.id, maxBodyChars: 10 })) as Record<string, any>;
    expect(capped.responseBody).toMatchObject({ text: '{"id":1234', truncated: true });
    const noBodies = (await api.call('get_request', { id: e.id, includeBodies: false })) as Record<string, unknown>;
    expect(noBodies.responseBody).toBeUndefined();

    const bin = ex({ responseBody: { text: Buffer.alloc(300).toString('base64'), encoding: 'base64' } });
    host.push(bin);
    expect(((await api.call('get_request', { id: bin.id })) as Record<string, any>).responseBody).toEqual({ text: '[binary 300 bytes]', binary: true, bytes: 300 });

    setRedact(false);
    expect(JSON.stringify(await api.call('get_request', { id: e.id }))).toContain('SECRET4');
    await rejects(api.call('get_request', { id: 'nope' }), 'not_found');
  });

  it('list_paused and list_rules', async () => {
    const { api, host } = setup();
    const p = ex({ state: 'paused-request', pausedAt: 5, pauseDeadline: 300005 });
    host.push(ex());
    host.push(p);
    expect(await api.call('list_paused', {})).toMatchObject({ items: [{ id: p.id, phase: 'request', pausedAt: 5, pauseDeadline: 300005 }] });
    host.rules = [{ id: 'r', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    expect(await api.call('list_rules', {})).toEqual({ rules: host.rules });
  });
});

describe('wait_for_request', () => {
  it('resolves on a matching exchange that reaches a final state after the call (event-driven, no polling)', async () => {
    const { api, host } = setup();
    const getSpy = vi.spyOn(host, 'getExchanges');
    const p = api.call('wait_for_request', { url: 'https://api.example.com/login*', method: 'POST', timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 10));
    const login = ex({ url: 'https://api.example.com/login', method: 'POST', state: 'pending', status: undefined, startedAt: Date.now() });
    host.push(login); // pending: not final yet
    host.push(ex({ url: 'https://api.example.com/other', startedAt: Date.now() })); // no match
    host.push({ ...login, state: 'completed', status: 200 });
    const r = (await p) as Record<string, unknown>;
    expect(r).toMatchObject({ timedOut: false, id: login.id, status: 200, state: 'completed' });
    expect(r.responseBody).toBeUndefined(); // includeBodies defaults to false
    expect(getSpy).toHaveBeenCalledTimes(1); // one scan at call time, then events only
    expect(host.listenerCount('exchange')).toBe(0);
  });

  it('returns an already-recorded matching exchange that finished after sinceMs (oldest first)', async () => {
    const { api, host } = setup();
    host.push(ex({ url: 'https://a/x', startedAt: 100 }));
    const hit1 = ex({ url: 'https://a/x', startedAt: 200 });
    const hit2 = ex({ url: 'https://a/x', startedAt: 300 });
    host.push(hit2);
    host.push(hit1);
    const r = (await api.call('wait_for_request', { url: 'https://a/x', sinceMs: 150, includeBodies: true })) as Record<string, any>;
    expect(r.id).toBe(hit1.id);
    expect(r.responseBody.text).toContain(REDACTED);
  });

  it('"now" ignores exchanges that started before the call', async () => {
    const { api, host } = setup();
    host.push(ex({ url: 'https://a/x', startedAt: Date.now() - 10_000 }));
    expect(await api.call('wait_for_request', { url: 'https://a/x', timeoutMs: 50 })).toMatchObject({ timedOut: true, waitedMs: 50 });
  });

  it('status filter and error states count as final', async () => {
    const { api, host } = setup();
    const p = api.call('wait_for_request', { url: 'https://a/*', status: 'error', timeoutMs: 2000 });
    host.push(ex({ url: 'https://a/ok', startedAt: Date.now() + 1 }));
    const bad = ex({ url: 'https://a/bad', state: 'error', status: undefined, error: 'ECONNREFUSED', startedAt: Date.now() + 1 });
    host.push(bad);
    expect(await p).toMatchObject({ id: bad.id, state: 'error', error: 'ECONNREFUSED' });
  });

  it('times out with {timedOut:true} and never hangs; unsubscribes', async () => {
    const { api, host } = setup();
    const t0 = Date.now();
    expect(await api.call('wait_for_request', { url: 'https://never/*', timeoutMs: 80 })).toMatchObject({ timedOut: true, waitedMs: 80 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(host.listenerCount('exchange')).toBe(0);
  });

  it('honours AbortSignal (before and during), unsubscribes', async () => {
    const { api, host } = setup();
    const ac = new AbortController();
    const p = api.call('wait_for_request', { url: 'https://never/*', timeoutMs: 60_000 }, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(host.listenerCount('exchange')).toBe(1);
    ac.abort();
    await rejects(p, 'state', /cancelled/);
    expect(host.listenerCount('exchange')).toBe(0);
    await rejects(api.call('wait_for_request', { url: '*' }, AbortSignal.abort()), 'state', /cancelled/);
  });
});

describe('write tools', () => {
  it('add_mock: validated, inserted FIRST, "[agent] " prefix, JSON body + content-type default', async () => {
    const { api, host, applied } = setup();
    host.rules = [{ id: 'user', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    const r = await api.call('add_mock', { url: 'https://api.example.com/users*', method: 'get', status: 500, body: { error: 'boom' }, delayMs: 100 });
    expect(r).toEqual({ ruleId: 'agent_1' });
    expect(host.rules.map((x) => x.id)).toEqual(['agent_1', 'user']);
    expect(host.rules[0]).toEqual({
      id: 'agent_1',
      enabled: true,
      name: `${AGENT_RULE_PREFIX}mock get https://api.example.com/users* → 500`,
      match: { url: 'https://api.example.com/users*', method: 'GET' },
      action: { kind: 'mock', status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"boom"}', delayMs: 100 },
    });
    await api.call('add_mock', { url: '*', body: 'plain', name: 'my mock', headers: { 'Content-Type': 'text/plain' } });
    expect(host.rules[0]).toMatchObject({ name: '[agent] my mock', action: { body: 'plain', headers: { 'Content-Type': 'text/plain' } } });
    await api.call('add_mock', { url: '*', body: 'x', name: '[agent] already' });
    expect(host.rules[0].name).toBe('[agent] already');
    expect(applied).toHaveLength(3);
  });

  it('add_mock rejected by host validation (bad header) → invalid, nothing applied', async () => {
    const { api, applied } = setup();
    await rejects(api.call('add_mock', { url: '*', body: 'x', headers: { 'bad header': 'v' } }), 'invalid', /header name/);
    expect(applied).toEqual([]);
  });

  it('add_block / add_breakpoint defaults', async () => {
    const { api, host } = setup();
    await api.call('add_block', { url: 'https://ads/*' });
    expect(host.rules[0]).toMatchObject({ name: '[agent] block * https://ads/*', action: { kind: 'block', mode: 'status', status: 403 } });
    await api.call('add_block', { url: 'https://x/*', mode: 'reset' });
    expect(host.rules[0].action).toEqual({ kind: 'block', mode: 'reset' });
    await api.call('add_breakpoint', { url: 'https://x/*', method: 'POST' });
    expect(host.rules[0]).toMatchObject({ match: { method: 'POST' }, action: { kind: 'breakpoint', phase: 'response' } });
  });

  it('remove_rule', async () => {
    const { api, host } = setup();
    const { ruleId } = (await api.call('add_block', { url: '*' })) as { ruleId: string };
    expect(await api.call('remove_rule', { ruleId: 'nope' })).toEqual({ removed: false });
    expect(await api.call('remove_rule', { ruleId })).toEqual({ removed: true });
    expect(host.rules).toEqual([]);
  });

  it('resume_request: phase-aware edit validation; not paused → state error', async () => {
    const { api, host } = setup();
    const p = ex({ state: 'paused-response' });
    host.push(p);
    await rejects(api.call('resume_request', { id: p.id, edit: { url: 'https://other/' } }), 'invalid', /url/);
    await rejects(api.call('resume_request', { id: p.id, edit: { headers: { 'x-a': 'a\r\nb' } } }), 'invalid');
    expect(await api.call('resume_request', { id: p.id, edit: { status: 503, body: '{"down":true}' } })).toEqual({ resumed: true });
    expect(host.resumed).toEqual([[p.id, { status: 503, body: '{"down":true}' }]]);
    const done = ex();
    host.push(done);
    await rejects(api.call('resume_request', { id: done.id }), 'state', /not paused/);
    await rejects(api.call('resume_request', { id: 'nope' }), 'not_found');
  });

  it('abort_request', async () => {
    const { api, host } = setup();
    const p = ex({ state: 'paused-request' });
    host.push(p);
    expect(await api.call('abort_request', { id: p.id })).toEqual({ aborted: true });
    expect(host.aborted).toEqual([p.id]);
    await rejects(api.call('abort_request', { id: 'nope' }), 'not_found');
  });

  it('clear_requests counts what was cleared (in-flight kept) via the controller', async () => {
    const { api, host, cleared } = setup();
    host.push(ex());
    host.push(ex());
    host.push(ex({ state: 'paused-request' }));
    expect(await api.call('clear_requests', {})).toEqual({ cleared: 2 });
    expect(cleared()).toBe(1);
    expect(host.exchanges).toHaveLength(1);
  });

  it('launch_app / stop_app / hot_restart go to the launcher', async () => {
    const { api, launcher } = setup();
    expect(await api.call('launch_app', { deviceId: 'emulator-5554', program: 'lib/main_dev.dart' })).toMatchObject({ sessionId: 's1', sinceMs: expect.any(Number) });
    expect(launcher.launch).toHaveBeenCalledWith({ deviceId: 'emulator-5554', program: 'lib/main_dev.dart', flutterMode: 'debug' });
    expect(await api.call('stop_app', {})).toEqual({ stopped: 1 });
    expect(launcher.stop).toHaveBeenCalledWith(undefined);
    expect(await api.call('hot_restart', { sessionId: 's1' })).toMatchObject({ restarted: 1, sinceMs: expect.any(Number) });
    expect(launcher.hotRestart).toHaveBeenCalledWith('s1');
  });
});

describe('export_har', () => {
  it('writes a redacted HAR 1.2 under .dart_tool/flutter_intercept/exports and filters', async () => {
    const { api, host, root } = setup({ now: Date.UTC(2026, 9, 9, 12, 0, 0) });
    host.push(ex({ url: 'https://api.example.com/a?token=Q', requestBody: { text: '{"password":"P","n":1}', encoding: 'utf8' }, requestHeaders: { 'content-type': 'application/json', cookie: 'c=1' }, method: 'POST' }));
    host.push(ex({ url: 'https://cdn.example.com/img.png', responseHeaders: { 'content-type': 'image/png' }, responseBody: { text: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64' } }));
    const r = (await api.call('export_har', { url: 'https://api.example.com/*' })) as { path: string; entries: number; redacted: boolean };
    expect(r.entries).toBe(1);
    expect(r.redacted).toBe(true);
    expect(r.path).toBe(path.join(root!, '.dart_tool', 'flutter_intercept', 'exports', '2026-10-09T12-00-00-000Z.har'));
    const har = JSON.parse(fs.readFileSync(r.path, 'utf8'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'Flutter Intercept', version: '0.2.0' });
    const e = har.log.entries[0];
    expect(e.request.url).toBe(`https://api.example.com/a?token=${REDACTED}`);
    expect(e.request.queryString).toEqual([{ name: 'token', value: REDACTED }]);
    expect(e.request.headers).toContainEqual({ name: 'cookie', value: REDACTED });
    expect(e.request.postData).toEqual({ mimeType: 'application/json', text: `{"password":"${REDACTED}","n":1}` });
    expect(e.response.headers).toContainEqual({ name: 'set-cookie', value: REDACTED });
    expect(e.response.content.text).toBe(`{"id":12345678901234567890,"token":"${REDACTED}","name":"Ann"}`);
    expect(fs.readFileSync(r.path, 'utf8')).not.toMatch(/SECRET|"P"/);
    // second export in the same millisecond gets a distinct name
    const r2 = (await api.call('export_har', {})) as { path: string; entries: number };
    expect(r2.path).not.toBe(r.path);
    expect(r2.entries).toBe(2);
  });

  it('no workspace → state error', async () => {
    const { api } = setup({ root: null });
    await rejects(api.call('export_har', {}), 'state', /workspace/);
  });

  it('buildHar unredacted keeps values; binary bodies stay base64 with encoding', () => {
    const e = ex({ responseBody: { text: Buffer.from([0xff, 0]).toString('base64'), encoding: 'base64', truncated: true } });
    const har = buildHar([e], { redact: false }) as { log: { entries: Record<string, any>[] } };
    const entry = har.log.entries[0];
    expect(entry.request.headers).toContainEqual({ name: 'authorization', value: 'Bearer SECRET2' });
    expect(entry.response.content).toMatchObject({ size: 2, encoding: 'base64', comment: expect.stringMatching(/truncated/) });
    expect(entry.startedDateTime).toBe(new Date(e.startedAt).toISOString());
    expect(entry._state).toBe('completed');
  });
});

describe('wait_for_request after launch_app / hot_restart (no race)', () => {
  function clocked() {
    let now = 1_000_000;
    const t = setup({ now: 0 });
    // replace the clock: setup() fixes `now`; drive it by hand here
    (t.api as unknown as { deps: AgentApiDeps }).deps.now = () => now;
    return { ...t, tick: (ms: number) => (now += ms), at: () => now };
  }

  it('hot_restart returns sinceMs captured BEFORE the restart; a request sent before wait_for_request is matched', async () => {
    const t = clocked();
    let restartRequest: Exchange | undefined;
    (t.launcher.hotRestart as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      t.tick(300); // the restart takes a moment …
      restartRequest = ex({ url: 'https://api.example.com/config', startedAt: t.at() }); // … and the app already sent its request
      t.host.push(restartRequest);
      t.tick(200);
      return { restarted: 1 };
    });
    const before = t.at();
    const r = (await t.api.call('hot_restart', {})) as { restarted: number; sinceMs: number };
    expect(r).toEqual({ restarted: 1, sinceMs: before });
    t.tick(2_000); // the agent takes a while before waiting
    const w = (await t.api.call('wait_for_request', { url: 'https://api.example.com/config*', timeoutMs: 50 })) as Record<string, unknown>;
    expect(w).toMatchObject({ timedOut: false, id: restartRequest!.id, sinceMs: before });
  });

  it('launch_app sets the default the same way', async () => {
    const t = clocked();
    const before = t.at();
    expect(await t.api.call('launch_app', {})).toEqual({ sessionId: 's1', sinceMs: before });
    t.tick(5_000);
    const early = ex({ url: 'https://a/boot', startedAt: before + 1_000 });
    t.host.push(early);
    expect(await t.api.call('wait_for_request', { url: 'https://a/boot', timeoutMs: 50 })).toMatchObject({ id: early.id, sinceMs: before });
  });

  it('after the 120 s window the default is "now" again', async () => {
    const t = clocked();
    await t.api.call('hot_restart', {});
    const old = ex({ url: 'https://a/x', startedAt: t.at() + 10 });
    t.host.push(old);
    t.tick(120_001);
    const w = (await t.api.call('wait_for_request', { url: 'https://a/x', timeoutMs: 30 })) as Record<string, unknown>;
    expect(w).toEqual({ timedOut: true, waitedMs: 30, sinceMs: t.at() });
  });

  it('exactly at 120 s it still applies', async () => {
    const t = clocked();
    const before = t.at();
    await t.api.call('hot_restart', {});
    const e = ex({ url: 'https://a/y', startedAt: before + 5 });
    t.host.push(e);
    t.tick(120_000);
    expect(await t.api.call('wait_for_request', { url: 'https://a/y', timeoutMs: 30 })).toMatchObject({ id: e.id, sinceMs: before });
  });

  it('explicit "now" or a number overrides the trigger default', async () => {
    const t = clocked();
    await t.api.call('hot_restart', {});
    const e = ex({ url: 'https://a/z', startedAt: t.at() + 10 });
    t.host.push(e);
    t.tick(1_000);
    expect(await t.api.call('wait_for_request', { url: 'https://a/z', sinceMs: 'now', timeoutMs: 30 })).toEqual({ timedOut: true, waitedMs: 30, sinceMs: t.at() });
    expect(await t.api.call('wait_for_request', { url: 'https://a/z', sinceMs: e.startedAt + 1, timeoutMs: 30 })).toMatchObject({ timedOut: true, sinceMs: e.startedAt + 1 });
    expect(await t.api.call('wait_for_request', { url: 'https://a/z', sinceMs: 0, timeoutMs: 30 })).toMatchObject({ id: e.id, sinceMs: 0 });
  });

  it('a failed restart does not move the default', async () => {
    const t = clocked();
    (t.launcher.hotRestart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no session'));
    await rejects(t.api.call('hot_restart', {}), 'internal', /no session/);
    t.tick(10);
    const w = (await t.api.call('wait_for_request', { url: 'https://n/*', timeoutMs: 20 })) as Record<string, unknown>;
    expect(w.sinceMs).toBe(t.at());
  });

  it('stop_app does not count as a trigger', async () => {
    const t = clocked();
    expect(await t.api.call('stop_app', {})).toEqual({ stopped: 1 });
    const w = (await t.api.call('wait_for_request', { url: 'https://n/*', timeoutMs: 20 })) as Record<string, unknown>;
    expect(w.sinceMs).toBe(t.at());
  });
});

describe('v0.3.0: times / ttlMs on rule tools (CONTRACTS §9.5)', () => {
  it('add_mock / add_block / add_breakpoint pass times and expiresAt = now + ttlMs', async () => {
    const { api, host } = setup({ now: 1_000_000 });
    await api.call('add_mock', { url: '*/a', body: 'x', times: 1 });
    await api.call('add_block', { url: '*/b', ttlMs: 60_000 });
    await api.call('add_breakpoint', { url: '*/c', times: 3, ttlMs: 1000 });
    expect(host.rules.map((r) => [r.match.url, r.times, r.expiresAt])).toEqual([
      ['*/c', 3, 1_001_000],
      ['*/b', undefined, 1_060_000],
      ['*/a', 1, undefined],
    ]);
    await rejects(api.call('add_mock', { url: '*', body: 'x', times: 0 }), 'invalid', /times/);
    await rejects(api.call('add_mock', { url: '*', body: 'x', ttlMs: 999 }), 'invalid', /ttlMs/);
  });
});

describe('get_request snippet (from the redacted view)', () => {
  it('curl / dart_http / dio never contain secrets', async () => {
    const { api, host } = setup();
    const e = ex({ method: 'POST', requestHeaders: { authorization: 'Bearer SECRET2', 'content-type': 'application/json' }, requestBody: { text: '{"password":"SECRET5","user":"ann"}', encoding: 'utf8' } });
    host.push(e);
    for (const snippet of ['curl', 'dart_http', 'dio']) {
      const r = (await api.call('get_request', { id: e.id, snippet })) as { snippet: string };
      expect(r.snippet, snippet).toContain('api.example.com/v1/items');
      expect(r.snippet, snippet).toContain(REDACTED);
      expect(r.snippet, snippet).not.toMatch(/SECRET/);
      expect(r.snippet, snippet).toContain('ann');
    }
    expect(((await api.call('get_request', { id: e.id, snippet: 'curl' })) as { snippet: string }).snippet).toMatch(/^curl /);
    expect(await api.call('get_request', { id: e.id })).not.toHaveProperty('snippet');
    await rejects(api.call('get_request', { id: e.id, snippet: 'wget' }), 'invalid', /snippet/);
  });
});

describe('get_request_source', () => {
  const frames = [
    { fn: '_InterceptedHttpClient.openUrl', uri: 'package:flutter_intercept_entry/entry.dart', line: 10 },
    { fn: 'DioMixin.fetch', uri: 'package:dio/src/dio_mixin.dart', line: 400, column: 3 },
    { fn: 'UserApi.load', uri: 'package:demo_app/api/user_api.dart', line: 42, column: 18, afterAsyncGap: true },
    { fn: 'main', uri: 'file:///proj/lib/main.dart', line: 7, column: 3 },
  ];
  const resolveFrames = (fs: typeof frames): ResolvedFrame[] =>
    fs.map((f) =>
      f.uri.startsWith('package:demo_app/')
        ? { ...f, path: path.join(path.sep, 'proj', 'lib', 'api', 'user_api.dart'), inProject: true }
        : f.uri.startsWith('file:///proj/')
          ? { ...f, path: path.join(path.sep, 'proj', 'lib', 'main.dart'), inProject: true }
          : f.uri.startsWith('package:dio/')
            ? { ...f, path: path.join(path.sep, 'home', 'me', '.pub-cache', 'dio', 'dio_mixin.dart'), inProject: false }
            : { ...f, inProject: false },
    );

  it('returns the app frame with a project-relative path and every frame', async () => {
    const { api, host } = setup({ root: path.join(path.sep, 'proj'), extra: { resolveFrames } });
    const e = ex({ source: { frames, appFrame: 2 } });
    host.push(e);
    const r = (await api.call('get_request_source', { id: e.id })) as Record<string, any>;
    expect(r.available).toBe(true);
    expect(r.appFrame).toEqual({ fn: 'UserApi.load', uri: 'package:demo_app/api/user_api.dart', path: 'lib/api/user_api.dart', line: 42, column: 18 });
    expect(r.appFrameIndex).toBe(2);
    expect(r.totalFrames).toBe(4);
    expect(r.frames[1]).toEqual({ fn: 'DioMixin.fetch', uri: 'package:dio/src/dio_mixin.dart', line: 400, column: 3, inProject: false }); // no absolute path outside the project
    expect(r.frames[2]).toMatchObject({ inProject: true, afterAsyncGap: true });
    expect(r.frames[3]).toMatchObject({ uri: '<project>/lib/main.dart', path: 'lib/main.dart' });
    expect(JSON.stringify(r)).not.toContain('.pub-cache');
    expect(JSON.stringify(r)).not.toContain('file:');
    // maxFrames trims frames but never loses the app frame
    const short = (await api.call('get_request_source', { id: e.id, maxFrames: 1 })) as Record<string, any>;
    expect(short.frames).toHaveLength(1);
    expect(short.appFrame.path).toBe('lib/api/user_api.dart');
  });

  it('never returns absolute file: URIs or paths outside the project (REVIEW-3 #4)', async () => {
    const { api, host } = setup({ root: path.join(path.sep, 'proj') }); // no resolver
    const e = ex({
      source: {
        frames: [
          { fn: 'main', uri: 'file:///Users/alice/secret-client/bin/main.dart', line: 3 },
          { fn: 'inProj', uri: 'file:///proj/bin/tool.dart', line: 4 },
          { fn: 'weird', uri: 'http://evil.example/x.dart' },
          { fn: 'unc', uri: 'file://evil.example/share/x.dart' },
          { fn: 'escape', uri: 'file:///proj/../etc/passwd' },
          { fn: 'sdk', uri: 'dart:async/zone.dart' },
          { fn: 'pkg', uri: 'package:http/src/client.dart', line: 9 },
        ],
        appFrame: 0,
      },
    });
    host.push(e);
    const r = (await api.call('get_request_source', { id: e.id })) as Record<string, any>;
    expect(r.appFrame).toEqual({ fn: 'main', uri: '<outside project>', line: 3 });
    expect(r.frames.map((f: any) => [f.uri, f.path])).toEqual([
      ['<outside project>', undefined],
      ['<project>/bin/tool.dart', 'bin/tool.dart'],
      ['<outside project>', undefined],
      ['<outside project>', undefined],
      ['<outside project>', undefined],
      ['dart:async/zone.dart', undefined],
      ['package:http/src/client.dart', undefined],
    ]);
    const text = JSON.stringify(r);
    for (const leak of ['alice', 'secret-client', 'evil.example', 'passwd', 'file:']) expect(text).not.toContain(leak);
  });

  it('a resolver path outside the project (relative "..") is dropped too', async () => {
    const { api, host } = setup({ root: path.join(path.sep, 'proj'), extra: { resolveFrames: (fs) => fs.map((f) => ({ ...f, path: '../other/x.dart', inProject: false })) } });
    const e = ex({ source: { frames: [{ fn: 'f', uri: 'file:///other/x.dart' }], appFrame: 0 } });
    host.push(e);
    expect(((await api.call('get_request_source', { id: e.id })) as any).appFrame).toEqual({ fn: 'f', uri: '<outside project>' });
  });

  it('works without a resolver (raw frames) and when the resolver throws', async () => {
    const { api, host } = setup({ extra: { resolveFrames: () => Promise.reject(new Error('boom')) } });
    const e = ex({ source: { frames, appFrame: 2 } });
    host.push(e);
    const r = (await api.call('get_request_source', { id: e.id })) as Record<string, any>;
    expect(r.appFrame).toEqual({ fn: 'UserApi.load', uri: 'package:demo_app/api/user_api.dart', line: 42, column: 18 });
    expect(r.frames[0]).not.toHaveProperty('inProject');
  });

  it('explains when there is no source', async () => {
    const { api, host } = setup();
    const plain = ex();
    const sent = ex({ initiator: 'agent' });
    [plain, sent].forEach((e) => host.push(e));
    expect(await api.call('get_request_source', { id: plain.id })).toMatchObject({ available: false, reason: expect.stringMatching(/no stack trace/) });
    expect(await api.call('get_request_source', { id: sent.id })).toMatchObject({ available: false, reason: expect.stringMatching(/sent by an agent/) });
    await rejects(api.call('get_request_source', { id: 'nope' }), 'not_found');
  });
});

describe('get_body_shape', () => {
  it('describes the response JSON without values', async () => {
    const { api, host } = setup();
    const e = ex({ responseBody: { text: JSON.stringify({ users: [{ id: 1, token: 'SECRET9', email: null }, { id: 2, token: 'x', email: 'a@b' }], total: 2 }), encoding: 'utf8' } });
    host.push(e);
    const r = (await api.call('get_body_shape', { id: e.id })) as Record<string, any>;
    expect(r).toEqual({
      contentType: 'application/json',
      bytes: expect.any(Number),
      shape: { users: { '[]': { id: 'integer', token: 'string', email: 'string|null' }, length: 2 }, total: 'integer' },
    });
    expect(JSON.stringify(r)).not.toContain('SECRET9');
  });

  it('request body, binary, missing, pending and non-JSON bodies', async () => {
    const { api, host } = setup();
    const req = ex({ method: 'POST', requestHeaders: { 'content-type': 'application/json' }, requestBody: { text: '{"a":[1,2]}', encoding: 'utf8' } });
    const bin = ex({ responseBody: { text: 'AAEC', encoding: 'base64' }, responseHeaders: { 'content-type': 'image/png' } });
    const pending = ex({ state: 'pending', status: undefined, responseBody: undefined, responseHeaders: undefined });
    const html = ex({ responseBody: { text: '<html>', encoding: 'utf8' }, responseHeaders: { 'content-type': 'text/html' } });
    [req, bin, pending, html].forEach((e) => host.push(e));
    expect(await api.call('get_body_shape', { id: req.id, which: 'request' })).toMatchObject({ contentType: 'application/json', shape: { a: { '[]': 'integer', length: 2 } } });
    expect(await api.call('get_body_shape', { id: bin.id })).toEqual({ contentType: 'image/png', bytes: 3, shape: null, reason: 'the response body is binary' });
    expect(await api.call('get_body_shape', { id: pending.id })).toMatchObject({ shape: null, reason: expect.stringMatching(/not arrived yet/) });
    expect(await api.call('get_body_shape', { id: html.id })).toMatchObject({ shape: null, reason: 'the body is not JSON' });
  });

  it('maxDepth limits nesting', async () => {
    const { api, host } = setup();
    const e = ex({ responseBody: { text: '{"a":{"b":{"c":1}}}', encoding: 'utf8' } });
    host.push(e);
    expect(await api.call('get_body_shape', { id: e.id, maxDepth: 1 })).toMatchObject({ shape: { a: '{…}' }, truncated: true });
  });
});

describe('simulate_network', () => {
  it('global profiles: presets, custom, offline, none; get_status reports it', async () => {
    const { api, host } = setup();
    expect(await api.call('simulate_network', { profile: 'slow-3g' })).toEqual({ profile: { kind: 'throttle', preset: 'slow-3g', latencyMs: 400, kbps: 400, label: 'Slow 3G' } });
    expect(host.networkProfile).toEqual({ kind: 'throttle', preset: 'slow-3g', latencyMs: 400, kbps: 400 });
    expect(await api.call('get_status', {})).toMatchObject({ networkProfile: { kind: 'throttle', label: 'Slow 3G' } });
    await api.call('simulate_network', { profile: 'custom', latencyMs: 300, kbps: 800 });
    expect(host.networkProfile).toEqual({ kind: 'throttle', latencyMs: 300, kbps: 800 });
    await api.call('simulate_network', { profile: 'offline' });
    expect(host.networkProfile).toEqual({ kind: 'offline' });
    await api.call('simulate_network', { profile: 'none' });
    expect(host.networkProfile).toEqual({ kind: 'none' });
    expect(host.rules).toEqual([]);
  });

  it('url-scoped: throttle or fault rule inserted FIRST with [agent] name, times/ttlMs', async () => {
    const { api, host } = setup({ now: 5000 });
    host.rules = [{ id: 'old', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    const a = (await api.call('simulate_network', { url: '*/users*', profile: 'flaky' })) as { ruleId: string };
    expect(host.rules[0]).toMatchObject({ id: a.ruleId, match: { url: '*/users*' }, action: { kind: 'throttle', latencyMs: 200, dropRate: 0.2 } });
    expect(host.rules[0].name).toBe(`${AGENT_RULE_PREFIX}Flaky (20% fail) * */users*`);
    await api.call('simulate_network', { url: '*/login', method: 'post', fault: 'timeout', times: 1, ttlMs: 10_000, name: 'login timeout' });
    expect(host.rules[0]).toMatchObject({ name: '[agent] login timeout', match: { url: '*/login', method: 'POST' }, action: { kind: 'fault', fault: 'timeout' }, times: 1, expiresAt: 15_000 });
    await api.call('simulate_network', { url: '*/x', profile: 'offline' });
    expect(host.rules[0].action).toEqual({ kind: 'fault', fault: 'dns' });
    await api.call('simulate_network', { url: '*/y', profile: 'custom', kbps: 56 });
    expect(host.rules[0].action).toEqual({ kind: 'throttle', kbps: 56 });
    expect(host.rules.at(-1)!.id).toBe('old');
    expect(host.networkProfile).toEqual({ kind: 'none' });
  });

  it.each([
    [{}, /profile is required/],
    [{ profile: 'slow-3g', fault: 'reset', url: '*' }, /either profile or fault/],
    [{ fault: 'reset' }, /fault needs a url/],
    [{ profile: 'slow-3g', latencyMs: 10 }, /only used with profile "custom"/],
    [{ profile: 'custom' }, /needs latencyMs/],
    [{ profile: 'offline', times: 1 }, /only apply together with a url/],
    [{ profile: 'none', url: '*' }, /changes nothing/],
    [{ profile: 'warp' }, /profile/],
    [{ profile: 'custom', dropRate: 2 }, /dropRate/],
    [{ url: '*', fault: 'explode' }, /fault/],
  ])('rejects %j', async (input, re) => {
    const { api, host } = setup();
    await rejects(api.call('simulate_network', input), 'invalid', re);
    expect(host.rules).toEqual([]);
    expect(host.networkProfile).toEqual({ kind: 'none' });
  });
});

describe('resend_request', () => {
  it('resends with the original (unredacted) headers and body as the agent', async () => {
    const { api, host } = setup({ now: 777 });
    const e = ex({
      method: 'POST',
      url: 'https://api.example.com/v1/login?access_token=SECRET1',
      requestHeaders: { authorization: 'Bearer SECRET2', 'content-type': 'application/json', 'content-length': '20', host: 'api.example.com', 'proxy-authorization': 'Basic LAN' },
      requestBody: { text: '{"password":"SECRET5"}', encoding: 'utf8' },
    });
    host.push(e);
    const r = await api.call('resend_request', { id: e.id });
    expect(r).toEqual({ id: 'sent1', sinceMs: 777 });
    expect(host.sent[0]).toEqual({
      method: 'POST',
      url: 'https://api.example.com/v1/login?access_token=SECRET1',
      headers: { authorization: 'Bearer SECRET2', 'content-type': 'application/json' },
      body: '{"password":"SECRET5"}',
      initiator: 'agent',
      resentFrom: e.id,
    });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('edits: [redacted] header and query values are restored from the original', async () => {
    const { api, host } = setup();
    const e = ex({ url: 'https://api.example.com/v1/items?page=1&access_token=SECRET1' });
    host.push(e);
    await api.call('resend_request', {
      id: e.id,
      edit: { method: 'put', url: 'https://api.example.com/v1/items?page=2&access_token=[redacted]', headers: { Authorization: '[redacted]', accept: 'text/plain', cookie: '[redacted]' }, body: 'new' },
    });
    expect(host.sent[0]).toMatchObject({
      method: 'PUT',
      url: 'https://api.example.com/v1/items?page=2&access_token=SECRET1',
      headers: { Authorization: 'Bearer SECRET2', accept: 'text/plain' },
      body: 'new',
    });
  });

  it('same origin only: path/query edits allowed, scheme/host/port/userinfo changes refused (REVIEW-3 #1)', async () => {
    const { api, host } = setup();
    const e = ex({ url: 'https://api.example.com/a?x=1' });
    host.push(e);
    host.push(ex({ url: 'https://other-app-origin.example.net/x' })); // another app origin: still refused
    for (const url of [
      'https://evil.example.org/a',
      'https://other-app-origin.example.net/x',
      'https://api.example.com@evil.example.org/',
      'https://user:pw@api.example.com/a',
      'http://api.example.com/a',
      'https://api.example.com:8443/a',
      'https://api.example.com.evil.example.org/a',
      'https://[::1]/a',
      'https://127.0.0.1/a',
    ]) {
      await rejects(api.call('resend_request', { id: e.id, edit: { url } }), 'invalid', /must keep the original origin https:\/\/api\.example\.com/);
    }
    expect(host.sent).toEqual([]);
    await rejects(api.call('resend_request', { id: e.id, edit: { url: 'ftp://api.example.com/' } }), 'invalid', /http\(s\)/);
    // Normalised equivalents of the same origin are fine.
    await api.call('resend_request', { id: e.id, edit: { url: 'HTTPS://API.EXAMPLE.COM:443/other/path?y=2' } });
    expect(host.sent.map((r) => r.url)).toEqual(['https://api.example.com/other/path?y=2']);
  });

  it('IPv6 origins compare normalised', async () => {
    const { api, host } = setup();
    const e = ex({ url: 'http://[::1]:8080/a' });
    host.push(e);
    await api.call('resend_request', { id: e.id, edit: { url: 'http://[0:0:0:0:0:0:0:1]:8080/b' } });
    await rejects(api.call('resend_request', { id: e.id, edit: { url: 'http://[::2]:8080/b' } }), 'invalid', /original origin/);
    await rejects(api.call('resend_request', { id: e.id, edit: { url: 'http://[::1]:8081/b' } }), 'invalid', /original origin/);
    expect(host.sent).toHaveLength(1);
  });

  it.each<[string, Partial<Exchange>, RegExp]>([
    ['agent-sent', { initiator: 'agent' }, /sent by an agent/],
    ['editor-sent', { initiator: 'editor' }, /sent by .*the editor/],
    ['LAN client', { viaLan: true }, /over the LAN/],
    ['mocked', { state: 'mocked', matchedRuleId: 'm1' }, /handled by rule "m1"/],
    ['blocked', { state: 'blocked', matchedRuleId: 'b1' }, /handled by rule "b1"/],
    ['faulted', { state: 'blocked', matchedRuleId: 'f1', simulated: 'fault: reset' }, /handled by rule "f1"/],
    ['paused then edited at a breakpoint', { state: 'completed', matchedRuleId: 'bp1', url: 'http://127.0.0.1:9200/' }, /handled by rule "bp1"/],
    ['still paused', { state: 'paused-request', matchedRuleId: 'bp1' }, /handled by rule/],
    ['dropped by the network profile', { state: 'blocked', simulated: 'Flaky' }, /did not complete .*state: blocked/],
    ['upstream error', { state: 'error', status: undefined, error: 'ECONNREFUSED' }, /state: error/],
    ['pending', { state: 'pending', status: undefined }, /state: pending/],
    ['aborted', { state: 'aborted' }, /state: aborted/],
    ['lan-* record', { id: 'lan-123e4567', state: 'error', url: 'http://127.0.0.1:6379/' }, /connection-level record/],
    ['tls-* record', { id: 'tls-123e4567', state: 'error', url: 'https://sni.example/' }, /connection-level record/],
    ['lan-* record even if completed', { id: 'lan-abc', state: 'completed' }, /connection-level record/],
  ])('refuses %s', async (_name, over, re) => {
    const { api, host } = setup();
    const e = ex(over);
    host.push(e);
    await rejects(api.call('resend_request', { id: e.id }), 'invalid', new RegExp(`resend_request refused: .*${re.source}`));
    expect(host.sent).toEqual([]);
  });

  it('binary or truncated original bodies need edit.body; send failures are tool errors', async () => {
    const { api, host } = setup();
    const bin = ex({ method: 'POST', requestBody: { text: 'AAEC', encoding: 'base64' } });
    const cut = ex({ method: 'POST', requestBody: { text: 'abc', encoding: 'utf8', truncated: true } });
    const down = ex({ url: 'https://unreachable.example.com/' });
    [bin, cut, down].forEach((e) => host.push(e));
    await rejects(api.call('resend_request', { id: bin.id }), 'invalid', /binary/);
    await rejects(api.call('resend_request', { id: cut.id }), 'invalid', /truncated/);
    await expect(api.call('resend_request', { id: bin.id, edit: { body: 'text' } })).resolves.toMatchObject({ id: expect.any(String) });
    await rejects(api.call('resend_request', { id: down.id }), 'state', /could not send the request: ECONNREFUSED/);
    await rejects(api.call('resend_request', { id: 'gone' }), 'not_found');
    await rejects(api.call('resend_request', { id: bin.id, edit: { status: 200 } }), 'invalid');
  });

  it('list/get views show initiator, resentFrom, simulated and hasSource', async () => {
    const { api, host } = setup();
    const e = ex({ initiator: 'agent', resentFrom: 'e0', simulated: 'Slow 3G', source: { frames: [{ fn: 'f', uri: 'package:a/a.dart' }] } });
    host.push(e);
    expect(((await api.call('list_requests', {})) as { items: unknown[] }).items[0]).toMatchObject({ initiator: 'agent', simulated: 'Slow 3G' });
    expect(await api.call('get_request', { id: e.id })).toMatchObject({ initiator: 'agent', resentFrom: 'e0', simulated: 'Slow 3G', hasSource: true });
  });

  it('pure restore helpers', () => {
    expect(restoreRedactedHeaders({ a: ['[redacted]'], b: '[redacted]', c: 'x' }, { A: ['1', '2'] })).toEqual({ a: ['1', '2'], c: 'x' });
    expect(restoreRedactedQuery('https://h/p?t=%5Bredacted%5D&x=1#f', 'https://h/p?x=0&t=S%20E')).toBe('https://h/p?t=S%20E&x=1#f');
    expect(restoreRedactedQuery('https://h/p?t=[redacted]', 'https://h/p')).toBe('https://h/p?t=[redacted]');
  });
});

describe('older proxy builds', () => {
  it('simulate_network / resend_request give a clear state error without the host methods', async () => {
    const { api, host } = setup();
    (host as unknown as Record<string, unknown>).send = undefined;
    (host as unknown as Record<string, unknown>).setNetworkProfile = undefined;
    const e = ex();
    host.push(e);
    await rejects(api.call('simulate_network', { profile: 'offline' }), 'state', /cannot simulate/);
    await rejects(api.call('resend_request', { id: e.id }), 'state', /cannot send/);
  });
});
