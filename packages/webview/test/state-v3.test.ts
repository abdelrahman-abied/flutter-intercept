// v0.3.0 reducer paths and helpers (CONTRACTS §9): send/sent, composer, network profile, throttle/fault rules,
// times/expiresAt, source frames.
import { describe, expect, it } from 'vitest';
import type { HostMsg } from '../src/protocol';
import {
  canResend, checkThrottle, composeSend, composerFromExchange, customProfile, describeAction, formToRule, initialState,
  initiatorLabel, isProfileActive, profileChoice, profileForChoice, profileLabel, reducer, resendRequest, ruleBudget,
  ruleHits, ruleToForm, throttleFieldsOf, toPersisted, unsendableBody, validateRuleForm,
  type Action, type State,
} from '../src/state';
import { formatRemaining, fullFrameLocation, isFrameworkFrame, packageOf, shortFrameLocation } from '../src/util';
import { isHostMsg } from '../src/host';
import { ex, pausedRequest, rule, status } from './fixtures';

const host = (s: State, ...msgs: HostMsg[]) => reducer(s, { type: 'host', msgs });
const run = (s: State, ...actions: Action[]) => actions.reduce(reducer, s);
const snap = (exchanges = [ex(), ex()], rules = [rule()]) => host(initialState(), { type: 'snapshot', exchanges, rules, status });

describe('edit & resend: composer', () => {
  const post = ex({
    method: 'POST', url: 'https://api.example.com/cart',
    requestHeaders: { 'content-type': 'application/json', 'content-length': '9', 'set-cookie': ['a', 'b'] },
    requestBody: { text: '{"qty":1}', encoding: 'utf8' },
  });

  it('openComposer starts from the exchange; patch, hide on select, reopen keeps the draft', () => {
    let s = snap([post, ex()]);
    s = run(s, { type: 'openComposer', id: post.id });
    expect(s.composer).toMatchObject({ resentFrom: post.id, open: true, sending: false });
    expect(s.composer!.draft).toMatchObject({ method: 'POST', url: post.url, body: '{"qty":1}' });
    expect(s.composer!.draft.headers).toHaveLength(4);
    s = run(s, { type: 'patchComposer', patch: { body: '{"qty":2}' } });
    s = run(s, { type: 'select', id: s.exchanges[1].id });
    expect(s.composer).toMatchObject({ open: false });
    s = run(s, { type: 'openComposer', id: post.id });
    expect(s.composer).toMatchObject({ open: true });
    expect(s.composer!.draft.body).toBe('{"qty":2}');
    // Another exchange starts fresh; discard drops it.
    s = run(s, { type: 'openComposer', id: s.exchanges[1].id });
    expect(s.composer!.resentFrom).toBe(s.exchanges[1].id);
    expect(run(s, { type: 'closeComposer', discard: true }).composer).toBeUndefined();
    expect(run(s, { type: 'closeComposer' }).composer).toMatchObject({ open: false });
  });

  it('openComposer for an unknown id is a no-op; without id opens a blank request', () => {
    const s = snap();
    expect(run(s, { type: 'openComposer', id: 'nope' })).toBe(s);
    expect(run(s, { type: 'openComposer' }).composer).toMatchObject({ draft: { method: 'GET', url: 'https://' }, open: true });
  });

  it('host `sent` closes the sending composer and selects the new exchange (either arrival order)', () => {
    let s = run(snap([post]), { type: 'openComposer', id: post.id }, { type: 'composerSending' });
    expect(s.composer!.sending).toBe(true);
    // sent first, exchange later
    let a = host(s, { type: 'sent', id: 'new1' });
    expect(a.composer).toBeUndefined();
    expect(a.pendingSelectId).toBe('new1');
    a = host(a, { type: 'exchange', exchange: ex({ id: 'new1', state: 'pending', initiator: 'editor', resentFrom: post.id }) });
    expect(a.selectedId).toBe('new1');
    expect(a.detailTab).toBe('response');
    expect(a.pendingSelectId).toBeUndefined();
    // exchange first, then sent
    s = host(s, { type: 'exchange', exchange: ex({ id: 'new2', state: 'pending', initiator: 'editor' }) });
    const b = host(s, { type: 'sent', id: 'new2' });
    expect(b.selectedId).toBe('new2');
    expect(b.composer).toBeUndefined();
  });

  it('host error unlocks a sending composer (the draft stays)', () => {
    const s = run(snap([post]), { type: 'openComposer', id: post.id }, { type: 'composerSending' });
    const e = host(s, { type: 'error', message: 'Invalid URL' });
    expect(e.composer).toMatchObject({ sending: false, open: true });
  });

  it('`sent` without a composer (one-click Resend) still selects', () => {
    const s = host(snap([post]), { type: 'exchange', exchange: ex({ id: 'r1' }) }, { type: 'sent', id: 'r1' });
    expect(s.selectedId).toBe('r1');
  });

  it('a pending selection is honoured by a snapshot too', () => {
    const s = host(snap([post]), { type: 'sent', id: 'n9' });
    const t = host(s, { type: 'snapshot', exchanges: [post, ex({ id: 'n9' })], rules: [], status });
    expect(t.selectedId).toBe('n9');
  });

  it('composer survives a reload (persisted, never restored as sending)', () => {
    const s = run(snap([post]), { type: 'openComposer', id: post.id }, { type: 'composerSending' });
    const r = reducer(initialState(), { type: 'restore', persisted: toPersisted(s) });
    expect(r.composer).toMatchObject({ open: true, sending: false, resentFrom: post.id });
  });

  it('composeSend: upper-case method, trimmed URL, arrays kept, content-length dropped only when the body changed', () => {
    const c = composerFromExchange(post);
    const same = composeSend(c);
    expect(same).toEqual({
      method: 'POST', url: post.url, body: '{"qty":1}',
      headers: { 'content-type': 'application/json', 'content-length': '9', 'set-cookie': ['a', 'b'] },
    });
    const edited = composeSend({ ...c, draft: { ...c.draft, method: ' put ', url: ` ${post.url} `, body: '{"qty":22}' } });
    expect(edited.method).toBe('PUT');
    expect(edited.url).toBe(post.url);
    expect(edited.headers).not.toHaveProperty('content-length');
    expect(composeSend({ ...c, draft: { ...c.draft, headers: [], body: '' } })).toEqual({ method: 'POST', url: post.url });
  });

  it('composeSend drops a Host header that no longer matches the URL', () => {
    const c = composerFromExchange(ex({ url: 'https://api.example.com/a', requestHeaders: { Host: 'api.example.com', accept: '*/*' } }));
    expect(composeSend(c).headers).toEqual({ Host: 'api.example.com', accept: '*/*' });
    expect(composeSend({ ...c, draft: { ...c.draft, url: 'https://staging.example.com/a' } }).headers).toEqual({ accept: '*/*' });
  });

  it('binary / truncated request bodies are not copied into the draft and block one-click resend', () => {
    const bin = ex({ requestBody: { text: 'AAAA', encoding: 'base64' } });
    expect(unsendableBody(bin)).toMatch(/binary/);
    expect(composerFromExchange(bin)).toMatchObject({ bodyNote: expect.stringMatching(/binary/), draft: { body: '' } });
    expect(composeSend(composerFromExchange(bin)).headers).toBeDefined();
    expect(resendRequest(bin)).toBeUndefined();
    expect(unsendableBody(ex({ requestBody: { text: 'x', encoding: 'utf8', truncated: true } }))).toMatch(/truncated/);
  });

  it('resendRequest copies the recorded request; only finished exchanges can be resent', () => {
    expect(resendRequest(post)).toEqual({ method: 'POST', url: post.url, headers: post.requestHeaders, body: '{"qty":1}' });
    expect(resendRequest(ex({ requestHeaders: {} }))).toEqual({ method: 'GET', url: expect.any(String) });
    expect(canResend(pausedRequest())).toBe(false);
    expect(canResend(ex({ state: 'pending' }))).toBe(false);
    expect(canResend(ex({ state: 'error' }))).toBe(true);
    expect(resendRequest(ex({ state: 'pending' }))).toBeUndefined();
  });

  it('initiatorLabel', () => {
    expect(initiatorLabel(ex())).toBeUndefined();
    expect(initiatorLabel(ex({ initiator: 'editor' }))).toBe('Sent by the editor');
    expect(initiatorLabel(ex({ initiator: 'agent', resentFrom: 'e1' }))).toBe('Resent by an AI agent');
  });

  it('isHostMsg accepts `sent`', () => {
    expect(isHostMsg({ type: 'sent', id: 'x' })).toBe(true);
  });
});

describe('notices', () => {
  it('short notices are flagged for a quicker dismissal', () => {
    const s = run(initialState(), { type: 'notice', text: 'Copied as cURL', short: true });
    expect(s.notice).toMatchObject({ text: 'Copied as cURL', short: true });
  });
});

describe('network profile', () => {
  it('choice ⇄ profile', () => {
    expect(profileChoice(undefined)).toBe('none');
    expect(profileChoice({ kind: 'none' })).toBe('none');
    expect(profileChoice({ kind: 'offline' })).toBe('offline');
    expect(profileChoice(profileForChoice('slow-3g'))).toBe('slow-3g');
    expect(profileChoice({ kind: 'throttle', latencyMs: 300 })).toBe('custom');
    expect(profileForChoice('none')).toEqual({ kind: 'none' });
    expect(profileForChoice('flaky')).toMatchObject({ kind: 'throttle', preset: 'flaky', dropRate: 0.2 });
    expect(isProfileActive(undefined)).toBe(false);
    expect(isProfileActive({ kind: 'offline' })).toBe(true);
    expect(profileLabel(profileForChoice('fast-3g'))).toBe('Fast 3G');
    expect(profileLabel({ kind: 'throttle', latencyMs: 300, kbps: 800, dropRate: 0.05 })).toBe('+300 ms, 800 kbps, 5% fail');
  });

  it('custom throttle fields: validation and conversion', () => {
    expect(checkThrottle({ latencyMs: '', kbps: '', dropPct: '' }).errors.all).toMatch(/Set a latency/);
    expect(checkThrottle({ latencyMs: '-1', kbps: '0', dropPct: '101' }).errors).toMatchObject({
      latencyMs: expect.any(String), kbps: expect.any(String), dropPct: expect.any(String),
    });
    expect(customProfile({ latencyMs: '250', kbps: '', dropPct: '7.5' })).toEqual({ kind: 'throttle', latencyMs: 250, dropRate: 0.075 });
    expect(customProfile({ latencyMs: 'x', kbps: '', dropPct: '' })).toBeUndefined();
    expect(throttleFieldsOf({ latencyMs: 250, dropRate: 0.07 })).toEqual({ latencyMs: '250', kbps: '', dropPct: '7' });
  });
});

describe('throttle / fault rules, times / expiresAt', () => {
  const NOW = 1_800_000_000_000;

  it('describeAction covers the new kinds', () => {
    expect(describeAction({ kind: 'throttle', latencyMs: 400, kbps: 400 })).toBe('Throttle (+400 ms, 400 kbps)');
    expect(describeAction({ kind: 'throttle', dropRate: 0.2 })).toBe('Throttle (20% fail)');
    expect(describeAction({ kind: 'fault', fault: 'dns' })).toBe('Fault: DNS failure (host lookup)');
    expect(describeAction({ kind: 'fault', fault: 'timeout' })).toMatch(/timeout/);
  });

  it('round-trips throttle, fault, times and an untouched expiresAt', () => {
    const rules = [
      rule({ action: { kind: 'throttle', latencyMs: 400, kbps: 1600, dropRate: 0.25 } }),
      rule({ action: { kind: 'throttle', latencyMs: 150 } }),
      rule({ action: { kind: 'fault', fault: 'truncate' }, times: 3 }),
      rule({ action: { kind: 'fault', fault: 'reset' }, expiresAt: NOW + 90_000 }),
      rule({ action: { kind: 'block', mode: 'reset' }, times: 1, expiresAt: NOW - 1 }),
    ];
    for (const r of rules) expect(formToRule(ruleToForm(r, NOW), NOW)).toEqual(r);
  });

  it('expiresIn → absolute expiresAt; editing the field replaces a kept expiry', () => {
    const f = { ...ruleToForm(undefined, NOW), url: '*', kind: 'fault' as const, expiresIn: '5', expiresUnit: 'm' as const };
    expect(formToRule(f, NOW).expiresAt).toBe(NOW + 300_000);
    expect(formToRule({ ...f, expiresIn: '1.5', expiresUnit: 'h' }, NOW).expiresAt).toBe(NOW + 5_400_000);
    const kept = ruleToForm(rule({ expiresAt: NOW + 90_000 }), NOW);
    expect(kept.expiresIn).toBe('2'); // minutes, rounded up for display
    expect(kept.keepExpiresAt).toBe(NOW + 90_000);
    expect(formToRule({ ...kept, keepExpiresAt: undefined, expiresIn: '' }, NOW).expiresAt).toBeUndefined();
  });

  it('validates throttle fields, times and expiry', () => {
    const base = { ...ruleToForm(undefined, NOW), url: '*' };
    expect(validateRuleForm({ ...base, kind: 'throttle' }).errors).toEqual({});
    expect(validateRuleForm({ ...base, kind: 'throttle', throttle: { latencyMs: '', kbps: '', dropPct: '' } }).errors.throttle).toMatch(/Set a latency/);
    expect(validateRuleForm({ ...base, kind: 'throttle', throttle: { latencyMs: '99999', kbps: 'x', dropPct: '200' } }).errors)
      .toMatchObject({ latencyMs: expect.any(String), kbps: expect.any(String), dropPct: expect.any(String) });
    expect(validateRuleForm({ ...base, times: '0' }).errors.times).toMatch(/1–1000/);
    expect(validateRuleForm({ ...base, times: '1001' }).errors.times).toBeDefined();
    expect(validateRuleForm({ ...base, times: '3' }).errors.times).toBeUndefined();
    expect(validateRuleForm({ ...base, expiresIn: '25', expiresUnit: 'h' }).errors.expiresIn).toMatch(/24 hours/);
    expect(validateRuleForm({ ...base, expiresIn: '0.5', expiresUnit: 's' }).errors.expiresIn).toBeDefined();
    expect(validateRuleForm({ ...base, expiresIn: 'soon' }).errors.expiresIn).toBeDefined();
    expect(validateRuleForm({ ...base, expiresIn: '10', expiresUnit: 's' }).errors.expiresIn).toBeUndefined();
  });

  it('ruleBudget: remaining uses and expiry, judged from listed traffic', () => {
    const r = rule({ times: 3, expiresAt: NOW + 61_000 });
    const traffic = [ex({ matchedRuleId: r.id }), ex({ matchedRuleId: r.id }), ex()];
    expect(ruleHits(r, traffic)).toBe(2);
    expect(ruleBudget(r, 2, NOW)).toEqual({ text: '1 of 3 left · expires in 1m 1s', spent: false });
    expect(ruleBudget(r, 5, NOW)).toEqual({ text: '0 of 3 left · expires in 1m 1s', spent: true });
    expect(ruleBudget(r, 0, NOW + 61_000)).toEqual({ text: '3 of 3 left · expired', spent: true });
    expect(ruleBudget(rule(), 0, NOW)).toBeUndefined();
  });
});

describe('source frames and time helpers', () => {
  it('framework frames are SDK, HTTP libraries and the generated entry', () => {
    expect(packageOf('package:shop/api.dart')).toBe('shop');
    expect(isFrameworkFrame({ uri: 'dart:async/zone.dart' })).toBe(true);
    expect(isFrameworkFrame({ uri: 'package:dio/src/dio_mixin.dart' })).toBe(true);
    expect(isFrameworkFrame({ uri: 'package:http/src/client.dart' })).toBe(true);
    expect(isFrameworkFrame({ uri: 'file:///p/app/.dart_tool/flutter_intercept/entry_lib__main.dart' })).toBe(true);
    expect(isFrameworkFrame({ uri: 'package:shop/api/cart.dart' })).toBe(false);
    expect(isFrameworkFrame({ uri: 'package:http_helpers/x.dart' })).toBe(false);
  });
  it('short and full locations', () => {
    expect(shortFrameLocation({ uri: 'package:shop/src/api/cart_api.dart', line: 42 })).toBe('api/cart_api.dart:42');
    expect(shortFrameLocation({ uri: 'file:///Users/me/app/lib/main.dart', line: 7 })).toBe('lib/main.dart:7');
    expect(shortFrameLocation({ uri: 'dart:async/zone.dart' })).toBe('dart:async/zone.dart');
    expect(fullFrameLocation({ uri: 'package:shop/a.dart', line: 3, column: 9 })).toBe('package:shop/a.dart:3:9');
    expect(fullFrameLocation({ uri: 'package:shop/a.dart' })).toBe('package:shop/a.dart');
  });
  it('formatRemaining', () => {
    expect(formatRemaining(0)).toBe('0s');
    expect(formatRemaining(41_001)).toBe('42s');
    expect(formatRemaining(250_000)).toBe('4m 10s');
    expect(formatRemaining(3_900_000)).toBe('1h 5m');
  });
});
