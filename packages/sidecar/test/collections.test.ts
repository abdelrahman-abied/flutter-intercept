// CONTRACTS §21.6, §21.7, §21.8, §21.10, §21.11: collections in the sidecar (core wiring, IDE requests,
// exact-path file watching, controller + agent API integration, panel never receives an outside/absolute path).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectionParsers } from '../../extension/src/mocks/parsers';
import { validateRule } from '../../extension/src/ui/controller';
import type { HostMsg, ViewMsg } from '../../extension/src/ui/protocol';
import {
  CLIPBOARD_METHOD,
  COLLECTION_CHOOSER_BUSY,
  COLLECTION_COPY_METHOD,
  COLLECTION_ENV_METHOD,
  COLLECTION_FILE_METHOD,
  COLLECTION_REMOVE_METHOD,
  COLLECTION_VAR_METHOD,
  CONFIRM_METHOD,
  COPY_EXAMPLE_BUTTON,
  createSidecarCollections,
  DIFF_METHOD,
  FALLBACK_FAIL_BUTTON,
  FALLBACK_PASSTHROUGH_BUTTON,
  FROM_TRAFFIC_BUSY,
  OPEN_FILE_METHOD,
  PICK_MANY_METHOD,
  SNAPSHOT_NAME_METHOD,
  UPDATE_EXAMPLE_BUTTON,
  usableCollectionPath,
  usableSnapshotName,
  usableVariableUrl,
  type SidecarCollectionsDeps,
} from '../src/collections';
import { SnapshotCancelled } from '../../extension/src/mocks/core';
import type { Exchange, RequestHandler, Rule } from '@flutter-intercept/proxy';
import { SidecarHost, type PluginLink } from '../src/host';
import { RpcFailure } from '../src/rpc';
import { createNodeSharedRules } from '../src/sharedRules';
import { JsonStateStore } from '../src/state';

const FIXTURES = path.resolve(__dirname, '..', '..', 'extension', 'test', 'fixtures', 'collections');
const SHOP_COLLECTION = path.join(FIXTURES, 'shop.postman_collection.json');
const SHOP_ENV = path.join(FIXTURES, 'shop.postman_environment.json');
const SHOP_SWAGGER2 = path.join(FIXTURES, 'shop.swagger2.json');
const SHOP_INSOMNIA_V4 = path.join(FIXTURES, 'shop.insomnia-v4.json');
const SHOP_INSOMNIA_V5 = path.join(FIXTURES, 'shop.insomnia-v5.yaml');
const SHOP_BRUNO_DIR = path.join(FIXTURES, 'shop-bruno');

interface FakeIde {
  requests: { method: string; params: unknown }[];
  notifications: { level: string; message: string }[];
  answers: Record<string, (params: any) => unknown>;
  request(method: string, params: unknown): Promise<unknown>;
  notify(level: 'info' | 'warning' | 'error', message: string): Promise<void>;
}

function fakeIde(answers: Record<string, (params: any) => unknown> = {}): FakeIde {
  const ide: FakeIde = {
    requests: [],
    notifications: [],
    answers: { ...answers },
    async request(method, params) {
      ide.requests.push({ method, params });
      const handler = ide.answers[method];
      if (!handler) throw new RpcFailure(`unknown method ${method}`, 'unknown_method');
      return handler(params);
    },
    async notify(level, message) {
      ide.notifications.push({ level, message });
    },
  };
  return ide;
}

function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(check, 25);
    };
    check();
  });
}

describe('sidecar collections service', () => {
  let tmp: string;
  let project: string;
  let outside: string;
  let dataDir: string;
  const disposers: (() => void)[] = [];

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-sidecar-col-')));
    project = path.join(tmp, 'app');
    outside = path.join(tmp, 'secret-downloads-dir');
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(project, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.writeFileSync(path.join(project, 'lib', 'main.dart'), 'void main() {}\n');
  });

  afterEach(() => {
    for (const d of disposers.splice(0).reverse()) d();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setup(ide: FakeIde, seenOrigins: () => string[] = () => ['https://api.shop.example'], extra: Partial<SidecarCollectionsDeps> = {}) {
    const state = new JsonStateStore(dataDir);
    const shared = createNodeSharedRules({
      roots: () => [project],
      memento: state,
      validateRule,
      debounceMs: 30,
      pollMs: 80,
    });
    const collections = createSidecarCollections({
      shared,
      roots: () => [project],
      memento: state,
      parsers: collectionParsers,
      newRuleId: () => 'rule_copy_1',
      request: (m, p) => ide.request(m, p),
      notify: (level, message) => ide.notify(level, message),
      seenOrigins,
      debounceMs: 30,
      ...extra,
    });
    disposers.push(() => {
      collections.dispose();
      shared.dispose();
    });
    return { state, shared, collections };
  }

  it('loads linked collections from the shared file, builds rules and isolates personal enabled overrides', async () => {
    fs.mkdirSync(path.join(project, 'api'), { recursive: true });
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    fs.copyFileSync(SHOP_COLLECTION, path.join(project, 'api', 'shop.postman_collection.json'));
    fs.copyFileSync(SHOP_ENV, path.join(project, 'api', 'shop.postman_environment.json'));
    fs.writeFileSync(
      path.join(project, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({
        version: 1,
        rules: [{ id: 'r1', name: 'Existing rule', match: { url: 'https://api.shop.example/health' }, action: { kind: 'mock', status: 200, body: 'shared' } }],
        collections: [{ id: 'shop-api', file: 'api/shop.postman_collection.json', environment: 'api/shop.postman_environment.json' }],
      }),
    );

    const ide = fakeIde();
    const { collections } = setup(ide);
    await collections.ready;

    const status = collections.state();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ id: 'shop-api', name: 'Shop API', format: 'postman', enabled: true, unmatched: 'passthrough' });
    expect(status[0].mocked).toBeGreaterThan(0);
    expect(status[0].noExample).toBeGreaterThan(0);
    expect(status[0].origins).toContain('https://api.shop.example');
    expect(JSON.stringify(status)).not.toContain('env-token-must-never-leave-the-host');
    expect(collections.rules().length).toBeGreaterThan(0);

    // Personal enabled override changes rules without touching the shared file.
    const beforeFile = fs.readFileSync(path.join(project, '.vscode', 'flutter-intercept.json'), 'utf8');
    await collections.update('shop-api', { enabled: false });
    expect(collections.rules()).toEqual([]);
    expect(collections.state()[0].enabled).toBe(false);
    expect(fs.readFileSync(path.join(project, '.vscode', 'flutter-intercept.json'), 'utf8')).toBe(beforeFile);

    // CONTRACTS §21.15: unmatched is "for me" by default; scope "team" persists to the shared file, rules intact.
    await collections.update('shop-api', { unmatched: 'fail' });
    expect(fs.readFileSync(path.join(project, '.vscode', 'flutter-intercept.json'), 'utf8')).toBe(beforeFile);
    expect(collections.state()[0].unmatched).toBe('fail');
    await collections.update('shop-api', { unmatched: 'fail', scope: 'team' });
    const afterFile = JSON.parse(fs.readFileSync(path.join(project, '.vscode', 'flutter-intercept.json'), 'utf8'));
    expect(afterFile.rules).toHaveLength(1);
    expect(afterFile.collections[0].unmatched).toBe('fail');
  });

  it('importInteractive: inside-project file links in place, asks unset URL variables with seen origins', async () => {
    fs.mkdirSync(path.join(project, 'api'), { recursive: true });
    const colPath = path.join(project, 'api', 'shop.postman_collection.json');
    fs.copyFileSync(SHOP_COLLECTION, colPath);

    const ide = fakeIde({
      [COLLECTION_FILE_METHOD]: () => colPath,
      [COLLECTION_VAR_METHOD]: (p) => (p.name === 'baseUrl' ? 'https://api.shop.example' : null),
    });
    const { collections } = setup(ide, () => ['https://api.shop.example', 'https://staging.shop.example']);
    const imported = await collections.importInteractive();

    expect(imported).toEqual({ id: 'shop-api' });
    expect(ide.requests.map((r) => r.method)).toEqual([COLLECTION_FILE_METHOD, COLLECTION_VAR_METHOD, COLLECTION_VAR_METHOD]);
    expect(ide.requests[0].params).toEqual({ defaultDir: project });
    expect(ide.requests[1].params).toEqual({ name: 'baseUrl', origins: ['https://api.shop.example', 'https://staging.shop.example'] });
    expect(ide.requests[2].params).toEqual({ name: 'analyticsHost', origins: ['https://api.shop.example', 'https://staging.shop.example'] });
    expect(collections.state()[0].file).toBe('api/shop.postman_collection.json');
    expect(collections.state()[0].origins).toContain('https://api.shop.example');
    expect(ide.notifications.some((n) => n.level === 'info' && n.message.includes('Shop API'))).toBe(true);
  });

  it('importInteractive: outside-project file asks Copy without credentials / Copy as it is / Cancel, never sends full path', async () => {
    const extPath = path.join(outside, 'shop.postman_collection.json');
    fs.copyFileSync(SHOP_COLLECTION, extPath);

    // 1. Cancel copy → nothing written or linked.
    const cancelIde = fakeIde({
      [COLLECTION_FILE_METHOD]: () => extPath,
      [COLLECTION_COPY_METHOD]: () => null,
    });
    const { collections } = setup(cancelIde);
    expect(await collections.importInteractive()).toBeUndefined();
    expect(cancelIde.requests[1]).toEqual({ method: COLLECTION_COPY_METHOD, params: { fileName: 'shop.postman_collection.json' } });
    expect(collections.state()).toEqual([]);

    // 2. Copy without credentials → sanitised file written under .vscode/flutter-intercept/collections/.
    cancelIde.answers[COLLECTION_COPY_METHOD] = () => 'sanitised';
    cancelIde.answers[COLLECTION_VAR_METHOD] = () => null;
    const res = await collections.importInteractive();
    expect(res).toEqual({ id: 'shop-api' });
    const copiedRel = collections.state()[0].file;
    expect(copiedRel).toBe('.vscode/flutter-intercept/collections/shop.json');
    const copiedText = fs.readFileSync(path.join(project, copiedRel), 'utf8');
    expect(copiedText).not.toContain('collection-token-should-be-removed');
    expect(copiedText).not.toContain('live-key-123');
    expect(copiedText).not.toContain('hunter2');
    expect(JSON.stringify(collections.state())).not.toContain('secret-downloads-dir');

    // 3. Copy as-is (second file) keeps original text.
    const extPath2 = path.join(outside, 'shop-raw.postman_collection.json');
    fs.copyFileSync(SHOP_COLLECTION, extPath2);
    cancelIde.answers[COLLECTION_FILE_METHOD] = () => extPath2;
    cancelIde.answers[COLLECTION_COPY_METHOD] = () => 'as-is';
    const res2 = await collections.importInteractive();
    expect(res2?.id).toBe('shop-api-2');
    const copiedRaw = fs.readFileSync(path.join(project, collections.state()[1].file), 'utf8');
    expect(copiedRaw).toContain('live-key-123');
  });

  it('importInteractive: validates chooser responses, enforces one chooser at a time, reports old plugin clearly', async () => {
    let release!: (v: unknown) => void;
    const ide = fakeIde({
      [COLLECTION_FILE_METHOD]: () => new Promise((r) => (release = r)),
    });
    const { collections } = setup(ide);
    const first = collections.importInteractive();
    await waitFor(() => ide.requests.length === 1);
    expect(await collections.importInteractive()).toBeUndefined();
    expect(ide.notifications.at(-1)).toEqual({ level: 'warning', message: COLLECTION_CHOOSER_BUSY });
    release(null);
    expect(await first).toBeUndefined();

    // Relative path refused.
    ide.answers[COLLECTION_FILE_METHOD] = () => 'relative/shop.json';
    expect(await collections.importInteractive()).toBeUndefined();
    expect(ide.notifications.at(-1)?.message).toMatch(/choose a file on this computer/);

    // Old plugin without ui.chooseCollectionFile reports update notice.
    delete ide.answers[COLLECTION_FILE_METHOD];
    expect(await collections.importInteractive()).toBeUndefined();
    expect(ide.notifications.at(-1)?.message).toMatch(/update Flutter Intercept/);
  });

  it('removeWithConfirmation: only true removes the link and keeps the collection file on disk', async () => {
    fs.mkdirSync(path.join(project, 'api'), { recursive: true });
    const colPath = path.join(project, 'api', 'shop.postman_collection.json');
    fs.copyFileSync(SHOP_COLLECTION, colPath);

    const ide = fakeIde({ [COLLECTION_REMOVE_METHOD]: () => 'Remove' }); // truthy string must NOT remove
    const { collections } = setup(ide);
    await collections.ready;
    await collections.importFile({ file: 'api/shop.postman_collection.json' });

    expect(await collections.removeWithConfirmation('shop-api')).toBe(false);
    expect(collections.state()).toHaveLength(1);
    expect(ide.requests.at(-1)).toEqual({
      method: COLLECTION_REMOVE_METHOD,
      params: { name: 'Shop API', file: 'api/shop.postman_collection.json' },
    });

    ide.answers[COLLECTION_REMOVE_METHOD] = () => true;
    expect(await collections.removeWithConfirmation('shop-api')).toBe(true);
    expect(collections.state()).toEqual([]);
    expect(fs.existsSync(colPath)).toBe(true); // file is never deleted

    // Old plugin error on remove.
    await collections.importFile({ file: 'api/shop.postman_collection.json' });
    delete ide.answers[COLLECTION_REMOVE_METHOD];
    await expect(collections.removeWithConfirmation('shop-api')).rejects.toThrow(/update Flutter Intercept/);
  });

  it('reloads when the shared file links change and when the collection or environment file changes on disk', async () => {
    fs.mkdirSync(path.join(project, 'api'), { recursive: true });
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    const colPath = path.join(project, 'api', 'shop.postman_collection.json');
    const envPath = path.join(project, 'api', 'shop.postman_environment.json');
    fs.copyFileSync(SHOP_COLLECTION, colPath);
    fs.copyFileSync(SHOP_ENV, envPath);

    const ide = fakeIde();
    const { collections } = setup(ide);
    await collections.ready;
    let changes = 0;
    collections.onDidChange(() => changes++);
    expect(collections.state()).toEqual([]);

    // 1. Shared file gains a collection link → reloads automatically.
    fs.writeFileSync(
      path.join(project, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({
        version: 1,
        rules: [],
        collections: [{ id: 'shop-api', file: 'api/shop.postman_collection.json', environment: 'api/shop.postman_environment.json' }],
      }),
    );
    await waitFor(() => collections.state().length === 1);
    expect(collections.state()[0].name).toBe('Shop API');

    // 2. Collection file edited on disk → exact-path watcher reloads it.
    const doc = JSON.parse(fs.readFileSync(colPath, 'utf8'));
    doc.info.name = 'Shop API v2';
    fs.writeFileSync(colPath, JSON.stringify(doc, null, 2));
    await waitFor(() => collections.state()[0]?.name === 'Shop API v2');

    // 3. Environment file edited on disk → exact-path watcher reloads resolved origins.
    const envDoc = JSON.parse(fs.readFileSync(envPath, 'utf8'));
    envDoc.values[0].value = 'https://staging.shop.example';
    fs.writeFileSync(envPath, JSON.stringify(envDoc, null, 2));
    await waitFor(() => collections.state()[0]?.origins.includes('https://staging.shop.example'));
    expect(changes).toBeGreaterThanOrEqual(3);
  });

  it('stateful mocks (CONTRACTS §22.9): one handler per collection, data changes, snapshots named through ui.input, dropped when the proxy stops', async () => {
    const todo = {
      openapi: '3.0.3',
      info: { title: 'Todo API', version: '1' },
      servers: [{ url: 'https://api.todo.example' }],
      paths: {
        '/todos': {
          get: { responses: { 200: { description: 'ok', content: { 'application/json': { example: [{ id: 1, title: 'Buy milk' }] } } } } },
          post: { responses: { 201: { description: 'created', content: { 'application/json': { example: { id: 9, title: 'x' } } } } } },
        },
        '/todos/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          get: { responses: { 200: { description: 'ok', content: { 'application/json': { example: { id: 1, title: 'Buy milk' } } } } } },
          delete: { responses: { 204: { description: 'gone' } } },
        },
      },
    };
    fs.mkdirSync(path.join(project, 'api'), { recursive: true });
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(project, 'api', 'todo.openapi.json'), JSON.stringify(todo));
    fs.writeFileSync(path.join(project, '.vscode', 'flutter-intercept.json'), JSON.stringify({ version: 1, collections: [{ id: 'todo', file: 'api/todo.openapi.json' }] }));

    const handlers = new Map<string, RequestHandler>();
    let stopProxy = () => undefined as void;
    const ide = fakeIde();
    const { collections } = setup(ide, undefined, {
      setHandler: (id, fn) => void (fn ? handlers.set(id, fn) : handlers.delete(id)),
      onProxyStopped: (l) => {
        stopProxy = l;
        return { dispose: () => undefined };
      },
    });
    await collections.ready;
    expect([...handlers.keys()]).toEqual(['collection:todo']);
    expect(collections.storeStatus('todo')?.resources.map((r) => [r.name, r.count])).toEqual([['todos', 1]]);
    const create = collections.rules().find((r: Rule) => r.action.kind === 'handler' && r.match.method === 'POST')!;
    expect(create).toBeDefined();

    const changes: [string, string | undefined][] = [];
    collections.onDidChangeStore((id, resource) => changes.push([id, resource]));
    const answer = await handlers.get('collection:todo')!(
      { exchangeId: 'e1', ruleId: create.id, method: 'POST', url: 'https://api.todo.example/todos', headers: { 'content-type': 'application/json' }, body: { text: '{"title":"Walk"}', encoding: 'utf8' } },
      new AbortController().signal,
    );
    expect(answer).toMatchObject({ status: 201 });
    expect(collections.storeItems('todo', 'todos').total).toBe(2);
    expect(changes).toContainEqual(['todo', 'todos']);

    // Save without a name → the IDE's generic input box; the file lands in the snapshots folder of the collection.
    ide.answers[SNAPSHOT_NAME_METHOD] = () => ' checkout ';
    const saved = await collections.storeSnapshot('todo', 'save');
    expect(saved).toMatchObject({ path: '.vscode/flutter-intercept/snapshots/todo/checkout.json', resources: 1, records: 2 });
    const asked = ide.requests.find((r) => r.method === SNAPSHOT_NAME_METHOD)!.params as { prompt: string };
    expect(asked.prompt).toContain('.vscode/flutter-intercept/snapshots/todo/<name>.json');
    expect(JSON.parse(fs.readFileSync(path.join(project, '.vscode', 'flutter-intercept', 'snapshots', 'todo', 'checkout.json'), 'utf8')).resources.todos[0].records).toHaveLength(2);
    expect(collections.storeStatus('todo')?.snapshots).toEqual(['checkout']);

    ide.answers[SNAPSHOT_NAME_METHOD] = () => null;
    await expect(collections.storeSnapshot('todo', 'save')).rejects.toBeInstanceOf(SnapshotCancelled);
    ide.answers[SNAPSHOT_NAME_METHOD] = () => 'Bad Name';
    await expect(collections.storeSnapshot('todo', 'save')).rejects.toThrow(/lower-case letters/);
    await expect(collections.storeSnapshot('todo', 'load')).rejects.toThrow(/Choose a snapshot/);

    // Reset the data, then load the snapshot back.
    await collections.updateStore('todo', { reset: 'data' });
    expect(collections.storeItems('todo', 'todos').total).toBe(1);
    await collections.storeSnapshot('todo', 'load', 'checkout');
    expect(collections.storeItems('todo', 'todos').total).toBe(2);

    // The data lives as long as the proxy: a stop drops it (back to the seed when it starts again).
    stopProxy();
    await waitFor(() => collections.storeItems('todo', 'todos').total === 1);

    await collections.storeSnapshot('todo', 'delete', 'checkout');
    expect(fs.existsSync(path.join(project, '.vscode', 'flutter-intercept', 'snapshots', 'todo', 'checkout.json'))).toBe(false);
  });

  it('usableSnapshotName accepts only snapshot names', () => {
    expect(usableSnapshotName(' checkout-2 ')).toBe('checkout-2');
    for (const bad of ['', 'Checkout', 'a/b', '../x', 'x'.repeat(41), 7, null]) expect(usableSnapshotName(bad)).toBeUndefined();
  });

  it('usableCollectionPath and usableVariableUrl reject malformed inputs', () => {
    expect(usableCollectionPath('/tmp/shop.json')).toBe('/tmp/shop.json');
    for (const bad of [null, undefined, '', 7, 'relative.json', '/a\0b', '/a\nb', `/${'x'.repeat(4096)}`]) {
      expect(usableCollectionPath(bad)).toBeUndefined();
    }
    expect(usableVariableUrl(' https://api.example.com ')).toBe('https://api.example.com');
    expect(usableVariableUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
    for (const bad of [null, undefined, '', 'ftp://a.com', 'api.example.com', 'https://a\nb.com', `https://${'a'.repeat(2050)}.com`]) {
      expect(usableVariableUrl(bad)).toBeUndefined();
    }
  });

  it('refuses outside-project Swagger 2.0, Insomnia and Bruno files without prompting to copy (CONTRACTS §24.4)', async () => {
    const extSwagger = path.join(outside, 'shop.swagger2.json');
    const extInsomnia = path.join(outside, 'shop.insomnia-v4.json');
    const extInsomniaV5 = path.join(outside, 'shop.insomnia-v5.yaml');
    const extBrunoDir = path.join(outside, 'shop-bruno');
    fs.copyFileSync(SHOP_SWAGGER2, extSwagger);
    fs.copyFileSync(SHOP_INSOMNIA_V4, extInsomnia);
    fs.copyFileSync(SHOP_INSOMNIA_V5, extInsomniaV5);
    fs.cpSync(SHOP_BRUNO_DIR, extBrunoDir, { recursive: true });

    const ide = fakeIde({ [COLLECTION_COPY_METHOD]: () => 'as-is' });
    const { collections } = setup(ide);
    await collections.ready;

    for (const [file, pattern] of [
      [extSwagger, /Swagger 2\.0.*copy without credentials/i],
      [extInsomnia, /Insomnia.*copy without credentials/i],
      [extInsomniaV5, /Insomnia.*copy without credentials/i],
      [path.join(extBrunoDir, 'bruno.json'), /Bruno collection is a folder/i],
    ] as [string, RegExp][]) {
      ide.answers[COLLECTION_FILE_METHOD] = () => file;
      expect(await collections.importInteractive()).toBeUndefined();
      expect(ide.notifications.at(-1)?.level).toBe('error');
      expect(ide.notifications.at(-1)?.message).toMatch(pattern);
    }
    expect(ide.requests.some((r) => r.method === COLLECTION_COPY_METHOD)).toBe(false);
    expect(collections.state()).toEqual([]);
  });

  it('picks an environment by name via ui.pick for Insomnia and Bruno collections (CONTRACTS §24.4)', async () => {
    fs.mkdirSync(path.join(project, 'api'), { recursive: true });
    const insPath = path.join(project, 'api', 'shop.insomnia-v4.json');
    fs.copyFileSync(SHOP_INSOMNIA_V4, insPath);
    const brunoDir = path.join(project, 'api', 'shop-bruno');
    fs.cpSync(SHOP_BRUNO_DIR, brunoDir, { recursive: true });
    const brunoPath = path.join(brunoDir, 'bruno.json');

    // 1. Cancelled pick → nothing linked.
    const ide = fakeIde({
      [COLLECTION_FILE_METHOD]: () => insPath,
      [COLLECTION_ENV_METHOD]: () => null,
      [COLLECTION_VAR_METHOD]: () => null,
    });
    const { collections } = setup(ide);
    await collections.ready;
    expect(await collections.environmentsOf('api/shop.insomnia-v4.json')).toEqual(['Shop dev', 'Staging']);
    expect(await collections.environmentsOf('api/shop-bruno/bruno.json')).toEqual(['dev', 'staging']);
    expect(await collections.importInteractive()).toBeUndefined();
    expect(collections.state()).toEqual([]);

    // 2. Pick "Staging" on Insomnia → staging.shop.example resolved, values never shown in ui.pick.
    ide.answers[COLLECTION_ENV_METHOD] = (p: { items: { label: string; value: string }[] }) => p.items.find((i) => i.label === 'Staging')?.value ?? null;
    const insRes = await collections.importInteractive();
    expect(insRes).toEqual({ id: 'shop-api' });
    const pickCall = [...ide.requests].reverse().find((r) => r.method === COLLECTION_ENV_METHOD)!;
    expect(JSON.stringify(pickCall.params)).not.toContain('env-token-must-never-leave-the-host');
    expect(collections.state()[0]).toMatchObject({ id: 'shop-api', format: 'insomnia' });
    expect(collections.state()[0].origins).toContain('https://staging.shop.example');

    // 3. Pick "dev" on Bruno → api.shop.example resolved.
    ide.answers[COLLECTION_FILE_METHOD] = () => brunoPath;
    ide.answers[COLLECTION_ENV_METHOD] = (p: { items: { label: string; value: string }[] }) => p.items.find((i) => i.label === 'dev')?.value ?? null;
    const brunoRes = await collections.importInteractive();
    expect(brunoRes).toEqual({ id: 'shop-api-2' });
    expect(collections.state()[1]).toMatchObject({ id: 'shop-api-2', format: 'bruno' });
    expect(collections.state()[1].origins).toContain('https://api.shop.example');
  });

  it('watches Bruno collection folders and reloads when a .bru file is added or edited (CONTRACTS §24.4)', async () => {
    const brunoDir = path.join(project, 'api', 'shop-bruno');
    fs.cpSync(SHOP_BRUNO_DIR, brunoDir, { recursive: true });
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({ version: 1, collections: [{ id: 'shop-bruno', file: 'api/shop-bruno/bruno.json', environment: 'dev' }] }),
    );

    const ide = fakeIde();
    const { collections } = setup(ide);
    await collections.ready;
    const beforeCount = collections.state()[0].endpoints;
    expect(beforeCount).toBeGreaterThan(0);

    // Add a new .bru file inside the Bruno folder → watchFolder triggers reload.
    fs.writeFileSync(
      path.join(brunoDir, 'Ping.bru'),
      'meta {\n  name: Ping\n  type: http\n  seq: 99\n}\n\nget {\n  url: {{baseUrl}}/ping\n  body: none\n  auth: none\n}\n',
    );
    await waitFor(() => collections.state()[0]?.endpoints === beforeCount + 1);
  });
});

describe('SidecarHost collections wiring (panel, rule order, agent tools)', () => {
  let tmp: string;
  let project: string;
  let outside: string;
  let host: SidecarHost;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-sidecar-host-col-')));
    project = path.join(tmp, 'demo_app');
    outside = path.join(tmp, 'private-outside-folder');
    fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(project, 'pubspec.yaml'), 'name: demo_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.writeFileSync(path.join(project, 'lib', 'main.dart'), 'void main() {}\n');
  });

  afterEach(async () => {
    await host?.handle('shutdown', undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('wires Status.collections, panel messages (never exposing paths), proxy rule order, importCollection command and agent tools', async () => {
    const extCol = path.join(outside, 'shop.postman_collection.json');
    fs.copyFileSync(SHOP_COLLECTION, extCol);

    const requests: { method: string; params: unknown }[] = [];
    const link: PluginLink = {
      async request<T>(method: string, params?: unknown): Promise<T> {
        requests.push({ method, params });
        if (method === COLLECTION_FILE_METHOD) return extCol as T;
        if (method === COLLECTION_COPY_METHOD) return 'sanitised' as T;
        if (method === COLLECTION_VAR_METHOD) {
          const name = (params as { name: string }).name;
          return (name === 'baseUrl' ? 'https://api.shop.example' : null) as T;
        }
        if (method === COLLECTION_REMOVE_METHOD) return true as T;
        if (method === 'ui.notify') return null as T;
        throw new RpcFailure(`unknown method ${method}`, 'unknown_method');
      },
      event: () => undefined,
    };

    host = new SidecarHost({
      link,
      log: () => undefined,
      version: '0.15.0-test',
      webviewDir: path.join(__dirname, '..', '..', 'webview', 'dist'),
      adbPath: null,
      webSocket: null,
    });

    await host.handle('init', {
      dataDir: path.join(tmp, 'data'),
      workspaceFolders: [project],
      settings: {
        enabled: true,
        port: 0,
        agent: { access: 'readWrite', redactSecrets: true, screenshots: true, mcpPort: 0 },
      },
      theme: 'light',
      ide: { name: 'Android Studio', version: '2026.2', pluginVersion: '0.15.0' },
    });

    const internal = host as unknown as {
      controller: {
        attach(post: (m: HostMsg) => void): () => void;
        handle(raw: ViewMsg, reply: (m: HostMsg) => void): Promise<void>;
        status(): { collections?: { id: string; name: string; file: string }[] };
      };
      proxyHost: {
        getRules(): { id: string }[];
      };
      agentApi: {
        call(tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
      collections: { ready: Promise<void>; rules(): { id: string; action: { kind: string } }[]; storeStatus(id: string): { resources: { name: string }[] } | undefined };
    };
    await internal.collections.ready;

    // Attach a fake traffic panel to capture every HostMsg sent to the webview.
    const sentToPanel: HostMsg[] = [];
    const reply = (m: HostMsg) => sentToPanel.push(m);
    const detach = internal.controller.attach(reply);
    await internal.controller.handle({ type: 'ready' }, reply);
    expect(internal.controller.status().collections).toEqual([]);

    // Trigger import via the plugin command (same flow as panel's importCollection).
    const cmdRes = await host.handle('command', { name: 'importCollection' });
    expect(cmdRes).toEqual({ id: 'shop-api' });

    expect(internal.controller.status().collections).toHaveLength(1);
    expect(internal.collections.rules().length).toBeGreaterThan(0);
    // CONTRACTS §22.9: the host passes the proxy host's setHandler, so the shop's users remember (handler rules).
    expect(internal.collections.rules().some((r) => r.action.kind === 'handler')).toBe(true);
    expect(internal.collections.storeStatus('shop-api')?.resources.map((r) => r.name)).toContain('users');
    // Collection rules stay out of getRules() (proxy gets [...shared, ...personal, ...collections]).
    expect(internal.proxyHost.getRules()).toEqual([]);

    // Panel requests endpoints & example.
    await internal.controller.handle({ type: 'getCollectionEndpoints', id: 'shop-api' }, reply);
    const epMsg = sentToPanel.find((m) => m.type === 'collectionEndpoints');
    expect(epMsg).toBeDefined();
    expect(epMsg && epMsg.type === 'collectionEndpoints' && epMsg.endpoints.length).toBeGreaterThan(0);

    const loginEp = epMsg && epMsg.type === 'collectionEndpoints' ? epMsg.endpoints.find((e) => e.name === 'Log in')! : undefined;
    expect(loginEp).toBeDefined();
    await internal.controller.handle({ type: 'getCollectionExample', id: 'shop-api', endpoint: loginEp!.key, name: 'Success' }, reply);
    const exMsg = sentToPanel.find((m) => m.type === 'collectionExample');
    expect(exMsg).toMatchObject({ type: 'collectionExample', id: 'shop-api', name: 'Success', status: 200 });

    // Panel NEVER receives the outside directory or any absolute filesystem path!
    const allPanelText = JSON.stringify(sentToPanel);
    expect(allPanelText).not.toContain('private-outside-folder');
    expect(allPanelText).not.toContain(tmp);

    // Agent API tools work automatically through SidecarHost!
    const listed = await internal.agentApi.call('list_collections', {});
    expect((listed.collections as { id: string }[]).map((c) => c.id)).toEqual(['shop-api']);

    const got = await internal.agentApi.call('get_collection', { id: 'shop-api', filter: 'users' });
    expect((got.endpoints as unknown[]).length).toBeGreaterThan(0);

    const gotEx = await internal.agentApi.call('get_collection_example', { id: 'shop-api', endpoint: loginEp!.key, example: 'Success' });
    expect(gotEx.status).toBe(200);

    await internal.agentApi.call('set_collection', { id: 'shop-api', unmatched: 'fail' });
    expect(internal.controller.status().collections?.[0]).toMatchObject({ id: 'shop-api', unmatched: 'fail' });

    // Remove through panel → native IDE modal confirmation.
    await internal.controller.handle({ type: 'removeCollection', id: 'shop-api' }, reply);
    await waitFor(() => internal.controller.status().collections?.length === 0);
    expect(requests.some((r) => r.method === COLLECTION_REMOVE_METHOD)).toBe(true);
    detach();
  }, 30_000);

  it('re-sends panel status (debounced 500 ms) on session change and exposes answerOf / expireSessions / authCollectionFor / environmentsOf to agents (CONTRACTS §24.1, §24.9)', async () => {
    fs.mkdirSync(path.join(project, 'api'), { recursive: true });
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    fs.copyFileSync(SHOP_COLLECTION, path.join(project, 'api', 'shop.postman_collection.json'));
    fs.copyFileSync(SHOP_ENV, path.join(project, 'api', 'shop.postman_environment.json'));
    fs.writeFileSync(
      path.join(project, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({
        version: 1,
        collections: [{ id: 'shop-api', file: 'api/shop.postman_collection.json', environment: 'api/shop.postman_environment.json' }],
        stores: [{ collection: 'shop-api', auth: { enabled: true } }],
      }),
    );

    const link: PluginLink = {
      async request<T>(method: string): Promise<T> {
        if (method === 'ui.notify') return null as T;
        throw new RpcFailure(`unknown method ${method}`, 'unknown_method');
      },
      event: () => undefined,
    };

    host = new SidecarHost({
      link,
      log: () => undefined,
      version: '0.16.0-test',
      webviewDir: path.join(__dirname, '..', '..', 'webview', 'dist'),
      adbPath: null,
      webSocket: null,
    });

    await host.handle('init', {
      dataDir: path.join(tmp, 'data'),
      workspaceFolders: [project],
      settings: {
        enabled: true,
        port: 0,
        agent: { access: 'readWrite', redactSecrets: true, screenshots: true, mcpPort: 0 },
      },
      theme: 'light',
      ide: { name: 'Android Studio', version: '2026.2', pluginVersion: '0.16.0' },
    });

    const internal = host as unknown as {
      controller: {
        attach(post: (m: HostMsg) => void): () => void;
        handle(raw: ViewMsg, reply: (m: HostMsg) => void): Promise<void>;
      };
      proxyHost: {
        handlers: Map<string, RequestHandler>;
        getExchanges(): Exchange[];
      };
      agentApi: {
        call(tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
      collections: {
        ready: Promise<void>;
        rules(): Rule[];
        answerOf(id: string): { auth?: string; example?: string } | undefined;
        expireSessions(id: string): number;
        authCollectionFor(url: string): string | undefined;
        environmentsOf(file: string): Promise<string[]>;
      };
    };
    await internal.collections.ready;

    const sent: HostMsg[] = [];
    const reply = (m: HostMsg) => sent.push(m);
    const detach = internal.controller.attach(reply);
    await internal.controller.handle({ type: 'ready' }, reply);
    sent.length = 0;

    // Login through the registered handler → onAuthChange fires → controller re-sends status after 500 ms debounce.
    const loginRule = internal.collections.rules().find((r) => r.match.method === 'POST' && r.match.url.includes('auth\\/login'))!;
    const handler = internal.proxyHost.handlers.get('collection:shop-api')!;
    expect(handler).toBeDefined();
    const res = await handler(
      {
        exchangeId: 'ex-login-1',
        ruleId: loginRule.id,
        method: 'POST',
        url: 'https://api.shop.example/auth/login',
        headers: { 'content-type': 'application/json' },
        body: { text: '{"email":"sara@example.com","password":"any"}', encoding: 'utf8' },
      },
      new AbortController().signal,
    );
    expect(res).toMatchObject({ status: 200 });
    expect(internal.collections.answerOf('ex-login-1')).toMatchObject({ auth: 'signed in' });
    expect(internal.collections.authCollectionFor('https://api.shop.example/users')).toBe('shop-api');
    expect(await internal.collections.environmentsOf('api/shop.postman_collection.json')).toEqual([]);

    // Status message is re-sent after 500 ms debounce with sessions: 1.
    await waitFor(
      () =>
        sent.some(
          (m) => m.type === 'status' && m.status.collections?.some((c) => c.id === 'shop-api' && c.store?.auth?.sessions === 1),
        ),
      2500,
    );

    // Agent API's `expire_token` delegates to `authCollectionFor` + `expireSessions` (adds no rule).
    const exp = await internal.agentApi.call('expire_token', { url: 'https://api.shop.example/*' });
    expect(exp).toMatchObject({ collection: 'shop-api', expired: 1 });

    detach();
  }, 30_000);
});

describe('sidecar collections part 2: fake backend from traffic, drift & Update example (CONTRACTS §23)', () => {
  let tmp: string;
  let project: string;
  let dataDir: string;
  const disposers: (() => void)[] = [];

  const PLANTED_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwbGFudGVkLXVzZXItOTkiLCJleHAiOjE5MDAwMDAwMDB9.realSignatureBytes1234567890';
  const PLANTED_SECRETS = [
    PLANTED_JWT,
    'super-secret-password-999',
    'sk_live_plantedKey123',
    'alice.real@corp-private.test',
    '+44-7700-900123',
    '742 Evergreen Terrace',
    '24.7136',
    'planted-cookie-val-xyz',
    'planted-s3-sig-abcdef123456',
  ];

  function realExchange(id: string, url: string, body: unknown, opts: { status?: number; method?: string; headers?: Record<string, string>; matchedRuleId?: string } = {}): Exchange {
    return {
      id,
      startedAt: 1_800_000_000_000 + Number(id.replace(/\D/g, '') || 1),
      method: opts.method ?? 'GET',
      url,
      requestHeaders: {
        authorization: `Bearer ${PLANTED_JWT}`,
        'x-api-key': 'sk_live_plantedKey123',
      },
      status: opts.status ?? 200,
      responseHeaders: {
        'content-type': 'application/json',
        'set-cookie': 'sid=planted-cookie-val-xyz; HttpOnly',
        ...(opts.headers ?? {}),
      },
      responseBody: { text: JSON.stringify(body), encoding: 'utf8' },
      state: 'completed',
      ...(opts.matchedRuleId ? { matchedRuleId: opts.matchedRuleId } : {}),
    };
  }

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-sidecar-p2-')));
    project = path.join(tmp, 'app');
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(project, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.writeFileSync(path.join(project, 'lib', 'main.dart'), 'void main() {}\n');
  });

  afterEach(() => {
    for (const d of disposers.splice(0).reverse()) d();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setupP2(ide: FakeIde, traffic: Exchange[], extra: Partial<SidecarCollectionsDeps> = {}) {
    const state = new JsonStateStore(dataDir);
    const shared = createNodeSharedRules({
      roots: () => [project],
      memento: state,
      validateRule,
      debounceMs: 30,
      pollMs: 80,
    });
    const exchangeListeners = new Set<(e: Exchange) => void>();
    const collections = createSidecarCollections({
      shared,
      roots: () => [project],
      memento: state,
      parsers: collectionParsers,
      newRuleId: () => 'rule_p2_1',
      request: (m, p) => ide.request(m, p),
      notify: (level, message) => ide.notify(level, message),
      exchanges: () => traffic,
      onExchange: (l) => {
        exchangeListeners.add(l);
        return { dispose: () => void exchangeListeners.delete(l) };
      },
      debounceMs: 30,
      driftDebounceMs: 25,
      ...extra,
    });
    disposers.push(() => {
      collections.dispose();
      shared.dispose();
    });
    const emit = (e: Exchange) => {
      traffic.push(e);
      for (const l of exchangeListeners) l(e);
    };
    return { state, shared, collections, emit };
  }

  it('mockFromTrafficInteractive: cancels cleanly at every step and writes nothing', async () => {
    const traffic = [
      realExchange('e1', 'https://api.shop.example/users/1', { id: 1, name: 'Ada' }),
      realExchange('e2', 'https://www.google-analytics.com/g/collect', { ok: true }),
    ];

    for (const cancelAt of [0, 1, 2, 3]) {
      const ide = fakeIde({
        [PICK_MANY_METHOD]: (p) => {
          if (cancelAt === 0) return null;
          return (p.items as { value: string; picked: boolean }[]).filter((i) => i.picked).map((i) => i.value);
        },
        [SNAPSHOT_NAME_METHOD]: (p) => (cancelAt === 1 ? null : p.value),
        [COLLECTION_ENV_METHOD]: () => (cancelAt === 2 ? null : 'replace'),
        [CONFIRM_METHOD]: () => (cancelAt === 3 ? null : FALLBACK_PASSTHROUGH_BUTTON),
      });
      const { collections } = setupP2(ide, traffic);
      expect(await collections.mockFromTrafficInteractive({ session: {} })).toBeUndefined();
      expect(collections.state()).toEqual([]);
      expect(fs.existsSync(path.join(project, '.vscode', 'flutter-intercept', 'collections'))).toBe(false);
    }
  });

  it('mockFromTrafficInteractive: preselects JSON non-third-party origins, enforces one flow at a time, and strips all planted secrets', async () => {
    const traffic = [
      realExchange('e1', 'https://api.shop.example/users/42', {
        id: 42,
        name: 'Alice',
        email: 'alice.real@corp-private.test',
        phone: '+44-7700-900123',
        streetAddress: '742 Evergreen Terrace',
        lat: 24.7136,
        password: 'super-secret-password-999',
        accessToken: PLANTED_JWT,
        avatarUrl: 'https://cdn.example/a.png?X-Amz-Signature=planted-s3-sig-abcdef123456',
      }),
      realExchange('e2', 'https://api.shop.example/settings', { theme: 'dark' }, { matchedRuleId: 'rule_throttle' }),
      realExchange('e3', 'https://www.google-analytics.com/g/collect', { ok: true }),
    ];

    let releaseFirst!: (v: unknown) => void;
    const ide = fakeIde({
      [PICK_MANY_METHOD]: (p) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve((p.items as { value: string; picked: boolean }[]).filter((i) => i.picked).map((i) => i.value));
        }),
      [SNAPSHOT_NAME_METHOD]: (p) => p.value,
      [COLLECTION_ENV_METHOD]: () => 'replace',
      [CONFIRM_METHOD]: () => FALLBACK_FAIL_BUTTON,
      [OPEN_FILE_METHOD]: () => null,
    });
    const { collections } = setupP2(ide, traffic, {
      isThrottleOnlyRule: (id) => id === 'rule_throttle',
    });

    const first = collections.mockFromTrafficInteractive({ session: {} });
    await waitFor(() => ide.requests.length === 1);
    // Second concurrent invocation is refused while the first flow is open.
    expect(await collections.mockFromTrafficInteractive({ session: {} })).toBeUndefined();
    expect(ide.notifications.at(-1)).toEqual({ level: 'info', message: FROM_TRAFFIC_BUSY });

    releaseFirst(undefined);
    const res = await first;
    expect(res).toBeDefined();
    expect(res!.id).toBe('api-shop-example-recorded');
    expect(res!.endpoints).toBe(2); // /users/42 and throttle-only /settings

    // Verify exact dialog parameters.
    const pickManyParams = ide.requests[0].params as { items: { label: string; picked: boolean }[] };
    expect(pickManyParams.items.map((i) => [i.label, i.picked])).toEqual([
      ['api.shop.example', true],
      ['www.google-analytics.com', false],
    ]);
    expect((ide.requests[1].params as { value: string }).value).toBe('api.shop.example (recorded)');
    const confirmParams = ide.requests[3].params as { detail: string; buttons: string[]; modal: boolean };
    expect(confirmParams.modal).toBe(true);
    expect(confirmParams.buttons).toEqual([FALLBACK_PASSTHROUGH_BUTTON, FALLBACK_FAIL_BUTTON]);
    expect(confirmParams.detail).toContain('Credentials removed; example bodies are real data — review before committing');
    expect(ide.requests[4].method).toBe(OPEN_FILE_METHOD);

    // Written collection contains NONE of the planted secrets and links with unmatched=fail.
    const written = fs.readFileSync(path.join(project, ...res!.file.split('/')), 'utf8');
    for (const secret of PLANTED_SECRETS) expect(written).not.toContain(secret);
    expect(collections.state()[0]).toMatchObject({ id: 'api-shop-example-recorded', unmatched: 'fail' });
  });

  it('drift reaches status after 3 real answers; Update example previews, confirms and splices with every other byte unchanged; ignore hides it', async () => {
    const colDir = path.join(project, 'api');
    fs.mkdirSync(colDir, { recursive: true });
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    const colPath = path.join(colDir, 'shop.postman_collection.json');
    const colDoc = {
      info: {
        name: 'Shop API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      variable: [{ key: 'baseUrl', value: 'https://api.shop.example' }],
      item: [
        {
          name: 'Get user',
          request: { method: 'GET', url: '{{baseUrl}}/users/1' },
          response: [
            {
              name: '200 OK',
              status: 'OK',
              code: 200,
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: '{"id":1,"name":"Ada"}',
            },
          ],
        },
        {
          name: 'Untouched endpoint',
          request: { method: 'GET', url: '{{baseUrl}}/ping' },
          response: [
            {
              name: '200 OK',
              status: 'OK',
              code: 200,
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: '{"pong":true}',
            },
          ],
        },
      ],
    };
    const beforeFile = `${JSON.stringify(colDoc, null, 2)}\n`;
    fs.writeFileSync(colPath, beforeFile);
    fs.writeFileSync(
      path.join(project, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({ version: 1, collections: [{ id: 'shop-api', file: 'api/shop.postman_collection.json' }] }),
    );

    let confirmAnswer: string | null = null;
    const ide = fakeIde({
      [DIFF_METHOD]: () => null,
      [CONFIRM_METHOD]: () => confirmAnswer,
    });
    const traffic: Exchange[] = [];
    const { collections, emit } = setupP2(ide, traffic);
    await collections.ready;
    // Turn off for this user so real answers simulate calling the real server while collection is linked.
    await collections.update('shop-api', { enabled: false });

    let driftEvents = 0;
    collections.onDidChangeDrift(() => driftEvents++);

    // 2 answers are not enough (N = 3); 3rd triggers drift.
    emit(realExchange('d1', 'https://api.shop.example/users/1', { id: 1, name: 'Ada', tier: 'gold' }));
    emit(realExchange('d2', 'https://api.shop.example/users/1', { id: 1, name: 'Ada', tier: 'gold' }));
    await new Promise((r) => setTimeout(r, 60));
    expect(collections.drift('shop-api')).toEqual([]);
    expect(collections.state()[0].drift).toBeUndefined();

    emit(realExchange('d3', 'https://api.shop.example/users/1', { id: 1, name: 'Ada', tier: 'gold' }));
    await waitFor(() => collections.drift('shop-api').length === 1);
    expect(driftEvents).toBeGreaterThanOrEqual(1);
    expect(collections.state()[0].drift?.line).toBe('GET /users/1 now has tier');

    const epKey = collections.endpoints('shop-api').find((e) => e.drift?.length)!.key;

    // 1. Cancel after diff preview → file untouched.
    confirmAnswer = null;
    expect(await collections.updateExampleInteractive('shop-api', epKey, 200)).toBe('cancelled');
    expect(fs.readFileSync(colPath, 'utf8')).toBe(beforeFile);
    const diffReq = ide.requests.find((r) => r.method === DIFF_METHOD)!;
    const diffParams = diffReq.params as { title: string; left: { content: string }; right: { content: string } };
    expect(diffParams.left.content).toBe(beforeFile);
    expect(diffParams.right.content).toContain('tier');

    // 2. Confirm → file updated, every byte outside the spliced body literal unchanged!
    confirmAnswer = UPDATE_EXAMPLE_BUTTON;
    expect(await collections.updateExampleInteractive('shop-api', epKey, 200)).toBe('updated');
    const afterFile = fs.readFileSync(colPath, 'utf8');
    expect(afterFile).toBe(diffParams.right.content);
    const oldBodyLit = JSON.stringify('{"id":1,"name":"Ada"}');
    const newBodyLit = JSON.stringify('{"id":1,"name":"Ada","tier":"gold"}');
    expect(beforeFile.replace(oldBodyLit, newBodyLit)).toBe(afterFile);
    expect(collections.drift('shop-api')).toEqual([]);

    // 3. New drift → ignoreDrift hides it from status and drift().
    for (let i = 4; i <= 6; i++) {
      emit(realExchange(`d${i}`, 'https://api.shop.example/users/1', { id: 1, name: 'Ada', tier: 'gold', badge: 'vip' }));
    }
    await waitFor(() => collections.drift('shop-api').length === 1);
    await collections.ignoreDrift('shop-api', epKey, 200);
    expect(collections.drift('shop-api')).toEqual([]);
    expect(collections.state()[0].drift).toBeUndefined();
  });

  it('Update example copy-only path (OpenAPI YAML): offers Copy the updated example, writes clipboard, leaves file untouched', async () => {
    const colDir = path.join(project, 'api');
    fs.mkdirSync(colDir, { recursive: true });
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    const yamlPath = path.join(colDir, 'pets.yaml');
    const yamlText = [
      'openapi: 3.0.3',
      'info: {title: Pets, version: "1"}',
      'servers: [{url: "https://pets.example"}]',
      'paths:',
      '  /pets/{id}:',
      '    get:',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          content:',
      '            application/json:',
      '              example: {id: 1, name: Rex}',
      '',
    ].join('\n');
    fs.writeFileSync(yamlPath, yamlText);
    fs.writeFileSync(
      path.join(project, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({ version: 1, collections: [{ id: 'pets', file: 'api/pets.yaml' }] }),
    );

    let clipboard = '';
    let confirmAnswer: string | null = null;
    const ide = fakeIde({
      [CONFIRM_METHOD]: () => confirmAnswer,
      [CLIPBOARD_METHOD]: (p) => {
        clipboard = (p as { text: string }).text;
        return null;
      },
    });
    const traffic: Exchange[] = [];
    const { collections, emit } = setupP2(ide, traffic);
    await collections.ready;

    for (let i = 1; i <= 3; i++) {
      emit(realExchange(`p${i}`, 'https://pets.example/pets/1', { id: 1, name: 'Fido', owner: 'me@pets.dev' }));
    }
    await waitFor(() => collections.drift('pets').length === 1);

    // Cancel copy-only modal → clipboard untouched.
    confirmAnswer = null;
    expect(await collections.updateExampleInteractive('pets', 'GET /pets/{id}', 200)).toBe('cancelled');
    expect(clipboard).toBe('');
    expect(ide.requests.some((r) => r.method === DIFF_METHOD)).toBe(false);

    // Confirm → copies sanitised merged JSON to clipboard; YAML file untouched.
    confirmAnswer = COPY_EXAMPLE_BUTTON;
    expect(await collections.updateExampleInteractive('pets', 'GET /pets/{id}', 200)).toBe('copied');
    expect(JSON.parse(clipboard)).toEqual({ id: 1, name: 'Rex', owner: 'user1@example.com' });
    expect(fs.readFileSync(yamlPath, 'utf8')).toBe(yamlText);
  });

  it('SidecarHost wires drift → status broadcast, collectionDrift setting off clears drift, and panel/agent part 2 actions', async () => {
    const colDir = path.join(project, 'api');
    fs.mkdirSync(colDir, { recursive: true });
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    fs.writeFileSync(
      path.join(colDir, 'todo.openapi.json'),
      JSON.stringify(
        {
          openapi: '3.0.3',
          info: { title: 'Todo API', version: '1' },
          servers: [{ url: 'https://api.todo.example' }],
          paths: {
            '/todos/{id}': {
              get: {
                responses: {
                  '200': {
                    description: 'ok',
                    content: { 'application/json': { example: { id: 1, title: 'Milk' } } },
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(project, '.vscode', 'flutter-intercept.json'),
      JSON.stringify({ version: 1, collections: [{ id: 'todo', file: 'api/todo.openapi.json' }] }),
    );

    const link: PluginLink = {
      async request<T>(method: string): Promise<T> {
        if (method === 'ui.notify') return null as T;
        throw new RpcFailure(`unknown method ${method}`, 'unknown_method');
      },
      event: () => undefined,
    };

    const host = new SidecarHost({
      link,
      log: () => undefined,
      version: '0.16.0-test',
      webviewDir: path.join(__dirname, '..', '..', 'webview', 'dist'),
      adbPath: null,
      webSocket: null,
    });
    disposers.push(() => void host.handle('shutdown', undefined));

    await host.handle('init', {
      dataDir,
      workspaceFolders: [project],
      settings: {
        enabled: true,
        port: 0,
        collectionDrift: true,
        agent: { access: 'readWrite', redactSecrets: true, screenshots: true, mcpPort: 0 },
      },
      theme: 'dark',
      ide: { name: 'Android Studio', version: '2026.2', pluginVersion: '0.16.0' },
    });

    const internal = host as unknown as {
      controller: {
        attach(post: (m: HostMsg) => void): () => void;
        handle(raw: ViewMsg, reply: (m: HostMsg) => void): Promise<void>;
        status(): { collections?: { id: string; drift?: { endpoints: number; line: string } }[] };
      };
      proxyHost: {
        emit(event: 'exchange', ex: Exchange): boolean;
        getExchanges(): Exchange[];
      };
      agentApi: {
        call(tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
      collections: { ready: Promise<void> };
    };
    await internal.collections.ready;

    const sent: HostMsg[] = [];
    const reply = (m: HostMsg) => sent.push(m);
    const detach = internal.controller.attach(reply);
    await internal.controller.handle({ type: 'ready' }, reply);
    sent.length = 0;

    // Emit 3 real exchanges via proxyHost → observed by SidecarCollections → drift reaches status.
    const recorded: Exchange[] = [];
    const origGet = internal.proxyHost.getExchanges.bind(internal.proxyHost);
    internal.proxyHost.getExchanges = () => [...origGet(), ...recorded];
    for (let i = 1; i <= 3; i++) {
      const ex = realExchange(`h${i}`, 'https://api.todo.example/todos/1', { id: 1, title: 'Milk', priority: 'high' });
      recorded.push(ex);
      internal.proxyHost.emit('exchange', ex);
    }

    await waitFor(
      () =>
        sent.some(
          (m) => m.type === 'status' && m.status.collections?.some((c) => c.id === 'todo' && c.drift?.endpoints === 1),
        ),
      3000,
    );

    // Agent tools: update_collection_example preview + mock_from_traffic dryRun work through SidecarHost.
    const preview = await internal.agentApi.call('update_collection_example', { id: 'todo', endpoint: 'GET /todos/{id}', status: 200 });
    expect(String(preview.diff)).toContain('priority');
    const dry = await internal.agentApi.call('mock_from_traffic', { name: 'Recorded Todo', dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, endpoints: 1 });

    // Turning off collectionDrift via settings clears drift in status.
    await host.handle('settings', { settings: { enabled: true, port: 0, collectionDrift: false, agent: { access: 'readWrite', redactSecrets: true, screenshots: true, mcpPort: 0 } } });
    expect(internal.controller.status().collections?.[0]?.drift).toBeUndefined();

    detach();
  }, 30_000);
});
