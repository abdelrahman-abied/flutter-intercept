// CONTRACTS §19.3 host side: decrypt-all passthrough (constructor option, setter, re-applied after a restart), the
// simulator trust state in Status.grpc.simulatorTrust (re-broadcast on 'grpc') and in agents' get_status.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InterceptProxyOptions, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../src/agent/api';
import type { AppLauncher } from '../../src/agent/types';
import { InterceptProxyHost } from '../../src/proxyHost';
import { InterceptController } from '../../src/ui/controller';
import type { HostMsg, Status } from '../../src/ui/protocol';
import { fakeGrpc } from './grpc.fakes';

function host(made: { opts: InterceptProxyOptions; calls: boolean[] }[], o: { support?: boolean; logs?: string[] } = {}) {
  return new InterceptProxyHost({
    getPort: () => 9300,
    canRestart: () => true,
    log: (m) => o.logs?.push(m),
    factory: (opts) => {
      const ee = new EventEmitter();
      const f = { opts, calls: [] as boolean[] };
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
        ...(o.support === false ? {} : { setGrpcDecryptAll: (on: boolean) => void f.calls.push(on) }),
      };
    },
  });
}

const ctls: InterceptController[] = [];
afterEach(() => {
  while (ctls.length) ctls.pop()!.dispose();
});

describe('decrypt-all and simulator trust (CONTRACTS §19.3)', () => {
  it('passes decrypt-all through (option + setter), re-applies after a restart, emits grpc', async () => {
    const made: { opts: InterceptProxyOptions; calls: boolean[] }[] = [];
    const h = host(made);
    const events: unknown[] = [];
    h.on('grpc', (i) => events.push(i));
    h.setGrpcDecryptAll(true);
    h.setGrpcDecryptAll(true); // unchanged: no event
    expect(events).toHaveLength(1);
    await h.start();
    expect(made[0].opts.grpcDecryptAll).toBe(true);
    expect(made[0].calls).toEqual([true]);
    h.setGrpcDecryptAll(false);
    expect(made[0].calls).toEqual([true, false]);
    h.setGrpcDecryptAll(true);
    await h.stop();
    await h.start();
    expect(made[1].calls).toEqual([true]);
    const logs: string[] = [];
    const old = host([], { support: false, logs });
    old.setGrpcDecryptAll(true);
    await old.start();
    expect(logs.join('\n')).toMatch(/cannot decrypt TLS gRPC for every host/);
  });

  it('setSimulatorTrust sanitises and reports; Status and get_status show it', async () => {
    const h = host([]);
    expect(h.simulatorTrust).toBeUndefined();
    h.setSimulatorTrust({ devices: [{ udid: 'SIM-1', name: 'iPhone 17\nPro', state: 'trusted' }, { udid: 'SIM-2', state: 'failed', problem: 'unknown TrustStore schema' }, { udid: 'x', state: 'bogus' }, 7] });
    expect(h.simulatorTrust).toEqual({ devices: [{ udid: 'SIM-1', name: 'iPhone 17 Pro', state: 'trusted' }, { udid: 'SIM-2', state: 'failed', problem: 'unknown TrustStore schema' }], decryptAll: false });
    const c = new InterceptController({ host: h, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, grpc: fakeGrpc() });
    ctls.push(c);
    const msgs: HostMsg[] = [];
    c.attach((m) => msgs.push(m));
    h.setGrpcDecryptAll(true);
    const st = (msgs.filter((m) => m.type === 'status').at(-1) as { status: Status }).status;
    expect(st.grpc?.simulatorTrust).toEqual({ devices: [{ udid: 'SIM-1', name: 'iPhone 17 Pro', state: 'trusted' }, { udid: 'SIM-2', state: 'failed', problem: 'unknown TrustStore schema' }], decryptAll: true });
    const api = createAgentApi({
      host: h as unknown as AgentApiDeps['host'],
      applyRules: (_r: Rule[]) => undefined,
      clear: () => undefined,
      getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
      launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
      projectRoot: () => '/ws/app',
      grpc: fakeGrpc(),
    });
    expect(((await api.call('get_status', {})) as any).grpc.simulatorTrust).toMatchObject({ decryptAll: true, devices: [{ udid: 'SIM-1', state: 'trusted' }, { udid: 'SIM-2', state: 'failed' }] });
    h.setSimulatorTrust(undefined);
    h.setGrpcDecryptAll(false);
    expect(h.simulatorTrust).toBeUndefined();
  });
});
