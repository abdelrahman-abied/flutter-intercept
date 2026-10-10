import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import type { SessionWarning } from '../../src/ui/protocol';
import { BYPASS_WINDOW_MS, createVmSessionCore, type NativeClientsMode } from '../../src/vm/core';
import { bypassText, bypassVerdict, isTrustError, matchesProxyExchange, type ProfileEntry } from '../../src/vm/profile';
import type { VmTransport, VmTransportEvent } from '../../src/vm/transport';

// ------------------------------------------------------------------------------------------- fake profiles

const T0 = 1_760_000_000_000_000; // µs
let seq = 0;
/** A finished main-isolate dart:io entry (shape of `_HttpProfileData.toJson`). */
function dartIo(uri: string, o: { fi?: boolean; proxy?: { host: string; port: number }; error?: string; unfinished?: boolean; method?: string } = {}): ProfileEntry {
  const headers: Record<string, string[]> = { 'user-agent': ['Dart/3.13 (dart:io)'] };
  if (o.fi) headers['x-fi-id'] = ['c70cf61e1c206f9e-1'];
  const e: ProfileEntry = {
    id: String(-1000 - ++seq),
    isolateId: 'isolates/1',
    method: o.method ?? 'GET',
    uri,
    startTime: T0,
    endTime: T0 + 1000,
    request: { headers, ...(o.proxy ? { proxyDetails: o.proxy } : {}), ...(o.error ? { error: o.error } : {}) },
  };
  if (!o.unfinished && !o.error) e.response = { statusCode: 200, startTime: T0 + 2000, endTime: T0 + 3000, headers: { 'content-type': ['application/json'] } };
  return e;
}
/** A package:http_profile entry (cronet_http). */
function native(n: number, o: { error?: string; unfinished?: boolean } = {}): ProfileEntry {
  return {
    id: `from_package/${n}`,
    method: 'GET',
    uri: 'https://jsonplaceholder.typicode.com/posts/1',
    startTime: T0,
    request: { headers: { 'x-demo-client': ['cronet_http'] }, connectionInfo: { package: 'package:cronet_http', client: 'CronetHttp' }, ...(o.error ? { error: o.error } : {}) },
    response: o.unfinished || o.error ? {} : { statusCode: 200, startTime: T0 + 1, endTime: T0 + 2, headers: { 'content-length': ['0'] } },
  };
}
const ours = (_h: string, p: number) => p === 9123;

describe('bypassVerdict (CONTRACTS §14.7)', () => {
  it('https through our proxy is fine; no proxyDetails or another proxy is a bypass', () => {
    expect(bypassVerdict(dartIo('https://api.example.com/a', { fi: true, proxy: { host: '10.0.2.2', port: 9123 } }), { isOurProxy: ours })).toEqual({ verdict: 'ok' });
    expect(bypassVerdict(dartIo('https://api.example.com/a'), { isOurProxy: ours })).toEqual({ verdict: 'bypass', host: 'api.example.com', cause: 'no-overrides' });
    expect(bypassVerdict(dartIo('https://api.example.com/a', { fi: true }), { isOurProxy: ours })).toEqual({ verdict: 'bypass', host: 'api.example.com', cause: 'connection' });
    expect(bypassVerdict(dartIo('https://api.example.com/a', { proxy: { host: '127.0.0.1', port: 8888 } }), { isOurProxy: ours })).toEqual({ verdict: 'bypass', host: 'api.example.com', cause: 'other-proxy' });
    // Without isOurProxy a proxied request can't be judged: not reported.
    expect(bypassVerdict(dartIo('https://api.example.com/a', { proxy: { host: '127.0.0.1', port: 8888 } }))).toEqual({ verdict: 'ok' });
  });

  it('plain http: the proxy decides, else a missing x-fi-id in a traced session', () => {
    const e = dartIo('http://api.example.com/a');
    expect(bypassVerdict(e, { proxySaw: () => true })).toEqual({ verdict: 'ok' });
    expect(bypassVerdict(e, { proxySaw: () => false })).toEqual({ verdict: 'bypass', host: 'api.example.com', cause: 'no-overrides' });
    expect(bypassVerdict(e, {})).toEqual({ verdict: 'ok' });
    expect(bypassVerdict(e, { traced: true })).toEqual({ verdict: 'bypass', host: 'api.example.com', cause: 'no-overrides' });
    expect(bypassVerdict(dartIo('http://api.example.com/a', { fi: true }), { traced: true })).toEqual({ verdict: 'ok' });
    expect(bypassVerdict(dartIo('http://api.example.com/a', { fi: true }), { proxySaw: () => false })).toEqual({ verdict: 'bypass', host: 'api.example.com', cause: 'connection' });
    expect(bypassVerdict(e, { proxySaw: () => { throw new Error('x'); } })).toEqual({ verdict: 'ok' });
  });

  it('waits for the response; never reports failures, CONNECT, the trace channel or native entries', () => {
    expect(bypassVerdict(dartIo('https://api.example.com/a', { unfinished: true }))).toEqual({ verdict: 'wait' });
    expect(bypassVerdict(dartIo('https://api.example.com/a', { error: 'Connection refused' }))).toEqual({ verdict: 'ok' });
    expect(bypassVerdict(dartIo('https://api.example.com:443', { method: 'CONNECT' }))).toEqual({ verdict: 'ok' });
    expect(bypassVerdict(dartIo('https://trace.flutter-intercept.invalid/v1/traces', { method: 'POST' }))).toEqual({ verdict: 'ok' });
    expect(bypassVerdict(native(1))).toEqual({ verdict: 'ok' });
    expect(bypassVerdict(dartIo('ftp://x/'))).toEqual({ verdict: 'ok' });
  });

  it('text: one sentence naming the host and the cause, sanitised', () => {
    expect(bypassText('api.example.com', 'no-overrides')).toBe(
      'Requests to api.example.com bypass the proxy: an HttpOverrides zone in the app (HttpOverrides.runZoned / runWithHttpOverrides) creates its own HttpClient.',
    );
    expect(bypassText('a‮b"c', 'unknown')).toMatch(/^Requests to ab\?c bypass the proxy: an HttpOverrides zone or a custom connectionFactory/);
    expect(bypassText('x'.repeat(500), 'connection').length).toBeLessThanOrEqual(200);
  });

  it('matchesProxyExchange: same method + URL from the proxy itself, within the clock window', () => {
    const q = { method: 'GET', url: 'http://api.example.com/a?b=1', startedAt: 1_000_000 };
    expect(matchesProxyExchange({ method: 'GET', url: 'http://api.example.com:80/a?b=1', startedAt: 1_030_000 }, q)).toBe(true);
    expect(matchesProxyExchange({ method: 'POST', url: q.url, startedAt: 1_000_000 }, q)).toBe(false);
    expect(matchesProxyExchange({ method: 'GET', url: q.url, startedAt: 1_000_000, captured: 'vm-profile' }, q)).toBe(false);
    expect(matchesProxyExchange({ method: 'GET', url: q.url, startedAt: 1_000_000 + 10 * 60_000 }, q)).toBe(false);
  });

  it('isTrustError recognises cronet and NSURLSession certificate failures', () => {
    expect(isTrustError(native(1, { error: 'NetworkClientException: Exception in CronetUrlRequest: net::ERR_CERT_AUTHORITY_INVALID, ErrorCode=11' }))).toBe(true);
    expect(isTrustError(native(1, { error: 'The certificate for this server is invalid.' }))).toBe(true);
    expect(isTrustError(native(1, { error: 'net::ERR_NAME_NOT_RESOLVED' }))).toBe(false);
    expect(isTrustError(native(1))).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- core

type Handler = (params: Record<string, unknown>) => unknown;
class FakeTransport implements VmTransport {
  readonly kind = 'dap' as const;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  handlers = new Map<string, Handler>();
  private listeners = new Set<(e: VmTransportEvent) => void>();
  on(method: string, h: Handler): this {
    this.handlers.set(method, h);
    return this;
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    const h = this.handlers.get(method);
    if (!h) throw new Error(`Method not found: ${method}`);
    return h(params);
  }
  onEvent(l: (e: VmTransportEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  close(): void {}
}

const MAIN = 'isolates/1';
const vm = { type: 'VM', isolates: [{ id: MAIN, name: 'main', isSystemIsolate: false }] };
const LOG = 'ext.dart.io.httpEnableTimelineLogging';

function setup(o: { mode?: NativeClientsMode; httpProfile?: boolean; routed?: () => boolean; proxySaw?: (q: { url: string }) => boolean | undefined } = {}) {
  const recorded: Omit<Exchange, 'id'>[] = [];
  const warnings: SessionWarning[][] = [];
  const failures: (string | undefined)[] = [];
  let queue: ProfileEntry[][] = [];
  let ts = 1;
  const libs = [{ uri: 'package:demo/main.dart' }, ...(o.httpProfile ? [{ uri: 'package:http_profile/http_profile.dart' }] : [])];
  const t = new FakeTransport()
    .on('getVM', () => vm)
    .on('getIsolate', () => ({ type: 'Isolate', id: MAIN, name: 'main', extensionRPCs: [LOG, 'ext.dart.io.getHttpProfile'], libraries: libs }))
    .on(LOG, () => ({ type: 'Success' }))
    .on('ext.dart.io.getHttpProfile', () => ({ type: 'HttpProfile', timestamp: ++ts, requests: queue.shift() ?? [] }))
    .on('ext.dart.io.getHttpProfileRequest', () => ({}));
  const core = createVmSessionCore('s1', {
    record: (exs) => exs.map((ex) => (recorded.push(ex), `vm${recorded.length}`)),
    update: () => undefined,
    setWarnings: (_s, w) => warnings.push(w),
    log: () => undefined,
    nativeClients: () => o.mode ?? 'profile',
    isOurProxy: ours,
    nativeRouted: o.routed,
    nativeRouteFailed: (c) => failures.push(c),
    proxySaw: o.proxySaw,
    now: () => Date.now(),
  });
  return { t, core, recorded, warnings, failures, push: (...polls: ProfileEntry[][]) => (queue = [...queue, ...polls]), logging: () => t.calls.filter((c) => c.method === LOG).map((c) => c.params.enabled) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('bypass detection in the session core', () => {
  it('warns once per host for main-isolate dart:io traffic that missed the proxy, never importing it', async () => {
    const s = setup();
    s.push([
      dartIo('https://api.example.com/a', { fi: true, proxy: { host: '10.0.2.2', port: 9123 } }),
      dartIo('https://jsonplaceholder.typicode.com/posts/1'),
      dartIo('https://jsonplaceholder.typicode.com/posts/2'),
      dartIo('https://cdn.example.com/x', { unfinished: true }),
    ]);
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.recorded).toEqual([]);
    const bypass = (s.warnings.at(-1) ?? []).filter((w) => w.kind === 'bypass');
    expect(bypass).toEqual([{ id: 'bypass:s1:jsonplaceholder.typicode.com', kind: 'bypass', sessionId: 's1', text: expect.stringContaining('HttpOverrides zone') }]);
    // The unfinished one finishes in the next poll (updatedSince returns it again).
    s.push([dartIo('https://cdn.example.com/x')]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((s.warnings.at(-1) ?? []).filter((w) => w.kind === 'bypass').map((w) => w.id)).toEqual(['bypass:s1:jsonplaceholder.typicode.com', 'bypass:s1:cdn.example.com']);
    s.core.stop();
    expect(s.warnings.at(-1)).toEqual([]);
  });

  it('caps bypass warnings at 10 plus a summary', async () => {
    const s = setup();
    s.push(Array.from({ length: 13 }, (_, i) => dartIo(`https://h${i}.example.com/`)));
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(10);
    const ws = (s.warnings.at(-1) ?? []).filter((w) => w.kind === 'bypass');
    expect(ws).toHaveLength(11);
    expect(ws.at(-1)?.text).toBe('Requests to 3 more hosts bypass the proxy too.');
  });

  it('main without package:http_profile: logging only during the window, then off', async () => {
    const s = setup();
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.logging()).toEqual(['true']);
    await vi.advanceTimersByTimeAsync(BYPASS_WINDOW_MS + 5000);
    expect(s.logging()).toEqual(['true', 'false']);
    const polls = s.t.calls.filter((c) => c.method === 'ext.dart.io.getHttpProfile').length;
    await vi.advanceTimersByTimeAsync(30_000); // drained, then no more polling of the main isolate
    const after = s.t.calls.filter((c) => c.method === 'ext.dart.io.getHttpProfile').length;
    expect(after - polls).toBeLessThanOrEqual(10);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.t.calls.filter((c) => c.method === 'ext.dart.io.getHttpProfile').length).toBe(after);
    s.core.stop();
    expect(s.logging()).toEqual(['true', 'false']); // not turned off twice
  });

  it('main with package:http_profile keeps logging (native clients) and still detects bypasses', async () => {
    const s = setup({ httpProfile: true });
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(BYPASS_WINDOW_MS + 15_000);
    expect(s.logging()).toEqual(['true']);
    s.push([dartIo('https://late.example.com/')]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((s.warnings.at(-1) ?? []).some((w) => w.id === 'bypass:s1:late.example.com')).toBe(true);
  });

  it('off: no logging, no bypass detection', async () => {
    const s = setup({ mode: 'off' });
    s.push([dartIo('https://api.example.com/')]);
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.logging()).toEqual([]);
    expect(s.warnings.flat().filter((w) => w.kind === 'bypass')).toEqual([]);
  });
});

describe('nativeClients "proxy" (routed native clients)', () => {
  it('routed: finished native entries are proxy exchanges (not imported); a route warning is shown', async () => {
    const s = setup({ mode: 'proxy', httpProfile: true, routed: () => true });
    s.push([native(1, { unfinished: true })], [native(1)]);
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.recorded).toEqual([]);
    expect((s.warnings.at(-1) ?? []).map((w) => w.id)).toEqual(['native-route:s1']);
    expect(s.failures).toEqual([]);
  });

  it('a TLS trust failure is imported, reported once to the host, and later entries are imported read-only again', async () => {
    let routed = true;
    const s = setup({ mode: 'proxy', httpProfile: true, routed: () => routed });
    s.push([native(1, { error: 'Exception in CronetUrlRequest: net::ERR_CERT_AUTHORITY_INVALID' }), native(2, { error: 'net::ERR_CERT_AUTHORITY_INVALID' })]);
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.failures).toEqual(['cronet_http']);
    expect(s.recorded.map((r) => r.state)).toEqual(['error', 'error']);
    const route = (s.warnings.at(-1) ?? []).find((w) => w.id === 'native-route:s1');
    expect(route?.text).toMatch(/^cronet_http rejected the proxy's certificate/);
    routed = false; // the host released the emulator
    s.push([native(3)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.recorded).toHaveLength(3);
    expect(s.recorded[2]).toMatchObject({ captured: 'vm-profile', state: 'completed' });
  });

  it('REVIEW-8 #7: a routed entry the proxy never recorded (route reverted meanwhile) is imported after all', async () => {
    const s = setup({ mode: 'proxy', httpProfile: true, routed: () => true, proxySaw: (q) => q.url.endsWith('/posts/1') && false });
    s.push([native(1)]);
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.recorded).toHaveLength(1);
    const seen = setup({ mode: 'proxy', httpProfile: true, routed: () => true, proxySaw: () => true });
    seen.push([native(1)]);
    await seen.core.start(seen.t);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.recorded).toEqual([]);
  });

  it('"proxy" without routing (iOS simulator, macOS, physical devices) behaves like "profile"', async () => {
    const s = setup({ mode: 'proxy', httpProfile: true, routed: () => false });
    s.push([native(1)]);
    await s.core.start(s.t);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.recorded).toHaveLength(1);
    expect((s.warnings.at(-1) ?? []).map((w) => w.kind)).toEqual(['native-client']);
  });
});
