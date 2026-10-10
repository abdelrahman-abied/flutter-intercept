// v0.6.0 (CONTRACTS §12): reducer paths (recordings, auth flows, views), the rule form for sequence / mapRemote /
// rewrite / bodyFile, list descriptions, and the pure helpers in src/scenarios.ts.
import { describe, expect, it } from 'vitest';
import {
  defaultSteps, describeAction, fieldsToAction, firstActionError, formToRule, initialState, newStep, reducer, ruleToForm, stepsPreview,
  toPersisted, validateActionFields, validateRuleForm, type RuleForm, type State,
} from '../src/state';
import {
  authAlerts, bodyFileError, bodySecretHint, UPSTREAM_TITLE, canMoveRule, checkMapTarget, defaultRecordingName, describeRewrite, diffPair, emptyRewriteForm, expireTokenError,
  expireTokenLabel, flowRows, flowTitle, formatDate, isLoopbackHost, isRecordable, isReplaying, isShared, mapRemoteWarning, MAX_REPLACEMENTS,
  needsApproval, pendingApprovalText, recordingNameError, removeList, rewriteError, rewriteFromForm, rewriteSetsRequestHeaders,
  rewriteToForm, sequencePreview, sortRecordings, stampedeText, stepCountError, stepLabel, suggestBodyFile, togglePick,
} from '../src/scenarios';
import { isHostMsg } from '../src/host';
import type { AuthFlowSummary, HostMsg, RecordingSummary, Rule, RuleAction } from '../src/protocol';
import { ex, rule, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });
const rec = (id: string, createdAt: number, over: Partial<RecordingSummary> = {}): RecordingSummary =>
  ({ id, name: `Rec ${id}`, createdAt, exchanges: 3, redacted: false, ...over });
const NOW = 1_700_000_000_000;
const base = (): RuleForm => ({ ...ruleToForm(undefined, NOW), url: 'https://api.example.com/*' });

describe('reducer: recordings, auth flows, views', () => {
  it('recordings arrive sorted newest first; host messages are recognised', () => {
    const s = host(initialState(), { type: 'recordings', recordings: [rec('a', 1), rec('b', 3), rec('c', 2)] });
    expect(s.recordings.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(isHostMsg({ type: 'recordings', recordings: [] })).toBe(true);
    expect(isHostMsg({ type: 'authFlows', flows: [] })).toBe(true);
  });

  it('pickRecording keeps at most two picks, toggles, ignores unknown ids; clear empties', () => {
    let s = host(initialState(), { type: 'recordings', recordings: [rec('a', 1), rec('b', 2), rec('c', 3)] });
    s = reducer(s, { type: 'pickRecording', id: 'a' });
    s = reducer(s, { type: 'pickRecording', id: 'b' });
    expect(s.recordingPicks).toEqual(['a', 'b']);
    s = reducer(s, { type: 'pickRecording', id: 'c' });
    expect(s.recordingPicks).toEqual(['b', 'c']);
    s = reducer(s, { type: 'pickRecording', id: 'b' });
    expect(s.recordingPicks).toEqual(['c']);
    expect(reducer(s, { type: 'pickRecording', id: 'zzz' })).toBe(s);
    s = reducer(s, { type: 'clearRecordingPicks' });
    expect(s.recordingPicks).toEqual([]);
    expect(reducer(s, { type: 'clearRecordingPicks' })).toBe(s);
  });

  it('a new recordings list drops picks that are gone (and keeps the same array when nothing changed)', () => {
    let s = host(initialState(), { type: 'recordings', recordings: [rec('a', 1), rec('b', 2)] });
    s = reducer(s, { type: 'pickRecording', id: 'a' });
    s = reducer(s, { type: 'pickRecording', id: 'b' });
    const picks = s.recordingPicks;
    s = host(s, { type: 'recordings', recordings: [rec('a', 1), rec('b', 2), rec('c', 5)] });
    expect(s.recordingPicks).toBe(picks);
    s = host(s, { type: 'recordings', recordings: [rec('b', 2)] });
    expect(s.recordingPicks).toEqual(['b']);
  });

  it('authFlows replace the list; cleared drops them with the traffic', () => {
    const flows: AuthFlowSummary[] = [{ steps: [{ exchangeId: 'e1', role: 'unauthorized' }] }];
    let s = host(initialState(), { type: 'authFlows', flows });
    expect(s.authFlows).toBe(flows);
    s = host(s, { type: 'cleared' });
    expect(s.authFlows).toEqual([]);
  });

  it('views: recordings and auth are views; persisted; an unknown persisted view is ignored', () => {
    let s = reducer(initialState(), { type: 'setView', view: 'recordings' });
    expect(toPersisted(s).view).toBe('recordings');
    s = reducer(initialState(), { type: 'restore', persisted: { view: 'auth' } });
    expect(s.view).toBe('auth');
    s = reducer(initialState(), { type: 'restore', persisted: { view: 'bogus' as State['view'] } });
    expect(s.view).toBe('traffic');
  });

  it('status carries replay and shared-rules state through', () => {
    const st = { ...status, replay: { recording: 'R', fallback: 'fail' as const }, sharedRules: { count: 1, problems: [], pendingApproval: 2 } };
    const s = host(initialState(), { type: 'status', status: st });
    expect(s.status.replay?.fallback).toBe('fail');
    expect(s.status.sharedRules?.pendingApproval).toBe(2);
  });
});

describe('rule form: new kinds round-trip', () => {
  const rules: Rule[] = [
    rule({ action: { kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, body: '{}', headers: { 'content-type': 'application/json' } }, count: 1 }, { action: { kind: 'passthrough' }, count: 2 }], then: 'passthrough' } }),
    rule({ action: { kind: 'sequence', steps: [{ action: { kind: 'fault', fault: 'timeout' }, count: 3 }, { action: { kind: 'block', mode: 'status', status: 429 }, count: 1 }], then: 'loop' } }),
    rule({ action: { kind: 'sequence', steps: [{ action: { kind: 'mapRemote', to: 'http://localhost:8080' }, count: 1 }, { action: { kind: 'rewrite', response: { status: 503 } }, count: 1 }] } }),
    rule({ action: { kind: 'mapRemote', to: 'https://staging.example.com' } }),
    rule({ action: { kind: 'mapRemote', to: 'http://localhost:8080/api', preserveHost: true } }),
    rule({ action: { kind: 'rewrite', request: { setHeaders: { 'x-debug': '1' }, removeHeaders: ['if-none-match'] }, response: { status: 503, setHeaders: { 'retry-after': '5' }, removeHeaders: ['etag', 'vary'], replaceBody: [{ find: 'a', replace: 'b' }, { find: '"x"', replace: '"y"', all: true }] } } }),
    rule({ action: { kind: 'rewrite', response: { replaceBody: [{ find: 'true', replace: 'false' }] } } }),
    rule({ action: { kind: 'mock', status: 200, body: '{"from":"file"}', headers: { 'content-type': 'application/json' }, bodyFile: '.vscode/flutter-intercept/mocks/a.json' } }),
  ];
  it('formToRule(ruleToForm(r)) === r for sequence / mapRemote / rewrite / bodyFile rules', () => {
    for (const r of rules) {
      const f = ruleToForm(r, NOW);
      expect(validateRuleForm(f).errors).toEqual({});
      expect(formToRule(f, NOW)).toEqual(r);
    }
  });

  it('a new rule switched to sequence gets the default steps (500 once, then the real server)', () => {
    const f = { ...base(), kind: 'sequence' as const };
    expect(validateRuleForm(f).errors).toEqual({});
    expect(formToRule(f, NOW).action).toEqual({
      kind: 'sequence',
      steps: [
        { action: { kind: 'mock', status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"server_error"}' }, count: 1 },
        { action: { kind: 'passthrough' }, count: 1 },
      ],
    });
    expect(defaultSteps()).toHaveLength(2);
  });

  it('then: last is the default and is not written; empty count means 1', () => {
    const f = { ...base(), kind: 'sequence' as const, steps: [{ ...newStep('mock'), count: '' }], seqThen: 'loop' as const };
    const a = formToRule(f, NOW).action;
    expect(a).toMatchObject({ kind: 'sequence', then: 'loop', steps: [{ count: 1 }] });
  });

  it('sequence validation: per step, the first error named; count; no steps; too many steps', () => {
    const f = { ...base(), kind: 'sequence' as const };
    let v = validateRuleForm({ ...f, steps: [newStep('passthrough'), { ...newStep('mock'), mockStatus: '99' }] });
    expect(v.errors.sequence).toBe('Step 2: Status: 100–599');
    expect(v.stepChecks?.[0].errors).toEqual({});
    v = validateRuleForm({ ...f, steps: [{ ...newStep('passthrough'), count: '0' }] });
    expect(v.errors.sequence).toMatch(/^Step 1: Count: whole number 1–1000/);
    v = validateRuleForm({ ...f, steps: [{ ...newStep('mapRemote'), mapTo: 'ftp://x' }] });
    expect(v.errors.sequence).toBe('Step 1: Only http:// and https:// targets');
    expect(validateRuleForm({ ...f, steps: [] }).errors.sequence).toBe('Add at least one step.');
    expect(validateRuleForm({ ...f, steps: Array.from({ length: 21 }, () => newStep('passthrough')) }).errors.sequence).toBe('At most 20 steps.');
    // A non-sequence rule ignores its (default) steps.
    expect(validateRuleForm({ ...base(), steps: [] }).errors.sequence).toBeUndefined();
  });

  it('mapRemote and rewrite validation', () => {
    expect(validateRuleForm({ ...base(), kind: 'mapRemote' }).errors.mapTo).toMatch(/Required/);
    expect(validateRuleForm({ ...base(), kind: 'mapRemote', mapTo: 'https://staging.example.com' }).errors).toEqual({});
    expect(validateRuleForm({ ...base(), kind: 'rewrite' }).errors.rewrite).toMatch(/Set or remove a header/);
    const rw = { ...emptyRewriteForm(), status: '503' };
    expect(validateRuleForm({ ...base(), kind: 'rewrite', rewrite: rw }).errors).toEqual({});
  });

  it('mock body from a file: path validated, JSON check skipped, bodyFile written', () => {
    const f = { ...base(), mockUseFile: true, mockBodyFile: '', mockBody: '{bad' };
    expect(validateRuleForm(f).errors.mockBodyFile).toMatch(/workspace-relative/);
    expect(validateRuleForm({ ...f, mockBodyFile: '/etc/passwd' }).errors.mockBodyFile).toMatch(/not an absolute path/);
    const ok = { ...f, mockBodyFile: ' mocks/a.json ' };
    const v = validateRuleForm(ok);
    expect(v.errors).toEqual({});
    expect(v.json).toBeUndefined();
    expect(formToRule(ok, NOW).action).toMatchObject({ kind: 'mock', bodyFile: 'mocks/a.json' });
    // Switched back to inline: no bodyFile.
    expect(formToRule({ ...ok, mockUseFile: false }, NOW).action).not.toHaveProperty('bodyFile');
  });

  it('validateActionFields / fieldsToAction / firstActionError work per step kind', () => {
    const s = newStep('throttle');
    expect(validateActionFields('throttle', { ...s, throttle: { latencyMs: '', kbps: '', dropPct: '' } }).errors.throttle).toMatch(/Set a latency/);
    expect(fieldsToAction('passthrough', s)).toEqual({ kind: 'passthrough' });
    expect(fieldsToAction('breakpoint', { ...s, phase: 'request' })).toEqual({ kind: 'breakpoint', phase: 'request' });
    expect(firstActionError({ errors: { mockDelayMs: 'x' } })).toBe('Delay: x');
    expect(firstActionError({ errors: { blockStatus: '100–599' } })).toBe('Status: 100–599');
    expect(firstActionError({ errors: { mapTo: 'bad' } })).toBe('bad');
    expect(firstActionError({ errors: {} })).toBeUndefined();
  });

  it('stepsPreview labels steps that do not validate yet', () => {
    expect(stepsPreview([{ ...newStep('mock'), mockStatus: '5' }, newStep('passthrough')], 'passthrough')).toBe('? ×1 → real server ×1 → real server');
    expect(stepsPreview([{ ...newStep('mutate'), mutateOps: [{ path: '$.a', op: 'set', value: '{bad' }] }, { ...newStep('mock'), mockStatus: '200', count: 'x' }], 'last'))
      .toBe('mutated ×1 → 200 from then on');
  });
});

describe('list descriptions (describeAction)', () => {
  it('describes the new kinds', () => {
    expect(describeAction({ kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, body: '' } }, { action: { kind: 'mock', status: 200, body: '' }, count: 2 }], then: 'passthrough' }))
      .toBe('Sequence: 500 ×1 → 200 ×2 → real server');
    expect(describeAction({ kind: 'mapRemote', to: 'https://staging.example.com' })).toBe('Map to https://staging.example.com');
    expect(describeAction({ kind: 'mapRemote', to: 'http://localhost:1', preserveHost: true })).toBe('Map to http://localhost:1 (keep Host)');
    expect(describeAction({ kind: 'rewrite', response: { status: 503 } })).toBe('Rewrite: status → 503');
    expect(describeAction({ kind: 'mock', status: 200, body: '', bodyFile: 'm/a.json', delayMs: 5 })).toBe('Mock 200 from m/a.json after 5 ms');
  });

  it('describeRewrite counts header changes and replacements per side', () => {
    expect(describeRewrite({ kind: 'rewrite', request: { setHeaders: { a: '1' }, removeHeaders: ['b'] }, response: { replaceBody: [{ find: 'x', replace: 'y' }] } }))
      .toBe('Rewrite: request headers (2), response body (1 replacement)');
    expect(describeRewrite({ kind: 'rewrite', request: { replaceBody: [{ find: 'x', replace: 'y' }, { find: 'z', replace: '' }] } }))
      .toBe('Rewrite: request body (2 replacements)');
    expect(describeRewrite({ kind: 'rewrite' })).toBe('Rewrite: no changes');
  });
});

describe('scenarios helpers', () => {
  it('stepLabel and sequencePreview', () => {
    expect(stepLabel({ kind: 'block', mode: 'reset' })).toBe('reset');
    expect(stepLabel({ kind: 'block', mode: 'status' })).toBe('blocked 403');
    expect(stepLabel({ kind: 'fault', fault: 'dns' })).toBe('DNS failure');
    expect(stepLabel({ kind: 'fault', fault: 'truncate' })).toBe('truncated');
    expect(stepLabel({ kind: 'fault', fault: 'timeout' })).toBe('timeout');
    expect(stepLabel({ kind: 'throttle', latencyMs: 1 })).toBe('slow');
    expect(stepLabel({ kind: 'mutate', ops: [] })).toBe('mutated');
    expect(stepLabel({ kind: 'cors' })).toBe('CORS');
    expect(stepLabel({ kind: 'rewrite', response: { status: 418 } })).toBe('rewritten 418');
    expect(stepLabel({ kind: 'rewrite' })).toBe('rewritten');
    expect(stepLabel({ kind: 'mapRemote', to: 'http://localhost:8080/x' })).toBe('→ localhost:8080');
    const m = (status: number) => ({ action: { kind: 'mock' as const, status, body: '' } });
    expect(sequencePreview([m(500), { ...m(200), count: 2 }], 'passthrough')).toBe('500 ×1 → 200 ×2 → real server');
    expect(sequencePreview([m(500), m(200)])).toBe('500 ×1 → 200 from then on');
    expect(sequencePreview([m(500)])).toBe('500 every time');
    expect(sequencePreview([m(500), m(200)], 'loop')).toBe('500 ×1 → 200 ×1 → ↻ again');
    expect(sequencePreview([])).toBe('no steps');
    expect(stepCountError('')).toBeUndefined();
    expect(stepCountError('1001')).toMatch(/1–1000/);
    expect(stepCountError('2')).toBeUndefined();
  });

  it('Map Remote target checks and the credentials warning', () => {
    for (const h of ['localhost', 'api.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['10.0.2.2', '192.168.1.2', 'example.com', 'localhost.example.com']) expect(isLoopbackHost(h)).toBe(false);
    expect(checkMapTarget('not a url').error).toMatch(/Not a URL/);
    expect(checkMapTarget('https://u:p@x.com').error).toMatch(/user name/);
    expect(checkMapTarget('https://x.com/?a=1').error).toMatch(/no \?query/);
    expect(checkMapTarget('https://x.com/#f').error).toMatch(/no \?query/);
    expect(checkMapTarget(' https://x.com/api ')).toEqual({ origin: 'https://x.com', loopback: false });
    expect(checkMapTarget('http://127.0.0.1:9000')).toEqual({ origin: 'http://127.0.0.1:9000', loopback: true });
    expect(mapRemoteWarning('https://staging.example.com')).toMatch(/credentials .* sent to https:\/\/staging\.example\.com/);
    expect(mapRemoteWarning('http://localhost:8080')).toBeUndefined();
    expect(mapRemoteWarning('bad')).toBeUndefined();
  });

  it('rewrite form ↔ spec and its validation', () => {
    const a: Extract<RuleAction, { kind: 'rewrite' }> = { kind: 'rewrite', request: { removeHeaders: ['a', 'b'] }, response: { status: 500 } };
    const f = rewriteToForm(a);
    expect(f.request.removeHeaders).toBe('a, b');
    expect(f.status).toBe('500');
    expect(rewriteFromForm(f)).toEqual(a);
    expect(removeList(' a,b  c ,, ')).toEqual(['a', 'b', 'c']);
    const e = emptyRewriteForm();
    // Empty replace rows are ignored; a value without a name is an error.
    expect(rewriteFromForm({ ...e, response: { ...e.response, replaceBody: [{ find: '', replace: '', all: false }] } })).toEqual({ kind: 'rewrite' });
    expect(rewriteError({ ...e, request: { ...e.request, setHeaders: [{ name: '', value: 'x' }] } })).toMatch(/needs a name/);
    expect(rewriteError({ ...e, request: { ...e.request, setHeaders: [{ name: 'bad name', value: 'x' }] } })).toMatch(/not valid/);
    expect(rewriteError({ ...e, response: { ...e.response, removeHeaders: 'ok, b@d' } })).toMatch(/b@d/);
    expect(rewriteError({ ...e, response: { ...e.response, replaceBody: [{ find: '', replace: 'x', all: false }] } })).toMatch(/can't be empty/);
    const many = Array.from({ length: MAX_REPLACEMENTS + 1 }, (_, i) => ({ find: `f${i}`, replace: '', all: false }));
    expect(rewriteError({ ...e, response: { ...e.response, replaceBody: many } })).toMatch(/at most 20/);
    expect(rewriteError({ ...e, status: '99' })).toMatch(/100–599/);
    expect(rewriteError({ ...e, status: '204' })).toBeUndefined();
    expect(rewriteSetsRequestHeaders({ kind: 'rewrite', request: { setHeaders: { a: '1' } } })).toBe(true);
    expect(rewriteSetsRequestHeaders({ kind: 'rewrite', request: { removeHeaders: ['a'] } })).toBe(false);
    expect(rewriteSetsRequestHeaders({ kind: 'cors' })).toBe(false);
  });

  it('bodySecretHint flags tokens, keys and credentials but not ordinary JSON', () => {
    expect(bodySecretHint('{"t":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2ln"}')).toBe('what looks like a JWT');
    expect(bodySecretHint('-----BEGIN RSA PRIVATE KEY-----')).toBe('a private key');
    expect(bodySecretHint('key=' + 'AKIA' + 'ABCDEFGHIJKLMNOP')).toBe('what looks like an AWS access key');
    expect(bodySecretHint('Authorization: Bearer abcdef123456789')).toBe('a bearer token');
    expect(bodySecretHint('{"password": "hunter2"}')).toBe('a "password" value');
    expect(bodySecretHint('{"refresh_token":"rt_abcdef"}')).toBe('a "refresh_token" value');
    expect(bodySecretHint('{"name":"Ada","items":[1,2],"token":""}')).toBeUndefined();
    expect(UPSTREAM_TITLE('127.0.0.1:8888')).toContain('127.0.0.1:8888');
  });

  it('body file paths', () => {
    expect(bodyFileError('mocks/a.json')).toBeUndefined();
    expect(bodyFileError('C:\\x.json')).toMatch(/absolute/);
    expect(bodyFileError('~/x.json')).toMatch(/absolute/);
    expect(bodyFileError('file:///x.json')).toMatch(/absolute/);
    expect(bodyFileError('mocks/../../x.json')).toMatch(/inside the workspace/);
    expect(bodyFileError('mocks/')).toMatch(/not a folder/);
    expect(suggestBodyFile('Empty Cart!', '')).toBe('.vscode/flutter-intercept/mocks/empty-cart.json');
    expect(suggestBodyFile('', 'https://api.example.com/v1/cart/items?x=1')).toBe('.vscode/flutter-intercept/mocks/items.json');
    expect(suggestBodyFile('', 'https://api.example.com/users/*')).toBe('.vscode/flutter-intercept/mocks/users.json');
    expect(suggestBodyFile('', '')).toBe('.vscode/flutter-intercept/mocks/mock.json');
  });

  it('shared rules: movement, approval reasons, banner text', () => {
    const s1 = rule({ shared: true });
    const p1 = rule();
    const p2 = rule();
    expect(isShared(s1)).toBe(true);
    expect(canMoveRule([s1, p1, p2], 1, 2)).toBe(true);
    expect(canMoveRule([s1, p1, p2], 1, 0)).toBe(false);
    expect(canMoveRule([s1, p1, p2], 0, 1)).toBe(false);
    expect(canMoveRule([s1, p1], 1, 1)).toBe(false);
    expect(canMoveRule([s1, p1], 1, 5)).toBe(false);
    expect(needsApproval({ kind: 'mapRemote', to: 'https://staging.example.com' })).toMatch(/staging\.example\.com/);
    expect(needsApproval({ kind: 'mapRemote', to: 'http://localhost:1' })).toBeUndefined();
    expect(needsApproval({ kind: 'rewrite', request: { setHeaders: { authorization: 'x' } } })).toMatch(/request headers/);
    expect(needsApproval({ kind: 'sequence', steps: [{ action: { kind: 'passthrough' } }, { action: { kind: 'mapRemote', to: 'https://x.io' } }] })).toMatch(/x\.io/);
    expect(needsApproval({ kind: 'sequence', steps: [{ action: { kind: 'passthrough' } }] })).toBeUndefined();
    expect(needsApproval({ kind: 'mock', status: 200, body: '' })).toBeUndefined();
    expect(pendingApprovalText({ count: 0, problems: [], pendingApproval: 1 })).toMatch(/^1 rule waits for your approval and doesn't run yet: shared rules from \.vscode\/flutter-intercept\.json/);
    expect(pendingApprovalText({ file: 'a/b.json', count: 0, problems: [], pendingApproval: 2 })).toMatch(/^2 rules wait for your approval and don't run yet: shared rules from a\/b\.json/);
    // REVIEW-7 #1: personal script rules are held too — the text doesn't say "shared" only.
    expect(pendingApprovalText({ count: 0, problems: [], pendingApproval: 2 })).toMatch(/script rules whose file content you haven't approved/);
  });

  it('recordings: recordable exchanges, sorting, names, picks, diff pair, replay match', () => {
    expect(isRecordable(ex())).toBe(true);
    expect(isRecordable(ex({ state: 'mocked' }))).toBe(true);
    expect(isRecordable(ex({ state: 'pending' }))).toBe(false);
    expect(isRecordable(ex({ state: 'paused-response' }))).toBe(false);
    expect(isRecordable(ex({ kind: 'websocket' }))).toBe(false);
    expect(isRecordable(ex({ captured: 'vm-profile' }))).toBe(false);
    expect(sortRecordings([rec('b', 1, { name: 'B' }), rec('a', 1, { name: 'A' }), rec('c', 2)]).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(recordingNameError('  ')).toMatch(/name/);
    expect(recordingNameError('x'.repeat(81))).toMatch(/80/);
    expect(recordingNameError('ok')).toBeUndefined();
    expect(defaultRecordingName(new Date(2026, 9, 10, 14, 5).getTime())).toBe('Session 10 Oct 14:05');
    expect(formatDate(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2 Jan 03:04');
    expect(togglePick(['a'], 'a')).toEqual([]);
    expect(togglePick(['a', 'b'], 'c')).toEqual(['b', 'c']);
    const recs = [rec('new', 9), rec('old', 1)];
    expect(diffPair(recs, ['new', 'old'])).toEqual({ a: recs[1], b: recs[0] });
    expect(diffPair(recs, ['old', 'new'])).toEqual({ a: recs[1], b: recs[0] });
    expect(diffPair(recs, ['old'])).toBeUndefined();
    expect(diffPair(recs, ['old', 'gone'])).toBeUndefined();
    expect(isReplaying({ replay: { recording: 'Rec new', fallback: 'fail' } }, recs[0])).toBe(true);
    expect(isReplaying({ replay: { recording: 'new', fallback: 'fail' } }, recs[0])).toBe(true);
    expect(isReplaying({ replay: { recording: 'Rec new', fallback: 'fail' } }, recs[1])).toBe(false);
    expect(isReplaying({}, recs[0])).toBe(false);
  });

  it('auth flows: rows with offsets, title, stampede text, alert count', () => {
    const a = ex({ id: 'u', startedAt: 1000, url: 'https://api.example.com/v1/me?x=1', status: 401 });
    const b = ex({ id: 'r', startedAt: 1040, method: 'POST', url: 'https://api.example.com/auth/refresh' });
    const flow: AuthFlowSummary = {
      steps: [{ exchangeId: 'u', role: 'unauthorized' }, { exchangeId: 'r', role: 'refresh' }, { exchangeId: 'gone', role: 'retry' }],
      stampede: { refreshCalls: 3, windowMs: 2000 },
    };
    const find = (id: string) => [a, b].find((e) => e.id === id);
    const rows = flowRows(flow, find);
    expect(rows.map((r) => [r.role, r.offsetMs, !!r.ex])).toEqual([['unauthorized', 0, true], ['refresh', 40, true], ['retry', undefined, false]]);
    expect(flowTitle(flow, find)).toBe('GET /v1/me');
    expect(flowTitle({ steps: [{ exchangeId: 'r', role: 'refresh' }] }, find)).toBe('POST /auth/refresh');
    expect(flowTitle({ steps: [] }, find)).toBe('Token refresh');
    expect(flowRows({ steps: [{ exchangeId: 'gone', role: 'other' }] }, find)[0].offsetMs).toBeUndefined();
    expect(stampedeText({ refreshCalls: 3, windowMs: 2000 })).toBe('3 refresh calls for one expiry (within 2 s)');
    expect(stampedeText({ refreshCalls: 2, windowMs: 350 })).toBe('2 refresh calls for one expiry (within 350 ms)');
    expect(authAlerts([flow, { steps: [] }, { steps: [], problem: 'x' }])).toBe(2);
  });

  it('expire token preset: validation and notice text', () => {
    expect(expireTokenError('', '1')).toMatch(/URL/);
    expect(expireTokenError('https://a/*', '0')).toMatch(/1–100/);
    expect(expireTokenError('https://a/*', '101')).toMatch(/1–100/);
    expect(expireTokenError('https://a/*', '2')).toBeUndefined();
    expect(expireTokenLabel('https://a/*', 1)).toBe('the next request to https://a/* gets 401 {"error":"token_expired"}, then the real server answers.');
    expect(expireTokenLabel('https://a/*', 3)).toMatch(/^the next 3 requests to https:\/\/a\/\* get 401/);
  });
});
