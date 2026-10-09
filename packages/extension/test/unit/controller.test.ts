import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { ControllerHost, InterceptController, ruleFromExchangeErrorMessage, validateEdit, validateRule, validateRules } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  resumed: unknown[] = [];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  setRules(r: Rule[]) {
    this.rules = r;
  }
  clear() {
    this.exchanges = this.exchanges.filter((e) => e.state.startsWith('paused'));
  }
  resume(id: string, edit?: unknown) {
    if (edit && (edit as { status?: number }).status === 9999) throw new Error('invalid status 9999');
    this.resumed.push([id, edit]);
  }
  abort(id: string) {
    this.resumed.push(['abort', id]);
  }
  push(e: Exchange) {
    const i = this.exchanges.findIndex((x) => x.id === e.id);
    if (i >= 0) this.exchanges[i] = e;
    else this.exchanges.push(e);
    this.emit('exchange', { ...e });
  }
}

const ex = (id: string, state: Exchange['state'] = 'completed', extra: Partial<Exchange> = {}): Exchange => ({
  id,
  startedAt: 1,
  method: 'GET',
  url: `https://api.example.com/v1/items/${id}?q=1`,
  requestHeaders: {},
  state,
  status: 200,
  responseHeaders: { 'content-type': 'application/json', 'content-length': '2' },
  responseBody: { text: '[]', encoding: 'utf8' },
  ...extra,
});

function setup(throttleMs = 20) {
  const host = new FakeHost();
  let enabled = true;
  const saved: Rule[][] = [];
  const c = new InterceptController({
    host,
    saveRules: (r) => saved.push(r),
    getEnabled: () => enabled,
    setEnabled: async (b) => {
      enabled = b;
    },
    newRuleId: () => 'rule_new',
    throttleMs,
  });
  const got: HostMsg[] = [];
  c.attach((m) => got.push(m));
  const replies: HostMsg[] = [];
  const reply = (m: HostMsg) => replies.push(m);
  return { host, c, got, replies, reply, saved, isEnabled: () => enabled };
}

describe('InterceptController', () => {
  it('answers every ready with a snapshot (rules + status)', async () => {
    const { host, c, replies, reply } = setup();
    host.exchanges = [ex('a')];
    host.rules = [{ id: 'r1', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    await c.handle({ type: 'ready' }, reply);
    await c.handle({ type: 'ready' }, reply);
    expect(replies.map((m) => m.type)).toEqual(['snapshot', 'snapshot']);
    expect(replies[0]).toMatchObject({ exchanges: [{ id: 'a' }], rules: [{ id: 'r1' }], status: { proxyRunning: true, port: 9123, interceptEnabled: true, sessions: 0 } });
    expect(c.readyCount).toBe(2);
  });

  it('coalesces exchange updates per id within the throttle window', async () => {
    vi.useFakeTimers();
    const { host, got } = setup(50);
    host.push(ex('a', 'pending'));
    host.push(ex('a', 'completed'));
    host.push(ex('b', 'pending'));
    expect(got).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(got.map((m) => (m.type === 'exchange' ? `${m.exchange.id}:${m.exchange.state}` : m.type))).toEqual(['a:completed', 'b:pending']);
    vi.useRealTimers();
  });

  it('tracks the paused count for the status bar', () => {
    const { host, c } = setup();
    const counts: number[] = [];
    c.onPausedCount((n) => counts.push(n));
    host.push(ex('a', 'paused-response'));
    host.push(ex('b', 'paused-request'));
    host.push(ex('a', 'completed'));
    host.emit('removed', ['b']);
    expect(counts).toEqual([1, 2, 1, 0]);
    expect(c.pausedCount).toBe(0);
  });

  it('setRules persists and echoes rules', async () => {
    const { c, host, got, saved, reply } = setup();
    const rules: Rule[] = [{ id: 'r', enabled: true, match: { url: '*' }, action: { kind: 'mock', status: 200, body: 'x' } }];
    await c.handle({ type: 'setRules', rules }, reply);
    expect(host.rules).toEqual(rules);
    expect(saved).toEqual([rules]);
    expect(got).toContainEqual({ type: 'rules', rules });
  });

  it('createRuleFromExchange inserts the new rule FIRST and echoes rules', async () => {
    const { c, host, got, reply } = setup();
    host.exchanges = [ex('a')];
    host.rules = [{ id: 'old', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    await c.handle({ type: 'createRuleFromExchange', id: 'a', action: 'mock' }, reply);
    expect(host.rules.map((r) => r.id)).toEqual(['rule_new', 'old']);
    expect(host.rules[0]).toMatchObject({ match: { method: 'GET', url: 'https://api.example.com/v1/items/a*' }, action: { kind: 'mock', status: 200, body: '[]' } });
    expect(got.at(-1)).toMatchObject({ type: 'rules' });
  });

  it('reports errors for unknown exchanges and invalid edits', async () => {
    const { c, replies, reply } = setup();
    await c.handle({ type: 'createRuleFromExchange', id: 'nope', action: 'block' }, reply);
    await c.handle({ type: 'resume', id: 'x', edit: { status: 9999 } }, reply);
    expect(replies.map((m) => m.type)).toEqual(['error', 'error']);
    expect(replies[1]).toMatchObject({ message: 'edit: status must be an integer 100–599' });
  });

  it('clear sends cleared and then a fresh snapshot that keeps in-flight exchanges', async () => {
    const { c, host, got, reply } = setup();
    host.exchanges = [ex('a'), ex('p', 'paused-request')];
    await c.handle({ type: 'clear' }, reply);
    expect(got.map((m) => m.type)).toEqual(['cleared', 'snapshot']);
    expect((got[1] as Extract<HostMsg, { type: 'snapshot' }>).exchanges.map((e) => e.id)).toEqual(['p']);
  });

  it('setInterceptEnabled updates the setting and sends status', async () => {
    const { c, got, reply, isEnabled } = setup();
    await c.handle({ type: 'setInterceptEnabled', enabled: false }, reply);
    expect(isEnabled()).toBe(false);
    expect(got).toContainEqual({ type: 'status', status: { proxyRunning: true, port: 9123, interceptEnabled: false, sessions: 0 } });
  });

  it('forwards resume/abort and broadcasts removed + session status', async () => {
    const { c, host, got, reply } = setup();
    await c.handle({ type: 'resume', id: 'a', edit: { body: 'x' } }, reply);
    await c.handle({ type: 'abort', id: 'b' }, reply);
    expect(host.resumed).toEqual([['a', { body: 'x' }], ['abort', 'b']]);
    host.emit('removed', ['z']);
    c.setSessions(2);
    expect(got.map((m) => m.type)).toEqual(['removed', 'status']);
  });

  it('ignores garbage messages', async () => {
    const { c, replies, reply } = setup();
    await c.handle(undefined, reply);
    await c.handle({ nope: 1 }, reply);
    await c.handle({ type: 'unknown' }, reply);
    expect(replies).toEqual([]);
  });
});

const okRule = (over: Record<string, unknown> = {}) => ({ id: 'r1', enabled: true, match: { url: 'https://x/*' }, action: { kind: 'block', mode: 'reset' }, ...over });

describe('host-side validation of webview messages (review #7)', () => {
  it.each<[string, unknown]>([
    ['not an object', 'x'],
    ['missing id', { ...okRule(), id: undefined }],
    ['empty id', okRule({ id: '' })],
    ['enabled not boolean', okRule({ enabled: 'yes' })],
    ['no match (must not become match-all)', okRule({ match: undefined })],
    ['match without url', okRule({ match: { method: 'GET' } })],
    ['empty url', okRule({ match: { url: '  ' } })],
    ['url not string', okRule({ match: { url: 42 } })],
    ['bad method', okRule({ match: { url: '*', method: 'GE T' } })],
    ['unknown match field', okRule({ match: { url: '*', host: 'x' } })],
    ['no action', okRule({ action: undefined })],
    ['unknown kind', okRule({ action: { kind: 'redirect' } })],
    ['mock status 99', okRule({ action: { kind: 'mock', status: 99, body: '' } })],
    ['mock status 600', okRule({ action: { kind: 'mock', status: 600, body: '' } })],
    ['mock status float', okRule({ action: { kind: 'mock', status: 200.5, body: '' } })],
    ['mock body missing', okRule({ action: { kind: 'mock', status: 200 } })],
    ['mock header non-string', okRule({ action: { kind: 'mock', status: 200, body: '', headers: { a: 1 } } })],
    ['mock header CRLF', okRule({ action: { kind: 'mock', status: 200, body: '', headers: { a: 'x\r\nSet-Cookie: y' } } })],
    ['mock header bad name', okRule({ action: { kind: 'mock', status: 200, body: '', headers: { 'a b': 'x' } } })],
    ['mock array header (mock headers are flat)', okRule({ action: { kind: 'mock', status: 200, body: '', headers: { a: ['x'] } } })],
    ['negative delay', okRule({ action: { kind: 'mock', status: 200, body: '', delayMs: -1 } })],
    ['block bad mode', okRule({ action: { kind: 'block', mode: 'drop' } })],
    ['block bad status', okRule({ action: { kind: 'block', mode: 'status', status: 1000 } })],
    ['breakpoint bad phase', okRule({ action: { kind: 'breakpoint', phase: 'later' } })],
    ['unknown action field', okRule({ action: { kind: 'breakpoint', phase: 'request', extra: 1 } })],
  ])('rejects rule: %s', (_n, rule) => {
    expect(() => validateRule(rule)).toThrow();
  });

  it('accepts every valid action shape', () => {
    for (const action of [
      { kind: 'mock', status: 200, body: '{}' },
      { kind: 'mock', status: 404, headers: { 'content-type': 'application/json' }, body: '', delayMs: 250 },
      { kind: 'block', mode: 'reset' },
      { kind: 'block', mode: 'status', status: 403 },
      { kind: 'block', mode: 'status' },
      { kind: 'breakpoint', phase: 'both' },
    ]) {
      expect(() => validateRule(okRule({ action, name: 'n', match: { url: '/api\\/v1/i', method: 'post' } }))).not.toThrow();
    }
    expect(() => validateRule(okRule({ match: { url: '*', method: '' } }))).not.toThrow();
  });

  it('rejects non-arrays and duplicate ids', () => {
    expect(() => validateRules({})).toThrow(/array/);
    expect(() => validateRules([okRule(), okRule()])).toThrow(/duplicate id/);
  });

  it.each<[string, unknown, ('request' | 'response')?]>([
    ['header value number', { headers: { a: 1 } }],
    ['header array with number', { headers: { a: ['x', 2] } }],
    ['body not string', { body: 1 }],
    ['status float', { status: 200.1 }],
    ['status out of range', { status: 42 }],
    ['relative url', { url: '/x' }],
    ['file url', { url: 'file:///etc/passwd' }],
    ['bad method', { method: 'G E T' }],
    ['unknown field', { foo: 1 }],
    ['status on a paused request', { status: 200 }, 'request'],
    ['url on a paused response', { url: 'https://x/' }, 'response'],
    ['not an object', 'x'],
  ])('rejects edit: %s', (_n, edit, phase) => {
    expect(() => validateEdit(edit, phase)).toThrow();
  });

  it('accepts valid edits', () => {
    expect(validateEdit(undefined)).toBeUndefined();
    expect(validateEdit({ method: 'PUT', url: 'https://api.example.com/x?y=1', headers: { a: 'b', 'set-cookie': ['1', '2'] }, body: '' }, 'request')).toBeTruthy();
    expect(validateEdit({ status: 299, headers: {}, body: 'x' }, 'response')).toBeTruthy();
  });

  it('setRules with an invalid rule: error reply, nothing applied, nothing persisted', async () => {
    const { c, host, got, saved, replies, reply } = setup();
    host.rules = [okRule() as never];
    await c.handle({ type: 'setRules', rules: [okRule({ id: 'ok' }), { id: 'bad', enabled: true, action: { kind: 'block', mode: 'reset' } }] }, reply);
    expect(replies).toEqual([{ type: 'error', message: expect.stringMatching(/rule 2: match is required/) }]);
    expect(host.rules.map((r) => r.id)).toEqual(['r1']);
    expect(saved).toEqual([]);
    expect(got.filter((m) => m.type === 'rules')).toEqual([]);
  });

  it('resume with an invalid edit is rejected before reaching the proxy (phase-aware)', async () => {
    const { c, host, replies, reply } = setup();
    host.exchanges = [ex('p', 'paused-response')];
    await c.handle({ type: 'resume', id: 'p', edit: { headers: { 'content-type': 7 } } }, reply);
    await c.handle({ type: 'resume', id: 'p', edit: { url: 'https://other/' } }, reply);
    await c.handle({ type: 'resume', id: 42 }, reply);
    expect(replies.map((m) => m.type)).toEqual(['error', 'error', 'error']);
    expect(host.resumed).toEqual([]);
    await c.handle({ type: 'resume', id: 'p', edit: { status: 201, body: 'ok' } }, reply);
    expect(host.resumed).toEqual([['p', { status: 201, body: 'ok' }]]);
  });

  it('setInterceptEnabled requires a boolean', async () => {
    const { c, replies, reply, isEnabled } = setup();
    await c.handle({ type: 'setInterceptEnabled', enabled: 'false' }, reply);
    expect(replies[0]).toMatchObject({ type: 'error' });
    expect(isEnabled()).toBe(true);
  });
});

describe('createRuleFromExchange failures (review #8)', () => {
  it('maps the proxy typed error codes to clear messages', () => {
    expect(ruleFromExchangeErrorMessage(Object.assign(new Error('x'), { code: 'truncated' }), 'mock')).toMatch(/truncated/);
    expect(ruleFromExchangeErrorMessage(Object.assign(new Error('x'), { code: 'binary' }), 'mock')).toMatch(/binary/);
    expect(ruleFromExchangeErrorMessage(new Error('boom'), 'block')).toMatch(/a block rule.*boom/);
  });

  it('replies with an error (no rule added) when ruleFromExchange throws', async () => {
    const { c, host, replies, reply, saved } = setup();
    // A binary response: whatever the proxy's ruleFromExchange does (throw a typed error, or build a
    // rule), the host must either add a VALID rule or reply with an error — never persist garbage.
    host.exchanges = [ex('bin', 'completed', { responseBody: { text: 'AAEC', encoding: 'base64' } })];
    await c.handle({ type: 'createRuleFromExchange', id: 'bin', action: 'mock' }, reply);
    const added = host.rules;
    if (replies.length) {
      expect(replies[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/Can't create a mock rule/) });
      expect(added).toEqual([]);
      expect(saved).toEqual([]);
    } else {
      expect(() => validateRules(added)).not.toThrow();
    }
  });

  it('a throwing ruleFromExchange becomes an error reply', async () => {
    const { c, host, replies, reply } = setup();
    host.exchanges = [{ ...ex('weird'), url: undefined as unknown as string, method: undefined as unknown as string, responseHeaders: 7 as never }];
    await c.handle({ type: 'createRuleFromExchange', id: 'weird', action: 'mock' }, reply);
    expect(replies[0]?.type).toBe('error');
    expect(host.rules).toEqual([]);
  });
});

describe('status carries the LAN listener (CONTRACTS §7)', () => {
  it('includes lan {host, port} while open, never a token', async () => {
    const { c, host, replies, reply } = setup();
    (host as unknown as { lan?: unknown }).lan = { host: '192.168.1.23', port: 9400, token: 'SECRET' };
    await c.handle({ type: 'ready' }, reply);
    const snap = replies[0] as Extract<HostMsg, { type: 'snapshot' }>;
    expect(snap.status.lan).toEqual({ host: '192.168.1.23', port: 9400 });
    expect(JSON.stringify(replies)).not.toContain('SECRET');
    (host as unknown as { lan?: unknown }).lan = undefined;
    expect(c.status().lan).toBeUndefined();
  });
});
