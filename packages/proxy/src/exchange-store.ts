// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import { randomUUID } from 'crypto';
import { cleanHeaders, type HeaderBag } from './body';
import { MAX_NOTES } from './grpc-meta';
import { diagnoseCors } from './cors';
import { frameCost, LIVE_FRAME_FLOOR, MAX_FRAME_BYTES_PER_EXCHANGE } from './frames';
import { isBrowserInternal } from './browser';
import { elapsed, type TimingPatch } from './timing';
import type { Body, Exchange, Frame } from './types';
import { grpcWebExchangeFields } from './grpc-web-flow';
import type { Flow, RequestTimingEvents, Live } from './flow-types';
import { bodySize, FRAME_EMIT_INTERVAL_MS, clipNote, snapshot, graphqlOf, sanitizeRecord } from './proxy-util';
import type { ProxyContext } from './proxy-context';

/** The exchange store: ring buffer, live exchanges, frames, byte budget and change events. */
export class ExchangeStore {
  readonly maxExchanges: number;
  readonly maxStoredBodyBytes: number;
  /** Ring buffer, insertion order = oldest first. */
  readonly store = new Map<string, Exchange>();
  readonly sizes = new Map<string, number>();
  storedBytes = 0;
  /** In-flight exchanges (survive ring eviction and clear()). */
  readonly live = new Map<string, Live>();
  /** Routing decision per request id, made once by the first matcher that asks. */
  readonly flows = new Map<string, Flow>();
  readonly maxFrames: number;
  /** Stored frame payload bytes per exchange (part of the body byte budget). */
  readonly frameBytes = new Map<string, number>();
  /** Coalesced 'exchange' emits for frames: last emit time and the pending timer, per exchange. */
  readonly emitState = new Map<string, { last: number; timer?: NodeJS.Timeout }>();
  /** Ids of read-only records added with record() (CONTRACTS §11.4). */
  readonly records = new Set<string>();

  constructor(
    private readonly px: ProxyContext,
    limits: { maxExchanges: number; maxStoredBodyBytes: number; maxFrames: number },
  ) {
    this.maxExchanges = limits.maxExchanges;
    this.maxStoredBodyBytes = limits.maxStoredBodyBytes;
    this.maxFrames = limits.maxFrames;
  }

  /** Oldest first. In-flight exchanges are always included. */
  getExchanges(): Exchange[] {
    return [...this.store.values()].map((ex) => {
      if (ex.frames && ex.frames.length > this.maxFrames) this.trimFrames(ex);
      return snapshot(ex);
    });
  }

  /**
   * Store a read-only exchange that did not go through the proxy (CONTRACTS §11.4): e.g. a native client's
   * request read from the app's HTTP profile. `captured` defaults to 'vm-profile'. It is stored and evicted
   * like any other exchange and emits 'exchange', but is never routed, never matched against rules, never
   * CORS-diagnosed. Bodies are capped like recorded ones (5 MB of text), frames at maxFramesPerExchange.
   * Returns its id. Throws on a missing method / URL.
   */
  record(input: Omit<Exchange, 'id'>): string {
    if (!input || typeof input !== 'object') throw new Error('Invalid exchange');
    if (typeof input.method !== 'string' || !input.method || typeof input.url !== 'string' || !input.url) {
      throw new Error('Invalid exchange: method and url are required');
    }
    const id = `rec-${randomUUID()}`;
    const ex = {
      startedAt: Date.now(),
      requestHeaders: {},
      state: 'completed',
      ...sanitizeRecord(input as Partial<Exchange>, this.maxFrames),
      id,
    } as Exchange;
    ex.captured ??= 'vm-profile';
    this.records.add(id);
    this.store.set(id, ex);
    if (ex.frames) this.frameBytes.set(id, ex.frames.reduce((n, f) => n + frameCost(f), 0));
    this.emitChange(ex);
    return id;
  }

  /**
   * Change a record() exchange (a pending native request that completed, more frames…): fields in `patch`
   * replace the stored ones, `undefined` removes one; `id` can't change. Emits 'exchange'. Returns false (and
   * does nothing) for an id that is not a record or was evicted / cleared.
   */
  update(id: string, patch: Partial<Omit<Exchange, 'id'>>): boolean {
    const ex = this.records.has(id) ? this.store.get(id) : undefined;
    if (!ex) {
      this.records.delete(id);
      return false;
    }
    if (!patch || typeof patch !== 'object') return false;
    const clean = sanitizeRecord(patch as Partial<Exchange>, this.maxFrames);
    for (const k of Object.keys(patch)) {
      if (k === 'id') continue;
      const v = (clean as Record<string, unknown>)[k];
      if (v === undefined) delete (ex as unknown as Record<string, unknown>)[k];
      else (ex as unknown as Record<string, unknown>)[k] = v;
    }
    ex.captured ??= 'vm-profile';
    if ('frames' in patch) this.frameBytes.set(id, (ex.frames ?? []).reduce((n, f) => n + frameCost(f), 0));
    this.emitChange(ex);
    return true;
  }

  /**
   * Drops finished exchanges (no 'removed' event — the host sends 'cleared'). In-flight ones
   * (pending / paused) are kept: the app is still waiting and a paused one must stay resumable,
   * so the host should send a fresh snapshot (getExchanges()) after clearing.
   */
  clear(): void {
    for (const id of [...this.store.keys()]) if (!this.live.has(id)) this.drop(id);
  }

  // ---------------------------------------------------------------- store

  emitChange(ex: Exchange): void {
    if (ex.grpc?.web) {
      // CONTRACTS §19.1: a gRPC-Web call shows messages as frames, never its raw (binary / base64) bodies.
      delete ex.requestBody;
      delete ex.responseBody;
    }
    if (ex.frames && ex.frames.length > this.maxFrames) this.trimFrames(ex);
    if (!ex.captured) {
      // CONTRACTS §11.3: browser requests (Origin) get a CORS diagnosis; `patched` is kept.
      const cors = diagnoseCors(ex);
      if (cors) ex.cors = cors;
      else delete ex.cors;
    }
    if (this.store.get(ex.id) === ex) {
      const size = bodySize(ex) + (this.frameBytes.get(ex.id) ?? 0);
      this.storedBytes += size - (this.sizes.get(ex.id) ?? 0);
      this.sizes.set(ex.id, size);
    }
    const st = this.emitState.get(ex.id);
    if (st) {
      clearTimeout(st.timer);
      st.timer = undefined;
      st.last = Date.now();
    }
    this.px.emit('exchange', snapshot(ex));
    this.evict();
  }

  /** Coalesced emit for frame updates: at most one 'exchange' per exchange per FRAME_EMIT_INTERVAL_MS. */
  touch(ex: Exchange): void {
    let st = this.emitState.get(ex.id);
    if (!st) {
      st = { last: 0 };
      this.emitState.set(ex.id, st);
    }
    if (st.timer) return;
    const wait = st.last + FRAME_EMIT_INTERVAL_MS - Date.now();
    if (wait <= 0) return this.emitChange(ex);
    const state = st;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.store.get(ex.id) === ex || this.live.get(ex.id)?.ex === ex) this.emitChange(ex);
    }, wait);
    state.timer.unref?.();
  }

  /**
   * Append a frame (WebSocket message / SSE event / gRPC message), keeping the newest maxFrames. `late`: a gRPC
   * message decompressed after its call ended (CONTRACTS §16.8) still joins the stored exchange, in time order.
   */
  addFrame(ex: Exchange, f: Frame, late = false): void {
    const live = this.live.get(ex.id)?.ex === ex;
    if (!live && !(late && this.store.get(ex.id) === ex)) return; // finished: late frames are ignored
    const frames = (ex.frames ??= []);
    let i = frames.length;
    while (late && i > 0 && frames[i - 1].at > f.at) i--;
    if (i === frames.length) frames.push(f);
    else frames.splice(i, 0, f);
    const bytes = (this.frameBytes.get(ex.id) ?? 0) + frameCost(f);
    this.frameBytes.set(ex.id, bytes);
    // PERF-1 #3: trim in batches (the array may hold up to 2 × maxFrames between emits), never one shift() per frame.
    if (frames.length > this.maxFrames * 2 || bytes > MAX_FRAME_BYTES_PER_EXCHANGE) this.trimFrames(ex);
    this.touch(ex); // coalesced, also for late frames of a finished exchange
  }

  /** Newest maxFrames, and at most MAX_FRAME_BYTES_PER_EXCHANGE of them (REVIEW-5 #4); always the newest one. */
  trimFrames(ex: Exchange): void {
    const frames = ex.frames;
    if (!frames) return;
    let bytes = this.frameBytes.get(ex.id) ?? 0;
    let drop = Math.max(0, frames.length - this.maxFrames);
    for (let k = 0; k < drop; k++) bytes -= frameCost(frames[k]);
    while (bytes > MAX_FRAME_BYTES_PER_EXCHANGE && frames.length - drop > 1) bytes -= frameCost(frames[drop++]);
    if (!drop) return;
    frames.splice(0, drop);
    ex.framesDropped = (ex.framesDropped ?? 0) + drop;
    this.frameBytes.set(ex.id, bytes);
  }

  /**
   * Over the store's byte budget: drop the oldest frames of open streams first (down to LIVE_FRAME_FLOOR each),
   * so heavy live WebSockets / SSE streams can't push every finished exchange out (REVIEW-5 #4).
   */
  trimLiveFrames(): void {
    for (const { ex } of this.live.values()) {
      if (this.storedBytes <= this.maxStoredBodyBytes) return;
      const frames = ex.frames;
      if (!frames || frames.length <= LIVE_FRAME_FLOOR) continue;
      let freed = 0;
      let dropped = 0;
      while (frames.length > LIVE_FRAME_FLOOR && this.storedBytes - freed > this.maxStoredBodyBytes) {
        freed += frameCost(frames.shift()!);
        dropped++;
      }
      if (!dropped) continue;
      ex.framesDropped = (ex.framesDropped ?? 0) + dropped;
      this.frameBytes.set(ex.id, (this.frameBytes.get(ex.id) ?? 0) - freed);
      if (this.sizes.has(ex.id)) {
        this.sizes.set(ex.id, this.sizes.get(ex.id)! - freed);
        this.storedBytes -= freed;
      }
      // Not synchronously: evict() runs inside emitChange.
      queueMicrotask(() => {
        if (this.live.get(ex.id)?.ex === ex) this.touch(ex);
      });
    }
  }

  drop(id: string): void {
    this.storedBytes -= this.sizes.get(id) ?? 0;
    this.sizes.delete(id);
    this.store.delete(id);
    this.frameBytes.delete(id);
    this.records.delete(id);
    const st = this.emitState.get(id);
    if (st) {
      clearTimeout(st.timer);
      this.emitState.delete(id);
    }
  }

  /** Evict oldest finished exchanges beyond maxExchanges / maxStoredBodyBytes; never in-flight ones. */
  evict(): void {
    if (this.store.size <= this.maxExchanges && this.storedBytes <= this.maxStoredBodyBytes) return;
    if (this.storedBytes > this.maxStoredBodyBytes) this.trimLiveFrames();
    if (this.store.size <= this.maxExchanges && this.storedBytes <= this.maxStoredBodyBytes) return;
    const removed: string[] = [];
    // PERF-1 #2: iterate the Map itself (oldest first; deleting the current entry is safe), no key copy per exchange.
    for (const id of this.store.keys()) {
      if (this.store.size <= this.maxExchanges && this.storedBytes <= this.maxStoredBodyBytes) break;
      if (this.live.has(id)) continue;
      this.drop(id);
      removed.push(id);
    }
    if (removed.length) this.px.emit('removed', removed);
  }

  track(ex: Exchange, flow: Flow): void {
    this.live.set(ex.id, { ex, flow });
    this.store.set(ex.id, ex);
    if (this.px.grpcWeb.grpcWebCalls.has(ex.id)) queueMicrotask(() => this.px.grpcWeb.syncGrpcWeb(ex.id));
    if (flow.traceId && !ex.source) {
      const info = this.px.traceJoin.exchange(flow.traceId, ex.id, this.px.appPackages);
      if (info) ex.source = info;
    }
    this.emitChange(ex);
    if (flow.send && !flow.send.done) flow.send.recorded(ex.id);
  }

  /** A new exchange for a request, with what the flow knows (rule, simulation, initiator). */
  newExchange(req: { id: string; method: string; url: string; headers: HeaderBag; timingEvents?: { startTime?: number } }, flow: Flow): Exchange {
    // Map Remote: the exchange keeps the URL the app asked for (CONTRACTS §12.6); `simulated` names the target.
    const url = flow.originalUrl ?? req.url;
    return {
      id: req.id,
      startedAt: req.timingEvents?.startTime ?? Date.now(),
      method: req.method,
      url,
      requestHeaders: cleanHeaders(req.headers),
      state: 'pending',
      ...(flow.rule ? { matchedRuleId: flow.rule.id } : {}),
      ...(flow.note ? { notes: [clipNote(flow.note)] } : {}),
      ...(flow.simulated ? { simulated: flow.simulated } : {}),
      ...(flow.send ? { initiator: flow.send.initiator } : {}),
      ...(flow.send?.resentFrom !== undefined ? { resentFrom: flow.send.resentFrom } : {}),
      ...(flow.viaLan ? { viaLan: true as const } : {}),
      ...(flow.grpcWeb ? grpcWebExchangeFields(url, req.headers, flow.grpcWeb) : graphqlOf(req.method, url, req.headers)),
      ...(this.px.webSession && !flow.send && !flow.viaLan && !flow.traceId && isBrowserInternal(url, req.headers)
        ? { browserInternal: true as const }
        : {}),
    };
  }

  /** Set the request body (and, once it is known, `graphql`: CONTRACTS §11.2). */
  setRequestBody(ex: Exchange, body: Body | undefined): void {
    ex.requestBody = body;
    const g = graphqlOf(ex.method, ex.url, ex.requestHeaders, body);
    if (g.graphql) ex.graphql = g.graphql;
    else delete ex.graphql;
  }

  // ---------------------------------------------------------------- timings (CONTRACTS §13.2)

  /**
   * Upstream phases from the pooled agents (src/timing.ts). A live exchange carries them with its next 'exchange'
   * event (no event per phase); one that already finished gets an event of its own.
   */
  addTimings(id: string, patch: TimingPatch): void {
    const live = this.live.get(id);
    const ex = live?.ex ?? this.store.get(id);
    if (!ex || ex.captured || !Object.keys(patch).length) return;
    ex.timings = { ...ex.timings, ...patch };
    if (!live) this.emitChange(ex);
  }

  /**
   * CONTRACTS §19.4: an informational note (never a failure: those go to `error`). Oldest first, de-duplicated,
   * at most MAX_NOTES notes of MAX_NOTE_CHARS each. The caller emits.
   */
  addNote(ex: Exchange, text: string | undefined): void {
    if (!text) return;
    const t = clipNote(text);
    const notes = (ex.notes ??= []);
    if (notes.includes(t) || notes.length >= MAX_NOTES) return;
    notes.push(t);
  }

  /** Add to an accumulated phase (breakpoint holds, delays). Integer ms ≥ 0. */
  addPhase(ex: Exchange, key: 'pausedMs' | 'delayMs', ms: number): void {
    const add = Math.max(0, Math.round(ms));
    ex.timings = { ...ex.timings, [key]: (ex.timings?.[key] ?? 0) + add };
  }

  /** `requestMs` (start → the whole request received), once known; never overwritten. */
  setRequestMs(ex: Exchange, te: RequestTimingEvents | undefined, end?: number): void {
    if (ex.timings?.requestMs !== undefined || te?.startTimestamp === undefined) return;
    const at = end ?? te.bodyReceivedTimestamp;
    if (at === undefined) return;
    ex.timings = { ...ex.timings, requestMs: elapsed(te.startTimestamp, at) };
  }

  finish(ex: Exchange, state: Exchange['state']): void {
    const live = this.live.get(ex.id);
    if (live?.ex === ex) this.setRequestMs(ex, live.flow.te);
    if (ex.kind === 'grpc') {
      // REVIEW-11 #5: a pause ends with its call (its timer cleared, its held bytes freed by the pauser).
      delete ex.grpcPause;
      const p = this.px.paused.get(ex.id);
      if (p && live?.ex === ex) {
        this.live.delete(ex.id); // the pauser sees the call as gone
        p.settle({ kind: 'gone' });
      }
    }
    ex.state = state;
    ex.durationMs = Date.now() - ex.startedAt;
    delete ex.pausedAt;
    delete ex.pauseDeadline;
    this.live.delete(ex.id);
    this.flows.delete(ex.id);
    this.emitChange(ex);
    this.emitState.delete(ex.id); // emitChange cleared its timer
  }

  fail(ex: Exchange, error: string): void {
    ex.error = error;
    this.finish(ex, 'error');
  }
}
