/**
 * File-backed mocks (CONTRACTS §12.2). Pure apart from the injected fs.
 *
 * `mock.bodyFile` is a path relative to the rule's workspace folder (shared rules: the folder of their file;
 * personal rules: the primary folder). It must stay inside the workspace after resolving symlinks (realpath on both
 * sides, `checkSourcePath`), be a regular file of at most 5 MB, and be UTF-8 text.
 */
import * as path from 'path';
import { checkSourcePath, isUncPath } from '../source/resolve';
import type { Rule } from '@flutter-intercept/proxy';

export const MAX_BODY_FILE_BYTES = 5 * 1024 * 1024;
export const MOCKS_DIR = '.vscode/flutter-intercept/mocks';

/** The file system the shared-rules service uses (node's `fs` in production, a fake in tests). */
export interface RulesFs {
  readFile(p: string): Promise<Uint8Array>;
  /** Plain write (used for the temp file of an atomic write). */
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  mkdir(p: string): Promise<void>; // recursive
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number }>;
  readdir(p: string): Promise<{ name: string; isDirectory(): boolean }[]>;
  /** Throws when `p` does not exist. */
  realpathSync(p: string): string;
}

/** A readable error about a body file, shown as a problem. */
export class BodyFileError extends Error {}

/** Checks the syntax of a `bodyFile` value (before touching the disk). */
export function bodyFileSyntaxError(rel: unknown): string | undefined {
  if (typeof rel !== 'string' || !rel.trim()) return 'must be a non-empty path';
  if (rel.length > 1024) return 'is too long';
  if (rel.includes('\0')) return 'is not a valid path';
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || isUncPath(rel)) return 'must be relative to the workspace folder (not absolute)';
  return undefined;
}

/** Absolute (not yet realpath-checked) location of `rel` in `folder`. */
export function bodyFileLocation(rel: string, folder: string): string {
  return path.resolve(folder, rel.replace(/\\/g, '/'));
}

/** What a workspace file reference is checked against (body files here, script files in scriptFile.ts). */
export interface WorkspaceFileSpec {
  /** "body file", "script file": starts every message. */
  what: string;
  maxBytes: number;
  /** "5 MB", "256 KB". */
  maxLabel: string;
  /** Extra syntax check of the value (e.g. the extension). */
  syntax?: (rel: string) => string | undefined;
  /** The error class thrown (default BodyFileError). */
  error?: new (message: string) => BodyFileError;
}

export const BODY_FILE_SPEC: WorkspaceFileSpec = { what: 'body file', maxBytes: MAX_BODY_FILE_BYTES, maxLabel: '5 MB' };

/**
 * The real path of a workspace file reference, after the safety checks: inside one of `workspaceRoots` (realpath),
 * a regular file, at most `spec.maxBytes`. Throws `spec.error` (BodyFileError) with a readable message.
 */
export async function checkWorkspaceFile(rel: string, folder: string, workspaceRoots: string[], fs: RulesFs, spec: WorkspaceFileSpec): Promise<{ real: string; size: number; mtimeMs: number }> {
  const Err = spec.error ?? BodyFileError;
  const syntax = bodyFileSyntaxError(rel) ?? spec.syntax?.(rel);
  if (syntax) throw new Err(`${spec.what} ${JSON.stringify(String(rel).slice(0, 200))} ${syntax}`);
  let real: string;
  try {
    real = checkSourcePath(bodyFileLocation(rel, folder), workspaceRoots, (p) => fs.realpathSync(p));
  } catch (e) {
    throw new Err(/not found/i.test((e as Error).message) ? `${spec.what} ${rel} not found` : `${spec.what} ${rel} must be inside the workspace`);
  }
  let st: Awaited<ReturnType<RulesFs['stat']>>;
  try {
    st = await fs.stat(real);
  } catch {
    throw new Err(`${spec.what} ${rel} not found`);
  }
  if (!st.isFile()) throw new Err(`${spec.what} ${rel} is not a regular file`);
  if (st.size > spec.maxBytes) throw new Err(`${spec.what} ${rel} is larger than ${spec.maxLabel}`);
  return { real, size: st.size, mtimeMs: st.mtimeMs };
}

/** Decodes UTF-8 (BOM dropped); throws `spec.error` (BodyFileError) for anything else. */
export function decodeWorkspaceFile(bytes: Uint8Array, rel: string, spec: WorkspaceFileSpec): string {
  const Err = spec.error ?? BodyFileError;
  if (bytes.byteLength > spec.maxBytes) throw new Err(`${spec.what} ${rel} is larger than ${spec.maxLabel}`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Err(`${spec.what} ${rel} is not UTF-8 text`);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The real path of the body file, after the safety checks: inside one of `workspaceRoots` (realpath), a regular
 * file, ≤ 5 MB. Throws BodyFileError with a readable message.
 */
export function checkBodyFile(rel: string, folder: string, workspaceRoots: string[], fs: RulesFs): Promise<{ real: string; size: number; mtimeMs: number }> {
  return checkWorkspaceFile(rel, folder, workspaceRoots, fs, BODY_FILE_SPEC);
}

/** Decodes UTF-8 (BOM dropped); throws BodyFileError for anything else. */
export function decodeBodyFile(bytes: Uint8Array, rel: string): string {
  return decodeWorkspaceFile(bytes, rel, BODY_FILE_SPEC);
}

/** A file-name stem for a rule's body (or script) file: its name, else the last path segment of its URL pattern. */
export function bodyFileStem(rule: Pick<Rule, 'name' | 'match'>, fallback = 'mock'): string {
  let base = rule.name?.trim() ?? '';
  if (!base) {
    const url = rule.match.url.replace(/^\/.*\/[a-z]*$/, '').replace(/[?#].*$/, '');
    const segs = url.split('/').filter((s) => s && !/^\*+$/.test(s) && !/^[a-z]+:$/i.test(s));
    base = segs.slice(-2).join('-');
  }
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/, '');
  return slug || fallback;
}

/** `.json` when the text is JSON (or empty), else `.txt`. */
export function bodyFileExtension(text: string): '.json' | '.txt' {
  if (!text.trim()) return '.json';
  try {
    JSON.parse(text);
    return '.json';
  } catch {
    return '.txt';
  }
}

/** The mock actions of a rule that read a body file (the mock itself, or sequence steps). */
export function bodyFileActions(rule: Rule): { bodyFile: string; body: string }[] {
  const a = rule.action;
  const out: { bodyFile: string; body: string }[] = [];
  if (a.kind === 'mock' && typeof a.bodyFile === 'string') out.push(a as { bodyFile: string; body: string });
  if (a.kind === 'sequence') {
    for (const s of a.steps ?? []) if (s.action.kind === 'mock' && typeof s.action.bodyFile === 'string') out.push(s.action as { bodyFile: string; body: string });
  }
  return out;
}
