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
      expect(login.request.header).toEqual([
        { key: 'Authorization', value: '{{authorization}}' },
        { key: 'X-Api-Key', value: '{{x-api-key}}' },
        { key: 'Cookie', value: '{{cookie}}' },
        { key: 'Cookie', value: '{{cookie}}' },
        { key: 'content-type', value: 'application/json' },
        { key: 'x-trace', value: '[redacted]' },
      ]);
      expect(col.variable).toEqual([
        { key: 'baseUrl', value: API, type: 'string' },
        { key: 'authorization', value: '', type: 'string' },
        { key: 'x-api-key', value: '', type: 'string' },
        { key: 'cookie', value: '', type: 'string' },
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
      expect(res.notes).toContain('Secret headers are variables to fill in: {{authorization}}, {{x-api-key}}, {{cookie}}');
    });

    it('redact: false keeps every value and declares no header variables', () => {
      const { res, col } = build(exchanges(), { redact: false });
      for (const secret of ['hunter2', 'tok-1', 'k123', 'key-9', 'abcdefghijklmnop123', 's3cr3t', jwt]) expect(res.text).toContain(secret);
      expect(col.variable).toEqual([{ key: 'baseUrl', value: API, type: 'string' }]);
      expect(res.notes).toEqual([]);
    });
  });

  it('nothing to export → an empty valid collection with a note', () => {
    const { res, col } = build([]);
    expect(col.item).toEqual([]);
    expect(col.variable).toEqual([]);
    expect(res.notes).toEqual(['No finished HTTP exchanges to export.']);
  });
});
