// CONTRACTS §24.4: Bruno collections — bruno.json, .bru request files, folder.bru, collection.bru, environments/*.bru.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { brunoLimits, parseBruno, type BrunoFile } from '../../src/mocks/bruno';
import { mergeCollectionVars, parsePostmanEnvironment } from '../../src/mocks/environment';
import { parsePostman, postmanCollectionVariables } from '../../src/mocks/postman';
import type { MockEndpoint } from '../../src/mocks/types';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const read = (name: string): string => fs.readFileSync(path.join(fixtures, name), 'utf8');

function readFolder(dir: string): BrunoFile[] {
  const out: BrunoFile[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push({ path: path.relative(fixtures, p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}
const shopFiles = readFolder(path.join(fixtures, 'shop-bruno'));

function postmanShop() {
  const collection = JSON.parse(read('shop.postman_collection.json'));
  const env = JSON.parse(read('shop.postman_environment.json'));
  const vars = mergeCollectionVars({}, parsePostmanEnvironment(env).values, postmanCollectionVariables(collection));
  return parsePostman(collection, vars);
}

const shape = (e: MockEndpoint) => ({
  key: e.key,
  method: e.method,
  name: e.name,
  folder: e.folder,
  origin: e.origin,
  path: e.path,
  unresolved: e.unresolved,
  queryParams: e.queryParams,
  requestBody: e.requestBody,
  auth: e.auth,
  examples: e.examples.map((x) => ({ name: x.name, status: x.status, headers: x.headers, body: x.body, query: x.query, request: x.request })),
});

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

/** A one-request collection. */
function one(bru: string, extra: BrunoFile[] = []): BrunoFile[] {
  return [{ path: 'c/bruno.json', text: '{"version":"1","name":"C","type":"collection"}' }, { path: 'c/r.bru', text: bru }, ...extra];
}

describe('parseBruno (shop fixture)', () => {
  const postman = postmanShop();
  const parsed = parseBruno(shopFiles, { environment: 'dev' });

  it('gives exactly the Postman shop collection: endpoints, examples, query and request bodies, auth, variables', () => {
    expect(parsed.format).toBe('bruno');
    expect(parsed.name).toBe('Shop API');
    expect(parsed.problems).toEqual([]);
    expect(parsed.environments).toEqual(['dev', 'staging']);
    expect(parsed.endpoints.map(shape)).toEqual(postman.endpoints.map(shape));
    expect(parsed.variables).toEqual([
      { name: 'baseUrl', from: 'environment' },
      { name: 'apiVersion', from: 'collection' },
      { name: 'orderId' },
      { name: 'analyticsHost' },
    ]);
  });

  it('reads examples the way Bruno writes them', () => {
    const login = parsed.endpoints[0];
    expect(login.examples[0].body).toBe('{\n  "token": "abc",\n  "user": { "id": 1, "name": "Sara" }\n}');
    expect(login.examples[1].request).toEqual({ contentType: 'application/json', body: '{"email":"sara@example.com","password":"wrong-guess"}' });
    const list = parsed.endpoints.find((e) => e.name === 'List users')!;
    expect(list.examples.map((x) => x.query)).toEqual([undefined, { page: '2' }]);
    const config = parsed.endpoints.find((e) => e.name === 'Remote config')!;
    expect(config.examples[0].headers).toEqual({ 'content-type': 'application/json', 'x-tag': 'a, b', 'set-cookie': 'a=1' });
  });

  it('never puts auth values, secrets, scripts or environment values in the result', () => {
    const json = JSON.stringify(parsed);
    for (const secret of ['refresh-token-literal', 'live-key-123', 'literal-in-header', 'Date.now', 'https://api.shop.example/', 'stats.shop.example']) {
      expect(json).not.toContain(secret);
    }
  });

  it('chooses the environment by name; the link variables win; none chosen → unresolved', () => {
    expect(parseBruno(shopFiles).endpoints[0]).toMatchObject({ unresolved: ['baseUrl'] });
    expect(parseBruno(shopFiles, { environment: 'staging' }).endpoints[0].origin).toBe('https://staging.shop.example');
    const linked = parseBruno(shopFiles, { environment: 'dev', variables: { baseUrl: 'http://localhost:3000' } });
    expect(linked.endpoints[0].origin).toBe('http://localhost:3000');
    expect(linked.variables[0]).toEqual({ name: 'baseUrl', from: 'link' });
    expect(parseBruno(shopFiles, { environment: 'prod' }).problems).toEqual(['Environment "prod" is not in the collection']);
  });

  it('never reads .env files, secret vars or files outside the collection, and accepts Windows paths', () => {
    const files: BrunoFile[] = [
      ...shopFiles.map((f) => ({ ...f, path: f.path.replace(/\//g, '\\') })),
      { path: 'shop-bruno\\.env', text: 'baseUrl=https://evil.example\n' },
      { path: 'shop-bruno\\.hidden\\x.bru', text: 'get {\n  url: https://evil.example/hidden\n}\n' },
      { path: 'shop-bruno\\node_modules\\x.bru', text: 'get {\n  url: https://evil.example/nm\n}\n' },
      { path: 'other\\y.bru', text: 'get {\n  url: https://evil.example/outside\n}\n' },
    ];
    const r = parseBruno(files, { environment: 'dev' });
    expect(r.endpoints.map(shape)).toEqual(parsed.endpoints.map(shape));
    expect(JSON.stringify(r)).not.toContain('evil');
  });
});

describe('the .bru reader', () => {
  it('reads a Bruno-written request: quoted and disabled keys, multi-line values, form bodies, custom methods', () => {
    const bru = [
      'meta {',
      '  name: Send',
      '  type: http',
      '  seq: 1',
      '  tags: [',
      '    foo',
      '  ]',
      '}',
      '',
      'http {',
      '  method: PURGE',
      '  url: https://api.x.example/send/:id?apiKey=1',
      '  body: formUrlEncoded',
      '  auth: bearer',
      '}',
      '',
      'params:query {',
      '  apiKey: 1',
      '  "key with spaces": allowed',
      '  ~message: hello',
      '}',
      '',
      'body:form-urlencoded {',
      '  apikey: secret',
      '  ~off: x',
      '  @description(\'note\')',
      '  numbers: +91',
      '}',
      '',
      'auth:bearer {',
      '  token: never-read',
      '}',
      '',
      'docs {',
      '  }',
      '  not a block end',
      '}',
    ].join('\n');
    const r = parseBruno(one(bru));
    expect(r.problems).toEqual([]);
    expect(r.endpoints[0]).toMatchObject({
      key: 'PURGE https://api.x.example/send/:id',
      method: 'PURGE',
      name: 'Send',
      path: ['send', { param: 'id' }],
      queryParams: ['apiKey', 'key with spaces', 'message'],
      requestBody: { contentType: 'application/x-www-form-urlencoded', body: 'apikey=secret&numbers=%2B91' },
      auth: 'declared',
    });
    expect(JSON.stringify(r)).not.toContain('never-read');
  });

  it('reads a swapped status (old Postman imports) and a missing status as 200', () => {
    const bru = [
      'get {',
      '  url: https://api.x.example/t',
      '}',
      '',
      'example {',
      '  name: Swapped',
      '',
      '  response: {',
      '    status: {',
      '      code: Accepted',
      '      text: 202',
      '    }',
      '  }',
      '}',
      '',
      'example {',
      '  name: No status',
      '',
      '  response: {',
      '    body: {',
      '      type: xml',
      "      content: '''",
      '        <a>',
      '          <b/>',
      '        </a>',
      "      '''",
      '    }',
      '  }',
      '}',
    ].join('\n');
    const r = parseBruno(one(bru));
    expect(r.endpoints[0].examples).toEqual([
      { name: 'Swapped', status: 202, headers: {}, body: '' },
      { name: 'No status', status: 200, headers: { 'content-type': 'application/xml' }, body: '<a>\n  <b/>\n</a>' },
    ]);
  });

  it('settles auth: inherit through folder.bru, then collection.bru', () => {
    const files: BrunoFile[] = [
      { path: 'c/bruno.json', text: '{"name":"C"}' },
      { path: 'c/collection.bru', text: 'auth {\n  mode: none\n}\n' },
      { path: 'c/a/folder.bru', text: 'meta {\n  name: A\n  seq: 1\n}\n\nauth {\n  mode: apikey\n}\n' },
      { path: 'c/a/r.bru', text: 'meta {\n  name: In A\n}\n\nget {\n  url: https://x.example/a\n  auth: inherit\n}\n' },
      { path: 'c/r.bru', text: 'meta {\n  name: Root\n  seq: 2\n}\n\nget {\n  url: https://x.example/r\n  auth: inherit\n}\n' },
      { path: 'c/s.bru', text: 'meta {\n  name: Own\n  seq: 3\n}\n\nget {\n  url: https://x.example/s\n}\n' },
    ];
    const r = parseBruno(files);
    expect(r.endpoints.map((e) => [e.name, e.folder, e.auth])).toEqual([
      ['In A', ['A'], 'declared'],
      ['Root', [], 'none'],
      ['Own', [], 'none'],
    ]);
  });

  it('skips gRPC / WebSocket requests and files without a method block, with problems', () => {
    const r = parseBruno([
      { path: 'c/bruno.json', text: '{}' },
      { path: 'c/g.bru', text: 'meta {\n  type: grpc\n}\n\ngrpc {\n  url: grpc://x\n}\n' },
      { path: 'c/w.bru', text: 'ws {\n  url: wss://x\n}\n' },
      { path: 'c/n.bru', text: 'meta {\n  name: Nothing\n}\n' },
      { path: 'c/bad.bru', text: 'get {\n  url: https://x.example/\n}\n' },
    ]);
    expect(r.name).toBe('c');
    expect(r.endpoints.map((e) => e.key)).toEqual(['GET https://x.example/']);
    expect(r.problems).toEqual(['n.bru: no HTTP method block (skipped)', '2 gRPC or WebSocket requests skipped (HTTP only)']);
  });

  it('needs bruno.json and uses the shallowest one', () => {
    expect(parseBruno([{ path: 'x.bru', text: 'get {\n  url: https://x.example\n}\n' }]).problems).toEqual(['Bruno collection: no bruno.json']);
    const r = parseBruno([
      { path: 'a/b/bruno.json', text: '{"name":"Inner"}' },
      { path: 'a/bruno.json', text: '{"name":"Outer"}' },
      { path: 'a/b/r.bru', text: 'get {\n  url: https://x.example/r\n}\n' },
    ]);
    expect(r.name).toBe('Outer');
    expect(r.endpoints[0].folder).toEqual(['b']);
    expect(parseBruno([{ path: 'bruno.json', text: '{oops' }]).problems).toEqual(['bruno.json is not valid JSON (folder name used)']);
  });
});

describe('Bruno hostile input', () => {
  it('never throws on junk', () => {
    for (const input of [null, undefined, 7, 'x', {}, [null, 1, { path: 5, text: 'x' }], [{ path: 'bruno.json', text: 'null' }]]) {
      const r = parseBruno(input as never);
      expect(r.format).toBe('bruno');
      expectCleanProblems(r.problems);
    }
  });

  it('stops at an unterminated block with a problem and keeps what came before', () => {
    const bru = 'meta {\n  name: Half\n}\n\nget {\n  url: https://x.example/h\n}\n\nbody:json {\n  {"a": 1}\n';
    const r = parseBruno(one(bru));
    expect(r.endpoints[0]).toMatchObject({ name: 'Half', key: 'GET https://x.example/h' });
    expect(r.problems).toEqual(['r.bru: block "body:json" at line 9 is not closed (rest of the file ignored)']);
    const nested = 'get {\n  url: https://x.example/n\n}\n\nexample {\n  name: E\n  response: {\n    status: {\n      code: 201\n}\n';
    const n = parseBruno(one(nested));
    expect(n.endpoints[0].examples).toEqual([{ name: 'E', status: 200, headers: {}, body: '' }]);
    expect(n.problems).toEqual(['r.bru: "response" at line 7 is not closed']);
  });

  it('reads 10 000-line files in linear time', () => {
    const cases = [
      // 10 000 header lines
      ['get {', '  url: https://x.example/a', '}', 'headers {', ...Array.from({ length: 10000 }, (_, i) => `  h${i}: v`), '}'].join('\n'),
      // 10 000 unterminated example blocks
      ['get {', '  url: https://x.example/b', '}', ...Array.from({ length: 10000 }, () => 'example {')].join('\n'),
      // 5 000 examples, each with an unclosed nested block
      ['get {', '  url: https://x.example/c', '}', ...Array.from({ length: 5000 }, () => 'example {\n  response: {\n}').join('\n').split('\n')].join('\n'),
      // one example with 10 000 nested unclosed `key: {` lines
      ['get {', '  url: https://x.example/d', '}', 'example {', ...Array.from({ length: 10000 }, (_, i) => `${' '.repeat(2 + (i % 50))}k${i}: {`), '}'].join('\n'),
      // 10 000 unclosed multi-line values
      ['get {', '  url: https://x.example/e', '}', 'meta {', ...Array.from({ length: 10000 }, () => "  name: '''"), '}'].join('\n'),
      // 10 000 lines of junk
      Array.from({ length: 10000 }, (_, i) => `}{ ''' ~"\\" : [ ${i}`).join('\n'),
    ];
    for (const bru of cases) {
      const { value, ms } = timed(() => parseBruno(one(bru)));
      expect(ms).toBeLessThan(200);
      expectCleanProblems(value.problems);
    }
    const many = parseBruno(one(cases[2]));
    expect(many.endpoints[0].examples).toHaveLength(20);
    expect(many.problems.some((p) => /more than 20 examples/.test(p))).toBe(true);
  });

  it('enforces brunoLimits: files, depth and total size', () => {
    expect(brunoLimits).toEqual({ files: 2000, depth: 32, totalBytes: 20 * 1024 * 1024 });
    const files: BrunoFile[] = [{ path: 'bruno.json', text: '{}' }];
    for (let i = 0; i < 2100; i++) files.push({ path: `r${i}.bru`, text: `get {\n  url: https://x.example/r${i}\n}\n` });
    const { value, ms } = timed(() => parseBruno(files));
    expect(ms).toBeLessThan(200);
    expect(value.problems[0]).toBe('Bruno collection has more than 2000 files; the rest were not read');
    expect(value.endpoints).toHaveLength(1999);

    const deep = `${Array.from({ length: 40 }, (_, i) => `d${i}`).join('/')}/r.bru`;
    const d = parseBruno([{ path: 'bruno.json', text: '{}' }, { path: deep, text: 'get {\n  url: https://x.example\n}\n' }]);
    expect(d.endpoints).toEqual([]);
    expect(d.problems).toEqual(['Bruno folders deeper than 32 levels were not read']);

    const big = 'x'.repeat(11 * 1024 * 1024);
    const t = timed(() => parseBruno([{ path: 'bruno.json', text: '{}' }, { path: 'a.bru', text: big }, { path: 'b.bru', text: big }]));
    expect(t.value.problems).toContain('Bruno collection is larger than 20 MB; the rest was not read');
  });

  it('keeps __proto__ and constructor as data in headers, variables and folders', () => {
    const files: BrunoFile[] = [
      { path: 'bruno.json', text: '{"name":"P","__proto__":{"polluted":1}}' },
      { path: 'environments/__proto__.bru', text: 'vars {\n  __proto__: https://p.example\n  constructor: v1\n}\n' },
      { path: '__proto__/folder.bru', text: 'meta {\n  name: constructor\n}\n' },
      {
        path: '__proto__/r.bru',
        text: [
          'get {',
          '  url: {{__proto__}}/{{constructor}}',
          '}',
          '',
          'example {',
          '  name: __proto__',
          '  response: {',
          '    headers: {',
          '      __proto__: h1',
          '      constructor: h2',
          '    }',
          '  }',
          '}',
        ].join('\n'),
      },
    ];
    const r = parseBruno(files, { environment: '__proto__' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.environments).toEqual(['__proto__']);
    const ep = r.endpoints[0];
    expect(ep).toMatchObject({ folder: ['constructor'], origin: 'https://p.example', path: ['v1'] });
    expect(Object.getOwnPropertyDescriptor(ep.examples[0].headers, '__proto__')?.value).toBe('h1');
    expect(Object.getOwnPropertyDescriptor(ep.examples[0].headers, 'constructor')?.value).toBe('h2');
  });

  it('treats templates as text: dynamic values and expressions in a host are unresolved, in a path a parameter', () => {
    const bru = 'get {\n  url: {{ $randomHost }}/a/{{ $guid }}/{{process.env.SECRET}}/{{ a + b }}\n}\n';
    const r = parseBruno(one(bru));
    expect(r.endpoints[0].unresolved).toEqual(['$randomHost']);
    const p = parseBruno(one('get {\n  url: https://x.example/{{ $guid }}/{{process.env.SECRET}}/{{ a + b }}\n}\n'));
    expect(p.endpoints[0].path).toEqual([{ param: '$guid' }, { param: 'process.env.SECRET' }, { param: '$a' }]);
    expect(p.variables).toEqual([{ name: 'process.env.SECRET' }]);
  });

  it('caps huge strings and keeps problem lines clean', () => {
    const huge = 'n'.repeat(1_000_000);
    const evil = 'x‮Y\ttab';
    const bru = `meta {\n  name: ${evil}${huge}\n}\n\nget {\n  url: https://x.example/${huge}\n}\n\n${evil}${huge} {\n`;
    const { value, ms } = timed(() => parseBruno(one(bru, [{ path: `c/${evil}${huge}.bru`, text: '{' }])));
    expect(ms).toBeLessThan(200);
    expect(value.problems.length).toBeGreaterThanOrEqual(2);
    expectCleanProblems(value.problems);
  });
});
