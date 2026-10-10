/**
 * Policy for shared rules (CONTRACTS §12.1, REVIEW-6 #4/#6/#8). Pure.
 *
 * - Approval gate: a rule from a cloned repo must not silently send the app's (authenticated) traffic elsewhere,
 *   redirect it, change what the real server receives, or serve pages / scripts to the Flutter Web debug browser.
 *   Held back until the user approves that rule (src/rules/core.ts): see `approvalReasons` for the list; sequence
 *   steps are inspected the same way.
 * - Secrets: shared rules and body files are committed with the code, so writing them is refused when a value looks
 *   like a credential: JWTs, Bearer/Basic credentials, long random tokens, AWS access key ids, PEM private keys,
 *   `user:pass@` in URLs, and any non-placeholder value under a credential name (JSON key, form field, query
 *   parameter, header such as authorization / cookie / x-api-key). Placeholders ("fake-token", "<token>", "xxx",
 *   "[redacted]", "changeme", "${TOKEN}", anything under 4 characters, globs) stay allowed.
 */
import type { Rule, RuleAction } from '@flutter-intercept/proxy';
import { isOpaqueToken, isSensitiveHeader, redactSecretValues } from '../agent/redact';

type AnyAction = RuleAction | { kind: 'passthrough' };

// ------------------------------------------------------------------ text for prompts

/** Control, bidi and zero-width characters: they could fake lines or reorder text in a prompt. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** `text` safe for one line of a prompt: control/bidi characters removed, whitespace collapsed, capped. */
export function cleanText(text: string, max = 80): string {
  const t = text.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const q = (v: unknown, max = 80) => `"${cleanText(String(v), max)}"`;

/** Readable, sanitised label of a rule for messages: its name, else its id, in quotes. */
export function ruleLabel(rule: { id?: unknown; name?: unknown }): string {
  if (typeof rule.name === 'string' && cleanText(rule.name)) return q(rule.name);
  return typeof rule.id === 'string' ? q(rule.id.replace(/^shared(@[^:]*)?:/, '')) : 'a rule';
}

/** "GET https://api.example.com/*" (sanitised), "any method" when the rule doesn't pin one. */
export function matchLabel(rule: Rule): string {
  const m = rule.match.method && rule.match.method !== '*' ? rule.match.method.toUpperCase() : 'any method';
  const op = rule.match.graphqlOperation ? ` (GraphQL ${cleanText(rule.match.graphqlOperation, 60)})` : '';
  return `${cleanText(m, 20)} ${cleanText(rule.match.url, 200)}${op}`;
}

// ------------------------------------------------------------------ approval gate

/** Loopback host of an absolute URL / origin: localhost, *.localhost, 127.0.0.0/8, ::1 (also IPv4-mapped). */
export function isLoopbackTarget(to: string): boolean {
  let host: string;
  try {
    host = new URL(to).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped loopback (WHATWG serialises ::ffff:127.0.0.1 as ::ffff:7f00:1)
  return /^::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/.test(host);
}

function origin(to: string): string {
  try {
    const u = new URL(to);
    return cleanText(`${u.protocol}//${u.host}`, 200);
  } catch {
    return cleanText(to, 200);
  }
}

const ACTIVE_CONTENT = /(html|javascript|ecmascript|svg|xml)/i;
const ACTIVE_EXT = /\.(html?|xhtml|svg|m?js|xml)$/i;

function contentKind(contentType: string): string {
  return /javascript|ecmascript/i.test(contentType) ? 'JavaScript' : /svg/i.test(contentType) ? 'an SVG image (can run scripts)' : 'an HTML page';
}

function headerEntries(h: Record<string, string> | undefined): [string, string, string][] {
  return Object.entries(h ?? {}).map(([k, v]) => [k, k.toLowerCase(), String(v)]);
}

/** Reasons for response headers a shared mock / response rewrite sets. */
function responseHeaderReasons(h: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [name, lower, value] of headerEntries(h)) {
    if (lower === 'location') out.push(`sends the app on to ${q(value, 120)} (Location header)`);
    else if (lower === 'refresh') out.push(`makes the page reload or go elsewhere (Refresh: ${q(value)})`);
    else if (lower.startsWith('content-security-policy')) out.push("changes the page's Content-Security-Policy");
    else if (lower === 'set-cookie') out.push(`sets a cookie (Set-Cookie: ${q(value.split(';')[0], 60)})`);
    else if (lower.startsWith('access-control-')) out.push(`changes which websites may read these responses (${cleanText(name, 60)}: ${q(value, 60)})`);
    else if (lower.startsWith('x-forwarded-')) out.push(`sets the forwarding header ${cleanText(name, 60)}: ${q(value, 60)}`);
    else if (lower === 'content-type' && ACTIVE_CONTENT.test(value)) out.push(`serves ${contentKind(value)} (Content-Type: ${q(value, 60)})`);
  }
  return out;
}

const listNames = (names: string[]) => `${names.slice(0, 5).map((n) => cleanText(n, 60)).join(', ')}${names.length > 5 ? ', …' : ''}`;

function actionApprovalReasons(a: AnyAction): string[] {
  const out: string[] = [];
  switch (a.kind) {
    case 'mapRemote':
      if (!isLoopbackTarget(a.to)) out.push(`sends the app's requests to ${origin(a.to)} instead of the real server`);
      break;
    case 'rewrite': {
      const req = a.request;
      const set = headerEntries(req?.setHeaders);
      if (set.length) {
        out.push(`changes request headers sent to the server: ${set.slice(0, 5).map(([n, , v]) => `${cleanText(n, 60)}: ${q(v, 60)}`).join(', ')}${set.length > 5 ? ', …' : ''}`);
      }
      if (req?.removeHeaders?.length) out.push(`removes request headers before they reach the server: ${listNames(req.removeHeaders)}`);
      if (req?.replaceBody?.length) {
        const r = req.replaceBody[0];
        out.push(`changes the request body sent to the server (${q(r.find, 60)} → ${q(r.replace, 60)}${req.replaceBody.length > 1 ? `, and ${req.replaceBody.length - 1} more` : ''})`);
      }
      const res = a.response;
      if (typeof res?.status === 'number' && res.status >= 300 && res.status < 400) out.push(`turns the response into a redirect (status ${res.status})`);
      out.push(...responseHeaderReasons(res?.setHeaders));
      if (res?.removeHeaders?.some((n) => n.toLowerCase().startsWith('content-security-policy'))) out.push("removes the page's Content-Security-Policy");
      for (const r of res?.replaceBody ?? []) {
        if (/<|javascript:/i.test(r.replace)) {
          out.push(`inserts HTML or script into the response (${q(r.replace, 60)})`);
          break;
        }
      }
      break;
    }
    case 'mock': {
      if (a.status >= 300 && a.status < 400) out.push(`answers with a redirect (status ${a.status})`);
      out.push(...responseHeaderReasons(a.headers));
      const hasType = headerEntries(a.headers).some(([, lower]) => lower === 'content-type');
      if (!hasType && a.bodyFile && ACTIVE_EXT.test(a.bodyFile)) out.push(`serves the file ${q(a.bodyFile, 80)} as a page or script`);
      else if (!hasType && !a.bodyFile && a.body.trimStart().startsWith('<')) out.push('serves what looks like an HTML page');
      break;
    }
    case 'cors':
      out.push(`lets other websites read these responses (CORS for ${a.allowOrigin ? q(a.allowOrigin, 60) : 'any origin'}${a.allowCredentials ? ', with cookies' : ''})`);
      break;
    default:
      break;
  }
  return out;
}

/** Why this shared rule needs the user's approval, in plain words (empty: it doesn't). */
export function approvalReasons(rule: Rule): string[] {
  const a = rule.action;
  if (a.kind === 'sequence') {
    return (a.steps ?? []).flatMap((step, i) => actionApprovalReasons(step.action).map((r) => `step ${i + 1} ${r}`));
  }
  return actionApprovalReasons(a);
}

/** All reasons joined, or undefined when the rule needs no approval. */
export function approvalReason(rule: Rule): string | undefined {
  const r = approvalReasons(rule);
  return r.length ? r.join('; ') : undefined;
}

// ------------------------------------------------------------------ secrets

const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./;
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const AWS_KEY_ID = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/;

/** A value that is obviously not a real credential. */
export function isPlaceholder(value: string): boolean {
  const t = value.trim();
  if (t.length < 4) return true;
  if (/^[*x•.#_-]+$/i.test(t)) return true; // xxxx, ****, globs
  if (/^(<[^<>]*>|\$\{[^{}]*\}|\{\{[^{}]*\}\}|%[A-Za-z0-9_]+%|\$[A-Z][A-Z0-9_]*|\[[^\][]*\])$/.test(t)) return true;
  return /(fake|test|dummy|example|sample|placeholder|mock|demo|change[-_ ]?me|redacted|your[-_ ]|xxx|todo|not[-_ ]?a[-_ ]?real)/i.test(t);
}

/** JSON keys / form fields / query parameters whose values are credentials. */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  // metadata about a credential, not the credential (token_type, tokenExpiresIn, password_hint, api_key_name …)
  if (/(type|expires|expiresin|expiresat|ttl|count|length|url|uri|endpoint|hint|policy|required|label|name|enabled|format|scopes?|algorithm|kind|version)$/.test(k.replace(/[-_.]/g, ''))) return false;
  return (
    /(password|passwd|passphrase|secret|token|api[-_]?key|apikey|private[-_]?key|access[-_]?key|credential|jwt)/.test(k) ||
    /^(pass|pwd|pin|session|session[-_]?(id|key)|sid|auth|authorization|cookie)$/.test(k)
  );
}

/** Headers whose values are credentials (authorization, cookie, x-api-key, x-auth-token …). */
export function isCredentialHeader(name: string): boolean {
  const n = name.toLowerCase();
  return /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-amz-security-token)$/.test(n) || (n !== 'set-cookie' && isSensitiveHeader(n));
}

/** What a single value (header value, JSON string value) looks like, when it looks like a credential. */
export function secretKind(value: string, headerName?: string): string | undefined {
  if (PEM.test(value)) return 'a private key';
  if (AWS_KEY_ID.test(value)) return 'an AWS access key id';
  if (JWT.test(value)) return 'a JWT';
  if (redactSecretValues(value) !== value) return 'a Bearer/Basic credential';
  if (isOpaqueToken(value.trim())) return 'a long random token';
  if (!headerName) return undefined;
  const lower = headerName.toLowerCase();
  if (lower === 'cookie' || lower === 'set-cookie') {
    const pairs = lower === 'set-cookie' ? [value.split(';')[0]] : value.split(';');
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? '' : pair.slice(0, eq).trim();
      const v = eq < 0 ? pair.trim() : pair.slice(eq + 1).trim();
      if (isOpaqueToken(v) || /^[0-9a-f]{32,}$/i.test(v)) return 'a credential';
      if (name && isSensitiveKey(name) && !isPlaceholder(v)) return 'a credential';
    }
    return undefined;
  }
  if (isCredentialHeader(lower)) {
    const v = value.replace(/^(bearer|basic|token|digest|apikey|api-key)\s+/i, '');
    if (!isPlaceholder(v)) return 'a credential';
  }
  return undefined;
}

/** Credential patterns anywhere in free text (names, find strings, non-JSON bodies). */
export function textSecretKind(text: string): string | undefined {
  if (PEM.test(text)) return 'a private key';
  if (AWS_KEY_ID.test(text)) return 'an AWS access key id';
  if (JWT.test(text)) return 'a JWT';
  if (redactSecretValues(text) !== text) return 'a Bearer/Basic credential';
  for (const m of text.matchAll(/[A-Za-z0-9_\-.~+/=]{32,}/g)) if (isOpaqueToken(m[0])) return 'a long random token';
  return undefined;
}

function walkJson(v: unknown, key: string | undefined, depth: number): string | undefined {
  if (depth > 200) return undefined;
  if (typeof v === 'string') {
    const k = secretKind(v);
    if (k) return k;
    if (key !== undefined && isSensitiveKey(key) && !isPlaceholder(v)) return `a credential (in ${q(key, 40)})`;
    return undefined;
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = walkJson(x, key, depth + 1);
      if (r) return r;
    }
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const r = walkJson(x, k, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

function formSecretKind(text: string): string | undefined {
  for (const [k, v] of new URLSearchParams(text)) {
    const kind = secretKind(v);
    if (kind) return kind;
    if (isSensitiveKey(k) && !isPlaceholder(v)) return `a credential (in ${q(k, 40)})`;
  }
  return undefined;
}

/** What a body text contains that looks like a credential. */
export function bodySecretKind(text: string): string | undefined {
  if (PEM.test(text)) return 'a private key';
  if (AWS_KEY_ID.test(text)) return 'an AWS access key id';
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const r = walkJson(JSON.parse(text), undefined, 0);
      if (r) return r;
      return textSecretKind(text);
    } catch {
      // not JSON: pattern checks below
    }
  }
  if (/^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(t)) {
    const r = formSecretKind(t);
    if (r) return r;
  }
  // JSON-like text: "key": "value" pairs
  for (const m of text.matchAll(/"([^"\\]{1,100})"\s*:\s*"([^"\\]*)"/g)) {
    if (isSensitiveKey(m[1]) && !isPlaceholder(m[2])) return `a credential (in ${q(m[1], 40)})`;
  }
  return textSecretKind(text);
}

/** What a URL / URL pattern carries that looks like a credential (userinfo, credential query values, tokens). */
export function urlSecretKind(url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url)) return 'a user name / password';
  const qi = url.indexOf('?');
  if (qi >= 0) {
    const r = formSecretKind(url.slice(qi + 1).split('#')[0]);
    if (r) return r;
  }
  for (const part of url.split(/[/?&=#]/)) {
    let v = part;
    try {
      v = decodeURIComponent(part);
    } catch {
      // keep it raw
    }
    const k = secretKind(v);
    if (k) return k;
  }
  return undefined;
}

function headersSecret(h: Record<string, string> | undefined, where: string): string | undefined {
  for (const [name, value] of Object.entries(h ?? {})) {
    const k = typeof value === 'string' ? secretKind(value, name) : undefined;
    if (k) return `${where} header ${cleanText(name, 60)} looks like ${k}`;
  }
  return undefined;
}

function actionSecret(a: AnyAction, bodyFileText: (path: string) => string | undefined): string | undefined {
  switch (a.kind) {
    case 'mock': {
      const h = headersSecret(a.headers, 'mock');
      if (h) return h;
      const text = a.bodyFile ? bodyFileText(a.bodyFile) : a.body;
      const k = typeof text === 'string' ? bodySecretKind(text) : undefined;
      if (k) return a.bodyFile ? `the mock body file ${cleanText(a.bodyFile, 120)} contains what looks like ${k}` : `the mock body contains what looks like ${k}`;
      return undefined;
    }
    case 'mapRemote': {
      const k = urlSecretKind(a.to);
      return k ? `the map remote target contains what looks like ${k}` : undefined;
    }
    case 'rewrite': {
      const h = headersSecret(a.request?.setHeaders, 'request') ?? headersSecret(a.response?.setHeaders, 'response');
      if (h) return h;
      for (const r of [...(a.request?.replaceBody ?? []), ...(a.response?.replaceBody ?? [])]) {
        const k = (typeof r.replace === 'string' ? bodySecretKind(r.replace) : undefined) ?? (typeof r.find === 'string' ? textSecretKind(r.find) : undefined);
        if (k) return `a body replacement contains what looks like ${k}`;
      }
      return undefined;
    }
    case 'sequence':
      for (const [i, step] of (a.steps ?? []).entries()) {
        const r = actionSecret(step.action, bodyFileText);
        if (r) return `step ${i + 1}: ${r}`;
      }
      return undefined;
    default:
      return undefined;
  }
}

const PLACEHOLDER_HINT = 'Replace it with a placeholder (for example "test-token")';

/**
 * Why this rule must not be written to the shared file (it would commit a credential), or undefined.
 * `bodyFileText` returns a `bodyFile`'s content when it can be read (it is committed too).
 */
export function secretProblem(rule: Rule, bodyFileText: (path: string) => string | undefined = () => undefined): string | undefined {
  const n = typeof rule.name === 'string' ? textSecretKind(rule.name) : undefined;
  const u = urlSecretKind(rule.match.url);
  const what = n ? `its name contains what looks like ${n}` : u ? `its URL pattern contains what looks like ${u}` : actionSecret(rule.action, bodyFileText);
  if (!what) return undefined;
  const label = n ? 'a rule' : `rule ${ruleLabel(rule)}`;
  return `Not shared: ${label} — ${what}. Shared rules are committed with the code, so a real credential would end up in the repository. ${PLACEHOLDER_HINT}, or keep this rule personal.`;
}

/** Why `text` must not be written to a body file under `.vscode/` (usually committed), or undefined. */
export function bodyFileSecretProblem(text: string): string | undefined {
  const k = bodySecretKind(text);
  if (!k) return undefined;
  return `Not written: the body contains what looks like ${k}. Body files under .vscode/ are usually committed with the code, so a real credential would end up in the repository. ${PLACEHOLDER_HINT} first.`;
}
