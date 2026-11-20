// CONTRACTS §21.6: the `collections` key of the shared file (WP0).
import { describe, expect, it } from 'vitest';
import { checkStoreAuth, isBrunoLinkFile, parseCollectionLinks, parseStoreLinks, relativePath, toFileLink, withStoreEntry } from '../../src/mocks/link';
import { parseSharedFile, serializeSharedFile } from '../../src/rules/file';
import type { Rule } from '@flutter-intercept/proxy';

const L = '.vscode/flutter-intercept.json';
const validateRule = (raw: unknown) => raw as Rule;

describe('relativePath', () => {
  it('accepts workspace-relative paths and normalises them', () => {
    expect(relativePath('api/shop.json')).toBe('api/shop.json');
    expect(relativePath('./api//shop.json')).toBe('api/shop.json');
    expect(relativePath('api\\shop.json')).toBe('api/shop.json');
  });
  it('refuses absolute, home, parent and empty paths', () => {
    for (const p of ['/etc/passwd', 'C:/x.json', 'c:x', '~/x.json', '../x.json', 'api/../../x.json', '', '  ', 'a\0b', 42, undefined]) {
      expect(relativePath(p), String(p)).toBeUndefined();
    }
  });
});

describe('parseCollectionLinks', () => {
  it('no key → nothing, no problem', () => {
    expect(parseCollectionLinks({ version: 1, rules: [] }, L)).toEqual({ links: [], problems: [] });
  });

  it('fills defaults', () => {
    const { links, problems } = parseCollectionLinks({ collections: [{ id: 'shop-api', file: 'api/shop.json' }] }, L);
    expect(problems).toEqual([]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ id: 'shop-api', file: 'api/shop.json', enabled: true, unmatched: 'passthrough', off: [] });
    expect(Object.keys(links[0].variables)).toEqual([]);
    expect(links[0].environment).toBeUndefined();
  });

  it('reads every field', () => {
    const { links, problems } = parseCollectionLinks(
      {
        collections: [
          {
            id: 'shop',
            file: 'api/shop.postman_collection.json',
            environment: 'api/dev.postman_environment.json',
            variables: { baseUrl: 'https://api.shop.example' },
            enabled: false,
            unmatched: 'fail',
            selected: { 'POST {{baseUrl}}/login': 'Wrong password' },
            off: ['GET {{baseUrl}}/health', 'GET {{baseUrl}}/health'],
          },
        ],
      },
      L,
    );
    expect(problems).toEqual([]);
    expect(links[0]).toMatchObject({
      environment: 'api/dev.postman_environment.json',
      enabled: false,
      unmatched: 'fail',
      variables: { baseUrl: 'https://api.shop.example' },
      selected: { 'POST {{baseUrl}}/login': 'Wrong password' },
      off: ['GET {{baseUrl}}/health'],
    });
  });

  it('skips invalid entries with a readable problem and keeps the rest', () => {
    const { links, problems } = parseCollectionLinks(
      {
        collections: [
          'x',
          { id: 'Bad Id', file: 'a.json' },
          { id: 'outside', file: '../a.json' },
          { id: 'env', file: 'a.json', environment: '/abs.json' },
          { id: 'flag', file: 'a.json', enabled: 'yes' },
          { id: 'mode', file: 'a.json', unmatched: 'block' },
          { id: 'vars', file: 'a.json', variables: { 'bad name': 'x' } },
          { id: 'vals', file: 'a.json', variables: { baseUrl: 42 } },
          { id: 'sel', file: 'a.json', selected: { k: 1 } },
          { id: 'off', file: 'a.json', off: 'all' },
          { id: 'ok', file: 'a.json' },
          { id: 'ok', file: 'b.json' },
        ],
      },
      L,
      (i) => i + 3,
    );
    expect(links.map((l) => l.id)).toEqual(['ok']);
    expect(problems).toHaveLength(11);
    expect(problems[0]).toBe(`${L} line 3: collection 1: must be an object (skipped)`);
    expect(problems[2]).toContain('"file" must be a path inside the workspace');
    expect(problems[10]).toContain('duplicate id');
    for (const p of problems) expect(p).toMatch(/\(skipped\)$/);
  });

  it('not an array → one problem', () => {
    expect(parseCollectionLinks({ collections: {} }, L)).toEqual({ links: [], problems: [`${L}: "collections" must be an array (ignored)`] });
  });

  it('caps the number of links', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ id: `c${i}`, file: `c${i}.json` }));
    const { links, problems } = parseCollectionLinks({ collections: many }, L);
    expect(links).toHaveLength(20);
    expect(problems).toEqual([`${L}: at most 20 collections; the rest are skipped`]);
  });

  it('keeps prototype keys as data', () => {
    const json = JSON.parse('{"collections":[{"id":"p","file":"a.json","variables":{"__proto__":"x","constructor":"y"},"selected":{"__proto__":"z"}}]}');
    const { links, problems } = parseCollectionLinks(json, L);
    expect(problems).toEqual([]);
    expect(links[0].variables['__proto__']).toBe('x');
    expect(links[0].variables['constructor']).toBe('y');
    expect(links[0].selected['__proto__']).toBe('z');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    const written = JSON.stringify(toFileLink(links[0]));
    expect(JSON.parse(written).variables).toEqual(JSON.parse('{"__proto__":"x","constructor":"y"}'));
  });
});

describe('toFileLink', () => {
  it('leaves defaults out and keeps a stable order', () => {
    const { links } = parseCollectionLinks({ collections: [{ off: [], unmatched: 'passthrough', file: 'a.json', id: 'a', enabled: true }] }, L);
    expect(toFileLink(links[0])).toEqual({ id: 'a', file: 'a.json' });
    const full = parseCollectionLinks(
      { collections: [{ unmatched: 'fail', enabled: false, id: 'b', file: 'b.json', environment: 'e.json', variables: { v: '1' }, selected: { k: 'n' }, off: ['k2'] }] },
      L,
    ).links[0];
    expect(Object.keys(toFileLink(full))).toEqual(['id', 'file', 'environment', 'variables', 'enabled', 'unmatched', 'selected', 'off']);
  });

  it('round-trips through parse', () => {
    const src = { id: 'a', file: 'a.json', environment: 'e.json', variables: { baseUrl: 'https://x' }, enabled: false, unmatched: 'fail', selected: { k: 'n' }, off: ['k2'] };
    const once = parseCollectionLinks({ collections: [src] }, L).links[0];
    const twice = parseCollectionLinks({ collections: [toFileLink(once)] }, L).links[0];
    expect(twice).toEqual(once);
  });
});

describe('serializeSharedFile with collections', () => {
  const text = '{\n    "version": 1,\n    "collections": [{ "id": "old", "file": "old.json" }],\n    "rules": [],\n    "team": "x"\n}\n';
  const prev = parseSharedFile(text, { label: L, folderKey: '', validateRule });
  if (!prev.ok) throw new Error(prev.problem);

  it('keeps the key when writing rules only (as 0.14 did)', () => {
    const out = JSON.parse(serializeSharedFile([], prev));
    expect(out.collections).toEqual([{ id: 'old', file: 'old.json' }]);
    expect(Object.keys(out)).toEqual(['version', 'collections', 'rules', 'team']);
  });

  it('replaces it in place, keeping order and indentation', () => {
    const s = serializeSharedFile([], prev, [{ id: 'new', file: 'n.json' }]);
    expect(Object.keys(JSON.parse(s))).toEqual(['version', 'collections', 'rules', 'team']);
    expect(JSON.parse(s).collections).toEqual([{ id: 'new', file: 'n.json' }]);
    expect(s).toContain('\n    "collections"');
  });

  it('an empty list removes it', () => {
    expect(JSON.parse(serializeSharedFile([], prev, [])).collections).toBeUndefined();
  });

  it('adds it after rules in a new file', () => {
    const s = serializeSharedFile([], undefined, [{ id: 'a', file: 'a.json' }]);
    expect(Object.keys(JSON.parse(s))).toEqual(['version', 'rules', 'collections']);
    expect(Object.keys(JSON.parse(serializeSharedFile([], undefined)))).toEqual(['version', 'rules']);
  });
});

// CONTRACTS §24.1 / §24.3 / §24.4 (part 3)
describe('part 3: environment by name, stores[].auth and stores[].dynamic', () => {
  it('a Bruno link is known by its file name and takes an environment name; other formats a path or a path-shaped name', () => {
    expect(isBrunoLinkFile('api/shop/bruno.json')).toBe(true);
    expect(isBrunoLinkFile('bruno.json')).toBe(true);
    expect(isBrunoLinkFile('api\\shop\\Bruno.JSON')).toBe(true);
    expect(isBrunoLinkFile('api/shop/my-bruno.json')).toBe(false);
    const { links, problems } = parseCollectionLinks(
      {
        collections: [
          { id: 'b1', file: 'api/shop/bruno.json', environment: 'Staging / EU' },
          { id: 'b2', file: 'api/shop2/bruno.json', environment: 'x'.repeat(101) },
          { id: 'b3', file: 'api/shop3/bruno.json', environment: 'two\nlines' },
          { id: 'i1', file: 'api/insomnia.yaml', environment: 'Staging EU' },
          { id: 'p1', file: 'api/shop.json', environment: 'api/dev.postman_environment.json' },
          { id: 'p2', file: 'api/shop2.json', environment: '../dev.json' },
        ],
      },
      L,
    );
    expect(links.map((l) => [l.id, l.environment])).toEqual([
      ['b1', 'Staging / EU'],
      ['i1', 'Staging EU'],
      ['p1', 'api/dev.postman_environment.json'],
    ]);
    expect(problems).toHaveLength(3);
    for (const p of problems) expect(p).toMatch(/"environment" must be a path inside the workspace \(Postman\) or an environment name \(Insomnia, Bruno\) \(skipped\)$/);
    expect(toFileLink(links[0])).toEqual({ id: 'b1', file: 'api/shop/bruno.json', environment: 'Staging / EU' });
  });

  it('parseStoreLinks reads auth and dynamic; an invalid one skips the entry with a line (never guessed)', () => {
    const { stores, problems } = parseStoreLinks(
      {
        stores: [
          { collection: 'a', auth: { enabled: true, ttlSeconds: 60, protect: 'all', login: 'POST {{baseUrl}}/login', refresh: 'POST {{baseUrl}}/refresh' }, dynamic: 'seeded' },
          { collection: 'b', auth: {} },
          { collection: 'c', auth: { ttlSeconds: 59 } },
          { collection: 'd', auth: { ttlSeconds: 86401 } },
          { collection: 'e', auth: { protect: 'none' } },
          { collection: 'f', auth: { password: 'hunter2' } },
          { collection: 'g', auth: { login: 7 } },
          { collection: 'h', dynamic: 'chaos' },
          { collection: 'i', auth: { enabled: 'yes' } },
          { collection: 'j', auth: { ttlSeconds: 86400, enabled: false } },
        ],
      },
      L,
    );
    expect(stores).toEqual([
      { collection: 'a', auth: { enabled: true, ttlSeconds: 60, protect: 'all', login: 'POST {{baseUrl}}/login', refresh: 'POST {{baseUrl}}/refresh' }, dynamic: 'seeded' },
      { collection: 'b' },
      { collection: 'j', auth: { ttlSeconds: 86400, enabled: false } },
    ]);
    expect(problems).toHaveLength(7);
    expect(problems.join('\n')).toMatch(/stores entry 6 "f": "auth": unknown field "password" \(a password or token is never stored here\) \(skipped\)/);
    expect(problems.join('\n')).not.toContain('hunter2');
    expect(checkStoreAuth({ ttlSeconds: 90.5 }).problem).toMatch(/whole number 60–86400/);
  });

  it('withStoreEntry writes auth and dynamic without defaults, keeps the rest, and drops an entry that holds nothing', () => {
    const raw = [{ collection: 'other', auth: { enabled: true }, note: 'kept' }, { collection: 'shop', resources: { users: { off: true } }, custom: 1, auth: { enabled: true }, dynamic: 'fixed' }];
    const next = withStoreEntry(raw, 'shop', { collection: 'shop', resources: { users: { off: true } }, auth: { enabled: true, ttlSeconds: 3600, protect: 'all' }, dynamic: 'seeded' });
    expect(next).toEqual([raw[0], { collection: 'shop', custom: 1, resources: { users: { off: true } }, auth: { enabled: true, protect: 'all' }, dynamic: 'seeded' }]);
    // off, default ttl, no mode → the keys go
    expect(withStoreEntry(raw, 'shop', { collection: 'shop', auth: { enabled: false, ttlSeconds: 3600 } })).toEqual([raw[0], { collection: 'shop', custom: 1 }]);
    expect(withStoreEntry([{ collection: 'shop', auth: { enabled: true } }], 'shop', { collection: 'shop', auth: { enabled: false } })).toEqual([]);
    expect(withStoreEntry(undefined, 'shop', { collection: 'shop', auth: { ttlSeconds: 120 } })).toEqual([{ collection: 'shop', auth: { ttlSeconds: 120 } }]);
    // round trip through the parser
    expect(parseStoreLinks({ stores: next }, L).stores[1]).toEqual({ collection: 'shop', resources: { users: { off: true } }, auth: { enabled: true, protect: 'all' }, dynamic: 'seeded' });
  });
});
