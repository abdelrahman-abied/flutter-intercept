/**
 * Sidecar layer of "Mock from a collection" (CONTRACTS §21.6, §21.7, §21.11): wires MockCollectionsCore
 * (packages/extension/src/mocks/core.ts) to the sidecar's shared rules, JSON state store, Node file watching and
 * IDE requests (types.ts `SidecarRequest`):
 *
 *   ui.chooseCollectionFile   {defaultDir?}       → absolute path | null (cancelled)
 *   ui.confirmCopyCollection  {fileName}          → 'sanitised' | 'as-is' | null (cancelled)
 *   ui.askCollectionVariable  {name, origins}     → http(s) URL | null (cancelled)
 *   ui.confirmRemoveCollection {name, file}       → true to remove (native modal; anything else = no)
 *
 * The traffic panel never receives a file path: choosing a file, confirming a copy into the project and confirming
 * removal all happen in the IDE. Collection and environment files are watched by exact path (non-recursive `fs.watch`
 * on each parent directory, matched against the files in use).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Rule } from '@flutter-intercept/proxy';
import { decodeWorkspaceFile, type RulesFs, type WorkspaceFileSpec } from '../../extension/src/rules/bodyFile';
import type { MementoLike } from '../../extension/src/rules/core';
import { MockCollectionsCore, type CollectionParsers } from '../../extension/src/mocks/core';
import { COLLECTION_LIMITS } from '../../extension/src/mocks/types';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus } from '../../extension/src/ui/protocol';
import { RpcFailure } from './rpc';
import { nodeRulesFs, type NodeSharedRules } from './sharedRules';

export const COLLECTION_FILE_METHOD = 'ui.chooseCollectionFile';
export const COLLECTION_COPY_METHOD = 'ui.confirmCopyCollection';
export const COLLECTION_VAR_METHOD = 'ui.askCollectionVariable';
export const COLLECTION_REMOVE_METHOD = 'ui.confirmRemoveCollection';

export const COLLECTION_CHOOSER_BUSY = 'A file chooser is already open in the IDE.';

const MAX_PATH = 4096;
const MAX_VARIABLE_VALUE = 2048;
const MAX_WATCHED_DIRS = 64;
const MAX_WATCHED_FILES = 256;
const COLLECTION_FILE_SPEC: WorkspaceFileSpec = { what: 'collection file', maxBytes: COLLECTION_LIMITS.fileBytes, maxLabel: '20 MB' };

export interface SidecarCollectionsDeps {
  shared: Pick<NodeSharedRules, 'ready' | 'collectionLinks' | 'onDidChangeCollections' | 'primaryFolderPath' | 'saveCollections' | 'writeWorkspaceFile'>;
  roots(): string[];
  memento: MementoLike;
  parsers: CollectionParsers;
  newRuleId(): string;
  /** Sends a `SidecarRequest` to the IDE plugin. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Shows a fire-and-forget IDE notification. */
  notify?(level: 'info' | 'warning' | 'error', message: string): Promise<unknown>;
  /** Origins seen in this session's traffic (offered when a URL variable has no value). */
  seenOrigins?(): string[];
  log?(msg: string): void;
  debounceMs?: number;
  /** Tests: a fake file system. */
  fs?: RulesFs;
}

export interface SidecarCollections {
  readonly ready: Promise<void>;
  state(): CollectionStatus[];
  rules(): Rule[];
  fileProblems(): string[];
  onDidChange(listener: () => void): { dispose(): void };
  endpoints(id: string): CollectionEndpointView[];
  example(id: string, endpoint: string, name: string): { status: number; headers: Record<string, string>; body: string; truncated?: true };
  toRule(id: string, endpoint: string): Rule;
  update(id: string, patch: CollectionPatch): Promise<void>;
  removeWithConfirmation(id: string): Promise<boolean>;
  /** Agents (§21.10): workspace-relative files inside the workspace only; no copying, no dialogs. */
  importFile(pick: { file: string; environment?: string }): Promise<{ id: string }>;
  /** Command / panel flow: IDE file chooser, copy modal for outside files, unset URL variables. */
  importInteractive(): Promise<{ id: string } | undefined>;
  reload(): Promise<void>;
  dispose(): void;
}

/** A path returned by the IDE's file chooser: absolute, one line, bounded. Undefined otherwise. */
export function usableCollectionPath(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v || v.length > MAX_PATH || /[\0\r\n]/.test(v) || !path.isAbsolute(v)) return undefined;
  return v;
}

/** A URL variable value returned by the IDE: trimmed `http://` or `https://` URL, one line, bounded. */
export function usableVariableUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > MAX_VARIABLE_VALUE || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  if (!/^https?:\/\/[^\s/?#]+/i.test(trimmed)) return undefined;
  return trimmed;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function ideError(e: unknown, what: string): Error {
  const f = e as RpcFailure;
  if (f?.code === 'unknown_method') return new Error(`This IDE plugin can't ${what}: update Flutter Intercept.`);
  if (f?.code === 'closed') return new Error('The IDE connection closed.');
  const msg = e instanceof Error ? e.message.replace(/[\r\n]+/g, ' ').slice(0, 300) : '';
  return new Error(msg || `The IDE couldn't ${what}.`);
}

export function createSidecarCollections(deps: SidecarCollectionsDeps): SidecarCollections {
  const log = deps.log ?? (() => undefined);
  const notify = (level: 'info' | 'warning' | 'error', message: string) =>
    Promise.resolve(deps.notify?.(level, message)).catch((e: unknown) => log(`collections notify failed: ${String(e)}`));
  const debounceMs = deps.debounceMs ?? 300;
  const files = deps.fs ?? nodeRulesFs;
  const listeners = new Set<() => void>();
  const fireChanged = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // a listener's bug must not break the others
      }
    }
  };
  let disposed = false;
  let picking = false;

  // Exact-path watching: one non-recursive watcher per directory, events matched against the files in use.
  const dirWatchers = new Map<string, { watcher?: fs.FSWatcher; files: Set<string> }>();
  let watchedFiles = 0;
  let timer: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, debounceMs);
  };
  const onDirEvent = (dir: string, name: string | Buffer | null) => {
    const entry = dirWatchers.get(dir);
    if (!entry || !entry.files.size) return;
    if (!name) {
      scheduleReload();
      return;
    }
    const abs = path.resolve(dir, name.toString());
    if (entry.files.has(abs)) scheduleReload();
  };
  const watchFile = (abs: string) => {
    if (disposed) return;
    const resolved = path.resolve(abs);
    const dir = path.dirname(resolved);
    let entry = dirWatchers.get(dir);
    if (entry?.files.has(resolved)) return;
    if (watchedFiles >= MAX_WATCHED_FILES) return;
    if (!entry) {
      if (dirWatchers.size >= MAX_WATCHED_DIRS) return;
      let watcher: fs.FSWatcher | undefined;
      try {
        watcher = fs.watch(dir, { persistent: false }, (_ev, name) => onDirEvent(dir, name));
        watcher.on('error', () => undefined);
      } catch {
        // directory unreadable or missing: next reload re-checks
      }
      entry = { watcher, files: new Set() };
      dirWatchers.set(dir, entry);
    }
    entry.files.add(resolved);
    watchedFiles++;
  };

  const core = new MockCollectionsCore({
    links: () => deps.shared.collectionLinks(),
    saveLinks: (folder, links) => deps.shared.saveCollections(folder, links),
    primaryFolderPath: () => deps.shared.primaryFolderPath(),
    writeWorkspaceFile: (folder, rel, text) => deps.shared.writeWorkspaceFile(folder, rel, text),
    workspaceRoots: () => deps.roots(),
    fs: files,
    memento: deps.memento,
    parsers: deps.parsers,
    newRuleId: deps.newRuleId,
    log,
    watchFile,
  });

  const reload = async () => {
    if (disposed) return;
    try {
      if (await core.reload()) fireChanged();
    } catch (e) {
      log(`collections: reload failed: ${(e as Error).message}`);
    }
  };

  /** Runs a change, then tells listeners (the change already reloaded the core). */
  const after = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } finally {
      fireChanged();
    }
  };

  const linksSub = deps.shared.onDidChangeCollections(() => void reload());
  const ready = deps.shared.ready.then(reload);

  const askVariables = async (id: string): Promise<void> => {
    for (const name of core.unresolved(id).slice(0, 5)) {
      const origins = (deps.seenOrigins?.() ?? []).slice(0, 20);
      let raw: unknown;
      try {
        raw = await deps.request(COLLECTION_VAR_METHOD, { name, origins });
      } catch (e) {
        throw ideError(e, 'ask for a collection variable');
      }
      if (raw === null || raw === undefined) return;
      const value = usableVariableUrl(raw);
      if (!value) return;
      await after(core.update(id, { variable: { name, value } }));
    }
  };

  const importInteractive = async (): Promise<{ id: string } | undefined> => {
    await ready;
    const primary = await deps.shared.primaryFolderPath();
    if (!primary) {
      void notify('warning', 'Open the Flutter project folder to mock from a collection.');
      return undefined;
    }
    if (picking) {
      void notify('warning', COLLECTION_CHOOSER_BUSY);
      return undefined;
    }
    picking = true;
    let chosen: unknown;
    try {
      chosen = await deps.request(COLLECTION_FILE_METHOD, { defaultDir: primary });
    } catch (e) {
      void notify('error', `Mock from a collection: ${ideError(e, 'choose a collection file').message}`);
      return undefined;
    } finally {
      picking = false;
    }
    if (chosen === null || chosen === undefined) return undefined;
    const picked = usableCollectionPath(chosen);
    if (!picked) {
      void notify('error', "Mock from a collection: That file can't be used: choose a file on this computer.");
      return undefined;
    }
    let real: string;
    let realRoot: string;
    try {
      real = files.realpathSync(picked);
      realRoot = files.realpathSync(primary);
    } catch {
      void notify('error', `${path.basename(picked)} can't be read.`);
      return undefined;
    }
    try {
      let rel: string;
      if (inside(real, realRoot)) {
        rel = path.relative(realRoot, real).split(path.sep).join('/');
      } else {
        const st = await files.stat(real);
        if (!st.isFile()) throw new Error(`${path.basename(real)} is not a regular file`);
        if (st.size > COLLECTION_LIMITS.fileBytes) throw new Error(`${path.basename(real)} is larger than 20 MB`);
        let choice: unknown;
        try {
          choice = await deps.request(COLLECTION_COPY_METHOD, { fileName: path.basename(real) });
        } catch (e) {
          throw ideError(e, 'ask before copying a collection');
        }
        if (choice !== 'sanitised' && choice !== 'as-is') return undefined;
        const text = decodeWorkspaceFile(await files.readFile(real), path.basename(real), COLLECTION_FILE_SPEC);
        const copied = await core.copyIn(text, path.basename(real), choice);
        rel = copied.file;
        if (copied.removed.length) log(`collections: copied ${rel} without ${copied.removed.length} credential(s)`);
      }
      const { id } = await after(core.addLink({ file: rel, folderPath: primary }));
      await askVariables(id);
      const s = core.state().find((x) => x.id === id);
      if (s) {
        void notify(
          'info',
          `Mocking ${s.mocked} request${s.mocked === 1 ? '' : 's'} from "${s.name}"${s.noExample ? ` (${s.noExample} without an example answer 501)` : ''}. Hot restart the app if it's running.`,
        );
      }
      return { id };
    } catch (e) {
      void notify('error', `Mock from a collection: ${(e as Error).message}`);
      return undefined;
    }
  };

  return {
    ready,
    state: () => core.state(),
    rules: () => core.rules(),
    fileProblems: () => core.fileProblems(),
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    endpoints: (id) => core.endpoints(id),
    example: (id, endpoint, name) => core.example(id, endpoint, name),
    toRule: (id, endpoint) => core.toRule(id, endpoint),
    update: (id, patch) => after(core.update(id, patch)),
    removeWithConfirmation: async (id) => {
      const s = core.state().find((x) => x.id === id);
      if (!s) throw new Error(`No collection "${String(id).slice(0, 60)}" is linked`);
      let ok: unknown;
      try {
        ok = await deps.request(COLLECTION_REMOVE_METHOD, { name: s.name, file: s.file });
      } catch (e) {
        throw ideError(e, 'ask before removing a collection');
      }
      if (ok !== true) return false;
      await after(core.remove(id));
      return true;
    },
    importFile: (pick) => after(core.addLink(pick)),
    importInteractive,
    reload,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      linksSub.dispose();
      for (const { watcher } of dirWatchers.values()) watcher?.close();
      dirWatchers.clear();
      listeners.clear();
    },
  };
}
