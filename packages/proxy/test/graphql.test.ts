// GraphQL awareness (CONTRACTS §11.2): detection without a parser, `graphqlOperation` matching (pure, shared
// with the webview) and routing in the proxy (the rule is chosen once the body is known).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy, Rule } from '../src';
import { detectGraphql, matches, ruleFromExchange, scanOperations } from '../src/rules';
import { inState, nextExchange, settled, startProxy, startUpstream, viaProxy, type Upstream } from './helpers';

const json = (o: unknown) => JSON.stringify(o);
const post = (body: string, ct = 'application/json') => ({ method: 'POST', url: 'https://api.test/graphql', contentType: ct, body });

describe('scanOperations', () => {
  it('reads operation types and names, skipping comments, strings, variables with object defaults, directives and fragments', () => {
    const doc = `
      # query Fake { x }
      fragment UserParts on User @include(if: true) { id name(format: "query NotThis { }") }
      query GetUser($id: ID!, $filter: Filter = {kind: "a", nested: {deep: [1, 2]}}) @cached(ttl: 60) {
        user(id: $id) { ...UserParts friends(first: 10) { edges { node { id } } } }
      }
      mutation UpdateUser { update(input: {name: "x}", bio: """block } with "quotes" and \\""" query Nope { }"""}) { id } }
      subscription OnMessage { message { text } }
      { shorthand }`;
    expect(scanOperations(doc)).toEqual([
      { type: 'query', name: 'GetUser' },
      { type: 'mutation', name: 'UpdateUser' },
      { type: 'subscription', name: 'OnMessage' },
      { type: 'query' },
    ]);
  });

  it('is not fooled by non-GraphQL text', () => {
    for (const s of ['shoes', 'query', 'query shoes', 'type User { id: ID }', '{ unbalanced', 'select * from t', '', '"query X { a }"']) {
      expect(scanOperations(s), s).toBeUndefined();
    }
    expect(scanOperations('query Q { a(s: "unterminated) }')).toBeUndefined();
  });
});

describe('detectGraphql', () => {
  it('POST application/json: query + operationName (the named one picks the type)', () => {
    const body = json({ query: 'query A { a } mutation B { b }', operationName: 'B', variables: { x: 1 } });
    expect(detectGraphql(post(body))).toEqual({ info: { operationType: 'mutation', operationName: 'B' }, count: 1, operationNames: ['B'] });
    expect(detectGraphql(post(json({ query: '{ me { id } }' })))).toEqual({ info: { operationType: 'query' }, count: 1, operationNames: [] });
    expect(detectGraphql(post(json({ query: 'subscription S { s }' }), 'application/graphql-response+json; charset=utf-8'))?.info).toEqual({
      operationType: 'subscription',
      operationName: 'S',
    });
  });

  it('persisted queries (APQ): hash only → persisted; hash + query → the query', () => {
    const ext = { persistedQuery: { version: 1, sha256Hash: 'abc' } };
    expect(detectGraphql(post(json({ operationName: 'GetFeed', variables: {}, extensions: ext })))?.info).toEqual({
      persisted: true,
      operationName: 'GetFeed',
    });
    expect(detectGraphql(post(json({ operationName: 'GetFeed', query: 'query GetFeed { f }', extensions: ext })))?.info).toEqual({
      operationType: 'query',
      operationName: 'GetFeed',
    });
  });

  it('batched arrays: first operation + count + every name', () => {
    const body = json([{ query: 'query A { a }' }, { query: 'mutation B { b }', operationName: 'B' }, { not: 'graphql' }]);
    expect(detectGraphql(post(body))).toEqual({ info: { operationType: 'query', operationName: 'A', batch: 2 }, count: 2, operationNames: ['A', 'B'] });
    expect(detectGraphql(post(json([{ query: 'query One { a }' }])))?.info).toEqual({ operationType: 'query', operationName: 'One', batch: 1 });
    expect(detectGraphql(post(json({ query: 'query One { a }' })))?.info.batch).toBeUndefined();
  });

  it('application/graphql bodies and GET ?query= / persisted GET', () => {
    expect(detectGraphql(post('query Q { q }', 'application/graphql'))?.info).toEqual({ operationType: 'query', operationName: 'Q' });
    const q = encodeURIComponent('query Search($t: String) { search(t: $t) { id } }');
    expect(detectGraphql({ method: 'GET', url: `https://x/graphql?query=${q}&variables=%7B%7D`, contentType: '' })?.info).toEqual({
      operationType: 'query',
      operationName: 'Search',
    });
    const ext = encodeURIComponent(json({ persistedQuery: { version: 1, sha256Hash: 'h' } }));
    expect(detectGraphql({ method: 'GET', url: `https://x/graphql?operationName=Feed&extensions=${ext}`, contentType: '' })?.info).toEqual({
      persisted: true,
      operationName: 'Feed',
    });
  });

  it('REVIEW-5 #9: operationName must be a GraphQL Name of at most 200 chars', () => {
    const zw = 'getUser\u200b';
    expect(detectGraphql(post(json({ query: 'query getUser { u }', operationName: zw })))?.info).toEqual({ operationType: 'query', operationName: 'getUser' });
    expect(detectGraphql(post(json({ operationName: zw, extensions: { persistedQuery: { version: 1 } } })))?.info).toEqual({ persisted: true });
    expect(detectGraphql(post(json({ query: '{ a }', operationName: 'a'.repeat(201) })))?.info.operationName).toBeUndefined();
    expect(detectGraphql(post(json({ query: '{ a }', operationName: 'a'.repeat(200) })))?.info.operationName).toHaveLength(200);
    expect(detectGraphql(post(json({ query: `query ${'b'.repeat(300)} { a }` })))?.info).toEqual({ operationType: 'query' });
    expect(detectGraphql({ method: 'GET', url: `https://x/g?query=${encodeURIComponent('{ a }')}&operationName=bad%20name`, contentType: '' })?.info).toEqual({
      operationType: 'query',
    });
    expect(matches({ url: '*', graphqlOperation: 'getUser' }, 'POST', 'https://x', json({ query: 'query getUser { u }', operationName: zw }))).toBe(true);
  });

  it('REST look-alikes are not GraphQL', () => {
    expect(detectGraphql({ method: 'GET', url: 'https://shop/search?query=red+shoes', contentType: '' })).toBeUndefined();
    expect(detectGraphql(post(json({ query: 'red shoes' })))).toBeUndefined();
    expect(detectGraphql(post(json({ query: 'query Q { q }' }), 'text/plain'))).toBeUndefined(); // strict: content type
    expect(detectGraphql(post('not json'))).toBeUndefined();
  });
});

describe('matches() with graphqlOperation (pure, as the webview uses it)', () => {
  const m = { url: '*/graphql*', graphqlOperation: 'GetUser' };
  it('matches the body operation name, any operation of a batch, and GET URLs without a body', () => {
    expect(matches(m, 'POST', 'https://api/graphql', json({ query: 'query GetUser { u }' }))).toBe(true);
    expect(matches(m, 'POST', 'https://api/graphql', json({ query: 'query Other { u }' }))).toBe(false);
    expect(matches(m, 'POST', 'https://api/graphql', json([{ query: 'query A { a }' }, { query: 'query GetUser { u }' }]))).toBe(true);
    expect(matches(m, 'POST', 'https://api/graphql', 'query GetUser { u }')).toBe(true); // a raw document
    expect(matches(m, 'GET', `https://api/graphql?query=${encodeURIComponent('query GetUser { u }')}`)).toBe(true);
    expect(matches(m, 'POST', 'https://api/graphql')).toBe(false); // body unknown
    expect(matches(m, 'POST', 'https://api/other', json({ query: 'query GetUser { u }' }))).toBe(false);
  });
  it('without graphqlOperation, the body is ignored (backward compatible)', () => {
    expect(matches({ url: '*/graphql' }, 'POST', 'https://api/graphql')).toBe(true);
    expect(matches({ url: '*/graphql', graphqlOperation: '  ' }, 'POST', 'https://api/graphql')).toBe(true);
  });
  it('ruleFromExchange scopes a GraphQL exchange to its operation', () => {
    const ex = { id: '1', startedAt: 0, method: 'POST', url: 'https://api/graphql', requestHeaders: {}, state: 'completed', graphql: { operationName: 'GetUser' } } as Exchange;
    expect(ruleFromExchange(ex, 'block', 'r').match).toEqual({ method: 'POST', url: 'https://api/graphql*', graphqlOperation: 'GetUser' });
    expect(ruleFromExchange(ex, 'cors', 'r').match).toEqual({ url: 'https://api/graphql*' });
  });
});

// ---------------------------------------------------------------- proxy

let up: Upstream;
let proxy: InterceptProxy;
beforeAll(async () => {
  up = await startUpstream();
});
afterAll(async () => {
  await up.close();
});
beforeEach(async () => {
  proxy = await startProxy();
  up.hits.length = 0;
});
afterEach(async () => {
  await proxy.stop();
});

const gql = (query: string, operationName?: string) => json({ query, ...(operationName ? { operationName } : {}), variables: { id: 1 } });
const opts = (body: string) => ({ method: 'POST', body, headers: { 'content-type': 'application/json' } });
const mockOp = (op: string, body: string, extra: Partial<Rule> = {}): Rule => ({
  id: `m-${op}`,
  enabled: true,
  match: { url: '*/echo*', graphqlOperation: op },
  action: { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body },
  ...extra,
});

describe('GraphQL in the proxy', () => {
  it('sets Exchange.graphql on pass-through (POST body, GET URL)', async () => {
    await viaProxy(proxy.port, `${up.httpsUrl}/echo`, opts(gql('mutation Save { save }')));
    const q = encodeURIComponent('query List { items { id } }');
    await viaProxy(proxy.port, `${up.httpUrl}/echo?query=${q}`);
    const [a, b] = await settled(proxy);
    expect(a.graphql).toEqual({ operationType: 'mutation', operationName: 'Save' });
    expect(b.graphql).toEqual({ operationType: 'query', operationName: 'List' });
  });

  it('a mock scoped to one operation answers only that operation; the others reach the server', async () => {
    proxy.setRules([mockOp('GetUser', '{"data":{"user":{"id":"mock"}}}', { times: 1 })]);
    const other = await viaProxy(proxy.port, `${up.httpsUrl}/echo`, opts(gql('query GetFeed { feed }')));
    expect(JSON.parse(other.text).body).toContain('GetFeed');
    const mocked = await viaProxy(proxy.port, `${up.httpsUrl}/echo`, opts(gql('query GetUser { user { id } }')));
    expect(mocked.text).toBe('{"data":{"user":{"id":"mock"}}}');
    // times: 1 is spent by the matching operation only
    const again = await viaProxy(proxy.port, `${up.httpsUrl}/echo`, opts(gql('query GetUser { user { id } }')));
    expect(JSON.parse(again.text).body).toContain('GetUser');
    const all = await settled(proxy);
    expect(all.map((e) => [e.graphql?.operationName, e.state, e.matchedRuleId])).toEqual([
      ['GetFeed', 'completed', undefined],
      ['GetUser', 'mocked', 'm-GetUser'],
      ['GetUser', 'completed', undefined],
    ]);
    expect(up.hits).toEqual(['POST /echo', 'POST /echo']);
  });

  it('batched arrays match on any operation; persisted queries by operationName; GET without a body', async () => {
    proxy.setRules([mockOp('GetUser', '"hit"')]);
    const batch = json([{ query: 'query A { a }' }, { query: 'query GetUser { u }' }]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/echo`, opts(batch))).text).toBe('"hit"');
    const apq = json({ operationName: 'GetUser', extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } });
    expect((await viaProxy(proxy.port, `${up.httpUrl}/echo`, opts(apq))).text).toBe('"hit"');
    const q = encodeURIComponent('query GetUser { u }');
    expect((await viaProxy(proxy.port, `${up.httpUrl}/echo?query=${q}`)).text).toBe('"hit"');
    const all = await settled(proxy);
    expect(all.map((e) => e.graphql)).toEqual([
      { operationType: 'query', operationName: 'A', batch: 2 },
      { persisted: true, operationName: 'GetUser' },
      { operationType: 'query', operationName: 'GetUser' },
    ]);
    expect(up.hits).toEqual([]);
  });

  it('a later rule still applies when the GraphQL rule does not match (rule order kept)', async () => {
    proxy.setRules([mockOp('GetUser', '"first"'), { id: 'all', enabled: true, match: { url: '*/echo*' }, action: { kind: 'block', mode: 'status', status: 418 } }]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/echo`, opts(gql('query Other { o }')))).status).toBe(418);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/echo`, opts(gql('query GetUser { u }')))).text).toBe('"first"');
  });

  it('a response breakpoint scoped to an operation pauses only that operation', async () => {
    proxy.setRules([{ id: 'bp', enabled: true, match: { url: '*/echo*', graphqlOperation: 'GetUser' }, action: { kind: 'breakpoint', phase: 'response' } }]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/echo`, opts(gql('query Feed { f }')))).status).toBe(200);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/echo`, opts(gql('query GetUser { u }')));
    const ex = await paused;
    expect(ex.graphql?.operationName).toBe('GetUser');
    proxy.resume(ex.id, { body: '{"data":"edited"}' });
    expect((await resP).text).toBe('{"data":"edited"}');
  });

  it('a mutate rule scoped to an operation', async () => {
    proxy.setRules([{ id: 'mu', enabled: true, match: { url: '*/echo*', graphqlOperation: 'GetUser' }, action: { kind: 'mutate', ops: [{ op: 'null', path: '$.method' }] } }]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/echo`, opts(gql('query GetUser { u }')));
    expect(JSON.parse(r.text).method).toBeNull();
    const r2 = await viaProxy(proxy.port, `${up.httpUrl}/echo`, opts(gql('query Other { u }')));
    expect(JSON.parse(r2.text).method).toBe('POST');
  });

  it('a body over the 5 MB pause limit skips the GraphQL rule with a note', async () => {
    proxy.setRules([{ ...mockOp('GetUser', '"hit"'), match: { url: '*/count*', graphqlOperation: 'GetUser' } }]);
    const big = json({ query: 'query GetUser { u }', variables: { pad: 'x'.repeat(6 * 1024 * 1024) } });
    const r = await viaProxy(proxy.port, `${up.httpUrl}/count`, { method: 'POST', body: big, headers: { 'content-type': 'application/json' } });
    expect(r.text).toBe(String(Buffer.byteLength(big)));
    const [ex] = await settled(proxy);
    expect(ex.state).toBe('completed');
    expect(ex.error).toMatch(/GraphQL rule skipped: the request body \(6\.0 MB\) is over the 5 MB pause limit/);
  });
});
