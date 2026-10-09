// Pure, dependency-free rule helpers (type-only imports). The webview imports this module
// (`@flutter-intercept/proxy/rules`) so its preview can never disagree with the proxy.
import type { Exchange, Matcher, Rule, RuleAction } from './types';

export type CompiledMatcher = (method: string, url: string) => boolean;

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/s;

/**
 * Compile a Matcher. method: case-insensitive, undefined / '' / '*' = any.
 * url: '' or '*' = any; `/regex/flags` = regex (g/y ignored; invalid never matches);
 * otherwise a case-sensitive glob on the full URL where `*` = any chars (incl. '/').
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

function compileUrl(pattern: string): (url: string) => boolean {
  const p = pattern.trim();
  if (p === '' || p === '*') return () => true;

  const lit = REGEX_LITERAL.exec(p);
  if (lit) {
    try {
      const re = new RegExp(lit[1], lit[2].replace(/[gy]/g, ''));
      return (url) => re.test(url);
    } catch {
      return () => false;
    }
  }

  const source = p
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  const re = new RegExp(`^${source}$`);
  return (url) => re.test(url);
}

/** True if the matcher's url is a /regex/ literal that fails to compile. */
export function isInvalidMatcher(m: Matcher): boolean {
  const lit = REGEX_LITERAL.exec((m.url ?? '').trim());
  if (!lit) return false;
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
 * block = status 403; breakpoint = response phase. The host inserts it FIRST.
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
