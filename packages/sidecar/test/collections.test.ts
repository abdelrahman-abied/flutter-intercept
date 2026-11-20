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
  COLLECTION_CHOOSER_BUSY,
  COLLECTION_COPY_METHOD,
  COLLECTION_FILE_METHOD,
  COLLECTION_REMOVE_METHOD,
  COLLECTION_VAR_METHOD,
  createSidecarCollections,
  usableCollectionPath,
  usableVariableUrl,
} from '../src/collections';
import { SidecarHost, type PluginLink } from '../src/host';
import { RpcFailure } from '../src/rpc';
import { createNodeSharedRules } from '../src/sharedRules';
import { JsonStateStore } from '../src/state';

const FIXTURES = path.resolve(__dirname, '..', '..', 'extension', 'test', 'fixtures', 'collections');
const SHOP_COLLECTION = path.join(FIXTURES, 'shop.postman_collection.json');
const SHOP_ENV = path.join(FIXTURES, 'shop.postman_environment.json');

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

  function setup(ide: FakeIde, seenOrigins: () => string[] = () => ['https://api.shop.example']) {
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
      collections: { ready: Promise<void>; rules(): { id: string }[] };
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
});
