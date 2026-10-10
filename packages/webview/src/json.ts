/**
 * Lossless JSON for the webview. Nothing in the UI goes through JSON.parse/JSON.stringify:
 * those turn 12345678901234567890 into 12345678901234567000, -0 into 0, 1e400 into Infinity,
 * 1.0 into 1, drop duplicate keys and rewrite escapes. Dart keeps 64-bit ints, so the app must
 * receive exactly the bytes the user saw.
 *
 * - parseJsonLossless: strict parser that keeps every scalar's original token text.
 * - validateJson: the same parser without building a tree (strict, with line and column).
 * - formatJson: re-indents the token stream and never changes a token.
 *
 * All three are iterative (explicit stack), so deep nesting can't overflow the call stack.
 */

export type JsonNode =
  | { t: 'obj'; entries: JsonEntry[] }
  | { t: 'arr'; items: JsonNode[] }
  | { t: 'str'; raw: string }                 // raw token text, quotes and escapes included
  | { t: 'num'; raw: string }                 // raw token text, e.g. "12345678901234567890", "-0", "1.0"
  | { t: 'lit'; raw: 'true' | 'false' | 'null' };
export interface JsonEntry { keyRaw: string; value: JsonNode }

export type JsonCheck = { ok: true } | { ok: false; message: string; offset: number; line: number; column: number };
export type JsonParse = { ok: true; value: JsonNode } | Extract<JsonCheck, { ok: false }>;

class JsonError extends Error {
  constructor(msg: string, public at: number) { super(msg); }
}

type Frame =
  | { kind: 'obj'; node: { t: 'obj'; entries: JsonEntry[] } | null; key: string }
  | { kind: 'arr'; node: { t: 'arr'; items: JsonNode[] } | null };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function run(text: string, build: boolean): JsonNode | null {
  const n = text.length;
  let i = 0;
  const fail = (msg: string, at = i): never => { throw new JsonError(msg, at); };
  const describe = (at: number) => (at >= n ? 'end of input' : `'${text[at]}'`);
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };
  /** Scans a string token starting at the opening quote; returns its raw text. */
  const string = (): string => {
    const start = i;
    i++;
    while (true) {
      if (i >= n) fail('Unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; return build ? text.slice(start, i) : ''; }
      if (c < 0x20) fail('Control character in string (use \\n, \\t, …)');
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('Invalid \\u escape');
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail('Invalid escape sequence');
      } else i++;
    }
  };
  const key = (): string => {
    ws();
    if (text[i] !== '"') fail(`Expected property name, got ${describe(i)}`);
    const k = string();
    ws();
    if (text[i] !== ':') fail(`Expected ':' after property name, got ${describe(i)}`);
    i++;
    return k;
  };

  const stack: Frame[] = [];
  while (true) {
    // ---- parse one value at i (containers push a frame and loop back here)
    ws();
    const c = text[i];
    let v: JsonNode | null = null;
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') { i++; v = build ? { t: 'obj', entries: [] } : null; }
      else {
        stack.push({ kind: 'obj', node: build ? { t: 'obj', entries: [] } : null, key: key() });
        continue;
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') { i++; v = build ? { t: 'arr', items: [] } : null; }
      else {
        stack.push({ kind: 'arr', node: build ? { t: 'arr', items: [] } : null });
        continue;
      }
    } else if (c === '"') {
      const raw = string();
      v = build ? { t: 'str', raw } : null;
    } else if (c === 't' || c === 'f' || c === 'n') {
      const word = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
      if (!text.startsWith(word, i)) fail(`Unexpected ${describe(i)}`);
      i += word.length;
      v = build ? { t: 'lit', raw: word } : null;
    } else if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) fail(`Unexpected ${describe(i)}`);
      i += m![0].length;
      v = build ? { t: 'num', raw: m![0] } : null;
    } else {
      fail(`Unexpected ${describe(i)}`);
    }

    // ---- attach the finished value to its parent(s), closing containers as we go
    while (true) {
      const f = stack[stack.length - 1];
      if (!f) {
        ws();
        if (i < n) fail(`Unexpected ${describe(i)} after JSON value`);
        return v;
      }
      if (build) {
        if (f.kind === 'obj') f.node!.entries.push({ keyRaw: f.key, value: v! });
        else f.node!.items.push(v!);
      }
      ws();
      if (text[i] === ',') {
        i++;
        if (f.kind === 'obj') f.key = key();
        break; // parse the next value
      }
      const close = f.kind === 'obj' ? '}' : ']';
      if (text[i] !== close) fail(`Expected ',' or '${close}', got ${describe(i)}`);
      i++;
      stack.pop();
      v = f.node;
    }
  }
}

function toError(text: string, e: unknown): Extract<JsonCheck, { ok: false }> {
  if (!(e instanceof JsonError)) throw e;
  const { line, column } = lineCol(text, e.at);
  return { ok: false, message: e.message, offset: e.at, line, column };
}

export function parseJsonLossless(text: string): JsonParse {
  try {
    return { ok: true, value: run(text, true)! };
  } catch (e) {
    return toError(text, e);
  }
}

/** Strict JSON validator with engine-independent error positions. Never modifies anything. */
export function validateJson(text: string): JsonCheck {
  try {
    run(text, false);
    return { ok: true };
  } catch (e) {
    return toError(text, e);
  }
}

export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNl = -1;
  for (let k = 0; k < offset && k < text.length; k++) {
    if (text.charCodeAt(k) === 0x0a) { line++; lastNl = k; }
  }
  return { line, column: offset - lastNl };
}

const isWs = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
const isStructural = (c: string) => c === '{' || c === '}' || c === '[' || c === ']' || c === ',' || c === ':' || c === '"';

/**
 * Pretty-print without touching a single token: strings (escapes included), numbers and
 * literals are copied byte for byte; only whitespace between tokens changes. Empty containers
 * stay `{}` / `[]`. A trailing newline in the input is kept. Returns undefined for invalid JSON.
 */
export function formatJson(text: string, indent = '  '): string | undefined {
  if (!validateJson(text).ok) return undefined;
  const n = text.length;
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  const nl = () => '\n' + indent.repeat(depth);
  const nextNonWs = (from: number) => {
    let k = from;
    while (k < n && isWs(text[k])) k++;
    return k;
  };
  while (i < n) {
    const c = text[i];
    if (isWs(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
    } else if (c === '{' || c === '[') {
      const k = nextNonWs(i + 1);
      if (text[k] === (c === '{' ? '}' : ']')) {
        out.push(c, text[k]);
        i = k + 1;
      } else {
        depth++;
        out.push(c, nl());
        i++;
      }
    } else if (c === '}' || c === ']') {
      depth--;
      out.push(nl(), c);
      i++;
    } else if (c === ',') {
      out.push(',', nl());
      i++;
    } else if (c === ':') {
      out.push(': ');
      i++;
    } else {
      let j = i;
      while (j < n && !isWs(text[j]) && !isStructural(text[j])) j++;
      out.push(text.slice(i, j));
      i = j;
    }
  }
  return out.join('') + (text.endsWith('\n') ? '\n' : '');
}

/** The decoded text of a raw JSON string token (`"a\"b"` → `a"b`). */
export function decodeJsonString(raw: string): string {
  try { return JSON.parse(raw) as string; } catch { return raw.slice(1, -1); }
}
