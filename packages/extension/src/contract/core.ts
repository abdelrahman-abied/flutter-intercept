/**
 * Contract check core (CONTRACTS §10.3), no `vscode`: the model + API index over `*.g.dart` /
 * `*.chopper.dart` files (cached by mtime, owners linked through `part of`), and `checkExchange`, which
 * maps an exchange to a model (user → source → retrofit/chopper) and walks its JSON body.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Exchange } from '@flutter-intercept/proxy';
import type { ContractResult, MappingVia } from './types';
import { parseApiFile, XEndpoint } from './api';
import { checkValue, ModelLookup, XViolation } from './check';
import { GeneratedFileInfo, parseGeneratedDart } from './generated';
import { parseJson } from './json';
import { bestEndpoint, endpointsFromFrames, GeneratedClassRef, matchEndpoint, splitUrl } from './mapping';
import { LinkedModel, linkModelsToOwner } from './owner';
import { checkSourcePath, isUncPath } from '../source/resolve';

export interface FileStat {
  mtimeMs: number;
  size: number;
  isFile: boolean;
}

export interface ContractFs {
  /** stat (following symlinks), or undefined when the file is gone. */
  stat(p: string): FileStat | undefined;
  /** The text of a regular file of at most `maxBytes`, else undefined. Must never block on FIFOs / devices. */
  read(p: string, maxBytes: number): string | undefined;
  /** Real path (symlinks resolved), or undefined. */
  realpath(p: string): string | undefined;
}

/**
 * REVIEW-4 #3: open non-blocking, then fstat the descriptor we will read from (no stat/read race), and
 * read only a regular file within the size cap: no FIFOs (hang), devices (`/dev/zero` → OOM) or huge files.
 */
export const nodeFs: ContractFs = {
  stat(p) {
    try {
      const st = fs.statSync(p);
      return { mtimeMs: st.mtimeMs, size: st.size, isFile: st.isFile() };
    } catch {
      return undefined;
    }
  },
  read(p, maxBytes) {
    if (isUncPath(p)) return undefined;
    let fd: number | undefined;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > maxBytes) return undefined;
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      return buf.toString('utf8', 0, off);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  },
  realpath(p) {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return undefined;
    }
  },
};

/** Generated files we read. */
export const isGeneratedFile = (p: string): boolean => /\.(g|chopper)\.dart$/.test(p);

/** Paths we never index (tool output, pub cache, plugin symlinks). */
export function isExcludedPath(p: string): boolean {
  return /[\\/](\.dart_tool|build|\.pub-cache|\.pub|node_modules|\.git|\.symlinks|\.plugin_symlinks|ephemeral)[\\/]/.test(p);
}

/** `part of 'x.dart'` we follow: a relative `.dart` URI (no scheme, not absolute, no UNC / drive / backslash). */
export function isSafePartOf(uri: string): boolean {
  return /^[^:\\/][^:\\]*\.dart$/.test(uri) && !/^[A-Za-z]:/.test(uri);
}

/** Per-file cap: ~40 ms of scanning at worst (REVIEW-4 #5); larger owners are simply not linked. */
export const MAX_FILE_BYTES = 1_000_000;
/** Total text indexed (generated files + owners). */
export const MAX_TOTAL_BYTES = 64_000_000;

/** Let the event loop run (REVIEW-4 #5: the index build never blocks for long). */
export const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

export interface IndexOptions {
  /** Workspace folders: generated files and owners must (real-)resolve inside one. Absent = no restriction (tests). */
  roots?: () => string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  log?: (msg: string) => void;
}

interface Entry {
  mtime: number;
  info: GeneratedFileInfo;
  owner?: string;
  ownerMtime?: number;
  endpoints: XEndpoint[];
  bytes: number;
}

export class ContractIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly owners = new Map<string, Set<string>>(); // owner → generated files
  private built?: { models: Map<string, LinkedModel[]>; endpoints: XEndpoint[]; classes: GeneratedClassRef[] };
  private totalBytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  /** Files skipped by the caps, the roots check or unreadable (for logs / tests). */
  skipped = 0;
  /** Bumped whenever anything that can change a result changes. */
  version = 0;

  constructor(
    private readonly fsx: ContractFs = nodeFs,
    private readonly opts: IndexOptions = {},
  ) {
    this.maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
  }

  /** `p` real-resolves inside a root (REVIEW-3 #3 rules: no UNC, symlinks resolved); with no roots configured, true. */
  inRoots(p: string): boolean {
    const roots = this.opts.roots?.();
    if (!roots) return !isUncPath(p);
    try {
      checkSourcePath(p, roots, (x) => {
        const r = this.fsx.realpath(x);
        if (r === undefined) throw new Error('not found');
        return r;
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Full set of generated files (a workspace scan); re-reads only what changed, yielding between files. */
  async setFiles(files: string[]): Promise<boolean> {
    const wanted = new Set(files.filter((f) => isGeneratedFile(f) && !isExcludedPath(f)).map((f) => path.resolve(f)));
    let changed = false;
    for (const f of [...this.entries.keys()]) {
      if (!wanted.has(f)) {
        this.drop(f);
        changed = true;
      }
    }
    for (const f of wanted) changed = (await this.refresh(f)) || changed;
    if (changed) this.invalidate();
    return changed;
  }

  /** A file changed / was created / deleted (generated, owner or anything else). Resolves true if the index changed. */
  async touch(file: string): Promise<boolean> {
    const f = path.resolve(file);
    let changed = false;
    if (isGeneratedFile(f) && !isExcludedPath(f)) changed = await this.refresh(f);
    else if (this.owners.has(f)) {
      for (const g of [...(this.owners.get(f) ?? [])]) {
        if (this.entries.has(g)) changed = (await this.refresh(g, true)) || changed;
      }
    }
    if (changed) this.invalidate();
    return changed;
  }

  isOwner(file: string): boolean {
    return this.owners.has(path.resolve(file));
  }

  private readonly pubspecNames = new Map<string, string | null>();

  /** `package:<pubspec name>/<path under lib/>` for a file inside a package's `lib/`, else undefined. Never walks above the roots. */
  importUriFor(file: string): string | undefined {
    const roots = this.opts.roots?.().map((r) => path.resolve(r));
    let dir = path.dirname(file);
    for (let guard = 0; guard < 40; guard++) {
      if (roots && !roots.some((r) => dir === r || dir.startsWith(r + path.sep))) return undefined;
      let name = this.pubspecNames.get(dir);
      if (name === undefined) {
        const pubspec = this.fsx.read(path.join(dir, 'pubspec.yaml'), 256_000);
        name = pubspec === undefined ? null : (/^name:\s*["']?([A-Za-z0-9_]+)/m.exec(pubspec)?.[1] ?? null);
        this.pubspecNames.set(dir, name);
      }
      if (name) {
        const rel = path.relative(path.join(dir, 'lib'), file);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
        return `package:${name}/${rel.split(path.sep).join('/')}`;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
    return undefined;
  }

  private invalidate(): void {
    this.built = undefined;
    this.version++;
  }

  private drop(f: string): void {
    const e = this.entries.get(f);
    if (e?.owner) this.owners.get(e.owner)?.delete(f);
    if (e) this.totalBytes -= e.bytes;
    this.entries.delete(f);
  }

  /** Reads a file we're allowed to (inside the roots, regular, within both caps). */
  private readAllowed(p: string): string | undefined {
    if (!this.inRoots(p)) return undefined;
    const budget = Math.min(this.maxFileBytes, this.maxTotalBytes - this.totalBytes);
    if (budget <= 0) return undefined;
    return this.fsx.read(p, budget);
  }

  private async refresh(f: string, force = false): Promise<boolean> {
    const st = this.fsx.stat(f);
    const prev = this.entries.get(f);
    if (!st || !st.isFile) {
      if (prev) {
        this.drop(f);
        return true;
      }
      return false;
    }
    const ownerMtime = prev?.owner ? this.fsx.stat(prev.owner)?.mtimeMs : undefined;
    if (!force && prev && prev.mtime === st.mtimeMs && prev.ownerMtime === ownerMtime) return false;
    if (prev) this.drop(f);
    const text = this.readAllowed(f);
    if (text === undefined) {
      this.skipped++;
      if (!prev) this.opts.log?.(`contract: skipped ${path.basename(f)} (outside the workspace, not a regular file, or over the size limits)`);
      return !!prev;
    }
    await yieldToLoop();
    const info = parseGeneratedDart(text, f);
    const entry: Entry = { mtime: st.mtimeMs, info, endpoints: [], bytes: text.length };
    this.totalBytes += text.length;
    if (info.partOf && isSafePartOf(info.partOf)) {
      const owner = path.resolve(path.dirname(f), info.partOf);
      entry.owner = owner;
      if (!this.owners.has(owner)) this.owners.set(owner, new Set());
      this.owners.get(owner)!.add(f);
      entry.ownerMtime = this.fsx.stat(owner)?.mtimeMs;
      const ownerText = info.models.length || info.apiClasses.length ? this.readAllowed(owner) : undefined;
      if (ownerText !== undefined) {
        entry.bytes += ownerText.length;
        this.totalBytes += ownerText.length;
        if (info.models.length) {
          await yieldToLoop();
          linkModelsToOwner(info.models, ownerText, owner);
        }
        if (info.apiClasses.length) {
          await yieldToLoop();
          const apis = new Set(info.apiClasses.map((c) => c.api));
          entry.endpoints = parseApiFile(ownerText, owner).filter((e) => apis.has(e.apiClass));
          const importUri = this.importUriFor(owner);
          if (importUri) for (const e of entry.endpoints) e.importUri = importUri;
        }
      }
    }
    this.entries.set(f, entry);
    return true;
  }

  private build() {
    if (this.built) return this.built;
    const models = new Map<string, LinkedModel[]>();
    const endpoints: XEndpoint[] = [];
    const classes: GeneratedClassRef[] = [];
    for (const [file, e] of this.entries) {
      for (const m of e.info.models) {
        const list = models.get(m.name) ?? [];
        list.push(m);
        models.set(m.name, list);
      }
      endpoints.push(...e.endpoints);
      for (const c of e.info.apiClasses) classes.push({ generated: c.generated, api: c.api, file });
    }
    this.built = { models, endpoints, classes };
    return this.built;
  }

  get endpoints(): XEndpoint[] {
    return this.build().endpoints;
  }

  get classes(): GeneratedClassRef[] {
    return this.build().classes;
  }

  allModels(): LinkedModel[] {
    return [...this.build().models.values()].flat();
  }

  /** Model by name; with several, the one closest (directory-wise) to `near`. */
  model(name: string, near?: string): LinkedModel | undefined {
    const list = this.build().models.get(name);
    if (!list?.length) return undefined;
    if (list.length === 1 || !near) return list[0];
    let best = list[0];
    let bestLen = -1;
    for (const m of list) {
      const len = commonPrefix(path.dirname(m.generatedFile), path.dirname(near));
      if (len > bestLen) {
        best = m;
        bestLen = len;
      }
    }
    return best;
  }

  lookupNear(near: string | undefined): ModelLookup {
    return { get: (name) => this.model(name, near) };
  }
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export interface CheckRequest {
  /** Explicit model ("User" / "List<User>"), e.g. from an agent: checked whatever the status. */
  model?: string;
  /** The user's saved choice for this route: a model name, or '' = "Don't check this route". */
  userModel?: string;
}

const result = (exchangeId: string, via: MappingVia, extra: Partial<ContractResult> = {}): ContractResult => ({
  exchangeId,
  checked: false,
  via,
  violations: [],
  ...extra,
});

/** `List<User>` → {name: "User", list: true}. */
function parseModelRef(ref: string): { name: string; list: boolean | undefined } {
  const m = /^\s*List\s*<\s*([A-Za-z_$][\w$]*)\s*>\s*$/.exec(ref);
  return m ? { name: m[1], list: true } : { name: ref.trim(), list: undefined };
}

function header(h: Record<string, string | string[]> | undefined, name: string): string | undefined {
  if (!h) return undefined;
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name) {
      const v = h[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/** Decides the mapping and walks the body. Never throws. */
export function checkExchange(index: ContractIndex, ex: Exchange, req: CheckRequest = {}): ContractResult {
  try {
    return checkExchangeUnsafe(index, ex, req);
  } catch (e) {
    return result(ex.id, 'none', { reason: `internal error: ${(e as Error).message}` });
  }
}

function checkExchangeUnsafe(index: ContractIndex, ex: Exchange, req: CheckRequest): ContractResult {
  // 1. mapping
  let via: MappingVia = 'none';
  let modelRef: { name: string; list: boolean | undefined } | undefined;
  let near: string | undefined;
  if (req.model !== undefined && req.model.trim()) {
    via = 'user';
    modelRef = parseModelRef(req.model);
  } else if (req.userModel !== undefined) {
    via = 'user';
    if (req.userModel === '') return result(ex.id, via, { reason: 'not checked: you chose "Don\'t check this route"' });
    modelRef = parseModelRef(req.userModel);
  } else {
    let ep: XEndpoint | undefined;
    if (ex.source?.frames?.length) {
      const fromFrames = endpointsFromFrames(ex.source.frames, index.classes, index.endpoints);
      ep = fromFrames.find((e) => matchEndpoint(e, ex.method, ex.url) !== undefined);
      if (ep) via = 'source';
    }
    if (!ep) {
      ep = bestEndpoint(index.endpoints, ex.method, ex.url)?.endpoint;
      if (ep) via = ep.kind;
    }
    if (!ep) return result(ex.id, 'none', { reason: 'no model mapped (no Retrofit/Chopper method matches this request; pick one)' });
    if (!ep.responseModel) {
      return result(ex.id, via, { reason: `${ep.apiClass}.${ep.dartMethod} returns no json_serializable model` });
    }
    modelRef = { name: ep.responseModel, list: !!ep.responseIsList };
    near = ep.file;
  }
  const model = index.model(modelRef.name, near);
  if (!model) return result(ex.id, via, { model: modelRef.name, reason: `model ${modelRef.name} not found in any *.g.dart (run build_runner?)` });

  // 2. the response
  const base = { model: model.name };
  if (ex.state !== 'completed' && ex.state !== 'mocked') return result(ex.id, via, { ...base, reason: `no response to check (${ex.state})` });
  const status = ex.status ?? 0;
  if (req.model === undefined && (status < 200 || status > 299)) {
    return result(ex.id, via, { ...base, reason: `status ${status}: fromJson only runs on success responses` });
  }
  const body = ex.responseBody;
  if (!body || body.text === '') return result(ex.id, via, { ...base, reason: 'empty body' });
  if (body.truncated) return result(ex.id, via, { ...base, reason: 'body truncated' });
  let text = body.text;
  if (body.encoding === 'base64') {
    const ct = header(ex.responseHeaders, 'content-type') ?? '';
    if (!/json/i.test(ct)) return result(ex.id, via, { ...base, reason: 'not JSON (binary body)' });
    text = Buffer.from(text, 'base64').toString('utf8');
  }
  const parsed = parseJson(text);
  if (!parsed.ok) return result(ex.id, via, { ...base, reason: 'not JSON' });

  // 3. walk
  const listOf = modelRef.list ?? Array.isArray(parsed.value);
  const u = splitUrl(ex.url);
  const out = checkValue(parsed.value, model, listOf, index.lookupNear(model.generatedFile), {
    method: ex.method.toUpperCase(),
    urlPath: u ? u.path : ex.url.replace(/[?#].*$/, ''),
  });
  const r: ContractResult = { exchangeId: ex.id, checked: true, model: model.name, via, violations: out.violations as XViolation[] };
  if (listOf) r.listOf = true;
  if (out.partial) r.reason = `checked partially: ${out.partial}`;
  return r;
}
