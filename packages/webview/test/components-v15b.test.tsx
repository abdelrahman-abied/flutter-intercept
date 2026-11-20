// @vitest-environment happy-dom
// v0.15.0 (CONTRACTS §21.9): Collections section next to Rules — empty state, collection rows (counts,
// personal on/off, unmatched switch, problems, inline unresolved variables, IDE-confirmed Remove),
// endpoint browser (folders, filter, example picker + generated tag, View example, Edit as a rule),
// and the 501 no-example banner in the detail pane.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { CollectionEndpointView, CollectionStatus, HostMsg, ViewMsg } from '../src/protocol';
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
  const b = Array.from(scope.querySelectorAll('button')).find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
  if (!b) throw new Error(`button ${label} not found`);
  return b as HTMLButtonElement;
};
const maybeButton = (label: string | RegExp, scope: ParentNode = root) =>
  Array.from(scope.querySelectorAll('button')).find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
async function click(el: Element) { await act(() => { (el as HTMLElement).click(); }); }
async function choose(el: Element, value: string) {
  await act(() => { (el as HTMLSelectElement).value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
const sent = () => posted.filter((m) => m.type !== 'ready');
const lastOf = <T extends ViewMsg['type']>(t: T) => sent().filter((m) => m.type === t).at(-1) as Extract<ViewMsg, { type: T }> | undefined;

beforeEach(() => {
  posted = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const shopStatus = (over: Partial<CollectionStatus> = {}): CollectionStatus => ({
  id: 'shop-api',
  overrides: 0,
  name: 'Shop API',
  file: 'api/shop.postman_collection.json',
  format: 'postman',
  enabled: true,
  unmatched: 'passthrough',
  endpoints: 46,
  mocked: 42,
  noExample: 3,
  generated: 0,
  off: 1,
  unresolved: [],
  origins: ['https://api.shop.example'],
  problems: [],
  ...over,
});


const loginEp = (over: Partial<CollectionEndpointView> = {}): CollectionEndpointView => ({
  key: 'POST {{baseUrl}}/auth/login', method: 'POST', name: 'Log in', folder: ['Auth'],
  url: 'https://api.shop.example/auth/login', examples: [{ name: 'Success', status: 200 }, { name: 'Wrong password', status: 401 }],
  ...over,
});
const meEp = (over: Partial<CollectionEndpointView> = {}): CollectionEndpointView => ({
  key: 'GET {{baseUrl}}/users/me', method: 'GET', name: 'Me', folder: ['Users'],
  url: 'https://api.shop.example/users/me', examples: [{ name: 'OK', status: 200 }], ...over,
});
async function showCollections(collections: CollectionStatus[], exchanges = [] as ReturnType<typeof ex>[]) {
  await mount({ view: 'collections' });
  await emit({ type: 'snapshot', exchanges, rules: [], status: { ...status, collections } });
}
const updates = () => sent().filter((m) => m.type === 'updateCollection') as Extract<ViewMsg, { type: 'updateCollection' }>[];

describe('W2: limited answers (CONTRACTS §21.16)', () => {
  it('one calm line with Review & approve; the IDE does the asking', async () => {
    await showCollections([shopStatus({ limited: { reasons: ['sets cookies', 'redirects'], answers: 3 } })]);
    const note = $('.collection-limited')!;
    expect(note.textContent).toContain('Some answers are limited until you approve: sets cookies, redirects');
    expect($('.collection-limited.warn, .collection-limited.error')).toBeNull();
    await click(button('Review & approve', note));
    expect(lastOf('approveCollection')).toEqual({ type: 'approveCollection', id: 'shop-api' });
  });

  it('nothing is shown when no answer is limited', async () => {
    await showCollections([shopStatus()]);
    expect($('.collection-limited')).toBeNull();
    expect(maybeButton('Review & approve')).toBeUndefined();
  });
});

describe('W2: changes for you (CONTRACTS §21.15)', () => {
  it('panel changes are sent for this user only', async () => {
    await showCollections([shopStatus()]);
    await click(button('Fail'));
    expect(updates().at(-1)!.patch).toEqual({ unmatched: 'fail', scope: 'me' });
    await click(button(/^Shop API/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [loginEp(), meEp()] });
    await choose($('.ep-example-select')!, 'Wrong password');
    expect(updates().at(-1)!.patch).toEqual({ example: { endpoint: 'POST {{baseUrl}}/auth/login', name: 'Wrong password' }, scope: 'me' });
    const box = $$('.ep-item')[1].querySelector('input[type="checkbox"]')!;
    await click(box);
    expect(updates().at(-1)!.patch).toEqual({ off: { endpoint: 'GET {{baseUrl}}/users/me', off: true }, scope: 'me' });
  });

  it('"N changes for you" with Reset; an overridden endpoint has its own tag and Reset', async () => {
    await showCollections([shopStatus({ overrides: 2 })]);
    const line = $('.collection-overrides')!;
    expect(line.textContent).toContain('2 changes for you');
    await click(button('Reset', line));
    expect(updates().at(-1)!.patch).toEqual({ reset: true, scope: 'me' });

    await click(button(/^Shop API/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [loginEp({ selected: 'Wrong password', overridden: true }), meEp()] });
    const items = $$('.ep-item');
    expect(items[0].textContent).toContain('changed for you');
    expect(items[1].textContent).not.toContain('changed for you');
    await click(button('Reset', items[0]));
    expect(updates().at(-1)!.patch).toEqual({ reset: true, endpoint: 'POST {{baseUrl}}/auth/login', scope: 'me' });
  });

  it('Save for the team writes each of your changes with scope team, then clears yours', async () => {
    await showCollections([shopStatus({ overrides: 2, unmatched: 'fail' })]);
    await click(button(/^Shop API/));
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [loginEp({ selected: 'Wrong password', overridden: true }), meEp({ off: true, overridden: true }), meEp({ key: 'GET /x', overridden: undefined })] });
    const before = updates().length;
    await click(button('Save for the team'));
    expect(updates().slice(before).map((u) => u.patch)).toEqual([
      { example: { endpoint: 'POST {{baseUrl}}/auth/login', name: 'Wrong password' }, scope: 'team' },
      { off: { endpoint: 'POST {{baseUrl}}/auth/login', off: false }, scope: 'team' },
      { off: { endpoint: 'GET {{baseUrl}}/users/me', off: true }, scope: 'team' },
      { unmatched: 'fail', scope: 'team' },
      { reset: true, scope: 'me' },
    ]);
  });

  it('Save for the team on a closed collection loads its requests first, then saves once', async () => {
    await showCollections([shopStatus({ overrides: 1 })]);
    await click(button('Save for the team'));
    expect(lastOf('getCollectionEndpoints')).toEqual({ type: 'getCollectionEndpoints', id: 'shop-api' });
    expect(updates()).toHaveLength(0);
    expect(button('Save for the team').disabled).toBe(true);
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [loginEp({ selected: 'Wrong password', overridden: true })] });
    expect(updates().map((u) => u.patch.scope)).toEqual(['team', 'team', 'team', 'me']);
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: [loginEp({ selected: 'Wrong password', overridden: true })] });
    expect(updates()).toHaveLength(4);
  });

  it('the words shown never say overlay or scope', async () => {
    await showCollections([shopStatus({ overrides: 1, limited: { reasons: ['redirects'], answers: 1 }, seen: { notInCollection: [{ method: 'GET', path: '/a', count: 1 }], noExample: [] } })]);
    expect(root.textContent!.toLowerCase()).not.toMatch(/overlay|scope/);
  });
});

describe('W2: what the collection is missing (CONTRACTS §21.15 #4)', () => {
  const seen = {
    notInCollection: [{ method: 'GET', path: '/cart/{id}', count: 4 }, { method: 'DELETE', path: '/cart', count: 1 }],
    noExample: [{ endpoint: 'POST {{baseUrl}}/auth/refresh', count: 2 }],
  };

  it('a summary that opens a list; each item has one way to fix it', async () => {
    const listed = ex({ id: 'x-cart', method: 'GET', url: 'https://api.shop.example/cart/77?full=1' });
    const elsewhere = ex({ id: 'x-other', method: 'GET', url: 'https://other.example/cart/77' });
    await showCollections([shopStatus({ seen })], [elsewhere, listed]);
    const summary = button('2 requests not in the collection · 1 answered 501 (no example)');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    await click(summary);
    const items = $$('.collection-seen-list li');
    expect(items.map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'GET /cart/{id} ×4 · not in the collection Mock it with a rule',
      'DELETE /cart ×1 · not in the collection Mock it with a rule',
      'POST {{baseUrl}}/auth/refresh ×2 · answered 501 (no example) Mock it with a rule',
    ]);
    await click(button('Mock it with a rule', items[0]));
    expect(lastOf('createRuleFromExchange')).toEqual({ type: 'createRuleFromExchange', id: 'x-cart', action: 'mock' });
    expect(button('Mock it with a rule', items[1]).disabled).toBe(true);
    await click(button('Mock it with a rule', items[2]));
    expect(lastOf('collectionToRule')).toEqual({ type: 'collectionToRule', id: 'shop-api', endpoint: 'POST {{baseUrl}}/auth/refresh' });
  });

  it('nothing is shown when nothing is missing', async () => {
    await showCollections([shopStatus({ seen: { notInCollection: [], noExample: [] } })]);
    expect($('.collection-seen')).toBeNull();
  });
});

describe('W2: a limited answer in the request details', () => {
  it('one line naming what was left out, with Review & approve while the collection is limited', async () => {
    const limited = ex({
      id: 'lim', method: 'POST', url: 'https://api.shop.example/auth/login', matchedRuleId: 'collection:shop-api:3', state: 'mocked',
      responseHeaders: { 'x-flutter-intercept': 'limited; removed=set-cookie,location', 'content-type': 'application/json' },
    });
    await mount({ view: 'traffic' });
    await emit({ type: 'snapshot', exchanges: [limited], rules: [], status: { ...status, collections: [shopStatus({ limited: { reasons: ['sets cookies'], answers: 1 } })] } });
    await click($('.row')!);
    const note = $('.collection-limited-note')!;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('Limited answer from Shop API: set-cookie, location left out until the collection is approved.');
    await click(button('Review & approve', note));
    expect(lastOf('approveCollection')).toEqual({ type: 'approveCollection', id: 'shop-api' });
  });
});
