// v0.15.0 (CONTRACTS §21): pure collection helpers, hostile-input safety, hostMsg handling
// (collectionEndpoints / collectionExample / pruning), and reducer actions.
import { describe, expect, it } from 'vitest';
import {
  activeExampleOf, clipName, COLLECTION_LIMITS, collectionCountsText, collectionExampleCacheKey,
  collectionIdFromRuleId, filterEndpoints, formatExampleBody,
  groupEndpointsByFolder, isNoExampleExchange, knownRequestOrigins, noExampleCollectionName,
  statusClassSuffix,
} from '../src/collections';
import { isHostMsg } from '../src/host';
import type { CollectionEndpointView, CollectionStatus, HostMsg } from '../src/protocol';
import { initialState, reducer, toPersisted, type Action, type State } from '../src/state';
import { ex, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });
const run = (s: State, ...actions: Action[]) => actions.reduce(reducer, s);

const colStatus = (over: Partial<CollectionStatus> = {}): CollectionStatus => ({
  id: 'shop-api',
  overrides: 0,
  name: 'Shop API',
  file: 'api/shop.postman_collection.json',
  format: 'postman',
  enabled: true,
  unmatched: 'passthrough',
  endpoints: 10,
  mocked: 7,
  noExample: 2,
  generated: 0,
  off: 1,
  unresolved: [],
  origins: ['https://api.shop.example'],
  problems: [],
  ...over,
});

const ep = (over: Partial<CollectionEndpointView> = {}): CollectionEndpointView => ({
  key: 'GET {{baseUrl}}/users',
  method: 'GET',
  name: 'List users',
  folder: ['Users'],
  url: 'https://api.shop.example/users',
  examples: [{ name: 'OK', status: 200 }],
  ...over,
});

describe('pure collection helpers (CONTRACTS §21)', () => {
  it('formats counts leaving out zero parts except mocked', () => {
    expect(collectionCountsText({ mocked: 42, noExample: 3, off: 1 })).toBe('42 mocked · 3 without an example · 1 off');
    expect(collectionCountsText({ mocked: 0, noExample: 0, off: 0 })).toBe('0 mocked');
    expect(collectionCountsText({ mocked: 5, noExample: 0, off: 2 })).toBe('5 mocked · 2 off');
    expect(collectionCountsText({ mocked: 5, noExample: 1, off: 0 })).toBe('5 mocked · 1 without an example');
  });

  it('clips names longer than 200 characters with "…" without crashing on bad inputs', () => {
    const exact = 'a'.repeat(200);
    expect(clipName(exact)).toBe(exact);
    const over = 'b'.repeat(201);
    const clipped = clipName(over);
    expect(clipped).toHaveLength(200);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipName(undefined)).toBe('');
    expect(clipName(null)).toBe('');
    expect(clipName(123)).toBe('123');
  });

  it('picks the active example: selected if present, else first 2xx, else first', () => {
    expect(activeExampleOf(ep({ examples: [] }))).toBeUndefined();
    expect(activeExampleOf(ep({
      examples: [{ name: 'Err', status: 400 }, { name: 'OK', status: 201 }, { name: 'Other', status: 200 }],
    }))?.name).toBe('OK');
    expect(activeExampleOf(ep({
      selected: 'Err',
      examples: [{ name: 'Err', status: 400 }, { name: 'OK', status: 200 }],
    }))?.name).toBe('Err');
    expect(activeExampleOf(ep({
      selected: 'Missing',
      examples: [{ name: 'Err', status: 404 }, { name: 'Server', status: 500 }],
    }))?.name).toBe('Err');
  });

  it('filters endpoints by method, url and name (case-insensitive, hostile-regex safe)', () => {
    const list = [
      ep({ key: '1', method: 'GET', url: 'https://api.example.com/users', name: 'List users' }),
      ep({ key: '2', method: 'POST', url: 'https://api.example.com/auth/login', name: 'Log in' }),
      ep({ key: '3', method: 'DELETE', url: 'https://api.example.com/items/[id]+(a)?', name: 'Drop * item' }),
    ];
    expect(filterEndpoints(list, '  ').length).toBe(3);
    expect(filterEndpoints(list, 'post').map((x) => x.key)).toEqual(['2']);
    expect(filterEndpoints(list, 'AUTH/LOGIN').map((x) => x.key)).toEqual(['2']);
    expect(filterEndpoints(list, 'list users').map((x) => x.key)).toEqual(['1']);
    expect(filterEndpoints(list, 'post log').map((x) => x.key)).toEqual(['2']);
    // Hostile regex metacharacters never throw and match literally.
    expect(filterEndpoints(list, '[id]+(a)?').map((x) => x.key)).toEqual(['3']);
    expect(filterEndpoints(list, '*').map((x) => x.key)).toEqual(['3']);
  });

  it('groups endpoints by folder preserving order, handling prototype keys and folderDepth limit', () => {
    const deep = Array.from({ length: 40 }, (_, i) => `f${i}`);
    const list = [
      ep({ key: 'a', folder: ['__proto__'] }),
      ep({ key: 'b', folder: ['constructor', 'toString'] }),
      ep({ key: 'c', folder: [] }),
      ep({ key: 'd', folder: ['__proto__'] }),
      ep({ key: 'e', folder: deep }),
    ];
    const groups = groupEndpointsByFolder(list);
    expect(groups.map((g) => g.label)).toEqual([
      '__proto__',
      'constructor / toString',
      'Top level',
      deep.slice(0, COLLECTION_LIMITS.folderDepth).join(' / '),
    ]);
    expect(groups[0].endpoints.map((x) => x.key)).toEqual(['a', 'd']);
    expect(groups[2].endpoints.map((x) => x.key)).toEqual(['c']);
  });

  it('formats example bodies: lossless pretty JSON when valid, raw text otherwise, caps at 256 KB', () => {
    expect(formatExampleBody('')).toEqual({ text: '', isJson: false, truncated: false });
    expect(formatExampleBody('{"id":12345678901234567890,"z":-0,"f":1.0}')).toEqual({
      text: '{\n  "id": 12345678901234567890,\n  "z": -0,\n  "f": 1.0\n}',
      isJson: true,
      truncated: false,
    });
    expect(formatExampleBody('ok')).toEqual({ text: 'ok', isJson: false, truncated: false });
    expect(formatExampleBody('{invalid')).toEqual({ text: '{invalid', isJson: false, truncated: false });
    const huge = 'x'.repeat(COLLECTION_LIMITS.panelBodyBytes + 500);
    const res = formatExampleBody(huge);
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBe(COLLECTION_LIMITS.panelBodyBytes);
  });

  it('extracts 501 no-example state and collection name from matchedRuleId + Status.collections (CONTRACTS §21.8)', () => {
    const noEx = ex({
      status: 501,
      state: 'mocked',
      matchedRuleId: 'collection:shop-api:4',
      responseHeaders: { 'X-Flutter-Intercept': 'no-example' },
    });
    expect(isNoExampleExchange(noEx)).toBe(true);
    expect(isNoExampleExchange(ex())).toBe(false);

    // From Status.collections via matchedRuleId = collection:<id>:<n>
    expect(noExampleCollectionName(noEx, [colStatus()])).toBe('Shop API');
    expect(noExampleCollectionName(noEx, [colStatus({ name: 'X'.repeat(250) })])).toHaveLength(200);

    // Fallbacks when id is missing, non-collection, malformed, or unknown in Status.collections
    expect(noExampleCollectionName(noEx, [])).toBe('the collection');
    expect(noExampleCollectionName(ex({ matchedRuleId: undefined }), [colStatus()])).toBe('the collection');
    expect(noExampleCollectionName(ex({ matchedRuleId: 'rule_1' }), [colStatus()])).toBe('the collection');
    expect(noExampleCollectionName(ex({ matchedRuleId: 'collection:shop-api:' }), [colStatus()])).toBe('the collection');
    expect(collectionIdFromRuleId('collection:shop-api:4')).toBe('shop-api');
    expect(collectionIdFromRuleId('collection:shop-api:')).toBeUndefined();
    expect(collectionIdFromRuleId('rule_1')).toBeUndefined();
    expect(statusClassSuffix(204)).toBe('2xx');
    expect(statusClassSuffix(501)).toBe('5xx');
    expect(statusClassSuffix(99)).toBe('none');
  });

  it('collects unique HTTP(S) origins from traffic newest first', () => {
    const list = [
      ex({ url: 'https://old.example/a' }),
      ex({ url: 'not-a-url' }),
      ex({ url: 'http://localhost:8080/b' }),
      ex({ url: 'https://old.example/c' }),
    ];
    expect(knownRequestOrigins(list)).toEqual(['https://old.example', 'http://localhost:8080']);
  });
});

describe('collection state, hostMsg and reducer', () => {
  it('isHostMsg accepts collectionEndpoints and collectionExample', () => {
    expect(isHostMsg({ type: 'collectionEndpoints', id: 'c1', endpoints: [] })).toBe(true);
    expect(isHostMsg({ type: 'collectionExample', id: 'c1', endpoint: 'k', name: 'n', status: 200, headers: {}, body: '' })).toBe(true);
  });

  it('stores collectionEndpoints and collectionExample safely, including prototype-like keys', () => {
    let s = host(initialState(),
      { type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [colStatus({ id: '__proto__' })] } },
      { type: 'collectionEndpoints', id: '__proto__', endpoints: [ep({ key: 'constructor' })] },
      {
        type: 'collectionExample',
        id: '__proto__',
        endpoint: 'constructor',
        name: 'toString',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        truncated: true,
      },
    );
    expect(s.collectionEndpoints.get('__proto__')?.[0].key).toBe('constructor');
    const cached = s.collectionExamples.get(collectionExampleCacheKey('__proto__', 'constructor', 'toString'));
    expect(cached).toEqual({
      id: '__proto__',
      endpoint: 'constructor',
      name: 'toString',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      truncated: true,
    });
    // Never persisted to vscode.setState
    expect(JSON.stringify(toPersisted(s))).not.toContain('constructor');
  });

  it('drops stale collectionEndpoints/collectionExample and prunes removed collections on status/snapshot', () => {
    const c1 = colStatus({ id: 'c1' });
    const c2 = colStatus({ id: 'c2' });
    let s = host(initialState(),
      { type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [c1, c2] } },
      { type: 'collectionEndpoints', id: 'c1', endpoints: [ep()] },
      { type: 'collectionEndpoints', id: 'c2', endpoints: [ep({ key: 'k2' })] },
      { type: 'collectionEndpoints', id: 'gone', endpoints: [ep()] },
      { type: 'collectionExample', id: 'c1', endpoint: 'k1', name: 'OK', status: 200, headers: {}, body: '' },
      { type: 'collectionExample', id: 'gone', endpoint: 'k1', name: 'OK', status: 200, headers: {}, body: '' },
    );
    expect(s.collectionEndpoints.has('gone')).toBe(false);
    expect(s.collectionEndpoints.has('c1')).toBe(true);
    expect(s.collectionEndpoints.has('c2')).toBe(true);
    expect(s.collectionExamples.size).toBe(1);

    // Removing c2 in status prunes c2's endpoints while keeping c1
    s = host(s, { type: 'status', status: { ...status, collections: [c1] } });
    expect(s.collectionEndpoints.has('c2')).toBe(false);
    expect(s.collectionEndpoints.has('c1')).toBe(true);

    // Snapshot with no collections clears everything
    s = host(s, { type: 'snapshot', exchanges: [], rules: [], status });
    expect(s.collectionEndpoints.size).toBe(0);
    expect(s.collectionExamples.size).toBe(0);
  });

  it('handles setView collections, restore, patchCollectionEndpoint and error clearing awaitingRule', () => {
    let s = host(initialState(),
      { type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [colStatus()] } },
      { type: 'collectionEndpoints', id: 'shop-api', endpoints: [ep({ key: 'k1', examples: [{ name: 'A', status: 200 }, { name: 'B', status: 404 }] })] },
    );
    s = run(s,
      { type: 'setView', view: 'collections' },
      { type: 'patchCollectionEndpoint', id: 'shop-api', patch: { example: { endpoint: 'k1', name: 'B' } } },
      { type: 'patchCollectionEndpoint', id: 'shop-api', patch: { off: { endpoint: 'k1', off: true } } },
    );
    expect(s.view).toBe('collections');
    expect(s.collectionEndpoints.get('shop-api')?.[0]).toMatchObject({ selected: 'B', off: true });
    s = run(s, { type: 'patchCollectionEndpoint', id: 'shop-api', patch: { off: { endpoint: 'k1', off: false } } });
    expect(s.collectionEndpoints.get('shop-api')?.[0].off).toBeUndefined();

    // Restore preserves collections view
    const restored = reducer(initialState(), { type: 'restore', persisted: { view: 'collections' } });
    expect(restored.view).toBe('collections');

    // Error clears awaitingRule
    s = run(s, { type: 'awaitRule', kind: 'mock' });
    expect(s.awaitingRule).toBeDefined();
    s = host(s, { type: 'error', message: 'failed' });
    expect(s.awaitingRule).toBeUndefined();
  });

  it('tracks collectionRequested across status updates and resets it on snapshot (reconnect/ready)', () => {
    const c1 = colStatus({ id: 'c1' });
    const c2 = colStatus({ id: 'c2' });
    let s = host(initialState(), { type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [c1, c2] } });
    expect(s.snapshotSeq).toBe(1);
    s = run(s, { type: 'collectionRequested', id: 'c1' }, { type: 'collectionRequested', id: 'c2' });
    expect(s.collectionRequested.has('c1')).toBe(true);

    // Unsolicited collectionEndpoints for a collection that isn't expanded is stored without changing view
    s = host(s, { type: 'collectionEndpoints', id: 'c2', endpoints: [ep({ key: 'pushed' })] });
    expect(s.collectionEndpoints.get('c2')?.[0].key).toBe('pushed');

    // Status update keeps collectionRequested for live collections and prunes removed ones
    s = host(s, { type: 'status', status: { ...status, collections: [c1] } });
    expect(s.collectionRequested.has('c1')).toBe(true);
    expect(s.collectionRequested.has('c2')).toBe(false);

    // Fresh snapshot (reconnect / ready) bumps snapshotSeq and clears collectionRequested
    s = host(s, { type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [c1] } });
    expect(s.snapshotSeq).toBe(2);
    expect(s.collectionRequested.size).toBe(0);
  });
});
