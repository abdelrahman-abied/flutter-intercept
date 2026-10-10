/**
 * Shared rules for a headless run (CONTRACTS §12.1, §13.4, §13.9): the editor's own SharedRulesCore (same parsing,
 * validation, body / script file checks and approval reasons), with an in-memory approval store. Rules that need
 * approval are skipped with their reason unless `approve` is set; nothing is ever written.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Rule } from '@flutter-intercept/proxy';
import { SharedRulesCore, type MementoLike } from '../../extension/src/rules/core';
import type { RulesFs } from '../../extension/src/rules/bodyFile';
import { SHARED_FILE } from '../../extension/src/rules/file';
import { ruleLabel } from '../../extension/src/rules/policy';
import { validateRule } from '../../extension/src/ui/controller';

export interface LoadedRules {
  /** Absolute path of the file used, or undefined when there is none. */
  file?: string;
  /** Rules to apply (bodies and scripts resolved), in file order. */
  rules: Rule[];
  /** One line per rule left out because it needs approval (without --approve-shared-rules). */
  skipped: string[];
  /** Rules that were applied only because of --approve-shared-rules (their reasons). */
  approved: string[];
  /** Problems: parse errors, invalid rules, unreadable body / script files. */
  problems: string[];
}

/** Read-only node fs for SharedRulesCore (the editor's `nodeRulesFs` lives in a vscode module). A run never writes. */
export const readOnlyRulesFs: RulesFs = {
  readFile: (p) => fs.promises.readFile(p),
  writeFile: () => Promise.reject(new Error('read-only')),
  rename: () => Promise.reject(new Error('read-only')),
  unlink: () => Promise.reject(new Error('read-only')),
  mkdir: () => Promise.reject(new Error('read-only')),
  stat: (p) => fs.promises.stat(p),
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  realpathSync: (p) => fs.realpathSync.native(p),
};

class MemoryMemento implements MementoLike {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

/** The root of the git work tree containing `dir` (a folder with `.git`), or undefined. */
export function findGitRoot(dir: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  let cur = path.resolve(dir);
  for (;;) {
    if (exists(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * The default rules file (REVIEW-7 #12): `.vscode/flutter-intercept.json` in the project root, or — inside a git work
 * tree — in the nearest folder between the project and the work tree root (a repository whose Flutter app is in a
 * subfolder). Never above the work tree, and outside one only the project's own file.
 */
export function findDefaultRulesFile(projectRoot: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const start = path.resolve(projectRoot);
  const top = findGitRoot(start, exists) ?? start;
  for (let dir = start; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, SHARED_FILE);
    if (exists(candidate)) return candidate;
    if (dir === top || path.dirname(dir) === dir) return undefined;
  }
}

export interface StatLike {
  mode: number;
  uid: number;
}

/**
 * Why the rules file must not be trusted (REVIEW-7 #12), or undefined: it or a folder between it and `folder` is
 * writable by every user, or (when we are not root) owned by another user than us or root. POSIX only.
 */
export function unsafeRulesLocation(
  file: string,
  folder: string,
  stat: (p: string) => StatLike = (p) => fs.statSync(p),
  uid: number | undefined = process.getuid?.(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32' || uid === undefined) return undefined;
  const top = path.resolve(folder);
  const chain = [path.resolve(file)];
  for (let dir = path.dirname(chain[0]); ; dir = path.dirname(dir)) {
    chain.push(dir);
    if (dir === top || path.dirname(dir) === dir) break;
  }
  for (const p of chain) {
    let st: StatLike;
    try {
      st = stat(p);
    } catch {
      continue;
    }
    if (st.mode & 0o002) return `${p} is writable by every user`;
    if (uid !== 0 && st.uid !== uid && st.uid !== 0) return `${p} is owned by another user`;
  }
  return undefined;
}

/** The folder a custom rules file and its body / script files must be in: the git repository root, else the project. */
export function workspaceRootFor(projectRoot: string, exists: (p: string) => boolean = fs.existsSync): string {
  return findGitRoot(projectRoot, exists) ?? path.resolve(projectRoot);
}

/**
 * Where SharedRulesCore should look: the workspace folder whose `.vscode/flutter-intercept.json` is `file`, or — for
 * a file elsewhere — `fallbackFolder` with the canonical path redirected to `file` (body and script files then
 * resolve against `fallbackFolder`, and `file` must be inside it).
 */
export function rulesLocation(file: string, fallbackFolder: string): { folder: string; redirect?: { from: string; to: string } } {
  const abs = path.resolve(file);
  const canonicalTail = path.join(...SHARED_FILE.split('/'));
  if (abs.endsWith(path.sep + canonicalTail)) return { folder: abs.slice(0, abs.length - canonicalTail.length - 1) };
  const folder = path.resolve(fallbackFolder);
  return { folder, redirect: { from: path.join(folder, canonicalTail), to: abs } };
}

function redirectFs(base: RulesFs, from: string, to: string): RulesFs {
  const map = (p: string) => (path.resolve(p) === from ? to : p);
  return {
    ...base,
    readFile: (p) => base.readFile(map(p)),
    stat: (p) => base.stat(map(p)),
    realpathSync: (p) => base.realpathSync(map(p)),
  };
}

export interface LoadRulesOptions {
  /** `--rules` value (path), `false` for `--no-rules`, undefined for the default file. */
  rules?: string | false;
  approve: boolean;
  projectRoot: string;
  cwd: string;
  fs?: RulesFs;
  log?(msg: string): void;
  /** For tests: the stat used by the ownership / permission check. */
  stat?: (p: string) => StatLike;
}

export async function loadRules(o: LoadRulesOptions): Promise<LoadedRules> {
  if (o.rules === false) return { rules: [], skipped: [], approved: [], problems: [] };
  const file = o.rules !== undefined ? path.resolve(o.cwd, o.rules) : findDefaultRulesFile(o.projectRoot);
  if (!file) return { rules: [], skipped: [], approved: [], problems: [] };
  if (o.rules !== undefined && !fs.existsSync(file)) throw new Error(`rules file ${o.rules} not found`);
  const loc = rulesLocation(file, workspaceRootFor(o.projectRoot));
  const unsafe = unsafeRulesLocation(file, loc.folder, o.stat);
  if (unsafe) throw new Error(`refusing the rules file ${file}: ${unsafe} (another user could change the rules)`);
  const baseFs = o.fs ?? readOnlyRulesFs;
  const core = new SharedRulesCore({
    folders: () => [{ name: path.basename(loc.folder), path: loc.folder }],
    fs: loc.redirect ? redirectFs(baseFs, loc.redirect.from, loc.redirect.to) : baseFs,
    validateRule,
    memento: new MemoryMemento(),
    ...(o.log ? { log: o.log } : {}),
  });
  await core.reload();
  const before = core.state();
  const reasons = core.pendingReasons();
  const skipped: string[] = [];
  const approved: string[] = [];
  if (before.pendingApproval.length) {
    if (o.approve) {
      await core.approvePending();
      approved.push(...reasons);
    } else skipped.push(...reasons);
  }
  const state = core.state();
  const resolved = await core.resolveBodies(state.rules);
  // Nobody can resume a paused request in a headless run: breakpoints would only hold requests until they time out.
  const rules = resolved.rules.filter((r) => r.action.kind !== 'breakpoint');
  const breakpoints = resolved.rules.filter((r) => r.action.kind === 'breakpoint').map((r) => `Rule ${ruleLabel(r)} is off: breakpoints need the editor`);
  return { file, rules, skipped, approved, problems: [...state.problems, ...resolved.problems, ...breakpoints] };
}
