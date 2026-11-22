/**
 * VS Code layer of "Mock from a collection" (CONTRACTS §21.6, §21.7): wires MockCollectionsCore (src/mocks/core.ts)
 * to the shared rules file, workspaceState, file watchers and the IDE's own dialogs.
 *
 * - The panel never sees a path: the file picker, the copy question and the remove confirmation are IDE dialogs.
 * - Collection and environment files are watched by exact path (a directory watcher per folder, like body files in
 *   src/rules/service.ts: a file name may contain glob characters); edits reload after a short debounce.
 * - CONTRACTS §24.4: the folders of a linked Bruno collection are watched whole, with the same directory watchers and
 *   the same cap; Swagger / Insomnia files and Bruno folders outside the project are never copied in.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { Exchange, RequestHandler, Rule } from '@flutter-intercept/proxy';
import type { SharedRulesHost } from '../rules/service';
import { nodeRulesFs } from '../rules/service';
import type { MementoLike } from '../rules/core';
import type { RulesFs } from '../rules/bodyFile';
import { COLLECTION_LIMITS, SNAPSHOT_NAME, SNAPSHOTS_DIR } from './types';
import {
  copyRefusal,
  NOTHING_RECORDED,
  MockCollectionsCore,
  SnapshotCancelled,
  type CollectionAnswer,
  type CollectionParsers,
  type ExampleUpdate,
  type MockFromTrafficRequest,
  type MockFromTrafficResult,
  type PipelineAnswerView,
  type TrafficSource,
} from './core';
import { isBrunoLinkFile } from './link';
import { cleanLine } from './limit';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus, DriftView, StoreOpView, StorePatch, StoreStatus } from '../ui/protocol';

export interface MockCollectionsDeps {
  shared: SharedRulesHost;
  workspaceState: MementoLike;
  parsers: CollectionParsers;
  newRuleId(): string;
  log?(msg: string): void;
  /** Origins seen in this session's traffic (offered when a URL variable has no value). */
  seenOrigins?(): string[];
  /** CONTRACTS §21.15 #4: this session's exchanges (`seen`). */
  exchanges?(): readonly Exchange[];
  /** REVIEW-15 #8: hosts passed through without decryption (learned or configured). */
  passthroughHosts?(): string[];
  debounceMs?: number;
  /** CONTRACTS §22.9: the proxy host's `setHandler` (stateful mocks). Absent → collections answer as in 0.15. */
  setHandler?(id: string, fn: RequestHandler | undefined): void;
  /** CONTRACTS §22.4: fires when the proxy stops (every store is dropped then). */
  onProxyStopped?(listener: () => void): vscode.Disposable;
  /** Tests: a fake file system. */
  fs?: RulesFs;
  // ---- CONTRACTS §23 (part 2)
  /** §23.2: a saved recording's exchanges (`recordings/store.ts` `load(id).entries`). */
  loadRecording?(id: string): Promise<readonly Exchange[]>;
  /** §23.3: every exchange update of the proxy (`exchange` events); finished ones are checked for drift. */
  onExchange?(listener: (e: Exchange) => void): vscode.Disposable;
  /** §23.1 / §23.3: the user's rule `ruleId` only throttles (its exchanges still reached the real server). */
  isThrottleOnlyRule?(ruleId: string): boolean;
  /** §23.3: setting `flutterIntercept.collectionDrift` (absent = on). Call `refreshDrift()` when it changes. */
  driftEnabled?(): boolean;
  /** Tests: the drift debounce (default 500 ms). */
  driftDebounceMs?: number;
  /** Tests with fake timers: the drift slice (default 10 ms; `Infinity` = a whole tick at once). */
  driftSliceMs?: number;
}

export interface MockCollectionsHost extends vscode.Disposable {
  readonly ready: Promise<void>;
  state(): CollectionStatus[];
  rules(): Rule[];
  /** Problems of the `collections` entries themselves (shown with the shared rules' problems). */
  fileProblems(): string[];
  onDidChange(listener: () => void): vscode.Disposable;
  endpoints(id: string): CollectionEndpointView[];
  example(id: string, endpoint: string, name: string): { status: number; headers: Record<string, string>; body: string; truncated?: true };
  toRule(id: string, endpoint: string): Rule;
  update(id: string, patch: CollectionPatch): Promise<void>;
  /** Asks the user (modal) first; resolves to false when they cancel. The collection file is kept. */
  removeWithConfirmation(id: string): Promise<boolean>;
  /** Agents (§21.10): workspace-relative files inside the workspace only; no copying, no dialogs. */
  importFile(pick: { file: string; environment?: string }): Promise<{ id: string }>;
  /** CONTRACTS §21.16: asks the user (modal) what approving allows; resolves to whether they approved. IDE only. */
  approveWithConfirmation(id: string): Promise<boolean>;
  /** CONTRACTS §21.15 #2: which collection answer an exchange got (`matchedRuleId`). */
  describeRule(ruleId: string | undefined): CollectionAnswer | undefined;
  /** CONTRACTS §21.15 #3: the endpoint of collection `id` for a request seen in traffic. */
  endpointForRequest(id: string, ex: Pick<Exchange, 'method' | 'url' | 'matchedRuleId'>): string;
  /** The command / panel flow: file picker, copy question for files outside the workspace, unset variables. */
  importInteractive(): Promise<{ id: string } | undefined>;
  reload(): Promise<void>;
  // CONTRACTS §22.9 (stateful mocks)
  storeStatus(id: string): StoreStatus | undefined;
  storeItems(id: string, resource: string, opts?: { offset?: number; limit?: number; filter?: string; scope?: Record<string, string> }): { total: number; items: unknown[]; truncated?: true };
  /** Data changes never reach a file; settings follow `patch.scope` (§22.7). */
  updateStore(id: string, patch: StorePatch): Promise<void>;
  /** `save` without a name asks in the IDE (panel only; agents always pass one). */
  storeSnapshot(id: string, action: 'save' | 'load' | 'delete', name?: string): Promise<{ path: string; resources: number; records: number; blanked?: string[] }>;
  /** Which store operation answered an exchange (last 5 000). */
  storeOpOf(exchangeId: string): StoreOpView | undefined;
  /** A store's data changed (`resource` undefined = possibly several); status counts and open tables follow. */
  onDidChangeStore(listener: (id: string, resource: string | undefined) => void): vscode.Disposable;
  // CONTRACTS §24
  /** What the answer pipeline answered an exchange with when it isn't the rule's own example (last 5 000). */
  answerOf(exchangeId: string): PipelineAnswerView | undefined;
  /** §24.1: every access token of the collection expires now; how many were valid. Throws when sign-in simulation is off. */
  expireSessions(id: string): number;
  /** §24.1: the collection with sign-in simulation on that answers `url` (a URL or glob with a literal host). */
  authCollectionFor(url: string): string | undefined;
  /** §24.9: the number of signed-in sessions of a collection changed. */
  onDidChangeAuth(listener: (id: string) => void): vscode.Disposable;
  // CONTRACTS §23 (part 2)
  /** §23.2 for agents: no dialogs, the caller passes every choice; `dryRun` writes nothing. */
  mockFromTraffic(req: MockFromTrafficRequest): Promise<MockFromTrafficResult>;
  /** §23.2: the IDE flow (origins, name, personal data, then a modal); undefined when the user cancels. */
  mockFromTrafficInteractive(source: TrafficSource): Promise<MockFromTrafficResult | undefined>;
  /** §23.3: a collection's drift findings (paths and kinds only). */
  drift(id: string): DriftView[];
  /** §23.3: hides findings (all, one endpoint's, one status) until they change. */
  ignoreDrift(id: string, endpoint?: string, status?: number): Promise<void>;
  /** §23.4 for agents: what Update example would change; never writes. */
  previewExampleUpdate(id: string, endpoint: string, status: number, mode?: 'merge' | 'add'): Promise<ExampleUpdate>;
  /** §23.4: diff preview, the user's confirmation, then the write (or "Copy the updated example"). */
  updateExampleInteractive(id: string, endpoint: string, status: number, mode?: 'merge' | 'add'): Promise<'updated' | 'copied' | 'cancelled'>;
  /** §23.3: the setting `flutterIntercept.collectionDrift` changed. */
  refreshDrift(): void;
  /** §23.3: drift findings changed (Status and the open collections follow). */
  onDidChangeDrift(listener: () => void): vscode.Disposable;
}

/** §23.4: before / after of a collection file, served read-only (never a temp file in the project). */
export const EXAMPLE_DIFF_SCHEME = 'flutter-intercept-example';
const MAX_DIFF_DOCS = 10;

const MAX_WATCHED_DIRS = 64;

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function createMockCollectionsService(deps: MockCollectionsDeps): MockCollectionsHost {
  const log = deps.log ?? (() => undefined);
  const debounceMs = deps.debounceMs ?? 300;
  const files = deps.fs ?? nodeRulesFs;
  const changed = new vscode.EventEmitter<void>();
  const storeChanged = new vscode.EventEmitter<{ id: string; resource: string | undefined }>();
  const authChanged = new vscode.EventEmitter<string>();
  const driftChanged = new vscode.EventEmitter<void>();
  const disposables: vscode.Disposable[] = [changed, storeChanged, authChanged, driftChanged];
  // CONTRACTS §22.8: the snapshots folder of each collection (created later is fine: the pattern is relative)
  const snapshotWatchers = new Map<string, vscode.Disposable>();
  const watchSnapshots = (folder: string, linkId: string) => {
    const key = `${folder}\0${linkId}`;
    if (disposed || snapshotWatchers.has(key) || snapshotWatchers.size >= MAX_WATCHED_DIRS) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), `${SNAPSHOTS_DIR}/${linkId}/*.json`));
    w.onDidCreate(() => scheduleReload());
    w.onDidDelete(() => scheduleReload());
    snapshotWatchers.set(key, w);
  };
  let disposed = false;

  // exact-path watching: one watcher per directory ("*"), events matched against the files in use — or, for the
  // folders of a Bruno collection (`all`), any file in it (a new request file is a change too)
  const dirWatchers = new Map<string, { watcher: vscode.Disposable; files: Set<string>; all?: true }>();
  let timer: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, debounceMs);
  };
  const onFileEvent = (uri: vscode.Uri) => {
    const abs = path.resolve(uri.fsPath);
    const w = dirWatchers.get(path.dirname(abs));
    if (w && (w.all || w.files.has(abs))) scheduleReload();
  };
  const watchDir = (dir: string) => {
    let entry = dirWatchers.get(dir);
    if (!entry) {
      if (dirWatchers.size >= MAX_WATCHED_DIRS) return undefined;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*'));
      watcher.onDidCreate(onFileEvent);
      watcher.onDidChange(onFileEvent);
      watcher.onDidDelete(onFileEvent);
      entry = { watcher, files: new Set() };
      dirWatchers.set(dir, entry);
    }
    return entry;
  };
  const watchFile = (abs: string) => {
    if (disposed) return;
    watchDir(path.dirname(abs))?.files.add(abs);
  };
  /** CONTRACTS §24.4: a folder of a Bruno collection (past the cap of watched directories: reloads on the next change elsewhere). */
  const watchFolder = (abs: string) => {
    if (disposed) return;
    const entry = watchDir(path.resolve(abs));
    if (entry) entry.all = true;
  };

  const roots = () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  const core = new MockCollectionsCore({
    links: () => deps.shared.collectionLinks(),
    saveLinks: (folder, links) => deps.shared.saveCollections(folder, links),
    primaryFolderPath: () => deps.shared.primaryFolderPath(),
    writeWorkspaceFile: (folder, rel, text) => deps.shared.writeWorkspaceFile(folder, rel, text),
    workspaceRoots: roots,
    fs: files,
    memento: deps.workspaceState,
    parsers: deps.parsers,
    newRuleId: deps.newRuleId,
    log,
    watchFile,
    exchanges: deps.exchanges,
    passthroughHosts: deps.passthroughHosts,
    ...(deps.setHandler ? { setHandler: deps.setHandler } : {}),
    saveStore: (folder, collection, entry) => deps.shared.saveStore(folder, collection, entry),
    onStoreChange: (id, resource) => storeChanged.fire({ id, resource }),
    watchSnapshots,
    watchFolder,
    onAuthChange: (id) => authChanged.fire(id),
    // CONTRACTS §23
    ...(deps.loadRecording ? { loadRecording: deps.loadRecording } : {}),
    ...(deps.isThrottleOnlyRule ? { isThrottleOnlyRule: deps.isThrottleOnlyRule } : {}),
    ...(deps.driftEnabled ? { driftEnabled: deps.driftEnabled } : {}),
    ...(deps.driftDebounceMs !== undefined ? { driftDebounceMs: deps.driftDebounceMs } : {}),
    ...(deps.driftSliceMs !== undefined ? { driftSliceMs: deps.driftSliceMs } : {}),
    onDriftChange: () => {
      if (!disposed) driftChanged.fire();
    },
  });
  if (deps.onExchange) disposables.push(deps.onExchange((e) => core.observeExchange(e)));

  const reload = async () => {
    if (disposed) return;
    try {
      if (await core.reload()) changed.fire();
    } catch (e) {
      log(`collections: reload failed: ${(e as Error).message}`);
    }
  };
  /** Runs a change, then tells listeners (the change already reloaded the core). */
  const after = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } finally {
      changed.fire();
    }
  };

  disposables.push(deps.shared.onDidChangeCollections(() => void reload()));
  if (deps.onProxyStopped) {
    disposables.push(
      deps.onProxyStopped(() => {
        if (disposed) return;
        void after(core.dropStores()).catch((e: unknown) => log(`collections: dropping stores failed: ${(e as Error).message}`));
      }),
    );
  }

  /** CONTRACTS §22.8: the IDE asks for a snapshot name (save from the panel without one). */
  const askSnapshotName = async (id: string): Promise<string> => {
    const taken = new Set(core.storeStatus(id)?.snapshots ?? []);
    const name = await vscode.window.showInputBox({
      title: 'Save the data as a snapshot',
      prompt: `Saved as ${SNAPSHOTS_DIR}/${id}/<name>.json, a file the team commits to share this scenario. Secret-looking fields are blanked.`,
      placeHolder: 'checkout',
      ignoreFocusOut: true,
      validateInput: (v) => {
        const t = v.trim();
        if (!SNAPSHOT_NAME.test(t)) return 'Use 1–40 lower-case letters, digits or "-", such as "checkout"';
        return taken.has(t) ? { message: `Replaces the snapshot "${t}"`, severity: vscode.InputBoxValidationSeverity.Warning } : undefined;
      },
    });
    if (name === undefined) throw new SnapshotCancelled('Not saved');
    return name.trim();
  };
  const ready = deps.shared.ready.then(reload);

  /** Asks for every URL variable a new collection still needs (session origins offered first). */
  const askVariables = async (id: string): Promise<void> => {
    for (const name of core.unresolved(id).slice(0, 5)) {
      const seen = (deps.seenOrigins?.() ?? []).slice(0, 20);
      let value: string | undefined;
      if (seen.length) {
        const typed = '$(edit) Type a URL…';
        const pick = await vscode.window.showQuickPick([...seen, typed], { title: `Mock from a collection: value of {{${name}}}`, placeHolder: `Which server does {{${name}}} stand for? The app keeps calling it; the answers come from the collection.`, ignoreFocusOut: true });
        if (pick === undefined) return;
        value = pick === typed ? undefined : pick;
      }
      value ??= await vscode.window.showInputBox({
        title: `Mock from a collection: value of {{${name}}}`,
        prompt: `The server the app calls for {{${name}}}, e.g. https://api.example.com. Saved in .vscode/flutter-intercept.json for the team.`,
        ignoreFocusOut: true,
        validateInput: (v) => (/^https?:\/\/[^\s/?#]+/i.test(v.trim()) ? undefined : 'Enter an http:// or https:// URL'),
      });
      if (value === undefined) return;
      await after(core.update(id, { variable: { name, value: value.trim() } }));
    }
  };

  /**
   * CONTRACTS §24.4: an Insomnia / Bruno collection keeps its environments inside: the user picks one by name (names
   * only are read). Undefined = none (or the format has none); null = cancelled.
   */
  const askEnvironment = async (rel: string, folder: string): Promise<string | undefined | null> => {
    const names = await core.environmentsOf(rel, folder);
    if (!names.length) return undefined;
    const none = '$(circle-slash) No environment';
    const pick = await vscode.window.showQuickPick([...names.map((n) => cleanLine(n, 100)), none], {
      title: 'Mock from a collection: environment',
      placeHolder: 'Which environment gives the server URLs? Only its URL variables are used; its values are never shown.',
      ignoreFocusOut: true,
    });
    if (pick === undefined) return null;
    return pick === none ? undefined : names.find((n) => cleanLine(n, 100) === pick);
  };

  // REVIEW-15 #8 (as REVIEW-14 #6 for certificate files): one import flow at a time
  let importing = false;
  const importInteractive = async (): Promise<{ id: string } | undefined> => {
    if (importing) {
      void vscode.window.showInformationMessage('A collection import is already open.');
      return undefined;
    }
    importing = true;
    try {
      return await importFlow();
    } finally {
      importing = false;
    }
  };

  const importFlow = async (): Promise<{ id: string } | undefined> => {
    await ready;
    const primary = await deps.shared.primaryFolderPath();
    if (!primary) {
      void vscode.window.showWarningMessage('Open the Flutter project folder to mock from a collection.');
      return undefined;
    }
    const picked = await vscode.window.showOpenDialog({
      title: 'Mock from a collection',
      openLabel: 'Mock from this file',
      canSelectMany: false,
      defaultUri: vscode.Uri.file(primary),
      // CONTRACTS §24.4: a Bruno collection is chosen by its bruno.json
      filters: { 'Postman, OpenAPI / Swagger, Insomnia or Bruno (bruno.json)': ['json', 'yaml', 'yml'] },
    });
    const uri = picked?.[0];
    if (!uri || uri.scheme !== 'file') return undefined;
    let real: string;
    let realRoot: string;
    try {
      real = files.realpathSync(uri.fsPath);
      realRoot = files.realpathSync(primary);
    } catch {
      void vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} can't be read.`);
      return undefined;
    }
    try {
      let rel: string;
      if (inside(real, realRoot)) {
        rel = path.relative(realRoot, real).split(path.sep).join('/');
      } else {
        // CONTRACTS §24.4: a Bruno collection is a folder — never copied
        if (isBrunoLinkFile(path.basename(real))) throw new Error(copyRefusal(path.basename(real), 'bruno'));
        const st = await files.stat(real);
        if (st.size > COLLECTION_LIMITS.fileBytes) throw new Error(`${path.basename(real)} is larger than 20 MB`);
        const text = new TextDecoder().decode(await files.readFile(real));
        const shown = cleanLine(path.basename(real), 120);
        const format = core.formatOf(text, path.basename(real));
        // CONTRACTS §24.4: no copy without credentials exists for Swagger / Insomnia files yet, so none is made
        if (format === 'swagger' || format === 'insomnia') throw new Error(copyRefusal(path.basename(real), format));
        // REVIEW-15 #8: only a Postman collection can be copied without credentials; say so for OpenAPI documents
        const postman = format === 'postman';
        const choice = postman
          ? await vscode.window.showInformationMessage(
              `${shown} is outside the project. To share these mocks with the team, a copy goes into .vscode/flutter-intercept/collections/.`,
              {
                modal: true,
                detail:
                  'Without credentials (recommended): auth settings, scripts, secret-looking headers, query values and variables, and passwords in request bodies are removed from the copy. Example responses are kept exactly as they are in the file, so check them for real data.',
              },
              'Copy without credentials',
              'Copy as it is',
            )
          : await vscode.window.showInformationMessage(
              `${shown} is outside the project. To share these mocks with the team, a copy goes into .vscode/flutter-intercept/collections/.`,
              { modal: true, detail: 'The document is copied as it is: check its examples and server URLs for real data before you commit it.' },
              'Copy as it is',
            );
        if (!choice) return undefined;
        const copied = await core.copyIn(text, path.basename(real), choice === 'Copy as it is' ? 'as-is' : 'sanitised');
        rel = copied.file;
        if (copied.removed.length) log(`collections: copied ${rel} without ${copied.removed.length} credential(s)`);
      }
      const environment = await askEnvironment(rel, primary);
      if (environment === null) return undefined;
      const { id } = await after(core.addLink({ file: rel, folderPath: primary, ...(environment !== undefined ? { environment } : {}) }));
      await askVariables(id);
      const s = core.state().find((x) => x.id === id);
      if (s) void vscode.window.showInformationMessage(`Mocking ${s.mocked} request${s.mocked === 1 ? '' : 's'} from "${s.name}"${s.noExample ? ` (${s.noExample} without an example answer 501)` : ''}. Hot restart the app if it's running.`);
      return { id };
    } catch (e) {
      void vscode.window.showErrorMessage(`Mock from a collection: ${(e as Error).message}`);
      return undefined;
    }
  };

  // ---------------------------------------------------------------- CONTRACTS §23 (part 2)

  // REVIEW-15 #8 (as importing): one "fake backend from traffic" flow at a time
  let fromTrafficBusy = false;
  const mockFromTrafficInteractive = async (source: TrafficSource): Promise<MockFromTrafficResult | undefined> => {
    if (fromTrafficBusy) {
      void vscode.window.showInformationMessage('Making a fake backend from traffic is already open.');
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
    // 1. servers: the app's own JSON APIs chosen, third-party services listed unchosen
    const picked = await vscode.window.showQuickPick(
      all.map((o) => ({
        label: cleanLine(o.origin.replace(/^https?:\/\//, ''), 120),
        description: `${o.requests} request${o.requests === 1 ? '' : 's'}${o.json ? '' : ', no JSON'}${o.thirdParty ? ' · third-party service' : ''}`,
        picked: o.preselected,
        origin: o.origin,
      })),
      { title: `${title} (1/3)`, placeHolder: 'Which servers should the fake backend answer for? Their recorded answers become its examples.', canPickMany: true, ignoreFocusOut: true },
    );
    if (!picked?.length) return undefined;
    const origins = picked.map((p) => p.origin);
    // 2. a name
    const name = await vscode.window.showInputBox({
      title: `${title} (2/3)`,
      prompt: 'A name for the collection (its file goes to .vscode/flutter-intercept/collections/)',
      value: `${cleanLine(origins[0].replace(/^https?:\/\//, ''), 80)} (recorded)`,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() && v.trim().length <= 100 ? undefined : 'Use 1–100 characters'),
    });
    if (name === undefined) return undefined;
    // 3. personal data (on by default)
    const replace = { label: 'Replace e-mails, phone numbers and addresses', description: 'recommended', replace: true };
    const keep = { label: 'Keep them as recorded', description: 'the file holds real personal data', replace: false };
    const pd = await vscode.window.showQuickPick([replace, keep], { title: `${title} (3/3)`, placeHolder: 'Personal data in the recorded answers', ignoreFocusOut: true });
    if (!pd) return undefined;
    // 4. what requests it has no answer for do — and what the file holds
    const fallback = 'Fall back to the real server';
    const offline = "Offline: fail what wasn't recorded";
    const choice = await vscode.window.showInformationMessage(
      `Make "${cleanLine(name.trim(), 100)}" from ${origins.length} server${origins.length === 1 ? '' : 's'}?`,
      {
        modal: true,
        detail:
          "Credentials removed; example bodies are real data — review before committing. The collection is written to .vscode/flutter-intercept/collections/ (opened for review) and linked in .vscode/flutter-intercept.json for the team. Requests it has no answer for can fall back to the real server, or fail as if offline.",
      },
      fallback,
      offline,
    );
    if (!choice) return undefined;
    const r = await after(core.mockFromTraffic({ source, name: name.trim(), origins, unmatched: choice === offline ? 'fail' : 'passthrough', replacePersonalData: pd.replace }));
    // "+ Open file" (§23.2): the new file opens for review, focus stays where it was; the panel shows the result line
    void Promise.resolve(vscode.window.showTextDocument(vscode.Uri.file(path.join(primary, ...r.file.split('/'))), { preview: true, preserveFocus: true })).catch(() => undefined);
    return r;
  };

  // §23.4: read-only before / after documents for vscode.diff
  const diffDocs = new Map<string, string>();
  let diffRegistration: vscode.Disposable | undefined;
  let diffSeq = 0;
  const showExampleDiff = async (u: ExampleUpdate): Promise<void> => {
    if (!diffRegistration) {
      diffRegistration = vscode.workspace.registerTextDocumentContentProvider(EXAMPLE_DIFF_SCHEME, { provideTextDocumentContent: (uri) => diffDocs.get(`${uri.path}?${uri.query}`) ?? '' });
    }
    const n = ++diffSeq;
    const base = path.posix.basename(u.file) || 'collection.json';
    const put = (side: string, text: string) => {
      const uri = vscode.Uri.from({ scheme: EXAMPLE_DIFF_SCHEME, path: `/${side}/${base}`, query: String(n) });
      diffDocs.set(`${uri.path}?${uri.query}`, text);
      while (diffDocs.size > MAX_DIFF_DOCS * 2) diffDocs.delete(diffDocs.keys().next().value as string);
      return uri;
    };
    const left = put('now', u.edit!.before);
    const right = put('updated', u.edit!.after);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${base}: ${u.mode === 'merge' ? 'update' : 'add'} example "${cleanLine(u.example, 80)}"`, { preview: true });
  };

  const updateExampleInteractive = async (id: string, endpoint: string, status: number, mode: 'merge' | 'add' = 'merge'): Promise<'updated' | 'copied' | 'cancelled'> => {
    const u = await core.exampleUpdate(id, endpoint, status, mode);
    const file = cleanLine(u.file, 200);
    if (!u.edit) {
      const copy = 'Copy the updated example';
      const ok = await vscode.window.showInformationMessage(
        `${file} isn't changed here: ${cleanLine(u.copyOnly ?? 'this format is not edited', 200)}.`,
        { modal: true, detail: 'Copy the updated example and paste it into the file yourself. Credentials are removed; other values are real data from the server.' },
        copy,
      );
      if (ok !== copy) return 'cancelled';
      await vscode.env.clipboard.writeText(u.newBody);
      return 'copied';
    }
    await showExampleDiff(u);
    const ok = await vscode.window.showWarningMessage(
      `${u.mode === 'merge' ? 'Update' : 'Add'} example "${cleanLine(u.example, 100)}" in ${file}?`,
      {
        modal: true,
        detail:
          "This changes a file shared with the team (the diff shows exactly what). The collection's remembered data restarts from its examples, and if some of its answers are limited until approved, it asks for approval again. Credentials are removed from the server's answer; other values are real data.",
      },
      'Update example',
    );
    if (ok !== 'Update example') return 'cancelled';
    await after(core.applyExampleUpdate(u));
    return 'updated';
  };

  return {
    ready,
    state: () => core.state(),
    rules: () => core.rules(),
    fileProblems: () => core.fileProblems(),
    onDidChange: (listener) => changed.event(listener),
    endpoints: (id) => core.endpoints(id),
    example: (id, endpoint, name) => core.example(id, endpoint, name),
    toRule: (id, endpoint) => core.toRule(id, endpoint),
    update: (id, patch) => after(core.update(id, patch)),
    removeWithConfirmation: async (id) => {
      const s = core.state().find((x) => x.id === id);
      if (!s) throw new Error(`No collection "${String(id).slice(0, 60)}" is linked`);
      const ok = await vscode.window.showWarningMessage(
        `Stop mocking from "${cleanLine(s.name, 120)}"?`,
        { modal: true, detail: `The link is removed from .vscode/flutter-intercept.json for everyone who uses it. ${cleanLine(s.file, 200)} itself is kept.` },
        'Remove',
      );
      if (ok !== 'Remove') return false;
      await after(core.remove(id));
      return true;
    },
    importFile: (pick) => after(core.addLink(pick)),
    importInteractive,
    approveWithConfirmation: async (id) => {
      const sum = core.approvalSummary(id);
      if (!sum) return true;
      const where = sum.origins.length ? ` on ${sum.origins.map((o) => cleanLine(o.replace(/^https?:\/\//, ''), 80)).join(', ')}` : '';
      const ok = await vscode.window.showWarningMessage(
        `"${sum.name}" wants to: ${sum.reasons.join(', ')} (${sum.answers} answer${sum.answers === 1 ? '' : 's'})${where}.`,
        {
          modal: true,
          detail:
            'Until you approve, these answers are served without those parts (no redirect target, no cookies, no CORS or security-policy headers, HTML and scripts as plain text). Approve only if you trust this file. Changing the file or its server URL asks again.',
        },
        'Approve',
      );
      if (ok !== 'Approve') return false;
      await after(core.approve(id));
      return true;
    },
    describeRule: (ruleId) => core.describeRule(ruleId),
    // CONTRACTS §22.9
    storeStatus: (id) => core.storeStatus(id),
    storeItems: (id, resource, opts) => core.storeItems(id, resource, opts),
    updateStore: async (id, patch) => {
      // settings changes rebuild the rules (listeners re-apply them); data changes only fire onDidChangeStore
      if (await core.updateStore(id, patch)) changed.fire();
    },
    storeSnapshot: async (id, action, name) => {
      const n = name ?? (action === 'save' ? await askSnapshotName(id) : undefined);
      if (n === undefined) throw new Error(`${action} needs a snapshot name`);
      const r = await core.storeSnapshot(id, action, n);
      if (action !== 'load') changed.fire(); // the list of snapshots changed
      return r;
    },
    storeOpOf: (exchangeId) => core.storeOpOf(exchangeId),
    onDidChangeStore: (listener) => storeChanged.event((e) => listener(e.id, e.resource)),
    // CONTRACTS §24
    answerOf: (exchangeId) => core.answerOf(exchangeId),
    expireSessions: (id) => {
      const n = core.expireSessions(id);
      authChanged.fire(id);
      return n;
    },
    authCollectionFor: (url) => core.authCollectionFor(url),
    onDidChangeAuth: (listener) => authChanged.event(listener),
    endpointForRequest: (id, ex) => core.endpointForRequest(id, ex),
    // CONTRACTS §23
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
    onDidChangeDrift: (listener) => driftChanged.event(listener),
    reload,
    dispose: () => {
      disposed = true;
      core.stopDrift();
      diffRegistration?.dispose();
      diffDocs.clear();
      clearTimeout(timer);
      for (const { watcher } of dirWatchers.values()) watcher.dispose();
      dirWatchers.clear();
      for (const w of snapshotWatchers.values()) w.dispose();
      snapshotWatchers.clear();
      for (const d of disposables) d.dispose();
    },
  };
}
