import { describe, expect, it } from 'vitest';
import { createIsolateInstaller, ENTRY_ROOT_LIB, type InstallStatus } from '../../src/vm/isolates';
import type { VmTransport, VmTransportEvent } from '../../src/vm/transport';

type Handler = (params: Record<string, unknown>) => unknown;

/** Scripted DDS client (the WebSocket transport): handlers per method; an Error answer rejects. */
class FakeDds implements VmTransport {
  readonly kind = 'ws' as const;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  handlers = new Map<string, Handler>();
  private listeners = new Set<(e: VmTransportEvent) => void>();
  closed = false;
  on(method: string, h: Handler): this {
    this.handlers.set(method, h);
    return this;
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new Error('transport closed');
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
    for (const l of [...this.listeners]) l(e);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ kind: 'closed' });
  }
  resumed(): string[] {
    return this.calls.filter((c) => c.method === 'readyToResume').map((c) => c.params.isolateId as string);
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const ENTRY_URI = 'file:///Users/dev/app/.dart_tool/flutter_intercept/entry_lib__main.dart';
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 10) {
  for (let i = 0; i < n; i++) await tick();
}

/** A DDS with a main isolate already running and spawned isolates `isolates/<n>` named per `names`. */
function dds(opts: { names?: Record<string, string>; rootUri?: Record<string, string>; mainPaused?: boolean } = {}) {
  const names: Record<string, string> = { 'isolates/1': 'main', ...(opts.names ?? {}) };
  const t = new FakeDds()
    .on('streamListen', () => ({ type: 'Success' }))
    .on('setClientName', () => ({ type: 'Success' }))
    .on('requirePermissionToResume', () => ({ type: 'Success' }))
    .on('getVM', () => ({ type: 'VM', isolates: [{ id: 'isolates/1', name: 'main', isSystemIsolate: false }, { id: 'isolates/0', name: 'vm-service', isSystemIsolate: true }] }))
    .on('getIsolate', (p) => {
      const id = p.isolateId as string;
      if (!names[id]) return new Error('[Sentinel kind: Collected]');
      return {
        type: 'Isolate',
        id,
        name: names[id],
        rootLib: { id: 'libraries/@1', uri: opts.rootUri?.[id] ?? ENTRY_URI },
        pauseEvent: { kind: id === 'isolates/1' && opts.mainPaused ? 'PauseStart' : 'Resume' },
      };
    })
    .on('invoke', () => ({ type: '@Instance', kind: 'Null', valueAsString: 'null' }))
    .on('readyToResume', () => ({ type: 'Success' }));
  return { t, names };
}

function installer(over: { mode?: () => 'intercept' | 'warn'; budgetMs?: number; sweepMs?: number } = {}) {
  const logs: string[] = [];
  const inst = createIsolateInstaller('session-1', { log: (m) => logs.push(m), backgroundIsolates: over.mode, budgetMs: over.budgetMs, sweepMs: over.sweepMs ?? 0 });
  return { inst, logs };
}

describe('background-isolate installer (CONTRACTS §13.3)', () => {
  it('matches only generated entries as root libraries', () => {
    expect(ENTRY_ROOT_LIB.test(ENTRY_URI)).toBe(true);
    expect(ENTRY_ROOT_LIB.test('file:///C:/app/.dart_tool/flutter_intercept/entry_lib__flavors__dev__main_1a2b3c4d.dart')).toBe(true);
    expect(ENTRY_ROOT_LIB.test('file:///app/bin/other.dart')).toBe(false);
    expect(ENTRY_ROOT_LIB.test('package:app/main.dart')).toBe(false);
    expect(ENTRY_ROOT_LIB.test('file:///app/.dart_tool/flutter_intercept/sub/entry_x.dart')).toBe(false);
  });

  it('asks DDS to hold isolates at start, installs in a spawned isolate, then lets it resume', async () => {
    const { t } = dds({ names: { 'isolates/5': 'demo_worker' } });
    const { inst, logs } = installer();
    expect(await inst.start(t)).toBe(true);
    expect(t.calls.slice(0, 3).map((c) => c.method)).toEqual(['streamListen', 'setClientName', 'requirePermissionToResume']);
    expect(t.calls[0].params).toEqual({ streamId: 'Debug' });
    expect(t.calls[2].params).toEqual({ onPauseStart: true });
    expect(inst.active).toBe(true);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'demo_worker' });
    expect(await inst.status('isolates/5')).toBe('installed');
    const invoke = t.calls.find((c) => c.method === 'invoke')!;
    expect(invoke.params).toEqual({ isolateId: 'isolates/5', targetId: 'libraries/@1', selector: 'flutterInterceptInstall', argumentIds: [], disableBreakpoints: true });
    // Resumed after the install, never before.
    const order = t.calls.map((c) => c.method);
    expect(order.indexOf('readyToResume')).toBeGreaterThan(order.indexOf('invoke'));
    expect(t.resumed()).toEqual(['isolates/5']);
    expect(inst.stats.installed).toBe(1);
    expect(logs.some((l) => /background isolate "demo_worker" go through the proxy/.test(l))).toBe(true);
    // A second PauseStart for the same isolate is ignored.
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'demo_worker' });
    await settle();
    expect(t.count('invoke')).toBe(1);
  });

  it('logs once per isolate name (compute runs a new isolate each time)', async () => {
    const { t, names } = dds();
    const { inst, logs } = installer();
    await inst.start(t);
    for (let i = 10; i < 15; i++) {
      names[`isolates/${i}`] = 'demo_compute';
      t.emit({ kind: 'pause-start', isolateId: `isolates/${i}`, name: 'demo_compute' });
      expect(await inst.status(`isolates/${i}`)).toBe('installed');
    }
    expect(logs.filter((l) => /demo_compute/.test(l))).toHaveLength(1);
    expect(t.resumed()).toHaveLength(5);
  });

  it('handles the main isolate it finds paused at start (launch race): installed (idempotent with main), resumed', async () => {
    const { t, names } = dds({ mainPaused: true });
    const { inst, logs } = installer();
    expect(await inst.start(t)).toBe(true);
    expect(await inst.status('isolates/1')).toBe('installed');
    expect(t.resumed()).toEqual(['isolates/1']);
    // hot restart: a new main isolate
    names['isolates/2'] = 'main';
    t.emit({ kind: 'pause-start', isolateId: 'isolates/2', name: 'main' });
    expect(await inst.status('isolates/2')).toBe('installed');
    expect(t.resumed()).toEqual(['isolates/1', 'isolates/2']);
    // No "background isolate" log line for main.
    expect(logs.some((l) => /"main"/.test(l))).toBe(false);
  });

  it('REVIEW-7 #13: a background isolate merely named "main" is intercepted (no name checks)', async () => {
    const { t } = dds({ names: { 'isolates/9': 'main' } });
    const { inst } = installer();
    await inst.start(t);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/9', name: 'main' });
    expect(await inst.status('isolates/9')).toBe('installed');
    expect(t.calls.find((c) => c.method === 'invoke')?.params.isolateId).toBe('isolates/9');
  });

  it('REVIEW-7 #4: the installer does not call requirePermissionToResume when streamListen(Debug) fails', async () => {
    const { t } = dds({ mainPaused: true });
    t.on('streamListen', () => new Error('Stream Debug cannot be subscribed'));
    const { inst, logs } = installer();
    expect(await inst.start(t)).toBe(false);
    expect(t.count('requirePermissionToResume')).toBe(0);
    expect(t.count('readyToResume')).toBe(0);
    expect(t.closed).toBe(true);
    expect(inst.active).toBe(false);
    expect(logs.some((l) => /Debug stream/.test(l))).toBe(true);
  });

  it('REVIEW-7 #4: "already subscribed" (code 103) is fine', async () => {
    const { t } = dds();
    t.on('streamListen', () => Object.assign(new Error('Stream already subscribed'), { code: 103 }));
    const { inst } = installer();
    expect(await inst.start(t)).toBe(true);
    expect(t.count('requirePermissionToResume')).toBe(1);
    inst.stop();
  });

  it('REVIEW-7 #4: the periodic sweep handles an isolate whose PauseStart event never arrived', async () => {
    const { t, names } = dds();
    const { inst } = installer({ sweepMs: 10 });
    await inst.start(t);
    // A new isolate paused at start, no event.
    names['isolates/5'] = 'silent';
    const vmBefore = t.handlers.get('getVM')!;
    t.on('getVM', () => ({ isolates: [...(vmBefore({}) as { isolates: unknown[] }).isolates, { id: 'isolates/5', name: 'silent', isSystemIsolate: false }] }));
    const getIsolate = t.handlers.get('getIsolate')!;
    t.on('getIsolate', (p) => (p.isolateId === 'isolates/5' ? { ...(getIsolate(p) as object), pauseEvent: { kind: 'PauseStart' } } : getIsolate(p)));
    expect(await inst.status('isolates/5', 1000)).toBe('installed');
    expect(t.resumed()).toEqual(['isolates/5']);
    // Running isolates are checked once, not on every sweep.
    const before = t.calls.filter((c) => c.method === 'getIsolate' && c.params.isolateId === 'isolates/1').length;
    await new Promise((r) => setTimeout(r, 60));
    expect(t.calls.filter((c) => c.method === 'getIsolate' && c.params.isolateId === 'isolates/1').length).toBe(before);
    expect(t.count('getVM')).toBeGreaterThan(2);
    inst.stop();
    const n = t.count('getVM');
    await new Promise((r) => setTimeout(r, 40));
    expect(t.count('getVM')).toBe(n);
  });

  it('REVIEW-7 #4: three failing sweeps in a row close the connection (DDS releases everything)', async () => {
    const { t } = dds();
    const { inst, logs } = installer({ sweepMs: 5 });
    await inst.start(t);
    t.on('getVM', () => new Error('Internal error'));
    await new Promise((r) => setTimeout(r, 80));
    expect(t.closed).toBe(true);
    expect(logs.some((l) => /sweeps keep failing/.test(l))).toBe(true);
  });

  it('Isolate.spawnUri (another program): not installed, resumed', async () => {
    const { t } = dds({ names: { 'isolates/7': 'worker' }, rootUri: { 'isolates/7': 'file:///app/bin/other.dart' } });
    const { inst, logs } = installer();
    await inst.start(t);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/7', name: 'worker' });
    expect(await inst.status('isolates/7')).toBe('not-entry');
    expect(t.count('invoke')).toBe(0);
    expect(t.resumed()).toEqual(['isolates/7']);
    expect(logs.some((l) => /runs another program/.test(l))).toBe(true);
  });

  it('an entry without the install function (v4) fails cleanly and still resumes', async () => {
    const { t } = dds({ names: { 'isolates/5': 'w' } });
    t.on('invoke', () => ({ type: '@Error', kind: 'UnhandledException', message: "NoSuchMethodError: No top-level method 'flutterInterceptInstall' declared." }));
    const { inst, logs } = installer();
    await inst.start(t);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'w' });
    expect(await inst.status('isolates/5')).toBe('failed');
    expect(t.resumed()).toEqual(['isolates/5']);
    expect(logs.some((l) => /predates Flutter Intercept 0\.7\.0/.test(l))).toBe(true);
  });

  it('errors in getIsolate / invoke still resume', async () => {
    const { t } = dds({ names: { 'isolates/5': 'a', 'isolates/6': 'b' } });
    const { inst } = installer();
    await inst.start(t);
    t.on('getIsolate', (p) => (p.isolateId === 'isolates/5' ? new Error('boom') : { type: 'Isolate', name: 'b', rootLib: { id: 'l', uri: ENTRY_URI } }));
    t.on('invoke', () => new Error('Isolate must be paused'));
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'a' });
    t.emit({ kind: 'pause-start', isolateId: 'isolates/6', name: 'b' });
    expect(await inst.status('isolates/5')).toBe('failed');
    expect(await inst.status('isolates/6')).toBe('failed');
    expect(t.resumed().sort()).toEqual(['isolates/5', 'isolates/6']);
  });

  it('"warn" (read per isolate): no install, resumed at once', async () => {
    let mode: 'intercept' | 'warn' = 'warn';
    const { t } = dds({ names: { 'isolates/5': 'w', 'isolates/6': 'w' } });
    const { inst } = installer({ mode: () => mode });
    await inst.start(t);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'w' });
    expect(await inst.status('isolates/5')).toBe('skipped');
    mode = 'intercept';
    t.emit({ kind: 'pause-start', isolateId: 'isolates/6', name: 'w' });
    expect(await inst.status('isolates/6')).toBe('installed');
    expect(t.resumed()).toEqual(['isolates/5', 'isolates/6']);
  });

  it('a hung VM call: resumed after the 2 s budget, reported as failed', async () => {
    const { t } = dds({ names: { 'isolates/5': 'slow' } });
    t.on('invoke', () => new Promise(() => {}));
    const { inst, logs } = installer({ budgetMs: 30 });
    await inst.start(t);
    const before = Date.now();
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'slow' });
    expect(await inst.status('isolates/5')).toBe('failed');
    expect(Date.now() - before).toBeGreaterThanOrEqual(25);
    expect(t.resumed()).toEqual(['isolates/5']);
    expect(logs.some((l) => /no answer within 30 ms/.test(l))).toBe(true);
  });

  it('defaults to a 2 s budget', async () => {
    const delays: number[] = [];
    const inst = createIsolateInstaller('s', {
      log: () => undefined,
      sweepMs: 0,
      setTimeout: (fn, ms) => {
        delays.push(ms);
        return setTimeout(fn, 0);
      },
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    });
    const { t } = dds({ names: { 'isolates/5': 'x' } });
    t.on('invoke', () => new Promise(() => {}));
    await inst.start(t);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'x' });
    expect(await inst.status('isolates/5')).toBe('failed');
    expect(delays).toContain(2000);
    expect(t.resumed()).toEqual(['isolates/5']);
  });

  it('readyToResume failing: closes the connection (DDS then resumes whatever waited for us)', async () => {
    const { t } = dds({ names: { 'isolates/5': 'w' } });
    t.on('readyToResume', () => new Error('Internal error'));
    const { inst, logs } = installer();
    await inst.start(t);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'w' });
    await inst.status('isolates/5');
    await settle();
    expect(t.closed).toBe(true);
    expect(inst.active).toBe(false);
    expect(logs.some((l) => /closing the isolate-install connection/.test(l))).toBe(true);
  });

  it('a Collected sentinel from readyToResume (isolate gone) is fine', async () => {
    const { t } = dds({ names: { 'isolates/5': 'w' } });
    t.on('readyToResume', () => ({ type: 'Sentinel', kind: 'Collected' }));
    const { inst } = installer();
    await inst.start(t);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'w' });
    await inst.status('isolates/5');
    await settle();
    expect(t.closed).toBe(false);
  });

  it('no DDS (requirePermissionToResume unknown): gives up and closes, nothing is held', async () => {
    const { t } = dds();
    t.handlers.delete('requirePermissionToResume');
    const { inst, logs } = installer();
    expect(await inst.start(t)).toBe(false);
    expect(t.closed).toBe(true);
    expect(inst.active).toBe(false);
    expect(await inst.status('isolates/5', 50)).toBeUndefined();
    expect(logs.some((l) => /no DDS resume permissions/.test(l))).toBe(true);
  });

  it('a failed isolate scan after taking the permission closes the connection (never leaves main waiting)', async () => {
    const { t } = dds({ mainPaused: true });
    t.on('getVM', () => new Error('socket hang up'));
    const { inst } = installer();
    expect(await inst.start(t)).toBe(false);
    expect(t.closed).toBe(true);
  });

  it('a VM that stops answering during setup: the connection is closed (budget), nothing stays held', async () => {
    const { t } = dds({ mainPaused: true });
    t.on('getVM', () => new Promise(() => {}));
    const { inst, logs } = installer({ budgetMs: 20 });
    expect(await inst.start(t)).toBe(false);
    expect(t.closed).toBe(true);
    expect(logs.some((l) => /getVM: timeout/.test(l))).toBe(true);
  });

  it('status() waits for a PauseStart that arrives after the DAP reported the isolate', async () => {
    const { t } = dds({ names: { 'isolates/5': 'w' } });
    const { inst } = installer();
    await inst.start(t);
    const pending = inst.status('isolates/5', 500);
    setTimeout(() => t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'w' }), 10);
    expect(await pending).toBe('installed');
    // Never paused at start (e.g. it existed before we connected): undefined after the wait.
    expect(await inst.status('isolates/99', 20)).toBeUndefined();
    expect(await inst.status('isolates/98')).toBeUndefined();
  });

  it('stop() closes the transport; pending waits resolve undefined; later events are ignored', async () => {
    const { t } = dds({ names: { 'isolates/5': 'w' } });
    const { inst } = installer();
    await inst.start(t);
    const waiting = inst.status('isolates/5', 5000);
    inst.stop();
    expect(t.closed).toBe(true);
    expect(await waiting).toBeUndefined();
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'w' });
    await settle();
    expect(t.count('invoke')).toBe(0);
  });

  it('the transport closing on its own deactivates it', async () => {
    const { t } = dds();
    const { inst } = installer();
    await inst.start(t);
    t.close();
    expect(inst.active).toBe(false);
    const s: InstallStatus | undefined = await inst.status('isolates/5', 50);
    expect(s).toBeUndefined();
  });

  it('isolate names in log lines are sanitised', async () => {
    const { t } = dds({ names: { 'isolates/5': 'evil\u202e\nname' } });
    const { inst, logs } = installer();
    await inst.start(t);
    t.emit({ kind: 'pause-start', isolateId: 'isolates/5', name: 'evil\u202e\nname' });
    await inst.status('isolates/5');
    expect(logs.join('\n')).not.toMatch(/[\u202e]|evil\n/);
  });
});
