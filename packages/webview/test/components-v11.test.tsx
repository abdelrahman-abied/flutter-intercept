// @vitest-environment happy-dom
// v0.11.0 UI (CONTRACTS §17.2 / §17.3 / §17.4 / §17.6): paused gRPC calls (rows, the message editor prefilled from
// `grpcDecoded.paused` → messageJson / message / drop / abort, the status editor → status + trailers, a new pause
// unlocking the editor), dropped / edited markers, breakpoint and mutate offered for gRPC (rule editor, row menu,
// "mutate this field" on decoded response messages), and gRPC calls in recordings — plus the pure helpers.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, Frame, GrpcDecoded, GrpcPause, HostMsg, RecordingSummary, Status, ViewMsg } from '../src/protocol';
import { appliesToGrpc, grpcActionNote, grpcPauseKey, grpcPauseTitle, grpcVersion, pausedDecoded } from '../src/grpc';
import { interceptOff } from '../src/components/actions';
import { isRecordable, recordingCountText, recordingCounts, streamCountText } from '../src/scenarios';
import { initialState, reducer } from '../src/state';
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
});

const T0 = 1_700_000_000_000;
const msg = (dir: Frame['dir'], at: number, over: Partial<Frame> = {}): Frame =>
  ({ dir, at: T0 + at, kind: 'message', size: 5, base64: 'CgNBZGE=', ...over });
const HELD = 'CgI0MhIDQWRh';
const messagePause: GrpcPause = { kind: 'message', dir: 'receive', index: 0, base64: HELD, size: 9 };
const statusPause: GrpcPause = { kind: 'status', code: 0, trailers: { 'grpc-status': '0', 'x-trace': 't-1' } };

const paused = (over: Partial<Exchange> = {}): Exchange => ex({
  id: 'p1',
  startedAt: T0,
  method: 'POST',
  url: 'http://10.0.2.2:50051/demo.Users/GetUser',
  kind: 'grpc',
  requestHeaders: { 'content-type': 'application/grpc' },
  responseHeaders: { 'content-type': 'application/grpc' },
  responseBody: undefined,
  durationMs: undefined,
  state: 'paused-response',
  pausedAt: Date.now(),
  pauseDeadline: Date.now() + 120_000,
  grpc: { service: 'demo.Users', method: 'GetUser', messagesSent: 1, messagesReceived: 0 },
  frames: [msg('send', 3)],
  grpcPause: messagePause,
  ...over,
});
const decoded = (over: Partial<GrpcDecoded> = {}): GrpcDecoded => ({
  framesDropped: 0,
  method: { requestType: 'demo.GetUserRequest', responseType: 'demo.User', clientStreaming: false, serverStreaming: false },
  messages: [{ dir: 'send', via: 'schema', json: '{\n  "id": "42"\n}', hex: '0a023432', size: 4 }],
  paused: { index: 0, dir: 'receive', via: 'schema', json: '{\n  "id": "42",\n  "name": "Ada"\n}', hex: '', size: 9 },
  ...over,
});
const withGrpc: Status = { ...status, grpc: { enabled: true, decryptHosts: [], schema: { methods: 3, messages: 7, problems: [] } } };

async function openPaused(e: Exchange = paused()) {
  await mount();
  await emit({ type: 'snapshot', exchanges: [e], rules: [], status: withGrpc });
}
const jsonBox = () => $<HTMLTextAreaElement>('textarea[aria-label="Held message (JSON)"]');
const b64Box = () => $<HTMLTextAreaElement>('textarea[aria-label="Held message (base64)"]');
const editor = () => $('.grpc-pause-editor')!;

describe('pure helpers (CONTRACTS §17)', () => {
  it('pause identity, title, decoded match; a new pause is a new decode version', () => {
    const p = paused();
    expect(grpcPauseKey(p)).toBe(`m:receive:0:9:${p.pausedAt}`);
    expect(grpcPauseKey(ex())).toBe('');
    expect(grpcPauseTitle(messagePause)).toBe('Paused on message 1 the server sends — before it reaches the app.');
    expect(grpcPauseTitle(statusPause)).toMatch(/end of the call/);
    expect(pausedDecoded(p, decoded())?.json).toContain('Ada');
    expect(pausedDecoded(p, decoded({ paused: { ...decoded().paused!, index: 1 } }))).toBeUndefined();
    expect(pausedDecoded({ grpcPause: statusPause }, decoded())).toBeUndefined();
    expect(grpcVersion(p)).not.toBe(grpcVersion({ ...p, grpcPause: statusPause }));
  });

  it('breakpoint and mutate apply to gRPC; no note for them; the row menu offers Break', () => {
    expect(appliesToGrpc({ kind: 'breakpoint', phase: 'both' })).toBe(true);
    expect(appliesToGrpc({ kind: 'sequence', steps: [{ action: { kind: 'mutate', ops: [] } }] })).toBe(true);
    expect(grpcActionNote('breakpoint')).toBeUndefined();
    expect(grpcActionNote('mutate')).toBeUndefined();
    expect(interceptOff(paused({ state: 'completed' })).breakpoint).toBeUndefined();
  });

  it('a new pause in the same phase unlocks the editor (resolving cleared)', () => {
    let s = reducer(initialState(), { type: 'host', msgs: [{ type: 'snapshot', exchanges: [paused()], rules: [], status }] });
    s = reducer(s, { type: 'resolving', id: 'p1' });
    s = reducer(s, { type: 'host', msgs: [{ type: 'exchange', exchange: paused({ grpcPause: statusPause }) }] });
    expect(s.resolving.p1).toBeUndefined();
  });

  it('recordings keep finished gRPC calls and count them', () => {
    const g = paused({ state: 'completed', grpcPause: undefined });
    expect(isRecordable(g)).toBe(true);
    expect(isRecordable(paused())).toBe(false);
    const c = recordingCounts([ex(), g]);
    expect(c).toEqual({ exchanges: 2, streams: 0, frames: 0, grpc: 1 });
    expect(streamCountText(c)).toBe('1 gRPC call');
    const rec: RecordingSummary = { id: 'r', name: 'n', createdAt: 0, exchanges: 12, redacted: false, streams: 1, frames: 4, grpc: 3 };
    expect(recordingCountText(rec)).toBe('12 exchanges · 1 WebSocket / SSE · 4 frames · 3 gRPC calls');
  });
});

describe('paused gRPC calls', () => {
  it('row looks like a paused HTTP row: badge, countdown, no status yet', async () => {
    await openPaused();
    const row = $$('.row')[0];
    expect(row.classList.contains('st-paused-response')).toBe(true);
    expect($('.state', row)!.textContent).toBe('paused res');
    expect($('.c-dur .countdown', row)).not.toBeNull();
    expect($('.c-status', row)!.textContent).toBe('…');
  });

  it('message pause: decodes on open, JSON prefilled; Resume with edit → messageJson; the next pause unlocks', async () => {
    await openPaused();
    expect($('.tabs [aria-selected="true"]')!.textContent).toBe('Response');
    expect(lastOf('decodeGrpc')).toEqual({ type: 'decodeGrpc', id: 'p1' });
    expect(editor().textContent).toContain('Paused on message 1 the server sends');
    expect($('.grpc-pause-loading')).not.toBeNull();
    expect(b64Box()!.value).toBe(HELD); // until the decode arrives
    await emit({ type: 'grpcDecoded', id: 'p1', decoded: decoded() });
    expect(jsonBox()!.value).toBe('{\n  "id": "42",\n  "name": "Ada"\n}');
    expect(button(/Resume with edit/).disabled).toBe(true);
    await type(jsonBox()!, '{"id": "42", "name": "Grace"}');
    await click(button(/Resume with edit/));
    expect(lastOf('resume')).toEqual({ type: 'resume', id: 'p1', edit: { messageJson: { id: '42', name: 'Grace' } } });
    expect(editor().textContent).toContain('Sent — waiting for the proxy…');
    // The proxy holds the end of the call next: a status editor, unlocked, and a new decode.
    const before = all('decodeGrpc').length;
    await emit({ type: 'exchange', exchange: paused({ grpcPause: statusPause, pausedAt: Date.now() + 1 }) });
    expect(all('decodeGrpc').length).toBe(before + 1);
    expect(editor().getAttribute('aria-label')).toBe('Edit the end of the gRPC call');
    expect(button('Resume unchanged').disabled).toBe(false);
  });

  it('invalid JSON blocks the edit; base64 mode → message; Drop; Abort; Resume unchanged', async () => {
    await openPaused();
    await emit({ type: 'grpcDecoded', id: 'p1', decoded: decoded() });
    await type(jsonBox()!, '{oops');
    expect($('.grpc-pause-editor .msg.error')!.textContent).toMatch(/not valid JSON/);
    expect(button(/Resume with edit/).disabled).toBe(true);
    await click($$('input[name="grpc-pause-mode"]')[1]);
    await type(b64Box()!, 'CgI0Mw==');
    await click(button(/Resume with edit/));
    expect(lastOf('resume')).toEqual({ type: 'resume', id: 'p1', edit: { message: 'CgI0Mw==' } });

    await emit({ type: 'exchange', exchange: paused({ pausedAt: Date.now() + 5 }) });
    await click(button('Drop message'));
    expect(lastOf('resume')).toEqual({ type: 'resume', id: 'p1', edit: { drop: true } });

    await emit({ type: 'exchange', exchange: paused({ pausedAt: Date.now() + 10 }) });
    await click(button('Resume unchanged'));
    expect(lastOf('resume')).toEqual({ type: 'resume', id: 'p1' });

    await emit({ type: 'exchange', exchange: paused({ pausedAt: Date.now() + 15 }) });
    await click(button(/Abort/, editor()));
    expect(lastOf('abort')).toEqual({ type: 'abort', id: 'p1' });
  });

  it('without a schema decode only base64 edits are possible', async () => {
    await openPaused();
    await emit({ type: 'grpcDecoded', id: 'p1', decoded: decoded({ paused: { index: 0, dir: 'receive', via: 'raw', json: '{"1": "42"}', hex: '', size: 9 } }) });
    expect(($$('input[name="grpc-pause-mode"]')[0] as HTMLInputElement).disabled).toBe(true);
    expect(b64Box()).not.toBeNull();
    expect(editor().textContent).toContain('No schema for this message');
  });

  it('a request-message pause shows on the Request tab', async () => {
    await openPaused(paused({ state: 'paused-request', grpcPause: { kind: 'message', dir: 'send', index: 2, base64: HELD, size: 9 } }));
    expect($('.tabs [aria-selected="true"]')!.textContent).toBe('Request');
    expect(editor().textContent).toContain('Paused on message 3 the app sends');
  });

  it('status pause: code, message and custom trailers → status + trailers; reserved trailers refused', async () => {
    await openPaused(paused({ grpcPause: statusPause }));
    const names = () => $$('.grpc-pause-editor .he-name') as HTMLInputElement[];
    expect(names().map((n) => n.value)).toEqual(['x-trace']); // grpc-status comes from the field
    await choose($('select[aria-label="gRPC status"]')!, '14');
    await type($$('.grpc-pause-editor label.field input')[0], 'maintenance');
    await click(button(/Resume with edit/));
    expect(lastOf('resume')).toEqual({ type: 'resume', id: 'p1', edit: { status: { code: 14, message: 'maintenance' } } });

    await emit({ type: 'exchange', exchange: paused({ grpcPause: statusPause, pausedAt: Date.now() + 20 }) });
    await type(names()[0], 'grpc-message');
    expect(editor().textContent).toMatch(/Trailer “grpc-message” is set by the proxy/);
    expect(button(/Resume with edit/).disabled).toBe(true);
    await type(names()[0], 'x-debug');
    await click(button(/Resume with edit/));
    expect(lastOf('resume')).toEqual({ type: 'resume', id: 'p1', edit: { status: { code: 0 }, trailers: { 'x-debug': 't-1' } } });
  });
});

describe('Messages tab, breakpoints and mutate on gRPC', () => {
  const done = (over: Partial<Exchange> = {}) => paused({
    state: 'completed', grpcPause: undefined, pausedAt: undefined, pauseDeadline: undefined, durationMs: 40,
    grpc: { service: 'demo.Users', method: 'GetUser', statusCode: 0, messagesSent: 1, messagesReceived: 2 },
    frames: [msg('send', 3), msg('receive', 10, { dropped: true }), msg('receive', 20, { edited: true })],
    ...over,
  });

  it('dropped / edited markers in the list and the message detail', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [done()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    const rows = $$('.frame-row');
    expect($('.dropped-badge', rows[1])!.textContent).toBe('dropped');
    expect(rows[1].classList.contains('fr-dropped')).toBe(true);
    expect($('.edited-badge', rows[2])!.textContent).toBe('edited');
    await click(rows[2]);
    expect($('.grpc-message .edited-badge')).not.toBeNull();
  });

  it('"mutate this field" from a decoded response message posts mutateField', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [done({ frames: [msg('send', 3), msg('receive', 20)], grpc: { service: 'demo.Users', method: 'GetUser', statusCode: 0, messagesSent: 1, messagesReceived: 1 } })], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await emit({ type: 'grpcDecoded', id: 'p1', decoded: decoded({ paused: undefined, messages: [
      { dir: 'send', via: 'schema', json: '{"id": "42"}', hex: '', size: 4 },
      { dir: 'receive', via: 'schema', json: '{"id": "42", "name": "Ada"}', hex: '', size: 9 },
    ] }) });
    await click($$('.frame-row')[1]);
    const field = $$('.j-row[data-path]').find((x) => (x as HTMLElement).dataset.path === '$.name')!;
    await contextMenu(field);
    await click(button('Make null in next responses'));
    expect(lastOf('mutateField')).toEqual({ type: 'mutateField', id: 'p1', path: '$.name', op: 'null' });
    // A request message's tree has no mutate menu (mutate rules change response messages).
    await click($$('.frame-row')[0]);
    expect($('.grpc-message')!.textContent).toContain('"42"');
    expect($$('.j-row[data-path]')).toHaveLength(0);
    expect($('.grpc-message')!.textContent).not.toContain('Right-click a field');
  });

  it('Break on this is offered for a gRPC call (detail and row menu)', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [done()], rules: [], status: withGrpc });
    await contextMenu($$('.row')[0]);
    expect(menuItem(/Break on this/).disabled).toBe(false);
    await click(menuItem(/Break on this/));
    expect(lastOf('createRuleFromExchange')).toEqual({ type: 'createRuleFromExchange', id: 'p1', action: 'breakpoint' });
  });

  it('rule editor: no "skip" note for breakpoint and mutate on a gRPC URL', async () => {
    await mount({ view: 'rules', editingRuleId: '__new__' });
    await emit({ type: 'snapshot', exchanges: [done()], rules: [], status: withGrpc });
    const url = $$('label.field').find((l) => l.querySelector('span')?.textContent === 'URL')!.querySelector('input')!;
    await type(url, 'http://*/demo.Users/*');
    expect($('.grpc-rule-note')).not.toBeNull(); // the default kind (mock) doesn't apply
    for (const label of ['Breakpoint', 'Mutate JSON']) {
      await click($$('label.radio').find((l) => l.textContent === label)!.querySelector('input')!);
      expect($('.grpc-rule-note'), label).toBeNull();
      expect($('.rule-editor')!.textContent).toContain('Matches 1 of the 1 exchanges');
    }
    expect($('.rule-editor')!.textContent).toContain('On gRPC calls the paths apply to each response message');
  });

  it('recordings list shows gRPC counts', async () => {
    await mount({ view: 'recordings' });
    await emit({ type: 'snapshot', exchanges: [done()], rules: [], status: withGrpc },
      { type: 'recordings', recordings: [{ id: 'r1', name: 'Checkout', createdAt: T0, exchanges: 9, redacted: false, grpc: 4 }] });
    expect($('.rec-sub')!.textContent).toContain('9 exchanges · 4 gRPC calls');
  });
});
