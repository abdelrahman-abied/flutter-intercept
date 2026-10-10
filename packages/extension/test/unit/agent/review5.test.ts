// REVIEW-5 fixes on the host / agent side: #3 CORS rule scope and wording, #4 panel frame budget and stream
// update rate, #5 URL userinfo / fragment / error text, #6 hidden browser-internal count, #7 HAR with invalid
// times, #8 GraphQL document and Sec-WebSocket-Protocol redaction.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { urlGlobHasHost } from '../../../src/agent/corsPolicy';
import { buildHar } from '../../../src/agent/har';
import { confirmationText } from '../../../src/agent/lmTools';
import { redactBodyText, redactGraphqlDocument, redactHeaders, redactText, redactUrl, redactWebSocketProtocols } from '../../../src/agent/redact';
import { AgentToolError, type AppLauncher } from '../../../src/agent/types';
import { ControllerHost, InterceptController, uiExchange, UI_MAX_FRAME_CHARS, validateRule, validateRules } from '../../../src/ui/controller';
import type { HostMsg } from '../../../src/ui/protocol';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const TOKEN = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAB7CD';

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  setRules(r: Rule[]) {
    this.rules = r;
  }
  clear() {}
  resume() {}
  abort() {}
  push(e: Exchange) {
    const i = this.exchanges.findIndex((x) => x.id === e.id);
    if (i >= 0) this.exchanges[i] = e;
    else this.exchanges.push(e);
    this.emit('exchange', { ...e });
  }
}

let seq = 0;
const ex = (over: Partial<Exchange> = {}): Exchange => ({
  id: `r${++seq}`,
  startedAt: 1000 + seq,
  method: 'GET',
  url: 'https://api.example.com/v1/x',
  requestHeaders: {},
  state: 'completed',
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: { text: '{}', encoding: 'utf8' },
  ...over,
});

function agent() {
  const host = new FakeHost();
  let n = 0;
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
    launcher: { sessions: () => [] } as unknown as AppLauncher,
    projectRoot: () => undefined,
    newRuleId: () => `a${++n}`,
  };
  return { api: createAgentApi(deps), host };
}

async function rejects(p: Promise<unknown>, re: RegExp) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AgentToolError);
  expect((err as Error).message).toMatch(re);
}

describe('#3 CORS rules', () => {
  it('add_cors_rule needs a host', async () => {
    const { api, host } = agent();
    for (const url of ['*', '*://*', '*://*/*', '*/api/*', 'https://*/x', 'https://*:8080/*', 'api.example.com/*']) {
      await rejects(api.call('add_cors_rule', { url }), /needs a url with a host/);
    }
    expect(host.rules).toEqual([]);
    for (const url of ['https://api.example.com/*', 'https://*.example.com/*', '*://localhost:8080/*', 'http://127.0.0.1:5000/api/*']) expect(urlGlobHasHost(url), url).toBe(true);
  });

  it('the rule name always states the origin policy and credentials (custom names too)', async () => {
    const { api, host } = agent();
    await api.call('add_cors_rule', { url: 'https://api.example.com/*' });
    expect(host.rules[0].name).toBe('[agent] * https://api.example.com/* [CORS dev only: loopback origins only, no credentials]');
    await api.call('add_cors_rule', { url: 'https://api.example.com/*', allowOrigin: '*', name: 'open' });
    expect(host.rules[0].name).toBe('[agent] open [CORS dev only: ANY origin, no credentials]');
  });

  it('the confirmation states who can read the responses', () => {
    expect(confirmationText('add_cors_rule', { url: 'https://a.dev/*' }).message).toMatch(/only loopback pages.*Credentials \(cookies\): \*\*not allowed\*\*/s);
    expect(confirmationText('add_cors_rule', { url: 'https://a.dev/*', allowOrigin: '*' }).message).toMatch(/\*\*Any website\*\* open in the debug browser/);
    expect(confirmationText('add_cors_rule', { url: 'https://a.dev/*', allowOrigin: 'http://localhost:5000', allowCredentials: true }).message).toMatch(
      /only `http:\/\/localhost:5000`.*allowed — pages of that origin can read these responses with the user's cookies/s,
    );
  });

  it('validateRule refuses allowOrigin "null"', async () => {
    for (const o of ['null', 'NULL', 'Null']) {
      expect(() => validateRule({ id: 'r', enabled: true, match: { url: 'https://a.dev/*' }, action: { kind: 'cors', allowOrigin: o } })).toThrow(/"null" is refused/);
    }
    await rejects(agent().api.call('add_cors_rule', { url: 'https://a.dev/*', allowOrigin: 'null' }), /"null" is refused/);
  });
});

describe('#4 panel frames', () => {
  it('the budget counts SSE event names and ids', () => {
    const big = 'e'.repeat(64 * 1024);
    const frames = Array.from({ length: 200 }, (_, i) => ({ dir: 'receive' as const, at: i, kind: 'event' as const, event: big, id: big, text: 'd', size: 1 }));
    const u = uiExchange(ex({ kind: 'sse', state: 'pending', frames }));
    const bytes = JSON.stringify(u.frames).length;
    expect(bytes).toBeLessThan(UI_MAX_FRAME_CHARS + 200_000);
    expect(u.framesDropped).toBeGreaterThan(150);
  });

  const controllers: InterceptController[] = [];
  afterEach(() => {
    while (controllers.length) controllers.pop()!.dispose();
  });

  it('an open stream updates the panel at most every streamUpdateMs; the final state goes out at once', async () => {
    const host = new FakeHost();
    const c = new InterceptController({ host: host as unknown as ControllerHost, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, streamUpdateMs: 200 });
    controllers.push(c);
    const msgs: HostMsg[] = [];
    c.attach((m) => msgs.push(m));
    const sent = () => msgs.filter((m): m is Extract<HostMsg, { type: 'exchange' }> => m.type === 'exchange' && m.exchange.id === 'ws1');
    const frames: NonNullable<Exchange['frames']> = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 450) {
      frames.push({ dir: 'receive', at: Date.now(), kind: 'text', text: 'x', size: 1 });
      host.push(ex({ id: 'ws1', kind: 'websocket', state: 'pending', frames: [...frames] }));
      await new Promise((r) => setTimeout(r, 10));
    }
    const live = sent().length;
    expect(live).toBeGreaterThanOrEqual(2);
    expect(live).toBeLessThanOrEqual(4); // ≈ 450 ms / 200 ms + the first
    host.push(ex({ id: 'ws1', kind: 'websocket', state: 'completed', frames: [...frames] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(sent().at(-1)!.exchange.state).toBe('completed');
    // the held update was replaced, not sent after the final one
    await new Promise((r) => setTimeout(r, 250));
    expect(sent().at(-1)!.exchange.state).toBe('completed');
    // a plain request is never held
    host.push(ex({ id: 'h1' }));
    host.push(ex({ id: 'h1', status: 201 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(msgs.some((m) => m.type === 'exchange' && m.exchange.id === 'h1' && m.exchange.status === 201)).toBe(true);
  });
});

describe('#5 URLs and error texts', () => {
  it('redactUrl drops userinfo and redacts fragment parameters', () => {
    expect(redactUrl('https://user:hunter2@api.example.com/p#access_token=SECRETabc123&state=ok')).toBe('https://[redacted]@api.example.com/p#access_token=[redacted]&state=ok');
    expect(redactUrl('https://alice@api.example.com/')).toBe('https://[redacted]@api.example.com/');
    expect(redactUrl(`https://a.dev/p?x=1#${JWT}`)).toBe('https://a.dev/p?x=1#[redacted]');
    expect(redactUrl('https://a.dev/docs#section-2')).toBe('https://a.dev/docs#section-2');
    expect(redactUrl('https://a.dev/p#frag?token=x')).toBe('https://a.dev/p#frag?token=[redacted]');
  });

  it('error texts are redacted for agents and in HAR', async () => {
    const { api, host } = agent();
    const err = 'HttpException: Connection closed before full header was received, uri = https://u:pw@api.example.com/v1/me?access_token=SECRET_Q&x=1';
    const e = ex({ state: 'error', status: undefined, error: err, captured: 'vm-profile', cors: { problem: `no Access-Control-Allow-Origin for https://a.dev/?token=SECRET_C` } });
    host.exchanges.push(e);
    const r = (await api.call('get_request', { id: e.id })) as any;
    expect(r.error).toBe('HttpException: Connection closed before full header was received, uri = https://[redacted]@api.example.com/v1/me?access_token=[redacted]&x=1');
    expect(JSON.stringify(r)).not.toMatch(/SECRET_|pw@/);
    expect(JSON.stringify(buildHar([e], { redact: true }))).not.toMatch(/SECRET_|pw@/);
    expect(redactText(`failed: Bearer ${TOKEN}1`)).toBe('failed: Bearer [redacted]');
  });
});

describe('#6 / #7', () => {
  it('get_status counts hidden browser-internal exchanges', async () => {
    const { api, host } = agent();
    host.exchanges.push(ex(), ex({ browserInternal: true }), ex({ browserInternal: true }));
    expect(((await api.call('get_status', {})) as any).browserInternalHidden).toBe(2);
  });

  it('buildHar tolerates invalid times', () => {
    const bad = [ex({ startedAt: NaN }), ex({ startedAt: 1e30, durationMs: NaN }), ex({ kind: 'websocket', frames: [{ dir: 'send', at: NaN, kind: 'text', text: 'x', size: 1 }] })];
    const har = buildHar(bad, { redact: true }) as any;
    expect(har.log.entries).toHaveLength(3);
    expect(har.log.entries.every((x: any) => typeof x.startedDateTime === 'string' && Number.isFinite(x.time))).toBe(true);
  });

  it('redacted HAR summarises binary WebSocket frames', () => {
    const e = ex({ kind: 'websocket', frames: [{ dir: 'receive', at: 1, kind: 'binary', base64: 'U0VDUkVU', size: 6 }] });
    expect((buildHar([e], { redact: true }) as any).log.entries[0]._webSocketMessages[0].data).toBe('[binary 6 bytes]');
    expect((buildHar([e], { redact: false }) as any).log.entries[0]._webSocketMessages[0].data).toBe('U0VDUkVU');
  });
});

describe('#8 GraphQL documents and WebSocket subprotocols', () => {
  it('a JWT in the document does not switch off argument redaction', () => {
    const body = JSON.stringify({ query: `mutation { login(password: "pw-secret", t: "${JWT}") { ok } }` });
    const out = redactBodyText(body, { 'content-type': 'application/json' });
    expect(out).not.toContain('pw-secret');
    expect(out).not.toContain('eyJhbGci');
  });

  it('lists, variable defaults and CR-terminated comments', () => {
    expect(redactGraphqlDocument('{ a(tokens: ["t1", "t2"], ids: [1, 2]) }')).toBe('{ a(tokens: ["[redacted]", "[redacted]"], ids: [1, 2]) }');
    expect(redactGraphqlDocument('{ a(apiKeys: [[ "k" ], [{v: "w"}]], b: "ok") }')).toBe('{ a(apiKeys: [[ "[redacted]" ], [{v: "[redacted]"}]], b: "ok") }');
    expect(redactGraphqlDocument('query Q($password: String! = "hunter2", $id: ID = "7", $tokens: [String] = ["a"]) { me(password: $password) }')).toBe(
      'query Q($password: String! = "[redacted]", $id: ID = "7", $tokens: [String] = ["[redacted]"]) { me(password: $password) }',
    );
    expect(redactGraphqlDocument('#c\rmutation { login(password: "x") }')).toBe('#c\rmutation { login(password: "[redacted]") }');
    expect(redactGraphqlDocument('{ a(password: "x"\r, b: "y") }')).toBe('{ a(password: "[redacted]"\r, b: "y") }');
  });

  it('Sec-WebSocket-Protocol tokens (request and the 101 echo)', async () => {
    expect(redactWebSocketProtocols(`access_token, ${TOKEN}`)).toBe('access_token, [redacted]');
    expect(redactWebSocketProtocols('bearer, abc.def')).toBe('bearer, [redacted]');
    expect(redactWebSocketProtocols(`base64url.bearer.authorization.k8s.io.${TOKEN}, base64.binary.k8s.io`)).toBe('base64url.bearer.authorization.k8s.io.[redacted], base64.binary.k8s.io');
    expect(redactWebSocketProtocols(`graphql-transport-ws, ${JWT}`)).toBe('graphql-transport-ws, [redacted]');
    expect(redactWebSocketProtocols('graphql-ws, mqtt')).toBe('graphql-ws, mqtt');
    expect(redactHeaders({ 'Sec-WebSocket-Protocol': ['access_token', 'tok-123'] })).toEqual({ 'Sec-WebSocket-Protocol': ['access_token, [redacted]'] });
    const { api, host } = agent();
    const w = ex({ kind: 'websocket', status: 101, requestHeaders: { 'sec-websocket-protocol': `access_token, ${TOKEN}` }, responseHeaders: { 'sec-websocket-protocol': `access_token` } });
    host.exchanges.push(w);
    expect(JSON.stringify(await api.call('get_request', { id: w.id }))).not.toContain(TOKEN);
  });
});

vi.setConfig({ testTimeout: 10_000 });
