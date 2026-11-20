// CONTRACTS §24.4: Swagger 2.0 → OpenAPI 3.0 (`swagger2ToOas3`) → `parseOpenApi` (`parseSwagger2`).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../src/mocks/openapi';
import { parseSwagger2, parseSwagger2Doc, rewriteRef, swagger2ToOas3 } from '../../src/mocks/swagger2';
import { COLLECTION_LIMITS, type CollectionVars, type MockEndpoint } from '../../src/mocks/types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const swaggerText = fs.readFileSync(path.join(fixtures, 'shop.swagger2.json'), 'utf8');
const noVars: CollectionVars = { values: new Map(), sources: new Map() };

function expectCleanProblems(problems: string[]): void {
  for (const p of problems) {
    expect(p.length).toBeLessThanOrEqual(300);
    expect(p).not.toMatch(/[\r\n\t‪-‮⁦-⁩]/);
  }
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

const shape = (e: MockEndpoint) => ({ key: e.key, method: e.method, name: e.name, folder: e.folder, origin: e.origin, path: e.path });

describe('parseSwagger2 (shop fixture)', () => {
  const parsed = parseSwagger2(swaggerText, 'shop.swagger2.json', noVars);
  const byName = (n: string) => parsed.endpoints.find((e) => e.name === n)!;

  it('reads the document as format swagger with no problems', () => {
    expect(parsed.format).toBe('swagger');
    expect(parsed.name).toBe('Shop API');
    expect(parsed.problems).toEqual([]);
    expect(parsed.variables).toEqual([]);
    expect(parsed.endpoints.map((e) => e.key)).toEqual([
      'GET /users',
      'GET /users/{id}',
      'DELETE /users/{id}',
      'POST /orders',
      'POST /auth/login',
      'GET /health',
      'GET /reports/{year}',
    ]);
  });

  it('gives the same endpoints as the OpenAPI 3 shop fixture where Swagger 2.0 can express them', () => {
    const oas = parseOpenApi(JSON.parse(fs.readFileSync(path.join(fixtures, 'shop.openapi.json'), 'utf8')), noVars);
    for (const name of ['listUsers', 'getUser', 'Delete a user', 'report']) {
      const fromOas = oas.endpoints.find((e) => e.name === name)!;
      expect(shape(byName(name))).toEqual(shape(fromOas));
    }
    // the shared Error schema generates the same 404 body; a delete with no content answers the same
    const notFound = (eps: MockEndpoint[]) => eps.find((e) => e.name === 'getUser')!.examples.find((x) => x.status === 404);
    expect(notFound(parsed.endpoints)).toEqual(notFound(oas.endpoints));
    expect(byName('Delete a user').examples).toEqual(oas.endpoints.find((e) => e.name === 'Delete a user')!.examples);
    // Swagger 2.0 has one host for the document (OpenAPI's per-operation server can't be written)
    expect(byName('createOrder').origin).toBe('https://api.shop.example');
    expect(byName('createOrder').path).toEqual(['v1', 'orders']);
  });

  it('turns examples{mime}, produces, x-example and body / formData parameters into examples and request bodies', () => {
    expect(byName('listUsers').examples).toEqual([
      {
        name: '200',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ id: 1, name: 'Sara' }, { id: 2, name: 'Omar' }], null, 2),
      },
    ]);
    expect(byName('listUsers').queryParams).toEqual(['page']);
    const order = byName('createOrder');
    expect(order.examples[0]).toEqual({
      name: '201',
      status: 201,
      headers: { 'content-type': 'application/json', location: '/orders/7' },
      body: JSON.stringify({ id: 7, status: 'pending' }, null, 2),
    });
    expect(order.examples[1]).toMatchObject({ name: 'default', status: 500, generated: true });
    expect(byName('GET /health').examples).toEqual([
      { name: '200', status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
    ]);
    expect(byName('report').examples[0]).toMatchObject({ headers: { 'content-type': 'application/pdf' }, body: '' });
    const login = byName('login');
    expect(login.examples.map((x) => [x.name, x.status])).toEqual([
      ['200', 200],
      ['401', 401],
    ]);
  });

  it('fills requestBody and auth through the converted document (security / securityDefinitions)', () => {
    // parseOpenApi owns these fields; the conversion only has to give it OpenAPI 3 input
    const login = byName('login');
    const order = byName('createOrder');
    expect(login.auth).toBe('none');
    expect(byName('GET /health').auth).toBe('none');
    expect(byName('listUsers').auth).toBe('declared');
    expect(order.requestBody).toEqual({ contentType: 'application/json', body: JSON.stringify({ sku: 'A1', qty: 2 }, null, 2) });
    expect(login.requestBody?.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('reads the same document written as YAML', () => {
    const yaml = [
      'swagger: "2.0"',
      'info: { title: Tiny, version: "1" }',
      'host: api.tiny.example',
      'schemes: [http]',
      'paths:',
      '  /ping:',
      '    get:',
      '      produces: [application/json]',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          examples: { application/json: { pong: true } }',
    ].join('\n');
    const r = parseSwagger2(yaml, 'tiny.yaml', noVars);
    expect(r.problems).toEqual([]);
    expect(r.endpoints[0]).toMatchObject({ key: 'GET /ping', origin: 'http://api.tiny.example', path: ['ping'] });
    expect(r.endpoints[0].examples[0].body).toBe('{\n  "pong": true\n}');
  });
});

describe('swagger2ToOas3', () => {
  const doc = JSON.parse(swaggerText);
  const { doc: oas, problems } = swagger2ToOas3(doc);
  const o = oas as Record<string, any>;

  it('writes servers, components and rewritten local $refs', () => {
    expect(problems).toEqual([]);
    expect(o.openapi).toBe('3.0.3');
    expect(o.servers).toEqual([{ url: 'https://api.shop.example/v1' }]);
    expect(o.components.schemas.User.properties.address.$ref).toBe('#/components/schemas/Address');
    expect(o.components.schemas.User.properties.manager).toEqual({ $ref: '#/components/schemas/User', 'x-nullable': true, nullable: true });
    expect(o.components.schemas.Address.properties.zip.nullable).toBe(true);
    expect(o.components.parameters.UserId).toEqual({ name: 'id', in: 'path', required: true, schema: { type: 'integer' } });
    expect(o.components.responses.NotFound.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Error' });
    expect(o.paths['/users/{id}'].get.responses['404']).toEqual({ $ref: '#/components/responses/NotFound' });
    expect(o.paths['/users/{id}'].get.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]);
    expect(o.paths['/users'].get.parameters[0]).toEqual({ name: 'page', in: 'query', schema: { type: 'integer' }, example: 1 });
    expect(o.paths['/reports/{year}'].get.responses['200'].content['application/pdf'].schema).toEqual({ type: 'string', format: 'binary' });
    expect(o.paths['/orders'].post.responses['201'].headers.Location).toEqual({ schema: { type: 'string' }, example: '/orders/7' });
  });

  it('converts body and formData parameters to requestBody', () => {
    expect(o.paths['/orders'].post.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' }, example: { sku: 'A1', qty: 2 } } },
    });
    expect(o.paths['/auth/login'].post.requestBody).toEqual({
      content: {
        'application/x-www-form-urlencoded': {
          schema: {
            type: 'object',
            properties: { email: { type: 'string' }, password: { type: 'string' } },
            required: ['email', 'password'],
          },
          example: { email: 'sara@example.com' },
        },
      },
    });
    expect(o.paths['/orders'].post.parameters).toBeUndefined();
  });

  it('converts security definitions and keeps security requirements', () => {
    expect(o.components.securitySchemes).toEqual({
      bearer: { type: 'apiKey', name: 'Authorization', in: 'header' },
      oauth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.shop.example/authorize',
            tokenUrl: 'https://auth.shop.example/token',
            scopes: { read: 'Read' },
          },
        },
      },
    });
    expect(o.security).toEqual([{ bearer: [] }]);
    expect(o.paths['/auth/login'].post.security).toEqual([]);
    const basic = swagger2ToOas3({ swagger: '2.0', paths: {}, securityDefinitions: { b: { type: 'basic' }, x: { type: 'magic' } } });
    expect((basic.doc as any).components.securitySchemes).toEqual({ b: { type: 'http', scheme: 'basic' } });
    expect(basic.problems.join('\n')).toMatch(/Security definition "x" has an unknown type/);
  });

  it('keeps a relative server for a basePath without host, and none without either', () => {
    expect((swagger2ToOas3({ swagger: '2.0', basePath: 'api/', paths: {} }).doc as any).servers).toEqual([{ url: '/api' }]);
    expect((swagger2ToOas3({ swagger: '2.0', paths: {} }).doc as any).servers).toBeUndefined();
    const r = parseSwagger2Doc({ swagger: '2.0', basePath: '/api', paths: { '/x': { get: { responses: { 200: { description: 'ok' } } } } } }, noVars);
    expect(r.endpoints[0]).toMatchObject({ path: ['api', 'x'], unresolved: ['baseUrl'] });
    expect(r.variables).toEqual([{ name: 'baseUrl' }]);
  });

  it('rewrites only the four local pointer roots', () => {
    expect(rewriteRef('#/definitions/A~1B')).toBe('#/components/schemas/A~1B');
    expect(rewriteRef('#/parameters/P')).toBe('#/components/parameters/P');
    expect(rewriteRef('#/responses/R')).toBe('#/components/responses/R');
    expect(rewriteRef('#/securityDefinitions/S')).toBe('#/components/securitySchemes/S');
    expect(rewriteRef('other.yaml#/definitions/A')).toBe('other.yaml#/definitions/A');
  });

  it('does not change the input document', () => {
    const before = JSON.stringify(doc);
    swagger2ToOas3(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('Swagger 2.0 hostile input', () => {
  it('rejects what is not Swagger 2.0 with a problem, never throwing', () => {
    for (const input of [null, 42, 'x', [], {}, { swagger: 3 }, { swagger: '3.0' }, { openapi: '3.0.0' }]) {
      const r = swagger2ToOas3(input);
      expect(r.doc).toBeUndefined();
      expect(r.problems.length).toBe(1);
      expect(parseSwagger2Doc(input, noVars)).toMatchObject({ format: 'swagger', endpoints: [] });
    }
    expect(parseSwagger2('{not json', 'x.json', noVars).problems[0]).toMatch(/^x.json line \d+/);
    expect(parseSwagger2('{"swagger": "2.0", "info": {"title": "secret-in-file"', 'x.json', noVars).problems.join(' ')).not.toContain('secret-in-file');
  });

  it('survives junk in every place', () => {
    const junk = {
      swagger: '2.0',
      host: 'a b/c',
      basePath: 7,
      schemes: [null],
      consumes: 'x',
      produces: [1, {}, 'application/json'],
      definitions: [1, 2],
      parameters: { a: null, b: { in: 'body' }, c: { in: 'formData' } },
      responses: { r: 'nope' },
      securityDefinitions: { s: null },
      paths: {
        '/a': null,
        '/b': { get: null, post: 'x', parameters: 'p', put: { parameters: [null, 1, { $ref: 7 }], responses: [] } },
        '/c': { get: { parameters: [{ in: 'body' }, { in: 'formData' }], responses: { 200: null, 201: { schema: 5, examples: 'e' } } } },
        'x-ext': { anything: true },
      },
    };
    const { value, ms } = timed(() => parseSwagger2Doc(junk, noVars));
    expect(ms).toBeLessThan(200);
    expect(value.format).toBe('swagger');
    expectCleanProblems(value.problems);
    expect(value.problems.join('\n')).toMatch(/Swagger "host" is not a valid host/);
  });

  it('stops deep nesting and long $ref chains with problems, fast', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20000; i++) deep = { type: 'object', properties: { n: deep } };
    const doc = {
      swagger: '2.0',
      host: 'api.x.example',
      definitions: { Deep: deep },
      paths: { '/d': { get: { responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Deep' } } } } } },
    };
    const { value, ms } = timed(() => parseSwagger2Doc(doc, noVars));
    expect(ms).toBeLessThan(200);
    expect(value.endpoints).toHaveLength(1);
    expect(value.problems.join('\n')).toMatch(/Schema nesting deeper than 128 levels was cut/);
    expectCleanProblems(value.problems);

    const params: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) params[`P${i}`] = { $ref: `#/parameters/P${i + 1}` };
    params.P50 = { $ref: '#/parameters/P0' };
    const chain = parseSwagger2Doc(
      { swagger: '2.0', parameters: params, paths: { '/p': { get: { parameters: [{ $ref: '#/parameters/P0' }], responses: { 200: { description: 'ok' } } } } } },
      noVars,
    );
    expect(chain.endpoints).toHaveLength(1);
    expect(chain.problems.join('\n')).toMatch(/circular or too deep \$ref/);
  });

  it('copies cyclic and shared schemas once', () => {
    const user: Record<string, unknown> = { type: 'object', properties: {} };
    (user.properties as Record<string, unknown>).self = user;
    (user.properties as Record<string, unknown>).also = user;
    const { doc, problems } = swagger2ToOas3({ swagger: '2.0', definitions: { User: user }, paths: {} });
    expect(problems).toEqual([]);
    const copy = (doc as any).components.schemas.User;
    expect(copy.properties.self).toBe(copy);
    expect(copy.properties.also).toBe(copy);
  });

  it('keeps __proto__ and constructor as data and never touches Object.prototype', () => {
    const text =
      '{"swagger":"2.0","host":"api.x.example","definitions":{"__proto__":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"$ref":"#/definitions/__proto__"}}}},' +
      '"paths":{"/__proto__":{"get":{"operationId":"constructor","responses":{"200":{"description":"ok","schema":{"$ref":"#/definitions/__proto__"}}}}}}}';
    const r = parseSwagger2(text, 'p.json', noVars);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'properties')).toBe(false);
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0].path).toEqual(['__proto__']);
    const conv = swagger2ToOas3(JSON.parse(text)).doc as Record<string, any>;
    expect(Object.prototype.hasOwnProperty.call(conv.components.schemas, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(conv.components.schemas)).toBeNull();
  });

  it('caps huge strings and keeps problem lines clean (≤ 300 chars, one line, no bidi)', () => {
    const huge = 'p'.repeat(300_000);
    const evil = 'a‮b\r\nc\td';
    const doc = {
      swagger: '2.0',
      host: 'api.x.example',
      basePath: `/${huge}`,
      securityDefinitions: { [evil + huge]: { type: 'nope' } },
      paths: {
        [`/${huge}`]: { get: { responses: { 200: { description: 'ok' } } } },
        '/ext': { get: { parameters: [{ $ref: `https://user:pw@evil.example/${evil}` }], responses: { 200: { $ref: `#/responses/${evil}` } } } },
      },
    };
    const { value, ms } = timed(() => parseSwagger2Doc(doc, noVars));
    expect(ms).toBeLessThan(200);
    expect(value.problems.length).toBeGreaterThan(2);
    expectCleanProblems(value.problems);
    expect(value.problems.join('\n')).not.toContain('pw@');
  });

  it('stops a billion-laughs YAML document on the walk budget', () => {
    const lines = ['swagger: "2.0"', 'host: api.x.example', 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 10; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
    lines.push('definitions:', '  Bomb:', '    type: object', '    enum: *a9', '    properties:', '      x: { type: array, items: *a9 }');
    lines.push('paths:', '  /bomb:', '    get:', '      responses:', '        "200":', '          description: ok', '          schema: { $ref: "#/definitions/Bomb" }', '          examples: { application/json: *a9 }');
    const { value, ms } = timed(() => parseSwagger2(lines.join('\n'), 'bomb.yaml', noVars));
    expect(ms).toBeLessThan(200);
    expect(value.problems.some((p) => /walk exceeded|exceeds|exceeded/.test(p))).toBe(true);
    expectCleanProblems(value.problems);
  });

  it('rejects a file over the size limit without reading it', () => {
    const big = ' '.repeat(COLLECTION_LIMITS.fileBytes + 1);
    const { value, ms } = timed(() => parseSwagger2(big, 'big.json', noVars));
    expect(ms).toBeLessThan(200);
    expect(value.problems).toEqual(['big.json is larger than 20 MB (not read)']);
  });
});

describe('Swagger 2.0 version written as a YAML number', () => {
  it('accepts `swagger: 2.0` read as the number 2', () => {
    const r = swagger2ToOas3({ swagger: 2, info: { title: 'T', version: '1' }, host: 'api.example.com', paths: {} });
    expect(r.problems).toEqual([]);
    expect(r.doc).toBeDefined();
  });
});
