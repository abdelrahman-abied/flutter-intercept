/**
 * The `collections` key of `.vscode/flutter-intercept.json` (CONTRACTS §21.6): read, validate, write. Pure.
 *
 * Invalid entries are skipped with a readable problem, never guessed. Paths are only checked for shape here
 * (workspace-relative, no `..`); the host checks that they resolve inside the workspace (realpath, §12.2).
 * Maps read from the file are null-prototype objects: `__proto__` / `constructor` are plain keys.
 */
import { COLLECTION_LIMITS, LINK_ID, SNAPSHOT_NAME, STORE_LIMITS, type CollectionLink, type ResourceOverride, type StoreLink } from './types';
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from './auth';
import type { DynamicMode } from './dynamic';

const VARIABLE_NAME = /^[A-Za-z0-9_.$-]{1,100}$/;
const MAX_VALUE_CHARS = 2048;
const MAX_KEY_CHARS = 8 * 1024 + 16; // an endpoint key: method + URL template (§21.1)
const MAX_SELECTED = COLLECTION_LIMITS.endpoints;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function dict(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/** A workspace-relative path, `/`-separated; undefined when it isn't one. */
export function relativePath(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const p = v.trim().replace(/\\/g, '/');
  if (!p || p.length > 1024 || p.includes('\0')) return undefined;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return undefined;
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!parts.length || parts.includes('..')) return undefined;
  return parts.join('/');
}

/** CONTRACTS §24.4: a Bruno collection is linked by its `bruno.json` (the folder next to it is the collection). */
export function isBrunoLinkFile(file: string): boolean {
  return /(?:^|\/)bruno\.json$/i.test(file.replace(/\\/g, '/'));
}

/** CONTRACTS §24.4: an environment chosen by name (Insomnia, Bruno): one line, ≤ 100 characters. */
export const ENVIRONMENT_NAME = /^[^\u0000-\u001f\u007f\u2028\u2029]{1,100}$/;

/** The name as it is compared (trimmed); undefined when it isn't a usable name. */
export function environmentName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && ENVIRONMENT_NAME.test(t) ? t : undefined;
}

export interface ParsedLinks {
  links: CollectionLink[];
  problems: string[];
}

/**
 * Reads `json.collections`. `label` names the file in problems; `lineOf(i)` (optional) gives the 1-based line of
 * entry `i` for them.
 */
export function parseCollectionLinks(json: Obj, label: string, lineOf?: (i: number) => number | undefined): ParsedLinks {
  const raw = json.collections;
  if (raw === undefined) return { links: [], problems: [] };
  if (!Array.isArray(raw)) return { links: [], problems: [`${label}: "collections" must be an array (ignored)`] };
  const links: CollectionLink[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const line = lineOf?.(i);
    const at = line ? `${label} line ${line}` : label;
    if (i >= COLLECTION_LIMITS.linksPerFile) {
      if (i === COLLECTION_LIMITS.linksPerFile) problems.push(`${at}: at most ${COLLECTION_LIMITS.linksPerFile} collections; the rest are skipped`);
      return;
    }
    const where = `collection ${i + 1}${isObj(entry) && typeof entry.id === 'string' ? ` "${entry.id.slice(0, 40)}"` : ''}`;
    const skip = (why: string) => problems.push(`${at}: ${where}: ${why} (skipped)`);
    if (!isObj(entry)) return skip('must be an object');
    if (typeof entry.id !== 'string' || !LINK_ID.test(entry.id)) return skip('"id" must be 1–40 lower-case letters, digits or "-", such as "shop-api"');
    if (seen.has(entry.id)) return skip('duplicate id');
    const file = relativePath(entry.file);
    if (!file) return skip('"file" must be a path inside the workspace, such as "api/shop.postman_collection.json"');
    let environment: string | undefined;
    if (entry.environment !== undefined) {
      // CONTRACTS §24.4: a Postman environment file, or — for an Insomnia or Bruno collection — an environment's name
      // (the host knows which once it has read the collection; a Bruno link is known by its file name)
      // — a name has the shape of a relative path too ("dev", "Staging EU"), so one check covers both there
      environment = isBrunoLinkFile(file) ? environmentName(entry.environment) : relativePath(entry.environment);
      if (!environment) return skip('"environment" must be a path inside the workspace (Postman) or an environment name (Insomnia, Bruno)');
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') return skip('"enabled" must be true or false');
    if (entry.unmatched !== undefined && entry.unmatched !== 'passthrough' && entry.unmatched !== 'fail') return skip('"unmatched" must be "passthrough" or "fail"');

    const variables = dict();
    if (entry.variables !== undefined) {
      if (!isObj(entry.variables)) return skip('"variables" must be an object of names to text');
      for (const [k, v] of Object.entries(entry.variables)) {
        if (!VARIABLE_NAME.test(k)) return skip(`variable name "${k.slice(0, 40)}" isn't valid`);
        if (typeof v !== 'string' || v.length > MAX_VALUE_CHARS) return skip(`variable "${k}" must be text (at most ${MAX_VALUE_CHARS} characters)`);
        variables[k] = v;
      }
    }
    const selected = dict();
    if (entry.selected !== undefined) {
      if (!isObj(entry.selected)) return skip('"selected" must be an object of request keys to example names');
      const pairs = Object.entries(entry.selected);
      if (pairs.length > MAX_SELECTED) return skip(`"selected" has more than ${MAX_SELECTED} entries`);
      for (const [k, v] of pairs) {
        if (k.length > MAX_KEY_CHARS || typeof v !== 'string' || v.length > 1000) return skip(`"selected" entry "${k.slice(0, 40)}" isn't valid`);
        selected[k] = v;
      }
    }
    const off: string[] = [];
    if (entry.off !== undefined) {
      if (!Array.isArray(entry.off) || entry.off.length > MAX_SELECTED) return skip(`"off" must be a list of request keys (at most ${MAX_SELECTED})`);
      for (const k of entry.off) {
        if (typeof k !== 'string' || k.length > MAX_KEY_CHARS) return skip('"off" must be a list of request keys');
        if (!off.includes(k)) off.push(k);
      }
    }
    seen.add(entry.id);
    links.push({
      id: entry.id,
      file,
      ...(environment ? { environment } : {}),
      variables,
      enabled: entry.enabled ?? true,
      unmatched: (entry.unmatched as CollectionLink['unmatched'] | undefined) ?? 'passthrough',
      selected,
      off,
    });
  });
  return { links, problems };
}

/** The entry as written to the file: stable key order, defaults and empty maps left out. */
export function toFileLink(link: CollectionLink): Obj {
  const out: Obj = { id: link.id, file: link.file };
  if (link.environment) out.environment = link.environment;
  const sorted = (m: Record<string, string>) => {
    const keys = Object.keys(m);
    if (!keys.length) return undefined;
    const o: Obj = {};
    for (const k of keys) Object.defineProperty(o, k, { value: m[k], enumerable: true, writable: true, configurable: true });
    return o;
  };
  const variables = sorted(link.variables);
  if (variables) out.variables = variables;
  if (!link.enabled) out.enabled = false;
  if (link.unmatched !== 'passthrough') out.unmatched = link.unmatched;
  const selected = sorted(link.selected);
  if (selected) out.selected = selected;
  if (link.off.length) out.off = [...link.off];
  return out;
}

// ------------------------------------------------------------------ stores (CONTRACTS §22.7)

/** A resource name as detection makes it (`users`, `users.orders`, `users #2`): one line, ≤ 100 characters. */
export const RESOURCE_NAME = /^[^\u0000-\u001f\u007f]{1,100}$/;
/** An id field name: one line, ≤ 100 characters. */
export const ID_FIELD = /^[^\u0000-\u001f\u007f]{1,100}$/;

/** Checks one resource override (`{off?, idField?}`); a readable problem, or the clean value. */
export function checkResourceOverride(v: unknown): { value?: ResourceOverride; problem?: string } {
  if (!isObj(v)) return { problem: 'must be an object such as {"idField": "userId"} or {"off": true}' };
  const out: ResourceOverride = {};
  for (const k of Object.keys(v)) {
    if (k !== 'off' && k !== 'idField') return { problem: `unknown field "${k.slice(0, 40)}"` };
  }
  if (v.off !== undefined) {
    if (typeof v.off !== 'boolean') return { problem: '"off" must be true or false' };
    out.off = v.off;
  }
  if (v.idField !== undefined) {
    if (typeof v.idField !== 'string' || !ID_FIELD.test(v.idField) || v.idField === '__proto__') return { problem: '"idField" must be a field name (1–100 characters)' };
    out.idField = v.idField;
  }
  return { value: out };
}

/** CONTRACTS §24.1: `stores[].auth` — sign-in simulation. Never a password or a token. */
export interface StoreAuthLink {
  /** Default false: a collection never starts rejecting requests by itself. */
  enabled?: boolean;
  /** 60–86 400; default 3 600. */
  ttlSeconds?: number;
  protect?: 'declared' | 'all';
  /** Endpoint keys, when detection picked the wrong request. */
  login?: string;
  refresh?: string;
}

/** CONTRACTS §24.1 / §24.3: a `stores` entry with the part 3 settings (`StoreLink` + `auth`, `dynamic`). */
export interface StoreSettingsLink extends StoreLink {
  auth?: StoreAuthLink;
  dynamic?: DynamicMode;
}

export const DYNAMIC_MODES: readonly DynamicMode[] = ['random', 'seeded', 'fixed'];

export function isDynamicMode(v: unknown): v is DynamicMode {
  return typeof v === 'string' && (DYNAMIC_MODES as readonly string[]).includes(v);
}

export function isTtlSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_TTL_SECONDS && v <= MAX_TTL_SECONDS;
}

/** Checks `stores[].auth` (or the same fields of a personal overlay); a readable problem, or the clean value. */
export function checkStoreAuth(v: unknown): { value?: StoreAuthLink; problem?: string } {
  if (!isObj(v)) return { problem: 'must be an object such as {"enabled": true, "ttlSeconds": 3600}' };
  const out: StoreAuthLink = {};
  for (const k of Object.keys(v)) {
    if (!['enabled', 'ttlSeconds', 'protect', 'login', 'refresh'].includes(k)) return { problem: `unknown field "${k.slice(0, 40)}" (a password or token is never stored here)` };
  }
  if (v.enabled !== undefined) {
    if (typeof v.enabled !== 'boolean') return { problem: '"enabled" must be true or false' };
    out.enabled = v.enabled;
  }
  if (v.ttlSeconds !== undefined) {
    if (!isTtlSeconds(v.ttlSeconds)) return { problem: `"ttlSeconds" must be a whole number ${MIN_TTL_SECONDS}–${MAX_TTL_SECONDS}` };
    out.ttlSeconds = v.ttlSeconds;
  }
  if (v.protect !== undefined) {
    if (v.protect !== 'declared' && v.protect !== 'all') return { problem: '"protect" must be "declared" or "all"' };
    out.protect = v.protect;
  }
  for (const k of ['login', 'refresh'] as const) {
    const x = v[k];
    if (x === undefined) continue;
    if (typeof x !== 'string' || !x || x.length > MAX_KEY_CHARS || /[\u0000-\u001f\u007f]/.test(x)) return { problem: `"${k}" must be a request key such as "POST {{baseUrl}}/auth/login"` };
    out[k] = x;
  }
  return { value: out };
}

/** `auth` as written to the file: defaults left out; undefined when nothing is left. */
function authToFile(a: StoreAuthLink | undefined): Obj | undefined {
  if (!a) return undefined;
  const o: Obj = {};
  if (a.enabled === true) o.enabled = true;
  if (a.ttlSeconds !== undefined && a.ttlSeconds !== DEFAULT_TTL_SECONDS) o.ttlSeconds = a.ttlSeconds;
  if (a.protect) o.protect = a.protect;
  if (a.login) o.login = a.login;
  if (a.refresh) o.refresh = a.refresh;
  return Object.keys(o).length ? o : undefined;
}

export interface ParsedStores {
  /** Valid entries in file order (the first one per collection is used; one whose collection isn't linked is ignored). */
  stores: StoreSettingsLink[];
  problems: string[];
}

/**
 * Reads `json.stores` (CONTRACTS §22.7). Invalid entries are skipped with a problem line; at most 20 entries and 100
 * resources each. Resource maps are null-prototype objects.
 */
export function parseStoreLinks(json: Obj, label: string): ParsedStores {
  const raw = json.stores;
  if (raw === undefined) return { stores: [], problems: [] };
  if (!Array.isArray(raw)) return { stores: [], problems: [`${label}: "stores" must be an array (ignored)`] };
  const stores: StoreSettingsLink[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    if (i >= STORE_LIMITS.storeLinks) {
      if (i === STORE_LIMITS.storeLinks) problems.push(`${label}: at most ${STORE_LIMITS.storeLinks} "stores" entries; the rest are skipped`);
      return;
    }
    const where = `stores entry ${i + 1}${isObj(entry) && typeof entry.collection === 'string' ? ` "${entry.collection.slice(0, 40)}"` : ''}`;
    const skip = (why: string) => problems.push(`${label}: ${where}: ${why} (skipped)`);
    if (!isObj(entry)) return skip('must be an object');
    if (typeof entry.collection !== 'string' || !LINK_ID.test(entry.collection)) return skip('"collection" must be the id of a linked collection, such as "shop-api"');
    if (seen.has(entry.collection)) return skip('a second entry for the same collection');
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') return skip('"enabled" must be true or false');
    if (entry.snapshot !== undefined && (typeof entry.snapshot !== 'string' || !SNAPSHOT_NAME.test(entry.snapshot))) {
      return skip('"snapshot" must be a snapshot name (1–40 lower-case letters, digits or "-")');
    }
    let resources: Record<string, ResourceOverride> | undefined;
    if (entry.resources !== undefined) {
      if (!isObj(entry.resources)) return skip('"resources" must be an object of resource names to settings');
      const pairs = Object.entries(entry.resources);
      if (pairs.length > STORE_LIMITS.resourcesPerCollection) return skip(`"resources" has more than ${STORE_LIMITS.resourcesPerCollection} entries`);
      resources = Object.create(null) as Record<string, ResourceOverride>;
      for (const [name, v] of pairs) {
        if (!RESOURCE_NAME.test(name)) return skip(`resource name "${name.slice(0, 40)}" isn't valid`);
        const c = checkResourceOverride(v);
        if (!c.value) return skip(`resource "${name.slice(0, 40)}": ${c.problem}`);
        resources[name] = c.value;
      }
    }
    // CONTRACTS §24.1 / §24.3
    let auth: StoreAuthLink | undefined;
    if (entry.auth !== undefined) {
      const c = checkStoreAuth(entry.auth);
      if (!c.value) return skip(`"auth": ${c.problem}`);
      auth = c.value;
    }
    if (entry.dynamic !== undefined && !isDynamicMode(entry.dynamic)) return skip('"dynamic" must be "random", "seeded" or "fixed"');
    seen.add(entry.collection);
    stores.push({
      collection: entry.collection,
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
      ...(entry.snapshot !== undefined ? { snapshot: entry.snapshot } : {}),
      ...(resources && Object.keys(resources).length ? { resources } : {}),
      ...(auth && Object.keys(auth).length ? { auth } : {}),
      ...(entry.dynamic !== undefined ? { dynamic: entry.dynamic as DynamicMode } : {}),
    });
  });
  return { stores, problems };
}

/**
 * The `stores` array with the entry of `collection` replaced by `entry` (or removed when undefined / empty), every
 * other entry kept exactly as written (also ones for collections that aren't linked). Unknown fields of the replaced
 * entry are kept. Defaults are left out (`enabled: true`, `auth.enabled: false`, `auth.ttlSeconds: 3600`).
 */
export function withStoreEntry(raw: unknown, collection: string, entry: StoreSettingsLink | undefined): unknown[] {
  const list = Array.isArray(raw) ? [...(raw as unknown[])] : [];
  const at = list.findIndex((e) => isObj(e) && e.collection === collection);
  const old = at >= 0 && isObj(list[at]) ? (list[at] as Obj) : undefined;
  const out: Obj = { collection };
  if (old) for (const k of Object.keys(old)) if (!['collection', 'enabled', 'snapshot', 'resources', 'auth', 'dynamic'].includes(k)) out[k] = old[k];
  if (entry?.enabled === false) out.enabled = false;
  if (entry?.snapshot) out.snapshot = entry.snapshot;
  const res = entry?.resources ?? {};
  const names = Object.keys(res).filter((n) => res[n].off === true || res[n].idField !== undefined);
  if (names.length) {
    const o: Obj = {};
    for (const n of names) {
      const v: Obj = {};
      if (res[n].idField !== undefined) v.idField = res[n].idField;
      if (res[n].off === true) v.off = true;
      Object.defineProperty(o, n, { value: v, enumerable: true, writable: true, configurable: true });
    }
    out.resources = o;
  }
  const auth = authToFile(entry?.auth);
  if (auth) out.auth = auth;
  if (entry?.dynamic !== undefined && isDynamicMode(entry.dynamic)) out.dynamic = entry.dynamic;
  const empty = Object.keys(out).length === 1;
  if (at >= 0) {
    if (empty) list.splice(at, 1);
    else list[at] = out;
  } else if (!empty) list.push(out);
  return list;
}
