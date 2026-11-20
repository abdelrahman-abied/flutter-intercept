// CONTRACTS §24 (v0.16.0 part 3) agent side: get_store shows `auth` / `dynamic`; set_store takes `auth` (settings for
// me by default, `expire` is data) and `dynamic`; expire_token on a collection with sign-in simulation on expires its
// sessions instead of adding a rule; get_collection examples carry `byBody`; exchange views say which example the
// pipeline chose and what the auth gate did. No output holds a token or a request body. The host is a fake
// `MockCollectionsHost`.
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { ALL_TOOLS, parseToolInput, TOOL_DOCS } from '../../../src/agent/schema';
import type { AppLauncher } from '../../../src/agent/types';
import { confirmationText } from '../../../src/agent/lmTools';
import { AGENT_SECTION } from '../../../src/agent/instructions';
import { validateRules } from '../../../src/ui/controller';
import type { CollectionEndpointView, CollectionStatus, StoreAuthStatus, StorePatch, StoreStatus } from '../../../src/ui/protocol';

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  getExchanges() {
    return this.exchanges;
  }
  getRules() {
    return this.rules;
  }
  resume() {}
  abort() {}
}

// Planted: what the fake host knows and must never come out of a tool.
const TOKEN = ['fi', 'planted0access0token0value0abcdefghij'].join('.');
const REQUEST_BODY = 'planted-request-password';
const KEY_SECRET = 'Ab3xYz9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm';
const LOGIN_KEY = `POST https://api.shop.example/auth/login?api_key=${KEY_SECRET}`;

type Rec = Record<string, unknown>;

function setup(opts: { access?: 'readWrite' | 'readOnly'; redact?: boolean; auth?: Partial<StoreAuthStatus>; noAuthApi?: boolean } = {}) {
  const host = new FakeHost();
  const patches: StorePatch[] = [];
  const auth: StoreAuthStatus = { available: true, enabled: true, login: LOGIN_KEY, refresh: 'POST {{baseUrl}}/auth/refresh', ttlSeconds: 3600, protect: 'declared', sessions: 2, problems: [], ...opts.auth };
  let dynamic: StoreStatus['dynamic'] = 'random';
  let expired = 0;
  const status = (): StoreStatus => ({ enabled: true, resources: [{ name: 'users', path: '/users/:id', idField: 'id', count: 2, remembers: true, detected: true }], snapshots: [], changed: false, problems: [], auth: { ...auth }, dynamic });
  const collectionStatus: CollectionStatus = {
    id: 'shop-api', name: 'Shop API', file: 'api/shop.json', format: 'insomnia', enabled: true, unmatched: 'passthrough',
    endpoints: 3, mocked: 3, noExample: 0, generated: 0, off: 0, unresolved: [], origins: ['https://api.shop.example'], problems: [], overrides: 0,
  };
  const endpoints: CollectionEndpointView[] = [
    { key: 'POST {{baseUrl}}/auth/login', method: 'POST', name: 'Log in', folder: ['Auth'], url: 'https://api.shop.example/auth/login', examples: [{ name: 'Success', status: 200 }, { name: 'Wrong password', status: 401, byBody: ['password'] }] },
  ];
  const collections: NonNullable<AgentApiDeps['collections']> = {
    state: () => [{ ...collectionStatus, store: status() }],
    endpoints: () => endpoints,
    example: () => ({ status: 200, headers: {}, body: '' }),
    update: async () => undefined,
    importFile: async () => ({ id: 'shop-api' }),
    describeRule: (ruleId) => (ruleId?.startsWith('collection:shop-api:') ? { id: 'shop-api', name: 'Shop API', endpoint: 'POST {{baseUrl}}/auth/login', example: 'Success' } : undefined),
    storeStatus: (id) => {
      if (id !== 'shop-api') throw new Error(`No collection "${id}" is linked`);
      return status();
    },
    storeItems: () => ({ total: 0, items: [] }),
    updateStore: async (_id, patch) => {
      patches.push(patch);
      if (patch.auth?.enabled !== undefined) auth.enabled = patch.auth.enabled;
      if (patch.auth?.ttlSeconds !== undefined) auth.ttlSeconds = patch.auth.ttlSeconds;
      if (patch.auth?.protect !== undefined) auth.protect = patch.auth.protect;
      if (patch.auth?.expire === 'all') expired += auth.sessions;
      if (patch.dynamic !== undefined) dynamic = patch.dynamic;
    },
    storeSnapshot: async () => ({ path: 'x', resources: 0, records: 0 }),
    storeOpOf: () => undefined,
    ...(opts.noAuthApi
      ? {}
      : {
          answerOf: (exchangeId: string) =>
            exchangeId === 'e1' ? { example: 'Wrong password', byBody: true as const } : exchangeId === 'e2' ? { auth: '401 expired' as const, example: 'No token' } : exchangeId === 'e3' ? { auth: '401 no token' as const } : exchangeId === 'e4' ? { auth: 'signed in' as const } : undefined,
          authCollectionFor: (url: string) => (auth.enabled && /^https:\/\/api\.shop\.example(\/|$)/.test(url) ? 'shop-api' : undefined),
          expireSessions: (id: string) => {
            if (id !== 'shop-api') throw new Error(`Sign-in simulation isn't on for "${id}"`);
            const n = auth.sessions;
            expired += n;
            return n;
          },
        }),
  };
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: opts.access ?? 'readWrite', redactSecrets: opts.redact ?? true, interceptEnabled: true }),
    launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
    projectRoot: () => '/ws/app',
    now: () => 50_000,
    collections,
  };
  return { api: createAgentApi(deps), host, patches, auth, expiredCount: () => expired };
}

const clean = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const secret of [TOKEN, REQUEST_BODY, KEY_SECRET]) expect(s).not.toContain(secret);
};

describe('schemas and texts', () => {
  it('52 tools (§23.5); set_store takes auth and dynamic; the instructions stay within budget', () => {
    expect(ALL_TOOLS).toHaveLength(52);
    expect(parseToolInput('set_store', { id: 'shop-api', auth: { enabled: true, ttlSeconds: 600, protect: 'all' }, dynamic: 'seeded' })).toEqual({ id: 'shop-api', auth: { enabled: true, ttlSeconds: 600, protect: 'all' }, dynamic: 'seeded' });
    expect(parseToolInput('set_store', { id: 'shop-api', auth: { expire: 'all' } })).toEqual({ id: 'shop-api', auth: { expire: 'all' } });
    expect(() => parseToolInput('set_store', { id: 'shop-api', auth: { ttlSeconds: 59 } })).toThrow(/ttlSeconds/);
    expect(() => parseToolInput('set_store', { id: 'shop-api', auth: { ttlSeconds: 86_401 } })).toThrow(/ttlSeconds/);
    expect(() => parseToolInput('set_store', { id: 'shop-api', auth: { expire: 'some' } })).toThrow(/expire/);
    expect(() => parseToolInput('set_store', { id: 'shop-api', auth: { password: 'x' } })).toThrow();
    expect(() => parseToolInput('set_store', { id: 'shop-api', auth: { token: 'x' } })).toThrow();
    expect(() => parseToolInput('set_store', { id: 'shop-api', dynamic: 'sometimes' })).toThrow(/dynamic/);
    expect(TOOL_DOCS.get_store.model).toMatch(/auth \{available, enabled, login, refresh, ttlSeconds, protect, sessions \(a count\)/);
    expect(TOOL_DOCS.set_store.model).toMatch(/no password is read/);
    expect(TOOL_DOCS.expire_token.model).toMatch(/sign-in simulation on.*no rule is added/);
    expect(TOOL_DOCS.import_collection.model).toMatch(/Swagger 2\.0.*Insomnia.*Bruno/);
    const lines = AGENT_SECTION.split('\n');
    expect(lines.length).toBeLessThanOrEqual(64);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(120);
    expect(AGENT_SECTION).toMatch(/`set_store \{auth: \{enabled: true\}\}`; `expire_token` then expires its sessions/);
  });

  it('confirmations say what changes', () => {
    const on = confirmationText('set_store', { id: 'shop-api', auth: { enabled: true, ttlSeconds: 120, protect: 'all' } }).message;
    expect(on).toContain('**sign-in simulation** on');
    expect(on).toContain('**120** s');
    expect(on).toContain('every request but login');
    expect(on).toContain('For you only');
    const expire = confirmationText('set_store', { id: 'shop-api', auth: { expire: 'all' } }).message;
    expect(expire).toContain('**expire** every access token');
    expect(expire).toContain('In memory only');
    expect(confirmationText('set_store', { id: 'shop-api', dynamic: 'fixed', scope: 'team' }).message).toMatch(/`fixed` mode[\s\S]*shared with the team/);
    expect(confirmationText('expire_token', { url: 'https://api.shop.example/*' }).message).toMatch(/simulates sign-in.*sessions expire instead/);
  });
});

describe('get_store / get_collection', () => {
  it('the overview carries auth (a count of sessions, keys as agents see them) and dynamic', async () => {
    const { api } = setup();
    const r = (await api.call('get_store', { id: 'shop-api' })) as Rec;
    expect(r.auth).toEqual({
      available: true,
      enabled: true,
      login: 'POST https://api.shop.example/auth/login?api_key=[redacted]',
      refresh: 'POST {{baseUrl}}/auth/refresh',
      ttlSeconds: 3600,
      protect: 'declared',
      sessions: 2,
      problems: [],
    });
    expect(r.dynamic).toBe('random');
    clean(r);
    // without redaction the key is the collection's own
    const raw = (await setup({ redact: false }).api.call('get_store', { id: 'shop-api' })) as { auth: StoreAuthStatus };
    expect(raw.auth.login).toBe(LOGIN_KEY);
  });

  it('a hint when a login request exists and sign-in simulation is off', async () => {
    const { api } = setup({ auth: { enabled: false, sessions: 0 } });
    const r = (await api.call('get_store', { id: 'shop-api' })) as Rec;
    expect(r.note).toMatch(/set_store \{auth: \{enabled: true\}\}/);
  });

  it('get_collection examples carry byBody (field names only)', async () => {
    const { api } = setup();
    const r = (await api.call('get_collection', { id: 'shop-api' })) as { endpoints: { examples: Rec[] }[] };
    expect(r.endpoints[0].examples).toEqual([{ name: 'Success', status: 200 }, { name: 'Wrong password', status: 401, byBody: ['password'] }]);
    clean(r);
  });
});

describe('set_store: auth and dynamic', () => {
  it('settings are for me by default, team on request; the answer holds settings and counts only', async () => {
    const { api, patches } = setup({ auth: { enabled: false, sessions: 0 } });
    const r = (await api.call('set_store', { id: 'shop-api', auth: { enabled: true, ttlSeconds: 120 } })) as Rec;
    expect(patches[0]).toEqual({ auth: { enabled: true, ttlSeconds: 120 }, scope: 'me' });
    expect(r).toMatchObject({ id: 'shop-api', auth: { enabled: true, ttlSeconds: 120, protect: 'declared', sessions: 0 }, note: expect.stringMatching(/for you only/) });
    await api.call('set_store', { id: 'shop-api', auth: { protect: 'all' }, dynamic: 'seeded', scope: 'team' });
    expect(patches[1]).toEqual({ auth: { protect: 'all' }, dynamic: 'seeded', scope: 'team' });
    const d = (await api.call('set_store', { id: 'shop-api', dynamic: 'fixed' })) as Rec;
    expect(patches[2]).toEqual({ dynamic: 'fixed', scope: 'me' });
    expect(d.dynamic).toBe('fixed');
    clean([r, d]);
  });

  it('expire is a data change: no scope, not mixed with settings or other data, needs sign-in simulation on', async () => {
    const { api, patches, expiredCount } = setup();
    const r = (await api.call('set_store', { id: 'shop-api', auth: { expire: 'all' } })) as Rec;
    expect(patches).toEqual([{ auth: { expire: 'all' } }]);
    expect(expiredCount()).toBe(2);
    expect(r.note).toMatch(/every access token is expired \(refresh tokens still work\)/);
    expect(r.auth).toMatchObject({ enabled: true, sessions: 2 });
    clean(r);
    await expect(api.call('set_store', { id: 'shop-api', auth: { expire: 'all' }, scope: 'team' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.call('set_store', { id: 'shop-api', auth: { expire: 'all', enabled: true } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.call('set_store', { id: 'shop-api', resource: 'users', items: [], auth: { expire: 'all' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.call('set_store', { id: 'shop-api', auth: {} })).rejects.toMatchObject({ code: 'invalid' });
    const off = setup({ auth: { enabled: false } });
    await expect(off.api.call('set_store', { id: 'shop-api', auth: { expire: 'all' } })).rejects.toMatchObject({ code: 'state', message: expect.stringMatching(/set_store \{auth: \{enabled: true\}\} first/) });
    expect(off.patches).toEqual([]);
  });

  it('read-only access refuses it', async () => {
    const { api, patches } = setup({ access: 'readOnly' });
    await expect(api.call('set_store', { id: 'shop-api', auth: { expire: 'all' } })).rejects.toMatchObject({ code: 'access' });
    await expect(api.call('expire_token', { url: 'https://api.shop.example/*' })).rejects.toMatchObject({ code: 'access' });
    expect(patches).toEqual([]);
  });
});

describe('expire_token (§24.1)', () => {
  it('on an origin whose collection simulates sign-in: the sessions expire, {expired: n}, no rule', async () => {
    const { api, host, expiredCount } = setup();
    const r = (await api.call('expire_token', { url: 'https://api.shop.example/v1/*', count: 3 })) as Rec;
    expect(r).toEqual({ expired: 2, collection: 'shop-api', note: expect.stringMatching(/No rule was added/) });
    expect(host.rules).toEqual([]);
    expect(expiredCount()).toBe(2);
    clean(r);
  });

  it('nobody signed in: says so', async () => {
    const { api, host } = setup({ auth: { sessions: 0 } });
    expect(await api.call('expire_token', { url: 'https://api.shop.example/*' })).toMatchObject({ expired: 0, note: expect.stringMatching(/nobody is signed in/) });
    expect(host.rules).toEqual([]);
  });

  it('another origin, sign-in simulation off, or a host without it: the sequence rule as before', async () => {
    // another server than the collection's: the usual rule, whatever the collection does
    for (const s of [setup(), setup({ auth: { enabled: false } }), setup({ noAuthApi: true })]) {
      const r = (await s.api.call('expire_token', { url: 'https://api.example.com/v1/*' })) as Rec;
      expect(r).toMatchObject({ ruleId: expect.any(String), count: 1, match: 'https://api.example.com/v1/*' });
      expect(s.host.rules).toHaveLength(1);
      expect(s.host.rules[0].action.kind).toBe('sequence');
      expect(s.expiredCount()).toBe(0);
    }
    // the collection's own origin with sign-in simulation off, or no auth API on the host → a rule too
    for (const s of [setup({ auth: { enabled: false } }), setup({ noAuthApi: true })]) {
      await s.api.call('expire_token', { url: 'https://api.shop.example/*' });
      expect(s.host.rules).toHaveLength(1);
      expect(s.expiredCount()).toBe(0);
    }
  });
});

describe('exchange views (§24)', () => {
  const ex = (id: string, ruleId?: string) =>
    ({ id, method: 'POST', url: 'https://api.shop.example/auth/login', state: 'mocked', startedAt: 1, requestHeaders: {}, requestBody: { text: JSON.stringify({ password: REQUEST_BODY }), encoding: 'utf8' }, notes: ['auth: signed in'], ...(ruleId ? { matchedRuleId: ruleId } : {}) }) as unknown as Exchange;

  it('collection.example is the one that answered; byBody and auth say why', async () => {
    const { api, host } = setup();
    host.exchanges = [ex('e1', 'collection:shop-api:1'), ex('e2', 'collection:shop-api:1'), ex('e3', 'collection:shop-api:1'), ex('e4', 'collection:shop-api:1'), ex('e5', 'collection:shop-api:1')];
    const list = (await api.call('list_requests', {})) as { items: Rec[] };
    const by = (id: string) => list.items.find((r) => r.id === id)!.collection as Rec;
    expect(by('e1')).toEqual({ id: 'shop-api', name: 'Shop API', endpoint: 'POST {{baseUrl}}/auth/login', example: 'Wrong password', byBody: true });
    expect(by('e2')).toEqual({ id: 'shop-api', name: 'Shop API', endpoint: 'POST {{baseUrl}}/auth/login', example: 'No token', auth: '401 expired' });
    // the built-in 401 has no example to name
    expect(by('e3')).toEqual({ id: 'shop-api', name: 'Shop API', endpoint: 'POST {{baseUrl}}/auth/login', auth: '401 no token' });
    expect(by('e4')).toEqual({ id: 'shop-api', name: 'Shop API', endpoint: 'POST {{baseUrl}}/auth/login', example: 'Success', auth: 'signed in' });
    expect(by('e5')).toEqual({ id: 'shop-api', name: 'Shop API', endpoint: 'POST {{baseUrl}}/auth/login', example: 'Success' });
    clean(list);
    clean(await api.call('get_request', { id: 'e4' }));
  });
});
