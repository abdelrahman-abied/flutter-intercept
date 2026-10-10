// v0.7.0 (CONTRACTS §13): reducer paths for `select` / `exported` / the waterfall toggle, the `script` rule form,
// export scope, and the pure helpers in src/scripts.ts.
import { describe, expect, it } from 'vitest';
import {
  describeAction, EMPTY_FILTERS, fieldsToAction, formToRule, initialState, reducer, ruleToForm, toPersisted, validateActionFields,
  validateRuleForm, type RuleForm, type State,
} from '../src/state';
import {
  describeScript, nextScriptFile, SCRIPT_TEMPLATE, scriptCodeError, scriptErrorLine, scriptFileError, scriptMatchError, suggestScriptFile,
} from '../src/scripts';
import { exportScope } from '../src/exporting';
import { isHostMsg } from '../src/host';
import type { HostMsg, Rule } from '../src/protocol';
import { ex, rule, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });
const NOW = 1_700_000_000_000;
const base = (): RuleForm => ({ ...ruleToForm(undefined, NOW), url: 'https://api.example.com/*', kind: 'script' });

describe('reducer: select (CONTRACTS §13.6)', () => {
  const a = ex({ url: 'https://api.example.com/a' });
  const b = ex({ url: 'https://api.example.com/b', status: 500 });
  const c = ex({ url: 'https://api.example.com/c', browserInternal: true });
  const snap = (): State => host(initialState(), { type: 'snapshot', exchanges: [a, b, c], rules: [], status });

  it('is a host message', () => {
    expect(isHostMsg({ type: 'select', id: 'x' })).toBe(true);
    expect(isHostMsg({ type: 'exported', format: 'har', path: '/x.har' })).toBe(true);
  });

  it('switches to the traffic view, selects the exchange and bumps revealSeq', () => {
    let s = reducer(snap(), { type: 'setView', view: 'rules' });
    s = host(s, { type: 'select', id: b.id });
    expect(s.view).toBe('traffic');
    expect(s.selectedId).toBe(b.id);
    expect(s.revealSeq).toBe(1);
    expect(s.notice).toBeUndefined();
    // Selecting it again still asks the list to scroll to it.
    expect(host(s, { type: 'select', id: b.id }).revealSeq).toBe(2);
  });

  it('keeps filters that already show it', () => {
    let s = reducer(snap(), { type: 'setFilters', patch: { text: '/b' } });
    s = host(s, { type: 'select', id: b.id });
    expect(s.filters.text).toBe('/b');
  });

  it('clears filters that hide it, with a short note', () => {
    let s = reducer(snap(), { type: 'setFilters', patch: { text: 'nomatch', method: 'GET' } });
    s = host(s, { type: 'select', id: b.id });
    expect(s.filters).toEqual(EMPTY_FILTERS);
    expect(s.selectedId).toBe(b.id);
    expect(s.notice?.text).toMatch(/Filters cleared/);
  });

  it('shows hidden browser traffic when the exchange is browser-internal', () => {
    const s = host(snap(), { type: 'select', id: c.id });
    expect(s.filters.showBrowser).toBe(true);
    expect(s.selectedId).toBe(c.id);
  });

  it('an exchange no longer listed: a note, the selection unchanged', () => {
    let s = reducer(snap(), { type: 'select', id: a.id });
    s = host(s, { type: 'select', id: 'gone' });
    expect(s.selectedId).toBe(a.id);
    expect(s.notice?.text).toMatch(/no longer listed/);
  });

  it('hides an open composer', () => {
    let s = reducer(snap(), { type: 'openComposer' });
    s = host(s, { type: 'select', id: a.id });
    expect(s.composer?.open).toBe(false);
  });
});

describe('reducer: exported, waterfall, timing tab', () => {
  it('exported shows a notice with the format and path', () => {
    const s = host(initialState(), { type: 'exported', format: 'openapi', path: '/proj/api.openapi.json' });
    expect(s.notice?.text).toBe('Exported OpenAPI 3.1 to /proj/api.openapi.json');
  });

  it('the waterfall is on by default, toggles, and is remembered', () => {
    let s = initialState();
    expect(s.showWaterfall).toBe(true);
    s = reducer(s, { type: 'toggleWaterfall' });
    expect(s.showWaterfall).toBe(false);
    expect(toPersisted(s).showWaterfall).toBe(false);
    expect(reducer(initialState(), { type: 'restore', persisted: { showWaterfall: false } }).showWaterfall).toBe(false);
    expect(reducer(initialState(), { type: 'restore', persisted: {} }).showWaterfall).toBe(true);
  });

  it('the Timing tab survives selecting another exchange (also a WebSocket one) and is restored', () => {
    const ws = ex({ kind: 'websocket', frames: [{ dir: 'send', at: 1, kind: 'text', text: 'hi', size: 2 }] });
    const plain = ex();
    let s = host(initialState(), { type: 'snapshot', exchanges: [plain, ws], rules: [], status });
    s = reducer(s, { type: 'setDetailTab', tab: 'timing' });
    s = reducer(s, { type: 'select', id: ws.id });
    expect(s.detailTab).toBe('timing');
    expect(reducer(initialState(), { type: 'restore', persisted: { detailTab: 'timing' } }).detailTab).toBe('timing');
    expect(reducer(initialState(), { type: 'restore', persisted: { detailTab: 'bogus' as never } }).detailTab).toBe('request');
  });
});

describe('script rule form (CONTRACTS §13.4)', () => {
  it('round-trips an inline script', () => {
    const r: Rule = rule({ action: { kind: 'script', code: 'function onRequest(r) { return r; }' } });
    const f = ruleToForm(r, NOW);
    expect(f.kind).toBe('script');
    expect(f.scriptCode).toBe('function onRequest(r) { return r; }');
    expect(f.scriptUseFile).toBe(false);
    expect(formToRule(f, NOW).action).toEqual({ kind: 'script', code: 'function onRequest(r) { return r; }' });
  });

  it('round-trips a file-backed script, keeping the resolved code', () => {
    const r = rule({ action: { kind: 'script', code: 'function onResponse(x) {}', file: '.vscode/flutter-intercept/scripts/auth.js' } });
    const f = ruleToForm(r, NOW);
    expect(f.scriptUseFile).toBe(true);
    expect(f.scriptFile).toBe('.vscode/flutter-intercept/scripts/auth.js');
    expect(formToRule(f, NOW).action).toEqual({ kind: 'script', code: 'function onResponse(x) {}', file: '.vscode/flutter-intercept/scripts/auth.js' });
  });

  it('validates inline code and file paths', () => {
    expect(validateActionFields('script', { ...base(), scriptCode: '' }).errors.scriptCode).toMatch(/Write the script/);
    expect(validateActionFields('script', { ...base(), scriptCode: 'let x = 1;' }).errors.scriptCode).toMatch(/onRequest/);
    expect(validateActionFields('script', { ...base(), scriptCode: SCRIPT_TEMPLATE }).errors).toEqual({});
    expect(validateActionFields('script', { ...base(), scriptUseFile: true, scriptFile: 'a.ts' }).errors.scriptFile).toMatch(/\.js/);
    expect(validateActionFields('script', { ...base(), scriptUseFile: true, scriptFile: 'scripts/a.js' }).errors).toEqual({});
  });

  it('flags a WebSocket matcher', () => {
    const v = validateRuleForm({ ...base(), url: 'wss://socket.example.com/*', scriptCode: SCRIPT_TEMPLATE });
    expect(v.errors.url).toMatch(/WebSocket/);
    expect(validateRuleForm({ ...base(), scriptCode: SCRIPT_TEMPLATE }).errors).toEqual({});
  });

  it('builds the action; describes it for the rules list', () => {
    expect(fieldsToAction('script', { ...base(), scriptCode: 'function onRequest(){}', scriptUseFile: true, scriptFile: ' s/a.js ' }))
      .toEqual({ kind: 'script', code: 'function onRequest(){}', file: 's/a.js' });
    expect(describeAction({ kind: 'script', code: 'x' })).toBe('Script: inline');
    expect(describeAction({ kind: 'script', code: 'x', file: 's/a.js' })).toBe('Script: s/a.js');
    expect(describeScript({ kind: 'script', code: '', file: '  ' })).toBe('Script: inline');
  });
});

describe('scripts helpers', () => {
  it('suggests a file under .vscode/flutter-intercept/scripts', () => {
    expect(suggestScriptFile('Add debug header', '')).toBe('.vscode/flutter-intercept/scripts/add-debug-header.js');
    expect(suggestScriptFile('', 'https://api.example.com/users/*')).toBe('.vscode/flutter-intercept/scripts/users.js');
    expect(suggestScriptFile('', '*')).toBe('.vscode/flutter-intercept/scripts/script.js');
  });
  it('REVIEW-7 #1: the next free name after a refused "Create file"', () => {
    expect(nextScriptFile('.vscode/flutter-intercept/scripts/login.js')).toBe('.vscode/flutter-intercept/scripts/login-2.js');
    expect(nextScriptFile('scripts/login-2.js')).toBe('scripts/login-3.js');
    expect(nextScriptFile('scripts/a-b.JS')).toBe('scripts/a-b-2.js');
    expect(nextScriptFile('scripts/x')).toBe('scripts/x-2.js');
  });
  it('file paths: workspace-relative .js only', () => {
    expect(scriptFileError('')).toMatch(/workspace-relative/);
    expect(scriptFileError('/etc/x.js')).toMatch(/absolute/);
    expect(scriptFileError('../x.js')).toMatch(/inside the workspace/);
    expect(scriptFileError('x.mjs')).toMatch(/\.js/);
    expect(scriptFileError('scripts/x.js')).toBeUndefined();
  });
  it('code checks: empty, size, hooks', () => {
    expect(scriptCodeError('  ')).toBeDefined();
    expect(scriptCodeError(`function onRequest(){}${' '.repeat(300 * 1024)}`)).toMatch(/256 KB/);
    expect(scriptCodeError('const onResponse = (r) => r;')).toBeUndefined();
    expect(scriptMatchError('ws://x/*')).toBeDefined();
    expect(scriptMatchError('https://x/*')).toBeUndefined();
  });
  it('finds the error line of a failed script', () => {
    expect(scriptErrorLine({ state: 'error', error: 'Script Auth: boom', scriptLog: ['hello', 'boom'] })).toBe(1);
    expect(scriptErrorLine({ state: 'error', error: 'Script Auth: TypeError: x is undefined', scriptLog: ['a', 'TypeError: x is undefined', 'b'] })).toBe(1);
    expect(scriptErrorLine({ state: 'error', error: 'Script Auth: timed out', scriptLog: ['a'] })).toBe(0);
    // The proxy's own error line: "Script <rule>: <message>", cut at 500 characters.
    const long = `Script Auth: ${'x'.repeat(700)}`;
    expect(scriptErrorLine({ state: 'error', error: long, scriptLog: ['first', long.slice(0, 500)] })).toBe(1);
    expect(scriptErrorLine({ state: 'completed', scriptLog: ['a'] })).toBe(-1);
    expect(scriptErrorLine({ state: 'error', error: 'connect ECONNREFUSED', scriptLog: ['a'] })).toBe(-1);
  });
});

describe('exportScope (CONTRACTS §13.5)', () => {
  const a = ex();
  const ws = ex({ kind: 'websocket' });
  const b = ex();
  it('no filter: no ids, counts the HTTP exchanges shown', () => {
    expect(exportScope([a, ws, b], false)).toEqual({ count: 2, filtered: false });
    // Hidden browser traffic is not a filter: the host's default ("all shown HTTP") applies.
    expect(exportScope([a, ws], false)).toEqual({ count: 1, filtered: false });
  });
  it('a filter: the ids of the shown HTTP exchanges', () => {
    expect(exportScope([ws, b], true)).toEqual({ ids: [b.id], count: 1, filtered: true });
    expect(exportScope([], true)).toEqual({ ids: [], count: 0, filtered: true });
  });
});
