// CONTRACTS §16.3: reads one protoc_plugin output file (`*.pb.dart`, `*.pbenum.dart`, `*.pbgrpc.dart`) into
// unlinked declarations. Token-level only (the repo's Dart tokenizer), never evaluates anything, never throws.
// Covers protoc_plugin 21.x–25.x output (BuilderInfo chains `a`, `aOS`, `aOB`, `aQS`, `aI`, `aD`, `aE`,
// `aInt64`, `aOM`, `aQM`, `e`, `p`, `pc`, `pPS`, `pPM`, `pPE`, `m`, `oo`; `ClientMethod` / `ServiceMethod`).

import { lineIndex, Tok, tokenize } from '../contract/dart';

/** A Dart type reference as written: `$2.Money` → {prefix: '$2', cls: 'Money'}. */
export interface TypeRef {
  prefix?: string;
  cls: string;
}

export interface ParsedField {
  number: number;
  name: string;
  /** PbFieldType code (`OS`, `KU6`, `PM`, …); undefined only for maps. */
  code?: string;
  ref?: TypeRef;
  map?: { keyCode: string; valueCode: string; valueRef?: TypeRef };
  oneof?: string;
}

export interface ParsedMessage {
  dartClass: string;
  /** Name as in the BuilderInfo, relative to the package: `Order.Line`. */
  relName: string;
  pkg: string;
  fields: ParsedField[];
  line: number;
}

export interface ParsedEnum {
  dartClass: string;
  values: { name: string; number: number }[];
  line: number;
}

export interface ParsedClientMethod {
  path: string;
  req?: TypeRef;
  res?: TypeRef;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
  line: number;
}

export interface ParsedServiceMethod {
  path: string;
  req?: TypeRef;
  res?: TypeRef;
  clientStreaming: boolean;
  serverStreaming: boolean;
  line: number;
}

export interface ParsedFile {
  path: string;
  imports: { uri: string; prefix?: string }[];
  exports: string[];
  messages: ParsedMessage[];
  enums: ParsedEnum[];
  clientMethods: ParsedClientMethod[];
  serviceMethods: ParsedServiceMethod[];
  problems: string[];
}

const OPEN = new Set(['(', '[', '{', '?[']);
const CLOSE = new Set([')', ']', '}']);

const isP = (t: Tok | undefined, v: string) => !!t && t.k === 'punct' && t.v === v;
const isId = (t: Tok | undefined, v?: string) => !!t && t.k === 'id' && (v === undefined || t.v === v);

/** Index of the bracket closing the one at `i` (`(`, `[`, `{`); the last index when unbalanced. */
function matching(toks: Tok[], i: number): number {
  let d = 0;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j];
    if (t.k !== 'punct') continue;
    if (OPEN.has(t.v)) d++;
    else if (CLOSE.has(t.v)) {
      d--;
      if (d === 0) return j;
    }
  }
  return toks.length - 1;
}

/** Index of the `>` closing the `<` at `i` (type arguments only); -1 when it isn't one. */
function matchingAngle(toks: Tok[], i: number): number {
  let d = 0;
  for (let j = i; j < toks.length && j < i + 200; j++) {
    const t = toks[j];
    if (t.k === 'punct') {
      if (t.v === '<') d++;
      else if (t.v === '>') {
        d--;
        if (d === 0) return j;
      } else if (t.v === '(' || t.v === ')' || t.v === '{' || t.v === '}' || t.v === ';' || t.v === '=') return -1;
    }
  }
  return -1;
}

/** Splits `toks(open, close)` at top-level commas: `[start, end)` ranges, empty trailing range dropped. */
function splitArgs(toks: Tok[], open: number, close: number): [number, number][] {
  const out: [number, number][] = [];
  let start = open + 1;
  let d = 0;
  for (let j = open + 1; j < close; j++) {
    const t = toks[j];
    if (t.k !== 'punct') continue;
    if (OPEN.has(t.v) || t.v === '<') d++;
    else if (CLOSE.has(t.v) || t.v === '>') d--;
    else if (t.v === ',' && d <= 0) {
      out.push([start, j]);
      start = j + 1;
    }
  }
  if (start < close) out.push([start, close]);
  return out;
}

interface Args {
  positional: [number, number][];
  named: Map<string, [number, number]>;
}

function readArgs(toks: Tok[], open: number, close: number): Args {
  const positional: [number, number][] = [];
  const named = new Map<string, [number, number]>();
  for (const [s, e] of splitArgs(toks, open, close)) {
    if (isId(toks[s]) && isP(toks[s + 1], ':')) named.set(toks[s].v, [s + 2, e]);
    else positional.push([s, e]);
  }
  return { positional, named };
}

/** Last string literal in a range (`_omitFieldNames ? '' : 'userId'` → userId). */
function lastStr(toks: Tok[], r: [number, number] | undefined): string | undefined {
  if (!r) return undefined;
  for (let j = r[1] - 1; j >= r[0]; j--) if (toks[j].k === 'str') return toks[j].v;
  return undefined;
}

function intAt(toks: Tok[], r: [number, number] | undefined): number | undefined {
  if (!r) return undefined;
  let s = r[0];
  let neg = false;
  if (isP(toks[s], '-')) {
    neg = true;
    s++;
  }
  const t = toks[s];
  if (!t || t.k !== 'num' || s + 1 !== r[1]) return undefined;
  const n = t.v.startsWith('0x') || t.v.startsWith('0X') ? parseInt(t.v.slice(2).replace(/_/g, ''), 16) : Number(t.v.replace(/_/g, ''));
  if (!Number.isSafeInteger(n)) return undefined;
  return neg ? -n : n;
}

/** `$pb.PbFieldType.OU6` (or `PbFieldType.OU6`) inside a range → `OU6`. */
function fieldTypeCode(toks: Tok[], r: [number, number] | undefined): string | undefined {
  if (!r) return undefined;
  for (let j = r[0]; j + 2 < r[1] + 1; j++) {
    if (isId(toks[j], 'PbFieldType') && isP(toks[j + 1], '.') && isId(toks[j + 2])) return toks[j + 2].v;
  }
  return undefined;
}

/** Reads a type at `i`: `[prefix.]Name[<…>]`; returns the ref of the outermost name and the next index. */
function typeRefAt(toks: Tok[], i: number): { ref: TypeRef; args: TypeRef[]; next: number } | undefined {
  if (!isId(toks[i])) return undefined;
  let prefix: string | undefined;
  let cls = toks[i].v;
  let j = i + 1;
  if (isP(toks[j], '.') && isId(toks[j + 1])) {
    prefix = cls;
    cls = toks[j + 1].v;
    j += 2;
  }
  const args: TypeRef[] = [];
  if (isP(toks[j], '<')) {
    const close = matchingAngle(toks, j);
    if (close < 0) return undefined;
    let k = j + 1;
    while (k < close) {
      const a = typeRefAt(toks, k);
      if (!a) break;
      args.push(a.ref);
      k = a.next;
      if (isP(toks[k], ',')) k++;
      else break;
    }
    j = close + 1;
  }
  if (isP(toks[j], '?')) j++;
  return { ref: prefix ? { prefix, cls } : { cls }, args, next: j };
}

/** A reference taken from `subBuilder: X.create` / `enumValues: X.values` / `valueOf: X.valueOf` / `valueCreator: …`. */
function refFromMember(toks: Tok[], r: [number, number] | undefined): TypeRef | undefined {
  if (!r) return undefined;
  const t = typeRefAt(toks, r[0]);
  if (!t) return undefined;
  // `$2.Money.create` reads as prefix $2, cls Money, then `.create`; `Money.create` as prefix Money, cls create.
  const after = toks[t.next];
  if (t.ref.prefix && !isP(after, '.')) {
    // `X.values` with no import prefix
    return { cls: t.ref.prefix };
  }
  return t.ref;
}

const SCALAR_CORE = new Set(['int', 'double', 'bool', 'String', 'List', 'Int64', 'num', 'Object', 'dynamic']);
const isCoreRef = (r: TypeRef | undefined) =>
  !r || r.prefix === '$core' || r.prefix === '$fixnum' || (!r.prefix && SCALAR_CORE.has(r.cls));

const DEFAULT_CODES: Record<string, string> = {
  aOS: 'OS',
  aOB: 'OB',
  aQS: 'QS',
  aInt64: 'O6',
  aI: 'O3',
  aD: 'OD',
  aE: 'OE',
  aOM: 'OM',
  aQM: 'QM',
  pPS: 'PS',
  pPM: 'PM',
  pPE: 'PE',
};
/** Methods whose third positional argument is the field type. */
const POSITIONAL_CODE = new Set(['a', 'e', 'p', 'pc', 'add']);

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

export function parseGeneratedFile(path: string, text: string): ParsedFile {
  const file: ParsedFile = {
    path,
    imports: [],
    exports: [],
    messages: [],
    enums: [],
    clientMethods: [],
    serviceMethods: [],
    problems: [],
  };
  let toks: Tok[];
  try {
    toks = tokenize(text);
  } catch (e) {
    file.problems.push(`${path}: couldn't read the file (${(e as Error).message})`);
    return file;
  }
  const lineOf = lineIndex(text);
  const n = toks.length;
  for (let i = 0; i < n; i++) {
    const t = toks[i];
    if (t.k !== 'id') continue;
    try {
      if ((t.v === 'import' || t.v === 'export') && toks[i + 1]?.k === 'str') {
        const uri = toks[i + 1].v;
        let j = i + 2;
        let prefix: string | undefined;
        while (j < n && !isP(toks[j], ';')) {
          if (isId(toks[j], 'as') && isId(toks[j + 1])) prefix = toks[j + 1].v;
          j++;
        }
        if (t.v === 'import') file.imports.push(prefix ? { uri, prefix } : { uri });
        else file.exports.push(uri);
        i = j;
        continue;
      }
      if (t.v === 'class' && isId(toks[i + 1])) {
        const name = toks[i + 1].v;
        let j = i + 2;
        while (j < n && !isP(toks[j], '{') && !isP(toks[j], ';')) j++;
        if (!isP(toks[j], '{')) continue;
        const header = toks.slice(i + 2, j).map((x) => x.v);
        const close = matching(toks, j);
        const kind = header.includes('GeneratedMessage')
          ? 'message'
          : header.includes('ProtobufEnum')
            ? 'enum'
            : header.includes('Client') && header.includes('extends')
              ? 'client'
              : header.includes('Service') && header.includes('extends')
                ? 'service'
                : undefined;
        try {
          if (kind === 'message') parseMessageClass(file, toks, name, j, close, lineOf(t.pos));
          else if (kind === 'enum') parseEnumClass(file, toks, name, j, close, lineOf(t.pos));
          else if (kind === 'client') parseClientClass(file, toks, j, close, lineOf);
          else if (kind === 'service') parseServiceClass(file, toks, j, close, lineOf);
        } catch (e) {
          file.problems.push(`${path}: couldn't read class ${name} (${(e as Error).message})`);
        }
        i = close;
      }
    } catch (e) {
      file.problems.push(`${path}: couldn't read the file near line ${lineOf(t.pos)} (${(e as Error).message})`);
    }
  }
  return file;
}

function parseMessageClass(file: ParsedFile, toks: Tok[], dartClass: string, open: number, close: number, line: number): void {
  // Oneof names: `static const $core.Map<$core.int, Order_Payment> _Order_PaymentByTag = {10: Order_Payment.cardToken, …}`.
  const oneofByTag = new Map<number, string>();
  for (let j = open; j < close; j++) {
    const t = toks[j];
    if (t.k === 'id' && t.v.startsWith('_') && t.v.endsWith('ByTag') && isP(toks[j + 1], '=') && isP(toks[j + 2], '{')) {
      const enumCls = t.v.slice(1, -'ByTag'.length);
      const bare = enumCls.startsWith(`${dartClass}_`) ? enumCls.slice(dartClass.length + 1) : enumCls;
      const oneofName = lowerFirst(bare);
      const end = matching(toks, j + 2);
      for (const [s, e] of splitArgs(toks, j + 2, end)) {
        const tag = intAt(toks, [s, Math.min(e, s + (isP(toks[s], '-') ? 2 : 1))]);
        if (tag !== undefined && isP(toks[s + 1], ':')) oneofByTag.set(tag, oneofName);
      }
      j = end;
    }
  }

  // The BuilderInfo constructor and its `..` chain.
  let b = -1;
  for (let j = open; j < close; j++) {
    if (isId(toks[j], 'BuilderInfo') && isP(toks[j + 1], '(')) {
      b = j;
      break;
    }
  }
  if (b < 0) throw new Error('no BuilderInfo');
  const argsClose = matching(toks, b + 1);
  const args = readArgs(toks, b + 1, argsClose);
  const relName = lastStr(toks, args.positional[0]) || dartClass.replace(/_/g, '.');
  const pkg = lastStr(toks, args.named.get('package')) ?? '';
  const fields: ParsedField[] = [];
  const oneofIndex = new Map<number, number>();
  let j = argsClose + 1;
  while (j < close && isP(toks[j], '..')) {
    const nameTok = toks[j + 1];
    if (!isId(nameTok)) break;
    const method = nameTok.v;
    j += 2;
    const typeArgs: TypeRef[] = [];
    if (isP(toks[j], '<')) {
      const angleClose = matchingAngle(toks, j);
      if (angleClose < 0) break;
      let k = j + 1;
      while (k < angleClose) {
        const a = typeRefAt(toks, k);
        if (!a) break;
        typeArgs.push(a.ref);
        k = a.next;
        if (isP(toks[k], ',')) k++;
        else break;
      }
      j = angleClose + 1;
    }
    if (isP(toks[j], '=')) {
      // `..hasRequiredFields = false`: skip the value
      j++;
      let d = 0;
      while (j < close) {
        const t = toks[j];
        if (t.k === 'punct' && OPEN.has(t.v)) d++;
        else if (t.k === 'punct' && CLOSE.has(t.v)) d--;
        else if (d === 0 && t.k === 'punct' && (t.v === '..' || t.v === ';')) break;
        j++;
      }
      continue;
    }
    if (!isP(toks[j], '(')) break;
    const cClose = matching(toks, j);
    const a = readArgs(toks, j, cClose);
    j = cClose + 1;
    if (method === 'oo') {
      const idx = intAt(toks, a.positional[0]);
      const list = a.positional[1];
      if (idx !== undefined && list && isP(toks[list[0]], '[')) {
        for (const [s, e] of splitArgs(toks, list[0], matching(toks, list[0]))) {
          const tag = intAt(toks, [s, e]);
          if (tag !== undefined) oneofIndex.set(tag, idx);
        }
      }
      continue;
    }
    const number = intAt(toks, a.positional[0]);
    const name = lastStr(toks, a.positional[1]);
    if (number === undefined || number <= 0 || name === undefined) continue; // addUnused / customised chains
    if (method === 'm') {
      const keyCode = fieldTypeCode(toks, a.named.get('keyFieldType'));
      const valueCode = fieldTypeCode(toks, a.named.get('valueFieldType'));
      if (!keyCode || !valueCode) continue;
      let valueRef: TypeRef | undefined = typeArgs[1];
      if (isCoreRef(valueRef)) valueRef = undefined;
      valueRef ??=
        refFromMember(toks, a.named.get('valueCreator')) ??
        refFromMember(toks, a.named.get('enumValues')) ??
        refFromMember(toks, a.named.get('valueOf'));
      fields.push({ number, name, map: { keyCode, valueCode, valueRef } });
      continue;
    }
    let code = fieldTypeCode(toks, a.named.get('fieldType'));
    if (!code && POSITIONAL_CODE.has(method)) code = fieldTypeCode(toks, a.positional[2]);
    code ??= DEFAULT_CODES[method];
    if (!code) continue;
    let ref: TypeRef | undefined = typeArgs[0];
    if (isCoreRef(ref)) ref = undefined;
    ref ??=
      refFromMember(toks, a.named.get('subBuilder')) ??
      refFromMember(toks, a.named.get('enumValues')) ??
      refFromMember(toks, a.named.get('valueOf'));
    fields.push({ number, name, code, ref });
  }
  for (const f of fields) {
    const idx = oneofIndex.get(f.number);
    if (idx !== undefined) f.oneof = oneofByTag.get(f.number) ?? `oneof${idx}`;
  }
  file.messages.push({ dartClass, relName, pkg, fields, line });
}

function parseEnumClass(file: ParsedFile, toks: Tok[], dartClass: string, open: number, close: number, line: number): void {
  const values: { name: string; number: number }[] = [];
  const seen = new Set<string>();
  // static const Color RED = Color._(1, _omitEnumNames ? '' : 'RED');
  for (let j = open; j < close; j++) {
    if (
      isId(toks[j], 'static') &&
      isId(toks[j + 1], 'const') &&
      isId(toks[j + 2], dartClass) &&
      isId(toks[j + 3]) &&
      isP(toks[j + 4], '=') &&
      isId(toks[j + 5], dartClass) &&
      isP(toks[j + 6], '.') &&
      isId(toks[j + 7], '_') &&
      isP(toks[j + 8], '(')
    ) {
      const c = matching(toks, j + 8);
      const a = readArgs(toks, j + 8, c);
      const num = intAt(toks, a.positional[0]);
      const name = lastStr(toks, a.positional[1]) || toks[j + 3].v;
      if (num !== undefined && !seen.has(name)) {
        seen.add(name);
        values.push({ name, number: num });
      }
      j = c;
    }
  }
  file.enums.push({ dartClass, values, line });
}

/** Method declarations at class-body level: `ReturnType name(params) {…}`. */
function* classMethods(toks: Tok[], open: number, close: number): Generator<{ retStart: number; name: string; params: [number, number]; body: [number, number] }> {
  let j = open + 1;
  let stmtStart = j;
  while (j < close) {
    const t = toks[j];
    if (t.k === 'punct' && (t.v === ';' || t.v === '}')) {
      j++;
      stmtStart = j;
      continue;
    }
    if (t.k === 'punct' && t.v === '(' && isId(toks[j - 1])) {
      const pClose = matching(toks, j);
      if (isP(toks[pClose + 1], '{')) {
        const bClose = matching(toks, pClose + 1);
        yield { retStart: stmtStart, name: toks[j - 1].v, params: [j, pClose], body: [pClose + 1, bClose] };
        j = bClose + 1;
        stmtStart = j;
        continue;
      }
      j = pClose + 1;
      continue;
    }
    if (t.k === 'punct' && (t.v === '[' || t.v === '{' || t.v === '?[')) {
      j = matching(toks, j) + 1;
      continue;
    }
    j++;
  }
}

function parseClientClass(file: ParsedFile, toks: Tok[], open: number, close: number, lineOf: (p: number) => number): void {
  const byVar = new Map<string, ParsedClientMethod>();
  for (let j = open; j < close; j++) {
    if (isId(toks[j], 'ClientMethod') && isP(toks[j + 1], '<')) {
      const angle = matchingAngle(toks, j + 1);
      if (angle < 0 || !isP(toks[angle + 1], '(')) continue;
      const req = typeRefAt(toks, j + 2);
      const res = req && isP(toks[req.next], ',') ? typeRefAt(toks, req.next + 1) : undefined;
      const c = matching(toks, angle + 1);
      const a = readArgs(toks, angle + 1, c);
      const pathTok = a.positional[0] ? toks[a.positional[0][0]] : undefined;
      if (!pathTok || pathTok.k !== 'str') continue;
      // `static final _$getOrder = $grpc.ClientMethod<…>(`
      let k = j - 1;
      while (k > open && !isP(toks[k], '=')) k--;
      const varName = isId(toks[k - 1]) ? toks[k - 1].v : '';
      const m: ParsedClientMethod = { path: pathTok.v, req: req?.ref, res: res?.ref, line: lineOf(pathTok.pos) };
      file.clientMethods.push(m);
      if (varName) byVar.set(varName, m);
      j = c;
    }
  }
  for (const meth of classMethods(toks, open, close)) {
    let callVar: string | undefined;
    for (let k = meth.body[0]; k < meth.body[1]; k++) {
      const t = toks[k];
      if ((isId(t, '$createUnaryCall') || isId(t, '$createStreamingCall')) && isP(toks[k + 1], '(') && isId(toks[k + 2])) {
        callVar = toks[k + 2].v;
        break;
      }
    }
    const m = callVar ? byVar.get(callVar) : undefined;
    if (!m) continue;
    let serverStreaming = false;
    for (let k = meth.retStart; k < meth.params[0]; k++) if (isId(toks[k], 'ResponseStream')) serverStreaming = true;
    const params = splitArgs(toks, meth.params[0], meth.params[1]);
    let clientStreaming = false;
    if (params[0]) {
      const p = typeRefAt(toks, params[0][0]);
      clientStreaming = !!p && p.ref.cls === 'Stream';
    }
    m.clientStreaming = clientStreaming;
    m.serverStreaming = serverStreaming;
  }
}

function parseServiceClass(file: ParsedFile, toks: Tok[], open: number, close: number, lineOf: (p: number) => number): void {
  let service: string | undefined;
  for (let j = open; j < close; j++) {
    if (isId(toks[j], 'get') && isId(toks[j + 1], '$name') && isP(toks[j + 2], '=>') && toks[j + 3]?.k === 'str') {
      service = toks[j + 3].v;
      break;
    }
  }
  if (!service) return;
  for (let j = open; j < close; j++) {
    if (isId(toks[j], 'ServiceMethod') && isP(toks[j + 1], '<')) {
      const angle = matchingAngle(toks, j + 1);
      if (angle < 0 || !isP(toks[angle + 1], '(')) continue;
      const req = typeRefAt(toks, j + 2);
      const res = req && isP(toks[req.next], ',') ? typeRefAt(toks, req.next + 1) : undefined;
      const c = matching(toks, angle + 1);
      const a = readArgs(toks, angle + 1, c);
      const nameTok = a.positional[0] ? toks[a.positional[0][0]] : undefined;
      const cs = a.positional[2] ? toks[a.positional[2][0]] : undefined;
      const ss = a.positional[3] ? toks[a.positional[3][0]] : undefined;
      if (nameTok?.k !== 'str') continue;
      file.serviceMethods.push({
        path: `/${service}/${nameTok.v}`,
        req: req?.ref,
        res: res?.ref,
        clientStreaming: isId(cs, 'true'),
        serverStreaming: isId(ss, 'true'),
        line: lineOf(nameTok.pos),
      });
      j = c;
    }
  }
}
