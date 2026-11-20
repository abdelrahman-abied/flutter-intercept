// CONTRACTS §21.4: deterministic schema-to-body generator.
import { describe, expect, it } from 'vitest';
import { generateFromSchema } from '../../src/mocks/generate';
import { COLLECTION_LIMITS } from '../../src/mocks/types';
import { parseYaml } from '../../src/mocks/yaml';

describe('generateFromSchema', () => {
  it('is deterministic across repeated calls', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        created: { type: 'string', format: 'date-time' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 2 },
      },
    };
    const first = generateFromSchema(schema, {});
    const second = generateFromSchema(schema, {});
    expect(first).toEqual(second);
    expect(first.problems).toEqual([]);
  });

  it('applies example -> default -> const -> enum -> type in strict order (including falsy values)', () => {
    expect(JSON.parse(generateFromSchema({ example: false, default: true, const: 'c', enum: ['e'], type: 'string' }, {}).text)).toBe(false);
    expect(JSON.parse(generateFromSchema({ example: 0, default: 1, type: 'integer' }, {}).text)).toBe(0);
    expect(JSON.parse(generateFromSchema({ example: '', default: 'x', type: 'string' }, {}).text)).toBe('');
    expect(JSON.parse(generateFromSchema({ example: null, default: 'x', type: 'string' }, {}).text)).toBeNull();
    expect(JSON.parse(generateFromSchema({ examples: ['from-examples'], default: 'd', type: 'string' }, {}).text)).toBe('from-examples');
    expect(JSON.parse(generateFromSchema({ default: 0, const: 5, enum: [9], type: 'integer' }, {}).text)).toBe(0);
    expect(JSON.parse(generateFromSchema({ const: false, enum: [true], type: 'boolean' }, {}).text)).toBe(false);
    expect(JSON.parse(generateFromSchema({ enum: ['first', 'second'], type: 'string' }, {}).text)).toBe('first');
    expect(JSON.parse(generateFromSchema({ enum: [], type: 'integer' }, {}).text)).toBe(0);
  });

  it('generates every documented string format', () => {
    const schema = {
      type: 'object',
      properties: {
        dt: { type: 'string', format: 'date-time' },
        d: { type: 'string', format: 'date' },
        t: { type: 'string', format: 'time' },
        u: { type: 'string', format: 'uuid' },
        e: { type: 'string', format: 'email' },
        uri: { type: 'string', format: 'uri' },
        url: { type: 'string', format: 'url' },
        host: { type: 'string', format: 'hostname' },
        v4: { type: 'string', format: 'ipv4' },
        v6: { type: 'string', format: 'ipv6' },
        b: { type: 'string', format: 'byte' },
        bin: { type: 'string', format: 'binary' },
        other: { type: 'string', format: 'custom' },
      },
    };
    const { text, problems } = generateFromSchema(schema, {});
    expect(problems).toEqual([]);
    expect(JSON.parse(text)).toEqual({
      dt: '2026-01-01T00:00:00Z',
      d: '2026-01-01',
      t: '00:00:00Z',
      u: '00000000-0000-4000-8000-000000000000',
      e: 'user@example.com',
      uri: 'https://example.com',
      url: 'https://example.com',
      host: 'example.com',
      v4: '192.0.2.1',
      v6: '2001:db8::1',
      b: 'AA==',
      bin: '',
      other: 'string',
    });
  });

  it('respects minLength and maxLength on strings', () => {
    expect(JSON.parse(generateFromSchema({ type: 'string' }, {}).text)).toBe('string');
    expect(JSON.parse(generateFromSchema({ type: 'string', minLength: 8 }, {}).text)).toBe('stringst');
    expect(JSON.parse(generateFromSchema({ type: 'string', minLength: 3 }, {}).text)).toBe('string');
    expect(JSON.parse(generateFromSchema({ type: 'string', maxLength: 3 }, {}).text)).toBe('str');
    expect(JSON.parse(generateFromSchema({ type: 'string', maxLength: 0 }, {}).text)).toBe('');
    expect(JSON.parse(generateFromSchema({ type: 'string', minLength: 10, maxLength: 7 }, {}).text)).toBe('strings');
  });

  it('respects minimum, exclusiveMinimum, maximum and exclusiveMaximum on numbers', () => {
    expect(JSON.parse(generateFromSchema({ type: 'integer' }, {}).text)).toBe(0);
    expect(JSON.parse(generateFromSchema({ type: 'number' }, {}).text)).toBe(0);
    expect(JSON.parse(generateFromSchema({ type: 'integer', minimum: 5 }, {}).text)).toBe(5);
    expect(JSON.parse(generateFromSchema({ type: 'integer', minimum: 5, exclusiveMinimum: true }, {}).text)).toBe(6);
    expect(JSON.parse(generateFromSchema({ type: 'integer', exclusiveMinimum: 5 }, {}).text)).toBe(6);
    expect(JSON.parse(generateFromSchema({ type: 'number', minimum: 1.5, exclusiveMinimum: true }, {}).text)).toBe(2.5);
    expect(JSON.parse(generateFromSchema({ type: 'integer', maximum: -3 }, {}).text)).toBe(-3);
    expect(JSON.parse(generateFromSchema({ type: 'integer', minimum: 10, maximum: 7 }, {}).text)).toBe(7);
    expect(JSON.parse(generateFromSchema({ type: 'integer', maximum: 0, exclusiveMaximum: true }, {}).text)).toBe(-1);
  });

  it('generates boolean, null and inferred types', () => {
    expect(JSON.parse(generateFromSchema({ type: 'boolean' }, {}).text)).toBe(true);
    expect(JSON.parse(generateFromSchema({ type: 'null' }, {}).text)).toBeNull();
    expect(JSON.parse(generateFromSchema({ properties: { a: { type: 'integer' } } }, {}).text)).toEqual({ a: 0 });
    expect(JSON.parse(generateFromSchema({ items: { type: 'boolean' } }, {}).text)).toEqual([true]);
    expect(JSON.parse(generateFromSchema({}, {}).text)).toBeNull();
  });

  it('handles minItems and missing items on arrays', () => {
    expect(JSON.parse(generateFromSchema({ type: 'array' }, {}).text)).toEqual([]);
    expect(JSON.parse(generateFromSchema({ type: 'array', items: { type: 'integer' } }, {}).text)).toEqual([0]);
    expect(JSON.parse(generateFromSchema({ type: 'array', items: { type: 'integer' }, minItems: 0 }, {}).text)).toEqual([0]);
    expect(JSON.parse(generateFromSchema({ type: 'array', items: { type: 'integer' }, minItems: 2 }, {}).text)).toEqual([0, 0]);
    expect(JSON.parse(generateFromSchema({ type: 'array', items: { type: 'integer' }, minItems: 10 }, {}).text)).toEqual([0, 0, 0]);
  });

  it('handles type lists (3.1) and nullable (3.0)', () => {
    expect(JSON.parse(generateFromSchema({ type: ['null', 'integer'] }, {}).text)).toBe(0);
    expect(JSON.parse(generateFromSchema({ type: ['string', 'null'], maxLength: 3 }, {}).text)).toBe('str');
    expect(JSON.parse(generateFromSchema({ type: ['null'] }, {}).text)).toBeNull();
    expect(JSON.parse(generateFromSchema({ type: 'string', nullable: true }, {}).text)).toBe('string');
  });

  it('merges allOf (uniting properties and required, later wins) and picks first oneOf/anyOf', () => {
    const allOfSchema = {
      allOf: [
        { type: 'object', required: ['a'], properties: { a: { type: 'string' }, clash: { type: 'integer' } } },
        { type: 'object', required: ['b'], properties: { clash: { type: 'boolean' }, b: { type: 'string', minLength: 8 } } },
      ],
    };
    expect(JSON.parse(generateFromSchema(allOfSchema, {}).text)).toEqual({
      a: 'string',
      clash: true,
      b: 'stringst',
    });

    expect(JSON.parse(generateFromSchema({ oneOf: [{ type: 'integer', minimum: 9 }, { type: 'string' }] }, {}).text)).toBe(9);
    expect(JSON.parse(generateFromSchema({ anyOf: [{ type: 'boolean' }, { type: 'string' }] }, {}).text)).toBe(true);
  });

  it('omits writeOnly properties (direct and via $ref)', () => {
    const root = {
      components: {
        schemas: {
          Secret: { type: 'string', writeOnly: true },
        },
      },
    };
    const schema = {
      type: 'object',
      required: ['id', 'password', 'secretRef'],
      properties: {
        id: { type: 'integer' },
        password: { type: 'string', writeOnly: true },
        secretRef: { $ref: '#/components/schemas/Secret' },
      },
    };
    expect(JSON.parse(generateFromSchema(schema, root).text)).toEqual({ id: 0 });
  });

  it('handles objects with additionalProperties only when there are no named properties', () => {
    expect(JSON.parse(generateFromSchema({ type: 'object' }, {}).text)).toEqual({});
    expect(JSON.parse(generateFromSchema({ type: 'object', additionalProperties: true }, {}).text)).toEqual({});
    expect(JSON.parse(generateFromSchema({ type: 'object', additionalProperties: false }, {}).text)).toEqual({});
    expect(
      JSON.parse(generateFromSchema({ type: 'object', additionalProperties: { type: 'integer', minimum: 2 } }, {}).text),
    ).toEqual({ key: 2 });
    expect(
      JSON.parse(generateFromSchema({ type: 'object', properties: {}, additionalProperties: { type: 'string' } }, {}).text),
    ).toEqual({ key: 'string' });
    // Next to named properties, additionalProperties is ignored (§21.4).
    expect(
      JSON.parse(
        generateFromSchema(
          { type: 'object', properties: { fixed: { type: 'boolean' } }, additionalProperties: { type: 'string' } },
          {},
        ).text,
      ),
    ).toEqual({ fixed: true });
  });

  it('stops direct and $ref cycles cleanly with null for optional/nullable and {}/[]/scalar for required', () => {
    const direct: Record<string, unknown> = { type: 'object', required: ['req'], properties: {} };
    (direct.properties as Record<string, unknown>).opt = direct;
    (direct.properties as Record<string, unknown>).req = direct;
    expect(JSON.parse(generateFromSchema(direct, {}).text)).toEqual({ opt: null, req: {} });

    const root = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            required: ['reqNext', 'nullableNext', 'arrNext'],
            properties: {
              optNext: { $ref: '#/components/schemas/Node' },
              nullableNext: { nullable: true, $ref: '#/components/schemas/Node' },
              reqNext: { $ref: '#/components/schemas/Node' },
              arrNext: { $ref: '#/components/schemas/NodeList' },
            },
          },
          NodeList: {
            type: 'array',
            items: { $ref: '#/components/schemas/NodeList' },
          },
        },
      },
    };
    const { text, problems } = generateFromSchema(root.components.schemas.Node, root);
    expect(problems).toEqual([]);
    expect(JSON.parse(text)).toEqual({
      optNext: null,
      nullableNext: null,
      reqNext: {},
      arrNext: [[]],
    });

    // Direct $ref chain cycle never loops and reports a problem.
    const refLoop = { a: { $ref: '#/b' }, b: { $ref: '#/a' } };
    const loopRes = generateFromSchema(refLoop.a, refLoop);
    expect(loopRes.problems.length).toBeGreaterThan(0);
    expect(loopRes.text).toBe('null');
  });

  it('caps nesting depth at COLLECTION_LIMITS.generateDepth (12) for objects and arrays', () => {
    let schema: Record<string, unknown> = { type: 'object', properties: { leaf: { type: 'string' } } };
    for (let i = 0; i < 16; i++) {
      schema = { type: 'object', required: ['child'], properties: { child: schema } };
    }
    const { text, problems } = generateFromSchema(schema, {});
    expect(problems.length).toBe(1);
    let cur = JSON.parse(text) as Record<string, unknown>;
    let depth = 0;
    while (cur && typeof cur === 'object' && 'child' in cur) {
      depth += 1;
      cur = cur.child as Record<string, unknown>;
    }
    expect(depth).toBe(COLLECTION_LIMITS.generateDepth);
    expect(cur).toEqual({});

    let arrSchema: Record<string, unknown> = { type: 'array', items: { type: 'string' } };
    for (let i = 0; i < 15; i++) {
      arrSchema = { type: 'array', items: arrSchema };
    }
    const arrRes = generateFromSchema(arrSchema, {});
    expect(arrRes.problems.length).toBe(1);
    let arrCur: unknown = JSON.parse(arrRes.text);
    let arrDepth = 0;
    while (Array.isArray(arrCur) && arrCur.length > 0) {
      arrDepth += 1;
      arrCur = arrCur[0];
    }
    expect(arrDepth).toBe(COLLECTION_LIMITS.generateDepth);
    expect(arrCur).toEqual([]);
  });

  it('never overflows the call stack on 50,000-deep allOf, oneOf, anyOf or $ref chains', () => {
    for (const combinator of ['allOf', 'oneOf', 'anyOf'] as const) {
      let s: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 50_000; i++) {
        s = { [combinator]: [s] };
      }
      const res = generateFromSchema(s, {});
      expect(res.problems.length, combinator).toBeGreaterThan(0);
      expect(() => JSON.parse(res.text), combinator).not.toThrow();
    }

    const schemas: Record<string, unknown> = {};
    for (let i = 1; i < 50_000; i++) {
      schemas[`A${i}`] = { $ref: `#/components/schemas/A${i + 1}` };
    }
    schemas['A50000'] = { type: 'string' };
    const root = { components: { schemas } };
    const refRes = generateFromSchema({ $ref: '#/components/schemas/A1' }, root);
    expect(refRes.problems.length).toBeGreaterThan(0);
    expect(refRes.text).toBe('null');
  });

  it('cuts output at the property where 256 KB is exceeded and reports a problem', () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 400; i++) {
      props[`p${i}`] = { type: 'string', minLength: 1000 };
    }
    const { text, problems } = generateFromSchema({ type: 'object', properties: props }, {});
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/256 KB/);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(COLLECTION_LIMITS.generateBytes);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys.length).toBeGreaterThan(200);
    expect(keys.length).toBeLessThan(300);

    // Also caps an oversized single string / minLength schema safely.
    const giant = generateFromSchema({ type: 'string', minLength: 400_000 }, {});
    expect(giant.problems.length).toBe(1);
    expect(Buffer.byteLength(giant.text, 'utf8')).toBeLessThanOrEqual(COLLECTION_LIMITS.generateBytes);
    expect(typeof JSON.parse(giant.text)).toBe('string');
  });

  it('keeps __proto__ and constructor as data properties and never throws on bad input', () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"}}}');
    const res = generateFromSchema(schema, {});
    expect(res.problems).toEqual([]);
    const parsed = JSON.parse(res.text) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed['__proto__']).toBe('string');
    expect(parsed['constructor']).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    expect(generateFromSchema(null, {}).problems.length).toBeGreaterThan(0);
    expect(generateFromSchema(42, {}).problems.length).toBeGreaterThan(0);
    expect(generateFromSchema('bad', {}).problems.length).toBeGreaterThan(0);
  });

  it('stops fast on a YAML billion-laughs schema DAG within walkNodes', () => {
    let doc = 's0: &s0\n  type: object\n  properties:\n';
    for (let j = 0; j < 10; j++) doc += `    k${j}: { type: string }\n`;
    for (let i = 1; i <= 8; i++) {
      doc += `s${i}: &s${i}\n  type: object\n  properties:\n`;
      for (let j = 0; j < 10; j++) doc += `    k${j}: *s${i - 1}\n`;
    }
    const { value } = parseYaml(doc, 'bomb.yaml');
    const root = value as Record<string, unknown>;
    const t0 = performance.now();
    const res = generateFromSchema(root.s8, root);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.problems.length).toBeGreaterThan(0);
  });
});
