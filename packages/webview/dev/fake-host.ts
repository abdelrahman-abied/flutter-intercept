/**
 * Dev harness: pretends to be the extension host so the webview runs in a plain browser.
 * Stubs acquireVsCodeApi(), answers every ViewMsg and streams realistic fake traffic through
 * a tiny simulated proxy that honours rules (mock / block / breakpoints) like the real one.
 *
 * URL params:  ?n=40 preloaded exchanges · ?ui={"view":"rules"} initial persisted UI state
 *               · ?rate=900 ms between new exchanges · ?stream=0
 *              ?empty=1 start with no traffic · ?theme=vscode-light|vscode-high-contrast
 *              ?bpTimeout=300000 breakpoint auto-resume · ?clientTimeout=120000 fake app gives up while paused
 *              ?max=1000 ring buffer (evictions are reported with a 'removed' message)
 *              ?lan=1 start with the iPhone LAN listener open (dev bar: open/close LAN)
 *              ?agent=connected|readOnly|off simulated Agent API status (dev bar cycles it; "connected" adds an
 *              "[agent] …" mock rule and fakes tool calls)
 *              ?net=offline|slow-3g|fast-3g|flaky start with that network profile
 *
 * v0.3.0 (CONTRACTS §9): exchanges carry a fake `source` (Dio / http stacks with async gaps) that arrives a moment
 * after the request, like the real trace side channel; `send` runs through the simulated proxy (initiator, resentFrom)
 * and is answered with `sent`; `setNetworkProfile` updates status and slows / fails pass-through traffic;
 * throttle / fault rules are simulated; rules with `times` / `expiresAt` are spent and removed like the host does.
 * `openSource` / `copySnippet` only log (plus an `error` for a request without a source or an SDK frame).
 *
 * Semantics follow CONTRACTS §3/§4: pausedAt/pauseDeadline while paused, auto-resume unedited at the
 * deadline, a client that gives up while paused → 'error' (late resume ignored), invalid edit → 'error'
 * message and the exchange stays paused, clear keeps in-flight exchanges and is followed by a snapshot,
 * createRuleFromExchange uses the proxy's ruleFromExchange and inserts the rule first.
 *
 * v0.4.0 (CONTRACTS §10): completed JSON exchanges get a fake `contract` result from a tiny model table (Product,
 * ProductPage, CartSummary, User; products sometimes come back with `image: null` → an error) — also re-sent after
 * every snapshot. `mutate` rules change the JSON response like the proxy (and set `simulated`); `mutateField`
 * inserts such a rule first; `pickModel` cycles the route through the models (then "don't check") and re-checks;
 * `openViolation` / `generateModel` / `generateFixture` only log (the webview shows its own notice).
 */
import type {
  Body, ContractSummary, Exchange, HostMsg, NetworkProfile, RequestEdit, ResponseEdit, Rule, SendDraft, Status, ViewMsg,
} from '../src/protocol';
import type { MutateOp, SourceInfo, StackFrame } from '@flutter-intercept/proxy/types';
import { applyOps } from '@flutter-intercept/proxy/jsonpath';
import { parsePath, formatPath } from '../src/jsonpath';
import { describeMutateOps } from '../src/state';
import { matches, ruleFromExchange } from '@flutter-intercept/proxy/rules';
import { describeProfile, presetProfile, type NetworkPresetId } from '@flutter-intercept/proxy/network';

const params = new URLSearchParams(location.search);

// ?seed=N makes the fake traffic reproducible (used for the README screenshots).
const random = (() => {
  const seed = params.get('seed');
  if (seed === null) return Math.random;
  let a = Number(seed) >>> 0;
  return () => { // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const PNG_16PX = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABlklEQVR42g3LQQEAIQgAQSMQwQhEIIIRjEAEIhjBCETguU8jGMEId/Of1hrS6A1tWGM0ZsMb0ViN3chGNU7jNl6jNUGELqhgwhCm4EIIS9hCCiUc4QpP/tCRTu9oxzqjMzveic7q7E52qnM6t/P6HxRRuqKKKUOZiiuhLGUrqZRylKs8/YMhRjfUMGMY03AjjGVsI40yjnGNZ38YyKAPdGCDMZgDH8RgDfYgBzU4gzt44w8TmfSJTmwyJnPik5isyZ7kpCZncidv/sERpzvqmDOc6bgTznK2k045x7nO8z8EEvRAAwtGMAMPIljBDjKo4AQ3ePGHhSz6Qhe2GIu58EUs1mIvclGLs7iLt/6wkU3f6MY2YzM3vonN2uxNbmpzNnfz9h8SSXqiiSUjmYknkaxkJ5lUcpKbvPxDIUUvtLBiFLPwIopV7CKLKk5xi1d/OMihH/Rgh3GYBz/EYR32IQ91OId7eOcPF7n0i17sMi7z4pe4rMu+5KUu53Iv7/7hIY/+0Ic9xmM+/BGP9diPfNTjPO7jPT6GdLgQ8hjYogAAAABJRU5ErkJggg==';

let seq = 0;
let exchanges: Exchange[] = [];
let status: Status = { proxyRunning: true, port: 8899, interceptEnabled: true, sessions: 1 };
let rules: Rule[] = [
  {
    id: 'rule_bp_cart', enabled: true, name: 'Inspect cart writes',
    match: { method: 'POST', url: 'https://api.shop.example.com/v1/cart/*' },
    action: { kind: 'breakpoint', phase: 'request' },
  },
  {
    id: 'rule_mock_flags', enabled: true, name: 'Feature flags (mock)',
    match: { url: '/\\/v1\\/flags(\\?.*)?$/' },
    action: { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{\n  "newCheckout": true,\n  "darkMode": false\n}', delayMs: 120 },
  },
  {
    id: 'rule_block_ads', enabled: true, name: 'No ads',
    match: { url: 'https://ads.*' },
    action: { kind: 'block', mode: 'reset' },
  },
  {
    id: 'rule_bp_me', enabled: false, name: 'Break on /me response',
    match: { method: 'GET', url: 'https://api.shop.example.com/v1/me' },
    action: { kind: 'breakpoint', phase: 'response' },
  },
  {
    id: 'rule_throttle_feed', enabled: true, name: 'Slow feed',
    match: { method: 'GET', url: 'https://api.shop.example.com/v1/feed' },
    action: { kind: 'throttle', latencyMs: 1200, kbps: 256 },
  },
  {
    id: 'rule_mutate_image', enabled: true, name: 'Product image → null (first 4)',
    match: { method: 'GET', url: 'https://api.shop.example.com/v1/products/*' },
    action: { kind: 'mutate', ops: [{ path: '$.image', op: 'null' }] }, times: 4,
  },
  {
    id: 'rule_fault_reco', enabled: true, name: 'Recommendations: DNS failure (first 3)',
    match: { url: 'https://api.shop.example.com/v1/recommendations*' },
    action: { kind: 'fault', fault: 'dns' }, times: 3, expiresAt: Date.now() + 10 * 60_000,
  },
];
/** Rule hit counts by id (the proxy keeps them across setRules; dropped when the id disappears). */
const hits = new Map<string, number>();
const isSpent = (r: Rule) => (r.times !== undefined && (hits.get(r.id) ?? 0) >= r.times) || (r.expiresAt !== undefined && r.expiresAt <= Date.now());
/** Host behaviour (CONTRACTS §9.4): a spent rule is removed and the new list broadcast. */
function removeSpentRules() {
  const keep = rules.filter((r) => !isSpent(r));
  if (keep.length === rules.length) return;
  rules = keep;
  for (const id of [...hits.keys()]) if (!rules.some((r) => r.id === id)) hits.delete(id);
  send({ type: 'rules', rules });
}
setInterval(removeSpentRules, 1000);

const BP_TIMEOUT = Number(params.get('bpTimeout') ?? 300_000);
const CLIENT_TIMEOUT = Number(params.get('clientTimeout') ?? 120_000);
const MAX = Number(params.get('max') ?? 1000);

interface PausedEntry { phase: 'request' | 'response'; resume: (edit?: RequestEdit | ResponseEdit) => void; settle: () => void }
/** Paused exchanges: what happens when the user resumes (or the timers fire). */
const paused = new Map<string, PausedEntry>();

// ---------------------------------------------------------------- transport

const send = (m: HostMsg) => window.postMessage(m, '*');
const lastEl = () => document.getElementById('dev-last');

function onViewMsg(msg: ViewMsg) {
  const el = lastEl();
  if (el) el.textContent = JSON.stringify(msg).slice(0, 160);
  console.info('[fake-host] ←', msg);
  switch (msg.type) {
    case 'ready':
      send({ type: 'snapshot', exchanges, rules, status });
      sendContracts(exchanges);
      break;
    case 'resume': {
      const p = paused.get(msg.id);
      if (!p) break; // not paused (finished, gave up, auto-resumed): no-op, like the proxy
      const problem = invalidEdit(msg.edit);
      if (problem) {
        send({ type: 'error', message: `Resume rejected: ${problem}. The exchange is still paused.` });
        break;
      }
      p.resume(msg.edit);
      break;
    }
    case 'abort': {
      const ex = find(msg.id);
      const p = paused.get(msg.id);
      if (ex && p) {
        p.settle();
        update(ex, { state: 'aborted', error: 'Aborted from breakpoint', durationMs: Date.now() - ex.startedAt, pausedAt: undefined, pauseDeadline: undefined });
      }
      break;
    }
    case 'setRules':
      rules = msg.rules;
      send({ type: 'rules', rules });
      break;
    case 'clear':
      // In-flight exchanges stay (like the proxy); the host follows 'cleared' with a fresh snapshot.
      exchanges = exchanges.filter((e) => e.state === 'pending' || paused.has(e.id));
      send({ type: 'cleared' });
      send({ type: 'snapshot', exchanges, rules, status });
      sendContracts(exchanges);
      break;
    case 'setInterceptEnabled':
      status = { ...status, interceptEnabled: msg.enabled };
      send({ type: 'status', status });
      break;
    case 'createRuleFromExchange': {
      const ex = find(msg.id);
      if (!ex) break;
      rules = [ruleFromExchange(ex, msg.action, `rule_${Date.now().toString(36)}`), ...rules]; // first, so it wins
      send({ type: 'rules', rules });
      break;
    }
    case 'send': {
      const problem = invalidSend(msg.request);
      if (problem) { send({ type: 'error', message: `Send failed: ${problem}` }); break; }
      const id = simulate(templateFor(msg.request), { initiator: 'editor', resentFrom: msg.resentFrom });
      send({ type: 'sent', id });
      break;
    }
    case 'openSource': {
      const ex = find(msg.id);
      const frame = ex?.source?.frames[msg.frame ?? ex.source.appFrame ?? -1];
      if (!ex?.source) send({ type: 'error', message: 'No source for this request (the trace has not arrived, or capture is off).' });
      else if (!frame || frame.uri.startsWith('dart:')) send({ type: 'error', message: `Can't open ${frame?.uri ?? 'that frame'}: the file is not in the workspace.` });
      else console.info(`[fake-host] would open ${frame.uri}:${frame.line}:${frame.column ?? 1}`);
      break;
    }
    case 'copySnippet': {
      const ex = find(msg.id);
      if (!ex) { send({ type: 'error', message: 'No such exchange' }); break; }
      const curl = `curl -X ${ex.method} '${ex.url}'${Object.entries(ex.requestHeaders).map(([k, v]) => ` -H '${k}: ${v}'`).join('')}`;
      console.info(`[fake-host] clipboard (${msg.format}):`, curl);
      navigator.clipboard?.writeText(`// ${msg.format} (dev harness: always cURL)\n${curl}`).catch(() => {});
      break;
    }
    case 'mutateField': {
      const ex = find(msg.id);
      if (!ex) { send({ type: 'error', message: 'No such exchange' }); break; }
      try { parsePath(msg.path); } catch (e) { send({ type: 'error', message: `Invalid path ${msg.path}: ${(e as Error).message}` }); break; }
      const base = ruleFromExchange(ex, 'breakpoint', `rule_${Date.now().toString(36)}`);
      const op: MutateOp = msg.op === 'set'
        ? { path: msg.path, op: 'set', value: msg.value, ...(msg.valueJson !== undefined ? { valueJson: msg.valueJson } : {}) }
        : { path: msg.path, op: msg.op };
      rules = [{ ...base, name: describeMutateOps([op]), action: { kind: 'mutate', ops: [op] } }, ...rules];
      send({ type: 'rules', rules });
      break;
    }
    case 'pickModel': {
      // Stands in for the host's QuickPick: next model in the table, then "Don't check this route", then back.
      const ex = find(msg.id);
      if (!ex) break;
      const route = routeKey(ex);
      const order = [...Object.keys(TOP_MODELS), null];
      const cur = userChoice.has(route) ? order.indexOf(userChoice.get(route)!) : -1;
      userChoice.set(route, order[(cur + 1) % order.length]);
      console.info(`[fake-host] ${route} → ${userChoice.get(route) ?? "don't check"}`);
      sendContracts(exchanges.filter((e) => routeKey(e) === route));
      break;
    }
    case 'openViolation': {
      const v = contractOf(find(msg.id))?.violations[msg.index];
      console.info(v ? `[fake-host] would open the model field ${v.field} (${v.path})` : '[fake-host] no such violation');
      break;
    }
    case 'generateModel':
    case 'generateFixture':
      console.info(`[fake-host] would open untitled editors: ${msg.type} for ${msg.id}`);
      break;
    case 'setNetworkProfile':
      status = { ...status, networkProfile: msg.profile.kind === 'none' ? undefined : msg.profile };
      if (!status.networkProfile) delete status.networkProfile;
      send({ type: 'status', status });
      break;
  }
}

function invalidSend(r: SendDraft): string | undefined {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(r.method)) return `invalid method ${r.method}`;
  try {
    const u = new URL(r.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `unsupported URL ${r.url}`;
  } catch { return `invalid URL ${r.url}`; }
  return undefined;
}

/** A sent request answers like the template with the same method + path when there is one, else echoes. */
function templateFor(r: SendDraft): Template {
  const base = TEMPLATES.find((t) => t.method === r.method && sameRoute(t.url(), r.url));
  const reqBody: Body | undefined = r.body !== undefined ? { text: r.body, encoding: 'utf8' } : undefined;
  if (base) return { ...base, url: () => r.url, reqHeaders: r.headers ?? {}, reqBody: () => reqBody, src: undefined };
  return {
    weight: 0, method: r.method, url: () => r.url, reqHeaders: r.headers ?? {}, reqBody: () => reqBody,
    status: 200, resHeaders: JSON_RES, latency: [40, 200],
    resBody: () => json({ echo: { method: r.method, url: r.url, body: r.body ?? null } }),
  };
}
function sameRoute(a: string, b: string): boolean {
  try { return new URL(a).pathname.replace(/\d+/g, 'N') === new URL(b).pathname.replace(/\d+/g, 'N'); } catch { return false; }
}

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => {
  let state: unknown;
  try { state = JSON.parse(params.get('ui') ?? sessionStorage.getItem('fi-dev-state') ?? 'null') ?? undefined; } catch { /* ignore */ }
  return {
    postMessage: (m: ViewMsg) => setTimeout(() => onViewMsg(m), 5),
    getState: () => state,
    setState: (s: unknown) => { state = s; try { sessionStorage.setItem('fi-dev-state', JSON.stringify(s)); } catch { /* quota */ } },
  };
};

// ---------------------------------------------------------------- simulated proxy

function find(id: string) { return exchanges.find((e) => e.id === id); }

function update(ex: Exchange, patch: Partial<Exchange>): Exchange {
  // Merge into the stored version (like the proxy): a late `source` must survive updates made from an older copy.
  const next = { ...(find(ex.id) ?? ex), ...patch } as Exchange;
  for (const k of Object.keys(next) as (keyof Exchange)[]) if (next[k] === undefined) delete next[k];
  exchanges = exchanges.map((e) => (e.id === ex.id ? next : e));
  send({ type: 'exchange', exchange: next });
  if (next.state !== 'pending' && !next.state.startsWith('paused')) setTimeout(() => sendContracts([next]), 30);
  return next;
}

/** Ring buffer: drop the oldest finished exchanges beyond MAX and report them. */
function record(ex: Exchange, announce: boolean) {
  exchanges.push(ex);
  if (exchanges.length <= MAX) return;
  const removed: string[] = [];
  let excess = exchanges.length - MAX;
  exchanges = exchanges.filter((e) => {
    if (excess > 0 && e.state !== 'pending' && !paused.has(e.id)) { excess--; removed.push(e.id); return false; }
    return true;
  });
  if (announce && removed.length) send({ type: 'removed', ids: removed });
}

function invalidEdit(e?: RequestEdit | ResponseEdit): string | undefined {
  if (!e) return undefined;
  if ('status' in e && e.status !== undefined && (!Number.isInteger(e.status) || e.status < 100 || e.status > 599)) return `invalid status ${e.status}`;
  if ('url' in e && e.url !== undefined) {
    try { new URL(e.url); } catch { return `invalid URL ${e.url}`; }
  }
  return undefined;
}

/**
 * Pause `ex` like the proxy: pausedAt/pauseDeadline, auto-resume unedited at the deadline, and the
 * fake app gives up after CLIENT_TIMEOUT (→ 'error'; a late resume is then a no-op).
 */
function pause(ex: Exchange, phase: 'request' | 'response', patch: Partial<Exchange>, onResume: (edit?: RequestEdit | ResponseEdit) => void): Exchange {
  const pausedAt = Date.now();
  const cur = update(ex, { ...patch, state: phase === 'request' ? 'paused-request' : 'paused-response', pausedAt, pauseDeadline: pausedAt + BP_TIMEOUT });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const settle = () => { timers.forEach(clearTimeout); paused.delete(cur.id); };
  const resume = (edit?: RequestEdit | ResponseEdit) => { settle(); onResume(edit); };
  timers.push(setTimeout(() => resume(undefined), BP_TIMEOUT));
  timers.push(setTimeout(() => {
    settle();
    const e = find(cur.id);
    if (e) {
      update(e, {
        state: 'error', pausedAt: undefined, pauseDeadline: undefined, durationMs: Date.now() - e.startedAt,
        error: `Client closed the connection while ${phase === 'request' ? 'the request' : 'the response'} was paused (client timeout?)`,
      });
    }
  }, CLIENT_TIMEOUT));
  paused.set(cur.id, { phase, resume, settle });
  return cur;
}

interface Template {
  method: string;
  url: () => string;
  reqHeaders?: Record<string, string | string[]>;
  reqBody?: () => Body | undefined;
  status: number | 'error';
  resHeaders?: Record<string, string | string[]>;
  resBody?: () => Body | undefined;
  latency: [number, number];
  error?: string;
  weight: number;
  /** App call chain (innermost first): [function, path under package:shop/, line]. */
  src?: { http: 'dio' | 'http'; chain: [string, string, number][] };
}

// ---------------------------------------------------------------- fake source traces (CONTRACTS §9.2)

const ENTRY_URI = 'file:///Users/dev/shop/.dart_tool/flutter_intercept/entry_lib__main.dart';
const LIB_FRAMES: Record<'dio' | 'http', StackFrame[]> = {
  dio: [
    { fn: 'DioMixin._dispatchRequest', uri: 'package:dio/src/dio_mixin.dart', line: 544, column: 46 },
    { fn: 'DioMixin.fetch.<anonymous closure>', uri: 'package:dio/src/dio_mixin.dart', line: 455, column: 12, afterAsyncGap: true },
    { fn: 'DioMixin.fetch', uri: 'package:dio/src/dio_mixin.dart', line: 430, column: 5, afterAsyncGap: true },
  ],
  http: [
    { fn: 'IOClient.send', uri: 'package:http/src/io_client.dart', line: 90, column: 38 },
    { fn: 'BaseClient._sendUnstreamed', uri: 'package:http/src/base_client.dart', line: 93, column: 32 },
    { fn: 'BaseClient.get', uri: 'package:http/src/base_client.dart', line: 28, column: 7 },
  ],
};
function fakeSource(src: NonNullable<Template['src']>): SourceInfo {
  const lib = LIB_FRAMES[src.http];
  const frames: StackFrame[] = [
    { fn: '_InterceptedHttpClient.openUrl', uri: ENTRY_URI, line: 141, column: 22 },
    ...lib,
    ...src.chain.map(([fn, path, line], i): StackFrame => ({ fn, uri: `package:shop/${path}`, line, column: 7 + i * 4, afterAsyncGap: i > 0 })),
    { fn: '_rootRunUnary', uri: 'dart:async/zone.dart', line: 1407, column: 47, afterAsyncGap: true },
  ];
  return { frames, appFrame: 1 + lib.length };
}

const json = (v: unknown): Body => ({ text: JSON.stringify(v), encoding: 'utf8' });
const rnd = (a: number, b: number) => Math.round(a + random() * (b - a));
const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)];
const UA = { 'user-agent': 'Dart/3.5 (dart:io)', 'accept-encoding': 'gzip', 'host': 'api.shop.example.com' };
const AUTH = { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl' };
const JSON_RES = { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', 'server': 'nginx', 'x-request-id': 'req-8f2a' };

const product = (id: number) => ({
  id, name: pick(['Desk lamp', 'Espresso cup', 'Wool socks', 'USB-C cable', 'Notebook', 'Backpack']),
  price: { amount: rnd(199, 9999) / 100, currency: 'EUR' }, inStock: random() > 0.2,
  tags: ['home', 'sale'].slice(0, rnd(0, 2)), rating: Math.round(random() * 50) / 10,
  image: random() < 0.015 ? null : `https://cdn.shop.example.com/img/${id}.png`, // the backend bug the model check catches
});

const TEMPLATES: Template[] = [
  { weight: 6, src: { http: 'dio', chain: [['ProductsApi.list', 'data/products_api.dart', 31], ['ProductsRepository.page', 'data/products_repository.dart', 17], ['_HomePageState._loadMore', 'ui/home_page.dart', 54]] },
    method: 'GET', url: () => `https://api.shop.example.com/v1/products?page=${rnd(1, 9)}&limit=20`, reqHeaders: { ...UA, ...AUTH, accept: 'application/json' },
    status: 200, resHeaders: JSON_RES, resBody: () => json({ page: 1, total: 183, items: Array.from({ length: 20 }, (_, i) => product(100 + i)) }), latency: [60, 400] },
  { weight: 4, src: { http: 'dio', chain: [['ProductsApi.byId', 'data/products_api.dart', 44], ['ProductPage.build.<anonymous closure>', 'ui/product_page.dart', 23]] },
    method: 'GET', url: () => `https://api.shop.example.com/v1/products/${rnd(1, 300)}`, reqHeaders: { ...UA, ...AUTH },
    status: 200, resHeaders: JSON_RES, resBody: () => json({ ...product(rnd(1, 300)), description: 'A thing you will love.\nSecond line.', variants: [{ sku: 'A-1', size: 'M' }, { sku: 'A-2', size: 'L' }], meta: null }), latency: [40, 250] },
  { weight: 2, src: { http: 'dio', chain: [['CartApi.add', 'data/cart_api.dart', 19], ['CartNotifier.add', 'state/cart_notifier.dart', 37], ['AddToCartButton._onPressed', 'ui/widgets/add_to_cart_button.dart', 28]] },
    method: 'POST', url: () => 'https://api.shop.example.com/v1/cart/items', reqHeaders: { ...UA, ...AUTH, 'content-type': 'application/json' },
    reqBody: () => json({ productId: rnd(1, 300), quantity: rnd(1, 3) }), status: 201, resHeaders: JSON_RES, resBody: () => json({ cartId: 'c_91', items: 3, total: { amount: 42.5, currency: 'EUR' } }), latency: [80, 300] },
  { weight: 3, method: 'GET', url: () => `https://cdn.shop.example.com/img/${rnd(1, 300)}.png`, reqHeaders: { 'user-agent': 'Dart/3.5 (dart:io)' },
    status: 200, resHeaders: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }, resBody: () => ({ text: PNG_16PX, encoding: 'base64' }), latency: [20, 120] },
  { weight: 1, src: { http: 'http', chain: [['AuthService.me', 'auth/auth_service.dart', 62], ['main', 'main.dart', 18]] },
    method: 'GET', url: () => 'https://api.shop.example.com/v1/me', reqHeaders: { ...UA },
    status: 401, resHeaders: { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer' }, resBody: () => json({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Token expired' }), latency: [30, 90] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/recommendations', reqHeaders: { ...UA, ...AUTH },
    status: 503, resHeaders: { 'content-type': 'text/html', 'retry-after': '30' }, resBody: () => ({ text: '<html><body><h1>503 Service Unavailable</h1></body></html>', encoding: 'utf8' }), latency: [900, 2500] },
  { weight: 1, method: 'POST', url: () => 'https://telemetry.example.net/v2/collect', reqHeaders: { 'content-type': 'application/json' },
    reqBody: () => json({ events: [{ name: 'screen_view', screen: 'home' }] }), status: 'error', error: 'SocketException: Connection refused (OS Error: Connection refused, errno = 61)', latency: [10, 40] },
  { weight: 1, src: { http: 'http', chain: [['ProfileApi.save', 'data/profile_api.dart', 25]] },
    method: 'PUT', url: () => 'https://api.shop.example.com/v1/profile', reqHeaders: { ...UA, ...AUTH, 'content-type': 'application/json' },
    reqBody: () => json({ displayName: 'Ada', newsletter: true }), status: 204, resHeaders: { 'x-request-id': 'req-11' }, latency: [50, 200] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/checkout/legacy', reqHeaders: { ...UA },
    status: 302, resHeaders: { location: 'https://api.shop.example.com/v2/checkout', 'set-cookie': ['session=abc; HttpOnly', 'theme=dark'] }, latency: [20, 60] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/reports/2026-q3.pdf', reqHeaders: { ...UA, ...AUTH },
    status: 200, resHeaders: { 'content-type': 'application/pdf', 'content-length': '7340032' }, resBody: () => ({ text: 'JVBERi0xLjcK'.repeat(2000), encoding: 'base64', truncated: true }), latency: [400, 1200] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/flags', reqHeaders: { ...UA }, status: 200, resHeaders: JSON_RES, resBody: () => json({ newCheckout: false }), latency: [20, 50] },
  { weight: 1, method: 'GET', url: () => 'https://ads.tracker.example.org/pixel?u=42', reqHeaders: { 'user-agent': 'Dart/3.5 (dart:io)' }, status: 200, resHeaders: { 'content-type': 'image/gif' }, latency: [20, 60] },
  { weight: 1, src: { http: 'dio', chain: [['FeedApi.load', 'data/feed_api.dart', 12], ['FeedController.refresh', 'state/feed_controller.dart', 40]] },
    method: 'GET', url: () => 'https://api.shop.example.com/v1/feed', reqHeaders: { ...UA, ...AUTH }, status: 200, resHeaders: JSON_RES,
    resBody: () => json({ sections: Array.from({ length: 150 }, (_, i) => ({ id: i, title: `Section ${i}`, items: [product(i), product(i + 1)], layout: { kind: 'carousel', columns: 2 } })) }), latency: [100, 600] },
];

function pickTemplate(): Template {
  const total = TEMPLATES.reduce((s, t) => s + t.weight, 0);
  let r = random() * total;
  for (const t of TEMPLATES) { r -= t.weight; if (r <= 0) return t; }
  return TEMPLATES[0];
}

function applyRequestEdit(ex: Exchange, e?: RequestEdit): Exchange {
  if (!e) return ex;
  return {
    ...ex,
    method: e.method ?? ex.method,
    url: e.url ?? ex.url,
    requestHeaders: e.headers ?? ex.requestHeaders,
    requestBody: e.body !== undefined ? { text: e.body, encoding: 'utf8' } : ex.requestBody,
  };
}

function applyResponseEdit(ex: Exchange, e?: ResponseEdit): Partial<Exchange> {
  if (!e) return {};
  const p: Partial<Exchange> = {};
  if (e.status !== undefined) p.status = e.status;
  if (e.headers) p.responseHeaders = e.headers;
  if (e.body !== undefined) p.responseBody = { text: e.body, encoding: 'utf8' };
  return p;
}

/** Run one exchange through the simulated proxy. `instant` = no timers (preload). Returns the exchange id. */
function simulate(t: Template, opts: { instant?: boolean; startedAt?: number; initiator?: 'editor' | 'agent'; resentFrom?: string } = {}): string {
  const id = `ex_${++seq}`;
  let ex: Exchange = {
    id, startedAt: opts.startedAt ?? Date.now(), method: t.method, url: t.url(),
    requestHeaders: t.reqHeaders ?? {}, requestBody: t.reqBody?.(), state: 'pending',
  };
  if (opts.initiator) ex.initiator = opts.initiator;
  if (opts.resentFrom) ex.resentFrom = opts.resentFrom;
  if (!ex.requestBody) delete ex.requestBody;
  const rule = rules.find((r) => r.enabled && !isSpent(r) && matches(r.match, ex.method, ex.url));
  if (rule) {
    ex.matchedRuleId = rule.id;
    hits.set(rule.id, (hits.get(rule.id) ?? 0) + 1);
    if (isSpent(rule)) setTimeout(removeSpentRules, opts.instant ? 0 : 50);
  }
  const later = (ms: number, fn: () => void) => (opts.instant ? fn() : setTimeout(fn, ms));
  const a = rule?.action;

  // Network profile (global) + throttle rule: what would reach the network is slowed or failed.
  const reachesNetwork = !a || a.kind === 'breakpoint' || a.kind === 'throttle' || a.kind === 'mutate';
  const profile: NetworkProfile = status.networkProfile ?? { kind: 'none' };
  let latency = rnd(...t.latency);
  const simulated: string[] = [];
  let drop = 0;
  let kbps: number | undefined;
  if (reachesNetwork && profile.kind === 'throttle') {
    latency += profile.latencyMs ?? 0;
    drop = profile.dropRate ?? 0;
    kbps = profile.kbps;
    simulated.push(describeProfile(profile));
  }
  if (a?.kind === 'throttle') {
    latency += a.latencyMs ?? 0;
    drop = Math.max(drop, a.dropRate ?? 0);
    kbps = a.kbps !== undefined ? Math.min(a.kbps, kbps ?? Infinity) : kbps;
    simulated.push(`Throttle rule: ${describeProfile({ kind: 'throttle', latencyMs: a.latencyMs, kbps: a.kbps, dropRate: a.dropRate })}`);
  }
  if (simulated.length) ex.simulated = simulated.join(' + ');

  // The trace side channel: the source meets the exchange a moment later.
  const attachSource = () => {
    if (!t.src) return;
    const cur = find(id);
    if (cur) update(cur, { source: fakeSource(t.src) });
  };

  const finish = (cur: Exchange) => {
    if (t.status === 'error') {
      update(cur, { state: 'error', error: t.error, durationMs: latency });
      return;
    }
    let body = t.resBody?.();
    const resp: Partial<Exchange> = { status: t.status, responseHeaders: t.resHeaders ?? {} };
    if (a?.kind === 'mutate') {
      const m = mutateBody(body, a.ops);
      body = m.body;
      if (m.error) resp.error = m.error;
      else resp.simulated = [ex.simulated, `Mutated: ${describeMutateOps(a.ops)}`].filter(Boolean).join(' + ');
    }
    resp.responseBody = body;
    const bytes = body ? (body.encoding === 'base64' ? body.text.length * 0.75 : body.text.length) : 0;
    const transfer = kbps ? Math.round((bytes * 8) / kbps) : 0;
    if (rule?.action.kind === 'breakpoint' && rule.action.phase !== 'request') {
      pause(cur, 'response', resp, (edit) => {
        const p = find(id) ?? cur;
        update(p, { ...applyResponseEdit(p, edit as ResponseEdit), state: 'completed', durationMs: Date.now() - p.startedAt, pausedAt: undefined, pauseDeadline: undefined });
      });
      return;
    }
    later(transfer, () => update(find(id) ?? cur, { ...resp, state: 'completed', durationMs: latency + transfer }));
  };

  record(ex, !opts.instant);
  if (!opts.instant) send({ type: 'exchange', exchange: ex });
  later(40, attachSource);

  const fail = (error: string, label: string, after = 2) => later(after, () => update(find(id) ?? ex, {
    state: 'blocked', error, durationMs: after, simulated: ex.simulated ? `${ex.simulated} → ${label}` : label,
  }));

  if (a?.kind === 'mock') {
    later(a.delayMs ?? 5, () => update(ex, {
      state: 'mocked', status: a.status, responseHeaders: a.headers ?? {}, responseBody: { text: a.body, encoding: 'utf8' }, durationMs: a.delayMs ?? 5,
    }));
  } else if (a?.kind === 'block') {
    later(2, () => update(ex, a.mode === 'reset'
      ? { state: 'blocked', durationMs: 2, error: 'Connection reset by rule' }
      : { state: 'blocked', status: a.status ?? 403, responseHeaders: {}, durationMs: 2 }));
  } else if (a?.kind === 'fault') {
    const host = (() => { try { return new URL(ex.url).host; } catch { return ex.url; } })();
    if (a.fault === 'dns') fail(`SocketException: Failed host lookup: '${host}' (simulated)`, 'Fault: DNS failure');
    else if (a.fault === 'reset') fail('Connection reset by peer (simulated fault)', 'Fault: connection reset');
    else if (a.fault === 'timeout') fail('Client gave up waiting (simulated timeout)', 'Fault: timeout', opts.instant ? 0 : 8000);
    else later(latency, () => {
      const body = t.resBody?.();
      update(find(id) ?? ex, {
        state: 'blocked', status: t.status === 'error' ? 200 : t.status, responseHeaders: t.resHeaders ?? {},
        responseBody: body ? { ...body, text: body.text.slice(0, Math.floor(body.text.length / 2)), truncated: true } : undefined,
        durationMs: latency, error: 'Response body cut mid-way (simulated)', simulated: 'Fault: truncated response',
      });
    });
  } else if (reachesNetwork && profile.kind === 'offline') {
    fail("SocketException: Failed host lookup (OS Error: nodename nor servname provided) — network profile Offline", 'Offline');
  } else if (drop && random() < drop) {
    fail('Connection reset by peer (simulated drop)', `dropped (${Math.round(drop * 100)}% fail)`, Math.min(latency, 300));
  } else if (a?.kind === 'breakpoint' && a.phase !== 'response') {
    ex = pause(ex, 'request', {}, (edit) => {
      const p = find(id) ?? ex;
      const edited = update(p, { ...applyRequestEdit(p, edit as RequestEdit), state: 'pending', pausedAt: undefined, pauseDeadline: undefined });
      setTimeout(() => finish(edited), latency);
    });
  } else {
    later(latency, () => finish(find(id) ?? ex));
  }
  return id;
}

// ---------------------------------------------------------------- boot

function preload(n: number) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    let t = pickTemplate();
    // keep preloaded traffic free of request breakpoints; we add two paused ones explicitly below
    while (t.method === 'POST' && t.url().includes('/cart/')) t = pickTemplate();
    simulate(t, { instant: true, startedAt: now - (n - i) * 900 });
  }
}

if (params.get('empty') !== '1') {
  preload(Number(params.get('n') ?? 40));
  // One paused request (cart write hits the breakpoint rule) …
  simulate(TEMPLATES[2], { instant: true });
  // … and one paused response (temporarily enable the /me response breakpoint).
  const me = rules.find((r) => r.id === 'rule_bp_me')!;
  me.enabled = true;
  simulate({ ...TEMPLATES[4], status: 200, resHeaders: JSON_RES, resBody: () => ({ text: JSON.stringify({ id: 42, name: 'Ada Lovelace', email: 'ada@example.com', roles: ['admin'], plan: 'pro', address: { city: 'London', zip: 'NW1' } }, null, 2), encoding: 'utf8' }) }, { instant: true });
  me.enabled = false;
}

let streaming = params.get('stream') !== '0';
setInterval(() => {
  if (streaming && status.proxyRunning && status.interceptEnabled) simulate(pickTemplate());
}, Number(params.get('rate') ?? 1200));

// dev bar wiring (no inline handlers: the page runs under the production-like CSP)
function wire() {
  const theme = params.get('theme');
  if (theme) document.body.className = theme;
  document.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((b) =>
    b.addEventListener('click', () => { document.body.className = b.dataset.theme!; }));
  const streamBtn = document.getElementById('dev-stream')!;
  streamBtn.textContent = streaming ? 'pause stream' : 'resume stream';
  streamBtn.addEventListener('click', () => { streaming = !streaming; streamBtn.textContent = streaming ? 'pause stream' : 'resume stream'; });
  document.getElementById('dev-burst')!.addEventListener('click', () => {
    const before = new Set(exchanges.map((e) => e.id));
    preload(1000);
    for (const e of exchanges) if (!before.has(e.id)) send({ type: 'exchange', exchange: e });
    const gone = [...before].filter((id) => !exchanges.some((e) => e.id === id));
    if (gone.length) send({ type: 'removed', ids: gone });
  });
  const lanBtn = document.getElementById('dev-lan')!;
  lanBtn.addEventListener('click', () => {
    // Simulates a physical-iPhone session opening/closing the token-protected LAN listener.
    status = status.lan ? { ...status, lan: undefined } : { ...status, lan: { host: '192.168.1.20', port: status.port ?? 8899 } };
    if (!status.lan) delete status.lan;
    lanBtn.textContent = status.lan ? 'close LAN' : 'open LAN';
    send({ type: 'status', status });
  });
  if (params.get('lan') === '1') lanBtn.click();

  // Agent API status (CONTRACTS §8): none → connected → read-only → off → none.
  const agentBtn = document.getElementById('dev-agent')!;
  const AGENT_RULE: Rule = {
    id: 'rule_agent_empty', enabled: true, name: '[agent] Empty recommendations',
    match: { method: 'GET', url: 'https://api.shop.example.com/v1/recommendations*' },
    action: { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '[]' },
  };
  const modes = ['none', 'connected', 'readOnly', 'off'] as const;
  let agentMode: (typeof modes)[number] = 'none';
  const setAgent = (mode: (typeof modes)[number]) => {
    agentMode = mode;
    agentBtn.textContent = `agent: ${mode}`;
    const mcpUrl = 'http://127.0.0.1:47823/mcp';
    if (mode === 'none') delete status.agent;
    else if (mode === 'connected') status = { ...status, agent: { access: 'readWrite', mcpUrl, clients: 1, lastCall: { tool: 'wait_for_request', at: Date.now() - 3000 } } };
    else if (mode === 'readOnly') status = { ...status, agent: { access: 'readOnly', mcpUrl, clients: 1, lastCall: { tool: 'list_requests', at: Date.now() - 65_000 } } };
    else status = { ...status, agent: { access: 'off', clients: 0 } };
    if (mode === 'connected' && !rules.some((r) => r.id === AGENT_RULE.id)) {
      rules = [AGENT_RULE, ...rules];
      send({ type: 'rules', rules });
    }
    send({ type: 'status', status: { ...status } });
  };
  agentBtn.addEventListener('click', () => setAgent(modes[(modes.indexOf(agentMode) + 1) % modes.length]));
  const agentParam = params.get('agent');
  if (agentParam && (modes as readonly string[]).includes(agentParam)) setAgent(agentParam as (typeof modes)[number]);
  // Fake an agent tool call now and then while "connected".
  setInterval(() => {
    if (agentMode === 'connected' && status.agent) {
      status = { ...status, agent: { ...status.agent, lastCall: { tool: random() < 0.5 ? 'wait_for_request' : 'get_request', at: Date.now() } } };
      send({ type: 'status', status });
    }
  }, 7000);
  // An AI agent resends a recent finished exchange (CONTRACTS §9.5 resend_request): initiator 'agent', no `sent`.
  document.getElementById('dev-agent-resend')?.addEventListener('click', () => {
    const src = [...exchanges].reverse().find((e) => e.state === 'completed');
    if (!src) return;
    simulate(templateFor({ method: src.method, url: src.url, headers: src.requestHeaders, body: src.requestBody?.encoding === 'utf8' ? src.requestBody.text : undefined }),
      { initiator: 'agent', resentFrom: src.id });
  });
  const net = params.get('net');
  if (net === 'offline') status = { ...status, networkProfile: { kind: 'offline' } };
  else if (net && ['slow-3g', 'fast-3g', 'flaky'].includes(net)) status = { ...status, networkProfile: presetProfile(net as NetworkPresetId) };
  if (net) send({ type: 'status', status });
  document.getElementById('dev-error')!.addEventListener('click', () => {
    send({ type: 'error', message: 'Simulated host error: could not apply rules (example).' });
  });
  const proxyBtn = document.getElementById('dev-proxy')!;
  proxyBtn.addEventListener('click', () => {
    status = status.proxyRunning ? { ...status, proxyRunning: false, port: undefined, sessions: 0 } : { ...status, proxyRunning: true, port: 8899, sessions: 1 };
    proxyBtn.textContent = status.proxyRunning ? 'stop proxy' : 'start proxy';
    send({ type: 'status', status });
  });
  if (params.get('bare') === '1') {
    // Screenshot mode: no dev bar, panel background like the real bottom-panel view.
    document.getElementById('dev-bar')?.remove();
    document.body.classList.add('fi-panel');
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();

// ---------------------------------------------------------------- contract check + mutate (CONTRACTS §10)

/** Applies mutate ops to a JSON body like the proxy; a non-JSON body passes unchanged with a note. */
function mutateBody(body: Body | undefined, ops: MutateOp[]): { body?: Body; error?: string } {
  if (!body || body.encoding !== 'utf8') return { body, error: 'Mutate rule: the response is not JSON — forwarded unchanged' };
  let root: unknown;
  try { root = JSON.parse(body.text); } catch { return { body, error: 'Mutate rule: the response is not valid JSON — forwarded unchanged' }; }
  // Dev only: valueJson is applied through JSON.parse (the real proxy splices the text byte-exact).
  const plain = ops.map((o) => (o.valueJson !== undefined ? { path: o.path, op: o.op, value: JSON.parse(o.valueJson) } : o));
  return { body: { text: JSON.stringify(applyOps(root, plain).value), encoding: 'utf8' } };
}

type WireType = 'int' | 'double' | 'String' | 'bool' | { model: string } | { list: WireType } | { enumOf: string[] };
interface WireField { key: string; field: string; type: WireType; nullable?: boolean }
const f = (key: string, type: WireType, nullable = false, field = key): WireField => ({ key, field, type, nullable });
const MODELS: Record<string, WireField[]> = {
  Product: [f('id', 'int'), f('name', 'String'), f('price', { model: 'Price' }), f('inStock', 'bool'), f('image', 'String'),
    f('rating', 'double'), f('tags', { list: 'String' }), f('description', 'String', true)],
  Price: [f('amount', 'double'), f('currency', 'String')],
  ProductPage: [f('page', 'int'), f('total', 'int'), f('items', { list: { model: 'Product' } })],
  CartSummary: [f('cartId', 'String', false, 'id'), f('items', 'int', false, 'itemCount'), f('total', { model: 'Price' })],
  User: [f('id', 'int'), f('name', 'String'), f('email', 'String'), f('roles', { list: 'String' }), f('plan', { enumOf: ['free', 'pro'] }),
    f('address', { model: 'Address' }, true)],
  Address: [f('city', 'String'), f('zip', 'String', true)],
};
/** Models a route can be mapped to (the QuickPick's list). */
const TOP_MODELS: Record<string, true> = { Product: true, ProductPage: true, CartSummary: true, User: true };
const API: { method: string; path: RegExp; model: string; via: ContractSummary['via'] }[] = [
  { method: 'GET', path: /^\/v1\/products\/\d+$/, model: 'Product', via: 'retrofit' },
  { method: 'GET', path: /^\/v1\/products$/, model: 'ProductPage', via: 'retrofit' },
  { method: 'POST', path: /^\/v1\/cart\/items$/, model: 'CartSummary', via: 'source' },
  { method: 'GET', path: /^\/v1\/me$/, model: 'User', via: 'retrofit' },
];
/** "GET /v1/products/{id}" → model name, or null = don't check (the host keeps this in workspaceState). */
const userChoice = new Map<string, string | null>();
const contracts = new Map<string, ContractSummary>();

function pathOf(e: Exchange): string { try { return new URL(e.url).pathname; } catch { return e.url; } }
function routeKey(e: Exchange): string { return `${e.method} ${pathOf(e).replace(/\/\d+(?=\/|$)/g, '/{id}')}`; }
const typeName = (t: WireType): string =>
  typeof t === 'string' ? t : 'model' in t ? t.model : 'list' in t ? `List<${typeName(t.list)}>` : 'enum';
const actualName = (v: unknown): string =>
  v === undefined ? 'missing' : v === null ? 'null' : Array.isArray(v) ? 'List' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'double')
    : typeof v === 'string' ? 'String' : typeof v === 'boolean' ? 'bool' : 'Map';

function checkValue(v: unknown, t: WireType, path: string, field: string, nullable: boolean, out: ContractSummary['violations']) {
  if (out.length >= 50) return;
  const bad = (message: string, severity: 'error' | 'warning' = 'error') =>
    out.push({ path, field, expected: `${typeName(t)}${nullable ? '?' : ''}`, actual: actualName(v), severity, message });
  if (v === undefined || v === null) {
    if (!nullable) bad(`${v === undefined ? 'Key is missing' : 'Value is null'} → Null is not a subtype of ${typeName(t)}`);
    return;
  }
  if (t === 'int') { if (typeof v !== 'number' || !Number.isInteger(v)) bad(`${actualName(v)} is not a subtype of int`); return; }
  if (t === 'double') { if (typeof v !== 'number') bad(`${actualName(v)} is not a subtype of num`); return; }
  if (t === 'String') { if (typeof v !== 'string') bad(`${actualName(v)} is not a subtype of String`); return; }
  if (t === 'bool') { if (typeof v !== 'boolean') bad(`${actualName(v)} is not a subtype of bool`); return; }
  if ('enumOf' in t) {
    if (typeof v !== 'string') bad(`${actualName(v)} is not a subtype of String`);
    else if (!t.enumOf.includes(v)) bad(`"${v}" is not one of ${t.enumOf.join(', ')} — decoded as unknownEnumValue`, 'warning');
    return;
  }
  if ('list' in t) {
    if (!Array.isArray(v)) { bad(`${actualName(v)} is not a subtype of List<dynamic>`); return; }
    v.forEach((item, i) => checkValue(item, t.list, formatPath([...parsePath(path), { index: i }]), field, false, out));
    return;
  }
  if (typeof v !== 'object' || Array.isArray(v)) { bad(`${actualName(v)} is not a subtype of Map<String, dynamic>`); return; }
  for (const fl of MODELS[t.model] ?? []) {
    checkValue((v as Record<string, unknown>)[fl.key], fl.type, formatPath([...parsePath(path), { key: fl.key }]), fl.field, !!fl.nullable, out);
  }
}

function checkExchange(e: Exchange): ContractSummary | undefined {
  const ct = String(e.responseHeaders?.['content-type'] ?? '');
  if (e.status === undefined || !/json/.test(ct) || e.responseBody?.encoding !== 'utf8') return undefined;
  const route = routeKey(e);
  const chosen = userChoice.get(route);
  if (chosen === null) return { id: e.id, checked: false, via: 'user', violations: [], reason: `You chose not to check ${route}.` };
  const api = API.find((x) => x.method === e.method && x.path.test(pathOf(e)));
  const model = chosen ?? api?.model;
  const via: ContractSummary['via'] = chosen ? 'user' : api?.via ?? 'none';
  if (!model) return { id: e.id, checked: false, via: 'none', violations: [], reason: `No Retrofit or Chopper method matches ${route}.` };
  if (e.status >= 400) return { id: e.id, checked: false, model, via, violations: [], reason: `Error responses (${e.status}) aren't checked against ${model}.` };
  let json: unknown;
  try { json = JSON.parse(e.responseBody.text); } catch { return { id: e.id, checked: false, model, via, violations: [], reason: 'The body is not valid JSON.' }; }
  const violations: ContractSummary['violations'] = [];
  checkValue(json, { model }, '$', model, false, violations);
  return { id: e.id, checked: true, model, via, violations };
}

function contractOf(e: Exchange | undefined): ContractSummary | undefined { return e && contracts.get(e.id); }

function sendContracts(list: Exchange[]) {
  const results: ContractSummary[] = [];
  for (const e of list) {
    const r = checkExchange(e);
    if (!r) continue;
    contracts.set(e.id, r);
    results.push(r);
  }
  if (results.length) send({ type: 'contract', results });
}
