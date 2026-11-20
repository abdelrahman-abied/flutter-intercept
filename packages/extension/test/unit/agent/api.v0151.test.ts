// CONTRACTS §21.15 (agent-friendly amendments) and REVIEW-15 #5 on the agent side: exchanges say which collection
// answer they got, `request` names a collection request by a traffic id, changes are "for me" unless scope "team",
// reset, and keys / query values are redacted (and still accepted back in their redacted form).
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import type { AppLauncher } from '../../../src/agent/types';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus } from '../../../src/ui/protocol';

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

const LOGIN = 'POST {{baseUrl}}/auth/login';
const SECRET_KEY = 'GET https://bot:hunter2@api.shop.example/hook';
// A Stripe-format fake key, built at run time so secret scanners don't flag the source.
const FAKE_TOKEN = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
const status: CollectionStatus = {
  id: 'shop-api', name: 'Shop API', file: 'api/shop.json', format: 'postman', enabled: true, unmatched: 'passthrough',
  endpoints: 2, mocked: 2, noExample: 0, generated: 0, off: 0, unresolved: [], origins: ['https://api.shop.example'], problems: [], overrides: 0,
  seen: { notInCollection: [{ method: 'GET', path: '/orders/{id}', count: 2 }], noExample: [] },
};
const views: CollectionEndpointView[] = [
  { key: LOGIN, method: 'POST', name: 'Log in', folder: [], url: 'https://api.shop.example/auth/login', examples: [{ name: 'Success', status: 200 }, { name: 'Wrong password', status: 401, query: { access_token: FAKE_TOKEN, page: '2' } }] },
  { key: SECRET_KEY, method: 'GET', name: 'Hook', folder: [], url: 'https://bot:hunter2@api.shop.example/hook', examples: [{ name: 'OK', status: 200 }] },
];

function ex(id: string, method: string, url: string, matchedRuleId?: string): Exchange {
  return { id, method, url, state: 'mocked', startedAt: 1, requestHeaders: {}, ...(matchedRuleId ? { matchedRuleId } : {}) } as unknown as Exchange;
}

function setup(redact = true) {
  const host = new FakeHost();
  const updates: [string, CollectionPatch][] = [];
  const collections: NonNullable<AgentApiDeps['collections']> = {
    state: () => [status],
    endpoints: () => views,
    example: (_id, endpoint) => ({ status: 200, headers: {}, body: `{"for":"${endpoint.length}"}` }),
    update: async (id, patch) => {
      updates.push([id, patch]);
    },
    importFile: async () => ({ id: 'shop-api' }),
    describeRule: (ruleId) => (ruleId === 'collection:shop-api:1' ? { id: 'shop-api', name: 'Shop API', endpoint: LOGIN, example: 'Success', limited: ['set-cookie'] } : undefined),
    endpointForRequest: (_id, e) => {
      if (e.url.includes('/auth/login')) return LOGIN;
      throw new Error(`${e.method} ${e.url} is not in collection "shop-api"`);
    },
  };
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: () => undefined,
    clear: () => undefined,
    getSettings: () => ({ access: 'readWrite', redactSecrets: redact, interceptEnabled: true }),
    launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
    projectRoot: () => '/ws/app',
    now: () => 50_000,
    collections,
  };
  return { api: createAgentApi(deps), host, updates };
}

describe('§21.15 #2: an exchange says which collection answer it got', () => {
  it('list_requests and get_request carry `collection`', async () => {
    const { api, host } = setup();
    host.exchanges = [ex('e1', 'POST', 'https://api.shop.example/auth/login', 'collection:shop-api:1'), ex('e2', 'GET', 'https://api.shop.example/x', 'rule_1')];
    const list = (await api.call("list_requests", {})) as { items: Record<string, unknown>[] };
    const first = list.items.find((r) => r.id === 'e1')!;
    expect(first.collection).toEqual({ id: 'shop-api', name: 'Shop API', endpoint: LOGIN, example: 'Success', limited: ['set-cookie'] });
    expect(list.items.find((r) => r.id === 'e2')!.collection).toBeUndefined();
    expect(((await api.call('get_request', { id: 'e1' })) as Record<string, unknown>).collection).toMatchObject({ endpoint: LOGIN });
  });
});

describe('§21.15 #1 / #3: set_collection', () => {
  it('example by request: resolved to the endpoint, for me by default, with a note on how to undo', async () => {
    const { api, host, updates } = setup();
    host.exchanges = [ex('e1', 'POST', 'https://api.shop.example/auth/login', 'collection:shop-api:1')];
    const r = (await api.call('set_collection', { id: 'shop-api', example: { request: 'e1', name: 'Wrong password' } })) as { note: string };
    expect(updates).toEqual([['shop-api', { example: { endpoint: LOGIN, name: 'Wrong password' } }]]);
    expect(r.note).toContain('changed for you only');
  });

  it('scope "team" is passed on; reset (all or one request) stands alone', async () => {
    const { api, host, updates } = setup();
    host.exchanges = [ex('e1', 'POST', 'https://api.shop.example/auth/login')];
    await api.call('set_collection', { id: 'shop-api', unmatched: 'fail', scope: 'team' });
    await api.call('set_collection', { id: 'shop-api', reset: true });
    await api.call('set_collection', { id: 'shop-api', reset: true, request: 'e1' });
    expect(updates).toEqual([
      ['shop-api', { unmatched: 'fail', scope: 'team' }],
      ['shop-api', { reset: true }],
      ['shop-api', { reset: true, endpoint: LOGIN }],
    ]);
    await expect(api.call('set_collection', { id: 'shop-api', reset: true, unmatched: 'fail' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.call('set_collection', { id: 'shop-api', reset: true, scope: 'team' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.call('set_collection', { id: 'shop-api', request: 'e1' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('exactly one of endpoint / request; a request the collection lacks is a readable error', async () => {
    const { api, host } = setup();
    host.exchanges = [ex('e9', 'GET', 'https://api.shop.example/orders/1')];
    await expect(api.call('set_collection', { id: 'shop-api', example: { name: 'x' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.call('set_collection', { id: 'shop-api', example: { endpoint: LOGIN, request: 'e9', name: 'x' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.call('set_collection', { id: 'shop-api', example: { request: 'e9', name: 'x' } })).rejects.toThrow('is not in collection "shop-api"');
    await expect(api.call('set_collection', { id: 'shop-api', example: { request: 'gone', name: 'x' } })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('REVIEW-15 #5: redaction', () => {
  it('get_collection redacts keys, URLs and credential-like query values; a redacted key is accepted back', async () => {
    const { api, updates } = setup();
    const r = (await api.call('get_collection', { id: 'shop-api' })) as { endpoints: CollectionEndpointView[]; seen: unknown };
    const out = JSON.stringify(r);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain(FAKE_TOKEN);
    expect(r.endpoints[0].examples[1].query).toMatchObject({ page: '2' });
    expect(r.seen).toEqual(status.seen);
    const shownKey = r.endpoints[1].key;
    expect(shownKey).not.toBe(SECRET_KEY);
    await api.call('set_collection', { id: 'shop-api', off: { endpoint: shownKey, off: true } });
    expect(updates.at(-1)).toEqual(['shop-api', { off: { endpoint: SECRET_KEY, off: true } }]);
  });

  it('with redaction off, keys are shown as they are', async () => {
    const { api } = setup(false);
    const r = (await api.call('get_collection', { id: 'shop-api' })) as { endpoints: CollectionEndpointView[] };
    expect(r.endpoints[1].key).toBe(SECRET_KEY);
  });
});
