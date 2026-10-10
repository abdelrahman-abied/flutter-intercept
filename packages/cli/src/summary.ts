/** The summary printed after a run: traffic by route, then the assertions and the files written. */
import type { Exchange } from '@flutter-intercept/proxy';
import type { AssertionResult } from './assertions';

export const MAX_ROUTE_ROWS = 40;

function routeKey(e: Exchange, view: (url: string) => string): string {
  let shown = view(e.url);
  try {
    const u = new URL(shown);
    shown = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // keep as is
  }
  return `${e.method.toUpperCase()} ${shown}`;
}

function outcome(e: Exchange): string {
  if (e.status !== undefined) return e.state === 'mocked' ? `${e.status}*` : String(e.status);
  return e.state;
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Rows of `[cells]` as an aligned text table (first row = header). */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
  const out = [line(rows[0]), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows.slice(1)) out.push(line(r));
  return out.join('\n');
}

/** Traffic grouped by method + URL without query: count, statuses (`*` = answered by a rule / replay), slowest. */
export function trafficTable(exchanges: Exchange[], opts: { maxRows?: number; urlView?: (url: string) => string } = {}): string {
  const maxRows = opts.maxRows ?? MAX_ROUTE_ROWS;
  const view = opts.urlView ?? ((u: string) => u);
  if (!exchanges.length) return 'No requests went through the proxy.';
  const groups = new Map<string, { n: number; outcomes: Map<string, number>; maxMs?: number }>();
  for (const e of [...exchanges].sort((a, b) => a.startedAt - b.startedAt)) {
    const k = routeKey(e, view);
    const g = groups.get(k) ?? { n: 0, outcomes: new Map<string, number>() };
    g.n++;
    const o = outcome(e);
    g.outcomes.set(o, (g.outcomes.get(o) ?? 0) + 1);
    if (e.durationMs !== undefined) g.maxMs = Math.max(g.maxMs ?? 0, e.durationMs);
    groups.set(k, g);
  }
  const rows: string[][] = [['REQUESTS', 'STATUS', 'MAX MS', 'ROUTE']];
  let shown = 0;
  for (const [k, g] of groups) {
    if (shown++ >= maxRows) break;
    const statuses = [...g.outcomes].map(([o, n]) => (n > 1 ? `${o}×${n}` : o)).join(' ');
    rows.push([String(g.n), cut(statuses, 30), g.maxMs !== undefined ? String(Math.round(g.maxMs)) : '-', cut(k, 100)]);
  }
  const more = groups.size > maxRows ? `\n… and ${groups.size - maxRows} more routes` : '';
  const failed = exchanges.filter((e) => e.state === 'error' || e.state === 'aborted' || (e.status !== undefined && e.status >= 500)).length;
  const mocked = exchanges.filter((e) => e.state === 'mocked' || e.state === 'blocked').length;
  const totals = `${exchanges.length} request(s), ${groups.size} route(s)${mocked ? `, ${mocked} answered by rules / replay` : ''}${failed ? `, ${failed} failed (5xx / error)` : ''}`;
  return `${table(rows)}${more}\n${totals}`;
}

export function assertionsTable(results: AssertionResult[]): string {
  const rows: string[][] = [['RESULT', 'MATCHED', 'ASSERTION']];
  for (const r of results) rows.push([r.pass ? 'PASS' : r.error ? 'ERROR' : 'FAIL', String(r.matched), cut(r.name, 100)]);
  const lines = [table(rows)];
  for (const r of results) {
    if (r.pass) continue;
    lines.push(`  ${r.name}:`);
    for (const f of r.failures.slice(0, 10)) lines.push(`    - ${f}`);
    if (r.failures.length > 10) lines.push(`    - … ${r.failures.length - 10} more`);
  }
  const passed = results.filter((r) => r.pass).length;
  lines.push(`${passed}/${results.length} assertion(s) passed`);
  return lines.join('\n');
}
