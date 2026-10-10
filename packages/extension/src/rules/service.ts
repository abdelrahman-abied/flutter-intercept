/**
 * VS Code layer of the shared rules service (CONTRACTS §12.1–12.2): wires SharedRulesCore (src/rules/core.ts) to the
 * workspace folders, workspaceState and file system watchers.
 *
 * Watching: per workspace folder one watcher for `.vscode/flutter-intercept.json` and `pubspec.yaml` (root or one
 * level down — which folders count can change); events are debounced (a git checkout touches many files at once).
 * Body files get a watcher each once a rule refers to them; a change fires `onDidChangeBodyFile(<bodyFile value>)`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Rule } from '@flutter-intercept/proxy';
import type { SharedRulesService, SharedRulesState } from './types';
import type { RulesFs } from './bodyFile';
import type { ValidateRule } from './file';
import { PendingSnapshot, SharedRulesCore, SharedRulesStatus } from './core';

export { mergeRules, toPersonalRule } from './core';
export { isSharedRuleId } from './file';

export interface SharedRulesDeps {
  workspaceState: vscode.Memento;
  /** `validateRule` from src/ui/controller.ts. */
  validateRule: ValidateRule;
  log?: (msg: string) => void;
  /** Debounce for file events (ms). Default 300. */
  debounceMs?: number;
  /** Tests: a fake file system. */
  fs?: RulesFs;
}

export interface SharedRulesHost extends SharedRulesService, vscode.Disposable {
  /** Resolves after the first load. */
  readonly ready: Promise<void>;
  /** For `Status.sharedRules` (undefined: no file and nothing to report). */
  status(): SharedRulesStatus | undefined;
  /** One readable line per rule awaiting approval (sanitised), for the approval prompt. */
  pendingReasons(): string[];
  /** REVIEW-6 #6: the held rules as shown in the prompt + a hash for `approvePending(hash)`. */
  pendingSnapshot(): PendingSnapshot;
  /** Approves exactly the snapshot's rules; throws (readable) if the held set changed since. No hash: the current set. */
  approvePending(snapshotHash?: string): Promise<void>;
  /** Folder-aware: a shared rule's body file resolves in its own folder (pass the rule id). */
  resolveBodyFile(path: string, ruleId?: string): Promise<string>;
  /** REVIEW-6 #5: why `text` must not be written to a body file (looks like a credential), or undefined. Call before
   *  writing any body file ("Edit body in a file" / "Create file"). `createBodyFile` refuses on its own. */
  checkBodyFileContent(text: string): string | undefined;
  /** `rules` with every `mock.bodyFile` read into `body`; rules whose file can't be used are left out with a problem. */
  resolveBodies(rules: Rule[]): Promise<{ rules: Rule[]; problems: string[] }>;
  /** "Edit body in a file": creates `.vscode/flutter-intercept/mocks/<name>.json`, returns the `bodyFile` value. */
  createBodyFile(rule: Rule, text: string): Promise<string>;
  /** Absolute path of a rule's body file (for opening it in an editor); undefined for an invalid path. */
  bodyFilePath(bodyFile: string, ruleId?: string): string | undefined;
  /** Moves a personal rule into the file; returns it as shared. */
  share(rule: Rule): Promise<Rule>;
  /** Removes a shared rule from the file; returns its personal copy (to add to the personal list). */
  unshare(id: string): Promise<Rule>;
  /** Deletes a shared rule from its file, also one awaiting approval. */
  removeShared(id: string): Promise<void>;
  /** Every valid shared rule in file order (active + awaiting approval); edit one and pass the list to `save`. */
  fileRules(): Rule[];
  /** The shared files in use (primary first), e.g. to open them. */
  files(): { path: string; label: string; folder: string }[];
  /** Re-reads the files now. */
  reload(): Promise<void>;
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

const MAX_BODY_WATCHED_FILES = 256;
const MAX_BODY_WATCHED_DIRS = 64;

export function createSharedRulesService(deps: SharedRulesDeps): SharedRulesHost {
  const log = deps.log ?? (() => undefined);
  const debounceMs = deps.debounceMs ?? 300;
  const changed = new vscode.EventEmitter<SharedRulesState>();
  const bodyChanged = new vscode.EventEmitter<string>();
  const disposables: vscode.Disposable[] = [changed, bodyChanged];
  let disposed = false;

  // REVIEW-6 #12: a body file path may contain glob characters ("[id].json", "**"), so it is never used as a glob:
  // each directory is watched for its direct children ("*") and events are matched against exact paths.
  const dirWatchers = new Map<string, { watcher: vscode.Disposable; files: Map<string, Set<string>> }>();
  let watchedFiles = 0;
  const bodyTimers = new Map<string, NodeJS.Timeout>();
  const onBodyEvent = (uri: vscode.Uri) => {
    const abs = path.resolve(uri.fsPath);
    const rels = dirWatchers.get(path.dirname(abs))?.files.get(abs);
    if (!rels) return;
    clearTimeout(bodyTimers.get(abs));
    bodyTimers.set(
      abs,
      setTimeout(() => {
        bodyTimers.delete(abs);
        core.invalidateBodyFile();
        for (const rel of rels) bodyChanged.fire(rel);
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
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*'));
      watcher.onDidCreate(onBodyEvent);
      watcher.onDidChange(onBodyEvent);
      watcher.onDidDelete(onBodyEvent);
      entry = { watcher, files: new Map() };
      dirWatchers.set(dir, entry);
    }
    const rels = entry.files.get(abs) ?? new Set<string>();
    if (!rels.size) watchedFiles++;
    rels.add(rel);
    entry.files.set(abs, rels);
  };

  const core = new SharedRulesCore({
    folders: () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => ({ name: f.name, path: f.uri.fsPath })),
    fs: deps.fs ?? nodeRulesFs,
    validateRule: deps.validateRule,
    memento: deps.workspaceState,
    log,
    watchBodyFile,
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
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, debounceMs);
  };

  let folderWatchers: vscode.Disposable[] = [];
  const watchFolders = () => {
    for (const w of folderWatchers) w.dispose();
    folderWatchers = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '{.vscode/flutter-intercept.json,pubspec.yaml,*/pubspec.yaml}'));
      w.onDidCreate(scheduleReload);
      w.onDidChange(scheduleReload);
      w.onDidDelete(scheduleReload);
      folderWatchers.push(w);
    }
  };
  watchFolders();
  disposables.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watchFolders();
      scheduleReload();
    }),
  );

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
    state: () => core.state(),
    status: () => core.status(),
    pendingReasons: () => core.pendingReasons(),
    files: () => core.files(),
    fileRules: () => core.fileRules(),
    onDidChange: (listener) => changed.event(listener),
    onDidChangeBodyFile: (listener) => bodyChanged.event(listener),
    save: (rules) => after(core.save(rules)),
    share: (rule) => after(core.share(rule)),
    unshare: (id) => after(core.unshare(id)),
    removeShared: (id) => after(core.removeShared(id)),
    approvePending: (snapshotHash?: string) => after(core.approvePending(snapshotHash)).then(() => undefined),
    pendingSnapshot: () => core.pendingSnapshot(),
    checkBodyFileContent: (text) => core.checkBodyFileContent(text),
    resolveBodyFile: (p, ruleId?: string) => core.readBodyFile(p, core.folderPathFor(ruleId)),
    resolveBodies: (rules) => core.resolveBodies(rules),
    createBodyFile: (rule, text) => core.createBodyFile(rule, text),
    bodyFilePath: (bodyFile, ruleId) => core.bodyFilePath(bodyFile, ruleId),
    reload,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      for (const t of bodyTimers.values()) clearTimeout(t);
      for (const w of folderWatchers) w.dispose();
      for (const { watcher } of dirWatchers.values()) watcher.dispose();
      dirWatchers.clear();
      for (const d of disposables) d.dispose();
    },
  };
}
