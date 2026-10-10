// v0.5.0 (CONTRACTS §11): reducer paths, rule form (graphqlOperation, cors), GraphQL-aware rule preview,
// coverage helpers and the new filter tokens.
import { describe, expect, it } from 'vitest';
import {
  compileExchangeMatcher, countMatches, describeAction, describeCors, filterExchanges, formToRule, hiddenBrowserCount, initialState, matcherLabel,
  reducer, ruleLabel, ruleStats, ruleToForm, toPersisted, validateRuleForm, visibleWarnings, winningRuleIndex, EMPTY_FILTERS,
  type State,
} from '../src/state';
import { corsActionError, corsMatches, corsRuleFor, gqlLabel, gqlTitle, isNative, requestOrigin, routeGlob, sentCookies } from '../src/coverage';
import { parseFilter } from '../src/filter';
import type { Exchange, HostMsg, SessionWarning, Status } from '../src/protocol';
import { ex, pausedResponse, rule, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });
const ws = (over: Partial<Exchange> = {}) => ex({
  method: 'GET', url: 'wss://rt.example.com/socket', kind: 'websocket', status: 101, state: 'pending',
  responseBody: undefined, frames: [{ dir: 'receive', at: 1, kind: 'text', text: 'hi', size: 2 }], ...over,
});
const gql = (op: string, over: Partial<Exchange> = {}) => ex({
  method: 'POST', url: 'https://api.example.com/graphql', graphql: { operationName: op, operationType: 'query' }, ...over,
});
const warn = (id: string, kind: SessionWarning['kind'] = 'background-isolate'): SessionWarning => ({ id, kind, text: `warning ${id}` });

describe('detail tab for WebSocket / SSE exchanges', () => {
  it('selecting a framed exchange opens Messages; a plain one leaves Messages for Response', () => {
    const a = ws();
    const b = ex();
    let s = host(initialState(), { type: 'snapshot', exchanges: [a, b], rules: [], status });
    s = reducer(s, { type: 'select', id: a.id });
    expect(s.detailTab).toBe('messages');
    s = reducer(s, { type: 'select', id: b.id });
    expect(s.detailTab).toBe('response');
    s = reducer(s, { type: 'setDetailTab', tab: 'request' });
    s = reducer(s, { type: 'select', id: a.id });
    expect(s.detailTab).toBe('messages');
  });

  it('plain exchanges keep request/response; sse counts as framed; move behaves like select', () => {
    const a = ex();
    const b = ws({ kind: 'sse', url: 'https://api.example.com/stream' });
    let s = host(initialState(), { type: 'snapshot', exchanges: [a, b], rules: [], status });
    s = reducer(s, { type: 'setDetailTab', tab: 'request' });
    s = reducer(s, { type: 'select', id: a.id });
    expect(s.detailTab).toBe('request');
    s = reducer(s, { type: 'move', to: 'next' });
    expect(s.selectedId).toBe(b.id);
    expect(s.detailTab).toBe('messages');
    s = reducer(s, { type: 'move', to: 'prev' });
    expect(s.detailTab).toBe('response');
  });

  it('a paused phase wins over Messages', () => {
    const p = pausedResponse();
    let s = host(initialState(), { type: 'snapshot', exchanges: [ws(), p], rules: [], status });
    s = reducer(s, { type: 'setDetailTab', tab: 'messages' });
    s = reducer(s, { type: 'select', id: p.id });
    expect(s.detailTab).toBe('response');
  });

  it('a restored Messages tab falls back to Response when the selection is not framed', () => {
    const a = ex();
    let s = reducer(initialState(), { type: 'restore', persisted: { detailTab: 'messages', selectedId: a.id } });
    s = host(s, { type: 'snapshot', exchanges: [a], rules: [], status });
    expect(s.detailTab).toBe('response');
    const w = ws();
    let t = reducer(initialState(), { type: 'restore', persisted: { detailTab: 'messages', selectedId: w.id } });
    t = host(t, { type: 'snapshot', exchanges: [w], rules: [], status });
    expect(t.detailTab).toBe('messages');
  });

  it('frame updates of the selected exchange keep the tab and selection', () => {
    const a = ws();
    let s = host(initialState(), { type: 'snapshot', exchanges: [a], rules: [], status });
    s = reducer(s, { type: 'select', id: a.id });
    s = host(s, { type: 'exchange', exchange: { ...a, frames: [...a.frames!, { dir: 'send', at: 2, kind: 'text', text: 'yo', size: 2 }] } });
    expect(s.detailTab).toBe('messages');
    expect(s.selectedId).toBe(a.id);
    expect(s.exchanges[0].frames).toHaveLength(2);
  });
});

describe('session warnings', () => {
  const withWarnings = (ws: SessionWarning[]): Status => ({ ...status, warnings: ws });

  it('dismiss hides one warning by id (idempotent) and persists', () => {
    let s = host(initialState(), { type: 'snapshot', exchanges: [], rules: [], status: withWarnings([warn('a'), warn('b')]) });
    expect(visibleWarnings(s).map((w) => w.id)).toEqual(['a', 'b']);
    s = reducer(s, { type: 'dismissWarning', id: 'a' });
    expect(visibleWarnings(s).map((w) => w.id)).toEqual(['b']);
    expect(reducer(s, { type: 'dismissWarning', id: 'a' })).toBe(s);
    expect(toPersisted(s).dismissedWarnings).toEqual(['a']);
  });

  it('dismissed ids are pruned when the host stops reporting them (status and snapshot)', () => {
    let s = host(initialState(), { type: 'status', status: withWarnings([warn('a'), warn('b')]) });
    s = reducer(s, { type: 'dismissWarning', id: 'a' });
    s = reducer(s, { type: 'dismissWarning', id: 'b' });
    s = host(s, { type: 'status', status: withWarnings([warn('b'), warn('c')]) });
    expect(s.dismissedWarnings).toEqual(['b']);
    expect(visibleWarnings(s).map((w) => w.id)).toEqual(['c']);
    s = host(s, { type: 'snapshot', exchanges: [], rules: [], status });
    expect(s.dismissedWarnings).toEqual([]);
    expect(visibleWarnings(s)).toEqual([]);
  });

  it('restore keeps dismissed ids (strings only) until the snapshot says which are live', () => {
    let s = reducer(initialState(), { type: 'restore', persisted: { dismissedWarnings: ['a', 3 as unknown as string, 'gone'] } });
    expect(s.dismissedWarnings).toEqual(['a', 'gone']);
    s = host(s, { type: 'snapshot', exchanges: [], rules: [], status: withWarnings([warn('a'), warn('b')]) });
    expect(s.dismissedWarnings).toEqual(['a']);
    expect(visibleWarnings(s).map((w) => w.id)).toEqual(['b']);
    // an older persisted state without the field
    expect(reducer(initialState(), { type: 'restore', persisted: {} }).dismissedWarnings).toEqual([]);
  });
});

describe('GraphQL-aware rule preview', () => {
  const a = gql('getUser');
  const b = gql('addToCart');
  const c = ex({ method: 'POST', url: 'https://api.example.com/graphql' }); // not detected as GraphQL
  const n = ex({ url: 'https://api.example.com/graphql', method: 'POST', graphql: { operationName: 'getUser' }, captured: 'vm-profile' });
  const list = [a, b, c, n];

  it('graphqlOperation narrows by the detected operation (exact, case-sensitive)', () => {
    const m = { url: 'https://api.example.com/graphql' };
    expect(countMatches(m, list)).toBe(3); // the native one never matches
    expect(countMatches({ ...m, graphqlOperation: 'getUser' }, list)).toBe(1);
    expect(countMatches({ ...m, graphqlOperation: 'getuser' }, list)).toBe(0);
    expect(countMatches({ ...m, graphqlOperation: ' addToCart ' }, list)).toBe(1);
    expect(compileExchangeMatcher({ ...m, method: 'GET' })(a)).toBe(false);
  });

  it('first enabled match wins; native exchanges are never handled by rules', () => {
    const rules = [
      rule({ match: { url: '*graphql', graphqlOperation: 'addToCart' } }),
      rule({ match: { url: '*graphql' } }),
    ];
    expect(winningRuleIndex(rules, a)).toBe(1);
    expect(winningRuleIndex(rules, b)).toBe(0);
    expect(winningRuleIndex(rules, n)).toBe(-1);
    expect(ruleStats(rules, list)).toEqual([{ matches: 1, wins: 1 }, { matches: 3, wins: 2 }]);
  });

  it('labels show the operation', () => {
    expect(matcherLabel({ method: 'post', url: '*graphql', graphqlOperation: 'getUser' })).toBe('POST *graphql · op getUser');
    expect(ruleLabel(rule({ match: { url: '*graphql', graphqlOperation: 'getUser' } }))).toBe('*graphql · op getUser');
  });
});

describe('rule form: graphqlOperation and the cors action', () => {
  it('round-trips graphqlOperation', () => {
    const r = rule({ match: { method: 'POST', url: '*graphql', graphqlOperation: 'getUser' }, action: { kind: 'block', mode: 'reset' } });
    const f = ruleToForm(r);
    expect(f.graphqlOperation).toBe('getUser');
    expect(formToRule(f).match).toEqual({ method: 'POST', url: '*graphql', graphqlOperation: 'getUser' });
    expect(formToRule({ ...f, graphqlOperation: '  ' }).match).toEqual({ method: 'POST', url: '*graphql' });
  });

  it('validates the operation name', () => {
    const f = { ...ruleToForm(), url: '*graphql' };
    expect(validateRuleForm({ ...f, graphqlOperation: 'get User' }).errors.graphqlOperation).toMatch(/operation name/);
    expect(validateRuleForm({ ...f, graphqlOperation: '_getUser2' }).errors.graphqlOperation).toBeUndefined();
  });

  it('round-trips the cors action', () => {
    const r = rule({ action: { kind: 'cors', allowOrigin: 'http://localhost:5000', allowCredentials: true } });
    const f = ruleToForm(r);
    expect(f.kind).toBe('cors');
    expect(f.corsOrigin).toBe('http://localhost:5000');
    expect(f.corsCredentials).toBe(true);
    expect(formToRule(f).action).toEqual({ kind: 'cors', allowOrigin: 'http://localhost:5000', allowCredentials: true });
    expect(formToRule({ ...f, corsOrigin: '', corsCredentials: false }).action).toEqual({ kind: 'cors' });
  });

  it('rejects * with credentials and malformed origins', () => {
    const f = { ...ruleToForm(), url: '*', kind: 'cors' as const };
    expect(validateRuleForm({ ...f, corsOrigin: '*', corsCredentials: true }).errors.cors).toMatch(/"\*" with credentials/);
    expect(validateRuleForm({ ...f, corsOrigin: '*' }).errors.cors).toBeUndefined();
    expect(validateRuleForm({ ...f, corsOrigin: 'http://localhost:5000/app' }).errors.cors).toMatch(/no path/);
    expect(validateRuleForm({ ...f, corsOrigin: 'localhost' }).errors.cors).toMatch(/scheme/);
    expect(validateRuleForm({ ...f, corsOrigin: 'https://app.example.com:8443', corsCredentials: true }).errors.cors).toBeUndefined();
    // only for the cors action
    expect(validateRuleForm({ ...f, kind: 'breakpoint', corsOrigin: 'nope' }).errors.cors).toBeUndefined();
  });

  it('describes cors rules', () => {
    expect(describeAction({ kind: 'cors' })).toBe('CORS (dev only): allow localhost origins');
    expect(describeCors({ allowOrigin: 'http://localhost:5000', allowCredentials: true })).toBe('CORS (dev only): allow http://localhost:5000 + credentials');
  });
});

describe('coverage helpers', () => {
  it('GraphQL labels', () => {
    expect(gqlLabel(ex())).toBeUndefined();
    expect(gqlLabel(gql('getUser'))).toBe('GQL getUser');
    expect(gqlLabel(ex({ graphql: {} }))).toBe('GQL');
    expect(gqlTitle(gql('getUser'))).toBe('GraphQL query getUser');
    expect(gqlTitle(ex({ graphql: { operationType: 'mutation', persisted: true } }))).toBe('GraphQL mutation (anonymous) (persisted query: hash only, no query text)');
  });

  it('native', () => {
    expect(isNative(ex({ captured: 'vm-profile' }))).toBe(true);
    expect(isNative(ex())).toBe(false);
  });

  it('cors statuses', () => {
    const problem = ex({ cors: { problem: 'no ACAO' } });
    const pre = ex({ cors: { preflight: true } });
    const patched = ex({ cors: { patched: true } });
    expect(corsMatches(problem, 'problem')).toBe(true);
    expect(corsMatches(problem, 'ok')).toBe(false);
    expect(corsMatches(pre, 'ok')).toBe(true);
    expect(corsMatches(pre, 'preflight')).toBe(true);
    expect(corsMatches(patched, 'patched')).toBe(true);
    expect(corsMatches(ex(), 'ok')).toBe(false); // no diagnosis at all (not a browser request)
  });

  it('origin and route', () => {
    expect(requestOrigin(ex({ requestHeaders: { Origin: 'http://localhost:5000' } }))).toBe('http://localhost:5000');
    expect(requestOrigin(ex({ requestHeaders: { origin: 'null' } }))).toBeUndefined();
    expect(routeGlob('https://api.example.com/v1/cart?x=1#h')).toBe('https://api.example.com/v1/cart*');
    expect(routeGlob('not a url?x')).toBe('not a url*');
  });

  it('corsRuleFor: any method on the route, names the Origin explicitly, credentials only when asked (REVIEW-5 #3)', () => {
    const e = ex({ url: 'https://api.example.com/v1/cart?x=1', requestHeaders: { origin: 'http://localhost:5000', cookie: 's=1' }, cors: { problem: '"*" with credentials' } });
    expect(corsRuleFor(e, {}, 'r1')).toEqual({
      id: 'r1', enabled: true, name: 'CORS (dev only) /v1/cart for http://localhost:5000',
      match: { url: 'https://api.example.com/v1/cart*' }, action: { kind: 'cors', allowOrigin: 'http://localhost:5000' },
    });
    const withCreds = corsRuleFor(e, { credentials: true }, 'r2')!;
    expect(withCreds.action).toEqual({ kind: 'cors', allowOrigin: 'http://localhost:5000', allowCredentials: true });
    expect(withCreds.name).toBe('CORS (dev only) /v1/cart for http://localhost:5000 + credentials');
    expect(corsRuleFor({ ...e, requestHeaders: {} })).toBeUndefined(); // nothing to name: no rule
    expect(corsRuleFor({ ...e, requestHeaders: { origin: 'null' } })).toBeUndefined();
    expect(corsRuleFor(e)!.id).toMatch(/^rule/);
    expect(sentCookies(e)).toBe(true);
    expect(sentCookies(ex())).toBe(false);
  });

  it('corsActionError', () => {
    expect(corsActionError('', true)).toBeUndefined();
    expect(corsActionError('*', false)).toBeUndefined();
    expect(corsActionError('*', true)).toBeDefined();
  });
});

describe('filter tokens: kind, op, cors, captured', () => {
  const plain = ex({ id: 'plain' });
  const sock = ws({ id: 'ws' });
  const sse = ws({ id: 'sse', kind: 'sse' });
  const g1 = gql('getUser', { id: 'g1' });
  const g2 = gql('getUserList', { id: 'g2' });
  const g3 = gql('addToCart', { id: 'g3' });
  const bad = ex({ id: 'bad', cors: { problem: 'no ACAO' } });
  const pre = ex({ id: 'pre', method: 'OPTIONS', cors: { preflight: true, patched: true } });
  const nat = ex({ id: 'nat', captured: 'vm-profile' });
  const all = [plain, sock, sse, g1, g2, g3, bad, pre, nat];
  const ids = (text: string) => filterExchanges(all, { ...EMPTY_FILTERS, text }).map((e) => e.id);

  it('kind:', () => {
    expect(ids('kind:ws')).toEqual(['ws']);
    expect(ids('kind:websocket')).toEqual(['ws']);
    expect(ids('kind:sse')).toEqual(['sse']);
    expect(ids('kind:ws,sse')).toEqual(['ws', 'sse']);
    expect(ids('-kind:http')).toEqual(['ws', 'sse']);
    expect(ids('kind:http').length).toBe(7);
    expect(parseFilter('kind:grpc').errors[0]).toMatch(/ws, sse, http or tunnel/);
  });

  it('op: (case-insensitive prefix, comma, negation)', () => {
    expect(ids('op:getUser')).toEqual(['g1', 'g2']);
    expect(ids('op:getuserl')).toEqual(['g2']);
    expect(ids('op:add,getUserL')).toEqual(['g2', 'g3']);
    expect(ids('operation:add')).toEqual(['g3']);
    expect(ids('gql:get -op:getUserList')).toEqual(['g1']);
    expect(ids('-op:get')).not.toContain('g1');
    expect(ids('-op:get')).toContain('plain');
  });

  it('cors:', () => {
    expect(ids('cors:problem')).toEqual(['bad']);
    expect(ids('cors:pre')).toEqual(['pre']);
    expect(ids('cors:ok')).toEqual(['pre']);
    expect(ids('cors:patched')).toEqual(['pre']);
    expect(ids('cors:problem,preflight')).toEqual(['bad', 'pre']);
    expect(ids('-cors:problem')).not.toContain('bad');
    expect(parseFilter('cors:maybe').errors[0]).toMatch(/problem, ok, preflight/);
  });

  it('captured:', () => {
    expect(ids('captured:native')).toEqual(['nat']);
    expect(ids('captured:vm-profile')).toEqual(['nat']);
    expect(ids('-captured:native')).not.toContain('nat');
    expect(ids('captured:proxy')).toHaveLength(8);
    expect(parseFilter('captured:wifi').errors[0]).toMatch(/native or proxy/);
  });

  it('combines with the rest of the language', () => {
    expect(ids('m:POST op:get graphql')).toEqual(['g1', 'g2']);
    expect(ids('kind:ws socket')).toEqual(['ws']);
  });
});

describe('browser-internal traffic (CONTRACTS §11.3)', () => {
  const app = ex({ id: 'app' });
  const b1 = ex({ id: 'b1', url: 'https://update.googleapis.com/x', browserInternal: true });
  const b2 = ex({ id: 'b2', url: 'https://optimizationguide-pa.googleapis.com/y', browserInternal: true, status: 404 });
  const all = [app, b1, b2];
  const ids = (f: Partial<typeof EMPTY_FILTERS>) => filterExchanges(all, { ...EMPTY_FILTERS, ...f }).map((e) => e.id);

  it('hidden by default, shown with the toggle; hidden count', () => {
    expect(ids({})).toEqual(['app']);
    expect(hiddenBrowserCount(all, EMPTY_FILTERS)).toBe(2);
    expect(ids({ showBrowser: true })).toEqual(['app', 'b1', 'b2']);
    expect(hiddenBrowserCount(all, { ...EMPTY_FILTERS, showBrowser: true })).toBe(0);
    const plain = [app];
    expect(filterExchanges(plain, EMPTY_FILTERS)).toBe(plain); // no copy when nothing is hidden
  });

  it('browser: token selects explicitly (and overrides hiding)', () => {
    expect(ids({ text: 'browser:internal' })).toEqual(['b1', 'b2']);
    expect(ids({ text: 'browser:in s:404' })).toEqual(['b2']);
    expect(ids({ text: 'browser:app' })).toEqual(['app']);
    expect(ids({ text: '-browser:internal', showBrowser: true })).toEqual(['app']);
    expect(hiddenBrowserCount(all, { ...EMPTY_FILTERS, text: 'browser:internal' })).toBe(0);
    expect(parseFilter('browser:chrome').errors[0]).toMatch(/internal or app/);
    expect(ids({ text: 'browser:chrome' })).toEqual(['app']); // invalid token: ignored, still hidden
    expect(ids({ text: 'googleapis' })).toEqual([]);
  });

  it('the toggle persists, survives Clear filters, and showPaused reveals a paused browser exchange', () => {
    let s = reducer(initialState(), { type: 'setFilters', patch: { showBrowser: true, text: 'x' } });
    expect(toPersisted(s).filters.showBrowser).toBe(true);
    s = reducer(s, { type: 'clearFilters' });
    expect(s.filters).toEqual({ ...EMPTY_FILTERS, showBrowser: true });
    expect(reducer(initialState(), { type: 'restore', persisted: { filters: { text: '' } as never } }).filters.showBrowser).toBe(false);
    const p = { ...b1, state: 'paused-request' as const };
    let t = host(initialState(), { type: 'snapshot', exchanges: [app, p], rules: [], status });
    t = reducer(t, { type: 'select', id: app.id });
    t = reducer(t, { type: 'showPaused' });
    expect(t.selectedId).toBe(p.id);
    expect(t.filters.showBrowser).toBe(true);
  });
});
