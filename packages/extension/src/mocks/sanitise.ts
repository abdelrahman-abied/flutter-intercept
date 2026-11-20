/**
 * Credential stripping for "Copy without credentials" (CONTRACTS §21.6, REVIEW-15 #2/#6/#7). Pure: no vscode, no fs, no network.
 */
import { isSensitiveHeader, redactUrl } from '../agent/redact';
import { isSecretHeaderName, isSecretName, isSecretQueryName } from './secrets';
import { COLLECTION_LIMITS, type SanitisePostman } from './types';

type Obj = Record<string, unknown>;

const SECRET_KEY = /(secret|token|passw(or)?d|pwd|passphrase|api[-_]?key|auth|credential|session|cookie|private|signature)/i;
const SECRET_KEY_SUFFIX = /(?:[-_](?:key|token|pin|sig)$|[a-z](?:Key|Pin|Sig)$|^(?:pin|sig)$)/;
const SECRET_QUERY_EXACT = /^(?:key|sig|signature|code|client[-_]?secret)$/i;
const SENSITIVE_HEADER_EXTRA = /(?:[-_](?:key|token|secret|sig|signature|auth)$|^(?:ocp-apim-subscription-key|x-functions-key|x-signature|signature)$)/i;
const EXAMPLE_COOKIE_HEADER = /^(?:set-cookie|cookie)$/i;

const URL_USERINFO = /([a-z][a-z0-9+.-]{0,30}:\/\/)([^/?#@\s]+@)/gi;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>`]+/gi;
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const FORM_KEY = /^[A-Za-z0-9_.~%+-]+$/;

const MAX_CLONE_DEPTH = 64;
/** In `removed` when the walk stopped at its budget (the copy is cut). */
export const SANITISE_TOO_LARGE = 'the rest of the collection was not copied (too large)';
const TOO_LARGE_NOTICE = SANITISE_TOO_LARGE;

interface WalkBudget {
  visited: number;
  exceeded: boolean;
  /** Visits allowed: `COLLECTION_LIMITS.walkNodes`, more for a plain tree (REVIEW-16 #12). */
  limit: number;
}

/** A plain tree (no object reached twice) of at most this many values gets a budget sized to it. */
const MAX_TREE_NODES = 8_000_000;

/**
 * REVIEW-16 #12: the number of values in `doc` when it is a plain tree (what `JSON.parse` gives: no object reached
 * twice) of at most `MAX_TREE_NODES` values, else undefined. Stops at the first shared object (a YAML alias DAG keeps
 * the REVIEW-15 #2a budget) or past the cap, so it costs at most what the walk itself would.
 */
function treeSize(doc: unknown): number | undefined {
  const seen = new WeakSet<object>();
  let n = 0;
  let ok = true;
  const walk = (v: unknown, depth: number): void => {
    if (!ok) return;
    if (++n > MAX_TREE_NODES) {
      ok = false;
      return;
    }
    if (v === null || typeof v !== 'object' || depth > MAX_CLONE_DEPTH + 1) return;
    if (seen.has(v)) {
      ok = false;
      return;
    }
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && ok; i++) walk(v[i], depth + 1);
    } else {
      for (const k of Object.keys(v)) {
        if (!ok) return;
        walk(own(v as Obj, k), depth + 1);
      }
    }
  };
  walk(doc, 0);
  return ok ? n : undefined;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(obj: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key)
    ? Object.getOwnPropertyDescriptor(obj, key)?.value
    : undefined;
}

function dict(): Obj {
  return Object.create(null) as Obj;
}

function setKey(obj: Obj, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function cleanLabel(s: string, max = 80): string {
  const cleaned = s
    .replace(URL_IN_TEXT, (u) => redactUrl(u))
    .replace(BIDI_CONTROLS, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function addRemoved(removed: Set<string>, name: string): void {
  const clean = cleanLabel(name, 160);
  if (clean) removed.add(clean);
}

function touchNode(budget: WalkBudget, removed: Set<string>, cost = 1): boolean {
  if (budget.exceeded) return false;
  budget.visited += cost;
  if (budget.visited > budget.limit) {
    budget.exceeded = true;
    addRemoved(removed, TOO_LARGE_NOTICE);
    return false;
  }
  return true;
}

/** REVIEW-16 #4–#6: this copy's own substring rule, plus the shared word rule (`sid`, `otp`, `verificationCode`, `csrf` …). */
function isSecretKeyName(name: string): boolean {
  return SECRET_KEY.test(name) || SECRET_KEY_SUFFIX.test(name) || isSecretName(name);
}

function isSecretQueryKeyName(name: string): boolean {
  return isSecretKeyName(name) || SECRET_QUERY_EXACT.test(name) || isSecretQueryName(name);
}

function isSanitiseSensitiveHeader(name: string): boolean {
  const trimmed = name.trim();
  return isSensitiveHeader(trimmed) || SENSITIVE_HEADER_EXTRA.test(trimmed) || isSecretHeaderName(trimmed);
}

/**
 * Clones arbitrary values while counting every visit against `COLLECTION_LIMITS.walkNodes` (REVIEW-15 #2a).
 * Cycles stop via `active`; shared YAML aliases are counted per expanded visit so DAG bombs stop quickly.
 */
function cloneUnknown(
  value: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_CLONE_DEPTH || active.has(value)) return undefined;

  active.add(value);
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (budget.exceeded) break;
      const item = cloneUnknown(value[i], removed, budget, active, depth + 1);
      if (budget.exceeded) break;
      arr.push(item);
    }
    active.delete(value);
    return arr;
  }

  const out = dict();
  for (const k of Object.keys(value)) {
    if (budget.exceeded) break;
    const cloned = cloneUnknown(own(value as Obj, k), removed, budget, active, depth + 1);
    if (budget.exceeded) break;
    setKey(out, k, cloned);
  }
  active.delete(value);
  return out;
}

// ------------------------------------------------------------------ URLs & headers

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function stripUrlUserinfo(raw: string): { text: string; stripped: boolean } {
  let stripped = false;
  const text = raw.replace(URL_USERINFO, (_m, scheme: string) => {
    stripped = true;
    return scheme;
  });
  return { text, stripped };
}

function stripHostUserinfo(hostPart: string): { text: string; stripped: boolean } {
  const withScheme = stripUrlUserinfo(hostPart);
  if (withScheme.stripped) return withScheme;
  // Bare `user:pass@host` in `url.host` outside `{{...}}`.
  let depth = 0;
  let atPos = -1;
  for (let i = 0; i < hostPart.length; i++) {
    if (hostPart.startsWith('{{', i)) {
      depth++;
      i++;
    } else if (hostPart.startsWith('}}', i) && depth > 0) {
      depth--;
      i++;
    } else if (hostPart[i] === '@' && depth === 0) {
      atPos = i;
    }
  }
  if (atPos !== -1) {
    return { text: hostPart.slice(atPos + 1), stripped: true };
  }
  return { text: hostPart, stripped: false };
}

function sanitiseUrlString(raw: string, removed: Set<string>, userinfoLabel = 'URL credentials'): string {
  const ui = stripUrlUserinfo(raw);
  let text = ui.text;
  if (ui.stripped) addRemoved(removed, userinfoLabel);

  const qIdx = text.indexOf('?');
  if (qIdx === -1) return text;
  const hashIdx = text.indexOf('#', qIdx + 1);
  const qs = hashIdx === -1 ? text.slice(qIdx + 1) : text.slice(qIdx + 1, hashIdx);
  if (!qs) return text;

  let changed = false;
  const parts = qs.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return part;
    const rawKey = part.slice(0, eq);
    const rawVal = part.slice(eq + 1);
    const decodedKey = safeDecode(rawKey);
    if (isSecretQueryKeyName(decodedKey) && rawVal !== '') {
      addRemoved(removed, decodedKey);
      changed = true;
      return `${rawKey}=`;
    }
    return part;
  });

  if (!changed) return text;
  const suffix = hashIdx === -1 ? '' : text.slice(hashIdx);
  text = `${text.slice(0, qIdx + 1)}${parts.join('&')}${suffix}`;
  return text;
}

function sanitiseUrlHost(
  rawHost: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (typeof rawHost === 'string') {
    const res = stripHostUserinfo(rawHost);
    if (res.stripped) addRemoved(removed, 'URL credentials');
    return res.text;
  }
  if (!Array.isArray(rawHost) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawHost, removed, budget, active, depth);
  }
  const out: unknown[] = [];
  for (const part of rawHost) {
    if (budget.exceeded) break;
    if (typeof part === 'string') {
      if (!touchNode(budget, removed)) break;
      const res = stripHostUserinfo(part);
      if (res.stripped) addRemoved(removed, 'URL credentials');
      out.push(res.text);
    } else {
      const cloned = cloneUnknown(part, removed, budget, active, depth + 1);
      if (budget.exceeded) break;
      out.push(cloned);
    }
  }
  return out;
}

function sanitiseKeyValueList(
  rawList: unknown,
  fallbackName: string,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
  opts: { stripFileSrc?: boolean; isQuery?: boolean } = {},
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (!Array.isArray(rawList) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawList, removed, budget, active, depth);
  }
  const out: unknown[] = [];
  for (const entry of rawList) {
    if (budget.exceeded) break;
    if (!isObj(entry)) {
      const cloned = cloneUnknown(entry, removed, budget, active, depth + 1);
      if (budget.exceeded) break;
      out.push(cloned);
      continue;
    }
    if (!touchNode(budget, removed)) break;
    const isFile = Boolean(opts.stripFileSrc) && own(entry, 'type') === 'file';
    const cloned = dict();
    for (const k of Object.keys(entry)) {
      if (budget.exceeded) break;
      const v = own(entry, k);
      if (isFile && k === 'src') {
        const keyName = own(entry, 'key');
        if (v !== '' && v !== undefined && v !== null) {
          addRemoved(removed, typeof keyName === 'string' && keyName ? keyName : 'file');
        }
        continue;
      }
      const valCopy = cloneUnknown(v, removed, budget, active, depth + 1);
      if (budget.exceeded) break;
      setKey(cloned, k, valCopy);
    }
    if (budget.exceeded) break;

    const key = own(cloned, 'key');
    const type = own(cloned, 'type');
    const val = own(cloned, 'value');
    const keyMatches = typeof key === 'string' && (opts.isQuery ? isSecretQueryKeyName(key) : isSecretKeyName(key));
    const isSecret = type === 'secret' || keyMatches;
    if (isSecret && val !== '' && val !== undefined && val !== null) {
      setKey(cloned, 'value', '');
      addRemoved(removed, typeof key === 'string' && key ? key : fallbackName);
    } else if (typeof val === 'string' && val.includes('://')) {
      const cleanedUrl = sanitiseUrlString(val, removed, typeof key === 'string' && key ? `${key} (URL credentials)` : 'URL credentials');
      if (cleanedUrl !== val) {
        setKey(cloned, 'value', cleanedUrl);
      }
    }
    out.push(cloned);
  }
  return out;
}

function sanitiseVariables(
  rawVars: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  return sanitiseKeyValueList(rawVars, 'variable', removed, budget, active, depth);
}

function sanitiseHeaderString(raw: string, removed: Set<string>, predicate: (name: string) => boolean): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();
      if (predicate(name)) {
        if (val !== '') addRemoved(removed, name);
        out.push(`${line.slice(0, colon + 1)}`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

function sanitiseHeaders(
  rawHeaders: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
  predicate: (name: string) => boolean = isSanitiseSensitiveHeader,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (typeof rawHeaders === 'string') {
    return sanitiseHeaderString(rawHeaders, removed, predicate);
  }
  if (!Array.isArray(rawHeaders) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawHeaders, removed, budget, active, depth);
  }
  const out: unknown[] = [];
  for (const entry of rawHeaders) {
    if (budget.exceeded) break;
    const cloned = cloneUnknown(entry, removed, budget, active, depth + 1);
    if (budget.exceeded) break;
    if (isObj(cloned)) {
      const key = own(cloned, 'key');
      const val = own(cloned, 'value');
      if (typeof key === 'string' && predicate(key)) {
        if (val !== '' && val !== undefined && val !== null) {
          setKey(cloned, 'value', '');
          addRemoved(removed, key);
        }
      }
    }
    out.push(cloned);
  }
  return out;
}

function sanitiseResponseCookies(
  rawCookies: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (!Array.isArray(rawCookies) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawCookies, removed, budget, active, depth);
  }
  const out: unknown[] = [];
  for (const entry of rawCookies) {
    if (budget.exceeded) break;
    const cloned = cloneUnknown(entry, removed, budget, active, depth + 1);
    if (budget.exceeded) break;
    if (isObj(cloned)) {
      const val = own(cloned, 'value');
      if (val !== '' && val !== undefined && val !== null) {
        const name = own(cloned, 'name');
        setKey(cloned, 'value', '');
        addRemoved(removed, typeof name === 'string' && name ? `cookie (${name})` : 'cookie');
      }
    }
    out.push(cloned);
  }
  return out;
}

function sanitiseUrl(
  rawUrl: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (typeof rawUrl === 'string') return sanitiseUrlString(rawUrl, removed);
  if (!isObj(rawUrl) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawUrl, removed, budget, active, depth);
  }
  const out = dict();
  for (const k of Object.keys(rawUrl)) {
    if (budget.exceeded) break;
    const v = own(rawUrl, k);
    if (k === 'auth') {
      if (v !== undefined && v !== null) addRemoved(removed, 'url auth');
      continue;
    }
    let val: unknown;
    if (k === 'variable') {
      val = sanitiseVariables(v, removed, budget, active, depth + 1);
    } else if (k === 'query') {
      val = sanitiseKeyValueList(v, 'query', removed, budget, active, depth + 1, { isQuery: true });
    } else if (k === 'host') {
      val = sanitiseUrlHost(v, removed, budget, active, depth + 1);
    } else if (k === 'raw' && typeof v === 'string') {
      if (!touchNode(budget, removed)) break;
      val = sanitiseUrlString(v, removed);
    } else {
      val = cloneUnknown(v, removed, budget, active, depth + 1);
    }
    if (budget.exceeded) break;
    setKey(out, k, val);
  }
  return out;
}

// ------------------------------------------------------------------ request bodies (CONTRACTS §21.6, REVIEW-15 #6)

function sanitiseJsonValue(
  value: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  depth: number,
  state: { changed: boolean },
  active: WeakSet<object>,
): unknown {
  if (!touchNode(budget, removed)) {
    state.changed = true;
    return undefined;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_CLONE_DEPTH || active.has(value)) {
    state.changed = true;
    return undefined;
  }

  active.add(value);
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (budget.exceeded) break;
      const item = sanitiseJsonValue(value[i], removed, budget, depth + 1, state, active);
      if (budget.exceeded) break;
      arr.push(item);
    }
    active.delete(value);
    return arr;
  }

  const out = dict();
  for (const k of Object.keys(value)) {
    if (budget.exceeded) break;
    const v = own(value as Obj, k);
    if (isSecretKeyName(k)) {
      if (v !== '' && v !== undefined && v !== null) {
        addRemoved(removed, k);
      }
      if (v !== '') {
        state.changed = true;
      }
      setKey(out, k, '');
    } else {
      const child = sanitiseJsonValue(v, removed, budget, depth + 1, state, active);
      if (budget.exceeded) break;
      setKey(out, k, child);
    }
  }
  active.delete(value);
  return out;
}

/** Recognises and sanitises an `x-www-form-urlencoded`-shaped raw body (`a=1&password=x`). */
function trySanitiseFormEncodedRaw(raw: string, removed: Set<string>): string | undefined {
  if (/[\r\n<>{}\[\]]/.test(raw) || !raw.includes('=')) return undefined;
  const parts = raw.split('&');
  if (parts.length === 0) return undefined;
  let changed = false;
  const out: string[] = [];
  for (const part of parts) {
    if (!part) {
      out.push(part);
      continue;
    }
    const eq = part.indexOf('=');
    if (eq <= 0) return undefined;
    const rawKey = part.slice(0, eq);
    if (!FORM_KEY.test(rawKey)) return undefined;
    const rawVal = part.slice(eq + 1);
    const decodedKey = safeDecode(rawKey);
    if (isSecretKeyName(decodedKey) && rawVal !== '') {
      addRemoved(removed, decodedKey);
      changed = true;
      out.push(`${rawKey}=`);
    } else {
      out.push(part);
    }
  }
  return changed ? out.join('&') : raw;
}

function sanitiseJsonString(raw: string, reqLabel: string, removed: Set<string>, budget: WalkBudget): string {
  const cost = Math.max(1, Math.ceil(raw.length / 1024));
  if (!touchNode(budget, removed, cost)) return '';
  if (raw.trim() === '') return raw;
  let parsed: unknown;
  try {
    // REVIEW-16 #3: a leading BOM doesn't hide the body from the name rules
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    const formSanitised = trySanitiseFormEncodedRaw(raw, removed);
    if (formSanitised !== undefined) return formSanitised;
    addRemoved(removed, `request body of ${reqLabel} not checked (not JSON)`);
    return raw;
  }
  const state = { changed: false };
  const cleaned = sanitiseJsonValue(parsed, removed, budget, 0, state, new WeakSet());
  if (budget.exceeded) return '';
  if (!state.changed) return raw;
  return raw.includes('\n') ? JSON.stringify(cleaned, null, 2) : JSON.stringify(cleaned);
}

function sanitiseGraphql(
  rawGraphql: unknown,
  reqLabel: string,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (!isObj(rawGraphql) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawGraphql, removed, budget, active, depth);
  }
  const out = dict();
  for (const k of Object.keys(rawGraphql)) {
    if (budget.exceeded) break;
    const v = own(rawGraphql, k);
    let val: unknown;
    if (k === 'variables') {
      if (typeof v === 'string') {
        val = sanitiseJsonString(v, reqLabel, removed, budget);
      } else if (v !== null && typeof v === 'object') {
        const state = { changed: false };
        val = sanitiseJsonValue(v, removed, budget, 0, state, new WeakSet());
      } else {
        val = cloneUnknown(v, removed, budget, active, depth + 1);
      }
    } else {
      val = cloneUnknown(v, removed, budget, active, depth + 1);
    }
    if (budget.exceeded) break;
    setKey(out, k, val);
  }
  return out;
}

function sanitiseFileBody(
  rawFile: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (!isObj(rawFile) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawFile, removed, budget, active, depth);
  }
  const out = dict();
  for (const k of Object.keys(rawFile)) {
    if (budget.exceeded) break;
    const v = own(rawFile, k);
    if (k === 'src') {
      if (v !== '' && v !== undefined && v !== null) addRemoved(removed, 'file');
      continue;
    }
    const val = cloneUnknown(v, removed, budget, active, depth + 1);
    if (budget.exceeded) break;
    setKey(out, k, val);
  }
  return out;
}

function sanitiseBody(
  rawBody: unknown,
  reqLabel: string,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (!isObj(rawBody) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawBody, removed, budget, active, depth);
  }
  const out = dict();
  for (const k of Object.keys(rawBody)) {
    if (budget.exceeded) break;
    const v = own(rawBody, k);
    let val: unknown;
    if (k === 'raw' && typeof v === 'string') {
      val = sanitiseJsonString(v, reqLabel, removed, budget);
    } else if (k === 'urlencoded') {
      val = sanitiseKeyValueList(v, 'urlencoded', removed, budget, active, depth + 1);
    } else if (k === 'formdata') {
      val = sanitiseKeyValueList(v, 'formdata', removed, budget, active, depth + 1, { stripFileSrc: true });
    } else if (k === 'graphql') {
      val = sanitiseGraphql(v, reqLabel, removed, budget, active, depth + 1);
    } else if (k === 'file') {
      val = sanitiseFileBody(v, removed, budget, active, depth + 1);
    } else {
      val = cloneUnknown(v, removed, budget, active, depth + 1);
    }
    if (budget.exceeded) break;
    setKey(out, k, val);
  }
  return out;
}

// ------------------------------------------------------------------ requests, responses, items

/**
 * CONTRACTS §24.1: an `auth` block keeps only its `type` (so auth simulation still knows which requests are protected
 * in a copy without credentials); every value under it is dropped and `auth` is named in `removed`. A missing or odd
 * type → the block is dropped as before.
 */
function authTypeOnly(v: unknown, removed: Set<string>): Obj | undefined {
  const type = isObj(v) ? own(v, 'type') : undefined;
  if (isObj(v) && Object.keys(v).some((k) => k !== 'type')) addRemoved(removed, 'auth');
  if (typeof type !== 'string' || !/^[a-z0-9]{1,20}$/i.test(type)) {
    if (v !== undefined && v !== null && !(isObj(v) && Object.keys(v).length === 0)) addRemoved(removed, 'auth');
    return undefined;
  }
  const out = dict();
  setKey(out, 'type', type);
  return out;
}

function shouldDropBlock(key: string, v: unknown, removed: Set<string>): boolean {
  if (key === 'auth' || key === 'certificate' || key === 'certificates' || key === 'proxy') {
    if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null) addRemoved(removed, key);
    return true;
  }
  if (key === 'event') {
    if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null) addRemoved(removed, 'event');
    return true;
  }
  return false;
}

function sanitiseRequest(
  rawReq: unknown,
  reqLabel: string,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (typeof rawReq === 'string') return sanitiseUrlString(rawReq, removed);
  if (!isObj(rawReq) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawReq, removed, budget, active, depth);
  }
  const out = dict();
  for (const k of Object.keys(rawReq)) {
    if (budget.exceeded) break;
    const v = own(rawReq, k);
    if (k === 'auth') {
      const kept = authTypeOnly(v, removed);
      if (kept) setKey(out, k, kept);
      continue;
    }
    if (shouldDropBlock(k, v, removed)) continue;
    let val: unknown;
    if (k === 'header') {
      val = sanitiseHeaders(v, removed, budget, active, depth + 1);
    } else if (k === 'url') {
      val = sanitiseUrl(v, removed, budget, active, depth + 1);
    } else if (k === 'body') {
      val = sanitiseBody(v, reqLabel, removed, budget, active, depth + 1);
    } else {
      val = cloneUnknown(v, removed, budget, active, depth + 1);
    }
    if (budget.exceeded) break;
    setKey(out, k, val);
  }
  return out;
}

function sanitiseResponses(
  rawRes: unknown,
  reqLabel: string,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (!Array.isArray(rawRes) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawRes, removed, budget, active, depth);
  }
  const out: unknown[] = [];
  for (const entry of rawRes) {
    if (budget.exceeded) break;
    if (!isObj(entry)) {
      const cloned = cloneUnknown(entry, removed, budget, active, depth + 1);
      if (budget.exceeded) break;
      out.push(cloned);
      continue;
    }
    if (!touchNode(budget, removed)) break;
    const copy = dict();
    for (const k of Object.keys(entry)) {
      if (budget.exceeded) break;
      const v = own(entry, k);
      let val: unknown;
      if (k === 'originalRequest') {
        val = sanitiseRequest(v, reqLabel, removed, budget, active, depth + 1);
      } else if (k === 'header') {
        val = sanitiseHeaders(v, removed, budget, active, depth + 1, (n) => EXAMPLE_COOKIE_HEADER.test(n.trim()));
      } else if (k === 'cookie') {
        val = sanitiseResponseCookies(v, removed, budget, active, depth + 1);
      } else {
        val = cloneUnknown(v, removed, budget, active, depth + 1);
      }
      if (budget.exceeded) break;
      setKey(copy, k, val);
    }
    if (budget.exceeded) break;
    out.push(copy);
  }
  return out;
}

function sanitiseItems(
  rawItems: unknown,
  removed: Set<string>,
  budget: WalkBudget,
  active: WeakSet<object>,
  depth: number,
): unknown {
  if (!touchNode(budget, removed)) return undefined;
  if (!Array.isArray(rawItems) || depth > MAX_CLONE_DEPTH) {
    return cloneUnknown(rawItems, removed, budget, active, depth);
  }
  const out: unknown[] = [];
  for (const entry of rawItems) {
    if (budget.exceeded) break;
    if (!isObj(entry) || active.has(entry)) {
      const cloned = cloneUnknown(entry, removed, budget, active, depth + 1);
      if (budget.exceeded) break;
      out.push(cloned);
      continue;
    }
    if (!touchNode(budget, removed)) break;
    active.add(entry);
    const rawName = own(entry, 'name');
    const reqLabel = typeof rawName === 'string' && rawName.trim() !== '' ? cleanLabel(rawName) : 'unnamed request';
    const copy = dict();
    for (const k of Object.keys(entry)) {
      if (budget.exceeded) break;
      const v = own(entry, k);
      if (k === 'auth') {
        const kept = authTypeOnly(v, removed);
        if (kept) setKey(copy, k, kept);
        continue;
      }
      if (shouldDropBlock(k, v, removed)) continue;
      let val: unknown;
      if (k === 'item') {
        val = sanitiseItems(v, removed, budget, active, depth + 1);
      } else if (k === 'variable') {
        val = sanitiseVariables(v, removed, budget, active, depth + 1);
      } else if (k === 'request') {
        val = sanitiseRequest(v, reqLabel, removed, budget, active, depth + 1);
      } else if (k === 'response') {
        val = sanitiseResponses(v, reqLabel, removed, budget, active, depth + 1);
      } else {
        val = cloneUnknown(v, removed, budget, active, depth + 1);
      }
      if (budget.exceeded) break;
      setKey(copy, k, val);
    }
    active.delete(entry);
    if (budget.exceeded) break;
    out.push(copy);
  }
  return out;
}

/**
 * CONTRACTS §21.6: returns a deep copy of a Postman collection with `event`, `certificate` and `proxy` blocks
 * removed, `auth` blocks cut to their `type` (§24.1), sensitive request headers, variables, URL credentials, query parameters, request bodies and
 * example cookies cleared, and file `src` paths removed. Stops at `COLLECTION_LIMITS.walkNodes` (a plain tree of up to
 * 8 M values: a budget sized to it, REVIEW-16 #12) without copying unsanitised content (`removed` then holds
 * `SANITISE_TOO_LARGE`). Never mutates its input and never throws; `removed` holds names only.
 */
export const sanitisePostman: SanitisePostman = (doc) => {
  const removed = new Set<string>();
  // REVIEW-16 #12: a plain tree (a parsed JSON file, a generated collection) gets a budget sized to it, so a large
  // collection is copied whole; a YAML alias DAG keeps COLLECTION_LIMITS.walkNodes
  const size = treeSize(doc);
  const limit = size === undefined ? COLLECTION_LIMITS.walkNodes : Math.max(COLLECTION_LIMITS.walkNodes, size * 3 + 1000);
  const budget: WalkBudget = { visited: 0, exceeded: false, limit };
  const active = new WeakSet<object>();

  if (!isObj(doc)) {
    return { doc: cloneUnknown(doc, removed, budget, active, 0), removed: [...removed] };
  }

  touchNode(budget, removed);
  active.add(doc);
  const out = dict();

  for (const k of Object.keys(doc)) {
    if (budget.exceeded) break;
    const v = own(doc, k);
    if (k === 'auth') {
      const kept = authTypeOnly(v, removed);
      if (kept) setKey(out, k, kept);
      continue;
    }
    if (shouldDropBlock(k, v, removed)) continue;
    let val: unknown;
    if (k === 'variable') {
      val = sanitiseVariables(v, removed, budget, active, 1);
    } else if (k === 'item') {
      val = sanitiseItems(v, removed, budget, active, 1);
    } else {
      val = cloneUnknown(v, removed, budget, active, 1);
    }
    if (budget.exceeded) break;
    setKey(out, k, val);
  }

  return { doc: out, removed: [...removed] };
};
