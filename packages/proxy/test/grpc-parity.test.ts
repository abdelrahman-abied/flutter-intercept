// v0.11.0 (CONTRACTS §17): gRPC breakpoints, mutate through an injected codec, replay of recorded gRPC calls.
import { createHash } from 'crypto';
import * as http2 from 'http2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, GrpcProxyCodec, InterceptProxy, ReplayEntry, Rule } from '../src';
import { decodeGrpcMessage, grpcHookTesting, grpcTransformStats } from '../src/grpc';
import { lanIPv4Addresses, lanTesting } from '../src/lan';
import { randomBytes } from 'crypto';
import { nextExchange, sleep, startProxy, notesOf } from './helpers';
import { frame, grpcCall, h2cSession, startGrpcServer, type GrpcServer } from './grpc-helpers';
import { TEST_INTERNALS } from '../src/intercept-proxy';

const C = http2.constants;
const rule = (id: string, url: string, action: Rule['action']): Rule => ({ id, enabled: true, match: { url }, action });
const b64 = (s: string) => Buffer.from(s).toString('base64');
const text = (s: string | undefined) => Buffer.from(s ?? '', 'base64').toString();
const isGrpc = (path: string) => (e: Exchange) => e.kind === 'grpc' && e.url.endsWith(path);
const doneGrpc = (path: string) => (e: Exchange) => isGrpc(path)(e) && e.state !== 'pending' && !e.state.startsWith('paused');

function waitFor(proxy: InterceptProxy, pred: (e: Exchange) => boolean, timeoutMs = 10_000): Promise<Exchange> {
  const have = [...proxy.getExchanges()].reverse().find(pred);
  return have ? Promise.resolve(have) : nextExchange(proxy, pred, timeoutMs);
}

/** The next pause of a gRPC call (optionally a given kind / index). */
const paused = (proxy: InterceptProxy, pred: (e: Exchange) => boolean = () => true) =>
  waitFor(proxy, (e) => e.kind === 'grpc' && e.state.startsWith('paused') && !!e.grpcPause && pred(e));
const pausedMsg = (dir: 'send' | 'receive', index: number) => (e: Exchange) => e.grpcPause?.kind === 'message' && e.grpcPause.dir === dir && e.grpcPause.index === index;
const pausedStatus = (e: Exchange) => e.grpcPause?.kind === 'status';

let up: GrpcServer;
let proxy: InterceptProxy;
let session: http2.ClientHttp2Session;
let target: string;
beforeAll(async () => {
  up = await startGrpcServer();
  target = `127.0.0.1:${up.port}`;
});
afterAll(async () => {
  await up.close();
});
beforeEach(async () => {
  proxy = await startProxy({ breakpointTimeoutMs: 10_000 });
  session = await h2cSession(proxy.port, target);
});
afterEach(async () => {
  session.destroy();
  await proxy.stop();
  delete grpcHookTesting.hookCap;
  delete grpcHookTesting.heldTotalCap;
});

// ---------------------------------------------------------------- breakpoints (CONTRACTS §17.2)

describe('gRPC breakpoints', () => {
  it('request phase: the app’s message is held, edited, and the server gets the edit; frames say edited', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Unary', { kind: 'breakpoint', phase: 'request' })]);
    const call = grpcCall(session, '/t.Echo/Unary', ['hi']);
    const p = await paused(proxy, pausedMsg('send', 0));
    expect(p).toMatchObject({ state: 'paused-request', grpcPause: { kind: 'message', dir: 'send', index: 0, base64: b64('hi'), size: 2 } });
    expect(p.pauseDeadline).toBeGreaterThan(Date.now());
    expect(() => proxy.resume(p.id, { status: { code: 1 } })).toThrow(/paused at a message/);
    expect(() => proxy.resume(p.id, { message: 'not base64!' })).toThrow(/base64/);
    expect(() => proxy.resume(p.id, { messageJson: { a: 1 } })).toThrow(/encoded by the host/);
    proxy.resume(p.id, { message: b64('HI!') });
    const r = await call;
    expect(r.messages.map(String)).toEqual(['echo:HI!']);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.state).toBe('completed');
    expect(ex.grpcPause).toBeUndefined();
    expect(ex.frames?.find((f) => f.dir === 'send')).toMatchObject({ edited: true, base64: b64('HI!') });
    expect(ex.timings?.pausedMs).toBeGreaterThanOrEqual(0);
  });

  it('response phase: each server message, then the end of the call (status + trailers) can be edited', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Unary', { kind: 'breakpoint', phase: 'response' })]);
    const call = grpcCall(session, '/t.Echo/Unary', ['x']);
    const m = await paused(proxy, pausedMsg('receive', 0));
    expect(m.state).toBe('paused-response');
    expect(text(m.grpcPause?.kind === 'message' ? m.grpcPause.base64 : '')).toBe('echo:x');
    proxy.resume(m.id, { message: b64('changed') });
    const st = await paused(proxy, pausedStatus);
    expect(st.grpcPause).toEqual({ kind: 'status', code: 0, trailers: { 'x-custom-trailer': 'trail-v', 'x-bin-bin': 'AQID' } });
    expect(() => proxy.resume(st.id, { drop: true })).toThrow(/at its end/);
    expect(() => proxy.resume(st.id, { trailers: { 'grpc-status': '3' } })).toThrow(/grpc-status/);
    expect(() => proxy.resume(st.id, { status: { code: 17 } })).toThrow(/0–16/);
    proxy.resume(st.id, { status: { code: 5, message: 'nope ✗' }, trailers: { 'x-t': 'v' } });
    const r = await call;
    expect(r.messages.map(String)).toEqual(['changed']);
    expect(r.grpcStatus).toBe(5);
    expect(decodeGrpcMessage(r.grpcMessage)).toBe('nope ✗');
    expect(r.trailers?.['x-t']).toBe('v');
    expect(r.trailers?.['x-custom-trailer']).toBeUndefined();
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ state: 'completed', grpc: { statusCode: 5, statusMessage: 'nope ✗' } });
    expect(ex.responseTrailers).toMatchObject({ 'grpc-status': '5', 'x-t': 'v' });
  });

  it('a trailers-only answer is held as the end of the call and can be changed', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Fail', { kind: 'breakpoint', phase: 'response' })]);
    const call = grpcCall(session, '/t.Echo/Fail', ['x']);
    const st = await paused(proxy, pausedStatus);
    expect(st.grpcPause).toMatchObject({ kind: 'status', code: 14, message: 'upstream says no' });
    proxy.resume(st.id, { status: { code: 0 } });
    const r = await call;
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 0 });
    expect(r.grpcMessage).toBeUndefined();
  });

  it('server streaming: messages keep their order; drop one (recorded dropped, index unchanged); unedited resume', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/ServerStream', { kind: 'breakpoint', phase: 'response' })]);
    const call = grpcCall(session, '/t.Echo/ServerStream', ['3']);
    for (const i of [0, 1, 2]) {
      const p = await paused(proxy, pausedMsg('receive', i));
      expect(text(p.grpcPause?.kind === 'message' ? p.grpcPause.base64 : '')).toBe(`msg${i}`);
      proxy.resume(p.id, i === 1 ? { drop: true } : undefined);
    }
    proxy.resume((await paused(proxy, pausedStatus)).id);
    const r = await call;
    expect(r.messages.map(String)).toEqual(['msg0', 'msg2']);
    expect(r.grpcStatus).toBe(0);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/ServerStream'));
    const recv = ex.frames!.filter((f) => f.dir === 'receive');
    expect(recv.map((f) => [text(f.base64), !!f.dropped])).toEqual([
      ['msg0', false],
      ['msg1', true],
      ['msg2', false],
    ]);
    expect(ex.grpc?.messagesReceived).toBe(3);
  });

  it('bidi: while a server message is held, the app’s next message still reaches the server', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Bidi', { kind: 'breakpoint', phase: 'response' })]);
    const call = grpcCall(session, '/t.Echo/Bidi', ['b0', 'b1'], { gapMs: 100 });
    const p0 = await paused(proxy, pausedMsg('receive', 0));
    await sleep(250); // b1 was sent meanwhile; the server echoes it (held behind b0's echo)
    proxy.resume(p0.id);
    const p1 = await paused(proxy, pausedMsg('receive', 1));
    expect(text(p1.grpcPause?.kind === 'message' ? p1.grpcPause.base64 : '')).toBe('bidi:b1');
    proxy.resume(p1.id);
    proxy.resume((await paused(proxy, pausedStatus)).id);
    expect((await call).messages.map(String)).toEqual(['bidi:b0', 'bidi:b1']);
  });

  it('abort: RST_STREAM CANCEL to the app and the server; the exchange is aborted', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Slow', { kind: 'breakpoint', phase: 'request' })]);
    const call = grpcCall(session, '/t.Echo/Slow', ['x']);
    const p = await paused(proxy, pausedMsg('send', 0));
    proxy.abort(p.id);
    const r = await call;
    expect(r.rstCode).toBe(C.NGHTTP2_CANCEL);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Slow'));
    expect(ex).toMatchObject({ state: 'aborted', error: 'Aborted at a breakpoint.' });
    await sleep(100);
    expect(up.events).toContain('cancelled /t.Echo/Slow');
  });

  it('the app leaving while paused ends the pause; auto-resume after breakpointTimeoutMs', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Unary', { kind: 'breakpoint', phase: 'request' })]);
    const gone = grpcCall(session, '/t.Echo/Unary', ['x'], { deadlineMs: 300 });
    await paused(proxy, pausedMsg('send', 0));
    expect((await gone).rstCode).toBe(C.NGHTTP2_CANCEL);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.state).toBe('aborted');
    expect(ex.error).toMatch(/paused at a breakpoint/);
    const p2 = await startProxy({ breakpointTimeoutMs: 300 });
    try {
      p2.setRules([rule('bp', '*/t.Echo/Unary', { kind: 'breakpoint', phase: 'request' })]);
      const s2 = await h2cSession(p2.port, target);
      const r = await grpcCall(s2, '/t.Echo/Unary', ['auto']);
      s2.destroy();
      expect(r.messages.map(String)).toEqual(['echo:auto']);
      const e2 = await waitFor(p2, doneGrpc('/t.Echo/Unary'));
      expect(e2.timings?.pausedMs).toBeGreaterThanOrEqual(250);
    } finally {
      await p2.stop();
    }
  });

  it('caps: a message over 4 MB is forwarded unchanged with a note; over the total held cap, pauses are skipped', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Unary', { kind: 'breakpoint', phase: 'request' })]);
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 7);
    const r = await grpcCall(session, '/t.Echo/Unary', [big]);
    expect(r.messages[0].length).toBe(big.length + 5);
    let ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(notesOf(ex)).toMatch(/over 4 MB was forwarded unchanged/);
    expect(ex.frames?.find((f) => f.dir === 'send')).toMatchObject({ size: big.length, truncated: true });
    grpcHookTesting.heldTotalCap = 1;
    const r2 = await grpcCall(session, '/t.Echo/Unary', ['small']);
    expect(r2.messages.map(String)).toEqual(['echo:small']);
    ex = await waitFor(proxy, (e) => doneGrpc('/t.Echo/Unary')(e) && e.id !== ex.id);
    expect(notesOf(ex)).toMatch(/too much gRPC data is held right now/); // REVIEW-11 #4: refused when collecting starts
  });

  it('gzip messages are paused decompressed; an edit goes out uncompressed', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Gzip', { kind: 'breakpoint', phase: 'request' })]);
    const call = grpcCall(session, '/t.Echo/Gzip', ['zipped'], { gzip: true });
    const p = await paused(proxy, pausedMsg('send', 0));
    expect(text(p.grpcPause?.kind === 'message' ? p.grpcPause.base64 : '')).toBe('zipped');
    proxy.resume(p.id, { message: b64('plain') });
    expect((await call).messages.map(String)).toEqual(['gz:plain']);
  });

  it('fast path: calls without a breakpoint / mutate hook create no transform', async () => {
    const before = grpcTransformStats.created;
    await grpcCall(session, '/t.Echo/Unary', ['x']);
    await grpcCall(session, '/t.Echo/ServerStream', ['2']);
    expect(grpcTransformStats.created).toBe(before);
    proxy.setRules([rule('bp', '*/t.Echo/Unary', { kind: 'breakpoint', phase: 'both' })]);
    const call = grpcCall(session, '/t.Echo/Unary', ['x']);
    proxy.resume((await paused(proxy, pausedMsg('send', 0))).id);
    proxy.resume((await paused(proxy, pausedMsg('receive', 0))).id);
    proxy.resume((await paused(proxy, pausedStatus)).id);
    expect((await call).messages.map(String)).toEqual(['echo:x']);
    expect(grpcTransformStats.created).toBe(before + 2);
  });
});

// ---------------------------------------------------------------- mutate (CONTRACTS §17.3)

describe('gRPC mutate through the injected codec', () => {
  // The test server answers `echo:<request>`; this fake codec treats what follows "echo:" as JSON.
  const codec: GrpcProxyCodec = {
    decode(path, dir, bytes) {
      if (path !== '/t.Echo/Unary' || dir !== 'receive') return undefined;
      const s = Buffer.from(bytes).toString();
      try {
        return JSON.parse(s.replace(/^echo:/, ''));
      } catch {
        return undefined;
      }
    },
    encode(_path, _dir, json) {
      const j = json as { n?: unknown };
      if (j && typeof j.n === 'string') throw new Error('$.n: expected an int32, got a string');
      return Buffer.from(`echo:${JSON.stringify(json)}`);
    },
  };

  it('decode → applyOps → encode; the app gets the mutated message (frame edited)', async () => {
    proxy.setGrpcCodec(codec);
    proxy.setRules([rule('m', '*/t.Echo/Unary', { kind: 'mutate', ops: [{ path: '$.n', op: 'set', value: 2 }, { path: '$.gone', op: 'delete' }] })]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['{"n":1,"gone":true}']);
    expect(r.messages.map(String)).toEqual(['echo:{"n":2}']);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.frames?.find((f) => f.dir === 'receive')).toMatchObject({ edited: true, base64: b64('echo:{"n":2}') });
    expect(ex.simulated).toMatch(/^Mutated: \$\.n, \$\.gone/);
  });

  it('no codec / no schema / an encode error: the original goes out, with a note naming the path', async () => {
    proxy.setRules([rule('m', '*/t.Echo/*', { kind: 'mutate', ops: [{ path: '$.n', op: 'set', valueJson: '"42"' }] })]);
    let r = await grpcCall(session, '/t.Echo/Unary', ['{"n":1}']);
    expect(r.messages.map(String)).toEqual(['echo:{"n":1}']);
    let ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(notesOf(ex)).toMatch(/mutate: no schema for \/t\.Echo\/Unary/);
    proxy.setGrpcCodec(codec);
    r = await grpcCall(session, '/t.Echo/Unary', ['{"n":1}']);
    expect(r.messages.map(String)).toEqual(['echo:{"n":1}']);
    ex = await waitFor(proxy, (e) => doneGrpc('/t.Echo/Unary')(e) && e.id !== ex.id);
    expect(notesOf(ex)).toMatch(/mutate: \$\.n: expected an int32, got a string; the original message was forwarded/);
    const s = await grpcCall(session, '/t.Echo/ServerStream', ['1']);
    expect(s.messages.map(String)).toEqual(['msg0']);
    expect(notesOf(await waitFor(proxy, doneGrpc('/t.Echo/ServerStream')))).toMatch(/no schema for \/t\.Echo\/ServerStream/);
  });
});

// ---------------------------------------------------------------- replay (CONTRACTS §17.4)

describe('replay of recorded gRPC calls', () => {
  const sha = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');
  const entry = (path: string, out: { text: string; at: number }[], o: Partial<NonNullable<ReplayEntry['grpc']>> & { requestHash?: string; extra?: Partial<ReplayEntry> } = {}): ReplayEntry => ({
    kind: 'grpc',
    method: 'POST',
    url: `http://${target}${path}`,
    status: 200,
    headers: { 'content-type': 'application/grpc', 'x-rec': 'yes', 'grpc-encoding': 'gzip', ':status': '200' },
    frames: out.map((m) => ({ dir: 'receive' as const, at: m.at, kind: 'message' as const, size: m.text.length, base64: b64(m.text) })),
    grpc: { code: o.code ?? 0, ...(o.message ? { message: o.message } : {}), trailers: { 'x-rec-trailer': 't', 'grpc-status': '0' }, ...(o.requestHash ? { requestHash: o.requestHash } : {}) },
    ...o.extra,
  });

  it('answers like a grpcMock: headers, messages at their recorded gaps (≤ 5 s), status and trailers; never contacts the server', async () => {
    const before = up.events.length;
    proxy.setReplay([entry('/t.Echo/ServerStream', [{ text: 'r0', at: 1000 }, { text: 'r1', at: 1300 }, { text: 'r2', at: 99_000 }], { code: 7, message: 'recorded' })], { fallback: 'passthrough', name: 'rec' });
    const t0 = Date.now();
    const r = await grpcCall(session, '/t.Echo/ServerStream', ['3']);
    expect(r.headers?.['x-rec']).toBe('yes');
    expect(r.headers?.['grpc-encoding']).toBeUndefined();
    expect(r.messages.map(String)).toEqual(['r0', 'r1', 'r2']);
    expect(r.at[1] - r.at[0]).toBeGreaterThanOrEqual(250);
    expect(r.at[2] - r.at[1]).toBeGreaterThanOrEqual(4900); // capped at 5 s
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r).toMatchObject({ grpcStatus: 7, grpcMessage: 'recorded' });
    expect(r.trailers?.['x-rec-trailer']).toBe('t');
    expect(up.events.length).toBe(before);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/ServerStream'));
    expect(ex).toMatchObject({ state: 'mocked', simulated: 'Replayed from rec', grpc: { statusCode: 7, messagesReceived: 3 } });
  }, 15_000);

  it('several calls on one path: the first request message (requestHash) picks; else in order, then the last repeats', async () => {
    proxy.setReplay(
      [entry('/t.Echo/Unary', [{ text: 'for one', at: 0 }], { requestHash: sha('one') }), entry('/t.Echo/Unary', [{ text: 'for two', at: 0 }], { requestHash: sha('two') })],
      { fallback: 'passthrough' },
    );
    expect((await grpcCall(session, '/t.Echo/Unary', ['two'])).messages.map(String)).toEqual(['for two']);
    expect((await grpcCall(session, '/t.Echo/Unary', ['one'])).messages.map(String)).toEqual(['for one']);
    proxy.setReplay([entry('/t.Echo/ClientStream', [{ text: 'first', at: 0 }]), entry('/t.Echo/ClientStream', [{ text: 'second', at: 0 }])], { fallback: 'passthrough' });
    const got: string[] = [];
    for (let i = 0; i < 3; i++) got.push(...(await grpcCall(session, '/t.Echo/ClientStream', ['x'])).messages.map(String));
    expect(got).toEqual(['first', 'second', 'second']);
  });

  it('incomplete entries are never replayed; unmatched calls follow the fallback', async () => {
    proxy.setReplay(
      [
        entry('/t.Echo/Unary', [{ text: 'cut', at: 0 }], { extra: { incomplete: true } as Partial<ReplayEntry> }),
        { ...entry('/t.Echo/ClientStream', [{ text: 'big', at: 0 }]), frames: [{ dir: 'receive', at: 0, kind: 'message', size: 99_999, base64: b64('big'), truncated: true }] },
      ],
      { fallback: 'passthrough' },
    );
    expect((await grpcCall(session, '/t.Echo/Unary', ['real'])).messages.map(String)).toEqual(['echo:real']);
    expect((await grpcCall(session, '/t.Echo/ClientStream', ['a'])).messages.map(String)).toEqual(['a']);
    proxy.setReplay([], { fallback: 'fail' });
    const r = await grpcCall(session, '/t.Echo/Unary', ['x']);
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
  });
});

// ---------------------------------------------------------------- REVIEW-11 regressions

const internals = (p: InterceptProxy) => p[TEST_INTERNALS]();

describe('REVIEW-11', () => {
  it('#4 collected / held hook bytes stay within the budget; beyond it messages stream through with a note', async () => {
    grpcHookTesting.heldTotalCap = 10 * 1024 * 1024;
    proxy.setRules([rule('bp', '*/t.Echo/Unary', { kind: 'breakpoint', phase: 'request' })]);
    const size = 4 * 1024 * 1024 - 64;
    const streams: http2.ClientHttp2Stream[] = [];
    for (let i = 0; i < 8; i++) {
      const s = session.request({ ':method': 'POST', ':path': '/t.Echo/Unary', 'content-type': 'application/grpc', te: 'trailers' });
      s.on('error', () => undefined);
      s.write(frame(Buffer.alloc(size)).subarray(0, 5 + size - 1)); // never completes: nothing pauses
      streams.push(s);
    }
    await sleep(800);
    expect(internals(proxy).grpcHeld).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(internals(proxy).grpcHeld).toBeGreaterThan(0);
    expect(proxy.getExchanges().some((e) => notesOf(e).includes('too much gRPC data is held'))).toBe(true);
    for (const s of streams) s.close(C.NGHTTP2_CANCEL);
    await sleep(200);
    expect(internals(proxy).grpcHeld).toBe(0);
  });

  it('#5a a held message ends with its call when the server resets: pause settled, bytes freed, state error', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/ResetNow', { kind: 'breakpoint', phase: 'request' })]);
    const r = await grpcCall(session, '/t.Echo/ResetNow', [Buffer.alloc(1024 * 1024, 1)]);
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/ResetNow'));
    await sleep(10);
    expect(ex.state).toBe('error');
    expect(ex.grpcPause).toBeUndefined();
    expect(internals(proxy).paused.size).toBe(0);
    expect(internals(proxy).grpcHeld).toBe(0);
  });

  it('#5b a held trailers-only status honours the app’s cancel: aborted, nothing left paused', async () => {
    proxy.setRules([rule('bp', '*/t.Echo/Fail', { kind: 'breakpoint', phase: 'response' })]);
    const call = grpcCall(session, '/t.Echo/Fail', ['x'], { deadlineMs: 400 });
    await paused(proxy, pausedStatus);
    expect((await call).rstCode).toBe(C.NGHTTP2_CANCEL);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Fail'));
    expect(ex.state).toBe('aborted');
    expect(ex.grpcPause).toBeUndefined();
    expect(internals(proxy).paused.size).toBe(0);
  });

  it('#6 mutate: messages over 1 MB are not decoded; a call stops mutating after its codec budget', async () => {
    let calls = 0;
    proxy.setGrpcCodec({
      decode(_p, _d, bytes) {
        calls++;
        const until = Date.now() + 700;
        while (Date.now() < until) {
          /* a slow schema */
        }
        return { s: Buffer.from(bytes).toString() };
      },
      encode: (_p, _d, json) => Buffer.from(`m:${(json as { s: string }).s}`),
    });
    proxy.setRules([rule('m', '*/t.Echo/*', { kind: 'mutate', ops: [{ path: '$.x', op: 'set', value: 1 }] })]);
    const big = await grpcCall(session, '/t.Echo/Unary', [Buffer.alloc(1024 * 1024 + 10, 65)]);
    expect(big.messages[0].length).toBe(1024 * 1024 + 15);
    expect(calls).toBe(0);
    expect(notesOf(await waitFor(proxy, doneGrpc('/t.Echo/Unary')))).toMatch(/over 1 MB are forwarded unchanged/);
    const s = await grpcCall(session, '/t.Echo/ServerStream', ['5']);
    expect(calls).toBe(3); // 3 × 0.7 s > 2 s, then stopped
    expect(s.messages.map(String)).toEqual(['m:msg0', 'm:msg1', 'm:msg2', 'msg3', 'msg4']);
    expect(notesOf(await waitFor(proxy, doneGrpc('/t.Echo/ServerStream')))).toMatch(/mutate: stopped for this call/);
  }, 20_000);

  it('#7 replay never answers across origins (the fallback applies)', async () => {
    proxy.setReplay(
      [{ kind: 'grpc', method: 'POST', url: 'https://api.a.example/t.Echo/Unary', status: 200, headers: {}, frames: [{ dir: 'receive', at: 0, kind: 'message', size: 5, base64: b64('tokA!') }], grpc: { code: 0 } }],
      { fallback: 'passthrough' },
    );
    expect((await grpcCall(session, '/t.Echo/Unary', ['real'])).messages.map(String)).toEqual(['echo:real']);
    proxy.setReplay(
      [{ kind: 'grpc', method: 'POST', url: 'https://api.a.example/t.Echo/Unary', status: 200, headers: {}, frames: [], grpc: { code: 0 } }],
      { fallback: 'fail' },
    );
    expect(await grpcCall(session, '/t.Echo/Unary', ['x'])).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
  });
});

const LAN_IP = lanIPv4Addresses()[0];

describe.skipIf(!LAN_IP)('REVIEW-11 #7: the LAN deny rule comes before local gRPC answers', () => {
  it('a LAN client’s call to a forbidden target gets UNAVAILABLE, not the mock or the recording', async () => {
    const token = randomBytes(32).toString('base64url');
    const auth = `Basic ${Buffer.from(`flutter-intercept:${token}`).toString('base64')}`;
    const lanUp = await startGrpcServer({ host: LAN_IP });
    let checks = 0;
    lanTesting.allowTarget = (ip, port) => ip === LAN_IP && port === lanUp.port && ++checks === 1; // the gate's check only
    const p = await startProxy();
    try {
      const lanPort = (await p.openLan({ host: LAN_IP!, token })).port;
      p.setRules([rule('g', '*/t.Echo/Unary', { kind: 'grpcMock', messages: [b64('mocked')] })]);
      const s = await h2cSession(lanPort, `${LAN_IP}:${lanUp.port}`, { host: LAN_IP, headers: { 'Proxy-Authorization': auth } });
      const r = await grpcCall(s, '/t.Echo/Unary', ['x']);
      s.destroy();
      expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14, messages: [] });
      expect(decodeGrpcMessage(r.grpcMessage)).toMatch(/^Flutter Intercept: blocked a LAN client/);
      const ex = await waitFor(p, doneGrpc('/t.Echo/Unary'));
      expect(ex).toMatchObject({ state: 'error', viaLan: true });
    } finally {
      await p.stop();
      await lanUp.close();
      delete lanTesting.allowTarget;
    }
  });
});
