// CONTRACTS §18 (v0.12.0) host + agents: gRPC rewrite validation (reserved metadata, -bin base64, trailers), shared-rule
// approval and secret checks for gRPC rewrites / map remote / scripts, the script template's gRPC hooks, resend / edit &
// resend of gRPC calls (panel and agents), agent add_rewrite trailers, confirmation texts.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule, SendRequest } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../src/agent/api';
import { confirmationText } from '../../src/agent/lmTools';
import { AgentToolError, type AppLauncher } from '../../src/agent/types';
import { approvalReasons, secretProblem } from '../../src/rules/policy';
import { scriptTemplate } from '../../src/rules/scriptFile';
import { InterceptController, validateRule, validateRules, type ControllerHost } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';
import { fakeGrpc, grpcCall, pb64 } from './grpc.fakes';

const GRPC_URL = '*/shop.v1.CartService/AddItem';
const HOST_GRPC_URL = 'http://10.0.2.2:50051/shop.v1.CartService/AddItem';
const rw = (response: Record<string, unknown> | undefined, request?: Record<string, unknown>, url = GRPC_URL) =>
  ({ id: 'r', enabled: true, match: { url }, action: { kind: 'rewrite', ...(request ? { request } : {}), ...(response ? { response } : {}) } }) as unknown as Rule;

describe('gRPC rewrite validation (CONTRACTS §18.1)', () => {
  it('accepts metadata, trailers and base64 -bin values', () => {
    expect(validateRule(rw({ setHeaders: { 'x-demo-server': 'fi' }, setTrailers: { 'x-region': 'eu', 'x-trace-bin': 'AQID' }, removeTrailers: ['x-old'] }, { setHeaders: { 'x-flag': '1', 'x-ctx-bin': 'AAE' }, removeHeaders: ['x-gone'] })).action.kind).toBe('rewrite');
    // content-type / te are fine on HTTP rules
    expect(validateRule(rw({ setHeaders: { 'content-type': 'application/json' } }, undefined, 'https://api.example.com/*')).action.kind).toBe('rewrite');
  });

  it('refuses reserved metadata, bad -bin values, CR/LF and trailers on the request side', () => {
    const bad: [Rule, RegExp][] = [
      [rw({ setHeaders: { 'grpc-status': '0' } }), /gRPC protocol metadata/],
      [rw(undefined, { removeHeaders: ['grpc-timeout'] }), /can't be removed/],
      [rw({ setTrailers: { 'grpc-message': 'x' } }), /can't be set as a trailer/],
      [rw({ setTrailers: { 'content-type': 'x' } }), /can't be set as a trailer/],
      [rw({ removeTrailers: ['grpc-status'] }), /can't be removed/],
      [rw({ setTrailers: { 'x-a-bin': 'not base64!' } }), /must be base64/],
      [rw(undefined, { setHeaders: { 'x-a-bin': '***' } }), /must be base64/],
      [rw({ setTrailers: { 'x-a': 'a\r\nb' } }), /CR, LF/],
      [rw({ removeTrailers: 'x' }), /removeTrailers must be a list/],
      [rw(undefined, { setTrailers: { a: '1' } }), /unknown field "setTrailers"/],
      [rw(undefined, { setHeaders: { 'content-type': 'application/grpc+proto' } }), /can't be changed on a gRPC call/],
      [rw({ removeHeaders: ['te'] }), /can't be changed on a gRPC call/],
    ];
    for (const [rule, re] of bad) expect(() => validateRule(rule), JSON.stringify(rule.action)).toThrow(re);
  });
});

describe('shared-rule policy for gRPC (CONTRACTS §18.1 / §18.3 / §18.2)', () => {
  it('request-metadata rewrites, map remote and scripts need approval like HTTP; trailers are checked like headers', () => {
    expect(approvalReasons(rw(undefined, { setHeaders: { 'x-tenant': 'other' } })).join(' ')).toMatch(/changes request headers sent to the server/);
    expect(approvalReasons({ id: 'm', enabled: true, match: { url: GRPC_URL }, action: { kind: 'mapRemote', to: 'https://staging.example.com' } } as Rule).join(' ')).toMatch(/sends the app's requests to https:\/\/staging\.example\.com/);
    expect(approvalReasons({ id: 's', enabled: true, match: { url: GRPC_URL }, action: { kind: 'script', code: 'function onGrpcMessage(){}' } } as Rule).join(' ')).toMatch(/runs JavaScript/);
    expect(approvalReasons(rw({ setTrailers: { 'set-cookie': 'sid=1' } })).join(' ')).toMatch(/sets a cookie .* as a gRPC trailer/);
    expect(approvalReasons(rw({ setTrailers: { 'x-region': 'eu' } }))).toEqual([]);
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJl'].join('.');
    expect(secretProblem(rw({ setTrailers: { 'x-auth': jwt } }))).toMatch(/JWT|credential/);
  });

  it('the script template documents the gRPC hooks (commented) and still parses', () => {
    const t = scriptTemplate({ name: 'demo' });
    expect(t).toMatch(/\/\/ function onGrpcMessage\(message, context\)/);
    expect(t).toMatch(/\/\/ function onGrpcStatus\(status, context\)/);
    expect(() => new Function(`${t}\nreturn [typeof onRequest, typeof onResponse, typeof onGrpcMessage];`)).not.toThrow();
    expect(new Function(`${t}\nreturn typeof onGrpcMessage;`)()).toBe('undefined');
  });
});

// ------------------------------------------------------------------ resend (panel)

class CtlHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 1;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  sent: SendRequest[] = [];
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
  async send(req: SendRequest) {
    this.sent.push(req);
    return { id: `s${this.sent.length}` };
  }
}

describe('resend / edit & resend of gRPC calls in the panel (CONTRACTS §18.4)', () => {
  const ctls: InterceptController[] = [];
  afterEach(() => {
    while (ctls.length) ctls.pop()!.dispose();
  });
  const setup = () => {
    const host = new CtlHost();
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, grpc: fakeGrpc() });
    ctls.push(c);
    const replies: HostMsg[] = [];
    return { host, c, replies, reply: (m: HostMsg) => replies.push(m) };
  };
  const errs = (r: HostMsg[]) => r.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message);

  it('resend sends the recorded request messages; edit & resend encodes messagesJson with the request type', async () => {
    const { host, c, replies, reply } = setup();
    const call = grpcCall({ id: 'g' });
    host.exchanges = [call];
    const headers = { 'content-type': 'application/grpc', te: 'trailers', 'grpc-encoding': 'gzip', 'x-tenant': 'a' };
    await c.handle({ type: 'send', request: { method: 'POST', url: call.url, headers }, resentFrom: 'g' }, reply);
    expect(host.sent[0]).toEqual({ method: 'POST', url: call.url, headers: { 'x-tenant': 'a' }, grpc: { messages: [call.frames![0].base64] }, initiator: 'editor', resentFrom: 'g' });
    await c.handle({ type: 'send', request: { method: 'POST', url: call.url, grpc: { messagesJson: [{ sku: 'B2', quantity: 1 }] } }, resentFrom: 'g' }, reply);
    expect(host.sent[1].grpc).toEqual({ messages: [pb64({ sku: 'B2', quantity: 1 })] });
    expect(replies.filter((m) => m.type === 'sent')).toHaveLength(2);
  });

  it('refusals: cut request message, bad JSON, body, non-POST, non-gRPC URL, both message forms', async () => {
    const { host, c, replies, reply } = setup();
    host.exchanges = [grpcCall({ id: 'cut', frames: [{ dir: 'send', at: 1, kind: 'message', base64: 'AA==', size: 999_999, truncated: true }] })];
    const url = 'http://10.0.2.2:50051/shop.v1.CartService/AddItem';
    await c.handle({ type: 'send', request: { method: 'POST', url }, resentFrom: 'cut' }, reply);
    await c.handle({ type: 'send', request: { method: 'POST', url, grpc: { messagesJson: [{ nope: 1 }] } } }, reply);
    await c.handle({ type: 'send', request: { method: 'POST', url, body: 'x', grpc: { messages: ['AA=='] } } }, reply);
    await c.handle({ type: 'send', request: { method: 'GET', url, grpc: { messages: ['AA=='] } } }, reply);
    await c.handle({ type: 'send', request: { method: 'POST', url: 'https://api.example.com/x', grpc: { messages: ['AA=='] } } }, reply);
    await c.handle({ type: 'send', request: { method: 'POST', url, grpc: { messages: ['AA=='], messagesJson: [{}] } } }, reply);
    await c.handle({ type: 'send', request: { method: 'POST', url, grpc: { messages: Array.from({ length: 101 }, () => 'AA==') } } }, reply);
    expect(errs(replies)).toEqual([
      expect.stringMatching(/too large to record in full/),
      expect.stringMatching(/messagesJson\[0\] can't be encoded as the request of \/shop\.v1\.CartService\/AddItem: \$\.nope/),
      expect.stringMatching(/has no body/),
      expect.stringMatching(/method POST/),
      expect.stringMatching(/ends in \/<package\.Service>\/<Method>/),
      expect.stringMatching(/exactly one of messages/),
      expect.stringMatching(/at most 100/),
    ]);
    expect(host.sent).toEqual([]);
  });
});

// ------------------------------------------------------------------ agents

class AgentHost extends CtlHost {
  off = vi.fn();
}

function agent(o: { redact?: boolean; access?: 'readWrite' | 'readOnly' } = {}) {
  const host = new AgentHost();
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: o.access ?? 'readWrite', redactSecrets: o.redact ?? true, interceptEnabled: true }),
    launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
    projectRoot: () => '/ws/app',
    newRuleId: () => 'agent_1',
    now: () => 50_000,
    grpc: fakeGrpc(),
  };
  return { api: createAgentApi(deps), host };
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

describe('agents: resend_request grpc (CONTRACTS §18.4)', () => {
  it('resends the recorded messages, or messagesJson with "[redacted]" values restored, or base64', async () => {
    const { api, host } = agent();
    const call = grpcCall({ id: 'g' });
    host.exchanges = [call];
    expect(await api.call('resend_request', { id: 'g' })).toEqual({ id: 's1', sinceMs: 50_000, messages: 1 });
    expect(host.sent[0]).toMatchObject({ method: 'POST', url: call.url, grpc: { messages: [call.frames![0].base64] }, initiator: 'agent', resentFrom: 'g' });
    // the authorization header the agent saw redacted goes out with its real value; te / content-type are dropped
    expect(host.sent[0].headers).toEqual({ authorization: 'Bearer abc.def.ghi', 'x-session-bin': 'AAEC' });
    await api.call('resend_request', { id: 'g', grpc: { messagesJson: [{ sku: 'B2', quantity: 3, sessionToken: '[redacted]' }] } });
    expect(host.sent[1].grpc).toEqual({ messages: [pb64({ sku: 'B2', quantity: 3, sessionToken: 'tok-123' })] });
    await api.call('resend_request', { id: 'g', grpc: { messages: ['AAE='] } });
    expect(host.sent[2].grpc).toEqual({ messages: ['AAE='] });
  });

  it('refusals', async () => {
    const { api, host } = agent();
    host.exchanges = [
      grpcCall({ id: 'g' }),
      grpcCall({ id: 'cut', frames: [{ dir: 'send', at: 1, kind: 'message', base64: 'AA==', size: 999_999, truncated: true }] }),
      grpcCall({ id: 'lan', viaLan: true }),
      grpcCall({ id: 'mocked', matchedRuleId: 'r1', state: 'mocked' }),
      { id: 'h', startedAt: 1, method: 'GET', url: 'https://api.example.com/x', requestHeaders: {}, state: 'completed', status: 200 },
    ];
    await rejectsWith(api.call('resend_request', { id: 'cut' }), /too large to record in full/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 'lan' }), /over the LAN/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 'mocked' }), /handled by rule/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 'h', grpc: { messages: ['AA=='] } }), /not a gRPC call/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 'g', grpc: { messagesJson: [{ nope: 1 }] } }), /\$\.nope/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 'g', grpc: { messagesJson: [{}], messages: ['AA=='] } }), /not both/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 'g', edit: { body: 'x' } }), /has no body/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 'g', edit: { url: 'http://evil.example:50051/shop.v1.CartService/AddItem' } }), /original origin/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 'g', edit: { url: 'http://10.0.2.2:50051/not/a/method/path' } }), /must name a gRPC method/, 'invalid');
    await rejectsWith(agent({ access: 'readOnly' }).api.call('resend_request', { id: 'g', grpc: { messages: ['AA=='] } }), /read-only/, 'access');
    // a cut recording can still be resent with replacements
    expect(await api.call('resend_request', { id: 'cut', grpc: { messages: ['AAE='] } })).toMatchObject({ messages: 1 });
    expect(host.sent).toHaveLength(1);
  });
});

describe('agents: add_rewrite with gRPC trailers (CONTRACTS §18.1)', () => {
  it('sets / removes trailers; forbidden and reserved names refused', async () => {
    const { api, host } = agent();
    await api.call('add_rewrite', { url: HOST_GRPC_URL, response: { setHeaders: { 'x-demo-server': 'fi' }, setTrailers: { 'x-region': 'eu' }, removeTrailers: ['x-old'] } });
    expect(host.rules[0].action).toEqual({ kind: 'rewrite', response: { setHeaders: { 'x-demo-server': 'fi' }, setTrailers: { 'x-region': 'eu' }, removeTrailers: ['x-old'] } });
    await rejectsWith(api.call('add_rewrite', { url: HOST_GRPC_URL, response: { setTrailers: { 'set-cookie': 'a=1' } } }), /agents can't set "set-cookie"/, 'invalid');
    await rejectsWith(api.call('add_rewrite', { url: HOST_GRPC_URL, response: { setTrailers: { 'grpc-status': '0' } } }), /can't be set as a trailer/, 'invalid');
    await rejectsWith(api.call('add_rewrite', { url: HOST_GRPC_URL, response: { setTrailers: { 'x-a': '[redacted]' } } }), /placeholder/, 'invalid');
  });

  it('confirmation texts name trailers and gRPC messages', () => {
    expect(confirmationText('add_rewrite', { url: GRPC_URL, response: { setTrailers: { 'x-region': 'eu' }, removeTrailers: ['x-old'] } }).message).toMatch(/set gRPC trailers `x-region`: `eu`; remove gRPC trailers `x-old`/);
    expect(confirmationText('resend_request', { id: 'g', grpc: { messagesJson: [{}, {}] } }).message).toMatch(/2 gRPC request message\(s\) as JSON/);
  });
});
