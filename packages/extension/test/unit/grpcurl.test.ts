// CONTRACTS §19.2: the grpcurl snippet (flags, -proto / -import-path, -d, metadata, quoting, redaction, no schema),
// the panel's copySnippet for gRPC rows, agents' get_request snippet "grpcurl", gRPC-Web (`grpc.web`) in agent views
// and HAR.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../src/agent/api';
import { buildHar } from '../../src/agent/har';
import { parseToolInput } from '../../src/agent/schema';
import { AgentToolError, type AppLauncher } from '../../src/agent/types';
import { toGrpcurl } from '../../src/codegen/grpcurl';
import { SNIPPET_FORMATS } from '../../src/codegen/snippets';
import { InterceptController, validateRules, type ControllerHost } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';
import { fakeGrpc, fakeSchema, grpcCall, MESSAGES, METHODS, pb64 } from './grpc.fakes';

const protoSchema = () =>
  fakeSchema(
    METHODS.map((m) => ({ ...m, source: 'proto' as const, file: '/ws/app/protos/shop/v1/shop.proto' })),
    MESSAGES,
  );

describe('toGrpcurl', () => {
  it('h2c call: -plaintext, metadata without protocol headers, -d from the schema, reflection note', () => {
    const s = toGrpcurl(grpcCall({ requestHeaders: { 'content-type': 'application/grpc', te: 'trailers', 'grpc-timeout': '5S', 'grpc-accept-encoding': 'gzip', 'user-agent': 'grpc-dart', 'x-tenant': "o'brien", authorization: 'Bearer abc' } }), { grpc: fakeGrpc() });
    expect(s).toBe(
      [
        "# Without -proto, the server must support gRPC reflection (this method's schema isn't from a .proto file in the workspace).",
        'grpcurl \\',
        '  -plaintext \\',
        "  -H 'x-tenant: o'\\''brien' \\",
        "  -H 'authorization: Bearer abc' \\",
        `  -d '${JSON.stringify({ sku: 'A1', quantity: 2, sessionToken: 'tok-123' })}' \\`,
        "  10.0.2.2:50051 shop.v1.CartService/AddItem",
      ].join('\n'),
    );
  });

  it('TLS: -insecure only for decrypt hosts, default port spelled out; -proto / -import-path from the workspace', () => {
    const call = grpcCall({ url: 'https://grpc.example.com/shop.v1.CartService/AddItem', requestHeaders: {} });
    const g = { codec: fakeGrpc().codec, schema: protoSchema };
    const plain = toGrpcurl(call, { grpc: g, projectRoot: '/ws/app' });
    expect(plain).not.toMatch(/-insecure|-plaintext/);
    expect(plain).toMatch(/-import-path protos \\\n  -proto shop\/v1\/shop\.proto/);
    expect(plain).toMatch(/Run from the workspace folder/);
    expect(plain).toMatch(/grpc\.example\.com:443 shop\.v1\.CartService\/AddItem$/);
    expect(toGrpcurl(call, { grpc: g, projectRoot: '/ws/app', decryptHosts: ['*.example.com'] })).toMatch(/-insecure/);
    // a .proto outside the workspace: reflection note, no -proto
    expect(toGrpcurl(call, { grpc: g, projectRoot: '/elsewhere' })).toMatch(/must support gRPC reflection/);
  });

  it('client streaming: every request message concatenated; no schema / cut message / none: a note and no -d', () => {
    const streaming = fakeSchema(METHODS.map((m) => ({ ...m, clientStreaming: true })), MESSAGES);
    const call = grpcCall({
      frames: [
        { dir: 'send', at: 1, kind: 'message', base64: pb64({ sku: 'A' }), size: 9 },
        { dir: 'send', at: 2, kind: 'message', base64: pb64({ sku: 'B' }), size: 9 },
      ],
    });
    expect(toGrpcurl(call, { grpc: { codec: fakeGrpc().codec, schema: () => streaming } })).toMatch(/-d '\{"sku":"A"\} \{"sku":"B"\}'/);
    expect(toGrpcurl(call, { grpc: { codec: fakeGrpc().codec, schema: () => fakeSchema() } })).toMatch(/-d '\{"sku":"A"\}' \\/);
    expect(toGrpcurl(call, { grpc: fakeGrpc({ schema: null }) })).toMatch(/No protobuf schema for this method/);
    expect(toGrpcurl(call, {})).not.toMatch(/^\s+-d /m);
    expect(toGrpcurl(grpcCall({ frames: [{ dir: 'send', at: 1, kind: 'message', base64: 'AA==', size: 99_999, truncated: true }] }), { grpc: fakeGrpc() })).toMatch(/larger than 64 KB/);
    expect(toGrpcurl(grpcCall({ frames: [] }), { grpc: fakeGrpc() })).toMatch(/No request message was recorded/);
  });

  it('redact: metadata and request JSON as agents see them; gRPC-Web noted; non-gRPC refused', () => {
    const s = toGrpcurl(grpcCall({ grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 0, messagesSent: 1, messagesReceived: 1, web: 'text' }, requestHeaders: { authorization: 'Bearer abc', 'x-session-bin': 'AAEC', origin: 'http://localhost:5000', 'x-grpc-web': '1', 'x-user-agent': 'grpc-web-dart', 'sec-fetch-mode': 'cors' } }), { grpc: fakeGrpc(), redact: true });
    expect(s).toMatch(/-H 'authorization: \[redacted\]'/);
    expect(s).toMatch(/-H 'x-session-bin: \[redacted\]'/);
    expect(s).toMatch(/"sessionToken":"\[redacted\]"/);
    expect(s).not.toMatch(/origin|x-grpc-web|x-user-agent|sec-fetch|tok-123/);
    expect(s).toMatch(/Recorded as gRPC-Web \(text\)/);
    expect(() => toGrpcurl({ id: 'h', startedAt: 1, method: 'GET', url: 'https://a.example/x', requestHeaders: {}, state: 'completed' })).toThrow(/gRPC calls only/);
    expect(SNIPPET_FORMATS).toContain('grpcurl');
  });
});

class Host extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 1;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  grpcDecryptHosts: string[] = [];
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
}

describe('copySnippet / get_request snippet with gRPC', () => {
  const ctls: InterceptController[] = [];
  afterEach(() => {
    while (ctls.length) ctls.pop()!.dispose();
  });

  it('the panel copies gRPC rows as grpcurl (unredacted) and refuses the other pairings', async () => {
    const host = new Host();
    const copied: string[] = [];
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, grpc: fakeGrpc(), copyToClipboard: async (t) => void copied.push(t) });
    ctls.push(c);
    host.exchanges = [grpcCall({ id: 'g' }), { id: 'h', startedAt: 1, method: 'GET', url: 'https://a.example/x', requestHeaders: {}, state: 'completed', status: 200 }];
    const replies: HostMsg[] = [];
    await c.handle({ type: 'copySnippet', id: 'g', format: 'grpcurl' }, (m) => replies.push(m));
    expect(copied[0]).toMatch(/^grpcurl/m);
    expect(copied[0]).toMatch(/tok-123/); // the user's own clipboard
    await c.handle({ type: 'copySnippet', id: 'g', format: 'curl' }, (m) => replies.push(m));
    await c.handle({ type: 'copySnippet', id: 'h', format: 'grpcurl' }, (m) => replies.push(m));
    expect(replies.map((m) => (m as { message?: string }).message)).toEqual([expect.stringMatching(/copy it as grpcurl/), expect.stringMatching(/gRPC calls only/)]);
    expect(copied).toHaveLength(1);
  });

  it('agents: snippet "grpcurl" redacted; refused pairings; web shown in summaries, details and HAR', async () => {
    const host = new Host();
    const deps: AgentApiDeps = {
      host: host as unknown as AgentApiDeps['host'],
      applyRules: (rules) => {
        host.rules = validateRules(rules);
      },
      clear: () => undefined,
      getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
      launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
      projectRoot: () => '/ws/app',
      grpc: fakeGrpc(),
    };
    const api = createAgentApi(deps);
    const web = grpcCall({ id: 'w', grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 0, messagesSent: 1, messagesReceived: 1, web: 'binary' } });
    host.exchanges = [web, { id: 'h', startedAt: 1, method: 'GET', url: 'https://a.example/x', requestHeaders: {}, state: 'completed', status: 200 }];
    expect(parseToolInput('get_request', { id: 'w', snippet: 'grpcurl' })).toMatchObject({ snippet: 'grpcurl' });
    const d = (await api.call('get_request', { id: 'w', snippet: 'grpcurl' })) as Record<string, any>;
    expect(d.snippet).toMatch(/^grpcurl/m);
    expect(d.snippet).not.toMatch(/tok-123|Bearer abc/);
    expect(d.grpc.web).toBe('binary');
    expect(((await api.call('list_requests', { kind: 'grpc' })) as any).items[0].grpc.web).toBe('binary');
    const reject = async (input: Record<string, unknown>, re: RegExp) => {
      const e = await api.call('get_request', input).then(() => undefined, (x: unknown) => x);
      expect(e).toBeInstanceOf(AgentToolError);
      expect((e as Error).message).toMatch(re);
    };
    await reject({ id: 'w', snippet: 'curl' }, /use snippet "grpcurl"/);
    await reject({ id: 'h', snippet: 'grpcurl' }, /not a gRPC call/);
    expect((buildHar([web], { redact: true }) as any).log.entries[0]._grpc.web).toBe('binary');
  });
});

describe('gRPC-Web calls are not resent (owner decision, CONTRACTS §19)', () => {
  it('the panel and agents refuse with a plain message', async () => {
    const web = grpcCall({ id: 'w', grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 0, messagesSent: 1, messagesReceived: 1, web: 'binary' } });
    const host = new Host();
    host.exchanges = [web];
    const sent: unknown[] = [];
    Object.assign(host, { send: async (r: unknown) => (sent.push(r), { id: 's' }) });
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, grpc: fakeGrpc() });
    const replies: HostMsg[] = [];
    await c.handle({ type: 'send', request: { method: 'POST', url: web.url }, resentFrom: 'w' }, (m) => replies.push(m));
    c.dispose();
    expect((replies[0] as { message: string }).message).toMatch(/Resending gRPC-Web calls comes later: the proxy resends over HTTP\/2/);
    const api = createAgentApi({
      host: host as unknown as AgentApiDeps['host'],
      applyRules: () => undefined,
      clear: () => undefined,
      getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
      launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
      projectRoot: () => '/ws/app',
      grpc: fakeGrpc(),
    });
    const e = await api.call('resend_request', { id: 'w', grpc: { messages: ['AA=='] } }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(AgentToolError);
    expect((e as Error).message).toMatch(/resending gRPC-Web calls comes later/);
    expect(sent).toEqual([]);
  });
});
