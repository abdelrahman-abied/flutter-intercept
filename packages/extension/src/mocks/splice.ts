/**
 * Update example (CONTRACTS §23.4): position-aware edits of a collection file. Pure: no vscode, no fs.
 *
 * - `parseJsonTree(text)` reads plain JSON (an optional BOM; no comments, no trailing commas) into a tree that keeps
 *   every value's span and its literal text (`1.0`, `é`, big integers stay as written).
 * - `spliceValue(text, path, replacement)` changes the text of one value — a string (`{string}`: Postman's example
 *   `body`) or any value (`{json}`: OpenAPI's `example` / `examples[k].value`, re-indented to where it sits) — and
 *   nothing else: every other byte (tabs, CRLF, escapes, key order) is identical.
 * - `insertBefore(text, path, entry)` adds an array element (Postman `response[k]`) or an object member (OpenAPI
 *   `examples[k]`) right before an existing one, with the same separator and indentation (mode `add`).
 * - `mergeExample(exampleBody, newestSampleBody, changes)` (merge mode): the example's own values, plus `added`
 *   fields with values from the newest answer (sanitised as §23.1) on every element of arrays of objects, without
 *   `removed` fields, with `type` changes converted (`int` → `double` keeps the number: `3` → `3.0`; other kinds take
 *   the answer's value). Formatted like the example (its indentation, or minified).
 * - `postmanExamplePath(text, endpointKey, exampleName)` finds `item…/response[k]` the way `parsePostman` names
 *   endpoints (`<METHOD> <url as written>`, ` #2` for repeats).
 * Problems are short lines; never the file's text.
 */
import { parseDriftPath, type DriftChange, type DriftPathSegment } from './drift';
import { TrafficSanitiser } from './fromTraffic';

export type JsonPath = readonly (string | number)[];

interface Span {
  start: number;
  end: number;
}

export type JsonNode =
  | (Span & { type: 'object'; members: JsonMember[] })
  | (Span & { type: 'array'; items: JsonNode[] })
  | (Span & { type: 'string'; value: string; raw: string })
  | (Span & { type: 'number'; raw: string })
  | (Span & { type: 'literal'; raw: 'true' | 'false' | 'null' });

export interface JsonMember {
  key: string;
  /** The key as written, quotes included. */
  keyRaw: string;
  keyStart: number;
  value: JsonNode;
}

export interface JsonStyle {
  /** One level of indentation; `''` = minified. */
  indent: string;
  eol: '\n' | '\r\n';
  /** Between a key and its value: `': '` or `':'`. */
  colon: string;
  /** Between members / items on one line (`indent` empty): `','` or `', '`. */
  comma?: string;
}

export type SpliceResult = { text: string; problem?: undefined } | { text?: undefined; problem: string };

const MAX_DEPTH = 512;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class TreeError extends Error {
  constructor(readonly at: number, what: string) {
    super(what);
  }
}

function lineCol(text: string, at: number): string {
  let line = 1;
  let last = -1;
  for (let k = text.indexOf('\n'); k !== -1 && k < at; k = text.indexOf('\n', k + 1)) {
    line++;
    last = k;
  }
  return `line ${line}, column ${at - last}`;
}

/** Plain JSON → a tree with spans, or a problem line (position only). */
export function parseJsonTree(text: string): { root: JsonNode; problem?: undefined } | { root?: undefined; problem: string } {
  if (typeof text !== 'string') return { problem: "The file isn't text." };
  try {
    return { root: parseTree(text) };
  } catch (e) {
    if (e instanceof TreeError) return { problem: `The file isn't plain JSON (${e.message} at ${lineCol(text, e.at)}).` };
    if (e instanceof SyntaxError) return { problem: "The file isn't plain JSON." };
    throw e;
  }
}

function parseTree(t: string): JsonNode {
  const n = t.length;
  let i = t.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (what: string): never => {
    throw new TreeError(i, what);
  };
  const ws = (): void => {
    while (i < n) {
      const c = t.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else break;
    }
  };
  const str = (): { value: string; raw: string; start: number } => {
    const s = i;
    if (t.charCodeAt(i) !== 34) fail('a string was expected');
    let j = i + 1;
    for (;;) {
      const q = t.indexOf('"', j);
      if (q < 0) {
        i = n;
        fail('a string is not closed');
      }
      let b = q - 1;
      while (b > s && t.charCodeAt(b) === 92) b--;
      const bs = q - 1 - b;
      j = q + 1;
      if (bs % 2 === 0) break;
    }
    const raw = t.slice(s, j);
    let value: string;
    if (raw.includes('\\')) {
      try {
        value = JSON.parse(raw) as string;
      } catch {
        return fail('a string has a bad escape');
      }
    } else {
      value = raw.slice(1, -1);
      for (let k = 0; k < value.length; k++) {
        if (value.charCodeAt(k) < 0x20) {
          i = s + 1 + k;
          fail('a control character in a string');
        }
      }
    }
    i = j;
    return { value, raw, start: s };
  };
  const value = (depth: number): JsonNode => {
    if (depth > MAX_DEPTH) fail('nested too deep');
    const start = i;
    const c = t.charCodeAt(i);
    if (c === 123) {
      i++;
      ws();
      const members: JsonMember[] = [];
      if (t.charCodeAt(i) === 125) {
        i++;
        return { type: 'object', start, end: i, members };
      }
      for (;;) {
        const k = str();
        ws();
        if (t.charCodeAt(i) !== 58) fail("':' was expected");
        i++;
        ws();
        members.push({ key: k.value, keyRaw: k.raw, keyStart: k.start, value: value(depth + 1) });
        ws();
        const d = t.charCodeAt(i);
        if (d === 44) {
          i++;
          ws();
          continue;
        }
        if (d === 125) {
          i++;
          return { type: 'object', start, end: i, members };
        }
        fail("',' or '}' was expected");
      }
    }
    if (c === 91) {
      i++;
      ws();
      const items: JsonNode[] = [];
      if (t.charCodeAt(i) === 93) {
        i++;
        return { type: 'array', start, end: i, items };
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        const d = t.charCodeAt(i);
        if (d === 44) {
          i++;
          ws();
          continue;
        }
        if (d === 93) {
          i++;
          return { type: 'array', start, end: i, items };
        }
        fail("',' or ']' was expected");
      }
    }
    if (c === 34) {
      const s = str();
      return { type: 'string', start, end: i, value: s.value, raw: s.raw };
    }
    for (const lit of ['true', 'false', 'null'] as const) {
      if (t.startsWith(lit, i)) {
        i += lit.length;
        return { type: 'literal', start, end: i, raw: lit };
      }
    }
    NUMBER.lastIndex = i;
    if (NUMBER.test(t) && NUMBER.lastIndex > i) {
      i = NUMBER.lastIndex;
      return { type: 'number', start, end: i, raw: t.slice(start, i) };
    }
    return fail('a value was expected');
  };
  ws();
  const root = value(0);
  ws();
  if (i !== n) fail('text after the end');
  return root;
}

// ------------------------------------------------------------------ locating

function describePath(path: JsonPath): string {
  let out = '';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : out ? `.${p}` : p;
  return out || '(root)';
}

/** The member a key names (the last one when repeated: that is the one `JSON.parse` keeps). */
function memberOf(node: JsonNode, key: string): JsonMember | undefined {
  if (node.type !== 'object') return undefined;
  for (let k = node.members.length - 1; k >= 0; k--) if (node.members[k].key === key) return node.members[k];
  return undefined;
}

interface Located {
  node: JsonNode;
  /** The container holding it, and its member (objects) or index (arrays). */
  parent?: JsonNode;
  member?: JsonMember;
  index?: number;
}

export function locate(root: JsonNode, path: JsonPath): Located | undefined {
  let cur: Located = { node: root };
  for (const p of path) {
    const node = cur.node;
    if (typeof p === 'number') {
      if (node.type !== 'array' || !Number.isInteger(p) || p < 0 || p >= node.items.length) return undefined;
      cur = { node: node.items[p], parent: node, index: p };
    } else {
      const m = memberOf(node, p);
      if (!m) return undefined;
      cur = { node: m.value, parent: node, member: m };
    }
  }
  return cur;
}

// ------------------------------------------------------------------ writing

/** The file's style: its first indented line, its line ends, its `": "`. */
export function detectStyle(text: string): JsonStyle {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /\n([ \t]+)[^ \t\r\n]/.exec(text);
  const indent = m ? m[1] : '';
  const c = /"(?:[^"\\\n]|\\.)*"([ \t]*):([ \t]*)/.exec(text);
  const colon = c ? `${c[1]}:${c[2]}` : indent ? ': ' : ':';
  return { indent, eol, colon };
}

const INLINE_MAX = 120;

/**
 * How to write a new value next to (or instead of) the one at `span`: on one line like it when it was on one line
 * and the new text stays short (`{"id": 1, "price": 2.50}` style kept), else the file's indentation from its line.
 */
function styleNear(text: string, span: Span, node: JsonNode): { style: JsonStyle; base: string } {
  const file = detectStyle(text);
  const base = lineIndent(text, span.start);
  const old = text.slice(span.start, span.end);
  if (!file.indent || /[\r\n]/.test(old)) return { style: file, base };
  const c = /"(?:[^"\\\n]|\\.)*"([ \t]*):([ \t]*)/.exec(old);
  const inline: JsonStyle = { indent: '', eol: file.eol, colon: c ? `${c[1]}:${c[2]}` : file.colon, comma: /,[ \t]/.test(old) || !/,/.test(old) ? ', ' : ',' };
  const one = writeJson(node, inline);
  return one.length <= INLINE_MAX ? { style: inline, base } : { style: file, base };
}

/** JSON text for a node at `base` indentation (its first line is not indented: it goes where the old value was). */
export function writeJson(node: JsonNode, style: JsonStyle, base = ''): string {
  switch (node.type) {
    case 'string':
    case 'number':
    case 'literal':
      return node.raw;
    case 'array': {
      if (!node.items.length) return '[]';
      if (!style.indent) return `[${node.items.map((x) => writeJson(x, style)).join(style.comma ?? ',')}]`;
      const inner = base + style.indent;
      return `[${style.eol}${node.items.map((x) => inner + writeJson(x, style, inner)).join(`,${style.eol}`)}${style.eol}${base}]`;
    }
    case 'object': {
      if (!node.members.length) return '{}';
      if (!style.indent) return `{${node.members.map((m) => `${m.keyRaw}${style.colon}${writeJson(m.value, style)}`).join(style.comma ?? ',')}}`;
      const inner = base + style.indent;
      return `{${style.eol}${node.members
        .map((m) => `${inner}${m.keyRaw}${style.colon}${writeJson(m.value, style, inner)}`)
        .join(`,${style.eol}`)}${style.eol}${base}}`;
    }
  }
}

/** The whitespace at the start of the line `at` is on. */
function lineIndent(text: string, at: number): string {
  let s = at;
  while (s > 0 && text[s - 1] !== '\n' && text[s - 1] !== '\r') s--;
  const m = /^[ \t]*/.exec(text.slice(s, at));
  return m ? m[0] : '';
}

/** A string literal for `value`, escaping non-ASCII when the old literal did (and had no raw non-ASCII). */
function stringLiteral(value: string, oldRaw?: string): string {
  let out = JSON.stringify(value);
  if (oldRaw && /\\u[0-9a-fA-F]{4}/.test(oldRaw) && !/[^\x00-\x7f]/.test(oldRaw)) {
    out = out.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  // U+2028 / U+2029 are valid in JSON but break some tools: always escaped
  return out.replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

export type Replacement = { string: string } | { json: string };

/** `text` with the value at `path` replaced; every other byte unchanged. */
export function spliceValue(text: string, path: JsonPath, replacement: Replacement): SpliceResult {
  const parsed = parseJsonTree(text);
  if (!parsed.root) return { problem: parsed.problem };
  const at = locate(parsed.root, path);
  if (!at) return { problem: `Not found in the file: ${describePath(path)}.` };
  const node = at.node;
  let next: string;
  if ('string' in replacement) {
    if (node.type !== 'string') return { problem: `Not a text value in the file: ${describePath(path)}.` };
    next = stringLiteral(replacement.string, node.raw);
  } else {
    const value = parseJsonTree(replacement.json);
    if (!value.root) return { problem: 'The new example is not JSON.' };
    const near = styleNear(text, node, value.root);
    next = writeJson(value.root, near.style, near.base);
  }
  return { text: text.slice(0, node.start) + next + text.slice(node.end) };
}

/**
 * `text` with a new entry right before the array element or object member at `path` (same separator and
 * indentation as the one it precedes). `entry.key` is required when the parent is an object.
 */
export function insertBefore(text: string, path: JsonPath, entry: { json: string; key?: string }): SpliceResult {
  const parsed = parseJsonTree(text);
  if (!parsed.root) return { problem: parsed.problem };
  if (!path.length) return { problem: 'Nothing to insert before: the path is empty.' };
  const at = locate(parsed.root, path);
  if (!at || !at.parent) return { problem: `Not found in the file: ${describePath(path)}.` };
  const value = parseJsonTree(entry.json);
  if (!value.root) return { problem: 'The new example is not JSON.' };
  const targetStart = at.member ? at.member.keyStart : at.node.start;
  const { style, base } = styleNear(text, { start: targetStart, end: at.node.end }, value.root);
  let insert: string;
  if (at.parent.type === 'object') {
    if (entry.key === undefined) return { problem: 'A name is needed for the new example.' };
    if (memberOf(at.parent, entry.key)) return { problem: `An example named "${entry.key.slice(0, 80)}" is already there.` };
    insert = `${stringLiteral(entry.key)}${style.colon}${writeJson(value.root, style, base)}`;
  } else {
    insert = writeJson(value.root, style, base);
  }
  // the whitespace before the element it precedes, repeated after the new one
  let w = targetStart;
  while (w > 0 && /[ \t\r\n]/.test(text[w - 1])) w--;
  const lead = text.slice(w, targetStart);
  return { text: `${text.slice(0, targetStart)}${insert},${lead}${text.slice(targetStart)}` };
}

// ------------------------------------------------------------------ Postman

function postmanUrlTemplate(url: JsonNode | undefined): string | undefined {
  if (!url) return undefined;
  let raw: string | undefined;
  if (url.type === 'string') raw = url.value;
  else if (url.type === 'object') {
    const r = memberOf(url, 'raw')?.value;
    if (r?.type === 'string') raw = r.value;
    else {
      const parts = (n: JsonNode | undefined, sep: string): string | undefined =>
        n?.type === 'string' ? n.value : n?.type === 'array' ? n.items.map((x) => (x.type === 'string' ? x.value : '')).join(sep) : undefined;
      const protocol = parts(memberOf(url, 'protocol')?.value, '');
      const host = parts(memberOf(url, 'host')?.value, '.');
      const port = parts(memberOf(url, 'port')?.value, '');
      const p = parts(memberOf(url, 'path')?.value, '/');
      raw = `${protocol ? `${protocol}://` : ''}${host ?? ''}${port ? `:${port}` : ''}${p !== undefined ? `/${p}` : ''}`;
    }
  }
  return raw?.replace(/[?#].*$/s, '').trim();
}

/**
 * The path of the example `exampleName` of the request `parsePostman` keys `endpointKey`
 * (`GET {{baseUrl}}/users/:id`, ` #2` for the second request with the same key), e.g.
 * `['item', 0, 'item', 3, 'response', 1]` (add `'body'` to splice its body). Undefined when not found.
 */
export function postmanExamplePath(text: string, endpointKey: string, exampleName: string): (string | number)[] | undefined {
  const parsed = parseJsonTree(text);
  if (!parsed.root) return undefined;
  const m = /^(.*?)(?: #(\d+))?$/s.exec(endpointKey)!;
  const base = m[1];
  let wanted = m[2] ? Number(m[2]) : 1;
  let found: (string | number)[] | undefined;
  const walk = (items: JsonNode | undefined, path: (string | number)[], depth: number): boolean => {
    if (items?.type !== 'array' || depth > 64) return false;
    for (let k = 0; k < items.items.length; k++) {
      const it = items.items[k];
      if (it.type !== 'object') continue;
      const req = memberOf(it, 'request')?.value;
      if (req) {
        let method = 'GET';
        let url: JsonNode | undefined = req;
        if (req.type === 'object') {
          const mm = memberOf(req, 'method')?.value;
          if (mm?.type === 'string' && mm.value.trim()) method = mm.value.trim().toUpperCase();
          url = memberOf(req, 'url')?.value;
        }
        if (`${method} ${postmanUrlTemplate(url) ?? ''}` === base && --wanted === 0) {
          const res = memberOf(it, 'response')?.value;
          if (res?.type !== 'array') return true;
          const idx = res.items.findIndex((r) => {
            const nm = r.type === 'object' ? memberOf(r, 'name')?.value : undefined;
            return nm?.type === 'string' && nm.value === exampleName;
          });
          if (idx >= 0) found = [...path, k, 'response', idx];
          return true;
        }
        continue;
      }
      if (walk(memberOf(it, 'item')?.value, [...path, k, 'item'], depth + 1)) return true;
    }
    return false;
  };
  walk(memberOf(parsed.root, 'item')?.value, ['item'], 0);
  return found;
}

// ------------------------------------------------------------------ merge

/** Nodes of `ex` at `segs` paired with the node of `s` at the same place (the same index in arrays when it exists). */
function pairs(ex: JsonNode, s: JsonNode | undefined, segs: readonly DriftPathSegment[], out: [JsonNode, JsonNode | undefined][]): void {
  if (!segs.length) {
    out.push([ex, s]);
    return;
  }
  const [head, ...rest] = segs;
  if (Array.isArray(head)) {
    if (ex.type !== 'array') return;
    const sItems = s?.type === 'array' ? s.items : [];
    ex.items.forEach((x, i) => pairs(x, sItems[i] ?? sItems[0], rest, out));
    return;
  }
  const m = memberOf(ex, head);
  if (!m) return;
  pairs(m.value, s ? memberOf(s, head)?.value : undefined, rest, out);
}

/** The first node of `node` at `segs` (any element of arrays). */
function firstAt(node: JsonNode | undefined, segs: readonly DriftPathSegment[]): JsonNode | undefined {
  if (!node) return undefined;
  if (!segs.length) return node;
  const [head, ...rest] = segs;
  if (Array.isArray(head)) {
    if (node.type !== 'array') return undefined;
    for (const x of node.items) {
      const f = firstAt(x, rest);
      if (f) return f;
    }
    return undefined;
  }
  return firstAt(memberOf(node, head)?.value, rest);
}

function memberFor(key: string, value: JsonNode): JsonMember {
  return { key, keyRaw: stringLiteral(key), keyStart: -1, value };
}

/**
 * Merge mode (§23.4): the example body with the drift changes applied, values from the newest answer (sanitised as
 * §23.1). An example or answer that isn't JSON → the example unchanged.
 */
export function mergeExample(exampleBody: string, newestSampleBody: string, changes: readonly DriftChange[]): string {
  const ex = parseJsonTree(exampleBody);
  if (!ex.root) return exampleBody;
  const cleaned = new TrafficSanitiser(true).jsonText(newestSampleBody, false);
  const sample = cleaned === undefined ? undefined : parseJsonTree(cleaned).root;
  if (!sample) return exampleBody;
  let root = ex.root;
  for (const c of changes) {
    const segs = parseDriftPath(c.path);
    if (c.kind === 'added' || c.kind === 'removed') {
      const key = segs[segs.length - 1];
      if (key === undefined || Array.isArray(key)) continue;
      const parentSegs = segs.slice(0, -1);
      const found: [JsonNode, JsonNode | undefined][] = [];
      pairs(root, sample, parentSegs, found);
      const fallback = c.kind === 'added' ? firstAt(sample, segs) : undefined;
      for (const [node, s] of found) {
        if (node.type !== 'object') continue;
        if (c.kind === 'removed') {
          node.members = node.members.filter((m) => m.key !== key);
          continue;
        }
        if (memberOf(node, key)) continue;
        const v = (s ? memberOf(s, key)?.value : undefined) ?? fallback;
        if (v) node.members.push(memberFor(key, v));
      }
    } else if (c.kind === 'type') {
      const found: [JsonNode, JsonNode | undefined][] = [];
      pairs(root, sample, segs, found);
      const fallback = firstAt(sample, segs);
      for (const [node, s] of found) {
        if (node.type === 'literal' && node.raw === 'null') continue;
        let next: JsonNode | undefined;
        if (c.from === 'int' && c.to === 'double' && node.type === 'number') {
          next = /[.eE]/.test(node.raw) ? node : { ...node, raw: `${node.raw}.0` };
        } else next = s ?? fallback;
        if (!next || next === node) continue;
        if (!segs.length) {
          root = next;
          continue;
        }
        replaceIn(root, segs, node, next);
      }
    }
  }
  return writeJson(root, detectStyle(exampleBody));
}

/** Replaces `old` (found at `segs`) by `next` inside `root`. */
function replaceIn(root: JsonNode, segs: readonly DriftPathSegment[], old: JsonNode, next: JsonNode): void {
  const visit = (node: JsonNode, rest: readonly DriftPathSegment[]): void => {
    if (rest.length === 1) {
      const head = rest[0];
      if (Array.isArray(head)) {
        if (node.type === 'array') node.items = node.items.map((x) => (x === old ? next : x));
      } else if (node.type === 'object') {
        for (const m of node.members) if (m.key === head && m.value === old) m.value = next;
      }
      return;
    }
    const [head, ...tail] = rest;
    if (Array.isArray(head)) {
      if (node.type === 'array') for (const x of node.items) visit(x, tail);
    } else {
      const m = memberOf(node, head);
      if (m) visit(m.value, tail);
    }
  };
  visit(root, segs);
}
