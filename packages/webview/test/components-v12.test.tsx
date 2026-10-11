// @vitest-environment happy-dom
// v0.12.0 (CONTRACTS §18): rewrite trailers + reserved gRPC metadata, scripts / map remote / rewrite on gRPC (notes,
// "Rewrite / Script / Map remote for this…" templates), Resend and Edit & resend for gRPC calls (JSON per message when
// the schema decodes, base64 otherwise) and the initiator badge on resent calls — pure helpers and UI.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, Frame, GrpcDecoded, HostMsg, Rule, Status, ViewMsg } from '../src/protocol';
import { grpcActionNote, grpcMetadataError, grpcRewriteNote, reservedGrpcMetadata } from '../src/grpc';
import { describeRewrite, emptyRewriteForm, grpcRewriteError, rewriteError, rewriteFromForm, rewriteToForm } from '../src/scenarios';
import { scriptCodeError } from '../src/scripts';
import { interceptOff, ruleTemplateFor } from '../src/components/actions';
import {
  composerFromExchange, composeSend, grpcComposerErrors, grpcUnsendable, resendRequest, ruleToForm, validateRuleForm,
} from '../src/state';
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
async function contextMenu(el: Element) {
  await act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })); });
}
const menuItem = (label: RegExp) => $$('[role="menuitem"]').find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement;
const sent = () => posted.filter((m) => m.type !== 'ready');
const lastOf = <T extends ViewMsg['type']>(t: T) => sent().filter((m) => m.type === t).at(-1) as Extract<ViewMsg, { type: T }> | undefined;
const field = (label: string, scope: ParentNode = root) =>
  ($$('label.field', scope).find((l) => l.querySelector('span')?.textContent?.startsWith(label))?.querySelector('input') ?? null) as HTMLInputElement | null;

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
  ({ dir, at: T0 + at, kind: 'message', size: 4, base64: 'CgI0Mg==', ...over });
const URL_G = 'http://10.0.2.2:50051/demo.Users/GetUser';
const call = (over: Partial<Exchange> = {}): Exchange => ex({
  id: 'g1', startedAt: T0, method: 'POST', url: URL_G, kind: 'grpc',
  requestHeaders: { 'content-type': 'application/grpc', te: 'trailers', 'grpc-encoding': 'gzip', authorization: 'Bearer t', 'x-user': 'ada' },
  responseHeaders: { 'content-type': 'application/grpc' }, responseBody: undefined, responseTrailers: { 'grpc-status': '0' },
  grpc: { service: 'demo.Users', method: 'GetUser', statusCode: 0, messagesSent: 1, messagesReceived: 1 },
  frames: [msg('send', 2), msg('receive', 30, { base64: 'CgNBZGE=', size: 5 })],
  ...over,
});
const decoded = (over: Partial<GrpcDecoded> = {}): GrpcDecoded => ({
  framesDropped: 0,
  messages: [
    { dir: 'send', via: 'schema', json: '{\n  "id": "42"\n}', hex: '', size: 4 },
    { dir: 'receive', via: 'schema', json: '{\n  "name": "Ada"\n}', hex: '', size: 5 },
  ],
  ...over,
});
const withGrpc: Status = { ...status, grpc: { enabled: true, decryptHosts: [], schema: { methods: 1, messages: 2, problems: [] } } };
const entry = (d: GrpcDecoded) => ({ key: 'k', base: 0, requestedAt: 0, decoded: d, answeredKey: 'k', answeredBase: 0 });

describe('pure helpers (CONTRACTS §18)', () => {
  it('rewrite trailers round-trip, describe, validation', () => {
    const a = { kind: 'rewrite' as const, response: { setTrailers: { 'x-env': 'dev' }, removeTrailers: ['x-debug'] } };
    const f = rewriteToForm(a);
    expect(f.setTrailers).toEqual([{ name: 'x-env', value: 'dev' }]);
    expect(f.removeTrailers).toBe('x-debug');
    expect(rewriteFromForm(f)).toEqual(a);
    expect(describeRewrite(a)).toBe('Rewrite: response trailers (2)');
    expect(rewriteError(f)).toBeUndefined();
    expect(rewriteError({ ...emptyRewriteForm(), setTrailers: [{ name: 'grpc-status', value: '0' }] })).toMatch(/“grpc-status” can't be changed on gRPC calls/);
    expect(rewriteError({ ...emptyRewriteForm(), removeTrailers: ':status' })).toMatch(/reserved/);
    expect(rewriteError({ ...emptyRewriteForm(), setTrailers: [{ name: 'x-trace-bin', value: 'not base64!' }] })).toMatch(/-bin value must be base64/);
    expect(rewriteError(emptyRewriteForm())).toMatch(/header or trailer/);
    // Pre-0.12 drafts without the trailer fields still work.
    expect(rewriteError({ request: { setHeaders: [{ name: 'x-a', value: '1' }], removeHeaders: '', replaceBody: [] }, response: emptyRewriteForm().response, status: '' })).toBeUndefined();
  });

  it('reserved gRPC metadata in headers: refused on gRPC URLs only', () => {
    expect(reservedGrpcMetadata('grpc-timeout')).toBe(true);
    expect(reservedGrpcMetadata('grpc-status-details-bin')).toBe(true); // REVIEW-12
    expect(rewriteError({ ...emptyRewriteForm(), removeTrailers: 'grpc-status-details-bin' })).toMatch(/reserved/);
    expect(reservedGrpcMetadata('Content-Type')).toBe(true);
    expect(reservedGrpcMetadata('authorization')).toBe(false);
    expect(grpcMetadataError('x-ok', 'v', 'Header')).toBeUndefined();
    const f = { ...emptyRewriteForm(), request: { setHeaders: [{ name: 'content-type', value: 'x' }], removeHeaders: '', replaceBody: [] } };
    expect(grpcRewriteError(f)).toMatch(/Request header “content-type” can't be changed on gRPC calls/);
    const form = (url: string) => ({ ...ruleToForm(), url, kind: 'rewrite' as const, rewrite: f });
    expect(validateRuleForm(form('http://*/demo.Users/*')).errors.rewrite).toMatch(/content-type/);
    expect(validateRuleForm(form('https://api.example.com/*')).errors.rewrite).toBeUndefined();
  });

  it('notes: replaceBody / status don\'t apply to gRPC; mock and cors skip gRPC calls; scripts accept gRPC hooks', () => {
    expect(grpcRewriteNote({ response: { status: 503 } })).toMatch(/The status change is skipped/);
    expect(grpcRewriteNote({ request: { replaceBody: [{}] }, response: { status: 503 } })).toMatch(/Body replacements and the status change are skipped/);
    expect(grpcRewriteNote({ response: {} })).toBeUndefined();
    for (const k of ['rewrite', 'script', 'mapRemote']) expect(grpcActionNote(k), k).toBeUndefined();
    expect(grpcActionNote('mock')).toMatch(/use a gRPC mock/);
    expect(grpcActionNote('cors')).toMatch(/browser requests/);
    expect(scriptCodeError('function onGrpcMessage(m, c) { return undefined; }')).toBeUndefined();
    expect(scriptCodeError('const x = 1;')).toMatch(/onGrpcMessage/);
  });

  it('resend: recorded request messages, metadata without the proxy-owned headers; refused when a message was cut', () => {
    const c = call();
    expect(interceptOff(c).edit).toBeUndefined();
    expect(resendRequest(c)).toEqual({ method: 'POST', url: URL_G, headers: { authorization: 'Bearer t', 'x-user': 'ada' }, grpc: { messages: ['CgI0Mg=='] } });
    const cut = call({ frames: [msg('send', 2, { truncated: true })] });
    expect(resendRequest(cut)).toBeUndefined();
    expect(grpcUnsendable(cut)).toMatch(/Request message 1 was cut at 64 KB/);
    expect(grpcUnsendable(call({ grpc: { ...c.grpc!, messagesSent: 3 } }))).toMatch(/Only 1 of the 3 request messages were kept/);
    expect(resendRequest(call({ state: 'pending' }))).toBeUndefined();
  });

  it('edit & resend: JSON per message when the schema decodes them all, else base64; send / errors', () => {
    const json = composerFromExchange(call(), entry(decoded()));
    expect(json.grpc).toEqual({ mode: 'json', json: ['{\n  "id": "42"\n}'], base64: ['CgI0Mg=='] });
    expect(json.draft.headers.map((h) => h.name)).toEqual(['authorization', 'x-user']);
    expect(composeSend(json)).toEqual({ method: 'POST', url: URL_G, headers: { authorization: 'Bearer t', 'x-user': 'ada' }, grpc: { messagesJson: [{ id: '42' }] } });
    const raw = composerFromExchange(call(), entry(decoded({ messages: [{ dir: 'send', via: 'raw', json: '{"1": "42"}', hex: '', size: 4 }] })));
    expect(raw.grpc).toEqual({ mode: 'base64', base64: ['CgI0Mg=='] });
    expect(composeSend(raw).grpc).toEqual({ messages: ['CgI0Mg=='] });
    expect(composerFromExchange(call()).grpc?.mode).toBe('base64');
    expect(grpcComposerErrors(json)).toEqual([]);
    expect(grpcComposerErrors({ ...json, grpc: { ...json.grpc!, json: ['{oops', ''] } })).toEqual([
      expect.stringMatching(/^Message 1: not valid JSON/), 'Message 2: enter a JSON object, e.g. {}',
    ]);
    expect(grpcComposerErrors({ ...raw, draft: { ...raw.draft, url: 'http://h:1/notgrpc' } })).toEqual(['URL path must be /package.Service/Method']);
  });

  it('rule templates: gRPC = exactly this method; HTTP = the route', () => {
    const t = ruleTemplateFor(call(), 'mapRemote');
    expect(t).toMatchObject({ name: 'Map /demo.Users/GetUser', match: { method: 'POST', url: URL_G }, action: { kind: 'mapRemote', to: '' } });
    expect(ruleTemplateFor(ex({ url: 'https://api.example.com/users/42?x=1' }), 'rewrite'))
      .toMatchObject({ name: 'Rewrite GET /users/42', match: { method: 'GET', url: 'https://api.example.com/users/42*' }, action: { kind: 'rewrite' } });
  });
});

describe('Resend / Edit & resend for gRPC calls', () => {
  it('Resend posts the recorded messages with resentFrom; the resent call gets the initiator badge', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await click(button('Resend', $('.detail-actions')!));
    expect(lastOf('send')).toEqual({ type: 'send', resentFrom: 'g1', request: {
      method: 'POST', url: URL_G, headers: { authorization: 'Bearer t', 'x-user': 'ada' }, grpc: { messages: ['CgI0Mg=='] },
    } });
    await emit({ type: 'sent', id: 'g2' }, { type: 'exchange', exchange: call({ id: 'g2', initiator: 'editor', resentFrom: 'g1' }) });
    expect($('.row.selected')!.id).toBe('ex-g2');
    expect($('.sent-badge', $$('.row')[1])!.textContent).toBe('resent');
    expect($('.detail-facts')!.textContent).toContain('Resent by the editor');
  });

  it('Resend is off with a reason when a request message was cut; Edit and resend stays on', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call({ frames: [msg('send', 2, { sizeUnknown: true })] })], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    const bar = $('.detail-actions')!;
    expect(button('Resend', bar).disabled).toBe(true);
    expect(button('Resend', bar).title).toMatch(/cut at 64 KB.*Edit and resend/);
    expect(button(/Edit and resend/, bar).disabled).toBe(false);
  });

  it('Edit and resend: JSON editor prefilled from the decode; add a message; Send → messagesJson', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await emit({ type: 'grpcDecoded', id: 'g1', decoded: decoded() });
    await click(button(/Edit and resend/, $('.detail-actions')!));
    const editor = $('.grpc-composer')!;
    expect(editor.textContent).toContain(`from ${URL_G}`);
    expect($('.hint', editor)!.textContent).toMatch(/^\s*Sent through the proxy like app traffic: rules and the network profile apply/);
    expect($<HTMLTextAreaElement>('textarea[aria-label="Request message 1"]')!.value).toBe('{\n  "id": "42"\n}');
    expect($$('.grpc-composer .he-name').map((i) => (i as HTMLInputElement).value)).toEqual(['authorization', 'x-user']);
    await click(button('+ Add message', editor));
    expect(button('Send', editor).disabled).toBe(false); // the new entry is "{}"
    await type($('textarea[aria-label="Request message 2"]')!, '{oops');
    expect($('.grpc-composer .msg.error')!.textContent).toMatch(/Message 2: not valid JSON/);
    expect(button('Send', editor).disabled).toBe(true);
    await type($('textarea[aria-label="Request message 2"]')!, '{"id": "43"}');
    await click(button('Send', editor));
    expect(lastOf('send')).toEqual({ type: 'send', resentFrom: 'g1', request: {
      method: 'POST', url: URL_G, headers: { authorization: 'Bearer t', 'x-user': 'ada' }, grpc: { messagesJson: [{ id: '42' }, { id: '43' }] },
    } });
    expect($('.grpc-composer')!.textContent).toContain('Sending…');
  });

  it('without a schema decode: base64 only; remove a message', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call({ frames: [msg('send', 1), msg('send', 2, { base64: 'CgI0Mw==' })], grpc: { ...call().grpc!, messagesSent: 2 } })], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await click(button(/Edit and resend/, $('.detail-actions')!));
    expect(($$('input[name="grpc-send-mode"]')[0] as HTMLInputElement).disabled).toBe(true);
    expect($<HTMLTextAreaElement>('textarea[aria-label="Request message 2"]')!.value).toBe('CgI0Mw==');
    await click(button('', $$('.grpc-composer .grpc-msg-row')[0]));
    await click(button('Send', $('.grpc-composer')!));
    expect(lastOf('send')!.request.grpc).toEqual({ messages: ['CgI0Mw=='] });
  });
});

describe('rewrite / script / map remote on gRPC', () => {
  it('"Rewrite this…" opens an unsaved rule for exactly this method; trailers save as setTrailers', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await click(button(/More rules/, $('.detail-actions')!));
    await click(menuItem(/Rewrite this/));
    expect($('.rule-editor')!.getAttribute('aria-label')).toBe('New rule');
    expect(field('Name')!.value).toBe('Rewrite /demo.Users/GetUser');
    expect(field('URL')!.value).toBe(URL_G);
    expect(field('Method')!.value).toBe('POST');
    expect($('.grpc-rule-note')).toBeNull();
    expect(sent().filter((m) => m.type === 'setRules')).toEqual([]); // nothing saved yet
    const trailers = $$('.rewrite-editor .headers-editor').at(-1)!;
    await click(button('+ Add header', trailers));
    await type($('.he-name', trailers)!, 'grpc-status');
    expect($('.rewrite-editor .msg.error')!.textContent).toMatch(/“grpc-status” can't be changed on gRPC calls/);
    await type($('.he-name', trailers)!, 'x-env');
    await type($('.he-value', trailers)!, 'staging');
    await click(button('Add rule', $('.re-actions')!));
    const saved = lastOf('setRules')!.rules[0];
    expect(saved).toMatchObject({ name: 'Rewrite /demo.Users/GetUser', match: { method: 'POST', url: URL_G },
      action: { kind: 'rewrite', response: { setTrailers: { 'x-env': 'staging' } } } });
  });

  it('a gRPC rewrite with a status change gets the "metadata only" note', async () => {
    const r: Rule = rule({ id: 'rw', match: { url: 'http://*/demo.Users/*' }, action: { kind: 'rewrite', response: { status: 503, setHeaders: { 'x-a': '1' } } } });
    await mount({ view: 'rules', editingRuleId: 'rw' });
    await emit({ type: 'snapshot', exchanges: [call()], rules: [r], status: withGrpc });
    expect($('.grpc-rewrite-note')!.textContent).toMatch(/only the metadata parts apply: The status change is skipped/);
  });

  it('script and map remote templates from the row menu; cors still notes the skip', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [call()], rules: [], status: withGrpc });
    await contextMenu($$('.row')[0]);
    await click(menuItem(/Script for this/));
    expect(field('Name')!.value).toBe('Script /demo.Users/GetUser');
    expect($('.rule-editor')!.textContent).toContain('onGrpcMessage(message, context)');
    expect($('.grpc-rule-note')).toBeNull();
    await click(button('Cancel', $('.re-actions')!));
    await click(button('Traffic'));
    await contextMenu($$('.row')[0]);
    await click(menuItem(/Map this to another server/));
    expect(field('Name')!.value).toBe('Map /demo.Users/GetUser');
    expect($('.rule-editor')!.textContent).toContain('gRPC calls go to the new server over HTTP/2');
    await click($$('label.radio').find((l) => l.textContent === 'CORS (dev only)')!.querySelector('input')!);
    expect($('.grpc-rule-note')!.textContent).toMatch(/browser requests/);
  });
});
