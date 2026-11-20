/**
 * One "is this secret" check (REVIEW-16 #4–#6) for everything written for the team (snapshots §22.8, collections from
 * traffic §23.1, Update example §23.4, the copy without credentials §21.6), the store (§22.5: secret fields of a
 * request body are never kept) and, where it is wider, the agent redaction (§8). Pure: no vscode, no fs, no imports.
 *
 * Names (`isSecretName`): the name split into words (camelCase, snake_case, kebab-case, dots, digits). Secret when
 * - a word is in `SECRET_WORDS` (also its plural for stems of 5+ letters: `passwords`, `tokens`, `credentials`);
 * - two adjacent words are a pair in `SECRET_PAIRS` (`api key`, `access key`, `verification code`, …; plural second
 *   word too: `apiKeys`);
 * - a word that is a lower-case run ends with a `SECRET_SUFFIXES` stem (`newpassword`, `accesstoken`, `clientsecret`)
 *   or starts with a `SECRET_PREFIXES` stem (`passwordhash`, `apikeyid`);
 * - the whole name is `session`.
 * With the value at hand (`isSecretField`), the bare names `session`, `sessions` and `pass` are secret only for a text
 * value (a token, a password): a list of workout `sessions`, a `session` object, `pass: true` stay.
 * Short stems (`pin`, `sid`, `otp`, `auth`, `pass`, `sig`) match whole words only, and `token` / `secret` / `session`
 * never as a prefix, so `author`, `sessionCount`, `tokenizer`, `pinned`, `passenger`, `secretary` stay.
 *
 * Values (`isCredentialValue` / `scrubSecretText`): JWTs (a linear regex: one attempt per base64url run, REVIEW-16 #7),
 * `Bearer` / `Basic` / `Token` / `ApiKey` credentials (≥ 16 characters with a digit), long opaque tokens (≥ 32
 * characters mixing upper, lower and digits), well-known key prefixes (`sk_live_`, `xoxb-`, `AKIA`, `ghp_`, …), PEM
 * private keys, and URLs (absolute or relative) with userinfo or secret-named query / fragment parameters.
 */

const MAX_NAME = 200;

/** Whole words (lower case) that make a name secret. */
const SECRET_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passcode', 'passphrase', 'pass', 'secret', 'token', 'apikey', 'authorization', 'auth',
  'oauth', 'credential', 'cookie', 'privatekey', 'otp', 'totp', 'hotp', 'pin', 'sessionid', 'sessid', 'sid',
  'signature', 'sig', 'ssn', 'cvv', 'cvc', 'csrf', 'xsrf', 'hmac', 'nonce', 'bearer', 'jwt', 'mnemonic',
  'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'sessiontoken', 'clientsecret', 'secretkey', 'accesskey',
]);
/** Words that are secret as a plural too, besides stems of 5+ letters. */
const SHORT_PLURALS = new Set(['jwt', 'otp']);
/** Adjacent word pairs that are secret together. */
const SECRET_PAIRS = new Set([
  'api key', 'private key', 'priv key', 'secret key', 'access key', 'signing key', 'encryption key', 'session id',
  'session token', 'session key', 'session secret', 'refresh token', 'access token', 'id token', 'auth token',
  'client secret', 'card number', 'security answer', 'secret answer', 'seed phrase', 'recovery phrase',
]);
/** `<word> code` / `<word>code`: one-time and verification codes (a bare `code` is not secret: country, product …). */
const CODE_WORDS = new Set([
  'verification', 'verify', 'otp', 'sms', 'auth', 'authorization', 'reset', 'confirmation', 'confirm', 'security',
  'activation', 'mfa', 'recovery', 'backup', 'access', 'pairing', 'login', 'magic', 'twofa', 'one', 'passcode',
]);
/** A lower-case run ending with one of these is secret (`newpassword`, `accesstoken`, `clientsecret`). */
const SECRET_SUFFIXES = [
  'password', 'passwd', 'passphrase', 'passcode', 'token', 'secret', 'apikey', 'credential', 'cookie', 'signature',
  'sessionid', 'sessid', 'privatekey', 'accesskey', 'secretkey', 'otp',
];
/** A lower-case run starting with one of these is secret (`passwordhash`, `apikeyid`). */
const SECRET_PREFIXES = [
  'password', 'passwd', 'passphrase', 'passcode', 'credential', 'apikey', 'sessionid', 'secretkey', 'privatekey',
  'accesstoken', 'refreshtoken', 'authtoken', 'accesskey', 'clientsecret',
];

/**
 * A field name as lower-case words: camelCase / PascalCase (`APIKey` → api, key), snake_case, kebab-case, dots,
 * spaces, and digits as their own words (`pin2` → pin, 2).
 */
export function fieldWords(name: string): string[] {
  const n = name.length > MAX_NAME ? name.slice(0, MAX_NAME) : name;
  return (n.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []).map((w) => w.toLowerCase());
}

function singularOf(w: string): string | undefined {
  if (w.length < 4 || !w.endsWith('s')) return undefined;
  const s = w.slice(0, -1);
  return s.length >= 5 || SHORT_PLURALS.has(s) ? s : undefined;
}

function isSecretRun(w: string): boolean {
  if (SECRET_WORDS.has(w)) return true;
  for (const c of CODE_WORDS) if (w === `${c}code`) return true;
  for (const s of SECRET_SUFFIXES) if (w.length > s.length && w.endsWith(s)) return true;
  for (const p of SECRET_PREFIXES) if (w.length > p.length && w.startsWith(p)) return true;
  return false;
}

/** The shared name rule (see the header). Field names, query names, form fields and header names alike. */
export function isSecretName(name: string): boolean {
  if (typeof name !== 'string' || name === '') return false;
  const words = fieldWords(name);
  if (words.length === 1 && words[0] === 'session') return true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const one = singularOf(w);
    if (isSecretRun(w) || (one !== undefined && isSecretRun(one))) return true;
    if (i + 1 < words.length) {
      const next = words[i + 1];
      const nextOne = singularOf(next) ?? (next === 'keys' ? 'key' : next === 'codes' ? 'code' : undefined);
      for (const n of nextOne !== undefined ? [next, nextOne] : [next]) {
        if (SECRET_PAIRS.has(`${w} ${n}`)) return true;
        if (n === 'code' && CODE_WORDS.has(w)) return true;
      }
    }
  }
  return false;
}

/** Bare names that are secret only when their value is text (`isSecretField`). */
const TEXT_ONLY_NAMES = new Set(['session', 'sessions', 'pass']);

/**
 * The shared name rule for a field whose value is known (JSON bodies, records): as `isSecretName`, except that the
 * bare names `session` / `sessions` / `pass` are secret only when the value is a string (a token-like value);
 * objects, arrays, numbers, booleans and `null` under those names are kept.
 */
export function isSecretField(name: string, value: unknown): boolean {
  if (typeof name !== 'string' || name === '') return false;
  const words = fieldWords(name);
  if (words.length === 1 && TEXT_ONLY_NAMES.has(words[0]) && name.length <= MAX_NAME) return typeof value === 'string';
  return isSecretName(name);
}

const HEADER_EXACT = /^(?:authorization|proxy-authorization|cookie|set-cookie)$/i;
/** Header names that carry keys or signatures by convention (`Ocp-Apim-Subscription-Key`, `X-Request-Sig`). */
const HEADER_EXTRA = /(?:[-_](?:key|token|secret|sig|signature|auth)$|^(?:ocp-apim-subscription-key|x-functions-key|x-signature|signature)$)/i;

/** Header names whose values are credentials: the name rule plus the header conventions (§21.6). */
export function isSecretHeaderName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  return HEADER_EXACT.test(n) || HEADER_EXTRA.test(n) || isSecretName(n);
}

/** Query / fragment parameters whose values are signatures or credentials (signed URLs, OAuth codes). */
const SIGNED_QUERY = /^(?:x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|sig|signature|token|access_token|key|code|hmac|policy|key-pair-id|client_secret|apikey|api_key)$/i;

export function isSecretQueryName(name: string): boolean {
  if (typeof name !== 'string') return false;
  return SIGNED_QUERY.test(name) || (/^x-(?:amz|goog)-/i.test(name) && /signature|credential|token/i.test(name)) || isSecretName(name);
}

// ------------------------------------------------------------------ values

/**
 * A JWT anywhere in text. REVIEW-16 #7: the lookbehind makes one attempt per base64url run (linear); `\b` tried again
 * before every `eyJ` of `eyJa-eyJa-…` (quadratic). A JWT glued to a preceding `-` / `_` / letter is part of a longer
 * run, which the opaque-token rule catches when it is the whole value.
 */
export const JWT_ANY = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
export const JWT_WHOLE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;
/** `Bearer <credential>` and friends; the credential needs a digit (prose like "basic informational" stays). */
export const AUTH_SCHEME = /\b(Bearer|Basic|Token|ApiKey|Api-Key)(\s+)([A-Za-z0-9._~+/=-]{16,})/gi;
const AUTH_WORD = /bearer|basic|token|api-?key/i;
const OPAQUE = /^[A-Za-z0-9_\-.~+/=]{32,}$/;
const PREFIX_BODY =
  'gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{6,}|xox[abprs]-[A-Za-z0-9-]{6,}|' +
  'AKIA[0-9A-Z]{16}(?![0-9A-Za-z])|AIza[0-9A-Za-z_-]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}';
/** Well-known credential prefixes (GitHub, Stripe, Slack, AWS, Google, OpenAI / Anthropic, GitLab, npm). */
export const TOKEN_PREFIX = new RegExp(`^(?:${PREFIX_BODY})`);
const TOKEN_PREFIX_ANY = new RegExp(`(?<![A-Za-z0-9_-])(?:${PREFIX_BODY})[A-Za-z0-9_-]*`, 'g');
/** A PEM private key block; its body can't hold `-----`, so every attempt stops at the next dash run (linear). */
const PEM_ANY = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:[A-Za-z0-9+/=\s:,.]|-(?!----)){0,65536}-----END [A-Z ]{0,40}PRIVATE KEY-----/g;
const PEM_START = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/;

/** A whole value that is a long opaque token (mixed upper, lower and digits, ≥ 32 characters). */
export function isOpaqueToken(v: string): boolean {
  return OPAQUE.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v);
}

/** A whole value that starts with a well-known credential prefix (one word). */
export function isPrefixedToken(v: string): boolean {
  return v.length >= 10 && v.length <= 4096 && !/\s/.test(v) && TOKEN_PREFIX.test(v);
}

function hasSchemeCredential(text: string): boolean {
  if (!AUTH_WORD.test(text)) return false;
  AUTH_SCHEME.lastIndex = 0;
  for (const m of text.matchAll(AUTH_SCHEME)) if (/\d/.test(m[3])) return true;
  return false;
}

/** A value that is (or holds) a credential: opaque / prefixed token, JWT, scheme credential, PEM private key. */
export function isCredentialValue(v: string): boolean {
  if (typeof v !== 'string' || v === '') return false;
  if (isOpaqueToken(v) || isPrefixedToken(v)) return true;
  if (v.includes('eyJ')) {
    JWT_ANY.lastIndex = 0;
    if (JWT_ANY.test(v)) return true;
  }
  if (v.includes('PRIVATE KEY') && PEM_START.test(v)) return true;
  return hasSchemeCredential(v);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

export interface ScrubOptions {
  /** What a JWT becomes (default `''`). */
  jwt?: string;
  /** Extra query names to blank (the caller's own rule, e.g. the agent's substring rule for request URLs). */
  query?: (name: string) => boolean;
  /** Called with a label (a name, never a value) for each kind of thing removed. */
  note?: (label: string) => void;
}

/** A URL (absolute or relative) without userinfo and with secret query / fragment values blanked (names kept). */
export function scrubUrl(u: string, o: ScrubOptions = {}): string {
  let out = u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, (_m, scheme: string) => {
    o.note?.('credentials in URLs');
    return scheme;
  });
  out = out.replace(/([?#&])([^=&#?]{1,200})=([^&#]*)/g, (whole, sep: string, rawKey: string, value: string) => {
    const key = safeDecode(rawKey);
    if (value && (isSecretQueryName(key) || (o.query?.(key) ?? false))) {
      o.note?.(`${key} (in URLs)`);
      return `${sep}${rawKey}=`;
    }
    return whole;
  });
  return out;
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>`\\]+/gi;
/** A relative URL with a query (`/files/1?sig=…`) after a delimiter. */
const RELATIVE_URL_IN_TEXT = /(^|[\s"'(<>=,[{])(\.{0,2}\/[A-Za-z0-9._~%!$'()*+,:@/-]{0,2048}\?[^\s"'<>`\\]{1,8192})/g;

/**
 * Credentials inside free text: JWTs → `o.jwt` (default `''`), the credential after `Bearer` / `Basic` / `Token` /
 * `ApiKey` → empty, well-known prefixed keys and PEM private keys → empty, URLs (absolute and relative) through
 * `scrubUrl`. Linear in the text.
 */
export function scrubSecretText(text: string, o: ScrubOptions = {}): string {
  if (typeof text !== 'string' || text === '') return text;
  const jwt = o.jwt ?? '';
  let out = text;
  if (out.includes('eyJ')) {
    out = out.replace(JWT_ANY, () => {
      o.note?.(jwt ? 'JWTs (a fixed unsigned placeholder)' : 'JWTs');
      return jwt;
    });
  }
  if (AUTH_WORD.test(out)) {
    out = out.replace(AUTH_SCHEME, (m, scheme: string, sp: string, cred: string) => {
      if ((jwt && cred === jwt) || !/\d/.test(cred)) return m;
      o.note?.('Bearer / Basic credentials');
      return `${scheme}${sp}`;
    });
  }
  if (out.includes('PRIVATE KEY')) {
    out = out.replace(PEM_ANY, () => {
      o.note?.('private keys');
      return '';
    });
  }
  out = out.replace(TOKEN_PREFIX_ANY, (m) => {
    if (m.length < 10) return m;
    o.note?.('API keys');
    return '';
  });
  if (out.includes('://')) out = out.replace(URL_IN_TEXT, (u) => scrubUrl(u, o));
  if (out.includes('/') && out.includes('?')) {
    out = out.replace(RELATIVE_URL_IN_TEXT, (_m, lead: string, u: string) => `${lead}${scrubUrl(u, o)}`);
  }
  return out;
}

/** One whole string value that is a relative URL with a query (`/files/1?sig=…`): through `scrubUrl`. */
export function isRelativeUrlWithQuery(v: string): boolean {
  return /^\.{0,2}\/[^\s?]{0,2048}\?[^\s]+$/.test(v);
}

// ------------------------------------------------------------------ names inside text (not-quite-JSON, XML, forms, prose)

const JSON_PAIR = /"((?:[^"\\\n]|\\.){1,200})"(\s{0,16}:\s{0,16})("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]{0,64}|-?Infinity|NaN|true|false|null)/g;
const JSON_CONTAINER = /"((?:[^"\\\n]|\\.){1,200})"\s{0,16}:\s{0,16}[[{]/g;
const TEXT_PAIR = /(^|[\s&;,?{(|[])([A-Za-z_][A-Za-z0-9_.-]{0,63})([ \t]{0,8}[:=][ \t]{0,8})("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s&;,"'<>]{1,4096})/g;
const XML_ELEMENT = /<([A-Za-z_][\w.:-]{0,63})(\s[^<>]{0,2048})?>([^<]{1,65536})<\/\1\s*>/g;
const HTML_INPUT = /<input\b[^<>]{0,2048}>/gi;

function nameOfJsonKey(raw: string): string {
  if (!raw.includes('\\')) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function localName(tag: string): string {
  const c = tag.lastIndexOf(':');
  return c >= 0 ? tag.slice(c + 1) : tag;
}

/**
 * Values of secret-named entries inside text that isn't parsed as JSON: `"name": value` pairs (strings `""`, other
 * literals `0` / `null`), `name=value` / `name: value` pairs, `<name>value</name>` elements and `<input name=… value=…>`.
 * `isSecret` decides on the name (default `isSecretName`). Linear: every pattern is bounded per start.
 */
export function scrubNamedText(text: string, isSecret: (name: string) => boolean = isSecretName, note?: (name: string) => void): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  if (out.includes('"')) {
    out = out.replace(JSON_PAIR, (whole, rawName: string, sep: string, value: string) => {
      const name = nameOfJsonKey(rawName);
      if (!isSecret(name) || value === '""' || value === 'null' || value === 'true' || value === 'false') return whole;
      note?.(name);
      return `"${rawName}"${sep}${value.startsWith('"') ? '""' : '0'}`;
    });
  }
  if (out.includes('<')) {
    out = out.replace(XML_ELEMENT, (whole, tag: string, attrs: string | undefined, content: string) => {
      if (!isSecret(localName(tag)) || content.trim() === '') return whole;
      note?.(localName(tag));
      return `<${tag}${attrs ?? ''}></${tag}>`;
    });
    out = out.replace(HTML_INPUT, (tag) => {
      const nm = /\sname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const name = nm ? (nm[1] ?? nm[2] ?? nm[3] ?? '') : '';
      if (!name || !isSecret(name)) return tag;
      note?.(name);
      return tag.replace(/(\svalue\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '$1""');
    });
  }
  if (out.includes('=') || out.includes(':')) {
    out = out.replace(TEXT_PAIR, (whole, lead: string, name: string, sep: string, value: string) => {
      if (!isSecret(name)) return whole;
      const q = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      if (value === `${q}${q}`) return whole;
      note?.(name);
      return `${lead}${name}${sep}${q}${q}`;
    });
  }
  return out;
}

/** Text that still holds a secret-named JSON container (`"tokens": {…}`), which a pattern can't blank safely. */
export function hasSecretContainer(text: string, isSecret: (name: string) => boolean = isSecretName): boolean {
  if (!text.includes('"')) return false;
  for (const m of text.matchAll(JSON_CONTAINER)) if (isSecret(nameOfJsonKey(m[1]))) return true;
  return false;
}

// ------------------------------------------------------------------ JSON values (the store)

/**
 * A copy of a parsed JSON value without the entries whose names are secret (at any depth, through arrays). `removed`
 * gets each dropped name once. Used on request bodies before the store keeps them (§22.5, REVIEW-16 #4).
 */
export function withoutSecretFields(value: unknown, removed?: Set<string>, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 64) return value;
  if (Array.isArray(value)) return value.map((v) => withoutSecretFields(v, removed, depth + 1));
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(value)) {
    const v = Object.getOwnPropertyDescriptor(value, k)?.value as unknown;
    if (isSecretField(k, v)) {
      removed?.add(k);
      continue;
    }
    Object.defineProperty(out, k, { value: withoutSecretFields(v, removed, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

const EMAIL_IN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/;

/**
 * A label safe to show for a name (a key, a field path segment): a kind instead of a name that is itself personal
 * data or a credential (REVIEW-16 #11: an e-mail or phone number used as a JSON key).
 */
export function safeNameLabel(name: string): string {
  if (EMAIL_IN.test(name) || /%40/i.test(name)) return 'a key that is an e-mail address';
  if (/\+?\d[\d ()-]{6,}\d/.test(name)) return 'a key that is a number';
  if (isCredentialValue(name)) return 'a key that looks like a credential';
  return name;
}
