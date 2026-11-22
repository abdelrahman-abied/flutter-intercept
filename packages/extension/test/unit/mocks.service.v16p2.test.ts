// CONTRACTS §23.2 / §23.3 / §23.4 (part 2): the VS Code layer — the "fake backend from this session" dialogs (servers,
// name, personal data, the modal with the two fallbacks), drift fed by the proxy's exchange events (debounced),
// Update example through vscode.diff of read-only documents and a modal, copy-only for YAML; and the panel's three
// messages (validation, then Status and endpoints sent again).
import * as nodeFs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { FakeFs, FakeMemento, fakeValidateRule, FILE, ROOT } from './rules.fakes';

const vs = vi.hoisted(() => ({
  folders: [] as { name: string; uri: { fsPath: string; scheme: string } }[],
  quickPicks: [] as { items: unknown[]; options: Record<string, unknown> }[],
  pick: [] as ((items: { label: string; picked?: boolean }[]) => unknown)[],
  inputs: [] as Record<string, unknown>[],
  input: undefined as string | undefined,
  modals: [] as { kind: string; message: string; detail?: string; items: string[] }[],
  answer: [] as (string | undefined)[],
  commands: [] as unknown[][],
  providers: new Map<string, { provideTextDocumentContent(uri: { path: string; query: string }): string }>(),
  shown: [] as { uri: { fsPath: string }; options: unknown }[],
  clipboard: '',
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
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  }
  const modal = (kind: string) => async (message: string, opts: { detail?: string } | string, ...rest: unknown[]) => {
    const items = [opts, ...rest].filter((x): x is string => typeof x === 'string');
    vs.modals.push({ kind, message, detail: typeof opts === 'object' ? opts.detail : undefined, items });
    return vs.answer.shift();
  };
  return {
    EventEmitter,
    RelativePattern,
    InputBoxValidationSeverity: { Warning: 2 },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: 'file' }),
      from: (c: { scheme: string; path: string; query: string }) => ({ ...c, toString: () => `${c.scheme}:${c.path}?${c.query}` }),
    },
    window: {
      showQuickPick: async (items: { label: string; picked?: boolean }[], options: Record<string, unknown>) => {
        vs.quickPicks.push({ items, options });
        const f = vs.pick.shift();
        return f ? f(items) : undefined;
      },
      showInputBox: async (o: Record<string, unknown>) => {
        vs.inputs.push(o);
        return vs.input === undefined ? undefined : vs.input === '' ? o.value : vs.input;
      },
      showErrorMessage: modal('error'),
      showWarningMessage: modal('warning'),
      showInformationMessage: modal('info'),
      showTextDocument: async (uri: { fsPath: string }, options: unknown) => void vs.shown.push({ uri, options }),
    },
    commands: { executeCommand: async (...args: unknown[]) => void vs.commands.push(args) },
    env: { clipboard: { writeText: async (t: string) => void (vs.clipboard = t) } },
    workspace: {
      get workspaceFolders() {
        return vs.folders;
      },
      createFileSystemWatcher: () => ({ onDidCreate: () => undefined, onDidChange: () => undefined, onDidDelete: () => undefined, dispose: () => undefined }),
      onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
      registerTextDocumentContentProvider: (scheme: string, p: { provideTextDocumentContent(uri: { path: string; query: string }): string }) => {
        vs.providers.set(scheme, p);
        return { dispose: () => vs.providers.delete(scheme) };
      },
    },
  };
});

import { createMockCollectionsService, EXAMPLE_DIFF_SCHEME, type MockCollectionsHost } from '../../src/mocks/service';
import { collectionParsers } from '../../src/mocks/parsers';
import { createSharedRulesService, type SharedRulesHost } from '../../src/rules/service';
import { createViewHandlers } from '../../src/ui/handlers';
import type { InterceptController } from '../../src/ui/controller';

const SESSION = path.join(__dirname, '..', 'fixtures', 'traffic', 'session.json');
const A = 'https://api.shop.example';
const NAME = 'api-shop-example-recorded';
const COL = `${ROOT}/.vscode/flutter-intercept/collections/${NAME}.json`;
const USER = 'GET {{baseUrl}}/users/:userId';

let fs: FakeFs;
let shared: SharedRulesHost;
let svc: MockCollectionsHost;
let traffic: Exchange[];
let listeners: ((e: Exchange) => void)[];
let driftOn: boolean;
let seq = 0;

async function start(): Promise<void> {
  const memento = new FakeMemento();
  shared = createSharedRulesService({ workspaceState: memento as never, validateRule: fakeValidateRule, fs, debounceMs: 300 });
  svc = createMockCollectionsService({
    shared,
    workspaceState: memento,
    parsers: collectionParsers,
    newRuleId: () => 'rule_new',
    fs,
    debounceMs: 300,
    exchanges: () => traffic,
    loadRecording: async () => traffic,
    onExchange: (l) => {
      listeners.push(l);
      return { dispose: () => (listeners = listeners.filter((x) => x !== l)) };
    },
    isThrottleOnlyRule: () => false,
    driftEnabled: () => driftOn,
    // fake timers: a sliced tick's rest would wait for an immediate (PERF-5 #4); the real clock decides the slice
    driftSliceMs: Infinity,
  });
  await svc.ready;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vs.folders = [{ name: 'app', uri: { fsPath: ROOT, scheme: 'file' } }];
  vs.quickPicks = [];
  vs.pick = [];
  vs.inputs = [];
  vs.input = undefined;
  vs.modals = [];
  vs.answer = [];
  vs.commands = [];
  vs.providers.clear();
  vs.shown = [];
  vs.clipboard = '';
  fs = new FakeFs();
  fs.put(`${ROOT}/pubspec.yaml`, 'name: app\n');
  traffic = (JSON.parse(nodeFs.readFileSync(SESSION, 'utf8')) as { exchanges: Exchange[] }).exchanges;
  listeners = [];
  driftOn = true;
  await start();
});

afterEach(() => {
  svc?.dispose();
  shared?.dispose();
  vi.useRealTimers();
});

/** The user: keeps the preselected servers, keeps the name, replaces personal data, picks `fallback`. */
function answers(fallback: string | undefined): void {
  vs.pick.push((items) => items.filter((x) => x.picked));
  vs.input = '';
  vs.pick.push((items) => items[0]);
  vs.answer.push(fallback);
}

function serve(body: Record<string, unknown>, status = 200): void {
  seq++;
  const x: Exchange = {
    id: `s${seq}`,
    startedAt: 1_800_000_000_000 + seq,
    method: 'GET',
    url: `${A}/users/42`,
    requestHeaders: {},
    status,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: { text: JSON.stringify(body), encoding: 'utf8' },
    state: 'completed',
  };
  traffic.push(x);
  for (const l of listeners) l(x);
}

const recordedUser = (extra: Record<string, unknown>) => ({
  id: 42, name: 'Ada', email: 'x@y.dev', phone: '1', rating: 4.5, seen: 1, address: { street: 'a', city: 'b', zip: 'c' }, lat: 1, lng: 2, avatarUrl: 'https://cdn.example/a.png', bio: 'b', big: 1, ...extra,
});

describe('a fake backend from this session (§23.2)', () => {
  it('servers (JSON ones chosen), name, personal data, then the modal; offline writes unmatched "fail"; the file opens for review', async () => {
    answers("Offline: fail what wasn't recorded");
    const r = await svc.mockFromTrafficInteractive({ session: {} });
    expect(r).toMatchObject({ id: NAME, endpoints: 10 }); // no throttle-only rule here: /settings is skipped
    const servers = vs.quickPicks[0].items as { label: string; picked: boolean }[];
    expect(servers.map((s) => [s.label, s.picked])).toEqual([
      ['api.shop.example', true],
      ['feed.media.example:8443', true],
    ]);
    expect(vs.quickPicks[0].options.canPickMany).toBe(true);
    expect(vs.inputs[0].value).toBe('api.shop.example (recorded)');
    expect((vs.quickPicks[1].items as { label: string }[])[0].label).toMatch(/Replace e-mails, phone numbers and addresses/);
    expect(vs.modals).toHaveLength(1);
    expect(vs.modals[0].items).toEqual(['Fall back to the real server', "Offline: fail what wasn't recorded"]);
    expect(vs.modals[0].detail).toContain('Credentials removed; example bodies are real data — review before committing');
    expect(JSON.parse(fs.text(FILE)!).collections[0]).toMatchObject({ id: NAME, unmatched: 'fail' });
    expect(vs.shown).toEqual([{ uri: { fsPath: COL, scheme: 'file' }, options: { preview: true, preserveFocus: true } }]);
  });

  it('cancelling any step writes nothing', async () => {
    for (const step of [0, 1, 2, 3]) {
      vs.pick = [];
      vs.answer = [];
      if (step > 0) vs.pick.push((items) => items.filter((x) => x.picked));
      vs.input = step > 1 ? '' : undefined;
      if (step > 2) vs.pick.push((items) => items[1]);
      expect(await svc.mockFromTrafficInteractive({ session: {} })).toBeUndefined();
    }
    expect(fs.files.has(COL)).toBe(false);
    expect(fs.text(FILE)).toBeUndefined();
  });

  it('nothing recorded: an error, no dialog', async () => {
    traffic = [];
    await expect(svc.mockFromTrafficInteractive({ session: {} })).rejects.toThrow(/Run the app against the real server first/);
    expect(vs.quickPicks).toEqual([]);
  });
});

describe('drift and Update example (§23.3, §23.4)', () => {
  async function drifted(): Promise<void> {
    answers('Fall back to the real server');
    await svc.mockFromTrafficInteractive({ session: {} });
    await svc.update(NAME, { enabled: false });
    for (let k = 0; k < 3; k++) serve(recordedUser({ tier: 'gold' }));
  }

  it('exchange events are looked at after the 500 ms debounce; onDidChangeDrift fires; the setting turns it off', async () => {
    let fired = 0;
    svc.onDidChangeDrift(() => fired++);
    await drifted();
    expect(svc.drift(NAME)).toEqual([]);
    await vi.advanceTimersByTimeAsync(499);
    expect(fired).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toBe(1);
    expect(svc.state()[0].drift?.line).toBe('GET /users/:userId now has tier');
    driftOn = false;
    svc.refreshDrift();
    expect(fired).toBe(2);
    expect(svc.state()[0].drift).toBeUndefined();
  });

  it('Update example: a read-only before / after in vscode.diff, then the modal; cancel keeps the file, confirm writes it', async () => {
    await drifted();
    await vi.advanceTimersByTimeAsync(500);
    const before = fs.text(COL)!;
    vs.answer.push(undefined);
    expect(await svc.updateExampleInteractive(NAME, USER, 200)).toBe('cancelled');
    expect(fs.text(COL)).toBe(before);
    const [cmd, left, right, title] = vs.commands[0] as [string, { path: string; query: string }, { path: string; query: string }, string];
    expect(cmd).toBe('vscode.diff');
    expect(title).toBe(`${NAME}.json: update example "200 OK"`);
    const p = vs.providers.get(EXAMPLE_DIFF_SCHEME)!;
    expect(p.provideTextDocumentContent(left)).toBe(before);
    const after = p.provideTextDocumentContent(right);
    expect(after).toContain('tier');
    const modal = vs.modals.at(-1)!;
    expect(modal.kind).toBe('warning');
    expect(modal.items).toEqual(['Update example']);
    expect(modal.detail).toMatch(/shared with the team.*remembered data restarts.*approval again/s);
    // no temp file anywhere in the project
    expect([...fs.files.keys()].filter((f) => f.includes('tmp') || f.endsWith('.orig'))).toEqual([]);
    vs.answer.push('Update example');
    expect(await svc.updateExampleInteractive(NAME, USER, 200)).toBe('updated');
    expect(fs.text(COL)).toBe(after);
  });

  it('a YAML collection: "Copy the updated example" to the clipboard, the file untouched', async () => {
    const yaml = ['openapi: 3.0.3', 'info: {title: Pets, version: "1"}', 'servers: [{url: "https://pets.example"}]', 'paths:', '  /pets/{id}:', '    get:', '      responses:', '        "200":', '          description: ok', '          content:', '            application/json:', '              example: {id: 1, name: Rex}', ''].join('\n');
    fs.put(`${ROOT}/api/pets.yaml`, yaml);
    const { id } = await svc.importFile({ file: 'api/pets.yaml' });
    for (let k = 0; k < 3; k++) {
      seq++;
      const x: Exchange = { id: `p${seq}`, startedAt: seq, method: 'GET', url: 'https://pets.example/pets/1', requestHeaders: {}, status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: { text: '{"id":1,"name":"Fido","owner":"me@pets.dev"}', encoding: 'utf8' }, state: 'completed' };
      traffic.push(x);
      for (const l of listeners) l(x);
    }
    await vi.advanceTimersByTimeAsync(500);
    vs.answer.push('Copy the updated example');
    expect(await svc.updateExampleInteractive(id, 'GET /pets/{id}', 200)).toBe('copied');
    expect(JSON.parse(vs.clipboard)).toEqual({ id: 1, name: 'Rex', owner: 'user1@example.com' });
    expect(vs.modals.at(-1)!.message).toMatch(/OpenAPI YAML files are not edited here/);
    expect(vs.commands).toEqual([]);
    expect(fs.text(`${ROOT}/api/pets.yaml`)).toBe(yaml);
  });
});

describe('panel messages (§23.2–§23.4)', () => {
  function handlers() {
    const refresh = vi.fn();
    const c = { deps: { collections: svc }, refreshCollectionViews: refresh } as unknown as InterceptController;
    return { h: createViewHandlers(c), refresh };
  }
  const reply = () => undefined;

  it('mockFromTraffic: "session" or {recording}; unknown keys refused; Status follows', async () => {
    const { h, refresh } = handlers();
    answers('Fall back to the real server');
    await h.mockFromTraffic({ type: 'mockFromTraffic', source: 'session' }, reply);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(svc.state().map((s) => s.id)).toEqual([NAME]);
    await expect(h.mockFromTraffic({ type: 'mockFromTraffic', source: 'everything' } as never, reply)).rejects.toThrow(/source must be "session" or \{recording\}/);
    await expect(h.mockFromTraffic({ type: 'mockFromTraffic', source: { recording: 'r', path: '/x' } } as never, reply)).rejects.toThrow(/unknown/i);
    await expect(h.mockFromTraffic({ type: 'mockFromTraffic', source: 'session', file: 'x' } as never, reply)).rejects.toThrow(/unknown/i);
    answers('Fall back to the real server');
    await h.mockFromTraffic({ type: 'mockFromTraffic', source: { recording: 'r1' } }, reply);
    expect(svc.state().map((s) => s.id)).toEqual([NAME, `${NAME}-2`]);
  });

  it('updateExample / ignoreDrift: checked, then done, then Status again', async () => {
    const { h, refresh } = handlers();
    await expect(h.updateExample({ type: 'updateExample', id: 'Bad Id', endpoint: USER, status: 200 }, reply)).rejects.toThrow(/id must be a collection id/);
    await expect(h.updateExample({ type: 'updateExample', id: NAME, endpoint: USER, status: 99 }, reply)).rejects.toThrow(/status must be 100–599/);
    await expect(h.updateExample({ type: 'updateExample', id: NAME, endpoint: USER, status: 200, mode: 'replace' } as never, reply)).rejects.toThrow(/mode must be/);
    await expect(h.ignoreDrift({ type: 'ignoreDrift', id: NAME, status: 200 }, reply)).rejects.toThrow(/status needs an endpoint/);
    answers('Fall back to the real server');
    await svc.mockFromTrafficInteractive({ session: {} });
    await svc.update(NAME, { enabled: false });
    for (let k = 0; k < 3; k++) serve(recordedUser({ tier: 'gold' }));
    await vi.advanceTimersByTimeAsync(500);
    // §24.9: merge on a status without an example is refused
    for (let k = 0; k < 3; k++) serve({ error: 'x' }, 409);
    await vi.advanceTimersByTimeAsync(500);
    await expect(h.updateExample({ type: 'updateExample', id: NAME, endpoint: USER, status: 409 }, reply)).rejects.toThrow(/no example to merge into/);
    expect(refresh).toHaveBeenCalledTimes(1);
    await h.ignoreDrift({ type: 'ignoreDrift', id: NAME }, reply);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(svc.drift(NAME)).toEqual([]);
    expect(svc.state()[0].drift).toBeUndefined();
  });
});
