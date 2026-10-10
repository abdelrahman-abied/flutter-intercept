/**
 * Schema inference for model generation (CONTRACTS §10.4). Pure.
 *
 * Every sample is folded into one `Shape`:
 * - a key present in only some of the objects seen at that place → optional (`FieldDef.optional`);
 * - a value seen as `null` → nullable (`FieldDef.nullable`); both become `T?` in Dart;
 * - int + double → double; any other mix → dynamic; `[]` alone → `List<dynamic>` (another sample can fill it);
 * - the elements of an array are merged with each other, so `[{a:1},{a:1,b:2}]` makes `b` optional;
 * - an object whose keys are all ids (`{"17": {...}, "42": {...}}`) is a `Map<String, X>`.
 * Field order is the order keys were first seen. Classes come out root first, then depth-first in field order.
 * Numbers: a `JsonDouble` (see json.ts) is a double; otherwise `Number.isInteger` decides.
 */
import { JsonDouble } from './json';
import { className, isAvoidedClassName, itemClassName, fieldName } from './naming';

export type ShapeKind = 'none' | 'bool' | 'int' | 'double' | 'string' | 'list' | 'object' | 'dynamic';

/** What was seen at one place in the JSON. `none` = no non-null value yet (only null, or items of `[]`). */
export interface Shape {
  kind: ShapeKind;
  nullable: boolean;
  of?: Shape; // list
  fields?: Map<string, FieldShape>; // object
  count?: number; // object: how many objects were merged
}

export interface FieldShape {
  shape: Shape;
  present: number; // in how many of the merged objects the key existed
}

export type DartType =
  | { kind: 'int' | 'double' | 'String' | 'bool'; nullable: boolean }
  | { kind: 'dynamic' }
  | { kind: 'list'; of: DartType; nullable: boolean }
  | { kind: 'map'; of: DartType; nullable: boolean }
  | { kind: 'class'; name: string; nullable: boolean };

export interface FieldDef {
  key: string; // JSON key
  name: string; // Dart field name
  type: DartType; // nullable when optional or nullable
  optional: boolean; // missing from some objects
  nullable: boolean; // null in some objects
}

export interface ClassDef {
  name: string;
  fields: FieldDef[];
}

export interface Schema {
  rootName: string;
  /** What the whole response decodes to: `User`, `List<User>`, `Map<String, User>`. */
  rootType: DartType;
  /** Root class first. */
  classes: ClassDef[];
}

const NONE = (): Shape => ({ kind: 'none', nullable: false });

export function observe(value: unknown): Shape {
  if (value === null || value === undefined) return { kind: 'none', nullable: true };
  if (value instanceof JsonDouble) return { kind: 'double', nullable: false };
  switch (typeof value) {
    case 'boolean':
      return { kind: 'bool', nullable: false };
    case 'number':
      return { kind: Number.isInteger(value) ? 'int' : 'double', nullable: false };
    case 'bigint':
      return { kind: 'int', nullable: false };
    case 'string':
      return { kind: 'string', nullable: false };
  }
  if (Array.isArray(value)) {
    let of = NONE();
    for (const item of value) of = mergeShapes(of, observe(item));
    return { kind: 'list', nullable: false, of };
  }
  if (typeof value === 'object') {
    const fields = new Map<string, FieldShape>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields.set(k, { shape: observe(v), present: 1 });
    return { kind: 'object', nullable: false, fields, count: 1 };
  }
  return { kind: 'dynamic', nullable: true };
}

export function mergeShapes(a: Shape, b: Shape): Shape {
  const nullable = a.nullable || b.nullable;
  if (a.kind === 'none') return { ...b, nullable };
  if (b.kind === 'none') return { ...a, nullable };
  if (a.kind === b.kind) {
    if (a.kind === 'list') return { kind: 'list', nullable, of: mergeShapes(a.of!, b.of!) };
    if (a.kind === 'object') {
      const fields = new Map<string, FieldShape>();
      for (const [k, f] of a.fields!) {
        const g = b.fields!.get(k);
        fields.set(k, g ? { shape: mergeShapes(f.shape, g.shape), present: f.present + g.present } : f);
      }
      for (const [k, g] of b.fields!) if (!fields.has(k)) fields.set(k, g);
      return { kind: 'object', nullable, fields, count: a.count! + b.count! };
    }
    return { kind: a.kind, nullable };
  }
  if ((a.kind === 'int' && b.kind === 'double') || (a.kind === 'double' && b.kind === 'int')) return { kind: 'double', nullable };
  return { kind: 'dynamic', nullable };
}

/** All samples folded into one shape. */
export function inferShape(samples: readonly unknown[]): Shape {
  let shape = NONE();
  for (const s of samples) shape = mergeShapes(shape, observe(s));
  return shape;
}

const ID_KEY = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,})$/i;

/** An object keyed by ids rather than field names. */
function isMapLike(shape: Shape): boolean {
  return shape.kind === 'object' && shape.fields!.size > 0 && [...shape.fields!.keys()].every((k) => ID_KEY.test(k));
}

function mapValueShape(shape: Shape): Shape {
  let of = NONE();
  for (const f of shape.fields!.values()) of = mergeShapes(of, f.shape);
  return of;
}

/** A structural key for a shape, so identical nested objects under the same name share one class. */
function signature(s: Shape): string {
  const n = s.nullable ? '?' : '';
  switch (s.kind) {
    case 'list':
      return `[${signature(s.of!)}]${n}`;
    case 'object': {
      const parts = [...s.fields!.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, f]) => `${JSON.stringify(k)}${f.present < s.count! ? '~' : ''}:${signature(f.shape)}`);
      return `{${parts.join(',')}}${n}`;
    }
    default:
      return s.kind + n;
  }
}

class SchemaBuilder {
  readonly classes: ClassDef[] = [];
  private readonly used = new Set<string>();
  private readonly bySignature = new Map<string, string>();

  reserve(name: string): void {
    this.used.add(name);
  }

  /** Picks a free class name: the hint, else Parent+Hint, else Parent+Hint+2, 3 … */
  private pickName(hint: string, parent: string | undefined): string {
    const base = hint || 'Item';
    if (!isAvoidedClassName(base) && !this.used.has(base)) return base;
    const prefixed = parent ? parent + base : base + 'Model';
    if (!isAvoidedClassName(prefixed) && !this.used.has(prefixed)) return prefixed;
    for (let i = 2; ; i++) if (!this.used.has(prefixed + i)) return prefixed + i;
  }

  /** Builds (or reuses) the class for an object shape and returns its name. */
  classFor(shape: Shape, hint: string, parent: string | undefined, fixedName?: string): string {
    const sigKey = `${hint}|${signature({ ...shape, nullable: false })}`;
    if (!fixedName) {
      const existing = this.bySignature.get(sigKey);
      if (existing) return existing;
    }
    const name = fixedName ?? this.pickName(hint, parent);
    this.used.add(name);
    this.bySignature.set(sigKey, name);
    const def: ClassDef = { name, fields: [] };
    this.classes.push(def);
    // Keys that are already the Dart name (`type`) keep it; renamed ones (`@type`, `user-id`) yield to them.
    const keys = [...shape.fields!.keys()];
    const names = new Map<string, string>();
    const taken = new Set<string>();
    for (const pass of [true, false]) {
      for (const key of keys) {
        const base = fieldName(key);
        if ((base === key) !== pass) continue;
        let fname = base;
        for (let i = 2; taken.has(fname); i++) fname = base + i;
        taken.add(fname);
        names.set(key, fname);
      }
    }
    for (const [key, f] of shape.fields!) {
      const optional = f.present < shape.count!;
      const nullable = f.shape.nullable;
      const type = this.typeFor(f.shape, key, name, optional || nullable);
      def.fields.push({ key, name: names.get(key)!, type, optional, nullable });
    }
    return name;
  }

  /** Dart type for a shape found under JSON key `key` inside class `parent`. */
  typeFor(shape: Shape, key: string, parent: string, nullable: boolean, itemHint?: string): DartType {
    switch (shape.kind) {
      case 'none':
      case 'dynamic':
        return { kind: 'dynamic' };
      case 'bool':
        return { kind: 'bool', nullable };
      case 'int':
        return { kind: 'int', nullable };
      case 'double':
        return { kind: 'double', nullable };
      case 'string':
        return { kind: 'String', nullable };
      case 'list': {
        const hint = itemHint ?? itemClassName(key);
        return { kind: 'list', nullable, of: this.typeFor(shape.of!, key, parent, shape.of!.nullable, hint) };
      }
      case 'object': {
        const hint = itemHint ?? className(key);
        if (isMapLike(shape)) {
          const of = mapValueShape(shape);
          return { kind: 'map', nullable, of: this.typeFor(of, key, parent, of.nullable, itemHint ?? itemClassName(key)) };
        }
        return { kind: 'class', name: this.classFor(shape, hint, parent), nullable };
      }
    }
  }
}

/** A class name for the root, from what the caller asked for. */
export function rootClassName(rootName: string): string {
  const name = className(rootName) || 'Response';
  return isAvoidedClassName(name) ? name + 'Model' : name;
}

/** Infers the classes for one route. Throws when the samples hold no JSON object to model. */
export function inferSchema(samples: readonly unknown[], rootName: string): Schema {
  if (!samples.length) throw new Error('No samples to generate a model from.');
  const shape = inferShape(samples);
  const name = rootClassName(rootName);
  const b = new SchemaBuilder();
  b.reserve(name);
  // Unwrap list / id-map layers around the root object.
  const wrappers: ('list' | 'map')[] = [];
  let inner = shape;
  for (;;) {
    if (inner.kind === 'list') {
      wrappers.push('list');
      inner = inner.of!;
    } else if (isMapLike(inner)) {
      wrappers.push('map');
      inner = mapValueShape(inner);
    } else break;
  }
  if (inner.kind !== 'object') {
    const what = inner.kind === 'none' ? (wrappers.length ? 'only empty lists or nulls' : 'null') : inner.kind === 'dynamic' ? 'values of different types' : `a ${inner.kind}`;
    throw new Error(`The response is not a JSON object (or a list of objects): the samples hold ${what}.`);
  }
  b.classFor(inner, name, undefined, name);
  let rootType: DartType = { kind: 'class', name, nullable: false };
  for (const w of wrappers.reverse()) rootType = { kind: w, of: rootType, nullable: false };
  return { rootName: name, rootType, classes: b.classes };
}

/** `List<Map<String, int?>>` … */
export function dartTypeName(t: DartType): string {
  switch (t.kind) {
    case 'dynamic':
      return 'dynamic';
    case 'list':
      return `List<${dartTypeName(t.of)}>${t.nullable ? '?' : ''}`;
    case 'map':
      return `Map<String, ${dartTypeName(t.of)}>${t.nullable ? '?' : ''}`;
    case 'class':
      return t.name + (t.nullable ? '?' : '');
    default:
      return t.kind + (t.nullable ? '?' : '');
  }
}
