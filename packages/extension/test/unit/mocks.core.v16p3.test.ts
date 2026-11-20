// CONTRACTS §24 (v0.16.0 part 3, X3): the collections host core — more sources (Swagger 2.0, Insomnia, Bruno), the
// answer pipeline (auth gate → query example → body example → store → default example → dynamic values → limited
// headers), light auth (sessions, never credentials), settings (`stores[].auth` / `.dynamic`, shared + overlay), and
// that no token, password or request body reaches the panel, agents, logs or problem lines.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterceptProxy, type Exchange, type RequestHandler, type Rule } from '@flutter-intercept/proxy';
import { compileRules, findRule } from '@flutter-intercept/proxy/rules';
import { AUTH_NOTES, BRUNO_MAX_ENTRIES, MockCollectionsCore, STORES_OVERLAY_KEY } from '../../src/mocks/core';
import { brunoLimits } from '../../src/mocks/bruno';
import { collectionParsers } from '../../src/mocks/parsers';
import { InterceptProxyHost } from '../../src/proxyHost';
import { SharedRulesCore } from '../../src/rules/core';
import { nodeRulesFs } from '../../src/rules/service';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, ROOT } from './rules.fakes';

// service.ts imports vscode; only its node fs adapter is used here
vi.mock('vscode', () => ({}));

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'collections');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const BASE = 'http://api.shop.test';
const COL = `${ROOT}/api/shop.postman_collection.json`;
// Planted values: none of them may show up in anything the panel, agents or logs get.
const PASSWORD = 'hunter2-planted-pw';
const WRONG = 'wrong-guess-planted';
const ENV_TOKEN = 'env-token-must-never-leave-the-host';

const J = { key: 'Content-Type', value: 'application/json' };
const url = (p: string[], query?: { key: string; value: string }[]) => ({
  raw: `{{baseUrl}}/${p.join('/')}${query ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : ''}`,
  host: ['{{baseUrl}}'],
  path: p,
  ...(query ? { query } : {}),
});
const raw = (v: unknown) => ({ mode: 'raw', raw: JSON.stringify(v), options: { raw: { language: 'json' } } });
const NOAUTH = { type: 'noauth' };

interface Opts {
  /** Extra headers on the login Success example. */
  loginHeaders?: { key: string; value: string }[];
  /** Leave the 401 example of "Me" out. */
  noMe401?: boolean;
  /** The collection declares no auth at all. */
  noAuthDeclared?: boolean;
}

function shop(o: Opts = {}): string {
  const loginBody = { email: 'sara@example.com', password: PASSWORD };
  return JSON.stringify({
    info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    ...(o.noAuthDeclared ? {} : { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] } }),
    variable: [{ key: 'baseUrl', value: BASE }, { key: 'region', value: 'eu-1' }],
    item: [
      {
        name: 'Log in',
        request: { method: 'POST', url: url(['auth', 'login']), body: raw(loginBody), ...(o.noAuthDeclared ? {} : { auth: NOAUTH }) },
        response: [
          {
            name: 'Success',
            code: 200,
            header: [J, ...(o.loginHeaders ?? [])],
            body: JSON.stringify({ access_token: 'example-access', refresh_token: 'example-refresh', expires_in: 5, user: { id: 1, name: 'Sara' }, issued: '{{$isoTimestamp}}' }),
            originalRequest: { method: 'POST', url: url(['auth', 'login']), body: raw(loginBody) },
          },
          { name: 'Wrong password', code: 401, header: [J], body: '{"error":"invalid_credentials"}', originalRequest: { method: 'POST', url: url(['auth', 'login']), body: raw({ email: 'sara@example.com', password: WRONG }) } },
        ],
      },
      {
        name: 'Refresh',
        request: { method: 'POST', url: url(['auth', 'refresh']), ...(o.noAuthDeclared ? {} : { auth: NOAUTH }) },
        response: [
          { name: 'OK', code: 200, header: [J], body: '{"access_token":"x","refresh_token":"y"}' },
          { name: 'Refresh expired', code: 401, header: [J], body: '{"error":"refresh_expired"}' },
        ],
      },
      { name: 'Log out', request: { method: 'POST', url: url(['auth', 'logout']) }, response: [{ name: 'Bye', code: 204, header: [], body: '' }] },
      {
        name: 'Me',
        request: { method: 'GET', url: url(['users', 'me']) },
        response: [{ name: 'OK', code: 200, header: [J], body: '{"id":1,"name":"Sara"}' }, ...(o.noMe401 ? [] : [{ name: 'No token', code: 401, header: [J], body: '{"error":"token_missing"}' }])],
      },
      { name: 'List users', request: { method: 'GET', url: url(['users']) }, response: [{ name: 'OK', code: 200, header: [J], body: '[{"id":1,"name":"Sara"},{"id":2,"name":"Omar"}]' }] },
      {
        name: 'Create user',
        request: { method: 'POST', url: url(['users']), body: raw({ name: 'Lina', email: 'lina@example.com' }) },
        response: [
          { name: 'Created', code: 201, header: [J], body: '{"id":3,"name":"Lina","email":"lina@example.com"}', originalRequest: { method: 'POST', url: url(['users']), body: raw({ name: 'Lina', email: 'lina@example.com' }) } },
          { name: 'Email taken', code: 409, header: [J], body: '{"error":"email_taken"}', originalRequest: { method: 'POST', url: url(['users']), body: raw({ name: 'Lina', email: 'taken@example.com' }) } },
          { name: 'VIP', code: 201, header: [J], body: '{"id":99,"name":"VIP","vip":true}', originalRequest: { method: 'POST', url: url(['users']), body: raw({ name: 'VIP', email: 'lina@example.com' }) } },
        ],
      },
      {
        name: 'User by id',
        request: { method: 'GET', url: url(['users', ':id']) },
        response: [{ name: 'Found', code: 200, header: [J], body: '{"id":1,"name":"Sara"}' }, { name: 'Not found', code: 404, header: [J], body: '{"error":"not_found"}' }],
      },
      { name: 'Delete user', request: { method: 'DELETE', url: url(['users', ':id']) }, response: [{ name: 'Gone', code: 204, header: [], body: '' }] },
      {
        name: 'Config',
        request: { method: 'GET', url: url(['config']) },
        response: [
          {
            name: 'OK',
            code: 200,
            header: [J, { key: 'X-Request-Id', value: '{{$guid}}' }, { key: 'X-Region', value: '{{region}}' }, { key: 'Set-Cookie', value: 'sid={{$guid}}' }],
            body: '{"id":"{{$guid}}","n":{{$randomInt}},"base":"{{baseUrl}}","secret":"{{token}}","flag":"{{flag}}","img":"{{$randomImage}}"}',
          },
        ],
      },
      {
        name: 'Search',
        request: { method: 'GET', url: url(['search'], [{ key: 'q', value: 'shoes' }]) },
        response: [
          { name: 'Hits', code: 200, header: [J], body: '[{"sku":"A1"}]' },
          { name: 'Nothing', code: 200, header: [J], body: '[]', originalRequest: { method: 'GET', url: url(['search'], [{ key: 'q', value: 'none' }]) } },
        ],
      },
      {
        name: 'Echo',
        request: { method: 'POST', url: url(['echo']), body: raw({ kind: 'a' }) },
        response: [
          { name: 'A', code: 200, header: [J], body: '{"got":"a"}', originalRequest: { method: 'POST', url: url(['echo']), body: raw({ kind: 'a' }) } },
          { name: 'B', code: 200, header: [J], body: '{"got":"b"}', originalRequest: { method: 'POST', url: url(['echo']), body: raw({ kind: 'b' }) } },
        ],
      },
      { name: 'Health', request: { method: 'GET', url: url(['health']), auth: NOAUTH }, response: [{ name: 'OK', code: 200, header: [J], body: '{"ok":true}' }] },
    ],
  });
}

let files: FakeFs;
let memento: FakeMemento;
let shared: SharedRulesCore;
let handlers: Map<string, RequestHandler>;
let storeChanges: [string, string | undefined][];
let authChanges: string[];
let watchedFolders: string[];
let logs: string[];
let clock: number;
let core: MockCollectionsCore;

function makeCore(opts: { handler?: boolean; fs?: FakeFs | typeof nodeRulesFs; root?: string; sharedCore?: SharedRulesCore; setHandler?: (id: string, fn: RequestHandler | undefined) => void; dynamic?: { mode?: 'random' | 'seeded' | 'fixed'; seed?: number } } = {}): MockCollectionsCore {
  const sc = opts.sharedCore ?? shared;
  return new MockCollectionsCore({
    links: () => sc.collectionLinks(),
    saveLinks: (folder, links) => sc.saveCollections(folder, links),
    primaryFolderPath: () => sc.primaryFolderPath(),
    writeWorkspaceFile: (folder, rel, text) => sc.writeWorkspaceFile(folder, rel, text),
    workspaceRoots: () => [opts.root ?? ROOT],
    fs: opts.fs ?? files,
    memento,
    parsers: collectionParsers,
    newRuleId: () => 'rule_new',
    log: (m) => logs.push(m),
    ...(opts.handler === false ? {} : { setHandler: opts.setHandler ?? ((id: string, fn: RequestHandler | undefined) => void (fn ? handlers.set(id, fn) : handlers.delete(id))) }),
    saveStore: (folder, collection, entry) => sc.saveStore(folder, collection, entry),
    onStoreChange: (id, resource) => storeChanges.push([id, resource]),
    onAuthChange: (id) => authChanges.push(id),
    watchFolder: (abs) => watchedFolders.push(abs),
    now: () => clock,
    ...(opts.dynamic ? { dynamic: opts.dynamic } : {}),
  });
}

function sharedFile(extra: Record<string, unknown> = {}, link: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, rules: [], collections: [{ id: 'shop', file: 'api/shop.postman_collection.json', ...link }], ...extra }, null, 2);
}

async function setup(extra: Record<string, unknown> = {}, opts: Parameters<typeof makeCore>[0] & { link?: Record<string, unknown> } = {}): Promise<void> {
  files.put(FILE, sharedFile(extra, opts.link));
  await shared.reload();
  core = makeCore(opts);
  await core.reload();
}

const AUTH_ON = { stores: [{ collection: 'shop', auth: { enabled: true } }] };

beforeEach(() => {
  files = new FakeFs();
  files.put(`${ROOT}/pubspec.yaml`, 'name: app');
  files.put(COL, shop());
  memento = new FakeMemento();
  shared = new SharedRulesCore({ folders: () => [{ name: 'app', path: ROOT }], fs: files, validateRule: fakeValidateRule, memento });
  handlers = new Map();
  storeChanges = [];
  authChanges = [];
  watchedFolders = [];
  logs = [];
  clock = Date.UTC(2026, 10, 20, 12, 0, 0);
});

const ruleFor = (method: string, u: string, c = core): Rule | undefined => findRule(compileRules(c.rules()), method, u) as Rule | undefined;
const kind = (method: string, p: string) => ruleFor(method, `${BASE}${p}`)?.action.kind;

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
  note?: string;
  /** The proxy answered the rule's own example (a plain mock rule, or a quiet `{fallback: true}`). */
  static: boolean;
}

/** What the app gets: the handler's answer for a handler rule (its fallback when it asks for it), else the mock. */
function send(method: string, p: string, o: { body?: unknown; text?: string; token?: string; headers?: Record<string, string>; id?: string } = {}): Answer {
  const u = `${BASE}${p}`;
  const rule = ruleFor(method, u);
  if (!rule) throw new Error(`no rule for ${method} ${u}`);
  const a = rule.action;
  if (a.kind === 'mock') return { status: a.status, headers: a.headers ?? {}, body: a.body, static: true };
  if (a.kind !== 'handler') throw new Error(`unexpected ${a.kind} rule for ${method} ${u}`);
  const fn = handlers.get(a.handlerId);
  if (!fn) throw new Error('no handler registered');
  const text = o.text ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined);
  const r = fn(
    {
      exchangeId: o.id ?? `ex${Math.random()}`,
      ruleId: rule.id,
      method,
      url: u,
      headers: {
        ...(text !== undefined && !Object.keys(o.headers ?? {}).some((k) => k.toLowerCase() === 'content-type') ? { 'Content-Type': 'application/json' } : {}),
        ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
        ...(o.headers ?? {}),
      },
      ...(text !== undefined ? { body: { text, encoding: 'utf8' as const } } : {}),
    },
    new AbortController().signal,
  ) as { status?: number; headers?: Record<string, string>; body?: string; note?: string; fallback?: true } | undefined;
  if (!r || r.fallback) {
    const fb = a.fallback!;
    return { status: fb.status, headers: fb.headers ?? {}, body: fb.body, static: true, ...(r?.note ? { note: r.note } : {}) };
  }
  return { status: r.status!, headers: r.headers ?? {}, body: r.body ?? '', static: false, ...(r.note ? { note: r.note } : {}) };
}

/** A response header by name, whatever its case. */
const h = (a: Answer, name: string): string | undefined => Object.entries(a.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const login = (password = PASSWORD) => send('POST', '/auth/login', { body: { email: 'sara@example.com', password } });
const tokenOf = (a: Answer) => (JSON.parse(a.body) as { access_token: string }).access_token;

/** Everything the panel, agents and logs can get out of the core, as text. */
function everythingShown(c = core): string {
  const state = c.state();
  return JSON.stringify([
    state,
    c.fileProblems(),
    state.map((s) => [c.endpoints(s.id), c.storeStatus(s.id)]),
    c.rules().map((r) => c.describeRule(r.id)),
    logs,
    storeChanges,
    authChanges,
    memento.get(STORES_OVERLAY_KEY),
  ]);
}

// ---------------------------------------------------------------------------------------------- rules

describe('which rules need the handler (§24 preamble)', () => {
  it('auth off: endpoints needing nothing stay plain mock rules; a store op, body examples and dynamic values get a handler rule', async () => {
    await setup();
    expect(kind('GET', '/health')).toBe('mock');
    expect(kind('GET', '/users/me')).toBe('mock');
    expect(kind('POST', '/auth/refresh')).toBe('mock');
    expect(kind('POST', '/auth/logout')).toBe('mock');
    expect(kind('GET', '/search?q=none')).toBe('mock'); // the query example's own static rule
    expect(kind('GET', '/search?q=shoes')).toBe('mock');
    expect(kind('POST', '/auth/login')).toBe('handler'); // "Wrong password" by body
    expect(kind('POST', '/echo')).toBe('handler'); // an example by body
    expect(kind('GET', '/config')).toBe('handler'); // dynamic values
    expect(kind('GET', '/users')).toBe('handler'); // the store
    // the static answer stays the fallback, in the same position, under the same handler id
    const cfg = ruleFor('GET', `${BASE}/config`)!;
    expect(cfg.action).toMatchObject({ kind: 'handler', handlerId: 'collection:shop', fallback: { kind: 'mock', status: 200 } });
    expect(cfg.name).toBe('Shop › Config · OK');
    // internal needs never show in what describes a rule
    expect(core.describeRule(cfg.id)).toEqual({ id: 'shop', name: 'Shop', endpoint: 'GET {{baseUrl}}/config', example: 'OK', limited: ['set-cookie'] });
    // every rule passes the proxy's validation
    const p = new InterceptProxy({ port: 0 });
    p.setRules(core.rules());
    expect(p.refusedRules ?? []).toEqual([]);
  });

  it('a host without a handler gets exactly the static rules (same ids and order)', async () => {
    await setup();
    const flat = makeCore({ handler: false });
    await flat.reload();
    expect(flat.rules().map((r) => r.id)).toEqual(core.rules().map((r) => r.id));
    expect(flat.rules().every((r) => r.action.kind === 'mock')).toBe(true);
    expect(flat.endpoints('shop').every((e) => e.examples.every((x) => x.byBody === undefined))).toBe(true);
    expect(handlers.size).toBe(1);
  });

  it('auth on: protected endpoints and their query examples are gated; public ones stay plain; a chosen example stays static', async () => {
    await setup(AUTH_ON);
    expect(kind('GET', '/users/me')).toBe('handler');
    expect(kind('POST', '/auth/refresh')).toBe('handler');
    expect(kind('POST', '/auth/logout')).toBe('handler');
    expect(kind('GET', '/search?q=none')).toBe('handler');
    expect(kind('GET', '/search?q=shoes')).toBe('handler');
    expect(kind('GET', '/health')).toBe('mock'); // declares no auth
    await core.update('shop', { example: { endpoint: 'GET {{baseUrl}}/users/me', name: 'OK' } });
    expect(kind('GET', '/users/me')).toBe('mock');
    await core.update('shop', { reset: true });
    expect(kind('GET', '/users/me')).toBe('handler');
  });

  it('with the store off for this user, sign-in simulation and dynamic values still apply (§24.9)', async () => {
    await setup(AUTH_ON);
    await core.updateStore('shop', { enabled: false });
    expect(kind('GET', '/users')).toBe('handler'); // gated, answered by its example once signed in
    expect(send('GET', '/users').status).toBe(401);
    const t = tokenOf(login());
    const list = send('GET', '/users', { token: t });
    expect(list).toMatchObject({ status: 200, static: true, body: '[{"id":1,"name":"Sara"},{"id":2,"name":"Omar"}]' });
    expect(send('GET', '/config', { token: t }).static).toBe(false);
    expect(core.storeStatus('shop')).toMatchObject({ enabled: false, auth: { enabled: true, sessions: 1 } });
  });
});

// ---------------------------------------------------------------------------------------------- pipeline order

describe('pipeline order (§24 preamble)', () => {
  it('a chosen example beats the auth gate; the auth gate beats a body example, except on the login request', async () => {
    await setup(AUTH_ON);
    // chosen example: static, no token needed
    await core.update('shop', { example: { endpoint: 'GET {{baseUrl}}/users/:id', name: 'Not found' } });
    expect(send('GET', '/users/7')).toMatchObject({ status: 404, static: true });
    // auth beats the body example on a protected request
    const gated = send('POST', '/echo', { body: { kind: 'b' }, id: 'g1' });
    expect(gated).toMatchObject({ status: 401, note: AUTH_NOTES.noToken });
    expect(core.answerOf('g1')).toMatchObject({ auth: '401 no token' });
    // … but on the login request a matching body example answers instead of a session
    const wrong = login(WRONG);
    expect(wrong).toMatchObject({ status: 401, body: '{"error":"invalid_credentials"}', note: 'example: Wrong password (by body)' });
    expect(core.storeStatus('shop')!.auth!.sessions).toBe(0);
    const t = tokenOf(login());
    expect(send('POST', '/echo', { body: { kind: 'b' }, token: t, id: 'g2' })).toMatchObject({ status: 200, body: '{"got":"b"}', note: 'example: B (by body)' });
    expect(core.answerOf('g2')).toEqual({ example: 'B', byBody: true });
    // the default example is the rule's own: answered quietly
    expect(send('POST', '/echo', { body: { kind: 'a' }, token: t })).toMatchObject({ static: true, body: '{"got":"a"}' });
    expect(send('POST', '/echo', { body: { kind: 'zzz' }, token: t })).toMatchObject({ static: true, body: '{"got":"a"}' });
  });

  it('the query example answers after the gate; a body example beats the store only when it is an error on a create; the store beats the default', async () => {
    await setup(AUTH_ON);
    expect(send('GET', '/search?q=none')).toMatchObject({ status: 401, note: AUTH_NOTES.noToken });
    const t = tokenOf(login());
    expect(send('GET', '/search?q=none', { token: t })).toMatchObject({ status: 200, body: '[]', static: true });
    expect(send('GET', '/search?q=shoes', { token: t })).toMatchObject({ body: '[{"sku":"A1"}]', static: true });
    // an error example chosen by body beats the store on a create: nothing is added
    const taken = send('POST', '/users', { body: { name: 'Lina', email: 'taken@example.com' }, token: t });
    expect(taken).toMatchObject({ status: 409, body: '{"error":"email_taken"}', note: 'example: Email taken (by body)' });
    expect(core.storeStatus('shop')!.resources.find((r) => r.name === 'users')!.count).toBe(2);
    // a success example chosen by body doesn't: the store creates the record
    const vip = send('POST', '/users', { body: { name: 'VIP', email: 'lina@example.com' }, token: t });
    expect(vip).toMatchObject({ status: 201, note: 'users: created 3' });
    expect(JSON.parse(vip.body)).toMatchObject({ id: 3, name: 'VIP' });
    // the store beats the default example
    const list = send('GET', '/users', { token: t });
    expect(JSON.parse(list.body).map((u: { id: number }) => u.id)).toEqual([1, 2, 3]);
    expect(list.note).toBe('users: listed 3 of 3');
  });

  it('auth off: a body example answers on a non-resource endpoint whatever its status; nothing is gated', async () => {
    await setup();
    expect(send('POST', '/echo', { body: { kind: 'b' } })).toMatchObject({ status: 200, body: '{"got":"b"}', static: false });
    expect(login(WRONG)).toMatchObject({ status: 401, body: '{"error":"invalid_credentials"}' });
    // the login example as written (its dynamic value filled in), no session: auth simulation is off
    const ok = login();
    expect(JSON.parse(ok.body)).toMatchObject({ access_token: 'example-access', refresh_token: 'example-refresh' });
    expect(ok.note).toBeUndefined();
    expect(send('GET', '/users/me')).toMatchObject({ status: 200, static: true });
    expect(core.storeStatus('shop')!.auth).toMatchObject({ available: true, enabled: false, sessions: 0 });
  });
});

// ---------------------------------------------------------------------------------------------- auth

describe('sign-in simulation, light (§24.1)', () => {
  it('login → token → protected GET ok → expire → 401 → refresh → ok; exact notes; sessions are only counted', async () => {
    await setup(AUTH_ON);
    expect(core.storeStatus('shop')!.auth).toEqual({
      available: true,
      enabled: true,
      login: 'POST {{baseUrl}}/auth/login',
      refresh: 'POST {{baseUrl}}/auth/refresh',
      ttlSeconds: 3600,
      protect: 'declared',
      sessions: 0,
      problems: [],
    });
    expect(send('GET', '/users/me', { id: 'm0' })).toMatchObject({ status: 401, body: '{"error":"token_missing"}', note: 'auth: 401 no token' });
    expect(core.answerOf('m0')).toEqual({ auth: '401 no token', example: 'No token' });
    expect(send('GET', '/users/me', { token: 'made-up' })).toMatchObject({ status: 401, note: 'auth: 401 no token' });

    const signedIn = login();
    expect(signedIn).toMatchObject({ status: 200, note: 'auth: signed in', static: false });
    const body = JSON.parse(signedIn.body) as { access_token: string; refresh_token: string; expires_in: number; user: unknown; issued: string };
    expect(body.access_token).toMatch(/^fi\.[a-z0-9]{32}$/);
    expect(body.refresh_token).toMatch(/^fi\.r\.[a-z0-9]{32}$/);
    expect(body.expires_in).toBe(3600);
    expect(body.user).toEqual({ id: 1, name: 'Sara' }); // kept as written
    expect(body.issued).toBe(new Date(clock).toISOString()); // dynamic values of the login answer are rendered
    expect(authChanges).toEqual(['shop']);
    expect(core.storeStatus('shop')!.auth!.sessions).toBe(1);

    expect(send('GET', '/users/me', { token: body.access_token })).toMatchObject({ status: 200, static: true, body: '{"id":1,"name":"Sara"}' });
    // case and spacing of the header don't matter
    expect(send('GET', '/users/me', { headers: { authorization: `bearer   ${body.access_token}` } }).status).toBe(200);

    await core.updateStore('shop', { auth: { expire: 'all' } });
    expect(send('GET', '/users/me', { token: body.access_token, id: 'm1' })).toMatchObject({ status: 401, note: 'auth: 401 expired' });
    expect(core.answerOf('m1')).toMatchObject({ auth: '401 expired' });

    // an unknown refresh token: the refresh request's own 401 example
    expect(send('POST', '/auth/refresh', { body: { refresh_token: 'nope' } })).toMatchObject({ status: 401, body: '{"error":"refresh_expired"}', note: 'auth: 401 no token' });
    const refreshed = send('POST', '/auth/refresh', { body: { refresh_token: body.refresh_token } });
    expect(refreshed).toMatchObject({ status: 200, note: 'auth: refreshed' });
    const pair = JSON.parse(refreshed.body) as { access_token: string; refresh_token: string };
    expect(pair.access_token).not.toBe(body.access_token);
    expect(send('GET', '/users/me', { token: pair.access_token }).status).toBe(200);
    // the old refresh token is spent
    expect(send('POST', '/auth/refresh', { body: { refresh_token: body.refresh_token } }).status).toBe(401);
    // logout drops the session
    expect(send('POST', '/auth/logout', { token: pair.access_token })).toMatchObject({ status: 204, static: true });
    expect(send('GET', '/users/me', { token: pair.access_token })).toMatchObject({ status: 401, note: 'auth: 401 no token' });
  });

  it('tokens expire after ttlSeconds on the host clock; the built-in 401 when no example exists', async () => {
    files.put(COL, shop({ noMe401: true }));
    await setup({ stores: [{ collection: 'shop', auth: { enabled: true, ttlSeconds: 60 } }] });
    // no 401 on the endpoint → the login request's 401 example ("Wrong password")
    expect(send('GET', '/users/me')).toMatchObject({ status: 401, body: '{"error":"invalid_credentials"}' });
    const t = tokenOf(login());
    expect(JSON.parse(login().body).expires_in).toBe(60);
    clock += 59_000;
    expect(send('GET', '/users/me', { token: t }).status).toBe(200);
    clock += 2_000;
    expect(send('GET', '/users/me', { token: t })).toMatchObject({ status: 401, note: 'auth: 401 expired' });
  });

  it("'declared' protects what the collection marks; 'all' everything but login / refresh / logout; the §24.9 line when nothing is declared", async () => {
    await setup(AUTH_ON);
    expect(send('GET', '/health').status).toBe(200);
    await core.updateStore('shop', { auth: { protect: 'all' } });
    expect(core.storeStatus('shop')!.auth!.protect).toBe('all');
    expect(send('GET', '/health').status).toBe(200); // `noauth` is public even then (§24.6)
    expect(send('GET', '/config').status).toBe(401);

    files.put(COL, shop({ noAuthDeclared: true }));
    await core.updateStore('shop', { reset: 'settings' });
    await core.reload();
    // nothing declared → 'all' by default
    expect(core.storeStatus('shop')!.auth).toMatchObject({ protect: 'all', problems: [] });
    expect(send('GET', '/users/me').status).toBe(401);
    await core.updateStore('shop', { auth: { protect: 'declared' } });
    expect(core.storeStatus('shop')!.auth).toMatchObject({ protect: 'declared', problems: ['The collection marks no request as needing a token, so none is checked. Choose all.'] });
    expect(send('GET', '/users/me').status).toBe(200);
  });

  it('never on by itself; turning it on needs a login request; sessions end on Reset data, proxy stop, auth off and link removal', async () => {
    await setup();
    expect(core.storeStatus('shop')!.auth).toMatchObject({ available: true, enabled: false });
    expect(send('GET', '/users/me').status).toBe(200);
    await core.updateStore('shop', { auth: { enabled: true } });
    expect(send('GET', '/users/me').status).toBe(401);

    const sessions = () => core.storeStatus('shop')!.auth!.sessions;
    let t = tokenOf(login());
    expect(sessions()).toBe(1);
    await core.updateStore('shop', { reset: 'data' });
    expect(sessions()).toBe(0);
    expect(send('GET', '/users/me', { token: t }).status).toBe(401);

    t = tokenOf(login());
    await core.dropStores();
    expect(sessions()).toBe(0);
    expect(send('GET', '/users/me', { token: t }).status).toBe(401);

    t = tokenOf(login());
    await core.updateStore('shop', { auth: { enabled: false } });
    expect(sessions()).toBe(0);
    await core.updateStore('shop', { auth: { enabled: true } });
    expect(send('GET', '/users/me', { token: t }).status).toBe(401);

    login();
    expect(sessions()).toBe(1);
    await core.update('shop', { enabled: false });
    await core.update('shop', { enabled: true });
    expect(sessions()).toBe(0);

    // a collection without a login request can't turn it on
    files.put(`${ROOT}/api/plain.json`, JSON.stringify({ info: { name: 'Plain', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'Ping', request: { method: 'GET', url: 'http://plain.test/ping' }, response: [{ name: 'OK', code: 200, header: [J], body: '{}' }] }] }));
    await core.addLink({ file: 'api/plain.json' });
    expect(core.storeStatus('plain')!.auth).toMatchObject({ available: false, enabled: false });
    await expect(core.updateStore('plain', { auth: { enabled: true } })).rejects.toThrow(/No login request was found/);
    await expect(core.updateStore('plain', { auth: { expire: 'all' } })).rejects.toThrow(/isn't on/);
    expect(() => core.expireSessions('plain')).toThrow(/isn't on/);
  });

  it('/oauth/token is login and refresh in one: grant_type decides (form bodies); a Bearer refresh token works too', async () => {
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    files.put(
      COL,
      JSON.stringify({
        info: { name: 'OAuth', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        variable: [{ key: 'baseUrl', value: BASE }],
        item: [
          { name: 'Token', request: { method: 'POST', url: url(['oauth', 'token']) }, response: [{ name: 'OK', code: 200, header: [J], body: '{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":1}' }] },
          { name: 'Me', request: { method: 'GET', url: url(['me']) }, response: [{ name: 'OK', code: 200, header: [J], body: '{"id":1}' }] },
        ],
      }),
    );
    await setup(AUTH_ON);
    expect(core.storeStatus('shop')!.auth).toMatchObject({ login: 'POST {{baseUrl}}/oauth/token', refresh: 'POST {{baseUrl}}/oauth/token', protect: 'all' });
    // no 401 example anywhere → the built-in one
    expect(send('GET', '/me')).toMatchObject({ status: 401, body: '{"error":"unauthorized"}', note: 'auth: 401 no token' });
    const first = send('POST', '/oauth/token', { text: `grant_type=password&username=sara&password=${PASSWORD}`, headers: form });
    expect(first.note).toBe('auth: signed in');
    const a = JSON.parse(first.body) as { access_token: string; refresh_token: string; token_type: string };
    expect(a.token_type).toBe('Bearer');
    expect(send('GET', '/me', { token: a.access_token }).status).toBe(200);
    core.expireSessions('shop');
    expect(send('GET', '/me', { token: a.access_token }).note).toBe('auth: 401 expired');
    const second = send('POST', '/oauth/token', { text: `grant_type=refresh_token&refresh_token=${encodeURIComponent(a.refresh_token)}`, headers: form });
    expect(second.note).toBe('auth: refreshed');
    const b = JSON.parse(second.body) as { access_token: string; refresh_token: string };
    expect(send('GET', '/me', { token: b.access_token }).status).toBe(200);
    expect(send('POST', '/oauth/token', { text: 'grant_type=refresh_token&refresh_token=unknown', headers: form })).toMatchObject({ status: 401, note: 'auth: 401 no token' });
    // the refresh token as a Bearer header
    expect(send('POST', '/oauth/token', { text: 'grant_type=refresh_token', headers: { ...form, authorization: `Bearer ${b.refresh_token}` } }).note).toBe('auth: refreshed');
    expect(everythingShown()).not.toContain(PASSWORD);
  });

  it('expireSessions / authCollectionFor (agents: expire_token)', async () => {
    await setup(AUTH_ON);
    expect(core.authCollectionFor(`${BASE}/v1/*`)).toBe('shop');
    expect(core.authCollectionFor('http://API.shop.test:80/users/me')).toBe('shop');
    expect(core.authCollectionFor('http://other.test/*')).toBeUndefined();
    expect(core.authCollectionFor('*')).toBeUndefined();
    expect(core.authCollectionFor('http://*.shop.test/*')).toBeUndefined();
    login();
    login();
    expect(core.expireSessions('shop')).toBe(2);
    expect(core.expireSessions('shop')).toBe(0);
    await core.updateStore('shop', { auth: { enabled: false } });
    expect(core.authCollectionFor(`${BASE}/*`)).toBeUndefined();
  });

  it('"Wrong password" by body on the unsanitised shop fixture; a JWT-shaped token when the example has one', async () => {
    const doc = JSON.parse(fixture('shop.postman_collection.json'));
    files.put(COL, JSON.stringify(doc));
    await setup({ stores: [{ collection: 'shop', auth: { enabled: true } }] }, { link: { variables: { baseUrl: BASE } } });
    const view = core.endpoints('shop').find((e) => e.key === 'POST {{baseUrl}}/auth/login')!;
    expect(view.examples).toEqual([{ name: 'Success', status: 200 }, { name: 'Wrong password', status: 401, byBody: ['password'] }]);
    const wrong = send('POST', '/auth/login', { body: { email: 'sara@example.com', password: 'wrong-guess' } });
    expect(wrong).toMatchObject({ status: 401, body: '{"error":"invalid_credentials"}', note: 'example: Wrong password (by body)' });
    const ok = send('POST', '/auth/login', { body: { email: 'sara@example.com', password: 'anything-else' } });
    expect(ok).toMatchObject({ status: 200, note: 'auth: signed in' });
    const t = (JSON.parse(ok.body) as { token: string }).token;
    expect(t).toMatch(/^fi\./);
    expect(send('GET', '/users/me').status).toBe(401);
    expect(send('GET', '/users/me', { token: t }).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------- dynamic values

describe('dynamic values (§24.3)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('rendered per answer; link and collection variables only — environment values never; unsupported names left as written', async () => {
    files.put(`${ROOT}/api/env.json`, JSON.stringify({ name: 'dev', values: [{ key: 'token', value: ENV_TOKEN, enabled: true }, { key: 'flag', value: 'from-env', enabled: true }], _postman_variable_scope: 'environment' }));
    await setup({}, { link: { environment: 'api/env.json', variables: { flag: 'from-link' } } });
    const a = send('GET', '/config');
    const b = send('GET', '/config');
    expect(a.static).toBe(false);
    const ja = JSON.parse(a.body) as Record<string, unknown>;
    const jb = JSON.parse(b.body) as Record<string, unknown>;
    expect(ja.id).toMatch(UUID);
    expect(ja.id).not.toBe(jb.id);
    expect(typeof ja.n).toBe('number');
    expect(ja.base).toBe(BASE); // the collection's own variable
    expect(ja.flag).toBe('from-link'); // the link's variable (never the environment's value of the same name)
    expect(ja.secret).toBe('{{token}}'); // an environment value is never used
    expect(ja.img).toBe('{{$randomImage}}');
    expect(a.body).not.toContain(ENV_TOKEN);
    expect(h(a, 'x-region')).toBe('eu-1');
    expect(h(a, 'x-request-id')).toMatch(UUID);
    expect(core.state()[0].problems.join('\n')).toMatch(/GET \/config: Dynamic values not supported \(left as written\): \$randomImage/);
    expect(core.storeStatus('shop')!.dynamic).toBe('random');
  });

  it("limited headers stay limited, and a header an approval is about is never rendered", async () => {
    await setup();
    const before = send('GET', '/config');
    expect(Object.keys(before.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    expect(before.headers['x-flutter-intercept']).toBe('limited; removed=set-cookie');
    expect(core.state()[0].limited).toMatchObject({ reasons: ['sets cookies'], answers: 1 });
    await core.approve('shop');
    const after = send('GET', '/config');
    expect(h(after, 'set-cookie')).toBe('sid={{$guid}}'); // as written: what was approved is the text in the file
    expect(h(after, 'x-request-id')).toMatch(UUID);
  });

  it('answers the pipeline gives besides a rule\'s own example count as limited too (so they can be approved)', async () => {
    files.put(COL, shop({ loginHeaders: [{ key: 'Set-Cookie', value: 'session=1' }] }));
    await setup(AUTH_ON);
    // the login Success example is the rule's own; nothing else sets a cookie
    expect(core.state()[0].limited).toMatchObject({ reasons: ['sets cookies'] });
    const ok = login();
    expect(Object.keys(ok.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    await core.approve('shop');
    expect(h(login(), 'set-cookie')).toBe('session=1');
  });

  it("'seeded' is reproducible answer by answer; 'fixed' gives the constants; the mode is a setting (file + overlay)", async () => {
    await setup({ stores: [{ collection: 'shop', dynamic: 'seeded' }] });
    expect(core.storeStatus('shop')!.dynamic).toBe('seeded');
    const first = [send('GET', '/config').body, send('GET', '/config').body];
    expect(first[0]).not.toBe(first[1]);
    await core.dropStores(); // a new run
    expect([send('GET', '/config').body, send('GET', '/config').body]).toEqual(first);
    // another core (another process) gives the same values
    const again = makeCore({ setHandler: () => undefined });
    await again.reload();
    const rule = ruleFor('GET', `${BASE}/config`, again)!;
    const r = again.handle('shop', { exchangeId: 'x', ruleId: rule.id, method: 'GET', url: `${BASE}/config`, headers: {} }) as { body: string };
    expect(r.body).toBe(first[0]);

    await core.updateStore('shop', { dynamic: 'fixed' });
    expect(core.storeStatus('shop')).toMatchObject({ dynamic: 'fixed', overridden: true });
    expect(memento.get<Record<string, unknown>>(STORES_OVERLAY_KEY)).toEqual({ [`${ROOT}\0shop`]: { dynamic: 'fixed' } });
    expect(JSON.parse(send('GET', '/config').body)).toMatchObject({ id: '00000000-0000-4000-8000-000000000000', n: 0 });
    // equal to the team's value → no override
    await core.updateStore('shop', { dynamic: 'seeded' });
    expect(memento.get(STORES_OVERLAY_KEY)).toEqual({});
    await expect(core.updateStore('shop', { dynamic: 'sometimes' as never })).rejects.toThrow(/dynamic must be/);
  });

  it('a host default (the CLI: seeded) applies when neither the file nor the user sets a mode', async () => {
    await setup({}, { dynamic: { mode: 'seeded', seed: 7 } });
    const a = send('GET', '/config').body;
    const other = makeCore({ setHandler: () => undefined, dynamic: { mode: 'seeded', seed: 8 } });
    await other.reload();
    const rule = ruleFor('GET', `${BASE}/config`, other)!;
    const b = (other.handle('shop', { exchangeId: 'x', ruleId: rule.id, method: 'GET', url: `${BASE}/config`, headers: {} }) as { body: string }).body;
    expect(a).not.toBe(b);
  });

  it('StoreStatus.dynamic only when the collection has {{$…}} values (§24.9)', async () => {
    const doc = JSON.parse(shop());
    doc.item = doc.item.filter((i: { name: string }) => i.name !== 'Config' && i.name !== 'Log in');
    files.put(COL, JSON.stringify(doc));
    await setup();
    expect(core.storeStatus('shop')!.dynamic).toBeUndefined();
  });

  it('store seeds are rendered once, seeded by the link id: stable ids across reloads and cores', async () => {
    const doc = JSON.parse(shop());
    const list = doc.item.find((i: { name: string }) => i.name === 'List users');
    list.response[0].body = '[{"id":"{{$guid}}","name":"{{$randomFirstName}}"},{"id":"{{$guid}}","name":"{{$randomFirstName}}"}]';
    doc.item = doc.item.filter((i: { name: string }) => !['User by id', 'Delete user'].includes(i.name));
    doc.item.push({ name: 'User by id', request: { method: 'GET', url: url(['users', ':id']) }, response: [] });
    files.put(COL, JSON.stringify(doc));
    await setup();
    const ids = () => (core.storeItems('shop', 'users').items as { id: string; name: string }[]).map((u) => u.id);
    const first = ids();
    expect(first).toHaveLength(2);
    expect(first[0]).toMatch(UUID);
    expect(first[0]).not.toBe(first[1]);
    await core.dropStores();
    expect(ids()).toEqual(first);
    const other = makeCore({ setHandler: () => undefined });
    await other.reload();
    expect((other.storeItems('shop', 'users').items as { id: string }[]).map((u) => u.id)).toEqual(first);
    // store answers are data, not templates
    const got = JSON.parse(send('GET', `/users/${first[0]}`).body) as { id: string };
    expect(got.id).toBe(first[0]);
  });

  it('collectionToRule renders once and says so in the name', async () => {
    await setup();
    const rule = core.toRule('shop', 'GET {{baseUrl}}/config');
    expect(rule).toMatchObject({ id: 'rule_new', name: 'Shop › Config · OK · dynamic values filled in once', action: { kind: 'mock', status: 200 } });
    const body = JSON.parse((rule.action as { body: string }).body) as Record<string, unknown>;
    expect(body.id).toMatch(UUID);
    expect(body.base).toBe(BASE);
    // nothing dynamic → exactly as before
    expect(core.toRule('shop', 'GET {{baseUrl}}/health').name).toBe('Shop › Health · OK');
  });
});

// ---------------------------------------------------------------------------------------------- body examples

describe('examples by request body (§24.2)', () => {
  it('byBody = field names in the endpoints view; request bodies stay in the host', async () => {
    await setup();
    const eps = core.endpoints('shop');
    expect(eps.find((e) => e.name === 'Log in')!.examples).toEqual([{ name: 'Success', status: 200 }, { name: 'Wrong password', status: 401, byBody: ['password'] }]);
    expect(eps.find((e) => e.name === 'Create user')!.examples.map((x) => x.byBody)).toEqual([undefined, ['email'], ['name']]);
    expect(eps.find((e) => e.name === 'Echo')!.examples.map((x) => x.byBody)).toEqual([undefined, ['kind']]);
    expect(JSON.stringify(eps)).not.toContain(WRONG);
  });

  it('problems are quiet lines (a copy without credentials can\'t choose by a blanked field), with field names only', async () => {
    const doc = JSON.parse(shop());
    const loginItem = doc.item[0];
    for (const r of [loginItem.request, ...loginItem.response.map((x: { originalRequest: unknown }) => x.originalRequest)]) r.body = raw({ email: 'sara@example.com', password: '' });
    files.put(COL, JSON.stringify(doc));
    await setup();
    const problems = core.state()[0].problems;
    expect(problems.some((p) => /Wrong password.*not chosen by body.*"password"/.test(p))).toBe(true);
    expect(kind('POST', '/auth/login')).toBe('handler'); // still dynamic ({{$isoTimestamp}})
    expect(core.endpoints('shop').find((e) => e.name === 'Log in')!.examples.every((x) => x.byBody === undefined)).toBe(true);
  });

  it('a broken or non-JSON body chooses nothing', async () => {
    await setup();
    expect(send('POST', '/echo', { text: 'kind=b&x=1', headers: { 'Content-Type': 'text/plain' } }).body).toBe('{"got":"a"}');
    expect(send('POST', '/echo', { text: '{"kind":"b"' }).body).toBe('{"got":"a"}');
    // a form body is compared as a flat object of strings (§24.2)
    expect(send('POST', '/echo', { text: 'kind=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).body).toBe('{"got":"b"}');
    expect(send('POST', '/echo', { text: 'kind=c', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).body).toBe('{"got":"a"}');
  });
});

// ---------------------------------------------------------------------------------------------- settings

describe('settings: stores[].auth / .dynamic in the shared file and the personal overlay (§24.1, §22.7)', () => {
  const fileStores = () => JSON.parse(files.text(FILE)!).stores as unknown;

  it('personal by default; team writes the file and drops the same overlay entries; reset clears; unchanged re-sends are no-ops', async () => {
    await setup();
    expect(await core.updateStore('shop', { auth: { enabled: true, ttlSeconds: 120 } })).toBe(true);
    expect(memento.get(STORES_OVERLAY_KEY)).toEqual({ [`${ROOT}\0shop`]: { auth: { enabled: true, ttlSeconds: 120 } } });
    expect(fileStores()).toBeUndefined();
    expect(core.storeStatus('shop')).toMatchObject({ overridden: true, auth: { enabled: true, ttlSeconds: 120 } });
    expect(await core.updateStore('shop', { auth: { enabled: true, ttlSeconds: 120 } })).toBe(false);

    // "Save for the team": one patch with everything in effect (§24.9)
    expect(await core.updateStore('shop', { enabled: true, startsFrom: null, auth: { enabled: true, ttlSeconds: 120, protect: 'declared' }, dynamic: 'random', scope: 'team' })).toBe(true);
    // defaults aren't written: protect 'declared' is this collection's default, 'random' the host's
    expect(fileStores()).toEqual([{ collection: 'shop', auth: { enabled: true, ttlSeconds: 120 } }]);
    expect(memento.get(STORES_OVERLAY_KEY)).toEqual({});
    expect(core.storeStatus('shop')).toMatchObject({ auth: { enabled: true, ttlSeconds: 120, protect: 'declared' } });
    expect(core.storeStatus('shop')!.overridden).toBeUndefined();
    expect(await core.updateStore('shop', { enabled: true, startsFrom: null, auth: { enabled: true, ttlSeconds: 120, protect: 'declared' }, dynamic: 'random', scope: 'team' })).toBe(false);

    // a personal value over the team's, then reset
    await core.updateStore('shop', { auth: { enabled: false }, dynamic: 'fixed' });
    expect(core.storeStatus('shop')).toMatchObject({ overridden: true, dynamic: 'fixed', auth: { enabled: false, ttlSeconds: 120 } });
    await core.updateStore('shop', { reset: 'settings' });
    expect(core.storeStatus('shop')).toMatchObject({ dynamic: 'random', auth: { enabled: true } });

    // team: explicit non-defaults are written; other settings of the entry are kept
    await core.updateStore('shop', { resource: 'users', idField: 'id', scope: 'team' });
    await core.updateStore('shop', { auth: { protect: 'all' }, dynamic: 'seeded', scope: 'team' });
    expect(fileStores()).toEqual([{ collection: 'shop', resources: { users: { idField: 'id' } }, auth: { enabled: true, ttlSeconds: 120, protect: 'all' }, dynamic: 'seeded' }]);
    await core.updateStore('shop', { auth: { enabled: false, ttlSeconds: 3600 }, scope: 'team' });
    expect(fileStores()).toEqual([{ collection: 'shop', resources: { users: { idField: 'id' } }, auth: { protect: 'all' }, dynamic: 'seeded' }]);
  });

  it('validation: ranges, unknown fields (never a password or token), expire stands as a data change', async () => {
    await setup(AUTH_ON);
    await expect(core.updateStore('shop', { auth: { ttlSeconds: 59 } })).rejects.toThrow(/60–86400/);
    await expect(core.updateStore('shop', { auth: { ttlSeconds: 86_401 } })).rejects.toThrow(/60–86400/);
    await expect(core.updateStore('shop', { auth: { ttlSeconds: 90.5 } })).rejects.toThrow(/60–86400/);
    await expect(core.updateStore('shop', { auth: { protect: 'some' as never } })).rejects.toThrow(/protect/);
    await expect(core.updateStore('shop', { auth: { password: 'x' } as never })).rejects.toThrow(/unknown field "password".*never set here/);
    await expect(core.updateStore('shop', { auth: { expire: 'some' as never } })).rejects.toThrow(/expire/);
    await expect(core.updateStore('shop', { auth: {} })).rejects.toThrow(/auth is empty/);
    await expect(core.updateStore('shop', { resource: 'users', replace: [], auth: { expire: 'all' } })).rejects.toThrow(/one data change at a time/);
    expect(memento.get(STORES_OVERLAY_KEY)).toBeUndefined();
    // expire changes no setting and no file
    login();
    const before = files.text(FILE);
    expect(await core.updateStore('shop', { auth: { expire: 'all' } })).toBe(false);
    expect(files.text(FILE)).toBe(before);
    expect(memento.get(STORES_OVERLAY_KEY)).toBeUndefined();
  });

  it('the file: login / refresh name the requests; invalid auth entries are skipped with a line; a bad overlay is ignored', async () => {
    await setup({ stores: [{ collection: 'shop', auth: { enabled: true, login: 'POST {{baseUrl}}/echo', refresh: 'POST {{baseUrl}}/nope' } }] });
    const auth = core.storeStatus('shop')!.auth!;
    expect(auth).toMatchObject({ enabled: true, login: 'POST {{baseUrl}}/echo', refresh: 'POST {{baseUrl}}/auth/refresh' });
    expect(auth.problems).toEqual(["auth.refresh in the settings names a request that isn't in the collection (the detected one is used)."]);

    files.put(FILE, sharedFile({ stores: [{ collection: 'shop', auth: { enabled: true, password: 'p' } }] }));
    await shared.reload();
    await core.reload();
    expect(core.storeStatus('shop')!.auth!.enabled).toBe(false);
    expect(core.fileProblems().join('\n')).toMatch(/stores entry 1 "shop": "auth": unknown field "password"/);

    for (const bad of [{ auth: { ttlSeconds: 5 } }, { auth: { ttlSeconds: '600' } }, { dynamic: 'x' }, { auth: 'yes' }]) {
      files.put(FILE, sharedFile({ stores: [{ collection: 'shop', ...bad }] }));
      await shared.reload();
      expect(shared.collectionLinks()[0].stores).toBeUndefined();
    }
    files.put(FILE, sharedFile());
    await shared.reload();
    await memento.update(STORES_OVERLAY_KEY, { [`${ROOT}\0shop`]: { auth: { enabled: 'yes', ttlSeconds: 1, protect: 'x' }, dynamic: 7 } });
    await core.reload();
    expect(core.storeStatus('shop')).toMatchObject({ dynamic: 'random', auth: { enabled: false, ttlSeconds: 3600, protect: 'declared' } });
  });
});

// ---------------------------------------------------------------------------------------------- nothing leaks

describe('nothing shown holds a token, a password or a request body', () => {
  it('panel views, describeRule, answerOf, logs, events, problems and workspaceState', async () => {
    await setup(AUTH_ON);
    const a = login();
    const issued = JSON.parse(a.body) as { access_token: string; refresh_token: string };
    login(WRONG);
    send('GET', '/users/me', { token: issued.access_token, id: 'p1' });
    send('GET', '/users/me', { token: 'planted-bad-token-value', id: 'p2' });
    send('POST', '/users', { body: { name: 'Lina', email: 'taken@example.com', password: PASSWORD }, token: issued.access_token, id: 'p3' });
    send('POST', '/echo', { body: { kind: 'b', card: 'planted-card-4111' }, token: issued.access_token, id: 'p4' });
    send('POST', '/auth/refresh', { body: { refresh_token: issued.refresh_token }, id: 'p5' });
    await core.updateStore('shop', { auth: { expire: 'all' } });
    const shown = everythingShown() + JSON.stringify(['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => [core.answerOf(id), core.storeOpOf(id)]));
    for (const secret of [PASSWORD, WRONG, issued.access_token, issued.refresh_token, 'planted-bad-token-value', 'planted-card-4111', 'taken@example.com']) {
      expect(shown, secret).not.toContain(secret);
    }
    // … and neither does a handler note
    for (const n of [a.note, login(WRONG).note]) expect(n).toMatch(/^(auth: signed in|example: Wrong password \(by body\))$/);
    expect(core.storeStatus('shop')!.auth!.sessions).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------- end to end

describe('through a real InterceptProxy', () => {
  it('login, a protected request, a quiet fallback and a rendered answer', async () => {
    await setup(AUTH_ON);
    const host = new InterceptProxyHost({ getPort: () => 0, factory: (o) => new InterceptProxy(o) });
    const real = makeCore({ setHandler: (id, fn) => host.setHandler(id, fn) });
    await real.reload();
    host.setCollectionRules(real.rules());
    const port = await host.start();
    const call = (method: string, p: string, body?: string, token?: string) =>
      new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, method, path: `${BASE}${p}`, headers: { host: 'api.shop.test', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
          (res) => {
            let b = '';
            res.on('data', (d) => (b += d));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    try {
      expect((await call('GET', '/users/me')).status).toBe(401);
      const signed = await call('POST', '/auth/login', JSON.stringify({ email: 'sara@example.com', password: PASSWORD }));
      expect(signed.status).toBe(200);
      const t = (JSON.parse(signed.body) as { access_token: string }).access_token;
      const me = await call('GET', '/users/me', undefined, t);
      expect(me).toMatchObject({ status: 200, body: '{"id":1,"name":"Sara"}' });
      const cfg = await call('GET', '/config', undefined, t);
      expect(JSON.parse(cfg.body).base).toBe(BASE);
      await new Promise((r) => setTimeout(r, 50));
      const exchanges = host.getExchanges() as Exchange[];
      const noted = (p: string, status: number) => exchanges.find((e) => e.url.endsWith(p) && e.status === status)!;
      expect(noted('/users/me', 401).notes).toEqual(['auth: 401 no token']);
      expect(noted('/auth/login', 200).notes).toEqual(['auth: signed in']);
      // the quiet fallback: the rule's own example, no "had no answer" note
      expect(noted('/users/me', 200).notes ?? []).toEqual([]);
      expect(real.storeStatus('shop')!.auth!.sessions).toBe(1);
      // nothing recorded about the exchanges holds the password beyond the app's own request body
      expect(JSON.stringify(exchanges.map((e) => [e.notes, e.error, e.simulated]))).not.toContain(PASSWORD);
    } finally {
      await host.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------- sources

describe('more sources through the core (§24.4, §24.7)', () => {
  const link = (file: string, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, rules: [], collections: [{ id: 'shop', file, ...extra }] });
  const SHOP = 'https://api.shop.example';
  const mocked = (c = core) => c.state()[0];

  function putBruno(root = `${ROOT}/api/shop-bruno`): void {
    const walk = (dir: string, rel: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs, `${rel}/${ent.name}`);
        else files.put(`${root}${rel}/${ent.name}`, fs.readFileSync(abs, 'utf8'));
      }
    };
    walk(path.join(FIXTURES, 'shop-bruno'), '');
  }

  it('Swagger 2.0', async () => {
    files.put(`${ROOT}/api/shop.swagger2.json`, fixture('shop.swagger2.json'));
    files.put(FILE, link('api/shop.swagger2.json'));
    await shared.reload();
    core = makeCore();
    await core.reload();
    const s = mocked();
    expect(s).toMatchObject({ format: 'swagger', name: 'Shop API' });
    expect(s.mocked).toBeGreaterThan(3);
    expect(s.origins).toEqual([SHOP]);
    expect(findRule(compileRules(core.rules()), 'GET', `${SHOP}/v1/users/7`)).toBeTruthy();
    expect(findRule(compileRules(core.rules()), 'POST', `${SHOP}/v1/auth/login`)).toBeTruthy();
    // a personal rule copy works for it too
    expect(core.toRule('shop', core.endpoints('shop')[0].key).action.kind).toBe('mock');
  });

  it('Insomnia v4 (JSON) and v5 (YAML): the environment is chosen by name, validated, never a file', async () => {
    files.put(`${ROOT}/api/shop.insomnia-v4.json`, fixture('shop.insomnia-v4.json'));
    files.put(`${ROOT}/api/shop.insomnia-v5.yaml`, fixture('shop.insomnia-v5.yaml'));
    files.put(FILE, JSON.stringify({ version: 1, rules: [] }));
    await shared.reload();
    core = makeCore();
    await core.reload();
    const names4 = await core.environmentsOf('api/shop.insomnia-v4.json');
    expect(names4.length).toBeGreaterThan(0);
    await expect(core.addLink({ file: 'api/shop.insomnia-v4.json', environment: 'api/dev.json' })).rejects.toThrow(/is not an environment of this Insomnia collection; it has: /);
    const { id } = await core.addLink({ file: 'api/shop.insomnia-v4.json', environment: names4[0] });
    await shared.reload();
    await core.reload();
    const s = core.state().find((x) => x.id === id)!;
    expect(s).toMatchObject({ format: 'insomnia' });
    expect(s.endpoints).toBeGreaterThan(3);
    expect(JSON.parse(files.text(FILE)!).collections[0]).toMatchObject({ file: 'api/shop.insomnia-v4.json', environment: names4[0] });
    // a name that is gone later: a problem line, the collection still loads
    const doc = JSON.parse(files.text(FILE)!);
    doc.collections[0].environment = 'Gone';
    files.put(FILE, JSON.stringify(doc));
    await shared.reload();
    await core.reload();
    expect(core.state()[0].problems.join('\n')).toMatch(/Environment "Gone" is not in the file/);

    const v5 = await core.addLink({ file: 'api/shop.insomnia-v5.yaml' });
    await shared.reload();
    await core.reload();
    const s5 = core.state().find((x) => x.id === v5.id)!;
    expect(s5.format).toBe('insomnia');
    expect(s5.endpoints).toBeGreaterThan(3);
    expect(s5.id).not.toBe(id);
  });

  it('Bruno: the folder is walked from bruno.json; hidden folders, node_modules and non-.bru files are never read', async () => {
    putBruno();
    files.put(`${ROOT}/api/shop-bruno/.env`, 'TOKEN=planted-env-secret');
    files.put(`${ROOT}/api/shop-bruno/.git/Hidden.bru`, 'meta {\n  name: Hidden\n}\nget {\n  url: https://hidden.example/x\n}\n');
    files.put(`${ROOT}/api/shop-bruno/node_modules/pkg/Dep.bru`, 'meta {\n  name: Dep\n}\nget {\n  url: https://dep.example/x\n}\n');
    files.put(`${ROOT}/api/shop-bruno/notes.md`, 'planted-notes');
    files.put(FILE, link('api/shop-bruno/bruno.json', { environment: 'dev' }));
    await shared.reload();
    core = makeCore();
    await core.reload();
    const s = mocked();
    expect(s).toMatchObject({ format: 'bruno', name: 'Shop API', file: 'api/shop-bruno/bruno.json' });
    expect(s.origins).toContain(SHOP);
    expect(s.endpoints).toBeGreaterThan(5);
    const urls = core.endpoints('shop').map((e) => e.url).join('\n');
    expect(urls).not.toMatch(/hidden\.example|dep\.example/);
    expect(everythingShown()).not.toMatch(/planted-env-secret|planted-notes/);
    // every folder of the collection is watched (not the hidden ones)
    expect(watchedFolders).toContain(`${ROOT}/api/shop-bruno`);
    expect(watchedFolders).toContain(`${ROOT}/api/shop-bruno/Users/Orders`);
    expect(watchedFolders.some((d) => /\.git|node_modules/.test(d))).toBe(false);
    // examples by body come through the same pipeline
    const loginView = core.endpoints('shop').find((e) => e.name === 'Log in')!;
    expect(loginView.examples.find((x) => x.name === 'Wrong password')!.byBody).toEqual(['password']);
    expect(everythingShown()).not.toMatch(/hunter2|wrong-guess/);

    // environments by name: offered, validated on import
    expect(await core.environmentsOf('api/shop-bruno/bruno.json')).toEqual(['dev', 'staging']);
    files.put(FILE, JSON.stringify({ version: 1, rules: [] }));
    await shared.reload();
    await core.reload();
    await expect(core.addLink({ file: 'api/shop-bruno/bruno.json', environment: 'prod' })).rejects.toThrow(/"prod" is not an environment of this Bruno collection; it has: dev, staging/);
    expect((await core.addLink({ file: 'api/shop-bruno/bruno.json', environment: 'staging' })).id).toBe('shop-api');
  });

  it('Bruno: a .bru change, a new file and a removed file reload (cache key = paths + sizes + mtimes); unchanged → the cached parse', async () => {
    putBruno();
    files.put(FILE, link('api/shop-bruno/bruno.json', { environment: 'dev' }));
    await shared.reload();
    let parses = 0;
    core = new MockCollectionsCore({
      ...(makeCore() as unknown as { deps: ConstructorParameters<typeof MockCollectionsCore>[0] }).deps,
      parsers: { ...collectionParsers, parseBruno: (f, o) => (parses++, collectionParsers.parseBruno!(f, o)) },
    });
    await core.reload();
    const before = mocked().endpoints;
    expect(parses).toBe(1);
    expect(await core.reload()).toBe(false);
    expect(parses).toBe(1);

    files.put(`${ROOT}/api/shop-bruno/Users/New.bru`, 'meta {\n  name: Coupons\n  type: http\n}\n\nget {\n  url: {{baseUrl}}/coupons\n}\n');
    expect(await core.reload()).toBe(true);
    expect(parses).toBe(2);
    expect(mocked().endpoints).toBe(before + 1);

    const health = `${ROOT}/api/shop-bruno/Health.bru`;
    files.put(health, files.text(health)!.replace('/health', '/healthz'));
    expect(await core.reload()).toBe(true);
    expect(core.endpoints('shop').some((e) => e.url.endsWith('/healthz'))).toBe(true);

    files.files.delete(`${ROOT}/api/shop-bruno/Users/New.bru`);
    expect(await core.reload()).toBe(true);
    expect(mocked().endpoints).toBe(before);
  });

  it('Bruno folder limits: more than 2 000 files, deeper than 32, over 20 MB or a huge folder → refused whole, never read in part', async () => {
    const root = `${ROOT}/api/big`;
    const bru = (n: number) => `meta {\n  name: R${n}\n  type: http\n}\n\nget {\n  url: https://big.example/r${n}\n}\n`;
    files.put(`${root}/bruno.json`, '{"version":"1","name":"Big","type":"collection"}');
    files.put(FILE, link('api/big/bruno.json'));
    await shared.reload();
    core = makeCore();

    for (let n = 0; n < brunoLimits.files; n++) files.put(`${root}/r${n}.bru`, bru(n)); // + bruno.json = 2 001
    await core.reload();
    expect(mocked().problems.join('\n')).toMatch(/more than 2000 request files in the collection folder \(not read\)/);
    expect(mocked().endpoints).toBe(0);
    files.files.delete(`${root}/r0.bru`);
    await core.reload();
    expect(mocked().endpoints).toBe(brunoLimits.files - 1);

    // depth
    for (const k of [...files.files.keys()]) if (k.startsWith(`${root}/r`)) files.files.delete(k);
    const deep = (levels: number) => `${root}/${Array.from({ length: levels }, (_, i) => `d${i}`).join('/')}`;
    files.put(`${deep(brunoLimits.depth)}/ok.bru`, bru(1));
    await core.reload();
    expect(mocked().endpoints).toBe(1);
    files.put(`${deep(brunoLimits.depth + 1)}/too-deep.bru`, bru(2));
    await core.reload();
    expect(mocked().problems.join('\n')).toMatch(/nested deeper than 32 \(not read\) — using the last good version/);
    expect(mocked().endpoints).toBe(1); // the last good version is kept
  });

  it('Bruno folder limits: total size', async () => {
    const root = `${ROOT}/api/heavy`;
    files.put(`${root}/bruno.json`, '{"version":"1","name":"Heavy","type":"collection"}');
    files.put(`${root}/a.bru`, new Uint8Array(11 * 1024 * 1024).fill(0x20));
    files.put(`${root}/b.bru`, new Uint8Array(10 * 1024 * 1024).fill(0x20));
    files.put(FILE, link('api/heavy/bruno.json'));
    await shared.reload();
    core = makeCore();
    await core.reload();
    expect(mocked().problems.join('\n')).toMatch(/larger than 20 MB in all \(not read\)/);
    expect(BRUNO_MAX_ENTRIES).toBeGreaterThan(brunoLimits.files);
  });

  describe('on the real file system', () => {
    let tmp: string;
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('symbolic links are never followed: a linked file, a linked folder (also one pointing outside), a linked bruno.json', async () => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-bruno-')));
      const ws = path.join(tmp, 'ws');
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(ws, 'pubspec.yaml'), 'name: app');
      fs.cpSync(path.join(FIXTURES, 'shop-bruno'), path.join(ws, 'api', 'shop'), { recursive: true });
      const secret = 'meta {\n  name: Outside\n  type: http\n}\n\nget {\n  url: https://outside.example/planted-outside\n}\n';
      fs.writeFileSync(path.join(outside, 'Outside.bru'), secret);
      fs.symlinkSync(outside, path.join(ws, 'api', 'shop', 'Linked'), 'dir');
      fs.symlinkSync(path.join(outside, 'Outside.bru'), path.join(ws, 'api', 'shop', 'Alias.bru'), 'file');
      fs.symlinkSync(path.join(ws, 'api', 'shop', 'Users'), path.join(ws, 'api', 'shop', 'UsersAgain'), 'dir');
      fs.writeFileSync(path.join(ws, '.vscode', 'flutter-intercept.json'), link('api/shop/bruno.json', { environment: 'dev' }));
      const realShared = new SharedRulesCore({ folders: () => [{ name: 'app', path: ws }], fs: nodeRulesFs, validateRule: fakeValidateRule, memento });
      await realShared.reload();
      core = makeCore({ fs: nodeRulesFs, root: ws, sharedCore: realShared });
      await core.reload();
      const s = mocked();
      expect(s.format).toBe('bruno');
      expect(s.endpoints).toBeGreaterThan(5);
      expect(s.problems.filter((p) => /is a symbolic link \(not read\)/.test(p)).sort()).toEqual(['Alias.bru is a symbolic link (not read)', 'Linked is a symbolic link (not read)', 'UsersAgain is a symbolic link (not read)']);
      expect(everythingShown()).not.toContain('planted-outside');
      // each request once (the linked copy of Users is not read)
      const keys = core.endpoints('shop').map((e) => e.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.filter((k) => /\/users\/me$/.test(k))).toHaveLength(1);

      // a bruno.json reached through a link is refused
      fs.symlinkSync(path.join(ws, 'api', 'shop'), path.join(ws, 'api', 'alias'), 'dir');
      fs.writeFileSync(path.join(ws, '.vscode', 'flutter-intercept.json'), link('api/alias/bruno.json'));
      await realShared.reload();
      const second = makeCore({ fs: nodeRulesFs, root: ws, sharedCore: realShared });
      await second.reload();
      expect(second.state()[0].problems.join('\n')).toMatch(/goes through a symbolic link/);
      expect(second.state()[0].endpoints).toBe(0);
    });
  });

  it('copy-in: Swagger / Insomnia files and Bruno folders outside the project are refused with what to do; formatOf', async () => {
    await setup();
    expect(core.formatOf(fixture('shop.swagger2.json'), 'shop.swagger2.json')).toBe('swagger');
    expect(core.formatOf(fixture('shop.insomnia-v5.yaml'), 'shop.insomnia-v5.yaml')).toBe('insomnia');
    expect(core.formatOf('{"version":"1","name":"Shop","type":"collection"}', 'bruno.json')).toBe('bruno');
    await expect(core.copyIn(fixture('shop.swagger2.json'), 'shop.swagger2.json', 'as-is')).rejects.toThrow(/outside the project\. Put the Swagger 2\.0 file in the project/);
    await expect(core.copyIn(fixture('shop.insomnia-v4.json'), 'shop.insomnia-v4.json', 'sanitised')).rejects.toThrow(/Put the Insomnia file in the project/);
    await expect(core.copyIn('{"version":"1","name":"Shop","type":"collection"}', 'bruno.json', 'as-is')).rejects.toThrow(/A Bruno collection is a folder/);
    expect(files.writes.filter((w) => w.includes('/collections/'))).toEqual([]);
    // a bruno.json that isn't linked by that name gets a pointer
    files.put(`${ROOT}/api/other.json`, '{"version":"1","name":"Shop","type":"collection"}');
    await expect(core.addLink({ file: 'api/other.json' })).rejects.toThrow(/link the file named bruno\.json itself/);
    // a Postman environment *file* is still what the other formats take
    files.put(`${ROOT}/api/shop.swagger2.json`, fixture('shop.swagger2.json'));
    await expect(core.addLink({ file: 'api/shop.swagger2.json', environment: '../env.json' })).rejects.toThrow(/environment must be a file inside the workspace/);
  });
});
