// WebSocket recording (CONTRACTS §11.1): Node `ws` clients for the details, and a REAL dart:io WebSocket
// (test/fixtures/ws_client.dart) over ws:// and wss:// with the install-CA trust of the generated entry.
import { execFile, execFileSync } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import { generateCACertificate } from 'mockttp';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy, InterceptProxyOptions } from '../src';
import { nextExchange, selfSignedCert, sleep, startProxy } from './helpers';

interface WsUpstream {
  wsUrl: string;
  wssUrl: string;
  /** Upgrade requests seen: path + headers. */
  upgrades: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

async function startWsUpstream(): Promise<WsUpstream> {
  const { key, cert } = await selfSignedCert();
  const h = http.createServer((_q, r) => r.writeHead(404).end());
  const s = https.createServer({ key, cert }, (_q, r) => r.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  const upgrades: WsUpstream['upgrades'] = [];
  wss.on('connection', (ws) => {
    ws.send('welcome');
    ws.on('message', (data, isBinary) => {
      const buf = data as Buffer;
      if (isBinary) return ws.send(Buffer.from([...buf].reverse()), { binary: true });
      const t = buf.toString('utf8');
      if (t === 'close-me') return ws.close(4002, 'server bye');
      if (t === 'kill') return ws.terminate();
      if (t === 'big') return ws.send('x'.repeat(100_000));
      if (t.startsWith('bigs:')) {
        for (let i = 0; i < Number(t.slice(5)); i++) ws.send(`${i}:${'y'.repeat(100_000)}`);
        return;
      }
      if (t.startsWith('many:')) {
        for (let i = 0; i < Number(t.slice(5)); i++) ws.send(`m${i}`);
        return;
      }
      ws.send(`echo:${t}`);
    });
  });
  const onUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    upgrades.push({ url: req.url ?? '', headers: req.headers });
    if (req.url === '/refuse') {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nnope');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  h.on('upgrade', onUpgrade);
  s.on('upgrade', onUpgrade);
  h.listen(0, '127.0.0.1');
  s.listen(0, '127.0.0.1');
  await Promise.all([once(h, 'listening'), once(s, 'listening')]);
  return {
    wsUrl: `ws://127.0.0.1:${(h.address() as AddressInfo).port}`,
    wssUrl: `wss://localhost:${(s.address() as AddressInfo).port}`,
    upgrades,
    async close() {
      for (const c of wss.clients) c.terminate();
      h.closeAllConnections();
      s.closeAllConnections();
      await Promise.all([new Promise((r) => h.close(r)), new Promise((r) => s.close(r))]);
    },
  };
}

/** A `ws` client through the proxy: a relative-path upgrade on a plain connection, or inside a CONNECT tunnel. */
async function wsViaProxy(proxyPort: number, url: string, headers: Record<string, string> = {}, extra: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  const u = new URL(url);
  if (u.protocol === 'ws:') {
    const ws = new WebSocket(url, { headers, ...extra, createConnection: () => net.connect(proxyPort, '127.0.0.1') } as WebSocket.ClientOptions);
    ws.on('error', () => undefined); // tests that expect failures look at the exchange
    return ws;
  }
  const connect = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${u.hostname}:${u.port}`, agent: false });
  connect.end();
  const [, socket] = (await once(connect, 'connect')) as [http.IncomingMessage, net.Socket];
  const tlsSocket = tls.connect({ socket, servername: u.hostname, rejectUnauthorized: false });
  return new WebSocket(url, { headers, rejectUnauthorized: false, createConnection: () => tlsSocket } as WebSocket.ClientOptions);
}

/** Collect messages until `n` arrived. */
function messages(ws: WebSocket, n: number): Promise<string[]> {
  const got: string[] = [];
  return new Promise((resolve, reject) => {
    ws.on('message', (d, isBinary) => {
      got.push(isBinary ? `bin:${[...(d as Buffer)].join(',')}` : (d as Buffer).toString());
      if (got.length === n) resolve(got);
    });
    ws.on('error', reject);
  });
}

const finished = (id?: string) => (e: Exchange) => e.kind === 'websocket' && e.state !== 'pending' && (id === undefined || e.id === id);

let up: WsUpstream;
let proxy: InterceptProxy;
const opts: { extra?: Partial<InterceptProxyOptions> } = {};

beforeAll(async () => {
  up = await startWsUpstream();
});
afterAll(async () => {
  await up?.close();
});
beforeEach(async () => {
  proxy = await startProxy(opts.extra);
  up.upgrades.length = 0;
});
afterEach(async () => {
  await proxy.stop();
  opts.extra = undefined;
});

describe('WebSocket recording (Node client)', () => {
  it('records the upgrade and messages both ways, in order; pending while open, completed on a clean close', async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/chat?room=1`, { 'x-app': 'demo' });
    const welcome = once(ws, 'message');
    const got = messages(ws, 3);
    const open = nextExchange(proxy, (e) => e.kind === 'websocket' && e.state === 'pending' && (e.frames?.length ?? 0) >= 4);
    await welcome;
    ws.send('hello');
    ws.send(Buffer.from([1, 2, 3]));
    await got;
    const pending = await open;
    expect(pending).toMatchObject({ kind: 'websocket', method: 'GET', url: `${up.wsUrl}/chat?room=1`, status: 101, state: 'pending' });
    expect(pending.requestHeaders['x-app']).toBe('demo');
    expect(pending.responseHeaders?.upgrade).toMatch(/websocket/i);
    const done = nextExchange(proxy, finished());
    ws.send('close-me');
    const [code, reason] = (await once(ws, 'close')) as [number, Buffer];
    expect([code, reason.toString()]).toEqual([4002, 'server bye']);
    const ex = await done;
    expect(ex.state).toBe('completed');
    expect(ex.frames!.map((f) => [f.dir, f.kind, f.text ?? f.base64 ?? '', f.size, f.closeCode])).toEqual([
      ['receive', 'text', 'welcome', 7, undefined],
      ['send', 'text', 'hello', 5, undefined],
      ['send', 'binary', 'AQID', 3, undefined],
      ['receive', 'text', 'echo:hello', 10, undefined],
      ['receive', 'binary', 'AwIB', 3, undefined],
      ['send', 'text', 'close-me', 8, undefined],
      ['receive', 'close', 'server bye', 12, 4002],
    ]);
    for (let i = 1; i < ex.frames!.length; i++) expect(ex.frames![i].at).toBeGreaterThanOrEqual(ex.frames![i - 1].at);
    expect(ex.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('client-initiated close: a send close frame with its code', async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/c`);
    await once(ws, 'message');
    const done = nextExchange(proxy, finished());
    ws.close(4001, 'bye');
    await once(ws, 'close');
    const ex = await done;
    expect(ex.state).toBe('completed');
    expect(ex.frames!.at(-1)).toMatchObject({ dir: 'send', kind: 'close', closeCode: 4001, text: 'bye' });
  });

  it('records pings and pongs with their payload', async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/p`);
    await once(ws, 'message');
    ws.ping('p1');
    await once(ws, 'pong');
    await sleep(50);
    const done = nextExchange(proxy, finished());
    ws.close(1000);
    const ex = await done;
    expect(ex.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dir: 'send', kind: 'ping', text: 'p1', size: 2 }),
        expect.objectContaining({ dir: 'receive', kind: 'pong', text: 'p1', size: 2 }),
      ]),
    );
  });

  it("an abnormal close by the server (no close frame) is an error, even though the app gets a clean-looking close", async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/k`);
    await once(ws, 'message');
    const done = nextExchange(proxy, finished());
    ws.send('kill');
    await once(ws, 'close');
    const ex = await done;
    expect(ex.state).toBe('error');
    expect(ex.error).toMatch(/server.*without a close frame.*1006/);
  });

  it('an app that disappears (socket destroyed) ends the exchange as an error', async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/gone`);
    await once(ws, 'message');
    const done = nextExchange(proxy, finished());
    ws.terminate();
    const ex = await done;
    expect(ex.state).toBe('error');
    expect(ex.error).toMatch(/app.*1006/);
  });

  it('payloads over 64 KB are cut (truncated, full size kept)', async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/big`);
    await once(ws, 'message');
    const got = messages(ws, 1);
    ws.send('big');
    expect((await got)[0]).toHaveLength(100_000);
    const done = nextExchange(proxy, finished());
    ws.close();
    const big = (await done).frames!.find((f) => f.size === 100_000)!;
    expect(big).toMatchObject({ dir: 'receive', kind: 'text', truncated: true });
    expect(big.text).toHaveLength(64 * 1024);
  });

  it('keeps the newest maxFramesPerExchange frames, counts the rest, coalesces exchange events (≤ 1 per 100 ms)', async () => {
    await proxy.stop();
    proxy = await startProxy({ maxFramesPerExchange: 5 });
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/many`);
    await once(ws, 'message');
    let events = 0;
    proxy.on('exchange', (e) => e.kind === 'websocket' && events++);
    const got = messages(ws, 200);
    const t0 = Date.now();
    ws.send('many:200');
    await got;
    await sleep(150);
    const elapsed = Date.now() - t0;
    const done = nextExchange(proxy, finished());
    ws.close(1000);
    const ex = await done;
    expect(ex.frames!.map((f) => f.text ?? f.kind)).toEqual(['m196', 'm197', 'm198', 'm199', 'close']);
    expect(ex.framesDropped).toBe(1 + 1 + 196); // welcome, many:200, m0…m195
    // 200 messages in `elapsed` ms → at most one event per 100 ms (+ the leading one) before the close.
    expect(events).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 3);
  });

  it('frame payloads count against the body byte budget', async () => {
    await proxy.stop();
    proxy = await startProxy({ maxStoredBodyBytes: 100_000 });
    const removed: string[] = [];
    proxy.on('removed', (ids) => removed.push(...ids));
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/budget`);
    await once(ws, 'message');
    const got = messages(ws, 2);
    ws.send('big');
    ws.send('big');
    await got;
    const done = nextExchange(proxy, finished());
    ws.close();
    const ex = await done;
    // ~128 KB of frames > 100 KB: evicted as soon as it is no longer in flight.
    expect(removed).toContain(ex.id);
    expect(proxy.getExchanges().find((e) => e.id === ex.id)).toBeUndefined();
  });

  it('wss:// through a CONNECT tunnel is recorded as wss://', async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wssUrl}/secure`);
    const [m] = await messages(ws, 1);
    expect(m).toBe('welcome');
    const done = nextExchange(proxy, finished());
    ws.close(1000);
    const ex = await done;
    expect(ex).toMatchObject({ url: `${up.wssUrl}/secure`, status: 101, state: 'completed', kind: 'websocket' });
  });

  it('a refused upgrade is an error with the server status', async () => {
    const done = nextExchange(proxy, finished());
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/refuse`);
    const [, res] = (await once(ws, 'unexpected-response')) as [unknown, http.IncomingMessage];
    expect(res.statusCode).toBe(401);
    ws.terminate();
    const ex = await done;
    expect(ex).toMatchObject({ state: 'error', status: 401 });
    expect(ex.error).toMatch(/refused: 401/);
  });

  it('x-fi-id is stripped before the upgrade goes upstream and never recorded', async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/trace`, { 'x-fi-id': 'abc123def4567890' });
    await once(ws, 'message');
    const done = nextExchange(proxy, finished());
    ws.close();
    const ex = await done;
    expect(up.upgrades.at(-1)?.headers['x-fi-id']).toBeUndefined();
    expect(ex.requestHeaders['x-fi-id']).toBeUndefined();
  });
});

describe('rules on WebSocket upgrades', () => {
  it('block (status) answers the upgrade; the server is never contacted', async () => {
    proxy.setRules([{ id: 'b', enabled: true, match: { url: 'ws://*' }, action: { kind: 'block', mode: 'status', status: 403 } }]);
    const done = nextExchange(proxy, finished());
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/blocked`);
    const [, res] = (await once(ws, 'unexpected-response')) as [unknown, http.IncomingMessage];
    expect(res.statusCode).toBe(403);
    ws.terminate();
    const ex = await done;
    expect(ex).toMatchObject({ state: 'blocked', status: 403, matchedRuleId: 'b', kind: 'websocket' });
    expect(up.upgrades).toEqual([]);
  });

  it('block (reset) and the reset / dns faults fail the connection; offline profile too', async () => {
    const cases: Array<() => void> = [
      () => proxy.setRules([{ id: 'r', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }]),
      () => proxy.setRules([{ id: 'f', enabled: true, match: { url: 'ws://*' }, action: { kind: 'fault', fault: 'reset' } }]),
      () => proxy.setRules([{ id: 'd', enabled: true, match: { url: 'ws://*' }, action: { kind: 'fault', fault: 'dns' } }]),
      () => {
        proxy.setRules([]);
        proxy.setNetworkProfile({ kind: 'offline' });
      },
    ];
    for (const apply of cases) {
      apply();
      const done = nextExchange(proxy, finished());
      const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/f`);
      await new Promise((r) => ws.once('close', r)); // (events.once would reject on the 'error' first)
      const ex = await done;
      expect(ex.state).toBe('blocked');
      expect(ex.simulated ?? ex.matchedRuleId).toBeTruthy();
    }
    proxy.setNetworkProfile({ kind: 'none' });
    expect(up.upgrades).toEqual([]);
  });

  it('the timeout fault holds the upgrade until the app gives up', async () => {
    proxy.setRules([{ id: 't', enabled: true, match: { url: 'ws://*' }, action: { kind: 'fault', fault: 'timeout' } }]);
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/hold`);
    await sleep(300);
    ws.terminate();
    const ex = await nextExchange(proxy, finished());
    expect(ex.state).toBe('blocked');
    expect(ex.simulated).toMatch(/the app gave up/);
  });

  it('mock / breakpoint / mutate / cors / throttle rules do not apply: passed through with a note, not spent', async () => {
    for (const action of [
      { kind: 'mock', status: 200, body: '{}' },
      { kind: 'breakpoint', phase: 'both' },
      { kind: 'mutate', ops: [] },
      { kind: 'cors' },
      { kind: 'throttle', latencyMs: 2000 },
      { kind: 'fault', fault: 'truncate' },
    ] as const) {
      // Written for https:// too: an http(s) pattern can't break a socket either.
      proxy.setRules([{ id: 'x', enabled: true, name: 'catch-all', times: 1, match: { url: '*' }, action }]);
      const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/pass`);
      const [m] = await messages(ws, 1);
      expect(m).toBe('welcome');
      const done = nextExchange(proxy, finished());
      ws.close();
      const ex = await done;
      expect(ex.state).toBe('completed');
      expect(ex.matchedRuleId).toBeUndefined();
      expect(ex.error).toMatch(/does not apply to WebSocket connections; passed through/);
    }
  });

  it('a GraphQL-scoped rule never matches an upgrade', async () => {
    proxy.setRules([{ id: 'g', enabled: true, match: { url: '*', graphqlOperation: 'OnMessage' }, action: { kind: 'block', mode: 'status' } }]);
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/graphql`);
    expect((await messages(ws, 1))[0]).toBe('welcome');
    ws.close();
    expect((await nextExchange(proxy, finished())).state).toBe('completed');
  });
});

/**
 * A hand-made upstream that accepts any upgrade with permessage-deflate and immediately sends one compressed
 * binary message of `inflated` zero bytes (REVIEW-5 #1: 261 KB on the wire → 256 MB inflated).
 */
async function startDeflateBomb(inflated: number) {
  const z = zlib.createDeflateRaw({ level: 9 });
  const parts: Buffer[] = [];
  z.on('data', (d: Buffer) => parts.push(d));
  const zero = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < inflated / zero.length; i++) z.write(zero);
  await new Promise<void>((r) => z.flush(zlib.constants.Z_SYNC_FLUSH, () => r()));
  let payload = Buffer.concat(parts);
  payload = payload.subarray(0, payload.length - 4); // permessage-deflate drops the trailing 00 00 ff ff
  const head = Buffer.alloc(10);
  head[0] = 0x80 | 0x40 | 0x02; // FIN + RSV1 (compressed) + binary
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(payload.length), 2);
  const frame = Buffer.concat([head, payload]);
  const server = http.createServer();
  const sockets = new Set<net.Socket>();
  server.on('upgrade', (req, socket: net.Socket) => {
    sockets.add(socket);
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.on('error', () => undefined);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
        'Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n',
    );
    socket.write(frame);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    wire: frame.length,
    close: () => {
      for (const so of sockets) so.destroy(); // upgraded sockets aren't the HTTP server's any more
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

describe('REVIEW-5 limits', () => {
  it('#1 a permessage-deflate bomb from the server (≈261 KB → 256 MB) is refused with 1009, memory stays bounded', async () => {
    const bomb = await startDeflateBomb(256 * 1024 * 1024);
    expect(bomb.wire).toBeLessThan(400 * 1024);
    global.gc?.();
    const rss0 = process.memoryUsage().rss;
    let peak = rss0;
    const iv = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
    const done = nextExchange(proxy, finished());
    const ws = await wsViaProxy(proxy.port, `${bomb.url}/bomb`, {}, { perMessageDeflate: false });
    let gotMessage = false;
    ws.on('message', () => (gotMessage = true));
    const [code] = (await once(ws, 'close')) as [number];
    clearInterval(iv);
    const ex = await done;
    await bomb.close();
    console.log(`[ws-bomb] wire ${(bomb.wire / 1024).toFixed(0)} KB, app close ${code}, peak RSS +${((peak - rss0) / 1e6).toFixed(1)} MB`);
    expect(gotMessage).toBe(false);
    expect(code).toBe(1009);
    expect(ex.state).toBe('error');
    expect(ex.error).toMatch(/from the server was over the 16 MB limit.*1009/);
    expect(peak - rss0).toBeLessThan(200 * 1024 * 1024);
  });

  it('#1 an oversized message from the app (plain and compressed) is refused with 1009 on both sides', async () => {
    for (const perMessageDeflate of [false, true]) {
      up.upgrades.length = 0;
      const done = nextExchange(proxy, finished());
      const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/upload`, {}, { perMessageDeflate });
      await once(ws, 'open');
      ws.send(Buffer.alloc(20 * 1024 * 1024));
      const [code] = (await once(ws, 'close')) as [number];
      const ex = await done;
      expect(code).toBe(1009);
      expect(ex.state).toBe('error');
      expect(ex.error).toMatch(/from the app was over the 16 MB limit/);
    }
    // Messages under the limit still pass.
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/ok`);
    const got = messages(ws, 2);
    await once(ws, 'open');
    ws.send(Buffer.alloc(15 * 1024 * 1024, 1));
    expect((await got)[1]).toMatch(/^bin:/);
    ws.close();
  });

  it('#4 frames of one exchange are kept within an 8 MB byte budget (oldest dropped)', async () => {
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/bytes`);
    const got = messages(ws, 201);
    await once(ws, 'open');
    ws.send('bigs:200');
    await got;
    const done = nextExchange(proxy, finished());
    ws.close();
    const ex = await done;
    const kept = ex.frames!.reduce((n, f) => n + (f.text?.length ?? 0), 0);
    expect(kept).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(ex.frames!.length).toBeLessThan(150);
    expect(ex.framesDropped).toBeGreaterThan(50);
    expect(ex.frames!.at(-2)?.text).toMatch(/^199:/);
  });

  it('#4 heavy open streams lose their oldest frames before finished exchanges are evicted', async () => {
    await proxy.stop();
    proxy = await startProxy({ maxStoredBodyBytes: 4 * 1024 * 1024 });
    const removed: string[] = [];
    proxy.on('removed', (ids) => removed.push(...ids));
    const finishedWs = await wsViaProxy(proxy.port, `${up.wsUrl}/small`);
    await once(finishedWs, 'message');
    const closed = nextExchange(proxy, finished());
    finishedWs.close();
    const small = await closed;
    const ws = await wsViaProxy(proxy.port, `${up.wsUrl}/heavy`);
    const got = messages(ws, 101);
    await once(ws, 'open');
    ws.send('bigs:100'); // ≈ 6.5 MB of frames, over the 4 MB store budget
    await got;
    await sleep(150);
    const heavy = proxy.getExchanges().find((e) => e.url.endsWith('/heavy'))!;
    expect(heavy.state).toBe('pending');
    expect(heavy.frames!.length).toBeGreaterThanOrEqual(50);
    expect(heavy.framesDropped).toBeGreaterThan(30);
    expect(removed).not.toContain(small.id);
    expect(proxy.getExchanges().some((e) => e.id === small.id)).toBe(true);
    ws.close();
  });
});

describe('real Dart WebSocket through the proxy', () => {
  let exe: string;
  let tmp: string;
  let caFile: string;
  let ca: { key: string; cert: string };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-ws-'));
    exe = path.join(tmp, 'ws_client');
    execFileSync('dart', ['compile', 'exe', path.join(__dirname, 'fixtures', 'ws_client.dart'), '-o', exe], { stdio: 'pipe' });
    const c = await generateCACertificate({ subject: { commonName: 'Flutter Intercept test CA' } });
    ca = { key: c.key, cert: c.cert };
    caFile = path.join(tmp, 'ca.pem');
    fs.writeFileSync(caFile, ca.cert);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const dart = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(exe, args, { env: { ...process.env, ...env }, timeout: 60_000 }, (err, stdout) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout });
      });
    });

  for (const scheme of ['ws', 'wss'] as const) {
    for (const closer of ['server', 'app'] as const) {
      it(`${scheme}:// — messages both ways recorded in order, ${closer} closes`, async () => {
        await proxy.stop();
        proxy = await startProxy({ ca });
        const base = scheme === 'ws' ? up.wsUrl : up.wssUrl;
        const done = nextExchange(proxy, finished(), 30_000);
        const r = await dart([String(proxy.port), `${base}/dart`, ...(scheme === 'wss' ? [caFile] : [])], closer === 'app' ? { FI_WS_CLIENT_CLOSE: '1' } : {});
        expect(r.out).toContain('RECV text welcome');
        expect(r.out).toContain('RECV text echo:hello');
        expect(r.out).toContain('RECV binary 3,2,1');
        expect(r.out).toContain(closer === 'app' ? 'CLOSED 4001 bye' : 'CLOSED 4002 server bye');
        expect(r.code).toBe(0);
        const ex = await done;
        expect(ex).toMatchObject({ url: `${base}/dart`, kind: 'websocket', status: 101, state: 'completed' });
        expect(ex.requestHeaders['user-agent']).toMatch(/Dart/);
        const data = ex.frames!.filter((f) => f.kind !== 'ping' && f.kind !== 'pong');
        expect(data.slice(0, 5).map((f) => `${f.dir} ${f.kind} ${f.text ?? f.base64}`)).toEqual([
          'receive text welcome',
          'send text hello',
          'send binary AQID',
          'receive text echo:hello',
          'receive binary AwIB',
        ]);
        expect(data.at(-1)).toMatchObject(
          closer === 'app' ? { dir: 'send', kind: 'close', closeCode: 4001 } : { dir: 'receive', kind: 'close', closeCode: 4002, text: 'server bye' },
        );
      }, 60_000);
    }
  }
});
