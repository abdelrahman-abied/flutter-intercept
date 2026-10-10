// v0.6.0 (CONTRACTS §12.3, §12.4, §12.6): sequence rules, Map Remote, rewrite, replay, upstream proxy.
import * as http from 'http';
import * as net from 'net';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { once } from 'events';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy, ReplayEntry, Rule } from '../src';
import { mapRemoteUrl, pathTemplate, pickSequenceStep, routeTemplate, ruleProblem } from '../src/rules';
import { ReplayStore } from '../src/replay';
import { firstChunkViaProxy, settled, sleep, startProxy, startTinyProxy, startUpstream, viaProxy, type TinyProxy, type Upstream } from './helpers';

const mock = (body: string, status = 200) => ({ kind: 'mock' as const, status, body, headers: { 'content-type': 'text/plain' } });
const rule = (id: string, url: string, action: Rule['action'], extra: Partial<Rule> = {}): Rule => ({ id, enabled: true, match: { url }, action, ...extra });

// ---------------------------------------------------------------- pure helpers

describe('pure helpers', () => {
  it('pickSequenceStep: counts, then last / passthrough / loop, invalid steps', () => {
    const a = { steps: [{ action: mock('a'), count: 2 }, { action: { kind: 'passthrough' as const } }, { action: mock('c') }] };
    const at = (then: 'last' | 'passthrough' | 'loop' | undefined, n: number) => pickSequenceStep({ ...a, then }, n);
    expect([0, 1, 2, 3, 4, 5].map((n) => at(undefined, n).index)).toEqual([0, 0, 1, 2, 2, 2]);
    expect(at(undefined, 2).action).toBeUndefined(); // passthrough step
    expect([3, 4].map((n) => at('passthrough', n))).toEqual([{ action: a.steps[2].action, index: 2 }, { action: undefined, index: -1 }]);
    expect([4, 5, 6, 7, 8].map((n) => at('loop', n).index)).toEqual([0, 0, 1, 2, 0]);
    expect(pickSequenceStep({ steps: [] }, 0)).toEqual({ action: undefined, index: -1 });
    const bad = pickSequenceStep({ steps: [{ action: { kind: 'breakpoint', phase: 'request' } as never }] }, 0);
    expect(bad.action).toBeUndefined();
    expect(bad.invalid).toMatch(/not allowed/);
    expect(pickSequenceStep({ steps: [{ action: mock('x'), count: 0 }, { action: mock('y') }] }, 1).index).toBe(1); // count < 1 = 1
  });

  it('mapRemoteUrl: origin, prefix replacement, regex rules, ws schemes, invalid targets', () => {
    const o = 'https://api.example.com/v1/users/7?x=1';
    expect(mapRemoteUrl(o, 'https://api.example.com/*', 'https://staging.example.com')).toBe('https://staging.example.com/v1/users/7?x=1');
    expect(mapRemoteUrl(o, 'https://api.example.com/*', 'http://localhost:8080/')).toBe('http://localhost:8080/v1/users/7?x=1');
    expect(mapRemoteUrl(o, 'https://api.example.com/v1/*', 'http://localhost:8080/api/v2')).toBe('http://localhost:8080/api/v2/users/7?x=1');
    expect(mapRemoteUrl(o, 'https://api.example.com/v1/*', 'http://localhost:8080/api/v2/')).toBe('http://localhost:8080/api/v2/users/7?x=1');
    expect(mapRemoteUrl(o, 'https://api.example.com/v1*', 'http://l/v2')).toBe('http://l/v2/users/7?x=1');
    expect(mapRemoteUrl(o, o, 'http://l/fixed')).toBe('http://l/fixed'); // exact URL → exact URL
    expect(mapRemoteUrl(o, '/users\\/\\d+/', 'http://l/mock')).toBe('http://l/mock/v1/users/7?x=1');
    expect(mapRemoteUrl(o, '*/users/*', 'http://l/mock')).toBe('http://l/mock/v1/users/7?x=1');
    expect(mapRemoteUrl('wss://api.example.com/chat', 'wss://api.example.com/*', 'https://staging.example.com')).toBe('wss://staging.example.com/chat');
    expect(mapRemoteUrl('https://a/x', '*', 'ws://b:9')).toBe('http://b:9/x');
    expect(() => mapRemoteUrl(o, '*', 'ftp://x')).toThrow(/http/);
    expect(() => mapRemoteUrl(o, '*', 'http://u:p@x')).toThrow(/credentials/);
    expect(() => mapRemoteUrl(o, '*', 'nope')).toThrow(/not a URL/);
  });

  it('pathTemplate / routeTemplate: numeric, uuid, hex and opaque id segments', () => {
    expect(pathTemplate('/users/42/posts/0f8c2e9a-1b3d-4c5e-8f7a-9b0c1d2e3f4a')).toBe('/users/{id}/posts/{id2}');
    expect(pathTemplate('/objects/5f2b8c9e1a2b3c4d5e6f7a8b?x=1')).toBe('/objects/{id}');
    expect(pathTemplate('/v1/users/me')).toBe('/v1/users/me');
    expect(routeTemplate('HTTPS://API.example.com:443/users/7')).toBe('https://api.example.com/users/{id}');
  });

  it('ruleProblem: v0.6.0 actions', () => {
    expect(ruleProblem(rule('a', '*', { kind: 'sequence', steps: [] }))).toMatch(/at least one step/);
    expect(ruleProblem(rule('a', '*', { kind: 'sequence', steps: [{ action: { kind: 'breakpoint', phase: 'both' } as never }] }))).toMatch(/can't be a step/);
    expect(ruleProblem(rule('a', '*', { kind: 'mapRemote', to: 'ftp://x' }))).toMatch(/http/);
    expect(ruleProblem(rule('a', 'wss://x/*', { kind: 'mapRemote', to: 'https://y' }))).toBeUndefined();
    expect(ruleProblem(rule('a', '*', { kind: 'rewrite', response: { status: 99 } }))).toMatch(/200–599/);
    expect(ruleProblem(rule('a', '*', { kind: 'rewrite', response: { replaceBody: [{ find: '', replace: 'x' }] } }))).toMatch(/non-empty/);
    expect(ruleProblem(rule('a', 'wss://x/*', { kind: 'sequence', steps: [{ action: mock('x') }] }))).toMatch(/WebSocket/);
  });

  it('ReplayStore: exact, body hash, templates, order then repeat last', () => {
    const h = (s: string) => createHash('sha256').update(s).digest('hex');
    const e = (url: string, text: string, extra: Partial<ReplayEntry> = {}): ReplayEntry => ({
      method: 'GET', url, status: 200, headers: {}, body: { text, encoding: 'utf8' }, ...extra,
    });
    const s = new ReplayStore(
      [
        e('https://a.test/users/1', 'one'),
        e('https://a.test/users/1', 'one-again'),
        e('https://a.test/gql', 'q1', { method: 'POST', requestBodyHash: h('{"q":1}') }),
        e('https://a.test/gql', 'q2', { method: 'POST', requestBodyHash: h('{"q":2}') }),
        { bad: true } as never,
      ],
      { fallback: 'passthrough', matchTemplates: true, name: 'demo' },
    );
    expect([s.size, s.skipped, s.name]).toEqual([4, 1, 'demo']);
    const text = (r: ReturnType<ReplayStore['lookup']>) => (r && typeof r === 'object' ? r.entry.body?.text : r);
    expect(text(s.lookup('GET', 'https://a.test/users/1', {}, true))).toBe('one');
    expect(text(s.lookup('GET', 'https://a.test/users/1', {}, true))).toBe('one-again');
    expect(text(s.lookup('GET', 'https://a.test/users/1', {}, true))).toBe('one-again'); // last repeats
    expect(text(s.lookup('GET', 'https://a.test/users/99', {}, true))).toBe('one'); // template tier, own counter
    expect(s.lookup('POST', 'https://a.test/gql', 'unknown', true)).toBe('needs-body');
    expect(text(s.lookup('POST', 'https://a.test/gql', { hash: h('{"q":2}') }, true))).toBe('q2');
    expect(s.lookup('POST', 'https://a.test/gql', { hash: h('other') }, true)).toBeUndefined();
    expect(s.lookup('POST', 'https://a.test/gql', 'unreadable', true)).toBeUndefined();
    expect(s.lookup('GET', 'https://b.test/users/1', {}, true)).toBeUndefined();
    const noTpl = new ReplayStore([e('https://a.test/users/1', 'one')], { fallback: 'fail' });
    expect(noTpl.lookup('GET', 'https://a.test/users/2', {}, true)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- through the proxy

let up: Upstream;
let proxy: InterceptProxy;

beforeAll(async () => {
  up = await startUpstream();
});
afterAll(async () => {
  await up?.close();
});
afterEach(async () => {
  await proxy?.stop();
  up.hits.length = 0;
});

describe('sequence rules (§12.3)', () => {
  beforeEach(async () => {
    proxy = await startProxy();
  });

  it('first 500 ×2, then the real server; rule-hit reports the step; exchanges are labelled', async () => {
    const hits: unknown[][] = [];
    proxy.on('rule-hit', (...a: unknown[]) => hits.push(a));
    proxy.setRules([rule('s', `${up.httpUrl}/json`, { kind: 'sequence', steps: [{ action: mock('boom', 500), count: 2 }, { action: { kind: 'passthrough' } }] })]);
    const got: Array<[number, string]> = [];
    for (let i = 0; i < 4; i++) {
      const r = await viaProxy(proxy.port, `${up.httpUrl}/json`);
      got.push([r.status, r.text]);
    }
    expect(got).toEqual([[500, 'boom'], [500, 'boom'], [200, '{"hello":"world"}'], [200, '{"hello":"world"}']]);
    expect(up.hits).toEqual(['GET /json', 'GET /json']);
    await sleep(20);
    expect(hits).toEqual([['s', 1, 0], ['s', 2, 0], ['s', 3, 1], ['s', 4, 1]]);
    const ex = await settled(proxy);
    expect(ex.map((e) => [e.state, e.matchedRuleId, e.simulated])).toEqual([
      ['mocked', 's', 'Sequence step 1/2'],
      ['mocked', 's', 'Sequence step 1/2'],
      ['completed', 's', 'Sequence step 2/2'],
      ['completed', 's', 'Sequence step 2/2'],
    ]);
  });

  it('routes per current step: a passthrough step streams, a mutate step buffers and mutates', async () => {
    proxy.setRules([
      rule('st', `${up.httpUrl}/stream*`, { kind: 'sequence', steps: [{ action: mock('data: mocked\n\n') }, { action: { kind: 'passthrough' } }] }),
      rule('mu', `${up.httpUrl}/json`, { kind: 'sequence', steps: [{ action: { kind: 'passthrough' } }, { action: { kind: 'mutate', ops: [{ path: '$.hello', op: 'null' }] } }] }),
    ]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/stream?ms=600`)).text).toBe('data: mocked\n\n');
    const streamed = await firstChunkViaProxy(proxy.port, `${up.httpUrl}/stream?ms=600`);
    expect(streamed.firstChunkMs).toBeLessThan(400);
    expect(streamed.totalMs).toBeGreaterThanOrEqual(550);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text).toBe('{"hello":"world"}');
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text).toBe('{"hello":null}');
  });

  it('then: loop and then: passthrough', async () => {
    proxy.setRules([
      rule('l', `${up.httpUrl}/json?l`, { kind: 'sequence', then: 'loop', steps: [{ action: mock('a') }, { action: mock('b') }] }),
      rule('p', `${up.httpUrl}/json?p`, { kind: 'sequence', then: 'passthrough', steps: [{ action: mock('a') }] }),
    ]);
    const l: string[] = [];
    for (let i = 0; i < 5; i++) l.push((await viaProxy(proxy.port, `${up.httpUrl}/json?l`)).text);
    expect(l).toEqual(['a', 'b', 'a', 'b', 'a']);
    const p: string[] = [];
    for (let i = 0; i < 3; i++) p.push((await viaProxy(proxy.port, `${up.httpUrl}/json?p`)).text);
    expect(p).toEqual(['a', '{"hello":"world"}', '{"hello":"world"}']);
    const last = (await settled(proxy)).at(-1)!;
    expect(last.simulated).toBe('Sequence done: passed through');
  });

  it('position: kept across identical setRules, reset when match/action change or by resetSequences()', async () => {
    const url = `${up.httpUrl}/json`;
    const seqRule = (steps: string[], name?: string) => rule('r', url, { kind: 'sequence', steps: steps.map((s) => ({ action: mock(s) })) }, name ? { name } : {});
    const next = async () => (await viaProxy(proxy.port, url)).text;
    proxy.setRules([seqRule(['a', 'b'])]);
    expect([await next(), await next(), await next()]).toEqual(['a', 'b', 'b']);
    proxy.setRules([seqRule(['a', 'b'], 'renamed')]); // name isn't content that resets
    expect(await next()).toBe('b');
    proxy.setRules([seqRule(['a', 'b', 'c'])]);
    expect([await next(), await next()]).toEqual(['a', 'b']);
    proxy.resetSequences();
    expect(await next()).toBe('a');
    proxy.resetSequences(['other']);
    expect(await next()).toBe('b');
  });

  it('times / expiresAt apply to the whole rule; an invalid step passes through with a note', async () => {
    const spent: string[] = [];
    proxy.on('rule-spent', (id: string) => spent.push(id));
    proxy.setRules([
      rule('t', `${up.httpUrl}/json`, { kind: 'sequence', steps: [{ action: mock('a') }, { action: mock('b') }] }, { times: 2 }),
      rule('bad', `${up.httpUrl}/echo`, { kind: 'sequence', steps: [{ action: { kind: 'breakpoint', phase: 'request' } as never }] }),
    ]);
    const t: string[] = [];
    for (let i = 0; i < 3; i++) t.push((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text);
    expect(t).toEqual(['a', 'b', '{"hello":"world"}']);
    await sleep(20);
    expect(spent).toEqual(['t']);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/echo`);
    expect(r.status).toBe(200);
    const ex = (await settled(proxy)).at(-1)!;
    expect(ex).toMatchObject({ state: 'completed', matchedRuleId: 'bad' });
    expect(ex.error).toMatch(/Sequence step 1 \(breakpoint\) is not allowed/);
  });
});

describe('Map Remote (§12.6)', () => {
  it('origin mapping: a name that never resolves goes to the mapped server; Host is the target; URL kept', async () => {
    proxy = await startProxy();
    proxy.setRules([rule('m', 'http://api.example.invalid/*', { kind: 'mapRemote', to: up.httpUrl })]);
    const r = await viaProxy(proxy.port, 'http://api.example.invalid/echo?x=1');
    expect(r.status).toBe(200);
    const echo = JSON.parse(r.text);
    expect(echo.path).toBe('/echo?x=1');
    expect(echo.headers.host).toBe(new URL(up.httpUrl).host);
    const [ex] = await settled(proxy);
    expect(ex).toMatchObject({ state: 'completed', url: 'http://api.example.invalid/echo?x=1', matchedRuleId: 'm', simulated: `Mapped to ${up.httpUrl}` });
    expect(ex.requestHeaders.host).toBe(new URL(up.httpUrl).host);
  });

  it('prefix mapping + preserveHost; streams (first event before the end)', async () => {
    proxy = await startProxy();
    proxy.setRules([
      rule('p', 'http://api.example.invalid/v1/me*', { kind: 'mapRemote', to: `${up.httpUrl}/echo`, preserveHost: true }),
      rule('s', 'http://sse.example.invalid/*', { kind: 'mapRemote', to: up.httpUrl }),
    ]);
    const echo = JSON.parse((await viaProxy(proxy.port, 'http://api.example.invalid/v1/me?x=1')).text);
    expect(echo.path).toBe('/echo?x=1');
    expect(echo.headers.host).toBe('api.example.invalid');
    const s = await firstChunkViaProxy(proxy.port, 'http://sse.example.invalid/stream?ms=600');
    expect(s.firstChunkMs).toBeLessThan(400);
    expect(s.text).toBe('data: one\n\ndata: two\n\n');
  });

  it('HTTPS: the app sees the original host; upstream TLS is verified strictly (unless ignored for that host)', async () => {
    proxy = await startProxy({ ignoreUpstreamCertErrors: false });
    proxy.setRules([rule('m', 'https://api.example.invalid/*', { kind: 'mapRemote', to: up.httpsUrl })]);
    const strict = await viaProxy(proxy.port, 'https://api.example.invalid/json');
    expect(strict.status).toBe(502);
    expect(up.hits).toEqual([]);
    await proxy.stop();
    proxy = await startProxy({ ignoreUpstreamCertErrors: ['127.0.0.1'] });
    proxy.setRules([rule('m', 'https://api.example.invalid/*', { kind: 'mapRemote', to: up.httpsUrl })]);
    const ok = await viaProxy(proxy.port, 'https://api.example.invalid/json');
    expect([ok.status, ok.text]).toEqual([200, '{"hello":"world"}']);
    const ex = (await settled(proxy)).at(-1)!;
    expect(ex).toMatchObject({ url: 'https://api.example.invalid/json', state: 'completed' });
  });

  it('a GraphQL-scoped Map Remote rule (decided in beforeRequest) maps too, Host preserved', async () => {
    proxy = await startProxy();
    proxy.setRules([rule('g', 'http://gql.example.invalid/*', { kind: 'mapRemote', to: up.httpUrl, preserveHost: true }, { match: { url: 'http://gql.example.invalid/*', graphqlOperation: 'Me' } })]);
    const body = JSON.stringify({ query: 'query Me { me { id } }', operationName: 'Me' });
    const r = await viaProxy(proxy.port, 'http://gql.example.invalid/echo', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    const echo = JSON.parse(r.text);
    expect([echo.path, echo.headers.host, echo.body]).toEqual(['/echo', 'gql.example.invalid', body]);
    const [ex] = await settled(proxy);
    expect(ex).toMatchObject({ url: 'http://gql.example.invalid/echo', simulated: `Mapped to ${up.httpUrl}`, state: 'completed' });
  });

  it('an unusable target answers 502 and records why; the network profile applies (offline = fails)', async () => {
    proxy = await startProxy();
    proxy.setRules([rule('bad', 'http://x.example.invalid/*', { kind: 'mapRemote', to: 'ftp://nope' })]);
    const r = await viaProxy(proxy.port, 'http://x.example.invalid/a');
    expect(r.status).toBe(502);
    expect(r.text).toMatch(/Map Remote rule: .*http/);
    const [ex] = await settled(proxy);
    expect(ex.state).toBe('error');
    proxy.setRules([rule('m', 'http://y.example.invalid/*', { kind: 'mapRemote', to: up.httpUrl })]);
    proxy.setNetworkProfile({ kind: 'offline' });
    await expect(viaProxy(proxy.port, 'http://y.example.invalid/json')).rejects.toThrow();
    expect(up.hits).toEqual([]);
  });

  it('WebSocket upgrades are mapped (ws:// → the mapped server, frames recorded, original URL kept)', async () => {
    const h = http.createServer();
    const wss = new WebSocketServer({ server: h });
    const seenHosts: string[] = [];
    wss.on('connection', (ws, req) => {
      seenHosts.push(String(req.headers.host));
      ws.on('message', (d) => ws.send(`echo:${d}`));
    });
    h.listen(0, '127.0.0.1');
    await once(h, 'listening');
    const port = (h.address() as AddressInfo).port;
    try {
      proxy = await startProxy();
      proxy.setRules([rule('w', 'ws://chat.example.invalid/*', { kind: 'mapRemote', to: `http://127.0.0.1:${port}` })]);
      const ws = new WebSocket('ws://chat.example.invalid/room', { createConnection: () => net.connect(proxy.port, '127.0.0.1') } as WebSocket.ClientOptions);
      await once(ws, 'open');
      ws.send('hi');
      const [msg] = (await once(ws, 'message')) as [Buffer];
      expect(msg.toString()).toBe('echo:hi');
      ws.close();
      await once(ws, 'close');
      expect(seenHosts).toEqual([`127.0.0.1:${port}`]);
      const ex = (await settled(proxy)).find((e) => e.kind === 'websocket')!;
      expect(ex).toMatchObject({ url: 'ws://chat.example.invalid/room', simulated: `Mapped to ws://127.0.0.1:${port}`, matchedRuleId: 'w' });
      expect(ex.frames?.map((f) => f.kind)).toEqual(['text', 'text', 'close']);
    } finally {
      for (const c of wss.clients) c.terminate();
      h.closeAllConnections();
      await new Promise((r) => h.close(r));
    }
  });
});

describe('rewrite (§12.6)', () => {
  beforeEach(async () => {
    proxy = await startProxy();
  });

  it('request headers set / removed; response status + headers on the streaming route', async () => {
    proxy.setRules([
      rule('rq', `${up.httpUrl}/echo`, { kind: 'rewrite', request: { setHeaders: { 'x-env': 'staging', 'content-length': '1' }, removeHeaders: ['x-drop'] } }),
      rule('rs', `${up.httpUrl}/stream*`, { kind: 'rewrite', response: { status: 503, setHeaders: { 'x-added': '1' }, removeHeaders: ['cache-control'] } }),
    ]);
    const echo = JSON.parse((await viaProxy(proxy.port, `${up.httpUrl}/echo`, { headers: { 'x-drop': 'secret', 'x-keep': 'k' } })).text);
    expect(echo.headers['x-env']).toBe('staging');
    expect(echo.headers['x-drop']).toBeUndefined();
    expect(echo.headers['x-keep']).toBe('k');
    expect(echo.headers['content-length']).toBeUndefined(); // framing headers can't be rewritten (GET, no body)
    const t0 = Date.now();
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; first: number; text: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `${up.httpUrl}/stream?ms=600`, agent: false });
      req.on('response', (r) => {
        let first = -1;
        let text = '';
        r.on('data', (c) => {
          if (first < 0) first = Date.now() - t0;
          text += c;
        });
        r.on('end', () => resolve({ status: r.statusCode!, headers: r.headers, first, text }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(503);
    expect(res.headers['x-added']).toBe('1');
    expect(res.headers['cache-control']).toBeUndefined();
    expect(res.first).toBeLessThan(400); // still streaming
    const ex = await settled(proxy);
    expect(ex.map((e) => e.simulated)).toEqual(['Rewritten: request headers', 'Rewritten: status 503, response headers']);
    expect(ex[1].status).toBe(503);
  });

  it('response body replace: decoded, re-encoded (gzip kept), re-framed; non-text untouched with a note', async () => {
    proxy.setRules([
      rule('gz', `${up.httpUrl}/gzip`, { kind: 'rewrite', response: { replaceBody: [{ find: 'o', replace: '0', all: true }, { find: 'nothing-here', replace: 'x' }] } }),
      rule('br', `${up.httpUrl}/br`, { kind: 'rewrite', response: { replaceBody: [{ find: 'br', replace: 'BROTLI' }] } }),
      rule('bin', `${up.httpUrl}/binary`, { kind: 'rewrite', response: { replaceBody: [{ find: 'a', replace: 'b' }] } }),
    ]);
    const gz = await viaProxy(proxy.port, `${up.httpUrl}/gzip`);
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(Number(gz.headers['content-length'])).toBe(gz.body.length);
    expect(zlib.gunzipSync(gz.body).toString()).toBe('hell0 gzip w0rld');
    const br = await viaProxy(proxy.port, `${up.httpUrl}/br`);
    expect(zlib.brotliDecompressSync(br.body).toString()).toBe('hello BROTLI world');
    const bin = await viaProxy(proxy.port, `${up.httpUrl}/binary`);
    expect([...bin.body]).toEqual([0, 1, 2, 0xff, 0xfe, 0x80]);
    const ex = await settled(proxy);
    expect(ex[0]).toMatchObject({ state: 'completed', responseBody: { text: 'hell0 gzip w0rld', encoding: 'utf8' }, simulated: 'Rewritten: response body' });
    expect(ex[0].error).toMatch(/1 response body replacement\(s\) found nothing/);
    expect(ex[2].error).toMatch(/not UTF-8 text/);
  });

  it('request body replace (re-framed); a streamed upload skips the body part with a note', async () => {
    proxy.setRules([rule('rb', `${up.httpUrl}/echo`, { kind: 'rewrite', request: { replaceBody: [{ find: 'prod', replace: 'staging', all: true }] } })]);
    const echo = JSON.parse((await viaProxy(proxy.port, `${up.httpUrl}/echo`, { method: 'POST', body: '{"env":"prod","x":"prod"}' })).text);
    expect(echo.body).toBe('{"env":"staging","x":"staging"}');
    expect(echo.headers['content-length']).toBe(String(echo.body.length));
    const [ex] = await settled(proxy);
    expect(ex.requestBody?.text).toBe('{"env":"staging","x":"staging"}');
    // chunked upload: streamed, no body replacement
    const chunked = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: `${up.httpUrl}/echo`, agent: false, headers: { 'transfer-encoding': 'chunked' } });
      req.on('response', (r) => {
        let t = '';
        r.on('data', (c) => (t += c));
        r.on('end', () => resolve(t));
      });
      req.on('error', reject);
      req.write('prod');
      req.end();
    });
    expect(JSON.parse(chunked).body).toBe('prod');
    const last = (await settled(proxy)).at(-1)!;
    expect(last.error).toMatch(/body replacement skipped: the request body is streamed/);
  });
});

describe('replay (§12.4)', () => {
  const gzipEntry = (): ReplayEntry => ({
    method: 'GET',
    url: `${up.httpUrl}/gz-recorded`,
    status: 200,
    headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
    body: { text: 'recorded gzip', encoding: 'utf8' },
  });

  beforeEach(async () => {
    proxy = await startProxy();
  });

  it('answers from the recording in order (last repeats), mocked + labelled; the server is never contacted', async () => {
    const entries: ReplayEntry[] = [
      { method: 'GET', url: `${up.httpUrl}/json`, status: 200, headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] }, body: { text: '{"n":1}', encoding: 'utf8' } },
      { method: 'GET', url: `${up.httpUrl}/json`, status: 201, headers: { 'content-type': 'application/json' }, body: { text: '{"n":2}', encoding: 'utf8' } },
    ];
    expect(proxy.setReplay(entries, { fallback: 'passthrough', name: 'Login flow' })).toBe(2);
    expect(proxy.replay).toEqual({ name: 'Login flow', entries: 2, fallback: 'passthrough', matchTemplates: false });
    const got: Array<[number, string]> = [];
    for (let i = 0; i < 3; i++) {
      const r = await viaProxy(proxy.port, `${up.httpUrl}/json`);
      got.push([r.status, r.text]);
      if (i === 0) {
        expect(r.headers['set-cookie']).toEqual(['a=1', 'b=2']);
        expect(r.headers['content-length']).toBe('7');
      }
    }
    expect(got).toEqual([[200, '{"n":1}'], [201, '{"n":2}'], [201, '{"n":2}']]);
    expect(up.hits).toEqual([]);
    const ex = await settled(proxy);
    expect(ex.map((e) => [e.state, e.simulated])).toEqual(Array(3).fill(['mocked', 'Replayed from Login flow']));
    // unmatched → passthrough
    expect((await viaProxy(proxy.port, `${up.httpUrl}/echo`)).status).toBe(200);
    expect(up.hits).toEqual(['GET /echo']);
    proxy.setReplay(undefined);
    expect(proxy.replay).toBeUndefined();
    expect((await viaProxy(proxy.port, `${up.httpUrl}/json`)).text).toBe('{"hello":"world"}');
  });

  it('request body hash tells POSTs apart; templates match other ids; rules win', async () => {
    const h = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
    proxy.setReplay(
      [
        { method: 'POST', url: `${up.httpUrl}/gql`, status: 200, headers: {}, body: { text: 'A', encoding: 'utf8' }, requestBodyHash: h('{"op":"A"}') },
        { method: 'POST', url: `${up.httpUrl}/gql`, status: 200, headers: {}, body: { text: 'B', encoding: 'utf8' }, requestBodyHash: h('{"op":"B"}') },
        { method: 'GET', url: `${up.httpUrl}/users/42`, status: 200, headers: {}, body: { text: 'user', encoding: 'utf8' } },
      ],
      { fallback: 'fail', matchTemplates: true },
    );
    expect((await viaProxy(proxy.port, `${up.httpUrl}/gql`, { method: 'POST', body: '{"op":"B"}' })).text).toBe('B');
    expect((await viaProxy(proxy.port, `${up.httpUrl}/gql`, { method: 'POST', body: '{"op":"A"}' })).text).toBe('A');
    // gzip-encoded request body: hashed decoded
    const gz = zlib.gzipSync('{"op":"A"}');
    expect((await viaProxy(proxy.port, `${up.httpUrl}/gql`, { method: 'POST', body: gz, headers: { 'content-encoding': 'gzip' } })).text).toBe('A');
    await expect(viaProxy(proxy.port, `${up.httpUrl}/gql`, { method: 'POST', body: '{"op":"C"}' })).rejects.toThrow(); // fail = closed
    expect((await viaProxy(proxy.port, `${up.httpUrl}/users/7`)).text).toBe('user');
    proxy.setRules([rule('r', `${up.httpUrl}/users/*`, mock('rule'))]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/users/7`)).text).toBe('rule');
    expect(up.hits).toEqual([]);
    const ex = await settled(proxy);
    expect(ex[3]).toMatchObject({ state: 'blocked', simulated: 'Not in the recording (replay: fail)' });
  });

  it('fallback fail: plain and HTTPS requests fail inside the tunnel (no DIRECT fallback); nothing reaches the server', async () => {
    proxy.setReplay([], { fallback: 'fail' });
    await expect(viaProxy(proxy.port, `${up.httpUrl}/json`)).rejects.toThrow();
    await expect(viaProxy(proxy.port, `${up.httpsUrl}/json`)).rejects.toThrow(); // CONNECT succeeded, then closed
    expect(up.hits).toEqual([]);
    expect((await settled(proxy)).map((e) => e.state)).toEqual(['blocked', 'blocked']);
  });

  it('re-encodes the body for a recorded content-encoding; binary bodies; wire-encoded bodies are sent as they are', async () => {
    const wire = zlib.gzipSync('already gzip');
    proxy.setReplay(
      [
        gzipEntry(),
        { method: 'GET', url: `${up.httpUrl}/bin`, status: 200, headers: { 'content-type': 'application/octet-stream' }, body: { text: Buffer.from([0, 255, 1]).toString('base64'), encoding: 'base64' } },
        { method: 'GET', url: `${up.httpUrl}/wire`, status: 200, headers: { 'content-encoding': 'gzip' }, body: { text: wire.toString('base64'), encoding: 'base64' } },
        { method: 'HEAD', url: `${up.httpUrl}/head`, status: 204, headers: {} },
      ],
      { fallback: 'passthrough' },
    );
    const g = await viaProxy(proxy.port, `${up.httpUrl}/gz-recorded`);
    expect(g.headers['content-encoding']).toBe('gzip');
    expect(Number(g.headers['content-length'])).toBe(g.body.length);
    expect(zlib.gunzipSync(g.body).toString()).toBe('recorded gzip');
    expect([...(await viaProxy(proxy.port, `${up.httpUrl}/bin`)).body]).toEqual([0, 255, 1]);
    const w = await viaProxy(proxy.port, `${up.httpUrl}/wire`);
    expect(zlib.gunzipSync(w.body).toString()).toBe('already gzip');
    expect((await viaProxy(proxy.port, `${up.httpUrl}/head`, { method: 'HEAD' })).status).toBe(204);
    const ex = await settled(proxy);
    expect(ex[0].responseBody).toEqual({ text: 'recorded gzip', encoding: 'utf8' });
    expect(ex[2].responseBody).toEqual({ text: 'already gzip', encoding: 'utf8' });
  });

  it('setReplay validates options; invalid entries are skipped', () => {
    expect(() => proxy.setReplay([], { fallback: 'nope' as never })).toThrow(/fallback/);
    expect(proxy.setReplay([{ method: 'GET', url: 'not a url', status: 200, headers: {} }, { method: 'GET', url: 'https://a/', status: 99, headers: {} }], { fallback: 'passthrough' })).toBe(0);
  });
});

// ---------------------------------------------------------------- upstream proxy

describe('upstream proxy (§12.6)', () => {
  let tiny: TinyProxy;
  // Non-loopback names for the local upstream (only the tiny proxy resolves them): loopback targets bypass it.
  const name = (u: string) => u.replace('127.0.0.1', 'up.example.invalid');
  afterEach(async () => {
    await tiny?.close();
  });

  it('plain http goes absolute-form, https via CONNECT; switching at runtime; credentials in the URL', async () => {
    tiny = await startTinyProxy();
    proxy = await startProxy({ upstreamProxy: { url: tiny.url } });
    expect(proxy.upstreamProxy).toEqual({ url: tiny.url, ignoreCertErrors: false });
    expect(proxy.upstreamProxyDisplay).toBe(`127.0.0.1:${tiny.port}`);
    const a = await viaProxy(proxy.port, `${name(up.httpUrl)}/json`);
    const b = await viaProxy(proxy.port, `${name(up.httpsUrl)}/json`);
    expect([a.text, b.text]).toEqual(['{"hello":"world"}', '{"hello":"world"}']);
    expect(tiny.seen).toEqual([`GET ${name(up.httpUrl)}/json`, `CONNECT ${new URL(name(up.httpsUrl)).host}`]);
    expect((await settled(proxy)).map((e) => e.state)).toEqual(['completed', 'completed']);
    proxy.setUpstreamProxy(undefined);
    expect(proxy.upstreamProxyDisplay).toBeUndefined();
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    expect(tiny.seen).toHaveLength(2);
    expect(up.hits).toHaveLength(3);
    await tiny.close();
    const auth = `Basic ${Buffer.from('me:p@ss').toString('base64')}`;
    tiny = await startTinyProxy(auth);
    proxy.setUpstreamProxy({ url: `http://127.0.0.1:${tiny.port}` });
    expect((await viaProxy(proxy.port, `${name(up.httpUrl)}/json`)).status).toBe(407); // the upstream proxy's answer
    proxy.setUpstreamProxy({ url: `http://me:p%40ss@127.0.0.1:${tiny.port}` });
    expect(proxy.upstreamProxy?.url).toBe(`http://127.0.0.1:${tiny.port}`); // never credentials
    expect(proxy.upstreamProxyDisplay).toBe(`127.0.0.1:${tiny.port}`);
    expect((await viaProxy(proxy.port, `${name(up.httpUrl)}/echo`)).status).toBe(200);
    expect((await viaProxy(proxy.port, `${name(up.httpsUrl)}/json`)).status).toBe(200);
    const echo = JSON.parse((await viaProxy(proxy.port, `${name(up.httpUrl)}/echo`)).text);
    expect(echo.headers['proxy-authorization']).toBeUndefined();
    expect(echo.headers.host).toBe(new URL(name(up.httpUrl)).host);
  });

  it('upstream TLS stays strict through the tunnel; ignoreCertErrors only when set', async () => {
    tiny = await startTinyProxy();
    proxy = await startProxy({ ignoreUpstreamCertErrors: false, upstreamProxy: { url: tiny.url } });
    const strict = await viaProxy(proxy.port, `${name(up.httpsUrl)}/json`);
    expect(strict.status).toBe(502);
    expect(tiny.seen).toEqual([`CONNECT ${new URL(name(up.httpsUrl)).host}`]);
    proxy.setUpstreamProxy({ url: tiny.url, ignoreCertErrors: true });
    expect((await viaProxy(proxy.port, `${name(up.httpsUrl)}/json`)).status).toBe(200);
  });

  it('REVIEW-6 #10: loopback targets, the emulator alias and Map Remote to loopback bypass it (direct)', async () => {
    tiny = await startTinyProxy();
    proxy = await startProxy({ upstreamProxy: { url: tiny.url } });
    const port = new URL(up.httpUrl).port;
    const sport = new URL(up.httpsUrl).port;
    for (const url of [
      `http://127.0.0.1:${port}/json`,
      `http://localhost:${port}/json`,
      `http://10.0.2.2:${port}/json`,
      `https://127.0.0.1:${sport}/json`,
      `https://localhost:${sport}/json`,
      `https://10.0.3.2:${sport}/json`,
    ]) {
      const r = await viaProxy(proxy.port, url);
      expect([url, r.status, r.text]).toEqual([url, 200, '{"hello":"world"}']);
    }
    proxy.setRules([rule('m', 'http://api.example.com/*', { kind: 'mapRemote', to: `http://localhost:${port}` })]);
    expect((await viaProxy(proxy.port, 'http://api.example.com/json')).text).toBe('{"hello":"world"}');
    expect(tiny.seen).toEqual([]);
    expect(up.hits).toHaveLength(7);
    // a non-loopback name still goes through it
    await viaProxy(proxy.port, `${name(up.httpUrl)}/json`);
    expect(tiny.seen).toEqual([`GET ${name(up.httpUrl)}/json`]);
  });

  it('refuses itself (also localhost. and [::ffff:127.0.0.1]), other schemes and junk; an unreachable proxy gives 502', async () => {
    proxy = await startProxy();
    for (const host of ['127.0.0.1', 'localhost', 'localhost.', '[::ffff:127.0.0.1]', '[::1]', '127.1.2.3', '0.0.0.0']) {
      expect(() => proxy.setUpstreamProxy({ url: `http://${host}:${proxy.port}` }), host).toThrow(/loop/);
    }
    expect(() => proxy.setUpstreamProxy({ url: 'https://127.0.0.1:1' })).toThrow(/only http/);
    expect(() => proxy.setUpstreamProxy({ url: 'http://127.0.0.1:1/path' })).toThrow(/just http/);
    expect(() => proxy.setUpstreamProxy({ url: 'junk' })).toThrow(/not a URL/);
    const closed = net.createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const dead = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    proxy.setUpstreamProxy({ url: `http://127.0.0.1:${dead}` });
    expect((await viaProxy(proxy.port, `${name(up.httpUrl)}/json`)).status).toBe(502);
    const r = await viaProxy(proxy.port, `${name(up.httpsUrl)}/json`);
    expect(r.status).toBe(502);
    expect(r.text).toMatch(/upstream proxy .* is unreachable/);
    expect(up.hits).toEqual([]);
  });

  it('WebSocket upgrades and Map Remote go through it too', async () => {
    tiny = await startTinyProxy();
    const h = http.createServer();
    const wss = new WebSocketServer({ server: h });
    wss.on('connection', (ws) => ws.on('message', (d) => ws.send(`echo:${d}`)));
    h.listen(0, '127.0.0.1');
    await once(h, 'listening');
    const port = (h.address() as AddressInfo).port;
    try {
      proxy = await startProxy({ upstreamProxy: { url: tiny.url } });
      const ws = new WebSocket(`ws://ws.example.invalid:${port}/x`, { createConnection: () => net.connect(proxy.port, '127.0.0.1') } as WebSocket.ClientOptions);
      await once(ws, 'open');
      ws.send('hi');
      expect(String(((await once(ws, 'message')) as [Buffer])[0])).toBe('echo:hi');
      ws.close();
      expect(tiny.seen).toEqual([`CONNECT ws.example.invalid:${port}`]);
      proxy.setRules([rule('m', 'http://api.example.com/*', { kind: 'mapRemote', to: name(up.httpUrl) })]);
      expect((await viaProxy(proxy.port, 'http://api.example.com/json')).text).toBe('{"hello":"world"}');
      expect(tiny.seen.at(-1)).toBe(`GET ${name(up.httpUrl)}/json`);
    } finally {
      for (const c of wss.clients) c.terminate();
      h.closeAllConnections();
      await new Promise((r) => h.close(r));
    }
  });
});

describe('REVIEW-6 #3: body replacement is bounded', () => {
  it("the reviewer's 4.5 KB → 410 MB rewrite is refused: body unchanged, a note, RSS growth < 100 MB", async () => {
    const json = JSON.stringify(Array.from({ length: 1000 }, (_, i) => String(i % 10))); // 1000 strings = 2000 `"`
    expect(json.split('"').length - 1).toBe(2000);
    const h = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'application/json' }).end(json));
    h.listen(0, '127.0.0.1');
    await once(h, 'listening');
    const url = `http://127.0.0.1:${(h.address() as AddressInfo).port}/list`;
    try {
      proxy = await startProxy();
      proxy.setRules([rule('amp', '*', { kind: 'rewrite', response: { replaceBody: [{ find: '"', replace: 'z'.repeat(200 * 1024), all: true }] } })]);
      global.gc?.();
      const before = process.memoryUsage().rss;
      let peak = before;
      const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
      const rs = await Promise.all([0, 1, 2, 3].map(() => viaProxy(proxy.port, url)));
      clearInterval(timer);
      peak = Math.max(peak, process.memoryUsage().rss);
      for (const r of rs) expect(r.text).toBe(json);
      expect((peak - before) / 1024 / 1024).toBeLessThan(100);
      const ex = await settled(proxy);
      for (const e of ex) {
        expect(e.state).toBe('completed');
        expect(e.error).toMatch(/response body not changed: the replacements would make it larger than .*; it was forwarded unchanged/);
      }
      // Within the budget it still applies (2000 × +1 byte on 4.5 KB is under +1 MB).
      proxy.setRules([rule('ok', '*', { kind: 'rewrite', response: { replaceBody: [{ find: '"', replace: '""', all: true }] } })]);
      expect((await viaProxy(proxy.port, url)).text).toBe(json.split('"').join('""'));
    } finally {
      h.closeAllConnections();
      await new Promise((r) => h.close(r));
    }
  });

  it('rewriteOutputBudget: ≤ 64 MB, ≤ max(4 × input, input + 1 MB)', async () => {
    const { rewriteOutputBudget } = await import('../src/intercept-proxy');
    const MB = 1024 * 1024;
    expect(rewriteOutputBudget(1000)).toBe(1000 + MB);
    expect(rewriteOutputBudget(10 * MB)).toBe(40 * MB);
    expect(rewriteOutputBudget(32 * MB)).toBe(64 * MB);
  });
});

// Keep the Exchange type referenced for editors.
export type { Exchange };
