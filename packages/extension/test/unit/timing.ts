// QUALITY-1 Q8: timing checks that hold on a loaded machine. Budgets are best-of-N wall times, scaled by FI_TIME_SCALE
// (CI on slow runners: FI_TIME_SCALE=3); prefer structure (work counts, loop yields) and ratios over absolute times.

export const TIME_SCALE = Math.max(1, Number(process.env.FI_TIME_SCALE) || 1);

/** The fastest of `runs` runs of `fn`, in ms (each run awaited). */
export async function bestOf(fn: () => unknown, runs = 3): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Throws unless the best of `runs` runs of `fn` takes at most `budgetMs` × FI_TIME_SCALE. */
export async function expectWithin(fn: () => unknown, budgetMs: number, runs = 3): Promise<number> {
  const best = await bestOf(fn, runs);
  if (best > budgetMs * TIME_SCALE) throw new Error(`took ${best.toFixed(1)} ms (best of ${runs}), over the ${budgetMs * TIME_SCALE} ms budget`);
  return best;
}
