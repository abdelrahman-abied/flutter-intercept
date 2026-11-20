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
import type { CollectionEndpointView, CollectionStatus, HostMsg, Status, ViewMsg } from '../src/protocol';
import { ex, rule, status } from './fixtures';

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
async function type(el: Element, value: string) {
  await act(() => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(el: Element, value: string) {
  await act(() => { (el as HTMLSelectElement).value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function key(el: Element, k: string) {
  await act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
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

const shopEndpoints: CollectionEndpointView[] = [
  {
    key: 'POST {{baseUrl}}/auth/login',
    method: 'POST',
    name: 'Log in',
    folder: ['Auth'],
    url: 'https://api.shop.example/auth/login',
    examples: [{ name: 'Success', status: 200 }, { name: 'Wrong password', status: 401 }],
  },
  {
    key: 'POST {{baseUrl}}/auth/refresh',
    method: 'POST',
    name: 'Refresh',
    folder: ['Auth'],
    url: 'https://api.shop.example/auth/refresh',
    examples: [],
  },
  {
    key: 'GET {{baseUrl}}/users/:id',
    method: 'GET',
    name: 'User by id',
    folder: ['Users'],
    url: 'https://api.shop.example/users/:id',
    examples: [{ name: '200', status: 200, generated: true }],
  },
  {
    key: 'GET {{baseUrl}}/{{apiVersion}}/orders/{{orderId}}/items',
    method: 'GET',
    name: 'Order items',
    folder: ['Users', 'Orders'],
    url: 'https://api.shop.example/v2/orders/:orderId/items',
    examples: [{ name: 'OK', status: 200 }],
    off: true,
  },
  {
    key: 'POST {{analyticsHost}}/collect',
    method: 'POST',
    name: 'Analytics',
    folder: [],
    url: '{{analyticsHost}}/collect',
    examples: [{ name: 'Accepted', status: 202 }],
    unresolved: ['analyticsHost'],
  },
];

describe('Collections tab and empty state (CONTRACTS §21.9)', () => {
  it('Collections tab sits right next to Rules; empty state has two lines and Mock from a collection…', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    const tabs = $$('.toolbar [role="tab"]').map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Traffic', 'Rules', 'Collections', 'Recordings', 'Auth']);

    await click(button(/^Collections/));
    expect($('.collections-view')).not.toBeNull();
    const empty = $('.collection-empty')!;
    expect($$('p', empty)).toHaveLength(2);
    expect(empty.textContent).toContain('Postman collection or OpenAPI 3');
    expect(empty.textContent).toContain('.vscode/flutter-intercept.json');

    await click(button('Mock from a collection…', $('.rules-head')!));
    expect(sent()).toEqual([{ type: 'importCollection' }]);
    await click(button('Mock from a collection…', empty));
    expect(sent()).toEqual([{ type: 'importCollection' }, { type: 'importCollection' }]);
  });
});

describe('Collections rows and controls', () => {
  it('renders counts leaving out zero parts except mocked, personal toggle, unmatched switch, problems, and IDE-confirmed Remove', async () => {
    await mount({ view: 'collections' });
    const c1 = shopStatus();
    const c2 = shopStatus({
      id: 'zero-api',
      name: 'Zero API',
      format: 'openapi',
      enabled: false,
      unmatched: 'fail',
      mocked: 0,
      noExample: 0,
      off: 0,
      problems: ['Line 4: skipped external $ref legacy.yaml'],
    });
    const st: Status = { ...status, collections: [c1, c2] };
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: st });

    expect(button(/^Collections/).textContent).toBe('Collections1/2');
    expect($('.toolbar [role="tab"][aria-selected="true"] .warn-count')).not.toBeNull();

    const rows = $$('.collection-item');
    expect(rows).toHaveLength(2);
    expect($('.collection-counts', rows[0])!.textContent).toBe('42 mocked · 3 without an example · 1 off');
    expect($('.collection-counts', rows[1])!.textContent).toBe('0 mocked');
    expect($('.collection-problems', rows[1])!.textContent).toContain('legacy.yaml');

    // Personal on/off switch
    const enableBox = $<HTMLInputElement>('input[type="checkbox"]', rows[0])!;
    expect(enableBox.checked).toBe(true);
    await click(enableBox);
    expect(lastOf('updateCollection')).toEqual({ type: 'updateCollection', id: 'shop-api', patch: { enabled: false } });

    // Unmatched switch (real server <-> fail)
    const unmatchedGroup = $('[role="group"][aria-label="Not in the collection for Shop API"]', rows[0])!;
    expect(button('Real server', unmatchedGroup).getAttribute('aria-pressed')).toBe('true');
    expect(button('Fail', unmatchedGroup).getAttribute('aria-pressed')).toBe('false');
    await click(button('Fail', unmatchedGroup));
    expect(lastOf('updateCollection')).toEqual({ type: 'updateCollection', id: 'shop-api', patch: { unmatched: 'fail', scope: 'me' } });

    await click(button('Real server', $('[role="group"][aria-label="Not in the collection for Zero API"]', rows[1])!));
    expect(lastOf('updateCollection')).toEqual({ type: 'updateCollection', id: 'zero-api', patch: { unmatched: 'passthrough', scope: 'me' } });

    // Remove posts removeCollection directly with no inline confirm dialog
    await click(button('Remove', rows[0]));
    expect($('[role="alertdialog"]', rows[0])).toBeNull();
    expect(lastOf('removeCollection')).toEqual({ type: 'removeCollection', id: 'shop-api' });
    expect($$('.collection-item')).toHaveLength(2);
  });

  it('unresolved variables: Set <name>… inline text field with Escape cancel, traffic origin suggestions, and submit', async () => {
    await mount({ view: 'collections' });
    const c = shopStatus({ unresolved: ['baseUrl', 'analyticsHost'], mocked: 0, noExample: 0, off: 0 });
    await emit({
      type: 'snapshot',
      exchanges: [ex({ url: 'https://staging.shop.example/v1/items' })],
      rules: [],
      status: { ...status, collections: [c] },
    });

    await click(button('Set baseUrl…'));
    const form = $('.collection-var-form')!;
    const input = $<HTMLInputElement>('input', form)!;
    expect(document.activeElement).toBe(input);
    expect($$('datalist option', form).map((o) => (o as HTMLOptionElement).value)).toContain('https://staging.shop.example');
    expect(button('Save', form).disabled).toBe(true);

    // Escape closes without posting
    await key(form, 'Escape');
    expect($('.collection-var-form')).toBeNull();
    expect(lastOf('updateCollection')).toBeUndefined();

    // Submit posts patch.variable
    await click(button('Set baseUrl…'));
    await type($('input', $('.collection-var-form')!)!, '  https://api.shop.example  ');
    expect(button('Save', $('.collection-var-form')!).disabled).toBe(false);
    await click(button('Save', $('.collection-var-form')!));
    expect(lastOf('updateCollection')).toEqual({
      type: 'updateCollection',
      id: 'shop-api',
      patch: { variable: { name: 'baseUrl', value: 'https://api.shop.example' } },
    });
    expect($('.collection-var-form')).toBeNull();
  });
});

describe('Opened collection: endpoints, folders, filter, example picker, View, Edit as a rule', () => {
  async function openShop(eps: CollectionEndpointView[] = shopEndpoints, st: CollectionStatus = shopStatus()) {
    await mount({ view: 'collections' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [st] } });
    await click($('.collection-title-btn')!);
    expect(lastOf('getCollectionEndpoints')).toEqual({ type: 'getCollectionEndpoints', id: 'shop-api' });
    expect($('.collection-body')!.textContent).toContain('Loading endpoints…');
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: eps });
  }

  it('groups by folder, filters case-insensitively by method/url/name, and toggles endpoint on/off', async () => {
    await openShop();
    expect($$('.ep-folder-name').map((e) => e.textContent)).toEqual(['Auth', 'Users', 'Users / Orders', 'Top level']);
    expect($$('.ep-item')).toHaveLength(5);
    expect($('.ep-no-example', $$('.ep-item')[1])!.textContent).toBe('no example · 501');
    expect(maybeButton('View', $$('.ep-item')[1])).toBeUndefined();
    expect($('.ep-generated', $$('.ep-item')[2])!.textContent).toBe('generated');
    expect($$('.ep-item')[3].className).toContain('ep-off');
    expect($('.ep-unresolved-badge', $$('.ep-item')[4])!.textContent).toBe('needs analyticsHost');

    // Filter by method, url, and name (case-insensitive)
    const filter = $<HTMLInputElement>('.collection-ep-filter')!;
    await type(filter, 'GET');
    expect($$('.ep-item')).toHaveLength(2);
    expect($('.collection-ep-count')!.textContent).toBe('2 of 5 matching');

    await type(filter, 'USERS/:ID');
    expect($$('.ep-item')).toHaveLength(1);
    expect($('.ep-item .ep-name')!.textContent).toBe('User by id');

    await type(filter, 'order items');
    expect($$('.ep-item')).toHaveLength(1);
    expect($('.ep-item .ep-name')!.textContent).toBe('Order items');

    await type(filter, 'post collect');
    expect($$('.ep-item')).toHaveLength(1);
    expect($('.ep-item .ep-name')!.textContent).toBe('Analytics');

    await type(filter, 'nothing-matches');
    expect($$('.ep-item')).toHaveLength(0);
    await click(button('Clear filter'));
    expect($$('.ep-item')).toHaveLength(5);

    // Toggle endpoint off -> posts updateCollection { patch: { off } }
    const firstBox = $<HTMLInputElement>('.ep-item input[type="checkbox"]')!;
    expect(firstBox.checked).toBe(true);
    await click(firstBox);
    expect(lastOf('updateCollection')).toEqual({
      type: 'updateCollection',
      id: 'shop-api',
      patch: { off: { endpoint: 'POST {{baseUrl}}/auth/login', off: true }, scope: 'me' },
    });
    expect($$('.ep-item')[0].className).toContain('ep-off');
  });

  it('example picker, View (pretty JSON, raw fallback, truncated note), and Edit as a rule', async () => {
    await openShop();
    const loginRow = $$('.ep-item')[0];
    const picker = $<HTMLSelectElement>('.ep-example-select', loginRow)!;
    expect(picker.value).toBe('Success');
    expect($('.ep-status', loginRow)!.textContent).toBe('200');

    // View currently selected example -> getCollectionExample -> pretty JSON
    await click(button('View', loginRow));
    expect(lastOf('getCollectionExample')).toEqual({
      type: 'getCollectionExample',
      id: 'shop-api',
      endpoint: 'POST {{baseUrl}}/auth/login',
      name: 'Success',
    });
    await emit({
      type: 'collectionExample',
      id: 'shop-api',
      endpoint: 'POST {{baseUrl}}/auth/login',
      name: 'Success',
      status: 200,
      headers: { 'content-type': 'application/json', 'x-req': '1' },
      body: '{"token":"abc","user":{"id":1}}',
    });
    const viewer = $('.collection-example', loginRow)!;
    expect($('.ep-status', viewer)!.textContent).toBe('200');
    expect(viewer.textContent).toContain('x-req');
    expect($('.collection-example-body', viewer)!.textContent).toBe('{\n  "token": "abc",\n  "user": {\n    "id": 1\n  }\n}');

    // Switching example while View is open sends updateCollection + getCollectionExample for new example
    await choose(picker, 'Wrong password');
    expect(lastOf('updateCollection')).toEqual({
      type: 'updateCollection',
      id: 'shop-api',
      patch: { example: { endpoint: 'POST {{baseUrl}}/auth/login', name: 'Wrong password' }, scope: 'me' },
    });
    expect(lastOf('getCollectionExample')).toEqual({
      type: 'getCollectionExample',
      id: 'shop-api',
      endpoint: 'POST {{baseUrl}}/auth/login',
      name: 'Wrong password',
    });
    await emit({
      type: 'collectionExample',
      id: 'shop-api',
      endpoint: 'POST {{baseUrl}}/auth/login',
      name: 'Wrong password',
      status: 401,
      headers: { 'content-type': 'text/plain' },
      body: 'invalid credentials',
      truncated: true,
    });
    expect($('.ep-status', loginRow)!.textContent).toBe('401');
    expect($('.collection-example-truncated', loginRow)!.textContent).toBe('truncated');
    expect($('.collection-example-truncated-note', loginRow)!.textContent).toContain('truncated');
    expect($('.collection-example-body', loginRow)!.textContent).toBe('invalid credentials');

    // Close example viewer
    await click(button('View', loginRow));
    expect($('.collection-example', loginRow)).toBeNull();

    // Edit as a rule -> collectionToRule -> opens RuleEditor on rules answer
    await click(button('Edit as a rule', loginRow));
    expect(lastOf('collectionToRule')).toEqual({
      type: 'collectionToRule',
      id: 'shop-api',
      endpoint: 'POST {{baseUrl}}/auth/login',
    });
    const personal = rule({
      id: 'personal_login',
      name: 'Shop API › Log in · Wrong password',
      match: { method: 'POST', url: 'https://api.shop.example/auth/login' },
      action: { kind: 'mock', status: 401, body: 'invalid credentials' },
    });
    await emit({ type: 'rules', rules: [personal] });
    expect($('.rule-editor')).not.toBeNull();
    expect($<HTMLInputElement>('.rule-editor input[placeholder="e.g. Empty cart"]')!.value).toBe('Shop API › Log in · Wrong password');
  });

  it('requests once on open, never re-requests on Status changes, accepts host pushes (expanded or collapsed), and re-requests on reconnect snapshot', async () => {
    const c2 = shopStatus({ id: 'other-api', name: 'Other API', mocked: 1, noExample: 0, off: 0 });
    await mount({ view: 'collections' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [shopStatus({ unresolved: ['analyticsHost'] }), c2] } });

    // Open shop-api -> asks once
    await click($$('.collection-title-btn')[0]);
    expect(sent()).toEqual([{ type: 'getCollectionEndpoints', id: 'shop-api' }]);
    await emit({ type: 'collectionEndpoints', id: 'shop-api', endpoints: shopEndpoints });

    // Status update (e.g. variable resolved / file reloaded) must NOT send a duplicate getCollectionEndpoints
    posted = [];
    await emit({
      type: 'status',
      status: { ...status, collections: [shopStatus({ unresolved: [] }), c2] },
    });
    expect(sent()).toEqual([]);

    // Host pushes updated endpoints for shop-api -> UI reflects the push
    await emit({
      type: 'collectionEndpoints',
      id: 'shop-api',
      endpoints: [shopEndpoints[0]],
    });
    expect($$('.ep-item')).toHaveLength(1);

    // Host pushes endpoints for collapsed c2 -> stored in state, row stays collapsed
    await emit({
      type: 'collectionEndpoints',
      id: 'other-api',
      endpoints: [{ key: 'GET /ping', method: 'GET', name: 'Ping', folder: [], url: 'https://other.example/ping', examples: [{ name: 'OK', status: 200 }] }],
    });
    expect($$('.collection-item')[1].querySelector('.collection-body')).toBeNull();
    expect($$('.collection-title-btn')[1].getAttribute('aria-expanded')).toBe('false');

    // Closing and reopening shop-api in the same session does not send a duplicate request
    await click($$('.collection-title-btn')[0]);
    await click($$('.collection-title-btn')[0]);
    expect(sent()).toEqual([]);

    // Reconnect (fresh snapshot after ready) re-requests ONLY expanded collections (shop-api, not collapsed other-api)
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [shopStatus(), c2] } });
    expect(sent()).toEqual([{ type: 'getCollectionEndpoints', id: 'shop-api' }]);
  });

  it('omits redundant Top level header when no endpoint has folders, and checks accessibility labels', async () => {
    const flat: CollectionEndpointView[] = [
      { key: 'GET /a', method: 'GET', name: 'Health', folder: [], url: 'https://api.shop.example/a', examples: [{ name: '200', status: 200 }] },
    ];
    await openShop(flat);
    expect($$('.ep-folder-head')).toHaveLength(0);
    expect($('.collection-toggle-open')!.getAttribute('aria-expanded')).toBe('true');
    expect($('.collection-title-btn')!.getAttribute('aria-expanded')).toBe('true');
    expect($('.collection-ep-filter')!.getAttribute('aria-label')).toBe('Filter endpoints in Shop API');
    expect($('.ep-item input[type="checkbox"]')!.getAttribute('aria-label')).toBe('Enable GET https://api.shop.example/a');
  });
});

describe('501 no-example banner in DetailPane (CONTRACTS §21.5, §21.8, §21.9)', () => {
  it('resolves collection name from matchedRuleId via Status.collections and Mock it with a rule → createRuleFromExchange(mock)', async () => {
    const noEx = ex({
      id: 'nx1',
      method: 'POST',
      url: 'https://api.shop.example/auth/refresh',
      state: 'mocked',
      status: 501,
      matchedRuleId: 'collection:shop-api:1',
      responseHeaders: { 'content-type': 'application/json; charset=utf-8', 'x-flutter-intercept': 'no-example' },
      responseBody: { text: '{"error":"no_example"}', encoding: 'utf8' },
    });

    await mount();
    await emit({ type: 'snapshot', exchanges: [noEx], rules: [], status: { ...status, collections: [shopStatus()] } });
    await click($('.row')!);

    const banner = $('.no-example-banner')!;
    expect(banner.textContent).toContain('No example is saved for this request in Shop API');
    expect($('.detail-facts')!.textContent).toContain('collection “Shop API”');
    expect($('.detail-facts')!.textContent).not.toContain('no longer exists');
    await click(button('Mock it with a rule', banner));
    expect(lastOf('createRuleFromExchange')).toEqual({ type: 'createRuleFromExchange', id: 'nx1', action: 'mock' });

    const created = rule({ id: 'mock_refresh', name: 'Mock POST /auth/refresh', action: { kind: 'mock', status: 200, body: '{}' } });
    await emit({ type: 'rules', rules: [created] });
    expect($('.rule-editor')).not.toBeNull();
  });

  it('falls back to "the collection" when matchedRuleId is missing or not in Status.collections, and hides banner on normal exchanges', async () => {
    const missingCol = ex({
      id: 'nx2',
      state: 'mocked',
      status: 501,
      matchedRuleId: 'collection:deleted-api:2',
      responseHeaders: { 'x-flutter-intercept': 'no-example' },
    });
    const noId = ex({
      id: 'nx3',
      state: 'mocked',
      status: 501,
      matchedRuleId: undefined,
      responseHeaders: { 'x-flutter-intercept': 'no-example' },
    });
    const normal = ex({ id: 'ok1', status: 200 });

    await mount();
    await emit({
      type: 'snapshot',
      exchanges: [missingCol, noId, normal],
      rules: [],
      status: { ...status, collections: [shopStatus()] },
    });

    await click($$('.row')[0]);
    expect($('.no-example-banner')!.textContent).toContain('No example is saved for this request in the collection');

    await click($$('.row')[1]);
    expect($('.no-example-banner')!.textContent).toContain('No example is saved for this request in the collection');

    await click($$('.row')[2]);
    expect($('.no-example-banner')).toBeNull();
  });
});

describe('Hostile inputs, plain text rendering and 200-char clipping', () => {
  it('renders HTML-looking text as plain text and clips names longer than 200 characters with "…"', async () => {
    const xss = '<img src=x onerror=alert(1)><script>boom()</script>';
    const longName = `${xss}${'Z'.repeat(230)}`;
    const c = shopStatus({
      id: 'xss',
      name: longName,
      problems: [`Bad ${xss}`],
    });
    const eps: CollectionEndpointView[] = [{
      key: 'GET /xss',
      method: 'GET',
      name: `${xss}${'E'.repeat(230)}`,
      folder: [`${xss}${'F'.repeat(230)}`],
      url: `https://api.example.com/${xss}`,
      examples: [{ name: `${xss}${'X'.repeat(230)}`, status: 200 }],
    }];

    await mount({ view: 'collections' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [c] } });
    expect($('img', root)).toBeNull();
    expect($('script', root)).toBeNull();
    expect($('.collection-title')!.textContent).toHaveLength(200);
    expect($('.collection-title')!.textContent!.endsWith('…')).toBe(true);
    expect($('.collection-problems')!.textContent).toContain(xss);

    await click($('.collection-title-btn')!);
    await emit({ type: 'collectionEndpoints', id: 'xss', endpoints: eps });
    expect($('img', root)).toBeNull();
    expect($('script', root)).toBeNull();
    expect($('.ep-folder-name')!.textContent).toHaveLength(200);
    expect($('.ep-name')!.textContent).toHaveLength(200);
    expect($('.ep-example-name')!.textContent).toHaveLength(200);
  });
});
