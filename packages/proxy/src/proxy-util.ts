// Constants and pure helpers shared by the proxy and its flow modules.

import { requestInternals } from './mockttp-internals';
import { generateCACertificate } from 'mockttp/dist/util/certificates';
import type { CompletedBody, OngoingRequest } from 'mockttp';
import { BODY_CAP_BYTES, cleanHeaders, getHeader, type HeaderBag } from './body';
import { isGrpcContentType } from './grpc';
import { MAX_NOTE_CHARS, MAX_NOTES } from './grpc-meta';
import { detectGraphql } from './graphql';
import { type CorsOptions } from './cors';
import { frameCost, materializeFrame, MAX_FRAME_BYTES_PER_EXCHANGE } from './frames';
import { describeProfile, NO_PROFILE, type NetworkProfile } from './network';
import { TRACE_HEADER } from './trace';
import { mentionsOnResponse, SCRIPT_LOG_MAX_CHARS, SCRIPT_LOG_MAX_LINES } from './script';
import type { Body, Exchange, RequestEdit, ResponseEdit, Rule, RuleAction } from './types';
import type { FlowFault, Flow, ThrottleProfile } from './flow-types';

export const DEFAULT_MAX_EXCHANGES = 1000;

export const DEFAULT_BREAKPOINT_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_MAX_STORED_BODY_BYTES = 256 * 1024 * 1024;

export const BLOCK_BODY = 'Blocked by Flutter Intercept';

export const MB = 1024 * 1024;

/** Marks requests made by send(): `x-fi-send: <nonce>`, stripped like `x-fi-id`. */
export const SEND_HEADER = 'x-fi-send';

/** Hop-by-hop / framing / internal headers a send() caller can't set (the proxy derives them). */
export const SEND_DROPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'content-length',
  'te',
  'trailer',
  'upgrade',
  TRACE_HEADER,
  SEND_HEADER,
]);

export const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Node's setTimeout limit; longer rule expiries are re-armed. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export const TRACE_FLOW: Flow = { route: 'trace' };

export const DENIED_FLOW: Flow = { route: 'denied' };

export const FAULT_LABELS: Record<FlowFault, string> = {
  reset: 'Fault: connection reset',
  timeout: 'Fault: timeout',
  truncate: 'Fault: truncated response',
  dns: 'Fault: DNS failure',
  drop: 'Dropped',
};

export function throttleLabel(t: { latencyMs?: number; kbps?: number; dropRate?: number; uploadKbps?: number }): string {
  const label = withUpload(describeProfile({ kind: 'throttle', latencyMs: t.latencyMs, kbps: t.kbps, dropRate: t.dropRate }), t.uploadKbps);
  return label === describeProfile(NO_PROFILE) ? 'Throttle' : label;
}

/** describeProfile, plus the upload rate for custom profiles ("+300 ms, 800 kbps, 200 kbps up"). */
export function profileLabel(p: ThrottleProfile): string {
  return p.preset ? describeProfile(p) : withUpload(describeProfile(p), p.uploadKbps);
}

export function withUpload(label: string, uploadKbps: number | undefined): string {
  if (!uploadKbps || uploadKbps <= 0) return label;
  const up = `${uploadKbps} kbps up`;
  return label === describeProfile(NO_PROFILE) ? up : `${label}, ${up}`;
}

/** Request bodies a request breakpoint may hold (and that can be edited). Same as the display cap. */
export const REQUEST_PAUSE_LIMIT_BYTES = BODY_CAP_BYTES;

export let defaultCaPromise: Promise<{ key: string; cert: string }> | undefined;

export function defaultCa(): Promise<{ key: string; cert: string }> {
  defaultCaPromise ??= generateCACertificate({
    subject: { commonName: 'Flutter Intercept CA (in-memory, do not trust)', organizationName: 'Flutter Intercept' },
  }).then((c) => ({ key: c.key, cert: c.cert }));
  return defaultCaPromise;
}

/** Full decode, for edits that must re-encode the original body (bounded by the pause limits). */
export async function decodeFull(body: CompletedBody): Promise<Buffer> {
  try {
    return (await body.getDecodedBuffer()) ?? body.buffer;
  } catch {
    return body.buffer;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const bodySize = (e: Exchange) => (e.requestBody?.text.length ?? 0) + (e.responseBody?.text.length ?? 0);

/** 'exchange' events for frames: at most one per exchange per this many ms (CONTRACTS §11.1). */
export const FRAME_EMIT_INTERVAL_MS = 100;

export const isEventStream = (contentType: string | undefined) =>
  (contentType ?? '').split(';')[0].trim().toLowerCase() === 'text/event-stream';

/** WebSocket upgrades are recorded (and matched) as ws:// / wss:// URLs. */
export const toWsUrl = (url: string) => url.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s.toLowerCase()}://`);

export const capitalize = (s: string) => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;

export function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data ?? ''), 'utf8');
}

export const isTooBig = (e: { code?: string } | undefined) => e?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

/** A `grpc-message` / error text with the "Flutter Intercept:" prefix exactly once (REVIEW-10 #6). */
export function fiText(text: string): string {
  return /^Flutter Intercept\b/.test(text) ? text : `Flutter Intercept: ${text}`;
}

/** An HTTP/2 request with a gRPC content type (CONTRACTS §16.2; not gRPC-Web). */
export function isGrpcCall(req: OngoingRequest): boolean {
  return requestInternals(req).httpVersion === '2.0' && isGrpcContentType((req.headers as HeaderBag)['content-type']);
}

/** A note of at most MAX_NOTE_CHARS characters (CONTRACTS §19.4). */
export function clipNote(text: string): string {
  const t = String(text).trim();
  return t.length > MAX_NOTE_CHARS ? `${t.slice(0, MAX_NOTE_CHARS - 1)}…` : t;
}

/** A copy for listeners / getExchanges (frames is the only array the proxy keeps appending to). */
export function snapshot(ex: Exchange): Exchange {
  const copy = { ...ex };
  if (ex.frames) copy.frames = ex.frames.map(materializeFrame); // PERF-1 #3: base64 only for frames that are shown
  if (ex.timings) copy.timings = { ...ex.timings };
  if (ex.scriptLog) copy.scriptLog = ex.scriptLog.slice();
  if (ex.notes) copy.notes = ex.notes.slice();
  return copy;
}

/** `{graphql}` for a request whose body (if any) is known; strict detection (CONTRACTS §11.2). */
export function graphqlOf(method: string, url: string, headers: HeaderBag, body?: Body): { graphql?: Exchange['graphql'] } {
  const m = method.toUpperCase();
  let text: string | undefined;
  if (m !== 'GET' && m !== 'HEAD') {
    if (!body || body.encoding !== 'utf8' || body.truncated) return {};
    text = body.text;
  }
  const d = detectGraphql({ method, url, contentType: getHeader(headers, 'content-type') ?? '', body: text });
  return d ? { graphql: d.info } : {};
}

export function hasRequestBody(headers: HeaderBag): boolean {
  return !!getHeader(headers, 'transfer-encoding') || Number(getHeader(headers, 'content-length') ?? 0) > 0;
}

/** Why a request body can't be held for a hooked route (streamed, or over the pause limit). */
export function bodyLimitReason(headers: HeaderBag): string | undefined {
  if (getHeader(headers, 'transfer-encoding')) return 'the request body is streamed (unknown length)';
  const cl = Number(getHeader(headers, 'content-length') ?? 0);
  if (cl > REQUEST_PAUSE_LIMIT_BYTES) {
    return `the request body (${(cl / MB).toFixed(1)} MB) is over the ${REQUEST_PAUSE_LIMIT_BYTES / MB} MB pause limit`;
  }
  return undefined;
}

export function corsOptions(a: { allowOrigin?: string; allowCredentials?: boolean }): CorsOptions {
  const o: CorsOptions = {};
  if (typeof a.allowOrigin === 'string' && a.allowOrigin.trim()) o.allowOrigin = a.allowOrigin.trim();
  if (typeof a.allowCredentials === 'boolean') o.allowCredentials = a.allowCredentials;
  return o;
}

export function capBody(b: unknown): Body | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const { text, encoding, truncated } = b as Body;
  if (typeof text !== 'string') return undefined;
  const enc = encoding === 'base64' ? 'base64' : 'utf8';
  const cap = enc === 'base64' ? Math.ceil((BODY_CAP_BYTES * 4) / 3) : BODY_CAP_BYTES;
  if (text.length > cap) return { text: text.slice(0, cap), encoding: enc, truncated: true };
  return truncated ? { text, encoding: enc, truncated: true } : { text, encoding: enc };
}

/** Copy of a record() / update() input: headers copied, bodies capped, frames capped (newest kept). */
export function sanitizeRecord(input: Partial<Exchange>, maxFrames: number): Partial<Exchange> {
  const out: Record<string, unknown> = { ...input };
  delete out.id;
  if ('requestHeaders' in input) out.requestHeaders = cleanHeaders((input.requestHeaders ?? {}) as HeaderBag);
  if ('responseHeaders' in input) out.responseHeaders = input.responseHeaders ? cleanHeaders(input.responseHeaders as HeaderBag) : undefined;
  if ('requestBody' in input) out.requestBody = capBody(input.requestBody);
  if ('responseBody' in input) out.responseBody = capBody(input.responseBody);
  if ('timings' in input) out.timings = cleanTimings(input.timings);
  if ('notes' in input) {
    const n = Array.isArray(input.notes) ? [...new Set(input.notes.filter((x) => typeof x === 'string' && x).map((x) => clipNote(x)))].slice(0, MAX_NOTES) : [];
    out.notes = n.length ? n : undefined;
  }
  if ('scriptLog' in input) {
    out.scriptLog = Array.isArray(input.scriptLog)
      ? input.scriptLog.slice(0, SCRIPT_LOG_MAX_LINES).map((l) => String(l).slice(0, SCRIPT_LOG_MAX_CHARS))
      : undefined;
  }
  if ('frames' in input) {
    const frames = Array.isArray(input.frames) ? input.frames.map((f) => ({ ...f })) : undefined;
    if (frames) {
      let bytes = frames.reduce((n, f) => n + frameCost(f), 0);
      let drop = 0;
      while (frames.length - drop > maxFrames || (bytes > MAX_FRAME_BYTES_PER_EXCHANGE && frames.length - drop > 1)) {
        bytes -= frameCost(frames[drop++]);
      }
      if (drop) {
        out.framesDropped = (input.framesDropped ?? 0) + drop;
        frames.splice(0, drop);
      }
    }
    out.frames = frames;
  }
  return out as Partial<Exchange>;
}

export const TIMING_FIELDS = ['requestMs', 'pausedMs', 'delayMs', 'dnsMs', 'connectMs', 'tlsMs', 'sendMs', 'waitMs', 'receiveMs'] as const;

/** A record()'s timings (e.g. from the VM HTTP profile): known phases only, integer ms ≥ 0; undefined when none. */
export function cleanTimings(t: unknown): Exchange['timings'] {
  if (!t || typeof t !== 'object') return undefined;
  const src = t as Record<string, unknown>;
  const out: NonNullable<Exchange['timings']> = {};
  for (const k of TIMING_FIELDS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.round(v);
  }
  if (src.reused === true) out.reused = true;
  return Object.keys(out).length ? out : undefined;
}

export function copyHeaders(h: Record<string, string | string[]>): HeaderBag {
  const out: HeaderBag = {};
  for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v.slice() : v;
  return out;
}

export function isEmptyEdit(edit: RequestEdit | ResponseEdit): boolean {
  return Object.values(edit).every((v) => v === undefined);
}

export function validateEdit(phase: 'request' | 'response', edit: RequestEdit | ResponseEdit, ex: Exchange | undefined): void {
  if (phase === 'request') {
    const e = edit as RequestEdit;
    if (e.url !== undefined) {
      let u: URL;
      try {
        u = new URL(e.url);
      } catch {
        throw new Error(`Invalid URL: ${e.url}`);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Unsupported URL scheme: ${u.protocol}`);
    }
    if (e.method !== undefined && !/^[A-Za-z]+$/.test(e.method)) throw new Error(`Invalid method: ${e.method}`);
    if (e.body !== undefined && ex?.requestBody?.truncated) {
      throw new Error('The request body is larger than 5 MB and was only shown in part; it cannot be edited (method, URL and headers can).');
    }
  } else {
    const e = edit as ResponseEdit;
    if (e.status !== undefined && (!Number.isInteger(e.status) || e.status < 100 || e.status > 999)) {
      throw new Error(`Invalid status: ${e.status}`);
    }
    if (e.body !== undefined && ex?.responseBody?.truncated) {
      throw new Error('The response body is larger than 5 MB and was only shown in part; it cannot be edited (status and headers can).');
    }
  }
}

/** Validate and copy a NetworkProfile; throws on nonsense (negative latency, dropRate outside 0–1, …). */
export function validateProfile(p: NetworkProfile): NetworkProfile {
  if (!p || typeof p !== 'object') throw new Error('Invalid network profile');
  if (p.kind === 'none' || p.kind === 'offline') return { kind: p.kind };
  if (p.kind !== 'throttle') throw new Error(`Invalid network profile kind: ${(p as { kind?: unknown }).kind}`);
  const num = (v: unknown, name: string, max: number): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new Error(`Invalid network profile ${name}: ${v}`);
    return v;
  };
  const latencyMs = num(p.latencyMs, 'latencyMs', 10 * 60 * 1000);
  const kbps = num(p.kbps, 'kbps', 10_000_000);
  const dropRate = num(p.dropRate, 'dropRate', 1);
  const uploadKbps = num(p.uploadKbps, 'uploadKbps', 10_000_000);
  return {
    kind: 'throttle',
    ...(p.preset ? { preset: p.preset } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(kbps ? { kbps } : {}),
    ...(dropRate !== undefined ? { dropRate } : {}),
    ...(uploadKbps ? { uploadKbps } : {}),
  };
}

// ---------------------------------------------------------------- v0.6.0 helpers (CONTRACTS §12)

/** Identity of a sequence rule's content: its position resets when this changes. */
export function sequenceSig(rule: Rule): string {
  try {
    return JSON.stringify([rule.match, rule.action]);
  } catch {
    return String(Math.random());
  }
}

/** Could this action need the buffered response hook (h2)? */
export function needsResponseHook(a: RuleAction | undefined): boolean {
  if (!a) return false;
  if (a.kind === 'mutate' || (a.kind === 'breakpoint' && a.phase !== 'request')) return true;
  if (a.kind === 'rewrite') return !!a.response?.replaceBody?.length;
  if (a.kind === 'script') return mentionsOnResponse(a.code);
  if (a.kind === 'sequence') return (a.steps ?? []).some((s) => s?.action?.kind !== 'passthrough' && needsResponseHook(s?.action as RuleAction));
  return false;
}

/** Headers a replayed response doesn't carry over: the proxy frames the body itself. */
export const REPLAY_DROPPED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'trailer', 'upgrade']);

/** CONTRACTS §18.6: the hop marker header, and what a call that would loop gets. */
export const HOP_HEADER = 'flutter-intercept-hop';

export const GRPC_LOOP_TEXT = 'Flutter Intercept: the call would loop back to the proxy';

/** CONTRACTS §18.6: on send()'s own silent CONNECT: `<hop nonce>[; tls][; lan]` (only accepted from loopback). */
export const INTERNAL_TUNNEL_HEADER = 'flutter-intercept-internal';

/** Headers a gRPC send() doesn't take from the caller (the proxy sets them, or they'd break the call). */
export const GRPC_SEND_DROPPED = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'content-length',
  'te',
  'trailer',
  'upgrade',
  'content-type',
  'grpc-encoding',
  'http2-settings',
  'x-fi-id',
  'x-fi-send',
  'flutter-intercept-tunnel',
  'flutter-intercept-connect-timeout',
]);

/** `/pkg.Service/Method` of an exchange URL. */
export function grpcPathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

/** CONTRACTS §17.4: recorded gRPC headers / trailers a replay doesn't send (the proxy sets them, or they'd be wrong). */
export const REPLAY_GRPC_DROPPED = new Set([
  ...REPLAY_DROPPED_HEADERS,
  'content-type',
  'grpc-status',
  'grpc-message',
  'grpc-encoding',
  'host',
  'http2-settings',
  'proxy-authorization',
  'te',
  'date',
]);

