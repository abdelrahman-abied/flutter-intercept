/**
 * CONTRACTS §16.3: finds the app's protoc-generated Dart (`*.pbgrpc.dart`, `*.pb.dart`, `*.pbenum.dart`). Pure Node
 * (no vscode): the VS Code extension and the sidecar share it. File access goes through `GrpcFs` (tests use a fake).
 *
 * - Sources: every root (workspace folder) and, from the nearest `.dart_tool/package_config.json` at or above each
 *   root, every local package whose `packageUri` folder (usually `lib/`) contains a `*.pbgrpc.dart`. (Google's
 *   well-known types are built into the codec, src/grpc/wkt.ts.)
 * - Never follows symbolic links (files or folders), and every file read must real-resolve inside the root it was found
 *   under (no escapes through a symlinked parent). `build/`, `.dart_tool/`, `.git/`, `node_modules/` and the other
 *   tool folders are skipped (package_config.json is read directly).
 * - Caps: MAX_GRPC_FILES files, MAX_GRPC_FILE_BYTES each (larger files are skipped and reported), MAX_GRPC_TOTAL_BYTES in
 *   all, MAX_DIR_ENTRIES directory entries visited. Problems are plain words (≤ 50).
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { GrpcSourceFile } from './types';

export const MAX_GRPC_FILES = 5000;
export const MAX_GRPC_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_GRPC_TOTAL_BYTES = 50 * 1024 * 1024;
/** Directory entries looked at in one scan (all roots and packages together). */
export const MAX_DIR_ENTRIES = 300_000;
const MAX_DEPTH = 30;
const MAX_PROBLEMS = 50;

/** Folders never descended into. */
export const SKIP_DIRS = new Set(['.dart_tool', 'build', '.pub-cache', '.pub', 'node_modules', '.git', '.symlinks', '.plugin_symlinks', 'ephemeral', '.idea', '.gradle', 'Pods', '.fvm']);

/** `foo.pbgrpc.dart`, `foo.pb.dart`, `foo.pbenum.dart` (not `.pbjson.dart` / `.pbserver.dart`). */
export const GRPC_FILE = /\.(pbgrpc|pb|pbenum)\.dart$/;
const SERVICE_FILE = /\.pbgrpc\.dart$/;

export interface GrpcDirent {
  name: string;
  dir: boolean;
  file: boolean;
  symlink: boolean;
}

/** The file access discovery needs (async). */
export interface GrpcFs {
  readdir(dir: string): Promise<GrpcDirent[]>;
  lstat(p: string): Promise<{ size: number; file: boolean; dir: boolean; symlink: boolean }>;
  realpath(p: string): Promise<string>;
  readFile(p: string): Promise<string>;
}

export const nodeGrpcFs: GrpcFs = {
  async readdir(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile(), symlink: e.isSymbolicLink() }));
  },
  async lstat(p) {
    const s = await fs.promises.lstat(p);
    return { size: s.size, file: s.isFile(), dir: s.isDirectory(), symlink: s.isSymbolicLink() };
  },
  realpath: (p) => fs.promises.realpath(p),
  readFile: (p) => fs.promises.readFile(p, 'utf8'),
};

export interface DiscoveryResult {
  files: GrpcSourceFile[];
  /** Plain-words problems (caps hit, unreadable files), ≤ 50. */
  problems: string[];
  /** Folders scanned: the roots and the packages that contributed files. */
  sources: string[];
}

interface PackageDir {
  name: string;
  /** Package root (files must stay inside it). */
  root: string;
  /** Where its Dart files live (`packageUri`, usually `<root>/lib`). */
  lib: string;
}

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/** `\\host\share\…`, `//host/share/…` or a Windows device path. */
const isUnc = (p: string): boolean => /^[\\/]{2}/.test(p);

/** The nearest `.dart_tool/package_config.json` at or above `root`, if any. */
async function findPackageConfig(root: string, f: GrpcFs): Promise<string | undefined> {
  let dir = path.resolve(root);
  for (let i = 0; i < 64; i++) {
    const p = path.join(dir, '.dart_tool', 'package_config.json');
    try {
      const st = await f.lstat(p);
      if (st.file) return p;
    } catch {
      // keep looking upwards
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Local packages of a package_config.json (UNC / remote / malformed entries are skipped). */
export function parsePackageDirs(configPath: string, text: string): PackageDir[] {
  const out: PackageDir[] = [];
  let json: { packages?: { name?: unknown; rootUri?: unknown; packageUri?: unknown }[] };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    return out;
  }
  const configUrl = pathToFileURL(configPath);
  const withSlash = (u: string) => (u.endsWith('/') ? u : `${u}/`);
  for (const p of Array.isArray(json?.packages) ? json.packages : []) {
    if (typeof p?.name !== 'string' || typeof p.rootUri !== 'string') continue;
    if (/^file:\/\/(?!\/)/i.test(p.rootUri)) continue; // file://<host>/… is remote (UNC)
    try {
      const rootUrl = new URL(withSlash(p.rootUri), configUrl);
      if (rootUrl.protocol !== 'file:' || rootUrl.host !== '') continue;
      const libUrl = typeof p.packageUri === 'string' && p.packageUri ? new URL(withSlash(p.packageUri), rootUrl) : rootUrl;
      if (!libUrl.href.startsWith(rootUrl.href)) continue;
      const root = fileURLToPath(rootUrl);
      const lib = fileURLToPath(libUrl);
      if (isUnc(root)) continue;
      out.push({ name: p.name, root: path.resolve(root), lib: path.resolve(lib) });
    } catch {
      // malformed entry: skip it
    }
  }
  return out;
}

class Scan {
  readonly files: GrpcSourceFile[] = [];
  readonly problems: string[] = [];
  readonly sources: string[] = [];
  private readonly seen = new Set<string>();
  private entries = 0;
  private bytes = 0;
  private full = false;
  private warnedEntries = false;

  constructor(private readonly f: GrpcFs) {}

  problem(text: string): void {
    if (this.problems.length < MAX_PROBLEMS && !this.problems.includes(text)) this.problems.push(text);
  }

  get stopped(): boolean {
    return this.full;
  }

  /** Paths of generated files under `dir` (no symlinks, SKIP_DIRS skipped); `stopAt` = return after the first match. */
  async walk(dir: string, match: RegExp, stopAt?: number): Promise<string[]> {
    const out: string[] = [];
    const visit = async (d: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || (stopAt !== undefined && out.length >= stopAt)) return;
      let list: GrpcDirent[];
      try {
        list = await this.f.readdir(d);
      } catch {
        return;
      }
      for (const e of list) {
        if (stopAt !== undefined && out.length >= stopAt) return;
        if (++this.entries > MAX_DIR_ENTRIES) {
          if (!this.warnedEntries) this.problem(`gRPC schema: stopped looking for generated files after ${MAX_DIR_ENTRIES} folder entries`);
          this.warnedEntries = true;
          return;
        }
        if (e.symlink) continue;
        const p = path.join(d, e.name);
        if (e.dir) {
          if (!SKIP_DIRS.has(e.name)) await visit(p, depth + 1);
        } else if (e.file && match.test(e.name)) out.push(p);
      }
    };
    await visit(dir, 0);
    return out;
  }

  /** Reads one file found under `root` (real path must stay inside `realRoot`). */
  async read(file: string, realRoot: string, label: string): Promise<void> {
    if (this.full) return;
    let real: string;
    try {
      real = await this.f.realpath(file);
    } catch {
      return;
    }
    if (this.seen.has(real)) return;
    this.seen.add(real);
    if (!isInside(real, realRoot)) {
      this.problem(`gRPC schema: skipped ${label}: it resolves outside its folder`);
      return;
    }
    if (this.files.length >= MAX_GRPC_FILES) {
      this.problem(`gRPC schema: only the first ${MAX_GRPC_FILES} generated files are read`);
      this.full = true;
      return;
    }
    let st: { size: number; file: boolean; symlink: boolean };
    try {
      st = await this.f.lstat(real);
    } catch {
      return;
    }
    if (!st.file || st.symlink) return;
    if (st.size > MAX_GRPC_FILE_BYTES) {
      this.problem(`gRPC schema: skipped ${label}: larger than ${MAX_GRPC_FILE_BYTES / 1024 / 1024} MB`);
      return;
    }
    if (this.bytes + st.size > MAX_GRPC_TOTAL_BYTES) {
      this.problem(`gRPC schema: stopped reading generated files at ${MAX_GRPC_TOTAL_BYTES / 1024 / 1024} MB`);
      this.full = true;
      return;
    }
    let text: string;
    try {
      text = await this.f.readFile(real);
    } catch (e) {
      this.problem(`gRPC schema: could not read ${label}: ${(e as Error)?.message ?? String(e)}`.slice(0, 300));
      return;
    }
    if (text.length > MAX_GRPC_FILE_BYTES) return; // changed in between
    this.bytes += st.size;
    this.files.push({ path: file, text });
  }
}

async function realOrUndefined(f: GrpcFs, p: string): Promise<string | undefined> {
  try {
    return await f.realpath(p);
  } catch {
    return undefined;
  }
}

/**
 * Discovers and reads the generated gRPC / protobuf Dart files for `roots` (workspace folders). Never throws:
 * problems are returned.
 */
export async function discoverGrpcFiles(roots: readonly string[], f: GrpcFs = nodeGrpcFs): Promise<DiscoveryResult> {
  const scan = new Scan(f);
  const uniqueRoots = [...new Set(roots.filter((r) => typeof r === 'string' && r && !isUnc(r)).map((r) => path.resolve(r)))];
  const realRoots: string[] = [];
  // 1. The workspace folders themselves.
  for (const root of uniqueRoots) {
    const real = await realOrUndefined(f, root);
    if (!real) continue;
    realRoots.push(real);
    const found = await scan.walk(root, GRPC_FILE);
    if (found.length) scan.sources.push(root);
    for (const file of found) {
      await scan.read(file, real, path.relative(root, file) || path.basename(file));
      if (scan.stopped) return result(scan);
    }
  }
  // 2. Packages from package_config.json that ship services (path dependencies, hosted API packages).
  const configs = new Set<string>();
  for (const root of uniqueRoots) {
    const c = await findPackageConfig(root, f);
    if (c) configs.add(c);
  }
  const packages = new Map<string, PackageDir>();
  for (const c of configs) {
    let text: string;
    try {
      const st = await f.lstat(c);
      if (!st.file || st.size > MAX_GRPC_FILE_BYTES) continue;
      text = await f.readFile(c);
    } catch {
      continue;
    }
    for (const p of parsePackageDirs(c, text)) if (!packages.has(p.root)) packages.set(p.root, p);
  }
  for (const pkg of packages.values()) {
    if (scan.stopped) break;
    const realRoot = await realOrUndefined(f, pkg.root);
    if (!realRoot) continue;
    // Already covered by a workspace folder (the app itself, a path package inside the repo).
    if (realRoots.some((r) => isInside(realRoot, r))) continue;
    const services = await scan.walk(pkg.lib, SERVICE_FILE, 1);
    if (!services.length) continue;
    const files = await scan.walk(pkg.lib, GRPC_FILE);
    scan.sources.push(pkg.root);
    for (const file of files) {
      await scan.read(file, realRoot, `package:${pkg.name}/${path.relative(pkg.lib, file).split(path.sep).join('/')}`);
      if (scan.stopped) break;
    }
  }
  return result(scan);
}

function result(scan: Scan): DiscoveryResult {
  return { files: scan.files, problems: scan.problems, sources: scan.sources };
}

/** Whether a changed path can affect the schema (a generated file or a package_config.json). */
export function isGrpcSchemaPath(p: string): boolean {
  const base = path.basename(p);
  return GRPC_FILE.test(base) || (base === 'package_config.json' && path.basename(path.dirname(p)) === '.dart_tool');
}
