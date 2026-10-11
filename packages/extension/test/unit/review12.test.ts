// REVIEW-12 / CONTRACTS §18.6 host + agents: Map Remote to the proxy itself refused (host filter, panel, agents),
// base64 runs in agents' scriptLog, "[redacted]" restore only for the same method, messagesJson total caps, a resend
// whose record is gone refused.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, InterceptProxyOptions, Rule, SendRequest } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../src/agent/api';
import { redactBase64Runs, redactLogLine } from '../../src/agent/redact';
import { toolDescriptions } from '../../src/agent/schema';
import { AgentToolError, type AppLauncher } from '../../src/agent/types';
import { InterceptProxyHost, mapRemoteSelfProblem } from '../../src/proxyHost';
import { InterceptController, resolveSendGrpc, validateRules, type ControllerHost } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';
import { fakeGrpc, grpcCall, pb64 } from './grpc.fakes';

const map = (to: string, id = 'm'): Rule => ({ id, enabled: true, name: 'loop', match: { url: '*/shop.v1.CartService/*' }, action: { kind: 'mapRemote', to } });

describe('#1 Map Remote to the proxy itself', () => {
  it('mapRemoteSelfProblem: loopback / aliases / LAN host on an own port', () => {
    const own = { ports: [8899, 9100], hosts: ['192.168.1.20'] };
    for (const to of ['http://127.0.0.1:8899', 'http://localhost:8899/x', 'http://[::1]:9100', 'http://10.0.2.2:8899', 'http://0.0.0.0:8899', 'http://192.168.1.20:9100']) expect(mapRemoteSelfProblem(to, own), to).toMatch(/loop back into the proxy/);
    for (const to of ['http://127.0.0.1:50051', 'https://api.example.com:8899', 'http://192.168.1.21:9100', 'http://localhost']) expect(mapRemoteSelfProblem(to, own), to).toBeUndefined();
    expect(mapRemoteSelfProblem('http://localhost', { ports: [80] })).toMatch(/loop/);
  });

  it('the host never applies such a rule (shared ones too), with a warning; re-checked once the port is known', async () => {
    const sent: Rule[][] = [];
    const h = new InterceptProxyHost({
      getPort: () => 8899,
      canRestart: () => true,
      factory: (opts: InterceptProxyOptions) => {
        const ee = new EventEmitter();
        return { port: opts.port ?? 0, start: async () => undefined, stop: async () => undefined, setRules: (r: Rule[]) => void sent.push(r), getExchanges: () => [], clear: () => undefined, resume: () => undefined, abort: () => undefined, on: (ev: string, l: (...a: any[]) => void) => ee.on(ev, l) };
      },
    });
    h.setRules([{ ...map('http://127.0.0.1:8899'), shared: true }, map('http://127.0.0.1:50051', 'ok')]);
    expect(h.warnings[0]).toMatchObject({ id: 'selfMap:m', text: expect.stringMatching(/Rule "loop" is skipped: .*own proxy port/) });
    await h.start();
    expect(sent.at(-1)!.map((r) => r.id)).toEqual(['ok']);
    expect(h.ownListeners.ports).toEqual([8899]);
  });

  it('the panel refuses a personal one; agents refuse add_map_remote to it', async () => {
    const host = Object.assign(new EventEmitter(), {
      running: true, port: 8899, exchanges: [] as Exchange[], rules: [] as Rule[], ownListeners: { ports: [8899], hosts: [] },
      getExchanges() { return []; }, getRules() { return this.rules; }, setRules(r: Rule[]) { this.rules = r; }, clear() {}, resume() {}, abort() {},
    }) as unknown as ControllerHost & { rules: Rule[] };
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined });
    expect(() => c.applyRules([map('http://localhost:8899')])).toThrow(/own proxy port/);
    c.dispose();
    const { api } = agent({ ownListeners: { ports: [8899], hosts: [] } });
    await rejectsWith(api.call('add_map_remote', { url: 'http://10.0.2.2:50051/*', to: 'http://127.0.0.1:8899' }), /own proxy port/, 'invalid');
  });
});

describe('#3 base64 in agents\' scriptLog', () => {
  it('redacts base64 runs ≥ 16 characters; keeps paths and words', () => {
    const b = Buffer.from('Login{user:ada,password:hunter2}').toString('base64');
    expect(redactBase64Runs(`msg ${b} end`)).toBe(`msg [base64 32 bytes] end`);
    expect(redactLogLine(`sent ${b}`)).not.toContain(b); // long ones are caught as opaque tokens already
    const short = Buffer.from('pw:hunter2-pin').toString('base64'); // 20 chars, not an "opaque token"
    expect(redactLogLine(`sent ${short}`)).toBe('sent [base64 14 bytes]');
    expect(redactBase64Runs('path /shop.v1.CartService/AddItem ok')).toBe('path /shop.v1.CartService/AddItem ok');
    expect(redactBase64Runs('flutterInterceptRuleName stays')).toBe('flutterInterceptRuleName stays');
    expect(redactBase64Runs('id abc123')).toBe('id abc123');
  });
});

class Host extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  sent: SendRequest[] = [];
  ownListeners?: { ports: number[]; hosts: string[] };
  getExchanges() { return this.exchanges.map((e) => ({ ...e })); }
  getRules() { return this.rules; }
  resume() {}
  abort() {}
  async send(r: SendRequest) { this.sent.push(r); return { id: 's' }; }
}
function agent(o: { ownListeners?: { ports: number[]; hosts: string[] } } = {}) {
  const host = new Host();
  if (o.ownListeners) host.ownListeners = o.ownListeners;
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => { host.rules = validateRules(rules); },
    clear: () => undefined,
    getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
    launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
    projectRoot: () => '/ws/app',
    newRuleId: () => 'a1',
    now: () => 1,
    grpc: fakeGrpc(),
  };
  return { api: createAgentApi(deps), host };
}
const rejectsWith = async (p: Promise<unknown>, re: RegExp, code?: AgentToolError['code']) => {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(e).toBeInstanceOf(AgentToolError);
  expect((e as Error).message).toMatch(re);
  if (code) expect((e as AgentToolError).code).toBe(code);
};

describe('#4 resend', () => {
  const ctls: InterceptController[] = [];
  afterEach(() => { while (ctls.length) ctls.pop()!.dispose(); });

  it('"[redacted]" is restored only when the edit keeps the method', async () => {
    const { api, host } = agent();
    host.exchanges = [grpcCall({ id: 'g' })];
    await api.call('resend_request', { id: 'g', grpc: { messagesJson: [{ sku: 'B', sessionToken: '[redacted]' }] } });
    expect(host.sent[0].grpc).toEqual({ messages: [pb64({ sku: 'B', sessionToken: 'tok-123' })] });
    await rejectsWith(
      api.call('resend_request', { id: 'g', edit: { url: 'http://10.0.2.2:50051/shop.v1.CartService/Watch' }, grpc: { messagesJson: [{ sessionToken: '[redacted]' }] } }),
      /no decodable original message 1 of the same method/,
      'invalid',
    );
    expect(host.sent).toHaveLength(1);
  });

  it('messagesJson totals are capped (encoded 16 MB)', () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    expect(() => resolveSendGrpc('http://h/shop.v1.CartService/AddItem', { messagesJson: Array.from({ length: 6 }, () => ({ sku: big })) }, fakeGrpc())).toThrow(/total at most 16 MB/);
  });

  it('the panel refuses a resend whose record is gone', async () => {
    const host = Object.assign(new EventEmitter(), {
      running: true, port: 1, sent: [] as unknown[], getExchanges: () => [], getRules: () => [], setRules() {}, clear() {}, resume() {}, abort() {},
      async send(r: unknown) { this.sent.push(r); return { id: 'x' }; },
    }) as unknown as ControllerHost & { sent: unknown[] };
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined });
    ctls.push(c);
    const replies: HostMsg[] = [];
    await c.handle({ type: 'send', request: { method: 'GET', url: 'https://api.example.com/x' }, resentFrom: 'gone' }, (m) => replies.push(m));
    expect(replies).toEqual([{ type: 'error', message: expect.stringMatching(/no longer available/) }]);
    expect(host.sent).toEqual([]);
  });
});

describe('#5 wording', () => {
  it('resend_request says rules and the network profile apply, gRPC included', () => {
    expect(toolDescriptions().resend_request).toMatch(/the network profile and replay apply to the resent call, gRPC calls included/);
  });
});
