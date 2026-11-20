/**
 * Bruno collections (CONTRACTS §24.4). Pure: no vscode, no fs, no network — the host walks the folder (realpath-checked,
 * no symlinks, `brunoLimits`) and passes the files it read.
 *
 * Format (usebruno/bruno `packages/bruno-lang/v2`: `src/bruToJson.js`, `src/envToJson.js`,
 * `src/example/bruToJson.js`, `src/example/response/bruToJson.js`, `src/example/jsonToBru.js`; fixtures
 * `tests/fixtures/request.bru`, `tests/examples/fixtures/bru/*.bru`):
 * - a collection is a folder with `bruno.json`; every request is one `.bru` file; a folder may have `folder.bru`
 *   (`meta { name, seq }`, `auth { mode }`); the root may have `collection.bru`; environments are
 *   `environments/<name>.bru` with `vars { … }` and `vars:secret [ … ]`.
 * - a `.bru` file is a list of top-level blocks `<name> {` … a line that is exactly `}` (or `<name> [` … `]`).
 *   Dictionary blocks hold `key: value` lines (`~key` = disabled, `"quoted key"`, `'''` multi-line values); text
 *   blocks (`body:json`, `body:text`, `body:xml`) hold text indented by two spaces.
 * - `example { name: …, request: { url, method, mode, params:query: {…}, headers: {…}, body:json: {…} },
 *   response: { headers: {…}, status: { code, text }, body: { type, content: ''' … ''' } } }`, nested blocks closed by
 *   `}` at their own indentation.
 *
 * This reader is hand-written and bounded (linear in the file, fixed nesting). It reads `meta`, the method block
 * (`get|post|put|patch|delete|options|head|connect|trace { url, body, auth }`, `http { method, url }`), `params:path`,
 * `params:query`, `headers`, `body:json|text|xml|form-urlencoded` and `example`. Scripts, tests, docs, `auth:*`
 * blocks (credentials), `vars:secret` and `.env` files are never read; of an `auth` block only `mode` is.
 */
import { mergeCollectionVars } from './environment';
import { addProblem, quoteFileText } from './ref';
import { COLLECTION_LIMITS } from './types';
import {
  expandValues,
  MAX_ENVIRONMENTS,
  normaliseTemplate,
  parseSourceRequests,
  type SourceBody,
  type SourceExample,
  type SourceHeader,
  type SourceOptions,
  type SourceParsed,
  type SourceRequest,
} from './viaPostman';

/** What the host's folder walk must enforce (CONTRACTS §24.4); the parser checks them again. */
export const brunoLimits = {
  /** Files read from one collection folder (every kind, `.bru` and `bruno.json`). */
  files: 2000,
  /** Folder depth below the folder holding `bruno.json`. */
  depth: 32,
  /** Total bytes of the files read. */
  totalBytes: 20 * 1024 * 1024,
} as const;

export interface BrunoFile {
  /** Path as the host found it (`/` or `\` separated); the folder holding `bruno.json` is the collection root. */
  path: string;
  text: string;
}

const METHOD_BLOCKS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace']);
const METHOD = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const HEADER = /^([A-Za-z][\w:.-]*)[ \t]*([{[])[ \t]*$/;
const STRUCT_KEY = /^([A-Za-z~][\w-]*(?::[A-Za-z][\w-]*)*)[ \t]*:[ \t]?(.*)$/;
const MAX_ENTRIES = 1000;

// ------------------------------------------------------------------ the .bru reader

interface Block {
  name: string;
  /** Header line index; content is `start + 1 … end - 1`. */
  start: number;
  end: number;
}

interface Entry {
  key: string;
  enabled: boolean;
  value: string;
  indent: number;
  line: number;
  /** For `key: {` — the content lines `[start, end)`. */
  block?: [number, number];
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

/** Removes up to `n` leading spaces / tabs. */
function outdent(line: string, n: number): string {
  let i = 0;
  while (i < n && i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

interface Reader {
  lines: string[];
  label: string;
  problems: string[];
}

/** Top-level blocks. An unclosed block ends the file with a problem line. */
function topBlocks(r: Reader): Block[] {
  const blocks: Block[] = [];
  const { lines } = r;
  let stray = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const m = indentOf(line) === 0 ? HEADER.exec(line) : null;
    if (!m) {
      stray = true;
      continue;
    }
    const closer = m[2] === '{' ? /^\}[ \t]*$/ : /^[ \t]*\][ \t]*$/;
    let j = i + 1;
    while (j < lines.length && !closer.test(lines[j])) j++;
    if (j >= lines.length) {
      addProblem(r.problems, `${r.label}: block "${quoteFileText(m[1], 40)}" at line ${i + 1} is not closed (rest of the file ignored)`);
      break;
    }
    blocks.push({ name: m[1], start: i, end: j });
    i = j;
  }
  if (stray) addProblem(r.problems, `${r.label}: text outside a block (ignored)`);
  return blocks;
}

/** A `'''` multi-line value starting on `line` (the key line). Returns the value and the last line used. */
function multiline(r: Reader, rest: string, keyLine: number, end: number): { value: string; last: number } {
  const after = rest.slice(3);
  const close = after.indexOf("'''");
  if (close >= 0) return { value: after.slice(0, close), last: keyLine };
  const n = indentOf(r.lines[keyLine]) + 2;
  const out: string[] = [];
  for (let j = keyLine + 1; j < end; j++) {
    if (r.lines[j].trim().startsWith("'''")) return { value: out.join('\n'), last: j };
    out.push(outdent(r.lines[j], n));
  }
  addProblem(r.problems, `${r.label}: multi-line value at line ${keyLine + 1} is not closed`);
  return { value: out.join('\n'), last: end - 1 };
}

/**
 * `key: value` lines of a dictionary block (Bruno's `pairlist`): `~` disables, `"…"` quotes a key, `@annotations`
 * are skipped, a key without `:` is ignored. Keys are kept as data (the caller stores them in Maps / arrays).
 */
function readDict(r: Reader, start: number, end: number): Entry[] {
  const out: Entry[] = [];
  for (let i = start; i < end && out.length < MAX_ENTRIES; i++) {
    const raw = r.lines[i];
    let s = raw.trimStart();
    if (s === '' || s.startsWith('@')) continue;
    let enabled = true;
    if (s.startsWith('~')) {
      enabled = false;
      s = s.slice(1);
    }
    let key: string;
    let rest: string;
    if (s.startsWith('"')) {
      let k = 1;
      let name = '';
      while (k < s.length && s[k] !== '"') {
        if (s[k] === '\\' && s[k + 1] === '"') {
          name += '"';
          k += 2;
          continue;
        }
        name += s[k];
        k++;
      }
      if (k >= s.length) continue;
      key = name;
      rest = s.slice(k + 1).trimStart();
    } else {
      const m = /^([^\s:]+)[ \t]*/.exec(s);
      if (!m) continue;
      key = m[1];
      rest = s.slice(m[0].length);
    }
    if (!rest.startsWith(':')) continue;
    let value = rest.slice(1).trim();
    if (value.startsWith("'''")) {
      const ml = multiline(r, value, i, end);
      value = ml.value;
      i = ml.last;
    } else if (value === '[') {
      while (i + 1 < end && !/^[ \t]*\][ \t]*$/.test(r.lines[i + 1])) i++;
      i++;
      continue;
    }
    out.push({ key, enabled, value, indent: indentOf(raw), line: i });
  }
  return out;
}

/**
 * Entries of a structured level (inside `example`): `key: value`, `key: '''…'''`, and `key: {` … `}` closed at the
 * key's own indentation. Compound keys (`params:query`, `body:json`) are one key. An unclosed block stops the level.
 */
function readEntries(r: Reader, start: number, end: number): Entry[] {
  const out: Entry[] = [];
  for (let i = start; i < end && out.length < MAX_ENTRIES; i++) {
    const raw = r.lines[i];
    const s = raw.trim();
    if (s === '') continue;
    const m = STRUCT_KEY.exec(s);
    if (!m) continue;
    const indent = indentOf(raw);
    const enabled = !m[1].startsWith('~');
    const key = enabled ? m[1] : m[1].slice(1);
    const value = m[2].trim();
    if (value === '{') {
      let j = i + 1;
      while (j < end && !(r.lines[j].trim() === '}' && indentOf(r.lines[j]) === indent)) j++;
      if (j >= end) {
        addProblem(r.problems, `${r.label}: "${quoteFileText(key, 40)}" at line ${i + 1} is not closed`);
        break;
      }
      out.push({ key, enabled, value: '', indent, line: i, block: [i + 1, j] });
      i = j;
    } else if (value.startsWith("'''")) {
      const ml = multiline(r, value, i, end);
      out.push({ key, enabled, value: ml.value, indent, line: i });
      i = ml.last;
    } else {
      out.push({ key, enabled, value, indent, line: i });
    }
  }
  return out;
}

/** A text block's lines, outdented by `n`, leading empty lines dropped (Bruno's `"{" nl* textblock`). */
function text(r: Reader, start: number, end: number, n: number): string {
  let s = start;
  while (s < end && r.lines[s] === '') s++;
  const out: string[] = [];
  for (let i = s; i < end; i++) out.push(outdent(r.lines[i], n));
  return out.join('\n');
}

function first(entries: Entry[], key: string): Entry | undefined {
  return entries.find((e) => e.key === key);
}

function dictValue(entries: Entry[], key: string): string | undefined {
  const e = entries.find((x) => x.key === key && x.enabled);
  return e?.value;
}

// ------------------------------------------------------------------ request files

interface ParsedRequest {
  name: string;
  seq: number;
  req?: SourceRequest;
  /** gRPC / WebSocket: not HTTP. */
  other?: true;
}

function authMode(mode: string | undefined): 'none' | 'declared' | 'inherit' | undefined {
  if (mode === undefined || mode === '') return undefined;
  if (mode === 'inherit') return 'inherit';
  return mode === 'none' ? 'none' : 'declared';
}

function seqOf(v: string | undefined): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function formEntries(entries: Entry[]): { key: string; value: string }[] {
  return entries.filter((e) => e.enabled && e.key !== '').map((e) => ({ key: e.key, value: e.value }));
}

function language(type: string | undefined): string | undefined {
  const t = type?.trim().toLowerCase();
  return t === 'json' || t === 'xml' || t === 'html' || t === 'text' ? t : undefined;
}

function statusOf(entries: Entry[] | undefined): unknown {
  if (!entries) return 200;
  const code = dictValue(entries, 'code')?.trim();
  const textValue = dictValue(entries, 'text')?.trim();
  if (code !== undefined && /^\d{3}$/.test(code)) return Number(code);
  // Postman imports into older Bruno versions swapped the two (bruToJson-swapped-status.bru).
  if (textValue !== undefined && /^\d{3}$/.test(textValue)) return Number(textValue);
  return code ?? 200;
}

function readExample(r: Reader, block: Block, index: number): SourceExample {
  const top = readEntries(r, block.start + 1, block.end);
  const name = first(top, 'name')?.value.trim() || `Example ${index + 1}`;
  const example: SourceExample = { name, status: 200, headers: [], body: '' };

  const request = first(top, 'request');
  if (request?.block) {
    const req = readEntries(r, request.block[0], request.block[1]);
    const url = first(req, 'url')?.value;
    if (url !== undefined && url.length <= COLLECTION_LIMITS.urlChars) example.requestUrl = normaliseTemplate(url, false);
    const mode = first(req, 'mode')?.value.trim();
    const json = first(req, 'body:json');
    const form = first(req, 'body:form-urlencoded');
    if (json?.block && (mode === undefined || mode === 'json')) {
      example.requestBody = { kind: 'raw', text: text(r, json.block[0], json.block[1], json.indent + 2) };
    } else if (form?.block && (mode === undefined || mode === 'formUrlEncoded')) {
      example.requestBody = { kind: 'form', entries: formEntries(readDict(r, form.block[0], form.block[1])) };
    }
  }

  const response = first(top, 'response');
  if (response?.block) {
    const res = readEntries(r, response.block[0], response.block[1]);
    const status = first(res, 'status');
    example.status = statusOf(status?.block ? readDict(r, status.block[0], status.block[1]) : undefined);
    const headers = first(res, 'headers');
    if (headers?.block) {
      example.headers = readDict(r, headers.block[0], headers.block[1])
        .filter((e) => e.enabled)
        .map((e): SourceHeader => ({ name: e.key, value: e.value }));
    }
    const body = first(res, 'body');
    if (body?.block) {
      const fields = readEntries(r, body.block[0], body.block[1]);
      example.body = first(fields, 'content')?.value ?? '';
      const lang = language(first(fields, 'type')?.value);
      if (lang) example.language = lang;
    }
  }
  return example;
}

function readRequest(r: Reader, fileName: string, problems: string[]): ParsedRequest | undefined {
  const blocks = topBlocks(r);
  const byName = (n: string): Block | undefined => blocks.find((b) => b.name === n);
  const meta = byName('meta');
  const metaDict = meta ? readDict(r, meta.start + 1, meta.end) : [];
  const name = dictValue(metaDict, 'name')?.trim() || fileName.replace(/\.bru$/i, '');
  const seq = seqOf(dictValue(metaDict, 'seq'));

  const methodBlock = blocks.find((b) => METHOD_BLOCKS.has(b.name) || b.name === 'http');
  if (!methodBlock) {
    if (byName('grpc') || byName('ws')) return { name, seq, other: true };
    addProblem(problems, `${r.label}: no HTTP method block (skipped)`);
    return undefined;
  }
  const http = readDict(r, methodBlock.start + 1, methodBlock.end);
  const rawMethod = methodBlock.name === 'http' ? (dictValue(http, 'method')?.trim() ?? '') : methodBlock.name;
  if (!METHOD.test(rawMethod)) {
    addProblem(problems, `${r.label}: invalid method (skipped)`);
    return undefined;
  }
  const method = rawMethod.toUpperCase();
  const rawUrl = dictValue(http, 'url')?.trim() ?? '';
  const url = rawUrl.length > COLLECTION_LIMITS.urlChars ? rawUrl : normaliseTemplate(rawUrl, false);

  const queryBlock = byName('params:query') ?? byName('query');
  const query = queryBlock
    ? readDict(r, queryBlock.start + 1, queryBlock.end).map((e) => ({ key: e.key, value: e.value, ...(e.enabled ? {} : { disabled: true }) }))
    : [];

  const bodyMode = dictValue(http, 'body')?.trim();
  let body: SourceBody | undefined;
  const json = byName('body:json');
  const form = byName('body:form-urlencoded');
  if (json && (bodyMode === undefined || bodyMode === 'json')) {
    body = { kind: 'raw', text: text(r, json.start + 1, json.end, 2) };
  } else if (form && (bodyMode === undefined || bodyMode === 'formUrlEncoded')) {
    body = { kind: 'form', entries: formEntries(readDict(r, form.start + 1, form.end)) };
  }

  const examples: SourceExample[] = [];
  const exampleBlocks = blocks.filter((b) => b.name === 'example');
  if (exampleBlocks.length > COLLECTION_LIMITS.examplesPerEndpoint) {
    addProblem(
      problems,
      `Request "${quoteFileText(name)}": has more than ${COLLECTION_LIMITS.examplesPerEndpoint} examples; only the first ${COLLECTION_LIMITS.examplesPerEndpoint} were kept`,
    );
  }
  for (const [i, b] of exampleBlocks.slice(0, COLLECTION_LIMITS.examplesPerEndpoint).entries()) {
    examples.push(readExample(r, b, i));
  }

  const mode = authMode(dictValue(http, 'auth')?.trim());
  return {
    name,
    seq,
    req: {
      name,
      method,
      url,
      ...(query.length > 0 ? { query } : {}),
      folder: [],
      examples,
      ...(body ? { body } : {}),
      // `inherit` (or no auth line) is settled by the caller: folder.bru, then collection.bru
      ...(mode === 'none' || mode === 'declared' ? { auth: mode } : {}),
    },
  };
}

/** `folder.bru` / `collection.bru`: `meta { name, seq }`, `auth { mode }`, `vars:pre-request` (collection.bru only). */
function readFolderFile(r: Reader): { name?: string; seq: number; auth?: 'none' | 'declared' | 'inherit'; vars: Entry[] } {
  const blocks = topBlocks(r);
  const meta = blocks.find((b) => b.name === 'meta');
  const metaDict = meta ? readDict(r, meta.start + 1, meta.end) : [];
  const auth = blocks.find((b) => b.name === 'auth');
  const vars = blocks.find((b) => b.name === 'vars:pre-request');
  return {
    name: dictValue(metaDict, 'name')?.trim() || undefined,
    seq: seqOf(dictValue(metaDict, 'seq')),
    auth: auth ? authMode(dictValue(readDict(r, auth.start + 1, auth.end), 'mode')?.trim()) : undefined,
    vars: vars ? readDict(r, vars.start + 1, vars.end) : [],
  };
}

/** `environments/<name>.bru`: `vars { … }` only (never `vars:secret`). */
function readEnvFile(r: Reader): Map<string, string> {
  const values = new Map<string, string>();
  for (const b of topBlocks(r)) {
    if (b.name !== 'vars') continue;
    for (const e of readDict(r, b.start + 1, b.end)) {
      // REVIEW-16 #2: a value longer than a URL can't end up in one; it would only cost time to expand
      if (e.enabled && e.key && !values.has(e.key) && e.value.length <= COLLECTION_LIMITS.urlChars) values.set(e.key, e.value);
    }
  }
  return values;
}

// ------------------------------------------------------------------ the collection

interface DirNode {
  /** Folder name (folder.bru `meta.name`, else the directory name). */
  name: string;
  seq: number;
  auth?: 'none' | 'declared' | 'inherit';
  dirs: Map<string, DirNode>;
  requests: { seq: number; file: string; parsed: ParsedRequest }[];
}

function newDir(name: string): DirNode {
  return { name, seq: Number.POSITIVE_INFINITY, dirs: new Map(), requests: [] };
}

function reader(text: string, label: string, problems: string[]): Reader {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return { lines: src.split(/\r?\n/), label, problems };
}

function empty(name: string, problems: string[], environments: string[] = []): SourceParsed {
  return { format: 'bruno', name, endpoints: [], variables: [], problems, environments };
}

/**
 * CONTRACTS §24.4: a Bruno collection from the files the host read. The folder holding `bruno.json` (the shallowest
 * one) is the root; files outside it, in ignored or hidden folders, and anything but `.bru` / `bruno.json` are not
 * read. `format: 'bruno'`. Never throws.
 */
export function parseBruno(files: readonly BrunoFile[], opts: SourceOptions = {}): SourceParsed {
  const problems: string[] = [];
  try {
    return parse(files, opts, problems);
  } catch {
    addProblem(problems, 'Bruno collection could not be read');
    return empty('Bruno', problems);
  }
}

function parse(files: readonly BrunoFile[], opts: SourceOptions, problems: string[]): SourceParsed {
  if (!Array.isArray(files)) {
    addProblem(problems, 'Bruno collection: no files');
    return empty('Bruno', problems);
  }
  let list = files.filter((f): f is BrunoFile => !!f && typeof f.path === 'string' && typeof f.text === 'string');
  if (list.length > brunoLimits.files) {
    addProblem(problems, `Bruno collection has more than ${brunoLimits.files} files; the rest were not read`);
    list = list.slice(0, brunoLimits.files);
  }
  const norm = list.map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^(\.\/)+/, ''), text: f.text }));

  // root = the folder of the shallowest bruno.json
  let rootFile: { path: string; text: string } | undefined;
  for (const f of norm) {
    if (!/(^|\/)bruno\.json$/.test(f.path)) continue;
    if (!rootFile || f.path.split('/').length < rootFile.path.split('/').length) rootFile = f;
  }
  if (!rootFile) {
    addProblem(problems, 'Bruno collection: no bruno.json');
    return empty('Bruno', problems);
  }
  const root = rootFile.path.slice(0, rootFile.path.length - 'bruno.json'.length);
  let name = root.replace(/\/$/, '').split('/').pop() || 'Bruno';
  const ignore = new Set<string>(['node_modules', '.git']);
  try {
    const cfg: unknown = JSON.parse(rootFile.text);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      const n = Object.getOwnPropertyDescriptor(cfg, 'name')?.value;
      if (typeof n === 'string' && n.trim() !== '') name = n.trim();
      const ig = Object.getOwnPropertyDescriptor(cfg, 'ignore')?.value;
      if (Array.isArray(ig)) for (const s of ig.slice(0, 100)) if (typeof s === 'string' && s) ignore.add(s.replace(/\/+$/, ''));
    }
  } catch {
    addProblem(problems, 'bruno.json is not valid JSON (folder name used)');
  }

  const top = newDir(name);
  const envFiles = new Map<string, Map<string, string>>();
  let collectionVars: Entry[] = [];
  let collectionAuth: 'none' | 'declared' | 'inherit' | undefined;
  let total = 0;
  let other = 0;
  let deepWarned = false;

  for (const f of norm) {
    if (!f.path.startsWith(root) || f === rootFile) continue;
    const rel = f.path.slice(root.length);
    if (!rel.toLowerCase().endsWith('.bru')) continue; // .env, scripts, anything else: never read
    const segs = rel.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || ignore.has(s))) continue;
    if (segs.length - 1 > brunoLimits.depth) {
      if (!deepWarned) addProblem(problems, `Bruno folders deeper than ${brunoLimits.depth} levels were not read`);
      deepWarned = true;
      continue;
    }
    total += f.text.length;
    if (total > brunoLimits.totalBytes) {
      addProblem(problems, `Bruno collection is larger than ${brunoLimits.totalBytes / (1024 * 1024)} MB; the rest was not read`);
      break;
    }
    const label = quoteFileText(rel);
    const r = reader(f.text, label, problems);
    const fileName = segs[segs.length - 1];

    if (segs.length === 2 && segs[0] === 'environments') {
      envFiles.set(fileName.replace(/\.bru$/i, ''), readEnvFile(r));
      continue;
    }
    if (segs.length === 1 && fileName === 'collection.bru') {
      const c = readFolderFile(r);
      collectionVars = c.vars;
      collectionAuth = c.auth;
      continue;
    }
    // the folder node of this file
    let node = top;
    for (const s of segs.slice(0, -1)) {
      let next = node.dirs.get(s);
      if (!next) {
        next = newDir(s);
        node.dirs.set(s, next);
      }
      node = next;
    }
    if (fileName === 'folder.bru') {
      const ff = readFolderFile(r);
      if (ff.name) node.name = ff.name;
      node.seq = ff.seq;
      node.auth = ff.auth;
      continue;
    }
    const parsed = readRequest(r, fileName, problems);
    if (!parsed) continue;
    if (parsed.other) {
      other++;
      continue;
    }
    node.requests.push({ seq: parsed.seq, file: fileName, parsed });
  }
  if (other > 0) addProblem(problems, `${other} gRPC or WebSocket requests skipped (HTTP only)`);

  // requests in Bruno's order: by seq inside each folder (folders by their folder.bru seq), then by name
  const requests: SourceRequest[] = [];
  let truncated = false;
  const walk = (node: DirNode, folder: string[], inherited: 'none' | 'declared' | undefined): void => {
    type Item = { seq: number; key: string; run: () => void };
    const items: Item[] = [];
    for (const rq of node.requests) {
      items.push({
        seq: rq.seq,
        key: rq.file,
        run: () => {
          if (requests.length > COLLECTION_LIMITS.endpoints) {
            truncated = true;
            return;
          }
          const req = rq.parsed.req!;
          const auth = req.auth ?? inherited;
          requests.push({ ...req, folder, ...(auth ? { auth } : {}) });
        },
      });
    }
    for (const [dirName, d] of node.dirs) {
      const auth = d.auth === 'inherit' || d.auth === undefined ? inherited : d.auth;
      items.push({ seq: d.seq, key: dirName, run: () => walk(d, [...folder, d.name], auth) });
    }
    items.sort((a, b) => (a.seq === b.seq ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.seq < b.seq ? -1 : 1));
    for (const it of items) it.run();
  };
  walk(top, [], collectionAuth === 'inherit' ? undefined : collectionAuth);

  // variables: link → environments/<name>.bru → collection.bru `vars:pre-request` (§21.6); values may use others
  const environments = [...envFiles.keys()].slice(0, MAX_ENVIRONMENTS).map((n) => n.slice(0, 100));
  let chosen: Map<string, string> | undefined;
  if (opts.environment !== undefined) {
    chosen = envFiles.get(opts.environment);
    if (!chosen) addProblem(problems, `Environment "${quoteFileText(opts.environment)}" is not in the collection`);
  }
  const raw = new Map<string, string>();
  for (const e of collectionVars) if (e.enabled && e.key && !raw.has(e.key) && e.value.length <= COLLECTION_LIMITS.urlChars) raw.set(e.key, e.value);
  for (const [k, v] of chosen ?? []) raw.set(k, v);
  const expanded = expandValues(raw, false);
  const env = new Map<string, string>();
  const coll = new Map<string, string>();
  for (const [k, v] of expanded) (chosen?.has(k) ? env : coll).set(k, v);
  const vars = mergeCollectionVars(opts.variables ?? {}, env, coll);

  const parsed = parseSourceRequests('bruno', name, requests, vars, problems, truncated);
  return { ...parsed, environments, envValues: env };
}
