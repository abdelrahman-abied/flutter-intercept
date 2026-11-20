/**
 * Postman Collection v2.0 / v2.1 parser (CONTRACTS §21.1, §21.2). Pure: no vscode, no fs, no network.
 */
import { redactUrl } from '../agent/redact';
import { REQUEST_BODY_BYTES } from './bodyMatch';
import {
  COLLECTION_LIMITS,
  type CollectionVars,
  type MockEndpoint,
  type MockExample,
  type ParsedCollection,
  type PathSegment,
  type ParsePostman,
  type PostmanCollectionVariables,
  type VariableSource,
} from './types';

type Obj = Record<string, unknown>;

/** REVIEW-15 #2c: maximum sum of example body bytes across one collection (not in types.ts). */
const COLLECTION_BODY_BYTES = 64 * 1024 * 1024;
const MAX_PROBLEM_CHARS = 300;
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>`]+/gi;

const DROPPED_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'date',
  'te',
  'trailer',
  'upgrade',
]);

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(obj: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key)
    ? Object.getOwnPropertyDescriptor(obj, key)?.value
    : undefined;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Sanitises file text quoted inside a problem line (REVIEW-15 #7): no URL credentials, no bidi/control chars, bounded length. */
function quoteFileText(raw: string, max = 80): string {
  const cleaned = raw
    .replace(URL_IN_TEXT, (u) => redactUrl(u))
    .replace(BIDI_CONTROLS, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function pushProblem(problems: string[], msg: string): void {
  const cleaned = msg
    .replace(URL_IN_TEXT, (u) => redactUrl(u))
    .replace(BIDI_CONTROLS, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();
  problems.push(cleaned.length > MAX_PROBLEM_CHARS ? `${cleaned.slice(0, MAX_PROBLEM_CHARS - 1)}…` : cleaned);
}

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function utf8ByteLength(s: string): number {
  if (s.length === 0) return 0;
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
  return new TextEncoder().encode(s).byteLength;
}

function isDroppedHeader(lowerName: string): boolean {
  return DROPPED_HEADERS.has(lowerName) || lowerName.startsWith('proxy-') || lowerName.startsWith(':');
}

// ------------------------------------------------------------------ walk & body budgets (REVIEW-15 #2)

interface WalkBudget {
  visited: number;
  exceeded: boolean;
}

interface BodyBudget {
  bytes: number;
  exceeded: boolean;
}

function touchNode(budget: WalkBudget, problems: string[]): boolean {
  if (budget.exceeded) return false;
  budget.visited++;
  if (budget.visited > COLLECTION_LIMITS.walkNodes) {
    budget.exceeded = true;
    pushProblem(problems, `Collection exceeds ${COLLECTION_LIMITS.walkNodes} nodes; the rest were skipped.`);
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ template variables

interface Token {
  kind: 'text' | 'var';
  value: string;
}

/** Linear-time tokeniser for `{{name}}` placeholders (no regex backtracking on hostile input). */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < input.length) {
    const open = input.indexOf('{{', pos);
    if (open === -1) {
      tokens.push({ kind: 'text', value: input.slice(pos) });
      break;
    }
    const close = input.indexOf('}}', open + 2);
    if (close === -1) {
      tokens.push({ kind: 'text', value: input.slice(pos) });
      break;
    }
    const inner = input.slice(open + 2, close);
    const nested = inner.indexOf('{{');
    if (nested !== -1) {
      tokens.push({ kind: 'text', value: input.slice(pos, open + 2 + nested) });
      pos = open + 2 + nested;
      continue;
    }
    if (open > pos) {
      tokens.push({ kind: 'text', value: input.slice(pos, open) });
    }
    if (inner.length === 0) {
      tokens.push({ kind: 'text', value: '{{}}' });
    } else {
      tokens.push({ kind: 'var', value: inner });
    }
    pos = close + 2;
  }
  return tokens;
}

function hasTemplateVar(s: string): boolean {
  return tokenize(s).some((t) => t.kind === 'var');
}

function resolveTemplate(
  input: string,
  vars: CollectionVars,
  usedVars: Map<string, VariableSource | undefined>,
): { text: string; unresolved: string[]; hasDynamic: boolean } {
  const tokens = tokenize(input);
  let text = '';
  const unresolved: string[] = [];
  let hasDynamic = false;

  for (const tok of tokens) {
    if (tok.kind === 'text') {
      text += tok.value;
      continue;
    }
    const name = tok.value;
    if (name.startsWith('$')) {
      hasDynamic = true;
      if (!unresolved.includes(name)) unresolved.push(name);
      text += `{{${name}}}`;
      continue;
    }
    const val = vars.values.get(name);
    const hasValue = typeof val === 'string' && val !== '';
    if (!usedVars.has(name)) {
      usedVars.set(name, hasValue ? vars.sources.get(name) : undefined);
    }
    if (hasValue) {
      text += val;
    } else {
      if (!unresolved.includes(name)) unresolved.push(name);
      text += `{{${name}}}`;
    }
  }
  return { text, unresolved, hasDynamic };
}

// ------------------------------------------------------------------ URL parsing

interface RawUrlParts {
  scheme?: string;
  host?: string;
  port?: string;
  pathSegments: string[];
  queryMap: Map<string, string>;
}

function stripQueryAndFragment(url: string): string {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  let cut = url.length;
  if (q !== -1 && q < cut) cut = q;
  if (h !== -1 && h < cut) cut = h;
  return url.slice(0, cut);
}

function safeDecodeQueryPart(s: string): string {
  const plusAsSpace = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
}

function parseQueryString(qs: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? '' : part.slice(eq + 1);
    const key = safeDecodeQueryPart(rawKey);
    if (!key) continue;
    out.set(key, safeDecodeQueryPart(rawVal));
  }
  return out;
}

/** Splits `authority` (without scheme or path) into host and optional port, keeping `{{...}}` and `[...]` intact. */
function splitAuthority(authority: string): { host?: string; port?: string } {
  if (!authority) return {};
  // Strip userinfo (`user:pass@`) outside `{{...}}`.
  let clean = authority;
  let depth = 0;
  let atPos = -1;
  for (let i = 0; i < clean.length; i++) {
    if (clean.startsWith('{{', i)) {
      depth++;
      i++;
    } else if (clean.startsWith('}}', i) && depth > 0) {
      depth--;
      i++;
    } else if (clean[i] === '@' && depth === 0) {
      atPos = i;
    }
  }
  if (atPos !== -1) clean = clean.slice(atPos + 1);
  if (!clean) return {};

  if (clean.startsWith('[')) {
    const end = clean.indexOf(']');
    if (end !== -1) {
      const host = clean.slice(0, end + 1);
      const port = clean[end + 1] === ':' ? clean.slice(end + 2) : undefined;
      return { host, ...(port !== undefined ? { port } : {}) };
    }
  }

  depth = 0;
  let colonPos = -1;
  for (let i = 0; i < clean.length; i++) {
    if (clean.startsWith('{{', i)) {
      depth++;
      i++;
    } else if (clean.startsWith('}}', i) && depth > 0) {
      depth--;
      i++;
    } else if (clean[i] === ':' && depth === 0) {
      colonPos = i;
    }
  }
  if (colonPos !== -1) {
    return { host: clean.slice(0, colonPos), port: clean.slice(colonPos + 1) };
  }
  return { host: clean };
}

function parseUrlString(raw: string): RawUrlParts {
  const trimmed = raw.trim();
  const hashIdx = trimmed.indexOf('#');
  const noHash = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  const qIdx = noHash.indexOf('?');
  const queryStr = qIdx === -1 ? undefined : noHash.slice(qIdx + 1);
  const main = qIdx === -1 ? noHash : noHash.slice(0, qIdx);

  const schemeSep = main.indexOf('://');
  const firstSlash = main.indexOf('/');
  let scheme: string | undefined;
  let rest = main;
  if (schemeSep !== -1 && (firstSlash === -1 || schemeSep < firstSlash)) {
    scheme = main.slice(0, schemeSep);
    rest = main.slice(schemeSep + 3);
  }

  let authority = '';
  let pathStr = '';
  const slash = rest.indexOf('/');
  if (slash === -1) {
    authority = rest;
  } else {
    authority = rest.slice(0, slash);
    pathStr = rest.slice(slash + 1);
  }

  const { host, port } = splitAuthority(authority);
  const pathSegments = pathStr ? pathStr.split('/').filter((s) => s.length > 0) : [];
  return { scheme, host, port, pathSegments, queryMap: parseQueryString(queryStr) };
}

function extractQueryArray(
  rawQuery: unknown,
  problems: string[] | undefined,
  reqName: string,
  budget: WalkBudget,
  budgetProblems: string[],
): Map<string, string> | undefined {
  if (rawQuery === undefined || rawQuery === null) return undefined;
  if (!touchNode(budget, budgetProblems)) return undefined;
  if (!Array.isArray(rawQuery)) {
    if (problems) pushProblem(problems, `Request "${quoteFileText(reqName)}": url.query is not an array (ignored).`);
    return undefined;
  }
  const out = new Map<string, string>();
  for (const item of rawQuery) {
    if (!touchNode(budget, budgetProblems)) break;
    if (!isObj(item)) {
      if (problems) pushProblem(problems, `Request "${quoteFileText(reqName)}": url.query entry is not an object (skipped).`);
      continue;
    }
    if (own(item, 'disabled') === true) continue;
    const key = own(item, 'key');
    if (typeof key !== 'string' || key.length === 0) continue;
    const val = own(item, 'value');
    if (val === undefined || val === null) {
      out.set(key, '');
    } else if (typeof val === 'string') {
      out.set(key, val);
    } else if ((typeof val === 'number' && Number.isFinite(val)) || typeof val === 'boolean') {
      out.set(key, String(val));
    }
  }
  return out;
}

const MAX_QUERY_PARAMS = 20;
const MAX_QUERY_PARAM_CHARS = 100;
/** Entries of `url.query` looked at for names (the array was already walked by `extractQueryArray`). */
const MAX_QUERY_ENTRIES_SCANNED = 1000;

/**
 * CONTRACTS §22.2: the query parameter names a request declares — `url.query` keys (disabled ones included), else the
 * keys of the raw URL's query string; file order, unique, ≤ 20, each ≤ 100 chars.
 */
function queryParamNames(rawUrl: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (k: unknown): void => {
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_QUERY_PARAM_CHARS || seen.has(k)) return;
    if (names.length >= MAX_QUERY_PARAMS) return;
    seen.add(k);
    names.push(k);
  };
  let raw: unknown = rawUrl;
  if (isObj(rawUrl)) {
    const q = own(rawUrl, 'query');
    if (Array.isArray(q)) {
      const n = Math.min(q.length, MAX_QUERY_ENTRIES_SCANNED);
      for (let i = 0; i < n; i++) {
        const entry: unknown = q[i];
        if (isObj(entry)) add(own(entry, 'key'));
      }
      return names;
    }
    raw = own(rawUrl, 'raw');
  }
  if (typeof raw === 'string' && raw.length <= COLLECTION_LIMITS.urlChars) {
    for (const k of parseUrlString(raw).queryMap.keys()) add(k);
  }
  return names;
}

interface ExtractedUrl {
  keyTemplate: string;
  scheme?: string;
  host?: string;
  port?: string;
  pathSegments: string[];
  queryMap: Map<string, string>;
}

function extractUrl(
  rawUrl: unknown,
  reqName: string,
  problems: string[],
  budget: WalkBudget,
): ExtractedUrl | undefined {
  if (!touchNode(budget, problems)) return undefined;
  const safeReq = quoteFileText(reqName);
  if (typeof rawUrl === 'string') {
    if (rawUrl.length > COLLECTION_LIMITS.urlChars) {
      pushProblem(problems, `Request "${safeReq}": URL exceeds ${COLLECTION_LIMITS.urlChars} characters (skipped).`);
      return undefined;
    }
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      pushProblem(problems, `Request "${safeReq}": URL is empty (skipped).`);
      return undefined;
    }
    const parsed = parseUrlString(trimmed);
    return {
      keyTemplate: stripQueryAndFragment(trimmed),
      scheme: parsed.scheme,
      host: parsed.host,
      port: parsed.port,
      pathSegments: parsed.pathSegments,
      queryMap: parsed.queryMap,
    };
  }

  if (!isObj(rawUrl)) {
    pushProblem(problems, `Request "${safeReq}": missing or invalid URL (skipped).`);
    return undefined;
  }

  const rawField = own(rawUrl, 'raw');
  let rawStr: string | undefined;
  if (rawField !== undefined) {
    if (!touchNode(budget, problems)) return undefined;
    if (typeof rawField !== 'string') {
      pushProblem(problems, `Request "${safeReq}": url.raw is not a string (ignored).`);
    } else {
      if (rawField.length > COLLECTION_LIMITS.urlChars) {
        pushProblem(problems, `Request "${safeReq}": URL exceeds ${COLLECTION_LIMITS.urlChars} characters (skipped).`);
        return undefined;
      }
      if (rawField.trim() !== '') rawStr = rawField.trim();
    }
  }

  const protoField = own(rawUrl, 'protocol');
  let partScheme: string | undefined;
  if (protoField !== undefined) {
    if (!touchNode(budget, problems)) return undefined;
    if (typeof protoField !== 'string') {
      pushProblem(problems, `Request "${safeReq}": url.protocol is not a string (ignored).`);
    } else if (protoField.trim() !== '') {
      partScheme = protoField.trim().replace(/:+$/, '');
    }
  }

  const hostField = own(rawUrl, 'host');
  let partHost: string | undefined;
  if (hostField !== undefined) {
    if (!touchNode(budget, problems)) return undefined;
    if (typeof hostField === 'string') {
      if (hostField.trim() !== '') partHost = hostField.trim();
    } else if (Array.isArray(hostField)) {
      const segs: string[] = [];
      let bad = false;
      for (const h of hostField) {
        if (!touchNode(budget, problems)) return undefined;
        if (typeof h === 'string') segs.push(h);
        else bad = true;
      }
      if (bad) pushProblem(problems, `Request "${safeReq}": url.host contains a non-string entry.`);
      const joined = segs.filter((s) => s.length > 0).join('.');
      if (joined !== '') partHost = joined;
    } else {
      pushProblem(problems, `Request "${safeReq}": url.host must be a string or array of strings (ignored).`);
    }
  }

  const portField = own(rawUrl, 'port');
  let partPort: string | undefined;
  if (portField !== undefined) {
    if (!touchNode(budget, problems)) return undefined;
    if (typeof portField !== 'string') {
      pushProblem(problems, `Request "${safeReq}": url.port is not a string (ignored).`);
    } else {
      partPort = portField.trim();
    }
  }

  const pathField = own(rawUrl, 'path');
  let partPath: string[] | undefined;
  if (pathField !== undefined) {
    if (!touchNode(budget, problems)) return undefined;
    if (typeof pathField === 'string') {
      partPath = pathField.split('/').filter((s) => s.length > 0);
    } else if (Array.isArray(pathField)) {
      partPath = [];
      let bad = false;
      for (const seg of pathField) {
        if (!touchNode(budget, problems)) return undefined;
        if (typeof seg === 'string') {
          if (seg.length > 0) partPath.push(seg);
        } else if (isObj(seg) && typeof own(seg, 'value') === 'string') {
          const val = own(seg, 'value') as string;
          if (val.length > 0) partPath.push(val);
        } else {
          bad = true;
        }
      }
      if (bad) pushProblem(problems, `Request "${safeReq}": url.path contains an invalid entry.`);
    } else {
      pushProblem(problems, `Request "${safeReq}": url.path must be a string or array (ignored).`);
    }
  }

  const partQuery = extractQueryArray(own(rawUrl, 'query'), problems, reqName, budget, problems);
  if (budget.exceeded) return undefined;
  const fromRaw = rawStr ? parseUrlString(rawStr) : { pathSegments: [], queryMap: new Map<string, string>() };

  // CONTRACTS §21.2: object parts win over `raw` when both are present.
  const scheme = partScheme ?? fromRaw.scheme;
  const host = partHost ?? fromRaw.host;
  const port = partPort !== undefined ? (partPort === '' ? undefined : partPort) : fromRaw.port;
  const pathSegments = partPath ?? fromRaw.pathSegments;
  const queryMap = partQuery ?? fromRaw.queryMap;

  let keyTemplate: string;
  if (rawStr) {
    keyTemplate = stripQueryAndFragment(rawStr);
  } else {
    const schemePrefix = scheme ? `${scheme}://` : '';
    const portSuffix = port ? `:${port}` : '';
    const pathSuffix = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
    keyTemplate = `${schemePrefix}${host ?? ''}${portSuffix}${pathSuffix}`;
  }

  if (!keyTemplate) {
    pushProblem(problems, `Request "${safeReq}": URL is missing or invalid (skipped).`);
    return undefined;
  }

  if (keyTemplate.length > COLLECTION_LIMITS.urlChars) {
    pushProblem(problems, `Request "${safeReq}": URL exceeds ${COLLECTION_LIMITS.urlChars} characters (skipped).`);
    return undefined;
  }

  return { keyTemplate, scheme, host, port, pathSegments, queryMap };
}

function defaultPortFor(scheme: string): string | undefined {
  if (scheme === 'http' || scheme === 'ws') return '80';
  if (scheme === 'https' || scheme === 'wss') return '443';
  return undefined;
}

const VALID_SCHEME = /^[a-z][a-z0-9+.-]*$/;

function buildOriginAndPrefix(
  extracted: ExtractedUrl,
  vars: CollectionVars,
  usedVars: Map<string, VariableSource | undefined>,
  reqName: string,
  problems: string[],
): { origin?: string; unresolved: string[]; prefixPath: string[] } {
  const unresolved: string[] = [];
  const pushUnresolved = (names: string[]) => {
    for (const n of names) {
      if (!unresolved.includes(n)) unresolved.push(n);
    }
  };

  const schemeRes = extracted.scheme !== undefined ? resolveTemplate(extracted.scheme, vars, usedVars) : undefined;
  if (schemeRes) pushUnresolved(schemeRes.unresolved);

  const hostRes = extracted.host !== undefined ? resolveTemplate(extracted.host, vars, usedVars) : undefined;
  if (hostRes) pushUnresolved(hostRes.unresolved);

  const portRes = extracted.port !== undefined ? resolveTemplate(extracted.port, vars, usedVars) : undefined;
  if (portRes) pushUnresolved(portRes.unresolved);

  if (unresolved.length > 0) {
    return { unresolved, prefixPath: [] };
  }

  const rawHostText = hostRes?.text.trim() ?? '';
  if (!rawHostText) {
    pushProblem(problems, `Request "${quoteFileText(reqName)}": URL has no host.`);
    return { unresolved: [], prefixPath: [] };
  }

  // A `{{baseUrl}}` variable commonly holds `scheme://host[:port][/prefix]`.
  let finalScheme = schemeRes?.text.trim() ?? '';
  let finalHost = rawHostText;
  let finalPort = portRes?.text.trim() ?? '';
  let prefixPath: string[] = [];

  if (rawHostText.includes('://') || rawHostText.includes('/')) {
    const parsedHost = parseUrlString(rawHostText);
    if (parsedHost.scheme) finalScheme = parsedHost.scheme;
    if (parsedHost.host !== undefined) finalHost = parsedHost.host;
    if (!finalPort && parsedHost.port !== undefined) finalPort = parsedHost.port;
    prefixPath = parsedHost.pathSegments;
  }

  if (!finalScheme) finalScheme = 'https';
  finalScheme = finalScheme.toLowerCase();
  finalHost = finalHost.toLowerCase();

  if (!VALID_SCHEME.test(finalScheme)) {
    pushProblem(problems, `Request "${quoteFileText(reqName)}": invalid URL scheme.`);
    return { unresolved: [], prefixPath };
  }
  if (!finalHost || /[\s/?#]/.test(finalHost)) {
    pushProblem(problems, `Request "${quoteFileText(reqName)}": invalid host.`);
    return { unresolved: [], prefixPath };
  }

  let portPart = '';
  if (finalPort) {
    if (!/^\d{1,5}$/.test(finalPort)) {
      pushProblem(problems, `Request "${quoteFileText(reqName)}": invalid port.`);
      return { unresolved: [], prefixPath };
    }
    const portNum = Number(finalPort);
    if (portNum < 1 || portNum > 65535) {
      pushProblem(problems, `Request "${quoteFileText(reqName)}": port is out of range.`);
      return { unresolved: [], prefixPath };
    }
    const normalizedPort = String(portNum);
    if (normalizedPort !== defaultPortFor(finalScheme)) {
      portPart = `:${normalizedPort}`;
    }
  }

  return { origin: `${finalScheme}://${finalHost}${portPart}`, unresolved: [], prefixPath };
}

function buildPath(
  prefixPath: string[],
  rawSegments: string[],
  vars: CollectionVars,
  usedVars: Map<string, VariableSource | undefined>,
  reqName: string,
  problems: string[],
): PathSegment[] {
  const out: PathSegment[] = [];
  for (const seg of prefixPath) {
    if (seg) out.push(seg);
  }

  for (const seg of rawSegments) {
    if (!seg) continue;
    if (seg.startsWith(':') && seg.length > 1) {
      out.push({ param: seg.slice(1) });
      continue;
    }

    const tokens = tokenize(seg);
    if (tokens.length === 1 && tokens[0].kind === 'var') {
      const name = tokens[0].value;
      if (name.startsWith('$')) {
        out.push({ param: name });
        continue;
      }
      const val = vars.values.get(name);
      const hasValue = typeof val === 'string' && val !== '';
      if (!usedVars.has(name)) {
        usedVars.set(name, hasValue ? vars.sources.get(name) : undefined);
      }
      if (hasValue) {
        for (const piece of val.split('/')) {
          if (piece) out.push(piece);
        }
      } else {
        out.push({ param: name });
      }
      continue;
    }

    const res = resolveTemplate(seg, vars, usedVars);
    if (res.unresolved.length === 0) {
      for (const piece of res.text.split('/')) {
        if (piece) out.push(piece);
      }
    } else {
      pushProblem(
        problems,
        `Request "${quoteFileText(reqName)}": partially unresolved path segment "${quoteFileText(seg, 60)}" treated as a parameter.`,
      );
      out.push({ param: res.unresolved[0] });
    }
  }

  return out;
}

// ------------------------------------------------------------------ request bodies and auth (CONTRACTS §24.1, §24.2)

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const JSON_CONTENT_TYPE = 'application/json';

/**
 * §24.2: a Postman `body` as `{ contentType, body }` — `raw` text that parses as JSON, or `urlencoded` entries
 * (enabled ones, re-encoded). Other modes (formdata, file, graphql) and non-JSON raw text → undefined. Over
 * `REQUEST_BODY_BYTES` → undefined with `tooBig`.
 */
function postmanRequestBody(
  rawBody: unknown,
  budget: WalkBudget,
  problems: string[],
): { value?: { contentType: string; body: string }; tooBig?: true } {
  if (!isObj(rawBody) || own(rawBody, 'disabled') === true) return {};
  if (!touchNode(budget, problems)) return {};
  const mode = own(rawBody, 'mode');
  const raw = own(rawBody, 'raw');
  if ((mode === 'raw' || mode === undefined) && typeof raw === 'string') {
    if (raw.trim() === '') return {};
    if (utf8ByteLength(raw) > REQUEST_BODY_BYTES) return { tooBig: true };
    try {
      JSON.parse(raw);
    } catch {
      return {};
    }
    return { value: { contentType: JSON_CONTENT_TYPE, body: raw } };
  }
  if (mode === 'urlencoded') {
    const list = own(rawBody, 'urlencoded');
    if (!Array.isArray(list)) return {};
    const parts: string[] = [];
    let bytes = 0;
    for (const entry of list) {
      if (!touchNode(budget, problems)) return {};
      if (!isObj(entry) || own(entry, 'disabled') === true) continue;
      const key = own(entry, 'key');
      if (typeof key !== 'string' || key === '') continue;
      const rawVal = own(entry, 'value');
      const val =
        typeof rawVal === 'string'
          ? rawVal
          : (typeof rawVal === 'number' && Number.isFinite(rawVal)) || typeof rawVal === 'boolean'
            ? String(rawVal)
            : '';
      const part = `${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
      bytes += part.length + 1;
      if (bytes > REQUEST_BODY_BYTES) return { tooBig: true };
      parts.push(part);
    }
    return parts.length > 0 ? { value: { contentType: FORM_CONTENT_TYPE, body: parts.join('&') } } : {};
  }
  return {};
}

/** §24.1: a Postman `auth` block → 'none' (`noauth`), 'declared' (any other type), undefined (absent / inherit). */
function postmanAuth(rawAuth: unknown): 'none' | 'declared' | undefined {
  if (!isObj(rawAuth)) return undefined;
  const type = own(rawAuth, 'type');
  if (typeof type !== 'string' || type === '' || type === 'inherit') return undefined;
  return type === 'noauth' ? 'none' : 'declared';
}

// ------------------------------------------------------------------ examples (responses)

function previewContentType(lang: unknown): string {
  const lower = typeof lang === 'string' ? lang.toLowerCase() : '';
  if (lower === 'json') return 'application/json; charset=utf-8';
  if (lower === 'xml') return 'application/xml';
  if (lower === 'html') return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function parseExampleHeaders(
  rawHeader: unknown,
  body: string,
  previewLang: unknown,
  reqName: string,
  exName: string,
  problems: string[],
  budget: WalkBudget,
): Record<string, string> {
  const headers = dict<string>();

  // Postman v2.0 string headers are ignored without crashing.
  if (Array.isArray(rawHeader)) {
    if (!touchNode(budget, problems)) return headers;
    for (const h of rawHeader) {
      if (!touchNode(budget, problems)) break;
      if (!isObj(h)) continue;
      if (own(h, 'disabled') === true) continue;
      const rawKey = own(h, 'key');
      if (typeof rawKey !== 'string') continue;
      const name = rawKey.trim().toLowerCase();
      if (!name || isDroppedHeader(name)) continue;

      const rawVal = own(h, 'value');
      let val: string;
      if (typeof rawVal === 'string') val = rawVal;
      else if (rawVal === undefined || rawVal === null) val = '';
      else if ((typeof rawVal === 'number' && Number.isFinite(rawVal)) || typeof rawVal === 'boolean') val = String(rawVal);
      else continue;

      if (name === 'set-cookie') {
        if (!hasOwn(headers, name)) setOwn(headers, name, val);
      } else {
        setOwn(headers, name, hasOwn(headers, name) ? `${headers[name]}, ${val}` : val);
      }
    }
  } else if (rawHeader !== undefined && rawHeader !== null && typeof rawHeader !== 'string') {
    pushProblem(problems, `Request "${quoteFileText(reqName)}" example "${quoteFileText(exName)}": "header" is not an array (ignored).`);
  }

  if (!hasOwn(headers, 'content-type') && body.length > 0) {
    setOwn(headers, 'content-type', previewContentType(previewLang));
  }
  return headers;
}

function extractExampleQuery(
  originalRequest: unknown,
  reqQuery: Map<string, string>,
  budget: WalkBudget,
  problems: string[],
): Record<string, string> | undefined {
  if (originalRequest === undefined || originalRequest === null) return undefined;
  if (!touchNode(budget, problems)) return undefined;
  let rawUrl: unknown;
  if (typeof originalRequest === 'string') {
    rawUrl = originalRequest;
  } else if (isObj(originalRequest)) {
    rawUrl = own(originalRequest, 'url');
  } else {
    return undefined;
  }

  let exQuery: Map<string, string> | undefined;
  if (typeof rawUrl === 'string') {
    if (!touchNode(budget, problems)) return undefined;
    exQuery = parseUrlString(rawUrl).queryMap;
  } else if (isObj(rawUrl)) {
    if (!touchNode(budget, problems)) return undefined;
    const queryField = own(rawUrl, 'query');
    if (queryField !== undefined) {
      exQuery = extractQueryArray(queryField, undefined, '', budget, problems);
    } else if (typeof own(rawUrl, 'raw') === 'string') {
      exQuery = parseUrlString(own(rawUrl, 'raw') as string).queryMap;
    }
  }

  if (!exQuery || exQuery.size === 0 || budget.exceeded) return undefined;

  const diff = dict<string>();
  let count = 0;
  for (const [k, v] of exQuery) {
    if (hasTemplateVar(k) || hasTemplateVar(v)) continue;
    if (reqQuery.get(k) !== v) {
      setOwn(diff, k, v);
      count++;
    }
  }
  return count > 0 ? diff : undefined;
}

function parseExamples(
  rawResponse: unknown,
  reqQuery: Map<string, string>,
  reqName: string,
  problems: string[],
  budget: WalkBudget,
  bodyBudget: BodyBudget,
): MockExample[] {
  const safeReq = quoteFileText(reqName);
  if (rawResponse === undefined || rawResponse === null) return [];
  if (!touchNode(budget, problems)) return [];
  if (!Array.isArray(rawResponse)) {
    pushProblem(problems, `Request "${safeReq}": "response" is not an array (ignored).`);
    return [];
  }

  const limit = Math.min(rawResponse.length, COLLECTION_LIMITS.examplesPerEndpoint);
  if (rawResponse.length > COLLECTION_LIMITS.examplesPerEndpoint) {
    pushProblem(
      problems,
      `Request "${safeReq}": has more than ${COLLECTION_LIMITS.examplesPerEndpoint} examples; only the first ${COLLECTION_LIMITS.examplesPerEndpoint} were kept.`,
    );
  }

  const examples: MockExample[] = [];
  for (let i = 0; i < limit; i++) {
    if (!touchNode(budget, problems)) break;
    if (bodyBudget.exceeded) break;
    const res = rawResponse[i];
    if (!isObj(res)) {
      pushProblem(problems, `Request "${safeReq}": example ${i + 1} is not an object (skipped).`);
      continue;
    }

    const rawName = own(res, 'name');
    const exName = typeof rawName === 'string' && rawName.length > 0 ? rawName : `Example ${i + 1}`;
    const safeEx = quoteFileText(exName);
    if (rawName !== undefined && typeof rawName !== 'string') {
      pushProblem(problems, `Request "${safeReq}": example ${i + 1} has a non-string name.`);
    }

    const rawCode = own(res, 'code');
    let status = 200;
    if (typeof rawCode !== 'number' || !Number.isInteger(rawCode) || rawCode < 100 || rawCode > 599) {
      pushProblem(problems, `Request "${safeReq}" example "${safeEx}": missing or invalid status code (using 200).`);
    } else {
      status = rawCode;
    }

    const rawBody = own(res, 'body');
    let body = '';
    if (rawBody !== undefined && rawBody !== null) {
      if (!touchNode(budget, problems)) break;
      if (typeof rawBody !== 'string') {
        pushProblem(problems, `Request "${safeReq}" example "${safeEx}": response body is not text (treated as empty).`);
      } else {
        const bodyBytes = utf8ByteLength(rawBody);
        if (bodyBytes > COLLECTION_LIMITS.exampleBodyBytes) {
          pushProblem(problems, `Request "${safeReq}" example "${safeEx}": body exceeds 5 MB (skipped).`);
          continue;
        }
        if (bodyBudget.bytes + bodyBytes > COLLECTION_BODY_BYTES) {
          bodyBudget.exceeded = true;
          pushProblem(problems, 'Collection example bodies exceed 64 MB in total; further examples were skipped.');
          break;
        }
        bodyBudget.bytes += bodyBytes;
        body = rawBody;
      }
    }

    const headers = parseExampleHeaders(
      own(res, 'header'),
      body,
      own(res, '_postman_previewlanguage'),
      reqName,
      exName,
      problems,
      budget,
    );
    const originalRequest = own(res, 'originalRequest');
    const query = extractExampleQuery(originalRequest, reqQuery, budget, problems);
    if (budget.exceeded) break;
    const request = isObj(originalRequest) ? postmanRequestBody(own(originalRequest, 'body'), budget, problems) : {};
    if (budget.exceeded) break;
    if (request.tooBig) {
      pushProblem(
        problems,
        `Request "${safeReq}" example "${safeEx}": request body over ${REQUEST_BODY_BYTES / 1024} KB, not used for choosing by body.`,
      );
    }

    examples.push({
      name: exName,
      status,
      headers,
      body,
      ...(query ? { query } : {}),
      ...(request.value ? { request: request.value } : {}),
    });
  }
  return examples;
}

// ------------------------------------------------------------------ public API

/**
 * CONTRACTS §21.2: reads the collection's own `variable[]` (disabled and empty entries skipped),
 * ready to be merged with `mergeCollectionVars`. Never throws.
 */
export const postmanCollectionVariables: PostmanCollectionVariables = (doc) => {
  const out = new Map<string, string>();
  if (!isObj(doc)) return out;
  const rawVars = own(doc, 'variable');
  if (!Array.isArray(rawVars)) return out;

  const limit = Math.min(rawVars.length, COLLECTION_LIMITS.walkNodes);
  for (let i = 0; i < limit; i++) {
    const entry = rawVars[i];
    if (!isObj(entry)) continue;
    if (own(entry, 'disabled') === true) continue;
    const key = own(entry, 'key');
    if (typeof key !== 'string' || key.length === 0) continue;
    const rawVal = own(entry, 'value');
    if (typeof rawVal === 'string') {
      if (rawVal !== '') out.set(key, rawVal);
    } else if ((typeof rawVal === 'number' && Number.isFinite(rawVal)) || typeof rawVal === 'boolean') {
      out.set(key, String(rawVal));
    }
  }
  return out;
};

/**
 * CONTRACTS §21.1, §21.2: parses a Postman v2.0 / v2.1 collection into `ParsedCollection`.
 * Never throws; invalid entries and exceeded limits produce one-line problems while the rest loads.
 */
export const parsePostman: ParsePostman = (doc, vars) => {
  const problems: string[] = [];
  const endpoints: MockEndpoint[] = [];
  const usedVars = new Map<string, VariableSource | undefined>();
  const budget: WalkBudget = { visited: 0, exceeded: false };
  const bodyBudget: BodyBudget = { bytes: 0, exceeded: false };

  if (!isObj(doc)) {
    pushProblem(problems, 'Postman collection must be a JSON object.');
    return { format: 'postman', name: 'Postman collection', endpoints, variables: [], problems };
  }
  touchNode(budget, problems);

  const info = own(doc, 'info');
  const rawCollName = isObj(info) ? own(info, 'name') : undefined;
  const collName = typeof rawCollName === 'string' && rawCollName.trim() !== '' ? rawCollName : 'Postman collection';

  const rootItems = own(doc, 'item');
  if (!Array.isArray(rootItems)) {
    pushProblem(problems, 'Postman collection has no "item" array.');
    return { format: 'postman', name: collName, endpoints, variables: [], problems };
  }

  const keyCounts = new Map<string, number>();
  const usedKeys = new Set<string>();
  const activeFolders = new Set<object>();
  let endpointLimitHit = false;

  const uniqueKey = (baseKey: string): string => {
    let n = (keyCounts.get(baseKey) ?? 0) + 1;
    let candidate = n === 1 ? baseKey : `${baseKey} #${n}`;
    while (usedKeys.has(candidate)) {
      n++;
      candidate = `${baseKey} #${n}`;
    }
    keyCounts.set(baseKey, n);
    usedKeys.add(candidate);
    return candidate;
  };

  const walkItems = (items: unknown[], folder: string[], inheritedAuth: 'none' | 'declared' | undefined) => {
    if (!touchNode(budget, problems)) return;
    for (const item of items) {
      if (endpointLimitHit || budget.exceeded) return;
      if (!touchNode(budget, problems)) return;
      if (!isObj(item)) {
        pushProblem(problems, 'Skipped a collection item that is not an object.');
        continue;
      }

      const rawItemName = own(item, 'name');
      const itemName = typeof rawItemName === 'string' && rawItemName.trim() !== '' ? rawItemName : undefined;
      const safeItem = quoteFileText(itemName ?? 'Unnamed request');

      const req = own(item, 'request');
      if (req !== undefined) {
        if (!touchNode(budget, problems)) return;
        if (endpoints.length >= COLLECTION_LIMITS.endpoints) {
          endpointLimitHit = true;
          pushProblem(problems, `Collection has more than ${COLLECTION_LIMITS.endpoints} endpoints; the rest were skipped.`);
          return;
        }

        let method = 'GET';
        let rawUrl: unknown;
        if (typeof req === 'string') {
          rawUrl = req;
        } else if (isObj(req)) {
          const rawMethod = own(req, 'method');
          if (typeof rawMethod === 'string' && rawMethod.trim() !== '') {
            method = rawMethod.trim().toUpperCase();
          } else if (rawMethod !== undefined) {
            pushProblem(problems, `Request "${safeItem}": invalid method (using GET).`);
          }
          rawUrl = own(req, 'url');
        } else {
          pushProblem(problems, `Request "${safeItem}": "request" is not an object or string (skipped).`);
          continue;
        }

        const label = itemName ?? (typeof rawUrl === 'string' ? quoteFileText(rawUrl, 60) : 'Unnamed request');
        const extracted = extractUrl(rawUrl, label, problems, budget);
        if (budget.exceeded) return;
        if (!extracted) continue;

        const name = itemName ?? `${method} ${extracted.keyTemplate}`;
        const { origin, unresolved, prefixPath } = buildOriginAndPrefix(extracted, vars, usedVars, name, problems);
        const path = buildPath(prefixPath, extracted.pathSegments, vars, usedVars, name, problems);
        const examples = parseExamples(own(item, 'response'), extracted.queryMap, name, problems, budget, bodyBudget);
        if (budget.exceeded) return;
        const key = uniqueKey(`${method} ${extracted.keyTemplate}`);
        const queryParams = queryParamNames(rawUrl);
        const auth = (isObj(req) ? postmanAuth(own(req, 'auth')) : undefined) ?? inheritedAuth;
        const ownBody = isObj(req) ? postmanRequestBody(own(req, 'body'), budget, problems) : {};
        if (budget.exceeded) return;
        if (ownBody.tooBig) {
          pushProblem(problems, `Request "${quoteFileText(name)}": request body over ${REQUEST_BODY_BYTES / 1024} KB (ignored).`);
        }

        endpoints.push({
          key,
          method,
          name,
          folder: [...folder],
          ...(origin !== undefined ? { origin } : {}),
          path,
          examples,
          unresolved,
          ...(queryParams.length > 0 ? { queryParams } : {}),
          ...(ownBody.value ? { requestBody: ownBody.value } : {}),
          ...(auth !== undefined ? { auth } : {}),
        });
        continue;
      }

      const childItems = own(item, 'item');
      if (childItems !== undefined) {
        const safeFolder = quoteFileText(itemName ?? 'Unnamed folder');
        if (!Array.isArray(childItems)) {
          pushProblem(problems, `Folder "${safeFolder}": "item" is not an array (skipped).`);
          continue;
        }
        if (activeFolders.has(item)) {
          pushProblem(problems, `Folder "${safeFolder}": circular reference (skipped).`);
          continue;
        }
        if (folder.length >= COLLECTION_LIMITS.folderDepth) {
          pushProblem(
            problems,
            `Folder "${safeFolder}" exceeds maximum depth of ${COLLECTION_LIMITS.folderDepth} (skipped).`,
          );
          continue;
        }
        activeFolders.add(item);
        walkItems(childItems, [...folder, itemName ?? 'Unnamed folder'], postmanAuth(own(item, 'auth')) ?? inheritedAuth);
        activeFolders.delete(item);
        continue;
      }

      pushProblem(problems, `Item "${quoteFileText(itemName ?? 'Unnamed item')}" has neither "request" nor "item" (skipped).`);
    }
  };

  walkItems(rootItems, [], postmanAuth(own(doc, 'auth')));

  const variables = [...usedVars.entries()].map(([name, from]) => (from !== undefined ? { name, from } : { name }));
  return { format: 'postman', name: collName, endpoints, variables, problems };
};
