/**
 * From a parsed collection to `mock` rules (CONTRACTS §21.5). Pure: no vscode, no fs.
 *
 * Every regex is built only from escaped literals and the fixed pieces below, which pass the proxy's
 * `isSafeRegexSource` (REVIEW-4 #2): at most 2 unbounded quantifiers, at most 1 on a wide atom, ≤ 256 characters.
 * An endpoint whose regex would be longer is not mocked (REVIEW-15 #3: the old glob fallback could turn one request
 * into a catch-all). Text from the collection never reaches a RegExp unescaped, and only plain host names and
 * methods become rules.
 */
import type { Rule } from '@flutter-intercept/proxy';
import {
  COLLECTION_LIMITS,
  COLLECTION_RULE_PREFIX,
  NO_EXAMPLE_HEADER,
  NO_EXAMPLE_HEADER_VALUE,
  type MockEndpoint,
  type MockExample,
  type ParsedCollection,
  type ToRules,
  type ToRulesOptions,
  type ToRulesStats,
  type CollectionRuleMeta,
} from './types';

/** Longest regex source the proxy accepts (`MAX_REGEX_SOURCE` in packages/proxy/src/rules.ts). */
export const MAX_SOURCE = 256;
const MAX_NAME = 200;

/** A path parameter: any characters but a separator, bounded (not a wide unbounded atom). */
const PARAM = `[^/?#]{1,${COLLECTION_LIMITS.paramChars}}`;
/** End of the path: an optional trailing slash, then the query, the fragment or the end. */
const PATH_END = '\\/?(?:[?#]|$)';
/** Characters a query string may hold before `&<name>=` (a narrow class, so the lookahead stays cheap). */
const QUERY_CHARS = "[\\w.~%+=,;:@!$'()*\\/?&-]";

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BAD_HEADER_VALUE = /[\r\n\0]/;

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Escapes every character with a meaning in a regex (and `/`, the literal's delimiter). */
export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/** RFC 3986 sub-delims plus `:` and `@`: what a path segment may hold unencoded (Dart's `Uri` leaves them so). */
const PCHAR_SUBDELIMS = /%(?:21|24|26|27|28|29|2A|2B|2C|3B|3D|3A|40)/gi;

function encodeAll(s: string): string | undefined {
  try {
    return encodeURIComponent(s);
  } catch {
    return undefined; // a lone surrogate: only the literal
  }
}

/**
 * A literal as an HTTP client sends it, as whole-literal alternatives (REVIEW-15 #3: per-character alternatives made
 * non-ASCII paths, such as Arabic ones, too long for the proxy's 256-character limit): as written; fully
 * percent-encoded (`encodeURIComponent`); and, for a path segment, Dart's `Uri` form (sub-delims, `:` and `@` kept);
 * for a query, with `+` for spaces (`Uri(queryParameters:)`). Hex case doesn't matter (the regex has the `i` flag).
 * The group is never quantified, so the regex stays safe.
 */
function flexibleLiteral(s: string, inQuery: boolean): string {
  const enc = encodeAll(s);
  const forms = [s];
  if (enc !== undefined) {
    forms.push(enc);
    forms.push(inQuery ? enc.replace(/%20/g, '+') : enc.replace(PCHAR_SUBDELIMS, (m) => decodeURIComponent(m)));
  }
  const unique = [...new Set(forms.map(escapeRegex))];
  return unique.length === 1 ? unique[0] : `(?:${unique.join('|')})`;
}

/** A plain host name (letters, digits, `-`, `_`, dots) or a bracketed IPv6 address: never `*` or other wildcards. */
const HOST_NAME = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;
/** An HTTP method as a word (no `*`, which the proxy reads as "any method"). */
const METHOD = /^[A-Z]{1,20}$/;

interface OriginParts {
  /** The escaped origin plus `(?::443)?` when it has no port. */
  source: string;
  /** As given (lower-case host, default port dropped by the parser). */
  text: string;
}

function originParts(origin: string): OriginParts | undefined {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (!HOST_NAME.test(u.hostname) || u.username || u.password) return undefined;
  const text = `${u.protocol}//${u.host}`.toLowerCase();
  const def = DEFAULT_PORTS[u.protocol];
  return { text, source: escapeRegex(text) + (u.port === '' && def ? `(?::${def})?` : '') };
}

/** One lookahead per parameter (`?page=2` anywhere in the query). */
function queryLookahead(name: string, value: string): string {
  const pair = `${flexibleLiteral(name, true)}=${flexibleLiteral(value, true)}`;
  return `(?=(?:${QUERY_CHARS}*&)?${pair}(?:[&#]|$))`;
}

/** The path part of the source: `\/users\/[^/?#]{1,100}`. */
function pathSource(e: MockEndpoint): string {
  return e.path.map((s) => `\\/${typeof s === 'string' ? flexibleLiteral(s, false) : PARAM}`).join('');
}

/** `/users/:id` for names and messages. */
export function displayPath(e: Pick<MockEndpoint, 'path'>): string {
  return `/${e.path.map((s) => (typeof s === 'string' ? s : `:${s.param}`)).join('/')}`;
}

/** Cut in the middle so both ends stay readable. */
export function cutMiddle(s: string, max = MAX_NAME): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

/** A plain object built with defineProperty, so a header named `__proto__` stays a header. */
function headerObject(entries: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of entries) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

/** Example headers that a rule can carry: valid names, no CR / LF / NUL. Skipped names go to `dropped`. */
function cleanHeaders(h: Readonly<Record<string, string>>, dropped: string[]): Record<string, string> {
  const ok: [string, string][] = [];
  for (const [k, v] of Object.entries(h)) {
    if (TOKEN.test(k) && typeof v === 'string' && !BAD_HEADER_VALUE.test(v)) ok.push([k, v]);
    else dropped.push(k.slice(0, 60));
  }
  return headerObject(ok);
}

const is2xx = (x: MockExample) => x.status >= 200 && x.status <= 299;

/** Examples a rule can answer with (the parsers guarantee this; checked again because rules reach the proxy). */
function usable(x: MockExample): boolean {
  return Number.isInteger(x.status) && x.status >= 100 && x.status <= 599 && typeof x.body === 'string' && typeof x.name === 'string';
}

/** §21.5: the example the endpoint's default rule answers with. */
function defaultExample(e: MockEndpoint, selected: string | undefined): { example: MockExample; missingSelection: boolean } | undefined {
  if (!e.examples.length) return undefined;
  if (selected !== undefined) {
    const chosen = e.examples.find((x) => x.name === selected);
    if (chosen) return { example: chosen, missingSelection: false };
  }
  return { example: e.examples.find(is2xx) ?? e.examples[0], missingSelection: selected !== undefined };
}

function noExampleBody(e: MockEndpoint, collection: string): string {
  return JSON.stringify({
    error: 'no_example',
    message: `No example response is saved for ${e.method} ${displayPath(e)} in ${collection}. Add an example to the collection, or mock this request with a rule.`,
  });
}

/** Sort key (§21.5): more literal segments, then fewer params, then longer paths, then file order. */
function specificity(e: MockEndpoint): [number, number, number] {
  const params = e.path.filter((s) => typeof s !== 'string').length;
  return [e.path.length - params, params, e.path.length];
}

interface Draft {
  match: Rule['match'];
  action: Rule['action'];
  name: string;
  meta: CollectionRuleMeta;
}

export const toRules: ToRules = (parsed: ParsedCollection, opts: ToRulesOptions) => {
  const stats: ToRulesStats = { endpoints: parsed.endpoints.length, mocked: 0, noExample: 0, unresolved: 0, off: 0, generated: 0, tooLong: 0 };
  const problems: string[] = [];
  const off = new Set(opts.off);
  const prefix = `${opts.name} › `;
  const groups: { endpoint: MockEndpoint; index: number; drafts: Draft[] }[] = [];
  const origins = new Map<string, OriginParts>();

  parsed.endpoints.forEach((raw, index) => {
    const e: MockEndpoint = { ...raw, examples: raw.examples.filter(usable) };
    const label = `${e.method} ${displayPath(e)}`;
    if (e.examples.length < raw.examples.length) problems.push(`${label}: ${raw.examples.length - e.examples.length} example(s) with an invalid status or body left out`);
    if (off.has(e.key)) {
      stats.off++;
      const o = e.origin && originParts(e.origin);
      if (o) origins.set(o.text, o); // still "in the collection" for the unmatched rule (§21.5)
      return;
    }
    if (!e.origin || e.unresolved.length) {
      stats.unresolved++;
      return;
    }
    const origin = originParts(e.origin);
    if (!origin) {
      problems.push(`${label}: the origin isn't a plain http or https host name (not mocked)`);
      stats.unresolved++;
      return;
    }
    origins.set(origin.text, origin);
    const method = e.method.toUpperCase();
    if (!METHOD.test(method)) {
      problems.push(`${displayPath(e).slice(0, 120)}: the method isn't a plain HTTP method name (not mocked)`);
      return;
    }

    const base = `^${origin.source}${pathSource(e)}`;
    if (base.length + PATH_END.length > MAX_SOURCE) {
      // REVIEW-15 #3: never a looser pattern (a glob answered other paths, and with a wildcard host every host)
      stats.tooLong++;
      problems.push(`${label}: the URL is too long to match exactly (a rule's pattern is limited to ${MAX_SOURCE} characters), so it isn't mocked; mock it with a rule instead`);
      return;
    }
    const drafts: Draft[] = [];
    const dropped: string[] = [];
    const ruleName = (exampleName: string) => cutMiddle(`${prefix}${e.name} · ${exampleName}`);

    // Examples chosen by query parameters (§21.5): their own rules, before the default one.
    const byQuery = e.examples
      .map((x, i) => ({ x, i, keys: x.query ? Object.keys(x.query).sort() : [] }))
      .filter((q) => q.keys.length > 0)
      .sort((a, b) => b.keys.length - a.keys.length || a.i - b.i);
    {
      for (const { x, keys } of byQuery) {
        const used = keys.slice(0, COLLECTION_LIMITS.exampleQueryParams);
        if (keys.length > used.length) {
          problems.push(`${label}: example "${x.name.slice(0, 60)}" is chosen by ${used.join(' and ')} only (at most ${COLLECTION_LIMITS.exampleQueryParams} query parameters)`);
        }
        const source = `${base}\\/?\\?${used.map((k) => queryLookahead(k, x.query![k])).join('')}`;
        if (source.length > MAX_SOURCE) {
          problems.push(`${label}: example "${x.name.slice(0, 60)}" can't be chosen by its query parameters (too long); the default example answers instead`);
          continue;
        }
        drafts.push({
          match: { method, url: `/${source}/i` },
          action: { kind: 'mock', status: x.status, headers: cleanHeaders(x.headers, dropped), body: x.body },
          name: ruleName(x.name),
          meta: { endpoint: e.key, example: x.name },
        });
      }
    }

    // The default rule.
    const url = `/${base}${PATH_END}/i`;
    const chosen = defaultExample(e, opts.selected[e.key]);
    if (chosen) {
      if (chosen.missingSelection) {
        problems.push(`${label}: the selected example "${opts.selected[e.key].slice(0, 60)}" isn't in the collection any more; "${chosen.example.name.slice(0, 60)}" answers instead`);
      }
      const x = chosen.example;
      drafts.push({ match: { method, url }, action: { kind: 'mock', status: x.status, headers: cleanHeaders(x.headers, dropped), body: x.body }, name: ruleName(x.name), meta: { endpoint: e.key, example: x.name } });
      stats.mocked++;
      if (x.generated) stats.generated++;
    } else {
      drafts.push({
        match: { method, url },
        action: {
          kind: 'mock',
          status: 501,
          headers: headerObject([
            ['content-type', 'application/json; charset=utf-8'],
            [NO_EXAMPLE_HEADER, NO_EXAMPLE_HEADER_VALUE],
          ]),
          body: noExampleBody(e, opts.name),
        },
        name: ruleName('no example'),
        meta: { endpoint: e.key, noExample: true },
      });
      stats.noExample++;
    }
    if (dropped.length) {
      problems.push(`${label}: header${dropped.length > 1 ? 's' : ''} ${[...new Set(dropped)].slice(0, 5).map((d) => `"${d}"`).join(', ')} can't be sent (invalid name or value) and ${dropped.length > 1 ? 'were' : 'was'} left out`);
    }
    groups.push({ endpoint: e, index, drafts });
  });

  groups.sort((a, b) => {
    const [la, pa, na] = specificity(a.endpoint);
    const [lb, pb, nb] = specificity(b.endpoint);
    return lb - la || pa - pb || nb - na || a.index - b.index;
  });

  const drafts: Draft[] = groups.flatMap((g) => g.drafts);
  if (opts.unmatched === 'fail') {
    for (const o of origins.values()) {
      drafts.push({
        match: { url: `/^${o.source}(?:[\\/?#]|$)/i` },
        action: { kind: 'block', mode: 'reset' },
        name: cutMiddle(`${prefix}not in the collection`),
        meta: { unmatched: true },
      });
    }
  }

  const meta = new Map<string, CollectionRuleMeta>();
  const rules: Rule[] = drafts.map((d, i) => {
    const id = `${COLLECTION_RULE_PREFIX}${opts.id}:${i + 1}`;
    meta.set(id, d.meta);
    return { id, enabled: true, name: d.name, match: d.match, action: d.action };
  });
  return { rules, stats, problems, meta };
};
