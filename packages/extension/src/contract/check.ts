/**
 * Walks a decoded JSON response with a wire model (CONTRACTS §10.3) and reports what `fromJson` would
 * do with it: `error` = it throws (with the message Dart would print), `warning` = it doesn't throw but
 * silently changes the value (an unknown enum decoded to its fallback, a fraction truncated by
 * `toInt()`). Extra keys are never reported; `unknown` / `dynamic` are skipped. Pure; never throws.
 */
import type { ContractViolation } from './types';
import { describeType, TypeFlags, XField, XType } from './generated';
import { IntegralDouble, JsonValue } from './json';
import type { LinkedModel } from './owner';
import { isSensitiveField } from '../agent/redact';

export const MAX_VIOLATIONS = 50;

export interface ModelLookup {
  get(name: string): LinkedModel | undefined;
}

export interface CheckOptions {
  /** "GET" — for messages. */
  method: string;
  /** "/users/42" — for messages (no origin, no query). */
  urlPath: string;
  maxViolations?: number;
  /** Stop walking after this many JSON values (huge bodies). */
  maxNodes?: number;
}

export interface XViolation extends ContractViolation {
  /** 0-based column of the field declaration (diagnostic range). */
  column?: number;
  /** How many places in this response had the same problem. */
  count?: number;
}

export interface CheckOutcome {
  violations: XViolation[];
  /** Set when the walk stopped early (node budget). */
  partial?: string;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Control, bidi and invisible format characters: never shown raw (Trojan-source style text, REVIEW-4 #6). */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffb]/g;
const escapeUnsafe = (s: string) => s.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** At most `max` UTF-16 units (no split surrogate pair), "…" when cut, unsafe characters escaped. */
export function shortText(s: string, max = 40): string {
  let cut = s;
  if (s.length > max) {
    cut = s.slice(0, max);
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    cut += '…';
  }
  return escapeUnsafe(cut);
}

/** A response string shown in a message: `"…"`, ≤ 40 chars, escaped. */
const quoted = (s: string) => `"${shortText(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`;

/** `.name` for identifier-like keys, `['…']` otherwise (same canonical form as the proxy's jsonpath.ts). */
export function pathKey(base: string, key: string): string {
  return IDENT.test(key) ? `${base}.${key}` : `${base}['${escapeUnsafe(key.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}']`;
}

const isObject = (v: JsonValue | undefined): v is { [k: string]: JsonValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof IntegralDouble);

const isNumber = (v: JsonValue): boolean => typeof v === 'number' || v instanceof IntegralDouble;

/** Dart runtime type of a decoded JSON value. */
function dartRuntimeType(v: JsonValue): string {
  if (v === null) return 'Null';
  if (typeof v === 'string') return 'String';
  if (typeof v === 'boolean') return 'bool';
  if (v instanceof IntegralDouble) return 'double';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (Array.isArray(v)) return 'List<dynamic>';
  return '_Map<String, dynamic>';
}

/**
 * How the value reads in a message: "a string", "a number (1.5)", "an object". Never a string's content;
 * no value at all under a sensitive key (REVIEW-4 #6).
 */
function phrase(v: JsonValue, sensitive = false): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'a string';
  if (typeof v === 'boolean') return sensitive ? 'a bool' : `a bool (${v})`;
  if (v instanceof IntegralDouble) return sensitive ? 'a number' : `a number (${numText(v.value, true)})`;
  if (typeof v === 'number') return sensitive ? 'a number' : `a number (${numText(v, false)})`;
  if (Array.isArray(v)) return 'a list';
  return 'an object';
}

function actualText(v: JsonValue, sensitive = false): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (v instanceof IntegralDouble) return sensitive ? 'number' : `number ${numText(v.value, true)}`;
  if (typeof v === 'number') return sensitive ? 'number' : `number ${numText(v, false)}`;
  if (Array.isArray(v)) return 'list';
  return 'object';
}

function numText(n: number, double: boolean): string {
  const s = String(n);
  return shortText(double && Number.isInteger(n) && !/e/i.test(s) ? `${s}.0` : s);
}

/** The type a cast in the generated code targets (what Dart names in "is not a subtype of type 'X'"). */
function castTarget(t: XType, nullable: boolean): string {
  const q = nullable ? '?' : '';
  const strict = (t as TypeFlags).strict;
  switch (t.kind) {
    case 'string':
    case 'datetime':
    case 'uri':
    case 'bigint':
      return `String${q}`;
    case 'int':
      return strict ? `int${q}` : `num${q}`;
    case 'double':
      return strict ? `double${q}` : `num${q}`;
    case 'num':
      return `num${q}`;
    case 'bool':
      return `bool${q}`;
    case 'list':
      return `List<dynamic>${q}`;
    case 'map':
    case 'model':
      return `Map<String, dynamic>${q}`;
    default:
      return `Object${q}`;
  }
}

const castError = (v: JsonValue, t: XType, nullable: boolean) =>
  `type '${dartRuntimeType(v)}' is not a subtype of type '${castTarget(t, nullable)}' in type cast`;

function enumValuesText(t: Extract<XType, { kind: 'enum' }>): string {
  return t.values.join(', ');
}

// Dart's DateTime.parse grammar (sdk/lib/core/date_time.dart `_parseFormat`).
const DART_DATE =
  /^([+-]?\d{4,6})-?(\d\d)-?(\d\d)(?:[ T](\d\d)(?::?(\d\d)(?::?(\d\d)(?:[.,](\d+))?)?)?( ?[zZ]| ?([-+])(\d\d)(?::?(\d\d))?)?)?$/;
const BIGINT = /^\s*[+-]?(?:\d+|0[xX][0-9a-fA-F]+)\s*$/;

interface Problem {
  severity: 'error' | 'warning';
  actual: string;
  phrase: string;
  error: string;
}

interface Site {
  path: string;
  model: LinkedModel;
  field: XField | undefined; // undefined at the root
  /** A key or field on the way here matches the redaction rules: no values in the message. */
  sensitive: boolean;
}

const sensitiveField = (f: XField) => isSensitiveField(f.key) || isSensitiveField(f.dartName);

class Walker {
  readonly out: XViolation[] = [];
  private readonly seen = new Map<string, XViolation>();
  private nodes = 0;
  partial?: string;
  private readonly maxViolations: number;
  private readonly maxNodes: number;

  constructor(private readonly lookup: ModelLookup, private readonly opts: CheckOptions) {
    this.maxViolations = opts.maxViolations ?? MAX_VIOLATIONS;
    this.maxNodes = opts.maxNodes ?? 200_000;
  }

  get full(): boolean {
    return this.out.length >= this.maxViolations || this.partial !== undefined;
  }

  private tick(): boolean {
    if (++this.nodes > this.maxNodes) {
      this.partial ??= `stopped after ${this.maxNodes} values`;
      return false;
    }
    return true;
  }

  report(site: Site, expected: string, p: Problem): void {
    const field = site.field;
    const kind = `${site.model.name}|${field?.dartName ?? ''}|${p.severity}|${p.actual.replace(/ .*/, '')}|${site.path.replace(/\[\d+\]/g, '[]')}`;
    const prev = this.seen.get(kind);
    if (prev) {
      prev.count = (prev.count ?? 1) + 1;
      return;
    }
    if (this.out.length >= this.maxViolations) return;
    const rawWhere = site.path === '$' ? 'the response' : site.path.replace(/^\$\.?/, '');
    const where = rawWhere.length > 120 ? `${rawWhere.slice(0, 120)}…` : rawWhere;
    const m = site.model;
    let error = p.error;
    if (m.checked && field && p.severity === 'error') error = `CheckedFromJsonException: Could not create \`${m.name}\`. There is a problem with "${field.key}". ${error}`;
    const v: XViolation = {
      path: site.path,
      model: m.name,
      field: field?.dartName ?? '',
      key: field?.key ?? '',
      expected,
      actual: p.actual,
      severity: p.severity,
      message: `${where} is ${p.phrase} in ${this.opts.method} ${this.opts.urlPath} → ${error}`,
    };
    const line = field && m.fieldLines?.[field.dartName];
    if (m.sourceFile && line) {
      v.file = m.sourceFile;
      v.line = line;
      const col = m.fieldColumns?.[field.dartName];
      if (col !== undefined) v.column = col;
    } else if (m.sourceFile && !field && m.sourceLine) {
      v.file = m.sourceFile;
      v.line = m.sourceLine;
    } else {
      v.file = m.generatedFile;
      v.line = m.generatedLine;
    }
    this.seen.set(kind, v);
    this.out.push(v);
  }

  /** Root: a model or a list of models. */
  root(value: JsonValue, model: LinkedModel, listOf: boolean): void {
    const site: Site = { path: '$', model, field: undefined, sensitive: false };
    if (listOf) {
      if (!Array.isArray(value)) {
        const t: XType = { kind: 'list', of: { kind: 'model', name: model.name } };
        this.report(site, `List<${model.name}>`, { severity: 'error', actual: actualText(value), phrase: phrase(value), error: castError(value, t, false) });
        return;
      }
      for (let i = 0; i < value.length && !this.full; i++) {
        const el = value[i];
        const s: Site = { path: `$[${i}]`, model, field: undefined, sensitive: false };
        if (!isObject(el)) {
          this.report(s, model.name, { severity: 'error', actual: actualText(el), phrase: phrase(el), error: castError(el, { kind: 'model', name: model.name }, false) });
          continue;
        }
        this.model(el, model, `$[${i}]`, 0);
      }
      return;
    }
    if (!isObject(value)) {
      this.report(site, model.name, { severity: 'error', actual: actualText(value), phrase: phrase(value), error: castError(value, { kind: 'model', name: model.name }, false) });
      return;
    }
    this.model(value, model, '$', 0);
  }

  model(obj: { [k: string]: JsonValue }, model: LinkedModel, path: string, depth: number, sensitive = false): void {
    if (depth > 64 || !this.tick()) return;
    for (const f of model.fields) {
      if (this.full) return;
      const site: Site = { path: pathKey(path, f.key), model, field: f, sensitive: sensitive || sensitiveField(f) };
      const t = f.type;
      const present = Object.prototype.hasOwnProperty.call(obj, f.key);
      const expected = describeType(t, f.nullable && !f.hasDefault);
      if (!present) {
        if (f.requiredKey) {
          this.report(site, expected, { severity: 'error', actual: 'missing', phrase: 'missing', error: `MissingRequiredKeysException: Required keys are missing: ${f.key}.` });
          continue;
        }
        if (t.kind === 'unknown' || f.nullable || f.hasDefault) continue;
        this.report(site, expected, { severity: 'error', actual: 'missing', phrase: 'missing', error: this.nullError(t, false) });
        continue;
      }
      const v = obj[f.key];
      if (v === null) {
        if (f.disallowNull) {
          this.report(site, expected, { severity: 'error', actual: 'null', phrase: 'null', error: `DisallowedNullValueException: These keys had \`null\` values, which is not allowed: ${f.key}` });
          continue;
        }
        if (t.kind === 'unknown' || f.nullable || f.hasDefault) continue;
        this.report(site, expected, { severity: 'error', actual: 'null', phrase: 'null', error: this.nullError(t, false) });
        continue;
      }
      this.value(v, t, f.nullable, site, depth, expected);
    }
  }

  private nullError(t: XType, nullable: boolean): string {
    if (t.kind === 'enum') return `Invalid argument(s): A value must be provided. Supported values: ${enumValuesText(t)}`;
    return castError(null, t, nullable);
  }

  /** A non-null value against a type. `nullable` only affects the cast text (`String?`). */
  value(v: JsonValue, t: XType, nullable: boolean, site: Site, depth: number, shown?: string): void {
    if (!this.tick()) return;
    const flags = t as TypeFlags;
    const expected = shown ?? describeType(t, nullable);
    const sens = site.sensitive;
    const bad = (error: string, severity: 'error' | 'warning' = 'error', ph = phrase(v, sens)) =>
      this.report(site, expected, { severity, actual: actualText(v, sens), phrase: ph, error });
    switch (t.kind) {
      case 'string':
      case 'uri':
        if (typeof v !== 'string') bad(castError(v, t, nullable));
        return;
      case 'datetime':
        if (typeof v !== 'string') bad(castError(v, t, nullable));
        else if (!DART_DATE.test(v)) this.report(site, expected, { severity: 'error', actual: 'string (not a date)', phrase: 'not a valid date', error: 'FormatException: Invalid date format' });
        return;
      case 'bigint':
        if (typeof v !== 'string') bad(castError(v, t, nullable));
        else if (!BIGINT.test(v)) this.report(site, expected, { severity: 'error', actual: 'string (not an integer)', phrase: 'not an integer string', error: 'FormatException: Could not parse BigInt' });
        return;
      case 'bool':
        if (typeof v !== 'boolean') bad(castError(v, t, nullable));
        return;
      case 'num':
        if (!isNumber(v)) bad(castError(v, t, nullable));
        return;
      case 'int':
        if (!isNumber(v)) return bad(castError(v, t, nullable));
        if (flags.strict) {
          if (v instanceof IntegralDouble || !Number.isInteger(v)) bad(castError(v, t, nullable));
        } else if (typeof v === 'number' && !Number.isInteger(v)) {
          bad(sens ? 'toInt() drops the fraction' : `toInt() truncates it to ${numText(Math.trunc(v), false)}`, 'warning');
        }
        return;
      case 'double':
        if (!isNumber(v)) return bad(castError(v, t, nullable));
        if (flags.strict && typeof v === 'number' && Number.isInteger(v)) bad(castError(v, t, nullable));
        return;
      case 'enum': {
        const vals = flags.jsonValues ?? t.values;
        const raw = v instanceof IntegralDouble ? v.value : v;
        if ((typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') && vals.some((x) => x === raw)) return;
        // REVIEW-4 #6: never the raw value under a sensitive key; elsewhere ≤ 40 chars, quoted, escaped
        const shown = sens ? (typeof raw === 'string' ? 'an unknown value' : phrase(v, true)) : typeof raw === 'string' ? quoted(raw) : actualText(v);
        const actual = typeof raw === 'string' ? (sens ? 'unknown enum value' : `unknown enum value ${shown}`) : actualText(v, sens);
        if (flags.lenient) {
          const to = flags.unknownToNull ? 'null' : (flags.fallback ?? 'its unknownEnumValue');
          this.report(site, expected, { severity: 'warning', actual, phrase: shown, error: `not a ${t.name} value: decoded as ${to}` });
        } else {
          const src = sens ? '[redacted]' : typeof raw === 'string' ? shortText(raw) : shortText(JSON.stringify(raw) ?? String(raw));
          this.report(site, expected, {
            severity: 'error',
            actual,
            phrase: typeof raw === 'string' ? shown : phrase(v, sens),
            error: `Invalid argument(s): \`${src}\` is not one of the supported values: ${enumValuesText(t)}`,
          });
        }
        return;
      }
      case 'list': {
        if (!Array.isArray(v)) return bad(castError(v, t, nullable));
        const of = t.of as XType;
        for (let i = 0; i < v.length && !this.full; i++) {
          const el = v[i];
          const s: Site = { ...site, path: `${site.path}[${i}]` };
          if (el === null) {
            if (!flags.elemNullable && of.kind !== 'unknown' && of.kind !== 'dynamic') {
              this.report(s, describeType(of), { severity: 'error', actual: 'null', phrase: 'null', error: this.nullError(of, false) });
            }
            continue;
          }
          this.value(el, of, !!flags.elemNullable, s, depth);
        }
        return;
      }
      case 'map': {
        if (!isObject(v)) return bad(castError(v, t, nullable));
        const of = t.of as XType;
        for (const k of Object.keys(v)) {
          if (this.full) return;
          const el = v[k];
          const s: Site = { ...site, path: pathKey(site.path, k), sensitive: site.sensitive || isSensitiveField(k) };
          if (el === null) {
            if (!flags.elemNullable && of.kind !== 'unknown' && of.kind !== 'dynamic') {
              this.report(s, describeType(of), { severity: 'error', actual: 'null', phrase: 'null', error: this.nullError(of, false) });
            }
            continue;
          }
          this.value(el, of, !!flags.elemNullable, s, depth);
        }
        return;
      }
      case 'model': {
        if (!isObject(v)) return bad(castError(v, t, nullable));
        const m = this.lookup.get(t.name);
        if (m) this.model(v, m, site.path, depth + 1, site.sensitive);
        return;
      }
      default:
        return; // dynamic / unknown
    }
  }
}

/** Checks `value` (a decoded body) against `model` (or a list of it). */
export function checkValue(value: JsonValue, model: LinkedModel, listOf: boolean, lookup: ModelLookup, opts: CheckOptions): CheckOutcome {
  const w = new Walker(lookup, opts);
  try {
    w.root(value, model, listOf);
  } catch {
    w.partial ??= 'stopped early';
  }
  for (const v of w.out) if (v.count && v.count > 1) v.message += ` (${v.count} places in this response)`;
  return { violations: w.out, partial: w.partial };
}
