// CONTRACTS §17.5: reads one `.proto` file (proto2 / proto3 / editions subset) into unlinked declarations with
// fully-qualified names and protoc_plugin's Dart class names. Hand-written tokenizer and recursive descent:
// linear, bounded (same per-file budget as §16.8), never throws, plain-words problems with the file's label.

import type { ProtoScalar } from './types';

export interface ProtoTypeRef {
  /** A scalar keyword, or a type name as written (`Money`, `.pkg.Money`, `Outer.Inner`). */
  scalar?: ProtoScalar;
  name?: string;
}

export interface ProtoFieldDecl {
  number: number;
  /** JSON name (protoc's lowerCamelCase, or `json_name`). */
  name: string;
  type: ProtoTypeRef;
  map?: { key: ProtoScalar; value: ProtoTypeRef };
  repeated: boolean;
  required: boolean;
  /** `[packed = …]` / `features.repeated_field_encoding`, when given. */
  packed?: boolean;
  oneof?: string;
  line: number;
}

export interface ProtoMessageDecl {
  fq: string;
  dartClass: string;
  fields: ProtoFieldDecl[];
  line: number;
}

export interface ProtoEnumDecl {
  fq: string;
  dartClass: string;
  values: { name: string; number: number }[];
  line: number;
}

export interface ProtoMethodDecl {
  path: string;
  req: string;
  res: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  line: number;
}

export interface ParsedProto {
  path: string;
  label: string;
  syntax: 'proto2' | 'proto3' | 'editions';
  pkg: string;
  imports: string[];
  /** Messages and enums in protoc_plugin naming order. */
  messages: ProtoMessageDecl[];
  enums: ProtoEnumDecl[];
  methods: ProtoMethodDecl[];
  /** Whether repeated scalars are packed when the field doesn't say (proto3 / editions default, or a file feature). */
  packedByDefault: boolean;
  problems: string[];
}

export const MAX_PROTO_TOKENS = 2_000_000;
export const MAX_PROTO_MS = 200;
const MAX_FILE_PROBLEMS = 20;
const MAX_NESTING = 64;

const SCALARS = new Set<string>([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes',
]);
const MAP_KEYS = new Set<string>([
  'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string',
]);

/** protoc_plugin's names that a generated class can't take (`forbiddenTopLevelNames`). */
const FORBIDDEN_DART = [
  'List', 'Function', 'Map',
  'assert', 'bool', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'false', 'final', 'finally', 'for', 'if', 'in', 'int', 'is', 'new', 'null', 'rethrow', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'var', 'void', 'while', 'with',
];

export function isProtoFile(path: string): boolean {
  return typeof path === 'string' && /\.proto$/i.test(path);
}

/** protoc's ToJsonName: drop underscores, upper-case the letter after each. */
export function protoJsonName(name: string): string {
  let out = '';
  let up = false;
  for (const c of name) {
    if (c === '_') up = true;
    else if (up) {
      out += c.toUpperCase();
      up = false;
    } else out += c;
  }
  return out;
}

/** Oneof name as the Dart reader derives it from `Parent_OneofName`: lowerFirst(underscoresToCamelCase). */
export function oneofKey(name: string): string {
  const camel = name
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join('');
  return camel ? camel[0].toLowerCase() + camel.slice(1) : name;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

type K = 'id' | 'num' | 'str' | 'p' | 'eof';
interface T {
  k: K;
  v: string;
  line: number;
}

class TooComplex extends Error {}

function tokenizeProto(src: string, deadline: number): T[] | 'too complex' | { error: string; line: number } {
  const out: T[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let ticks = 0;
  while (i < n) {
    if ((++ticks & 4095) === 0 && Date.now() > deadline) return 'too complex';
    if (out.length > MAX_PROTO_TOKENS) return 'too complex';
    const c = src.charCodeAt(i);
    if (c === 10) {
      line++;
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11 || c === 0xfeff) {
      i++;
      continue;
    }
    if (c === 47 && src.charCodeAt(i + 1) === 47) {
      while (i < n && src.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (c === 47 && src.charCodeAt(i + 1) === 42) {
      const start = line;
      i += 2;
      while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) {
        if (src.charCodeAt(i) === 10) line++;
        i++;
      }
      if (i >= n) return { error: 'a /* comment is never closed', line: start };
      i += 2;
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      const s = i;
      i++;
      while (i < n) {
        const d = src.charCodeAt(i);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95 || (d >= 48 && d <= 57)) i++;
        else break;
      }
      out.push({ k: 'id', v: src.slice(s, i), line });
      continue;
    }
    if ((c >= 48 && c <= 57) || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      const s = i;
      i++;
      while (i < n) {
        const d = src.charCodeAt(i);
        const prev = src.charCodeAt(i - 1);
        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 46 || ((d === 43 || d === 45) && (prev === 101 || prev === 69))) i++;
        else break;
      }
      out.push({ k: 'num', v: src.slice(s, i), line });
      continue;
    }
    if (c === 34 || c === 39) {
      const start = line;
      let v = '';
      i++;
      let closed = false;
      while (i < n) {
        const d = src[i];
        if (d === '\n') break;
        if (src.charCodeAt(i) === c) {
          i++;
          closed = true;
          break;
        }
        if (d === '\\' && i + 1 < n) {
          const e = src[i + 1];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e;
          i += 2;
          continue;
        }
        v += d;
        i++;
      }
      if (!closed) return { error: 'a string is never closed', line: start };
      out.push({ k: 'str', v, line });
      continue;
    }
    out.push({ k: 'p', v: src[i], line });
    i++;
  }
  out.push({ k: 'eof', v: '', line });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parser

interface MsgNode {
  name: string;
  fq: string;
  line: number;
  fields: ProtoFieldDecl[];
  enums: EnumNode[];
  messages: MsgNode[];
}

interface EnumNode {
  name: string;
  fq: string;
  line: number;
  values: { name: string; number: number }[];
}

class Bail extends Error {}

class ProtoParser {
  i = 0;
  private ticks = 0;
  readonly topEnums: EnumNode[] = [];
  readonly topMessages: MsgNode[] = [];

  constructor(
    readonly t: T[],
    readonly out: ParsedProto,
    private readonly deadline: number,
  ) {}

  get tok(): T {
    return this.t[this.i] ?? this.t[this.t.length - 1];
  }

  tick(): void {
    if ((++this.ticks & 1023) === 0 && Date.now() > this.deadline) throw new TooComplex();
  }

  problem(text: string, line = this.tok.line): void {
    if (this.out.problems.length < MAX_FILE_PROBLEMS) this.out.problems.push(`${this.out.label}: ${text} (line ${line})`);
  }

  isP(v: string, o = 0): boolean {
    const x = this.t[this.i + o];
    return !!x && x.k === 'p' && x.v === v;
  }

  isId(v?: string, o = 0): boolean {
    const x = this.t[this.i + o];
    return !!x && x.k === 'id' && (v === undefined || x.v === v);
  }

  eat(v: string): boolean {
    if (this.isP(v)) {
      this.i++;
      return true;
    }
    return false;
  }

  expect(v: string): void {
    if (!this.eat(v)) {
      this.problem(`expected "${v}" but found ${this.tok.k === 'eof' ? 'the end of the file' : `"${this.tok.v}"`}`);
      throw new Bail();
    }
  }

  ident(): string {
    if (this.tok.k !== 'id') {
      this.problem(`expected a name but found ${this.tok.k === 'eof' ? 'the end of the file' : `"${this.tok.v}"`}`);
      throw new Bail();
    }
    return this.t[this.i++].v;
  }

  /** `a.b.c` or `.a.b.c`. */
  fullIdent(): string {
    let s = '';
    if (this.eat('.')) s = '.';
    s += this.ident();
    while (this.isP('.') && this.isId(undefined, 1)) {
      this.i++;
      s += `.${this.ident()}`;
    }
    return s;
  }

  int(): number {
    let neg = false;
    if (this.eat('-')) neg = true;
    else this.eat('+');
    const x = this.tok;
    if (x.k !== 'num') {
      this.problem(`expected a number but found "${x.v}"`);
      throw new Bail();
    }
    this.i++;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(x.v)) n = parseInt(x.v.slice(2), 16);
    else if (/^0[0-7]+$/.test(x.v)) n = parseInt(x.v.slice(1), 8);
    else if (/^\d+$/.test(x.v)) n = Number(x.v);
    else {
      this.problem(`"${x.v}" is not a whole number`);
      throw new Bail();
    }
    return neg ? -n : n;
  }

  strings(): string {
    let s = '';
    if (this.tok.k !== 'str') {
      this.problem(`expected a string but found "${this.tok.v}"`);
      throw new Bail();
    }
    while (this.tok.k === 'str') s += this.t[this.i++].v;
    return s;
  }

  /** Skips to just past the next `;` at this level, or past a balanced `{…}`; never past `stop` (`}` of the caller). */
  skipStatement(): void {
    let d = 0;
    while (this.tok.k !== 'eof') {
      this.tick();
      const x = this.tok;
      if (x.k === 'p') {
        if (x.v === '{' || x.v === '(' || x.v === '[') d++;
        else if (x.v === '}' || x.v === ')' || x.v === ']') {
          if (d === 0) return; // the enclosing block's end
          d--;
          if (d === 0 && x.v === '}') {
            this.i++;
            this.eat(';');
            return;
          }
        } else if (x.v === ';' && d === 0) {
          this.i++;
          return;
        }
      }
      this.i++;
    }
  }

  /** `[name = value, …]` field options; returns the ones we read. */
  fieldOptions(): { jsonName?: string; packed?: boolean; required?: boolean } {
    const res: { jsonName?: string; packed?: boolean; required?: boolean } = {};
    if (!this.eat('[')) return res;
    for (;;) {
      this.tick();
      // option name: tokens up to `=` (custom options are parenthesised)
      let name = '';
      let d = 0;
      while (this.tok.k !== 'eof' && !(d === 0 && this.isP('='))) {
        if (this.isP('(')) d++;
        else if (this.isP(')')) d--;
        else if (d === 0 && (this.isP(']') || this.isP(';'))) break;
        name += this.tok.v;
        this.i++;
      }
      this.expect('=');
      const valueStart = this.i;
      let vd = 0;
      while (this.tok.k !== 'eof') {
        if (this.isP('{') || this.isP('[') || this.isP('(')) vd++;
        else if (this.isP('}') || this.isP(')') || (this.isP(']') && vd > 0)) vd--;
        else if (vd === 0 && (this.isP(',') || this.isP(']') || this.isP(';'))) break;
        this.i++;
        this.tick();
      }
      const value = this.t.slice(valueStart, this.i);
      const v0 = value[0];
      if (name === 'json_name' && v0?.k === 'str') res.jsonName = value.filter((x) => x.k === 'str').map((x) => x.v).join('');
      else if (name === 'packed' && v0?.k === 'id') res.packed = v0.v === 'true';
      else if (name === 'features.repeated_field_encoding' && v0?.k === 'id') res.packed = v0.v !== 'EXPANDED';
      else if (name === 'features.field_presence' && v0?.k === 'id' && v0.v === 'LEGACY_REQUIRED') res.required = true;
      if (this.eat(',')) continue;
      this.expect(']');
      return res;
    }
  }

  file(): void {
    while (this.tok.k !== 'eof') {
      this.tick();
      const start = this.i;
      try {
        this.topStatement();
      } catch (e) {
        if (!(e instanceof Bail)) throw e;
        if (this.i === start) this.i++;
        this.skipStatement();
        if (this.isP('}')) this.i++; // a stray `}` at the top level
      }
    }
  }

  private topStatement(): void {
    const x = this.tok;
    if (this.eat(';')) return;
    if (x.k !== 'id') {
      this.problem(`unexpected "${x.v}"`);
      throw new Bail();
    }
    switch (x.v) {
      case 'syntax': {
        this.i++;
        this.expect('=');
        const s = this.strings();
        this.expect(';');
        if (s === 'proto2' || s === 'proto3') this.out.syntax = s;
        else this.problem(`unknown syntax "${s}"`, x.line);
        this.out.packedByDefault = this.out.syntax === 'proto3';
        return;
      }
      case 'edition': {
        this.i++;
        this.expect('=');
        this.strings();
        this.expect(';');
        this.out.syntax = 'editions';
        this.out.packedByDefault = true;
        return;
      }
      case 'package': {
        this.i++;
        this.out.pkg = this.fullIdent().replace(/^\./, '');
        this.expect(';');
        return;
      }
      case 'import': {
        this.i++;
        if (this.isId('public') || this.isId('weak')) this.i++;
        this.out.imports.push(this.strings());
        this.expect(';');
        return;
      }
      case 'option': {
        this.i++;
        const name: string[] = [];
        while (this.tok.k !== 'eof' && !this.isP('=') && !this.isP(';') && !this.isP('{') && !this.isP('}')) {
          this.tick();
          name.push(this.t[this.i++].v);
        }
        if (this.eat('=') && name.join('') === 'features.repeated_field_encoding' && this.isId()) {
          this.out.packedByDefault = this.tok.v !== 'EXPANDED';
        }
        this.skipStatement();
        return;
      }
      case 'message':
        this.i++;
        this.topMessages.push(this.message(this.out.pkg, 0));
        return;
      case 'enum':
        this.i++;
        this.topEnums.push(this.enumBody(this.out.pkg));
        return;
      case 'service':
        this.i++;
        this.service();
        return;
      case 'extend':
        this.problem('extensions ("extend") are not supported; they are skipped');
        this.i++;
        this.skipStatement();
        return;
      default:
        this.problem(`unexpected "${x.v}"`);
        throw new Bail();
    }
  }

  private message(scope: string, depth: number): MsgNode {
    const line = this.tok.line;
    const name = this.ident();
    const fq = scope ? `${scope}.${name}` : name;
    const node: MsgNode = { name, fq, line, fields: [], enums: [], messages: [] };
    if (depth > MAX_NESTING) {
      this.problem(`messages nested deeper than ${MAX_NESTING}; the rest is skipped`, line);
      this.skipStatement();
      return node;
    }
    this.expect('{');
    this.messageBody(node, depth, undefined);
    return node;
  }

  /** Statements up to the closing `}` (consumed). `oneof` is set inside a oneof block. */
  private messageBody(node: MsgNode, depth: number, oneof: string | undefined): void {
    while (!this.eat('}')) {
      this.tick();
      if (this.tok.k === 'eof') {
        this.problem(`the block of ${node.fq} is never closed`, node.line);
        return;
      }
      const start = this.i;
      try {
        this.messageStatement(node, depth, oneof);
      } catch (e) {
        if (!(e instanceof Bail)) throw e;
        if (this.i === start) this.i++;
        this.skipStatement();
      }
    }
  }

  private messageStatement(node: MsgNode, depth: number, oneof: string | undefined): void {
    if (this.eat(';')) return;
    const x = this.tok;
    if (x.k === 'id' && !oneof) {
      switch (x.v) {
        case 'message':
          if (this.isId(undefined, 1)) {
            this.i++;
            node.messages.push(this.message(node.fq, depth + 1));
            return;
          }
          break;
        case 'enum':
          if (this.isId(undefined, 1)) {
            this.i++;
            node.enums.push(this.enumBody(node.fq));
            return;
          }
          break;
        case 'oneof':
          if (this.isId(undefined, 1) && this.isP('{', 2)) {
            this.i++;
            const name = this.ident();
            this.expect('{');
            this.messageBody(node, depth, oneofKey(name));
            return;
          }
          break;
        case 'reserved':
        case 'extensions':
          if (!this.isP('=', 2)) {
            this.skipStatement(); // ranges / names: nothing to decode
            return;
          }
          break;
        case 'extend':
          this.problem('extensions ("extend") are not supported; they are skipped');
          this.skipStatement();
          return;
      }
    }
    if (x.k === 'id' && x.v === 'option') {
      this.skipStatement();
      return;
    }
    this.field(node, oneof);
  }

  private field(node: MsgNode, oneof: string | undefined): void {
    const line = this.tok.line;
    let repeated = false;
    let required = false;
    if (this.isId('repeated') || this.isId('optional') || this.isId('required')) {
      // `optional int32 x = 1;` vs a field of a type named `optional` (`optional x = 1;`)
      if (!this.isP('=', 2)) {
        const label = this.t[this.i++].v;
        repeated = label === 'repeated';
        required = label === 'required';
      }
    }
    if (this.isId('group') && this.isId(undefined, 1) && this.isP('=', 2)) {
      this.problem('groups are not supported; the field is skipped');
      this.skipStatement();
      return;
    }
    let type: ProtoTypeRef;
    let map: ProtoFieldDecl['map'];
    if (this.isId('map') && this.isP('<', 1)) {
      this.i += 2;
      const k = this.ident();
      this.expect(',');
      const v = this.fullIdent();
      this.expect('>');
      if (!MAP_KEYS.has(k)) {
        this.problem(`"${k}" can't be a map key`, line);
        throw new Bail();
      }
      map = { key: k as ProtoScalar, value: SCALARS.has(v) ? { scalar: v as ProtoScalar } : { name: v } };
      type = map.value;
    } else {
      const t = this.fullIdent();
      type = SCALARS.has(t) ? { scalar: t as ProtoScalar } : { name: t };
    }
    const name = this.ident();
    this.expect('=');
    const number = this.int();
    const opts = this.fieldOptions();
    this.expect(';');
    if (number < 1 || number > 536870911) {
      this.problem(`field ${name} has an invalid number ${number}`, line);
      return;
    }
    const decl: ProtoFieldDecl = {
      number,
      name: opts.jsonName ?? protoJsonName(name),
      type,
      repeated: repeated && !map,
      required: required || !!opts.required,
      line,
    };
    if (map) decl.map = map;
    if (opts.packed !== undefined) decl.packed = opts.packed;
    if (oneof) decl.oneof = oneof;
    node.fields.push(decl);
  }

  private enumBody(scope: string): EnumNode {
    const line = this.tok.line;
    const name = this.ident();
    const fq = scope ? `${scope}.${name}` : name;
    const node: EnumNode = { name, fq, line, values: [] };
    const seen = new Set<number>();
    this.expect('{');
    while (!this.eat('}')) {
      this.tick();
      if (this.tok.k === 'eof') {
        this.problem(`the block of ${fq} is never closed`, line);
        return node;
      }
      const start = this.i;
      try {
        if (this.eat(';')) continue;
        if ((this.isId('option') || this.isId('reserved')) && !this.isP('=', 1)) {
          this.skipStatement();
          continue;
        }
        const v = this.ident();
        this.expect('=');
        const num = this.int();
        this.fieldOptions();
        this.expect(';');
        if (!seen.has(num)) {
          seen.add(num);
          node.values.push({ name: v, number: num });
        }
      } catch (e) {
        if (!(e instanceof Bail)) throw e;
        if (this.i === start) this.i++;
        this.skipStatement();
      }
    }
    return node;
  }

  private service(): void {
    const line = this.tok.line;
    const name = this.ident();
    const svc = this.out.pkg ? `${this.out.pkg}.${name}` : name;
    this.expect('{');
    while (!this.eat('}')) {
      this.tick();
      if (this.tok.k === 'eof') {
        this.problem(`the block of service ${name} is never closed`, line);
        return;
      }
      const start = this.i;
      try {
        if (this.eat(';')) continue;
        if (this.isId('rpc')) {
          const mline = this.tok.line;
          this.i++;
          const m = this.ident();
          this.expect('(');
          const cs = this.isId('stream') && !this.isP(')', 1) ? (this.i++, true) : false;
          const req = this.fullIdent();
          this.expect(')');
          if (!this.isId('returns')) {
            this.problem(`expected "returns" in rpc ${m}`);
            throw new Bail();
          }
          this.i++;
          this.expect('(');
          const ss = this.isId('stream') && !this.isP(')', 1) ? (this.i++, true) : false;
          const res = this.fullIdent();
          this.expect(')');
          if (this.isP('{')) this.skipStatement();
          else this.expect(';');
          this.out.methods.push({ path: `/${svc}/${m}`, req, res, clientStreaming: cs, serverStreaming: ss, line: mline });
          continue;
        }
        this.skipStatement(); // option …;
      } catch (e) {
        if (!(e instanceof Bail)) throw e;
        if (this.i === start) this.i++;
        this.skipStatement();
      }
    }
  }
}

/** protoc_plugin's class names: top-level enums, then messages depth-first (each message, its enums, its messages). */
function assignDartNames(p: ProtoParser, out: ParsedProto): void {
  const used = new Set<string>(FORBIDDEN_DART);
  const take = (name: string, parent: string): string => {
    let base = parent ? `${parent}_${name}` : name;
    while (base.startsWith('_')) base = `${base.slice(1)}_`;
    if (/^[0-9]/.test(base)) base = `x${base}`;
    let chosen = base;
    if (used.has(chosen)) {
      chosen = `${base}_`;
      for (let i = 0; used.has(chosen); i++) chosen = `${base}_${i}`;
    }
    used.add(chosen);
    return chosen;
  };
  for (const e of p.topEnums) out.enums.push({ fq: e.fq, dartClass: take(e.name, ''), values: e.values, line: e.line });
  const walk = (m: MsgNode, parent: string) => {
    const cls = take(m.name, parent);
    out.messages.push({ fq: m.fq, dartClass: cls, fields: m.fields, line: m.line });
    for (const e of m.enums) out.enums.push({ fq: e.fq, dartClass: take(e.name, cls), values: e.values, line: e.line });
    for (const n of m.messages) walk(n, cls);
  };
  for (const m of p.topMessages) walk(m, '');
}

/** Parses one `.proto` file. Never throws. */
export function parseProtoFile(path: string, text: string, label: string): ParsedProto {
  const out: ParsedProto = {
    path,
    label,
    syntax: 'proto2',
    pkg: '',
    imports: [],
    messages: [],
    enums: [],
    methods: [],
    packedByDefault: false,
    problems: [],
  };
  const deadline = Date.now() + MAX_PROTO_MS;
  try {
    const toks = tokenizeProto(text, deadline);
    if (toks === 'too complex') {
      out.problems.push(`${label}: too complex to read`);
      return out;
    }
    if (!Array.isArray(toks)) {
      out.problems.push(`${label}: ${toks.error} (line ${toks.line})`);
      return out;
    }
    const p = new ProtoParser(toks, out, deadline);
    p.file();
    assignDartNames(p, out);
    return out;
  } catch (e) {
    const skipped: ParsedProto = { ...out, imports: [], messages: [], enums: [], methods: [] };
    skipped.problems = [e instanceof TooComplex ? `${label}: too complex to read` : `${label}: couldn't read the file (${(e as Error).message})`];
    return skipped;
  }
}
