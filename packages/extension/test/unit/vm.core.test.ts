import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Exchange } from '@flutter-intercept/proxy';
import type { SessionWarning } from '../../src/ui/protocol';
import { backgroundIsolateText, createVmSessionCore, isGoneError, moreIsolatesText, safeName, type NativeClientsMode } from '../../src/vm/core';
import type { VmTransport, VmTransportEvent } from '../../src/vm/transport';

const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vm', name), 'utf8')) as T;

type Handler = (params: Record<string, unknown>) => unknown;

/** Scripted VM service: handlers per method (a function, or a queue of answers; an Error answer rejects). */
class FakeTransport implements VmTransport {
  readonly kind = 'dap' as const;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  handlers = new Map<string, Handler>();
  private listeners = new Set<(e: VmTransportEvent) => void>();
  closed = false;
  on(method: string, h: Handler | unknown[]): this {
    if (Array.isArray(h)) {
      const queue = [...h];
      this.handlers.set(method, () => (queue.length > 1 ? queue.shift() : queue[0]));
    } else this.handlers.set(method, h);
    return this;
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    const h = this.handlers.get(method);
    if (!h) throw new Error(`Method not found: ${method}`);
    const v = await h(params);
    if (v instanceof Error) throw v;
    return v;
  }
  onEvent(l: (e: VmTransportEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: VmTransportEvent): void {
    for (const l of this.listeners) l(e);
  }
  close(): void {
    this.closed = true;
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

function host(mode: NativeClientsMode = 'profile') {
  const recorded: (Omit<Exchange, 'id'> & { id: string })[] = [];
  const updates: { id: string; patch: Partial<Exchange> }[] = [];
  const warnings: SessionWarning[][] = [];
  const logs: string[] = [];
  let n = 0;
  const state = { mode };
  return {
    recorded,
    updates,
    warnings,
    logs,
    state,
    deps: {
      record: (exs: Omit<Exchange, 'id'>[]) => exs.map((ex) => {
        const id = `vm${++n}`;
        recorded.push({ ...ex, id });
        return id;
      }),
      update: (id: string, patch: Partial<Exchange>) => updates.push({ id, patch }),
      setWarnings: (_sid: string, w: SessionWarning[]) => warnings.push(w),
      log: (m: string) => logs.push(m),
      nativeClients: () => state.mode,
    },
  };
}

const MAIN = 'isolates/1';
const vmWithMain = { type: 'VM', isolates: [{ type: '@Isolate', id: MAIN, name: 'main', isSystemIsolate: false }], systemIsolates: [{ id: 'isolates/9', name: 'vm-service', isSystemIsolate: true }] };
const mainIsolate = { type: 'Isolate', id: MAIN, name: 'main', extensionRPCs: ['ext.dart.io.httpEnableTimelineLogging', 'ext.dart.io.getHttpProfile'] };
const emptyProfile = (ts = 1) => ({ type: 'HttpProfile', timestamp: ts, requests: [] });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('native clients (recorded macOS cupertino_http profiles)', () => {
  it('records pending entries, then updates them with status and bodies; warns once', async () => {
    const h = host();
    const pending = fixture<{ timestamp: number }>('macos-profile-pending.json');
    const done = fixture<{ timestamp: number }>('macos-profile-done.json');
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', () => mainIsolate)
      .on('ext.dart.io.httpEnableTimelineLogging', () => ({ type: 'Success' }))
      .on('ext.dart.io.getHttpProfile', [pending, done, emptyProfile(done.timestamp + 1)])
      .on('ext.dart.io.getHttpProfileRequest', (p) => fixture(`macos-detail-${String(p.id).replace('/', '_')}.json`));
    const core = createVmSessionCore('sess-1', h.deps);
    await core.start(t);
    expect(t.calls.find((c) => c.method === 'ext.dart.io.httpEnableTimelineLogging')?.params).toEqual({ isolateId: MAIN, enabled: 'true' });

    await vi.advanceTimersByTimeAsync(10); // logging enabled → immediate poll
    expect(h.recorded.map((r) => [r.method, r.url, r.state, r.captured])).toEqual([
      ['GET', 'https://jsonplaceholder.typicode.com/posts/1', 'pending', 'vm-profile'],
      ['POST', 'https://jsonplaceholder.typicode.com/posts', 'pending', 'vm-profile'],
    ]);
    // Only the main isolate's dart:io entries were in the profile besides: none recorded (they went through the proxy).
    expect(h.warnings.at(-1)).toEqual([
      { id: 'native:sess-1', kind: 'native-client', sessionId: 'sess-1', text: expect.stringContaining('cupertino_http') },
    ]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls.filter((c) => c.method === 'ext.dart.io.getHttpProfile').map((c) => c.params.updatedSince)).toEqual([undefined, String(fixture<{ timestamp: number }>('macos-profile-pending.json').timestamp)]);
    const byId = new Map(h.updates.map((u) => [u.id, u.patch]));
    expect(byId.get('vm1')).toMatchObject({ status: 200, state: 'completed' });
    expect(JSON.parse(byId.get('vm1')!.responseBody!.text)).toMatchObject({ id: 1 });
    expect(byId.get('vm2')).toMatchObject({ status: 201, state: 'completed' });
    expect(JSON.parse(byId.get('vm2')!.requestBody!.text)).toEqual({ title: 'native', body: 'from cupertino_http', userId: 1 });

    // Finished entries are never updated again; no new records.
    const nUpdates = h.updates.length;
    t.on('ext.dart.io.getHttpProfile', () => done);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.updates.length).toBe(nUpdates);
    expect(h.recorded.length).toBe(2);
    core.stop();
    expect(h.warnings.at(-1)).toEqual([]);
  });

  it('records finished entries with bodies in one go (recorded Android cronet_http profile)', async () => {
    const h = host();
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', () => mainIsolate)
      .on('ext.dart.io.httpEnableTimelineLogging', () => ({ type: 'Success' }))
      .on('ext.dart.io.getHttpProfile', [fixture('android-debug-profile.json'), emptyProfile(2e15)])
      .on('ext.dart.io.getHttpProfileRequest', (p) => fixture(`android-detail-${String(p.id).replace('/', '_')}.json`));
    await createVmSessionCore('s', h.deps).start(t);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1]).toMatchObject({ method: 'POST', status: 201, state: 'completed', captured: 'vm-profile' });
    expect(JSON.parse(h.recorded[1].responseBody!.text)).toMatchObject({ id: 101 });
    // Detail requests only for the imported (finished) native entries.
    // REVIEW-5 #2: the GET's response length is unknown (chunked gzip): no detail call, a placeholder body.
    expect(t.calls.filter((c) => c.method === 'ext.dart.io.getHttpProfileRequest').map((c) => c.params.id)).toEqual(['from_package/2']);
    expect(h.recorded[0].responseBody).toEqual({ text: '[body not imported: unknown length]', encoding: 'utf8', truncated: true });
    expect(h.warnings.at(-1)?.[0].text).toContain('cronet_http');
  });

  it('dedupes per isolate: the same id in a restarted isolate is a new request', async () => {
    const h = host();
    const entry = (id: string) => ({ id, method: 'GET', uri: 'https://x.test/a', startTime: 1e15, endTime: 1e15 + 1, request: { headers: {} }, response: { statusCode: 200, endTime: 1e15 + 2, headers: {} } });
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', (p) => ({ ...mainIsolate, id: p.isolateId }))
      .on('ext.dart.io.httpEnableTimelineLogging', () => ({ type: 'Success' }))
      .on('ext.dart.io.getHttpProfile', (p) => ({ timestamp: 5, requests: [entry('from_package/1')], isolate: p.isolateId }))
      .on('ext.dart.io.getHttpProfileRequest', () => ({}));
    await createVmSessionCore('s', h.deps).start(t);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.recorded).toHaveLength(1);
    // Hot restart: old main exits, a new "main" registers dart:io.
    t.emit({ kind: 'isolate-exit', isolateId: MAIN });
    const mark = t.calls.length;
    t.emit({ kind: 'extension-added', isolateId: 'isolates/2', rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.recorded).toHaveLength(2);
    expect(h.warnings.flat().filter((w) => w.kind === 'background-isolate')).toEqual([]); // "main" is not a background isolate
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.recorded).toHaveLength(2);
    const later = t.calls.slice(mark).filter((c) => c.method === 'ext.dart.io.getHttpProfile');
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((c) => c.params.isolateId === 'isolates/2')).toBe(true);
  });
});

describe('background isolates', () => {
  it('warns once per isolate name (DAP: names via getIsolate), never for main', async () => {
    const h = host('off');
    const names: Record<string, string> = { 'isolates/5': 'demo_worker', 'isolates/6': 'demo_worker', 'isolates/7': 'demo_compute' };
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', (p) => (p.isolateId === MAIN ? mainIsolate : { type: 'Isolate', id: p.isolateId, name: names[String(p.isolateId)] }));
    const core = createVmSessionCore('sess-2', h.deps);
    await core.start(t);
    expect(h.warnings).toEqual([]);
    for (const id of Object.keys(names)) t.emit({ kind: 'extension-added', isolateId: id, rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    t.emit({ kind: 'extension-added', isolateId: 'isolates/7', rpc: 'ext.dart.io.getHttpProfile' }); // other RPCs are ignored
    await flush();
    expect(h.warnings.at(-1)).toEqual([
      { id: 'isolate:sess-2:demo_worker', kind: 'background-isolate', sessionId: 'sess-2', text: 'Requests from background isolate "demo_worker" are not intercepted (HttpOverrides is per isolate).' },
      { id: 'isolate:sess-2:demo_compute', kind: 'background-isolate', sessionId: 'sess-2', text: backgroundIsolateText('demo_compute') },
    ]);
    // Setting "off": no HTTP profiling at all.
    expect(t.count('ext.dart.io.httpEnableTimelineLogging')).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBe(0);
    core.stop();
    expect(h.warnings.at(-1)).toEqual([]);
  });

  it('WebSocket transport: names come with IsolateStart (recorded events)', async () => {
    const h = host('off');
    const t = new FakeTransport().on('getVM', () => ({ isolates: [] }));
    await createVmSessionCore('s', h.deps).start(t);
    for (const e of fixture<{ kind: string; isolate: { id: string; name: string }; extensionRPC?: string }[]>('ws-isolate-events.json')) {
      if (e.kind === 'IsolateStart') t.emit({ kind: 'isolate-start', isolateId: e.isolate.id, name: e.isolate.name });
      if (e.kind === 'IsolateExit') t.emit({ kind: 'isolate-exit', isolateId: e.isolate.id });
      if (e.kind === 'ServiceExtensionAdded') t.emit({ kind: 'extension-added', isolateId: e.isolate.id, rpc: e.extensionRPC! });
    }
    await flush();
    expect(t.count('getIsolate')).toBe(0);
    expect(h.warnings.at(-1)?.map((w) => w.id).sort()).toEqual(['isolate:s:demo_compute', 'isolate:s:demo_worker']);
  });

  it('a long name is shortened; an isolate gone before its name is known gets a generic warning', async () => {
    expect(backgroundIsolateText('x'.repeat(100))).toContain(`"${'x'.repeat(59)}…"`);
    const h = host('off');
    const t = new FakeTransport().on('getVM', () => vmWithMain).on('getIsolate', (p) => (p.isolateId === MAIN ? mainIsolate : new Error('[Sentinel kind: Collected, valueAsString: <collected>]')));
    await createVmSessionCore('s', h.deps).start(t);
    t.emit({ kind: 'extension-added', isolateId: 'isolates/3', rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    await flush();
    expect(h.warnings.at(-1)).toEqual([{ id: 'isolate:s:?', kind: 'background-isolate', sessionId: 's', text: backgroundIsolateText(undefined) }]);
  });

  it('the only isolate at start is the main one whatever its name', async () => {
    const h = host('off');
    const t = new FakeTransport().on('getVM', () => ({ isolates: [{ id: 'isolates/1', name: 'my_app', isSystemIsolate: false }] })).on('getIsolate', () => ({ name: 'my_app', extensionRPCs: [] }));
    await createVmSessionCore('s', h.deps).start(t);
    expect(h.warnings).toEqual([]);
  });
});

describe('polling', () => {
  function polling(profile: Handler) {
    const h = host();
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', () => mainIsolate)
      .on('ext.dart.io.httpEnableTimelineLogging', () => ({ type: 'Success' }))
      .on('ext.dart.io.getHttpProfile', profile);
    return { h, t };
  }

  it('≤ 1/s, slowing down when idle', async () => {
    const { h, t } = polling(() => emptyProfile());
    const core = createVmSessionCore('s', h.deps);
    await core.start(t);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBeLessThanOrEqual(11);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(core.stats.intervalMs).toBe(4000);
    const before = t.count('ext.dart.io.getHttpProfile');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(t.count('ext.dart.io.getHttpProfile') - before).toBeLessThanOrEqual(10);
    core.stop();
    const after = t.count('ext.dart.io.getHttpProfile');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBe(after);
  });

  it('backs off exponentially on errors (max 30 s)', async () => {
    const { h, t } = polling(() => new Error('Method not found'));
    const core = createVmSessionCore('s', h.deps);
    await core.start(t);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(core.stats.intervalMs).toBe(30_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBeLessThan(12);
    core.stop();
  });

  it('keeps one call in flight per isolate (an isolate paused at a breakpoint answers late)', async () => {
    let release!: (v: unknown) => void;
    const { h, t } = polling(() => new Promise((r) => (release = r)));
    const core = createVmSessionCore('s', { ...h.deps, callTimeoutMs: 2000 });
    await core.start(t);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBe(1);
    release(emptyProfile());
    t.on('ext.dart.io.getHttpProfile', () => emptyProfile());
    await vi.advanceTimersByTimeAsync(35_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBeGreaterThan(1);
    core.stop();
  });

  it('drops collected isolates', async () => {
    const { h, t } = polling(() => new Error('[Sentinel kind: Collected, valueAsString: <collected>]'));
    await createVmSessionCore('s', h.deps).start(t);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBe(1);
    expect(isGoneError(new Error('[Sentinel kind: Expired]'))).toBe(true);
    expect(isGoneError(new Error('timeout'))).toBe(false);
  });

  it('pauses while nobody watches, catching up afterwards', async () => {
    const { h, t } = polling(() => emptyProfile(7));
    let watched = false;
    await createVmSessionCore('s', { ...h.deps, isWatched: () => watched }).start(t);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBe(0);
    watched = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBeGreaterThan(0);
  });

  it('turning the setting off disables HTTP logging; on again re-enables it', async () => {
    const { h, t } = polling(() => emptyProfile());
    await createVmSessionCore('s', h.deps).start(t);
    await vi.advanceTimersByTimeAsync(1500);
    h.state.mode = 'off';
    await vi.advanceTimersByTimeAsync(5000);
    const logging = () => t.calls.filter((c) => c.method === 'ext.dart.io.httpEnableTimelineLogging').map((c) => c.params.enabled);
    expect(logging()).toEqual(['true', 'false']);
    const polls = t.count('ext.dart.io.getHttpProfile');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBe(polls);
    h.state.mode = 'profile';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logging()).toEqual(['true', 'false', 'true']);
    expect(t.count('ext.dart.io.getHttpProfile')).toBeGreaterThan(polls);
  });

  it('degrades to nothing on unexpected answers', async () => {
    const h = host();
    const t = new FakeTransport().on('getVM', () => 'nonsense').on('ext.dart.io.getHttpProfile', () => ({ what: 1 }));
    const core = createVmSessionCore('s', h.deps);
    await core.start(t);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.recorded).toEqual([]);
    expect(h.warnings).toEqual([]);
    core.stop();
  });

  it('stops when the transport closes', async () => {
    const { h, t } = polling(() => emptyProfile());
    await createVmSessionCore('s', h.deps).start(t);
    await vi.advanceTimersByTimeAsync(1500);
    t.emit({ kind: 'closed' });
    const n = t.count('ext.dart.io.getHttpProfile');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.count('ext.dart.io.getHttpProfile')).toBe(n);
  });
});

describe('REVIEW-5 hardening', () => {
  const logging = (t: FakeTransport) => t.calls.filter((c) => c.method === 'ext.dart.io.httpEnableTimelineLogging').map((c) => [c.params.isolateId, c.params.enabled]);

  it('#12: ≤ 10 isolate warnings plus a summary, native-client warning first, linear pushes', async () => {
    const h = host();
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', (p) => (p.isolateId === MAIN ? mainIsolate : { name: `worker_${String(p.isolateId).slice(9)}` }))
      .on('ext.dart.io.httpEnableTimelineLogging', () => ({ type: 'Success' }))
      .on('ext.dart.io.getHttpProfile', () => fixture('android-debug-profile.json'))
      .on('ext.dart.io.getHttpProfileRequest', () => ({}));
    await createVmSessionCore('s', h.deps).start(t);
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 200; i++) t.emit({ kind: 'extension-added', isolateId: `isolates/x${i}`, rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    await vi.advanceTimersByTimeAsync(10);
    const last = h.warnings.at(-1)!;
    expect(last[0].kind).toBe('native-client');
    expect(last.filter((w) => w.kind === 'background-isolate')).toHaveLength(11);
    expect(last.at(-1)!.text).toBe(moreIsolatesText(190));
    expect(Math.max(...h.warnings.map((w) => w.length))).toBeLessThanOrEqual(12);
    expect(h.warnings.length).toBeLessThan(220);
  });

  it('#13: isolate names are sanitised and quoted; log lines have no newlines', async () => {
    expect(safeName('evil\n[flutter_intercept] fake\u202e"x"')).toBe("evil[flutter_intercept] fake?x?");
    expect(backgroundIsolateText('a'.repeat(500)).length).toBeLessThanOrEqual(200);
    const h = host('profile');
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', (p) => (p.isolateId === MAIN ? mainIsolate : { name: 'w\nINJECTED', extensionRPCs: ['ext.dart.io.httpEnableTimelineLogging'] }))
      .on('ext.dart.io.httpEnableTimelineLogging', (p) => (p.isolateId === MAIN ? { type: 'Success' } : new Error('boom\nINJECTED line')));
    await createVmSessionCore('s', h.deps).start(t);
    t.emit({ kind: 'extension-added', isolateId: 'isolates/7', rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    await flush();
    expect(h.warnings.at(-1)![0].text).toContain('"wINJECTED"');
    expect(h.logs.every((l) => !/[\r\n]/.test(l))).toBe(true);
  });

  it('#14: an isolate merely NAMED main is a background isolate while the real main lives; a hot restart replaces main', async () => {
    const h = host('off');
    let oldMainGone = false;
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', (p) => {
        if (p.isolateId === MAIN) return oldMainGone ? new Error('[Sentinel kind: Collected]') : mainIsolate;
        return { type: 'Isolate', id: p.isolateId, name: 'main' };
      });
    await createVmSessionCore('s', h.deps).start(t);
    t.emit({ kind: 'extension-added', isolateId: 'isolates/66', rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    await flush();
    expect(h.warnings.at(-1)).toEqual([expect.objectContaining({ kind: 'background-isolate', text: backgroundIsolateText('main') })]);
    // Hot restart through the DAP (no IsolateExit): the old main answers Collected → the new "main" is main.
    oldMainGone = true;
    const n = h.warnings.length;
    t.emit({ kind: 'extension-added', isolateId: 'isolates/67', rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    await flush();
    expect(h.warnings.length).toBe(n);
  });

  it('#15: logging only where needed (main only with package:http_profile), off again on stop', async () => {
    const h = host();
    let libs = [{ uri: 'package:demo/main.dart' }];
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', (p) => (p.isolateId === MAIN ? { ...mainIsolate, libraries: libs } : { name: 'worker', extensionRPCs: [] }))
      .on('ext.dart.io.httpEnableTimelineLogging', () => ({ type: 'Success' }))
      .on('ext.dart.io.getHttpProfile', () => emptyProfile());
    const core = createVmSessionCore('s', h.deps);
    await core.start(t);
    await flush();
    expect(logging(t)).toEqual([]); // main without http_profile: nothing to find there
    t.emit({ kind: 'extension-added', isolateId: 'isolates/2', rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    await flush();
    expect(logging(t)).toEqual([['isolates/2', 'true']]);
    core.stop();
    expect(logging(t)).toEqual([['isolates/2', 'true'], ['isolates/2', 'false']]);

    const h2 = host();
    libs = [{ uri: 'package:demo/main.dart' }, { uri: 'package:http_profile/http_profile.dart' }];
    const t2 = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', () => ({ ...mainIsolate, libraries: libs }))
      .on('ext.dart.io.httpEnableTimelineLogging', () => ({ type: 'Success' }))
      .on('ext.dart.io.getHttpProfile', () => emptyProfile());
    const core2 = createVmSessionCore('s2', h2.deps);
    await core2.start(t2);
    await flush();
    expect(logging(t2)).toEqual([[MAIN, 'true']]);
    core2.stop();
    expect(logging(t2)).toEqual([[MAIN, 'true'], [MAIN, 'false']]);
  });

  it('#7: invalid entries are dropped with one log line', async () => {
    const h = host();
    const bad = (i: number) => ({ id: `from_package/${i}`, method: 'GET\u202e', uri: 'https://x.test/', startTime: 1, request: {}, response: {} });
    const t = new FakeTransport()
      .on('getVM', () => vmWithMain)
      .on('getIsolate', () => mainIsolate)
      .on('ext.dart.io.httpEnableTimelineLogging', () => ({ type: 'Success' }))
      .on('ext.dart.io.getHttpProfile', () => ({ timestamp: 1, requests: [bad(1), bad(2), bad(3)] }));
    await createVmSessionCore('s', h.deps).start(t);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.recorded).toEqual([]);
    expect(h.logs.filter((l) => l.includes('invalid HTTP profile entry'))).toHaveLength(1);
  });

  it('#12: dead isolates are pruned while the setting is off', async () => {
    const h = host('off');
    const t = new FakeTransport().on('getVM', () => vmWithMain).on('getIsolate', (p) => (p.isolateId === MAIN ? mainIsolate : { name: 'w' }));
    await createVmSessionCore('s', h.deps).start(t);
    for (let i = 0; i < 700; i++) {
      t.emit({ kind: 'extension-added', isolateId: `isolates/d${i}`, rpc: 'ext.dart.io.httpEnableTimelineLogging' });
      t.emit({ kind: 'isolate-exit', isolateId: `isolates/d${i}` });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    // Still learning new isolates after 700 dead ones (the map is pruned, not full).
    const before = t.count('getIsolate');
    t.emit({ kind: 'extension-added', isolateId: 'isolates/new', rpc: 'ext.dart.io.httpEnableTimelineLogging' });
    await flush();
    expect(t.count('getIsolate')).toBe(before + 1);
  });
});
