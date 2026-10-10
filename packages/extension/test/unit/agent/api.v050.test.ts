// CONTRACTS §11.5: get_frames, kind / graphqlOperation filters, get_request fields, graphqlOperation on rule
// tools, add_cors_rule, get_status warnings, read-only profile exchanges, redaction of frames and GraphQL.
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, MAX_FRAME_RESULT_CHARS, restoreRedactedQuery, type AgentApiDeps } from '../../../src/agent/api';
import { buildHar } from '../../../src/agent/har';
import { confirmationText, invocationMessage } from '../../../src/agent/lmTools';
import { redactBodyText, redactFrameText, redactGraphqlDocument, redactUrl } from '../../../src/agent/redact';
import { toolAnnotations } from '../../../src/agent/mcp/server';
import { AgentToolError, type AgentAccess, type AppLauncher } from '../../../src/agent/types';
import { validateRules } from '../../../src/ui/controller';
import type { SessionWarning } from '../../../src/ui/protocol';

type Frame = NonNullable<Exchange['frames']>[number];

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  warnings: SessionWarning[] = [];
  send = vi.fn(async () => ({ id: 'sent1' }));
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  resume() {}
  abort() {}
}

let seq = 0;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const ex = (over: Partial<Exchange> = {}): Exchange => ({
  id: `x${++seq}`,
  startedAt: 1000 + seq,
  method: 'GET',
  url: `https://api.example.com/v1/users/${seq}`,
  requestHeaders: { authorization: 'Bearer SECRET_H' },
  state: 'completed',
  status: 200,
  durationMs: 40,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: { text: '{"id":1}', encoding: 'utf8' },
  ...over,
});
const text = (dir: Frame['dir'], t: string, at = 1): Frame => ({ dir, at, kind: 'text', text: t, size: Buffer.byteLength(t) });

function setup(opts: { access?: AgentAccess; redact?: boolean } = {}) {
  const host = new FakeHost();
  const launcher: AppLauncher = { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher;
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
  };
  return { api: createAgentApi(deps), host };
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

const ws = (frames: Frame[], over: Partial<Exchange> = {}) =>
  ex({ kind: 'websocket', url: 'wss://rt.example.com/socket', status: 101, state: 'pending', responseBody: undefined, frames, ...over });

describe('get_frames', () => {
  it('both directions, redacted: JSON structurally, text by pattern, binary summarised', async () => {
    const { api, host } = setup();
    const e = ws([
      text('send', JSON.stringify({ type: 'auth', token: 'SECRET_T', n: 1.0 }).replace('1', '1.0'), 10),
      text('receive', JSON.stringify({ type: 'welcome', user: { name: 'Ann', session_id: 'SECRET_S' } }), 11),
      text('send', `CONNECT\npasscode:SECRET_P\nAuthorization: Bearer ${JWT}\n\n`, 12),
      text('receive', `42["auth",{"password":"SECRET_W","ok":true}]`, 13),
      { dir: 'receive', at: 14, kind: 'binary', base64: Buffer.from('SECRET_BIN').toString('base64'), size: 10 },
      { dir: 'send', at: 15, kind: 'ping', size: 0 },
      { dir: 'receive', at: 16, kind: 'close', closeCode: 1000, text: 'bye', size: 5 },
    ]);
    host.exchanges.push(e);
    const r = (await api.call('get_frames', { id: e.id })) as any;
    const out = JSON.stringify(r);
    expect(out).not.toMatch(/SECRET_|eyJhbGci/);
    expect(r.frames.map((f: any) => f.dir)).toEqual(['send', 'receive', 'send', 'receive', 'receive', 'send', 'receive']);
    expect(r.frames.map((f: any) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.frames[0].text).toBe('{"type":"auth","token":"[redacted]","n":1.0}'); // JSON kept byte-exact
    expect(r.frames[1].text).toContain('"name":"Ann"');
    expect(r.frames[2].text).toContain('passcode:[redacted]');
    expect(r.frames[4]).toMatchObject({ kind: 'binary', text: '[binary 10 bytes]', binary: true, size: 10 });
    expect(r.frames[6]).toMatchObject({ kind: 'close', closeCode: 1000, text: 'bye' });
    expect(r).toMatchObject({ id: e.id, kind: 'websocket', state: 'pending', next: 7, total: 7, more: false, open: true });
  });

  it('unredacted when redaction is off (binary still summarised)', async () => {
    const { api, host } = setup({ redact: false });
    const e = ws([text('send', '{"token":"T1"}'), { dir: 'receive', at: 1, kind: 'binary', base64: 'AAEC', size: 3 }]);
    host.exchanges.push(e);
    const r = (await api.call('get_frames', { id: e.id })) as any;
    expect(r.frames[0].text).toBe('{"token":"T1"}');
    expect(r.frames[1].text).toBe('[binary 3 bytes]');
  });

  it('pages with since / next using absolute indexes across dropped frames', async () => {
    const { api, host } = setup();
    const e = ws(
      Array.from({ length: 10 }, (_, i) => text('receive', `m${i + 20}`, i)),
      { framesDropped: 20 },
    );
    host.exchanges.push(e);
    const p1 = (await api.call('get_frames', { id: e.id, limit: 4 })) as any;
    expect(p1.frames.map((f: any) => [f.index, f.text])).toEqual([
      [20, 'm20'],
      [21, 'm21'],
      [22, 'm22'],
      [23, 'm23'],
    ]);
    expect(p1).toMatchObject({ next: 24, total: 30, dropped: 20, more: true });
    const p2 = (await api.call('get_frames', { id: e.id, since: p1.next, limit: 100 })) as any;
    expect(p2.frames[0].index).toBe(24);
    expect(p2).toMatchObject({ next: 30, more: false });
    const old = (await api.call('get_frames', { id: e.id, since: 5, limit: 1 })) as any;
    expect(old).toMatchObject({ skipped: 15, next: 21 });
    expect(old.note).toMatch(/frames 5-19 were dropped/);
    const past = (await api.call('get_frames', { id: e.id, since: 99 })) as any;
    expect(past).toMatchObject({ frames: [], next: 99, more: false });
  });

  it('maxChars cuts each frame; the total result is bounded', async () => {
    const { api, host } = setup();
    const e = ws([text('receive', 'a'.repeat(5000)), ...Array.from({ length: 60 }, () => text('receive', 'b'.repeat(60_000)))]);
    host.exchanges.push(e);
    const r = (await api.call('get_frames', { id: e.id, limit: 2, maxChars: 100 })) as any;
    expect(r.frames[0]).toMatchObject({ truncated: true, textChars: 5000 });
    expect(r.frames[0].text).toHaveLength(100);
    const all = (await api.call('get_frames', { id: e.id, limit: 500, maxChars: 65_536 })) as any;
    expect(JSON.stringify(all.frames).length).toBeLessThan(MAX_FRAME_RESULT_CHARS + 50_000);
    expect(all.more).toBe(true);
    expect(all.next).toBe(all.frames.length);
  });

  it('SSE events: event name and id; plain HTTP is refused; unknown id', async () => {
    const { api, host } = setup();
    const s = ex({ kind: 'sse', url: 'https://api.example.com/events', frames: [{ dir: 'receive', at: 1, kind: 'event', event: 'price', id: '7', text: '{"p":1,"api_key":"K"}', size: 20 }] });
    const h = ex();
    host.exchanges.push(s, h);
    const r = (await api.call('get_frames', { id: s.id })) as any;
    expect(r.frames[0]).toMatchObject({ kind: 'event', event: 'price', id: '7', text: '{"p":1,"api_key":"[redacted]"}' });
    await rejects(api.call('get_frames', { id: h.id }), 'invalid', /plain HTTP request/);
    await rejects(api.call('get_frames', { id: 'nope' }), 'not_found');
    await rejects(api.call('get_frames', { id: s.id, limit: 501 }), 'invalid');
  });

  it('is a read tool (allowed read-only, annotated read-only)', async () => {
    const { api, host } = setup({ access: 'readOnly' });
    const e = ws([]);
    host.exchanges.push(e);
    await expect(api.call('get_frames', { id: e.id })).resolves.toMatchObject({ frames: [], total: 0 });
    expect(toolAnnotations('get_frames')).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
  });
});

describe('list_requests / get_request (v0.5.0 fields)', () => {
  it('filters by kind and graphqlOperation; summaries carry kind, operation, captured', async () => {
    const { api, host } = setup();
    const a = ws([text('send', 'x')]);
    const b = ex({ method: 'POST', url: 'https://api.example.com/graphql', graphql: { operationName: 'GetUser', operationType: 'query' } });
    const c = ex({ method: 'POST', url: 'https://api.example.com/graphql', graphql: { operationName: 'Login', operationType: 'mutation' } });
    const d = ex({ kind: 'sse', url: 'https://api.example.com/events' });
    const n = ex({ captured: 'vm-profile', url: 'https://native.example.com/x' });
    host.exchanges.push(a, b, c, d, n);
    const ids = async (input: Record<string, unknown>) => ((await api.call('list_requests', input)) as any).items.map((i: any) => i.id);
    expect(await ids({ kind: 'websocket' })).toEqual([a.id]);
    expect(await ids({ kind: 'sse' })).toEqual([d.id]);
    expect((await ids({ kind: 'http' })).sort()).toEqual([b.id, c.id, n.id].sort());
    expect(await ids({ graphqlOperation: 'GetUser' })).toEqual([b.id]);
    expect(await ids({ graphqlOperation: 'GetUser', url: '*/rest*' })).toEqual([]);
    await rejects(api.call('list_requests', { graphqlOperation: 'Get User' }), 'invalid');
    await rejects(api.call('list_requests', { kind: 'grpc' }), 'invalid');
    const items = ((await api.call('list_requests', {})) as any).items;
    expect(items.find((i: any) => i.id === b.id)).toMatchObject({ graphqlOperation: 'GetUser' });
    expect(items.find((i: any) => i.id === a.id)).toMatchObject({ kind: 'websocket' });
    expect(items.find((i: any) => i.id === n.id)).toMatchObject({ captured: 'vm-profile' });
  });

  it('get_request shows kind, frameCount, framesDropped, graphql, cors, captured — never the frames', async () => {
    const { api, host } = setup();
    const a = ws([text('send', '{"token":"SECRET_T"}'), text('receive', 'y')], { framesDropped: 3 });
    const g = ex({ method: 'POST', graphql: { operationName: 'GetUser', operationType: 'query' }, cors: { problem: 'no Access-Control-Allow-Origin for http://localhost:5000' } });
    const n = ex({ captured: 'vm-profile' });
    host.exchanges.push(a, g, n);
    const ra = (await api.call('get_request', { id: a.id })) as any;
    expect(ra).toMatchObject({ kind: 'websocket', frameCount: 2, framesDropped: 3 });
    expect(ra.frames).toBeUndefined();
    expect(JSON.stringify(ra)).not.toContain('SECRET_T');
    const rg = (await api.call('get_request', { id: g.id })) as any;
    expect(rg.graphql).toEqual({ operationName: 'GetUser', operationType: 'query' });
    expect(rg.cors.problem).toMatch(/no Access-Control-Allow-Origin/);
    expect(rg.frameCount).toBeUndefined();
    const rn = (await api.call('get_request', { id: n.id })) as any;
    expect(rn.captured).toBe('vm-profile');
    expect(rn.readOnly).toMatch(/native HTTP client/);
  });

  it('GraphQL variables and inline secrets are redacted (POST body, GET query, application/graphql)', async () => {
    const { api, host } = setup();
    const body = JSON.stringify({
      operationName: 'Login',
      query: 'mutation Login($email: String!) { login(email: $email, password: "SECRET_INLINE", otp: 123) { token } }',
      variables: { email: 'a@b.c', password: 'SECRET_VAR', input: { apiKey: 'SECRET_KEY' } },
    });
    const post = ex({ method: 'POST', url: 'https://api.example.com/graphql', requestHeaders: { 'content-type': 'application/json' }, requestBody: { text: body, encoding: 'utf8' }, graphql: { operationName: 'Login', operationType: 'mutation' } });
    const getUrl = `https://api.example.com/graphql?query=${encodeURIComponent('{ me(token: "SECRET_Q") { id } }')}&variables=${encodeURIComponent('{"password":"SECRET_GV","id":1}')}`;
    const get = ex({ url: getUrl, graphql: { operationName: 'Me', operationType: 'query' } });
    const gql = ex({ method: 'POST', requestHeaders: { 'content-type': 'application/graphql' }, requestBody: { text: 'mutation { reset(secret: """SECRET_BLOCK""") }', encoding: 'utf8' } });
    host.exchanges.push(post, get, gql);
    for (const e of [post, get, gql]) {
      const out = JSON.stringify(await api.call('get_request', { id: e.id, snippet: 'curl' }));
      expect(out, e.id).not.toMatch(/SECRET_/);
    }
    const r = (await api.call('get_request', { id: post.id })) as any;
    expect(r.requestBody.text).toContain('"email":"a@b.c"');
    expect(r.requestBody.text).toContain('password: \\"[redacted]\\"');
    expect(r.requestBody.text).toContain('$email: String!');
    // list_requests urls too
    expect(JSON.stringify(await api.call('list_requests', {}))).not.toMatch(/SECRET_/);
    const har = JSON.stringify(buildHar(host.exchanges, { redact: true }));
    expect(har).not.toMatch(/SECRET_/);
  });
});

describe('graphqlOperation on rule tools', () => {
  it('add_mock / add_block / add_breakpoint / add_mutation / simulate_network put it in match', async () => {
    const { api, host } = setup();
    const url = 'https://api.example.com/graphql';
    await api.call('add_mock', { url, method: 'POST', graphqlOperation: 'GetUser', body: { data: { user: null } } });
    await api.call('add_block', { url, graphqlOperation: 'Login' });
    await api.call('add_breakpoint', { url, graphqlOperation: 'Login', phase: 'request' });
    await api.call('add_mutation', { url, graphqlOperation: 'GetUser', ops: [{ path: '$.data.user', op: 'null' }] });
    await api.call('simulate_network', { url, graphqlOperation: 'Feed', fault: 'timeout' });
    expect(host.rules.map((r) => r.match.graphqlOperation)).toEqual(['Feed', 'GetUser', 'Login', 'Login', 'GetUser']);
    expect(host.rules.at(-1)!.match).toEqual({ url, method: 'POST', graphqlOperation: 'GetUser' });
    expect(host.rules.at(-1)!.name).toBe(`[agent] mock POST ${url} (GraphQL GetUser) → 200`);
    await rejects(api.call('add_mock', { url, graphqlOperation: '1x', body: 'x' }), 'invalid');
    await rejects(api.call('simulate_network', { profile: 'slow-3g', graphqlOperation: 'Feed' }), 'invalid', /only apply together with a url/);
    // globs only still applies to the url
    await rejects(api.call('add_mock', { url: '/graphql/', graphqlOperation: 'GetUser', body: 'x' }), 'invalid', /globs/);
  });
});

describe('add_cors_rule', () => {
  it('inserts a cors rule first, labelled', async () => {
    const { api, host } = setup();
    host.rules = validateRules([{ id: 'u1', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'status', status: 403 } }]);
    const r = (await api.call('add_cors_rule', { url: 'https://api.example.com/*', allowOrigin: 'http://localhost:5000', allowCredentials: true, times: 3 })) as any;
    expect(host.rules[0]).toMatchObject({
      id: r.ruleId,
      enabled: true,
      match: { url: 'https://api.example.com/*' },
      action: { kind: 'cors', allowOrigin: 'http://localhost:5000', allowCredentials: true },
      times: 3,
    });
    expect(host.rules[0].name).toBe('[agent] * https://api.example.com/* [CORS dev only: http://localhost:5000, WITH credentials]');
    await api.call('add_cors_rule', { url: 'https://api.example.com/*', ttlMs: 60_000 });
    expect(host.rules[0]).toMatchObject({ action: { kind: 'cors' }, expiresAt: 50_000 + 60_000 });
  });

  it('refuses * with credentials, header injection, ws URLs, read-only access', async () => {
    const { api } = setup();
    await rejects(api.call('add_cors_rule', { url: 'https://a.dev/*', allowOrigin: '*', allowCredentials: true }), 'invalid', /cannot be combined/);
    await rejects(api.call('add_cors_rule', { url: 'https://a.dev/*', allowOrigin: 'http://a.dev\r\nx: 1' }), 'invalid', /allowOrigin/);
    await rejects(api.call('add_cors_rule', { url: 'wss://a.dev/*' }), 'invalid', /needs a url with a host/);
    await rejects(api.call('add_cors_rule', { url: 'https://a.dev/*', access_token: 'x' }), 'invalid');
    const ro = setup({ access: 'readOnly' });
    await rejects(ro.api.call('add_cors_rule', { url: 'https://a.dev/*' }), 'access');
  });

  it('annotations like add_mock; confirmation says development only', () => {
    const { title: _a, ...cors } = toolAnnotations('add_cors_rule');
    const { title: _b, ...mock } = toolAnnotations('add_mock');
    expect(cors).toEqual(mock);
    const c = confirmationText('add_cors_rule', { url: 'https://a.dev/*', allowCredentials: true, times: 1 });
    expect(c.title).toMatch(/development only/);
    expect(c.message).toMatch(/not\*\* changed/);
    expect(c.message).toMatch(/only loopback pages/);
    expect(c.message).toMatch(/Credentials \(cookies\): \*\*allowed\*\*/);
    expect(invocationMessage('add_cors_rule', { url: 'https://a.dev/*' })).toMatch(/development-only CORS/);
    expect(invocationMessage('get_frames', { id: 'x1', since: 4 })).toBe('Reading the frames of x1 from #4');
    expect(confirmationText('add_mock', { url: 'https://a.dev/graphql', graphqlOperation: 'GetUser', body: {} }).message).toMatch(/GraphQL operation `GetUser`/);
  });
});

describe('get_status warnings, read-only exchanges', () => {
  it('get_status lists warnings', async () => {
    const { api, host } = setup();
    host.warnings = [{ id: 'isolate:s1:worker', kind: 'background-isolate', text: 'Requests from background isolate "worker" are not intercepted (HttpOverrides is per isolate).', sessionId: 's1' }];
    const st = (await api.call('get_status', {})) as any;
    expect(st.warnings).toEqual([{ kind: 'background-isolate', text: host.warnings[0].text, sessionId: 's1' }]);
  });

  it('resend_request refuses vm-profile, WebSocket and SSE exchanges', async () => {
    const { api, host } = setup();
    const n = ex({ captured: 'vm-profile' });
    const w = ws([], { state: 'completed', url: 'https://rt.example.com/socket' });
    const s = ex({ kind: 'sse' });
    host.exchanges.push(n, w, s);
    await rejects(api.call('resend_request', { id: n.id }), 'invalid', /native HTTP client/);
    await rejects(api.call('resend_request', { id: w.id }), 'invalid', /WebSocket/);
    await rejects(api.call('resend_request', { id: s.id }), 'invalid', /server-sent event/);
    expect(host.send).not.toHaveBeenCalled();
  });
});

describe('redaction helpers (v0.5.0)', () => {
  it('redactFrameText', () => {
    expect(redactFrameText('{"a":{"password":"p"},"n":12345678901234567890}')).toBe('{"a":{"password":"[redacted]"},"n":12345678901234567890}');
    expect(redactFrameText('{not json "token": "abc"')).toBe('{not json "token": "[redacted]"');
    expect(redactFrameText(`hello Bearer ${JWT}`)).not.toContain('eyJ');
    expect(redactFrameText('SUBSCRIBE\nid:sub-0\nx-api-key: K1\n')).toBe('SUBSCRIBE\nid:sub-0\nx-api-key: [redacted]\n');
    expect(redactFrameText('plain text: nothing secret')).toBe('plain text: nothing secret');
  });

  it('redactGraphqlDocument keeps variable definitions and non-sensitive arguments', () => {
    expect(redactGraphqlDocument('query($token: String!) { me(token: $token, id: "42") { name } }')).toBe('query($token: String!) { me(token: $token, id: "42") { name } }');
    expect(redactGraphqlDocument('{ a(sessionToken: "x\\"y", pin: 1) }')).toBe('{ a(sessionToken: "[redacted]", pin: 1) }');
    expect(redactGraphqlDocument('{ a(clientSecret: 99) }')).toBe('{ a(clientSecret: "[redacted]") }');
    expect(redactGraphqlDocument('{ a(password: """multi\nline""", b: "ok") # token: "c"\n }')).toBe('{ a(password: "[redacted]", b: "ok") # token: "c"\n }');
    expect(redactGraphqlDocument('{ a(input: {apiKey: "K", list: [1]}, mode: SECRET_ENUM_KEPT, pass: null) }')).toBe(
      '{ a(input: {apiKey: "[redacted]", list: [1]}, mode: SECRET_ENUM_KEPT, pass: null) }',
    );
  });

  it('stays linear on hostile documents', () => {
    const t = Date.now();
    for (const doc of ['token:"\\"'.repeat(200_000), 'token:"""'.repeat(200_000), 'a:'.repeat(500_000)]) {
      redactGraphqlDocument(doc);
      redactFrameText(doc);
      redactBodyText(JSON.stringify({ query: doc }));
    }
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('GET GraphQL parameters; resend restores what the agent saw', () => {
    const orig = `https://api.example.com/graphql?query=${encodeURIComponent('{ me { id } }')}&variables=${encodeURIComponent('{"password":"PW","id":1}')}`;
    const seen = redactUrl(orig);
    expect(seen).not.toContain('PW');
    expect(decodeURIComponent(seen)).toContain('"id":1');
    expect(restoreRedactedQuery(seen, orig)).toBe(orig);
    expect(redactBodyText('{"variables":{"auth":{"x":1}}}')).toBe('{"variables":{"auth":"[redacted]"}}');
  });
});

describe('browserInternal exchanges (CONTRACTS §11.3)', () => {
  it('list_requests / wait_for_request / assert_traffic / export_har hide them unless includeBrowserInternal', async () => {
    const { api, host } = setup();
    const app = ex({ url: 'https://api.example.com/v1/items', startedAt: 10 });
    const chrome = ex({ url: 'https://update.googleapis.com/service/update2/json', startedAt: 20, browserInternal: true });
    host.exchanges.push(app, chrome);
    const ids = async (input: Record<string, unknown>) => ((await api.call('list_requests', input)) as any).items.map((i: any) => i.id);
    expect(await ids({})).toEqual([app.id]);
    expect(((await api.call('list_requests', {})) as any).total).toBe(1);
    const all = (await api.call('list_requests', { includeBrowserInternal: true })) as any;
    expect(all.items.map((i: any) => i.id)).toEqual([chrome.id, app.id]);
    expect(all.items[0].browserInternal).toBe(true);
    expect(all.items[1].browserInternal).toBeUndefined();

    const w = (await api.call('wait_for_request', { url: '*googleapis*', sinceMs: 0, timeoutMs: 0 })) as any;
    expect(w.timedOut).toBe(true);
    const w2 = (await api.call('wait_for_request', { url: '*googleapis*', sinceMs: 0, timeoutMs: 0, includeBrowserInternal: true })) as any;
    expect(w2).toMatchObject({ timedOut: false, id: chrome.id, browserInternal: true });

    const a = (await api.call('assert_traffic', { url: '*', expect: { count: { exact: 1 } } })) as any;
    expect(a).toMatchObject({ pass: true, matched: 1 });
    const a2 = (await api.call('assert_traffic', { url: '*', includeBrowserInternal: true, expect: { count: { exact: 2 } } })) as any;
    expect(a2.pass).toBe(true);
    const ord = (await api.call('assert_traffic', { url: '*', expect: { order: ['*/v1/items', '*googleapis*'] } })) as any;
    expect(ord.pass).toBe(false);
    const ord2 = (await api.call('assert_traffic', { url: '*', includeBrowserInternal: true, expect: { order: ['*/v1/items', '*googleapis*'] } })) as any;
    expect(ord2.pass).toBe(true);
    await rejects(api.call('list_requests', { includeBrowserInternal: 'yes' }), 'invalid');
  });

  it('export_har excludes them by default', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const pathMod = await import('path');
    const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fi-har-'));
    try {
      const host = new FakeHost();
      host.exchanges.push(ex({ startedAt: 10 }), ex({ startedAt: 20, browserInternal: true }));
      const api = createAgentApi({
        host: host as unknown as AgentApiDeps['host'],
        applyRules: () => undefined,
        clear: () => undefined,
        getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
        launcher: { sessions: () => [] } as unknown as AppLauncher,
        projectRoot: () => root,
      });
      expect(((await api.call('export_har', {})) as any).entries).toBe(1);
      expect(((await api.call('export_har', { includeBrowserInternal: true })) as any).entries).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
