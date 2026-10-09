import { describe, expect, it } from 'vitest';
import { compileMatcher, matches, ruleFromExchange, RuleFromExchangeError } from '../src';
import { compileRules, findRule, isInvalidMatcher } from '../src/rules';
import type { Exchange, Rule } from '../src';

describe('matcher', () => {
  it('glob on the full URL, * = any chars, case-sensitive', () => {
    const m = compileMatcher({ url: 'https://api.example.com/users/*' });
    expect(m('GET', 'https://api.example.com/users/42')).toBe(true);
    expect(m('GET', 'https://api.example.com/users/42?x=1')).toBe(true);
    expect(m('GET', 'https://api.example.com/users/a/b')).toBe(true); // * crosses '/'
    expect(m('GET', 'https://api.example.com/Users/42')).toBe(false);
    expect(matches({ url: 'https://api.example.com/users/*' }, 'get', 'https://api.example.com/users/1')).toBe(true);
    expect(m('GET', 'https://api.example.com/user')).toBe(false);
    expect(m('GET', 'http://api.example.com/users/42')).toBe(false);
    expect(compileMatcher({ url: '*/users*' })('GET', 'https://x.io/users?id=1')).toBe(true);
    // regex metacharacters in a glob are literal
    expect(compileMatcher({ url: 'https://a.io/p?q=(1)' })('GET', 'https://a.io/p?q=(1)')).toBe(true);
    expect(compileMatcher({ url: 'https://a.io/p?q=(1)' })('GET', 'https://a.io/pXq=(1)')).toBe(false);
  });

  it('empty or * url matches everything', () => {
    expect(compileMatcher({ url: '' })('GET', 'https://a/b')).toBe(true);
    expect(compileMatcher({ url: '*' })('DELETE', 'http://a/b')).toBe(true);
  });

  it('/regex/flags', () => {
    const m = compileMatcher({ url: '/\\/users\\/\\d+$/i' });
    expect(m('GET', 'https://a.io/USERS/12')).toBe(true);
    expect(m('GET', 'https://a.io/users/x')).toBe(false);
    // g flag must not make matching stateful
    const g = compileMatcher({ url: '/users/g' });
    expect([1, 2, 3].map(() => g('GET', 'https://a/users'))).toEqual([true, true, true]);
    // invalid regex never matches, and is reported
    expect(compileMatcher({ url: '/(/' })('GET', 'https://a/(')).toBe(false);
    expect(isInvalidMatcher({ url: '/(/' })).toBe(true);
    expect(isInvalidMatcher({ url: '/ok/' })).toBe(false);
  });

  it('method is case-insensitive; undefined = any', () => {
    expect(compileMatcher({ method: 'post', url: '*' })('POST', 'http://a/')).toBe(true);
    expect(compileMatcher({ method: 'POST', url: '*' })('GET', 'http://a/')).toBe(false);
    expect(compileMatcher({ url: '*' })('PATCH', 'http://a/')).toBe(true);
  });

  it('first enabled matching rule wins', () => {
    const rules: Rule[] = [
      { id: 'disabled', enabled: false, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } },
      { id: 'get-only', enabled: true, match: { method: 'GET', url: '*/a*' }, action: { kind: 'block', mode: 'reset' } },
      { id: 'a', enabled: true, match: { url: '*/a*' }, action: { kind: 'block', mode: 'reset' } },
      { id: 'all', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } },
    ];
    const c = compileRules(rules);
    expect(findRule(c, 'GET', 'http://h/a')?.id).toBe('get-only');
    expect(findRule(c, 'POST', 'http://h/a')?.id).toBe('a');
    expect(findRule(c, 'POST', 'http://h/b')?.id).toBe('all');
    expect(findRule([], 'GET', 'http://h/')).toBeUndefined();
  });
});

describe('ruleFromExchange', () => {
  const ex: Exchange = {
    id: 'x1',
    startedAt: 0,
    method: 'POST',
    url: 'https://api.example.com/v1/users?page=2#frag',
    requestHeaders: {},
    status: 201,
    responseHeaders: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '42',
      'transfer-encoding': 'chunked',
      'set-cookie': ['a=1', 'b=2'],
    },
    responseBody: { text: '{"ok":true}', encoding: 'utf8' },
    state: 'completed',
  };

  it('matches origin + path + * with the method, and the rule matches the exchange itself', () => {
    const r = ruleFromExchange(ex, 'breakpoint', 'r1');
    expect(r).toMatchObject({
      id: 'r1',
      enabled: true,
      match: { method: 'POST', url: 'https://api.example.com/v1/users*' },
      action: { kind: 'breakpoint', phase: 'response' },
    });
    expect(matches(r.match, ex.method, ex.url)).toBe(true);
    expect(matches(r.match, 'GET', ex.url)).toBe(false);
    expect(matches(r.match, 'POST', 'https://api.example.com/v1/other')).toBe(false);
  });

  it('mock copies status, headers (minus framing) and decoded body', () => {
    const r = ruleFromExchange(ex, 'mock', 'r2');
    expect(r.action).toEqual({
      kind: 'mock',
      status: 201,
      headers: { 'content-type': 'application/json', 'set-cookie': 'a=1, b=2' },
      body: '{"ok":true}',
    });
  });

  it('mock without a response is 200 "{}"; block is status 403', () => {
    const pending: Exchange = { ...ex, status: undefined, responseHeaders: undefined, responseBody: undefined, state: 'pending' };
    expect(ruleFromExchange(pending, 'mock', 'm').action).toMatchObject({ kind: 'mock', status: 200, body: '{}' });
    expect(ruleFromExchange(ex, 'block', 'b').action).toEqual({ kind: 'block', mode: 'status', status: 403 });
  });

  it('refuses to mock a binary or truncated body with a typed error', () => {
    const bin: Exchange = { ...ex, responseBody: { text: 'AAEC', encoding: 'base64' } };
    const big: Exchange = { ...ex, responseBody: { text: 'abc', encoding: 'utf8', truncated: true } };
    for (const [e, code] of [[bin, 'binary'], [big, 'truncated']] as const) {
      let err: unknown;
      try {
        ruleFromExchange(e, 'mock', 'm');
      } catch (x) {
        err = x;
      }
      expect(err).toBeInstanceOf(RuleFromExchangeError);
      expect((err as RuleFromExchangeError).code).toBe(code);
    }
    // other kinds don't need the body
    expect(ruleFromExchange(bin, 'block', 'b').action.kind).toBe('block');
    expect(ruleFromExchange(big, 'breakpoint', 'b').action.kind).toBe('breakpoint');
  });

  it('an empty response body mocks as empty text', () => {
    const empty: Exchange = { ...ex, responseBody: undefined };
    expect(ruleFromExchange(empty, 'mock', 'm').action).toMatchObject({ kind: 'mock', status: 201, body: '' });
  });
});
