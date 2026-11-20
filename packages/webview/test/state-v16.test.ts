// v0.16.0 (CONTRACTS §22.10 / §22.11): pure helpers for a collection's remembered data, and the `storeItems`
// host message (replace / append by offset, pruning, hostile input).
import { describe, expect, it } from 'vitest';
import { isHostMsg } from '../src/host';
import type { CollectionStatus, HostMsg, StoreResourceView, StoreStatus } from '../src/protocol';
import { initialState, reducer, type State } from '../src/state';
import {
  cellOf, cellText, mergeStoreItems, parseRecordText, recordId, recordsJsonText, recordText, STORE_VIEW_LIMITS,
  storeColumns, storeItemsKey, storeOpOfExchange, storeSummaryText,
} from '../src/store';
import { ex, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });

const res = (over: Partial<StoreResourceView> = {}): StoreResourceView => ({
  name: 'users', path: '/users/:id', idField: 'id', count: 10, remembers: true, detected: true, ...over,
});
const store = (over: Partial<StoreStatus> = {}): StoreStatus => ({
  enabled: true, resources: [res(), res({ name: 'orders', path: '/orders/:id', count: 2 }), res({ name: 'cart', path: '/cart/:id', count: 0 })],
  snapshots: [], changed: false, problems: [], ...over,
});
const col = (over: Partial<CollectionStatus> = {}): CollectionStatus => ({
  id: 'shop-api', overrides: 0, name: 'Shop API', file: 'api/shop.json', format: 'postman', enabled: true,
  unmatched: 'passthrough', endpoints: 10, mocked: 10, noExample: 0, generated: 0, off: 0, unresolved: [],
  origins: ['https://api.shop.example'], problems: [], store: store(), ...over,
});
const withCols = (cols: CollectionStatus[]) => host(initialState(), { type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: cols } });
const items = (id: string, resource: string, offset: number, list: unknown[], total = list.length): HostMsg =>
  ({ type: 'storeItems', id, resource, offset, total, items: list });

describe('storeItems (CONTRACTS §22.10)', () => {
  it('is a known host message', () => {
    expect(isHostMsg({ type: 'storeItems', id: 'a', resource: 'users', offset: 0, total: 0, items: [] })).toBe(true);
  });

  it('offset 0 replaces, a later offset appends after the records kept', () => {
    let s = withCols([col()]);
    s = host(s, items('shop-api', 'users', 0, [{ id: 1 }, { id: 2 }], 4));
    expect(s.storeItems.get(storeItemsKey('shop-api', 'users'))).toEqual({ id: 'shop-api', resource: 'users', total: 4, items: [{ id: 1 }, { id: 2 }] });
    s = host(s, items('shop-api', 'users', 2, [{ id: 3 }, { id: 4 }], 4));
    expect(s.storeItems.get(storeItemsKey('shop-api', 'users'))!.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    // A push for page 2 again never duplicates.
    s = host(s, items('shop-api', 'users', 2, [{ id: 3 }, { id: 5 }], 4));
    expect(s.storeItems.get(storeItemsKey('shop-api', 'users'))!.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 5 }]);
    // The host's push after a change: the first page again.
    s = host(s, items('shop-api', 'users', 0, [{ id: 9 }], 1));
    expect(s.storeItems.get(storeItemsKey('shop-api', 'users'))).toEqual({ id: 'shop-api', resource: 'users', total: 1, items: [{ id: 9 }] });
  });

  it('ignores answers for collections no longer listed, and keeps resources apart', () => {
    let s = withCols([col()]);
    s = host(s, items('gone', 'users', 0, [{ id: 1 }]));
    expect(s.storeItems.size).toBe(0);
    s = host(s, items('shop-api', 'users', 0, [{ id: 1 }]), items('shop-api', 'orders', 0, [{ id: 7 }]));
    expect(s.storeItems.size).toBe(2);
  });

  it('drops records when the collection or the resource goes away', () => {
    let s = withCols([col()]);
    s = host(s, items('shop-api', 'users', 0, [{ id: 1 }]), items('shop-api', 'orders', 0, [{ id: 7 }]));
    s = host(s, { type: 'status', status: { ...status, collections: [col({ store: store({ resources: [res()] }) })] } });
    expect([...s.storeItems.keys()]).toEqual([storeItemsKey('shop-api', 'users')]);
    const same = s.storeItems;
    s = host(s, { type: 'status', status: { ...status, collections: [col({ store: store({ resources: [res()] }) })] } });
    expect(s.storeItems).toBe(same);
    s = host(s, { type: 'status', status: { ...status, collections: [] } });
    expect(s.storeItems.size).toBe(0);
  });

  it('keeps at most 5 000 records and survives hostile values', () => {
    const big = Array.from({ length: 6000 }, (_, i) => ({ id: i }));
    const merged = mergeStoreItems(undefined, { id: 'a', resource: 'r', offset: 0, total: 6000, items: big });
    expect(merged.items).toHaveLength(STORE_VIEW_LIMITS.items);
    expect(merged.total).toBe(6000);
    const odd = mergeStoreItems(undefined, { id: 'a', resource: 'r', offset: -3, total: Number.NaN, items: 'x' as unknown as unknown[] });
    expect(odd).toEqual({ id: 'a', resource: 'r', total: 0, items: [] });
    // storeItemsKey can't collide through separators
    expect(storeItemsKey('a:b', 'c')).not.toBe(storeItemsKey('a', 'b:c'));
  });
});

describe('summary and table helpers (CONTRACTS §22.11)', () => {
  it('"users 10 · orders 2 · cart 0", resources that remember only, six named at most', () => {
    expect(storeSummaryText(store())).toBe('users 10 · orders 2 · cart 0');
    expect(storeSummaryText(store({ resources: [res(), res({ name: 'orders', remembers: false })] }))).toBe('users 10');
    expect(storeSummaryText(store({ resources: [res({ remembers: false })] }))).toBeUndefined();
    const many = Array.from({ length: 9 }, (_, i) => res({ name: `r${i}`, count: i }));
    expect(storeSummaryText(store({ resources: many }))).toBe('r0 0 · r1 1 · r2 2 · r3 3 · r4 4 · r5 5 · 3 more');
    expect(storeSummaryText(store({ resources: [res({ name: 'x'.repeat(500) })] }))!.length).toBeLessThan(80);
  });

  it('columns: top-level scalar keys of the first 50 records, id first, at most eight', () => {
    const recs = [
      { name: 'Ada', id: 1, address: { city: 'X' }, tags: ['a'] },
      { id: 2, email: 'b@x', name: 'Bob' },
    ];
    expect(storeColumns(recs, 'id')).toEqual(['id', 'name', 'email']);
    const wide = [Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))];
    expect(storeColumns(wide, 'k15')).toEqual(['k15', 'k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    const late = Array.from({ length: 60 }, (_, i) => (i === 55 ? { id: i, late: 1 } : { id: i }));
    expect(storeColumns(late, 'id')).toEqual(['id']);
    expect(storeColumns([null, 'x', [1], { __proto__: 1, ok: true }], 'id')).toEqual(['ok']);
  });

  it('cells are plain text: nested as {…} / [n], long strings cut, never a prototype value', () => {
    expect(cellText({ a: 1 })).toBe('{…}');
    expect(cellText([1, 2, 3])).toBe('[3]');
    expect(cellText(null)).toBe('null');
    expect(cellText(false)).toBe('false');
    expect(cellText(undefined)).toBe('');
    expect(cellText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    expect(cellText('a\nb')).toBe('a b');
    expect(cellText('y'.repeat(500))).toHaveLength(STORE_VIEW_LIMITS.cell);
    expect(cellOf({}, 'constructor')).toBe('');
    expect(cellOf({}, 'toString')).toBe('');
    expect(cellOf('str', 'length')).toBe('');
  });

  it('record ids come from the id field (strings and numbers only)', () => {
    expect(recordId({ id: 7 }, 'id')).toBe('7');
    expect(recordId({ userId: 'u-1' }, 'userId')).toBe('u-1');
    expect(recordId({ id: { x: 1 } }, 'id')).toBeUndefined();
    expect(recordId({ id: '' }, 'id')).toBeUndefined();
    expect(recordId({}, 'constructor')).toBeUndefined();
    expect(recordId([1], '0')).toBeUndefined();
  });

  it('the editor text is validated as one JSON object', () => {
    expect(parseRecordText('{"id": 1, "name": "Ada"}')).toEqual({ ok: true, item: { id: 1, name: 'Ada' } });
    expect(parseRecordText('')).toMatchObject({ ok: false });
    expect(parseRecordText('[1]')).toMatchObject({ ok: false, message: expect.stringContaining('JSON object') });
    expect(parseRecordText('42')).toMatchObject({ ok: false });
    expect(parseRecordText('null')).toMatchObject({ ok: false });
    const bad = parseRecordText('{\n  "id": 1,\n}');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.message).toContain('line 3');
    expect(recordText({ id: 1 })).toBe('{\n  "id": 1\n}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(recordText(cyclic)).toBe('{}');
  });

  it('the JSON view is cut at 256 K characters', () => {
    expect(recordsJsonText([{ id: 1 }])).toEqual({ text: '[\n  {\n    "id": 1\n  }\n]', cut: false });
    const big = recordsJsonText(Array.from({ length: 3000 }, (_, i) => ({ id: i, text: 'z'.repeat(100) })));
    expect(big.cut).toBe(true);
    expect(big.text.length).toBe(STORE_VIEW_LIMITS.jsonChars);
  });
});

describe('what the data did for an exchange (CONTRACTS §22.11, detail pane)', () => {
  const cols = [col()];
  it('reads the store note on a Stateful mock answer: "created users 7"', () => {
    const e = ex({ state: 'mocked', matchedRuleId: 'collection:shop-api:4', simulated: 'Stateful mock', notes: ['users: created 7'] });
    expect(storeOpOfExchange(e, cols)).toEqual({ text: 'created users 7', note: 'users: created 7' });
    expect(storeOpOfExchange({ ...e, notes: ['users: listed 12 of 40'] }, cols)!.text).toBe('listed users 12 of 40');
    expect(storeOpOfExchange({ ...e, notes: ['other: x', 'users: 7 not found'] }, cols)!.text).toBe('users 7 not found');
  });

  it('prefers collection.store when the exchange carries it', () => {
    const e = { ...ex({ matchedRuleId: 'collection:shop-api:4', simulated: 'Stateful mock', notes: ['users: deleted 7'] }),
      collection: { store: { resource: 'users', op: 'delete', itemId: '7' } } };
    expect(storeOpOfExchange(e, cols)).toEqual({ text: 'deleted users 7', note: 'users: deleted 7' });
    const list = { ...ex({ matchedRuleId: 'collection:shop-api:4' }), collection: { store: { resource: 'users', op: 'list' } } };
    expect(storeOpOfExchange(list, cols)).toEqual({ text: 'listed users' });
  });

  it('says nothing when it is not a collection data answer', () => {
    expect(storeOpOfExchange(ex({ matchedRuleId: 'collection:shop-api:4', notes: ['users: created 7'] }), cols)).toBeUndefined();
    expect(storeOpOfExchange(ex({ matchedRuleId: 'r1', simulated: 'Stateful mock', notes: ['users: created 7'] }), cols)).toBeUndefined();
    expect(storeOpOfExchange(ex({ matchedRuleId: 'collection:shop-api:4', simulated: 'Stateful mock', notes: ['answered from the example'] }), cols)).toBeUndefined();
    // An unknown resource name isn't read as an operation.
    expect(storeOpOfExchange(ex({ matchedRuleId: 'collection:shop-api:4', simulated: 'Stateful mock', notes: ['mutate: created 3'] }), cols)).toBeUndefined();
    const bogus = { ...ex({ matchedRuleId: 'collection:shop-api:4' }), collection: { store: { resource: 'users', op: 'explode' } } };
    expect(storeOpOfExchange(bogus, cols)).toBeUndefined();
  });
});
