/**
 * `.vscode/flutter-intercept.json` (CONTRACTS §12.1): parse, validate, namespace, serialise, hash. Pure.
 *
 * File format: `{ "version": 1, "rules": [ <Rule without `shared`/`used`>, … ], …other keys kept }`. Comments and
 * trailing commas are accepted (as in every `.vscode/*.json`) but are not written back. Hand-written rules may omit
 * `enabled` (default true), and a mock with `bodyFile` may omit `body`. Every rule needs an `id` (unique in the file).
 *
 * Ids in memory are namespaced so they can't collide with personal rules: `shared:<id>` for the primary folder's
 * file, `shared@<folder name>:<id>` for the files of further workspace folders (multi-root).
 */
import { createHash } from 'crypto';
import type { Rule } from '@flutter-intercept/proxy';
import { lineLocator, parseJsonc } from './jsonc';

export const SHARED_FILE = '.vscode/flutter-intercept.json';
export const SHARED_ID_PREFIX = 'shared:';
export const MAX_SHARED_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SHARED_RULES = 1000;
export const FILE_VERSION = 1;

export type ValidateRule = (raw: unknown, where?: string) => Rule;

// ------------------------------------------------------------------ ids

/** True for ids of rules that come from a shared file. */
export function isSharedRuleId(id: string): boolean {
  return id.startsWith(SHARED_ID_PREFIX) || id.startsWith('shared@');
}

/** The in-memory id of rule `fileId` from the file of the folder with namespace `folderKey` ('' = primary). */
export function namespaceId(fileId: string, folderKey: string): string {
  return folderKey ? `shared@${folderKey}:${fileId}` : `${SHARED_ID_PREFIX}${fileId}`;
}

/** Splits a shared id into its folder key and file id (`folderKeys` = the known non-primary keys). */
export function splitSharedId(id: string, folderKeys: string[]): { folderKey: string; fileId: string } | undefined {
  if (id.startsWith(SHARED_ID_PREFIX)) return { folderKey: '', fileId: id.slice(SHARED_ID_PREFIX.length) };
  if (id.startsWith('shared@')) {
    // longest key first, so "app" doesn't shadow "app:2"
    for (const key of [...folderKeys].sort((a, b) => b.length - a.length)) {
      const prefix = `shared@${key}:`;
      if (key && id.startsWith(prefix)) return { folderKey: key, fileId: id.slice(prefix.length) };
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ hashing

/** Canonical JSON: keys sorted at every level, no whitespace. Formatting and key order don't change it. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** sha256 of the normalised (canonical JSON) file content: the unit of approval. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ------------------------------------------------------------------ parsing

export interface FileEntry {
  /** The element as written in the file. */
  raw: unknown;
  /** 1-based line where the element starts. */
  line: number;
  /** Validated rule (namespaced id, `shared: true`), when valid. */
  rule?: Rule;
  /** The element's `id` in the file (when a string). */
  fileId?: string;
}

export interface ParsedSharedFile {
  ok: true;
  /** The whole parsed file (top-level object). */
  json: Record<string, unknown>;
  entries: FileEntry[];
  /** Readable problems: invalid rules (skipped), duplicates, unknown version … */
  problems: string[];
  hash: string;
  hadComments: boolean;
  indent: string;
  eol: string;
}

export interface BrokenSharedFile {
  ok: false;
  problem: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A file rule prepared for the host's validator: no `shared`/`used`, defaults filled, namespaced id. */
function prepare(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const r = structuredClone(raw);
  delete r.shared;
  delete r.used;
  r.id = id;
  if (r.enabled === undefined) r.enabled = true;
  const fillBody = (a: unknown) => {
    if (isObj(a) && a.kind === 'mock' && typeof a.bodyFile === 'string' && a.body === undefined) a.body = '';
  };
  fillBody(r.action);
  if (isObj(r.action) && r.action.kind === 'sequence' && Array.isArray(r.action.steps)) {
    for (const s of r.action.steps) if (isObj(s)) fillBody(s.action);
  }
  return r;
}

function detectIndent(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : '  ';
}

/**
 * Parses and validates the file text. `label` names the file in problems (".vscode/flutter-intercept.json").
 * A syntax error, a non-object, a wrong `rules` type or a newer `version` make the whole file broken (the caller
 * keeps the last good rules); invalid rules are only skipped.
 */
export function parseSharedFile(text: string, opts: { label: string; folderKey: string; validateRule: ValidateRule }): ParsedSharedFile | BrokenSharedFile {
  const { label, folderKey, validateRule } = opts;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parsed = parseJsonc(src);
  if (parsed.error !== undefined) return { ok: false, problem: `${label} ${parsed.error}` };
  const json = parsed.value;
  if (!isObj(json)) return { ok: false, problem: `${label}: the file must contain a JSON object like { "version": 1, "rules": [] }` };
  if (json.version !== undefined && json.version !== FILE_VERSION) {
    return {
      ok: false,
      problem:
        typeof json.version === 'number' && json.version > FILE_VERSION
          ? `${label}: written for a newer Flutter Intercept (version ${json.version}); update the extension to use these rules`
          : `${label}: "version" must be ${FILE_VERSION}`,
    };
  }
  if (json.rules !== undefined && !Array.isArray(json.rules)) return { ok: false, problem: `${label}: "rules" must be an array` };
  const rawRules = (json.rules as unknown[] | undefined) ?? [];
  const locate = lineLocator(src);
  const problems: string[] = [];
  const entries: FileEntry[] = [];
  const seen = new Set<string>();
  rawRules.forEach((raw, i) => {
    const offset = parsed.ruleOffsets[i];
    const line = offset === undefined ? 0 : locate(offset).line;
    const at = line ? `${label} line ${line}` : label;
    const entry: FileEntry = { raw, line };
    entries.push(entry);
    if (!isObj(raw)) {
      problems.push(`${at}: rule ${i + 1} must be an object (skipped)`);
      return;
    }
    if (typeof raw.id === 'string') entry.fileId = raw.id;
    const where = `rule ${i + 1}${typeof raw.id === 'string' ? ` "${raw.id.slice(0, 80)}"` : ''}`;
    if (i >= MAX_SHARED_RULES) {
      if (i === MAX_SHARED_RULES) problems.push(`${at}: at most ${MAX_SHARED_RULES} shared rules; the rest are skipped`);
      return;
    }
    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      problems.push(`${at}: ${where} needs an "id" (a stable name such as "login-500") (skipped)`);
      return;
    }
    if (seen.has(raw.id)) {
      problems.push(`${at}: ${where}: duplicate id (skipped)`);
      return;
    }
    seen.add(raw.id);
    try {
      const rule = validateRule(prepare(raw, namespaceId(raw.id, folderKey)), where);
      entry.rule = { ...rule, shared: true };
    } catch (e) {
      problems.push(`${at}: ${(e as Error).message} (skipped)`);
    }
  });
  return {
    ok: true,
    json,
    entries,
    problems,
    hash: contentHash(json),
    hadComments: parsed.hadComments,
    indent: detectIndent(src),
    eol: src.includes('\r\n') ? '\r\n' : '\n',
  };
}

// ------------------------------------------------------------------ serialising

const RULE_KEYS = ['id', 'enabled', 'name', 'match', 'action', 'times'];
const MATCH_KEYS = ['method', 'url', 'graphqlOperation'];

function fileAction(a: unknown): unknown {
  if (!isObj(a)) return a;
  const out: Record<string, unknown> = { kind: a.kind };
  for (const [k, v] of Object.entries(a)) {
    if (k === 'kind' || v === undefined) continue;
    if (k === 'body' && a.kind === 'mock' && typeof a.bodyFile === 'string') continue; // the file is the body
    out[k] = v;
  }
  if (a.kind === 'sequence' && Array.isArray(a.steps)) {
    out.steps = a.steps.map((s) => (isObj(s) ? { ...s, action: fileAction(s.action) } : s));
  }
  return structuredClone(out);
}

/**
 * The rule as it is written to the file: the file id, stable key order, and none of the personal-only fields
 * (`shared`, `used`, `expiresAt` — a wall-clock expiry would be dead for everyone else). A mock with `bodyFile`
 * is written without its resolved `body`.
 */
export function toFileRule(rule: Rule, fileId: string): Record<string, unknown> {
  const src = rule as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of RULE_KEYS) {
    if (k === 'id') out.id = fileId;
    else if (k === 'match') {
      const sm = rule.match as unknown;
      if (!isObj(sm)) {
        if (sm !== undefined) out.match = sm; // invalid: the validator reports it
        continue;
      }
      const m: Record<string, unknown> = {};
      for (const mk of MATCH_KEYS) if (sm[mk] !== undefined && sm[mk] !== '') m[mk] = sm[mk];
      for (const [mk, v] of Object.entries(sm)) if (!MATCH_KEYS.includes(mk) && v !== undefined) m[mk] = v;
      out.match = m;
    } else if (k === 'action') out.action = fileAction(rule.action);
    else if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/**
 * The new file text. `previous` = the current file (its other top-level keys, their order, indentation and line
 * endings are kept), `rules` = the elements of `rules` in order.
 */
export function serializeSharedFile(rules: unknown[], previous?: Pick<ParsedSharedFile, 'json' | 'indent' | 'eol'>): string {
  const out: Record<string, unknown> = {};
  const prev = previous?.json ?? {};
  if (!('version' in prev)) out.version = FILE_VERSION;
  for (const k of Object.keys(prev)) out[k] = k === 'version' ? FILE_VERSION : k === 'rules' ? rules : prev[k];
  if (!('rules' in prev)) out.rules = rules;
  const eol = previous?.eol ?? '\n';
  const text = JSON.stringify(out, null, previous?.indent ?? '  ');
  return `${eol === '\n' ? text : text.replace(/\n/g, eol)}${eol}`;
}
