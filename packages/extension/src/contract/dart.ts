/**
 * A small, forgiving Dart scanner (CONTRACTS §10.3): a tokenizer plus an expression / type / statement
 * parser for the subset of Dart that json_serializable, freezed, Retrofit and Chopper generate. Pure.
 *
 * Never throws to callers: `tokenize` always returns tokens, and the parse entry points return
 * `undefined` (or an `unknown` node) on anything they do not understand.
 */

export type TokKind = 'id' | 'str' | 'num' | 'punct' | 'eof';

export interface Tok {
  k: TokKind;
  /** Identifier name / punctuation text / number text / decoded string value. */
  v: string;
  /** Offset of the token's first character in the source. */
  pos: number;
  /** Offset just past the token. */
  end: number;
}

const PUNCT3 = ['??=', '...', '>>=', '<<=', '~/='];
const PUNCT2 = ['=>', '??', '?.', '..', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '?[', '~/', '<<'];

const ID_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUM_RE = /0[xX][0-9A-Fa-f_]*|(?:[0-9][0-9_]*)?(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9]+)?/y;
const PUNCT3_SET = new Set(PUNCT3);
const PUNCT2_SET = new Set(PUNCT2);

/** A-Z a-z _ $ */
const isIdStartCode = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
const isDigit = (c: number) => c >= 48 && c <= 57;

const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', $: '$' };

/** Tokenizes Dart source. Comments are dropped; `>>` is always two `>` tokens (generic closers). */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 0;
      while (i < n) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      continue;
    }
    const start = i;
    // Strings: optional r prefix, ' or ", single or triple quoted.
    const raw = (c === 'r' || c === 'R') && (src[i + 1] === "'" || src[i + 1] === '"');
    if (raw || c === "'" || c === '"') {
      if (raw) i++;
      const q = src[i];
      const triple = src[i + 1] === q && src[i + 2] === q;
      const close = triple ? q + q + q : q;
      i += close.length;
      let val = '';
      while (i < n) {
        if (src.startsWith(close, i)) {
          i += close.length;
          break;
        }
        const ch = src[i];
        if (!triple && ch === '\n') break; // unterminated: stop at the line end
        if (!raw && ch === '\\' && i + 1 < n) {
          const e = src[i + 1];
          if (e === 'u') {
            const m = /^u\{([0-9A-Fa-f]{1,6})\}|^u([0-9A-Fa-f]{4})/.exec(src.slice(i + 1, i + 10));
            if (m) {
              const cp = parseInt(m[1] ?? m[2], 16);
              val += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
              i += 1 + m[0].length;
              continue;
            }
          }
          if (e === 'x') {
            const m = /^x([0-9A-Fa-f]{2})/.exec(src.slice(i + 1, i + 4));
            if (m) {
              val += String.fromCharCode(parseInt(m[1], 16));
              i += 4;
              continue;
            }
          }
          val += ESC[e] ?? e;
          i += 2;
          continue;
        }
        if (!raw && ch === '$' && src[i + 1] === '{') {
          // Interpolation: keep it verbatim, skipping balanced braces.
          let depth = 0;
          const s0 = i;
          i++;
          while (i < n) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
              depth--;
              if (depth === 0) {
                i++;
                break;
              }
            }
            i++;
          }
          val += src.slice(s0, i);
          continue;
        }
        val += ch;
        i++;
      }
      out.push({ k: 'str', v: val, pos: start, end: i });
      continue;
    }
    const code = src.charCodeAt(i);
    if (isIdStartCode(code)) {
      ID_RE.lastIndex = i;
      ID_RE.test(src);
      i = ID_RE.lastIndex;
      out.push({ k: 'id', v: src.slice(start, i), pos: start, end: i });
      continue;
    }
    if (isDigit(code) || (code === 46 && isDigit(src.charCodeAt(i + 1)))) {
      NUM_RE.lastIndex = i;
      NUM_RE.test(src);
      i = Math.max(i + 1, NUM_RE.lastIndex);
      out.push({ k: 'num', v: src.slice(start, i), pos: start, end: i });
      continue;
    }
    if (code > 127) {
      // non-ASCII outside strings/comments (identifier letters, stray characters): one punct token each
      i++;
      out.push({ k: 'punct', v: c, pos: start, end: i });
      continue;
    }
    const three = src.substr(i, 3);
    const two = three.slice(0, 2);
    const p = PUNCT3_SET.has(three) ? three : PUNCT2_SET.has(two) ? two : c;
    i += p.length;
    out.push({ k: 'punct', v: p, pos: start, end: i });
  }
  out.push({ k: 'eof', v: '', pos: n, end: n });
  return out;
}

// ---------------------------------------------------------------------------------------------
// AST

export interface TypeNode {
  name: string; // "List", "Map", "String", "dynamic", "prefix.Name"; "?" for anything we can't read
  args: TypeNode[];
  nullable: boolean;
}

export interface Arg {
  name?: string;
  value: Node;
}

export type Node =
  | { k: 'id'; name: string }
  | { k: 'str'; v: string }
  | { k: 'num'; v: string }
  | { k: 'lit'; v: 'true' | 'false' | 'null' }
  | { k: 'member'; obj: Node; name: string; nullAware: boolean }
  | { k: 'call'; callee: Node; typeArgs?: TypeNode[]; args: Arg[] }
  | { k: 'index'; obj: Node; index: Node; nullAware: boolean }
  | { k: 'as'; expr: Node; type: TypeNode }
  | { k: 'is'; expr: Node; type: TypeNode; not: boolean }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node }
  | { k: 'unary'; op: string; e: Node }
  | { k: 'bang'; e: Node }
  | { k: 'fn'; params: string[]; body: Node | Block }
  | { k: 'cascade'; target: Node; sections: { name: string; value?: Node; call?: Arg[] }[] }
  | { k: 'list'; items: Node[]; typeArgs?: TypeNode[] }
  | { k: 'map'; entries: { key: Node; value: Node }[]; typeArgs?: TypeNode[] }
  | { k: 'assign'; target: Node; op: string; value: Node }
  | { k: 'unknown' };

export type Stmt =
  | { k: 'return'; e?: Node }
  | { k: 'decl'; name: string; e?: Node }
  | { k: 'expr'; e: Node }
  | { k: 'block'; body: Block }
  | { k: 'other' };

export interface Block {
  k: 'block';
  stmts: Stmt[];
}

class ParseError extends Error {}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Recursive-descent parser over a token array. All methods may throw ParseError; use the wrappers. */
export class Parser {
  i: number;
  private depth = 0;
  /** > 0 while reading a cascade section's value: `..a = x ? y : z..b = w` must not nest `..b`. */
  private noCascade = 0;

  constructor(readonly toks: Tok[], start = 0) {
    this.i = start;
  }

  get t(): Tok {
    return this.toks[this.i] ?? this.toks[this.toks.length - 1];
  }

  peek(o = 1): Tok {
    return this.toks[this.i + o] ?? this.toks[this.toks.length - 1];
  }

  is(v: string, o = 0): boolean {
    const t = this.peek(o);
    return (t.k === 'punct' || t.k === 'id') && t.v === v;
  }

  eat(v: string): boolean {
    if (this.is(v)) {
      this.i++;
      return true;
    }
    return false;
  }

  expect(v: string): void {
    if (!this.eat(v)) throw new ParseError(`expected ${v} at ${this.t.pos}, got ${this.t.v}`);
  }

  /** Index of the token closing the bracket at `at` (or the eof index). */
  matching(at: number): number {
    const open = this.toks[at]?.v;
    const close = OPEN[open];
    if (!close) return at;
    let d = 0;
    for (let j = at; j < this.toks.length; j++) {
      const tk = this.toks[j];
      if (tk.k !== 'punct') continue;
      if (tk.v === '(' || tk.v === '[' || tk.v === '{' || tk.v === '?[') d++;
      else if (tk.v === ')' || tk.v === ']' || tk.v === '}') {
        d--;
        if (d === 0) return j;
      }
    }
    return this.toks.length - 1;
  }

  // -- types ---------------------------------------------------------------------------------

  /** Tries to read a type at the cursor; restores the cursor and returns undefined when it can't. */
  tryType(): TypeNode | undefined {
    const save = this.i;
    try {
      return this.type();
    } catch {
      this.i = save;
      return undefined;
    }
  }

  type(): TypeNode {
    if (this.t.k !== 'id') {
      if (this.is('(')) {
        // record type: skip it
        this.i = this.matching(this.i) + 1;
        return { name: '?', args: [], nullable: this.eat('?') };
      }
      throw new ParseError('type expected');
    }
    let name = this.t.v;
    this.i++;
    while (this.is('.') && this.peek(1).k === 'id') {
      name += `.${this.peek(1).v}`;
      this.i += 2;
    }
    const args: TypeNode[] = [];
    if (this.is('<')) {
      this.i++;
      args.push(this.type());
      while (this.eat(',')) args.push(this.type());
      this.expect('>');
    }
    if (this.is('Function')) {
      // `T Function(Object? json)`: a function type
      this.i++;
      if (this.is('(')) this.i = this.matching(this.i) + 1;
      return { name: 'Function', args: [], nullable: this.eat('?') };
    }
    const nullable = this.eat('?');
    return { name, args, nullable };
  }

  /** `<A, B>` type arguments; restores and returns undefined when it isn't one. */
  tryTypeArgs(): TypeNode[] | undefined {
    if (!this.is('<')) return undefined;
    const save = this.i;
    try {
      this.i++;
      const args = [this.type()];
      while (this.eat(',')) args.push(this.type());
      this.expect('>');
      return args;
    } catch {
      this.i = save;
      return undefined;
    }
  }

  // -- expressions ---------------------------------------------------------------------------

  expr(): Node {
    if (++this.depth > 200) throw new ParseError('too deep');
    try {
      return this.assignment();
    } finally {
      this.depth--;
    }
  }

  private assignment(): Node {
    const lhs = this.cascade();
    const t = this.t;
    if (t.k === 'punct' && (t.v === '=' || t.v === '??=' || t.v === '+=' || t.v === '-=')) {
      this.i++;
      return { k: 'assign', target: lhs, op: t.v, value: this.expr() };
    }
    return lhs;
  }

  private cascade(): Node {
    const target = this.conditional();
    if (this.noCascade > 0 || !this.is('..')) return target;
    const sections: { name: string; value?: Node; call?: Arg[] }[] = [];
    while (this.eat('..')) {
      if (this.t.k !== 'id') throw new ParseError('cascade name expected');
      let name = this.t.v;
      this.i++;
      let call: Arg[] | undefined;
      // `..a.b = x` / `..add(x)` — keep the first name, read the rest loosely
      for (;;) {
        if (this.is('.') && this.peek(1).k === 'id') {
          name += `.${this.peek(1).v}`;
          this.i += 2;
        } else if (this.is('(')) {
          call = this.args();
        } else if (this.is('[')) {
          this.i = this.matching(this.i) + 1;
        } else break;
      }
      let value: Node | undefined;
      if (this.eat('=')) {
        this.noCascade++;
        try {
          value = this.conditional();
        } finally {
          this.noCascade--;
        }
      }
      sections.push({ name, value, call });
    }
    return { k: 'cascade', target, sections };
  }

  private conditional(): Node {
    const c = this.ifNull();
    if (this.is('?')) {
      this.i++;
      const a = this.expr();
      this.expect(':');
      const b = this.expr();
      return { k: 'cond', c, a, b };
    }
    return c;
  }

  private ifNull(): Node {
    let l = this.logicOr();
    while (this.eat('??')) l = { k: 'bin', op: '??', l, r: this.logicOr() };
    return l;
  }

  private logicOr(): Node {
    let l = this.logicAnd();
    while (this.eat('||')) l = { k: 'bin', op: '||', l, r: this.logicAnd() };
    return l;
  }

  private logicAnd(): Node {
    let l = this.equality();
    while (this.eat('&&')) l = { k: 'bin', op: '&&', l, r: this.equality() };
    return l;
  }

  private equality(): Node {
    let l = this.relational();
    while (this.is('==') || this.is('!=')) {
      const op = this.t.v;
      this.i++;
      l = { k: 'bin', op, l, r: this.relational() };
    }
    return l;
  }

  private relational(): Node {
    let l = this.additive();
    for (;;) {
      if (this.is('as')) {
        this.i++;
        l = { k: 'as', expr: l, type: this.type() };
      } else if (this.is('is')) {
        this.i++;
        const not = this.eat('!');
        l = { k: 'is', expr: l, type: this.type(), not };
      } else if (this.is('<=') || this.is('>=')) {
        const op = this.t.v;
        this.i++;
        l = { k: 'bin', op, l, r: this.additive() };
      } else if ((this.is('<') || this.is('>')) && this.peek(1).k !== 'eof') {
        // Comparison (never a generic here: generics are consumed in postfix()).
        const op = this.t.v;
        const save = this.i;
        this.i++;
        try {
          l = { k: 'bin', op, l, r: this.additive() };
        } catch {
          this.i = save;
          return l;
        }
      } else return l;
    }
  }

  private additive(): Node {
    let l = this.multiplicative();
    while (this.is('+') || this.is('-')) {
      const op = this.t.v;
      this.i++;
      l = { k: 'bin', op, l, r: this.multiplicative() };
    }
    return l;
  }

  private multiplicative(): Node {
    let l = this.unary();
    while (this.is('*') || this.is('/') || this.is('%') || this.is('~/')) {
      const op = this.t.v;
      this.i++;
      l = { k: 'bin', op, l, r: this.unary() };
    }
    return l;
  }

  private unary(): Node {
    if (this.is('!') || this.is('-') || this.is('~')) {
      const op = this.t.v;
      this.i++;
      return { k: 'unary', op, e: this.unary() };
    }
    if (this.is('await') || this.is('new')) {
      this.i++;
      return this.unary();
    }
    if (this.is('const')) {
      this.i++;
      return this.unary();
    }
    return this.postfix(this.primary());
  }

  /** Runs `f` with cascades allowed again (inside brackets they nest normally). */
  private nested<T>(f: () => T): T {
    const saved = this.noCascade;
    this.noCascade = 0;
    try {
      return f();
    } finally {
      this.noCascade = saved;
    }
  }

  args(): Arg[] {
    return this.nested(() => this.argsInner());
  }

  private argsInner(): Arg[] {
    const close = this.matching(this.i);
    if (this.toks[close]?.v !== ')') throw new ParseError('unbalanced (');
    this.expect('(');
    const out: Arg[] = [];
    while (!this.is(')') && this.i < close) {
      let name: string | undefined;
      if (this.t.k === 'id' && this.is(':', 1)) {
        name = this.t.v;
        this.i += 2;
      }
      const start = this.i;
      let value: Node;
      try {
        value = this.expr();
        if (!this.is(',') && !this.is(')')) throw new ParseError('junk after argument');
      } catch {
        // One unreadable argument (switch expression, collection-if, …) must not lose the others:
        // skip to the next top-level `,` and keep it as unknown.
        this.i = start;
        while (this.i < close && !this.is(',')) {
          if (this.is('(') || this.is('[') || this.is('{') || this.is('?[')) this.i = this.matching(this.i);
          this.i++;
        }
        value = { k: 'unknown' };
      }
      out.push(name !== undefined ? { name, value } : { value });
      if (!this.eat(',')) break;
    }
    this.i = close;
    this.expect(')');
    return out;
  }

  private postfix(n: Node): Node {
    for (;;) {
      if (this.is('.') || this.is('?.')) {
        const nullAware = this.t.v === '?.';
        this.i++;
        if (this.t.k !== 'id') throw new ParseError('member name expected');
        n = { k: 'member', obj: n, name: this.t.v, nullAware };
        this.i++;
      } else if (this.is('(')) {
        n = { k: 'call', callee: n, args: this.args() };
      } else if (this.is('<') && (n.k === 'id' || n.k === 'member')) {
        const save = this.i;
        const typeArgs = this.tryTypeArgs();
        if (typeArgs && (this.is('(') || this.is('.'))) {
          if (this.is('(')) n = { k: 'call', callee: n, typeArgs, args: this.args() };
          else {
            // `Map<String, String>.from(...)`: fold type args into the callee name
            const base = n.k === 'id' ? n.name : 'member';
            n = { k: 'id', name: `${base}<${typeArgs.map(typeText).join(', ')}>` };
          }
        } else {
          this.i = save;
          return n;
        }
      } else if (this.is('[') || this.is('?[')) {
        const nullAware = this.t.v === '?[';
        this.i++;
        const index = this.nested(() => this.expr());
        this.expect(']');
        n = { k: 'index', obj: n, index, nullAware };
      } else if (this.is('!') && !this.is('=', 1)) {
        this.i++;
        n = { k: 'bang', e: n };
      } else return n;
    }
  }

  private primary(): Node {
    const t = this.t;
    if (t.k === 'str') {
      let v = t.v;
      this.i++;
      while (this.t.k === 'str') {
        v += this.t.v; // adjacent string literals
        this.i++;
      }
      return { k: 'str', v };
    }
    if (t.k === 'num') {
      this.i++;
      return { k: 'num', v: t.v };
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false' || t.v === 'null') {
        this.i++;
        return { k: 'lit', v: t.v };
      }
      // `(e) =>` handled below; a bare `e => …` never appears in Dart (params need parens)
      this.i++;
      return { k: 'id', name: t.v };
    }
    if (t.k === 'punct') {
      if (t.v === '(') {
        const close = this.matching(this.i);
        const after = this.toks[close + 1];
        if (after && after.k === 'punct' && (after.v === '=>' || after.v === '{')) return this.lambda(close);
        if (after && after.k === 'id' && (after.v === 'async' || after.v === 'sync')) return this.lambda(close);
        this.i++;
        const e = this.nested(() => this.expr());
        if (this.eat(',')) {
          // record literal: skip the rest
          this.i = close;
        }
        this.expect(')');
        return e;
      }
      if (t.v === '<') {
        const typeArgs = this.tryTypeArgs();
        if (!typeArgs) throw new ParseError('unexpected <');
        return this.collection(typeArgs);
      }
      if (t.v === '[' || t.v === '{') return this.collection(undefined);
    }
    throw new ParseError(`unexpected ${t.v || t.k} at ${t.pos}`);
  }

  private lambda(close: number): Node {
    const params: string[] = [];
    // last identifier of each top-level comma group, skipping `{`/`[` optional markers
    let last: string | undefined;
    let d = 0;
    for (let j = this.i + 1; j < close; j++) {
      const tk = this.toks[j];
      if (tk.k === 'punct' && (tk.v === '<' || tk.v === '(')) d++;
      else if (tk.k === 'punct' && (tk.v === '>' || tk.v === ')')) d--;
      else if (d === 0 && tk.k === 'punct' && tk.v === ',') {
        if (last) params.push(last);
        last = undefined;
      } else if (d === 0 && tk.k === 'id') last = tk.v;
    }
    if (last) params.push(last);
    this.i = close + 1;
    if (this.is('async') || this.is('sync')) {
      this.i++;
      this.eat('*');
    }
    if (this.eat('=>')) return { k: 'fn', params, body: this.expr() };
    return { k: 'fn', params, body: this.block() };
  }

  private collection(typeArgs: TypeNode[] | undefined): Node {
    return this.nested(() => this.collectionInner(typeArgs));
  }

  private collectionInner(typeArgs: TypeNode[] | undefined): Node {
    if (this.is('[')) {
      const close = this.matching(this.i);
      this.i++;
      const items: Node[] = [];
      try {
        while (!this.is(']')) {
          if (this.is('...') || this.is('if') || this.is('for')) throw new ParseError('collection control');
          items.push(this.expr());
          if (!this.eat(',')) break;
        }
        this.expect(']');
      } catch {
        this.i = close + 1;
        return { k: 'list', items: [], typeArgs };
      }
      return { k: 'list', items, typeArgs };
    }
    if (this.is('{')) {
      const close = this.matching(this.i);
      this.i++;
      const entries: { key: Node; value: Node }[] = [];
      try {
        while (!this.is('}')) {
          if (this.is('...') || this.is('if') || this.is('for')) throw new ParseError('collection control');
          const key = this.expr();
          this.expect(':');
          entries.push({ key, value: this.expr() });
          if (!this.eat(',')) break;
        }
        this.expect('}');
      } catch {
        this.i = close + 1;
        return { k: 'map', entries: [], typeArgs };
      }
      return { k: 'map', entries, typeArgs };
    }
    throw new ParseError('collection expected');
  }

  // -- statements ----------------------------------------------------------------------------

  block(): Block {
    return this.nested(() => this.blockInner());
  }

  private blockInner(): Block {
    const close = this.matching(this.i);
    this.expect('{');
    const stmts: Stmt[] = [];
    while (this.i < close && this.t.k !== 'eof') {
      const save = this.i;
      try {
        stmts.push(this.statement());
      } catch {
        this.i = save;
        this.skipStatement(close);
        stmts.push({ k: 'other' });
      }
      if (this.i === save) this.i++; // always progress
    }
    this.i = close + 1;
    return { k: 'block', stmts };
  }

  /** Skips to just past the next `;` at this level, or past a balanced `{…}` block, stopping at `limit`. */
  private skipStatement(limit: number): void {
    while (this.i < limit) {
      const tk = this.t;
      if (tk.k === 'punct' && (tk.v === '(' || tk.v === '[' || tk.v === '?[')) {
        this.i = this.matching(this.i) + 1;
        continue;
      }
      if (tk.k === 'punct' && tk.v === '{') {
        this.i = this.matching(this.i) + 1;
        if (!this.is(';') && !this.is('..') && !this.is(')')) return;
        continue;
      }
      this.i++;
      if (tk.k === 'punct' && tk.v === ';') return;
    }
  }

  private statement(): Stmt {
    if (this.is('{')) return { k: 'block', body: this.block() };
    if (this.eat(';')) return { k: 'other' };
    if (this.is('return')) {
      this.i++;
      if (this.eat(';')) return { k: 'return' };
      const e = this.expr();
      this.expect(';');
      return { k: 'return', e };
    }
    if (this.is('if') || this.is('for') || this.is('while') || this.is('try') || this.is('switch') || this.is('do')) {
      throw new ParseError('control flow');
    }
    // declaration: [late] (final|var|const) [Type] name [= e]; or Type name [= e];
    const save = this.i;
    this.eat('late');
    const hasKeyword = this.eat('final') || this.eat('var') || this.eat('const');
    if (hasKeyword || this.looksLikeTypedDecl()) {
      if (!(this.t.k === 'id' && (this.is('=', 1) || this.is(';', 1)))) this.type();
      if (this.t.k === 'id') {
        const name = this.t.v;
        this.i++;
        let e: Node | undefined;
        if (this.eat('=')) e = this.expr();
        this.expect(';');
        return { k: 'decl', name, e };
      }
    }
    this.i = save;
    const e = this.expr();
    this.expect(';');
    return { k: 'expr', e };
  }

  private looksLikeTypedDecl(): boolean {
    if (this.t.k !== 'id') return false;
    const save = this.i;
    const ty = this.tryType();
    const ok = !!ty && this.t.k === 'id' && (this.is('=', 1) || this.is(';', 1));
    this.i = save;
    return ok;
  }
}

/** `List<Item>` / `String?` text of a type node. */
export function typeText(t: TypeNode): string {
  return `${t.name}${t.args.length ? `<${t.args.map(typeText).join(', ')}>` : ''}${t.nullable ? '?' : ''}`;
}

/** Parses an expression starting at token `start`; undefined on failure. */
export function parseExprAt(toks: Tok[], start: number): { node: Node; next: number } | undefined {
  const p = new Parser(toks, start);
  try {
    const node = p.expr();
    return { node, next: p.i };
  } catch {
    return undefined;
  }
}

/** Parses a type at token `start`; undefined on failure. */
export function parseTypeAt(toks: Tok[], start: number): { type: TypeNode; next: number } | undefined {
  const p = new Parser(toks, start);
  const type = p.tryType();
  return type ? { type, next: p.i } : undefined;
}

/** 1-based line of a source offset, with a precomputed line-start table. */
export function lineIndex(src: string): (pos: number) => number {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 0-based column of a source offset. */
export function columnOf(src: string, pos: number): number {
  const nl = src.lastIndexOf('\n', pos - 1);
  return pos - (nl + 1);
}
