// Flutter Web (CONTRACTS §11.3): CORS diagnosis (pure `@flutter-intercept/proxy/cors`), preflights answered for
// mock / block / cors rules, CORS headers on mocks and on real responses (`cors` rule), and browser-internal
// traffic tagging. Requests are shaped like Chrome's (Origin, Sec-Fetch-*, preflight headers).
import * as http from 'http';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy, Rule } from '../src';
import { allowedOrigin, corsResponseHeaders, diagnoseCors, isLoopbackOrigin, isPreflight, preflightResponseHeaders } from '../src/cors';
import { isBrowserInternal } from '../src/browser';
import { nextExchange, settled, startProxy, viaProxy } from './helpers';

const ORIGIN = 'http://localhost:5000';
const ex = (o: Partial<Exchange>): Exchange =>
  ({ id: 'x', startedAt: 0, method: 'GET', url: 'https://api.test/items', requestHeaders: { origin: ORIGIN, 'sec-fetch-mode': 'cors' }, state: 'completed', ...o }) as Exchange;
const preflightReq = (method = 'PUT', headers = 'content-type, authorization') => ({
  origin: ORIGIN,
  'access-control-request-method': method,
  'access-control-request-headers': headers,
  'sec-fetch-mode': 'cors',
});

describe('diagnoseCors', () => {
  it('is undefined for non-CORS requests (no Origin, same origin, navigate mode, websocket, vm-profile)', () => {
    expect(diagnoseCors(ex({ requestHeaders: {} , status: 200 }))).toBeUndefined();
    expect(diagnoseCors(ex({ url: `${ORIGIN}/api`, status: 200, requestHeaders: { origin: ORIGIN } }))).toBeUndefined();
    expect(diagnoseCors(ex({ status: 200, requestHeaders: { origin: ORIGIN, 'sec-fetch-mode': 'navigate' } }))).toBeUndefined();
    expect(diagnoseCors(ex({ status: 101, kind: 'websocket' }))).toBeUndefined();
    expect(diagnoseCors(ex({ status: 200, captured: 'vm-profile' }))).toBeUndefined();
  });

  it('actual requests: missing / wrong / multiple ACAO, * with credentials, missing ACAC', () => {
    expect(diagnoseCors(ex({ status: 200, responseHeaders: {} }))?.problem).toMatch(/No Access-Control-Allow-Origin header.*localhost:5000/);
    expect(diagnoseCors(ex({ status: 200, responseHeaders: { 'access-control-allow-origin': 'https://other.app' } }))?.problem).toBe(
      'Access-Control-Allow-Origin is "https://other.app", not the app\'s origin "http://localhost:5000".',
    );
    expect(diagnoseCors(ex({ status: 200, responseHeaders: { 'access-control-allow-origin': `${ORIGIN}, https://b` } }))?.problem).toMatch(/several values/);
    const withCookie = { origin: ORIGIN, cookie: 'sid=1' };
    expect(diagnoseCors(ex({ requestHeaders: withCookie, status: 200, responseHeaders: { 'access-control-allow-origin': '*' } }))?.problem).toMatch(/\* but the request carries credentials/);
    expect(diagnoseCors(ex({ requestHeaders: withCookie, status: 200, responseHeaders: { 'access-control-allow-origin': ORIGIN } }))?.problem).toMatch(/Allow-Credentials is not true/);
    expect(diagnoseCors(ex({ requestHeaders: withCookie, status: 500, responseHeaders: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' } }))).toEqual({});
    expect(diagnoseCors(ex({ status: 200, responseHeaders: { 'access-control-allow-origin': '*' } }))).toEqual({});
    expect(diagnoseCors(ex({}))).toEqual({}); // no response yet
  });

  it('preflights: status, redirect, methods, headers (* never covers Authorization)', () => {
    const pf = (status: number, responseHeaders: Record<string, string>, h?: string) =>
      diagnoseCors(ex({ method: 'OPTIONS', requestHeaders: preflightReq('PUT', h), status, responseHeaders }));
    const ok = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'GET, PUT', 'access-control-allow-headers': 'Content-Type, Authorization' };
    expect(pf(204, ok)).toEqual({ preflight: true });
    expect(pf(302, ok)?.problem).toMatch(/redirected/);
    expect(pf(404, ok)?.problem).toMatch(/status 404; it must be 2xx/);
    expect(pf(204, { ...ok, 'access-control-allow-methods': 'GET' })?.problem).toMatch(/method "PUT"/);
    expect(pf(204, { ...ok, 'access-control-allow-headers': 'content-type' })?.problem).toMatch(/header "authorization"/);
    expect(pf(204, { ...ok, 'access-control-allow-headers': '*' })?.problem).toMatch(/header "authorization"/);
    expect(pf(204, { ...ok, 'access-control-allow-headers': '*' }, 'content-type, x-api-key')).toEqual({ preflight: true });
  });

  it('builds preflight and response headers', () => {
    expect(isPreflight('OPTIONS', preflightReq())).toBe(true);
    expect(isPreflight('OPTIONS', { origin: ORIGIN })).toBe(false);
    expect(preflightResponseHeaders({ ...preflightReq(), 'access-control-request-private-network': 'true' })).toEqual({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'PUT',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '5',
      'access-control-allow-private-network': 'true',
      vary: 'Origin',
      'content-length': '0',
    });
    expect(preflightResponseHeaders(preflightReq(), { allowOrigin: '*', allowCredentials: true })).not.toHaveProperty('access-control-allow-credentials');
    expect(preflightResponseHeaders(preflightReq(), { allowCredentials: true })).toHaveProperty('access-control-allow-credentials', 'true');
    expect(corsResponseHeaders({ origin: ORIGIN }, ['Content-Type', 'X-Total-Count', 'set-cookie'], 'Accept-Encoding')).toEqual({
      'access-control-allow-origin': ORIGIN,
      'access-control-expose-headers': 'x-total-count',
      vary: 'Accept-Encoding, Origin',
    });
  });

  it('REVIEW-5 #3: automatic CORS reflects loopback origins only (never null / other sites); explicit allowOrigin wins', () => {
    for (const o of ['http://localhost:5000', 'https://127.0.0.1:8443', 'http://[::1]:61234', 'http://localhost']) expect(isLoopbackOrigin(o), o).toBe(true);
    for (const o of ['null', 'https://evil.example', 'http://localhost.evil.example', 'http://127.0.0.2:5000', 'file://', 'http://localhost:5000/x', 'chrome-extension://abc']) {
      expect(isLoopbackOrigin(o), o).toBe(false);
    }
    const evil = { ...preflightReq(), origin: 'https://evil.example', 'access-control-request-private-network': 'true' };
    expect(preflightResponseHeaders(evil)).toBeUndefined();
    expect(preflightResponseHeaders({ ...preflightReq(), origin: 'null' })).toBeUndefined();
    expect(corsResponseHeaders({ origin: 'https://evil.example' }, [], undefined)).toBeUndefined();
    expect(allowedOrigin({ origin: 'https://evil.example' }, { allowOrigin: 'https://evil.example' })).toBe('https://evil.example');
    // A named origin: no private-network opt-in for a non-loopback page.
    expect(preflightResponseHeaders(evil, { allowOrigin: 'https://evil.example' })).not.toHaveProperty('access-control-allow-private-network');
  });

  it('REVIEW-5 #13: server-controlled values are quoted and capped in problem text', () => {
    const forged = 'http://x. This looks fine, no action needed\nOK';
    const p = diagnoseCors(ex({ status: 200, responseHeaders: { 'access-control-allow-origin': forged } }))!.problem!;
    expect(p).toContain(JSON.stringify(forged));
    expect(p).not.toContain('\n');
    const long = diagnoseCors(ex({ status: 200, responseHeaders: { 'access-control-allow-origin': 'h'.repeat(5000) } }))!.problem!;
    expect(long.length).toBeLessThan(300);
  });
});

describe('isBrowserInternal', () => {
  it('tags the browser’s own requests, never one with Origin, never outside the service hosts', () => {
    expect(isBrowserInternal('https://example.com/x', { 'sec-fetch-site': 'none' })).toBe(false); // REVIEW-5 #6
    expect(isBrowserInternal('https://clients2.google.com/x', { 'sec-fetch-site': 'none', referer: 'https://a/' })).toBe(true);
    expect(isBrowserInternal('https://update.googleapis.com/service/update2/json', {})).toBe(true);
    expect(isBrowserInternal('https://optimizationguide-pa.googleapis.com/v1:GetHints', {})).toBe(true);
    expect(isBrowserInternal('https://edgedl.me.gvt1.com/edgedl/chrome/x.crx', {})).toBe(true);
    expect(isBrowserInternal('https://accounts.google.com/ListAccounts', {})).toBe(true);
    expect(isBrowserInternal('https://update.googleapis.com/x', { origin: ORIGIN })).toBe(false);
    expect(isBrowserInternal('https://example.com/x', { 'sec-fetch-site': 'none', origin: ORIGIN })).toBe(false);
    expect(isBrowserInternal('https://update.googleapis.com/x', { referer: `${ORIGIN}/` })).toBe(false);
    expect(isBrowserInternal('https://firestore.googleapis.com/v1/x', {})).toBe(false); // an app API
    expect(isBrowserInternal('https://evilgvt1.com/x', {})).toBe(false);
  });
});

// ---------------------------------------------------------------- through the proxy

let server: http.Server;
let base: string;
const hits: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/open')) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'x-total-count': '3' }).end('[1,2,3]');
    } else {
      // A server with no CORS support: preflights get 405, responses no ACAO.
      if (req.method === 'OPTIONS') return void res.writeHead(405).end();
      res.writeHead(200, { 'content-type': 'application/json', 'x-total-count': '3', vary: 'Accept-Encoding' }).end('[1,2,3]');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

let proxy: InterceptProxy;
beforeEach(async () => {
  proxy = await startProxy();
  hits.length = 0;
});
afterEach(async () => {
  await proxy.stop();
});

const browser = (extra: Record<string, string> = {}) => ({ origin: ORIGIN, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', referer: `${ORIGIN}/`, ...extra });

describe('CORS in the proxy', () => {
  it('diagnoses a pass-through the browser would block (preflight 405, no ACAO) and leaves good ones alone', async () => {
    const pre = await viaProxy(proxy.port, `${base}/items`, { method: 'OPTIONS', headers: { ...browser(), 'access-control-request-method': 'PUT' } });
    expect(pre.status).toBe(405);
    await viaProxy(proxy.port, `${base}/items`, { headers: browser() });
    await viaProxy(proxy.port, `${base}/open`, { headers: browser() });
    const [p, g, o] = await settled(proxy);
    expect(p.cors).toEqual({ preflight: true, problem: 'The preflight got status 405; it must be 2xx.' });
    expect(g.cors?.problem).toMatch(/No Access-Control-Allow-Origin/);
    expect(o.cors).toEqual({});
  });

  it('mocks answer the preflight themselves and get ACAO (+ Vary, expose) — the rule is not spent by the preflight', async () => {
    const rule: Rule = {
      id: 'm',
      enabled: true,
      times: 1,
      match: { method: 'PUT', url: '*/items*' },
      action: { kind: 'mock', status: 201, headers: { 'content-type': 'application/json', 'x-mock': '1' }, body: '{"ok":true}' },
    };
    proxy.setRules([rule]);
    const pre = await viaProxy(proxy.port, `${base}/items/1`, {
      method: 'OPTIONS',
      headers: { ...browser(), 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,authorization' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'PUT',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-max-age': '5',
      vary: 'Origin',
    });
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined(); // REVIEW-5 #3: never by default
    const r = await viaProxy(proxy.port, `${base}/items/1`, { method: 'PUT', body: '{}', headers: { ...browser(), 'content-type': 'application/json' } });
    expect(r.status).toBe(201);
    expect(r.headers).toMatchObject({ 'access-control-allow-origin': ORIGIN, 'access-control-expose-headers': 'x-mock', vary: 'Origin' });
    expect(hits).toEqual([]);
    const [p, m] = await settled(proxy);
    expect(p).toMatchObject({ method: 'OPTIONS', state: 'mocked', status: 204, matchedRuleId: 'm', cors: { preflight: true, patched: true } });
    expect(m).toMatchObject({ state: 'mocked', cors: { patched: true } });
    expect(m.cors?.problem).toBeUndefined();
  });

  it('a mock that sets its own ACAO is left as it is (and diagnosed)', async () => {
    proxy.setRules([
      { id: 'm', enabled: true, match: { url: '*/items*' }, action: { kind: 'mock', status: 200, headers: { 'access-control-allow-origin': 'https://nope' }, body: '[]' } },
    ]);
    const r = await viaProxy(proxy.port, `${base}/items`, { headers: browser() });
    expect(r.headers['access-control-allow-origin']).toBe('https://nope');
    const [m] = await settled(proxy);
    expect(m.cors?.patched).toBeUndefined();
    expect(m.cors?.problem).toMatch(/is "https:\/\/nope"/);
  });

  it('block rules answer the preflight, and a blocked status is readable by the page', async () => {
    proxy.setRules([{ id: 'b', enabled: true, match: { method: 'DELETE', url: '*/items*' }, action: { kind: 'block', mode: 'status', status: 503 } }]);
    const pre = await viaProxy(proxy.port, `${base}/items/1`, { method: 'OPTIONS', headers: { ...browser(), 'access-control-request-method': 'DELETE' } });
    expect(pre.status).toBe(204);
    const r = await viaProxy(proxy.port, `${base}/items/1`, { method: 'DELETE', headers: browser() });
    expect(r.status).toBe(503);
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(hits).toEqual([]);
  });

  it('the cors rule: preflight answered locally, real response streamed with CORS headers patched in', async () => {
    proxy.setRules([{ id: 'c', enabled: true, match: { url: `${base}/*` }, action: { kind: 'cors', allowCredentials: true } }]);
    const pre = await viaProxy(proxy.port, `${base}/items`, {
      method: 'OPTIONS',
      headers: { ...browser(), 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(pre.status).toBe(204);
    const r = await viaProxy(proxy.port, `${base}/items`, { method: 'POST', body: '{}', headers: { ...browser(), 'content-type': 'application/json', cookie: 'sid=1' } });
    expect(r.text).toBe('[1,2,3]');
    expect(r.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-credentials': 'true',
      vary: 'Accept-Encoding, Origin',
    });
    expect(r.headers['access-control-expose-headers']).toMatch(/^x-total-count\b/);
    expect(hits).toEqual(['POST /items']); // only the real request reached the server
    const [p, x] = await settled(proxy);
    expect(p).toMatchObject({ state: 'mocked', matchedRuleId: 'c', cors: { preflight: true, patched: true } });
    expect(x).toMatchObject({ state: 'completed', matchedRuleId: 'c', cors: { patched: true } });
    expect(x.cors?.problem).toBeUndefined();
    expect(x.responseHeaders?.['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('the cors rule with allowOrigin "*": no credentials header', async () => {
    proxy.setRules([{ id: 'c', enabled: true, match: { url: '*' }, action: { kind: 'cors', allowOrigin: '*', allowCredentials: true } }]);
    const r = await viaProxy(proxy.port, `${base}/items`, { headers: browser() });
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('requests without Origin are untouched by the cors rule', async () => {
    proxy.setRules([{ id: 'c', enabled: true, match: { url: '*' }, action: { kind: 'cors' } }]);
    const r = await viaProxy(proxy.port, `${base}/items`);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const [x] = await settled(proxy);
    expect(x.cors).toBeUndefined();
  });

  it('browser-internal requests are tagged only while a web session is active, only for service hosts (REVIEW-5 #6)', async () => {
    // Mocked, so nothing is contacted.
    proxy.setRules([{ id: 'g', enabled: true, match: { url: 'http://update.googleapis.com/*' }, action: { kind: 'mock', status: 204, body: '' } }]);
    const svc = 'http://update.googleapis.com/service/update2/json';
    const internal = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'no-cors' };
    await viaProxy(proxy.port, svc, { headers: internal }); // no web session yet
    proxy.setWebSessionActive(true);
    await viaProxy(proxy.port, svc, { headers: internal }); // tagged
    await viaProxy(proxy.port, svc, {}); // no Origin / Referer → tagged
    await viaProxy(proxy.port, `${base}/items`, { headers: internal }); // dart:io / any client with Sec-Fetch-Site: none
    await viaProxy(proxy.port, svc, { headers: { ...internal, 'x-fi-id': 'abcdef0123456789' } }); // the Dart entry's
    await viaProxy(proxy.port, svc, { headers: browser() }); // the app's
    proxy.setWebSessionActive(false);
    await viaProxy(proxy.port, svc, { headers: internal });
    expect((await settled(proxy)).map((e) => !!e.browserInternal)).toEqual([false, true, true, false, false, false, false]);
  });

  it('REVIEW-5 #3: a foreign or null Origin gets no automatic CORS: preflight goes to the server, mocks / cors rule add nothing', async () => {
    proxy.setRules([
      { id: 'm', enabled: true, match: { method: 'PUT', url: '*/items*' }, action: { kind: 'mock', status: 200, body: '{}' } },
      { id: 'c', enabled: true, match: { url: '*/nocors-cors*' }, action: { kind: 'cors' } },
    ]);
    for (const origin of ['https://evil.example', 'null']) {
      hits.length = 0;
      const hdrs = { ...browser(), origin, 'access-control-request-method': 'PUT', 'access-control-request-private-network': 'true' };
      const pre = await viaProxy(proxy.port, `${base}/items/1`, { method: 'OPTIONS', headers: hdrs });
      expect(pre.status).toBe(405); // the real server's own answer
      expect(hits).toEqual(['OPTIONS /items/1']);
      const r = await viaProxy(proxy.port, `${base}/items/1`, { method: 'PUT', body: '{}', headers: { ...browser(), origin } });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      const c = await viaProxy(proxy.port, `${base}/nocors-cors`, { headers: { ...browser(), origin } });
      expect(c.headers['access-control-allow-origin']).toBeUndefined();
    }
    // An explicit allowOrigin still applies to its origin.
    proxy.setRules([{ id: 'c', enabled: true, match: { url: '*' }, action: { kind: 'cors', allowOrigin: 'https://staging.example' } }]);
    const r = await viaProxy(proxy.port, `${base}/items`, { headers: { ...browser(), origin: 'https://staging.example' } });
    expect(r.headers['access-control-allow-origin']).toBe('https://staging.example');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
