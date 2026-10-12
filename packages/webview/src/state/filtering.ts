/** Traffic list filtering (the filter language lives in ../filter). Split out of ../state.ts (QUALITY-1 Q6). */
import { matchesFilter, parseFilter } from '../filter';
import type { ContractSummary, Exchange } from '../protocol';
import { isPaused, statusClassOf } from '../util';
import type { Filters, State } from './core';

// ---------------------------------------------------------------- filtering

export function hasActiveFilters(f: Filters): boolean {
  return !!f.text.trim() || !!f.method || f.statusClasses.length > 0 || f.pausedOnly;
}

/**
 * The text box speaks the filter language in ./filter (free words match the URL, m: s: t: body: h: state:
 * src:, -negation); it is AND-ed with the method / status-class / paused-only controls.
 */
export function filterExchanges(exchanges: Exchange[], f: Filters, contracts?: Record<string, ContractSummary>): Exchange[] {
  const parsed = parseFilter(f.text);
  // Browser-internal traffic is hidden unless the toggle is on or the filter asks for it (`browser:`).
  const hideBrowser = !f.showBrowser && !parsed.keys.has('browser');
  if (!hasActiveFilters(f) && !(hideBrowser && exchanges.some(isBrowserInternal))) return exchanges;
  const method = f.method.toUpperCase();
  return exchanges.filter((e) => {
    if (hideBrowser && e.browserInternal) return false;
    if (f.pausedOnly && !isPaused(e)) return false;
    if (method && e.method.toUpperCase() !== method) return false;
    if (f.statusClasses.length) {
      const c = statusClassOf(e);
      if (!c || !f.statusClasses.includes(c)) return false;
    }
    return parsed.empty || matchesFilter(e, parsed, { contracts });
  });
}

const isBrowserInternal = (e: Exchange) => !!e.browserInternal;

/** How many browser-internal exchanges the list hides right now (0 when the toggle or a `browser:` token shows them). */
export function hiddenBrowserCount(exchanges: Exchange[], f: Filters): number {
  if (f.showBrowser || parseFilter(f.text).keys.has('browser')) return 0;
  let n = 0;
  for (const e of exchanges) if (e.browserInternal) n++;
  return n;
}

export function findExchange(state: Pick<State, 'exchanges'>, id: string): Exchange | undefined {
  for (let k = state.exchanges.length - 1; k >= 0; k--) if (state.exchanges[k].id === id) return state.exchanges[k];
  return undefined;
}

export function pausedCount(exchanges: Exchange[]): number {
  let n = 0;
  for (const e of exchanges) if (isPaused(e)) n++;
  return n;
}
