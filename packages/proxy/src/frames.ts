// Frame construction for WebSocket messages and SSE events (CONTRACTS §11.1). Payloads are kept up to
// FRAME_PAYLOAD_CAP bytes (text as UTF-8, binary as base64 of the first bytes); `size` is always the full size.
import { isUtf8 } from 'buffer';
import type { Frame } from './types';
import type { SseEvent } from './sse';

export { FRAME_PAYLOAD_CAP } from './grpc-meta';
import { FRAME_PAYLOAD_CAP } from './grpc-meta';
export const DEFAULT_MAX_FRAMES = 500;
/** Per-exchange byte budget for stored frames (frameCost), oldest dropped beyond it (REVIEW-5 #4). */
export const MAX_FRAME_BYTES_PER_EXCHANGE = 8 * 1024 * 1024;
/** Frames an open stream keeps when the store's byte budget makes the proxy trim live streams first. */
export const LIVE_FRAME_FLOOR = 50;

/** Text (cut at a character boundary) of at most FRAME_PAYLOAD_CAP bytes. */
function cappedText(buf: Buffer): { text: string; truncated: boolean } {
  if (buf.length <= FRAME_PAYLOAD_CAP) return { text: buf.toString('utf8'), truncated: false };
  let text = buf.subarray(0, FRAME_PAYLOAD_CAP).toString('utf8');
  // A multi-byte character split by the cut decodes to U+FFFD at the end.
  if (text.endsWith('�')) text = text.slice(0, -1);
  return { text, truncated: true };
}

/** A WebSocket data frame (text / binary), or a control frame's payload (ping / pong). */
export function payloadFrame(dir: Frame['dir'], kind: 'text' | 'binary' | 'ping' | 'pong', payload: Buffer, at = Date.now()): Frame {
  const f: Frame = { dir, at, kind, size: payload.length };
  if (!payload.length) return f;
  const asText = kind === 'text' || ((kind === 'ping' || kind === 'pong') && isUtf8(payload));
  if (asText) {
    const { text, truncated } = cappedText(payload);
    f.text = text;
    if (truncated) f.truncated = true;
  } else {
    f.base64 = payload.subarray(0, FRAME_PAYLOAD_CAP).toString('base64');
    if (payload.length > FRAME_PAYLOAD_CAP) f.truncated = true;
  }
  return f;
}

export function closeFrame(dir: Frame['dir'], code: number | undefined, reason: string | Buffer | undefined, at = Date.now()): Frame {
  const r = Buffer.isBuffer(reason) ? reason : Buffer.from(reason ?? '', 'utf8');
  const f: Frame = { dir, at, kind: 'close', size: r.length + (code !== undefined ? 2 : 0) };
  if (code !== undefined) f.closeCode = code;
  if (r.length) f.text = cappedText(r).text;
  return f;
}

export function sseFrame(e: SseEvent, at = Date.now()): Frame {
  const f: Frame = { dir: 'receive', at, kind: 'event', text: e.data, size: e.size };
  if (e.truncated) f.truncated = true;
  if (e.event !== undefined) f.event = e.event;
  if (e.id !== undefined) f.id = e.id;
  return f;
}

/**
 * PERF-1 #3: a gRPC message frame keeps its raw bytes here until it is first shown (snapshot / emit), so messages that
 * are trimmed away before that are never base64-encoded.
 */
export const RAW_PAYLOAD = Symbol('flutter-intercept.raw-payload');
type LazyFrame = Frame & { [RAW_PAYLOAD]?: Buffer };

/** A frame whose `base64` is filled in from `bytes` on first `materializeFrame`. */
export function lazyPayloadFrame(f: Frame, bytes: Buffer): Frame {
  if (bytes.length) (f as LazyFrame)[RAW_PAYLOAD] = bytes;
  return f;
}

/** Fill in a lazy frame's `base64` (once). Returns the frame. */
export function materializeFrame(f: Frame): Frame {
  const raw = (f as LazyFrame)[RAW_PAYLOAD];
  if (raw) {
    f.base64 = raw.toString('base64');
    delete (f as LazyFrame)[RAW_PAYLOAD];
  }
  return f;
}

/**
 * PERF-1 #9: the measured per-frame overhead (object, fields, array slot) is about 140 B, not 32: small frames were
 * under-counted 1.6× against the store's byte budget.
 */
export const FRAME_OVERHEAD_BYTES = 150;

/** What a stored frame costs against the body byte budget (its kept payload + names + object overhead). */
export function frameCost(f: Frame): number {
  const raw = (f as LazyFrame)[RAW_PAYLOAD];
  const payload = raw ? Math.ceil(raw.length / 3) * 4 : (f.base64?.length ?? 0);
  return (f.text?.length ?? 0) + payload + (f.event?.length ?? 0) + (f.id?.length ?? 0) + FRAME_OVERHEAD_BYTES;
}
