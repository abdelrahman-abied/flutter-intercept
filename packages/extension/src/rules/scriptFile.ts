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
 * Starter content for a new script file: both hooks, `context.log`, adding a request header and editing a JSON
 * response. `rule` (optional) names the rule in the first comment line.
 */
export function scriptTemplate(rule?: Pick<Rule, 'name'>): string {
  const name = typeof rule?.name === 'string' ? cleanText(rule.name, 80).replace(/\*\//g, '* /') : '';
  return `// Flutter Intercept script${name ? ` for the rule "${name}"` : ''}.
// Runs in the proxy for every request the rule matches. Both hooks are optional and must return synchronously;
// return undefined to leave things as they are. Plain JavaScript only: no require, fetch, timers or Node APIs.
// context.log(...) lines show up in the request's details. A hook that throws answers the app with 502.

/**
 * Before the request goes to the server.
 * request: { method, url, headers, body? } — body is text; absent (bodyOmitted: true) when binary or over 1 MB.
 * Return the edited request, { response: { status, headers, body } } to answer locally, or undefined.
 */
function onRequest(request, context) {
  request.headers['x-debug'] = 'flutter-intercept';
  context.log('request', request.method, request.url);
  return request;
}

/**
 * With the server's response.
 * response: { status, headers, body? }
 * Return the edited response, or undefined.
 */
function onResponse(response, request, context) {
  if (response.body === undefined) return undefined;
  let json;
  try {
    json = JSON.parse(response.body);
  } catch {
    return undefined; // not JSON: leave it as it is
  }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    json.editedBy = 'flutter-intercept';
  }
  context.log('edited the JSON response of', request.url, '- status', response.status);
  return { ...response, body: JSON.stringify(json) };
}
`;
}
