/**
 * Background-isolate interception (CONTRACTS §13.3, docs/spikes/background-isolates.md), vscode-free.
 *
 * HttpOverrides is per isolate, so `compute` / `Isolate.run` / `Isolate.spawn` isolates start without the entry's
 * overrides. In a debug session every isolate starts paused (the Flutter / Dart DAP launches with
 * `pause_isolates_on_start`) and the DAP releases it through DDS `readyToResume`. On our own VM-service WebSocket
 * (a separate DDS client) we:
 *   1. subscribe to the `Debug` stream — mandatory (REVIEW-7 #4): without PauseStart events we would hold isolates we
 *      never hear about, so a failed subscription closes the connection before any permission is taken;
 *   2. `requirePermissionToResume {onPauseStart: true}`: DDS now also waits for us before resuming a new isolate;
 *   3. on `PauseStart` (Debug stream, plus a scan of isolates already paused when we connect, repeated every 2 s as a
 *      safety net): if the isolate's root library is a generated entry (same program, template v5), `invoke` its
 *      top-level `flutterInterceptInstall()` (no expression compile), then `readyToResume`.
 * Never leaves an isolate paused: `readyToResume` runs on every path, at the latest after a 2 s budget per isolate;
 * if that call fails, anything in setup fails, or three sweeps in a row fail, the WebSocket is closed — DDS then
 * drops our permission and resumes whatever waited for us. `Isolate.spawnUri` isolates run another program (root
 * library is not the entry): not installed. The main isolate (launch, hot restart) is installed like any other: the
 * install is idempotent and the entry's own `main` then reuses the same overrides (REVIEW-7 #13: no name checks, so
 * an isolate merely named `main` is intercepted too).
 */
import type { VmTransport, VmTransportEvent } from './transport';
import { cleanText } from './profile';

export type InstallStatus = 'installed' | 'failed' | 'not-entry' | 'skipped';

export interface IsolateInstallerDeps {
  log(msg: string): void;
  /** Setting `flutterIntercept.backgroundIsolates`, read for every isolate; absent = "intercept". */
  backgroundIsolates?(): 'intercept' | 'warn';
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Per-isolate budget before it is resumed regardless, ms (default 2000). */
  budgetMs?: number;
  /** Interval of the PauseStart safety-net sweep, ms (default 2000). */
  sweepMs?: number;
}

export interface IsolateInstaller {
  /**
   * Takes over a WebSocket transport (subscribes to its Debug stream itself). Resolves true once DDS holds new
   * isolates for us; false when it can't (no Debug stream, no DDS, setup failed): the transport is closed then.
   */
  start(transport: VmTransport): Promise<boolean>;
  /**
   * What happened in this isolate. Waits up to `waitMs` for its PauseStart when it wasn't seen yet (the DAP's
   * `serviceExtensionAdded` can arrive first); undefined = not handled by us (not paused at start, or inactive).
   */
  status(isolateId: string, waitMs?: number): Promise<InstallStatus | undefined>;
  /** Closes the transport (DDS resumes anything still waiting for us). */
  stop(): void;
  readonly active: boolean;
  readonly stats: { held: number; installed: number; maxHeldMs: number };
}

export const INSTALL_FUNCTION = 'flutterInterceptInstall';
export const DDS_CLIENT_NAME = 'Flutter Intercept';
export const ISOLATE_BUDGET_MS = 2000;
export const SWEEP_MS = 2000;
const MAX_SWEEP_FAILURES = 3;
/** Root library of an isolate running our generated entry (any project): `…/.dart_tool/flutter_intercept/entry_*.dart`. */
export const ENTRY_ROOT_LIB = /\/\.dart_tool\/flutter_intercept\/entry_[^/]*\.dart$/;
const MAX_REMEMBERED = 1000;

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 200);
}

function isGone(e: unknown): boolean {
  return /Sentinel|Collected|Expired|isolate.*(not found|unknown)|Unrecognized isolate|Invalid isolate/i.test(errText(e));
}

export function createIsolateInstaller(sessionId: string, deps: IsolateInstallerDeps): IsolateInstaller {
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const budgetMs = deps.budgetMs ?? ISOLATE_BUDGET_MS;
  const sweepMs = deps.sweepMs ?? SWEEP_MS;
  /** Isolates seen running (not at PauseStart): PauseStart only happens before an isolate first runs. */
  const checked = new Set<string>();
  let sweepTimer: unknown;
  let sweeping = false;
  let sweepFailures = 0;
  const statuses = new Map<string, Promise<InstallStatus>>();
  const waiters = new Map<string, Set<(s: Promise<InstallStatus> | undefined) => void>>();
  const loggedNames = new Set<string>();
  let transport: VmTransport | undefined;
  let offEvents: (() => void) | undefined;
  let active = false;
  let stopped = false;
  const stats = { held: 0, installed: 0, maxHeldMs: 0 };

  const log = (msg: string) => deps.log(`vm[${sessionId.slice(0, 8)}]: ${cleanText(msg, 500)}`);
  const quoted = (name: string | undefined) => (name ? `"${cleanText(name, 60)}"` : 'a background isolate');

  function logOnce(key: string, msg: string): void {
    if (loggedNames.has(key)) return;
    if (loggedNames.size < MAX_REMEMBERED) loggedNames.add(key);
    log(msg);
  }

  function mode(): 'intercept' | 'warn' {
    try {
      return deps.backgroundIsolates?.() === 'warn' ? 'warn' : 'intercept';
    } catch {
      return 'warn';
    }
  }

  function call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const t = transport;
    if (!t || stopped) return Promise.reject(new Error('stopped'));
    try {
      return Promise.resolve(t.call(method, params));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Setup calls: a VM that stops answering must not keep isolates waiting for our approval. */
  function timed(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const h = setT(() => reject(new Error(`${method}: timeout`)), budgetMs);
      call(method, params).then(
        (v) => {
          clearT(h);
          resolve(v);
        },
        (e) => {
          clearT(h);
          reject(e);
        },
      );
    });
  }

  function wake(id: string, s: Promise<InstallStatus> | undefined): void {
    const ws = waiters.get(id);
    if (!ws) return;
    waiters.delete(id);
    for (const w of ws) w(s);
  }

  /** Last resort: closing our DDS client makes DDS resume every isolate that waited for our approval. */
  function release(why: string): void {
    if (stopped) return;
    log(`${why}; closing the isolate-install connection (DDS resumes what waited for it)`);
    stop();
  }

  function remember(id: string, p: Promise<InstallStatus>): void {
    statuses.set(id, p);
    while (statuses.size > MAX_REMEMBERED) statuses.delete(statuses.keys().next().value as string);
  }

  async function install(id: string, hint: string | undefined, budget: { over: boolean }): Promise<{ status: InstallStatus; name?: string }> {
    if (mode() !== 'intercept') return { status: 'skipped', name: hint };
    const info = (await call('getIsolate', { isolateId: id })) as { type?: unknown; name?: unknown; rootLib?: { id?: unknown; uri?: unknown } } | undefined;
    if (!info || typeof info !== 'object' || info.type === 'Sentinel') return { status: 'failed', name: hint };
    const name = typeof info.name === 'string' ? info.name : hint;
    const root = info.rootLib;
    if (!root || typeof root.id !== 'string' || typeof root.uri !== 'string' || !ENTRY_ROOT_LIB.test(root.uri)) return { status: 'not-entry', name };
    if (budget.over) return { status: 'failed', name };
    const r = (await call('invoke', { isolateId: id, targetId: root.id, selector: INSTALL_FUNCTION, argumentIds: [], disableBreakpoints: true })) as
      | { type?: unknown; message?: unknown }
      | undefined;
    if (!r || typeof r !== 'object' || r.type === '@Error' || r.type === 'Error' || r.type === 'Sentinel') {
      const msg = typeof r?.message === 'string' ? r.message : '';
      // A v4 entry (generated before 0.7.0, not rewritten yet) has no install function.
      const why = /NoSuchMethodError|No top-level method/.test(msg) ? 'the entry predates Flutter Intercept 0.7.0' : cleanText(msg, 160) || 'unexpected answer';
      logOnce(`fail:${name ?? '?'}`, `could not intercept background isolate ${quoted(name)}: ${why}`);
      return { status: 'failed', name };
    }
    if (budget.over) return { status: 'failed', name }; // installed, but only after it was resumed: may have missed requests
    return { status: 'installed', name };
  }

  function onPauseStart(id: string, hint: string | undefined): void {
    if (stopped || statuses.has(id)) return;
    const started = Date.now();
    stats.held++;
    const budget = { over: false };
    let resumed = false;
    const resume = () => {
      if (resumed) return;
      resumed = true;
      const held = Date.now() - started;
      if (held > stats.maxHeldMs) stats.maxHeldMs = held;
      call('readyToResume', { isolateId: id }).then(
        (r) => {
          if (r && typeof r === 'object' && (r as { type?: unknown }).type === 'Sentinel') return; // exited meanwhile
        },
        (e) => {
          if (!stopped && !isGone(e)) release(`readyToResume failed for an isolate (${errText(e)})`);
        },
      );
    };
    let timer: unknown;
    const p = new Promise<InstallStatus>((resolve) => {
      timer = setT(() => {
        budget.over = true;
        log(`isolate ${quoted(hint)}: no answer within ${budgetMs} ms; resumed without interception`);
        resolve('failed');
        resume();
      }, budgetMs);
      install(id, hint, budget).then(
        ({ status, name }) => {
          if (status === 'installed') {
            stats.installed++;
            if (name !== 'main') logOnce(`ok:${name ?? '?'}`, `requests from background isolate ${quoted(name)} go through the proxy (overrides installed at isolate start)`);
          } else if (status === 'not-entry') {
            logOnce(`other:${name ?? '?'}`, `background isolate ${quoted(name)} runs another program (Isolate.spawnUri?): not intercepted`);
          }
          resolve(status);
        },
        (e) => {
          if (!isGone(e) && !stopped) logOnce(`err:${hint ?? '?'}`, `could not intercept background isolate ${quoted(hint)}: ${errText(e)}`);
          resolve('failed');
        },
      );
    }).finally(() => {
      clearT(timer);
      resume();
    });
    remember(id, p);
    wake(id, p);
  }

  function onEvent(e: VmTransportEvent): void {
    if (stopped) return;
    if (e.kind === 'pause-start') onPauseStart(e.isolateId, e.name);
    else if (e.kind === 'closed') {
      // DDS resumes what waited for us when our client goes away.
      active = false;
      stopped = true;
      offEvents?.();
      if (sweepTimer !== undefined) clearT(sweepTimer);
      sweepTimer = undefined;
      for (const id of [...waiters.keys()]) wake(id, undefined);
    }
  }

  function stop(): void {
    if (stopped && !transport) return;
    stopped = true;
    active = false;
    offEvents?.();
    offEvents = undefined;
    if (sweepTimer !== undefined) clearT(sweepTimer);
    sweepTimer = undefined;
    const t = transport;
    transport = undefined;
    try {
      t?.close();
    } catch {
      /* ignore */
    }
    for (const id of [...waiters.keys()]) wake(id, undefined);
  }

  /** Handles every isolate at PauseStart that we haven't seen (missed events, the launch race). Throws on errors. */
  async function sweep(): Promise<void> {
    const vm = (await timed('getVM')) as { isolates?: { id?: unknown; name?: unknown; isSystemIsolate?: unknown }[] } | undefined;
    const live = new Set<string>();
    for (const i of Array.isArray(vm?.isolates) ? vm!.isolates : []) {
      if (stopped) return;
      if (typeof i?.id !== 'string' || i.isSystemIsolate === true) continue;
      live.add(i.id);
      if (statuses.has(i.id) || checked.has(i.id)) continue;
      const info = (await timed('getIsolate', { isolateId: i.id }).catch((e) => (isGone(e) ? undefined : Promise.reject(e)))) as
        | { pauseEvent?: { kind?: unknown } }
        | undefined;
      if (stopped) return;
      if (info?.pauseEvent?.kind === 'PauseStart') onPauseStart(i.id, typeof i.name === 'string' ? i.name : undefined);
      else if (info) checked.add(i.id);
    }
    for (const id of checked) if (!live.has(id)) checked.delete(id);
  }

  function scheduleSweep(): void {
    if (stopped || sweepMs <= 0) return;
    sweepTimer = setT(() => {
      sweepTimer = undefined;
      if (stopped || sweeping) return scheduleSweep();
      sweeping = true;
      sweep().then(
        () => {
          sweepFailures = 0;
        },
        (e) => {
          if (++sweepFailures >= MAX_SWEEP_FAILURES) release(`isolate sweeps keep failing (${errText(e)})`);
        },
      ).finally(() => {
        sweeping = false;
        scheduleSweep();
      });
    }, sweepMs);
    (sweepTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  return {
    stats,
    get active() {
      return active;
    },
    async start(t: VmTransport): Promise<boolean> {
      if (transport || stopped) {
        t.close();
        return false;
      }
      transport = t;
      offEvents = t.onEvent(onEvent);
      // REVIEW-7 #4: no PauseStart events → no permission (we'd hold isolates we never hear about).
      try {
        await timed('streamListen', { streamId: 'Debug' });
      } catch (e) {
        if (!/already subscribed/i.test(errText(e)) && (e as { code?: unknown })?.code !== 103) {
          log(`background isolates can't be intercepted (Debug stream: ${errText(e)})`);
          stop();
          return false;
        }
      }
      if (stopped) return false;
      try {
        await timed('setClientName', { name: DDS_CLIENT_NAME });
      } catch {
        /* only cosmetic (approvals are per client name; the default name is unique) */
      }
      try {
        await timed('requirePermissionToResume', { onPauseStart: true });
      } catch (e) {
        log(`background isolates can't be intercepted (no DDS resume permissions: ${errText(e)})`);
        stop();
        return false;
      }
      if (stopped) return false;
      active = true;
      // Isolates that paused before our Debug subscription took effect (the main isolate at launch, typically)
      // now wait for us too: approve or install them. A failed scan would leave them waiting: close instead.
      try {
        await sweep();
      } catch (e) {
        release(`could not list isolates (${errText(e)})`);
        return false;
      }
      scheduleSweep();
      return !stopped;
    },
    status(isolateId: string, waitMs = 0): Promise<InstallStatus | undefined> {
      const known = statuses.get(isolateId);
      if (known) return known;
      if (!active || stopped || waitMs <= 0) return Promise.resolve(undefined);
      return new Promise<InstallStatus | undefined>((resolve) => {
        let done = false;
        const finish = (p: Promise<InstallStatus> | undefined) => {
          if (done) return;
          done = true;
          clearT(h);
          const set = waiters.get(isolateId);
          set?.delete(finish);
          if (set && set.size === 0) waiters.delete(isolateId);
          if (p) p.then(resolve, () => resolve('failed'));
          else resolve(undefined);
        };
        const h = setT(() => finish(undefined), waitMs);
        let set = waiters.get(isolateId);
        if (!set) waiters.set(isolateId, (set = new Set()));
        set.add(finish);
      });
    },
    stop,
  };
}
