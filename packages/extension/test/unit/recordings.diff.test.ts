import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { diff, diffText } from '../../src/recordings/diff';
import type { Recording } from '../../src/recordings/types';

let n = 0;
function ex(p: Partial<Exchange> = {}): Exchange {
  n++;
  return {
    id: `e${n}`,
    startedAt: n * 100,
    durationMs: 40,
    method: 'GET',
    url: 'https://api.example.com/users/1',
    requestHeaders: { accept: 'application/json' },
    status: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: { text: '{"id":1}', encoding: 'utf8' },
    state: 'completed',
    ...p,
  };
}
const json = (v: string): Partial<Exchange> => ({ responseBody: { text: v, encoding: 'utf8' } });

function rec(name: string, entries: Exchange[]): Recording {
  return { version: 1, id: name.toLowerCase(), name, createdAt: 0, exchanges: entries.length, path: `/tmp/${name}.json`, redacted: false, entries };
}

describe('diff', () => {
  it('reports added / removed routes, grouped by path template, in a stable order', () => {
    const a = rec('A', [ex({ url: 'https://api.example.com/users/1' }), ex({ url: 'https://api.example.com/users/2' }), ex({ url: 'https://api.example.com/legacy' })]);
    const b = rec('B', [ex({ url: 'https://api.example.com/users/7' }), ex({ url: 'https://api.example.com/users/9' }), ex({ url: 'https://api.example.com/feed', status: 204, responseBody: undefined })]);
    expect(diff(a, b)).toEqual([
      { route: 'GET /feed', change: 'added', detail: '1 call, 204' },
      { route: 'GET /legacy', change: 'removed', detail: '1 call, 200' },
    ]);
    // order does not depend on input order
    expect(diff(rec('A', [...a.entries].reverse()), rec('B', [...b.entries].reverse()))).toEqual(diff(a, b));
  });

  it('keeps the origin when the recordings span several hosts', () => {
    const a = rec('A', [ex({ url: 'https://a.example.com/x' })]);
    const b = rec('B', [ex({ url: 'https://b.example.com/x' })]);
    expect(diff(a, b).map((d) => `${d.change} ${d.route}`)).toEqual(['removed GET https://a.example.com/x', 'added GET https://b.example.com/x']);
  });

  it('reports status, count, shape, body and timing changes for one route', () => {
    const a = rec('A', [
      ex({ ...json('{"id":1,"name":"Ann","age":30,"price":1.0,"tags":[{"k":"a"}],"legacy":true}') }),
      ex({ url: 'https://api.example.com/users/2', ...json('{"id":2,"name":"Bob","age":31,"price":2.0,"tags":[],"legacy":false}') }),
    ]);
    const b = rec('B', [
      ex({ durationMs: 400, ...json('{"id":1,"name":"Ann","age":"30","price":1,"tags":[{"k":"a","v":1}],"avatar_url":"x"}') }),
      ex({ url: 'https://api.example.com/users/2', durationMs: 400, status: 500, ...json('{"id":2,"name":"Robert","age":"31","price":2,"tags":[],"avatar_url":null}') }),
      ex({ url: 'https://api.example.com/users/3', durationMs: 400, ...json('{"id":3,"name":"Cy","age":"5","price":3,"tags":[],"avatar_url":"y"}') }),
    ]);
    expect(diff(a, b)).toEqual([
      { route: 'GET /users/{id}', change: 'status', detail: '200 → 200/500' },
      { route: 'GET /users/{id}', change: 'count', detail: '2 → 3 calls' },
      { route: 'GET /users/{id}', change: 'shape', detail: '-field legacy (bool)' },
      { route: 'GET /users/{id}', change: 'shape', detail: '+field avatar_url (string?)' },
      { route: 'GET /users/{id}', change: 'shape', detail: 'type age: int → string' },
      { route: 'GET /users/{id}', change: 'shape', detail: 'type price: double → int' },
      { route: 'GET /users/{id}', change: 'shape', detail: '+field tags[].v (int)' },
      // pairs users/1 and users/2: only the name; retyped values are shape changes
      { route: 'GET /users/{id}', change: 'body', detail: '1 value changed in 1 of 2 responses' },
      { route: 'GET /users/{id}', change: 'timing', detail: '40 ms → 400 ms (median, 10.0× slower)' },
    ]);
  });

  it('counts value changes without revealing them, and ignores unchanged routes', () => {
    const a = rec('A', [ex(json('{"token":"old-secret","n":1}')), ex({ url: 'https://api.example.com/same' })]);
    const b = rec('B', [ex(json('{"token":"new-secret","n":2}')), ex({ url: 'https://api.example.com/same' })]);
    const d = diff(a, b);
    expect(d).toEqual([{ route: 'GET /users/{id}', change: 'body', detail: '2 values changed in 1 of 1 response' }]);
    expect(JSON.stringify(d)).not.toContain('secret');
  });

  it('pairs POSTs by request body and treats non-JSON bodies as text', () => {
    const post = (q: string, res: string) => ex({ method: 'POST', url: 'https://api.example.com/search', requestBody: { text: q, encoding: 'utf8' }, responseHeaders: { 'content-type': 'text/plain' }, responseBody: { text: res, encoding: 'utf8' } });
    const a = rec('A', [post('a', 'one'), post('b', 'two')]);
    const b = rec('B', [post('b', 'two'), post('a', 'uno')]);
    expect(diff(a, b)).toEqual([{ route: 'POST /search', change: 'body', detail: '1 of 2 responses changed' }]);
  });

  it('reports JSON → not JSON, nullability, array element changes and map-like objects', () => {
    const a = rec('A', [ex(json('{"items":[1,2],"byId":{"17":{"a":1},"42":{"a":2}},"x":"s"}')), ex({ url: 'https://api.example.com/page', ...json('{"a":1}') })]);
    const b = rec('B', [ex(json('{"items":[1.5],"byId":{"99":{"a":"1"}},"x":null}')), ex({ url: 'https://api.example.com/page', responseBody: { text: '<html>', encoding: 'utf8' } })]);
    const shape = diff(a, b).filter((d) => d.change === 'shape').map((d) => `${d.route}: ${d.detail}`);
    expect(shape).toEqual([
      'GET /page: response body: JSON → not JSON',
      'GET /users/{id}: type items[]: int → double',
      'GET /users/{id}: type byId{}.a: int → string',
      'GET /users/{id}: type x: string → null',
    ]);
  });

  it('labels GraphQL operations separately and redacts tokens in routes', () => {
    const gql = (op: string) => ex({ method: 'POST', url: 'https://api.example.com/graphql', graphql: { operationName: op } });
    const a = rec('A', [gql('GetUser'), ex({ url: 'https://api.example.com/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc' })]);
    const b = rec('B', [gql('GetFeed')]);
    expect(diff(a, b).map((d) => `${d.change} ${d.route}`)).toEqual(['added POST /graphql (GetFeed)', 'removed POST /graphql (GetUser)', 'removed GET /reset/[redacted]']);
  });

  it('does not flag small or faster timing changes', () => {
    expect(diff(rec('A', [ex({ durationMs: 10 })]), rec('B', [ex({ durationMs: 30 })]))).toEqual([]);
    expect(diff(rec('A', [ex({ durationMs: 400 })]), rec('B', [ex({ durationMs: 40 })]))).toEqual([]);
  });

  it('caps shape changes per route', () => {
    const keys = (p: string) => `{${Array.from({ length: 30 }, (_, i) => `"${p}${i}":1`).join(',')}}`;
    const d = diff(rec('A', [ex(json(keys('a')))]), rec('B', [ex(json(keys('b')))])).filter((x) => x.change === 'shape');
    expect(d).toHaveLength(21);
    expect(d[20].detail).toBe('… and 40 more shape changes');
  });
});

describe('diffText', () => {
  it('is normalised: sorted routes and headers, volatile headers dropped, secrets redacted, literals kept', () => {
    const r = rec('Run 1', [
      ex({
        url: 'https://api.example.com/users/2',
        startedAt: 50,
        requestHeaders: { Authorization: 'Bearer abcdefghijklmnop1234', 'x-request-id': 'r-1', accept: 'application/json', cookie: 'sid=abc; theme=dark' },
        responseHeaders: { date: 'Mon', 'content-type': 'application/json', 'set-cookie': ['sid=xyz; Path=/; HttpOnly; Max-Age=60'], etag: 'W/"1"', 'x-b3-traceid': '1' },
        responseBody: { text: '{"price":1.0,"big":12345678901234567890,"token":"t-secret","list":[]}', encoding: 'utf8' },
      }),
      ex({ url: 'https://api.example.com/avatar.png', startedAt: 10, responseHeaders: { 'content-type': 'image/png' }, responseBody: { text: 'iVBORw0KGgo=', encoding: 'base64' } }),
    ]);
    expect(diffText(r)).toBe(
      [
        'Recording: Run 1',
        '2 exchanges',
        '',
        '=== GET /avatar.png — 1 call',
        '',
        'GET https://api.example.com/avatar.png',
        '    accept: application/json',
        '→ 200',
        '    content-type: image/png',
        '',
        '    [binary 8 bytes, sha256 4c4b6a3be131…]',
        '',
        '=== GET /users/{id} — 1 call',
        '',
        'GET https://api.example.com/users/2',
        '    accept: application/json',
        '    authorization: [redacted]',
        '    cookie: sid=…; theme=…',
        '→ 200',
        '    content-type: application/json',
        '    set-cookie: sid=…; Path=/; HttpOnly',
        '',
        '    {',
        '      "price": 1.0,',
        '      "big": 12345678901234567890,',
        '      "token": "[redacted]",',
        '      "list": []',
        '    }',
        '',
      ].join('\n'),
    );
  });

  it('is identical for the same traffic recorded in a different order', () => {
    const a = ex({ url: 'https://api.example.com/a' });
    const b = ex({ url: 'https://api.example.com/b' });
    expect(diffText(rec('R', [a, b]))).toBe(diffText(rec('R', [b, a])));
  });

  it('marks truncated bodies and mocked responses', () => {
    const t = diffText(rec('R', [ex({ state: 'mocked', responseBody: { text: '{"a":', encoding: 'utf8', truncated: true } })]));
    expect(t).toContain('→ 200 (mocked)');
    expect(t).toContain('[truncated at the 5 MB capture limit]');
  });
});
