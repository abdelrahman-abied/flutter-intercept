import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, Frame } from '@flutter-intercept/proxy';
import { createRecordingService, isRecordable, parseHead, recordedExchange, streamCounts } from '../../src/recordings/store';
import { toReplay } from '../../src/recordings/replay';
import { diff, diffText } from '../../src/recordings/diff';
import { validateRecording } from '../../src/recordings/validate';
import {
  capFrames,
  frameCost,
  frameLines,
  MAX_FRAME_COST_PER_EXCHANGE,
  MAX_RECORDED_FRAMES,
  normaliseFrameText,
  redactFrame,
} from '../../src/recordings/frames';
import type { Recording } from '../../src/recordings/types';

// Fake credentials, built at run time (never literal provider-format tokens in the repo).
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
const LIVE_KEY = ['sk', 'live', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56'].join('_');

const T = 1_760_000_000_000;
let n = 0;

function frame(p: Partial<Frame> & Pick<Frame, 'dir' | 'kind'>): Frame {
  return { at: T + 10, size: p.text?.length ?? 0, ...p };
}

function ws(p: Partial<Exchange> = {}): Exchange {
  n++;
  return {
    id: `w${n}`,
    kind: 'websocket',
    startedAt: T,
    durationMs: 3000,
    method: 'GET',
    url: 'wss://api.example.com/socket',
    requestHeaders: { 'sec-websocket-key': `k${n}==`, 'sec-websocket-protocol': 'graphql-ws', authorization: `Bearer ${JWT}` },
    status: 101,
    responseHeaders: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-accept': `a${n}=`,
      'sec-websocket-protocol': 'graphql-ws',
      'sec-websocket-extensions': 'permessage-deflate',
    },
    state: 'completed',
    frames: [
      frame({ dir: 'send', kind: 'text', at: T + 100, text: `{"type":"auth","token":"${LIVE_KEY}"}` }),
      frame({ dir: 'receive', kind: 'text', at: T + 250, text: '{"type":"ack","requestId":"9b2c7d4e-1f3a-4b5c-8d6e-7f8091a2b3c4","ts":1760000000250}' }),
      frame({ dir: 'receive', kind: 'binary', at: T + 400, base64: Buffer.from([1, 2, 3, 4]).toString('base64'), size: 4 }),
      frame({ dir: 'send', kind: 'close', at: T + 3000, closeCode: 1000, text: 'bye', size: 5 }),
    ],
    ...p,
  };
}

function sse(p: Partial<Exchange> = {}): Exchange {
  n++;
  return {
    id: `s${n}`,
    kind: 'sse',
    startedAt: T,
    durationMs: 2000,
    method: 'POST',
    url: 'https://api.example.com/v1/stream',
    requestHeaders: { 'content-type': 'application/json', accept: 'text/event-stream' },
    requestBody: { text: '{"prompt":"hi"}', encoding: 'utf8' },
    status: 200,
    responseHeaders: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked', 'cache-control': 'no-cache' },
    state: 'completed',
    frames: [
      frame({ dir: 'receive', kind: 'event', at: T + 50, event: 'delta', id: '1', text: '{"t":"Hel"}' }),
      frame({ dir: 'receive', kind: 'event', at: T + 90, event: 'delta', id: '2', text: '{"t":"lo"}' }),
      frame({ dir: 'receive', kind: 'event', at: T + 1500, text: `line one\ntoken: ${LIVE_KEY}` }),
    ],
    ...p,
  };
}

function rec(name: string, entries: Exchange[], redacted = false): Recording {
  return { version: 1, id: name.toLowerCase(), name, createdAt: 0, exchanges: entries.length, path: `/tmp/${name}.json`, redacted, entries };
}

let root: string;
const svc = () => createRecordingService({ root: () => root, now: () => T });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-recws-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isRecordable (CONTRACTS §14.5)', () => {
  it('keeps finished WebSocket (101) and SSE exchanges; not tunnels, failed upgrades or open streams', () => {
    expect(isRecordable(ws())).toBe(true);
    expect(isRecordable(sse())).toBe(true);
    expect(isRecordable(sse({ state: 'mocked' }))).toBe(true);
    expect(isRecordable(ws({ status: 403 }))).toBe(false);
    expect(isRecordable(ws({ state: 'error' }))).toBe(false);
    expect(isRecordable(ws({ state: 'pending' }))).toBe(false);
    expect(isRecordable(sse({ state: 'pending' }))).toBe(false);
    expect(isRecordable({ ...sse(), kind: 'tunnel', method: 'CONNECT' })).toBe(false);
    expect(isRecordable(ws({ browserInternal: true }))).toBe(false);
  });
});

describe('RecordingService with WebSocket / SSE', () => {
  it('saves frames unredacted by default and loads them back unchanged', async () => {
    const s = svc();
    const a = ws();
    const b = sse();
    const meta = await s.save('Streams', [a, b]);
    expect(meta.exchanges).toBe(2);
    const loaded = await s.load(meta.id);
    const w = loaded.entries.find((e) => e.kind === 'websocket')!;
    const e = loaded.entries.find((e) => e.kind === 'sse')!;
    expect(w.frames).toEqual(a.frames);
    expect(w.url).toBe('wss://api.example.com/socket');
    expect(w).not.toHaveProperty('responseBody');
    expect(e.frames).toEqual(b.frames);
    expect(e.requestBody).toEqual(b.requestBody);
    expect(fs.readFileSync(meta.path, 'utf8')).toContain(LIVE_KEY);
  });

  it('metadata counts streams and frames (save, list from the head, load, export); absent for HTTP-only and 0.7 files', async () => {
    const s = svc();
    const http: Exchange = { id: 'h', startedAt: T, method: 'GET', url: 'https://api.example.com/a', requestHeaders: {}, status: 200, responseHeaders: {}, state: 'completed' };
    const meta = await s.save('Mixed', [ws(), sse(), http, { ...ws(), kind: 'tunnel', method: 'CONNECT', status: 200 }]);
    expect(meta).toMatchObject({ exchanges: 3, streams: 2, frames: 7 });
    const head = fs.readFileSync(meta.path, 'utf8').split('\n')[0];
    expect(head).toMatch(/^\{"version":2,/);
    expect(head).toContain('"streams":2,"frames":7');
    expect((await s.list())[0]).toMatchObject({ id: meta.id, streams: 2, frames: 7 });
    expect(await s.load(meta.id)).toMatchObject({ streams: 2, frames: 7 });
    const dest = path.join(root, 'copy.json');
    await s.export(meta.id, dest, { redact: true });
    expect(parseHead(fs.readFileSync(dest, 'utf8'))).toMatchObject({ streams: 2, frames: 7 });

    expect(fs.readFileSync(dest, 'utf8')).toMatch(/^\{"version":2,/);

    // HTTP-only recordings stay version 1 (0.7 can read them)
    const plain = await s.save('Plain', [http]);
    expect(fs.readFileSync(plain.path, 'utf8')).toMatch(/^\{"version":1,/);
    expect((await s.load(plain.id)).version).toBe(1);
    expect(plain).not.toHaveProperty('streams');
    expect((await s.list()).find((m) => m.id === plain.id)).not.toHaveProperty('streams');
    expect(await s.load(plain.id)).not.toHaveProperty('frames');
    expect(streamCounts([http])).toEqual({});
    // a bad count in the head: not trusted, the full file is read instead
    expect(parseHead('{"version":1,"name":"x","createdAt":1,"exchanges":1,"redacted":false,"streams":5,\n')).toBeUndefined();
    expect(parseHead('{"version":3,"name":"x","createdAt":1,"exchanges":1,"redacted":false,\n')).toBeUndefined();
    expect(parseHead('{"version":2,"name":"x","createdAt":1,"exchanges":2,"redacted":false,"streams":1,"frames":4,\n')).toMatchObject({ streams: 1, frames: 4 });
    expect(parseHead('{"version":1,"name":"x","createdAt":1,"exchanges":1,"redacted":false,"streams":1,"frames":-1,\n')).toBeUndefined();
  });

  it('redact: true redacts frames like agent views (text, SSE ids, binary payloads)', async () => {
    const s = svc();
    const meta = await s.save('Shared streams', [ws(), sse({ frames: [frame({ dir: 'receive', kind: 'event', id: JWT, text: `{"access_token":"x1"}` })] })], { redact: true });
    const text = fs.readFileSync(meta.path, 'utf8');
    expect(text).not.toContain(LIVE_KEY);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain('"x1"');
    const loaded = await s.load(meta.id);
    const w = loaded.entries.find((e) => e.kind === 'websocket')!;
    expect(w.frames![0].text).toBe('{"type":"auth","token":"[redacted]"}');
    expect(w.frames![2]).toEqual({ dir: 'receive', at: T + 400, kind: 'binary', size: 4, truncated: true });
    expect(w.frames![3]).toMatchObject({ kind: 'close', closeCode: 1000, text: 'bye' });
    expect(w.requestHeaders.authorization).toBe('[redacted]');
    const e = loaded.entries.find((e) => e.kind === 'sse')!;
    expect(e.frames![0]).toMatchObject({ id: '[redacted]', text: '{"access_token":"[redacted]"}' });
  });

  it('export redacted redacts frames of an unredacted recording', async () => {
    const s = svc();
    const meta = await s.save('Export', [sse()]);
    const dest = path.join(root, 'out.json');
    await s.export(meta.id, dest, { redact: true });
    const text = fs.readFileSync(dest, 'utf8');
    expect(text).not.toContain(LIVE_KEY);
    expect(text).toContain('token: [redacted]');
  });

  it('keeps the frame caps (newest 500, 8 MB) and counts the dropped ones', () => {
    const many = Array.from({ length: 620 }, (_, i) => frame({ dir: 'receive', kind: 'text', at: T + i, text: `m${i}` }));
    const r = recordedExchange(ws({ frames: many, framesDropped: 5 }));
    expect(r.frames).toHaveLength(MAX_RECORDED_FRAMES);
    expect(r.frames![0].text).toBe('m120');
    expect(r.framesDropped).toBe(125);
    const big = Array.from({ length: 200 }, (_, i) => frame({ dir: 'receive', kind: 'text', at: T + i, text: 'x'.repeat(60 * 1024) }));
    const c = capFrames(big);
    expect(c.frames.reduce((s, f) => s + frameCost(f), 0)).toBeLessThanOrEqual(MAX_FRAME_COST_PER_EXCHANGE);
    expect(c.frames.length + c.dropped).toBe(200);
    expect(c.frames[c.frames.length - 1]).toBe(big[199]);
  });

  it('save drops fields a recording does not keep from frames and the exchange', () => {
    const r = recordedExchange(ws({ frames: [{ ...frame({ dir: 'send', kind: 'text', text: 'a' }), extra: 1 } as Frame], viaLan: true }));
    expect(r.frames).toEqual([{ dir: 'send', at: T + 10, kind: 'text', size: 1, text: 'a' }]);
    expect(r).not.toHaveProperty('viaLan');
  });
});

describe('validation of WebSocket / SSE entries', () => {
  const file = (entries: unknown[], version: unknown = 2) => ({ version, name: 'x', createdAt: 1, redacted: false, entries });
  const plain = { id: 'h1', startedAt: 1, method: 'GET', url: 'https://api.example.com/a', requestHeaders: {}, status: 200, responseHeaders: {}, state: 'completed' };
  const good = () => JSON.parse(JSON.stringify(ws()));
  const goodSse = () => JSON.parse(JSON.stringify(sse()));

  it('loads 0.6 / 0.7 files (plain HTTP entries) unchanged', () => {
    const r = validateRecording(file([plain], 1), 'x', '/x.json');
    expect(r.version).toBe(1);
    expect(r.entries[0]).not.toHaveProperty('kind');
    expect(r.entries[0]).not.toHaveProperty('frames');
  });

  it('versions: 2 for stream entries, a version 1 file with one is refused, unknown versions are refused clearly', () => {
    expect(validateRecording(file([good()], 2), 'x', '/x.json').version).toBe(2);
    expect(validateRecording(file([plain], 2), 'x', '/x.json').version).toBe(2);
    expect(() => validateRecording(file([plain, good()], 1), 'x', '/x.json')).toThrow(/entries\[1\]\.kind is not allowed in a version 1 recording/);
    expect(() => validateRecording(file([plain], 3), 'x', '/x.json')).toThrow(/version must be 1 or 2 \(this file has 3: it was saved by a newer Flutter Intercept/);
    expect(() => validateRecording(file([plain], 0), 'x', '/x.json')).toThrow(/version must be 1 or 2 \(this file has 0\)$/);
    expect(() => validateRecording({ ...file([plain]), version: undefined }, 'x', '/x.json')).toThrow(/version must be 1 or 2/);
  });

  it('loads valid WebSocket and SSE entries', () => {
    const r = validateRecording(file([good(), goodSse(), plain]), 'x', '/x.json');
    expect(r.entries[0].frames).toEqual(ws().frames);
    expect(r.entries[1].frames).toEqual(sse().frames);
  });

  it.each<[string, (d: any) => void, RegExp]>([
    ['unknown kind', (d) => (d.kind = 'tunnel'), /kind must be "websocket" or "sse"/],
    ['http URL on a WebSocket', (d) => (d.url = 'https://api.example.com/socket'), /must be a ws\(s\) URL/],
    ['status other than 101', (d) => (d.status = 200), /must be 101/],
    ['POST upgrade', (d) => (d.method = 'POST'), /must be GET/],
    ['body on a WebSocket', (d) => (d.responseBody = { text: 'x', encoding: 'utf8' }), /must not have bodies/],
    ['frames not an array', (d) => (d.frames = {}), /frames must be an array/],
    ['too many frames', (d) => (d.frames = Array.from({ length: 501 }, () => d.frames[0])), /more than 500 frames/],
    ['bad dir', (d) => (d.frames[0].dir = 'up'), /frames\[0\]\.dir/],
    ['bad time', (d) => (d.frames[0].at = -1), /frames\[0\]\.at/],
    ['event kind on a WebSocket', (d) => (d.frames[0].kind = 'event'), /frames\[0\]\.kind/],
    ['negative size', (d) => (d.frames[0].size = -1), /frames\[0\]\.size/],
    ['fractional size', (d) => (d.frames[0].size = 1.5), /frames\[0\]\.size/],
    ['text on binary', (d) => (d.frames[2].text = 'x'), /frames\[2\]\.text is not allowed/],
    ['base64 on text', (d) => (d.frames[0].base64 = 'AAAA'), /frames\[0\]\.base64 is only allowed/],
    ['text and base64', (d) => (d.frames[2] = { dir: 'send', at: 1, kind: 'ping', size: 1, text: 'a', base64: 'AA==' }), /both text and base64/],
    ['bad base64', (d) => (d.frames[2].base64 = '***'), /not valid base64/],
    ['base64 over 64 KB', (d) => (d.frames[2].base64 = 'A'.repeat(4 * 21846 + 4)), /too long/],
    ['text over the cap', (d) => (d.frames[0].text = 'x'.repeat(128 * 1024 + 1)), /frames\[0\]\.text is too long/],
    ['truncated false', (d) => (d.frames[0].truncated = false), /truncated must be true/],
    ['close code on text', (d) => (d.frames[0].closeCode = 1000), /closeCode is only allowed/],
    ['bad close code', (d) => (d.frames[3].closeCode = 70000), /close code/],
    ['event name on WebSocket', (d) => (d.frames[0].event = 'x'), /event is only allowed/],
    ['framesDropped', (d) => (d.framesDropped = -2), /framesDropped/],
    ['payload over 8 MB', (d) => (d.frames = Array.from({ length: 130 }, () => ({ dir: 'receive', at: 1, kind: 'text', size: 1, text: 'x'.repeat(65536) }))), /more than 8 MB/],
  ])('rejects a WebSocket entry with %s', (_what, mut, re) => {
    const d = good();
    mut(d);
    expect(() => validateRecording(file([d]), 'x', '/x.json')).toThrow(re);
  });

  it.each<[string, (d: any) => void, RegExp]>([
    ['a text frame', (d) => (d.frames[0].kind = 'text'), /must be "event" in an SSE recording/],
    ['a sent event', (d) => (d.frames[0].dir = 'send'), /must be "receive" for an SSE event/],
    ['a CRLF in the event name', (d) => (d.frames[0].event = 'a\r\ndata: x'), /event must be a string/],
    ['a long id', (d) => (d.frames[0].id = 'x'.repeat(1025)), /id must be a string/],
    ['a response body', (d) => (d.responseBody = { text: 'x', encoding: 'utf8' }), /responseBody must be absent/],
    ['a ws URL', (d) => (d.url = 'wss://api.example.com/x'), /must be an http\(s\) URL/],
  ])('rejects an SSE entry with %s', (_what, mut, re) => {
    const d = goodSse();
    mut(d);
    expect(() => validateRecording(file([d]), 'x', '/x.json')).toThrow(re);
  });

  it('rejects frames on a plain HTTP entry and drops unknown frame fields', () => {
    expect(() => validateRecording(file([{ ...plain, frames: [] }]), 'x', '/x.json')).toThrow(/only allowed on WebSocket and SSE/);
    const d = good();
    d.frames[0].evil = 1;
    expect(validateRecording(file([d]), 'x', '/x.json').entries[0].frames![0]).not.toHaveProperty('evil');
  });
});

describe('toReplay (CONTRACTS §14.5)', () => {
  it('emits WebSocket entries with frames, without handshake headers the local server computes', () => {
    const [e] = toReplay(rec('R', [ws()]));
    expect(e).toEqual({
      kind: 'websocket',
      method: 'GET',
      url: 'wss://api.example.com/socket',
      status: 101,
      headers: { 'sec-websocket-protocol': 'graphql-ws' },
      frames: ws().frames,
    });
    expect(e).not.toHaveProperty('body');
    expect(e).not.toHaveProperty('requestBodyHash');
  });

  it('emits SSE entries with the head (no framing / content-encoding), events and the request body hash', () => {
    const [e] = toReplay(rec('R', [sse()]));
    expect(e.kind).toBe('sse');
    expect(e.headers).toEqual({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    expect(e.frames).toEqual(sse().frames);
    expect(e.requestBodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e).not.toHaveProperty('body');
  });

  it('keeps recorded order with HTTP entries, and copies frames (no shared references)', () => {
    const h: Exchange = { id: 'h', startedAt: T - 5, method: 'GET', url: 'https://api.example.com/a', requestHeaders: {}, status: 200, responseHeaders: {}, state: 'completed' };
    const w = ws();
    const out = toReplay(rec('R', [w, h]));
    expect(out.map((x) => x.kind ?? 'http')).toEqual(['http', 'websocket']);
    out[1].frames![0].text = 'changed';
    expect(w.frames![0].text).not.toBe('changed');
  });
});

describe('diff with WebSocket / SSE routes', () => {
  it('labels stream routes apart from HTTP and reports frame counts, message types and close codes', () => {
    const a = rec('A', [ws(), sse(), { ...ws(), kind: undefined, status: 200, url: 'https://api.example.com/socket', frames: undefined }]);
    const b = rec('B', [
      ws({
        frames: [
          frame({ dir: 'send', kind: 'text', at: T + 100, text: '{"type":"auth"}' }),
          frame({ dir: 'receive', kind: 'text', at: T + 200, text: '{"type":"ack"}' }),
          frame({ dir: 'receive', kind: 'text', at: T + 300, text: '{"type":"ack"}' }),
          frame({ dir: 'receive', kind: 'close', at: T + 400, closeCode: 1011 }),
        ],
      }),
      sse({ frames: [frame({ dir: 'receive', kind: 'event', event: 'delta', text: 'x' }), frame({ dir: 'receive', kind: 'event', event: 'done', text: '' })] }),
      { ...ws(), kind: undefined, status: 200, url: 'https://api.example.com/socket', frames: undefined },
    ]);
    expect(diff(a, b)).toEqual([
      { route: 'WS /socket', change: 'status', detail: 'close 1000 → 1011' },
      { route: 'WS /socket', change: 'count', detail: 'frames: 4 → 4 (sent 2 → 1, received 2 → 3)' },
      { route: 'WS /socket', change: 'shape', detail: '-message type receive binary' },
      { route: 'WS /socket', change: 'shape', detail: '-message type send close' },
      { route: 'WS /socket', change: 'shape', detail: '+message type receive close' },
      { route: 'POST /v1/stream (SSE)', change: 'count', detail: 'frames: 3 → 2 (received 3 → 2)' },
      { route: 'POST /v1/stream (SSE)', change: 'shape', detail: '-SSE event message' },
      { route: 'POST /v1/stream (SSE)', change: 'shape', detail: '+SSE event done' },
    ]);
  });

  it('reports nothing for the same stream traffic and adds / removes stream routes', () => {
    expect(diff(rec('A', [ws(), sse()]), rec('B', [ws(), sse()]))).toEqual([]);
    expect(diff(rec('A', [sse()]), rec('B', [sse(), ws()]))).toEqual([{ route: 'WS /socket', change: 'added', detail: '1 call, 101' }]);
  });

  it('mentions frames the proxy dropped', () => {
    const d = diff(rec('A', [ws()]), rec('B', [ws({ framesDropped: 7, frames: ws().frames!.slice(0, 3) })]));
    expect(d.find((x) => x.change === 'count')!.detail).toBe('frames: 4 → 3 (sent 2 → 1, received 2 → 2; older frames not recorded: 0 → 7)');
  });
});

describe('diffText with frames', () => {
  it('lists frames normalised: relative times, redacted text, volatile ids masked, SSE ids dropped', () => {
    const text = diffText(rec('A', [ws(), sse()]));
    expect(text).toContain('=== WS /socket — 1 call');
    expect(text).toContain('=== POST /v1/stream (SSE) — 1 call');
    expect(text).not.toContain(LIVE_KEY);
    expect(text).not.toContain('sec-websocket-key');
    expect(text).toContain('    frames: 4');
    expect(text).toContain('    +0.1s send text {"type":"auth","token":"[redacted]"}');
    expect(text).toContain('    +0.3s receive text {"type":"ack","requestId":"…","ts":"…"}');
    expect(text).toMatch(/ {4}\+0\.4s receive binary \[binary 4 bytes, sha256 [0-9a-f]{12}…\]/);
    expect(text).toContain('    +3.0s send close 1000 bye');
    expect(text).toContain('    +0.1s event delta id … {"t":"Hel"}');
    expect(text).toContain('    +1.5s event message line one\\ntoken: [redacted]');
  });

  it('is identical for two runs that differ only in timestamps, ids and handshake keys', () => {
    const run = (shift: number, id: string) =>
      ws({
        startedAt: T + shift,
        frames: [frame({ dir: 'receive', kind: 'text', at: T + shift + 250, text: `{"type":"ack","messageId":"${id}","at":"2026-10-10T12:00:0${shift % 10}Z","sub":"${id}-0000-4000-8000-000000000000"}` })],
      });
    const a = diffText(rec('X', [run(1000, 'aaaaaaaa')]));
    const b = diffText(rec('X', [run(5003, 'bbbbbbbb')]));
    expect(a).toBe(b);
  });

  it('marks truncated text frames, redacted binary frames and dropped frames', () => {
    const lines = frameLines(
      ws({
        framesDropped: 2,
        frames: [
          frame({ dir: 'receive', kind: 'text', at: T, text: 'abc', size: 99999, truncated: true }),
          redactFrame(frame({ dir: 'receive', kind: 'binary', at: T, base64: 'AQID', size: 3 })),
        ],
      }),
    );
    expect(lines).toEqual(['frames: 2 (2 older not recorded)', '+0.0s receive text abc [truncated, 99999 bytes]', '+0.0s receive binary [binary 3 bytes]']);
  });

  it('normaliseFrameText masks UUIDs, ISO times and id / time members but keeps plain ids', () => {
    expect(normaliseFrameText('{"id":7,"nonce":"x","traceId":"t","at":"2026-01-02T03:04:05.123Z","u":"123e4567-e89b-12d3-a456-426614174000"}')).toBe(
      '{"id":7,"nonce":"…","traceId":"…","at":"<time>","u":"<uuid>"}',
    );
  });
});
