// Pure, dependency-free rule helpers (type-only imports). The webview imports this module
// (`@flutter-intercept/proxy/rules`) so its preview can never disagree with the proxy.
import type { Exchange, Matcher, Rule, RuleAction } from './types';

export type CompiledMatcher = (method: string, url: string) => boolean;

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
  const wantMethod = (m.method ?? '').trim().toUpperCase();
  const anyMethod = wantMethod === '' || wantMethod === '*';
  const urlTest = compileUrl(m.url ?? '');
  return (method, url) => (anyMethod || method.toUpperCase() === wantMethod) && urlTest(url);
}

export function matches(m: Matcher, method: string, url: string): boolean {
  return compileMatcher(m)(method, url);
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
}

export function compileRules(rules: Rule[]): CompiledRule[] {
  return rules.map((rule) => ({ rule, test: compileMatcher(rule.match) }));
}

/** First enabled matching rule wins. */
export function findRule(rules: CompiledRule[], method: string, url: string): Rule | undefined {
  for (const r of rules) if (r.rule.enabled && r.test(method, url)) return r.rule;
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
 * block = status 403; mutate = no ops yet (the caller adds them); anything else = a response-phase
 * breakpoint. The host inserts it FIRST.
 */
export function ruleFromExchange(e: Exchange, kind: RuleAction['kind'], id: string): Rule {
  let base = e.url;
  try {
    const u = new URL(e.url);
    base = `${u.origin}${u.pathname}`;
  } catch {
    base = e.url.split(/[?#]/)[0];
  }
  const match: Matcher = { method: e.method, url: `${base}*` };

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
      const body = e.responseBody?.text ?? '';
      action = { kind: 'mock', status: e.status, headers, body };
    } else {
      action = { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
    }
  } else if (kind === 'block') {
    action = { kind: 'block', mode: 'status', status: 403 };
  } else if (kind === 'mutate') {
    action = { kind: 'mutate', ops: [] }; // the caller fills in the ops (CONTRACTS §10.5 mutateField)
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
