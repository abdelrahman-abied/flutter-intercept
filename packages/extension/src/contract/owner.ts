/**
 * Links wire models parsed from a `*.g.dart` to their `part of` owner (CONTRACTS §10.3): the line of
 * `class User`, the line/column of each field's declaration (for diagnostics), and the real names of
 * positional constructor arguments. Pure; never throws.
 *
 * Linear in the owner's size (REVIEW-4 #5): the owner is tokenized once, brackets are matched with one
 * stack pass, and classes, redirect factories (`= Circle;`) and declarations are indexed in one forward
 * scan; each model / field lookup is then a map hit plus a binary search.
 */
import { columnOf, lineIndex, Tok, tokenize } from './dart';
import type { XModel } from './generated';

export interface LinkedModel extends XModel {
  /** dartName → 0-based column of the declaration in sourceFile. */
  fieldColumns?: Record<string, number>;
}

interface Scope {
  from: number; // token index (inclusive)
  to: number; // token index (exclusive)
  line: number;
  /** Token index of a constructor's `(` (positional parameter names), if any. */
  ctorParen?: number;
}

const OPENERS = new Set(['(', '[', '{', '?[']);
const CLOSERS = new Set([')', ']', '}']);
const DECL_NEXT = new Set([';', ',', ')', '}', '=']);
const NOT_TYPE = new Set(['this', 'super', 'get', 'set', 'return', 'new', 'const', 'final', 'var', 'late', 'required', 'static', 'covariant']);

/** Everything the linker needs from one owner file, built in O(tokens). */
export class OwnerIndex {
  readonly toks: Tok[];
  /** match[i] = index of the bracket closing/opening the one at i (or -1). */
  private readonly match: Int32Array;
  private readonly classes = new Map<string, Scope>();
  private readonly redirects = new Map<string, Scope>();
  /** name → token indexes of typed declarations (`String email;`), ascending. */
  private readonly typedDecls = new Map<string, number[]>();
  /** name → token indexes of untyped declarations (`final email;`), ascending. */
  private readonly keywordDecls = new Map<string, number[]>();
  readonly lineOf: (pos: number) => number;

  constructor(readonly text: string) {
    this.toks = tokenize(text);
    this.lineOf = lineIndex(text);
    const toks = this.toks;
    const n = toks.length;
    this.match = new Int32Array(n).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = toks[i];
      if (t.k !== 'punct') continue;
      if (OPENERS.has(t.v)) stack.push(i);
      else if (CLOSERS.has(t.v) && stack.length) {
        const o = stack.pop()!;
        this.match[o] = i;
        this.match[i] = o;
      }
    }
    for (let i = 0; i < n; i++) {
      const t = toks[i];
      if (t.k !== 'id') continue;
      // class Name … {
      if (t.v === 'class' && toks[i + 1]?.k === 'id' && !this.classes.has(toks[i + 1].v)) {
        let j = i + 2;
        const limit = Math.min(n, i + 300);
        while (j < limit && !(toks[j].k === 'punct' && (toks[j].v === '{' || toks[j].v === ';'))) j++;
        if (toks[j]?.v === '{' && this.match[j] > j) {
          this.classes.set(toks[i + 1].v, { from: j + 1, to: this.match[j], line: this.lineOf(t.pos) });
        }
      }
      // `) = Name;` (freezed redirect factory)
      if (i >= 2 && toks[i - 1].v === '=' && toks[i - 2].v === ')' && (toks[i + 1]?.v === ';' || toks[i + 1]?.v === '<')) {
        const open = this.match[i - 2];
        if (open >= 0 && open < i - 2 && !this.redirects.has(t.v)) {
          this.redirects.set(t.v, { from: open + 1, to: i - 2, line: this.lineOf(toks[open].pos), ctorParen: open });
        }
      }
      // declarations
      const prev = toks[i - 1];
      const next = toks[i + 1];
      if (!prev || !next || prev.v === '.' || prev.v === '?.' || !DECL_NEXT.has(next.v)) continue;
      const typed = (prev.k === 'id' && !NOT_TYPE.has(prev.v)) || prev.v === '>' || prev.v === '?';
      const keyword = prev.v === 'final' || prev.v === 'var' || prev.v === 'late';
      const map = typed ? this.typedDecls : keyword ? this.keywordDecls : undefined;
      if (!map) continue;
      const list = map.get(t.v);
      if (list) list.push(i);
      else map.set(t.v, [i]);
    }
  }

  /** The class body (with its unnamed constructor) or the redirect factory's params for `name`. */
  scope(name: string): Scope | undefined {
    const cls = this.classes.get(name);
    if (cls) {
      if (cls.ctorParen === undefined) cls.ctorParen = this.ctorOf(name, cls) ?? -1;
      return cls;
    }
    return this.redirects.get(name);
  }

  /** `Name(` at the class body's top level, not `.Name(` / `factory Name(` / `new Name(`. O(body). */
  private ctorOf(name: string, cls: Scope): number | undefined {
    const toks = this.toks;
    for (let k = cls.from; k < cls.to; k++) {
      const t = toks[k];
      if (t.k === 'punct' && OPENERS.has(t.v)) {
        if (t.v === '(' && toks[k - 1]?.v === name && toks[k - 2]?.v !== '.' && toks[k - 2]?.v !== 'factory' && toks[k - 2]?.v !== 'new') return k;
        const m = this.match[k];
        if (m > k) k = m; // skip nested brackets: top level only
      }
    }
    return undefined;
  }

  /** First declaration of `name` inside [from, to), else the first in the file. */
  decl(name: string, scope: Scope): number | undefined {
    return (
      firstIn(this.typedDecls.get(name), scope.from, scope.to) ??
      firstIn(this.keywordDecls.get(name), scope.from, scope.to) ??
      this.typedDecls.get(name)?.[0] ??
      this.keywordDecls.get(name)?.[0]
    );
  }

  /** Positional parameter names inside `( … )` at `paren` (stops at `{` / `[`). */
  positionalNames(paren: number): string[] {
    const toks = this.toks;
    const close = this.match[paren] > paren ? this.match[paren] : toks.length - 1;
    const out: string[] = [];
    let last: string | undefined;
    let angle = 0;
    for (let k = paren + 1; k < close; k++) {
      const t = toks[k];
      if (t.k === 'punct' && OPENERS.has(t.v)) {
        if (t.v === '{' || t.v === '[') break;
        const m = this.match[k];
        if (m > k) k = m; // annotations' args, function-typed params
        continue;
      }
      if (t.v === '<') angle++;
      else if (t.v === '>') angle--;
      else if (angle === 0 && t.v === ',') {
        if (last) out.push(last);
        last = undefined;
      } else if (angle === 0 && t.v === '=') {
        // default value: skip to the next top-level comma
        while (k + 1 < close && toks[k + 1].v !== ',') {
          k++;
          const m = this.match[k];
          if (m > k) k = m;
        }
      } else if (angle === 0 && t.k === 'id') last = t.v;
    }
    if (last) out.push(last);
    return out;
  }
}

function firstIn(list: number[] | undefined, from: number, to: number): number | undefined {
  if (!list) return undefined;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length && list[lo] < to ? list[lo] : undefined;
}

/** Fills `sourceFile`, `sourceLine`, `fieldLines`, `fieldColumns` and positional `dartName`s in place. */
export function linkModelsToOwner(models: XModel[], ownerText: string, ownerFile: string): void {
  let idx: OwnerIndex;
  try {
    idx = new OwnerIndex(ownerText);
  } catch {
    return;
  }
  for (const m of models as LinkedModel[]) {
    try {
      const names = [m.name, m.constructed?.replace(/^_\$+/, '').replace(/^_+/, '')].filter((x): x is string => !!x);
      let scope: Scope | undefined;
      for (const n of names) {
        scope = idx.scope(n);
        if (scope) break;
      }
      if (!scope) continue;
      m.sourceFile = ownerFile;
      m.sourceLine = scope.line;
      if (scope.ctorParen !== undefined && scope.ctorParen >= 0 && m.fields.some((f) => f.positional !== undefined)) {
        const pos = idx.positionalNames(scope.ctorParen);
        for (const f of m.fields) if (f.positional !== undefined && pos[f.positional]) f.dartName = pos[f.positional];
      }
      const lines: Record<string, number> = {};
      const cols: Record<string, number> = {};
      for (const f of m.fields) {
        const k = idx.decl(f.dartName, scope);
        if (k === undefined) continue;
        lines[f.dartName] = idx.lineOf(idx.toks[k].pos);
        cols[f.dartName] = columnOf(ownerText, idx.toks[k].pos);
      }
      m.fieldLines = lines;
      m.fieldColumns = cols;
    } catch {
      // keep the model unlinked
    }
  }
}
