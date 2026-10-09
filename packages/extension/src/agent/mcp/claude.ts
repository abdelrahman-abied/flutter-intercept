/**
 * "Add to Claude Code now": runs the Claude Code CLI for the user, only after an explicit click.
 * No shell (execFile with an args array; on Windows the npm `.cmd` shim needs cmd.exe, and every
 * argument is from a validated safe alphabet). Pure: the locator and the runner are injected for tests.
 *
 * Flags verified with `claude mcp add --help` / `claude mcp remove --help`:
 *   claude mcp add --transport http --scope user <name> <url> --header "<Key: value>"
 *   claude mcp remove --scope user <name>
 * (`--header` is variadic, so it goes LAST, after the positional name and URL.)
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCP_SERVER_NAME } from './connect';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (file: string, args: string[]) => Promise<RunResult>;

export const execRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    const [f, a] = isCmd ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', file, ...args]] : [file, args];
    execFile(f, a, { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code?: unknown }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) });
    });
  });

/** `claude` on PATH, then the usual install locations. */
export function findClaude(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isExecutable): string | undefined {
  const win = process.platform === 'win32';
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  dirs.push(
    path.join(home, '.claude', 'local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  );
  if (win && env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  for (const d of dirs) for (const n of names) if (exists(path.join(d, n))) return path.join(d, n);
  return undefined;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function claudeAddArgs(url: string, token: string): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('unexpected token format');
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/mcp$/.test(url)) throw new Error('unexpected MCP URL');
  return ['mcp', 'add', '--transport', 'http', '--scope', 'user', MCP_SERVER_NAME, url, '--header', `Authorization: Bearer ${token}`];
}

export const claudeRemoveArgs = (): string[] => ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME];

export interface AddResult {
  ok: boolean;
  /** An older `flutter-intercept` entry was removed first. */
  replaced: boolean;
  /** User-facing text (never contains the token). */
  message: string;
}

export async function addToClaudeCode(opts: { url: string; token: string; find?: () => string | undefined; run?: Runner }): Promise<AddResult> {
  const claude = (opts.find ?? findClaude)();
  if (!claude) {
    return { ok: false, replaced: false, message: 'Claude Code CLI (`claude`) not found on PATH. The command is on your clipboard: run it in a terminal.' };
  }
  const run = opts.run ?? execRunner;
  const args = claudeAddArgs(opts.url, opts.token);
  const scrub = (s: string) => s.split(opts.token).join('<token>').trim().slice(0, 300);

  let r = await run(claude, args);
  let replaced = false;
  if (r.code !== 0 && /already exists/i.test(`${r.stdout}\n${r.stderr}`)) {
    // Only our own name, only in the user scope we add to.
    const rm = await run(claude, claudeRemoveArgs());
    if (rm.code !== 0) {
      return { ok: false, replaced: false, message: `Could not replace the existing "${MCP_SERVER_NAME}" entry: ${scrub(rm.stderr || rm.stdout)}` };
    }
    replaced = true;
    r = await run(claude, args);
  }
  if (r.code !== 0) return { ok: false, replaced, message: `claude mcp add failed: ${scrub(r.stderr || r.stdout) || `exit code ${r.code}`}` };
  return {
    ok: true,
    replaced,
    message: replaced
      ? `Updated "${MCP_SERVER_NAME}" in Claude Code (user scope). Restart running Claude Code sessions to pick it up.`
      : `Added "${MCP_SERVER_NAME}" to Claude Code (user scope). Start a new Claude Code session to use it.`,
  };
}
