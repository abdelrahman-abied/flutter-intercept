// v0.16.0 (CONTRACTS §22.1): the `handler` action — a stateful mock answered by a host function.
import * as http from 'http';
import * as zlib from 'zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, HandlerRequest, InterceptProxy, RequestHandler, Rule } from '../src';
import { GRPC_ACTIONS, grpcApplicable, handlerProblem, pickSequenceStep, ruleProblem, WEBSOCKET_ACTIONS } from '../src/rules';
import { handlerTesting, readHandlerResult } from '../src/handler-flow';
import { notesOf, settled, sleep, startProxy, startUpstream, viaProxy, type Upstream } from './helpers';

type HandlerRule = Extract<Rule['action'], { kind: 'handler' }>;
const FALLBACK: NonNullable<HandlerRule['fallback']> = { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{"example":true}' };
const handlerRule = (extra: Partial<HandlerRule> = {}, url = '*/items*', id = 'h1'): Rule => ({
  id,
  enabled: true,
  match: { url },
  action: { kind: 'handler', handlerId: 'collection:c1', ...extra },
});

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
  delete handlerTesting.maxInFlight;
  await proxy?.stop();
});

/** The finished exchange for a URL part. */
async function done(urlPart: string): Promise<Exchange> {
  const all = await settled(proxy);
  const ex = [...all].reverse().find((e) => e.url.includes(urlPart));
  if (!ex) throw new Error(`no exchange for ${urlPart}`);
  return ex;
}

/** A request whose body is sent chunked (no content-length), in 64 KB pieces. */
function chunkedPost(port: number, url: string, size: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: url, headers: { host: u.host, 'content-type': 'text/plain' }, agent: false });
    let answered = false;
    // The proxy may answer (and close) before a body over 5 MB is fully sent: EPIPE after the answer is expected.
    req.on('error', (e) => (answered ? undefined : reject(new Error(`${size} bytes: ${e.message}`))));
    req.on('response', (res) => {
      answered = true;
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    const piece = Buffer.alloc(64 * 1024, 'a');
    let left = size;
    const write = () => {
      while (left > 0) {
        const n = Math.min(left, piece.length);
        left -= n;
        if (!req.write(piece.subarray(0, n))) return void req.once('drain', write);
      }
      req.end();
    };
    write();
  });
}

describe('handler rules (CONTRACTS §22.1)', () => {
  it('the handler sees method, absolute URL, headers and the decoded body; its answer reaches the app', async () => {
    const seen: HandlerRequest[] = [];
    proxy.setHandler('collection:c1', (req) => {
      seen.push(req);
      const item = JSON.parse(req.body!.text);
      return {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-store': ['a', 'b'] },
        body: JSON.stringify({ id: 7, ...item }),
        note: 'Created item 7 in\n/items',
      };
    });
    proxy.setRules([handlerRule()]);
    const body = zlib.gzipSync(Buffer.from('{"name":"milk"}'));
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items?list=1`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-test': 'yes' },
    });
    expect(r.status).toBe(201);
    expect(JSON.parse(r.text)).toEqual({ id: 7, name: 'milk' });
    expect(r.headers['x-store']).toBe('a, b');
    expect(up.hits).toEqual([]);

    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req).toMatchObject({ ruleId: 'h1', method: 'POST', url: `${up.httpUrl}/items?list=1` });
    expect(req.headers['x-test']).toBe('yes');
    expect(req.body).toMatchObject({ text: '{"name":"milk"}', encoding: 'utf8' });
    expect(req.body?.truncated).toBeUndefined();

    const fin = await done('/items');
    expect(req.exchangeId).toBe(fin.id);
    expect(fin).toMatchObject({ state: 'mocked', status: 201, simulated: 'Stateful mock', matchedRuleId: 'h1' });
    expect(fin.responseBody?.text).toBe('{"id":7,"name":"milk"}');
    expect(fin.notes).toContain('Created item 7 in /items');
    expect(fin.error).toBeUndefined();
  });

  it('works over HTTPS, with an async handler and a delay', async () => {
    let url = '';
    proxy.setHandler('collection:c1', async (req) => {
      url = req.url;
      await sleep(20);
      return { status: 200, body: 'ok', delayMs: 60 };
    });
    proxy.setRules([handlerRule()]);
    const r = await viaProxy(proxy.port, `${up.httpsUrl}/items/3`);
    expect(r.status).toBe(200);
    expect(r.text).toBe('ok');
    expect(url).toBe(`${up.httpsUrl}/items/3`);
    const fin = await done('/items/3');
    expect(fin).toMatchObject({ state: 'mocked', simulated: 'Stateful mock' });
    expect(fin.timings?.delayMs).toBeGreaterThanOrEqual(50);
    expect(up.hits).toEqual([]);
  });

  it('no handler registered → the fallback example, with a note', async () => {
    proxy.setRules([handlerRule({ fallback: FALLBACK })]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`);
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"example":true}');
    const fin = await done('/items');
    expect(fin).toMatchObject({ state: 'mocked', matchedRuleId: 'h1' });
    expect(fin.simulated).toBeUndefined();
    expect(notesOf(fin)).toMatch(/answered from the example/);
    expect(up.hits).toEqual([]);
  });

  it('the handler returns undefined → the fallback example, with a note', async () => {
    let calls = 0;
    proxy.setHandler('collection:c1', () => {
      calls++;
      return undefined;
    });
    proxy.setRules([handlerRule({ fallback: FALLBACK })]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`);
    expect(calls).toBe(1);
    expect(r.text).toBe('{"example":true}');
    const fin = await done('/items');
    expect(fin.state).toBe('mocked');
    expect(notesOf(fin)).toMatch(/had no answer; answered from the example/);
  });

  it('{ fallback: true } → the fallback example quietly; its note when given (CONTRACTS §24)', async () => {
    let note: unknown;
    proxy.setHandler('collection:c1', () => ({ fallback: true, ...(note !== undefined ? { note } : {}) }) as never);
    proxy.setRules([handlerRule({ fallback: FALLBACK })]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`);
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"example":true}');
    const fin = await done('/items');
    expect(fin).toMatchObject({ state: 'mocked', matchedRuleId: 'h1' });
    expect(fin.simulated).toBeUndefined();
    expect(notesOf(fin)).not.toMatch(/answered from the example/);

    note = `auth: signed in\n${'x'.repeat(400)}`;
    expect((await viaProxy(proxy.port, `${up.httpUrl}/items/2`)).text).toBe('{"example":true}');
    const withNote = await done('/items/2');
    const n = (withNote.notes ?? []).find((x) => x.startsWith('auth: signed in'));
    expect(n).toBeDefined();
    expect(n!.length).toBeLessThanOrEqual(300);
    expect(n).not.toMatch(/\n/);
    expect(notesOf(withNote)).not.toMatch(/answered from the example/);

    note = 5;
    expect((await viaProxy(proxy.port, `${up.httpUrl}/items/3`)).status).toBe(502);
    expect((await done('/items/3')).error).toMatch(/^Handler h1: answer\.note must be text/);
    expect(up.hits).toEqual([]);
  });

  it('{ fallback: true } without a fallback on the rule → 502; fallback other than true reads as an answer', async () => {
    proxy.setRules([handlerRule()]);
    proxy.setHandler('collection:c1', () => ({ fallback: true, note: 'x' }) as never);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/items`)).status).toBe(502);
    expect(await done('/items')).toMatchObject({ state: 'error', status: 502, error: 'Handler h1: asked for the example, and the rule has no example to fall back to' });

    proxy.setRules([handlerRule({ fallback: FALLBACK })]);
    proxy.setHandler('collection:c1', () => ({ fallback: 'yes', status: 202, body: 'mine' }) as never);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items/2`);
    expect(r).toMatchObject({ status: 202, text: 'mine' });
    expect(up.hits).toEqual([]);
  });

  it('no handler and no fallback → 502; undefined without fallback → 502', async () => {
    proxy.setRules([handlerRule()]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`);
    expect(r.status).toBe(502);
    expect(await done('/items')).toMatchObject({ state: 'error', status: 502, error: 'Handler h1: no stateful mock is registered' });

    proxy.setHandler('collection:c1', async () => undefined);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/items/2`)).status).toBe(502);
    expect((await done('/items/2')).error).toMatch(/^Handler h1: no answer/);
    expect(up.hits).toEqual([]);
  });

  it('a throw or a rejection → 502, state error, one-line message', async () => {
    proxy.setRules([handlerRule()]);
    proxy.setHandler('collection:c1', () => {
      throw new TypeError('boom\nsecond line');
    });
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`);
    expect(r.status).toBe(502);
    expect(r.text).toBe('Flutter Intercept: Handler h1: boom second line');
    expect(await done('/items')).toMatchObject({ state: 'error', status: 502, error: 'Handler h1: boom second line', simulated: 'Stateful mock' });

    proxy.setHandler('collection:c1', async () => {
      throw new Error('x'.repeat(1000));
    });
    expect((await viaProxy(proxy.port, `${up.httpUrl}/items/2`)).status).toBe(502);
    const fin = await done('/items/2');
    expect(fin.error!.length).toBeLessThanOrEqual(300);
    expect(fin.error).toMatch(/^Handler h1: xxx/);
    expect(up.hits).toEqual([]);
  });

  it('an invalid answer → 502 with what is wrong', async () => {
    proxy.setRules([handlerRule()]);
    const cases: [unknown, RegExp][] = [
      [{ status: 42 }, /answer\.status must be an integer 100–599/],
      [{ status: 200, body: { a: 1 } }, /answer\.body must be a string/],
      [{ status: 200, delayMs: 60_001 }, /answer\.delayMs must be a number 0–60000/],
      [{ status: 200, headers: { 'bad name': 'x' } }, /invalid header name/],
      [{ status: 200, headers: { a: 'x\r\ny' } }, /invalid value/],
      [{ status: 200, body: 'x'.repeat(5 * 1024 * 1024 + 1) }, /larger than 5 MB/],
      ['text', /must be an object or undefined/],
      [null, /got null/],
    ];
    let i = 0;
    for (const [value, why] of cases) {
      proxy.setHandler('collection:c1', () => value as never);
      const path = `/items/${++i}`;
      const r = await viaProxy(proxy.port, `${up.httpUrl}${path}`);
      expect(r.status, String(why)).toBe(502);
      const fin = await done(path);
      expect(fin.state).toBe('error');
      expect(fin.error).toMatch(why);
    }
  });

  it('readHandlerResult: defaults and the note made one line ≤ 300', () => {
    expect(readHandlerResult({ status: 204 })).toEqual({ status: 204, headers: {}, body: '', delayMs: 0 });
    const r = readHandlerResult({ status: 200, note: `a\nb ${'n'.repeat(400)}`, delayMs: 10.4 });
    expect(r.note!.length).toBeLessThanOrEqual(300);
    expect(r.note).toMatch(/^a b n+…$/);
    expect(r.delayMs).toBe(10);
    expect(() => readHandlerResult({ status: 200, note: 5 })).toThrow(/note must be text/);
  });

  it('times out: the signal aborts and the app gets 502 "timed out after N ms"', async () => {
    let aborted: unknown;
    proxy.setHandler('collection:c1', (_req, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = signal.reason;
        setTimeout(() => resolve({ status: 200, body: 'too late' }), 10);
      });
    }));
    proxy.setRules([handlerRule({ timeoutMs: 100 })]);
    const t0 = Date.now();
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(r.status).toBe(502);
    expect(r.text).toBe('Flutter Intercept: Handler h1: timed out after 100 ms');
    expect(aborted).toBeInstanceOf(Error);
    const fin = await done('/items');
    expect(fin).toMatchObject({ state: 'error', error: 'Handler h1: timed out after 100 ms' });
  });

  it('the app gives up: the signal aborts and the result is dropped', async () => {
    let signalled!: () => void;
    const wasAborted = new Promise<void>((r) => (signalled = r));
    let finish!: () => void;
    proxy.setHandler('collection:c1', (_req, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => signalled());
      finish = () => resolve({ status: 200, body: 'late' });
    }));
    proxy.setRules([handlerRule({ timeoutMs: 30_000 })]);
    await expect(viaProxy(proxy.port, `${up.httpUrl}/items`, { timeoutMs: 150 })).rejects.toThrow();
    await wasAborted;
    finish();
    await sleep(30);
    const fin = await done('/items');
    expect(fin.state).toBe('error');
    expect(fin.status).toBeUndefined();
    expect(fin.responseBody).toBeUndefined();
  });

  it('more than the in-flight cap → 503 with a note; the others still answer', async () => {
    handlerTesting.maxInFlight = 2;
    const release: (() => void)[] = [];
    proxy.setHandler('collection:c1', () => new Promise((resolve) => release.push(() => resolve({ status: 200, body: 'ok' }))));
    proxy.setRules([handlerRule()]);
    const a = viaProxy(proxy.port, `${up.httpUrl}/items/a`);
    const b = viaProxy(proxy.port, `${up.httpUrl}/items/b`);
    for (let i = 0; i < 200 && release.length < 2; i++) await sleep(5);
    expect(release).toHaveLength(2);
    const c = await viaProxy(proxy.port, `${up.httpUrl}/items/c`);
    expect(c.status).toBe(503);
    expect(c.headers['retry-after']).toBe('1');
    for (const r of release) r();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    const fc = await done('/items/c');
    expect(fc.state).toBe('error');
    expect(fc.error).toMatch(/^Handler h1: busy/);
    expect(notesOf(fc)).toMatch(/More than 2 stateful mock answers were in flight; answered 503/);
    // the slots are free again
    proxy.setHandler('collection:c1', () => ({ status: 200, body: 'again' }));
    expect((await viaProxy(proxy.port, `${up.httpUrl}/items/d`)).text).toBe('again');
  });

  it('answers the CORS preflight like a mock (the handler is not called)', async () => {
    let calls = 0;
    proxy.setHandler('collection:c1', () => {
      calls++;
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '[]' };
    });
    proxy.setRules([handlerRule()]);
    const origin = 'http://localhost:5000';
    const pre = await viaProxy(proxy.port, `${up.httpUrl}/items`, {
      method: 'OPTIONS',
      headers: { origin, 'sec-fetch-mode': 'cors', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(origin);
    expect(calls).toBe(0);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`, { method: 'PUT', body: '{}', headers: { origin, 'sec-fetch-mode': 'cors', 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(origin);
    expect(calls).toBe(1);
    expect(up.hits).toEqual([]);
  });

  it('answers while the network profile is offline (never reaches the network)', async () => {
    proxy.setHandler('collection:c1', () => ({ status: 200, body: 'local' }));
    proxy.setRules([handlerRule()]);
    proxy.setNetworkProfile({ kind: 'offline' });
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`);
    expect(r.text).toBe('local');
    expect((await done('/items')).state).toBe('mocked');
  });

  it('a chunked body under 5 MB reaches the handler whole; over 5 MB it arrives truncated', async () => {
    const got: HandlerRequest[] = [];
    proxy.setHandler('collection:c1', (req) => {
      got.push(req);
      return { status: 200, body: String(req.body?.text.length ?? 0) };
    });
    proxy.setRules([handlerRule()]);
    const small = await chunkedPost(proxy.port, `${up.httpUrl}/items/small`, 1024 * 1024);
    expect(small).toEqual({ status: 200, text: String(1024 * 1024) });
    expect(got[0].body?.truncated).toBeUndefined();

    // Like a mock, the answer may come before the upload finishes (the client may then see EPIPE): either is fine.
    const big = await chunkedPost(proxy.port, `${up.httpUrl}/items/big`, 6 * 1024 * 1024).catch((e: Error) => e);
    if (!(big instanceof Error)) expect(big.status).toBe(200);
    for (let i = 0; i < 200 && got.length < 2; i++) await sleep(5);
    expect(got[1].body?.truncated).toBe(true);
    expect(got[1].body!.text.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(up.hits).toEqual([]);
  });

  it('handlers survive setRules; stop() clears them and aborts waiting calls', async () => {
    const h: RequestHandler = () => ({ status: 200, body: 'kept' });
    proxy.setHandler('collection:c1', h);
    proxy.setRules([handlerRule({ fallback: FALLBACK })]);
    proxy.setRules([handlerRule({ fallback: FALLBACK }), { id: 'other', enabled: true, match: { url: '*/json' }, action: { kind: 'block', mode: 'status' } }]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/items`)).text).toBe('kept');

    // removing it answers the example
    proxy.setHandler('collection:c1', undefined);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/items/2`)).text).toBe('{"example":true}');

    let aborted = false;
    proxy.setHandler('collection:c1', (_r, signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = true))));
    const pending = viaProxy(proxy.port, `${up.httpUrl}/items/3`).catch(() => undefined);
    for (let i = 0; i < 100 && !(proxy as unknown as { handlerFlow: { inFlight: Map<string, unknown> } }).handlerFlow.inFlight.size; i++) await sleep(5);
    await proxy.stop();
    await pending;
    expect(aborted).toBe(true);
    expect((proxy as unknown as { handlerFlow: { size: number } }).handlerFlow.size).toBe(0);
  });

  it('setRules refuses an invalid handler rule (kept, never matched)', async () => {
    proxy.setHandler('collection:c1', () => ({ status: 200, body: 'handled' }));
    proxy.setRules([handlerRule({ timeoutMs: 0 })]);
    expect(proxy.refusedRules).toEqual([{ id: 'h1', problem: expect.stringMatching(/timeoutMs must be an integer 1–60000/) }]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/items`);
    expect(r.status).toBe(404); // passed through to the upstream
    expect(up.hits).toEqual(['GET /items']);
  });
});

describe('handler rule validation (CONTRACTS §22.1)', () => {
  const action = (extra: Partial<HandlerRule> = {}) => ({ kind: 'handler' as const, handlerId: 'collection:c1', ...extra });

  it('handlerId, timeoutMs and fallback', () => {
    expect(handlerProblem(action())).toBeUndefined();
    expect(handlerProblem(action({ timeoutMs: 1, fallback: FALLBACK }))).toBeUndefined();
    expect(handlerProblem(action({ timeoutMs: 60_000 }))).toBeUndefined();
    expect(handlerProblem(action({ handlerId: '' }))).toMatch(/needs a handlerId/);
    expect(handlerProblem(action({ handlerId: 5 as never }))).toMatch(/needs a handlerId/);
    expect(handlerProblem(action({ handlerId: 'x'.repeat(201) }))).toMatch(/at most 200/);
    expect(handlerProblem(action({ handlerId: 'x'.repeat(200) }))).toBeUndefined();
    for (const t of [0, -1, 60_001, 1.5, '10' as never]) expect(handlerProblem(action({ timeoutMs: t })), String(t)).toMatch(/timeoutMs must be an integer 1–60000/);
    expect(handlerProblem(action({ fallback: { ...FALLBACK, status: 42 } }))).toMatch(/^fallback status must be an integer 100–599/);
    expect(handlerProblem(action({ fallback: { ...FALLBACK, kind: 'block' } as never }))).toMatch(/^fallback must be a mock action/);
    expect(handlerProblem(action({ fallback: { ...FALLBACK, body: 5 as never } }))).toMatch(/^fallback body must be text/);
    expect(handlerProblem(action({ fallback: { ...FALLBACK, headers: { a: 'x\ny' } } }))).toMatch(/^fallback header "a" has an invalid value/);
    expect(handlerProblem(action({ fallback: { ...FALLBACK, delayMs: -1 } }))).toMatch(/^fallback delayMs must be an integer/);
    expect(ruleProblem({ match: { url: '*' }, action: action({ handlerId: '' }) })).toMatch(/needs a handlerId/);
  });

  it('never a sequence step; never for WebSockets or gRPC', () => {
    const seq = { kind: 'sequence' as const, steps: [{ action: action() as never }] };
    expect(ruleProblem({ match: { url: '*' }, action: seq })).toBe("Sequence step 1: handler can't be a step.");
    expect(pickSequenceStep(seq, 0)).toMatchObject({ action: undefined, invalid: expect.stringMatching(/Sequence step 1 \(handler\) is not allowed/) });
    expect(ruleProblem({ match: { url: 'wss://x.test/socket' }, action: action() })).toMatch(/Handler rules do not apply to WebSocket/);
    expect(WEBSOCKET_ACTIONS.has('handler')).toBe(false);
    expect(GRPC_ACTIONS.has('handler')).toBe(false);
    expect(grpcApplicable(action())).toBe(false);
  });
});
