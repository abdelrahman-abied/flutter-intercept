// Pure, dependency-free rule helpers (type-only imports). The webview imports this module
// (`@flutter-intercept/proxy/rules`) so its preview can never disagree with the proxy.
import type { Exchange, Matcher, Rule, RuleAction, SequenceStep } from './types';
import { graphqlOperationNames } from './graphql';

export { detectGraphql, graphqlOperationNames, scanOperations } from './graphql';
export type { GraphqlDetection, GraphqlOperationRef, GraphqlRequest } from './graphql';
export { isIdSegment, pathTemplate, routeTemplate } from './template';

/**
 * `body` (the decoded request body text) matters only for matchers with `graphqlOperation` (CONTRACTS §11.2);
 * without it such a matcher still works for GET requests (`?query=` / `?operationName=`).
 */
export type CompiledMatcher = (method: string, url: string, body?: string) => boolean;

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/s;

/** Longest `/regex/` source accepted in a rule (REVIEW-4 #2). */
export const MAX_REGEX_SOURCE = 256;
/** Unbounded quantifiers (`*`, `+`, `{n,}`, `{n,m}` with m > 100) allowed in one regex… */
const MAX_UNBOUNDED_QUANTIFIERS = 2;
/** …of which on a "wide" atom (`.`, `\S`, `\W`, `\D`, `[^…]`, or a group containing one). */
const MAX_UNBOUNDED_WIDE = 1;

/**
 * Whether a regex source is safe to run on every request (REVIEW-4 #2: no RegExp timeout in Node 20, and
 * a backtracking pattern freezes the extension host). Conservative, syntax-only. Refused:
 * - longer than MAX_REGEX_SOURCE;
 * - backreferences (`\1`, `\k<name>`);
 * - a repeated group (`*`, `+`, `{n,}`, `{n,m>1}`) that contains a quantifier or an alternation
 *   (`(.+)+`, `(a*)*`, `(a|a)*`, `(\d+)?` is fine);
 * - two unbounded quantified atoms in a row (`.*.*`, `\w+\d*`);
 * - more than 2 unbounded quantifiers, or more than 1 on a wide atom (`.`, `\S`, `\W`, `\D`, `[^…]`).
 * Unanchored, k unbounded quantifiers cost up to n^(k+1) on a hostile URL: measured, `.*a.*a.*b` takes
 * 439 ms on 218 chars and `.*a.*b` 1.2 s on 2048. What's accepted is at worst ~n^3 with narrow overlapping
 * atoms on an unusual URL (`\d+1\d+x` on 2048 digits: ~1 s); typical rules (`\/users\/\d+$`) are linear.
 */
export function isSafeRegexSource(src: string): boolean {
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_REGEX_SOURCE) return false;
  interface Frame {
    complex: boolean; // contains a quantifier or an alternation
    wide: boolean; // contains a wide atom
  }
  const stack: Frame[] = [{ complex: false, wide: false }];
  // The atom a following quantifier applies to.
  let atom: { complexGroup: boolean; wide: boolean } | undefined;
  let prevUnbounded = false; // the atom before `atom` carried an unbounded quantifier
  let lastUnbounded = false; // `atom` carries an unbounded quantifier
  let unbounded = 0;
  let unboundedWide = 0;
  const startAtom = (complexGroup = false, wide = false) => {
    prevUnbounded = lastUnbounded;
    lastUnbounded = false;
    atom = { complexGroup, wide };
    if (wide) stack[stack.length - 1].wide = true;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const e = src[i + 1];
      if (e === undefined) return false;
      if ((e >= '1' && e <= '9') || e === 'k') return false; // backreference
      startAtom(false, e === 'S' || e === 'W' || e === 'D');
      i += e === 'u' && src[i + 2] === '{' ? src.indexOf('}', i) + 1 || src.length : 2;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      const negated = src[j] === '^';
      if (negated) j++;
      if (src[j] === ']') j++;
      while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return false;
      startAtom(false, negated);
      i = j + 1;
      continue;
    }
    if (c === '(') {
      stack.push({ complex: false, wide: false });
      atom = undefined;
      lastUnbounded = false;
      prevUnbounded = false;
      i++;
      if (src[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        i++;
        if (src[i] === '<' && src[i + 1] !== '=' && src[i + 1] !== '!') {
          const close = src.indexOf('>', i);
          if (close < 0) return false;
          i = close + 1;
        } else if (src[i] === '<') i += 2;
        else i++;
      }
      continue;
    }
    if (c === ')') {
      if (stack.length < 2) return false;
      const f = stack.pop()!;
      if (f.complex) stack[stack.length - 1].complex = true;
      startAtom(f.complex, f.wide);
      i++;
      continue;
    }
    if (c === '|') {
      stack[stack.length - 1].complex = true;
      atom = undefined;
      lastUnbounded = false;
      prevUnbounded = false;
      i++;
      continue;
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      let isUnbounded = c === '*' || c === '+';
      let repeats = c !== '?';
      let len = 1;
      if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
        if (!m) {
          startAtom(); // a literal "{"
          i++;
          continue;
        }
        len = m[0].length;
        const max = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]);
        isUnbounded = max > 100;
        repeats = max > 1;
      }
      if (!atom) return false; // nothing to quantify, or a stacked quantifier
      if (repeats && atom.complexGroup) return false; // nested quantifier / quantified alternation
      stack[stack.length - 1].complex = true;
      if (isUnbounded) {
        if (prevUnbounded) return false; // adjacent unbounded quantifiers
        if (++unbounded > MAX_UNBOUNDED_QUANTIFIERS) return false;
        if (atom.wide && ++unboundedWide > MAX_UNBOUNDED_WIDE) return false;
        lastUnbounded = true;
      }
      i += len;
      if (src[i] === '?') i++; // lazy
      atom = undefined; // a quantifier can't be quantified again
      continue;
    }
    startAtom(false, c === '.');
    i++;
  }
  return stack.length === 1;
}

/**
 * For RegExp#test, a leading or trailing `.*` (or `.*?`) changes nothing (it can match nothing), but it
 * costs a backtracking quantifier: drop it, so `.*users.*` is as cheap and as safe as `users`.
 */
export function simplifyRegexSource(src: string): string {
  let out = src;
  for (;;) {
    const before = out;
    out = out.replace(/^\.\*\??(?![*+?{])/, '');
    const tail = /\.\*\??$/.exec(out);
    if (tail) {
      let k = tail.index - 1;
      while (k >= 0 && out[k] === '\\') k--;
      if ((tail.index - 1 - k) % 2 === 0) out = out.slice(0, tail.index); // the "." is not escaped
    }
    if (out === before || out === '') return out === '' ? before : out;
  }
}

/** Linear `*` glob (no RegExp, no backtracking): O(n·m) worst case via indexOf. Case-sensitive. */
function compileGlob(p: string): (url: string) => boolean {
  const parts = p.split('*');
  if (parts.length === 1) return (url) => url === p;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const middle = parts.slice(1, -1).filter((x) => x !== '');
  const minLen = first.length + last.length;
  return (url) => {
    if (url.length < minLen || !url.startsWith(first) || !url.endsWith(last)) return false;
    let pos = first.length;
    const end = url.length - last.length;
    for (const part of middle) {
      const at = url.indexOf(part, pos);
      if (at < 0 || at + part.length > end) return false;
      pos = at + part.length;
    }
    return true;
  };
}

type UrlTest = (url: string) => boolean;

/** Compiled URL tests by pattern (REVIEW-4 #11: no recompiling per exchange). Bounded; cleared when full. */
const urlCache = new Map<string, UrlTest>();
const URL_CACHE_MAX = 1000;

/**
 * Compile a Matcher. method: case-insensitive, undefined / '' / '*' = any.
 * url: '' or '*' = any; `/regex/flags` = regex (g/y ignored; an invalid or unsafe one — see
 * isSafeRegexSource — never matches); otherwise a case-sensitive glob on the full URL where `*` = any
 * chars (incl. '/'), matched in linear time.
 */
export function compileMatcher(m: Matcher): CompiledMatcher {
  const base = compileBase(m);
  const op = graphqlOperationOf(m);
  if (op === undefined) return (method, url) => base(method, url);
  return (method, url, body) => base(method, url) && graphqlOperationNames(method, url, body).includes(op);
}

/** Method + URL only (ignores `graphqlOperation`). */
export function compileBase(m: Matcher): (method: string, url: string) => boolean {
  const wantMethod = (m.method ?? '').trim().toUpperCase();
  const anyMethod = wantMethod === '' || wantMethod === '*';
  const urlTest = compileUrl(m.url ?? '');
  return (method, url) => (anyMethod || method.toUpperCase() === wantMethod) && urlTest(url);
}

/** The matcher's GraphQL operation name, or undefined when it has none (empty / whitespace = none). */
export function graphqlOperationOf(m: Matcher): string | undefined {
  const op = typeof m.graphqlOperation === 'string' ? m.graphqlOperation.trim() : '';
  return op === '' ? undefined : op;
}

/**
 * Does the matcher match this request? `body` is the decoded request body text; it is only read when the
 * matcher has `graphqlOperation` (the operation names of a batched request: any of them).
 */
export function matches(m: Matcher, method: string, url: string, body?: string): boolean {
  return compileMatcher(m)(method, url, body);
}

function compileUrl(pattern: string): UrlTest {
  const p = pattern.trim();
  const cached = urlCache.get(p);
  if (cached) return cached;
  let test: UrlTest;
  if (p === '' || p === '*') test = () => true;
  else {
    const lit = REGEX_LITERAL.exec(p);
    if (lit) {
      test = () => false;
      const src = simplifyRegexSource(lit[1]);
      if (isSafeRegexSource(src)) {
        try {
          const re = new RegExp(src, lit[2].replace(/[gy]/g, ''));
          test = (url) => re.test(url);
        } catch {
          /* invalid: never matches */
        }
      }
    } else test = compileGlob(p);
  }
  if (urlCache.size >= URL_CACHE_MAX) urlCache.clear();
  urlCache.set(p, test);
  return test;
}

/** True if the matcher's url is a /regex/ literal that fails to compile or is unsafe (isSafeRegexSource). */
export function isInvalidMatcher(m: Matcher): boolean {
  const lit = REGEX_LITERAL.exec((m.url ?? '').trim());
  if (!lit) return false;
  if (!isSafeRegexSource(simplifyRegexSource(lit[1]))) return true;
  try {
    new RegExp(lit[1], lit[2]);
    return false;
  } catch {
    return true;
  }
}

export interface CompiledRule {
  rule: Rule;
  test: CompiledMatcher;
  /** Method + URL only. */
  base: (method: string, url: string) => boolean;
  /** Matcher.graphqlOperation, trimmed (undefined = none). */
  graphqlOperation?: string;
}

export function compileRules(rules: Rule[]): CompiledRule[] {
  return rules.map((rule) => {
    const op = graphqlOperationOf(rule.match);
    return { rule, test: compileMatcher(rule.match), base: compileBase(rule.match), ...(op !== undefined ? { graphqlOperation: op } : {}) };
  });
}

/** First enabled matching rule wins. */
export function findRule(rules: CompiledRule[], method: string, url: string, body?: string): Rule | undefined {
  for (const r of rules) if (r.rule.enabled && r.test(method, url, body)) return r.rule;
  return undefined;
}

/** Rule actions that apply to a WebSocket upgrade (CONTRACTS §11.1, §12.6); the others pass it through. */
export const WEBSOCKET_ACTIONS: ReadonlySet<RuleAction['kind']> = new Set(['block', 'fault', 'mapRemote']);

/**
 * Why a rule can't do what it says, for rule editors and agent tools (undefined = fine). Today: a rule whose
 * URL only matches WebSockets (`ws://` / `wss://`) with an action that doesn't apply to them (mock, breakpoint,
 * mutate, throttle, cors, the truncate fault), or a `graphqlOperation` on such a rule (the operation of a
 * GraphQL subscription is inside the frames, not in the upgrade request).
 */
export function ruleProblem(rule: Pick<Rule, 'match' | 'action'>): string | undefined {
  const own = actionProblem(rule.action);
  if (own) return own;
  const url = (rule.match?.url ?? '').trim();
  if (!/^wss?:\/\//i.test(url)) return undefined;
  const kind = rule.action?.kind;
  if (graphqlOperationOf(rule.match) !== undefined) {
    return 'GraphQL operation names are not visible on a WebSocket upgrade; match the URL only.';
  }
  if (kind === 'fault' && rule.action.kind === 'fault' && rule.action.fault === 'truncate') {
    return 'The truncate fault does not apply to WebSockets; use reset, timeout or dns.';
  }
  if (kind && !WEBSOCKET_ACTIONS.has(kind)) {
    return `${kind[0].toUpperCase()}${kind.slice(1)} rules do not apply to WebSocket connections (only block, fault and mapRemote do).`;
  }
  return undefined;
}

// Headers that describe the wire framing of the recorded body, not the decoded text a mock
// sends (the proxy recomputes framing for mock bodies).
const FRAMING_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

export type RuleFromExchangeErrorCode = 'truncated' | 'binary';

/**
 * Thrown by ruleFromExchange('mock') when the recorded response can't be replayed faithfully as a
 * text mock. The host turns it into an `error` message for the webview.
 */
export class RuleFromExchangeError extends Error {
  readonly name = 'RuleFromExchangeError';
  constructor(
    readonly code: RuleFromExchangeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Build a rule from a recorded exchange. match = { method, url: origin + path + '*' }.
 * mock = the exchange's response (status/headers/decoded body), or 200 "{}" if it has none;
 *   throws RuleFromExchangeError ('truncated' | 'binary') when that body can't be a text mock.
 *   Multi-value headers (e.g. several set-cookie) are joined with ', ' because RuleAction mock
 *   headers are Record<string, string> (contract question raised in docs/spikes/proxy.md).
 * block = status 403; mutate = no ops yet (the caller adds them); cors = `{kind:'cors'}` matching any
 * method (the preflight is OPTIONS); anything else = a response-phase breakpoint. A GraphQL exchange's rule
 * also matches its `graphqlOperation` (except cors). The host inserts it FIRST.
 */
export function ruleFromExchange(e: Exchange, kind: RuleAction['kind'], id: string): Rule {
  let base = e.url;
  try {
    const u = new URL(e.url);
    base = `${u.origin}${u.pathname}`;
  } catch {
    base = e.url.split(/[?#]/)[0];
  }
  const match: Matcher = kind === 'cors' ? { url: `${base}*` } : { method: e.method, url: `${base}*` };
  // A GraphQL endpoint serves every operation at one URL: scope the rule to this one.
  if (e.graphql?.operationName && kind !== 'cors') match.graphqlOperation = e.graphql.operationName;

  let action: RuleAction;
  if (kind === 'mock') {
    if (e.status !== undefined) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.responseHeaders ?? {})) {
        if (FRAMING_HEADERS.has(k.toLowerCase())) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      if (e.responseBody?.truncated) {
        throw new RuleFromExchangeError(
          'truncated',
          'Cannot mock this response: its body was larger than 5 MB and only partly recorded.',
        );
      }
      if (e.responseBody && e.responseBody.encoding !== 'utf8') {
        throw new RuleFromExchangeError(
          'binary',
          'Cannot mock this response: its body is binary, and mock bodies are text.',
        );
      }
      let body = e.responseBody?.text ?? '';
      if (e.kind === 'sse' && !e.responseBody && e.frames?.length) {
        // Event streams are recorded as frames only (CONTRACTS §11.1): rebuild the stream text.
        if (e.framesDropped || e.frames.some((f) => f.truncated)) {
          throw new RuleFromExchangeError('truncated', 'Cannot mock this event stream: some of its events were not fully recorded.');
        }
        body = e.frames.map(sseEventText).join('');
      }
      action = { kind: 'mock', status: e.status, headers, body };
    } else {
      action = { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
    }
  } else if (kind === 'block') {
    action = { kind: 'block', mode: 'status', status: 403 };
  } else if (kind === 'mutate') {
    action = { kind: 'mutate', ops: [] }; // the caller fills in the ops (CONTRACTS §10.5 mutateField)
  } else if (kind === 'cors') {
    action = { kind: 'cors' }; // any method: the preflight (OPTIONS) and the request itself
  } else {
    action = { kind: 'breakpoint', phase: 'response' };
  }

  let path = base;
  try {
    path = new URL(e.url).pathname;
  } catch {
    /* keep base */
  }
  return { id, enabled: true, name: `${kind} ${e.method} ${path}`, match, action };
}

/** One recorded SSE event as event-stream text. */
function sseEventText(f: { event?: string; id?: string; text?: string }): string {
  let out = '';
  if (f.event !== undefined) out += `event: ${f.event}\n`;
  if (f.id !== undefined) out += `id: ${f.id}\n`;
  for (const line of (f.text ?? '').split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

// ---------------------------------------------------------------- v0.6.0 (CONTRACTS §12.3, §12.6)

/** Actions a sequence step may not use. */
const NOT_A_STEP: ReadonlySet<string> = new Set(['sequence', 'breakpoint']);
/** At most this many literal body replacements per rewrite side (CONTRACTS §12.6). */
export const MAX_BODY_REPLACEMENTS = 20;

/** What a sequence step does: an action, or `undefined` = the real server (`passthrough`). */
export type StepAction = Exclude<SequenceStep['action'], { kind: 'passthrough' }> | undefined;

export interface PickedStep {
  /** The action to apply (`undefined` = pass through to the real server). */
  action: StepAction;
  /** 0-based index of the step that answers, or -1 after the steps with `then: 'passthrough'` (or no steps). */
  index: number;
  /** Set when the step's action is not allowed (`breakpoint` / `sequence`): it passes through instead. */
  invalid?: string;
}

/** `count` of a step: a positive integer, default 1. */
export function stepCount(s: SequenceStep | undefined): number {
  const c = Number(s?.count ?? 1);
  return Number.isFinite(c) && c >= 1 ? Math.floor(c) : 1;
}

/**
 * The step that answers the `n`-th (0-based) matching request of a sequence rule. Each step answers `count`
 * requests in order; afterwards `then`: `last` (default) keeps the last step, `passthrough` sends everything to
 * the real server, `loop` starts again at the first step.
 */
export function pickSequenceStep(a: { steps?: SequenceStep[]; then?: 'last' | 'passthrough' | 'loop' }, n: number): PickedStep {
  const steps = Array.isArray(a.steps) ? a.steps : [];
  if (steps.length === 0) return { action: undefined, index: -1 };
  const total = steps.reduce((t, s) => t + stepCount(s), 0);
  let k = Math.max(0, Math.floor(n));
  if (k >= total) {
    if (a.then === 'passthrough') return { action: undefined, index: -1 };
    if (a.then === 'loop') k %= total;
    else k = total - 1;
  }
  let index = 0;
  for (; index < steps.length - 1; index++) {
    const c = stepCount(steps[index]);
    if (k < c) break;
    k -= c;
  }
  const action = steps[index]?.action;
  if (!action || typeof action !== 'object' || action.kind === 'passthrough') return { action: undefined, index };
  if (NOT_A_STEP.has(action.kind)) {
    return { action: undefined, index, invalid: `Sequence step ${index + 1} (${action.kind}) is not allowed; the request was passed through.` };
  }
  return { action: action as StepAction, index };
}

/** The literal part of a glob before its first `*` (undefined for a /regex/ or a match-all). */
function globPrefix(pattern: string): string | undefined {
  const p = (pattern ?? '').trim();
  if (p === '' || p === '*' || REGEX_LITERAL.test(p)) return undefined;
  const star = p.indexOf('*');
  return star < 0 ? p : p.slice(0, star);
}

const WS_TO_HTTP: Record<string, string> = { 'ws:': 'http:', 'wss:': 'https:' };
const HTTP_TO_WS: Record<string, string> = { 'http:': 'ws:', 'https:': 'wss:' };

/** Parse a Map Remote target (`to`): an absolute http(s) / ws(s) URL without credentials or fragment. */
export function parseMapTarget(to: string): URL {
  let t: URL;
  try {
    t = new URL(String(to ?? '').trim());
  } catch {
    throw new Error(`Map Remote target is not a URL: ${JSON.stringify(String(to ?? '')).slice(0, 200)}`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(t.protocol)) throw new Error(`Map Remote target must be http(s)://, got ${t.protocol}`);
  if (!t.hostname) throw new Error('Map Remote target has no host');
  if (t.username || t.password) throw new Error('Map Remote target must not contain credentials');
  if (t.hash) throw new Error('Map Remote target must not contain a #fragment');
  return t;
}

/**
 * Where a Map Remote rule sends a request (CONTRACTS §12.6). `to` is either an origin
 * (`https://staging.example.com`: only the origin changes, path and query are kept) or a URL prefix
 * (`http://localhost:8080/api/v2`): it replaces the part of the URL the rule's glob matched literally — the text
 * before its first `*` (for `https://api.example.com/v1/*` that is `https://api.example.com/v1/`) — and the rest
 * (path + query) is appended. A /regex/ or match-all rule replaces the origin and puts the prefix's path in front
 * of the request path. The scheme family follows the request: a ws(s):// request maps to ws(s)://. Throws on an
 * invalid target.
 */
export function mapRemoteUrl(original: string, matchUrl: string, to: string): string {
  const t = parseMapTarget(to);
  const o = new URL(original);
  const isWs = o.protocol === 'ws:' || o.protocol === 'wss:';
  const proto = isWs ? (HTTP_TO_WS[t.protocol] ?? t.protocol) : (WS_TO_HTTP[t.protocol] ?? t.protocol);
  const origin = `${proto}//${t.host}`;
  const originOnly = (t.pathname === '/' || t.pathname === '') && !t.search;
  if (originOnly) return `${origin}${o.pathname}${o.search}`;
  const base = `${origin}${t.pathname}${t.search}`;
  const originalOrigin = `${o.protocol}//${o.host}`;
  let prefix = globPrefix(matchUrl);
  if (prefix !== undefined && !original.startsWith(prefix)) prefix = undefined;
  // Never less than the origin (a glob like `https://api.*` names no path to replace).
  if (prefix === undefined || prefix.length <= originalOrigin.length) prefix = `${originalOrigin}/`;
  const rest = original.slice(prefix.length);
  if (rest === '') return base;
  if (rest.startsWith('?')) return t.search ? `${base}&${rest.slice(1)}` : `${base}${rest}`;
  if (base.endsWith('/') && rest.startsWith('/')) return base + rest.slice(1);
  if (prefix.endsWith('/') && !base.endsWith('/') && !rest.startsWith('/')) return `${base}/${rest}`;
  return base + rest;
}

/** Problems with an action's own settings (v0.6.0 actions), for rule editors and agent tools. */
function actionProblem(a: RuleAction | undefined): string | undefined {
  if (!a || typeof a !== 'object') return undefined;
  if (a.kind === 'sequence') {
    if (!Array.isArray(a.steps) || a.steps.length === 0) return 'A sequence needs at least one step.';
    for (let i = 0; i < a.steps.length; i++) {
      const s = a.steps[i]?.action;
      if (!s || typeof s !== 'object') return `Sequence step ${i + 1} has no action.`;
      if (NOT_A_STEP.has(s.kind)) return `Sequence step ${i + 1}: ${s.kind} can't be a step.`;
      if (s.kind !== 'passthrough') {
        const inner = actionProblem(s as RuleAction);
        if (inner) return `Sequence step ${i + 1}: ${inner}`;
      }
    }
    return undefined;
  }
  if (a.kind === 'mapRemote') {
    try {
      parseMapTarget(a.to);
    } catch (e) {
      return (e as Error).message;
    }
    return undefined;
  }
  if (a.kind === 'rewrite') {
    for (const side of [a.request, a.response]) {
      const r = side?.replaceBody;
      if (!r) continue;
      if (r.length > MAX_BODY_REPLACEMENTS) return `At most ${MAX_BODY_REPLACEMENTS} body replacements per side.`;
      if (r.some((x) => typeof x?.find !== 'string' || x.find === '')) return 'A body replacement needs non-empty text to find.';
    }
    const st = a.response?.status;
    if (st !== undefined && (!Number.isInteger(st) || st < 200 || st > 599)) return `Rewrite status must be 200–599, got ${st}.`;
    return undefined;
  }
  return undefined;
}
