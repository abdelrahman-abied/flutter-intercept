// Pure, dependency-free rule helpers (type-only imports). The webview imports this module
// (`@flutter-intercept/proxy/rules`) so its preview can never disagree with the proxy.
import type { Exchange, Matcher, Rule, RuleAction, SequenceStep } from './types';
import { graphqlOperationNames } from './graphql';
import { globIndexKey, type IndexKey, regexIndexKey, RuleIndex, scanClass } from './rule-index';
import {
  type GrpcMetadataSide,
  GRPC_STATUS_MESSAGE_MAX_BYTES,
  GRPC_EDIT_MAX_BYTES,
  isBase64,
  mapTargetProblem,
  MAX_BODY_REPLACEMENTS,
  MAX_GRPC_CODE,
  MAX_SCRIPT_BYTES,
  MAX_SEQUENCE_STEPS,
  metadataValueProblem,
  reservedGrpcMetadataProblem,
  SCRIPT_TEMPLATE,
} from './grpc-meta';
// The shared limits / sets / helpers keep their old import path (CONTRACTS §19.4: grpc-meta is the source).
export {
  GRPC_REWRITE_RESERVED,
  GRPC_TRAILER_RESERVED,
  GRPC_STATUS_MESSAGE_MAX_BYTES,
  GRPC_EDIT_MAX_BYTES,
  MAX_BODY_REPLACEMENTS,
  MAX_SCRIPT_BYTES,
  MAX_SEQUENCE_STEPS,
  SCRIPT_TEMPLATE,
  targetsProxy,
} from './grpc-meta';

export { detectGraphql, graphqlOperationNames, scanOperations } from './graphql';
export { RuleIndex, requestOriginKey, scanClass } from './rule-index';
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
/** …of which on a "wide" atom (`.`, `\S`, `\W`, `\D`, `[^…]`, `[^]`, `[\s\S]`, or a group containing one). */
const MAX_UNBOUNDED_WIDE = 1;

/**
 * The escape at `i` (`\`) outside a class, read as JavaScript reads it: the index after it and whether it's a wide
 * atom, or undefined when refused (a backreference, a trailing `\`, an unclosed `\u{` / `\p{`). Without `u` / `v`,
 * `\u{` is `u` and then a literal `{` (REVIEW-16 #1), and `\p` is `p`.
 */
function escapeAt(src: string, i: number, unicode: boolean): { next: number; wide: boolean } | undefined {
  const e = src[i + 1];
  if (e === undefined) return undefined;
  if ((e >= '1' && e <= '9') || e === 'k') return undefined; // backreference
  if (e === 'S' || e === 'W' || e === 'D') return { next: i + 2, wide: true };
  if (unicode && (e === 'u' || e === 'p' || e === 'P') && src[i + 2] === '{') {
    const close = src.indexOf('}', i + 3);
    if (close < 0) return undefined;
    return { next: close + 1, wide: e !== 'u' }; // a property counts as wide
  }
  if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) return { next: i + 6, wide: false };
  if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) return { next: i + 4, wide: false };
  if (e === 'c' && /^[A-Za-z]$/.test(src[i + 2] ?? '')) return { next: i + 3, wide: false };
  return { next: i + 2, wide: false };
}

/**
 * Whether a regex source is safe to run on every request (REVIEW-4 #2: no RegExp timeout in Node 20, and
 * a backtracking pattern freezes the extension host). Conservative, syntax-only. Refused:
 * - longer than MAX_REGEX_SOURCE;
 * - backreferences (`\1`, `\k<name>`);
 * - a repeated group (`*`, `+`, `{n,}`, `{n,m>1}`) that contains a quantifier or an alternation
 *   (`(.+)+`, `(a*)*`, `(a|a)*`, `(\d+)?` is fine);
 * - two unbounded quantified atoms in a row (`.*.*`, `\w+\d*`);
 * - more than 2 unbounded quantifiers, or more than 1 on a wide atom (`.`, `\S`, `\W`, `\D`, `[^…]`, `[^]`, a class
 *   holding one of those escapes or a range of ≥ 94 code points, a Unicode property).
 * Classes and escapes are read as JavaScript reads them under `flags` (`rule-index.ts` `scanClass`; REVIEW-16 #1).
 * Unanchored, k unbounded quantifiers cost up to n^(k+1) on a hostile URL: measured, `.*a.*a.*b` takes
 * 439 ms on 218 chars and `.*a.*b` 1.2 s on 2048. What's accepted is at worst ~n^3 with narrow overlapping
 * atoms on an unusual URL (`\d+1\d+x` on 2048 digits: ~1 s); typical rules (`\/users\/\d+$`) are linear.
 */
export function isSafeRegexSource(src: string, flags = ''): boolean {
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_REGEX_SOURCE) return false;
  const unicode = typeof flags === 'string' && /[uv]/.test(flags);
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
      const e = escapeAt(src, i, unicode);
      if (!e) return false;
      startAtom(false, e.wide);
      i = e.next;
      continue;
    }
    if (c === '[') {
      // JavaScript's reading (REVIEW-16 #1): `[]` matches nothing, `[^]` any character (wide)
      const cls = scanClass(src, i, typeof flags === 'string' ? flags : '');
      if (!cls) return false;
      startAtom(false, cls.wide);
      i = cls.end;
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
  const wantMethod = matcherMethod(m);
  const anyMethod = wantMethod === '*';
  const urlTest = compileUrl(m.url ?? '');
  return (method, url) => (anyMethod || method.toUpperCase() === wantMethod) && urlTest(url);
}

/** The matcher's method, upper-cased; `*` = any (undefined, '' or '*'). */
function matcherMethod(m: Matcher): string {
  const want = (m.method ?? '').trim().toUpperCase();
  return want === '' ? '*' : want;
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
      if (isSafeRegexSource(src, lit[2])) {
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
  if (!isSafeRegexSource(simplifyRegexSource(lit[1]), lit[2])) return true;
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
  /** The matcher's method upper-cased, `*` = any: `base` is `(method === '*' || method === M) && url(U)` with M upper-cased. */
  method: string;
  /** The URL half of `base`. */
  url: (url: string) => boolean;
}

/** compileRules' result: the rules in order, plus the method × origin index (CONTRACTS §24.5) unless forced linear. */
export type CompiledRules = CompiledRule[] & { readonly index?: RuleIndex };

/** `FI_PROXY_LINEAR=1` in the environment: no index (every request tests every rule, the 0.15 behaviour). */
export function linearMatchingForced(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.FI_PROXY_LINEAR === '1';
}

/**
 * Where a matcher URL sits in the rule index (CONTRACTS §24.5): the origin keys it can match and its place in their
 * path tries, or undefined when the origin can't be proven (wildcard). See rule-index.ts for the shapes recognised.
 */
export function urlIndexKey(pattern: string | undefined): IndexKey | undefined {
  const p = (pattern ?? '').trim();
  if (p === '' || p === '*') return undefined;
  const lit = REGEX_LITERAL.exec(p);
  return lit ? regexIndexKey(simplifyRegexSource(lit[1]), lit[2]) : globIndexKey(p);
}

/** The origin keys a matcher URL can match, or undefined when it can't be proven (wildcard). */
export function urlOriginKeys(pattern: string | undefined): string[] | undefined {
  return urlIndexKey(pattern)?.origins;
}

/** `linear`: no index. `maxTrieNodes`: the index's path-trie budget (tests; 0 = method × origin only). */
export function compileRules(rules: Rule[], o: { linear?: boolean; maxTrieNodes?: number } = {}): CompiledRules {
  const out: CompiledRules = rules.map((rule) => {
    const op = graphqlOperationOf(rule.match);
    return {
      rule,
      test: compileMatcher(rule.match),
      base: compileBase(rule.match),
      ...(op !== undefined ? { graphqlOperation: op } : {}),
      method: matcherMethod(rule.match),
      url: compileUrl(rule.match.url ?? ''),
    };
  });
  if (o.linear ?? linearMatchingForced()) return out;
  const index = new RuleIndex(out.length, o.maxTrieNodes);
  for (let i = 0; i < out.length; i++) {
    const key = urlIndexKey(out[i].rule.match.url);
    index.add(i, out[i].method, key?.origins, key?.path);
  }
  Object.defineProperty(out, 'index', { value: index, enumerable: false });
  return out;
}

/**
 * The indexes of the rules that could match a request, in order (CONTRACTS §24.5), or undefined: test every rule (no
 * index, or the list isn't the one it was built for). `method` already upper-cased.
 */
export function ruleCandidates(rules: CompiledRule[], method: string, url: string): readonly number[] | undefined {
  const index = (rules as CompiledRules).index;
  return index && index.size === rules.length ? index.candidates(method, url) : undefined;
}

/** Method + URL of a compiled rule, the request's method already upper-cased (`base` without its per-rule toUpperCase). */
export function baseMatches(r: CompiledRule, method: string, url: string): boolean {
  return (r.method === '*' || r.method === method) && r.url(url);
}

/** First enabled matching rule wins. */
export function findRule(rules: CompiledRule[], method: string, url: string, body?: string): Rule | undefined {
  const M = method.toUpperCase();
  const order = ruleCandidates(rules, M, url);
  const n = order ? order.length : rules.length;
  for (let k = 0; k < n; k++) {
    const r = rules[order ? order[k] : k];
    if (!r.rule.enabled || !baseMatches(r, M, url)) continue;
    if (r.graphqlOperation === undefined || graphqlOperationNames(method, url, body).includes(r.graphqlOperation)) return r.rule;
  }
  return undefined;
}

/**
 * Rule actions that apply to a WebSocket upgrade (CONTRACTS §11.1, §12.6; throttle paces the frames, §14.4); the
 * others pass it through.
 */
export const WEBSOCKET_ACTIONS: ReadonlySet<RuleAction['kind']> = new Set(['block', 'fault', 'mapRemote', 'throttle']);

/**
 * Why a rule can't do what it says, for rule editors and agent tools (undefined = fine). Today: a rule whose
 * URL only matches WebSockets (`ws://` / `wss://`) with an action that doesn't apply to them (mock, breakpoint,
 * mutate, cors, script, the truncate fault), or a `graphqlOperation` on such a rule (the operation of a
 * GraphQL subscription is inside the frames, not in the upgrade request); a sequence step that can't be one
 * (breakpoint, sequence, script); a script without code or over MAX_SCRIPT_BYTES.
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
    return `${kind[0].toUpperCase()}${kind.slice(1)} rules do not apply to WebSocket connections (only block, fault, throttle and mapRemote do).`;
  }
  return undefined;
}

// ---------------------------------------------------------------- gRPC (CONTRACTS §16.2)

/** Rule actions that apply to gRPC calls (CONTRACTS §16.2); a sequence only when every step is one of them. */
export const GRPC_ACTIONS: ReadonlySet<RuleAction['kind']> = new Set([
  'grpcMock',
  'block',
  'fault',
  'throttle',
  'breakpoint',
  'mutate',
  // CONTRACTS §18 (v0.12.0): every action but cors (browser-only) and mock (HTTP bodies; gRPC has grpcMock)
  'rewrite',
  'script',
  'mapRemote',
]);

export function grpcApplicable(a: RuleAction | undefined): boolean {
  if (!a || typeof a !== 'object') return false;
  if (a.kind === 'sequence') {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    return steps.length > 0 && steps.every((s) => s?.action && (s.action.kind === 'passthrough' || GRPC_ACTIONS.has(s.action.kind)));
  }
  return GRPC_ACTIONS.has(a.kind);
}

/** Why a grpcMock action can't be used (setRules refuses it), or undefined. */
export function grpcMockProblem(a: Extract<RuleAction, { kind: 'grpcMock' }>): string | undefined {
  if (a.code !== undefined && (!Number.isInteger(a.code) || a.code < 0 || a.code > MAX_GRPC_CODE)) return `gRPC status code must be 0–${MAX_GRPC_CODE}, got ${String(a.code)}.`;
  if (a.message !== undefined && typeof a.message !== 'string') return 'The gRPC status message must be text.';
  for (const [what, n] of [['delayMs', a.delayMs], ['gapMs', a.gapMs]] as const) {
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return `${what} must be a number ≥ 0.`;
  }
  if (a.messages !== undefined) {
    if (!Array.isArray(a.messages)) return 'messages must be a list of base64 protobuf payloads.';
    for (let i = 0; i < a.messages.length; i++) {
      const m = a.messages[i];
      if (typeof m !== 'string' || !isBase64(m)) return `Message ${i + 1} is not base64.`;
    }
  }
  for (const [what, h] of [['headers', a.headers], ['trailers', a.trailers]] as const) {
    if (h === undefined) continue;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return `${what} must be an object of name → value.`;
    for (const [k, v] of Object.entries(h)) {
      const why = reservedGrpcMetadataProblem(k, 'mock') ?? metadataValueProblem(k, v);
      if (why) return `${what}: ${why}`;
    }
  }
  return undefined;
}

/** Why a rewrite rule's metadata changes are invalid (CONTRACTS §18.1), or undefined. */
function rewriteMetadataProblem(a: Extract<RuleAction, { kind: 'rewrite' }>): string | undefined {
  // Header rewrites apply to HTTP too: only the gRPC-wide reserved names are refused up front (content-type / te are
  // skipped, with a note, on gRPC calls).
  const sides: Array<[string, Record<string, string> | undefined, string[] | undefined, GrpcMetadataSide]> = [
    ['request headers', a.request?.setHeaders, a.request?.removeHeaders, 'rewrite'],
    ['response headers', a.response?.setHeaders, a.response?.removeHeaders, 'rewrite'],
    ['trailers', a.response?.setTrailers, a.response?.removeTrailers, 'trailers'],
  ];
  for (const [what, set, remove, side] of sides) {
    if (set !== undefined && (typeof set !== 'object' || set === null || Array.isArray(set))) return `Rewrite ${what}: expected an object of name → value.`;
    if (remove !== undefined && !Array.isArray(remove)) return `Rewrite ${what}: expected a list of names to remove.`;
    for (const n of [...Object.keys(set ?? {}), ...(remove ?? []).map(String)]) {
      const why = reservedGrpcMetadataProblem(n, side);
      if (why) return `Rewrite ${what}: ${why}`;
    }
    for (const [k, v] of Object.entries(set ?? {})) {
      const why = metadataValueProblem(k, v);
      if (why) return `Rewrite ${what}: ${why}`;
    }
  }
  return undefined;
}

/**
 * Why a `resume` edit of a paused gRPC call is invalid (CONTRACTS §17.2), or undefined. `pause` = what is held:
 * a message takes `message` (base64, ≤ 4 MB decoded) or `drop`; the end of the call takes `status` (0–16) and / or
 * `trailers` (no reserved names). `messageJson` must have been encoded by the host.
 */
export function grpcEditProblem(pause: 'message' | 'status', edit: unknown): string | undefined {
  if (edit === undefined || edit === null) return undefined;
  if (typeof edit !== 'object' || Array.isArray(edit)) return 'A gRPC edit must be an object.';
  const e = edit as { message?: unknown; messageJson?: unknown; drop?: unknown; status?: unknown; trailers?: unknown };
  if (pause === 'message') {
    if (e.status !== undefined || e.trailers !== undefined) return 'This call is paused at a message: edit the message or drop it (status and trailers are for the end of the call).';
    if (e.drop !== undefined && e.drop !== true) return 'drop must be true.';
    if (e.message !== undefined && e.drop) return 'Give either a replacement message or drop, not both.';
    if (e.message === undefined && e.messageJson !== undefined) return 'messageJson must be encoded by the host (schema) before it reaches the proxy.';
    if (e.message !== undefined) {
      if (typeof e.message !== 'string' || !isBase64(e.message)) return 'The replacement message is not base64.';
      if (Math.floor((e.message.length * 3) / 4) > GRPC_EDIT_MAX_BYTES + 3) return `The replacement message is over ${GRPC_EDIT_MAX_BYTES / 1024 / 1024} MB.`;
    }
    return undefined;
  }
  if (e.message !== undefined || e.messageJson !== undefined || e.drop !== undefined) return 'This call is paused at its end: edit the status or the trailers (messages are already delivered).';
  if (e.status !== undefined) {
    const st = e.status as { code?: unknown; message?: unknown };
    if (!st || typeof st !== 'object') return 'status must be {code, message?}.';
    if (!Number.isInteger(st.code) || (st.code as number) < 0 || (st.code as number) > MAX_GRPC_CODE) return `gRPC status code must be 0–${MAX_GRPC_CODE}, got ${String(st.code)}.`;
    if (st.message !== undefined && typeof st.message !== 'string') return 'The status message must be text.';
    if (typeof st.message === 'string' && utf8Length(st.message) > GRPC_STATUS_MESSAGE_MAX_BYTES) return `The status message is over ${GRPC_STATUS_MESSAGE_MAX_BYTES / 1024} KB.`;
  }
  if (e.trailers !== undefined) return grpcMockProblem({ kind: 'grpcMock', trailers: e.trailers as Record<string, string> });
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
 * method (the preflight is OPTIONS); script = SCRIPT_TEMPLATE (hooks that change nothing yet); anything else = a
 * response-phase breakpoint. A GraphQL exchange's rule
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
  } else if (kind === 'grpcMock') {
    action = grpcMockFromExchange(e);
  } else if (kind === 'block') {
    action = { kind: 'block', mode: 'status', status: 403 };
  } else if (kind === 'mutate') {
    action = { kind: 'mutate', ops: [] }; // the caller fills in the ops (CONTRACTS §10.5 mutateField)
  } else if (kind === 'cors') {
    action = { kind: 'cors' }; // any method: the preflight (OPTIONS) and the request itself
  } else if (kind === 'script') {
    action = { kind: 'script', code: SCRIPT_TEMPLATE };
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

/**
 * CONTRACTS §16.2: a grpcMock answering like a recorded gRPC call: its response messages (base64, as recorded) and its
 * status. Throws RuleFromExchangeError('truncated') when some response message was not recorded in full.
 */
function grpcMockFromExchange(e: Exchange): Extract<RuleAction, { kind: 'grpcMock' }> {
  const received = (e.frames ?? []).filter((f) => f.kind === 'message' && f.dir === 'receive');
  if (e.kind === 'grpc' && ((e.grpc?.messagesReceived ?? received.length) > received.length || received.some((f) => f.truncated))) {
    throw new RuleFromExchangeError('truncated', 'Cannot mock this call: some of its response messages were not fully recorded.');
  }
  const code = e.grpc?.statusCode;
  return {
    kind: 'grpcMock',
    code: code !== undefined && Number.isInteger(code) && code >= 0 && code <= 16 ? code : 0,
    ...(e.grpc?.statusMessage ? { message: e.grpc.statusMessage } : {}),
    messages: received.map((f) => f.base64 ?? ''),
  };
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
const NOT_A_STEP: ReadonlySet<string> = new Set(['sequence', 'breakpoint', 'script', 'handler']);

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

/** Parse a Map Remote target (`to`), checked by the shared `mapTargetProblem` (ws(s):// allowed inside the proxy). */
export function parseMapTarget(to: string): URL {
  const why = mapTargetProblem(to, { allowWs: true });
  if (why) throw new Error(why);
  return new URL(String(to).trim());
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

// ---------------------------------------------------------------- v0.7.0 (CONTRACTS §13.4)


/** UTF-8 length of a string without Buffer / TextEncoder (this module also runs in the webview). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Problems with an action's own settings (v0.6.0+ actions), for rule editors and agent tools. */
function actionProblem(a: RuleAction | undefined): string | undefined {
  if (!a || typeof a !== 'object') return undefined;
  if (a.kind === 'grpcMock') return grpcMockProblem(a);
  if (a.kind === 'handler') return handlerProblem(a);
  if (a.kind === 'script') {
    if (typeof a.code !== 'string' || a.code.trim() === '') return 'A script rule needs code (define onRequest and / or onResponse).';
    if (utf8Length(a.code) > MAX_SCRIPT_BYTES) return `A script can be at most ${MAX_SCRIPT_BYTES / 1024} KB.`;
    return undefined;
  }
  if (a.kind === 'sequence') {
    if (!Array.isArray(a.steps) || a.steps.length === 0) return 'A sequence needs at least one step.';
    if (a.steps.length > MAX_SEQUENCE_STEPS) return `A sequence can have at most ${MAX_SEQUENCE_STEPS} steps.`;
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
    const meta = rewriteMetadataProblem(a);
    if (meta) return meta;
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

// ---------------------------------------------------------------- v0.16.0 (CONTRACTS §22.1)

/** A `handler` rule's default timeout (ms). */
export const HANDLER_TIMEOUT_DEFAULT_MS = 10_000;
/** A `handler` rule's longest timeout (ms). */
export const HANDLER_TIMEOUT_MAX_MS = 60_000;
/** Longest `handlerId`. */
export const HANDLER_ID_MAX_CHARS = 200;
/** A mock body (and a handler's answer body) is at most this many UTF-8 bytes (BODY_CAP_BYTES). */
const MOCK_BODY_MAX_BYTES = 5 * 1024 * 1024;
const MOCK_DELAY_MAX_MS = 600_000;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Problems with a mock action's values (a handler rule's `fallback`). */
function mockProblem(m: unknown): string | undefined {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'must be a mock action.';
  const a = m as Record<string, unknown>;
  if (a.kind !== 'mock') return 'must be a mock action.';
  if (!Number.isInteger(a.status) || (a.status as number) < 100 || (a.status as number) > 599) return `status must be an integer 100–599, got ${String(a.status)}.`;
  if (a.body !== undefined && typeof a.body !== 'string') return 'body must be text.';
  if (typeof a.body === 'string' && utf8Length(a.body) > MOCK_BODY_MAX_BYTES) return `body can be at most ${MOCK_BODY_MAX_BYTES / 1024 / 1024} MB.`;
  if (a.headers !== undefined) {
    if (!a.headers || typeof a.headers !== 'object' || Array.isArray(a.headers)) return 'headers must be an object.';
    for (const [k, v] of Object.entries(a.headers)) {
      if (!HEADER_NAME.test(k)) return `invalid header name ${JSON.stringify(k).slice(0, 100)}.`;
      if (typeof v !== 'string' || /[\r\n\0]/.test(v)) return `header "${k}" has an invalid value.`;
    }
  }
  const d = a.delayMs;
  if (d !== undefined && (!Number.isInteger(d) || (d as number) < 0 || (d as number) > MOCK_DELAY_MAX_MS)) return `delayMs must be an integer 0–${MOCK_DELAY_MAX_MS}.`;
  return undefined;
}

/** Why a handler action can't be used (setRules refuses it: kept but never matched), or undefined. */
export function handlerProblem(a: Extract<RuleAction, { kind: 'handler' }>): string | undefined {
  if (typeof a.handlerId !== 'string' || a.handlerId.trim() === '') return 'A stateful mock rule needs a handlerId.';
  if (a.handlerId.length > HANDLER_ID_MAX_CHARS) return `handlerId can be at most ${HANDLER_ID_MAX_CHARS} characters.`;
  const t = a.timeoutMs;
  if (t !== undefined && (!Number.isInteger(t) || t < 1 || t > HANDLER_TIMEOUT_MAX_MS)) return `timeoutMs must be an integer 1–${HANDLER_TIMEOUT_MAX_MS}, got ${String(t)}.`;
  if (a.fallback !== undefined) {
    const why = mockProblem(a.fallback);
    if (why) return `fallback ${why}`;
  }
  return undefined;
}
