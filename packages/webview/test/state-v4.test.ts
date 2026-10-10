// v0.4.0 reducer paths and helpers (CONTRACTS §10): contract results, contract: filter, mutate rules, JSON paths.
import { describe, expect, it } from 'vitest';
import type { ContractSummary, HostMsg } from '../src/protocol';
import {
  describeAction, describeMutateOp, describeMutateOps, EMPTY_FILTERS, filterExchanges, formToRule, initialState, jsonText,
  mutateRowError, reducer, ruleToForm, shortJson, validateRuleForm, type Action, type State,
} from '../src/state';
import { contractBadgeTitle, contractStatus, contractSummaryText, countBySeverity } from '../src/contract';
import { parseFilter } from '../src/filter';
import { isHostMsg } from '../src/host';
import { decodeJsonString, parseJsonLossless } from '../src/json';
import { checkPath, childPath, everyItemPath, formatPath, normalizePath, parsePath, type PathSegment } from '../src/jsonpath';
import { nodeText } from '../src/components/Viewers';
import { ex, rule, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });
const run = (s: State, ...actions: Action[]) => actions.reduce(reducer, s);
const snap = (exchanges = [ex(), ex()], rules = [rule()]) => host(initialState(), { type: 'snapshot', exchanges, rules, status });

type Violation = ContractSummary['violations'][number];
const viol = (over: Partial<Violation> = {}): Violation => ({
  path: '$.avatar_url', field: 'avatarUrl', expected: 'String', actual: 'null', severity: 'error',
  message: 'Null is not a subtype of String', ...over,
});
const result = (id: string, over: Partial<ContractSummary> = {}): ContractSummary => ({
  id, checked: true, model: 'User', via: 'retrofit', violations: [], ...over,
});

describe('contract results (host `contract`)', () => {
  it('stores results by id, later results replace earlier ones; an empty batch is a no-op', () => {
    const a = ex();
    const b = ex();
    let s = snap([a, b]);
    s = host(s, { type: 'contract', results: [result(a.id, { violations: [viol()] }), result(b.id)] });
    expect(Object.keys(s.contracts)).toEqual([a.id, b.id]);
    s = host(s, { type: 'contract', results: [result(a.id)] });
    expect(s.contracts[a.id].violations).toEqual([]);
    expect(host(s, { type: 'contract', results: [] })).toBe(s);
  });

  it('is dropped with the exchange (removed), on cleared, and pruned by a snapshot', () => {
    const a = ex();
    const b = ex();
    let s = host(snap([a, b]), { type: 'contract', results: [result(a.id), result(b.id)] });
    s = host(s, { type: 'removed', ids: [a.id] });
    expect(Object.keys(s.contracts)).toEqual([b.id]);
    s = host(s, { type: 'snapshot', exchanges: [a], rules: [], status });
    expect(s.contracts).toEqual({});
    s = host(s, { type: 'contract', results: [result(a.id)] });
    s = host(s, { type: 'cleared' });
    expect(s.contracts).toEqual({});
  });

  it('isHostMsg accepts contract', () => {
    expect(isHostMsg({ type: 'contract', results: [] })).toBe(true);
  });

  it('status, counts and texts', () => {
    expect(contractStatus(undefined)).toBe('unchecked');
    expect(contractStatus(result('x', { checked: false, via: 'none', reason: 'No model for this route' }))).toBe('unchecked');
    expect(contractStatus(result('x'))).toBe('ok');
    expect(contractStatus(result('x', { violations: [viol({ severity: 'warning' })] }))).toBe('warning');
    const mixed = result('x', { violations: [viol({ severity: 'warning', path: '$.role', message: 'unknown enum value' }), viol()] });
    expect(contractStatus(mixed)).toBe('error');
    expect(countBySeverity(mixed)).toEqual({ errors: 1, warnings: 1 });
    expect(contractSummaryText(mixed)).toBe('1 error, 1 warning');
    expect(contractSummaryText(result('x'))).toBe('matches the model');
    expect(contractSummaryText(result('x', { violations: [viol(), viol()] }))).toBe('2 errors');
    expect(contractBadgeTitle(mixed)).toBe('Model check (User): 1 error, 1 warning\n$.avatar_url: Null is not a subtype of String');
  });
});

describe('filter language: contract:', () => {
  const e1 = ex();
  const e2 = ex();
  const e3 = ex();
  const e4 = ex();
  const list = [e1, e2, e3, e4];
  const contracts = {
    [e1.id]: result(e1.id, { violations: [viol()] }),
    [e2.id]: result(e2.id, { violations: [viol({ severity: 'warning' })] }),
    [e3.id]: result(e3.id),
    // e4: no result
  };
  const f = (text: string) => filterExchanges(list, { ...EMPTY_FILTERS, text }, contracts).map((e) => e.id);

  it('matches error / warning / ok / unchecked, prefixes, alternatives and negation', () => {
    expect(f('contract:error')).toEqual([e1.id]);
    expect(f('contract:warn')).toEqual([e2.id]);
    expect(f('contract:ok')).toEqual([e3.id]);
    expect(f('contract:unchecked')).toEqual([e4.id]);
    expect(f('contract:error,warning')).toEqual([e1.id, e2.id]);
    expect(f('-contract:ok')).toEqual([e1.id, e2.id, e4.id]);
    expect(f('model:err')).toEqual([e1.id]);
  });

  it('without results everything is unchecked; a bad value is reported and ignored', () => {
    expect(filterExchanges(list, { ...EMPTY_FILTERS, text: 'contract:error' }).map((e) => e.id)).toEqual([]);
    expect(parseFilter('contract:bogus').errors[0]).toMatch(/contract:bogus — use error, warning, ok, unchecked/);
    expect(f('contract:bogus')).toEqual(list.map((e) => e.id));
  });

  it('the move action follows the contract-filtered list', () => {
    let s = host(snap(list), { type: 'contract', results: Object.values(contracts) });
    s = run(s, { type: 'setFilters', patch: { text: 'contract:error,ok' } }, { type: 'move', to: 'last' });
    expect(s.selectedId).toBe(e3.id);
  });
});

describe('mutate rules', () => {
  it('describes ops: null / delete / set, shortened values, +N more', () => {
    expect(describeMutateOp({ path: '$.a', op: 'null' })).toBe('$.a → null');
    expect(describeMutateOp({ path: '$.a', op: 'delete' })).toBe('$.a removed');
    expect(describeMutateOp({ path: '$.age', op: 'set', value: '42' })).toBe('$.age = "42"');
    expect(describeMutateOp({ path: '$.p', op: 'set', value: 1, valueJson: '1.0' })).toBe('$.p = 1.0');
    expect(describeMutateOp({ path: '$.p', op: 'set', valueJson: `"${'y'.repeat(60)}"` })).toHaveLength('$.p = '.length + 40);
    expect(shortJson('x'.repeat(100))).toHaveLength(40);
    expect(shortJson('x'.repeat(100)).endsWith('…')).toBe(true);
    expect(describeMutateOps([])).toBe('no changes');
    expect(describeAction({ kind: 'mutate', ops: [{ path: '$.a', op: 'null' }, { path: '$.b', op: 'delete' }, { path: '$.c', op: 'set', value: 1 }] }))
      .toBe('Mutate: $.a → null, $.b removed +1 more');
  });

  it('form round trip is lossless: valueJson is shown and saved byte-exact, value kept for older hosts', () => {
    const r = rule({ action: { kind: 'mutate', ops: [
      { path: '$.user.avatar_url', op: 'null' },
      { path: "$['odd key']", op: 'delete' },
      { path: '$.price', op: 'set', value: 1, valueJson: '1.0' },
      { path: '$.big', op: 'set', value: 12345678901234567000, valueJson: '{"id": 12345678901234567890}' },
    ] } });
    const form = ruleToForm(r);
    expect(form.kind).toBe('mutate');
    expect(form.mutateOps).toEqual([
      { path: '$.user.avatar_url', op: 'null', value: '' },
      { path: "$['odd key']", op: 'delete', value: '' },
      { path: '$.price', op: 'set', value: '1.0' },
      { path: '$.big', op: 'set', value: '{"id": 12345678901234567890}' },
    ]);
    expect(validateRuleForm(form).errors).toEqual({});
    const back = formToRule(form);
    expect(back.action).toEqual({ kind: 'mutate', ops: [
      { path: '$.user.avatar_url', op: 'null' },
      { path: "$['odd key']", op: 'delete' },
      { path: '$.price', op: 'set', value: 1, valueJson: '1.0' },
      { path: '$.big', op: 'set', value: { id: 12345678901234567890 }, valueJson: '{"id": 12345678901234567890}' },
    ] });
    expect(ruleToForm(back).mutateOps).toEqual(form.mutateOps);
  });

  it('a rule without valueJson (older host) shows value as JSON and gains valueJson on save', () => {
    const r = rule({ action: { kind: 'mutate', ops: [{ path: '$.age', op: 'set', value: { n: '42' } }] } });
    const form = ruleToForm(r);
    expect(form.mutateOps).toEqual([{ path: '$.age', op: 'set', value: '{"n":"42"}' }]);
    expect(formToRule(form).action).toEqual({ kind: 'mutate', ops: [{ path: '$.age', op: 'set', value: { n: '42' }, valueJson: '{"n":"42"}' }] });
  });

  it('a new rule starts with one empty op; validation names the first bad change', () => {
    const form = { ...ruleToForm(), url: 'https://api.example.com/*', kind: 'mutate' as const };
    expect(form.mutateOps).toEqual([{ path: '', op: 'null', value: '' }]);
    let v = validateRuleForm(form);
    expect(v.errors.mutate).toBe('Change 1: Path: Required, e.g. $.user.avatar_url');
    v = validateRuleForm({ ...form, mutateOps: [{ path: '$.a', op: 'null', value: '' }, { path: '$.b', op: 'set', value: '{bad' }] });
    expect(v.errors.mutate).toMatch(/^Change 2: Value is not valid JSON/);
    expect(v.opErrors![0]).toBeUndefined();
    v = validateRuleForm({ ...form, mutateOps: [] });
    expect(v.errors.mutate).toBe('Add at least one change.');
    // Other kinds ignore the op list.
    expect(validateRuleForm({ ...form, kind: 'block' }).errors.mutate).toBeUndefined();
  });

  it('mutateRowError: path syntax, root, empty set value', () => {
    expect(mutateRowError({ path: 'user.name', op: 'null', value: '' })).toMatch(/starts with \$/);
    expect(mutateRowError({ path: '$', op: 'null', value: '' })).toMatch(/below \$/);
    expect(mutateRowError({ path: '$.a', op: 'set', value: '  ' })).toMatch(/enter JSON/);
    expect(mutateRowError({ path: '$.a[*].b', op: 'set', value: 'null' })).toBeUndefined();
    expect(jsonText(undefined)).toBe('');
    expect(jsonText('a')).toBe('"a"');
  });

  it('awaitRule with a label: the created rule gives "Rule added: …" with undo to the list without it', () => {
    const r1 = rule();
    let s = run(snap([], [r1]), { type: 'awaitRule', kind: 'mutate', label: '$.a → null in the next GET /x responses.' });
    expect(s.awaitingRule).toMatchObject({ kind: 'mutate', label: '$.a → null in the next GET /x responses.' });
    const created = rule({ id: 'm1', action: { kind: 'mutate', ops: [{ path: '$.a', op: 'null' }] } });
    s = host(s, { type: 'rules', rules: [created, r1] });
    expect(s.awaitingRule).toBeUndefined();
    expect(s.view).toBe('traffic');
    expect(s.notice?.text).toBe('Rule added: $.a → null in the next GET /x responses.');
    expect(s.notice?.undoRules).toEqual([r1]);
  });
});

describe('JSON paths (webview side of jsonpath.ts)', () => {
  it('childPath uses .name for identifiers and quoted, escaped brackets for anything else', () => {
    expect(childPath('$', 'user')).toBe('$.user');
    expect(childPath('$.user', 'avatar_url')).toBe('$.user.avatar_url');
    expect(childPath('$', '$ref')).toBe('$.$ref');
    expect(childPath('$.items', 0)).toBe('$.items[0]');
    expect(childPath('$', 'odd key')).toBe("$['odd key']");
    expect(childPath('$', "it's")).toBe("$['it\\'s']");
    expect(childPath('$', 'a\\b')).toBe("$['a\\\\b']");
    expect(childPath('$', 'line\nbreak\u0001')).toBe("$['line\\nbreak\\u0001']");
    expect(childPath('$', '1st')).toBe("$['1st']");
    expect(childPath('$', '')).toBe("$['']");
    expect(childPath('$', 'a.b')).toBe("$['a.b']");
  });

  it('parse ↔ format round-trips every segment kind', () => {
    const segs: PathSegment[] = [{ key: 'a' }, { index: 3 }, { wildcard: true }, { key: "it's \\ odd" }, { key: '' }];
    const p = formatPath(segs);
    expect(p).toBe("$.a[3][*]['it\\'s \\\\ odd']['']");
    expect(parsePath(p)).toEqual(segs);
    expect(parsePath('$["double \\" q"]')).toEqual([{ key: 'double " q' }]);
    expect(parsePath(" $.a[ 'b' ].* ")).toEqual([{ key: 'a' }, { key: 'b' }, { wildcard: true }]);
    expect(parsePath('$.avatar-url')).toEqual([{ key: 'avatar-url' }]);
    expect(parsePath("$['\\u0041']")).toEqual([{ key: 'A' }]);
    expect(parsePath('$')).toEqual([]);
  });

  it('readable errors for bad syntax', () => {
    expect(() => parsePath('$.')).toThrow(/field name after "\."/);
    expect(() => parsePath('$..a')).toThrow(/Recursive descent/);
    expect(() => parsePath("$['open")).toThrow(/Unterminated/);
    expect(() => parsePath("$['a'x")).toThrow(/Expected "\]"/);
    expect(() => parsePath("$['\\q']")).toThrow(/Unknown escape/);
    expect(() => parsePath('$[-1]')).toThrow(/Negative/);
    expect(() => parsePath('$a')).toThrow(/Unexpected "a"/);
    expect(() => parsePath('$.a*')).toThrow(/inside a name/);
    expect(checkPath('$.ok')).toBeUndefined();
    expect(checkPath('')).toMatch(/Required/);
  });

  it('normalizePath and everyItemPath', () => {
    expect(normalizePath('$["a"][\'b c\']')).toBe("$.a['b c']");
    expect(normalizePath('not a path')).toBe('not a path');
    expect(everyItemPath('$.sections[3].items[1].image')).toBe('$.sections[*].items[*].image');
    expect(everyItemPath('$.user.name')).toBeUndefined();
    expect(everyItemPath('bad')).toBeUndefined();
  });

  it('agrees with @flutter-intercept/proxy/jsonpath (segments, canonical text, rejections)', async () => {
    const proxy = await import('@flutter-intercept/proxy/jsonpath');
    try { proxy.parsePath('$'); } catch (e) {
      if (/not implemented/.test((e as Error).message)) return; // proxy dist predates the implementation
      throw e;
    }
    const good = [
      '$', '$.user.avatar_url', '$.items[0].id', '$.items[*].price', '$.items.*', "$['odd key']", "$['it\\'s']", "$['a\\\\b']",
      "$['']", '$["dq \\" x"]', "$[ 'sp' ]", '$.avatar-url', "$['\\u00e9\\n']", '$.$ref', "$['0']",
    ];
    for (const p of good) {
      const theirs = proxy.parsePath(p);
      expect(parsePath(p)).toEqual(theirs);
      expect(formatPath(theirs)).toBe(proxy.formatPath(theirs));
    }
    for (const k of ['a', 'odd key', "it's", 'a\\b', 'tab\there', '\u0001', '1st', '$x', '', 'ü']) {
      expect(childPath('$', k)).toBe(proxy.formatPath([{ key: k }]));
    }
    for (const bad of ['', 'a', '$.', '$..a', "$['x", "$['\\q']", '$[-1]', '$[a]', '$.a*', '$[1', '$[?(@.a)]', '$[0:2]']) {
      expect(() => parsePath(bad)).toThrow();
      expect(() => proxy.parsePath(bad)).toThrow();
    }
  });
});

describe('JSON helpers', () => {
  it('decodeJsonString and nodeText keep tokens as sent', () => {
    expect(decodeJsonString('"a\\"b\\u00e9"')).toBe('a"bé');
    expect(decodeJsonString('"broken')).toBe('broke');
    const p = parseJsonLossless('{ "a" : [1.0, {"b\\n":null}], "c": "x" }');
    if (!p.ok) throw new Error('parse');
    expect(nodeText(p.value)).toBe('{"a":[1.0,{"b\\n":null}],"c":"x"}');
  });
});

describe('nodeAt', () => {
  it('finds nodes by concrete path; duplicate keys resolve to the last one; misses are undefined', async () => {
    const { nodeAt } = await import('../src/components/Viewers');
    const p = parseJsonLossless('{"a":[{"b c":1},{"d":2}],"dup":1,"dup":2}');
    if (!p.ok) throw new Error('parse');
    expect(nodeAt(p.value, "$.a[0]['b c']")).toEqual({ t: 'num', raw: '1' });
    expect(nodeAt(p.value, '$.dup')).toEqual({ t: 'num', raw: '2' });
    expect(nodeAt(p.value, '$.a[5]')).toBeUndefined();
    expect(nodeAt(p.value, '$.a.x')).toBeUndefined();
    expect(nodeAt(p.value, '$.a[*]')).toBeUndefined();
    expect(nodeAt(p.value, '$')).toBe(p.value);
  });
});
