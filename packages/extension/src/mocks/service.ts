/**
 * VS Code layer of "Mock from a collection" (CONTRACTS §21.6, §21.7): wires MockCollectionsCore (src/mocks/core.ts)
 * to the shared rules file, workspaceState, file watchers and the IDE's own dialogs.
 *
 * - The panel never sees a path: the file picker, the copy question and the remove confirmation are IDE dialogs.
 * - Collection and environment files are watched by exact path (a directory watcher per folder, like body files in
 *   src/rules/service.ts: a file name may contain glob characters); edits reload after a short debounce.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import type { SharedRulesHost } from '../rules/service';
import { nodeRulesFs } from '../rules/service';
import type { MementoLike } from '../rules/core';
import type { RulesFs } from '../rules/bodyFile';
import { COLLECTION_LIMITS } from './types';
import { MockCollectionsCore, type CollectionAnswer, type CollectionParsers } from './core';
import { cleanLine } from './limit';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus } from '../ui/protocol';

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
  /** Tests: a fake file system. */
  fs?: RulesFs;
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
}

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
  const disposables: vscode.Disposable[] = [changed];
  let disposed = false;

  // exact-path watching: one watcher per directory ("*"), events matched against the files in use
  const dirWatchers = new Map<string, { watcher: vscode.Disposable; files: Set<string> }>();
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
    if (dirWatchers.get(path.dirname(abs))?.files.has(abs)) scheduleReload();
  };
  const watchFile = (abs: string) => {
    if (disposed) return;
    const dir = path.dirname(abs);
    let entry = dirWatchers.get(dir);
    if (!entry) {
      if (dirWatchers.size >= MAX_WATCHED_DIRS) return;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*'));
      watcher.onDidCreate(onFileEvent);
      watcher.onDidChange(onFileEvent);
      watcher.onDidDelete(onFileEvent);
      entry = { watcher, files: new Set() };
      dirWatchers.set(dir, entry);
    }
    entry.files.add(abs);
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
  });

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
      filters: { 'Postman collection or OpenAPI': ['json', 'yaml', 'yml'] },
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
        const st = await files.stat(real);
        if (st.size > COLLECTION_LIMITS.fileBytes) throw new Error(`${path.basename(real)} is larger than 20 MB`);
        const text = new TextDecoder().decode(await files.readFile(real));
        const shown = cleanLine(path.basename(real), 120);
        // REVIEW-15 #8: only a Postman collection can be copied without credentials; say so for OpenAPI documents
        const postman = core.formatOf(text, path.basename(real)) === 'postman';
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
      const { id } = await after(core.addLink({ file: rel, folderPath: primary }));
      await askVariables(id);
      const s = core.state().find((x) => x.id === id);
      if (s) void vscode.window.showInformationMessage(`Mocking ${s.mocked} request${s.mocked === 1 ? '' : 's'} from "${s.name}"${s.noExample ? ` (${s.noExample} without an example answer 501)` : ''}. Hot restart the app if it's running.`);
      return { id };
    } catch (e) {
      void vscode.window.showErrorMessage(`Mock from a collection: ${(e as Error).message}`);
      return undefined;
    }
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
    endpointForRequest: (id, ex) => core.endpointForRequest(id, ex),
    reload,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      for (const { watcher } of dirWatchers.values()) watcher.dispose();
      dirWatchers.clear();
      for (const d of disposables) d.dispose();
    },
  };
}
