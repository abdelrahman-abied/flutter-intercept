// CONTRACTS §22.4, §22.5, §22.14: the resource store (seed, CRUD semantics, limits, snapshots in and out).
import { describe, expect, it } from 'vitest';
import { detectResources } from '../../src/mocks/resources';
import { ResourceStore, type StoreRequest } from '../../src/mocks/store';
import { STORE_LIMITS, type MockEndpoint, type MockExample, type PathSegment, type StoreSnapshot } from '../../src/mocks/types';
import { shopOpenApi, shopPostman } from './mocks.shop';

const ORIGIN = 'https://api.test';
function ex(body: unknown, status = 200, extra: Partial<MockExample> = {}): MockExample {
  return {
    name: String(status),
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '99', 'x-api': 'v1' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...extra,
  };
}
function ep(method: string, p: string, examples: MockExample[] = [], extra: Partial<MockEndpoint> = {}): MockEndpoint {
  const segs: PathSegment[] = p
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? { param: s.slice(1) } : s));
  return { key: `${method} ${p}`, method, name: `${method} ${p}`, folder: [], origin: ORIGIN, path: segs, examples, unresolved: [], ...extra };
}
function storeOf(endpoints: MockEndpoint[]): ResourceStore {
  const { resources, problems } = detectResources(endpoints, {});
  expect(problems).toEqual([]);
  return new ResourceStore(resources, endpoints);
}
function call(s: ResourceStore, resource: string, op: StoreRequest['op'], opts: Partial<StoreRequest> & { json?: unknown } = {}) {
  const { json, ...rest } = opts;
  const req: StoreRequest = {
    resource,
    op,
    params: {},
    query: [],
    ...(json !== undefined ? { body: { text: JSON.stringify(json) }, contentType: 'application/json' } : {}),
    ...rest,
  };
  const a = s.handle(req);
  return { ...a, json: a.body ? (JSON.parse(a.body) as unknown) : undefined };
}

const users = [
  { id: 1, name: 'Sara', role: 'admin' },
  { id: 2, name: 'Omar', role: 'member' },
];
function usersApi(extra: { listBody?: unknown; listQuery?: string[]; deleteExample?: MockExample[] } = {}): MockEndpoint[] {
  return [
    ep('GET', '/users', [ex(extra.listBody ?? users)], { queryParams: extra.listQuery ?? [] }),
    ep('POST', '/users', [ex({ id: 99, name: 'x', createdAt: '2026-01-01T00:00:00Z', status: 'active' }, 201)]),
    ep('GET', '/users/:id', [ex({ id: 1, name: 'Sara', role: 'admin', email: 'sara@example.com' }), ex({ error: 'user_not_found' }, 404, { name: 'Not found' })]),
    ep('PUT', '/users/:id'),
    ep('PATCH', '/users/:id'),
    ep('DELETE', '/users/:id', extra.deleteExample ?? []),
  ];
}

describe('ResourceStore: CRUD (§22.5)', () => {
  it('seed, create → list shows it, get, patch, put, delete → 404', () => {
    const s = storeOf(usersApi());
    expect(s.changed).toBe(false);
    expect(s.counts()).toEqual({ users: 2 });

    let a = call(s, 'users', 'list');
    expect(a.status).toBe(200);
    expect(a.json).toEqual([{ id: 1, name: 'Sara', role: 'admin', email: 'sara@example.com' }, users[1]]);
    expect(a.headers['x-total-count']).toBe('2');
    expect(a.headers['content-length']).toBeUndefined();
    expect(a.headers['x-api']).toBe('v1');
    expect(a.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(a.note).toBe('users: listed 2 of 2');

    a = call(s, 'users', 'create', { json: { name: 'Lina', role: 'member' } });
    expect(a.status).toBe(201);
    expect(a.json).toEqual({ id: 3, name: 'Lina', createdAt: '2026-01-01T00:00:00Z', status: 'active', role: 'member' });
    expect(a.body.startsWith('{"id":3,')).toBe(true); // Dart int pitfall: an integer id stays a JSON number
    expect(a.note).toBe('users: created 3');
    expect(a.itemId).toBe('3');
    expect(a.headers.location).toBeUndefined();
    expect(s.changed).toBe(true);

    a = call(s, 'users', 'list');
    expect((a.json as { id: number }[]).map((u) => u.id)).toEqual([1, 2, 3]);
    expect(a.note).toBe('users: listed 3 of 3');

    a = call(s, 'users', 'get', { params: { id: '3' } });
    expect(a.status).toBe(200);
    expect(a.note).toBe('users: read 3');
    expect((a.json as { name: string }).name).toBe('Lina');

    a = call(s, 'users', 'patch', { params: { id: '3' }, json: { role: null, nick: 'L', id: 77 } });
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ id: 3, name: 'Lina', createdAt: '2026-01-01T00:00:00Z', status: 'active', role: null, nick: 'L' });
    expect(a.note).toBe('users: updated 3');

    a = call(s, 'users', 'replace', { params: { id: '3' }, json: { id: 'zzz', name: 'Lina B' } });
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ id: 3, name: 'Lina B' });

    a = call(s, 'users', 'delete', { params: { id: '3' } });
    expect(a.status).toBe(204);
    expect(a.body).toBe('');
    expect(a.headers['content-type']).toBeUndefined();
    expect(a.note).toBe('users: deleted 3');

    a = call(s, 'users', 'get', { params: { id: '3' } });
    expect(a.status).toBe(404);
    expect(a.json).toEqual({ error: 'user_not_found' }); // the item's written 404 example
    expect(a.note).toBe('users: 3 not found');

    // ids are never reused after delete
    a = call(s, 'users', 'create', { json: { name: 'Next' } });
    expect((a.json as { id: number }).id).toBe(4);
  });

  it('404 without a written example, PUT and PATCH never upsert, DELETE answers the example 2xx body', () => {
    const eps = usersApi({ deleteExample: [ex({ deleted: true }, 200)] }).map((e) => (e.key === 'GET /users/:id' ? { ...e, examples: [e.examples[0]] } : e));
    const s = storeOf(eps);
    let a = call(s, 'users', 'replace', { params: { id: '50' }, json: { name: 'x' } });
    expect(a.status).toBe(404);
    expect(a.json).toEqual({ error: 'not_found', message: 'users 50 not found' });
    expect(a.headers['content-type']).toBe('application/json');
    a = call(s, 'users', 'patch', { params: { id: '50' }, json: { name: 'x' } });
    expect(a.status).toBe(404);
    expect(s.counts().users).toBe(2);
    a = call(s, 'users', 'delete', { params: { id: '1' } });
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ deleted: true });
  });

  it('status codes come from the written 2xx example of the operation', () => {
    const eps = usersApi();
    eps[1] = { ...eps[1], examples: [ex({ ok: true }, 200)] };
    eps[3] = { ...eps[3], examples: [ex('', 204)] };
    const s = storeOf(eps);
    expect(call(s, 'users', 'create', { json: { name: 'a' } }).status).toBe(200);
    const put = call(s, 'users', 'replace', { params: { id: '1' }, json: { name: 'b' } });
    expect(put.status).toBe(204);
    expect(put.body).toBe('');
  });

  it('id kinds: uuid from a reproducible counter, string as <resource>-<n>; a client id is kept when free, else 409', () => {
    const u = storeOf([ep('GET', '/devices', [ex([{ id: '9b2e4c1a-1111-4000-8000-000000000001' }])]), ep('POST', '/devices'), ep('GET', '/devices/:id')]);
    expect((call(u, 'devices', 'create', { json: {} }).json as { id: string }).id).toBe('00000000-0000-4000-8000-000000000001');
    expect((call(u, 'devices', 'create', { json: {} }).json as { id: string }).id).toBe('00000000-0000-4000-8000-000000000002');

    const b = storeOf([ep('GET', '/books', [ex([{ id: 'books-1', title: 'A' }])]), ep('POST', '/books'), ep('GET', '/books/:id')]);
    expect((call(b, 'books', 'create', { json: { title: 'B' } }).json as { id: string }).id).toBe('books-2');
    let a = call(b, 'books', 'create', { json: { id: 'mine', title: 'C' } });
    expect(a.status).toBe(201);
    expect((a.json as { id: string }).id).toBe('mine');
    a = call(b, 'books', 'create', { json: { id: 'mine' } });
    expect(a.status).toBe(409);
    expect(a.json).toMatchObject({ error: 'conflict' });
    expect(a.note).toBe('books: mine already exists');
    a = call(b, 'books', 'create', { json: { id: { x: 1 } } });
    expect(a.status).toBe(400);

    const n = storeOf(usersApi());
    expect(call(n, 'users', 'create', { json: { id: 10 } }).status).toBe(201);
    expect((call(n, 'users', 'create', { json: {} }).json as { id: number }).id).toBe(11);
  });

  it('400 / 413 / 415, and a JSON body sent as text/plain (Dart http) is accepted', () => {
    const s = storeOf(usersApi());
    const req = (text: string, contentType?: string, op: StoreRequest['op'] = 'create', truncated?: true) =>
      call(s, 'users', op, { params: { id: '1' }, body: { text, ...(truncated ? { truncated } : {}) }, ...(contentType ? { contentType } : {}) });
    expect(req('[1,2]', 'application/json').status).toBe(400);
    expect(req('{"a":', 'application/json').status).toBe(400);
    expect(req('"text"').status).toBe(400);
    expect(req('{}', 'application/json', 'create', true).status).toBe(413);
    expect(req('a=1&b=2', 'application/x-www-form-urlencoded').status).toBe(415);
    expect(req('<a/>', 'application/xml').status).toBe(415);
    expect(req('[{"op":"replace","path":"/name","value":"x"}]', 'application/json-patch+json', 'patch').status).toBe(415);
    expect(req('', undefined, 'patch').status).toBe(400);
    const plain = req('{"name":"Plain"}', 'text/plain; charset=utf-8');
    expect(plain.status).toBe(201);
    expect(req('', undefined, 'create').status).toBe(201); // empty create body = {}
    for (const r of [req('[1]', 'application/json')]) {
      expect(r.headers['content-type']).toBe('application/json');
      expect(Object.keys(r.json as object)).toEqual(['error', 'message']);
      expect(r.note.startsWith('users: ')).toBe(true);
    }
    const unknown = s.handle({ resource: 'nope', op: 'list', params: {}, query: [] });
    expect(unknown.status).toBe(404);
    expect(unknown.note).toBe('nope: not a remembered resource');
  });

  it('writeOnly fields are never stored or answered (OpenAPI User.password)', () => {
    const endpoints = shopOpenApi();
    const s = new ResourceStore(detectResources(endpoints, {}).resources, endpoints);
    expect(call(s, 'users', 'list').json).toEqual([
      { id: 1, name: 'Sara' },
      { id: 2, name: 'Omar' },
    ]);
    const a = call(s, 'users', 'create', { json: { name: 'Lina', password: 'hunter2' } });
    expect(a.json).toEqual({ id: 3, name: 'Lina' });
    expect(JSON.stringify(s.dump())).not.toContain('hunter2');
  });

  it('the Postman shop seed: list example + item example merged; the ?page=2 example is ignored', () => {
    const endpoints = shopPostman();
    const s = new ResourceStore(detectResources(endpoints, {}).resources, endpoints);
    expect(call(s, 'users', 'list').json).toEqual([
      { id: 1, name: 'Sara' },
      { id: 2, name: 'Omar' },
      { id: 42, name: 'Lina' },
    ]);
    expect(call(s, 'users', 'get', { params: { id: '2' } }).status).toBe(200);
    expect(call(s, 'users', 'get', { params: { id: '7' } }).json).toEqual({ error: 'not_found' });
  });
});

describe('ResourceStore: lists (§22.5)', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `User ${String(i + 1).padStart(2, '0')}`, role: i % 3 === 0 ? 'admin' : 'member' }));

  it('a wrapper is rebuilt with its counters recomputed', () => {
    const s = storeOf(usersApi({ listBody: { data: users, total: 2, meta: { count: 2 } } }));
    call(s, 'users', 'create', { json: { name: 'Lina' } });
    const a = call(s, 'users', 'list');
    expect(a.json).toMatchObject({ total: 3, meta: { count: 3 } });
    expect((a.json as { data: unknown[] }).data).toHaveLength(3);
    expect(Object.keys(a.json as object)).toEqual(['data', 'total', 'meta']);
    expect(a.headers['x-total-count']).toBe('3');
  });

  it('paging only for parameters the list declares; unknown parameters are ignored', () => {
    const plain = storeOf(usersApi({ listBody: many }));
    let a = call(plain, 'users', 'list', { query: [['page', '2'], ['limit', '5'], ['lang', 'en']] });
    expect((a.json as unknown[]).length).toBe(30);
    expect(a.note).toBe('users: listed 30 of 30');

    const paged = storeOf(usersApi({ listBody: { items: many, total: 30, page: 1, per_page: 10, totalPages: 3 }, listQuery: ['page', 'per_page'] }));
    a = call(paged, 'users', 'list', { query: [['page', '2'], ['per_page', '5'], ['lang', 'en']] });
    const body = a.json as { items: { id: number }[]; total: number; page: number; per_page: number; totalPages: number };
    expect(body.items.map((u) => u.id)).toEqual([6, 7, 8, 9, 10]);
    expect(body).toMatchObject({ total: 30, page: 2, per_page: 5, totalPages: 6 });
    expect(a.note).toBe('users: listed 5 of 30');
    expect(a.headers['x-total-count']).toBe('30');
    // page without a size: 20 per page
    a = call(paged, 'users', 'list', { query: [['page', '2']] });
    expect((a.json as { items: unknown[] }).items).toHaveLength(10);

    const offset = storeOf(usersApi({ listBody: many, listQuery: ['offset', 'limit'] }));
    a = call(offset, 'users', 'list', { query: [['offset', '28'], ['limit', '5']] });
    expect((a.json as { id: number }[]).map((u) => u.id)).toEqual([29, 30]);
    const js = storeOf(usersApi({ listBody: many, listQuery: ['_page', '_limit'] }));
    a = call(js, 'users', 'list', { query: [['_page', '3'], ['_limit', '10']] });
    expect((a.json as { id: number }[])[0].id).toBe(21);
  });

  it('sorting when declared; filters only when every record has the field', () => {
    const s = storeOf(usersApi({ listBody: many, listQuery: ['sort', 'order'] }));
    let a = call(s, 'users', 'list', { query: [['sort', 'name'], ['order', 'desc']] });
    expect((a.json as { id: number }[])[0].id).toBe(30);
    a = call(s, 'users', 'list', { query: [['sort', '-id']] });
    expect((a.json as { id: number }[])[0].id).toBe(30);
    a = call(s, 'users', 'list', { query: [['role', 'admin']] });
    expect((a.json as unknown[]).length).toBe(10);
    a = call(s, 'users', 'list', { query: [['role', 'admin'], ['role', 'member']] });
    expect((a.json as unknown[]).length).toBe(30);
    a = call(s, 'users', 'list', { query: [['id', '7']] });
    expect(a.json).toEqual([many[6]]);
    // a field that one record lacks is not a filter
    call(s, 'users', 'create', { json: { name: 'No role' } });
    a = call(s, 'users', 'list', { query: [['role', 'admin']] });
    expect((a.json as unknown[]).length).toBe(31);
  });

  it('a list answer over 5 MB keeps the records that fit', () => {
    const s = storeOf(usersApi({ listBody: [] }));
    const big = 'x'.repeat(600 * 1024);
    for (let i = 0; i < 10; i++) expect(s.put('users', { name: big })).toEqual([]);
    const a = call(s, 'users', 'list');
    expect(a.headers['x-flutter-intercept']).toBe('truncated');
    expect((a.json as unknown[]).length).toBe(9); // the seed record + 8 big ones
    expect(a.note).toBe('users: listed 9 of 11');
    expect(Buffer.byteLength(a.body)).toBeLessThanOrEqual(STORE_LIMITS.answerBytes);
  });

  it('is fast: a list of 1 000 records answers in about a millisecond', () => {
    const s = storeOf(usersApi({ listBody: [] }));
    expect(s.generate('users', 1000)).toEqual([]);
    call(s, 'users', 'list');
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) call(s, 'users', 'list');
    expect((performance.now() - t0) / 20).toBeLessThan(5);
  });
});

describe('ResourceStore: nested resources (scopes)', () => {
  const api = (): MockEndpoint[] => [
    ep('GET', '/users/:userId/orders', [ex([{ id: 1, userId: 1, total: 10 }])]),
    ep('POST', '/users/:userId/orders'),
    ep('GET', '/users/:userId/orders/:orderId'),
    ep('DELETE', '/users/:userId/orders/:orderId'),
  ];

  it('each parent has its own list, seeded on first read; changes stay in their scope', () => {
    const s = storeOf(api());
    expect(s.counts()).toEqual({ 'users.orders': 0 });
    let a = call(s, 'users.orders', 'list', { params: { userId: '2' } });
    expect(a.json).toEqual([{ id: 1, userId: 2, total: 10 }]); // scope field filled, stays a number
    expect(s.changed).toBe(false);
    a = call(s, 'users.orders', 'create', { params: { userId: '2' }, json: { total: 5 } });
    expect(a.json).toEqual({ id: 2, total: 5 });
    a = call(s, 'users.orders', 'create', { params: { userId: '2' }, json: { total: 6, userId: 9 } });
    expect(a.json).toEqual({ id: 3, total: 6, userId: 2 });
    expect((call(s, 'users.orders', 'list', { params: { userId: '2' } }).json as unknown[]).length).toBe(3);
    expect((call(s, 'users.orders', 'list', { params: { userId: '1' } }).json as unknown[]).length).toBe(1);
    expect(call(s, 'users.orders', 'get', { params: { userId: '1', orderId: '3' } }).status).toBe(404);
    expect(call(s, 'users.orders', 'delete', { params: { userId: '2', orderId: '1' } }).status).toBe(204);
    expect(call(s, 'users.orders', 'get', { params: { userId: '1', orderId: '1' } }).status).toBe(200);
    expect(s.counts()).toEqual({ 'users.orders': 2 });
    expect(s.items('users.orders').items).toHaveLength(2);
    expect(s.items('users.orders', { scope: { userId: '5' } }).items).toEqual([{ id: 1, userId: 5, total: 10 }]);
  });

  it('put / remove without a scope act on the first scope holding the id; a new record needs its scope field (§22.14)', () => {
    const s = storeOf(api());
    call(s, 'users.orders', 'create', { params: { userId: '4' }, json: { total: 1 } });
    expect(s.put('users.orders', { id: 2, total: 99 })).toEqual([]);
    expect(s.items('users.orders', { scope: { userId: '4' } }).items).toContainEqual({ id: 2, total: 99 });
    expect(s.put('users.orders', { id: 50, total: 1 })).toEqual(['users.orders: set userId to say which parent it belongs to']);
    expect(s.put('users.orders', { id: 50, total: 1, userId: 8 })).toEqual([]);
    expect(s.items('users.orders', { scope: { userId: '8' } }).items).toContainEqual({ id: 50, total: 1, userId: 8 });
    expect(s.remove('users.orders', '50')).toBe(true);
    expect(s.remove('users.orders', '50')).toBe(false);
    expect(s.generate('users.orders', 2)).toEqual(['users.orders: pass the scope (userId) to add records']);
    expect(s.generate('users.orders', 2, { userId: '4' })).toEqual([]);
  });
});

describe('ResourceStore: limits and safety', () => {
  it('a create past the per-resource limit answers 507 store_full and evicts nothing', () => {
    const s = storeOf(usersApi());
    expect(s.generate('users', STORE_LIMITS.recordsPerResource - 2)).toEqual([]);
    expect(s.counts().users).toBe(STORE_LIMITS.recordsPerResource);
    const a = call(s, 'users', 'create', { json: { name: 'one more' } });
    expect(a.status).toBe(507);
    expect(a.json).toMatchObject({ error: 'store_full' });
    expect(a.note.startsWith('users: store full')).toBe(true);
    expect(s.counts().users).toBe(STORE_LIMITS.recordsPerResource);
    expect(s.problems.length).toBe(1);
    expect(s.generate('users', 1)[0]).toMatch(/^users: only 0 of 1 added/);
  });

  it('a record over 1 MB answers 507; a body nested deeper than 32 levels answers 400', () => {
    const s = storeOf(usersApi());
    expect(call(s, 'users', 'create', { json: { name: 'x'.repeat(STORE_LIMITS.recordBytes) } }).status).toBe(507);
    expect(call(s, 'users', 'patch', { params: { id: '1' }, json: { name: 'x'.repeat(STORE_LIMITS.recordBytes) } }).status).toBe(507);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(call(s, 'users', 'create', { json: deep }).status).toBe(400);
    expect(s.counts().users).toBe(2);
  });

  it('prototype pollution attempts are plain data at most', () => {
    const s = storeOf(usersApi());
    const text = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"name":"P"}';
    const a = call(s, 'users', 'create', { body: { text }, contentType: 'application/json' });
    expect(a.status).toBe(201);
    expect(a.body).not.toContain('__proto__');
    expect((a.json as Record<string, unknown>).constructor).toEqual({ prototype: { polluted: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    call(s, 'users', 'patch', { params: { id: '1' }, body: { text: '{"__proto__":{"admin":true}}' } });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(s.put('users', JSON.parse('{"__proto__":{"x":1},"name":"Q"}'))).toEqual([]);
    expect(call(s, 'users', 'list', { query: [['__proto__', 'x']] }).status).toBe(200);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('generate 5 000: copies of the first seed record with new ids and numbered names', () => {
    const s = storeOf([ep('GET', '/users'), ep('POST', '/users'), ep('GET', '/users/:id')]);
    const fresh = storeOf(usersApi());
    const t0 = performance.now();
    expect(fresh.generate('users', 4998)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2000);
    const items = fresh.items('users', { offset: 2, limit: 2 }).items as { id: number; name: string; role: string }[];
    expect(items).toEqual([
      { id: 3, name: 'Sara 3', role: 'admin', email: 'sara@example.com' },
      { id: 4, name: 'Sara 4', role: 'admin', email: 'sara@example.com' },
    ]);
    expect(fresh.generate('users', 5001)).toEqual(['users: count must be 1–5000']);
    // no seed at all: records with only an id
    expect(s.generate('users', 2)).toEqual([]);
    expect(s.items('users').items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('items: offset, limit and a case-insensitive filter over the record JSON', () => {
    const s = storeOf(usersApi());
    s.generate('users', 10);
    expect(s.items('users', { filter: 'OMAR' })).toEqual({ total: 1, items: [users[1]] });
    expect(s.items('users', { filter: 'sara 7' }).items).toHaveLength(1);
    const page = s.items('users', { offset: 10, limit: 5 });
    expect(page.total).toBe(12);
    expect(page.items).toHaveLength(2);
    expect(s.items('nope')).toEqual({ total: 0, items: [] });
  });

  it('replace, put, remove, reset and changed', () => {
    const s = storeOf(usersApi());
    expect(s.replace('users', [{ name: 'A' }, { id: 7, name: 'B' }, 'junk'])).toEqual(['users: item 3 was skipped (not a JSON object)']);
    expect(s.items('users').items).toEqual([{ id: 3, name: 'A' }, { id: 7, name: 'B' }]);
    expect(s.put('users', { id: 7, name: 'B2' })).toEqual([]);
    expect(s.items('users').items).toEqual([{ id: 3, name: 'A' }, { id: 7, name: 'B2' }]);
    expect(s.remove('users', '3')).toBe(true);
    expect(s.changed).toBe(true);
    s.reset('users');
    expect(s.changed).toBe(false);
    expect(s.counts()).toEqual({ users: 2 });
    expect((call(s, 'users', 'create', { json: {} }).json as { id: number }).id).toBe(3);
    expect(s.replace('users', [])).toEqual([]);
    expect(s.counts()).toEqual({ users: 0 });
    s.reset();
    expect(s.counts()).toEqual({ users: 2 });
  });
});

describe('ResourceStore: dump and load', () => {
  it('round trip: dump → load into a fresh store gives the same data and the same next id', () => {
    const s = storeOf(usersApi());
    call(s, 'users', 'create', { json: { name: 'Lina' } });
    call(s, 'users', 'delete', { params: { id: '3' } });
    const dump = s.dump();
    expect(dump).toMatchObject({ version: 1, next: { users: 4 } });
    expect(dump.resources.users).toEqual([{ records: [{ id: 1, name: 'Sara', role: 'admin', email: 'sara@example.com' }, users[1]] }]);

    const t = storeOf(usersApi());
    t.reset();
    expect(t.load(JSON.parse(JSON.stringify(dump)) as StoreSnapshot)).toEqual([]);
    expect(t.dump().resources).toEqual(dump.resources);
    expect((call(t, 'users', 'create', { json: {} }).json as { id: number }).id).toBe(4);
  });

  it('load as the start point: changed is false and reset comes back to it', () => {
    const s = storeOf(usersApi());
    const snap: StoreSnapshot = { version: 1, collection: 'shop', savedAt: '', resources: { users: [{ records: [{ id: 10, name: 'Z' }] }] } };
    expect(s.load(snap, { asStart: true })).toEqual([]);
    expect(s.changed).toBe(false);
    call(s, 'users', 'create', { json: {} });
    s.reset();
    expect(s.items('users').items).toEqual([{ id: 10, name: 'Z' }]);
  });

  it('unknown resources are reported, known ones applied; a broken snapshot changes nothing', () => {
    const s = storeOf([...usersApi(), ep('GET', '/tags', [ex([{ id: 't1' }])]), ep('GET', '/tags/:id')]);
    const before = JSON.stringify(s.dump().resources);
    const broken: unknown[] = [
      { version: 2, collection: 'x', savedAt: '', resources: {} },
      { version: 1, collection: 'x', savedAt: '', resources: { users: [{ records: [{ id: 1 }, { id: 1 }] }] } },
      { version: 1, collection: 'x', savedAt: '', resources: { users: [{ records: [{ name: 'no id' }] }] } },
      { version: 1, collection: 'x', savedAt: '', resources: { tags: [{ records: [] }], users: [{ scope: { userId: '1' }, records: [] }] } },
      { version: 1, collection: 'x', savedAt: '', resources: { users: [{ records: ['x'] }] } },
      { version: 1, collection: 'x', savedAt: '', resources: { tags: [{ records: [{ id: 'a' }] }], users: [{ records: Array.from({ length: 5001 }, (_, i) => ({ id: i })) }] } },
    ];
    for (const b of broken) {
      expect(s.load(b as StoreSnapshot).length).toBeGreaterThan(0);
      expect(JSON.stringify(s.dump().resources)).toBe(before);
    }
    const p = s.load({ version: 1, collection: 'x', savedAt: '', resources: { tags: [{ records: [{ id: 'new' }] }], ghosts: [{ records: [] }] } });
    expect(p).toEqual(['ghosts: not a resource of this collection (skipped)']);
    expect(s.counts()).toEqual({ users: 2, tags: 1 });
  });
});
