// CONTRACTS §16.4 (v0.10.0) agent side: kind "grpc" in list / wait / assert (expect.grpcStatus), get_request on a gRPC
// call (info, trailers, decoded messages redacted, ≤ 20 each way), get_frames decoded, add_grpc_mock, get_grpc_schema,
// get_status grpc, add_mock / resend refusals, export_har with gRPC, access rules, LM texts.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, GRPC_MESSAGES_PER_DIR, type AgentApiDeps } from '../../../src/agent/api';
import { confirmationText, invocationMessage } from '../../../src/agent/lmTools';
import { toolAnnotations } from '../../../src/agent/mcp/server';
import { redactGrpcMetadata } from '../../../src/agent/redact';
import { parseToolInput } from '../../../src/agent/schema';
import { AgentToolError, isWriteTool, type AgentAccess, type AppLauncher } from '../../../src/agent/types';
import { validateRules } from '../../../src/ui/controller';
import { fakeGrpc, grpcCall, pb64 } from '../grpc.fakes';

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
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
  resume() {}
  abort() {}
  async send() {
    return { id: 'sent' };
  }
}

function setup(o: { redact?: boolean; access?: AgentAccess; grpc?: ReturnType<typeof fakeGrpc> | null; root?: string } = {}) {
  const host = new FakeHost();
  const launcher = { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher;
  let idn = 0;
  let now = 50_000;
  const grpc = o.grpc === null ? undefined : (o.grpc ?? fakeGrpc());
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: o.access ?? 'readWrite', redactSecrets: o.redact ?? true, interceptEnabled: true }),
    launcher,
    projectRoot: () => o.root ?? '/ws/app',
    newRuleId: () => `agent_${++idn}`,
    now: () => now,
    ...(grpc ? { grpc } : {}),
  };
  return { api: createAgentApi(deps), host, grpc, tick: (ms: number) => (now += ms) };
}

const rejectsWith = async (p: Promise<unknown>, re: RegExp, code?: AgentToolError['code']) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AgentToolError);
  expect((e as Error).message).toMatch(re);
  if (code) expect((e as AgentToolError).code).toBe(code);
};

const http = (id: string): Exchange => ({ id, startedAt: 4000, method: 'GET', url: 'https://api.example.com/x', requestHeaders: {}, state: 'completed', status: 200 });

describe('list / wait / assert with kind "grpc"', () => {
  it('list_requests filters gRPC calls; summaries carry the gRPC status', async () => {
    const { api, host } = setup();
    const ok = grpcCall({ id: 'ok' });
    const down = grpcCall({ id: 'down', grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 14, messagesSent: 1, messagesReceived: 0 } });
    host.exchanges = [http('h'), ok, down, { ...http('t'), kind: 'tunnel', grpcTunnel: true, method: 'CONNECT', status: undefined }];
    const r = (await api.call('list_requests', { kind: 'grpc' })) as { items: Record<string, any>[] };
    expect(r.items.map((i) => i.id).sort()).toEqual(['down', 'ok']);
    expect(r.items.find((i) => i.id === 'down')!.grpc).toEqual({ code: 14, status: 'UNAVAILABLE', messagesSent: 1, messagesReceived: 0 });
    const tunnels = (await api.call('list_requests', { kind: 'tunnel' })) as { items: Record<string, any>[] };
    expect(tunnels.items[0]).toMatchObject({ grpcTunnel: true, notDecrypted: true });
  });

  it('wait_for_request with kind grpc', async () => {
    const { api, host } = setup();
    host.exchanges = [{ ...http('h'), url: 'http://10.0.2.2:50051/shop.v1.CartService/AddItem', startedAt: 60_000 }];
    const p = api.call('wait_for_request', { url: '*/shop.v1.CartService/AddItem', kind: 'grpc', sinceMs: 0, timeoutMs: 1000 });
    const call = grpcCall({ id: 'g', startedAt: 60_001 });
    host.exchanges.push(call);
    host.emit('exchange', call);
    expect(await p).toMatchObject({ id: 'g', kind: 'grpc', timedOut: false });
  });

  it('assert_traffic expect.grpcStatus by code or name; non-gRPC exchanges fail it', async () => {
    const { api, host } = setup();
    host.exchanges = [grpcCall({ id: 'a' }), grpcCall({ id: 'b', grpc: { service: 's', method: 'm', statusCode: 5, statusMessage: 'secret detail', messagesSent: 1, messagesReceived: 0 } })];
    const pass = (await api.call('assert_traffic', { url: '*/AddItem', sinceMs: 0, expect: { grpcStatus: 'OK' } })) as any;
    expect(pass.pass).toBe(false);
    expect(pass.failures).toEqual([expect.stringMatching(/^b \(POST .*\): gRPC status 5 \(NOT_FOUND\), expected 0 \(OK\)$/)]);
    expect(JSON.stringify(pass.failures)).not.toMatch(/secret detail/);
    expect(((await api.call('assert_traffic', { url: '*/AddItem', sinceMs: 0, expect: { grpcStatus: 5, count: { exact: 1 } }, kind: 'grpc' })) as any).failures).toEqual([
      'count: expected exactly 1 request(s) matching */AddItem, got 2',
      expect.stringMatching(/^a .*gRPC status 0 \(OK\), expected 5 \(NOT_FOUND\)/),
    ]);
    host.exchanges = [{ ...http('h'), url: 'http://x/shop.v1.CartService/AddItem' }];
    expect(((await api.call('assert_traffic', { url: '*/AddItem', sinceMs: 0, expect: { grpcStatus: 0 } })) as any).failures[0]).toMatch(/not a gRPC call \(kind http\)/);
    expect(() => parseToolInput('assert_traffic', { url: '*', expect: { grpcStatus: 'BROKEN' } })).toThrow();
  });
});

describe('get_request / get_frames on a gRPC call', () => {
  it('shows info, redacted metadata and trailers, decoded messages with secret fields redacted', async () => {
    const { api, host } = setup();
    host.exchanges = [grpcCall({ id: 'g', grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 16, statusMessage: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig expired', messagesSent: 1, messagesReceived: 1, deadlineMs: 500 } })];
    const d = (await api.call('get_request', { id: 'g' })) as Record<string, any>;
    expect(d.grpc).toMatchObject({ service: 'shop.v1.CartService', method: 'AddItem', path: '/shop.v1.CartService/AddItem', code: 16, status: 'UNAUTHENTICATED', deadlineMs: 500, requestType: 'shop.v1.AddItemRequest', responseType: 'shop.v1.Cart', streaming: 'unary' });
    expect(d.grpc.statusMessage).toBe('token [redacted] expired');
    expect(d.requestHeaders).toMatchObject({ authorization: '[redacted]', 'x-session-bin': '[redacted]', te: 'trailers' });
    expect(d.responseTrailers).toEqual({ 'grpc-status': '0', 'set-cookie': '[redacted]', 'x-trace-bin': '[redacted]', 'x-region': 'eu' });
    expect(d.messages).toEqual([
      { index: 0, dir: 'send', at: 5001, size: 40, via: 'schema', json: { sku: 'A1', quantity: 2, sessionToken: '[redacted]' } },
      { index: 1, dir: 'receive', at: 5005, size: 30, via: 'schema', json: { items: [{ sku: 'A1' }], total: '1999' } },
    ]);
    expect(d).not.toHaveProperty('messagesNote');
    // unredacted when the user turned redaction off
    const raw = setup({ redact: false });
    raw.host.exchanges = [grpcCall({ id: 'g' })];
    expect(((await raw.api.call('get_request', { id: 'g' })) as any).messages[0].json.sessionToken).toBe('tok-123');
    // includeBodies false: no messages
    expect(await api.call('get_request', { id: 'g', includeBodies: false })).not.toHaveProperty('messages');
  });

  it('first 20 each way, ≤ 64 KB of JSON, raw without a schema', async () => {
    const { api, host } = setup({ grpc: fakeGrpc({ schema: null }) });
    const big = 'x'.repeat(5000);
    const frames = Array.from({ length: 30 }, (_, i) => ({ dir: (i % 2 ? 'receive' : 'send') as 'send' | 'receive', at: i, kind: 'message' as const, base64: pb64({ n: i, pad: big }), size: 5000 }));
    host.exchanges = [grpcCall({ id: 'g', frames: [...frames, ...frames.map((f) => ({ ...f, dir: 'receive' as const }))] })];
    const d = (await api.call('get_request', { id: 'g' })) as Record<string, any>;
    expect(d.messages.filter((m: any) => m.dir === 'send')).toHaveLength(15);
    expect(d.messages.filter((m: any) => m.dir === 'receive')).toHaveLength(GRPC_MESSAGES_PER_DIR);
    expect(d.messages[0].via).toBe('raw');
    expect(d.messages.some((m: any) => m.jsonOmitted)).toBe(true);
    expect(JSON.stringify(d.messages).length).toBeLessThan(70 * 1024);
    expect(d.messagesNote).toMatch(/get_frames.*without json.*no protobuf schema/s);
  });

  it('get_frames returns decoded, redacted messages and pages', async () => {
    const { api, host } = setup();
    host.exchanges = [grpcCall({ id: 'g', framesDropped: 4 })];
    const r = (await api.call('get_frames', { id: 'g', limit: 1 })) as Record<string, any>;
    expect(r.frames).toEqual([{ index: 4, dir: 'send', at: 5001, kind: 'message', size: 40, via: 'schema', text: JSON.stringify({ sku: 'A1', quantity: 2, sessionToken: '[redacted]' }) }]);
    expect(r).toMatchObject({ next: 5, total: 6, more: true, kind: 'grpc' });
    const r2 = (await api.call('get_frames', { id: 'g', since: 5, maxChars: 10 })) as Record<string, any>;
    expect(r2.frames[0]).toMatchObject({ index: 5, truncated: true, text: '{"items":[' });
  });

  it('resend_request refuses gRPC calls; add_mock refuses a known gRPC method', async () => {
    const { api, host } = setup();
    host.exchanges = [grpcCall({ id: 'g' })];
    await rejectsWith(api.call('resend_request', { id: 'g' }), /gRPC call/, 'invalid');
    await rejectsWith(api.call('add_mock', { url: '*/shop.v1.CartService/AddItem', body: {} }), /use add_grpc_mock/, 'invalid');
  });
});

describe('add_grpc_mock (CONTRACTS §16.4)', () => {
  it('JSON messages are checked with the schema and kept as messagesJson; [agent] name; times / ttlMs', async () => {
    const { api, host } = setup();
    const r = (await api.call('add_grpc_mock', { url: '*/shop.v1.CartService/AddItem', messages: [{ total: '5' }], code: 'UNAVAILABLE', message: 'down', delayMs: 10, gapMs: 3, times: 2, ttlMs: 5000 })) as any;
    expect(r).toEqual({ ruleId: 'agent_1', method: '/shop.v1.CartService/AddItem', code: 14, status: 'UNAVAILABLE', messages: 1 });
    expect(host.rules[0]).toMatchObject({
      id: 'agent_1',
      name: '[agent] gRPC mock /shop.v1.CartService/AddItem → 14 UNAVAILABLE (1 message)',
      match: { method: 'POST', url: '*/shop.v1.CartService/AddItem' },
      action: { kind: 'grpcMock', code: 14, message: 'down', messagesJson: [{ total: '5' }], delayMs: 10, gapMs: 3 },
      times: 2,
      expiresAt: 55_000,
    });
  });

  it('service + method, base64 messages, and trailers-only errors', async () => {
    const { api, host } = setup({ grpc: null });
    await api.call('add_grpc_mock', { service: 'shop.v1.CartService', method: 'AddItem', messages: [pb64({ a: 1 })], name: 'mine' });
    expect(host.rules[0]).toMatchObject({ name: '[agent] mine', match: { url: '*/shop.v1.CartService/AddItem' }, action: { kind: 'grpcMock', messages: [pb64({ a: 1 })] } });
    await api.call('add_grpc_mock', { url: '*/x.Y/Z', code: 16 });
    expect(host.rules[0].action).toEqual({ kind: 'grpcMock', code: 16 });
  });

  it('readable refusals', async () => {
    const { api } = setup();
    await rejectsWith(api.call('add_grpc_mock', { url: '*/shop.v1.CartService/AddItem', service: 'a.B', method: 'C' }), /not both/, 'invalid');
    await rejectsWith(api.call('add_grpc_mock', { service: 'a.B' }), /both service and method/, 'invalid');
    await rejectsWith(api.call('add_grpc_mock', { url: '*/shop.v1.CartService/AddItem', messages: [{ nope: 1 }] }), /messages\[0\] is not a valid shop\.v1\.Cart: \$\.nope/, 'invalid');
    await rejectsWith(api.call('add_grpc_mock', { url: '*/shop.v1.CartService/AddItm', messages: [{}] }), /no gRPC method \/shop\.v1\.CartService\/AddItm \(did you mean \/shop\.v1\.CartService\/AddItem/, 'not_found');
    await rejectsWith(api.call('add_grpc_mock', { url: '*/shop.v1.CartService/*', messages: [{}] }), /doesn't name one gRPC method/, 'invalid');
    await rejectsWith(api.call('add_grpc_mock', { url: '*/shop.v1.CartService/AddItem', messages: [{}, 'AA=='] }), /not both/, 'invalid');
    await rejectsWith(api.call('add_grpc_mock', { url: '*/shop.v1.CartService/AddItem', messages: ['%%%'] }), /not base64/, 'invalid');
    await rejectsWith(api.call('add_grpc_mock', { url: '*/x.Y/Z?session=abc' }), /pins the value of the query parameter "session"/, 'invalid');
    const noSchema = setup({ grpc: fakeGrpc({ schema: null }) });
    await rejectsWith(noSchema.api.call('add_grpc_mock', { url: '*/shop.v1.CartService/AddItem', messages: [{}] }), /no protobuf schema.*base64/, 'state');
    const g = fakeGrpc();
    g.on = false;
    await rejectsWith(setup({ grpc: g }).api.call('add_grpc_mock', { url: '*/shop.v1.CartService/AddItem', messages: [{}] }), /gRPC support is off/, 'state');
  });

  it('is a write tool: refused read-only; list_rules shows it redacted', async () => {
    expect(isWriteTool('add_grpc_mock')).toBe(true);
    expect(isWriteTool('get_grpc_schema')).toBe(false);
    expect(toolAnnotations('add_grpc_mock')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(toolAnnotations('get_grpc_schema')).toMatchObject({ readOnlyHint: true });
    await rejectsWith(setup({ access: 'readOnly' }).api.call('add_grpc_mock', { url: '*/x.Y/Z' }), /read-only/, 'access');
    const { api, host } = setup();
    host.rules = validateRules([{ id: 'u', enabled: true, match: { url: '*/x.Y/Z' }, action: { kind: 'grpcMock', messagesJson: [{ apiKey: 'k-1', id: 2 }], trailers: { authorization: 'Bearer x' } } }]);
    const rules = ((await api.call('list_rules', {})) as any).rules;
    expect(rules[0].action).toEqual({ kind: 'grpcMock', messagesJson: [{ apiKey: '[redacted]', id: 2 }], trailers: { authorization: '[redacted]' } });
  });
});

describe('get_grpc_schema (CONTRACTS §16.4)', () => {
  it('lists methods; describes a method with fields, enums, skeletons and project-relative files', async () => {
    const { api } = setup();
    const list = (await api.call('get_grpc_schema', {})) as any;
    expect(list).toMatchObject({ available: true, totalMethods: 2, messages: 4 });
    expect(list.methods[1]).toEqual({ path: '/shop.v1.CartService/Watch', requestType: 'shop.v1.WatchRequest', responseType: 'shop.v1.Cart', streaming: 'server streaming' });
    const m = (await api.call('get_grpc_schema', { method: 'shop.v1.CartService.AddItem' })) as any;
    expect(m).toMatchObject({ method: '/shop.v1.CartService/AddItem', streaming: 'unary', file: 'lib/gen/shop.pbgrpc.dart', line: 40 });
    expect(m.response.fields).toEqual([
      { number: 1, name: 'items', type: 'shop.v1.Cart.Line', repeated: true },
      { number: 2, name: 'total', type: 'int64' },
      { number: 3, name: 'color', type: 'enum shop.v1.Color' },
    ]);
    expect(m.response.enums).toEqual({ 'shop.v1.Color': ['RED', 'BLUE'] });
    expect(m.responseSkeleton).toEqual({ items: 0, total: 0, color: 0 });
    expect(m.request.file).toBe('lib/gen/shop.pb.dart');
  });

  it('messages by full, short or Dart name; enums; not found with suggestions', async () => {
    const { api } = setup();
    expect(((await api.call('get_grpc_schema', { message: 'Cart_Line' })) as any).message.name).toBe('shop.v1.Cart.Line');
    expect(((await api.call('get_grpc_schema', { message: '.shop.v1.Cart' })) as any).skeleton).toEqual({ items: 0, total: 0, color: 0 });
    expect(((await api.call('get_grpc_schema', { message: 'shop.v1.Color' })) as any).enum.values).toEqual([{ name: 'RED', number: 0 }, { name: 'BLUE', number: 1 }]);
    await rejectsWith(api.call('get_grpc_schema', { message: 'Car' }), /no message or enum "Car".*similar: shop\.v1\.Cart/, 'not_found');
    await rejectsWith(api.call('get_grpc_schema', { method: 'nope' }), /must look like/, 'invalid');
    await rejectsWith(api.call('get_grpc_schema', { method: '/a.B/C', message: 'X' }), /not both/, 'invalid');
  });

  it('available:false when off, missing or still loading; never an absolute path outside the project', async () => {
    expect(await setup({ grpc: null }).api.call('get_grpc_schema', {})).toMatchObject({ available: false, reason: expect.stringMatching(/not available/) });
    const g = fakeGrpc();
    g.on = false;
    expect(await setup({ grpc: g }).api.call('get_grpc_schema', {})).toMatchObject({ available: false, reason: expect.stringMatching(/off/) });
    expect(await setup({ grpc: fakeGrpc({ schema: null, status: { methods: 0, messages: 0, problems: ['x.pb.dart: odd'], files: 1 } }) }).api.call('get_grpc_schema', {})).toMatchObject({ available: false, problems: ['x.pb.dart: odd'] });
    const elsewhere = (await setup({ root: '/other' }).api.call('get_grpc_schema', { method: '/shop.v1.CartService/AddItem' })) as any;
    expect(elsewhere.file).toBe('shop.pbgrpc.dart');
  });
});

describe('get_status / export_har / redaction / LM texts', () => {
  it('get_status grpc', async () => {
    const { api, host } = setup();
    host.grpcDecryptHosts = ['grpc.example.com'];
    host.grpcProblem = 'self-check failed';
    expect(((await api.call('get_status', {})) as any).grpc).toEqual({ enabled: true, decryptHosts: ['grpc.example.com'], problem: 'self-check failed', schema: { methods: 2, messages: 4 } });
    expect(await setup({ grpc: null }).api.call('get_status', {})).not.toHaveProperty('grpc');
  });

  it('export_har writes gRPC entries with redacted decoded JSON', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-har-'));
    try {
      const { api, host } = setup({ root });
      host.exchanges = [grpcCall({ id: 'g' })];
      const r = (await api.call('export_har', {})) as { path: string };
      const har = JSON.parse(fs.readFileSync(r.path, 'utf8'));
      expect(har.log.entries[0]._grpc.messages[0].json.sessionToken).toBe('[redacted]');
      expect(har.log.entries[0]._grpc.messages[0]).not.toHaveProperty('data');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('redactGrpcMetadata blanks credentials and custom -bin metadata, keeps protocol fields', () => {
    const token = ['sk', 'live', 'x'.repeat(24)].join('_');
    expect(redactGrpcMetadata({ authorization: `Bearer ${token}`, 'x-user-bin': 'AAEC', 'grpc-status-details-bin': 'CAUS', 'grpc-message': 'not found', cookie: 'a=1', 'x-api-key': token, 'x-req': 'r1' })).toEqual({
      authorization: '[redacted]',
      'x-user-bin': '[redacted]',
      'grpc-status-details-bin': 'CAUS',
      'grpc-message': 'not found',
      cookie: '[redacted]',
      'x-api-key': '[redacted]',
      'x-req': 'r1',
    });
  });

  it('LM invocation and confirmation texts', () => {
    expect(invocationMessage('add_grpc_mock', { url: '*/a.B/C', code: 14 })).toBe('Adding gRPC mock for */a.B/C → 14 (UNAVAILABLE)');
    expect(invocationMessage('get_grpc_schema', {})).toBe("Listing the app's gRPC methods");
    expect(invocationMessage('get_grpc_schema', { method: '/a.B/C' })).toMatch(/\/a\.B\/C/);
    const c = confirmationText('add_grpc_mock', { service: 'a.B', method: 'C', messages: [{}, {}], message: 'x', times: 1 });
    expect(c.title).toBe('Add a gRPC mock rule');
    expect(c.message).toMatch(/`a\.B\/C` with \*\*2\*\* messages, then status \*\*OK\*\* with message `x`.*only the next matching request/s);
  });
});
