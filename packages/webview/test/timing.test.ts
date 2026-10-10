// CONTRACTS §13.2: waterfall geometry and timing text (pure).
import { describe, expect, it } from 'vitest';
import { barGeometry, exchangeEnd, hasTimings, MIN_BAR_PCT, phaseRows, timeRange, timingTooltip } from '../src/timing';
import { ex } from './fixtures';

const T0 = 1_000_000;

describe('phaseRows', () => {
  it('lists known phases in waterfall order with cumulative offsets, skipping absent ones', () => {
    const rows = phaseRows({ waitMs: 50, requestMs: 2, dnsMs: 10, receiveMs: 8, connectMs: 20 });
    expect(rows.map((r) => [r.phase, r.ms, r.offset])).toEqual([
      ['request', 2, 0], ['dns', 10, 2], ['connect', 20, 12], ['wait', 50, 32], ['receive', 8, 82],
    ]);
  });
  it('puts paused and delay right after the request, and keeps zero-length phases', () => {
    expect(phaseRows({ requestMs: 1, pausedMs: 3000, delayMs: 0, waitMs: 5 }).map((r) => r.phase)).toEqual(['request', 'paused', 'delay', 'wait']);
  });
  it('is empty without timings; ignores invalid numbers', () => {
    expect(phaseRows(undefined)).toEqual([]);
    expect(phaseRows({ dnsMs: -1, waitMs: Number.NaN })).toEqual([]);
    expect(hasTimings({ timings: { reused: true } })).toBe(false);
    expect(hasTimings({ timings: { waitMs: 0 } })).toBe(true);
    expect(hasTimings({})).toBe(false);
  });
});

describe('timeRange / exchangeEnd', () => {
  it('spans the earliest start to the latest end', () => {
    const r = timeRange([
      ex({ startedAt: T0 + 100, durationMs: 50 }),
      ex({ startedAt: T0, durationMs: 20 }),
      ex({ startedAt: T0 + 40, durationMs: 400 }),
    ], T0 + 10_000);
    expect(r).toEqual({ start: T0, end: T0 + 440 });
  });
  it('running exchanges end at now; finished ones without a duration end where they started', () => {
    expect(exchangeEnd({ startedAt: T0, state: 'pending' }, T0 + 300)).toBe(T0 + 300);
    expect(exchangeEnd({ startedAt: T0, state: 'paused-request' }, T0 + 300)).toBe(T0 + 300);
    expect(exchangeEnd({ startedAt: T0, state: 'error' }, T0 + 300)).toBe(T0);
  });
  it('open WebSocket / SSE connections and paused exchanges count with their start only', () => {
    const r = timeRange([
      ex({ startedAt: T0, durationMs: 100 }),
      ex({ startedAt: T0 + 50, kind: 'websocket', state: 'pending', status: 101, durationMs: undefined }),
      ex({ startedAt: T0 + 60, state: 'paused-response', durationMs: undefined }),
      ex({ startedAt: T0 + 70, state: 'pending', status: undefined, durationMs: undefined }),
    ], T0 + 500);
    expect(r).toEqual({ start: T0, end: T0 + 500 }); // the plain pending request still runs to now
    const sockets = timeRange([ex({ startedAt: T0, durationMs: 100 }), ex({ startedAt: T0 + 50, kind: 'sse', state: 'pending', durationMs: undefined })], T0 + 60_000);
    expect(sockets).toEqual({ start: T0, end: T0 + 100 });
    // A closed socket counts with its whole duration.
    expect(timeRange([ex({ startedAt: T0, kind: 'websocket', durationMs: 900 })], T0 + 5000)).toEqual({ start: T0, end: T0 + 900 });
  });
  it('never returns an empty span; undefined for no exchanges', () => {
    expect(timeRange([ex({ startedAt: T0, durationMs: 0 })], T0)).toEqual({ start: T0, end: T0 + 1 });
    expect(timeRange([], T0)).toBeUndefined();
  });
});

describe('barGeometry', () => {
  const range = { start: T0, end: T0 + 1000 };
  it('places the bar by offset and duration on the range', () => {
    const g = barGeometry(ex({ startedAt: T0 + 250, durationMs: 500 }), range, T0);
    expect(g.left).toBe(25);
    expect(g.width).toBe(50);
    expect(g.running).toBe(false);
    expect(g.segments).toEqual([{ phase: 'total', pct: 100 }]);
  });
  it('splits the bar by phase in proportion; uncovered time becomes "other"', () => {
    const g = barGeometry(ex({ startedAt: T0, durationMs: 200, timings: { requestMs: 10, dnsMs: 20, connectMs: 30, waitMs: 100, receiveMs: 20 } }), range, T0);
    expect(g.segments).toEqual([
      { phase: 'request', pct: 5 }, { phase: 'dns', pct: 10 }, { phase: 'connect', pct: 15 }, { phase: 'wait', pct: 50 },
      { phase: 'receive', pct: 10 }, { phase: 'other', pct: 10 },
    ]);
  });
  it('scales by the phase sum when it exceeds the total (rounding), never overflowing the bar', () => {
    const g = barGeometry(ex({ startedAt: T0, durationMs: 90, timings: { waitMs: 60, receiveMs: 40 } }), range, T0);
    expect(g.segments).toEqual([{ phase: 'wait', pct: 60 }, { phase: 'receive', pct: 40 }]);
  });
  it('skips zero-length phases in the bar', () => {
    const g = barGeometry(ex({ startedAt: T0, durationMs: 10, timings: { requestMs: 0, waitMs: 10 } }), range, T0);
    expect(g.segments).toEqual([{ phase: 'wait', pct: 100 }]);
  });
  it('gives tiny exchanges a minimum width and clamps to the range', () => {
    const tiny = barGeometry(ex({ startedAt: T0 + 1000, durationMs: 0 }), range, T0);
    expect(tiny.width).toBe(MIN_BAR_PCT);
    expect(tiny.left + tiny.width).toBeLessThanOrEqual(100);
    const before = barGeometry(ex({ startedAt: T0 - 500, durationMs: 2000 }), range, T0);
    expect(before.left).toBe(0);
    expect(before.width).toBe(100);
  });
  it('a running exchange reaches now', () => {
    const g = barGeometry(ex({ startedAt: T0 + 500, state: 'pending', status: undefined, durationMs: undefined }), range, T0 + 1000);
    expect(g).toMatchObject({ left: 50, width: 50, running: true });
  });
});

describe('timingTooltip', () => {
  it('names each phase, the reused connection and the total', () => {
    const t = timingTooltip(ex({ durationMs: 1234, timings: { requestMs: 1, pausedMs: 1000, reused: true, waitMs: 200, receiveMs: 33 } }));
    expect(t.split('\n')).toEqual([
      'Request from the app: 1 ms', 'Paused at a breakpoint: 1.00 s', 'Waiting (TTFB): 200 ms', 'Content download: 33 ms',
      'Reused connection (no DNS / connect / TLS)', 'Total: 1.23 s',
    ]);
  });
  it('total only without timings; "in progress" while running', () => {
    expect(timingTooltip(ex({ durationMs: 12 }))).toBe('Total: 12 ms');
    expect(timingTooltip(ex({ state: 'pending', durationMs: undefined }))).toBe('In progress…');
  });
});
