// v0.10.0 pure helpers (CONTRACTS §16): gRPC status codes, row texts, decode bookkeeping (decodeGrpc / grpcDecoded),
// the `t:grpc` / `kind:grpc` / `grpc:` filter tokens, rule applicability, the grpcMock rule form, export scope and
// exhaustive handling of the new kind / action.
import { describe, expect, it } from 'vitest';
import {
  appliesToGrpc, decodedMessages, decodeNote, DECODE_TIMEOUT_MS, describeGrpcMock, GRPC_CODES, GRPC_TUNNEL_HINT, grpcActionNote, grpcCodeLabel,
  grpcCodeName, grpcCodesMatching, grpcCountsShort, grpcPath, grpcPreview, grpcStatusSummary, grpcStatusView, grpcVersion, hexTextDump,
  isBase64, isGrpcStreaming, looksLikeGrpcUrl, methodTypesText, needsDecode, reservedGrpcHeader,
} from '../src/grpc';
import { contentClassOf, parseFilter } from '../src/filter';
import { hasMessagesTab, KIND_BADGE, kindTitle } from '../src/frames';
import { exportScope } from '../src/exporting';
import { interceptOff, GRPC_OFF } from '../src/components/actions';
import { isRecordable, STEP_KIND_LABEL, STEP_KINDS, stepLabel } from '../src/scenarios';
import {
  countMatches, describeAction, EMPTY_FILTERS, fieldsToAction, filterExchanges, formToRule, initialState, newStep, reducer, ruleStats,
  ruleToForm, stepsPreview, validateActionFields, validateRuleForm, winningRuleIndex, type State,
} from '../src/state';
import type { Exchange, Frame, GrpcDecoded, Rule, RuleAction } from '../src/protocol';
import { ex, rule, status } from './fixtures';

const msg = (dir: Frame['dir'], at: number, size = 5, over: Partial<Frame> = {}): Frame =>
  ({ dir, at, kind: 'message', size, base64: 'CgNBZGE=', ...over });

export const grpcCall = (over: Partial<Exchange> = {}): Exchange => ex({
  method: 'POST',
  url: 'http://10.0.2.2:50051/demo.Users/GetUser',
  kind: 'grpc',
  requestHeaders: { 'content-type': 'application/grpc', te: 'trailers' },
  responseHeaders: { 'content-type': 'application/grpc' },
  responseBody: undefined,
  responseTrailers: { 'grpc-status': '0' },
  grpc: { service: 'demo.Users', method: 'GetUser', statusCode: 0, messagesSent: 1, messagesReceived: 1 },
  frames: [msg('send', 1_700_000_000_010), msg('receive', 1_700_000_000_040, 12)],
  ...over,
});

const decodedOf = (over: Partial<GrpcDecoded> = {}): GrpcDecoded => ({
  framesDropped: 0,
  method: { requestType: 'demo.GetUserRequest', responseType: 'demo.User', clientStreaming: false, serverStreaming: false },
  messages: [
    { dir: 'send', via: 'schema', json: '{\n  "id": "42"\n}', hex: '0a 02 34 32', size: 4 },
    { dir: 'receive', via: 'schema', json: '{\n  "name": "Ada"\n}', hex: '0a03416461', size: 5 },
  ],
  skeletons: { request: '{"id": ""}', response: '{\n  "id": "",\n  "name": ""\n}' },
  ...over,
});

describe('gRPC status codes', () => {
  it('names the 17 codes and anything else as CODE n', () => {
    expect(GRPC_CODES).toHaveLength(17);
    expect(grpcCodeName(0)).toBe('OK');
    expect(grpcCodeName(14)).toBe('UNAVAILABLE');
    expect(grpcCodeName(16)).toBe('UNAUTHENTICATED');
    expect(grpcCodeName(42)).toBe('CODE 42');
    expect(grpcCodeLabel(4)).toBe('4 DEADLINE_EXCEEDED');
  });

  it('matches names by prefix (case, _ optional) and numbers', () => {
    expect(grpcCodesMatching('unavailable')).toEqual([14]);
    expect(grpcCodesMatching('UNAVAIL')).toEqual([14]);
    expect(grpcCodesMatching('not_found')).toEqual([5]);
    expect(grpcCodesMatching('notfound')).toEqual([5]);
    expect(grpcCodesMatching('deadline-exceeded')).toEqual([4]);
    expect(grpcCodesMatching('un')).toEqual([2, 12, 14, 16]);
    expect(grpcCodesMatching('14')).toEqual([14]);
    expect(grpcCodesMatching('bogus')).toEqual([]);
  });
});

describe('gRPC rows', () => {
  it('status view: OK green, other codes red, pending, cancelled, reset', () => {
    expect(grpcStatusView(grpcCall())).toMatchObject({ text: 'OK', cls: 'ok' });
    const bad = grpcStatusView(grpcCall({ grpc: { service: 's.S', method: 'M', statusCode: 14, statusMessage: 'down', trailersOnly: true, messagesSent: 1, messagesReceived: 0 } }));
    expect(bad).toMatchObject({ text: 'UNAVAILABLE', cls: 'err' });
    expect(bad.title).toBe('gRPC status 14 UNAVAILABLE — down (trailers-only response)');
    expect(grpcStatusView(grpcCall({ state: 'pending', grpc: { service: 's.S', method: 'M', messagesSent: 1, messagesReceived: 0 } })))
      .toMatchObject({ text: '…', cls: 'pending' });
    expect(grpcStatusView(grpcCall({ state: 'aborted', grpc: { service: 's.S', method: 'M', messagesSent: 1, messagesReceived: 0 } })).title)
      .toMatch(/Cancelled by the app/);
    expect(grpcStatusView(grpcCall({ state: 'error', error: 'RST_STREAM', grpc: { service: 's.S', method: 'M', messagesSent: 1, messagesReceived: 0 } })))
      .toMatchObject({ text: '✕', cls: 'err', title: 'No gRPC status: RST_STREAM' });
  });

  it('path, counts, streaming marker, badge and tooltip', () => {
    const c = grpcCall();
    expect(grpcPath(c)).toBe('/demo.Users/GetUser');
    expect(grpcPath({ url: 'http://h:1/a.B/C?x', grpc: undefined })).toBe('/a.B/C');
    expect(grpcCountsShort(c)).toBe('↑1 ↓1');
    expect(isGrpcStreaming(c)).toBe(false);
    expect(isGrpcStreaming(grpcCall({ grpc: { ...c.grpc!, messagesReceived: 3 } }))).toBe(true);
    expect(isGrpcStreaming(c, decodedOf({ method: { requestType: 'a', responseType: 'b', clientStreaming: false, serverStreaming: true } }))).toBe(true);
    expect(KIND_BADGE.grpc).toBe('gRPC');
    expect(kindTitle(c)).toBe('gRPC · demo.Users/GetUser · 1 message sent by the app · 1 received from the server');
    expect(hasMessagesTab(c)).toBe(true);
    expect(hasMessagesTab(ex())).toBe(false);
  });

  it('undecrypted gRPC tunnels carry the decryptHosts hint', () => {
    const t = ex({ method: 'CONNECT', url: 'https://grpc.example.com:443/', kind: 'tunnel', grpcTunnel: true, status: undefined, tunnelBytes: { sent: 900, received: 2048 } });
    const title = kindTitle(t);
    expect(title.split('\n')[0]).toBe(GRPC_TUNNEL_HINT);
    expect(title).toContain('flutterIntercept.grpc.decryptHosts');
    expect(title).not.toContain('flutterIntercept.tlsPassthrough');
    expect(title).toContain('900 B sent by the app');
    expect(interceptOff(t).mock).toMatch(/gRPC over TLS, not decrypted/);
    expect(interceptOff(t).block).toBeUndefined();
  });

  it('actions that don\'t apply to a gRPC call are off with a reason; mock and block stay', () => {
    const off = interceptOff(grpcCall());
    expect(off).toEqual(GRPC_OFF);
    expect(off.mock).toBeUndefined();
    expect(off.block).toBeUndefined();
    expect(off.copy).toMatch(/not gRPC/);
    expect(off.generate).toMatch(/JSON HTTP responses/);
  });

  it('recordings skip gRPC; HAR export includes it, OpenAPI / Postman don\'t', () => {
    expect(isRecordable(grpcCall())).toBe(false);
    const a = ex();
    const g = grpcCall();
    expect(exportScope([a, g], false)).toEqual({ count: 1, filtered: false, grpc: 1 });
    expect(exportScope([g, a], true)).toEqual({ ids: [a.id], count: 1, filtered: true, grpc: 1, harIds: [g.id, a.id] });
    expect(exportScope([a], true)).toEqual({ ids: [a.id], count: 1, filtered: true });
  });
});

describe('decode bookkeeping (decodeGrpc / grpcDecoded)', () => {
  const withCall = (c: Exchange): State => reducer(initialState(), { type: 'host', msgs: [{ type: 'snapshot', exchanges: [c], rules: [], status }] });

  it('asks once per version; a new message or the status is a new version', () => {
    const c = grpcCall({ state: 'pending', grpc: { service: 'demo.Users', method: 'GetUser', messagesSent: 1, messagesReceived: 0 }, frames: [msg('send', 1)] });
    let s = withCall(c);
    expect(needsDecode(c, s.grpcDecoded[c.id])).toBe(true);
    s = reducer(s, { type: 'grpcRequested', id: c.id, key: grpcVersion(c), base: 0, at: 1000 });
    expect(needsDecode(c, s.grpcDecoded[c.id])).toBe(false);
    const more = { ...c, frames: [...c.frames!, msg('receive', 2)] };
    expect(needsDecode(more, s.grpcDecoded[c.id])).toBe(true);
    const done = { ...more, state: 'completed' as const, grpc: { ...c.grpc!, statusCode: 0 } };
    expect(grpcVersion(done)).not.toBe(grpcVersion(more));
    expect(needsDecode(ex(), undefined)).toBe(false);
  });

  it('stores the answer, keeps it while a newer version decodes, prunes it with the exchange', () => {
    const c = grpcCall();
    let s = withCall(c);
    s = reducer(s, { type: 'grpcRequested', id: c.id, key: 'v1', base: 0, at: 1000 });
    s = reducer(s, { type: 'host', msgs: [{ type: 'grpcDecoded', id: c.id, decoded: decodedOf() }] });
    expect(s.grpcDecoded[c.id]).toMatchObject({ key: 'v1', answeredKey: 'v1', answeredBase: 0 });
    s = reducer(s, { type: 'grpcRequested', id: c.id, key: 'v2', base: 0, at: 2000 });
    expect(s.grpcDecoded[c.id].decoded?.skeletons?.response).toContain('"name"');
    // An answer for an exchange no longer listed is dropped.
    expect(reducer(s, { type: 'host', msgs: [{ type: 'grpcDecoded', id: 'gone', decoded: decodedOf() }] }).grpcDecoded.gone).toBeUndefined();
    expect(reducer(s, { type: 'host', msgs: [{ type: 'removed', ids: [c.id] }] }).grpcDecoded[c.id]).toBeUndefined();
    expect(reducer(s, { type: 'host', msgs: [{ type: 'cleared' }] }).grpcDecoded).toEqual({});
    expect(reducer(s, { type: 'host', msgs: [{ type: 'snapshot', exchanges: [], rules: [], status }] }).grpcDecoded).toEqual({});
  });

  it('an unsolicited answer is kept too', () => {
    const c = grpcCall();
    const s = reducer(withCall(c), { type: 'host', msgs: [{ type: 'grpcDecoded', id: c.id, decoded: decodedOf() }] });
    expect(s.grpcDecoded[c.id]).toMatchObject({ key: '', answeredKey: '' });
  });

  it('maps decoded messages onto frames, shifted by frames dropped since the request', () => {
    const frames = [msg('send', 1), msg('receive', 2), msg('receive', 3)];
    const d = decodedOf({ messages: [
      { dir: 'send', via: 'raw', json: '{"1": "x"}', hex: '', size: 1 },
      { dir: 'receive', via: 'schema', json: '{"a": 1}', hex: '', size: 1 },
      { dir: 'receive', via: 'schema', json: '{"a": 2}', hex: '', size: 1 },
    ] });
    const entry = { key: 'k', base: 0, requestedAt: 0, decoded: d, answeredKey: 'k', answeredBase: 0 };
    expect(decodedMessages(entry, frames, 0).map((m) => m?.json)).toEqual(['{"1": "x"}', '{"a": 1}', '{"a": 2}']);
    // One frame dropped since: the window now starts at the second message.
    expect(decodedMessages(entry, frames.slice(1), 1).map((m) => m?.json)).toEqual(['{"a": 1}', '{"a": 2}']);
    // A direction mismatch (stale answer) is not shown.
    expect(decodedMessages(entry, [msg('receive', 1)], 0)).toEqual([undefined]);
    expect(decodedMessages(undefined, frames, 0)).toHaveLength(3);
  });

  it('prefers the window the host says it decoded (framesDropped) over the one at request time', () => {
    const frames = [msg('receive', 3), msg('receive', 4)];
    const d = decodedOf({ framesDropped: 2, messages: [
      { dir: 'receive', via: 'schema', json: '{"n": 3}', hex: '', size: 1 },
      { dir: 'receive', via: 'schema', json: '{"n": 4}', hex: '', size: 1 },
    ] });
    // Asked when 1 frame was dropped, but the host decoded after a second one went: its framesDropped wins.
    const entry = { key: 'k', base: 1, requestedAt: 0, decoded: d, answeredKey: 'k', answeredBase: 1 };
    expect(decodedMessages(entry, frames, 2).map((m) => m?.json)).toEqual(['{"n": 3}', '{"n": 4}']);
    // An older host without the field: the request-time value is used.
    const old = { ...entry, decoded: { ...d, framesDropped: undefined } as unknown as GrpcDecoded };
    expect(decodedMessages(old, frames, 2).map((m) => m?.json)).toEqual(['{"n": 4}', undefined]);
  });

  it('previews, hex and notes', () => {
    expect(grpcPreview(msg('send', 1), { dir: 'send', via: 'schema', json: '{\n  "id": "42"\n}', hex: '', size: 4 })).toBe('{ "id": "42" }');
    expect(grpcPreview(msg('send', 1, 7), undefined)).toBe('7 bytes (protobuf)');
    expect(grpcPreview(msg('send', 1, 7), { dir: 'send', via: 'none', hex: '', size: 7, error: 'bad varint' })).toBe('7 bytes · bad varint');
    expect(hexTextDump('0a 03 41 64 61').text).toBe(`00000000  ${'0a 03 41 64 61'.padEnd(47)}  ..Ada`);
    expect(hexTextDump('0A0341').shown).toBe(3);
    expect(decodeNote(undefined, 0)).toBeUndefined();
    const asked = { key: 'k', base: 0, requestedAt: 1000 };
    expect(decodeNote(asked, 1500)?.kind).toBe('loading');
    expect(decodeNote(asked, 1000 + DECODE_TIMEOUT_MS)?.kind).toBe('none');
    expect(decodeNote({ ...asked, decoded: decodedOf({ problem: 'Unknown method' }) }, 1500)).toEqual({ kind: 'problem', text: 'Unknown method' });
    expect(decodeNote({ ...asked, decoded: decodedOf() }, 99_999)).toBeUndefined();
    expect(methodTypesText(decodedOf().method!)).toBe('demo.GetUserRequest → demo.User · unary');
  });
});

describe('filter: t:grpc, kind:grpc, grpc:<status>', () => {
  const ok = grpcCall({ id: 'ok' });
  const down = grpcCall({ id: 'down', grpc: { service: 'demo.Users', method: 'List', statusCode: 14, messagesSent: 1, messagesReceived: 0 } });
  const open = grpcCall({ id: 'open', state: 'pending', grpc: { service: 'demo.Chat', method: 'Talk', messagesSent: 3, messagesReceived: 2 } });
  const reset = grpcCall({ id: 'reset', state: 'error', grpc: { service: 'demo.Users', method: 'GetUser', messagesSent: 1, messagesReceived: 0 } });
  const tun = ex({ id: 'tun', kind: 'tunnel', grpcTunnel: true, method: 'CONNECT', url: 'https://g.example:443/', status: undefined });
  const http = ex({ id: 'http' });
  const all = [ok, down, open, reset, tun, http];
  const ids = (text: string) => filterExchanges(all, { ...EMPTY_FILTERS, text }).map((e) => e.id);

  it('t:grpc = gRPC calls and undecrypted gRPC tunnels', () => {
    expect(ids('t:grpc')).toEqual(['ok', 'down', 'open', 'reset', 'tun']);
    expect(ids('-t:grpc')).toEqual(['http']);
    expect(contentClassOf({ responseHeaders: { 'content-type': 'application/grpc+proto' }, responseBody: undefined })).toBe('grpc');
  });

  it('kind:grpc', () => {
    expect(ids('kind:grpc')).toEqual(['ok', 'down', 'open', 'reset']);
  });

  it('grpc: names, numbers, error, pending, stream; comma = any of; -grpc:ok negates', () => {
    expect(ids('grpc:ok')).toEqual(['ok']);
    expect(ids('grpc:unavailable')).toEqual(['down']);
    expect(ids('grpc:14')).toEqual(['down']);
    expect(ids('grpc:0,14')).toEqual(['ok', 'down']);
    expect(ids('grpc:error')).toEqual(['down', 'reset']);
    expect(ids('grpc:pending')).toEqual(['open']);
    expect(ids('grpc:stream')).toEqual(['open']);
    expect(ids('-grpc:ok')).toEqual(['down', 'open', 'reset', 'tun', 'http']);
    expect(ids('kind:grpc -grpc:ok')).toEqual(['down', 'open', 'reset']);
    expect(ids('grpc:ok Users')).toEqual(['ok']);
  });

  it('reports invalid values', () => {
    expect(parseFilter('grpc:nope').errors[0]).toMatch(/grpc:nope — use a status name/);
    expect(parseFilter('grpc:').errors).toEqual([]);
  });
});

describe('rules on gRPC calls (CONTRACTS §16.2)', () => {
  const g = grpcCall();
  it('only grpcMock, block, fault, throttle and sequences of those (+ real server) apply', () => {
    const yes: RuleAction[] = [
      { kind: 'grpcMock' }, { kind: 'block', mode: 'reset' }, { kind: 'fault', fault: 'timeout' }, { kind: 'throttle', latencyMs: 100 },
      { kind: 'sequence', steps: [{ action: { kind: 'grpcMock', code: 14 } }, { action: { kind: 'passthrough' } }] },
    ];
    const no: RuleAction[] = [
      { kind: 'mock', status: 200, body: '' }, { kind: 'breakpoint', phase: 'both' }, { kind: 'mutate', ops: [] }, { kind: 'script', code: '' },
      { kind: 'mapRemote', to: 'http://localhost' }, { kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, body: '' } }] },
    ];
    for (const a of yes) expect(appliesToGrpc(a)).toBe(true);
    for (const a of no) expect(appliesToGrpc(a)).toBe(false);
  });

  it('the matcher preview, stats and the winning rule skip rules that don\'t apply', () => {
    const rules: Rule[] = [
      rule({ id: 'bp', match: { url: '*/demo.Users/*' }, action: { kind: 'breakpoint', phase: 'both' } }),
      rule({ id: 'gm', match: { url: '*/demo.Users/*' }, action: { kind: 'grpcMock', code: 5 } }),
    ];
    expect(winningRuleIndex(rules, g)).toBe(1);
    expect(ruleStats(rules, [g])).toEqual([{ matches: 0, wins: 0 }, { matches: 1, wins: 1 }]);
    expect(countMatches({ url: '*/demo.Users/*' }, [g], true)).toBe(0);
    expect(countMatches({ url: '*/demo.Users/*' }, [g])).toBe(1);
  });

  it('notes a rule whose action gRPC calls skip; recognises gRPC-looking URLs', () => {
    expect(grpcActionNote('mock')).toMatch(/gRPC calls skip this rule/);
    expect(grpcActionNote('grpcMock')).toBeUndefined();
    expect(grpcActionNote('sequence', ['grpcMock', 'passthrough'])).toBeUndefined();
    expect(grpcActionNote('sequence', ['grpcMock', 'mock'])).toMatch(/every step/);
    expect(looksLikeGrpcUrl('http://*/demo.Users/GetUser')).toBe(true);
    expect(looksLikeGrpcUrl('*/demo.v1.Users/*')).toBe(true);
    expect(looksLikeGrpcUrl('https://api.example.com/users/*')).toBe(false);
  });
});

describe('grpcMock rule form', () => {
  const base = (action: RuleAction): Rule => rule({ id: 'g1', match: { method: 'POST', url: 'http://*/demo.Users/GetUser' }, action });

  it('round-trips JSON messages as messagesJson (and drops host-encoded messages)', () => {
    const r = base({
      kind: 'grpcMock', code: 0, messagesJson: [{ id: '42', name: 'Ada' }], messages: ['CgI0Mg=='],
      headers: { 'x-env': 'dev' }, trailers: { 'x-trace': 't1' }, delayMs: 200, gapMs: 50,
    });
    const f = ruleToForm(r);
    expect(f.kind).toBe('grpcMock');
    expect(f.grpcMessagesMode).toBe('json');
    expect(f.grpcMessages).toEqual(['{\n  "id": "42",\n  "name": "Ada"\n}']);
    expect(f.grpcHeaders).toEqual([{ name: 'x-env', value: 'dev' }]);
    expect(validateRuleForm(f).errors).toEqual({});
    expect(formToRule(f).action).toEqual({
      kind: 'grpcMock', code: 0, messagesJson: [{ id: '42', name: 'Ada' }],
      headers: { 'x-env': 'dev' }, trailers: { 'x-trace': 't1' }, delayMs: 200, gapMs: 50,
    });
  });

  it('round-trips base64 messages, status and message', () => {
    const r = base({ kind: 'grpcMock', code: 14, message: 'backend down', messages: ['CgI0Mg==', ''] });
    const f = ruleToForm(r);
    expect(f.grpcMessagesMode).toBe('base64');
    expect(f.grpcCode).toBe('14');
    expect(formToRule(f).action).toEqual({ kind: 'grpcMock', code: 14, message: 'backend down', messages: ['CgI0Mg=='] });
  });

  it('a status-only mock (no messages)', () => {
    const f = ruleToForm(base({ kind: 'grpcMock', code: 16 }));
    expect(f.grpcMessages).toEqual([]);
    expect(formToRule(f).action).toEqual({ kind: 'grpcMock', code: 16 });
    expect(describeAction(formToRule(f).action)).toBe('gRPC mock UNAUTHENTICATED');
    expect(describeGrpcMock({ kind: 'grpcMock', code: 0, messagesJson: [{}, {}], delayMs: 10 })).toBe('gRPC mock OK · 2 messages · after 10 ms');
  });

  it('validates messages, delays and reserved headers / trailers', () => {
    const f = { ...newStep('grpcMock'), grpcMessages: ['{"a": 1}', '{oops', '[1]'] };
    const v = validateActionFields('grpcMock', f);
    expect(v.grpcErrors?.[0]).toBeUndefined();
    expect(v.grpcErrors?.[1]).toMatch(/not valid JSON/);
    expect(v.grpcErrors?.[2]).toMatch(/a JSON object/);
    expect(v.errors.grpcMessages).toMatch(/^Message 2: not valid JSON/);
    const b = validateActionFields('grpcMock', { ...newStep('grpcMock'), grpcMessagesMode: 'base64', grpcMessages: ['not base64!'] });
    expect(b.errors.grpcMessages).toMatch(/not valid base64/);
    const h = validateActionFields('grpcMock', {
      ...newStep('grpcMock'), grpcDelayMs: 'soon', grpcGapMs: '-1',
      grpcHeaders: [{ name: 'content-type', value: 'x' }], grpcTrailers: [{ name: 'grpc-status', value: '0' }],
    });
    expect(h.errors.grpcDelayMs).toBeDefined();
    expect(h.errors.grpcGapMs).toBeDefined();
    expect(h.errors.grpcHeaders).toMatch(/content-type/);
    expect(h.errors.grpcTrailers).toMatch(/grpc-status/);
    expect(reservedGrpcHeader(':status')).toBe(true);
    expect(reservedGrpcHeader('x-foo')).toBe(false);
    expect(isBase64('CgI0Mg==')).toBe(true);
    expect(isBase64('CgI0Mg=')).toBe(false);
  });

  it('is a sequence step', () => {
    expect(STEP_KINDS).toContain('grpcMock');
    expect(STEP_KIND_LABEL.grpcMock).toBe('gRPC mock');
    expect(stepLabel({ kind: 'grpcMock', code: 14 })).toBe('gRPC UNAVAILABLE');
    // The preview never throws on a step whose JSON doesn't parse yet.
    const steps = [{ ...newStep('grpcMock'), grpcCode: '14', grpcMessages: ['{oops'] }, newStep('passthrough')];
    expect(stepsPreview(steps, 'last')).toBe('gRPC UNAVAILABLE ×1 → real server from then on');
    const f = { ...ruleToForm(), url: '*/demo.Users/*', kind: 'sequence' as const, steps: [{ ...newStep('grpcMock'), grpcCode: '14', grpcMessages: [] }, newStep('passthrough')] };
    expect(formToRule(f).action).toEqual({ kind: 'sequence', steps: [{ action: { kind: 'grpcMock', code: 14 }, count: 1 }, { action: { kind: 'passthrough' }, count: 1 }] });
    expect(fieldsToAction('grpcMock', newStep('grpcMock'))).toEqual({ kind: 'grpcMock', code: 0, messagesJson: [{}] });
  });
});

describe('Status.grpc summary', () => {
  it('nothing to say, off, schema + decrypt hosts, problems', () => {
    expect(grpcStatusSummary(undefined)).toBeUndefined();
    expect(grpcStatusSummary({ enabled: true, decryptHosts: [] })).toBeUndefined();
    expect(grpcStatusSummary({ enabled: false, decryptHosts: [] })?.text).toBe('gRPC off');
    const s = grpcStatusSummary({ enabled: true, decryptHosts: ['*.internal.example'], schema: { methods: 12, messages: 30, problems: [] } })!;
    expect(s.text).toBe('gRPC: 12 methods · 1 decrypt host');
    expect(s.title).toContain('• *.internal.example');
    expect(s.title).toContain('12 methods, 30 message types');
    const p = grpcStatusSummary({ enabled: true, decryptHosts: [], problem: 'mockttp internals changed', schema: { methods: 1, messages: 2, problems: ['a.pb.dart: parse error'] } })!;
    expect(p.problems).toBe(2);
    expect(p.text).toBe('gRPC: 1 method · 2 problems');
    expect(p.title).toContain('✕ a.pb.dart: parse error');
  });
});
