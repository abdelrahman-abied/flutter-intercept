/**
 * Error-notification policy (CONTRACTS §13.6). Pure: no vscode, no timers (the caller passes `now`).
 *
 * - Counted: the app's own traffic only. Not editor / agent sends, browser-internal requests, answers the user
 *   arranged (mocked, blocked, replayed or scripted local answers — all end `mocked` / `blocked`), simulated
 *   faults (fault rules, throttle drops, offline profile, "not in the recording"), or a status a rewrite rule set.
 * - A failure: state `error`, or status ≥ 500; level "all" adds 4xx.
 * - Each exchange is looked at once, when it first reaches a final state (later updates are ignored).
 * - While the panel is visible nothing is shown or queued (the user can see the traffic).
 * - At most one notice per window (default 10 s): failures inside it are grouped into the next notice, which
 *   `flush` returns once the window has passed.
 * - The text names the method and the URL PATH only (no host, no query string — it may hold secrets; path
 *   segments that look like credentials are redacted).
 * - REVIEW-7 #2: VS Code renders `[label](command:…|file:…|https:…)` in notification text, and paths, GraphQL
 *   operation names and error texts come from the app / server. Link syntax never survives: in paths `[ ] ( ) \ \``
 *   are percent-encoded; in other untrusted text they become look-alikes (`［ ］ （ ） ⧵ ˋ`). Only our own `[redacted]`
 *   marks keep brackets, and nothing after them can open a `(`.
 */
import type { Exchange } from '@flutter-intercept/proxy';
import { STATUS_CODES } from 'http';
import { redactSecretValues, redactText } from '../agent/redact';
import type { Notice, NotifyLevel, NotifyPolicy, NotifyPolicyOptions } from './types';

export const DEFAULT_WINDOW_MS = 10_000;
/** Ids remembered so an exchange counts once; the oldest are forgotten past this. */
const SEEN_CAP = 10_000;
const FINAL = new Set(['completed', 'mocked', 'blocked', 'aborted', 'error']);
const MAX_ERROR_CHARS = 120;
/** The proxy's `simulated` labels for failures it caused itself (fault rules, drops, offline, replay "fail"). */
const SIMULATED_FAILURE = /\bFault:|\bDropped\b|: dropped\b|^Offline\b|· Offline\b|Not in the recording/;

const PATH_ESCAPES: Record<string, string> = { '[': '%5B', ']': '%5D', '(': '%28', ')': '%29', '\\': '%5C', '`': '%60' };
const TEXT_ESCAPES: Record<string, string> = { '[': '［', ']': '］', '(': '（', ')': '）', '\\': '⧵', '`': 'ˋ' };
const MARKDOWN_CHARS = /[[\]()\\`]/g;

/** A URL path with Markdown link characters percent-encoded (REVIEW-7 #2). */
export function neutralizePath(path: string): string {
  return path.replace(MARKDOWN_CHARS, (c) => PATH_ESCAPES[c]);
}

/** Untrusted text with Markdown link characters replaced by look-alikes (REVIEW-7 #2). */
export function neutralizeText(text: string): string {
  return text.replace(MARKDOWN_CHARS, (c) => TEXT_ESCAPES[c]);
}

/** `flutterIntercept.notifications` as read from settings; anything unknown means the default. */
export function normalizeLevel(v: unknown): NotifyLevel {
  return v === 'off' || v === 'all' || v === 'errors' ? v : 'errors';
}

/** The user asked for this outcome (a rule, a replay, a simulated fault), or it isn't the app's traffic. */
export function isExcluded(e: Exchange): boolean {
  if (e.initiator || e.browserInternal) return true;
  if (e.state === 'mocked' || e.state === 'blocked') return true; // mocks, blocks, replays, scripted answers
  const sim = e.simulated;
  if (sim) {
    if (/^Replayed\b/.test(sim)) return true;
    // A fault rule, a throttle / profile drop, offline, replay "fail": the failure IS the simulation. (A plain
    // throttle or Map Remote label doesn't excuse a real failure.)
    if (SIMULATED_FAILURE.test(sim)) return true;
    // A rewrite rule that set the status.
    if (/Rewritten:[^·]*\bstatus \d{3}/.test(sim)) return true;
  }
  return false;
}

/** Whether `e` (in a final state) is a failure at `level`. */
export function isFailure(e: Exchange, level: NotifyLevel): boolean {
  if (level === 'off') return false;
  if (e.state === 'error') return true;
  const st = e.status;
  if (typeof st !== 'number') return false;
  return st >= 500 || (level === 'all' && st >= 400);
}

/** `GET /users/42` (path only; credential-looking segments redacted), plus the GraphQL operation when known. */
export function describeRequest(e: Exchange): string {
  let path = e.url;
  try {
    path = new URL(e.url).pathname || '/';
  } catch {
    path = e.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/[?#].*$/s, '') || '/';
  }
  path = path
    .split('/')
    .map((seg) => {
      let v = seg;
      try {
        v = decodeURIComponent(seg);
      } catch {
        // keep raw
      }
      return redactSecretValues(v, true) !== v ? '[redacted]' : neutralizePath(seg);
    })
    .join('/');
  const op = e.graphql?.operationName ? ` (${neutralizeText(e.graphql.operationName)})` : '';
  return `${neutralizeText(e.method.toUpperCase())} ${path}${op}`;
}

/** `500 Internal Server Error`, or a short error message (URLs reduced to origin + path). */
export function describeOutcome(e: Exchange): string {
  if (typeof e.status === 'number' && e.status > 0) {
    const reason = STATUS_CODES[e.status];
    return reason ? `${e.status} ${reason}` : String(e.status);
  }
  if (!e.error) return 'error';
  const noQuery = e.error.replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>`?#]*)[?#][^\s"'<>`]*/gi, '$1');
  // neutralized first: our own "[redacted]" marks stay readable and are never followed by a "("
  const text = redactText(neutralizeText(noQuery)).replace(/\s+/g, ' ').trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text || 'error';
}

function noticeFor(latest: Exchange, count: number): Notice {
  const what = describeRequest(latest);
  const outcome = describeOutcome(latest);
  const text = count === 1 ? `${what} failed: ${outcome}` : `${count} requests failed — latest: ${what} → ${outcome}`;
  return { text, exchangeId: latest.id, count };
}

/** The policy plus what a timer needs: when grouped failures can be flushed. */
export interface TimedNotifyPolicy extends NotifyPolicy {
  /** Epoch ms at which `flush` will return the waiting group, or undefined when nothing waits. */
  nextFlushAt(): number | undefined;
}

export function createNotifyPolicy(opts: NotifyPolicyOptions): TimedNotifyPolicy {
  let level = normalizeLevel(opts.level);
  const windowMs = Math.max(0, opts.windowMs ?? DEFAULT_WINDOW_MS);
  const seen = new Set<string>();
  let lastShownAt = Number.NEGATIVE_INFINITY;
  let pending: { latest: Exchange; count: number } | undefined;

  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > SEEN_CAP) {
      // Sets iterate in insertion order: drop the oldest.
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  };

  const emit = (now: number): Notice | undefined => {
    if (!pending) return undefined;
    const n = noticeFor(pending.latest, pending.count);
    pending = undefined;
    lastShownAt = now;
    return n;
  };

  return {
    onExchange(e, now, panelVisible) {
      if (!FINAL.has(e.state) || seen.has(e.id)) return undefined;
      remember(e.id);
      if (level === 'off' || isExcluded(e) || !isFailure(e, level)) return undefined;
      if (panelVisible) {
        pending = undefined; // the user is looking at the traffic
        return undefined;
      }
      pending = { latest: e, count: (pending?.count ?? 0) + 1 };
      return now - lastShownAt >= windowMs ? emit(now) : undefined;
    },
    flush(now, panelVisible) {
      if (!pending) return undefined;
      if (panelVisible || level === 'off') {
        pending = undefined;
        return undefined;
      }
      return now - lastShownAt >= windowMs ? emit(now) : undefined;
    },
    nextFlushAt() {
      return pending ? Math.max(lastShownAt + windowMs, Number.MIN_SAFE_INTEGER) : undefined;
    },
    setLevel(l) {
      level = normalizeLevel(l);
      if (level === 'off') pending = undefined;
    },
  };
}
