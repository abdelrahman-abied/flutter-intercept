/**
 * JSON paths for `mutate` rules (CONTRACTS §10.2): the grammar of `@flutter-intercept/proxy/jsonpath`, mirrored
 * here so the panel can build and check paths without bundling proxy code. A test keeps the two in agreement
 * (same segments, same canonical text, same accepted / rejected inputs).
 *
 *   `$` then `.name` (any run without `. [ ] ' " *` or whitespace), `.*`, `['key']` / `["key"]` (JSON escapes),
 *   `[3]`, `[*]`. Canonical form: `.name` for identifier-like keys, `['…']` (escaped) otherwise.
 */

export type PathSegment = { key: string } | { index: number } | { wildcard: true };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NAME_STOP = /[.[\]'"*\s]/;
const ESCAPES: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

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
      s += `\\u${code.toString(16).padStart(4, '0')}`;
    } else s += ch;
  }
  return `['${s}']`;
}

export function formatSegment(s: PathSegment): string {
  if ('wildcard' in s) return '[*]';
  if ('index' in s) return `[${s.index}]`;
  return IDENT.test(s.key) ? `.${s.key}` : quoteKey(s.key);
}

export function formatPath(segments: PathSegment[]): string {
  return '$' + segments.map(formatSegment).join('');
}

/** `parent` + one child step (object key or array index). */
export function childPath(parent: string, k: string | number): string {
  return parent + formatSegment(typeof k === 'number' ? { index: k } : { key: k });
}

/** Parses a path; throws an Error with a readable message on bad syntax. */
export function parsePath(path: string): PathSegment[] {
  const fail = (pos: number, why: string): never => { throw new Error(`${why} (at position ${pos})`); };
  let i = 0;
  let end = path.length;
  while (i < end && /\s/.test(path[i])) i++;
  while (end > i && /\s/.test(path[end - 1])) end--;
  if (path[i] !== '$') fail(i, 'A path starts with $ (e.g. $.user.name)');
  i++;
  const out: PathSegment[] = [];
  while (i < end) {
    const c = path[i];
    if (c === '.') {
      i++;
      if (path[i] === '.') fail(i - 1, 'Recursive descent (..) is not supported');
      if (path[i] === '*') { out.push({ wildcard: true }); i++; continue; }
      const start = i;
      while (i < end && !NAME_STOP.test(path[i])) i++;
      if (i === start) fail(start, i >= end ? 'Expected a field name after "."' : `Unexpected ${JSON.stringify(path[i])} after "."; use ['…'] for odd keys`);
      if (path[i] === '*') fail(i, `"*" inside a name; use ['…'] for odd keys`);
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
          if (i >= end) fail(open, `Unterminated quoted key (missing ${q})`);
          const ch = path[i];
          if (ch === q) { i++; break; }
          if (ch === '\\') {
            const e = path[i + 1];
            if (e === 'u') {
              const hex = path.slice(i + 2, i + 6);
              if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail(i, 'Bad \\u escape (expected 4 hex digits)');
              key += String.fromCharCode(parseInt(hex, 16));
              i += 6;
            } else if (e !== undefined && ESCAPES[e] !== undefined) {
              key += ESCAPES[e];
              i += 2;
            } else fail(i, `Unknown escape "\\${e ?? ''}"`);
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
        if (!Number.isSafeInteger(index)) fail(start, 'Index too large');
        out.push({ index });
      } else {
        fail(i, q === '-' ? 'Negative indexes are not supported' : i >= end ? 'Unclosed "["' : "Expected ['key'], [index] or [*]");
      }
      while (i < end && path[i] === ' ') i++;
      if (path[i] !== ']') fail(i, i >= end ? 'Unclosed "["' : `Expected "]", got ${JSON.stringify(path[i])}`);
      i++;
    } else {
      fail(i, `Unexpected ${JSON.stringify(c)}; expected "." or "["`);
    }
  }
  return out;
}

/** undefined when `path` is valid and selects something below the root, else why not. */
export function checkPath(path: string): string | undefined {
  if (!path.trim()) return 'Required, e.g. $.user.avatar_url';
  try {
    if (!parsePath(path).length) return 'Point at a field below $, e.g. $.user.avatar_url';
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}

/** Canonical form of a valid path (so `$["a"]` and `$.a` compare equal); the input when it doesn't parse. */
export function normalizePath(path: string): string {
  try { return formatPath(parsePath(path)); } catch { return path; }
}

/** The same path with every array index replaced by [*] ("in every item"); undefined when it has no index. */
export function everyItemPath(path: string): string | undefined {
  let segs: PathSegment[];
  try { segs = parsePath(path); } catch { return undefined; }
  if (!segs.some((s) => 'index' in s)) return undefined;
  return formatPath(segs.map((s) => ('index' in s ? { wildcard: true } : s)));
}
