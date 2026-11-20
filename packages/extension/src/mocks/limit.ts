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
