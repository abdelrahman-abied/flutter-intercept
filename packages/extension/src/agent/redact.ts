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
 * - CONTRACTS §11.5 (GraphQL): sensitive inline arguments in GraphQL documents (`login(password: "x")`) — in a
 *   JSON `query` string, an `application/graphql` body, or a `?query=` parameter — and sensitive keys inside a
 *   `?variables=` / `?extensions=` JSON parameter. `variables` in JSON bodies are covered by the structural pass.
 * - CONTRACTS §11.5 (frames): WebSocket / SSE text is redacted like a body (`redactFrameText`), plus
 *   `name: value` lines with a sensitive name (STOMP-style headers).
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

/**
 * REVIEW-5 #8: `Sec-WebSocket-Protocol` often carries a token as a subprotocol: `access_token, <token>`,
 * `bearer, <token>`, Kubernetes' `base64url.bearer.authorization.k8s.io.<token>`. Elements that are credentials
 * (opaque / JWT), follow a sensitive marker, or carry a `bearer.` prefixed token are redacted; protocol names stay.
 */
export function redactWebSocketProtocols(value: string): string {
  const parts = value.split(',').map((x) => x.trim());
  let afterMarker = false;
  return parts
    .map((p) => {
      const marker = afterMarker;
      // a bare marker word (`access_token`, `bearer`, `token`), not a protocol name that merely contains one
      afterMarker = /^[A-Za-z][A-Za-z_-]{0,40}$/.test(p) && (isSensitiveField(p) || /^bearer$/i.test(p));
      if (marker && p) return REDACTED;
      const k8s = /^(.*\bbearer\.[a-z0-9.-]*?k8s\.io\.)(.+)$/i.exec(p);
      if (k8s) return `${k8s[1]}${REDACTED}`;
      return redactSecretValues(p, true);
    })
    .join(', ');
}

export function redactHeaders(headers: Headers | undefined): Headers | undefined {
  if (!headers) return headers;
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'sec-websocket-protocol') {
      // One list across repeated header lines, so `access_token` + `<token>` on two lines is caught too.
      out[k] = Array.isArray(v) ? [redactWebSocketProtocols(v.join(', '))] : redactWebSocketProtocols(v);
      continue;
    }
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
      if (redactSecretValues(value, true) !== value) return `${rawKey}=${REDACTED}`;
      // GraphQL over GET: ?query=<document>&variables=<JSON>&extensions=<JSON>
      const nested = key === 'query' ? redactGraphqlDocument(value) : key === 'variables' || key === 'extensions' ? redactJsonParam(value) : value;
      return nested !== value ? `${rawKey}=${encodeURIComponent(nested)}` : part;
    })
    .join('&');
}

/** A JSON query parameter value with sensitive keys redacted; not JSON → returned unchanged. */
function redactJsonParam(value: string): string {
  const t = value.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return value;
  try {
    return redactJsonText(value);
  } catch {
    return redactJsonLikeText(value);
  }
}

const NAME_START = /[_A-Za-z]/;
const NAME_CHAR = /[_0-9A-Za-z]/;
const NUM_CHAR = /[0-9.eE+-]/;

/**
 * A GraphQL document with the literal values of sensitive arguments / input fields replaced:
 * `login(password: "hunter2")` → `login(password: "[redacted]")`, every literal of a list after a sensitive name
 * (`tokens: ["a", "b"]`), and a sensitive variable's default (`$password: String = "x"`). Variable references
 * carry no literal and are kept. Credential-looking values (JWT, Bearer) are redacted anywhere. One linear pass
 * over GraphQL tokens (strings, block strings, comments ending at LF or CR), so hostile input can't make it slow.
 */
export function redactGraphqlDocument(doc: string): string {
  if (!doc.includes(':')) return redactSecretValues(doc);
  const n = doc.length;
  let out = '';
  let copied = 0;
  let lastName: string | undefined; // the name token right before the current position
  let lastIsVar = false; // that name followed a `$`
  let dollar = false;
  let sensitive = false; // a sensitive name followed by ':' (or a sensitive variable's '=') awaits its value
  let typeMode = false; // inside `$secret: Type` before an optional `= default`
  let listDepth = 0; // > 0: inside a list value of a sensitive name: every literal is redacted
  const replace = (from: number, to: number) => {
    out += `${doc.slice(copied, from)}"${REDACTED}"`;
    copied = to;
  };
  const reset = () => {
    sensitive = false;
    typeMode = false;
    lastName = undefined;
    lastIsVar = false;
  };
  let i = 0;
  while (i < n) {
    const c = doc[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < n && doc[j] !== '\n' && doc[j] !== '\r') j++;
      i = j;
      continue;
    }
    if (c === '"') {
      let end: number;
      if (doc.startsWith('"""', i)) {
        const e = doc.indexOf('"""', i + 3);
        end = e === -1 ? n : e + 3;
      } else {
        let j = i + 1;
        while (j < n && doc[j] !== '"' && doc[j] !== '\n' && doc[j] !== '\r') j += doc[j] === '\\' ? 2 : 1;
        end = Math.min(n, j + 1);
      }
      if (sensitive || listDepth > 0) replace(i, end);
      reset();
      dollar = false;
      i = end;
      continue;
    }
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && NAME_CHAR.test(doc[j])) j++;
      if (!typeMode) {
        // an enum / boolean / null value is not a secret literal
        sensitive = false;
        lastName = doc.slice(i, j);
        lastIsVar = dollar;
      }
      dollar = false;
      i = j;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < n && NUM_CHAR.test(doc[j])) j++;
      if (sensitive || listDepth > 0) replace(i, j);
      reset();
      dollar = false;
      i = j;
      continue;
    }
    dollar = false;
    if (c === ':') {
      const secret = lastName !== undefined && isSensitiveField(lastName);
      typeMode = secret && lastIsVar;
      sensitive = secret && !lastIsVar;
      lastName = undefined;
      lastIsVar = false;
    } else if (c === '[') {
      if (sensitive || listDepth > 0) listDepth++;
      else if (!typeMode) reset();
    } else if (c === ']') {
      if (listDepth > 0) listDepth--;
      else if (!typeMode) reset();
    } else if (c === '!' && typeMode) {
      // `$password: String!` → still waiting for `=`
    } else if (c === '=' && typeMode) {
      typeMode = false;
      sensitive = true;
    } else {
      if (c === '$') dollar = true;
      // other punctuation: ( ) { } ! = @ | & … — a value inside a sensitive list keeps listDepth
      sensitive = false;
      typeMode = false;
      lastName = undefined;
      lastIsVar = false;
    }
    i++;
  }
  return redactSecretValues(out + doc.slice(copied));
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

/**
 * The URL as agents see it: userinfo (`user:pass@`) → `[redacted]@` (REVIEW-5 #5: imported profile URLs can carry
 * it), path segments / query values / fragment parameters that are secrets → `[redacted]`.
 */
export function redactUrl(url: string): string {
  const hashAt = url.indexOf('#');
  const main = hashAt === -1 ? url : url.slice(0, hashAt);
  const q = main.indexOf('?');
  const pathEnd = q === -1 ? main.length : q;
  const rawAuth = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(main)?.[0] ?? '';
  let auth = rawAuth;
  const at = rawAuth.lastIndexOf('@');
  if (at !== -1) {
    const start = rawAuth.indexOf('//') + 2;
    auth = `${rawAuth.slice(0, start)}${REDACTED}@${rawAuth.slice(at + 1)}`;
  }
  let out = auth + redactPath(main.slice(rawAuth.length, pathEnd));
  if (q !== -1) out += `?${redactQueryString(main.slice(q + 1))}`;
  if (hashAt !== -1) out += `#${redactFragment(url.slice(hashAt + 1))}`;
  return out;
}

/** `#access_token=…&state=…` (OAuth implicit flow) like a query; a fragment that is itself a credential → redacted. */
function redactFragment(frag: string): string {
  if (!frag) return frag;
  if (frag.includes('=')) return redactQueryString(frag);
  let v = frag;
  try {
    v = decodeURIComponent(frag);
  } catch {
    // keep raw
  }
  return redactSecretValues(v, true) !== v ? REDACTED : frag;
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>`]+/gi;
const MAX_REDACT_TEXT = 8192;

/**
 * Free text for agents (an exchange's `error`, a CORS note): every URL in it as `redactUrl` shows it, plus
 * credential-looking values (REVIEW-5 #5: dart:io errors embed `uri = <full url>`). Cut at 8 KB.
 */
export function redactText(text: string): string {
  const t = text.length > MAX_REDACT_TEXT ? `${text.slice(0, MAX_REDACT_TEXT)}…` : text;
  return redactSecretValues(t.replace(URL_IN_TEXT, (u) => redactUrl(u)));
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
  /** Scans one value at i; copies it to out unless `redact`, in which case writes "[redacted]". `key` = its object key. */
  const value = (redact: boolean, key?: string): void => {
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
        value(isSensitiveField(key), key);
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
      let cleaned = redactSecretValues(decoded, true);
      // A GraphQL request's document: sensitive inline arguments (CONTRACTS §11.5).
      // Always, also when a JWT was already replaced (REVIEW-5 #8).
      if (key === 'query') cleaned = redactGraphqlDocument(cleaned);
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
  if (ct.includes('application/graphql')) return redactGraphqlDocument(text);
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

const HEADER_LINE = /^([A-Za-z0-9_-]+)([ \t]*:[ \t]*)(\S.*)$/gm;

/**
 * CONTRACTS §11.5: one WebSocket message / SSE event text as agents see it — JSON structurally, other text by
 * pattern (`"name": value` pairs, `name: value` lines with a sensitive name, JWT / Bearer credentials).
 */
export function redactFrameText(text: string): string {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return redactJsonText(text);
    } catch {
      // not one JSON value: fall through to the patterns
    }
  }
  const lines = text.includes(':')
    ? text.replace(HEADER_LINE, (whole, name: string, sep: string) => (isSensitiveHeader(name) || isSensitiveField(name) ? `${name}${sep}${REDACTED}` : whole))
    : text;
  return lines.includes('"') ? redactJsonLikeText(lines) : redactSecretValues(lines);
}
