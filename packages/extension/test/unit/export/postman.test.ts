import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { POSTMAN_SCHEMA, toPostman } from '../../../src/export';
import { ex } from './helpers';

type Json = Record<string, any>;

const API = 'https://api.example.com';

function build(exchanges: Exchange[], opts: Partial<Parameters<typeof toPostman>[1]> = {}) {
  const res = toPostman(exchanges, { title: 'Demo', ...opts });
  const col = JSON.parse(res.text) as Json;
  expect(postmanProblems(col)).toEqual([]);
  return { res, col };
}

/** Structural checks of a v2.1 collection as this exporter writes it. */
function postmanProblems(col: Json): string[] {
  const out: string[] = [];
  if (col.info?.schema !== POSTMAN_SCHEMA) out.push('info.schema');
  if (typeof col.info?.name !== 'string') out.push('info.name');
  const declared = new Set((col.variable as Json[]).map((v) => v.key));
  const used = new Set<string>();
  const scan = (s: unknown) => {
    for (const m of JSON.stringify(s).matchAll(/\{\{([^}]+)\}\}/g)) used.add(m[1]);
  };
  for (const folder of col.item as Json[]) {
    if (typeof folder.name !== 'string' || !Array.isArray(folder.item)) out.push('folder shape');
    for (const it of folder.item as Json[]) {
      const where = String(it.name);
      const req = it.request;
      if (typeof req?.method !== 'string') out.push(`${where}: method`);
      if (!req.url?.raw?.startsWith('{{')) out.push(`${where}: url.raw`);
      for (const h of req.header as Json[]) if (typeof h.key !== 'string' || typeof h.value !== 'string') out.push(`${where}: header`);
      const pathVars = (req.url.path as string[]).filter((p) => p.startsWith(':')).map((p) => p.slice(1));
      const declaredVars = ((req.url.variable as Json[] | undefined) ?? []).map((v) => v.key);
      if (JSON.stringify(pathVars) !== JSON.stringify(declaredVars)) out.push(`${where}: path variables ${pathVars} vs ${declaredVars}`);
      for (const r of it.response as Json[]) {
        if (typeof r.code !== 'number' || typeof r.body !== 'string' || !r.originalRequest) out.push(`${where}: example shape`);
      }
      scan(it);
    }
  }
  for (const u of used) if (!declared.has(u)) out.push(`variable {{${u}}} not declared`);
  return out;
}

describe('toPostman', () => {
  it('v2.1 collection: a folder per host, one request per route (latest sample), baseUrl variables', () => {
    const { res, col } = build([
      ex('GET', `${API}/users/42?page=1`, 200, { id: 42 }),
      ex('GET', `${API}/users/7?page=2`, 200, { id: 7 }),
      ex('POST', `${API}/users`, 201, { id: 8 }, { reqBody: { name: 'Cy' } }),
      ex('GET', 'http://localhost:8080/health', 200, 'ok', { responseHeaders: { 'content-type': 'text/plain' } }),
    ]);
    expect(col.info).toMatchObject({ name: 'Demo', schema: POSTMAN_SCHEMA });
    expect(col.item.map((f: Json) => f.name)).toEqual(['api.example.com', 'localhost:8080']);
    expect(col.variable).toEqual([
      { key: 'baseUrl', value: API, type: 'string' },
      { key: 'baseUrl2', value: 'http://localhost:8080', type: 'string' },
    ]);
    const [postItem, usersItem] = col.item[0].item; // sorted by path, then method
    expect(usersItem.name).toBe('GET /users/:id');
    expect(postItem.name).toBe('POST /users');
    expect(usersItem.request.url).toEqual({
      raw: '{{baseUrl}}/users/:id?page=2',
      host: ['{{baseUrl}}'],
      path: ['users', ':id'],
      query: [{ key: 'page', value: '2' }],
      variable: [{ key: 'id', value: '7' }],
    });
    expect(usersItem.request.description).toBe('Recorded 2 times.');
    expect(postItem.request.body).toEqual({ mode: 'raw', raw: '{\n  "name": "Cy"\n}', options: { raw: { language: 'json' } } });
    expect(col.item[1].item[0].request.url.raw).toBe('{{baseUrl2}}/health');
    expect(res.routes).toBe(3);
    expect(res.exchanges).toBe(4);
  });

  it('saved examples: the latest response of each status, with the request that got it', () => {
    const { col } = build([
      ex('GET', `${API}/users/1`, 200, { v: 1 }),
      ex('GET', `${API}/users/2`, 404, { error: 'nf' }),
      ex('GET', `${API}/users/3`, 200, { v: 3 }),
    ]);
    const item = col.item[0].item[0];
    expect(item.response.map((r: Json) => r.name)).toEqual(['200 OK', '404 Not Found']);
    const ok = item.response[0];
    expect(ok).toMatchObject({ status: 'OK', code: 200, _postman_previewlanguage: 'json', cookie: [] });
    expect(JSON.parse(ok.body)).toEqual({ v: 3 });
    expect(ok.originalRequest.url.variable).toEqual([{ key: 'id', value: '3' }]);
    expect(ok.header).toEqual([{ key: 'content-type', value: 'application/json; charset=utf-8' }]);
  });

  it('drops connection-level headers', () => {
    const { col } = build([
      ex('GET', `${API}/a`, 200, {}, { requestHeaders: { host: 'api.example.com', 'content-length': '0', connection: 'keep-alive', accept: 'application/json', ':authority': 'x' } }),
    ]);
    expect(col.item[0].item[0].request.header).toEqual([{ key: 'accept', value: 'application/json' }]);
  });

  it('GraphQL: a request per operation on the endpoint', () => {
    const g = (name: string) => ex('POST', `${API}/graphql`, 200, { data: {} }, { reqBody: { query: `query ${name} { x }` }, graphql: { operationName: name, operationType: 'query' } });
    const { col, res } = build([g('A'), g('B'), g('A')]);
    expect(col.item[0].item.map((i: Json) => i.name)).toEqual(['POST /graphql — query A', 'POST /graphql — query B']);
    expect(res.routes).toBe(2);
  });

  it('skips what it cannot export, with the same notes as OpenAPI; binary bodies are left out', () => {
    const { res, col } = build([
      ex('GET', `${API}/ws`, 101, undefined, { kind: 'websocket' }),
      ex('GET', `${API}/a`, 200, undefined, { state: 'pending', status: undefined }),
      ex('GET', `${API}/img`, 200, undefined, { responseHeaders: { 'content-type': 'image/png' }, responseBody: { text: 'iVBORw0K', encoding: 'base64' } }),
      ex('PROPFIND', `${API}/dav`, 207, '<x/>', { responseHeaders: { 'content-type': 'application/xml' } }),
    ]);
    expect(res.notes).toEqual([
      '1 WebSocket exchange skipped',
      '1 unfinished exchange (pending or paused) skipped',
      '1 binary body left out (Postman raw bodies are text)',
    ]);
    const img = col.item[0].item.find((i: Json) => i.name === 'GET /img');
    expect(img.response[0].body).toBe('');
    // any method is fine in Postman
    const dav = col.item[0].item.find((i: Json) => i.name === 'PROPFIND /dav');
    expect(dav.response[0]).toMatchObject({ code: 207, _postman_previewlanguage: 'xml', body: '<x/>' });
  });

  it('cuts long bodies at maxExampleChars with a note (each body counted once)', () => {
    const { res, col } = build([ex('POST', `${API}/a`, 200, 'x'.repeat(100), { reqBody: 'y'.repeat(100), responseHeaders: { 'content-type': 'text/plain' } })], { maxExampleChars: 10 });
    const item = col.item[0].item[0];
    expect(item.request.body.raw).toBe('y'.repeat(10) + '…');
    expect(item.response[0].body).toBe('x'.repeat(10) + '…');
    expect(res.notes).toEqual(['2 bodies cut at 10 characters']);
  });

  describe('redaction', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
    const exchanges = () => [
      ex('POST', `${API}/login?api_key=k123&page=1`, 200, { access_token: 'tok-1', id: 5 }, {
        reqBody: { user: 'ada', password: 'hunter2' },
        requestHeaders: {
          Authorization: 'Bearer abcdefghijklmnop123',
          'X-Api-Key': 'key-9',
          Cookie: ['a=1', 'b=2'],
          'content-type': 'application/json',
          'x-trace': jwt,
        },
        responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'sid=s3cr3t' },
      }),
      ex('GET', `${API}/reset/${jwt}`, 200, { ok: true }),
    ];

    it('default: secret headers become empty variables; URLs, bodies and other headers are redacted', () => {
      const { res, col } = build(exchanges());
      for (const secret of ['hunter2', 'tok-1', 'k123', 'key-9', 'abcdefghijklmnop123', 's3cr3t', jwt, 'a=1']) expect(res.text).not.toContain(secret);
      const login = col.item[0].item.find((i: Json) => i.name === 'POST /login');
      // the bearer token is the request's auth (CONTRACTS §14.6); the other credentials stay headers / parameters
      expect(login.request.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{bearerToken}}', type: 'string' }] });
      expect(login.response[0].originalRequest.auth).toEqual(login.request.auth);
      expect(login.request.header).toEqual([
        { key: 'X-Api-Key', value: '{{x-api-key}}' },
        { key: 'Cookie', value: '{{cookie}}' },
        { key: 'Cookie', value: '{{cookie}}' },
        { key: 'content-type', value: 'application/json' },
        { key: 'x-trace', value: '[redacted]' },
      ]);
      expect(col.variable).toEqual([
        { key: 'baseUrl', value: API, type: 'string' },
        { key: 'x-api-key', value: '', type: 'string' },
        { key: 'cookie', value: '', type: 'string' },
        { key: 'bearerToken', value: '', type: 'string' },
      ]);
      expect(login.request.url.query).toEqual([
        { key: 'api_key', value: '[redacted]' },
        { key: 'page', value: '1' },
      ]);
      expect(JSON.parse(login.request.body.raw)).toEqual({ user: 'ada', password: '[redacted]' });
      expect(JSON.parse(login.response[0].body)).toEqual({ access_token: '[redacted]', id: 5 });
      expect(login.response[0].header).toContainEqual({ key: 'set-cookie', value: '[redacted]' });
      // a JWT path segment is a path variable with a redacted value
      const reset = col.item[0].item.find((i: Json) => i.name === 'GET /reset/:id');
      expect(reset.request.url.variable).toEqual([{ key: 'id', value: '[redacted]' }]);
      expect(res.notes).toContain('Secrets are variables to fill in: {{x-api-key}}, {{cookie}}, {{bearerToken}}');
    });

    it('redact: false keeps every value: no header variables, the auth variable holds the recorded token', () => {
      const { res, col } = build(exchanges(), { redact: false });
      for (const secret of ['hunter2', 'tok-1', 'k123', 'key-9', 'abcdefghijklmnop123', 's3cr3t', jwt]) expect(res.text).toContain(secret);
      expect(col.variable).toEqual([
        { key: 'baseUrl', value: API, type: 'string' },
        { key: 'bearerToken', value: 'abcdefghijklmnop123', type: 'string' },
      ]);
      expect(res.notes).toEqual([]);
    });
  });

  describe('auth (CONTRACTS §14.6)', () => {
    // Fake credentials, built at run time.
    const opaque = ['sk', 'live', 'Qa12Ws34Ed56Rf78Tg90Yh12Uj34Ik56'].join('_');
    const basic = Buffer.from(['ada', 'p:ss'].join(':')).toString('base64');
    const h = (headers: Record<string, string>) => ({ requestHeaders: { accept: 'application/json', ...headers } });
    const items = (col: Json) => Object.fromEntries((col.item[0].item as Json[]).map((i) => [i.name, i]));

    it('basic, header API key and query API key become auth with {{variable}} placeholders, removed from headers / query', () => {
      const { res, col } = build([
        ex('POST', `${API}/session`, 200, {}, h({ Authorization: `Basic ${basic}` })),
        ex('GET', `${API}/items`, 200, [], h({ 'X-API-Key': opaque })),
        ex('GET', `${API}/maps?q=cafe&api_key=${opaque}&page=2`, 200, {}),
        ex('GET', `${API}/public`, 200, {}),
      ]);
      expect(res.text).not.toContain(opaque);
      expect(res.text).not.toContain(basic);
      const it = items(col);
      expect(it['POST /session'].request.auth).toEqual({
        type: 'basic',
        basic: [
          { key: 'username', value: '{{basicUsername}}', type: 'string' },
          { key: 'password', value: '{{basicPassword}}', type: 'string' },
        ],
      });
      expect(it['POST /session'].request.header).toEqual([{ key: 'accept', value: 'application/json' }]);
      expect(it['GET /items'].request.auth).toEqual({
        type: 'apikey',
        apikey: [
          { key: 'key', value: 'X-API-Key', type: 'string' },
          { key: 'value', value: '{{x-api-key}}', type: 'string' },
          { key: 'in', value: 'header', type: 'string' },
        ],
      });
      expect(it['GET /items'].request.header).toEqual([{ key: 'accept', value: 'application/json' }]);
      const maps = it['GET /maps'].request;
      expect(maps.auth.apikey).toEqual([
        { key: 'key', value: 'api_key', type: 'string' },
        { key: 'value', value: '{{api_key}}', type: 'string' },
        { key: 'in', value: 'query', type: 'string' },
      ]);
      expect(maps.url.query).toEqual([
        { key: 'q', value: 'cafe' },
        { key: 'page', value: '2' },
      ]);
      expect(maps.url.raw).toBe('{{baseUrl}}/maps?q=cafe&page=2');
      expect(it['GET /public'].request).not.toHaveProperty('auth');
      expect(col.variable.map((v: Json) => [v.key, v.value])).toEqual([
        // first-use order (requests sorted by path)
        ['baseUrl', API],
        ['x-api-key', ''],
        ['api_key', ''],
        ['basicUsername', ''],
        ['basicPassword', ''],
      ]);
    });

    it('with "Keep values" the variables hold the recorded credentials (basic split into user and password)', () => {
      const { col } = build([
        ex('POST', `${API}/session`, 200, {}, h({ Authorization: `Basic ${basic}` })),
        ex('GET', `${API}/maps?api_key=${opaque}`, 200, {}),
      ], { redact: false });
      expect(col.variable.map((v: Json) => [v.key, v.value])).toEqual([
        ['baseUrl', API],
        ['api_key', opaque],
        ['basicUsername', 'ada'],
        ['basicPassword', 'p:ss'],
      ]);
      expect(items(col)['GET /maps'].request.url.raw).toBe('{{baseUrl}}/maps');
    });
  });

  it('nothing to export → an empty valid collection with a note', () => {
    const { res, col } = build([]);
    expect(col.item).toEqual([]);
    expect(col.variable).toEqual([]);
    expect(res.notes).toEqual(['No finished HTTP exchanges to export.']);
  });
});
