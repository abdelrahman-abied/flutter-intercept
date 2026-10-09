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

export type Headers = Record<string, string | string[]>;

export function redactHeaders(headers: Headers | undefined): Headers | undefined {
  if (!headers) return headers;
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isSensitiveHeader(k) ? (Array.isArray(v) ? v.map(() => REDACTED) : REDACTED) : v;
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
      return isSensitiveField(key) ? `${rawKey}=${REDACTED}` : part;
    })
    .join('&');
}

export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hash = url.indexOf('#', q);
  const query = hash === -1 ? url.slice(q + 1) : url.slice(q + 1, hash);
  const tail = hash === -1 ? '' : url.slice(hash);
  return `${url.slice(0, q + 1)}${redactQueryString(query)}${tail}`;
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
    if (c === '"') str();
    else if (((NUM.lastIndex = i), NUM.test(text))) i = NUM.lastIndex;
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
  return text.replace(PAIR, (whole, prefix: string, name: string) => (isSensitiveField(name) ? `${prefix}"${REDACTED}"` : whole));
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
  return text.includes('"') ? redactJsonLikeText(text) : text;
}
