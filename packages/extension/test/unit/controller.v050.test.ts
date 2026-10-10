// CONTRACTS §11: graphqlOperation + cors validation, read-only profile exchanges, WebSocket rule limits,
// frame caps in what the panel gets, Status.warnings.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { ControllerHost, InterceptController, uiExchange, UI_MAX_FRAMES, UI_MAX_FRAME_CHARS, validateRule } from '../../src/ui/controller';
import type { HostMsg, SessionWarning } from '../../src/ui/protocol';

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  warnings: SessionWarning[] = [];
  sent: unknown[] = [];
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
  async send(req: unknown) {
    this.sent.push(req);
    return { id: 'new' };
  }
  push(e: Exchange) {
    const i = this.exchanges.findIndex((x) => x.id === e.id);
    if (i >= 0) this.exchanges[i] = e;
    else this.exchanges.push(e);
    this.emit('exchange', { ...e });
  }
}

const ex = (id: string, extra: Partial<Exchange> = {}): Exchange => ({
  id,
  startedAt: 1,
  method: 'GET',
  url: 'https://api.example.com/v1/users/1',
  requestHeaders: {},
  state: 'completed',
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: { text: '{"id":1}', encoding: 'utf8' },
  ...extra,
});

const rule = (over: Record<string, unknown> = {}) => ({ id: 'r1', enabled: true, match: { url: 'https://api.example.com/graphql' }, action: { kind: 'block', mode: 'status', status: 403 }, ...over });

const controllers: InterceptController[] = [];
afterEach(() => {
  while (controllers.length) controllers.pop()!.dispose();
});

function setup() {
  const host = new FakeHost();
  const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, newRuleId: () => 'rule_new', throttleMs: 5 });
  controllers.push(c);
  const msgs: HostMsg[] = [];
  c.attach((m) => msgs.push(m));
  const replies: HostMsg[] = [];
  const reply = (m: HostMsg) => replies.push(m);
  return { host, c, msgs, replies, reply };
}

const errors = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);

describe('validateRule: graphqlOperation (CONTRACTS §11.2)', () => {
  it('accepts a GraphQL name', () => {
    expect(validateRule(rule({ match: { url: '*/graphql', method: 'POST', graphqlOperation: 'GetUser_2' } })).match.graphqlOperation).toBe('GetUser_2');
  });
  it.each([[''], ['2Fast'], ['Get User'], ['a-b'], [42], ['x'.repeat(201)]])('rejects %j', (op) => {
    expect(() => validateRule(rule({ match: { url: '*/graphql', graphqlOperation: op } }))).toThrow(/graphqlOperation/);
  });
});

describe('validateRule: cors action (CONTRACTS §11.3)', () => {
  it('accepts no options, "*", an origin, credentials', () => {
    expect(validateRule(rule({ action: { kind: 'cors' } })).action).toEqual({ kind: 'cors' });
    expect(validateRule(rule({ action: { kind: 'cors', allowOrigin: '*' } })).action).toEqual({ kind: 'cors', allowOrigin: '*' });
    expect(validateRule(rule({ action: { kind: 'cors', allowOrigin: 'http://localhost:5000', allowCredentials: true } })).action).toMatchObject({ allowCredentials: true });
    expect(validateRule(rule({ action: { kind: 'cors', allowCredentials: true } })).action).toMatchObject({ allowCredentials: true });
  });
  it('rejects * with credentials, header injection, lists, long values, unknown fields', () => {
    expect(() => validateRule(rule({ action: { kind: 'cors', allowOrigin: '*', allowCredentials: true } }))).toThrow(/cannot be combined with allowCredentials/);
    for (const bad of ['', 'http://a.dev\r\nx-evil: 1', 'http://a.dev, http://b.dev', 'http://a dev', `http://${'a'.repeat(500)}.dev`, 7]) {
      expect(() => validateRule(rule({ action: { kind: 'cors', allowOrigin: bad } })), String(bad)).toThrow(/allowOrigin/);
    }
    expect(() => validateRule(rule({ action: { kind: 'cors', allowCredentials: 'yes' } }))).toThrow(/allowCredentials must be a boolean/);
    expect(() => validateRule(rule({ action: { kind: 'cors', headers: {} } }))).toThrow(/unknown field "headers"/);
  });
});

describe('validateRule: WebSocket URLs (CONTRACTS §11.1)', () => {
  it('ws(s):// patterns can only be blocked or failed', () => {
    expect(() => validateRule(rule({ match: { url: 'wss://rt.example.com/socket*' } }))).not.toThrow();
    expect(() => validateRule(rule({ match: { url: 'ws://rt.example.com/*' }, action: { kind: 'fault', fault: 'reset' } }))).not.toThrow();
    for (const action of [{ kind: 'mock', status: 200, body: '' }, { kind: 'mutate', ops: [{ path: '$.a', op: 'null' }] }, { kind: 'cors' }, { kind: 'breakpoint', phase: 'request' }]) {
      expect(() => validateRule(rule({ match: { url: 'wss://rt.example.com/socket' }, action })), action.kind).toThrow(/do not apply to WebSocket/);
    }
  });
  it('REVIEW-5 #16: dead WebSocket rules (truncate fault, graphqlOperation) are refused via ruleProblem', () => {
    expect(() => validateRule(rule({ match: { url: 'ws://rt.example.com/*' }, action: { kind: 'fault', fault: 'truncate' } }))).toThrow(/truncate fault does not apply/);
    expect(() => validateRule(rule({ match: { url: 'wss://rt.example.com/*', graphqlOperation: 'Sub' } }))).toThrow(/GraphQL operation names are not visible/);
  });
});

describe('read-only and streaming exchanges', () => {
  it('createRuleFromExchange / mutateField / send(resentFrom) refuse vm-profile exchanges', async () => {
    const { host, c, replies, reply } = setup();
    host.push(ex('n1', { captured: 'vm-profile' }));
    for (const action of ['mock', 'block', 'breakpoint'] as const) await c.handle({ type: 'createRuleFromExchange', id: 'n1', action }, reply);
    await c.handle({ type: 'mutateField', id: 'n1', path: '$.id', op: 'null' }, reply);
    await c.handle({ type: 'send', request: { method: 'GET', url: 'https://api.example.com/v1/users/1' }, resentFrom: 'n1' }, reply);
    const errs = errors(replies);
    expect(errs).toHaveLength(5);
    for (const e of errs) expect(e).toMatch(/native HTTP client/);
    expect(host.rules).toEqual([]);
    expect(host.sent).toEqual([]);
    // A normal exchange still works.
    host.push(ex('h1'));
    await c.handle({ type: 'send', request: { method: 'GET', url: 'https://api.example.com/v1/users/1' }, resentFrom: 'h1' }, reply);
    expect(host.sent).toHaveLength(1);
  });

  it('a WebSocket exchange only gets block rules; no field mutations on WS / SSE', async () => {
    const { host, c, replies, reply } = setup();
    host.push(ex('w1', { kind: 'websocket', url: 'wss://rt.example.com/socket', status: 101, responseBody: undefined, frames: [] }));
    host.push(ex('s1', { kind: 'sse', url: 'https://api.example.com/events' }));
    await c.handle({ type: 'createRuleFromExchange', id: 'w1', action: 'mock' }, reply);
    await c.handle({ type: 'createRuleFromExchange', id: 'w1', action: 'breakpoint' }, reply);
    await c.handle({ type: 'mutateField', id: 'w1', path: '$.a', op: 'null' }, reply);
    await c.handle({ type: 'mutateField', id: 's1', path: '$.a', op: 'null' }, reply);
    expect(errors(replies)).toHaveLength(4);
    expect(errors(replies)[0]).toMatch(/WebSocket connections can only be blocked/);
    expect(errors(replies)[3]).toMatch(/server-sent event stream/);
    await c.handle({ type: 'createRuleFromExchange', id: 'w1', action: 'block' }, reply);
    expect(host.rules.map((r) => [r.match.url, r.action.kind])).toEqual([['wss://rt.example.com/socket*', 'block']]);
  });
});

describe('frames in what the panel gets (bounded)', () => {
  const frame = (n: number, chars = 10) => ({ dir: 'receive' as const, at: n, kind: 'text' as const, text: 'x'.repeat(chars), size: chars });

  it('uiExchange keeps the newest UI_MAX_FRAMES and counts the rest in framesDropped', () => {
    const e = ex('w1', { kind: 'websocket', frames: Array.from({ length: 450 }, (_, i) => frame(i)), framesDropped: 50 });
    const u = uiExchange(e);
    expect(u.frames).toHaveLength(UI_MAX_FRAMES);
    expect(u.frames![0].at).toBe(450 - UI_MAX_FRAMES);
    expect(u.framesDropped).toBe(50 + 450 - UI_MAX_FRAMES);
    expect(e.frames).toHaveLength(450); // the host's list is untouched
    const small = ex('w2', { kind: 'websocket', frames: [frame(1)] });
    expect(uiExchange(small)).toBe(small);
    const plain = ex('h');
    expect(uiExchange(plain)).toBe(plain);
  });

  it('uiExchange caps the payload characters (always at least the newest frame)', () => {
    const big = Math.floor(UI_MAX_FRAME_CHARS / 3) - 100;
    const u = uiExchange(ex('w', { kind: 'websocket', frames: [frame(1, big), frame(2, big), frame(3, big), frame(4, big)] }));
    expect(u.frames!.map((f) => f.at)).toEqual([2, 3, 4]);
    expect(u.framesDropped).toBe(1);
    const huge = uiExchange(ex('w', { kind: 'websocket', frames: [frame(1, 10), frame(2, UI_MAX_FRAME_CHARS + 5)] }));
    expect(huge.frames!.map((f) => f.at)).toEqual([2]);
  });

  it('snapshot and exchange broadcasts are capped', async () => {
    const { host, c, msgs, reply, replies } = setup();
    host.push(ex('w1', { kind: 'websocket', state: 'pending', frames: Array.from({ length: 500 }, (_, i) => frame(i)) }));
    await new Promise((r) => setTimeout(r, 30));
    const update = msgs.find((m) => m.type === 'exchange') as Extract<HostMsg, { type: 'exchange' }>;
    expect(update.exchange.frames).toHaveLength(UI_MAX_FRAMES);
    expect(update.exchange.framesDropped).toBe(500 - UI_MAX_FRAMES);
    await c.handle({ type: 'ready' }, reply);
    const snap = replies.find((m) => m.type === 'snapshot') as Extract<HostMsg, { type: 'snapshot' }>;
    expect(snap.exchanges[0].frames).toHaveLength(UI_MAX_FRAMES);
  });
});

describe('Status.warnings (CONTRACTS §11.4)', () => {
  it('included when present, broadcast on the host event', () => {
    const { host, c, msgs } = setup();
    expect(c.status().warnings).toBeUndefined();
    host.warnings = [{ id: 'isolate:s1:worker', kind: 'background-isolate', text: 'Requests from background isolate "worker" are not intercepted.', sessionId: 's1' }];
    host.emit('warnings', host.warnings);
    const st = msgs.filter((m): m is Extract<HostMsg, { type: 'status' }> => m.type === 'status').at(-1);
    expect(st?.status.warnings).toEqual(host.warnings);
    host.warnings = [];
    host.emit('warnings', []);
    expect(msgs.filter((m): m is Extract<HostMsg, { type: 'status' }> => m.type === 'status').at(-1)?.status.warnings).toBeUndefined();
  });
});
