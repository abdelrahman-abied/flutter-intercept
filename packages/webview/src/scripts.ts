/**
 * v0.7.0 JavaScript scripting hooks (CONTRACTS §13.4): editor helpers for the `script` rule action. Pure.
 */
import type { Exchange, RuleAction } from './protocol';

export const SCRIPTS_DIR = '.vscode/flutter-intercept/scripts';
export const MAX_SCRIPT_BYTES = 256 * 1024;

/**
 * The inline editor's placeholder and "Start from the template". ("Create file" with an empty inline script sends empty
 * content: the host writes its own template, naming the rule.) Hooks are synchronous plain JavaScript: no require,
 * timers, fetch or import().
 */
export const SCRIPT_TEMPLATE = `// Flutter Intercept script rule. Define onRequest and/or onResponse (synchronous, plain JavaScript).
// Return an edited object, or undefined to leave it unchanged. context.log(...) writes to the exchange's script log.

function onRequest(request, context) {
  // request: { method, url, headers, body? }
  // return { ...request, headers: { ...request.headers, 'x-debug': '1' } };
  // return { response: { status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"down"}' } };
  return undefined;
}

function onResponse(response, request, context) {
  // response: { status, headers, body? }
  // context.log('status', response.status);
  return undefined;
}
`;

/** `.vscode/flutter-intercept/scripts/<slug>.js` from the rule name, else the URL's last path segment. */
export function suggestScriptFile(name: string, url: string): string {
  const fromUrl = url.replace(/[?#].*$/, '').split('/').filter((s) => s && !/[*\\^$()[\]{}|]/.test(s)).pop() ?? '';
  const slug = (name.trim() || fromUrl || 'script').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'script';
  return `${SCRIPTS_DIR}/${slug}.js`;
}

/**
 * REVIEW-7 #1: "Create file" never reuses an existing file (the host refuses). The next name to offer:
 * `auth.js` → `auth-2.js` → `auth-3.js`.
 */
export function nextScriptFile(path: string): string {
  const p = path.trim();
  const m = /^(.*?)(?:-(\d+))?\.js$/i.exec(p);
  if (!m) return `${p}-2.js`;
  const n = m[2] ? Number(m[2]) + 1 : 2;
  return `${m[1]}-${n}.js`;
}

/** Why `script.file` can't be used, if it can't. The host also realpath-checks it stays inside the workspace. */
export function scriptFileError(path: string): string | undefined {
  const p = path.trim();
  if (!p) return `Enter a workspace-relative path, e.g. ${SCRIPTS_DIR}/auth.js`;
  if (/^([\\/]|~|[A-Za-z]:)/.test(p) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return 'A workspace-relative path — not an absolute path or URL';
  if (p.split(/[\\/]/).includes('..')) return 'The file must be inside the workspace (no “..”)';
  if (!/\.js$/i.test(p)) return 'A JavaScript file ending in .js';
  return undefined;
}

/** Why an inline script can't be saved, if it can't. */
export function scriptCodeError(code: string): string | undefined {
  if (!code.trim()) return 'Write the script (onRequest and/or onResponse), or edit it in a file.';
  if (new TextEncoder().encode(code).length > MAX_SCRIPT_BYTES) return 'At most 256 KB — move it to a file and keep it smaller.';
  if (!/\bon(Request|Response)\b/.test(code)) return 'Define function onRequest(request, context) and/or onResponse(response, request, context).';
  return undefined;
}

/** Script rules never run on WebSocket upgrades (the proxy refuses them): flag a ws:// or wss:// matcher. */
export function scriptMatchError(url: string): string | undefined {
  return /^wss?:\/\//i.test(url.trim()) ? 'Script rules don\'t run on WebSocket connections — match an http(s) URL.' : undefined;
}

/** "Script: .vscode/flutter-intercept/scripts/auth.js" / "Script: inline". */
export function describeScript(a: Extract<RuleAction, { kind: 'script' }>): string {
  return `Script: ${a.file?.trim() || 'inline'}`;
}

/**
 * The script log line that is the hook's error: on a failed exchange the proxy puts the message in `scriptLog` and
 * "Script <rule>: <message>" in `error`. Returns the index of that line, or -1.
 */
export function scriptErrorLine(ex: Pick<Exchange, 'scriptLog' | 'error' | 'state'>): number {
  const log = ex.scriptLog;
  if (!log?.length || ex.state !== 'error' || !ex.error) return -1;
  const err = ex.error;
  for (let i = log.length - 1; i >= 0; i--) {
    const line = log[i].trim();
    // The proxy appends "Script <rule>: <message>" (cut at 500 characters) as the last line.
    if (line && (err === line || err.startsWith(line) || err.endsWith(line) || line.endsWith(err))) return i;
  }
  // Not found verbatim: an error the proxy reports is appended last.
  return /^script\b/i.test(err) ? log.length - 1 : -1;
}
