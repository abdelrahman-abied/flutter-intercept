// CONTRACTS §10.6: check_contract, generate_model, generate_fixture_test, assert_traffic, add_mutation.
import { EventEmitter } from 'events';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, jsonEqual, type AgentApiDeps } from '../../../src/agent/api';
import { AgentToolError, type AgentAccess, type AppLauncher } from '../../../src/agent/types';
import type { CodegenService, FixtureGenInput, ModelGenInput } from '../../../src/codegen/types';
import type { ApiEndpoint, ContractResult, ContractService } from '../../../src/contract/types';
import { JsonDouble } from '../../../src/codegen/json';
import { validateRules } from '../../../src/ui/controller';


const ROOT = path.join(path.sep, 'Users', 'dev', 'app');

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
const json = (v: unknown) => ({ text: JSON.stringify(v), encoding: 'utf8' as const });
const ex = (over: Partial<Exchange> = {}): Exchange => ({
  id: `x${++seq}`,
  startedAt: 1000 + seq,
  method: 'GET',
  url: `https://api.example.com/v1/users/${seq}?access_token=SECRET_Q`,
  requestHeaders: { authorization: 'Bearer SECRET_H' },
  state: 'completed',
  status: 200,
  durationMs: 40,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: json({ id: seq, name: 'Ann', token: 'SECRET_T', tags: ['a', 'b'], profile: { avatar_url: null } }),
  ...over,
});

class FakeContract implements ContractService {
  checks: { id: string; model?: string }[] = [];
  async check(e: Exchange, opts?: { model?: string }): Promise<ContractResult> {
    this.checks.push({ id: e.id, model: opts?.model });
    return {
      exchangeId: e.id,
      checked: true,
      model: opts?.model ?? 'User',
      via: opts?.model ? 'user' : 'retrofit',
      violations: [
        {
          path: '$.profile.avatar_url',
          model: 'Profile',
          field: 'avatarUrl',
          key: 'avatar_url',
          expected: 'String',
          actual: 'null',
          severity: 'error',
          message: `avatar_url is null in GET ${e.url} → Null is not a subtype of String (${ROOT}${path.sep}lib${path.sep}models${path.sep}user.dart)`,
          file: path.join(ROOT, 'lib', 'models', 'user.dart'),
          line: 12,
        },
        {
          path: '$.token',
          model: 'User',
          field: 'token',
          key: 'token',
          expected: 'int',
          actual: 'string "SECRET_T"',
          severity: 'error',
          message: 'token is string "SECRET_T", expected int',
          file: path.join(path.sep, 'opt', 'pub-cache', 'x.dart'),
          line: 3,
        },
      ],
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
    return [{ name: 'User', file: path.join(ROOT, 'lib', 'models', 'user.dart') }];
  }
  async remember() {}
  onDidChangeModels() {
    return { dispose: () => undefined };
  }
}

class FakeCodegen implements CodegenService {
  modelInputs: ModelGenInput[] = [];
  fixtureInputs: FixtureGenInput[] = [];
  detectModelStyle = vi.fn(() => 'freezed' as const);
  detectFixtureStyle = vi.fn((): 'http_mock_adapter' | 'mocktail' => 'http_mock_adapter');
  generateModels(input: ModelGenInput) {
    this.modelInputs.push(input);
    return [{ path: `lib/models/${input.rootName.toLowerCase()}.dart`, content: `class ${input.rootName} {}` }];
  }
  generateFixtureTest(input: FixtureGenInput) {
    this.fixtureInputs.push(input);
    return [{ path: `test/${input.name}_test.dart`, content: '// test' }];
  }
  routeTemplate(url: string) {
    return url.replace(/\/\d+(?=\/|$)/g, '/{id}');
  }
}

function setup(opts: { access?: AgentAccess; redact?: boolean; extra?: Partial<AgentApiDeps>; now?: () => number } = {}) {
  const host = new FakeHost();
  const contract = new FakeContract();
  const codegen = new FakeCodegen();
  let redact = opts.redact ?? true;
  const launcher: AppLauncher = {
    launch: vi.fn(async () => ({ sessionId: 's1' })),
    stop: vi.fn(async () => ({ stopped: 1 })),
    hotRestart: vi.fn(async () => ({ restarted: 1 })),
    sessions: () => [],
  };
  let idn = 0;
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: opts.access ?? 'readWrite', redactSecrets: redact, interceptEnabled: true }),
    launcher,
    projectRoot: () => ROOT,
    newRuleId: () => `agent_${++idn}`,
    now: opts.now,
    contract,
    codegen,
    appPackageName: () => 'demo_app',
    ...opts.extra,
  };
  return { api: createAgentApi(deps), host, contract, codegen, setRedact: (r: boolean) => (redact = r) };
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

describe('check_contract', () => {
  it('checks one exchange by id: project-relative paths only, secrets and the raw URL never echoed', async () => {
    const { api, host } = setup();
    const e = ex();
    host.exchanges.push(e);
    const r = (await api.call('check_contract', { id: e.id })) as any;
    expect(r.checked).toBe(1);
    expect(r.errors).toBe(2);
    const res = r.results[0];
    expect(res).toMatchObject({ exchangeId: e.id, checked: true, model: 'User', via: 'retrofit', errors: 2, warnings: 0, method: 'GET' });
    expect(res.url).toContain('access_token=[redacted]');
    expect(res.violations[0]).toMatchObject({ path: '$.profile.avatar_url', file: 'lib/models/user.dart', line: 12 });
    // outside the project: no file, no line
    expect(res.violations[1].file).toBeUndefined();
    expect(res.violations[1].line).toBeUndefined();
    const text = JSON.stringify(r);
    for (const s of ['SECRET_Q', 'SECRET_T', ROOT, '/opt/pub-cache']) expect(text).not.toContain(s);
    expect(res.violations[0].message).toBe('avatar_url is null at $.profile.avatar_url: Profile.avatarUrl expects String, so fromJson would throw');
    expect(res.violations[1]).toMatchObject({ path: '$.token', actual: 'string', message: 'token is string at $.token: User.token expects int, so fromJson would throw' });
  });

  it('reuses the controller cache unless a model is forced; latest matching JSON responses otherwise', async () => {
    const cached: ContractResult = { exchangeId: 'x', checked: false, via: 'none', violations: [], reason: 'no model mapped' };
    const { api, host, contract } = setup({ extra: { contractResult: (id) => ({ ...cached, exchangeId: id }) } });
    const a = ex();
    const b = ex();
    const html = ex({ responseHeaders: { 'content-type': 'text/html' }, responseBody: { text: '<html>', encoding: 'utf8' } });
    const pending = ex({ state: 'pending', status: undefined, responseBody: undefined });
    host.exchanges.push(a, b, html, pending);
    const r = (await api.call('check_contract', {})) as any;
    expect(r.results.map((x: any) => x.exchangeId)).toEqual([b.id, a.id]);
    expect(r.results[0]).toMatchObject({ checked: false, reason: 'no model mapped' });
    expect(contract.checks).toEqual([]);
    const forced = (await api.call('check_contract', { id: a.id, model: 'Account' })) as any;
    expect(contract.checks).toEqual([{ id: a.id, model: 'Account' }]);
    expect(forced.results[0]).toMatchObject({ model: 'Account', via: 'user' });
    const p = (await api.call('check_contract', { id: pending.id })) as any;
    expect(p.results[0]).toMatchObject({ checked: false, reason: expect.stringMatching(/not arrived/) });
    const none = (await api.call('check_contract', { url: '*/nothing*' })) as any;
    expect(none.results).toEqual([]);
    expect(none.note).toMatch(/no finished JSON response/);
  });

  it('errors clearly without the service, for unknown ids and mixed filters', async () => {
    await rejects(setup({ extra: { contract: undefined } }).api.call('check_contract', {}), 'state', /not available/);
    await rejects(setup().api.call('check_contract', { id: 'nope' }), 'not_found');
    await rejects(setup().api.call('check_contract', { id: 'a', url: '*' }), 'invalid', /either id/);
  });
});

describe('generate_model', () => {
  it('merges the real samples of the same route (redacted), names the root from the route, uses the project style', async () => {
    const { api, host, codegen } = setup();
    const a = ex({ url: 'https://api.example.com/v1/users/1' });
    const b = ex({ url: 'https://api.example.com/v1/users/2', responseBody: json({ id: 2, name: null, token: 'SECRET_T2' }) });
    const otherRoute = ex({ url: 'https://api.example.com/v1/orders/2' });
    const mocked = ex({ url: 'https://api.example.com/v1/users/3', state: 'mocked', matchedRuleId: 'r1' });
    const err = ex({ url: 'https://api.example.com/v1/users/4', status: 404, responseBody: json({ error: 'nope' }) });
    host.exchanges.push(a, b, otherRoute, mocked, err);
    const r = (await api.call('generate_model', { id: b.id })) as any;
    expect(r).toMatchObject({ samples: 2, route: 'GET /v1/users/{id}', style: 'freezed', files: [{ path: 'lib/models/user.dart' }] });
    const input = codegen.modelInputs[0];
    expect(input.rootName).toBe('User');
    expect(input.source).toBe('GET https://api.example.com/v1/users/{id}');
    expect(input.samples).toHaveLength(2);
    expect(JSON.stringify(input.samples)).not.toContain('SECRET');
    expect(codegen.detectModelStyle).toHaveBeenCalledWith(ROOT);
  });

  it('keeps doubles written as 1.0 (JsonDouble) through redaction, so models get double', async () => {
    const { api, host, codegen } = setup();
    const a = ex({ responseBody: { text: '{"price":1.0,"n":2,"token":"SECRET_T","geo":{"lat":-37.0}}', encoding: 'utf8' } });
    host.exchanges.push(a);
    await api.call('generate_model', { id: a.id });
    const s = codegen.modelInputs[0].samples[0] as Record<string, any>;
    expect(s.price).toBeInstanceOf(JsonDouble);
    expect(s.price.value).toBe(1);
    expect(s.geo.lat).toBeInstanceOf(JsonDouble);
    expect(s.n).toBe(2);
    expect(s.token).toBe('[redacted]');
  });

  it('url picks the newest matching JSON response; name/style override; errors are clear', async () => {
    const { api, host, codegen } = setup();
    host.exchanges.push(ex({ url: 'https://api.example.com/v1/users/1' }), ex({ url: 'https://api.example.com/v1/users/7' }));
    await api.call('generate_model', { url: '*/users/*', name: 'Person', style: 'plain' });
    expect(codegen.modelInputs[0]).toMatchObject({ rootName: 'Person', style: 'plain' });
    expect(codegen.modelInputs[0].samples).toHaveLength(2);
    await rejects(api.call('generate_model', {}), 'invalid', /exactly one/);
    await rejects(api.call('generate_model', { url: '*/none*' }), 'not_found');
    const bin = ex({ responseBody: { text: 'AAEC', encoding: 'base64' } });
    host.exchanges.push(bin);
    await rejects(api.call('generate_model', { id: bin.id }), 'invalid', /binary/);
    await rejects(setup({ extra: { codegen: undefined } }).api.call('generate_model', { url: '*' }), 'state', /not available/);
  });
});

describe('generate_fixture_test', () => {
  it('always redacts (even with the setting off) and names files from the route', async () => {
    const { api, host, codegen, setRedact } = setup();
    setRedact(false);
    const a = ex({ url: 'https://api.example.com/v1/users/1?access_token=SECRET_Q' });
    host.exchanges.push(a);
    const r = (await api.call('generate_fixture_test', { ids: [a.id, a.id] })) as any;
    expect(r).toMatchObject({ exchanges: 1, style: 'http_mock_adapter', redacted: true, files: [{ path: 'test/get_user_test.dart' }] });
    const input = codegen.fixtureInputs[0];
    expect(input).toMatchObject({ name: 'get_user', packageName: 'demo_app', style: 'http_mock_adapter' });
    expect(JSON.stringify(input.exchanges)).not.toMatch(/SECRET_(Q|H|T)/);
    expect(input.exchanges[0].responseBody?.text).toContain('[redacted]');
  });

  it('mocktail: passes the Retrofit interface whose endpoint matches, with its import and model imports', async () => {
    const { api, host, codegen } = setup();
    codegen.detectFixtureStyle.mockReturnValue('mocktail');
    const a = ex({ url: 'https://api.example.com/v1/users/1' });
    host.exchanges.push(a);
    const r = (await api.call('generate_fixture_test', { ids: [a.id] })) as any;
    expect(r.mocks).toBe('UsersApi');
    const fx = codegen.fixtureInputs[0];
    expect(fx.api).toMatchObject({ className: 'UsersApi', imports: ['package:demo_app/api/users_api.dart', 'package:demo_app/models/user.dart'] });
    expect(fx.api!.endpoints.map((e) => e.dartMethod)).toEqual(['getUser']);
    expect(fx.testPackage).toBeUndefined(); // no readable pubspec → flutter_test default
    // no matching endpoint (or no contract service) → no api: the generator falls back
    const o = ex({ url: 'https://api.example.com/v1/things/1' });
    host.exchanges.push(o);
    await api.call('generate_fixture_test', { ids: [o.id] });
    expect(codegen.fixtureInputs[1].api).toBeUndefined();
  });

  it('url collects finished exchanges; unfinished ids are refused', async () => {
    const { api, host, codegen } = setup();
    const p = ex({ state: 'pending', status: undefined, responseBody: undefined });
    host.exchanges.push(ex(), ex(), p);
    await api.call('generate_fixture_test', { url: 'https://api.example.com/*', name: 'users', style: 'mock_client' });
    expect(codegen.fixtureInputs[0].exchanges).toHaveLength(2);
    expect(codegen.fixtureInputs[0]).toMatchObject({ name: 'users', style: 'mock_client' });
    await rejects(api.call('generate_fixture_test', { ids: [p.id] }), 'invalid', /no finished response/);
    await rejects(api.call('generate_fixture_test', { url: '*/none' }), 'not_found');
    await rejects(api.call('generate_fixture_test', { ids: ['a'], url: '*' }), 'invalid', /exactly one/);
  });
});

describe('assert_traffic', () => {
  it('passes on recorded traffic: status, count, order, json, duration', async () => {
    const { api, host } = setup();
    host.exchanges.push(
      ex({ url: 'https://api.example.com/v1/login', method: 'POST', responseBody: json({ ok: true }) }),
      ex({ url: 'https://api.example.com/v1/users/1' }),
      ex({ url: 'https://api.example.com/v1/users/2' }),
    );
    const r = (await api.call('assert_traffic', {
      url: '*/users/*',
      method: 'GET',
      expect: {
        status: '2xx',
        count: { min: 2 },
        order: ['*/login', '*/users/*'],
        maxDurationMs: 100,
        json: [{ path: '$.id', type: 'integer' }, { path: '$.tags[*]', type: 'string' }, { path: '$.name', equals: 'Ann' }, { path: '$.missing', exists: false }, { path: '$.profile' }],
      },
    })) as any;
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ pass: true, matched: 2, sinceMs: 0 });
    expect(r.ids).toHaveLength(2);
  });

  it('failure texts are readable and never echo response values or secrets', async () => {
    const { api, host } = setup();
    host.exchanges.push(ex({ url: 'https://api.example.com/v1/users/1?access_token=SECRET_Q', status: 500, durationMs: 900 }));
    const r = (await api.call('assert_traffic', {
      url: '*/users/*',
      expect: {
        status: 200,
        count: { exact: 2 },
        order: ['*/users/*', '*/orders*'],
        maxDurationMs: 100,
        json: [
          { path: '$.name', equals: 'Bob' },
          { path: '$.token', equals: 'guess' },
          { path: '$.token', equals: '[redacted]' },
          { path: '$.id', type: 'string' },
          { path: '$.nope' },
          { path: '$.name', exists: false },
        ],
      },
    })) as any;
    expect(r.pass).toBe(false);
    const all = r.failures.join('\n');
    expect(all).toMatch(/count: expected exactly 2 request\(s\) matching \*\/users\/\*, got 1/);
    expect(all).toMatch(/order: no request matching "\*\/orders\*" started after the one matching "\*\/users\/\*"/);
    expect(all).toMatch(/status 500, expected 200/);
    expect(all).toMatch(/took 900 ms, expected at most 100 ms/);
    expect(all).toMatch(/\$\.name does not equal the expected value \(it is a string of 3 characters\)/);
    expect(all).toMatch(/\$\.token does not equal the expected value/);
    expect(all).toMatch(/\$\.id is integer, expected string/);
    expect(all).toMatch(/\$\.nope not found/);
    expect(all).toMatch(/\$\.name is present \(1 value\), expected it to be absent/);
    // equals on a secret compares with the redacted view: only "[redacted]" matches (no oracle)
    expect(r.failures.filter((f: string) => f.includes('$.token'))).toHaveLength(1);
    expect(all).not.toMatch(/Ann|SECRET/);
    expect(all).toContain('access_token=[redacted]');
  });

  it('with redaction off, equals sees real values', async () => {
    const { api, host } = setup({ redact: false });
    host.exchanges.push(ex());
    const r = (await api.call('assert_traffic', { url: '*', expect: { json: [{ path: '$.token', equals: 'SECRET_T' }] } })) as any;
    expect(r.pass).toBe(true);
  });

  it('no match → a clear failure; non-JSON bodies are reported', async () => {
    const { api, host } = setup();
    expect(((await api.call('assert_traffic', { url: '*/x', expect: {} })) as any).failures).toEqual([expect.stringMatching(/no finished request matched \*\/x/)]);
    host.exchanges.push(ex({ responseBody: { text: '<p>', encoding: 'utf8' } }), ex({ responseBody: { text: '{"a":', encoding: 'utf8', truncated: true } }));
    const r = (await api.call('assert_traffic', { url: '*', expect: { json: [{ path: '$.a' }] } })) as any;
    expect(r.failures).toEqual([expect.stringMatching(/not valid JSON/), expect.stringMatching(/truncated/)]);
  });

  it('waits event-driven within withinMs and resolves as soon as the count is reached', async () => {
    let now = 50_000;
    const { api, host } = setup({ now: () => now });
    const p = api.call('assert_traffic', { url: '*/users/*', sinceMs: 50_000, withinMs: 60_000, expect: { count: { min: 2 } } });
    const a = ex({ startedAt: 50_001, state: 'pending', status: undefined });
    host.push(a);
    host.push({ ...a, state: 'completed', status: 200 });
    now = 50_200;
    host.push(ex({ startedAt: 50_100 }));
    const r = (await p) as any;
    expect(r).toMatchObject({ pass: true, matched: 2, waitedMs: 200 });
    expect(host.listenerCount('exchange')).toBe(0);
  });

  it('times out with a failure (never hangs), observes the whole window for upper bounds, and can be cancelled', async () => {
    vi.useFakeTimers();
    try {
      const { api, host } = setup();
      const p = api.call('assert_traffic', { url: '*/users/*', sinceMs: 0, withinMs: 1000, expect: { count: { min: 1 } } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(((await p) as any).failures[0]).toMatch(/expected at least 1/);

      // max: the full window is observed, a pass needs the window to end without too many requests
      let settled = false;
      const q = api.call('assert_traffic', { url: '*/users/*', sinceMs: 0, withinMs: 1000, expect: { count: { max: 1 } } }).then((r) => {
        settled = true;
        return r;
      });
      host.push(ex());
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
      host.push(ex()); // exceeded: settles at once
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(((await q) as any).failures[0]).toMatch(/at most 1 .* got 2/);

      const ctl = new AbortController();
      const c = api.call('assert_traffic', { url: '*/none', withinMs: 60_000, expect: {} }, ctl.signal);
      ctl.abort();
      await rejects(c, 'state', /cancelled/);
      expect(host.listenerCount('exchange')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults sinceMs to the latest launch/restart; validates input', async () => {
    let now = 10_000;
    const { api, host } = setup({ now: () => now });
    host.exchanges.push(ex({ startedAt: 9_000 }));
    await api.call('hot_restart', {});
    now = 10_500;
    host.exchanges.push(ex({ startedAt: 10_100 }));
    const r = (await api.call('assert_traffic', { url: '*', expect: {} })) as any;
    expect(r).toMatchObject({ sinceMs: 10_000, matched: 1 });
    await rejects(api.call('assert_traffic', { url: '*', expect: { count: { exact: 1, min: 1 } } }), 'invalid', /exact alone/);
    await rejects(api.call('assert_traffic', { url: '*', expect: { count: { min: 3, max: 1 } } }), 'invalid', /greater than max/);
    await rejects(api.call('assert_traffic', { url: '*', expect: { json: [{ path: 'name' }] } }), 'invalid', /start with "\$"/);
    await rejects(api.call('assert_traffic', { url: '*', expect: { json: [{ path: '$.a', exists: false, type: 'string' }] } }), 'invalid', /exists:false/);
    await rejects(api.call('assert_traffic', { url: '*', withinMs: 120_001, expect: {} }), 'invalid', /withinMs/);
  });

  it('is a read tool (allowed under readOnly)', async () => {
    const { api } = setup({ access: 'readOnly' });
    expect(((await api.call('assert_traffic', { url: '*', expect: {} })) as any).pass).toBe(false);
  });
});

describe('add_mutation', () => {
  it('inserts a validated mutate rule FIRST with an [agent] name, times and ttlMs', async () => {
    const { api, host } = setup({ now: () => 1_000 });
    host.rules = [{ id: 'old', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }];
    const r = (await api.call('add_mutation', { url: '*/users/*', method: 'get', ops: [{ path: '$.avatar_url', op: 'null' }, { path: '$.id', op: 'set', value: '42' }], times: 1, ttlMs: 5000 })) as any;
    expect(r).toEqual({ ruleId: 'agent_1' });
    expect(host.rules[0]).toEqual({
      id: 'agent_1',
      enabled: true,
      name: '[agent] mutate get */users/*: null $.avatar_url, set $.id',
      match: { url: '*/users/*', method: 'GET' },
      action: { kind: 'mutate', ops: [{ path: '$.avatar_url', op: 'null' }, { path: '$.id', op: 'set', value: '42' }] },
      times: 1,
      expiresAt: 6_000,
    });
    expect(host.rules[1].id).toBe('old');
    await api.call('add_mutation', { url: '*', ops: [{ path: '$.price', op: 'set', valueJson: '1.0' }] });
    expect(host.rules[0].action).toEqual({ kind: 'mutate', ops: [{ path: '$.price', op: 'set', valueJson: '1.0' }] });
    await rejects(api.call('add_mutation', { url: '*', ops: [{ path: '$.a', op: 'set', valueJson: '{' }] }), 'invalid', /valid JSON text/);
  });

  it('refuses invalid ops and read-only access', async () => {
    const { api } = setup();
    await rejects(api.call('add_mutation', { url: '*', ops: [{ path: '$.a', op: 'set' }] }), 'invalid', /needs a value/);
    await rejects(api.call('add_mutation', { url: '*', ops: [{ path: '$.a', op: 'null', value: 1 }] }), 'invalid', /only used with op "set"/);
    await rejects(api.call('add_mutation', { url: '*', ops: [{ path: '$.a[', op: 'null' }] }), 'invalid', /invalid path/);
    await rejects(api.call('add_mutation', { url: '*', ops: [] }), 'invalid', /ops/);
    await rejects(setup({ access: 'readOnly' }).api.call('add_mutation', { url: '*', ops: [{ path: '$.a', op: 'null' }] }), 'access');
  });
});

describe('jsonEqual', () => {
  it('compares structurally', () => {
    expect(jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual(1, '1')).toBe(false);
  });
});

describe('REVIEW-4: no oracles for redacted values', () => {
  const SECRET_URL = 'https://api.example.com/me?access_token=s3cr3tTOKEN&x=1';

  it('#1: a char-by-char URL probe recovers nothing (every filter sees the redacted URL)', async () => {
    const { api, host } = setup();
    const e = ex({ url: SECRET_URL });
    host.exchanges.push(e);
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let recovered = '';
    for (let pos = 0; pos < 3; pos++) {
      let next: string | undefined;
      for (const c of alphabet) {
        const r = (await api.call('list_requests', { url: `*access_token=${recovered}${c}*` })) as any;
        if (r.total) next = c;
      }
      if (next === undefined) break;
      recovered += next;
    }
    expect(recovered).toBe('');
    // the redacted form the agent sees still matches
    expect(((await api.call('list_requests', { url: '*access_token=[redacted]*' })) as any).total).toBe(1);
    // the same for the other filters
    const probe = '*access_token=s*';
    expect(((await api.call('assert_traffic', { url: probe, expect: {} })) as any).pass).toBe(false);
    expect(((await api.call('assert_traffic', { url: '*', expect: { order: ['*/me*', probe] } })) as any).failures.join()).toMatch(/order/);
    expect(((await api.call('check_contract', { url: probe })) as any).results).toEqual([]);
    await rejects(api.call('generate_model', { url: probe }), 'not_found');
    await rejects(api.call('generate_fixture_test', { url: probe }), 'not_found');
    expect(((await api.call('wait_for_request', { url: probe, sinceMs: 0, timeoutMs: 0 })) as any).timedOut).toBe(true);
  });

  it('#1: with redaction off the real URL is matched', async () => {
    const { api, host } = setup({ redact: false });
    host.exchanges.push(ex({ url: SECRET_URL }));
    expect(((await api.call('list_requests', { url: '*access_token=s3cr3t*' })) as any).total).toBe(1);
  });

  it('#1: agent rules may not pin a sensitive query value', async () => {
    const { api } = setup();
    await rejects(api.call('add_mock', { url: '*access_token=a*', body: 'x' }), 'invalid', /pins the value of the query parameter "access_token"/);
    await rejects(api.call('add_mutation', { url: 'https://x/me?api_key=k&x=1', ops: [{ path: '$.a', op: 'null' }] }), 'invalid', /api_key/);
    await rejects(api.call('simulate_network', { url: '*?session=[redacted]', profile: 'slow-3g' }), 'invalid', /session/);
    expect(await api.call('add_block', { url: '*access_token=*' })).toMatchObject({ ruleId: expect.any(String) });
    expect(await api.call('add_block', { url: '*/me?page=2*' })).toMatchObject({ ruleId: expect.any(String) });
  });

  it('#2: /regex/ patterns are refused everywhere (read filters and rules), globs are capped', async () => {
    const { api } = setup();
    await rejects(api.call('list_requests', { url: '/(.+)+Z/' }), 'invalid', /regex/);
    await rejects(api.call('assert_traffic', { url: '*', expect: { order: ['*', '/a/i'] } }), 'invalid', /regex/);
    await rejects(api.call('add_mock', { url: '/api/', body: 'x' }), 'invalid', /regex/);
    await rejects(api.call('add_mutation', { url: `${'*a'.repeat(17)}`, ops: [{ path: '$.a', op: 'null' }] }), 'invalid', /at most 16/);
  });

  it('#7: assertions see the redacted view; nothing below a redacted field is revealed', async () => {
    const { api, host } = setup();
    host.exchanges.push(ex({ responseBody: json({ session: { k_9f2a: 1, k_77: 2 }, token: 12345, name: 'Ann' }) }));
    const r = (await api.call('assert_traffic', {
      url: '*',
      expect: {
        json: [
          { path: '$.session[*]', type: 'string' },
          { path: '$.session.x', equals: 1 },
          { path: '$.session.probe', exists: false },
          { path: '$.session', exists: true },
          { path: '$.token', type: 'string' }, // "[redacted]" in the view
          { path: '$.token', type: 'integer' },
        ],
      },
    })) as any;
    const all = r.failures.join('\n');
    expect(r.failures).toHaveLength(4);
    expect(all.match(/inside a redacted field/g)).toHaveLength(3);
    expect(all).toMatch(/\$\.token is string, expected integer/);
    expect(all).not.toMatch(/k_9f2a|k_77|12345|2 values/);
  });

  it('#8: JSON failures are capped per exchange', async () => {
    const { api, host } = setup();
    host.exchanges.push(ex({ responseBody: json({ tags: Array.from({ length: 500 }, (_, i) => `t${i}`) }) }));
    const r = (await api.call('assert_traffic', { url: '*', expect: { json: [{ path: '$.tags[*]', type: 'number' }, { path: '$.nope' }] } })) as any;
    expect(r.failures).toHaveLength(10);
    expect(r.failures.at(-1)).toMatch(/further JSON failures of x\d+ omitted/);
  });
});
