/**
 * Secret redaction for everything an agent can read (CONTRACTS §8). Applies to tool results and
 * HAR exports only — never to what the app receives. Pure, no `vscode`.
 *
 * - Headers: name is authorization / proxy-authorization / cookie / set-cookie, or contains
 *   token|secret|api-key|session|password|auth → "[redacted]" (every element of a multi-value header).
 * - URL query params and JSON fields at any depth whose NAME matches
 *   pass(word)|token|secret|api-key|session|auth|credential|client-secret → "[redacted]".
 * - JSON bodies are redacted structurally by a small scanner that copies the text verbatim and only
 *   swaps the values of sensitive keys, so nothing is ever re-parsed into JS numbers (integers beyond
 *   2^53, `1.0`, exponent forms and formatting all survive byte for byte). Text that isn't valid JSON
 *   falls back to a regex on `"name": "value"` pairs. `application/x-www-form-urlencoded` bodies are
 *   redacted like a query string.
 * - REVIEW-4 #9: VALUES that look like credentials are redacted whatever their key or header name: JWTs
 *   (`eyJ….….…`, also inside longer text), the credential after `Bearer` / `Basic` (≥ 16 chars with a digit), and whole values that are
 *   long opaque tokens (≥ 32 chars of [A-Za-z0-9_-.~+/=] with upper case, lower case AND digits — so hex
 *   hashes, UUIDs and ordinary ids are kept). Applied to header values, query values, path segments, JSON
 *   string values and (JWT / Bearer only) any other text body.
 */

export const REDACTED = '[redacted]';

const HEADER_EXACT = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;
const HEADER_CONTAINS = /(token|secret|api[-_]?key|session|password|auth)/i;
const FIELD = /(pass(word)?|token|secret|api[-_]?key|session|auth|credential|client[-_]?secret)/i;

export function isSensitiveHeader(name: string): boolean {
  return HEADER_EXACT.test(name) || HEADER_CONTAINS.test(name);
}

export function isSensitiveField(name: string): boolean {
  return FIELD.test(name);
}

const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+\/=-]{16,})/gi;
const OPAQUE = /^[A-Za-z0-9_\-.~+/=]{32,}$/;

/** A whole value that is a long opaque token (mixed upper, lower and digits; see the header). */
export function isOpaqueToken(v: string): boolean {
  return OPAQUE.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v);
}

/**
 * `text` with credential-looking values blanked (REVIEW-4 #9). `whole` = the text is one value (a header,
 * query or JSON string value), so a long opaque token as the entire value is redacted too.
 */
export function redactSecretValues(text: string, whole = false): string {
  if (whole && isOpaqueToken(text)) return REDACTED;
  if (!text.includes('eyJ') && !/bearer|basic/i.test(text)) return text;
  // a credential after the scheme has a digit (prose like "basic informational" is kept)
  return text.replace(JWT, REDACTED).replace(AUTH_SCHEME, (m, scheme: string, sp: string, cred: string) => (/\d/.test(cred) ? `${scheme}${sp}${REDACTED}` : m));
}

export type Headers = Record<string, string | string[]>;

export function redactHeaders(headers: Headers | undefined): Headers | undefined {
  if (!headers) return headers;
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isSensitiveHeader(k)
      ? Array.isArray(v)
        ? v.map(() => REDACTED)
        : REDACTED
      : Array.isArray(v)
        ? v.map((x) => redactSecretValues(x, true))
        : redactSecretValues(v, true);
  }
  return out;
}

/** Redacts `a=1&token=x` style text (query strings, urlencoded bodies), keeping order and raw keys. */
export function redactQueryString(qs: string): string {
  if (!qs) return qs;
  return qs
    .split('&')
    .map((part) => {
      if (!part) return part;
      const eq = part.indexOf('=');
      const rawKey = eq === -1 ? part : part.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // keep raw
      }
      if (isSensitiveField(key)) return `${rawKey}=${REDACTED}`;
      if (eq === -1) return part;
      const rawValue = part.slice(eq + 1);
      let value = rawValue;
      try {
        value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      } catch {
        // keep raw
      }
      return redactSecretValues(value, true) !== value ? `${rawKey}=${REDACTED}` : part;
    })
    .join('&');
}

/** Path segments that are JWTs / opaque tokens (e.g. `/reset/eyJ…`) → "[redacted]". */
function redactPath(p: string): string {
  return p
    .split('/')
    .map((seg) => {
      let v = seg;
      try {
        v = decodeURIComponent(seg);
      } catch {
        // keep raw
      }
      return redactSecretValues(v, true) !== v ? REDACTED : seg;
    })
    .join('/');
}

export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  const hash0 = url.indexOf('#');
  const pathEnd = q !== -1 ? q : hash0 !== -1 ? hash0 : url.length;
  // keep scheme://authority as is; redact the path segments
  const auth = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0] ?? '';
  const head = auth + redactPath(url.slice(auth.length, pathEnd));
  if (q === -1) return head + url.slice(pathEnd);
  const hash = url.indexOf('#', q);
  const query = hash === -1 ? url.slice(q + 1) : url.slice(q + 1, hash);
  const tail = hash === -1 ? '' : url.slice(hash);
  return `${head}?${redactQueryString(query)}${tail}`;
}

// ------------------------------------------------------------------ lossless JSON redaction

class JsonScanError extends Error {}

const NUM = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

/**
 * Walks `text` as JSON and returns it with the values of sensitive keys replaced by "[redacted]".
 * Everything else is copied verbatim. Throws JsonScanError if `text` isn't a single JSON value.
 */
export function redactJsonText(text: string): string {
  let i = 0;
  const n = text.length;
  let out = '';

  const ws = () => {
    const start = i;
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
    out += text.slice(start, i);
  };
  const fail = (what: string): never => {
    throw new JsonScanError(`${what} at ${i}`);
  };
  /** Scans a string literal at i (must be '"'), returns its raw text. */
  const str = (): string => {
    const start = i;
    if (text[i] !== '"') fail('string expected');
    i++;
    while (i < n && text[i] !== '"') {
      const c = text.charCodeAt(i);
      if (c < 0x20) fail('control character in string');
      if (text[i] === '\\') {
        i++;
        if (text[i] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail('bad \\u escape');
          i += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(text[i] ?? '')) fail('bad escape');
      }
      i++;
    }
    if (i >= n) fail('unterminated string');
    i++;
    return text.slice(start, i);
  };
  /** Scans one value at i; copies it to out unless `redact`, in which case writes "[redacted]". */
  const value = (redact: boolean): void => {
    const c = text[i];
    if (c === '{') {
      if (redact) {
        skipValue();
        out += `"${REDACTED}"`;
        return;
      }
      out += '{';
      i++;
      ws();
      if (text[i] === '}') {
        out += '}';
        i++;
        return;
      }
      for (;;) {
        const rawKey = str();
        const key = JSON.parse(rawKey) as string;
        out += rawKey;
        ws();
        if (text[i] !== ':') fail("':' expected");
        out += ':';
        i++;
        ws();
        value(isSensitiveField(key));
        ws();
        if (text[i] === ',') {
          out += ',';
          i++;
          ws();
          continue;
        }
        if (text[i] === '}') {
          out += '}';
          i++;
          return;
        }
        fail("',' or '}' expected");
      }
    }
    if (c === '[') {
      if (redact) {
        skipValue();
        out += `"${REDACTED}"`;
        return;
      }
      out += '[';
      i++;
      ws();
      if (text[i] === ']') {
        out += ']';
        i++;
        return;
      }
      for (;;) {
        value(false);
        ws();
        if (text[i] === ',') {
          out += ',';
          i++;
          ws();
          continue;
        }
        if (text[i] === ']') {
          out += ']';
          i++;
          return;
        }
        fail("',' or ']' expected");
      }
    }
    const start = i;
    if (c === '"') {
      const raw = str();
      if (redact) {
        out += `"${REDACTED}"`;
        return;
      }
      const decoded = JSON.parse(raw) as string;
      const cleaned = redactSecretValues(decoded, true);
      out += cleaned === decoded ? raw : JSON.stringify(cleaned);
      return;
    } else if (((NUM.lastIndex = i), NUM.test(text))) i = NUM.lastIndex;
    else if (text.startsWith('true', i)) i += 4;
    else if (text.startsWith('false', i)) i += 5;
    else if (text.startsWith('null', i)) i += 4;
    else fail('value expected');
    out += redact ? `"${REDACTED}"` : text.slice(start, i);
  };
  /** Advances past one value without writing (used for redacted objects/arrays). */
  const skipValue = (): void => {
    const saved = out;
    value(false);
    out = saved;
  };

  ws();
  value(false);
  ws();
  if (i !== n) fail('trailing characters');
  return out;
}

const PAIR = /("((?:[^"\\]|\\.)*)"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)/g;

/** Fallback for text that isn't valid JSON: redact `"name": value` pairs by regex. */
export function redactJsonLikeText(text: string): string {
  return redactSecretValues(text.replace(PAIR, (whole, prefix: string, name: string) => (isSensitiveField(name) ? `${prefix}"${REDACTED}"` : whole)));
}

function headerValue(headers: Headers | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

/** Redacts a decoded text body according to its content type (JSON, urlencoded, or JSON-ish text). */
export function redactBodyText(text: string, headers?: Headers): string {
  const ct = (headerValue(headers, 'content-type') ?? '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) return redactQueryString(text);
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || ct.includes('json')) {
    try {
      return redactJsonText(text);
    } catch {
      return redactJsonLikeText(text);
    }
  }
  // text, multipart, GraphQL strings …: JWTs and Bearer credentials anywhere (REVIEW-4 #9)
  return text.includes('"') ? redactJsonLikeText(text) : redactSecretValues(text);
}
