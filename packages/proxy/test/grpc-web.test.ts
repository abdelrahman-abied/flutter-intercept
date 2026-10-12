// v0.13.0 (CONTRACTS §19.1): gRPC-Web calls (Flutter Web through the browser) shown as gRPC on the HTTP flow.
import { once } from 'events';
import * as http from 'http';
import * as zlib from 'zlib';
import { performance } from 'perf_hooks';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy, Rule } from '../src';
import { Base64Stream, GrpcWebFrameParser, grpcWebVariant, parseGrpcWebTrailers } from '../src/grpc-web';
import { nextExchange, sleep, startProxy } from './helpers';

const rule = (id: string, url: string, action: Rule['action']): Rule => ({ id, enabled: true, match: { url }, action });
const text = (s: string | undefined) => Buffer.from(s ?? '', 'base64').toString();
const frame = (payload: Buffer | string, flags = 0) => {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const h = Buffer.alloc(5);
  h[0] = flags;
  h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
};
const trailerFrame = (lines: string) => frame(Buffer.from(lines), 0x80);
const done = (path: string) => (e: Exchange) => e.kind === 'grpc' && e.url.endsWith(path) && e.state !== 'pending';

function waitFor(proxy: InterceptProxy, pred: (e: Exchange) => boolean, timeoutMs = 10_000): Promise<Exchange> {
  const have = [...proxy.getExchanges()].reverse().find(pred);
  return have ? Promise.resolve(have) : nextExchange(proxy, pred, timeoutMs);
}

/** Read every frame of a binary gRPC-Web body. */
function readFrames(body: Buffer): { flags: number; payload: Buffer }[] {
  const out: { flags: number; payload: Buffer }[] = [];
  let off = 0;
  while (off + 5 <= body.length) {
    const len = body.readUInt32BE(off + 1);
    out.push({ flags: body[off], payload: body.subarray(off + 5, off + 5 + len) });
    off += 5 + len;
  }
  return out;
}

let server: http.Server;
let base: string;
// REVIEW-13 probes: ~100 B of br that decode to 64 MB of zeros (13.4 M empty frames), and repeated trailer frames.
let brBomb: Buffer;
let brTrailerBomb: Buffer;
let brProto: Buffer;
beforeAll(async () => {
  brBomb = zlib.brotliCompressSync(Buffer.alloc(64 * 1024 * 1024));
  const tf = trailerFrame('a:\n'.repeat(5461));
  brTrailerBomb = zlib.brotliCompressSync(Buffer.concat(Array.from({ length: 400 }, () => tf)));
  brProto = zlib.brotliCompressSync(Buffer.concat([frame('ok'), trailerFrame('grpc-status: 0\r\nconstructor: boom\r\nconstructor: again\r\n__proto__: x\r\nprototype: y\r\nx-v: a\rb\u0000c\u001bd\r\n')]));
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const isText = /grpc-web-text/.test(req.headers['content-type'] ?? '');
    const body = isText ? Buffer.from(raw.toString(), 'base64') : raw;
    const first = readFrames(body)[0]?.payload ?? Buffer.alloc(0);
    const ct = isText ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto';
    const name = (req.url ?? '').split('/').pop();
    const out = (b: Buffer) => (isText ? Buffer.from(b.toString('base64')) : b);
    // Writes `b` in small, odd-sized chunks (base64 groups and frame headers split across chunks).
    const dribble = async (b: Buffer, size = 7) => {
      for (let i = 0; i < b.length; i += size) {
        res.write(b.subarray(i, i + size));
        await sleep(1);
      }
    };
    if (name === 'Fail') {
      res.writeHead(200, { 'content-type': ct, 'grpc-status': '14', 'grpc-message': 'down%20for%20now', 'content-length': '0' }).end();
      return;
    }
    if (name === 'Bomb' || name === 'TrailerBomb' || name === 'Proto') {
      res.writeHead(200, { 'content-type': ct, 'content-encoding': 'br' }).end(name === 'Bomb' ? brBomb : name === 'TrailerBomb' ? brTrailerBomb : brProto);
      return;
    }
    if (name === 'Bad') {
      res.writeHead(200, { 'content-type': ct }).end(out(Buffer.from([0x42, 0, 0, 0, 1, 9])));
      return;
    }
    res.writeHead(200, { 'content-type': ct, ...(name === 'Gzip' ? { 'content-encoding': 'gzip' } : {}) });
    if (name === 'Unary') {
      // each part base64'd separately for -text (padded segments), like grpc-web servers stream them
      await dribble(out(frame(Buffer.concat([Buffer.from('echo:'), first]))));
      await dribble(out(trailerFrame('grpc-status: 0\r\nx-t: v\r\n')));
      res.end();
    } else if (name === 'Stream') {
      for (let i = 0; i < 3; i++) {
        await dribble(out(frame(`m${i}`)), 3);
        await sleep(60);
      }
      await sleep(400);
      res.end(out(trailerFrame('grpc-status: 5\r\ngrpc-message: not%20found\r\n')));
    } else if (name === 'Big') {
      res.end(out(Buffer.concat([frame(Buffer.alloc(3 * 1024 * 1024, 1)), trailerFrame('grpc-status: 0\r\n')])));
    } else if (name === 'Gzip') {
      res.end(zlib.gzipSync(out(Buffer.concat([frame('zipped'), trailerFrame('grpc-status: 0\r\n')]))));
    } else res.end(out(trailerFrame('grpc-status: 12\r\n')));
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
});
afterEach(async () => {
  await proxy.stop();
});

/** A gRPC-Web call through the proxy (absolute-form HTTP/1.1, like a browser with a proxy). */
function call(path: string, o: { variant?: 'binary' | 'text'; message?: string; origin?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; frames: { flags: number; payload: Buffer }[] }> {
  const variant = o.variant ?? 'binary';
  const req = frame(o.message ?? 'hi');
  const body = variant === 'text' ? Buffer.from(req.toString('base64')) : req;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        method: 'POST',
        path: `${base}${path}`,
        headers: {
          host: new URL(base).host,
          'content-type': variant === 'text' ? 'application/grpc-web-text' : 'application/grpc-web+proto',
          'x-grpc-web': '1',
          'content-length': body.length,
          ...(o.origin ? { origin: o.origin } : {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const isText = /grpc-web-text/.test(res.headers['content-type'] ?? '');
          const decoded = isText ? Buffer.from(raw.toString(), 'base64') : raw;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw, frames: readFrames(decoded) });
        });
      },
    );
    r.on('error', reject);
    r.end(body);
  });
}

describe('gRPC-Web helpers (unit)', () => {
  it('variants, base64 across chunk boundaries and padded segments, trailer lines, framing', () => {
    expect(grpcWebVariant('application/grpc-web')).toBe('binary');
    expect(grpcWebVariant('application/grpc-web+proto; charset=x')).toBe('binary');
    expect(grpcWebVariant('application/grpc-web-text')).toBe('text');
    expect(grpcWebVariant('application/grpc-web-text+proto')).toBe('text');
    expect(grpcWebVariant('application/grpc')).toBeUndefined();
    const out: Buffer[] = [];
    const bad: string[] = [];
    const s = new Base64Stream((b) => out.push(b), (w) => bad.push(w));
    const whole = Buffer.concat([Buffer.from('a'), Buffer.from('bc'), Buffer.from('defg')]);
    const parts = [Buffer.from('a').toString('base64'), Buffer.from('bc').toString('base64'), Buffer.from('defg').toString('base64')].join('\n'); // "YQ==\nYmM=\nZGVmZw=="
    for (let i = 0; i < parts.length; i += 3) s.push(Buffer.from(parts.slice(i, i + 3)));
    s.end();
    expect(Buffer.concat(out)).toEqual(whole);
    expect(bad).toEqual([]);
    new Base64Stream(() => undefined, (w) => bad.push(w)).push(Buffer.from('not*base64'));
    expect(bad).toEqual(['the -text body is not base64']);
    expect(parseGrpcWebTrailers(Buffer.from('Grpc-Status: 3\r\ngrpc-message: bad%20arg\r\nx-a: 1\r\nx-a: 2\r\nnot a line\r\n'))).toEqual({ 'grpc-status': '3', 'grpc-message': 'bad%20arg', 'x-a': ['1', '2'] });
    const got: string[] = [];
    const p = new GrpcWebFrameParser({ onMessage: (m) => got.push(`m:${m.kept}`), onTrailers: (t) => got.push(`t:${t}`), onBad: (w) => got.push(`bad:${w}`), compressedKeep: 1024 });
    const all = Buffer.concat([frame('x'), trailerFrame('grpc-status: 0\r\n'), frame('y', 0x42)]);
    for (const b of all) p.push(Buffer.from([b]));
    expect(got).toEqual(['m:x', 't:grpc-status: 0\r\n', 'bad:not gRPC-Web framing (flags 0x42)']);
  });
});

describe('gRPC-Web calls through the proxy', () => {
  for (const variant of ['binary', 'text'] as const) {
    it(`${variant}: unary over a chunked body → kind grpc, frames both ways, trailer frame → status and trailers`, async () => {
      const r = await call('/t.Web/Unary', { variant, message: 'hello' });
      expect(r.status).toBe(200);
      expect(r.frames.map((f) => [f.flags, f.payload.toString()])).toEqual([
        [0, 'echo:hello'],
        [0x80, 'grpc-status: 0\r\nx-t: v\r\n'],
      ]);
      const ex = await waitFor(proxy, (e) => done('/t.Web/Unary')(e) && (e.frames?.length ?? 0) === 2 && e.grpc?.statusCode !== undefined);
      expect(ex).toMatchObject({
        kind: 'grpc',
        method: 'POST',
        status: 200,
        state: 'completed',
        grpc: { service: 't.Web', method: 'Unary', web: variant, statusCode: 0, messagesSent: 1, messagesReceived: 1 },
        responseTrailers: { 'grpc-status': '0', 'x-t': 'v' },
      });
      expect(ex.requestBody).toBeUndefined();
      expect(ex.responseBody).toBeUndefined();
      expect(ex.frames?.map((f) => [f.dir, text(f.base64)])).toEqual([
        ['send', 'hello'],
        ['receive', 'echo:hello'],
      ]);
    });
  }

  it('server streaming is parsed as it arrives; trailers-only via headers; HTTP-gzip bodies', async () => {
    const pending = call('/t.Web/Stream', { variant: 'text' });
    const mid = await waitFor(proxy, (e) => e.kind === 'grpc' && e.url.endsWith('/t.Web/Stream') && e.state === 'pending' && (e.frames?.filter((f) => f.dir === 'receive').length ?? 0) === 3);
    expect(mid.grpc?.statusCode).toBeUndefined();
    await pending;
    const ex = await waitFor(proxy, (e) => done('/t.Web/Stream')(e) && e.grpc?.statusCode !== undefined);
    expect(ex.grpc).toMatchObject({ statusCode: 5, statusMessage: 'not found', messagesReceived: 3 });
    expect((await call('/t.Web/Fail')).headers['grpc-status']).toBe('14');
    const f = await waitFor(proxy, (e) => done('/t.Web/Fail')(e) && e.grpc?.statusCode !== undefined);
    expect(f.grpc).toMatchObject({ statusCode: 14, statusMessage: 'down for now', trailersOnly: true, messagesReceived: 0 });
    await call('/t.Web/Gzip');
    const z = await waitFor(proxy, (e) => done('/t.Web/Gzip')(e) && e.grpc?.statusCode !== undefined && (e.frames?.length ?? 0) === 2);
    expect(text(z.frames?.find((x) => x.dir === 'receive')?.base64)).toBe('zipped');
  });

  it('caps: a 3 MB message keeps 64 KB, size is the full size; a malformed body gets a note, nothing breaks', async () => {
    const r = await call('/t.Web/Big');
    expect(r.frames[0].payload.length).toBe(3 * 1024 * 1024);
    const ex = await waitFor(proxy, (e) => done('/t.Web/Big')(e) && e.grpc?.statusCode !== undefined);
    const m = ex.frames!.find((f) => f.dir === 'receive')!;
    expect(m).toMatchObject({ size: 3 * 1024 * 1024, truncated: true });
    expect(Buffer.from(m.base64!, 'base64').length).toBe(64 * 1024);
    await call('/t.Web/Bad');
    const bad = await waitFor(proxy, (e) => done('/t.Web/Bad')(e) && !!e.error);
    expect(bad.state).toBe('completed');
    expect(bad.error).toMatch(/gRPC-Web response: not gRPC-Web framing \(flags 0x42\)/);
  });

  it('HTTP traffic is unchanged (not shown as gRPC)', async () => {
    const r = await new Promise<number>((resolve) => {
      const q = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: `${base}/plain`, headers: { host: new URL(base).host, 'content-type': 'application/json' }, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      q.end('{}');
    });
    expect(r).toBe(200);
    const ex = await waitFor(proxy, (e) => e.url.endsWith('/plain') && e.state !== 'pending');
    expect(ex.kind).toBeUndefined();
  });
});

describe('rules on gRPC-Web calls', () => {
  for (const variant of ['binary', 'text'] as const) {
    it(`grpcMock (${variant}): frames + trailer frame in the request's variant, CORS for a page origin`, async () => {
      proxy.setRules([
        rule('m', '*/t.Web/Unary', { kind: 'grpcMock', code: 3, message: 'bad ✗', messages: [Buffer.from('mocked').toString('base64')], trailers: { 'x-m': '1' } }),
      ]);
      const r = await call('/t.Web/Unary', { variant, origin: 'http://localhost:5000' });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe(variant === 'text' ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto');
      expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5000');
      expect(r.headers['access-control-expose-headers']).toMatch(/grpc-status/);
      expect(r.frames.map((f) => [f.flags, f.payload.toString()])).toEqual([
        [0, 'mocked'],
        [0x80, 'grpc-status: 3\r\ngrpc-message: bad %E2%9C%97\r\nx-m: 1\r\n'],
      ]);
      const ex = await waitFor(proxy, (e) => done('/t.Web/Unary')(e) && (e.frames?.length ?? 0) === 2);
      expect(ex).toMatchObject({ state: 'mocked', matchedRuleId: 'm', grpc: { web: variant, statusCode: 3, statusMessage: 'bad ✗' } });
    });
  }

  it('grpcMock without messages and a non-zero code is trailers-only; block → trailers-only 14; mutate has no effect (note)', async () => {
    proxy.setRules([rule('m', '*/t.Web/Unary', { kind: 'grpcMock', code: 7 })]);
    let r = await call('/t.Web/Unary');
    expect(r.headers['grpc-status']).toBe('7');
    expect(r.body.length).toBe(0);
    proxy.setRules([rule('b', '*/t.Web/Unary', { kind: 'block', mode: 'status', status: 403 })]);
    r = await call('/t.Web/Unary', { variant: 'text', origin: 'http://localhost:5000' });
    expect(r).toMatchObject({ status: 200, headers: { 'grpc-status': '14', 'grpc-message': 'Blocked by Flutter Intercept' } });
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5000');
    const b = await waitFor(proxy, (e) => done('/t.Web/Unary')(e) && e.state === 'blocked');
    expect(b.grpc).toMatchObject({ statusCode: 14, trailersOnly: true, web: 'text' });
    proxy.setRules([rule('mu', '*/t.Web/Unary', { kind: 'mutate', ops: [{ path: '$.a', op: 'null' }] })]);
    r = await call('/t.Web/Unary', { message: 'm' });
    expect(r.frames[0].payload.toString()).toBe('echo:m');
    const mu = await waitFor(proxy, (e) => done('/t.Web/Unary')(e) && !!e.error?.includes('Mutate'));
    expect(mu.error).toMatch(/Mutate rules edit JSON bodies/);
  });

  it('a preflight for a gRPC-Web call that a grpcMock answers is answered locally', async () => {
    proxy.setRules([rule('m', '*/t.Web/Unary', { kind: 'grpcMock', messages: [] })]);
    const status = await new Promise<{ s: number; h: http.IncomingHttpHeaders }>((resolve) => {
      const q = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'OPTIONS',
          path: `${base}/t.Web/Unary`,
          headers: { host: new URL(base).host, origin: 'http://localhost:5000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-grpc-web' },
          agent: false,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ s: res.statusCode ?? 0, h: res.headers }));
        },
      );
      q.end();
    });
    expect(status.s).toBe(204);
    expect(status.h['access-control-allow-origin']).toBe('http://localhost:5000');
    expect(status.h['access-control-max-age']).toBe('0'); // never cached (REVIEW-13)
  });
});

describe('REVIEW-13: the passive reader is bounded by work', () => {
  /** Event-loop busy time and peak heap growth while `fn` runs and the reader finishes (forgotten). */
  async function measure(fn: () => Promise<unknown>): Promise<{ activeMs: number; heapMb: number }> {
    const heap0 = process.memoryUsage().heapUsed;
    let peak = heap0;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 5);
    const elu0 = performance.eventLoopUtilization();
    await fn();
    const calls = (proxy as unknown as { grpcWebCalls: Map<string, unknown> }).grpcWebCalls;
    for (let i = 0; i < 300 && calls.size; i++) await sleep(10);
    const used = performance.eventLoopUtilization(elu0);
    clearInterval(sampler);
    expect(calls.size).toBe(0);
    return { activeMs: used.active, heapMb: (peak - heap0) / 1024 / 1024 };
  }

  it(`the ${'106'}-byte br bomb (64 MB of zeros) and the repeated-trailer probe: < 100 ms of event loop, < 64 MB heap`, async () => {
    expect(brBomb.length).toBeLessThan(200);
    const a = await measure(() => call('/t.Web/Bomb'));
    expect(a.activeMs).toBeLessThan(100);
    expect(a.heapMb).toBeLessThan(64);
    const ex = await waitFor(proxy, (e) => done('/t.Web/Bomb')(e) && !!e.error);
    expect(ex.error).toMatch(/more than 10000 frames/);
    expect(ex.grpc?.messagesReceived).toBe(10_000);
    expect(ex.frames!.length).toBeLessThanOrEqual(500);
    const b = await measure(() => call('/t.Web/TrailerBomb'));
    expect(b.activeMs).toBeLessThan(100);
    expect(b.heapMb).toBeLessThan(64);
    const t = await waitFor(proxy, (e) => done('/t.Web/TrailerBomb')(e) && !!e.error);
    expect(t.error).toMatch(/frames after the trailer frame/);
    expect((t.responseTrailers?.a as string[]).length).toBe(100);
  });

  it('four bombs in parallel finish without trouble', async () => {
    const r = await measure(() => Promise.all([1, 2, 3, 4].map(() => call('/t.Web/Bomb'))));
    expect(r.heapMb).toBeLessThan(128);
    expect(proxy.getExchanges().filter(done('/t.Web/Bomb')).length).toBe(4);
  });

  it('trailers are prototype-safe and control characters are stripped', async () => {
    await call('/t.Web/Proto');
    const ex = await waitFor(proxy, (e) => done('/t.Web/Proto')(e) && e.grpc?.statusCode !== undefined);
    const t = ex.responseTrailers!;
    expect(Object.keys(t).sort()).toEqual(['grpc-status', 'x-v']);
    expect(Object.prototype.hasOwnProperty.call(t, 'constructor')).toBe(false);
    expect(Object.getPrototypeOf(t)).toBe(Object.prototype);
    expect(t['x-v']).toBe('abcd');
    expect(() => JSON.stringify(ex)).not.toThrow();
  });
});
