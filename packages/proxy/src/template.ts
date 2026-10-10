// Path templates (CONTRACTS §12.4 replay matching). Pure and dependency-free: re-exported from
// `@flutter-intercept/proxy/rules`, so the host (recording diff) and the webview can use the very same
// notion of "the same route". Same id-segment rules as the extension's codegen `routeTemplate`.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^-?\d+$/;
/** ≥ 16 hex chars, or ≥ 8 with both digits and letters (Mongo ObjectIds, hashes, short SHAs). */
const HEX = /^(?:[0-9a-f]{16,}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,})$/i;
/** Opaque tokens: ≥ 16 base64/base64url chars with a digit and a letter (ULIDs, Firebase push ids, …). */
const OPAQUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-+]{16,}={0,2}$/;

/** Longest segment considered (longer ones are kept literally; also bounds the regex work). */
const MAX_SEGMENT = 256;

/** True when a (decoded) path segment looks like an identifier value rather than a resource name. */
export function isIdSegment(segment: string): boolean {
  if (!segment || segment.length > MAX_SEGMENT) return false;
  return NUMERIC.test(segment) || UUID.test(segment) || HEX.test(segment) || OPAQUE.test(segment);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `/users/42/posts/9f1c…` → `/users/{id}/posts/{id2}` (query / fragment dropped). */
export function pathTemplate(path: string): string {
  let n = 0;
  return path
    .replace(/[?#].*$/s, '')
    .split('/')
    .map((seg) => (isIdSegment(safeDecode(seg)) ? `{id${++n === 1 ? '' : n}}` : seg))
    .join('/');
}

/**
 * `https://api.example.com/users/42?x=1` → `https://api.example.com/users/{id}`: the origin (lower-cased host,
 * default port dropped) plus the path template. A string that isn't an absolute URL is templated as a path.
 */
export function routeTemplate(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return pathTemplate(url);
  }
  return `${u.protocol}//${u.host}${pathTemplate(u.pathname)}`;
}
