// CONTRACTS §24.4: Insomnia v4 JSON exports and v5 YAML files (collection, design document, mock server).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { mergeCollectionVars, parsePostmanEnvironment } from '../../src/mocks/environment';
import { isInsomniaDoc, parseInsomnia, parseInsomniaDoc } from '../../src/mocks/insomnia';
import { parsePostman, postmanCollectionVariables } from '../../src/mocks/postman';
import type { MockEndpoint } from '../../src/mocks/types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const read = (name: string): string => fs.readFileSync(path.join(fixtures, name), 'utf8');
const v4Text = read('shop.insomnia-v4.json');
const v5Text = read('shop.insomnia-v5.yaml');
const ENV_SECRET = 'env-token-must-never-leave-the-host';

function postmanShop() {
  const collection = JSON.parse(read('shop.postman_collection.json'));
  const env = JSON.parse(read('shop.postman_environment.json'));
  const vars = mergeCollectionVars({}, parsePostmanEnvironment(env).values, postmanCollectionVariables(collection));
  return parsePostman(collection, vars);
}

/** What an Insomnia collection can express: everything but saved answers. */
const shape = (e: MockEndpoint) => ({
  key: e.key,
  method: e.method,
  name: e.name,
  folder: e.folder,
  origin: e.origin,
  path: e.path,
  unresolved: e.unresolved,
  queryParams: e.queryParams,
});

function expectCleanProblems(problems: string[]): void {
  for (const p of problems) {
    expect(p.length).toBeLessThanOrEqual(300);
    expect(p).not.toMatch(/[\r\n\t\u202a-\u202e\u2066-\u2069]/);
  }
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe('parseInsomnia (shop fixtures)', () => {
  const postman = postmanShop();

  for (const [file, text] of [
    ['shop.insomnia-v4.json', v4Text],
    ['shop.insomnia-v5.yaml', v5Text],
  ] as const) {
    it(`${file}: the same endpoints and variables as the Postman shop collection, without saved answers`, () => {
      const r = parseInsomnia(text, file, { environment: 'Shop dev' });
      expect(r.format).toBe('insomnia');
      expect(r.name).toBe('Shop API');
      expect(r.environments).toEqual(['Shop dev', 'Staging']);
      expect(r.endpoints.map(shape)).toEqual(postman.endpoints.map(shape));
      expect(r.endpoints.every((e) => e.examples.length === 0)).toBe(true);
      expect(r.variables).toEqual(postman.variables);
      expect(r.variables).toEqual([
        { name: 'baseUrl', from: 'environment' },
        { name: 'apiVersion', from: 'collection' },
        { name: 'orderId' },
        { name: 'analyticsHost' },
      ]);
    });

    it(`${file}: request bodies and auth after inheritance; no environment value in the result`, () => {
      const r = parseInsomnia(text, file, { environment: 'Shop dev' });
      const by = (n: string) => r.endpoints.find((e) => e.name === n)!;
      expect(by('Log in').requestBody).toEqual({ contentType: 'application/json', body: '{"email":"sara@example.com","password":"hunter2"}' });
      expect(by('Log in').auth).toBe('none');
      expect(by('Refresh').auth).toBe('declared');
      expect(by('Me').auth).toBe('declared'); // the Users folder's bearer
      expect(by('Order items').auth).toBe('declared'); // two levels down
      const json = JSON.stringify(r);
      expect(json).not.toContain(ENV_SECRET);
      expect(json).not.toContain('refresh-token-literal');
      expect(json).not.toContain('https://api.shop.example/'); // values only as the resolved origin
    });
  }

  it('v5: the collection-level authentication reaches root requests; v5 skips WebSocket requests with one problem', () => {
    const r = parseInsomnia(v5Text, 'shop.insomnia-v5.yaml', { environment: 'Shop dev' });
    expect(r.endpoints.find((e) => e.name === 'Health')!.auth).toBe('declared');
    expect(r.problems).toEqual(['1 gRPC, WebSocket, Socket.IO or MCP requests skipped (HTTP only)']);
    const v4 = parseInsomnia(v4Text, 'shop.insomnia-v4.json', { environment: 'Shop dev' });
    expect(v4.problems).toEqual([]);
    expect(v4.endpoints.find((e) => e.name === 'Health')!.auth).toBeUndefined();
  });

  it('chooses the environment by name; the link variables win; none chosen → unresolved', () => {
    const none = parseInsomnia(v4Text, 'shop.insomnia-v4.json');
    expect(none.endpoints[0]).toMatchObject({ unresolved: ['baseUrl'] });
    expect(none.endpoints[0].origin).toBeUndefined();
    const staging = parseInsomnia(v4Text, 'shop.insomnia-v4.json', { environment: 'Staging' });
    expect(staging.endpoints[0].origin).toBe('https://staging.shop.example');
    const linked = parseInsomnia(v4Text, 'shop.insomnia-v4.json', { environment: 'Staging', variables: { baseUrl: 'http://localhost:8080' } });
    expect(linked.endpoints[0].origin).toBe('http://localhost:8080');
    expect(linked.variables[0]).toEqual({ name: 'baseUrl', from: 'link' });
    const missing = parseInsomnia(v4Text, 'shop.insomnia-v4.json', { environment: 'Prod' });
    expect(missing.problems).toEqual(['Environment "Prod" is not in the file']);
  });

  it('detects Insomnia documents', () => {
    expect(isInsomniaDoc(JSON.parse(v4Text))).toBe(true);
    expect(isInsomniaDoc({ type: 'mock.insomnia.rest/5.0' })).toBe(true);
    expect(isInsomniaDoc({ info: {}, item: [] })).toBe(false);
    expect(isInsomniaDoc(null)).toBe(false);
  });
});

describe('Insomnia variables and templates', () => {
  const doc = (url: string, data: Record<string, unknown> = {}) => ({
    _type: 'export',
    __export_format: 4,
    resources: [
      { _id: 'wrk', _type: 'workspace', name: 'W' },
      { _id: 'env', _type: 'environment', parentId: 'wrk', data },
      { _id: 'r', _type: 'request', parentId: 'wrk', name: 'R', method: 'get', url },
    ],
  });

  it('reads {{ _.x }}, {{ x }} and nested environment objects', () => {
    const r = parseInsomniaDoc(doc('{{ _.api.host }}/{{ version }}/items', { api: { host: 'https://API.x.example' }, version: 'v3' }));
    expect(r.endpoints[0]).toMatchObject({ key: 'GET {{api.host}}/{{version}}/items', origin: 'https://api.x.example', path: ['v3', 'items'] });
    expect(r.variables).toEqual([
      { name: 'api.host', from: 'collection' },
      { name: 'version', from: 'collection' },
    ]);
  });

  it('expands environment values that use other variables', () => {
    const r = parseInsomniaDoc(doc('{{ _.baseUrl }}/x', { host: 'api.x.example', baseUrl: 'https://{{ _.host }}' }));
    expect(r.endpoints[0].origin).toBe('https://api.x.example');
  });

  it('never evaluates Nunjucks: a tag in the host is unresolved, in a path a parameter', () => {
    const host = parseInsomniaDoc(doc("{% response 'body', 'req_1', 'b64::JC50b2tlbg==::46b', 'never', 60 %}/users", {}));
    expect(host.endpoints[0].unresolved).toEqual(['$response']);
    expect(host.endpoints[0].origin).toBeUndefined();
    expect(host.variables).toEqual([]);
    const inPath = parseInsomniaDoc(doc("https://api.x.example/users/{% uuid 'v4' %}/{{ _.x | upper }}", { x: 'abc' }));
    expect(inPath.endpoints[0].path).toEqual(['users', { param: '$uuid' }, { param: '$x' }]);
    // an environment value that is itself a tag is dropped, not evaluated
    const envTag = parseInsomniaDoc(doc('{{ _.baseUrl }}/x', { baseUrl: "{% prompt 'url' %}" }));
    expect(envTag.endpoints[0].unresolved).toEqual(['baseUrl']);
  });

  it('a Nunjucks injection finishes fast as plain text', () => {
    const loop = '{% for i in range(0, 1000000000) %}{{ i }}{% endfor %}'.repeat(100);
    const { value, ms } = timed(() => parseInsomniaDoc(doc(`https://api.x.example/${loop}`)));
    expect(ms).toBeLessThan(200);
    expect(value.endpoints[0].origin).toBe('https://api.x.example');
    expectCleanProblems(value.problems);
  });
});

describe('Insomnia API specs and mock servers', () => {
  const openapi = {
    openapi: '3.0.3',
    info: { title: 'Spec', version: '1' },
    servers: [{ url: 'https://spec.x.example' }],
    paths: { '/ping': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { example: { pong: true } } } } } } } },
  };

  it('v5 design document: the endpoints come from spec.contents', () => {
    const r = parseInsomniaDoc({
      type: 'spec.insomnia.rest/5.0',
      name: 'Design',
      spec: { contents: openapi },
      collection: [{ name: 'generated', url: 'https://spec.x.example/ping', method: 'GET', meta: { id: 'req_1' } }],
    });
    expect(r).toMatchObject({ format: 'insomnia', name: 'Design' });
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0].examples[0].body).toBe('{\n  "pong": true\n}');
  });

  it('v4 api_spec with YAML contents (and Swagger 2.0) is read the same way', () => {
    const yaml = 'openapi: 3.0.3\ninfo: {title: S, version: "1"}\nservers: [{url: "https://spec.x.example"}]\npaths:\n  /a:\n    get:\n      responses:\n        "200": {description: ok}\n';
    const r = parseInsomniaDoc({
      _type: 'export',
      __export_format: 4,
      resources: [
        { _id: 'wrk', _type: 'workspace', name: 'W' },
        { _id: 'spc', _type: 'api_spec', parentId: 'wrk', contents: yaml, contentType: 'yaml' },
      ],
    });
    expect(r.endpoints.map((e) => e.key)).toEqual(['GET /a']);
    const swagger = parseInsomniaDoc({
      type: 'spec.insomnia.rest/5.0',
      spec: { contents: { swagger: '2.0', host: 'old.x.example', paths: { '/b': { get: { responses: { 200: { description: 'ok' } } } } } } },
    });
    expect(swagger.endpoints[0]).toMatchObject({ key: 'GET /b', origin: 'https://old.x.example' });
  });

  it('v5 mock server routes become endpoints with examples on {{baseUrl}}', () => {
    const yaml = [
      'type: mock.insomnia.rest/5.0',
      'name: Shop mock',
      'routes:',
      '  - name: /users/:id',
      '    method: GET',
      '    statusCode: 200',
      '    statusText: Found',
      '    mimeType: application/json',
      '    body: \'{"id":1}\'',
      '    headers:',
      '      - name: X-Mock',
      '        value: "yes"',
      '      - name: X-Off',
      '        value: "no"',
      '        disabled: true',
      '  - name: /users/:id',
      '    method: GET',
      '    statusCode: 404',
      '    body: ""',
      '  - name: health',
      '    body: ok',
      '    mimeType: text/plain',
    ].join('\n');
    const r = parseInsomnia(yaml, 'mock.yaml', { variables: { baseUrl: 'https://api.x.example' } });
    expect(r.problems).toEqual([]);
    expect(r.endpoints.map((e) => [e.key, e.origin, e.path])).toEqual([
      ['GET {{baseUrl}}/users/:id', 'https://api.x.example', ['users', { param: 'id' }]],
      ['GET {{baseUrl}}/health', 'https://api.x.example', ['health']],
    ]);
    expect(r.endpoints[0].examples).toEqual([
      { name: 'Found', status: 200, headers: { 'x-mock': 'yes', 'content-type': 'application/json' }, body: '{"id":1}' },
      { name: '404', status: 404, headers: {}, body: '' },
    ]);
    expect(r.endpoints[1].examples[0].headers).toEqual({ 'content-type': 'text/plain' });
    expect(parseInsomnia(yaml, 'mock.yaml').endpoints[0].unresolved).toEqual(['baseUrl']);
  });

  it('refuses environment files, other v5 types and other export formats with one problem', () => {
    expect(parseInsomniaDoc({ type: 'environment.insomnia.rest/5.0' }).problems).toEqual(['This is an Insomnia environment file, not a collection']);
    expect(parseInsomniaDoc({ type: 'mcpClient.insomnia/5.0' }).problems[0]).toMatch(/isn't supported/);
    expect(parseInsomniaDoc({ _type: 'export', __export_format: 3, resources: [] }).problems[0]).toMatch(/format 3 isn't supported/);
    expect(parseInsomniaDoc({ _type: 'export', __export_format: 4 }).problems).toEqual(['Insomnia export has no "resources" array']);
    expect(parseInsomniaDoc({ hello: 1 }).problems[0]).toMatch(/Not an Insomnia export/);
  });
});

describe('Insomnia hostile input', () => {
  it('never throws on junk and keeps problem lines clean', () => {
    const inputs: unknown[] = [
      null,
      7,
      [],
      { _type: 'export', __export_format: 4, resources: [null, 1, 'x', { _type: 7 }, { _type: 'request', url: 5, method: {} }, { _type: 'request_group' }] },
      { type: 'collection.insomnia.rest/5.0', collection: [null, { children: 'x' }, { url: null }, { url: 'x', method: 'G E T' }], environments: [] },
      { type: 'mock.insomnia.rest/5.0', routes: [null, { name: 5 }, { method: 'bad method' }] },
    ];
    for (const input of inputs) {
      const r = parseInsomniaDoc(input);
      expect(r.format).toBe('insomnia');
      expectCleanProblems(r.problems);
    }
    expect(parseInsomnia('{"_type": "export", "__export_format": 4, "resources": [{"name": "secret-value"', 'x.json').problems.join(' ')).not.toContain(
      'secret-value',
    );
  });

  it('stops deep folders at depth 32 and cyclic parents without hanging', () => {
    let children: unknown[] = [{ name: 'leaf', url: 'https://api.x.example/leaf', method: 'GET' }];
    for (let i = 0; i < 10000; i++) children = [{ name: `F${i}`, children }];
    const { value, ms } = timed(() =>
      parseInsomniaDoc({ type: 'collection.insomnia.rest/5.0', collection: [...children, { name: 'Shallow', url: 'https://api.x.example/s', method: 'GET' }] }),
    );
    expect(ms).toBeLessThan(200);
    expect(value.endpoints.map((e) => e.name)).toEqual(['Shallow']);
    expect(value.problems.join('\n')).toMatch(/exceeds maximum depth of 32/);

    const cyclic = parseInsomniaDoc({
      _type: 'export',
      __export_format: 4,
      resources: [
        { _id: 'a', _type: 'request_group', parentId: 'b', name: 'A' },
        { _id: 'b', _type: 'request_group', parentId: 'a', name: 'B' },
        { _id: 'r', _type: 'request', parentId: 'a', url: 'https://x.example/r' },
        { _id: 's', _type: 'request', parentId: 'nowhere', name: 'Orphan', url: 'https://x.example/s' },
      ],
    });
    expect(cyclic.endpoints.map((e) => e.name)).toEqual(['Orphan']);
  });

  it('handles 10 000 resources and huge strings within the time budget', () => {
    const resources: unknown[] = [{ _id: 'wrk', _type: 'workspace', name: 'W' }];
    for (let i = 0; i < 10000; i++) resources.push({ _id: `r${i}`, _type: 'request', parentId: 'wrk', name: `R${i}`, url: `https://api.x.example/r${i}`, metaSortKey: -i });
    const huge = 'u'.repeat(1_000_000);
    resources.push({ _id: 'big', _type: 'request', parentId: 'wrk', name: huge, url: `https://api.x.example/${huge}`, metaSortKey: -1e9 });
    const { value, ms } = timed(() => parseInsomniaDoc({ _type: 'export', __export_format: 4, resources }));
    expect(ms).toBeLessThan(200);
    expect(value.endpoints).toHaveLength(2000);
    expect(value.problems.some((p) => /more than 2000 endpoints/.test(p))).toBe(true);
    expect(value.problems.some((p) => /URL exceeds 8192 characters/.test(p))).toBe(true);
    expectCleanProblems(value.problems);
  });

  it('keeps __proto__ and constructor as data', () => {
    const text =
      '{"_type":"export","__export_format":4,"resources":[{"_id":"__proto__","_type":"workspace","name":"W"},' +
      '{"_id":"env","_type":"environment","parentId":"__proto__","data":{"__proto__":{"polluted":"https://p.example"},"constructor":"https://c.example"}},' +
      '{"_id":"constructor","_type":"request_group","parentId":"__proto__","name":"__proto__"},' +
      '{"_id":"r","_type":"request","parentId":"constructor","name":"R","url":"{{ constructor }}/{{ __proto__.polluted }}","parameters":[{"name":"__proto__","value":"1"}]}]}';
    const r = parseInsomnia(text, 'p.json');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.endpoints[0]).toMatchObject({ folder: ['__proto__'], origin: 'https://c.example', path: ['https:', 'p.example'], queryParams: ['__proto__'] });
  });

  it('stops a billion-laughs YAML file', () => {
    const lines = ['type: collection.insomnia.rest/5.0', 'a0: &a0 [{url: "https://x.example/a", name: a}, {url: "https://x.example/b", name: b}]'];
    for (let i = 1; i < 12; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`{name: f, children: *a${i - 1}}`).join(', ')}]`);
    lines.push('collection: *a11');
    const { value, ms } = timed(() => parseInsomnia(lines.join('\n'), 'bomb.yaml'));
    expect(ms).toBeLessThan(200);
    expect(value.problems.some((p) => /walk exceeded|more than 2000 endpoints|exceeds/.test(p))).toBe(true);
    expectCleanProblems(value.problems);
  });
});
