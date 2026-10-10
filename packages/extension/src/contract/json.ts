/**
 * JSON for the contract check: like Dart's `jsonDecode`, a number literal with a fraction or exponent
 * is a `double` even when its value is integral (`1.0`), which `json['x'] as int` rejects. JSON.parse
 * loses that, so bodies up to `maxExactBytes` are read by this parser; larger ones fall back to
 * JSON.parse (integral doubles then look like ints). Objects have no prototype. Pure; never throws.
 */

/** A JSON number written as a double whose value is integral (`1.0`, `2e3`). */
export class IntegralDouble {
  constructor(readonly value: number) {}
}

export type JsonValue = null | boolean | number | string | IntegralDouble | JsonValue[] | { [k: string]: JsonValue };

export type ParseResult = { ok: true; value: JsonValue; exact: boolean } | { ok: false; error: string };

const MAX_DEPTH = 512;

export function parseJson(text: string, maxExactBytes = 2_000_000): ParseResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (src.length <= maxExactBytes) {
    try {
      return { ok: true, value: new JsonParser(src).parse(), exact: true };
    } catch (e) {
      if (!(e instanceof DepthError)) return { ok: false, error: (e as Error).message };
      // very deep: fall through to JSON.parse
    }
  }
  try {
    return { ok: true, value: JSON.parse(src) as JsonValue, exact: false };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

class DepthError extends Error {}

class JsonParser {
  private i = 0;
  private depth = 0;

  constructor(private readonly s: string) {}

  parse(): JsonValue {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) this.fail('unexpected trailing characters');
    return v;
  }

  private fail(why: string): never {
    throw new Error(`${why} at position ${this.i}`);
  }

  private ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 10 || c === 13 || c === 9) this.i++;
      else break;
    }
  }

  private value(): JsonValue {
    const c = this.s[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return this.string();
    if (c === 't' && this.s.startsWith('true', this.i)) {
      this.i += 4;
      return true;
    }
    if (c === 'f' && this.s.startsWith('false', this.i)) {
      this.i += 5;
      return false;
    }
    if (c === 'n' && this.s.startsWith('null', this.i)) {
      this.i += 4;
      return null;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    return this.fail(c === undefined ? 'unexpected end of JSON' : `unexpected ${JSON.stringify(c)}`);
  }

  private object(): JsonValue {
    if (++this.depth > MAX_DEPTH) throw new DepthError('too deep');
    this.i++;
    const out: { [k: string]: JsonValue } = Object.create(null) as { [k: string]: JsonValue };
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      this.depth--;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail('expected a key');
      const k = this.string();
      this.ws();
      if (this.s[this.i] !== ':') this.fail('expected ":"');
      this.i++;
      this.ws();
      out[k] = this.value();
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') break;
      if (c !== ',') this.fail('expected "," or "}"');
    }
    this.depth--;
    return out;
  }

  private array(): JsonValue {
    if (++this.depth > MAX_DEPTH) throw new DepthError('too deep');
    this.i++;
    const out: JsonValue[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      this.depth--;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value());
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') break;
      if (c !== ',') this.fail('expected "," or "]"');
    }
    this.depth--;
    return out;
  }

  private string(): string {
    const s = this.s;
    const start = ++this.i;
    // fast path: no escapes
    for (;;) {
      const c = s.charCodeAt(this.i);
      if (Number.isNaN(c)) this.fail('unterminated string');
      if (c === 34) {
        this.i++;
        return s.slice(start, this.i - 1);
      }
      if (c === 92) break;
      if (c < 32) this.fail('control character in string');
      this.i++;
    }
    let out = s.slice(start, this.i);
    for (;;) {
      const c = s[this.i];
      if (c === undefined) this.fail('unterminated string');
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === '\\') {
        const e = s[this.i + 1];
        this.i += 2;
        switch (e) {
          case '"':
          case '\\':
          case '/':
            out += e;
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = s.slice(this.i, this.i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.i += 4;
            break;
          }
          default:
            this.fail('bad escape');
        }
        continue;
      }
      if (c.charCodeAt(0) < 32) this.fail('control character in string');
      out += c;
      this.i++;
    }
  }

  private number(): JsonValue {
    const s = this.s;
    const start = this.i;
    if (s[this.i] === '-') this.i++;
    if (s[this.i] === '0') this.i++;
    else if (s[this.i] >= '1' && s[this.i] <= '9') while (s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    else this.fail('bad number');
    let isDouble = false;
    if (s[this.i] === '.') {
      isDouble = true;
      this.i++;
      if (!(s[this.i] >= '0' && s[this.i] <= '9')) this.fail('bad number');
      while (s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    }
    if (s[this.i] === 'e' || s[this.i] === 'E') {
      isDouble = true;
      this.i++;
      if (s[this.i] === '+' || s[this.i] === '-') this.i++;
      if (!(s[this.i] >= '0' && s[this.i] <= '9')) this.fail('bad number');
      while (s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    }
    const n = Number(s.slice(start, this.i));
    // Dart: an integer literal beyond 64 bits decodes as a double
    if (!isDouble && !Number.isSafeInteger(n) && Math.abs(n) >= 2 ** 63) return new IntegralDouble(n);
    return isDouble && Number.isInteger(n) ? new IntegralDouble(n) : n;
  }
}
