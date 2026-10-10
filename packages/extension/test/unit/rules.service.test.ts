import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, mock, ROOT } from './rules.fakes';

const vs = vi.hoisted(() => ({
  folders: [] as { name: string; uri: { fsPath: string; scheme: string } }[],
  watchers: [] as { pattern: string; base: string; create: ((u?: unknown) => void)[]; change: ((u?: unknown) => void)[]; del: ((u?: unknown) => void)[]; disposed: boolean }[],
  folderListeners: [] as (() => void)[],
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
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
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
      onDidChangeWorkspaceFolders: (l: () => void) => {
        vs.folderListeners.push(l);
        return { dispose: () => undefined };
      },
    },
  };
});

import { createSharedRulesService } from '../../src/rules/service';

const fileJson = (rules: unknown[]) => JSON.stringify({ version: 1, rules });

let fs: FakeFs;

beforeEach(() => {
  vi.useFakeTimers();
  vs.folders = [{ name: 'app', uri: { fsPath: ROOT, scheme: 'file' } }];
  vs.watchers = [];
  vs.folderListeners = [];
  fs = new FakeFs();
  fs.put(`${ROOT}/pubspec.yaml`, 'name: app\n');
});

afterEach(() => {
  vi.useRealTimers();
});

const create = () => createSharedRulesService({ workspaceState: new FakeMemento() as never, validateRule: fakeValidateRule, fs, debounceMs: 300 });

describe('createSharedRulesService', () => {
  it('loads on start, watches the file, debounces bursts (git checkout) into one reload', async () => {
    fs.put(FILE, fileJson([mock('a')]));
    const svc = create();
    await svc.ready;
    expect(svc.state().rules.map((r) => r.id)).toEqual(['shared:a']);
    expect(vs.watchers.map((w) => [w.base, w.pattern])).toEqual([[ROOT, '{.vscode/flutter-intercept.json,pubspec.yaml,*/pubspec.yaml}']]);

    const changes: string[][] = [];
    svc.onDidChange((s) => changes.push(s.rules.map((r) => r.id)));
    const w = vs.watchers[0];
    fs.put(FILE, '{ broken');
    w.change.forEach((l) => l());
    fs.put(FILE, fileJson([mock('b')]));
    w.change.forEach((l) => l());
    fs.files.delete(FILE);
    w.del.forEach((l) => l());
    fs.put(FILE, fileJson([mock('c')]));
    w.create.forEach((l) => l());
    await vi.advanceTimersByTimeAsync(299);
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(changes).toEqual([['shared:c']]));
    expect(svc.status()).toEqual({ file: '.vscode/flutter-intercept.json', count: 1, problems: [], pendingApproval: 0 });
    svc.dispose();
    expect(vs.watchers[0].disposed).toBe(true);
  });

  it('fires onDidChange after save / approve, and onDidChangeBodyFile for watched body files', async () => {
    fs.put(FILE, fileJson([{ id: 'm', match: { url: '*' }, action: { kind: 'mapRemote', to: 'https://staging.example.com' } }]));
    const svc = create();
    await svc.ready;
    const events: number[] = [];
    svc.onDidChange((s) => events.push(s.pendingApproval.length));
    await svc.approvePending();
    expect(events).toEqual([0]);

    fs.put(`${ROOT}/m.json`, 'one');
    const bodyEvents: string[] = [];
    svc.onDidChangeBodyFile((p) => bodyEvents.push(p));
    expect(await svc.resolveBodyFile('m.json')).toBe('one');
    const w = vs.watchers.find((x) => x.base === ROOT && x.pattern === '*')!;
    const at = (p: string) => ({ fsPath: p, scheme: 'file' });
    fs.put(`${ROOT}/m.json`, 'two');
    w.change.forEach((l) => l(at(`${ROOT}/m.json`)));
    w.change.forEach((l) => l(at(`${ROOT}/m.json`)));
    w.change.forEach((l) => l(at(`${ROOT}/other.json`))); // same directory, not a body file
    await vi.advanceTimersByTimeAsync(300);
    expect(bodyEvents).toEqual(['m.json']);
    expect(await svc.resolveBodyFile('m.json')).toBe('two');
    expect(vs.watchers.filter((x) => x.pattern === '*')).toHaveLength(1); // one watcher per directory

    await svc.save([...svc.state().rules, mock('n')]);
    expect(events).toEqual([0, 0]);
    svc.dispose();
  });

  it('a shared script file change reloads (re-holding the rule) before onDidChangeBodyFile fires (CONTRACTS §13.4)', async () => {
    fs.put(`${ROOT}/s/a.js`, 'function onRequest() {}');
    fs.put(FILE, fileJson([{ id: 's', match: { url: '*' }, action: { kind: 'script', file: 's/a.js' } }]));
    const svc = create();
    await svc.ready;
    expect(svc.pendingReasons()).toEqual(['Rule "s" (any method *): runs JavaScript that can read, change and redirect every matching request, including its credentials (s/a.js)']);
    await svc.approvePending();
    expect(svc.state().rules.map((r) => r.id)).toEqual(['shared:s']);
    expect(await svc.resolveScriptFile('s/a.js', 'shared:s')).toBe('function onRequest() {}');
    expect((await svc.resolveBodies(svc.state().rules)).rules.map((r) => (r.action as { code: string }).code)).toEqual(['function onRequest() {}']);

    const seen: { path: string; pending: number }[] = [];
    svc.onDidChangeBodyFile((p) => seen.push({ path: p, pending: svc.state().pendingApproval.length }));
    const w = vs.watchers.find((x) => x.base === `${ROOT}/s` && x.pattern === '*')!;
    fs.put(`${ROOT}/s/a.js`, 'function onRequest() { /* changed */ }');
    w.change.forEach((l) => l({ fsPath: `${ROOT}/s/a.js`, scheme: 'file' }));
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(seen).toEqual([{ path: 's/a.js', pending: 1 }]));
    await expect(svc.resolveScriptFile('s/a.js', 'shared:s')).rejects.toThrow('is not approved for this shared rule');
    svc.dispose();
  });

  it('personal script files: held until approved, onDidChange fires, approval and saves in VS Code release them (REVIEW-7 #1)', async () => {
    fs.put(`${ROOT}/s/p.js`, 'function onRequest() {}');
    const svc = create();
    await svc.ready;
    const changes: string[][] = [];
    svc.onDidChange((st) => changes.push(st.pendingApproval.map((r) => r.id)));
    const rule = { id: 'p', enabled: true, match: { url: '*' }, action: { kind: 'script' as const, code: '', file: 's/p.js' } };
    await expect(svc.resolveScriptFile('s/p.js', 'p')).rejects.toThrow(/waits for your approval/);
    expect(changes).toEqual([['p']]);
    await svc.setPersonalRules([rule]);
    expect(changes).toEqual([['p']]); // same holds: no event
    await svc.approvePending(svc.pendingSnapshot().hash);
    expect(changes).toEqual([['p'], []]);
    expect(await svc.resolveScriptFile('s/p.js', 'p')).toBe('function onRequest() {}');

    // a change from outside: the watcher reloads (holding the rule) before onDidChangeBodyFile fires
    const seen: number[] = [];
    svc.onDidChangeBodyFile(() => seen.push(svc.state().pendingApproval.length));
    const w = vs.watchers.find((x) => x.base === `${ROOT}/s` && x.pattern === '*')!;
    fs.put(`${ROOT}/s/p.js`, 'function onRequest() { /* pulled */ }');
    w.change.forEach((l) => l({ fsPath: `${ROOT}/s/p.js`, scheme: 'file' }));
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(seen).toEqual([1]));
    expect(await svc.noteScriptFileSaved(`${ROOT}/s/p.js`)).toBe(true);
    expect(svc.state().pendingApproval).toEqual([]);
    fs.put(`${ROOT}/s/p.js`, 'function onRequest() { /* again */ }');
    await svc.approveScriptFile('s/p.js', 'p');
    expect(svc.state().pendingApproval).toEqual([]);
    svc.dispose();
  });

  it('createScriptFile / checkScriptFileContent', async () => {
    const svc = create();
    await svc.ready;
    const rel = await svc.createScriptFile({ id: 'r', enabled: true, name: 'Hdr', match: { url: '*' }, action: { kind: 'script', code: '' } });
    expect(rel).toBe('.vscode/flutter-intercept/scripts/hdr.js');
    expect(fs.text(`${ROOT}/${rel}`)).toContain('function onRequest(request, context)');
    expect(svc.checkScriptFileContent('const password = "s3cr3t-pa55";')).toMatch(/^Not written:/);
    svc.dispose();
  });

  it('never uses a body file path as a glob (REVIEW-6 #12)', async () => {
    const svc = create();
    await svc.ready;
    fs.put(`${ROOT}/mocks/[id].json`, 'x');
    const bodyEvents: string[] = [];
    svc.onDidChangeBodyFile((p) => bodyEvents.push(p));
    await svc.resolveBodyFile('mocks/[id].json');
    await svc.resolveBodyFile('**/*').catch(() => undefined);
    const patterns = vs.watchers.slice(1).map((w) => [w.base, w.pattern]);
    expect(patterns).toEqual([[`${ROOT}/mocks`, '*'], [`${ROOT}/**`, '*']]);
    const w = vs.watchers[1];
    w.change.forEach((l) => l({ fsPath: `${ROOT}/mocks/i.json`, scheme: 'file' })); // "[id]" as a glob would match this
    w.change.forEach((l) => l({ fsPath: `${ROOT}/mocks/[id].json`, scheme: 'file' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(bodyEvents).toEqual(['mocks/[id].json']);
    svc.dispose();
  });

  it('exposes the pending snapshot and approves by its hash', async () => {
    fs.put(FILE, fileJson([{ id: 'm', match: { url: '*' }, action: { kind: 'mapRemote', to: 'https://staging.example.com' } }]));
    const svc = create();
    await svc.ready;
    const snap = svc.pendingSnapshot();
    expect(snap.items.map((i) => i.name)).toEqual(['"m"']);
    await expect(svc.approvePending('stale')).rejects.toThrow(/changed while you were deciding/);
    await svc.approvePending(snap.hash);
    expect(svc.state().pendingApproval).toEqual([]);
    svc.dispose();
  });

  it('re-watches and reloads when workspace folders change', async () => {
    const svc = create();
    await svc.ready;
    vs.folders = [...vs.folders, { name: 'api', uri: { fsPath: '/ws/api', scheme: 'file' } }];
    fs.put('/ws/api/pubspec.yaml', 'name: api\n');
    fs.put('/ws/api/.vscode/flutter-intercept.json', fileJson([mock('x')]));
    vs.folderListeners.forEach((l) => l());
    expect(vs.watchers.filter((w) => !w.disposed).map((w) => w.base)).toEqual([ROOT, '/ws/api']);
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(svc.state().rules.map((r) => r.id)).toEqual(['shared@api:x']));
    svc.dispose();
  });
});
