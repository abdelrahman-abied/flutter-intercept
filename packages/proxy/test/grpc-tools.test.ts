// v0.12.0 (CONTRACTS §18): rewrite, scripts, map remote and send() for gRPC calls.
import { randomBytes } from 'crypto';
import * as http2 from 'http2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, GrpcProxyCodec, InterceptProxy, Rule } from '../src';
import { grpcApplicable, grpcEditProblem, ruleProblem, targetsProxy } from '../src/rules';
import { mentionsGrpcHooks } from '../src/script';
import { tunnelTesting } from '../src/tunnel';
import * as dns from 'dns';
import { decodeGrpcMessage } from '../src/grpc';
import { lanIPv4Addresses, lanTesting } from '../src/lan';
import { nextExchange, sleep, startProxy, notesOf } from './helpers';
import { grpcCall, h2cSession, startGrpcServer, type GrpcServer } from './grpc-helpers';

const rule = (id: string, url: string, action: Rule['action']): Rule => ({ id, enabled: true, match: { url }, action });
const b64 = (s: string) => Buffer.from(s).toString('base64');
const text = (s: string | undefined) => Buffer.from(s ?? '', 'base64').toString();
const doneGrpc = (path: string) => (e: Exchange) => e.kind === 'grpc' && e.url.endsWith(path) && e.state !== 'pending' && !e.state.startsWith('paused');

function waitFor(proxy: InterceptProxy, pred: (e: Exchange) => boolean, timeoutMs = 10_000): Promise<Exchange> {
  const have = [...proxy.getExchanges()].reverse().find(pred);
  return have ? Promise.resolve(have) : nextExchange(proxy, pred, timeoutMs);
}

let up: GrpcServer;
let up2: GrpcServer;
let proxy: InterceptProxy;
let session: http2.ClientHttp2Session;
let target: string;
beforeAll(async () => {
  up = await startGrpcServer();
  up2 = await startGrpcServer();
  target = `127.0.0.1:${up.port}`;
});
afterAll(async () => {
  await up.close();
  await up2.close();
});
beforeEach(async () => {
  proxy = await startProxy();
  session = await h2cSession(proxy.port, target);
});
afterEach(async () => {
  session.destroy();
  await proxy.stop();
});

describe('rules for gRPC (unit)', () => {
  it('grpcApplicable: every action but cors and mock', () => {
    for (const a of [
      { kind: 'rewrite' },
      { kind: 'script', code: 'x' },
      { kind: 'mapRemote', to: 'http://x' },
      { kind: 'breakpoint', phase: 'both' },
      { kind: 'mutate', ops: [] },
      { kind: 'grpcMock' },
    ] as Rule['action'][]) {
      expect(grpcApplicable(a)).toBe(true);
    }
    expect(grpcApplicable({ kind: 'cors' })).toBe(false);
    expect(grpcApplicable({ kind: 'mock', status: 200, body: '' })).toBe(false);
  });

  it('ruleProblem refuses reserved metadata, CR/LF and non-base64 -bin values in rewrites', () => {
    const p = (action: Rule['action']) => ruleProblem({ match: { url: '*' }, action });
    expect(p({ kind: 'rewrite', request: { setHeaders: { 'grpc-timeout': '1S' } } })).toMatch(/grpc-timeout/);
    expect(p({ kind: 'rewrite', request: { removeHeaders: [':authority'] } })).toMatch(/pseudo/);
    expect(p({ kind: 'rewrite', response: { setHeaders: { 'grpc-status': '0' } } })).toMatch(/gRPC status/);
    expect(p({ kind: 'rewrite', response: { setTrailers: { 'content-type': 'x' } } })).toMatch(/content-type/);
    expect(p({ kind: 'rewrite', response: { removeTrailers: ['grpc-message'] } })).toMatch(/grpc-message/);
    expect(p({ kind: 'rewrite', response: { setTrailers: { 'x-a': 'b\r\nc' } } })).toMatch(/one line/);
    expect(p({ kind: 'rewrite', response: { setTrailers: { 'x-data-bin': 'not base64!' } } })).toMatch(/base64/);
    expect(p({ kind: 'rewrite', request: { setHeaders: { 'x-a': 'b', 'x-c-bin': 'AQI=' } }, response: { setTrailers: { 'x-t': 'v' }, removeTrailers: ['x-u'] } })).toBeUndefined();
    // HTTP rewrites of content-type stay valid
    expect(p({ kind: 'rewrite', response: { setHeaders: { 'content-type': 'text/plain' } } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------- rewrite (CONTRACTS §18.1)

describe('rewrite on gRPC calls', () => {
  it('request / response metadata and trailers; reserved names skipped with a note', async () => {
    proxy.setRules([
      rule('rw', '*/t.Echo/Unary', {
        kind: 'rewrite',
        request: { setHeaders: { 'x-added': 'yes', 'content-type': 'text/plain' }, removeHeaders: ['x-req-meta'] },
        response: { setHeaders: { 'x-new': 'n' }, removeHeaders: ['x-custom-header'], setTrailers: { 'x-t2': 'v2' }, removeTrailers: ['x-custom-trailer'] },
      }),
    ]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['hi'], { metadata: { 'x-req-meta': 'gone' } });
    expect(r.messages.map(String)).toEqual(['echo:hi']);
    const seen = up.seen.at(-1)!;
    expect(seen['x-added']).toBe('yes');
    expect(seen['x-req-meta']).toBeUndefined();
    expect(seen['content-type']).toBe('application/grpc');
    expect(r.headers?.['x-new']).toBe('n');
    expect(r.headers?.['x-custom-header']).toBeUndefined();
    expect(r.trailers).toMatchObject({ 'grpc-status': '0', 'x-t2': 'v2', 'x-bin-bin': 'AQID' });
    expect(r.trailers?.['x-custom-trailer']).toBeUndefined();
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.simulated).toBe('Rewritten: metadata');
    expect(ex.requestHeaders['x-added']).toBe('yes');
    expect(ex.responseTrailers?.['x-t2']).toBe('v2');
    expect(notesOf(ex)).toMatch(/"content-type" can't be changed on a gRPC call/);
  });

  it('a trailers-only answer gets the trailer changes in its one frame; replaceBody / status are noted, metadata still applied', async () => {
    proxy.setRules([
      rule('rw', '*/t.Echo/Fail', {
        kind: 'rewrite',
        request: { replaceBody: [{ find: 'a', replace: 'b' }] },
        response: { status: 500, setTrailers: { 'x-t': 'only' } },
      }),
    ]);
    const r = await grpcCall(session, '/t.Echo/Fail', ['x']);
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    expect(r.headers?.['x-t']).toBe('only');
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Fail'));
    expect(notesOf(ex)).toMatch(/body replacements and the status don't apply to gRPC calls/);
  });
});

// ---------------------------------------------------------------- scripts (CONTRACTS §18.2)

describe('script hooks on gRPC calls', () => {
  const codec: GrpcProxyCodec = {
    decode: (path, dir, bytes) => (path === '/t.Echo/Unary' && dir === 'receive' ? { text: Buffer.from(bytes).toString() } : undefined),
    encode(_p, _d, json) {
      const j = json as { text?: unknown };
      if (typeof j?.text !== 'string') throw new Error('$.text: expected a string');
      return Buffer.from(j.text);
    },
  };
  const script = (code: string): Rule => rule('s', '*/t.Echo/*', { kind: 'script', code });

  it('onGrpcMessage: both directions, {base64} / {json} via the codec; HTTP hooks are not called', async () => {
    proxy.setGrpcCodec(codec);
    proxy.setRules([
      script(`
        function onRequest(r, c) { c.log('http hook ran'); }
        function onGrpcMessage(m, c) {
          c.log(m.path, m.dir, m.index, m.size, m.json ? 'json' : 'raw');
          if (m.dir === 'send') return { base64: 'U0NSSVBURUQ=' }; // "SCRIPTED"
          return { json: { text: m.json.text + '!' } };
        }`),
    ]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['hi']);
    expect(r.messages.map(String)).toEqual(['echo:SCRIPTED!']);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.scriptLog).toEqual(['/t.Echo/Unary send 0 2 raw', '/t.Echo/Unary receive 0 13 json']);
    expect(ex.frames?.map((f) => [f.dir, text(f.base64), !!f.edited])).toEqual([
      ['send', 'SCRIPTED', true],
      ['receive', 'echo:SCRIPTED!', true],
    ]);
  });

  it('onGrpcMessage: drop, a throw, a timeout and an encode error all leave the original (logged)', async () => {
    proxy.setGrpcCodec(codec);
    proxy.setRules([
      script(`
        function onGrpcMessage(m) {
          if (m.dir === 'receive' && m.index === 1) return { drop: true };
          if (m.dir === 'receive' && m.index === 2) throw new Error('boom');
          if (m.dir === 'receive' && m.index === 3) { for (;;) {} }
        }`),
    ]);
    const s = await grpcCall(session, '/t.Echo/ServerStream', ['5']);
    expect(s.messages.map(String)).toEqual(['msg0', 'msg2', 'msg3', 'msg4']);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/ServerStream'));
    expect(ex.frames?.filter((f) => f.dir === 'receive').map((f) => [text(f.base64), !!f.dropped])).toEqual([
      ['msg0', false],
      ['msg1', true],
      ['msg2', false],
      ['msg3', false],
      ['msg4', false],
    ]);
    const log = (ex.scriptLog ?? []).join('\n');
    expect(log).toMatch(/onGrpcMessage: Error: boom; the original message was sent/);
    expect(log).toMatch(/timed out/);
    proxy.setRules([script(`function onGrpcMessage(m) { if (m.dir === 'receive') return { json: { text: 5 } }; }`)]);
    expect((await grpcCall(session, '/t.Echo/Unary', ['x'])).messages.map(String)).toEqual(['echo:x']);
    const e2 = await waitFor(proxy, (e) => doneGrpc('/t.Echo/Unary')(e));
    expect((e2.scriptLog ?? []).join('\n')).toMatch(/\$\.text: expected a string/);
  }, 20_000);

  it('onGrpcStatus: code, message and trailers changed (trailers-only too); invalid returns are logged', async () => {
    proxy.setRules([
      script(`function onGrpcStatus(s, c) {
        c.log(s.path, s.code, s.message || '-', Object.keys(s.trailers).join(','));
        if (s.code === 14) return { code: 0 };
        return { code: 5, message: 'scripted ✓', trailers: { 'x-s': '1' } };
      }`),
    ]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['x']);
    expect(r.messages.map(String)).toEqual(['echo:x']); // no onGrpcMessage: messages untouched
    expect(r.grpcStatus).toBe(5);
    expect(decodeGrpcMessage(r.grpcMessage)).toBe('scripted ✓');
    expect(r.trailers?.['x-s']).toBe('1');
    expect(r.trailers?.['x-custom-trailer']).toBeUndefined();
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex.scriptLog).toEqual(['/t.Echo/Unary 0 - x-custom-trailer,x-bin-bin']);
    expect(ex.grpc).toMatchObject({ statusCode: 5, statusMessage: 'scripted ✓' });
    const f = await grpcCall(session, '/t.Echo/Fail', ['x']);
    expect(f).toMatchObject({ trailersOnly: true, grpcStatus: 0 });
    proxy.setRules([script(`function onGrpcStatus() { return { code: 99 }; }`)]);
    expect((await grpcCall(session, '/t.Echo/Unary', ['y'])).grpcStatus).toBe(0);
    const e3 = await waitFor(proxy, (e) => doneGrpc('/t.Echo/Unary')(e) && e.id !== ex.id);
    expect((e3.scriptLog ?? []).join('\n')).toMatch(/must be 0–16, got 99.*the original status was sent/);
  });
});

// ---------------------------------------------------------------- map remote (CONTRACTS §18.3)

describe('map remote on gRPC calls', () => {
  it('goes to the mapped server; :authority is the new host unless preserveHost; the exchange keeps the app URL', async () => {
    const before = up.events.length;
    proxy.setRules([rule('m', '*/t.Echo/Unary', { kind: 'mapRemote', to: `http://127.0.0.1:${up2.port}` })]);
    expect((await grpcCall(session, '/t.Echo/Unary', ['mapped'])).messages.map(String)).toEqual(['echo:mapped']);
    expect(up.events.length).toBe(before);
    expect(up2.seen.at(-1)?.[':authority']).toBe(`127.0.0.1:${up2.port}`);
    const ex = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    expect(ex).toMatchObject({ url: `http://${target}/t.Echo/Unary`, simulated: `Mapped to http://127.0.0.1:${up2.port}`, state: 'completed' });
    proxy.setRules([rule('m', '*/t.Echo/Unary', { kind: 'mapRemote', to: `http://127.0.0.1:${up2.port}`, preserveHost: true })]);
    await grpcCall(session, '/t.Echo/Unary', ['p']);
    expect(up2.seen.at(-1)?.[':authority']).toBe(target);
  });

  it('a prefix target rewrites :path; an unusable target answers UNAVAILABLE', async () => {
    proxy.setRules([rule('m', `http://${target}/t.Echo/*`, { kind: 'mapRemote', to: `http://127.0.0.1:${up2.port}/t.Echo/` })]);
    expect((await grpcCall(session, '/t.Echo/ClientStream', ['a', 'b'])).messages.map(String)).toEqual(['a+b']);
    expect(up2.seen.at(-1)?.[':path']).toBe('/t.Echo/ClientStream');
    proxy.setRules([rule('m', '*/t.Echo/Unary', { kind: 'mapRemote', to: 'ftp://elsewhere.example' })]);
    const r = await grpcCall(session, '/t.Echo/Unary', ['x']);
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    expect(decodeGrpcMessage(r.grpcMessage)).toMatch(/^Flutter Intercept: Map Remote rule/);
  });
});

// ---------------------------------------------------------------- send (CONTRACTS §18.4)

describe('send() for gRPC', () => {
  const send = (o: { path: string; messages?: string[]; headers?: Record<string, string>; resentFrom?: string; extra?: object }) =>
    proxy.send({ method: 'POST', url: `http://${target}${o.path}`, initiator: 'editor', headers: o.headers, ...(o.resentFrom ? { resentFrom: o.resentFrom } : {}), grpc: { messages: o.messages ?? [], ...o.extra } } as never);

  it('unary, client streaming (all then half-close) and server streaming; recorded with initiator / resentFrom', async () => {
    await grpcCall(session, '/t.Echo/Unary', ['orig']);
    const orig = await waitFor(proxy, doneGrpc('/t.Echo/Unary'));
    const { id } = await send({ path: '/t.Echo/Unary', messages: [b64('hello')], headers: { 'x-req-meta': 'm', 'content-type': 'text/x' }, resentFrom: orig.id });
    let ex = await waitFor(proxy, (e) => e.id === id && e.state !== 'pending');
    expect(ex).toMatchObject({ kind: 'grpc', state: 'completed', initiator: 'editor', resentFrom: orig.id, grpc: { statusCode: 0, messagesSent: 1, messagesReceived: 1, deadlineMs: 60000 } });
    expect(JSON.stringify(ex.requestHeaders)).not.toMatch(/x-fi-send|flutter-intercept/i);
    expect(ex.frames?.map((f) => [f.dir, text(f.base64)])).toEqual([
      ['send', 'hello'],
      ['receive', 'echo:hello'],
    ]);
    expect(ex.responseTrailers?.['x-custom-trailer']).toBe('trail-v');
    const seen = up.seen.at(-1)!;
    expect(seen).toMatchObject({ 'content-type': 'application/grpc', te: 'trailers', 'grpc-timeout': '60S', 'x-req-meta': 'm' });
    const c = await send({ path: '/t.Echo/ClientStream', messages: ['a', 'b', 'c'].map(b64) });
    ex = await waitFor(proxy, (e) => e.id === c.id && e.state !== 'pending');
    expect(text(ex.frames?.find((f) => f.dir === 'receive')?.base64)).toBe('a+b+c');
    const s = await send({ path: '/t.Echo/ServerStream', messages: [b64('3')] });
    ex = await waitFor(proxy, (e) => e.id === s.id && e.state !== 'pending');
    expect(ex.frames?.filter((f) => f.dir === 'receive').map((f) => text(f.base64))).toEqual(['msg0', 'msg1', 'msg2']);
    expect(ex.responseTrailers?.['x-stream-trailer']).toBe('done');
  });

  it('a given grpc-timeout is the deadline (the call is cancelled like the app would)', async () => {
    const { id } = await send({ path: '/t.Echo/Slow', messages: [b64('x')], headers: { 'grpc-timeout': '200m' } });
    const ex = await waitFor(proxy, (e) => e.id === id && e.state !== 'pending');
    expect(ex.state).toBe('aborted');
    expect(ex.error).toMatch(/deadline \(200 ms\)/);
    await sleep(100);
    expect(up.events).toContain('cancelled /t.Echo/Slow');
  });

  it('caps and refusals', async () => {
    await expect(send({ path: '/t.Echo/Unary', messages: Array.from({ length: 101 }, () => '') })).rejects.toThrow(/At most 100 messages/);
    await expect(send({ path: '/t.Echo/Unary', messages: [Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')] })).rejects.toThrow(/over 4 MB/);
    await expect(send({ path: '/t.Echo/Unary', messages: Array.from({ length: 5 }, () => Buffer.alloc(4 * 1024 * 1024).toString('base64')) })).rejects.toThrow(/16 MB in total/);
    await expect(send({ path: '/t.Echo/Unary', messages: ['not base64!'] })).rejects.toThrow(/not base64/);
    await expect(send({ path: '/t.Echo/Unary', extra: { messagesJson: [{}] } })).rejects.toThrow(/encoded by the host/);
    await expect(send({ path: '/not-a-method' })).rejects.toThrow(/Not a gRPC method URL/);
    await expect(proxy.send({ method: 'GET', url: `http://${target}/t.Echo/Unary`, initiator: 'agent', grpc: { messages: [] } })).rejects.toThrow(/POST/);
    await expect(send({ path: '/t.Echo/Unary', resentFrom: 'evicted-or-unknown' })).rejects.toThrow(/no longer recorded/);
  });

  it('REVIEW-12 #2: rules, the network profile and replay apply to sent calls like to the app’s', async () => {
    const sent = async (path: string, messages = [b64('s')]) => {
      const { id } = await send({ path, messages });
      return waitFor(proxy, (e) => e.id === id && e.state !== 'pending' && !e.state.startsWith('paused'));
    };
    const before = up.events.length;
    proxy.setRules([rule('b', '*/t.Echo/Unary', { kind: 'block', mode: 'status' })]);
    expect(await sent('/t.Echo/Unary')).toMatchObject({ state: 'blocked', matchedRuleId: 'b', grpc: { statusCode: 14 } });
    proxy.setRules([]);
    proxy.setNetworkProfile({ kind: 'offline' });
    expect(await sent('/t.Echo/Unary')).toMatchObject({ state: 'blocked', simulated: 'Offline', grpc: { statusCode: 14, statusMessage: 'DNS lookup failed' } });
    proxy.setNetworkProfile({ kind: 'none' });
    proxy.setReplay([], { fallback: 'fail' });
    expect(await sent('/t.Echo/Unary')).toMatchObject({ state: 'blocked', grpc: { statusCode: 14 } });
    proxy.setReplay(undefined);
    expect(up.events.length).toBe(before); // none of these reached the server
    proxy.setRules([rule('m', '*/t.Echo/Unary', { kind: 'mapRemote', to: `http://127.0.0.1:${up2.port}` })]);
    const m = await sent('/t.Echo/Unary', [b64('mapped')]);
    expect(m).toMatchObject({ state: 'completed', simulated: `Mapped to http://127.0.0.1:${up2.port}` });
    expect(up.events.length).toBe(before);
    proxy.setGrpcCodec({ decode: (_p, d, b) => (d === 'receive' ? { t: Buffer.from(b).toString() } : undefined), encode: (_p, _d, j) => Buffer.from(`${(j as { t: string }).t}!`) });
    proxy.setRules([rule('mu', '*/t.Echo/Unary', { kind: 'mutate', ops: [{ path: '$.x', op: 'set', value: 1 }] })]);
    const mu = await sent('/t.Echo/Unary', [b64('q')]);
    expect(text(mu.frames?.find((f) => f.dir === 'receive')?.base64)).toBe('echo:q!');
  });
});

// ---------------------------------------------------------------- LAN guard (CONTRACTS §18.5)

const LAN_IP = lanIPv4Addresses()[0];

describe.skipIf(!LAN_IP)('LAN guard on map remote and send', () => {
  it('map remote to a forbidden target is refused before any connection; a resend of a LAN call too', async () => {
    const token = randomBytes(32).toString('base64url');
    const auth = `Basic ${Buffer.from(`flutter-intercept:${token}`).toString('base64')}`;
    const lanUp = await startGrpcServer({ host: LAN_IP });
    lanTesting.allowTarget = (ip, port) => ip === LAN_IP && port === lanUp.port;
    const p = await startProxy();
    try {
      const lanPort = (await p.openLan({ host: LAN_IP!, token })).port;
      const s = await h2cSession(lanPort, `${LAN_IP}:${lanUp.port}`, { host: LAN_IP, headers: { 'Proxy-Authorization': auth } });
      // allowed: relayed
      expect((await grpcCall(s, '/t.Echo/Unary', ['ok'])).messages.map(String)).toEqual(['echo:ok']);
      const lanEx = await waitFor(p, doneGrpc('/t.Echo/Unary'));
      expect(lanEx.viaLan).toBe(true);
      // map remote to this machine's loopback: refused, nothing contacted
      const before = up.events.length;
      p.setRules([rule('m', '*/t.Echo/ClientStream', { kind: 'mapRemote', to: `http://127.0.0.1:${up.port}` })]);
      const r = await grpcCall(s, '/t.Echo/ClientStream', ['x']);
      s.destroy();
      expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
      expect(decodeGrpcMessage(r.grpcMessage)).toMatch(/blocked a LAN client/);
      expect(up.events.length).toBe(before);
      // resend of the LAN call: to a loopback target refused, to the allowed one fine
      await expect(p.send({ method: 'POST', url: `http://127.0.0.1:${up.port}/t.Echo/Unary`, initiator: 'agent', resentFrom: lanEx.id, grpc: { messages: [b64('x')] } })).rejects.toThrow(/blocked a LAN client/);
      const again = await p.send({ method: 'POST', url: lanEx.url, initiator: 'agent', resentFrom: lanEx.id, grpc: { messages: [b64('again')] } });
      const ex = await waitFor(p, (e) => e.id === again.id && e.state !== 'pending');
      expect(ex).toMatchObject({ state: 'completed', viaLan: true });
      await p.closeLan();
      await expect(p.send({ method: 'POST', url: lanEx.url, initiator: 'agent', resentFrom: lanEx.id, grpc: { messages: [b64('x')] } })).rejects.toThrow(/LAN mode is off/);
      expect(up.events.length).toBe(before);
    } finally {
      await p.stop();
      await lanUp.close();
      delete lanTesting.allowTarget;
    }
  });
});

// ---------------------------------------------------------------- REVIEW-12 #1: no relay loops

describe('REVIEW-12 #1: gRPC calls never relay to the proxy itself', () => {
  const settle = async () => {
    await sleep(500);
    return proxy.getExchanges().filter((e) => e.kind === 'grpc');
  };

  it('a direct h2c call to the proxy port: one exchange, 14 "would loop back"', async () => {
    const direct = http2.connect(`http://127.0.0.1:${proxy.port}`);
    direct.on('error', () => undefined);
    const r = await grpcCall(direct, '/t.S/M', ['x']);
    direct.destroy();
    expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
    expect(decodeGrpcMessage(r.grpcMessage)).toBe('Flutter Intercept: the call would loop back to the proxy');
    const all = await settle();
    expect(all.length).toBe(1);
    expect(all[0]).toMatchObject({ state: 'error', error: 'Flutter Intercept: the call would loop back to the proxy' });
  });

  it('a Map Remote rule to 127.0.0.1:<proxy port> (or an emulator alias): one exchange; the pure helper flags such targets', async () => {
    expect(targetsProxy(`http://127.0.0.1:${proxy.port}`, [proxy.port])).toBe(true);
    expect(targetsProxy(`http://localhost:${proxy.port}/x`, [proxy.port])).toBe(true);
    expect(targetsProxy(`http://10.0.2.2:${proxy.port}`, [proxy.port])).toBe(true);
    expect(targetsProxy(`http://127.0.0.1:${proxy.port + 1}`, [proxy.port])).toBe(false);
    expect(targetsProxy('https://api.example.com', [443])).toBe(false);
    expect(proxy.targetsProxy(`http://[::1]:${proxy.port}`)).toBe(true);
    for (const to of [`http://127.0.0.1:${proxy.port}`, `http://10.0.2.2:${proxy.port}`]) {
      proxy.clear();
      proxy.setRules([rule('m', '*/t.Echo/*', { kind: 'mapRemote', to })]);
      const r = await grpcCall(session, '/t.Echo/Unary', ['x']);
      expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
      expect((await settle()).length).toBe(1);
    }
  });

  it('a name that resolves to this machine on the proxy port is caught when the socket connects: one exchange', async () => {
    tunnelTesting.lookup = ((host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
      const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
      if (host === 'loops-here.example.test') return all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
      return dns.lookup(host, opts as dns.LookupOptions, cb as never);
    }) as never;
    try {
      expect(proxy.targetsProxy(`http://loops-here.example.test:${proxy.port}`)).toBe(false); // not visible before DNS
      proxy.setRules([rule('m', '*/t.Echo/*', { kind: 'mapRemote', to: `http://loops-here.example.test:${proxy.port}` })]);
      const r = await grpcCall(session, '/t.Echo/Unary', ['x']);
      expect(r).toMatchObject({ trailersOnly: true, grpcStatus: 14 });
      expect(decodeGrpcMessage(r.grpcMessage)).toBe('Flutter Intercept: the call would loop back to the proxy');
      const all = await settle();
      expect(all.length).toBe(1);
      expect(all[0]).toMatchObject({ state: 'error', error: 'Flutter Intercept: the call would loop back to the proxy' });
    } finally {
      delete tunnelTesting.lookup;
    }
  });

  it('real servers never see a marker of ours (relay, send, map remote)', async () => {
    await grpcCall(session, '/t.Echo/Unary', ['x']);
    await proxy.send({ method: 'POST', url: `http://${target}/t.Echo/Unary`, initiator: 'agent', grpc: { messages: [b64('s')] } });
    await sleep(200);
    proxy.setRules([rule('m', '*/t.Echo/*', { kind: 'mapRemote', to: `http://127.0.0.1:${up2.port}` })]);
    await grpcCall(session, '/t.Echo/Unary', ['m']);
    for (const h of [...up.seen, ...up2.seen]) expect(JSON.stringify(h)).not.toMatch(/flutter-intercept|x-fi-/i);
  });
});

describe('REVIEW-12 INFO items', () => {
  it('hook detection ignores comments; status messages are capped at 1 KB; a sent grpc-timeout is clamped to 1 h', async () => {
    expect(mentionsGrpcHooks('// function onGrpcMessage(m) {}\n/* onGrpcStatus */ function onRequest() {}')).toEqual({ message: false, status: false });
    expect(mentionsGrpcHooks("const u = 'http://x'; function onGrpcStatus(s) {}")).toEqual({ message: false, status: true });
    expect(grpcEditProblem('status', { status: { code: 1, message: 'x'.repeat(1025) } })).toMatch(/over 1 KB/);
    const { id } = await proxy.send({ method: 'POST', url: `http://${target}/t.Echo/Unary`, initiator: 'agent', headers: { 'grpc-timeout': '99999999H' }, grpc: { messages: [b64('t')] } });
    const ex = await waitFor(proxy, (e) => e.id === id && e.state !== 'pending');
    expect(ex.state).toBe('completed');
    expect(up.seen.at(-1)?.['grpc-timeout']).toBe('1H');
  });
});
