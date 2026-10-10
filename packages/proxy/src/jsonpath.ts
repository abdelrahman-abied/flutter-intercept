// JSON path subset for mutate rules and agent assertions (CONTRACTS §10.2). Pure and dependency-free
// (`@flutter-intercept/proxy/jsonpath`). Owner: proxy agent — signatures fixed by the contract.
//
// Grammar: `$` then any of `.name`, `['any key']` / `["any key"]`, `[3]`, `[*]` (every element / value).
// No filters, slices or recursive descent.
//
// Details:
// - `.name` takes any run of characters other than `.`, `[`, `]`, quotes, `*` and whitespace
//   (`$.avatar-url` works); `.*` is accepted as a synonym of `[*]`. Anything else needs `['…']`.
// - Quoted keys understand the JSON escapes (`\\ \' \" \/ \b \f \n \r \t \uXXXX`).
// - `[n]` is a non-negative integer and selects array elements only; `['0']` selects the object key "0".
// - Keys select own properties of plain objects only; `[*]` expands arrays (in order) and objects
//   (in key order). Paths that lead nowhere select nothing (never an error).
// - formatPath writes the canonical form: `.name` for identifier-like keys, `['…']` otherwise.

export type PathSegment = { key: string } | { index: number } | { wildcard: true };

type Op = { path: string; op: 'null' | 'delete' | 'set'; value?: unknown; valueJson?: string };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NAME_STOP = /[.[\]'"*\s]/;
const ESCAPES: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own data property, also for "__proto__" (never touches the prototype). */
function setKey(o: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
  else o[key] = value;
}

/** Deep copy of arrays and plain objects; anything else (primitives, class instances) is kept as is. */
function deepCopy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) setKey(out, k, deepCopy(v[k]));
  return out;
}

/** Parses a path; throws an Error with a readable message on bad syntax. */
export function parsePath(path: string): PathSegment[] {
  if (typeof path !== 'string') throw new Error(`Invalid JSON path: expected a string, got ${typeof path}`);
  const fail = (pos: number, why: string): never => {
    throw new Error(`Invalid JSON path ${JSON.stringify(path)}: ${why} (at position ${pos})`);
  };
  let i = 0;
  let end = path.length;
  while (i < end && /\s/.test(path[i])) i++;
  while (end > i && /\s/.test(path[end - 1])) end--;
  if (path[i] !== '$') fail(i, i >= end ? 'empty path, expected "$"' : 'a path starts with "$"');
  i++;
  const out: PathSegment[] = [];
  while (i < end) {
    const c = path[i];
    if (c === '.') {
      i++;
      if (path[i] === '.') fail(i - 1, 'recursive descent ("..") is not supported');
      if (path[i] === '*') {
        out.push({ wildcard: true });
        i++;
        continue;
      }
      const start = i;
      while (i < end && !NAME_STOP.test(path[i])) i++;
      if (i === start) {
        fail(start, i >= end ? 'expected a name after "."' : `unexpected ${JSON.stringify(path[i])} after "."; use ['…'] for keys with special characters`);
      }
      if (path[i] === '*') fail(i, `"*" inside a name; use ['…'] for keys with special characters`);
      out.push({ key: path.slice(start, i) });
    } else if (c === '[') {
      const open = i;
      i++;
      while (i < end && path[i] === ' ') i++;
      const q = path[i];
      if (q === "'" || q === '"') {
        i++;
        let key = '';
        for (;;) {
          if (i >= end) fail(open, `unterminated quoted key (missing ${q})`);
          const ch = path[i];
          if (ch === q) {
            i++;
            break;
          }
          if (ch === '\\') {
            const e = path[i + 1];
            if (e === 'u') {
              const hex = path.slice(i + 2, i + 6);
              if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail(i, 'bad \\u escape (expected 4 hex digits)');
              key += String.fromCharCode(parseInt(hex, 16));
              i += 6;
            } else if (e !== undefined && ESCAPES[e] !== undefined) {
              key += ESCAPES[e];
              i += 2;
            } else {
              fail(i, `unknown escape "\\${e ?? ''}"`);
            }
            continue;
          }
          key += ch;
          i++;
        }
        out.push({ key });
      } else if (q === '*') {
        i++;
        out.push({ wildcard: true });
      } else if (q !== undefined && q >= '0' && q <= '9') {
        const start = i;
        while (i < end && path[i] >= '0' && path[i] <= '9') i++;
        const index = Number(path.slice(start, i));
        if (!Number.isSafeInteger(index)) fail(start, 'index too large');
        out.push({ index });
      } else if (q === '-') {
        fail(i, 'negative indexes are not supported');
      } else if (q === '?' || q === '(') {
        fail(i, 'filter expressions are not supported');
      } else if (q === ':') {
        fail(i, 'slices are not supported');
      } else {
        fail(i, i >= end ? 'unclosed "["' : 'expected a quoted key, an index or "*" inside [ ]');
      }
      while (i < end && path[i] === ' ') i++;
      if (path[i] === ':' || path[i] === ',') fail(i, path[i] === ':' ? 'slices are not supported' : 'unions are not supported');
      if (path[i] !== ']') fail(i, i >= end ? 'unclosed "["' : `expected "]", got ${JSON.stringify(path[i])}`);
      i++;
    } else {
      fail(i, `unexpected ${JSON.stringify(c)}; expected "." or "["`);
    }
  }
  return out;
}

function quoteKey(key: string): string {
  let s = '';
  for (const ch of key) {
    const code = ch.charCodeAt(0);
    if (ch === '\\') s += '\\\\';
    else if (ch === "'") s += "\\'";
    else if (ch === '\n') s += '\\n';
    else if (ch === '\r') s += '\\r';
    else if (ch === '\t') s += '\\t';
    else if (ch === '\b') s += '\\b';
    else if (ch === '\f') s += '\\f';
    else if (code < 0x20 || code === 0x7f || (ch.length === 1 && code >= 0xd800 && code <= 0xdfff)) {
      s += `\\u${code.toString(16).padStart(4, '0')}`; // control characters and lone surrogates
    } else s += ch;
  }
  return `['${s}']`;
}

/** Formats segments back to the canonical string (`$.a[0]['b c']`). */
export function formatPath(segments: PathSegment[]): string {
  let s = '$';
  for (const seg of segments) {
    if ('wildcard' in seg) s += '[*]';
    else if ('index' in seg) {
      if (!Number.isSafeInteger(seg.index) || seg.index < 0) throw new Error(`formatPath: invalid index ${seg.index}`);
      s += `[${seg.index}]`;
    } else if (typeof seg.key === 'string') s += IDENT.test(seg.key) ? `.${seg.key}` : quoteKey(seg.key);
    else throw new Error('formatPath: invalid segment');
  }
  return s;
}

/** selectPath refuses paths that select more values than this (REVIEW-4 #8). */
export const SELECT_LIMIT = 10_000;
/** Any step of a path walk may hold at most this many places (selectPath and applyOps). */
export const WALK_LIMIT = 1_000_000;

/** A selected place. Paths are rebuilt from the parent links for results only (REVIEW-4 #8). */
interface Node {
  value: unknown;
  parent?: Node;
  seg?: PathSegment;
}

/** Expands one segment from each node (parent links kept only when `track`). */
function step(nodes: Node[], seg: PathSegment, track: boolean, path: string): Node[] {
  const next: Node[] = [];
  const at = (n: Node, value: unknown, s: PathSegment) => {
    if (next.length >= WALK_LIMIT) throw new Error(`JSON path ${path} reaches more than ${WALK_LIMIT} places`);
    next.push(track ? { value, parent: n, seg: s } : { value });
  };
  for (const n of nodes) {
    const v = n.value;
    if ('wildcard' in seg) {
      if (Array.isArray(v)) for (let i = 0; i < v.length; i++) at(n, v[i], { index: i });
      else if (isPlainObject(v)) for (const k of Object.keys(v)) at(n, v[k], { key: k });
    } else if ('index' in seg) {
      if (Array.isArray(v) && seg.index < v.length) at(n, v[seg.index], seg);
    } else if (isPlainObject(v) && hasOwn(v, seg.key)) {
      at(n, v[seg.key], seg);
    }
  }
  return next;
}

function pathOf(n: Node): string {
  const segs: PathSegment[] = [];
  for (let x: Node | undefined = n; x?.seg; x = x.parent) segs.push(x.seg);
  return formatPath(segs.reverse());
}

/**
 * Every value the path selects, with its concrete path (wildcards expanded). Values are not copied.
 * Throws when the path selects more than `limit` values (default SELECT_LIMIT) or any step of the walk
 * reaches more than WALK_LIMIT places — narrow the path then.
 */
export function selectPath(root: unknown, path: string, opts?: { limit?: number }): { path: string; value: unknown }[] {
  const limit = opts?.limit ?? SELECT_LIMIT;
  let nodes: Node[] = [{ value: root }];
  for (const seg of parsePath(path)) nodes = step(nodes, seg, true, path);
  if (nodes.length > limit) throw new Error(`JSON path ${path} selects ${nodes.length} values, more than the limit of ${limit}`);
  return nodes.map((n) => ({ path: pathOf(n), value: n.value }));
}

function validateOp(op: Op, i: number): void {
  if (!op || typeof op !== 'object') throw new Error(`applyOps: op ${i} is not an object`);
  if (typeof op.path !== 'string') throw new Error(`applyOps: op ${i} has no path`);
  if (op.op !== 'null' && op.op !== 'delete' && op.op !== 'set') {
    throw new Error(`applyOps: op ${i} (${op.path}) has an unknown kind ${JSON.stringify(op.op)}; expected "null", "delete" or "set"`);
  }
  if (op.valueJson !== undefined && typeof op.valueJson !== 'string') throw new Error(`applyOps: op ${i} (${op.path}) has a valueJson that is not a string`);
  if (op.op === 'set' && op.value === undefined && op.valueJson === undefined) throw new Error(`applyOps: op ${i} (set ${op.path}) needs a value`);
}

/** The value a `set` op writes: `valueJson` (parsed) wins over `value`. */
function setValue(op: Op, i: number): unknown {
  if (op.op !== 'set' || op.valueJson === undefined) return op.value;
  try {
    return JSON.parse(op.valueJson);
  } catch (e) {
    throw new Error(`applyOps: op ${i} (set ${op.path}) has invalid valueJson: ${(e as Error).message}`);
  }
}

/** Bounds for applyOps (REVIEW-4 #4). */
export interface ApplyOptions {
  /** Places all ops together may change. Default 1 000 000. */
  maxTargets?: number;
  /** Σ places × JSON size of the written value (≈ bytes added). Default 64 MB. */
  maxWork?: number;
  /** Change `root` itself instead of a deep copy (for callers that own a freshly parsed value). */
  inPlace?: boolean;
}

const DEFAULT_MAX_TARGETS = 1_000_000;
const DEFAULT_MAX_WORK = 64 * 1024 * 1024;

function jsonSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 4;
  } catch {
    return 4;
  }
}

/**
 * Applies ops in order to a deep copy of `root`; returns the new value and how many places each op
 * changed (0 = path matched nothing — not an error). Never mutates `root`.
 *
 * `null` / `delete` change existing keys / elements only; `set` also creates a missing last key on an
 * object (never array elements). `delete` removes object keys and array elements (later elements shift;
 * several elements of one array are removed from the end so indexes stay valid). `$` itself can be `set`
 * or `null`ed, not deleted. Throws on a bad path or op (the input is still untouched).
 *
 * `valueJson` (CONTRACTS §10.2) wins over `value` for `set`; here it is read with JSON.parse, so number
 * literals become JS numbers (`1.0` → 1). The proxy's mutate rule parses it itself to keep it byte-exact.
 *
 * Bounded (REVIEW-4 #4, `opts`): throws before writing anything an op would push past `maxTargets` places
 * or `maxWork` (places × JSON size of the value). Earlier ops are already applied to the copy then; with
 * `inPlace` the caller must discard `root` after an error.
 */
export function applyOps(
  root: unknown,
  ops: { path: string; op: 'null' | 'delete' | 'set'; value?: unknown; valueJson?: string }[],
  opts: ApplyOptions = {},
): { value: unknown; changed: number[] } {
  if (!Array.isArray(ops)) throw new Error('applyOps: ops must be an array');
  const parsed = ops.map((op, i) => {
    validateOp(op, i);
    return parsePath(op.path);
  });
  const values = ops.map((op, i) => setValue(op, i));
  const sizes = ops.map((op, i) => (op.op === 'delete' ? 1 : op.op === 'null' ? 4 : op.valueJson !== undefined ? op.valueJson.length : jsonSize(values[i])));
  const maxTargets = opts.maxTargets ?? DEFAULT_MAX_TARGETS;
  const maxWork = opts.maxWork ?? DEFAULT_MAX_WORK;
  let targets = 0;
  let work = 0;
  const budget = (i: number, count: number) => {
    targets += count;
    work += count * sizes[i];
    if (targets > maxTargets) throw new Error(`applyOps: op ${i} (${ops[i].path}) would change more than ${maxTargets} places in total`);
    if (work > maxWork) {
      throw new Error(`applyOps: op ${i} (${ops[i].path}) is too large: ${count} places × ${sizes[i]} bytes would exceed ${Math.round(maxWork / 1024 / 1024)} MB`);
    }
  };
  let value = opts.inPlace ? root : deepCopy(root);
  const changed: number[] = [];
  ops.forEach((op, i) => {
    const segs = parsed[i];
    const replacement = () => (op.op === 'null' ? null : deepCopy(values[i]));
    if (segs.length === 0) {
      if (op.op === 'delete') throw new Error(`applyOps: op ${i} cannot delete the root ($)`);
      budget(i, 1);
      value = replacement();
      changed.push(1);
      return;
    }
    let parents: Node[] = [{ value }];
    for (const seg of segs.slice(0, -1)) parents = step(parents, seg, false, op.path);
    const last = segs[segs.length - 1];
    // Targets: (container, key or index), all collected before anything changes.
    const objTargets: [Record<string, unknown>, string][] = [];
    const arrTargets = new Map<unknown[], number[]>();
    const wholeArrays: unknown[][] = []; // `[*]` last: every element
    const addIndex = (a: unknown[], idx: number) => {
      const list = arrTargets.get(a);
      if (list) list.push(idx);
      else arrTargets.set(a, [idx]);
    };
    for (const { value: p } of parents) {
      if ('wildcard' in last) {
        if (Array.isArray(p)) wholeArrays.push(p);
        else if (isPlainObject(p)) for (const k of Object.keys(p)) objTargets.push([p, k]);
      } else if ('index' in last) {
        if (Array.isArray(p) && last.index < p.length) addIndex(p, last.index);
      } else if (isPlainObject(p) && (hasOwn(p, last.key) || op.op === 'set')) {
        objTargets.push([p, last.key]);
      }
    }
    let count = objTargets.length;
    for (const idx of arrTargets.values()) count += idx.length;
    for (const a of wholeArrays) count += a.length;
    budget(i, count);
    if (op.op === 'delete') {
      for (const [o, k] of objTargets) delete o[k];
      for (const [a, idx] of arrTargets) {
        for (const n of [...new Set(idx)].sort((x, y) => y - x)) a.splice(n, 1);
      }
      for (const a of wholeArrays) a.length = 0;
    } else {
      for (const [o, k] of objTargets) setKey(o, k, replacement());
      for (const [a, idx] of arrTargets) for (const n of idx) a[n] = replacement();
      for (const a of wholeArrays) for (let n = 0; n < a.length; n++) a[n] = replacement();
    }
    changed.push(count);
  });
  return { value, changed };
}
