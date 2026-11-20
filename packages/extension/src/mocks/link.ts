/**
 * The `collections` key of `.vscode/flutter-intercept.json` (CONTRACTS §21.6): read, validate, write. Pure.
 *
 * Invalid entries are skipped with a readable problem, never guessed. Paths are only checked for shape here
 * (workspace-relative, no `..`); the host checks that they resolve inside the workspace (realpath, §12.2).
 * Maps read from the file are null-prototype objects: `__proto__` / `constructor` are plain keys.
 */
import { COLLECTION_LIMITS, LINK_ID, type CollectionLink } from './types';

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
      environment = relativePath(entry.environment);
      if (!environment) return skip('"environment" must be a path inside the workspace');
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
