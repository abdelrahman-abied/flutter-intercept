// @vitest-environment happy-dom
// v0.16.0 (CONTRACTS §22.11): data a collection remembers, in the panel — the one line (Reset data, Snapshots ▾,
// starts from a snapshot), the Requests | Data switch, resources (remembers, id field, tags, "changed for you"),
// the records table (filter, Show more, JSON view, Edit / Delete / Add), and the detail pane's
// "Answered by collection … · created users 7".
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { CollectionEndpointView, CollectionStatus, HostMsg, StorePatch, StoreResourceView, StoreStatus, ViewMsg } from '../src/protocol';
import { ex, status } from './fixtures';

let root: HTMLElement;
let posted: ViewMsg[];
let listener: ((m: HostMsg) => void) | undefined;

function host(persisted?: unknown): Host {
  return {
    post: (m) => { posted.push(m); },
    getState: <T,>() => persisted as T | undefined,
    setState: () => {},
    onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
  };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function mount(persisted?: unknown) { await act(() => { render(<App host={host(persisted)} />, root); }); }
async function emit(...msgs: HostMsg[]) {
  await act(async () => { for (const m of msgs) listener!(m); await tick(); });
}
const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = root) => scope.querySelector(sel) as T | null;
const $$ = (sel: string, scope: ParentNode = root) => Array.from(scope.querySelectorAll(sel));
const button = (label: string | RegExp, scope: ParentNode = root) => {
  const b = maybeButton(label, scope);
  if (!b) throw new Error(`button ${label} not found`);
  return b as HTMLButtonElement;
};
const maybeButton = (label: string | RegExp, scope: ParentNode = root) =>
  Array.from(scope.querySelectorAll('button')).find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
const byLabel = <T extends HTMLElement = HTMLInputElement>(label: string, scope: ParentNode = root) => {
  const el = scope.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no control labelled ${label}`);
  return el as T;
};
async function click(el: Element) { await act(() => { (el as HTMLElement).click(); }); }
async function type(el: Element, value: string) {
  await act(() => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function key(el: Element, k: string) {
  await act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
}
const sent = () => posted.filter((m) => m.type !== 'ready');
const all = <T extends ViewMsg['type']>(t: T) => sent().filter((m) => m.type === t) as Extract<ViewMsg, { type: T }>[];
const lastOf = <T extends ViewMsg['type']>(t: T) => all(t).at(-1);
const patches = () => all('updateStore').map((m) => m.patch);

beforeEach(() => {
  posted = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const res = (over: Partial<StoreResourceView> = {}): StoreResourceView => ({
  name: 'users', path: '/users/:id', idField: 'id', count: 10, remembers: true, detected: true, ...over,
});
const store = (over: Partial<StoreStatus> = {}): StoreStatus => ({
  enabled: true,
  resources: [res(), res({ name: 'orders', path: '/orders/:id', count: 2 }), res({ name: 'cart', path: '/cart/:id', count: 0 })],
  snapshots: ['checkout', 'empty-cart'], changed: true, problems: [], ...over,
});
const shop = (over: Partial<CollectionStatus> = {}): CollectionStatus => ({
  id: 'shop-api', overrides: 0, name: 'Shop API', file: 'api/shop.postman_collection.json', format: 'postman',
  enabled: true, unmatched: 'passthrough', endpoints: 12, mocked: 12, noExample: 0, generated: 0, off: 0,
  unresolved: [], origins: ['https://api.shop.example'], problems: [], store: store(), ...over,
});
const usersEp: CollectionEndpointView = {
  key: 'GET {{baseUrl}}/users', method: 'GET', name: 'List users', folder: [], url: 'https://api.shop.example/users',
  examples: [{ name: 'OK', status: 200 }],
};

async function openShop(c = shop()) {
  await mount({ view: 'collections' });
  await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [c] } });
  await click(button(/^Shop API/));
}
async function openData(c = shop()) {
  await openShop(c);
  await click(button('Data'));
}
const users = [
  { id: 1, name: 'Ada', email: 'ada@example.com', address: { city: 'London' }, roles: ['admin', 'dev'] },
  { id: 2, name: 'Bob', email: 'bob@example.com', address: { city: 'Paris' }, roles: [] },
];
async function openUsers(c = shop()) {
  await openData(c);
  await click(byLabel<HTMLButtonElement>('Show the users records'));
  await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 2, items: users });
}

describe('the one line (CONTRACTS §22.11)', () => {
  it('says what is remembered, only when the row is open, with Reset data and Snapshots', async () => {
    await mount({ view: 'collections' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [shop()] } });
    expect($('.store-line')).toBeNull();
    await click(button(/^Shop API/));
    const line = $('.store-line')!;
    expect(line.textContent).toContain('Remembers what the app sends: users 10 · orders 2 · cart 0');
    // calm: no warning styles, no banner
    expect($('.store-line.warn, .store-line.error, .msg.warn.store-line')).toBeNull();
    await click(button('Reset data', line));
    expect(lastOf('updateStore')).toEqual({ type: 'updateStore', id: 'shop-api', patch: { reset: 'data' } });
  });

  it('Reset data is disabled, with a reason, when nothing changed', async () => {
    await openShop(shop({ store: store({ changed: false }) }));
    const reset = button('Reset data');
    expect(reset.disabled).toBe(true);
    expect(reset.title).toBe('Nothing has changed since it started');
  });

  it('Snapshots: Save asks the IDE for a name; Load sends the name', async () => {
    await openShop();
    await click(button(/Snapshots/));
    const menu = $('[role="menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('Snapshots of Shop API');
    expect($$('[role="menuitem"]', menu).map((b) => b.textContent)).toEqual([
      'Save…', 'Load › checkout', 'Load › empty-cart', 'Delete › checkout…', 'Delete › empty-cart…',
    ]);
    await click(button('Save…', menu));
    expect(lastOf('storeSnapshot')).toEqual({ type: 'storeSnapshot', id: 'shop-api', action: 'save' });
    await click(button(/Snapshots/));
    await click(button('Load › checkout'));
    expect(lastOf('storeSnapshot')).toEqual({ type: 'storeSnapshot', id: 'shop-api', action: 'load', name: 'checkout' });
  });

  it('Delete asks inside the panel first (never confirm())', async () => {
    await openShop();
    await click(button(/Snapshots/));
    await click(button('Delete › empty-cart…'));
    expect(all('storeSnapshot')).toHaveLength(0);
    const ask = $('.store-confirm')!;
    expect(ask.textContent).toContain('Delete snapshot “empty-cart”?');
    await click(button('Cancel', ask));
    expect($('.store-confirm')).toBeNull();
    expect(all('storeSnapshot')).toHaveLength(0);
    await click(button(/Snapshots/));
    await click(button('Delete › empty-cart…'));
    await click(button('Delete', $('.store-confirm')!));
    expect(lastOf('storeSnapshot')).toEqual({ type: 'storeSnapshot', id: 'shop-api', action: 'delete', name: 'empty-cart' });
    expect($('.store-confirm')).toBeNull();
  });

  it('shows where the data starts from, and goes back to the examples for me', async () => {
    await openShop(shop({ store: store({ startsFrom: 'checkout' }) }));
    expect($('.store-line')!.textContent).toContain('starts from snapshot “checkout”');
    await click(button('Start from the examples'));
    expect(lastOf('updateStore')!.patch).toEqual({ startsFrom: null, scope: 'me' });
  });

  it('when data is not remembered: one line and one action', async () => {
    await openShop(shop({ store: store({ enabled: false }) }));
    const line = $('.store-line')!;
    expect(line.textContent).toContain("what the app sends isn't remembered");
    expect(maybeButton('Reset data')).toBeUndefined();
    await click(button('Remember data', line));
    expect(lastOf('updateStore')!.patch).toEqual({ enabled: true, scope: 'me' });
  });

  it('nothing at all for a collection without remembered data (0.15 look)', async () => {
    await openShop(shop({ store: undefined }));
    expect($('.store-line')).toBeNull();
    expect(maybeButton('Data')).toBeUndefined();
    await openShop(shop({ store: store({ resources: [] }) }));
    expect($('.store-line')).toBeNull();
  });
});

describe('Requests | Data (CONTRACTS §22.11)', () => {
  it('Requests is the endpoints view; Data lists the resources', async () => {
    await openShop();
    expect(button('Requests').getAttribute('aria-pressed')).toBe('true');
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [usersEp] });
    expect($('.ep-item')).not.toBeNull();
    await click(button('Data'));
    expect(button('Data').getAttribute('aria-pressed')).toBe('true');
    expect($('.ep-item')).toBeNull();
    const list = $('ul[aria-label="Data in Shop API"]')!;
    const rows = $$('.store-res', list);
    expect(rows.map((r) => $('.store-res-name', r)!.textContent)).toEqual(['users', 'orders', 'cart']);
    expect(rows[0].textContent).toContain('/users/:id');
    expect(rows[0].textContent).toContain('10 records');
    expect(rows[2].textContent).toContain('0 records');
    await click(button('Requests'));
    expect($('.ep-item')).not.toBeNull();
  });

  it('settings are for me: remembers switch, id field, whole-store switch', async () => {
    await openData();
    await click(byLabel('orders remembers what the app sends, for me'));
    expect(patches().at(-1)).toEqual({ resource: 'orders', remembers: false, scope: 'me' });

    const id = byLabel('Id field of users, for me');
    expect(id.value).toBe('id');
    await type(id, ' userId ');
    await key(id, 'Enter');
    expect(patches().at(-1)).toEqual({ resource: 'users', idField: 'userId', scope: 'me' });
    // Escape puts the current value back; an empty value is never sent.
    const before = patches().length;
    await type(id, '');
    await key(id, 'Enter');
    expect(patches()).toHaveLength(before);
    expect(id.value).toBe('id');
    await type(id, 'zzz');
    await key(id, 'Escape');
    expect(id.value).toBe('id');

    await click(byLabel('Remember what the app sends to Shop API, for me'));
    expect(patches().at(-1)).toEqual({ enabled: false, scope: 'me' });
  });

  it('tags: changed for you, made up from the schema, and problems as quiet lines', async () => {
    await openData(shop({ store: store({
      resources: [
        res({ overridden: true, idField: 'userId' }),
        res({ name: 'products', path: '/products/:id', generatedSeed: true, problem: 'products: 3 records were too big and were left out' }),
      ],
      problems: ['reports: set its id field to make it remember'],
    }) }));
    const [u, p] = $$('.store-res');
    expect(u.textContent).toContain('changed for you');
    expect(p.textContent).not.toContain('changed for you');
    expect(p.textContent).toContain('made up from the schema');
    expect($('.store-problem', p)!.textContent).toBe('products: 3 records were too big and were left out');
    expect($$('.store-body > .store-problem').map((e) => e.textContent)).toEqual(['reports: set its id field to make it remember']);
    expect($('.store-body .msg.warn, .store-body .badge.warn')).toBeNull();
  });

  it('settings changed for you: Reset, and Save for the team re-sends them for the team then resets mine', async () => {
    await openData(shop({ store: store({
      overridden: true,
      resources: [res({ overridden: true, idField: 'userId' }), res({ name: 'orders', remembers: false, overridden: true }), res({ name: 'cart' })],
    }) }));
    const line = $('.store-overrides')!;
    expect(line.textContent).toContain('Data settings changed for you');
    await click(button('Reset', line));
    expect(patches().at(-1)).toEqual({ reset: 'settings', scope: 'me' });
    posted = [];
    await click(button('Save for the team', line));
    const want: StorePatch[] = [
      { enabled: true, startsFrom: null, scope: 'team' },
      { resource: 'users', remembers: true, idField: 'userId', scope: 'team' },
      { resource: 'orders', remembers: false, idField: 'id', scope: 'team' },
      { reset: 'settings', scope: 'me' },
    ];
    expect(patches()).toEqual(want);
  });

  it('the settings line is not shown when nothing is changed for you', async () => {
    await openData();
    expect($('.store-overrides')).toBeNull();
  });
});

describe('records table (CONTRACTS §22.11)', () => {
  it('selecting a resource asks for its first page and shows a table of scalar columns', async () => {
    await openData();
    await click(byLabel<HTMLButtonElement>('Show the users records'));
    expect(lastOf('getStoreItems')).toEqual({ type: 'getStoreItems', id: 'shop-api', resource: 'users', offset: 0 });
    expect($('.store-table-box')!.textContent).toContain('Loading users');
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 2, items: users });
    const heads = $$('.store-table th').map((th) => th.textContent);
    expect(heads).toEqual(['id', 'name', 'email', 'Actions']);
    const cells = $$('.store-table tbody tr')[0].querySelectorAll('td');
    expect(Array.from(cells).slice(0, 3).map((c) => c.textContent)).toEqual(['1', 'Ada', 'ada@example.com']);
    expect($('.store-count')!.textContent).toBe('2 records');
    // The id field picker offers the record's fields.
    expect($$('datalist option').map((o) => (o as HTMLOptionElement).value)).toEqual(['id', 'name', 'email']);
  });

  it('record values are plain text, never HTML', async () => {
    await openData();
    await click(byLabel<HTMLButtonElement>('Show the users records'));
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 1,
      items: [{ id: 1, name: '<img src=x onerror="window.__pwned=1">' }] });
    expect($('.store-table img')).toBeNull();
    expect($$('.store-table td')[1].textContent).toBe('<img src=x onerror="window.__pwned=1">');
  });

  it('nested values show as {…} / [n] in the JSON-less table, and the JSON view shows them whole', async () => {
    await openData();
    await click(byLabel<HTMLButtonElement>('Show the users records'));
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 1,
      items: [{ id: 1, name: { first: 'Ada' }, tags: ['a', 'b'] }, { id: 2, name: 'Bob', tags: 'x' }] });
    const first = $$('.store-table tbody tr')[0].querySelectorAll('td');
    expect(Array.from(first).slice(0, 3).map((c) => c.textContent)).toEqual(['1', '{…}', '[2]']);
    await click(button('JSON'));
    expect($('.store-table')).toBeNull();
    expect($('.store-json')!.textContent).toContain('"first": "Ada"');
    await click(button('Table'));
    expect($('.store-table')).not.toBeNull();
  });

  it('the filter is debounced and asks the host from the first page', async () => {
    await openUsers();
    posted = [];
    const box = byLabel('Filter users records');
    await type(box, 'a');
    await type(box, 'ad');
    await type(box, 'ada');
    expect(all('getStoreItems')).toHaveLength(0);
    await act(async () => { await tick(300); });
    expect(all('getStoreItems')).toEqual([{ type: 'getStoreItems', id: 'shop-api', resource: 'users', offset: 0, filter: 'ada' }]);
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 1, items: [users[0]] });
    expect($('.store-count')!.textContent).toBe('1 matching');
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 0, items: [] });
    expect($('.store-empty')!.textContent).toContain('No users records match “ada”');
    await type(box, '');
    await act(async () => { await tick(300); });
    expect(all('getStoreItems').at(-1)).toEqual({ type: 'getStoreItems', id: 'shop-api', resource: 'users', offset: 0 });
  });

  it('Show more renders the next rows, then asks for the next page', async () => {
    await openData();
    await click(byLabel<HTMLButtonElement>('Show the users records'));
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `u${from + i}` }));
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 400, items: page(0, 200) });
    expect($$('.store-table tbody tr')).toHaveLength(50);
    posted = [];
    await click(button(/Show more/));
    expect($$('.store-table tbody tr')).toHaveLength(150);
    expect(all('getStoreItems')).toHaveLength(0);
    await click(button(/Show more/));
    expect(lastOf('getStoreItems')).toEqual({ type: 'getStoreItems', id: 'shop-api', resource: 'users', offset: 200 });
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 200, total: 400, items: page(200, 200) });
    expect($$('.store-table tbody tr')).toHaveLength(250);
    expect(button(/Show more/).textContent).toContain('150 more');
  });

  it('a host push (data changed) replaces the rows in place', async () => {
    await openUsers();
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 3,
      items: [...users, { id: 3, name: 'Cy', email: 'cy@example.com' }] });
    expect($$('.store-table tbody tr')).toHaveLength(3);
    expect($('.store-count')!.textContent).toBe('3 records');
  });

  it('Edit: the record as JSON, validated before it is sent', async () => {
    await openUsers();
    await click(byLabel<HTMLButtonElement>('Edit users 1'));
    const text = byLabel<HTMLTextAreaElement>('JSON of users 1');
    expect(JSON.parse(text.value)).toEqual(users[0]);
    await type(text, '{"id": 1, "name": "Ada L",}');
    await click(button('Save'));
    expect(all('updateStore')).toHaveLength(0);
    expect($('.store-editor-error')!.textContent).toContain('Not valid JSON (line 1');
    await type(text, '[1, 2]');
    await click(button('Save'));
    expect($('.store-editor-error')!.textContent).toContain('JSON object');
    expect(all('updateStore')).toHaveLength(0);
    await type(text, '{"id": 1, "name": "Ada L"}');
    await click(button('Save'));
    expect(lastOf('updateStore')).toEqual({ type: 'updateStore', id: 'shop-api', patch: { resource: 'users', put: { item: { id: 1, name: 'Ada L' } } } });
    expect($('.store-editor')).toBeNull();
  });

  it('Escape closes the editor without sending', async () => {
    await openUsers();
    await click(byLabel<HTMLButtonElement>('Edit users 2'));
    await key(byLabel('JSON of users 2'), 'Escape');
    expect($('.store-editor')).toBeNull();
    expect(all('updateStore')).toHaveLength(0);
  });

  it('Add starts from {} and Delete removes by id', async () => {
    await openUsers();
    await click(button('Add'));
    const text = byLabel<HTMLTextAreaElement>('JSON of the new users record');
    expect(text.value).toBe('{}');
    await type(text, '{"name": "Cy"}');
    await click(button('Add', $('.store-editor')!));
    expect(lastOf('updateStore')!.patch).toEqual({ resource: 'users', put: { item: { name: 'Cy' } } });
    await click(byLabel<HTMLButtonElement>('Delete users 2'));
    expect(lastOf('updateStore')!.patch).toEqual({ resource: 'users', remove: { itemId: '2' } });
  });

  it('a record without its id field cannot be deleted from the table', async () => {
    await openData();
    await click(byLabel<HTMLButtonElement>('Show the users records'));
    await emit({ type: 'storeItems', id: 'shop-api', resource: 'users', offset: 0, total: 1, items: [{ name: 'no id' }] });
    expect(byLabel<HTMLButtonElement>('Delete users row 1').disabled).toBe(true);
  });

  it('a reconnect asks again for the open resource', async () => {
    await openUsers();
    posted = [];
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [shop()] } });
    expect(all('getStoreItems')).toEqual([{ type: 'getStoreItems', id: 'shop-api', resource: 'users', offset: 0 }]);
  });

  it('names from the file are cut at 200 characters', async () => {
    const long = 'r'.repeat(400);
    await openData(shop({ store: store({ resources: [res({ name: long })] }) }));
    expect($('.store-res-name')!.textContent!.length).toBe(200);
    expect($('.store-line')!.textContent!.length).toBeLessThan(200);
  });
});

describe('detail pane: what the data did (CONTRACTS §22.11)', () => {
  it('"Answered by collection Shop API · created users 7", one line, no second banner', async () => {
    const created = ex({
      id: 'st1', method: 'POST', url: 'https://api.shop.example/users', state: 'mocked', status: 201,
      matchedRuleId: 'collection:shop-api:3', simulated: 'Stateful mock', notes: ['users: created 7'],
    });
    await mount();
    await emit({ type: 'snapshot', exchanges: [created], rules: [], status: { ...status, collections: [shop()] } });
    await click($('.row')!);
    const facts = $('.detail-facts')!;
    expect(facts.textContent).toContain('Answered by collection “Shop API” · created users 7');
    expect($('.detail .sim-badge')).toBeNull();
    expect($('.exchange-notes')).toBeNull();
    expect($('.no-example-banner')).toBeNull();
  });

  it('an ordinary collection answer keeps the 0.15 line; other notes stay', async () => {
    const plain = ex({ id: 'st2', state: 'mocked', matchedRuleId: 'collection:shop-api:1', notes: ['answered from the example'] });
    await mount();
    await emit({ type: 'snapshot', exchanges: [plain], rules: [], status: { ...status, collections: [shop()] } });
    await click($('.row')!);
    expect($('.detail-facts')!.textContent).toContain('collection “Shop API”');
    expect($('.detail-facts')!.textContent).not.toContain('Answered by');
    expect($('.exchange-notes')!.textContent).toContain('answered from the example');
  });
});
