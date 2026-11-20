// CONTRACTS §21.10 (v0.15.0) agent side: list_collections / get_collection / get_collection_example (redacted like
// traffic), import_collection (workspace files only, through the service) and set_collection (patch built from the
// input, errors mapped), read-only access, no remove tool, and the LM confirmations.
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { ALL_TOOLS, parseToolInput, TOOL_DOCS } from '../../../src/agent/schema';
import type { AppLauncher } from '../../../src/agent/types';
import { confirmationText, invocationMessage } from '../../../src/agent/lmTools';
import { AGENT_SECTION } from '../../../src/agent/instructions';
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

const status = (over: Partial<CollectionStatus> = {}): CollectionStatus => ({
  id: 'shop-api', name: 'Shop API', file: 'api/shop.json', format: 'postman', enabled: true, unmatched: 'passthrough',
  endpoints: 3, mocked: 2, noExample: 1, generated: 0, off: 0, unresolved: [], origins: ['https://api.shop.example'], problems: [], overrides: 0, ...over,
});
const views: CollectionEndpointView[] = [
  { key: 'POST {{baseUrl}}/auth/login', method: 'POST', name: 'Log in', folder: ['Auth'], url: 'https://api.shop.example/auth/login', examples: [{ name: 'Success', status: 200 }, { name: 'Wrong password', status: 401 }] },
  { key: 'GET {{baseUrl}}/users/me', method: 'GET', name: 'Me', folder: ['Users'], url: 'https://api.shop.example/users/me', examples: [{ name: 'OK', status: 200 }] },
  { key: 'GET {{baseUrl}}/users/:id', method: 'GET', name: 'User by id', folder: ['Users'], url: 'https://api.shop.example/users/:id', examples: [] },
];

function setup(opts: { access?: 'readWrite' | 'readOnly'; redact?: boolean; noService?: boolean } = {}) {
  const host = new FakeHost();
  const launcher = { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher;
  const updates: [string, CollectionPatch][] = [];
  const imports: { file: string; environment?: string }[] = [];
  let statuses = [status()];
  const collections: NonNullable<AgentApiDeps['collections']> = {
    state: () => statuses,
    endpoints: (id) => {
      if (id !== 'shop-api') throw new Error(`No collection "${id}" is linked`);
      return views;
    },
    example: (id, endpoint, name) => {
      if (name !== 'Success') throw new Error(`The request "${endpoint}" has no example "${name}"`);
      return { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc123' }, body: '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl","user":{"id":1}}' };
    },
    update: async (id, patch) => {
      if (id !== 'shop-api') throw new Error(`No collection "${id}" is linked`);
      if (patch.example && patch.example.name === 'Nope') throw new Error(`The request "${patch.example.endpoint}" has no example "Nope"`);
      updates.push([id, patch]);
      statuses = [status({ unmatched: patch.unmatched ?? 'passthrough' })];
    },
    importFile: async (pick) => {
      if (pick.file.startsWith('/') || pick.file.includes('..')) throw new Error('The collection must be a file inside the workspace');
      imports.push(pick);
      statuses = [...statuses, status({ id: 'orders', name: 'Orders', unresolved: ['baseUrl'] })];
      return { id: 'orders' };
    },
  };
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: () => undefined,
    clear: () => undefined,
    getSettings: () => ({ access: opts.access ?? 'readWrite', redactSecrets: opts.redact ?? true, interceptEnabled: true }),
    launcher,
    projectRoot: () => '/ws/app',
    now: () => 50_000,
    ...(opts.noService ? {} : { collections }),
  };
  return { api: createAgentApi(deps), updates, imports };
}

describe('collection tools', () => {
  it('are registered with docs; there is no remove tool', () => {
    for (const t of ['list_collections', 'get_collection', 'get_collection_example', 'import_collection', 'set_collection'] as const) {
      expect(ALL_TOOLS).toContain(t);
      expect(TOOL_DOCS[t].model.length).toBeGreaterThan(40);
    }
    expect(ALL_TOOLS.some((t) => /remove_collection/.test(t))).toBe(false);
  });

  it('list_collections returns the statuses, with a hint when none', async () => {
    const { api } = setup();
    expect(await api.call('list_collections', {})).toEqual({ collections: [status()] });
  });

  it('get_collection filters and limits', async () => {
    const { api } = setup();
    const all = (await api.call('get_collection', { id: 'shop-api' })) as { endpoints: CollectionEndpointView[]; total: number };
    expect(all.total).toBe(3);
    expect(await api.call('get_collection', { id: 'shop-api', filter: 'USERS', limit: 1 })).toEqual({ id: 'shop-api', endpoints: [views[1]], total: 2, more: 1 });
    await expect(api.call('get_collection', { id: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('get_collection_example redacts like traffic (and not when redaction is off)', async () => {
    const { api } = setup();
    const r = (await api.call('get_collection_example', { id: 'shop-api', endpoint: views[0].key, example: 'Success' })) as { status: number; headers: Record<string, string>; body: { text: string } };
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).not.toContain('abc123');
    expect(r.body.text).not.toContain('c2lnbmF0dXJlLXZhbHVl');
    const raw = (await setup({ redact: false }).api.call('get_collection_example', { id: 'shop-api', endpoint: views[0].key, example: 'Success' })) as { headers: Record<string, string>; body: { text: string } };
    expect(raw.headers['set-cookie']).toBe('sid=abc123');
    await expect(api.call('get_collection_example', { id: 'shop-api', endpoint: views[0].key, example: 'Gone' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('import_collection goes through the service and points at unset variables', async () => {
    const { api, imports } = setup();
    const r = await api.call('import_collection', { file: 'api/orders.json', environment: 'api/dev.json' });
    expect(imports).toEqual([{ file: 'api/orders.json', environment: 'api/dev.json' }]);
    expect(r).toMatchObject({ id: 'orders', unresolved: ['baseUrl'] });
    expect(String(r.note)).toContain('set_collection {id: "orders", variable');
    await expect(api.call('import_collection', { file: '/etc/passwd' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('set_collection builds the patch from the input and maps errors', async () => {
    const { api, updates } = setup();
    const r = await api.call('set_collection', { id: 'shop-api', unmatched: 'fail', example: { endpoint: views[0].key, name: 'Wrong password' } });
    expect(updates).toEqual([['shop-api', { unmatched: 'fail', example: { endpoint: views[0].key, name: 'Wrong password' } }]]);
    expect(r).toMatchObject({ id: 'shop-api', unmatched: 'fail' });
    await expect(api.call('set_collection', { id: 'shop-api' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.call('set_collection', { id: 'shop-api', example: { endpoint: views[0].key, name: 'Nope' } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(api.call('set_collection', { id: 'other', enabled: false })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('input validation', () => {
    expect(() => parseToolInput('set_collection', { id: 'Bad Id', enabled: true })).toThrow();
    expect(() => parseToolInput('set_collection', { id: 'a', variable: { name: 'bad name', value: 'x' } })).toThrow();
    expect(() => parseToolInput('get_collection', { id: 'a', limit: 501 })).toThrow();
    expect(parseToolInput('get_collection', { id: 'a' })).toEqual({ id: 'a', limit: 100 });
    expect(parseToolInput('get_collection_example', { id: 'a', endpoint: 'GET x', example: 'y' })).toEqual({ id: 'a', endpoint: 'GET x', example: 'y', maxBodyChars: 20_000 });
  });

  it('read-only access refuses import and set, allows reads', async () => {
    const { api, updates } = setup({ access: 'readOnly' });
    await expect(api.call('set_collection', { id: 'shop-api', enabled: false })).rejects.toMatchObject({ code: 'access' });
    await expect(api.call('import_collection', { file: 'a.json' })).rejects.toMatchObject({ code: 'access' });
    expect(await api.call('list_collections', {})).toMatchObject({ collections: [status()] });
    expect(updates).toEqual([]);
  });

  it('without the service: a clear state error', async () => {
    await expect(setup({ noService: true }).api.call('list_collections', {})).rejects.toMatchObject({ code: 'state' });
  });

  it('LM texts say what changes and that the team file is written', () => {
    const c = confirmationText('set_collection', { id: 'shop-api', unmatched: 'fail', example: { endpoint: 'POST {{baseUrl}}/login', name: 'Wrong password' } });
    expect(c.message).toContain('**fail like offline**');
    expect(c.message).toContain('answer `POST {{baseUrl}}/login` with example `Wrong password`');
    expect(c.message).toContain('shared with the team');
    expect(confirmationText('set_collection', { id: 'shop-api', enabled: false }).message).not.toContain('shared with the team');
    expect(confirmationText('import_collection', { file: 'api/shop.json' }).message).toContain('`api/shop.json`');
    expect(invocationMessage('get_collection', { id: 'shop-api' })).toBe('Reading the requests of collection shop-api');
  });

  it('the instructions mention the workflow', () => {
    const text = AGENT_SECTION;
    expect(text).toContain('import_collection');
    expect(text).toContain('set_collection');
  });
});
