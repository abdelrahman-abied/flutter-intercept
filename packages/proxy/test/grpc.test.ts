// v0.10.0 (CONTRACTS §16.2): gRPC — silent tunnels, the HTTP/2 relay, recording, rules, LAN guard, self-check.
import { once } from 'events';
import { Duplex } from 'stream';
import * as http from 'http';
import * as http2 from 'http2';
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { randomBytes, X509Certificate } from 'crypto';
import { performance } from 'perf_hooks';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, Frame, InterceptProxy, Rule } from '../src';
import { ruleFromExchange, ruleProblem } from '../src/rules';
import {
  classifyFirstBytes,
  decodeGrpcMessage,
  encodeGrpcMessage,
  decompressPrefix,
  FirstMessageCut,
  GRPC_BREAKER_EVENT,
  GrpcFrameRecorder,
  GrpcMessageParser,
  type GrpcBreakerEvent,
  isGrpcContentType,
  messageFrame,
  parseConnectTimeout,
  parseGrpcPath,
  parseGrpcTimeout,
} from '../src/grpc';
import { grpcPoolTesting } from '../src/grpc-upstream';
import { grpcTesting } from '../src/silent';
import { findOnSocketChain, lanIPv4Addresses, lanTesting, SOCKET_SELF } from '../src/lan';
import { nextExchange, selfSignedCert, sleep, startProxy, startTinyProxy, startUpstream, viaProxy } from './helpers';
import { frame, grpcCall, h2cSession, silentSocket, startGrpcServer, tlsSession, type GrpcServer } from './grpc-helpers';

const C = http2.constants;
const rule = (id: string, url: string, action: Rule['action'], extra: Partial<Rule> = {}): Rule => ({ id, enabled: true, match: { url }, action, ...extra });
const isGrpc = (path: string) => (e: Exchange) => e.kind === 'grpc' && e.url.endsWith(path);
const doneGrpc = (path: string) => (e: Exchange) => isGrpc(path)(e) && e.state !== 'pending';

/** The newest exchange matching `pred`, already there or the next one to arrive. */
function waitFor(proxy: InterceptProxy, pred: (e: Exchange) => boolean, timeoutMs = 10_000): Promise<Exchange> {
  const have = [...proxy.getExchanges()].reverse().find(pred);
  return have ? Promise.resolve(have) : nextExchange(proxy, pred, timeoutMs);
}

// ---------------------------------------------------------------- unit

describe('gRPC wire helpers (unit)', () => {
  it('content types: grpc, grpc+proto, parameters; not grpc-web', () => {
    for (const ct of ['application/grpc', 'application/grpc+proto', 'application/grpc; charset=utf-8', 'APPLICATION/GRPC+json']) expect(isGrpcContentType(ct)).toBe(true);
    for (const ct of ['application/grpc-web', 'application/grpc-web+proto', 'application/json', '', undefined]) expect(isGrpcContentType(ct)).toBe(false);
  });

  it('paths, grpc-timeout, connect timeout, grpc-message percent-encoding', () => {
    expect(parseGrpcPath('/pkg.v1.Service/Method')).toEqual({ service: 'pkg.v1.Service', method: 'Method' });
    expect(parseGrpcPath('/odd')).toEqual({ service: 'odd', method: '' });
    expect(parseGrpcTimeout('100m')).toBe(100);
    expect(parseGrpcTimeout('5S')).toBe(5000);
    expect(parseGrpcTimeout('2M')).toBe(120000);
    expect(parseGrpcTimeout('1H')).toBe(3600000);
    expect(parseGrpcTimeout('1500u')).toBe(2);
    expect(parseGrpcTimeout('123456789m')).toBeUndefined();
    expect(parseGrpcTimeout('x')).toBeUndefined();
    expect(parseConnectTimeout(undefined)).toBe(30000);
    expect(parseConnectTimeout('250')).toBe(250);
    expect(parseConnectTimeout('999999')).toBe(60000);
    expect(parseConnectTimeout('0')).toBe(30000);
    expect(parseConnectTimeout('-5')).toBe(30000);
    expect(encodeGrpcMessage('no way: 100% ✓')).toBe('no way: 100%25 %E2%9C%93');
    expect(decodeGrpcMessage('no way: 100%25 %E2%9C%93')).toBe('no way: 100% ✓');
    expect(decodeGrpcMessage('bad %zz escape %4')).toBe('bad %zz escape %4');
  });

  it('message parser: split headers, many per chunk, big messages counted not kept, bad flag stops', () => {
    const got: { size: number; kept: number; complete: boolean; compressed: boolean }[] = [];
    const p = new GrpcMessageParser((m) => got.push({ size: m.size, kept: m.kept.length, complete: m.complete, compressed: m.compressed }));
    const big = frame(Buffer.alloc(200_000, 7));
    const all = Buffer.concat([frame('a'), frame(''), big, frame(Buffer.from([1, 2]), true)]);
    for (let i = 0; i < all.length; i += 3) p.push(all.subarray(i, i + 3));
    expect(got).toEqual([
      { size: 1, kept: 1, complete: true, compressed: false },
      { size: 0, kept: 0, complete: true, compressed: false },
      { size: 200_000, kept: 64 * 1024, complete: false, compressed: false },
      { size: 2, kept: 2, complete: true, compressed: true },
    ]);
    const q = new GrpcMessageParser((m) => got.push({ size: m.size, kept: 0, complete: true, compressed: false }));
    const before = got.length;
    q.push(Buffer.from([7, 0, 0, 0, 1, 1]));
    q.push(frame('x'));
    expect(got.length).toBe(before);
  });

  it('message frames: only the kept prefix is decompressed, streaming, stopping after 64 KB + 1 (REVIEW-10 #3)', async () => {
    const frames: Frame[] = [];
    const rec = new GrpcFrameRecorder('receive', () => 'gzip', (f) => frames.push(f));
    const push = (payload: Buffer, compressed = true) => {
      const p = new GrpcMessageParser((m) => rec.push(m));
      p.push(frame(compressed ? zlib.gzipSync(payload) : payload, compressed));
    };
    push(Buffer.from('small'));
    push(Buffer.alloc(100_000, 'z')); // decompresses past the cap: stopped early
    push(Buffer.from('plain'), false); // uncompressed after compressed: order kept
    push(randomBytes(400_000)); // incompressible, only the first 256 KB kept: stopped early too
    await rec.idle();
    expect(frames.map((f) => [f.size, !!f.sizeUnknown, !!f.truncated, !!f.compressed])).toEqual([
      [5, false, false, true],
      [zlib.gzipSync(Buffer.alloc(100_000, 'z')).length, true, true, true],
      [5, false, false, false],
      [expect.any(Number), true, true, true],
    ]);
    expect(Buffer.from(frames[0].base64!, 'base64').toString()).toBe('small');
    expect(Buffer.from(frames[1].base64!, 'base64')).toEqual(Buffer.alloc(64 * 1024, 'z'));
    expect(frames[3].size).toBeGreaterThan(400_000);
    expect(await decompressPrefix(Buffer.from('not gzip'), 'gzip')).toBeUndefined();
    // unknown encodings: counted, never decoded
    expect(messageFrame('send', { compressed: true, size: 3, kept: Buffer.from([1, 2, 3]), complete: true })).toMatchObject({ size: 3, compressed: true, truncated: true });
  });

  it('1000 gzip bombs on one call cost < 100 ms of event-loop time (REVIEW-10 #3)', async () => {
    const bomb = frame(zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024 - 1)), true); // ≈ 16 KB → 16 MB
    const wire = Buffer.concat(Array.from({ length: 1000 }, () => bomb));
    let n = 0;
    const rec = new GrpcFrameRecorder('receive', () => 'gzip', (f) => {
      n++;
      expect(f.sizeUnknown).toBe(true);
    });
    const parser = new GrpcMessageParser((m) => rec.push(m));
    const before = performance.eventLoopUtilization();
    for (let i = 0; i < wire.length; i += 16 * 1024) parser.push(wire.subarray(i, i + 16 * 1024)); // like h2 DATA frames
    await rec.idle();
    const used = performance.eventLoopUtilization(before);
    expect(n).toBe(1000);
    expect(used.active).toBeLessThan(100);
  });

  it('first bytes: h2c preface (even partial), TLS, other; the truncate cutter', () => {
    expect(classifyFirstBytes(Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'))).toBe('h2c');
    expect(classifyFirstBytes(Buffer.from('PRI'))).toBe('h2c');
    expect(classifyFirstBytes(Buffer.from([0x16, 3, 1]))).toBe('tls');
    expect(classifyFirstBytes(Buffer.from('GET / HTTP/1.1\r\n'))).toBe('other');
    const cut = new FirstMessageCut();
    const two = Buffer.concat([frame('first'), frame('second')]);
    expect(cut.push(two.subarray(0, 3))).toEqual({ forward: two.subarray(0, 3), cut: false });
    const r = cut.push(two.subarray(3));
    expect(r.cut).toBe(true);
    expect(r.forward.length).toBe(frame('first').length - 3);
  });

  it('grpcMock validation: reserved headers refused (ruleProblem, setRules)', () => {
    const bad = [
      { kind: 'grpcMock', headers: { ':status': '500' } },
      { kind: 'grpcMock', headers: { 'content-type': 'text/plain' } },
      { kind: 'grpcMock', trailers: { 'grpc-status': '0' } },
      { kind: 'grpcMock', trailers: { 'Grpc-Message': 'x' } },
      { kind: 'grpcMock', headers: { connection: 'close' } },
      { kind: 'grpcMock', headers: { 'x-a': 'line\nbreak' } },
      { kind: 'grpcMock', code: 17 },
      { kind: 'grpcMock', messages: ['not base64!'] },
    ] as Rule['action'][];
    for (const a of bad) expect(ruleProblem({ match: { url: '*' }, action: a })).toBeDefined();
    expect(ruleProblem({ match: { url: '*' }, action: { kind: 'sequence', steps: [{ action: { kind: 'grpcMock', trailers: { 'grpc-status': '1' } } }] } })).toMatch(/Sequence step 1/);
    expect(ruleProblem({ match: { url: '*' }, action: { kind: 'grpcMock', code: 5, message: 'gone', messages: ['CgJoaQ=='], headers: { 'x-h': 'v' }, trailers: { 'x-t-bin': 'AQI=' } } })).toBeUndefined();
  });

  it('socket chain: an HTTP/2 session (as mockttp passes it to agent lookups) leads to its raw socket', () => {
    const raw: Record<symbol, unknown> = {};
    raw[SOCKET_SELF] = raw;
    const socketProxy = new Proxy(raw, { get: (t, p) => (t as Record<string | symbol, unknown>)[p] }); // like http2's socket proxy
    const session = { socket: socketProxy };
    expect(findOnSocketChain(session, (o) => (o === raw ? 'found' : undefined))).toBe('found');
    const throwing = new Proxy({}, { get: () => { throw new Error('ERR_HTTP2_SOCKET_UNBOUND'); } });
    expect(findOnSocketChain({ socket: throwing }, () => undefined)).toBeUndefined();
  });

  it('ruleFromExchange(grpcMock): the call’s response messages and status', () => {
    const ex: Exchange = {
      id: 'g1',
      startedAt: 0,
      method: 'POST',
      url: 'http://api.example.test:50051/t.Echo/Unary',
      requestHeaders: {},
      state: 'completed',
      kind: 'grpc',
      grpc: { service: 't.Echo', method: 'Unary', statusCode: 5, statusMessage: 'not here', messagesSent: 1, messagesReceived: 1 },
      frames: [
        { dir: 'send', at: 0, kind: 'message', size: 2, base64: 'aGk=' },
        { dir: 'receive', at: 1, kind: 'message', size: 3, base64: 'YWJj' },
      ],
    };
    const r = ruleFromExchange(ex, 'grpcMock', 'r1');
    expect(r.match).toEqual({ method: 'POST', url: 'http://api.example.test:50051/t.Echo/Unary*' });
    expect(r.action).toEqual({ kind: 'grpcMock', code: 5, message: 'not here', messages: ['YWJj'] });
    expect(() => ruleFromExchange({ ...ex, frames: [{ dir: 'receive', at: 1, kind: 'message', size: 99_999, base64: 'YQ==', truncated: true }] }, 'grpcMock', 'r2')).toThrow(/not fully recorded/);
  });
});

// ---------------------------------------------------------------- relay over silent tunnels

describe('silent tunnels and the relay (h2c)', () => {
  let up: GrpcServer;
  let proxy: InterceptProxy;
  let target: string;
  let session: http2.ClientHttp2Session;
  beforeAll(async () => {
    up = await startGrpcServer();
    target = `127.0.0.1:${up.port}`;
  });
  afterAll(async () => {
    await up.close();
  });
  beforeEach(async () => {
    proxy = await startProxy();
    session = await h2cSession(proxy.port, target);
  });
  afterEach(async () => {
    session.destroy();
    await proxy.stop();
  });

  it('unary: headers, message, trailers incl. -bin; recorded as one grpc exchange with frames and timings', async () => {
    const r = await grpcCall(session, '/t.Echo/Unary', ['hi'], { metadata: { 'x-req-meta': 'r1' } });
    expect(r.status).toBe(200);
    expect(r.headers?.['x-custom-header']).toBe('head-v');
    expect(r.messages.map(String)).toEqual(['echo:hi']);
    expect(r.trailers).toMatchObject({ 'grpc-status': '0', 'x-custom-trailer': 'trail-v', 'x-bin-bin': 'AQID' });
    expect(up.events).toContain('meta r1');
    // the marker never went upstream
    expect(JSON.stringify(up.seen.at(-1))).not.toMatch(/flutter-intercept/i);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({
      kind: 'grpc',
      method: 'POST',
      url: `http://${target}/t.Echo/Unary`,
      status: 200,
      state: 'completed',
      grpc: { service: 't.Echo', method: 'Unary', statusCode: 0, messagesSent: 1, messagesReceived: 1 },
      responseTrailers: { 'grpc-status': '0', 'x-custom-trailer': 'trail-v', 'x-bin-bin': 'AQID' },
    });
    expect(ex.requestHeaders['x-req-meta']).toBe('r1');
    expect(Object.keys(ex.requestHeaders).some((k) => k.startsWith(':'))).toBe(false);
    expect(ex.frames?.map((f) => [f.dir, f.kind, Buffer.from(f.base64 ?? '', 'base64').toString()])).toEqual([
      ['send', 'message', 'hi'],
      ['receive', 'message', 'echo:hi'],
    ]);
    expect(ex.grpc?.trailersOnly).toBeUndefined();
    expect(ex.timings?.waitMs).toBeGreaterThanOrEqual(0);
    expect(ex.timings?.connectMs).toBeGreaterThanOrEqual(0);
    // the next call reuses the upstream session
    await grpcCall(session, '/t.Echo/Unary', ['again']);
    const ex2 = await waitFor(proxy, (e) => doneGrpc('/t.Echo/Unary')(e) && e.id !== ex.id);
    expect(ex2.timings?.reused).toBe(true);
    expect(up.connections).toBe(1);
  });

  it('trailers-only errors stay trailers-only (UNAVAILABLE + message)', async () => {
    const r = await grpcCall(session, '/t.Echo/Fail', ['x']);
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14, grpcMessage: 'upstream%20says%20no', messages: [] });
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Fail'));
    expect(ex).toMatchObject({ state: 'completed', grpc: { statusCode: 14, statusMessage: 'upstream says no', trailersOnly: true } });
  });

  it('server, client and bidi streaming (no buffering: messages keep their gaps)', async () => {
    const s = await grpcCall(session, '/t.Echo/ServerStream', ['5']);
    expect(s.messages.map(String)).toEqual(['msg0', 'msg1', 'msg2', 'msg3', 'msg4']);
    expect(s.trailers?.['x-stream-trailer']).toBe('done');
    const gaps = s.at.slice(1).map((t, i) => t - s.at[i]);
    expect(Math.min(...gaps)).toBeGreaterThan(20);
    const c = await grpcCall(session, '/t.Echo/ClientStream', ['c0', 'c1', 'c2'], { gapMs: 30 });
    expect(c.messages.map(String)).toEqual(['c0+c1+c2']);
    // bidi, interleaved: the next message only after the previous echo
    const bidi = await new Promise<string[]>((resolve) => {
      const req = session.request({ ':method': 'POST', ':path': '/t.Echo/Bidi', 'content-type': 'application/grpc', te: 'trailers' });
      const got: string[] = [];
      let buf = Buffer.alloc(0);
      req.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
          got.push(buf.subarray(5, 5 + buf.readUInt32BE(1)).toString());
          buf = buf.subarray(5 + buf.readUInt32BE(1));
          if (got.length < 3) req.write(frame(`b${got.length}`));
          else req.end();
        }
      });
      req.on('close', () => resolve(got));
      req.write(frame('b0'));
    });
    expect(bidi).toEqual(['bidi:b0', 'bidi:b1', 'bidi:b2']);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Bidi'));
    expect(ex.grpc).toMatchObject({ messagesSent: 3, messagesReceived: 3, statusCode: 0 });
    expect(ex.frames?.map((f) => f.dir)).toEqual(['send', 'receive', 'send', 'receive', 'send', 'receive']);
  });

  it('3 MB each way: relayed whole; frames keep 64 KB, size is the full size', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const r = await grpcCall(session, '/t.Echo/Unary', [big]);
    expect(r.messages[0].length).toBe(big.length + 5);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    const [sent, received] = ex.frames!;
    expect(sent).toMatchObject({ dir: 'send', size: big.length, truncated: true });
    expect(received).toMatchObject({ dir: 'receive', size: big.length + 5, truncated: true });
    expect(Buffer.from(sent.base64!, 'base64').length).toBe(64 * 1024);
  });

  it('gzip messages: relayed compressed, recorded decompressed with compressed: true', async () => {
    const r = await grpcCall(session, '/t.Echo/Gzip', ['zipped'], { gzip: true });
    expect(r.compressed).toEqual([true]);
    expect(r.messages.map(String)).toEqual(['gz:zipped']);
    // compressed frames are decompressed asynchronously and may join the exchange just after it finished
    const ex = await waitFor(proxy, (e) => doneGrpc('/t.Echo/Gzip')(e) && (e.frames?.length ?? 0) === 2);
    expect(ex.grpc).toMatchObject({ requestEncoding: 'gzip', responseEncoding: 'gzip' });
    expect(ex.frames?.map((f) => [f.dir, f.compressed, Buffer.from(f.base64!, 'base64').toString(), f.size])).toEqual([
      ['send', true, 'zipped', 6],
      ['receive', true, 'gz:zipped', 9],
    ]);
  });

  it('client cancel: RST_STREAM CANCEL reaches the server; the exchange is aborted', async () => {
    const r = await grpcCall(session, '/t.Echo/ServerStream', ['50'], { cancelAfter: 2 });
    expect(r.rstCode).toBe(C.NGHTTP2_CANCEL);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/ServerStream'));
    expect(ex.state).toBe('aborted');
    expect(ex.error).toMatch(/cancelled/);
    await sleep(200);
    expect(up.events).toContain('cancelled /t.Echo/ServerStream');
  });

  it('deadline: grpc-timeout forwarded unchanged; the cancel at the deadline reaches the server', async () => {
    const r = await grpcCall(session, '/t.Echo/Slow', ['x'], { deadlineMs: 300 });
    expect(r.rstCode).toBe(C.NGHTTP2_CANCEL);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Slow'));
    expect(ex).toMatchObject({ state: 'aborted', grpc: { deadlineMs: 300 } });
    expect(ex.error).toMatch(/deadline \(300 ms\)/);
    await sleep(200);
    expect(up.events).toContain('timeout 300m');
    expect(up.events).toContain('cancelled /t.Echo/Slow');
  });

  it('a server reset mid-response reaches the app with its code', async () => {
    const r = await grpcCall(session, '/t.Echo/Reset', ['x']);
    expect(r.messages.map(String)).toEqual(['one']);
    expect(r.rstCode).toBe(C.NGHTTP2_ENHANCE_YOUR_CALM);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Reset'));
    expect(ex.state).toBe('error');
    expect(ex.error).toMatch(/ENHANCE_YOUR_CALM/);
  });

  it('upstream down → trailers-only UNAVAILABLE "Flutter Intercept: …" (never a bare close)', async () => {
    const dead = net.createServer();
    dead.listen(0, '127.0.0.1');
    await once(dead, 'listening');
    const port = (dead.address() as net.AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const s = await h2cSession(proxy.port, `127.0.0.1:${port}`);
    const r = await grpcCall(s, '/t.Echo/Unary', ['x']);
    s.destroy();
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    expect(decodeGrpcMessage(r.grpcMessage)).toMatch(/^Flutter Intercept: Could not connect to 127\.0\.0\.1:\d+/);
    const ex = await waitFor(proxy, (e) => e.kind === 'grpc' && e.url.includes(`:${port}/`) && e.state !== 'pending');
    expect(ex).toMatchObject({ state: 'error', grpc: { statusCode: 14, trailersOnly: true } });
  });

  it('connect timeout from Flutter-Intercept-Connect-Timeout (a server that never finishes TLS)', async () => {
    const held = new Set<net.Socket>();
    const hang = net.createServer((sock) => {
      held.add(sock); // accepts, never answers the ClientHello
      sock.on('error', () => undefined);
      sock.resume(); // reads (and drops) the ClientHello, so it sees the proxy close
    });
    hang.listen(0, '127.0.0.1');
    await once(hang, 'listening');
    const port = (hang.address() as net.AddressInfo).port;
    const ca = await generateCACertificate();
    const p2 = await startProxy({ ca: { key: ca.key, cert: ca.cert }, grpcDecryptHosts: ['127.0.0.1'] });
    try {
      const { session: s } = await tlsSession(p2.port, `127.0.0.1:${port}`, { ca: ca.cert, headers: { 'Flutter-Intercept-Connect-Timeout': '300' } });
      const t0 = Date.now();
      const r = await grpcCall(s, '/t.Echo/Unary', ['x']);
      s.destroy();
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
      expect(decodeGrpcMessage(r.grpcMessage)).toMatch(/within 0\.3 s/);
      // the half-open upstream connection was closed, not leaked
      for (let i = 0; i < 50 && [...held].some((h) => !h.closed); i++) await sleep(20);
      expect(held.size).toBe(1);
      expect([...held].every((h) => h.closed)).toBe(true);
    } finally {
      await p2.stop();
      for (const h of held) h.destroy();
      await new Promise((r) => hang.close(r));
    }
  });

  it('other bytes inside a silent tunnel: closed, recorded as an error tunnel; nothing is written back', async () => {
    const sock = await silentSocket(proxy.port, target);
    const got: Buffer[] = [];
    sock.on('data', (d) => got.push(d));
    sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(sock, 'close');
    expect(Buffer.concat(got).length).toBe(0);
    const ex = await waitFor(proxy, (e) => e.kind === 'tunnel' && e.grpcTunnel === true);
    expect(ex).toMatchObject({ state: 'error', method: 'CONNECT' });
  });

  it('the CONNECT head and the h2 preface in one chunk (split at the blank line)', async () => {
    const raw = net.connect(proxy.port, '127.0.0.1');
    await once(raw, 'connect');
    const head = Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nFlutter-Intercept-Tunnel: SILENT\r\n\r\n`, 'latin1');
    let first = true;
    let firstWrite = 0;
    const duplex = new Duplex({
      write(chunk: Buffer, _enc, cb) {
        const b = first ? Buffer.concat([head, chunk]) : chunk;
        if (first) firstWrite = b.length;
        first = false;
        raw.write(b, cb);
      },
      read() {},
      final(cb) {
        raw.end();
        cb();
      },
    });
    raw.on('data', (d) => duplex.push(d));
    raw.on('end', () => duplex.push(null));
    raw.on('error', () => duplex.destroy());
    const session2 = http2.connect(`http://${target}`, { createConnection: () => duplex });
    session2.on('error', () => undefined);
    const r = await grpcCall(session2, '/t.Echo/Unary', ['one-chunk']);
    session2.destroy();
    raw.destroy();
    expect(firstWrite).toBeGreaterThan(head.length + 20);
    expect(r.messages.map(String)).toEqual(['echo:one-chunk']);
  });
});

// ---------------------------------------------------------------- TLS: decrypted (grpcDecryptHosts) or passed through

describe('TLS silent tunnels', () => {
  let up: GrpcServer;
  let upCert: { key: string; cert: string };
  let proxy: InterceptProxy;
  let ca: { key: string; cert: string };
  beforeAll(async () => {
    upCert = await selfSignedCert();
    up = await startGrpcServer({ tls: upCert });
    const c = await generateCACertificate();
    ca = { key: c.key, cert: c.cert };
  });
  afterAll(async () => {
    await up.close();
  });
  beforeEach(async () => {
    proxy = await startProxy({ ca });
  });
  afterEach(async () => {
    await proxy.stop();
  });

  it('a grpcDecryptHosts host is decrypted (the app trusts our CA): full gRPC exchange, https URL', async () => {
    expect(proxy.setGrpcDecryptHosts(['127.0.0.1', '*', 'api.*'])).toEqual({
      hosts: ['127.0.0.1'],
      problems: [expect.stringMatching(/every host/), expect.stringMatching(/last label/)],
    });
    expect(proxy.grpcDecryptHosts).toEqual(['127.0.0.1']);
    const target = `127.0.0.1:${up.port}`;
    const { session, socket } = await tlsSession(proxy.port, target, { ca: ca.cert });
    expect(socket.alpnProtocol).toBe('h2'); // [grpc-exp, h2] → h2 with http2: 'fallback'
    const r = await grpcCall(session, '/t.Echo/Unary', ['secure']);
    const s = await grpcCall(session, '/t.Echo/ServerStream', ['3']);
    session.destroy();
    expect(r.messages.map(String)).toEqual(['echo:secure']);
    expect(r.trailers?.['x-bin-bin']).toBe('AQID');
    expect(s.messages.length).toBe(3);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ url: `https://${target}/t.Echo/Unary`, state: 'completed', grpc: { statusCode: 0 } });
    expect(ex.timings?.tlsMs).toBeGreaterThanOrEqual(0);
  });

  it('other TLS hosts: an undecrypted tunnel (the server’s own certificate), grpcTunnel exchange, no reply written', async () => {
    const target = `127.0.0.1:${up.port}`;
    const { session, socket } = await tlsSession(proxy.port, target);
    expect(socket.getPeerCertificate().fingerprint256).toBe(new X509Certificate(upCert.cert).fingerprint256);
    const r = await grpcCall(session, '/t.Echo/Unary', ['through']);
    await new Promise<void>((resolve) => session.close(() => resolve())); // graceful: GOAWAY, then the TLS socket ends
    socket.end();
    expect(r.messages.map(String)).toEqual(['echo:through']);
    const ex = await waitFor(proxy, (e) => e.kind === 'tunnel' && e.state !== 'pending');
    expect(ex).toMatchObject({ kind: 'tunnel', grpcTunnel: true, method: 'CONNECT', url: `https://${target}/`, state: 'completed' });
    expect(ex.tunnelBytes!.sent).toBeGreaterThan(0);
    expect(JSON.stringify(ex.requestHeaders)).not.toMatch(/flutter-intercept/i);
    expect(proxy.getExchanges().some((e) => e.kind === 'grpc')).toBe(false);
  });

  it('a tlsPassthrough host is never decrypted, even when listed in grpcDecryptHosts', async () => {
    proxy.setGrpcDecryptHosts(['127.0.0.1']);
    proxy.setTlsPassthrough(['127.0.0.1']);
    const { session, socket } = await tlsSession(proxy.port, `127.0.0.1:${up.port}`);
    expect(socket.getPeerCertificate().fingerprint256).toBe(new X509Certificate(upCert.cert).fingerprint256);
    expect((await grpcCall(session, '/t.Echo/Unary', ['p'])).messages.map(String)).toEqual(['echo:p']);
    session.destroy();
  });

  /** A TLS client inside a silent tunnel; resolves whether the handshake completed within `ms`. */
  async function heldClient(port: number, target: string, ms = 300) {
    const sock = await silentSocket(port, target);
    const t = tls.connect({ socket: sock, servername: 'localhost', ALPNProtocols: ['grpc-exp', 'h2'], rejectUnauthorized: false });
    t.on('error', () => undefined);
    let secure = false;
    t.once('secureConnect', () => (secure = true));
    await sleep(ms);
    return { t, sock, secure };
  }

  it('block / offline / replay: fail hold a silent passthrough tunnel: no answer, no close, the server never contacted (REVIEW-10 #1)', async () => {
    const target = `127.0.0.1:${up.port}`;
    const before = up.connections;
    proxy.setRules([rule('b', `https://${target}/*`, { kind: 'block', mode: 'reset' }, { match: { method: 'CONNECT', url: `https://${target}/*` } })]);
    const a = await heldClient(proxy.port, target);
    expect(a.secure).toBe(false);
    expect(a.sock.destroyed).toBe(false);
    a.t.destroy(); // the app gives up (its deadline)
    let ex = await waitFor(proxy, (e) => e.kind === 'tunnel' && e.state !== 'pending');
    expect(ex).toMatchObject({ state: 'blocked', grpcTunnel: true, matchedRuleId: 'b' });
    expect(ex.simulated).toMatch(/^Blocked \(held without an answer; the app gave up after \d+\.\d s\)$/);
    proxy.setRules([]);
    proxy.setReplay([], { fallback: 'fail' });
    const b = await heldClient(proxy.port, target);
    expect(b.secure).toBe(false);
    b.t.destroy();
    ex = await waitFor(proxy, (e) => e.kind === 'tunnel' && e.state !== 'pending' && e.id !== ex.id);
    expect(ex.simulated).toMatch(/^Not in the recording \(replay: fail\) \(held/);
    proxy.setReplay(undefined);
    expect(up.connections).toBe(before);
  });

  it('a held tunnel is reset after breakpointTimeoutMs (offline profile)', async () => {
    const p2 = await startProxy({ ca, breakpointTimeoutMs: 400 });
    try {
      p2.setNetworkProfile({ kind: 'offline' });
      const c = await heldClient(p2.port, `127.0.0.1:${up.port}`, 50);
      await once(c.sock, 'close');
      const ex = await waitFor(p2, (e) => e.kind === 'tunnel' && e.state !== 'pending');
      expect(ex.simulated).toMatch(/^Offline \(held without an answer; reset after 0\.\d s\)$/);
    } finally {
      await p2.stop();
    }
  });

  it('a web page’s gRPC call to a client-certificate host is refused before any connection (REVIEW-10 #6)', async () => {
    proxy.setGrpcDecryptHosts(['127.0.0.1']);
    expect(proxy.setClientCertificates([{ host: '127.0.0.1', cert: upCert.cert, key: upCert.key }])).toEqual([{ host: '127.0.0.1' }]);
    const before = up.connections;
    const { session } = await tlsSession(proxy.port, `127.0.0.1:${up.port}`, { ca: ca.cert });
    const r = await grpcCall(session, '/t.Echo/Unary', ['x'], { metadata: { origin: 'https://ads.example' } });
    session.destroy();
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    expect(decodeGrpcMessage(r.grpcMessage)).toMatch(/^Flutter Intercept: Refused: a client certificate/);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.state).toBe('blocked');
    expect(up.connections).toBe(before);
  });

  it('HTTP/1.1 clients and a Chrome-like ALPN offer still get HTTP/1.1; an h2-only offer gets h2', async () => {
    const alpn = async (protocols: string[]) => {
      const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: 'example.test:443', agent: false });
      c.end();
      const [, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
      const t = tls.connect({ socket: raw, servername: 'example.test', ALPNProtocols: protocols, rejectUnauthorized: false });
      await once(t, 'secureConnect');
      const p = t.alpnProtocol;
      t.destroy();
      return p;
    };
    expect(await alpn(['h2', 'http/1.1'])).toBe('http/1.1');
    expect(await alpn(['http/1.1'])).toBe('http/1.1');
    expect(await alpn(['h2'])).toBe('h2');
    expect(await alpn(['grpc-exp', 'h2'])).toBe('h2');
    const httpUp = await startUpstream();
    try {
      expect((await viaProxy(proxy.port, `${httpUp.httpsUrl}/json`)).text).toBe('{"hello":"world"}');
      expect((await viaProxy(proxy.port, `${httpUp.httpUrl}/json`)).text).toBe('{"hello":"world"}');
      // the silent-tunnel headers mean nothing on other requests and never go upstream
      const echo = await viaProxy(proxy.port, `${httpUp.httpUrl}/echo`, { headers: { 'Flutter-Intercept-Tunnel': 'silent', 'Flutter-Intercept-Connect-Timeout': '5' } });
      expect(echo.status).toBe(200);
      expect(JSON.stringify(JSON.parse(echo.text).headers)).not.toMatch(/flutter-intercept/i);
    } finally {
      await httpUp.close();
    }
  });
});

// ---------------------------------------------------------------- rules

describe('rules on gRPC calls', () => {
  let up: GrpcServer;
  let proxy: InterceptProxy;
  let target: string;
  let session: http2.ClientHttp2Session;
  beforeAll(async () => {
    up = await startGrpcServer();
    target = `127.0.0.1:${up.port}`;
  });
  afterAll(async () => {
    await up.close();
  });
  beforeEach(async () => {
    proxy = await startProxy({ breakpointTimeoutMs: 2000 });
    session = await h2cSession(proxy.port, target);
  });
  afterEach(async () => {
    session.destroy();
    await proxy.stop();
  });
  const calls = (path: string) => up.events.filter((e) => e === `call ${path}`).length;

  it('grpcMock: headers, messages gapMs apart after delayMs, then status trailers; never contacts the server', async () => {
    const before = calls('/t.Echo/Unary');
    proxy.setRules([
      rule('m', '*/t.Echo/Unary', {
        kind: 'grpcMock',
        messages: [Buffer.from('m1').toString('base64'), Buffer.from('m2').toString('base64')],
        delayMs: 150,
        gapMs: 100,
        headers: { 'x-mock': 'yes' },
        trailers: { 'x-t': 'v', 'x-t-bin': 'AQI=' },
        code: 0,
        messagesJson: [{ ignored: true }],
      }),
    ]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['q']);
    expect(r.headers?.['x-mock']).toBe('yes');
    expect(r.messages.map(String)).toEqual(['m1', 'm2']);
    expect(r.at[0]).toBeGreaterThanOrEqual(140);
    expect(r.at[1] - r.at[0]).toBeGreaterThanOrEqual(80);
    expect(r.trailers).toMatchObject({ 'grpc-status': '0', 'x-t': 'v', 'x-t-bin': 'AQI=' });
    expect(calls('/t.Echo/Unary')).toBe(before);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ state: 'mocked', matchedRuleId: 'm', grpc: { statusCode: 0, messagesSent: 1, messagesReceived: 2 } });
    expect(ex.timings?.delayMs).toBeGreaterThanOrEqual(140);
    expect(ex.frames?.map((f) => f.dir)).toEqual(['send', 'receive', 'receive']);
  });

  it('grpcMock: a non-zero code without messages is trailers-only, message percent-encoded', async () => {
    proxy.setRules([rule('m', '*/t.Echo/Unary', { kind: 'grpcMock', code: 7, message: 'nope ✗ 100%' })]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['q']);
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 7, grpcMessage: 'nope %E2%9C%97 100%25' });
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ state: 'mocked', grpc: { statusCode: 7, statusMessage: 'nope ✗ 100%', trailersOnly: true } });
  });

  it('grpcMock answers a bidi call before the app half-closes', async () => {
    proxy.setRules([rule('m', '*/t.Echo/Bidi', { kind: 'grpcMock', messages: [Buffer.from('b1').toString('base64')] })]);
    const r = await grpcCall(session, '/t.Echo/Bidi', ['q'], { keepOpen: true });
    expect(r.messages.map(String)).toEqual(['b1']);
    expect(r.grpcStatus).toBe(0);
  });

  it('setRules refuses a grpcMock that sets reserved headers: listed, never matched', async () => {
    proxy.setRules([
      rule('bad', '*/t.Echo/Unary', { kind: 'grpcMock', trailers: { 'grpc-status': '3' } }),
      rule('bad2', '*/t.Echo/Unary', { kind: 'sequence', steps: [{ action: { kind: 'grpcMock', headers: { ':path': '/x' } } }] }),
    ]);
    expect(proxy.refusedRules).toEqual([
      { id: 'bad', problem: expect.stringMatching(/grpc-status/) },
      { id: 'bad2', problem: expect.stringMatching(/Sequence step 1: .*pseudo/) },
    ]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['real']);
    expect(r.messages.map(String)).toEqual(['echo:real']);
  });

  it('block: status → trailers-only UNAVAILABLE "Blocked by Flutter Intercept"; reset → RST_STREAM', async () => {
    const before = calls('/t.Echo/Unary');
    proxy.setRules([rule('b', '*/t.Echo/Unary', { kind: 'block', mode: 'status', status: 403 })]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['q']);
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14, grpcMessage: 'Blocked by Flutter Intercept' });
    expect((await waitFor(proxy, doneGrpc('/t.Echo/Unary'))).state).toBe('blocked');
    proxy.setRules([rule('b', '*/t.Echo/Unary', { kind: 'block', mode: 'reset' })]);
    const r2 = await grpcCall(session, '/t.Echo/Unary', ['q']);
    expect(r2.rstCode).toBe(C.NGHTTP2_INTERNAL_ERROR);
    expect(r2.grpcStatus).toBeUndefined();
    expect(calls('/t.Echo/Unary')).toBe(before);
  });

  it('faults: reset → RST_STREAM INTERNAL_ERROR, dns → UNAVAILABLE "DNS lookup failed", truncate → first message then reset', async () => {
    proxy.setRules([rule('f', '*/t.Echo/Unary', { kind: 'fault', fault: 'reset' })]);
    expect((await grpcCall(session, '/t.Echo/Unary', ['q'])).rstCode).toBe(C.NGHTTP2_INTERNAL_ERROR);
    let ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ state: 'blocked', simulated: 'Fault: connection reset' });

    proxy.setRules([rule('f', '*/t.Echo/Unary', { kind: 'fault', fault: 'dns' })]);
    expect(await grpcCall(session, '/t.Echo/Unary', ['q'])).toMatchObject({ trailersOnly: true, grpcStatus: 14, grpcMessage: 'DNS lookup failed' });

    proxy.setRules([rule('f', '*/t.Echo/ServerStream', { kind: 'fault', fault: 'truncate' })]);
    const t = await grpcCall(session, '/t.Echo/ServerStream', ['5']);
    expect(t.messages.map(String)).toEqual(['msg0']);
    expect(t.rstCode).toBe(C.NGHTTP2_INTERNAL_ERROR);
    expect(t.grpcStatus).toBeUndefined();
    ex = await waitFor(proxy, doneGrpc('/t.Echo/ServerStream'));
    expect(ex).toMatchObject({ state: 'blocked', simulated: 'Fault: truncated response', grpc: { messagesReceived: 1 } });
  });

  it('fault timeout: no answer until the app gives up (its deadline)', async () => {
    proxy.setRules([rule('f', '*/t.Echo/Unary', { kind: 'fault', fault: 'timeout' })]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['q'], { deadlineMs: 300 });
    expect(r.rstCode).toBe(C.NGHTTP2_CANCEL);
    expect(r.messages).toEqual([]);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.state).toBe('blocked');
    expect(ex.simulated).toMatch(/the app gave up after 0\.\d s/);
  });

  it('throttle: latency before the server is contacted, kbps paces the response; labels like HTTP', async () => {
    proxy.setRules([rule('t', '*/t.Echo/Unary', { kind: 'throttle', latencyMs: 300, kbps: 400, uploadKbps: 400 })]);
    const t0 = Date.now();
    const r = await grpcCall(session, '/t.Echo/Unary', [Buffer.alloc(20_000, 1)]);
    const took = Date.now() - t0;
    expect(r.messages[0].length).toBe(20_005);
    // 300 ms + 20 KB up at 400 kbps (~400 ms) + 20 KB down (~400 ms)
    expect(took).toBeGreaterThan(900);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ state: 'completed', simulated: '+300 ms, 400 kbps, 400 kbps up', matchedRuleId: 't' });
    expect(ex.timings?.delayMs).toBeGreaterThanOrEqual(290);
  });

  it('network profile: offline → UNAVAILABLE; drop rate → UNAVAILABLE; throttle labels', async () => {
    proxy.setNetworkProfile({ kind: 'offline' });
    expect(await grpcCall(session, '/t.Echo/Unary', ['q'])).toMatchObject({ trailersOnly: true, grpcStatus: 14, grpcMessage: 'DNS lookup failed' });
    expect((await waitFor(proxy, doneGrpc('/t.Echo/Unary'))).simulated).toBe('Offline');
    proxy.setNetworkProfile({ kind: 'throttle', latencyMs: 50, dropRate: 1 });
    const r = await grpcCall(session, '/t.Echo/ServerStream', ['2']);
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    expect(decodeGrpcMessage(r.grpcMessage)).toMatch(/dropped/);
    expect((await waitFor(proxy, doneGrpc('/t.Echo/ServerStream'))).simulated).toBe('+50 ms, 100% fail: dropped');
    proxy.setNetworkProfile({ kind: 'none' });
    proxy.setReplay([], { fallback: 'fail', name: 'demo' });
    expect(await grpcCall(session, '/t.Echo/Gzip', ['q'])).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    expect((await waitFor(proxy, doneGrpc('/t.Echo/Gzip'))).simulated).toBe('Not in the recording "demo" (replay: fail)');
    proxy.setReplay(undefined);
    proxy.setNetworkProfile({ kind: 'throttle', preset: 'fast-3g', latencyMs: 150, kbps: 1600, uploadKbps: 750 });
    expect((await grpcCall(session, '/t.Echo/ClientStream', ['a'])).messages.map(String)).toEqual(['a']);
    expect((await waitFor(proxy, doneGrpc('/t.Echo/ClientStream'))).simulated).toBe('Fast 3G');
  });

  it('sequence: block first, then the real server; rule-hit reports the step', async () => {
    const hits: [string, number, number | undefined][] = [];
    proxy.on('rule-hit', (id, used, step) => hits.push([id, used, step]));
    proxy.setRules([rule('s', '*/t.Echo/Unary', { kind: 'sequence', steps: [{ action: { kind: 'block', mode: 'status' } }, { action: { kind: 'passthrough' } }] })]);
    expect((await grpcCall(session, '/t.Echo/Unary', ['1'])).grpcStatus).toBe(14);
    expect((await grpcCall(session, '/t.Echo/Unary', ['2'])).messages.map(String)).toEqual(['echo:2']);
    const all = proxy.getExchanges().filter(isGrpc('/t.Echo/Unary'));
    expect(all.map((e) => e.simulated)).toEqual(['Sequence step 1/2', 'Sequence step 2/2']);
    await sleep(10);
    expect(hits.map((h) => h[2])).toEqual([0, 1]);
  });

  it('rules with other actions never match a gRPC call (the next rule is tried, with a note); grpcMock never matches HTTP', async () => {
    proxy.setRules([
      rule('mock', '*/t.Echo/Unary', { kind: 'mock', status: 200, body: 'http mock' }),
      rule('rw', '*/t.Echo/Unary', { kind: 'rewrite', response: { setHeaders: { 'x-a': 'b' } } }),
      rule('seq', '*/t.Echo/Unary', { kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, body: '' } }] }),
      rule('g', '*/t.Echo/Unary', { kind: 'grpcMock', code: 5 }),
    ]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['q']);
    expect(r.grpcStatus).toBe(5);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.matchedRuleId).toBe('g');
    expect(ex.error).toMatch(/Mock rule does not apply to gRPC calls/);
    // HTTP: a grpcMock rule is skipped
    const http1 = await startUpstream();
    try {
      proxy.setRules([rule('g', '*', { kind: 'grpcMock', code: 5 }), rule('s', '*', { kind: 'sequence', steps: [{ action: { kind: 'grpcMock' } }] })]);
      const res = await viaProxy(proxy.port, `${http1.httpUrl}/json`);
      expect(res.text).toBe('{"hello":"world"}');
    } finally {
      await http1.close();
    }
  });

  it('idle upstream sessions are closed', async () => {
    grpcPoolTesting.idleMs = 100;
    try {
      const p2 = await startProxy();
      const s = await h2cSession(p2.port, target);
      await grpcCall(s, '/t.Echo/Unary', ['x']);
      const pool = (p2 as unknown as { grpcPool: { size: number } }).grpcPool;
      expect(pool.size).toBe(1);
      await sleep(300);
      expect(pool.size).toBe(0);
      s.destroy();
      await p2.stop();
    } finally {
      delete grpcPoolTesting.idleMs;
    }
  });
});

// ---------------------------------------------------------------- upstream sessions

describe('upstream sessions', () => {
  let proxy: InterceptProxy;
  beforeEach(async () => {
    proxy = await startProxy();
  });
  afterEach(async () => {
    await proxy.stop();
  });

  /** A raw h2c server: answers every call with one message; `goawayAfter` calls → GOAWAY; counts connections. */
  async function rawServer(o: { maxConcurrentStreams?: number; goawayAfter?: number; holdMs?: number } = {}) {
    const server = http2.createServer(o.maxConcurrentStreams ? { settings: { maxConcurrentStreams: o.maxConcurrentStreams } } : {});
    let connections = 0;
    let calls = 0;
    const sockets = new Set<net.Socket>();
    server.on('connection', (sock: net.Socket) => {
      connections++;
      sockets.add(sock);
    });
    server.on('stream', (stream) => {
      calls++;
      const n = calls;
      stream.on('error', () => undefined);
      stream.resume();
      stream.on('end', () => {
        setTimeout(() => {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end(frame(`r${n}`));
          if (o.goawayAfter && n === o.goawayAfter) stream.session?.goaway();
        }, o.holdMs ?? 0);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
      port: (server.address() as net.AddressInfo).port,
      get connections() {
        return connections;
      },
      async close() {
        for (const sck of sockets) sck.destroy();
        await new Promise((r) => server.close(r));
      },
    };
  }

  it('GOAWAY: in-flight calls finish, the next call opens a new session', async () => {
    const srv = await rawServer({ goawayAfter: 1 });
    const s = await h2cSession(proxy.port, `127.0.0.1:${srv.port}`);
    expect((await grpcCall(s, '/t.S/M', ['a'])).messages.map(String)).toEqual(['r1']);
    await sleep(50);
    expect((await grpcCall(s, '/t.S/M', ['b'])).messages.map(String)).toEqual(['r2']);
    s.destroy();
    expect(srv.connections).toBe(2);
    await srv.close();
  });

  it('max concurrent streams: a full session gets a sibling', async () => {
    const srv = await rawServer({ maxConcurrentStreams: 1, holdMs: 150 });
    const s = await h2cSession(proxy.port, `127.0.0.1:${srv.port}`);
    await grpcCall(s, '/t.S/M', ['warm']); // the server's SETTINGS are known now
    const both = await Promise.all([grpcCall(s, '/t.S/M', ['a']), grpcCall(s, '/t.S/M', ['b'])]);
    s.destroy();
    expect(both.every((r) => r.grpcStatus === 0)).toBe(true);
    expect(srv.connections).toBe(2);
    await srv.close();
  });

  it('through the upstream proxy (CONNECT), and emulator aliases connect to this machine', async () => {
    const up = await startGrpcServer();
    const tiny = await startTinyProxy();
    try {
      proxy.setUpstreamProxy({ url: tiny.url });
      const s = await h2cSession(proxy.port, `grpc.example.invalid:${up.port}`);
      expect((await grpcCall(s, '/t.Echo/Unary', ['via'])).messages.map(String)).toEqual(['echo:via']);
      s.destroy();
      expect(tiny.seen).toContain(`CONNECT grpc.example.invalid:${up.port}`);
      proxy.setUpstreamProxy(undefined);
      const s2 = await h2cSession(proxy.port, `10.0.2.2:${up.port}`);
      expect((await grpcCall(s2, '/t.Echo/Unary', ['alias'])).messages.map(String)).toEqual(['echo:alias']);
      s2.destroy();
      const ex = await waitFor(proxy, (e) => doneGrpc('/t.Echo/Unary')(e) && e.url.includes('10.0.2.2'));
      expect(ex.url).toBe(`http://10.0.2.2:${up.port}/t.Echo/Unary`);
    } finally {
      await tiny.close();
      await up.close();
    }
  });
});

// ---------------------------------------------------------------- breaker reports (CONTRACTS §16.8)

describe('breaker reports', () => {
  it('Flutter-Intercept-Tunnel: breaker → one grpcBreaker event per authority per 60 s; never answered, no exchange', async () => {
    const proxy = await startProxy();
    try {
      const events: GrpcBreakerEvent[] = [];
      proxy.on(GRPC_BREAKER_EVENT, (e: GrpcBreakerEvent) => events.push(e));
      const report = async (authority: string) => {
        const s = net.connect(proxy.port, '127.0.0.1');
        await once(s, 'connect');
        const got: Buffer[] = [];
        s.on('data', (d) => got.push(d));
        s.on('error', () => undefined);
        s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nFlutter-Intercept-Tunnel: Breaker\r\n\r\n`);
        await once(s, 'close');
        return Buffer.concat(got).length;
      };
      expect(await report('API.example.test:443')).toBe(0);
      expect(await report('api.example.test:443')).toBe(0);
      expect(await report('[::1]:50051')).toBe(0);
      await sleep(20);
      expect(events).toEqual([
        { authority: 'api.example.test:443', viaLan: false },
        { authority: '[::1]:50051', viaLan: false },
      ]);
      expect(proxy.getExchanges()).toEqual([]);
    } finally {
      await proxy.stop();
    }
  });
});

// ---------------------------------------------------------------- self-check fallback

describe('self-check fallback', () => {
  afterEach(() => {
    delete grpcTesting.forceProblem;
  });

  it('without the mockttp internals, silent tunnels are passed through undecrypted and the problem is reported', async () => {
    grpcTesting.forceProblem = 'test: internals missing';
    const up = await startGrpcServer();
    const proxy = await startProxy();
    try {
      expect(proxy.grpcSupport()).toEqual({ ok: false, problem: 'test: internals missing' });
      const snapshots: Exchange[] = [];
      proxy.on('exchange', (e) => snapshots.push(e));
      const s = await h2cSession(proxy.port, `127.0.0.1:${up.port}`);
      const r = await grpcCall(s, '/t.Echo/Unary', ['raw']);
      await new Promise<void>((resolve) => s.close(() => resolve())); // graceful: an abrupt close may end the tunnel as an error
      expect(r.messages.map(String)).toEqual(['echo:raw']);
      const ex = await waitFor(proxy, (e) => e.kind === 'tunnel' && e.state !== 'pending');
      expect(ex).toMatchObject({ grpcTunnel: true, url: `http://127.0.0.1:${up.port}/` });
      // the note is on the tunnel while it is open (a teardown error may replace it at the end)
      expect(snapshots.some((e) => e.kind === 'tunnel' && /internals missing/.test(e.error ?? ''))).toBe(true);
      expect(proxy.getExchanges().some((e) => e.kind === 'grpc')).toBe(false);
    } finally {
      await proxy.stop();
      await up.close();
    }
  });

  it('a working mockttp passes the self-check', async () => {
    const proxy = await startProxy();
    try {
      expect(proxy.grpcSupport()).toEqual({ ok: true });
    } finally {
      await proxy.stop();
    }
  });
});

// ---------------------------------------------------------------- LAN clients (CONTRACTS §7)

const LAN_IP = lanIPv4Addresses()[0];

describe.skipIf(!LAN_IP)('silent tunnels from LAN clients', () => {
  const token = randomBytes(32).toString('base64url');
  const auth = (t = token) => `Basic ${Buffer.from(`flutter-intercept:${t}`).toString('base64')}`;
  let up: GrpcServer;
  let proxy: InterceptProxy;
  let lanPort: number;
  let checks: number;
  let allowFirstOnly: boolean;
  beforeEach(async () => {
    up = await startGrpcServer({ host: LAN_IP });
    checks = 0;
    allowFirstOnly = false;
    lanTesting.allowTarget = (ip, port) => {
      if (ip !== LAN_IP || port !== up.port) return false;
      checks++;
      return !allowFirstOnly || checks === 1;
    };
    proxy = await startProxy();
    lanPort = (await proxy.openLan({ host: LAN_IP!, token })).port;
  });
  afterEach(async () => {
    await proxy.stop();
    await up.close();
    delete lanTesting.allowTarget;
  });

  it('with the token: relayed, viaLan, the token never recorded', async () => {
    const s = await h2cSession(lanPort, `${LAN_IP}:${up.port}`, { host: LAN_IP, headers: { 'Proxy-Authorization': auth() } });
    const r = await grpcCall(s, '/t.Echo/Unary', ['lan']);
    s.destroy();
    expect(r.messages.map(String)).toEqual(['echo:lan']);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ viaLan: true, state: 'completed' });
    expect(JSON.stringify(proxy.getExchanges())).not.toContain(token);
  });

  it('a bad token closes the silent tunnel without a reply; the server is never contacted', async () => {
    const sock = await silentSocket(lanPort, `${LAN_IP}:${up.port}`, { host: LAN_IP, headers: { 'Proxy-Authorization': auth('wrong-token-wrong-token') } });
    const got: Buffer[] = [];
    sock.on('data', (d) => got.push(d));
    sock.on('error', () => undefined);
    sock.write(Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1'));
    await once(sock, 'close');
    expect(Buffer.concat(got).length).toBe(0);
    expect(up.connections).toBe(0);
    // no credentials at all: same
    const sock2 = await silentSocket(lanPort, `${LAN_IP}:${up.port}`, { host: LAN_IP });
    sock2.on('error', () => undefined);
    const got2: Buffer[] = [];
    sock2.on('data', (d) => got2.push(d));
    await once(sock2, 'close');
    expect(Buffer.concat(got2).length).toBe(0);
    expect(up.connections).toBe(0);
  });

  it('a loopback target is refused at the gate (closed, recorded); DNS rebinding is caught when the relay connects', async () => {
    const sock = await silentSocket(lanPort, `127.0.0.1:${up.port}`, { host: LAN_IP, headers: { 'Proxy-Authorization': auth() } });
    sock.on('error', () => undefined);
    await once(sock, 'close');
    expect((await waitFor(proxy, (e) => e.viaLan === true && e.method === 'CONNECT')).state).toBe('error');
    allowFirstOnly = true; // the gate's check passes, the relay's own check doesn't
    const s = await h2cSession(lanPort, `${LAN_IP}:${up.port}`, { host: LAN_IP, headers: { 'Proxy-Authorization': auth() } });
    const r = await grpcCall(s, '/t.Echo/Unary', ['x']);
    s.destroy();
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    expect(decodeGrpcMessage(r.grpcMessage)).toMatch(/^Flutter Intercept: blocked a LAN client/); // the prefix once
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ state: 'error', viaLan: true });
    expect(up.connections).toBe(0);
    expect(checks).toBeGreaterThanOrEqual(2);
  });

  it('HTTP/2 requests that are not gRPC keep the LAN guard (per-request target check)', async () => {
    allowFirstOnly = true; // the gate's CONNECT check passes; the request's own check must refuse
    const s = await h2cSession(lanPort, `${LAN_IP}:${up.port}`, { host: LAN_IP, headers: { 'Proxy-Authorization': auth() } });
    const status = await new Promise<number>((resolve) => {
      const r = s.request({ ':method': 'GET', ':path': '/plain' });
      r.on('response', (h) => resolve(Number(h[':status'])));
      r.on('error', () => resolve(-1));
      r.end();
    });
    s.destroy();
    expect(status).toBe(403);
    expect(up.connections).toBe(0);
  });

  it('breaker reports from the LAN: with the token → viaLan event; a bad token is dropped silently', async () => {
    const events: GrpcBreakerEvent[] = [];
    proxy.on(GRPC_BREAKER_EVENT, (e: GrpcBreakerEvent) => events.push(e));
    const report = async (headers: string) => {
      const s = net.connect(lanPort, LAN_IP);
      await once(s, 'connect');
      s.on('error', () => undefined);
      const got: Buffer[] = [];
      s.on('data', (d) => got.push(d));
      s.write(`CONNECT ${LAN_IP}:${up.port} HTTP/1.1\r\nHost: x\r\nFlutter-Intercept-Tunnel: breaker\r\n${headers}\r\n`);
      await once(s, 'close');
      return Buffer.concat(got).length;
    };
    expect(await report(`Proxy-Authorization: ${auth('nope-nope-nope-nope')}\r\n`)).toBe(0);
    await sleep(20);
    expect(events).toEqual([]);
    expect(await report(`Proxy-Authorization: ${auth()}\r\n`)).toBe(0);
    await sleep(20);
    expect(events).toEqual([{ authority: `${LAN_IP}:${up.port}`, viaLan: true }]);
    expect(proxy.getExchanges()).toEqual([]);
    expect(up.connections).toBe(0);
  });

  it('upstream sessions are not shared across LAN gates and loopback clients', async () => {
    const s = await h2cSession(lanPort, `${LAN_IP}:${up.port}`, { host: LAN_IP, headers: { 'Proxy-Authorization': auth() } });
    await grpcCall(s, '/t.Echo/Unary', ['a']);
    s.destroy();
    const local = await h2cSession(proxy.port, `${LAN_IP}:${up.port}`);
    await grpcCall(local, '/t.Echo/Unary', ['b']);
    local.destroy();
    expect(up.connections).toBe(2);
    // closeLan drops the gate's sessions
    const pool = (proxy as unknown as { grpcPool: { size: number } }).grpcPool;
    expect(pool.size).toBe(2);
    await proxy.closeLan();
    await sleep(50);
    expect(pool.size).toBe(1);
  });
});
