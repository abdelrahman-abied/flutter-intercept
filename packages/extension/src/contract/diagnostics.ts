/**
 * Contract violations → VS Code diagnostics on the model field's line (CONTRACTS §10.3), in a
 * DiagnosticCollection named "Flutter Intercept contract". One diagnostic per field and problem: the
 * same violation in many responses is merged (latest message, "seen in N responses"). `aggregate`
 * is pure; the class is the thin vscode layer (flushes are batched).
 */
import * as vscode from 'vscode';
import type { XViolation } from './check';

export const COLLECTION_NAME = 'Flutter Intercept contract';

export interface AggregatedDiagnostic {
  line: number; // 1-based
  column?: number; // 0-based
  length?: number;
  severity: 'error' | 'warning';
  message: string;
  responses: number;
}

/** Groups violations of every exchange by file, merging repeats of the same field problem. */
export function aggregate(byExchange: Map<string, XViolation[]>): Map<string, AggregatedDiagnostic[]> {
  const groups = new Map<string, { file: string; d: AggregatedDiagnostic; ids: Set<string> }>();
  for (const [id, violations] of byExchange) {
    for (const v of violations) {
      if (!v.file || !v.line) continue;
      const kind = v.actual.replace(/ .*/, '');
      const key = `${v.file}\0${v.line}\0${v.model}\0${v.field}\0${v.severity}\0${kind}\0${v.path.replace(/\[\d+\]/g, '[]').replace(/\['[^']*'\]$/, '[*]')}`;
      const g = groups.get(key);
      const d: AggregatedDiagnostic = {
        line: v.line,
        column: v.column,
        length: v.column !== undefined && v.field ? v.field.length : undefined,
        severity: v.severity,
        message: v.message,
        responses: 1,
      };
      if (g) {
        g.ids.add(id);
        g.d = { ...d, responses: g.ids.size }; // later exchanges win the message
      } else groups.set(key, { file: v.file, d, ids: new Set([id]) });
    }
  }
  const out = new Map<string, AggregatedDiagnostic[]>();
  for (const { file, d } of groups.values()) {
    const list = out.get(file) ?? [];
    list.push(d);
    out.set(file, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.line - b.line || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return out;
}

export class ContractDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly byExchange = new Map<string, XViolation[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(collection?: vscode.DiagnosticCollection, private readonly delayMs = 150) {
    this.collection = collection ?? vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
  }

  /** The violations of one exchange (an empty list removes it). */
  set(exchangeId: string, violations: XViolation[]): void {
    const had = this.byExchange.has(exchangeId);
    this.byExchange.delete(exchangeId); // re-insert: latest last
    if (violations.length) this.byExchange.set(exchangeId, violations);
    if (had || violations.length) this.schedule();
  }

  delete(ids: string[]): void {
    let changed = false;
    for (const id of ids) changed = this.byExchange.delete(id) || changed;
    if (changed) this.schedule();
  }

  clear(): void {
    this.byExchange.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.collection.clear();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const files = aggregate(this.byExchange);
    this.collection.clear();
    for (const [file, list] of files) {
      const diags = list.map((d) => {
        const line = Math.max(0, d.line - 1);
        const start = d.column ?? 0;
        const end = d.length ? start + d.length : 10_000; // clamped to the line by the editor
        const msg = d.responses > 1 ? `${d.message} — seen in ${d.responses} responses` : d.message;
        const diag = new vscode.Diagnostic(
          new vscode.Range(line, start, line, end),
          msg,
          d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        );
        diag.source = 'Flutter Intercept';
        return diag;
      });
      this.collection.set(vscode.Uri.file(file), diags);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.collection.dispose();
  }
}
