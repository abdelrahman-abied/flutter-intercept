/**
 * Sidecar layer of "Mock from a collection" (CONTRACTS §21.6, §21.7, §21.11): wires MockCollectionsCore
 * (packages/extension/src/mocks/core.ts) to the sidecar's shared rules, JSON state store, Node file watching and
 * IDE requests (types.ts `SidecarRequest`):
 *
 *   ui.chooseCollectionFile   {defaultDir?}       → absolute path | null (cancelled)
 *   ui.confirmCopyCollection  {fileName}          → 'sanitised' | 'as-is' | null (cancelled)
 *   ui.pick                   {title, placeholder, items} → chosen environment / option | null (cancelled) (CONTRACTS §24.4, §23.2)
 *   ui.pickMany               {title, placeholder, items, okButton?} → chosen values[] | null (cancelled) (CONTRACTS §23.2)
 *   ui.askCollectionVariable  {name, origins}     → http(s) URL | null (cancelled)
 *   ui.confirmRemoveCollection {name, file}       → true to remove (native modal; anything else = no)
 *   ui.input                  {prompt, value?}    → a snapshot / collection name | null (cancelled) (CONTRACTS §22.8, §23.2)
 *   ui.confirm                {message, detail?, buttons, modal} → clicked button | null (cancelled) (CONTRACTS §23.2, §23.4)
 *   ui.diff                   {title, left, right} → null (read-only before/after preview, CONTRACTS §23.4)
 *   ui.clipboard              {text}              → null (copy-only example update, CONTRACTS §23.4)
 *   ui.openFile               {path}              → null (open newly recorded collection for review, CONTRACTS §23.2)
 *
 * The traffic panel never receives a file path: choosing a file, confirming a copy into the project and confirming
 * removal all happen in the IDE. Collection and environment files are watched by exact path (non-recursive `fs.watch`
 * on each parent directory, matched against the files in use); Bruno collection folders whole (`watchFolder`, capped
 * by `MAX_WATCHED_DIRS`); a collection's snapshot folder (`.vscode/flutter-intercept/snapshots/<linkId>/`) by its
 * `*.json` files.
 *
 * Stateful mocks (CONTRACTS §22.9): the core registers one proxy handler per collection through `setHandler` (the
 * shared InterceptProxyHost's), writes snapshots through the sidecar's RulesFs with the §22.8 path checks, and writes
 * a store's team settings through the shared rules (`saveStore`). A snapshot saved without a name asks the IDE for one
 * through the generic `ui.input`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Exchange } from '@flutter-intercept/proxy';
import type { RequestHandler, Rule } from '@flutter-intercept/proxy';
import { decodeWorkspaceFile, type RulesFs, type WorkspaceFileSpec } from '../../extension/src/rules/bodyFile';
import type { MementoLike } from '../../extension/src/rules/core';
import {
  copyRefusal,
  exampleDiff,
  MockCollectionsCore,
  NOTHING_RECORDED,
  SnapshotCancelled,
  type CollectionAnswer,
  type CollectionParsers,
  type ExampleUpdate,
  type MockFromTrafficRequest,
  type MockFromTrafficResult,
  type PipelineAnswerView,
  type TrafficSource,
} from '../../extension/src/mocks/core';
import { cleanLine } from '../../extension/src/mocks/limit';
import { isBrunoLinkFile } from '../../extension/src/mocks/link';
import { COLLECTION_LIMITS, SNAPSHOT_NAME, SNAPSHOTS_DIR } from '../../extension/src/mocks/types';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus, DriftView, StoreOpView, StorePatch, StoreStatus } from '../../extension/src/ui/protocol';
import { RpcFailure } from './rpc';
import { nodeRulesFs, type NodeSharedRules } from './sharedRules';

export const COLLECTION_FILE_METHOD = 'ui.chooseCollectionFile';
export const COLLECTION_COPY_METHOD = 'ui.confirmCopyCollection';
export const COLLECTION_VAR_METHOD = 'ui.askCollectionVariable';
export const COLLECTION_REMOVE_METHOD = 'ui.confirmRemoveCollection';
/** CONTRACTS §24.4: environment-name pick for Insomnia / Bruno collections through the generic choice dialog. */
export const COLLECTION_ENV_METHOD = 'ui.pick';
/** CONTRACTS §23.2: multi-choice dialog for selecting servers when making a fake backend from traffic. */
export const PICK_MANY_METHOD = 'ui.pickMany';
/** CONTRACTS §22.8 / §23.2: generic input box. */
export const SNAPSHOT_NAME_METHOD = 'ui.input';
export const CONFIRM_METHOD = 'ui.confirm';
export const DIFF_METHOD = 'ui.diff';
export const CLIPBOARD_METHOD = 'ui.clipboard';
export const OPEN_FILE_METHOD = 'ui.openFile';

export const FROM_TRAFFIC_BUSY = 'Making a fake backend from traffic is already open.';
export const FALLBACK_PASSTHROUGH_BUTTON = 'Fall back to the real server';
export const FALLBACK_FAIL_BUTTON = "Offline: fail what wasn't recorded";
export const UPDATE_EXAMPLE_BUTTON = 'Update example';
export const COPY_EXAMPLE_BUTTON = 'Copy the updated example';
export function snapshotNamePrompt(id: string): string {
  return `Save the data as a snapshot: a name of 1–40 lower-case letters, digits or "-", such as "checkout".\nSaved as ${SNAPSHOTS_DIR}/${id}/<name>.json, a file the team commits to share this scenario. Secret-looking fields are blanked.`;
}

export const COLLECTION_CHOOSER_BUSY = 'A file chooser is already open in the IDE.';

const MAX_PATH = 4096;
const MAX_VARIABLE_VALUE = 2048;
const MAX_WATCHED_DIRS = 64;
const MAX_WATCHED_FILES = 256;
const COLLECTION_FILE_SPEC: WorkspaceFileSpec = { what: 'collection file', maxBytes: COLLECTION_LIMITS.fileBytes, maxLabel: '20 MB' };

/** CONTRACTS §22.9: what a snapshot save / load / delete reports. */
export interface StoreSnapshotResult {
  path: string;
  resources: number;
  records: number;
  blanked?: string[];
}

export interface StoreItemsOptions {
  offset?: number;
  limit?: number;
  filter?: string;
  scope?: Record<string, string>;
}
export interface StoreItemsPage {
  total: number;
  items: unknown[];
  truncated?: true;
}

export interface SidecarCollectionsDeps {
  shared: Pick<NodeSharedRules, 'ready' | 'collectionLinks' | 'onDidChangeCollections' | 'primaryFolderPath' | 'saveCollections' | 'writeWorkspaceFile'> &
    Partial<Pick<NodeSharedRules, 'saveStore'>>;
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
  /** CONTRACTS §22.9: registers / removes a proxy handler (InterceptProxyHost.setHandler). Absent → no stateful mocks. */
  setHandler?(id: string, fn: RequestHandler | undefined): void;
  /** CONTRACTS §21.15 #4 / §22.9: this session's exchanges (`seen`). */
  exchanges?(): readonly Exchange[];
  /** REVIEW-15 #8: hosts passed through without decryption (their requests aren't mocked). */
  passthroughHosts?(): string[];
  /** CONTRACTS §22.4: the proxy stopped — the stores are dropped (their data lives as long as the proxy). */
  onProxyStopped?(listener: () => void): { dispose(): void };
  // ---- CONTRACTS §23 (part 2)
  /** §23.2: a saved recording's exchanges (`recordings/store.ts` `load(id).entries`). */
  loadRecording?(id: string): Promise<readonly Exchange[]>;
  /** §23.3: every exchange update of the proxy (`exchange` events); finished ones are checked for drift. */
  onExchange?(listener: (e: Exchange) => void): { dispose(): void };
  /** §23.1 / §23.3: the user's rule `ruleId` only throttles (its exchanges still reached the real server). */
  isThrottleOnlyRule?(ruleId: string): boolean;
  /** §23.3: plugin setting `collectionDrift` (absent = on). Call `refreshDrift()` when it changes. */
  driftEnabled?(): boolean;
  /** Tests: the drift debounce (default 500 ms). */
  driftDebounceMs?: number;
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
  // CONTRACTS §22.9 (stateful mocks)
  storeStatus(id: string): StoreStatus | undefined;
  storeItems(id: string, resource: string, opts?: StoreItemsOptions): StoreItemsPage;
  /** Data changes never reach a file; settings follow `patch.scope` (§22.7). */
  updateStore(id: string, patch: StorePatch): Promise<void>;
  /** `save` without a name asks in the IDE (`ui.input`); a cancelled prompt throws `SnapshotCancelled`. */
  storeSnapshot(id: string, action: 'save' | 'load' | 'delete', name?: string): Promise<StoreSnapshotResult>;
  /** Which store operation answered an exchange (last 5 000). */
  storeOpOf(exchangeId: string): StoreOpView | undefined;
  /** A store's data changed (`resource` undefined = possibly several): status counts and open tables follow. */
  onDidChangeStore(listener: (id: string, resource: string | undefined) => void): { dispose(): void };
  // CONTRACTS §21.15 / §24 (answer pipeline, sign-in simulation, Insomnia / Bruno environments)
  describeRule(ruleId: string | undefined): CollectionAnswer | undefined;
  endpointForRequest(id: string, ex: Pick<Exchange, 'method' | 'url' | 'matchedRuleId'>): string;
  environmentsOf(file: string, folderPath?: string): Promise<string[]>;
  answerOf(exchangeId: string): PipelineAnswerView | undefined;
  expireSessions(id: string): number;
  authCollectionFor(url: string): string | undefined;
  onDidChangeAuth(listener: (id: string) => void): { dispose(): void };
  // CONTRACTS §23 (part 2: fake backend from traffic, drift detection, Update example)
  /** §23.2 for agents: no dialogs, caller passes every choice; `dryRun` writes nothing. */
  mockFromTraffic(req: MockFromTrafficRequest): Promise<MockFromTrafficResult>;
  /** §23.2: IDE flow (servers, name, personal data, confirm modal); undefined when cancelled. */
  mockFromTrafficInteractive(source: TrafficSource): Promise<MockFromTrafficResult | undefined>;
  /** §23.3: a collection's drift findings (paths and kinds only). */
  drift(id: string): DriftView[];
  /** §23.3: hides findings (all, one endpoint's, one status) until they change. */
  ignoreDrift(id: string, endpoint?: string, status?: number): Promise<void>;
  /** §23.4 for agents: what Update example would change; never writes. */
  previewExampleUpdate(id: string, endpoint: string, status: number, mode?: 'merge' | 'add'): Promise<ExampleUpdate>;
  /** §23.4: before/after preview + modal confirm → apply (or copy-only clipboard). */
  updateExampleInteractive(id: string, endpoint: string, status: number, mode?: 'merge' | 'add'): Promise<'updated' | 'copied' | 'cancelled'>;
  /** §23.3: the plugin setting `collectionDrift` changed. */
  refreshDrift(): void;
  /** §23.3: drift findings changed (Status and open collections follow). */
  onDidChangeDrift(listener: () => void): { dispose(): void };
  dispose(): void;
}

/** A snapshot name returned by the IDE: trimmed, `SNAPSHOT_NAME`. Undefined otherwise. */
export function usableSnapshotName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return SNAPSHOT_NAME.test(t) ? t : undefined;
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
  const storeListeners = new Set<(id: string, resource: string | undefined) => void>();
  const authListeners = new Set<(id: string) => void>();
  const driftListeners = new Set<() => void>();
  const fireStore = (id: string, resource: string | undefined) => {
    for (const l of [...storeListeners]) {
      try {
        l(id, resource);
      } catch {
        // a listener's bug must not break the others
      }
    }
  };
  const fireAuth = (id: string) => {
    for (const l of [...authListeners]) {
      try {
        l(id);
      } catch {
        // a listener's bug must not break the others
      }
    }
  };
  const fireDrift = () => {
    for (const l of [...driftListeners]) {
      try {
        l();
      } catch {
        // a listener's bug must not break the others
      }
    }
  };
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

  // Exact-path watching: one non-recursive watcher per directory, events matched against the files in use — or, for
  // Bruno collection folders (`all`), any file change inside the directory.
  const dirWatchers = new Map<string, { watcher?: fs.FSWatcher; files: Set<string>; anyJson?: boolean; all?: boolean }>();
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
    if (!entry || (!entry.files.size && !entry.anyJson && !entry.all)) return;
    if (!name || entry.all) {
      scheduleReload();
      return;
    }
    const abs = path.resolve(dir, name.toString());
    if (entry.files.has(abs) || (entry.anyJson && abs.toLowerCase().endsWith('.json'))) scheduleReload();
  };
  const watchDir = (dir: string): { watcher?: fs.FSWatcher; files: Set<string>; anyJson?: boolean; all?: boolean } | undefined => {
    let entry = dirWatchers.get(dir);
    if (entry) return entry;
    if (dirWatchers.size >= MAX_WATCHED_DIRS) return undefined;
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(dir, { persistent: false }, (_ev, name) => onDirEvent(dir, name));
      watcher.on('error', () => undefined);
    } catch {
      // directory unreadable or missing: next reload re-checks
    }
    entry = { watcher, files: new Set() };
    dirWatchers.set(dir, entry);
    return entry;
  };
  /** CONTRACTS §22.8: `<folder>/.vscode/flutter-intercept/snapshots/<linkId>/*.json` (a missing folder is retried on reload). */
  const watchSnapshots = (folderPath: string, linkId: string) => {
    if (disposed) return;
    const dir = path.resolve(folderPath, ...SNAPSHOTS_DIR.split('/'), linkId);
    const existing = dirWatchers.get(dir);
    if (existing && !existing.watcher && !existing.files.size && !existing.all) dirWatchers.delete(dir); // it didn't exist before: try again
    const entry = watchDir(dir);
    if (entry) entry.anyJson = true;
  };
  /** CONTRACTS §24.4: a folder of a Bruno collection (any change inside reloads, within MAX_WATCHED_DIRS). */
  const watchFolder = (abs: string) => {
    if (disposed) return;
    const dir = path.resolve(abs);
    const existing = dirWatchers.get(dir);
    if (existing && !existing.watcher && !existing.files.size && !existing.anyJson) dirWatchers.delete(dir);
    const entry = watchDir(dir);
    if (entry) entry.all = true;
  };
  const watchFile = (abs: string) => {
    if (disposed) return;
    const resolved = path.resolve(abs);
    const dir = path.dirname(resolved);
    let entry = dirWatchers.get(dir);
    if (entry?.files.has(resolved)) return;
    if (watchedFiles >= MAX_WATCHED_FILES) return;
    entry = watchDir(dir);
    if (!entry) return;
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
    ...(deps.exchanges ? { exchanges: deps.exchanges } : {}),
    ...(deps.passthroughHosts ? { passthroughHosts: deps.passthroughHosts } : {}),
    // CONTRACTS §22.9: stateful mocks
    ...(deps.setHandler ? { setHandler: deps.setHandler } : {}),
    ...(deps.shared.saveStore ? { saveStore: deps.shared.saveStore } : {}),
    onStoreChange: (id: string, resource: string | undefined) => fireStore(id, resource),
    watchSnapshots,
    // CONTRACTS §24: Bruno folder watching and live sign-in session counts
    watchFolder,
    onAuthChange: (id: string) => fireAuth(id),
    // CONTRACTS §23 (part 2): recordings, throttle-only check, drift detection
    ...(deps.loadRecording ? { loadRecording: deps.loadRecording } : {}),
    ...(deps.isThrottleOnlyRule ? { isThrottleOnlyRule: deps.isThrottleOnlyRule } : {}),
    ...(deps.driftEnabled ? { driftEnabled: deps.driftEnabled } : {}),
    ...(deps.driftDebounceMs !== undefined ? { driftDebounceMs: deps.driftDebounceMs } : {}),
    onDriftChange: () => {
      if (!disposed) fireDrift();
    },
  });
  const exchangeSub = deps.onExchange?.((e) => core.observeExchange(e));

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
  const stoppedSub = deps.onProxyStopped?.(() => {
    if (disposed) return;
    void after(core.dropStores()).catch((e: unknown) => log(`collections: dropping stores failed: ${(e as Error).message}`));
  });
  const ready = deps.shared.ready.then(reload);

  /**
   * CONTRACTS §24.4: an Insomnia / Bruno collection keeps its environments inside — the user picks one by name through
   * the IDE's generic choice picker (`ui.pick`). Undefined = none (or the format has none); null = cancelled.
   */
  const askEnvironment = async (rel: string, folder: string): Promise<string | undefined | null> => {
    const names = await core.environmentsOf(rel, folder);
    if (!names.length) return undefined;
    const items = [
      ...names.map((n, i) => ({ label: cleanLine(n, 100), value: `env:${i}` })),
      { label: 'No environment', value: 'none' },
    ];
    let pick: unknown;
    try {
      pick = await deps.request(COLLECTION_ENV_METHOD, {
        title: 'Mock from a collection: environment',
        placeholder: 'Which environment gives the server URLs? Only its URL variables are used; its values are never shown.',
        items,
      });
    } catch (e) {
      throw ideError(e, 'choose a collection environment');
    }
    if (pick === null || pick === undefined) return null;
    if (pick === 'none') return undefined;
    if (typeof pick === 'string' && pick.startsWith('env:')) {
      const idx = Number(pick.slice(4));
      if (Number.isInteger(idx) && idx >= 0 && idx < names.length) return names[idx];
    }
    return names.find((n) => cleanLine(n, 100) === pick);
  };

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
        // CONTRACTS §24.4: a Bruno collection is a whole folder — never copied
        if (isBrunoLinkFile(path.basename(real))) throw new Error(copyRefusal(path.basename(real), 'bruno'));
        const st = await files.stat(real);
        if (!st.isFile()) throw new Error(`${path.basename(real)} is not a regular file`);
        if (st.size > COLLECTION_LIMITS.fileBytes) throw new Error(`${path.basename(real)} is larger than 20 MB`);
        const text = decodeWorkspaceFile(await files.readFile(real), path.basename(real), COLLECTION_FILE_SPEC);
        const format = core.formatOf(text, path.basename(real));
        // CONTRACTS §24.4: no copy without credentials exists for Swagger / Insomnia files yet, so none is made
        if (format === 'swagger' || format === 'insomnia') throw new Error(copyRefusal(path.basename(real), format));
        let choice: unknown;
        try {
          choice = await deps.request(COLLECTION_COPY_METHOD, { fileName: path.basename(real) });
        } catch (e) {
          throw ideError(e, 'ask before copying a collection');
        }
        if (choice !== 'sanitised' && choice !== 'as-is') return undefined;
        const copied = await core.copyIn(text, path.basename(real), choice);
        rel = copied.file;
        if (copied.removed.length) log(`collections: copied ${rel} without ${copied.removed.length} credential(s)`);
      }
      const environment = await askEnvironment(rel, primary);
      if (environment === null) return undefined;
      const { id } = await after(core.addLink({ file: rel, folderPath: primary, ...(environment !== undefined ? { environment } : {}) }));
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

  // ---------------------------------------------------------------- CONTRACTS §23 (part 2)

  // One "fake backend from traffic" flow at a time (as importInteractive).
  let fromTrafficBusy = false;
  const mockFromTrafficInteractive = async (source: TrafficSource): Promise<MockFromTrafficResult | undefined> => {
    if (fromTrafficBusy) {
      void notify('info', FROM_TRAFFIC_BUSY);
      return undefined;
    }
    fromTrafficBusy = true;
    try {
      return await fromTrafficFlow(source);
    } finally {
      fromTrafficBusy = false;
    }
  };

  const fromTrafficFlow = async (source: TrafficSource): Promise<MockFromTrafficResult | undefined> => {
    await ready;
    const primary = await deps.shared.primaryFolderPath();
    if (!primary) throw new Error('Open the Flutter project folder to make a fake backend from traffic');
    const all = await core.trafficOrigins(source);
    if (!all.length) throw new Error(NOTHING_RECORDED);
    const title = 'Make a fake backend from this session';
    // 1. servers: JSON APIs preselected, third-party services listed unselected
    let rawOrigins: unknown;
    try {
      rawOrigins = await deps.request(PICK_MANY_METHOD, {
        title: `${title} (1/3)`,
        placeholder: 'Which servers should the fake backend answer for? Their recorded answers become its examples.',
        items: all.map((o) => ({
          label: cleanLine(o.origin.replace(/^https?:\/\//, ''), 120),
          description: `${o.requests} request${o.requests === 1 ? '' : 's'}${o.json ? '' : ', no JSON'}${o.thirdParty ? ' · third-party service' : ''}`,
          value: o.origin,
          picked: o.preselected,
        })),
        okButton: 'Continue',
      });
    } catch (e) {
      throw ideError(e, 'choose servers for a fake backend');
    }
    if (!Array.isArray(rawOrigins)) return undefined;
    const known = new Set(all.map((o) => o.origin));
    const origins = [...new Set(rawOrigins.filter((v): v is string => typeof v === 'string' && known.has(v)))];
    if (!origins.length) return undefined;

    // 2. a name (prefilled "<host> (recorded)")
    const defaultName = `${cleanLine(origins[0].replace(/^https?:\/\//, ''), 80)} (recorded)`;
    let rawName: unknown;
    try {
      rawName = await deps.request(SNAPSHOT_NAME_METHOD, {
        prompt: `${title} (2/3): A name for the collection (1–100 characters; its file goes to .vscode/flutter-intercept/collections/)`,
        value: defaultName,
      });
    } catch (e) {
      throw ideError(e, 'ask for a collection name');
    }
    if (rawName === null || rawName === undefined) return undefined;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > 100 || /[\r\n\0]/.test(name)) {
      throw new Error('Use 1–100 characters for the collection name.');
    }

    // 3. personal data (replace by default)
    let rawPd: unknown;
    try {
      rawPd = await deps.request(COLLECTION_ENV_METHOD, {
        title: `${title} (3/3)`,
        placeholder: 'Personal data in the recorded answers',
        items: [
          { label: 'Replace e-mails, phone numbers and addresses', description: 'recommended', value: 'replace' },
          { label: 'Keep them as recorded', description: 'the file holds real personal data', value: 'keep' },
        ],
      });
    } catch (e) {
      throw ideError(e, 'choose how to handle personal data');
    }
    if (rawPd !== 'replace' && rawPd !== 'keep') return undefined;
    const replacePersonalData = rawPd === 'replace';

    // 4. confirm modal: the two fallback choices + review warning
    let choice: unknown;
    try {
      choice = await deps.request(CONFIRM_METHOD, {
        message: `Make "${cleanLine(name, 100)}" from ${origins.length} server${origins.length === 1 ? '' : 's'}?`,
        detail:
          'Credentials removed; example bodies are real data — review before committing. The collection is written to .vscode/flutter-intercept/collections/ (opened for review) and linked in .vscode/flutter-intercept.json for the team. Requests it has no answer for can fall back to the real server, or fail as if offline.',
        buttons: [FALLBACK_PASSTHROUGH_BUTTON, FALLBACK_FAIL_BUTTON],
        modal: true,
      });
    } catch (e) {
      throw ideError(e, 'confirm making a fake backend');
    }
    if (choice !== FALLBACK_PASSTHROUGH_BUTTON && choice !== FALLBACK_FAIL_BUTTON) return undefined;
    const r = await after(
      core.mockFromTraffic({
        source,
        name,
        origins,
        unmatched: choice === FALLBACK_FAIL_BUTTON ? 'fail' : 'passthrough',
        replacePersonalData,
      }),
    );
    // Open the written collection file for review (best effort; the panel shows the result line, CONTRACTS §24.9).
    void Promise.resolve(deps.request(OPEN_FILE_METHOD, { path: path.join(primary, ...r.file.split('/')) })).catch(() => undefined);
    return r;
  };

  /** CONTRACTS §23.4: plain before/after preview + modal confirmation, or copy-only clipboard for non-editable formats. */
  const updateExampleInteractive = async (id: string, endpoint: string, status: number, mode: 'merge' | 'add' = 'merge'): Promise<'updated' | 'copied' | 'cancelled'> => {
    const u = await core.exampleUpdate(id, endpoint, status, mode);
    const file = cleanLine(u.file, 200);
    if (!u.edit) {
      let ok: unknown;
      try {
        ok = await deps.request(CONFIRM_METHOD, {
          message: `${file} isn't changed here: ${cleanLine(u.copyOnly ?? 'this format is not edited', 200)}.`,
          detail: 'Copy the updated example and paste it into the file yourself. Credentials are removed; other values are real data from the server.',
          buttons: [COPY_EXAMPLE_BUTTON],
          modal: true,
        });
      } catch (e) {
        throw ideError(e, 'confirm copying the updated example');
      }
      if (ok !== COPY_EXAMPLE_BUTTON) return 'cancelled';
      try {
        await deps.request(CLIPBOARD_METHOD, { text: u.newBody });
      } catch (e) {
        throw ideError(e, 'copy the updated example to the clipboard');
      }
      return 'copied';
    }
    const base = path.posix.basename(u.file) || 'collection.json';
    try {
      await deps.request(DIFF_METHOD, {
        title: `${base}: ${u.mode === 'merge' ? 'update' : 'add'} example "${cleanLine(u.example, 80)}"`,
        left: { name: `before-${base}`, content: u.edit.before },
        right: { name: `after-${base}`, content: u.edit.after },
      });
    } catch (e) {
      throw ideError(e, 'show the example diff');
    }
    let ok: unknown;
    try {
      ok = await deps.request(CONFIRM_METHOD, {
        message: `${u.mode === 'merge' ? 'Update' : 'Add'} example "${cleanLine(u.example, 100)}" in ${file}?`,
        detail:
          "This changes a file shared with the team (the diff shows exactly what). The collection's remembered data restarts from its examples, and if some of its answers are limited until approved, it asks for approval again. Credentials are removed from the server's answer; other values are real data.\n\n" +
          exampleDiff(u),
        buttons: [UPDATE_EXAMPLE_BUTTON],
        modal: true,
      });
    } catch (e) {
      throw ideError(e, 'confirm updating the example');
    }
    if (ok !== UPDATE_EXAMPLE_BUTTON) return 'cancelled';
    await after(core.applyExampleUpdate(u));
    return 'updated';
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
    storeStatus: (id) => core.storeStatus(id),
    storeItems: (id, resource, opts = {}) => core.storeItems(id, resource, opts),
    updateStore: async (id, patch) => {
      // settings changes rebuild the rules (listeners re-apply them); data changes only fire onDidChangeStore
      if (await core.updateStore(id, patch)) fireChanged();
    },
    storeSnapshot: async (id, action, name) => {
      let chosen = name;
      if (chosen === undefined) {
        if (action !== 'save') throw new Error('Choose a snapshot.');
        let raw: unknown;
        try {
          raw = await deps.request(SNAPSHOT_NAME_METHOD, { prompt: snapshotNamePrompt(id) });
        } catch (e) {
          throw ideError(e, 'ask for a snapshot name');
        }
        if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) throw new SnapshotCancelled();
        chosen = usableSnapshotName(raw);
        if (!chosen) throw new Error('A snapshot name has 1–40 lower-case letters, digits or dashes.');
      }
      const r = await core.storeSnapshot(id, action, chosen);
      if (action !== 'load') fireChanged(); // the list of snapshots changed
      return r;
    },
    storeOpOf: (exchangeId) => core.storeOpOf(exchangeId),
    onDidChangeStore: (listener) => {
      storeListeners.add(listener);
      return { dispose: () => void storeListeners.delete(listener) };
    },
    describeRule: (ruleId) => core.describeRule(ruleId),
    endpointForRequest: (id, ex) => core.endpointForRequest(id, ex),
    environmentsOf: (file, folderPath) => core.environmentsOf(file, folderPath),
    answerOf: (exchangeId) => core.answerOf(exchangeId),
    expireSessions: (id) => {
      const n = core.expireSessions(id);
      fireAuth(id);
      return n;
    },
    authCollectionFor: (url) => core.authCollectionFor(url),
    onDidChangeAuth: (listener) => {
      authListeners.add(listener);
      return { dispose: () => void authListeners.delete(listener) };
    },
    // CONTRACTS §23 (part 2)
    mockFromTraffic: async (req) => {
      await ready;
      return req.dryRun ? core.mockFromTraffic(req) : after(core.mockFromTraffic(req));
    },
    mockFromTrafficInteractive,
    drift: (id) => core.driftOf(id),
    ignoreDrift: async (id, endpoint, status) => {
      await core.ignoreDrift(id, endpoint, status);
    },
    previewExampleUpdate: (id, endpoint, status, mode) => core.exampleUpdate(id, endpoint, status, mode),
    updateExampleInteractive,
    refreshDrift: () => core.refreshDrift(),
    onDidChangeDrift: (listener) => {
      driftListeners.add(listener);
      return { dispose: () => void driftListeners.delete(listener) };
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      linksSub.dispose();
      stoppedSub?.dispose();
      exchangeSub?.dispose();
      for (const { watcher } of dirWatchers.values()) watcher?.close();
      dirWatchers.clear();
      listeners.clear();
      storeListeners.clear();
      authListeners.clear();
      driftListeners.clear();
    },
  };
}
