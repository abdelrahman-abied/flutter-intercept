// CONTRACTS §21.1, §21.3: OpenAPI 3.0 / 3.1 collection parser.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../src/mocks/openapi';
import { COLLECTION_LIMITS, type CollectionVars, type VariableSource } from '../../src/mocks/types';
import { parseYaml } from '../../src/mocks/yaml';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');

function makeVars(entries: Record<string, [string, VariableSource]> = {}): CollectionVars {
  const values = new Map<string, string>();
  const sources = new Map<string, VariableSource>();
  for (const [k, [v, src]] of Object.entries(entries)) {
    values.set(k, v);
    sources.set(k, src);
  }
  return { values, sources };
}

describe('parseOpenApi', () => {
  const expectedAll = JSON.parse(fs.readFileSync(path.join(fixtures, 'shop.expected.json'), 'utf8'));
  const expected = expectedAll.openapi;
  const shopJson = JSON.parse(fs.readFileSync(path.join(fixtures, 'shop.openapi.json'), 'utf8'));
  const shopYaml = fs.readFileSync(path.join(fixtures, 'shop.openapi.yaml'), 'utf8');

  it('matches shop.expected.json exactly for shop.openapi.json and shop.openapi.yaml', () => {
    const emptyVars = makeVars();
    const fromJson = parseOpenApi(shopJson, emptyVars);
    const yamlParsed = parseYaml(shopYaml, 'shop.openapi.yaml');
    expect(yamlParsed.problem).toBeUndefined();
    const fromYaml = parseOpenApi(yamlParsed.value, emptyVars);

    expect(fromJson).toEqual(fromYaml);
    expect({
      format: fromJson.format,
      name: fromJson.name,
      variables: fromJson.variables,
      endpoints: fromJson.endpoints,
    }).toEqual({
      format: expected.format,
      name: expected.name,
      variables: expected.variables,
      endpoints: expected.endpoints,
    });
    expect(fromJson.problems).toHaveLength(expected.problemCount);
    for (const needle of expected.problemsContain as string[]) {
      expect(fromJson.problems.some((p) => p.includes(needle))).toBe(true);
    }
  });

  it('lets a link variable override a server variable', () => {
    const res = parseOpenApi(shopJson, makeVars({ region: ['eu', 'link'] }));
    expect(res.variables).toEqual([{ name: 'region', from: 'link' }]);
    const users = res.endpoints.find((e) => e.key === 'GET /users');
    expect(users?.origin).toBe('https://eu.shop.example');
    expect(users?.unresolved).toEqual([]);
    const orders = res.endpoints.find((e) => e.key === 'POST /orders');
    expect(orders?.origin).toBe('https://orders.shop.example');
  });

  it('treats a relative or missing server URL as unresolved baseUrl and resolves when baseUrl is provided', () => {
    const withRelative = {
      openapi: '3.0.3',
      info: { title: 'Rel' },
      servers: [{ url: '/api/v2' }],
      paths: { '/items': { get: { responses: { '200': { description: 'ok' } } } } },
    };
    const withoutServers = {
      openapi: '3.1.0',
      info: { title: 'NoSrv' },
      paths: { '/items': { get: { responses: { '200': { description: 'ok' } } } } },
    };

    const relUnresolved = parseOpenApi(withRelative, makeVars());
    expect(relUnresolved.variables).toEqual([{ name: 'baseUrl' }]);
    expect(relUnresolved.endpoints[0].origin).toBeUndefined();
    expect('origin' in relUnresolved.endpoints[0]).toBe(false);
    expect(relUnresolved.endpoints[0].unresolved).toEqual(['baseUrl']);
    expect(relUnresolved.endpoints[0].path).toEqual(['api', 'v2', 'items']);

    const relResolved = parseOpenApi(withRelative, makeVars({ baseUrl: ['https://DEV.shop.example:443', 'link'] }));
    expect(relResolved.variables).toEqual([{ name: 'baseUrl', from: 'link' }]);
    expect(relResolved.endpoints[0].origin).toBe('https://dev.shop.example');
    expect(relResolved.endpoints[0].unresolved).toEqual([]);
    expect(relResolved.endpoints[0].path).toEqual(['api', 'v2', 'items']);

    const missUnresolved = parseOpenApi(withoutServers, makeVars());
    expect(missUnresolved.variables).toEqual([{ name: 'baseUrl' }]);
    expect(missUnresolved.endpoints[0].origin).toBeUndefined();
    expect(missUnresolved.endpoints[0].unresolved).toEqual(['baseUrl']);
    expect(missUnresolved.endpoints[0].path).toEqual(['items']);

    const missResolved = parseOpenApi(withoutServers, makeVars({ baseUrl: ['http://localhost:8080/', 'environment'] }));
    expect(missResolved.variables).toEqual([{ name: 'baseUrl', from: 'environment' }]);
    expect(missResolved.endpoints[0].origin).toBe('http://localhost:8080');
    expect(missResolved.endpoints[0].unresolved).toEqual([]);
    expect(missResolved.endpoints[0].path).toEqual(['items']);
  });

  it('resolves local $ref with ~0/~1 escapes across path items, responses, schemas, examples and headers, and skips remote/cyclic refs', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Refs' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/a~b/c': {
          get: {
            responses: {
              '200': { $ref: '#/components/responses/R~01' },
            },
          },
        },
        '/via-path-ref': { $ref: '#/paths/~1a~0b~1c' },
        '/bad-local': {
          get: {
            responses: {
              '200': { $ref: '#/components/responses/LoopA' },
            },
          },
        },
        '/remote': { $ref: 'https://evil.example/spec.yaml#/paths/~1x' },
        '/other-file': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { $ref: 'other.yaml#/Schemas/Item' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        responses: {
          'R~1': {
            description: 'ok',
            headers: {
              'X-Trace': { $ref: '#/components/headers/TraceHeader' },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Item' },
                examples: {
                  one: { $ref: '#/components/examples/OneItem' },
                },
              },
            },
          },
          LoopA: { $ref: '#/components/responses/LoopB' },
          LoopB: { $ref: '#/components/responses/LoopA' },
        },
        headers: {
          TraceHeader: { schema: { type: 'string', example: 'trace-1' } },
        },
        examples: {
          OneItem: { value: { id: 10 } },
        },
        schemas: {
          Item: { type: 'object', properties: { id: { type: 'integer' } } },
        },
      },
    };

    const res = parseOpenApi(doc, makeVars());
    expect(res.endpoints.map((e) => e.key)).toEqual([
      'GET /a~b/c',
      'GET /via-path-ref',
      'GET /bad-local',
      'GET /other-file',
    ]);
    expect(res.endpoints[0].examples).toEqual([
      {
        name: '200 · one',
        status: 200,
        headers: { 'content-type': 'application/json', 'x-trace': 'trace-1' },
        body: '{\n  "id": 10\n}',
      },
    ]);
    expect(res.endpoints[1].examples).toEqual(res.endpoints[0].examples);
    expect(res.endpoints[2].examples).toEqual([]);
    expect(res.endpoints[3].examples).toEqual([]);
    expect(res.problems.some((p) => p.includes('https://evil.example/spec.yaml#/paths/~1x'))).toBe(true);
    expect(res.problems.some((p) => p.includes('other.yaml#/Schemas/Item'))).toBe(true);
    expect(res.problems.some((p) => p.includes('LoopA'))).toBe(true);
  });

  it('handles response selection rules: default as 200 when sole, media-type priority, and schema examples', () => {
    const doc = {
      openapi: '3.1.0',
      info: { title: 'Responses' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/only-default': {
          get: {
            responses: {
              default: {
                description: 'ok',
                content: {
                  'text/plain': { example: 'hi' },
                  'application/vnd.api+json': { schema: { type: 'object', examples: [{ ok: true }] } },
                },
              },
            },
          },
        },
        '/skip-external': {
          get: {
            responses: {
              '4XX': {
                description: 'err',
                content: {
                  'application/json': {
                    examples: { ext: { externalValue: 'https://example.com/a.json' } },
                    schema: { type: 'object', example: { fallback: 1 } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const res = parseOpenApi(doc, makeVars());
    expect(res.endpoints[0].examples).toEqual([
      {
        name: 'default',
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json' },
        body: '{\n  "ok": true\n}',
      },
    ]);
    expect(res.endpoints[1].examples).toEqual([
      {
        name: '4XX',
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: '{\n  "fallback": 1\n}',
      },
    ]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toContain('externalValue');
  });

  it('applies server precedence (operation > path > document), normalises origin, and formats non-JSON generated strings', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Servers' },
      servers: [{ url: 'https://DOC.example.com:443/root' }],
      paths: {
        '/doc-srv': {
          get: { responses: { '200': { description: 'ok', content: { 'text/plain': { schema: { type: 'string', format: 'email' } } } } } },
        },
        '/path-srv': {
          servers: [{ url: 'http://PATH.example.com:80/v2' }],
          get: {
            summary: 'Path summary',
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string', format: 'email' } } } } },
          },
          post: {
            servers: [{ url: 'https://OP.example.com:8443/v3/' }],
            responses: { '5XX': { description: 'err' } },
          },
        },
      },
    };
    const res = parseOpenApi(doc, makeVars());
    expect(res.problems).toEqual([]);
    expect(res.endpoints[0]).toMatchObject({
      key: 'GET /doc-srv',
      name: 'GET /doc-srv',
      origin: 'https://doc.example.com',
      path: ['root', 'doc-srv'],
      examples: [{ name: '200', status: 200, headers: { 'content-type': 'text/plain' }, body: 'user@example.com', generated: true }],
    });
    expect(res.endpoints[1]).toMatchObject({
      key: 'GET /path-srv',
      name: 'Path summary',
      origin: 'http://path.example.com',
      path: ['v2', 'path-srv'],
      examples: [{ name: '200', status: 200, headers: { 'content-type': 'application/json' }, body: '"user@example.com"', generated: true }],
    });
    expect(res.endpoints[2]).toMatchObject({
      key: 'POST /path-srv',
      name: 'POST /path-srv',
      origin: 'https://op.example.com:8443',
      path: ['v3', 'path-srv'],
      examples: [{ name: '5XX', status: 500, headers: {}, body: '' }],
    });
  });

  it('stops fast with a problem line when a YAML billion-laughs document exceeds limits or walkNodes', () => {
    let yaml = 'openapi: "3.1.0"\ninfo:\n  title: Bomb\n  version: "1.0"\n';
    yaml += 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n';
    for (let i = 1; i <= 9; i++) {
      yaml += `a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]\n`;
    }
    yaml +=
      'paths:\n  /bomb:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              example: *a9\n';
    const parsed = parseYaml(yaml, 'bomb.yaml');
    expect(parsed.problem).toBeUndefined();

    const t0 = performance.now();
    const res = parseOpenApi(parsed.value, makeVars());
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.problems.length).toBeGreaterThan(0);

    // A shallow DAG of numbers hits walkNodes (200_000) before exampleBodyBytes (5 MB).
    let shallow = 'openapi: "3.1.0"\ninfo:\n  title: WalkBomb\n  version: "1.0"\n';
    shallow += `w0: &w0 [${Array(100).fill('1').join(', ')}]\n`;
    shallow += `w1: &w1 [${Array(50).fill('*w0').join(', ')}]\n`;
    shallow += `w2: &w2 [${Array(50).fill('*w1').join(', ')}]\n`;
    shallow +=
      'paths:\n  /walk:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              example: *w2\n';
    const shallowParsed = parseYaml(shallow, 'walk.yaml');
    expect(shallowParsed.problem).toBeUndefined();

    const t1 = performance.now();
    const shallowRes = parseOpenApi(shallowParsed.value, makeVars());
    expect(performance.now() - t1).toBeLessThan(1000);
    expect(shallowRes.problems.some((p) => p.includes(String(COLLECTION_LIMITS.walkNodes)))).toBe(true);
  });

  it('never throws on malformed or hostile inputs', () => {
    for (const bad of [null, undefined, 42, 'openapi', [], {}]) {
      const r = parseOpenApi(bad, makeVars());
      expect(r.format).toBe('openapi');
      expect(r.problems.length).toBeGreaterThan(0);
    }

    const swagger2 = parseOpenApi({ swagger: '2.0', info: { title: 'Old' }, paths: {} }, makeVars());
    expect(swagger2.problems[0]).toContain('Swagger 2.0');

    const badParts = parseOpenApi(
      {
        openapi: '3.1.0',
        info: { title: 'BadParts' },
        paths: {
          '/bad-op': {
            get: 'not-an-object',
            post: { responses: 'not-an-object' },
          },
          '/no-responses': {
            get: { operationId: 'noResp' },
          },
          '/bad-examples': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      examples: ['wrong'],
                      schema: { type: 'object', examples: 'wrong' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      makeVars(),
    );
    expect(badParts.problems.length).toBeGreaterThanOrEqual(4);
    expect(badParts.endpoints.map((e) => e.key)).toEqual([
      'POST /bad-op',
      'GET /no-responses',
      'GET /bad-examples',
    ]);
    expect(badParts.endpoints[2].examples[0].generated).toBe(true);

    const badPaths = parseOpenApi({ openapi: '3.1.0', paths: [] }, makeVars());
    expect(badPaths.problems.length).toBeGreaterThan(0);
  });

  it('enforces COLLECTION_LIMITS for endpoints, examplesPerEndpoint and exampleBodyBytes while loading the rest', () => {
    const manyPaths: Record<string, unknown> = {};
    for (let i = 0; i < COLLECTION_LIMITS.endpoints + 10; i++) {
      manyPaths[`/p${i}`] = { get: { responses: { '200': { description: 'ok' } } } };
    }
    const epCapped = parseOpenApi({ openapi: '3.1.0', paths: manyPaths }, makeVars());
    expect(epCapped.endpoints).toHaveLength(COLLECTION_LIMITS.endpoints);
    expect(epCapped.problems).toHaveLength(1);

    const manyExamples: Record<string, unknown> = {};
    for (let i = 0; i < COLLECTION_LIMITS.examplesPerEndpoint + 5; i++) {
      manyExamples[`ex${i}`] = { value: i };
    }
    const exCapped = parseOpenApi(
      {
        openapi: '3.1.0',
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/many': {
            get: {
              responses: {
                '200': { description: 'ok', content: { 'application/json': { examples: manyExamples } } },
              },
            },
          },
          '/after': {
            get: { responses: { '200': { description: 'ok' } } },
          },
        },
      },
      makeVars(),
    );
    expect(exCapped.endpoints).toHaveLength(2);
    expect(exCapped.endpoints[0].examples).toHaveLength(COLLECTION_LIMITS.examplesPerEndpoint);
    expect(exCapped.endpoints[1].key).toBe('GET /after');
    expect(exCapped.problems).toHaveLength(1);

    const hugeStr = 'a'.repeat(COLLECTION_LIMITS.exampleBodyBytes + 100);
    const bodyCapped = parseOpenApi(
      {
        openapi: '3.1.0',
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/huge-plain': {
            get: {
              responses: {
                '200': { description: 'ok', content: { 'text/plain': { example: hugeStr } } },
              },
            },
          },
          '/huge-named-fallback': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': {
                      examples: { tooBig: { value: { blob: hugeStr } } },
                      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
                    },
                  },
                },
              },
            },
          },
          '/next': {
            get: { responses: { '204': { description: 'ok' } } },
          },
        },
      },
      makeVars(),
    );
    expect(bodyCapped.problems).toHaveLength(2);
    // Oversized explicit example is skipped (never truncated or emptied) (§21.3).
    expect(bodyCapped.endpoints[0].examples).toEqual([]);
    // When every named example is skipped as oversized, the next step (schema) applies (§21.3).
    expect(bodyCapped.endpoints[1].examples).toEqual([
      {
        name: '200',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{\n  "ok": true\n}',
        generated: true,
      },
    ]);
    expect(bodyCapped.endpoints[2].key).toBe('GET /next');
  });

  it('never overflows the call stack on 50,000-deep allOf, oneOf, anyOf or $ref chains in response schemas', () => {
    for (const combinator of ['allOf', 'oneOf', 'anyOf'] as const) {
      let s: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 50_000; i++) {
        s = { [combinator]: [s] };
      }
      const doc = {
        openapi: '3.1.0',
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/deep': {
            get: {
              responses: {
                '200': { description: 'ok', content: { 'application/json': { schema: s } } },
              },
            },
          },
        },
      };
      const res = parseOpenApi(doc, makeVars());
      expect(res.problems.length, combinator).toBeGreaterThan(0);
      expect(res.endpoints).toHaveLength(1);
    }

    const schemas: Record<string, unknown> = {};
    for (let i = 1; i < 50_000; i++) {
      schemas[`A${i}`] = { $ref: `#/components/schemas/A${i + 1}` };
    }
    schemas['A50000'] = { type: 'string' };
    const refDoc = {
      openapi: '3.1.0',
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/deep-ref': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/A1' } } },
              },
            },
          },
        },
      },
      components: { schemas },
    };
    const refRes = parseOpenApi(refDoc, makeVars());
    expect(refRes.problems.length).toBeGreaterThan(0);
    expect(refRes.endpoints).toHaveLength(1);
  });

  it('treats __proto__ and constructor as data across path keys, properties and example names', () => {
    const raw = `{
      "openapi": "3.1.0",
      "info": { "title": "Proto" },
      "servers": [{ "url": "https://api.example.com" }],
      "paths": {
        "__proto__": {
          "get": {
            "responses": {
              "200": {
                "description": "ok",
                "headers": {
                  "__proto__": { "example": "hdr-proto" },
                  "constructor": { "example": "hdr-ctor" }
                },
                "content": {
                  "application/json": {
                    "examples": {
                      "__proto__": { "value": { "k": 1 } },
                      "constructor": { "value": { "k": 2 } }
                    }
                  }
                }
              }
            }
          }
        },
        "constructor": {
          "get": {
            "responses": {
              "200": {
                "description": "ok",
                "content": {
                  "application/json": {
                    "schema": {
                      "type": "object",
                      "properties": {
                        "__proto__": { "type": "string" },
                        "constructor": { "type": "integer" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`;
    const doc = JSON.parse(raw);
    const res = parseOpenApi(doc, makeVars());
    expect(res.problems).toEqual([]);
    expect(res.endpoints.map((e) => e.key)).toEqual(['GET __proto__', 'GET constructor']);
    expect(res.endpoints[0].path).toEqual(['__proto__']);
    expect(res.endpoints[0].examples.map((e) => e.name)).toEqual(['200 · __proto__', '200 · constructor']);
    expect(Object.prototype.hasOwnProperty.call(res.endpoints[0].examples[0].headers, '__proto__')).toBe(true);
    expect(res.endpoints[0].examples[0].headers['__proto__']).toBe('hdr-proto');
    expect(res.endpoints[0].examples[0].headers['constructor']).toBe('hdr-ctor');
    expect(JSON.parse(res.endpoints[1].examples[0].body)).toEqual(JSON.parse('{"__proto__":"string","constructor":0}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('caps total example body bytes at 64 MB and reuses serialised text for shared $ref / YAML alias examples (REVIEW-15 #2b)', () => {
    const big = 'A'.repeat(4 * 1024 * 1024);
    const refPaths: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      refPaths[`/p${i}`] = {
        get: {
          responses: {
            '200': {
              description: 'd',
              content: { 'application/json': { examples: { a: { $ref: '#/components/examples/big' } } } },
            },
          },
        },
      };
    }
    const refDoc = {
      openapi: '3.0.0',
      info: { title: 'Ref', version: '1' },
      servers: [{ url: 'https://api.x.example' }],
      components: { examples: { big: { value: big } } },
      paths: refPaths,
    };

    const t0 = performance.now();
    const refRes = parseOpenApi(refDoc, makeVars());
    expect(performance.now() - t0).toBeLessThan(2000);
    const refTotalBytes = refRes.endpoints.reduce((n, e) => n + e.examples.reduce((m, x) => m + x.body.length, 0), 0);
    expect(refTotalBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(refRes.problems).toHaveLength(1);
    expect(refRes.problems[0]).toContain('64 MB');
    expect(refRes.endpoints[0].examples[0].body).toBe(refRes.endpoints[1].examples[0].body);

    const yamlLines = [
      'openapi: 3.0.0',
      'info: {title: Amp, version: "1"}',
      'servers: [{url: "https://api.x.example"}]',
      `x-big: &b "${big}"`,
      'paths:',
    ];
    for (let i = 0; i < 300; i++) {
      yamlLines.push(`  /p${i}: {get: {responses: {"200": {description: d, content: {application/json: {example: *b}}}}}}`);
    }
    const yamlParsed = parseYaml(`${yamlLines.join('\n')}\n`, 'amp.yaml');
    expect(yamlParsed.problem).toBeUndefined();

    const t1 = performance.now();
    const yamlRes = parseOpenApi(yamlParsed.value, makeVars());
    expect(performance.now() - t1).toBeLessThan(2000);
    const yamlTotalBytes = yamlRes.endpoints.reduce((n, e) => n + e.examples.reduce((m, x) => m + x.body.length, 0), 0);
    expect(yamlTotalBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(yamlRes.problems).toHaveLength(1);
    expect(yamlRes.problems[0]).toContain('64 MB');

    // Shared JSON object via $ref under the cap loads on all endpoints and reuses the string.
    const sharedObjDoc = {
      openapi: '3.0.0',
      servers: [{ url: 'https://api.x.example' }],
      components: { examples: { shared: { value: { id: 1, items: [1, 2, 3] } } } },
      paths: {
        '/a': { get: { responses: { '200': { description: 'd', content: { 'application/json': { examples: { x: { $ref: '#/components/examples/shared' } } } } } } } },
        '/b': { get: { responses: { '200': { description: 'd', content: { 'application/json': { examples: { x: { $ref: '#/components/examples/shared' } } } } } } } },
      },
    };
    const sharedRes = parseOpenApi(sharedObjDoc, makeVars());
    expect(sharedRes.problems).toEqual([]);
    expect(sharedRes.endpoints[0].examples[0].body).toBe(sharedRes.endpoints[1].examples[0].body);
  });

  it('sanitises, redacts credentials from URLs, strips bidi/controls, and caps problem lines (REVIEW-15 #7)', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) {
      paths[`/p${i}`] = { get: { responses: { [`${'X'.repeat(300_000)}${i}`]: { description: 'd' } } } };
    }
    paths['/ext'] = {
      get: {
        responses: {
          '200': {
            description: 'd',
            content: {
              'application/json': {
                examples: {
                  'a\u202E\t\nb': {
                    externalValue:
                      'https://ci:ghp_S3cretTokenValue1234567890abcdef@raw.example/ex.json?api_key=leak123\nInjected second line',
                  },
                },
              },
            },
          },
        },
      },
    };
    paths['/ref'] = {
      get: {
        responses: {
          '200': { $ref: 'https://user:pw@schemas.example/r.yaml?token=secret#/x' },
        },
      },
    };
    paths['/srv\u2066bad\u2069'] = {
      get: {
        servers: [{ url: 'https://admin:hunter2@bad host\r\n/v1' }],
        responses: { '200': { description: 'd' } },
      },
    };

    const res = parseOpenApi(
      {
        openapi: '3.0.0',
        info: { title: 'O', version: '1' },
        servers: [{ url: 'https://api.x.example' }],
        paths,
      },
      makeVars(),
    );

    expect(res.problems).toHaveLength(6);
    for (const p of res.problems) {
      expect(p.length).toBeLessThanOrEqual(300);
      expect(p).not.toMatch(/[\r\n\t]/);
      expect(p).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
      expect(p).not.toContain('ghp_S3cretTokenValue1234567890abcdef');
      expect(p).not.toContain('ci:');
      expect(p).not.toContain('user:pw');
      expect(p).not.toContain('admin:hunter2');
      expect(p).not.toContain('leak123');
      expect(p).not.toContain('token=secret');
    }
    // 300 KB response-code keys are cut to 60 chars.
    expect(res.problems[0].length).toBeLessThan(150);
    expect(res.problems.some((p) => p.includes('https://raw.example/ex.json'))).toBe(true);
    expect(res.problems.some((p) => p.includes('https://schemas.example/r.yaml#/x'))).toBe(true);
  });
});
