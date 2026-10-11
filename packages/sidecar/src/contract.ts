/**
 * Contract checks for the sidecar (CONTRACTS §10.3): the same ContractIndex / checkExchange as the VS Code service
 * (packages/extension/src/contract/core.ts), with a Node scan of `*.g.dart` / `*.chopper.dart` under the project
 * roots, a recursive `fs.watch` where the platform supports it (macOS, Windows, Linux on Node ≥ 20), and the user's
 * route → model choices in the state store. No editor diagnostics (the IDE has no such channel in this protocol).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Exchange } from '@flutter-intercept/proxy';
import { checkExchange, ContractIndex, isExcludedPath, isGeneratedFile, nodeFs, yieldToLoop } from '../../extension/src/contract/core';
import { routeKey } from '../../extension/src/contract/mapping';
import type { ApiEndpoint, ContractResult, ContractService } from '../../extension/src/contract/types';
import type { Memento } from './state';

export const ROUTES_KEY = 'contractRoutes';
export const DONT_CHECK = '';
const MAX_SCAN_FILES = 20_000;
const MAX_CACHE = 2_000;
const SKIP_DIRS = new Set(['.dart_tool', 'build', '.pub-cache', '.pub', 'node_modules', '.git', '.symlinks', '.plugin_symlinks', 'ephemeral', '.idea', '.gradle']);

/** Every generated Dart file under `roots` (excluded folders skipped), at most `max`. */
export async function findGeneratedFiles(roots: string[], max = MAX_SCAN_FILES): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= max || depth > 30) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(p, depth + 1);
      } else if (e.isFile() && isGeneratedFile(p) && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  };
  for (const r of roots) await walk(r, 0);
  return out;
}

export interface NodeContractService extends ContractService {
  forget(ids: string[]): void;
  clear(): void;
  cached(id: string): ContractResult | undefined;
  /** Project roots changed: rescan on the next check and re-watch. */
  rootsChanged(): void;
  dispose(): void;
}

export function createNodeContractService(deps: { roots(): string[]; memento: Memento; log?(m: string): void; watch?: boolean }): NodeContractService {
  const log = deps.log ?? (() => undefined);
  const index = new ContractIndex(nodeFs, { roots: deps.roots, log });
  const listeners = new Set<() => void>();
  const cache = new Map<string, { key: string; result: ContractResult }>();
  let userVersion = 0;
  let scan: Promise<void> | undefined;
  let disposed = false;
  let watchers: fs.FSWatcher[] = [];

  const ensureIndexed = (): Promise<void> => {
    scan ??= (async () => {
      const t0 = Date.now();
      try {
        const files = await findGeneratedFiles(deps.roots());
        await index.setFiles(files);
        log(`contract: indexed ${index.allModels().length} models and ${index.endpoints.length} API methods from ${files.length} generated files in ${Date.now() - t0} ms`);
      } catch (e) {
        log(`contract: workspace scan failed: ${String(e)}`);
      }
    })();
    return scan;
  };

  const routes = (): Record<string, string> => {
    const v = deps.memento.get<unknown>(ROUTES_KEY);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, m] of Object.entries(v as Record<string, unknown>)) if (typeof m === 'string') out[k] = m;
    return out;
  };

  const modelsChanged = () => {
    cache.clear();
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // keep notifying
      }
    }
  };

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = async () => {
    timer = undefined;
    const files = [...pending];
    pending.clear();
    let changed = false;
    for (const f of files) changed = (await index.touch(f)) || changed;
    if (changed && !disposed) modelsChanged();
  };
  const watch = () => {
    for (const w of watchers) w.close();
    watchers = [];
    if (deps.watch === false || disposed) return;
    for (const root of deps.roots()) {
      try {
        const w = fs.watch(root, { recursive: true, persistent: false }, (_ev, name) => {
          if (!name) return;
          const p = path.join(root, name.toString());
          if (!p.endsWith('.dart') || isExcludedPath(p)) return;
          if (!isGeneratedFile(p) && !index.isOwner(p)) return;
          pending.add(p);
          timer ??= setTimeout(() => void flush(), 300);
        });
        w.on('error', () => undefined);
        watchers.push(w);
      } catch (e) {
        log(`contract: can't watch ${path.basename(root)} for model changes (${(e as Error).message}); models refresh on restart`);
      }
    }
  };
  watch();

  return {
    async check(exchange: Exchange, opts?: { model?: string }): Promise<ContractResult> {
      try {
        await ensureIndexed();
        await yieldToLoop();
        const explicit = opts?.model !== undefined && opts.model.trim() !== '' ? opts.model : undefined;
        const userModel = explicit === undefined ? routes()[routeKey(exchange.method, exchange.url)] : undefined;
        const key = [index.version, userVersion, explicit ?? '', userModel ?? '\0', exchange.state, exchange.status ?? '', exchange.responseBody?.text.length ?? -1, exchange.source ? exchange.source.frames.length : 0].join('|');
        const hit = cache.get(exchange.id);
        if (hit && hit.key === key) return hit.result;
        const result = checkExchange(index, exchange, { model: explicit, userModel });
        if (!explicit) {
          cache.delete(exchange.id);
          cache.set(exchange.id, { key, result });
          if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
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
      return index.endpoints.map(({ apiClass: _a, kind: _k, rawPath: _r, ...ep }) => ({ ...ep, params: ep.params?.map((p) => ({ ...p })) }));
    },
    async remember(exchange: Exchange, model: string | undefined) {
      const all = routes();
      const key = routeKey(exchange.method, exchange.url);
      if (model === undefined) delete all[key];
      else all[key] = model;
      await deps.memento.update(ROUTES_KEY, all);
      userVersion++;
      cache.clear();
    },
    onDidChangeModels(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    forget(ids: string[]) {
      for (const id of ids) cache.delete(id);
    },
    clear() {
      cache.clear();
    },
    cached(id: string) {
      return cache.get(id)?.result;
    },
    rootsChanged() {
      scan = undefined;
      watch();
      void ensureIndexed().then(modelsChanged);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const w of watchers) w.close();
      watchers = [];
      listeners.clear();
    },
  };
}
