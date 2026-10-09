import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { AGENT_RULE_PREFIX, createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
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

function setup(opts: { access?: AgentAccess; redact?: boolean; now?: number; root?: string | null } = {}) {
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
    for (const t of ['add_mock', 'add_block', 'add_breakpoint', 'remove_rule', 'resume_request', 'abort_request', 'clear_requests', 'launch_app', 'stop_app', 'hot_restart'] as ToolName[]) {
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
    expect(((await api.call('list_requests', { url: '/users\\/\\d$/' })) as { total: number }).total).toBe(1);
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
