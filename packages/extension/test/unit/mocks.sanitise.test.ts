// CONTRACTS §21.6: "Copy without credentials" sanitisation for Postman collections.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { sanitisePostman } from '../../src/mocks/sanitise';
import { parseYaml } from '../../src/mocks/yaml';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

describe('sanitisePostman', () => {
  it('matches expected sanitise rules on shop.postman_collection.json without mutating input', () => {
    const collection = readJson('shop.postman_collection.json');
    const before = JSON.stringify(collection);
    const expected = readJson('shop.expected.json') as {
      sanitise: { mustNotContain: string[]; mustContain: string[] };
    };

    const { doc, removed } = sanitisePostman(collection);
    const json = JSON.stringify(doc);

    for (const s of expected.sanitise.mustNotContain) {
      expect(json).not.toContain(s);
    }
    for (const s of expected.sanitise.mustContain) {
      expect(json).toContain(s);
    }

    // Names only, never secret values.
    for (const name of ['auth', 'event', 'token', 'clientSecret', 'X-Api-Key', 'Authorization', 'password']) {
      expect(removed).toContain(name);
    }
    for (const secret of expected.sanitise.mustNotContain) {
      expect(removed.join('\n')).not.toContain(secret);
    }

    // Input must not be mutated.
    expect(JSON.stringify(collection)).toBe(before);
  });

  it('produces a valid Postman collection that parsePostman still parses with the same endpoints (except cleared cookies)', async () => {
    const { parsePostman } = await import('../../src/mocks/postman');
    const collection = readJson('shop.postman_collection.json');
    const { doc } = sanitisePostman(collection);
    const empty = { values: new Map<string, string>(), sources: new Map() };
    const origParsed = parsePostman(collection, empty);
    const sanParsed = parsePostman(doc, empty);
    expect(sanParsed.endpoints.map((e) => e.key)).toEqual(origParsed.endpoints.map((e) => e.key));
    const remote = sanParsed.endpoints.find((e) => e.name === 'Remote config');
    expect(remote?.examples[0].headers['set-cookie']).toBe('');
    expect(remote?.examples[0].body).toBe('{"theme":"dark"}');
  });

  it('strips nested auth/events, folder variables, url.variable/url.query secrets, originalRequest secrets, and v2.0 header strings', () => {
    const doc = {
      info: { name: 'Nested' },
      variable: [
        { key: 'api_key', value: 'my-secret-key' },
        { key: 'pwd', value: 'my-pwd' },
        { key: 'custom', value: 'secret-val', type: 'secret' },
        { key: 'alreadyEmpty', value: '', type: 'secret' },
        { key: 'baseUrl', value: 'https://api.example.com' },
      ],
      item: [
        {
          name: 'Folder',
          auth: { type: 'apikey' },
          event: [{ listen: 'test', script: { exec: ['console.log(1)'] } }],
          variable: [{ key: 'folderToken', value: 'folder-secret-tok' }],
          item: [
            {
              name: 'Endpoint',
              event: [{ listen: 'prerequest', script: { exec: ['secretCall()'] } }],
              request: {
                method: 'GET',
                header: 'Authorization: Bearer raw-v2-secret\nAccept: application/json',
                url: {
                  raw: '{{baseUrl}}/users/:privateToken?api_key=query-secret&page=2',
                  variable: [{ key: 'privateToken', value: 'path-secret-999' }],
                  query: [
                    { key: 'api_key', value: 'query-secret' },
                    { key: 'page', value: '2' },
                  ],
                },
              },
              response: [
                {
                  name: 'Saved',
                  code: 200,
                  originalRequest: {
                    auth: { type: 'basic' },
                    header: [{ key: 'Cookie', value: 'sid=abc' }],
                    url: {
                      raw: '{{baseUrl}}/users?session=orig-sess&page=2',
                      query: [
                        { key: 'session', value: 'orig-sess' },
                        { key: 'page', value: '2' },
                      ],
                    },
                  },
                  header: [{ key: 'Set-Cookie', value: 'example-cookie=keep' }],
                  body: '{"ok":true}',
                },
              ],
            },
          ],
        },
      ],
    };

    const { doc: out, removed } = sanitisePostman(doc);
    const s = JSON.stringify(out);
    for (const secret of [
      'my-secret-key',
      'my-pwd',
      'secret-val',
      'folder-secret-tok',
      'console.log(1)',
      'secretCall()',
      'raw-v2-secret',
      'path-secret-999',
      'query-secret',
      'sid=abc',
      'orig-sess',
    ]) {
      expect(s).not.toContain(secret);
    }
    expect(s).toContain('https://api.example.com');
    expect(s).toContain('Accept: application/json');
    expect(s).not.toContain('example-cookie=keep');
    expect(s).toContain('page=2');
    expect(removed).not.toContain('alreadyEmpty');
    expect(removed).toContain('api_key');
    expect(removed).toContain('folderToken');
    expect(removed).toContain('Cookie');
    expect(removed).toContain('Set-Cookie');
    expect(removed).toContain('Authorization');
    expect(removed).toContain('privateToken');
    expect(removed).toContain('session');
  });

  it('sanitises nested JSON raw request bodies while preserving non-credential fields', () => {
    const doc = {
      info: { name: 'NestedJson' },
      item: [
        {
          name: 'Register',
          request: {
            method: 'POST',
            url: 'https://api.example.com/register',
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                user: { email: 'sara@example.com', password: 'nested-secret-password' },
                items: [{ name: 'ok', apiKey: 'deep-key-42' }],
              }),
            },
          },
        },
      ],
    };

    const before = JSON.stringify(doc);
    const { doc: out, removed } = sanitisePostman(doc);
    const s = JSON.stringify(out);

    expect(s).not.toContain('nested-secret-password');
    expect(s).not.toContain('deep-key-42');
    expect(s).toContain('sara@example.com');
    expect(removed).toContain('password');
    expect(removed).toContain('apiKey');
    expect(removed.join('\n')).not.toContain('nested-secret-password');
    expect(JSON.stringify(doc)).toBe(before);

    const parsedBody = JSON.parse(
      ((out as { item: { request: { body: { raw: string } } }[] }).item[0].request.body.raw),
    );
    expect(parsedBody).toEqual({
      user: { email: 'sara@example.com', password: '' },
      items: [{ name: 'ok', apiKey: '' }],
    });
  });

  it('sanitises urlencoded and formdata bodies and strips src from file formdata entries', () => {
    const doc = {
      info: { name: 'Forms' },
      item: [
        {
          name: 'OAuth token',
          request: {
            method: 'POST',
            url: 'https://api.example.com/oauth/token',
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'grant_type', value: 'password' },
                { key: 'username', value: 'sara@example.com' },
                { key: 'password', value: 'form-pass-1' },
                { key: 'client_secret', value: 'form-sec-2' },
              ],
            },
          },
        },
        {
          name: 'Upload avatar',
          request: {
            method: 'POST',
            url: 'https://api.example.com/avatar',
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'caption', value: 'hello', type: 'text' },
                { key: 'auth_token', value: 'fd-tok-3', type: 'text' },
                { key: 'avatar', type: 'file', src: '/Users/sara/private/avatar.png' },
              ],
            },
          },
        },
      ],
    };

    const { doc: out, removed } = sanitisePostman(doc);
    const s = JSON.stringify(out);

    expect(s).not.toContain('form-pass-1');
    expect(s).not.toContain('form-sec-2');
    expect(s).not.toContain('fd-tok-3');
    expect(s).not.toContain('/Users/sara/private/avatar.png');
    expect(s).toContain('sara@example.com');
    expect(s).toContain('hello');

    const formEntries = (out as { item: { request: { body: { formdata: Record<string, unknown>[] } } }[] }).item[1]
      .request.body.formdata;
    expect(Object.prototype.hasOwnProperty.call(formEntries[2], 'src')).toBe(false);

    expect(removed).toContain('password');
    expect(removed).toContain('client_secret');
    expect(removed).toContain('auth_token');
    expect(removed).toContain('avatar');
    expect(removed.join('\n')).not.toContain('/Users/sara/private/avatar.png');
  });

  it('keeps non-JSON raw request bodies as is and names them in removed', () => {
    const doc = {
      info: { name: 'NonJson' },
      item: [
        {
          name: 'Send XML',
          request: {
            method: 'POST',
            url: 'https://api.example.com/xml',
            body: {
              mode: 'raw',
              raw: '<login><user>sara</user></login>',
            },
          },
        },
        {
          name: 'Empty raw',
          request: {
            method: 'POST',
            url: 'https://api.example.com/empty',
            body: { mode: 'raw', raw: '   ' },
          },
        },
      ],
    };

    const { doc: out, removed } = sanitisePostman(doc);
    const s = JSON.stringify(out);
    expect(s).toContain('<login><user>sara</user></login>');
    expect(removed).toContain('request body of Send XML not checked (not JSON)');
    expect(removed.join('\n')).not.toContain('Empty raw');
  });

  it('sanitises graphql.variables like raw JSON', () => {
    const doc = {
      info: { name: 'GQL' },
      item: [
        {
          name: 'Login mutation',
          request: {
            method: 'POST',
            url: 'https://api.example.com/graphql',
            body: {
              mode: 'graphql',
              graphql: {
                query: 'mutation Login($input: LoginInput!) { login(input: $input) { ok } }',
                variables: JSON.stringify({
                  input: { email: 'sara@example.com', password: 'gql-secret-password' },
                }),
              },
            },
          },
        },
      ],
    };

    const { doc: out, removed } = sanitisePostman(doc);
    const s = JSON.stringify(out);
    expect(s).not.toContain('gql-secret-password');
    expect(s).toContain('sara@example.com');
    expect(removed).toContain('password');
  });

  it('sanitises originalRequest bodies inside saved examples while keeping response bodies', () => {
    const doc = {
      info: { name: 'OrigReqBody' },
      item: [
        {
          name: 'Sign in',
          request: {
            method: 'POST',
            url: 'https://api.example.com/signin',
          },
          response: [
            {
              name: 'OK',
              code: 200,
              originalRequest: {
                method: 'POST',
                url: 'https://api.example.com/signin',
                body: {
                  mode: 'raw',
                  raw: '{"email":"sara@example.com","password":"orig-req-password"}',
                },
              },
              body: '{"token":"example-response-token"}',
            },
            {
              name: 'XML example',
              code: 200,
              originalRequest: {
                method: 'POST',
                url: 'https://api.example.com/signin',
                body: {
                  mode: 'raw',
                  raw: '<raw>not-json</raw>',
                },
              },
              body: '{"ok":true}',
            },
          ],
        },
      ],
    };

    const { doc: out, removed } = sanitisePostman(doc);
    const s = JSON.stringify(out);
    expect(s).not.toContain('orig-req-password');
    expect(s).toContain('sara@example.com');
    expect(s).toContain('example-response-token');
    expect(s).toContain('<raw>not-json</raw>');
    expect(removed).toContain('password');
    expect(removed).toContain('request body of Sign in not checked (not JSON)');
  });

  it('never throws on bad/cyclic/deep inputs and keeps prototype keys as data', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(() => sanitisePostman(bad)).not.toThrow();
    }

    const cyclic: Record<string, unknown> = { info: { name: 'C' }, item: [] };
    (cyclic.item as unknown[]).push(cyclic);
    expect(() => sanitisePostman(cyclic)).not.toThrow();

    // Deeply nested JSON body (> 64 levels) must not leak the buried secret or throw.
    let deepJson: Record<string, unknown> = { password: 'deep-buried-secret' };
    for (let i = 0; i < 80; i++) deepJson = { n: deepJson };
    const deepRes = sanitisePostman({
      info: { name: 'DeepBody' },
      item: [{ name: 'Deep', request: { method: 'POST', url: 'https://a.test', body: { mode: 'raw', raw: JSON.stringify(deepJson) } } }],
    });
    expect(JSON.stringify(deepRes.doc)).not.toContain('deep-buried-secret');

    const protoDoc = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"x","variable":[{"key":"__proto__","value":"s","type":"secret"}],"item":[{"name":"P","request":{"method":"POST","url":"https://a.test","body":{"mode":"raw","raw":"{\\"__proto__\\":{\\"password\\":\\"proto-body-secret\\"}}"}}}]}',
    );
    const res = sanitisePostman(protoDoc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(res.doc)).toContain('"__proto__"');
    expect(JSON.stringify(res.doc)).not.toContain('proto-body-secret');
    expect(res.removed).toContain('__proto__');
    expect(res.removed).toContain('password');
  });

  it('strips URL userinfo, key/sig/code/client_secret queries, -key/-token/APIM headers, certificates/proxy, form raw body, and example cookies (REVIEW-15 #6)', () => {
    const doc = {
      info: { name: 'S', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [
        { key: 'baseUrl', value: 'https://deploy:GhP4ssw0rdX@api.x.example' },
        { key: 'clientKey', value: 'CK-LIVE-111' },
        { key: 'pin', value: '4321' },
      ],
      certificates: [{ passphrase: 'ROOTPASS888', key: { src: '/Users/dev/root.key' } }],
      item: [
        {
          name: 'r',
          request: {
            method: 'GET',
            url: {
              raw: 'https://u:RawPass@api.x.example/a?key=AIzaKEY222&sig=SIG333&code=OAUTHCODE444&client_secret=CS555',
              host: ['huser:HostPass@api', 'x', 'example'],
              auth: { user: 'authU', password: 'UrlObjAuthPass' },
              query: [
                { key: 'key', value: 'AIzaKEY222' },
                { key: 'sig', value: 'SIG333' },
                { key: 'code', value: 'OAUTHCODE444' },
                { key: 'client_secret', value: 'CS555' },
              ],
            },
            header: [
              { key: 'Ocp-Apim-Subscription-Key', value: 'APIM555' },
              { key: 'X-Functions-Key', value: 'FUNC666' },
              { key: 'X-Amz-Security-Token', value: 'AMZ777' },
              { key: 'X-Signature', value: 'XSIG888' },
              { key: 'X-Custom-Key', value: 'CUSTKEY999' },
              { key: 'X-Custom-Token', value: 'CUSTTOK000' },
            ],
            certificate: {
              name: 'c',
              matches: ['https://api.x.example/*'],
              key: { src: '/Users/dev/certs/client.key' },
              cert: { src: '/Users/dev/certs/client.pem' },
              passphrase: 'CERTPASS999',
            },
            proxy: { host: 'proxy.corp', port: 8080, match: 'http+https://*/*', disabled: false },
            body: { mode: 'raw', raw: 'grant_type=password&username=dev&password=PLAINPW000' },
          },
          response: [
            {
              name: 'ok',
              code: 200,
              header: [
                { key: 'Set-Cookie', value: 'sid=REALSESSION111; HttpOnly' },
                { key: 'Cookie', value: 'c=REALCOOKIE222' },
              ],
              cookie: [{ name: 'sid', value: 'REALSESSION111' }],
              body: '{"access_token":"RESPTOKEN222"}',
            },
          ],
        },
      ],
    };

    const { doc: out, removed } = sanitisePostman(doc);
    const json = JSON.stringify(out);
    for (const secret of [
      'GhP4ssw0rdX',
      'CK-LIVE-111',
      '4321',
      'ROOTPASS888',
      '/Users/dev/root.key',
      'RawPass',
      'HostPass',
      'UrlObjAuthPass',
      'AIzaKEY222',
      'SIG333',
      'OAUTHCODE444',
      'CS555',
      'APIM555',
      'FUNC666',
      'AMZ777',
      'XSIG888',
      'CUSTKEY999',
      'CUSTTOK000',
      'CERTPASS999',
      '/Users/dev/certs',
      'proxy.corp',
      'PLAINPW000',
      'REALSESSION111',
      'REALCOOKIE222',
    ]) {
      expect(json, secret).not.toContain(secret);
      expect(removed.join('\n'), secret).not.toContain(secret);
    }
    expect(json).toContain('RESPTOKEN222');
    for (const name of [
      'baseUrl (URL credentials)',
      'clientKey',
      'pin',
      'certificates',
      'url auth',
      'key',
      'sig',
      'code',
      'client_secret',
      'Ocp-Apim-Subscription-Key',
      'X-Functions-Key',
      'X-Custom-Key',
      'X-Custom-Token',
      'certificate',
      'proxy',
      'password',
      'Set-Cookie',
      'Cookie',
      'cookie (sid)',
    ]) {
      expect(removed).toContain(name);
    }
  });

  it('stops on a YAML alias DAG at COLLECTION_LIMITS.walkNodes in < 1 s without copying unsanitised tail (REVIEW-15 #2a)', () => {
    const lines = [
      'info: {name: DAG, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"}',
      'x:',
      '  - &l0 {name: f0, item: []}',
    ];
    for (let i = 1; i <= 7; i++) {
      lines.push(`  - &l${i} {name: f${i}, item: [${Array(10).fill(`*l${i - 1}`).join(', ')}]}`);
    }
    lines.push('item: [*l7]');
    lines.push('afterBudget: { secretTail: "SHOULD-NOT-BE-COPIED-PAST-BUDGET" }');
    const yaml = parseYaml(`${lines.join('\n')}\n`, 'dag7.postman_collection.yaml');
    expect(yaml.problem).toBeUndefined();

    const t0 = performance.now();
    const res = sanitisePostman(yaml.value);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(1000);
    expect(res.removed).toContain('the rest of the collection was not copied (too large)');
    expect(JSON.stringify(res.doc)).not.toContain('SHOULD-NOT-BE-COPIED-PAST-BUDGET');
  });

  it('strips bidi/control chars and URL credentials from removed entries (REVIEW-15 #7)', () => {
    const res = sanitisePostman({
      info: { name: 'R' },
      item: [
        {
          name: 'https://ci:ghp_SecretRemoved99@raw.example/r\nLine2\t\u202E',
          request: { method: 'POST', url: 'https://a.test', body: { mode: 'raw', raw: '<not-json/>' } },
        },
      ],
    });
    expect(res.removed.length).toBeGreaterThan(0);
    for (const r of res.removed) {
      expect(r).not.toMatch(/[\r\n\t\u202A-\u202E\u2066-\u2069]/);
      expect(r).not.toContain('ghp_SecretRemoved99');
    }
  });
});
