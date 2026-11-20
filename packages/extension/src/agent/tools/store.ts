/**
 * Agent tools: stateful mocks (CONTRACTS §22.11). get_store reads a collection's remembered data through the agent's
 * redaction (records, a projection, or only their shape); set_store changes data (in memory) or settings (for me by
 * default); store_snapshot saves / loads / deletes a named snapshot file. Agents still can't approve or remove a
 * collection.
 */
import { isSensitiveField, REDACTED, redactSecretValues } from '../redact';
import { restoreRedactedJson, type AgentApiDeps } from '../shared';
import { shapeOf } from '../shape';
import type { ToolInput } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';
import type { StorePatch, StoreResourceView, StoreStatus } from '../../ui/protocol';

/** Characters of records one get_store answer carries at most (more → `more` / `next`, and a note). */
export const MAX_STORE_RESULT_CHARS = 100_000;
/** Records the host returns per storeItems call (its own cap is 1 000) when the agent side pages through a resource. */
const HOST_PAGE = 1000;
/** Records read at most to filter on the agent side or to build a shape (STORE_LIMITS.recordsPerResource). */
const MAX_SCAN = 5000;
/** Records a `shape: true` answer is built from. */
const SHAPE_SAMPLE = 1000;
const MAX_DEPTH = 64;

type Svc = NonNullable<AgentApiDeps['collections']>;
type StoreSvc = Svc & Required<Pick<Svc, 'storeStatus' | 'storeItems' | 'updateStore' | 'storeSnapshot'>>;

/** A service error as a tool error: "no such collection / resource / snapshot" → not_found, the rest → invalid. */
function toolError(e: unknown): AgentToolError {
  if (e instanceof AgentToolError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AgentToolError(message, /^No collection|no such|not found|has no (resource|snapshot)|No snapshot/i.test(message) ? 'not_found' : 'invalid');
}

function storeSvc(ag: AgentViews): StoreSvc {
  const svc = ag.collectionsOrThrow();
  if (!svc.storeStatus || !svc.storeItems || !svc.updateStore || !svc.storeSnapshot) {
    throw new AgentToolError('stateful mocks are not available here', 'state');
  }
  return svc as StoreSvc;
}

/** The store's status, or undefined when the collection has none; a collection that isn't linked → not_found. */
function statusOf(ag: AgentViews, svc: StoreSvc, id: string): StoreStatus | undefined {
  let st: StoreStatus | undefined;
  try {
    st = svc.storeStatus(id);
  } catch (e) {
    throw toolError(e);
  }
  if (st) return st;
  if (!svc.state().some((s) => s.id === id)) throw new AgentToolError(`No collection "${id}" is linked (list_collections lists them)`, 'not_found');
  return undefined;
}

function resourceOf(st: StoreStatus | undefined, id: string, resource: string): StoreResourceView {
  const r = st?.resources.find((x) => x.name === resource);
  if (r) return r;
  const names = st?.resources.map((x) => x.name) ?? [];
  throw new AgentToolError(
    `collection "${id}" has no resource "${resource}"${names.length ? `; it has: ${names.slice(0, 20).join(', ')}` : ' (none of its requests form a resource that remembers)'}`,
    'not_found',
  );
}

/** A record as agents see it: secret-like field names and credential-looking values redacted (null-prototype safe). */
export function redactRecord(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[…]';
  if (Array.isArray(v)) return v.map((x) => redactRecord(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      Object.defineProperty(out, k, { value: isSensitiveField(k) ? REDACTED : redactRecord(x, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (typeof v === 'string') return redactSecretValues(v, true);
  return v;
}

/** Only `fields` (and the id field, first) of each record object. */
function project(rec: unknown, idField: string, fields: string[] | undefined): unknown {
  if (!fields || !rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
  const src = rec as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of [idField, ...fields]) {
    if (Object.prototype.hasOwnProperty.call(src, k) && !Object.prototype.hasOwnProperty.call(out, k)) {
      Object.defineProperty(out, k, { value: src[k], enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/**
 * Every record of a resource (≤ MAX_SCAN), paging through the host. Used where the agent side must see all of them:
 * a filter under redaction (matched against what the agent sees, so a filter can't probe a redacted value) and shapes.
 */
function scan(svc: StoreSvc, id: string, resource: string, scope: Record<string, string> | undefined, max = MAX_SCAN): { items: unknown[]; total: number } {
  const items: unknown[] = [];
  let total = 0;
  for (let offset = 0, calls = 0; items.length < max && calls < 50; calls++) {
    const page = svc.storeItems(id, resource, { offset, limit: Math.min(HOST_PAGE, max - items.length), ...(scope ? { scope } : {}) });
    total = page.total;
    if (!page.items.length) break;
    items.push(...page.items);
    offset += page.items.length;
    if (offset >= page.total) break;
  }
  return { items, total };
}

export function getStore(ag: AgentViews, i: ToolInput<'get_store'>): ToolResult {
  const svc = storeSvc(ag);
  const st = statusOf(ag, svc, i.id);
  if (i.resource === undefined) {
    if (i.scope || i.filter || i.fields || i.shape || i.offset) throw new AgentToolError('scope, filter, offset, fields and shape need resource', 'invalid');
    if (!st) return { id: i.id, enabled: false, resources: [], note: 'this collection has no data that remembers (it needs list and item routes such as GET/POST /todos and GET/PUT/PATCH/DELETE /todos/:id)' };
    const notes: string[] = [];
    if (!st.enabled) notes.push('its resources do not remember now: set_store {enabled: true}');
    else if (!st.resources.length) notes.push('none of its requests form a resource that remembers');
    else notes.push('get_store {resource} reads the records; set_store changes them');
    // CONTRACTS §24.1: settings and a count of sessions — the status never holds a token; keys and lines as agents see them
    const auth = st.auth
      ? {
          ...st.auth,
          ...(st.auth.login !== undefined ? { login: ag.endpointKeyView(st.auth.login) } : {}),
          ...(st.auth.refresh !== undefined ? { refresh: ag.endpointKeyView(st.auth.refresh) } : {}),
          problems: st.auth.problems.map((p) => ag.text(p)),
        }
      : undefined;
    if (st.auth?.available && !st.auth.enabled) notes.push('it has a login request: set_store {auth: {enabled: true}} makes login answer a fresh token and other requests need it');
    return {
      id: i.id,
      ...st,
      problems: st.problems.map((p) => ag.text(p)),
      resources: st.resources.map((r) => (r.problem ? { ...r, problem: ag.text(r.problem) } : r)),
      ...(auth ? { auth } : {}),
      note: notes.join('; '),
    };
  }
  const res = resourceOf(st, i.id, i.resource);
  const view = (rec: unknown) => project(ag.redact ? redactRecord(rec) : rec, res.idField, i.fields);
  const filter = i.filter?.toLowerCase();

  let records: unknown[]; // already viewed (redacted, projected)
  let total: number;
  let start: number; // index of records[0] in the (filtered) list
  try {
    if (i.shape || (filter && ag.redact)) {
      const all = scan(svc, i.id, i.resource, i.scope, i.shape && !filter ? SHAPE_SAMPLE : MAX_SCAN);
      let viewed = all.items.map(view);
      if (filter) viewed = viewed.filter((r) => JSON.stringify(r).toLowerCase().includes(filter));
      if (i.shape) {
        const s = shapeOf(viewed, { maxChars: 4000 });
        const sampled = filter ? viewed.length : Math.min(all.items.length, all.total);
        return {
          id: i.id,
          resource: i.resource,
          total: filter ? viewed.length : all.total,
          shape: s.shape,
          ...(s.truncated ? { truncated: true } : {}),
          ...(!filter && sampled < all.total ? { sampledRecords: sampled } : {}),
        };
      }
      total = viewed.length;
      records = viewed.slice(i.offset, i.offset + i.limit);
      start = i.offset;
    } else {
      const page = svc.storeItems(i.id, i.resource, { offset: i.offset, limit: i.limit, ...(i.filter ? { filter: i.filter } : {}), ...(i.scope ? { scope: i.scope } : {}) });
      total = page.total;
      records = page.items.map(view);
      start = i.offset;
    }
  } catch (e) {
    throw toolError(e);
  }
  // keep the answer readable: stop at MAX_STORE_RESULT_CHARS of records (at least one)
  const items: unknown[] = [];
  let chars = 0;
  let cut = false;
  for (const r of records) {
    const n = (JSON.stringify(r) ?? '').length + 1;
    if (items.length && chars + n > MAX_STORE_RESULT_CHARS) {
      cut = true;
      break;
    }
    items.push(r);
    chars += n;
  }
  const next = start + items.length;
  const more = Math.max(0, total - next);
  const notes: string[] = [];
  if (cut) notes.push(`cut at ${MAX_STORE_RESULT_CHARS} characters: use fields, a smaller limit or shape: true`);
  if (!res.remembers) notes.push('this resource does not remember now (fixed examples answer): set_store {resource, remembers: true}');
  return {
    id: i.id,
    resource: i.resource,
    total,
    items,
    ...(i.offset ? { offset: i.offset } : {}),
    ...(more ? { more, next } : {}),
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

/** `[redacted]` values the agent sends back get the stored value of the record with the same id (never revealed). */
function restoreRecords(ag: AgentViews, svc: StoreSvc, id: string, resource: string, idField: string, recs: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!ag.redact || !recs.some((r) => JSON.stringify(r).includes(REDACTED))) return recs;
  const byId = new Map<string, unknown>();
  for (const r of scan(svc, id, resource, undefined).items) {
    if (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, idField)) byId.set(String((r as Record<string, unknown>)[idField]), r);
  }
  return recs.map((r) => {
    const key = Object.prototype.hasOwnProperty.call(r, idField) ? String(r[idField]) : undefined;
    const orig = key !== undefined ? byId.get(key) : undefined;
    return orig === undefined ? r : (restoreRedactedJson(r, orig) as Record<string, unknown>);
  });
}

export async function setStore(ag: AgentViews, i: ToolInput<'set_store'>): Promise<ToolResult> {
  const svc = storeSvc(ag);
  const st = statusOf(ag, svc, i.id);
  // CONTRACTS §24.1: auth.expire is a data change (sessions); the other auth fields and dynamic are settings
  const expire = i.auth?.expire === 'all';
  const authSettings = i.auth && (i.auth.enabled !== undefined || i.auth.ttlSeconds !== undefined || i.auth.protect !== undefined)
    ? { ...(i.auth.enabled !== undefined ? { enabled: i.auth.enabled } : {}), ...(i.auth.ttlSeconds !== undefined ? { ttlSeconds: i.auth.ttlSeconds } : {}), ...(i.auth.protect !== undefined ? { protect: i.auth.protect } : {}) }
    : undefined;
  if (i.auth !== undefined && !expire && !authSettings) throw new AgentToolError('auth is empty: pass enabled, ttlSeconds, protect or expire', 'invalid');
  const dataOps = [i.items !== undefined, i.put !== undefined, i.remove !== undefined, i.generate !== undefined, expire].filter(Boolean).length;
  const settings = i.enabled !== undefined || i.remembers !== undefined || i.idField !== undefined || i.startsFrom !== undefined || authSettings !== undefined || i.dynamic !== undefined;
  if (!st) throw new AgentToolError(`collection "${i.id}" has no data that remembers`, 'state');
  const res = i.resource !== undefined ? resourceOf(st, i.id, i.resource) : undefined;
  let patch: StorePatch;
  let kind: 'data' | 'reset' | 'settings';
  if (i.reset !== undefined) {
    if (dataOps || settings) throw new AgentToolError("reset can't be combined with other changes", 'invalid');
    if (i.reset === 'settings' && i.scope === 'team') throw new AgentToolError("reset: 'settings' undoes your own settings: leave scope out (or \"me\")", 'invalid');
    if (i.reset === 'data' && i.scope !== undefined) throw new AgentToolError('data is never saved to a file: scope is only for settings', 'invalid');
    patch = { reset: i.reset, ...(i.resource !== undefined ? { resource: i.resource } : {}) };
    kind = 'reset';
  } else if (dataOps) {
    if (dataOps > 1) throw new AgentToolError('one data change per call: items, put, remove, generate or auth.expire', 'invalid');
    if (settings) throw new AgentToolError('change data and settings in separate calls', 'invalid');
    if (i.scope !== undefined) throw new AgentToolError('data changes stay in memory and are never saved to a file: leave scope out', 'invalid');
    if (expire) {
      if (!st.auth?.enabled) throw new AgentToolError(`sign-in simulation is not on for collection "${i.id}"${st.auth?.available ? ': set_store {auth: {enabled: true}} first' : ' (it has no login request)'}`, 'state');
      patch = { auth: { expire: 'all' } };
    } else if (!res || i.resource === undefined) throw new AgentToolError('resource is required for items, put, remove and generate (get_store lists the resources)', 'invalid');
    else if (i.items !== undefined) patch = { resource: i.resource, replace: restoreRecords(ag, svc, i.id, i.resource, res.idField, i.items) };
    else if (i.put !== undefined) patch = { resource: i.resource, put: { item: restoreRecords(ag, svc, i.id, i.resource, res.idField, [i.put])[0] } };
    else if (i.remove !== undefined) patch = { resource: i.resource, remove: { itemId: String(i.remove) } };
    else patch = { resource: i.resource, generate: { count: i.generate!.count } };
    kind = 'data';
  } else if (settings) {
    if ((i.remembers !== undefined || i.idField !== undefined) && i.resource === undefined) throw new AgentToolError('remembers and idField need resource', 'invalid');
    if (typeof i.startsFrom === 'string' && !st.snapshots.includes(i.startsFrom)) {
      throw new AgentToolError(`no snapshot "${i.startsFrom}" for collection "${i.id}"${st.snapshots.length ? `; saved: ${st.snapshots.slice(0, 20).join(', ')}` : ' (store_snapshot {action: "save"} makes one)'}`, 'not_found');
    }
    patch = {
      ...(i.resource !== undefined ? { resource: i.resource } : {}),
      ...(i.enabled !== undefined ? { enabled: i.enabled } : {}),
      ...(i.remembers !== undefined ? { remembers: i.remembers } : {}),
      ...(i.idField !== undefined ? { idField: i.idField } : {}),
      ...(i.startsFrom !== undefined ? { startsFrom: i.startsFrom } : {}),
      ...(authSettings ? { auth: authSettings } : {}),
      ...(i.dynamic !== undefined ? { dynamic: i.dynamic } : {}),
      scope: i.scope ?? 'me',
    };
    kind = 'settings';
  } else {
    throw new AgentToolError('pass one change: items, put, remove, generate, remembers, idField, enabled, startsFrom, auth, dynamic or reset', 'invalid');
  }
  try {
    await svc.updateStore(i.id, patch);
  } catch (e) {
    throw toolError(e);
  }
  const after = statusOf(ag, svc, i.id);
  const problems = [...(after?.problems ?? []), ...(after?.resources.flatMap((r) => (r.problem && (i.resource === undefined || r.name === i.resource) ? [r.problem] : [])) ?? [])].map((p) => ag.text(p));
  const note =
    expire
      ? "every access token is expired (refresh tokens still work): the app's next request gets 401 and should refresh; get_auth_flows shows what it did"
      : kind === 'data'
      ? "changed in memory: the app's next requests see it (hot_restart to make a running app fetch again); set_store {resource, reset: \"data\"} puts back how it started"
      : kind === 'reset'
        ? i.reset === 'data'
          ? "back to how it started; the app's next requests see it"
          : 'your own store settings are undone (the team\'s apply)'
        : i.scope === 'team'
          ? 'saved in .vscode/flutter-intercept.json for the team'
          : 'changed for you only — set_store {reset: "settings"} undoes it';
  const counted = after?.resources ?? [];
  const one = i.resource !== undefined ? counted.find((r) => r.name === i.resource) : undefined;
  // CONTRACTS §24.1: settings and counts only — never a token
  const authView = (i.auth !== undefined || i.reset !== undefined) && after?.auth ? { auth: { enabled: after.auth.enabled, ttlSeconds: after.auth.ttlSeconds, protect: after.auth.protect, sessions: after.auth.sessions } } : {};
  for (const p of i.auth !== undefined ? after?.auth?.problems ?? [] : []) problems.push(ag.text(p));
  return {
    id: i.id,
    ...(one
      ? { resource: one.name, count: one.count, ...(kind === 'settings' ? { remembers: one.remembers, idField: one.idField } : {}) }
      : { enabled: after?.enabled ?? false, counts: Object.fromEntries(counted.map((r) => [r.name, r.count])) }),
    ...authView,
    ...(i.dynamic !== undefined && after?.dynamic !== undefined ? { dynamic: after.dynamic } : {}),
    ...(problems.length ? { problems: problems.slice(0, 20) } : {}),
    note,
  };
}

/** `.vscode/flutter-intercept/snapshots/<id>/<name>.json` as the agent sees it (never an absolute path). */
function snapshotPathView(ag: AgentViews, id: string, name: string, p: string): string {
  const rel = `.vscode/flutter-intercept/snapshots/${id}/${name}.json`;
  const norm = String(p).replace(/\\/g, '/');
  if (norm === rel || norm.endsWith(`/${rel}`)) return rel;
  return ag.projectPath(p) ?? rel;
}

export async function storeSnapshot(ag: AgentViews, i: ToolInput<'store_snapshot'>): Promise<ToolResult> {
  const svc = storeSvc(ag);
  const st = statusOf(ag, svc, i.id);
  if (!st) throw new AgentToolError(`collection "${i.id}" has no data that remembers`, 'state');
  if (i.action !== 'save' && !st.snapshots.includes(i.name)) {
    throw new AgentToolError(`no snapshot "${i.name}" for collection "${i.id}"${st.snapshots.length ? `; saved: ${st.snapshots.slice(0, 20).join(', ')}` : ''}`, 'not_found');
  }
  let r;
  try {
    r = await svc.storeSnapshot(i.id, i.action, i.name);
  } catch (e) {
    throw toolError(e);
  }
  const note =
    i.action === 'save'
      ? 'a file the team can commit; store_snapshot {action: "load"} loads it, set_store {startsFrom: name} starts from it'
      : i.action === 'load'
        ? "loaded: the app's next requests see it; set_store {reset: \"data\"} goes back"
        : 'deleted';
  return {
    id: i.id,
    action: i.action,
    name: i.name,
    path: snapshotPathView(ag, i.id, i.name, r.path),
    resources: r.resources,
    records: r.records,
    ...(r.blanked?.length ? { blanked: r.blanked.slice(0, 50).map((b) => ag.text(String(b))) } : {}),
    note,
  };
}

export const storeTools: ToolHandlers = {
  get_store: (ag, i) => getStore(ag, i),
  set_store: (ag, i) => setStore(ag, i),
  store_snapshot: (ag, i) => storeSnapshot(ag, i),
};
