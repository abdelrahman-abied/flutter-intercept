// @vitest-environment happy-dom
// v0.13.0 (CONTRACTS §19.1 / §19.2): gRPC-Web calls shown as gRPC (badge, text variant, HTTP side + CORS preflight
// link, which actions apply, HTTP-level breakpoints in the HTTP editor), "Copy as grpcurl" for every gRPC row (and no
// cURL / Dart / Dio there), the `grpc:web` filter and `t:grpc` including gRPC-Web.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, Frame, HostMsg, Rule, Status, ViewMsg } from '../src/protocol';
import { findPreflight, GRPC_TUNNEL_HINT, grpcTitle, isGrpcWeb, isNativeGrpc, simTrustFailures, simTrustSummary } from '../src/grpc';
import { interceptOff } from '../src/components/actions';
import { countMatches, EMPTY_FILTERS, filterExchanges, ruleStats, snippetFormatsFor, SNIPPET_LABEL } from '../src/state';
import { parseFilter } from '../src/filter';
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
async function contextMenu(el: Element) {
  await act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })); });
}
const menuItems = () => $$('[role="menuitem"]') as HTMLButtonElement[];
const menuItem = (label: RegExp) => menuItems().find((b) => label.test(b.textContent ?? ''))!;
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

const T0 = 1_700_000_000_000;
const URL_W = 'http://localhost:8080/demo.Users/GetUser';
const msg = (dir: Frame['dir'], at: number): Frame => ({ dir, at: T0 + at, kind: 'message', size: 4, base64: 'CgI0Mg==' });
const preflight = (over: Partial<Exchange> = {}): Exchange => ex({
  id: 'pre', startedAt: T0 - 5, method: 'OPTIONS', url: URL_W, status: 204, requestHeaders: { origin: 'http://localhost:5000' },
  responseBody: undefined, cors: { preflight: true }, ...over,
});
const web = (over: Partial<Exchange> = {}): Exchange => ex({
  id: 'w1', startedAt: T0, method: 'POST', url: URL_W, kind: 'grpc', status: 200,
  requestHeaders: { 'content-type': 'application/grpc-web+proto', origin: 'http://localhost:5000', 'x-grpc-web': '1' },
  requestBody: { text: 'AAAAAAQKAjQy', encoding: 'base64' },
  responseHeaders: { 'content-type': 'application/grpc-web+proto', 'access-control-allow-origin': 'http://localhost:5000' },
  responseBody: { text: 'AAAAAAUKA0FkYQ==', encoding: 'base64' },
  responseTrailers: { 'grpc-status': '0' },
  grpc: { service: 'demo.Users', method: 'GetUser', statusCode: 0, messagesSent: 1, messagesReceived: 1, web: 'binary' },
  frames: [msg('send', 2), msg('receive', 20)],
  ...over,
});
const h2 = (over: Partial<Exchange> = {}): Exchange => web({
  id: 'g1', url: 'http://10.0.2.2:50051/demo.Users/GetUser', requestHeaders: { 'content-type': 'application/grpc' },
  requestBody: undefined, responseBody: undefined, grpc: { service: 'demo.Users', method: 'GetUser', statusCode: 0, messagesSent: 1, messagesReceived: 1 },
  ...over,
});
const withGrpc: Status = { ...status, grpc: { enabled: true, decryptHosts: [], schema: { methods: 1, messages: 2, problems: [] } } };

describe('pure helpers (CONTRACTS §19)', () => {
  it('gRPC-Web vs HTTP/2 gRPC; title; preflight lookup', () => {
    expect(isGrpcWeb(web())).toBe(true);
    expect(isNativeGrpc(web())).toBe(false);
    expect(isNativeGrpc(h2())).toBe(true);
    expect(grpcTitle(web({ grpc: { ...web().grpc!, web: 'text' } }))).toMatch(/^gRPC-Web \(text\) · demo.Users\/GetUser/);
    const all = [preflight(), preflight({ id: 'other', url: 'http://localhost:8080/demo.Users/List' }), web()];
    expect(findPreflight(all, web())?.id).toBe('pre');
    expect(findPreflight([web()], web())).toBeUndefined();
  });

  it('snippets: grpcurl only for gRPC rows', () => {
    expect(snippetFormatsFor(h2())).toEqual(['grpcurl']);
    expect(snippetFormatsFor(web())).toEqual(['grpcurl']);
    expect(snippetFormatsFor(ex())).toEqual(['curl', 'dart_http', 'dio']);
    expect(SNIPPET_LABEL.grpcurl).toBe('grpcurl');
  });

  it('actions: HTTP-level tools apply to gRPC-Web, message-level ones come later', () => {
    const off = interceptOff(web());
    expect(off.mock).toBeUndefined();
    expect(off.block).toBeUndefined();
    expect(off.breakpoint).toBeUndefined();
    expect(off.copy).toBeUndefined();
    expect(off.rules).toBeUndefined();
    expect(off.script).toMatch(/Message-level tools for gRPC-Web come later/);
    expect(off.edit).toMatch(/come later/);
    expect(interceptOff(h2()).script).toBeUndefined();
  });

  it('every HTTP rule counts for gRPC-Web calls (no gRPC skip)', () => {
    const rules: Rule[] = [rule({ id: 'm', match: { url: '*/demo.Users/*' }, action: { kind: 'mock', status: 200, body: '' } })];
    expect(ruleStats(rules, [web(), h2()])).toEqual([{ matches: 1, wins: 1 }]);
    expect(countMatches({ url: '*/demo.Users/*' }, [web(), h2()], true)).toBe(1);
  });

  it('filter: t:grpc includes gRPC-Web; grpc:web', () => {
    const list = [web(), h2(), ex({ id: 'h' })];
    const ids = (text: string) => filterExchanges(list, { ...EMPTY_FILTERS, text }).map((e) => e.id);
    expect(ids('t:grpc')).toEqual(['w1', 'g1']);
    expect(ids('grpc:web')).toEqual(['w1']);
    expect(ids('kind:grpc -grpc:web')).toEqual(['g1']);
    expect(parseFilter('grpc:nope').errors[0]).toMatch(/stream or web/);
  });
});

describe('gRPC-Web in the panel', () => {
  it('row: gRPC-Web badge (+ text), path, status code name', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [web(), web({ id: 'w2', grpc: { ...web().grpc!, web: 'text' } })], rules: [], status: withGrpc });
    const [bin, text] = $$('.row');
    expect($('.kb-grpc', bin)!.textContent?.trim()).toBe('gRPC-Web');
    expect($('.grpc-text-badge', bin)).toBeNull();
    expect($('.grpc-text-badge', text)!.textContent).toBe('text');
    expect($('.c-path', bin)!.textContent).toContain('/demo.Users/GetUser');
    expect($('.c-status', bin)!.textContent).toBe('OK');
  });

  it('detail: HTTP side with the preflight link and the "come later" note; CORS diagnosis shown', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [preflight(), web({ cors: { problem: 'no Access-Control-Allow-Origin for http://localhost:5000' } })], rules: [], status: withGrpc });
    await click($$('.row')[1]);
    const block = $('.grpc-status-block')!;
    expect($('.grpc-web-badge', block)!.textContent).toBe('gRPC-Web');
    expect(block.textContent).toContain('HTTP 200');
    expect($('.grpc-web-note', block)!.textContent).toMatch(/message-level tools for gRPC-Web .* come later/);
    expect($('.cors')!.textContent).toContain('no Access-Control-Allow-Origin');
    await click(button(/preflight OPTIONS 204/, block));
    expect($('.row.selected')!.id).toBe('ex-pre');
  });

  it('Request / Response tabs keep the HTTP body (frames as sent)', async () => {
    await mount({ detailTab: 'response' });
    await emit({ type: 'snapshot', exchanges: [web()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    await click(button('Response'));
    expect($('.grpc-web-body summary')!.textContent).toContain('HTTP body');
    await click(button('Request'));
    expect($('.grpc-web-body')).not.toBeNull();
  });

  it('actions: Mock → grpcMock, Break on this, grpcurl copy; Script / Resend come later', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [web()], rules: [], status: withGrpc });
    await click($$('.row')[0]);
    const bar = $('.detail-actions')!;
    expect(button('Resend', bar).disabled).toBe(true);
    expect(button('Resend', bar).title).toMatch(/come later/);
    await click(button('Mock this', bar));
    expect(lastOf('createRuleFromExchange')).toEqual({ type: 'createRuleFromExchange', id: 'w1', action: 'grpcMock' });
    await contextMenu($$('.row')[0]);
    expect(menuItems().map((b) => b.textContent)).not.toContain('Copy as cURL');
    expect(menuItem(/Script for this/).disabled).toBe(true);
    expect(menuItem(/Rewrite this/).disabled).toBe(false);
    expect(menuItem(/Map this/).disabled).toBe(false);
    expect(menuItem(/Break on this/).disabled).toBe(false);
    await click(menuItem(/Copy as grpcurl/));
    expect(lastOf('copySnippet')).toEqual({ type: 'copySnippet', id: 'w1', format: 'grpcurl' });
  });

  it('an HTTP-level breakpoint on a gRPC-Web call opens the HTTP editor', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [web({ state: 'paused-request', status: undefined, responseHeaders: undefined, responseBody: undefined,
      pausedAt: Date.now(), pauseDeadline: Date.now() + 60_000 })], rules: [], status: withGrpc });
    expect($('.pause-editor')!.getAttribute('aria-label')).toBe('Edit paused request');
    expect($('.grpc-pause-editor')).toBeNull();
  });

  it('HTTP/2 gRPC rows copy as grpcurl only', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [h2()], rules: [], status: withGrpc });
    await contextMenu($$('.row')[0]);
    expect(menuItems().filter((b) => /^Copy as/.test(b.textContent ?? '')).map((b) => b.textContent)).toEqual(['Copy as grpcurl']);
    await click(menuItem(/Copy as grpcurl/));
    expect(lastOf('copySnippet')).toEqual({ type: 'copySnippet', id: 'g1', format: 'grpcurl' });
    expect($('.notice')!.textContent).toContain('Copied as grpcurl');
  });

  it('rule editor: a route whose gRPC matches are all gRPC-Web gets no "skip" note', async () => {
    await mount({ view: 'rules', editingRuleId: '__new__' });
    await emit({ type: 'snapshot', exchanges: [web()], rules: [], status: withGrpc });
    const url = $$('label.field').find((l) => l.querySelector('span')?.textContent === 'URL')!.querySelector('input')!;
    await act(() => { (url as HTMLInputElement).value = 'http://localhost:8080/demo.Users/*'; url.dispatchEvent(new Event('input', { bubbles: true })); });
    expect($('.grpc-rule-note')).toBeNull();
    expect($('.rule-editor')!.textContent).toContain('Matches 1 of the 1 exchanges');
  });
});

describe('iOS simulator trust (CONTRACTS §19.3)', () => {
  const trust = (devices: NonNullable<NonNullable<Status['grpc']>['simulatorTrust']>['devices'], decryptAll = true): Status =>
    ({ ...withGrpc, grpc: { ...withGrpc.grpc!, simulatorTrust: { devices, decryptAll } } });

  it('pure: summary text and failures', () => {
    expect(simTrustSummary(undefined)).toBeUndefined();
    const s = simTrustSummary({ devices: [{ udid: 'AAAA-1', name: 'iPhone 17', state: 'trusted' }], decryptAll: true })!;
    expect(s.text).toBe('iPhone 17 trusts the Flutter Intercept CA until the session ends · decrypting all TLS gRPC');
    expect(s.title).toContain('flutterIntercept.grpc.trustOnSimulator');
    const two = simTrustSummary({ devices: [
      { udid: 'A', name: 'iPhone 17', state: 'trusted' }, { udid: 'BBBBBBBB-2', state: 'pre-existing' }, { udid: 'C', name: 'iPad', state: 'failed', problem: 'x' },
    ], decryptAll: false })!;
    expect(two.text).toBe('iPhone 17 and Simulator BBBBBBBB trust the Flutter Intercept CA until the session ends');
    expect(two.title).toContain('already trusted before; left in place');
    expect(simTrustFailures({ devices: [{ udid: 'C', name: 'iPad', state: 'failed', problem: 'unknown trust store schema' }], decryptAll: false }))
      .toEqual([{ key: 'C:unknown trust store schema', text: 'iPad couldn\'t be set to trust the Flutter Intercept CA: unknown trust store schema TLS gRPC from it stays undecrypted.' }]);
    expect(GRPC_TUNNEL_HINT).toContain('flutterIntercept.grpc.trustOnSimulator');
  });

  it('status line item; failed device as a dismissable warning banner', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status: trust([
      { udid: 'A', name: 'iPhone 17', state: 'trusted' }, { udid: 'C', name: 'iPad Air', state: 'failed', problem: 'unknown trust store schema' },
    ]) });
    expect($('.sim-trust-status')!.textContent).toBe('iPhone 17 trusts the Flutter Intercept CA until the session ends · decrypting all TLS gRPC');
    const banner = $('.sim-trust-failed')!;
    expect(banner.textContent).toContain('iPad Air couldn\'t be set to trust the Flutter Intercept CA: unknown trust store schema');
    await click(button('', banner));
    expect($('.sim-trust-failed')).toBeNull();
  });

  it('gRPC tunnel rows mention the simulator setting', async () => {
    await mount();
    const tun = ex({ id: 'tun', method: 'CONNECT', url: 'https://grpc.example.com:443/', kind: 'tunnel', grpcTunnel: true, status: undefined,
      requestHeaders: {}, responseHeaders: undefined, responseBody: undefined });
    await emit({ type: 'snapshot', exchanges: [tun], rules: [], status: withGrpc });
    expect($('.kb-grpc-tunnel')!.getAttribute('title')).toContain('on an iOS simulator, turn on flutterIntercept.grpc.trustOnSimulator');
    await click($$('.row')[0]);
    expect($('.tunnel')!.textContent).toContain('iOS simulator, turn on flutterIntercept.grpc.trustOnSimulator');
  });
});
