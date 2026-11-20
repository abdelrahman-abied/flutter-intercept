// CONTRACTS §22.2, §22.3: finding the REST resources of a collection.
import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../src/mocks/openapi';
import { cleanJson, detectResources, seedRecords, singular } from '../../src/mocks/resources';
import type { MockEndpoint, MockExample, PathSegment } from '../../src/mocks/types';
import { shopOpenApi, shopPostman } from './mocks.shop';

const ORIGIN = 'https://api.test';
function ex(body: unknown, status = 200, extra: Partial<MockExample> = {}): MockExample {
  return { name: String(status), status, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra };
}
function ep(method: string, p: string, examples: MockExample[] = [], extra: Partial<MockEndpoint> = {}): MockEndpoint {
  const segs: PathSegment[] = p
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? { param: s.slice(1) } : s));
  return { key: `${method} ${p}`, method, name: `${method} ${p}`, folder: [], origin: ORIGIN, path: segs, examples, unresolved: [], ...extra };
}

describe('detectResources on the shop fixtures', () => {
  it('Postman: users remembers with id; /users/me, auth and the order items stay static', () => {
    const { resources, problems } = detectResources(shopPostman(), {});
    expect(problems).toEqual([]);
    expect(resources).toHaveLength(1);
    const users = resources[0];
    expect(users).toMatchObject({
      name: 'users',
      origin: 'https://api.shop.example',
      listPath: ['users'],
      itemParam: 'id',
      scopeParams: [],
      idField: 'id',
      idKind: 'integer',
      ops: { list: 'GET {{baseUrl}}/users', get: 'GET {{baseUrl}}/users/:id', delete: 'DELETE {{baseUrl}}/users/:id' },
      list: {},
      writeOnly: [],
      detected: true,
    });
    expect(users.ops.create).toBeUndefined();
    expect(users.generatedSeed).toBeUndefined();
  });

  it('Postman seed: the list example, item examples merged by id, the ?page=2 example is not a seed', () => {
    const endpoints = shopPostman();
    const users = detectResources(endpoints, {}).resources[0];
    const seed = seedRecords(users, new Map(endpoints.map((e) => [e.key, e])));
    expect(seed.generated).toBe(false);
    expect(seed.records.map((r) => r.id)).toEqual([1, 2, 42]);
  });

  it('OpenAPI: users with schema hints (integer id, password writeOnly); create-only POST /orders on another origin stays static', () => {
    const endpoints = shopOpenApi();
    expect(endpoints.find((e) => e.key === 'GET /users/{id}')?.schemaHints).toEqual({ idField: 'id', idType: 'integer', writeOnly: ['password'] });
    const { resources, problems } = detectResources(endpoints, {});
    expect(problems).toEqual([]);
    expect(resources.map((r) => r.name)).toEqual(['users']);
    expect(resources[0]).toMatchObject({
      listPath: ['v1', 'users'],
      idField: 'id',
      idKind: 'integer',
      writeOnly: ['password'],
      ops: { list: 'GET /users', get: 'GET /users/{id}', delete: 'DELETE /users/{id}' },
    });
  });

  it('OpenAPI with no written examples seeds from generated bodies (generatedSeed)', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Gen' },
      servers: [{ url: 'https://gen.test' }],
      paths: {
        '/pets': {
          get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } } } },
          post: { responses: { '201': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
        },
        '/pets/{petId}': {
          get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
        },
      },
      components: {
        schemas: {
          Pet: {
            allOf: [
              { type: 'object', properties: { petId: { type: 'string', format: 'uuid', readOnly: true } } },
              { type: 'object', properties: { name: { type: 'string' }, secret: { type: 'string', writeOnly: true } } },
            ],
          },
        },
      },
    };
    const endpoints = parseOpenApi(doc, { values: new Map(), sources: new Map() }).endpoints;
    expect(endpoints[0].schemaHints).toEqual({ idField: 'petId', idType: 'string', idFormat: 'uuid', writeOnly: ['secret'] });
    const { resources } = detectResources(endpoints, {});
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ name: 'pets', idField: 'petId', idKind: 'uuid', writeOnly: ['secret'], generatedSeed: true });
  });

  it('OpenAPI queryParams come from path and operation parameters (in: query)', () => {
    const doc = {
      openapi: '3.1.0',
      info: { title: 'Q' },
      servers: [{ url: 'https://q.test' }],
      components: { parameters: { Page: { name: 'page', in: 'query', schema: { type: 'integer' } } } },
      paths: {
        '/items': {
          parameters: [{ $ref: '#/components/parameters/Page' }, { name: 'X-Trace', in: 'header' }],
          get: { parameters: [{ name: 'limit', in: 'query' }, { name: 'page', in: 'query' }], responses: { '200': { description: 'ok' } } },
        },
      },
    };
    const endpoints = parseOpenApi(doc, { values: new Map(), sources: new Map() }).endpoints;
    expect(endpoints[0].queryParams).toEqual(['page', 'limit']);
  });
});

describe('detectResources rules (§22.3)', () => {
  const list = [{ id: 1, name: 'A' }];

  it('pairs need an item op and a list op; actions and item-only paths stay static', () => {
    const { resources } = detectResources(
      [
        ep('GET', '/reports/:year', [ex({ year: 2026 })]),
        ep('POST', '/auth/login', [ex({ token: 't' })]),
        ep('POST', '/orders', [ex({ id: 1 }, 201)]),
        ep('GET', '/things', [ex(list)]),
        ep('DELETE', '/things/:id'),
      ],
      {},
    );
    expect(resources.map((r) => r.name)).toEqual(['things']);
    expect(resources[0].ops).toEqual({ list: 'GET /things', delete: 'DELETE /things/:id' });
  });

  it('nested resources get scope params and a dotted name; endpoints without an origin are ignored', () => {
    const { resources } = detectResources(
      [
        ep('GET', '/users/:userId/orders', [ex([{ id: 5, userId: 1 }])]),
        ep('GET', '/users/:userId/orders/:orderId', [ex({ id: 5, userId: 1 })]),
        ep('GET', '/carts', [ex([{ id: 1 }])], { origin: undefined, unresolved: ['baseUrl'] }),
        ep('GET', '/carts/:id', [], { origin: undefined, unresolved: ['baseUrl'] }),
      ],
      {},
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      name: 'users.orders',
      listPath: ['users', { param: 'userId' }, 'orders'],
      itemParam: 'orderId',
      scopeParams: ['userId'],
      idField: 'id',
    });
  });

  it('id field order: item param key, id, <singular>Id, <singular>_id, _id, uuid; none → static with one line', () => {
    const pick = (record: Record<string, unknown>, p = '/books/:id') => {
      const r = detectResources([ep('GET', '/books', [ex([record])]), ep('GET', p, [ex(record)])], {});
      return { field: r.resources[0]?.idField, problems: r.problems };
    };
    expect(pick({ isbn: 'x', id: 1 }, '/books/:isbn').field).toBe('isbn');
    expect(pick({ bookId: 3, id: 1 }).field).toBe('id');
    expect(pick({ bookId: 3, _id: 'a' }).field).toBe('bookId');
    expect(pick({ book_id: 3 }).field).toBe('book_id');
    expect(pick({ _id: 'a', uuid: 'b' }).field).toBe('_id');
    expect(pick({ uuid: 'b' }).field).toBe('uuid');
    const none = pick({ sku: 'A1', qty: 2 });
    expect(none.field).toBeUndefined();
    expect(none.problems).toEqual(['books: set its id field to make it remember']);
  });

  it('an override fixes the id field (detected: override) or turns the resource off', () => {
    const eps = [ep('GET', '/items', [ex([{ sku: 'A1', qty: 2 }])]), ep('GET', '/items/:sku', [ex({ sku: 'A1', qty: 2 })])];
    expect(detectResources(eps, {}).resources[0].idField).toBe('sku');
    const eps2 = [ep('GET', '/items', [ex([{ code: 'A1' }])]), ep('GET', '/items/:x', [ex({ code: 'A1' })])];
    expect(detectResources(eps2, {}).resources).toEqual([]);
    const fixed = detectResources(eps2, { items: { idField: 'code' } });
    expect(fixed.problems).toEqual([]);
    expect(fixed.resources[0]).toMatchObject({ idField: 'code', idKind: 'string', detected: 'override' });
    expect(detectResources(eps, { items: { off: true } }).resources).toEqual([]);
  });

  it('id kind from the seeded ids: integers, UUIDs, other strings; integer when nothing is known', () => {
    const kind = (ids: unknown[]) =>
      detectResources([ep('GET', '/a', [ex(ids.map((id) => ({ id })))]), ep('GET', '/a/:id')], {}).resources[0].idKind;
    expect(kind([1, 2])).toBe('integer');
    expect(kind(['9b2e4c1a-0000-4000-8000-000000000001'])).toBe('uuid');
    expect(kind(['a1', 'b2'])).toBe('string');
    expect(kind([1, 'b'])).toBe('string');
    expect(kind([])).toBe('integer');
    expect(detectResources([ep('POST', '/a'), ep('GET', '/a/:id')], {}).resources[0]).toMatchObject({ idField: 'id', idKind: 'integer' });
  });

  it('list shapes: bare array, wrappers up to 3 levels with totals, anything else static', () => {
    const shape = (body: unknown) => detectResources([ep('GET', '/u', [ex(body)]), ep('GET', '/u/:id')], {});
    expect(shape([{ id: 1 }]).resources[0].list).toEqual({});
    const w = shape({ data: [{ id: 1 }], total: 1, page: 1 }).resources[0].list.wrapper;
    expect(w?.path).toEqual(['data']);
    expect(w?.totals).toEqual(['/total']);
    expect(JSON.parse(JSON.stringify(w?.template))).toEqual({ data: [], total: 1, page: 1 });
    const deep = shape({ data: { items: [{ id: 1 }], meta: {} }, meta: { totalCount: 1 } }).resources[0].list.wrapper;
    expect(deep?.path).toEqual(['data', 'items']);
    expect(deep?.totals).toEqual(['/meta/totalCount']);
    expect(shape({ results: [], count: 0 }).resources[0].list.wrapper?.path).toEqual(['results']);
    expect(shape({ a: { b: { c: [{ id: 1 }] } } }).resources[0].list.wrapper?.path).toEqual(['a', 'b', 'c']);
    const tooDeep = shape({ a: { b: { c: { d: [{ id: 1 }] } } } });
    expect(tooDeep.resources).toEqual([]);
    expect(tooDeep.problems[0]).toMatch(/^u: its list answer has no single list of records/);
    expect(shape({ users: [{ id: 1 }], admins: [{ id: 2 }] }).resources).toEqual([]);
    expect(shape('<xml/>').problems[0]).toMatch(/isn't JSON records/);
    expect(shape(['a', 'b']).resources).toEqual([]);
  });

  it('literal siblings stay static; duplicate names get #2; problem names are cut to 60 chars', () => {
    const r = detectResources(
      [
        ep('GET', '/users', [ex([{ id: 1 }])]),
        ep('GET', '/users/me', [ex({ id: 1 })]),
        ep('GET', '/users/:id', [ex({ id: 1 })]),
        ep('GET', '/v2/users', [ex([{ id: 1 }])]),
        ep('PATCH', '/v2/users/:id'),
        ep('GET', `/${'x'.repeat(90)}`, [ex([{ nope: 1 }])]),
        ep('GET', `/${'x'.repeat(90)}/:id`),
      ],
      {},
    );
    expect(r.resources.map((x) => x.name)).toEqual(['users', 'users #2']);
    expect(r.resources[0].ops.get).toBe('GET /users/:id');
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].length).toBeLessThan(110);
    expect(r.problems[0]).toContain('…: set its id field');
  });

  it('more than 100 resources: the rest stay static with one line', () => {
    const eps: MockEndpoint[] = [];
    for (let i = 0; i < 105; i++) eps.push(ep('GET', `/r${i}`), ep('GET', `/r${i}/:id`));
    const r = detectResources(eps, {});
    expect(r.resources).toHaveLength(100);
    expect(r.problems).toEqual(['5 more resources answer from the examples (at most 100 remember)']);
  });

  it('a path that repeats a parameter name stays static', () => {
    const r = detectResources([ep('GET', '/a/:id/b'), ep('GET', '/a/:id/b/:id')], {});
    expect(r.resources).toEqual([]);
    expect(r.problems[0]).toContain('repeats a parameter name');
  });

  it('never throws on junk', () => {
    expect(detectResources(undefined as unknown as MockEndpoint[], {}).resources).toEqual([]);
    const broken = detectResources([ep('GET', '/a'), ep('GET', '/a/:id', [ex('{"id":')])], null as never);
    expect(broken.resources).toEqual([]);
    expect(broken.problems).toEqual(["a: its item answer isn't a JSON object, so it answers from the examples"]);
  });

  it('is fast: 2 000 endpoints in under 50 ms', () => {
    const eps: MockEndpoint[] = [];
    const body = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `n${i}`, tags: ['a', 'b'] })));
    for (let i = 0; i < 500; i++) {
      eps.push(ep('GET', `/r${i}`, [ex(body)]), ep('POST', `/r${i}`), ep('GET', `/r${i}/:id`, [ex({ id: 1, name: 'x' })]), ep('DELETE', `/r${i}/:id`));
    }
    detectResources(eps, {});
    const t0 = performance.now();
    const r = detectResources(eps, {});
    const ms = performance.now() - t0;
    expect(r.resources).toHaveLength(100);
    expect(ms).toBeLessThan(50);
  });
});

describe('helpers', () => {
  it('singular', () => {
    expect(['users', 'categories', 'boxes', 'address', 'news', 'data'].map(singular)).toEqual(['user', 'category', 'box', 'address', 'new', 'data']);
  });
  it('cleanJson drops __proto__, keeps constructor as data, refuses more than 32 levels', () => {
    const c = cleanJson(JSON.parse('{"__proto__":{"admin":true},"constructor":1,"a":[1,{"b":null}]}'));
    expect(c.ok).toBe(true);
    const v = (c as { value: Record<string, unknown> }).value;
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect(Object.keys(v)).toEqual(['constructor', 'a']);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    let deep: unknown = 1;
    for (let i = 0; i < 33; i++) deep = [deep];
    expect(cleanJson(deep).ok).toBe(false);
    deep = 1;
    for (let i = 0; i < 32; i++) deep = [deep];
    expect(cleanJson(deep).ok).toBe(true);
  });
});
