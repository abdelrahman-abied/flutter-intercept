// CONTRACTS §10.2: the `mutate` rule action — the real response, with JSON fields changed before the
// app gets it. Node clients, plus a real dart:io client reading the JSON like a generated model.
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { presetProfile, ruleFromExchange, type Exchange, type InterceptProxy, type MutateOp, type Rule } from '../src';
import { inState, nextExchange, selfSignedCert, settled, sleep, startProxy, viaProxy } from './helpers';

// 9007199254740993 = 2^53 + 1: JavaScript can't hold it, Dart's int can. 1.0 must stay a double for Dart.
const USER = '{"login":"octo","id":9007199254740993,"avatar_url":"https://avatars.example/u/1.png","price":1.0,"items":[{"id":1,"price":2.50},{"id":2,"price":3.0}]}';
const USER_NULL_AVATAR = USER.replace('"https://avatars.example/u/1.png"', 'null');
const MB = 1024 * 1024;

interface Up {
  httpUrl: string;
  httpsUrl: string;
  hits: string[];
  bodies: string[];
  close(): Promise<void>;
}

const json = { 'content-type': 'application/json; charset=utf-8' };

const handler = (hits: string[], bodies: string[]): http.RequestListener => async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const u = new URL(req.url ?? '/', 'http://x');
  hits.push(`${req.method} ${u.pathname}`);
  bodies.push(Buffer.concat(chunks).toString('utf8'));
  switch (u.pathname) {
    case '/user':
      res.writeHead(200, { ...json, 'content-length': Buffer.byteLength(USER), 'content-md5': 'stale', etag: '"v1"' }).end(USER);
      return;
    case '/user.gz': {
      const z = zlib.gzipSync(USER);
      res.writeHead(200, { ...json, 'content-encoding': 'gzip', 'content-length': z.length }).end(z);
      return;
    }
    case '/user.br': // chunked
      res.writeHead(200, { ...json, 'content-encoding': 'br' }).end(zlib.brotliCompressSync(USER));
      return;
    case '/user.deflate':
      res.writeHead(200, { ...json, 'content-encoding': 'deflate' }).end(zlib.deflateRawSync(USER)); // raw deflate, as some servers send
      return;
    case '/user.zstd': {
      const z = (zlib as unknown as { zstdCompressSync?: (b: string) => Buffer }).zstdCompressSync;
      if (!z) return void res.writeHead(500).end('no zstd');
      res.writeHead(200, { ...json, 'content-encoding': 'zstd' }).end(z(USER));
      return;
    }
    case '/user.chunked': {
      res.writeHead(200, json); // chunked, several writes
      for (let i = 0; i < USER.length; i += 20) {
        res.write(USER.slice(i, i + 20));
        await sleep(2);
      }
      res.end();
      return;
    }
    case '/user.bom':
      res.writeHead(200, json).end(`﻿${USER}`);
      return;
    case '/user.pretty':
      res.writeHead(200, json).end(JSON.stringify({ a: 1, list: [1, 2] }, null, 2));
      return;
    case '/slow-json':
      res.writeHead(200, json);
      res.write('{"a":');
      setTimeout(() => res.end('1}'), Number(u.searchParams.get('ms') ?? 500));
      return;
    case '/many-objects': {
      // REVIEW-4 #4: ~32 MB of [{},{},…] (≈ 10.6 M values).
      const n = Math.floor((32 * MB - 16) / 3);
      res.writeHead(200, json).end(`[${'{},'.repeat(n - 1)}{}]`);
      return;
    }
    case '/list': {
      const body = JSON.stringify(Array.from({ length: 100_000 }, (_, i) => ({ id: i, d: 'x' })));
      res.writeHead(200, json).end(body);
      return;
    }
    case '/text':
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
      return;
    case '/bad':
      res.writeHead(200, json).end('{"login":');
      return;
    case '/latin1':
      res.writeHead(200, json).end(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d])); // {"a":"é"} in Latin-1
      return;
    case '/corrupt-gzip':
      res.writeHead(200, { ...json, 'content-encoding': 'gzip' }).end(zlib.gzipSync(USER).subarray(0, 30));
      return;
    case '/empty':
      res.writeHead(204).end();
      return;
    case '/error-json':
      res.writeHead(422, json).end('{"error":{"code":"bad","field":"email"}}');
      return;
    case '/bomb': {
      // 33 MB decoded, a few KB on the wire.
      const z = zlib.gzipSync(Buffer.concat([Buffer.from('{"a":"'), Buffer.alloc(33 * MB, 'a'), Buffer.from('"}')]));
      res.writeHead(200, { ...json, 'content-encoding': 'gzip', 'content-length': z.length }).end(z);
      return;
    }
    case '/huge':
      res.writeHead(200, json).end(Buffer.concat([Buffer.from('{"a":"'), Buffer.alloc(33 * MB, 'a'), Buffer.from('"}')]));
      return;
    case '/echo': {
      const out = JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString('utf8'), secret: 's' });
      res.writeHead(200, json).end(out);
      return;
    }
    default:
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
};

async function startUp(): Promise<Up> {
  const hits: string[] = [];
  const bodies: string[] = [];
  const h = http.createServer(handler(hits, bodies));
  const { key, cert } = await selfSignedCert();
  const s = https.createServer({ key, cert }, handler(hits, bodies));
  h.listen(0, '127.0.0.1');
  s.listen(0, '127.0.0.1');
  await Promise.all([once(h, 'listening'), once(s, 'listening')]);
  return {
    httpUrl: `http://127.0.0.1:${(h.address() as AddressInfo).port}`,
    httpsUrl: `https://127.0.0.1:${(s.address() as AddressInfo).port}`,
    hits,
    bodies,
    async close() {
      h.closeAllConnections();
      s.closeAllConnections();
      await Promise.all([new Promise((r) => h.close(r)), new Promise((r) => s.close(r))]);
    },
  };
}

let up: Up;
let proxy: InterceptProxy;

beforeAll(async () => {
  up = await startUp();
});
afterAll(async () => {
  await up?.close();
});
beforeEach(async () => {
  proxy = await startProxy();
  up.hits.length = 0;
  up.bodies.length = 0;
});
afterEach(async () => {
  await proxy.stop();
});

const mutate = (ops: MutateOp[], r: Partial<Rule> = {}): Rule => ({ id: 'mut', enabled: true, match: { url: '*' }, action: { kind: 'mutate', ops }, ...r });
const AVATAR_NULL: MutateOp[] = [{ path: '$.avatar_url', op: 'null' }];

function decode(body: Buffer, enc: string | string[] | undefined): string {
  if (enc === 'gzip') return zlib.gunzipSync(body).toString('utf8');
  if (enc === 'br') return zlib.brotliDecompressSync(body).toString('utf8');
  if (enc === 'deflate') return zlib.inflateSync(body).toString('utf8');
  if (enc === 'zstd') return (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(body).toString('utf8');
  return body.toString('utf8');
}

const lastCompleted = async (): Promise<Exchange> => {
  const all = await settled(proxy);
  return all[all.length - 1];
};

describe('mutate rule', () => {
  it('the classic: $.avatar_url → null; everything else byte-identical, re-framed, labelled', async () => {
    proxy.setRules([mutate(AVATAR_NULL)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/user`);
    expect(r.status).toBe(200);
    expect(r.text).toBe(USER_NULL_AVATAR); // 1.0, 2.50 and 2^53+1 written exactly as the server sent them
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength(USER_NULL_AVATAR)));
    expect(r.headers['transfer-encoding']).toBeUndefined();
    expect(r.headers['content-md5']).toBeUndefined(); // would no longer match
    expect(r.headers.etag).toBe('"v1"');
    const ex = await lastCompleted();
    expect(ex).toMatchObject({
      state: 'completed',
      status: 200,
      matchedRuleId: 'mut',
      simulated: 'Mutated: $.avatar_url → null',
      responseBody: { text: USER_NULL_AVATAR, encoding: 'utf8' },
    });
    expect(ex.error).toBeUndefined();
    expect(ex.responseHeaders?.['content-length']).toBe(String(Buffer.byteLength(USER_NULL_AVATAR)));
    expect(up.hits).toEqual(['GET /user']); // forwarded to the real server once
  });

  it('several ops: set / delete / wildcard; HTTPS (CONNECT); label lists up to 3', async () => {
    proxy.setRules([
      mutate([
        { path: '$.items[*].price', op: 'set', value: '42' },
        { path: '$.login', op: 'delete' },
        { path: '$.items[0]', op: 'delete' },
        { path: '$.extra', op: 'set', value: { a: [1.5] } },
      ]),
    ]);
    const r = await viaProxy(proxy.port, `${up.httpsUrl}/user`);
    expect(r.text).toBe('{"id":9007199254740993,"avatar_url":"https://avatars.example/u/1.png","price":1.0,"items":[{"id":2,"price":"42"}],"extra":{"a":[1.5]}}');
    const ex = await lastCompleted();
    expect(ex.simulated).toBe('Mutated: $.items[*].price → "42", $.login removed, $.items[0] removed (+1 more)');
    expect(ex.url).toBe(`${up.httpsUrl}/user`);
  });

  it.each([
    ['gzip with content-length', '/user.gz', 'gzip'],
    ['br, chunked upstream', '/user.br', 'br'],
    ['raw deflate', '/user.deflate', 'deflate'],
    ['zstd', '/user.zstd', 'zstd'],
  ])('%s: decoded, mutated, re-encoded with the same encoding and an exact content-length', async (_name, p, enc) => {
    if (enc === 'zstd' && !(zlib as unknown as { zstdCompressSync?: unknown }).zstdCompressSync) return;
    proxy.setRules([mutate(AVATAR_NULL)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}${p}`);
    expect(r.headers['content-encoding']).toBe(enc);
    expect(r.headers['content-length']).toBe(String(r.body.length));
    expect(r.headers['transfer-encoding']).toBeUndefined();
    expect(decode(r.body, enc)).toBe(USER_NULL_AVATAR);
    const ex = await lastCompleted();
    expect(ex).toMatchObject({ state: 'completed', simulated: 'Mutated: $.avatar_url → null', responseBody: { text: USER_NULL_AVATAR } });
  });

  it('chunked identity upstream (many small chunks): buffered, mutated, sent with a content-length', async () => {
    proxy.setRules([mutate(AVATAR_NULL)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/user.chunked`);
    expect(r.text).toBe(USER_NULL_AVATAR);
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength(USER_NULL_AVATAR)));
    expect(r.headers['transfer-encoding']).toBeUndefined();
  });

  it('a UTF-8 BOM is accepted and kept; error responses are mutated too; pretty JSON comes back compact', async () => {
    proxy.setRules([mutate([...AVATAR_NULL, { path: '$.error.field', op: 'null' }, { path: '$.a', op: 'null' }])]);
    const bom = await viaProxy(proxy.port, `${up.httpUrl}/user.bom`);
    expect(bom.text).toBe(`﻿${USER_NULL_AVATAR}`);
    const err = await viaProxy(proxy.port, `${up.httpUrl}/error-json`);
    expect(err.status).toBe(422);
    expect(err.text).toBe('{"error":{"code":"bad","field":null}}');
    expect((await viaProxy(proxy.port, `${up.httpUrl}/user.pretty`)).text).toBe('{"a":null,"list":[1,2]}');
    const all = await settled(proxy);
    expect(all.map((e) => e.state)).toEqual(['completed', 'completed', 'completed']);
    expect(all[0].simulated).toBe('Mutated: $.avatar_url → null'); // only the ops that changed something
    expect(all[1].simulated).toBe('Mutated: $.error.field → null');
    expect(all.map((e) => e.error)).toEqual([
      'Mutate rule: nothing matched $.error.field, $.a (the other changes were applied).',
      'Mutate rule: nothing matched $.avatar_url, $.a (the other changes were applied).',
      'Mutate rule: nothing matched $.avatar_url, $.error.field (the other changes were applied).',
    ]);
  });

  it.each([
    ['not JSON', '/text', 'hello', /the body is not valid JSON \(Unexpected "h" at position 0\)/],
    ['invalid JSON', '/bad', '{"login":', /the body is not valid JSON \(Unexpected end of JSON at position 9\)/],
    ['not UTF-8', '/latin1', '{"a":"�"}', /not UTF-8 text/],
    ['corrupt gzip', '/corrupt-gzip', undefined, /could not be decoded/],
    ['no body', '/empty', '', /has no body/],
  ])('%s: forwarded unchanged, note in error, state completed', async (_name, p, text, note) => {
    proxy.setRules([mutate(AVATAR_NULL)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}${p}`);
    if (text !== undefined) expect(r.text).toBe(text);
    const ex = await lastCompleted();
    expect(ex.state).toBe('completed');
    expect(ex.matchedRuleId).toBe('mut');
    expect(ex.simulated).toBeUndefined();
    expect(ex.error).toMatch(note);
    expect(ex.error).toMatch(/^Mutate rule not applied: .*; the response was forwarded unchanged\.$/);
  });

  it('corrupt gzip is forwarded byte for byte (the app sees what it would have seen)', async () => {
    proxy.setRules([mutate(AVATAR_NULL)]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/corrupt-gzip`);
    expect(r.body.equals(zlib.gzipSync(USER).subarray(0, 30))).toBe(true);
  });

  it('valueJson: the set value lands byte-exact (1.0, big ints, nested), wins over value, labelled as written', async () => {
    proxy.setRules([
      mutate([
        { path: '$.price', op: 'set', valueJson: '2.0' },
        { path: '$.id', op: 'set', value: 1, valueJson: '12345678901234567890' },
        { path: '$.items[0]', op: 'set', valueJson: '{"id":1e3,"price":-0}' },
      ]),
    ]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/user.gz`);
    expect(zlib.gunzipSync(r.body).toString('utf8')).toBe(
      '{"login":"octo","id":12345678901234567890,"avatar_url":"https://avatars.example/u/1.png","price":2.0,"items":[{"id":1e3,"price":-0},{"id":2,"price":3.0}]}',
    );
    const ex = await lastCompleted();
    expect(ex.simulated).toBe('Mutated: $.price → 2.0, $.id → 12345678901234567890, $.items[0] → {"id":1e3,"price":-0}');
  });

  it('nothing matched / bad path / no ops: forwarded unchanged with a note', async () => {
    for (const [ops, note] of [
      [[{ path: '$.nope', op: 'null' }], /nothing in the body matched \$\.nope/],
      [[{ path: 'avatar_url', op: 'null' }], /Invalid JSON path "avatar_url"/],
      [[{ path: '$.a', op: 'set' }], /needs a value/],
      [[{ path: '$.price', op: 'set', valueJson: '1.0.0' }], /invalid valueJson \(Unexpected "\." after the JSON value at position 3\)/],
      [[{ path: '$.price', op: 'set', valueJson: '' }], /invalid valueJson/],
      [[], /the rule has no operations/],
    ] as [MutateOp[], RegExp][]) {
      proxy.clear();
      proxy.setRules([mutate(ops)]);
      const r = await viaProxy(proxy.port, `${up.httpUrl}/user`);
      expect(r.text).toBe(USER);
      expect(r.headers['content-md5']).toBe('stale'); // untouched response
      const ex = await lastCompleted();
      expect(ex.state).toBe('completed');
      expect(ex.simulated).toBeUndefined();
      expect(ex.error).toMatch(note);
    }
  });

  it('decoded body over 32 MB (small on the wire): forwarded unchanged with a note', async () => {
    proxy.setRules([mutate([{ path: '$.a', op: 'null' }])]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/bomb`);
    expect(r.status).toBe(200);
    expect(zlib.gunzipSync(r.body).length).toBe(33 * MB + 8);
    const ex = await lastCompleted();
    expect(ex.state).toBe('completed');
    expect(ex.error).toMatch(/larger than 32 MB decoded/);
  });

  it('upstream body over 32 MB: 502 that says why (like a response breakpoint), never buffered', async () => {
    proxy.setRules([mutate([{ path: '$.a', op: 'null' }])]);
    const errored = nextExchange(proxy, inState('error'));
    const r = await viaProxy(proxy.port, `${up.httpUrl}/huge`);
    expect(r.status).toBe(502);
    expect(r.text).toMatch(/larger than 32 MB.*mutate rule/);
    expect((await errored).error).toMatch(/larger than 32 MB/);
  });

  it('REVIEW-4 #4: 32 MB of [{},…] is refused quickly without stalling the event loop or ballooning memory', async () => {
    proxy.setRules([mutate([{ path: '$[0]', op: 'null' }])]);
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const rss0 = process.memoryUsage().rss;
    try {
      const r = await viaProxy(proxy.port, `${up.httpUrl}/many-objects`);
      expect(r.body.length).toBeGreaterThan(31 * MB); // forwarded unchanged
      expect(r.text.startsWith('[{},{},')).toBe(true);
    } finally {
      clearInterval(timer);
    }
    const ex = await lastCompleted();
    expect(ex.state).toBe('completed');
    expect(ex.error).toMatch(/too large to change \(more than 2000000 JSON values\)/);
    expect(maxGap).toBeLessThan(500); // was 1.9 s synchronous
    expect(process.memoryUsage().rss - rss0).toBeLessThan(1024 * MB); // was +3.1 GB
  });

  it('REVIEW-4 #4: fan-out × value size over the budget → not applied, with the reason', async () => {
    proxy.setRules([mutate([{ path: '$[*].d', op: 'set', value: 'y'.repeat(1024) }])]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/list`);
    expect(JSON.parse(r.text)[0]).toEqual({ id: 0, d: 'x' });
    const ex = await lastCompleted();
    expect(ex.state).toBe('completed');
    expect(ex.error).toMatch(/^Mutate rule not applied: applyOps: op 0 \(\$\[\*\]\.d\) is too large: 100000 places × 1026 bytes would exceed 64 MB/);
    // within budget it applies
    proxy.setRules([mutate([{ path: '$[*].d', op: 'set', value: 'y' }])]);
    expect(JSON.parse((await viaProxy(proxy.port, `${up.httpUrl}/list`)).text)[99_999]).toEqual({ id: 99_999, d: 'y' });
  });

  it('request side unchanged: the body reaches the server as sent; only the response is mutated', async () => {
    proxy.setRules([mutate([{ path: '$.secret', op: 'delete' }], { match: { method: 'POST', url: '*/echo' } })]);
    const sent = '{"id":1.0,"q":"x"}';
    const r = await viaProxy(proxy.port, `${up.httpUrl}/echo`, { method: 'POST', body: sent, headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(r.text)).toEqual({ method: 'POST', body: sent });
    expect(up.bodies).toEqual([sent]);
    const ex = await lastCompleted();
    expect(ex.requestBody).toEqual({ text: sent, encoding: 'utf8' });
    // GET to the same URL doesn't match the POST rule.
    expect(JSON.parse((await viaProxy(proxy.port, `${up.httpUrl}/echo`)).text).secret).toBe('s');
  });

  it('a streamed (chunked) request body skips the rule with a note, passed through unedited', async () => {
    proxy.setRules([mutate([{ path: '$.secret', op: 'delete' }])]);
    const text = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: `${up.httpUrl}/echo`, headers: { host: new URL(up.httpUrl).host }, agent: false });
      req.on('error', reject);
      req.on('response', (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve(t));
      });
      req.write('part1,');
      req.end('part2');
    });
    expect(JSON.parse(text)).toEqual({ method: 'POST', body: 'part1,part2', secret: 's' });
    const ex = await lastCompleted();
    expect(ex).toMatchObject({ state: 'completed', matchedRuleId: 'mut' });
    expect(ex.error).toMatch(/^Mutate rule skipped: the request body is streamed/);
  });

  it('times: counts toward times (rule-hit / rule-spent), then the real response again', async () => {
    const hits: [string, number][] = [];
    const spent: string[] = [];
    proxy.on('rule-hit', (id, n) => hits.push([id, n]));
    proxy.on('rule-spent', (id) => spent.push(id));
    proxy.setRules([mutate(AVATAR_NULL, { times: 2 })]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/user`)).text).toBe(USER_NULL_AVATAR);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/user`)).text).toBe(USER_NULL_AVATAR);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/user`)).text).toBe(USER);
    await sleep(10);
    expect(hits).toEqual([['mut', 1], ['mut', 2]]);
    expect(spent).toEqual(['mut']);
    const all = await settled(proxy);
    expect(all.map((e) => e.matchedRuleId)).toEqual(['mut', 'mut', undefined]);
  });

  it('network profile: offline fails it like any pass-through; a throttle profile still mutates (both labels)', async () => {
    proxy.setRules([mutate(AVATAR_NULL)]);
    proxy.setNetworkProfile({ kind: 'offline' });
    await expect(viaProxy(proxy.port, `${up.httpUrl}/user`)).rejects.toThrow();
    let ex = await lastCompleted();
    expect(ex).toMatchObject({ state: 'blocked', simulated: 'Offline', matchedRuleId: 'mut' });
    expect(up.hits).toEqual([]);

    proxy.clear();
    proxy.setNetworkProfile(presetProfile('fast-3g'));
    const t0 = Date.now();
    expect((await viaProxy(proxy.port, `${up.httpUrl}/user`)).text).toBe(USER_NULL_AVATAR);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    ex = await lastCompleted();
    expect(ex).toMatchObject({ state: 'completed', simulated: 'Fast 3G · Mutated: $.avatar_url → null' });
  });

  it('send() goes through the rule: the recorded exchange is mutated', async () => {
    proxy.setRules([mutate(AVATAR_NULL)]);
    const { id } = await proxy.send({ method: 'GET', url: `${up.httpsUrl}/user`, initiator: 'agent' });
    const ex = await nextExchange(proxy, (e) => e.id === id && e.state === 'completed');
    expect(ex).toMatchObject({ initiator: 'agent', simulated: 'Mutated: $.avatar_url → null', responseBody: { text: USER_NULL_AVATAR } });
  });

  it('the app leaving while the response is buffered is recorded as error, the proxy keeps serving', async () => {
    proxy.setRules([mutate([{ path: '$.a', op: 'null' }])]);
    const errored = nextExchange(proxy, inState('error'));
    await expect(viaProxy(proxy.port, `${up.httpUrl}/slow-json?ms=600`, { timeoutMs: 100 })).rejects.toThrow();
    expect((await errored).error).toBeTruthy();
    proxy.setRules([mutate(AVATAR_NULL)]);
    expect((await viaProxy(proxy.port, `${up.httpUrl}/user`)).text).toBe(USER_NULL_AVATAR);
  });

  it('ruleFromExchange(e, "mutate") gives the route match and an empty ops list to fill in', async () => {
    await viaProxy(proxy.port, `${up.httpUrl}/user?x=1`);
    const [ex] = await settled(proxy);
    const r = ruleFromExchange(ex, 'mutate', 'id1');
    expect(r).toMatchObject({ id: 'id1', enabled: true, match: { method: 'GET', url: `${up.httpUrl}/user*` }, action: { kind: 'mutate', ops: [] } });
  });
});

// ---------------------------------------------------------------- real Dart client

describe('real dart:io client reading the JSON like a model', () => {
  let tmp: string;
  let exe: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-mutate-'));
    exe = path.join(tmp, process.platform === 'win32' ? 'mutate_client.exe' : 'mutate_client');
    execFileSync('dart', ['compile', 'exe', path.join(__dirname, 'fixtures', 'mutate_client.dart'), '-o', exe], { stdio: 'pipe' });
  }, 120_000);
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (url: string) =>
    new Promise<Record<string, string>>((resolve) => {
      execFile(exe, [String(proxy.port), url], { timeout: 60_000 }, (_err, stdout) => {
        const out: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          const sp = line.indexOf(' ');
          if (sp > 0) out[line.slice(0, sp)] = line.slice(sp + 1);
        }
        resolve(out);
      });
    });

  it('without a rule: the model reads fine (price is a double, id an exact int)', async () => {
    const out = await run(`${up.httpsUrl}/user.gz`);
    expect(out).toMatchObject({ STATUS: '200', BODY: USER, AVATAR: 'https://avatars.example/u/1.png', PRICE: '1.0', ID: '9007199254740993' });
  });

  it('$.avatar_url → null reproduces "Null is not a subtype of String" — and nothing else changes', async () => {
    proxy.setRules([mutate(AVATAR_NULL)]);
    // (dart:io decompresses gzip only; br / zstd are covered with the Node client above.)
    for (const p of ['/user', '/user.gz', '/user.chunked']) {
      const out = await run(`${up.httpsUrl}${p}`);
      expect(out.BODY, p).toBe(USER_NULL_AVATAR);
      expect(out.AVATAR_ERROR, p).toMatch(/type 'Null' is not a subtype of type 'String'/);
      expect(out.PRICE, p).toBe('1.0'); // still a double: re-serialising didn't turn 1.0 into 1
      expect(out.ID, p).toBe('9007199254740993');
    }
    const all = await settled(proxy);
    expect(all.map((e) => [e.state, e.simulated])).toEqual(Array(3).fill(['completed', 'Mutated: $.avatar_url → null']));
  }, 60_000);

  it('valueJson "2.0" keeps price a double for Dart; value 2 (a JS number) arrives as an int', async () => {
    proxy.setRules([mutate([{ path: '$.price', op: 'set', valueJson: '2.0' }, { path: '$.id', op: 'set', valueJson: '9007199254740995' }])]);
    let out = await run(`${up.httpsUrl}/user`);
    expect(out).toMatchObject({ PRICE: '2.0', ID: '9007199254740995', AVATAR: 'https://avatars.example/u/1.png' });
    proxy.setRules([mutate([{ path: '$.price', op: 'set', value: 2.0 }])]);
    out = await run(`${up.httpsUrl}/user`);
    expect(out.PRICE_ERROR).toMatch(/type 'int' is not a subtype of type 'double'/);
  });

  it('retyping a field ("42" for a double) reaches the app as the new type', async () => {
    proxy.setRules([mutate([{ path: '$.price', op: 'set', value: '42' }])]);
    const out = await run(`${up.httpUrl}/user`);
    expect(out.PRICE_ERROR).toMatch(/type 'String' is not a subtype of type 'double'/);
    expect(out.AVATAR).toBe('https://avatars.example/u/1.png');
  });
});
