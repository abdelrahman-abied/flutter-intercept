/**
 * v0.15.0 (CONTRACTS §21): pure helpers for the Collections section and the 501 no-example banner.
 * No DOM, no postMessage. Hostile-input safe: no RegExp on external strings, Maps for file-derived keys,
 * respects COLLECTION_LIMITS and clips displayed names at 200 characters.
 */
import { formatJson } from './json';
import type { CollectionEndpointView, CollectionStatus, Exchange } from './protocol';
import { headerValue } from './util';

/** CONTRACTS §21.1 / §21.8: mirror of `COLLECTION_LIMITS` from `packages/extension/src/mocks/types.ts`. */
export const COLLECTION_LIMITS = {
  endpoints: 2000,
  examplesPerEndpoint: 20,
  folderDepth: 32,
  linksPerFile: 20,
  panelBodyBytes: 256 * 1024,
} as const;

export const MAX_COLLECTION_NAME = 200;
export const COLLECTION_RULE_PREFIX = 'collection:';
export const NO_EXAMPLE_HEADER = 'x-flutter-intercept';
export const NO_EXAMPLE_HEADER_VALUE = 'no-example';
export const ENDPOINT_INITIAL_CAP = 100;
export const ENDPOINT_PAGE_STEP = 200;

export interface CollectionExampleView {
  id: string;
  endpoint: string;
  name: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated?: true;
}

/** Clip any host/file-supplied display name at 200 characters with "…" (CONTRACTS §21.9). */
export function clipName(text: unknown, max = MAX_COLLECTION_NAME): string {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (s.length <= max) return s;
  return max > 1 ? `${s.slice(0, max - 1)}…` : '…';
}

/** Unambiguous cache key for `(collectionId, endpointKey, exampleName)` in a Map. */
export function collectionExampleCacheKey(id: string, endpoint: string, name: string): string {
  return JSON.stringify([id, endpoint, name]);
}

/** CONTRACTS §21.9: "42 mocked · 3 without an example · 1 off" (leave out zero parts except "mocked"). */
export function collectionCountsText(c: Pick<CollectionStatus, 'mocked' | 'noExample' | 'off'>): string {
  const parts = [`${c.mocked} mocked`];
  if (c.noExample > 0) parts.push(`${c.noExample} without an example`);
  if (c.off > 0) parts.push(`${c.off} off`);
  return parts.join(' · ');
}

/**
 * Which example answers right now for an endpoint (CONTRACTS §21.5):
 * `selected` when present in `examples`, else the first 2xx example, else the first example.
 */
export function activeExampleOf(
  ep: Pick<CollectionEndpointView, 'examples' | 'selected'>,
): CollectionEndpointView['examples'][number] | undefined {
  const list = ep.examples ?? [];
  if (!list.length) return undefined;
  if (ep.selected !== undefined) {
    const hit = list.find((e) => e.name === ep.selected);
    if (hit) return hit;
  }
  return list.find((e) => e.status >= 200 && e.status < 300) ?? list[0];
}

/**
 * Case-insensitive filter across `method`, `url` and `name` (CONTRACTS §21.9).
 * Whitespace-separated terms use AND semantics; never puts text into a RegExp.
 */
export function filterEndpoints(endpoints: readonly CollectionEndpointView[], query: string): CollectionEndpointView[] {
  const q = query.trim().toLowerCase();
  if (!q) return endpoints as CollectionEndpointView[];
  const terms = q.split(/\s+/);
  const out: CollectionEndpointView[] = [];
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const m = (ep.method ?? '').toLowerCase();
    const u = (ep.url ?? '').toLowerCase();
    const n = (ep.name ?? '').toLowerCase();
    let ok = true;
    for (let t = 0; t < terms.length; t++) {
      const term = terms[t];
      if (!m.includes(term) && !u.includes(term) && !n.includes(term)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(ep);
  }
  return out;
}

export interface FolderGroup {
  key: string;
  label: string;
  endpoints: CollectionEndpointView[];
}

/**
 * Group endpoints by `folder` in arrival order using a Map (immune to `__proto__` / `constructor` folder names)
 * and respecting `COLLECTION_LIMITS.folderDepth`.
 */
export function groupEndpointsByFolder(endpoints: readonly CollectionEndpointView[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const segs = (Array.isArray(ep.folder) ? ep.folder : [])
      .slice(0, COLLECTION_LIMITS.folderDepth)
      .map((s) => clipName(s));
    const key = segs.join('\0');
    let g = groups.get(key);
    if (!g) {
      g = { key, label: segs.length ? segs.join(' / ') : 'Top level', endpoints: [] };
      groups.set(key, g);
    }
    g.endpoints.push(ep);
  }
  return [...groups.values()];
}

function sliceUtf8Bytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let step = 1;
    let charBytes = 1;
    if (c < 0x80) charBytes = 1;
    else if (c < 0x800) charBytes = 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      charBytes = 4;
      step = 2;
    } else charBytes = 3;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i += step;
  }
  return s.slice(0, i);
}

/** Format an example body for read-only display: pretty JSON when it parses losslessly, capped at 256 KB. */
export function formatExampleBody(raw: unknown): { text: string; isJson: boolean; truncated: boolean } {
  const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  if (!s) return { text: '', isJson: false, truncated: false };
  const sliced = sliceUtf8Bytes(s, COLLECTION_LIMITS.panelBodyBytes);
  const truncated = sliced.length < s.length;
  const pretty = !truncated ? formatJson(sliced) : undefined;
  if (pretty !== undefined) return { text: pretty, isJson: true, truncated: false };
  return { text: sliced, isJson: false, truncated };
}

/** CSS status class suffix ("2xx" | "3xx" | "4xx" | "5xx" | "none") for a numeric HTTP status. */
export function statusClassSuffix(status: number): string {
  const c = Math.floor(status / 100);
  return c >= 2 && c <= 5 ? `${c}xx` : 'none';
}

/** CONTRACTS §21.5 / §21.9: true when the exchange carries `x-flutter-intercept: no-example`. */
export function isNoExampleExchange(ex: Pick<Exchange, 'responseHeaders'>): boolean {
  const v = headerValue(ex.responseHeaders, NO_EXAMPLE_HEADER);
  return v !== undefined && v.trim().toLowerCase() === NO_EXAMPLE_HEADER_VALUE;
}

/** Extract `<id>` from a collection rule id `collection:<id>:<n>` (CONTRACTS §21.5, §21.8). */
export function collectionIdFromRuleId(ruleId: string | undefined): string | undefined {
  if (!ruleId || !ruleId.startsWith(COLLECTION_RULE_PREFIX)) return undefined;
  const rest = ruleId.slice(COLLECTION_RULE_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0 || sep >= rest.length - 1) return undefined;
  return rest.slice(0, sep);
}

/**
 * Collection name for the 501 no-example banner (CONTRACTS §21.8, §21.9):
 * resolved from `Exchange.matchedRuleId` (`collection:<id>:<n>`) via `Status.collections`, else "the collection".
 */
export function noExampleCollectionName(
  ex: Pick<Exchange, 'matchedRuleId'>,
  collections?: readonly CollectionStatus[],
): string {
  const colId = collectionIdFromRuleId(ex.matchedRuleId);
  if (colId) {
    const col = collections?.find((c) => c.id === colId);
    if (col?.name) return clipName(col.name);
  }
  return 'the collection';
}

/** Unique HTTP(S) origins seen in recent traffic (newest first, capped), offered when setting URL variables. */
export function knownRequestOrigins(exchanges: readonly Pick<Exchange, 'url'>[], max = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = exchanges.length - 1; i >= 0 && out.length < max; i--) {
    try {
      const u = new URL(exchanges[i].url);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !seen.has(u.origin)) {
        seen.add(u.origin);
        out.push(u.origin);
      }
    } catch {
      // ignore non-URL strings
    }
  }
  return out;
}

// ------------------------------------------------------------------ W2: approval, "changed for you", what's missing

/** CONTRACTS §21.16: "Some answers are limited until you approve: sets cookies, redirects" (undefined: nothing limited). */
export function limitedText(limited: CollectionStatus['limited']): string | undefined {
  if (!limited || limited.answers <= 0) return undefined;
  const reasons = (limited.reasons ?? []).map((r) => clipName(r, 80)).filter(Boolean).slice(0, 5);
  return `Some answers are limited until you approve${reasons.length ? `: ${reasons.join(', ')}` : ''}`;
}

/** CONTRACTS §21.15: "2 changes for you" (undefined: none). */
export function overridesText(overrides: number | undefined): string | undefined {
  if (!overrides || overrides <= 0) return undefined;
  return `${overrides} change${overrides === 1 ? '' : 's'} for you`;
}

/** CONTRACTS §21.15 #4: "3 requests not in the collection · 2 answered 501 (no example)" (undefined: nothing seen). */
export function seenSummaryText(seen: CollectionStatus['seen']): string | undefined {
  if (!seen) return undefined;
  const sum = (list: readonly { count: number }[] | undefined) => (list ?? []).length;
  const missing = sum(seen.notInCollection);
  const noExample = sum(seen.noExample);
  const parts: string[] = [];
  if (missing) parts.push(`${missing} request${missing === 1 ? '' : 's'} not in the collection`);
  // "answered 501", not "without an example": the counts line above already says how many endpoints lack one
  if (noExample) parts.push(`${noExample} answered 501 (no example)`);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * The newest listed exchange for a `seen.notInCollection` entry: same method, an origin of the collection, and a
 * path that fits the host's path template (`/users/{id}` — `{…}` stands for one segment). Undefined when none is
 * listed any more (cleared), so the panel can say how to get one.
 */
export function exchangeForSeen(
  exchanges: readonly Pick<Exchange, 'id' | 'method' | 'url'>[],
  origins: readonly string[],
  method: string,
  pathTemplate: string,
): Pick<Exchange, 'id'> | undefined {
  const want = pathTemplate.split('/');
  const fits = (pathname: string) => {
    const got = pathname.split('/');
    if (got.length !== want.length) return false;
    return want.every((seg, i) => (/^\{[^/{}]*\}$/.test(seg) ? got[i] !== '' : seg === got[i]));
  };
  const originSet = new Set(origins);
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const ex = exchanges[i];
    if (ex.method.toUpperCase() !== method.toUpperCase()) continue;
    let u: URL;
    try {
      u = new URL(ex.url);
    } catch {
      continue;
    }
    if (originSet.size && !originSet.has(u.origin)) continue;
    if (fits(u.pathname)) return ex;
  }
  return undefined;
}

/**
 * CONTRACTS §21.17: a collection answer sent in its limited form carries `x-flutter-intercept: limited; removed=a,b`.
 * Returns what was removed (header names, or "none"), or undefined when the answer isn't limited.
 */
export function limitedRemoved(ex: Pick<Exchange, 'responseHeaders'>): string[] | undefined {
  const v = headerValue(ex.responseHeaders, NO_EXAMPLE_HEADER);
  if (v === undefined || !/^\s*limited\b/i.test(v)) return undefined;
  const m = /removed=([^;]*)/i.exec(v);
  return (m ? m[1].split(',') : []).map((s) => clipName(s.trim(), 60)).filter((s) => s && s !== 'none').slice(0, 8);
}
