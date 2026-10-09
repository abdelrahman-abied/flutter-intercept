import * as zlib from 'zlib';
import * as net from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InterceptProxy, type Exchange, type Rule } from '../src';
import { listenHostTesting } from '../src/listen-host';
import { firstChunkViaProxy, settled, inState, nextExchange, sleep, startProxy, startUpstream, viaProxy, type Upstream } from './helpers';

let up: Upstream;
let proxy: InterceptProxy;

beforeAll(async () => {
  up = await startUpstream();
});
afterAll(async () => {
  await up.close();
});
beforeEach(async () => {
  proxy = await startProxy();
  up.hits.length = 0;
});
afterEach(async () => {
  await proxy.stop();
});

const bp = (phase: 'request' | 'response' | 'both', url = '*', id = 'bp'): Rule => ({
  id,
  enabled: true,
  match: { url },
  action: { kind: 'breakpoint', phase },
});

describe('lifecycle', () => {
  it('listens on 127.0.0.1 by default and reports the actual port', () => {
    expect(proxy.port).toBeGreaterThan(0);
    const raw = (proxy as unknown as { server: { server: net.Server } }).server.server;
    const addr = raw.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBe(proxy.port);
  });

  it('honours host 0.0.0.0', async () => {
    const p = await startProxy({ host: '0.0.0.0' });
    const raw = (p as unknown as { server: { server: net.Server } }).server.server;
    expect((raw.address() as net.AddressInfo).address).toBe('0.0.0.0');
    const r = await viaProxy(p.port, `${up.httpUrl}/json`);
    expect(r.status).toBe(200);
    await p.stop();
  });

  it('bind fails CLOSED: hook missing → fallback re-listens on 127.0.0.1; both missing → start() throws, nothing listens', async () => {
    try {
      listenHostTesting.disableHook = true;
      const p = await startProxy();
      const raw = (p as unknown as { server: { server: net.Server } }).server.server;
      expect((raw.address() as net.AddressInfo).address).toBe('127.0.0.1');
      await p.stop();

      listenHostTesting.disableRebind = true;
      const port = await new Promise<number>((r) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
          const n = (s.address() as net.AddressInfo).port;
          s.close(() => r(n));
        });
      });
      const q = new InterceptProxy({ port });
      await expect(q.start()).rejects.toThrow(/bound to :: instead of 127\.0\.0\.1; refusing to run/);
      expect(q.port).toBe(0);
      // the port was released
      await new Promise<void>((resolve, reject) => {
        const c = net.connect(port, '127.0.0.1');
        c.on('connect', () => reject(new Error('still listening')));
        c.on('error', () => resolve());
      });
    } finally {
      listenHostTesting.disableHook = false;
      listenHostTesting.disableRebind = false;
    }
  });

  it('start() on a busy port rejects', async () => {
    const p = new InterceptProxy({ port: proxy.port });
    await expect(p.start()).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('pass-through recording', () => {
  it('records an HTTP exchange', async () => {
    const seen: Exchange[] = [];
    proxy.on('exchange', (e) => seen.push(e));
    const r = await viaProxy(proxy.port, `${up.httpUrl}/json?x=1`);
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"hello":"world"}');
    const [ex] = (await settled(proxy));
    expect(ex).toMatchObject({
      method: 'GET',
      url: `${up.httpUrl}/json?x=1`,
      status: 200,
      state: 'completed',
      responseBody: { text: '{"hello":"world"}', encoding: 'utf8' },
    });
    expect(ex.responseHeaders?.['x-up']).toBe('1');
    expect(ex.requestHeaders.host).toBe(new URL(up.httpUrl).host);
    expect(ex.durationMs).toBeGreaterThanOrEqual(0);
    expect(ex.matchedRuleId).toBeUndefined();
    // pending (request seen), pending again when its body is recorded, then completed
    expect([...new Set(seen.map((e) => e.state))]).toEqual(['pending', 'completed']);
  });

  it('records an HTTPS (CONNECT) exchange with a POST body', async () => {
    const r = await viaProxy(proxy.port, `${up.httpsUrl}/echo`, { method: 'POST', body: 'ping=1' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).body).toBe('ping=1');
    const [ex] = (await settled(proxy));
    expect(ex.url).toBe(`${up.httpsUrl}/echo`);
    expect(ex.requestBody).toEqual({ text: 'ping=1', encoding: 'utf8' });
    expect(ex.state).toBe('completed');
  });

  it('decodes gzip and br for display, passes the encoded bytes through untouched', async () => {
    const g = await viaProxy(proxy.port, `${up.httpUrl}/gzip`);
    expect(g.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(g.body).toString()).toBe('hello gzip world');
    const b = await viaProxy(proxy.port, `${up.httpsUrl}/br`);
    expect(zlib.brotliDecompressSync(b.body).toString()).toBe('hello br world');
    const [eg, eb] = (await settled(proxy));
    expect(eg.responseBody).toEqual({ text: 'hello gzip world', encoding: 'utf8' });
    expect(eb.responseBody).toEqual({ text: 'hello br world', encoding: 'utf8' });
  });

  it('records binary bodies as base64 and caps bodies at 5 MB', async () => {
    await viaProxy(proxy.port, `${up.httpUrl}/binary`);
    const big = 6 * 1024 * 1024;
    const r = await viaProxy(proxy.port, `${up.httpUrl}/big?size=${big}`);
    expect(r.body.length).toBe(big); // client gets everything
    const [bin, large] = (await settled(proxy));
    expect(bin.responseBody).toEqual({ text: Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80]).toString('base64'), encoding: 'base64' });
    expect(large.responseBody?.truncated).toBe(true);
    expect(large.responseBody?.text.length).toBe(5 * 1024 * 1024);
  });

  it('upstream connection failure: client gets 502 (never hangs), exchange is error', async () => {
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as net.AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const done = nextExchange(proxy, inState('error'));
    const r = await viaProxy(proxy.port, `http://127.0.0.1:${port}/x`);
    expect(r.status).toBe(502);
    const ex = await done;
    expect(ex.status).toBe(502);
    expect(ex.error).toMatch(/ECONNREFUSED/);
  });

  it('upstream failure on a hooked (rule-matched) request is recorded too', async () => {
    proxy.setRules([bp('response')]);
    const done = nextExchange(proxy, inState('error'));
    const r = await viaProxy(proxy.port, `http://127.0.0.1:1/x`);
    expect(r.status).toBe(502);
    expect((await done).matchedRuleId).toBe('bp');
  });

  it('verifies upstream certificates unless told otherwise', async () => {
    const strict = await startProxy({ ignoreUpstreamCertErrors: false });
    const done = nextExchange(strict, inState('error'));
    expect((await viaProxy(strict.port, `${up.httpsUrl}/json`)).status).toBe(502);
    expect((await done).error).toMatch(/certificate/i);
    await strict.stop();
  });

  it('streams responses that match no rule (SSE): first event arrives before the stream ends', async () => {
    const r = await firstChunkViaProxy(proxy.port, `${up.httpUrl}/stream?ms=600`);
    expect(r.text).toBe('data: one\n\ndata: two\n\n');
    expect(r.firstChunkMs).toBeLessThan(300);
    expect(r.totalMs).toBeGreaterThanOrEqual(550);
    const [ex] = (await settled(proxy));
    expect(ex).toMatchObject({ state: 'completed', responseBody: { text: 'data: one\n\ndata: two\n\n' } });
  });

  it('reuses upstream connections across client connections (Dart opens a tunnel per request)', async () => {
    const before = { ...up.connections };
    for (let i = 0; i < 4; i++) {
      // viaProxy opens a new TCP connection + CONNECT tunnel every time, like dart:io does.
      // Node's agent-less client would send `Connection: close` (forwarded upstream by mockttp);
      // dart:io sends no Connection header, so mimic that with keep-alive.
      const headers = { connection: 'keep-alive' };
      expect((await viaProxy(proxy.port, `${up.httpsUrl}/json`, { headers })).status).toBe(200);
      expect((await viaProxy(proxy.port, `${up.httpUrl}/json`, { headers })).status).toBe(200);
    }
    expect(up.connections.https - before.https).toBe(1);
    expect(up.connections.http - before.http).toBe(1);
  });

  it('snapshots are copies', async () => {
    let snap: Exchange | undefined;
    proxy.on('exchange', (e) => (snap = e));
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    snap!.state = 'error';
    snap!.url = 'mutated';
    expect((await settled(proxy))[0]).toMatchObject({ state: 'completed', url: `${up.httpUrl}/json` });
  });
});

describe('mock and block never contact the server', () => {
  it('mock', async () => {
    proxy.setRules([
      {
        id: 'm1',
        enabled: true,
        match: { method: 'get', url: '*/users/*' },
        action: { kind: 'mock', status: 201, headers: { 'content-type': 'application/json', 'x-mock': 'yes' }, body: '{"mocked":true}', delayMs: 150 },
      },
    ]);
    const t0 = Date.now();
    const r = await viaProxy(proxy.port, `${up.httpsUrl}/users/7`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(r.status).toBe(201);
    expect(r.headers['x-mock']).toBe('yes');
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength('{"mocked":true}')));
    expect(r.text).toBe('{"mocked":true}');
    expect(up.hits).toEqual([]);
    const [ex] = (await settled(proxy));
    expect(ex).toMatchObject({ state: 'mocked', status: 201, matchedRuleId: 'm1', responseBody: { text: '{"mocked":true}' } });
  });

  it('mock with content-encoding gzip is encoded consistently', async () => {
    proxy.setRules([{ id: 'm', enabled: true, match: { url: '*' }, action: { kind: 'mock', status: 200, headers: { 'Content-Encoding': 'gzip' }, body: 'zipped' } }]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/a`);
    expect(zlib.gunzipSync(r.body).toString()).toBe('zipped');
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
  });

  it('block with status (default 403 and custom)', async () => {
    proxy.setRules([
      { id: 'b451', enabled: true, match: { url: '*/legal*' }, action: { kind: 'block', mode: 'status', status: 451 } },
      { id: 'b', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'status' } },
    ]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).status).toBe(403);
    expect((await viaProxy(proxy.port, `${up.httpsUrl}/legal`)).status).toBe(451);
    expect(up.hits).toEqual([]);
    expect((await settled(proxy)).map((e) => [e.state, e.status, e.matchedRuleId])).toEqual([
      ['blocked', 403, 'b'],
      ['blocked', 451, 'b451'],
    ]);
  });

  it('block with reset', async () => {
    proxy.setRules([{ id: 'r', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }]);
    await expect(viaProxy(proxy.port, `${up.httpUrl}/json`)).rejects.toThrow(/ECONNRESET|socket hang up/);
    await expect(viaProxy(proxy.port, `${up.httpsUrl}/json`)).rejects.toThrow(/ECONNRESET|socket hang up/);
    expect(up.hits).toEqual([]);
    await sleep(50); // let mockttp's abort event pass, it must not overwrite 'blocked'
    expect((await settled(proxy)).map((e) => e.state)).toEqual(['blocked', 'blocked']);
  });
});

describe('request breakpoints', () => {
  it('pauses before forwarding and resumes with an edited method/url/headers/body', async () => {
    proxy.setRules([bp('request', '*/json*')]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = viaProxy(proxy.port, `${up.httpsUrl}/json`, { headers: { 'x-a': '1' } });
    const ex = await paused;
    expect(ex.matchedRuleId).toBe('bp');
    await sleep(100);
    expect(up.hits).toEqual([]); // not forwarded yet
    proxy.resume(ex.id, {
      method: 'post',
      url: `${up.httpsUrl}/echo?edited=1`,
      headers: { 'content-type': 'text/plain', 'x-b': '2' },
      body: 'edited body ✓',
    });
    const r = await resP;
    const echo = JSON.parse(r.text);
    expect(echo.method).toBe('POST');
    expect(echo.path).toBe('/echo?edited=1');
    expect(echo.body).toBe('edited body ✓');
    expect(echo.headers['x-b']).toBe('2');
    expect(echo.headers['x-a']).toBeUndefined(); // headers replace the set
    expect(echo.headers['content-length']).toBe(String(Buffer.byteLength('edited body ✓')));
    const [done] = (await settled(proxy));
    expect(done).toMatchObject({ state: 'completed', method: 'POST', url: `${up.httpsUrl}/echo?edited=1`, requestBody: { text: 'edited body ✓' } });
  });

  it('sets pausedAt / pauseDeadline while paused and clears them after', async () => {
    const p = await startProxy({ breakpointTimeoutMs: 60_000 });
    p.setRules([bp('request')]);
    const paused = nextExchange(p, inState('paused-request'));
    const resP = viaProxy(p.port, `${up.httpUrl}/json`);
    const ex = await paused;
    expect(ex.pausedAt).toBeGreaterThan(Date.now() - 5000);
    expect(ex.pauseDeadline).toBe(ex.pausedAt! + 60_000);
    p.resume(ex.id);
    await resP;
    const [done] = (await settled(p));
    expect(done.pausedAt).toBeUndefined();
    expect(done.pauseDeadline).toBeUndefined();
    await p.stop();
  });

  it('edit headers accept string[] values', async () => {
    proxy.setRules([bp('request')]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/echo`);
    proxy.resume((await paused).id, { headers: { 'x-multi': ['a', 'b'] } });
    expect(JSON.parse((await resP).text).headers['x-multi']).toBe('a, b');
  });

  it('can redirect to another host (Host header follows the URL)', async () => {
    const other = await startUpstream();
    proxy.setRules([bp('request')]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/echo`);
    const ex = await paused;
    proxy.resume(ex.id, { url: `${other.httpUrl}/echo`, headers: ex.requestHeaders as Record<string, string> });
    const echo = JSON.parse((await resP).text);
    expect(echo.headers.host).toBe(new URL(other.httpUrl).host);
    expect(other.hits).toEqual(['GET /echo']);
    expect(up.hits).toEqual([]);
    await other.close();
  });

  it('abort resets the client and never contacts the server', async () => {
    proxy.setRules([bp('request')]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/json`);
    proxy.abort((await paused).id);
    await expect(resP).rejects.toThrow(/ECONNRESET|socket hang up/);
    expect(up.hits).toEqual([]);
    await sleep(50);
    expect((await settled(proxy))[0].state).toBe('aborted');
  });

  it('invalid edits throw and leave the exchange paused', async () => {
    proxy.setRules([bp('request')]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/json`);
    const ex = await paused;
    expect(() => proxy.resume(ex.id, { url: 'not a url' })).toThrow(/Invalid URL/);
    expect((await settled(proxy))[0].state).toBe('paused-request');
    proxy.resume(ex.id);
    expect((await resP).status).toBe(200);
  });

  it('resume/abort of unknown or finished ids are no-ops', async () => {
    expect(() => proxy.resume('nope')).not.toThrow();
    expect(() => proxy.abort('nope')).not.toThrow();
  });
});

describe('response breakpoints', () => {
  it('pauses after the real response and delivers an edited body with consistent headers', async () => {
    proxy.setRules([bp('response', '*/json')]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpsUrl}/json`);
    const ex = await paused;
    expect(up.hits).toEqual(['GET /json']);
    expect(ex.status).toBe(200);
    expect(ex.responseBody?.text).toBe('{"hello":"world"}');
    proxy.resume(ex.id, { body: '{"hello":"edited, longer than before"}' });
    const r = await resP;
    expect(r.text).toBe('{"hello":"edited, longer than before"}');
    expect(r.headers['content-length']).toBe(String(r.body.length));
    expect(r.headers['x-up']).toBe('1');
    expect((await settled(proxy))[0]).toMatchObject({ state: 'completed', responseBody: { text: '{"hello":"edited, longer than before"}' } });
  });

  it('re-encodes an edited gzip body', async () => {
    proxy.setRules([bp('response')]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/gzip`);
    const ex = await paused;
    expect(ex.responseBody?.text).toBe('hello gzip world');
    proxy.resume(ex.id, { body: 'edited gzip world' });
    const r = await resP;
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
    expect(zlib.gunzipSync(r.body).toString()).toBe('edited gzip world');
  });

  it('edited headers without content-encoding deliver an identity body; chunked br upstream', async () => {
    proxy.setRules([bp('response')]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/br`);
    const ex = await paused;
    const headers = { ...(ex.responseHeaders as Record<string, string>) };
    delete headers['content-encoding'];
    headers['x-edited'] = 'yes';
    proxy.resume(ex.id, { headers, status: 299 });
    const r = await resP;
    expect(r.status).toBe(299);
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.headers['transfer-encoding']).toBeUndefined();
    expect(r.headers['x-edited']).toBe('yes');
    expect(r.text).toBe('hello br world');
    expect(r.headers['content-length']).toBe(String(r.body.length));
  });

  it('status-only edit keeps the original body', async () => {
    proxy.setRules([bp('response')]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/json`);
    proxy.resume((await paused).id, { status: 500 });
    const r = await resP;
    expect(r.status).toBe(500);
    expect(r.text).toBe('{"hello":"world"}');
    expect((await settled(proxy))[0].status).toBe(500);
  });

  it('abort resets the client', async () => {
    proxy.setRules([bp('response')]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpsUrl}/json`);
    proxy.abort((await paused).id);
    await expect(resP).rejects.toThrow(/ECONNRESET|socket hang up/);
    await sleep(50);
    expect((await settled(proxy))[0].state).toBe('aborted');
  });

  it("phase 'both' pauses twice", async () => {
    proxy.setRules([bp('both')]);
    const states: string[] = [];
    proxy.on('exchange', (e) => states.push(e.state));
    const p1 = nextExchange(proxy, inState('paused-request'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/json`);
    const ex = await p1;
    const p2 = nextExchange(proxy, inState('paused-response'));
    proxy.resume(ex.id);
    proxy.resume((await p2).id, { body: 'both' });
    expect((await resP).text).toBe('both');
    expect(states).toEqual(['paused-request', 'pending', 'paused-response', 'completed']);
  });
});

describe('concurrency, timeouts, client disconnects', () => {
  it('several paused requests resume independently', async () => {
    proxy.setRules([bp('response')]);
    const n = 6;
    const pausedIds: string[] = [];
    const allPaused = new Promise<void>((resolve) =>
      proxy.on('exchange', (e) => {
        if (e.state === 'paused-response') {
          pausedIds.push(e.id);
          if (pausedIds.length === n) resolve();
        }
      }),
    );
    const results = Array.from({ length: n }, (_, i) =>
      viaProxy(proxy.port, `${i % 2 ? up.httpsUrl : up.httpUrl}/echo?i=${i}`),
    );
    await allPaused;
    const byId = new Map((await settled(proxy)).map((e) => [e.id, e]));
    // resume in reverse order, each with its own body, aborting one
    for (const id of [...pausedIds].reverse()) {
      const i = new URL(byId.get(id)!.url).searchParams.get('i')!;
      if (i === '3') proxy.abort(id);
      else proxy.resume(id, { body: `body-${i}` });
    }
    const outcomes = await Promise.allSettled(results);
    outcomes.forEach((s, i) => {
      if (i === 3) expect(s.status).toBe('rejected');
      else expect(s).toMatchObject({ status: 'fulfilled', value: { text: `body-${i}` } });
    });
  });

  it('breakpointTimeoutMs auto-resumes unedited', async () => {
    const p = await startProxy({ breakpointTimeoutMs: 300 });
    p.setRules([bp('both')]);
    const t0 = Date.now();
    const r = await viaProxy(p.port, `${up.httpUrl}/json`);
    expect(r.text).toBe('{"hello":"world"}');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect((await settled(p))[0].state).toBe('completed');
    await p.stop();
  });

  it('client giving up while the response is paused: exchange errors, late resume is a no-op', async () => {
    proxy.setRules([bp('response', '*/json')]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpsUrl}/json`, { timeoutMs: 300 });
    const ex = await paused;
    await expect(resP).rejects.toThrow(/client timeout/);
    const errored = await nextExchange(proxy, (e) => e.id === ex.id && e.state === 'error');
    expect(errored.error).toMatch(/while the response was paused/);
    expect(() => proxy.resume(ex.id, { body: 'late' })).not.toThrow();
    expect(() => proxy.abort(ex.id)).not.toThrow();
    // proxy keeps working
    expect((await viaProxy(proxy.port, `${up.httpsUrl}/echo`)).status).toBe(200);
    expect((await settled(proxy)).find((e) => e.id === ex.id)?.state).toBe('error');
  });

  it('client giving up while the request is paused: the request is never forwarded', async () => {
    proxy.setRules([bp('request', '*/json')]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/json`, { timeoutMs: 300 });
    const ex = await paused;
    await expect(resP).rejects.toThrow(/client timeout/);
    await nextExchange(proxy, (e) => e.id === ex.id && e.state === 'error');
    proxy.resume(ex.id);
    await sleep(100);
    expect(up.hits).toEqual([]);
  });

  it('stop() while paused does not hang', async () => {
    const p = await startProxy();
    p.setRules([bp('request')]);
    const paused = nextExchange(p, inState('paused-request'));
    const resP = viaProxy(p.port, `${up.httpUrl}/json`).catch((e) => e);
    await paused;
    await p.stop();
    expect(await resP).toBeInstanceOf(Error);
    expect((await settled(p))[0]).toMatchObject({ state: 'error', error: 'Proxy stopped' });
  });
});

describe('store', () => {
  it('ring buffer keeps the newest maxExchanges but never evicts paused ones', async () => {
    const p = await startProxy({ maxExchanges: 5 });
    p.setRules([bp('request', '*/slow*')]);
    const paused = nextExchange(p, inState('paused-request'));
    const slow = viaProxy(p.port, `${up.httpUrl}/slow?ms=1`);
    const pausedEx = await paused;
    for (let i = 0; i < 12; i++) await viaProxy(p.port, `${up.httpUrl}/echo?n=${i}`);
    const urls = (await settled(p)).map((e) => e.url);
    expect(urls).toHaveLength(5);
    expect(urls[0]).toContain('/slow');
    expect(urls.slice(1).map((u) => new URL(u).searchParams.get('n'))).toEqual(['8', '9', '10', '11']);
    p.resume(pausedEx.id);
    expect((await slow).text).toBe('slow done');
    await p.stop();
  });

  it("emits 'removed' with evicted ids", async () => {
    const p = await startProxy({ maxExchanges: 2 });
    const removed: string[][] = [];
    p.on('removed', (ids) => removed.push(ids));
    for (let i = 0; i < 4; i++) await viaProxy(p.port, `${up.httpUrl}/echo?n=${i}`);
    const kept = (await settled(p)).map((e) => e.id);
    expect(kept).toHaveLength(2);
    expect(removed.flat()).toHaveLength(2);
    expect(removed.flat().some((id) => kept.includes(id))).toBe(false);
    await p.stop();
  });

  it('maxStoredBodyBytes evicts old exchanges by body size', async () => {
    const p = await startProxy({ maxStoredBodyBytes: 250_000 });
    for (let i = 0; i < 6; i++) await viaProxy(p.port, `${up.httpUrl}/big?size=100000&n=${i}`);
    const kept = (await settled(p));
    expect(kept.length).toBe(2);
    expect(new URL(kept[1].url).searchParams.get('n')).toBe('5');
    await p.stop();
  });

  it('clear() drops finished exchanges and keeps in-flight ones', async () => {
    proxy.setRules([bp('request', '*/slow*')]);
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    const paused = nextExchange(proxy, inState('paused-request'));
    const slow = viaProxy(proxy.port, `${up.httpUrl}/slow?ms=1`);
    const ex = await paused;
    proxy.clear();
    expect((await settled(proxy)).map((e) => e.id)).toEqual([ex.id]);
    proxy.resume(ex.id);
    await slow;
    proxy.clear();
    expect((await settled(proxy))).toEqual([]);
  });
});
