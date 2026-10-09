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
 *
 * Semantics follow CONTRACTS §3/§4: pausedAt/pauseDeadline while paused, auto-resume unedited at the
 * deadline, a client that gives up while paused → 'error' (late resume ignored), invalid edit → 'error'
 * message and the exchange stays paused, clear keeps in-flight exchanges and is followed by a snapshot,
 * createRuleFromExchange uses the proxy's ruleFromExchange and inserts the rule first.
 */
import type {
  Body, Exchange, HostMsg, RequestEdit, ResponseEdit, Rule, Status, ViewMsg,
} from '../src/protocol';
import { matches, ruleFromExchange } from '@flutter-intercept/proxy/rules';

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
];

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
  }
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
  const next = { ...ex, ...patch } as Exchange;
  for (const k of Object.keys(next) as (keyof Exchange)[]) if (next[k] === undefined) delete next[k];
  exchanges = exchanges.map((e) => (e.id === ex.id ? next : e));
  send({ type: 'exchange', exchange: next });
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
  tags: ['home', 'sale'].slice(0, rnd(0, 2)), rating: Math.round(random() * 50) / 10, image: `https://cdn.shop.example.com/img/${id}.png`,
});

const TEMPLATES: Template[] = [
  { weight: 6, method: 'GET', url: () => `https://api.shop.example.com/v1/products?page=${rnd(1, 9)}&limit=20`, reqHeaders: { ...UA, ...AUTH, accept: 'application/json' },
    status: 200, resHeaders: JSON_RES, resBody: () => json({ page: 1, total: 183, items: Array.from({ length: 20 }, (_, i) => product(100 + i)) }), latency: [60, 400] },
  { weight: 4, method: 'GET', url: () => `https://api.shop.example.com/v1/products/${rnd(1, 300)}`, reqHeaders: { ...UA, ...AUTH },
    status: 200, resHeaders: JSON_RES, resBody: () => json({ ...product(rnd(1, 300)), description: 'A thing you will love.\nSecond line.', variants: [{ sku: 'A-1', size: 'M' }, { sku: 'A-2', size: 'L' }], meta: null }), latency: [40, 250] },
  { weight: 2, method: 'POST', url: () => 'https://api.shop.example.com/v1/cart/items', reqHeaders: { ...UA, ...AUTH, 'content-type': 'application/json' },
    reqBody: () => json({ productId: rnd(1, 300), quantity: rnd(1, 3) }), status: 201, resHeaders: JSON_RES, resBody: () => json({ cartId: 'c_91', items: 3, total: { amount: 42.5, currency: 'EUR' } }), latency: [80, 300] },
  { weight: 3, method: 'GET', url: () => `https://cdn.shop.example.com/img/${rnd(1, 300)}.png`, reqHeaders: { 'user-agent': 'Dart/3.5 (dart:io)' },
    status: 200, resHeaders: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }, resBody: () => ({ text: PNG_16PX, encoding: 'base64' }), latency: [20, 120] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/me', reqHeaders: { ...UA },
    status: 401, resHeaders: { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer' }, resBody: () => json({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Token expired' }), latency: [30, 90] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/recommendations', reqHeaders: { ...UA, ...AUTH },
    status: 503, resHeaders: { 'content-type': 'text/html', 'retry-after': '30' }, resBody: () => ({ text: '<html><body><h1>503 Service Unavailable</h1></body></html>', encoding: 'utf8' }), latency: [900, 2500] },
  { weight: 1, method: 'POST', url: () => 'https://telemetry.example.net/v2/collect', reqHeaders: { 'content-type': 'application/json' },
    reqBody: () => json({ events: [{ name: 'screen_view', screen: 'home' }] }), status: 'error', error: 'SocketException: Connection refused (OS Error: Connection refused, errno = 61)', latency: [10, 40] },
  { weight: 1, method: 'PUT', url: () => 'https://api.shop.example.com/v1/profile', reqHeaders: { ...UA, ...AUTH, 'content-type': 'application/json' },
    reqBody: () => json({ displayName: 'Ada', newsletter: true }), status: 204, resHeaders: { 'x-request-id': 'req-11' }, latency: [50, 200] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/checkout/legacy', reqHeaders: { ...UA },
    status: 302, resHeaders: { location: 'https://api.shop.example.com/v2/checkout', 'set-cookie': ['session=abc; HttpOnly', 'theme=dark'] }, latency: [20, 60] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/reports/2026-q3.pdf', reqHeaders: { ...UA, ...AUTH },
    status: 200, resHeaders: { 'content-type': 'application/pdf', 'content-length': '7340032' }, resBody: () => ({ text: 'JVBERi0xLjcK'.repeat(2000), encoding: 'base64', truncated: true }), latency: [400, 1200] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/flags', reqHeaders: { ...UA }, status: 200, resHeaders: JSON_RES, resBody: () => json({ newCheckout: false }), latency: [20, 50] },
  { weight: 1, method: 'GET', url: () => 'https://ads.tracker.example.org/pixel?u=42', reqHeaders: { 'user-agent': 'Dart/3.5 (dart:io)' }, status: 200, resHeaders: { 'content-type': 'image/gif' }, latency: [20, 60] },
  { weight: 1, method: 'GET', url: () => 'https://api.shop.example.com/v1/feed', reqHeaders: { ...UA, ...AUTH }, status: 200, resHeaders: JSON_RES,
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

/** Run one exchange through the simulated proxy. `instant` = no timers (preload). */
function simulate(t: Template, opts: { instant?: boolean; startedAt?: number } = {}) {
  const id = `ex_${++seq}`;
  let ex: Exchange = {
    id, startedAt: opts.startedAt ?? Date.now(), method: t.method, url: t.url(),
    requestHeaders: t.reqHeaders ?? {}, requestBody: t.reqBody?.(), state: 'pending',
  };
  const rule = rules.find((r) => r.enabled && matches(r.match, ex.method, ex.url));
  if (rule) ex.matchedRuleId = rule.id;
  const latency = rnd(...t.latency);
  const later = (ms: number, fn: () => void) => (opts.instant ? fn() : setTimeout(fn, ms));

  const finish = (cur: Exchange) => {
    if (t.status === 'error') {
      update(cur, { state: 'error', error: t.error, durationMs: latency });
      return;
    }
    const resp: Partial<Exchange> = { status: t.status, responseHeaders: t.resHeaders ?? {}, responseBody: t.resBody?.() };
    if (rule?.action.kind === 'breakpoint' && rule.action.phase !== 'request') {
      pause(cur, 'response', resp, (edit) => {
        const p = find(id) ?? cur;
        update(p, { ...applyResponseEdit(p, edit as ResponseEdit), state: 'completed', durationMs: Date.now() - p.startedAt, pausedAt: undefined, pauseDeadline: undefined });
      });
      return;
    }
    update(cur, { ...resp, state: 'completed', durationMs: latency });
  };

  record(ex, !opts.instant);
  if (!opts.instant) send({ type: 'exchange', exchange: ex });

  const a = rule?.action;
  if (a?.kind === 'mock') {
    later(a.delayMs ?? 5, () => update(ex, {
      state: 'mocked', status: a.status, responseHeaders: a.headers ?? {}, responseBody: { text: a.body, encoding: 'utf8' }, durationMs: a.delayMs ?? 5,
    }));
  } else if (a?.kind === 'block') {
    later(2, () => update(ex, a.mode === 'reset'
      ? { state: 'blocked', durationMs: 2, error: 'Connection reset by rule' }
      : { state: 'blocked', status: a.status ?? 403, responseHeaders: {}, durationMs: 2 }));
  } else if (a?.kind === 'breakpoint' && a.phase !== 'response') {
    ex = pause(ex, 'request', {}, (edit) => {
      const p = find(id) ?? ex;
      const edited = update(p, { ...applyRequestEdit(p, edit as RequestEdit), state: 'pending', pausedAt: undefined, pauseDeadline: undefined });
      setTimeout(() => finish(edited), latency);
    });
  } else {
    later(latency, () => finish(find(id) ?? ex));
  }
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
