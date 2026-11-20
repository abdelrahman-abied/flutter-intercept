// CONTRACTS §24.2: choosing an example by the request body.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildBodyMatchers, chooseByBody, MAX_BODY_LEAVES, REQUEST_BODY_BYTES } from '../../src/mocks/bodyMatch';
import { parseOpenApi } from '../../src/mocks/openapi';
import { parsePostman } from '../../src/mocks/postman';
import { sanitisePostman } from '../../src/mocks/sanitise';
import type { CollectionVars, MockEndpoint, MockExample } from '../../src/mocks/types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const vars: CollectionVars = { values: new Map([['baseUrl', 'https://api.shop.example']]), sources: new Map() };
const JSON_CT = 'application/json';

function ep(examples: MockExample[], requestBody?: string, contentType = JSON_CT): MockEndpoint {
  return {
    key: 'POST /x',
    method: 'POST',
    name: 'X',
    folder: [],
    origin: 'https://api.example',
    path: ['x'],
    examples,
    unresolved: [],
    ...(requestBody !== undefined ? { requestBody: { contentType, body: requestBody } } : {}),
  };
}
function ex(name: string, status: number, request?: string, contentType = JSON_CT): MockExample {
  return { name, status, headers: {}, body: '', ...(request !== undefined ? { request: { contentType, body: request } } : {}) };
}

describe('body matching on the shop fixture', () => {
  it('chooses "Wrong password" by body from the collection as written', () => {
    const parsed = parsePostman(readJson('shop.postman_collection.json'), vars);
    const login = parsed.endpoints.find((e) => e.name === 'Log in') as MockEndpoint;
    const { matchers, problems } = buildBodyMatchers(login);
    expect(problems).toEqual([]);
    // "Success" carries the request's own body: it is the default, not a body candidate.
    expect(matchers.map((m) => [m.example, m.fields])).toEqual([['Wrong password', ['password']]]);
    expect(chooseByBody(matchers, '{"email":"sara@example.com","password":"wrong-guess"}', JSON_CT)).toBe('Wrong password');
    expect(chooseByBody(matchers, '{"password":"wrong-guess","email":"x@example.com"}', 'application/json; charset=utf-8')).toBe(
      'Wrong password',
    );
    expect(chooseByBody(matchers, '{"email":"sara@example.com","password":"hunter2"}', JSON_CT)).toBeUndefined();
    expect(chooseByBody(matchers, 'not json', JSON_CT)).toBeUndefined();
    expect(chooseByBody(matchers, undefined, JSON_CT)).toBeUndefined();
  });

  it('falls back in the copy without credentials (passwords blanked) with a problem line naming the field', () => {
    const { doc } = sanitisePostman(readJson('shop.postman_collection.json'));
    const parsed = parsePostman(doc, vars);
    const login = parsed.endpoints.find((e) => e.name === 'Log in') as MockEndpoint;
    expect(login.examples[1].request?.body).toBe('{"email":"sara@example.com","password":""}');
    const { matchers, problems } = buildBodyMatchers(login);
    expect(matchers).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Wrong password');
    expect(problems[0]).toContain('"password"');
    expect(problems[0]).not.toContain('hunter2');
    expect(chooseByBody(matchers, '{"email":"sara@example.com","password":"wrong-guess"}', JSON_CT)).toBeUndefined();
  });
});

describe('buildBodyMatchers / chooseByBody', () => {
  it('uses every leaf when the endpoint has no body of its own; most discriminators wins, then file order', () => {
    const e = ep([
      ex('OK', 200),
      ex('Card declined', 402, '{"card":"4000"}'),
      ex('Declined in EUR', 402, '{"card":"4000","currency":"EUR"}'),
      ex('Also 4000', 409, '{"card":"4000"}'),
    ]);
    const { matchers } = buildBodyMatchers(e);
    expect(matchers.map((m) => m.fields)).toEqual([['card'], ['card', 'currency'], ['card']]);
    expect(chooseByBody(matchers, '{"card":"4000","currency":"EUR"}', JSON_CT)).toBe('Declined in EUR');
    expect(chooseByBody(matchers, '{"card":"4000","currency":"USD"}', JSON_CT)).toBe('Card declined');
    expect(chooseByBody(matchers, '{"card":"4242"}', JSON_CT)).toBeUndefined();
  });

  it('compares with strict JSON equality, nested paths and arrays', () => {
    const e = ep(
      [ex('OK', 200, '{"qty":1,"user":{"tier":"basic"},"items":[{"id":1}]}'), ex('Gold', 200, '{"qty":1,"user":{"tier":"gold"},"items":[{"id":1}]}'), ex('Many', 200, '{"qty":1,"user":{"tier":"basic"},"items":[{"id":1},{"id":2}]}')],
      '{"qty":1,"user":{"tier":"basic"},"items":[{"id":1}]}',
    );
    const { matchers } = buildBodyMatchers(e);
    expect(matchers.map((m) => [m.example, m.fields])).toEqual([
      ['Gold', ['user.tier']],
      ['Many', ['items[1].id']],
    ]);
    expect(chooseByBody(matchers, '{"user":{"tier":"gold"}}', JSON_CT)).toBe('Gold');
    expect(chooseByBody(matchers, '{"items":[{"id":1},{"id":2}]}', JSON_CT)).toBe('Many');
    expect(chooseByBody(matchers, '{"items":[{"id":1},{"id":"2"}]}', JSON_CT)).toBeUndefined(); // "2" ≠ 2
  });

  it('ignores secret-named blank leaves and {{var}} leaves', () => {
    const e = ep([
      ex('OK', 200),
      ex('Locked', 423, '{"username":"locked-user","password":""}'),
      ex('Templated', 400, '{"username":"{{user}}","otp":"123"}'),
    ]);
    const { matchers } = buildBodyMatchers(e);
    expect(matchers.map((m) => m.fields)).toEqual([['username'], ['otp']]);
    expect(chooseByBody(matchers, '{"username":"locked-user","password":"anything"}', JSON_CT)).toBe('Locked');
    expect(chooseByBody(matchers, '{"username":"whoever","otp":"123"}', JSON_CT)).toBe('Templated');
  });

  it('compares urlencoded bodies as flat objects (and form vs JSON by value)', () => {
    const form = 'application/x-www-form-urlencoded';
    const e = ep([ex('OK', 200, 'grant_type=password&username=sara', form), ex('Bad grant', 400, 'grant_type=refresh_token&username=sara', form)], 'grant_type=password&username=sara', form);
    const { matchers } = buildBodyMatchers(e);
    expect(matchers.map((m) => [m.example, m.fields])).toEqual([['Bad grant', ['grant_type']]]);
    expect(chooseByBody(matchers, 'username=x&grant_type=refresh_token', form)).toBe('Bad grant');
    expect(chooseByBody(matchers, 'username=x&grant_type=refresh%5Ftoken', `${form}; charset=utf-8`)).toBe('Bad grant');
    expect(chooseByBody(matchers, '{"grant_type":"refresh_token"}', JSON_CT)).toBe('Bad grant');
  });

  it('caps leaves at 32 and depth at 8', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 40; i++) wide[`f${i}`] = i;
    const deep = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } });
    const { matchers } = buildBodyMatchers(ep([ex('OK', 200), ex('Wide', 400, JSON.stringify(wide)), ex('Deep', 400, deep)]));
    expect(matchers[0].fields).toHaveLength(MAX_BODY_LEAVES);
    expect(matchers[1].fields).toEqual(['a.b.c.d.e.f.g.h']); // the container at depth 8 is one leaf, compared whole
    expect(chooseByBody(matchers, deep, JSON_CT)).toBe('Deep');
    expect(chooseByBody(matchers, deep.replace('"j":1', '"j":2'), JSON_CT)).toBeUndefined();
  });

  it('skips oversized and broken example bodies with problem lines (names only), and never throws', () => {
    const big = JSON.stringify({ blob: 'x'.repeat(REQUEST_BODY_BYTES) });
    const { matchers, problems } = buildBodyMatchers(ep([ex('OK', 200), ex('Big', 400, big), ex('Broken', 400, '{"a":')]));
    expect(matchers).toEqual([]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"Big"');
    expect(problems[1]).toContain('"Broken"');
    expect(problems.join('\n')).not.toContain('xxxx');
    const ok = buildBodyMatchers(ep([ex('OK', 200), ex('A', 400, '{"a":1}')])).matchers;
    for (const hostile of ['{"__proto__":{"a":1}}', '[1,2]', 'null', '1', '"s"', '{"a":{"__proto__":1}}']) {
      expect(() => chooseByBody(ok, hostile, JSON_CT)).not.toThrow();
    }
    expect(chooseByBody(ok, '{"__proto__":{"a":1}}', JSON_CT)).toBeUndefined();
  });

  it('pairs OpenAPI request examples with response examples of the same key (Microcks)', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Pay' },
      servers: [{ url: 'https://pay.example' }],
      paths: {
        '/charges': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  example: { amount: 10, card: '4242' },
                  examples: { declined: { value: { amount: 10, card: '4000' } }, ok: { value: { amount: 10, card: '4242' } } },
                },
              },
            },
            responses: {
              '201': { description: 'ok', content: { 'application/json': { examples: { ok: { value: { id: 'ch_1' } } } } } },
              '402': { description: 'declined', content: { 'application/json': { examples: { declined: { value: { error: 'card_declined' } } } } } },
            },
          },
        },
      },
    };
    const parsed = parseOpenApi(doc, { values: new Map(), sources: new Map() });
    const charge = parsed.endpoints[0];
    expect(JSON.parse(charge.requestBody?.body ?? '')).toEqual({ amount: 10, card: '4242' });
    expect(charge.examples.map((e) => [e.name, e.request ? JSON.parse(e.request.body) : undefined])).toEqual([
      ['201 · ok', { amount: 10, card: '4242' }],
      ['402 · declined', { amount: 10, card: '4000' }],
    ]);
    const { matchers } = buildBodyMatchers(charge);
    expect(chooseByBody(matchers, '{"amount":10,"card":"4000"}', JSON_CT)).toBe('402 · declined');
    expect(chooseByBody(matchers, '{"amount":10,"card":"4242"}', JSON_CT)).toBeUndefined();
  });
});
