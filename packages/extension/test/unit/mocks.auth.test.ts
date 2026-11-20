// CONTRACTS §24.1: auth simulation, light — sessions, never credentials.
import * as fs from 'fs';
import * as path from 'path';
import { inspect } from 'util';
import { describe, expect, it } from 'vitest';
import {
  AuthSessions,
  defaultProtect,
  detectAuth,
  isProtected,
  isRefreshGrant,
  jwtClaims,
  loginIdentifier,
  MAX_SESSIONS,
  refreshTokenOf,
  unauthorizedExample,
} from '../../src/mocks/auth';
import { parseOpenApi } from '../../src/mocks/openapi';
import { parsePostman } from '../../src/mocks/postman';
import { sanitisePostman } from '../../src/mocks/sanitise';
import type { CollectionVars, MockEndpoint, PathSegment } from '../../src/mocks/types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const vars: CollectionVars = { values: new Map([['baseUrl', 'https://api.shop.example']]), sources: new Map() };
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

function ep(method: string, p: PathSegment[], extra: Partial<MockEndpoint> = {}): MockEndpoint {
  const key = `${method} /${p.map((s) => (typeof s === 'string' ? s : `:${s.param}`)).join('/')}`;
  return { key, method, name: key, folder: [], origin: 'https://api.example', path: p, examples: [], unresolved: [], ...extra };
}

const JWT_EXAMPLE =
  // {"alg":"HS256","typ":"JWT"} . {"sub":"1","name":"Sara","role":"admin","exp":1}
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwibmFtZSI6IlNhcmEiLCJyb2xlIjoiYWRtaW4iLCJleHAiOjF9.c2ln';

describe('detectAuth', () => {
  it('finds login / refresh / logout on the shop fixture', () => {
    const parsed = parsePostman(readJson('shop.postman_collection.json'), vars);
    expect(detectAuth(parsed.endpoints)).toEqual({
      login: 'POST {{baseUrl}}/auth/login',
      refresh: 'POST {{baseUrl}}/auth/refresh',
      problems: [],
    });
  });

  it('knows the names, methods and the oauth/token refresh grant', () => {
    const r = detectAuth([
      ep('GET', ['login']),
      ep('POST', ['v1', 'sign-in']),
      ep('POST', ['sessions']),
      ep('DELETE', ['auth', 'sign-out']),
      ep('POST', ['auth', 'refresh_token']),
    ]);
    expect(r.login).toBe('POST /v1/sign-in');
    expect(r.refresh).toBe('POST /auth/refresh_token');
    expect(r.logout).toBe('DELETE /auth/sign-out');
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('POST /sessions');

    const oauth = detectAuth([ep('POST', ['oauth', 'token'])]);
    expect(oauth.login).toBe('POST /oauth/token');
    expect(oauth.refresh).toBe('POST /oauth/token');
    expect(isRefreshGrant({ grant_type: 'refresh_token', refresh_token: 'fi.r.1' })).toBe(true);
    expect(isRefreshGrant({ grant_type: 'password' })).toBe(false);
    expect(refreshTokenOf({ refreshToken: 'fi.r.1' })).toBe('fi.r.1');
    expect(detectAuth([ep('POST', ['users', { param: 'id' }])])).toEqual({ problems: [] });
  });
});

describe('protection', () => {
  it('reads declared auth from Postman (inherited, noauth) and keeps it in the copy without credentials', () => {
    const doc = readJson('shop.postman_collection.json');
    for (const d of [doc, sanitisePostman(doc).doc]) {
      const eps = parsePostman(d, vars).endpoints;
      expect(eps.find((e) => e.name === 'Log in')?.auth).toBe('none');
      expect(eps.find((e) => e.name === 'Me')?.auth).toBe('declared');
      expect(defaultProtect(eps)).toBe('declared');
    }
    const sanitised = JSON.stringify(sanitisePostman(doc).doc);
    expect(sanitised).toContain('"auth":{"type":"bearer"}');
    expect(sanitised).not.toContain('refresh-token-literal');
  });

  it('reads OpenAPI security (operation over root, [] = public)', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'S' },
      servers: [{ url: 'https://s.example' }],
      security: [{ bearer: [] }],
      paths: {
        '/me': { get: { responses: { '200': { description: 'ok' } } } },
        '/login': { post: { security: [], responses: { '200': { description: 'ok' } } } },
        '/maybe': { get: { security: [{}, { bearer: [] }], responses: { '200': { description: 'ok' } } } },
      },
    };
    const eps = parseOpenApi(doc, { values: new Map(), sources: new Map() }).endpoints;
    expect(eps.map((e) => e.auth)).toEqual(['declared', 'none', 'none']);
    const { security: _drop, ...noRoot } = doc;
    void _drop;
    expect(parseOpenApi(noRoot, { values: new Map(), sources: new Map() }).endpoints.map((e) => e.auth)).toEqual([
      undefined,
      'none',
      'none',
    ]);
  });

  it('isProtected: declared vs all, auth endpoints and register / forgot-password public', () => {
    const login = ep('POST', ['auth', 'login'], { auth: 'declared' });
    const refresh = ep('POST', ['auth', 'refresh']);
    const me = ep('GET', ['me'], { auth: 'declared' });
    const open = ep('GET', ['catalog']);
    const pub = ep('GET', ['status'], { auth: 'none' });
    const register = ep('POST', ['register']);
    const forgot = ep('POST', ['auth', 'forgot-password']);
    const auth = { login: login.key, refresh: refresh.key };
    expect([login, refresh, me, open, pub, register, forgot].map((e) => isProtected(e, 'declared', auth))).toEqual([
      false, false, true, false, false, false, false,
    ]);
    expect([login, refresh, me, open, pub, register, forgot].map((e) => isProtected(e, 'all', auth))).toEqual([
      false, false, true, true, false, false, false,
    ]);
    expect(defaultProtect([open, register])).toBe('all');
  });

  it('unauthorizedExample: the endpoint 401, else the login 401', () => {
    const e401 = { name: 'No token', status: 401, headers: {}, body: '{"e":1}' };
    const l401 = { name: 'Wrong password', status: 401, headers: {}, body: '{"e":2}' };
    const login = ep('POST', ['login'], { examples: [l401] });
    expect(unauthorizedExample(ep('GET', ['me'], { examples: [e401] }), login)).toBe(e401);
    expect(unauthorizedExample(ep('GET', ['me']), login)).toBe(l401);
    expect(unauthorizedExample(ep('GET', ['me']), undefined)).toBeUndefined();
  });
});

describe('AuthSessions', () => {
  it('login rewrites an opaque token, refresh token and expiry fields; keeps a nested user as written', () => {
    const s = new AuthSessions();
    const example = JSON.stringify({
      data: { access_token: 'abc', refresh_token: 'def', expires_in: 1, expires_at: '2020-01-01T00:00:00Z' },
      user: { id: 1, token: 'kept' },
    });
    const r = s.login(example, 'seeded', 600, T0);
    expect(r.token).toBe('fi.1');
    expect(r.refresh).toBe('fi.r.2');
    expect(JSON.parse(r.body)).toEqual({
      data: { access_token: 'fi.1', refresh_token: 'fi.r.2', expires_in: 600, expires_at: new Date(T0 + 600_000).toISOString() },
      user: { id: 1, token: 'kept' },
    });
    expect(s.count).toBe(1);
    // Random mode: `fi.<random>`, injectable randomness.
    const rnd = new AuthSessions({ random: () => 0.5 }).login('{"token":"x"}', 'random', 600, T0);
    expect(rnd.token).toMatch(/^fi\.[a-z0-9]{32}$/);
    expect(JSON.parse(rnd.body)).toEqual({ token: rnd.token });
  });

  it('login gives a JWT-shaped alg:none token with the example claims, sub from the identifier hash, iat and exp', () => {
    const s = new AuthSessions();
    const r = s.login(JSON.stringify({ token: JWT_EXAMPLE, expires_at: 1 }), 'seeded', 900, T0, 'sara@example.com');
    const [h, p, sig] = r.token.split('.');
    expect(sig).toBe('');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'none', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    expect(claims.name).toBe('Sara');
    expect(claims.role).toBe('admin');
    expect(claims.iat).toBe(T0 / 1000);
    expect(claims.exp).toBe(T0 / 1000 + 900);
    expect(claims.sub).toMatch(/^u_[0-9a-f]{16}$/);
    expect(JSON.stringify(claims)).not.toContain('sara@example.com');
    expect(jwtClaims(r.token)?.exp).toBe(T0 / 1000 + 900);
    // Same identifier → same sub; seconds-based expires_at stays seconds.
    const again = s.login(JSON.stringify({ token: JWT_EXAMPLE }), 'seeded', 900, T0, 'sara@example.com');
    expect(jwtClaims(again.token)?.sub).toBe(claims.sub);
    expect(again.token).not.toBe(r.token);
    expect(JSON.parse(r.body).expires_at).toBe(T0 / 1000 + 900);
    expect(Buffer.byteLength(r.token)).toBeLessThanOrEqual(4096);
  });

  it('keeps JWT tokens ≤ 4 KB by dropping oversized example claims', () => {
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ blob: 'x'.repeat(3500) })).toString('base64url');
    const r = new AuthSessions().login(JSON.stringify({ jwt: `${header}.${payload}.sig` }), 'seeded', 600, T0);
    expect(Buffer.byteLength(r.token)).toBeLessThanOrEqual(4096);
    expect(jwtClaims(r.token)?.blob).toBeUndefined();
  });

  it('check: ok, missing, unknown, expired (time injected); expireAll; logout', () => {
    const s = new AuthSessions();
    const { token } = s.login('{"token":"x"}', 'seeded', 60, T0);
    expect(s.check(`Bearer ${token}`, T0 + 1000)).toBe('ok');
    expect(s.check(`bearer   ${token} `, T0 + 1000)).toBe('ok');
    expect(s.check(undefined, T0)).toBe('missing');
    expect(s.check('', T0)).toBe('missing');
    expect(s.check('Basic dXNlcjpwYXNz', T0)).toBe('missing');
    expect(s.check('Bearer nope', T0)).toBe('unknown');
    expect(s.check(`Bearer ${'a'.repeat(5000)}`, T0)).toBe('unknown');
    expect(s.check(`Bearer ${token}`, T0 + 60_000)).toBe('expired');

    const t2 = s.login('{"token":"x"}', 'seeded', 3600, T0).token;
    expect(s.expireAll(T0 + 60_000)).toBe(1); // the first one had expired already
    expect(s.check(`Bearer ${t2}`, T0)).toBe('expired');

    const t3 = s.login('{"token":"x"}', 'seeded', 3600, T0).token;
    expect(s.logout(`Bearer ${t3}`)).toBe(true);
    expect(s.check(`Bearer ${t3}`, T0)).toBe('unknown');
    expect(s.logout('nope')).toBe(false);
    s.clear();
    expect(s.count).toBe(0);
  });

  it('refresh: a known refresh token gives a new pair (spent once); unknown → undefined', () => {
    const s = new AuthSessions();
    const first = s.login('{"access_token":"a","refresh_token":"r"}', 'seeded', 60, T0);
    s.expireAll();
    expect(s.check(`Bearer ${first.token}`, T0)).toBe('expired');
    const next = s.refresh(first.refresh as string, '{"access_token":"a","refresh_token":"r","expires_in":5}', 'seeded', 120, T0);
    expect(next).toBeDefined();
    expect(next?.token).not.toBe(first.token);
    expect(next?.refresh).not.toBe(first.refresh);
    expect(JSON.parse(next?.body ?? '')).toEqual({ access_token: next?.token, refresh_token: next?.refresh, expires_in: 120 });
    expect(s.check(`Bearer ${next?.token}`, T0 + 1000)).toBe('ok');
    expect(s.refresh(first.refresh as string, '{}', 'seeded', 120, T0)).toBeUndefined();
    expect(s.refresh('fi.r.unknown', '{}', 'seeded', 120, T0)).toBeUndefined();
    // Logout drops the refresh token too.
    s.logout(next?.token);
    expect(s.refresh(next?.refresh as string, '{}', 'seeded', 120, T0)).toBeUndefined();
  });

  it(`keeps at most ${MAX_SESSIONS} sessions, dropping the oldest with one note`, () => {
    const s = new AuthSessions();
    const first = s.login('{"token":"x","refresh_token":"y"}', 'seeded', 600, T0);
    const notes: string[] = [];
    for (let i = 1; i < MAX_SESSIONS + 5; i++) {
      const r = s.login('{"token":"x"}', 'seeded', 600, T0);
      if (r.note) notes.push(r.note);
    }
    expect(s.count).toBe(MAX_SESSIONS);
    expect(notes).toHaveLength(1);
    expect(s.check(`Bearer ${first.token}`, T0)).toBe('unknown');
    expect(s.refresh(first.refresh as string, '{}', 'seeded', 600, T0)).toBeUndefined();
  });

  it('never reads, stores or returns a password', () => {
    const password = 'Pa55-never-read-9f3k';
    const requestBody = { email: 'sara@example.com', password, user: { password } };
    const identifier = loginIdentifier(requestBody);
    expect(identifier).toBe('sara@example.com');
    expect(loginIdentifier({ password, passwd: password, pin: password })).toBeUndefined();
    expect(loginIdentifier({ user: { username: 'sara', password } })).toBe('sara');

    // A proxy proves the password's value (or even its descriptor) is never looked at; names only.
    const touched: string[] = [];
    const spy = new Proxy({ password, username: 'sara' } as Record<string, unknown>, {
      get: (t, k, r) => {
        touched.push(`get ${String(k)}`);
        return Reflect.get(t, k, r);
      },
      getOwnPropertyDescriptor: (t, k) => {
        touched.push(`desc ${String(k)}`);
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    expect(loginIdentifier(spy)).toBe('sara');
    expect(touched.filter((x) => x.endsWith('password'))).toEqual([]);

    const s = new AuthSessions();
    const r = s.login('{"token":"abc","user":{"id":1}}', 'seeded', 600, T0, identifier);
    expect(JSON.stringify(r)).not.toContain(password);
    expect(JSON.stringify(r)).not.toContain('sara@example.com');
    const state = inspect(s, { depth: 10, showHidden: true });
    expect(state).not.toContain(password);
    expect(state).not.toContain('sara@example.com');
  });
});
