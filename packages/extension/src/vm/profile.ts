/**
 * Pure mapping from the dart:io HTTP profile (`ext.dart.io.getHttpProfile` / `getHttpProfileRequest`, service
 * extension v4) to read-only `Exchange`s (CONTRACTS §11.4). No vscode, no I/O. Shapes: dart-sdk
 * lib/io/network_profiling.dart + lib/_http/http_impl.dart (`_HttpProfileData.toJson`) and package:http_profile
 * (entries with ids `from_package/<n>`, written by cupertino_http / cronet_http / ok_http). docs/spikes/vm-service.md.
 */
import * as zlib from 'zlib';
import type { Body, Exchange } from '@flutter-intercept/proxy';

/** `@HttpProfileRequest` (ref) or `HttpProfileRequest` (with bodies). Timestamps are µs since epoch (device clock). */
export interface ProfileEntry {
  id: string;
  isolateId?: string;
  method: string;
  uri: string;
  startTime: number;
  /** Request finished (sent) — absent while the request is still being written. */
  endTime?: number;
  /** dart:io: present once the request ended. package:http_profile: always (maybe sparse). */
  request?: ProfileRequestData;
  response?: ProfileResponseData;
  requestBody?: number[];
  responseBody?: number[];
}

export interface ProfileRequestData {
  headers?: Record<string, string[] | string>;
  proxyDetails?: { host?: string; port?: number };
  connectionInfo?: Record<string, unknown>;
  contentLength?: number;
  error?: string;
}

export interface ProfileResponseData {
  statusCode?: number;
  reasonPhrase?: string;
  headers?: Record<string, string[] | string>;
  startTime?: number;
  endTime?: number;
  contentLength?: number;
  connectionInfo?: Record<string, unknown>;
  error?: string;
}

export interface HttpProfile {
  type?: string;
  timestamp: number;
  requests: ProfileEntry[];
}

export const TRACE_HEADER = 'x-fi-id';
/** Bodies kept per side (and the limit above which a known-length body is not fetched at all). */
export const MAX_PROFILE_BODY_BYTES = 1024 * 1024;

export function isPackageEntry(e: ProfileEntry): boolean {
  return typeof e?.id === 'string' && e.id.startsWith('from_package/');
}

/** Our proxy endpoint check for dart:io `proxyDetails` (any other proxy, e.g. Charles, is not ours). */
export type IsOurProxy = (host: string, port: number) => boolean;

/**
 * What to do with a profile entry:
 * - `skip`: never import (through our proxy, a CONNECT tunnel record, or dart:io in the main isolate);
 * - `wait`: undecided until the request has been sent (dart:io only reports headers then);
 * - `import`: traffic the proxy did not see.
 *
 * Main-isolate dart:io traffic is never imported: it runs under the generated entry's HttpOverrides (through
 * the proxy, or DIRECT only when the proxy is unreachable). Plain-http requests through the proxy carry no
 * `proxyDetails`, and with source capture off they carry no `x-fi-id` either, so they could not be told apart.
 * package:http_profile entries never go through our proxy (an `x-fi-id` there is not ours: REVIEW-5 #14);
 * background-isolate dart:io entries are skipped only when `proxyDetails` names OUR proxy.
 */
export function classifyEntry(e: ProfileEntry, isolate: { main: boolean }, isOurProxy?: IsOurProxy): 'import' | 'skip' | 'wait' {
  if (!e || typeof e.id !== 'string' || typeof e.method !== 'string' || typeof e.uri !== 'string') return 'skip';
  if (e.method.toUpperCase() === 'CONNECT') return 'skip';
  if (isPackageEntry(e)) return 'import';
  if (isolate.main) return 'skip';
  if (e.endTime === undefined && !e.request) return 'wait';
  const pd = e.request?.proxyDetails;
  if (pd && typeof pd === 'object' && typeof pd.host === 'string' && typeof pd.port === 'number' && isOurProxy?.(pd.host, pd.port)) return 'skip';
  return 'import';
}

/** Finished = the response body ended, or the request / response failed. */
export function isFinished(e: ProfileEntry): boolean {
  return Boolean(e.response?.endTime !== undefined || entryError(e));
}

export function entryError(e: ProfileEntry): string | undefined {
  const err = e.request?.error ?? e.response?.error;
  if (err === undefined || err === null || err === '') return undefined;
  return cleanText(typeof err === 'string' ? err : safeString(err), MAX_ERROR_CHARS) || undefined;
}

// --- validation / sanitising (REVIEW-5 #7, #13): everything in the profile is app-controlled ---

export const MAX_URL_CHARS = 8 * 1024;
export const MAX_HEADERS = 100;
export const MAX_HEADER_NAME = 256;
export const MAX_HEADER_VALUE = 8 * 1024;
export const MAX_HEADERS_TOTAL = 64 * 1024;
export const MAX_ERROR_CHARS = 1024;
/** C0 / C1 controls, zero-width and bidi formatting characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const METHOD = /^[A-Za-z]{1,16}$/;

function safeString(v: unknown): string {
  try {
    return typeof v === 'object' ? JSON.stringify(v) ?? '' : String(v);
  } catch {
    return '';
  }
}

/** Strips control / zero-width / bidi characters and caps the length. */
export function cleanText(s: string, max: number): string {
  return s.slice(0, max * 2).replace(UNSAFE_CHARS, '').slice(0, max);
}

/** http(s) URL ≤ 8 KB without control / bidi characters, else undefined. */
export function cleanUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || u.length > MAX_URL_CHARS * 2) return undefined;
  const s = u.replace(UNSAFE_CHARS, '');
  if (!s || s.length > MAX_URL_CHARS) return undefined;
  try {
    const parsed = new URL(s);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** A µs timestamp → epoch ms within the Date range, else undefined. */
function usToMs(us: unknown): number | undefined {
  if (typeof us !== 'number' || !Number.isFinite(us)) return undefined;
  const ms = Math.round(us / 1000);
  return Math.abs(ms) <= 8.64e15 ? ms : undefined;
}

/**
 * Header map → Exchange headers (≤ 100 headers, token names ≤ 256, values ≤ 8 KB without control characters,
 * ≤ 64 KB in total). package:http_profile splits every value on commas (`date: ["Sat", "10 Oct …"]`), so its
 * lists are joined back; dart:io lists are real separate values (kept as arrays when > 1).
 */
export function toHeaders(h: ProfileRequestData['headers'], fromPackage: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!h || typeof h !== 'object' || Array.isArray(h)) return out;
  let count = 0;
  let total = 0;
  for (const [k, v] of Object.entries(h)) {
    if (count >= MAX_HEADERS || total >= MAX_HEADERS_TOTAL) break;
    if (k.length > MAX_HEADER_NAME || !TOKEN.test(k)) continue;
    const raw = Array.isArray(v) ? v.slice(0, 50).map(safeString) : v === undefined || v === null ? [] : [safeString(v)];
    if (raw.length === 0) continue;
    const vals = raw.map((x) => cleanText(x, MAX_HEADER_VALUE));
    let value: string | string[] = fromPackage || vals.length === 1 ? vals.join(', ').slice(0, MAX_HEADER_VALUE) : vals;
    const size = k.length + (Array.isArray(value) ? value.reduce((n, x) => n + x.length, 0) : value.length);
    if (total + size > MAX_HEADERS_TOTAL) {
      if (Array.isArray(value)) value = value.join(', ');
      value = value.slice(0, Math.max(0, MAX_HEADERS_TOTAL - total - k.length));
    }
    out[k] = value;
    total += size;
    count++;
  }
  return out;
}

function headerValue(h: Record<string, string | string[]> | undefined, name: string): string | undefined {
  if (!h) return undefined;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(', ') : v;
  return undefined;
}

/**
 * The exchange fields known from a profile entry (no bodies: those come from `getHttpProfileRequest`), validated.
 * undefined = invalid entry (method, URL): drop it.
 */
export function toExchange(e: ProfileEntry, now: () => number = Date.now): Omit<Exchange, 'id'> | undefined {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string') return undefined;
  if (typeof e.method !== 'string' || !METHOD.test(e.method)) return undefined;
  const url = cleanUrl(e.uri);
  if (!url) return undefined;
  const pkg = isPackageEntry(e);
  const res = e.response && typeof e.response === 'object' ? e.response : undefined;
  const status = Number.isInteger(res?.statusCode) && res!.statusCode! >= 100 && res!.statusCode! <= 999 ? res!.statusCode : undefined;
  const error = entryError(e);
  const finished = isFinished(e);
  const start = usToMs(e.startTime);
  const end = usToMs(res?.endTime ?? (error ? (res?.startTime ?? e.endTime) : undefined));
  const ex: Omit<Exchange, 'id'> = {
    startedAt: start ?? now(),
    method: e.method.toUpperCase(),
    url,
    requestHeaders: toHeaders(e.request?.headers, pkg),
    state: error ? 'error' : finished ? 'completed' : 'pending',
    captured: 'vm-profile',
  };
  if (status !== undefined) ex.status = status;
  if (res?.headers && (status !== undefined || Object.keys(res.headers).length > 0)) ex.responseHeaders = toHeaders(res.headers, pkg);
  if (finished && start !== undefined && end !== undefined && end >= start) ex.durationMs = end - start;
  if (error) ex.error = error;
  return ex;
}

/** The client package that reported the entry ("cupertino_http"), from package:http_profile's connectionInfo. */
export function clientName(e: ProfileEntry): string | undefined {
  const pkg = e.request?.connectionInfo?.package ?? e.response?.connectionInfo?.package;
  if (typeof pkg !== 'string') return undefined;
  const m = /^package:([a-z][a-z0-9_]{0,39})$/.exec(pkg);
  return m ? m[1] : undefined;
}

const TEXT_TYPES = /^\s*(text\/[\w.+-]+|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)|[\w.-]+\/[\w.-]+\+(json|xml))\s*(;|$)/i;
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

function knownLength(contentLength: unknown, headers: Record<string, string | string[]>): number | undefined {
  if (typeof contentLength === 'number' && Number.isInteger(contentLength) && contentLength >= 0) return contentLength;
  const h = headerValue(headers, 'content-length');
  return h !== undefined && /^\s*\d{1,15}\s*$/.test(h) ? Number(h) : undefined;
}

export function requestLength(e: ProfileEntry): number | undefined {
  const h = toHeaders(e.request?.headers, isPackageEntry(e));
  const n = knownLength(e.request?.contentLength, h);
  if (n !== undefined) return n;
  // A GET without content-length / transfer-encoding has no body.
  return BODYLESS_METHODS.has(String(e.method).toUpperCase()) && headerValue(h, 'transfer-encoding') === undefined ? 0 : undefined;
}

export function responseLength(e: ProfileEntry): number | undefined {
  if (!e.response) return undefined;
  const n = knownLength(e.response.contentLength, toHeaders(e.response.headers, isPackageEntry(e)));
  if (n !== undefined) return n;
  const status = e.response.statusCode;
  return String(e.method).toUpperCase() === 'HEAD' || status === 204 || status === 304 ? 0 : undefined;
}

export interface BodyPlan {
  /** Call getHttpProfileRequest (both lengths known, ≤ 1 MB, textual response). */
  fetch: boolean;
  /** Placeholders for bodies that are not imported. */
  requestBody?: Body;
  responseBody?: Body;
}

const notImported = (len: number | undefined, type?: string): Body => ({
  text: `[body not imported: ${len === undefined ? 'unknown length' : `${len} bytes`}${type ? `, ${cleanText(type, 100)}` : ''}]`,
  encoding: 'utf8',
  truncated: true,
});

/**
 * REVIEW-5 #2: `getHttpProfileRequest` ships BOTH bodies as JSON number arrays (~4–8 bytes per body byte), so
 * the detail is fetched only when both lengths are known and ≤ 1 MB and the response is textual.
 */
export function bodyPlan(e: ProfileEntry, max = MAX_PROFILE_BODY_BYTES): BodyPlan {
  const pkg = isPackageEntry(e);
  const reqLen = requestLength(e);
  const resLen = responseLength(e);
  const resType = headerValue(toHeaders(e.response?.headers, pkg), 'content-type');
  const resTextual = resLen === 0 || (resType !== undefined && TEXT_TYPES.test(resType));
  if (reqLen !== undefined && reqLen <= max && resLen !== undefined && resLen <= max && resTextual) return { fetch: true };
  const plan: BodyPlan = { fetch: false };
  if (reqLen !== 0) plan.requestBody = notImported(reqLen);
  const hasResponse = e.response?.statusCode !== undefined;
  if (hasResponse && resLen !== 0) plan.responseBody = notImported(resLen, resLen !== undefined && resLen <= max && !resTextual ? resType : undefined);
  return plan;
}

/** Back-compat helper: whether the bodies are fetched. */
export function shouldFetchBodies(e: ProfileEntry): boolean {
  return bodyPlan(e).fetch;
}

const BINARY_TYPES = /^(image|audio|video|font)\/|^application\/(octet-stream|zip|gzip|pdf|x-protobuf|protobuf|grpc|wasm)/i;

/** Body bytes from the detail payload → display Body (≤ maxBytes, gunzipped when still compressed). */
export function toBody(bytes: unknown, headers: Record<string, string | string[]> | undefined, maxBytes = MAX_PROFILE_BODY_BYTES): Body | undefined {
  if (!Array.isArray(bytes) || bytes.length === 0) return undefined;
  let buf: Buffer = Buffer.from(bytes.slice(0, maxBytes + 1).map((b) => Number(b) & 0xff));
  let truncated = bytes.length > maxBytes;
  // dart:io may keep the wire bytes; native clients hand over decoded bytes but keep the content-encoding header.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && !truncated) {
    try {
      buf = zlib.gunzipSync(buf, { maxOutputLength: maxBytes + 1 });
    } catch {
      /* keep the raw bytes */
    }
  }
  if (buf.length > maxBytes) {
    buf = buf.subarray(0, maxBytes);
    truncated = true;
  }
  const ct = headerValue(headers, 'content-type') ?? '';
  const body: Body = isText(buf, ct, truncated) ? { text: buf.toString('utf8'), encoding: 'utf8' } : { text: buf.toString('base64'), encoding: 'base64' };
  if (truncated) body.truncated = true;
  return body;
}

function isText(buf: Buffer, contentType: string, truncated: boolean): boolean {
  if (BINARY_TYPES.test(contentType)) return false;
  if (buf.includes(0)) return false;
  try {
    // A cut multi-byte sequence at the end of a truncated body is fine.
    new TextDecoder('utf-8', { fatal: true }).decode(truncated ? buf.subarray(0, Math.max(0, buf.length - 3)) : buf);
    return true;
  } catch {
    return false;
  }
}

/** Fields of a detail payload (`getHttpProfileRequest`) as an Exchange patch. */
export function bodiesPatch(detail: ProfileEntry, maxBytes = MAX_PROFILE_BODY_BYTES): Partial<Exchange> {
  if (!detail || typeof detail !== 'object') return {};
  const pkg = isPackageEntry(detail);
  const patch: Partial<Exchange> = {};
  const reqBody = toBody(detail.requestBody, toHeaders(detail.request?.headers, pkg), maxBytes);
  const resBody = toBody(detail.responseBody, toHeaders(detail.response?.headers, pkg), maxBytes);
  if (reqBody) patch.requestBody = reqBody;
  if (resBody) patch.responseBody = resBody;
  return patch;
}

/** Fields that changed between two mappings of the same entry (for `update`). */
export function diffExchange(prev: Omit<Exchange, 'id'>, next: Omit<Exchange, 'id'>): Partial<Exchange> {
  const patch: Partial<Exchange> = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof Omit<Exchange, 'id'>>;
  for (const k of keys) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k]) && next[k] !== undefined) (patch as Record<string, unknown>)[k] = next[k];
  }
  return patch;
}

/** Validates the getHttpProfile result shape (any Dart-Code / SDK version may hand back something else). */
export function asHttpProfile(v: unknown): HttpProfile | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as Partial<HttpProfile>;
  if (typeof p.timestamp !== 'number' || !Array.isArray(p.requests)) return undefined;
  return { type: p.type, timestamp: p.timestamp, requests: p.requests.filter((r) => r && typeof r === 'object' && typeof r.id === 'string') };
}

// ---------------------------------------------------------------------------------------------------------------
// CONTRACTS §14.7: bypass detection. Main-isolate dart:io traffic runs under the generated entry's HttpOverrides
// and so goes through the proxy; an entry that did NOT is a bypass: an `HttpOverrides.runZoned` /
// `runWithHttpOverrides` zone in the app (its own HttpClient: no `x-fi-id`, no proxy), a custom
// `connectionFactory` (our `x-fi-id`, but the app's own socket), the DIRECT fallback while the proxy was
// unreachable, or another proxy set by the app's own overrides.
// ---------------------------------------------------------------------------------------------------------------

/** The entry's trace side channel (CONTRACTS §9.1): never a bypass. */
export const TRACE_HOST = 'trace.flutter-intercept.invalid';

export type BypassCause = 'no-overrides' | 'connection' | 'other-proxy' | 'unknown';

export interface BypassQuery {
  method: string;
  url: string;
  /** Epoch ms (device clock). */
  startedAt: number;
}

export interface BypassOptions {
  isOurProxy?: IsOurProxy;
  /** Whether the proxy recorded this request (true / false), undefined = can't tell. */
  proxySaw?: (q: BypassQuery) => boolean | undefined;
  /** Requests of this session carry `x-fi-id` (source capture on): a plain-http one without it didn't come through us. */
  traced?: boolean;
}

export type BypassVerdict = { verdict: 'wait' } | { verdict: 'ok' } | { verdict: 'bypass'; host: string; cause: BypassCause };

export function hasTraceHeader(e: ProfileEntry): boolean {
  const h = e.request?.headers;
  return !!h && typeof h === 'object' && Object.keys(h).some((k) => k.toLowerCase() === TRACE_HEADER);
}

/**
 * Whether a main-isolate dart:io entry went around the proxy. Decided once the response ended (`wait` before):
 * - https: through the proxy it is always tunnelled (`proxyDetails`), so no `proxyDetails` = bypass, and
 *   `proxyDetails` naming another proxy = bypass;
 * - plain http: through the proxy it has no `proxyDetails` either, so `proxySaw` decides; without an answer, a
 *   request without `x-fi-id` in a traced session is a bypass, anything else is not reported.
 * Failed requests, CONNECT records, package:http_profile entries and the trace channel are never reported.
 */
export function bypassVerdict(e: ProfileEntry, opts: BypassOptions = {}): BypassVerdict {
  if (!e || typeof e.id !== 'string' || typeof e.method !== 'string' || typeof e.uri !== 'string') return { verdict: 'ok' };
  if (isPackageEntry(e) || e.method.toUpperCase() === 'CONNECT') return { verdict: 'ok' };
  const url = cleanUrl(e.uri);
  if (!url) return { verdict: 'ok' };
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (!host || host === TRACE_HOST) return { verdict: 'ok' };
  if (entryError(e)) return { verdict: 'ok' };
  if (!isFinished(e)) return { verdict: 'wait' };
  if (!e.request || typeof e.request !== 'object') return { verdict: 'ok' };
  const traced = hasTraceHeader(e);
  const pd = e.request.proxyDetails;
  if (pd && typeof pd === 'object' && typeof pd.host === 'string' && typeof pd.port === 'number') {
    if (!opts.isOurProxy || opts.isOurProxy(pd.host, pd.port)) return { verdict: 'ok' };
    return { verdict: 'bypass', host, cause: 'other-proxy' };
  }
  const cause: BypassCause = traced ? 'connection' : 'no-overrides';
  if (parsed.protocol === 'https:') return { verdict: 'bypass', host, cause };
  let saw: boolean | undefined;
  try {
    saw = opts.proxySaw?.({ method: e.method.toUpperCase(), url, startedAt: usToMs(e.startTime) ?? Date.now() });
  } catch {
    saw = undefined;
  }
  if (saw === true) return { verdict: 'ok' };
  if (saw === false) return { verdict: 'bypass', host, cause };
  if (!traced && opts.traced) return { verdict: 'bypass', host, cause: 'no-overrides' };
  return { verdict: 'ok' };
}

/** How far apart the device's and the proxy's clocks may be when matching a request (ms). */
export const PROXY_MATCH_WINDOW_MS = 120_000;

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/**
 * Host helper for `proxySaw`: whether a proxy exchange is this request (same method and URL, recorded by the proxy
 * itself — not imported from the profile — within `PROXY_MATCH_WINDOW_MS`). Wire as
 * `proxySaw: (q) => proxyHost.getExchanges().some((x) => matchesProxyExchange(x, q))`.
 */
export function matchesProxyExchange(x: Pick<Exchange, 'method' | 'url' | 'startedAt' | 'captured'>, q: BypassQuery): boolean {
  if (!x || x.captured === 'vm-profile') return false;
  if (String(x.method).toUpperCase() !== q.method.toUpperCase()) return false;
  if (Math.abs(x.startedAt - q.startedAt) > PROXY_MATCH_WINDOW_MS) return false;
  return sameUrl(x.url, q.url);
}

const BYPASS_CAUSES: Record<BypassCause, string> = {
  'no-overrides': 'an HttpOverrides zone in the app (HttpOverrides.runZoned / runWithHttpOverrides) creates its own HttpClient',
  connection: 'a custom connectionFactory in the app, or the proxy was unreachable (DIRECT fallback)',
  'other-proxy': "the app's own HttpOverrides sends them to another proxy",
  unknown: 'an HttpOverrides zone or a custom connectionFactory in the app',
};

/** One sentence (≤ 200 characters): the host and the likely cause. */
export function bypassText(host: string, cause: BypassCause): string {
  const h = cleanText(host, 100).replace(/[^A-Za-z0-9.:[\]_-]/g, '?');
  return `Requests to ${h} bypass the proxy: ${BYPASS_CAUSES[cause] ?? BYPASS_CAUSES.unknown}.`.slice(0, 200);
}

export function moreBypassText(n: number): string {
  return `Requests to ${n} more host${n === 1 ? '' : 's'} bypass the proxy too.`;
}

/** Whether a native client's failure is a TLS trust failure (the app doesn't trust the proxy's CA). */
export function isTrustError(e: ProfileEntry): boolean {
  const err = entryError(e);
  return !!err && /ERR_CERT_|CERT_AUTHORITY|certificate|trust anchor|SSLHandshake|handshake failed|-1202|NSURLErrorServerCertificate/i.test(err);
}
