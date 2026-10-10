/**
 * JSON with comments, for `.vscode/flutter-intercept.json` (CONTRACTS §12.1). Pure.
 *
 * Like every `.vscode/*.json`, the file may carry `//` and `/* *\/` comments and trailing commas. They are blanked
 * (same length, newlines kept) so every offset still points at the user's text, then a small scanner checks the
 * syntax — it reports "line L, column C" for every kind of error (V8's own messages omit the position for some) —
 * and records where each element of the top-level `rules` array starts, so problems can name the rule's line.
 */

export interface JsonParseResult {
  value?: unknown;
  /** Readable syntax error with its position, e.g. "line 4, column 7: expected ',' or '}'". */
  error?: string;
  /** Start offsets (in the original text) of the elements of the top-level `rules` array. */
  ruleOffsets: number[];
  hadComments: boolean;
}

/** `text` with comments and trailing commas replaced by spaces (newlines kept), so offsets are unchanged. */
export function blankJsonc(text: string): { text: string; hadComments: boolean } {
  const out = text.split('');
  const n = text.length;
  let hadComments = false;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      hadComments = true;
      while (i < n && text[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && text[i + 1] === '*') {
      hadComments = true;
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
    } else {
      i++;
    }
  }
  // trailing commas: `,` followed (after whitespace) by `}` or `]`, outside strings
  const blanked = out.join('');
  const res = blanked.split('');
  for (let j = 0; j < n; j++) {
    const c = blanked[j];
    if (c === '"') {
      j++;
      while (j < n && blanked[j] !== '"' && blanked[j] !== '\n') j += blanked[j] === '\\' ? 2 : 1;
    } else if (c === ',') {
      let k = j + 1;
      while (k < n && /\s/.test(blanked[k])) k++;
      if (blanked[k] === '}' || blanked[k] === ']') res[j] = ' ';
    }
  }
  return { text: res.join(''), hadComments };
}

/** 1-based line and column of an offset in `text` (line starts indexed once, then binary search). */
export function lineLocator(text: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

class ScanError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_DEPTH = 256;

/** Syntax check of strict JSON; records the `rules` element offsets. Throws ScanError. */
function scan(t: string, ruleOffsets: number[]): void {
  const n = t.length;
  let i = 0;
  const ws = () => {
    while (i < n && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) i++;
  };
  const what = () => (i >= n ? 'end of file' : `'${t[i]}'`);
  const str = () => {
    const start = i;
    i++; // opening quote
    while (i < n && t[i] !== '"') {
      const c = t.charCodeAt(i);
      if (c < 0x20) throw new ScanError(i, 'line break or control character inside a string (unterminated string?)');
      if (t[i] === '\\') {
        const e = t[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(t.slice(i + 2, i + 6))) throw new ScanError(i, 'invalid \\u escape');
          i += 6;
          continue;
        }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) throw new ScanError(i, 'invalid escape in string');
        i += 2;
        continue;
      }
      i++;
    }
    if (i >= n) throw new ScanError(start, 'unterminated string');
    i++;
    return t.slice(start, i);
  };
  const value = (depth: number, rulesArray: boolean): void => {
    if (depth > MAX_DEPTH) throw new ScanError(i, 'nested too deeply');
    ws();
    const c = t[i];
    if (c === '{') {
      i++;
      ws();
      if (t[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (t[i] !== '"') throw new ScanError(i, `expected a property name in double quotes, found ${what()}`);
        const keyText = str();
        ws();
        if (t[i] !== ':') throw new ScanError(i, `expected ':' after property name, found ${what()}`);
        i++;
        const isRules = depth === 0 && keyText === '"rules"';
        if (isRules) ruleOffsets.length = 0; // a duplicate key: JSON.parse keeps the last one
        value(depth + 1, isRules);
        ws();
        if (t[i] === ',') {
          i++;
          continue;
        }
        if (t[i] === '}') {
          i++;
          return;
        }
        throw new ScanError(i, `expected ',' or '}' after a property value, found ${what()}`);
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (t[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (rulesArray) ruleOffsets.push(i);
        value(depth + 1, false);
        ws();
        if (t[i] === ',') {
          i++;
          continue;
        }
        if (t[i] === ']') {
          i++;
          return;
        }
        throw new ScanError(i, `expected ',' or ']' after an array element, found ${what()}`);
      }
    }
    if (c === '"') {
      str();
      return;
    }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(t.slice(i, i + 400));
    if (m && m[0] !== '-' && m[0] !== '') {
      i += m[0].length;
      return;
    }
    for (const lit of ['true', 'false', 'null']) {
      if (t.startsWith(lit, i)) {
        i += lit.length;
        return;
      }
    }
    throw new ScanError(i, i >= n ? 'unexpected end of file' : `unexpected ${what()}`);
  };
  value(0, false);
  ws();
  if (i < n) throw new ScanError(i, `unexpected ${what()} after the end of the JSON value`);
}

/** Parses JSON with comments / trailing commas. Never throws. */
export function parseJsonc(text: string): JsonParseResult {
  const { text: t, hadComments } = blankJsonc(text);
  const ruleOffsets: number[] = [];
  try {
    scan(t, ruleOffsets);
  } catch (e) {
    if (e instanceof ScanError) {
      const { line, column } = lineLocator(text)(e.offset);
      return { error: `line ${line}, column ${column}: ${e.message}`, ruleOffsets: [], hadComments };
    }
    return { error: (e as Error).message, ruleOffsets: [], hadComments };
  }
  try {
    return { value: JSON.parse(t), ruleOffsets, hadComments };
  } catch (e) {
    return { error: (e as Error).message.replace(/,? ".*" is not valid JSON$/s, ''), ruleOffsets: [], hadComments };
  }
}
