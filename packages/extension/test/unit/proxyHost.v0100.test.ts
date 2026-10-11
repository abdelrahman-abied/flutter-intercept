// CONTRACTS §16 (v0.10.0) host side: gRPC decrypt hosts forwarded to the proxy (constructor option + setter, re-applied
// after a restart, problems as warnings), the proxy's gRPC self-check as `grpcProblem`, and grpcMock.messagesJson encoded
// into messages before rules reach the proxy (failures skip the rule with a warning, like body files).
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { InterceptProxyOptions, Rule } from '@flutter-intercept/proxy';
import { grpcMockEncoder } from '../../src/grpc/service';
import { hasGrpcJson, InterceptProxyHost, normalizeGrpcDecryptHosts } from '../../src/proxyHost';
import { fakeGrpc, pb64 } from './grpc.fakes';

interface Fake {
  opts: InterceptProxyOptions;
  calls: unknown[][];
  rules: Rule[][];
}

function factory(made: Fake[], o: { grpc?: boolean; support?: { ok: boolean; problem?: string } | 'throw' } = {}) {
  return (opts: InterceptProxyOptions) => {
    const ee = new EventEmitter();
    const f: Fake = { opts, calls: [], rules: [] };
    made.push(f);
    return {
      port: opts.port ?? 0,
      start: async () => undefined,
      stop: async () => undefined,
      setRules: (r: Rule[]) => {
        f.rules.push(r);
      },
      getExchanges: () => [],
      clear: () => undefined,
      resume: () => undefined,
      abort: () => undefined,
      on: (ev: string, l: (...a: any[]) => void) => ee.on(ev, l),
      emit: (ev: string, ...a: unknown[]) => ee.emit(ev, ...a),
      ...(o.grpc === false
        ? {}
        : {
            setGrpcDecryptHosts: (hosts: string[]) => {
              f.calls.push(['setGrpcDecryptHosts', hosts]);
              return { hosts: hosts.filter((h) => h !== 'refused.example'), problems: hosts.includes('refused.example') ? ['refused.example is not allowed'] : [] };
            },
            grpcSupport: () => {
              if (o.support === 'throw') throw new Error('internals moved');
              return o.support ?? { ok: true };
            },
          }),
    };
  };
}

function host(made: Fake[], o: Parameters<typeof factory>[1] & { logs?: string[] } = {}) {
  return new InterceptProxyHost({ getPort: () => 9100, factory: factory(made, o), log: (m) => o.logs?.push(m), canRestart: () => true });
}

const grpcRule = (over: Partial<Rule> = {}, action: Record<string, unknown> = {}): Rule =>
  ({ id: 'g1', enabled: true, name: 'cart', match: { method: 'POST', url: '*/shop.v1.CartService/AddItem' }, action: { kind: 'grpcMock', messagesJson: [{ total: '5' }], ...action }, ...over }) as Rule;

describe('normalizeGrpcDecryptHosts (CONTRACTS §16.4)', () => {
  it('normalises like the TLS passthrough list, naming its own setting', () => {
    const r = normalizeGrpcDecryptHosts([' API.Example.com ', 'api.example.com', '*', 'grpc.example.com:443', 3]);
    expect(r.hosts).toEqual(['api.example.com', 'grpc.example.com:443']);
    expect(r.problems.length).toBe(2);
    expect(r.problems.every((p) => p.startsWith('flutterIntercept.grpc.decryptHosts'))).toBe(true);
    expect(normalizeGrpcDecryptHosts('x').problems[0]).toMatch(/must be a list/);
    expect(normalizeGrpcDecryptHosts(undefined)).toEqual({ hosts: [], problems: [] });
  });
});

describe('gRPC breaker warnings (CONTRACTS §16.8)', () => {
  it("turn the proxy's 'grpcBreaker' event into one bypass warning per authority, cleared on demand and on stop", async () => {
    const made: Fake[] = [];
    let proxyEmit: ((ev: string, ...a: unknown[]) => void) | undefined;
    const h = new InterceptProxyHost({
      getPort: () => 9100,
      factory: (opts) => {
        const p = factory(made)(opts) as any;
        proxyEmit = p.emit;
        return p;
      },
      canRestart: () => true,
    });
    await h.start();
    const seen: unknown[] = [];
    h.on('warnings', (w) => seen.push(w));
    proxyEmit!('grpcBreaker', { authority: 'api.example.com:443', viaLan: false });
    proxyEmit!('grpcBreaker', { authority: 'api.example.com:443', viaLan: true });
    proxyEmit!('grpcBreaker', { authority: 'evil\r\n.example:1' });
    proxyEmit!('grpcBreaker', { nope: 1 });
    proxyEmit!('grpcBreaker', 'x');
    expect(h.warnings).toEqual([
      { id: 'grpc-breaker:api.example.com:443', kind: 'bypass', text: "gRPC connections to api.example.com:443 kept closing, so the app connected directly for 30 s — rules and network simulation didn't apply to them meanwhile." },
      expect.objectContaining({ id: 'grpc-breaker:evil.example:1' }),
    ]);
    expect(seen).toHaveLength(2);
    h.clearGrpcBreakerWarnings();
    expect(h.warnings).toEqual([]);
    proxyEmit!('grpcBreaker', { authority: 'b.example:50051' });
    expect(h.warnings).toHaveLength(1);
    await h.stop();
    expect(h.warnings).toEqual([]);
  });
});

describe('InterceptProxyHost gRPC (CONTRACTS §16.2 / §16.4)', () => {
  it('passes decrypt hosts as a constructor option and through the setter; re-applies after a restart', async () => {
    const made: Fake[] = [];
    const h = host(made);
    const events: unknown[] = [];
    h.on('grpc', (i) => events.push(i));
    expect(h.setGrpcDecryptHosts(['grpc.example.com'])).toEqual({ hosts: ['grpc.example.com'], problems: [] });
    expect(events).toEqual([{ decryptHosts: ['grpc.example.com'] }]);
    await h.start();
    expect(made[0].opts.grpcDecryptHosts).toEqual(['grpc.example.com']);
    expect(made[0].calls).toContainEqual(['setGrpcDecryptHosts', ['grpc.example.com']]);
    h.setGrpcDecryptHosts(['a.example.com', 'b.example.com']);
    expect(made[0].calls.at(-1)).toEqual(['setGrpcDecryptHosts', ['a.example.com', 'b.example.com']]);
    expect(h.grpcDecryptHosts).toEqual(['a.example.com', 'b.example.com']);
    await h.stop();
    await h.start();
    expect(made[1].opts.grpcDecryptHosts).toEqual(['a.example.com', 'b.example.com']);
  });

  it('setting and proxy problems become a Status warning; clearing the list clears it', async () => {
    const made: Fake[] = [];
    const h = host(made);
    await h.start();
    const r = h.setGrpcDecryptHosts(['*', 'refused.example', 'ok.example.com']);
    expect(r.problems.length).toBe(2);
    expect(h.warnings.find((w) => w.id === 'settings:grpcDecryptHosts')?.text).toMatch(/refused\.example is not allowed/);
    h.setGrpcDecryptHosts([]);
    expect(h.warnings.find((w) => w.id === 'settings:grpcDecryptHosts')).toBeUndefined();
  });

  it('grpcProblem reflects the self-check; an older proxy build without gRPC says so', async () => {
    const ok: Fake[] = [];
    const a = host(ok);
    expect(a.grpcProblem).toBeUndefined();
    await a.start();
    expect(a.grpcProblem).toBeUndefined();

    const bad = host([], { support: { ok: false, problem: 'mockttp internals changed:\nno LastTunnelAddress' } });
    const events: unknown[] = [];
    bad.on('grpc', (i) => events.push(i));
    await bad.start();
    expect(bad.grpcProblem).toBe('mockttp internals changed: no LastTunnelAddress');
    expect(events.at(-1)).toEqual({ decryptHosts: [], problem: 'mockttp internals changed: no LastTunnelAddress' });
    await bad.stop();
    expect(bad.grpcProblem).toBeUndefined();

    const throwing = host([], { support: 'throw' });
    await throwing.start();
    expect(throwing.grpcProblem).toMatch(/self-check failed: internals moved/);

    const logs: string[] = [];
    const old = host([], { grpc: false, logs });
    old.setGrpcDecryptHosts(['x.example.com']);
    await old.start();
    expect(old.grpcProblem).toMatch(/cannot intercept gRPC/);
    expect(logs.join('\n')).toMatch(/cannot decrypt gRPC/);
  });

  it('encodes grpcMock.messagesJson before the proxy gets the rule (also in sequence steps)', async () => {
    const made: Fake[] = [];
    const h = host(made);
    await h.start();
    h.setGrpcMessageEncoder(grpcMockEncoder(fakeGrpc()));
    const seq = {
      id: 's1',
      enabled: true,
      match: { method: 'POST', url: 'http://h/shop.v1.CartService/AddItem' },
      action: { kind: 'sequence', steps: [{ action: { kind: 'grpcMock', code: 14 } }, { action: { kind: 'grpcMock', messagesJson: [{ total: '9' }] } }] },
    } as unknown as Rule;
    h.setRules([grpcRule(), seq]);
    await h.rulesReady();
    const sent = made[0].rules.at(-1)!;
    expect(sent[0].action).toEqual({ kind: 'grpcMock', messages: [pb64({ total: '5' })] });
    expect((sent[1].action as any).steps[1].action).toEqual({ kind: 'grpcMock', messages: [pb64({ total: '9' })] });
    expect((sent[1].action as any).steps[0].action).toEqual({ kind: 'grpcMock', code: 14 });
    // the authored rules keep messagesJson
    expect((h.getRules()[0].action as any).messagesJson).toEqual([{ total: '5' }]);
    expect(h.warnings).toEqual([]);
    expect(hasGrpcJson(grpcRule())).toBe(true);
    expect(hasGrpcJson(grpcRule({}, { messagesJson: undefined, messages: ['AA=='] }))).toBe(false);
  });

  it('a rule whose messages cannot be encoded is skipped with a warning; the encoder arriving later applies it', async () => {
    const made: Fake[] = [];
    const h = host(made);
    await h.start();
    const plain = { id: 'p', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'status', status: 403 } } as Rule;
    h.setRules([grpcRule(), plain]);
    await h.rulesReady();
    expect(made[0].rules.at(-1)!.map((r) => r.id)).toEqual(['p']);
    expect(h.warnings[0]).toMatchObject({ id: 'grpcMock:g1', text: expect.stringMatching(/Rule "cart" is skipped: its gRPC messages can't be encoded \(gRPC JSON messages need the protobuf schema/) });
    h.setGrpcMessageEncoder(grpcMockEncoder(fakeGrpc()));
    await h.rulesReady();
    expect(made[0].rules.at(-1)!.map((r) => r.id)).toEqual(['g1', 'p']);
    expect(h.warnings).toEqual([]);
    h.setRules([grpcRule({}, { messagesJson: [{ nope: 1 }] })]);
    await h.rulesReady();
    expect(h.warnings[0].text).toMatch(/message 1 \(shop\.v1\.Cart\): \$\.nope: no such field/);
  });

  it('refreshGrpcMocks re-encodes after a schema change', async () => {
    const made: Fake[] = [];
    const h = host(made);
    await h.start();
    let schemaOk = false;
    const g = fakeGrpc();
    const enc = grpcMockEncoder({ ...g, schema: () => (schemaOk ? g.schema() : undefined) });
    h.setGrpcMessageEncoder(enc);
    h.setRules([grpcRule()]);
    await h.rulesReady();
    expect(made[0].rules.at(-1)).toEqual([]);
    schemaOk = true;
    h.refreshGrpcMocks();
    await h.rulesReady();
    expect(made[0].rules.at(-1)!.map((r) => r.id)).toEqual(['g1']);
  });
});
