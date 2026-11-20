// CONTRACTS §23.1: Record → Mock — a Postman collection from recorded traffic, sanitised, that the collection parser
// and sanitiser accept as it is.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { mergeCollectionVars } from '../../src/mocks/environment';
import { collectionFromTraffic, JWT_PLACEHOLDER, TrafficSanitiser, type FromTrafficOptions } from '../../src/mocks/fromTraffic';
import { parsePostman, postmanCollectionVariables } from '../../src/mocks/postman';
import { sanitisePostman } from '../../src/mocks/sanitise';
import { COLLECTION_LIMITS, type ParsedCollection } from '../../src/mocks/types';
import { DriftTracker } from '../../src/mocks/drift';

const fixture = path.join(__dirname, '..', 'fixtures', 'traffic', 'session.json');
const session = (): Exchange[] => (JSON.parse(fs.readFileSync(fixture, 'utf8')) as { exchanges: Exchange[] }).exchanges;
const A = 'https://api.shop.example';
const B = 'https://feed.media.example:8443';
const opts: FromTrafficOptions = { name: 'Shop API (recorded)', isThrottleOnlyRule: (id) => id === 'throttle-only' };

function parseBack(text: string): ParsedCollection {
  const doc = JSON.parse(text) as unknown;
  return parsePostman(doc, mergeCollectionVars({}, new Map(), postmanCollectionVariables(doc)));
}

let seq = 0;
function ex(method: string, url: string, status: number, body?: string | object, extra: Partial<Exchange> = {}): Exchange {
  return {
    id: `x${++seq}`,
    startedAt: 1_000_000 + seq,
    method,
    url,
    requestHeaders: {},
    status,
    responseHeaders: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { responseBody: { text: typeof body === 'string' ? body : JSON.stringify(body), encoding: 'utf8' as const } }),
    state: 'completed',
    ...extra,
  };
}

/** Values planted in the fixture that must never reach the collection. */
const PLANTED = [
  // JWTs (header, payload and signature parts each)
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiI0MiIsIm5hbWUiOiJBZGEiLCJleHAiOjE5MDAwMDAwMDB9',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0',
  'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg',
  // cookies, tokens, passwords, signed URLs, API keys
  's3cr3tCookieValue42',
  'rt_9f8e7d6c5b4a39281706f5e4d3c2b1a0ZZqq',
  'Hunter2!PlantedPw',
  'deadbeefcafef00d1234567890abcdef0042',
  'AKIAPLANTEDCRED',
  'qTok3nPlantedValue99',
  'PlantedSig0001',
  'tkPlantedHeader0042',
  // personal data
  'ada@lovelace.dev',
  'charles@engine.dev',
  'bob@corp.example.net',
  '7946 0958',
  '7946 0001',
  '415 555 0100',
  '12 Analytical Way',
  'London',
  'NW1 6XE',
  '51.5072',
  '-0.1276',
  // volatile / security headers
  'req-abc-123-trace',
  '4bf92f3577b34da6a3ce929d0e0e4736',
  "default-src 'self'",
  'max-age=63072000',
  'Fri, 20 Nov 2026',
];

describe('collectionFromTraffic: the fixture session', () => {
  const r = collectionFromTraffic(session(), opts);
  const parsed = parseBack(r.text);

  it('takes the recorded JSON / text endpoints of both origins, templated, and nothing else', () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.format).toBe('postman');
    expect(parsed.name).toBe('Shop API (recorded)');
    expect(parsed.endpoints.map((e) => `${e.key} → ${e.origin} ${e.examples.map((x) => x.status).join(',')}`).sort()).toEqual([
      `GET {{baseUrl2}}/v1/feed → ${B} 200`,
      `GET {{baseUrl}}/brands → ${A} 200`,
      `GET {{baseUrl}}/categories → ${A} 200`,
      `GET {{baseUrl}}/health → ${A} 200`,
      `GET {{baseUrl}}/orders/:orderId → ${A} 200`,
      `GET {{baseUrl}}/products/:productId → ${A} 200`, // shoes / hats / bags collapsed
      `GET {{baseUrl}}/settings → ${A} 200`, // a throttle-only rule is fine
      `GET {{baseUrl}}/stores → ${A} 200`, // categories / brands / stores are resources, not values
      `GET {{baseUrl}}/users → ${A} 200`,
      `GET {{baseUrl}}/users/:userId → ${A} 200,404`, // 304 skipped
      `POST {{baseUrl}}/auth/login → ${A} 200`,
    ]);
    expect(r.endpoints).toBe(11);
    expect(r.examples).toBe(12);
    expect(r.origins).toEqual([A, B]);
    expect(parsed.variables).toEqual([
      { name: 'baseUrl', from: 'collection' },
      { name: 'baseUrl2', from: 'collection' },
    ]);
  });

  it('counts each skipped kind in a short line', () => {
    expect(r.skipped).toEqual([
      '1 mocked or replayed answer',
      '1 answer changed by a rule',
      '1 redirect or 1xx / 304 answer',
      '1 OPTIONS request',
      '1 GraphQL request',
      '1 gRPC call',
      '1 WebSocket',
      '1 SSE stream',
      '1 undecrypted TLS connection',
      '1 browser-internal request',
      '1 unfinished or failed exchange',
      '1 exchange with a truncated body',
      '1 binary answer',
    ]);
  });

  it('holds no planted secret or personal value anywhere, and `removed` names only', () => {
    for (const v of PLANTED) expect(r.text, v).not.toContain(v);
    for (const v of PLANTED) for (const name of r.removed) expect(name).not.toContain(v);
    expect(r.removed).toEqual(
      expect.arrayContaining(['authorization', 'access_token', 'refresh_token', 'password', 'x-api-token', 'X-Amz-Signature (in URLs)', 'e-mail addresses', 'phone numbers', 'addresses and locations']),
    );
  });

  it('keeps answers working: the JWT placeholder decodes, literals and keys stay, personal data is consistent', () => {
    const login = parsed.endpoints.find((e) => e.key === 'POST {{baseUrl}}/auth/login')!;
    const body = JSON.parse(login.examples[0].body) as Record<string, unknown>;
    expect(body.access_token).toBe(JWT_PLACEHOLDER);
    const [h, p, sig] = JWT_PLACEHOLDER.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'none' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ sub: 'fi', exp: 4102444800 });
    expect(sig).toBe('');
    expect(body.refresh_token).toBe('');
    expect(body.expires_in).toBe(3600);
    expect(body.user).toEqual({ id: 42, email: 'user1@example.com' });

    const user = parsed.endpoints.find((e) => e.key === 'GET {{baseUrl}}/users/:userId')!.examples[0];
    expect(user.body).toContain('"rating": 4.0'); // literal kept (Dart: double)
    expect(user.body).toContain('"big": 12345678901234567890');
    const u = JSON.parse(user.body) as Record<string, unknown>;
    expect(u.email).toBe('user1@example.com'); // the same address → the same replacement in every body
    expect(u.bio).toBe('Write to user1@example.com or call');
    expect(u.phone).toBe('+100000001');
    expect(u.address).toEqual({ street: '', city: '', zip: '' });
    expect(user.body).toContain('"lat": 0.0'); // the kind is kept: a double stays a double
    expect(user.body).toContain('"lng": 0.0');
    expect(u.avatarUrl).toBe('https://bucket.s3.amazonaws.com/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=&X-Amz-Signature=');
    expect(u.seen).toBe(2); // the newest 200
    expect(user.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' });

    const feed = parsed.endpoints.find((e) => e.key.includes('/v1/feed'))!;
    expect(feed.queryParams).toEqual(['page', 'token']); // names kept, values blank
    expect(JSON.parse(feed.examples[0].body)).toMatchObject({ next: 'https://feed.media.example:8443/v1/feed?page=3&sig=&lang=en' });
  });

  it('writes request auth as a typed placeholder and request bodies without secrets', () => {
    const doc = JSON.parse(r.text) as { item: { item: { name: string; request: Record<string, unknown> }[] }[]; variable: { key: string; value: string }[] };
    const login = doc.item.flatMap((f) => f.item).find((i) => i.name === 'POST /auth/login')!;
    expect(login.request.auth).toEqual({ type: 'bearer' }); // the sanitiser keeps the type only (§24.1)
    expect(JSON.parse((login.request.body as { raw: string }).raw)).toEqual({ email: 'user1@example.com', password: '' });
    expect(doc.variable.find((v) => v.key === 'bearerToken')?.value).toBe('');
    expect(doc.variable.filter((v) => v.key.startsWith('baseUrl')).map((v) => v.value)).toEqual([A, B]);
  });

  it('is already what sanitisePostman makes of it (the host copyIn changes nothing)', () => {
    const again = sanitisePostman(JSON.parse(r.text));
    expect(JSON.stringify(again.doc, null, 2)).toBe(r.text);
  });

  it('is deterministic', () => {
    expect(collectionFromTraffic(session(), opts).text).toBe(r.text);
  });
});

describe('collectionFromTraffic: options and limits', () => {
  it('keeps only the chosen origins', () => {
    const r = collectionFromTraffic(session(), { ...opts, origins: [`${A}/`] });
    expect(r.origins).toEqual([A]);
    expect(r.endpoints).toBe(10);
    expect(r.skipped).toContain('2 requests to other origins');
  });

  it('skips exchanges a rule answered unless the host says the rule only throttles', () => {
    const r = collectionFromTraffic(session(), { name: 'x' });
    expect(r.skipped).toContain('2 answers changed by a rule');
    expect(parseBack(r.text).endpoints.some((e) => e.key.endsWith('/settings'))).toBe(false);
  });

  it('replaces personal data only when asked; secrets go either way', () => {
    const r = collectionFromTraffic(session(), { ...opts, replacePersonalData: false });
    expect(r.text).toContain('ada@lovelace.dev');
    expect(r.text).toContain('12 Analytical Way');
    for (const v of ['s3cr3tCookieValue42', 'Hunter2!PlantedPw', 'deadbeefcafef00d1234567890abcdef0042', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c']) {
      expect(r.text).not.toContain(v);
    }
    expect(r.removed).not.toContain('e-mail addresses');
  });

  it('never cuts a body: an answer over maxExampleBytes is dropped (an older one that fits is used)', () => {
    const big = JSON.stringify({ rows: 'x'.repeat(6 * 1024 * 1024) });
    const list = [
      ex('GET', `${A}/reports/big`, 200, big),
      ex('GET', `${A}/reports/7`, 200, { id: 7, small: true }),
      ex('GET', `${A}/reports/8`, 200, `{"id":8,"pad":"${'y'.repeat(2 * 1024 * 1024)}"}`),
    ];
    const r = collectionFromTraffic(list, { name: 'Reports' });
    const eps = parseBack(r.text).endpoints;
    expect(eps.map((e) => e.key)).toEqual(['GET {{baseUrl}}/reports/:reportId']);
    expect(JSON.parse(eps[0].examples[0].body)).toEqual({ id: 7, small: true });
    expect(r.skipped).toEqual(['2 answers over 1 MB left out (never cut)', '1 endpoint left out: every answer was over 1 MB']);
    expect(r.text).not.toContain('…');
  });

  it('stays under 20 MB by dropping the largest examples first', () => {
    const mb = 1024 * 1024;
    const list = [1, 2, 3, 4, 5].map((n) => ex('GET', `${A}/blobs/b${n}x`, 200, 'z'.repeat(Math.round((3.5 + n * 0.3) * mb)), { responseHeaders: { 'content-type': 'text/plain' } }));
    const r = collectionFromTraffic(list, { name: 'Blobs', maxExampleBytes: 5 * mb });
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(COLLECTION_LIMITS.fileBytes);
    expect(r.skipped).toEqual(['1 example left out to keep the file under 20 MB']);
    expect(r.endpoints).toBe(4);
    expect(r.text).not.toContain('/blobs/b5x'); // the largest one went (text siblings never collapse)
  });

  it('keeps ≤ 20 statuses per endpoint and ≤ 2 000 endpoints', () => {
    const statuses = Array.from({ length: 22 }, (_, i) => 400 + i);
    const r1 = collectionFromTraffic([ex('GET', `${A}/x`, 200, { ok: 1 }), ...statuses.map((s) => ex('GET', `${A}/x`, s, { s }))], { name: 'x' });
    expect(parseBack(r1.text).endpoints[0].examples).toHaveLength(20);
    expect(r1.skipped).toEqual(['3 statuses over 20 per endpoint left out']);

    const many = Array.from({ length: 2005 }, (_, i) => ex('GET', `${A}/r${i}/list`, 200, { [`k${i}`]: i }));
    const r2 = collectionFromTraffic(many, { name: 'many' });
    expect(r2.endpoints).toBe(2000);
    expect(r2.skipped).toEqual(['5 endpoints over the 2,000 limit left out']);
    expect(parseBack(r2.text).problems).toEqual([]);
  });

  it('names params after the previous literal and collapses sibling literals only when they look like values', () => {
    const list = [
      ex('GET', `${A}/users/42/posts/9`, 200, { id: 9 }),
      ex('GET', `${A}/files/12/34`, 200, { ok: 1 }),
      ex('GET', `${A}/api/users`, 200, [{ id: 1, name: 'a', email: 'x' }]),
      ex('GET', `${A}/api/orders`, 200, [{ orderNo: 1, total: 2, lines: [] }]),
      ex('GET', `${A}/api/invoices`, 200, [{ invoice: 'i', due: '2026-01-01' }]),
      ex('GET', `${A}/shop/sale-items/red`, 200, { name: 'r', price: 1 }),
      ex('GET', `${A}/shop/sale-items/blue`, 200, { name: 'b', price: 2 }),
      ex('GET', `${A}/shop/sale-items/green`, 200, { name: 'g', price: 3, extra: true }),
      ex('POST', `${A}/shop/sale-items/red`, 201, { ok: 1 }), // another method: not a sibling
      // envelope APIs: the same top-level keys, different records
      ex('GET', `${A}/v2/users`, 200, { data: [{ id: 1, name: 'a', email: 'e' }], meta: { total: 1, page: 1 } }),
      ex('GET', `${A}/v2/orders`, 200, { data: [{ id: 1, total: 2, status: 's' }], meta: { total: 1, page: 1 } }),
      ex('GET', `${A}/v2/coupons`, 200, { data: [{ id: 1, code: 'c', percent: 5 }], meta: { total: 1, page: 1 } }),
    ];
    const keys = parseBack(collectionFromTraffic(list, { name: 'x' }).text).endpoints.map((e) => e.key).sort();
    expect(keys).toEqual([
      'GET {{baseUrl}}/api/invoices',
      'GET {{baseUrl}}/api/orders',
      'GET {{baseUrl}}/api/users',
      'GET {{baseUrl}}/files/:fileId/:id',
      'GET {{baseUrl}}/shop/sale-items/:saleItemId',
      'GET {{baseUrl}}/users/:userId/posts/:postId',
      'GET {{baseUrl}}/v2/coupons',
      'GET {{baseUrl}}/v2/orders',
      'GET {{baseUrl}}/v2/users',
      'POST {{baseUrl}}/shop/sale-items/red',
    ]);
  });

  it('never throws on odd exchanges and answers an empty collection that still parses', () => {
    const junk = [null, 42, {}, { state: 'completed', status: 200, url: 5, method: 'GET' }, { state: 'completed', status: 200, url: 'ftp://x/y', method: 'GET' }] as unknown as Exchange[];
    const r = collectionFromTraffic(junk, { name: '' });
    expect(r.endpoints).toBe(0);
    expect(parseBack(r.text).problems).toEqual([]);
  });

  it('leaves out request bodies over 64 KB and binary ones, keeping the endpoint', () => {
    const r = collectionFromTraffic(
      [
        ex('POST', `${A}/upload`, 201, { ok: 1 }, { requestHeaders: { 'content-type': 'image/png' }, requestBody: { text: 'AAAA', encoding: 'base64' } }),
        ex('POST', `${A}/bulk`, 200, { ok: 1 }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { text: JSON.stringify({ a: 'b'.repeat(70 * 1024) }), encoding: 'utf8' } }),
      ],
      { name: 'x' },
    );
    expect(r.endpoints).toBe(2);
    expect(r.skipped).toEqual(['1 request body over 64 KB left out', '1 binary request body left out']);
  });
});

describe('TrafficSanitiser', () => {
  it('blanks secret-named fields by type, keeps innocuous look-alikes, and replaces JWTs inside text', () => {
    const s = new TrafficSanitiser(true);
    const out = JSON.parse(
      s.jsonText(
        JSON.stringify({
          author: 'Ada',
          sessionCount: 3,
          pinned: true,
          pin: 1234,
          apiKey: 'k-1',
          auth: { user: { name: 'Ada', age: 36 } },
          note: `Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz and more`,
          opaque: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
          uuid: '550e8400-e29b-41d4-a716-446655440000',
        }),
      )!,
    ) as Record<string, unknown>;
    expect(out).toEqual({
      author: 'Ada',
      sessionCount: 3,
      pinned: true,
      pin: 0,
      apiKey: '',
      auth: { user: { name: '', age: 36 } },
      note: `Bearer ${JWT_PLACEHOLDER} and more`,
      opaque: '',
      uuid: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('returns undefined for text that is not JSON, and handles escapes', () => {
    const s = new TrafficSanitiser(true);
    expect(s.jsonText('{"a": 1,}')).toBeUndefined();
    expect(s.jsonText('{"a\\"b": "x\\u00e9 ada@lovelace.dev"}')).toBe('{"a\\"b": "xé user1@example.com"}');
    expect(s.jsonText('[1.50, -0, 1e3]')).toBe('[1.50, -0, 1e3]');
  });
});

describe('redaction keeps number kinds (no false drift)', () => {
  it('writes 0.0 for a decimal coordinate, 0 for an integer one, and drift stays quiet on real decimals', () => {
    const answer = '{"id":5,"lat":24.7136,"lng":46,"pin":1234,"otp":1.5e3,"phone":966500000000,"name":"Riyadh office"}';
    const r = collectionFromTraffic([ex('GET', `${A}/places/5`, 200, answer)], { name: 'Places' });
    const body = parseBack(r.text).endpoints[0].examples[0].body;
    expect(JSON.parse(body)).toEqual({ id: 5, lat: 0, lng: 0, pin: 0, otp: 0, phone: 100000001, name: 'Riyadh office' });
    expect(body).toContain('"lat": 0.0');
    expect(body).toContain('"lng": 0,');
    expect(body).toContain('"pin": 0,');
    expect(body).toContain('"otp": 0.0');
    expect(body).toContain('"phone": 100000001');

    const t = new DriftTracker();
    for (const lat of ['21.4858', '24.7136', '26.4207']) {
      t.observe({ linkId: 'p', endpoint: 'GET {{baseUrl}}/places/:placeId', status: 200, body: answer.replace('24.7136', lat) }, { status: 200, body });
    }
    expect(t.findings('p')).toEqual([]);
  });
});
