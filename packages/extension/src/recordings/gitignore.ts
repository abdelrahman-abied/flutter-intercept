/**
 * "Would git track this path?" without running git (REVIEW-6 #9). Reads the `.gitignore` files from the repository
 * root (the nearest ancestor with a `.git` entry) down to the path's directory, plus `.git/info/exclude`, and applies
 * git's rules: the last matching pattern wins, deeper files override shallower ones, `!` re-includes, and nothing
 * below an excluded directory can be re-included. Global excludes (`core.excludesFile`) are not read, so the answer
 * errs on "not ignored". Pure apart from the injected reads.
 */
import * as path from 'path';

export interface GitignoreFs {
  /** Kind of the entry at `p` (not following a final symlink), or undefined when missing. */
  kind(p: string): Promise<'file' | 'dir' | 'symlink' | 'other' | undefined>;
  readFile(p: string): Promise<string>;
}

export type GitStatus = 'ignored' | 'not-ignored' | 'no-repo';

const MAX_LEVELS = 64;
const MAX_IGNORE_FILE_CHARS = 1024 * 1024;

interface Pattern {
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean; // contains a slash: matched against the path relative to the file's directory
  re: RegExp;
}

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` = any number of directories, a trailing `**` = everything inside
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) re += '\\[';
      else {
        let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      re += glob[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i++;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function parseGitignore(text: string): Pattern[] {
  const out: Pattern[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    out.push({ negate, dirOnly, anchored, re: globToRegex(line) });
  }
  return out;
}

/** Last matching pattern's verdict for `rel` (relative to the ignore file's directory), or undefined. */
function verdict(patterns: Pattern[], rel: string, isDir: boolean): boolean | undefined {
  let v: boolean | undefined;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  for (const p of patterns) {
    if (p.dirOnly && !isDir) continue;
    if (p.anchored ? p.re.test(rel) : p.re.test(base)) v = !p.negate;
  }
  return v;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/**
 * Whether git would ignore the file `target` (absolute, real path; it need not exist). `no-repo` when no ancestor
 * has a `.git` entry.
 */
export async function gitIgnoreStatus(target: string, fs: GitignoreFs): Promise<GitStatus> {
  // the repository root: nearest ancestor of the target's directory with `.git`
  let repo: string | undefined;
  let dir = path.dirname(target);
  for (let i = 0; i < MAX_LEVELS; i++) {
    if (await fs.kind(path.join(dir, '.git'))) {
      repo = dir;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (!repo) return 'no-repo';
  const rel = toPosix(path.relative(repo, target));
  if (!rel || rel.startsWith('..')) return 'no-repo';
  const parts = rel.split('/');

  const read = async (file: string): Promise<Pattern[]> => {
    if ((await fs.kind(file)) !== 'file') return []; // symlinked ignore files are not followed by git either
    try {
      const text = await fs.readFile(file);
      return text.length > MAX_IGNORE_FILE_CHARS ? [] : parseGitignore(text);
    } catch {
      return [];
    }
  };
  // ignore files by directory depth: -1 = .git/info/exclude (lowest precedence, relative to the repo root)
  const exclude = await read(path.join(repo, '.git', 'info', 'exclude'));
  const files: Pattern[][] = [];
  for (let d = 0; d < parts.length; d++) files.push(await read(path.join(repo, ...parts.slice(0, d), '.gitignore')));

  // Each ancestor directory, then the file: excluded as soon as one of them is (no re-including below it).
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join('/');
    const isDir = i < parts.length;
    let v = verdict(exclude, candidate, isDir);
    for (let d = 0; d < i; d++) {
      const relToFile = parts.slice(d, i).join('/');
      const fv = verdict(files[d], relToFile, isDir);
      if (fv !== undefined) v = fv;
    }
    if (v === true) return 'ignored';
  }
  return 'not-ignored';
}
