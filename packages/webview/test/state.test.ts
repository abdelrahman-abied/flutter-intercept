import { describe, expect, it } from 'vitest';
import type { HostMsg } from '../src/protocol';
import {
  EMPTY_FILTERS, MAX_HOST_ERRORS, NEW_RULE, clientGaveUp, countMatches, isAgentRule, ruleDisplayName, computeRequestEdit, computeResponseEdit, currentDraft, deleteRule,
  draftFromExchange, filterExchanges, formToRule, headersChanged, initialState, moveRule, pausedCount,
  reducer, rowsToRecord, ruleStats, ruleToForm, toPersisted, toggleRule, upsertRule, validateDraft,
  validateRuleForm, winningRuleIndex,
  type Action, type RequestDraft, type ResponseDraft, type State,
} from '../src/state';
import { ex, pausedRequest, pausedResponse, rule, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });
const run = (s: State, ...actions: Action[]) => actions.reduce(reducer, s);
const snap = (exchanges = [ex(), ex()], rules = [rule()]) =>
  host(initialState(), { type: 'snapshot', exchanges, rules, status });

describe('host messages', () => {
  it('snapshot replaces exchanges, rules, status and marks connected', () => {
    const s0 = initialState();
    expect(s0.connected).toBe(false);
    const a = ex();
    const s = host(s0, { type: 'snapshot', exchanges: [a], rules: [rule({ id: 'x' })], status });
    expect(s.connected).toBe(true);
    expect(s.exchanges).toEqual([a]);
    expect(s.rules.map((r) => r.id)).toEqual(['x']);
    expect(s.status).toEqual(status);
    const s2 = host(s, { type: 'snapshot', exchanges: [], rules: [], status: { ...status, sessions: 0 } });
    expect(s2.exchanges).toEqual([]);
    expect(s2.status.sessions).toBe(0);
  });

  it('snapshot keeps the selection when the exchange still exists, drops it otherwise', () => {
    const a = ex();
    const s = run(snap([a, ex()]), { type: 'select', id: a.id });
    expect(host(s, { type: 'snapshot', exchanges: [a], rules: [], status }).selectedId).toBe(a.id);
    expect(host(s, { type: 'snapshot', exchanges: [ex()], rules: [], status }).selectedId).toBeUndefined();
  });

  it('snapshot auto-selects a paused exchange and opens the paused phase tab', () => {
    const p = pausedResponse();
    const s = host(initialState(), { type: 'snapshot', exchanges: [ex(), p], rules: [], status });
    expect(s.selectedId).toBe(p.id);
    expect(s.detailTab).toBe('response');
  });

  it('snapshot and exchange never cap on their own (the proxy reports evictions)', () => {
    const many = Array.from({ length: 1500 }, () => ex());
    let s = host(initialState(), { type: 'snapshot', exchanges: many, rules: [], status });
    expect(s.exchanges.length).toBe(1500);
    s = host(s, { type: 'exchange', exchange: ex() });
    expect(s.exchanges.length).toBe(1501);
  });

  it('exchange appends new and replaces existing in place', () => {
    const a = ex({ state: 'pending', status: undefined });
    let s = snap([a]);
    const b = ex();
    s = host(s, { type: 'exchange', exchange: b });
    expect(s.exchanges.map((e) => e.id)).toEqual([a.id, b.id]);
    s = host(s, { type: 'exchange', exchange: { ...a, state: 'completed', status: 204 } });
    expect(s.exchanges.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(s.exchanges[0].status).toBe(204);
  });

  it('removed drops the ids and everything keyed by them', () => {
    const [a, b] = [ex(), pausedRequest()];
    const c = ex();
    let s = run(snap([a, b, c]), { type: 'patchDraft', id: b.id, patch: { body: '{}' } }, { type: 'resolving', id: b.id });
    expect(s.selectedId).toBe(b.id);
    s = host(s, { type: 'removed', ids: [a.id, b.id, 'unknown'] });
    expect(s.exchanges.map((e) => e.id)).toEqual([c.id]);
    expect(s.drafts).toEqual({});
    expect(s.resolving).toEqual({});
    expect(s.selectedId).toBeUndefined();
    expect(host(s, { type: 'removed', ids: ['nope'] })).toBe(s);
  });

  it('error is collected for a non-blocking banner and unlocks resolving editors', () => {
    const p = pausedResponse();
    let s = run(snap([p]), { type: 'patchDraft', id: p.id, patch: { status: '999' } }, { type: 'resolving', id: p.id });
    s = host(s, { type: 'error', message: 'Resume rejected: invalid status' });
    expect(s.hostErrors.map((e) => e.message)).toEqual(['Resume rejected: invalid status']);
    expect(s.resolving).toEqual({});
    expect(s.drafts[p.id]).toMatchObject({ status: '999' }); // the user's edit survives the rejection
    expect(s.exchanges).toEqual([p]); // nothing else changes
    for (let i = 0; i < 10; i++) s = host(s, { type: 'error', message: `e${i}` });
    expect(s.hostErrors.length).toBe(MAX_HOST_ERRORS);
    expect(s.hostErrors.at(-1)!.message).toBe('e9');
    expect(run(s, { type: 'dismissErrors' }).hostErrors).toEqual([]);
  });

  it('a paused exchange that turns into error is flagged as "client gave up"', () => {
    const p = pausedRequest({ pausedAt: 1, pauseDeadline: 300_001 });
    let s = snap([p]);
    const gone = { ...p, state: 'error' as const, pausedAt: undefined, pauseDeadline: undefined, error: 'socket closed' };
    s = host(s, { type: 'exchange', exchange: gone });
    expect(clientGaveUp(s, gone)).toBe(true);
    expect(s.drafts[p.id]).toBeUndefined();
    // recognised from the proxy's message too (e.g. after a reload, when the paused state was never seen)
    const fromSnapshot = ex({ state: 'error', error: 'Client closed the connection while the response was paused (client timeout?)' });
    expect(clientGaveUp(initialState(), fromSnapshot)).toBe(true);
    expect(clientGaveUp(initialState(), ex({ state: 'error', error: 'ECONNREFUSED' }))).toBe(false);
    expect(host(s, { type: 'removed', ids: [p.id] }).gaveUp).toEqual({});
  });

  it('a newly paused exchange is selected when nothing else is', () => {
    let s = snap([ex()]);
    expect(s.selectedId).toBeUndefined();
    const p = pausedResponse();
    s = host(s, { type: 'exchange', exchange: p });
    expect(s.selectedId).toBe(p.id);
    expect(s.detailTab).toBe('response');
    // …but never steals an existing selection
    const s2 = host(s, { type: 'exchange', exchange: pausedRequest() });
    expect(s2.selectedId).toBe(p.id);
  });

  it('selected exchange moving to paused-response switches to the response tab', () => {
    const p = pausedRequest();
    let s = snap([p]);
    expect(s.detailTab).toBe('request');
    s = host(s, { type: 'exchange', exchange: { ...p, state: 'paused-response', status: 200 } });
    expect(s.detailTab).toBe('response');
  });

  it('drafts and resolving flags are dropped when the exchange leaves the paused phase', () => {
    const p = pausedRequest();
    let s = snap([p]);
    const d = draftFromExchange(p) as RequestDraft;
    s = run(s, { type: 'setDraft', id: p.id, draft: { ...d, body: '{}' } });
    expect(s.drafts[p.id]).toBeDefined();
    // same phase update keeps the draft
    s = host(s, { type: 'exchange', exchange: { ...p } });
    expect(s.drafts[p.id]).toBeDefined();
    s = run(s, { type: 'resolving', id: p.id });
    expect(s.resolving[p.id]).toBe(true);
    expect(s.drafts[p.id]).toBeDefined(); // kept until the host confirms (a rejected edit stays fixable)
    s = host(s, { type: 'exchange', exchange: { ...p, state: 'pending' } });
    expect(s.drafts[p.id]).toBeUndefined();
    expect(s.resolving[p.id]).toBeUndefined();
  });

  it('rules replaces the list and closes the editor of a deleted rule', () => {
    const r1 = rule();
    let s = run(snap([], [r1]), { type: 'editRule', id: r1.id });
    expect(s.view).toBe('rules');
    s = host(s, { type: 'rules', rules: [r1, rule()] });
    expect(s.rules.length).toBe(2);
    expect(s.editingRuleId).toBe(r1.id);
    s = host(s, { type: 'rules', rules: [] });
    expect(s.editingRuleId).toBeUndefined();
  });

  it('rules after createRuleFromExchange(mock) opens the new rule in the editor', () => {
    const r1 = rule();
    let s = run(snap([], [r1]), { type: 'awaitRule', kind: 'mock' });
    const created = rule({ id: 'new1', action: { kind: 'mock', status: 200, body: '{}' } });
    s = host(s, { type: 'rules', rules: [created, r1] });
    expect(s.awaitingRule).toBeUndefined();
    expect(s.view).toBe('rules');
    expect(s.editingRuleId).toBe('new1');
    expect(s.notice?.text).toMatch(/Created rule/);
  });

  it('rules after createRuleFromExchange(block) only shows a notice', () => {
    let s = run(snap([], []), { type: 'awaitRule', kind: 'block' });
    s = host(s, { type: 'rules', rules: [rule({ action: { kind: 'block', mode: 'reset' } })] });
    expect(s.view).toBe('traffic');
    expect(s.editingRuleId).toBeUndefined();
    expect(s.notice?.text).toMatch(/Block/);
  });

  it('status replaces status', () => {
    const s = host(snap(), { type: 'status', status: { ...status, interceptEnabled: false, sessions: 2 } });
    expect(s.status).toEqual({ ...status, interceptEnabled: false, sessions: 2 });
  });

  it('cleared empties exchanges, drafts and selection', () => {
    const p = pausedRequest();
    let s = run(snap([p, ex()]), { type: 'setDraft', id: p.id, draft: draftFromExchange(p)! });
    s = host(s, { type: 'cleared' });
    expect(s.exchanges).toEqual([]);
    expect(s.drafts).toEqual({});
    expect(s.selectedId).toBeUndefined();
  });

  it('applies a batch of messages in order', () => {
    const a = ex({ state: 'pending' });
    const s = host(initialState(),
      { type: 'snapshot', exchanges: [], rules: [], status },
      { type: 'exchange', exchange: a },
      { type: 'exchange', exchange: { ...a, state: 'completed' } },
      { type: 'cleared' },
      { type: 'exchange', exchange: ex() });
    expect(s.exchanges.length).toBe(1);
  });
});

describe('selection and navigation', () => {
  it('move next/prev/first/last walks the filtered list', () => {
    const [a, b, c] = [ex({ method: 'GET' }), ex({ method: 'POST' }), ex({ method: 'GET' })];
    let s = snap([a, b, c]);
    s = run(s, { type: 'move', to: 'next' });
    expect(s.selectedId).toBe(a.id);
    s = run(s, { type: 'move', to: 'next' }, { type: 'move', to: 'next' }, { type: 'move', to: 'next' });
    expect(s.selectedId).toBe(c.id); // clamps at the end
    s = run(s, { type: 'move', to: 'first' });
    expect(s.selectedId).toBe(a.id);
    s = run(s, { type: 'move', to: 'prev' });
    expect(s.selectedId).toBe(a.id);
    s = run(s, { type: 'move', to: 'last' });
    expect(s.selectedId).toBe(c.id);
    s = run(s, { type: 'setFilters', patch: { method: 'GET' } }, { type: 'move', to: 'prev' });
    expect(s.selectedId).toBe(a.id); // skips the hidden POST
  });

  it('showPaused cycles through paused exchanges and reveals hidden ones', () => {
    const p1 = pausedRequest();
    const p2 = pausedResponse();
    let s = run(snap([ex(), p1, p2]), { type: 'select', id: undefined }, { type: 'setFilters', patch: { method: 'DELETE' } });
    s = run(s, { type: 'showPaused' });
    expect(s.selectedId).toBe(p1.id);
    expect(s.filters).toEqual({ ...EMPTY_FILTERS, pausedOnly: true });
    s = run(s, { type: 'showPaused' });
    expect(s.selectedId).toBe(p2.id);
    expect(s.detailTab).toBe('response');
    s = run(s, { type: 'showPaused' });
    expect(s.selectedId).toBe(p1.id);
  });

  it('restore + toPersisted round-trip UI state', () => {
    const s = run(initialState(), { type: 'setFilters', patch: { text: 'cart' } }, { type: 'setView', view: 'rules' }, { type: 'setSplit', pct: 95 });
    const p = toPersisted(s);
    expect(p.splitPct).toBe(80); // clamped
    const r = reducer(initialState(), { type: 'restore', persisted: JSON.parse(JSON.stringify(p)) });
    expect(r.filters.text).toBe('cart');
    expect(r.view).toBe('rules');
  });
});

describe('filters', () => {
  const list = [
    ex({ method: 'GET', url: 'https://api.example.com/users/1', status: 200 }),
    ex({ method: 'POST', url: 'https://api.example.com/cart', status: 201 }),
    ex({ method: 'GET', url: 'https://cdn.example.com/a.png', status: 304 }),
    ex({ method: 'GET', url: 'https://api.example.com/me', status: 401 }),
    ex({ method: 'GET', url: 'https://api.example.com/feed', status: 503 }),
    ex({ method: 'GET', url: 'https://t.example.net/x', state: 'error', status: undefined, error: 'refused' }),
    ex({ method: 'GET', url: 'https://ads.example.org/p', state: 'blocked', status: undefined }),
    pausedRequest({ url: 'https://api.example.com/cart/items' }),
  ];
  const f = (patch: Partial<typeof EMPTY_FILTERS>) => filterExchanges(list, { ...EMPTY_FILTERS, ...patch }).map((e) => e.url);

  it('no filters returns the same array', () => {
    expect(filterExchanges(list, EMPTY_FILTERS)).toBe(list);
  });
  it('text matches URL substrings case-insensitively, all terms required, -term excludes', () => {
    expect(f({ text: 'CART' })).toEqual(['https://api.example.com/cart', 'https://api.example.com/cart/items']);
    expect(f({ text: 'api cart items' })).toEqual(['https://api.example.com/cart/items']);
    expect(f({ text: 'cart -items' })).toEqual(['https://api.example.com/cart']);
  });
  it('method filter is exact and case-insensitive', () => {
    expect(f({ method: 'post' })).toEqual(['https://api.example.com/cart', 'https://api.example.com/cart/items']);
  });
  it('status classes are OR-ed; error covers network errors and resets', () => {
    expect(f({ statusClasses: ['2xx'] })).toEqual(['https://api.example.com/users/1', 'https://api.example.com/cart']);
    expect(f({ statusClasses: ['3xx', '5xx'] })).toEqual(['https://cdn.example.com/a.png', 'https://api.example.com/feed']);
    expect(f({ statusClasses: ['error'] })).toEqual(['https://t.example.net/x', 'https://ads.example.org/p']);
    expect(f({ statusClasses: ['4xx'] })).toEqual(['https://api.example.com/me']);
  });
  it('paused only', () => {
    expect(f({ pausedOnly: true })).toEqual(['https://api.example.com/cart/items']);
  });
  it('filters combine with AND', () => {
    expect(f({ text: 'api', method: 'GET', statusClasses: ['2xx', '4xx'] })).toEqual(['https://api.example.com/users/1', 'https://api.example.com/me']);
  });
  it('toggleStatusClass adds and removes', () => {
    let s = run(initialState(), { type: 'toggleStatusClass', cls: '4xx' }, { type: 'toggleStatusClass', cls: '5xx' });
    expect(s.filters.statusClasses).toEqual(['4xx', '5xx']);
    s = run(s, { type: 'toggleStatusClass', cls: '4xx' });
    expect(s.filters.statusClasses).toEqual(['5xx']);
    expect(run(s, { type: 'clearFilters' }).filters).toEqual(EMPTY_FILTERS);
  });
  it('pausedCount', () => {
    expect(pausedCount(list)).toBe(1);
  });
});

describe('edit diff (only changed fields)', () => {
  it('an untouched request draft produces no edit', () => {
    const p = pausedRequest();
    expect(computeRequestEdit(p, draftFromExchange(p) as RequestDraft)).toBeUndefined();
  });
  it('only the body when only the body changed', () => {
    const p = pausedRequest();
    const d = draftFromExchange(p) as RequestDraft;
    expect(computeRequestEdit(p, { ...d, body: '{"qty":5}' })).toEqual({ body: '{"qty":5}' });
  });
  it('method is compared case-insensitively and sent upper-case', () => {
    const p = pausedRequest();
    const d = draftFromExchange(p) as RequestDraft;
    expect(computeRequestEdit(p, { ...d, method: ' post ' })).toBeUndefined();
    expect(computeRequestEdit(p, { ...d, method: 'put' })).toEqual({ method: 'PUT' });
  });
  it('url change is trimmed', () => {
    const p = pausedRequest();
    const d = draftFromExchange(p) as RequestDraft;
    expect(computeRequestEdit(p, { ...d, url: ' https://staging.example.com/cart ' })).toEqual({ url: 'https://staging.example.com/cart' });
  });
  it('headers are sent as the complete new set when any header changed', () => {
    const p = pausedRequest();
    const d = draftFromExchange(p) as RequestDraft;
    const headers = d.headers.filter((h) => h.name !== 'authorization').concat({ name: 'x-debug', value: '1' });
    expect(computeRequestEdit(p, { ...d, headers })).toEqual({ headers: { 'content-type': 'application/json', 'x-debug': '1' } });
  });
  it('header order and name case are not changes; blank rows are ignored', () => {
    const p = pausedRequest();
    const d = draftFromExchange(p) as RequestDraft;
    const headers = [...d.headers].reverse().map((h) => ({ ...h, name: h.name.toUpperCase() })).concat({ name: ' ', value: '' });
    expect(computeRequestEdit(p, { ...d, headers })).toBeUndefined();
  });
  it('binary or truncated bodies are never sent', () => {
    const bin = pausedRequest({ requestBody: { text: 'AAEC', encoding: 'base64' } });
    const d = draftFromExchange(bin) as RequestDraft;
    expect(d.body).toBe('');
    expect(computeRequestEdit(bin, { ...d, body: 'hello' })).toBeUndefined();
    const trunc = pausedRequest({ requestBody: { text: '{"a":', encoding: 'utf8', truncated: true } });
    expect(computeRequestEdit(trunc, { ...(draftFromExchange(trunc) as RequestDraft), body: '{}' })).toBeUndefined();
  });
  it('a request without a body gets one only when text is entered', () => {
    const p = pausedRequest({ requestBody: undefined });
    const d = draftFromExchange(p) as RequestDraft;
    expect(computeRequestEdit(p, d)).toBeUndefined();
    expect(computeRequestEdit(p, { ...d, body: 'x' })).toEqual({ body: 'x' });
  });
  it('response: status as number, untouched multi-value headers are not sent', () => {
    const p = pausedResponse();
    const d = draftFromExchange(p) as ResponseDraft;
    expect(d.headers.filter((h) => h.name === 'set-cookie').length).toBe(2);
    expect(computeResponseEdit(p, d)).toBeUndefined();
    expect(computeResponseEdit(p, { ...d, status: '404' })).toEqual({ status: 404 });
    expect(computeResponseEdit(p, { ...d, status: '404', body: '{}' })).toEqual({ status: 404, body: '{}' });
  });
  it('response: the full header set is sent, repeated headers stay arrays (never joined)', () => {
    const p = pausedResponse();
    const d = draftFromExchange(p) as ResponseDraft;
    const headers = d.headers.concat({ name: 'x-new', value: 'y' });
    expect(computeResponseEdit(p, { ...d, headers })).toEqual({
      headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'], 'x-new': 'y' },
    });
    // removing one cookie row is a change; the remaining one is a plain string
    const fewer = d.headers.filter((h) => h.value !== 'b=2');
    expect(computeResponseEdit(p, { ...d, headers: fewer })!.headers).toEqual({ 'content-type': 'application/json', 'set-cookie': 'a=1' });
  });
  it('request: adding a second value for an existing header makes it an array', () => {
    const p = pausedRequest();
    const d = draftFromExchange(p) as RequestDraft;
    const edit = computeRequestEdit(p, { ...d, headers: d.headers.concat({ name: 'Authorization', value: 'Bearer y' }) });
    expect(edit).toEqual({ headers: { 'content-type': 'application/json', authorization: ['Bearer x', 'Bearer y'] } });
    expect(edit).not.toHaveProperty('body');
  });
  it('rowsToRecord groups duplicate names case-insensitively in row order; headersChanged compares per value', () => {
    expect(rowsToRecord([{ name: 'A', value: '1' }, { name: 'a', value: '2' }, { name: '', value: 'x' }, { name: 'a', value: '3' }]))
      .toEqual({ A: ['1', '2', '3'] });
    expect(headersChanged({ A: ['1', '2'] }, [{ name: 'a', value: '1' }, { name: 'A', value: '2' }])).toBe(false);
    expect(headersChanged({ A: ['1', '2'] }, [{ name: 'a', value: '1, 2' }])).toBe(true);
    expect(headersChanged({ A: '1, 2' }, [{ name: 'a', value: '1, 2' }])).toBe(false);
    expect(headersChanged(undefined, [])).toBe(false);
  });
  it('patchDraft composes back-to-back edits on the current draft', () => {
    const p = pausedResponse();
    const s = run(snap([p]), { type: 'patchDraft', id: p.id, patch: { body: '{}' } }, { type: 'patchDraft', id: p.id, patch: { status: '500' } });
    expect(computeResponseEdit(p, s.drafts[p.id] as ResponseDraft)).toEqual({ status: 500, body: '{}' });
    expect(run(s, { type: 'patchDraft', id: 'missing', patch: { body: 'x' } })).toBe(s);
  });
  it('currentDraft ignores a stale draft from another phase', () => {
    const p = pausedRequest();
    const s = run(snap([p]), { type: 'setDraft', id: p.id, draft: { ...(draftFromExchange(p) as RequestDraft), body: 'x' } });
    expect(currentDraft(s, p)!.body).toBe('x');
    const asResponse = { ...p, state: 'paused-response' as const, status: 200, responseBody: { text: 'r', encoding: 'utf8' as const } };
    expect(currentDraft(s, asResponse)).toMatchObject({ kind: 'response', body: 'r' });
  });
  it('validateDraft: hard errors and JSON checks', () => {
    const p = pausedRequest();
    const d = draftFromExchange(p) as RequestDraft;
    expect(validateDraft(d)).toEqual({ errors: [], json: { ok: true } });
    expect(validateDraft({ ...d, url: 'not a url', method: 'GE T' }).errors).toHaveLength(2);
    const bad = validateDraft({ ...d, body: '{"qty": 1,}' });
    expect(bad.json).toMatchObject({ ok: false, line: 1, column: 11 });
    // non-JSON content type → no JSON validation
    expect(validateDraft({ ...d, headers: [{ name: 'content-type', value: 'text/plain' }], body: '{' }).json).toBeUndefined();
    const r = draftFromExchange(pausedResponse()) as ResponseDraft;
    expect(validateDraft({ ...r, status: '99' }).errors).toEqual(['Status must be an integer 100–599']);
  });
});

describe('rules', () => {
  const [a, b, c] = [rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'c' })];
  const ids = (rs: { id: string }[]) => rs.map((r) => r.id);

  it('moveRule reorders and ignores out-of-range moves', () => {
    expect(ids(moveRule([a, b, c], 2, 0))).toEqual(['c', 'a', 'b']);
    expect(ids(moveRule([a, b, c], 0, 1))).toEqual(['b', 'a', 'c']);
    const same = [a, b, c];
    expect(moveRule(same, 0, -1)).toBe(same);
    expect(moveRule(same, 2, 3)).toBe(same);
  });
  it('toggle / delete / upsert', () => {
    expect(toggleRule([a, b], 'b')[1].enabled).toBe(false);
    expect(ids(deleteRule([a, b, c], 'b'))).toEqual(['a', 'c']);
    expect(ids(upsertRule([a, b], c))).toEqual(['a', 'b', 'c']);
    expect(upsertRule([a, b], { ...b, name: 'B' })[1].name).toBe('B');
  });
  it('first enabled match wins (winningRuleIndex, ruleStats shadowing)', () => {
    const all = rule({ match: { url: '*' } });
    const cart = rule({ match: { method: 'post', url: 'https://api.example.com/cart*' } });
    const exs = [ex({ method: 'POST', url: 'https://api.example.com/cart' }), ex({ url: 'https://x.dev/' })];
    expect(winningRuleIndex([cart, all], exs[0])).toBe(0);
    expect(winningRuleIndex([all, cart], exs[0])).toBe(0);
    expect(winningRuleIndex([{ ...all, enabled: false }, cart], exs[1])).toBe(-1);
    expect(ruleStats([all, cart], exs)).toEqual([{ matches: 2, wins: 2 }, { matches: 1, wins: 0 }]);
    expect(ruleStats([cart, all], exs)).toEqual([{ matches: 1, wins: 1 }, { matches: 2, wins: 1 }]);
  });
  it('uses the proxy matcher semantics (method "*" = any, case-sensitive glob, bad regex never matches)', () => {
    const exs = [ex({ method: 'PATCH', url: 'https://api.example.com/Users/1' })];
    expect(countMatches({ method: '*', url: 'https://api.example.com/Users/*' }, exs)).toBe(1);
    expect(countMatches({ url: 'https://api.example.com/users/*' }, exs)).toBe(0);
    expect(countMatches({ url: '/users\\/\\d/i' }, exs)).toBe(1);
    expect(countMatches({ url: '/[/' }, exs)).toBe(0);
    expect(countMatches({ url: '' }, exs)).toBe(1);
  });
  it('setRules is optimistic, can carry an undo notice', () => {
    let s = snap([], [a, b]);
    s = run(s, { type: 'setRules', rules: [b], notice: 'Deleted', undoable: true });
    expect(ids(s.rules)).toEqual(['b']);
    expect(ids(s.notice!.undoRules!)).toEqual(['a', 'b']);
  });
  it('editRule NEW_RULE opens the rules view', () => {
    expect(run(initialState(), { type: 'editRule', id: NEW_RULE })).toMatchObject({ view: 'rules', editingRuleId: NEW_RULE });
  });
});

describe('rule form', () => {
  it('mock headers are flattened (contract: Record<string, string>)', () => {
    const f = { ...ruleToForm(), url: '*', mockHeaders: [{ name: 'set-cookie', value: 'a' }, { name: 'set-cookie', value: 'b' }] };
    expect(formToRule(f).action).toMatchObject({ headers: { 'set-cookie': 'a, b' } });
  });
  it('round-trips every action kind', () => {
    const rules = [
      rule({ name: 'm', match: { method: 'GET', url: 'https://a/*' }, action: { kind: 'mock', status: 418, headers: { 'content-type': 'application/json' }, body: '{"a":1}', delayMs: 250 } }),
      rule({ match: { url: '/\\/v1\\//i' }, action: { kind: 'block', mode: 'status', status: 451 } }),
      rule({ action: { kind: 'block', mode: 'reset' } }),
      rule({ enabled: false, action: { kind: 'breakpoint', phase: 'response' } }),
    ];
    for (const r of rules) expect(formToRule(ruleToForm(r))).toEqual(r);
  });
  it('new form defaults to a JSON mock', () => {
    const f = ruleToForm();
    expect(f.isNew).toBe(true);
    expect(f.kind).toBe('mock');
    expect(f.id).toMatch(/^rule_/);
  });
  it('validates url (glob vs regex), status, delay and JSON body', () => {
    const f = ruleToForm();
    expect(validateRuleForm(f).errors.url).toMatch(/Required/);
    expect(validateRuleForm({ ...f, url: '/[/' }).errors.url).toMatch(/Invalid regular expression/);
    expect(validateRuleForm({ ...f, url: '/users\\/\\d+/' }).urlHint).toMatch(/Regular expression/);
    expect(validateRuleForm({ ...f, url: 'api.example.com' }).urlHint).toMatch(/must equal the full URL/);
    const ok = { ...f, url: 'https://api.example.com/*', mockBody: '{"a":1}' };
    expect(validateRuleForm(ok).errors).toEqual({});
    expect(validateRuleForm({ ...ok, mockStatus: '99', mockDelayMs: 'soon' }).errors).toEqual({ mockStatus: '100–599', mockDelayMs: 'Milliseconds, whole number' });
    expect(validateRuleForm({ ...ok, mockBody: '{a:1}' }).json).toMatchObject({ ok: false, line: 1, column: 2 });
    expect(validateRuleForm({ ...ok, kind: 'block', blockMode: 'status', blockStatus: 'x' }).errors).toEqual({ blockStatus: '100–599' });
  });
});

describe('agent rules', () => {
  it('detects the "[agent] " prefix and strips it for display', () => {
    const a = rule({ name: '[agent] Products 500', match: { url: '*/products*' } });
    expect(isAgentRule(a)).toBe(true);
    expect(ruleDisplayName(a)).toBe('Products 500');
    expect(ruleDisplayName(rule({ name: '[agent] ', match: { method: 'get', url: '*/x' } }))).toBe('GET */x');
    expect(isAgentRule(rule({ name: 'agent rule' }))).toBe(false);
    expect(isAgentRule(rule({ name: '[Agent] x' }))).toBe(false);
    expect(isAgentRule(undefined)).toBe(false);
    expect(ruleDisplayName(rule({ name: 'Mine' }))).toBe('Mine');
  });
});
