// CONTRACTS §16.4 (v0.10.0) controller: Status.grpc (re-broadcast on host 'grpc' and schema changes), decodeGrpc →
// grpcDecoded, createRuleFromExchange grpcMock (JSON when decodable, else base64) and the refusals, grpcMock validation,
// gRPC never recorded / resent, HAR export with _grpc (redacted: JSON only), notifications and OpenAPI skip.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { buildHar } from '../../src/agent/har';
import { selectExchanges } from '../../src/export/common';
import { createNotifyPolicy, describeOutcome, isFailure } from '../../src/notify/policy';
import { EXPORT_REDACT, EXPORT_KEEP, InterceptController, isRecordable, tunnelReason, validateRule, type ControllerDeps, type ControllerHost, type GrpcDecoded } from '../../src/ui/controller';
import type { HostMsg, Status } from '../../src/ui/protocol';
import { fakeGrpc, grpcCall, pb64 } from './grpc.fakes';

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  grpcDecryptHosts?: string[];
  grpcProblem?: string;
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
  resume() {}
  abort() {}
  async send() {
    return { id: 's' };
  }
}

const controllers: InterceptController[] = [];
afterEach(() => {
  while (controllers.length) controllers.pop()!.dispose();
});

function setup(extra: Partial<ControllerDeps> = {}) {
  const host = new FakeHost();
  let n = 0;
  const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, newRuleId: () => `r${++n}`, projectRoot: () => '/ws/app', ...extra });
  controllers.push(c);
  const msgs: HostMsg[] = [];
  c.attach((m) => msgs.push(m));
  const replies: HostMsg[] = [];
  return { host, c, msgs, replies, reply: (m: HostMsg) => replies.push(m) };
}
type GrpcStatusT = { enabled: boolean; decryptHosts: string[]; problem?: string; schema?: { methods: number; messages: number; problems: string[] } };
const lastStatus = (msgs: HostMsg[]) => (msgs.filter((m) => m.type === 'status').at(-1) as { status: Status & { grpc?: GrpcStatusT } } | undefined)?.status;
const errors = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);
const decodedOf = (replies: HostMsg[]) => (replies.find((m) => (m as { type: string }).type === 'grpcDecoded') as unknown as { id: string; decoded: GrpcDecoded } | undefined);

describe('Status.grpc (CONTRACTS §16.4)', () => {
  it('only with the schema service wired; host decrypt hosts / problem and schema counts', () => {
    expect(setup().c.status()).not.toHaveProperty('grpc');
    const g = fakeGrpc({ status: { methods: 2, messages: 4, problems: ['shop.pb.dart: unknown field type'], files: 3 } });
    const { host, c, msgs } = setup({ grpc: g });
    expect(c.status().grpc).toEqual({ enabled: true, decryptHosts: [], schema: { methods: 2, messages: 4, problems: ['shop.pb.dart: unknown field type'] } });
    host.grpcDecryptHosts = ['grpc.example.com'];
    host.grpcProblem = 'this proxy build cannot intercept gRPC';
    host.emit('grpc', {});
    expect(lastStatus(msgs)?.grpc).toMatchObject({ decryptHosts: ['grpc.example.com'], problem: 'this proxy build cannot intercept gRPC' });
    g.on = false;
    g.listeners.forEach((l) => l());
    expect(lastStatus(msgs)?.grpc).toEqual({ enabled: false, decryptHosts: ['grpc.example.com'], problem: 'this proxy build cannot intercept gRPC' });
  });
});

describe('decodeGrpc (CONTRACTS §16.4)', () => {
  it('answers grpcDecoded: method, schema-decoded JSON, hex, skeletons', async () => {
    const { host, c, replies, reply } = setup({ grpc: fakeGrpc() });
    const call = grpcCall();
    host.exchanges = [call];
    await c.handle({ type: 'decodeGrpc', id: call.id }, reply);
    const d = decodedOf(replies)!;
    expect(d.id).toBe(call.id);
    expect(d.decoded.method).toEqual({ requestType: 'shop.v1.AddItemRequest', responseType: 'shop.v1.Cart', clientStreaming: false, serverStreaming: false, file: 'lib/gen/shop.pbgrpc.dart' });
    expect(d.decoded.messages).toHaveLength(2);
    expect(d.decoded.messages[0]).toMatchObject({ dir: 'send', via: 'schema', size: 40 });
    expect(JSON.parse(d.decoded.messages[0].json!)).toEqual({ sku: 'A1', quantity: 2, sessionToken: 'tok-123' }); // the user's own panel: unredacted
    expect(d.decoded.messages[1].hex).toBe(Buffer.from(call.frames![1].base64!, 'base64').toString('hex'));
    expect(JSON.parse(d.decoded.skeletons!.response!)).toEqual({ items: 0, total: 0, color: 0 });
    expect(d.decoded.problem).toBeUndefined();
    expect(d.decoded.framesDropped).toBe(0);
  });

  it('framesDropped matches the frames the panel holds', async () => {
    const { host, c, replies, reply } = setup({ grpc: fakeGrpc() });
    const frames = Array.from({ length: 205 }, (_, i) => ({ dir: 'receive' as const, at: i, kind: 'message' as const, base64: pb64({ total: String(i) }), size: 20 }));
    const call = grpcCall({ frames, framesDropped: 3 });
    host.exchanges = [call];
    await c.handle({ type: 'decodeGrpc', id: call.id }, reply);
    const d = decodedOf(replies)!.decoded;
    expect(d.framesDropped).toBe(8);
    expect(d.messages).toHaveLength(200);
    expect(JSON.parse(d.messages[0].json!)).toEqual({ total: '5' });
  });

  it('Status.grpc.schema is sent once loaded, even with no methods', () => {
    const { c } = setup({ grpc: fakeGrpc({ schema: null, status: { methods: 0, messages: 0, problems: [], files: 0 } }) });
    expect(c.status().grpc?.schema).toEqual({ methods: 0, messages: 0, problems: [] });
  });

  it('raw without a schema (with a problem), hex only when gRPC is off, errors for other exchanges', async () => {
    const t = setup({ grpc: fakeGrpc({ schema: null }) });
    const call = grpcCall();
    t.host.exchanges = [call, { ...grpcCall(), id: 'h', kind: undefined }, { id: 't', kind: 'tunnel', grpcTunnel: true, method: 'CONNECT', url: 'https://grpc.example.com:443/', requestHeaders: {}, startedAt: 1, state: 'completed' }];
    await t.c.handle({ type: 'decodeGrpc', id: call.id }, t.reply);
    const d = decodedOf(t.replies)!.decoded;
    expect(d.messages.map((m) => m.via)).toEqual(['raw', 'raw']);
    expect(d.problem).toMatch(/No protobuf schema/);
    expect(d.method).toBeUndefined();
    await t.c.handle({ type: 'decodeGrpc', id: 'h' }, t.reply);
    await t.c.handle({ type: 'decodeGrpc', id: 't' }, t.reply);
    await t.c.handle({ type: 'decodeGrpc', id: 'gone' }, t.reply);
    expect(errors(t.replies)).toEqual(['This exchange is not a gRPC call.', expect.stringMatching(/flutterIntercept\.grpc\.decryptHosts/), 'That exchange is no longer available.']);

    const g = fakeGrpc();
    g.on = false;
    const off = setup({ grpc: g });
    off.host.exchanges = [call];
    await off.c.handle({ type: 'decodeGrpc', id: call.id }, off.reply);
    expect(decodedOf(off.replies)!.decoded.problem).toMatch(/gRPC support is off/);
  });
});

describe('createRuleFromExchange grpcMock (CONTRACTS §16.4)', () => {
  it('JSON messages when the schema decodes them, its status, custom metadata only', async () => {
    const { host, c, reply } = setup({ grpc: fakeGrpc() });
    const call = grpcCall({ grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 5, statusMessage: 'no such sku', messagesSent: 1, messagesReceived: 1 } });
    host.exchanges = [call];
    await c.handle({ type: 'createRuleFromExchange', id: call.id, action: 'grpcMock' }, reply);
    const rule = host.rules[0];
    expect(rule.match).toEqual({ method: 'POST', url: 'http://10.0.2.2:50051/shop.v1.CartService/AddItem' });
    expect(rule.action).toEqual({
      kind: 'grpcMock',
      code: 5,
      message: 'no such sku',
      messagesJson: [{ items: [{ sku: 'A1' }], total: '1999' }],
      headers: { 'x-request-id': 'r-1' },
      trailers: { 'set-cookie': 'sid=1', 'x-trace-bin': 'AQID', 'x-region': 'eu' },
    });
    expect(rule.name).toBe('gRPC mock /shop.v1.CartService/AddItem → 5 (1 message)');
  });

  it('base64 messages without a schema; refusals for other kinds, unfinished or truncated calls', async () => {
    const t = setup({ grpc: fakeGrpc({ schema: null }) });
    const call = grpcCall();
    t.host.exchanges = [
      call,
      grpcCall({ id: 'open', state: 'pending' }),
      grpcCall({ id: 'big', frames: [{ dir: 'receive', at: 1, kind: 'message', base64: 'AA==', size: 999999, truncated: true }] }),
      { id: 'h', startedAt: 1, method: 'GET', url: 'https://api.example.com/x', requestHeaders: {}, state: 'completed', status: 200 },
    ];
    await t.c.handle({ type: 'createRuleFromExchange', id: call.id, action: 'grpcMock' }, t.reply);
    expect(t.host.rules[0].action).toMatchObject({ kind: 'grpcMock', messages: [call.frames![1].base64] });
    expect(t.host.rules[0].action).not.toHaveProperty('code');
    for (const [id, action] of [
      [call.id, 'mock'],
      [call.id, 'breakpoint'],
      ['open', 'grpcMock'],
      ['big', 'grpcMock'],
      ['h', 'grpcMock'],
    ] as const) {
      await t.c.handle({ type: 'createRuleFromExchange', id, action }, t.reply);
    }
    expect(errors(t.replies)).toEqual([
      expect.stringMatching(/an HTTP mock rule from a gRPC call/),
      expect.stringMatching(/a breakpoint rule from a gRPC call/),
      expect.stringMatching(/has not finished yet/),
      expect.stringMatching(/too large to record/),
      expect.stringMatching(/isn't a gRPC call/),
    ]);
    // block works on a gRPC call
    await t.c.handle({ type: 'createRuleFromExchange', id: call.id, action: 'block' }, t.reply);
    expect(t.host.rules[0].action).toEqual({ kind: 'block', mode: 'status', status: 403 });
  });

  it('gRPC calls are neither recordable nor resendable; tunnels explain the decrypt setting', async () => {
    const t = setup();
    const call = grpcCall();
    t.host.exchanges = [call];
    expect(isRecordable(call)).toBe(false);
    await t.c.handle({ type: 'send', request: { method: 'POST', url: call.url }, resentFrom: call.id }, t.reply);
    expect(errors(t.replies)[0]).toMatch(/Can't resend a gRPC call/);
    await t.c.handle({ type: 'mutateField', id: call.id, path: '$.a', op: 'null' }, t.reply);
    expect(errors(t.replies)[1]).toMatch(/gRPC call/);
    expect(tunnelReason({ id: 't', kind: 'tunnel', grpcTunnel: true, method: 'CONNECT', url: 'https://grpc.example.com:443/', requestHeaders: {}, startedAt: 1, state: 'completed' })).toMatch(/gRPC over TLS to grpc\.example\.com, not decrypted.*flutterIntercept\.grpc\.decryptHosts/);
  });
});

describe('validateRule grpcMock (CONTRACTS §16.2)', () => {
  const rule = (action: Record<string, unknown>) => ({ id: 'a', enabled: true, match: { method: 'POST', url: '*/shop.v1.CartService/AddItem' }, action: { kind: 'grpcMock', ...action } });
  it('accepts the documented fields', () => {
    expect(validateRule(rule({ code: 14, message: 'down', messages: [pb64({ a: 1 })], headers: { 'x-a': '1' }, trailers: { 'x-b-bin': 'AQID' }, delayMs: 10, gapMs: 5 })).action.kind).toBe('grpcMock');
    expect(validateRule(rule({ messagesJson: [{ a: 1 }, { b: [1, 2] }] })).action).toEqual({ kind: 'grpcMock', messagesJson: [{ a: 1 }, { b: [1, 2] }] });
    // inside a sequence step too
    expect(validateRule({ id: 's', enabled: true, match: { url: '*/x.Y/Z' }, action: { kind: 'sequence', steps: [{ action: { kind: 'grpcMock', code: 14 } }, { action: { kind: 'passthrough' } }] } }).action.kind).toBe('sequence');
  });
  it('refuses bad codes, both message forms, non-base64, reserved metadata, bad timings, unknown keys', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ code: -1 }, /code must be a gRPC status code/],
      [{ code: 1.5 }, /code must be/],
      [{ message: 'x'.repeat(5000) }, /message must be text/],
      [{ messages: ['AA=='], messagesJson: [{}] }, /not both/],
      [{ messages: ['not base64!'] }, /messages\[0\] must be base64/],
      [{ messages: 'AA==' }, /messages must be a list/],
      [{ messagesJson: [() => 1] }, /messagesJson\[0\] must be a JSON value/],
      [{ headers: { 'content-type': 'text/plain' } }, /"content-type" can't be set by a gRPC mock/],
      [{ trailers: { 'grpc-status': '0' } }, /"grpc-status" can't be set/],
      [{ trailers: { ':status': '200' } }, /invalid header name|can't be set/],
      [{ headers: { 'x-a': 'a\r\nb' } }, /CR, LF or NUL/],
      [{ delayMs: -5 }, /delayMs must be/],
      [{ gapMs: 700_000 }, /gapMs must be/],
      [{ body: 'x' }, /unknown field "body"/],
    ];
    for (const [a, re] of bad) expect(() => validateRule(rule(a)), JSON.stringify(a)).toThrow(re);
  });
});

describe('HAR / notifications / OpenAPI with gRPC (CONTRACTS §16.4)', () => {
  it('HAR: unredacted carries base64 + JSON; redacted carries redacted JSON only and redacted metadata', () => {
    const call = grpcCall();
    const decode = (e: Exchange) => (e.frames ?? []).filter((f) => f.kind === 'message').map((f) => JSON.parse(Buffer.from(f.base64!, 'base64').toString('utf8').slice(3)));
    const raw = buildHar([call], { redact: false, grpcDecode: decode }) as any;
    const entry = raw.log.entries[0];
    expect(entry.request.httpVersion).toBe('HTTP/2');
    expect(entry._grpc).toMatchObject({ service: 'shop.v1.CartService', method: 'AddItem', statusCode: 0, messagesSent: 1, messagesReceived: 1 });
    expect(entry._grpc.messages[0]).toMatchObject({ type: 'send', size: 40, data: call.frames![0].base64, json: { sessionToken: 'tok-123' } });
    expect(entry._grpc.trailers).toContainEqual({ name: 'set-cookie', value: 'sid=1' });
    expect(entry._webSocketMessages).toBeUndefined();
    expect(entry._eventSourceMessages).toBeUndefined();

    const red = (buildHar([call], { redact: true, grpcDecode: decode }) as any).log.entries[0];
    expect(red._grpc.messages[0]).not.toHaveProperty('data');
    expect(red._grpc.messages[0].json).toEqual({ sku: 'A1', quantity: 2, sessionToken: '[redacted]' });
    expect(red._grpc.trailers).toEqual(expect.arrayContaining([{ name: 'set-cookie', value: '[redacted]' }, { name: 'x-trace-bin', value: '[redacted]' }, { name: 'x-region', value: 'eu' }, { name: 'grpc-status', value: '0' }]));
    expect(red.request.headers).toEqual(expect.arrayContaining([{ name: 'authorization', value: '[redacted]' }, { name: 'x-session-bin', value: '[redacted]' }, { name: 'te', value: 'trailers' }]));
    // no decoder: redacted messages are summarised
    const blind = (buildHar([call], { redact: true }) as any).log.entries[0];
    expect(blind._grpc.messages[1]).toMatchObject({ data: '[binary 30 bytes]' });
  });

  it('the panel export includes gRPC calls in HAR with the schema decoder', async () => {
    const writes: { file: string; text: string }[] = [];
    const t = setup({
      grpc: fakeGrpc(),
      pickOne: async () => EXPORT_REDACT,
      showSaveDialog: async () => '/ws/app/out.har',
      writeFile: async (file, text) => void writes.push({ file, text }),
      gitFs: { kind: async () => undefined, readFile: async () => '' },
    });
    t.host.exchanges = [grpcCall()];
    await t.c.exportTraffic('har');
    const har = JSON.parse(writes[0].text);
    expect(har.log.entries[0]._grpc.messages[0].json.sessionToken).toBe('[redacted]');
    expect(EXPORT_KEEP).toBeTruthy();
  });

  it('notifications: gRPC status other than OK / CANCELLED is a failure, described by code name', () => {
    const fail = grpcCall({ grpc: { service: 's', method: 'm', statusCode: 14, statusMessage: 'upstream connect error [x](command:evil)', messagesSent: 1, messagesReceived: 0 } });
    expect(isFailure(fail, 'errors')).toBe(true);
    expect(isFailure(grpcCall(), 'errors')).toBe(false);
    expect(isFailure(grpcCall({ grpc: { service: 's', method: 'm', statusCode: 1, messagesSent: 0, messagesReceived: 0 } }), 'all')).toBe(false);
    expect(describeOutcome(fail)).toBe('gRPC 14 UNAVAILABLE: upstream connect error ［x］（command:evil）');
    const p = createNotifyPolicy({ level: 'errors' });
    expect(p.onExchange(fail, 100_000, false)?.text).toMatch(/^POST \/shop\.v1\.CartService\/AddItem failed: gRPC 14 UNAVAILABLE/);
  });

  it('OpenAPI / Postman selection skips gRPC calls with a note', () => {
    const s = selectExchanges([grpcCall(), { id: 'h', startedAt: 1, method: 'GET', url: 'https://api.example.com/x', requestHeaders: {}, state: 'completed', status: 200 }]);
    expect(s.samples.map((x) => x.e.id)).toEqual(['h']);
    expect(s.notes).toContain('1 gRPC call skipped (export them as HAR)');
  });
});
