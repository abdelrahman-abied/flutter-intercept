// CONTRACTS §9.2 (v0.3.0): trace sink + x-fi-id, send(), rule spending, throttle / fault / network
// profile, rewriteLocalhost. Node clients here; the real Dart client is in faults.test.ts.
import * as http from 'http';
import * as zlib from 'zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { presetProfile, type Exchange, type InterceptProxy, type Rule } from '../src';
import { TraceJoin } from '../src/trace';
import { parseDartStack } from '../src/source';
import type { AddressInfo } from 'net';
import { firstChunkViaProxy, inState, nextExchange, settled, sleep, startProxy, startUpstream, viaProxy, type Upstream } from './helpers';

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
  await proxy.stop();
});

const TRACE_URL = 'http://trace.flutter-intercept.invalid/v1/traces';
const STACK = `#0      _InterceptedHttpClient.openUrl (file:///p/.dart_tool/flutter_intercept/entry_lib__main.dart:1:1)
#1      IOClient.send (package:http/src/io_client.dart:94:38)
<asynchronous suspension>
#2      HomeState.load (package:demo_app/home.dart:42:5)
#3      Other.call (package:other_pkg/x.dart:3:3)`;

const postTraces = (body: unknown, url = TRACE_URL) =>
  viaProxy(proxy.port, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const rule = (r: Partial<Rule> & Pick<Rule, 'action'>): Rule => ({ id: 'r', enabled: true, match: { url: '*' }, ...r });

const hitsOf = (path: string) => up.hits.filter((h) => h.endsWith(` ${path}`)).length;

// ---------------------------------------------------------------- trace sink + x-fi-id

describe('trace sink and x-fi-id', () => {
  it('answers 204 for the trace host (http and https, any path), records nothing, contacts nothing', async () => {
    const seen: Exchange[] = [];
    proxy.on('exchange', (e) => seen.push(e));
    expect((await postTraces({ traces: [] })).status).toBe(204);
    expect((await postTraces({ traces: [] }, 'https://trace.flutter-intercept.invalid/v1/traces')).status).toBe(204);
    expect((await viaProxy(proxy.port, 'http://trace.flutter-intercept.invalid:8123/anything')).status).toBe(204);
    expect((await postTraces('not json')).status).toBe(204);
    await sleep(50);
    expect(seen).toEqual([]);
    expect(proxy.getExchanges()).toEqual([]);
  });

  it('x-fi-id never reaches the server and is never recorded (plain, mock, breakpoint routes)', async () => {
    const r1 = await viaProxy(proxy.port, `${up.httpUrl}/echo`, { headers: { 'x-fi-id': 'abcdefgh1234', 'X-Other': '1' } });
    expect(JSON.parse(r1.text).headers['x-fi-id']).toBeUndefined();
    expect(JSON.parse(r1.text).headers['x-other']).toBe('1');
    const r2 = await viaProxy(proxy.port, `${up.httpsUrl}/echo`, { headers: { 'X-FI-ID': 'abcdefgh1234' } });
    expect(JSON.parse(r2.text).headers['x-fi-id']).toBeUndefined();

    // request breakpoint: an edit that puts it back is stripped too; response breakpoint route as well
    proxy.setRules([rule({ id: 'bp', match: { url: '*/echo?bp' }, action: { kind: 'breakpoint', phase: 'both' } })]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/echo?bp`, { headers: { 'x-fi-id': 'abcdefgh1234' } });
    const ex = await paused;
    expect(ex.requestHeaders['x-fi-id']).toBeUndefined();
    proxy.resume(ex.id, { headers: { ...ex.requestHeaders, 'x-fi-id': 'sneaky12345' } });
    const pausedRes = await nextExchange(proxy, inState('paused-response'));
    proxy.resume(pausedRes.id);
    expect(JSON.parse((await resP).text).headers['x-fi-id']).toBeUndefined();

    for (const e of await settled(proxy)) expect(Object.keys(e.requestHeaders).map((k) => k.toLowerCase())).not.toContain('x-fi-id');
  });

  it('joins trace → exchange and exchange → trace; appFrame prefers setAppPackages', async () => {
    proxy.setAppPackages(['demo_app']);
    // trace first
    await postTraces({ traces: [{ id: 'trace-first-1', stack: STACK }] });
    await viaProxy(proxy.port, `${up.httpUrl}/json`, { headers: { 'x-fi-id': 'trace-first-1' } });
    let [ex] = await settled(proxy);
    expect(ex.source?.frames[0].fn).toBe('IOClient.send'); // entry frames dropped
    expect(ex.source?.frames[ex.source.appFrame!]).toMatchObject({ fn: 'HomeState.load', uri: 'package:demo_app/home.dart', line: 42 });

    // exchange first: an 'exchange' event carries the source when the trace arrives
    proxy.clear();
    await viaProxy(proxy.port, `${up.httpUrl}/json?late`, { headers: { 'x-fi-id': 'exchange-first' } });
    [ex] = await settled(proxy);
    expect(ex.source).toBeUndefined();
    const withSource = nextExchange(proxy, (e) => e.id === ex.id && !!e.source);
    await postTraces({ traces: [{ id: 'exchange-first', stack: STACK }, { id: 'bad id!', stack: 'x' }, { id: 'no-stack-1' }] });
    expect((await withSource).source?.appFrame).toBeDefined();

    // without app packages the first non-framework frame wins
    proxy.setAppPackages([]);
    await postTraces({ traces: [{ id: 'no-packages-1', stack: STACK.replace('package:demo_app/home.dart', 'package:dio/x.dart') }] });
    await viaProxy(proxy.port, `${up.httpUrl}/json?3`, { headers: { 'x-fi-id': 'no-packages-1' } });
    const third = (await settled(proxy)).find((e) => e.url.endsWith('?3'))!;
    expect(third.source?.frames[third.source.appFrame!].uri).toBe('package:other_pkg/x.dart');
  });

  it('ignores invalid ids in the header, oversized and content-encoded trace bodies', async () => {
    await postTraces({ traces: [{ id: 'big-body-1', stack: STACK + ' '.repeat(1024 * 1024) }] });
    const gz = zlib.gzipSync(JSON.stringify({ traces: [{ id: 'gzip-body-1', stack: STACK }] }));
    expect((await viaProxy(proxy.port, TRACE_URL, { method: 'POST', headers: { 'content-encoding': 'gzip' }, body: gz })).status).toBe(204);
    for (const id of ['big-body-1', 'gzip-body-1', 'short']) {
      await viaProxy(proxy.port, `${up.httpUrl}/json?${id}`, { headers: { 'x-fi-id': id } });
    }
    await sleep(50);
    for (const e of await settled(proxy)) expect(e.source).toBeUndefined();
  });

  it('x-fi-id never reaches the server on websocket upgrades either', async () => {
    const seen = new Promise<http.IncomingHttpHeaders>((resolve) => {
      const ws = http.createServer();
      ws.on('upgrade', (req, socket) => {
        resolve(req.headers);
        socket.destroy();
        ws.close();
      });
      ws.listen(0, '127.0.0.1', () => {
        const port = (ws.address() as AddressInfo).port;
        const req = http.request({
          host: '127.0.0.1',
          port: proxy.port,
          path: `http://127.0.0.1:${port}/socket`,
          headers: {
            host: `127.0.0.1:${port}`,
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'x-fi-id': 'websocket-trace-1',
            'x-other': 'kept',
          },
          agent: false,
        });
        req.on('error', () => undefined);
        req.on('upgrade', (_res, socket) => socket.destroy());
        req.end();
      });
    });
    const headers = await seen;
    expect(headers['x-other']).toBe('kept');
    expect(headers['x-fi-id']).toBeUndefined();
    expect(headers['x-fi-send']).toBeUndefined();
  });

  it('REVIEW-3 #2: an adversarial ~1 MB trace POST costs < 100 ms of main-thread time (parsed on join)', async () => {
    // Patterns that made the old frame regexes backtrack quadratically, at the 16 KB per-stack cap,
    // plus lines over the 2 KB line cap. 60 traces (only 50 are taken), each with an exchange waiting.
    const lines = [
      '#1 ' + 'a ('.repeat(660),
      '#1 a (' + '1:'.repeat(990) + ')',
      'package:a/b.dart ' + ' '.repeat(1980) + 'x ',
      'package:a/b.dart' + ' 1'.repeat(990),
      '===' + ' ='.repeat(990) + ' x',
      ':'.repeat(2000),
    ];
    const adversarial = (i: number) =>
      i % 2 ? ('#1 ' + 'a ('.repeat(6000)).slice(0, 16 * 1024) : Array.from({ length: 8 }, (_, k) => lines[(i + k) % lines.length]).join('\n');
    const t0 = performance.now();
    for (let i = 0; i < 12; i++) parseDartStack(adversarial(i), 256);
    expect(performance.now() - t0).toBeLessThan(50);

    const ids = Array.from({ length: 60 }, (_, i) => `adversarial-${String(i).padStart(3, '0')}`);
    for (const id of ids.slice(0, 50)) await viaProxy(proxy.port, `${up.httpUrl}/json?${id}`, { headers: { 'x-fi-id': id } });
    await settled(proxy);
    const body = JSON.stringify({ traces: ids.map((id, i) => ({ id, stack: adversarial(i) })) });
    expect(body.length).toBeGreaterThan(800 * 1024);

    // Event-loop lag during the POST (the proxy runs in this process, like in the extension host).
    let maxGap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 2);
    const joined = new Promise<void>((resolve) => {
      let n = 0;
      proxy.on('exchange', (e) => {
        if (e.source && ++n === 50) resolve();
      });
    });
    expect((await postTraces(body)).status).toBe(204);
    await joined;
    clearInterval(tick);
    console.log(`[trace-dos] ${(body.length / 1024).toFixed(0)} KB POST, max event-loop gap ${maxGap.toFixed(1)} ms`);
    expect(maxGap).toBeLessThan(100);
    const all = await settled(proxy);
    expect(all.filter((e) => e.source)).toHaveLength(50);
  });

  it('TraceJoin: bounded both ways (size and TTL), redirects reuse the trace', () => {
    const j = new TraceJoin(3, 1000);
    for (let i = 0; i < 5; i++) j.exchange(`waiting-${i}`, `ex${i}`, [], 0);
    expect(j.pending.exchanges).toBe(3);
    expect(j.trace('waiting-0', STACK, [], 1).exchangeIds).toEqual([]); // evicted (oldest)
    expect(j.trace('waiting-4', STACK, [], 2).exchangeIds).toEqual(['ex4']);
    expect(j.exchange('waiting-4', 'ex-redirect', [], 3)).toBeDefined(); // same id again (redirect)
    expect(j.exchange('waiting-4', 'ex-late', [], 5000)).toBeUndefined(); // trace expired
    j.trace('t1', STACK, [], 10_000);
    expect(j.exchange('t1', 'a', [], 10_500)).toBeDefined();
    expect(j.exchange('t1', 'b', [], 11_001)).toBeUndefined();
    for (let i = 0; i < 10; i++) j.trace(`many-${i}`, STACK, [], 20_000);
    expect(j.pending.traces).toBe(3);
    // nobody waiting: stored raw, not parsed
    expect(j.trace('unasked-1', STACK, [], 20_000).info).toBeUndefined();
    // total size budget for raw stacks
    const small = new TraceJoin(100, 60_000, 1000);
    for (let i = 0; i < 5; i++) small.trace(`sized-${i}`, 'x'.repeat(400), [], 0);
    expect(small.pending.traces).toBe(2);
  });
});

// ---------------------------------------------------------------- send

describe('send()', () => {
  it('goes through the proxy, records initiator / resentFrom, resolves with the id', async () => {
    const { id } = await proxy.send({ method: 'get', url: `${up.httpUrl}/echo?q=1#frag`, headers: { 'X-A': 'b' }, initiator: 'editor', resentFrom: 'orig-1' });
    const ex = (await settled(proxy)).find((e) => e.id === id)!;
    expect(ex).toMatchObject({ method: 'GET', url: `${up.httpUrl}/echo?q=1`, state: 'completed', status: 200, initiator: 'editor', resentFrom: 'orig-1' });
    const echo = JSON.parse(ex.responseBody!.text);
    expect(echo.headers['x-a']).toBe('b');
    expect(echo.headers['x-fi-send']).toBeUndefined();
    expect(ex.requestHeaders['x-fi-send']).toBeUndefined();
    expect(hitsOf('/echo')).toBe(1);
  });

  it('recomputes framing and host: stale content-length / host from a recorded request are fixed', async () => {
    const { id } = await proxy.send({
      method: 'POST',
      url: `${up.httpsUrl}/echo`,
      headers: { host: 'old.example:1', 'content-length': '999', 'transfer-encoding': 'chunked', 'x-fi-id': 'zzzzzzzzzz', 'content-type': 'text/plain' },
      body: 'héllo',
      initiator: 'agent',
    });
    const ex = (await settled(proxy)).find((e) => e.id === id)!;
    const echo = JSON.parse(ex.responseBody!.text);
    expect(echo.body).toBe('héllo');
    expect(echo.headers['content-length']).toBe(String(Buffer.byteLength('héllo')));
    expect(echo.headers.host).toBe(new URL(up.httpsUrl).host);
    expect(echo.headers['x-fi-id']).toBeUndefined();
    expect(ex.initiator).toBe('agent');
  });

  it('re-encodes a decoded body per content-encoding', async () => {
    const { id } = await proxy.send({ method: 'POST', url: `${up.httpUrl}/echo`, headers: { 'content-encoding': 'gzip' }, body: 'zipped', initiator: 'editor' });
    const ex = (await settled(proxy)).find((e) => e.id === id)!;
    const echo = JSON.parse(ex.responseBody!.text);
    expect(echo.headers['content-encoding']).toBe('gzip');
    expect(ex.requestBody?.text).toBe('zipped');
  });

  it('rules apply (mock) and the result is recorded before completion (paused)', async () => {
    proxy.setRules([rule({ id: 'm', match: { url: '*/mocked' }, action: { kind: 'mock', status: 201, body: 'm' } })]);
    const m = await proxy.send({ method: 'GET', url: `${up.httpUrl}/mocked`, initiator: 'editor' });
    expect(proxy.getExchanges().find((e) => e.id === m.id)).toMatchObject({ state: 'mocked', initiator: 'editor' });
    expect(up.hits).toEqual([]);

    proxy.setRules([rule({ id: 'bp', action: { kind: 'breakpoint', phase: 'request' } })]);
    const p = await proxy.send({ method: 'GET', url: `${up.httpUrl}/json`, initiator: 'agent' });
    expect(proxy.getExchanges().find((e) => e.id === p.id)?.state).toBe('paused-request');
    proxy.resume(p.id);
  });

  it('upstream TLS stays strict', async () => {
    const strict = await startProxy({ ignoreUpstreamCertErrors: false });
    try {
      const { id } = await strict.send({ method: 'GET', url: `${up.httpsUrl}/json`, initiator: 'editor' });
      const ex = (await settled(strict)).find((e) => e.id === id)!;
      expect(ex.state).toBe('error');
      expect(up.hits).toEqual([]);
    } finally {
      await strict.stop();
    }
  });

  it('rejects invalid input and a stopped proxy', async () => {
    const bad = [
      { method: 'GE T', url: `${up.httpUrl}/json` },
      { method: 'CONNECT', url: `${up.httpUrl}/json` },
      { method: 'GET', url: 'not a url' },
      { method: 'GET', url: 'ftp://example.com/x' },
      { method: 'GET', url: 'http://user:pw@example.com/' },
      { method: 'GET', url: TRACE_URL },
      { method: 'GET', url: `${up.httpUrl}/json`, headers: { 'bad header': 'x' } },
      { method: 'GET', url: `${up.httpUrl}/json`, headers: { 'x-a': 'a\r\nInjected: 1' } },
    ];
    for (const b of bad) await expect(proxy.send({ ...b, initiator: 'editor' })).rejects.toThrow();
    await expect(proxy.send({ method: 'GET', url: `${up.httpUrl}/json`, initiator: 'someone' as 'editor' })).rejects.toThrow();
    expect(up.hits).toEqual([]);
    const stopped = await startProxy();
    await stopped.stop();
    await expect(stopped.send({ method: 'GET', url: `${up.httpUrl}/json`, initiator: 'editor' })).rejects.toThrow(/not running/);
  });
});

// ---------------------------------------------------------------- rule spending

describe('rule spending (times / expiresAt)', () => {
  it('times: applies N times, rule-hit per hit, rule-spent once; counts survive setRules, `used` is ignored', async () => {
    const spent: Array<[string, string]> = [];
    const hits: Array<[string, number]> = [];
    proxy.on('rule-spent', (id, reason) => spent.push([id, reason]));
    proxy.on('rule-hit', (id, used) => hits.push([id, used]));
    const r = rule({ id: 'twice', match: { url: '*/json' }, times: 2, action: { kind: 'mock', status: 200, body: 'mock' } });
    proxy.setRules([r]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text).toBe('mock');
    proxy.setRules([{ ...r, used: 0 }]); // host re-broadcast: the count stays ours
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text).toBe('mock');
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text).toBe('{"hello":"world"}');
    await sleep(10);
    expect(hits).toEqual([['twice', 1], ['twice', 2]]);
    expect(spent).toEqual([['twice', 'times']]);
    proxy.setRules([r]); // still spent, no second event
    await sleep(10);
    expect(spent).toHaveLength(1);
    // raising times revives it, and it can be spent (and reported) again
    proxy.setRules([{ ...r, times: 3 }]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text).toBe('mock');
    await sleep(10);
    expect(spent).toEqual([['twice', 'times'], ['twice', 'times']]);
    // removing the id drops its count
    proxy.setRules([]);
    proxy.setRules([r]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text).toBe('mock');
  });

  it('expiresAt: spent by a timer without traffic, then no longer matches; already expired fires at setRules', async () => {
    const spent: Array<[string, string]> = [];
    proxy.on('rule-spent', (id, reason) => spent.push([id, reason]));
    proxy.setRules([
      rule({ id: 'soon', match: { url: '*/json' }, expiresAt: Date.now() + 150, action: { kind: 'block', mode: 'status', status: 418 } }),
      rule({ id: 'past', match: { url: '*/nothing' }, expiresAt: Date.now() - 1, action: { kind: 'block', mode: 'status' } }),
    ]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).status).toBe(418);
    await sleep(10);
    expect(spent).toEqual([['past', 'expired']]);
    await sleep(250);
    expect(spent).toEqual([['past', 'expired'], ['soon', 'expired']]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- throttle / faults / profile

describe('throttle, faults and the network profile', () => {
  it('throttle latency: forwarded after the delay, completed, labelled', async () => {
    proxy.setRules([rule({ id: 't', action: { kind: 'throttle', latencyMs: 300 } })]);
    const t0 = Date.now();
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    const [ex] = await settled(proxy);
    expect(ex).toMatchObject({ state: 'completed', simulated: '+300 ms', matchedRuleId: 't' });
  });

  it('throttle kbps streams at the capped rate (first bytes early, total ≈ size / rate), body intact', async () => {
    proxy.setRules([rule({ id: 't', action: { kind: 'throttle', kbps: 800 } })]); // 100 KB/s
    const r = await firstChunkViaProxy(proxy.port, `${up.httpUrl}/big?size=${100 * 1024}`);
    expect(r.text.length).toBe(100 * 1024);
    expect(r.firstChunkMs).toBeLessThan(300);
    expect(r.totalMs).toBeGreaterThan(850);
    expect(r.totalMs).toBeLessThan(3000);
    const [ex] = await settled(proxy);
    expect(ex).toMatchObject({ state: 'completed', simulated: '800 kbps' });
    expect(ex.responseBody?.text.length).toBe(100 * 1024);
    // HTTPS path too
    const t0 = Date.now();
    expect((await viaProxy(proxy.port, `${up.httpsUrl}/big?size=${50 * 1024}`)).body.length).toBe(50 * 1024);
    expect(Date.now() - t0).toBeGreaterThan(400);
  });

  it('dropRate 1: reset instead of forwarding, blocked', async () => {
    proxy.setRules([rule({ id: 't', action: { kind: 'throttle', dropRate: 1, latencyMs: 50 } })]);
    await expect(viaProxy(proxy.port, `${up.httpUrl}/json`)).rejects.toThrow();
    const [ex] = await settled(proxy);
    expect(ex).toMatchObject({ state: 'blocked', simulated: '+50 ms, 100% fail: dropped' });
    expect(up.hits).toEqual([]);
  });

  it('faults: reset and dns fail the request without contacting the server; blocked', async () => {
    for (const fault of ['reset', 'dns'] as const) {
      proxy.setRules([rule({ id: fault, action: { kind: 'fault', fault } })]);
      await expect(viaProxy(proxy.port, `${up.httpsUrl}/json`)).rejects.toThrow();
    }
    expect(up.hits).toEqual([]);
    expect((await settled(proxy)).map((e) => [e.state, e.simulated])).toEqual([
      ['blocked', 'Fault: connection reset'],
      ['blocked', 'Fault: DNS failure'],
    ]);
  });

  it('fault timeout: held until the client gives up; or reset at breakpointTimeoutMs', async () => {
    proxy.setRules([rule({ id: 'to', action: { kind: 'fault', fault: 'timeout' } })]);
    await expect(viaProxy(proxy.port, `${up.httpUrl}/json`, { timeoutMs: 300 })).rejects.toThrow(/client timeout/);
    const ex = await nextExchange(proxy, inState('blocked'));
    expect(ex.simulated).toMatch(/the app gave up after 0\.\d s/);

    const short = await startProxy({ breakpointTimeoutMs: 300 });
    try {
      short.setRules([rule({ id: 'to', action: { kind: 'fault', fault: 'timeout' } })]);
      const t0 = Date.now();
      await expect(viaProxy(short.port, `${up.httpUrl}/json`)).rejects.toThrow();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
      expect((await settled(short))[0].simulated).toMatch(/reset after/);
    } finally {
      await short.stop();
    }
    expect(up.hits).toEqual([]);
  });

  it('fault truncate: forwards, cuts the body in half, records what the app got', async () => {
    proxy.setRules([rule({ id: 'tr', action: { kind: 'fault', fault: 'truncate' } })]);
    const blocked = nextExchange(proxy, inState('blocked'));
    const got = await new Promise<{ bytes: number; error?: string }>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `${up.httpUrl}/big?size=10000`, agent: false });
      req.on('response', (res) => {
        let bytes = 0;
        res.on('data', (c: Buffer) => (bytes += c.length));
        res.on('error', (e) => resolve({ bytes, error: e.message }));
        res.on('end', () => resolve({ bytes }));
        res.on('close', () => resolve({ bytes, error: 'closed' }));
      });
      req.on('error', (e) => resolve({ bytes: -1, error: e.message }));
      req.end();
    });
    expect(got.bytes).toBe(5000);
    expect(got.error).toBeDefined();
    const ex = await blocked;
    expect(ex).toMatchObject({ state: 'blocked', status: 200, simulated: 'Fault: truncated response' });
    expect(ex.responseBody).toMatchObject({ truncated: true });
    expect(ex.responseBody!.text.length).toBe(5000);
    expect(hitsOf('/big')).toBe(1);
  });

  it('profile: throttle presets label pass-through, mocks are untouched; offline fails the network, not mocks', async () => {
    expect(proxy.networkProfile).toEqual({ kind: 'none' });
    proxy.setNetworkProfile(presetProfile('fast-3g'));
    expect(proxy.networkProfile).toMatchObject({ kind: 'throttle', preset: 'fast-3g', latencyMs: 150 });
    proxy.setRules([rule({ id: 'm', match: { url: '*/mocked' }, action: { kind: 'mock', status: 200, body: 'm' } })]);
    const t0 = Date.now();
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/mocked`)).text).toBe('m');
    expect((await postTraces({ traces: [] })).status).toBe(204);
    let all = await settled(proxy);
    expect(all.map((e) => [e.state, e.simulated])).toEqual([
      ['completed', 'Fast 3G'],
      ['mocked', undefined],
    ]);

    proxy.clear();
    proxy.setNetworkProfile({ kind: 'offline' });
    await expect(viaProxy(proxy.port, `${up.httpsUrl}/json`)).rejects.toThrow();
    expect((await viaProxy(proxy.port, `${up.httpUrl}/mocked`)).text).toBe('m');
    // send() is subject to the profile too
    const { id } = await proxy.send({ method: 'GET', url: `${up.httpUrl}/json`, initiator: 'agent' });
    all = await settled(proxy);
    expect(all.find((e) => e.id === id)).toMatchObject({ state: 'blocked', simulated: 'Offline', initiator: 'agent' });
    expect(all.map((e) => e.state)).toEqual(['blocked', 'mocked', 'blocked']);
    expect(up.hits).toEqual(['GET /json']); // only the Fast 3G one

    proxy.setNetworkProfile({ kind: 'none' });
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).status).toBe(200);
    expect(() => proxy.setNetworkProfile({ kind: 'throttle', dropRate: 2 })).toThrow();
    expect(() => proxy.setNetworkProfile({ kind: 'nope' } as never)).toThrow();
  });

  it('profile kbps applies to a response breakpoint (single end) and a throttle rule overrides the profile', async () => {
    proxy.setNetworkProfile({ kind: 'throttle', kbps: 800 });
    proxy.setRules([rule({ id: 'bp', match: { url: '*/big*' }, action: { kind: 'breakpoint', phase: 'response' } })]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/big?size=${60 * 1024}`);
    const ex = await paused;
    const t0 = Date.now();
    proxy.resume(ex.id);
    expect((await resP).body.length).toBe(60 * 1024);
    expect(Date.now() - t0).toBeGreaterThan(450);

    proxy.setRules([rule({ id: 'fast', action: { kind: 'throttle', latencyMs: 10 } })]);
    const t1 = Date.now();
    expect((await viaProxy(proxy.port, `${up.httpUrl}/big?size=${60 * 1024}`)).body.length).toBe(60 * 1024);
    expect(Date.now() - t1).toBeLessThan(400);
  });

  it('the app leaving mid-throttle is recorded, the proxy keeps serving', async () => {
    proxy.setRules([rule({ id: 't', action: { kind: 'throttle', kbps: 80 } })]); // 10 KB/s
    await expect(viaProxy(proxy.port, `${up.httpUrl}/big?size=${100 * 1024}`, { timeoutMs: 300 })).rejects.toThrow();
    const ex = await nextExchange(proxy, inState('error'));
    expect(ex.error).toBeTruthy();
    proxy.setRules([]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- rewriteLocalhost

describe('rewriteLocalhost', () => {
  it('10.0.2.2 / 10.0.3.2 reach 127.0.0.1 on the same port (http and https); URL and Host stay', async () => {
    const port = new URL(up.httpUrl).port;
    const sport = new URL(up.httpsUrl).port;
    for (const alias of ['10.0.2.2', '10.0.3.2']) {
      const r = await viaProxy(proxy.port, `http://${alias}:${port}/echo`, { timeoutMs: 5000 });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).headers.host).toBe(`${alias}:${port}`);
    }
    expect((await viaProxy(proxy.port, `https://10.0.2.2:${sport}/json`, { timeoutMs: 5000 })).status).toBe(200);
    const all = await settled(proxy);
    expect(all.map((e) => e.url)).toEqual([`http://10.0.2.2:${port}/echo`, `http://10.0.3.2:${port}/echo`, `https://10.0.2.2:${sport}/json`]);
    expect(all.every((e) => e.state === 'completed')).toBe(true);
  });

  it('localhost and 127.0.0.1 targets reach the host; a loop to the proxy itself ends (no hang)', async () => {
    const port = new URL(up.httpUrl).port;
    expect((await viaProxy(proxy.port, `http://localhost:${port}/json`)).status).toBe(200);
    expect((await viaProxy(proxy.port, `http://127.0.0.1:${port}/json`)).status).toBe(200);
    for (const host of ['127.0.0.1', '10.0.2.2']) {
      const r = await viaProxy(proxy.port, `http://${host}:${proxy.port}/loop`, { timeoutMs: 5000 });
      expect(r.status).toBeGreaterThanOrEqual(500);
    }
    expect((await viaProxy(proxy.port, `http://127.0.0.1:${port}/json`)).status).toBe(200);
  });

  it('off: 10.0.2.2 is not rewritten', async () => {
    const off = await startProxy({ rewriteLocalhost: false });
    try {
      const port = new URL(up.httpUrl).port;
      const r = await viaProxy(off.port, `http://10.0.2.2:${port}/json`, { timeoutMs: 1500 }).catch((e: Error) => e);
      expect(r instanceof Error ? r.message : r.status).not.toBe(200);
      expect(up.hits).toEqual([]);
    } finally {
      await off.stop();
    }
  });
});
