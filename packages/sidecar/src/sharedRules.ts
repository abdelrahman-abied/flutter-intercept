/**
 * Shared rules for the sidecar (CONTRACTS §12.1–12.2, §13.4): packages/extension/src/rules/core.ts wired to the
 * IDE project roots, the JSON state store (approvals) and Node file watching instead of VS Code's.
 *
 * Watching: per project root, `fs.watchFile` (1 s stat polling, works for files that don't exist yet) on
 * `.vscode/flutter-intercept.json`, `pubspec.yaml` and the `pubspec.yaml` of each direct child folder, plus a
 * non-recursive `fs.watch` on the root (new child projects). Body and script files a rule refers to get a
 * non-recursive `fs.watch` on their folder, matched by exact path (never globbed, REVIEW-6 #12). Events are debounced.
 * A script file changed on disk re-holds its rule until approved (REVIEW-7 #1); the plugin may report saves done
 * in the IDE with `fileSaved` (approves like VS Code's onDidSaveTextDocument).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Rule } from '@flutter-intercept/proxy';
import { SharedRulesCore } from '../../extension/src/rules/core';
import type { PendingSnapshot, SharedRulesStatus } from '../../extension/src/rules/core';
import type { RulesFs } from '../../extension/src/rules/bodyFile';
import type { ValidateRule } from '../../extension/src/rules/file';
import type { SharedRulesState } from '../../extension/src/rules/types';
import type { Memento } from './state';

export interface NodeSharedRulesDeps {
  /** Project roots (absolute), in order. */
  roots(): string[];
  memento: Memento;
  validateRule: ValidateRule;
  log?(msg: string): void;
  debounceMs?: number;
  /** Stat polling interval for the shared files (ms). Default 1000. */
  pollMs?: number;
}

export const nodeRulesFs: RulesFs = {
  readFile: (p) => fs.promises.readFile(p),
  writeFile: (p, data) => fs.promises.writeFile(p, data, 'utf8'),
  rename: (a, b) => fs.promises.rename(a, b),
  unlink: (p) => fs.promises.unlink(p),
  mkdir: async (p) => {
    await fs.promises.mkdir(p, { recursive: true });
  },
  stat: (p) => fs.promises.stat(p),
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  realpathSync: (p) => fs.realpathSync.native(p),
};

type Listener<T> = (v: T) => void;
class Emitter<T> {
  private readonly ls = new Set<Listener<T>>();
  event = (l: Listener<T>) => {
    this.ls.add(l);
    return { dispose: () => void this.ls.delete(l) };
  };
  fire(v: T): void {
    for (const l of [...this.ls]) {
      try {
        l(v);
      } catch {
        // a listener's bug must not break the others
      }
    }
  }
}

const MAX_BODY_WATCHED_FILES = 256;
const MAX_BODY_WATCHED_DIRS = 64;

export type NodeSharedRules = ReturnType<typeof createNodeSharedRules>;

export function createNodeSharedRules(deps: NodeSharedRulesDeps) {
  const log = deps.log ?? (() => undefined);
  const debounceMs = deps.debounceMs ?? 300;
  const pollMs = deps.pollMs ?? 1000;
  const changed = new Emitter<SharedRulesState>();
  const bodyChanged = new Emitter<string>();
  let disposed = false;

  const dirWatchers = new Map<string, { watcher?: fs.FSWatcher; files: Map<string, Set<string>> }>();
  let watchedFiles = 0;
  const bodyTimers = new Map<string, NodeJS.Timeout>();
  const onBodyEvent = (abs: string) => {
    const rels = dirWatchers.get(path.dirname(abs))?.files.get(abs);
    if (!rels) return;
    clearTimeout(bodyTimers.get(abs));
    bodyTimers.set(
      abs,
      setTimeout(() => {
        bodyTimers.delete(abs);
        core.invalidateBodyFile();
        const fire = () => {
          for (const rel of rels) bodyChanged.fire(rel);
        };
        if (core.isScriptFile(abs)) void reload().then(fire);
        else fire();
      }, debounceMs),
    );
  };
  const watchBodyFile = (folder: string, rel: string) => {
    if (disposed) return;
    const abs = path.resolve(folder, rel);
    const dir = path.dirname(abs);
    let entry = dirWatchers.get(dir);
    if (entry?.files.get(abs)?.has(rel)) return;
    if (watchedFiles >= MAX_BODY_WATCHED_FILES) return;
    if (!entry) {
      if (dirWatchers.size >= MAX_BODY_WATCHED_DIRS) return;
      let watcher: fs.FSWatcher | undefined;
      try {
        watcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
          if (name) onBodyEvent(path.join(dir, name.toString()));
          else for (const f of dirWatchers.get(dir)?.files.keys() ?? []) onBodyEvent(f);
        });
        watcher.on('error', () => undefined);
      } catch {
        // the folder doesn't exist yet: the file is re-read on the next reload
      }
      entry = { watcher, files: new Map() };
      dirWatchers.set(dir, entry);
    }
    const rels = entry.files.get(abs) ?? new Set<string>();
    if (!rels.size) watchedFiles++;
    rels.add(rel);
    entry.files.set(abs, rels);
  };

  const core = new SharedRulesCore({
    folders: () => deps.roots().map((p) => ({ name: path.basename(p), path: p })),
    fs: nodeRulesFs,
    validateRule: deps.validateRule,
    memento: deps.memento,
    log,
    watchBodyFile,
    requestReload: () => scheduleReload(),
  });

  const reload = async () => {
    if (disposed) return;
    try {
      if (await core.reload()) changed.fire(core.state());
    } catch (e) {
      log(`shared rules: reload failed: ${(e as Error).message}`);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, debounceMs);
  };

  // Shared files + pubspecs (polled), root folders (fs.watch for new child projects).
  let polled = new Set<string>();
  let rootWatchers: fs.FSWatcher[] = [];
  const onPoll = (cur: fs.Stats, prev: fs.Stats) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size || cur.ino !== prev.ino) scheduleReload();
  };
  const watchFolders = () => {
    if (disposed) return;
    const want = new Set<string>();
    for (const root of deps.roots()) {
      want.add(path.join(root, '.vscode', 'flutter-intercept.json'));
      want.add(path.join(root, 'pubspec.yaml'));
      try {
        for (const c of fs.readdirSync(root, { withFileTypes: true })) {
          if (c.isDirectory() && !c.name.startsWith('.')) want.add(path.join(root, c.name, 'pubspec.yaml'));
        }
      } catch {
        // unreadable root
      }
    }
    for (const f of polled) if (!want.has(f)) fs.unwatchFile(f, onPoll);
    for (const f of want) if (!polled.has(f)) fs.watchFile(f, { interval: pollMs, persistent: false }, onPoll);
    polled = want;
    for (const w of rootWatchers) w.close();
    rootWatchers = [];
    for (const root of deps.roots()) {
      try {
        const w = fs.watch(root, { persistent: false }, (ev) => {
          if (ev === 'rename') {
            watchFolders();
            scheduleReload();
          }
        });
        w.on('error', () => undefined);
        rootWatchers.push(w);
      } catch {
        // missing root
      }
    }
  };
  watchFolders();

  const after = async <T>(p: Promise<T>): Promise<T> => {
    const before = JSON.stringify(core.state());
    try {
      return await p;
    } finally {
      if (JSON.stringify(core.state()) !== before) changed.fire(core.state());
    }
  };

  const ready = reload();

  return {
    ready,
    state: (): SharedRulesState => core.state(),
    status: (): SharedRulesStatus | undefined => core.status(),
    pendingReasons: (): string[] => core.pendingReasons(),
    files: () => core.files(),
    fileRules: (): Rule[] => core.fileRules(),
    onDidChange: (listener: (s: SharedRulesState) => void) => changed.event(listener),
    onDidChangeBodyFile: (listener: (p: string) => void) => bodyChanged.event(listener),
    save: (rules: Rule[]) => after(core.save(rules)),
    share: (rule: Rule) => after(core.share(rule)),
    unshare: (id: string) => after(core.unshare(id)),
    removeShared: (id: string) => after(core.removeShared(id)),
    approvePending: (snapshotHash?: string) => after(core.approvePending(snapshotHash)).then(() => undefined),
    pendingSnapshot: (): PendingSnapshot => core.pendingSnapshot(),
    checkBodyFileContent: (text: string) => core.checkBodyFileContent(text),
    resolveBodyFile: (p: string, ruleId?: string) => core.readBodyFile(p, core.folderPathFor(ruleId)),
    resolveBodies: (rules: Rule[]) => core.resolveBodies(rules),
    createBodyFile: (rule: Rule, text: string) => core.createBodyFile(rule, text),
    resolveScriptFile: (p: string, ruleId?: string) => after(core.readScriptFile(p, core.folderPathFor(ruleId), ruleId)),
    setPersonalRules: (rules: Rule[]) => after(core.setPersonalRules(rules)).then(() => undefined),
    approveScriptFile: (rel: string, ruleId?: string) => after(core.approveScriptFile(rel, ruleId)).then(() => undefined),
    noteScriptFileSaved: (abs: string) => after(core.noteScriptFileSaved(abs)),
    createScriptFile: (rule: Rule, code?: string) => core.createScriptFile(rule, code),
    checkScriptFileContent: (code: string) => core.checkScriptFileContent(code),
    bodyFilePath: (bodyFile: string, ruleId?: string) => core.bodyFilePath(bodyFile, ruleId),
    /** Project roots changed: re-watch and reload. */
    rootsChanged: () => {
      watchFolders();
      scheduleReload();
    },
    reload,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      for (const t of bodyTimers.values()) clearTimeout(t);
      for (const f of polled) fs.unwatchFile(f, onPoll);
      polled.clear();
      for (const w of rootWatchers) w.close();
      for (const { watcher } of dirWatchers.values()) watcher?.close();
      dirWatchers.clear();
    },
  };
}
