/**
 * WebSocket messages / SSE events (CONTRACTS §11.1) for the "Messages" tab. Pure: no DOM.
 *
 * Frames have no ids: the proxy keeps the newest `maxFramesPerExchange` and counts the rest in `framesDropped`,
 * so a frame's stable number is `framesDropped + index` (it survives older frames being dropped).
 *
 * The host re-sends an open exchange's whole frame window (up to ~200 frames / ~2 MB, ≤ 2 updates/s). Every update
 * arrives as new objects (structured clone), so per-frame work is cached by `frameKey` (number + time + size) in a
 * FrameCache, never by object identity (REVIEW-5 #4).
 */
import type { Exchange, Frame } from './protocol';
import { formatJson } from './json';
import { formatBytes } from './util';
import { tunnelTitle } from './connection';

export type { Frame } from './protocol';

/** True for exchanges that carry frames (an upgraded WebSocket or a text/event-stream response). */
export function hasFrames(ex: Pick<Exchange, 'kind'>): boolean {
  return ex.kind === 'websocket' || ex.kind === 'sse';
}

/** Total frames seen, including the dropped ones. */
export function frameTotal(ex: Pick<Exchange, 'frames' | 'framesDropped'>): number {
  return (ex.framesDropped ?? 0) + (ex.frames?.length ?? 0);
}

export const KIND_BADGE: Record<NonNullable<Exchange['kind']>, string> = { websocket: 'WS', sse: 'SSE', tunnel: 'TLS' };

/** Tooltip of a WS / SSE list badge: "WebSocket · 12 messages (3 dropped) · open" (tunnels: CONTRACTS §14.2). */
export function kindTitle(ex: Pick<Exchange, 'kind' | 'frames' | 'framesDropped' | 'state'> & Partial<Pick<Exchange, 'url' | 'tunnelBytes'>>): string {
  if (ex.kind === 'tunnel') return tunnelTitle({ url: ex.url ?? '', state: ex.state, tunnelBytes: ex.tunnelBytes });
  const what = ex.kind === 'websocket' ? 'WebSocket' : 'Server-sent events';
  const n = frameTotal(ex);
  const unit = ex.kind === 'sse' ? 'event' : 'message';
  const dropped = ex.framesDropped ? ` (${ex.framesDropped} oldest dropped)` : '';
  const live = ex.state === 'pending' ? ' · open' : '';
  return `${what} · ${n} ${unit}${n === 1 ? '' : 's'}${dropped}${live}`;
}

/** "↑" sent by the app, "↓" received from the server. */
export function dirArrow(f: Pick<Frame, 'dir'>): string {
  return f.dir === 'send' ? '↑' : '↓';
}
export function dirLabel(f: Pick<Frame, 'dir'>): string {
  return f.dir === 'send' ? 'Sent by the app' : 'Received from the server';
}

/** Time since the connection opened: "+0.042 s", "+12.4 s", "+3m 02s", "+1h 04m". */
export function formatRelative(at: number, start: number): string {
  const ms = Math.max(0, at - start);
  if (ms < 10_000) return `+${(ms / 1000).toFixed(3)} s`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `+${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `+${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** RFC 6455 §7.4.1 close codes the app is likely to meet. */
const CLOSE_CODES: Record<number, string> = {
  1000: 'normal closure',
  1001: 'going away',
  1002: 'protocol error',
  1003: 'unsupported data',
  1005: 'no status code',
  1006: 'abnormal closure (no close frame)',
  1007: 'invalid payload data',
  1008: 'policy violation',
  1009: 'message too big',
  1010: 'missing extension',
  1011: 'internal server error',
  1012: 'service restart',
  1013: 'try again later',
  1015: 'TLS handshake failure',
};

/** "1000 (normal closure)", "4001 (application-defined)". */
export function closeCodeText(code: number | undefined): string {
  if (code === undefined) return 'no status code';
  const known = CLOSE_CODES[code];
  if (known) return `${code} (${known})`;
  if (code >= 4000 && code <= 4999) return `${code} (application-defined)`;
  return String(code);
}

/** Longest SSE `event` / `id` text rendered (the proxy may send up to 64 KB of each). */
export const MAX_EVENT_CHARS = 256;
export const MAX_ID_CHARS = 256;

/** `s` cut to `max` characters with an ellipsis. */
export function capText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Stable identity of a frame across re-sends: its number (framesDropped + index), time and size. */
export function frameKey(n: number, f: Pick<Frame, 'at' | 'size'>): string {
  return `${n}:${f.at}:${f.size}`;
}

const PREVIEW_CHARS = 160;

/** One-line preview for the frame list. */
export function framePreview(f: Frame): string {
  switch (f.kind) {
    case 'binary': return `binary · ${formatBytes(f.size)}`;
    case 'ping': return f.text ? `ping · ${oneLine(f.text)}` : 'ping';
    case 'pong': return f.text ? `pong · ${oneLine(f.text)}` : 'pong';
    case 'close': return `close ${closeCodeText(f.closeCode)}${f.text ? ` · ${oneLine(f.text)}` : ''}`;
    default: return oneLine(f.text ?? '');
  }
}

function oneLine(t: string): string {
  const head = t.length > PREVIEW_CHARS * 2 ? t.slice(0, PREVIEW_CHARS * 2) : t;
  const s = head.replace(/\s+/g, ' ').trim();
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS - 1)}…` : s;
}

/** Pretty JSON of a text frame, when it is JSON (objects / arrays only); undefined otherwise. */
export function framePrettyJson(f: Pick<Frame, 'text' | 'truncated'>): string | undefined {
  const t = f.text;
  if (!t || f.truncated || !/^\s*[[{]/.test(t)) return undefined;
  return formatJson(t);
}

const HEX_BYTES = 256;

/** Hex dump of the first bytes of a binary frame: "00000000  89 50 4e 47 …  .PNG…". */
export function hexDump(base64: string, max = HEX_BYTES): { text: string; shown: number } {
  let bin = '';
  try {
    // Only decode what is shown (4 base64 chars = 3 bytes).
    bin = atob(base64.slice(0, Math.ceil(max / 3) * 4));
  } catch {
    return { text: '(not valid base64)', shown: 0 };
  }
  const bytes = bin.slice(0, max);
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const hex = Array.from(chunk, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, (c) => { const n = c.charCodeAt(0); return n >= 0x20 && n < 0x7f ? c : '.'; }).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return { text: lines.join('\n'), shown: bytes.length };
}

// ---------------------------------------------------------------- per-exchange cache

interface Cached { haystack?: string; preview?: string; computed: number }

/**
 * Derived text of one exchange's frames (lowercased search text, list preview), keyed by frameKey so a re-sent
 * window only processes the frames that are new. Entries of frames that left the window are dropped on `prune`.
 */
export class FrameCache {
  private map = new Map<string, Cached>();
  /** Frames whose derived text was computed (not served from the cache) — for tests and the benchmark. */
  computed = 0;

  private entry(key: string): Cached {
    let c = this.map.get(key);
    if (!c) { c = { computed: 0 }; this.map.set(key, c); }
    return c;
  }

  haystack(n: number, f: Frame): string {
    const c = this.entry(frameKey(n, f));
    if (c.haystack === undefined) {
      this.computed++;
      c.haystack = [f.text ?? '', capText(f.event ?? '', MAX_EVENT_CHARS), capText(f.id ?? '', MAX_ID_CHARS), f.kind, f.closeCode ?? '']
        .join('\n').toLowerCase();
    }
    return c.haystack;
  }

  preview(n: number, f: Frame): string {
    const c = this.entry(frameKey(n, f));
    if (c.preview === undefined) { this.computed++; c.preview = framePreview(f); }
    return c.preview;
  }

  /** Forget frames outside the current window (call once per update). */
  prune(frames: readonly Frame[], dropped: number): void {
    if (this.map.size <= frames.length * 2 + 16) return;
    const keep = new Set(frames.map((f, i) => frameKey(dropped + i, f)));
    for (const k of this.map.keys()) if (!keep.has(k)) this.map.delete(k);
  }

  get size(): number { return this.map.size; }
}

// ---------------------------------------------------------------- filter inside messages

export type DirFilter = 'all' | 'send' | 'receive';

/**
 * Indexes (into `frames`) of the frames that match: every whitespace-separated word must appear in the text,
 * SSE event name / id, kind or close code (case-insensitive; "-word" excludes). Lowercased text comes from
 * `cache` (by frame number + time + size), so neither typing nor a re-sent window re-lowercases 64 KB payloads.
 */
export function filterFrames(
  frames: readonly Frame[], text: string, dir: DirFilter = 'all', cache: FrameCache = new FrameCache(), dropped = 0,
): number[] {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w && w !== '-');
  const out: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (dir !== 'all' && f.dir !== dir) continue;
    if (words.length) {
      const h = cache.haystack(dropped + i, f);
      let ok = true;
      for (const w of words) {
        const neg = w.startsWith('-');
        if (h.includes(neg ? w.slice(1) : w) === neg) { ok = false; break; }
      }
      if (!ok) continue;
    }
    out.push(i);
  }
  return out;
}

/** Counts for the Messages header. */
export function frameCounts(frames: readonly Frame[]): { sent: number; received: number } {
  let sent = 0;
  for (const f of frames) if (f.dir === 'send') sent++;
  return { sent, received: frames.length - sent };
}
