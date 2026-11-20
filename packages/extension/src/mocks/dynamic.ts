/**
 * Dynamic values in example bodies (CONTRACTS §24.3). Pure: no vscode, no fs, no network, no dependency.
 *
 * `renderDynamic(text, ctx)` replaces Postman-style placeholders:
 * - `{{$name}}` from the supported list below (anything else — images, finance, passwords, user agents — is left as
 *   written, named once in a problem line);
 * - plain `{{name}}` only from `ctx.vars` (the caller passes link `variables` + the collection's own `variable[]`,
 *   never environment-file values, §21.6); a name not in `ctx.vars` is left as written.
 *
 * Inside a JSON string (`ctx.json`) the value is JSON-escaped; outside one it is inserted as it is (so
 * `"n": {{$randomInt}}` stays a number). At most `MAX_PLACEHOLDERS` replacements per text; the output is at most
 * `COLLECTION_LIMITS.exampleBodyBytes` (over → the text is returned unchanged, with a problem line: never cut).
 *
 * Modes: `'random'` (a fresh mulberry32 seed per call, `ctx.nowMs ?? Date.now()`), `'seeded'` (mulberry32 seeded with
 * `ctx.seed ?? 0`; the same text, seed and `nowMs` always give the same output; without `nowMs` the clock is the fixed
 * base below), `'fixed'` (the §21.4 constants: the nil-v4 uuid, `2026-01-01T00:00:00Z`, `user@example.com`,
 * `192.0.2.1`, `2001:db8::1`, `https://example.com`, `0`, `true`, and the first entry of each word list).
 */
import { COLLECTION_LIMITS } from './types';

export type DynamicMode = 'random' | 'seeded' | 'fixed';

export interface DynamicContext {
  mode: DynamicMode;
  /** `'seeded'` only (default 0). */
  seed?: number;
  /** Link variables + the collection's own variables. Never environment values. */
  vars?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  /** The text is JSON: values inside JSON strings are escaped. */
  json: boolean;
  /** The clock for `$timestamp`, `$isoTimestamp` and the `$randomDate…` names (ms since the epoch). */
  nowMs?: number;
}

export const MAX_PLACEHOLDERS = 1000;
/** The clock in `'fixed'` mode and in `'seeded'` mode without `nowMs`: §21.4's `2026-01-01T00:00:00Z`. */
export const FIXED_NOW_MS = Date.UTC(2026, 0, 1);
const MAX_NAME_CHARS = 100;
const MAX_UNSUPPORTED_NAMED = 5;
const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ PRNG

/** mulberry32: a small, fast 32-bit PRNG; deterministic for a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ word lists (~2 KB)

const FIRST = ['Sara', 'Omar', 'Lina', 'Adam', 'Maya', 'Yusuf', 'Nora', 'Karim', 'Emma', 'Liam', 'Aisha', 'Noah', 'Hana', 'Ali', 'Zoe', 'Sami'];
const LAST = ['Hassan', 'Smith', 'Khalil', 'Garcia', 'Nasser', 'Brown', 'Mansour', 'Lee', 'Haddad', 'Martin', 'Saleh', 'Wilson', 'Farah', 'Taylor'];
const CITY = ['Cairo', 'Riyadh', 'Dubai', 'London', 'Berlin', 'Lisbon', 'Austin', 'Toronto', 'Tokyo', 'Nairobi', 'Oslo', 'Madrid'];
const STREET = ['Main', 'Oak', 'Park', 'Cedar', 'Lake', 'Hill', 'Nile', 'Palm', 'River', 'Elm'];
const STREET_SUFFIX = ['Street', 'Avenue', 'Road', 'Lane', 'Way'];
const COUNTRY: [string, string][] = [
  ['Egypt', 'EG'], ['Saudi Arabia', 'SA'], ['United Arab Emirates', 'AE'], ['United Kingdom', 'GB'], ['Germany', 'DE'],
  ['Portugal', 'PT'], ['United States', 'US'], ['Canada', 'CA'], ['Japan', 'JP'], ['Kenya', 'KE'], ['Norway', 'NO'], ['Spain', 'ES'],
];
const COMPANY_SUFFIX = ['Group', 'LLC', 'Inc', 'and Sons', 'Labs', 'Partners'];
const JOB_LEVEL = ['Senior', 'Lead', 'Junior', 'Principal', 'Chief'];
const JOB_AREA = ['Data', 'Product', 'Mobile', 'Security', 'Marketing', 'Finance'];
const JOB_TYPE = ['Engineer', 'Designer', 'Manager', 'Analyst', 'Officer', 'Specialist'];
const PRODUCT_ADJ = ['Small', 'Ergonomic', 'Rustic', 'Sleek', 'Handmade', 'Smart'];
const PRODUCT_MAT = ['Steel', 'Wooden', 'Cotton', 'Granite', 'Rubber', 'Bamboo'];
const PRODUCT = ['Chair', 'Table', 'Lamp', 'Shoes', 'Gloves', 'Keyboard', 'Bottle', 'Watch'];
const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor',
  'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim', 'minim', 'veniam', 'quis', 'nostrud',
];
const WORDS = ['river', 'orange', 'pixel', 'garden', 'rocket', 'silver', 'harbor', 'maple', 'signal', 'canvas', 'summit', 'velvet'];
const COLOR = ['red', 'blue', 'green', 'orange', 'purple', 'teal', 'yellow', 'black', 'white', 'silver'];
const CURRENCY = ['USD', 'EUR', 'GBP', 'EGP', 'SAR', 'AED', 'JPY', 'CAD'];
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

// ------------------------------------------------------------------ generators

interface Gen {
  rng: () => number;
  fixed: boolean;
  nowMs: number;
}

function int(g: Gen, min: number, max: number): number {
  return min + Math.floor(g.rng() * (max - min + 1));
}

function pick<T>(g: Gen, list: readonly T[]): T {
  return list[Math.floor(g.rng() * list.length) % list.length];
}

function hex(g: Gen, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(g.rng() * 16).toString(16);
  return s;
}

function uuid(g: Gen): string {
  const variant = (8 + Math.floor(g.rng() * 4)).toString(16);
  return `${hex(g, 8)}-${hex(g, 4)}-4${hex(g, 3)}-${variant}${hex(g, 3)}-${hex(g, 12)}`;
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

function sentence(g: Gen): string {
  const n = int(g, 6, 10);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(pick(g, LOREM));
  return `${capitalise(words.join(' '))}.`;
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Each supported name → its generator. A null-prototype table, so `$constructor` is simply unsupported. */
const GENERATORS: Record<string, (g: Gen) => string> = Object.assign(Object.create(null) as Record<string, (g: Gen) => string>, {
  $guid: uuid,
  $randomUUID: uuid,
  $timestamp: (g: Gen) => String(Math.floor(g.nowMs / 1000)),
  $isoTimestamp: (g: Gen) => (g.fixed ? isoSeconds(g.nowMs) : new Date(g.nowMs).toISOString()),
  $randomInt: (g: Gen) => String(int(g, 0, 1000)),
  $randomBoolean: (g: Gen) => (g.rng() < 0.5 ? 'true' : 'false'),
  $randomAlphaNumeric: (g: Gen) => pick(g, ALNUM.split('')),
  $randomEmail: (g: Gen) =>
    g.fixed ? 'user@example.com' : `${pick(g, FIRST).toLowerCase()}.${pick(g, LAST).toLowerCase()}@${pick(g, ['example.com', 'example.net', 'example.org'])}`,
  $randomExampleEmail: (g: Gen) =>
    g.fixed ? 'user@example.com' : `${pick(g, FIRST).toLowerCase()}${int(g, 1, 99)}@${pick(g, ['example.com', 'example.net', 'example.org'])}`,
  $randomUserName: (g: Gen) => `${pick(g, FIRST).toLowerCase()}_${pick(g, LAST).toLowerCase()}${g.fixed ? '' : int(g, 1, 99)}`,
  $randomFirstName: (g: Gen) => pick(g, FIRST),
  $randomLastName: (g: Gen) => pick(g, LAST),
  $randomFullName: (g: Gen) => `${pick(g, FIRST)} ${pick(g, LAST)}`,
  $randomPhoneNumber: (g: Gen) => `555-${String(int(g, 0, 999)).padStart(3, '0')}-${String(int(g, 0, 9999)).padStart(4, '0')}`,
  $randomCity: (g: Gen) => pick(g, CITY),
  $randomStreetAddress: (g: Gen) => `${int(g, 1, 999)} ${pick(g, STREET)} ${pick(g, STREET_SUFFIX)}`,
  $randomCountry: (g: Gen) => pick(g, COUNTRY)[0],
  $randomCountryCode: (g: Gen) => pick(g, COUNTRY)[1],
  $randomLatitude: (g: Gen) => (g.rng() * 180 - (g.fixed ? 0 : 90)).toFixed(4),
  $randomLongitude: (g: Gen) => (g.rng() * 360 - (g.fixed ? 0 : 180)).toFixed(4),
  $randomPrice: (g: Gen) => (int(g, 100, 100_000) / 100).toFixed(2),
  $randomProductName: (g: Gen) => `${pick(g, PRODUCT_ADJ)} ${pick(g, PRODUCT_MAT)} ${pick(g, PRODUCT)}`,
  $randomCompanyName: (g: Gen) => `${pick(g, LAST)} ${pick(g, COMPANY_SUFFIX)}`,
  $randomJobTitle: (g: Gen) => `${pick(g, JOB_LEVEL)} ${pick(g, JOB_AREA)} ${pick(g, JOB_TYPE)}`,
  $randomWord: (g: Gen) => pick(g, WORDS),
  $randomWords: (g: Gen) => `${pick(g, WORDS)} ${pick(g, WORDS)} ${pick(g, WORDS)}`,
  $randomLoremWord: (g: Gen) => pick(g, LOREM),
  $randomLoremSentence: sentence,
  $randomLoremParagraph: (g: Gen) => {
    const n = int(g, 3, 5);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(sentence(g));
    return out.join(' ');
  },
  $randomDateFuture: (g: Gen) => isoSeconds(g.nowMs + DAY_MS + Math.floor(g.rng() * 364 * DAY_MS)),
  $randomDatePast: (g: Gen) => isoSeconds(g.nowMs - DAY_MS - Math.floor(g.rng() * 364 * DAY_MS)),
  $randomDateRecent: (g: Gen) => isoSeconds(g.nowMs - 60_000 - Math.floor(g.rng() * DAY_MS)),
  $randomColor: (g: Gen) => pick(g, COLOR),
  $randomHexColor: (g: Gen) => `#${hex(g, 6)}`,
  $randomCurrencyCode: (g: Gen) => pick(g, CURRENCY),
  $randomIP: (g: Gen) => (g.fixed ? '192.0.2.1' : `${int(g, 1, 223)}.${int(g, 0, 255)}.${int(g, 0, 255)}.${int(g, 1, 254)}`),
  $randomIPV6: (g: Gen) => {
    if (g.fixed) return '2001:db8::1';
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) parts.push(hex(g, 4));
    return parts.join(':');
  },
  $randomDomainName: (g: Gen) => (g.fixed ? 'example.com' : `${pick(g, WORDS)}.example.com`),
  $randomUrl: (g: Gen) => (g.fixed ? 'https://example.com' : `https://example.com/${pick(g, WORDS)}`),
});

/** The supported dynamic names (§24.3), for tests and the panel. */
export const DYNAMIC_NAMES: readonly string[] = Object.keys(GENERATORS);

export function isSupportedDynamic(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GENERATORS, name);
}

// ------------------------------------------------------------------ rendering

function varValue(vars: DynamicContext['vars'], name: string): string | undefined {
  if (!vars) return undefined;
  if (vars instanceof Map) {
    const v = vars.get(name);
    return typeof v === 'string' ? v : undefined;
  }
  const rec = vars as Readonly<Record<string, string>>;
  if (!Object.prototype.hasOwnProperty.call(rec, name)) return undefined;
  const v = rec[name];
  return typeof v === 'string' ? v : undefined;
}

/** A placeholder name: no braces, quotes, backslashes or control characters; ≤ 100 chars. */
function isPlaceholderName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x22 /* " */ || c === 0x5c /* \ */ || c === 0x7b /* { */ || c === 0x7d /* } */) {
      return false;
    }
  }
  return true;
}

function jsonEscapeInner(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

function utf8Bytes(s: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).byteLength;
}

/** True when `text` holds at least one `{{…}}` (cheap pre-check for the answer pipeline). */
export function hasPlaceholders(text: string): boolean {
  const open = text.indexOf('{{');
  return open !== -1 && text.indexOf('}}', open + 2) !== -1;
}

/**
 * CONTRACTS §24.3: replaces the supported `{{$dynamic}}` names and the `{{vars}}` the caller passed. Never throws;
 * linear in the text's length.
 */
export function renderDynamic(text: string, ctx: DynamicContext): { text: string; problems: string[] } {
  const problems: string[] = [];
  if (typeof text !== 'string' || !hasPlaceholders(text)) return { text, problems };

  const fixed = ctx.mode === 'fixed';
  const seed = ctx.mode === 'seeded' ? (Number.isFinite(ctx.seed) ? Number(ctx.seed) : 0) : Math.floor(Math.random() * 4294967296);
  const nowMs = fixed
    ? FIXED_NOW_MS
    : typeof ctx.nowMs === 'number' && Number.isFinite(ctx.nowMs)
      ? ctx.nowMs
      : ctx.mode === 'seeded'
        ? FIXED_NOW_MS
        : Date.now();
  const g: Gen = { rng: fixed ? () => 0 : mulberry32(seed), fixed, nowMs };

  const limitChars = COLLECTION_LIMITS.exampleBodyBytes;
  const unsupported: string[] = [];
  let replaced = 0;
  let capped = false;
  let inString = false;
  let out = '';
  let segStart = 0;
  let i = 0;
  /** The next `}}` at or after the last search start; searches only move forward, so the scan stays linear. */
  let nextClose = -2;
  const n = text.length;

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x7b /* { */ && text.charCodeAt(i + 1) === 0x7b) {
      if (nextClose !== -1 && nextClose < i + 2) nextClose = text.indexOf('}}', i + 2);
      const close = nextClose;
      const name = close === -1 || close - (i + 2) > MAX_NAME_CHARS ? undefined : text.slice(i + 2, close);
      if (name !== undefined && isPlaceholderName(name)) {
        let value: string | undefined;
        if (name.startsWith('$')) {
          if (isSupportedDynamic(name)) {
            if (replaced < MAX_PLACEHOLDERS) value = GENERATORS[name](g);
            else capped = true;
          } else if (!unsupported.includes(name) && unsupported.length < MAX_UNSUPPORTED_NAMED + 1) {
            unsupported.push(name);
          }
        } else {
          const v = varValue(ctx.vars, name);
          if (v !== undefined) {
            if (replaced < MAX_PLACEHOLDERS) value = v;
            else capped = true;
          }
        }
        if (value !== undefined) {
          replaced++;
          out += text.slice(segStart, i);
          out += ctx.json && inString ? jsonEscapeInner(value) : value;
          i = close + 2;
          segStart = i;
          if (out.length > limitChars) break;
          continue;
        }
        // Left as written; its name holds no quote or backslash, so the JSON string state is unchanged.
        i = close + 2;
        continue;
      }
    }
    if (ctx.json) {
      if (inString) {
        if (c === 0x5c /* \ */) {
          i += 2;
          continue;
        }
        if (c === 0x22 /* " */) inString = false;
      } else if (c === 0x22) {
        inString = true;
      }
    }
    i++;
  }
  out += text.slice(segStart);

  if (out.length > limitChars || utf8Bytes(out) > COLLECTION_LIMITS.exampleBodyBytes) {
    problems.push(
      `Dynamic values would make the body larger than ${Math.round(COLLECTION_LIMITS.exampleBodyBytes / (1024 * 1024))} MB: served as written.`,
    );
    return { text, problems };
  }
  if (capped) problems.push(`More than ${MAX_PLACEHOLDERS} placeholders in one body: the rest were left as written.`);
  if (unsupported.length > 0) {
    const shown = unsupported.slice(0, MAX_UNSUPPORTED_NAMED).join(', ');
    problems.push(`Dynamic values not supported (left as written): ${shown}${unsupported.length > MAX_UNSUPPORTED_NAMED ? ', …' : ''}.`);
  }
  return { text: out, problems };
}
