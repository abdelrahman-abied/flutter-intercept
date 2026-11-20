/**
 * Stateful mocks: finding the REST resources of a collection (CONTRACTS §22.2, §22.3), plus the JSON helpers the
 * store (`store.ts`) and the snapshot format (`snapshot.ts`) share. Pure: no vscode, no fs, no network; deterministic.
 *
 * Decisions where §22.3 leaves room (CONTRACTS §22.3):
 * - Endpoints without an `origin` (an unset variable) are never part of a resource (they are not mocked at all).
 * - Paths are compared with parameters normalised (`/users/:id` and `/users/{userId}` are the same item path); the
 *   names (`itemParam`, `scopeParams`, `listPath`) come from the first item endpoint in file order. A path that
 *   repeats a parameter name stays static (path params are passed to the store by name).
 * - The name is the literal before each scope param plus the list's last literal (`users.orders`), ≤ 100 chars.
 * - Overrides are keyed by the final name (with ` #2`). `off: true` → the resource is left out of `resources`
 *   (static, as 0.15); call again without `off` to list it.
 * - With no example record at all (no examples, nothing generated), the id field is `id` and the id kind `integer`.
 * - Wrapper totals are JSON Pointers from the list body's root (`/total`, `/meta/total`): numeric fields named as in
 *   `TOTAL_NAMES` in the object holding the records, at the root, or in a root `meta` / `pagination` / `paging` object.
 * - A list example that is not JSON records, or an item example that is not a JSON object → static, one line.
 */
import {
  COLLECTION_LIMITS,
  STORE_LIMITS,
  type DetectResources,
  type MockEndpoint,
  type MockExample,
  type PathSegment,
  type Resource,
  type ResourceOverride,
  type StoreOp,
} from './types';

export type JsonRecord = Record<string, unknown>;

/** Numeric wrapper fields recomputed to the list's total (§22.3 step 6, plus Spring's `totalElements`). */
export const TOTAL_NAMES = ['total', 'count', 'totalCount', 'total_count', 'totalItems', 'totalElements', 'total_elements'];
/** Root objects of a list wrapper that may hold counters (`{data: [...], meta: {total}}`). */
export const META_NAMES = ['meta', 'pagination', 'paging'];
const ID_CANDIDATES_TAIL = ['_id', 'uuid'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_CHARS = 100;
const MAX_PROBLEM_NAME = 60;
const WRAPPER_DEPTH = 3;

// ------------------------------------------------------------------ JSON helpers (shared with store.ts, snapshot.ts)

export function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function hasOwnKey(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Null-prototype object: `__proto__` / `constructor` are plain data keys. */
export function nullObject(): JsonRecord {
  return Object.create(null) as JsonRecord;
}

export function setKey(o: JsonRecord, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// ------------------------------------------------------------------ number text (REVIEW-16 #15c)
//
// A number literal JavaScript can't write back the same (`10.50`, `1.0`, `1e3`, a big integer such as
// `1234567890123456789`) is remembered next to the object or array that holds it, by key, when the JSON is parsed
// (`parseJsonText`, through `JSON.parse`'s source text: hosts without it keep numbers as JavaScript writes them).
// `cleanJson` and `copyKey` carry it to copies, and `stringifyJson` writes it back while the value is still the same
// number. So the store answers the seed's and the app's numbers as they were written.

const numberTexts = new WeakMap<object, Map<string, string>>();
let numberTextSeen = false;
/** Cheap test before parsing with the reviver: a digit before `.` / `e`, a long digit run, or `-0`. */
const MAYBE_NUMBER_TEXT = /\d[.eE]|\d{16}|-0/;

function keepNumberText(holder: object, key: string, raw: string): void {
  let m = numberTexts.get(holder);
  if (!m) {
    m = new Map();
    numberTexts.set(holder, m);
  }
  m.set(key, raw);
  numberTextSeen = true;
}

function reviveNumberText(this: unknown, key: string, value: unknown, ctx?: { source?: unknown }): unknown {
  if (typeof value === 'number' && Number.isFinite(value) && this !== null && typeof this === 'object') {
    const raw = ctx?.source;
    if (typeof raw === 'string' && raw !== JSON.stringify(value)) keepNumberText(this, key, raw);
  }
  return value;
}

/** `dst[dk] = src[sk]` (with `setKey`), keeping the number's text when it had one. */
export function copyKey(dst: JsonRecord, dk: string, src: object, sk: string = dk): void {
  const v = (src as JsonRecord)[sk];
  setKey(dst, dk, v);
  if (numberTextSeen && typeof v === 'number') {
    const raw = numberTexts.get(src)?.get(sk);
    if (raw !== undefined) keepNumberText(dst, dk, raw);
    else numberTexts.get(dst)?.delete(dk);
  }
}

/**
 * `JSON.stringify` (`'null'` for `undefined`) that writes a number as it was written in the JSON it came from, while
 * it is still that number (REVIEW-16 #15c).
 */
export function stringifyJson(v: unknown): string {
  if (!numberTextSeen) return JSON.stringify(v) ?? 'null';
  const raws: string[] = [];
  const mark = `\u0000fi-num-${Math.random().toString(36).slice(2, 10)}:`;
  const text = JSON.stringify(v, function (this: unknown, key: string, value: unknown) {
    if (typeof value === 'number' && this !== null && typeof this === 'object') {
      const raw = numberTexts.get(this)?.get(key);
      if (raw !== undefined && Number(raw) === value) {
        raws.push(raw);
        return `${mark}${raws.length - 1}`;
      }
    }
    return value;
  }) as string | undefined;
  if (text === undefined) return 'null';
  if (raws.length === 0) return text;
  const quoted = JSON.stringify(mark).slice(0, -1); // `"\u0000fi-num-…:`
  let out = '';
  let pos = 0;
  for (let at = text.indexOf(quoted, pos); at >= 0; at = text.indexOf(quoted, pos)) {
    const end = text.indexOf('"', at + quoted.length);
    const i = Number(text.slice(at + quoted.length, end));
    out += text.slice(pos, at) + (raws[i] ?? text.slice(at, end + 1));
    pos = end + 1;
  }
  return out + text.slice(pos);
}

export type Cleaned = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * A fresh copy of a JSON value made of null-prototype objects and plain arrays; `__proto__` keys are dropped,
 * non-finite numbers become `null`, `undefined` properties are left out. Deeper than `maxDepth` (objects and arrays
 * count one level each, the top value is level 1) → not ok. Never throws.
 */
export function cleanJson(value: unknown, maxDepth: number = STORE_LIMITS.recordDepth): Cleaned {
  let reason: string | undefined;
  const walk = (v: unknown, depth: number): unknown => {
    if (reason !== undefined) return undefined;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'object') {
      reason = 'it holds a value that is not JSON';
      return undefined;
    }
    if (depth > maxDepth) {
      reason = `it is nested deeper than ${maxDepth} levels`;
      return undefined;
    }
    const texts = numberTextSeen ? numberTexts.get(v) : undefined;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const c = walk(v[i], depth + 1);
        if (reason !== undefined) return undefined;
        out.push(c === undefined ? null : c);
        const t = texts && typeof c === 'number' ? texts.get(String(i)) : undefined;
        if (t !== undefined) keepNumberText(out, String(i), t);
      }
      return out;
    }
    const out = nullObject();
    for (const k of Object.keys(v)) {
      if (k === '__proto__') continue;
      const raw = (v as JsonRecord)[k];
      if (raw === undefined) continue;
      const c = walk(raw, depth + 1);
      if (reason !== undefined) return undefined;
      setKey(out, k, c);
      const t = texts && typeof c === 'number' ? texts.get(k) : undefined;
      if (t !== undefined) keepNumberText(out, k, t);
    }
    return out;
  };
  const value2 = walk(value, 1);
  return reason !== undefined ? { ok: false, reason } : { ok: true, value: value2 };
}

/** `JSON.parse` that never throws; number literals JavaScript writes differently keep their text (REVIEW-16 #15c). */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    if (typeof text === 'string' && MAYBE_NUMBER_TEXT.test(text)) return { ok: true, value: JSON.parse(text, reviveNumberText) as unknown };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** A record id as the URL spells it, or undefined when the value can't be an id (≤ 100 chars, string or number). */
export function idText(v: unknown): string | undefined {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
  else return undefined;
  return s.length > 0 && s.length <= COLLECTION_LIMITS.paramChars ? s : undefined;
}

export function isUuid(s: string): boolean {
  return UUID.test(s);
}

/** `users` → `user`, `categories` → `category`, `boxes` → `box`. */
export function singular(word: string): string {
  if (/ies$/i.test(word) && word.length > 3) return `${word.slice(0, -3)}y`;
  if (/(?:ss|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word) && word.length > 1) return word.slice(0, -1);
  return word;
}

/** RFC 6901 pointer from path segments. */
export function toPointer(path: readonly string[]): string {
  return path.map((p) => `/${p.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

export function fromPointer(pointer: string): string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The value at `path` inside `root` (own keys only). */
export function valueAt(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const k of path) {
    if (!isRecord(cur) || !hasOwnKey(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** The records of a list body: a bare array, or the array at the wrapper path. */
export function recordsIn(body: unknown, wrapperPath: readonly string[] | undefined): unknown[] | undefined {
  const v = wrapperPath ? valueAt(body, wrapperPath) : body;
  return Array.isArray(v) ? v : undefined;
}

// ------------------------------------------------------------------ examples and seeds (§22.4)

export function is2xx(ex: MockExample): boolean {
  return ex.status >= 200 && ex.status <= 299;
}

/** Examples that describe the endpoint's normal answer: 2xx and not chosen by a query (`?page=2` → `[]`). */
function plainOk(ep: MockEndpoint | undefined, generated: boolean): MockExample[] {
  if (!ep) return [];
  return ep.examples.filter((ex) => is2xx(ex) && !ex.query && (generated ? ex.generated === true : ex.generated !== true));
}

/** The operation's first written 2xx example (not generated, not query-chosen): its status, headers and body. */
export function writtenOk(ep: MockEndpoint | undefined): MockExample | undefined {
  return plainOk(ep, false)[0];
}

function parseExample(ex: MockExample): unknown {
  if (ex.body.trim() === '') return undefined;
  const r = parseJsonText(ex.body);
  return r.ok ? r.value : undefined;
}

export interface SeedSource {
  /** Raw records (parsed JSON, not cleaned) in seed order. */
  records: JsonRecord[];
  generated: boolean;
}

/**
 * §22.4 seed: the first written 2xx list example with records, then every written 2xx item example (GET item) merged
 * in by id (shallow, the item's fields win). Generated bodies only when nothing is written. Records without a usable
 * id are skipped.
 */
export function seedRecords(
  resource: Pick<Resource, 'ops' | 'idField' | 'list'>,
  byKey: ReadonlyMap<string, MockEndpoint>,
): SeedSource {
  const listEp = resource.ops.list !== undefined ? byKey.get(resource.ops.list) : undefined;
  const getEp = resource.ops.get !== undefined ? byKey.get(resource.ops.get) : undefined;
  const path = resource.list.wrapper?.path;
  const pick = (generated: boolean): JsonRecord[] => {
    const out: JsonRecord[] = [];
    const at = new Map<string, number>();
    const add = (r: unknown, merge: boolean): void => {
      if (!isRecord(r)) return;
      const id = idText(r[resource.idField]);
      if (id === undefined) return;
      const i = at.get(id);
      if (i === undefined) {
        at.set(id, out.length);
        out.push(r);
      } else if (merge) {
        const merged = nullObject();
        for (const k of Object.keys(out[i])) copyKey(merged, k, out[i]);
        for (const k of Object.keys(r)) copyKey(merged, k, r);
        out[i] = merged;
      }
    };
    for (const ex of plainOk(listEp, generated)) {
      const recs = recordsIn(parseExample(ex), path);
      if (!recs || !recs.some((r) => isRecord(r) && idText(r[resource.idField]) !== undefined)) continue;
      for (const r of recs) add(r, false);
      break;
    }
    for (const ex of plainOk(getEp, generated)) add(parseExample(ex), true);
    return out;
  };
  const written = pick(false);
  if (written.length > 0) return { records: written, generated: false };
  const generated = pick(true);
  return { records: generated, generated: generated.length > 0 };
}

// ------------------------------------------------------------------ detection (§22.3)

interface Group {
  origin: string;
  endpoints: MockEndpoint[];
  first: number;
}

function signature(origin: string, path: readonly PathSegment[]): string {
  return JSON.stringify([origin, ...path.map((s) => (typeof s === 'string' ? s : 0))]);
}

function firstWith(group: Group | undefined, method: string): MockEndpoint | undefined {
  return group?.endpoints.find((e) => e.method === method);
}

function shortName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
  return clean.length > MAX_PROBLEM_NAME ? `${clean.slice(0, MAX_PROBLEM_NAME - 1)}…` : clean;
}

/**
 * REVIEW-16 #8 (CONTRACTS §21.6, §22.8): the literal segments of `path` with every environment value (≥ 3 characters)
 * written as `{{name}}`, longest value first, as `endpoints()` shows URLs. A value that holds a `/` spans segments:
 * every segment it touches is masked. Parameters are kept. Linear in the path length per value. Used for resource
 * names and the paths the panel, agents, notes and snapshot files see; never for matching requests.
 */
export function maskPathSegments(path: readonly PathSegment[], envValues: ReadonlyMap<string, string> | undefined): PathSegment[] {
  const env = [...(envValues ?? [])]
    .filter(([n, v]) => typeof n === 'string' && typeof v === 'string' && v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  if (env.length === 0) return path.map((s) => (typeof s === 'string' ? s : { param: s.param }));
  // NUL stands for a parameter (no value crosses one), \u0003 for a `/` inside one segment; \u0001<i>\u0002 marks
  // where value i was, once per segment it touches
  let text = path.map((s) => (typeof s === 'string' ? s.replace(/[\u0000-\u0003]/g, '').replace(/\//g, '\u0003') : '\u0000')).join('/');
  env.forEach(([, v], i) => {
    if (!text.includes(v)) return;
    const mark = `\u0001${i}\u0002`;
    text = text.split(v).join(mark + `/${mark}`.repeat(v.split('/').length - 1));
  });
  const parts = text.split('/');
  return path.map((s, i) =>
    typeof s === 'string'
      ? (parts[i] ?? s).replace(/\u0001(\d+)\u0002/g, (_m, n: string) => `{{${env[Number(n)][0]}}}`).replace(/\u0003/g, '/')
      : { param: s.param },
  );
}

function resourceName(listPath: readonly PathSegment[]): string {
  const parts: string[] = [];
  for (let i = 0; i < listPath.length; i++) {
    const s = listPath[i];
    if (typeof s !== 'string') {
      const prev = listPath[i - 1];
      if (typeof prev === 'string') parts.push(prev);
    }
  }
  const last = listPath[listPath.length - 1];
  if (typeof last === 'string') parts.push(last);
  const name = parts.join('.') || 'items';
  return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS) : name;
}

interface WrapperFound {
  path: string[];
  totals: string[];
}

/** §22.3 step 6: exactly one array of records (≤ 3 levels deep) inside a list body object. */
function findWrapper(body: JsonRecord, idField: string): WrapperFound | undefined {
  const arrays: { path: string[]; arr: unknown[] }[] = [];
  const walk = (o: JsonRecord, path: string[]): void => {
    for (const k of Object.keys(o)) {
      if (k === '__proto__') continue;
      const v = o[k];
      if (Array.isArray(v)) arrays.push({ path: [...path, k], arr: v });
      else if (isRecord(v) && path.length + 1 < WRAPPER_DEPTH) walk(v, [...path, k]);
    }
  };
  walk(body, []);
  const holding = arrays.filter((a) => a.arr.length > 0 && a.arr.every((e) => isRecord(e) && hasOwnKey(e, idField)));
  let chosen: { path: string[] } | undefined;
  if (holding.length === 1) chosen = holding[0];
  else if (holding.length === 0 && arrays.length === 1 && arrays[0].arr.length === 0) chosen = arrays[0];
  if (!chosen) return undefined;

  const totals: string[] = [];
  const seen = new Set<string>();
  const scan = (holderPath: string[]): void => {
    const holder = valueAt(body, holderPath);
    if (!isRecord(holder)) return;
    for (const n of TOTAL_NAMES) {
      if (hasOwnKey(holder, n) && typeof holder[n] === 'number') {
        const p = toPointer([...holderPath, n]);
        if (!seen.has(p)) {
          seen.add(p);
          totals.push(p);
        }
      }
    }
  };
  scan(chosen.path.slice(0, -1));
  scan([]);
  for (const m of META_NAMES) scan([m]);
  return { path: chosen.path, totals };
}

/** The holders (as paths) where page counters of a wrapper may live: the records' parent, the root, root meta objects. */
export function counterHolders(wrapperPath: readonly string[]): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const p of [wrapperPath.slice(0, -1), [], ...META_NAMES.map((m) => [m])]) {
    const k = JSON.stringify(p);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

interface Candidate {
  name: string;
  origin: string;
  listPath: PathSegment[];
  itemParam: string;
  scopeParams: string[];
  ops: Partial<Record<StoreOp, string>>;
  eps: Partial<Record<StoreOp, MockEndpoint>>;
  first: number;
  repeatedParam: boolean;
}

function findCandidates(endpoints: readonly MockEndpoint[], envValues: ReadonlyMap<string, string> | undefined): Candidate[] {
  const groups = new Map<string, Group>();
  endpoints.forEach((ep, i) => {
    if (ep.origin === undefined || ep.unresolved.length > 0) return;
    const sig = signature(ep.origin, ep.path);
    const g = groups.get(sig);
    if (g) g.endpoints.push(ep);
    else groups.set(sig, { origin: ep.origin, endpoints: [ep], first: i });
  });

  const out: Candidate[] = [];
  for (const item of groups.values()) {
    const sample = item.endpoints[0];
    const path = sample.path;
    if (path.length < 2) continue;
    const last = path[path.length - 1];
    const prev = path[path.length - 2];
    if (typeof last === 'string' || typeof prev !== 'string') continue;
    const list = groups.get(signature(item.origin, path.slice(0, -1)));
    const eps: Partial<Record<StoreOp, MockEndpoint>> = {
      list: firstWith(list, 'GET'),
      create: firstWith(list, 'POST'),
      get: firstWith(item, 'GET'),
      replace: firstWith(item, 'PUT'),
      patch: firstWith(item, 'PATCH'),
      delete: firstWith(item, 'DELETE'),
    };
    const hasItem = eps.get || eps.replace || eps.patch || eps.delete;
    const hasList = eps.list || eps.create;
    if (!hasItem || !hasList) continue;

    const primary = (eps.get ?? eps.replace ?? eps.patch ?? eps.delete) as MockEndpoint;
    const listPath = primary.path.slice(0, -1).map((s) => (typeof s === 'string' ? s : { param: s.param }));
    const itemParam = (primary.path[primary.path.length - 1] as { param: string }).param;
    const scopeParams = listPath.filter((s): s is { param: string } => typeof s !== 'string').map((s) => s.param);
    const allParams = [...scopeParams, itemParam];
    const ops: Partial<Record<StoreOp, string>> = {};
    for (const op of ['list', 'create', 'get', 'replace', 'patch', 'delete'] as StoreOp[]) {
      const e = eps[op];
      if (e) ops[op] = e.key;
    }
    const firsts = [item.first, list?.first ?? Infinity];
    out.push({
      // REVIEW-16 #8: never an environment value (the name reaches notes, the panel, agents and snapshot files)
      name: resourceName(maskPathSegments(listPath, envValues)),
      origin: item.origin,
      listPath,
      itemParam,
      scopeParams,
      ops,
      eps,
      first: Math.min(...firsts),
      repeatedParam: new Set(allParams).size !== allParams.length,
    });
  }
  out.sort((a, b) => a.first - b.first);
  // §22.3 step 7: duplicate names get ` #2`, ` #3`.
  const used = new Map<string, number>();
  for (const c of out) {
    const n = (used.get(c.name) ?? 0) + 1;
    used.set(c.name, n);
    if (n > 1) c.name = `${c.name} #${n}`;
  }
  return out;
}

function sampleRecord(c: Candidate, wrapperPath?: string[]): { record?: JsonRecord; itemNotObject?: boolean } {
  const tryGet = (generated: boolean): { record?: JsonRecord; itemNotObject?: boolean } | undefined => {
    const ex = plainOk(c.eps.get, generated)[0];
    if (!ex) return undefined;
    const v = parseExample(ex);
    if (isRecord(v)) return { record: v };
    return generated ? undefined : { itemNotObject: true };
  };
  const item = tryGet(false) ?? tryGet(true);
  if (item) return item;
  for (const generated of [false, true]) {
    for (const ex of plainOk(c.eps.list, generated)) {
      const recs = recordsIn(parseExample(ex), wrapperPath);
      const r = recs?.find(isRecord);
      if (r) return { record: r };
      if (!wrapperPath) {
        const v = parseExample(ex);
        if (isRecord(v)) {
          // A wrapped list: the first array of objects inside it, ≤ 3 levels.
          const found = firstRecordDeep(v, 0);
          if (found) return { record: found };
        }
      }
    }
  }
  return {};
}

function firstRecordDeep(o: JsonRecord, depth: number): JsonRecord | undefined {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v)) {
      const r = v.find(isRecord);
      if (r) return r;
    } else if (isRecord(v) && depth + 1 < WRAPPER_DEPTH) {
      const r = firstRecordDeep(v, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

function hintsOf(c: Candidate): MockEndpoint['schemaHints'] {
  for (const op of ['get', 'list', 'replace', 'patch', 'create'] as StoreOp[]) {
    const h = c.eps[op]?.schemaHints;
    if (h?.idField) return h;
  }
  return undefined;
}

function chooseIdField(c: Candidate, override: ResourceOverride | undefined, sample: JsonRecord | undefined): string | undefined {
  if (override?.idField && override.idField.length <= COLLECTION_LIMITS.paramChars) return override.idField;
  const hints = hintsOf(c);
  if (hints?.idField) return hints.idField;
  if (!sample) return 'id';
  const has = (k: string): boolean => hasOwnKey(sample, k) && idText(sample[k]) !== undefined;
  const lastLiteral = c.listPath[c.listPath.length - 1] as string;
  const one = singular(lastLiteral);
  for (const k of [c.itemParam, 'id', `${one}Id`, `${one}_id`, ...ID_CANDIDATES_TAIL]) {
    if (has(k)) return k;
  }
  return undefined;
}

function chooseIdKind(idField: string, hints: MockEndpoint['schemaHints'], seed: JsonRecord[]): Resource['idKind'] {
  const ids = seed.map((r) => r[idField]).filter((v) => v !== undefined && v !== null);
  const allUuid = ids.length > 0 && ids.every((v) => typeof v === 'string' && isUuid(v));
  if (hints && hints.idField === idField) {
    if (hints.idFormat?.toLowerCase() === 'uuid') return 'uuid';
    if (hints.idType === 'integer') return 'integer';
    if (hints.idType === 'string') return allUuid ? 'uuid' : 'string';
  }
  if (ids.length === 0) return 'integer';
  if (ids.every((v) => typeof v === 'number' && Number.isInteger(v))) return 'integer';
  if (allUuid) return 'uuid';
  return 'string';
}

/** Options of `detectResources` beyond §22.3. */
export interface DetectOptions {
  /** REVIEW-16 #8: the environment's values (host only): written as `{{name}}` in resource names. */
  envValues?: ReadonlyMap<string, string>;
}

/** CONTRACTS §22.3. Pure, deterministic; never throws. */
export const detectResources: (...a: [...Parameters<DetectResources>, DetectOptions?]) => ReturnType<DetectResources> = (endpoints, overrides, opts = {}) => {
  const problems: string[] = [];
  const resources: Resource[] = [];
  let candidates: Candidate[];
  try {
    candidates = findCandidates(Array.isArray(endpoints) ? endpoints : [], opts.envValues);
  } catch {
    return { resources, problems: ['Resources could not be read from this collection.'] };
  }
  const byKey = new Map<string, MockEndpoint>();
  for (const ep of Array.isArray(endpoints) ? endpoints : []) if (!byKey.has(ep.key)) byKey.set(ep.key, ep);
  const overrideOf = (name: string): ResourceOverride | undefined => {
    if (!overrides || typeof overrides !== 'object' || !hasOwnKey(overrides, name)) return undefined;
    const o: unknown = (overrides as Record<string, unknown>)[name];
    return isRecord(o) ? (o as ResourceOverride) : undefined;
  };

  let dropped = 0;
  for (const c of candidates) {
    const label = shortName(c.name);
    const override = overrideOf(c.name);
    if (override?.off === true) continue;
    if (c.repeatedParam) {
      problems.push(`${label}: its path repeats a parameter name, so it answers from the examples`);
      continue;
    }
    if (resources.length >= STORE_LIMITS.resourcesPerCollection) {
      dropped++;
      continue;
    }

    const firstSample = sampleRecord(c);
    if (firstSample.itemNotObject) {
      problems.push(`${label}: its item answer isn't a JSON object, so it answers from the examples`);
      continue;
    }
    const idField = chooseIdField(c, override, firstSample.record);
    if (idField === undefined) {
      problems.push(`${label}: set its id field to make it remember`);
      continue;
    }

    // §22.3 step 6: the list example's shape.
    const list: Resource['list'] = {};
    const listEx = writtenOk(c.eps.list) ?? plainOk(c.eps.list, true)[0];
    if (listEx && listEx.body.trim() !== '') {
      const parsed = parseJsonText(listEx.body);
      if (!parsed.ok || (!Array.isArray(parsed.value) && !isRecord(parsed.value))) {
        problems.push(`${label}: its list answer isn't JSON records, so it answers from the examples`);
        continue;
      }
      if (Array.isArray(parsed.value)) {
        if (parsed.value.length > 0 && !parsed.value.every(isRecord)) {
          problems.push(`${label}: its list answer isn't a list of JSON objects, so it answers from the examples`);
          continue;
        }
      } else {
        const found = findWrapper(parsed.value, idField);
        if (!found) {
          problems.push(`${label}: its list answer has no single list of records, so it answers from the examples`);
          continue;
        }
        const template = cleanJson(parsed.value, 64);
        if (!template.ok || !isRecord(template.value)) {
          problems.push(`${label}: its list answer is nested too deeply, so it answers from the examples`);
          continue;
        }
        const holder = valueAt(template.value, found.path.slice(0, -1));
        if (isRecord(holder)) setKey(holder, found.path[found.path.length - 1], []);
        list.wrapper = { path: found.path, template: template.value, totals: found.totals };
      }
    }

    const hints = hintsOf(c);
    const writeOnly: string[] = [];
    for (const op of ['get', 'list', 'create', 'replace', 'patch'] as StoreOp[]) {
      for (const w of c.eps[op]?.schemaHints?.writeOnly ?? []) if (w !== idField && !writeOnly.includes(w)) writeOnly.push(w);
    }
    const seed = seedRecords({ ops: c.ops, idField, list }, byKey);
    const resource: Resource = {
      name: c.name,
      origin: c.origin,
      listPath: c.listPath,
      itemParam: c.itemParam,
      scopeParams: c.scopeParams,
      idField,
      idKind: chooseIdKind(idField, hints, seed.records),
      ops: c.ops,
      list,
      writeOnly,
      detected: override?.idField ? 'override' : true,
      ...(seed.generated ? { generatedSeed: true as const } : {}),
    };
    resources.push(resource);
  }
  if (dropped > 0) {
    problems.push(`${dropped} more resources answer from the examples (at most ${STORE_LIMITS.resourcesPerCollection} remember)`);
  }
  return { resources, problems };
};
