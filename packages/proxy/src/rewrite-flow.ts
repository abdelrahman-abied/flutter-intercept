// Rewrite rules (CONTRACTS §12.6): header sets, the rewrite plan and body replacements. Pure.

import { isUtf8 } from 'buffer';
import { decodeStrict, type HeaderBag } from './body';
import { MAX_BODY_REPLACEMENTS } from './rules';
import { RESPONSE_PAUSE_LIMIT_BYTES } from './taps';
import { TRACE_HEADER } from './trace';
import type { RewriteSpec } from './types';
import type { RewriteAction, RewriteFlow, HeaderSets, ReplaceOutcome } from './flow-types';
import { MB, SEND_HEADER, HTTP_TOKEN } from './proxy-util';

/** Headers a rewrite can't set or remove: framing, hop-by-hop and internal ones (the proxy manages them). */
export const REWRITE_SKIPPED = new Set([
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'host', // request: handled with Map Remote's Host logic (rewriteHostOf)
  TRACE_HEADER,
  SEND_HEADER,
]);

export const validHeaderValue = (v: unknown): v is string => typeof v === 'string' && !/[\r\n\0]/.test(v);

/** The valid header changes of a RewriteSpec (invalid names / values and managed headers are ignored). */
export function rewriteSets(spec: RewriteSpec | undefined, _response = false): HeaderSets {
  const remove = new Set<string>();
  const set: Array<[string, string]> = [];
  for (const n of spec?.removeHeaders ?? []) {
    const l = String(n).trim().toLowerCase();
    if (HTTP_TOKEN.test(l) && !REWRITE_SKIPPED.has(l)) remove.add(l);
  }
  for (const [k, v] of Object.entries(spec?.setHeaders ?? {})) {
    const l = k.trim().toLowerCase();
    if (!HTTP_TOKEN.test(l) || REWRITE_SKIPPED.has(l) || !validHeaderValue(v)) continue;
    set.push([k.trim(), v]);
  }
  return { remove: [...remove], set };
}

/** A Host header set by a request rewrite (CONTRACTS §12.6), if valid. */
export function rewriteHostOf(spec: RewriteSpec | undefined): string | undefined {
  for (const [k, v] of Object.entries(spec?.setHeaders ?? {})) {
    if (k.trim().toLowerCase() === 'host' && validHeaderValue(v) && v.trim()) return v.trim();
  }
  return undefined;
}

export function rewritePairs(pairs: Array<[string, string]>, sets: HeaderSets): Array<[string, string]> {
  const drop = new Set([...sets.remove, ...sets.set.map(([k]) => k.toLowerCase())]);
  const out = pairs.filter(([k]) => !drop.has(String(k).toLowerCase()));
  for (const p of sets.set) out.push([p[0], p[1]]);
  return out;
}

export function pairValue(pairs: Array<[string, string]>, name: string): string | undefined {
  return pairs.find(([k]) => String(k).toLowerCase() === name)?.[1];
}

export function pairsToObject(pairs: Array<[string, string]>): HeaderBag {
  const out: HeaderBag = {};
  for (const [k, v] of pairs) {
    const l = String(k).toLowerCase();
    const prev = out[l];
    out[l] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

export function headerPairs(h: HeaderBag): Array<[string, string]> {
  return Object.entries(h).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string])));
}

export const validRewriteStatus = (s: unknown): s is number => Number.isInteger(s) && (s as number) >= 200 && (s as number) <= 599;

export function rewriteFlow(a: RewriteAction): RewriteFlow {
  const ok = (r: RewriteSpec['replaceBody']) => (r ?? []).some((x) => typeof x?.find === 'string' && x.find !== '');
  return {
    ...(a.request ? { request: a.request } : {}),
    ...(a.response ? { response: a.response } : {}),
    reqBody: ok(a.request?.replaceBody),
    resBody: ok(a.response?.replaceBody),
  };
}

export function rewriteLabel(rw: RewriteFlow): string {
  const parts: string[] = [];
  const rq = rw.request;
  const rs = rw.response;
  if (rq && (rewriteSets(rq).remove.length || rewriteSets(rq).set.length || rewriteHostOf(rq))) parts.push('request headers');
  if (rw.reqBody) parts.push('request body');
  if (rs?.status !== undefined && validRewriteStatus(rs.status)) parts.push(`status ${rs.status}`);
  if (rs && (rewriteSets(rs, true).remove.length || rewriteSets(rs, true).set.length)) parts.push('response headers');
  if (rw.resBody) parts.push('response body');
  return parts.length ? `Rewritten: ${parts.join(', ')}` : 'Rewrite (nothing to change)';
}

/** Most a body replacement may produce (REVIEW-6 #3), whatever the input. */
export const REWRITE_OUTPUT_MAX_BYTES = 64 * MB;

/** The output budget for a body of `input` bytes: ≤ 64 MB and ≤ max(4 × input, input + 1 MB). */
export function rewriteOutputBudget(input: number): number {
  return Math.min(REWRITE_OUTPUT_MAX_BYTES, Math.max(4 * input, input + MB));
}

export const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Literal find / replace on a complete body's decoded UTF-8 text (≤ MAX_BODY_REPLACEMENTS, in order). Bounded
 * (REVIEW-6 #3): before each replacement the result size is computed from the occurrences (counting stops as soon
 * as it would pass the budget), and a body that would grow past `rewriteOutputBudget` is left unchanged. Yields to
 * the event loop between replacements.
 */
export async function replaceInBody(raw: Buffer, contentEncoding: string | undefined, list: NonNullable<RewriteSpec['replaceBody']>): Promise<ReplaceOutcome> {
  let decoded: Buffer;
  try {
    decoded = await decodeStrict(raw, contentEncoding, RESPONSE_PAUSE_LIMIT_BYTES);
  } catch (e) {
    return { kind: 'skipped', reason: `it could not be decoded (${(e as Error).message})` };
  }
  if (!isUtf8(decoded)) return { kind: 'skipped', reason: 'it is not UTF-8 text' };
  const budget = rewriteOutputBudget(decoded.length);
  const bom = decoded.length >= 3 && decoded[0] === 0xef && decoded[1] === 0xbb && decoded[2] === 0xbf;
  let text = decoded.subarray(bom ? 3 : 0).toString('utf8');
  let bytes = decoded.length;
  let unmatched = 0;
  for (const r of list.slice(0, MAX_BODY_REPLACEMENTS)) {
    if (typeof r?.find !== 'string' || r.find === '' || typeof r.replace !== 'string') continue;
    await yieldToLoop();
    const growth = Buffer.byteLength(r.replace, 'utf8') - Buffer.byteLength(r.find, 'utf8');
    let count = 0;
    for (let at = text.indexOf(r.find); at >= 0; at = text.indexOf(r.find, at + r.find.length)) {
      count++;
      if (growth > 0 && bytes + count * growth > budget) {
        return {
          kind: 'skipped',
          reason:
            `the replacements would make it larger than ${(budget / MB).toFixed(1)} MB ` +
            `(at most 4 × its size or +1 MB, and never over ${REWRITE_OUTPUT_MAX_BYTES / MB} MB)`,
        };
      }
      if (!r.all) break;
    }
    if (!count) {
      unmatched++;
      continue;
    }
    text = r.all ? text.split(r.find).join(r.replace) : text.replace(r.find, () => r.replace);
    bytes += count * growth;
  }
  const out = Buffer.from(text, 'utf8');
  return { kind: 'done', decoded: bom ? Buffer.concat([decoded.subarray(0, 3), out]) : out, unmatched };
}

