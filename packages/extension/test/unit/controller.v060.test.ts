// CONTRACTS §12 (v0.6.0): sequence / mapRemote / rewrite / bodyFile / shared validation, shared + personal rules,
// shareRule / approveSharedRules, recordings messages, expireToken preset, authFlows, Status.replay / sharedRules.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, ReplayEntry, ReplayOptions, Rule } from '@flutter-intercept/proxy';
import type { AuthAnalysis } from '../../src/analysis/types';
import type { Recording, RecordingMeta, RecordingService } from '../../src/recordings/types';
import type { SharedRulesState } from '../../src/rules/types';
import { ControllerDeps, ControllerHost, expireTokenRule, InterceptController, isRecordable, MAX_SEQUENCE_STEPS, validateRule, validateRules } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
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
  setRules(r: Rule[]) {
    this.rules = r;
  }
  clear() {
    this.exchanges = [];
  }
  resume() {}
  abort() {}
  setReplay(entries: ReplayEntry[] | undefined, opts?: ReplayOptions, meta?: { id?: string; name: string }) {
    this.replayCalls.push([entries, opts, meta]);
    this.replay = entries ? { ...(meta?.id ? { id: meta.id } : {}), recording: meta?.name ?? '?', fallback: opts?.fallback ?? 'passthrough' } : undefined;
    this.emit('replay', this.replay);
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

const base = { id: 'r1', enabled: true, match: { url: 'https://api.example.com/*' } };
const rule = (action: unknown, over: Record<string, unknown> = {}) => ({ ...base, action, ...over });
const mock = (status = 500) => ({ kind: 'mock', status, body: '' });

const controllers: InterceptController[] = [];
afterEach(() => {
  while (controllers.length) controllers.pop()!.dispose();
  vi.useRealTimers();
});

class FakeShared {
  st: SharedRulesState = { file: '.vscode/flutter-intercept.json', rules: [], problems: [], pendingApproval: [] };
  saved: Rule[][] = [];
  approved = 0;
  failSave = false;
  removed: string[] = [];
  reasons: string[] = [];
  state() {
    return this.st;
  }
  async save(rules: Rule[]) {
    if (this.failSave) throw new Error('disk full');
    this.saved.push(rules);
    // Like the real service: the file's rules come back validated; held-back ones stay pending.
    this.st = { ...this.st, rules: rules.filter((r) => !this.st.pendingApproval.some((p) => p.id === r.id)).map((r) => ({ ...r, shared: true })) };
  }
  async approvePending() {
    this.approved++;
    this.st = { ...this.st, rules: [...this.st.rules, ...this.st.pendingApproval], pendingApproval: [] };
  }
}

class FakeRecordings implements RecordingService {
  recs = new Map<string, Recording>();
  saves: { name: string; ids: string[]; redact?: boolean }[] = [];
  async list(): Promise<RecordingMeta[]> {
    return [...this.recs.values()].map(({ entries: _e, version: _v, ...m }) => m);
  }
  async save(name: string, exchanges: Exchange[], opts?: { redact?: boolean }): Promise<RecordingMeta> {
    this.saves.push({ name, ids: exchanges.map((e) => e.id), redact: opts?.redact });
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const rec: Recording = { id, name, createdAt: 5, exchanges: exchanges.length, path: `/p/${id}.json`, redacted: !!opts?.redact, version: 1, entries: exchanges };
    this.recs.set(id, rec);
    const { entries: _e, version: _v, ...meta } = rec;
    return meta;
  }
  async load(id: string): Promise<Recording> {
    const r = this.recs.get(id);
    if (!r) throw new Error(`no recording ${id}`);
    return r;
  }
  async remove(id: string) {
    this.recs.delete(id);
  }
  async export(id: string, dest: string) {
    await this.load(id);
    return dest;
  }
  toReplay(rec: Recording): ReplayEntry[] {
    return rec.entries.map((e) => ({ method: e.method, url: e.url, status: e.status ?? 0, headers: e.responseHeaders ?? {} }));
  }
  diff() {
    return [];
  }
  diffText(rec: Recording) {
    return rec.name;
  }
}

function setup(extra: Partial<ControllerDeps> = {}) {
  const host = new FakeHost();
  const saved: Rule[][] = [];
  let n = 0;
  const c = new InterceptController({
    host,
    saveRules: (r) => saved.push(r),
    getEnabled: () => true,
    setEnabled: async () => undefined,
    newRuleId: () => `rule_${++n}`,
    throttleMs: 5,
    ...extra,
  });
  controllers.push(c);
  const msgs: HostMsg[] = [];
  c.attach((m) => msgs.push(m));
  const replies: HostMsg[] = [];
  const reply = (m: HostMsg) => replies.push(m);
  return { host, c, msgs, replies, reply, saved };
}

const errors = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);
const last = <T extends HostMsg['type']>(msgs: HostMsg[], type: T) => msgs.filter((m) => m.type === type).pop() as Extract<HostMsg, { type: T }> | undefined;

describe('validateRule: sequence (CONTRACTS §12.3)', () => {
  it('accepts steps with counts, passthrough and then', () => {
    const r = validateRule(rule({ kind: 'sequence', steps: [{ action: mock(500), count: 2 }, { action: { kind: 'passthrough' } }], then: 'loop' }));
    expect(r.action).toEqual({ kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, body: '' }, count: 2 }, { action: { kind: 'passthrough' } }], then: 'loop' });
  });
  it('validates each step as its action, recursively', () => {
    expect(() => validateRule(rule({ kind: 'sequence', steps: [{ action: { kind: 'mock', status: 999, body: '' } }] }))).toThrow(/steps\[0\]\.action: status/);
    expect(() => validateRule(rule({ kind: 'sequence', steps: [{ action: { kind: 'fault', fault: 'nope' } }] }))).toThrow(/fault must be/);
    expect(() => validateRule(rule({ kind: 'sequence', steps: [{ action: { kind: 'block', mode: 'status', extra: 1 } }] }))).toThrow(/unknown field "extra"/);
  });
  it.each([
    [{ kind: 'sequence', steps: [] }, /1–50 steps/],
    [{ kind: 'sequence', steps: Array.from({ length: MAX_SEQUENCE_STEPS + 1 }, () => ({ action: mock() })) }, /1–50 steps/],
    [{ kind: 'sequence', steps: [{ action: { kind: 'breakpoint', phase: 'request' } }] }, /cannot be a breakpoint/],
    [{ kind: 'sequence', steps: [{ action: { kind: 'sequence', steps: [{ action: mock() }] } }] }, /cannot be another sequence/],
    [{ kind: 'sequence', steps: [{ action: mock(), count: 0 }] }, /count must be an integer 1–1000/],
    [{ kind: 'sequence', steps: [{ action: mock(), count: 1001 }] }, /count/],
    [{ kind: 'sequence', steps: [{ action: mock(), count: 1.5 }] }, /count/],
    [{ kind: 'sequence', steps: [{ action: mock() }], then: 'forever' }, /then must be/],
    [{ kind: 'sequence', steps: [{ action: mock(), extra: true }] }, /unknown field/],
    [{ kind: 'sequence', steps: ['mock'] }, /must be an object/],
    [{ kind: 'passthrough' }, /only a sequence step/],
  ])('rejects %j', (action, re) => {
    expect(() => validateRule(rule(action))).toThrow(re);
  });
  it('ruleProblem still applies (no mock steps on ws:// via the top-level kind check)', () => {
    expect(() => validateRule(rule({ kind: 'sequence', steps: [{ action: mock() }] }, { match: { url: 'wss://a.dev/socket' } }))).toThrow(/WebSocket/);
  });
});

describe('validateRule: mapRemote (CONTRACTS §12.6)', () => {
  it.each(['https://staging.example.com', 'http://localhost:8080/api/v2', 'http://127.0.0.1:3000/', 'http://[::1]:9000'])('accepts %s', (to) => {
    expect(validateRule(rule({ kind: 'mapRemote', to, preserveHost: true })).action).toEqual({ kind: 'mapRemote', to, preserveHost: true });
  });
  it.each([
    ['staging.example.com', /absolute/],
    ['/api', /absolute/],
    ['ftp://a.dev', /http\(s\)/],
    ['https://user:pw@a.dev', /user info/],
    ['https://a.dev/#x', /fragment/],
    ['', /absolute/],
    [42, /absolute/],
    [`https://a.dev/${'x'.repeat(2050)}`, /2048/],
  ])('rejects %j', (to, re) => {
    expect(() => validateRule(rule({ kind: 'mapRemote', to }))).toThrow(re);
  });
  it('preserveHost must be boolean', () => {
    expect(() => validateRule(rule({ kind: 'mapRemote', to: 'https://a.dev', preserveHost: 'yes' }))).toThrow(/preserveHost/);
  });
});

describe('validateRule: rewrite (CONTRACTS §12.6)', () => {
  it('accepts request and response changes', () => {
    const a = {
      kind: 'rewrite',
      request: { setHeaders: { 'x-env': 'staging' }, removeHeaders: ['x-debug'], replaceBody: [{ find: 'a', replace: 'b', all: true }] },
      response: { status: 503, setHeaders: { 'retry-after': '5' }, removeHeaders: ['etag'], replaceBody: [{ find: '"premium":false', replace: '"premium":true' }] },
    };
    expect(validateRule(rule(a)).action).toEqual(a);
  });
  it.each([
    [{ kind: 'rewrite' }, /needs request and\/or response/],
    [{ kind: 'rewrite', request: { status: 200 } }, /unknown field "status"/],
    [{ kind: 'rewrite', response: { status: 99 } }, /status/],
    [{ kind: 'rewrite', request: { setHeaders: { 'bad name': 'x' } } }, /invalid header name/],
    [{ kind: 'rewrite', request: { setHeaders: { 'x-a': 'a\r\nb' } } }, /CR, LF/],
    [{ kind: 'rewrite', request: { setHeaders: { 'Content-Length': '5' } } }, /can't be set/],
    [{ kind: 'rewrite', request: { setHeaders: { host: 'evil.dev' } } }, /can't be set/],
    [{ kind: 'rewrite', request: { removeHeaders: ['ok', 'not ok'] } }, /invalid header name/],
    [{ kind: 'rewrite', request: { removeHeaders: 'x' } }, /list of header names/],
    [{ kind: 'rewrite', request: { setHeaders: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`x-${i}`, 'v'])) } }, /at most 50 headers/],
    [{ kind: 'rewrite', response: { removeHeaders: Array.from({ length: 51 }, (_, i) => `x-${i}`) } }, /at most 50 headers/],
    [{ kind: 'rewrite', response: { replaceBody: Array.from({ length: 21 }, () => ({ find: 'a', replace: 'b' })) } }, /at most 20/],
    [{ kind: 'rewrite', response: { replaceBody: [{ find: '', replace: 'b' }] } }, /find must be non-empty/],
    [{ kind: 'rewrite', response: { replaceBody: [{ find: 'x'.repeat(10 * 1024 + 1), replace: 'b' }] } }, /10 KB/],
    [{ kind: 'rewrite', response: { replaceBody: [{ find: 'a' }] } }, /replace must be text/],
    [{ kind: 'rewrite', response: { replaceBody: [{ find: 'a', replace: 'b', all: 'yes' }] } }, /all must be a boolean/],
    [{ kind: 'rewrite', response: { replaceBody: [{ find: 'a', replace: 'b', regex: true }] } }, /unknown field "regex"/],
  ])('rejects %j', (action, re) => {
    expect(() => validateRule(rule(action))).toThrow(re);
  });
});

describe('validateRule: bodyFile and shared (CONTRACTS §12.1–12.2)', () => {
  it('a mock may take its body from a workspace-relative file (body defaults to "")', () => {
    const r = validateRule(rule({ kind: 'mock', status: 200, bodyFile: '.vscode/flutter-intercept/mocks/user.json' }));
    expect(r.action).toEqual({ kind: 'mock', status: 200, bodyFile: '.vscode/flutter-intercept/mocks/user.json', body: '' });
  });
  it.each([['/etc/passwd'], ['C:\\x.json'], ['\\\\server\\share'], ['../secrets.json'], ['mocks/../../x'], ['mocks\\..\\x'], ['~/x'], [''], ['a\0b'], ['x'.repeat(301)], [7]])('rejects bodyFile %j', (bodyFile) => {
    expect(() => validateRule(rule({ kind: 'mock', status: 200, bodyFile }))).toThrow(/bodyFile/);
  });
  it('a mock without bodyFile still needs a body', () => {
    expect(() => validateRule(rule({ kind: 'mock', status: 200 }))).toThrow(/body must be a string/);
  });
  it('accepts shared: true only', () => {
    expect(validateRule(rule(mock(), { shared: true })).shared).toBe(true);
    expect(() => validateRule(rule(mock(), { shared: false }))).toThrow(/shared must be true/);
  });
  it('still drops `used` and does not mutate the input', () => {
    const raw = rule({ kind: 'mock', status: 200, bodyFile: 'm.json' }, { used: 3 });
    const r = validateRule(raw);
    expect('used' in r).toBe(false);
    expect('body' in (raw.action as object)).toBe(false);
  });
});

describe('expireTokenRule (CONTRACTS §12.3)', () => {
  it('builds sequence [401 × count, passthrough], named "Expire token: …", query dropped', () => {
    const r = expireTokenRule('x', 'https://api.example.com/v1/me?access_token=abc', 2);
    expect(r).toEqual({
      id: 'x',
      enabled: true,
      name: 'Expire token: https://api.example.com/v1/me*',
      match: { url: 'https://api.example.com/v1/me*' },
      action: {
        kind: 'sequence',
        steps: [{ action: { kind: 'mock', status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"token_expired"}' }, count: 2 }, { action: { kind: 'passthrough' } }],
        then: 'last',
      },
    });
    expect(validateRule(r)).toEqual(r);
  });
  it('keeps globs, adds the method and prefix', () => {
    const r = expireTokenRule('x', '*/api/*', 1, { method: 'get', namePrefix: '[agent] ' });
    expect(r.match).toEqual({ url: '*/api/*', method: 'GET' });
    expect(r.name).toBe('[agent] Expire token: GET */api/*');
  });
  it.each([[0], [1001], [1.5]])('rejects count %j', (count) => {
    expect(() => expireTokenRule('x', 'https://a.dev/', count)).toThrow(/count/);
  });
});

describe('shared + personal rules (CONTRACTS §12.1)', () => {
  const personal = (id: string): Rule => ({ id, enabled: true, match: { url: `https://a.dev/${id}*` }, action: { kind: 'block', mode: 'status', status: 403 } });
  const sharedRule = (id: string): Rule => ({ ...personal(id), shared: true });

  it('setSharedRules puts shared first, persists nothing, broadcasts rules + status', () => {
    const shared = new FakeShared();
    shared.st = { ...shared.st, rules: [sharedRule('s1')], pendingApproval: [sharedRule('s2')], problems: ['rule 3: bad'] };
    const { host, c, msgs, saved } = setup({ shared });
    host.rules = [personal('p1')];
    c.setSharedRules([personal('s1')]); // the flag is added
    expect(host.rules.map((r) => [r.id, r.shared])).toEqual([['s1', true], ['p1', undefined]]);
    expect(saved).toEqual([]);
    expect(last(msgs, 'rules')!.rules.map((r) => r.id)).toEqual(['s1', 'p1']);
    expect(last(msgs, 'status')!.status.sharedRules).toEqual({ file: '.vscode/flutter-intercept.json', count: 1, problems: ['rule 3: bad'], pendingApproval: 1 });
  });

  it('a shared rule whose id a personal rule uses is skipped', () => {
    const { host, c } = setup({ shared: new FakeShared() });
    host.rules = [personal('p1')];
    c.setSharedRules([sharedRule('p1'), sharedRule('s1'), sharedRule('s1')]);
    expect(host.rules.map((r) => r.id)).toEqual(['s1', 'p1']);
  });

  it('applyRules persists personal rules only and keeps shared ones first', () => {
    const { host, c, saved } = setup({ shared: new FakeShared() });
    c.setSharedRules([sharedRule('s1')]);
    c.applyRules([personal('p2'), sharedRule('s1'), personal('p1')]);
    expect(host.rules.map((r) => r.id)).toEqual(['s1', 'p2', 'p1']);
    expect(saved.pop()!.map((r) => r.id)).toEqual(['p2', 'p1']);
  });

  it('editing a shared rule in the panel saves the approved rules only (the service keeps pending ones), not workspaceState', async () => {
    const shared = new FakeShared();
    shared.st = { ...shared.st, pendingApproval: [sharedRule('held')] };
    const { host, c, saved, reply } = setup({ shared });
    c.setSharedRules([sharedRule('s1'), sharedRule('s2')]);
    await c.handle({ type: 'setRules', rules: [{ ...sharedRule('s1'), enabled: false }, personal('p1')] }, reply);
    await vi.waitFor(() => expect(shared.saved.length).toBe(1));
    expect(shared.saved[0].map((r) => [r.id, r.enabled])).toEqual([['s1', false]]);
    expect(saved.pop()!.map((r) => r.id)).toEqual(['p1']);
    await vi.waitFor(() => expect(host.rules.map((r) => [r.id, r.enabled])).toEqual([['s1', false], ['p1', true]]));
  });

  it('unchanged shared rules (other key order, used counts) do not touch the file', async () => {
    const shared = new FakeShared();
    const { c, reply } = setup({ shared });
    c.setSharedRules([sharedRule('s1')]);
    const s = sharedRule('s1');
    await c.handle({ type: 'setRules', rules: [{ action: s.action, match: s.match, enabled: true, id: 's1', shared: true, used: 4 }] }, reply);
    await new Promise((r) => setTimeout(r, 5));
    expect(shared.saved).toEqual([]);
  });

  it('without a shared service, shared rules cannot be changed from the panel', async () => {
    const { c, replies, reply } = setup();
    await c.handle({ type: 'setRules', rules: [sharedRule('s1')] }, reply);
    expect(errors(replies)[0]).toMatch(/flutter-intercept\.json/);
  });

  it('a failed shared write is reported as an error', async () => {
    const shared = new FakeShared();
    shared.failSave = true;
    const { c, msgs } = setup({ shared });
    c.setSharedRules([sharedRule('s1')]);
    c.applyRules([]);
    await vi.waitFor(() => expect(errors(msgs)).toEqual(['disk full']));
  });

  it('shareRule moves a personal rule into the file (same id) and back (new id)', async () => {
    const shared = new FakeShared();
    const { host, c, saved, reply, replies } = setup({ shared });
    host.rules = [personal('p1'), personal('p2')];
    await c.handle({ type: 'shareRule', id: 'p2', shared: true }, reply);
    expect(errors(replies)).toEqual([]);
    expect(shared.saved.pop()!.map((r) => r.id)).toEqual(['p2']);
    expect(host.rules.map((r) => [r.id, r.shared])).toEqual([['p2', true], ['p1', undefined]]);
    expect(saved.pop()!.map((r) => r.id)).toEqual(['p1']);

    await c.handle({ type: 'shareRule', id: 'p2', shared: false }, reply);
    expect(shared.saved.pop()).toEqual([]);
    expect(host.rules.map((r) => [r.id, r.shared])).toEqual([['rule_1', undefined], ['p1', undefined]]);
    expect(saved.pop()!.map((r) => r.id)).toEqual(['rule_1', 'p1']);
    expect(saved.flat().every((r) => !('shared' in r))).toBe(true);
  });

  it('shareRule restores the personal rule when the write fails', async () => {
    const shared = new FakeShared();
    shared.failSave = true;
    const { host, c, reply, replies, saved } = setup({ shared });
    host.rules = [personal('p1'), personal('p2')];
    await c.handle({ type: 'shareRule', id: 'p2', shared: true }, reply);
    expect(errors(replies)).toEqual(['disk full']);
    expect(host.rules.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(saved.pop()!.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('shareRule / approveSharedRules without a service, or for an unknown rule, answer an error', async () => {
    const a = setup();
    await a.c.handle({ type: 'shareRule', id: 'x', shared: true }, a.reply);
    await a.c.handle({ type: 'approveSharedRules' }, a.reply);
    expect(errors(a.replies)).toEqual([expect.stringMatching(/workspace folder/), expect.stringMatching(/workspace folder/)]);
    const b = setup({ shared: new FakeShared() });
    await b.c.handle({ type: 'shareRule', id: 'nope', shared: true }, b.reply);
    await b.c.handle({ type: 'shareRule', id: 'nope', shared: 'yes' }, b.reply);
    expect(errors(b.replies)).toEqual(['That rule no longer exists.', expect.stringMatching(/shared must be a boolean/)]);
  });

  it('approveSharedRules approves and applies the held-back rules', async () => {
    const shared = new FakeShared();
    shared.st = { ...shared.st, rules: [sharedRule('s1')], pendingApproval: [{ ...sharedRule('map'), action: { kind: 'mapRemote', to: 'https://staging.example.com' } }] };
    const { host, c, msgs, reply } = setup({ shared });
    c.setSharedRules(shared.st.rules);
    await c.handle({ type: 'approveSharedRules' }, reply);
    expect(shared.approved).toBe(1);
    expect(host.rules.map((r) => r.id)).toEqual(['s1', 'map']);
    expect(last(msgs, 'status')!.status.sharedRules?.pendingApproval).toBe(0);
  });

  it('a spent shared rule is dropped for the session only', () => {
    const shared = new FakeShared();
    const { host, c, saved } = setup({ shared });
    c.setSharedRules([{ ...sharedRule('s1'), times: 1 }]);
    host.rules = [...host.rules, personal('p1')];
    host.emit('rule-spent', 's1', 'times');
    expect(host.rules.map((r) => r.id)).toEqual(['p1']);
    expect(shared.saved).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('rules made from an exchange go first among the personal rules', async () => {
    const { host, c, reply } = setup({ shared: new FakeShared() });
    c.setSharedRules([sharedRule('s1')]);
    host.rules = [...host.rules, personal('p1')];
    host.exchanges = [ex('e1')];
    await c.handle({ type: 'createRuleFromExchange', id: 'e1', action: 'block' }, reply);
    expect(host.rules.map((r) => r.id)).toEqual(['s1', 'rule_1', 'p1']);
  });

  it('validateRules still refuses duplicate ids across shared and personal', () => {
    expect(() => validateRules([sharedRule('a'), personal('a')])).toThrow(/duplicate id/);
  });
});

describe('removeShared, pending reasons, openSharedRules / openBodyFile (CONTRACTS §12.7 note)', () => {
  const sharedRule = (id: string): Rule => ({ id, enabled: true, shared: true, match: { url: `https://a.dev/${id}*` }, action: { kind: 'block', mode: 'status', status: 403 } });
  class RemovingShared extends FakeShared {
    async removeShared(id: string) {
      this.removed.push(id);
      this.st = { ...this.st, rules: this.st.rules.filter((r) => r.id !== id), pendingApproval: this.st.pendingApproval.filter((r) => r.id !== id) };
    }
    pendingReasons() {
      return this.reasons;
    }
  }

  it('deleting a shared rule in the panel goes through removeShared (no save when nothing else changed)', async () => {
    const shared = new RemovingShared();
    shared.st = { ...shared.st, rules: [sharedRule('s1'), sharedRule('s2')] };
    const { host, c, reply } = setup({ shared });
    c.setSharedRules(shared.st.rules);
    await c.handle({ type: 'setRules', rules: [sharedRule('s2')] }, reply);
    await vi.waitFor(() => expect(shared.removed).toEqual(['s1']));
    expect(shared.saved).toEqual([]);
    expect(host.rules.map((r) => r.id)).toEqual(['s2']);
  });

  it('a removal plus an edit: removeShared, then save of the edited list', async () => {
    const shared = new RemovingShared();
    shared.st = { ...shared.st, rules: [sharedRule('s1'), sharedRule('s2')] };
    const { c, reply } = setup({ shared });
    c.setSharedRules(shared.st.rules);
    await c.handle({ type: 'setRules', rules: [{ ...sharedRule('s2'), enabled: false }] }, reply);
    await vi.waitFor(() => expect(shared.saved.length).toBe(1));
    expect(shared.removed).toEqual(['s1']);
    expect(shared.saved[0].map((r) => [r.id, r.enabled])).toEqual([['s2', false]]);
  });

  it('un-sharing uses removeShared', async () => {
    const shared = new RemovingShared();
    shared.st = { ...shared.st, rules: [sharedRule('s1')] };
    const { host, c, reply, replies } = setup({ shared });
    c.setSharedRules(shared.st.rules);
    await c.handle({ type: 'shareRule', id: 's1', shared: false }, reply);
    expect(errors(replies)).toEqual([]);
    expect(shared.removed).toEqual(['s1']);
    expect(shared.saved).toEqual([]);
    expect(host.rules.map((r) => [r.id, r.shared])).toEqual([['rule_1', undefined]]);
  });

  it('Status.sharedRules.pending from pendingReasons', () => {
    const shared = new RemovingShared();
    shared.st = { ...shared.st, pendingApproval: [sharedRule('a'), sharedRule('b'), sharedRule('c')] };
    shared.reasons = ['Rule "Staging" sends the app\'s requests to https://staging.example.com', 'Rule "With \\"quote\\"" sets the request header "authorization"', 'something else\nentirely'];
    const { c } = setup({ shared });
    expect(c.status().sharedRules?.pending).toEqual([
      { name: 'Staging', reason: "sends the app's requests to https://staging.example.com" },
      { name: 'With \\"quote\\"', reason: 'sets the request header "authorization"' },
      { name: 'Shared rule', reason: 'something else entirely' },
    ]);
    shared.st = { ...shared.st, pendingApproval: [] };
    expect(c.status().sharedRules).toEqual({ file: '.vscode/flutter-intercept.json', count: 0, problems: [], pendingApproval: 0 });
  });

  it('openSharedRules / openBodyFile go through the deps; paths and content are validated', async () => {
    const opened: unknown[][] = [];
    const { c, reply, replies } = setup({
      openSharedRules: async () => opened.push(['shared']),
      openBodyFile: async (p, create) => opened.push([p, create]),
    });
    await c.handle({ type: 'openSharedRules' }, reply);
    await c.handle({ type: 'openBodyFile', path: '.vscode/flutter-intercept/mocks/user.json' }, reply);
    await c.handle({ type: 'openBodyFile', path: 'mocks/new.json', create: { content: '{}' } }, reply);
    expect(opened).toEqual([['shared'], ['.vscode/flutter-intercept/mocks/user.json', undefined], ['mocks/new.json', { content: '{}' }]]);
    expect(errors(replies)).toEqual([]);
    for (const bad of [
      { path: '../x.json' },
      { path: '/etc/passwd' },
      { path: 'C:\\x' },
      { path: 'x'.repeat(301) },
      { path: 42 },
      { path: 'a.json', create: { content: 1 } },
      { path: 'a.json', create: 'x' },
      { path: 'a.json', create: { content: '', extra: 1 } },
      { path: 'a.json', create: { content: 'x'.repeat(5 * 1024 * 1024 + 1) } },
    ]) {
      await c.handle({ type: 'openBodyFile', ...bad }, reply);
    }
    expect(errors(replies)).toHaveLength(9);
    expect(errors(replies)[0]).toMatch(/path must stay inside the workspace/);
    expect(errors(replies)[8]).toMatch(/5 MB/);
    expect(opened).toHaveLength(3);
  });

  it('without the deps they answer an error; a failing dep is reported', async () => {
    const a = setup();
    await a.c.handle({ type: 'openSharedRules' }, a.reply);
    await a.c.handle({ type: 'openBodyFile', path: 'a.json' }, a.reply);
    expect(errors(a.replies)).toEqual([expect.stringMatching(/workspace folder/), expect.stringMatching(/not available/)]);
    const b = setup({
      openBodyFile: async () => {
        throw new Error('not inside the workspace');
      },
    });
    await b.c.handle({ type: 'openBodyFile', path: 'a.json' }, b.reply);
    expect(errors(b.replies)).toEqual(['not inside the workspace']);
  });
});

describe('expireToken message (CONTRACTS §12.3)', () => {
  it('inserts the preset FIRST among the personal rules', async () => {
    const { host, c, reply, replies, saved } = setup({ shared: new FakeShared() });
    c.setSharedRules([{ id: 's1', enabled: true, shared: true, match: { url: '*' }, action: { kind: 'throttle', latencyMs: 1 } }]);
    host.rules = [...host.rules, { id: 'p1', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    await c.handle({ type: 'expireToken', url: 'https://api.example.com/v1/me?x=1', count: 3 }, reply);
    expect(errors(replies)).toEqual([]);
    expect(host.rules.map((r) => r.id)).toEqual(['s1', 'rule_1', 'p1']);
    const r = host.rules[1];
    expect(r.name).toBe('Expire token: https://api.example.com/v1/me*');
    expect(r.action.kind === 'sequence' && r.action.steps[0].count).toBe(3);
    expect(saved.pop()!.map((x) => x.id)).toEqual(['rule_1', 'p1']);
  });
  it.each([[{ url: 'https://a.dev/', count: 0 }], [{ url: 42, count: 1 }], [{ url: '', count: 1 }]])('rejects %j', async (m) => {
    const { c, reply, replies } = setup();
    await c.handle({ type: 'expireToken', ...m }, reply);
    expect(errors(replies)).toHaveLength(1);
  });
});

describe('recordings messages (CONTRACTS §12.4–12.5)', () => {
  it('saveRecording saves the finished HTTP exchanges (unredacted by default) and broadcasts recordings', async () => {
    const recordings = new FakeRecordings();
    const { host, c, msgs, reply, replies } = setup({ recordings });
    host.exchanges = [
      ex('a'),
      ex('b', { state: 'pending', status: undefined }),
      ex('ws', { kind: 'websocket' }),
      ex('vm', { captured: 'vm-profile' }),
      ex('chrome', { browserInternal: true }),
      ex('m', { state: 'mocked', status: 500 }),
    ];
    await c.handle({ type: 'saveRecording', name: ' Happy path ' }, reply);
    expect(errors(replies)).toEqual([]);
    expect(recordings.saves).toEqual([{ name: 'Happy path', ids: ['a', 'm'], redact: false }]);
    expect(last(msgs, 'recordings')!.recordings).toEqual([{ id: 'happy-path', name: 'Happy path', createdAt: 5, exchanges: 2, redacted: false }]);
    await c.handle({ type: 'saveRecording', name: 'Only a', ids: ['a', 'ws'], redact: true }, reply);
    expect(recordings.saves[1]).toEqual({ name: 'Only a', ids: ['a'], redact: true });
  });

  it('saveRecording validates and refuses an empty recording', async () => {
    const { c, reply, replies } = setup({ recordings: new FakeRecordings() });
    await c.handle({ type: 'saveRecording', name: '' }, reply);
    await c.handle({ type: 'saveRecording', name: 'x', redact: 'yes' }, reply);
    await c.handle({ type: 'saveRecording', name: 'x', ids: 'a' }, reply);
    await c.handle({ type: 'saveRecording', name: 'x' }, reply);
    expect(errors(replies)).toEqual([expect.stringMatching(/name/), expect.stringMatching(/redact/), expect.stringMatching(/ids/), expect.stringMatching(/no finished HTTP request/)]);
  });

  it('replayRecording starts and stops replay; Status.replay follows', async () => {
    const recordings = new FakeRecordings();
    const { host, c, msgs, reply, replies } = setup({ recordings });
    host.exchanges = [ex('a')];
    await c.handle({ type: 'saveRecording', name: 'Demo' }, reply);
    await c.handle({ type: 'replayRecording', id: 'demo', fallback: 'fail' }, reply);
    expect(errors(replies)).toEqual([]);
    expect(host.replayCalls[0][1]).toEqual({ fallback: 'fail', matchTemplates: true });
    expect(host.replayCalls[0][2]).toEqual({ id: 'demo', name: 'Demo' });
    expect(last(msgs, 'status')!.status.replay).toEqual({ recording: 'Demo', fallback: 'fail' });
    expect(c.status().replay).toEqual({ recording: 'Demo', fallback: 'fail' });
    await c.handle({ type: 'replayRecording' }, reply);
    expect(host.replayCalls[1][0]).toBeUndefined();
    expect(last(msgs, 'status')!.status.replay).toBeUndefined();
  });

  it('replayRecording errors: unknown id, bad fallback, no replay support', async () => {
    const { c, reply, replies } = setup({ recordings: new FakeRecordings() });
    await c.handle({ type: 'replayRecording', id: 'nope' }, reply);
    await c.handle({ type: 'replayRecording', id: 'nope', fallback: 'maybe' }, reply);
    expect(errors(replies)).toEqual(['no recording nope', expect.stringMatching(/fallback/)]);
    const old = setup({ recordings: new FakeRecordings() });
    (old.host as { setReplay?: unknown }).setReplay = undefined;
    await old.c.handle({ type: 'replayRecording', id: 'x' }, old.reply);
    expect(errors(old.replies)).toEqual([expect.stringMatching(/cannot replay/)]);
  });

  it('diffRecordings opens the diff of two loaded recordings', async () => {
    const recordings = new FakeRecordings();
    const opened: string[][] = [];
    const { host, c, reply, replies } = setup({ recordings, openDiff: async (a, b) => opened.push([a.name, b.name]) });
    host.exchanges = [ex('a')];
    await c.handle({ type: 'saveRecording', name: 'One' }, reply);
    await c.handle({ type: 'saveRecording', name: 'Two' }, reply);
    await c.handle({ type: 'diffRecordings', a: 'one', b: 'two' }, reply);
    await c.handle({ type: 'diffRecordings', a: 'one', b: 'one' }, reply);
    expect(opened).toEqual([['One', 'Two']]);
    expect(errors(replies)).toEqual([expect.stringMatching(/two different/)]);
  });

  it('deleteRecording stops replaying it and broadcasts the new list', async () => {
    const recordings = new FakeRecordings();
    const { host, c, msgs, reply } = setup({ recordings });
    host.exchanges = [ex('a')];
    await c.handle({ type: 'saveRecording', name: 'Demo' }, reply);
    await c.handle({ type: 'replayRecording', id: 'demo' }, reply);
    await c.handle({ type: 'deleteRecording', id: 'demo' }, reply);
    expect(host.replay).toBeUndefined();
    expect(last(msgs, 'recordings')!.recordings).toEqual([]);
  });

  it('ready sends the recordings list; without a service the messages answer an error', async () => {
    const recordings = new FakeRecordings();
    const { host, c, reply, replies } = setup({ recordings });
    host.exchanges = [ex('a')];
    await c.handle({ type: 'saveRecording', name: 'Demo' }, reply);
    await c.handle({ type: 'ready' }, reply);
    expect(last(replies, 'recordings')!.recordings.map((r) => r.id)).toEqual(['demo']);
    const none = setup();
    await none.c.handle({ type: 'saveRecording', name: 'x' }, none.reply);
    await none.c.handle({ type: 'ready' }, none.reply);
    expect(errors(none.replies)).toEqual([expect.stringMatching(/Recordings are not available/)]);
    expect(none.replies.some((m) => m.type === 'recordings')).toBe(false);
  });

  it('isRecordable', () => {
    expect(isRecordable(ex('a'))).toBe(true);
    expect(isRecordable(ex('a', { state: 'error', status: undefined }))).toBe(true);
    expect(isRecordable(ex('a', { state: 'paused-response' }))).toBe(false);
    expect(isRecordable(ex('a', { kind: 'sse' }))).toBe(false);
  });
});

describe('authFlows (CONTRACTS §12.3)', () => {
  const analysis = (ids: string[]): AuthAnalysis => ({
    flows: ids.length ? [{ steps: ids.map((id, i) => ({ exchangeId: id, role: i === 0 ? 'unauthorized' : i === 1 ? 'refresh' : 'retry', at: i })), stampede: { refreshCalls: 2, windowMs: 2000 } }] : [],
  });

  it('pushed on ready and at most once per debounce window after exchange changes, only when changed', async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const { host, c, msgs, reply, replies } = setup({
      authDebounceMs: 1000,
      analyzeAuth: (list) => {
        calls.push(list.length);
        return analysis(list.map((e) => e.id));
      },
    });
    await c.handle({ type: 'ready' }, reply);
    expect(last(replies, 'authFlows')!.flows).toEqual([]);
    host.push(ex('401', { status: 401 }));
    host.push(ex('refresh'));
    host.push(ex('pending', { state: 'pending', status: undefined }));
    expect(msgs.some((m) => m.type === 'authFlows')).toBe(false);
    vi.advanceTimersByTime(1000);
    const flows = msgs.filter((m) => m.type === 'authFlows');
    expect(flows).toHaveLength(1);
    expect((flows[0] as Extract<HostMsg, { type: 'authFlows' }>).flows).toEqual([
      { steps: [{ exchangeId: '401', role: 'unauthorized' }, { exchangeId: 'refresh', role: 'refresh' }, { exchangeId: 'pending', role: 'retry' }], stampede: { refreshCalls: 2, windowMs: 2000 } },
    ]);
    // Same result again: nothing sent.
    host.push(ex('refresh'));
    vi.advanceTimersByTime(1000);
    expect(msgs.filter((m) => m.type === 'authFlows')).toHaveLength(1);
    c.clear();
    vi.advanceTimersByTime(1000);
    expect(last(msgs, 'authFlows')!.flows).toEqual([]);
  });

  it('nothing is computed without a panel; a throwing analyzer yields no flows', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    let n = 0;
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, analyzeAuth: () => (n++, analysis([])) });
    controllers.push(c);
    host.push(ex('a'));
    vi.advanceTimersByTime(2000);
    expect(n).toBe(0);
    const bad = setup({
      analyzeAuth: () => {
        throw new Error('boom');
      },
    });
    expect(bad.c.authFlows()).toEqual([]);
  });
});

describe('Status (CONTRACTS §12.7)', () => {
  it('omits replay and sharedRules when there is nothing to show', () => {
    const shared = new FakeShared();
    shared.st = { rules: [], problems: [], pendingApproval: [] };
    const { c } = setup({ shared });
    expect('replay' in c.status()).toBe(false);
    expect('sharedRules' in c.status()).toBe(false);
  });
  it('a replay event from the host broadcasts status', () => {
    const { host, msgs } = setup();
    host.replay = { recording: 'R', fallback: 'passthrough' };
    host.emit('replay', host.replay);
    expect(last(msgs, 'status')!.status.replay).toEqual({ recording: 'R', fallback: 'passthrough' });
  });
});
