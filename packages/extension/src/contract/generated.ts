/**
 * `*.g.dart` → wire models (CONTRACTS §10.1/10.3). Reads every `_$XFromJson` json_serializable emits
 * (freezed delegates to it) plus the `_$XEnumMap` constants, across generator versions:
 * expression bodies (`=> X(…)`), legacy block bodies (`{ return X(…)..a = …; }`), `checked: true`
 * (`$checkedCreate` / legacy `$checkedNew` + `$checkedConvert`), `$checkKeys`, positional and named
 * constructor arguments, cascades, generic `fromJsonT`. Anything else becomes `{kind:'unknown'}`.
 * Pure; never throws (a broken function yields no model, a broken field yields `unknown`).
 */
import type { WireField, WireModel, WireType } from './types';
import { Block, lineIndex, Node, Parser, Stmt, Tok, tokenize, TypeNode, typeText } from './dart';

/** Extra facts the checker uses beyond the shared WireType (kept as optional properties on the type objects). */
export interface TypeFlags {
  /** `json['x'] as int` / `as double`: no num conversion, so a double for an int (or an int for a double) throws. */
  strict?: boolean;
  /** enum with `unknownValue:` — unknown values decode to a fallback instead of throwing. */
  lenient?: boolean;
  /** enum fallback is `JsonKey.nullForUndefinedEnumValue` (decodes to null). */
  unknownToNull?: boolean;
  /** List/map element (or value) may be null. */
  elemNullable?: boolean;
  /** enum JSON values with their real JSON types (`values` holds their text). */
  jsonValues?: (string | number | boolean)[];
  /** The Dart enum constant used as fallback, e.g. "UserTier.unknown". */
  fallback?: string;
}
export type XType = WireType & TypeFlags;

export interface XField extends WireField {
  type: XType;
  /** `$checkKeys(requiredKeys:)`: the key must be present even when the field is nullable. */
  requiredKey?: boolean;
  /** `$checkKeys(disallowNullValues:)`: null throws even when the field is nullable. */
  disallowNull?: boolean;
  /** Positional constructor argument index (dartName is a guess until the owner class is read). */
  positional?: number;
}

export interface XModel extends WireModel {
  fields: XField[];
  /** `checked: true`: errors are wrapped in CheckedFromJsonException. */
  checked?: boolean;
  /** Function name in the .g.dart, e.g. `_$$UserImplFromJson`. */
  fn: string;
  /** Class actually constructed (`_$UserImpl`, `_User`, `User`). */
  constructed?: string;
  /** 1-based line of the `_$XFromJson` function in the .g.dart. */
  generatedLine: number;
  /** Generic type parameters (`Page<T>`): their fields are `unknown`. */
  typeParams?: string[];
}

/** Retrofit / Chopper implementation classes found in a generated file. */
export interface GeneratedApiClass {
  generated: string; // "_UsersApi" / "_$ItemService"
  api: string; // "UsersApi" / "ItemService"
  kind: 'retrofit' | 'chopper';
  line: number;
}

export interface GeneratedFileInfo {
  file: string;
  /** `part of 'user.dart'` (relative URI) when present. */
  partOf?: string;
  models: XModel[];
  apiClasses: GeneratedApiClass[];
}

/** `_$UserFromJson` → "User"; freezed `_$$UserImplFromJson` / `_$$_UserFromJson` / `_$_$_UserFromJson` → "User". */
export function modelNameFromFn(fn: string): string | undefined {
  const m = /^_\$(.+)FromJson$/.exec(fn);
  if (!m) return undefined;
  let name = m[1];
  const freezedMark = /^[$_]/.test(name);
  name = name.replace(/^[$_]+/, '');
  if (freezedMark && /^\$/.test(m[1]) && name.endsWith('Impl') && name.length > 4) name = name.slice(0, -4);
  // legacy freezed: `_$_$_User` → strip any remaining `_$` / `$_` prefix runs
  name = name.replace(/^(?:_\$|\$_)+/, '');
  return name || undefined;
}

/** `_$RoleEnumMap` → "Role". */
function enumNameFromMap(id: string): string {
  return id.replace(/^_\$/, '').replace(/EnumMap$/, '');
}

const PRIMS: Record<string, WireType['kind']> = {
  String: 'string',
  int: 'int',
  double: 'double',
  num: 'num',
  bool: 'bool',
  dynamic: 'dynamic',
  Object: 'dynamic',
};

/** json_serializable's own helpers (not models): `_$nullableGenericFromJson`, `_$JsonConverterFromJson`, `_$recordConvert…`. */
const HELPER_FN = /^_\$(?:nullable\w*|JsonConverter\w*|record\w*)FromJson$/;

const unknown = (text: string): XType => ({ kind: 'unknown', text });

interface Conv {
  type: XType;
  nullable: boolean;
  hasDefault: boolean;
}

interface Ctx {
  jsonVar: string;
  enums: Map<string, { values: (string | number | boolean)[] }>;
  typeParams: Set<string>;
}

/** A value source: `json['key']` (captures the key) or a lambda/checked parameter. */
interface Src {
  vars: Set<string>;
  key?: string;
}

function isSrc(n: Node, ctx: Ctx, src: Src): boolean {
  if (n.k === 'id' && src.vars.has(n.name)) return true;
  if (n.k === 'index' && n.obj.k === 'id' && n.obj.name === ctx.jsonVar && n.index.k === 'str') {
    if (src.key === undefined) src.key = n.index.v;
    return src.key === n.index.v;
  }
  if (n.k === 'bang') return isSrc(n.e, ctx, src);
  return false;
}

/** Does `n` read the source anywhere (for "unknown but it's this field")? */
function mentionsSrc(n: Node | undefined, ctx: Ctx, src: Src, depth = 0): boolean {
  if (!n || depth > 60) return false;
  if (isSrc(n, ctx, src)) return true;
  const d = depth + 1;
  switch (n.k) {
    case 'member':
      return mentionsSrc(n.obj, ctx, src, d);
    case 'call':
      return mentionsSrc(n.callee, ctx, src, d) || n.args.some((a) => mentionsSrc(a.value, ctx, src, d));
    case 'index':
      return mentionsSrc(n.obj, ctx, src, d) || mentionsSrc(n.index, ctx, src, d);
    case 'as':
    case 'is':
      return mentionsSrc(n.expr, ctx, src, d);
    case 'bin':
      return mentionsSrc(n.l, ctx, src, d) || mentionsSrc(n.r, ctx, src, d);
    case 'cond':
      return mentionsSrc(n.c, ctx, src, d) || mentionsSrc(n.a, ctx, src, d) || mentionsSrc(n.b, ctx, src, d);
    case 'unary':
    case 'bang':
      return mentionsSrc(n.e, ctx, src, d);
    case 'fn':
      return n.body.k !== 'block' && mentionsSrc(n.body, ctx, src, d);
    default:
      return false;
  }
}

/** Type of a cast target: `as String?`, `as Map<String, dynamic>`, `as List<dynamic>?`. */
function castType(t: TypeNode, ctx: Ctx): Conv {
  const nullable = t.nullable;
  const prim = PRIMS[t.name];
  if (prim) {
    const type: XType = { kind: prim } as XType;
    if (prim === 'int' || prim === 'double') (type as TypeFlags).strict = true;
    return { type, nullable: nullable || t.name === 'dynamic', hasDefault: false };
  }
  if (t.name === 'Map') return { type: { kind: 'map', of: { kind: 'dynamic' }, elemNullable: true }, nullable, hasDefault: false };
  if (t.name === 'List' || t.name === 'Iterable') {
    return { type: { kind: 'list', of: { kind: 'dynamic' }, elemNullable: true }, nullable, hasDefault: false };
  }
  if (ctx.typeParams.has(t.name)) return { type: unknown(t.name), nullable: true, hasDefault: false };
  return { type: unknown(typeText(t)), nullable: true, hasDefault: false };
}

const asMember = (n: Node, name: string): n is Extract<Node, { k: 'call' }> =>
  n.k === 'call' && n.callee.k === 'member' && n.callee.name === name;

const calleeName = (n: Extract<Node, { k: 'call' }>): string | undefined =>
  n.callee.k === 'id' ? n.callee.name : n.callee.k === 'member' && n.callee.obj.k === 'id' ? `${n.callee.obj.name}.${n.callee.name}` : undefined;

/** A `Map` source: `S as Map<String, dynamic>`, `Map<String, dynamic>.from(S as Map)`, `S as Map`, or `S`. */
function mapSource(n: Node, ctx: Ctx, src: Src): { nullable: boolean } | undefined {
  if (n.k === 'as' && isSrc(n.expr, ctx, src) && (n.type.name === 'Map' || PRIMS[n.type.name] === 'dynamic')) {
    return { nullable: n.type.nullable || n.type.name === 'dynamic' };
  }
  if (n.k === 'call' && n.callee.k === 'member' && n.callee.name === 'from' && n.callee.obj.k === 'id' && /^Map\b/.test(n.callee.obj.name)) {
    return n.args[0] ? mapSource(n.args[0].value, ctx, src) : undefined;
  }
  if (isSrc(n, ctx, src)) return { nullable: true };
  return undefined;
}

/** A list source: `S as List<dynamic>`, `S as List<dynamic>?`, `S as List`, `S as Iterable`. */
function listSource(n: Node, ctx: Ctx, src: Src): { nullable: boolean } | undefined {
  if (n.k === 'as' && isSrc(n.expr, ctx, src) && (n.type.name === 'List' || n.type.name === 'Iterable')) return { nullable: n.type.nullable };
  if (isSrc(n, ctx, src)) return { nullable: true };
  return undefined;
}

function lambdaOf(n: Node | undefined): Extract<Node, { k: 'fn' }> | undefined {
  return n && n.k === 'fn' ? n : undefined;
}

/** Element conversion of a `.map((e) => …)` lambda (its body converts the parameter). */
function elementConv(fnNode: Node | undefined, ctx: Ctx, paramIdx = 0): Conv {
  const fn = lambdaOf(fnNode);
  if (fnNode && fnNode.k === 'id') {
    // `.map(fromJsonT)` / a tear-off
    return { type: unknown(fnNode.name), nullable: true, hasDefault: false };
  }
  if (!fn || fn.body.k === 'block' || fn.params.length <= paramIdx) return { type: unknown('?'), nullable: true, hasDefault: false };
  const inner: Src = { vars: new Set([fn.params[paramIdx]]) };
  return conv(fn.body, ctx, inner);
}

/** Classifies a field value expression against its source. */
export function conv(n: Node, ctx: Ctx, src: Src, depth = 0): Conv {
  if (depth > 40) return { type: unknown('?'), nullable: true, hasDefault: false };
  const d = depth + 1;
  // S ?? default
  if (n.k === 'bin' && n.op === '??') {
    const l = conv(n.l, ctx, src, d);
    return { type: l.type, nullable: true, hasDefault: true };
  }
  // S == null ? null : X   /   S != null ? X : null
  if (n.k === 'cond' && n.c.k === 'bin' && (n.c.op === '==' || n.c.op === '!=') && n.c.r.k === 'lit' && n.c.r.v === 'null' && isSrc(n.c.l, ctx, src)) {
    const other = n.c.op === '==' ? n.a : n.b;
    const conv2 = n.c.op === '==' ? n.b : n.a;
    if (other.k === 'lit' && other.v === 'null') {
      const r = conv(conv2, ctx, src, d);
      return { type: r.type, nullable: true, hasDefault: r.hasDefault };
    }
  }
  if (isSrc(n, ctx, src)) return { type: { kind: 'dynamic' }, nullable: true, hasDefault: false };
  if (n.k === 'as' && isSrc(n.expr, ctx, src)) return castType(n.type, ctx);
  if (n.k === 'bang') return conv(n.e, ctx, src, d);

  if (n.k === 'call') {
    // (S as num).toDouble() / (S as num?)?.toInt()
    if (n.callee.k === 'member' && (n.callee.name === 'toDouble' || n.callee.name === 'toInt') && n.args.length === 0) {
      const target = n.callee.obj;
      if (target.k === 'as' && isSrc(target.expr, ctx, src) && (target.type.name === 'num' || target.type.name === 'int' || target.type.name === 'double')) {
        const kind = n.callee.name === 'toDouble' ? 'double' : 'int';
        const type: XType = { kind } as XType;
        if (target.type.name !== 'num' && target.type.name !== kind) (type as TypeFlags).strict = true;
        return { type, nullable: target.type.nullable, hasDefault: false };
      }
      return { type: unknown('?'), nullable: true, hasDefault: false };
    }
    const name = calleeName(n);
    // DateTime.parse(S as String) / Uri.parse / BigInt.parse
    if (name === 'DateTime.parse' || name === 'Uri.parse' || name === 'BigInt.parse' || name === 'DateTime.tryParse' || name === 'Uri.tryParse') {
      const a = n.args[0] ? conv(n.args[0].value, ctx, src, d) : undefined;
      if (a && a.type.kind === 'string') {
        const kind = name.startsWith('DateTime') ? 'datetime' : name.startsWith('Uri') ? 'uri' : 'bigint';
        if (name.endsWith('tryParse')) return { type: { kind: 'string' }, nullable: true, hasDefault: false };
        return { type: { kind } as XType, nullable: a.nullable, hasDefault: false };
      }
      return { type: unknown(name), nullable: true, hasDefault: false };
    }
    // DateTime.fromMillisecondsSinceEpoch((S as num).toInt()) / Duration(microseconds: …)
    if (name === 'DateTime.fromMillisecondsSinceEpoch' || name === 'DateTime.fromMicrosecondsSinceEpoch' || name === 'Duration') {
      const a = n.args[0] ? conv(n.args[0].value, ctx, src, d) : undefined;
      if (a && (a.type.kind === 'int' || a.type.kind === 'num')) return a;
      return { type: unknown(name), nullable: true, hasDefault: false };
    }
    // $enumDecode(_$RoleEnumMap, S, unknownValue: …) / $enumDecodeNullable / legacy _$enumDecode*
    if (name && /^(?:\$|_\$)enumDecode(Nullable)?$/.test(name)) {
      const nullableFn = /Nullable$/.test(name);
      const mapArg = n.args[0]?.value;
      const valArg = n.args[1]?.value;
      const unknownArg = n.args.find((a) => a.name === 'unknownValue')?.value;
      if (mapArg?.k === 'id' && valArg && isSrc(valArg, ctx, src)) {
        const enumName = enumNameFromMap(mapArg.name);
        const values = ctx.enums.get(mapArg.name)?.values ?? [];
        const type: XType = { kind: 'enum', name: enumName, values: values.map(String), jsonValues: values };
        if (unknownArg) {
          (type as TypeFlags).lenient = true;
          const fb = unknownArg.k === 'member' && unknownArg.obj.k === 'id' ? `${unknownArg.obj.name}.${unknownArg.name}` : undefined;
          if (fb === 'JsonKey.nullForUndefinedEnumValue') (type as TypeFlags).unknownToNull = true;
          else if (fb) (type as TypeFlags).fallback = fb;
        }
        if (!ctx.enums.has(mapArg.name)) return { type: unknown(`enum ${enumName}`), nullable: true, hasDefault: false };
        return { type, nullable: nullableFn, hasDefault: false };
      }
      return { type: unknown(name), nullable: true, hasDefault: false };
    }
    // X.fromJson(S as Map<String, dynamic>, …) / _$XFromJson(S as Map<String, dynamic>)
    if (
      (n.callee.k === 'member' && n.callee.name === 'fromJson' && n.callee.obj.k === 'id') ||
      (n.callee.k === 'id' && /^_\$.+FromJson$/.test(n.callee.name) && !HELPER_FN.test(n.callee.name))
    ) {
      const arg = n.args[0]?.value;
      const ms = arg ? mapSource(arg, ctx, src) : undefined;
      if (ms) {
        let model =
          n.callee.k === 'member' && n.callee.obj.k === 'id' ? n.callee.obj.name.replace(/<.*$/, '') : n.callee.k === 'id' ? modelNameFromFn(n.callee.name) : undefined;
        if (model && ctx.typeParams.has(model)) model = undefined;
        if (model) return { type: { kind: 'model', name: model }, nullable: ms.nullable, hasDefault: false };
      }
      return { type: unknown('fromJson'), nullable: true, hasDefault: false };
    }
    // Map<String, String>.from(S as Map) / List<String>.from(S as List)
    if (n.callee.k === 'member' && n.callee.name === 'from' && n.callee.obj.k === 'id') {
      const m = /^(Map|List|Set)<(.+)>$/.exec(n.callee.obj.name);
      const arg = n.args[0]?.value;
      if (m && arg) {
        const isMap = m[1] === 'Map';
        const s = isMap ? mapSource(arg, ctx, src) : listSource(arg, ctx, src);
        if (s) {
          const parts = m[2].split(',').map((x) => x.trim());
          const valText = isMap ? parts.slice(1).join(', ') : parts[0];
          const vNullable = valText.endsWith('?');
          const prim = PRIMS[valText.replace(/\?$/, '')];
          const of: XType = prim ? ({ kind: prim } as XType) : unknown(valText);
          if (prim === 'int' || prim === 'double') (of as TypeFlags).strict = true;
          return {
            type: isMap ? { kind: 'map', of, elemNullable: vNullable || prim === 'dynamic' } : { kind: 'list', of, elemNullable: vNullable || prim === 'dynamic' },
            nullable: s.nullable,
            hasDefault: false,
          };
        }
      }
    }
    // (S as List<dynamic>).map((e) => …).toList() / ?.map(…)?.toList() / .toSet()
    let core: Node = n;
    if (asMember(core, 'toList') || asMember(core, 'toSet')) core = (core.callee as Extract<Node, { k: 'member' }>).obj;
    if (asMember(core, 'map') && core.callee.k === 'member') {
      const target = core.callee.obj;
      const ls = listSource(target, ctx, src);
      const fn = lambdaOf(core.args[0]?.value);
      if (ls && !(target.k === 'as' && target.type.name === 'Map')) {
        const el = elementConv(core.args[0]?.value, ctx);
        return { type: { kind: 'list', of: el.type, elemNullable: el.nullable }, nullable: ls.nullable, hasDefault: false };
      }
      // (S as Map<String, dynamic>).map((k, e) => MapEntry(k, …))
      const ms = mapSource(target, ctx, src);
      if (ms && fn && fn.params.length === 2 && fn.body.k === 'call') {
        const body = fn.body;
        const valueNode = calleeName(body) === 'MapEntry' ? body.args[1]?.value : undefined;
        if (valueNode) {
          const el = conv(valueNode, ctx, { vars: new Set([fn.params[1]]) }, d);
          return { type: { kind: 'map', of: el.type, elemNullable: el.nullable }, nullable: ms.nullable, hasDefault: false };
        }
      }
      return { type: unknown('map'), nullable: true, hasDefault: false };
    }
    // _$nullableGenericFromJson(S, fromJsonT) / fromJsonT(S) / converters / records
    if (mentionsSrc(n, ctx, src)) {
      return { type: unknown(name ?? 'converter'), nullable: true, hasDefault: false };
    }
  }
  return { type: unknown('?'), nullable: true, hasDefault: false };
}

function lit(n: Node): string | number | boolean | undefined {
  if (n.k === 'str') return n.v;
  if (n.k === 'num') return Number(n.v.replace(/_/g, ''));
  if (n.k === 'unary' && n.op === '-' && n.e.k === 'num') return -Number(n.e.v.replace(/_/g, ''));
  if (n.k === 'lit' && n.v !== 'null') return n.v === 'true';
  return undefined;
}

function stringList(n: Node | undefined): string[] {
  if (!n || n.k !== 'list') return [];
  return n.items.filter((x): x is Extract<Node, { k: 'str' }> => x.k === 'str').map((x) => x.v);
}

/** `fooBar_baz-qux` → `fooBarBazQux`: a guess for positional arguments until the owner class is read. */
export function camelFromKey(key: string): string {
  const parts = key.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return key;
  const allUpper = key === key.toUpperCase();
  return parts
    .map((p, i) => {
      const w = allUpper ? p.toLowerCase() : p;
      return i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
}

interface Collected {
  fields: { name?: string; positional?: number; value: Node; key?: string; srcVar?: string }[];
  required: Set<string>;
  disallowNull: Set<string>;
  checked: boolean;
  constructed?: string;
}

/** Unwraps `$checkedConvert('k', (v) => E)` (new API) / `$checkedConvert(json, 'k', (v) => E)` (legacy). */
function unwrapChecked(n: Node): { key: string; srcVar: string; body: Node } | undefined {
  if (n.k !== 'call' || n.callee.k !== 'id' || n.callee.name !== '$checkedConvert') return undefined;
  const pos = n.args.filter((a) => !a.name);
  const keyArg = pos.find((a) => a.value.k === 'str');
  const fnArg = pos.find((a) => a.value.k === 'fn');
  if (!keyArg || !fnArg || keyArg.value.k !== 'str' || fnArg.value.k !== 'fn') return undefined;
  const fn = fnArg.value;
  if (fn.body.k === 'block' || !fn.params[0]) return undefined;
  return { key: keyArg.value.v, srcVar: fn.params[0], body: fn.body };
}

function collectConstruction(n: Node, out: Collected, vars: Map<string, Node>, depth = 0): void {
  if (depth > 20) return;
  if (n.k === 'id' && vars.has(n.name)) return collectConstruction(vars.get(n.name)!, out, vars, depth + 1);
  if (n.k === 'cascade') {
    collectConstruction(n.target, out, vars, depth + 1);
    for (const s of n.sections) if (s.value && !s.name.includes('.')) out.fields.push({ name: s.name, value: s.value });
    return;
  }
  if (n.k === 'call') {
    const name = calleeName(n);
    if (name === '$checkedCreate' || name === '$checkedNew') {
      out.checked = true;
      const fn = n.args.find((a) => a.value.k === 'fn')?.value;
      if (fn && fn.k === 'fn') {
        if (fn.body.k === 'block') collectBlock(fn.body, out, vars, depth + 1);
        else collectConstruction(fn.body, out, vars, depth + 1);
      }
      return;
    }
    if (n.callee.k === 'id' || n.callee.k === 'member') {
      out.constructed = n.callee.k === 'id' ? n.callee.name.replace(/<.*$/, '') : name;
      let p = 0;
      for (const a of n.args) {
        if (a.name) out.fields.push({ name: a.name, value: a.value });
        else out.fields.push({ positional: p++, value: a.value });
      }
    }
  }
}

function collectStmt(s: Stmt, out: Collected, vars: Map<string, Node>, depth: number): void {
  if (s.k === 'decl' && s.e) {
    vars.set(s.name, s.e);
    return;
  }
  if (s.k === 'return' && s.e) {
    collectConstruction(s.e, out, vars, depth + 1);
    return;
  }
  if (s.k === 'block') {
    collectBlock(s.body, out, vars, depth + 1);
    return;
  }
  if (s.k !== 'expr') return;
  const e = s.e;
  if (e.k === 'call' && e.callee.k === 'id' && e.callee.name === '$checkKeys') {
    for (const a of e.args) {
      if (a.name === 'requiredKeys') stringList(a.value).forEach((k) => out.required.add(k));
      if (a.name === 'disallowNullValues') stringList(a.value).forEach((k) => out.disallowNull.add(k));
    }
    return;
  }
  // checked mode, non-constructor fields: $checkedConvert('k', (v) => val.x = E)
  const ch = unwrapChecked(e);
  if (ch && ch.body.k === 'assign' && ch.body.target.k === 'member') {
    out.fields.push({ name: ch.body.target.name, value: ch.body.value, key: ch.key, srcVar: ch.srcVar });
    return;
  }
  // val.x = E  /  val..x = E
  if (e.k === 'assign' && e.target.k === 'member' && e.target.obj.k === 'id' && vars.has(e.target.obj.name)) {
    out.fields.push({ name: e.target.name, value: e.value });
    return;
  }
  if (e.k === 'cascade' && e.target.k === 'id' && vars.has(e.target.name)) {
    for (const sec of e.sections) if (sec.value && !sec.name.includes('.')) out.fields.push({ name: sec.name, value: sec.value });
  }
}

function collectBlock(b: Block, out: Collected, vars: Map<string, Node>, depth: number): void {
  for (const s of b.stmts) collectStmt(s, out, vars, depth);
}

function enumMapValues(n: Node): (string | number | boolean)[] | undefined {
  if (n.k !== 'map') return undefined;
  const out: (string | number | boolean)[] = [];
  for (const e of n.entries) {
    const v = lit(e.value);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** Top-level declarations: indices of `_$XFromJson` functions and `_$XEnumMap` consts. */
function scanTopLevel(toks: Tok[]): { fns: number[]; enumMaps: number[]; classes: number[] } {
  const fns: number[] = [];
  const enumMaps: number[] = [];
  const classes: number[] = [];
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'punct') {
      if (t.v === '(' || t.v === '[' || t.v === '{' || t.v === '?[') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || t.k !== 'id') continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (/^_\$.+FromJson$/.test(t.v) && next && (next.v === '(' || next.v === '<') && prev && (prev.k === 'id' || prev.v === '>' || prev.v === '?')) {
      if (prev.v !== 'return' && prev.v !== 'await') fns.push(i);
    } else if (/^_\$.+EnumMap$/.test(t.v) && next?.v === '=' && prev && (prev.v === 'const' || prev.v === 'final' || prev.k === 'id' || prev.v === '>')) {
      enumMaps.push(i);
    } else if (t.v === 'class' && next?.k === 'id') {
      classes.push(i);
    }
  }
  return { fns, enumMaps, classes };
}

/** Parses one generated file. `file` is recorded on each model as `generatedFile`. */
export function parseGeneratedDart(text: string, file: string): GeneratedFileInfo {
  const info: GeneratedFileInfo = { file, models: [], apiClasses: [] };
  let toks: Tok[];
  try {
    toks = tokenize(text);
  } catch {
    return info;
  }
  const lineOf = lineIndex(text);
  // part of 'user.dart';
  for (let i = 0; i + 2 < Math.min(toks.length, 400); i++) {
    if (toks[i].k === 'id' && toks[i].v === 'part' && toks[i + 1].v === 'of' && toks[i + 2].k === 'str') {
      info.partOf = toks[i + 2].v;
      break;
    }
  }
  const { fns, enumMaps, classes } = scanTopLevel(toks);
  const enums = new Map<string, { values: (string | number | boolean)[] }>();
  for (const i of enumMaps) {
    try {
      const p = new Parser(toks, i + 2);
      const n = p.expr();
      const values = enumMapValues(n);
      if (values) enums.set(toks[i].v, { values });
    } catch {
      // unreadable enum map: its enums become unknown
    }
  }
  for (const i of fns) {
    try {
      const m = parseFromJsonFn(toks, i, enums, file, lineOf);
      if (m) info.models.push(m);
    } catch {
      // never throw: skip this function
    }
  }
  for (const i of classes) {
    // class _UsersApi implements UsersApi {   /   final class _$ItemService extends ItemService {
    const name = toks[i + 1]?.v;
    let j = i + 2;
    while (j < toks.length && j < i + 40 && toks[j].v !== 'implements' && toks[j].v !== 'extends' && toks[j].v !== '{') j++;
    const rel = toks[j]?.v;
    const base = toks[j + 1];
    if (!name || !base || base.k !== 'id' || (rel !== 'implements' && rel !== 'extends')) continue;
    const retrofit = rel === 'implements' && name === `_${base.v}`;
    const chopper = rel === 'extends' && name === `_$${base.v}`;
    if (retrofit || chopper) info.apiClasses.push({ generated: name, api: base.v, kind: retrofit ? 'retrofit' : 'chopper', line: lineOf(toks[i].pos) });
  }
  return info;
}

function parseFromJsonFn(
  toks: Tok[],
  i: number,
  enums: Map<string, { values: (string | number | boolean)[] }>,
  file: string,
  lineOf: (pos: number) => number,
): XModel | undefined {
  const fn = toks[i].v;
  const name = modelNameFromFn(fn);
  if (!name || HELPER_FN.test(fn)) return undefined;
  const p = new Parser(toks, i + 1);
  const typeParams: string[] = [];
  if (p.is('<')) {
    // <T> / <T extends Object?>
    p.i++;
    while (!p.is('>') && p.t.k !== 'eof') {
      if (p.t.k === 'id') typeParams.push(p.t.v);
      if (p.is('extends')) {
        p.i++;
        p.type();
        continue;
      }
      p.i++;
    }
    p.expect('>');
  }
  // parameters: first one's name is the json variable
  if (!p.is('(')) return undefined;
  const close = p.matching(p.i);
  let jsonVar = 'json';
  let last: string | undefined;
  let d = 0;
  const firstType = toks[p.i + 1];
  if (firstType && firstType.k === 'id' && firstType.v !== 'Map' && !/^(?:core\.)?Map$/.test(firstType.v)) return undefined;
  for (let j = p.i + 1; j < close; j++) {
    const tk = toks[j];
    if (tk.k === 'punct' && (tk.v === '<' || tk.v === '(')) d++;
    else if (tk.k === 'punct' && (tk.v === '>' || tk.v === ')')) d--;
    else if (d === 0 && tk.v === ',') break;
    else if (d === 0 && tk.k === 'id') last = tk.v;
  }
  if (last) jsonVar = last;
  p.i = close + 1;
  const out: Collected = { fields: [], required: new Set(), disallowNull: new Set(), checked: false };
  const vars = new Map<string, Node>();
  if (p.eat('=>')) {
    collectConstruction(p.expr(), out, vars);
  } else if (p.is('{')) {
    collectBlock(p.block(), out, vars, 0);
  } else return undefined;

  const ctx: Ctx = { jsonVar, enums, typeParams: new Set(typeParams) };
  const fields: XField[] = [];
  for (const f of out.fields) {
    let value = f.value;
    let src: Src = { vars: new Set() };
    let key = f.key;
    if (f.srcVar) src = { vars: new Set([f.srcVar]), key };
    const ch = unwrapChecked(value);
    if (ch) {
      key = ch.key;
      src = { vars: new Set([ch.srcVar]), key };
      value = ch.body;
    }
    let c: Conv;
    try {
      c = conv(value, ctx, src);
    } catch {
      c = { type: unknown('?'), nullable: true, hasDefault: false };
    }
    key = key ?? src.key;
    if (key === undefined) {
      // a constructor argument that doesn't read json (e.g. a constant), or `_readX(json, 'key')`
      const rv = readValueKey(value, jsonVar);
      if (rv === undefined) continue;
      key = rv;
      c = { type: unknown('readValue'), nullable: true, hasDefault: false };
    }
    const field: XField = {
      key,
      dartName: f.name ?? camelFromKey(key),
      type: c.type,
      nullable: c.nullable,
      hasDefault: c.hasDefault,
    };
    if (f.positional !== undefined && !f.name) field.positional = f.positional;
    if (out.required.has(key)) field.requiredKey = true;
    if (out.disallowNull.has(key)) field.disallowNull = true;
    fields.push(field);
  }
  const model: XModel = { name, generatedFile: file, fields, fn, generatedLine: lineOf(toks[i].pos) };
  if (out.checked) model.checked = true;
  if (out.constructed) model.constructed = out.constructed;
  if (typeParams.length) model.typeParams = typeParams;
  return model;
}

/** `_readX(json, 'key')` (JsonKey.readValue): the key, else undefined. */
function readValueKey(n: Node, jsonVar: string, depth = 0): string | undefined {
  if (depth > 30) return undefined;
  if (n.k === 'call') {
    const a0 = n.args[0]?.value;
    const a1 = n.args[1]?.value;
    if (a0?.k === 'id' && a0.name === jsonVar && a1?.k === 'str') return a1.v;
    for (const a of n.args) {
      const k = readValueKey(a.value, jsonVar, depth + 1);
      if (k !== undefined) return k;
    }
    return readValueKey(n.callee, jsonVar, depth + 1);
  }
  if (n.k === 'as' || n.k === 'is') return readValueKey(n.expr, jsonVar, depth + 1);
  if (n.k === 'member') return readValueKey(n.obj, jsonVar, depth + 1);
  if (n.k === 'bin') return readValueKey(n.l, jsonVar, depth + 1) ?? readValueKey(n.r, jsonVar, depth + 1);
  if (n.k === 'cond') return readValueKey(n.a, jsonVar, depth + 1) ?? readValueKey(n.b, jsonVar, depth + 1);
  return undefined;
}

/** Human type text for messages: "String", "int?", "List<Item>", "enum Role(admin|user)". */
export function describeType(t: XType, nullable = false): string {
  const q = nullable ? '?' : '';
  switch (t.kind) {
    case 'string':
      return `String${q}`;
    case 'int':
      return `int${q}`;
    case 'double':
      return `double${q}`;
    case 'num':
      return `num${q}`;
    case 'bool':
      return `bool${q}`;
    case 'dynamic':
      return nullable ? 'dynamic' : 'Object';
    case 'datetime':
      return `DateTime${q}`;
    case 'uri':
      return `Uri${q}`;
    case 'bigint':
      return `BigInt${q}`;
    case 'list':
      return `List<${describeType(t.of as XType, !!t.elemNullable)}>${q}`;
    case 'map':
      return `Map<String, ${describeType(t.of as XType, !!t.elemNullable)}>${q}`;
    case 'model':
      return `${t.name}${q}`;
    case 'enum': {
      const vals = t.values.slice(0, 8).join('|') + (t.values.length > 8 ? '|…' : '');
      return `enum ${t.name}(${vals})${q}`;
    }
    default:
      return t.text;
  }
}
