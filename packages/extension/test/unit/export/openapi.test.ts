import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { toOpenApi } from '../../../src/export';
import { shapeToSchema } from '../../../src/export/openapi';
import { inferShape } from '../../../src/codegen/infer';
import { ex, openApiProblems, schemaProblems } from './helpers';

type Json = Record<string, any>;

function build(exchanges: Exchange[], opts: Partial<Parameters<typeof toOpenApi>[1]> = {}) {
  const res = toOpenApi(exchanges, { title: 'Demo', ...opts });
  const doc = JSON.parse(res.text) as Json;
  expect(openApiProblems(doc)).toEqual([]);
  return { res, doc };
}

const API = 'https://api.example.com';

describe('toOpenApi: document', () => {
  it('servers, templated paths, path params with schema and example, operationIds', () => {
    const { res, doc } = build([
      ex('GET', `${API}/users/42`, 200, { id: 42, name: 'Ada' }),
      ex('GET', `${API}/users/7`, 200, { id: 7, name: 'Bob', email: null }),
      ex('GET', `${API}/users`, 200, [{ id: 1 }]),
      ex('POST', `${API}/users`, 201, { id: 8 }, { reqBody: { name: 'Cy' } }),
    ]);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Demo');
    expect(doc.servers).toEqual([{ url: API }]);
    expect(Object.keys(doc.paths)).toEqual(['/users', '/users/{id}']);
    expect(Object.keys(doc.paths['/users'])).toEqual(['get', 'post']);
    const get = doc.paths['/users/{id}'].get;
    expect(get.operationId).toBe('getUsersById');
    expect(doc.paths['/users'].get.operationId).toBe('getUsers');
    expect(doc.paths['/users'].post.operationId).toBe('postUsers');
    expect(get.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 7 }]);
    expect(res.exchanges).toBe(4);
    expect(res.routes).toBe(3);
    expect(res.notes).toEqual([]);
    // text is pretty-printed with 2 spaces
    expect(res.text.split('\n')[1]).toBe('  "openapi": "3.1.0",');
  });

  it('response schema from ALL samples: required = in every sample, nullable via type arrays', () => {
    const { doc } = build([
      ex('GET', `${API}/users/42`, 200, { id: 42, name: 'Ada', tags: ['a'], score: 1 }),
      ex('GET', `${API}/users/7`, 200, { id: 7, name: null, score: 2.5, address: { city: 'X' } }),
    ]);
    const media = doc.paths['/users/{id}'].get.responses['200'].content['application/json'];
    expect(media.schema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        score: { type: 'number' },
        address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
      required: ['id', 'name', 'score'],
    });
    // one example: the latest sample
    expect(media.example).toEqual({ id: 7, name: null, score: 2.5, address: { city: 'X' } });
  });

  it('responses per status with reason phrases; empty bodies have no content', () => {
    const { doc } = build([
      ex('DELETE', `${API}/users/1`, 204),
      ex('DELETE', `${API}/users/2`, 404, { error: 'not found' }),
    ]);
    const r = doc.paths['/users/{id}'].delete.responses;
    expect(Object.keys(r)).toEqual(['204', '404']);
    expect(r['204']).toEqual({ description: 'No Content' });
    expect(r['404'].description).toBe('Not Found');
    expect(r['404'].content['application/json'].schema.required).toEqual(['error']);
  });

  it('query params: required when in every sample, typed, repeated → array', () => {
    const { doc } = build([
      ex('GET', `${API}/items?page=1&q=shoes&tag=a&tag=b`, 200, []),
      ex('GET', `${API}/items?page=2&active=true`, 200, []),
    ]);
    const params = doc.paths['/items'].get.parameters as Json[];
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.page).toEqual({ name: 'page', in: 'query', required: true, schema: { type: 'integer' }, example: 2 });
    expect(byName.q).toMatchObject({ required: false, schema: { type: 'string' } });
    expect(byName.q.example).toBeUndefined(); // not in the latest sample
    expect(byName.tag).toMatchObject({ required: false, schema: { type: 'array', items: { type: 'string' } } });
    expect(byName.active).toMatchObject({ required: false, schema: { type: 'boolean' }, example: true });
  });

  it('request body: schema from every sample, required only when every sample had one', () => {
    const { doc } = build([
      ex('POST', `${API}/login`, 200, { ok: true }, { reqBody: { user: 'a', remember: true } }),
      ex('POST', `${API}/login`, 200, { ok: true }, { reqBody: { user: 'b' } }),
      ex('POST', `${API}/login`, 400, { error: 'x' }),
    ]);
    const rb = doc.paths['/login'].post.requestBody;
    expect(rb.required).toBe(false);
    expect(rb.content['application/json'].schema).toEqual({
      type: 'object',
      properties: { user: { type: 'string' }, remember: { type: 'boolean' } },
      required: ['user'],
    });
  });

  it('examples are embedded verbatim (doubles, big ints) and keep their key order', () => {
    const body = '{"z":1.0,"big":12345678901234567890,"a":[]}';
    const { res, doc } = build([ex('GET', `${API}/n`, 200, body)]);
    expect(res.text).toContain('"z": 1.0');
    expect(res.text).toContain('"big": 12345678901234567890');
    expect(Object.keys(doc.paths['/n'].get.responses['200'].content['application/json'].example)).toEqual(['z', 'big', 'a']);
    expect(doc.paths['/n'].get.responses['200'].content['application/json'].schema.properties.z).toEqual({ type: 'number' });
  });

  it('non-JSON, binary and truncated bodies: media type only', () => {
    const { res, doc } = build([
      ex('GET', `${API}/page`, 200, '<html></html>', { responseHeaders: { 'content-type': 'text/html' } }),
      ex('GET', `${API}/img`, 200, undefined, { responseHeaders: { 'content-type': 'image/png' }, responseBody: { text: 'iVBORw0K', encoding: 'base64' } }),
      ex('GET', `${API}/big`, 200, undefined, { responseHeaders: { 'content-type': 'application/json' }, responseBody: { text: '{"a":', encoding: 'utf8', truncated: true } }),
    ]);
    expect(doc.paths['/page'].get.responses['200'].content).toEqual({ 'text/html': {} });
    expect(doc.paths['/img'].get.responses['200'].content).toEqual({ 'image/png': {} });
    expect(doc.paths['/big'].get.responses['200'].content).toEqual({ 'application/json': {} });
    expect(res.notes).toContain('1 JSON body not used for schemas (truncated or not valid JSON)');
  });

  it('a long example is cut at maxExampleChars, as a string example with a note', () => {
    const { res, doc } = build([ex('GET', `${API}/list`, 200, { items: Array.from({ length: 50 }, (_, i) => ({ i })) })], { maxExampleChars: 40 });
    const media = doc.paths['/list'].get.responses['200'].content['application/json'];
    expect(media.example).toBeUndefined();
    expect(media.examples.recorded.value).toHaveLength(41);
    expect(media.examples.recorded.value.endsWith('…')).toBe(true);
    expect(media.examples.recorded.summary).toMatch(/cut at 40 characters/);
    expect(media.schema.properties.items.items).toEqual({ type: 'object', properties: { i: { type: 'integer' } }, required: ['i'] });
    expect(res.notes).toContain('1 example cut at 40 characters');
  });

  it('several origins: one server each, shared paths, path-level servers when only some serve a path', () => {
    const B = 'https://staging.example.com';
    const { doc } = build([
      ex('GET', `${API}/users/1`, 200, { id: 1 }),
      ex('GET', `${B}/users/2`, 200, { id: 2 }),
      ex('GET', `${B}/health`, 200, { ok: true }),
      ex('POST', `${API}/users/1`, 200, {}),
    ]);
    expect(doc.servers).toEqual([{ url: API }, { url: B }]);
    expect(doc.paths['/users/{id}'].servers).toBeUndefined();
    expect(doc.paths['/users/{id}'].get.servers).toBeUndefined();
    expect(doc.paths['/users/{id}'].post.servers).toEqual([{ url: API }]);
    expect(doc.paths['/health'].servers).toEqual([{ url: B }]);
  });

  it('operationIds stay unique and path params are numbered', () => {
    const { doc } = build([
      ex('GET', `${API}/users/1/posts/9f1c2a3b4d5e6f70`, 200, {}),
      ex('GET', `${API}/users-by/id`, 200, {}),
      ex('GET', `${API}/usersBy/id`, 200, {}),
      ex('GET', `${API}/`, 200, {}),
    ]);
    const op = doc.paths['/users/{id}/posts/{id2}'].get;
    expect(op.operationId).toBe('getUsersByIdPostsById2');
    expect(op.parameters.map((p: Json) => p.name)).toEqual(['id', 'id2']);
    expect(op.parameters[1].schema).toEqual({ type: 'string' });
    expect(doc.paths['/'].get.operationId).toBe('getRoot');
    const ids = [doc.paths['/users-by/id'].get.operationId, doc.paths['/usersBy/id'].get.operationId].sort();
    expect(ids).toEqual(['getUsersById', 'getUsersById2']);
  });

  it('uuid path params get format uuid', () => {
    const { doc } = build([ex('GET', `${API}/orders/123e4567-e89b-12d3-a456-426614174000`, 200, {})]);
    expect(doc.paths['/orders/{id}'].get.parameters[0].schema).toEqual({ type: 'string', format: 'uuid' });
  });

  it('GraphQL: one path, the operations listed in the description', () => {
    const q = (name: string, type: 'query' | 'mutation') =>
      ex('POST', `${API}/graphql`, 200, { data: { [name]: { id: 1 } } }, { reqBody: { query: `${type} ${name} { x }`, operationName: name }, graphql: { operationName: name, operationType: type } });
    const { doc, res } = build([q('GetUser', 'query'), q('GetUser', 'query'), q('Login', 'mutation')]);
    expect(Object.keys(doc.paths)).toEqual(['/graphql']);
    const op = doc.paths['/graphql'].post;
    expect(op.description).toContain('GraphQL endpoint. Operations seen:');
    expect(op.description).toContain('`query GetUser` × 2');
    expect(op.description).toContain('`mutation Login`');
    expect(res.routes).toBe(1);
    // both operations' response fields, each optional
    expect(op.responses['200'].content['application/json'].schema.properties.data.properties).toHaveProperty('GetUser');
    expect(op.responses['200'].content['application/json'].schema.properties.data.properties).toHaveProperty('Login');
  });
});

describe('toOpenApi: selection', () => {
  it('only finished HTTP exchanges; vm-profile captures and mocks included; notes for the rest', () => {
    const base = (over: Partial<Exchange>) => ex('GET', `${API}/a`, 200, { a: 1 }, over);
    const { res, doc } = build([
      base({}),
      base({ captured: 'vm-profile' }),
      base({ state: 'mocked', matchedRuleId: 'r1' }),
      base({ kind: 'websocket', status: 101 }),
      base({ kind: 'websocket', status: 101 }),
      base({ kind: 'sse' }),
      base({ browserInternal: true }),
      base({ state: 'pending', status: undefined }),
      base({ state: 'paused-response' }),
      base({ state: 'error', status: undefined, error: 'boom' }),
      base({ state: 'blocked', status: 403 }),
      base({ state: 'aborted', status: undefined }),
    ]);
    expect(res.exchanges).toBe(3);
    expect(doc.paths['/a'].get.description).toBe('Recorded 3 times.');
    expect(res.notes).toEqual([
      '2 WebSocket exchanges skipped',
      '1 SSE exchange skipped',
      '1 browser-internal exchange skipped',
      '2 unfinished exchanges (pending or paused) skipped',
      '3 exchanges without a response (failed, aborted or blocked) skipped',
    ]);
  });

  it('methods OpenAPI 3.1 cannot describe are skipped with a note', () => {
    const { res, doc } = build([ex('PROPFIND', `${API}/dav`, 207, '<x/>'), ex('GET', `${API}/dav`, 200, {})]);
    expect(Object.keys(doc.paths['/dav'])).toEqual(['get']);
    expect(res.notes).toContain('1 PROPFIND exchange skipped (OpenAPI 3.1 has no PROPFIND operations)');
    expect(res.exchanges).toBe(1);
  });

  it('nothing to export → an empty but valid document and a note', () => {
    const { res, doc } = build([]);
    expect(doc.paths).toEqual({});
    expect(doc.servers).toEqual([]);
    expect(res.notes).toEqual(['No finished HTTP exchanges to export.']);
    expect(res.routes).toBe(0);
  });

  it('is deterministic regardless of input order (sorted by startedAt)', () => {
    const a = ex('GET', `${API}/u/1`, 200, { v: 'old' });
    const b = ex('GET', `${API}/u/2`, 200, { v: 'new' });
    expect(toOpenApi([b, a], { title: 'T' }).text).toBe(toOpenApi([a, b], { title: 'T' }).text);
    expect(JSON.parse(toOpenApi([b, a], { title: 'T' }).text).paths['/u/{id}'].get.responses['200'].content['application/json'].example).toEqual({ v: 'new' });
  });
});

describe('toOpenApi: redaction', () => {
  const secretToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
  const exchanges = () => [
    ex('POST', `${API}/login?api_key=k123&page=1`, 200, { access_token: 'tok-1', user: { id: 1, password: 'p' } }, {
      reqBody: { user: 'ada', password: 'hunter2' },
      requestHeaders: { authorization: 'Bearer abcdefghijklmnop123', 'content-type': 'application/json' },
    }),
    ex('GET', `${API}/reset/${secretToken}`, 200, { ok: true }),
  ];

  it('default: examples, query examples and secret path segments are redacted; schemas keep the field names', () => {
    const { res, doc } = build(exchanges());
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toContain('tok-1');
    expect(res.text).not.toContain('k123');
    expect(res.text).not.toContain(secretToken);
    expect(res.text).not.toContain('abcdefghijklmnop123');
    const op = doc.paths['/login'].post;
    expect(op.requestBody.content['application/json'].example).toEqual({ user: 'ada', password: '[redacted]' });
    expect(op.requestBody.content['application/json'].schema.properties.password).toEqual({ type: 'string' });
    expect(op.responses['200'].content['application/json'].example).toEqual({ access_token: '[redacted]', user: { id: 1, password: '[redacted]' } });
    // an API-key query parameter is a security scheme, not a parameter (CONTRACTS §14.6)
    expect(op.parameters.find((p: Json) => p.name === 'api_key')).toBeUndefined();
    expect(op.security).toEqual([{ apiKeyQuery_api_key: [], bearerAuth: [] }]);
    expect(op.parameters.find((p: Json) => p.name === 'page').example).toBe(1);
    // a JWT path segment is a parameter, never part of the path, and has no example
    expect(Object.keys(doc.paths)).toContain('/reset/{id}');
    expect(doc.paths['/reset/{id}'].get.parameters[0].example).toBeUndefined();
    expect(doc.info.description).toMatch(/redacted/);
  });

  it('redact: false keeps the values (but still templates credential segments)', () => {
    const { res, doc } = build(exchanges(), { redact: false });
    expect(res.text).toContain('hunter2');
    expect(res.text).toContain('tok-1');
    // security schemes never carry values, redacted or not
    expect(res.text).not.toContain('k123');
    expect(res.text).not.toContain('abcdefghijklmnop123');
    expect(doc.components.securitySchemes).toEqual({
      apiKeyQuery_api_key: { type: 'apiKey', in: 'query', name: 'api_key' },
      bearerAuth: { type: 'http', scheme: 'bearer' },
    });
    expect(Object.keys(doc.paths)).toContain('/reset/{id}');
  });
});

describe('shapeToSchema', () => {
  it.each([
    [[1, 2], { type: 'integer' }],
    [[1, 2.5], { type: 'number' }],
    [[true], { type: 'boolean' }],
    [['a', null], { type: ['string', 'null'] }],
    [[null], { type: 'null' }],
    [[[]], { type: 'array', items: {} }],
    [[[1], null], { type: ['array', 'null'], items: { type: 'integer' } }],
    [[1, 'a'], {}],
    [[{}], { type: 'object', properties: {} }],
    [[{ '17': { a: 1 }, '42': { a: 2, b: 'x' } }], { type: 'object', additionalProperties: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'string' } }, required: ['a'] } }],
    [[{ a: 1 }, null], { type: ['object', 'null'], properties: { a: { type: 'integer' } }, required: ['a'] }],
  ])('%j → %j', (samples, schema) => {
    const s = shapeToSchema(inferShape(samples));
    expect(s).toEqual(schema);
    expect(schemaProblems(s)).toEqual([]);
  });

  it('list items merge: a key missing from some items is not required', () => {
    expect(shapeToSchema(inferShape([[{ a: 1 }, { a: 2, b: 3 }]]))).toEqual({
      type: 'array',
      items: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a'] },
    });
  });
});

describe('toOpenApi: securitySchemes (CONTRACTS §14.6)', () => {
  // Fake credentials, built at run time.
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiI0MiJ9', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
  const opaque = ['sk', 'live', 'Zx98Yw76Vu54Ts32Rq10Po98Nm76Lk54'].join('_');
  const basic = Buffer.from(['ada', 'hunter2'].join(':')).toString('base64');
  const h = (headers: Record<string, string | string[]>) => ({ requestHeaders: { 'user-agent': 'Dart/3.5', ...headers } });

  it('infers bearer (JWT format), basic, header and query API keys; references them per operation; never includes values', () => {
    const { res, doc } = build([
      ex('GET', `${API}/me`, 200, { id: 1 }, h({ Authorization: `Bearer ${jwt}` })),
      ex('GET', `${API}/me`, 200, { id: 1 }, h({ authorization: `bearer ${jwt}` })),
      ex('POST', `${API}/session`, 200, { ok: true }, h({ Authorization: `Basic ${basic}` })),
      ex('GET', `${API}/maps?key=${opaque}&q=cafe`, 200, { r: [] }),
      ex('GET', `${API}/items`, 200, [], h({ 'X-API-Key': opaque })),
      ex('GET', `${API}/items`, 200, [], h({ 'x-api-key': opaque, 'Ocp-Apim-Subscription-Key': opaque })),
      ex('GET', `${API}/public`, 200, {}),
    ], { redact: false });
    for (const secret of [jwt, opaque, basic, 'hunter2']) expect(res.text).not.toContain(secret);
    expect(doc.components.securitySchemes).toEqual({
      'apiKeyQuery_key': { type: 'apiKey', in: 'query', name: 'key' },
      'apiKey_ocp-apim-subscription-key': { type: 'apiKey', in: 'header', name: 'Ocp-Apim-Subscription-Key' },
      'apiKey_x-api-key': { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      basicAuth: { type: 'http', scheme: 'basic' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    });
    expect(doc.paths['/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/session'].post.security).toEqual([{ basicAuth: [] }]);
    expect(doc.paths['/maps'].get.security).toEqual([{ apiKeyQuery_key: [] }]);
    expect(doc.paths['/maps'].get.parameters.map((p: Json) => p.name)).toEqual(['q']);
    // two combinations seen: one key, then both keys
    expect(doc.paths['/items'].get.security).toEqual([{ 'apiKey_x-api-key': [] }, { 'apiKey_ocp-apim-subscription-key': [], 'apiKey_x-api-key': [] }]);
    expect(doc.paths['/public'].get).not.toHaveProperty('security');
    expect(doc).not.toHaveProperty('security');
  });

  it('optional auth: requests with and without credentials → the scheme or {}', () => {
    const { doc } = build([ex('GET', `${API}/feed`, 200, [], h({ Authorization: 'Bearer short-token-1' })), ex('GET', `${API}/feed`, 200, [])]);
    expect(doc.paths['/feed'].get.security).toEqual([{ bearerAuth: [] }, {}]);
    // not every token was a JWT: no bearerFormat
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
  });

  it('other Authorization schemes are an API key in the Authorization header; names that are not keys are ignored', () => {
    const { doc } = build([
      ex('GET', `${API}/a`, 200, {}, h({ Authorization: 'Token abc123' })),
      ex('GET', `${API}/b?page_token=x&keyword=y&token=`, 200, {}, h({ 'x-csrf-token': 'c', 'idempotency-key': 'i', 'x-request-id': 'r' })),
    ]);
    expect(doc.components.securitySchemes).toEqual({ authorizationHeader: { type: 'apiKey', in: 'header', name: 'Authorization' } });
    expect(doc.paths['/b'].get).not.toHaveProperty('security');
    expect(doc.paths['/b'].get.parameters.map((p: Json) => p.name)).toEqual(['page_token', 'keyword', 'token']);
  });

  it('no credentials anywhere → no components', () => {
    const { doc } = build([ex('GET', `${API}/a`, 200, {})]);
    expect(doc).not.toHaveProperty('components');
  });
});
