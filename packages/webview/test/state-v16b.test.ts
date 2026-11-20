// v0.16.0 parts 2 and 3 (CONTRACTS §23.2 – §23.4, §24.1 – §24.4): pure helpers — "out of date" in plain words,
// examples chosen by the request's body, the source badges, what a fake backend can be made from and its result
// line, sign-in and made-up values (Save for the team, the detail pane's line) — and the reducer's part.
import { describe, expect, it } from 'vitest';
import {
  byBodyHint, byBodyLine, fakeBackendResultText, formatLabel, hasFinishedRequest,
} from '../src/collections';
import {
  DRIFT_VIEW_LIMITS, driftChangeLines, driftChangeText, driftCountText, driftedEndpoints, driftLineText, driftsOf,
  endpointLabel, isNewStatus,
} from '../src/drift';
import type { CollectionEndpointView, CollectionStatus, DriftChange, DriftView, HostMsg, StoreAuthStatus, StoreStatus } from '../src/protocol';
import { initialState, reducer, type State } from '../src/state';
import {
  authNoteOfExchange, authOf, dynamicOf, parseTtl, protectOf, sessionsText, teamStorePatch, ttlOf,
} from '../src/store';
import { ex, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });

const auth = (over: Partial<StoreAuthStatus> = {}): StoreAuthStatus => ({
  available: true, enabled: true, login: 'POST /auth/login', ttlSeconds: 3600, protect: 'declared', sessions: 2, problems: [], ...over,
});
const store = (over: Partial<StoreStatus> = {}): StoreStatus => ({
  enabled: true,
  resources: [
    { name: 'users', path: '/users/:id', idField: 'id', count: 10, remembers: true, detected: true },
    { name: 'orders', path: '/orders/:id', idField: 'id', count: 2, remembers: true, detected: true },
    { name: 'logs', path: '/logs/:id', idField: 'id', count: 0, remembers: false, detected: true },
  ],
  snapshots: [], changed: false, problems: [], ...over,
});
const col = (over: Partial<CollectionStatus> = {}): CollectionStatus => ({
  id: 'shop-api', overrides: 0, name: 'Shop API', file: 'api/shop.json', format: 'postman', enabled: true,
  unmatched: 'passthrough', endpoints: 10, mocked: 10, noExample: 0, generated: 0, off: 0, unresolved: [],
  origins: ['https://api.shop.example'], problems: [], ...over,
});
const change = (kind: DriftChange['kind'], path: string, from?: string, to?: string): DriftChange =>
  ({ kind, path, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
const view = (changes: DriftChange[], over: Partial<DriftView> = {}): DriftView =>
  ({ endpoint: 'GET {{baseUrl}}/users/:id', status: 200, samples: 3, changes, since: 1_700_000_000_000, ...over });
const ep = (over: Partial<CollectionEndpointView> = {}): CollectionEndpointView => ({
  key: 'GET {{baseUrl}}/users/:id', method: 'GET', name: 'Get user', folder: [], url: 'https://api.shop.example/users/:id',
  examples: [{ name: 'OK', status: 200 }], ...over,
});

describe('out of date, in plain words (CONTRACTS §23.3)', () => {
  it('says each kind of change the way a person would', () => {
    expect(driftChangeText(change('added', 'avatar', undefined, 'string'), 200)).toBe('avatar — new field');
    expect(driftChangeText(change('removed', 'email', 'string'), 200)).toBe('email — gone');
    expect(driftChangeText(change('type', 'age', 'int', 'string'), 200)).toBe('age — now text, was a number');
    expect(driftChangeText(change('nullable', 'nickname', 'string', 'null'), 200)).toBe('nickname — can be empty now');
    expect(driftChangeText(change('status', '', undefined, '201'), 201)).toBe('answers 201, no example for it');
  });

  it('tells whole numbers from decimals only when both sides are numbers', () => {
    expect(driftChangeText(change('type', 'price', 'int', 'double'), 200)).toBe('price — now a decimal number, was a whole number');
    expect(driftChangeText(change('type', 'ok', 'bool', 'double'), 200)).toBe('ok — now a number, was true / false');
    expect(driftChangeText(change('type', 'items', 'object', 'list'), 200)).toBe('items — now a list, was an object');
  });

  it('never repeats a kind it does not know, and names the whole answer when there is no path', () => {
    expect(driftChangeText(change('type', 'x', 'mixed', 'string'), 200)).toBe('x — now text');
    expect(driftChangeText(change('type', 'x', 'string', '<b>secret-value</b>'), 200)).toBe('x — another kind of value now');
    expect(driftChangeText(change('type', '', 'object', 'list'), 200)).toBe('the whole answer — now a list, was an object');
    // a `status` change with a strange `to` falls back to the view's own status, then to no number at all
    expect(driftChangeText(change('status', '', undefined, 'alert(1)'), 202)).toBe('answers 202, no example for it');
    expect(driftChangeText(change('status', '', undefined, 'x'), Number.NaN)).toBe('answers a status it has no example for');
  });

  it('cuts long paths at 200 characters', () => {
    const text = driftChangeText(change('added', 'p'.repeat(500)), 200);
    expect(text.length).toBeLessThan(220);
    expect(text.endsWith('… — new field')).toBe(true);
  });

  it('lists twenty changes, then says how many more', () => {
    const many = Array.from({ length: 27 }, (_, i) => change('added', `f${i}`));
    const out = driftChangeLines(view(many));
    expect(out.lines).toHaveLength(DRIFT_VIEW_LIMITS.changes);
    expect(out.more).toBe(7);
    expect(driftChangeLines(view([change('added', 'a')]))).toEqual({ lines: ['a — new field'], more: 0 });
  });

  it('the collection line is the host\'s, prefixed "Out of date: "', () => {
    expect(driftLineText({ endpoints: 2, line: 'GET /users/:id now has avatar (and 2 more)' }))
      .toBe('Out of date: GET /users/:id now has avatar (and 2 more)');
    expect(driftLineText(undefined)).toBeUndefined();
    expect(driftLineText({ endpoints: 0, line: '' })).toBeUndefined();
    expect(driftLineText({ endpoints: 1, line: '' })).toBe('Out of date: 1 request no longer matches what the real server answers');
    expect(driftLineText({ endpoints: 3, line: '  ' })).toBe('Out of date: 3 requests no longer match what the real server answers');
    expect(driftLineText({ endpoints: 1, line: `a\n\nb ${'x'.repeat(1000)}` })!.length).toBeLessThanOrEqual('Out of date: '.length + DRIFT_VIEW_LIMITS.line);
    expect(driftLineText({ endpoints: 1, line: 'a\n\nb' })).toBe('Out of date: a b');
  });

  it('keeps only well-formed differences (hostile input)', () => {
    const bad = [
      null, 'x', { status: 200 }, { status: 'x', changes: [change('added', 'a')] }, view([]),
      view([{ kind: 'explode', path: 'a' } as unknown as DriftChange, { kind: 'added' } as unknown as DriftChange]),
      view([change('added', 'ok'), { kind: 'type', path: 'a', from: 7 } as unknown as DriftChange], { status: 404 }),
    ] as unknown as DriftView[];
    const kept = driftsOf(ep({ drift: bad }));
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe(404);
    expect(kept[0].changes).toEqual([change('added', 'ok')]);
    expect(driftsOf(ep())).toEqual([]);
    expect(driftsOf(ep({ drift: 'nope' as unknown as DriftView[] }))).toEqual([]);
  });

  it('at most ten statuses per endpoint', () => {
    const drift = Array.from({ length: 30 }, (_, i) => view([change('added', 'a')], { status: 200 + i }));
    expect(driftsOf(ep({ drift }))).toHaveLength(DRIFT_VIEW_LIMITS.statuses);
  });

  it('finds the endpoints that are out of date, in order', () => {
    const list = [ep({ key: 'a' }), ep({ key: 'b', drift: [view([change('added', 'x')])] }), ep({ key: 'c', drift: [] }), ep({ key: 'd', drift: [view([change('status', '', undefined, '201')], { status: 201 })] })];
    expect(driftedEndpoints(list).map((e) => e.key)).toEqual(['b', 'd']);
    expect(driftedEndpoints(undefined)).toEqual([]);
  });

  it('a status with no example can only be added', () => {
    expect(isNewStatus(view([change('status', '', undefined, '201')]))).toBe(true);
    expect(isNewStatus(view([change('added', 'a')]))).toBe(false);
    expect(isNewStatus(view([]))).toBe(false);
  });

  it('counts changes and labels endpoints like the host does', () => {
    expect(driftCountText([view([change('added', 'a')])])).toBe('1 change');
    expect(driftCountText([view([change('added', 'a'), change('removed', 'b')]), view([change('added', 'c')])])).toBe('3 changes');
    expect(endpointLabel('GET {{baseUrl}}/users/:id')).toBe('GET /users/:id');
    expect(endpointLabel('POST https://api.shop.example/users')).toBe('POST /users');
    expect(endpointLabel('GET https://api.shop.example')).toBe('GET /');
    expect(endpointLabel('GET /a?next=http://x/y')).toBe('GET /a?next=http://x/y');
    expect(endpointLabel('weird')).toBe('weird');
    expect(endpointLabel(undefined as unknown as string)).toBe('');
  });
});

describe('examples chosen by what the request sends (CONTRACTS §24.2)', () => {
  it('names the fields: three at most, then "and N more"', () => {
    expect(byBodyHint(['password'])).toBe("answers when the request's password matches");
    expect(byBodyHint(['email', 'password'])).toBe("answers when the request's email, password match");
    expect(byBodyHint(['a', 'b', 'c', 'd', 'e'])).toBe("answers when the request's a, b, c and 2 more match");
  });

  it('ignores what is not a field name', () => {
    expect(byBodyHint(undefined)).toBeUndefined();
    expect(byBodyHint([])).toBeUndefined();
    expect(byBodyHint('password')).toBeUndefined();
    expect(byBodyHint([7, null, '', '  '])).toBeUndefined();
    expect(byBodyHint(['a', 'a', 7])).toBe("answers when the request's a matches");
    expect(byBodyHint(['x'.repeat(500)])!.length).toBeLessThan(120);
  });

  it('one quiet line for the examples that are not the chosen one', () => {
    const login = ep({
      examples: [
        { name: 'OK', status: 200 },
        { name: 'Wrong password', status: 401, byBody: ['password'] },
        { name: 'Locked', status: 423, byBody: ['email'] },
        { name: 'Other', status: 400, byBody: ['a'] },
      ],
    });
    expect(byBodyLine(login, 'OK'))
      .toBe("“Wrong password” answers when the request's password matches · “Locked” answers when the request's email matches · and 1 more");
    expect(byBodyLine(ep({ examples: [{ name: 'OK', status: 200, byBody: ['a'] }] }), 'OK')).toBeUndefined();
    expect(byBodyLine(ep(), 'OK')).toBeUndefined();
  });
});

describe('where a collection came from (CONTRACTS §24.4)', () => {
  it('maps every format, and nothing else', () => {
    expect(formatLabel('postman')).toBe('Postman');
    expect(formatLabel('openapi')).toBe('OpenAPI');
    expect(formatLabel('swagger')).toBe('Swagger 2.0');
    expect(formatLabel('insomnia')).toBe('Insomnia');
    expect(formatLabel('bruno')).toBe('Bruno');
    expect(formatLabel(undefined)).toBeUndefined();
    expect(formatLabel('toString')).toBeUndefined();
    expect(formatLabel('__proto__')).toBeUndefined();
  });
});

describe('a fake backend from traffic (CONTRACTS §23.2)', () => {
  it('needs a finished request the real server answered', () => {
    expect(hasFinishedRequest([])).toBe(false);
    expect(hasFinishedRequest([ex()])).toBe(true);
    expect(hasFinishedRequest([ex({ state: 'pending', status: undefined })])).toBe(false);
    expect(hasFinishedRequest([ex({ state: 'mocked' })])).toBe(false);
    expect(hasFinishedRequest([ex({ state: 'error', status: undefined })])).toBe(false);
    expect(hasFinishedRequest([ex({ kind: 'websocket' })])).toBe(false);
    expect(hasFinishedRequest([ex({ kind: 'grpc' })])).toBe(false);
    expect(hasFinishedRequest([ex({ simulated: 'Replayed from demo' })])).toBe(false);
    expect(hasFinishedRequest([ex({ captured: 'vm-profile' })])).toBe(false);
    expect(hasFinishedRequest([ex({ state: 'mocked' }), ex(), ex({ kind: 'sse' })])).toBe(true);
  });

  it('the result line names the requests answered and the data remembered', () => {
    expect(fakeBackendResultText(col({ name: 'Shop API (recorded)', mocked: 23, store: store() })))
      .toBe('Shop API (recorded) answers 23 requests · remembers users, orders');
    expect(fakeBackendResultText(col({ name: 'One', mocked: 1 }))).toBe('One answers 1 request');
    expect(fakeBackendResultText(col({ name: '', mocked: Number.NaN }))).toBe('The fake backend answers 0 requests');
  });

  const withCols = (cols: CollectionStatus[]) => host(initialState(), { type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: cols } });

  it('the collection that appears after asking is shown, with its result line', () => {
    let s = withCols([col()]);
    s = reducer(s, { type: 'setView', view: 'recordings' });
    s = reducer(s, { type: 'awaitFakeBackend' });
    expect(s.awaitingFakeBackend).toEqual({ knownIds: ['shop-api'] });
    // a status that adds nothing changes nothing
    s = host(s, { type: 'status', status: { ...status, collections: [col()] } });
    expect(s.view).toBe('recordings');
    expect(s.notice).toBeUndefined();
    const made = col({ id: 'shop-recorded', name: 'Shop API (recorded)', mocked: 23, store: store() });
    s = host(s, { type: 'status', status: { ...status, collections: [col(), made] } });
    expect(s.view).toBe('collections');
    expect(s.notice?.text).toBe('Shop API (recorded) answers 23 requests · remembers users, orders');
    expect(s.awaitingFakeBackend).toBeUndefined();
    // and only once
    const again = host(s, { type: 'status', status: { ...status, collections: [col(), made, col({ id: 'third', name: 'Third' })] } });
    expect(again.notice).toBe(s.notice);
  });

  it('stops waiting when the host reports a problem or the user moves on', () => {
    let s = reducer(withCols([]), { type: 'awaitFakeBackend' });
    s = host(s, { type: 'error', message: 'Nothing to record' });
    expect(s.awaitingFakeBackend).toBeUndefined();
    s = host(s, { type: 'status', status: { ...status, collections: [col()] } });
    expect(s.notice).toBeUndefined();
    expect(s.view).toBe('traffic');

    s = reducer(withCols([]), { type: 'awaitFakeBackend' });
    s = reducer(s, { type: 'setView', view: 'rules' });
    s = host(s, { type: 'status', status: { ...status, collections: [col()] } });
    expect(s.view).toBe('rules');
    expect(s.notice).toBeUndefined();
  });

  it('a collection that is simply there (never asked for) is not announced', () => {
    const s = host(withCols([]), { type: 'status', status: { ...status, collections: [col()] } });
    expect(s.notice).toBeUndefined();
    expect(s.view).toBe('traffic');
  });
});

describe('sign-in and made-up values (CONTRACTS §24.1 / §24.3)', () => {
  it('sign-in shows only when the collection has a login request', () => {
    expect(authOf(store({ auth: auth() }))).toBeDefined();
    expect(authOf(store({ auth: auth({ available: false }) }))).toBeUndefined();
    expect(authOf(store())).toBeUndefined();
    expect(authOf(undefined)).toBeUndefined();
    expect(authOf(store({ auth: 'yes' as unknown as StoreAuthStatus }))).toBeUndefined();
  });

  it('token lifetime: 60 – 86 400 seconds, anything else falls back or is refused', () => {
    expect(ttlOf(auth({ ttlSeconds: 900 }))).toBe(900);
    expect(ttlOf(auth({ ttlSeconds: 5 }))).toBe(3600);
    expect(ttlOf(auth({ ttlSeconds: Number.NaN }))).toBe(3600);
    expect(ttlOf(auth({ ttlSeconds: '900' as unknown as number }))).toBe(3600);
    expect(parseTtl('900')).toBe(900);
    expect(parseTtl(' 120 ')).toBe(120);
    expect(parseTtl('5')).toBe(60);
    expect(parseTtl('999999')).toBe(86_400);
    expect(parseTtl('90.6')).toBe(91);
    expect(parseTtl('')).toBeUndefined();
    expect(parseTtl('soon')).toBeUndefined();
    expect(parseTtl('1e999')).toBeUndefined();
    expect(parseTtl('1'.repeat(40))).toBeUndefined();
  });

  it('which requests need a token, and how many are signed in', () => {
    expect(protectOf(auth({ protect: 'declared' }))).toBe('declared');
    expect(protectOf(auth({ protect: 'all' }))).toBe('all');
    expect(protectOf(auth({ protect: 'x' as unknown as 'all' }))).toBe('all');
    expect(sessionsText(0)).toBe('0 sessions');
    expect(sessionsText(1)).toBe('1 session');
    expect(sessionsText(12)).toBe('12 sessions');
    expect(sessionsText('many')).toBe('0 sessions');
  });

  it('made-up values: only the three known ways', () => {
    expect(dynamicOf(store({ dynamic: 'seeded' }))).toBe('seeded');
    expect(dynamicOf(store())).toBeUndefined();
    expect(dynamicOf(store({ dynamic: 'chaos' as unknown as 'fixed' }))).toBeUndefined();
  });

  it('Save for the team carries sign-in and made-up values — never a password, a token or "sign everyone out"', () => {
    expect(teamStorePatch(store())).toEqual({ enabled: true, startsFrom: null, scope: 'team' });
    const patch = teamStorePatch(store({
      startsFrom: 'checkout', dynamic: 'seeded',
      auth: auth({ enabled: true, ttlSeconds: 900, protect: 'all', sessions: 4, problems: ['x'] }),
    }));
    expect(patch).toEqual({
      enabled: true, startsFrom: 'checkout', auth: { enabled: true, ttlSeconds: 900, protect: 'all' }, dynamic: 'seeded', scope: 'team',
    });
    // sign-in the collection doesn't have is not written
    expect(teamStorePatch(store({ auth: auth({ available: false }) }))).toEqual({ enabled: true, startsFrom: null, scope: 'team' });
  });

  it('the detail pane line: what sign-in did, in plain words', () => {
    const answered = (notes: string[]) => ex({ matchedRuleId: 'collection:shop-api:3', notes });
    expect(authNoteOfExchange(answered(['auth: 401 no token']))).toEqual({ text: 'needs sign-in (no token)', note: 'auth: 401 no token' });
    expect(authNoteOfExchange(answered(['auth: 401 expired']))?.text).toBe('token expired');
    expect(authNoteOfExchange(answered(['users: listed', 'auth: signed in']))?.text).toBe('signed in');
    expect(authNoteOfExchange(answered(['auth: refreshed']))?.text).toBe('token refreshed');
  });

  it('other notes stay notes; answers that are not a collection\'s are left alone', () => {
    const more = 'auth: more than 1000 sessions, the oldest were dropped';
    expect(authNoteOfExchange(ex({ matchedRuleId: 'collection:shop-api:3', notes: [more] }))).toBeUndefined();
    expect(authNoteOfExchange(ex({ matchedRuleId: 'r1', notes: ['auth: signed in'] }))).toBeUndefined();
    expect(authNoteOfExchange(ex({ notes: ['auth: signed in'] }))).toBeUndefined();
    expect(authNoteOfExchange(ex({ matchedRuleId: 'collection:shop-api:3' }))).toBeUndefined();
    expect(authNoteOfExchange(ex({ matchedRuleId: 'collection:shop-api:3', notes: [7 as unknown as string] }))).toBeUndefined();
  });
});
