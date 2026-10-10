// CONTRACTS §10.5: mutate validation, contract checks (batched, cached, dropped), pickModel, openViolation,
// mutateField, generateModel, generateFixture.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import type { CodegenService, FixtureGenInput, GeneratedFile, ModelGenInput } from '../../src/codegen/types';
import type { ApiEndpoint, ContractResult, ContractService } from '../../src/contract/types';
import { JsonDouble } from '../../src/codegen/json';
import { ControllerDeps, ControllerHost, contractSummary, InterceptController, validateRule } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';


class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
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
  clear() {
    this.exchanges = this.exchanges.filter((e) => e.state.startsWith('paused') || e.state === 'pending');
  }
  resume() {}
  abort() {}
  push(e: Exchange) {
    const i = this.exchanges.findIndex((x) => x.id === e.id);
    if (i >= 0) this.exchanges[i] = e;
    else this.exchanges.push(e);
    this.emit('exchange', { ...e });
  }
}

const ex = (id: string, extra: Partial<Exchange> = {}): Exchange => ({
  id,
  startedAt: Number(id.replace(/\D/g, '') || 1),
  method: 'GET',
  url: `https://api.example.com/v1/users/${id.replace(/\D/g, '') || 1}?access_token=SECRET`,
  requestHeaders: { authorization: 'Bearer SECRET' },
  state: 'completed',
  status: 200,
  responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
  responseBody: { text: JSON.stringify({ id: 1, avatar_url: null, token: 'SECRET' }), encoding: 'utf8' },
  ...extra,
});

class FakeContract implements ContractService {
  checks: string[] = [];
  remembered: [string, string | undefined][] = [];
  listeners: (() => void)[] = [];
  delay = 0;
  fail = false;
  async check(e: Exchange, opts?: { model?: string }): Promise<ContractResult> {
    this.checks.push(e.id);
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    if (this.fail) throw new Error('parser crashed');
    return {
      exchangeId: e.id,
      checked: true,
      model: opts?.model ?? 'User',
      via: 'retrofit',
      violations: [{ path: '$.avatar_url', model: 'User', field: 'avatarUrl', key: 'avatar_url', expected: 'String', actual: 'null', severity: 'error', message: 'avatar_url is null', file: '/ws/lib/user.dart', line: 7 }],
    };
  }
  endpointList: ApiEndpoint[] = [
    { method: 'GET', pathTemplate: '/users/{id}', responseModel: 'User', dartMethod: 'getUser', file: '/x/users_api.dart', line: 3, className: 'UsersApi', importUri: 'package:demo_app/api/users_api.dart' },
    { method: 'GET', pathTemplate: '/orders/{id}', responseModel: 'Order', dartMethod: 'getOrder', file: '/x/orders_api.dart', line: 3, className: 'OrdersApi' },
  ];
  async endpoints() {
    return this.endpointList;
  }
  async models() {
    return [{ name: 'User', file: '/ws/lib/user.dart' }];
  }
  async remember(e: Exchange, model: string | undefined) {
    this.remembered.push([e.id, model]);
  }
  onDidChangeModels(l: () => void) {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  }
}

class FakeCodegen implements CodegenService {
  models: ModelGenInput[] = [];
  fixtures: FixtureGenInput[] = [];
  detectModelStyle() {
    return 'json_serializable' as const;
  }
  fixtureStyle: 'mocktail' | 'mock_client' = 'mocktail';
  detectFixtureStyle() {
    return this.fixtureStyle;
  }
  generateModels(i: ModelGenInput): GeneratedFile[] {
    this.models.push(i);
    return [{ path: 'lib/models/user.dart', content: 'class User {}' }];
  }
  generateFixtureTest(i: FixtureGenInput): GeneratedFile[] {
    this.fixtures.push(i);
    return [{ path: 'test/x_test.dart', content: '' }];
  }
  routeTemplate(u: string) {
    return u.replace(/\/\d+(?=\/|$)/g, '/{id}');
  }
}

function setup(extra: Partial<ControllerDeps> = {}) {
  const host = new FakeHost();
  const contract = new FakeContract();
  const codegen = new FakeCodegen();
  let checking = true;
  const results: ContractResult[] = [];
  const removed: string[][] = [];
  const opened: GeneratedFile[][] = [];
  const locations: [string, number][] = [];
  const c = new InterceptController({
    host,
    saveRules: () => undefined,
    getEnabled: () => true,
    setEnabled: async () => undefined,
    newRuleId: () => 'rule_new',
    throttleMs: 10,
    contractDebounceMs: 5,
    contract,
    contractCheckEnabled: () => checking,
    onContractResult: (r) => results.push(r),
    onContractRemoved: (ids) => removed.push(ids),
    codegen,
    openUntitled: async (files) => {
      opened.push(files);
    },
    openLocation: async (file, line) => {
      locations.push([file, line]);
    },
    projectRoot: () => '/ws',
    appPackageName: () => 'demo_app',
    ...extra,
  });
  const got: HostMsg[] = [];
  c.attach((m) => got.push(m));
  const replies: HostMsg[] = [];
  return { host, c, got, replies, reply: (m: HostMsg) => replies.push(m), contract, codegen, results, removed, opened, locations, setChecking: (b: boolean) => (checking = b) };
}

const contractMsgs = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'contract' }> => m.type === 'contract');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

afterEach(() => vi.useRealTimers());

describe('validateRule: mutate (CONTRACTS §10.2)', () => {
  const rule = (action: unknown) => ({ id: 'r', enabled: true, match: { url: '*' }, action });
  it('accepts valid ops', () => {
    expect(validateRule(rule({ kind: 'mutate', ops: [{ path: '$.a', op: 'null' }, { path: "$.items[*]['b c']", op: 'delete' }, { path: '$.n', op: 'set', value: { x: [1, 'two', null, true] } }] })).action).toMatchObject({ kind: 'mutate' });
    // valueJson: byte-exact JSON text (doubles like 1.0, big ints); enough on its own, wins over value
    expect(validateRule(rule({ kind: 'mutate', ops: [{ path: '$.a', op: 'set', valueJson: '1.0' }, { path: '$.b', op: 'set', value: 1, valueJson: '12345678901234567890' }] })).action).toMatchObject({ kind: 'mutate' });
  });
  it.each<[unknown, RegExp]>([
    [{ kind: 'mutate' }, /ops must be a list of 1–20/],
    [{ kind: 'mutate', ops: [] }, /ops must be a list/],
    [{ kind: 'mutate', ops: Array.from({ length: 21 }, () => ({ path: '$.a', op: 'null' })) }, /1–20/],
    [{ kind: 'mutate', ops: [{ path: 'a', op: 'null' }] }, /start with "\$"/],
    [{ kind: 'mutate', ops: [{ path: '$.a[', op: 'null' }] }, /invalid path/],
    [{ kind: 'mutate', ops: [{ path: `$.${'a'.repeat(1000)}`, op: 'null' }] }, /at most 1000/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'drop' }] }, /op must be/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'set' }] }, /needs a value/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'null', value: 1 }] }, /only used with op "set"/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'delete', valueJson: '1' }] }, /only used with op "set"/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'set', valueJson: '1.' }] }, /valid JSON text/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'set', valueJson: 1 }] }, /string of JSON text/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'set', valueJson: `"${'x'.repeat(1024 * 1024)}"` }] }, /at most 1 MB/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'set', value: () => 1 }] }, /JSON value/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'set', value: NaN }] }, /JSON value/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'set', value: new Date() }] }, /JSON value/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'set', value: 'x'.repeat(1024 * 1024) }] }, /at most 1 MB/],
    [{ kind: 'mutate', ops: [{ path: '$.a', op: 'null', extra: 1 }] }, /unknown field "extra"/],
    [{ kind: 'mutate', ops: [], other: 1 }, /unknown field "other"/],
  ])('rejects %#', (action, re) => {
    expect(() => validateRule(rule(action))).toThrow(re);
  });
});

describe('contract checks', () => {
  it('checks finished JSON exchanges once, batches results after the exchanges, feeds onContractResult', async () => {
    const { host, got, contract, results } = setup();
    host.push(ex('e1', { state: 'pending', status: undefined, responseBody: undefined }));
    host.push(ex('e1'));
    host.push(ex('e1')); // again: cached / in flight → no second check
    host.push(ex('e2', { responseHeaders: { 'content-type': 'text/html' }, responseBody: { text: '<p>', encoding: 'utf8' } }));
    host.push(ex('e3', { responseBody: { text: '{"a":', encoding: 'utf8', truncated: true } }));
    host.push(ex('e4', { responseBody: { text: 'AAA', encoding: 'base64' } }));
    host.push(ex('e5', { responseHeaders: {}, responseBody: { text: ' [1]', encoding: 'utf8' } })); // sniffed JSON
    await tick();
    expect(contract.checks.sort()).toEqual(['e1', 'e5']);
    expect(results.map((r) => r.exchangeId).sort()).toEqual(['e1', 'e5']);
    const types = got.map((m) => m.type);
    expect(types.lastIndexOf('exchange')).toBeLessThan(types.indexOf('contract'));
    const all = contractMsgs(got).flatMap((m) => m.results);
    expect(all.find((r) => r.id === 'e1')).toEqual({ id: 'e1', checked: true, model: 'User', via: 'retrofit', violations: [{ path: '$.avatar_url', field: 'avatarUrl', expected: 'String', actual: 'null', severity: 'error', message: 'avatar_url is null' }] });
  });

  it('limits concurrency', async () => {
    const { host, contract } = setup({ contractConcurrency: 1 });
    contract.delay = 20;
    let peak = 0;
    let running = 0;
    const orig = contract.check.bind(contract);
    contract.check = async (e, o) => {
      running++;
      peak = Math.max(peak, running);
      try {
        return await orig(e, o);
      } finally {
        running--;
      }
    };
    for (let i = 1; i <= 4; i++) host.push(ex(`e${i}`));
    await tick(150);
    expect(contract.checks).toHaveLength(4);
    expect(peak).toBe(1);
  });

  it('a throwing checker becomes checked:false with a reason', async () => {
    const { host, contract, results } = setup();
    contract.fail = true;
    host.push(ex('e1'));
    await tick();
    expect(results[0]).toMatchObject({ exchangeId: 'e1', checked: false, reason: expect.stringMatching(/parser crashed/) });
  });

  it('does nothing when checking is off or there is no service', async () => {
    const off = setup();
    off.setChecking(false);
    off.host.push(ex('e1'));
    await tick();
    expect(off.contract.checks).toEqual([]);
    const none = setup({ contract: undefined });
    none.host.push(ex('e1'));
    await tick();
    expect(contractMsgs(none.got)).toEqual([]);
  });

  it('ready sends the cached results for the current snapshot (and checks what is unchecked)', async () => {
    const { host, c, replies, reply, contract } = setup();
    host.push(ex('e1'));
    await tick();
    host.exchanges.push(ex('e2')); // recorded without an event (e.g. while checking was off)
    await c.handle({ type: 'ready' }, reply);
    expect(replies.map((m) => m.type)).toEqual(['snapshot', 'contract']);
    expect(contractMsgs(replies)[0].results.map((r) => r.id)).toEqual(['e1']);
    await tick();
    expect(contract.checks.sort()).toEqual(['e1', 'e2']);
    expect(c.contractResult('e2')).toBeDefined();
  });

  it('drops results on eviction, clear and proxy restart (onContractRemoved)', async () => {
    const { host, c, removed } = setup();
    host.push(ex('e1'));
    host.push(ex('e2'));
    host.push(ex('e3'));
    await tick();
    host.exchanges = host.exchanges.filter((e) => e.id !== 'e1');
    host.emit('removed', ['e1']);
    expect(removed).toEqual([['e1']]);
    expect(c.contractResult('e1')).toBeUndefined();
    c.clear();
    expect(removed[1].sort()).toEqual(['e2', 'e3']);
    host.push(ex('e4'));
    await tick();
    host.emit('state', true);
    expect(removed[2]).toEqual(['e4']);
    expect(c.contractResult('e4')).toBeUndefined();
  });

  it('a result that arrives after its exchange was evicted is discarded', async () => {
    const { host, contract, results, c } = setup();
    contract.delay = 30;
    host.push(ex('e1'));
    await tick(10);
    host.exchanges = [];
    host.emit('removed', ['e1']);
    await tick(60);
    expect(contract.checks).toEqual(['e1']);
    expect(results).toEqual([]);
    expect(c.contractResult('e1')).toBeUndefined();
  });

  it('re-checks everything when the models change; turning checking off clears the panel', async () => {
    const { host, c, contract, got, removed, setChecking } = setup();
    host.push(ex('e1'));
    await tick();
    contract.listeners.forEach((l) => l());
    expect(removed).toEqual([['e1']]);
    await tick();
    expect(contract.checks).toEqual(['e1', 'e1']);
    setChecking(false);
    c.recheckContracts();
    expect(contractMsgs(got).at(-1)!.results).toEqual([{ id: 'e1', checked: false, via: 'none', violations: [], reason: expect.stringMatching(/off/) }]);
    c.dispose();
    expect(contract.listeners).toEqual([]);
  });
});

describe('webview messages (CONTRACTS §10.5)', () => {
  it('pickModel: remembers the choice and re-checks; null = cancelled; undefined = forget', async () => {
    const choices: (string | undefined | null)[] = ['Account', null, undefined];
    const { host, c, reply, contract } = setup({ pickModel: async () => choices.shift() });
    host.push(ex('e1'));
    await tick();
    await c.handle({ type: 'pickModel', id: 'e1' }, reply);
    await tick();
    expect(contract.remembered).toEqual([['e1', 'Account']]);
    expect(contract.checks).toEqual(['e1', 'e1']);
    await c.handle({ type: 'pickModel', id: 'e1' }, reply);
    expect(contract.remembered).toHaveLength(1);
    await c.handle({ type: 'pickModel', id: 'e1' }, reply);
    expect(contract.remembered[1]).toEqual(['e1', undefined]);
  });

  it('pickModel with checking off still checks that exchange; errors without deps', async () => {
    const s = setup({ pickModel: async () => 'User' });
    s.setChecking(false);
    s.host.exchanges.push(ex('e1'));
    await s.c.handle({ type: 'pickModel', id: 'e1' }, s.reply);
    expect(s.contract.checks).toEqual(['e1']);
    expect(contractMsgs(s.got)[0].results[0].id).toBe('e1');
    const n = setup();
    n.host.exchanges.push(ex('e1'));
    await n.c.handle({ type: 'pickModel', id: 'e1' }, n.reply);
    expect(n.replies).toEqual([{ type: 'error', message: expect.stringMatching(/not available/) }]);
  });

  it('openViolation opens the model field line; bad index / unknown result → error', async () => {
    const { host, c, reply, replies, locations } = setup();
    host.push(ex('e1'));
    await tick();
    await c.handle({ type: 'openViolation', id: 'e1', index: 0 }, reply);
    expect(locations).toEqual([['/ws/lib/user.dart', 7]]);
    await c.handle({ type: 'openViolation', id: 'e1', index: 3 }, reply);
    await c.handle({ type: 'openViolation', id: 'zz', index: 0 }, reply);
    expect(replies.map((m) => (m.type === 'error' ? m.message : m.type))).toEqual([expect.stringMatching(/out of range/), expect.stringMatching(/no contract check result/)]);
  });

  it('mutateField inserts a mutate rule FIRST, named after the field and route', async () => {
    let n = 0;
    const { host, c, reply, got, replies } = setup({ newRuleId: () => (n++ ? `rule_${n}` : 'rule_new') });
    host.rules = [{ id: 'old', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    host.exchanges.push(ex('e1'));
    await c.handle({ type: 'mutateField', id: 'e1', path: '$.avatar_url', op: 'null' }, reply);
    expect(host.rules[0]).toEqual({
      id: 'rule_new',
      enabled: true,
      name: 'null $.avatar_url GET /v1/users/1',
      match: { method: 'GET', url: 'https://api.example.com/v1/users/1*' },
      action: { kind: 'mutate', ops: [{ path: '$.avatar_url', op: 'null' }] },
    });
    expect(got.some((m) => m.type === 'rules')).toBe(true);
    await c.handle({ type: 'mutateField', id: 'e1', path: '$.id', op: 'set', value: '42' }, reply);
    expect(host.rules[0].action).toEqual({ kind: 'mutate', ops: [{ path: '$.id', op: 'set', value: '42' }] });
    await c.handle({ type: 'mutateField', id: 'e1', path: '$.id', op: 'set', valueJson: '1.0' }, reply);
    expect(host.rules[0].action).toEqual({ kind: 'mutate', ops: [{ path: '$.id', op: 'set', valueJson: '1.0' }] });
    await c.handle({ type: 'mutateField', id: 'e1', path: '$.id', op: 'set' }, reply);
    await c.handle({ type: 'mutateField', id: 'e1', path: 'id', op: 'null' }, reply);
    await c.handle({ type: 'mutateField', id: 'e1', path: '$.id', op: 'zap' } as never, reply);
    expect(replies.map((m) => m.type)).toEqual(['error', 'error', 'error']);
    expect(host.rules).toHaveLength(4);
  });

  it('generateModel: decoded samples of the route (raw: the user\'s own editor) → untitled editors', async () => {
    const { host, c, reply, codegen, opened, replies } = setup();
    host.exchanges.push(ex('e1'), ex('e2', { responseBody: { text: '{"id":2,"avatar_url":"x"}', encoding: 'utf8' } }), ex('e3', { url: 'https://api.example.com/v1/orders/3' }));
    await c.handle({ type: 'generateModel', id: 'e2' }, reply);
    expect(replies).toEqual([]);
    expect(codegen.models[0]).toMatchObject({ rootName: 'User', style: 'json_serializable', source: 'GET https://api.example.com/v1/users/{id}' });
    expect(codegen.models[0].samples).toEqual([{ id: 1, avatar_url: null, token: 'SECRET' }, { id: 2, avatar_url: 'x' }]);
    expect(opened).toHaveLength(1);
    host.exchanges.push(ex('e9', { responseBody: { text: 'nope', encoding: 'utf8' } }));
    await c.handle({ type: 'generateModel', id: 'e9' }, reply);
    expect(replies[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/not valid JSON/) });
  });

  it('generateFixture: the REDACTED view of the route\'s distinct responses', async () => {
    const { host, c, reply, codegen, opened } = setup();
    host.exchanges.push(ex('e1'), ex('e2'), ex('e3', { status: 500, responseBody: { text: '{"error":"x"}', encoding: 'utf8' } }));
    await c.handle({ type: 'generateFixture', id: 'e1' }, reply);
    const input = codegen.fixtures[0];
    expect(input).toMatchObject({ name: 'get_user', style: 'mocktail', packageName: 'demo_app' });
    expect(input.exchanges.map((e) => e.id)).toEqual(['e1', 'e3']); // e2 has the same status + body as e1
    expect(JSON.stringify(input.exchanges)).not.toContain('SECRET');
    expect(opened).toHaveLength(1);
    // mocktail: the matching Retrofit interface (from contract.endpoints()) with its import + model imports
    expect(input.api).toMatchObject({ className: 'UsersApi', imports: ['package:demo_app/api/users_api.dart', 'package:demo_app/user.dart'] });
  });

  it('generateFixture: no api for other styles or when the endpoint index fails', async () => {
    const s = setup();
    s.host.exchanges.push(ex('e1'));
    s.codegen.fixtureStyle = 'mock_client';
    await s.c.handle({ type: 'generateFixture', id: 'e1' }, s.reply);
    expect(s.codegen.fixtures[0].api).toBeUndefined();
    s.codegen.fixtureStyle = 'mocktail';
    s.contract.endpoints = async () => {
      throw new Error('index broken');
    };
    await s.c.handle({ type: 'generateFixture', id: 'e1' }, s.reply);
    expect(s.codegen.fixtures[1].api).toBeUndefined();
    expect(s.replies).toEqual([]);
  });

  it('generateModel keeps 1.0 as a double (JsonDouble)', async () => {
    const { host, c, reply, codegen } = setup();
    host.exchanges.push(ex('e1', { responseBody: { text: '{"price":1.0}', encoding: 'utf8' } }));
    await c.handle({ type: 'generateModel', id: 'e1' }, reply);
    expect((codegen.models[0].samples[0] as { price: unknown }).price).toBeInstanceOf(JsonDouble);
  });

  it('codegen messages without deps → error', async () => {
    const { host, c, reply, replies } = setup({ codegen: undefined });
    host.exchanges.push(ex('e1'));
    await c.handle({ type: 'generateModel', id: 'e1' }, reply);
    await c.handle({ type: 'generateFixture', id: 'e1' }, reply);
    expect(replies.map((m) => m.type)).toEqual(['error', 'error']);
  });
});

describe('contractSummary', () => {
  it('drops file paths', () => {
    const s = contractSummary({ exchangeId: 'a', checked: false, via: 'none', violations: [], reason: 'no model mapped' });
    expect(s).toEqual({ id: 'a', checked: false, via: 'none', violations: [], reason: 'no model mapped' });
  });
});
