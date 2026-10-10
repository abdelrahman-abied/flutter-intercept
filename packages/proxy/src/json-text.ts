// JSON parse / stringify that round-trip number literals exactly (mutate rules, CONTRACTS §10.2).
//
// Why not JSON.parse + JSON.stringify: they rewrite numbers the mutation never touched, and Dart notices.
// `1.0` would come back as `1` — jsonDecode then yields an int and `json['price'] as double` throws, a
// bug the real API doesn't have. Integers beyond 2^53 would lose digits. So every number whose
// JavaScript value doesn't print back to the same text is kept as a RawNumber (its source text) and
// written back verbatim. (JSON.parse's `context.source` / JSON.rawJSON would do this natively, but VS
// Code 1.90's Node 20 has neither.)
//
// Everything else follows JSON.parse: RFC 8259 syntax, last duplicate key wins, "__proto__" is an
// ordinary own key. Like JSON.parse, objects list integer-like keys first when written back.

/** A number literal kept as written (`1.0`, `1e3`, `-0`, `12345678901234567890`). */
export class RawNumber {
  constructor(readonly source: string) {}
  valueOf(): number {
    return Number(this.source);
  }
}

/** Nesting deeper than this is refused (protects the recursive parser / writer and the stack). */
export const MAX_JSON_DEPTH = 1000;
/** Values (objects, arrays, strings, numbers, literals) one parse may create (REVIEW-4 #4). */
export const MAX_JSON_VALUES = 2_000_000;
/** Longest text stringifyJsonText writes by default (REVIEW-4 #4). */
export const MAX_JSON_OUTPUT = 64 * 1024 * 1024;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const CONTROL = /[\u0000-\u001f]/;

/**
 * Parses JSON text; throws a SyntaxError that names the position, or a RangeError past `maxValues`
 * values (default MAX_JSON_VALUES) or MAX_JSON_DEPTH levels.
 */
export function parseJsonText(text: string, maxValues = MAX_JSON_VALUES): unknown {
  let i = 0;
  let values = 0;
  const n = text.length;
  const fail = (why: string): never => {
    throw new SyntaxError(`${why} at position ${i}`);
  };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else return;
    }
  };
  const str = (): string => {
    const start = i; // at the opening quote
    let j = i + 1;
    let escaped = false;
    for (;;) {
      j = text.indexOf('"', j);
      if (j < 0) {
        i = start;
        return fail('Unterminated string');
      }
      let k = j - 1;
      while (text.charCodeAt(k) === 0x5c) k--;
      if ((j - 1 - k) % 2 === 0) break; // even number of backslashes: real end quote
      escaped = true;
      j++;
    }
    const raw = text.slice(start + 1, j);
    i = j + 1;
    if (!escaped && raw.indexOf('\\') < 0) {
      if (CONTROL.test(raw)) {
        i = start;
        return fail('Bad control character in string');
      }
      return raw;
    }
    try {
      return JSON.parse(text.slice(start, j + 1)) as string;
    } catch {
      i = start;
      return fail('Bad string');
    }
  };
  const value = (depth: number): unknown => {
    if (++values > maxValues) throw new RangeError(`more than ${maxValues} JSON values`);
    ws();
    const c = text[i];
    if (c === '{') {
      if (depth >= MAX_JSON_DEPTH) throw new RangeError(`nested more than ${MAX_JSON_DEPTH} levels deep`);
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expected a string key');
        const key = str();
        ws();
        if (text[i] !== ':') fail('Expected ":"');
        i++;
        const v = value(depth + 1);
        if (key === '__proto__') Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        else obj[key] = v;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        return fail('Expected "," or "}"');
      }
    }
    if (c === '[') {
      if (depth >= MAX_JSON_DEPTH) throw new RangeError(`nested more than ${MAX_JSON_DEPTH} levels deep`);
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        return fail('Expected "," or "]"');
      }
    }
    if (c === '"') return str();
    if (c === 't' && text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (c === 'f' && text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (c === 'n' && text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail(i >= n ? 'Unexpected end of JSON' : `Unexpected ${JSON.stringify(text[i])}`);
    i += m[0].length;
    const num = Number(m[0]);
    return String(num) === m[0] ? num : new RawNumber(m[0]);
  };
  const out = value(0);
  ws();
  if (i < n) fail(`Unexpected ${JSON.stringify(text[i])} after the JSON value`);
  return out;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Compact JSON; RawNumbers are written verbatim. Other values as JSON.stringify writes them. Throws a
 * RangeError once the output passes `maxLength` characters (default MAX_JSON_OUTPUT) or MAX_JSON_DEPTH.
 */
export function stringifyJsonText(value: unknown, maxLength = MAX_JSON_OUTPUT): string {
  const chunks: string[] = [];
  let cur = '';
  let total = 0;
  const put = (s: string) => {
    total += s.length;
    if (total > maxLength) throw new RangeError(`JSON output longer than ${maxLength} characters`);
    cur += s;
    if (cur.length > 65536) {
      chunks.push(cur);
      cur = '';
    }
  };
  const write = (v: unknown, depth: number): boolean => {
    if (v instanceof RawNumber) {
      put(v.source);
      return true;
    }
    if (typeof v === 'object' && v !== null && (Array.isArray(v) || isPlainObject(v))) {
      if (depth >= MAX_JSON_DEPTH) throw new RangeError('JSON nested too deeply');
      if (Array.isArray(v)) {
        put('[');
        for (let idx = 0; idx < v.length; idx++) {
          if (idx) put(',');
          if (!writable(v[idx])) put('null');
          else write(v[idx], depth + 1);
        }
        put(']');
        return true;
      }
      put('{');
      let first = true;
      for (const k of Object.keys(v)) {
        const x = (v as Record<string, unknown>)[k];
        if (!writable(x)) continue; // undefined / function / symbol: omitted, like JSON.stringify
        put(first ? JSON.stringify(k) : `,${JSON.stringify(k)}`);
        put(':');
        write(x, depth + 1);
        first = false;
      }
      put('}');
      return true;
    }
    const s = JSON.stringify(v);
    if (s === undefined) return false;
    put(s);
    return true;
  };
  if (!writable(value)) return 'null';
  write(value, 0);
  chunks.push(cur);
  return chunks.join('');
}

/** Values JSON.stringify writes (undefined, functions and symbols are skipped / null). */
function writable(v: unknown): boolean {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return false;
  if (typeof v === 'object' && v !== null && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    return (v as { toJSON(): unknown }).toJSON() !== undefined;
  }
  return true;
}
