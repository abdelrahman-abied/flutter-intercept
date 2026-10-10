/**
 * ContractService (CONTRACTS §10.3): the vscode layer over `core.ts` — workspace scan of `*.g.dart` /
 * `*.chopper.dart`, a FileSystemWatcher keeping the index fresh, the user's route → model choices in
 * workspaceState, a per-exchange result cache and the diagnostics.
 */
import * as vscode from 'vscode';
import type { Exchange } from '@flutter-intercept/proxy';
import type { ApiEndpoint, ContractResult, ContractService } from './types';
import { checkExchange, ContractFs, ContractIndex, isExcludedPath, isGeneratedFile, nodeFs, yieldToLoop } from './core';
import { ContractDiagnostics } from './diagnostics';
import type { XViolation } from './check';
import { routeKey } from './mapping';

/** workspaceState key: Record<"GET /users/{id}", modelName | "">. */
export const ROUTES_KEY = 'flutterIntercept.contractRoutes';
/** `remember(ex, DONT_CHECK)` = "Don't check this route". */
export const DONT_CHECK = '';

export const GENERATED_GLOB = '**/*.{g,chopper}.dart';
export const EXCLUDE_GLOB = '{**/.dart_tool/**,**/build/**,**/.pub-cache/**,**/node_modules/**,**/.git/**,**/.symlinks/**,**/.plugin_symlinks/**,**/ephemeral/**}';
const MAX_SCAN_FILES = 20_000;
const MAX_CACHE = 2_000;

export interface ContractServiceDeps {
  /** workspaceState: where the user's route → model choices live. */
  workspaceState: vscode.Memento;
  /** `flutterIntercept.contractCheck`; default reads the setting. Off = no diagnostics (check() still answers). */
  enabled?: () => boolean;
  log?: (msg: string) => void;
  /** Tests: file access and the scan. */
  fs?: ContractFs;
  /** Workspace folders (default: vscode.workspace.workspaceFolders). Only files real-resolving inside them are read or get diagnostics. */
  roots?: () => string[];
  findFiles?: () => Promise<string[]>;
  diagnostics?: ContractDiagnostics;
  watch?: boolean;
}

export interface ContractServiceHost extends ContractService, vscode.Disposable {
  /** Exchanges evicted from the ring buffer: drop their results and diagnostics. */
  forget(ids: string[]): void;
  /** Traffic cleared: drop every result and diagnostic. */
  clear(): void;
  /** The last result computed for an exchange (no work), if any. */
  cached(id: string): ContractResult | undefined;
}

export function createContractService(deps: ContractServiceDeps): ContractServiceHost {
  const log = deps.log ?? (() => undefined);
  const enabled = deps.enabled ?? (() => vscode.workspace.getConfiguration('flutterIntercept').get<boolean>('contractCheck', true));
  const roots = deps.roots ?? (() => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  const index = new ContractIndex(deps.fs ?? nodeFs, { roots, log });
  const diagnostics = deps.diagnostics ?? new ContractDiagnostics();
  const emitter = new vscode.EventEmitter<void>();
  const cache = new Map<string, { key: string; result: ContractResult }>();
  const disposables: vscode.Disposable[] = [emitter, diagnostics];
  let userVersion = 0;
  let scan: Promise<void> | undefined;
  let disposed = false;

  const findFiles =
    deps.findFiles ??
    (async () => (await vscode.workspace.findFiles(GENERATED_GLOB, EXCLUDE_GLOB, MAX_SCAN_FILES)).map((u) => u.fsPath));

  const ensureIndexed = (): Promise<void> => {
    scan ??= (async () => {
      const t0 = Date.now();
      try {
        const files = await findFiles();
        await index.setFiles(files);
        log(`contract: indexed ${index.allModels().length} models and ${index.endpoints.length} API methods from ${files.length} generated files in ${Date.now() - t0} ms`);
      } catch (e) {
        log(`contract: workspace scan failed: ${String(e)}`);
      }
    })();
    return scan;
  };

  const routes = (): Record<string, string> => {
    const v = deps.workspaceState.get<unknown>(ROUTES_KEY);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, m] of Object.entries(v as Record<string, unknown>)) if (typeof m === 'string') out[k] = m;
    return out;
  };

  const modelsChanged = () => {
    cache.clear();
    diagnostics.clear();
    emitter.fire();
  };

  // FileSystemWatcher: generated files and the owners we read (model / API sources), batched.
  if (deps.watch !== false) {
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      timer = undefined;
      const files = [...pending];
      pending.clear();
      let changed = false;
      for (const f of files) changed = (await index.touch(f)) || changed;
      if (changed && !disposed) modelsChanged();
    };
    const onFile = (uri: vscode.Uri) => {
      const p = uri.fsPath;
      if (isExcludedPath(p)) return;
      if (!isGeneratedFile(p) && !index.isOwner(p)) return;
      pending.add(p);
      timer ??= setTimeout(() => void flush(), 300);
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.dart');
    disposables.push(
      watcher,
      watcher.onDidChange(onFile),
      watcher.onDidCreate(onFile),
      watcher.onDidDelete(onFile),
      { dispose: () => timer && clearTimeout(timer) },
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        scan = undefined;
        void ensureIndexed().then(modelsChanged);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('flutterIntercept.contractCheck')) {
          diagnostics.clear();
          cache.clear();
          emitter.fire();
        }
      }),
    );
  }

  const service: ContractServiceHost = {
    async check(exchange: Exchange, opts?: { model?: string }): Promise<ContractResult> {
      try {
        await ensureIndexed();
        await yieldToLoop(); // REVIEW-4 #5: a bulk re-check never runs as one long microtask chain
        const explicit = opts?.model !== undefined && opts.model.trim() !== '' ? opts.model : undefined;
        const userModel = explicit === undefined ? routes()[routeKey(exchange.method, exchange.url)] : undefined;
        const key = [
          index.version,
          userVersion,
          explicit ?? '',
          userModel ?? '\0',
          exchange.state,
          exchange.status ?? '',
          exchange.responseBody?.text.length ?? -1,
          exchange.source ? exchange.source.frames.length : 0,
        ].join('|');
        const hit = cache.get(exchange.id);
        let result: ContractResult;
        if (hit && hit.key === key) result = hit.result;
        else {
          result = checkExchange(index, exchange, { model: explicit, userModel });
          if (!explicit) {
            cache.delete(exchange.id);
            cache.set(exchange.id, { key, result });
            if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
          }
        }
        if (!explicit && !disposed) {
          if (enabled()) diagnostics.set(exchange.id, (result.violations as XViolation[]).filter((v) => !!v.file && index.inRoots(v.file)));
          else diagnostics.set(exchange.id, []);
        }
        return result;
      } catch (e) {
        return { exchangeId: exchange.id, checked: false, via: 'none', violations: [], reason: `internal error: ${(e as Error).message}` };
      }
    },

    async models() {
      await ensureIndexed();
      const seen = new Set<string>();
      const out: { name: string; file: string }[] = [];
      for (const m of index.allModels()) {
        const file = m.sourceFile ?? m.generatedFile;
        const k = `${m.name}\0${file}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ name: m.name, file });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
    },

    async endpoints(): Promise<ApiEndpoint[]> {
      await ensureIndexed();
      // copies without the scanner's internals (apiClass/kind/rawPath)
      return index.endpoints.map(({ apiClass: _a, kind: _k, rawPath: _r, ...ep }) => ({ ...ep, params: ep.params?.map((p) => ({ ...p })) }));
    },

    async remember(exchange: Exchange, model: string | undefined) {
      const all = routes();
      const key = routeKey(exchange.method, exchange.url);
      if (model === undefined) delete all[key];
      else all[key] = model;
      await deps.workspaceState.update(ROUTES_KEY, all);
      userVersion++;
      cache.clear();
    },

    onDidChangeModels(listener: () => void) {
      return emitter.event(listener);
    },

    forget(ids: string[]) {
      for (const id of ids) cache.delete(id);
      diagnostics.delete(ids);
    },

    clear() {
      cache.clear();
      diagnostics.clear();
    },

    cached(id: string) {
      return cache.get(id)?.result;
    },

    dispose() {
      disposed = true;
      for (const d of disposables.splice(0)) {
        try {
          d.dispose();
        } catch {
          // keep disposing
        }
      }
    },
  };
  return service; // the workspace scan runs on the first check()/models()
}
