// @vitest-environment happy-dom
// v0.8.0 UI (CONTRACTS §14): TLS passthrough tunnel rows + detail, status line (VS Code proxy, passthrough hosts,
// client certificates), the client certificate badge, upload bandwidth in the throttle editors, WebSocket / SSE in
// recordings, and the `bypass` warning banner.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, Frame, HostMsg, RecordingSummary, Status, ViewMsg } from '../src/protocol';
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
async function click(el: Element) { await act(() => { (el as HTMLElement).click(); }); }
async function type(el: Element, value: string) {
  await act(() => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(el: Element, value: string) {
  await act(() => { (el as HTMLSelectElement).value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function contextMenu(el: Element) {
  await act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })); });
}
const field = (label: string, scope: ParentNode = root) =>
  ($$('label.field', scope).find((l) => l.querySelector('span')?.textContent === label)?.querySelector('input') ?? null) as HTMLInputElement | null;
const menuItem = (label: RegExp) => $$('[role="menuitem"]').find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement;
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

const tunnel = (over: Partial<Exchange> = {}) => ex({
  id: 'tun', method: 'CONNECT', url: 'https://pay.bank.example:443/', kind: 'tunnel', status: undefined, requestHeaders: {},
  responseHeaders: undefined, responseBody: undefined, durationMs: 85, tunnelBytes: { sent: 1229, received: 46_080 }, ...over,
});
const withPassthrough: Status = { ...status, tlsPassthrough: ['*.bank.example', 'pinned.example.com'] };

// ---------------------------------------------------------------- tunnels

describe('TLS passthrough tunnels (CONTRACTS §14.2)', () => {
  it('list row: lock badge, bytes sent / received instead of a size, no status code', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [tunnel(), ex()], rules: [], status: withPassthrough });
    const row = $$('.row')[0];
    expect(row.classList.contains('tunnel-row')).toBe(true);
    const badge = $('.kb-tunnel', row)!;
    expect(badge.querySelector('svg.icon-lock')).not.toBeNull();
    expect(badge.textContent).toBe('TLS');
    expect(badge.getAttribute('title')).toContain('TLS passthrough — not decrypted');
    expect($('.c-size', row)!.textContent).toBe('↑1.2k ↓45k');
    expect($('.c-size', row)!.getAttribute('title')).toContain('1.2 kB sent by the app');
    expect($('.c-status', row)!.textContent).toBe('—');
    expect($('.c-method', row)!.textContent).toBe('CONNECT');
  });

  it('context menu: only Block — Copy, Resend, Edit, Mock, Break, Generate are disabled', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [tunnel()], rules: [], status: withPassthrough });
    await contextMenu($$('.row')[0]);
    for (const label of [/Copy as cURL/, /^Resend$/, /Edit and resend/, /Mock this/, /Break on this/, /Generate Dart model/, /Generate test fixture/]) {
      expect(menuItem(label).disabled, String(label)).toBe(true);
    }
    expect(menuItem(/Copy as cURL/).title).toMatch(/not decrypted/);
    const block = menuItem(/Block this/);
    expect(block.disabled).toBe(false);
    await click(block);
    expect(lastOf('createRuleFromExchange')).toEqual({ type: 'createRuleFromExchange', id: 'tun', action: 'block' });
  });

  it('detail pane: Tunnel tab explains why and how to undo; actions other than Block are disabled', async () => {
    await mount({ detailTab: 'response' });
    await emit({ type: 'snapshot', exchanges: [tunnel()], rules: [], status: withPassthrough });
    await click($$('.row')[0]);
    const tabs = $$('.tabs [role="tab"]').map((t) => t.textContent);
    expect(tabs).toEqual(['Tunnel', 'Timing']);
    expect($('.detail-title .kb-tunnel')!.textContent).toBe('TLS passthrough — not decrypted');
    expect($('.tunnel-note')!.textContent).toContain('no rule applies except Block');
    const body = $('.tunnel')!;
    expect(body.textContent).toContain('pay.bank.example:443');
    expect(body.textContent).toContain('1.2 kB');
    expect(body.textContent).toContain('45.0 kB');
    expect(body.textContent).toContain('matches *.bank.example');
    expect(body.textContent).toContain('flutterIntercept.tlsPassthrough');
    expect(body.textContent).toMatch(/Remove \*\.bank\.example from/);
    for (const label of ['Mock this', 'Break on this', 'Expire token…', 'Resend']) expect(button(label, $('.detail-actions')!).disabled, label).toBe(true);
    expect(button(/Copy as/, $('.detail-actions')!).disabled).toBe(true);
    expect(button(/Edit and resend/, $('.detail-actions')!).disabled).toBe(true);
    expect(button(/Generate/, $('.detail-actions')!).disabled).toBe(true);
    const block = button('Block this', $('.detail-actions')!);
    expect(block.disabled).toBe(false);
    await click(block);
    expect(lastOf('createRuleFromExchange')).toMatchObject({ action: 'block' });
    // Timing still works.
    await click(button('Timing'));
    expect($('.timing')).not.toBeNull();
  });

  it('a normal exchange selected after a tunnel gets its own tabs back', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [tunnel(), ex({ id: 'h' })], rules: [], status: withPassthrough });
    await click($$('.row')[0]);
    await click($$('.row')[1]);
    expect($$('.tabs [role="tab"]').map((t) => t.textContent)).toEqual(['Request', 'Response', 'Timing']);
  });

  it('filter kind:tunnel shows only tunnels', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [tunnel(), ex(), ex()], rules: [], status });
    await type($('input.filter-text')!, 'kind:tunnel');
    expect($$('.row').length).toBe(1);
    expect($('.row .kb-tunnel')).not.toBeNull();
    expect($('input.filter-text')!.getAttribute('title')).toContain('kind:ws|sse|http|tunnel');
  });
});

// ---------------------------------------------------------------- status line

describe('status line (CONTRACTS §14.2, §14.3, §14.6)', () => {
  it('says "via VS Code proxy" when the upstream comes from http.proxy', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, upstreamProxy: 'proxy.corp:3128', upstreamProxySource: 'http.proxy' } });
    const item = $('.statusline .upstream-status')!;
    expect(item.textContent).toBe('via VS Code proxy proxy.corp:3128');
    expect(item.getAttribute('title')).toContain('http.proxy');
    expect($('.upstream-chip')!.textContent).toContain('via VS Code proxy proxy.corp:3128');
    await emit({ type: 'status', status: { ...status, upstreamProxy: '127.0.0.1:8888', upstreamProxySource: 'flutterIntercept' } });
    expect($('.statusline .upstream-status')!.textContent).toBe('via upstream proxy 127.0.0.1:8888');
  });

  it('counts passthrough hosts, listing them in the tooltip', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: withPassthrough });
    const item = $('.statusline .passthrough-status')!;
    expect(item.textContent).toBe('TLS passthrough: 2 hosts');
    expect(item.getAttribute('title')).toContain('• *.bank.example');
    expect(item.getAttribute('title')).toContain('• pinned.example.com');
    await emit({ type: 'status', status });
    expect($('.statusline .passthrough-status')).toBeNull();
  });

  it('lists client certificates by host pattern, problems first and highlighted', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, clientCertificates: [{ host: 'api.corp.example' }] } });
    let item = $('.statusline .cert-status')!;
    expect(item.classList.contains('has-problem')).toBe(false);
    expect(item.textContent).toBe('Client certificates: api.corp.example');
    await emit({ type: 'status', status: { ...status, clientCertificates: [
      { host: 'api.corp.example' }, { host: '*.bank.example', problem: 'Could not read bank.p12: wrong passphrase' },
      { host: 'a.example' }, { host: 'b.example' },
    ] } });
    item = $('.statusline .cert-status')!;
    expect(item.classList.contains('has-problem')).toBe(true);
    expect(item.textContent).toMatch(/^Client certificates \(1 problem\): ✕ \*\.bank\.example, api\.corp\.example, a\.example \+1$/);
    const bad = $('.cert-problem', item)!;
    expect(bad.textContent).toContain('*.bank.example');
    expect(bad.getAttribute('title')).toContain('wrong passphrase');
    expect(item.getAttribute('title')).toContain('Set Client Certificate Passphrase');
  });
});

// ---------------------------------------------------------------- client certificate badge

describe('client certificate badge (CONTRACTS §14.3)', () => {
  it('names the pattern in the request detail', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex({ clientCertificate: '*.corp.example' }), ex()], rules: [], status });
    await click($$('.row')[0]);
    const badge = $('.detail-title .cert-badge')!;
    expect(badge.textContent).toBe('client certificate: *.corp.example');
    expect(badge.getAttribute('title')).toContain('never leaves the proxy');
    await click($$('.row')[1]);
    expect($('.detail-title .cert-badge')).toBeNull();
  });
});

// ---------------------------------------------------------------- upload throttling

describe('upload bandwidth (CONTRACTS §14.4)', () => {
  it('custom network profile sends uploadKbps and the status line shows it', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    await choose($('select[aria-label="Network profile"]')!, 'custom');
    const dlg = $('.net-custom')!;
    await type(field('Download (kbps)', dlg)!, '800');
    await type(field('Upload (kbps)', dlg)!, '200');
    await click(button('Apply', dlg));
    expect(lastOf('setNetworkProfile')).toEqual({ type: 'setNetworkProfile', profile: { kind: 'throttle', latencyMs: 300, kbps: 800, uploadKbps: 200 } });
    await emit({ type: 'status', status: { ...status, networkProfile: { kind: 'throttle', latencyMs: 300, kbps: 800, uploadKbps: 200 } } });
    expect($('.statusline .net-status')!.textContent).toBe('Network: +300 ms, 800 kbps down / 200 up');
    // Editing it again keeps the upload value.
    await click(button('', $('.net-picker')!));
    expect(field('Upload (kbps)', $('.net-custom')!)!.value).toBe('200');
    await type(field('Upload (kbps)', $('.net-custom')!)!, '0');
    expect(button('Apply', $('.net-custom')!).disabled).toBe(true);
  });

  it('presets show their numbers (upload included) in the tooltip', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status,
      networkProfile: { kind: 'throttle', preset: 'fast-3g', latencyMs: 150, kbps: 1600, uploadKbps: 750 } } });
    const item = $('.statusline .net-status')!;
    expect(item.textContent).toBe('Network: Fast 3G');
    expect(item.getAttribute('title')).toContain('+150 ms, 1600 kbps down / 750 up');
  });

  it('throttle rule editor: upload field → action.uploadKbps, shown in the rule list', async () => {
    await mount({ view: 'rules' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    await click(button(/Add rule/));
    const form = $('.rule-editor')!;
    await type(form.querySelector('input.mono')!, 'https://api.example.com/upload*');
    const throttle = $$('label.radio', form).find((l) => l.textContent === 'Throttle')!.querySelector('input')!;
    await click(throttle);
    expect($('.rule-editor')!.textContent).toContain('upload paces request bodies');
    await type(field('Upload (kbps)', form)!, 'abc');
    expect($('.rule-editor')!.textContent).toContain('Upload: 1–1000000 kbps');
    await type(field('Upload (kbps)', form)!, '64');
    await click(button('Add rule', form));
    const msg = lastOf('setRules')!;
    expect(msg.rules[0].action).toEqual({ kind: 'throttle', latencyMs: 400, uploadKbps: 64 });
    expect($('.rule-item .rule-sub')!.textContent).toContain('Throttle (+400 ms, 64 kbps up)');
  });
});

// ---------------------------------------------------------------- recordings

describe('WebSocket / SSE in recordings (CONTRACTS §14.5)', () => {
  const frames = (n: number): Frame[] => Array.from({ length: n }, (_, i) => ({ dir: i % 2 ? 'send' : 'receive', at: i, kind: 'text', text: 'm', size: 1 }));
  const recs: (RecordingSummary & { streams?: number; frames?: number })[] = [
    { id: 'a', name: 'With streams', createdAt: 2, exchanges: 42, redacted: false, streams: 2, frames: 134 },
    { id: 'b', name: 'HTTP only', createdAt: 1, exchanges: 5, redacted: false },
  ];

  it('save form counts closed WebSocket / SSE streams and their frames', async () => {
    const list = [
      ex({ id: 'h' }),
      ex({ id: 'ws', kind: 'websocket', status: 101, frames: frames(12) }),
      ex({ id: 'sse', kind: 'sse', frames: frames(3) }),
      ex({ id: 'open', kind: 'websocket', status: 101, state: 'pending', frames: frames(4) }),
      tunnel(),
    ];
    await mount({ view: 'recordings' });
    await emit({ type: 'snapshot', exchanges: list, rules: [], status }, { type: 'recordings', recordings: recs });
    await click(button(/Save current traffic/));
    const form = $('.rec-save')!;
    expect(button(/^Save 3 exchanges$/, form)).not.toBeNull();
    expect($('.rec-streams', form)!.textContent).toBe('Includes 2 WebSocket / SSE · 15 frames.');
    expect(form.textContent).toContain('TLS passthrough tunnels');
    await click(button(/^Save 3/, form));
    expect($('.notice')!.textContent).toContain('(3 exchanges, 2 WebSocket / SSE · 15 frames)');
  });

  it('without streams, the save form says nothing about them', async () => {
    await mount({ view: 'recordings' });
    await emit({ type: 'snapshot', exchanges: [ex(), ex()], rules: [], status }, { type: 'recordings', recordings: [] });
    await click(button(/Save current traffic/));
    expect($('.rec-streams')).toBeNull();
  });

  it('recording rows show stream counts when the host reports them; replay explains streams', async () => {
    await mount({ view: 'recordings' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status }, { type: 'recordings', recordings: recs });
    const subs = $$('.rec-sub').map((s) => s.textContent ?? '');
    expect(subs[0]).toContain('42 exchanges · 2 WebSocket / SSE · 134 frames');
    expect(subs[1]).toMatch(/5 exchanges$/);
    await click(button(/Replay…/, $$('.rec-item')[0]));
    expect($('.rec-replay')!.textContent).toContain('WebSocket / SSE streams are answered locally');
  });
});

// ---------------------------------------------------------------- bypass warning

describe('bypass warning (CONTRACTS §14.7)', () => {
  it('renders like the other session warnings and can be dismissed', async () => {
    await mount();
    const text = 'Requests to api.example.com bypass the proxy — an HttpOverrides zone or a custom connectionFactory in the app.';
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, warnings: [
      { id: 'bypass:s1:api.example.com', kind: 'bypass', sessionId: 's1', text },
      { id: 'isolate:s1:w', kind: 'background-isolate', text: 'Isolate w is not intercepted.' },
    ] } });
    const banners = $$('.warning-banner');
    expect(banners.length).toBe(2);
    const b = banners[0];
    expect(b.classList.contains('wk-bypass')).toBe(true);
    expect(b.querySelector('.warning-icon')).not.toBeNull();
    expect(b.querySelector('.warning-text')!.textContent).toBe(text);
    expect(b.getAttribute('title')).toContain('never reached the proxy');
    await click(b.querySelector('button')!);
    expect($$('.warning-banner').length).toBe(1);
    expect($('.wk-bypass')).toBeNull();
  });
});
