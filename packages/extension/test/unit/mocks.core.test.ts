// CONTRACTS §21.6, §21.7 (H): the collections host core with a fake fs and fake parsers.
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { compileRules, findRule } from '@flutter-intercept/proxy/rules';
import { APPROVALS_KEY, COLLECTIONS_DIR, ENABLED_KEY, MockCollectionsCore, OVERLAY_KEY, parseJsonText, slugId, type CollectionParsers } from '../../src/mocks/core';
import type { Exchange } from '@flutter-intercept/proxy';
import type { CollectionLink, CollectionVars, MockEndpoint, ParsedCollection } from '../../src/mocks/types';
import type { FolderCollectionLinks } from '../../src/rules/core';
import { FakeFs } from './rules.fakes';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const read = (f: string) => fs.readFileSync(path.join(fixtures, f), 'utf8');
const expected = JSON.parse(read('shop.expected.json'));
const ROOT = '/ws/app';

class Memento {
  data = new Map<string, unknown>();
  get<T>(k: string): T | undefined {
    return this.data.get(k) as T | undefined;
  }
  async update(k: string, v: unknown): Promise<void> {
    this.data.set(k, v);
  }
}

/** Fake parsers: the fixture's expected output, with `baseUrl` taken from the merged variables. */
const parsers: CollectionParsers = {
  detectFormat: (doc) => {
    const d = doc as { info?: { schema?: string }; openapi?: string; swagger?: string } | null;
    if (d?.info?.schema?.includes('getpostman')) return { format: 'postman' };
    if (typeof d?.openapi === 'string' && d.openapi.startsWith('3.')) return { format: 'openapi' };
    if (d?.swagger) return { problem: "Swagger 2.0 isn't supported yet: convert it to OpenAPI 3." };
    return { problem: 'not a collection' };
  },
  parsePostman: (_doc, vars: CollectionVars): ParsedCollection => {
    const base = vars.values.get('baseUrl');
    const endpoints = (expected.postman.endpoints as MockEndpoint[]).map((e) => {
      const host = e.unresolved[0] && vars.values.get(e.unresolved[0]);
      if (host) return { ...e, origin: host, unresolved: [] };
      if (!e.key.includes('{{baseUrl}}')) return e;
      if (!base) return { ...e, origin: undefined, unresolved: ['baseUrl'] };
      return { ...e, origin: base };
    });
    return { format: 'postman', name: 'Shop API', endpoints, variables: [{ name: 'baseUrl', ...(base ? { from: vars.sources.get('baseUrl') } : {}) }], problems: ['Health: an example has no status code; 200 is used'] };
  },
  postmanCollectionVariables: (doc) => new Map(((doc as { variable?: { key: string; value: string }[] }).variable ?? []).map((v) => [v.key, v.value])),
  parsePostmanEnvironment: (doc) => ({
    values: new Map(((doc as { values: { key: string; value: string; enabled?: boolean }[] }).values ?? []).filter((v) => v.enabled !== false && v.value).map((v) => [v.key, v.value])),
    problems: [],
  }),
  mergeCollectionVars: (link, env, col) => {
    const values = new Map<string, string>();
    const sources = new Map<string, 'link' | 'environment' | 'collection'>();
    for (const [src, m] of [['link', new Map(Object.entries(link))], ['environment', env], ['collection', col]] as const) {
      for (const [k, v] of m) if (v && !values.has(k)) (values.set(k, v), sources.set(k, src));
    }
    return { values, sources };
  },
  parseOpenApi: () => ({ format: 'openapi', name: 'Shop API', endpoints: expected.openapi.endpoints, variables: [{ name: 'region', from: 'server' }], problems: [] }),
  sanitisePostman: (doc) => {
    const text = JSON.stringify(doc);
    const removed = text.includes('live-key-123') ? ['X-Api-Key', 'auth (bearer)'] : [];
    return { doc: JSON.parse(text.replace(/live-key-123/g, '')), removed };
  },
};

let files: FakeFs;
let memento: Memento;
let links: CollectionLink[];
let saves: CollectionLink[][];
let core: MockCollectionsCore;
let ids: number;

function link(l: Partial<CollectionLink> & Pick<CollectionLink, 'id' | 'file'>): CollectionLink {
  return { variables: {}, enabled: true, unmatched: 'passthrough', selected: {}, off: [], ...l };
}

let exchanges: Exchange[] = [];
let passthrough: string[] = [];

function make(extraFolders: FolderCollectionLinks[] = []): MockCollectionsCore {
  return new MockCollectionsCore({
    links: () => [{ folderPath: ROOT, label: '.vscode/flutter-intercept.json', links, problems: [] }, ...extraFolders],
    saveLinks: async (folder, next) => {
      expect(folder).toBe(ROOT);
      saves.push(next);
      links = next;
    },
    primaryFolderPath: async () => ROOT,
    writeWorkspaceFile: async (folder, rel, text) => {
      files.put(path.join(folder, rel), text);
    },
    workspaceRoots: () => [ROOT],
    fs: files,
    memento,
    parsers,
    newRuleId: () => `rule_${++ids}`,
    exchanges: () => exchanges,
    passthroughHosts: () => passthrough,
  });
}

beforeEach(() => {
  files = new FakeFs();
  files.put(`${ROOT}/pubspec.yaml`, 'name: app');
  files.put(`${ROOT}/api/shop.postman_collection.json`, read('shop.postman_collection.json'));
  files.put(`${ROOT}/api/dev.postman_environment.json`, read('shop.postman_environment.json'));
  files.put(`${ROOT}/api/shop.openapi.yaml`, read('shop.openapi.yaml'));
  memento = new Memento();
  links = [link({ id: 'shop', file: 'api/shop.postman_collection.json', environment: 'api/dev.postman_environment.json' })];
  saves = [];
  ids = 0;
  exchanges = [];
  passthrough = [];
  core = make();
});

const answer = (method: string, url: string) => findRule(compileRules(core.rules()), method, url);

describe('loading', () => {
  it('builds rules and a status from a linked collection and its environment', async () => {
    expect(await core.reload()).toBe(true);
    const [s] = core.state();
    expect(s).toMatchObject({ id: 'shop', name: 'Shop API', file: 'api/shop.postman_collection.json', format: 'postman', enabled: true, unmatched: 'passthrough', endpoints: 11, mocked: 8, noExample: 2, generated: 0, off: 0 });
    expect(s.origins).toEqual(['https://api.shop.example', 'https://cdn.shop.example']);
    expect(s.unresolved).toEqual(['analyticsHost']);
    expect(answer('GET', 'https://api.shop.example/users/me')?.action).toMatchObject({ body: '{"id":1,"name":"Sara"}' });
    expect(await core.reload()).toBe(false);
  });

  it('never shows environment values', async () => {
    await core.reload();
    const out = JSON.stringify([core.state(), core.endpoints('shop'), core.fileProblems()]);
    expect(out).not.toContain('env-token-must-never-leave-the-host');
  });

  it('reports credentials held by a linked Postman file, by name only', async () => {
    await core.reload();
    const p = core.state()[0].problems[0];
    expect(p).toContain('holds credentials (X-Api-Key, auth (bearer))');
    expect(p).not.toContain('live-key-123');
  });

  it('without the environment, baseUrl is unresolved and those requests are not mocked', async () => {
    links = [link({ id: 'shop', file: 'api/shop.postman_collection.json' })];
    await core.reload();
    expect(core.state()[0].unresolved).toEqual(['baseUrl', 'analyticsHost']);
    expect(answer('GET', 'https://api.shop.example/users/me')).toBeUndefined();
    expect(answer('GET', 'https://cdn.shop.example/config.json')).toBeDefined();
  });

  it('a link variable wins over the environment', async () => {
    links = [link({ id: 'shop', file: 'api/shop.postman_collection.json', environment: 'api/dev.postman_environment.json', variables: { baseUrl: 'http://localhost:8080' } })];
    await core.reload();
    expect(answer('GET', 'http://localhost:8080/users/me')).toBeDefined();
    expect(answer('GET', 'https://api.shop.example/users/me')).toBeUndefined();
  });

  it('reads YAML OpenAPI documents', async () => {
    links = [link({ id: 'oa', file: 'api/shop.openapi.yaml' })];
    await core.reload();
    expect(core.state()[0]).toMatchObject({ format: 'openapi', mocked: 6, generated: 2, problems: [] });
  });

  it('a missing file is a problem and no rules', async () => {
    links = [link({ id: 'gone', file: 'api/nope.json' })];
    await core.reload();
    expect(core.state()[0].problems).toEqual(['collection file api/nope.json not found']);
    expect(core.rules()).toEqual([]);
  });

  it('a file outside the workspace is refused', async () => {
    files.put('/elsewhere/c.json', read('shop.postman_collection.json'));
    links = [link({ id: 'out', file: '../../elsewhere/c.json' })];
    await core.reload();
    expect(core.state()[0].problems[0]).toMatch(/must be inside the workspace|not found/);
    expect(core.rules()).toEqual([]);
  });

  it('broken JSON: a position, never file text; the last good version stays', async () => {
    await core.reload();
    const before = core.rules().length;
    files.put(`${ROOT}/api/shop.postman_collection.json`, '{"info": {"name": "secret-abc"\n  oops');
    await core.reload();
    const s = core.state()[0];
    expect(s.problems.find((p) => p.includes('not valid JSON'))).toMatch(/^api\/shop\.postman_collection\.json line 2, column \d+: not valid JSON — using the last good version$/);
    expect(JSON.stringify(s)).not.toContain('secret-abc');
    expect(core.rules().length).toBe(before);
  });

  it('a file that is not a collection is a problem', async () => {
    files.put(`${ROOT}/api/s2.json`, '{"swagger": "2.0"}');
    links = [link({ id: 's2', file: 'api/s2.json' })];
    await core.reload();
    expect(core.state()[0].problems).toEqual(["api/s2.json: Swagger 2.0 isn't supported yet: convert it to OpenAPI 3."]);
  });

  it('a file over 20 MB is refused before it is read', async () => {
    files.put(`${ROOT}/api/big.json`, new Uint8Array(20 * 1024 * 1024 + 1));
    links = [link({ id: 'big', file: 'api/big.json' })];
    await core.reload();
    expect(core.state()[0].problems).toEqual(['collection file api/big.json is larger than 20 MB']);
  });

  it('caches by size and mtime: an unchanged file is not parsed again', async () => {
    let calls = 0;
    const counting = { ...parsers, parsePostman: (d: unknown, v: CollectionVars) => (calls++, parsers.parsePostman(d, v)) };
    core = new MockCollectionsCore({ ...(core as unknown as { deps: object }).deps, parsers: counting } as ConstructorParameters<typeof MockCollectionsCore>[0]);
    await core.reload();
    await core.reload();
    expect(calls).toBe(1);
    files.put(`${ROOT}/api/shop.postman_collection.json`, read('shop.postman_collection.json'));
    await core.reload();
    expect(calls).toBe(2);
  });

  it('the same id in another workspace folder is skipped with a problem', async () => {
    core = make([{ folderPath: '/ws/other', label: 'other/.vscode/flutter-intercept.json', links: [link({ id: 'shop', file: 'x.json' })], problems: ['other/.vscode/flutter-intercept.json: collection 2: bad (skipped)'] }]);
    await core.reload();
    expect(core.state()).toHaveLength(1);
    expect(core.fileProblems()).toEqual([
      'other/.vscode/flutter-intercept.json: collection 2: bad (skipped)',
      'other/.vscode/flutter-intercept.json: collection "shop" is also linked in another workspace folder (skipped)',
    ]);
  });

  it('caps the problems', async () => {
    const many = { ...parsers, parsePostman: (d: unknown, v: CollectionVars) => ({ ...parsers.parsePostman(d, v), problems: Array.from({ length: 80 }, (_, i) => `p${i}`) }) };
    core = new MockCollectionsCore({ ...(core as unknown as { deps: object }).deps, parsers: many } as ConstructorParameters<typeof MockCollectionsCore>[0]);
    await core.reload();
    const p = core.state()[0].problems;
    expect(p).toHaveLength(50);
    expect(p[49]).toMatch(/^… and \d+ more problems$/);
  });
});

describe('reading', () => {
  beforeEach(async () => {
    await core.reload();
  });

  it('endpoints for the panel', () => {
    const list = core.endpoints('shop');
    expect(list).toHaveLength(11);
    expect(list[0]).toEqual({
      key: 'POST {{baseUrl}}/auth/login',
      method: 'POST',
      name: 'Log in',
      folder: ['Auth'],
      url: 'https://api.shop.example/auth/login',
      examples: [
        { name: 'Success', status: 200 },
        { name: 'Wrong password', status: 401 },
      ],
    });
    expect(list.find((e) => e.name === 'User by id')!.url).toBe('https://api.shop.example/users/:id');
    expect(list.find((e) => e.name === 'Analytics')).toMatchObject({ url: '{{analyticsHost}}/collect', unresolved: ['analyticsHost'] });
    expect(list.find((e) => e.name === 'List users')!.examples[1]).toEqual({ name: 'Page 2', status: 200, query: { page: '2' } });
  });

  it('one example, cut at 256 KB', async () => {
    expect(core.example('shop', 'GET {{baseUrl}}/users/me', 'OK')).toEqual({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"id":1,"name":"Sara"}' });
    expect(() => core.example('shop', 'GET {{baseUrl}}/users/me', 'Nope')).toThrow('has no example "Nope"');
    expect(() => core.example('nope', 'x', 'y')).toThrow('No collection "nope" is linked');
    const big = { ...parsers, parsePostman: (d: unknown, v: CollectionVars) => {
      const p = parsers.parsePostman(d, v);
      return { ...p, endpoints: p.endpoints.map((e) => (e.name === 'Me' ? { ...e, examples: [{ ...e.examples[0], body: 'é'.repeat(200_000) }] } : e)) };
    } };
    core = new MockCollectionsCore({ ...(core as unknown as { deps: object }).deps, parsers: big } as ConstructorParameters<typeof MockCollectionsCore>[0]);
    await core.reload();
    const x = core.example('shop', 'GET {{baseUrl}}/users/me', 'OK');
    expect(x.truncated).toBe(true);
    expect(new TextEncoder().encode(x.body).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(x.body.endsWith('é')).toBe(true);
  });

  it('toRule: a personal copy of what answers now, with a new id', () => {
    const r = core.toRule('shop', 'GET {{baseUrl}}/users/:id');
    expect(r.id).toBe('rule_1');
    expect(r.shared).toBeUndefined();
    expect(r.action).toMatchObject({ kind: 'mock', status: 200, body: '{"id":42,"name":"Lina"}' });
    expect(r.name).toBe('Shop API › User by id · Found');
    expect(core.toRule('shop', 'POST {{baseUrl}}/auth/refresh').action).toMatchObject({ status: 501 });
    expect(() => core.toRule('shop', 'POST {{analyticsHost}}/collect')).toThrow('set analyticsHost first');
  });
});

describe('changing', () => {
  beforeEach(async () => {
    await core.reload();
  });

  it('enabled is personal (workspaceState), never written to the file', async () => {
    await core.update('shop', { enabled: false });
    expect(saves).toEqual([]);
    expect(memento.get(ENABLED_KEY)).toEqual({ [`${ROOT}\0shop`]: false });
    expect(core.state()[0].enabled).toBe(false);
    expect(core.rules()).toEqual([]);
    await core.update('shop', { enabled: true });
    expect(memento.get(ENABLED_KEY)).toEqual({});
    expect(core.rules().length).toBeGreaterThan(0);
  });

  it('with scope "team", an example selection, off, unmatched and a variable are written to the shared file', async () => {
    await core.update('shop', { example: { endpoint: 'POST {{baseUrl}}/auth/login', name: 'Wrong password' }, scope: 'team' });
    expect(answer('POST', 'https://api.shop.example/auth/login')?.action).toMatchObject({ status: 401 });
    await core.update('shop', { off: { endpoint: 'GET {{baseUrl}}/users/me', off: true }, scope: 'team' });
    await core.update('shop', { unmatched: 'fail', scope: 'team' });
    await core.update('shop', { variable: { name: 'analyticsHost', value: 'https://stats.shop.example' } });
    expect(links[0]).toMatchObject({
      selected: { 'POST {{baseUrl}}/auth/login': 'Wrong password' },
      off: ['GET {{baseUrl}}/users/me'],
      unmatched: 'fail',
      variables: { analyticsHost: 'https://stats.shop.example' },
    });
    expect(answer('POST', 'https://stats.shop.example/collect')?.action).toMatchObject({ status: 202 });
    await core.update('shop', { variable: { name: 'analyticsHost', value: '' }, off: { endpoint: 'GET {{baseUrl}}/users/me', off: false }, scope: 'team' });
    expect(links[0].variables).toEqual({});
    expect(links[0].off).toEqual([]);
  });

  it('refuses invalid patches with readable errors and writes nothing', async () => {
    const bad: [unknown, string][] = [
      [{}, 'patch is empty'],
      [{ nope: 1 }, 'unknown field "nope"'],
      [{ enabled: 'yes' }, 'enabled must be true or false'],
      [{ unmatched: 'block' }, 'unmatched must be'],
      [{ variable: { name: 'bad name', value: 'x' } }, 'variable.name'],
      [{ variable: { name: 'baseUrl', value: 'a\nb' } }, 'variable.value'],
      [{ example: { endpoint: 'POST {{baseUrl}}/auth/login', name: 'Nope' } }, 'has no example "Nope"'],
      [{ example: { endpoint: 'GET /nope', name: 'x' } }, 'has no request'],
      [{ off: { endpoint: 'GET {{baseUrl}}/users/me', off: 'yes' } }, 'off must be'],
    ];
    for (const [patch, msg] of bad) await expect(core.update('shop', patch as never), JSON.stringify(patch)).rejects.toThrow(msg);
    await expect(core.update('nope', { enabled: true })).rejects.toThrow('No collection "nope" is linked');
    expect(saves).toEqual([]);
  });

  it('remove deletes the link and the personal override, never the file', async () => {
    await core.update('shop', { enabled: false });
    await core.remove('shop');
    expect(links).toEqual([]);
    expect(memento.get(ENABLED_KEY)).toEqual({});
    expect(files.text(`${ROOT}/api/shop.postman_collection.json`)).toBeDefined();
    expect(core.state()).toEqual([]);
  });
});

describe('importing', () => {
  it('links a file inside the workspace with an id from its name', async () => {
    links = [];
    const { id } = await core.addLink({ file: 'api/shop.openapi.yaml' });
    expect(id).toBe('shop-api');
    expect(links).toEqual([link({ id: 'shop-api', file: 'api/shop.openapi.yaml' })]);
    expect(core.state()[0].mocked).toBe(6);
    const second = await core.addLink({ file: 'api/shop.postman_collection.json', environment: 'api/dev.postman_environment.json' });
    expect(second.id).toBe('shop-api-2');
  });

  it('refuses a file already linked, outside the workspace, or not a collection', async () => {
    await expect(core.addLink({ file: 'api/shop.postman_collection.json' })).rejects.toThrow('already linked (collection "shop")');
    await expect(core.addLink({ file: '/etc/passwd' })).rejects.toThrow('inside the workspace');
    await expect(core.addLink({ file: '../x.json' })).rejects.toThrow('inside the workspace');
    files.put(`${ROOT}/api/other.json`, '{"hello": 1}');
    await expect(core.addLink({ file: 'api/other.json' })).rejects.toThrow('api/other.json: not a collection');
  });

  it('copies a collection in without credentials, never over an existing file', async () => {
    const text = read('shop.postman_collection.json');
    const a = await core.copyIn(text, 'Shop.postman_collection.json', 'sanitised');
    expect(a).toEqual({ file: `${COLLECTIONS_DIR}/shop.json`, removed: ['X-Api-Key', 'auth (bearer)'] });
    expect(files.text(`${ROOT}/${a.file}`)).not.toContain('live-key-123');
    const b = await core.copyIn(text, 'shop.postman_collection.json', 'as-is');
    expect(b.file).toBe(`${COLLECTIONS_DIR}/shop-2.json`);
    expect(files.text(`${ROOT}/${b.file}`)).toBe(text);
    const y = await core.copyIn(read('shop.openapi.yaml'), 'api.yml', 'sanitised');
    expect(y).toEqual({ file: `${COLLECTIONS_DIR}/api.yml`, removed: [] });
  });

  it('copyIn refuses what is not a collection', async () => {
    await expect(core.copyIn('{"a":1}', 'a.json', 'as-is')).rejects.toThrow('a.json: not a collection');
    await expect(core.copyIn('{oops', 'a.json', 'as-is')).rejects.toThrow('a.json line 1, column 2: not valid JSON');
  });
});

describe('helpers', () => {
  it('slugId', () => {
    expect(slugId('Shop API', new Set())).toBe('shop-api');
    expect(slugId('Shop API', new Set(['shop-api', 'shop-api-2']))).toBe('shop-api-3');
    expect(slugId('مستخدمين', new Set())).toBe('collection');
    expect(slugId('Café — Orders!', new Set())).toBe('cafe-orders');
    expect(slugId('x'.repeat(100), new Set()).length).toBeLessThanOrEqual(40);
  });

  it('parseJsonText', () => {
    expect(parseJsonText('﻿{"a":1}', 'f').value).toEqual({ a: 1 });
    expect(parseJsonText('{\n"a": secret}', 'f.json').problem).toBe('f.json line 2, column 6: not valid JSON');
  });
});


// ------------------------------------------------------------------ CONTRACTS §21.15 / §21.16, REVIEW-15

const LOGIN = 'POST {{baseUrl}}/auth/login';
const ME = 'GET {{baseUrl}}/users/me';
const CONFIG = 'https://cdn.shop.example/config.json';

function ex(id: string, method: string, url: string, matchedRuleId?: string, state: Exchange['state'] = 'completed'): Exchange {
  return { id, method, url, state, startedAt: 0, requestHeaders: {}, ...(matchedRuleId ? { matchedRuleId } : {}) } as unknown as Exchange;
}

describe('§21.15 #1: changes are for me by default', () => {
  it('example, off and unmatched go to the overlay; the shared file is untouched', async () => {
    await core.reload();
    await core.update('shop', { example: { endpoint: LOGIN, name: 'Wrong password' } });
    await core.update('shop', { off: { endpoint: ME, off: true } });
    await core.update('shop', { unmatched: 'fail' });
    expect(saves).toEqual([]);
    expect(answer('POST', 'https://api.shop.example/auth/login')?.action).toMatchObject({ status: 401 });
    const [s] = core.state();
    expect(s.overrides).toBe(3);
    expect(s.unmatched).toBe('fail');
    expect(core.endpoints('shop').find((e) => e.key === LOGIN)).toMatchObject({ selected: 'Wrong password', overridden: true });
    expect(core.endpoints('shop').find((e) => e.key === ME)).toMatchObject({ off: true, overridden: true });
    expect(memento.get(OVERLAY_KEY)).toEqual({ [`${ROOT}\0shop`]: { selected: { [LOGIN]: 'Wrong password' }, off: { [ME]: true }, unmatched: 'fail' } });
  });

  it('reset clears one endpoint or everything; it needs scope "me" and stands alone', async () => {
    await core.reload();
    await core.update('shop', { example: { endpoint: LOGIN, name: 'Wrong password' } });
    await core.update('shop', { off: { endpoint: ME, off: true } });
    await core.update('shop', { reset: true, endpoint: LOGIN });
    expect(answer('POST', 'https://api.shop.example/auth/login')?.action).toMatchObject({ status: 200 });
    expect(core.state()[0].overrides).toBe(1);
    await core.update('shop', { reset: true });
    expect(core.state()[0].overrides).toBe(0);
    expect(memento.get(OVERLAY_KEY)).toEqual({});
    await expect(core.update('shop', { reset: true, scope: 'team' })).rejects.toThrow('scope "me"');
    await expect(core.update('shop', { reset: true, unmatched: 'fail' })).rejects.toThrow("can't be combined");
    await expect(core.update('shop', { endpoint: LOGIN } as never)).rejects.toThrow('only used with reset');
    expect(saves).toEqual([]);
  });

  it('"Save for the team" writes the file and drops the same overlay entries', async () => {
    await core.reload();
    await core.update('shop', { example: { endpoint: LOGIN, name: 'Wrong password' } });
    await core.update('shop', { example: { endpoint: LOGIN, name: 'Wrong password' }, scope: 'team' });
    expect(links[0].selected).toEqual({ [LOGIN]: 'Wrong password' });
    expect(core.state()[0].overrides).toBe(0);
  });

  it('a URL variable is always the team\'s, and one that stands for a server must be a plain URL', async () => {
    await core.reload();
    await core.update('shop', { variable: { name: 'analyticsHost', value: 'https://stats.shop.example' } });
    expect(links[0].variables).toEqual({ analyticsHost: 'https://stats.shop.example' });
    for (const bad of ['https://user:pw@stats.example', 'javascript:alert(1)', 'https://a b', 'ftp://x']) {
      await expect(core.update('shop', { variable: { name: 'analyticsHost', value: bad } }), bad).rejects.toThrow('stands for a server');
    }
    await core.update('shop', { variable: { name: 'analyticsHost', value: 'stats.shop.example:8443' } });
  });
});

describe('§21.16: limited until approved (REVIEW-15 #1, #4)', () => {
  it('a risky answer is served without the risky parts; plain JSON answers are untouched', async () => {
    await core.reload();
    const a = answer('GET', CONFIG)!.action as { headers: Record<string, string>; body: string };
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(a.headers['x-tag']).toBe('a, b');
    expect(a.headers['x-flutter-intercept']).toBe('limited; removed=set-cookie');
    expect(a.body).toBe('{"theme":"dark"}');
    const login = answer('POST', 'https://api.shop.example/auth/login')!.action as { headers: Record<string, string> };
    expect(login.headers['x-flutter-intercept']).toBeUndefined();
    expect(core.state()[0].limited).toEqual({ reasons: ['sets cookies'], answers: 1 });
    expect(core.approvalSummary('shop')).toMatchObject({ reasons: ['sets cookies'], answers: 1, origins: ['https://api.shop.example', 'https://cdn.shop.example'] });
  });

  it('approval gives full answers; an edit of the file or a new URL variable limits again; selections don\'t', async () => {
    await core.reload();
    await core.approve('shop');
    expect((answer('GET', CONFIG)!.action as { headers: Record<string, string> }).headers['set-cookie']).toBe('a=1');
    expect(core.state()[0].limited).toBeUndefined();
    await core.update('shop', { example: { endpoint: LOGIN, name: 'Wrong password' } });
    expect(core.state()[0].limited).toBeUndefined();
    await core.update('shop', { variable: { name: 'analyticsHost', value: 'https://stats.shop.example' } });
    expect(core.state()[0].limited).toEqual({ reasons: ['sets cookies'], answers: 1 });
    await core.approve('shop');
    files.put(`${ROOT}/api/shop.postman_collection.json`, `${read('shop.postman_collection.json')}\n`);
    await core.reload();
    expect(core.state()[0].limited).toBeDefined();
    expect(Object.values(memento.get<Record<string, string[]>>(APPROVALS_KEY)!)[0].length).toBe(2);
  });

  it('describeRule says which answer was limited', async () => {
    await core.reload();
    const r = answer('GET', CONFIG)!;
    expect(core.describeRule(r.id)).toEqual({ id: 'shop', name: 'Shop API', endpoint: 'GET https://CDN.shop.example:443/config.json', example: 'OK', limited: ['set-cookie'] });
  });
});

describe('§21.15 #2–#4: traffic', () => {
  it('describeRule names the endpoint, the example, a 501 and the unmatched failure', async () => {
    await core.reload();
    await core.update('shop', { unmatched: 'fail' });
    const login = answer('POST', 'https://api.shop.example/auth/login')!;
    expect(core.describeRule(login.id)).toEqual({ id: 'shop', name: 'Shop API', endpoint: LOGIN, example: 'Success' });
    const refresh = answer('POST', 'https://api.shop.example/auth/refresh')!;
    expect(core.describeRule(refresh.id)).toMatchObject({ endpoint: 'POST {{baseUrl}}/auth/refresh', noExample: true });
    const fail = answer('GET', 'https://api.shop.example/nope')!;
    expect(core.describeRule(fail.id)).toMatchObject({ unmatched: true });
    expect(core.describeRule('rule_1')).toBeUndefined();
    expect(core.describeRule(undefined)).toBeUndefined();
  });

  it('endpointForRequest: by the rule that answered, else by method + URL, else a readable error', async () => {
    await core.reload();
    const login = answer('POST', 'https://api.shop.example/auth/login')!;
    expect(core.endpointForRequest('shop', { method: 'POST', url: 'https://x.test/', matchedRuleId: login.id })).toBe(LOGIN);
    await core.update('shop', { off: { endpoint: ME, off: true } });
    expect(core.endpointForRequest('shop', { method: 'GET', url: 'https://api.shop.example/users/me?x=1' })).toBe(ME);
    expect(() => core.endpointForRequest('shop', { method: 'GET', url: 'https://api.shop.example/nope?token=abc' })).toThrow('GET https://api.shop.example/nope is not in collection "shop"');
  });

  it('seen lists requests the collection lacks and requests answered 501, counted and templated', async () => {
    await core.reload();
    const refresh = answer('POST', 'https://api.shop.example/auth/refresh')!;
    exchanges = [
      ex('1', 'GET', 'https://api.shop.example/orders/42'),
      ex('2', 'GET', 'https://api.shop.example/orders/43'),
      ex('3', 'POST', 'https://api.shop.example/auth/refresh', refresh.id),
      ex('4', 'GET', 'https://api.shop.example/users/me'),
      ex('5', 'GET', 'https://elsewhere.example/orders/1'),
      ex('6', 'GET', 'https://api.shop.example/mine', 'rule_7'),
    ];
    expect(core.state()[0].seen).toEqual({
      notInCollection: [{ method: 'GET', path: '/orders/{id}', count: 2 }],
      noExample: [{ endpoint: 'POST {{baseUrl}}/auth/refresh', count: 1 }],
    });
  });
});

describe('REVIEW-15 #5, #7, #8', () => {
  it('an environment value used in a path is shown as {{name}}', async () => {
    files.put(`${ROOT}/api/dev.postman_environment.json`, JSON.stringify({ values: [{ key: 'baseUrl', value: 'https://api.shop.example' }, { key: 'botToken', value: 'users' }] }));
    await core.reload();
    const urls = core.endpoints('shop').map((e) => e.url);
    expect(urls).toContain('https://api.shop.example/{{botToken}}/me');
    expect(urls.filter((u) => u.includes('/users/'))).toEqual([]);
  });

  it('problem lines are one short line without bidi controls or URL credentials', async () => {
    links = [link({ id: 'shop', file: 'api/missing‮\nfile.json' })];
    await core.reload();
    for (const p of core.state()[0].problems) {
      expect(p.length).toBeLessThanOrEqual(300);
      expect(p).not.toMatch(/[\r\n\t‮]/);
    }
  });

  it('a host passed through without decryption is reported', async () => {
    passthrough = ['cdn.shop.example:443'];
    await core.reload();
    expect(core.state()[0].problems).toContain("Requests to cdn.shop.example are passed through without decryption (the app's own certificate or pinning), so this collection can't answer them.");
    expect(core.state()[0].problems.filter((p) => p.includes('api.shop.example are passed'))).toEqual([]);
  });

  it('copy-in never replaces an existing name, a dangling symlink included', async () => {
    class LinkFs extends FakeFs {
      async readdir(p: string) {
        const list = await super.readdir(p).catch(() => [] as { name: string; isDirectory(): boolean }[]);
        return p === `${ROOT}/${COLLECTIONS_DIR}` ? [...list, { name: 'shop.json', isDirectory: () => false }] : list;
      }
    }
    const lfs = new LinkFs();
    for (const [k, v] of files.files) lfs.files.set(k, v);
    for (const d of files.dirs) lfs.dirs.add(d);
    lfs.dirs.add(`${ROOT}/${COLLECTIONS_DIR}`);
    files = lfs;
    core = make();
    const r = await core.copyIn(read('shop.postman_collection.json'), 'shop.json', 'sanitised');
    expect(r.file).toBe(`${COLLECTIONS_DIR}/shop-2.json`);
  });
});

describe('REVIEW-15 #4: links into build folders', () => {
  it('a file under .dart_tool/ or build/ is refused (it would be missing for the team)', async () => {
    files.put(`${ROOT}/.dart_tool/flutter_intercept/exports/x.postman_collection.json`, read('shop.postman_collection.json'));
    await expect(core.addLink({ file: '.dart_tool/flutter_intercept/exports/x.postman_collection.json' })).rejects.toThrow("build folder that isn't committed");
    await expect(core.addLink({ file: 'api/shop.postman_collection.json', environment: 'build/env.json' })).rejects.toThrow("build folder that isn't committed");
    expect(saves).toEqual([]);
  });
});
