// CONTRACTS §16.3: protobuf binary ⇄ proto3 JSON with a GrpcSchema, raw (`protoc --decode_raw` style)
// decoding, and example JSON. Pure and bounded: ≤ 4 MB input, ≤ 100k fields, nesting ≤ 32.

import type { DecodeResult, GrpcSchema, ProtoField, ProtoFieldType, ProtoMessage, ProtoScalar, RawField } from './types';
import {
  float32FromBits,
  float64FromBits,
  fromBase64,
  i64,
  jsonFloat,
  MAX_DEPTH,
  MAX_FIELDS,
  MAX_INPUT_BYTES,
  printableUtf8,
  Reader,
  shortestFloat32,
  toBase64,
  u64,
  utf8Decode,
  utf8Encode,
  WireError,
  WireType,
  Writer,
  zigzag32,
  zigzag64,
} from './wire';
import {
  fieldMaskFromJson,
  fieldMaskToJson,
  formatDuration,
  formatTimestamp,
  hasSpecialJson,
  parseDuration,
  parseTimestamp,
  wrapperScalar,
} from './wkt';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

const ANY = 'google.protobuf.Any';

/** Own data property, also for `__proto__` (a plain assignment would set the prototype and drop the entry). */
function setOwn(o: JsonObject, k: string, v: Json): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}
const VALUE = 'google.protobuf.Value';

// ---------------------------------------------------------------------------------------------
// Field indexes (cached per message object)

interface MsgIndex {
  byNumber: Map<number, ProtoField>;
  byKey: Map<string, ProtoField>;
  sorted: ProtoField[];
}

const indexCache = new WeakMap<ProtoMessage, MsgIndex>();

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function indexOf(msg: ProtoMessage): MsgIndex {
  let idx = indexCache.get(msg);
  if (idx) return idx;
  const byNumber = new Map<number, ProtoField>();
  const byKey = new Map<string, ProtoField>();
  for (const f of msg.fields) {
    if (!byNumber.has(f.number)) byNumber.set(f.number, f);
    if (!byKey.has(f.name)) byKey.set(f.name, f);
  }
  for (const f of msg.fields) {
    const snake = camelToSnake(f.name);
    if (!byKey.has(snake)) byKey.set(snake, f);
  }
  idx = { byNumber, byKey, sorted: [...byNumber.values()].sort((a, b) => a.number - b.number) };
  indexCache.set(msg, idx);
  return idx;
}

const VARINT_SCALARS = new Set<ProtoScalar>(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool']);
const FIXED64_SCALARS = new Set<ProtoScalar>(['double', 'fixed64', 'sfixed64']);
const FIXED32_SCALARS = new Set<ProtoScalar>(['float', 'fixed32', 'sfixed32']);

/** Wire type of a single value of this type. */
function wireTypeOf(t: ProtoFieldType): WireType {
  if (t.kind === 'enum') return 0;
  if (t.kind !== 'scalar') return 2;
  if (VARINT_SCALARS.has(t.scalar)) return 0;
  if (FIXED64_SCALARS.has(t.scalar)) return 1;
  if (FIXED32_SCALARS.has(t.scalar)) return 5;
  return 2;
}

const isPackable = (t: ProtoFieldType) => t.kind === 'enum' || (t.kind === 'scalar' && t.scalar !== 'string' && t.scalar !== 'bytes');

// ---------------------------------------------------------------------------------------------
// Raw decoding (no schema)

interface RawCtx {
  work: number;
}

const WORK_LIMIT = 4_000_000;

/** Parses `buf[start, end)` as fields; throws WireError. Returns the fields and how many there are, nested included. */
function parseRaw(buf: Uint8Array, start: number, end: number, depth: number, ctx: RawCtx): { fields: RawField[]; count: number } {
  if (depth > MAX_DEPTH) throw new WireError(`nested deeper than ${MAX_DEPTH} messages`);
  const r = new Reader(buf, start, end);
  const fields: RawField[] = [];
  let count = 0;
  while (!r.done) {
    if (++ctx.work > WORK_LIMIT) throw new WireError(`more than ${MAX_FIELDS} fields`);
    const [number, wt] = r.tag();
    switch (wt) {
      case 0: {
        const [lo, hi] = r.varint();
        fields.push({ number, wireType: 0, value: u64(lo, hi).toString(), as: 'varint' });
        break;
      }
      case 1: {
        const [lo, hi] = r.fixed64();
        fields.push({ number, wireType: 1, value: u64(lo, hi).toString(), as: 'fixed64' });
        break;
      }
      case 5:
        fields.push({ number, wireType: 5, value: String(r.fixed32()), as: 'fixed32' });
        break;
      case 2: {
        const [s, e] = r.bytesRange();
        const g = guessLengthDelimited(buf, s, e, depth, ctx);
        count += g.count;
        fields.push({ number, wireType: 2, value: g.value, as: g.as });
        break;
      }
      default:
        r.skip(wt); // groups: throws
    }
    count++;
  }
  if (count > MAX_FIELDS) throw new WireError(`more than ${MAX_FIELDS} fields`);
  return { fields, count };
}

/**
 * A message if it parses completely, else printable UTF-8 text, else bytes (base64). Text without tab / newline /
 * carriage return is taken as text without trying (`"hi"` would also parse as field 13 = 105): a message almost
 * always has a control character among its tags and lengths, and those three are the tags of field 1.
 */
function guessLengthDelimited(
  buf: Uint8Array,
  s: number,
  e: number,
  depth: number,
  ctx: RawCtx,
): { value: string | RawField[]; as: 'string' | 'message' | 'bytes'; count: number } {
  const sub = buf.subarray(s, e);
  const text = printableUtf8(sub);
  if (text !== undefined && !/[\t\n\r]/.test(text)) return { value: text, as: 'string', count: 0 };
  if (depth + 1 <= MAX_DEPTH && ctx.work < WORK_LIMIT) {
    try {
      const inner = parseRaw(buf, s, e, depth + 1, ctx);
      if (inner.fields.length) return { value: inner.fields, as: 'message', count: inner.count };
    } catch (err) {
      if (!(err instanceof WireError)) throw err;
    }
  }
  if (text !== undefined) return { value: text, as: 'string', count: 0 };
  return { value: toBase64(sub), as: 'bytes', count: 0 };
}

export function decodeRaw(bytes: Uint8Array): { fields?: RawField[]; error?: string } {
  try {
    if (!(bytes instanceof Uint8Array)) return { error: 'expected bytes' };
    if (bytes.length > MAX_INPUT_BYTES) return { error: `larger than ${MAX_INPUT_BYTES} bytes` };
    return { fields: parseRaw(bytes, 0, bytes.length, 0, { work: 0 }).fields };
  } catch (e) {
    return { error: plain(e) };
  }
}

/** Raw fields as JSON: `{"#1": "…", "#2": {…}}`, repeated numbers as arrays. */
function rawToJson(fields: RawField[]): JsonObject {
  const out: JsonObject = {};
  const groups = new Map<number, Json[]>();
  for (const f of fields) {
    const v: Json = Array.isArray(f.value) ? rawToJson(f.value) : f.value;
    const list = groups.get(f.number) ?? [];
    list.push(v);
    groups.set(f.number, list);
  }
  for (const n of [...groups.keys()].sort((a, b) => a - b)) {
    const list = groups.get(n)!;
    out[`#${n}`] = list.length === 1 ? list[0] : list;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Schema decoding

interface DecodeCtx {
  schema: GrpcSchema;
  fields: number;
  raw: RawCtx;
}

function plain(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function decodeMessage(schema: GrpcSchema, type: string, bytes: Uint8Array): DecodeResult {
  try {
    if (!(bytes instanceof Uint8Array)) return { error: 'expected bytes' };
    if (bytes.length > MAX_INPUT_BYTES) return { error: `larger than ${MAX_INPUT_BYTES} bytes` };
    const msg = schema?.message(type);
    if (!msg) return { error: `unknown message type ${type}` };
    const ctx: DecodeCtx = { schema, fields: 0, raw: { work: 0 } };
    return { json: decodeMsg(ctx, msg, bytes, 0, bytes.length, 0) };
  } catch (e) {
    return { error: plain(e) };
  }
}

/** Decodes the bytes of a field whose message type isn't in the schema: raw fields, else base64. */
function decodeOpaque(ctx: DecodeCtx, buf: Uint8Array, s: number, e: number, depth: number): Json {
  try {
    const r = parseRaw(buf, s, e, depth + 1, ctx.raw);
    ctx.fields += r.count;
    return rawToJson(r.fields);
  } catch (err) {
    if (!(err instanceof WireError)) throw err;
    return toBase64(buf.subarray(s, e));
  }
}

function decodeMsg(ctx: DecodeCtx, msg: ProtoMessage, buf: Uint8Array, start: number, end: number, depth: number): Json {
  if (depth > MAX_DEPTH) throw new WireError(`nested deeper than ${MAX_DEPTH} messages`);
  const idx = indexOf(msg);
  const r = new Reader(buf, start, end);
  const values = new Map<ProtoField, Json | Json[] | Map<string, Json>>();
  const chunks = new Map<ProtoField, [number, number][]>();
  const oneofs = new Map<string, ProtoField>();
  const unknown = new Map<number, Json[]>();

  const setOneof = (f: ProtoField) => {
    if (!f.oneof) return;
    const prev = oneofs.get(f.oneof);
    if (prev && prev !== f) {
      values.delete(prev);
      chunks.delete(prev);
    }
    oneofs.set(f.oneof, f);
  };

  while (!r.done) {
    if (++ctx.fields > MAX_FIELDS) throw new WireError(`more than ${MAX_FIELDS} fields`);
    const [no, wt] = r.tag();
    const f = idx.byNumber.get(no);
    const t = f?.type;
    if (f && t) {
      const expected = wireTypeOf(t);
      if (t.kind === 'map' && wt === 2) {
        const [s, e] = r.bytesRange();
        let m = values.get(f) as Map<string, Json> | undefined;
        if (!m) values.set(f, (m = new Map()));
        const [k, v] = decodeMapEntry(ctx, t, buf, s, e, depth);
        m.set(k, v);
        continue;
      }
      if (t.kind === 'message' && wt === 2) {
        const [s, e] = r.bytesRange();
        if (f.repeated) {
          let list = values.get(f) as Json[] | undefined;
          if (!list) values.set(f, (list = []));
          list.push(decodeMessageValue(ctx, t.type, buf, s, e, depth));
        } else {
          setOneof(f);
          const list = chunks.get(f) ?? [];
          list.push([s, e]);
          chunks.set(f, list);
        }
        continue;
      }
      if ((t.kind === 'scalar' || t.kind === 'enum') && wt === expected) {
        const v = readValue(ctx, t, r);
        if (f.repeated) {
          let list = values.get(f) as Json[] | undefined;
          if (!list) values.set(f, (list = []));
          list.push(v);
        } else {
          setOneof(f);
          values.set(f, v);
        }
        continue;
      }
      if (f.repeated && isPackable(t) && wt === 2) {
        const [s, e] = r.bytesRange();
        let list = values.get(f) as Json[] | undefined;
        if (!list) values.set(f, (list = []));
        const pr = new Reader(buf, s, e);
        while (!pr.done) {
          if (++ctx.fields > MAX_FIELDS) throw new WireError(`more than ${MAX_FIELDS} fields`);
          list.push(readValue(ctx, t as ProtoFieldType & { kind: 'scalar' | 'enum' }, pr));
        }
        continue;
      }
    }
    // Unknown field number, or a wire type that doesn't match the schema: keep it raw.
    const list = unknown.get(no) ?? [];
    list.push(readUnknown(ctx, r, wt, depth));
    unknown.set(no, list);
  }

  const out: JsonObject = {};
  for (const f of msg.fields) {
    const t = f.type;
    if (chunks.has(f) && t.kind === 'message') {
      const parts = chunks.get(f)!;
      if (parts.length === 1) setOwn(out, f.name, decodeMessageValue(ctx, t.type, buf, parts[0][0], parts[0][1], depth));
      else {
        // A singular message sent in pieces is merged: decode the concatenation.
        const total = parts.reduce((n, [s, e]) => n + (e - s), 0);
        const joined = new Uint8Array(total);
        let o = 0;
        for (const [s, e] of parts) {
          joined.set(buf.subarray(s, e), o);
          o += e - s;
        }
        setOwn(out, f.name, decodeMessageValue(ctx, t.type, joined, 0, joined.length, depth));
      }
      continue;
    }
    if (!values.has(f)) continue;
    const v = values.get(f)!;
    if (v instanceof Map) {
      const obj: JsonObject = {};
      for (const [k, x] of v) setOwn(obj, k, x);
      setOwn(out, f.name, obj);
    } else if (t.kind === 'enum') {
      setOwn(out, f.name, Array.isArray(v) ? v.map((x) => enumJson(ctx.schema, t.type, x)) : enumJson(ctx.schema, t.type, v));
    } else setOwn(out, f.name, v as Json);
  }
  for (const n of [...unknown.keys()].sort((a, b) => a - b)) {
    const list = unknown.get(n)!;
    out[`#${n}`] = list.length === 1 ? list[0] : list;
  }
  return hasSpecialJson(msg.name) ? wktToJson(ctx, msg.name, out, depth) : out;
}

function readUnknown(ctx: DecodeCtx, r: Reader, wt: number, depth: number): Json {
  switch (wt) {
    case 0: {
      const [lo, hi] = r.varint();
      return u64(lo, hi).toString();
    }
    case 1: {
      const [lo, hi] = r.fixed64();
      return u64(lo, hi).toString();
    }
    case 5:
      return String(r.fixed32());
    case 2: {
      const [s, e] = r.bytesRange();
      const g = guessLengthDelimited(r.buf, s, e, depth, ctx.raw);
      ctx.fields += g.count;
      return Array.isArray(g.value) ? rawToJson(g.value) : g.value;
    }
    default:
      r.skip(wt); // groups: throws
      return null;
  }
}

function enumJson(schema: GrpcSchema, type: string, v: Json): Json {
  if (typeof v !== 'number') return v;
  const e = schema.enumType(type);
  const hit = e?.values.find((x) => x.number === v);
  if (type === 'google.protobuf.NullValue') return null;
  return hit ? hit.name : v;
}

function decodeMessageValue(ctx: DecodeCtx, type: string, buf: Uint8Array, s: number, e: number, depth: number): Json {
  const m = ctx.schema.message(type);
  if (!m) return decodeOpaque(ctx, buf, s, e, depth);
  return decodeMsg(ctx, m, buf, s, e, depth + 1);
}

function readValue(ctx: DecodeCtx, t: ProtoFieldType, r: Reader): Json {
  if (t.kind === 'enum') return r.varint()[0] | 0;
  if (t.kind !== 'scalar') throw new WireError('not a scalar');
  switch (t.scalar) {
    case 'int32':
      return r.varint()[0] | 0;
    case 'uint32':
      return r.varint()[0];
    case 'sint32':
      return zigzag32(r.varint()[0]);
    case 'int64': {
      const [lo, hi] = r.varint();
      return i64(lo, hi).toString();
    }
    case 'uint64': {
      const [lo, hi] = r.varint();
      return u64(lo, hi).toString();
    }
    case 'sint64': {
      const [lo, hi] = r.varint();
      return zigzag64(lo, hi).toString();
    }
    case 'bool': {
      const [lo, hi] = r.varint();
      return lo !== 0 || hi !== 0;
    }
    case 'fixed32':
      return r.fixed32();
    case 'sfixed32':
      return r.fixed32() | 0;
    case 'float':
      return jsonFloat(shortestFloat32(float32FromBits(r.fixed32())));
    case 'fixed64': {
      const [lo, hi] = r.fixed64();
      return u64(lo, hi).toString();
    }
    case 'sfixed64': {
      const [lo, hi] = r.fixed64();
      return i64(lo, hi).toString();
    }
    case 'double': {
      const [lo, hi] = r.fixed64();
      return jsonFloat(float64FromBits(lo, hi));
    }
    case 'string': {
      const [s, e] = r.bytesRange();
      return utf8Decode(r.buf.subarray(s, e));
    }
    case 'bytes': {
      const [s, e] = r.bytesRange();
      return toBase64(r.buf.subarray(s, e));
    }
  }
}

function defaultScalarJson(s: ProtoScalar): Json {
  switch (s) {
    case 'bool':
      return false;
    case 'string':
    case 'bytes':
      return '';
    case 'int64':
    case 'uint64':
    case 'sint64':
    case 'fixed64':
    case 'sfixed64':
      return '0';
    default:
      return 0;
  }
}

function mapKeyJson(v: Json): string {
  return typeof v === 'string' ? v : String(v);
}

function decodeMapEntry(
  ctx: DecodeCtx,
  t: ProtoFieldType & { kind: 'map' },
  buf: Uint8Array,
  s: number,
  e: number,
  depth: number,
): [string, Json] {
  const r = new Reader(buf, s, e);
  const keyType: ProtoFieldType = { kind: 'scalar', scalar: t.key };
  let key: Json | undefined;
  let value: Json | undefined;
  while (!r.done) {
    if (++ctx.fields > MAX_FIELDS) throw new WireError(`more than ${MAX_FIELDS} fields`);
    const [no, wt] = r.tag();
    if (no === 1 && wt === wireTypeOf(keyType)) key = readValue(ctx, keyType, r);
    else if (no === 2 && t.value.kind === 'message' && wt === 2) {
      const [vs, ve] = r.bytesRange();
      value = decodeMessageValue(ctx, t.value.type, buf, vs, ve, depth);
    } else if (no === 2 && (t.value.kind === 'scalar' || t.value.kind === 'enum') && wt === wireTypeOf(t.value)) {
      const v = readValue(ctx, t.value, r);
      value = t.value.kind === 'enum' ? enumJson(ctx.schema, t.value.type, v) : v;
    } else r.skip(wt);
  }
  key ??= defaultScalarJson(t.key);
  if (value === undefined) {
    const vt = t.value;
    if (vt.kind === 'message') value = decodeMessageValue(ctx, vt.type, new Uint8Array(0), 0, 0, depth);
    else if (vt.kind === 'enum') value = enumJson(ctx.schema, vt.type, 0);
    else if (vt.kind === 'scalar') value = defaultScalarJson(vt.scalar);
    else value = null;
  }
  return [mapKeyJson(key), value];
}

/** Generic decoded JSON of a well-known type → its proto3 JSON form (falls back to the generic object). */
function wktToJson(ctx: DecodeCtx, name: string, g: JsonObject, depth: number): Json {
  const wrapped = wrapperScalar(name);
  if (wrapped) return 'value' in g ? g.value : defaultScalarJson(wrapped);
  switch (name) {
    case 'google.protobuf.Timestamp':
    case 'google.protobuf.Duration': {
      const seconds = BigInt(typeof g.seconds === 'string' ? g.seconds : '0');
      const nanos = typeof g.nanos === 'number' ? g.nanos : 0;
      const s = name.endsWith('Timestamp') ? formatTimestamp(seconds, nanos) : formatDuration(seconds, nanos);
      return s ?? g;
    }
    case 'google.protobuf.FieldMask':
      return fieldMaskToJson(Array.isArray(g.paths) ? (g.paths.filter((p) => typeof p === 'string') as string[]) : []);
    case 'google.protobuf.Struct':
      return g.fields && typeof g.fields === 'object' ? g.fields : {};
    case 'google.protobuf.ListValue':
      return Array.isArray(g.values) ? g.values : [];
    case VALUE: {
      for (const k of ['numberValue', 'stringValue', 'boolValue', 'structValue', 'listValue']) if (k in g) return g[k];
      return null; // nullValue, or nothing set
    }
    case ANY: {
      const url = typeof g.typeUrl === 'string' ? g.typeUrl : '';
      const value = typeof g.value === 'string' ? g.value : '';
      if (!url) return {};
      const inner = ctx.schema.message(url);
      const bytes = fromBase64(value);
      if (!inner || !bytes) return { '@type': url, value };
      const json = decodeMsg(ctx, inner, bytes, 0, bytes.length, depth + 1);
      if (hasSpecialJson(inner.name)) return { '@type': url, value: json };
      return json && typeof json === 'object' && !Array.isArray(json) ? { '@type': url, ...json } : { '@type': url, value: json };
    }
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Encoding

interface EncodeCtx {
  schema: GrpcSchema;
}

const fail = (path: string, why: string): never => {
  throw new Error(`${path}: ${why}`);
};

const keyPath = (path: string, key: string) => (/^[A-Za-z_#@][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/** Throws an Error naming the JSON path ("$.items[2].price: expected a number"). */
export function encodeMessage(schema: GrpcSchema, type: string, json: unknown): Uint8Array {
  const msg = schema?.message(type);
  if (!msg) throw new Error(`$: unknown message type ${type}`);
  const w = new Writer();
  try {
    encodeMsg({ schema }, w, msg, json, '$', 0);
  } catch (e) {
    if (e instanceof WireError) throw new Error(`$: ${e.message}`);
    throw e;
  }
  return w.finish();
}

function encodeMsg(ctx: EncodeCtx, w: Writer, msg: ProtoMessage, json: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) fail(path, `nested deeper than ${MAX_DEPTH} messages`);
  let obj: Record<string, unknown>;
  if (hasSpecialJson(msg.name)) obj = wktFromJson(ctx, msg.name, json, path, depth);
  else if (isObject(json)) obj = json;
  else return fail(path, `expected an object for ${msg.name}`);
  const idx = indexOf(msg);
  const items: { f?: ProtoField; n: number; v: unknown; p: string }[] = [];
  const oneofs = new Map<string, string>();
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const p = keyPath(path, key);
    const raw = /^#(\d+)$/.exec(key);
    if (raw) {
      const n = Number(raw[1]);
      if (n < 1 || n > 536870911) fail(p, 'invalid field number');
      if (idx.byNumber.has(n)) fail(p, `field ${n} is ${idx.byNumber.get(n)!.name}; use that name`);
      items.push({ n, v, p });
      continue;
    }
    const f = idx.byKey.get(key);
    if (!f) return fail(p, `${msg.name} has no field "${key}"`);
    if (v === null && !(f.type.kind === 'message' && f.type.type === VALUE && !f.repeated)) continue;
    if (v === undefined) continue;
    if (f.oneof) {
      const other = oneofs.get(f.oneof);
      if (other && other !== f.name) fail(p, `only one of oneof ${f.oneof} can be set (${other} is set too)`);
      oneofs.set(f.oneof, f.name);
    }
    items.push({ f, n: f.number, v, p });
  }
  items.sort((a, b) => a.n - b.n);
  for (const it of items) {
    if (it.f) encodeField(ctx, w, it.f, it.v, it.p, depth);
    else encodeRawJson(w, it.n, it.v, it.p, depth);
  }
}

function encodeField(ctx: EncodeCtx, w: Writer, f: ProtoField, v: unknown, path: string, depth: number): void {
  const t = f.type;
  if (t.kind === 'map') {
    if (!isObject(v)) return fail(path, 'expected an object (map)');
    for (const k of Object.keys(v)) {
      const ev = v[k];
      const p = keyPath(path, k);
      const entry = new Writer();
      entry.tag(1, wireTypeOf({ kind: 'scalar', scalar: t.key }));
      writeScalar(entry, t.key, mapKey(t.key, k, p), p);
      if (ev !== null || (t.value.kind === 'message' && t.value.type === VALUE)) {
        entry.tag(2, wireTypeOf(t.value));
        writeSingle(ctx, entry, t.value, ev, p, depth);
      }
      w.tag(f.number, 2);
      const bytes = entry.finish();
      w.uvarint(bytes.length);
      w.bytes(bytes);
    }
    return;
  }
  if (f.repeated) {
    if (!Array.isArray(v)) return fail(path, 'expected a list');
    if (f.packed && isPackable(t)) {
      if (v.length === 0) return;
      const inner = new Writer();
      v.forEach((x, i) => writeSingle(ctx, inner, t, x, `${path}[${i}]`, depth));
      const bytes = inner.finish();
      w.tag(f.number, 2);
      w.uvarint(bytes.length);
      w.bytes(bytes);
      return;
    }
    v.forEach((x, i) => {
      const p = `${path}[${i}]`;
      if (x === null && !(t.kind === 'message' && t.type === VALUE)) fail(p, 'null is not allowed in a list');
      w.tag(f.number, wireTypeOf(t));
      writeSingle(ctx, w, t, x, p, depth);
    });
    return;
  }
  w.tag(f.number, wireTypeOf(t));
  writeSingle(ctx, w, t, v, path, depth);
}

/** Writes one value (no tag). Messages are length-prefixed. */
function writeSingle(ctx: EncodeCtx, w: Writer, t: ProtoFieldType, v: unknown, path: string, depth: number): void {
  if (t.kind === 'scalar') return writeScalar(w, t.scalar, v, path);
  if (t.kind === 'enum') return w.varint32(enumNumber(ctx, t.type, v, path));
  if (t.kind === 'message') {
    const inner = new Writer();
    const m = ctx.schema.message(t.type);
    if (m) encodeMsg(ctx, inner, m, v, path, depth + 1);
    else if (isObject(v)) encodeRawObject(inner, v, path, depth + 1);
    else if (typeof v === 'string' && fromBase64(v)) inner.bytes(fromBase64(v)!);
    else fail(path, `${t.type} isn't in the loaded generated code; give its fields as {"#1": …} or base64`);
    const bytes = inner.finish();
    w.uvarint(bytes.length);
    w.bytes(bytes);
    return;
  }
  fail(path, 'a map can\'t be nested in a list');
}

function enumNumber(ctx: EncodeCtx, type: string, v: unknown, path: string): number {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) fail(path, `expected an enum value of ${type}`);
    return v;
  }
  if (typeof v === 'string') {
    if (/^-?\d+$/.test(v)) return enumNumber(ctx, type, Number(v), path);
    const e = ctx.schema.enumType(type);
    const hit = e?.values.find((x) => x.name === v);
    if (hit) return hit.number;
    const names = e?.values.slice(0, 8).map((x) => x.name).join(', ');
    return fail(path, `"${v}" is not a value of ${type}${names ? ` (${names}${e!.values.length > 8 ? ', …' : ''})` : ''}`);
  }
  if (v === null && type === 'google.protobuf.NullValue') return 0;
  return fail(path, `expected an enum name or number of ${type}`);
}

const INT_RE = /^-?\d+$/;
const RANGES32: Partial<Record<ProtoScalar, [number, number]>> = {
  int32: [-2147483648, 2147483647],
  sint32: [-2147483648, 2147483647],
  sfixed32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  fixed32: [0, 4294967295],
};
const MIN64 = -(2n ** 63n);
const MAX64 = 2n ** 63n - 1n;
const MAXU64 = 2n ** 64n - 1n;

function toInt32(s: ProtoScalar, v: unknown, path: string): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && INT_RE.test(v.trim())) n = Number(v.trim());
  else return fail(path, `expected an integer (${s})`);
  const [lo, hi] = RANGES32[s]!;
  if (!Number.isInteger(n)) fail(path, `expected an integer (${s}), got ${n}`);
  if (n < lo || n > hi) fail(path, `${n} is out of range for ${s}`);
  return n;
}

function toInt64(s: ProtoScalar, v: unknown, path: string): bigint {
  let n: bigint;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return fail(path, `expected an integer (${s}), got ${v}`);
    n = BigInt(v);
  } else if (typeof v === 'string' && INT_RE.test(v.trim())) n = BigInt(v.trim());
  else if (typeof v === 'bigint') n = v;
  else return fail(path, `expected an integer or a string of digits (${s})`);
  const unsigned = s === 'uint64' || s === 'fixed64';
  if (unsigned ? n < 0n || n > MAXU64 : n < MIN64 || n > MAX64) fail(path, `${n} is out of range for ${s}`);
  return n;
}

function toFloat(s: ProtoScalar, v: unknown, path: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v === 'NaN') return NaN;
    if (v === 'Infinity') return Infinity;
    if (v === '-Infinity') return -Infinity;
    const n = Number(v);
    if (v.trim() !== '' && !Number.isNaN(n)) return n;
  }
  return fail(path, `expected a number (${s})`);
}

function writeScalar(w: Writer, s: ProtoScalar, v: unknown, path: string): void {
  switch (s) {
    case 'int32':
      return w.varint32(toInt32(s, v, path));
    case 'uint32':
      return w.uvarint(toInt32(s, v, path));
    case 'sint32': {
      const n = toInt32(s, v, path);
      return w.uvarint(((n << 1) ^ (n >> 31)) >>> 0);
    }
    case 'fixed32':
    case 'sfixed32':
      return w.fixed32(toInt32(s, v, path) >>> 0);
    case 'int64':
    case 'uint64':
      return w.varint64(toInt64(s, v, path));
    case 'sint64': {
      const n = toInt64(s, v, path);
      return w.varint64((n << 1n) ^ (n >> 63n));
    }
    case 'fixed64':
    case 'sfixed64':
      return w.fixed64(toInt64(s, v, path));
    case 'float':
      return w.float(toFloat(s, v, path));
    case 'double':
      return w.double(toFloat(s, v, path));
    case 'bool':
      if (typeof v !== 'boolean') fail(path, 'expected true or false');
      return w.byte(v ? 1 : 0);
    case 'string': {
      if (typeof v !== 'string') fail(path, 'expected a string');
      const b = utf8Encode(v as string);
      w.uvarint(b.length);
      return w.bytes(b);
    }
    case 'bytes': {
      const b = v instanceof Uint8Array ? v : typeof v === 'string' ? fromBase64(v) : undefined;
      if (!b) return fail(path, 'expected base64 bytes');
      w.uvarint(b.length);
      return w.bytes(b);
    }
  }
}

function mapKey(s: ProtoScalar, k: string, path: string): unknown {
  if (s === 'bool') {
    if (k === 'true') return true;
    if (k === 'false') return false;
    return fail(path, 'a bool map key must be "true" or "false"');
  }
  if (s === 'string') return k;
  return k; // numeric keys: the scalar writers accept strings of digits
}

/** `{"#3": …}` values for fields the schema doesn't know (as decodeMessage shows them). */
function encodeRawJson(w: Writer, n: number, v: unknown, path: string, depth: number): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => encodeRawJson(w, n, x, `${path}[${i}]`, depth));
    return;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && INT_RE.test(v))) {
    const big = typeof v === 'boolean' ? (v ? 1n : 0n) : typeof v === 'number' && !Number.isInteger(v) ? fail(path, 'expected an integer') : BigInt(v);
    w.tag(n, 0);
    w.varint64(big);
    return;
  }
  if (typeof v === 'string') {
    const b = utf8Encode(v);
    w.tag(n, 2);
    w.uvarint(b.length);
    w.bytes(b);
    return;
  }
  if (isObject(v)) {
    const inner = new Writer();
    encodeRawObject(inner, v, path, depth + 1);
    const b = inner.finish();
    w.tag(n, 2);
    w.uvarint(b.length);
    w.bytes(b);
    return;
  }
  fail(path, 'expected a number, string, object or list');
}

function encodeRawObject(w: Writer, obj: Record<string, unknown>, path: string, depth: number): void {
  if (depth > MAX_DEPTH) fail(path, `nested deeper than ${MAX_DEPTH} messages`);
  const keys = Object.keys(obj).map((k) => {
    const m = /^#(\d+)$/.exec(k);
    if (!m) fail(keyPath(path, k), 'fields of a type that isn\'t loaded must be given as "#<number>"');
    return [Number(m![1]), k] as const;
  });
  keys.sort((a, b) => a[0] - b[0]);
  for (const [n, k] of keys) encodeRawJson(w, n, obj[k], keyPath(path, k), depth);
}

/** proto3 JSON of a well-known type → its generic field object. */
function wktFromJson(ctx: EncodeCtx, name: string, json: unknown, path: string, depth: number): Record<string, unknown> {
  // Default values are left out, as other encoders do (the fields have no presence).
  const wrapped = wrapperScalar(name);
  if (wrapped) {
    if (isObject(json)) return json;
    const isDefault = json === false || json === '' || json === 0 || json === '0';
    return isDefault ? {} : { value: json };
  }
  const secondsNanos = (t: { seconds: bigint; nanos: number }) => ({
    ...(t.seconds !== 0n ? { seconds: t.seconds.toString() } : {}),
    ...(t.nanos !== 0 ? { nanos: t.nanos } : {}),
  });
  switch (name) {
    case 'google.protobuf.Timestamp': {
      if (isObject(json)) return json;
      const t = typeof json === 'string' ? parseTimestamp(json) : undefined;
      if (!t) return fail(path, 'expected an RFC 3339 timestamp like "2025-01-01T00:00:00Z"');
      return secondsNanos(t);
    }
    case 'google.protobuf.Duration': {
      if (isObject(json)) return json;
      const d = typeof json === 'string' ? parseDuration(json) : undefined;
      if (!d) return fail(path, 'expected a duration like "1.5s"');
      return secondsNanos(d);
    }
    case 'google.protobuf.FieldMask':
      if (isObject(json)) return json;
      if (typeof json !== 'string') return fail(path, 'expected a field mask like "a.b,c"');
      return { paths: fieldMaskFromJson(json) };
    case 'google.protobuf.Struct':
      if (!isObject(json)) return fail(path, 'expected an object (Struct)');
      return { fields: json };
    case 'google.protobuf.ListValue':
      if (!Array.isArray(json)) return fail(path, 'expected a list (ListValue)');
      return { values: json };
    case VALUE:
      if (json === null || json === undefined) return { nullValue: 0 };
      if (typeof json === 'number') return { numberValue: json };
      if (typeof json === 'string') return { stringValue: json };
      if (typeof json === 'boolean') return { boolValue: json };
      if (Array.isArray(json)) return { listValue: json };
      if (isObject(json)) return { structValue: json };
      return fail(path, 'expected a JSON value');
    case ANY: {
      if (!isObject(json)) return fail(path, 'expected an object with "@type"');
      const url = json['@type'];
      if (url === undefined && Object.keys(json).length === 0) return {};
      if (typeof url !== 'string' || !url) return fail(path, 'an Any needs "@type"');
      const inner = ctx.schema.message(url);
      const { '@type': _, ...rest } = json;
      if (!inner) {
        if (typeof rest.value === 'string' && fromBase64(rest.value) && Object.keys(rest).length === 1) return { typeUrl: url, value: rest.value };
        return fail(keyPath(path, '@type'), `${url} isn't in the loaded generated code`);
      }
      const w = new Writer();
      encodeMsg(ctx, w, inner, hasSpecialJson(inner.name) ? rest.value : rest, hasSpecialJson(inner.name) ? keyPath(path, 'value') : path, depth + 1);
      return { typeUrl: url, value: w.finish() };
    }
  }
  return isObject(json) ? json : fail(path, `expected an object for ${name}`);
}

// ---------------------------------------------------------------------------------------------
// Skeleton

/** Example JSON with every field (one oneof member each), nested one level, cycles cut, lists of one. */
export function skeleton(schema: GrpcSchema, type: string): unknown {
  try {
    const m = schema?.message(type);
    if (!m) return undefined;
    return skeletonOf(schema, m, 0, new Set());
  } catch {
    return undefined;
  }
}

const SKELETON_LEVELS = 2; // the message itself + one level of nested messages

function skeletonOf(schema: GrpcSchema, m: ProtoMessage, level: number, path: Set<string>): Json {
  const special = wktSkeleton(m.name);
  if (special !== undefined) return special;
  if (level >= SKELETON_LEVELS || path.has(m.name)) return {};
  path.add(m.name);
  const out: JsonObject = {};
  const oneofs = new Set<string>();
  for (const f of m.fields) {
    if (f.oneof) {
      if (oneofs.has(f.oneof)) continue;
      oneofs.add(f.oneof);
    }
    const one = valueSkeleton(schema, f.type, level, path);
    if (f.type.kind === 'map') setOwn(out, f.name, { [mapKeySkeleton(f.type.key)]: valueSkeleton(schema, f.type.value, level, path) });
    else setOwn(out, f.name, f.repeated ? [one] : one);
  }
  path.delete(m.name);
  return out;
}

function valueSkeleton(schema: GrpcSchema, t: ProtoFieldType, level: number, path: Set<string>): Json {
  if (t.kind === 'scalar') return defaultScalarJson(t.scalar);
  if (t.kind === 'enum') {
    const e = schema.enumType(t.type);
    if (!e || !e.values.length) return 0;
    return (e.values.find((v) => v.number !== 0) ?? e.values[0]).name;
  }
  if (t.kind === 'message') {
    const m = schema.message(t.type);
    if (!m) return {};
    return skeletonOf(schema, m, level + 1, path);
  }
  return {};
}

function mapKeySkeleton(s: ProtoScalar): string {
  if (s === 'string') return 'key';
  if (s === 'bool') return 'true';
  return '0';
}

function wktSkeleton(name: string): Json | undefined {
  const wrapped = wrapperScalar(name);
  if (wrapped) return defaultScalarJson(wrapped);
  switch (name) {
    case 'google.protobuf.Timestamp':
      return '2025-01-01T00:00:00Z';
    case 'google.protobuf.Duration':
      return '1s';
    case 'google.protobuf.FieldMask':
      return '';
    case 'google.protobuf.Struct':
      return {};
    case 'google.protobuf.ListValue':
      return [];
    case VALUE:
      return null;
    case 'google.protobuf.Empty':
      return {};
    case ANY:
      return { '@type': 'type.googleapis.com/google.protobuf.Empty' };
  }
  return undefined;
}
