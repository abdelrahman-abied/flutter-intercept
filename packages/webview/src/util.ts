import type { Body, Exchange } from './protocol';
import type { StackFrame } from '@flutter-intercept/proxy/types';
import { FRAMEWORK_PACKAGES } from '@flutter-intercept/proxy/source';

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'error';
export const STATUS_CLASSES: StatusClass[] = ['2xx', '3xx', '4xx', '5xx', 'error'];

export type Headers = Record<string, string | string[]>;

// ---------------------------------------------------------------- formatting

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** m:ss for countdowns ("4:32"); never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

export interface PauseClock { label: string; title: string; urgent: boolean }

/**
 * Countdown for a paused exchange: the proxy auto-resumes it unedited at `pauseDeadline`.
 * Falls back to time-since-pause when only `pausedAt` is known. undefined when not paused.
 */
export function pauseClock(ex: Pick<Exchange, 'state' | 'pausedAt' | 'pauseDeadline'>, now: number): PauseClock | undefined {
  if (!isPaused(ex)) return undefined;
  if (ex.pauseDeadline !== undefined) {
    const left = ex.pauseDeadline - now;
    return left > 0
      ? { label: formatCountdown(left), title: `Auto-resumes unedited in ${formatCountdown(left)} (at ${formatTime(ex.pauseDeadline).slice(0, 8)})`, urgent: left <= 30_000 }
      : { label: '0:00', title: 'Auto-resuming unedited…', urgent: true };
  }
  if (ex.pausedAt !== undefined) {
    const t = formatCountdown(now - ex.pausedAt);
    return { label: t, title: `Paused for ${t}`, urgent: false };
  }
  return undefined;
}

/** Time left, coarse: "42s", "4m 10s", "1h 5m" (never negative). */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "3s ago", "2m ago", "1h ago" (never negative). */
export function formatAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export interface AgentLine { text: string; title: string; kind: 'off' | 'idle' | 'connected' }

/** Status-line text for Status.agent. Never includes a token (the status has none). */
export function agentLine(a: { access: string; mcpUrl?: string; clients: number; lastCall?: { tool: string; at: number } }, now: number): AgentLine {
  const accessText = a.access === 'readOnly' ? 'read-only' : a.access === 'off' ? 'off' : 'read & write';
  if (a.access === 'off') {
    return { text: 'Agent access: off', title: 'AI agents cannot use Flutter Intercept (setting flutterIntercept.agent.access).', kind: 'off' };
  }
  const connected = a.clients > 0;
  const head = `Agent${a.access === 'readOnly' ? ' (read-only)' : ''}: ${connected ? 'connected' : 'idle'}`;
  const last = a.lastCall ? ` · last: ${a.lastCall.tool} ${formatAgo(a.lastCall.at, now)}` : '';
  const title = [
    `AI agent access: ${accessText}.`,
    `${a.clients} MCP client${a.clients === 1 ? '' : 's'} connected.`,
    a.mcpUrl ? `MCP server: ${a.mcpUrl}` : '',
    a.lastCall ? `Last tool call: ${a.lastCall.tool} at ${formatTime(a.lastCall.at).slice(0, 8)}.` : 'No tool calls yet.',
  ].filter(Boolean).join('\n');
  return { text: head + last, title, kind: connected ? 'connected' : 'idle' };
}

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (x: number, w = 2) => String(x).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ---------------------------------------------------------------- URL

export interface UrlParts { host: string; path: string }
const urlCache = new Map<string, UrlParts>();

/** host + path(+query) of an absolute URL; cached because the list re-renders often. */
export function splitUrl(url: string): UrlParts {
  let parts = urlCache.get(url);
  if (parts) return parts;
  try {
    const u = new URL(url);
    parts = { host: u.host, path: u.pathname + u.search };
  } catch {
    parts = { host: '', path: url };
  }
  if (urlCache.size > 5000) urlCache.clear();
  urlCache.set(url, parts);
  return parts;
}

export function isAbsoluteUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- status

export function statusClassOf(ex: Pick<Exchange, 'state' | 'status'>): StatusClass | undefined {
  if (ex.state === 'error' || ex.state === 'aborted') return 'error';
  if (ex.status !== undefined) {
    const c = Math.floor(ex.status / 100);
    if (c >= 2 && c <= 5) return `${c}xx` as StatusClass;
    return undefined;
  }
  if (ex.state === 'blocked') return 'error'; // connection reset, no status
  return undefined;
}

export function isPaused(ex: Pick<Exchange, 'state'>): boolean {
  return ex.state === 'paused-request' || ex.state === 'paused-response';
}

// ---------------------------------------------------------------- headers

export function headerValue(headers: Headers | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v.join(', ') : v;
    }
  }
  return undefined;
}

export function isJsonContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const mime = ct.split(';')[0].trim().toLowerCase();
  return mime === 'application/json' || mime.endsWith('+json') || mime === 'text/json';
}

// ---------------------------------------------------------------- bodies

export function base64ByteLength(b64: string): number {
  const s = b64.replace(/[\s]/g, '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const sizeCache = new WeakMap<Body, number>();
export function bodyByteLength(body: Body | undefined): number | undefined {
  if (!body) return undefined;
  let n = sizeCache.get(body);
  if (n === undefined) {
    n = body.encoding === 'base64' ? base64ByteLength(body.text) : utf8ByteLength(body.text);
    sizeCache.set(body, n);
  }
  return n;
}

// ---------------------------------------------------------------- matchers
// Matching itself comes from '@flutter-intercept/proxy/rules' (the proxy's own code).
// This only explains a pattern to the user; it never decides what matches.

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/s;

export type MatcherUrlInfo =
  | { kind: 'any' }
  | { kind: 'glob' }
  | { kind: 'regex'; source: string; flags: string; error?: string };

export function describeMatcherUrl(url: string): MatcherUrlInfo {
  const p = url.trim();
  if (p === '' || p === '*') return { kind: 'any' };
  const m = REGEX_LITERAL.exec(p);
  if (!m) return { kind: 'glob' };
  try {
    new RegExp(m[1], m[2]);
    return { kind: 'regex', source: m[1], flags: m[2] };
  } catch (e) {
    return { kind: 'regex', source: m[1], flags: m[2], error: (e as Error).message };
  }
}

// ---------------------------------------------------------------- source frames (CONTRACTS §9.2)

/** Package name of a `package:name/…` uri. */
export function packageOf(uri: string): string | undefined {
  const m = /^package:([^/]+)\//.exec(uri);
  return m ? m[1] : undefined;
}

/** SDK, HTTP-stack / Flutter packages and the generated Flutter Intercept entry: shown dimmed. */
export function isFrameworkFrame(f: Pick<StackFrame, 'uri'>): boolean {
  if (f.uri.startsWith('dart:')) return true;
  if (f.uri.includes('.dart_tool/flutter_intercept/')) return true;
  const pkg = packageOf(f.uri);
  return !!pkg && FRAMEWORK_PACKAGES.includes(pkg);
}

/** Short location for a frame: last two path segments + line, e.g. "api/client.dart:42". */
export function shortFrameLocation(f: Pick<StackFrame, 'uri' | 'line'>): string {
  let path = f.uri;
  if (!path.startsWith('dart:')) {
    path = path.replace(/^package:[^/]+\//, '').replace(/^file:\/\/\/?/, '/');
    const segs = path.split('/').filter(Boolean);
    path = segs.slice(-2).join('/');
  }
  return f.line !== undefined ? `${path}:${f.line}` : path;
}

/** Full location for tooltips: "package:app/api.dart:42:7". */
export function fullFrameLocation(f: Pick<StackFrame, 'uri' | 'line' | 'column'>): string {
  return `${f.uri}${f.line !== undefined ? `:${f.line}` : ''}${f.line !== undefined && f.column !== undefined ? `:${f.column}` : ''}`;
}

// ---------------------------------------------------------------- JSON
// Lossless implementation lives in ./json (never JSON.parse/stringify on bodies).
export { lineCol, validateJson, type JsonCheck } from './json';

export function newId(prefix = 'r'): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return `${prefix}_${c.randomUUID().slice(0, 8)}`;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
