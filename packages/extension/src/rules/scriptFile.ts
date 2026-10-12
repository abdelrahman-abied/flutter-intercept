/**
 * Script files (CONTRACTS §13.4). Pure apart from the injected fs.
 *
 * `script.file` is a path relative to the rule's workspace folder (shared rules: the folder of their file; personal
 * rules: the primary folder), like `mock.bodyFile` (bodyFile.ts): a `.js` file that stays inside the workspace after
 * resolving symlinks, a regular file of at most 256 KB, UTF-8 text. The host reads it into `code` before handing the
 * rules to the proxy; a file that can't be used skips the rule with a problem (never runs it with empty code).
 *
 * The editor's "Edit script in a file" creates `.vscode/flutter-intercept/scripts/<name>.js` from `scriptTemplate`.
 */
import type { Rule } from '@flutter-intercept/proxy';
import { scriptTemplate as metaScriptTemplate } from '@flutter-intercept/proxy/grpc-meta';
import { BodyFileError, bodyFileStem, bodyFileSyntaxError, checkWorkspaceFile, decodeWorkspaceFile, RulesFs, WorkspaceFileSpec } from './bodyFile';
import { cleanText } from './policy';

export const MAX_SCRIPT_FILE_BYTES = 256 * 1024;
export const SCRIPTS_DIR = '.vscode/flutter-intercept/scripts';

/** A readable error about a script file, shown as a problem (also a BodyFileError). */
export class ScriptFileError extends BodyFileError {}

export const SCRIPT_FILE_SPEC: WorkspaceFileSpec = {
  what: 'script file',
  maxBytes: MAX_SCRIPT_FILE_BYTES,
  maxLabel: '256 KB',
  syntax: (rel) => (/\.js$/i.test(rel) ? undefined : 'must be a .js file'),
  error: ScriptFileError,
};

/** Checks the syntax of a `script.file` value (before touching the disk): a relative path ending in `.js`. */
export function scriptFileSyntaxError(rel: unknown): string | undefined {
  return bodyFileSyntaxError(rel) ?? SCRIPT_FILE_SPEC.syntax!(rel as string);
}

/** The real path of the script file after the safety checks (see the header). Throws ScriptFileError. */
export function checkScriptFile(rel: string, folder: string, workspaceRoots: string[], fs: RulesFs): Promise<{ real: string; size: number; mtimeMs: number }> {
  return checkWorkspaceFile(rel, folder, workspaceRoots, fs, SCRIPT_FILE_SPEC);
}

/** Decodes UTF-8 (BOM dropped); throws ScriptFileError for anything else. */
export function decodeScriptFile(bytes: Uint8Array, rel: string): string {
  return decodeWorkspaceFile(bytes, rel, SCRIPT_FILE_SPEC);
}

/** The script action of a rule that reads a file (scripts can't be sequence steps). */
export function scriptFileActions(rule: Rule): { file: string; code: string }[] {
  const a = rule.action;
  return a.kind === 'script' && typeof a.file === 'string' ? [a as { file: string; code: string }] : [];
}

/** The `script.file` path of a rule, if any. */
export function scriptFileOf(rule: Rule): string | undefined {
  return scriptFileActions(rule)[0]?.file;
}

/** A file-name stem for a rule's script file: its name, else the last path segment of its URL pattern. */
export function scriptFileStem(rule: Pick<Rule, 'name' | 'match'>): string {
  return bodyFileStem(rule, 'script');
}

/**
 * Default workspace-relative path for "Edit script in a file": `.vscode/flutter-intercept/scripts/<slug>.js`. The
 * host's `createScriptFile` picks `<slug>-2.js` … when the name is taken.
 */
export function defaultScriptFilePath(rule: Pick<Rule, 'name' | 'match'>): string {
  return `${SCRIPTS_DIR}/${scriptFileStem(rule)}.js`;
}

/**
 * Starter content for a new script file: grpc-meta's `scriptTemplate` (every hook documented, changing nothing until
 * edited; gRPC hooks commented out, CONTRACTS §13.4 / §18.2). `rule` (optional) names the rule in the first comment line.
 */
export function scriptTemplate(rule?: Pick<Rule, 'name'>): string {
  return metaScriptTemplate(typeof rule?.name === 'string' ? cleanText(rule.name, 80) : undefined);
}
