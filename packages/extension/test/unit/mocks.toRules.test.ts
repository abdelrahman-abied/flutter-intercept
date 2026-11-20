// CONTRACTS §21.5 (M3): collection endpoints → mock rules, checked against the real proxy matcher.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Rule } from '@flutter-intercept/proxy';
import { compileRules, findRule, isInvalidMatcher, isSafeRegexSource, simplifyRegexSource } from '@flutter-intercept/proxy/rules';
import { cutMiddle, displayPath, escapeRegex, MAX_SOURCE, toRules } from '../../src/mocks/toRules';
import type { MockEndpoint, MockExample, ParsedCollection, ToRulesOptions } from '../../src/mocks/types';
import { validateRule } from '../../src/ui/validate';

const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'collections', 'shop.expected.json'), 'utf8'));

function collection(endpoints: MockEndpoint[], name = 'Shop API'): ParsedCollection {
  return { format: 'postman', name, endpoints, variables: [], problems: [] };
}
const postman = (): ParsedCollection => collection(expected.postman.endpoints);
const openapi = (): ParsedCollection => ({ ...collection(expected.openapi.endpoints), format: 'openapi' });
const opts = (o: Partial<ToRulesOptions> = {}): ToRulesOptions => ({ id: 'shop', name: 'Shop API', selected: {}, off: [], unmatched: 'passthrough', ...o });

function ep(path: MockEndpoint['path'], examples: MockExample[] = [ex()], extra: Partial<MockEndpoint> = {}): MockEndpoint {
  const key = `GET ${displayPath({ path })}`;
  return { key, method: 'GET', name: key, folder: [], origin: 'https://api.test', path, examples, unresolved: [], ...extra };
}
function ex(name = 'OK', status = 200, extra: Partial<MockExample> = {}): MockExample {
  return { name, status, headers: {}, body: name, ...extra };
}

/** What the proxy answers for this request with these rules: the first match, as the proxy does it. */
function answer(rules: Rule[], method: string, url: string): Rule | undefined {
  return findRule(compileRules(rules), method, url);
}
function body(rules: Rule[], method: string, url: string): string | undefined {
  const r = answer(rules, method, url);
  return r?.action.kind === 'mock' ? r.action.body : r ? `<${r.action.kind}>` : undefined;
}

/** Every rule is valid for the panel's validator and safe for the proxy (a refused regex would never match). */
function expectValid(rules: Rule[]): void {
  for (const r of rules) {
    expect(() => validateRule(structuredClone(r)), r.name).not.toThrow();
    expect(isInvalidMatcher(r.match), `${r.name}: ${r.match.url}`).toBe(false);
    const lit = /^\/(.+)\/([a-z]*)$/s.exec(r.match.url);
    if (lit) {
      expect(lit[1].length, r.match.url).toBeLessThanOrEqual(MAX_SOURCE);
      expect(isSafeRegexSource(simplifyRegexSource(lit[1])), r.match.url).toBe(true);
    }
  }
}

describe('toRules on the Postman fixture', () => {
  const { rules, stats, problems } = toRules(postman(), opts());

  it('every rule is valid and safe', () => {
    expectValid(rules);
    expect(problems).toEqual([]);
  });

  it('stats', () => {
    expect(stats).toEqual({ endpoints: 11, mocked: 8, noExample: 2, unresolved: 1, off: 0, generated: 0, tooLong: 0 });
  });

  it('ids, names, enabled, never shared', () => {
    expect(rules.map((r) => r.id)).toEqual(rules.map((_, i) => `collection:shop:${i + 1}`));
    for (const r of rules) {
      expect(r.enabled).toBe(true);
      expect(r.shared).toBeUndefined();
      expect(r.name!.startsWith('Shop API › ')).toBe(true);
    }
    expect(rules.map((r) => r.name)).toContain('Shop API › Log in · Success');
  });

  it('answers each request from its example', () => {
    expect(body(rules, 'POST', 'https://api.shop.example/auth/login')).toContain('"token": "abc"');
    expect(body(rules, 'GET', 'https://api.shop.example/users/me')).toBe('{"id":1,"name":"Sara"}');
    expect(body(rules, 'GET', 'https://api.shop.example/users/42')).toBe('{"id":42,"name":"Lina"}');
    expect(answer(rules, 'DELETE', 'https://api.shop.example/users/42')?.action).toMatchObject({ status: 204, body: '' });
    expect(body(rules, 'GET', 'https://api.shop.example/v2/orders/7/items')).toBe('[{"sku":"A1","qty":2}]');
    expect(body(rules, 'GET', 'https://cdn.shop.example/config.json')).toBe('{"theme":"dark"}');
    expect(body(rules, 'GET', 'https://api.shop.example/health')).toBe('ok');
  });

  it('keeps the example headers', () => {
    expect(answer(rules, 'GET', 'https://cdn.shop.example/config.json')?.action).toMatchObject({
      headers: { 'content-type': 'application/json', 'x-tag': 'a, b', 'set-cookie': 'a=1' },
    });
  });

  it('matches the default port, a trailing slash, a query and a fragment, and any letter case', () => {
    expect(body(rules, 'GET', 'https://cdn.shop.example:443/config.json')).toBe('{"theme":"dark"}');
    expect(body(rules, 'GET', 'https://api.shop.example/users/me/')).toBe('{"id":1,"name":"Sara"}');
    expect(body(rules, 'GET', 'https://api.shop.example/users/me?x=1#top')).toBe('{"id":1,"name":"Sara"}');
    expect(body(rules, 'GET', 'https://API.Shop.Example/users/42')).toBe('{"id":42,"name":"Lina"}');
  });

  it('matches nothing else', () => {
    expect(answer(rules, 'GET', 'https://api.shop.example/users/42/extra')).toBeUndefined();
    expect(answer(rules, 'GET', 'https://api.shop.example/userss')).toBeUndefined();
    expect(answer(rules, 'GET', 'https://api.shop.example.evil.test/users/me')).toBeUndefined();
    expect(answer(rules, 'GET', 'http://api.shop.example/users/me')).toBeUndefined();
    expect(answer(rules, 'GET', 'https://api.shop.example:8443/users/me')).toBeUndefined();
    expect(answer(rules, 'PUT', 'https://api.shop.example/users/42')).toBeUndefined();
    expect(answer(rules, 'GET', 'https://api.shop.example/users/' + 'x'.repeat(101))).toBeUndefined();
    expect(body(rules, 'GET', 'https://api.shop.example/users/' + 'x'.repeat(100))).toBe('{"id":42,"name":"Lina"}');
  });

  it('a request with no example answers 501 with a readable message and the marker header', () => {
    const a = answer(rules, 'POST', 'https://api.shop.example/auth/refresh')!.action;
    expect(a).toMatchObject({ kind: 'mock', status: 501, headers: { 'content-type': 'application/json; charset=utf-8', 'x-flutter-intercept': 'no-example' } });
    expect(JSON.parse((a as { body: string }).body)).toEqual({
      error: 'no_example',
      message: 'No example response is saved for POST /auth/refresh in Shop API. Add an example to the collection, or mock this request with a rule.',
    });
    expect(answer(rules, 'POST', 'https://api.shop.example/auth/refresh')!.name).toBe('Shop API › Refresh · no example');
  });

  it('a duplicate endpoint is tried after the first (file order)', () => {
    const names = rules.filter((r) => /Health/.test(r.name!)).map((r) => r.name);
    expect(names).toEqual(['Shop API › Health · Up', 'Shop API › Health (copy) · no example']);
  });

  it('an endpoint with an unresolved variable gets no rule', () => {
    expect(rules.some((r) => r.name!.includes('Analytics'))).toBe(false);
  });

  it('/users/me is tried before /users/:id', () => {
    const me = rules.findIndex((r) => r.name === 'Shop API › Me · OK');
    const byId = rules.findIndex((r) => r.name === 'Shop API › User by id · Found');
    expect(me).toBeGreaterThanOrEqual(0);
    expect(me).toBeLessThan(byId);
  });
});

describe('choosing the example', () => {
  it('by query parameters (§21.2 MockExample.query)', () => {
    const { rules } = toRules(postman(), opts());
    expect(body(rules, 'GET', 'https://api.shop.example/users?page=2')).toBe('[]');
    expect(body(rules, 'GET', 'https://api.shop.example/users?sort=new&page=2#x')).toBe('[]');
    expect(body(rules, 'GET', 'https://api.shop.example/users/?page=2')).toBe('[]');
    expect(body(rules, 'GET', 'https://api.shop.example/users?page=22')).toBe('[{"id":1,"name":"Sara"},{"id":2,"name":"Omar"}]');
    expect(body(rules, 'GET', 'https://api.shop.example/users?xpage=2')).toBe('[{"id":1,"name":"Sara"},{"id":2,"name":"Omar"}]');
    expect(body(rules, 'GET', 'https://api.shop.example/users')).toBe('[{"id":1,"name":"Sara"},{"id":2,"name":"Omar"}]');
  });

  it('the selected example answers by default', () => {
    const { rules, problems } = toRules(postman(), opts({ selected: { 'POST {{baseUrl}}/auth/login': 'Wrong password' } }));
    expect(problems).toEqual([]);
    expect(answer(rules, 'POST', 'https://api.shop.example/auth/login')?.action).toMatchObject({ status: 401, body: '{"error":"invalid_credentials"}' });
  });

  it('a selection that no longer exists falls back with a problem', () => {
    const { rules, problems } = toRules(postman(), opts({ selected: { 'POST {{baseUrl}}/auth/login': 'Gone' } }));
    expect(answer(rules, 'POST', 'https://api.shop.example/auth/login')?.action).toMatchObject({ status: 200 });
    expect(problems).toEqual(['POST /auth/login: the selected example "Gone" isn\'t in the collection any more; "Success" answers instead']);
  });

  it('without a selection: the first 2xx, else the first', () => {
    const { rules } = toRules(collection([ep(['a'], [ex('Bad', 500), ex('Fine', 201), ex('Also', 200)]), ep(['b'], [ex('Nope', 404), ex('Worse', 500)])]), opts());
    expect(body(rules, 'GET', 'https://api.test/a')).toBe('Fine');
    expect(body(rules, 'GET', 'https://api.test/b')).toBe('Nope');
  });

  it('more query parameters first; at most two per example', () => {
    const e = ep(['items'], [ex('Default'), ex('Page 2', 200, { query: { page: '2' } }), ex('Page 2 new', 200, { query: { page: '2', sort: 'new' } }), ex('Three', 200, { query: { a: '1', b: '2', c: '3' } })]);
    const { rules, problems } = toRules(collection([e]), opts());
    expectValid(rules);
    expect(body(rules, 'GET', 'https://api.test/items?sort=new&page=2')).toBe('Page 2 new');
    expect(body(rules, 'GET', 'https://api.test/items?page=2')).toBe('Page 2');
    expect(body(rules, 'GET', 'https://api.test/items?b=2&a=1')).toBe('Three');
    expect(body(rules, 'GET', 'https://api.test/items')).toBe('Default');
    expect(problems).toEqual(['GET /items: example "Three" is chosen by a and b only (at most 2 query parameters)']);
  });

  it('query values are compared literally and in their encoded form', () => {
    const { rules } = toRules(collection([ep(['s'], [ex('Default'), ex('Spaced', 200, { query: { q: 'a b&c' } })])]), opts());
    expectValid(rules);
    expect(body(rules, 'GET', 'https://api.test/s?q=a%20b%26c')).toBe('Spaced');
    expect(body(rules, 'GET', 'https://api.test/s?q=a%20b')).toBe('Default');
  });
});

describe('off and unmatched', () => {
  it('an endpoint that is off gets no rule; a more general one may answer it', () => {
    const { rules, stats } = toRules(postman(), opts({ off: ['GET {{baseUrl}}/users/me'] }));
    expect(stats.off).toBe(1);
    expect(stats.mocked).toBe(7);
    expect(body(rules, 'GET', 'https://api.shop.example/users/me')).toBe('{"id":42,"name":"Lina"}');
  });

  it('passthrough (default): requests the collection does not know get no rule', () => {
    const { rules } = toRules(postman(), opts());
    expect(answer(rules, 'GET', 'https://api.shop.example/unknown')).toBeUndefined();
    expect(rules.some((r) => r.action.kind === 'block')).toBe(false);
  });

  it('fail: one last reset rule per origin of the collection, any method', () => {
    const { rules } = toRules(postman(), opts({ unmatched: 'fail' }));
    expectValid(rules);
    const blocks = rules.filter((r) => r.action.kind === 'block');
    expect(blocks.map((r) => r.match.url)).toEqual(['/^https:\\/\\/api\\.shop\\.example(?::443)?(?:[\\/?#]|$)/i', '/^https:\\/\\/cdn\\.shop\\.example(?::443)?(?:[\\/?#]|$)/i']);
    expect(rules.slice(-2)).toEqual(blocks);
    for (const b of blocks) {
      expect(b.action).toEqual({ kind: 'block', mode: 'reset' });
      expect(b.match.method).toBeUndefined();
      expect(b.name).toBe('Shop API › not in the collection');
    }
    expect(body(rules, 'PATCH', 'https://api.shop.example/unknown')).toBe('<block>');
    expect(body(rules, 'GET', 'https://api.shop.example')).toBe('<block>');
    expect(body(rules, 'GET', 'https://api.shop.example?x')).toBe('<block>');
    expect(body(rules, 'GET', 'https://cdn.shop.example/other.json')).toBe('<block>');
    expect(answer(rules, 'GET', 'https://api.shop.example.evil.test/x')).toBeUndefined();
    expect(answer(rules, 'GET', 'https://stats.shop.example/collect')).toBeUndefined();
    expect(body(rules, 'GET', 'https://api.shop.example/users/me')).toBe('{"id":1,"name":"Sara"}');
  });

  it('fail also covers an endpoint that is off (nothing reaches the real server)', () => {
    const { rules } = toRules(collection([ep(['only'])]), opts({ unmatched: 'fail', off: ['GET /only'] }));
    expect(body(rules, 'GET', 'https://api.test/only')).toBe('<block>');
  });
});

describe('OpenAPI fixture', () => {
  it('generated examples are counted, origins and path prefixes match', () => {
    const { rules, stats, problems } = toRules(openapi(), opts());
    expectValid(rules);
    expect(problems).toEqual([]);
    expect(stats).toEqual({ endpoints: 6, mocked: 6, noExample: 0, unresolved: 0, off: 0, generated: 2, tooLong: 0 });
    expect(answer(rules, 'GET', 'https://api.shop.example/v1/users/7')?.action).toMatchObject({ status: 200 });
    expect(answer(rules, 'POST', 'https://orders.shop.example/orders')?.action).toMatchObject({ status: 201, headers: { location: '/orders/7' } });
    expect(answer(rules, 'GET', 'https://api.shop.example/users/7')).toBeUndefined();
  });
});

describe('hostile input', () => {
  it('regex characters in segments are literals', () => {
    const seg = 'a.b(c)*[x]{2}|\\^$+?/';
    const { rules } = toRules(collection([ep([seg, { param: 'id' }])]), opts());
    expectValid(rules);
    expect(body(rules, 'GET', `https://api.test/${encodeURIComponent(seg)}/1`)).toBe('OK');
    expect(answer(rules, 'GET', 'https://api.test/aXb(c)[x]xx/1')).toBeUndefined();
    expect(answer(rules, 'GET', 'https://api.test/abc/1')).toBeUndefined();
  });

  it('non-ASCII and spaces match literally and percent-encoded', () => {
    const { rules } = toRules(collection([ep(['مستخدمين', 'a b'])]), opts());
    expectValid(rules);
    expect(body(rules, 'GET', `https://api.test/${encodeURIComponent('مستخدمين')}/a%20b`)).toBe('OK');
    expect(body(rules, 'GET', 'https://api.test/مستخدمين/a b')).toBe('OK');
  });

  it('REVIEW-15 #3: a URL too long for an exact pattern is not mocked (never a looser pattern)', () => {
    const long = ep(['segment'.repeat(30), { param: 'id' }, 'tail']);
    const { rules, stats, problems } = toRules(collection([long, ep(['other'])]), opts());
    expectValid(rules);
    expect(stats.tooLong).toBe(1);
    expect(stats.mocked).toBe(1);
    expect(rules.map((r) => r.match.url).every((u) => u.startsWith('/^'))).toBe(true);
    expect(problems).toEqual([
      `GET /${'segment'.repeat(30)}/:id/tail: the URL is too long to match exactly (a rule's pattern is limited to 256 characters), so it isn't mocked; mock it with a rule instead`,
    ]);
    expect(answer(rules, 'GET', `https://api.test/${'segment'.repeat(30)}/9/tail`)).toBeUndefined();
    expect(answer(rules, 'GET', 'https://api.test/segment')).toBeUndefined();
  });

  it('a query example whose pattern is too long is dropped; the default rule stays', () => {
    const e = ep(['s'.repeat(180)], [ex('Default'), ex('Q', 200, { query: { a: 'v'.repeat(60) } })]);
    const { rules, problems } = toRules(collection([e]), opts());
    expectValid(rules);
    expect(rules).toHaveLength(1);
    expect(body(rules, 'GET', `https://api.test/${'s'.repeat(180)}?a=${'v'.repeat(60)}`)).toBe('Default');
    expect(problems[0]).toContain("can't be chosen by its query parameters (too long)");
  });

  it('REVIEW-15 #3: an Arabic path segment is matched exactly (raw and percent-encoded), never as a prefix', () => {
    const seg = 'منتجات-جديدة-للبيع';
    const { rules, stats } = toRules(collection([ep(['products', seg])]), opts());
    expectValid(rules);
    expect(stats.tooLong).toBe(0);
    expect(body(rules, 'GET', `https://api.test/products/${encodeURIComponent(seg)}`)).toBe('OK');
    expect(body(rules, 'GET', `https://api.test/products/${encodeURIComponent(seg).toLowerCase()}`)).toBe('OK');
    expect(body(rules, 'GET', `https://api.test/products/${seg}`)).toBe('OK');
    expect(answer(rules, 'GET', 'https://api.test/products/1')).toBeUndefined();
    expect(answer(rules, 'GET', 'https://api.test/products/a/b/c')).toBeUndefined();
    // three Arabic segments still fit
    const three = toRules(collection([ep(['منتجات', 'جديدة', { param: 'id' }, 'تفاصيل'])]), opts());
    expect(three.stats.tooLong).toBe(0);
  });

  it("Dart's encodings: path sub-delims kept or encoded, query spaces as + or %20", () => {
    const { rules } = toRules(collection([ep(['a:b@c$d,e'], [ex('D'), ex('Q', 200, { query: { q: 'x y' } })])]), opts());
    expectValid(rules);
    expect(body(rules, 'GET', 'https://api.test/a:b@c$d,e')).toBe('D');
    expect(body(rules, 'GET', `https://api.test/${encodeURIComponent('a:b@c$d,e')}`)).toBe('D');
    expect(body(rules, 'GET', 'https://api.test/a:b@c$d,e?q=x+y')).toBe('Q');
    expect(body(rules, 'GET', 'https://api.test/a:b@c$d,e?q=x%20y')).toBe('Q');
  });

  it('REVIEW-15 #3: wildcard or odd hosts and methods never become rules', () => {
    const { rules, problems, stats } = toRules(
      collection([
        ep(['a'], [ex()], { origin: 'https://*' }),
        ep(['b'], [ex()], { origin: 'https://*.example.com' }),
        ep(['c'], [ex()], { origin: 'https://user:pw@api.test' }),
        ep(['d'], [ex()], { method: '*' }),
        ep(['e'], [ex()], { origin: 'http://[::1]:8080' }),
        ep(['f'], [ex()], { origin: 'http://10.0.2.2:3000' }),
      ]),
      opts({ unmatched: 'fail' }),
    );
    expectValid(rules);
    expect(stats.unresolved).toBe(3);
    expect(problems).toHaveLength(4);
    expect(rules.some((r) => r.match.method === '*' || /\*/.test(r.match.url.replace(/\\\*/g, '')))).toBe(false);
    expect(body(rules, 'GET', 'http://[::1]:8080/e')).toBe('OK');
    expect(body(rules, 'GET', 'http://10.0.2.2:3000/f')).toBe('OK');
    expect(answer(rules, 'GET', 'https://accounts.google.com/a')).toBeUndefined();
  });

  it('invalid header names and values are left out with one problem; __proto__ stays a header', () => {
    const headers = JSON.parse('{"__proto__":"x","good":"1","bad name":"2","x-crlf":"a\\r\\nInjected: 1"}');
    const { rules, problems } = toRules(collection([ep(['h'], [ex('H', 200, { headers })])]), opts());
    expectValid(rules);
    const h = (rules[0].action as { headers: Record<string, string> }).headers;
    expect(Object.keys(h)).toEqual(['__proto__', 'good']);
    expect(Object.getPrototypeOf(h)).toBe(Object.prototype);
    expect(problems).toEqual(['GET /h: headers "bad name", "x-crlf" can\'t be sent (invalid name or value) and were left out']);
  });

  it('an example with an invalid status is left out', () => {
    const { rules, problems } = toRules(collection([ep(['s'], [ex('Bad', 700), ex('Good', 200)])]), opts());
    expect(body(rules, 'GET', 'https://api.test/s')).toBe('Good');
    expect(problems).toEqual(['GET /s: 1 example(s) with an invalid status or body left out']);
  });

  it('origins that are not http(s) and methods that are not tokens get no rule', () => {
    const { rules, problems, stats } = toRules(
      collection([ep(['a'], [ex()], { origin: 'ftp://x.test' }), ep(['b'], [ex()], { origin: 'not a url' }), ep(['c'], [ex()], { method: 'GE T' })]),
      opts(),
    );
    expect(rules).toEqual([]);
    expect(stats.unresolved).toBe(2);
    expect(problems).toHaveLength(3);
  });

  it('long names are cut in the middle to 200 characters', () => {
    const { rules } = toRules(collection([ep(['n'], [ex('E'.repeat(300))], { name: 'N'.repeat(300) })], 'C'.repeat(50)), opts({ name: 'C'.repeat(50) }));
    expect(rules[0].name!.length).toBe(200);
    expect(rules[0].name!.startsWith('CCCC')).toBe(true);
    expect(rules[0].name!.endsWith('EEEE')).toBe(true);
    expect(cutMiddle('short')).toBe('short');
  });

  it('a non-default port is required as written', () => {
    const { rules } = toRules(collection([ep(['p'], [ex()], { origin: 'http://localhost:8080' })]), opts());
    expectValid(rules);
    expect(body(rules, 'GET', 'http://localhost:8080/p')).toBe('OK');
    expect(answer(rules, 'GET', 'http://localhost/p')).toBeUndefined();
    expect(answer(rules, 'GET', 'http://localhost:80/p')).toBeUndefined();
  });

  it('escapeRegex leaves nothing special', () => {
    const all = '\\^$.*+?()[]{}|/-';
    expect(new RegExp(`^${escapeRegex(all)}$`).test(all)).toBe(true);
  });
});

describe('fuzz: every generated rule is safe, valid, matches its own URL and stays fast', () => {
  // A small deterministic generator (no Math.random: failures must be reproducible).
  let seed = 0x2f6e2b1;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pool = Array.from('abcXYZ019-._~!$&\'()*+,;=:@%/?#[]{}|\\^ "<>`é中🙂'); // whole characters, not UTF-16 halves
  const segment = () => Array.from({ length: 1 + rnd(12) }, () => pool[rnd(pool.length)]).join('');
  const hosts = ['https://api.test', 'http://localhost:8080', 'https://a-b.c.d.example', 'http://10.0.2.2:3000'];

  it('600 random endpoints', () => {
    for (let n = 0; n < 600; n++) {
      const segs: MockEndpoint['path'] = Array.from({ length: rnd(7) }, () => (rnd(3) === 0 ? { param: `p${rnd(9)}` } : segment()));
      const examples = [ex('D')];
      if (rnd(2)) examples.push(ex('Q', 200, { query: { [segment()]: segment(), ...(rnd(2) ? { [segment()]: segment() } : {}) } }));
      const e = ep(segs, examples, { origin: hosts[rnd(hosts.length)], method: ['GET', 'POST', 'DELETE'][rnd(3)] });
      const { rules, stats } = toRules(collection([e]), opts({ unmatched: rnd(2) ? 'fail' : 'passthrough' }));
      expectValid(rules);
      if (stats.tooLong) continue;
      const url = `${e.origin}/${segs.map((s) => (typeof s === 'string' ? encodeURIComponent(s) : `v${rnd(1000)}`)).join('/')}`;
      const def = rules.find((r) => r.name!.endsWith('· D'))!;
      expect(answer([def], e.method, url), `${def.match.url}\n${url}`).toBe(def);
      const q = examples[1]?.query;
      const qRule = rules.find((r) => r.name!.endsWith('· Q'));
      if (q && qRule) {
        const qs = Object.entries(q).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        expect(answer(rules, e.method, `${url}?zz=1&${qs}`), `${qRule.match.url}`).toBe(qRule);
      }
    }
  });

  it('hostile URLs against many rules: < 5 ms per request', () => {
    const endpoints = Array.from({ length: 300 }, (_, i) =>
      ep(['users', { param: 'id' }, `s${i}`, { param: 'x' }], [ex('D'), ex('Q', 200, { query: { page: String(i), sort: 'new' } })], { key: `k${i}` }),
    );
    const compiled = compileRules(toRules(collection(endpoints), opts({ unmatched: 'fail' })).rules);
    const hostile = [
      `https://api.test/users/${'a'.repeat(4000)}`,
      `https://api.test/users/1/s1/${'x/'.repeat(2000)}`,
      `https://api.test/users/1/s1/2?${'a=b&'.repeat(1000)}page=1`,
      `https://api.test/${'%'.repeat(4000)}`,
      `https://api.test/users/1/s299/2?${'&'.repeat(4000)}`,
    ];
    const t = performance.now();
    for (let i = 0; i < 10; i++) for (const u of hostile) findRule(compiled, 'GET', u);
    expect((performance.now() - t) / (10 * hostile.length)).toBeLessThan(5);
  });
});

// CONTRACTS §24 preamble (part 3): which rules get a handler for the answer pipeline.
describe('pipeline option (§24)', () => {
  const handlerId = 'collection:shop';
  const kinds = (rules: Rule[]) => rules.map((r) => r.action.kind);
  const login = (): MockEndpoint => ({ ...ep(['auth', 'login'], [ex('Success'), ex('Wrong password', 401)]), key: 'POST /auth/login', method: 'POST', name: 'Log in' });

  it('without the option, or when nothing needs the host: plain mock rules', () => {
    const c = collection([ep(['health']), login()]);
    expect(kinds(toRules(c, opts()).rules)).toEqual(['mock', 'mock']);
    const r = toRules(c, { ...opts(), pipeline: { handlerId, auth: new Set(), body: new Set(), vars: new Map() } });
    expect(kinds(r.rules)).toEqual(['mock', 'mock']);
    expect([...r.meta.values()].every((m) => m.needs === undefined)).toBe(true);
    expect(r.rules.map((x) => x.id)).toEqual(toRules(c, opts()).rules.map((x) => x.id));
  });

  it('auth, body and dynamic each make the default rule a handler rule with the static answer as fallback', () => {
    const c = collection([
      ep(['health']),
      login(),
      ep(['me']),
      ep(['config'], [ex('OK', 200, { body: '{"id":"{{$guid}}"}', headers: { 'content-type': 'application/json' } })]),
      ep(['plain'], [ex('OK', 200, { body: '{"note":"{{unknown}} stays"}' })]),
      ep(['hdr'], [ex('OK', 200, { headers: { 'x-request-id': '{{$guid}}' } })]),
      ep(['cookie'], [ex('OK', 200, { headers: { 'set-cookie': 'sid={{$guid}}' } })]),
      ep(['var'], [ex('OK', 200, { body: 'at {{region}}' })]),
    ]);
    const r = toRules(c, { ...opts(), pipeline: { handlerId, auth: new Set(['GET /me', 'POST /auth/login']), body: new Set(['POST /auth/login']), vars: new Map([['region', 'eu']]) } });
    const by = (key: string) => {
      const [id, meta] = [...r.meta].find(([, m]) => m.endpoint === key)!;
      return { rule: r.rules.find((x) => x.id === id)!, meta };
    };
    expect(by('GET /health').rule.action.kind).toBe('mock');
    expect(by('GET /plain').rule.action.kind).toBe('mock'); // a {{name}} nobody can fill in needs no handler
    expect(by('GET /cookie').rule.action.kind).toBe('mock'); // a header an approval is about is never rendered
    expect(by('POST /auth/login')).toMatchObject({ rule: { name: 'Shop API › Log in · Success', action: { kind: 'handler', handlerId, fallback: { kind: 'mock', status: 200, body: 'Success' } } }, meta: { example: 'Success', needs: { auth: true, body: true } } });
    expect(by('GET /me').meta.needs).toEqual({ auth: true });
    expect(by('GET /config').meta.needs).toEqual({ dynamic: true });
    expect(by('GET /hdr').meta.needs).toEqual({ dynamic: true });
    expect(by('GET /var').meta.needs).toEqual({ dynamic: true });
    // same ids and order as the static rules; every rule is one the proxy accepts
    expect(r.rules.map((x) => x.id)).toEqual(toRules(c, opts()).rules.map((x) => x.id));
    for (const rule of r.rules) expect(isInvalidMatcher(rule.match), rule.name).toBe(false);
  });

  it('a chosen example stays static (it beats the gate and the examples by body) but keeps its dynamic values', () => {
    const c = collection([login(), ep(['config'], [ex('OK', 200, { body: '{{$guid}}' }), ex('Down', 503)])]);
    const pipeline = { handlerId, auth: new Set(['POST /auth/login', 'GET /config']), body: new Set(['POST /auth/login']), vars: new Map<string, string>() };
    const r = toRules(c, { ...opts({ selected: { 'POST /auth/login': 'Wrong password', 'GET /config': 'OK' } }), pipeline });
    expect(kinds(r.rules)).toEqual(['mock', 'handler']);
    expect([...r.meta.values()].map((m) => m.needs)).toEqual([undefined, { dynamic: true }]);
    // a selection that names no example is no choice
    expect(kinds(toRules(c, { ...opts({ selected: { 'POST /auth/login': 'Gone' } }), pipeline }).rules)).toEqual(['handler', 'handler']);
  });

  it('query examples keep their own rules: static, unless gated or dynamic (then a handler whose answer is their own example)', () => {
    const search = ep(['search'], [ex('Hits'), ex('None', 200, { query: { q: 'none' } }), ex('Rand', 200, { query: { q: 'rand' }, body: '{{$randomInt}}' })]);
    const c = collection([search]);
    const open = toRules(c, { ...opts(), pipeline: { handlerId, vars: new Map() } });
    expect(open.rules.map((r) => [r.action.kind, open.meta.get(r.id)!.example, open.meta.get(r.id)!.query])).toEqual([['mock', 'None', undefined], ['handler', 'Rand', true], ['mock', 'Hits', undefined]]);
    const gated = toRules(c, { ...opts(), pipeline: { handlerId, auth: new Set(['GET /search']), vars: new Map() } });
    expect(gated.rules.map((r) => [r.action.kind, gated.meta.get(r.id)!.needs])).toEqual([['handler', { auth: true }], ['handler', { auth: true, dynamic: true }], ['handler', { auth: true }]]);
    expect(gated.meta.get(gated.rules[0].id)).toMatchObject({ example: 'None', query: true });
    expect(gated.rules[0].action).toMatchObject({ fallback: { body: 'None' } });
  });

  it('a store operation keeps its rule; the gate and body examples ride on it; no-example endpoints can be gated too', () => {
    const list = ep(['users'], [ex('OK', 200, { body: '[{"id":1}]' })]);
    const create = { ...ep(['users'], [ex('Created', 201, { body: '{"id":2}' })]), key: 'POST /users', method: 'POST' };
    const item = ep(['users', { param: 'id' }], [ex('OK', 200, { body: '{"id":1}' })]);
    const bare = ep(['bare'], []);
    const resources = [{ name: 'users', origin: 'https://api.test', listPath: ['users'], itemParam: 'id', scopeParams: [], idField: 'id', idKind: 'integer' as const, ops: { list: 'GET /users', create: 'POST /users', get: 'GET /users/:id' }, list: {}, writeOnly: [], detected: true as const }];
    const r = toRules(collection([list, create, item, bare]), {
      ...opts(),
      stateful: { handlerId, resources },
      pipeline: { handlerId, auth: new Set(['GET /users', 'POST /users', 'GET /users/:id', 'GET /bare']), body: new Set(['POST /users']), vars: new Map() },
    });
    const meta = (key: string) => [...r.meta.values()].find((m) => m.endpoint === key)!;
    expect(meta('POST /users')).toEqual({ endpoint: 'POST /users', resource: 'users', op: 'create', needs: { auth: true, body: true } });
    expect(meta('GET /users')).toEqual({ endpoint: 'GET /users', resource: 'users', op: 'list', needs: { auth: true } });
    expect(meta('GET /bare')).toEqual({ endpoint: 'GET /bare', noExample: true, needs: { auth: true } });
    expect(r.rules.every((x) => x.action.kind === 'handler')).toBe(true);
    expect(r.rules.find((x) => r.meta.get(x.id)!.endpoint === 'GET /bare')!.action).toMatchObject({ fallback: { status: 501 } });
  });

  it('names what can\'t be filled in, once per endpoint', () => {
    const c = collection([ep(['img'], [ex('OK', 200, { body: '{"a":"{{$randomImage}}","b":"{{$randomImage}}","id":"{{$guid}}"}' })])]);
    const r = toRules(c, { ...opts(), pipeline: { handlerId, vars: new Map() } });
    expect(r.problems).toEqual(['GET /img: Dynamic values not supported (left as written): $randomImage.']);
  });
});
