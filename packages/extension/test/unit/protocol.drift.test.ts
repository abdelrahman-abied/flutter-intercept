// QUALITY-1 Q0: packages/extension/src/ui/protocol.ts mirrors packages/webview/src/protocol.ts (the host can't import
// the webview's source: different rootDir). Every exported type must exist in both with the same members / union arms.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '..', '..', '..', '..');

/** Exported type name → sorted member names (interfaces, object literals) or union arm texts (`type: '…'` tags). */
function shapes(file: string): Map<string, string[]> {
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out = new Map<string, string[]>();
  const members = (node: ts.Node): string[] => {
    const names: string[] = [];
    node.forEachChild(function walk(n) {
      if ((ts.isPropertySignature(n) || ts.isMethodSignature(n)) && n.name) {
        // Literal-typed members (`type: 'decodeGrpc'`) carry their value: the union arms of HostMsg / ViewMsg.
        const lit = ts.isPropertySignature(n) && n.type && ts.isLiteralTypeNode(n.type) ? `=${n.type.getText(src)}` : '';
        names.push(`${n.name.getText(src)}${n.questionToken ? '?' : ''}${lit}`);
        if (ts.isPropertySignature(n) && n.type && !lit) n.type.forEachChild(walk);
      }
      else if (ts.isLiteralTypeNode(n)) names.push(n.getText(src));
      else n.forEachChild(walk);
    });
    return names.sort();
  };
  for (const st of src.statements) {
    if (!ts.isInterfaceDeclaration(st) && !ts.isTypeAliasDeclaration(st)) continue;
    if (!(ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export)) continue;
    out.set(st.name.text, members(st));
  }
  return out;
}

describe('protocol.ts copies (webview ↔ extension host)', () => {
  it('declare the same exported types with the same members', () => {
    const web = shapes(path.join(repo, 'packages', 'webview', 'src', 'protocol.ts'));
    const host = shapes(path.join(repo, 'packages', 'extension', 'src', 'ui', 'protocol.ts'));
    expect(web.size).toBeGreaterThan(10); // the parse found the declarations (never passes vacuously)
    expect(web.get('HostMsg')?.length).toBeGreaterThan(10);
    for (const [name, m] of web) {
      expect(host.has(name), `${name} missing in the extension copy`).toBe(true);
      expect(host.get(name), name).toEqual(m);
    }
  });
});
