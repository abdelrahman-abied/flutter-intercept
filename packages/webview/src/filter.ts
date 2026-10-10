/**
 * DevTools-style filter language for the traffic list (ROADMAP WP4). Pure: no DOM.
 *
 *   free words          URL contains the word (case-insensitive); "quoted phrase" works too
 *   m:POST              method (comma = any of: m:GET,POST)
 *   s:404 s:4xx s:error status (exact, class pattern with x, or network error / reset / abort)
 *   t:json              response content class: json html image text xml binary other (prefix ok)
 *   body:token          decoded request + response UTF-8 bodies contain it (case-insensitive)
 *   body:"a phrase"
 *   h:name  h:name=val  request or response header present / value contains val
 *   state:paused        exchange state (prefix ok: paused → paused-request + paused-response),
 *                       plus `simulated`, `resent`, `sent` (sent from the editor or an agent)
 *   src:api.dart        a source frame's uri contains it
 *   contract:error      model check result (CONTRACTS §10.5): error | warning (worst is a warning) | ok |
 *                       unchecked (no result, or the host could not check it); prefix ok, comma = any of
 *   -token              negates any of the above
 *
 * Tokens are AND-ed. A token with an empty value (`m:` while typing) is ignored; a token with an invalid
 * value is ignored and reported in `errors`. Unknown `key:` prefixes (e.g. `https://…`) are URL words.
 *
 * Performance: lowercased body text is cached per Body object (WeakMap), so a keystroke never
 * re-lowercases multi-MB bodies; the parsed filter is cached per text.
 */
import type { Body, ContractSummary, Exchange, ExchangeState } from './protocol';
import { CONTRACT_STATUSES, contractStatus, type ContractStatus } from './contract';
import { headerValue, isJsonContentType, statusClassOf } from './util';

export type ContentClass = 'json' | 'html' | 'image' | 'text' | 'xml' | 'binary' | 'other';
export const CONTENT_CLASSES: readonly ContentClass[] = ['json', 'html', 'image', 'text', 'xml', 'binary', 'other'];

const STATES: readonly ExchangeState[] = [
  'pending', 'paused-request', 'paused-response', 'completed', 'mocked', 'blocked', 'aborted', 'error',
];
/** Extra `state:` values that are not ExchangeState names. */
const STATE_EXTRAS = ['simulated', 'resent', 'sent'] as const;

export const FILTER_KEYS = ['m', 's', 't', 'body', 'h', 'state', 'src', 'contract'] as const;
type Key = (typeof FILTER_KEYS)[number];
const ALIASES: Record<string, Key> = {
  m: 'm', method: 'm', s: 's', status: 's', t: 't', type: 't', body: 'body', h: 'h', header: 'h',
  state: 'state', is: 'state', src: 'src', source: 'src', contract: 'contract', model: 'contract',
};

export const FILTER_HINT =
  'Filter: words match the URL · m:POST · s:404 s:4xx s:error · t:json|html|image|text|xml|binary|other · ' +
  'body:token body:"a phrase" · h:name h:name=value · state:paused|mocked|blocked|error|simulated|resent · ' +
  'src:file.dart · contract:error|warning|ok|unchecked · -token negates';

/** What a filter can see besides the exchange itself. */
export interface FilterContext { contracts?: Record<string, ContractSummary> }
type Pred = (e: Exchange, ctx: FilterContext) => boolean;
interface Term { pred: Pred; negate: boolean; cost: number }

export interface ParsedFilter {
  terms: Term[];
  errors: string[];
  /** True when nothing would be filtered (all tokens empty / invalid). */
  empty: boolean;
}

// ---------------------------------------------------------------- tokenizer

export interface RawToken { negate: boolean; key?: string; value: string }

/** Splits on whitespace; `"…"` groups (also after `key:`); a leading `-` negates. Unclosed quotes run to the end. */
export function tokenize(text: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let negate = false;
    if (text[i] === '-' && i + 1 < n && !/\s/.test(text[i + 1])) { negate = true; i++; }
    let key: string | undefined;
    // key: letters followed by ':' (only known keys become filter keys; others stay URL words).
    const m = /^([A-Za-z]+):/.exec(text.slice(i, i + 12));
    if (m && ALIASES[m[1].toLowerCase()] && !(text.slice(i + m[0].length, i + m[0].length + 2) === '//')) {
      key = m[1].toLowerCase();
      i += m[0].length;
    }
    let value = '';
    if (text[i] === '"') {
      i++;
      const end = text.indexOf('"', i);
      value = end < 0 ? text.slice(i) : text.slice(i, end);
      i = end < 0 ? n : end + 1;
    } else {
      const start = i;
      while (i < n && !/\s/.test(text[i])) i++;
      value = text.slice(start, i);
    }
    out.push({ negate, key, value });
  }
  return out;
}

// ---------------------------------------------------------------- caches

const lowerBody = new WeakMap<Body, string>();
/** Lowercased UTF-8 body text, computed once per Body object. Binary bodies are never searched. */
export function lowerBodyText(b: Body | undefined): string {
  if (!b || b.encoding !== 'utf8' || !b.text) return '';
  let s = lowerBody.get(b);
  if (s === undefined) {
    s = b.text.toLowerCase();
    lowerBody.set(b, s);
  }
  return s;
}

const lowerUrl = new WeakMap<Exchange, string>();
function urlLower(e: Exchange): string {
  let s = lowerUrl.get(e);
  if (s === undefined) { s = e.url.toLowerCase(); lowerUrl.set(e, s); }
  return s;
}

const contentClassCache = new WeakMap<Exchange, ContentClass>();

/** Content class of the response (by content-type, else sniffed from the body). */
export function contentClassOf(e: Pick<Exchange, 'responseHeaders' | 'responseBody'>): ContentClass {
  const cached = contentClassCache.get(e as Exchange);
  if (cached) return cached;
  const c = computeContentClass(e);
  contentClassCache.set(e as Exchange, c);
  return c;
}

function computeContentClass(e: Pick<Exchange, 'responseHeaders' | 'responseBody'>): ContentClass {
  const ct = headerValue(e.responseHeaders, 'content-type');
  const mime = (ct ?? '').split(';')[0].trim().toLowerCase();
  const body = e.responseBody;
  if (mime) {
    if (isJsonContentType(mime)) return 'json';
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
    if (mime === 'application/xml' || mime === 'text/xml' || mime.endsWith('+xml')) return 'xml';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('text/') || /(javascript|ecmascript|x-www-form-urlencoded|graphql|yaml)/.test(mime)) return 'text';
    if (/^(audio|video|font)\//.test(mime) || /(octet-stream|pdf|zip|gzip|protobuf|grpc|msgpack|wasm)/.test(mime)) return 'binary';
    if (body?.encoding === 'base64') return 'binary';
    return 'other';
  }
  if (!body || (body.encoding === 'utf8' && !body.text)) return 'other';
  if (body.encoding === 'base64') return 'binary';
  const head = body.text.slice(0, 64).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (/^<!doctype html|^<html/i.test(head)) return 'html';
  if (head.startsWith('<')) return 'xml';
  return 'text';
}

function anyHeader(h: Exchange['requestHeaders'] | undefined, name: string, value?: string): boolean {
  if (!h) return false;
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() !== name) continue;
    if (value === undefined) return true;
    const v = h[k];
    const vs = Array.isArray(v) ? v : [v];
    for (const x of vs) if (x.toLowerCase().includes(value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- compile

const STATUS_PATTERN = /^[1-5][0-9x]{2}$/;

function statusPred(raw: string): Pred | string {
  const alts = raw.toLowerCase().split(',').filter(Boolean);
  const preds: Pred[] = [];
  for (const v of alts) {
    if (v === 'error' || v === 'err') { preds.push((e) => statusClassOf(e) === 'error'); continue; }
    if (!STATUS_PATTERN.test(v)) return `s:${raw} — use a status (404), a class (4xx) or error`;
    if (!v.includes('x')) { const s = Number(v); preds.push((e) => e.status === s); continue; }
    preds.push((e) => {
      if (e.status === undefined) return false;
      const s = String(e.status);
      for (let k = 0; k < 3; k++) if (v[k] !== 'x' && v[k] !== s[k]) return false;
      return true;
    });
  }
  return preds.length === 1 ? preds[0] : (e, x) => preds.some((p) => p(e, x));
}

function contentPred(raw: string): Pred | string {
  const wanted = new Set<ContentClass>();
  for (const v of raw.toLowerCase().split(',').filter(Boolean)) {
    const hits = CONTENT_CLASSES.filter((c) => c.startsWith(v));
    if (!hits.length) return `t:${raw} — use ${CONTENT_CLASSES.join(', ')}`;
    hits.forEach((c) => wanted.add(c));
  }
  return (e) => wanted.has(contentClassOf(e));
}

function statePred(raw: string): Pred | string {
  const preds: Pred[] = [];
  for (const v of raw.toLowerCase().split(',').filter(Boolean)) {
    const states = new Set(STATES.filter((s) => s.startsWith(v)));
    const extras = STATE_EXTRAS.filter((s) => s.startsWith(v));
    if (!states.size && !extras.length) return `state:${raw} — use paused, pending, completed, mocked, blocked, aborted, error, simulated, resent or sent`;
    if (states.size) preds.push((e) => states.has(e.state));
    for (const x of extras) {
      if (x === 'simulated') preds.push((e) => !!e.simulated);
      if (x === 'resent') preds.push((e) => !!e.resentFrom);
      if (x === 'sent') preds.push((e) => !!e.initiator);
    }
  }
  return preds.length === 1 ? preds[0] : (e, x) => preds.some((p) => p(e, x));
}

function contractPred(raw: string): Pred | string {
  const wanted = new Set<ContractStatus>();
  for (const v of raw.toLowerCase().split(',').filter(Boolean)) {
    const hits = CONTRACT_STATUSES.filter((c) => c.startsWith(v));
    if (!hits.length) return `contract:${raw} — use ${CONTRACT_STATUSES.join(', ')}`;
    hits.forEach((c) => wanted.add(c));
  }
  return (e, x) => wanted.has(contractStatus(x.contracts?.[e.id]));
}

function compileToken(t: RawToken): { pred: Pred; cost: number } | string | undefined {
  const key = t.key ? ALIASES[t.key] : undefined;
  const value = t.value;
  if (!key) {
    if (!value) return undefined;
    const v = value.toLowerCase();
    return { pred: (e) => urlLower(e).includes(v), cost: 1 };
  }
  if (!value.trim()) return undefined; // still typing: `m:`
  switch (key) {
    case 'm': {
      const ms = new Set(value.toUpperCase().split(',').filter(Boolean));
      return { pred: (e) => ms.has(e.method.toUpperCase()), cost: 0 };
    }
    case 's': {
      const p = statusPred(value);
      return typeof p === 'string' ? p : { pred: p, cost: 0 };
    }
    case 'state': {
      const p = statePred(value);
      return typeof p === 'string' ? p : { pred: p, cost: 0 };
    }
    case 't': {
      const p = contentPred(value);
      return typeof p === 'string' ? p : { pred: p, cost: 2 };
    }
    case 'h': {
      const eq = value.indexOf('=');
      const name = (eq < 0 ? value : value.slice(0, eq)).trim().toLowerCase();
      if (!name) return `h:${value} — use h:name or h:name=value`;
      const val = eq < 0 ? undefined : value.slice(eq + 1).toLowerCase();
      return { pred: (e) => anyHeader(e.requestHeaders, name, val) || anyHeader(e.responseHeaders, name, val), cost: 2 };
    }
    case 'src': {
      const v = value.toLowerCase();
      return {
        pred: (e) => !!e.source?.frames.some((f) => f.uri.toLowerCase().includes(v)),
        cost: 2,
      };
    }
    case 'contract': {
      const p = contractPred(value);
      return typeof p === 'string' ? p : { pred: p, cost: 0 };
    }
    case 'body': {
      const v = value.toLowerCase();
      return { pred: (e) => lowerBodyText(e.requestBody).includes(v) || lowerBodyText(e.responseBody).includes(v), cost: 9 };
    }
  }
}

let lastText: string | undefined;
let lastParsed: ParsedFilter | undefined;

/** Parse + compile the filter text (cached for the last text, so re-filtering on traffic is free). */
export function parseFilter(text: string): ParsedFilter {
  if (text === lastText && lastParsed) return lastParsed;
  const terms: Term[] = [];
  const errors: string[] = [];
  for (const tok of tokenize(text)) {
    const c = compileToken(tok);
    if (c === undefined) continue;
    if (typeof c === 'string') { errors.push(c); continue; }
    terms.push({ pred: c.pred, negate: tok.negate, cost: c.cost });
  }
  // Cheap predicates first: `m:POST body:x` only searches bodies of POSTs.
  terms.sort((a, b) => a.cost - b.cost);
  const parsed: ParsedFilter = { terms, errors, empty: terms.length === 0 };
  lastText = text;
  lastParsed = parsed;
  return parsed;
}

export function matchesFilter(e: Exchange, p: ParsedFilter, ctx: FilterContext = {}): boolean {
  for (const t of p.terms) if (t.pred(e, ctx) === t.negate) return false;
  return true;
}
