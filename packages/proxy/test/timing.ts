// QUALITY-1 Q8: timing checks that don't flake on a busy machine.
import { performance } from 'perf_hooks';

/** Multiplier for every time budget (set FI_TIME_SCALE=3 on slow / shared CI runners). */
export const TIME_SCALE = Math.max(1, Number(process.env.FI_TIME_SCALE) || 1);

/** A budget in ms, scaled by FI_TIME_SCALE. */
export const budget = (ms: number): number => ms * TIME_SCALE;

/** The fastest of `n` runs of a synchronous `fn` (ms): noise (GC, other processes) only ever adds time. */
export function bestOfMs(fn: () => void, n = 3): number {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Event-loop busy time (ms) of the best of `n` runs of an async `fn` (the loop's active time, not wall time). */
export async function bestActiveMs(fn: () => Promise<unknown>, n = 3): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const before = performance.eventLoopUtilization();
    await fn();
    best = Math.min(best, performance.eventLoopUtilization(before).active);
  }
  return best;
}
