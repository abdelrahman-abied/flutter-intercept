// CONTRACTS §21.6: the `collections` key of the shared file (WP0).
import { describe, expect, it } from 'vitest';
import { parseCollectionLinks, relativePath, toFileLink } from '../../src/mocks/link';
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
