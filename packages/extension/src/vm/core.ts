/**
 * One debug session's VM-service watcher, transport-agnostic and vscode-free (CONTRACTS §11.4):
 * - background isolates → `SessionWarning {kind:'background-isolate'}` once per isolate name (≤ 10, then a summary);
 * - native clients (setting `flutterIntercept.nativeClients` = "profile") → HTTP timeline logging enabled where it
 *   is needed (background isolates; the main isolate only when it loaded package:http_profile), turned off again
 *   on stop, the HTTP profile polled (≤ 1/s, backing off when idle or failing, one call in flight per isolate),
 *   entries the proxy did not see recorded as read-only `captured:'vm-profile'` exchanges, plus a
 *   `SessionWarning {kind:'native-client'}`.
 * Everything degrades to nothing when a call fails or answers in an unexpected shape.
 */
import type { Exchange } from '@flutter-intercept/proxy';
import type { SessionWarning } from '../ui/protocol';
import type { VmHostDeps } from './types';
import type { VmTransport, VmTransportEvent } from './transport';
import {
  asHttpProfile,
  bodiesPatch,
  bodyPlan,
  classifyEntry,
  cleanText,
  clientName,
  diffExchange,
  isFinished,
  isPackageEntry,
  toExchange,
  type IsOurProxy,
  type ProfileEntry,
} from './profile';

export type NativeClientsMode = 'profile' | 'off';

export interface VmCoreDeps extends VmHostDeps {
  /** Current `flutterIntercept.nativeClients` (read on every poll). */
  nativeClients(): NativeClientsMode;
  /** Optional: poll only while the panel or an agent watches; entries are caught up later (`updatedSince`). */
  isWatched?(): boolean;
  /** Timers (tests inject fakes). */
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Per-call timeout, ms (default 5000). */
  callTimeoutMs?: number;
  /** Whether a dart:io `proxyDetails` host:port is OUR proxy (REVIEW-5 #14). Absent = never (import). */
  isOurProxy?: IsOurProxy;
}

export const POLL_MS = 1000;
export const IDLE_POLL_MS = [1000, 2000, 4000] as const;
export const MAX_ERROR_BACKOFF_MS = 30_000;
const LOGGING_RPC = 'ext.dart.io.httpEnableTimelineLogging';
const MAX_TRACKED = 5000;
const MAX_ISOLATES = 500;
const MAX_ISOLATE_WARNINGS = 10;
const MAX_SEEN_NAMES = 1000;
const MAX_CLIENTS = 5;

interface IsolateState {
  id: string;
  name?: string;
  main: boolean;
  /** The isolate loaded package:http_profile (undefined = unknown). */
  httpProfile?: boolean;
  /** dart:io registered its extensions (we can enable logging / poll). */
  hasIo: boolean;
  logging: 'off' | 'enabling' | 'on';
  since?: number;
  inFlight: boolean;
  dead: boolean;
}

interface Tracked {
  exchangeId?: string; // undefined = skipped
  last?: Omit<Exchange, 'id'>;
  done: boolean;
}

export interface VmSessionCore {
  start(transport: VmTransport): Promise<void>;
  stop(): void;
  /** For tests / diagnostics. */
  readonly stats: { polls: number; imported: number; intervalMs: number };
}

/** App-controlled name → safe display text: no control / bidi / quote characters, ≤ 60 chars (REVIEW-5 #13). */
export function safeName(name: string): string {
  const s = cleanText(name, 200).replace(/[^\p{L}\p{N} _.:()<>@,=+'#$&/[\]{}-]/gu, '?');
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

export function backgroundIsolateText(name: string | undefined): string {
  if (!name) return 'Requests from a background isolate are not intercepted (HttpOverrides is per isolate).';
  return `Requests from background isolate "${safeName(name)}" are not intercepted (HttpOverrides is per isolate).`.slice(0, 200);
}

export function moreIsolatesText(n: number): string {
  return `Requests from ${n} more background isolate${n === 1 ? '' : 's'} are not intercepted either.`;
}

export function nativeClientText(clients: string[]): string {
  const who = clients.length ? clients.slice(0, MAX_CLIENTS).map(safeName).join(', ') : 'a native HTTP client';
  return `Requests from ${who} bypass the proxy: shown read-only from the app's HTTP profile; rules don't apply to them.`.slice(0, 200);
}

/** Sentinel / unknown-isolate errors: the isolate is gone (exited, or replaced by a hot restart). */
export function isGoneError(e: unknown): boolean {
  return /Sentinel|Collected|Expired|isolate.*(not found|unknown)|Unrecognized isolate|Invalid isolate|kind: Collected/i.test(String((e as Error)?.message ?? e));
}

export function createVmSessionCore(sessionId: string, deps: VmCoreDeps): VmSessionCore {
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const callTimeoutMs = deps.callTimeoutMs ?? 5000;
  const isolates = new Map<string, IsolateState>();
  const tracked = new Map<string, Tracked>();
  let nativeWarning: SessionWarning | undefined;
  const isolateWarnings = new Map<string, SessionWarning>(); // ≤ MAX_ISOLATE_WARNINGS
  const seenNames = new Set<string>(); // ≤ MAX_SEEN_NAMES
  let moreIsolates = 0;
  const clients = new Set<string>();
  let mainId: string | undefined;
  let droppedInvalid = 0;
  let transport: VmTransport | undefined;
  let offEvents: (() => void) | undefined;
  let timer: unknown;
  let stopped = false;
  let emptyPolls = 0;
  let failures = 0;
  let modeOff = false;
  const stats = { polls: 0, imported: 0, intervalMs: POLL_MS };

  // Names and errors in log lines are app-controlled: no newlines / control / bidi characters (REVIEW-5 #13).
  const log = (msg: string) => deps.log(`vm[${sessionId.slice(0, 8)}]: ${cleanText(msg, 500)}`);

  /** A transport call with a timeout. `onSettled` runs when the call itself settles (even after a timeout). */
  function call(method: string, params?: Record<string, unknown>, onSettled?: () => void): Promise<unknown> {
    const t = transport;
    if (!t || stopped) return Promise.reject(new Error('stopped'));
    let raw: Promise<unknown>;
    try {
      raw = Promise.resolve(t.call(method, params));
    } catch (e) {
      raw = Promise.reject(e);
    }
    if (onSettled) raw.then(onSettled, onSettled);
    return new Promise((resolve, reject) => {
      const h = setT(() => reject(new Error(`${method}: timeout`)), callTimeoutMs);
      raw.then(
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

  /** Native-client warning first, ≤ 10 isolate warnings, then one summary (REVIEW-5 #12). */
  function pushWarnings(): void {
    if (stopped) return;
    const list: SessionWarning[] = [];
    if (nativeWarning) list.push(nativeWarning);
    list.push(...isolateWarnings.values());
    if (moreIsolates > 0) list.push({ id: `isolate:${sessionId}:+more`, kind: 'background-isolate', text: moreIsolatesText(moreIsolates), sessionId });
    deps.setWarnings(sessionId, list);
  }

  function warnIsolate(iso: IsolateState): void {
    if (iso.main) return;
    const key = iso.name ?? '?';
    if (seenNames.has(key)) return;
    if (seenNames.size < MAX_SEEN_NAMES) seenNames.add(key);
    if (isolateWarnings.size < MAX_ISOLATE_WARNINGS) {
      const id = `isolate:${sessionId}:${safeName(key)}`;
      isolateWarnings.set(id, { id, kind: 'background-isolate', text: backgroundIsolateText(iso.name), sessionId });
    } else {
      moreIsolates++;
    }
    pushWarnings();
  }

  function noteNativeClient(e: ProfileEntry): void {
    const name = clientName(e);
    if (nativeWarning && (!name || clients.has(name) || clients.size >= MAX_CLIENTS)) return;
    if (name && clients.size < MAX_CLIENTS) clients.add(name);
    nativeWarning = { id: `native:${sessionId}`, kind: 'native-client', text: nativeClientText([...clients]), sessionId };
    pushWarnings();
  }

  function mode(): NativeClientsMode {
    try {
      return deps.nativeClients() === 'off' ? 'off' : 'profile';
    } catch {
      return 'off';
    }
  }

  /** Timeline logging costs app memory (every dart:io request + body is kept): only where it can find something. */
  function needsLogging(iso: IsolateState): boolean {
    return !iso.main || iso.httpProfile !== false;
  }

  async function enableLogging(iso: IsolateState): Promise<void> {
    if (iso.dead || !iso.hasIo || iso.logging !== 'off' || mode() !== 'profile' || !needsLogging(iso)) return;
    iso.logging = 'enabling';
    try {
      await call(LOGGING_RPC, { isolateId: iso.id, enabled: 'true' });
      iso.logging = 'on';
      emptyPolls = 0;
      reschedule(0);
    } catch (e) {
      iso.logging = 'off';
      if (isGoneError(e)) iso.dead = true;
      else log(`could not enable HTTP profiling in isolate ${safeName(iso.name ?? iso.id)}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  async function disableLogging(): Promise<void> {
    for (const iso of isolates.values()) {
      if (iso.logging !== 'on' || iso.dead) continue;
      iso.logging = 'off';
      iso.since = undefined;
      await call(LOGGING_RPC, { isolateId: iso.id, enabled: 'false' }).catch(() => undefined);
    }
  }

  async function isolateInfo(id: string): Promise<{ name?: string; hasIo?: boolean; httpProfile?: boolean; gone?: boolean }> {
    try {
      const info = (await call('getIsolate', { isolateId: id })) as { name?: unknown; extensionRPCs?: unknown; type?: unknown; libraries?: unknown } | undefined;
      if (!info || typeof info !== 'object') return {};
      if (info.type === 'Sentinel') return { gone: true };
      const out: { name?: string; hasIo?: boolean; httpProfile?: boolean } = {};
      if (typeof info.name === 'string') out.name = info.name.slice(0, 1000);
      if (Array.isArray(info.extensionRPCs)) out.hasIo = info.extensionRPCs.includes(LOGGING_RPC);
      if (Array.isArray(info.libraries)) {
        out.httpProfile = info.libraries.some((l) => typeof (l as { uri?: unknown })?.uri === 'string' && (l as { uri: string }).uri.startsWith('package:http_profile/'));
      }
      return out;
    } catch (e) {
      return isGoneError(e) ? { gone: true } : {};
    }
  }

  /** Whether the current main isolate is gone (hot restart): asks the VM, the DAP has no IsolateExit. */
  async function mainGone(): Promise<boolean> {
    if (mainId === undefined) return true;
    const cur = isolates.get(mainId);
    if (!cur || cur.dead) return true;
    const info = await isolateInfo(mainId);
    if (info.gone) cur.dead = true;
    return Boolean(info.gone);
  }

  /**
   * Learns an isolate. Main = the only isolate at start, else the first named `main` at start; later a new isolate
   * named `main` only replaces a main isolate that is gone (hot restart). A background isolate merely NAMED `main`
   * stays a background isolate (REVIEW-5 #14).
   */
  async function addIsolate(id: string, name: string | undefined, opts: { mainAtStart?: boolean; hasIo?: boolean } = {}): Promise<IsolateState> {
    let iso = isolates.get(id);
    if (iso) {
      if (name && !iso.name) iso.name = name.slice(0, 1000);
      if (opts.hasIo) iso.hasIo = true;
      return iso;
    }
    iso = { id, name: name?.slice(0, 1000), main: false, hasIo: Boolean(opts.hasIo), logging: 'off', inFlight: false, dead: false };
    pruneIsolates();
    const tracking = isolates.size < MAX_ISOLATES;
    if (tracking) isolates.set(id, iso);
    const candidate = opts.mainAtStart || (iso.name ?? name) === 'main' || name === undefined;
    if (name === undefined || opts.hasIo === undefined || candidate) {
      const info = await isolateInfo(id);
      if (info.name !== undefined) iso.name ??= info.name;
      if (info.hasIo) iso.hasIo = true;
      iso.httpProfile = info.httpProfile;
      if (info.gone) iso.dead = true;
    }
    if (opts.mainAtStart) {
      iso.main = true;
      mainId = id;
    } else if (iso.name === 'main' && !iso.dead && (await mainGone())) {
      iso.main = true;
      mainId = id;
    }
    if (opts.hasIo) iso.hasIo = true;
    warnIsolate(iso);
    emptyPolls = 0;
    return iso;
  }

  function pruneIsolates(): void {
    for (const [id, iso] of isolates) if (iso.dead && !iso.inFlight && id !== mainId) isolates.delete(id);
  }

  function onEvent(e: VmTransportEvent): void {
    if (stopped) return;
    if (e.kind === 'closed') {
      log('VM service connection closed');
      halt();
      return;
    }
    if (e.kind === 'isolate-exit') {
      const iso = isolates.get(e.isolateId);
      if (iso) iso.dead = true;
      pruneIsolates();
      return;
    }
    if (e.kind === 'isolate-start') {
      void addIsolate(e.isolateId, e.name, { hasIo: false });
      return;
    }
    if (e.kind === 'extension-added' && e.rpc === LOGGING_RPC) {
      void addIsolate(e.isolateId, undefined, { hasIo: true }).then((iso) => {
        iso.hasIo = true;
        return enableLogging(iso);
      });
    }
  }

  function reschedule(ms?: number): void {
    if (stopped) return;
    if (timer !== undefined) clearT(timer);
    const pendingWork = [...tracked.values()].some((t) => t.exchangeId && !t.done);
    const idle = IDLE_POLL_MS[emptyPolls < 10 || pendingWork ? 0 : emptyPolls < 30 ? 1 : 2];
    const delay = ms ?? (failures > 0 ? Math.min(POLL_MS * 2 ** failures, MAX_ERROR_BACKOFF_MS) : idle);
    stats.intervalMs = delay;
    timer = setT(() => {
      timer = undefined;
      void tick();
    }, delay);
  }

  let ticking = false;
  async function tick(): Promise<void> {
    if (stopped || ticking) return; // the running tick reschedules
    ticking = true;
    try {
      await tickOnce();
    } finally {
      ticking = false;
    }
  }

  async function tickOnce(): Promise<void> {
    pruneIsolates();
    if (mode() === 'off') {
      if (!modeOff) {
        modeOff = true;
        await disableLogging();
      }
      reschedule(IDLE_POLL_MS[2]);
      return;
    }
    if (modeOff) {
      modeOff = false;
      for (const iso of isolates.values()) void enableLogging(iso);
    }
    if (deps.isWatched && !deps.isWatched()) {
      reschedule(IDLE_POLL_MS[0]);
      return;
    }
    const live = [...isolates.values()].filter((i) => i.logging === 'on' && !i.inFlight && !i.dead);
    if (live.length === 0) {
      reschedule();
      return;
    }
    const results = await Promise.all(live.map((iso) => pollIsolate(iso)));
    if (stopped) return;
    const ok = results.filter((r) => r !== 'error');
    failures = ok.length === 0 ? failures + 1 : 0;
    emptyPolls = results.some((r) => r === 'changed') ? 0 : emptyPolls + 1;
    reschedule();
  }

  async function pollIsolate(iso: IsolateState): Promise<'changed' | 'idle' | 'error'> {
    // In flight until the VM answers, even past our timeout (an isolate paused at a breakpoint answers on resume).
    iso.inFlight = true;
    stats.polls++;
    try {
      const params: Record<string, unknown> = { isolateId: iso.id };
      if (iso.since !== undefined) params.updatedSince = String(iso.since);
      const profile = asHttpProfile(await call('ext.dart.io.getHttpProfile', params, () => (iso.inFlight = false)));
      if (!profile) return 'error';
      iso.since = profile.timestamp;
      let changed = false;
      for (const entry of profile.requests) if (await handleEntry(iso, entry)) changed = true;
      return changed ? 'changed' : 'idle';
    } catch (e) {
      if (isGoneError(e)) {
        iso.dead = true;
        return 'idle';
      }
      return 'error';
    }
  }

  async function handleEntry(iso: IsolateState, entry: ProfileEntry): Promise<boolean> {
    if (!entry || typeof entry.id !== 'string' || entry.id.length > 200) return false;
    const key = `${iso.id}|${entry.id}`;
    const t = tracked.get(key);
    if (t) {
      // LRU: most recently seen last.
      tracked.delete(key);
      tracked.set(key, t);
    }
    if (t && (t.done || !t.exchangeId)) return false;
    if (!t) {
      const verdict = classifyEntry(entry, iso, deps.isOurProxy);
      if (verdict === 'wait') return false;
      if (verdict === 'skip') {
        remember(key, { done: true });
        return false;
      }
    }
    let ex: Omit<Exchange, 'id'> | undefined;
    try {
      ex = toExchange(entry);
    } catch {
      ex = undefined;
    }
    if (!ex) {
      // REVIEW-5 #7: invalid method / URL: dropped, one log line per session.
      if (droppedInvalid++ === 0) log('dropped an invalid HTTP profile entry (method or URL); further ones are dropped silently');
      if (t?.exchangeId) t.done = true;
      else remember(key, { done: true });
      return false;
    }
    const finished = isFinished(entry);
    let bodies: Partial<Exchange> = {};
    if (finished) {
      const plan = bodyPlan(entry);
      if (plan.fetch) {
        try {
          const detail = (await call('ext.dart.io.getHttpProfileRequest', { isolateId: iso.id, id: entry.id })) as ProfileEntry | undefined;
          if (detail && typeof detail === 'object') bodies = bodiesPatch(detail);
        } catch {
          /* keep the exchange without bodies */
        }
      } else {
        if (plan.requestBody) bodies.requestBody = plan.requestBody;
        if (plan.responseBody) bodies.responseBody = plan.responseBody;
      }
    }
    if (stopped) return false;
    if (!t) {
      let id: string | undefined;
      try {
        [id] = deps.record([{ ...ex, ...bodies }]);
      } catch (err) {
        log(`record failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
      remember(key, { exchangeId: id, last: ex, done: finished });
      if (!id) return false;
      stats.imported++;
      if (isPackageEntry(entry)) noteNativeClient(entry);
      return true;
    }
    const patch = { ...diffExchange(t.last!, ex), ...bodies };
    t.last = ex;
    t.done = finished;
    if (Object.keys(patch).length === 0) return false;
    try {
      deps.update(t.exchangeId!, patch);
    } catch {
      /* evicted from the ring buffer meanwhile */
    }
    return true;
  }

  /** Hard-capped LRU (pending entries are evicted too; an evicted pending exchange simply stays pending). */
  function remember(key: string, t: Tracked): void {
    tracked.delete(key);
    tracked.set(key, t);
    while (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value as string);
  }

  function halt(): void {
    stopped = true;
    if (timer !== undefined) clearT(timer);
    timer = undefined;
    offEvents?.();
    offEvents = undefined;
  }

  return {
    stats,
    async start(t: VmTransport): Promise<void> {
      if (transport || stopped) return;
      transport = t;
      offEvents = t.onEvent(onEvent);
      try {
        const vm = (await call('getVM')) as { isolates?: { id?: unknown; name?: unknown; isSystemIsolate?: unknown }[] } | undefined;
        const list = (Array.isArray(vm?.isolates) ? vm!.isolates : []).filter((i) => typeof i?.id === 'string' && i.isSystemIsolate !== true).slice(0, MAX_ISOLATES);
        const mainAt = list.length === 1 ? 0 : list.findIndex((i) => i.name === 'main');
        for (const [n, i] of list.entries()) {
          const iso = await addIsolate(i.id as string, typeof i.name === 'string' ? i.name : undefined, { mainAtStart: n === mainAt });
          void enableLogging(iso);
        }
      } catch (e) {
        log(`getVM failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
      reschedule();
    },
    stop(): void {
      if (stopped) return;
      // Best effort: turn HTTP timeline logging off where we turned it on (REVIEW-5 #15). Sent before the
      // transport closes (both transports send synchronously).
      const t = transport;
      for (const iso of isolates.values()) {
        if (iso.logging === 'off' || iso.dead || !t) continue;
        try {
          void Promise.resolve(t.call(LOGGING_RPC, { isolateId: iso.id, enabled: 'false' })).catch(() => undefined);
        } catch {
          /* ignore */
        }
        iso.logging = 'off';
      }
      halt();
      deps.setWarnings(sessionId, []);
    },
  };
}
