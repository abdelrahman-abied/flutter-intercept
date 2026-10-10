/**
 * v0.7.0 timing waterfall (CONTRACTS §13.2). Pure: the list column and the detail pane's Timing tab are built on
 * these. Everything is in percentages, so a row never measures the DOM (no layout reads per row).
 */
import type { Exchange, Timings } from './protocol';
import { formatDuration, isPaused } from './util';

/** Phases in waterfall order (left to right). `paused` and `delay` are time the tool added, shown distinctly. */
export type Phase = 'request' | 'paused' | 'delay' | 'dns' | 'connect' | 'tls' | 'send' | 'wait' | 'receive';
export const PHASES: readonly Phase[] = ['request', 'paused', 'delay', 'dns', 'connect', 'tls', 'send', 'wait', 'receive'];

export const PHASE_FIELD: Record<Phase, keyof Timings> = {
  request: 'requestMs', paused: 'pausedMs', delay: 'delayMs', dns: 'dnsMs', connect: 'connectMs', tls: 'tlsMs',
  send: 'sendMs', wait: 'waitMs', receive: 'receiveMs',
};

export const PHASE_LABEL: Record<Phase, string> = {
  request: 'Request from the app',
  paused: 'Paused at a breakpoint',
  delay: 'Added delay',
  dns: 'DNS lookup',
  connect: 'Connect',
  tls: 'TLS handshake',
  send: 'Send',
  wait: 'Waiting (TTFB)',
  receive: 'Content download',
};

export const PHASE_TITLE: Record<Phase, string> = {
  request: 'From the start of the exchange until the proxy had the whole request from the app (headers and body)',
  paused: 'Time held at breakpoints (request and response) — added by you, not the network',
  delay: 'Added by a mock delay, a throttle rule or the network profile — not the server',
  dns: 'Host name lookup for a new upstream connection',
  connect: 'TCP connect to the server (new connection)',
  tls: 'TLS handshake with the server (new connection)',
  send: 'Writing the request to the server',
  wait: 'Request written → first response byte (time to first byte)',
  receive: 'Response headers → last body byte',
};

/** Phases the tool added on purpose (rendered hatched, never mistaken for network time). */
export const ADDED_PHASES: ReadonlySet<Phase> = new Set(['paused', 'delay']);

export interface PhaseRow { phase: Phase; ms: number; offset: number }

/** True when the exchange carries at least one phase timing. */
export function hasTimings(ex: Pick<Exchange, 'timings'>): boolean {
  const t = ex.timings;
  if (!t) return false;
  return PHASES.some((p) => typeof t[PHASE_FIELD[p]] === 'number');
}

/** The phases present (absent fields are unknown and skipped — never guessed), with cumulative offsets in ms. */
export function phaseRows(t: Timings | undefined): PhaseRow[] {
  if (!t) return [];
  const rows: PhaseRow[] = [];
  let offset = 0;
  for (const phase of PHASES) {
    const v = t[PHASE_FIELD[phase]];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    rows.push({ phase, ms: v, offset });
    offset += v;
  }
  return rows;
}

export interface TimeRange { start: number; end: number }

/** End of an exchange on the time axis: startedAt + durationMs; still running → `now`. */
export function exchangeEnd(ex: Pick<Exchange, 'startedAt' | 'durationMs' | 'state'>, now: number): number {
  if (ex.durationMs !== undefined) return ex.startedAt + Math.max(0, ex.durationMs);
  return ex.state === 'pending' || isPaused(ex) ? Math.max(ex.startedAt, now) : ex.startedAt;
}

/**
 * The time span of some exchanges (the rows in view). Long-lived ones — WebSocket / SSE connections and exchanges held
 * at a breakpoint — only count with their start while still open, so one open socket doesn't squash every other bar
 * (their bars run to the right edge). undefined for an empty list.
 */
export function timeRange(list: readonly Pick<Exchange, 'startedAt' | 'durationMs' | 'state' | 'kind'>[], now: number): TimeRange | undefined {
  if (!list.length) return undefined;
  let start = Infinity;
  let end = -Infinity;
  for (const ex of list) {
    if (ex.startedAt < start) start = ex.startedAt;
    const open = ex.durationMs === undefined && (!!ex.kind || isPaused(ex));
    const e = open ? ex.startedAt : exchangeEnd(ex, now);
    if (e > end) end = e;
  }
  return { start, end: Math.max(end, start + 1) };
}

export interface Segment { phase: Phase | 'total' | 'other'; pct: number }
export interface BarGeometry {
  /** Bar start and width, % of the time range (clamped to 0–100; width at least MIN_BAR_PCT). */
  left: number;
  width: number;
  /** Segments, % of the bar width (sum ≤ 100). */
  segments: Segment[];
  /** Still running: the bar ends at `now`. */
  running: boolean;
}

export const MIN_BAR_PCT = 0.5;

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Where the waterfall bar of `ex` goes in `range`: left = offset / span, width = duration / span; phases split the
 * bar in proportion (the scale is max(total, sum of phases), so a rounding excess never overflows the bar);
 * time the phases don't cover becomes an `other` segment. No timings → one `total` segment.
 */
export function barGeometry(ex: Pick<Exchange, 'startedAt' | 'durationMs' | 'state' | 'timings'>, range: TimeRange, now: number): BarGeometry {
  const span = Math.max(1, range.end - range.start);
  const end = exchangeEnd(ex, now);
  const running = ex.durationMs === undefined && end > ex.startedAt;
  let left = ((ex.startedAt - range.start) / span) * 100;
  let width = ((end - ex.startedAt) / span) * 100;
  left = Math.max(0, Math.min(100, left));
  width = Math.max(MIN_BAR_PCT, Math.min(100 - left, width));
  if (left + width > 100) left = Math.max(0, 100 - width);

  const rows = phaseRows(ex.timings);
  const total = ex.durationMs ?? Math.max(0, end - ex.startedAt);
  let segments: Segment[];
  if (!rows.length) {
    segments = [{ phase: 'total', pct: 100 }];
  } else {
    const sum = rows.reduce((n, r) => n + r.ms, 0);
    const scale = Math.max(total, sum, 1);
    segments = rows.filter((r) => r.ms > 0).map((r) => ({ phase: r.phase, pct: round((r.ms / scale) * 100) }));
    if (total > sum) segments.push({ phase: 'other', pct: round(((total - sum) / scale) * 100) });
    if (!segments.length) segments = [{ phase: 'total', pct: 100 }];
  }
  return { left: round(left), width: round(width), segments, running };
}

/** Multi-line tooltip: one line per known phase, "reused connection", and the total. */
export function timingTooltip(ex: Pick<Exchange, 'durationMs' | 'timings' | 'state'>): string {
  const lines: string[] = [];
  for (const r of phaseRows(ex.timings)) lines.push(`${PHASE_LABEL[r.phase]}: ${formatDuration(r.ms)}`);
  if (ex.timings?.reused) lines.push('Reused connection (no DNS / connect / TLS)');
  if (ex.durationMs !== undefined) lines.push(`Total: ${formatDuration(ex.durationMs)}`);
  else if (ex.state === 'pending' || isPaused(ex)) lines.push('In progress…');
  return lines.join('\n');
}

/** CSS class of a segment / swatch. */
export const phaseClass = (p: Segment['phase']): string => `ph-${p}`;
