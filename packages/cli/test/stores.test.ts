// CONTRACTS §22.6, §22.8, §22.11: stateful mocks in a headless run — handler rules from a collection, the store
// handler (POST then GET), starting snapshots (by name, by file, from the shared file), --no-collection-store, summary.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HandlerRequest, HandlerResponse, Rule } from '@flutter-intercept/proxy';
import { loadCollections, type LoadedCollections } from '../src/collections';
import { loadRules } from '../src/rules';
import { pathParams, storeSummary } from '../src/stores';

const TODO = path.join(__dirname, 'fixtures', 'todo.openapi.json');
const SHOP_FIXTURES = path.resolve(__dirname, '..', '..', 'extension', 'test', 'fixtures', 'collections');

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-cli-store-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(rel: string, data: unknown): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

/** Finds the collection rule a request matches (first match, as the proxy does for these exact patterns). */
function ruleFor(rules: Rule[], method: string, url: string): Rule {
  const r = rules.find((x) => {
    const m = x.match;
    if (m.method && m.method !== method) return false;
    const src = typeof m.url === 'string' ? m.url : '';
    const re = /^\/(.*)\/([a-z]*)$/s.exec(src);
    return re ? new RegExp(re[1], re[2]).test(url) : false;
  });
  if (!r) throw new Error(`no rule for ${method} ${url}`);
  return r;
}

async function call(loaded: LoadedCollections, method: string, url: string, json?: unknown): Promise<{ status: number; body: unknown; note?: string }> {
  const rule = ruleFor(loaded.rules, method, url);
  if (rule.action.kind !== 'handler') throw new Error(`${method} ${url} is answered by a ${rule.action.kind} rule`);
  const store = loaded.stores.find((s) => s.handlerId === (rule.action as { handlerId: string }).handlerId)!;
  const req: HandlerRequest = {
    exchangeId: 'x',
    ruleId: rule.id,
    method,
    url,
    headers: json !== undefined ? { 'content-type': 'application/json' } : {},
    ...(json !== undefined ? { body: { text: JSON.stringify(json), encoding: 'utf8' as const } } : {}),
  };
  const a = (await store.handler(req, new AbortController().signal)) as HandlerResponse;
  return { status: a.status, body: a.body ? (JSON.parse(a.body) as unknown) : undefined, note: a.note };
}

describe('stateful collection rules (CONTRACTS §22.6)', () => {
  it('resource operations become handler rules with the 0.15 mock as fallback; other endpoints stay static', async () => {
    const loaded = await loadCollections({ files: [TODO], cwd: dir, store: { folder: dir } });
    expect(loaded.stores.map((s) => [s.id, s.handlerId, s.resources.map((r) => r.name)])).toEqual([['todo-api', 'collection:todo-api', ['todos']]]);
    const list = ruleFor(loaded.rules, 'GET', 'https://api.todo.example/todos');
    expect(list.action).toMatchObject({ kind: 'handler', handlerId: 'collection:todo-api', fallback: { kind: 'mock', status: 200 } });
    expect(ruleFor(loaded.rules, 'GET', 'https://api.todo.example/health').action.kind).toBe('mock');

    // --no-collection-store (no `store` option): exactly the 0.15 rules
    const plain = await loadCollections({ files: [TODO], cwd: dir });
    expect(plain.stores).toEqual([]);
    expect(plain.rules.every((r) => r.action.kind === 'mock')).toBe(true);
    expect(plain.rules.length).toBe(loaded.rules.length);
  });

  it('POST then GET: the created record is listed and readable; DELETE removes it', async () => {
    const loaded = await loadCollections({ files: [TODO], cwd: dir, store: { folder: dir } });
    const created = await call(loaded, 'POST', 'https://api.todo.example/todos', { title: 'Walk the dog' });
    expect(created).toMatchObject({ status: 201, body: { id: 2, title: 'Walk the dog', done: false }, note: 'todos: created 2' });
    expect((await call(loaded, 'GET', 'https://api.todo.example/todos')).body).toEqual([
      { id: 1, title: 'Buy milk', done: false },
      { id: 2, title: 'Walk the dog', done: false },
    ]);
    expect(await call(loaded, 'GET', 'https://api.todo.example/todos/2')).toMatchObject({ status: 200, body: { id: 2 } });
    expect((await call(loaded, 'DELETE', 'https://api.todo.example/todos/1')).status).toBe(204);
    expect((await call(loaded, 'GET', 'https://api.todo.example/todos/1')).status).toBe(404);
    expect(storeSummary(loaded.stores)).toEqual(['store todos: 1 record (1 created, 1 deleted)']);
  });

  it('a URL that does not line up with the endpoint answers the fallback (undefined)', async () => {
    const loaded = await loadCollections({ files: [TODO], cwd: dir, store: { folder: dir } });
    const s = loaded.stores[0];
    const rule = ruleFor(loaded.rules, 'GET', 'https://api.todo.example/todos');
    expect(await s.handler({ exchangeId: 'x', ruleId: 'nope', method: 'GET', url: 'https://api.todo.example/todos', headers: {} }, new AbortController().signal)).toBeUndefined();
    expect(await s.handler({ exchangeId: 'x', ruleId: rule.id, method: 'GET', url: 'https://api.todo.example/a/b/c', headers: {} }, new AbortController().signal)).toBeUndefined();
  });

  it('pathParams decodes params and refuses paths of another length', () => {
    expect(pathParams(['users', { param: 'id' }], 'https://x.test/users/a%20b/?q=1')).toEqual({ id: 'a b' });
    expect(pathParams(['users', { param: 'id' }], 'https://x.test/users/%E0%A4%A')).toEqual({ id: '%E0%A4%A' });
    expect(pathParams(['users', { param: 'id' }], 'https://x.test/users')).toBeUndefined();
    expect(pathParams(['users'], 'not a url')).toBeUndefined();
  });

  it('the shop collection keeps a chosen example static and still answers GET /users/42 from the seed', async () => {
    fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
    fs.copyFileSync(path.join(SHOP_FIXTURES, 'shop.postman_collection.json'), path.join(dir, 'api', 'shop.postman_collection.json'));
    fs.copyFileSync(path.join(SHOP_FIXTURES, 'shop.postman_environment.json'), path.join(dir, 'api', 'shop.postman_environment.json'));
    write('.vscode/flutter-intercept.json', {
      version: 1,
      collections: [{ id: 'shop-api', file: 'api/shop.postman_collection.json', environment: 'api/shop.postman_environment.json' }],
    });
    const rules = await loadRules({ approve: false, projectRoot: dir, cwd: dir });
    const loaded = await loadCollections({ sharedLinks: rules.collectionLinks, cwd: dir, store: { folder: dir } });
    expect(loaded.stores.map((s) => s.id)).toEqual(['shop-api']);
    expect(await call(loaded, 'GET', 'https://api.shop.example/users/42')).toMatchObject({ status: 200, body: { id: 42, name: 'Lina' } });
  });
});

describe('starting snapshots (CONTRACTS §22.7, §22.8, §22.11)', () => {
  const snapshot = (collection: string, records: unknown[]) => ({ version: 1, collection, savedAt: '2026-11-20T00:00:00Z', resources: { todos: [{ records }] } });

  it('--collection-snapshot <name> loads .vscode/flutter-intercept/snapshots/<id>/<name>.json', async () => {
    write('.vscode/flutter-intercept/snapshots/todo-api/checkout.json', snapshot('todo-api', [{ id: 7, title: 'From the snapshot', done: true }]));
    const loaded = await loadCollections({ files: [TODO], cwd: dir, store: { folder: dir, snapshot: 'checkout' } });
    expect(loaded.stores[0].startsFrom).toBe('.vscode/flutter-intercept/snapshots/todo-api/checkout.json');
    expect((await call(loaded, 'GET', 'https://api.todo.example/todos')).body).toEqual([{ id: 7, title: 'From the snapshot', done: true }]);
    // ids continue after the snapshot's
    expect((await call(loaded, 'POST', 'https://api.todo.example/todos', { title: 'n' })).body).toMatchObject({ id: 8 });
  });

  it('a missing name, a broken file or a snapshot for another collection is a setup error', async () => {
    await expect(loadCollections({ files: [TODO], cwd: dir, store: { folder: dir, snapshot: 'nothing' } })).rejects.toThrow(/snapshot "nothing" not found/);
    write('.vscode/flutter-intercept/snapshots/todo-api/broken.json', '{"version": 2}');
    await expect(loadCollections({ files: [TODO], cwd: dir, store: { folder: dir, snapshot: 'broken' } })).rejects.toThrow(/broken\.json/);
    write('dup.json', snapshot('todo-api', [{ id: 1 }, { id: 1 }]));
    await expect(loadCollections({ files: [TODO], cwd: dir, store: { folder: dir, snapshot: 'dup.json' } })).rejects.toThrow(/listed twice/);
    // no collection remembers data
    await expect(loadCollections({ files: [], cwd: dir, store: { folder: dir, snapshot: 'x' } })).rejects.toThrow(/no collection in this run/);
  });

  it('--collection-snapshot <file> loads a file anywhere; unknown resources are reported, not fatal', async () => {
    const file = write('ci/scenario.json', { ...snapshot('todo-api', [{ id: 3, title: 'CI', done: false }]), resources: { todos: [{ records: [{ id: 3, title: 'CI', done: false }] }], ghosts: [{ records: [] }] } });
    const loaded = await loadCollections({ files: [TODO], cwd: dir, store: { folder: dir, snapshot: path.relative(dir, file) } });
    expect(loaded.stores[0].startsFrom).toBe('ci/scenario.json');
    expect(loaded.problems.some((p) => p.includes('ghosts'))).toBe(true);
    expect((await call(loaded, 'GET', 'https://api.todo.example/todos')).body).toEqual([{ id: 3, title: 'CI', done: false }]);
  });

  it('the shared file: stores[].snapshot starts the data, enabled: false keeps 0.15 rules, resources[].off turns one off', async () => {
    fs.copyFileSync(TODO, path.join(dir, 'todo.openapi.json'));
    write('.vscode/flutter-intercept/snapshots/todo/seeded.json', snapshot('todo', [{ id: 5, title: 'Shared', done: false }]));
    const shared = (stores: unknown[]) =>
      write('.vscode/flutter-intercept.json', { version: 1, collections: [{ id: 'todo', file: 'todo.openapi.json' }], stores });
    const load = async () => loadCollections({ sharedLinks: (await loadRules({ approve: false, projectRoot: dir, cwd: dir })).collectionLinks, cwd: dir, store: { folder: dir } });

    shared([{ collection: 'todo', snapshot: 'seeded' }]);
    const seeded = await load();
    expect((await call(seeded, 'GET', 'https://api.todo.example/todos')).body).toEqual([{ id: 5, title: 'Shared', done: false }]);

    shared([{ collection: 'todo', snapshot: 'missing' }]);
    const missing = await load();
    expect(missing.problems.some((p) => /snapshot "missing".*not found.*starts from its examples/.test(p))).toBe(true);
    expect((await call(missing, 'GET', 'https://api.todo.example/todos')).body).toEqual([{ id: 1, title: 'Buy milk', done: false }]);

    shared([{ collection: 'todo', enabled: false }]);
    const off = await load();
    expect(off.stores).toEqual([]);
    expect(off.rules.every((r) => r.action.kind === 'mock')).toBe(true);

    shared([{ collection: 'todo', resources: { todos: { off: true } } }]);
    expect((await load()).stores).toEqual([]);
  });
});
