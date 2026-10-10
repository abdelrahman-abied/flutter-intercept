/**
 * Strict validation of recording files (CONTRACTS §12.4). A recording lives in the project's `.dart_tool`, but it
 * may have been edited or come from someone else, so nothing in it is trusted: every field is checked and the
 * result is rebuilt from the checked fields only (unknown fields dropped, header objects without prototypes
 * tricks, no CR/LF in header values, base64 that really is base64). Pure.
 *
 * CONTRACTS §14.5: entries may be WebSocket (`kind: "websocket"`, a ws(s):// URL, status 101, no bodies) or SSE
 * (`kind: "sse"`, http(s), no response body) exchanges with `frames` (frames.ts `validFrames`) and `framesDropped`.
 * File versions: 1 = HTTP entries only (0.6 / 0.7 files, and HTTP-only files written now, so 0.7 can still read
 * them); 2 = has WebSocket / SSE entries (an older extension then refuses the file by its version, not an entry).
 * A version 1 file with stream entries is refused; unknown versions are refused with a clear message.
 */
import type { Body, Exchange } from '@flutter-intercept/proxy';
import { FrameFormatError, validFrames, type StreamKind } from './frames';
import type { Recording } from './types';

/** HTTP-only recordings (0.6 / 0.7 format). */
export const RECORDING_VERSION = 1;
/** Recordings with WebSocket / SSE entries (CONTRACTS §14.5). */
export const RECORDING_VERSION_STREAMS = 2;
export const SUPPORTED_RECORDING_VERSIONS: readonly number[] = [RECORDING_VERSION, RECORDING_VERSION_STREAMS];

/** The version a file holding `entries` is written with: 2 when any entry is a WebSocket / SSE exchange, else 1. */
export function recordingVersionFor(entries: readonly Pick<Exchange, 'kind'>[]): 1 | 2 {
  return entries.some((e) => e.kind === 'websocket' || e.kind === 'sse') ? RECORDING_VERSION_STREAMS : RECORDING_VERSION;
}
export const MAX_NAME_CHARS = 200;
export const MAX_ENTRIES = 100_000;
export const MAX_URL_CHARS = 64 * 1024;
const MAX_HEADERS = 500;
const MAX_HEADER_VALUE_CHARS = 64 * 1024;

/** File-name safe id: lower-case letters, digits and dashes. */
export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ENTRY_STATES = new Set(['completed', 'mocked']);

export class RecordingFormatError extends Error {
  readonly name = 'RecordingFormatError';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function fail(where: string, what: string): never {
  throw new RecordingFormatError(`${where} ${what}`);
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function validName(v: unknown, where = 'name'): string {
  if (typeof v !== 'string' || !v.trim()) fail(where, 'must be a non-empty string');
  if (v.length > MAX_NAME_CHARS) fail(where, `must be at most ${MAX_NAME_CHARS} characters`);
  if (/[\0-\x1f\x7f]/.test(v)) fail(where, 'must not contain control characters');
  return v;
}

function validHeaders(v: unknown, where: string): Record<string, string | string[]> {
  if (!isObj(v)) fail(where, 'must be an object');
  const keys = Object.keys(v);
  if (keys.length > MAX_HEADERS) fail(where, `has more than ${MAX_HEADERS} headers`);
  const out: Record<string, string | string[]> = {};
  const value = (x: unknown, at: string): string => {
    if (typeof x !== 'string') fail(at, 'must be a string');
    if (x.length > MAX_HEADER_VALUE_CHARS) fail(at, 'is too long');
    if (/[\r\n\0]/.test(x)) fail(at, 'must not contain CR, LF or NUL');
    return x;
  };
  for (const k of keys) {
    if (!TOKEN.test(k)) fail(`${where}`, `has an invalid header name ${JSON.stringify(k.slice(0, 40))}`);
    const raw = v[k];
    const at = `${where}[${JSON.stringify(k)}]`;
    const val = Array.isArray(raw) ? raw.map((x, i) => value(x, `${at}[${i}]`)) : value(raw, at);
    // defineProperty: a header literally named "__proto__" stays a plain own property
    Object.defineProperty(out, k, { value: val, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function validBody(v: unknown, where: string): Body {
  if (!isObj(v)) fail(where, 'must be an object');
  if (typeof v.text !== 'string') fail(`${where}.text`, 'must be a string');
  if (v.encoding !== 'utf8' && v.encoding !== 'base64') fail(`${where}.encoding`, 'must be "utf8" or "base64"');
  if (v.encoding === 'base64' && (v.text.length % 4 !== 0 || !BASE64.test(v.text))) fail(`${where}.text`, 'is not valid base64');
  if (v.truncated !== undefined && typeof v.truncated !== 'boolean') fail(`${where}.truncated`, 'must be a boolean');
  return { text: v.text, encoding: v.encoding, ...(v.truncated ? { truncated: true } : {}) };
}

function validUrl(v: unknown, where: string, kind?: StreamKind): string {
  if (typeof v !== 'string' || v.length > MAX_URL_CHARS) fail(where, 'must be a URL string');
  if (/[\0-\x20\x7f]/.test(v)) fail(where, 'must not contain spaces or control characters');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    fail(where, 'is not a valid URL');
  }
  if (kind === 'websocket') {
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') fail(where, 'must be a ws(s) URL for a WebSocket exchange');
  } else if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(where, 'must be an http(s) URL');
  return v;
}

/** One recorded exchange, rebuilt from validated fields only. */
export function validEntry(v: unknown, where: string): Exchange {
  if (!isObj(v)) fail(where, 'must be an object');
  if (typeof v.id !== 'string' || !v.id || v.id.length > 200) fail(`${where}.id`, 'must be a non-empty string');
  if (!finite(v.startedAt) || v.startedAt < 0) fail(`${where}.startedAt`, 'must be a time (epoch ms)');
  if (v.durationMs !== undefined && (!finite(v.durationMs) || v.durationMs < 0)) fail(`${where}.durationMs`, 'must be a non-negative number');
  if (typeof v.method !== 'string' || !METHOD.test(v.method)) fail(`${where}.method`, 'must be an HTTP method');
  if (v.kind !== undefined && v.kind !== 'websocket' && v.kind !== 'sse') fail(`${where}.kind`, 'must be "websocket" or "sse" (or absent for HTTP)');
  const kind = v.kind as StreamKind | undefined;
  const url = validUrl(v.url, `${where}.url`, kind);
  if (!Number.isInteger(v.status) || (v.status as number) < 100 || (v.status as number) > 599) fail(`${where}.status`, 'must be an HTTP status (100–599)');
  if (typeof v.state !== 'string' || !ENTRY_STATES.has(v.state)) fail(`${where}.state`, 'must be "completed" or "mocked"');
  if (kind === 'websocket') {
    if (v.method.toUpperCase() !== 'GET') fail(`${where}.method`, 'must be GET for a WebSocket exchange');
    if (v.status !== 101) fail(`${where}.status`, 'must be 101 for a WebSocket exchange');
    if (v.requestBody !== undefined || v.responseBody !== undefined) fail(where, 'must not have bodies (a WebSocket exchange records frames)');
  }
  if (kind === 'sse' && v.responseBody !== undefined) fail(`${where}.responseBody`, 'must be absent for an SSE exchange (the events are its frames)');
  if (!kind && (v.frames !== undefined || v.framesDropped !== undefined)) fail(`${where}.frames`, 'are only allowed on WebSocket and SSE exchanges');
  const e: Exchange = {
    id: v.id,
    startedAt: v.startedAt,
    ...(v.durationMs !== undefined ? { durationMs: v.durationMs as number } : {}),
    method: v.method,
    url,
    requestHeaders: validHeaders(v.requestHeaders ?? {}, `${where}.requestHeaders`),
    ...(v.requestBody !== undefined ? { requestBody: validBody(v.requestBody, `${where}.requestBody`) } : {}),
    status: v.status as number,
    responseHeaders: validHeaders(v.responseHeaders ?? {}, `${where}.responseHeaders`),
    ...(v.responseBody !== undefined ? { responseBody: validBody(v.responseBody, `${where}.responseBody`) } : {}),
    state: v.state as Exchange['state'],
  };
  if (kind) {
    e.kind = kind;
    try {
      e.frames = validFrames(v.frames ?? [], kind, `${where}.frames`);
    } catch (err) {
      if (err instanceof FrameFormatError) throw new RecordingFormatError(err.message);
      throw err;
    }
    if (v.framesDropped !== undefined) {
      if (!Number.isSafeInteger(v.framesDropped) || (v.framesDropped as number) < 0) fail(`${where}.framesDropped`, 'must be a non-negative integer');
      if (v.framesDropped) e.framesDropped = v.framesDropped as number;
    }
  }
  if (v.matchedRuleId !== undefined) {
    if (typeof v.matchedRuleId !== 'string' || v.matchedRuleId.length > 200) fail(`${where}.matchedRuleId`, 'must be a string');
    e.matchedRuleId = v.matchedRuleId;
  }
  if (v.simulated !== undefined) {
    if (typeof v.simulated !== 'string' || v.simulated.length > 500) fail(`${where}.simulated`, 'must be a string');
    e.simulated = v.simulated;
  }
  if (v.initiator !== undefined) {
    if (v.initiator !== 'editor' && v.initiator !== 'agent') fail(`${where}.initiator`, 'must be "editor" or "agent"');
    e.initiator = v.initiator;
  }
  if (v.graphql !== undefined) {
    const g = v.graphql;
    if (!isObj(g)) fail(`${where}.graphql`, 'must be an object');
    const out: NonNullable<Exchange['graphql']> = {};
    if (g.operationName !== undefined) {
      if (typeof g.operationName !== 'string' || g.operationName.length > 200) fail(`${where}.graphql.operationName`, 'must be a string');
      out.operationName = g.operationName;
    }
    if (g.operationType !== undefined) {
      if (g.operationType !== 'query' && g.operationType !== 'mutation' && g.operationType !== 'subscription') fail(`${where}.graphql.operationType`, 'is invalid');
      out.operationType = g.operationType;
    }
    if (g.persisted !== undefined) {
      if (g.persisted !== true) fail(`${where}.graphql.persisted`, 'must be true');
      out.persisted = true;
    }
    if (g.batch !== undefined) {
      if (!Number.isInteger(g.batch) || (g.batch as number) < 1) fail(`${where}.graphql.batch`, 'must be a positive integer');
      out.batch = g.batch as number;
    }
    e.graphql = out;
  }
  return e;
}

/**
 * A parsed recording file → a `Recording`. `id` and `path` come from where the file was found (the file name is
 * authoritative), never from its content. Throws RecordingFormatError naming the first bad field.
 */
export function validateRecording(data: unknown, id: string, path: string): Recording {
  if (!isObj(data)) fail('recording', 'must be a JSON object');
  if (!SUPPORTED_RECORDING_VERSIONS.includes(data.version as number)) {
    const newer = typeof data.version === 'number' && Number.isInteger(data.version) && data.version > RECORDING_VERSION_STREAMS;
    fail('version', `must be 1 or 2 (this file has ${JSON.stringify(data.version)}${newer ? ': it was saved by a newer Flutter Intercept — update the extension to load it' : ''})`);
  }
  const version = data.version as 1 | 2;
  const name = validName(data.name);
  if (!finite(data.createdAt) || data.createdAt < 0) fail('createdAt', 'must be a time (epoch ms)');
  if (typeof data.redacted !== 'boolean') fail('redacted', 'must be a boolean');
  if (!Array.isArray(data.entries)) fail('entries', 'must be an array');
  if (data.entries.length > MAX_ENTRIES) fail('entries', `has more than ${MAX_ENTRIES} exchanges`);
  const entries = data.entries.map((x, i) => validEntry(x, `entries[${i}]`));
  let streams = 0;
  let frames = 0;
  for (const [i, e] of entries.entries()) {
    if (!e.kind) continue;
    if (version === RECORDING_VERSION) fail(`entries[${i}].kind`, 'is not allowed in a version 1 recording (WebSocket / SSE entries need version 2)');
    streams++;
    frames += e.frames?.length ?? 0;
  }
  return {
    version,
    id,
    name,
    createdAt: data.createdAt,
    exchanges: entries.length,
    path,
    redacted: data.redacted,
    ...(streams ? { streams, frames } : {}),
    entries,
  };
}
