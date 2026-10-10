/**
 * JSON helpers for codegen (CONTRACTS §10.4). Pure.
 *
 * `JSON.parse` loses the one distinction Dart cares about: `jsonDecode('1.0')` is a `double`, `jsonDecode('1')`
 * an `int`. `parseJsonSample` keeps it: a number written with a fraction or an exponent comes back as a
 * `JsonDouble`, which `inferSchema` reads as `double` (plain JS numbers are classified by `Number.isInteger`).
 * `prettyJson` re-indents JSON text without re-serialising numbers or strings, so fixtures stay byte-faithful.
 */

/** A JSON number that Dart decodes as `double` (it had a fraction or an exponent, or is too large for int). */
export class JsonDouble {
  constructor(readonly value: number) {}
  toJSON(): number {
    return this.value;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const WS = /[ \t\n\r]*/y;
const INT64_MAX = 2 ** 63;

/** Parses JSON text like `JSON.parse`, but numbers Dart decodes as `double` become `JsonDouble`. Throws on bad JSON. */
export function parseJsonSample(text: string): unknown {
  let pos = 0;
  const fail = (what: string): never => {
    throw new SyntaxError(`Invalid JSON: ${what} at position ${pos}`);
  };
  const ws = () => {
    WS.lastIndex = pos;
    WS.exec(text);
    pos = WS.lastIndex;
  };
  const value = (depth: number): unknown => {
    if (depth > 512) fail('nesting too deep');
    ws();
    const c = text[pos];
    if (c === '{') {
      pos++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[pos] !== '"') fail('expected a key');
        const key = str();
        ws();
        if (text[pos++] !== ':') fail('expected ":"');
        const v = value(depth + 1);
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        const d = text[pos++];
        if (d === '}') return obj;
        if (d !== ',') fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      pos++;
      const arr: unknown[] = [];
      ws();
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        const d = text[pos++];
        if (d === ']') return arr;
        if (d !== ',') fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', pos)) return (pos += 4), true;
    if (text.startsWith('false', pos)) return (pos += 5), false;
    if (text.startsWith('null', pos)) return (pos += 4), null;
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(text);
    if (!m) return fail('unexpected character');
    pos = NUMBER.lastIndex;
    const n = Number(m[0]);
    return m[1] !== undefined || m[2] !== undefined || Math.abs(n) >= INT64_MAX ? new JsonDouble(n) : n;
  };
  const str = (): string => {
    STRING.lastIndex = pos;
    const m = STRING.exec(text);
    if (!m) return fail('bad string');
    pos = STRING.lastIndex;
    return JSON.parse(m[0]) as string;
  };
  const result = value(0);
  ws();
  if (pos !== text.length) fail('trailing characters');
  return result;
}

/** True when `text` is valid JSON. */
export function isJson(text: string): boolean {
  try {
    parseJsonSample(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-indents valid JSON text (2 spaces, `"key": value`, empty `{}`/`[]` kept compact) without touching the
 * literals. Throws on invalid JSON.
 */
export function prettyJson(text: string): string {
  parseJsonSample(text); // validate
  const tokens: string[] = [];
  const TOKEN = /\s*("(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,"]+)/gy;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text))) tokens.push(m[1]);
  let out = '';
  let depth = 0;
  const nl = () => '\n' + '  '.repeat(depth);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '{' || t === '[') {
      const close = t === '{' ? '}' : ']';
      if (tokens[i + 1] === close) {
        out += t + close;
        i++;
      } else {
        depth++;
        out += t + nl();
      }
    } else if (t === '}' || t === ']') {
      depth--;
      out += nl() + t;
    } else if (t === ',') out += ',' + nl();
    else if (t === ':') out += ': ';
    else out += t;
  }
  return out;
}
