/**
 * Example by request body (CONTRACTS §24.2). Pure: no vscode, no fs, no network.
 *
 * - `buildBodyMatchers(endpoint)`: one matcher per example that carries a `request` body with at least one
 *   discriminator. Discriminators = the JSON leaf paths where the example's request body differs from the endpoint's
 *   own `requestBody` (all leaves when the endpoint has none); depth ≤ 8 (a deeper container is one leaf, compared
 *   whole), ≤ 32 leaves per body (file order). A leaf that is `""` under a secret-like name (`isSecretFieldName`,
 *   §22.8) or a string holding a `{{var}}` is ignored. urlencoded bodies are flat objects of strings.
 * - `chooseByBody(matchers, text, contentType)`: the matcher whose discriminators all equal the request's values
 *   (strict JSON equality: `1` ≠ `"1"`), most discriminators first, then file order.
 *
 * Problem lines (field names only, never values): an example request body over `REQUEST_BODY_BYTES` or not parsable;
 * an example that is not the endpoint's default (first 2xx, else first) and has no discriminator left because its
 * differing fields are blank secrets or `{{variables}}` — e.g. "Wrong password" in a copy made without credentials.
 * An example whose request body is simply the endpoint's own body (the usual Postman case) is the default answer and
 * gets no line.
 */
import { isSecretFieldName } from './snapshot';
import type { MockEndpoint } from './types';

/** §24.2: example / endpoint request bodies over this are not used for choosing. */
export const REQUEST_BODY_BYTES = 64 * 1024;
/** Request bodies (from the app) over this are not parsed for choosing. */
export const MATCH_REQUEST_BYTES = 1024 * 1024;
export const MAX_BODY_DEPTH = 8;
export const MAX_BODY_LEAVES = 32;

export interface BodyMatcher {
  /** The example's name. */
  example: string;
  /** Discriminator paths as display names (`email`, `user.name`, `items[0].id`). */
  fields: string[];
  test(body: unknown): boolean;
}

type Path = (string | number)[];
interface Leaf {
  path: Path;
  name: string;
  value: unknown;
}

function own(obj: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? Object.getOwnPropertyDescriptor(obj, key)?.value : undefined;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function utf8Bytes(s: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).byteLength;
}

function mediaBase(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

function isJsonType(base: string): boolean {
  return base === 'application/json' || base.endsWith('/json') || base.endsWith('+json');
}

const FORM_TYPE = 'application/x-www-form-urlencoded';

function decodeFormPart(s: string): string {
  const plus = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/** urlencoded text → a flat null-prototype object of strings (a repeated name keeps its first value). */
export function parseFormBody(text: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const part of text.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeFormPart(eq === -1 ? part : part.slice(0, eq));
    if (!key || hasOwn(out, key)) continue;
    Object.defineProperty(out, key, {
      value: decodeFormPart(eq === -1 ? '' : part.slice(eq + 1)),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * A body as a value: JSON (by content type, or when there is none and the text looks like JSON) or urlencoded.
 * `undefined` = not comparable (another type, or broken).
 */
export function parseBodyForMatch(text: string, contentType: string | undefined): { value?: unknown; broken?: true } {
  const base = mediaBase(contentType);
  if (base === FORM_TYPE) return { value: parseFormBody(text) };
  const trimmed = text.trimStart();
  if (isJsonType(base) || (base === '' && (trimmed.startsWith('{') || trimmed.startsWith('[')))) {
    try {
      return { value: JSON.parse(text) as unknown };
    } catch {
      return { broken: true };
    }
  }
  return {};
}

function displayName(path: Path): string {
  let s = '';
  for (const p of path) {
    if (typeof p === 'number') s += `[${p}]`;
    else s += s === '' ? p : `.${p}`;
  }
  return s === '' ? '(body)' : s;
}

/** Leaves in document order: scalars, empty containers, and containers at the depth limit (compared whole). */
function collectLeaves(value: unknown, max: number): { leaves: Leaf[]; truncated: boolean } {
  const leaves: Leaf[] = [];
  let truncated = false;
  const walk = (v: unknown, path: Path, depth: number): void => {
    if (leaves.length >= max) {
      truncated = true;
      return;
    }
    const isContainer = typeof v === 'object' && v !== null;
    const empty = isContainer && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
    if (!isContainer || empty || depth >= MAX_BODY_DEPTH) {
      leaves.push({ path, name: displayName(path), value: v });
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (leaves.length >= max) {
          truncated = true;
          return;
        }
        walk(v[i], [...path, i], depth + 1);
      }
      return;
    }
    for (const k of Object.keys(v)) {
      if (leaves.length >= max) {
        truncated = true;
        return;
      }
      walk(own(v, k), [...path, k], depth + 1);
    }
  };
  walk(value, [], 0);
  return { leaves, truncated };
}

/** The value at a path, own properties only; `missing` when absent. */
const MISSING = Symbol('missing');
function valueAt(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (typeof p === 'number') {
      if (!Array.isArray(cur) || p >= cur.length) return MISSING;
      cur = cur[p];
    } else {
      if (!isPlainObject(cur) || !hasOwn(cur, p)) return MISSING;
      cur = own(cur, p);
    }
  }
  return cur;
}

/** Strict JSON equality (types matter; object key order does not). Bounded by the bodies' own size. */
export function jsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > 64) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!hasOwn(b, k) || !jsonEqual(own(a, k), own(b, k), depth + 1)) return false;
  }
  return true;
}

function hasTemplateVar(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const open = v.indexOf('{{');
  return open !== -1 && v.indexOf('}}', open + 2) !== -1;
}

function isIgnoredLeaf(leaf: Leaf): boolean {
  if (hasTemplateVar(leaf.value)) return true;
  if (leaf.value === '') {
    const last = leaf.path[leaf.path.length - 1];
    return typeof last === 'string' && isSecretFieldName(last);
  }
  return false;
}

function defaultExampleIndex(endpoint: MockEndpoint): number {
  const i = endpoint.examples.findIndex((e) => e.status >= 200 && e.status <= 299);
  return i === -1 ? 0 : i;
}

function quote(s: string): string {
  const t = s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/** CONTRACTS §24.2. Pure; never throws. */
export function buildBodyMatchers(endpoint: MockEndpoint): { matchers: BodyMatcher[]; problems: string[] } {
  const matchers: BodyMatcher[] = [];
  const problems: string[] = [];
  const where = `"${quote(endpoint.name)}"`;

  let ownLeaves: Leaf[] | undefined;
  const rb = endpoint.requestBody;
  if (rb && typeof rb.body === 'string' && rb.body !== '' && utf8Bytes(rb.body) <= REQUEST_BODY_BYTES) {
    const parsed = parseBodyForMatch(rb.body, rb.contentType);
    if (parsed.value !== undefined) ownLeaves = collectLeaves(parsed.value, MAX_BODY_LEAVES * 4).leaves;
  }
  const pathKey = (l: Leaf): string => JSON.stringify(l.path);
  const ownByPath = new Map<string, unknown>();
  for (const l of ownLeaves ?? []) ownByPath.set(pathKey(l), l.value);

  const defaultIndex = defaultExampleIndex(endpoint);
  endpoint.examples.forEach((ex, index) => {
    const req = ex.request;
    if (!req || typeof req.body !== 'string' || req.body === '') return;
    const exName = `${where} example "${quote(ex.name)}"`;
    if (utf8Bytes(req.body) > REQUEST_BODY_BYTES) {
      problems.push(`${exName}: request body over ${REQUEST_BODY_BYTES / 1024} KB, not used for choosing by body.`);
      return;
    }
    const parsed = parseBodyForMatch(req.body, req.contentType);
    if (parsed.broken) {
      problems.push(`${exName}: request body is not valid JSON, not used for choosing by body.`);
      return;
    }
    if (parsed.value === undefined) return;

    const { leaves } = collectLeaves(parsed.value, MAX_BODY_LEAVES);
    const differing = ownLeaves
      ? leaves.filter((l) => !ownByPath.has(pathKey(l)) || !jsonEqual(ownByPath.get(pathKey(l)), l.value))
      : leaves;
    const kept = differing.filter((l) => !isIgnoredLeaf(l));
    // Worth a line: differing fields that were ignored, or blank secrets (they may have differed before blanking).
    const ignored = leaves.filter((l) => isIgnoredLeaf(l) && (l.value === '' || differing.includes(l)));

    if (kept.length === 0) {
      if (index !== defaultIndex && ignored.length > 0) {
        const names = ignored.slice(0, 3).map((l) => `"${quote(l.name)}"`).join(', ');
        problems.push(
          `${exName}: not chosen by body — ${names} ${ignored.length === 1 ? 'is' : 'are'} blank or a {{variable}} (a copy without credentials blanks secret fields).`,
        );
      }
      return;
    }

    const paths = kept.map((l) => ({ path: l.path, value: l.value }));
    matchers.push({
      example: ex.name,
      fields: kept.map((l) => l.name),
      test(body: unknown): boolean {
        for (const p of paths) {
          const v = valueAt(body, p.path);
          if (v === MISSING || !jsonEqual(v, p.value)) return false;
        }
        return true;
      },
    });
  });
  return { matchers, problems };
}

/**
 * CONTRACTS §24.2: the example chosen by the request body, or undefined. Most discriminators wins, then file order.
 * Bodies over `MATCH_REQUEST_BYTES`, not JSON / urlencoded, or broken → undefined. Never throws.
 */
export function chooseByBody(
  matchers: readonly BodyMatcher[],
  requestBodyText: string | undefined,
  contentType: string | undefined,
): string | undefined {
  if (matchers.length === 0 || typeof requestBodyText !== 'string' || requestBodyText === '') return undefined;
  if (requestBodyText.length > MATCH_REQUEST_BYTES) return undefined;
  const parsed = parseBodyForMatch(requestBodyText, contentType);
  if (parsed.value === undefined) return undefined;
  let best: BodyMatcher | undefined;
  for (const m of matchers) {
    if (best && m.fields.length <= best.fields.length) continue;
    try {
      if (m.test(parsed.value)) best = m;
    } catch {
      // A hostile body can't break the answer: no match.
    }
  }
  return best?.example;
}
