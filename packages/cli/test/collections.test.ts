// CONTRACTS §21.11: CLI collections loader (shared-file collections, --no-rules, --collection, --collection-env,
// --collection-var, --collection-unmatched, unresolved variable usage errors, OpenAPI YAML/JSON).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCollections } from '../src/collections';
import { loadRules } from '../src/rules';

const FIXTURES = path.resolve(__dirname, '..', '..', 'extension', 'test', 'fixtures', 'collections');
const SHOP_COLLECTION = path.join(FIXTURES, 'shop.postman_collection.json');
const SHOP_ENV = path.join(FIXTURES, 'shop.postman_environment.json');
const SHOP_OPENAPI_YAML = path.join(FIXTURES, 'shop.openapi.yaml');

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-cli-col-')));
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(rel: string, data: unknown) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}

describe('loadCollections', () => {
  it('loads collections linked in the shared rules file, and --no-rules turns both off', async () => {
    fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
    fs.copyFileSync(SHOP_COLLECTION, path.join(dir, 'api', 'shop.postman_collection.json'));
    fs.copyFileSync(SHOP_ENV, path.join(dir, 'api', 'shop.postman_environment.json'));
    write('.vscode/flutter-intercept.json', {
      version: 1,
      rules: [{ id: 'r1', name: 'Shared mock', match: { url: 'https://api.shop.example/custom' }, action: { kind: 'mock', status: 200, body: '{}' } }],
      collections: [
        { id: 'shop-api', file: 'api/shop.postman_collection.json', environment: 'api/shop.postman_environment.json' },
        { id: 'disabled-api', file: 'api/shop.postman_collection.json', enabled: false },
      ],
    });

    const loaded = await loadRules({ approve: false, projectRoot: dir, cwd: dir });
    expect(loaded.collectionLinks).toHaveLength(1);
    const cols = await loadCollections({ sharedLinks: loaded.collectionLinks, cwd: dir });
    expect(cols.collections).toHaveLength(1);
    expect(cols.collections[0]).toMatchObject({ id: 'shop-api', name: 'Shop API', unmatched: 'passthrough' });
    expect(cols.collections[0].mocked).toBeGreaterThan(0);
    expect(cols.collections[0].noExample).toBeGreaterThan(0);
    expect(cols.collections[0].unresolved).toEqual(['analyticsHost']);
    expect(cols.rules.length).toBeGreaterThan(0);
    // Environment secrets never appear in problems or summaries.
    expect(JSON.stringify(cols)).not.toContain('env-token-must-never-leave-the-host');

    // --no-rules turns off both shared rules and shared-file collections.
    const off = await loadRules({ rules: false, approve: false, projectRoot: dir, cwd: dir });
    expect(off.collectionLinks).toBeUndefined();
    const offCols = await loadCollections({ sharedLinks: off.collectionLinks, cwd: dir });
    expect(offCols.rules).toEqual([]);
    expect(offCols.collections).toEqual([]);
  });

  it('merges variables in priority order: --collection-var → link → --collection-env → link env → collection', async () => {
    const cols = await loadCollections({
      files: [SHOP_COLLECTION],
      envFile: SHOP_ENV,
      vars: { baseUrl: 'https://override.shop.example', analyticsHost: 'https://stats.shop.example' },
      cwd: dir,
    });
    expect(cols.collections[0].unresolved).toEqual([]);
    const urls = cols.rules.map((r) => r.match.url);
    expect(urls.some((u) => u.includes('override\\.shop\\.example'))).toBe(true);
    expect(urls.some((u) => u.includes('stats\\.shop\\.example'))).toBe(true);
    expect(urls.some((u) => u.includes('api\\.shop\\.example'))).toBe(false);
  });

  it('rejects unresolved variables when unmatched is fail (CONTRACTS §21.11)', async () => {
    // analyticsHost is disabled in shop.postman_environment.json → unresolved.
    await expect(
      loadCollections({ files: [SHOP_COLLECTION], envFile: SHOP_ENV, unmatched: 'fail', cwd: dir }),
    ).rejects.toThrow(/unresolved URL variable\(s\).*\{\{analyticsHost\}\}.*unmatched=fail/);

    // Once all variables are resolved, unmatched=fail succeeds and appends block-reset rules.
    const ok = await loadCollections({
      files: [SHOP_COLLECTION],
      envFile: SHOP_ENV,
      vars: { analyticsHost: 'https://stats.shop.example' },
      unmatched: 'fail',
      cwd: dir,
    });
    expect(ok.collections[0].unmatched).toBe('fail');
    expect(ok.rules.some((r) => r.action.kind === 'block' && r.action.mode === 'reset')).toBe(true);
  });

  it('supports OpenAPI YAML documents and reports missing or invalid CLI files', async () => {
    const yamlCols = await loadCollections({ files: [SHOP_OPENAPI_YAML], cwd: dir });
    expect(yamlCols.collections).toHaveLength(1);
    expect(yamlCols.rules.length).toBeGreaterThan(0);

    await expect(loadCollections({ files: ['missing.json'], cwd: dir })).rejects.toThrow(/collection file missing\.json not found/);
    await expect(loadCollections({ files: [SHOP_COLLECTION], envFile: 'missing-env.json', cwd: dir })).rejects.toThrow(/environment file missing-env\.json not found/);
    const bad = write('bad.json', '{ not json');
    await expect(loadCollections({ files: [bad], cwd: dir })).rejects.toThrow(/not valid JSON/);
    const notCol = write('other.json', '{"hello":"world"}');
    await expect(loadCollections({ files: [notCol], cwd: dir })).rejects.toThrow(/Postman Collection.*OpenAPI 3/i);
  });

  it('treats prototype keys (__proto__, constructor) as data without polluting Object.prototype', async () => {
    const vars: Record<string, string> = {};
    Object.defineProperty(vars, '__proto__', { value: 'https://proto.example', enumerable: true });
    Object.defineProperty(vars, 'constructor', { value: 'https://ctor.example', enumerable: true });
    const cols = await loadCollections({ files: [SHOP_COLLECTION], envFile: SHOP_ENV, vars, cwd: dir });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(cols.collections[0].name).toBe('Shop API');
  });
});
