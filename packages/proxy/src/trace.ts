// Request → source traces (CONTRACTS §9.1/§9.2). The generated entry tags each request with an opaque
// `x-fi-id` header and posts the call-site stack out of band to a host that never resolves; the proxy
// answers that host itself and joins the two. Both arrival orders work; both sides wait bounded.
import type { SourceInfo } from './types';
import { toSourceInfo } from './source';

/** Answered locally by the proxy (any scheme/port): 204, never forwarded, never recorded. */
export const TRACE_HOST = 'trace.flutter-intercept.invalid';
export const TRACE_PATH = '/v1/traces';
/** Request header carrying the trace id; stripped before anything goes upstream and from recordings. */
export const TRACE_HEADER = 'x-fi-id';
export const TRACE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Bounds (CONTRACTS §9.2): at most this many waiting entries per side, for at most this long. */
export const TRACE_PENDING_MAX = 2000;
export const TRACE_PENDING_MS = 60_000;
/** Trace POST body limit; larger (or content-encoded) bodies are ignored. */
export const TRACE_BODY_MAX = 1024 * 1024;
const MAX_STACK_CHARS = 16 * 1024;
/** The entry batches ≤ 50 per POST (CONTRACTS §9.1); more are ignored (REVIEW-3 #2). */
export const MAX_TRACES_PER_POST = 50;
/** Raw stacks waiting for their exchange: total characters kept (oldest evicted first). */
export const TRACE_PENDING_CHARS = 8 * 1024 * 1024;

export function isTraceHost(hostname: string): boolean {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') === TRACE_HOST;
}

export function isTraceUrl(url: string): boolean {
  try {
    return isTraceHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Parse a trace POST body: `{"traces":[{"id","stack"}]}`. Invalid input → []. Never throws. */
export function parseTraceBody(body: Buffer): Array<{ id: string; stack: string }> {
  if (body.length === 0 || body.length > TRACE_BODY_MAX) return [];
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return [];
  }
  const list = (json as { traces?: unknown })?.traces;
  if (!Array.isArray(list)) return [];
  const out: Array<{ id: string; stack: string }> = [];
  for (const t of list.slice(0, MAX_TRACES_PER_POST)) {
    const id = (t as { id?: unknown })?.id;
    const stack = (t as { stack?: unknown })?.stack;
    if (typeof id === 'string' && TRACE_ID_RE.test(id) && typeof stack === 'string') {
      out.push({ id, stack: stack.length > MAX_STACK_CHARS ? stack.slice(0, MAX_STACK_CHARS) : stack });
    }
  }
  return out;
}

/** Insertion-ordered map with a size cap, an optional weight budget and a TTL; oldest entries go first. */
class Pending<V> {
  private readonly map = new Map<string, { v: V; at: number; w: number }>();
  private weight = 0;
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly maxWeight = Infinity,
    private readonly weigh: (v: V) => number = () => 0,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string, now = Date.now()): V | undefined {
    this.prune(now);
    return this.map.get(key)?.v;
  }

  set(key: string, v: V, now = Date.now()): void {
    this.delete(key); // re-insert at the end (fresh)
    const w = this.weigh(v);
    this.map.set(key, { v, at: now, w });
    this.weight += w;
    this.prune(now);
  }

  take(key: string, now = Date.now()): V | undefined {
    const v = this.get(key, now);
    this.delete(key);
    return v;
  }

  clear(): void {
    this.map.clear();
    this.weight = 0;
  }

  private delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.weight -= e.w;
    this.map.delete(key);
  }

  private prune(now: number): void {
    for (const [k, e] of this.map) {
      if (this.map.size > this.max || this.weight > this.maxWeight || now - e.at > this.ttlMs) this.delete(k);
      else break;
    }
  }
}

/**
 * Joins traces and exchanges. Traces are kept RAW (bounded by count, total size and TTL) and parsed only
 * when they meet an exchange, so posting traces nobody asks for costs no parsing (REVIEW-3 #2). A trace is
 * kept for its full TTL after it met an exchange, because a redirect followed by dart:io re-sends the same
 * headers (same `x-fi-id`) on a new exchange.
 */
export class TraceJoin {
  private readonly traces: Pending<string>;
  private readonly waiting: Pending<string[]>;

  constructor(max = TRACE_PENDING_MAX, ttlMs = TRACE_PENDING_MS, maxChars = TRACE_PENDING_CHARS) {
    this.traces = new Pending(max, ttlMs, maxChars, (stack) => stack.length);
    this.waiting = new Pending(max, ttlMs);
  }

  /** Sizes, for tests. */
  get pending(): { traces: number; exchanges: number } {
    return { traces: this.traces.size, exchanges: this.waiting.size };
  }

  /** An exchange carrying `traceId` was recorded: its source if the trace is already in, else it waits. */
  exchange(traceId: string, exchangeId: string, appPackages: readonly string[] = [], now = Date.now()): SourceInfo | undefined {
    const stack = this.traces.get(traceId, now);
    if (stack !== undefined) return toSourceInfo(stack, appPackages);
    const ids = this.waiting.get(traceId, now) ?? [];
    if (ids.length < 16) this.waiting.set(traceId, [...ids, exchangeId], now);
    return undefined;
  }

  /**
   * A trace arrived. If exchanges were waiting for it: their ids and the parsed source; else it is stored
   * raw (`info` undefined, nothing parsed).
   */
  trace(
    traceId: string,
    stack: string,
    appPackages: readonly string[],
    now = Date.now(),
  ): { info?: SourceInfo; exchangeIds: string[] } {
    this.traces.set(traceId, stack, now);
    const exchangeIds = this.waiting.take(traceId, now) ?? [];
    return exchangeIds.length ? { info: toSourceInfo(stack, appPackages), exchangeIds } : { exchangeIds };
  }

  clear(): void {
    this.traces.clear();
    this.waiting.clear();
  }
}
