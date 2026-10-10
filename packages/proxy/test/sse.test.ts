// Server-sent events (CONTRACTS §11.1): the incremental parser, recording through the proxy (streaming, never
// buffered), and a REAL dart:io client reading the stream (test/fixtures/sse_client.dart).
import { execFile, execFileSync } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy } from '../src';
import { SseParser, type SseEvent } from '../src/sse';
import { nextExchange, sleep, startProxy, viaProxy } from './helpers';

function parseAll(chunks: Array<string | Buffer>): SseEvent[] {
  const out: SseEvent[] = [];
  const p = new SseParser((e) => out.push(e));
  for (const c of chunks) (typeof c === 'string' ? p.pushBytes(Buffer.from(c, 'utf8')) : p.pushBytes(c));
  p.end();
  return out;
}

// Every feature at once: BOM, comments, retry, CRLF / LF / CR, multi-line data, names, ids, UTF-8.
const STREAM =
  '﻿: hello comment\r\nretry: 1500\r\n\r\n' +
  'data: first\n\n' +
  'event: update\rid: 7\rdata: line1\rdata: line2\r\r' +
  'data:no-space\r\ndata:  two-spaces\r\n\r\n' +
  'id: 8\nevent: événement\ndata: café \u{1F600}\n\n' +
  'event: no-data\n\n' +
  'data\n\n' +
  'id: bad\u0000id\ndata: x\n\n' +
  'data: unfinished at the end';
const EXPECTED: Array<Partial<SseEvent>> = [
  { data: 'first' },
  { data: 'line1\nline2', event: 'update', id: '7' },
  { data: 'no-space\n two-spaces' },
  { data: 'café \u{1F600}', event: 'événement', id: '8' },
  { data: '' },
  { data: 'x' },
];

describe('SseParser', () => {
  it('parses the HTML-standard event stream format', () => {
    const got = parseAll([STREAM]);
    expect(got.map(({ size: _s, ...e }) => e)).toEqual(EXPECTED);
    expect(got[3].size).toBe(Buffer.byteLength('café \u{1F600}'));
    expect(got[1].size).toBe('line1\nline2'.length);
  });

  it('gives the same events for every possible chunk boundary (incl. inside CRLF and UTF-8 sequences)', () => {
    const bytes = Buffer.from(STREAM, 'utf8');
    const want = JSON.stringify(parseAll([bytes]));
    for (let i = 1; i < bytes.length; i++) {
      expect(JSON.stringify(parseAll([bytes.subarray(0, i), bytes.subarray(i)]))).toBe(want);
    }
    expect(JSON.stringify(parseAll([...bytes].map((b) => Buffer.from([b]))))).toBe(want);
  });

  it('caps an event at 64 KB of data (truncated, full size counted) and bounds long lines', () => {
    const [e] = parseAll([`data: ${'a'.repeat(100_000)}\ndata: ${'b'.repeat(10)}\n\n`]);
    expect(e).toMatchObject({ truncated: true, size: 100_000 + 1 + 10 });
    expect(e.data).toHaveLength(64 * 1024);
    const [f] = parseAll(['data: ', 'x'.repeat(70_000), 'y'.repeat(70_000), '\n\n']);
    expect(f).toMatchObject({ truncated: true, size: 140_000 });
  });

  it('REVIEW-5 #4: caps event names at 256 chars and ids at 1 KB (truncated)', () => {
    const [e] = parseAll([`event: ${'e'.repeat(64_000)}\nid: ${'i'.repeat(64_000)}\ndata: d\n\n`]);
    expect(e.event).toHaveLength(256);
    expect(e.id).toHaveLength(1024);
    expect(e).toMatchObject({ data: 'd', truncated: true });
    const [ok] = parseAll(['event: up\nid: 7\ndata: d\n\n']);
    expect(ok.truncated).toBeUndefined();
  });
});

// ---------------------------------------------------------------- through the proxy

let server: http.Server;
let base: string;
const sockets = new Set<import('net').Socket>();

/** Writes `pieces` with `gapMs` between them (chunked), then ends after `lastMs`. */
async function writeSlowly(res: http.ServerResponse, pieces: Array<string | Buffer>, gapMs: number, lastMs = 0) {
  for (let i = 0; i < pieces.length; i++) {
    if (i === pieces.length - 1 && lastMs) await sleep(lastMs);
    else if (i) await sleep(gapMs);
    if (res.destroyed) return;
    res.write(pieces[i]);
  }
  res.end();
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const sse = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' };
    switch (u.pathname) {
      case '/events': {
        res.writeHead(200, sse);
        // Boundaries in odd places: inside a field name, between CR and LF, inside "é".
        const bytes = Buffer.from(STREAM.replace('data: unfinished at the end', 'data: last\n\n'), 'utf8');
        const cuts = [3, 20, 41, 42, 77, 78, 120, 121, 150, bytes.length - 12];
        const pieces: Buffer[] = [];
        let prev = 0;
        for (const c of cuts) {
          pieces.push(bytes.subarray(prev, c));
          prev = c;
        }
        pieces.push(bytes.subarray(prev));
        return writeSlowly(res, pieces, 15, Number(u.searchParams.get('lastMs') ?? 400));
      }
      case '/late':
        // Head now, first event only later: the app should see the head at once.
        res.writeHead(200, sse);
        res.flushHeaders();
        return writeSlowly(res, ['data: late\n\n'], 0, 400);
      case '/gzip': {
        res.writeHead(200, { ...sse, 'content-encoding': 'gzip' });
        const z = zlib.createGzip();
        z.on('data', (d) => res.write(d));
        z.on('end', () => res.end());
        for (const ev of ['data: g1\n\n', 'event: x\ndata: g2\n\n']) {
          z.write(ev);
          z.flush();
          await sleep(30);
        }
        z.end();
        return;
      }
      case '/forever':
        res.writeHead(200, sse);
        res.write('data: tick\n\n');
        return; // never ends; the client goes away
      case '/dies':
        res.writeHead(200, sse);
        res.write('data: before\n\n');
        setTimeout(() => res.socket?.destroy(), 100);
        return;
      case '/bomb': {
        // REVIEW-5 #11: ~70 MB of events once inflated, a fraction of that on the wire.
        res.writeHead(200, { ...sse, 'content-encoding': 'gzip' });
        const z = zlib.createGzip({ level: 9 });
        z.pipe(res);
        const ev = Buffer.from(`data: ${'x'.repeat(1000)}\n\n`);
        const block = Buffer.concat(Array.from({ length: 1024 }, () => ev)); // ~1 MB
        for (let i = 0; i < 70; i++) if (!z.write(block)) await once(z, 'drain');
        z.end();
        return;
      }
      case '/many':
        res.writeHead(200, sse);
        for (let i = 0; i < 50; i++) res.write(`data: e${i}\n\n`);
        res.end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

let proxy: InterceptProxy;
beforeEach(async () => {
  proxy = await startProxy();
});
afterEach(async () => {
  await proxy.stop();
});

const sseDone = (urlPart: string) => (e: Exchange) => e.kind === 'sse' && e.state !== 'pending' && e.url.includes(urlPart);
const texts = (e: Exchange) => (e.frames ?? []).map((f) => f.text);

describe('SSE through the proxy', () => {
  it('records events incrementally from a chunked stream: pending with frames before the end, no body copy', async () => {
    const live = nextExchange(proxy, (e) => e.kind === 'sse' && e.state === 'pending' && (e.frames?.length ?? 0) >= 6);
    const done = nextExchange(proxy, sseDone('/events'));
    const resP = viaProxy(proxy.port, `${base}/events`);
    const pending = await live; // before the last event (400 ms later)
    expect(pending).toMatchObject({ status: 200, kind: 'sse' });
    expect(pending.responseHeaders?.['content-type']).toMatch(/event-stream/);
    const r = await resP;
    expect(r.text).toContain('data: last');
    const ex = await done;
    expect(ex.state).toBe('completed');
    expect(ex.responseBody).toBeUndefined();
    expect(ex.frames!.map(({ dir, kind, text, event, id }) => ({ dir, kind, text, event, id }))).toEqual(
      [...EXPECTED, { data: 'last' }].map((e) => ({ dir: 'receive', kind: 'event', text: e.data, event: e.event, id: e.id })),
    );
  });

  it('flushes the head of an event stream at once (the app does not wait for the first event)', async () => {
    const t0 = Date.now();
    const headAt = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `${base}/late`, headers: { host: new URL(base).host } });
      req.on('response', (res) => {
        resolve(Date.now() - t0);
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });
    expect(headAt).toBeLessThan(300);
    const ex = await nextExchange(proxy, sseDone('/late'));
    expect(texts(ex)).toEqual(['late']);
  });

  it('decodes a gzip event stream', async () => {
    const done = nextExchange(proxy, sseDone('/gzip'));
    await viaProxy(proxy.port, `${base}/gzip`);
    const ex = await done;
    expect(ex.frames!.map((f) => [f.text, f.event])).toEqual([
      ['g1', undefined],
      ['g2', 'x'],
    ]);
  });

  it('the app closing the stream ends it as completed (with a note), not as an error', async () => {
    const live = nextExchange(proxy, (e) => e.kind === 'sse' && (e.frames?.length ?? 0) >= 1);
    const done = nextExchange(proxy, sseDone('/forever'));
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `${base}/forever`, headers: { host: new URL(base).host } });
    req.on('error', () => undefined);
    req.end();
    await live;
    req.destroy();
    const ex = await done;
    expect(ex).toMatchObject({ state: 'completed', error: 'The app closed the event stream.' });
    expect(texts(ex)).toEqual(['tick']);
  });

  it('an upstream that dies mid-stream keeps the events seen so far', async () => {
    const done = nextExchange(proxy, sseDone('/dies'));
    await viaProxy(proxy.port, `${base}/dies`).catch(() => undefined);
    const ex = await done;
    expect(texts(ex)).toEqual(['before']);
    expect(ex.state).toBe('error');
    expect(ex.error).toMatch(/connection to the server failed mid-stream \(ECONNRESET\)/);
  });

  it('REVIEW-5 #11: stops parsing a compressed stream past 64 MB decoded (noted), the app still gets it all', async () => {
    const done = nextExchange(proxy, sseDone('/bomb'), 60_000);
    const r = await viaProxy(proxy.port, `${base}/bomb`);
    expect(zlib.gunzipSync(r.body).length).toBe(70 * 1024 * 1008);
    const ex = await done;
    expect(ex.state).toBe('completed');
    expect(ex.error).toBe('Events not recorded past 64 MB of decoded stream.');
    expect(ex.framesDropped! + ex.frames!.length).toBeLessThan(70 * 1024);
  }, 60_000);

  it('caps frames at maxFramesPerExchange (newest kept)', async () => {
    await proxy.stop();
    proxy = await startProxy({ maxFramesPerExchange: 10 });
    const done = nextExchange(proxy, sseDone('/many'));
    await viaProxy(proxy.port, `${base}/many`);
    const ex = await done;
    expect(texts(ex)).toEqual(Array.from({ length: 10 }, (_, i) => `e${40 + i}`));
    expect(ex.framesDropped).toBe(40);
  });

  it('a throttled stream (network profile) is still recorded event by event', async () => {
    proxy.setNetworkProfile({ kind: 'throttle', latencyMs: 50, kbps: 50 });
    const done = nextExchange(proxy, sseDone('/many'));
    await viaProxy(proxy.port, `${base}/many`);
    const ex = await done;
    expect(ex.frames).toHaveLength(50);
    expect(ex.simulated).toBeTruthy();
  });

  it('a mock answering text/event-stream is shown as events', async () => {
    proxy.setRules([
      {
        id: 'm',
        enabled: true,
        match: { url: '*/mocked-events' },
        action: { kind: 'mock', status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: a\ndata: 1\n\ndata: 2\n\n' },
      },
    ]);
    const done = nextExchange(proxy, sseDone('/mocked-events'));
    const r = await viaProxy(proxy.port, `${base}/mocked-events`);
    expect(r.text).toBe('event: a\ndata: 1\n\ndata: 2\n\n');
    const ex = await done;
    expect(ex.state).toBe('mocked');
    expect(ex.frames!.map((f) => [f.event, f.text])).toEqual([
      ['a', '1'],
      [undefined, '2'],
    ]);
  });
});

describe('real Dart client reading an event stream', () => {
  let exe: string;
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-sse-'));
    exe = path.join(tmp, 'sse_client');
    execFileSync('dart', ['compile', 'exe', path.join(__dirname, 'fixtures', 'sse_client.dart'), '-o', exe], { stdio: 'pipe' });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('gets the events as they are sent (streamed, not buffered) and the proxy records each one', async () => {
    const done = nextExchange(proxy, sseDone('/events'), 30_000);
    const out = await new Promise<string>((resolve) => {
      execFile(exe, [String(proxy.port), `${base}/events?lastMs=600`], { timeout: 60_000 }, (_err, stdout) => resolve(stdout));
    });
    const lines = out.trim().split('\n');
    expect(lines[0]).toMatch(/^HEADERS \d+ 200 text\/event-stream/);
    const chunks = lines.filter((l) => l.startsWith('CHUNK ')).map((l) => {
      const [, ms, ...rest] = l.split(' ');
      return { ms: Number(ms), text: JSON.parse(rest.join(' ')) as string };
    });
    const end = Number(lines.at(-1)!.split(' ')[1]);
    expect(chunks.length).toBeGreaterThan(3);
    expect(end - chunks[0].ms).toBeGreaterThanOrEqual(500); // the first bytes long before the end
    // (Dart's utf8 decoder drops the leading BOM.)
    expect(chunks.map((c) => c.text).join('')).toBe(STREAM.slice(1).replace('data: unfinished at the end', 'data: last\n\n'));
    const ex = await done;
    expect(ex.requestHeaders['user-agent']).toMatch(/Dart/);
    expect(texts(ex)).toEqual([...EXPECTED.map((e) => e.data), 'last']);
  }, 60_000);
});
