// CONTRACTS §22.11 (v0.16.0) agent side: get_store (status, records through the agent redaction, paging, fields,
// shape, a filter that can't probe a redacted value), set_store (one data change per call, settings for me by
// default, counts only), store_snapshot (path, blanked), read-only access, exchange views with `collection.store`,
// the MCP / LM texts and the instructions line. The host is a fake `MockCollectionsHost`.
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { ALL_TOOLS, parseToolInput, TOOL_DOCS } from '../../../src/agent/schema';
import { READ_TOOLS, WRITE_TOOLS, type AppLauncher } from '../../../src/agent/types';
import { confirmationText, invocationMessage } from '../../../src/agent/lmTools';
import { AGENT_SECTION } from '../../../src/agent/instructions';
import { MAX_STORE_RESULT_CHARS } from '../../../src/agent/tools/store';
import type { CollectionStatus, StoreOpView, StorePatch, StoreStatus } from '../../../src/ui/protocol';

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

// Built at run time so secret scanners don't flag the source.
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
const OPAQUE = ['Ab3', 'xYz9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm'].join('');
const PASSWORD = 'hunter2-pw';

const collectionStatus = (id = 'shop-api'): CollectionStatus => ({
  id, name: 'Shop API', file: 'api/shop.json', format: 'postman', enabled: true, unmatched: 'passthrough',
  endpoints: 5, mocked: 5, noExample: 0, generated: 0, off: 0, unresolved: [], origins: ['https://api.shop.example'], problems: [], overrides: 0,
});

type Rec = Record<string, unknown>;

/** A fake store: users (with secrets) and todos; storeItems filters like the real one (JSON text, case-insensitive). */
function fakeStore() {
  const data: Record<string, Rec[]> = {
    users: [
      { id: 1, name: 'Ada', password: PASSWORD, profile: { apiToken: 'plain-looking', bio: 'hi' }, session: JWT, note: OPAQUE },
      { id: 2, name: 'Bob', password: 'other', avatar: `Bearer ${JWT}` },
    ],
    todos: Array.from({ length: 30 }, (_, n) => ({ id: n + 1, title: `todo ${n + 1}`, completed: n % 2 === 0, userId: 1 })),
  };
  const remembers: Record<string, boolean> = { users: true, todos: true };
  let snapshots = ['checkout'];
  let enabled = true;
  const patches: StorePatch[] = [];
  const itemsCalls: { resource: string; opts: unknown }[] = [];
  const status = (): StoreStatus => ({
    enabled,
    resources: Object.keys(data).map((name) => ({ name, path: `/${name}/:id`, idField: 'id', count: data[name].length, remembers: remembers[name], detected: true })),
    snapshots,
    changed: patches.length > 0,
    problems: [],
  });
  const host = {
    storeStatus: (id: string) => (id === 'shop-api' ? status() : id === 'plain' ? undefined : undefined),
    storeItems: (id: string, resource: string, opts: { offset?: number; limit?: number; filter?: string } = {}) => {
      itemsCalls.push({ resource, opts });
      let recs = data[resource] ?? [];
      if (opts.filter) recs = recs.filter((r) => JSON.stringify(r).toLowerCase().includes(opts.filter!.toLowerCase()));
      const offset = opts.offset ?? 0;
      return { total: recs.length, items: recs.slice(offset, offset + Math.min(1000, opts.limit ?? 50)).map((r) => JSON.parse(JSON.stringify(r))) };
    },
    updateStore: async (id: string, patch: StorePatch) => {
      if (id !== 'shop-api') throw new Error(`No collection "${id}" is linked`);
      patches.push(patch);
      if (patch.replace) data[patch.resource!] = patch.replace as Rec[];
      if (patch.generate) data[patch.resource!] = [...data[patch.resource!], ...Array.from({ length: patch.generate.count }, (_, n) => ({ id: 1000 + n, title: 'generated' }))];
      if (patch.put) {
        const item = patch.put.item as Rec;
        const list = data[patch.resource!];
        const at = list.findIndex((r) => r.id === item.id);
        if (at >= 0) list[at] = item;
        else list.push(item);
      }
      if (patch.remove) data[patch.resource!] = data[patch.resource!].filter((r) => String(r.id) !== patch.remove!.itemId);
      if (patch.enabled !== undefined) enabled = patch.enabled;
      if (patch.remembers !== undefined) remembers[patch.resource!] = patch.remembers;
    },
    storeSnapshot: async (id: string, action: 'save' | 'load' | 'delete', name?: string) => {
      if (action === 'save') snapshots = [...new Set([...snapshots, name!])];
      if (action === 'delete') snapshots = snapshots.filter((s) => s !== name);
      return { path: `/ws/app/.vscode/flutter-intercept/snapshots/${id}/${name}.json`, resources: 2, records: 32, ...(action === 'save' ? { blanked: ['users.password', 'users.session'] } : {}) };
    },
    storeOpOf: (exchangeId: string): StoreOpView | undefined =>
      exchangeId === 'e1' ? { resource: 'todos', op: 'create', itemId: '31' } : exchangeId === 'e3' ? { resource: 'users', op: 'get', itemId: OPAQUE } : undefined,
  };
  return { data, storeHost: host, patches, itemsCalls, remembers };
}

function setup(opts: { access?: 'readWrite' | 'readOnly'; redact?: boolean; noStore?: boolean } = {}) {
  const fake = fakeStore();
  const host = new FakeHost();
  const collections: NonNullable<AgentApiDeps['collections']> = {
    state: () => [collectionStatus(), collectionStatus('plain')],
    endpoints: () => [],
    example: () => ({ status: 200, headers: {}, body: '' }),
    update: async () => undefined,
    importFile: async () => ({ id: 'shop-api' }),
    describeRule: (ruleId) => (ruleId?.startsWith('collection:shop-api:') ? { id: 'shop-api', name: 'Shop API', endpoint: 'POST {{baseUrl}}/todos' } : undefined),
    ...(opts.noStore ? {} : fake.storeHost),
  };
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: () => undefined,
    clear: () => undefined,
    getSettings: () => ({ access: opts.access ?? 'readWrite', redactSecrets: opts.redact ?? true, interceptEnabled: true }),
    launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
    projectRoot: () => '/ws/app',
    now: () => 50_000,
    collections,
  };
  return { api: createAgentApi(deps), host, ...fake };
}

const secretFree = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const secret of [PASSWORD, JWT, OPAQUE, 'plain-looking']) expect(s).not.toContain(secret);
};

describe('store tools: registration and schemas', () => {
  it('get_store reads; set_store and store_snapshot write; 52 tools in all (§23.5)', () => {
    expect(READ_TOOLS).toContain('get_store');
    expect(WRITE_TOOLS).toContain('set_store');
    expect(WRITE_TOOLS).toContain('store_snapshot');
    expect(ALL_TOOLS).toHaveLength(52);
    for (const t of ['get_store', 'set_store', 'store_snapshot'] as const) expect(TOOL_DOCS[t].model.length).toBeGreaterThan(40);
    expect(ALL_TOOLS.some((t) => /approve|remove_collection/.test(t))).toBe(false);
  });

  it('input validation and defaults', () => {
    expect(parseToolInput('get_store', { id: 'shop-api' })).toEqual({ id: 'shop-api', offset: 0, limit: 20 });
    expect(() => parseToolInput('get_store', { id: 'shop-api', resource: 'todos', limit: 201 })).toThrow(/limit/);
    expect(() => parseToolInput('get_store', { id: 'shop-api', resource: 'todos', limit: 0 })).toThrow(/limit/);
    expect(() => parseToolInput('get_store', { id: 'shop-api', resource: 'todos', fields: [] })).toThrow(/fields/);
    expect(() => parseToolInput('get_store', { id: 'shop-api', scope: { 'bad name': '1' } })).toThrow(/scope/);
    expect(() => parseToolInput('set_store', { id: 'shop-api', resource: 'todos', generate: { count: 5001 } })).toThrow(/count/);
    expect(() => parseToolInput('set_store', { id: 'shop-api', resource: 'todos', items: [1, 2] })).toThrow(/items/);
    expect(() => parseToolInput('set_store', { id: 'shop-api', reset: 'everything' })).toThrow(/reset/);
    expect(() => parseToolInput('set_store', { id: 'shop-api', startsFrom: '../x' })).toThrow(/startsFrom/);
    expect(parseToolInput('set_store', { id: 'shop-api', startsFrom: null })).toEqual({ id: 'shop-api', startsFrom: null });
    for (const name of ['', 'Upper', '../etc', 'a b', 'x'.repeat(41), 'a/b']) expect(() => parseToolInput('store_snapshot', { id: 'shop-api', action: 'save', name })).toThrow(/name/);
    expect(() => parseToolInput('store_snapshot', { id: 'shop-api', action: 'save' })).toThrow(/name/);
    expect(() => parseToolInput('store_snapshot', { id: 'shop-api', action: 'rename', name: 'a' })).toThrow(/action/);
    expect(parseToolInput('store_snapshot', { id: 'shop-api', action: 'save', name: 'empty-cart-2' })).toEqual({ id: 'shop-api', action: 'save', name: 'empty-cart-2' });
  });
});

describe('get_store', () => {
  it('without resource: the store status; unknown collection → not_found; no store → a note', async () => {
    const { api } = setup();
    const r = (await api.call('get_store', { id: 'shop-api' })) as Rec;
    expect(r).toMatchObject({ id: 'shop-api', enabled: true, snapshots: ['checkout'], resources: [{ name: 'users', count: 2 }, { name: 'todos', count: 30 }] });
    expect(String(r.note)).toContain('get_store {resource}');
    secretFree(r);
    await expect(api.call('get_store', { id: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await api.call('get_store', { id: 'plain' })).toMatchObject({ id: 'plain', resources: [], note: expect.stringContaining('no data that remembers') });
    await expect(api.call('get_store', { id: 'shop-api', filter: 'x' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('records through the agent redaction: secret-like fields, JWTs, Bearer values and opaque tokens never appear', async () => {
    const { api } = setup();
    const r = (await api.call('get_store', { id: 'shop-api', resource: 'users' })) as { items: Rec[]; total: number };
    expect(r.total).toBe(2);
    secretFree(r);
    expect(r.items[0]).toMatchObject({ id: 1, name: 'Ada', password: '[redacted]', session: '[redacted]', note: '[redacted]', profile: { apiToken: '[redacted]', bio: 'hi' } });
    expect(String(r.items[1].avatar)).toContain('[redacted]');
    // with redaction off the user sees their own data
    const raw = (await setup({ redact: false }).api.call('get_store', { id: 'shop-api', resource: 'users' })) as { items: Rec[] };
    expect(raw.items[0].password).toBe(PASSWORD);
  });

  it('a filter is matched against what the agent sees, so it cannot probe a redacted value', async () => {
    const { api, itemsCalls } = setup();
    expect(await api.call('get_store', { id: 'shop-api', resource: 'users', filter: 'hunter2' })).toMatchObject({ total: 0, items: [] });
    expect(itemsCalls.every((c) => !(c.opts as Rec).filter)).toBe(true);
    expect(await api.call('get_store', { id: 'shop-api', resource: 'users', filter: 'ADA' })).toMatchObject({ total: 1, items: [{ id: 1 }] });
    // redaction off: the host filters
    const off = setup({ redact: false });
    expect(await off.api.call('get_store', { id: 'shop-api', resource: 'users', filter: 'hunter2' })).toMatchObject({ total: 1 });
    expect(off.itemsCalls.at(-1)!.opts).toMatchObject({ filter: 'hunter2' });
  });

  it('pages with offset / limit (default 20) and says what is left', async () => {
    const { api } = setup();
    const first = (await api.call('get_store', { id: 'shop-api', resource: 'todos' })) as Rec;
    expect(first).toMatchObject({ resource: 'todos', total: 30, more: 10, next: 20 });
    expect((first.items as unknown[]).length).toBe(20);
    const last = (await api.call('get_store', { id: 'shop-api', resource: 'todos', offset: 20, limit: 50 })) as Rec;
    expect((last.items as Rec[]).map((t) => t.id)).toEqual(Array.from({ length: 10 }, (_, n) => n + 21));
    expect(last.more).toBeUndefined();
  });

  it('fields keeps only those keys (and the id); shape gives the structure, small for 500 records', async () => {
    const { api, data } = setup();
    const r = (await api.call('get_store', { id: 'shop-api', resource: 'todos', fields: ['title'], limit: 2 })) as { items: Rec[] };
    expect(r.items).toEqual([{ id: 1, title: 'todo 1' }, { id: 2, title: 'todo 2' }]);
    data.todos = Array.from({ length: 500 }, (_, n) => ({ id: n + 1, title: `t${n}`, completed: false, tags: ['a'], owner: { password: PASSWORD } }));
    const s = (await api.call('get_store', { id: 'shop-api', resource: 'todos', shape: true })) as Rec;
    expect(s.items).toBeUndefined();
    expect(s.total).toBe(500);
    expect(JSON.stringify(s).length).toBeLessThan(1000);
    expect(JSON.stringify(s.shape)).toContain('completed');
    secretFree(s);
  });

  it('cuts very large answers and says how to get less', async () => {
    const { api, data } = setup();
    data.todos = Array.from({ length: 50 }, (_, n) => ({ id: n + 1, text: 'x'.repeat(10_000) }));
    const r = (await api.call('get_store', { id: 'shop-api', resource: 'todos', limit: 50 })) as Rec;
    expect(JSON.stringify(r.items).length).toBeLessThanOrEqual(MAX_STORE_RESULT_CHARS + 100);
    expect(r.more).toBeGreaterThan(0);
    expect(String(r.note)).toContain('shape');
  });

  it('an unknown resource names the ones there are', async () => {
    const { api } = setup();
    await expect(api.call('get_store', { id: 'shop-api', resource: 'orders' })).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('users, todos') });
  });
});

describe('set_store', () => {
  it('items replaces the data; the answer is counts only', async () => {
    const { api, patches } = setup();
    const r = (await api.call('set_store', { id: 'shop-api', resource: 'todos', items: [] })) as Rec;
    expect(patches).toEqual([{ resource: 'todos', replace: [] }]);
    expect(r).toMatchObject({ id: 'shop-api', resource: 'todos', count: 0 });
    expect(String(r.note)).toContain('reset: "data"');
    expect(r.items).toBeUndefined();
  });

  it('put / remove / generate build their patch; "[redacted]" values keep the stored value', async () => {
    const { api, patches, data } = setup();
    await api.call('set_store', { id: 'shop-api', resource: 'users', put: { id: 1, name: 'Ada L', password: '[redacted]', profile: { apiToken: '[redacted]', bio: 'new' } } });
    expect(patches[0]).toEqual({ resource: 'users', put: { item: { id: 1, name: 'Ada L', password: PASSWORD, profile: { apiToken: 'plain-looking', bio: 'new' } } } });
    expect(data.users[0].password).toBe(PASSWORD);
    await api.call('set_store', { id: 'shop-api', resource: 'users', remove: 2 });
    expect(patches[1]).toEqual({ resource: 'users', remove: { itemId: '2' } });
    const g = (await api.call('set_store', { id: 'shop-api', resource: 'todos', generate: { count: 500 } })) as Rec;
    expect(patches[2]).toEqual({ resource: 'todos', generate: { count: 500 } });
    expect(g.count).toBe(530);
  });

  it('settings are for me by default; team on request; reset stands alone', async () => {
    const { api, patches } = setup();
    const me = (await api.call('set_store', { id: 'shop-api', resource: 'todos', remembers: false })) as Rec;
    expect(patches[0]).toEqual({ resource: 'todos', remembers: false, scope: 'me' });
    expect(String(me.note)).toContain('for you only');
    await api.call('set_store', { id: 'shop-api', enabled: false, scope: 'team' });
    expect(patches[1]).toEqual({ enabled: false, scope: 'team' });
    await api.call('set_store', { id: 'shop-api', startsFrom: 'checkout' });
    expect(patches[2]).toEqual({ startsFrom: 'checkout', scope: 'me' });
    await api.call('set_store', { id: 'shop-api', startsFrom: null });
    expect(patches[3]).toEqual({ startsFrom: null, scope: 'me' });
    await api.call('set_store', { id: 'shop-api', reset: 'data' });
    await api.call('set_store', { id: 'shop-api', resource: 'todos', reset: 'data' });
    await api.call('set_store', { id: 'shop-api', reset: 'settings' });
    expect(patches.slice(4)).toEqual([{ reset: 'data' }, { resource: 'todos', reset: 'data' }, { reset: 'settings' }]);
  });

  it.each<[string, Rec, string]>([
    ['nothing to do', {}, 'invalid'],
    ['two data changes', { resource: 'todos', items: [], remove: '1' }, 'invalid'],
    ['data and settings together', { resource: 'todos', items: [], remembers: true }, 'invalid'],
    ['a data change with a scope', { resource: 'todos', items: [], scope: 'team' }, 'invalid'],
    ['a data change without resource', { items: [] }, 'invalid'],
    ['remembers without resource', { remembers: true }, 'invalid'],
    ['reset with other changes', { resource: 'todos', reset: 'data', items: [] }, 'invalid'],
    ['reset settings for the team', { reset: 'settings', scope: 'team' }, 'invalid'],
    ['an unknown resource', { resource: 'orders', items: [] }, 'not_found'],
    ['an unknown snapshot', { startsFrom: 'nope' }, 'not_found'],
  ])('refuses %s', async (_name, input, code) => {
    const { api, patches } = setup();
    await expect(api.call('set_store', { id: 'shop-api', ...input })).rejects.toMatchObject({ code });
    expect(patches).toEqual([]);
  });

  it('host errors are tool errors', async () => {
    const { api } = setup();
    await expect(api.call('set_store', { id: 'nope', resource: 'todos', items: [] })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('store_snapshot', () => {
  it('save answers a workspace-relative path and the fields it blanked', async () => {
    const { api } = setup();
    const r = (await api.call('store_snapshot', { id: 'shop-api', action: 'save', name: 'empty-cart' })) as Rec;
    expect(r).toMatchObject({ path: '.vscode/flutter-intercept/snapshots/shop-api/empty-cart.json', resources: 2, records: 32, blanked: ['users.password', 'users.session'] });
    expect(JSON.stringify(r)).not.toContain('/ws/app');
    expect(await api.call('store_snapshot', { id: 'shop-api', action: 'load', name: 'empty-cart' })).toMatchObject({ action: 'load', records: 32 });
    expect(await api.call('store_snapshot', { id: 'shop-api', action: 'delete', name: 'empty-cart' })).toMatchObject({ action: 'delete' });
    await expect(api.call('store_snapshot', { id: 'shop-api', action: 'load', name: 'empty-cart' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('access and availability', () => {
  it('read-only access refuses set_store and store_snapshot, allows get_store', async () => {
    const { api, patches } = setup({ access: 'readOnly' });
    await expect(api.call('set_store', { id: 'shop-api', resource: 'todos', items: [] })).rejects.toMatchObject({ code: 'access' });
    await expect(api.call('store_snapshot', { id: 'shop-api', action: 'save', name: 'x' })).rejects.toMatchObject({ code: 'access' });
    expect(await api.call('get_store', { id: 'shop-api', resource: 'todos', limit: 1 })).toMatchObject({ total: 30 });
    expect(patches).toEqual([]);
  });

  it('a host without stateful mocks answers a clear state error', async () => {
    await expect(setup({ noStore: true }).api.call('get_store', { id: 'shop-api' })).rejects.toMatchObject({ code: 'state' });
  });
});

describe('exchange views carry collection.store (§22.10)', () => {
  const ex = (id: string, ruleId?: string) =>
    ({ id, method: 'POST', url: 'https://api.shop.example/todos', state: 'mocked', startedAt: 1, requestHeaders: {}, ...(ruleId ? { matchedRuleId: ruleId } : {}) }) as unknown as Exchange;

  it('list_requests / get_request / wait_for_request', async () => {
    const { api, host } = setup();
    host.exchanges = [ex('e1', 'collection:shop-api:3'), ex('e2', 'collection:shop-api:4'), ex('e3', 'collection:shop-api:5'), ex('e4')];
    const list = (await api.call('list_requests', {})) as { items: Rec[] };
    const by = (id: string) => list.items.find((r) => r.id === id)!;
    expect(by('e1').collection).toMatchObject({ id: 'shop-api', store: { resource: 'todos', op: 'create', itemId: '31' } });
    expect((by('e2').collection as Rec).store).toBeUndefined();
    expect(by('e3').collection).toMatchObject({ store: { resource: 'users', op: 'get', itemId: '[redacted]' } }); // a token-like id
    expect(by('e4').collection).toBeUndefined();
    expect(((await api.call('get_request', { id: 'e1' })) as Rec).collection).toMatchObject({ store: { op: 'create' } });
    const w = (await api.call('wait_for_request', { url: '*/todos', sinceMs: 0, timeoutMs: 1000 })) as Rec;
    expect(w.collection).toMatchObject({ store: { resource: 'todos' } });
  });
});

describe('LM texts, instructions', () => {
  it('confirmations say what changes and where it is kept', () => {
    const empty = confirmationText('set_store', { id: 'shop-api', resource: 'todos', items: [] }).message;
    expect(empty).toContain('**empty** `todos`');
    expect(empty).toContain('In memory only');
    expect(confirmationText('set_store', { id: 'shop-api', resource: 'todos', generate: { count: 500 } }).message).toContain('**500** generated records');
    expect(confirmationText('set_store', { id: 'shop-api', resource: 'todos', remembers: false }).message).toContain('For you only');
    expect(confirmationText('set_store', { id: 'shop-api', enabled: false, scope: 'team' }).message).toContain('shared with the team');
    const save = confirmationText('store_snapshot', { id: 'shop-api', action: 'save', name: 'empty-cart' });
    expect(save.message).toContain('`.vscode/flutter-intercept/snapshots/shop-api/empty-cart.json`');
    expect(save.message).toContain('blanked');
    expect(confirmationText('store_snapshot', { id: 'shop-api', action: 'delete', name: 'x' }).message).toContain('Delete the file');
    expect(invocationMessage('get_store', { id: 'shop-api', resource: 'todos' })).toBe('Reading the todos data of collection shop-api');
    expect(invocationMessage('store_snapshot', { id: 'shop-api', action: 'load', name: 'x' })).toBe('Loading snapshot x of collection shop-api');
  });

  it('the instructions mention the store in one line pair', () => {
    expect(AGENT_SECTION).toContain('`get_store`');
    expect(AGENT_SECTION).toContain('`set_store {items: []}`');
    expect(AGENT_SECTION).toContain("`reset: 'data'`");
  });
});
