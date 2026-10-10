// @vitest-environment happy-dom
// v0.5.0 UI (CONTRACTS §11.5): frames viewer, list badges, CORS section + dev-only rule, native (read-only)
// exchanges, session warning banners, rule editor (graphqlOperation, cors).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, HostMsg, Rule, SessionWarning, ViewMsg } from '../src/protocol';
import type { Frame } from '../src/frames';
import { ex, rule, status } from './fixtures';

let root: HTMLElement;
let posted: ViewMsg[];
let saved: unknown[];
let listener: ((m: HostMsg) => void) | undefined;

function host(persisted?: unknown): Host {
  return {
    post: (m) => { posted.push(m); },
    getState: <T,>() => persisted as T | undefined,
    setState: (s) => { saved.push(s); },
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
async function click(el: Element) { await act(() => { (el as HTMLElement).click(); }); }
async function type(el: Element, value: string) {
  await act(() => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function key(el: Element, k: string) {
  await act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
}
async function contextMenu(el: Element) {
  await act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })); });
}
const sent = () => posted.filter((m) => m.type !== 'ready');
const filterBox = () => $<HTMLInputElement>('input[type="search"], .filter-input, input[aria-label*="ilter"]')!;

beforeEach(() => {
  posted = [];
  saved = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const T0 = 1_700_000_000_000;
const text = (i: number, over: Partial<Frame> = {}): Frame => {
  const t = JSON.stringify({ type: 'price', seq: i });
  return { dir: i % 3 ? 'receive' : 'send', at: T0 + i * 100, kind: 'text', text: t, size: t.length, ...over };
};
const frames = (n: number, from = 0) => Array.from({ length: n }, (_, i) => text(from + i));
const socket = (over: Partial<Exchange> = {}) => ex({
  id: 'ws1', startedAt: T0, method: 'GET', url: 'wss://rt.example.com/v1/prices', kind: 'websocket', state: 'pending', status: 101,
  responseHeaders: { upgrade: 'websocket' }, responseBody: undefined, durationMs: undefined, frames: frames(5), ...over,
});
const sse = (over: Partial<Exchange> = {}) => ex({
  id: 'sse1', startedAt: T0, url: 'https://api.example.com/v1/orders/stream', kind: 'sse', state: 'pending',
  responseHeaders: { 'content-type': 'text/event-stream' }, responseBody: { text: '', encoding: 'utf8' },
  frames: [
    { dir: 'receive', at: T0 + 10, kind: 'event', event: 'order.updated', id: '41', text: '{"orderId":"o_1"}', size: 17 },
    { dir: 'receive', at: T0 + 20, kind: 'event', event: 'heartbeat', id: '42', text: '', size: 0 },
  ],
  ...over,
});
async function open(exchanges: Exchange[], rules: Rule[] = []) {
  await mount();
  await emit({ type: 'snapshot', exchanges, rules, status });
  await click($$('.row')[0]);
}
const frameRows = () => $$('.frame-row');

describe('frames viewer', () => {
  it('selecting a WebSocket opens Messages: direction, relative time, size, preview; live badge', async () => {
    await open([socket()]);
    const tab = $$('.tab').find((t) => t.getAttribute('aria-selected') === 'true')!;
    expect(tab.textContent).toContain('Messages (5)');
    expect($('.tab-dot.live')).not.toBeNull();
    expect($('.frames-head')!.textContent).toContain('5 messages');
    expect($('.frames-head')!.textContent).toContain('↑ 2 sent · ↓ 3 received');
    expect($('.live-badge')).not.toBeNull();
    const rows = frameRows();
    expect(rows).toHaveLength(5);
    expect($('.fr-dir', rows[0])!.textContent).toBe('↑');
    expect($('.fr-dir', rows[1])!.textContent).toBe('↓');
    expect($('.fr-time', rows[1])!.textContent).toBe('+0.100 s');
    expect($('.fr-size', rows[1])!.textContent).toBe('24 B');
    expect($('.fr-preview', rows[1])!.textContent).toBe('{"type":"price","seq":1}');
  });

  it('selected message: pretty JSON with a Raw toggle; keyboard moves the selection', async () => {
    await open([socket()]);
    await click(frameRows()[1]);
    expect(frameRows()[1].getAttribute('aria-selected')).toBe('true');
    const pre = () => $('.frame-detail pre')!.textContent;
    expect(pre()).toBe('{\n  "type": "price",\n  "seq": 1\n}');
    await click(button('Raw', $('.frame-detail')!));
    expect(pre()).toBe('{"type":"price","seq":1}');
    expect($('.frame-detail')!.textContent).toContain('Received from the server');
    await key($('.frames-scroll')!, 'ArrowDown');
    expect(frameRows()[2].getAttribute('aria-selected')).toBe('true');
    expect($('.frames-scroll')!.getAttribute('aria-activedescendant')).toBe('fr-ws1-2');
    await key($('.frames-scroll')!, 'Home');
    expect(frameRows()[0].getAttribute('aria-selected')).toBe('true');
    expect($('.frame-detail')!.textContent).toContain('Sent by the app');
    await key($('.frames-scroll')!, 'Escape');
    expect($('.frame-detail')).toBeNull();
  });

  it('binary frames show a hex summary; close frames their code; abnormal close is flagged', async () => {
    const bin = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3));
    await open([socket({
      state: 'error', error: 'WebSocket closed abnormally (1006)',
      frames: [
        { dir: 'receive', at: T0, kind: 'binary', base64: bin, size: 7 },
        { dir: 'receive', at: T0 + 5, kind: 'close', closeCode: 1006, size: 2 },
      ],
    })]);
    expect($('.frames-head')!.textContent).toContain('Closed by the server: 1006 (abnormal closure (no close frame))');
    expect($('.frames-close')!.className).toContain('warn-text');
    expect($('.live-badge')).toBeNull();
    expect(frameRows()[0].textContent).toContain('binary · 7 B');
    await click(frameRows()[0]);
    expect($('.frame-detail .binary')!.textContent).toBe('binary (7 bytes)');
    expect($('.hexdump')!.textContent).toContain('00000000  89 50 4e 47 01 02 03');
    expect($('.hexdump')!.textContent).toContain('.PNG...');
    await click(frameRows()[1]);
    expect($('.frame-detail')!.textContent).toContain('code 1006 (abnormal closure');
    expect($('.frame-detail')!.textContent).toContain('No close reason.');
  });

  it('huge SSE event / id fields are capped when rendered (REVIEW-5 #4)', async () => {
    const big = 'e'.repeat(64 * 1024);
    await open([sse({ frames: [{ dir: 'receive', at: T0, kind: 'event', event: big, id: 'i'.repeat(64 * 1024), text: 'x', size: 1 }] })]);
    expect($('.ev-badge')!.textContent!.length).toBe(64);
    await click(frameRows()[0]);
    const codes = $$('.frame-detail .meta-item code').map((c) => c.textContent!.length);
    expect(codes).toEqual([256, 256]);
    expect(root.innerHTML.length).toBeLessThan(40_000);
  });

  it('a re-sent window only processes new frames; the selected message is not re-formatted', async () => {
    const win = (from: number) => frames(200, from).map((f) => ({ ...f, at: T0 + (f.at - T0) }));
    await open([socket({ frames: win(0) })]);
    await type($('.frames-filter')!, 'price');
    expect(frameRows().length).toBeGreaterThan(0);
    await click(frameRows().at(-1)!);
    const before = $('.frame-detail pre')!;
    // Same frames, new objects (structured clone), shifted by two (two dropped, two new).
    await emit({ type: 'exchange', exchange: socket({ frames: JSON.parse(JSON.stringify(win(2))), framesDropped: 2 }) });
    expect($('.frame-detail pre')).toBe(before); // same DOM node: not re-rendered from scratch
    expect(frameRows().at(-1)!.getAttribute('data-n')).toBe('201');
  });

  it('SSE: Events tab, event names and ids, no direction filter', async () => {
    await open([sse()]);
    expect($$('.tab').map((t) => t.textContent)).toContain('Events (2)');
    expect($('.frames-head')!.textContent).toContain('2 events');
    expect($('[aria-label="Direction"]')).toBeNull();
    expect($('.ev-badge', frameRows()[0])!.textContent).toBe('order.updated');
    await click(frameRows()[0]);
    const d = $('.frame-detail')!.textContent!;
    expect(d).toContain('event: order.updated');
    expect(d).toContain('id: 41');
    await click(frameRows()[1]);
    expect($('.frame-detail')!.textContent).toContain('Empty payload.');
  });

  it('"N earlier messages dropped" when the proxy dropped frames', async () => {
    await open([socket({ frames: frames(3, 20), framesDropped: 20 })]);
    expect($('.frames-dropped')!.textContent).toBe('20 earlier messages were dropped — the proxy keeps the newest 3.');
    expect($$('.tab').map((t) => t.textContent)).toContain('Messages (23)');
  });

  it('text filter and direction filter inside messages', async () => {
    const fs = [...frames(4), text(4, { text: 'hello needle', size: 12 }), text(5, { dir: 'send', text: 'subscribe needle', size: 16 })];
    await open([socket({ frames: fs })]);
    await type($('.frames-filter')!, 'needle');
    expect(frameRows().map((r) => $('.fr-preview', r)!.textContent)).toEqual(['hello needle', 'subscribe needle']);
    expect($('.frames-tools')!.textContent).toContain('2 of 6');
    await click(button('↑ Sent'));
    expect(frameRows().map((r) => $('.fr-preview', r)!.textContent)).toEqual(['subscribe needle']);
    await type($('.frames-filter')!, 'nothing-like-this');
    expect(frameRows()).toHaveLength(0);
    expect(root.textContent).toContain('No messages match the filter.');
  });

  it('live append stays pinned to the bottom; scrolling up stops following until "Jump to latest"', async () => {
    const many = frames(300);
    await open([socket({ frames: many })]);
    const last = () => frameRows().at(-1)!.getAttribute('data-n');
    expect(last()).toBe('299');
    expect(frameRows().length).toBeLessThan(60); // virtualised
    await emit({ type: 'exchange', exchange: socket({ frames: [...many, ...frames(2, 300)] }) });
    expect(last()).toBe('301');
    expect($('.tab[aria-selected="true"]')!.textContent).toContain('Messages (302)');

    // The user scrolls to the top.
    const sc = $<HTMLElement>('.frames-scroll')!;
    Object.defineProperty(sc, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(sc, 'scrollHeight', { configurable: true, value: 302 * 20 });
    await act(() => { sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); });
    expect(frameRows()[0].getAttribute('data-n')).toBe('0');
    await emit({ type: 'exchange', exchange: socket({ frames: [...many, ...frames(5, 300)] }) });
    expect(frameRows()[0].getAttribute('data-n')).toBe('0'); // not yanked to the bottom
    expect(frameRows().some((r) => r.getAttribute('data-n') === '304')).toBe(false);
    await click(button('Jump to latest'));
    expect(frameRows().at(-1)!.getAttribute('data-n')).toBe('304');
  });

  it('selection survives older frames being dropped (stable frame numbers)', async () => {
    await open([socket({ frames: frames(5) })]);
    await click(frameRows()[3]); // frame #3
    await emit({ type: 'exchange', exchange: socket({ frames: frames(5, 2), framesDropped: 2 }) });
    const sel = frameRows().find((r) => r.getAttribute('aria-selected') === 'true')!;
    expect(sel.getAttribute('data-n')).toBe('3');
    await emit({ type: 'exchange', exchange: socket({ frames: frames(2, 5), framesDropped: 5 }) });
    expect($('.frames')!.textContent).toContain('That message was dropped');
  });

  it('switching exchanges resets the filter; plain exchanges have no Messages tab', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [socket(), ex({ id: 'plain' })], rules: [], status });
    await click($$('.row')[0]);
    await type($('.frames-filter')!, 'zzz');
    await click($$('.row')[1]);
    expect($$('.tab').map((t) => t.textContent)).toEqual(['Request', 'Response', 'Timing']);
    expect($('.tab[aria-selected="true"]')!.textContent).toBe('Response');
    await click($$('.row')[0]);
    expect($<HTMLInputElement>('.frames-filter')!.value).toBe('');
  });

  it('render benchmark: 100 sockets × 500 frames; open one and stream 50 appends', async () => {
    await mount();
    const all = Array.from({ length: 100 }, (_, k) => socket({ id: `w${k}`, frames: frames(500), framesDropped: 40 }));
    await emit({ type: 'snapshot', exchanges: all, rules: [], status });
    const t0 = performance.now();
    await click($$('.row')[0]);
    const openMs = performance.now() - t0;
    expect(frameRows().length).toBeGreaterThan(10);
    expect(frameRows().length).toBeLessThan(60);
    let cur = all[0].frames!;
    const t1 = performance.now();
    for (let i = 0; i < 50; i++) {
      cur = [...cur.slice(1), text(500 + i)];
      await emit({ type: 'exchange', exchange: { ...all[0], frames: cur, framesDropped: 41 + i } });
    }
    const perAppend = (performance.now() - t1) / 50;
    console.info(`[frames render] open 500-frame socket ${openMs.toFixed(1)} ms; live append ${perAppend.toFixed(2)} ms each (${frameRows().length} rows in DOM)`);
    expect(frameRows().at(-1)!.getAttribute('data-n')).toBe(String(40 + 500 + 49));
    expect(openMs).toBeLessThan(500);
    expect(perAppend).toBeLessThan(50);
  });
});

describe('list badges and filter tokens', () => {
  it('WS / SSE / GQL / native / CORS badges with tooltips; frames count as size', async () => {
    await mount();
    await emit({ type: 'snapshot', rules: [], status, exchanges: [
      socket({ framesDropped: 2 }),
      sse(),
      ex({ id: 'g', method: 'POST', url: 'https://api.example.com/graphql', graphql: { operationName: 'getUser', operationType: 'query' } }),
      ex({ id: 'n', captured: 'vm-profile' }),
      ex({ id: 'c', cors: { problem: 'no Access-Control-Allow-Origin for http://localhost:5000' } }),
      ex({ id: 'p' }),
    ] });
    const rows = $$('.row');
    const kb = $('.kind-badge', rows[0])!;
    expect(kb.textContent).toBe('WS');
    expect(kb.getAttribute('title')).toBe('WebSocket · 7 messages (2 oldest dropped) · open');
    expect($('.c-size', rows[0])!.textContent).toBe('7 msg');
    expect($('.kind-badge', rows[1])!.textContent).toBe('SSE');
    const g = $('.gql-badge', rows[2])!;
    expect(g.textContent).toBe('GQL getUser');
    expect(g.getAttribute('title')).toBe('GraphQL query getUser');
    expect($('.native-badge', rows[3])!.getAttribute('title')).toMatch(/^Read-only/);
    expect($('.cors-badge', rows[4])!.getAttribute('title')).toBe('CORS: no Access-Control-Allow-Origin for http://localhost:5000');
    expect($('.c-path', rows[5])!.querySelector('.badge')).toBeNull();
  });

  it('new tokens filter the list (with negation)', async () => {
    await mount();
    await emit({ type: 'snapshot', rules: [], status, exchanges: [
      socket(), sse(), ex({ id: 'g', graphql: { operationName: 'getUser' } }), ex({ id: 'n', captured: 'vm-profile' }),
      ex({ id: 'c', cors: { problem: 'x' } }),
    ] });
    const ids = () => $$('.row').map((r) => r.id.slice(3));
    await type(filterBox(), 'kind:ws');
    expect(ids()).toEqual(['ws1']);
    await type(filterBox(), 'op:get');
    expect(ids()).toEqual(['g']);
    await type(filterBox(), 'cors:problem');
    expect(ids()).toEqual(['c']);
    await type(filterBox(), '-captured:native -kind:ws,sse');
    expect(ids()).toEqual(['g', 'c']);
  });
});

describe('CORS section', () => {
  const blocked = (over: Partial<Exchange> = {}) => ex({
    id: 'c1', url: 'https://api.example.com/v1/cart?x=1', requestHeaders: { origin: 'http://localhost:5000' },
    cors: { problem: 'no Access-Control-Allow-Origin for http://localhost:5000' }, ...over,
  });

  it('shows the problem; after a confirmation naming origin and route, adds the rule FIRST (credentials off), with undo', async () => {
    const existing = rule({ id: 'r_old' });
    await open([blocked()], [existing]);
    const sec = $('.cors')!;
    expect(sec.className).toContain('error');
    expect(sec.textContent).toContain('no Access-Control-Allow-Origin for http://localhost:5000');
    expect(sec.textContent).toContain('Development only');
    await click(button('Add CORS rule (dev only)'));
    expect(sent().some((m) => m.type === 'setRules')).toBe(false); // nothing until confirmed
    const conf = $('.cors-confirm')!;
    expect(conf.textContent).toContain('Allow http://localhost:5000 to read responses from https://api.example.com/v1/cart*');
    expect(conf.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    await click(button('Add rule', conf));
    const msg = sent().at(-1) as Extract<ViewMsg, { type: 'setRules' }>;
    expect(msg.type).toBe('setRules');
    expect(msg.rules).toHaveLength(2);
    expect(msg.rules[0]).toMatchObject({
      enabled: true, name: 'CORS (dev only) /v1/cart for http://localhost:5000', match: { url: 'https://api.example.com/v1/cart*' },
    });
    expect(msg.rules[0].action).toEqual({ kind: 'cors', allowOrigin: 'http://localhost:5000' });
    expect(msg.rules[0].match.method).toBeUndefined(); // the OPTIONS preflight matches too
    expect(msg.rules[1].id).toBe('r_old');
    expect($('.notice')!.textContent).toBe(
      'CORS rule added first: http://localhost:5000 may read https://api.example.com/v1/cart* responses, credentials off — development only, the server is not fixed.Undo',
    );
    await click(button('Undo'));
    expect((sent().at(-1) as Extract<ViewMsg, { type: 'setRules' }>).rules.map((r) => r.id)).toEqual(['r_old']);
  });

  it('credentials only when ticked, and the notice says so; Cancel adds nothing', async () => {
    await open([blocked({ requestHeaders: { origin: 'http://localhost:5000', cookie: 's=1' } })]);
    await click(button('Add CORS rule (dev only)'));
    expect($('.cors-confirm')!.textContent).toContain('this request sent cookies');
    await click(button('Cancel', $('.cors-confirm')!));
    expect($('.cors-confirm')).toBeNull();
    expect(sent().some((m) => m.type === 'setRules')).toBe(false);
    await click(button('Add CORS rule (dev only)'));
    await act(() => { $<HTMLInputElement>('.cors-confirm input[type="checkbox"]')!.click(); });
    await click(button('Add rule with credentials'));
    const msg = sent().at(-1) as Extract<ViewMsg, { type: 'setRules' }>;
    expect(msg.rules[0].action).toEqual({ kind: 'cors', allowOrigin: 'http://localhost:5000', allowCredentials: true });
    expect($('.notice')!.textContent).toContain('credentials ON (cookies included)');
  });

  it('no Origin header: the button is disabled (nothing to name)', async () => {
    await open([blocked({ requestHeaders: {} })]);
    const b = button('Add CORS rule (dev only)');
    expect(b.disabled).toBe(true);
    expect(b.title).toMatch(/no Origin/);
  });

  it('preflight and patched notes; no button when there is no problem', async () => {
    await open([blocked({ method: 'OPTIONS', cors: { preflight: true, patched: true } })]);
    const sec = $('.cors')!;
    expect(sec.className).toContain('info');
    expect($('.cors-pre', sec)).not.toBeNull();
    expect(sec.textContent).toContain('preflight (OPTIONS) for http://localhost:5000');
    expect(sec.textContent).toContain('Patched by Flutter Intercept');
    expect(() => button('Add CORS rule (dev only)')).toThrow();
  });

  it('no section for requests without a diagnosis', async () => {
    await open([ex()]);
    expect($('.cors')).toBeNull();
  });
});

describe('native (VM-profile) exchanges are read-only', () => {
  const native = () => ex({ id: 'n1', captured: 'vm-profile', responseBody: { text: '{"a":1}', encoding: 'utf8' } });

  it('intercept actions are disabled with a tooltip; copying still works', async () => {
    await open([native()]);
    expect($('.native-note')!.textContent).toContain('Read-only');
    for (const label of ['Mock this', 'Block this', 'Break on this', 'Resend', 'Edit and resend']) {
      const b = button(label);
      expect([label, b.disabled]).toEqual([label, true]);
      expect(b.title).toMatch(/^Read-only/);
    }
    await click(button(/Generate/));
    const items = $$('.menu [role="menuitem"]') as HTMLButtonElement[];
    expect(items.every((i) => i.disabled && /^Read-only/.test(i.title))).toBe(true);
    await key($('.menu')!, 'Escape');
    await click(button(/Copy as/));
    expect(($$('.menu [role="menuitem"]') as HTMLButtonElement[]).every((i) => !i.disabled)).toBe(true);
  });

  it('context menu items are disabled too; the JSON tree offers no mutations', async () => {
    await open([native()]);
    await contextMenu($$('.row')[0]);
    const items = $$('.menu [role="menuitem"]') as HTMLButtonElement[];
    const byLabel = (l: string) => items.find((i) => i.textContent === l)!;
    for (const l of ['Mock this', 'Block this', 'Break on this', 'Resend', 'Edit and resend…', 'Generate Dart model']) {
      expect(byLabel(l).disabled).toBe(true);
    }
    expect(byLabel('Copy as cURL').disabled).toBe(false);
  });

  it('WebSocket exchanges can\'t be mocked or resent', async () => {
    await open([socket({ state: 'completed' })]);
    expect(button('Mock this').disabled).toBe(true);
    expect(button('Mock this').title).toMatch(/WebSocket/);
    expect(button('Block this').disabled).toBe(false);
    expect(button('Resend').disabled).toBe(true);
    expect(button('Edit and resend').title).toMatch(/can't be resent/);
  });
});

describe('session warnings', () => {
  const w = (id: string, kind: SessionWarning['kind'] = 'background-isolate'): SessionWarning => ({ id, kind, text: `Warning ${id}` });

  it('shows banners, dismisses per id and persists the dismissal', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, warnings: [w('a'), w('b', 'native-client')] } });
    expect($$('.warning-banner').map((b) => b.textContent)).toEqual(['⚠Warning a', '⚠Warning b']);
    expect($('.wk-native-client')!.getAttribute('title')).toMatch(/cupertino_http/);
    await click(button('', $$('.warning-banner')[0]));
    expect($$('.warning-banner').map((b) => $('.warning-text', b)!.textContent)).toEqual(['Warning b']);
    await act(async () => { await tick(350); });
    expect((saved.at(-1) as { dismissedWarnings: string[] }).dismissedWarnings).toEqual(['a']);
    // a new warning still shows
    await emit({ type: 'status', status: { ...status, warnings: [w('a'), w('b'), w('c')] } });
    expect($$('.warning-text').map((b) => b.textContent)).toEqual(['Warning b', 'Warning c']);
  });

  it('a restored dismissal hides the warning after reload', async () => {
    await mount({ dismissedWarnings: ['a'] });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, warnings: [w('a'), w('b')] } });
    expect($$('.warning-text').map((b) => b.textContent)).toEqual(['Warning b']);
  });

  it('nothing rendered without warnings', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    expect($('.warnings')).toBeNull();
  });
});

describe('rule editor: GraphQL operation and CORS', () => {
  async function newRule(exchanges: Exchange[] = []) {
    await mount({ view: 'rules' });
    await emit({ type: 'snapshot', exchanges, rules: [], status });
    await click(button(/Add rule/));
  }
  const urlInput = () => $$('.rule-editor input').find((i) => (i as HTMLInputElement).placeholder.startsWith('https://api.example.com/users'))! as HTMLInputElement;
  const opInput = () => $<HTMLInputElement>('.rule-editor input[list="fi-rule-ops"]');

  it('graphqlOperation appears for GraphQL routes, suggests seen operations, narrows the preview and is saved', async () => {
    await newRule([
      ex({ method: 'POST', url: 'https://api.example.com/gql', graphql: { operationName: 'getUser' } }),
      ex({ method: 'POST', url: 'https://api.example.com/gql', graphql: { operationName: 'addToCart' } }),
    ]);
    expect(opInput()).toBeNull();
    await type(urlInput(), 'https://api.example.com/gql');
    expect(opInput()).not.toBeNull();
    expect($$('#fi-rule-ops option').map((o) => (o as HTMLOptionElement).value)).toEqual(['addToCart', 'getUser']);
    expect($('.rule-editor')!.textContent).toContain('Matches 2 of the 2');
    await type(opInput()!, 'getUser');
    expect($('.rule-editor')!.textContent).toContain('Matches 1 of the 2');
    await type(opInput()!, 'get User');
    expect($('.rule-editor')!.textContent).toContain('A GraphQL operation name');
    expect(button('Add rule', $('.re-actions')!).disabled).toBe(true);
    await type(opInput()!, 'getUser');
    await click(button('Add rule', $('.re-actions')!));
    const msg = sent().at(-1) as Extract<ViewMsg, { type: 'setRules' }>;
    expect(msg.rules[0].match).toEqual({ url: 'https://api.example.com/gql', graphqlOperation: 'getUser' });
    expect($('.rule-item .gql-badge')!.textContent?.trim()).toBe('op getUser');
  });

  it('shown for a /graphql URL even before traffic', async () => {
    await newRule();
    await type(urlInput(), 'https://api.example.com/graphql');
    expect(opInput()).not.toBeNull();
  });

  it('cors action: dev-only note, rejects * with credentials, saves', async () => {
    await newRule();
    await type(urlInput(), 'https://api.example.com/*');
    const corsRadio = $$('.rule-editor label.radio').find((l) => l.textContent === 'CORS (dev only)')!.querySelector('input')!;
    await act(() => { corsRadio.click(); });
    expect($('.cors-dev-note')!.textContent).toContain('NOT fixed');
    const origin = $$('.rule-editor input').find((i) => (i as HTMLInputElement).placeholder.includes('localhost origins only'))! as HTMLInputElement;
    await type(origin, '*');
    const creds = $$('.rule-editor label.check').find((l) => l.textContent?.includes('credentials'))!.querySelector('input')!;
    await act(() => { creds.click(); });
    expect($('.rule-editor')!.textContent).toContain('Browsers reject "*" with credentials');
    expect(button('Add rule', $('.re-actions')!).disabled).toBe(true);
    await type(origin, 'http://localhost:5000');
    await click(button('Add rule', $('.re-actions')!));
    const msg = sent().at(-1) as Extract<ViewMsg, { type: 'setRules' }>;
    expect(msg.rules[0].action).toEqual({ kind: 'cors', allowOrigin: 'http://localhost:5000', allowCredentials: true });
    expect($('.rule-item')!.textContent).toContain('CORS (dev only): allow http://localhost:5000 + credentials');
    expect($('.rule-item .kind-cors')).not.toBeNull();
  });
});

describe('browser-internal traffic', () => {
  const app = ex({ id: 'app' });
  const b1 = ex({ id: 'b1', url: 'https://update.googleapis.com/x', browserInternal: true });
  const b2 = ex({ id: 'b2', url: 'https://optimizationguide-pa.googleapis.com/y', browserInternal: true });
  const rowIds = () => $$('.row').map((r) => r.id.slice(3));
  const toggle = () => $<HTMLButtonElement>('.browser-toggle');

  it('hidden by default with a count; the toggle shows them and is persisted', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [app, b1, b2], rules: [], status });
    expect(rowIds()).toEqual(['app']);
    expect(toggle()!.textContent).toBe('Show browser traffic2');
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
    expect(toggle()!.title).toContain('2 hidden');
    expect($('.statusline')!.textContent).toContain('3 exchanges (1 shown)');
    await click(toggle()!);
    expect(rowIds()).toEqual(['app', 'b1', 'b2']);
    expect(toggle()!.textContent).toBe('Show browser traffic');
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { await tick(350); });
    expect((saved.at(-1) as { filters: { showBrowser: boolean } }).filters.showBrowser).toBe(true);
  });

  it('no toggle without browser traffic; browser: token in the filter box', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [app], rules: [], status });
    expect(toggle()).toBeNull();
    await emit({ type: 'exchange', exchange: b1 });
    expect(toggle()).not.toBeNull();
    await type(filterBox(), 'browser:internal');
    expect(rowIds()).toEqual(['b1']);
  });

  it('only browser traffic: the empty list offers to show it; restored toggle shows it at once', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [b1, b2], rules: [], status });
    expect($('.list-pane')!.textContent).toContain('Only browser traffic so far. 2 browser-internal exchanges are hidden.');
    await click(button('Show browser traffic', $('.list-pane')!));
    expect(rowIds()).toEqual(['b1', 'b2']);
    render(null, root);
    await mount({ filters: { ...{ text: '', method: '', statusClasses: [], pausedOnly: false }, showBrowser: true } });
    await emit({ type: 'snapshot', exchanges: [b1, b2], rules: [], status });
    expect(rowIds()).toEqual(['b1', 'b2']);
  });
});
