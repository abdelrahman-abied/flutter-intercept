import { describe, expect, it } from 'vitest';
import type { Exchange } from '../src/protocol';
import { contentClassOf, lowerBodyText, matchesFilter, parseFilter, tokenize } from '../src/filter';
import { EMPTY_FILTERS, filterExchanges, type Filters } from '../src/state';
import { ex, pausedRequest } from './fixtures';

const list: Exchange[] = [
  ex({ method: 'GET', url: 'https://api.example.com/users/1', status: 200,
    responseBody: { text: '{"name":"Ada Lovelace","token":"abc"}', encoding: 'utf8' } }),
  ex({ method: 'POST', url: 'https://api.example.com/cart', status: 201,
    requestHeaders: { 'content-type': 'application/json', Authorization: 'Bearer XYZ' },
    requestBody: { text: '{"productId":42,"note":"Gift Wrap please"}', encoding: 'utf8' },
    source: { frames: [{ fn: 'CartApi.add', uri: 'package:shop/api/cart_api.dart', line: 12 }, { fn: 'Dio.fetch', uri: 'package:dio/src/dio_mixin.dart', line: 300 }], appFrame: 0 } }),
  ex({ method: 'GET', url: 'https://cdn.example.com/a.png', status: 304,
    responseHeaders: { 'content-type': 'image/png' }, responseBody: { text: 'iVBORw0KGgo=', encoding: 'base64' } }),
  ex({ method: 'GET', url: 'https://api.example.com/me', status: 401,
    responseHeaders: { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer' } }),
  ex({ method: 'GET', url: 'https://api.example.com/feed', status: 503,
    responseHeaders: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '30' },
    responseBody: { text: '<html><body>Service Unavailable</body></html>', encoding: 'utf8' }, simulated: 'Slow 3G' }),
  ex({ method: 'GET', url: 'https://t.example.net/x', state: 'error', status: undefined, responseHeaders: undefined, responseBody: undefined, error: 'refused' }),
  ex({ method: 'GET', url: 'https://ads.example.org/p', state: 'blocked', status: undefined, responseHeaders: undefined, responseBody: undefined }),
  pausedRequest({ url: 'https://api.example.com/cart/items' }),
  ex({ method: 'PUT', url: 'https://api.example.com/profile', status: 204, state: 'mocked', initiator: 'editor', resentFrom: 'e1',
    responseHeaders: { 'content-type': 'application/xml' }, responseBody: { text: '<ok/>', encoding: 'utf8' } }),
];

const f = (text: string, patch: Partial<Filters> = {}) =>
  filterExchanges(list, { ...EMPTY_FILTERS, text, ...patch }).map((e) => e.url.replace(/^https:\/\//, ''));

describe('filter language: tokenizer', () => {
  it('splits words, keeps quoted phrases, reads negation and known keys only', () => {
    expect(tokenize('  cart  m:POST -s:4xx body:"gift wrap" -"x y" https://a.b/c -')).toEqual([
      { negate: false, key: undefined, value: 'cart' },
      { negate: false, key: 'm', value: 'POST' },
      { negate: true, key: 's', value: '4xx' },
      { negate: false, key: 'body', value: 'gift wrap' },
      { negate: true, key: undefined, value: 'x y' },
      { negate: false, key: undefined, value: 'https://a.b/c' },
      { negate: false, key: undefined, value: '-' },
    ]);
  });
  it('an unclosed quote runs to the end; unknown keys stay URL words', () => {
    expect(tokenize('body:"half open')).toEqual([{ negate: false, key: 'body', value: 'half open' }]);
    expect(tokenize('foo:bar')).toEqual([{ negate: false, key: undefined, value: 'foo:bar' }]);
  });
});

describe('filter language: matching', () => {
  it('free words still match the URL (case-insensitive, AND, -negation)', () => {
    expect(f('CART')).toEqual(['api.example.com/cart', 'api.example.com/cart/items']);
    expect(f('cart -items')).toEqual(['api.example.com/cart']);
    expect(f('"example.com/cart/"')).toEqual(['api.example.com/cart/items']);
  });
  it('m: method, comma = any of', () => {
    expect(f('m:post')).toEqual(['api.example.com/cart', 'api.example.com/cart/items']);
    expect(f('m:put,post -cart')).toEqual(['api.example.com/profile']);
  });
  it('s: exact status, class pattern and error', () => {
    expect(f('s:401')).toEqual(['api.example.com/me']);
    expect(f('s:4xx')).toEqual(['api.example.com/me']);
    expect(f('s:20x')).toEqual(['api.example.com/users/1', 'api.example.com/cart', 'api.example.com/profile']);
    expect(f('s:error')).toEqual(['t.example.net/x', 'ads.example.org/p']);
    expect(f('s:3xx,5xx')).toEqual(['cdn.example.com/a.png', 'api.example.com/feed']);
    expect(f('-s:2xx m:get')).toEqual(['cdn.example.com/a.png', 'api.example.com/me', 'api.example.com/feed', 't.example.net/x', 'ads.example.org/p']);
  });
  it('t: response content class (prefix ok)', () => {
    expect(f('t:json')).toEqual(['api.example.com/users/1', 'api.example.com/cart', 'api.example.com/me']);
    expect(f('t:image')).toEqual(['cdn.example.com/a.png']);
    expect(f('t:html')).toEqual(['api.example.com/feed']);
    expect(f('t:xml')).toEqual(['api.example.com/profile']);
    expect(f('t:other')).toEqual(['t.example.net/x', 'ads.example.org/p', 'api.example.com/cart/items']); // no response
    expect(f('t:im')).toEqual(['cdn.example.com/a.png']);
  });
  it('body: searches request and response UTF-8 bodies case-insensitively, quoted phrases', () => {
    expect(f('body:lovelace')).toEqual(['api.example.com/users/1']);
    expect(f('body:"gift wrap"')).toEqual(['api.example.com/cart']);
    expect(f('body:qty')).toEqual(['api.example.com/cart/items']);
    expect(f('body:iVBOR')).toEqual([]); // binary bodies are not searched
    expect(f('-body:"service unavailable" s:5xx')).toEqual([]);
  });
  it('h: header present or value contains (request or response)', () => {
    expect(f('h:authorization')).toEqual(['api.example.com/cart', 'api.example.com/cart/items']);
    expect(f('h:authorization=xyz')).toEqual(['api.example.com/cart']);
    expect(f('h:retry-after')).toEqual(['api.example.com/feed']);
    expect(f('h:www-authenticate=bearer')).toEqual(['api.example.com/me']);
  });
  it('state: states (prefix), simulated, resent, sent', () => {
    expect(f('state:paused')).toEqual(['api.example.com/cart/items']);
    expect(f('state:mocked')).toEqual(['api.example.com/profile']);
    expect(f('state:blocked,error')).toEqual(['t.example.net/x', 'ads.example.org/p']);
    expect(f('state:simulated')).toEqual(['api.example.com/feed']);
    expect(f('state:resent')).toEqual(['api.example.com/profile']);
    expect(f('is:sent')).toEqual(['api.example.com/profile']);
  });
  it('src: matches a source frame uri', () => {
    expect(f('src:cart_api.dart')).toEqual(['api.example.com/cart']);
    expect(f('src:dio')).toEqual(['api.example.com/cart']);
    expect(f('src:nothing.dart')).toEqual([]);
    expect(f('-src:cart_api m:post')).toEqual(['api.example.com/cart/items']);
  });
  it('combines with the method / status / paused controls', () => {
    expect(f('api', { method: 'GET', statusClasses: ['4xx', '5xx'] })).toEqual(['api.example.com/me', 'api.example.com/feed']);
    expect(f('m:post', { pausedOnly: true })).toEqual(['api.example.com/cart/items']);
  });
  it('incomplete tokens are ignored, invalid ones reported and ignored', () => {
    expect(f('m: cart')).toEqual(['api.example.com/cart', 'api.example.com/cart/items']);
    const p = parseFilter('s:abc t:video state:zzz h:=x');
    expect(p.errors).toHaveLength(4);
    expect(p.errors[0]).toMatch(/s:abc/);
    expect(p.empty).toBe(true);
    expect(f('s:abc')).toHaveLength(list.length);
  });
  it('the parsed filter is cached per text', () => {
    expect(parseFilter('m:GET body:x')).toBe(parseFilter('m:GET body:x'));
    const p = parseFilter('m:GET');
    expect(matchesFilter(list[0], p)).toBe(true);
    expect(matchesFilter(list[1], p)).toBe(false);
  });
});

describe('content class and body cache', () => {
  it('classifies by content-type, else sniffs the body', () => {
    const c = (ct: string | undefined, text = '', encoding: 'utf8' | 'base64' = 'utf8') =>
      contentClassOf({ responseHeaders: ct ? { 'Content-Type': ct } : {}, responseBody: { text, encoding } });
    expect(c('application/vnd.api+json')).toBe('json');
    expect(c('text/plain')).toBe('text');
    expect(c('application/javascript')).toBe('text');
    expect(c('application/pdf', 'JVBER', 'base64')).toBe('binary');
    expect(c('application/octet-stream')).toBe('binary');
    expect(c('application/x-custom', 'abc')).toBe('other');
    expect(c(undefined, '  [1,2]')).toBe('json');
    expect(c(undefined, '<!DOCTYPE html><html>')).toBe('html');
    expect(c(undefined, 'hello')).toBe('text');
    expect(c(undefined, 'AAAA', 'base64')).toBe('binary');
    expect(c(undefined, '')).toBe('other');
  });
  it('lowercases a body once per Body object', () => {
    const body = { text: 'MiXeD', encoding: 'utf8' as const };
    const a = lowerBodyText(body);
    expect(a).toBe('mixed');
    expect(lowerBodyText(body)).toBe(a);
    expect(lowerBodyText({ text: 'AAAA', encoding: 'base64' })).toBe('');
  });
});

describe('filter performance (ROADMAP WP4: 1000 exchanges < 50 ms)', () => {
  // Realistic traffic: JSON list/detail responses of 2–40 kB, request bodies on writes, a few 1 MB feeds.
  function realistic(n: number): Exchange[] {
    const out: Exchange[] = [];
    for (let i = 0; i < n; i++) {
      const items = Array.from({ length: 5 + (i % 60) }, (_, k) => ({
        id: i * 100 + k, name: `Product ${k} of page ${i}`, price: { amount: k * 1.5, currency: 'EUR' },
        description: 'A thing you will love. Lorem ipsum dolor sit amet, consectetur adipiscing elit.', tags: ['home', 'sale'],
      }));
      let text = JSON.stringify({ page: i, items });
      if (i % 250 === 0) text = text.repeat(Math.ceil(1_000_000 / text.length)); // a few ~1 MB bodies
      if (i === 778) text = text.slice(0, -2) + ',"auth":"Needle Token"}';
      const write = i % 7 === 0;
      out.push(ex({
        method: write ? 'POST' : 'GET',
        url: `https://api.shop.example.com/v1/products/${i}?page=${i % 9}`,
        status: i % 23 === 0 ? 503 : write ? 201 : 200,
        requestHeaders: { 'user-agent': 'Dart/3.5 (dart:io)', authorization: 'Bearer abc', 'content-type': 'application/json' },
        requestBody: write ? { text: JSON.stringify({ productId: i, quantity: 2, note: 'needle token' }), encoding: 'utf8' } : undefined,
        responseHeaders: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': `req-${i}` },
        responseBody: { text, encoding: 'utf8' },
      }));
    }
    return out;
  }
  const data = realistic(1000);
  const bytes = data.reduce((s, e) => s + (e.responseBody?.text.length ?? 0) + (e.requestBody?.text.length ?? 0), 0);

  const time = (text: string) => {
    const t0 = performance.now();
    const r = filterExchanges(data, { ...EMPTY_FILTERS, text });
    return { ms: performance.now() - t0, n: r.length };
  };

  it(`filters ${'1000'} exchanges with realistic bodies in < 50 ms per keystroke`, () => {
    expect(bytes).toBeGreaterThan(10_000_000); // > 10 MB of body text in total
    const cold = time('body:"needle token"'); // first run lowercases (and caches) every body once
    const queries = ['m:POST s:5xx body:"needle token"', 'body:"needle token"', 'body:needle', 'body:"needle t"',
      'products -page=3 t:json h:x-request-id', 'src:api.dart', '-body:lorem'];
    const warm = queries.map((q) => ({ q, ...time(q) }));
    const worst = Math.max(...warm.map((w) => w.ms));
    console.info(`[filter bench] ${(bytes / 1e6).toFixed(1)} MB bodies, cold ${cold.ms.toFixed(1)} ms; warm worst ${worst.toFixed(2)} ms`,
      warm.map((w) => `${w.q} → ${w.n} in ${w.ms.toFixed(2)} ms`).join(' | '));
    expect(cold.n).toBe(144); // 143 POST request bodies + the response with "Needle Token"
    expect(warm[0].n).toBe(7); // POSTs with a 503 (every 161st) carry "needle token" in the request body
    expect(worst).toBeLessThan(50);
  });
});
