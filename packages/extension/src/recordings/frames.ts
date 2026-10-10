/**
 * WebSocket / SSE frames in recordings (CONTRACTS §11.1, §14.5). Pure.
 *
 * - `capFrames`: the proxy's caps (newest `MAX_RECORDED_FRAMES`, at most `MAX_FRAME_COST_PER_EXCHANGE` of
 *   `frameCost`), so a saved file never holds more than the proxy would have kept.
 * - `redactFrame`: a frame as agents see it (CONTRACTS §11.5): text / event data / close reasons through
 *   `redactFrameText`, SSE ids like a value, binary payloads left out (size kept, marked `truncated`).
 * - `validFrames`: strict validation of the frames of a loaded file (kinds per exchange kind, sizes, base64, counts,
 *   names without line breaks), rebuilt from the checked fields only.
 * - `frameLines` / `frameSummary`: the normalised frame text for `diffText` and the per-route frame facts for `diff`.
 */
import { createHash } from 'crypto';
import type { Exchange, Frame } from '@flutter-intercept/proxy';
import { redactFrameText, redactSecretValues } from '../agent/redact';

/** packages/proxy/src/frames.ts `DEFAULT_MAX_FRAMES` (the extension never raises `maxFramesPerExchange`). */
export const MAX_RECORDED_FRAMES = 500;
/** packages/proxy/src/frames.ts `FRAME_PAYLOAD_CAP`: text ≤ 64 K characters, binary ≤ 64 KB (as base64). */
export const FRAME_PAYLOAD_CAP = 64 * 1024;
/** packages/proxy/src/frames.ts `MAX_FRAME_BYTES_PER_EXCHANGE` (counted with `frameCost`). */
export const MAX_FRAME_COST_PER_EXCHANGE = 8 * 1024 * 1024;
/** packages/proxy/src/sse.ts `SSE_EVENT_NAME_CAP` / `SSE_ID_CAP`. */
export const MAX_EVENT_NAME_CHARS = 256;
export const MAX_EVENT_ID_CHARS = 1024;

const BASE64_MAX_CHARS = 4 * Math.ceil(FRAME_PAYLOAD_CAP / 3);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const WS_KINDS = new Set<Frame['kind']>(['text', 'binary', 'ping', 'pong', 'close']);

export type StreamKind = 'websocket' | 'sse';

/** What a stored frame costs (packages/proxy/src/frames.ts `frameCost`). */
export function frameCost(f: Frame): number {
  return (f.text?.length ?? 0) + (f.base64?.length ?? 0) + (f.event?.length ?? 0) + (f.id?.length ?? 0) + 32;
}

/** The newest frames within the caps, and how many more were dropped (added to `dropped`). */
export function capFrames(frames: readonly Frame[], dropped = 0): { frames: Frame[]; dropped: number } {
  let start = Math.max(0, frames.length - MAX_RECORDED_FRAMES);
  let cost = 0;
  for (let i = start; i < frames.length; i++) cost += frameCost(frames[i]);
  while (cost > MAX_FRAME_COST_PER_EXCHANGE && start < frames.length - 1) cost -= frameCost(frames[start++]);
  return { frames: frames.slice(start), dropped: dropped + start };
}

/** A copy of `f` with only the fields a recording keeps. */
export function copyFrame(f: Frame): Frame {
  const out: Frame = { dir: f.dir, at: f.at, kind: f.kind, size: f.size };
  if (f.text !== undefined) out.text = f.text;
  if (f.base64 !== undefined) out.base64 = f.base64;
  if (f.truncated) out.truncated = true;
  if (f.event !== undefined) out.event = f.event;
  if (f.id !== undefined) out.id = f.id;
  if (f.closeCode !== undefined) out.closeCode = f.closeCode;
  return out;
}

/**
 * `f` redacted like agent views (CONTRACTS §11.5): text through `redactFrameText`, the SSE id like a value, a binary
 * payload left out (it can't be redacted; `size` keeps its length, `truncated` says the bytes are missing).
 */
export function redactFrame(f: Frame): Frame {
  const out = copyFrame(f);
  if (out.text !== undefined) out.text = redactFrameText(out.text);
  if (out.id !== undefined) out.id = redactSecretValues(out.id, true);
  if (out.base64 !== undefined) {
    delete out.base64;
    if (f.size > 0) out.truncated = true;
  }
  return out;
}

// ------------------------------------------------------------------ validation

export class FrameFormatError extends Error {
  readonly name = 'FrameFormatError';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(where: string, what: string): never {
  throw new FrameFormatError(`${where} ${what}`);
}

function validFrame(v: unknown, kind: StreamKind, where: string): Frame {
  if (!isObj(v)) fail(where, 'must be an object');
  if (v.dir !== 'send' && v.dir !== 'receive') fail(`${where}.dir`, 'must be "send" or "receive"');
  if (typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at < 0) fail(`${where}.at`, 'must be a time (epoch ms)');
  if (typeof v.kind !== 'string') fail(`${where}.kind`, 'must be a string');
  const fk = v.kind as Frame['kind'];
  if (kind === 'websocket' && !WS_KINDS.has(fk)) fail(`${where}.kind`, 'must be text, binary, ping, pong or close in a WebSocket recording');
  if (kind === 'sse' && fk !== 'event') fail(`${where}.kind`, 'must be "event" in an SSE recording');
  if (kind === 'sse' && v.dir !== 'receive') fail(`${where}.dir`, 'must be "receive" for an SSE event');
  if (!Number.isSafeInteger(v.size) || (v.size as number) < 0) fail(`${where}.size`, 'must be a non-negative integer');
  const f: Frame = { dir: v.dir, at: v.at, kind: fk, size: v.size as number };
  if (v.text !== undefined) {
    if (typeof v.text !== 'string') fail(`${where}.text`, 'must be a string');
    if (fk === 'binary') fail(`${where}.text`, 'is not allowed on a binary frame (use base64)');
    // ≤ 64 K characters, with room for "[redacted]" replacing shorter values in a redacted recording
    if (v.text.length > FRAME_PAYLOAD_CAP * 2) fail(`${where}.text`, 'is too long');
    f.text = v.text;
  }
  if (v.base64 !== undefined) {
    if (typeof v.base64 !== 'string') fail(`${where}.base64`, 'must be a string');
    if (fk !== 'binary' && fk !== 'ping' && fk !== 'pong') fail(`${where}.base64`, 'is only allowed on binary, ping and pong frames');
    if (f.text !== undefined) fail(where, 'must not have both text and base64');
    if (v.base64.length > BASE64_MAX_CHARS) fail(`${where}.base64`, 'is too long (more than 64 KB)');
    if (v.base64.length % 4 !== 0 || !BASE64.test(v.base64)) fail(`${where}.base64`, 'is not valid base64');
    f.base64 = v.base64;
  }
  if (v.truncated !== undefined) {
    if (v.truncated !== true) fail(`${where}.truncated`, 'must be true');
    f.truncated = true;
  }
  if (v.event !== undefined) {
    if (fk !== 'event') fail(`${where}.event`, 'is only allowed on SSE events');
    if (typeof v.event !== 'string' || v.event.length > MAX_EVENT_NAME_CHARS || /[\r\n\0]/.test(v.event)) {
      fail(`${where}.event`, `must be a string of at most ${MAX_EVENT_NAME_CHARS} characters without CR, LF or NUL`);
    }
    f.event = v.event;
  }
  if (v.id !== undefined) {
    if (fk !== 'event') fail(`${where}.id`, 'is only allowed on SSE events');
    if (typeof v.id !== 'string' || v.id.length > MAX_EVENT_ID_CHARS || /[\r\n\0]/.test(v.id)) {
      fail(`${where}.id`, `must be a string of at most ${MAX_EVENT_ID_CHARS} characters without CR, LF or NUL`);
    }
    f.id = v.id;
  }
  if (v.closeCode !== undefined) {
    if (fk !== 'close') fail(`${where}.closeCode`, 'is only allowed on close frames');
    if (!Number.isInteger(v.closeCode) || (v.closeCode as number) < 1000 || (v.closeCode as number) > 4999) fail(`${where}.closeCode`, 'must be a WebSocket close code (1000–4999)');
    f.closeCode = v.closeCode as number;
  }
  return f;
}

/** The frames of a loaded `kind` exchange, checked strictly and rebuilt (CONTRACTS §14.5). */
export function validFrames(v: unknown, kind: StreamKind, where: string): Frame[] {
  if (!Array.isArray(v)) fail(where, 'must be an array');
  if (v.length > MAX_RECORDED_FRAMES) fail(where, `has more than ${MAX_RECORDED_FRAMES} frames`);
  const frames = v.map((x, i) => validFrame(x, kind, `${where}[${i}]`));
  let cost = 0;
  for (const f of frames) cost += frameCost(f);
  if (cost > MAX_FRAME_COST_PER_EXCHANGE) fail(where, 'hold more than 8 MB of payload');
  return frames;
}

// ------------------------------------------------------------------ diff helpers

/** A frame's message type: `send text`, `receive binary`, `event price_update` (SSE default name: `message`). */
export function messageType(f: Frame): string {
  if (f.kind === 'event') return `event ${f.event ?? 'message'}`;
  return `${f.dir} ${f.kind}`;
}

export interface FrameSummary {
  sent: number;
  received: number;
  /** Frames the proxy dropped (oldest) beyond its caps, summed over the exchanges. */
  dropped: number;
  /** Message types seen (see `messageType`). */
  types: Set<string>;
  /** Close codes seen (WebSocket), in first-seen order. */
  closeCodes: number[];
}

/** Frame facts of a route's exchanges, for `diff`. */
export function frameSummary(items: readonly Exchange[]): FrameSummary {
  const s: FrameSummary = { sent: 0, received: 0, dropped: 0, types: new Set(), closeCodes: [] };
  for (const e of items) {
    s.dropped += e.framesDropped ?? 0;
    for (const f of e.frames ?? []) {
      if (f.dir === 'send') s.sent++;
      else s.received++;
      s.types.add(messageType(f));
      if (f.kind === 'close' && f.closeCode !== undefined && !s.closeCodes.includes(f.closeCode)) s.closeCodes.push(f.closeCode);
    }
  }
  return s;
}

// ------------------------------------------------------------------ diffText

const MAX_FRAME_LINE_CHARS = 2000;
const UUID_ANY = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
/** JSON members whose values change on every run (message ids, nonces, clocks). Plain `id` is kept (often a counter). */
const VOLATILE_MEMBER =
  /("(?:request_?id|requestId|message_?id|messageId|msg_?id|msgId|correlation_?id|correlationId|trace_?id|traceId|span_?id|spanId|nonce|uuid|timestamp|ts|time|server_?time|serverTime|sent_?at|sentAt|created_?at|createdAt)"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Frame text with volatile values masked: UUIDs, ISO timestamps, id / time members of JSON messages. */
export function normaliseFrameText(text: string): string {
  return text.replace(VOLATILE_MEMBER, '$1"…"').replace(UUID_ANY, '<uuid>').replace(ISO_TIME, '<time>');
}

function relative(at: number, t0: number): string {
  const s = Math.max(0, at - t0) / 1000;
  return `+${s.toFixed(1)}s`;
}

function payload(f: Frame, redact: (t: string) => string): string {
  if (f.base64 !== undefined) {
    const bytes = Buffer.from(f.base64, 'base64');
    const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    return `[binary ${f.size} bytes, sha256 ${sha}…]`;
  }
  if (f.kind === 'binary') return `[binary ${f.size} bytes]`;
  if (f.text === undefined || f.text === '') return '';
  let t = normaliseFrameText(redact(f.text)).replace(/\r\n?|\n/g, '\\n');
  if (t.length > MAX_FRAME_LINE_CHARS) t = `${t.slice(0, MAX_FRAME_LINE_CHARS)}… (${t.length} characters)`;
  return t;
}

/**
 * One line per frame, normalised for a side-by-side diff: time relative to the exchange start (0.1 s), direction,
 * kind / SSE event name, the redacted text with volatile ids masked; SSE `id:` values dropped (`id …` marks one).
 */
export function frameLines(e: Exchange, redact: (t: string) => string = redactFrameText): string[] {
  const frames = e.frames ?? [];
  const t0 = Number.isFinite(e.startedAt) ? e.startedAt : (frames[0]?.at ?? 0);
  const out: string[] = [];
  const n = frames.length;
  out.push(`frames: ${n}${e.framesDropped ? ` (${e.framesDropped} older not recorded)` : ''}`);
  for (const f of frames) {
    const head =
      f.kind === 'event'
        ? `event ${f.event ?? 'message'}${f.id !== undefined ? ' id …' : ''}`
        : f.kind === 'close'
          ? `${f.dir} close${f.closeCode !== undefined ? ` ${f.closeCode}` : ''}`
          : `${f.dir} ${f.kind}`;
    const body = payload(f, redact);
    const tail = f.truncated && f.base64 === undefined && f.kind !== 'binary' ? ` [truncated, ${f.size} bytes]` : '';
    out.push(`${relative(f.at, t0)} ${head}${body ? ` ${body}` : ''}${tail}`);
  }
  return out;
}
