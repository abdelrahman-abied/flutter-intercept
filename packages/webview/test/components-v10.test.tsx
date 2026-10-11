// @vitest-environment happy-dom
// v0.10.0 UI (CONTRACTS §16.5): gRPC rows (badge, method path, status code name, streaming, counts), undecrypted gRPC
// tunnel rows, the detail pane (status block, headers + trailers, Messages tab with and without the host's
// `grpcDecoded`, one `decodeGrpc` per exchange version), actions that don't apply, "Mock this" → grpcMock, the
// grpcMock rule form (round trip, Skeleton button, sequence step) and the Status.grpc banner / status line.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, Frame, GrpcDecoded, HostMsg, Rule, Status, ViewMsg } from '../src/protocol';
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
const menuItem = (label: RegExp) => $$('[role="menuitem"]').find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement;
const sent = () => posted.filter((m) => m.type !== 'ready');
const all = <T extends ViewMsg['type']>(t: T) => sent().filter((m) => m.type === t) as Extract<ViewMsg, { type: T }>[];
const lastOf = <T extends ViewMsg['type']>(t: T) => all(t).at(-1);

beforeEach(() => {
  posted = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.restoreAllMocks();
});

const T0 = 1_700_000_000_000;
const msg = (dir: Frame['dir'], at: number, over: Partial<Frame> = {}): Frame =>
  ({ dir, at: T0 + at, kind: 'message', size: 5, base64: 'CgNBZGE=', ...over });

const call = (over: Partial<Exchange> = {}): Exchange => ex({
  id: 'g1',
  startedAt: T0,
  method: 'POST',
  url: 'http://10.0.2.2:50051/demo.Users/GetUser',
  kind: 'grpc',
  requestHeaders: { 'content-type': 'application/grpc', te: 'trailers', 'x-user': 'ada' },
  responseHeaders: { 'content-type': 'application/grpc' },
  responseBody: undefined,
  responseTrailers: { 'grpc-status': '0', 'x-trace': 't-1' },
  grpc: { service: 'demo.Users', method: 'GetUser', statusCode: 0, messagesSent: 1, messagesReceived: 1, deadlineMs: 5000 },
  frames: [msg('send', 12), msg('receive', 40, { size: 12, compressed: true })],
  ...over,
});
const failed = (over: Partial<Exchange> = {}) => call({
  id: 'g2',
  url: 'http://10.0.2.2:50051/demo.Users/ListUsers',
  responseTrailers: undefined,
  grpc: { service: 'demo.Users', method: 'ListUsers', statusCode: 14, statusMessage: 'Flutter Intercept: connect ECONNREFUSED', trailersOnly: true, messagesSent: 1, messagesReceived: 0, deadlineMs: 5000 },
  frames: [msg('send', 3)],
  ...over,
});
const stream = (over: Partial<Exchange> = {}) => call({
  id: 'g3',
  url: 'http://10.0.2.2:50051/demo.Chat/Talk',
  state: 'pending',
  responseTrailers: undefined,
  durationMs: undefined,
  grpc: { service: 'demo.Chat', method: 'Talk', messagesSent: 2, messagesReceived: 3 },
  frames: [msg('send', 1), msg('receive', 2), msg('send', 3), msg('receive', 4), msg('receive', 5)],
  ...over,
});
const decoded = (over: Partial<GrpcDecoded> = {}): GrpcDecoded => ({
  framesDropped: 0,
  method: { requestType: 'demo.GetUserRequest', responseType: 'demo.User', clientStreaming: false, serverStreaming: false, file: 'lib/gen/users.pbgrpc.dart' },
  messages: [
    { dir: 'send', via: 'schema', json: '{\n  "id": "42"\n}', hex: '0a 02 34 32', size: 4 },
    { dir: 'receive', via: 'schema', json: '{\n  "id": "42",\n  "name": "Ada"\n}', hex: '0a0234321203416461', size: 9 },
  ],
  skeletons: { request: '{\n  "id": ""\n}', response: '{\n  "id": "",\n  "name": "",\n  "roles": []\n}' },
  ...over,
});
const withGrpc: Status = { ...status, grpc: { enabled: true, decryptHosts: ['*.corp.example'], schema: { methods: 3, messages: 7, problems: [] } } };

describe('gRPC rows (CONTRACTS §16.5)', () => {
  it('badge, method path, status code name, counts, streaming marker', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call(), failed(), stream()], rules: [], status: withGrpc });
    const [ok, bad, open] = $$('.row');
    expect($('.kb-grpc', ok)!.textContent).toBe('gRPC');
    expect($('.c-path', ok)!.textContent).toBe('gRPC/demo.Users/GetUser');
    expect($('.c-status', ok)!.textContent).toBe('OK');
    expect($('.c-status .grpc-status', ok)!.classList.contains('gs-ok')).toBe(true);
    expect($('.c-size', ok)!.textContent).toBe('↑1 ↓1');
    expect($('.stream-badge', ok)).toBeNull();
    expect($('.c-status', bad)!.textContent).toBe('UNAVAILABLE');
    expect($('.c-status .grpc-status', bad)!.classList.contains('gs-err')).toBe(true);
    expect($('.c-status .grpc-status', bad)!.getAttribute('title')).toBe('gRPC status 14 UNAVAILABLE — Flutter Intercept: connect ECONNREFUSED (trailers-only response)');
    expect($('.c-status', open)!.textContent).toBe('…');
    expect($('.stream-badge', open)).not.toBeNull();
    expect($('.c-size', open)!.textContent).toBe('↑2 ↓3');
  });

  it('an undecrypted gRPC tunnel: lock, "gRPC", the decryptHosts hint; only Block applies', async () => {
    await mount();
    const tun = ex({ id: 'tun', method: 'CONNECT', url: 'https://grpc.example.com:443/', kind: 'tunnel', grpcTunnel: true, status: undefined,
      requestHeaders: {}, responseHeaders: undefined, responseBody: undefined, tunnelBytes: { sent: 900, received: 4096 } });
    await emit({ type: 'snapshot', exchanges: [tun], rules: [], status: withGrpc });
    const row = $$('.row')[0];
    const badge = $('.kb-grpc-tunnel', row)!;
    expect(badge.querySelector('svg.icon-lock')).not.toBeNull();
    expect(badge.textContent).toBe('gRPC');
    expect(badge.getAttribute('title')).toContain('gRPC over TLS, not decrypted — add the host to flutterIntercept.grpc.decryptHosts if the app trusts the Flutter Intercept CA in debug');
    expect($('.c-path', row)!.getAttribute('title')).toContain('flutterIntercept.grpc.decryptHosts');
    await contextMenu(row);
    expect(menuItem(/Mock this/).disabled).toBe(true);
    expect(menuItem(/Mock this/).title).toMatch(/gRPC over TLS, not decrypted/);
    expect(menuItem(/Block this/).disabled).toBe(false);
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await click(row);
    expect($('.grpc-tunnel-note')!.textContent).toContain('flutterIntercept.grpc.decryptHosts');
    const body = $('.tunnel')!;
    expect(body.getAttribute('aria-label')).toBe('gRPC over TLS');
    expect(body.textContent).toContain('add grpc.example.com to flutterIntercept.grpc.decryptHosts');
    expect(body.textContent).toContain('*.corp.example');
    expect(body.textContent).not.toContain('flutterIntercept.tlsPassthrough');
  });

  it('filter grpc:unavailable and t:grpc from the toolbar', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call(), failed(), ex({ id: 'h' })], rules: [], status: withGrpc });
    await type($('input.filter-text')!, 'grpc:unavailable');
    expect($$('.row').map((r) => r.id)).toEqual(['ex-g2']);
    await type($('input.filter-text')!, 't:grpc');
    expect($$('.row').map((r) => r.id)).toEqual(['ex-g1', 'ex-g2']);
    await type($('input.filter-text')!, '-grpc:ok');
    expect($$('.row').map((r) => r.id)).toEqual(['ex-g2', 'ex-h']);
  });
});

describe('gRPC detail pane', () => {
  it('opens on Messages, shows the status prominently, posts decodeGrpc once per version', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [failed()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    expect($$('.tabs [role="tab"]').map((t) => t.textContent)).toEqual(['Request', 'Response', 'Messages (1)', 'Timing']);
    expect($('.tabs [aria-selected="true"]')!.textContent).toBe('Messages (1)');
    const block = $('.grpc-status-block')!;
    expect(block.classList.contains('gsb-err')).toBe(true);
    expect($('.grpc-method', block)!.textContent).toBe('/demo.Users/ListUsers');
    expect(block.textContent).toContain('14 UNAVAILABLE — Flutter Intercept: connect ECONNREFUSED');
    expect(block.textContent).toContain('deadline 5 s');
    expect(block.textContent).toContain('trailers-only');
    expect(all('decodeGrpc')).toEqual([{ type: 'decodeGrpc', id: 'g2' }]);
    // An unrelated update re-renders without asking again.
    await emit({ type: 'status', status: { ...withGrpc, sessions: 2 } });
    await click($$('.row')[0]);
    expect(all('decodeGrpc')).toHaveLength(1);
    // Snippets, resend, breakpoints, generators and the token preset don't apply.
    const bar = $('.detail-actions')!;
    expect(button('Expire token…', bar).disabled).toBe(true);
    expect(button('Resend', bar).disabled).toBe(false); // CONTRACTS §18.4
    expect(button('Break on this', bar).disabled).toBe(false); // CONTRACTS §17.2
    expect(button(/Copy as/, bar).disabled).toBe(true);
    expect(button(/Copy as/, bar).title).toMatch(/not gRPC calls/);
    expect(button(/Edit and resend/, bar).disabled).toBe(false);
    expect(button(/Generate/, bar).disabled).toBe(true);
    expect(button('Block this', bar).disabled).toBe(false);
  });

  it('a live stream asks again when a message arrives', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [stream()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    expect(all('decodeGrpc')).toHaveLength(1);
    const s = stream();
    await emit({ type: 'exchange', exchange: { ...s, grpc: { ...s.grpc!, messagesReceived: 4 }, frames: [...s.frames!, msg('receive', 6)] } });
    expect(all('decodeGrpc')).toHaveLength(2);
    expect($('.tabs [aria-selected="true"]')!.textContent).toBe('Messages (6)');
    expect($('.tab-dot.live')).not.toBeNull();
  });

  it('Messages tab: loading, then decoded JSON / text / hex per message; compressed marker; filter on the JSON', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    expect($('.grpc-decode-note')!.textContent).toBe('Decoding messages…');
    const rows = () => $$('.frame-row');
    expect(rows()).toHaveLength(2);
    expect($('.fr-preview', rows()[0])!.textContent).toBe('5 bytes (protobuf)');
    expect($('.gz-badge', rows()[1])).not.toBeNull();
    expect($('.fr-time', rows()[1])!.textContent).toBe('+0.040 s');
    await emit({ type: 'grpcDecoded', id: 'g1', decoded: decoded() });
    expect($('.grpc-decode-note')).toBeNull();
    expect($('.grpc-types')!.textContent).toBe('demo.GetUserRequest → demo.User · unary');
    expect($('.fr-preview', rows()[1])!.textContent).toBe('gz{ "id": "42", "name": "Ada" }');
    await click(rows()[1]);
    const detail = $('.grpc-message')!;
    expect(detail.textContent).toContain('decoded with the app\'s schema');
    expect(detail.textContent).toContain('compressed');
    expect($$('.seg-btn', detail).map((b) => b.textContent)).toEqual(['JSON', 'Text', 'Hex', 'Base64']);
    expect(detail.textContent).toContain('"Ada"');
    await click(button('Hex', detail));
    expect($('.hexdump', detail)!.textContent).toContain('0a 02 34 32 12 03 41 64 61');
    await click(button('Base64', detail));
    expect($('.grpc-base64', detail)!.textContent).toBe('CgNBZGE=');
    await type($('input.frames-filter')!, 'ada');
    expect(rows()).toHaveLength(1);
    expect($('.fr-preview', rows()[0])!.textContent).toContain('Ada');
  });

  it('a message whose decompression stopped at the cap shows "≥ 64.0 kB" with the compressed size', async () => {
    await mount();
    const big = msg('receive', 40, { size: 30_000, compressed: true, sizeUnknown: true, base64: btoa('x'.repeat(65_536)), truncated: true });
    await emit({ type: 'snapshot', exchanges: [call({ frames: [msg('send', 12), big] })], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    const size = $('.fr-size', $$('.frame-row')[1])!;
    expect(size.textContent).toBe('≥ 64.0 kB');
    expect(size.getAttribute('title')).toBe('compressed size 30,000 bytes; the full size wasn\'t measured');
    await click($$('.frame-row')[1]);
    const meta = $$('.grpc-message .meta-item').find((m) => m.textContent === '≥ 64.0 kB')!;
    expect(meta.getAttribute('title')).toMatch(/compressed size 30,000 bytes/);
  });

  it('raw fields (no schema) and a decode problem', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await emit({ type: 'grpcDecoded', id: 'g1', decoded: {
      framesDropped: 0,
      problem: 'The app\'s schema has no method /demo.Users/GetUser — showing raw fields.',
      messages: [
        { dir: 'send', via: 'raw', json: '{\n  "1": "42"\n}', hex: '0a023432', size: 4 },
        { dir: 'receive', via: 'raw', json: '{\n  "2": "Ada"\n}', hex: '1203416461', size: 5 },
      ],
    } });
    expect($('.grpc-decode-note')!.textContent).toContain('no method /demo.Users/GetUser');
    await click($$('.frame-row')[0]);
    const detail = $('.grpc-message')!;
    expect($$('.seg-btn', detail)[0].textContent).toBe('Raw fields');
    expect(detail.textContent).toContain('raw fields (no schema)');
  });

  it('falls back to hex / base64 when the host never answers (older host)', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    expect($('.grpc-decode-note')!.textContent).toBe('Decoding messages…');
    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real + 10_000);
    await emit({ type: 'status', status: { ...withGrpc, sessions: 3 } });
    expect($('.grpc-decode-note')!.textContent).toMatch(/No decoded view from the extension .* raw bytes/);
    await click($$('.frame-row')[0]);
    const detail = $('.grpc-message')!;
    expect($$('.seg-btn', detail).map((b) => b.textContent)).toEqual(['Hex', 'Base64']);
    expect($('.hexdump', detail)!.textContent).toContain('0a 03 41 64 61');
  });

  it('Request / Response tabs: metadata, trailers, messages hint (no body, no model check)', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await click(button('Response'));
    const body = $('.tab-body')!;
    expect($$('.section-title', body).map((h) => h.textContent)).toEqual(['Headers (metadata)', 'Trailers', 'Messages']);
    expect(body.textContent).toContain('x-trace');
    expect(body.textContent).toContain('1 message received from the server');
    expect($('.contract', body)).toBeNull();
    await click(button('Request'));
    expect($('.tab-body')!.textContent).toContain('x-user');
    expect($('.tab-body')!.textContent).toContain('1 message sent by the app');
    await click(button('see Messages'));
    expect($('.tabs [aria-selected="true"]')!.textContent).toBe('Messages (2)');
  });

  it('a trailers-only failure says where its status came from', async () => {
    await mount({ detailTab: 'response' });
    await emit({ type: 'snapshot', exchanges: [failed()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await click(button('Response'));
    expect($('.tab-body')!.textContent).toContain('Trailers-only response');
  });

  it('plain HTTP responses with trailers show them too', async () => {
    await mount({ detailTab: 'response' });
    await emit({ type: 'snapshot', exchanges: [ex({ id: 'h', responseTrailers: { 'server-timing': 'db;dur=53' } })], rules: [], status });
    await click($$('.row')[0]);
    expect($$('.section-title').map((h) => h.textContent)).toContain('Trailers');
    expect($('.tab-body')!.textContent).toContain('server-timing');
  });

  it('"Mock this" creates a grpcMock from the call and opens it in the rule editor', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await click(button('Mock this', $('.detail-actions')!));
    expect(lastOf('createRuleFromExchange')).toEqual({ type: 'createRuleFromExchange', id: 'g1', action: 'grpcMock' });
    const created = rule({ id: 'm1', match: { method: 'POST', url: 'http://10.0.2.2:50051/demo.Users/GetUser' },
      action: { kind: 'grpcMock', code: 0, messagesJson: [{ id: '42', name: 'Ada' }] } });
    await emit({ type: 'rules', rules: [created] });
    expect($('.rule-editor')).not.toBeNull();
    expect($<HTMLSelectElement>('select[aria-label="gRPC status"]')!.value).toBe('0');
    expect($<HTMLTextAreaElement>('textarea[aria-label="Message 1"]')!.value).toBe('{\n  "id": "42",\n  "name": "Ada"\n}');
    expect($('.notice')!.textContent).toContain('gRPC mock OK · 1 message');
  });
});

describe('grpcMock rule editor', () => {
  const grpcRule: Rule = rule({ id: 'r-g', name: 'Users down', match: { method: 'POST', url: 'http://*/demo.Users/*' },
    action: { kind: 'grpcMock', code: 14, message: 'down', messages: ['CgI0Mg=='] } });

  it('edits status, message, messages, delay; saves messagesJson for JSON entries', async () => {
    await mount({ view: 'rules', editingRuleId: 'r-g' });
    await emit({ type: 'snapshot', exchanges: [], rules: [grpcRule], status: withGrpc });
    expect($('.rule-name .kind-grpcMock')!.textContent).toBe('grpcMock');
    expect($('.rule-sub')!.textContent).toContain('gRPC mock UNAVAILABLE · 1 message');
    const select = $<HTMLSelectElement>('select[aria-label="gRPC status"]')!;
    expect(select.value).toBe('14');
    expect($$('option', select)).toHaveLength(17);
    const field = (label: RegExp) => $$('label.field').find((l) => label.test(l.querySelector('span')?.textContent ?? ''))!.querySelector('input')!;
    expect(field(/^Message/).value).toBe('down');
    // base64 entries round-trip
    expect($<HTMLTextAreaElement>('textarea[aria-label="Message 1"]')!.value).toBe('CgI0Mg==');
    await choose(select, '5');
    await click($$('input[type="radio"][name="rule-grpcFormat"]')[0]);
    await type($('textarea[aria-label="Message 1"]')!, '{oops');
    expect($('.grpc-mock-editor .msg.error')!.textContent).toMatch(/Message 1: not valid JSON/);
    expect(button('Save').disabled).toBe(true);
    await type($('textarea[aria-label="Message 1"]')!, '{"id": "7"}');
    await click(button('+ Add message'));
    await type($('textarea[aria-label="Message 2"]')!, '{"id": "8"}');
    const delay = $$('label.field').find((l) => l.querySelector('span')?.textContent === 'Delay (ms)')!.querySelector('input')!;
    await type(delay, '250');
    await click(button('Save'));
    expect(lastOf('setRules')!.rules[0].action).toEqual({
      kind: 'grpcMock', code: 5, message: 'down', messagesJson: [{ id: '7' }, { id: '8' }], delayMs: 250,
    });
  });

  it('refuses reserved trailers', async () => {
    await mount({ view: 'rules', editingRuleId: 'r-g' });
    await emit({ type: 'snapshot', exchanges: [], rules: [grpcRule], status: withGrpc });
    const editors = $$('.grpc-mock-editor .headers-editor');
    expect(editors).toHaveLength(2);
    await click(button('+ Add header', editors[1]));
    const names = $$('.grpc-mock-editor .he-name');
    await type(names[names.length - 1], 'grpc-status');
    expect($('.grpc-mock-editor')!.textContent).toMatch(/Trailer “grpc-status” is set by the proxy/);
  });

  it('Skeleton: decodes the last matching call on demand, then fills a message from the response type', async () => {
    const r = rule({ id: 'r-s', match: { method: 'POST', url: 'http://*/demo.Users/GetUser' }, action: { kind: 'grpcMock', code: 0, messagesJson: [{}] } });
    await mount({ view: 'rules', editingRuleId: 'r-s' });
    await emit({ type: 'snapshot', exchanges: [call()], rules: [r], status: withGrpc });
    await click(button('Skeleton'));
    expect(lastOf('decodeGrpc')).toEqual({ type: 'decodeGrpc', id: 'g1' });
    expect(button('Loading skeleton…').disabled).toBe(true);
    await emit({ type: 'grpcDecoded', id: 'g1', decoded: decoded() });
    await click(button('Skeleton'));
    expect($<HTMLTextAreaElement>('textarea[aria-label="Message 1"]')!.value).toBe('{\n  "id": "",\n  "name": "",\n  "roles": []\n}');
    // A second click adds another message (no empty one left).
    await click(button('Skeleton'));
    expect($$('.grpc-msg-row')).toHaveLength(2);
  });

  it('no Skeleton button without a matching gRPC call; schema warning without a schema', async () => {
    const r = rule({ id: 'r-n', match: { url: 'http://*/other.Svc/*' }, action: { kind: 'grpcMock' } });
    await mount({ view: 'rules', editingRuleId: 'r-n' });
    await emit({ type: 'snapshot', exchanges: [call()], rules: [r], status: { ...status, grpc: { enabled: true, decryptHosts: [] } } });
    expect($$('button').some((b) => b.textContent === 'Skeleton')).toBe(false);
    expect($('.grpc-no-schema')).not.toBeNull();
  });

  it('a new rule can pick gRPC mock; a sequence step can be a gRPC mock', async () => {
    await mount({ view: 'rules', editingRuleId: '__new__' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: withGrpc });
    const url = $$('label.field').find((l) => l.querySelector('span')?.textContent === 'URL')!.querySelector('input')!;
    await type(url, 'http://*/demo.Users/*');
    const radio = $$('label.radio').find((l) => l.textContent === 'Sequence')!.querySelector('input')!;
    await click(radio);
    await choose($('select[aria-label="Step 1 action"]')!, 'grpcMock');
    await choose($$('select[aria-label="gRPC status"]')[0], '14');
    await type($('textarea[aria-label="Message 1 (step1)"]')!, '');
    expect($('.seq-preview')!.textContent).toContain('gRPC UNAVAILABLE ×1 → real server from then on');
    expect($$('.rule-editor .msg.error').map((e) => e.textContent)).toEqual([]);
    await click(button('Add rule', $('.re-actions')!));
    expect(lastOf('setRules')!.rules[0].action).toEqual({
      kind: 'sequence', steps: [{ action: { kind: 'grpcMock', code: 14 }, count: 1 }, { action: { kind: 'passthrough' }, count: 1 }],
    });
  });

  it('notes that gRPC calls skip a rule whose action doesn\'t apply to them', async () => {
    await mount({ view: 'rules', editingRuleId: '__new__' });
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    const url = $$('label.field').find((l) => l.querySelector('span')?.textContent === 'URL')!.querySelector('input')!;
    await type(url, 'http://*/demo.Users/*');
    expect($('.grpc-rule-note')!.textContent).toMatch(/gRPC calls skip this rule/);
    expect($('.rule-editor')!.textContent).toContain('Matches 0 of the 1 exchanges');
    await click($$('label.radio').find((l) => l.textContent === 'gRPC mock')!.querySelector('input')!);
    expect($('.grpc-rule-note')).toBeNull();
    expect($('.rule-editor')!.textContent).toContain('Matches 1 of the 1 exchanges');
  });
});

describe('Status.grpc', () => {
  it('banner for the proxy problem (dismissable) and the status line item', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status: { ...withGrpc, grpc: { ...withGrpc.grpc!, problem: 'mockttp internals changed (h2 injection).' } } });
    const banner = $('.grpc-problem')!;
    expect(banner.textContent).toContain('gRPC calls can\'t be decoded: mockttp internals changed (h2 injection).');
    const item = $('.grpc-status-item')!;
    expect(item.textContent).toBe('gRPC: 3 methods · 1 decrypt host · 1 problem');
    expect(item.classList.contains('has-problem')).toBe(true);
    expect(item.getAttribute('title')).toContain('• *.corp.example');
    await click(button('', banner));
    expect($('.grpc-problem')).toBeNull();
  });

  it('nothing shown without gRPC status', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status });
    expect($('.grpc-problem')).toBeNull();
    expect($('.grpc-status-item')).toBeNull();
  });
});
