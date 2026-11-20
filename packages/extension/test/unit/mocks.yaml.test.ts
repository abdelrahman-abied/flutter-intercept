// CONTRACTS §21.3 (WP0): YAML OpenAPI documents through js-yaml, plain data only.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { isYamlFile, parseYaml } from '../../src/mocks/yaml';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');

describe('parseYaml', () => {
  it('the YAML copy of the OpenAPI fixture equals the JSON one', () => {
    const yaml = parseYaml(fs.readFileSync(path.join(fixtures, 'shop.openapi.yaml'), 'utf8'), 'shop.openapi.yaml');
    expect(yaml.problem).toBeUndefined();
    expect(yaml.value).toEqual(JSON.parse(fs.readFileSync(path.join(fixtures, 'shop.openapi.json'), 'utf8')));
  });

  it('keeps OpenAPI response codes as string keys and dates as text', () => {
    const { value } = parseYaml('responses:\n  200: {description: ok}\n  2XX: {description: ok}\ncreated: 2026-01-01\n', 'a.yaml');
    expect(value).toEqual({ responses: { '200': { description: 'ok' }, '2XX': { description: 'ok' } }, created: '2026-01-01' });
  });

  it('refuses custom tags (no functions, no regexps)', () => {
    for (const t of ['a: !!js/function "function () { return 1 }"', 'a: !!js/regexp /x/', 'a: !custom 1', 'a: !!binary AA==']) {
      const r = parseYaml(t, 'a.yaml');
      expect(r.value, t).toBeUndefined();
      expect(r.problem, t).toMatch(/^a\.yaml line 1/);
    }
  });

  it('reports the position and reason, never the file text', () => {
    const r = parseYaml('openapi: 3.1.0\ninfo:\n  title: "secret-value-123\n', 'api.yaml');
    expect(r.problem).toMatch(/^api\.yaml line \d+/);
    expect(r.problem).not.toContain('secret-value-123');
  });

  it('several documents in one file are a problem', () => {
    expect(parseYaml('a: 1\n---\nb: 2\n', 'a.yaml').problem).toMatch(/a\.yaml/);
  });

  it('keeps __proto__ as data', () => {
    const { value } = parseYaml('__proto__: {polluted: true}\nconstructor: x\n', 'a.yaml');
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a "billion laughs" document loads as shared references (small and fast)', () => {
    let doc = 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n';
    for (let i = 1; i <= 9; i++) doc += `a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]\n`;
    const t = performance.now();
    const { value, problem } = parseYaml(doc, 'bomb.yaml');
    expect(problem).toBeUndefined();
    expect(performance.now() - t).toBeLessThan(500);
    const v = value as Record<string, unknown[]>;
    expect(v.a9[0]).toBe(v.a9[1]); // the same object, not 10^9 copies
  });

  it('a BOM is ignored', () => {
    expect(parseYaml('﻿a: 1\n', 'a.yaml').value).toEqual({ a: 1 });
  });
});

describe('isYamlFile', () => {
  it('by extension', () => {
    expect(isYamlFile('api.yaml')).toBe(true);
    expect(isYamlFile('API.YML')).toBe(true);
    expect(isYamlFile('api.json')).toBe(false);
    expect(isYamlFile('yaml')).toBe(false);
  });
});
