// CONTRACTS §21.1, §21.2: Postman environment parsing and variable merge order.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { mergeCollectionVars, parsePostmanEnvironment } from '../../src/mocks/environment';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

describe('parsePostmanEnvironment', () => {
  it('matches the expected output for shop.postman_environment.json', () => {
    const env = readJson('shop.postman_environment.json');
    const expected = readJson('shop.expected.json') as {
      environment: { values: Record<string, string> };
    };
    const res = parsePostmanEnvironment(env);
    expect(res.problems).toEqual([]);
    expect(Object.fromEntries(res.values)).toEqual(expected.environment.values);
  });

  it('keeps enabled !== false and omits empty values', () => {
    const res = parsePostmanEnvironment({
      values: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2', enabled: true },
        { key: 'c', value: '3', enabled: false },
        { key: 'd', value: '' },
        { key: 'e', value: null },
        { key: 'f', value: 42 },
        { key: 'g', value: true },
      ],
    });
    expect(res.problems).toEqual([]);
    expect(Object.fromEntries(res.values)).toEqual({ a: '1', b: '2', f: '42', g: 'true' });
  });

  it('never throws on malformed inputs and reports problems', () => {
    for (const bad of [null, 42, [], {}, { values: 'nope' }]) {
      const res = parsePostmanEnvironment(bad);
      expect(res.values.size).toBe(0);
      expect(res.problems.length).toBeGreaterThan(0);
    }

    const mixed = parsePostmanEnvironment({
      values: [
        null,
        { key: '', value: 'x' },
        { key: 'badObj', value: { nested: 1 } },
        { key: 'ok', value: 'yes' },
      ],
    });
    expect(mixed.problems).toHaveLength(3);
    expect(Object.fromEntries(mixed.values)).toEqual({ ok: 'yes' });
  });

  it('handles __proto__ and constructor keys as data', () => {
    const env = JSON.parse(
      '{"values":[{"key":"__proto__","value":"proto-val"},{"key":"constructor","value":"ctor-val"}]}',
    );
    const res = parsePostmanEnvironment(env);
    expect(res.problems).toEqual([]);
    expect(res.values.get('__proto__')).toBe('proto-val');
    expect(res.values.get('constructor')).toBe('ctor-val');
    expect(({} as Record<string, unknown>)['proto-val']).toBeUndefined();
  });

  it('bounds problem lines to 300 chars and strips control/bidi chars and URL credentials (REVIEW-15 #7)', () => {
    const res = parsePostmanEnvironment({
      values: [
        {
          key: `https://user:SuperSecret99@api.example/x\r\n\t\u202E\u2066${'k'.repeat(400)}`,
          value: { bad: true },
        },
      ],
    });
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0].length).toBeLessThanOrEqual(300);
    expect(res.problems[0]).not.toMatch(/[\r\n\t\u202A-\u202E\u2066-\u2069]/);
    expect(res.problems[0]).not.toContain('SuperSecret99');
  });
});

describe('mergeCollectionVars', () => {
  it('picks the first non-empty value in order link → environment → collection', () => {
    const link = { a: 'from-link', b: '', emptyAll: '' };
    const env = new Map([
      ['a', 'from-env'],
      ['b', 'from-env'],
      ['c', ''],
      ['d', 'from-env'],
    ]);
    const coll = new Map([
      ['a', 'from-coll'],
      ['b', 'from-coll'],
      ['c', 'from-coll'],
      ['emptyAll', ''],
    ]);

    const merged = mergeCollectionVars(link, env, coll);
    expect(Object.fromEntries(merged.values)).toEqual({
      a: 'from-link',
      b: 'from-env',
      c: 'from-coll',
      d: 'from-env',
    });
    expect(Object.fromEntries(merged.sources)).toEqual({
      a: 'link',
      b: 'environment',
      c: 'collection',
      d: 'environment',
    });
  });

  it('treats __proto__ and constructor in link/env/collection as plain data', () => {
    const link = JSON.parse('{"__proto__":"link-proto","constructor":"link-ctor"}') as Record<string, string>;
    const env = new Map([['__proto__', 'env-proto']]);
    const coll = new Map([['constructor', 'coll-ctor']]);

    const merged = mergeCollectionVars(link, env, coll);
    expect(merged.values.get('__proto__')).toBe('link-proto');
    expect(merged.values.get('constructor')).toBe('link-ctor');
    expect(merged.sources.get('__proto__')).toBe('link');
    expect(merged.sources.get('constructor')).toBe('link');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
