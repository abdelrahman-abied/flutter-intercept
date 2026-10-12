// CONTRACTS §17 (v0.11.0) host side: the proxy codec (setGrpcCodec), `.proto` discovery, gRPC resume edits and the
// held message in decodeGrpc, breakpoint / mutate rules from gRPC calls, and recordings v3 (save, redaction, load,
// validation, replay entries, diff).
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, GrpcProxyCodec, InterceptProxyOptions, Rule } from '@flutter-intercept/proxy';
import { discoverGrpcFiles, isGrpcSchemaPath } from '../../src/grpc/discovery';
import { grpcProxyCodec } from '../../src/grpc/service';
import { InterceptProxyHost } from '../../src/proxyHost';
import { grpcMessageHash } from '@flutter-intercept/proxy';
import { diff } from '../../src/recordings/diff';
import { firstRequestHash } from '../../src/recordings/grpc';
import { createRecordingService } from '../../src/recordings/store';
import { toReplay } from '../../src/recordings/replay';
import { validateRecording } from '../../src/recordings/validate';
import { InterceptController, recordingSummary, resolveGrpcEdit, validateGrpcEdit, type ControllerHost } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';
import { fakeGrpc, grpcCall, pb, pb64 } from './grpc.fakes';


describe('grpcProxyCodec (CONTRACTS §17.3)', () => {
  it('decodes by path + direction, never throws on decode; encode names the JSON path', () => {
    const c = grpcProxyCodec(fakeGrpc());
    expect(c.decode('/shop.v1.CartService/AddItem', 'receive', pb({ total: '1' }))).toEqual({ total: '1' });
    expect(c.decode('/x.Y/Z', 'receive', pb({}))).toBeUndefined();
    expect(c.decode('/shop.v1.CartService/AddItem', 'receive', new Uint8Array(Buffer.from('garbage')))).toBeUndefined();
    expect(c.decode('/shop.v1.CartService/AddItem', 'receive', new Uint8Array(4 * 1024 * 1024 + 1))).toBeUndefined();
    expect(Buffer.from(c.encode('/shop.v1.CartService/AddItem', 'send', { sku: 'B' })).toString()).toBe('PB:{"sku":"B"}');
    expect(() => c.encode('/shop.v1.CartService/AddItem', 'receive', { nope: 1 })).toThrow(/\$\.nope/);
    expect(() => c.encode('/x.Y/Z', 'receive', {})).toThrow(/no schema for \/x\.Y\/Z/);
    const throwing = fakeGrpc();
    throwing.codec.decodeMessage = () => {
      throw new Error('boom');
    };
    expect(grpcProxyCodec(throwing).decode('/shop.v1.CartService/AddItem', 'receive', pb({}))).toBeUndefined();
    const off = fakeGrpc();
    off.on = false;
    expect(grpcProxyCodec(off).decode('/shop.v1.CartService/AddItem', 'receive', pb({}))).toBeUndefined();
  });

  it('the host applies it to the proxy, after restarts and on refreshGrpcMocks', async () => {
    const made: { codecs: unknown[] }[] = [];
    const host = new InterceptProxyHost(withFakeProxy({
      getPort: () => 9100,
      canRestart: () => true,
      factory: (opts: InterceptProxyOptions) => {
        const ee = new EventEmitter();
        const f = { codecs: [] as unknown[] };
        made.push(f);
        return {
          port: opts.port ?? 0,
          start: async () => undefined,
          stop: async () => undefined,
          setRules: () => undefined,
          getExchanges: () => [],
          clear: () => undefined,
          resume: () => undefined,
          abort: () => undefined,
          on: (ev: string, l: (...a: any[]) => void) => ee.on(ev, l),
          setGrpcCodec: (c?: GrpcProxyCodec) => void f.codecs.push(c),
        };
      },
    }));
    const codec = grpcProxyCodec(fakeGrpc());
    host.setGrpcCodec(codec);
    await host.start();
    expect(made[0].codecs).toEqual([codec]);
    host.refreshGrpcMocks();
    expect(made[0].codecs).toHaveLength(2);
    await host.stop();
    await host.start();
    expect(made[1].codecs).toEqual([codec]);
    host.setGrpcCodec(undefined);
    expect(made[1].codecs.at(-1)).toBeUndefined();
  });
});

describe('.proto discovery (CONTRACTS §17.5)', () => {
  it('finds .proto files in the workspace (not in node_modules / build / Pods), with labels', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-proto-')));
    try {
      const w = (p: string) => {
        fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        fs.writeFileSync(path.join(dir, p), 'syntax = "proto3";');
      };
      w('protos/shop/v1/shop.proto');
      w('node_modules/x/y.proto');
      w('build/z.proto');
      w('ios/Pods/p.proto');
      w('lib/gen/shop.pbgrpc.dart');
      const r = await discoverGrpcFiles([dir]);
      expect(r.files.map((f) => f.label).sort()).toEqual(['lib/gen/shop.pbgrpc.dart', 'protos/shop/v1/shop.proto']);
      expect(isGrpcSchemaPath('/a/b/shop.proto')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gRPC resume edits (CONTRACTS §17.2 / §17.6)', () => {
  const msgPause = { kind: 'message' as const, dir: 'receive' as const, index: 0, base64: pb64({ total: '1', sessionToken: 'tok' }), size: 30 };
  const statusPause = { kind: 'status' as const, code: 0, trailers: { 'x-a': '1' } };

  it('validates one of message / messageJson / drop for a held message, status (+ trailers) for the end', () => {
    expect(validateGrpcEdit(undefined, msgPause)).toBeUndefined();
    expect(validateGrpcEdit({}, msgPause)).toBeUndefined();
    expect(validateGrpcEdit({ drop: true }, msgPause)).toEqual({ drop: true });
    expect(validateGrpcEdit({ message: 'AA==' }, msgPause)).toEqual({ message: 'AA==' });
    expect(validateGrpcEdit({ messageJson: { a: 1 } }, msgPause)).toEqual({ messageJson: { a: 1 } });
    expect(validateGrpcEdit({ status: { code: 14, message: 'down' }, trailers: { 'x-b': '2' } }, statusPause)).toEqual({ status: { code: 14, message: 'down' }, trailers: { 'x-b': '2' } });
    const bad: [unknown, typeof msgPause | typeof statusPause | undefined, RegExp][] = [
      [{ drop: true, message: 'AA==' }, msgPause, /exactly one/],
      [{ drop: false }, msgPause, /drop must be true/],
      [{ message: 'not base64!' }, msgPause, /base64/],
      [{ message: 'A'.repeat(6 * 1024 * 1024) }, msgPause, /at most 4 MB/],
      [{ status: { code: 1 } }, msgPause, /only apply when the call is held at its end/],
      [{ drop: true }, statusPause, /only apply to a held message/],
      [{ trailers: { a: '1' } }, statusPause, /pass status/],
      [{ status: { code: 17 } }, statusPause, /0–16/],
      [{ status: { code: 2, extra: 1 } }, statusPause, /unknown field "extra"/],
      [{ status: { code: 2 }, trailers: { 'grpc-status': '0' } }, statusPause, /can't be set/],
      [{ status: { code: 2 }, trailers: { 'x-a': 'a\nb' } }, statusPause, /CR, LF/],
      [{ drop: true }, undefined, /not held at a gRPC breakpoint/],
      [{ bogus: 1 }, msgPause, /unknown field "bogus"/],
    ];
    for (const [raw, pause, re] of bad) expect(() => validateGrpcEdit(raw, pause), JSON.stringify(raw)).toThrow(re);
  });

  it('messageJson is encoded with the call type of the held direction; encode errors are thrown', () => {
    const call = grpcCall({ state: 'paused-response', grpcPause: msgPause });
    expect(resolveGrpcEdit(call, { messageJson: { total: '9' } }, fakeGrpc())).toEqual({ message: pb64({ total: '9' }) });
    expect(() => resolveGrpcEdit(call, { messageJson: { nope: 1 } }, fakeGrpc())).toThrow(/as the response of \/shop\.v1\.CartService\/AddItem: \$\.nope/);
    expect(() => resolveGrpcEdit(call, { messageJson: {} }, undefined)).toThrow(/pass message \(base64\)/);
    expect(resolveGrpcEdit({ ...call, grpcPause: { ...msgPause, dir: 'send' } }, { messageJson: { sku: 'Z' } }, fakeGrpc())).toEqual({ message: pb64({ sku: 'Z' }) });
  });
});

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 1;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  resumed: unknown[][] = [];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  setRules(r: Rule[]) {
    this.rules = r;
  }
  clear() {}
  resume(id: string, edit?: unknown) {
    this.resumed.push([id, edit]);
  }
  abort() {}
}

describe('controller with gRPC pauses and rules (CONTRACTS §17)', () => {
  const controllers: InterceptController[] = [];
  afterEach(() => {
    while (controllers.length) controllers.pop()!.dispose();
  });
  const setup = () => {
    const host = new FakeHost();
    let n = 0;
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, newRuleId: () => `r${++n}`, grpc: fakeGrpc() });
    controllers.push(c);
    const replies: HostMsg[] = [];
    return { host, c, replies, reply: (m: HostMsg) => replies.push(m) };
  };

  it('resume: messageJson encoded; a bad edit keeps the call paused; decodeGrpc shows the held message', async () => {
    const { host, c, replies, reply } = setup();
    const call = grpcCall({ id: 'p', state: 'paused-response', pausedAt: 6000, grpcPause: { kind: 'message', dir: 'receive', index: 0, base64: pb64({ total: '1' }), size: 14 } });
    host.exchanges = [call];
    await c.handle({ type: 'decodeGrpc', id: 'p' }, reply);
    const dec = (replies.at(-1) as any).decoded;
    expect(dec.paused).toMatchObject({ index: 0, dir: 'receive', via: 'schema', size: 14 });
    expect(JSON.parse(dec.paused.json)).toEqual({ total: '1' });
    await c.handle({ type: 'resume', id: 'p', edit: { messageJson: { nope: 1 } } }, reply);
    expect(host.resumed).toEqual([]);
    expect((replies.at(-1) as any).message).toMatch(/\$\.nope/);
    await c.handle({ type: 'resume', id: 'p', edit: { messageJson: { total: '2' } } }, reply);
    expect(host.resumed).toEqual([['p', { message: pb64({ total: '2' }) }]]);
    // an HTTP edit shape is refused for a gRPC pause
    await c.handle({ type: 'resume', id: 'p', edit: { status: 500, body: 'x' } }, reply);
    expect(host.resumed).toHaveLength(1);
  });

  it('breakpoint and mutate rules can be made from a gRPC call', async () => {
    const { host, c, reply } = setup();
    const call = grpcCall({ id: 'g' });
    host.exchanges = [call];
    await c.handle({ type: 'createRuleFromExchange', id: 'g', action: 'breakpoint' }, reply);
    expect(host.rules[0]).toMatchObject({ match: { method: 'POST', url: 'http://10.0.2.2:50051/shop.v1.CartService/AddItem*' }, action: { kind: 'breakpoint', phase: 'response' } });
    await c.handle({ type: 'mutateField', id: 'g', path: '$.total', op: 'set', valueJson: '"0"' }, reply);
    expect(host.rules[0].action).toEqual({ kind: 'mutate', ops: [{ path: '$.total', op: 'set', valueJson: '"0"' }] });
  });
});

// ------------------------------------------------------------------ recordings v3

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-grec-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const svc = (grpc: ReturnType<typeof fakeGrpc> | null = fakeGrpc()) => createRecordingService({ root: () => root, now: () => 1, ...(grpc ? { grpc } : {}) });
const sha = (b: string) => createHash('sha256').update(Buffer.from(b, 'base64')).digest('hex');

describe('recordings with gRPC (CONTRACTS §17.4)', () => {
  it('saves version 3 with the file form, loads it back, counts it, replays it', async () => {
    const s = svc();
    const call = grpcCall({ responseTrailers: { 'grpc-status': '0', 'x-region': 'eu' } });
    const meta = await s.save('Cart', [call, grpcCall({ id: 'open', state: 'pending', grpc: { service: 's', method: 'm', messagesSent: 1, messagesReceived: 0 } })]);
    expect(meta).toMatchObject({ exchanges: 1, grpc: 1 });
    const text = fs.readFileSync(meta.path, 'utf8');
    const file = JSON.parse(text);
    expect(file.version).toBe(3);
    expect(file.grpc).toBe(1);
    const entry = file.entries[0];
    expect(entry).toMatchObject({ kind: 'grpc', method: 'POST', grpc: { code: 0, trailers: { 'x-region': 'eu' }, requestHash: sha(call.frames![0].base64!) } });
    expect(entry).not.toHaveProperty('responseTrailers');
    expect(entry.frames).toHaveLength(2);
    expect((await s.list())[0]).toMatchObject({ grpc: 1 });
    expect(recordingSummary((await s.list())[0])).toMatchObject({ grpc: 1 });
    const rec = await s.load(meta.id);
    expect(rec.version).toBe(3);
    expect(rec.entries[0]).toMatchObject({ kind: 'grpc', grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 0, messagesSent: 1, messagesReceived: 1 }, responseTrailers: { 'x-region': 'eu' } });
    const [r] = toReplay(rec);
    expect(r).toMatchObject({ kind: 'grpc', method: 'POST', url: call.url, status: 200, grpc: { code: 0, trailers: { 'x-region': 'eu' }, requestHash: sha(call.frames![0].base64!) } });
    expect(r.headers).toEqual({ 'x-request-id': 'r-1' });
    expect(r.frames!.map((f) => f.dir)).toEqual(['send', 'receive']);
  });

  it('redacted: schema re-encode with secrets redacted; zero bytes without a schema; metadata redacted', async () => {
    const call = grpcCall();
    const meta = await svc().save('R', [call], { redact: true });
    const e = JSON.parse(fs.readFileSync(meta.path, 'utf8')).entries[0];
    expect(Buffer.from(e.frames[0].base64, 'base64').toString()).toBe('PB:{"sku":"A1","quantity":2,"sessionToken":"[redacted]"}');
    expect(e.requestHeaders).toMatchObject({ authorization: '[redacted]', 'x-session-bin': '[redacted]' });
    expect(e.grpc.trailers).toMatchObject({ 'set-cookie': '[redacted]', 'x-trace-bin': '[redacted]' });
    expect(e.grpc.requestHash).toBeUndefined(); // REVIEW-11 #2: no hash of the unredacted request
    const blind = await svc(null).save('R2', [call], { redact: true });
    const e2 = JSON.parse(fs.readFileSync(blind.path, 'utf8')).entries[0];
    for (const f of e2.frames) expect(Buffer.from(f.base64, 'base64').every((x: number) => x === 0)).toBe(true);
    expect(e2.frames[0].size).toBe(40);
    expect(fs.readFileSync(blind.path, 'utf8')).not.toContain('tok-123');
  });

  it("requestHash equals the proxy's grpcMessageHash over the first request frame's recorded bytes (also when cut)", () => {
    const b = pb64({ sku: 'A1' });
    expect(firstRequestHash([{ dir: 'receive', at: 0, kind: 'message', base64: 'AA==', size: 1 }, { dir: 'send', at: 1, kind: 'message', base64: b, size: 9 }])).toBe(grpcMessageHash(Buffer.from(b, 'base64')));
    expect(firstRequestHash([{ dir: 'send', at: 1, kind: 'message', base64: b, size: 99_999, truncated: true }])).toBe(grpcMessageHash(Buffer.from(b, 'base64')));
    expect(firstRequestHash([{ dir: 'send', at: 1, kind: 'message', base64: b, size: 9, dropped: true }])).toBeUndefined();
  });

  it('incomplete calls are saved, marked, and not replayed; dropped messages are left out; gaps capped at 5 s', async () => {
    const cut = grpcCall({ frames: [{ dir: 'receive', at: 1, kind: 'message', base64: 'AA==', size: 999999, truncated: true }] });
    const gaps = grpcCall({
      frames: [
        { dir: 'send', at: 1000, kind: 'message', base64: pb64({ a: 1 }), size: 9 },
        { dir: 'receive', at: 2000, kind: 'message', base64: pb64({ a: 2 }), size: 9 },
        { dir: 'receive', at: 2500, kind: 'message', base64: pb64({ a: 3 }), size: 9, dropped: true },
        { dir: 'receive', at: 60_000, kind: 'message', base64: pb64({ a: 4 }), size: 9 },
      ],
    });
    const meta = await svc().save('I', [cut, gaps]);
    const rec = await svc().load(meta.id);
    expect(rec.entries.map((e) => (e as any).incomplete ?? false)).toEqual([true, false]);
    expect(rec.entries[1].frames).toHaveLength(3);
    const replay = toReplay(rec);
    expect(replay).toHaveLength(1);
    expect(replay[0].frames!.map((f) => f.at)).toEqual([1000, 2000, 7000]);
  });

  it('validation refuses malformed gRPC entries and gRPC in older versions', async () => {
    const meta = await svc().save('V', [grpcCall()]);
    const good = JSON.parse(fs.readFileSync(meta.path, 'utf8'));
    const bad: [(d: any) => void, RegExp][] = [
      [(d) => (d.version = 2), /gRPC entries need version 3/],
      [(d) => (d.entries[0].method = 'GET'), /must be POST/],
      [(d) => (d.entries[0].grpc = undefined), /grpc must be an object/],
      [(d) => (d.entries[0].grpc.code = -1), /code must be a canonical gRPC status code/],
      [(d) => (d.entries[0].grpc.requestHash = 'xyz'), /sha256/],
      [(d) => (d.entries[0].grpc.extra = 1), /unknown field/],
      [(d) => (d.entries[0].frames[0].kind = 'text'), /must be "message" in a gRPC recording/],
      [(d) => (d.entries[0].frames[0].text = 'x'), /not allowed on a message frame/],
      [(d) => (d.entries[0].responseBody = { text: 'x', encoding: 'utf8' }), /must not have bodies/],
      [(d) => (d.entries[0].incomplete = 'yes'), /incomplete must be true/],
      [(d) => ((d.entries[0].kind = undefined), (d.entries[0].frames = undefined)), /grpc is only allowed on gRPC calls/],
    ];
    for (const [mut, re] of bad) {
      const d = JSON.parse(JSON.stringify(good));
      mut(d);
      expect(() => validateRecording(d, 'v', '/v.json'), String(re)).toThrow(re);
    }
  });

  it('diff: gRPC routes, status and message count changes, first response message shape', async () => {
    const a = await svc().load((await svc().save('A', [grpcCall()])).id);
    const changed = grpcCall({
      grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 14, messagesSent: 1, messagesReceived: 2 },
      frames: [
        { dir: 'send', at: 1, kind: 'message', base64: pb64({ sku: 'A1' }), size: 9 },
        { dir: 'receive', at: 2, kind: 'message', base64: pb64({ items: [], total: 1999, color: 'RED' }), size: 9 },
        { dir: 'receive', at: 3, kind: 'message', base64: pb64({ total: '1' }), size: 9 },
      ],
    });
    const b = await svc().load((await svc().save('B', [changed])).id);
    const d = diff(a, b, fakeGrpc());
    expect(d).toEqual(
      expect.arrayContaining([
        { route: 'gRPC /shop.v1.CartService/AddItem', change: 'status', detail: 'gRPC OK → UNAVAILABLE' },
        { route: 'gRPC /shop.v1.CartService/AddItem', change: 'count', detail: 'messages: received 1 → 2' },
        { route: 'gRPC /shop.v1.CartService/AddItem', change: 'shape', detail: 'type total: string → int' },
        { route: 'gRPC /shop.v1.CartService/AddItem', change: 'shape', detail: '+field color (string)' },
      ]),
    );
    expect(diff(a, b).some((x) => x.change === 'shape')).toBe(false); // no schema: no shape
    expect(svc().diffText(b)).toMatch(/gRPC 14 UNAVAILABLE/);
    const empty = await svc().load((await svc().save('C', [{ id: 'h', startedAt: 1, method: 'GET', url: 'https://x.example/a', requestHeaders: {}, status: 200, state: 'completed' }])).id);
    // two origins: routes carry the origin
    expect(diff(a, empty)).toContainEqual({ route: 'gRPC http://10.0.2.2:50051/shop.v1.CartService/AddItem', change: 'removed', detail: '1 call, gRPC OK' });
  });
});

// ------------------------------------------------------------------ REVIEW-11 fixes
import { clearHeldMessageCache, decodeHeldMessage, MAX_VIEW_DECODE_BYTES } from '../../src/grpc/service';
import { MAX_PROTO_FILES } from '../../src/grpc/discovery';
import { withFakeProxy } from './proxy.fakes';

describe('REVIEW-11', () => {
  it('#2: redacted recordings keep no requestHash (save, redacted export); unredacted ones do', async () => {
    const call = grpcCall();
    const s = svc();
    const red = await s.save('R', [call], { redact: true });
    expect(JSON.parse(fs.readFileSync(red.path, 'utf8')).entries[0].grpc).not.toHaveProperty('requestHash');
    expect(toReplay(await s.load(red.id))[0].grpc).not.toHaveProperty('requestHash');
    const plain = await s.save('P', [call]);
    expect(JSON.parse(fs.readFileSync(plain.path, 'utf8')).entries[0].grpc.requestHash).toMatch(/^[0-9a-f]{64}$/);
    const out = path.join(root, 'shared.json');
    await s.export(plain.id, out, { redact: true });
    const exported = JSON.parse(fs.readFileSync(out, 'utf8')).entries[0];
    expect(exported.grpc).not.toHaveProperty('requestHash');
    expect(fs.readFileSync(out, 'utf8')).not.toContain('tok-123');
  });

  it('#8: status codes outside 0–16 are refused in files and left out when saving', async () => {
    const s = svc();
    const meta = await s.save('C', [grpcCall(), grpcCall({ id: 'odd', grpc: { service: 's', method: 'm', statusCode: 20, messagesSent: 1, messagesReceived: 1 } })]);
    expect(meta.exchanges).toBe(1);
    const d = JSON.parse(fs.readFileSync(meta.path, 'utf8'));
    d.entries[0].grpc.code = 17;
    expect(() => validateRecording(d, 'c', '/c.json')).toThrow(/canonical gRPC status code \(0–16\): calls that ended with another code can't be replayed/);
  });

  it('#8: .proto files have their own cap, separate from the generated Dart', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-pcap-')));
    try {
      fs.mkdirSync(path.join(dir, 'protos'));
      for (let i = 0; i < MAX_PROTO_FILES + 3; i++) fs.writeFileSync(path.join(dir, 'protos', `p${i}.proto`), '');
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib', 'a.pbgrpc.dart'), '');
      const r = await discoverGrpcFiles([dir]);
      expect(r.files.filter((f) => f.path.endsWith('.proto'))).toHaveLength(MAX_PROTO_FILES);
      expect(r.files.some((f) => f.path.endsWith('a.pbgrpc.dart'))).toBe(true);
      expect(r.problems).toContain(`gRPC schema: only the first ${MAX_PROTO_FILES} .proto files are read`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#6: the held message is decoded once per pause (LRU), again after a schema change, and not beyond 1 MB', () => {
    clearHeldMessageCache();
    const g = fakeGrpc();
    let calls = 0;
    const real = g.codec.decodeMessage;
    g.codec.decodeMessage = (...a) => (calls++, real(...a));
    const e = grpcCall({ id: 'h1', state: 'paused-response', pausedAt: 7, grpcPause: { kind: 'message', dir: 'receive', index: 0, base64: pb64({ total: '1' }), size: 14 } });
    const a = decodeHeldMessage(e, g);
    const b = decodeHeldMessage(e, g);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(a).toMatchObject({ via: 'schema', json: { total: '1' } });
    decodeHeldMessage({ ...e, grpcPause: { ...(e.grpcPause as any), index: 1 } }, g); // the next held message
    expect(calls).toBe(2);
    const big = 'A'.repeat(Math.ceil(((MAX_VIEW_DECODE_BYTES + 4) * 4) / 3 / 4) * 4);
    const huge = decodeHeldMessage({ ...e, id: 'h2', grpcPause: { kind: 'message', dir: 'receive', index: 0, base64: big, size: MAX_VIEW_DECODE_BYTES + 4 } }, g)!;
    expect(calls).toBe(2);
    expect(huge.via).toBe('none');
    expect(huge.error).toMatch(/over the 1 MB shown decoded/);
    expect(huge.bytes!.length).toBe(4098);
    expect(decodeHeldMessage(grpcCall(), g)).toBeUndefined();
  });
});
