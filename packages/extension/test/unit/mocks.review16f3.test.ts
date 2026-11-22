// REVIEW-16 fix round F3: the Insomnia template freeze (#2), environment values in resource names, paths, notes and
// snapshots (#8) and in Insomnia / Bruno paths (#9), empty snapshot scopes (#10), huge client ids (#13), store answer
// headers and header values HTTP can't send (#14), and the INFO items (`__proto__` resources, number text, the Bruno
// walk's check-then-read gap); plus the narrower secret check for `session` / `sessions` / `pass` and the agent text
// for `replacePersonalData`. Each case uses the reviewer's inputs.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { RequestHandler, Rule } from '@flutter-intercept/proxy';
import { compileRules, findRule } from '@flutter-intercept/proxy/rules';
import { confirmationText } from '../../src/agent/lmTools';
import { languageModelToolsContribution, toolSchemas } from '../../src/agent/schema';
import { parseBruno } from '../../src/mocks/bruno';
import { MockCollectionsCore } from '../../src/mocks/core';
import { parseInsomnia } from '../../src/mocks/insomnia';
import { collectionParsers } from '../../src/mocks/parsers';
import { detectResources, maskPathSegments, parseJsonText, stringifyJson } from '../../src/mocks/resources';
import { isSecretField, isSecretName, withoutSecretFields } from '../../src/mocks/secrets';
import { parseSnapshot, snapshotText, validateSnapshot } from '../../src/mocks/snapshot';
import { ResourceStore, type StoreRequest } from '../../src/mocks/store';
import { COLLECTION_LIMITS, STORE_LIMITS, type MockEndpoint, type MockExample, type PathSegment } from '../../src/mocks/types';
import { normaliseTemplate } from '../../src/mocks/viaPostman';
import type { RulesFs } from '../../src/rules/bodyFile';
import { SharedRulesCore } from '../../src/rules/core';
import { checkHeaders, validateRule } from '../../src/ui/validate';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, ROOT } from './rules.fakes';

vi.mock('vscode', () => ({}));

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
};

// ------------------------------------------------------------------------------------------------ store helpers

const ORIGIN = 'https://api.test';
function ex(body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }): MockExample {
  return { name: String(status), status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) };
}
function ep(method: string, p: string, examples: MockExample[] = []): MockEndpoint {
  const segs: PathSegment[] = p.split('/').filter(Boolean).map((s) => (s.startsWith(':') ? { param: s.slice(1) } : s));
  return { key: `${method} ${p}`, method, name: `${method} ${p}`, folder: [], origin: ORIGIN, path: segs, examples, unresolved: [] };
}
function crud(base: string, seed: unknown, opts: { item?: unknown; headers?: Record<string, string> } = {}): MockEndpoint[] {
  const h = opts.headers;
  return [
    ep('GET', base, [ex(seed, 200, h)]),
    ep('POST', base, [ex('{}', 201, h)]),
    ep('GET', `${base}/:id`, [ex(opts.item ?? (Array.isArray(seed) && seed[0]) ?? {}, 200, h)]),
    ep('PUT', `${base}/:id`, [ex('{}', 200, h)]),
    ep('DELETE', `${base}/:id`, [ex('', 204, h)]),
  ];
}
function storeOf(endpoints: MockEndpoint[]) {
  const { resources } = detectResources(endpoints, {});
  return { store: new ResourceStore(resources, endpoints), resources };
}
function call(s: ResourceStore, resource: string, op: StoreRequest['op'], o: Partial<StoreRequest> & { json?: unknown } = {}) {
  const { json, ...rest } = o;
  return s.handle({
    resource,
    op,
    params: {},
    query: [],
    ...(json !== undefined ? { body: { text: typeof json === 'string' ? json : JSON.stringify(json) }, contentType: 'application/json' } : {}),
    ...rest,
  });
}

// ------------------------------------------------------------------------------------------------ host helpers

const BOT = '123456789:AAHk9plantedBotTokenValueXYZ';
const BOT2 = 'bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const TENANT = 'sk_live_51HxQz';

interface Host {
  core: MockCollectionsCore;
  handlers: Map<string, RequestHandler>;
  files: FakeFs;
}

async function host(sharedJson: unknown, put: Record<string, string>): Promise<Host> {
  const files = new FakeFs();
  files.put(`${ROOT}/pubspec.yaml`, 'name: app');
  for (const [p, t] of Object.entries(put)) files.put(`${ROOT}/${p}`, t);
  files.put(FILE, JSON.stringify(sharedJson, null, 2));
  const memento = new FakeMemento();
  const shared = new SharedRulesCore({ folders: () => [{ name: 'app', path: ROOT }], fs: files, validateRule: fakeValidateRule, memento });
  await shared.reload();
  const handlers = new Map<string, RequestHandler>();
  const core = new MockCollectionsCore({
    links: () => shared.collectionLinks(),
    saveLinks: (f, l) => shared.saveCollections(f, l),
    primaryFolderPath: () => shared.primaryFolderPath(),
    writeWorkspaceFile: (f, r, t) => shared.writeWorkspaceFile(f, r, t),
    workspaceRoots: () => [ROOT],
    fs: files,
    memento,
    parsers: collectionParsers,
    newRuleId: () => 'rule_new',
    setHandler: (id, fn) => void (fn ? handlers.set(id, fn) : handlers.delete(id)),
    saveStore: (f, c, e) => shared.saveStore(f, c, e),
    now: () => Date.UTC(2026, 10, 20, 12),
  });
  await core.reload();
  return { core, handlers, files };
}

let seq = 0;
function send(h: Host, method: string, url: string, text?: string): { status: number; body: string; note?: string; headers?: Record<string, unknown> } {
  const rule = findRule(compileRules(h.core.rules()), method, url) as Rule | undefined;
  if (!rule) throw new Error(`no rule for ${method} ${url}`);
  const a = rule.action;
  if (a.kind === 'mock') return { status: a.status, body: a.body };
  if (a.kind !== 'handler') throw new Error(a.kind);
  const fn = h.handlers.get(a.handlerId)!;
  const r = fn(
    { exchangeId: `e${++seq}`, ruleId: rule.id, method, url, headers: { 'content-type': 'application/json' }, ...(text !== undefined ? { body: { text, encoding: 'utf8' as const } } : {}) },
    new AbortController().signal,
  ) as { status?: number; body?: string; note?: string; headers?: Record<string, unknown>; fallback?: true } | undefined;
  if (!r || r.fallback) return { status: a.fallback!.status, body: a.fallback!.body };
  return { status: r.status!, body: r.body ?? '', ...(r.note ? { note: r.note } : {}), ...(r.headers ? { headers: r.headers } : {}) };
}

// ------------------------------------------------------------------------------------------------ #2

describe('#2: a small Insomnia file no longer freezes the host', () => {
  it('normaliseTemplate is linear: 5 MB of {{a}} and of {%a%} (Insomnia), and of {{a}} (Bruno) in < 1 s each (the quadratic version took 45 s at 400 KB; a loose bound keeps it stable on a loaded machine)', () => {
    for (const [text, insomnia] of [['{{a}}'.repeat(1_000_000), true], ['{%a%}'.repeat(1_000_000), true], ['{{a}}'.repeat(1_000_000), false]] as const) {
      const { value, ms } = timed(() => normaliseTemplate(text, insomnia));
      expect(ms, `${text.slice(0, 5)} insomnia=${insomnia}`).toBeLessThan(1000);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('normaliseTemplate still writes the same templates', () => {
    const cases: [string, boolean, string][] = [
      ['{{ _.baseUrl }}/a/{% uuid %}/{{ b }}', true, '{{baseUrl}}/a/{{$uuid}}/{{b}}'],
      ['{{a}}{%x%}{{b}}{%y', true, '{{a}}{{$x}}{{b}}{%y'],
      ['x {% now %} {{ a | upper }} {{', true, 'x {{$now}} {{$a}} {{'],
      ['{%a%}{{b}}', false, '{%a%}{{b}}'],
    ];
    for (const [input, ins, want] of cases) expect(normaliseTemplate(input, ins), input).toBe(want);
  });

  it('the reviewer’s 200 KB / 400 KB exports (a base-environment value of {{a}} × n) load in < 200 ms', () => {
    for (const n of [20_000, 40_000, 80_000]) {
      const doc = {
        _type: 'export',
        __export_format: 4,
        resources: [
          { _id: 'wrk_1', _type: 'workspace', name: 'W' },
          { _id: 'env_base', _type: 'environment', parentId: 'wrk_1', data: { big: '{{a}}'.repeat(n) } },
          { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'r', method: 'GET', url: 'https://x.test/a' },
        ],
      };
      const { value, ms } = timed(() => parseInsomnia(JSON.stringify(doc), 'x.json'));
      expect(ms, `${n}`).toBeLessThan(200);
      expect(value.endpoints).toHaveLength(1);
    }
  });

  it('environment values longer than a URL are not read (Insomnia data / kv, Bruno environment and collection vars)', () => {
    const long = 'x'.repeat(COLLECTION_LIMITS.urlChars + 1);
    const ins = parseInsomnia(
      JSON.stringify({
        _type: 'export',
        __export_format: 4,
        resources: [
          { _id: 'w', _type: 'workspace', name: 'W' },
          { _id: 'e', _type: 'environment', parentId: 'w', data: { host: `https://${long}` } },
          { _id: 'r', _type: 'request', parentId: 'w', name: 'r', method: 'GET', url: '{{ _.host }}/a' },
        ],
      }),
      'x.json',
    );
    expect(ins.endpoints[0].unresolved).toEqual(['host']);
    const bru = parseBruno(
      [
        { path: 'c/bruno.json', text: '{}' },
        { path: 'c/collection.bru', text: `vars:pre-request {\n  a: https://${long}\n}\n` },
        { path: 'c/environments/e.bru', text: `vars {\n  b: https://${long}\n}\n` },
        { path: 'c/r.bru', text: 'get {\n  url: {{a}}/x\n}\n' },
        { path: 'c/s.bru', text: 'get {\n  url: {{b}}/y\n}\n' },
      ],
      { environment: 'e' },
    );
    expect(bru.endpoints.map((e) => e.unresolved)).toEqual([['a'], ['b']]);
    // the reviewer's Bruno variant (D/brunoenv.probe.ts): 5 MB of {{a}} as an environment value
    const t = timed(() =>
      parseBruno([{ path: 'c/bruno.json', text: '{}' }, { path: 'c/environments/e.bru', text: `vars {\n  a: 1\n  big: ${'{{a}}'.repeat(1_000_000)}\n}\n` }, { path: 'c/r.bru', text: 'get {\n  url: https://a.test/{{big}}\n}\n' }], { environment: 'e' }),
    );
    expect(t.ms).toBeLessThan(200);
  });

  it('through the real core reload: a 200 KB committed export (D/insdoscore.probe.ts) in < 200 ms', async () => {
    const doc = {
      _type: 'export',
      __export_format: 4,
      resources: [
        { _id: 'wrk_1', _type: 'workspace', name: 'W' },
        { _id: 'env_base', _type: 'environment', parentId: 'wrk_1', data: { big: '{{a}}'.repeat(40_000) } },
        { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'r', method: 'GET', url: 'https://x.test/a' },
      ],
    };
    const t = performance.now();
    const h = await host({ version: 1, rules: [], collections: [{ id: 'ins', file: 'api/ins.json' }] }, { 'api/ins.json': JSON.stringify(doc) });
    expect(performance.now() - t).toBeLessThan(200);
    expect(h.core.endpoints('ins')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ #9 and #8

function brunoBot(): Record<string, string> {
  return {
    'api/bot/bruno.json': JSON.stringify({ version: '1', name: 'Bot', type: 'collection' }),
    'api/bot/environments/prod.bru': `vars {\n  baseUrl: https://api.telegram.org\n  botToken: ${BOT}\n}\n`,
    'api/bot/getMe.bru': 'meta {\n  name: Get me\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{baseUrl}}/bot{{botToken}}/getMe\n  body: none\n  auth: none\n}\n',
    'api/bot/list.bru': 'meta {\n  name: Updates\n  seq: 2\n}\nget {\n  url: {{baseUrl}}/bot{{botToken}}/updates\n}\n',
    'api/bot/one.bru': 'meta {\n  name: Update\n  seq: 3\n}\nget {\n  url: {{baseUrl}}/bot{{botToken}}/updates/:id\n}\n',
  };
}

function insomniaBot(): string {
  return JSON.stringify({
    _type: 'export',
    __export_format: 4,
    resources: [
      { _id: 'wrk_1', _type: 'workspace', name: 'Bot' },
      { _id: 'env_base', _type: 'environment', parentId: 'wrk_1', data: { baseUrl: 'https://api.telegram.org' } },
      { _id: 'env_prod', _type: 'environment', parentId: 'env_base', name: 'prod', data: { botToken: BOT } },
      { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'Get me', method: 'GET', url: '{{ _.baseUrl }}/bot{{ _.botToken }}/getMe' },
      { _id: 'req_2', _type: 'request', parentId: 'wrk_1', name: 'Updates', method: 'GET', url: '{{ _.baseUrl }}/bot{{ _.botToken }}/updates' },
      { _id: 'req_3', _type: 'request', parentId: 'wrk_1', name: 'Update', method: 'GET', url: '{{ _.baseUrl }}/bot{{ _.botToken }}/updates/:id' },
    ],
  });
}

describe('#9: Insomnia and Bruno environment values are masked like Postman’s', () => {
  for (const [label, link, files] of [
    ['Bruno environments/prod.bru', { id: 'bot', file: 'api/bot/bruno.json', environment: 'prod' }, brunoBot()],
    ['Insomnia sub-environment', { id: 'bot', file: 'api/bot.insomnia.json', environment: 'prod' }, { 'api/bot.insomnia.json': insomniaBot() }],
  ] as const) {
    it(`${label}: endpoints() shows {{botToken}}, never the value; the request still matches`, async () => {
      const h = await host({ version: 1, rules: [], collections: [link], stores: [{ collection: 'bot', enabled: true }] }, files);
      const eps = h.core.endpoints('bot');
      expect(eps.map((e) => e.url)).toContain('https://api.telegram.org/bot{{botToken}}/getMe');
      expect(JSON.stringify(eps)).not.toContain(BOT);
      expect(JSON.stringify(h.core.state())).not.toContain(BOT);
      // #8 too: the resource found under the token shows no value
      expect(JSON.stringify(h.core.storeStatus('bot'))).not.toContain(BOT);
      // the rule still matches the real URL (the value is only hidden from what is shown)
      expect(findRule(compileRules(h.core.rules()), 'GET', `https://api.telegram.org/bot${BOT}/getMe`)).toBeDefined();
    });
  }

  it('the parsers return the chosen environment’s values for the host only (not the base / collection ones)', () => {
    const ins = parseInsomnia(insomniaBot(), 'x.json', { environment: 'prod' });
    expect([...(ins.envValues ?? [])]).toEqual([['botToken', BOT]]);
    const files = Object.entries(brunoBot()).map(([p, text]) => ({ path: p, text }));
    expect([...(parseBruno(files, { environment: 'prod' }).envValues ?? [])].sort()).toEqual([['baseUrl', 'https://api.telegram.org'], ['botToken', BOT]]);
    expect([...(parseBruno(files).envValues ?? [])]).toEqual([]);
  });
});

function todoPostman(): Record<string, string> {
  const J = { key: 'Content-Type', value: 'application/json' };
  const u = (p: string[]) => ({ raw: `{{baseUrl}}/${p.join('/')}`, host: ['{{baseUrl}}'], path: p });
  return {
    'api/todo.postman_collection.json': JSON.stringify({
      info: { name: 'T', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'baseUrl', value: 'https://api.todo.test' }],
      item: [
        { name: 'list', request: { method: 'GET', url: u(['{{tenantKey}}', 'todos']) }, response: [{ name: 'OK', code: 200, header: [J], body: '[{"id":1,"title":"a"}]' }] },
        { name: 'create', request: { method: 'POST', url: u(['{{tenantKey}}', 'todos']) }, response: [{ name: 'OK', code: 201, header: [J], body: '{"id":2}' }] },
        { name: 'get', request: { method: 'GET', url: u(['{{tenantKey}}', 'todos', ':id']) }, response: [{ name: 'OK', code: 200, header: [J], body: '{"id":1,"title":"a"}' }] },
        { name: 'bot list', request: { method: 'GET', url: u(['{{botToken}}']) }, response: [{ name: 'OK', code: 200, header: [J], body: '[{"id":1}]' }] },
        { name: 'bot get', request: { method: 'GET', url: u(['{{botToken}}', ':id']) }, response: [{ name: 'OK', code: 200, header: [J], body: '{"id":1}' }] },
        { name: 'tags', request: { method: 'GET', url: u(['tags']) }, response: [{ name: 'OK', code: 200, header: [J], body: '[{"id":"a"}]' }] },
        { name: 'tag', request: { method: 'GET', url: u(['tags', ':id']) }, response: [{ name: 'OK', code: 200, header: [J], body: '{"id":"a"}' }] },
        { name: 'new tag', request: { method: 'POST', url: u(['tags']) }, response: [{ name: 'OK', code: 201, header: [J], body: '{}' }] },
      ],
    }),
    'api/prod.postman_environment.json': JSON.stringify({
      name: 'prod',
      values: [
        { key: 'tenantKey', value: TENANT, enabled: true },
        { key: 'botToken', value: BOT2, enabled: true },
      ],
    }),
  };
}

describe('#8: environment values never reach resource names, paths, notes or snapshot files', () => {
  it('the reviewer’s collection (B/envpath.ts): names, paths, notes, the saved snapshot and stores[].resources keys', async () => {
    const shared = {
      version: 1,
      rules: [],
      collections: [{ id: 'todo', file: 'api/todo.postman_collection.json', environment: 'api/prod.postman_environment.json' }],
      stores: [{ collection: 'todo', enabled: true }],
    };
    const h = await host(shared, todoPostman());
    const st = h.core.storeStatus('todo')!;
    expect(st.resources.map((r) => [r.name, r.path])).toEqual([
      ['todos', '/{{tenantKey}}/todos/:id'],
      ['{{botToken}}', '/{{botToken}}/:id'],
      ['tags', '/tags/:id'],
    ]);
    const got = send(h, 'GET', `https://api.todo.test/${BOT2}/1`);
    expect(got.status).toBe(200);
    expect(got.note).toBe('{{botToken}}: read 1');
    send(h, 'POST', `https://api.todo.test/${TENANT}/todos`, '{"title":"b"}');
    const saved = await h.core.storeSnapshot('todo', 'save', 'demo');
    const text = h.files.text(`${ROOT}/${saved.path}`)!;
    expect(text).toContain('"{{botToken}}"');
    for (const v of [BOT2, TENANT]) {
      expect(text).not.toContain(v);
      expect(JSON.stringify(h.core.storeStatus('todo'))).not.toContain(v);
      expect(JSON.stringify(h.core.endpoints('todo'))).not.toContain(v);
      expect(JSON.stringify(h.core.storeItems('todo', '{{botToken}}'))).not.toContain(v);
    }
  });

  it('string ids of a resource whose last literal is an environment value never carry it (`item-1`)', () => {
    const eps = [ep('GET', `/${BOT2}`, [ex([{ id: 'a' }])]), ep('POST', `/${BOT2}`, [ex('{}', 201)]), ep('GET', `/${BOT2}/:id`, [ex({ id: 'a' })])];
    const envValues = new Map([['botToken', BOT2]]);
    const { resources } = detectResources(eps, {}, { envValues });
    const store = new ResourceStore(resources, eps, { envValues });
    const a = call(store, '{{botToken}}', 'create', { json: {} });
    expect(JSON.parse(a.body).id).toBe('item-1');
    expect(a.note).toBe('{{botToken}}: created item-1');
    const plain = new ResourceStore(detectResources(eps, {}).resources, eps);
    expect(JSON.parse(call(plain, BOT2, 'create', { json: {} }).body).id).toMatch(/^bot123456:AAH.*-1$/); // without the mask: the value
  });

  it('maskPathSegments: whole and partial segments, a value spanning segments, parameters kept, longest first', () => {
    const env = new Map([
      ['tok', 'bot123:ABCdef'],
      ['slashy', 'ab/cd+ef='],
      ['short', 'ab'],
      ['tenant', 'acme'],
      ['tenantLong', 'acme-prod'],
    ]);
    expect(maskPathSegments(['x', 'bot123:ABCdef', { param: 'id' }], env)).toEqual(['x', '{{tok}}', { param: 'id' }]);
    expect(maskPathSegments(['pre-bot123:ABCdef-post'], env)).toEqual(['pre-{{tok}}-post']);
    expect(maskPathSegments(['v1', 'ab', 'cd+ef=', 'items'], env)).toEqual(['v1', '{{slashy}}', '{{slashy}}', 'items']);
    expect(maskPathSegments(['acme-prod', 'acme', 'ab'], env)).toEqual(['{{tenantLong}}', '{{tenant}}', 'ab']);
    expect(maskPathSegments(['a/b'], new Map())).toEqual(['a/b']);
    expect(maskPathSegments(['a/bot123:ABCdef'], env)).toEqual(['a/{{tok}}']);
  });

  it('detectResources names with the mask (overrides are keyed by the masked name); routing keeps the real path', () => {
    const eps = [ep('GET', `/${BOT2}`, [ex([{ id: 1 }])]), ep('GET', `/${BOT2}/:id`, [ex({ id: 1 })])];
    const env = new Map([['botToken', BOT2]]);
    const r = detectResources(eps, { '{{botToken}}': { idField: 'id' } }, { envValues: env });
    expect(r.resources.map((x) => [x.name, x.detected])).toEqual([['{{botToken}}', 'override']]);
    expect(r.resources[0].listPath).toEqual([BOT2]);
    expect(detectResources(eps, {}).resources[0].name).toBe(BOT2);
  });
});

// ------------------------------------------------------------------------------------------------ #10

const nested = (seeded: boolean): MockEndpoint[] => [
  ep('GET', '/users/:userId/orders', seeded ? [ex([{ id: 1, userId: 1 }])] : []),
  ep('POST', '/users/:userId/orders', [ex({}, 201)]),
  ep('GET', '/users/:userId/orders/:id', seeded ? [ex({ id: 1, userId: 1 })] : []),
  ep('DELETE', '/users/:userId/orders/:id'),
];

function emptyScopes(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`{"scope":{"userId":"${i}"},"records":[]}`);
  return `{"version":1,"collection":"shop","resources":{"users.orders":[${parts.join(',')}]}}`;
}

describe('#10: empty scopes in a snapshot count against the caps', () => {
  it('the reviewer’s 29.6 MB snapshot of 690 000 empty scopes is refused while parsing; loading it costs nothing', () => {
    const text = emptyScopes(690_000);
    expect(text.length).toBeGreaterThan(29_000_000);
    const p = parseSnapshot(text);
    expect(p.snapshot).toBeUndefined();
    expect(p.problems).toEqual(['users.orders: more than 5000 records']);
  });

  it('5 000 entries pass, 5 001 do not; records and empty entries share the cap', () => {
    expect(parseSnapshot(emptyScopes(STORE_LIMITS.recordsPerResource)).snapshot).toBeDefined();
    expect(parseSnapshot(emptyScopes(STORE_LIMITS.recordsPerResource + 1)).problems[0]).toMatch(/more than 5000 records/);
    const mixed = {
      version: 1,
      collection: 'c',
      resources: { 'users.orders': [{ scope: { userId: 'a' }, records: Array.from({ length: 4999 }, (_, i) => ({ id: i })) }, { scope: { userId: 'b' }, records: [] }, { scope: { userId: 'c' }, records: [] }] },
    };
    expect(validateSnapshot(mixed).problems[0]).toMatch(/more than 5000 records/);
  });

  it('scope text counts against the byte cap', () => {
    const big = 'x'.repeat(COLLECTION_LIMITS.paramChars);
    const keys = Object.fromEntries(Array.from({ length: 16 }, (_, k) => [`k${k}`, big]));
    const entries = Array.from({ length: 5000 }, () => ({ scope: keys, records: [] }));
    const r = validateSnapshot({ version: 1, collection: 'c', resources: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`r${i}`, entries])) });
    expect(r.problems[0]).toMatch(/The snapshot is over \d+ MB/);
  });

  it('load: with no seed an empty parent is skipped (it reads the same); with a seed it is kept as an emptied parent', () => {
    const plain = storeOf(nested(false)).store;
    expect(plain.load(parseSnapshot(emptyScopes(3)).snapshot!)).toEqual([]);
    expect(plain.dump().resources['users.orders']).toEqual([]);
    const seeded = storeOf(nested(true)).store;
    expect(seeded.load(parseSnapshot(emptyScopes(3)).snapshot!)).toEqual([]);
    expect(seeded.dump().resources['users.orders']).toHaveLength(3);
    expect(JSON.parse(call(seeded, 'users.orders', 'list', { params: { userId: '1' } }).body)).toEqual([]);
    expect(JSON.parse(call(seeded, 'users.orders', 'list', { params: { userId: '9' } }).body)).toEqual([{ id: 1, userId: 9 }]);
  });

  it('app traffic: create then delete in ever new parents leaves no empty parent behind (no seed)', () => {
    const { store } = storeOf(nested(false));
    for (let i = 0; i < 2000; i++) {
      const a = call(store, 'users.orders', 'create', { params: { userId: `u${i}` }, json: {} });
      call(store, 'users.orders', 'delete', { params: { userId: `u${i}`, id: String(JSON.parse(a.body).id) } });
    }
    expect(store.dump().resources['users.orders']).toEqual([]);
  });

  it('with a seed, emptied parents count against the record cap, so what is saved can be loaded again', () => {
    const { store } = storeOf(nested(true));
    let refused = 0;
    for (let i = 0; i < 6000 && !refused; i++) {
      // materialise the seed (1 record), then delete it: the parent is kept, emptied
      const d = call(store, 'users.orders', 'delete', { params: { userId: `u${i}`, id: '1' } });
      if (d.status === 507) refused = i;
    }
    expect(refused).toBe(STORE_LIMITS.recordsPerResource);
    const text = snapshotText({ ...store.dump(), collection: 'shop' }).text;
    const back = storeOf(nested(true)).store;
    expect(back.load(parseSnapshot(text).snapshot!)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ #13

describe('#13: a huge client id never freezes the integer id counter (refused with 400)', () => {
  it('the reviewer’s inputs (B/ids.ts)', () => {
    const { store } = storeOf(crud('/users', [{ id: 1, name: 'a' }]));
    const big = call(store, 'users', 'create', { json: '{"id": 1e300, "name":"big"}' });
    expect(big.status).toBe(400);
    expect(big.body).toMatch(/too large to keep exactly/);
    const t = timed(() => [call(store, 'users', 'create', { json: { name: 'next' } }), call(store, 'users', 'create', { json: { name: 'next2' } })]);
    expect(t.value.map((a) => JSON.parse(a.body).id)).toEqual([2, 3]);
    expect(t.ms).toBeLessThan(50);
    const s2 = storeOf(crud('/items', [{ id: 1 }])).store;
    expect(call(s2, 'items', 'create', { json: '{"id": 9007199254740993}' }).status).toBe(400);
    expect(JSON.parse(call(s2, 'items', 'create', { json: {} }).body).id).toBe(2);
  });

  it('a safe id at the edge is kept but doesn’t move the counter past 2^53 − 1; an unsafe put is skipped', () => {
    const s4 = storeOf(crud('/q', [{ id: 1 }])).store;
    expect(s4.put('q', { id: Number.MAX_SAFE_INTEGER })).toEqual([]);
    expect(JSON.parse(call(s4, 'q', 'create', { json: {} }).body).id).toBe(2);
    expect(s4.put('q', { id: 2 ** 53 })[0]).toMatch(/too large to keep exactly/);
  });

  it('a snapshot `next` at 2^53 − 1: one more id, then 507 at once (never a string id, never a long loop)', () => {
    const { store } = storeOf(crud('/users', [{ id: 1 }]));
    store.load({ version: 1, collection: 'c', savedAt: '', resources: { users: [{ records: [{ id: 1 }] }] }, next: { users: Number.MAX_SAFE_INTEGER } });
    expect(JSON.parse(call(store, 'users', 'create', { json: {} }).body).id).toBe(Number.MAX_SAFE_INTEGER);
    const t = timed(() => call(store, 'users', 'create', { json: {} }));
    expect(t.value.status).toBe(507);
    expect(t.value.body).toMatch(/id counter is used up/);
    expect(t.ms).toBeLessThan(20);
    expect(store.generate('users', 2)[0]).toMatch(/only 0 of 2 added \(the id counter is used up/);
  });
});

// ------------------------------------------------------------------------------------------------ #14

describe('#14: store answers carry only headers HTTP can send; mock headers are checked the same way', () => {
  it('the reviewer’s example headers (A/store-headers.ts) no longer turn every answer into a 502', () => {
    const headers = {
      'content-type': 'application/json',
      'x bad name': '1',
      'x-crlf': 'a\r\nset-cookie: s=1',
      'x-message': 'مرحبا',
      'x-ctl': 'a\x01b',
      'x-a': 'Ā',
      connection: 'close',
      'keep-alive': 'timeout=1',
      upgrade: 'websocket',
      'proxy-authenticate': 'Basic',
      'x-total-count': '1',
      'x-latin1': 'café',
      'content-disposition': "attachment; filename=\"تقرير.pdf\"",
    };
    const { store } = storeOf(crud('/users', [{ id: 1 }], { headers }));
    for (const a of [call(store, 'users', 'list'), call(store, 'users', 'get', { params: { id: '1' } }), call(store, 'users', 'create', { json: {} })]) {
      expect(Object.keys(a.headers).sort()).toEqual(['content-disposition', 'content-type', 'x-latin1', 'x-total-count']);
    }
  });

  it('checkHeaderValue refuses control characters and non-Latin-1 text with a clear message', () => {
    expect(() => checkHeaders({ 'x-message': 'مرحبا' }, 'action.headers', false)).toThrow(/Latin-1 text: HTTP can't send characters such as Arabic letters or emoji/);
    expect(() => checkHeaders({ 'x-a': 'a\x01b' }, 'action.headers', false)).toThrow(/control characters/);
    expect(() => checkHeaders({ 'x-a': ['ok', '😀'] }, 'edit.headers', true)).toThrow(/Latin-1/);
    expect(() => checkHeaders({ 'x-a': 'a\r\nb' }, 'action.headers', false)).toThrow(/CR, LF or NUL/);
    expect(() => checkHeaders({ 'x-a': 'café\tok', 'content-disposition': 'attachment; filename="تقرير.pdf"' }, 'action.headers', false)).not.toThrow();
    expect(() =>
      validateRule({ id: 'r1', enabled: true, match: { url: '*' }, action: { kind: 'mock', status: 200, body: '', headers: { 'x-message': 'مرحبا' } } }),
    ).toThrow(/Latin-1/);
  });
});

// ------------------------------------------------------------------------------------------------ #15 INFO

describe('#15c: a resource named __proto__ / constructor / prototype is like any other', () => {
  it('counts, dump, snapshot text and load (B/protoname.ts)', () => {
    const eps = [...crud('/__proto__', [{ id: 1, n: 'a' }]), ...crud('/constructor', [{ id: 1 }]), ...crud('/prototype', [{ id: 1 }]), ...crud('/users', [{ id: 1 }])];
    const { store, resources } = storeOf(eps);
    expect(resources.map((r) => r.name)).toEqual(['__proto__', 'constructor', 'prototype', 'users']);
    call(store, '__proto__', 'create', { json: { n: 'b' } });
    expect(Object.entries(store.counts())).toEqual([['__proto__', 2], ['constructor', 1], ['prototype', 1], ['users', 1]]);
    const d = store.dump();
    expect(Object.keys(d.resources)).toEqual(['__proto__', 'constructor', 'prototype', 'users']);
    expect(Object.getPrototypeOf(d.resources)).toBeNull();
    const text = snapshotText({ ...d, collection: 'c' }).text;
    expect(Object.keys(JSON.parse(text).resources)).toEqual(['__proto__', 'constructor', 'prototype', 'users']);
    const back = storeOf(eps).store;
    expect(back.load(parseSnapshot(text).snapshot!)).toEqual([]);
    expect(back.counts()['__proto__']).toBe(2);
    expect(({} as Record<string, unknown>).n).toBeUndefined();
  });
});

describe('#15c: store answers keep the number text of the seed and the app', () => {
  it('the reviewer’s example (B/precision.ts): big integers and 10.50 come back as written', () => {
    const seed = '[{"id":1,"tweetId":1234567890123456789,"price":10.50,"ratio":1.0,"e":1e3}]';
    const eps = [ep('GET', '/t', [ex(seed)]), ep('POST', '/t', [ex('{}', 201)]), ep('GET', '/t/:id', [ex('{"id":1,"tweetId":1234567890123456789,"price":10.50,"ratio":1.0,"e":1e3}')]), ep('PATCH', '/t/:id', [ex('{}')])];
    const { store } = storeOf(eps);
    expect(call(store, 't', 'list').body).toBe(seed);
    expect(call(store, 't', 'get', { params: { id: '1' } }).body).toBe('{"id":1,"tweetId":1234567890123456789,"price":10.50,"ratio":1.0,"e":1e3}');
    // the app's own numbers too, through create, patch and the list
    const c = call(store, 't', 'create', { json: '{"price": 2.50, "qty": 3.0, "big": 98765432109876543210}' });
    expect(c.body).toBe('{"id":2,"price":2.50,"qty":3.0,"big":98765432109876543210}');
    const p = call(store, 't', 'patch', { params: { id: '1' }, json: '{"ratio": 2.0}' });
    expect(p.body).toBe('{"id":1,"tweetId":1234567890123456789,"price":10.50,"ratio":2.0,"e":1e3}');
    expect(call(store, 't', 'list').body).toContain('"price":2.50,"qty":3.0,"big":98765432109876543210');
    // a changed value is written as JavaScript writes it
    const q = call(store, 't', 'patch', { params: { id: '1' }, json: '{"price": 11}' });
    expect(q.body).toContain('"price":11');
  });

  it('stringifyJson / parseJsonText: unchanged text for ordinary JSON, never confused by look-alike strings', () => {
    const t = '{"a":1,"b":[1.50,2],"s":"\\u0000fi-num-x:0","d":"2026-11-20T11:22:56.919Z"}';
    const v = parseJsonText(t);
    expect(v.ok && stringifyJson(v.value)).toBe(t);
    expect(stringifyJson({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(stringifyJson(undefined)).toBe('null');
  });
});

describe('#15g: the Bruno walk reads each file through the descriptor it checked', () => {
  const nodeFs: RulesFs = {
    readFile: (p) => fs.promises.readFile(p),
    writeFile: (p, d) => fs.promises.writeFile(p, d, 'utf8'),
    rename: (a, b) => fs.promises.rename(a, b),
    unlink: (p) => fs.promises.unlink(p),
    mkdir: async (p) => void (await fs.promises.mkdir(p, { recursive: true })),
    stat: (p) => fs.promises.stat(p),
    readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
    realpathSync: (p) => fs.realpathSync.native(p),
  };
  const req = (n: string, u: string) => `meta {\n  name: ${n}\n}\nget {\n  url: ${u}\n}\n`;

  it('a file swapped for a symbolic link (or another file) after the walk is not read', async () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-f3-ws-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-f3-out-')));
    try {
      fs.writeFileSync(path.join(outside, 'secret.bru'), req('OUTSIDE-SECRET', 'https://outside.test/leak'));
      const b = path.join(ws, 'api/c');
      fs.mkdirSync(b, { recursive: true });
      fs.writeFileSync(path.join(b, 'bruno.json'), '{"name":"c"}');
      fs.writeFileSync(path.join(b, 'ok.bru'), req('ok', 'https://in.test/ok'));
      fs.writeFileSync(path.join(b, 'swap.bru'), req('swap', 'https://in.test/swap'));
      fs.writeFileSync(path.join(b, 'replaced.bru'), req('replaced', 'https://in.test/replaced'));
      const core = new MockCollectionsCore({
        links: () => [],
        saveLinks: async () => undefined,
        primaryFolderPath: () => ws,
        writeWorkspaceFile: async () => undefined,
        workspaceRoots: () => [ws],
        fs: nodeFs,
        memento: new FakeMemento(),
        parsers: collectionParsers,
        newRuleId: () => 'r',
      } as unknown as ConstructorParameters<typeof MockCollectionsCore>[0]);
      const inner = core as unknown as {
        walkBruno(rel: string, folder: string): Promise<{ files: { rel: string; dev?: number; ino?: number }[] }>;
        readWalked(f: unknown): Promise<Uint8Array | undefined>;
        readBruno(link: { file: string; variables: Record<string, string> }, folder: string, watch: boolean): Promise<{ parsed: { endpoints: { name: string }[]; problems: string[] } }>;
      };
      const walked = await inner.walkBruno('api/c/bruno.json', ws);
      const byRel = new Map(walked.files.map((f) => [f.rel, f]));
      expect(typeof byRel.get('ok.bru')?.ino).toBe('number');
      // the swap, between the check and the read
      fs.unlinkSync(path.join(b, 'swap.bru'));
      fs.symlinkSync(path.join(outside, 'secret.bru'), path.join(b, 'swap.bru'));
      fs.renameSync(path.join(b, 'replaced.bru'), path.join(b, 'old.tmp'));
      fs.writeFileSync(path.join(b, 'replaced.bru'), req('NEW-FILE', 'https://in.test/new'));
      expect(await inner.readWalked(byRel.get('swap.bru'))).toBeUndefined();
      expect(await inner.readWalked(byRel.get('replaced.bru'))).toBeUndefined();
      expect(new TextDecoder().decode(await inner.readWalked(byRel.get('ok.bru')))).toContain('https://in.test/ok');
      // PERF-5 #3: reads side by side take their size from the shared budget first; none is read past it
      let budget = 10;
      const reserve = (n: number) => (budget -= n) >= 0;
      const over = await (inner.readWalked as (f: unknown, r: (n: number) => boolean) => Promise<unknown>).call(core, byRel.get('ok.bru'), reserve);
      expect(typeof over).toBe('symbol');
      expect(budget).toBeLessThan(0);
      // a whole read after a fresh walk never follows the link
      const r = await inner.readBruno({ file: 'api/c/bruno.json', variables: {} }, ws, false);
      expect(r.parsed.endpoints.map((e) => e.name).sort()).toEqual(['NEW-FILE', 'ok']);
      expect(JSON.stringify(r)).not.toContain('OUTSIDE-SECRET');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------ secret check, agent text

describe('secret check: session / sessions / pass are secret only for a text value', () => {
  it('isSecretField by value; isSecretName (no value) is unchanged', () => {
    for (const [name, value, secret] of [
      ['session', 'abc123def', true],
      ['sessions', 'abc123def', true],
      ['pass', 'Hunter2!', true],
      ['session', { id: 1, start: '09:00' }, false],
      ['sessions', [{ id: 1, kind: 'run' }, { id: 2, kind: 'swim' }], false],
      ['sessions', 3, false],
      ['pass', true, false],
      ['pass', false, false],
      ['pass', 12, false],
      ['pass', null, false],
      ['Session', 'abc', true],
      ['password', { a: 1 }, true],
      ['sessionId', 7, true],
      ['passenger', 'x', false],
    ] as const) {
      expect(isSecretField(name, value), `${name} ${JSON.stringify(value)}`).toBe(secret);
    }
    expect(isSecretName('session')).toBe(true);
    expect(isSecretName('pass')).toBe(true);
  });

  it('the store keeps a list of workout sessions and pass: true, and drops pass: "…" (withoutSecretFields)', () => {
    const body = { sessions: [{ id: 1, kind: 'run' }], session: { id: 9 }, pass: true, user: { pass: 'Hunter2!', sessions: 'tok-123' } };
    expect(JSON.parse(JSON.stringify(withoutSecretFields(body)))).toEqual({ sessions: [{ id: 1, kind: 'run' }], session: { id: 9 }, pass: true, user: {} });
  });

  it('a snapshot keeps them too, and blanks the text ones', () => {
    const r = snapshotText({
      version: 1,
      collection: 'c',
      savedAt: '',
      resources: { users: [{ records: [{ id: 1, sessions: [{ id: 1, kind: 'run' }], pass: true, session: 'abc123', other: { pass: 'Hunter2!' } }] }] },
    });
    const rec = JSON.parse(r.text).resources.users[0].records[0];
    expect(rec).toEqual({ id: 1, sessions: [{ id: 1, kind: 'run' }], pass: true, session: '', other: { pass: '' } });
    expect(r.blanked.sort()).toEqual(['users.other.pass', 'users.session']);
  });
});

describe('agent text: replacePersonalData is ignored for agents', () => {
  it('schema and tool descriptions say so; the Copilot confirmation never offers turning it off', () => {
    const shape = (toolSchemas.mock_from_traffic as unknown as { shape: Record<string, { description?: string }> }).shape;
    expect(shape.replacePersonalData.description).toMatch(/^Ignored for agents: personal data is always replaced/);
    const doc = languageModelToolsContribution().find((t) => t.name.endsWith('mock_from_traffic'))!;
    expect(doc.modelDescription).toContain('personal data is always replaced');
    expect(doc.modelDescription).not.toMatch(/unless replacePersonalData is false/);
    for (const input of [{}, { replacePersonalData: false }]) {
      const m = confirmationText('mock_from_traffic', input).message;
      expect(m).toContain('e-mails, phones and addresses replaced');
      expect(m).not.toMatch(/replacePersonalData|turn(ed)? off|unless/i);
    }
  });
});
