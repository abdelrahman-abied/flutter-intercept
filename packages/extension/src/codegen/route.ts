/**
 * Route templates for grouping samples of one endpoint (CONTRACTS §10.4). Pure.
 * Path segments that look like ids become `{id}`, `{id2}`, … in order; the query and fragment are dropped.
 * An absolute URL keeps its origin (`https://api.example.com/users/{id}`); a bare path stays a path.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^-?\d+$/;
/** ≥ 16 hex chars, or ≥ 8 with both digits and letters (Mongo ObjectIds, hashes, short SHAs). */
const HEX = /^(?:[0-9a-f]{16,}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,})$/i;
/** Opaque tokens: ≥ 16 base64/base64url chars with a digit and a letter (ULIDs, Firebase push ids, slugs with ids). */
const OPAQUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-+]{16,}={0,2}$/;

/** True when a decoded path segment looks like an identifier value rather than a resource name. */
export function isIdSegment(segment: string): boolean {
  if (!segment) return false;
  return NUMERIC.test(segment) || UUID.test(segment) || HEX.test(segment) || OPAQUE.test(segment);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `/users/42/posts/9f1c…` → `/users/{id}/posts/{id2}`. */
export function routeTemplate(url: string): string {
  let prefix = '';
  let path = url;
  const abs = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(url);
  if (abs) {
    prefix = abs[1];
    path = abs[2];
  }
  path = path.replace(/[?#].*$/s, '');
  let n = 0;
  const templated = path
    .split('/')
    .map((seg) => (isIdSegment(safeDecode(seg)) ? `{id${++n === 1 ? '' : n}}` : seg))
    .join('/');
  return prefix + (templated || (prefix ? '/' : templated));
}
