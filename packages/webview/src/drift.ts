/**
 * v0.16.0 part 2 (CONTRACTS §23.3 / §23.4): pure helpers for "out of date" — the real server's answers no longer
 * look like a collection's examples. No DOM, no postMessage. Plain words only ("out of date", never "drift"); field
 * names and kinds, never values. Hostile-input safe: nothing external goes into a RegExp, lists and names are cut.
 */
import { clipName } from './collections';
import type { CollectionEndpointView, CollectionStatus, DriftChange, DriftView } from './protocol';

export const DRIFT_VIEW_LIMITS = {
  /** Changes listed per endpoint and status (the host's own cap), then "and N more". */
  changes: 20,
  /** Endpoints listed under a collection's "Out of date" line, then "and N more". */
  endpoints: 20,
  /** Statuses listed per endpoint. */
  statuses: 10,
  /** Characters of the host's one line. */
  line: 300,
} as const;

const KINDS: readonly DriftChange['kind'][] = ['added', 'removed', 'type', 'nullable', 'status'];

function isChange(c: unknown): c is DriftChange {
  if (typeof c !== 'object' || c === null) return false;
  const v = c as Record<string, unknown>;
  return typeof v.kind === 'string' && (KINDS as readonly string[]).includes(v.kind) && typeof v.path === 'string'
    && (v.from === undefined || typeof v.from === 'string') && (v.to === undefined || typeof v.to === 'string');
}

function isHttpStatus(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599;
}

/** An endpoint's well-formed differences that have something to say (at most ten statuses). */
export function driftsOf(ep: Pick<CollectionEndpointView, 'drift'>): DriftView[] {
  const list = Array.isArray(ep.drift) ? ep.drift : [];
  const out: DriftView[] = [];
  for (const d of list) {
    if (typeof d !== 'object' || d === null || !isHttpStatus(d.status) || !Array.isArray(d.changes)) continue;
    const changes = d.changes.filter(isChange);
    if (!changes.length) continue;
    out.push({ ...d, changes });
    if (out.length >= DRIFT_VIEW_LIMITS.statuses) break;
  }
  return out;
}

/** The endpoints of a collection that are out of date, in the collection's order. */
export function driftedEndpoints(endpoints: readonly CollectionEndpointView[] | undefined): CollectionEndpointView[] {
  if (!endpoints) return [];
  const out: CollectionEndpointView[] = [];
  for (let i = 0; i < endpoints.length; i++) {
    if (endpoints[i].drift && driftsOf(endpoints[i]).length) out.push(endpoints[i]);
  }
  return out;
}

/** CONTRACTS §23.2: "Out of date: GET /users/:id now has avatar (and 2 more)" (undefined: nothing is out of date). */
export function driftLineText(drift: CollectionStatus['drift']): string | undefined {
  if (!drift || typeof drift !== 'object') return undefined;
  const line = typeof drift.line === 'string' ? drift.line.replace(/\s+/g, ' ').trim() : '';
  const n = typeof drift.endpoints === 'number' && Number.isFinite(drift.endpoints) ? Math.floor(drift.endpoints) : 0;
  if (!line && n <= 0) return undefined;
  if (line) return `Out of date: ${clipName(line, DRIFT_VIEW_LIMITS.line)}`;
  return `Out of date: ${n} request${n === 1 ? '' : 's'} no longer match${n === 1 ? 'es' : ''} what the real server answers`;
}

const NUMBERS = new Set(['int', 'integer', 'double', 'float', 'number', 'num']);
const WHOLE = new Set(['int', 'integer']);

/** A kind of value in plain words ("text", "a number"); undefined when it says nothing ("mixed", unknown). */
function kindWords(kind: string | undefined, other: string | undefined): string | undefined {
  if (kind === undefined) return undefined;
  const k = kind.toLowerCase();
  if (NUMBERS.has(k)) {
    // "a number" unless both sides are numbers: then say which.
    if (other === undefined || !NUMBERS.has(other.toLowerCase())) return 'a number';
    return WHOLE.has(k) ? 'a whole number' : 'a decimal number';
  }
  switch (k) {
    case 'string': return 'text';
    case 'bool':
    case 'boolean': return 'true / false';
    case 'list':
    case 'array': return 'a list';
    case 'object':
    case 'map': return 'an object';
    case 'null': return 'empty';
    default: return undefined;
  }
}

/** The status a `status` change is about: its `to` when that is a status, else the view's own. */
function statusOfChange(c: DriftChange, status: number): number | undefined {
  if (typeof c.to === 'string' && c.to.length === 3) {
    const n = Number(c.to);
    if (isHttpStatus(n)) return n;
  }
  return isHttpStatus(status) ? status : undefined;
}

/**
 * One difference in plain words: "avatar — new field", "age — now text, was a number", "nickname — can be empty
 * now", "email — gone", "answers 201, no example for it". Names and kinds only, never a value.
 */
export function driftChangeText(c: DriftChange, status: number): string {
  if (c.kind === 'status') {
    const s = statusOfChange(c, status);
    return s !== undefined ? `answers ${s}, no example for it` : 'answers a status it has no example for';
  }
  const what = c.path ? clipName(c.path) : 'the whole answer';
  switch (c.kind) {
    case 'added': return `${what} — new field`;
    case 'removed': return `${what} — gone`;
    case 'nullable': return `${what} — can be empty now`;
    case 'type': {
      const now = kindWords(c.to, c.from);
      const was = kindWords(c.from, c.to);
      if (now && was) return `${what} — now ${now}, was ${was}`;
      if (now) return `${what} — now ${now}`;
      return `${what} — another kind of value now`;
    }
  }
}

/** The first twenty differences of one status as lines, and how many were left out ("and N more"). */
export function driftChangeLines(view: Pick<DriftView, 'changes' | 'status'>): { lines: string[]; more: number } {
  const changes = Array.isArray(view.changes) ? view.changes.filter(isChange) : [];
  const shown = changes.slice(0, DRIFT_VIEW_LIMITS.changes);
  return { lines: shown.map((c) => driftChangeText(c, view.status)), more: changes.length - shown.length };
}

/** True when the server answered a status the endpoint has no example for: there is nothing to update, only to add. */
export function isNewStatus(view: Pick<DriftView, 'changes'>): boolean {
  return view.changes.length > 0 && view.changes.every((c) => c.kind === 'status');
}

/** "3 changes" for the tag's tooltip and the list. */
export function driftCountText(views: readonly Pick<DriftView, 'changes'>[]): string {
  let n = 0;
  for (const v of views) n += v.changes.length;
  return `${n} change${n === 1 ? '' : 's'}`;
}

/**
 * `GET {{baseUrl}}/users/:id` or `GET https://api.example/users/:id` → `GET /users/:id` (the host's own label, by
 * hand: no RegExp on an endpoint key).
 */
export function endpointLabel(key: string): string {
  const s = typeof key === 'string' ? key.trim() : '';
  const sp = s.indexOf(' ');
  if (sp <= 0) return clipName(s);
  const method = s.slice(0, sp);
  let rest = s.slice(sp + 1).trim();
  if (rest.startsWith('{{')) {
    const end = rest.indexOf('}}');
    if (end > 0) rest = rest.slice(end + 2);
  } else {
    const scheme = rest.indexOf('://');
    const slash = rest.indexOf('/');
    if (scheme > 0 && (slash < 0 || scheme < slash)) {
      const pathAt = rest.indexOf('/', scheme + 3);
      rest = pathAt < 0 ? '' : rest.slice(pathAt);
    }
  }
  return clipName(`${method} ${rest || '/'}`);
}
