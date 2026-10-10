// Replaying recorded WebSocket / SSE exchanges (CONTRACTS §14.5). Pure helpers: the timing plan and payloads; the
// proxy (intercept-proxy.ts) does the I/O.
import type { Frame } from './types';

/** Gaps between replayed frames are kept, up to this (a recording paused for minutes replays in seconds). */
export const MAX_REPLAY_GAP_MS = 5000;
/** A redacted binary frame (no payload kept) is replayed as this many zero bytes at most (its recorded size). */
export const REDACTED_BINARY_MAX = 64 * 1024;

const gap = (from: number | undefined, to: number | undefined): number => {
  if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.min(MAX_REPLAY_GAP_MS, Math.max(0, to - from));
};

/** One SSE event in wire format (`event:` / `id:` / `data:` lines, blank line). */
export function sseEventText(f: Frame): string {
  let out = '';
  if (f.event !== undefined && f.event !== '') out += `event: ${f.event.replace(/[\r\n]/g, ' ')}\n`;
  if (f.id !== undefined) out += `id: ${f.id.replace(/[\r\n]/g, ' ')}\n`;
  for (const line of (f.text ?? '').split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

export interface TimedStep {
  /** Wait this long after the previous step (ms, 0–MAX_REPLAY_GAP_MS). */
  delayMs: number;
  frame: Frame;
}

/** SSE: the recorded events, the first at once, then the recorded gaps (≤ 5 s, negative clamped). */
export function sseSchedule(frames: readonly Frame[] | undefined): TimedStep[] {
  const out: TimedStep[] = [];
  let prev: number | undefined;
  for (const f of frames ?? []) {
    if (!f || f.kind !== 'event') continue;
    out.push({ delayMs: out.length ? gap(prev, f.at) : 0, frame: f });
    prev = f.at;
  }
  return out;
}

/** The whole recorded stream as one body (when it can't be streamed in time). */
export function sseBody(frames: readonly Frame[] | undefined): string {
  return sseSchedule(frames)
    .map((s) => sseEventText(s.frame))
    .join('');
}

export interface WsScript {
  /** Server frames sent after the upgrade, before the app's first message. */
  opening: TimedStep[];
  /** replies[k]: server frames that followed the app's k-th message (0-based) in the recording. */
  replies: TimedStep[][];
}

const isClientMessage = (f: Frame) => f.dir === 'send' && (f.kind === 'text' || f.kind === 'binary');

/**
 * WebSocket: the server side of the recording keyed to the app's messages (by order, not content). The first
 * server frame of a reply waits as long after the app's message as it did in the recording; later frames keep their
 * gaps (all ≤ 5 s). Frames after the server's close are dropped; the app's own pings / pongs / close are not keys.
 */
export function wsScript(frames: readonly Frame[] | undefined): WsScript {
  const script: WsScript = { opening: [], replies: [] };
  let current = script.opening;
  let anchor: number | undefined;
  for (const f of frames ?? []) {
    if (!f || typeof f !== 'object') continue;
    if (isClientMessage(f)) {
      current = [];
      script.replies.push(current);
      anchor = f.at;
      continue;
    }
    if (f.dir !== 'receive') continue;
    const delayMs = current === script.opening && current.length === 0 ? 0 : gap(anchor, f.at);
    current.push({ delayMs, frame: f });
    anchor = f.at;
    if (f.kind === 'close') break;
  }
  return script;
}

/** The payload to send for a recorded frame (text, base64, or zeros of the recorded size when redacted). */
export function framePayload(f: Frame): { data: Buffer | string; binary: boolean } {
  if (f.kind === 'text' || f.kind === 'event') return { data: f.text ?? '', binary: false };
  if (f.base64 !== undefined) return { data: Buffer.from(f.base64, 'base64'), binary: true };
  if (f.text !== undefined) return { data: Buffer.from(f.text, 'utf8'), binary: f.kind === 'binary' };
  return { data: Buffer.alloc(Math.min(Math.max(0, f.size | 0), REDACTED_BINARY_MAX)), binary: true };
}
