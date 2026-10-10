// v0.7.0 (CONTRACTS §13.2, §13.4): timing phases, script rules.
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { createRequire } from 'module';
import { once } from 'events';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy, Rule } from '../src';
import { MAX_SCRIPT_BYTES, ruleFromExchange, ruleProblem, SCRIPT_TEMPLATE } from '../src/rules';
import { ScriptRunner } from '../src/script';
import { bypassPatchedRequests } from '../src/upstream-pool';
import { inState, nextExchange, settled, sleep, startProxy, startTinyProxy, startUpstream, viaProxy, type Upstream } from './helpers';

const rule = (id: string, url: string, action: Rule['action'], extra: Partial<Rule> = {}): Rule => ({ id, enabled: true, match: { url }, action, ...extra });
const script = (code: string, url = '*', name = 'my-script'): Rule => rule('s1', url, { kind: 'script', code }, { name });

let up: Upstream;
let proxy: InterceptProxy;

beforeAll(async () => {
  up = await startUpstream();
});
afterAll(async () => {
  await up?.close();
});
beforeEach(async () => {
  proxy = await startProxy();
  up.hits.length = 0;
});
afterEach(async () => {
  await proxy?.stop();
});

/** The finished exchange for a URL part (waits for plain pass-through completion). */
async function done(urlPart: string): Promise<Exchange> {
  const all = await settled(proxy);
  const ex = [...all].reverse().find((e) => e.url.includes(urlPart));
  if (!ex) throw new Error(`no exchange for ${urlPart}`);
  return ex;
}

// Node's agent-less client sends `Connection: close` (forwarded upstream); dart:io sends none.
const KEEP_ALIVE = { connection: 'keep-alive' };
const isInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

// ---------------------------------------------------------------- timings

describe('timings (CONTRACTS §13.2)', () => {
  it('HTTP pass-through: a new connection, then a reused one', async () => {
    await viaProxy(proxy.port, `${up.httpUrl}/slow?ms=120`, { headers: KEEP_ALIVE });
    const first = await done('/slow');
    const t = first.timings!;
    expect(t).toBeDefined();
    expect(t.reused).toBeUndefined();
    expect(t.dnsMs).toBeUndefined(); // an IP target: no lookup, never guessed
    expect(t.tlsMs).toBeUndefined();
    for (const k of ['requestMs', 'connectMs', 'sendMs', 'waitMs', 'receiveMs'] as const) expect(isInt(t[k]), k).toBe(true);
    expect(t.waitMs).toBeGreaterThanOrEqual(100);
    expect(t.waitMs).toBeLessThanOrEqual(first.durationMs!);
    expect(t.pausedMs).toBeUndefined();
    expect(t.delayMs).toBeUndefined();

    await viaProxy(proxy.port, `${up.httpUrl}/json`, { headers: KEEP_ALIVE });
    const second = await done('/json');
    expect(second.timings).toMatchObject({ reused: true });
    expect(second.timings!.connectMs).toBeUndefined();
    for (const k of ['requestMs', 'sendMs', 'waitMs', 'receiveMs'] as const) expect(isInt(second.timings![k]), k).toBe(true);
  });

  it('HTTPS pass-through: connect + TLS on a new connection, reused afterwards', async () => {
    await viaProxy(proxy.port, `${up.httpsUrl}/json`, { headers: KEEP_ALIVE });
    const first = await done('/json');
    expect(first.state).toBe('completed');
    const t = first.timings!;
    expect(isInt(t.connectMs)).toBe(true);
    expect(isInt(t.tlsMs)).toBe(true);
    expect(isInt(t.waitMs)).toBe(true);
    expect(t.reused).toBeUndefined();

    await viaProxy(proxy.port, `${up.httpsUrl}/echo`, { method: 'POST', body: 'x'.repeat(1000), headers: KEEP_ALIVE });
    const second = await done('/echo');
    expect(second.timings).toMatchObject({ reused: true });
    expect(second.timings!.tlsMs).toBeUndefined();
    expect(isInt(second.timings!.sendMs)).toBe(true);
  });

  it('a host name target has a DNS phase; hooked routes (breakpoints) are timed too', async () => {
    const local = await startUpstream('localhost');
    try {
      proxy.setRules([rule('bp', '*/json*', { kind: 'breakpoint', phase: 'request' })]);
      const paused = nextExchange(proxy, inState('paused-request'));
      const resP = viaProxy(proxy.port, `${local.httpUrl}/json`);
      const ex = await paused;
      await sleep(150);
      proxy.resume(ex.id);
      expect((await resP).status).toBe(200);
      const fin = await done('/json');
      const t = fin.timings!;
      expect(t.pausedMs).toBeGreaterThanOrEqual(140);
      expect(isInt(t.requestMs)).toBe(true);
      expect(isInt(t.dnsMs)).toBe(true);
      expect(isInt(t.connectMs)).toBe(true);
      expect(isInt(t.waitMs)).toBe(true);
      expect(isInt(t.receiveMs)).toBe(true);
    } finally {
      await local.close();
    }
  });

  it('response breakpoints add to pausedMs after the upstream phases', async () => {
    proxy.setRules([rule('bp', '*/json*', { kind: 'breakpoint', phase: 'response' })]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/json`);
    const ex = await paused;
    expect(isInt(ex.timings?.receiveMs)).toBe(true); // the upstream response is complete at the pause
    await sleep(120);
    proxy.resume(ex.id);
    await resP;
    const fin = await done('/json');
    expect(fin.timings!.pausedMs).toBeGreaterThanOrEqual(110);
  });

  it('mocks: only requestMs and delayMs', async () => {
    proxy.setRules([rule('m', '*/json*', { kind: 'mock', status: 200, body: 'mocked', delayMs: 120 })]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/json`);
    expect(r.text).toBe('mocked');
    const fin = await done('/json');
    expect(fin.state).toBe('mocked');
    expect(Object.keys(fin.timings!).sort()).toEqual(['delayMs', 'requestMs']);
    expect(fin.timings!.delayMs).toBeGreaterThanOrEqual(110);
  });

  it('throttle latency counts as delayMs (plain route)', async () => {
    proxy.setRules([rule('t', '*/json*', { kind: 'throttle', latencyMs: 100 })]);
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    const fin = await done('/json');
    expect(fin.timings!.delayMs).toBeGreaterThanOrEqual(90);
    expect(isInt(fin.timings!.waitMs)).toBe(true);
  });

  it('via an upstream proxy: what can be seen (no guessed TLS phase through the tunnel)', async () => {
    const tiny = await startTinyProxy();
    try {
      proxy.setUpstreamProxy({ url: tiny.url });
      await viaProxy(proxy.port, `${up.httpsUrl.replace('127.0.0.1', 'up.example.invalid')}/json`, { headers: KEEP_ALIVE });
      const first = await done('/json');
      expect(first.state).toBe('completed');
      expect(first.timings!.tlsMs).toBeUndefined();
      expect(isInt(first.timings!.waitMs)).toBe(true);
      expect(isInt(first.timings!.receiveMs)).toBe(true);
      await viaProxy(proxy.port, `${up.httpsUrl.replace('127.0.0.1', 'up.example.invalid')}/echo`, { headers: KEEP_ALIVE });
      expect((await done('/echo')).timings).toMatchObject({ reused: true });
    } finally {
      await tiny.close();
    }
  });

  // VS Code's extension host patches http / https IN PLACE (Object.assign on Node's module objects, the originals kept
  // as module.__vscodeOriginal; `node:http` is the same object) with a request() that replaces the caller's agent
  // (http.proxySupport "override"). Simulated on the real modules.
  async function withEditorPatch(saveOriginals: boolean, body: (ctx: { swapped: string[]; mods: { http: any; https: any } }) => Promise<void>) {
    const cjs = createRequire(import.meta.url);
    const mods = { http: cjs('http'), https: cjs('https') };
    const native = { http: mods.http.request, https: mods.https.request };
    const swapped: string[] = [];
    const editorPatch = (orig: typeof http.request, Agent: typeof http.Agent) =>
      function patched(this: unknown, ...args: unknown[]) {
        const opts = { ...(args[0] as object), agent: new Agent() };
        swapped.push((opts as { hostname?: string }).hostname ?? '');
        return (orig as (...a: unknown[]) => http.ClientRequest).call(this, opts, ...args.slice(1));
      };
    if (saveOriginals) {
      mods.http.__vscodeOriginal = { ...mods.http };
      mods.https.__vscodeOriginal = { ...mods.https };
    }
    mods.http.request = editorPatch(native.http, http.Agent);
    mods.https.request = editorPatch(native.https, https.Agent);
    try {
      await body({ swapped, mods });
    } finally {
      mods.http.request = native.http;
      mods.https.request = native.https;
      delete mods.http.__vscodeOriginal;
      delete mods.https.__vscodeOriginal;
    }
  }

  for (const saveOriginals of [true, false]) {
    it(`an editor's in-place http/https patch that swaps agents doesn't drop ours (${saveOriginals ? '__vscodeOriginal' : 'ClientRequest fallback'})`, async () => {
      await withEditorPatch(saveOriginals, async ({ swapped, mods }) => {
        await viaProxy(proxy.port, `${up.httpsUrl}/json`, { headers: KEEP_ALIVE });
        const broken = await done('/json');
        expect(swapped.length).toBe(1);
        expect(broken.timings).toEqual({ requestMs: broken.timings!.requestMs }); // the bug: phases lost with the agent

        // node:* is the same patched object: the original must come from the saved copy (or a ClientRequest).
        expect(bypassPatchedRequests(mods, mods)).toBe(true);
        expect(bypassPatchedRequests(mods, mods)).toBe(false); // once
        await viaProxy(proxy.port, `${up.httpsUrl}/echo`, { method: 'POST', body: 'hi', headers: KEEP_ALIVE });
        const fixed = await done('/echo');
        expect(swapped.length).toBe(1); // our agent went to Node's own request()
        expect(isInt(fixed.timings!.connectMs)).toBe(true);
        expect(isInt(fixed.timings!.tlsMs)).toBe(true);
        expect(isInt(fixed.timings!.waitMs)).toBe(true);
        expect(fixed.responseBody?.text).toContain('"body":"hi"');
        await viaProxy(proxy.port, `${up.httpUrl}/json`, { headers: KEEP_ALIVE });
        expect(isInt((await done(`${up.httpUrl}/json`)).timings!.waitMs)).toBe(true);
        expect(swapped.length).toBe(1);
        // Requests without one of our agents still go through the editor's patch.
        const u = new URL(up.httpUrl);
        await new Promise<void>((r, j) => mods.http.request({ hostname: u.hostname, port: u.port, path: '/json' }, (res: http.IncomingMessage) => res.resume().on('end', r)).on('error', j).end());
        expect(swapped.length).toBe(2);
      });
    });
  }

  it('record(): timings are kept as integer ms ≥ 0, known phases only', () => {
    const id = proxy.record({ method: 'GET', url: 'https://a.test/x', requestHeaders: {}, state: 'completed', startedAt: 1, timings: { waitMs: 12.6, dnsMs: -1, reused: true, bogus: 3 } as never });
    expect(proxy.getExchanges().find((e) => e.id === id)!.timings).toEqual({ waitMs: 13, reused: true });
  });

  it('WebSocket upgrades: phases up to the 101', async () => {
    const h = http.createServer((_q, r) => r.writeHead(404).end());
    const wss = new WebSocketServer({ noServer: true });
    h.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket as net.Socket, head, (ws) => ws.send('hi')));
    h.listen(0, '127.0.0.1');
    await once(h, 'listening');
    try {
      const url = `ws://127.0.0.1:${(h.address() as AddressInfo).port}/ws`;
      const accepted = nextExchange(proxy, (e) => e.kind === 'websocket' && e.status === 101);
      const ws = new WebSocket(url, { createConnection: () => net.connect(proxy.port, '127.0.0.1') } as WebSocket.ClientOptions);
      ws.on('error', () => undefined);
      await once(ws, 'message');
      const ex = await accepted;
      expect(isInt(ex.timings?.requestMs)).toBe(true);
      expect(isInt(ex.timings?.connectMs)).toBe(true);
      expect(isInt(ex.timings?.waitMs)).toBe(true);
      expect(ex.timings?.receiveMs).toBeUndefined();
      ws.terminate();
    } finally {
      for (const c of wss.clients) c.terminate();
      h.closeAllConnections();
      await new Promise((r) => h.close(r));
    }
  });
});

// ---------------------------------------------------------------- scripts

describe('script rules (CONTRACTS §13.4)', () => {
  it('onRequest edits a request header', async () => {
    proxy.setRules([script(`function onRequest(req, ctx) { req.headers['x-script'] = 'yes'; return req; }`)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/echo`, { method: 'POST', body: 'hello' });
    const echo = JSON.parse(r.text);
    expect(echo.headers['x-script']).toBe('yes');
    expect(echo.body).toBe('hello');
    const fin = await done('/echo');
    expect(fin).toMatchObject({ state: 'completed', matchedRuleId: 's1' });
    expect(fin.requestHeaders['x-script']).toBe('yes');
  });

  it('onRequest edits the body and URL (re-framed)', async () => {
    proxy.setRules([script(`function onRequest(req) { return { ...req, url: req.url + '?via=script', body: req.body.toUpperCase() + ' ✓' }; }`)]);
    const r = await viaProxy(proxy.port, `${up.httpsUrl}/echo`, { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } });
    const echo = JSON.parse(r.text);
    expect(echo.path).toBe('/echo?via=script');
    expect(echo.body).toBe('HELLO ✓');
    expect(echo.headers['content-length']).toBe(String(Buffer.byteLength('HELLO ✓')));
  });

  it('onResponse edits the response body and status', async () => {
    proxy.setRules([script(`function onResponse(res, req, ctx) { const d = JSON.parse(res.body); d.hello = 'script'; return { ...res, status: 202, body: JSON.stringify(d) }; }`)]);
    const r = await viaProxy(proxy.port, `${up.httpsUrl}/json`);
    expect(r.status).toBe(202);
    expect(JSON.parse(r.text)).toEqual({ hello: 'script' });
    expect(r.headers['x-up']).toBe('1');
    const fin = await done('/json');
    expect(fin).toMatchObject({ state: 'completed', status: 202, responseBody: { text: '{"hello":"script"}' } });
  });

  it('onResponse sees the decoded body of a gzip response and the edit is re-encoded', async () => {
    proxy.setRules([script(`function onResponse(res) { return { ...res, body: res.body.replace('gzip', 'script') }; }`)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/gzip`);
    expect(r.headers['content-encoding']).toBe('gzip');
    const zlib = await import('zlib');
    expect(zlib.gunzipSync(r.body).toString()).toBe('hello script world');
  });

  it('onRequest can answer locally (state mocked, the server is never contacted)', async () => {
    proxy.setRules([script(`function onRequest(req) { return { response: { status: 201, headers: { 'content-type': 'text/plain' }, body: 'local ' + req.method } }; }`)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/json`);
    expect(r.status).toBe(201);
    expect(r.text).toBe('local GET');
    const fin = await done('/json');
    expect(fin).toMatchObject({ state: 'mocked', status: 201 });
    expect(Object.keys(fin.timings ?? {})).toEqual(['requestMs']);
    expect(up.hits).toEqual([]);
  });

  it('context.log lines go to scriptLog (≤ 20 lines × 500 chars), with ruleId / exchangeId', async () => {
    proxy.setRules([
      script(`function onRequest(req, ctx) {
        ctx.log('rule', ctx.ruleId, typeof ctx.exchangeId, { n: 1 }, [2], undefined, null);
        ctx.log('x'.repeat(600));
        for (let i = 0; i < 30; i++) ctx.log('line', i);
      }`),
    ]);
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    const fin = await done('/json');
    expect(fin.state).toBe('completed');
    expect(fin.scriptLog).toHaveLength(20);
    expect(fin.scriptLog![0]).toBe('rule s1 string {"n":1} [2] undefined null');
    expect(fin.scriptLog![1]).toBe('x'.repeat(500));
    expect(fin.scriptLog![19]).toBe('line 17');
  });

  it('a hook that throws → 502, state error, message in error and scriptLog', async () => {
    proxy.setRules([script(`function onRequest(req, ctx) { ctx.log('before'); throw new TypeError('boom'); }`)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/json`);
    expect(r.status).toBe(502);
    expect(r.text).toBe('Flutter Intercept: Script my-script: TypeError: boom');
    const fin = await done('/json');
    expect(fin).toMatchObject({ state: 'error', status: 502, error: 'Script my-script: TypeError: boom' });
    expect(fin.scriptLog).toEqual(['before', 'Script my-script: TypeError: boom']);
    expect(up.hits).toEqual([]);
  });

  it('an invalid result → 502 (status out of range, async hook)', async () => {
    proxy.setRules([script(`function onResponse(res) { return { ...res, status: 42 }; }`)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/json`);
    expect(r.status).toBe(502);
    expect((await done('/json')).error).toMatch(/^Script my-script: response\.status must be an integer 100–599/);

    proxy.setRules([script(`async function onRequest(req) { return req; }`)]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/count`)).status).toBe(502);
    expect((await done('/count')).error).toMatch(/synchronous/);
  });

  it('a syntax error → 502 with the error', async () => {
    proxy.setRules([script(`function onRequest( {`)]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).status).toBe(502);
    expect((await done('/json')).error).toMatch(/^Script my-script: SyntaxError/);
  });

  it('an infinite loop times out (502) and the next request still runs scripts', async () => {
    proxy.setRules([script(`function onRequest(req, ctx) { if (req.url.includes('loop')) { ctx.log('looping'); for (;;) {} } req.headers['x-ok'] = '1'; return req; }`)]);
    const t0 = Date.now();
    const r = await viaProxy(proxy.port, `${up.httpUrl}/json?loop=1`);
    expect(r.status).toBe(502);
    expect(Date.now() - t0).toBeLessThan(1500);
    const fin = await done('loop=1');
    expect(fin.error).toBe('Script my-script: onRequest timed out after 200 ms');
    expect(fin.scriptLog).toEqual(['looping', 'Script my-script: onRequest timed out after 200 ms']);
    const ok = await viaProxy(proxy.port, `${up.httpUrl}/echo`);
    expect(JSON.parse(ok.text).headers['x-ok']).toBe('1');
  });

  it('no require / process / timers / fetch / eval / WebAssembly compile', async () => {
    proxy.setRules([
      script(`function onRequest(req, ctx) {
        ctx.log([typeof require, typeof process, typeof setTimeout, typeof setImmediate, typeof fetch, typeof module, typeof Buffer].join(','));
        try { eval('1 + 1'); ctx.log('eval ran'); } catch (e) { ctx.log('eval: ' + e.name); }
        try { new Function('return 1')(); ctx.log('Function ran'); } catch (e) { ctx.log('Function: ' + e.name); }
        try { this.constructor.constructor('return process')(); ctx.log('escaped'); } catch (e) { ctx.log('constructor: ' + e.name); }
        try { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); ctx.log('wasm ran'); } catch (e) { ctx.log('wasm: ' + e.name); }
        ctx.log([typeof FinalizationRegistry, typeof WeakRef, typeof SharedArrayBuffer, typeof Atomics, typeof WebAssembly].join(','));
      }`),
    ]);
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    const fin = await done('/json');
    expect(fin.scriptLog![0]).toBe('undefined,undefined,undefined,undefined,undefined,undefined,undefined');
    expect(fin.scriptLog!.slice(1)).toEqual([
      'eval: EvalError',
      'Function: EvalError',
      'constructor: EvalError',
      'wasm: ReferenceError',
      'undefined,undefined,undefined,undefined,undefined', // REVIEW-7 #3
    ]);
  });

  it('bodies over 1 MB reach the script as bodyOmitted; a returned body replaces them', async () => {
    proxy.setRules([
      script(`function onResponse(res, req, ctx) {
        ctx.log(String(res.bodyOmitted), typeof res.body, String(req.bodyOmitted));
        if (req.url.includes('replace')) return { ...res, body: 'small now' };
      }`),
    ]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/big?size=${2 * 1024 * 1024}`);
    expect(r.body.length).toBe(2 * 1024 * 1024);
    expect((await done('/big')).scriptLog).toEqual(['true undefined undefined']);
    const r2 = await viaProxy(proxy.port, `${up.httpUrl}/big?size=${2 * 1024 * 1024}&replace=1`);
    expect(r2.text).toBe('small now');
    expect(r2.headers['content-length']).toBe('9');
  });

  it('binary bodies are omitted', async () => {
    proxy.setRules([script(`function onResponse(res, req, ctx) { ctx.log(String(res.bodyOmitted), typeof res.body); }`)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/binary`);
    expect([...r.body]).toEqual([0, 1, 2, 0xff, 0xfe, 0x80]);
    expect((await done('/binary')).scriptLog).toEqual(['true undefined']);
  });

  it('the worker starts on the first call and stops when no script rule is left', async () => {
    expect(proxy.scriptWorkerRunning).toBe(false);
    proxy.setRules([script(`function onRequest(req) {}`)]);
    expect(proxy.scriptWorkerRunning).toBe(false); // lazily
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    expect(proxy.scriptWorkerRunning).toBe(true);
    proxy.setRules([script(`function onRequest(req) {}`, '*', 'disabled')].map((r) => ({ ...r, enabled: false })));
    expect(proxy.scriptWorkerRunning).toBe(false);
    proxy.setRules([script(`function onRequest(req, ctx) { ctx.log('again'); }`)]);
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    expect((await done('/json')).scriptLog).toEqual(['again']);
    proxy.setRules([]);
    expect(proxy.scriptWorkerRunning).toBe(false);
  });

  it('scripts do not apply to WebSocket upgrades (passed through with a note)', async () => {
    const h = http.createServer((_q, r) => r.writeHead(404).end());
    const wss = new WebSocketServer({ noServer: true });
    h.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket as net.Socket, head, (ws) => ws.send('hi')));
    h.listen(0, '127.0.0.1');
    await once(h, 'listening');
    try {
      proxy.setRules([script(`function onRequest(req) { return { response: { status: 500 } }; }`)]);
      const url = `ws://127.0.0.1:${(h.address() as AddressInfo).port}/ws`;
      const accepted = nextExchange(proxy, (e) => e.kind === 'websocket' && e.status === 101);
      const ws = new WebSocket(url, { createConnection: () => net.connect(proxy.port, '127.0.0.1') } as WebSocket.ClientOptions);
      ws.on('error', () => undefined);
      await once(ws, 'message');
      expect((await accepted).error).toMatch(/Script rule "my-script" does not apply to WebSocket/);
      ws.terminate();
    } finally {
      for (const c of wss.clients) c.terminate();
      h.closeAllConnections();
      await new Promise((r) => h.close(r));
    }
  });

  it('ruleProblem / ruleFromExchange', () => {
    expect(ruleProblem(script(''))).toMatch(/needs code/);
    expect(ruleProblem(script('   '))).toMatch(/needs code/);
    expect(ruleProblem(script('x'.repeat(MAX_SCRIPT_BYTES + 1)))).toMatch(/256 KB/);
    expect(ruleProblem(script('é'.repeat(MAX_SCRIPT_BYTES / 2 + 1)))).toMatch(/256 KB/); // UTF-8 bytes, not chars
    expect(ruleProblem(script('function onRequest() {}'))).toBeUndefined();
    expect(ruleProblem(script('function onRequest() {}', 'wss://x/*'))).toMatch(/do not apply to WebSocket/);
    expect(ruleProblem(rule('q', '*', { kind: 'sequence', steps: [{ action: { kind: 'script', code: 'x' } as never }] }))).toMatch(/script can't be a step/);
    const ex = { id: 'e', startedAt: 0, method: 'GET', url: 'https://a.test/users/1?x=1', requestHeaders: {}, state: 'completed' } as Exchange;
    const r = ruleFromExchange(ex, 'script', 'r1');
    expect(r.action).toEqual({ kind: 'script', code: SCRIPT_TEMPLATE });
    expect(r.match).toEqual({ method: 'GET', url: 'https://a.test/users/1*' });
  });
});

describe('ScriptRunner', () => {
  it('the watchdog terminates a stuck worker and the next call gets a fresh one', async () => {
    const runner = new ScriptRunner({ callTimeoutMs: 10_000, watchdogMs: 300 });
    const code = `function onRequest(req, ctx) { if (req.loop) for (;;) {} ctx.log('ran'); }`;
    runner.setScripts([{ ruleId: 'r', code }]);
    const ctx = { ruleId: 'r', exchangeId: 'e' };
    const t0 = Date.now();
    const stuck = await runner.run('r', 'R', code, 'onRequest', [{ loop: true }], ctx);
    expect(stuck.error).toMatch(/did not finish within 0.3 s; the script engine was restarted/);
    expect(Date.now() - t0).toBeLessThan(5000);
    const ok = await runner.run('r', 'R', code, 'onRequest', [{}], ctx);
    expect(ok).toEqual({ lines: ['ran'] });
    runner.stop();
    expect(runner.running).toBe(false);
  });

  it('runaway allocation hits the memory limit, not the host; the next call works', async () => {
    const runner = new ScriptRunner({ callTimeoutMs: 20_000, watchdogMs: 20_000 });
    const code = `function onRequest(req, ctx) { if (req.grow) { const a = []; for (;;) a.push({ x: new Array(1000).fill(a.length) }); } ctx.log('fine'); }`;
    runner.setScripts([{ ruleId: 'r', code }]);
    const ctx = { ruleId: 'r', exchangeId: 'e' };
    const bad = await runner.run('r', 'R', code, 'onRequest', [{ grow: true }], ctx);
    expect(bad.error).toMatch(/script engine/);
    expect(await runner.run('r', 'R', code, 'onRequest', [{}], ctx)).toEqual({ lines: ['fine'] });
    runner.stop();
  }, 60_000);

  it('binary data outside the heap limit: the call fails, the worker restarts, memory is released (REVIEW-7 #3)', async () => {
    const runner = new ScriptRunner();
    const code = `var held = []; function onRequest(req, ctx) { if (req.grow) held.push(new Uint8Array(100 * 1024 * 1024).fill(1)); ctx.log('held ' + held.length); }`;
    runner.setScripts([{ ruleId: 'r', code }]);
    const ctx = { ruleId: 'r', exchangeId: 'e' };
    expect(await runner.run('r', 'R', code, 'onRequest', [{}], ctx)).toEqual({ lines: ['held 0'] }); // worker up
    const rss0 = process.memoryUsage().rss;
    for (let i = 0; i < 6; i++) {
      const out = await runner.run('r', 'R', code, 'onRequest', [{ grow: true }], ctx);
      expect(out.error).toMatch(/more than 64 MB of binary data/);
      expect(out.lines).toEqual(['held 1']); // a fresh worker each time: nothing accumulates
    }
    expect(await runner.run('r', 'R', code, 'onRequest', [{}], ctx)).toEqual({ lines: ['held 0'] });
    await sleep(200);
    expect(process.memoryUsage().rss - rss0).toBeLessThan(100 * 1024 * 1024);
    runner.stop();
  }, 60_000);

  it('the queue is bounded: too many waiting calls fail at once (REVIEW-7 #3)', async () => {
    const runner = new ScriptRunner({ maxQueue: 3 });
    const code = `function onRequest(req, ctx) { const t = Date.now(); while (Date.now() - t < 50) {} ctx.log('ran'); }`;
    runner.setScripts([{ ruleId: 'r', code }]);
    const ctx = { ruleId: 'r', exchangeId: 'e' };
    const outs = await Promise.all([0, 1, 2, 3, 4, 5].map(() => runner.run('r', 'R', code, 'onRequest', [{}], ctx)));
    expect(outs.slice(0, 4).every((o) => o.lines[0] === 'ran' && !o.error)).toBe(true); // 1 running + 3 waiting
    expect(outs.slice(4).map((o) => o.error)).toEqual([
      'too many requests waiting for the script engine (3)',
      'too many requests waiting for the script engine (3)',
    ]);
    runner.stop();
  });

  it('a waiting call has a deadline (REVIEW-7 #3)', async () => {
    const runner = new ScriptRunner({ queueWaitMs: 300, callTimeoutMs: 2000, watchdogMs: 5000 });
    const code = `function onRequest(req, ctx) { if (req.slow) { const t = Date.now(); while (Date.now() - t < 800) {} } ctx.log('ran'); }`;
    runner.setScripts([{ ruleId: 'r', code }]);
    const ctx = { ruleId: 'r', exchangeId: 'e' };
    const slow = runner.run('r', 'R', code, 'onRequest', [{ slow: true }], ctx);
    const waiting = runner.run('r', 'R', code, 'onRequest', [{}], ctx);
    expect((await waiting).error).toBe('waited more than 0.3 s for the script engine (busy)');
    expect(await slow).toEqual({ lines: ['ran'] });
    expect(await runner.run('r', 'R', code, 'onRequest', [{}], ctx)).toEqual({ lines: ['ran'] });
    runner.stop();
  });

  it('calls are queued one at a time; missing hooks are reported', async () => {
    const runner = new ScriptRunner();
    const code = `let n = 0; function onRequest(req, ctx) { ctx.log(String(++n)); return { ...req, n }; }`;
    runner.setScripts([{ ruleId: 'r', code }]);
    const ctx = { ruleId: 'r', exchangeId: 'e' };
    const outs = await Promise.all([1, 2, 3].map(() => runner.run('r', 'R', code, 'onRequest', [{ method: 'GET' }], ctx)));
    expect(outs.map((o) => o.lines[0])).toEqual(['1', '2', '3']);
    expect(outs[2].value).toEqual({ method: 'GET', n: 3 });
    expect(await runner.run('r', 'R', code, 'onResponse', [{}, {}], ctx)).toEqual({ lines: [], missing: true });
    const arrow = `const onResponse = (res, req, ctx) => { ctx.log('const hook'); return null; };`;
    expect(await runner.run('r2', 'R2', arrow, 'onResponse', [{}, {}], ctx)).toEqual({ lines: ['const hook'] });
    runner.setScripts([]);
    expect(runner.running).toBe(false);
  });
});
