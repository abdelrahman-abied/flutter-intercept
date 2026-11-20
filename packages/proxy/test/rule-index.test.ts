// CONTRACTS §24.5: the method × origin × path rule index. The indexed result must equal the linear scan for every rule
// set and request; the property tests below are the proof (seeded, so a failure names the seed that reproduces it).
import { describe, expect, it } from 'vitest';
import { InterceptProxy } from '../src/intercept-proxy';
import { baseMatches, compileRules, findRule, ruleCandidates, urlIndexKey, urlOriginKeys } from '../src/rules';
import { requestOriginKey } from '../src/rule-index';
import type { Rule, RuleAction } from '../src/types';

/** mulberry32: a small seeded PRNG (no dependency). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The shapes packages/extension/src/mocks/toRules.ts builds (copied: the proxy can't import the extension).
const escapeRegex = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const PARAM = '[^/?#]{1,100}';
const PATH_END = '\\/?(?:[?#]|$)';
const QUERY_CHARS = "[\\w.~%+=,;:@!$'()*\\/?&-]";
function toRulesOrigin(scheme: 'http' | 'https', host: string, port?: string): string {
  const def = scheme === 'https' ? '443' : '80';
  return escapeRegex(`${scheme}://${host}${port ? `:${port}` : ''}`) + (port ? '' : `(?::${def})?`);
}

describe('rule index: origin keys (CONTRACTS §24.5)', () => {
  it('request keys: lower-cased, default port dropped, no scheme → none', () => {
    expect(requestOriginKey('https://API.Shop.example:443/users?x#y')).toBe('https://api.shop.example');
    expect(requestOriginKey('HTTP://h:80')).toBe('http://h');
    expect(requestOriginKey('http://h:443/')).toBe('http://h:443');
    expect(requestOriginKey('wss://h:443/socket')).toBe('wss://h');
    expect(requestOriginKey('https://user:pw@h/')).toBe('https://user:pw@h');
    expect(requestOriginKey('http://[::1]:80/')).toBe('http://[::1]');
    expect(requestOriginKey('api.shop.example:443')).toBeUndefined();
    expect(requestOriginKey('/users')).toBeUndefined();
    expect(requestOriginKey(' https://h/')).toBeUndefined();
  });

  it('toRules regexes are indexed by their origin (with and without the default port)', () => {
    const o = toRulesOrigin('https', 'api.shop.example');
    expect(urlOriginKeys(`/^${o}\\/users\\/${PARAM}${PATH_END}/i`)).toEqual(['https://api.shop.example']);
    expect(urlOriginKeys(`/^${o}${PATH_END}/i`)).toEqual(['https://api.shop.example']); // the root path
    expect(urlOriginKeys(`/^${o}\\/users\\/?\\?(?=(?:${QUERY_CHARS}*&)?page=2(?:[&#]|$))/i`)).toEqual(['https://api.shop.example']);
    expect(urlOriginKeys(`/^${o}(?:[\\/?#]|$)/i`)).toEqual(['https://api.shop.example']); // "not in the collection"
    expect(urlOriginKeys(`/^${toRulesOrigin('http', 'localhost', '8080')}\\/x${PATH_END}/i`)).toEqual(['http://localhost:8080']);
    expect(urlOriginKeys(`/^${toRulesOrigin('http', '[::1]')}\\/x${PATH_END}/i`)).toEqual(['http://[::1]']);
    expect(urlOriginKeys('/^https:\\/\\/h(?::8443)?\\/x/')).toEqual(['https://h', 'https://h:8443']);
  });

  it('globs: indexed only when the authority is closed before the first *', () => {
    expect(urlOriginKeys('https://API.example/users/*')).toEqual(['https://api.example']);
    expect(urlOriginKeys('https://api.example:443/x')).toEqual(['https://api.example']);
    expect(urlOriginKeys('https://api.example')).toEqual(['https://api.example']); // exact
    expect(urlOriginKeys('https://api.example?*')).toEqual(['https://api.example']);
    for (const wild of ['', '*', ' * ', 'https://api.example*', 'https://*.example/x', '*://api.example/x', '*/users*', 'api.example/*', 'https://api.ex*ample/']) {
      expect(urlOriginKeys(wild), wild).toBeUndefined();
    }
  });

  it('regexes that cannot be proven stay wildcard', () => {
    for (const wild of [
      '/users\\/\\d+/', // no ^
      '/^https?:\\/\\/api\\.example\\//', // quantified scheme
      '/^https:\\/\\/api\\.example\\/x|y/', // top-level alternation
      '/^https:\\/\\/a\\.b\\/[]|x]/', // `[]` is an empty class in JavaScript: the `|` is top-level
      '/^https:\\/\\/api\\.example\\//m', // ^ after any newline
      '/^https:\\/\\/api\\.example\\//iu', // Unicode case folding
      '/^https:\\/\\/api\\.example\\//v',
      '/^https:\\/\\/api\\.example/', // not closed: https://api.example.evil
      '/^https:\\/\\/api\\.example\\/?x/', // optional slash, then more host
      '/^https:\\/\\/api\\.example(?:\\/|x)/', // an alternative that isn't a terminator
      '/^https:\\/\\/api\\.example(?:\\/|)/', // an empty alternative
      '/^https:\\/\\/api\\.example[/x]/', // a class with more than terminators
      '/^https:\\/\\/api\\.example[^/]/',
      '/^https:\\/\\/api\\.example[/-?]/', // a range
      '/^https:\\/\\/api\\.example(?::443)??\\//', // lazy port group
      '/^https:\\/\\/api\\.examplé\\//', // not ASCII
      '/^https:\\/\\/api\\.example\\d\\//',
      '/^https:\\/\\/api\\.exampl(e)\\//',
      '/^https:\\/\\/api\\.example\\/{0}/',
      '/^https:\\/\\/[a-z]+\\.example\\//',
      '/^(?:https):\\/\\/api\\.example\\//',
      '/(^https:\\/\\/api\\.example\\/)/',
    ]) {
      expect(urlOriginKeys(wild), wild).toBeUndefined();
    }
    expect(urlOriginKeys('/^HTTPS:\\/\\/API\\.Example\\//')).toEqual(['https://api.example']);
    expect(urlOriginKeys('/^https:\\/\\/api\\.example\\/+/')).toEqual(['https://api.example']);
    expect(urlOriginKeys('/^https:\\/\\/api\\.example$/')).toEqual(['https://api.example']);
    expect(urlOriginKeys('/^https:\\/\\/api\\.example\\/?$/')).toEqual(['https://api.example']);
    expect(urlOriginKeys('/^https:\\/\\/api\\.example(?:\\/(?:a|b)|\\?|$)/')).toEqual(['https://api.example']);
  });

  it('findRule: first match wins across method, any-method and wildcard lists', () => {
    const rules: Rule[] = [
      { id: 'wild-get', enabled: true, match: { method: 'get', url: '*/never' }, action: { kind: 'block', mode: 'reset' } },
      { id: 'origin-any', enabled: true, match: { url: 'https://a.example/*' }, action: { kind: 'block', mode: 'reset' } },
      { id: 'origin-get', enabled: true, match: { method: 'GET', url: 'https://a.example/x' }, action: { kind: 'block', mode: 'reset' } },
      { id: 'wild-any', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } },
    ];
    const c = compileRules(rules, { linear: false }); // explicit: the suite also runs with FI_PROXY_LINEAR=1
    expect(ruleCandidates(c, 'GET', 'https://a.example/x')).toEqual([0, 1, 2, 3]);
    expect(ruleCandidates(c, 'POST', 'https://A.example:443/x')).toEqual([1, 3]);
    expect(ruleCandidates(c, 'GET', 'https://b.example/x')).toEqual([0, 3]);
    expect(ruleCandidates(c, 'POST', 'no scheme')).toEqual([3]);
    expect(findRule(c, 'get', 'https://a.example/x')?.id).toBe('origin-any');
    expect(findRule(c, 'get', 'https://b.example/x')?.id).toBe('wild-any');
    // a list that isn't the one compiled (a copy, or changed afterwards) is scanned whole
    expect(ruleCandidates([...c], 'GET', 'https://a.example/x')).toBeUndefined();
    expect(ruleCandidates(compileRules(rules, { linear: true }), 'GET', 'https://a.example/x')).toBeUndefined();
    const before = process.env.FI_PROXY_LINEAR;
    process.env.FI_PROXY_LINEAR = '1';
    try {
      expect(ruleCandidates(compileRules(rules), 'GET', 'https://a.example/x')).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.FI_PROXY_LINEAR;
      else process.env.FI_PROXY_LINEAR = before;
    }
  });
});

describe('rule index: path keys (CONTRACTS §24.5, the path trie)', () => {
  const o = toRulesOrigin('https', 'api.shop.example');
  const key = (pattern: string) => {
    const k = urlIndexKey(pattern)?.path;
    return k && `${k.segs.map((s) => `/${s}`).join('')}${k.exact ? ' =' : ' …'}`;
  };

  it('toRules regexes: the literal segments before the first parameter; exact when the path ends there', () => {
    expect(key(`/^${o}${PATH_END}/i`)).toBe(' ='); // the root path
    expect(key(`/^${o}\\/Users${PATH_END}/i`)).toBe('/users =');
    expect(key(`/^${o}\\/api\\/v1\\/users${PATH_END}/i`)).toBe('/api/v1/users =');
    expect(key(`/^${o}\\/users\\/${PARAM}${PATH_END}/i`)).toBe('/users …');
    expect(key(`/^${o}\\/api\\/res1\\/${PARAM}\\/items\\/${PARAM}${PATH_END}/i`)).toBe('/api/res1 …');
    expect(key(`/^${o}\\/${PARAM}\\/users${PATH_END}/i`)).toBe(' …');
    expect(key(`/^${o}\\/users\\/?\\?(?=(?:${QUERY_CHARS}*&)?page=2(?:[&#]|$))/i`)).toBe('/users ='); // a query example
    expect(key(`/^${o}\\/users\\/${PARAM}\\/?\\?(?=(?:${QUERY_CHARS}*&)?page=2(?:[&#]|$))/i`)).toBe('/users …');
    expect(key(`/^${o}(?:[\\/?#]|$)/i`)).toBe(' …'); // "not in the collection"
    // a literal in several encodings is a group: the proof stops before it
    expect(key(`/^${o}\\/api\\/(?:café|caf%C3%A9)\\/x${PATH_END}/i`)).toBe('/api …');
    expect(key(`/^${o}\\/caf%C3%A9\\/a\\.b\\/a\\-b${PATH_END}/i`)).toBe('/caf%c3%a9/a.b/a-b ='); // never decoded
    expect(key(`/^${toRulesOrigin('http', 'localhost', '8080')}\\/x${PATH_END}/i`)).toBe('/x =');
    expect(key('/^https:\\/\\/h(?::8443)?\\/x\\/y/')).toBe('/x …');
  });

  it('regexes: a segment is keyed only when it is plain, whole and unquantified', () => {
    const cases: [string, string][] = [
      ['\\/users', ' …'], // `/users5` matches too
      ['\\/users$', '/users ='],
      ['\\/users\\/?$', '/users ='],
      ['\\/users\\/$', '/users ='],
      ['\\/users[?#]', '/users ='],
      ['\\/users\\?x', '/users ='],
      ['\\/users\\#', '/users ='],
      ['\\/users(?:\\?|$)', '/users ='],
      ['/users/x$', '/users/x ='], // an unescaped slash
      ['\\/users\\/', '/users …'],
      ['\\/users\\/+$', '/users …'], // `/users//` is not the node's own path
      ['\\/users\\/*$', '/users …'],
      ['\\/users\\/??$', '/users …'],
      ['\\/users\\/{1}$', ' …'], // a counted slash proves nothing
      ['\\/users(?:[\\/?#]|$)', '/users …'],
      ['\\/users(?:\\/|$)', '/users …'],
      ['\\/users\\/?(?:[?#]|$)?', ' …'], // an optional end: `/usersx`
      ['\\/users\\/(?:[?#]|$)?', '/users …'], // … after a slash: anything may follow it
      ['\\/users\\/?(?:[?#]|x)', ' …'], // `/usersx`
      ['\\/users?$', ' …'], // a quantified character
      ['\\/users+\\/x', ' …'],
      ['\\/users{2}', ' …'],
      ['\\/users\\/*x', ' …'], // `/usersx`
      ['\\/a\\/users.\\/x', '/a …'],
      ['\\/a\\/(users)\\/x', '/a …'],
      ['\\/a\\/[Uu]sers\\/x', '/a …'],
      ['\\/a\\/(?=users)', '/a …'],
      ['\\/a\\/\\/b$', '/a …'], // an empty segment is never a key
      ['\\/\\/a$', ' …'],
      ['\\/+users$', ' …'], // `//users`: its first segment is empty
      ['\\/a\\/+users$', '/a …'],
      ['\\/a\\/?users$', ' …'], // `/ausers`
      ['\\/a\\/*users$', ' …'],
      ['\\/users\\/?\\/?$', '/users …'], // `/users//`
      ['\\/users\\/[\\/?#]', '/users …'],
      ['\\/a\\/café\\/x$', '/a …'], // `i` folds non-ASCII its own way
      ['\\/a\\/ς$', '/a …'],
      ['\\/a\\/x y$', '/a …'], // not printable ASCII
      ['\\/a\\/\\.\\.\\/%2F$', '/a/../%2f ='], // dot segments and escapes are text
      ['$', ' ='],
      ['\\/?$', ' ='],
      ['\\?x', ' ='],
      ['[?#]', ' ='],
      ['\\/+', ' …'],
      ['[\\/?#]', ' …'],
    ];
    for (const [tail, want] of cases) {
      for (const flags of ['', 'i']) expect(key(`/^https:\\/\\/h${tail}/${flags}`), `${tail} /${flags}`).toBe(want);
    }
    expect(key(`/^https:\\/\\/h${'\\/a'.repeat(20)}$/`)).toBe(`${'/a'.repeat(16)} …`); // 16 levels at most
  });

  it('globs: the segments closed before the first *; exact without a * (or at the query)', () => {
    const cases: [string, string | undefined][] = [
      ['https://h', ' ='],
      ['https://h/', ' ='],
      ['https://h?x', ' ='],
      ['https://h/Users', '/users ='],
      ['https://h/users/', '/users ='],
      ['https://h/users/5?page=2', '/users/5 ='],
      ['https://h/users#f', '/users ='],
      ['https://h/users?*', '/users ='],
      ['https://h/users/?*', '/users ='],
      ['https://h/*', ' …'],
      ['https://h/users*', ' …'], // `/users5`
      ['https://h/users/*', '/users …'],
      ['https://h/users/5*', '/users …'],
      ['https://h/users/*/items', '/users …'],
      ['https://h/users//x', '/users …'],
      ['https://h//users', ' …'],
      ['https://h/users//', '/users …'],
      ['https://h/a/café/x', '/a …'],
      ['https://h/a/x y/z', '/a …'],
      ['https://h/a/../%2F', '/a/../%2f ='],
      ['https://h*', undefined],
      ['*/users', undefined],
    ];
    for (const [glob, want] of cases) expect(key(glob), glob).toBe(want);
  });

  it('candidates: only the rules on the request\'s path, in order', () => {
    const block = { kind: 'block', mode: 'reset' } as const;
    const url = (tail: string) => `/^${o}${tail}/i`;
    const rules: Rule[] = [
      { id: 'users', enabled: true, match: { method: 'GET', url: url(`\\/users${PATH_END}`) }, action: block },
      { id: 'user', enabled: true, match: { method: 'GET', url: url(`\\/users\\/${PARAM}${PATH_END}`) }, action: block },
      { id: 'orders', enabled: true, match: { method: 'GET', url: url(`\\/orders${PATH_END}`) }, action: block },
      { id: 'any-users', enabled: true, match: { url: 'https://api.shop.example/users/*' }, action: block },
      { id: 'tenant', enabled: true, match: { method: 'GET', url: url(`\\/${PARAM}\\/settings${PATH_END}`) }, action: block },
      { id: 'wild', enabled: true, match: { method: 'GET', url: '*/health' }, action: block },
      { id: 'rest', enabled: true, match: { url: url('(?:[\\/?#]|$)') }, action: block },
    ];
    const c = compileRules(rules, { linear: false });
    const ids = (method: string, u: string) => ruleCandidates(c, method, u)!.map((i) => rules[i].id);
    expect(ids('GET', 'https://api.shop.example/users')).toEqual(['users', 'user', 'any-users', 'tenant', 'wild', 'rest']);
    expect(ids('GET', 'https://API.shop.example:443/USERS/?page=2')).toEqual(['users', 'user', 'any-users', 'tenant', 'wild', 'rest']);
    expect(ids('GET', 'https://api.shop.example/users/5')).toEqual(['user', 'any-users', 'tenant', 'wild', 'rest']);
    expect(ids('GET', 'https://api.shop.example/users//')).toEqual(['user', 'any-users', 'tenant', 'wild', 'rest']);
    expect(ids('GET', 'https://api.shop.example/orders#f')).toEqual(['orders', 'tenant', 'wild', 'rest']);
    expect(ids('GET', 'https://api.shop.example/orders/5')).toEqual(['tenant', 'wild', 'rest']);
    expect(ids('GET', 'https://api.shop.example/nothing/here')).toEqual(['tenant', 'wild', 'rest']);
    expect(ids('GET', 'https://api.shop.example')).toEqual(['tenant', 'wild', 'rest']);
    expect(ids('POST', 'https://api.shop.example/users/5')).toEqual(['any-users', 'rest']);
    expect(ids('POST', 'https://api.shop.example/orders')).toEqual(['rest']);
    expect(ids('GET', 'https://other.example/users')).toEqual(['wild']);
    // no trie nodes allowed: every rule of the origin (the index of before)
    const flat = compileRules(rules, { linear: false, maxTrieNodes: 0 });
    expect(ruleCandidates(flat, 'GET', 'https://api.shop.example/nothing/here')!.map((i) => rules[i].id)).toEqual(['users', 'user', 'orders', 'any-users', 'tenant', 'wild', 'rest']);
    for (const u of ['https://api.shop.example/users', 'https://api.shop.example/users/5', 'https://api.shop.example/x']) {
      expect(findRule(flat, 'GET', u)?.id).toBe(findRule(c, 'GET', u)?.id);
    }
  });
});

// ---------------------------------------------------------------- the property tests

const SCHEMES = ['http', 'https', 'ws', 'wss', 'HTTPS', 'HtTp'];
const HOSTS = ['api.shop.example', 'API.Shop.Example', 'localhost', '127.0.0.1', '[::1]', 'a.b', 'api.shop.example.evil', 'xn--bcher-kva.example', 'ſhop.example', 'İ.example', 'K.example', 'ς.example', 'σ.example', 'Σ.example'];
const PORTS = ['', ':80', ':443', ':8080', ':0443', ':'];
const PATHS = ['', '/', '/users', '/users/5', '/api/res1/7/items/2', '?page=2', '/users?page=2&x=1', '#f', '/%2E%2e/x', '/%2fusers', '/ünï', '/x\nhttps://api.shop.example/users'];
const METHODS = ['GET', 'get', 'POST', 'PUT', 'CONNECT', 'ss', '*', 'Get'];
const RULE_METHODS: (string | undefined)[] = [undefined, '', '*', ' * ', 'GET', 'get', ' Post ', 'PUT', 'CONNECT', 'ß'];
/** Regex pieces for random user regexes: mostly the prefix grammar, plus every way to break it. */
const FRAGMENTS = [
  '^', '^', '^', 'https', 'http', 'HTTPS', 'https?', ':\\/\\/', '://', 'api\\.shop\\.example', 'API\\.shop\\.EXAMPLE', 'a\\.b', 'localhost',
  '\\[::1\\]', '(?::443)?', '(?::80)?', '(?::8080)?', ':8080', ':443', '\\/', '\\/', '/', '\\/?', '\\/*', '\\/+', '(?:[\\/?#]|$)', '(?:[?#]|$)',
  '[\\/?#]', '[?#]', '[/]', '$', '|', '.*', '[^/]+', '(?:\\/|x)', '(?:\\/)?', 'users', '\\d+', '\\.', 'a', '[]', ']', '(?:', ')', '#', '\\?',
  '\\#', '{2}', '+', '?', '(?=x)', '\\b', '[a-z]', 'evil', '\\-', '%2E',
];
const FLAGS = ['', '', 'i', 'i', 'm', 'iu', 'u', 's', 'g', 'iy', 'im', 'v', 'x', 'id'];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function randomUrl(r: () => number): string {
  const x = r();
  if (x < 0.06) return pick(r, ['api.shop.example:443', 'localhost:8080', '/users', '*', '', ' https://api.shop.example/', 'https:/api.shop.example/', 'https:///users', 'mailto:x@y']);
  const user = r() < 0.08 ? pick(r, ['user@', 'u:p@', 'api.shop.example@']) : '';
  return `${pick(r, SCHEMES)}://${user}${pick(r, HOSTS)}${pick(r, PORTS)}${pick(r, PATHS)}`;
}

function randomPattern(r: () => number): string {
  const x = r();
  const scheme = pick(r, SCHEMES);
  const host = pick(r, HOSTS);
  if (x < 0.3) {
    // toRules: endpoint, query example or "not in the collection"
    const s = r() < 0.5 ? 'https' : 'http';
    const h = pick(r, ['api.shop.example', 'localhost', '127.0.0.1', '[::1]', 'a.b']);
    const o = toRulesOrigin(s, h, r() < 0.2 ? pick(r, ['8080', '443', '80']) : undefined);
    const path = pick(r, ['', '\\/users', `\\/users\\/${PARAM}`, `\\/api\\/res1\\/${PARAM}\\/items\\/${PARAM}`]);
    const y = r();
    if (y < 0.2) return `/^${o}(?:[\\/?#]|$)/i`;
    if (y < 0.4) return `/^${o}${path}\\/?\\?(?=(?:${QUERY_CHARS}*&)?page=2(?:[&#]|$))/i`;
    return `/^${o}${path}${PATH_END}/i`;
  }
  if (x < 0.55) {
    // globs, with and without wildcards
    const port = pick(r, PORTS);
    const path = pick(r, PATHS);
    return pick(r, [
      `${scheme}://${host}${port}${path}`,
      `${scheme}://${host}${port}/*`,
      `${scheme}://${host}*`,
      `*://${host}/*`,
      `${scheme}://*${path}`,
      `*${path}*`,
      `${scheme}://${host}${port}?*`,
      `${scheme}://${host}${port}${path}*`,
      '*',
      '',
      ' * ',
    ]);
  }
  // user regexes: random concatenations of fragments
  let src = '';
  const n = 1 + Math.floor(r() * 7);
  for (let i = 0; i < n; i++) src += pick(r, FRAGMENTS);
  if (r() < 0.5) src = `^${pick(r, ['https', 'http', 'HTTPS', 'wss'])}:\\/\\/${escapeRegex(host)}${src}`;
  return `/${src}/${pick(r, FLAGS)}`;
}

function randomAction(r: () => number): RuleAction {
  const x = r();
  if (x < 0.3) return { kind: 'mock', status: 200, body: 'm' };
  if (x < 0.4) return { kind: 'block', mode: 'reset' };
  if (x < 0.5) return { kind: 'fault', fault: pick(r, ['reset', 'truncate', 'timeout'] as const) } as RuleAction;
  if (x < 0.6) return { kind: 'breakpoint', phase: pick(r, ['request', 'response', 'both'] as const) } as RuleAction;
  if (x < 0.65) return { kind: 'mutate', response: { status: 201 } } as unknown as RuleAction;
  if (x < 0.75) {
    return {
      kind: 'sequence',
      steps: [
        { action: { kind: 'mock', status: 201, body: 's1' } },
        { action: { kind: 'passthrough' }, times: 2 },
        { action: r() < 0.5 ? { kind: 'block', mode: 'reset' } : { kind: 'breakpoint', phase: 'response' } } as never,
      ],
      then: pick(r, ['last', 'passthrough', 'loop'] as const),
    } as RuleAction;
  }
  if (x < 0.85) return { kind: 'handler', handlerId: 'collection:c1', fallback: { kind: 'mock', status: 200, body: 'f' } } as RuleAction;
  if (x < 0.92) return { kind: 'grpcMock', messages: [] } as unknown as RuleAction;
  return { kind: 'throttle', downKbps: 10 } as unknown as RuleAction;
}

function randomRules(r: () => number, set: number): Rule[] {
  const n = 1 + Math.floor(r() * (r() < 0.1 ? 60 : 16));
  const out: Rule[] = [];
  for (let i = 0; i < n; i++) {
    const method = pick(r, RULE_METHODS);
    const rule: Rule = {
      id: `s${set}-r${i}`,
      enabled: r() < 0.85,
      match: { url: randomPattern(r), ...(method !== undefined ? { method } : {}), ...(r() < 0.1 ? { graphqlOperation: pick(r, ['Q', 'M']) } : {}) },
      action: randomAction(r),
    };
    if (r() < 0.15) rule.times = Math.floor(r() * 3);
    if (r() < 0.05) rule.expiresAt = Date.now() - 1000;
    out.push(rule);
  }
  return out;
}

type Matcher = { setRules(r: Rule[]): void; matchRule(m: string, u: string, o: object): Record<string, unknown> };

/** A proxy whose rules were compiled linearly (FI_PROXY_LINEAR=1 at setRules) or indexed. */
function proxyCompiled(linear: boolean): Matcher {
  const px = new InterceptProxy({ port: 0 }) as unknown as Matcher;
  const setRules = px.setRules.bind(px);
  px.setRules = (rules) => {
    const before = process.env.FI_PROXY_LINEAR;
    if (linear) process.env.FI_PROXY_LINEAR = '1';
    else delete process.env.FI_PROXY_LINEAR;
    try {
      setRules(rules);
    } finally {
      if (before === undefined) delete process.env.FI_PROXY_LINEAR;
      else process.env.FI_PROXY_LINEAR = before;
    }
  };
  return px;
}

const MATCH_OPTIONS: object[] = [
  { count: true },
  { count: false },
  { count: true, ws: true },
  { count: true, tunnel: true },
  { count: true, grpc: true },
  { count: true, grpcWeb: true },
  { count: false, ignoreGraphql: true },
  { count: true, headers: { 'content-length': '10' } },
  { count: true, headers: { 'transfer-encoding': 'chunked' } },
  { count: true, body: () => '{"operationName":"Q","query":"query Q { a }"}' },
];

function summary(m: Record<string, unknown>) {
  const rule = m.rule as Rule | undefined;
  return { rule: rule?.id, action: m.action, step: m.step, note: m.note, deferred: m.deferred, needsResponseHook: m.needsResponseHook };
}

interface Tally {
  compared: number;
  matched: number;
  /** Candidates with the path trie / with method × origin only (the trie's pruning). */
  candidates: number;
  bucket: number;
}

/**
 * One rule set against its URLs: the candidates hold every rule whose method + URL match, in order; findRule and the
 * proxy's matchRule agree with the linear scan — with the full index, with a starved trie (`maxTrieNodes` from the
 * seed: rules past it stay at a shallower node) and with no trie.
 */
function checkSet(seed: number, r: () => number, rules: Rule[], urls: string[], methods: readonly string[], px: { linear: Matcher; indexed: Matcher }, t: Tally): void {
  const linear = compileRules(rules, { linear: true });
  const indexed = compileRules(rules, { linear: false });
  const starved = compileRules(rules, { linear: false, maxTrieNodes: 1 + (seed % 5) });
  const flat = compileRules(rules, { linear: false, maxTrieNodes: 0 });
  px.linear.setRules(rules);
  px.indexed.setRules(rules);
  for (const url of urls) {
    for (const method of [pick(r, methods), pick(r, methods)]) {
      const M = method.toUpperCase();
      const lists = [indexed, starved, flat].map((c) => ruleCandidates(c, M, url));
      for (const cands of lists) {
        expect(cands, `seed ${seed}`).toBeDefined();
        for (let k = 1; k < cands!.length; k++) expect(cands![k] > cands![k - 1], `seed ${seed}: order`).toBe(true);
      }
      const sets = lists.map((l) => new Set(l));
      for (let i = 0; i < linear.length; i++) {
        if (linear[i].base(method, url)) {
          for (const inCands of sets) {
            if (!inCands.has(i)) throw new Error(`seed ${seed}: rule ${i} ${JSON.stringify(rules[i].match)} matches ${method} ${JSON.stringify(url)} but isn't a candidate`);
          }
          t.matched++;
        }
        expect(baseMatches(linear[i], M, url), `seed ${seed}`).toBe(linear[i].base(method, url));
      }
      // the trie only narrows the origin's list
      for (const i of lists[0]!) expect(sets[2].has(i), `seed ${seed}`).toBe(true);
      t.candidates += lists[0]!.length;
      t.bucket += lists[2]!.length;
      const body = r() < 0.3 ? '{"operationName":"Q"}' : undefined;
      const want = findRule(linear, method, url, body)?.id;
      for (const c of [indexed, starved, flat]) {
        if (findRule(c, method, url, body)?.id !== want) throw new Error(`seed ${seed}: findRule ${method} ${JSON.stringify(url)}: linear ${want} ≠ indexed ${findRule(c, method, url, body)?.id}`);
      }
      const o = pick(r, MATCH_OPTIONS);
      const a = summary(px.linear.matchRule(method, url, o));
      const b = summary(px.indexed.matchRule(method, url, o));
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`seed ${seed}: ${method} ${JSON.stringify(url)} ${JSON.stringify(o)}: linear ${JSON.stringify(a)} ≠ indexed ${JSON.stringify(b)}`);
      t.compared++;
    }
  }
}

describe('rule index ≡ linear scan (property test, CONTRACTS §24.5)', () => {
  it('candidates hold every rule whose method + URL match, in order; findRule and the proxy agree with the linear scan', () => {
    const SETS = 3000;
    const px = { linear: proxyCompiled(true), indexed: proxyCompiled(false) };
    const t: Tally = { compared: 0, matched: 0, candidates: 0, bucket: 0 };
    let indexedRules = 0;
    for (let set = 0; set < SETS; set++) {
      const seed = 0x5eed0000 + set;
      const r = mulberry32(seed);
      const rules = randomRules(r, set);
      indexedRules += rules.filter((x) => urlOriginKeys(x.match.url) !== undefined).length;
      const urls = Array.from({ length: 12 }, () => randomUrl(r));
      // URLs built from the rules' own origins, so hits are common
      for (const x of rules.slice(0, 4)) {
        const k = urlOriginKeys(x.match.url);
        if (k) urls.push(`${k[0]}${pick(r, PATHS)}`, `${k[0].toUpperCase()}:443${pick(r, PATHS)}`);
      }
      checkSet(seed, r, rules, urls, METHODS, px, t);
    }
    // the generator exercises both sides (not a vacuous pass)
    expect(t.compared).toBeGreaterThan(SETS * 30);
    expect(t.matched).toBeGreaterThan(SETS);
    expect(indexedRules).toBeGreaterThan(SETS * 2);
  });
});

// ---------------------------------------------------------------- path-heavy sets (the path trie)

const P_ORIGINS = ['https://api.shop.example', 'http://localhost:8080'];
/**
 * Literal segments: shared prefixes (`user` / `users` / `users5`, `res1` / `res10`), both cases, encodings, dot
 * segments, an encoded slash, and characters the `i` flag folds its own way (`ς` matches `σ`; `K` and `ſ` match
 * neither `k` nor `s`).
 */
const SEGS = [
  'api', 'api', 'api', 'API', 'v1', 'v1', 'v2', 'users', 'users', 'users', 'Users', 'USERS', 'user', 'users5', 'items', 'items', 'a', 'a', 'b', 'A', 'a.b', 'a-b',
  '5', '..', '.', '%2F', '%2f',
  'x%2Fy', 'caf%C3%A9', 'caf%c3%a9', 'café', 'CAFÉ', 'a b', 'a:b', 'k', 'K', 'ς', 'σ', 'Σ', 's', 'ſ', 'res1', 'res10', 'a+b', 'a$b', '(x)', '[x]',
];
/** What a client sends for a path parameter. */
const PARAM_VALUES = ['5', 'x', 'A', '%2F', 'a%2Fb', '..', 'é', 'users', 'items', '5.json', ''];
const PCHAR_SUBDELIMS = /%(?:21|24|26|27|28|29|2A|2B|2C|3B|3D|3A|40)/gi;
/** toRules' `flexibleLiteral` for a path segment: the literal as written and in its encodings. */
function flexibleLiteral(s: string): string {
  const enc = encodeURIComponent(s);
  const unique = [...new Set([s, enc, enc.replace(PCHAR_SUBDELIMS, (m) => decodeURIComponent(m))].map(escapeRegex))];
  return unique.length === 1 ? unique[0] : `(?:${unique.join('|')})`;
}

/** A path as a collection has it: literal segments and parameters (null), a parameter possible at every position. */
type Template = (string | null)[];

function randomTemplate(r: () => number): Template {
  const n = Math.floor(r() * (r() < 0.2 ? 9 : 5));
  const paramRate = pick(r, [0, 0.15, 0.3, 0.6]);
  return Array.from({ length: n }, () => (r() < paramRate ? null : pick(r, SEGS)));
}

/** How the segments of a user's regex may be joined and ended: the proven shapes and every near miss. */
const P_SEPARATORS = ['/', '\\/+', '\\/+', '\\/+', '\\/?', '\\/*', '\\/\\/', '[/]', '(?:\\/)', '\\/{1}', '\\/{1,2}', '[\\/?#]', '.', '\\/+?'];
const P_ENDS = [
  '', PATH_END, PATH_END, '$', '\\/?$', '\\/$', '\\/', '\\/+$', '\\/*$', '\\/??$', '(?:[\\/?#]|$)', '[?#]', '\\?', '\\#', '\\?x=1', '(?:\\?|$)', '(?:\\/|$)',
  '\\/?(?:[?#]|$)?', '\\/?(?:[?#]|$)*', '(?:[?#]|$)x', '\\/?(?:[?#]|x)', '\\/{0}$', '\\/{2}$', '\\/?\\/?$', '(?:\\/?$)', '(?:$|\\/$)', '(?:$)?', '$|x',
  '.*', '.', '\\b', '(?=\\/|$)', '(?:)', '()', '[^/]', '[?#]?', '\\??$', '\\/?[?#]+', 's?$', '5', '\\/\\/$', '\\/\\.$', `\\/${PARAM}$`, `${PARAM}$`,
];
const P_FLAGS = ['', '', '', 'i', 'i', 'i', 's', 'g', 'iy', 'id', 'm', 'iu', 'u'];
const P_GLOB_ENDS = ['', '', '*', '*', '/*', '/*', '/', '?*', '?page=2', '#f', '//', '//*', '/?*', '*?x', '/*/', '?', '#', '*/', '/*#f'];

function randomPathPattern(r: () => number, t: Template): string {
  const origin = pick(r, P_ORIGINS);
  const u = new URL(origin);
  const scheme = u.protocol.slice(0, -1) as 'http' | 'https';
  const x = r();
  if (x < 0.4) {
    // toRules: an endpoint or a query example, literals in their encodings
    const base = `^${toRulesOrigin(scheme, u.hostname, u.port || undefined)}${t.map((s) => `\\/${s === null ? PARAM : flexibleLiteral(s)}`).join('')}`;
    return r() < 0.25 ? `/${base}\\/?\\?(?=(?:${QUERY_CHARS}*&)?page=2(?:[&#]|$))/i` : `/${base}${PATH_END}/i`;
  }
  if (x < 0.65) {
    // a glob: the literal path, `*` for a parameter
    const o = r() < 0.15 ? origin.toUpperCase() : r() < 0.15 && scheme === 'https' ? `${origin}:443` : origin;
    return `${o}${t.map((s) => `/${s ?? '*'}`).join('')}${pick(r, P_GLOB_ENDS)}`;
  }
  // a user's regex: plain literals (never decoded, never grouped), odd separators, quantifiers, any ending and flags
  let src = `^${r() < 0.5 ? toRulesOrigin(scheme, u.hostname, u.port || undefined) : escapeRegex(origin)}`;
  const odd = r() < 0.3 ? Math.floor(r() * t.length) : -1; // one separator that isn't a plain slash
  t.forEach((s, at) => {
    src += at === odd ? pick(r, P_SEPARATORS) : '\\/';
    if (s === null) src += pick(r, [PARAM, PARAM, '[^/]+', '\\d+', '.*', '[^/?#]*', '(?:a|b)', '\\w+']);
    else {
      const y = r();
      const lit = r() < 0.5 ? escapeRegex(s) : s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'); // `/` and `-` unescaped
      if (y < 0.8) src += lit;
      else if (y < 0.86) src += `${lit}${pick(r, ['?', '+', '*', '{2}', '{0,1}', '??'])}`;
      else if (y < 0.9) src += `(${lit})`;
      else if (y < 0.94) src += `(?:${lit}|x)`;
      else if (y < 0.97) src += `[${escapeRegex(s[0])}]${escapeRegex(s.slice(1))}`;
      else src += flexibleLiteral(s);
    }
  });
  return `/${src}${pick(r, P_ENDS)}/${pick(r, P_FLAGS)}`;
}

function randomCase(r: () => number, s: string): string {
  const x = r();
  if (x < 0.4) return s;
  if (x < 0.55) return s.toUpperCase();
  if (x < 0.7) return s.toLowerCase();
  return [...s].map((c) => (r() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');
}

/** What may follow the path: nothing, a trailing slash, an empty or a dot segment, a query or a fragment (with slashes in them). */
const P_TAILS = ['', '', '', '/', '/', '//', '?', '?page=2', '?x=1&page=2', '/?page=2', '#f', '/#f', '#', '?a=/users/5', '#/users/5', '/.', '/..', '%2F', ';v=1', '/?', '//?x', '?#', '\n'];

function randomPathUrl(r: () => number, templates: Template[]): string {
  let origin = pick(r, P_ORIGINS);
  const x = r();
  if (x < 0.1) origin = origin.toUpperCase();
  else if (x < 0.2 && origin.startsWith('https')) origin += ':443';
  else if (x < 0.23) origin = 'https://other.example';
  let segs: string[];
  if (templates.length > 0 && r() < 0.75) {
    // a request for one of the rules' own paths, then bent
    segs = pick(r, templates).map((s) => (s === null ? pick(r, PARAM_VALUES) : r() < 0.1 ? encodeURIComponent(s) : randomCase(r, s)));
    const y = r();
    if (y < 0.1) segs.pop();
    else if (y < 0.2) segs.push(pick(r, SEGS));
    else if (y < 0.26) segs.splice(Math.floor(r() * (segs.length + 1)), 0, pick(r, ['', '.', '..', '%2F']));
    else if (y < 0.3 && segs.length > 0) segs[Math.floor(r() * segs.length)] += pick(r, ['5', 's', '%2F', '.', 'x']);
    if (r() < 0.15) segs.splice(Math.floor(r() * (segs.length + 1)), 0, ''); // a doubled slash anywhere
  } else segs = Array.from({ length: Math.floor(r() * 5) }, () => randomCase(r, pick(r, SEGS)));
  return `${origin}${segs.map((s) => `/${s}`).join('')}${pick(r, P_TAILS)}`;
}

describe('rule index ≡ linear scan, path-heavy sets (property test, CONTRACTS §24.5: the path trie)', () => {
  it('deep and shared literal paths, parameters anywhere, encodings, cases, empty and dot segments, queries after any segment', () => {
    const SETS = 3000;
    const px = { linear: proxyCompiled(true), indexed: proxyCompiled(false) };
    const t: Tally = { compared: 0, matched: 0, candidates: 0, bucket: 0 };
    let keyed = 0;
    let exact = 0;
    for (let set = 0; set < SETS; set++) {
      const seed = 0x7a7e0000 + set;
      const r = mulberry32(seed);
      // a few path families per set, so rules share prefixes and requests land on several of them
      const families = Array.from({ length: 1 + Math.floor(r() * 4) }, () => randomTemplate(r));
      const n = 1 + Math.floor(r() * (r() < 0.1 ? 60 : 20));
      const templates: Template[] = [];
      const rules: Rule[] = [];
      for (let i = 0; i < n; i++) {
        const f = pick(r, families);
        // the family's path, a prefix of it, or a longer one
        const tpl = r() < 0.5 ? f : r() < 0.5 ? f.slice(0, Math.floor(r() * (f.length + 1))) : [...f, ...randomTemplate(r)];
        templates.push(tpl);
        const method = pick(r, [undefined, 'GET', 'GET', 'get', 'POST', '*']);
        const rule: Rule = {
          id: `p${set}-r${i}`,
          enabled: r() < 0.9,
          match: { url: randomPathPattern(r, tpl), ...(method !== undefined ? { method } : {}), ...(r() < 0.05 ? { graphqlOperation: 'Q' } : {}) },
          action: randomAction(r),
        };
        if (r() < 0.1) rule.times = Math.floor(r() * 3);
        rules.push(rule);
        const k = urlIndexKey(rule.match.url)?.path;
        if (k && k.segs.length > 0) keyed++;
        if (k?.exact) exact++;
      }
      const urls = Array.from({ length: 16 }, () => randomPathUrl(r, templates));
      checkSet(seed, r, rules, urls, ['GET', 'GET', 'get', 'POST', 'PUT'], px, t);
    }
    // not a vacuous pass: rules are keyed by path, requests hit them, and the trie drops rules the origin alone keeps
    expect(t.compared).toBeGreaterThan(SETS * 30);
    expect(t.matched).toBeGreaterThan(SETS * 10);
    expect(keyed).toBeGreaterThan(SETS * 3);
    expect(exact).toBeGreaterThan(SETS * 2);
    expect(t.candidates).toBeLessThan(t.bucket * 0.85);
  });
});
