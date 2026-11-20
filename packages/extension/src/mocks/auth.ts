/**
 * Auth simulation, light (CONTRACTS §24.1): sessions, never credentials. Pure: no vscode, no fs, no network; time is
 * passed in and randomness is injectable.
 *
 * - `detectAuth(endpoints)`: the login / refresh / logout endpoint keys.
 * - `loginIdentifier(body)`: the login name (email / username / phone …) of a login request body, read from an
 *   allow-list of field names — a password field is never read.
 * - `AuthSessions`: token → expiry, in host memory only. Random-mode tokens come from `crypto.randomBytes`; the JWT
 *   `sub` is an HMAC of the login name with a per-instance random key. `login` rewrites the login example's token-like fields;
 *   `check` answers `ok | missing | expired | unknown` for an `Authorization` header; `refresh`, `logout`,
 *   `expireAll`, `clear`, `count`. ≤ `MAX_SESSIONS` sessions (oldest dropped, one note until `clear`); tokens ≤ 4 KB.
 * - `isProtected(endpoint, protect, auth)`, `defaultProtect(endpoints)`, `unauthorizedExample(endpoint, login)`.
 */
import { createHmac, randomBytes } from 'crypto';
import type { DynamicMode } from './dynamic';
import type { MockEndpoint, MockExample } from './types';

export const MAX_SESSIONS = 1000;
export const MAX_TOKEN_BYTES = 4096;
export const DEFAULT_TTL_SECONDS = 3600;
export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 86_400;

const LOGIN_SEGMENT = /^(?:login|signin|sign-in|authenticate|token|sessions?)$/i;
const REFRESH_SEGMENT = /^(?:refresh|refresh-token|refresh_token)$/i;
const LOGOUT_SEGMENT = /^(?:logout|signout|sign-out)$/i;
/** Public in `protect: 'all'` besides login / refresh / logout. */
const PUBLIC_SEGMENT = /^(?:register|signup|sign-up|forgot-password|forgot_password|forgotpassword|reset-password|reset_password)$/i;

/** Normalised (lower case, no `_` / `-`) names of fields rewritten by `login` / `refresh`. */
const ACCESS_FIELDS = new Set(['accesstoken', 'token', 'jwt', 'idtoken']);
const REFRESH_FIELDS = new Set(['refreshtoken']);
const EXPIRES_IN_FIELDS = new Set(['expiresin']);
const EXPIRES_AT_FIELDS = new Set(['expiresat']);
/** Login name fields, in order of preference (normalised). Nothing else in a login body is read. */
const IDENTIFIER_FIELDS = ['email', 'username', 'login', 'phone', 'phonenumber', 'mobile', 'identifier', 'user'];
const MAX_IDENTIFIER_CHARS = 256;
const MAX_REWRITE_DEPTH = 4;

function norm(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

function own(obj: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? Object.getOwnPropertyDescriptor(obj, key)?.value : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lastLiteral(endpoint: MockEndpoint): string | undefined {
  const last = endpoint.path[endpoint.path.length - 1];
  return typeof last === 'string' ? last : undefined;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ------------------------------------------------------------------ detection

export interface AuthEndpoints {
  login?: string;
  refresh?: string;
  logout?: string;
}

/**
 * CONTRACTS §24.1: login = `POST` whose last segment is `login|signin|sign-in|authenticate|token|session(s)`; refresh
 * = `POST …/refresh|refresh-token|refresh_token`, else an `…/oauth/token` login (then the request's `grant_type`
 * decides, `isRefreshGrant`); logout = any method on `…/logout|signout|sign-out`. The first in file order wins (a
 * problem line names the others). Pure; never throws.
 */
export function detectAuth(endpoints: readonly MockEndpoint[]): AuthEndpoints & { problems: string[] } {
  const problems: string[] = [];
  const found: Record<'login' | 'refresh' | 'logout', string[]> = { login: [], refresh: [], logout: [] };
  for (const ep of endpoints) {
    const seg = lastLiteral(ep);
    if (seg === undefined) continue;
    if (ep.method === 'POST' && LOGIN_SEGMENT.test(seg)) found.login.push(ep.key);
    else if (ep.method === 'POST' && REFRESH_SEGMENT.test(seg)) found.refresh.push(ep.key);
    else if (LOGOUT_SEGMENT.test(seg)) found.logout.push(ep.key);
  }
  const out: AuthEndpoints & { problems: string[] } = { problems };
  for (const kind of ['login', 'refresh', 'logout'] as const) {
    const keys = found[kind];
    if (keys.length === 0) continue;
    out[kind] = keys[0];
    if (keys.length > 1) {
      const others = keys.slice(1, 4).map((k) => `"${k}"`).join(', ');
      problems.push(`Several ${kind} endpoints: using "${keys[0]}" (also ${others}${keys.length > 4 ? ', …' : ''}).`);
    }
  }
  if (out.refresh === undefined && out.login !== undefined) {
    const ep = endpoints.find((e) => e.key === out.login);
    const p = ep?.path ?? [];
    const prev = p[p.length - 2];
    if (typeof prev === 'string' && prev.toLowerCase() === 'oauth' && /^token$/i.test(lastLiteral(ep as MockEndpoint) ?? '')) {
      out.refresh = out.login;
    }
  }
  return out;
}

/** `grant_type=refresh_token` in a parsed request body (JSON object or urlencoded flat object). */
export function isRefreshGrant(body: unknown): boolean {
  return isPlainObject(body) && own(body, 'grant_type') === 'refresh_token';
}

/** The refresh token a refresh request sends (`refresh_token` / `refreshToken`), or undefined. */
export function refreshTokenOf(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  for (const k of Object.keys(body)) {
    if (!REFRESH_FIELDS.has(norm(k))) continue;
    const v = own(body, k);
    if (typeof v === 'string' && v !== '' && utf8Bytes(v) <= MAX_TOKEN_BYTES) return v;
  }
  return undefined;
}

/**
 * The login name in a login request body (email, username, phone …), top level or in a `user` object. Only the
 * allow-listed field names are looked at: a password is never read.
 */
export function loginIdentifier(body: unknown): string | undefined {
  const fromObject = (obj: Record<string, unknown>): string | undefined => {
    // Names only (no descriptors): a value is read for an allow-listed name and nothing else.
    const keys = Reflect.ownKeys(obj).filter((k): k is string => typeof k === 'string');
    for (const want of IDENTIFIER_FIELDS) {
      for (const k of keys) {
        if (norm(k) !== want) continue;
        const v = own(obj, k);
        if ((typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v))) {
          return String(v).slice(0, MAX_IDENTIFIER_CHARS);
        }
      }
    }
    return undefined;
  };
  if (!isPlainObject(body)) return undefined;
  const top = fromObject(body);
  if (top !== undefined) return top;
  const user = own(body, 'user');
  return isPlainObject(user) ? fromObject(user) : undefined;
}

// ------------------------------------------------------------------ protection

/** CONTRACTS §24.1: `'declared'` when the collection declares any auth, else `'all'`. */
export function defaultProtect(endpoints: readonly MockEndpoint[]): 'declared' | 'all' {
  return endpoints.some((e) => e.auth === 'declared') ? 'declared' : 'all';
}

/**
 * CONTRACTS §24.1: does this endpoint need a session? Login / refresh / logout never; an endpoint that declares no
 * auth (`auth: 'none'`: OpenAPI `security: []`, Postman `noauth`) never; `'declared'` → when it declares auth;
 * `'all'` → every other endpoint except register / sign-up / forgot- or reset-password.
 */
export function isProtected(endpoint: MockEndpoint, protect: 'declared' | 'all', authEndpoints: AuthEndpoints): boolean {
  const k = endpoint.key;
  if (k === authEndpoints.login || k === authEndpoints.refresh || k === authEndpoints.logout) return false;
  if (endpoint.auth === 'none') return false;
  if (protect === 'declared') return endpoint.auth === 'declared';
  const seg = lastLiteral(endpoint);
  return !(seg !== undefined && PUBLIC_SEGMENT.test(seg));
}

/** CONTRACTS §24.1: the endpoint's 401 example, else the login endpoint's, else undefined (→ `UNAUTHORIZED_BODY`). */
export function unauthorizedExample(endpoint: MockEndpoint | undefined, login: MockEndpoint | undefined): MockExample | undefined {
  return endpoint?.examples.find((e) => e.status === 401) ?? login?.examples.find((e) => e.status === 401);
}
export const UNAUTHORIZED_BODY = '{"error":"unauthorized"}';

// ------------------------------------------------------------------ tokens

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** The claims of a JWT-looking token (`header.payload.signature`, header JSON with `alg`), else undefined. */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  if (token.length > MAX_TOKEN_BYTES) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]*$/.test(parts[1])) return undefined;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
    if (!isPlainObject(header) || typeof own(header, 'alg') !== 'string') return undefined;
    const payload = parts[1] === '' ? {} : (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown);
    return isPlainObject(payload) ? payload : {};
  } catch {
    return undefined;
  }
}

/**
 * REVIEW-16 #15f: `u_` + 16 hex characters of an HMAC of the login name with a random key of this `AuthSessions`
 * (stable while it lives, not across restarts), so a known e-mail can't be found from the `sub` by a dictionary.
 */
function subjectOf(identifier: string | undefined, key: Buffer): string | undefined {
  if (identifier === undefined || identifier === '') return undefined;
  return `u_${createHmac('sha256', key).update(identifier, 'utf8').digest('hex').slice(0, 16)}`;
}

interface Session {
  token: string;
  refresh?: string;
  /** ms since the epoch; `-Infinity` after `expireAll`. */
  expMs: number;
  sub?: string;
}

export interface AuthSessionsOptions {
  /** `'random'` mode's randomness for tests (default: `crypto.randomBytes`, REVIEW-16 #15e). */
  random?: () => number;
  maxSessions?: number;
}

export interface LoginResult {
  body: string;
  token: string;
  refresh?: string;
  /** Set once (until `clear`) when the oldest session was dropped to stay within `MAX_SESSIONS`. */
  note?: string;
}

export type AuthCheck = 'ok' | 'missing' | 'expired' | 'unknown';

/** CONTRACTS §24.1: sessions in host memory only (never in the store, dumps, snapshots, panel or agents but counts). */
export class AuthSessions {
  private readonly byToken = new Map<string, Session>();
  private readonly byRefresh = new Map<string, Session>();
  private readonly random: (() => number) | undefined;
  private readonly max: number;
  /** REVIEW-16 #15f: the `sub` HMAC key, random per instance. */
  private readonly subKey = randomBytes(32);
  private counter = 0;
  private dropNoted = false;

  constructor(opts: AuthSessionsOptions = {}) {
    this.random = opts.random;
    this.max = Math.max(1, Math.min(opts.maxSessions ?? MAX_SESSIONS, MAX_SESSIONS));
  }

  get count(): number {
    return this.byToken.size;
  }

  /**
   * A new session answered with the login example: token-like fields get the new token (a JWT-shaped one when the
   * example's token looks like a JWT), `refresh_token` a new refresh token, `expires_in` the TTL, `expires_at` now +
   * TTL; a nested `user` object is kept as written. `identifier` is the login name (`loginIdentifier`) — only its
   * keyed hash is used, as the JWT `sub`; it is not kept.
   */
  login(exampleBody: string, mode: DynamicMode, ttlSeconds: number, nowMs: number, identifier?: string): LoginResult {
    return this.issue(exampleBody, mode, ttlSeconds, nowMs, subjectOf(identifier, this.subKey));
  }

  /**
   * A new pair for a known refresh token (the old refresh token is spent; its access token stays until it expires),
   * answered with `exampleBody` (the refresh endpoint's 2xx example, or the login's). Unknown → undefined (the
   * caller answers the refresh endpoint's 401 example).
   */
  refresh(refreshToken: string, exampleBody: string, mode: DynamicMode, ttlSeconds: number, nowMs: number): LoginResult | undefined {
    const old = this.byRefresh.get(refreshToken);
    if (!old) return undefined;
    this.byRefresh.delete(refreshToken);
    old.refresh = undefined;
    return this.issue(exampleBody, mode, ttlSeconds, nowMs, old.sub, true);
  }

  /** `Authorization: Bearer <token>` → `ok | expired | unknown`; no header (or not a Bearer one) → `missing`. */
  check(authorizationHeader: string | undefined, nowMs: number): AuthCheck {
    const token = bearerToken(authorizationHeader);
    if (token === undefined) return 'missing';
    if (token.length > MAX_TOKEN_BYTES) return 'unknown';
    const s = this.byToken.get(token);
    if (!s) return 'unknown';
    return nowMs < s.expMs ? 'ok' : 'expired';
  }

  /** Drops the session of an access token (or a whole `Bearer …` header) and its refresh token. */
  logout(tokenOrHeader: string | undefined): boolean {
    const token = bearerToken(tokenOrHeader) ?? tokenOrHeader;
    if (!token) return false;
    const s = this.byToken.get(token);
    if (!s) return false;
    this.byToken.delete(token);
    if (s.refresh !== undefined) this.byRefresh.delete(s.refresh);
    return true;
  }

  /**
   * Every access token expires now (refresh tokens stay valid, so the app's refresh path can be tested). Returns how
   * many were still valid at `nowMs` (every not-yet-expired one when omitted).
   */
  expireAll(nowMs = -Infinity): number {
    let n = 0;
    for (const s of this.byToken.values()) {
      if (s.expMs > nowMs) n++;
      s.expMs = -Infinity;
    }
    return n;
  }

  /** Reset, proxy stop, auth off. */
  clear(): void {
    this.byToken.clear();
    this.byRefresh.clear();
    this.counter = 0;
    this.dropNoted = false;
  }

  private nextToken(mode: DynamicMode, prefix: string): string {
    if (mode !== 'random') {
      this.counter++;
      return `fi.${prefix}${this.counter}`;
    }
    // REVIEW-16 #15e: unpredictable unless a test injects its own randomness
    if (!this.random) return `fi.${prefix}${randomBase36(32)}`;
    let s = '';
    for (let i = 0; i < 32; i++) s += Math.floor(this.random() * 36).toString(36);
    return `fi.${prefix}${s}`;
  }

  private issue(
    exampleBody: string,
    mode: DynamicMode,
    ttlSeconds: number,
    nowMs: number,
    sub: string | undefined,
    keepRefresh = false,
  ): LoginResult {
    const ttl = clampTtl(ttlSeconds);
    const expMs = nowMs + ttl * 1000;
    let parsed: unknown;
    try {
      parsed = exampleBody.trim() === '' ? undefined : (JSON.parse(exampleBody) as unknown);
    } catch {
      parsed = undefined;
    }

    // The example's token shape: JWT-looking anywhere → JWT-shaped.
    let exampleClaims: Record<string, unknown> | undefined;
    let wantsRefresh = keepRefresh;
    walkFields(parsed, (k, v) => {
      const n = norm(k);
      if (ACCESS_FIELDS.has(n) && typeof v === 'string' && exampleClaims === undefined) exampleClaims = jwtClaims(v);
      if (REFRESH_FIELDS.has(n)) wantsRefresh = true;
    });

    const id = this.nextToken(mode, '');
    const token = exampleClaims ? makeJwt(exampleClaims, sub, nowMs, ttl, id) : id;
    const refresh = wantsRefresh ? this.nextToken(mode, 'r.') : undefined;

    let body = exampleBody;
    if (isPlainObject(parsed)) {
      const rewritten = rewrite(parsed, 0, { token, refresh, ttl, nowMs, expMs });
      body = JSON.stringify(rewritten, null, /\n\s/.test(exampleBody) ? 2 : undefined);
    }

    let note: string | undefined;
    while (this.byToken.size >= this.max) {
      const oldest = this.byToken.keys().next().value as string;
      const s = this.byToken.get(oldest);
      this.byToken.delete(oldest);
      if (s?.refresh !== undefined) this.byRefresh.delete(s.refresh);
      if (!this.dropNoted) {
        this.dropNoted = true;
        note = `auth: more than ${this.max} sessions, the oldest were dropped`;
      }
    }
    const session: Session = { token, expMs, ...(refresh !== undefined ? { refresh } : {}), ...(sub !== undefined ? { sub } : {}) };
    this.byToken.set(token, session);
    if (refresh !== undefined) this.byRefresh.set(refresh, session);
    return { body, token, ...(refresh !== undefined ? { refresh } : {}), ...(note !== undefined ? { note } : {}) };
  }
}

/** `n` characters of [a-z0-9] from `crypto.randomBytes` (rejection sampling: no modulo bias). */
function randomBase36(n: number): string {
  let s = '';
  while (s.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b >= 252) continue;
      s += (b % 36).toString(36);
      if (s.length === n) break;
    }
  }
  return s;
}

function clampTtl(ttl: number): number {
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(ttl)));
}

function bearerToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(header.length > MAX_TOKEN_BYTES + 32 ? header.slice(0, MAX_TOKEN_BYTES + 32) : header);
  return m ? m[1] : undefined;
}

function makeJwt(exampleClaims: Record<string, unknown>, sub: string | undefined, nowMs: number, ttl: number, jti: string): string {
  const header = b64url('{"alg":"none","typ":"JWT"}');
  const iat = Math.floor(nowMs / 1000);
  const claims = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(exampleClaims)) {
    if (k === 'sub' || k === 'iat' || k === 'exp' || k === 'nbf' || k === 'jti' || k === '__proto__') continue;
    claims[k] = own(exampleClaims, k);
  }
  const fixedClaims = { sub: sub ?? (typeof exampleClaims.sub === 'string' ? exampleClaims.sub : 'user'), iat, exp: iat + ttl, jti };
  let token = `${header}.${b64url(JSON.stringify({ ...claims, ...fixedClaims }))}.`;
  if (utf8Bytes(token) > MAX_TOKEN_BYTES) token = `${header}.${b64url(JSON.stringify(fixedClaims))}.`;
  return token;
}

function walkFields(v: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
  if (!isPlainObject(v) || depth > MAX_REWRITE_DEPTH) return;
  for (const k of Object.keys(v)) {
    const child = own(v, k);
    visit(k, child);
    if (k !== 'user') walkFields(child, visit, depth + 1);
  }
}

interface RewriteCtx {
  token: string;
  refresh?: string;
  ttl: number;
  nowMs: number;
  expMs: number;
}

function rewrite(obj: Record<string, unknown>, depth: number, ctx: RewriteCtx): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    const v = own(obj, k);
    const n = norm(k);
    let next: unknown = v;
    if (ACCESS_FIELDS.has(n) && typeof v === 'string') next = ctx.token;
    else if (REFRESH_FIELDS.has(n) && typeof v === 'string' && ctx.refresh !== undefined) next = ctx.refresh;
    else if (EXPIRES_IN_FIELDS.has(n) && (typeof v === 'number' || typeof v === 'string')) next = typeof v === 'number' ? ctx.ttl : String(ctx.ttl);
    else if (EXPIRES_AT_FIELDS.has(n)) {
      if (typeof v === 'number') next = v > 1e12 ? ctx.expMs : Math.floor(ctx.expMs / 1000);
      else if (typeof v === 'string') next = new Date(ctx.expMs).toISOString();
    } else if (k !== 'user' && isPlainObject(v) && depth < MAX_REWRITE_DEPTH) next = rewrite(v, depth + 1, ctx);
    Object.defineProperty(out, k, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
