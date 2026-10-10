import { describe, expect, it, vi } from 'vitest';
import { compileMatcher, matches, ruleFromExchange, RuleFromExchangeError } from '../src';
import { compileRules, findRule, isInvalidMatcher, isSafeRegexSource, simplifyRegexSource } from '../src/rules';
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

  it('REVIEW-4 #2: globs match in linear time (the reviewer\'s *a*a*a*a*b on 218 chars, and 16 stars on 8 KB)', () => {
    const url = 'a'.repeat(218);
    const m = compileMatcher({ url: '*a*a*a*a*b' });
    let t0 = performance.now();
    expect(m('GET', url)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(5); // was 22.9 s
    const long = `https://x.io/${'a/'.repeat(4000)}`;
    t0 = performance.now();
    expect(compileMatcher({ url: '*/'.repeat(16) + '*x' })('GET', long)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(5);
    // semantics unchanged
    const g = (p: string, u: string) => compileMatcher({ url: p })('GET', u);
    expect(g('*a*a*a*a*b', 'xaaaab')).toBe(true);
    expect(g('a*', 'a')).toBe(true);
    expect(g('*a', 'a')).toBe(true);
    expect(g('a*a', 'a')).toBe(false); // first and last literal can't share the char
    expect(g('a*a', 'aa')).toBe(true);
    expect(g('**', 'anything')).toBe(true);
    expect(g('https://h/*/x*', 'https://h/a/b/x?q')).toBe(true);
    expect(g('https://h/*/x*', 'https://h/x')).toBe(false);
    expect(g('exact', 'exact')).toBe(true);
    expect(g('exact', 'exactly')).toBe(false);
    expect(g('*\n*', 'a\nb')).toBe(true);
  });

  it('REVIEW-4 #2: unsafe regexes are refused (never match, reported as invalid); safe ones keep working', () => {
    for (const src of ['(.+)+Z', '(a*)*', '(a|a)*', '(a+){2}', '(foo|bar)+', '(a)\\1', '(?<n>a)\\k<n>', 'a.*.*x', '\\w+\\d*', 'a.*b.*c', '[^/]+x[^/]+', '\\d+a\\d+b\\d+', 'x'.repeat(300)]) {
      expect(isSafeRegexSource(src), src).toBe(false);
      expect(isInvalidMatcher({ url: `/${src}/` }), src).toBe(true);
    }
    const t0 = performance.now();
    expect(compileMatcher({ url: '/(.+)+Z/' })('GET', 'a'.repeat(40))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(5);
    for (const src of ['\\/users\\/\\d+$', 'v\\d+\\/users\\/\\d+', '(\\d+)?x', '(foo|bar)', '(ab){2,}', '[a-z]+\\/[0-9]+', '^https:\\/\\/api\\.x\\.com\\/.*', 'x{', '(?:a|b)c']) {
      expect(isSafeRegexSource(src), src).toBe(true);
      expect(isInvalidMatcher({ url: `/${src}/` }), src).toBe(false);
    }
    // leading / trailing .* are dropped (same result for test()), so the usual way of writing it is accepted
    expect(simplifyRegexSource('.*users.*')).toBe('users');
    expect(simplifyRegexSource('.*a.*b')).toBe('a.*b');
    expect(simplifyRegexSource('\\.*')).toBe('\\.*'); // escaped dot stays
    expect(simplifyRegexSource('^.*x.*$')).toBe('^.*x.*$');
    expect(isInvalidMatcher({ url: '/.*users.*/' })).toBe(false);
    expect(compileMatcher({ url: '/.*users.*/' })('GET', 'https://a/users/1')).toBe(true);
    expect(compileMatcher({ url: '/.*users.*/' })('GET', 'https://a/orders')).toBe(false);
  });

  it('REVIEW-4 #11: patterns are compiled once (cached by pattern)', () => {
    const p = `/cache-${Math.random()}/`;
    const spy = vi.spyOn(globalThis, 'RegExp');
    try {
      for (let i = 0; i < 50; i++) matches({ url: p }, 'GET', 'https://a/');
      expect(spy.mock.calls.filter((c) => String(c[0]).startsWith('cache-')).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
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
