// @vitest-environment happy-dom
// v0.16.0 parts 2 and 3 (CONTRACTS §23.2 – §23.4, §24.1 – §24.4), in the panel: "Make a fake backend from this
// session / recording", the "Out of date: …" line, tag and what changed (Update example, Add as a new example,
// Ignore), sign-in (switch, sessions, token lifetime, which requests, Sign everyone out), made-up values, examples
// that answer by what the request sends, the source badges, and the detail pane's "· needs sign-in (no token)".
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type {
  CollectionEndpointView, CollectionStatus, DriftChange, DriftView, HostMsg, StoreAuthStatus, StorePatch, StoreResourceView,
  StoreStatus, ViewMsg,
} from '../src/protocol';
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
const maybeButton = (label: string | RegExp, scope: ParentNode = root) =>
  Array.from(scope.querySelectorAll('button')).find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
const button = (label: string | RegExp, scope: ParentNode = root) => {
  const b = maybeButton(label, scope);
  if (!b) throw new Error(`button ${label} not found`);
  return b as HTMLButtonElement;
};
const byLabel = <T extends HTMLElement = HTMLInputElement>(label: string, scope: ParentNode = root) => {
  const el = scope.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no control labelled ${label}`);
  return el as T;
};
async function click(el: Element) { await act(() => { (el as HTMLElement).click(); }); }
async function type(el: Element, value: string) {
  await act(() => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
}
// As a browser does it: `input` while editing, then `change` when the value is committed.
async function change(el: Element, value: string) {
  await act(() => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => { el.dispatchEvent(new Event('change', { bubbles: true })); });
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
  enabled: true, resources: [res(), res({ name: 'orders', path: '/orders/:id', count: 2 })],
  snapshots: [], changed: false, problems: [], ...over,
});
const auth = (over: Partial<StoreAuthStatus> = {}): StoreAuthStatus => ({
  available: true, enabled: false, login: 'POST /auth/login', refresh: 'POST /auth/refresh', ttlSeconds: 3600,
  protect: 'declared', sessions: 0, problems: [], ...over,
});
const shop = (over: Partial<CollectionStatus> = {}): CollectionStatus => ({
  id: 'shop-api', overrides: 0, name: 'Shop API', file: 'api/shop.postman_collection.json', format: 'postman',
  enabled: true, unmatched: 'passthrough', endpoints: 12, mocked: 12, noExample: 0, generated: 0, off: 0,
  unresolved: [], origins: ['https://api.shop.example'], problems: [], ...over,
});
const ch = (kind: DriftChange['kind'], path: string, from?: string, to?: string): DriftChange =>
  ({ kind, path, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
const drift = (endpoint: string, changes: DriftChange[], st = 200): DriftView =>
  ({ endpoint, status: st, samples: 3, changes, since: 1_700_000_000_000 });

const USER = 'GET {{baseUrl}}/users/:id';
const USERS = 'POST {{baseUrl}}/users';
const userEp = (over: Partial<CollectionEndpointView> = {}): CollectionEndpointView => ({
  key: USER, method: 'GET', name: 'Get user', folder: [], url: 'https://api.shop.example/users/:id',
  examples: [{ name: 'OK', status: 200 }, { name: 'Missing', status: 404 }],
  drift: [drift(USER, [
    ch('added', 'avatar', undefined, 'string'), ch('type', 'age', 'int', 'string'),
    ch('nullable', 'nickname', 'string', 'null'), ch('removed', 'email', 'string'),
  ])],
  ...over,
});
const createEp = (over: Partial<CollectionEndpointView> = {}): CollectionEndpointView => ({
  key: USERS, method: 'POST', name: 'Create user', folder: [], url: 'https://api.shop.example/users',
  examples: [{ name: 'OK', status: 200 }],
  drift: [drift(USERS, [ch('status', '', undefined, '201')], 201)],
  ...over,
});
const listEp: CollectionEndpointView = {
  key: 'GET {{baseUrl}}/users', method: 'GET', name: 'List users', folder: [], url: 'https://api.shop.example/users',
  examples: [{ name: 'OK', status: 200 }],
};
const stale = (over: Partial<CollectionStatus> = {}) =>
  shop({ drift: { endpoints: 2, line: 'GET /users/:id now has avatar (and 4 more)' }, ...over });

async function show(cols: CollectionStatus[], exchanges = [] as ReturnType<typeof ex>[]) {
  await mount({ view: 'collections' });
  await emit({ type: 'snapshot', exchanges, rules: [], status: { ...status, collections: cols } });
}
async function openShop(c = shop(), endpoints?: CollectionEndpointView[]) {
  await show([c]);
  await click(button(/^Shop API/));
  if (endpoints) await emit({ type: 'collectionEndpoints', id: c.id, endpoints });
}
async function openData(c: CollectionStatus) {
  await openShop(c);
  await click(button('Data'));
}

// ------------------------------------------------------------------ a fake backend from traffic (§23.2)

describe('Make a fake backend from this session (CONTRACTS §23.2)', () => {
  it('empty state: next to "Mock from a collection…", and it only asks the IDE', async () => {
    await show([], [ex()]);
    const empty = $('.collection-empty')!;
    expect(maybeButton(/Mock from a collection…/, empty)).toBeTruthy();
    const fake = button('Make a fake backend from this session', empty);
    expect(fake.disabled).toBe(false);
    await click(fake);
    expect(sent()).toEqual([{ type: 'mockFromTraffic', source: 'session' }]);
  });

  it('is disabled, with the reason, until the app has talked to the real server', async () => {
    await show([], [ex({ state: 'mocked' }), ex({ state: 'pending', status: undefined }), ex({ kind: 'websocket' })]);
    const fake = button('Make a fake backend from this session');
    expect(fake.disabled).toBe(true);
    expect(fake.title).toBe('Run the app against the real server first');
    await click(fake);
    expect(all('mockFromTraffic')).toEqual([]);
    await emit({ type: 'exchange', exchange: ex() });
    expect(button('Make a fake backend from this session').disabled).toBe(false);
  });

  it('with collections: in the header menu', async () => {
    await show([shop()], [ex()]);
    expect($('.collection-empty')).toBeNull();
    expect(maybeButton('Make a fake backend from this session')).toBeUndefined();
    await click(button(/^More/));
    const menu = $('[role="menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('More ways to mock');
    await click(button('Make a fake backend from this session', menu));
    expect(lastOf('mockFromTraffic')).toEqual({ type: 'mockFromTraffic', source: 'session' });
    expect($('[role="menu"]')).toBeNull();
  });

  it('header menu: disabled with the reason when nothing finished; Escape still closes it', async () => {
    await show([shop()]);
    const more = button(/^More/);
    await click(more);
    const item = button('Make a fake backend from this session', $('[role="menu"]')!);
    expect(item.disabled).toBe(true);
    expect(item.title).toBe('Run the app against the real server first');
    await key($('[role="menu"]')!, 'Escape');
    expect($('[role="menu"]')).toBeNull();
    expect(all('mockFromTraffic')).toEqual([]);
  });

  it('the header has no menu while there is no collection', async () => {
    await show([], [ex()]);
    expect(maybeButton(/^More/)).toBeUndefined();
  });

  it('the new collection is shown with one result line', async () => {
    await show([shop()], [ex()]);
    await click(button(/^More/));
    await click(button('Make a fake backend from this session'));
    const made = shop({ id: 'shop-recorded', name: 'Shop API (recorded)', mocked: 23, store: store() });
    await emit({ type: 'status', status: { ...status, collections: [shop(), made] } });
    expect($('.notice')!.textContent).toContain('Shop API (recorded) answers 23 requests · remembers users, orders');
    expect($$('.collection-item')).toHaveLength(2);
  });
});

describe('Make a fake backend from this recording (CONTRACTS §23.2)', () => {
  const recs = [
    { id: 'r1', name: 'Checkout', createdAt: 1_700_000_000_000, exchanges: 9, redacted: false },
    { id: 'r2', name: 'Streams only', createdAt: 1_700_000_100_000, exchanges: 0, redacted: false, streams: 2 },
  ];

  it('on each recording row; sends the recording, never a path', async () => {
    await mount({ view: 'recordings' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status }, { type: 'recordings', recordings: recs });
    const rows = $$('.rec-item');
    expect(rows).toHaveLength(2);
    const checkout = rows.find((r) => r.textContent!.includes('Checkout'))!;
    const fake = byLabel<HTMLButtonElement>('Make a fake backend from this recording “Checkout”', checkout);
    expect(fake.textContent!.trim()).toBe('Make a fake backend');
    expect(fake.title).toContain('Make a fake backend from this recording');
    await click(fake);
    expect(sent()).toEqual([{ type: 'mockFromTraffic', source: { recording: 'r1' } }]);
  });

  it('a recording without requests can\'t make one, and says why', async () => {
    await mount({ view: 'recordings' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status }, { type: 'recordings', recordings: recs });
    const fake = byLabel<HTMLButtonElement>('Make a fake backend from this recording “Streams only”');
    expect(fake.disabled).toBe(true);
    expect(fake.title).toBe('This recording has no finished requests');
  });

  it('when the collection arrives, the panel shows it', async () => {
    await mount({ view: 'recordings' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status }, { type: 'recordings', recordings: recs });
    await click(byLabel<HTMLButtonElement>('Make a fake backend from this recording “Checkout”'));
    await emit({ type: 'status', status: { ...status, collections: [shop({ id: 'checkout', name: 'Checkout', mocked: 9 })] } });
    expect($('.collections-view')).toBeTruthy();
    expect($('.notice')!.textContent).toContain('Checkout answers 9 requests');
  });
});

// ------------------------------------------------------------------ out of date (§23.3 / §23.4)

describe('out of date: the collection line (CONTRACTS §23.2)', () => {
  it('one calm line under the counts, closed, also on a collapsed row', async () => {
    await show([stale()]);
    const line = $('.collection-drift')!;
    expect(line.textContent).toBe('Out of date: GET /users/:id now has avatar (and 4 more)');
    const toggle = button(/^Out of date:/, line);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // calm: not a warning, not a banner, and the word "drift" is never shown
    expect($('.collection-drift.warn, .collection-drift .badge.warn, .collection-drift.msg')).toBeNull();
    expect($('.collection-item')!.classList.contains('has-problem')).toBe(false);
    expect(root.textContent!.toLowerCase()).not.toContain('drift');
    expect($('.ood-list')).toBeNull();
  });

  it('no line when nothing is out of date', async () => {
    await show([shop()]);
    expect($('.collection-drift')).toBeNull();
  });

  it('opening it asks for the endpoints once, then lists what changed in plain words', async () => {
    await show([stale()]);
    await click(button(/^Out of date:/));
    expect(all('getCollectionEndpoints')).toEqual([{ type: 'getCollectionEndpoints', id: 'shop-api' }]);
    expect($('.ood-list')!.getAttribute('aria-busy')).toBe('true');
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [listEp, userEp(), createEp()] });
    const list = $('.ood-list')!;
    expect($$('.ood-items > li', list)).toHaveLength(2);
    const user = byLabel<HTMLElement>('What changed in GET /users/:id', list);
    expect($$('.ood-changes li', user).map((li) => li.textContent)).toEqual([
      'avatar — new field', 'age — now text, was a number', 'nickname — can be empty now', 'email — gone',
    ]);
    const create = byLabel<HTMLElement>('What changed in POST /users', list);
    expect($$('.ood-changes li', create).map((li) => li.textContent)).toEqual(['answers 201, no example for it']);
    // the row itself stays closed; opening the row later doesn't ask again
    expect($('.collection-body')).toBeNull();
    await click(button(/^Shop API/));
    expect(all('getCollectionEndpoints')).toHaveLength(1);
  });

  it('Update example: the IDE shows the change and asks; the panel only names the example', async () => {
    await show([stale()]);
    await click(button(/^Out of date:/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [userEp(), createEp()] });
    const user = byLabel<HTMLElement>('What changed in GET /users/:id');
    await click(button('Update example', user));
    expect(lastOf('updateExample')).toEqual({ type: 'updateExample', id: 'shop-api', endpoint: USER, status: 200 });
  });

  it('"Add as a new example" is in the menu (mode add)', async () => {
    await show([stale()]);
    await click(button(/^Out of date:/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [userEp()] });
    const user = byLabel<HTMLElement>('What changed in GET /users/:id');
    const more = byLabel<HTMLButtonElement>('Other ways to update the 200 example of GET /users/:id', user);
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    await click(more);
    expect($$('[role="menuitem"]', user).map((b) => b.textContent)).toEqual(['Add as a new example']);
    await click(button('Add as a new example', user));
    expect(lastOf('updateExample')).toEqual({ type: 'updateExample', id: 'shop-api', endpoint: USER, status: 200, mode: 'add' });
  });

  it('a status with no example: the one action is to add it', async () => {
    await show([stale()]);
    await click(button(/^Out of date:/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [createEp()] });
    const create = byLabel<HTMLElement>('What changed in POST /users');
    expect(maybeButton('Update example', create)).toBeUndefined();
    await click(button('Add as a new example', create));
    expect(lastOf('updateExample')).toEqual({ type: 'updateExample', id: 'shop-api', endpoint: USERS, status: 201, mode: 'add' });
  });

  it('Ignore one, or all of them', async () => {
    await show([stale()]);
    await click(button(/^Out of date:/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [userEp(), createEp()] });
    await click(button('Ignore', byLabel<HTMLElement>('What changed in GET /users/:id')));
    expect(lastOf('ignoreDrift')).toEqual({ type: 'ignoreDrift', id: 'shop-api', endpoint: USER, status: 200 });
    await click(button('Ignore all'));
    expect(lastOf('ignoreDrift')).toEqual({ type: 'ignoreDrift', id: 'shop-api' });
  });

  it('"Ignore all" only when there is more than one', async () => {
    await show([stale()]);
    await click(button(/^Out of date:/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [userEp()] });
    expect(maybeButton('Ignore all')).toBeUndefined();
  });

  it('twenty endpoints, then "and N more"; twenty changes per endpoint, then "and N more"', async () => {
    const eps = Array.from({ length: 27 }, (_, i) => userEp({
      key: `GET {{baseUrl}}/things${i}`, url: `https://api.shop.example/things${i}`,
      drift: [drift(`GET {{baseUrl}}/things${i}`, Array.from({ length: i === 0 ? 26 : 1 }, (_x, j) => ch('added', `field${j}`)))],
    }));
    await show([stale({ drift: { endpoints: 27, line: 'GET /things0 now has field0 (and 51 more)' } })]);
    await click(button(/^Out of date:/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: eps });
    expect($$('.ood-items > li')).toHaveLength(20);
    expect($('.ood-foot')!.textContent).toContain('and 7 more');
    const first = byLabel<HTMLElement>('What changed in GET /things0');
    expect($$('.ood-changes li', first)).toHaveLength(21);
    expect($('.ood-more-changes', first)!.textContent).toBe('and 6 more');
  });

  it('the line closes by itself when the collection is up to date again', async () => {
    await show([stale()]);
    await click(button(/^Out of date:/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [userEp()] });
    expect($('.ood-list')).toBeTruthy();
    await emit({ type: 'status', status: { ...status, collections: [shop()] } });
    expect($('.collection-drift')).toBeNull();
    await emit({ type: 'status', status: { ...status, collections: [stale()] } });
    expect(button(/^Out of date:/).getAttribute('aria-expanded')).toBe('false');
  });

  it('after a reconnect the open line asks for its endpoints again', async () => {
    await show([stale()]);
    await click(button(/^Out of date:/));
    expect(all('getCollectionEndpoints')).toHaveLength(1);
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [stale()] } });
    expect(all('getCollectionEndpoints')).toHaveLength(2);
  });

  it('never shows a value: only names and kinds it knows, as plain text', async () => {
    const hostile = userEp({
      drift: [drift(USER, [
        ch('type', '<img src=x onerror=alert(1)>', 'hunter2-secret', 'eyJhbGciOiJub25lIn0.payload'),
        ch('added', 'token', undefined, 'Bearer abc123'),
      ])],
    });
    await show([stale({ drift: { endpoints: 1, line: '<b>GET /users/:id</b> now has avatar' } })]);
    await click(button(/^Out of date:/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [hostile] });
    const text = $('.collection-item')!.textContent!;
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('abc123');
    expect(text).toContain('<img src=x onerror=alert(1)> — another kind of value now');
    expect(text).toContain('Out of date: <b>GET /users/:id</b> now has avatar');
    expect($('.collection-item img, .collection-item b')).toBeNull();
  });
});

describe('out of date: in Requests (CONTRACTS §23.3)', () => {
  it('a small "out of date" tag on the endpoint; opening it lists the changes with the same actions', async () => {
    await openShop(stale(), [listEp, userEp()]);
    const rows = $$('.ep-item');
    expect($('.ep-drift', rows[0])).toBeNull();
    const tag = $<HTMLButtonElement>('.ep-drift', rows[1])!;
    expect(tag.tagName).toBe('BUTTON');
    expect(tag.textContent!.trim()).toBe('out of date');
    expect(tag.getAttribute('aria-expanded')).toBe('false');
    expect(tag.title).toContain('4 changes');
    expect($('.ood', rows[1])).toBeNull();
    await click(tag);
    expect(tag.getAttribute('aria-expanded')).toBe('true');
    const box = $('.ood', rows[1])!;
    expect($$('.ood-changes li', box).map((li) => li.textContent)).toEqual([
      'avatar — new field', 'age — now text, was a number', 'nickname — can be empty now', 'email — gone',
    ]);
    await click(button('Update example', box));
    expect(lastOf('updateExample')).toEqual({ type: 'updateExample', id: 'shop-api', endpoint: USER, status: 200 });
    await click(button('Ignore', box));
    expect(lastOf('ignoreDrift')).toEqual({ type: 'ignoreDrift', id: 'shop-api', endpoint: USER, status: 200 });
    await click(tag);
    expect($('.ood', rows[1])).toBeNull();
  });

  it('the tag goes when the host says the example is true again', async () => {
    await openShop(stale(), [userEp()]);
    await click($('.ep-drift')!);
    expect($('.ood')).toBeTruthy();
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [userEp({ drift: undefined })] });
    expect($('.ep-drift')).toBeNull();
    expect($('.ood')).toBeNull();
  });
});

// ------------------------------------------------------------------ sign-in (§24.1)

describe('sign-in, on the Data side (CONTRACTS §24.1)', () => {
  it('off: one row with a switch, and nothing else', async () => {
    await openData(shop({ store: store({ auth: auth() }) }));
    const row = $('.store-auth')!;
    expect(row.textContent).toBe('Sign-in: off — any login is accepted when onNo password is checked or kept.');
    const sw = byLabel('Sign-in for Shop API, for me', row);
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(false);
    expect($('.store-auth-switch', row)!.title).toContain('No password is checked or kept.');
    expect(document.getElementById(sw.getAttribute('aria-describedby')!)!.textContent).toBe('No password is checked or kept.');
    expect(maybeButton('Sign everyone out', row)).toBeUndefined();
    await click(sw);
    expect(patches()).toEqual([{ auth: { enabled: true }, scope: 'me' }]);
  });

  it('on: how many are signed in, how long tokens last, which requests need one', async () => {
    await openData(shop({ store: store({ auth: auth({ enabled: true, sessions: 2 }) }) }));
    const row = $('.store-auth')!;
    expect(row.textContent).toContain('Sign-in: on — any login is accepted');
    expect($('.store-auth-sessions', row)!.textContent!.replace(/\s+/g, ' ')).toBe('Signed in: 2 sessions · tokens last s');
    const ttl = byLabel('Seconds a token lasts in Shop API, for me', row);
    expect(ttl.type).toBe('number');
    expect(ttl.value).toBe('3600');
    expect(ttl.min).toBe('60');
    expect(ttl.max).toBe('86400');
    const group = byLabel<HTMLElement>('Requests that need a token in Shop API, for me', row);
    expect($$('button', group).map((b) => [b.textContent!.trim(), b.getAttribute('aria-pressed')])).toEqual([
      ['those the collection marks', 'true'], ['all', 'false'],
    ]);
    await click(byLabel('Sign-in for Shop API, for me', row));
    expect(patches()).toEqual([{ auth: { enabled: false }, scope: 'me' }]);
  });

  it('the token lifetime is sent for me when committed, kept within 60 – 86 400', async () => {
    await openData(shop({ store: store({ auth: auth({ enabled: true }) }) }));
    const ttl = byLabel('Seconds a token lasts in Shop API, for me');
    await type(ttl, '900');
    expect(patches()).toEqual([]);
    await key(ttl, 'Enter');
    expect(patches()).toEqual([{ auth: { ttlSeconds: 900 }, scope: 'me' }]);
    await change(ttl, '5');
    expect(patches().at(-1)).toEqual({ auth: { ttlSeconds: 60 }, scope: 'me' });
    expect(ttl.value).toBe('60');
    await change(ttl, '9999999');
    expect(patches().at(-1)).toEqual({ auth: { ttlSeconds: 86_400 }, scope: 'me' });
  });

  it('nonsense, or the same number, sends nothing and puts the old value back; Escape too', async () => {
    await openData(shop({ store: store({ auth: auth({ enabled: true }) }) }));
    const ttl = byLabel('Seconds a token lasts in Shop API, for me');
    await change(ttl, '');
    await change(ttl, '3600');
    expect(patches()).toEqual([]);
    expect(ttl.value).toBe('3600');
    await type(ttl, '120');
    await key(ttl, 'Escape');
    expect(ttl.value).toBe('3600');
    expect(patches()).toEqual([]);
  });

  it('which requests need a token', async () => {
    await openData(shop({ store: store({ auth: auth({ enabled: true }) }) }));
    await click(button('those the collection marks'));
    expect(patches()).toEqual([]);
    await click(button('all', $('.store-auth-protect')!));
    expect(patches()).toEqual([{ auth: { protect: 'all' }, scope: 'me' }]);
  });

  it('Sign everyone out changes the data, not a setting (no scope)', async () => {
    await openData(shop({ store: store({ auth: auth({ enabled: true, sessions: 3 }) }) }));
    await click(button('Sign everyone out'));
    expect(patches()).toEqual([{ auth: { expire: 'all' } }]);
  });

  it('problems are quiet lines; a token or a password is never shown', async () => {
    await openData(shop({ store: store({ auth: auth({ enabled: true, problems: ['POST /auth/login has no 2xx example to answer with'] }) }) }));
    const row = $('.store-auth')!;
    expect($$('.store-problem', row).map((p) => p.textContent)).toEqual(['POST /auth/login has no 2xx example to answer with']);
    expect($('.store-auth .msg.warn, .store-auth .badge.warn, .store-auth [role="alert"]')).toBeNull();
    expect($('.store-auth input[type="password"]')).toBeNull();
  });

  it('not shown when the collection has no login request', async () => {
    await openData(shop({ store: store({ auth: auth({ available: false }) }) }));
    expect($('.store-auth')).toBeNull();
    await emit({ type: 'status', status: { ...status, collections: [shop({ store: store() })] } });
    expect($('.store-auth')).toBeNull();
  });

  it('a collection with sign-in but no data still has a Data side', async () => {
    await openData(shop({ store: store({ resources: [], auth: auth() }) }));
    expect($('.store-auth')).toBeTruthy();
    expect($('.store-line')).toBeNull();
  });
});

// ------------------------------------------------------------------ made-up values (§24.3)

describe('made-up values, on the Data side (CONTRACTS §24.3)', () => {
  it('a small select, sent for me', async () => {
    await openData(shop({ store: store({ dynamic: 'random' }) }));
    const row = $('.store-dynamic')!;
    expect(row.textContent).toContain('Made-up values ({{$random…}}):');
    const select = byLabel<HTMLSelectElement>('Made-up values in Shop API, for me', row);
    expect($$('option', select).map((o) => [(o as HTMLOptionElement).value, o.textContent])).toEqual([
      ['random', 'New every time'], ['seeded', 'Same every run'], ['fixed', 'Fixed'],
    ]);
    expect(select.value).toBe('random');
    await change(select, 'seeded');
    expect(patches()).toEqual([{ dynamic: 'seeded', scope: 'me' }]);
    await change(select, 'random');
    expect(patches()).toHaveLength(1);
  });

  it('only when the collection has such values', async () => {
    await openData(shop({ store: store() }));
    expect($('.store-dynamic')).toBeNull();
  });
});

describe('changed for you: Save for the team carries sign-in and made-up values (CONTRACTS §22.7 / §24.1)', () => {
  it('re-sends them for the team, then resets mine', async () => {
    await openData(shop({ store: store({
      overridden: true, dynamic: 'fixed', auth: auth({ enabled: true, ttlSeconds: 900, protect: 'all', sessions: 5 }),
    }) }));
    const line = $('.store-overrides')!;
    expect(line.textContent).toContain('Data settings changed for you');
    await click(button('Save for the team', line));
    const want: StorePatch[] = [
      { enabled: true, startsFrom: null, auth: { enabled: true, ttlSeconds: 900, protect: 'all' }, dynamic: 'fixed', scope: 'team' },
      { reset: 'settings', scope: 'me' },
    ];
    expect(patches()).toEqual(want);
    // nothing about who is signed in ever goes to the team's file
    expect(JSON.stringify(patches())).not.toContain('sessions');
    expect(JSON.stringify(patches())).not.toContain('expire');
  });
});

// ------------------------------------------------------------------ examples by body (§24.2), formats (§24.4)

describe('examples that answer by what the request sends (CONTRACTS §24.2)', () => {
  const login: CollectionEndpointView = {
    key: 'POST {{baseUrl}}/auth/login', method: 'POST', name: 'Login', folder: [], url: 'https://api.shop.example/auth/login',
    examples: [
      { name: 'OK', status: 200 },
      { name: 'Wrong password', status: 401, byBody: ['password'] },
      { name: 'Locked', status: 423, byBody: ['email', 'password', 'device', 'otp', 'pin'] },
    ],
  };

  it('the picker says when each one answers: field names only, three then "and N more"', async () => {
    await openShop(shop(), [login, listEp]);
    const select = byLabel<HTMLSelectElement>('Example for POST Login');
    expect($$('option', select).map((o) => o.textContent)).toEqual([
      'OK (200)',
      "Wrong password (401) · answers when the request's password matches",
      "Locked (423) · answers when the request's email, password, device and 2 more match",
    ]);
    const rows = $$('.ep-item');
    expect($('.ep-by-body', rows[0])!.textContent)
      .toBe("“Wrong password” answers when the request's password matches · “Locked” answers when the request's email, password, device and 2 more match");
    expect($('.ep-by-body', rows[1])).toBeNull();
  });
});

describe('where a collection came from (CONTRACTS §24.4)', () => {
  it('a badge for each source', async () => {
    const formats = ['postman', 'openapi', 'swagger', 'insomnia', 'bruno'] as const;
    await show(formats.map((f) => shop({ id: f, name: f, format: f })));
    expect($$('.collection-format').map((b) => b.textContent)).toEqual(['Postman', 'OpenAPI', 'Swagger 2.0', 'Insomnia', 'Bruno']);
  });

  it('no badge for a source the panel doesn\'t know', async () => {
    await show([shop({ format: undefined }), shop({ id: 'x', format: 'har' as unknown as 'bruno' })]);
    expect($('.collection-format')).toBeNull();
  });
});

// ------------------------------------------------------------------ detail pane (§24.1)

describe('detail pane: what sign-in did (CONTRACTS §24.1)', () => {
  const answered = (notes: string[], over: Parameters<typeof ex>[0] = {}) =>
    ex({ id: 'a1', url: 'https://api.shop.example/orders', state: 'mocked', status: 401, matchedRuleId: 'collection:shop-api:3', notes, ...over });
  async function detail(e: ReturnType<typeof ex>) {
    await mount();
    await emit({ type: 'snapshot', exchanges: [e], rules: [], status: { ...status, collections: [shop({ store: store({ auth: auth({ enabled: true }) }) })] } });
    await click($('.row')!);
    return $('.detail-facts')!.textContent!;
  }

  it('"Answered by collection Shop API · needs sign-in (no token)", one line, no second banner', async () => {
    const facts = await detail(answered(['auth: 401 no token']));
    expect(facts).toContain('Answered by collection “Shop API” · needs sign-in (no token)');
    expect($('.exchange-notes')).toBeNull();
    expect($('.no-example-banner')).toBeNull();
    expect(root.textContent).not.toContain('auth: 401');
  });

  it('token expired / signed in / token refreshed', async () => {
    expect(await detail(answered(['auth: 401 expired']))).toContain('collection “Shop API” · token expired');
    render(null, root);
    expect(await detail(answered(['auth: signed in'], { status: 200 }))).toContain('collection “Shop API” · signed in');
    render(null, root);
    expect(await detail(answered(['auth: refreshed'], { status: 200 }))).toContain('collection “Shop API” · token refreshed');
  });

  it('sits with what the data did, and other notes stay notes', async () => {
    const more = 'auth: more than 1000 sessions, the oldest were dropped';
    const facts = await detail(answered(['auth: signed in', 'sessions: created 7', more], { status: 201, simulated: 'Stateful mock', method: 'POST' }));
    expect(facts).toContain('Answered by collection “Shop API” · signed in');
    expect($$('.exchange-notes li').map((li) => li.textContent)).toEqual(['sessions: created 7', more]);
  });
});
