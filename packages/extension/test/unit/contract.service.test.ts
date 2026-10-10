import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';

// --- minimal vscode ------------------------------------------------------------------------
const vs = vi.hoisted(() => {
  const state = {
    diagnostics: new Map<string, { range: unknown; message: string; severity: number; source?: string }[]>(),
    watchers: [] as { change: ((u: { fsPath: string }) => void)[] }[],
    config: { contractCheck: true },
    configListeners: [] as ((e: { affectsConfiguration: (s: string) => boolean }) => void)[],
  };
  return state;
});

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
  class Range {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number,
    ) {}
  }
  class Diagnostic {
    source?: string;
    constructor(
      public range: Range,
      public message: string,
      public severity: number,
    ) {}
  }
  const ev = () => ({ dispose: () => undefined });
  return {
    EventEmitter,
    Range,
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri: { fsPath: string }, d: never[]) => vs.diagnostics.set(uri.fsPath, d),
        clear: () => vs.diagnostics.clear(),
        dispose: () => vs.diagnostics.clear(),
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (k: string, d: unknown) => (k === 'contractCheck' ? vs.config.contractCheck : d) }),
      findFiles: async () => [],
      createFileSystemWatcher: () => {
        const w = { change: [] as ((u: { fsPath: string }) => void)[] };
        vs.watchers.push(w);
        return {
          onDidChange: (l: (u: { fsPath: string }) => void) => (w.change.push(l), ev()),
          onDidCreate: (l: (u: { fsPath: string }) => void) => (w.change.push(l), ev()),
          onDidDelete: (l: (u: { fsPath: string }) => void) => (w.change.push(l), ev()),
          dispose: () => undefined,
        };
      },
      onDidChangeWorkspaceFolders: () => ev(),
      onDidChangeConfiguration: (l: (e: { affectsConfiguration: (s: string) => boolean }) => void) => (vs.configListeners.push(l), ev()),
    },
  };
});

import { aggregate } from '../../src/contract/diagnostics';
import { checkExchange, ContractFs, ContractIndex, nodeFs } from '../../src/contract/core';
import { createContractService, DONT_CHECK, ROUTES_KEY } from '../../src/contract/service';
import type { XViolation } from '../../src/contract/check';

const DEMO = path.resolve(__dirname, '..', '..', '..', '..', 'samples', 'demo_app', 'lib');
const FIX = path.resolve(__dirname, 'fixtures', 'contract');
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const GENERATED = [path.join(DEMO, 'models', 'user.g.dart'), path.join(DEMO, 'models', 'todo.g.dart'), path.join(DEMO, 'api', 'users_api.g.dart'), path.join(FIX, 'probe', 'chop.chopper.dart'), path.join(FIX, 'probe', 'models.g.dart')];

const realUser = JSON.stringify({
  id: 1,
  name: 'Leanne Graham',
  username: 'Bret',
  email: 'Sincere@april.biz',
  address: { street: 'Kulas Light', suite: 'Apt. 556', city: 'Gwenborough', zipcode: '92998-3874', geo: { lat: '-37.3159', lng: '81.1496' } },
  company: { name: 'Romaguera-Crona', catchPhrase: 'x', bs: 'y' },
});

let n = 0;
function exchange(p: Partial<Exchange> & { body?: string }): Exchange {
  const { body, ...rest } = p;
  return {
    id: `ex${++n}`,
    startedAt: 0,
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/users/1',
    requestHeaders: {},
    status: 200,
    responseHeaders: { 'content-type': 'application/json; charset=utf-8' },
    responseBody: body === undefined ? undefined : { text: body, encoding: 'utf8' },
    state: 'completed',
    ...rest,
  };
}

/** Real files, with optional in-memory overrides. */
function memFs(over: Record<string, string> = {}, mtimes: Record<string, number> = {}): ContractFs & { over: Record<string, string>; mtimes: Record<string, number> } {
  return {
    over,
    mtimes,
    stat: (p) => (p in over ? { mtimeMs: mtimes[p] ?? 1, size: over[p].length, isFile: true } : nodeFs.stat(p)),
    read: (p, max) => (p in over ? (over[p].length <= max ? over[p] : undefined) : nodeFs.read(p, max)),
    realpath: (p) => (p in over ? p : nodeFs.realpath(p)),
  };
}

describe('ContractIndex + checkExchange (demo app, real generated code)', () => {
  const index = new ContractIndex(memFs());
  beforeAll(async () => {
    await index.setFiles(GENERATED);
  });

  it('indexes models, endpoints and generated API classes', () => {
    expect(index.allModels().map((m) => m.name)).toEqual(expect.arrayContaining(['User', 'Address', 'Geo', 'Company', 'Todo', 'Item', 'Profile']));
    expect(index.endpoints.map((e) => `${e.method} ${e.pathTemplate}`)).toEqual(['GET /users/{id}', 'GET /users/{id}/todos', 'GET /items/{id}', 'GET /items', 'POST /items/']);
    expect(index.classes.map((c) => c.generated)).toEqual(['_UsersApi', '_$ItemService']);
  });

  it('maps by Retrofit path template and checks clean real data', () => {
    const r = checkExchange(index, exchange({ body: realUser }));
    expect(r).toEqual({ exchangeId: expect.any(String), checked: true, model: 'User', via: 'retrofit', violations: [] });
  });

  it('prefers the source frame (validated against the URL)', () => {
    const source = { frames: [{ fn: '_UsersApi.getUser', uri: 'package:demo_app/api/users_api.g.dart', line: 40 }], appFrame: 0 };
    expect(checkExchange(index, exchange({ body: realUser, source })).via).toBe('source');
    // a token refresh fired from inside getUser's interceptor: the frame doesn't fit the URL
    const other = checkExchange(index, exchange({ url: 'https://auth.example.com/oauth/token', method: 'POST', body: '{}', source }));
    expect(other).toMatchObject({ checked: false, via: 'none' });
  });

  it('list endpoints check every element', () => {
    const r = checkExchange(index, exchange({ url: 'https://jsonplaceholder.typicode.com/users/1/todos', body: JSON.stringify([{ userId: 1, id: 1, title: null }]) }));
    expect(r).toMatchObject({ checked: true, model: 'Todo', listOf: true, via: 'retrofit' });
    expect(r.violations.map((v) => v.path)).toEqual(['$[0].title']);
  });

  it('chopper endpoints map with an unknown base (suffix match)', () => {
    const r = checkExchange(index, exchange({ url: 'https://shop.example.com/api/items/9', body: JSON.stringify({ 'item-id': 9, price: 1, label: 'x' }) }));
    expect(r).toMatchObject({ checked: true, model: 'Item', via: 'chopper', violations: [] });
  });

  it('explains every reason it did not check', () => {
    expect(checkExchange(index, exchange({ url: 'https://x.y/nothing', body: '{}' })).reason).toMatch(/no model mapped/);
    expect(checkExchange(index, exchange({ status: 404, body: '{}' })).reason).toMatch(/status 404/);
    expect(checkExchange(index, exchange({ state: 'pending', status: undefined })).reason).toMatch(/no response/);
    expect(checkExchange(index, exchange({ body: '' })).reason).toBe('empty body');
    expect(checkExchange(index, exchange({ body: '<html>' })).reason).toBe('not JSON');
    expect(checkExchange(index, exchange({ responseBody: { text: '{"a"', encoding: 'utf8', truncated: true } })).reason).toBe('body truncated');
    expect(checkExchange(index, exchange({ body: '{}' }), { userModel: DONT_CHECK })).toMatchObject({ checked: false, via: 'user' });
    expect(checkExchange(index, exchange({ body: '{}' }), { model: 'Nope' }).reason).toMatch(/model Nope not found/);
  });

  it('user choices and explicit models win; List<X> and base64 JSON bodies work', () => {
    const r = checkExchange(index, exchange({ url: 'https://x.y/anything', body: realUser }), { userModel: 'User' });
    expect(r).toMatchObject({ checked: true, via: 'user', model: 'User' });
    const b64 = Buffer.from(JSON.stringify([{ userId: 1, id: 2, title: 't' }])).toString('base64');
    const l = checkExchange(index, exchange({ url: 'https://x.y/t', responseBody: { text: b64, encoding: 'base64' }, status: 500 }), { model: 'List<Todo>' });
    expect(l).toMatchObject({ checked: true, listOf: true, violations: [] });
  });

  it('reindexes only what changed (mtime) and relinks when the owner changes', async () => {
    const g = '/mem/lib/a.g.dart';
    const o = '/mem/lib/a.dart';
    const mfs = memFs(
      { [g]: "part of 'a.dart';\nA _$AFromJson(Map<String, dynamic> json) => A(x: json['x'] as String);", [o]: 'class A {\n  final String x;\n}' },
      { [g]: 1, [o]: 1 },
    );
    const idx = new ContractIndex(mfs);
    expect(await idx.setFiles([g, '/mem/.dart_tool/b.g.dart', '/mem/build/c.g.dart'])).toBe(true);
    expect(idx.model('A')?.fieldLines).toEqual({ x: 2 });
    const v = idx.version;
    expect(await idx.setFiles([g])).toBe(false);
    expect(idx.version).toBe(v);
    mfs.over[o] = '// moved\n\nclass A {\n  final String x;\n}';
    mfs.mtimes[o] = 2;
    expect(idx.isOwner(o)).toBe(true);
    expect(await idx.touch(o)).toBe(true);
    expect(idx.model('A')?.fieldLines).toEqual({ x: 4 });
    delete mfs.over[g];
    expect(await idx.touch(g)).toBe(true);
    expect(idx.model('A')).toBeUndefined();
  });
});

describe('aggregate (diagnostics)', () => {
  const v = (p: Partial<XViolation>): XViolation => ({
    path: '$.email',
    model: 'User',
    field: 'email',
    key: 'email',
    expected: 'String',
    actual: 'null',
    severity: 'error',
    message: 'm',
    file: '/w/user.dart',
    line: 39,
    column: 15,
    ...p,
  });
  it('merges the same field problem across responses; keeps distinct problems', () => {
    const out = aggregate(
      new Map([
        ['a', [v({ message: 'first' })]],
        ['b', [v({ message: 'second' }), v({ actual: 'number 3', message: 'typed' })]],
        ['c', [v({ file: undefined })]],
      ]),
    );
    expect([...out.keys()]).toEqual(['/w/user.dart']);
    expect(out.get('/w/user.dart')).toEqual([
      { line: 39, column: 15, length: 5, severity: 'error', message: 'second', responses: 2 },
      { line: 39, column: 15, length: 5, severity: 'error', message: 'typed', responses: 1 },
    ]);
  });
});

describe('createContractService (vscode layer)', () => {
  let store: Record<string, unknown>;
  const memento = () => ({
    get: <T>(k: string) => store[k] as T,
    update: async (k: string, val: unknown) => {
      store[k] = val;
    },
    keys: () => Object.keys(store),
  });

  beforeEach(() => {
    store = {};
    vs.diagnostics.clear();
    vs.watchers.length = 0;
    vs.configListeners.length = 0;
    vs.config.contractCheck = true;
  });

  const make = (files = GENERATED) =>
    createContractService({ workspaceState: memento() as never, findFiles: async () => files, fs: memFs(), roots: () => [REPO] });

  it('checks, caches, and publishes diagnostics on the model field', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const svc = make();
      const ex = exchange({ body: realUser.replace('"Sincere@april.biz"', 'null') });
      const r = await svc.check(ex);
      expect(r.violations).toHaveLength(1);
      expect(svc.cached(ex.id)).toBe(r);
      expect(await svc.check(ex)).toBe(r); // cache hit
      vi.advanceTimersByTime(500);
      const d = vs.diagnostics.get(path.join(DEMO, 'models', 'user.dart'));
      expect(d).toHaveLength(1);
      expect(d![0]).toMatchObject({ severity: 0, source: 'Flutter Intercept', range: { startLine: 38, startCharacter: 15, endCharacter: 20 } });
      expect(d![0].message).toBe("email is null in GET /users/1 → type 'Null' is not a subtype of type 'String' in type cast");
      svc.forget([ex.id]);
      vi.advanceTimersByTime(500);
      expect(vs.diagnostics.size).toBe(0);
      expect(svc.cached(ex.id)).toBeUndefined();
      svc.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers route → model choices in workspaceState', async () => {
    const svc = make();
    const ex = exchange({ url: 'https://api.example.com/profile/42', body: realUser });
    expect((await svc.check(ex)).via).toBe('none');
    await svc.remember(ex, 'User');
    expect(store[ROUTES_KEY]).toEqual({ 'GET /profile/{id}': 'User' });
    const again = await svc.check(exchange({ url: 'https://api.example.com/profile/7', body: realUser }));
    expect(again).toMatchObject({ checked: true, via: 'user', model: 'User' });
    await svc.remember(ex, DONT_CHECK);
    expect((await svc.check(ex)).reason).toMatch(/Don't check this route/);
    await svc.remember(ex, undefined);
    expect(store[ROUTES_KEY]).toEqual({});
    svc.dispose();
  });

  it('lists endpoints with importUri, params and returnType', async () => {
    const svc = make();
    const eps = await svc.endpoints();
    const getUser = eps.find((e) => e.dartMethod === 'getUser')!;
    expect(getUser).toMatchObject({
      method: 'GET',
      pathTemplate: '/users/{id}',
      className: 'UsersApi',
      importUri: 'package:demo_app/api/users_api.dart',
      returnType: 'Future<HttpResponse<User>>',
      params: [{ name: 'id', type: 'int', kind: 'path' }],
      responseModel: 'User',
    });
    expect(getUser).not.toHaveProperty('rawPath');
    // the probe fixtures have no pubspec.yaml above lib/: no import URI
    expect(eps.find((e) => e.dartMethod === 'getItem')!.importUri).toBeUndefined();
    svc.dispose();
  });

  it('lists models for the picker and never throws', async () => {
    const svc = make();
    const models = await svc.models();
    expect(models.find((m) => m.name === 'User')).toEqual({ name: 'User', file: path.join(DEMO, 'models', 'user.dart') });
    const weird = await svc.check({ id: 'x', method: 'GET', url: 'nonsense', state: 'completed', status: 200 } as unknown as Exchange);
    expect(weird.checked).toBe(false);
    svc.dispose();
  });

  it('no diagnostics while flutterIntercept.contractCheck is off; results still answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vs.config.contractCheck = false;
      const svc = make();
      const r = await svc.check(exchange({ body: realUser.replace('"Bret"', '1') }));
      expect(r.violations).toHaveLength(1);
      vi.advanceTimersByTime(500);
      expect(vs.diagnostics.size).toBe(0);
      svc.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a changed generated file fires onDidChangeModels and drops stale results', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const svc = make();
      const ex = exchange({ body: realUser });
      await svc.check(ex);
      let fired = 0;
      svc.onDidChangeModels(() => fired++);
      const w = vs.watchers[0];
      // unrelated .dart files are ignored; generated ones are re-read (same mtime → no change, no event)
      w.change.forEach((l) => l({ fsPath: '/elsewhere/lib/main.dart' }));
      w.change.forEach((l) => l({ fsPath: path.join(DEMO, 'models', 'user.g.dart') }));
      vi.advanceTimersByTime(400);
      expect(fired).toBe(0);
      vs.configListeners.forEach((l) => l({ affectsConfiguration: (s) => s === 'flutterIntercept.contractCheck' }));
      expect(fired).toBe(1);
      expect(svc.cached(ex.id)).toBeUndefined();
      svc.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
