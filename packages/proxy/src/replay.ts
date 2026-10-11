// Record → replay (CONTRACTS §12.4): answer requests from a recording.
import { createHash } from 'crypto';
import { pathTemplate } from './template';
import type { Body, ReplayEntry, ReplayOptions } from './types';

/**
 * The request body as far as matching is concerned:
 * - `{hash}`: known (`hash` undefined = no / empty body);
 * - 'unknown': the request has a body that hasn't been read yet;
 * - 'unreadable': it can't be read (streamed or over the pause limit) — only entries without a hash match.
 */
export type BodyKey = { hash?: string } | 'unknown' | 'unreadable';

export type ReplayLookup =
  | { entry: ReplayEntry; tier: 'exact' | 'template'; index: number; of: number }
  | 'needs-body'
  | undefined;

/** hex sha256 of the decoded request body bytes, undefined for none / empty (same as the host's recorder). */
export function requestBodyHash(body: Body | undefined): string | undefined {
  if (!body || !body.text || body.truncated) return undefined;
  const bytes = body.encoding === 'base64' ? Buffer.from(body.text, 'base64') : Buffer.from(body.text, 'utf8');
  if (bytes.length === 0) return undefined;
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeUrl(url: string): URL | undefined {
  try {
    const u = new URL(url);
    // ws: / wss: = recorded WebSocket connections (CONTRACTS §14.5), looked up by the upgrade's ws(s):// URL.
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return undefined;
    u.hash = '';
    return u;
  } catch {
    return undefined;
  }
}

const exactKey = (method: string, u: URL) => `${method.toUpperCase()} ${u.href}`;
const templateKey = (method: string, u: URL) => `${method.toUpperCase()} ${u.protocol}//${u.host}${pathTemplate(u.pathname)}`;

function validEntry(e: unknown): e is ReplayEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as ReplayEntry;
  if (typeof x.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(x.method)) return false;
  if (typeof x.url !== 'string' || !normalizeUrl(x.url)) return false;
  const ws = /^wss?:/i.test(x.url);
  if (x.kind !== undefined && x.kind !== 'websocket' && x.kind !== 'sse' && x.kind !== 'grpc') return false;
  if (x.kind === 'grpc' && !validGrpcEntry(x)) return false;
  if ((x.kind === 'websocket') !== ws) return false; // ws(s):// URLs are WebSocket recordings and nothing else
  if (x.frames !== undefined && !Array.isArray(x.frames)) return false;
  if (x.kind === 'websocket' ? x.status !== 101 && x.status !== undefined : !Number.isInteger(x.status) || x.status < 200 || x.status > 599) return false;
  if (x.headers !== undefined && (typeof x.headers !== 'object' || x.headers === null)) return false;
  if (x.body !== undefined && (typeof x.body !== 'object' || x.body === null || typeof x.body.text !== 'string')) return false;
  if (x.requestBodyHash !== undefined && typeof x.requestBodyHash !== 'string') return false;
  return true;
}

/**
 * CONTRACTS §17.4: a replayable gRPC entry: messages as frames, a status 0–16; never one saved `incomplete` (a
 * response message truncated or of unknown size: replaying it would send the app a different message).
 */
function validGrpcEntry(x: ReplayEntry): boolean {
  if ((x as { incomplete?: unknown }).incomplete === true) return false;
  if (!Array.isArray(x.frames)) return false;
  const g = x.grpc;
  if (!g || typeof g !== 'object' || !Number.isInteger(g.code) || g.code < 0 || g.code > 16) return false;
  if (g.message !== undefined && typeof g.message !== 'string') return false;
  if (g.requestHash !== undefined && typeof g.requestHash !== 'string') return false;
  if (g.trailers !== undefined && (typeof g.trailers !== 'object' || g.trailers === null)) return false;
  for (const f of x.frames) {
    if (!f || typeof f !== 'object' || f.kind !== 'message') return false;
    if (f.dir === 'receive' && !f.dropped && (f.truncated || f.sizeUnknown)) return false;
    if (f.base64 !== undefined && typeof f.base64 !== 'string') return false;
  }
  return true;
}

/** sha256 (hex) of a gRPC message as recorded (its frame bytes: decompressed, ≤ 64 KB) — CONTRACTS §17.4 requestHash. */
export function grpcMessageHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type GrpcReplayLookup = { entry: ReplayEntry; index: number; of: number } | 'needs-body' | undefined;

/**
 * Entries grouped by exact method + URL and by method + origin + path template. Matching: the exact group first,
 * then (with `matchTemplates`) the template group (query ignored). Within a group, an entry with a
 * `requestBodyHash` only matches a request whose decoded body has that hash; entries without one match any body.
 * Several responses for one key are served in recorded order, then the last repeats.
 */
export class ReplayStore {
  readonly fallback: ReplayOptions['fallback'];
  readonly matchTemplates: boolean;
  readonly name?: string;
  readonly size: number;
  readonly skipped: number;
  private readonly exact = new Map<string, ReplayEntry[]>();
  private readonly template = new Map<string, ReplayEntry[]>();
  /** CONTRACTS §17.4: gRPC entries by path (`/pkg.Service/Method`), in recorded order. */
  private readonly grpcByPath = new Map<string, ReplayEntry[]>();
  /** Served count per (tier, group key, body hash). */
  private readonly served = new Map<string, number>();

  constructor(entries: readonly unknown[], opts: ReplayOptions & { name?: string }) {
    this.fallback = opts.fallback;
    this.matchTemplates = !!opts.matchTemplates;
    if (typeof opts.name === 'string' && opts.name.trim()) this.name = opts.name.trim().slice(0, 200);
    let size = 0;
    let skipped = 0;
    for (const e of entries) {
      if (!validEntry(e)) {
        skipped++;
        continue;
      }
      const u = normalizeUrl(e.url)!;
      const copy: ReplayEntry = { ...e, method: e.method.toUpperCase(), headers: { ...(e.headers ?? {}) } };
      size++;
      if (copy.kind === 'grpc') {
        push(this.grpcByPath, u.pathname, copy);
        continue;
      }
      push(this.exact, exactKey(copy.method, u), copy);
      push(this.template, templateKey(copy.method, u), copy);
    }
    this.size = size;
    this.skipped = skipped;
  }

  /** Find (and, with `count`, consume) the response for a request. */
  lookup(method: string, url: string, body: BodyKey, count: boolean): ReplayLookup {
    const u = normalizeUrl(url);
    if (!u) return undefined;
    const tiers: Array<['exact' | 'template', Map<string, ReplayEntry[]>, string]> = [['exact', this.exact, exactKey(method, u)]];
    if (this.matchTemplates) tiers.push(['template', this.template, templateKey(method, u)]);
    for (const [tier, map, key] of tiers) {
      const group = map.get(key);
      if (!group) continue;
      if (body === 'unknown' && group.some((e) => e.requestBodyHash)) return 'needs-body';
      const hash = typeof body === 'object' ? body.hash : undefined;
      const candidates = group.filter((e) => !e.requestBodyHash || (hash !== undefined && e.requestBodyHash === hash));
      if (!candidates.length) continue;
      const servedKey = `${tier}\n${key}\n${hash ?? ''}`;
      const n = this.served.get(servedKey) ?? 0;
      const index = Math.min(n, candidates.length - 1);
      if (count) this.served.set(servedKey, n + 1);
      return { entry: candidates[index], tier, index, of: candidates.length };
    }
    return undefined;
  }

  /** CONTRACTS §14.5: does an exact (or template) group for this request hold a recorded event stream? */
  hasStream(method: string, url: string): boolean {
    const u = normalizeUrl(url);
    if (!u) return false;
    const groups = [this.exact.get(exactKey(method, u)), this.matchTemplates ? this.template.get(templateKey(method, u)) : undefined];
    return groups.some((g) => g?.some((e) => e.kind === 'sse'));
  }

  /**
   * CONTRACTS §17.4: the recorded call for a gRPC request. Same origin and path (REVIEW-11 #7); when
   * several share it and some carry a `requestHash`, the first request message decides (`'needs-body'` until it is
   * known; `hash` undefined = none); else the next unused entry in recorded order; then the last one repeats.
   */
  lookupGrpc(url: string, first: { hash?: string } | 'unknown', count: boolean): GrpcReplayLookup {
    const u = normalizeUrl(url);
    if (!u) return undefined;
    const all = this.grpcByPath.get(u.pathname);
    if (!all?.length) return undefined;
    // REVIEW-11 #7: the request's own origin only (scheme + host + port), like HTTP replay keys: a call recorded from
    // one server never answers a call to another.
    const group = all.filter((e) => normalizeUrl(e.url)?.origin === u.origin);
    if (!group.length) return undefined;
    const hashed = group.length > 1 && group.some((e) => e.grpc?.requestHash);
    if (hashed && first === 'unknown') return 'needs-body';
    const hash = typeof first === 'object' ? first.hash : undefined;
    const byHash = hashed && hash !== undefined ? group.filter((e) => e.grpc?.requestHash === hash) : [];
    const candidates = byHash.length ? byHash : group;
    const servedKey = `grpc\n${u.origin}${u.pathname}\n${byHash.length ? hash : ''}`;
    const n = this.served.get(servedKey) ?? 0;
    const index = Math.min(n, candidates.length - 1);
    if (count) this.served.set(servedKey, n + 1);
    return { entry: candidates[index], index, of: candidates.length };
  }

  /** Start every key from its first response again. */
  rewind(): void {
    this.served.clear();
  }
}

function push(map: Map<string, ReplayEntry[]>, key: string, e: ReplayEntry): void {
  const list = map.get(key);
  if (list) list.push(e);
  else map.set(key, [e]);
}
