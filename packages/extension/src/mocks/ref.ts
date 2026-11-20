/**
 * Local JSON Pointer (`#/…`) `$ref` resolver, walk budget and safe JSON formatter (CONTRACTS §21.1, §21.3, §21.4).
 * Pure: no vscode, no fs, no network.
 */
import { COLLECTION_LIMITS } from './types';

export type Dict = Record<string, unknown>;

export const MAX_PROBLEM_CHARS = 300;
export const MAX_QUOTED_CHARS = 60;
export const MAX_QUOTED_URL_CHARS = 120;

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
const CONTROL_CHARS = /[\x00-\x1F\x7F\u2028\u2029]+/g;

function stripUrlCredentials(s: string): string {
  let out = '';
  let pos = 0;
  while (pos < s.length) {
    const sep = s.indexOf('://', pos);
    if (sep < 0) {
      out += s.slice(pos);
      break;
    }
    const afterScheme = sep + 3;
    let authEnd = s.length;
    for (const ch of ['/', '?', '#']) {
      const idx = s.indexOf(ch, afterScheme);
      if (idx >= 0 && idx < authEnd) authEnd = idx;
    }
    const authority = s.slice(afterScheme, authEnd);
    const at = authority.lastIndexOf('@');
    out += s.slice(pos, afterScheme);
    out += at >= 0 ? authority.slice(at + 1) : authority;
    // Drop any `?query` component (may hold tokens/keys) up to `#` or control/whitespace.
    let cur = authEnd;
    while (cur < s.length) {
      const ch = s[cur];
      const c = s.charCodeAt(cur);
      if (ch === '#' || c <= 0x20 || c === 0x7f) break;
      if (ch === '?') {
        out += s.slice(authEnd, cur);
        let qEnd = cur + 1;
        while (qEnd < s.length) {
          const qc = s.charCodeAt(qEnd);
          if (s[qEnd] === '#' || qc <= 0x20 || qc === 0x7f) break;
          qEnd += 1;
        }
        authEnd = qEnd;
        cur = qEnd;
        break;
      }
      cur += 1;
    }
    out += s.slice(authEnd, cur);
    pos = cur;
  }
  return out;
}

function isBidiCode(c: number): boolean {
  return (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c === 0x061c;
}

/**
 * Single helper for quoting file-controlled text in problem lines (REVIEW-15 #7):
 * strips URL credentials/queries, removes bidi control chars, flattens CR/LF/tab/controls, and caps length.
 */
export function quoteFileText(raw: string, max: number = MAX_QUOTED_CHARS): string {
  if (raw.includes('://')) {
    const cleaned = stripUrlCredentials(raw.replace(BIDI_CONTROLS, ''))
      .replace(CONTROL_CHARS, ' ')
      .trim();
    if (cleaned.length <= max) return cleaned;
    return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
  }
  // Fast bounded scan so a 300 KB key without `://` costs O(max) work.
  let out = '';
  let truncated = false;
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (isBidiCode(c)) continue;
    if (c <= 0x1f || c === 0x7f || c === 0x2028 || c === 0x2029) {
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      if (out.length >= max) {
        truncated = true;
        break;
      }
      out += ' ';
      pendingSpace = false;
    }
    if (out.length >= max) {
      truncated = true;
      break;
    }
    out += raw[i];
  }
  const trimmed = out.trim();
  if (!truncated && trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/** Appends one sanitised, single-line problem capped at `MAX_PROBLEM_CHARS` (300) (REVIEW-15 #7). */
export function addProblem(problems: string[], message: string): void {
  const clean = message.replace(BIDI_CONTROLS, '').replace(CONTROL_CHARS, ' ').trim();
  problems.push(clean.length <= MAX_PROBLEM_CHARS ? clean : `${clean.slice(0, MAX_PROBLEM_CHARS - 1)}…`);
}

export function isObj(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Null-prototype map so `__proto__` and `constructor` stay plain data keys (§21.1). */
export function dict<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function setProp(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export interface WalkBudget {
  count: number;
  limit: number;
  exceeded: boolean;
}

export function createWalkBudget(limit: number = COLLECTION_LIMITS.walkNodes): WalkBudget {
  return { count: 0, limit, exceeded: false };
}

/** Counts one visited value against `COLLECTION_LIMITS.walkNodes` (§21.3). Returns false once over. */
export function touchNode(budget: WalkBudget, problems: string[], context?: string): boolean {
  if (budget.exceeded) return false;
  budget.count += 1;
  if (budget.count > budget.limit) {
    budget.exceeded = true;
    const prefix = context ? `${context}: ` : '';
    addProblem(problems, `${prefix}document walk exceeded ${budget.limit} values; stopped`);
    return false;
  }
  return true;
}

export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function sliceUtf8Bytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let step = 1;
    let b = 1;
    if (c < 0x80) {
      b = 1;
    } else if (c < 0x800) {
      b = 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        b = 4;
        step = 2;
      } else {
        b = 3;
      }
    } else {
      b = 3;
    }
    if (bytes + b > maxBytes) break;
    bytes += b;
    i += step;
  }
  return s.slice(0, i);
}

/** Resolves a local RFC 6901 JSON Pointer (`#` or `#/…`) inside `root` without touching prototypes. */
export function resolvePointer(root: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === '#') return { found: true, value: root };
  if (!pointer.startsWith('#/')) return { found: false, value: undefined };
  const parts = pointer.slice(2).split('/');
  let cur: unknown = root;
  for (const rawSeg of parts) {
    let decoded = rawSeg;
    if (decoded.includes('%')) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // Keep raw segment if percent-encoding is malformed.
      }
    }
    const key = decoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (key !== '0' && !/^[1-9]\d*$/.test(key)) return { found: false, value: undefined };
      const idx = Number(key);
      if (idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else if (isObj(cur)) {
      if (!hasOwn(cur, key)) return { found: false, value: undefined };
      cur = cur[key];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

export interface DerefResult {
  ok: boolean;
  value: unknown;
  /** The resolved target object in `root` (for schema cycle identity even when siblings exist). */
  targetObj?: Dict;
  /** Number of `$ref` hops followed. */
  hops: number;
}

/**
 * Resolves local `#/…` `$ref` chains (§21.3, §21.4). External refs, non-pointer fragments, broken targets,
 * ref cycles and chains deeper than `maxHops` emit one readable problem and return `ok: false`.
 */
export function deref(
  node: unknown,
  root: unknown,
  budget: WalkBudget,
  problems: string[],
  context?: string,
  maxHops: number = COLLECTION_LIMITS.generateDepth,
): DerefResult {
  if (!touchNode(budget, problems, context)) return { ok: false, value: undefined, hops: 0 };
  if (!isObj(node) || !hasOwn(node, '$ref')) {
    return { ok: true, value: node, targetObj: isObj(node) ? node : undefined, hops: 0 };
  }

  const prefix = context ? `${context}: ` : '';
  const seenRefs = new Set<string>();
  const siblingsList: Dict[] = [];
  let cur: unknown = node;
  let hops = 0;

  while (isObj(cur) && hasOwn(cur, '$ref')) {
    const rawRef = cur['$ref'];
    if (typeof rawRef !== 'string' || rawRef.length === 0) {
      addProblem(problems, `${prefix}invalid $ref (expected non-empty string, skipped)`);
      return { ok: false, value: undefined, hops };
    }
    if (rawRef !== '#' && !rawRef.startsWith('#/')) {
      if (rawRef.startsWith('#')) {
        addProblem(
          problems,
          `${prefix}unsupported local $ref "${quoteFileText(rawRef)}" (only #/… JSON pointers are supported, skipped)`,
        );
      } else {
        addProblem(problems, `${prefix}external $ref "${quoteFileText(rawRef, MAX_QUOTED_URL_CHARS)}" is not followed (skipped)`);
      }
      return { ok: false, value: undefined, hops };
    }
    if (seenRefs.has(rawRef)) {
      addProblem(problems, `${prefix}circular $ref "${quoteFileText(rawRef)}" (skipped)`);
      return { ok: false, value: undefined, hops };
    }
    hops += 1;
    if (hops > maxHops) {
      addProblem(
        problems,
        `${prefix}$ref chain exceeded depth limit (${COLLECTION_LIMITS.generateDepth}) at "${quoteFileText(rawRef)}" (skipped)`,
      );
      return { ok: false, value: undefined, hops };
    }
    seenRefs.add(rawRef);

    const ownKeys = Object.keys(cur);
    if (ownKeys.length > 1) {
      const sib = dict();
      for (const k of ownKeys) {
        if (k !== '$ref') setProp(sib, k, cur[k]);
      }
      siblingsList.push(sib);
    }

    const hit = resolvePointer(root, rawRef);
    if (!hit.found) {
      addProblem(problems, `${prefix}unresolved $ref "${quoteFileText(rawRef)}" (skipped)`);
      return { ok: false, value: undefined, hops };
    }
    if (!touchNode(budget, problems, context)) return { ok: false, value: undefined, hops };
    cur = hit.value;
  }

  if (siblingsList.length === 0) {
    return { ok: true, value: cur, targetObj: isObj(cur) ? cur : undefined, hops };
  }
  if (!isObj(cur)) {
    return { ok: true, value: cur, hops };
  }
  const merged = dict();
  for (const k of Object.keys(cur)) setProp(merged, k, cur[k]);
  for (let i = siblingsList.length - 1; i >= 0; i--) {
    const sib = siblingsList[i];
    for (const k of Object.keys(sib)) setProp(merged, k, sib[k]);
  }
  return { ok: true, value: merged, targetObj: cur, hops };
}

/**
 * Byte-capped, walk-capped, cycle-safe JSON writer with 2-space indentation (§21.3, §21.4).
 * When `maxBytes` would be passed, cuts cleanly at the property/element boundary and records one problem
 * (unless `silentOnCut` is set so the caller can skip oversized explicit examples instead).
 */
export class JsonWriter {
  readonly chunks: string[] = [];
  usedBytes = 0;
  reservedClosing = 0;
  cut = false;
  private reportedCut = false;

  constructor(
    readonly maxBytes: number,
    readonly budget: WalkBudget,
    readonly problems: string[],
    readonly context?: string,
    readonly silentOnCut = false,
  ) {}

  get stopped(): boolean {
    return this.cut || this.budget.exceeded;
  }

  markCut(): void {
    this.cut = true;
    if (!this.reportedCut && !this.silentOnCut) {
      this.reportedCut = true;
      const prefix = this.context ? `${this.context}: ` : '';
      const kb = Math.round(this.maxBytes / 1024);
      addProblem(this.problems, `${prefix}output exceeded ${kb} KB limit; truncated`);
    }
  }

  pushRaw(s: string): void {
    this.chunks.push(s);
    this.usedBytes += utf8Bytes(s);
  }

  canFit(extraBytes: number): boolean {
    return this.usedBytes + extraBytes + this.reservedClosing <= this.maxBytes;
  }

  checkpoint(): { len: number; bytes: number; closing: number } {
    return { len: this.chunks.length, bytes: this.usedBytes, closing: this.reservedClosing };
  }

  rollback(cp: { len: number; bytes: number; closing: number }): void {
    this.chunks.length = cp.len;
    this.usedBytes = cp.bytes;
    this.reservedClosing = cp.closing;
  }

  text(): string {
    return this.chunks.join('');
  }
}

export function indentStr(depth: number): string {
  return '  '.repeat(depth);
}

/** Cuts a plain JS string so its `JSON.stringify` form fits within `maxBytes` UTF-8 bytes. */
export function fitJsonString(s: string, maxBytes: number): string {
  if (maxBytes < 2) return '""';
  const full = JSON.stringify(s);
  if (utf8Bytes(full) <= maxBytes) return full;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    let slice = s.slice(0, mid);
    // Avoid ending on an unpaired high surrogate.
    const last = slice.charCodeAt(slice.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      slice = slice.slice(0, -1);
    }
    if (utf8Bytes(JSON.stringify(slice)) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let res = s.slice(0, lo);
  if (res.length > 0) {
    const last = res.charCodeAt(res.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) res = res.slice(0, -1);
  }
  return JSON.stringify(res);
}

const MAX_VALUE_DEPTH = 256;

/** Writes any JS value as 2-space indented JSON into `writer`, respecting walk, cycle and size limits. */
export function writeAnyJson(
  value: unknown,
  depth: number,
  writer: JsonWriter,
  ancestors: Set<object>,
): boolean {
  if (writer.stopped) return false;
  if (!touchNode(writer.budget, writer.problems, writer.context)) return false;

  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    const lit = value === null ? 'null' : typeof value === 'boolean' ? (value ? 'true' : 'false') : Number.isFinite(value) ? String(value) : 'null';
    const b = utf8Bytes(lit);
    if (!writer.canFit(b)) {
      writer.markCut();
      return false;
    }
    writer.pushRaw(lit);
    return true;
  }

  if (typeof value === 'string') {
    const lit = JSON.stringify(value);
    const b = utf8Bytes(lit);
    if (!writer.canFit(b)) {
      if (depth === 0 && !writer.silentOnCut) {
        writer.markCut();
        writer.pushRaw(fitJsonString(value, writer.maxBytes));
        return true;
      }
      writer.markCut();
      return false;
    }
    writer.pushRaw(lit);
    return true;
  }

  if (typeof value !== 'object') {
    const lit = 'null';
    if (!writer.canFit(4)) {
      writer.markCut();
      return false;
    }
    writer.pushRaw(lit);
    return true;
  }

  if (ancestors.has(value)) {
    const lit = 'null';
    if (!writer.canFit(4)) {
      writer.markCut();
      return false;
    }
    writer.pushRaw(lit);
    return true;
  }

  if (depth >= MAX_VALUE_DEPTH) {
    const lit = Array.isArray(value) ? '[]' : '{}';
    if (!writer.canFit(2)) {
      writer.markCut();
      return false;
    }
    writer.pushRaw(lit);
    return true;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return writeArrayContainer(value.length, (i) => value[i], depth, writer, ancestors);
    }
    const entries: [string, unknown][] = [];
    for (const k of Object.keys(value)) {
      const v = (value as Dict)[k];
      if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
        entries.push([k, v]);
      }
    }
    return writeObjectContainer(entries, depth, writer, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function writeArrayContainer(
  length: number,
  getItem: (i: number) => unknown,
  depth: number,
  writer: JsonWriter,
  ancestors: Set<object>,
): boolean {
  if (!writer.canFit(2)) {
    writer.markCut();
    return false;
  }
  if (length === 0) {
    writer.pushRaw('[]');
    return true;
  }
  const outerCp = writer.checkpoint();
  writer.pushRaw('[');
  writer.reservedClosing += 1;
  let added = 0;

  for (let i = 0; i < length; i++) {
    const cp = writer.checkpoint();
    const prefix = added === 0 ? `\n${indentStr(depth + 1)}` : `,\n${indentStr(depth + 1)}`;
    const closingExtra = added === 0 ? 1 + depth * 2 : 0;
    writer.reservedClosing += closingExtra;
    const prefixBytes = utf8Bytes(prefix);
    if (!writer.canFit(prefixBytes)) {
      writer.rollback(cp);
      writer.markCut();
      break;
    }
    writer.pushRaw(prefix);
    const ok = writeAnyJson(getItem(i), depth + 1, writer, ancestors);
    if (!ok && writer.chunks.length === cp.len + 1) {
      // Child wrote nothing before failing/cutting -> roll back this element prefix.
      writer.rollback(cp);
      break;
    }
    added += 1;
    if (writer.stopped) break;
  }

  if (added === 0) {
    writer.rollback(outerCp);
    if (!writer.canFit(2)) {
      writer.markCut();
      return false;
    }
    writer.pushRaw('[]');
    return true;
  }
  writer.reservedClosing -= 2 + depth * 2;
  writer.pushRaw(`\n${indentStr(depth)}]`);
  return true;
}

function writeObjectContainer(
  entries: [string, unknown][],
  depth: number,
  writer: JsonWriter,
  ancestors: Set<object>,
): boolean {
  if (!writer.canFit(2)) {
    writer.markCut();
    return false;
  }
  if (entries.length === 0) {
    writer.pushRaw('{}');
    return true;
  }
  const outerCp = writer.checkpoint();
  writer.pushRaw('{');
  writer.reservedClosing += 1;
  let added = 0;

  for (const [k, v] of entries) {
    const cp = writer.checkpoint();
    const keyPart = `${JSON.stringify(k)}: `;
    const prefix = added === 0 ? `\n${indentStr(depth + 1)}${keyPart}` : `,\n${indentStr(depth + 1)}${keyPart}`;
    const closingExtra = added === 0 ? 1 + depth * 2 : 0;
    writer.reservedClosing += closingExtra;
    const prefixBytes = utf8Bytes(prefix);
    if (!writer.canFit(prefixBytes)) {
      writer.rollback(cp);
      writer.markCut();
      break;
    }
    writer.pushRaw(prefix);
    const ok = writeAnyJson(v, depth + 1, writer, ancestors);
    if (!ok && writer.chunks.length === cp.len + 1) {
      writer.rollback(cp);
      break;
    }
    added += 1;
    if (writer.stopped) break;
  }

  if (added === 0) {
    writer.rollback(outerCp);
    if (!writer.canFit(2)) {
      writer.markCut();
      return false;
    }
    writer.pushRaw('{}');
    return true;
  }
  writer.reservedClosing -= 2 + depth * 2;
  writer.pushRaw(`\n${indentStr(depth)}}`);
  return true;
}

export function formatJsonChecked(
  value: unknown,
  maxBytes: number,
  budget: WalkBudget,
  problems: string[],
  context?: string,
): { text: string; cut: boolean } {
  const writer = new JsonWriter(maxBytes, budget, problems, context, true);
  const ok = writeAnyJson(value, 0, writer, new Set());
  if (writer.cut) return { text: '', cut: true };
  if (!ok && writer.chunks.length === 0) return { text: 'null', cut: false };
  return { text: writer.text(), cut: false };
}

export function formatJsonValue(
  value: unknown,
  maxBytes: number,
  budget: WalkBudget,
  problems: string[],
  context?: string,
): string {
  const writer = new JsonWriter(maxBytes, budget, problems, context);
  const ok = writeAnyJson(value, 0, writer, new Set());
  if (!ok && writer.chunks.length === 0) {
    return 'null';
  }
  return writer.text();
}
