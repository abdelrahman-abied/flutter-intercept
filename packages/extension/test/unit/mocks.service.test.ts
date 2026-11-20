// CONTRACTS §24.4 / §24.9 (part 3): the VS Code layer of "Mock from a collection" — a linked Bruno collection's folders
// are watched whole with the directory watchers (same cap), the import flow offers the environments of an Insomnia /
// Bruno collection by name and never copies Swagger / Insomnia files or Bruno folders in, and session changes fire
// `onDidChangeAuth`.
import * as nodeFs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from '@flutter-intercept/proxy';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, ROOT } from './rules.fakes';

const vs = vi.hoisted(() => ({
  folders: [] as { name: string; uri: { fsPath: string; scheme: string } }[],
  watchers: [] as { pattern: string; base: string; create: ((u?: unknown) => void)[]; change: ((u?: unknown) => void)[]; del: ((u?: unknown) => void)[]; disposed: boolean }[],
  open: undefined as string | undefined,
  quickPicks: [] as { items: string[]; title?: string }[],
  pick: undefined as ((items: string[]) => string | undefined) | undefined,
  errors: [] as string[],
  infos: [] as { message: string; items: string[] }[],
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private ls: ((e: T) => void)[] = [];
    event = (l: (e: T) => void) => {
      this.ls.push(l);
      return { dispose: () => (this.ls = this.ls.filter((x) => x !== l)) };
    };
    fire(e: T) {
      for (const l of this.ls) l(e);
    }
    dispose() {
      this.ls = [];
    }
  }
  class RelativePattern {
    base: string;
    constructor(
      base: { uri?: { fsPath: string }; fsPath?: string },
      readonly pattern: string,
    ) {
      this.base = base.uri?.fsPath ?? base.fsPath ?? '';
    }
  }
  return {
    EventEmitter,
    RelativePattern,
    InputBoxValidationSeverity: { Warning: 2 },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
    window: {
      showOpenDialog: async () => (vs.open ? [{ fsPath: vs.open, scheme: 'file' }] : undefined),
      showQuickPick: async (items: string[], o: { title?: string }) => {
        vs.quickPicks.push({ items, title: o?.title });
        return vs.pick?.(items);
      },
      showInputBox: async () => undefined,
      showErrorMessage: async (m: string) => void vs.errors.push(m),
      showWarningMessage: async () => undefined,
      showInformationMessage: async (message: string, ...rest: unknown[]) => {
        vs.infos.push({ message, items: rest.filter((x): x is string => typeof x === 'string') });
        return undefined;
      },
    },
    workspace: {
      get workspaceFolders() {
        return vs.folders;
      },
      createFileSystemWatcher: (p: { pattern: string; base: string }) => {
        const w = { pattern: p.pattern, base: p.base, create: [] as ((u?: unknown) => void)[], change: [] as ((u?: unknown) => void)[], del: [] as ((u?: unknown) => void)[], disposed: false };
        vs.watchers.push(w);
        return {
          onDidCreate: (l: (u?: unknown) => void) => w.create.push(l),
          onDidChange: (l: (u?: unknown) => void) => w.change.push(l),
          onDidDelete: (l: (u?: unknown) => void) => w.del.push(l),
          dispose: () => (w.disposed = true),
        };
      },
      onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
    },
  };
});

import { createMockCollectionsService, type MockCollectionsHost } from '../../src/mocks/service';
import { collectionParsers } from '../../src/mocks/parsers';
import { createSharedRulesService, type SharedRulesHost } from '../../src/rules/service';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'collections');
const fixture = (name: string) => nodeFs.readFileSync(path.join(FIXTURES, name), 'utf8');
const BRUNO = `${ROOT}/api/shop`;

let fs: FakeFs;
let shared: SharedRulesHost;
let svc: MockCollectionsHost;
let handlers: Map<string, RequestHandler>;

function putBruno(root = BRUNO): void {
  const walk = (dir: string, rel: string) => {
    for (const ent of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, `${rel}/${ent.name}`);
      else fs.put(`${root}${rel}/${ent.name}`, nodeFs.readFileSync(abs, 'utf8'));
    }
  };
  walk(path.join(FIXTURES, 'shop-bruno'), '');
}

async function start(file?: Record<string, unknown>): Promise<void> {
  if (file) fs.put(FILE, JSON.stringify({ version: 1, rules: [], ...file }));
  const memento = new FakeMemento();
  shared = createSharedRulesService({ workspaceState: memento as never, validateRule: fakeValidateRule, fs, debounceMs: 300 });
  svc = createMockCollectionsService({
    shared,
    workspaceState: memento,
    parsers: collectionParsers,
    newRuleId: () => 'rule_new',
    fs,
    debounceMs: 300,
    setHandler: (id, fn) => void (fn ? handlers.set(id, fn) : handlers.delete(id)),
  });
  await svc.ready;
}

beforeEach(() => {
  vi.useFakeTimers();
  vs.folders = [{ name: 'app', uri: { fsPath: ROOT, scheme: 'file' } }];
  vs.watchers = [];
  vs.open = undefined;
  vs.quickPicks = [];
  vs.pick = undefined;
  vs.errors = [];
  vs.infos = [];
  handlers = new Map();
  fs = new FakeFs();
  fs.put(`${ROOT}/pubspec.yaml`, 'name: app\n');
});

afterEach(() => {
  svc?.dispose();
  shared?.dispose();
  vi.useRealTimers();
});

const fire = (dir: string, kind: 'create' | 'change' | 'del', file: string) => {
  const w = vs.watchers.find((x) => x.base === dir && x.pattern === '*' && !x.disposed);
  if (!w) throw new Error(`no watcher for ${dir}`);
  for (const l of w[kind]) l({ fsPath: file });
};

describe('watching a Bruno collection (§24.4)', () => {
  it('every folder is watched; a changed, a new and a removed .bru reload after the debounce', async () => {
    putBruno();
    await start({ collections: [{ id: 'shop', file: 'api/shop/bruno.json', environment: 'dev' }] });
    expect(svc.state()[0]).toMatchObject({ format: 'bruno', name: 'Shop API' });
    const dirs = vs.watchers.filter((w) => w.pattern === '*').map((w) => w.base);
    for (const d of [BRUNO, `${BRUNO}/Auth`, `${BRUNO}/Users`, `${BRUNO}/Users/Orders`, `${BRUNO}/environments`]) expect(dirs).toContain(d);
    const before = svc.state()[0].endpoints;
    let changed = 0;
    svc.onDidChange(() => changed++);

    // a new request file (not a file the core had read: the folder is watched whole)
    const added = `${BRUNO}/Users/Coupons.bru`;
    fs.put(added, 'meta {\n  name: Coupons\n  type: http\n}\n\nget {\n  url: {{baseUrl}}/coupons\n}\n');
    fire(`${BRUNO}/Users`, 'create', added);
    fire(`${BRUNO}/Users`, 'change', added); // a burst is one reload
    await vi.advanceTimersByTimeAsync(299);
    expect(svc.state()[0].endpoints).toBe(before);
    await vi.advanceTimersByTimeAsync(10);
    expect(svc.state()[0].endpoints).toBe(before + 1);
    expect(changed).toBe(1);

    // an edit
    const health = `${BRUNO}/Health.bru`;
    fs.put(health, fs.text(health)!.replace('/health', '/healthz'));
    fire(BRUNO, 'change', health);
    await vi.advanceTimersByTimeAsync(310);
    expect(svc.endpoints('shop').some((e) => e.url.endsWith('/healthz'))).toBe(true);

    // a removal
    fs.files.delete(added);
    fire(`${BRUNO}/Users`, 'del', added);
    await vi.advanceTimersByTimeAsync(310);
    expect(svc.state()[0].endpoints).toBe(before);

    // another environment file counts too
    fs.put(`${BRUNO}/environments/dev.bru`, 'vars {\n  baseUrl: https://dev.shop.example\n}\n');
    fire(`${BRUNO}/environments`, 'change', `${BRUNO}/environments/dev.bru`);
    await vi.advanceTimersByTimeAsync(310);
    expect(svc.state()[0].origins).toContain('https://dev.shop.example');
  });

  it('a file collection is still watched by exact path only; the watcher cap holds for Bruno folders', async () => {
    fs.put(`${ROOT}/api/shop.swagger2.json`, fixture('shop.swagger2.json'));
    fs.put(`${ROOT}/api/unrelated.json`, '{}');
    await start({ collections: [{ id: 'shop', file: 'api/shop.swagger2.json' }] });
    expect(svc.state()[0].format).toBe('swagger');
    let changed = 0;
    svc.onDidChange(() => changed++);
    fs.put(`${ROOT}/api/unrelated.json`, '{"a":1}');
    fire(`${ROOT}/api`, 'change', `${ROOT}/api/unrelated.json`);
    await vi.advanceTimersByTimeAsync(310);
    expect(changed).toBe(0);
    svc.dispose();
    shared.dispose();

    // 100 folders: at most 64 directory watchers
    vs.watchers = [];
    fs.put(`${BRUNO}/bruno.json`, '{"version":"1","name":"Wide","type":"collection"}');
    for (let n = 0; n < 100; n++) fs.put(`${BRUNO}/f${n}/r.bru`, `meta {\n  name: R${n}\n  type: http\n}\n\nget {\n  url: https://wide.example/r${n}\n}\n`);
    await start({ collections: [{ id: 'wide', file: 'api/shop/bruno.json' }] });
    expect(svc.state()[0].endpoints).toBe(100);
    expect(vs.watchers.filter((w) => w.pattern === '*' && w.base.startsWith(BRUNO)).length).toBeLessThanOrEqual(64);
  });
});

describe('the import flow (§24.4)', () => {
  it('a Bruno collection inside the project: chosen by its bruno.json, the environment picked by name', async () => {
    putBruno();
    await start({});
    vs.open = `${BRUNO}/bruno.json`;
    vs.pick = (items) => items.find((i) => i === 'staging');
    const r = await svc.importInteractive();
    expect(r).toEqual({ id: 'shop-api' });
    expect(vs.quickPicks[0]).toMatchObject({ title: 'Mock from a collection: environment' });
    expect(vs.quickPicks[0].items.slice(0, 2)).toEqual(['dev', 'staging']);
    expect(JSON.parse(fs.text(FILE)!).collections).toEqual([{ id: 'shop-api', file: 'api/shop/bruno.json', environment: 'staging' }]);
    expect(svc.state()[0]).toMatchObject({ format: 'bruno' });
    expect(vs.errors).toEqual([]);
  });

  it('"No environment" links without one; closing the pick cancels the import', async () => {
    fs.put(`${ROOT}/api/shop.insomnia-v4.json`, fixture('shop.insomnia-v4.json'));
    await start({});
    vs.open = `${ROOT}/api/shop.insomnia-v4.json`;
    vs.pick = () => undefined;
    expect(await svc.importInteractive()).toBeUndefined();
    expect(svc.state()).toEqual([]);
    vs.pick = (items) => items.at(-1);
    const r = await svc.importInteractive();
    expect(r).toBeDefined();
    expect(JSON.parse(fs.text(FILE)!).collections[0].environment).toBeUndefined();
    expect(svc.state()[0].format).toBe('insomnia');
  });

  it('outside the project: Swagger / Insomnia files and Bruno folders are refused with what to do, nothing is copied', async () => {
    await start({});
    const outside = '/elsewhere';
    fs.put(`${outside}/shop.swagger2.json`, fixture('shop.swagger2.json'));
    fs.put(`${outside}/shop.insomnia-v5.yaml`, fixture('shop.insomnia-v5.yaml'));
    fs.put(`${outside}/shop/bruno.json`, fixture('shop-bruno/bruno.json'));
    for (const [file, text] of [
      ['shop.swagger2.json', /Put the Swagger 2\.0 file in the project/],
      ['shop.insomnia-v5.yaml', /Put the Insomnia file in the project/],
      ['shop/bruno.json', /A Bruno collection is a folder: put the folder in the project/],
    ] as const) {
      vs.errors = [];
      vs.open = `${outside}/${file}`;
      expect(await svc.importInteractive()).toBeUndefined();
      expect(vs.errors).toHaveLength(1);
      expect(vs.errors[0]).toMatch(text);
    }
    expect(vs.infos).toEqual([]); // no copy question was asked
    expect(fs.writes.filter((w) => w.includes('flutter-intercept/collections'))).toEqual([]);
    expect(svc.state()).toEqual([]);
  });
});

describe('sign-in simulation events (§24.9)', () => {
  it('onDidChangeAuth fires on sign-in and on expireSessions; answerOf / authCollectionFor reach the core', async () => {
    fs.put(`${ROOT}/api/shop.postman_collection.json`, fixture('shop.postman_collection.json'));
    await start({ collections: [{ id: 'shop', file: 'api/shop.postman_collection.json', variables: { baseUrl: 'https://api.shop.example' } }], stores: [{ collection: 'shop', auth: { enabled: true } }] });
    const seen: string[] = [];
    svc.onDidChangeAuth((id) => seen.push(id));
    expect(svc.authCollectionFor('https://api.shop.example/*')).toBe('shop');
    const rule = svc.rules().find((r) => r.match.method === 'POST' && /login/.test(String(r.match.url)))!;
    expect(rule.action.kind).toBe('handler');
    const answer = handlers.get('collection:shop')!(
      { exchangeId: 'x1', ruleId: rule.id, method: 'POST', url: 'https://api.shop.example/auth/login', headers: { 'content-type': 'application/json' }, body: { text: '{"email":"a@example.com","password":"pw"}', encoding: 'utf8' } },
      new AbortController().signal,
    ) as { note: string };
    expect(answer.note).toBe('auth: signed in');
    expect(seen).toEqual(['shop']);
    expect(svc.answerOf('x1')).toEqual({ auth: 'signed in' });
    expect(svc.storeStatus('shop')!.auth!.sessions).toBe(1);
    expect(svc.expireSessions('shop')).toBe(1);
    expect(seen).toEqual(['shop', 'shop']);
  });
});
