// @vitest-environment happy-dom
// v0.3.0 UI (CONTRACTS §9.3): copy menu, resend + composer, source, network picker, throttle/fault + lifetime rules,
// filter language in the toolbar.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { presetProfile } from '@flutter-intercept/proxy/network';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, HostMsg, ViewMsg } from '../src/protocol';
import { ex, rule, status } from './fixtures';

let root: HTMLElement;
let posted: ViewMsg[];
let listener: ((m: HostMsg) => void) | undefined;

function host(): Host {
  return {
    post: (m) => { posted.push(m); },
    getState: () => undefined,
    setState: () => {},
    onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function mount() { await act(() => { render(<App host={host()} />, root); }); }
async function emit(...msgs: HostMsg[]) {
  await act(async () => { for (const m of msgs) listener!(m); await tick(); });
}
const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null;
const $$ = (sel: string) => Array.from(root.querySelectorAll(sel));
const button = (label: string | RegExp, scope: ParentNode = root) => {
  const b = Array.from(scope.querySelectorAll('button')).find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
  if (!b) throw new Error(`button ${label} not found`);
  return b as HTMLButtonElement;
};
async function click(el: Element) { await act(() => { (el as HTMLElement).click(); }); }
async function type(el: Element, value: string) {
  await act(() => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(el: Element, value: string) {
  await act(() => { (el as HTMLSelectElement).value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })); });
}
const sent = () => posted.filter((m) => m.type !== 'ready');

beforeEach(() => {
  posted = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const cart = (over: Partial<Exchange> = {}) => ex({
  id: 'cart1', method: 'POST', url: 'https://api.example.com/cart',
  requestHeaders: { 'content-type': 'application/json' }, requestBody: { text: '{"qty":1}', encoding: 'utf8' },
  status: 201, ...over,
});

async function selectFirstRow() {
  await click($$('.row')[0]);
}

describe('copy as code (WP2)', () => {
  it('detail pane menu posts copySnippet and shows a short notice', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [cart()], rules: [], status });
    await selectFirstRow();
    const trigger = button(/Copy as…/);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = $$('[role="menu"] [role="menuitem"]').map((b) => b.textContent);
    expect(items).toEqual(['Copy as cURL', 'Copy as Dart (http)', 'Copy as Dio']);
    expect(document.activeElement?.textContent).toBe('Copy as cURL'); // first item focused
    await click(button('Copy as Dio'));
    expect(sent()).toEqual([{ type: 'copySnippet', id: 'cart1', format: 'dio' }]);
    expect($('[role="menu"]')).toBeNull();
    expect($('.notice')!.textContent).toContain('Copied as Dio');
  });

  it('row context menu (right click or Shift+F10) offers copy, resend and rule actions; keyboard navigable', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [cart(), ex({ id: 'x2' })], rules: [], status });
    await act(() => { $$('.row')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 })); });
    const menu = $('.menu.context')!;
    expect(menu).not.toBeNull();
    expect($('.row.selected')!.id).toBe('ex-x2');
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Copy as cURL', 'Copy as Dart (http)', 'Copy as Dio', 'Resend', 'Edit and resend…', 'Mock this', 'Block this', 'Break on this',
      'Generate Dart model', 'Generate test fixture',
    ]);
    await key(menu, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Copy as Dart (http)');
    await key(menu, 'End');
    expect(document.activeElement?.textContent).toBe('Generate test fixture');
    await key(menu, 'Escape');
    expect($('.menu')).toBeNull();

    // Keyboard: Shift+F10 on the focused list opens it for the selected row.
    await key($('.list-scroll')!, 'F10', { shiftKey: true });
    expect($('.menu.context')).not.toBeNull();
    await click(button('Copy as cURL', $('.menu')!));
    expect(sent()).toEqual([{ type: 'copySnippet', id: 'x2', format: 'curl' }]);
  });
});

describe('resend and the edit-and-resend composer (WP3)', () => {
  it('Resend posts send with resentFrom; `sent` selects the new exchange, which links back to the original', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [cart()], rules: [], status });
    await selectFirstRow();
    await click(button('Resend'));
    expect(sent()).toEqual([{
      type: 'send', resentFrom: 'cart1',
      request: { method: 'POST', url: 'https://api.example.com/cart', headers: { 'content-type': 'application/json' }, body: '{"qty":1}' },
    }]);
    await emit({ type: 'sent', id: 'n1' }, { type: 'exchange', exchange: cart({ id: 'n1', state: 'pending', status: undefined, initiator: 'editor', resentFrom: 'cart1' }) });
    expect($('.row.selected')!.id).toBe('ex-n1');
    expect($('.row.selected .sent-badge')!.textContent).toBe('resent');
    expect($('.detail-facts')!.textContent).toContain('Resent by the editor from the original');
    await click(button('the original'));
    expect($('.row.selected')!.id).toBe('ex-cart1');
  });

  it('Resend is disabled for binary request bodies, and for unfinished exchanges', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [cart({ requestBody: { text: 'AAAA', encoding: 'base64' } }), ex({ id: 'p', state: 'pending' })], rules: [], status });
    await selectFirstRow();
    expect(button('Resend').disabled).toBe(true);
    expect(button(/Edit and resend/).disabled).toBe(false);
    await click($$('.row')[1]);
    expect(button(/Edit and resend/).disabled).toBe(true);
  });

  it('composer edits the request, sends it (Ctrl+Enter), unlocks on error, closes on sent', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [cart()], rules: [], status });
    await selectFirstRow();
    await click(button(/Edit and resend/));
    const form = $('.composer form')!;
    expect(form).not.toBeNull();
    expect($('.composer')!.textContent).toContain('from POST https://api.example.com/cart');
    expect($<HTMLInputElement>('.composer .pe-url')!.value).toBe('https://api.example.com/cart');
    await type($('.composer .pe-url')!, 'https://api.example.com/cart?dry=1');
    await type($('.composer textarea')!, '{"qty":2}');
    await key(form, 'Enter', { ctrlKey: true });
    expect(sent()).toEqual([{
      type: 'send', resentFrom: 'cart1',
      request: { method: 'POST', url: 'https://api.example.com/cart?dry=1', headers: { 'content-type': 'application/json' }, body: '{"qty":2}' },
    }]);
    expect($('.composer')!.textContent).toContain('Sending…');
    expect(button('Send').disabled).toBe(true);
    await emit({ type: 'error', message: 'Invalid URL' });
    expect(button('Send').disabled).toBe(false);
    await click(button('Send'));
    await emit({ type: 'exchange', exchange: cart({ id: 'n2', initiator: 'editor', resentFrom: 'cart1' }) }, { type: 'sent', id: 'n2' });
    expect($('.composer')).toBeNull();
    expect($('.row.selected')!.id).toBe('ex-n2');
  });

  it('composer validates (bad URL blocks Send) and Escape cancels', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [cart()], rules: [], status });
    await selectFirstRow();
    await click(button(/Edit and resend/));
    await type($('.composer .pe-url')!, 'not a url');
    expect(button('Send').disabled).toBe(true);
    expect($('.composer .errors')!.textContent).toContain('URL must be absolute');
    await key($('.composer form')!, 'Escape');
    expect($('.composer')).toBeNull();
    expect($('.detail')).not.toBeNull();
  });
});

describe('request source (WP1)', () => {
  const withSource = () => cart({
    source: {
      appFrame: 1,
      frames: [
        { fn: 'DioMixin.fetch', uri: 'package:dio/src/dio_mixin.dart', line: 300, column: 5 },
        { fn: 'CartApi.add', uri: 'package:shop/src/api/cart_api.dart', line: 12, column: 7 },
        { fn: 'CartPage._onTap', uri: 'package:shop/ui/cart_page.dart', line: 88, afterAsyncGap: true },
      ],
    },
  });

  it('shows the call site, opens it, and lists every frame (framework dimmed, async gaps shown)', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [withSource()], rules: [], status });
    await selectFirstRow();
    const src = $('.source')!;
    expect(src.textContent).toContain('Called from');
    expect(src.querySelector('.source-fn')!.textContent).toBe('CartApi.add');
    expect(src.querySelector('.source-loc')!.textContent).toBe('api/cart_api.dart:12');
    await click(button('Open source', src));
    expect(sent()).toEqual([{ type: 'openSource', id: 'cart1', frame: 1 }]);
    const toggle = button(/All frames \(3\)/, src);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    const frames = $$('.frames .frame');
    expect(frames).toHaveLength(3);
    expect(frames[0].classList.contains('framework')).toBe(true);
    expect(frames[1].classList.contains('app')).toBe(true);
    expect(frames[2].querySelector('.async-gap')!.textContent).toContain('asynchronous gap');
    await click(frames[2].querySelector('button')!);
    expect(sent()[1]).toEqual({ type: 'openSource', id: 'cart1', frame: 2 });
    // Context menu offers it too.
    await act(() => { $$('.row')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    await click(button('Open source', $('.menu')!));
    expect(sent()[2]).toEqual({ type: 'openSource', id: 'cart1', frame: 1 });
  });

  it('no source → no section; source without an app frame says so', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [cart(), cart({ id: 'c2', source: { frames: [{ fn: 'x', uri: 'dart:async' }] } })], rules: [], status });
    await selectFirstRow();
    expect($('.source')).toBeNull();
    await click($$('.row')[1]);
    expect($('.source')!.textContent).toContain('no app frame found');
    expect(() => button('Open source')).toThrow();
  });
});

describe('network profile picker and simulation (WP5)', () => {
  it('posts the chosen preset and highlights an active profile from status', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status });
    const sel = $<HTMLSelectElement>('select[aria-label="Network profile"]')!;
    expect(sel.value).toBe('none');
    expect($('.net-picker.active')).toBeNull();
    await choose(sel, 'slow-3g');
    expect(sent()).toEqual([{ type: 'setNetworkProfile', profile: presetProfile('slow-3g') }]);
    await emit({ type: 'status', status: { ...status, networkProfile: presetProfile('slow-3g') } });
    expect($('.net-picker.active')).not.toBeNull();
    expect($<HTMLSelectElement>('select[aria-label="Network profile"]')!.value).toBe('slow-3g');
    expect($('.statusline')!.textContent).toContain('Network: Slow 3G');
    await choose($('select[aria-label="Network profile"]')!, 'none');
    expect(sent()[1]).toEqual({ type: 'setNetworkProfile', profile: { kind: 'none' } });
  });

  it('custom profile: latency, kbps, fail % → throttle profile', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status });
    await choose($('select[aria-label="Network profile"]')!, 'custom');
    const dlg = $('.net-custom')!;
    const [lat, kbps, , drop] = Array.from(dlg.querySelectorAll('input')); // latency, download, upload, fail
    await type(lat, '250');
    await type(kbps, '');
    await type(drop, '10');
    await click(button('Apply', dlg));
    expect(sent()).toEqual([{ type: 'setNetworkProfile', profile: { kind: 'throttle', latencyMs: 250, dropRate: 0.1 } }]);
    expect($('.net-custom')).toBeNull();
    await emit({ type: 'status', status: { ...status, networkProfile: { kind: 'throttle', latencyMs: 250, dropRate: 0.1 } } });
    expect($('.statusline')!.textContent).toContain('Network: +250 ms, 10% fail');
    // Invalid values block Apply.
    await click(button('', $('.net-picker')!)); // the edit (pencil) icon button
    await type($('.net-custom input')!, '-5');
    expect(button('Apply', $('.net-custom')!).disabled).toBe(true);
  });

  it('simulated exchanges are marked in the list and the detail pane', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex({ simulated: 'Slow 3G: +400 ms' })], rules: [], status });
    expect($('.row .sim-badge')!.getAttribute('title')).toBe('Simulated: Slow 3G: +400 ms');
    await selectFirstRow();
    expect($('.detail-facts')!.textContent).toContain('simulated Slow 3G: +400 ms');
  });
});

describe('throttle / fault rules and rule lifetime (WP5, WP7)', () => {
  it('creates a throttle rule limited to the first N requests with an expiry', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status });
    await click(button(/^Rules/));
    await click(button(/Add rule/));
    const form = $('.rule-editor')!;
    await type(form.querySelector('input.mono')!, 'https://api.example.com/*');
    const throttle = Array.from(form.querySelectorAll('label.radio')).find((l) => l.textContent === 'Throttle')!.querySelector('input')!;
    await click(throttle);
    const field = (label: string) => Array.from(form.querySelectorAll('label.field')).find((l) => l.querySelector('span')?.textContent === label)!.querySelector('input')!;
    await type(field('Latency (ms)'), '800');
    await type(field('Download (kbps)'), '64');
    await type(field('Only first N requests'), '2');
    await type(field('Expires in'), '10');
    const before = Date.now();
    await click(button('Add rule', form));
    const msg = sent()[0] as Extract<ViewMsg, { type: 'setRules' }>;
    expect(msg.type).toBe('setRules');
    const r = msg.rules[0];
    expect(r.action).toEqual({ kind: 'throttle', latencyMs: 800, kbps: 64 });
    expect(r.times).toBe(2);
    expect(r.expiresAt! - before).toBeGreaterThanOrEqual(600_000 - 50);
    expect(r.expiresAt! - before).toBeLessThanOrEqual(600_000 + 1000);
    expect($('.rule-item .kind')!.textContent).toBe('throttle');
    expect($('.rule-item .rule-sub')!.textContent).toContain('Throttle (+800 ms, 64 kbps)');
    expect($('.rule-budget')!.textContent).toMatch(/2 of 2 left · expires in 9m 5\ds|2 of 2 left · expires in 10m 0s/);
  });

  it('fault rule: radios per fault kind, invalid lifetime blocks saving', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    await click(button(/^Rules/));
    await click(button(/Add rule/));
    const form = $('.rule-editor')!;
    await type(form.querySelector('input.mono')!, '*');
    await click(Array.from(form.querySelectorAll('label.radio')).find((l) => l.textContent === 'Fault')!.querySelector('input')!);
    const dns = Array.from(form.querySelectorAll('label.radio')).find((l) => l.textContent?.startsWith('DNS failure'))!.querySelector('input')!;
    await click(dns);
    expect(form.textContent).toContain('failed host lookup');
    const times = Array.from(form.querySelectorAll('label.field')).find((l) => l.querySelector('span')?.textContent === 'Only first N requests')!.querySelector('input')!;
    await type(times, '0');
    expect(button('Add rule', form).disabled).toBe(true);
    await type(times, '1');
    await click(button('Add rule', form));
    const r = (sent()[0] as Extract<ViewMsg, { type: 'setRules' }>).rules[0];
    expect(r.action).toEqual({ kind: 'fault', fault: 'dns' });
    expect(r.times).toBe(1);
    expect(r.expiresAt).toBeUndefined();
  });

  it('rules list shows remaining uses (from listed traffic) and a spent state', async () => {
    const r = rule({ id: 'lim', times: 2, action: { kind: 'fault', fault: 'reset' } });
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex({ matchedRuleId: 'lim', state: 'blocked' })], rules: [r], status });
    await click(button(/^Rules/));
    expect($('.rule-budget')!.textContent).toContain('1 of 2 left');
    expect($('.rule-item .rule-sub')!.textContent).toContain('Fault: connection reset');
    await emit({ type: 'exchange', exchange: ex({ matchedRuleId: 'lim', state: 'blocked' }) });
    expect($('.rule-budget.spent')!.textContent).toContain('0 of 2 left');
  });
});

describe('filter language in the toolbar (WP4)', () => {
  it('tokens filter the list; invalid tokens flag the box; the hint explains the syntax', async () => {
    await mount();
    await emit({
      type: 'snapshot', rules: [], status, exchanges: [
        cart(), ex({ id: 'g', url: 'https://api.example.com/users', responseBody: { text: '{"name":"Ada"}', encoding: 'utf8' } }),
        ex({ id: 'f', url: 'https://api.example.com/feed', status: 503 }),
      ],
    });
    const box = $<HTMLInputElement>('.filter-text')!;
    expect(box.getAttribute('title')).toContain('body:token');
    expect(box.placeholder).toContain('m:POST');
    await type(box, 'm:post body:qty');
    expect($$('.row').map((r) => r.id)).toEqual(['ex-cart1']);
    await type(box, '-s:5xx body:ada');
    expect($$('.row').map((r) => r.id)).toEqual(['ex-g']);
    await type(box, 's:5xx');
    expect($$('.row').map((r) => r.id)).toEqual(['ex-f']);
    await type(box, 's:boom');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('title')).toContain('s:boom');
    expect($$('.row')).toHaveLength(3);
  });
});
