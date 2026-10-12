// PERF-1 #1: activation must never evaluate the proxy's main index (it loads mockttp: ~50 ms and ~8 MB). A static
// import graph from src/extension.ts: no runtime (non-type) import of '@flutter-intercept/proxy' anywhere on it; the
// proxy itself is loaded lazily (`require` inside the factory) when the first session starts.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../src');

/** Runtime module specifiers of a file's top-level imports / re-exports (type-only ones skipped). */
function runtimeImports(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      if (c?.isTypeOnly) continue;
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : undefined;
      const onlyTypes = !!c && !c.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly);
      if (!onlyTypes) out.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      const named = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : undefined;
      if (!(named && named.length && named.every((e) => e.isTypeOnly))) out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

function resolveLocal(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(c)) return c;
  return undefined;
}

describe('activation import graph (PERF-1 #1)', () => {
  it("never imports '@flutter-intercept/proxy' (main index) at runtime; subpaths only", () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue = [path.join(SRC, 'extension.ts')];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of runtimeImports(f)) {
        if (spec === '@flutter-intercept/proxy') offenders.push(path.relative(SRC, f));
        if (spec.startsWith('.')) {
          const r = resolveLocal(f, spec);
          if (r) queue.push(r);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(50); // the walk really covered the host
    expect(offenders).toEqual([]);
  });
});
