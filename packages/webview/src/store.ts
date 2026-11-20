/**
 * v0.16.0 (CONTRACTS §22.10 / §22.11): pure helpers for a collection's remembered data (the "Data" view) and the
 * detail pane's "Answered by collection … · created users 7". No DOM, no postMessage. Hostile-input safe: records
 * are shown as plain text, keys never go into a RegExp, names and values are cut, prototype keys are never read.
 */
import { clipName, collectionIdFromRuleId } from './collections';
import { validateJson } from './json';
import type { CollectionStatus, Exchange, StoreAuthStatus, StoreOpView, StorePatch, StoreStatus } from './protocol';

export const STORE_VIEW_LIMITS = {
  /** Records kept in the panel per open resource (the store's own per-resource cap). */
  items: 5000,
  /** Rows rendered at first; "Show more" adds a page. */
  rows: 50,
  rowsStep: 100,
  /** Columns: top-level scalar keys of the first `sample` records, at most `columns`. */
  sample: 50,
  columns: 8,
  /** Characters of a value shown in a cell. */
  cell: 80,
  /** Resources named in the one-line summary. */
  summary: 6,
  /** The JSON view shows this many characters at most. */
  jsonChars: 256 * 1024,
  /** Filter box debounce before asking the host. */
  filterDebounceMs: 250,
} as const;

/** What the panel keeps of the host's `storeItems` answers for one (collection, resource). */
export interface StoreItemsView {
  id: string;
  resource: string;
  total: number;
  items: unknown[];
  truncated?: true;
}

/** Unambiguous Map key for `(collectionId, resource)`. */
export function storeItemsKey(id: string, resource: string): string {
  return JSON.stringify([id, resource]);
}

/**
 * Applies one `storeItems` answer: offset 0 replaces, a later offset appends after the first `offset` records kept
 * (so a push for page 1 never duplicates rows). At most `STORE_VIEW_LIMITS.items` records are kept.
 */
export function mergeStoreItems(
  prev: StoreItemsView | undefined,
  msg: { id: string; resource: string; offset: number; total: number; items: unknown[]; truncated?: true },
): StoreItemsView {
  const incoming = Array.isArray(msg.items) ? msg.items : [];
  const offset = Number.isInteger(msg.offset) && msg.offset > 0 ? msg.offset : 0;
  const head = offset > 0 && prev ? prev.items.slice(0, offset) : [];
  const items = head.concat(incoming).slice(0, STORE_VIEW_LIMITS.items);
  const total = Number.isFinite(msg.total) && msg.total >= 0 ? Math.floor(msg.total) : items.length;
  return { id: msg.id, resource: msg.resource, total, items, ...(msg.truncated ? { truncated: true as const } : {}) };
}

/** CONTRACTS §22.11: "users 10 · orders 2 · cart 0" — resources that remember, at most six named. */
export function storeSummaryText(store: Pick<StoreStatus, 'resources'>): string | undefined {
  const on = (store.resources ?? []).filter((r) => r.remembers);
  if (!on.length) return undefined;
  const named = on.slice(0, STORE_VIEW_LIMITS.summary).map((r) => `${clipName(r.name, 60)} ${countOf(r.count)}`);
  const rest = on.length - named.length;
  return named.join(' · ') + (rest > 0 ? ` · ${rest} more` : '');
}

function countOf(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function recordsText(n: number): string {
  return `${n} record${n === 1 ? '' : 's'}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ownValue(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Table columns: top-level keys holding a scalar in any of the first 50 records, in first-seen order, the id field
 * first, at most eight.
 */
export function storeColumns(items: readonly unknown[], idField: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const n = Math.min(items.length, STORE_VIEW_LIMITS.sample);
  for (let i = 0; i < n; i++) {
    const rec = items[i];
    if (!isPlainObject(rec)) continue;
    for (const key of Object.keys(rec)) {
      if (seen.has(key)) continue;
      if (!isScalar(rec[key])) continue;
      seen.add(key);
      out.push(key);
    }
  }
  const at = out.indexOf(idField);
  if (at > 0) {
    out.splice(at, 1);
    out.unshift(idField);
  }
  return out.slice(0, STORE_VIEW_LIMITS.columns);
}

/** A cell's plain text: scalars as written (strings cut at 80), nested values as `{…}` / `[n]`, absent as ''. */
export function cellText(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'string') return clipName(v.replace(/[\r\n\t]+/g, ' '), STORE_VIEW_LIMITS.cell);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return '{…}';
  return '';
}

/** The value a cell shows for `key` of a record. */
export function cellOf(rec: unknown, key: string): string {
  return isPlainObject(rec) ? cellText(ownValue(rec, key)) : '';
}

/** A record's id (its id field as text), or undefined when it has none usable. */
export function recordId(rec: unknown, idField: string): string | undefined {
  if (!isPlainObject(rec)) return undefined;
  const v = ownValue(rec, idField);
  if (typeof v === 'string') return v.length > 0 && v.length <= 100 ? v : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** JSON text of a record for the editor (2-space). */
export function recordText(rec: unknown): string {
  try {
    return JSON.stringify(rec ?? {}, null, 2) ?? '{}';
  } catch {
    return '{}';
  }
}

/** JSON view of the shown records, cut at 256 K characters. */
export function recordsJsonText(items: readonly unknown[]): { text: string; cut: boolean } {
  let text: string;
  try {
    text = JSON.stringify(items, null, 2) ?? '[]';
  } catch {
    text = '[]';
  }
  if (text.length <= STORE_VIEW_LIMITS.jsonChars) return { text, cut: false };
  return { text: text.slice(0, STORE_VIEW_LIMITS.jsonChars), cut: true };
}

/** Validates the editor's text as one JSON object (with line and column on a syntax error). */
export function parseRecordText(text: string): { ok: true; item: Record<string, unknown> } | { ok: false; message: string } {
  if (!text.trim()) return { ok: false, message: 'Write the record as a JSON object, e.g. {"name": "Ada"}.' };
  const check = validateJson(text);
  if (!check.ok) return { ok: false, message: `Not valid JSON (line ${check.line}, column ${check.column}): ${check.message}` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `Not valid JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(value)) return { ok: false, message: 'A record is a JSON object ({ … }), not a list or a single value.' };
  return { ok: true, item: value };
}

// ------------------------------------------------------------------ detail pane (CONTRACTS §22.11)

const OP_VERB: Record<StoreOpView['op'], string> = {
  list: 'listed', create: 'created', get: 'read', replace: 'updated', patch: 'updated', delete: 'deleted',
};
const NOTE_VERBS = ['listed', 'created', 'read', 'updated', 'deleted', 'replaced', 'patched'];
/** CONTRACTS §22.1: the `simulated` label of an answer a collection's data gave. */
export const STATEFUL_SIMULATED = 'Stateful mock';

function isStoreOp(v: unknown): v is StoreOpView {
  if (!isPlainObject(v)) return false;
  return typeof v.resource === 'string' && typeof v.op === 'string' && Object.prototype.hasOwnProperty.call(OP_VERB, v.op)
    && (v.itemId === undefined || typeof v.itemId === 'string');
}

/**
 * What the collection's data did for an exchange, as "created users 7" — from `collection.store` when the exchange
 * carries it (CONTRACTS §22.10), else from the store's note (§22.5 "<resource>: created 7") on an answer the proxy
 * labelled `Stateful mock` (§22.1). `note` is the note used, so the pane doesn't show it twice.
 */
export function storeOpOfExchange(
  ex: Pick<Exchange, 'matchedRuleId' | 'simulated' | 'notes'>,
  collections?: readonly CollectionStatus[],
): { text: string; note?: string } | undefined {
  const colId = collectionIdFromRuleId(ex.matchedRuleId);
  if (!colId) return undefined;
  const carried = (ex as { collection?: { store?: unknown } }).collection?.store;
  if (isStoreOp(carried)) {
    const parts = [OP_VERB[carried.op], clipName(carried.resource, 60)];
    if (carried.itemId) parts.push(clipName(carried.itemId, 100));
    const prefix = `${carried.resource}: `;
    const note = ex.simulated === STATEFUL_SIMULATED ? ex.notes?.find((n) => typeof n === 'string' && n.startsWith(prefix)) : undefined;
    return { text: parts.join(' '), ...(note !== undefined ? { note } : {}) };
  }
  if (ex.simulated !== STATEFUL_SIMULATED) return undefined;
  const names = collections?.find((c) => c.id === colId)?.store?.resources?.map((r) => r.name);
  for (const note of ex.notes ?? []) {
    if (typeof note !== 'string') continue;
    const at = note.indexOf(': ');
    if (at <= 0) continue;
    const resource = note.slice(0, at);
    const rest = note.slice(at + 2).trim();
    if (!rest) continue;
    if (names && names.length && !names.includes(resource)) continue;
    const verb = NOTE_VERBS.find((v) => rest === v || rest.startsWith(`${v} `));
    if (verb) return { text: clipName(`${verb} ${resource}${rest.slice(verb.length)}`, 200), note };
    if (rest.endsWith(' not found')) return { text: clipName(`${resource} ${rest}`, 200), note };
  }
  return undefined;
}

// ------------------------------------------------------------------ sign-in and made-up values (CONTRACTS §24.1 / §24.3)

/** CONTRACTS §24.1: how long a token lasts, in seconds. */
export const AUTH_TTL = { min: 60, max: 86_400, fallback: 3600 } as const;
export const SIGN_IN_TIP = 'No password is checked or kept.';

/** Sign-in simulation as the panel shows it: only when the collection has a login request. */
export function authOf(store: Pick<StoreStatus, 'auth'> | undefined): StoreAuthStatus | undefined {
  const a = store?.auth;
  return a && typeof a === 'object' && a.available === true ? a : undefined;
}

/** The token lifetime to show: the host's when it is in range, else the default. */
export function ttlOf(auth: Pick<StoreAuthStatus, 'ttlSeconds'>): number {
  const n = auth.ttlSeconds;
  return typeof n === 'number' && Number.isInteger(n) && n >= AUTH_TTL.min && n <= AUTH_TTL.max ? n : AUTH_TTL.fallback;
}

/** What the lifetime box holds, as seconds within 60–86 400 (undefined: not a number — put the old value back). */
export function parseTtl(text: string): number | undefined {
  const t = text.trim();
  if (!t || t.length > 12) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(AUTH_TTL.max, Math.max(AUTH_TTL.min, Math.round(n)));
}

export function protectOf(auth: Pick<StoreAuthStatus, 'protect'>): 'declared' | 'all' {
  return auth.protect === 'declared' ? 'declared' : 'all';
}

/** "2 sessions" (a count, never a token). */
export function sessionsText(n: unknown): string {
  const c = countOf(n);
  return `${c} session${c === 1 ? '' : 's'}`;
}

export const DYNAMIC_OPTIONS: readonly { value: NonNullable<StoreStatus['dynamic']>; label: string; title: string }[] = [
  { value: 'random', label: 'New every time', title: 'Every answer gets new made-up values' },
  { value: 'seeded', label: 'Same every run', title: 'The same made-up values each time the app runs — good for tests' },
  { value: 'fixed', label: 'Fixed', title: 'Always the same value for each kind' },
];

/** How made-up values are produced, when the collection has any (undefined: nothing to choose). */
export function dynamicOf(store: Pick<StoreStatus, 'dynamic'> | undefined): NonNullable<StoreStatus['dynamic']> | undefined {
  const d = store?.dynamic;
  return DYNAMIC_OPTIONS.some((o) => o.value === d) ? d : undefined;
}

/**
 * CONTRACTS §21.15 / §22.7 / §24.1: what "Save for the team" sends for the collection's own data settings — on or
 * off, where the data starts, sign-in (on, lifetime, which requests) and made-up values. Never a password or token.
 */
export function teamStorePatch(store: StoreStatus): StorePatch {
  const auth = authOf(store);
  const dynamic = dynamicOf(store);
  return {
    enabled: store.enabled,
    startsFrom: store.startsFrom ?? null,
    ...(auth ? { auth: { enabled: !!auth.enabled, ttlSeconds: ttlOf(auth), protect: protectOf(auth) } } : {}),
    ...(dynamic ? { dynamic } : {}),
    scope: 'team',
  };
}

const AUTH_NOTE_PREFIX = 'auth: ';
/** CONTRACTS §24.1: the notes of an answer the sign-in simulation gave, in plain words. */
const AUTH_NOTE_TEXT = new Map<string, string>([
  ['auth: 401 no token', 'needs sign-in (no token)'],
  ['auth: 401 expired', 'token expired'],
  ['auth: signed in', 'signed in'],
  ['auth: refreshed', 'token refreshed'],
]);

/**
 * What sign-in did for a collection's answer, for the collection's own line in the detail pane ("needs sign-in (no
 * token)"). `note` is the note used, so the pane doesn't show it twice. Other "auth: …" notes stay notes.
 */
export function authNoteOfExchange(ex: Pick<Exchange, 'matchedRuleId' | 'notes'>): { text: string; note: string } | undefined {
  if (!collectionIdFromRuleId(ex.matchedRuleId)) return undefined;
  for (const note of ex.notes ?? []) {
    if (typeof note !== 'string' || !note.startsWith(AUTH_NOTE_PREFIX)) continue;
    const text = AUTH_NOTE_TEXT.get(note.trim());
    if (text) return { text, note };
  }
  return undefined;
}
