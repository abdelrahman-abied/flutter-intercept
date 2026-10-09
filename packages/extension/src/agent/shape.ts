/**
 * `get_body_shape` (CONTRACTS §9.5): the structure of a JSON body without its values, small enough for an
 * agent's context even for a 1 MB response (target ≤ ~4k characters ≈ 1k tokens).
 *
 * Notation (also in the tool description):
 * - primitives: "string" | "integer" | "number" | "boolean" | "null"; unions joined with "|" ("string|null");
 * - object: { key: shape }, "key?" = missing in some of the merged objects;
 * - array: { "[]": <every element merged into one shape>, "length": n } ("length": "min-max" when several
 *   arrays were merged; "[]": "empty" when they were all empty);
 * - a union that mixes objects/arrays with other types: { "|": [ ... ] };
 * - "{…}" / "[…]" = nested deeper than maxDepth; "…": "+N more keys" = key cap.
 * No values ever appear, only key names and types.
 */

type Prim = 'string' | 'integer' | 'number' | 'boolean' | 'null';

interface ObjT {
  n: number; // objects merged
  keys: Map<string, { t: T; seen: number }>;
}
interface ArrT {
  min: number;
  max: number;
  item?: T;
}
/** A merged type: every kind of value seen at one position. */
interface T {
  prims: Set<Prim>;
  obj?: ObjT;
  arr?: ArrT;
  /** Objects / arrays seen below the depth cap (structure not recorded). */
  deepObj?: boolean;
  deepArr?: boolean;
}

const newT = (): T => ({ prims: new Set() });

function observe(t: T, v: unknown, depth: number, maxDepth: number): void {
  if (v === null) t.prims.add('null');
  else if (typeof v === 'string') t.prims.add('string');
  else if (typeof v === 'number') t.prims.add(Number.isInteger(v) ? 'integer' : 'number');
  else if (typeof v === 'boolean') t.prims.add('boolean');
  else if (Array.isArray(v)) {
    if (depth >= maxDepth) {
      t.deepArr = true;
      return;
    }
    const a = (t.arr ??= { min: v.length, max: v.length });
    a.min = Math.min(a.min, v.length);
    a.max = Math.max(a.max, v.length);
    for (const x of v) observe((a.item ??= newT()), x, depth + 1, maxDepth);
  } else if (typeof v === 'object') {
    if (depth >= maxDepth) {
      t.deepObj = true;
      return;
    }
    const o = (t.obj ??= { n: 0, keys: new Map() });
    o.n++;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      let slot = o.keys.get(k);
      if (!slot) o.keys.set(k, (slot = { t: newT(), seen: 0 }));
      slot.seen++;
      observe(slot.t, x, depth + 1, maxDepth);
    }
  }
}

export type Shape = string | number | { [key: string]: Shape } | Shape[];

interface RenderOpts {
  maxKeys: number;
  /** Structure deeper than this renders as "{…}" / "[…]". */
  maxDepth: number;
  /** Set when a cap removed information. */
  capped: { hit: boolean };
}

const PRIM_ORDER: Prim[] = ['string', 'integer', 'number', 'boolean', 'null'];

function render(t: T, o: RenderOpts, depth: number): Shape {
  const prims = PRIM_ORDER.filter((p) => t.prims.has(p) && !(p === 'integer' && t.prims.has('number')));
  const parts: Shape[] = [];
  const deep = depth >= o.maxDepth;
  if (t.obj && !deep) parts.push(renderObj(t.obj, o, depth));
  else if (t.obj || t.deepObj) parts.push('{…}');
  if (t.arr && !deep) parts.push(renderArr(t.arr, o, depth));
  else if (t.arr || t.deepArr) parts.push('[…]');
  if (deep ? t.obj || t.arr || t.deepObj || t.deepArr : t.deepObj || t.deepArr) o.capped.hit = true;
  const primText = prims.join('|');
  if (!parts.length) return primText || 'unknown';
  if (parts.length === 1 && !primText) return parts[0];
  if (parts.every((p) => typeof p === 'string')) return [primText, ...(parts as string[])].filter(Boolean).join('|');
  return { '|': [...(primText ? [primText] : []), ...parts] };
}

function renderObj(obj: ObjT, o: RenderOpts, depth: number): Shape {
  const out: Record<string, Shape> = {};
  let shown = 0;
  for (const [k, slot] of obj.keys) {
    if (shown >= o.maxKeys) {
      out['…'] = `+${obj.keys.size - shown} more keys`;
      o.capped.hit = true;
      break;
    }
    out[slot.seen < obj.n ? `${k}?` : k] = render(slot.t, o, depth + 1);
    shown++;
  }
  return out;
}

function renderArr(a: ArrT, o: RenderOpts, depth: number): Shape {
  return { '[]': a.item ? render(a.item, o, depth + 1) : 'empty', length: a.min === a.max ? a.max : `${a.min}-${a.max}` };
}

export interface ShapeOptions {
  maxDepth?: number; // default 6
  /** Budget for the rendered shape in JSON characters (default 4000). */
  maxChars?: number;
}

export interface ShapeResult {
  shape: Shape;
  /** Depth or key caps (or the size budget) removed detail. */
  truncated: boolean;
  /** The depth actually rendered (lower than asked when the budget forced it). */
  depth: number;
}

/**
 * Shape of an already-parsed JSON value. Stays within `maxChars` by lowering the key cap, then the depth;
 * at depth 0 the shape is a single word, so it always terminates.
 */
export function shapeOf(value: unknown, opts: ShapeOptions = {}): ShapeResult {
  const maxChars = opts.maxChars ?? 4000;
  const asked = Math.max(0, opts.maxDepth ?? 6);
  // Observe once (structure below `asked` is only flagged); caps are applied while rendering.
  const t = newT();
  observe(t, value, 0, asked);
  for (let depth = asked; ; depth--) {
    for (const maxKeys of [60, 30, 15, 8]) {
      const capped = { hit: false };
      const shape = render(t, { maxKeys, maxDepth: depth, capped }, 0);
      if (JSON.stringify(shape).length <= maxChars || depth === 0) return { shape, truncated: capped.hit, depth };
    }
  }
}

export interface BodyShapeResult {
  shape: Shape | null;
  truncated?: boolean;
  reason?: string;
}

/** Parses a body text as JSON and returns its shape, or `{shape: null, reason}`. */
export function bodyShape(text: string, opts: ShapeOptions & { bodyTruncated?: boolean } = {}): BodyShapeResult {
  if (!text.trim()) return { shape: null, reason: 'the body is empty' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      shape: null,
      reason: opts.bodyTruncated ? 'the body was truncated when recorded (larger than 5 MB), so it is not complete JSON' : 'the body is not JSON',
    };
  }
  const r = shapeOf(value, opts);
  return { shape: r.shape, ...(r.truncated ? { truncated: true } : {}) };
}
