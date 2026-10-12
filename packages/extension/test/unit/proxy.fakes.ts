// QUALITY-1 Q4: one fake of the proxy surface the host uses (`ProxyLike`), with no-op defaults for every member. Tests
// pass only what they observe; `withFakeProxy` wraps an InterceptProxyHost's options so a test's factory may return a
// partial object.
import { EventEmitter } from 'events';
import type { InterceptProxyOptions } from '@flutter-intercept/proxy';
import type { InterceptProxyHostOptions, ProxyLike } from '../../src/proxyHost';

/** A full ProxyLike: `overrides` (any subset, own `on` / `emit` included) win over the defaults. */
export function fakeProxy(opts: InterceptProxyOptions, overrides: object = {}): ProxyLike {
  const ee = new EventEmitter();
  const base = {
    port: opts.port ?? 0,
    start: async () => undefined,
    stop: async () => undefined,
    setRules: () => undefined,
    getExchanges: () => [],
    clear: () => undefined,
    resume: () => undefined,
    abort: () => undefined,
    on: (ev: string, l: (...a: unknown[]) => void) => ee.on(ev, l),
    emit: (ev: string, ...a: unknown[]) => ee.emit(ev, ...a),
    openLan: async (o: { host: string; port?: number }) => ({ host: o.host, port: o.port ?? 0 }),
    closeLan: async () => undefined,
    lan: undefined,
    lanPeer: undefined,
    send: async () => ({ id: 'sent' }),
    setNetworkProfile: () => undefined,
    setAppPackages: () => undefined,
    record: () => 'recorded',
    update: () => true,
    setWebSessionActive: () => undefined,
    setReplay: () => undefined,
    resetSequences: () => undefined,
    setUpstreamProxy: () => undefined,
    upstreamProxy: undefined,
    setTlsPassthrough: (hosts?: string[]) => ({ hosts: hosts ?? [], problems: [] }),
    tlsPassthrough: undefined,
    setClientCertificates: (certs?: { host: string }[]) => (certs ?? []).map((c) => ({ host: c.host })),
    setGrpcDecryptHosts: (hosts?: string[]) => ({ hosts: hosts ?? [], problems: [] }),
    grpcSupport: () => ({ ok: true }),
    setGrpcDecryptAll: () => undefined,
    setGrpcCodec: () => undefined,
  };
  // Keep getters (e.g. `get port()`, `get lan()`) of the overrides live.
  const out = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(out, Object.getOwnPropertyDescriptors(base));
  Object.defineProperties(out, Object.getOwnPropertyDescriptors(overrides));
  return out as unknown as ProxyLike;
}

/** InterceptProxyHost options whose `factory` may return a partial proxy (filled by `fakeProxy`). */
export function withFakeProxy(o: Omit<InterceptProxyHostOptions, 'factory'> & { factory: (opts: InterceptProxyOptions) => object }): InterceptProxyHostOptions {
  return { ...o, factory: (opts) => fakeProxy(opts, o.factory(opts)) };
}
