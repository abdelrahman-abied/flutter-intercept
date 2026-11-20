// CONTRACTS §22 (v0.16.0, H): stateful mocks in the collections host core — detection + store per link, handler
// rules (§22.6), the handler end to end through a real InterceptProxy, `stores` settings (§22.7), data patches,
// snapshots (§22.8) and the store's lifetime.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterceptProxy, type Exchange, type RequestHandler, type Rule } from '@flutter-intercept/proxy';
import { compileRules, findRule } from '@flutter-intercept/proxy/rules';
import { APPROVALS_KEY, MockCollectionsCore, STORES_OVERLAY_KEY } from '../../src/mocks/core';
import { collectionParsers } from '../../src/mocks/parsers';
import { InterceptProxyHost } from '../../src/proxyHost';
import { SharedRulesCore } from '../../src/rules/core';
import { nodeRulesFs } from '../../src/rules/service';
import { validateRule } from '../../src/ui/validate';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, ROOT } from './rules.fakes';
import { todoCollection } from './mocks.todo';

// service.ts imports vscode; only its node fs adapter is used here
vi.mock('vscode', () => ({}));

const COL = `${ROOT}/api/todo.postman_collection.json`;
const SNAPS = `${ROOT}/.vscode/flutter-intercept/snapshots/todo`;

let files: FakeFs;
let memento: FakeMemento;
let shared: SharedRulesCore;
let handlers: Map<string, RequestHandler>;
let changes: [string, string | undefined][];
let core: MockCollectionsCore;

function makeCore(opts: { handler?: boolean; fs?: typeof files | typeof nodeRulesFs; root?: string; sharedCore?: SharedRulesCore; setHandler?: (id: string, fn: RequestHandler | undefined) => void } = {}): MockCollectionsCore {
  const sc = opts.sharedCore ?? shared;
  return new MockCollectionsCore({
    links: () => sc.collectionLinks(),
    saveLinks: (folder, links) => sc.saveCollections(folder, links),
    primaryFolderPath: () => sc.primaryFolderPath(),
    writeWorkspaceFile: (folder, rel, text) => sc.writeWorkspaceFile(folder, rel, text),
    workspaceRoots: () => [opts.root ?? ROOT],
    fs: opts.fs ?? files,
    memento,
    parsers: collectionParsers,
    newRuleId: () => 'rule_new',
    ...(opts.handler === false ? {} : { setHandler: opts.setHandler ?? ((id: string, fn: RequestHandler | undefined) => void (fn ? handlers.set(id, fn) : handlers.delete(id))) }),
    saveStore: (folder, collection, entry) => sc.saveStore(folder, collection, entry),
    onStoreChange: (id, resource) => changes.push([id, resource]),
  });
}

function sharedFile(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, rules: [], collections: [{ id: 'todo', file: 'api/todo.postman_collection.json' }], ...extra }, null, 2);
}

async function setup(extra: Record<string, unknown> = {}, opts: { handler?: boolean } = {}): Promise<void> {
  files.put(FILE, sharedFile(extra));
  await shared.reload();
  core = makeCore(opts);
  await core.reload();
}

beforeEach(() => {
  files = new FakeFs();
  files.put(`${ROOT}/pubspec.yaml`, 'name: app');
  files.put(COL, todoCollection());
  memento = new FakeMemento();
  shared = new SharedRulesCore({ folders: () => [{ name: 'app', path: ROOT }], fs: files, validateRule: fakeValidateRule, memento });
  handlers = new Map();
  changes = [];
});

const ruleFor = (method: string, url: string): Rule | undefined => findRule(compileRules(core.rules()), method, url) as Rule | undefined;

/** Calls the registered handler the way the proxy would. */
function call(method: string, url: string, body?: unknown, exchangeId = `ex${Math.random()}`) {
  const rule = ruleFor(method, url);
  if (!rule || rule.action.kind !== 'handler') throw new Error(`no handler rule for ${method} ${url}`);
  const fn = handlers.get(rule.action.handlerId);
  if (!fn) throw new Error('no handler registered');
  const r = fn(
    { exchangeId, ruleId: rule.id, method, url, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: { text: JSON.stringify(body), encoding: 'utf8' as const } } : {}) },
    new AbortController().signal,
  ) as { status: number; headers: Record<string, string>; body: string; note: string } | undefined;
  return r;
}

describe('rules (§22.6)', () => {
  it('resource operations become handler rules in the same position, with the 0.15 answer as fallback', async () => {
    await setup();
    const rules = core.rules();
    const list = ruleFor('GET', 'http://api.todo.test/todos')!;
    expect(list.action).toMatchObject({ kind: 'handler', handlerId: 'collection:todo', fallback: { kind: 'mock', status: 200 } });
    expect(ruleFor('DELETE', 'http://api.todo.test/todos/1')!.action).toMatchObject({ kind: 'handler', fallback: { status: 204 } });
    // a non-resource endpoint stays static
    expect(ruleFor('POST', 'http://api.todo.test/auth/login')!.action.kind).toBe('mock');
    expect(core.describeRule(list.id)).toMatchObject({ id: 'todo', endpoint: 'GET {{baseUrl}}/todos', resource: 'todos', op: 'list' });
    // same ids and order as without a store
    const flat = makeCore({ handler: false });
    await flat.reload();
    expect(flat.rules().map((r) => r.id)).toEqual(rules.map((r) => r.id));
    expect(flat.rules().every((r) => r.action.kind === 'mock')).toBe(true);
    expect(flat.state()[0].store).toBeUndefined();
    expect(flat.storeStatus('todo')).toBeUndefined();
  });

  it('handler rules pass the proxy validation, and the host validator still refuses a handler rule from users', async () => {
    await setup();
    const h = ruleFor('GET', 'http://api.todo.test/todos')!;
    const p = new InterceptProxy({ port: 0 });
    p.setRules(core.rules());
    expect(p.refusedRules ?? []).toEqual([]);
    expect(() => validateRule(h)).toThrow(/stateful mock/);
  });

  it('a chosen example keeps the static rule; reset brings the store back', async () => {
    await setup();
    await core.update('todo', { example: { endpoint: 'GET {{baseUrl}}/todos/:id', name: 'Not found' } });
    expect(ruleFor('GET', 'http://api.todo.test/todos/1')!.action).toMatchObject({ kind: 'mock', status: 404 });
    expect(ruleFor('GET', 'http://api.todo.test/todos')!.action.kind).toBe('handler');
    await core.update('todo', { reset: true });
    expect(ruleFor('GET', 'http://api.todo.test/todos/1')!.action.kind).toBe('handler');
  });

  it('store off, resource off, link off → exactly the 0.15 rules for those', async () => {
    await setup();
    await core.updateStore('todo', { resource: 'todos', remembers: false });
    expect(ruleFor('GET', 'http://api.todo.test/todos')!.action.kind).toBe('mock');
    expect(core.storeStatus('todo')!.resources[0]).toMatchObject({ name: 'todos', remembers: false, overridden: true, path: '/todos/:id' });
    await core.updateStore('todo', { resource: 'todos', remembers: true });
    expect(ruleFor('GET', 'http://api.todo.test/todos')!.action.kind).toBe('handler');
    await core.updateStore('todo', { enabled: false });
    expect(core.rules().every((r) => r.action.kind !== 'handler')).toBe(true);
    expect(handlers.size).toBe(0);
    expect(core.storeStatus('todo')).toMatchObject({ enabled: false, resources: [{ name: 'todos', count: 0 }] });
  });

  it('query-example rules of a stateful list are not built (one problem line)', async () => {
    const doc = JSON.parse(todoCollection());
    doc.item[0].response.push({ name: 'Page 2', code: 200, header: [], body: '[]', originalRequest: { method: 'GET', url: { raw: '{{baseUrl}}/todos?page=2', host: ['{{baseUrl}}'], path: ['todos'], query: [{ key: 'page', value: '2' }] } } });
    files.put(COL, JSON.stringify(doc));
    await setup();
    expect(ruleFor('GET', 'http://api.todo.test/todos?page=2')!.action.kind).toBe('handler');
    expect(core.state()[0].problems.filter((p) => /query parameters aren't used while todos remembers/.test(p))).toHaveLength(1);
  });
});

describe('the handler (§22.9)', () => {
  it('POST then GET list shows the record; GET item, PATCH, DELETE → 404; notes; storeOpOf', async () => {
    await setup();
    const created = call('POST', 'http://api.todo.test/todos', { title: 'Tea' }, 'e1')!;
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ id: 3, title: 'Tea', createdAt: '2026-01-01' });
    expect(created.note).toBe('todos: created 3');
    expect(core.storeOpOf('e1')).toEqual({ resource: 'todos', op: 'create', itemId: '3' });
    const list = call('GET', 'http://api.todo.test/todos')!;
    expect(JSON.parse(list.body).map((t: { id: number }) => t.id)).toEqual([1, 2, 3]);
    expect(list.note).toBe('todos: listed 3 of 3');
    expect(call('GET', 'http://api.todo.test/todos/3')!.status).toBe(200);
    const patched = call('PATCH', 'http://api.todo.test/todos/3', { done: true })!;
    expect(JSON.parse(patched.body)).toMatchObject({ id: 3, done: true, title: 'Tea' });
    expect(call('DELETE', 'http://api.todo.test/todos/3')!.status).toBe(204);
    const gone = call('GET', 'http://api.todo.test/todos/3', undefined, 'e9')!;
    expect(gone.status).toBe(404);
    expect(core.storeOpOf('e9')).toMatchObject({ resource: 'todos', op: 'get' });
    expect(changes.filter(([id]) => id === 'todo').length).toBeGreaterThanOrEqual(3);
    expect(core.storeStatus('todo')).toMatchObject({ changed: true, resources: [{ name: 'todos', count: 2 }] });
    expect(core.state()[0].store).toMatchObject({ changed: true });
  });

  it('percent-decodes path params', async () => {
    await setup();
    call('POST', 'http://api.todo.test/todos', { id: 'a b', title: 'x' });
    expect(call('GET', 'http://api.todo.test/todos/a%20b')!.status).toBe(200);
  });

  it('end to end through a real InterceptProxy: the app sees the remembered data and the Stateful mock label', async () => {
    await setup();
    const host = new InterceptProxyHost({ getPort: () => 0, factory: (o) => new InterceptProxy(o) });
    const real = makeCore({ setHandler: (id, fn) => host.setHandler(id, fn) });
    await real.reload();
    host.setCollectionRules(real.rules());
    const port = await host.start();
    const seen: Exchange[] = [];
    host.on('exchange', (e: Exchange) => seen.push(e));
    const send = (method: string, p: string, body?: string) =>
      new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: `http://api.todo.test${p}`, headers: { host: 'api.todo.test', ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
        });
        req.on('error', reject);
        req.end(body);
      });
    try {
      expect((await send('POST', '/todos', '{"title":"Tea"}')).status).toBe(201);
      const list = await send('GET', '/todos');
      expect(JSON.parse(list.body)).toHaveLength(3);
      expect(list.headers['x-total-count']).toBe('3');
      await new Promise((r) => setTimeout(r, 50));
      const ex = host.getExchanges().find((e) => e.method === 'GET')!;
      expect(ex.simulated).toBe('Stateful mock');
      expect(ex.matchedRuleId).toMatch(/^collection:todo:\d+$/);
      expect(ex.notes ?? []).toContain('todos: listed 3 of 3');
      expect(real.storeOpOf(ex.id)).toEqual({ resource: 'todos', op: 'list' });
      // the proxy stops: the store is dropped (seed again)
      await host.stop();
      await real.dropStores();
      expect(real.storeStatus('todo')).toMatchObject({ changed: false, resources: [{ count: 2 }] });
      expect(real.storeOpOf(ex.id)).toBeUndefined();
    } finally {
      await host.stop();
    }
  });

  it('limited headers on store answers until the collection is approved', async () => {
    files.put(COL, todoCollection('http://api.todo.test', [{ key: 'Set-Cookie', value: 'sid=1' }]));
    await setup();
    const before = call('GET', 'http://api.todo.test/todos')!;
    expect(Object.keys(before.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    expect(before.headers['x-flutter-intercept']).toMatch(/limited; removed=set-cookie/);
    expect(core.state()[0].limited).toMatchObject({ reasons: ['sets cookies'] });
    await core.approve('todo');
    expect(memento.get(APPROVALS_KEY)).toBeTruthy();
    const after = call('GET', 'http://api.todo.test/todos')!;
    expect(Object.keys(after.headers).map((k) => k.toLowerCase())).toContain('set-cookie');
  });

  it('a handler of a dropped store answers undefined (the proxy answers the example)', async () => {
    await setup();
    const rule = ruleFor('GET', 'http://api.todo.test/todos')!;
    const fn = handlers.get('collection:todo')!;
    await core.updateStore('todo', { enabled: false });
    expect(fn({ exchangeId: 'x', ruleId: rule.id, method: 'GET', url: 'http://api.todo.test/todos', headers: {} }, new AbortController().signal)).toBeUndefined();
  });
});

describe('lifetime', () => {
  it('kept across selection, overlay and approval rebuilds; rebuilt on an id-field change; dropped on link off and removal', async () => {
    await setup();
    call('POST', 'http://api.todo.test/todos', { title: 'Tea' });
    await core.update('todo', { example: { endpoint: 'POST {{baseUrl}}/auth/login', name: 'OK' } });
    await core.update('todo', { unmatched: 'fail' });
    await core.approve('todo');
    await core.reload();
    expect(core.storeStatus('todo')!.resources[0].count).toBe(3);
    await core.updateStore('todo', { resource: 'todos', idField: 'title' });
    expect(core.storeStatus('todo')!.resources[0]).toMatchObject({ idField: 'title', count: 2, overridden: true });
    await core.updateStore('todo', { reset: 'settings' });
    call('POST', 'http://api.todo.test/todos', { title: 'Tea' });
    await core.update('todo', { enabled: false });
    await core.update('todo', { enabled: true });
    expect(core.storeStatus('todo')!.resources[0].count).toBe(2);
    await core.remove('todo');
    expect(handlers.size).toBe(0);
  });
});

describe('data patches', () => {
  it('put / remove / replace / generate / reset data change the data, never a file', async () => {
    await setup();
    const writes = files.writes.length;
    await core.updateStore('todo', { resource: 'todos', put: { item: { id: 9, title: 'New' } } });
    await core.updateStore('todo', { resource: 'todos', remove: { itemId: '1' } });
    expect(core.storeItems('todo', 'todos').items.map((r) => (r as { id: number }).id)).toEqual([2, 9]);
    await expect(core.updateStore('todo', { resource: 'todos', remove: { itemId: '77' } })).rejects.toThrow(/record 77 not found/);
    await core.updateStore('todo', { resource: 'todos', replace: [{ id: 5, title: 'a' }, 'nope'] });
    expect(core.storeItems('todo', 'todos').total).toBe(1);
    expect(core.storeStatus('todo')!.problems.join(' ')).toMatch(/item 2 was skipped/);
    await core.updateStore('todo', { resource: 'todos', generate: { count: 10 } });
    expect(core.storeItems('todo', 'todos').total).toBe(11);
    await expect(core.updateStore('todo', { resource: 'todos', generate: { count: 5001 } })).rejects.toThrow(/generate/);
    await core.updateStore('todo', { reset: 'data' });
    expect(core.storeStatus('todo')).toMatchObject({ changed: false, resources: [{ count: 2 }] });
    expect(files.writes.length).toBe(writes);
    expect(changes.length).toBeGreaterThanOrEqual(5);
  });

  it('refuses bad patches with readable errors', async () => {
    await setup();
    await expect(core.updateStore('todo', {} as never)).rejects.toThrow(/empty/);
    await expect(core.updateStore('todo', { bogus: 1 } as never)).rejects.toThrow(/unknown field "bogus"/);
    await expect(core.updateStore('todo', { remembers: true })).rejects.toThrow(/need resource/);
    await expect(core.updateStore('todo', { resource: 'nope', remembers: true })).rejects.toThrow(/no such resource "nope"/);
    await expect(core.updateStore('todo', { startsFrom: 'missing' })).rejects.toThrow(/no such snapshot "missing"/);
    await expect(core.updateStore('todo', { reset: 'data', enabled: true })).rejects.toThrow(/combined/);
    await expect(core.updateStore('todo', { resource: 'todos', put: { item: 1 }, remove: { itemId: '1' } })).rejects.toThrow(/one data change/);
    await expect(core.updateStore('nope', { reset: 'data' })).rejects.toThrow(/No collection "nope"/);
    expect(() => core.storeItems('todo', 'nope')).toThrow(/no such resource/);
  });
});

describe('settings (§22.7)', () => {
  it('reads the shared file: id field, off, enabled; unknown collections are kept and ignored', async () => {
    await setup({ stores: [{ collection: 'other', enabled: false }, { collection: 'todo', resources: { todos: { idField: 'title' } } }] });
    expect(core.storeStatus('todo')!.resources[0]).toMatchObject({ idField: 'title', detected: false });
    expect(core.fileProblems()).toEqual([]);
  });

  it('skips invalid entries with a problem line; at most 20 entries', async () => {
    const many = Array.from({ length: 22 }, (_, i) => ({ collection: `c${i}` }));
    await setup({ stores: [{ collection: 'BAD' }, { collection: 'todo', snapshot: '../x' }, ...many] });
    const p = core.fileProblems().join('\n');
    expect(p).toMatch(/"collection" must be the id/);
    expect(p).toMatch(/"snapshot" must be a snapshot name/);
    expect(p).toMatch(/at most 20 "stores" entries/);
  });

  it('personal by default (workspaceState), team writes the file and drops the overlay; unchanged re-send is a no-op', async () => {
    await setup({ stores: [{ collection: 'other', note: 'keep me' }] });
    await core.updateStore('todo', { resource: 'todos', remembers: false });
    expect(Object.values(memento.get<Record<string, unknown>>(STORES_OVERLAY_KEY)!)).toEqual([{ resources: { todos: { off: true } } }]);
    expect(JSON.parse(files.text(FILE)!).stores).toEqual([{ collection: 'other', note: 'keep me' }]);
    expect(core.storeStatus('todo')!.overridden).toBe(true);

    await core.updateStore('todo', { resource: 'todos', remembers: false, scope: 'team' });
    expect(JSON.parse(files.text(FILE)!).stores).toEqual([{ collection: 'other', note: 'keep me' }, { collection: 'todo', resources: { todos: { off: true } } }]);
    expect(memento.get<Record<string, unknown>>(STORES_OVERLAY_KEY)).toEqual({});
    expect(core.storeStatus('todo')!.overridden).toBeUndefined();

    // the same again: no write, no reload
    const writes = files.writes.length;
    const reload = vi.spyOn(core, 'reload');
    expect(await core.updateStore('todo', { resource: 'todos', remembers: false, scope: 'team' })).toBe(false);
    expect(await core.updateStore('todo', { enabled: true, scope: 'team' })).toBe(false);
    expect(await core.updateStore('todo', { enabled: true })).toBe(false); // equal to the team's: no override
    expect(await core.updateStore('todo', { resource: 'todos', remembers: false })).toBe(false);
    expect(files.writes.length).toBe(writes);
    expect(reload).not.toHaveBeenCalled();
    await core.updateStore('todo', { reset: 'settings' });
    expect(memento.get<Record<string, unknown>>(STORES_OVERLAY_KEY)).toEqual({});
    // no re-approval needed for store settings
    expect(core.state()[0].limited).toBeUndefined();
  });

  it('`stores` survives a 0.15-style save of the collections and of the rules, and the other way round', async () => {
    await setup({ stores: [{ collection: 'todo', enabled: false }], custom: 1 });
    await core.update('todo', { variable: { name: 'baseUrl', value: 'http://api.todo.test' } });
    expect(JSON.parse(files.text(FILE)!)).toMatchObject({ stores: [{ collection: 'todo', enabled: false }], custom: 1, collections: [{ id: 'todo' }] });
    await shared.save([]);
    expect(JSON.parse(files.text(FILE)!).stores).toEqual([{ collection: 'todo', enabled: false }]);
    await shared.saveStore(ROOT, 'todo', undefined);
    const after = JSON.parse(files.text(FILE)!);
    expect(after.stores).toBeUndefined();
    expect(after.collections).toEqual([{ id: 'todo', file: 'api/todo.postman_collection.json', variables: { baseUrl: 'http://api.todo.test' } }]);
  });
});

describe('snapshots (§22.8)', () => {
  it('save (redacted, listed), load, delete; startsFrom seeds from it, a broken one falls back to the seed', async () => {
    await setup();
    await core.updateStore('todo', { resource: 'todos', put: { item: { id: 7, title: 'Secret', apiKey: 'live-123', token: 'eyJhbGciOi.eyJzdWIiOiIx.c2ln' } } });
    const saved = await core.storeSnapshot('todo', 'save', 'checkout');
    expect(saved).toMatchObject({ path: '.vscode/flutter-intercept/snapshots/todo/checkout.json', resources: 1, records: 3 });
    expect(saved.blanked).toEqual(expect.arrayContaining(['todos.apiKey']));
    const text = files.text(`${SNAPS}/checkout.json`)!;
    expect(text).not.toContain('live-123');
    expect(JSON.parse(text)).toMatchObject({ version: 1, collection: 'todo' });
    expect(core.storeStatus('todo')!.snapshots).toEqual(['checkout']);

    await core.updateStore('todo', { reset: 'data' });
    expect(core.storeItems('todo', 'todos').total).toBe(2);
    expect(await core.storeSnapshot('todo', 'load', 'checkout')).toMatchObject({ resources: 1, records: 3 });
    expect(core.storeItems('todo', 'todos').total).toBe(3);

    await core.updateStore('todo', { startsFrom: 'checkout' });
    expect(core.storeStatus('todo')).toMatchObject({ startsFrom: 'checkout', changed: false, resources: [{ count: 3 }] });
    files.put(`${SNAPS}/checkout.json`, '{broken');
    await core.updateStore('todo', { resource: 'todos', idField: 'id' }); // rebuilds the store
    expect(core.storeStatus('todo')!.resources[0].count).toBe(2);
    expect(core.storeStatus('todo')!.problems.join(' ')).toMatch(/Snapshot "checkout" can't be used.*starts from the collection's examples/);

    await core.storeSnapshot('todo', 'delete', 'checkout');
    expect(files.text(`${SNAPS}/checkout.json`)).toBeUndefined();
    expect(core.storeStatus('todo')!.snapshots).toEqual([]);
    await expect(core.storeSnapshot('todo', 'delete', 'checkout')).rejects.toThrow(/no such snapshot "checkout"/);
    await expect(core.storeSnapshot('todo', 'save', '../x')).rejects.toThrow(/snapshot name/);
    await expect(core.storeSnapshot('todo', 'load', 'BUILD')).rejects.toThrow(/snapshot name/);
  });

  it('at most 50 snapshots per collection', async () => {
    await setup();
    for (let i = 0; i < 50; i++) files.put(`${SNAPS}/s${i}.json`, '{}');
    await core.reload();
    await expect(core.storeSnapshot('todo', 'save', 'one-more')).rejects.toThrow(/At most 50/);
    await core.storeSnapshot('todo', 'save', 's1'); // replacing one is fine
  });
});

describe('snapshot paths on a real file system', () => {
  let tmp: string;
  let ws: string;
  let outside: string;
  let realCore: MockCollectionsCore;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-snap-')));
    ws = path.join(tmp, 'app');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(ws, 'api'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(ws, 'api', 'todo.postman_collection.json'), todoCollection());
    fs.mkdirSync(path.join(ws, '.vscode'));
    fs.writeFileSync(path.join(ws, '.vscode', 'flutter-intercept.json'), sharedFile());
    const sc = new SharedRulesCore({ folders: () => [{ name: 'app', path: ws }], fs: nodeRulesFs, validateRule: fakeValidateRule, memento });
    await sc.reload();
    realCore = makeCore({ fs: nodeRulesFs, root: ws, sharedCore: sc });
    await realCore.reload();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes and reads plain files', async () => {
    await realCore.storeSnapshot('todo', 'save', 'plain');
    expect(fs.existsSync(path.join(ws, '.vscode/flutter-intercept/snapshots/todo/plain.json'))).toBe(true);
    expect(await realCore.storeSnapshot('todo', 'load', 'plain')).toMatchObject({ records: 2 });
  });

  it('refuses a snapshots folder that is a symbolic link out of the project', async () => {
    fs.mkdirSync(path.join(ws, '.vscode/flutter-intercept/snapshots'), { recursive: true });
    fs.symlinkSync(outside, path.join(ws, '.vscode/flutter-intercept/snapshots/todo'));
    await expect(realCore.storeSnapshot('todo', 'save', 'x')).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a snapshot file that is a symbolic link (load and delete)', async () => {
    const dir = path.join(ws, '.vscode/flutter-intercept/snapshots/todo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.json'), '{"version":1}');
    fs.symlinkSync(path.join(outside, 'secret.json'), path.join(dir, 'evil.json'));
    await expect(realCore.storeSnapshot('todo', 'load', 'evil')).rejects.toThrow(/symbolic link/);
    await expect(realCore.storeSnapshot('todo', 'delete', 'evil')).rejects.toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(outside, 'secret.json'))).toBe(true);
  });
});
