// CONTRACTS §21.1, §21.2: Postman collection parser, limits, v2.0 forms and prototype safety.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { mergeCollectionVars, parsePostmanEnvironment } from '../../src/mocks/environment';
import { parsePostman, postmanCollectionVariables } from '../../src/mocks/postman';
import { parseYaml } from '../../src/mocks/yaml';
import { COLLECTION_LIMITS, type CollectionVars, type ParsedCollection } from '../../src/mocks/types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const emptyVars = (): CollectionVars => ({ values: new Map(), sources: new Map() });

describe('parsePostman', () => {
  it('matches shop.expected.json exactly for shop.postman_collection.json + shop.postman_environment.json', () => {
    const collection = readJson('shop.postman_collection.json');
    const env = readJson('shop.postman_environment.json');
    const expected = readJson('shop.expected.json') as {
      postman: {
        format: string;
        name: string;
        variables: ParsedCollection['variables'];
        problemCount: number;
        problemsContain: string[];
        endpoints: ParsedCollection['endpoints'];
      };
    };

    const vars = mergeCollectionVars({}, parsePostmanEnvironment(env).values, postmanCollectionVariables(collection));
    const parsed = parsePostman(collection, vars);

    expect(parsed.format).toBe(expected.postman.format);
    expect(parsed.name).toBe(expected.postman.name);
    expect(parsed.variables).toEqual(expected.postman.variables);
    expect(parsed.endpoints).toEqual(expected.postman.endpoints);
    expect(parsed.problems).toHaveLength(expected.postman.problemCount);
    for (const needle of expected.postman.problemsContain) {
      expect(parsed.problems.some((p) => p.includes(needle))).toBe(true);
    }
  });

  it('extracts collection variables ignoring disabled and empty values', () => {
    const vars = postmanCollectionVariables({
      variable: [
        { key: 'a', value: '1' },
        { key: 'b', value: '' },
        { key: 'c', value: '3', disabled: true },
        { key: 'd', value: 10 },
      ],
    });
    expect(Object.fromEntries(vars)).toEqual({ a: '1', d: '10' });
  });

  it('never throws on bad or hostile inputs and reports problems', () => {
    for (const bad of [null, 42, [], {}]) {
      const res = parsePostman(bad, emptyVars());
      expect(res.format).toBe('postman');
      expect(res.endpoints).toEqual([]);
      expect(res.problems.length).toBeGreaterThan(0);
    }

    const badItems = parsePostman(
      {
        info: { name: 'Hostile' },
        item: [
          null,
          42,
          'not-an-object',
          {
            name: 'Bad URL object',
            request: {
              method: 'GET',
              url: { raw: 123, host: 456, port: true, path: 789, query: 'bad' },
            },
          },
          {
            name: 'Bad response array',
            request: 'https://api.example.com/ok',
            response: 'not-an-array',
          },
          {
            name: 'Bad body type',
            request: 'https://api.example.com/body',
            response: [{ name: 'Bad', code: 200, header: [], body: { not: 'a string' } }],
          },
        ],
      },
      emptyVars(),
    );

    expect(badItems.problems.length).toBeGreaterThanOrEqual(6);
    expect(badItems.endpoints.find((e) => e.name === 'Bad response array')?.examples).toEqual([]);
    expect(badItems.endpoints.find((e) => e.name === 'Bad body type')?.examples[0].body).toBe('');
  });

  it('enforces every limit in COLLECTION_LIMITS with a problem line while loading the rest', () => {
    // 1. > 2000 endpoints
    const manyItems = Array.from({ length: COLLECTION_LIMITS.endpoints + 5 }, (_, i) => ({
      name: `Req ${i}`,
      request: `https://api.example.com/r/${i}`,
    }));
    const overEndpoints = parsePostman({ info: { name: 'Many' }, item: manyItems }, emptyVars());
    expect(overEndpoints.endpoints).toHaveLength(COLLECTION_LIMITS.endpoints);
    expect(overEndpoints.problems).toHaveLength(1);
    expect(overEndpoints.problems[0]).toContain(String(COLLECTION_LIMITS.endpoints));

    // 2. > 20 examples
    const manyResponses = Array.from({ length: COLLECTION_LIMITS.examplesPerEndpoint + 4 }, (_, i) => ({
      name: `Ex ${i}`,
      code: 200,
      header: [],
      body: `${i}`,
    }));
    const overExamples = parsePostman(
      { info: { name: 'Ex' }, item: [{ name: 'E1', request: 'https://api.example.com/e', response: manyResponses }] },
      emptyVars(),
    );
    expect(overExamples.endpoints[0].examples).toHaveLength(COLLECTION_LIMITS.examplesPerEndpoint);
    expect(overExamples.problems).toHaveLength(1);
    expect(overExamples.problems[0]).toContain('E1');

    // 3. folder depth > 32
    let deep: Record<string, unknown> = {
      name: 'TooDeep',
      request: 'https://api.example.com/deep',
    };
    for (let d = COLLECTION_LIMITS.folderDepth + 2; d >= 1; d--) {
      deep = { name: `F${d}`, item: [deep] };
    }
    const overDepth = parsePostman(
      {
        info: { name: 'Depth' },
        item: [deep, { name: 'Shallow', request: 'https://api.example.com/shallow' }],
      },
      emptyVars(),
    );
    expect(overDepth.endpoints.map((e) => e.name)).toEqual(['Shallow']);
    expect(overDepth.problems).toHaveLength(1);
    expect(overDepth.problems[0]).toContain(String(COLLECTION_LIMITS.folderDepth));

    // 4. URL > 8 KB
    const longUrl = `https://api.example.com/${'a'.repeat(COLLECTION_LIMITS.urlChars + 100)}`;
    const overUrl = parsePostman(
      {
        info: { name: 'Url' },
        item: [
          { name: 'HugeUrl', request: longUrl },
          { name: 'Normal', request: 'https://api.example.com/ok' },
        ],
      },
      emptyVars(),
    );
    expect(overUrl.endpoints.map((e) => e.name)).toEqual(['Normal']);
    expect(overUrl.problems).toHaveLength(1);
    expect(overUrl.problems[0]).toContain('HugeUrl');

    // 5. body > 5 MB
    const hugeBody = 'x'.repeat(COLLECTION_LIMITS.exampleBodyBytes + 10);
    const overBody = parsePostman(
      {
        info: { name: 'Body' },
        item: [
          {
            name: 'BigBody',
            request: 'https://api.example.com/big',
            response: [
              { name: 'TooBig', code: 200, header: [], body: hugeBody },
              { name: 'Small', code: 200, header: [], body: 'ok' },
            ],
          },
        ],
      },
      emptyVars(),
    );
    expect(overBody.endpoints[0].examples.map((e) => e.name)).toEqual(['Small']);
    expect(overBody.problems).toHaveLength(1);
    expect(overBody.problems[0]).toContain('TooBig');
  });

  it('keeps __proto__ and constructor keys as data in variables, headers and query without polluting Object.prototype', () => {
    const rawJson = JSON.stringify({
      info: { name: 'Proto' },
      variable: [
        { key: '__proto__', value: 'v1' },
        { key: 'constructor', value: 'v2' },
      ],
      item: [
        {
          name: 'ProtoReq',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/{{__proto__}}/{{constructor}}' },
          },
          response: [
            {
              name: 'Res',
              code: 200,
              originalRequest: {
                url: {
                  raw: 'https://api.example.com/v1/v2?__proto__=qp&constructor=qc',
                  query: [
                    { key: '__proto__', value: 'qp' },
                    { key: 'constructor', value: 'qc' },
                  ],
                },
              },
              header: [
                { key: '__proto__', value: 'hp1' },
                { key: '__proto__', value: 'hp2' },
                { key: 'constructor', value: 'hc' },
              ],
              body: 'ok',
            },
          ],
        },
      ],
    });
    const doc = JSON.parse(rawJson);
    const collVars = postmanCollectionVariables(doc);
    const merged = mergeCollectionVars({}, new Map(), collVars);
    const parsed = parsePostman(doc, merged);

    expect(parsed.problems).toEqual([]);
    expect(parsed.endpoints[0].path).toEqual(['v1', 'v2']);

    const ex = parsed.endpoints[0].examples[0];
    expect(Object.prototype.hasOwnProperty.call(ex.headers, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(ex.headers, '__proto__')?.value).toBe('hp1, hp2');
    expect(Object.getOwnPropertyDescriptor(ex.headers, 'constructor')?.value).toBe('hc');

    expect(ex.query).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(ex.query!, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(ex.query!, '__proto__')?.value).toBe('qp');
    expect(Object.getOwnPropertyDescriptor(ex.query!, 'constructor')?.value).toBe('qc');
    expect(({} as Record<string, unknown>).hp1).toBeUndefined();
    expect(({} as Record<string, unknown>).qp).toBeUndefined();
  });

  it('handles Postman v2.0 forms (request as string, url as string, header as string)', () => {
    const vars: CollectionVars = {
      values: new Map([['baseUrl', 'http://LOCALHOST:80']]),
      sources: new Map([['baseUrl', 'link']]),
    };
    const parsed = parsePostman(
      {
        info: {
          name: 'V2',
          schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json',
        },
        item: [
          {
            name: 'StringReq',
            request: 'example.com:443/ping?x=1#top',
            response: [{ name: 'OK', code: 200, header: 'Content-Type: text/plain', body: 'pong' }],
          },
          {
            name: 'StringUrlAndHeaders',
            request: {
              method: 'POST',
              header: 'Authorization: Bearer x\nContent-Type: application/json',
              url: '{{baseUrl}}/users/:id?tab=profile',
            },
            response: [
              {
                name: 'Saved',
                code: 201,
                _postman_previewlanguage: 'xml',
                header: 'X-Legacy: 1',
                body: '<ok/>',
              },
            ],
          },
        ],
      },
      vars,
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.endpoints[0]).toEqual({
      key: 'GET example.com:443/ping',
      method: 'GET',
      name: 'StringReq',
      folder: [],
      origin: 'https://example.com',
      path: ['ping'],
      unresolved: [],
      queryParams: ['x'],
      examples: [
        {
          name: 'OK',
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: 'pong',
        },
      ],
    });
    expect(parsed.endpoints[1]).toEqual({
      key: 'POST {{baseUrl}}/users/:id',
      method: 'POST',
      name: 'StringUrlAndHeaders',
      folder: [],
      origin: 'http://localhost',
      path: ['users', { param: 'id' }],
      unresolved: [],
      queryParams: ['tab'],
      examples: [
        {
          name: 'Saved',
          status: 201,
          headers: { 'content-type': 'application/xml' },
          body: '<ok/>',
        },
      ],
    });
  });

  it('handles object parts winning over raw, dynamic vars, ports, preview languages, and query vars', () => {
    const vars: CollectionVars = {
      values: new Map([
        ['baseUrl', 'https://api.example.com/v1'],
        ['q', 'literal'],
      ]),
      sources: new Map([
        ['baseUrl', 'link'],
        ['q', 'link'],
      ]),
    };

    const parsed = parsePostman(
      {
        info: { name: 'Edge' },
        item: [
          {
            name: 'PartsWin',
            request: {
              method: 'get',
              url: {
                raw: 'http://wrong.example:8080/wrong?a=1',
                protocol: 'https',
                host: ['new', 'example'],
                port: '8443',
                path: ['right', '{{$guid}}'],
              },
            },
            response: [
              {
                name: 'Html',
                code: 200,
                _postman_previewlanguage: 'html',
                header: [{ key: 'Proxy-Connection', value: 'keep-alive' }, { key: ':status', value: '200' }],
                body: '<p>hi</p>',
                originalRequest: {
                  url: {
                    raw: 'https://new.example:8443/right/1?a=1&dyn={{q}}&mode=full',
                  },
                },
              },
            ],
          },
          {
            name: 'DynamicHost',
            request: {
              method: 'GET',
              url: 'https://{{$guid}}.example.com/x',
            },
          },
          {
            name: 'BasePrefix',
            request: {
              method: 'GET',
              url: { raw: '{{baseUrl}}/orders', host: ['{{baseUrl}}'], path: ['orders'] },
            },
          },
        ],
      },
      vars,
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.endpoints[0]).toEqual({
      key: 'GET http://wrong.example:8080/wrong',
      method: 'GET',
      name: 'PartsWin',
      folder: [],
      origin: 'https://new.example:8443',
      path: ['right', { param: '$guid' }],
      unresolved: [],
      queryParams: ['a'],
      examples: [
        {
          name: 'Html',
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: '<p>hi</p>',
          query: { mode: 'full' },
        },
      ],
    });
    expect(parsed.endpoints[1].origin).toBeUndefined();
    expect(parsed.endpoints[1].unresolved).toEqual(['$guid']);
    expect(parsed.endpoints[2].origin).toBe('https://api.example.com');
    expect(parsed.endpoints[2].path).toEqual(['v1', 'orders']);
    // Dynamic $guid in path is not listed as an unset user variable.
    expect(parsed.variables).toEqual([{ name: 'baseUrl', from: 'link' }]);
  });

  it('keeps problem lines single-line, <= 300 chars, without bidi controls or URL credentials (REVIEW-15 #7)', () => {
    const vars: CollectionVars = {
      values: new Map([['badHost', 'not a valid host\nsecret-env-token']]),
      sources: new Map([['badHost', 'environment']]),
    };
    const hostileName = `https://ci:ghp_S3cretTokenValue123456@raw.example/ex\nLine2\t\u202E\u2066${'A'.repeat(400)}`;
    const parsed = parsePostman(
      {
        info: { name: 'SafeProblems' },
        item: [
          {
            name: hostileName,
            request: { method: 'GET', url: 'https://{{badHost}}/a' },
            response: [{ name: `Ex\r\n\u202A${'B'.repeat(400)}`, header: [] }],
          },
          {
            request: `https://deploy:UrlPass999@api.example/${'c'.repeat(COLLECTION_LIMITS.urlChars + 10)}`,
          },
        ],
      },
      vars,
    );
    expect(parsed.problems.length).toBeGreaterThanOrEqual(3);
    for (const p of parsed.problems) {
      expect(p.length).toBeLessThanOrEqual(300);
      expect(p).not.toMatch(/[\r\n\t\u202A-\u202E\u2066-\u2069]/);
      expect(p).not.toContain('secret-env-token');
      expect(p).not.toContain('ghp_S3cretTokenValue123456');
      expect(p).not.toContain('UrlPass999');
    }
  });

  it('stops on a YAML alias DAG at COLLECTION_LIMITS.walkNodes in < 1 s (REVIEW-15 #2a)', () => {
    const lines = [
      'info: {name: DAG, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"}',
      'x:',
      '  - &l0 {name: f0, item: []}',
    ];
    for (let i = 1; i <= 7; i++) {
      lines.push(`  - &l${i} {name: f${i}, item: [${Array(10).fill(`*l${i - 1}`).join(', ')}]}`);
    }
    lines.push('item: [*l7]');
    const yaml = parseYaml(`${lines.join('\n')}\n`, 'dag7.postman_collection.yaml');
    expect(yaml.problem).toBeUndefined();

    const t0 = performance.now();
    const parsed = parsePostman(yaml.value, emptyVars());
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(1000);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toContain(String(COLLECTION_LIMITS.walkNodes));
  });

  it('caps total aliased example body bytes at 64 MB with one problem line (REVIEW-15 #2c)', () => {
    const big = 'A'.repeat(4 * 1024 * 1024);
    const lines = [
      'info: {name: Amp, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"}',
      'item:',
      `  - {name: r0, request: "https://api.x.example/r0", response: [{name: ok, code: 200, body: &b "${big}"}]}`,
    ];
    for (let i = 1; i < 200; i++) {
      lines.push(`  - {name: r${i}, request: "https://api.x.example/r${i}", response: [{name: ok, code: 200, body: *b}]}`);
    }
    const yaml = parseYaml(`${lines.join('\n')}\n`, 'amp.postman_collection.yaml');
    expect(yaml.problem).toBeUndefined();

    const parsed = parsePostman(yaml.value, emptyVars());
    const totalBytes = parsed.endpoints.reduce(
      (sum, ep) => sum + ep.examples.reduce((s, ex) => s + ex.body.length, 0),
      0,
    );

    expect(parsed.endpoints).toHaveLength(200);
    expect(totalBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(totalBytes).toBe(16 * 4 * 1024 * 1024);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toContain('64 MB');
  });
});

describe('parsePostman: queryParams (CONTRACTS §22.2)', () => {
  const parse = (url: unknown) =>
    parsePostman({ info: { name: 'Q' }, item: [{ name: 'R', request: { method: 'GET', url } }] }, emptyVars()).endpoints[0];

  it('url.query keys in file order, disabled ones included; else the raw query string; none → absent', () => {
    expect(
      parse({
        raw: 'https://q.test/items?page=1&ignored=1',
        host: ['q', 'test'],
        path: ['items'],
        query: [{ key: 'page', value: '1' }, { key: 'limit', value: '10', disabled: true }, { key: 'page', value: '2' }, { value: 'no key' }],
      }).queryParams,
    ).toEqual(['page', 'limit']);
    expect(parse('https://q.test/items?sort=name&order=desc').queryParams).toEqual(['sort', 'order']);
    expect('queryParams' in parse('https://q.test/items')).toBe(false);
  });

  it('at most 20 names, each at most 100 characters', () => {
    const query = [{ key: 'y'.repeat(101) }, ...Array.from({ length: 30 }, (_, i) => ({ key: `k${i}` }))];
    const qp = parse({ raw: 'https://q.test/items', query }).queryParams;
    expect(qp).toHaveLength(20);
    expect(qp?.[0]).toBe('k0');
  });
});
