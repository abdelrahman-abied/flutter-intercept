/**
 * Stateful mocks: the in-memory data of a collection's resources and the REST operations on it (CONTRACTS §22.4,
 * §22.5). Pure: no vscode, no fs, no network. Every operation is synchronous; `handle` never throws.
 *
 * Decisions where §22.4 / §22.5 leave room (CONTRACTS §22.4):
 * - Nested resources: a parent's list (`/users/1/orders`) starts as the seed (scope fields filled with the URL's
 *   value) the first time it is read; it is stored ("materialised") only on its first change, so reads never grow the
 *   store. `counts`, `items` without a scope and `dump` see stored scopes only.
 * - Request bodies: a body that parses as JSON is accepted whatever its content-type (Dart's `http` sends
 *   `text/plain` for a string body); `415` for `application/json-patch+json`, form and multipart bodies, and for a
 *   non-JSON content-type whose body doesn't parse. An empty body is `{}` for create, `400` for replace / patch.
 * - `writeOnly` fields are never stored (so never answered, listed, dumped).
 * - Create: the POST example's response body is used as the base when it is a JSON object; the id goes first.
 * - Paging without a size parameter in the request uses 20 per page. Sorting: `sort=name`, `sort=-name`,
 *   `sort=name,desc`, `sort=name:desc`, with `order=desc`. Filters compare the record's scalar as text.
 * - A `page` / `per_page` / `totalPages`-like number already in the wrapper is set when the request pages.
 * - `load(snapshot, {asStart: true})` makes the loaded data the point `changed` and `reset` compare to (the
 *   collection's starting snapshot).
 * - `problems` lists store-full refusals and seed records left out (unique lines, at most 20).
 */
import {
  cleanJson,
  copyKey,
  counterHolders,
  fromPointer,
  hasOwnKey,
  idText,
  isRecord,
  maskPathSegments,
  nullObject,
  parseJsonText,
  seedRecords,
  setKey,
  singular,
  stringifyJson,
  utf8Length,
  valueAt,
  writtenOk,
  type JsonRecord,
} from './resources';
import { validateSnapshot } from './snapshot';
import {
  COLLECTION_LIMITS,
  STORE_LIMITS,
  type MockEndpoint,
  type MockExample,
  type Resource,
  type StoreOp,
  type StoreSnapshot,
} from './types';

export interface StoreRequest {
  resource: string;
  op: StoreOp;
  /** Path params by name (scope params + item param), percent-decoded. */
  params: Record<string, string>;
  /** In order, decoded. */
  query: [string, string][];
  body?: { text: string; truncated?: boolean };
  contentType?: string;
}

export interface StoreAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** One line (§22.5). */
  note: string;
  itemId?: string;
}

export interface StoreItemsOptions {
  offset?: number;
  limit?: number;
  filter?: string;
  scope?: Record<string, string>;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_ITEMS_LIMIT = 50;
const MAX_ITEMS_LIMIT = 1000;
const MAX_PROBLEMS = 20;
const MAX_NOTE_ID = 60;
const JSON_TYPE = 'application/json';
const FRAMING = new Set(['content-length', 'transfer-encoding', 'content-encoding']);
/** RFC 9110 token: a valid header name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Connection headers: the proxy manages the connection (RFC 9110 §7.6.1); `proxy-*` too. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'te', 'trailer', 'upgrade']);
/** What Node can send in a header value: tab, printable ASCII and Latin-1. */
const SENDABLE_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/** Headers whose non-Latin-1 parameters the proxy writes as RFC 8187 ext-values. */
const PARAMETERISED = new Set(['content-disposition', 'link']);

/**
 * REVIEW-16 #14: an example header a store answer may carry — a valid name, not a connection header, and a value
 * HTTP can send (no control characters; Latin-1, except the parameters of `content-disposition` / `link`, which the
 * proxy encodes). Like `toRules` `cleanHeaders` for the static answer; anything else is left out.
 */
function sendableHeader(name: string, value: string): boolean {
  if (!HEADER_NAME.test(name) || HOP_BY_HOP.has(name) || name.startsWith('proxy-')) return false;
  if (SENDABLE_VALUE.test(value)) return true;
  return PARAMETERISED.has(name) && !/[\x00-\x08\x0a-\x1f\x7f]/.test(value);
}
const NO_BODY_STATUS = new Set([204, 205, 304]);
const NAME_LIKE = ['name', 'title', 'label', 'displayName', 'display_name', 'fullName', 'full_name', 'username', 'firstName', 'first_name'];

const PAGE_NAMES = ['page', '_page'];
const SIZE_NAMES = ['limit', 'per_page', 'size', 'pagesize', 'page_size', '_limit'];
const OFFSET_NAMES = ['offset'];
const SORT_NAMES = ['sort', '_sort', 'sort_by', 'sortby'];
const ORDER_NAMES = ['order', '_order'];
const ECHO_PAGE = ['page', 'currentPage', 'current_page', 'pageNumber', 'page_number'];
const ECHO_SIZE = ['per_page', 'perPage', 'pageSize', 'page_size', 'limit', 'size'];
const ECHO_OFFSET = ['offset'];
const ECHO_PAGES = ['totalPages', 'total_pages', 'pages', 'last_page', 'lastPage', 'pageCount', 'page_count'];

type Rec = JsonRecord;

interface Scope {
  values: Record<string, string>;
  records: Rec[];
  index: Map<string, Rec>;
}

interface ScopeField {
  param: string;
  fields: string[];
}

interface State {
  res: Resource;
  /** Display name for notes and messages, one line, ≤ 60 chars. */
  label: string;
  eps: Partial<Record<StoreOp, MockEndpoint>>;
  seed: Rec[];
  seedNext: number;
  /** What `reset` goes back to: the seed, or the starting snapshot (`load(…, {asStart})`). */
  start?: { scopes: { values: Record<string, string>; records: Rec[] }[]; next: number };
  scopes: Map<string, Scope>;
  next: number;
  count: number;
  bytes: number;
  dirty: boolean;
  queryNames: Map<string, string>;
  scopeFields: ScopeField[];
  wrapper?: {
    path: string[];
    template: Rec;
    holder: Rec;
    key: string;
    totals: { holder: Rec; key: string }[];
    counters: Rec[];
  };
  /** Prefix for string ids: `users-3`. */
  idBase: string;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function headerObject(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function isJsonType(ct: string | undefined): boolean {
  if (!ct) return false;
  const base = lower(ct.split(';')[0].trim());
  return base === JSON_TYPE || base.endsWith('/json') || base.endsWith('+json');
}

/** JSON text of a store value: numbers as the seed or the app wrote them (REVIEW-16 #15c). */
function stringify(v: unknown): string {
  return stringifyJson(v);
}

function cloneRecord(r: Rec): Rec {
  const c = cleanJson(r);
  return c.ok && isRecord(c.value) ? c.value : nullObject();
}

/** A plain-prototype deep copy for callers outside the store (agents, the panel, tests). */
function plain(v: unknown): unknown {
  return JSON.parse(stringify(v)) as unknown;
}

function scopeKey(res: Resource, values: Record<string, string>): string {
  return res.scopeParams.length === 0 ? '' : JSON.stringify(res.scopeParams.map((p) => values[p] ?? ''));
}

const UNSAFE_ID = 'is a number too large to keep exactly (over 2^53); send it as text';
const COUNTER_USED_UP = 'the id counter is used up (over 2^53); reset the data';

/** REVIEW-16 #13: a whole number JavaScript can't hold exactly (1e300, 2^53 + 1). */
function isUnsafeInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v);
}

/** REVIEW-16 #13: a whole number the integer id counter may move past (safe, below 2^53 − 1, so `+ 1` stays safe). */
function isCounterValue(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v < Number.MAX_SAFE_INTEGER;
}

function movesCounter(st: { res: Resource }, v: unknown): boolean {
  return st.res.idKind === 'integer' && isCounterValue(v);
}

function uuidFor(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0').slice(-12)}`;
}

export class ResourceStore {
  private readonly states = new Map<string, State>();
  private totalBytes = 0;
  private readonly problemLines: string[] = [];
  private sentinelSeq = 0;

  private readonly envValues: ReadonlyMap<string, string> | undefined;

  /** `opts.envValues` (host only, REVIEW-16 #8): environment values never become part of a string id. */
  constructor(resources: Resource[], endpoints: MockEndpoint[], opts: { envValues?: ReadonlyMap<string, string> } = {}) {
    this.envValues = opts.envValues;
    const byKey = new Map<string, MockEndpoint>();
    for (const ep of Array.isArray(endpoints) ? endpoints : []) if (!byKey.has(ep.key)) byKey.set(ep.key, ep);
    for (const res of Array.isArray(resources) ? resources : []) {
      if (this.states.has(res.name)) continue;
      try {
        this.states.set(res.name, this.buildState(res, byKey));
      } catch {
        this.problem(`${oneLine(res.name, MAX_NOTE_ID)}: its examples could not be read; it starts empty`);
      }
    }
    for (const st of this.states.values()) this.resetState(st);
  }

  // ------------------------------------------------------------------ public API (§22.4)

  /** Store refusals and seed records left out; unique lines, at most 20. */
  get problems(): string[] {
    return [...this.problemLines];
  }

  get changed(): boolean {
    for (const st of this.states.values()) if (st.dirty) return true;
    return false;
  }

  handle(req: StoreRequest): StoreAnswer {
    const st = req && typeof req.resource === 'string' ? this.states.get(req.resource) : undefined;
    if (!st) {
      const name = req && typeof req.resource === 'string' ? oneLine(req.resource, 100) : 'resource';
      return this.error(404, 'not_found', 'This resource is not remembered.', `${name}: not a remembered resource`);
    }
    try {
      const params = isRecord(req.params) ? (req.params as Record<string, string>) : {};
      for (const p of st.res.scopeParams) {
        const v = params[p];
        if (typeof v === 'string' && v.length > COLLECTION_LIMITS.paramChars) {
          return this.notFound(st, req.op, v.slice(0, MAX_NOTE_ID));
        }
      }
      switch (req.op) {
        case 'list':
          return this.list(st, params, Array.isArray(req.query) ? req.query : []);
        case 'create':
          return this.create(st, params, req);
        case 'get':
          return this.getItem(st, params);
        case 'replace':
        case 'patch':
          return this.change(st, params, req);
        case 'delete':
          return this.deleteItem(st, params);
        default:
          return this.error(405, 'method_not_allowed', 'This operation is not supported.', `${st.label}: unsupported operation`);
      }
    } catch (e) {
      return this.error(500, 'store_error', 'The stateful mock failed.', `${st.label}: failed (${oneLine(String(e), 80)})`);
    }
  }

  items(resource: string, opts: StoreItemsOptions = {}): { total: number; items: unknown[]; truncated?: true } {
    const st = this.states.get(resource);
    if (!st) return { total: 0, items: [] };
    let records: Rec[];
    if (opts.scope && st.res.scopeParams.length > 0) records = this.readScope(st, opts.scope).records;
    else records = [...st.scopes.values()].flatMap((s) => s.records);
    const filter = typeof opts.filter === 'string' ? lower(opts.filter.trim()) : '';
    if (filter) records = records.filter((r) => lower(stringify(r)).includes(filter));
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
    const limit = Math.min(MAX_ITEMS_LIMIT, Math.max(0, Math.floor(opts.limit === undefined ? DEFAULT_ITEMS_LIMIT : Number(opts.limit) || 0)));
    const slice = records.slice(offset, offset + limit);
    const items: unknown[] = [];
    let bytes = 2;
    let truncated = false;
    for (const r of slice) {
      const text = stringify(r);
      const size = utf8Length(text) + 1;
      if (bytes + size > STORE_LIMITS.answerBytes) {
        truncated = true;
        break;
      }
      bytes += size;
      items.push(JSON.parse(text));
    }
    return truncated ? { total: records.length, items, truncated: true } : { total: records.length, items };
  }

  replace(resource: string, items: unknown[], scope?: Record<string, string>): string[] {
    const st = this.states.get(resource);
    if (!st) return [`${oneLine(String(resource), MAX_NOTE_ID)}: no such resource`];
    if (!Array.isArray(items)) return [`${st.label}: items must be a list of JSON objects`];
    const problems: string[] = [];
    const scoped = st.res.scopeParams.length > 0;
    if (scoped && !scope) {
      for (const s of st.scopes.values()) this.dropScope(st, s);
    } else {
      const s = st.scopes.get(scopeKey(st.res, scope ?? {}));
      if (s) this.dropScope(st, s);
      if (!scoped) this.ensureScope(st, {});
      else this.ensureScope(st, this.scopeValues(st, scope ?? {}));
    }
    st.dirty = true;
    for (let i = 0; i < items.length; i++) {
      const p = this.putOne(st, items[i], scoped ? scope : undefined, `item ${i + 1}`, false);
      if (p) problems.push(p);
      if (problems.length >= MAX_PROBLEMS) break;
    }
    return problems;
  }

  put(resource: string, item: unknown, scope?: Record<string, string>): string[] {
    const st = this.states.get(resource);
    if (!st) return [`${oneLine(String(resource), MAX_NOTE_ID)}: no such resource`];
    const p = this.putOne(st, item, st.res.scopeParams.length > 0 ? scope : undefined, 'the item', true);
    return p ? [p] : [];
  }

  remove(resource: string, itemId: string, scope?: Record<string, string>): boolean {
    const st = this.states.get(resource);
    if (!st || typeof itemId !== 'string') return false;
    const candidates = scope && st.res.scopeParams.length > 0 ? [this.writeScope(st, scope)] : [...st.scopes.values()];
    for (const s of candidates) {
      if (!s) continue;
      const rec = s.index.get(itemId);
      if (rec) {
        this.removeRecord(st, s, itemId, rec);
        st.dirty = true;
        return true;
      }
    }
    return false;
  }

  generate(resource: string, count: number, scope?: Record<string, string>): string[] {
    const st = this.states.get(resource);
    if (!st) return [`${oneLine(String(resource), MAX_NOTE_ID)}: no such resource`];
    const n = Math.floor(Number(count) || 0);
    if (n < 1 || n > STORE_LIMITS.generateCount) return [`${st.label}: count must be 1–${STORE_LIMITS.generateCount}`];
    if (st.res.scopeParams.length > 0 && !scope) return [`${st.label}: pass the scope (${st.res.scopeParams.join(', ')}) to add records`];
    const target = this.writeScope(st, scope ?? {});
    if (!target) return [`${st.label}: store full`];
    const template = st.seed[0] ?? target.records[0] ?? [...st.scopes.values()].find((s) => s.records.length > 0)?.records[0];
    const nameField = template ? NAME_LIKE.find((k) => typeof template[k] === 'string') : undefined;
    const nameValue = nameField && template ? (template[nameField] as string) : undefined;
    let added = 0;
    for (let i = 0; i < n; i++) {
      const rec = nullObject();
      const id = this.newId(st, target);
      if (id === undefined) {
        st.dirty = st.dirty || added > 0;
        return [`${st.label}: only ${added} of ${n} added (${COUNTER_USED_UP})`];
      }
      setKey(rec, st.res.idField, id);
      const seq = target.records.length + 1;
      if (template) {
        for (const k of Object.keys(template)) {
          if (k === st.res.idField) continue;
          const v = template[k];
          if (nameValue !== undefined && v === nameValue) setKey(rec, k, `${nameValue} ${seq}`);
          else copyKey(rec, k, template);
        }
      }
      this.fillScopeFields(st, rec, target.values);
      const refusal = this.fits(st, rec, 0, true);
      if (refusal) {
        st.dirty = st.dirty || added > 0;
        return [`${st.label}: only ${added} of ${n} added (${refusal})`];
      }
      this.insert(st, target, rec);
      added++;
    }
    if (added > 0) st.dirty = true;
    return [];
  }

  reset(resource?: string): void {
    for (const st of this.states.values()) {
      if (resource === undefined || st.res.name === resource) this.resetState(st);
    }
  }

  /** Null-prototype: a resource named `__proto__` / `constructor` is counted like any other (REVIEW-16 #15c). */
  counts(): Record<string, number> {
    const out = nullObject() as Record<string, number>;
    for (const st of this.states.values()) setKey(out, st.res.name, st.count);
    return out;
  }

  dump(): StoreSnapshot {
    // null-prototype objects: a resource named `__proto__` is dumped like any other (REVIEW-16 #15c)
    const resources = nullObject() as StoreSnapshot['resources'];
    const next = nullObject() as Record<string, number>;
    for (const st of this.states.values()) {
      const entries: { scope?: Record<string, string>; records: unknown[] }[] = [];
      for (const s of st.scopes.values()) {
        // REVIEW-16 #10: an empty parent of a resource with no seed reads as one never stored: not written
        if (s.records.length === 0 && this.emptyMeansNothing(st)) continue;
        const records = s.records.map((r) => plain(r));
        entries.push(st.res.scopeParams.length > 0 ? { scope: Object.assign(nullObject(), s.values) as Record<string, string>, records } : { records });
      }
      setKey(resources as JsonRecord, st.res.name, entries);
      setKey(next as JsonRecord, st.res.name, st.next);
    }
    return { version: 1, collection: '', savedAt: new Date().toISOString(), resources, next };
  }

  /**
   * Replaces the data of the resources the snapshot names (the others are kept). The whole snapshot is checked first:
   * a broken one changes nothing. Unknown resources are reported, not applied. `asStart` makes the loaded data the
   * starting point (`changed` false, `reset` comes back to it).
   */
  load(s: StoreSnapshot, opts: { asStart?: boolean } = {}): string[] {
    const checked = validateSnapshot(s);
    if (!checked.snapshot) return checked.problems;
    const snap = checked.snapshot;
    const problems: string[] = [];
    const plan: { st: State; scopes: { values: Record<string, string>; records: Rec[]; sizes: number[] }[]; next: number; bytes: number; count: number }[] = [];
    let broken = false;
    for (const name of Object.keys(snap.resources)) {
      const st = this.states.get(name);
      if (!st) {
        problems.push(`${oneLine(name, MAX_NOTE_ID)}: not a resource of this collection (skipped)`);
        continue;
      }
      const res = st.res;
      const scopes: { values: Record<string, string>; records: Rec[]; sizes: number[] }[] = [];
      const seenScopes = new Set<string>();
      let bytes = 0;
      let count = 0;
      let maxInt = 0;
      for (const entry of snap.resources[name]) {
        const values = entry.scope ?? (nullObject() as Record<string, string>);
        const keys = Object.keys(values);
        if (keys.length !== res.scopeParams.length || !res.scopeParams.every((p) => hasOwnKey(values, p))) {
          problems.push(`${st.label}: a scope must name ${res.scopeParams.length ? res.scopeParams.join(', ') : 'nothing'}`);
          broken = true;
          break;
        }
        const key = scopeKey(res, values);
        if (seenScopes.has(key)) {
          problems.push(`${st.label}: a scope is listed twice`);
          broken = true;
          break;
        }
        seenScopes.add(key);
        if (entry.records.length === 0 && res.scopeParams.length > 0) {
          // REVIEW-16 #10: with no seed an empty parent reads as one never stored (skipped); with a seed it is a
          // parent the user emptied, kept and counted as one record
          if (this.emptyMeansNothing(st)) continue;
          count++;
        }
        const ids = new Set<string>();
        const records: Rec[] = [];
        const sizes: number[] = [];
        for (const raw of entry.records) {
          const rec = this.withoutWriteOnly(st, raw as Rec);
          const id = idText(rec[res.idField]);
          if (id === undefined) {
            problems.push(`${st.label}: a record has no usable ${oneLine(res.idField, MAX_NOTE_ID)}`);
            broken = true;
            break;
          }
          if (ids.has(id)) {
            problems.push(`${st.label}: id ${oneLine(id, MAX_NOTE_ID)} is listed twice`);
            broken = true;
            break;
          }
          ids.add(id);
          const v = rec[res.idField];
          if (isCounterValue(v)) maxInt = Math.max(maxInt, v);
          const size = utf8Length(stringify(rec));
          records.push(rec);
          sizes.push(size);
          bytes += size;
          count++;
        }
        if (broken) break;
        scopes.push({ values: Object.assign(nullObject(), values) as Record<string, string>, records, sizes });
      }
      if (broken) break;
      if (count > STORE_LIMITS.recordsPerResource) {
        problems.push(`${st.label}: more than ${STORE_LIMITS.recordsPerResource} records (an emptied parent counts as one)`);
        broken = true;
        break;
      }
      const saved = snap.next?.[name];
      const next = res.idKind === 'integer' ? Math.max(saved ?? 1, maxInt + 1, 1) : Math.max(saved ?? 1, 1);
      plan.push({ st, scopes, next, bytes, count });
    }
    if (!broken) {
      let total = this.totalBytes;
      for (const p of plan) total += p.bytes - p.st.bytes;
      if (total > STORE_LIMITS.storeBytes) {
        problems.push(`The snapshot doesn't fit in the store (over ${Math.round(STORE_LIMITS.storeBytes / 1048576)} MB)`);
        broken = true;
      }
    }
    if (broken) return problems;

    for (const p of plan) {
      const st = p.st;
      this.clearState(st);
      for (const sc of p.scopes) {
        const scope = this.ensureScope(st, sc.values);
        sc.records.forEach((r, i) => this.insert(st, scope, r, sc.sizes[i]));
      }
      st.next = p.next;
      if (opts.asStart) {
        st.start = { scopes: p.scopes.map((sc) => ({ values: { ...sc.values }, records: sc.records.map(cloneRecord) })), next: p.next };
        st.dirty = false;
      } else {
        st.dirty = true;
      }
    }
    return problems;
  }

  // ------------------------------------------------------------------ building

  private buildState(res: Resource, byKey: Map<string, MockEndpoint>): State {
    const eps: Partial<Record<StoreOp, MockEndpoint>> = {};
    for (const op of Object.keys(res.ops) as StoreOp[]) {
      const key = res.ops[op];
      const ep = key !== undefined ? byKey.get(key) : undefined;
      if (ep) eps[op] = ep;
    }
    const queryNames = new Map<string, string>();
    for (const q of eps.list?.queryParams ?? []) if (!queryNames.has(lower(q))) queryNames.set(lower(q), q);

    const scopeFields: ScopeField[] = [];
    res.scopeParams.forEach((param) => {
      const idx = res.listPath.findIndex((s) => typeof s !== 'string' && s.param === param);
      const before = idx > 0 ? res.listPath[idx - 1] : undefined;
      const fields = [param];
      if (typeof before === 'string') {
        const one = singular(before);
        for (const f of [`${one}Id`, `${one}_id`]) if (!fields.includes(f)) fields.push(f);
      }
      scopeFields.push({ param, fields: fields.filter((f) => f !== res.idField) });
    });

    const rawLiteral = [...res.listPath].reverse().find((s): s is string => typeof s === 'string');
    const masked = maskPathSegments(res.listPath, this.envValues);
    const maskedLiteral = [...masked].reverse().find((s): s is string => typeof s === 'string');
    // REVIEW-16 #8: a list path whose last literal holds an environment value gives `item-1`, never the value
    const lastLiteral = rawLiteral !== undefined && rawLiteral === maskedLiteral ? rawLiteral : 'item';
    const st: State = {
      res,
      label: oneLine(res.name, 100),
      eps,
      seed: [],
      seedNext: 1,
      scopes: new Map(),
      next: 1,
      count: 0,
      bytes: 0,
      dirty: false,
      queryNames,
      scopeFields,
      idBase: oneLine(lastLiteral, 40).replace(/\s+/g, '-'),
    };

    if (res.list.wrapper) {
      const t = cleanJson(res.list.wrapper.template, 64);
      const path = Array.isArray(res.list.wrapper.path) ? res.list.wrapper.path.map(String) : [];
      if (t.ok && isRecord(t.value) && path.length > 0) {
        const template = t.value;
        const holder = valueAt(template, path.slice(0, -1));
        if (isRecord(holder)) {
          const key = path[path.length - 1];
          const totals: { holder: Rec; key: string }[] = [];
          for (const ptr of res.list.wrapper.totals ?? []) {
            const parts = typeof ptr === 'string' ? fromPointer(ptr) : undefined;
            if (!parts || parts.length === 0) continue;
            const h = valueAt(template, parts.slice(0, -1));
            if (isRecord(h)) totals.push({ holder: h, key: parts[parts.length - 1] });
          }
          const counters: Rec[] = [];
          for (const p of counterHolders(path)) {
            const h = valueAt(template, p);
            if (isRecord(h) && !counters.includes(h)) counters.push(h);
          }
          st.wrapper = { path, template, holder, key, totals, counters };
        }
      }
    }

    // §22.4 seed.
    const source = seedRecords(res, byKey);
    const seen = new Set<string>();
    let bytes = 0;
    let maxInt = 0;
    let skipped = 0;
    for (const raw of source.records) {
      const c = cleanJson(raw);
      if (!c.ok || !isRecord(c.value)) {
        skipped++;
        continue;
      }
      const rec = this.withoutWriteOnly(st, c.value);
      const id = idText(rec[res.idField]);
      if (id === undefined || seen.has(id)) continue;
      const size = utf8Length(stringify(rec));
      if (size > STORE_LIMITS.recordBytes || st.seed.length >= STORE_LIMITS.recordsPerResource || bytes + size > STORE_LIMITS.storeBytes) {
        skipped++;
        continue;
      }
      seen.add(id);
      bytes += size;
      st.seed.push(rec);
      const v = rec[res.idField];
      if (isCounterValue(v)) maxInt = Math.max(maxInt, v);
    }
    if (skipped > 0) this.problem(`${st.label}: ${skipped} example records were left out of the seed (too large or too deep)`);
    st.seedNext = res.idKind === 'integer' ? maxInt + 1 : 1;
    return st;
  }

  private resetState(st: State): void {
    this.clearState(st);
    if (st.start) {
      for (const sc of st.start.scopes) {
        const scope = this.ensureScope(st, sc.values);
        for (const r of sc.records) this.insert(st, scope, cloneRecord(r));
      }
      st.next = st.start.next;
    } else {
      if (st.res.scopeParams.length === 0) {
        const scope = this.ensureScope(st, {});
        for (const r of st.seed) {
          if (this.fits(st, r, 0, true)) break;
          this.insert(st, scope, cloneRecord(r));
        }
      }
      st.next = st.seedNext;
    }
    st.dirty = false;
  }

  private clearState(st: State): void {
    this.totalBytes -= st.bytes;
    st.scopes.clear();
    st.count = 0;
    st.bytes = 0;
  }

  // ------------------------------------------------------------------ scopes and records

  private scopeValues(st: State, params: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of st.res.scopeParams) out[p] = typeof params[p] === 'string' ? params[p] : '';
    return out;
  }

  /** The scope for reading: stored, or (nested, never changed) a view of the seed. */
  private readScope(st: State, params: Record<string, string>): Scope {
    const values = this.scopeValues(st, params);
    const stored = st.scopes.get(scopeKey(st.res, values));
    if (stored) return stored;
    const records = st.seed.map((r) => {
      const c = cloneRecord(r);
      this.fillScopeFields(st, c, values);
      return c;
    });
    const index = new Map<string, Rec>();
    for (const r of records) {
      const id = idText(r[st.res.idField]);
      if (id !== undefined) index.set(id, r);
    }
    return { values, records, index };
  }

  /** The scope for a change: stored, materialised from the seed on first use. Undefined when the seed doesn't fit. */
  private writeScope(st: State, params: Record<string, string>): Scope | undefined {
    const values = this.scopeValues(st, params);
    const stored = st.scopes.get(scopeKey(st.res, values));
    if (stored) return stored;
    const view = this.readScope(st, values);
    let bytes = 0;
    const sizes = view.records.map((r) => {
      const s = utf8Length(stringify(r));
      bytes += s;
      return s;
    });
    // REVIEW-16 #10: emptied parents of a seeded resource count as one record each, as in a snapshot
    const emptied = this.emptyMeansNothing(st) ? 0 : this.emptyScopes(st);
    if (st.count + emptied + view.records.length > STORE_LIMITS.recordsPerResource || this.totalBytes + bytes > STORE_LIMITS.storeBytes) {
      return undefined;
    }
    const scope = this.ensureScope(st, values);
    view.records.forEach((r, i) => this.insert(st, scope, r, sizes[i]));
    return scope;
  }

  /** A nested resource with no seed: an empty parent reads the same as one never stored (REVIEW-16 #10). */
  private emptyMeansNothing(st: State): boolean {
    return st.res.scopeParams.length > 0 && st.seed.length === 0;
  }

  private emptyScopes(st: State): number {
    let n = 0;
    for (const s of st.scopes.values()) if (s.records.length === 0) n++;
    return n;
  }

  private ensureScope(st: State, values: Record<string, string>): Scope {
    const key = scopeKey(st.res, values);
    let s = st.scopes.get(key);
    if (!s) {
      s = { values: this.scopeValues(st, values), records: [], index: new Map() };
      st.scopes.set(key, s);
    }
    return s;
  }

  private dropScope(st: State, s: Scope): void {
    for (const r of s.records) {
      const size = this.sizeOf(r);
      st.bytes -= size;
      this.totalBytes -= size;
    }
    st.count -= s.records.length;
    st.scopes.delete(scopeKey(st.res, s.values));
  }

  private readonly sizes = new WeakMap<Rec, number>();

  private sizeOf(r: Rec): number {
    let s = this.sizes.get(r);
    if (s === undefined) {
      s = utf8Length(stringify(r));
      this.sizes.set(r, s);
    }
    return s;
  }

  private insert(st: State, scope: Scope, rec: Rec, size?: number): void {
    const s = size ?? utf8Length(stringify(rec));
    this.sizes.set(rec, s);
    scope.records.push(rec);
    const id = idText(rec[st.res.idField]);
    if (id !== undefined) scope.index.set(id, rec);
    st.count++;
    st.bytes += s;
    this.totalBytes += s;
  }

  private swap(st: State, scope: Scope, id: string, old: Rec, rec: Rec, size: number): void {
    const i = scope.records.indexOf(old);
    const oldSize = this.sizeOf(old);
    if (i >= 0) scope.records[i] = rec;
    else scope.records.push(rec);
    scope.index.set(id, rec);
    this.sizes.set(rec, size);
    st.bytes += size - oldSize;
    this.totalBytes += size - oldSize;
  }

  private removeRecord(st: State, scope: Scope, id: string, rec: Rec): void {
    const i = scope.records.indexOf(rec);
    if (i >= 0) scope.records.splice(i, 1);
    scope.index.delete(id);
    const size = this.sizeOf(rec);
    st.count--;
    st.bytes -= size;
    this.totalBytes -= size;
    // REVIEW-16 #10: an emptied parent of a resource with no seed is forgotten (it reads the same), so app traffic
    // (create, then delete, in ever new parents) can't pile up empty parents
    if (scope.records.length === 0 && this.emptyMeansNothing(st) && st.scopes.get(scopeKey(st.res, scope.values)) === scope) {
      st.scopes.delete(scopeKey(st.res, scope.values));
    }
  }

  /** Why `rec` can't be stored (replacing a record of `oldSize` bytes, or adding one), or undefined. */
  private fits(st: State, rec: Rec, oldSize: number, adding: boolean, size?: number): string | undefined {
    const s = size ?? utf8Length(stringify(rec));
    if (s > STORE_LIMITS.recordBytes) return `a record is over ${Math.round(STORE_LIMITS.recordBytes / 1048576)} MB`;
    if (adding && st.count + 1 > STORE_LIMITS.recordsPerResource) return `${STORE_LIMITS.recordsPerResource} records is the most a resource keeps`;
    if (this.totalBytes + s - oldSize > STORE_LIMITS.storeBytes) return `the store is full (${Math.round(STORE_LIMITS.storeBytes / 1048576)} MB)`;
    return undefined;
  }

  private withoutWriteOnly(st: State, rec: Rec): Rec {
    for (const w of st.res.writeOnly) if (w !== st.res.idField && hasOwnKey(rec, w)) delete rec[w];
    return rec;
  }

  private fillScopeFields(st: State, rec: Rec, values: Record<string, string>): void {
    for (const sf of st.scopeFields) {
      const v = values[sf.param];
      if (v === undefined || v === '') continue;
      for (const f of sf.fields) {
        if (!hasOwnKey(rec, f)) continue;
        const cur = rec[f];
        const asNumber = typeof cur === 'number' && /^-?\d{1,15}$/.test(v) ? Number(v) : undefined;
        setKey(rec, f, asNumber ?? v);
      }
    }
  }

  /** Scope values from a record's own scope fields (`userId: 1` → `{userId: '1'}`), or undefined. */
  private scopeFromRecord(st: State, rec: Rec): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const sf of st.scopeFields) {
      const f = sf.fields.find((k) => hasOwnKey(rec, k) && idText(rec[k]) !== undefined);
      if (!f) return undefined;
      out[sf.param] = idText(rec[f]) as string;
    }
    return out;
  }

  /**
   * The next free id, or undefined when the counter is used up (REVIEW-16 #13). The counter only ever holds safe
   * integers (`movesCounter`), so it always advances and the loop ends within the scope's record count.
   */
  private newId(st: State, scope: Scope): string | number | undefined {
    const kind = st.res.idKind;
    for (let guard = 0; guard <= STORE_LIMITS.recordsPerResource + 1; guard++) {
      if (!Number.isSafeInteger(st.next) || st.next < 1) return undefined;
      const n = st.next++;
      const id: string | number = kind === 'integer' ? n : kind === 'uuid' ? uuidFor(n) : `${st.idBase}-${n}`;
      if (!scope.index.has(String(id))) return id;
    }
    return undefined;
  }

  /**
   * Puts one item from the agent / panel API (insert or replace by id). A problem line, or undefined. Nested resource
   * without a scope (§22.14): `findExisting` → the record with that id in the first stored scope that has it; a new
   * record takes its scope from its own scope field (`userId`).
   */
  private putOne(st: State, item: unknown, scope: Record<string, string> | undefined, label: string, findExisting: boolean): string | undefined {
    const c = cleanJson(item);
    if (!c.ok) return `${st.label}: ${label} was skipped (${c.reason})`;
    if (!isRecord(c.value)) return `${st.label}: ${label} was skipped (not a JSON object)`;
    const rec = this.withoutWriteOnly(st, c.value);
    let values: Record<string, string> = {};
    if (st.res.scopeParams.length > 0) {
      let v = scope;
      if (!v && findExisting) {
        const given = idText(rec[st.res.idField]);
        if (given !== undefined) {
          for (const s of st.scopes.values()) {
            if (s.index.has(given)) {
              v = s.values;
              break;
            }
          }
        }
      }
      v = v ?? this.scopeFromRecord(st, rec);
      if (!v) return `${st.label}: set ${st.res.scopeParams.join(', ')} to say which parent it belongs to`;
      values = v;
    }
    const target = this.writeScope(st, values);
    if (!target) return `${st.label}: ${label} was skipped (the store is full)`;
    const raw = rec[st.res.idField];
    let id: string | number;
    if (raw === undefined || raw === null) {
      const fresh = this.newId(st, target);
      if (fresh === undefined) return `${st.label}: ${label} was skipped (${COUNTER_USED_UP})`;
      id = fresh;
    } else {
      const t = idText(raw);
      if (t === undefined) return `${st.label}: ${label} was skipped (its ${oneLine(st.res.idField, MAX_NOTE_ID)} must be text or a number, ≤ ${COLLECTION_LIMITS.paramChars} characters)`;
      if (isUnsafeInteger(raw)) return `${st.label}: ${label} was skipped (its ${oneLine(st.res.idField, MAX_NOTE_ID)} ${UNSAFE_ID})`;
      id = raw as string | number;
      if (movesCounter(st, raw)) st.next = Math.max(st.next, (raw as number) + 1);
    }
    const out = nullObject();
    if (raw === undefined || raw === null) setKey(out, st.res.idField, id);
    else copyKey(out, st.res.idField, rec);
    for (const k of Object.keys(rec)) if (k !== st.res.idField) copyKey(out, k, rec);
    this.fillScopeFields(st, out, target.values);
    const key = String(id);
    const old = target.index.get(key);
    const size = utf8Length(stringify(out));
    const refusal = this.fits(st, out, old ? this.sizeOf(old) : 0, !old, size);
    if (refusal) return `${st.label}: ${label} was skipped (${refusal})`;
    if (old) this.swap(st, target, key, old, out, size);
    else this.insert(st, target, out, size);
    st.dirty = true;
    return undefined;
  }

  // ------------------------------------------------------------------ answers

  private problem(line: string): void {
    const l = oneLine(line, 300);
    if (this.problemLines.length < MAX_PROBLEMS && !this.problemLines.includes(l)) this.problemLines.push(l);
  }

  private error(status: number, code: string, message: string, note: string, itemId?: string): StoreAnswer {
    const headers = headerObject();
    headers['content-type'] = JSON_TYPE;
    return {
      status,
      headers,
      body: stringify({ error: code, message }),
      note: oneLine(note, 300),
      ...(itemId !== undefined ? { itemId } : {}),
    };
  }

  /** The example's headers minus framing, with a JSON content-type when there is a body. */
  private headersFrom(ex: MockExample | undefined, hasBody: boolean, keepExampleType = false): Record<string, string> {
    const out = headerObject();
    if (ex && ex.headers && typeof ex.headers === 'object') {
      for (const k of Object.keys(ex.headers)) {
        const name = lower(k);
        if (FRAMING.has(name) || name === '__proto__') continue;
        const v = ex.headers[k];
        // REVIEW-16 #14: one header HTTP can't send must not turn every answer of the resource into a 502
        if (typeof v === 'string' && sendableHeader(name, v)) out[name] = v;
      }
    }
    if (hasBody) {
      const ct = out['content-type'];
      if (!(keepExampleType && ct) && !isJsonType(ct)) out['content-type'] = JSON_TYPE;
    } else {
      delete out['content-type'];
    }
    return out;
  }

  private okAnswer(st: State, op: StoreOp, defaultStatus: number, body: string, note: string, itemId?: string): StoreAnswer {
    const ex = writtenOk(st.eps[op]);
    const status = ex ? ex.status : defaultStatus;
    const text = NO_BODY_STATUS.has(status) ? '' : body;
    return {
      status,
      headers: this.headersFrom(ex, text !== ''),
      body: text,
      note: oneLine(`${st.label}: ${note}`, 300),
      ...(itemId !== undefined ? { itemId } : {}),
    };
  }

  private notFound(st: State, op: StoreOp, id: string): StoreAnswer {
    const shortId = oneLine(id, MAX_NOTE_ID);
    const note = `${st.label}: ${shortId} not found`;
    for (const ep of [st.eps[op], st.eps.get]) {
      const ex = ep?.examples.find((e) => e.status === 404 && !e.generated && !e.query);
      if (ex) {
        return { status: 404, headers: this.headersFrom(ex, ex.body !== '', true), body: ex.body, note: oneLine(note, 300), itemId: id };
      }
    }
    return this.error(404, 'not_found', `${st.res.name} ${shortId} not found`, note, id);
  }

  private full(st: State, reason: string): StoreAnswer {
    this.problem(`${st.label}: a change was refused, ${reason}`);
    return this.error(507, 'store_full', `The stateful mock can't keep this: ${reason}. Reset the data or remove records.`, `${st.label}: store full (${reason})`);
  }

  /** The request body as a JSON object, or the error answer. */
  private readBody(st: State, req: StoreRequest, allowEmpty: boolean): { rec: Rec } | { answer: StoreAnswer } {
    const body = req.body;
    if (body?.truncated) {
      return { answer: this.error(413, 'too_large', 'The request body is over 5 MB.', `${st.label}: rejected, body over 5 MB`) };
    }
    const ct = typeof req.contentType === 'string' ? lower(req.contentType.split(';')[0].trim()) : '';
    const unsupported = (): { answer: StoreAnswer } => ({
      answer: this.error(415, 'unsupported_media_type', 'Send the body as a JSON object (application/json).', `${st.label}: rejected, body is ${oneLine(ct || 'not JSON', 60)}`),
    });
    if (ct === 'application/json-patch+json' || ct === 'application/x-www-form-urlencoded' || ct.startsWith('multipart/')) return unsupported();
    const text = typeof body?.text === 'string' ? body.text : '';
    if (text.trim() === '') {
      if (allowEmpty) return { rec: nullObject() };
      return { answer: this.error(400, 'bad_request', 'The request body is empty: send a JSON object.', `${st.label}: rejected, empty body`) };
    }
    const parsed = parseJsonText(text);
    if (!parsed.ok) {
      if (ct && !isJsonType(ct)) return unsupported();
      return { answer: this.error(400, 'bad_request', "The request body isn't valid JSON.", `${st.label}: rejected, body isn't JSON`) };
    }
    if (!isRecord(parsed.value)) {
      return { answer: this.error(400, 'bad_request', 'The request body must be a JSON object.', `${st.label}: rejected, body isn't a JSON object`) };
    }
    const c = cleanJson(parsed.value);
    if (!c.ok || !isRecord(c.value)) {
      return { answer: this.error(400, 'bad_request', `The request body can't be stored: ${c.ok ? 'not an object' : c.reason}.`, `${st.label}: rejected, body too deep`) };
    }
    return { rec: this.withoutWriteOnly(st, c.value) };
  }

  private itemIdOf(st: State, params: Record<string, string>): string {
    const v = params[st.res.itemParam];
    return typeof v === 'string' ? v : '';
  }

  private getItem(st: State, params: Record<string, string>): StoreAnswer {
    const id = this.itemIdOf(st, params);
    const scope = this.readScope(st, params);
    const rec = id ? scope.index.get(id) : undefined;
    if (!rec) return this.notFound(st, 'get', id);
    return this.okAnswer(st, 'get', 200, stringify(rec), `read ${oneLine(id, MAX_NOTE_ID)}`, id);
  }

  private create(st: State, params: Record<string, string>, req: StoreRequest): StoreAnswer {
    const read = this.readBody(st, req, true);
    if ('answer' in read) return read.answer;
    const body = read.rec;
    const scope = this.writeScope(st, params);
    if (!scope) return this.full(st, `${STORE_LIMITS.recordsPerResource} records is the most a resource keeps`);

    const idField = st.res.idField;
    let id: string | number;
    const given = body[idField];
    if (given !== undefined && given !== null) {
      const t = idText(given);
      if (t === undefined) {
        return this.error(400, 'bad_request', `${idField} must be text or a number of at most ${COLLECTION_LIMITS.paramChars} characters.`, `${st.label}: rejected, bad ${oneLine(idField, MAX_NOTE_ID)}`);
      }
      // REVIEW-16 #13: a number id past 2^53 can't be kept exactly (and would freeze the counter): refused
      if (isUnsafeInteger(given)) {
        return this.error(400, 'bad_request', `${idField} ${UNSAFE_ID}.`, `${st.label}: rejected, ${oneLine(idField, MAX_NOTE_ID)} too large`);
      }
      if (scope.index.has(t)) {
        return this.error(409, 'conflict', `${st.res.name} ${oneLine(t, MAX_NOTE_ID)} already exists.`, `${st.label}: ${oneLine(t, MAX_NOTE_ID)} already exists`, t);
      }
      id = given as string | number;
    } else {
      const fresh = this.newId(st, scope);
      if (fresh === undefined) return this.full(st, COUNTER_USED_UP);
      id = fresh;
    }

    const rec = nullObject();
    if (given !== undefined && given !== null) copyKey(rec, idField, body);
    else setKey(rec, idField, id);
    const ex = writtenOk(st.eps.create) ?? st.eps.create?.examples.find((e) => e.generated && e.status >= 200 && e.status <= 299);
    if (ex) {
      const p = parseJsonText(ex.body);
      const base = p.ok ? cleanJson(p.value) : undefined;
      if (base?.ok && isRecord(base.value)) {
        for (const k of Object.keys(base.value)) if (k !== idField) copyKey(rec, k, base.value);
      }
    }
    for (const k of Object.keys(body)) if (k !== idField) copyKey(rec, k, body);
    this.withoutWriteOnly(st, rec);
    this.fillScopeFields(st, rec, scope.values);

    const text = stringify(rec);
    const size = utf8Length(text);
    const refusal = this.fits(st, rec, 0, true, size);
    if (refusal) {
      // A client id that was taken from the counter stays used (ids are never reused).
      return this.full(st, refusal);
    }
    if (movesCounter(st, id)) st.next = Math.max(st.next, (id as number) + 1);
    this.insert(st, scope, rec, size);
    st.dirty = true;
    const shown = String(id);
    return this.okAnswer(st, 'create', 201, text, `created ${oneLine(shown, MAX_NOTE_ID)}`, shown);
  }

  private change(st: State, params: Record<string, string>, req: StoreRequest): StoreAnswer {
    const op = req.op;
    const id = this.itemIdOf(st, params);
    const existing = id ? this.readScope(st, params).index.get(id) : undefined;
    if (!existing) return this.notFound(st, op, id);
    const read = this.readBody(st, req, false);
    if ('answer' in read) return read.answer;
    const body = read.rec;
    const scope = this.writeScope(st, params);
    if (!scope) return this.full(st, `${STORE_LIMITS.recordsPerResource} records is the most a resource keeps`);
    const old = scope.index.get(id);
    if (!old) return this.notFound(st, op, id);

    const idField = st.res.idField;
    const rec = nullObject();
    copyKey(rec, idField, old);
    if (op === 'patch') {
      for (const k of Object.keys(old)) if (k !== idField) copyKey(rec, k, old);
    }
    for (const k of Object.keys(body)) if (k !== idField) copyKey(rec, k, body);
    this.withoutWriteOnly(st, rec);
    this.fillScopeFields(st, rec, scope.values);

    const text = stringify(rec);
    const size = utf8Length(text);
    const refusal = this.fits(st, rec, this.sizeOf(old), false, size);
    if (refusal) return this.full(st, refusal);
    this.swap(st, scope, id, old, rec, size);
    st.dirty = true;
    return this.okAnswer(st, op, 200, text, `updated ${oneLine(id, MAX_NOTE_ID)}`, id);
  }

  private deleteItem(st: State, params: Record<string, string>): StoreAnswer {
    const id = this.itemIdOf(st, params);
    const existing = id ? this.readScope(st, params).index.get(id) : undefined;
    if (!existing) return this.notFound(st, 'delete', id);
    const scope = this.writeScope(st, params);
    if (!scope) return this.full(st, `${STORE_LIMITS.recordsPerResource} records is the most a resource keeps`);
    const rec = scope.index.get(id);
    if (!rec) return this.notFound(st, 'delete', id);
    this.removeRecord(st, scope, id, rec);
    st.dirty = true;
    const note = oneLine(`${st.label}: deleted ${oneLine(id, MAX_NOTE_ID)}`, 300);
    const ex = writtenOk(st.eps.delete);
    if (ex) {
      const body = NO_BODY_STATUS.has(ex.status) ? '' : ex.body;
      return { status: ex.status, headers: this.headersFrom(ex, body !== '', true), body, note, itemId: id };
    }
    return { status: 204, headers: headerObject(), body: '', note, itemId: id };
  }

  private list(st: State, params: Record<string, string>, query: [string, string][]): StoreAnswer {
    const scope = this.readScope(st, params);
    const declared = st.queryNames;
    const q = new Map<string, string[]>();
    for (const pair of query) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
      const name = pair[0];
      const value = typeof pair[1] === 'string' ? pair[1] : '';
      const list = q.get(name);
      if (list) list.push(value);
      else q.set(name, [value]);
    }
    const used = new Set<string>();
    /** A query value for one of `names` the collection declares on this list (case-insensitive). */
    const take = (names: string[]): string | undefined => {
      for (const n of names) {
        if (!declared.has(n)) continue;
        for (const [k, vs] of q) {
          if (lower(k) === n) {
            used.add(k);
            return vs[0];
          }
        }
      }
      return undefined;
    };
    const posInt = (v: string | undefined, min: number): number | undefined => {
      if (v === undefined || !/^\d{1,9}$/.test(v.trim())) return undefined;
      const n = Number(v.trim());
      return n >= min ? n : undefined;
    };
    const page = posInt(take(PAGE_NAMES), 1);
    const size = posInt(take(SIZE_NAMES), 1);
    const offset = posInt(take(OFFSET_NAMES), 0);
    const sortRaw = take(SORT_NAMES);
    const orderRaw = take(ORDER_NAMES);

    let records = scope.records;
    // Filters: other parameters, only when every record of the list has that field.
    for (const [k, vs] of q) {
      if (used.has(k) || k === '__proto__') continue;
      if (records.length === 0) break;
      if (!scope.records.every((r) => hasOwnKey(r, k))) continue;
      records = records.filter((r) => {
        const v = r[k];
        if (v !== null && typeof v === 'object') return false;
        return vs.includes(String(v));
      });
    }

    if (sortRaw !== undefined && sortRaw.trim() !== '') {
      let field = sortRaw.trim();
      let desc = false;
      if (field.startsWith('-')) {
        desc = true;
        field = field.slice(1);
      }
      const m = /^([^,:]+)[,:](asc|desc)$/i.exec(field);
      if (m) {
        field = m[1];
        desc = lower(m[2]) === 'desc';
      } else if (field.includes(',')) {
        field = field.split(',')[0];
      }
      if (orderRaw !== undefined) desc = lower(orderRaw.trim()) === 'desc';
      const f = field.trim();
      const dir = desc ? -1 : 1;
      records = records
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          const x = a.r[f];
          const y = b.r[f];
          const xm = x === undefined || x === null;
          const ym = y === undefined || y === null;
          if (xm || ym) return xm && ym ? a.i - b.i : xm ? 1 : -1;
          let c: number;
          if (typeof x === 'number' && typeof y === 'number') c = x - y;
          else {
            const xs = typeof x === 'object' ? stringify(x) : String(x);
            const ys = typeof y === 'object' ? stringify(y) : String(y);
            c = xs < ys ? -1 : xs > ys ? 1 : 0;
          }
          return c !== 0 ? c * dir : a.i - b.i;
        })
        .map((e) => e.r);
    }

    const total = records.length;
    let start = 0;
    let count = total;
    let paging: { page?: number; size?: number; offset?: number } | undefined;
    if (page !== undefined) {
      const s = size ?? DEFAULT_PAGE_SIZE;
      start = (page - 1) * s;
      count = s;
      paging = { page, size: s, offset: start };
    } else if (offset !== undefined) {
      start = offset;
      count = size ?? total;
      paging = { offset, ...(size !== undefined ? { size } : {}) };
    } else if (size !== undefined) {
      count = size;
      paging = { size, offset: 0 };
    }
    let slice = records.slice(start, start + count);

    // Answer cap: keep the records that fit.
    const overhead = st.wrapper ? utf8Length(stringify(st.wrapper.template)) + 64 : 2;
    let truncated = false;
    if (st.bytes + slice.length + overhead > STORE_LIMITS.answerBytes) {
      let bytes = overhead;
      let n = 0;
      for (const r of slice) {
        const s = this.sizeOf(r) + 1;
        if (bytes + s > STORE_LIMITS.answerBytes) {
          truncated = true;
          break;
        }
        bytes += s;
        n++;
      }
      if (truncated) slice = slice.slice(0, n);
    }

    const arrayText = stringify(slice);
    let body = arrayText;
    if (st.wrapper) body = this.wrap(st, arrayText, total, paging);

    const ex = writtenOk(st.eps.list);
    const status = ex ? ex.status : 200;
    const headers = this.headersFrom(ex, true);
    headers['x-total-count'] = String(total);
    if (truncated) headers['x-flutter-intercept'] = 'truncated';
    if (truncated) this.problem(`${st.label}: a list answer was cut to fit 5 MB`);
    const note = `${st.label}: listed ${slice.length} of ${total}`;
    return { status, headers, body: NO_BODY_STATUS.has(status) ? '' : body, note: oneLine(note, 300) };
  }

  /** The list example's wrapper around `arrayText`, counters set to `total`, page fields echoed when paging. */
  private wrap(st: State, arrayText: string, total: number, paging?: { page?: number; size?: number; offset?: number }): string {
    const w = st.wrapper as NonNullable<State['wrapper']>;
    const overrides = new Map<object, Map<string, unknown>>();
    const set = (holder: object, key: string, value: unknown): void => {
      let m = overrides.get(holder);
      if (!m) overrides.set(holder, (m = new Map()));
      m.set(key, value);
    };
    for (const t of w.totals) set(t.holder, t.key, total);
    if (paging) {
      for (const h of w.counters) {
        const isNum = (k: string): boolean => hasOwnKey(h, k) && typeof h[k] === 'number';
        if (paging.page !== undefined) for (const k of ECHO_PAGE) if (isNum(k)) set(h, k, paging.page);
        if (paging.size !== undefined) {
          for (const k of ECHO_SIZE) if (isNum(k)) set(h, k, paging.size);
          for (const k of ECHO_PAGES) if (isNum(k)) set(h, k, Math.max(1, Math.ceil(total / paging.size)));
        }
        if (paging.offset !== undefined) for (const k of ECHO_OFFSET) if (isNum(k)) set(h, k, paging.offset);
      }
    }
    const sentinel = `\u0000fi-records-${++this.sentinelSeq}\u0000`;
    set(w.holder, w.key, sentinel);
    const text = JSON.stringify(w.template, function (this: unknown, key: string, value: unknown) {
      const m = overrides.get(this as object);
      return m && m.has(key) ? m.get(key) : value;
    });
    const quoted = JSON.stringify(sentinel);
    const at = text.indexOf(quoted);
    return at < 0 ? arrayText : `${text.slice(0, at)}${arrayText}${text.slice(at + quoted.length)}`;
  }
}
