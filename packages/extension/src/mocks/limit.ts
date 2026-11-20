/**
 * Safety helpers for collection mocks. Pure.
 *
 * - `limitAnswer` (CONTRACTS §21.16, REVIEW-15 #1 / #4): the answer a collection rule gives until the user approves the
 *   collection. Only what shared mocks need approval for is taken out (rules/policy.ts `approvalReasons`): redirect
 *   targets, cookies, CORS / CSP / forwarding headers, active content types. Plain JSON answers never change.
 * - `cleanLine` (REVIEW-15 #7): every problem line the collections core exposes — one line, short, no bidi controls,
 *   no credentials in URLs — whatever the parser produced.
 */
import type { Rule } from '@flutter-intercept/proxy';
import { approvalReasons } from '../rules/policy';
import { NO_EXAMPLE_HEADER } from './types';

/** Plain words for the panel and the approval prompt, in this order. */
export const LIMIT_REASONS = ['redirects', 'sets cookies', 'changes CORS', 'sets a content security policy', 'sets forwarding headers', 'serves HTML or scripts'] as const;
export type LimitReason = (typeof LIMIT_REASONS)[number];

const ACTIVE_CONTENT = /(html|javascript|ecmascript|svg|xml)/i;
const PLAIN_TEXT = 'text/plain; charset=utf-8';

function setHeader(o: Record<string, string>, k: string, v: string): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

export interface LimitedAnswer {
  rule: Rule;
  /** Lower-case header names taken out or replaced (`content-type` when an active type was served as text). */
  removed: string[];
  reasons: LimitReason[];
}

/**
 * The limited version of a collection rule, or undefined when the rule needs no approval (or isn't a mock). The
 * limited answer carries `x-flutter-intercept: limited; removed=<names>` so the panel, agents and the app's own logs
 * can tell (a value the collection itself set for that header is replaced).
 */
export function limitAnswer(rule: Rule): LimitedAnswer | undefined {
  const a = rule.action;
  // CONTRACTS §22.6: a stateful rule answers its fallback (the example) when no store runs: limit that one
  if (a.kind === 'handler') {
    if (!a.fallback) return undefined;
    const inner = limitAnswer({ ...rule, action: a.fallback });
    if (!inner || inner.rule.action.kind !== 'mock') return undefined;
    return { ...inner, rule: { ...rule, action: { ...a, fallback: inner.rule.action } } };
  }
  if (a.kind !== 'mock' || !approvalReasons(rule).length) return undefined;
  const removed: string[] = [];
  const reasons = new Set<LimitReason>();
  const headers: Record<string, string> = {};
  let hasType = false;
  for (const [name, value] of Object.entries(a.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === NO_EXAMPLE_HEADER) continue;
    if (lower === 'location' || lower === 'refresh') reasons.add('redirects');
    else if (lower === 'set-cookie') reasons.add('sets cookies');
    else if (lower.startsWith('access-control-')) reasons.add('changes CORS');
    else if (lower.startsWith('content-security-policy')) reasons.add('sets a content security policy');
    else if (lower.startsWith('x-forwarded-')) reasons.add('sets forwarding headers');
    else if (lower === 'content-type' && ACTIVE_CONTENT.test(value)) {
      reasons.add('serves HTML or scripts');
      removed.push(lower);
      setHeader(headers, name, PLAIN_TEXT);
      hasType = true;
      continue;
    } else {
      if (lower === 'content-type') hasType = true;
      setHeader(headers, name, value);
      continue;
    }
    removed.push(lower);
  }
  if (a.status >= 300 && a.status < 400) reasons.add('redirects'); // the status stays; without Location nothing follows it
  if (!hasType && a.body.trimStart().startsWith('<')) {
    reasons.add('serves HTML or scripts');
    setHeader(headers, 'content-type', PLAIN_TEXT);
  }
  setHeader(headers, NO_EXAMPLE_HEADER, `limited; removed=${[...new Set(removed)].join(',') || 'none'}`);
  return {
    rule: { ...rule, action: { ...a, headers } },
    removed: [...new Set(removed)],
    reasons: LIMIT_REASONS.filter((r) => reasons.has(r)),
  };
}

/**
 * CONTRACTS §22.4 / §21.16: the headers of an answer a stateful mock computed, limited like a collection rule's until
 * the collection is approved. `removed` is empty (and `headers` unchanged) when nothing needed approval.
 */
export function limitHeaders(status: number, headers: Record<string, string>, body: string): { headers: Record<string, string>; removed: string[]; reasons: LimitReason[] } {
  const l = limitAnswer({ id: 'store', enabled: true, match: { url: '*' }, action: { kind: 'mock', status, headers, body } });
  if (!l || l.rule.action.kind !== 'mock') return { headers, removed: [], reasons: [] };
  const out = l.rule.action.headers ?? {};
  // the store's own marker (`truncated`) stays next to the limited one
  const own = Object.entries(headers).find(([k]) => k.toLowerCase() === NO_EXAMPLE_HEADER)?.[1];
  if (own && out[NO_EXAMPLE_HEADER] !== undefined) setHeader(out, NO_EXAMPLE_HEADER, `${own}, ${out[NO_EXAMPLE_HEADER]}`);
  return { headers: out, removed: l.removed, reasons: l.reasons };
}

/**
 * CONTRACTS §24.3: headers whose value is never rendered (dynamic values, `{{variables}}`): the ones an approval is
 * about (§21.16) — what was approved is the text in the file — plus the content type and our own marker.
 */
export function isLimitedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'location' ||
    lower === 'refresh' ||
    lower === 'set-cookie' ||
    lower === 'set-cookie2' ||
    lower === 'content-type' ||
    lower === NO_EXAMPLE_HEADER ||
    lower.startsWith('access-control-') ||
    lower.startsWith('content-security-policy') ||
    lower.startsWith('x-forwarded-')
  );
}

// ------------------------------------------------------------------ problem lines

const CONTROLS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;
export const MAX_LINE = 300;

/** One readable line: no control or bidi characters, no `user:password@` in URLs, at most `max` characters. */
export function cleanLine(text: string, max = MAX_LINE): string {
  const t = String(text).replace(CONTROLS, ' ').replace(BIDI, '').replace(URL_USERINFO, '$1***@').replace(/ {2,}/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
