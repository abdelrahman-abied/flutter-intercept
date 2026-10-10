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
 * - CONTRACTS §14.6 (multipart): `multipart/form-data` bodies (boundary from the content-type, ≤ 5 MB) are parsed:
 *   secret-named fields → "[redacted]", file parts → "[file <name>, N bytes]", other fields redacted like a body of
 *   their own content-type; also when the body was recorded as binary (`redactBody`). Unparseable → the text rules.
 */
import type { Body } from '@flutter-intercept/proxy';

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

/** Redacts a decoded text body according to its content type (JSON, urlencoded, multipart, or JSON-ish text). */
export function redactBodyText(text: string, headers?: Headers): string {
  const rawCt = headerValue(headers, 'content-type') ?? '';
  const ct = rawCt.toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) return redactQueryString(text);
  if (ct.includes('multipart/form-data') && text.length <= MAX_MULTIPART_BYTES) {
    const out = redactMultipart(Buffer.from(text, 'utf8'), rawCt);
    if (out !== undefined) return out;
  }
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

const LOG_PAIR = /([A-Za-z0-9_.-]+)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&)]+)/g;
/** REVIEW-7 #8: `context.log('token', value)` → `token <value>`: a sensitive name, whitespace, the value (optionally after "to" / "is" …). */
const LOG_WS_PAIR = /(^|[\s,;(\[{])([A-Za-z0-9_.-]+)(\s+)(?:(to|is|was|as|for|of|=)(\s+))?([^\s,;)}]+)/gi;
/** REVIEW-7 #8: well-known credential prefixes (GitHub, Stripe, Slack, AWS access keys, Google API keys). */
const TOKEN_PREFIX = /^(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|[sr]k_(live|test)_[A-Za-z0-9]{6,}|xox[abprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,})/;
const WORD_EDGE = /^([("'`\[{<]*)(.*?)([)"'`\]}>,;:.!?]*)$/s;

/**
 * CONTRACTS §13.4: one `scriptLog` line (free text a user's script logged) as agents see it: URLs and JSON like
 * `redactText` / `redactFrameText`; `name=value` / `name: value` pairs and (REVIEW-7 #8) `name value` with a sensitive
 * name anywhere in the line; every `Bearer <credential>`; and any word that is an opaque token or carries a known
 * credential prefix. Errs on redacting too much (prose like "password is wrong" loses a word).
 */
export function redactLogLine(line: string): string {
  const base = redactFrameText(redactText(line));
  const sensitive = (name: string) => isSensitiveField(name) || isSensitiveHeader(name);
  return base
    .replace(LOG_PAIR, (whole, name: string, sep: string, value: string) => {
      const q = /^["']/.test(value) ? value[0] : '';
      if (value.slice(q.length, value.length - q.length) === REDACTED || !sensitive(name)) return whole;
      return `${name}${sep}${q}${REDACTED}${q}`;
    })
    .replace(/\b(Bearer|Basic)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(LOG_WS_PAIR, (whole, lead: string, name: string, sp: string, link: string | undefined, sp2: string | undefined, value: string) => {
      if (!sensitive(name) || value.includes(REDACTED)) return whole;
      return `${lead}${name}${sp}${link ? `${link}${sp2}` : ''}${REDACTED}${/[\]"'.]+$/.exec(value)?.[0] ?? ''}`;
    })
    .split(/(\s+)/)
    .map((word) => {
      const m = WORD_EDGE.exec(word);
      if (!m || !m[2] || m[2] === REDACTED) return word;
      return isOpaqueToken(m[2]) || TOKEN_PREFIX.test(m[2]) ? `${m[1]}${REDACTED}${m[3]}` : word;
    })
    .join('');
}

// ------------------------------------------------------------------ CONTRACTS §14.6 multipart/form-data

/** Multipart bodies larger than this are not parsed (the text rules apply). */
export const MAX_MULTIPART_BYTES = 5 * 1024 * 1024;
/** At most this many parts are shown; the rest are summarised. */
export const MAX_MULTIPART_PARTS = 1000;

/** The `boundary` parameter of a multipart content-type (RFC 2046: 1-70 characters), or undefined. */
export function multipartBoundary(contentType: string): string | undefined {
  const m = /;\s*boundary\s*=\s*(?:"([^"]{1,70})"|([^\s;"]{1,70}))(?=\s*(?:;|$))/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  return b && !/[\r\n]/.test(b) ? b : undefined;
}

function dispositionParam(disposition: string, name: string): string | undefined {
  // filename*=UTF-8''…  (RFC 5987) wins over filename=
  const ext = new RegExp(`;\\s*${name}\\*\\s*=\\s*([^;]+)`, 'i').exec(disposition);
  if (ext) {
    const v = ext[1].trim().replace(/^[A-Za-z0-9_-]*'[A-Za-z-]*'/, '');
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, 'i').exec(disposition);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
}

/** latin1 (byte) string → UTF-8 text when it is valid UTF-8, else undefined. */
function utf8Of(bytes: string): string | undefined {
  const buf = Buffer.from(bytes, 'latin1');
  const text = buf.toString('utf8');
  return Buffer.byteLength(text, 'utf8') === buf.length && !text.includes('\uFFFD') ? text : undefined;
}

function cleanName(v: string): string {
  return (utf8Of(v) ?? v).replace(/[\r\n"\\]+/g, ' ').slice(0, 200);
}

/**
 * A `multipart/form-data` body as agents see it (CONTRACTS §14.6), rebuilt with the same boundary: part headers kept
 * (Content-Disposition with names; other part headers redacted like headers), values replaced — secret-named fields →
 * "[redacted]", file parts (a `filename`) → "[file <name>, N bytes]", binary values → "[binary N bytes]", other text
 * redacted like a body of the part's content-type. `bytes` is the raw body; undefined when it has no boundary, is
 * larger than MAX_MULTIPART_BYTES or doesn't parse (the caller falls back to the text rules). A truncated body ends
 * with the parts that were complete plus "[truncated]".
 */
export function redactMultipart(bytes: Buffer, contentType: string): string | undefined {
  if (bytes.length > MAX_MULTIPART_BYTES) return undefined;
  const boundary = multipartBoundary(contentType);
  if (!boundary) return undefined;
  const s = bytes.toString('latin1');
  const delim = `--${boundary}`;
  let pos: number;
  if (s.startsWith(delim)) pos = 0;
  else {
    const at = s.indexOf(`\n${delim}`);
    if (at === -1) return undefined;
    pos = at + 1;
  }
  const out: string[] = [];
  let parts = 0;
  let closed = false;
  let truncated = false;
  while (pos < s.length) {
    // at a delimiter line
    let p = pos + delim.length;
    if (s.startsWith('--', p)) {
      closed = true;
      break;
    }
    while (s[p] === ' ' || s[p] === '\t') p++;
    if (s.startsWith('\r\n', p)) p += 2;
    else if (s[p] === '\n') p += 1;
    else if (p >= s.length) {
      truncated = true;
      break;
    } else return undefined; // not a delimiter after all
    // part headers
    let headEnd = s.indexOf('\r\n\r\n', p);
    let bodyStart = headEnd + 4;
    const lf = s.indexOf('\n\n', p);
    if (lf !== -1 && (headEnd === -1 || lf < headEnd)) {
      headEnd = lf;
      bodyStart = lf + 2;
    }
    if (headEnd === -1) {
      truncated = true;
      break;
    }
    const headerLines = s.slice(p, headEnd).split(/\r?\n/).filter((l) => l.length > 0);
    // part body: up to the next delimiter line
    const nextCrlf = s.indexOf(`\r\n${delim}`, bodyStart);
    const nextLf = s.indexOf(`\n${delim}`, bodyStart);
    let bodyEnd: number;
    let next: number;
    if (nextCrlf !== -1 && (nextLf === -1 || nextCrlf <= nextLf)) {
      bodyEnd = nextCrlf;
      next = nextCrlf + 2;
    } else if (nextLf !== -1) {
      bodyEnd = nextLf;
      next = nextLf + 1;
    } else {
      bodyEnd = s.length;
      next = s.length;
      truncated = true;
    }
    parts++;
    if (parts > MAX_MULTIPART_PARTS) {
      let more = 1;
      let q = next;
      while (q < s.length && !s.startsWith('--', q + delim.length)) {
        more++;
        const n2 = s.indexOf(`\n${delim}`, q + 1);
        if (n2 === -1) break;
        q = n2 + 1;
      }
      out.push(`${delim}\r\n\r\n[${more} more parts]`);
      closed = true;
      break;
    }
    const headers: Record<string, string> = {};
    const shownHeaders: string[] = [];
    for (const line of headerLines) {
      const c = line.indexOf(':');
      if (c <= 0) return undefined;
      const name = line.slice(0, c).trim();
      const value = line.slice(c + 1).trim();
      headers[name.toLowerCase()] = value;
      const lower = name.toLowerCase();
      if (lower === 'content-disposition') {
        shownHeaders.push(`${name}: ${(utf8Of(value) ?? value).replace(/(;\s*filename\*?\s*=\s*)("(?:[^"\\]|\\.)*"|[^;]*)/gi, (_m, pre: string, v: string) => `${pre}${redactSecretValues(v)}`)}`);
      } else if (lower === 'content-type') {
        shownHeaders.push(`${name}: ${value}`);
      } else {
        const r = redactHeaders({ [name]: utf8Of(value) ?? value }) ?? {};
        shownHeaders.push(`${name}: ${String(r[name])}`);
      }
    }
    const disposition = headers['content-disposition'] ?? '';
    const field = dispositionParam(disposition, 'name');
    const filename = dispositionParam(disposition, 'filename');
    const raw = s.slice(bodyStart, bodyEnd);
    const size = raw.length; // latin1: one char per byte
    let value: string;
    const partCt = headers['content-type'] ?? '';
    if (filename !== undefined) {
      value = `[file ${redactSecretValues(cleanName(filename)) || 'unnamed'}, ${size} bytes]`;
    } else if (field !== undefined && isSensitiveField(cleanName(field))) {
      value = REDACTED;
    } else {
      const text = utf8Of(raw);
      if (text === undefined || /^(image|audio|video|font)\/|octet-stream|application\/(zip|pdf|gzip|x-protobuf|protobuf)/i.test(partCt)) value = `[binary ${size} bytes]`;
      else if (/multipart\//i.test(partCt)) value = `[nested multipart, ${size} bytes]`;
      else {
        const whole = redactSecretValues(text, true);
        value = whole !== text && whole === REDACTED ? REDACTED : redactBodyText(text, partCt ? { 'content-type': partCt } : undefined);
      }
    }
    out.push(`${delim}\r\n${shownHeaders.join('\r\n')}${shownHeaders.length ? '\r\n' : ''}\r\n${value}${truncated && bodyEnd === s.length ? ' [truncated]' : ''}`);
    pos = next;
  }
  if (!parts && !closed) return undefined;
  return `${out.join('\r\n')}\r\n${closed && !truncated ? `${delim}--\r\n` : '[truncated]'}`;
}

/**
 * A recorded body as agents see it with redaction on: text bodies through `redactBodyText`; a binary (`base64`)
 * `multipart/form-data` body parsed by `redactMultipart` and returned as text (`encoding: 'utf8'`); other binary
 * bodies unchanged (callers summarise them).
 */
export function redactBody(b: Body, headers?: Headers): Body {
  if (b.encoding === 'utf8') return { ...b, text: redactBodyText(b.text, headers) };
  const ct = headerValue(headers, 'content-type') ?? '';
  if (!/multipart\/form-data/i.test(ct)) return b;
  // base64 text is 4/3 of the bytes: skip the decode when it can't fit
  if (b.text.length > Math.ceil((MAX_MULTIPART_BYTES * 4) / 3) + 4) return b;
  const out = redactMultipart(Buffer.from(b.text, 'base64'), ct);
  return out === undefined ? b : { text: out, encoding: 'utf8', ...(b.truncated ? { truncated: true } : {}) };
}
