/**
 * Request → source (CONTRACTS §9.4): turns parsed Dart stack frames into files on disk. Pure (no `vscode`
 * import): unit-tested with a fake fs.
 *
 * - `package:<name>/<path>` → `<rootUri>/<packageUri>/<path>` from the nearest
 *   `.dart_tool/package_config.json` at or above each project root (pub workspaces keep a single config
 *   at the workspace root), cached by mtime. `rootUri` is relative to the config file.
 * - `file://` URIs → their path; never for `file://<host>/…` (UNC/remote) URIs.
 * - anything else (`dart:`, `org-dartlang-sdk:`, …) → no path.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { StackFrame } from '@flutter-intercept/proxy';

export interface ResolvedFrame extends StackFrame {
  /** Absolute file path, when the frame's URI maps to a file. */
  path?: string;
  /** The file is inside one of the project roots (not the pub cache, the SDK or the generated entry). */
  inProject: boolean;
}

export interface SourceFs {
  statSync(p: string): { mtimeMs: number };
  readFileSync(p: string, enc: 'utf8'): string;
}

const realFs: SourceFs = fs;

interface PackageEntry {
  /** Directory URL of the package's `packageUri` (always ends with `/`). */
  libUrl: URL;
  /** Directory URL of the package root (always ends with `/`); package paths may not escape it. */
  rootUrl: URL;
}

interface CachedConfig {
  mtimeMs: number;
  packages: Map<string, PackageEntry>;
}

const configCache = new Map<string, CachedConfig>();

/** Test hook: forget cached package configs. */
export function clearPackageConfigCache(): void {
  configCache.clear();
}

const withSlash = (u: string) => (u.endsWith('/') ? u : `${u}/`);

function parsePackageConfig(configPath: string, text: string): Map<string, PackageEntry> {
  const out = new Map<string, PackageEntry>();
  const json = JSON.parse(text) as { packages?: { name?: unknown; rootUri?: unknown; packageUri?: unknown }[] };
  const configUrl = pathToFileURL(configPath);
  for (const p of Array.isArray(json.packages) ? json.packages : []) {
    if (typeof p?.name !== 'string' || typeof p.rootUri !== 'string') continue;
    if (/^file:\/\/(?!\/)/i.test(p.rootUri)) continue; // file://<host>/… is remote (UNC), never a package root
    try {
      const rootUrl = new URL(withSlash(p.rootUri), configUrl);
      const libUrl = typeof p.packageUri === 'string' && p.packageUri ? new URL(withSlash(p.packageUri), rootUrl) : rootUrl;
      if (rootUrl.protocol !== 'file:' || rootUrl.host !== '') continue;
      out.set(p.name, { rootUrl, libUrl });
    } catch {
      // malformed entry: skip it
    }
  }
  return out;
}

/** Packages of the nearest `.dart_tool/package_config.json` at or above `root` (undefined if none). */
function packagesFor(root: string, f: SourceFs): Map<string, PackageEntry> | undefined {
  let dir = path.resolve(root);
  for (;;) {
    const configPath = path.join(dir, '.dart_tool', 'package_config.json');
    let mtimeMs: number | undefined;
    try {
      mtimeMs = f.statSync(configPath).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    if (mtimeMs !== undefined) {
      const cached = configCache.get(configPath);
      if (cached && cached.mtimeMs === mtimeMs) return cached.packages;
      try {
        const packages = parsePackageConfig(configPath, f.readFileSync(configPath, 'utf8'));
        configCache.set(configPath, { mtimeMs, packages });
        return packages;
      } catch {
        configCache.delete(configPath);
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolvePackageUri(uri: string, roots: string[], f: SourceFs): string | undefined {
  const m = /^package:([^/]+)\/(.+)$/.exec(uri);
  if (!m) return undefined;
  const [, name, rest] = m;
  for (const root of roots) {
    const entry = packagesFor(root, f)?.get(name);
    if (!entry) continue;
    try {
      const file = new URL(rest, entry.libUrl);
      // `package:x/../../etc` must stay inside the package.
      if (!file.href.startsWith(entry.rootUrl.href)) return undefined;
      return fileURLToPath(file);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function filePath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try {
    // `file://host/share/…` is a UNC/remote path: never a local source file. Checked on the raw text:
    // WHATWG URL parsing drops `localhost` and would hide the authority.
    if (!/^file:\/\/\//i.test(uri) && /^file:\/\//i.test(uri)) return undefined;
    const url = new URL(uri);
    if (url.host !== '') return undefined;
    const p = fileURLToPath(url);
    return isUncPath(p) ? undefined : p;
  } catch {
    return undefined;
  }
}

/** `\\host\share\…`, `//host/share/…` or a Windows device path (`\\?\…`, `\\.\…`). */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Inside a project root, but not in a generated/tool directory of it (`.dart_tool`, `build`). */
function isProjectFile(p: string, roots: string[]): boolean {
  return roots.some((root) => {
    if (!within(p, root)) return false;
    const first = path.relative(root, p).split(/[\\/]/)[0];
    return first !== '.dart_tool' && first !== 'build';
  });
}

/**
 * Maps each frame to a file. `projectRoots` are the Flutter/Dart project roots (pubspec directories)
 * of the session, most specific first; their package configs resolve `package:` URIs.
 */
export function resolveFrames(frames: StackFrame[], projectRoots: string[], f: SourceFs = realFs): ResolvedFrame[] {
  const roots = projectRoots.map((r) => path.resolve(r));
  return frames.map((frame) => {
    const p = frame.uri.startsWith('package:') ? resolvePackageUri(frame.uri, roots, f) : filePath(frame.uri);
    return p ? { ...frame, path: p, inProject: isProjectFile(p, roots) } : { ...frame, inProject: false };
  });
}

/**
 * `p` relative to the deepest root containing it, with `/` separators (`lib/api/orders.dart`);
 * undefined when it is in no root (never leaks an absolute path).
 */
export function projectRelative(p: string, roots: string[]): string | undefined {
  const abs = path.resolve(p);
  let best: string | undefined;
  for (const root of roots.map((r) => path.resolve(r))) {
    if (within(abs, root) && (!best || root.length > best.length)) best = root;
  }
  if (best === undefined) return undefined;
  return path.relative(best, abs).split(path.sep).join('/');
}

/**
 * Root directories of every package in the package configs of `projectRoots` (pub-cache, path and git
 * dependencies, the app itself). With the workspace folders, these are the only places "Open source" may
 * open a file from (REVIEW-3 #3).
 */
export function packageRootsFor(projectRoots: string[], f: SourceFs = realFs): string[] {
  const out = new Set<string>();
  for (const root of projectRoots) {
    for (const entry of packagesFor(path.resolve(root), f)?.values() ?? []) {
      try {
        const p = fileURLToPath(entry.rootUrl);
        if (!isUncPath(p)) out.add(path.resolve(p));
      } catch {
        // not a local path
      }
    }
  }
  return [...out];
}

/**
 * The real path of `p` if it is a local file inside one of `allowedRoots` (both sides resolved through
 * symlinks), else throws a readable Error. Stack frames come from the app, so a frame may name any file.
 */
export function checkSourcePath(p: string, allowedRoots: string[], realpath: (p: string) => string = fs.realpathSync.native): string {
  const name = path.basename(p);
  if (isUncPath(p) || !path.isAbsolute(p)) throw new Error(`This frame points outside the workspace: ${name}`);
  let real: string;
  try {
    real = realpath(p);
  } catch {
    throw new Error(`Source file not found: ${name}`);
  }
  if (isUncPath(real)) throw new Error(`This frame points outside the workspace: ${name}`);
  const roots: string[] = [];
  for (const r of allowedRoots) {
    try {
      roots.push(realpath(r));
    } catch {
      // a root that does not exist allows nothing
    }
  }
  if (!roots.some((r) => !isUncPath(r) && within(real, r))) throw new Error(`This frame points outside the workspace: ${name}`);
  return real;
}
