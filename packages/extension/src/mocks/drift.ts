/**
 * Drift: is the collection still true to the server? (CONTRACTS §23.3). Pure: no vscode, no fs.
 *
 * The host feeds `DriftTracker.observe` with qualifying answers (§23.3 "Qualify": a JSON answer ≤ 1 MB on one of the
 * collection's origins, matched to an endpoint) and the example the collection has for that status. The tracker keeps,
 * per (link, endpoint, status), the shapes of the last 5 answers (never bodies) and reports, from the last 3:
 * - `added`    a field in all 3 answers (in every object at that place), not in the example — the example must know the
 *              object it would be in (an empty array, a null or another type there says nothing);
 * - `removed`  a field the example always has, in none of the 3 (the parent object present each time); never for
 *              `generated` examples;
 * - `type`     another single non-null kind in all 3 (`int` → `double` counts, `double` → `int` is ignored: writers drop
 *              `.0`); mixed kinds say nothing;
 * - `nullable` null in ≥ 2 of the 3 where the example has a value and is never null;
 * - `status`   3 answers with a status the endpoint has no example for (5xx excluded: a failing server is not a new
 *              contract).
 * Never: optional fields (missing in some objects of one answer, or missing from some answers), map-like objects
 * (id-like keys: `{"17": …}` — skipped with everything under them), empty arrays, values. Depth ≤ 8, ≤ 20 changes per
 * endpoint, ≤ 500 windows per link (least recently used dropped). A finding clears when newer answers disagree.
 *
 * Shapes come from a single-pass scanner over the JSON text (no object tree), so `1.0` stays a double and a 100 KB
 * body costs well under the 2 ms budget.
 */
import { createHash } from 'crypto';

export interface DriftChange {
  kind: 'added' | 'removed' | 'type' | 'nullable' | 'status';
  /** `user.avatar`, `items[].price`; `""` = the whole body (and for `status`). Keys with `.`, `[`, `]` or `\` are
   *  backslash-escaped (`parseDriftPath`). */
  path: string;
  from?: string;
  to?: string;
}

export interface DriftView {
  endpoint: string;
  status: number;
  /** Answers observed for this endpoint and status. */
  samples: number;
  changes: DriftChange[];
  /** Epoch ms when this set of changes was first seen. */
  since: number;
}

export interface DriftSample {
  linkId: string;
  /** The endpoint key (`GET {{baseUrl}}/users/:id`). */
  endpoint: string;
  status: number;
  /** The server's answer (JSON text). */
  body: string;
}

export interface DriftExample {
  status: number;
  body: string;
  generated?: boolean;
}

export const DRIFT_LIMITS = {
  window: 5,
  needed: 3,
  depth: 8,
  changesPerEndpoint: 20,
  windowsPerLink: 500,
  pathsPerShape: 2000,
  exampleCache: 256,
} as const;

// ------------------------------------------------------------------ shapes

const K_BOOL = 1;
const K_INT = 2;
const K_DOUBLE = 4;
const K_STRING = 8;
const K_LIST = 16;
const K_OBJECT = 32;

interface Node {
  /** Parent path (`undefined` for the root). */
  parent: string | undefined;
  /** Bitmask of non-null kinds seen. */
  kinds: number;
  /** Null seen. */
  nul: boolean;
  /** Objects seen at this place. */
  objs: number;
  /** In how many parent objects the key was present (fields only). */
  present: number;
}

interface Shape {
  nodes: Map<string, Node>;
  /** Paths were left out (over `pathsPerShape`): additions / removals can't be judged. */
  partial: boolean;
}

const ID_KEY = /^(?:-?\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,})$/i;
const ESCAPE = /[.[\]\\]/;

function escapeKey(k: string): string {
  return ESCAPE.test(k) ? k.replace(/[.[\]\\]/g, (c) => `\\${c}`) : k;
}

/** A path as segments: keys, and `[]` for "every element". `parseDriftPath('items[].a\\.b')` → `['items', [], 'a.b']`. */
export type DriftPathSegment = string | [];

export function parseDriftPath(path: string): DriftPathSegment[] {
  const out: DriftPathSegment[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '\\' && i + 1 < path.length) {
      cur += path[++i];
      has = true;
    } else if (c === '.') {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '[' && path[i + 1] === ']') {
      if (has) out.push(cur);
      cur = '';
      has = false;
      out.push([]);
      i++;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function formatDriftPath(segs: readonly DriftPathSegment[]): string {
  let out = '';
  for (const s of segs) {
    if (Array.isArray(s)) out += '[]';
    else out += out ? `.${escapeKey(s)}` : escapeKey(s);
  }
  return out;
}

class ShapeError extends Error {}

/** One answer's shape, or undefined when the text isn't JSON. */
export function shapeOf(text: string): Shape | undefined {
  try {
    return scan(text);
  } catch (e) {
    if (e instanceof ShapeError || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

function scan(t: string): Shape {
  const n = t.length;
  let i = 0;
  const nodes = new Map<string, Node>();
  let partial = false;
  const fail = (): never => {
    throw new ShapeError('not JSON');
  };
  const ws = (): void => {
    while (i < n) {
      const c = t.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else break;
    }
  };
  /** Skips a string at i (a '"'); returns its decoded text when `decode`. */
  const str = (decode: boolean): string => {
    const s = i;
    let j = i + 1;
    for (;;) {
      const q = t.indexOf('"', j);
      if (q < 0) fail();
      let b = q - 1;
      while (b > s && t.charCodeAt(b) === 92) b--;
      const bs = q - 1 - b;
      j = q + 1;
      if (bs % 2 === 0) break;
    }
    i = j;
    if (!decode) return '';
    const raw = t.slice(s, i);
    return raw.includes('\\') ? (JSON.parse(raw) as string) : raw.slice(1, -1);
  };
  const node = (path: string, parent: string | undefined): Node | undefined => {
    let nd = nodes.get(path);
    if (!nd) {
      if (nodes.size >= DRIFT_LIMITS.pathsPerShape) {
        partial = true;
        return undefined;
      }
      nd = { parent, kinds: 0, nul: false, objs: 0, present: 0 };
      nodes.set(path, nd);
    }
    return nd;
  };
  /** One value at i. `path` undefined = not recorded (too deep, under a map, over the cap). */
  const value = (path: string | undefined, nd: Node | undefined, depth: number): void => {
    if (depth > 512) fail();
    const c = t.charCodeAt(i);
    if (c === 123 /* { */) {
      if (nd) {
        nd.kinds |= K_OBJECT;
        nd.objs++;
      }
      i++;
      ws();
      if (t.charCodeAt(i) === 125) {
        i++;
        return;
      }
      for (;;) {
        if (t.charCodeAt(i) !== 34) fail();
        const record = path !== undefined && depth < DRIFT_LIMITS.depth;
        const key = str(record);
        ws();
        if (t.charCodeAt(i) !== 58) fail();
        i++;
        ws();
        let childPath: string | undefined;
        let child: Node | undefined;
        if (record && !ID_KEY.test(key)) {
          childPath = path === '' ? escapeKey(key) : `${path}.${escapeKey(key)}`;
          child = node(childPath, path);
          if (child) child.present++;
          else childPath = undefined;
        }
        value(childPath, child, depth + 1);
        ws();
        const d = t.charCodeAt(i);
        i++;
        if (d === 44) {
          ws();
          continue;
        }
        if (d === 125) return;
        fail();
      }
    }
    if (c === 91 /* [ */) {
      if (nd) nd.kinds |= K_LIST;
      i++;
      ws();
      if (t.charCodeAt(i) === 93) {
        i++;
        return;
      }
      let elPath: string | undefined;
      let el: Node | undefined;
      if (path !== undefined && depth < DRIFT_LIMITS.depth) {
        elPath = `${path}[]`;
        el = node(elPath, path);
        if (!el) elPath = undefined;
      }
      for (;;) {
        ws();
        value(elPath, el, depth + 1);
        ws();
        const d = t.charCodeAt(i);
        i++;
        if (d === 44) continue;
        if (d === 93) return;
        fail();
      }
    }
    if (c === 34) {
      str(false);
      if (nd) nd.kinds |= K_STRING;
      return;
    }
    if (c === 116 /* t */ || c === 102 /* f */) {
      const lit = c === 116 ? 'true' : 'false';
      if (!t.startsWith(lit, i)) fail();
      i += lit.length;
      if (nd) nd.kinds |= K_BOOL;
      return;
    }
    if (c === 110 /* n */) {
      if (!t.startsWith('null', i)) fail();
      i += 4;
      if (nd) nd.nul = true;
      return;
    }
    // number
    const s = i;
    let dbl = false;
    if (t.charCodeAt(i) === 45) i++;
    const digits = i;
    while (i < n) {
      const d = t.charCodeAt(i);
      if (d >= 48 && d <= 57) i++;
      else if (d === 46 || d === 101 || d === 69 || d === 43 || d === 45) {
        dbl = true;
        i++;
      } else break;
    }
    if (i === digits) fail();
    if (!dbl && i - digits > 18 && Math.abs(Number(t.slice(s, i))) >= 2 ** 63) dbl = true;
    if (nd) nd.kinds |= dbl ? K_DOUBLE : K_INT;
  };
  ws();
  const root = node('', undefined)!;
  value('', root, 0);
  ws();
  if (i !== n) fail();
  return { nodes, partial };
}

/** int + double → double (as Dart's inference does). */
function norm(kinds: number): number {
  return kinds & K_DOUBLE ? kinds & ~K_INT : kinds;
}

function single(kinds: number): number | undefined {
  const k = norm(kinds);
  return k !== 0 && (k & (k - 1)) === 0 ? k : undefined;
}

function kindName(k: number): string {
  switch (k) {
    case K_BOOL:
      return 'bool';
    case K_INT:
      return 'int';
    case K_DOUBLE:
      return 'double';
    case K_STRING:
      return 'string';
    case K_LIST:
      return 'list';
    case K_OBJECT:
      return 'object';
    default:
      return 'mixed';
  }
}

function kindOf(nd: Node): string {
  const k = single(nd.kinds);
  return k ? kindName(k) : 'mixed';
}

/** Present in every object at its parent (not optional within this answer). */
function always(sh: Shape, path: string, nd: Node): boolean {
  const p = nd.parent === undefined ? undefined : sh.nodes.get(nd.parent);
  return !!p && p.objs > 0 && nd.present >= p.objs;
}

/** The parent of `path` is a known object in this shape. */
function parentKnown(sh: Shape, parent: string | undefined): boolean {
  if (parent === undefined) return false;
  const p = sh.nodes.get(parent);
  return !!p && p.objs > 0;
}

const KIND_ORDER: DriftChange['kind'][] = ['removed', 'added', 'type', 'nullable', 'status'];

/** The §23.3 rules between an example shape and the last answers (exactly `needed` of them). */
export function compareDrift(example: Shape, samples: readonly Shape[], generated: boolean): DriftChange[] {
  const out: DriftChange[] = [];
  if (samples.length < DRIFT_LIMITS.needed) return out;
  const last = samples.slice(-DRIFT_LIMITS.needed);
  const judgeSets = !example.partial && last.every((s) => !s.partial);

  if (judgeSets) {
    // added: in all answers, always present, unknown to the example (whose parent object it knows)
    const first = last[0];
    for (const [path, nd] of first.nodes) {
      if (nd.parent === undefined || example.nodes.has(path) || !parentKnown(example, nd.parent)) continue;
      if (!last.every((s) => {
        const x = s.nodes.get(path);
        return !!x && always(s, path, x);
      })) continue;
      const kinds = last.reduce((k, s) => k | s.nodes.get(path)!.kinds, 0);
      const k = single(kinds);
      out.push({ kind: 'added', path, ...(k ? { to: kindName(k) } : {}) });
    }
    // removed: the example always has it, no answer does (the parent object present in each)
    if (!generated) {
      for (const [path, nd] of example.nodes) {
        if (nd.parent === undefined || !always(example, path, nd)) continue;
        if (!last.every((s) => parentKnown(s, nd.parent) && !s.nodes.has(path))) continue;
        // only the topmost removal (the parent is still there, so this is it)
        out.push({ kind: 'removed', path, from: kindOf(nd) });
      }
    }
  }

  for (const [path, nd] of example.nodes) {
    const ek = single(nd.kinds);
    if (!ek) continue;
    const xs = last.map((s) => s.nodes.get(path));
    if (xs.some((x) => !x)) continue;
    // type: one other non-null kind in all answers
    const sk = xs.map((x) => single(x!.kinds));
    if (sk.every((k) => k !== undefined && k === sk[0]) && sk[0] !== ek && !(ek === K_DOUBLE && sk[0] === K_INT)) {
      out.push({ kind: 'type', path, from: kindName(ek), to: kindName(sk[0]!) });
      continue;
    }
    // nullable: null in ≥ 2 where the example has a value and is never null
    if (!nd.nul && xs.filter((x) => x!.nul).length >= 2) out.push({ kind: 'nullable', path, from: kindName(ek), to: 'null' });
  }

  // children of a field whose type changed say nothing more
  const typed = out.filter((c) => c.kind === 'type').map((c) => c.path);
  const kept = out.filter((c) => c.kind === 'type' || !typed.some((p) => isUnder(c.path, p)));
  kept.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return kept.slice(0, DRIFT_LIMITS.changesPerEndpoint);
}

function isUnder(path: string, parent: string): boolean {
  if (parent === '') return path !== '';
  return path.length > parent.length && path.startsWith(parent) && (path[parent.length] === '.' || path[parent.length] === '[');
}

// ------------------------------------------------------------------ tracker

interface Window {
  endpoint: string;
  status: number;
  shapes: Shape[];
  samples: number;
  /** Answers in a row with no example for this status. */
  noExample: number;
  changes: DriftChange[];
  fingerprint?: string;
  since: number;
}

/** A stable id of one endpoint's set of changes: Ignore hides it until the set differs (§23.3). */
export function driftFingerprint(endpoint: string, status: number, changes: readonly DriftChange[]): string {
  const lines = changes.map((c) => `${c.kind}\u0000${c.path}\u0000${c.from ?? ''}\u0000${c.to ?? ''}`).sort();
  return createHash('sha256').update(`${endpoint}\u0001${status}\u0001${lines.join('\u0001')}`).digest('hex').slice(0, 24);
}

export interface DriftTrackerOptions {
  now?: () => number;
  /** Fingerprints ignored earlier (workspaceState). */
  ignored?: Iterable<string>;
}

export class DriftTracker {
  private readonly links = new Map<string, Map<string, Window>>();
  private readonly examples = new Map<string, Shape | null>();
  private readonly ignored: Set<string>;
  private readonly now: () => number;

  constructor(o: DriftTrackerOptions = {}) {
    this.now = o.now ?? Date.now;
    this.ignored = new Set(o.ignored ?? []);
  }

  /**
   * One qualifying answer. `example` = the example the endpoint has for `sample.status` (query-matching first, else
   * the default); undefined when it has none (counts towards a `status` finding).
   */
  observe(sample: DriftSample, example: DriftExample | undefined): void {
    if (!sample || typeof sample.body !== 'string' || !Number.isInteger(sample.status)) return;
    const w = this.window(sample.linkId, sample.endpoint, sample.status);
    w.samples++;
    if (!example) {
      if (sample.status >= 500) return;
      w.noExample++;
      w.shapes = [];
      this.setChanges(w, w.noExample >= DRIFT_LIMITS.needed ? [{ kind: 'status', path: '', to: String(sample.status) }] : []);
      return;
    }
    w.noExample = 0;
    const shape = shapeOf(sample.body);
    if (!shape) return;
    w.shapes.push(shape);
    if (w.shapes.length > DRIFT_LIMITS.window) w.shapes.shift();
    const ex = this.exampleShape(example.body);
    this.setChanges(w, ex ? compareDrift(ex, w.shapes, example.generated === true) : []);
  }

  /** Current findings of a link (ignored ones left out), by endpoint then status. */
  findings(linkId: string): DriftView[] {
    const m = this.links.get(linkId);
    if (!m) return [];
    const out: DriftView[] = [];
    for (const w of m.values()) {
      if (!w.changes.length || (w.fingerprint && this.ignored.has(w.fingerprint))) continue;
      out.push({ endpoint: w.endpoint, status: w.status, samples: w.samples, changes: w.changes.map((c) => ({ ...c })), since: w.since });
    }
    return out.sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : a.status - b.status));
  }

  /** The fingerprint of the current finding of one endpoint and status, if any. */
  fingerprint(linkId: string, endpoint: string, status: number): string | undefined {
    const w = this.links.get(linkId)?.get(`${endpoint}\u0000${status}`);
    return w?.changes.length ? w.fingerprint : undefined;
  }

  /** Hides a finding until its set of changes differs. */
  ignore(fingerprint: string): void {
    this.ignored.add(fingerprint);
  }

  isIgnored(fingerprint: string): boolean {
    return this.ignored.has(fingerprint);
  }

  /** Drops what was observed for a link (removed, re-linked, or the collection file changed), or one endpoint of it. */
  forget(linkId: string, endpoint?: string): void {
    if (endpoint === undefined) {
      this.links.delete(linkId);
      return;
    }
    const m = this.links.get(linkId);
    if (!m) return;
    for (const [k, w] of m) if (w.endpoint === endpoint) m.delete(k);
  }

  /** Windows kept for a link (tests, diagnostics). */
  windows(linkId: string): number {
    return this.links.get(linkId)?.size ?? 0;
  }

  private window(linkId: string, endpoint: string, status: number): Window {
    let m = this.links.get(linkId);
    if (!m) this.links.set(linkId, (m = new Map()));
    const key = `${endpoint}\u0000${status}`;
    let w = m.get(key);
    if (w) {
      m.delete(key); // most recently used last
      m.set(key, w);
      return w;
    }
    w = { endpoint, status, shapes: [], samples: 0, noExample: 0, changes: [], since: 0 };
    m.set(key, w);
    while (m.size > DRIFT_LIMITS.windowsPerLink) m.delete(m.keys().next().value!);
    return w;
  }

  private exampleShape(body: string): Shape | undefined {
    const hit = this.examples.get(body);
    if (hit !== undefined) {
      this.examples.delete(body);
      this.examples.set(body, hit);
      return hit ?? undefined;
    }
    const sh = shapeOf(body) ?? null;
    this.examples.set(body, sh);
    while (this.examples.size > DRIFT_LIMITS.exampleCache) this.examples.delete(this.examples.keys().next().value!);
    return sh ?? undefined;
  }

  private setChanges(w: Window, changes: DriftChange[]): void {
    if (!changes.length) {
      w.changes = [];
      w.fingerprint = undefined;
      return;
    }
    const fp = driftFingerprint(w.endpoint, w.status, changes);
    if (fp !== w.fingerprint) w.since = this.now();
    w.changes = changes;
    w.fingerprint = fp;
  }
}

// ------------------------------------------------------------------ lines

/** `GET {{baseUrl}}/users/:id` → `GET /users/:id`. */
export function endpointLabel(endpoint: string): string {
  const m = /^(\S+)\s+(?:\{\{[^}\s]+\}\}|[a-z][a-z0-9+.-]*:\/\/[^/\s]*)?(\S*)(.*)$/i.exec(endpoint);
  if (!m) return endpoint;
  return `${m[1]} ${m[2] || '/'}${m[3]}`;
}

function changeText(ep: string, c: DriftChange): string {
  const what = c.path || 'the body';
  switch (c.kind) {
    case 'added':
      return `${ep} now has ${what}`;
    case 'removed':
      return `${ep} no longer has ${what}`;
    case 'type':
      return `${ep} now sends ${what} as ${c.to ?? 'another type'}`;
    case 'nullable':
      return `${ep} now sends ${what} as null`;
    case 'status':
      return `${ep} now answers ${c.to ?? 'another status'}`;
  }
}

/** "GET /users/:id now has avatar (and 2 more)" — the first change, and how many more across `views`. */
export function driftLine(views: readonly DriftView[]): string {
  const first = views.find((v) => v.changes.length);
  if (!first) return '';
  const total = views.reduce((n, v) => n + v.changes.length, 0);
  const more = total - 1;
  return `${changeText(endpointLabel(first.endpoint), first.changes[0])}${more > 0 ? ` (and ${more} more)` : ''}`;
}

/** `CollectionStatus.drift` (§23.3), or undefined when there is nothing to say. */
export function driftSummary(views: readonly DriftView[]): { endpoints: number; line: string } | undefined {
  const withChanges = views.filter((v) => v.changes.length);
  if (!withChanges.length) return undefined;
  return { endpoints: new Set(withChanges.map((v) => v.endpoint)).size, line: driftLine(withChanges) };
}
