/**
 * RecordingService (CONTRACTS §12.4, §14.5): finished HTTP, WebSocket and SSE exchanges saved to
 * `<project>/.dart_tool/flutter_intercept/recordings/<id>.json`, listed, loaded, removed, exported. No `vscode`;
 * the file system is injected (defaults to node's).
 *
 * File format (JSON, version 1 — or 2 when it holds WebSocket / SSE exchanges, see validate.ts). The first line holds the metadata so `list()` reads only the head of each file:
 *
 *     {"version":1,"id":"login-flow","name":"Login flow","createdAt":1760000000000,"exchanges":2,"redacted":false,
 *     "entries":[
 *     {...exchange...},
 *     {...exchange...}
 *     ]}
 *
 * Files hold real bodies unless saved with `redact: true` (replay needs them), so they are written with mode 0600
 * (directory 0700), atomically (temp file + rename), and refused beyond `maxBytes` (default 200 MB). Loading never
 * trusts the file: see validate.ts. A file that was reformatted by hand still loads (list falls back to a full read).
 */
import * as nodeFs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { Exchange, ReplayOptions } from '@flutter-intercept/proxy';
import { redactExchange } from '../agent/samples';
import { capFrames, copyFrame, redactFrame } from './frames';
import { diff, diffText } from './diff';
import { gitIgnoreStatus, type GitignoreFs } from './gitignore';
import { replayOptionsFor, toReplay } from './replay';
import type { Recording, RecordingDiffEntry, RecordingMeta, RecordingService } from './types';
import { isValidId, MAX_ENTRIES, recordingVersionFor, RecordingFormatError, SUPPORTED_RECORDING_VERSIONS, validateRecording, validEntry, validName } from './validate';

export const RECORDINGS_DIR = path.join('.dart_tool', 'flutter_intercept', 'recordings');
export const DEFAULT_MAX_RECORDING_BYTES = 200 * 1024 * 1024;
const HEAD_BYTES = 8192;

/** The file operations the store needs (node's `fs.promises` plus a head read). */
export interface RecordingFs {
  /** Creates ONE directory (not recursive; fails if it exists). */
  mkdir(p: string, opts: { mode?: number }): Promise<unknown>;
  readdir(p: string): Promise<string[]>;
  lstat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs?: number }>;
  realpath(p: string): Promise<string>;
  readFile(p: string): Promise<string>;
  /** At most `maxBytes` from the start of the file (UTF-8; a cut multi-byte character may be mangled). */
  readHead(p: string, maxBytes: number): Promise<string>;
  /** Creates a new file (fails if it exists) with the given mode. */
  writeNew(p: string, data: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
}

export const nodeRecordingFs: RecordingFs = {
  mkdir: (p, opts) => nodeFs.promises.mkdir(p, { mode: opts.mode }),
  readdir: (p) => nodeFs.promises.readdir(p),
  lstat: (p) => nodeFs.promises.lstat(p),
  realpath: (p) => nodeFs.promises.realpath(p),
  readFile: (p) => nodeFs.promises.readFile(p, 'utf8'),
  async readHead(p, maxBytes) {
    const fh = await nodeFs.promises.open(p, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  },
  async writeNew(p, data, mode) {
    await nodeFs.promises.writeFile(p, data, { encoding: 'utf8', mode, flag: 'wx' });
  },
  rename: (a, b) => nodeFs.promises.rename(a, b),
  unlink: (p) => nodeFs.promises.unlink(p),
};

export interface RecordingServiceDeps {
  /** The Flutter project root (recordings go under its `.dart_tool`); undefined = no project open. */
  root(): string | undefined;
  fs?: RecordingFs;
  now?: () => number;
  /** Largest recording file written or read (bytes). Default 200 MB. */
  maxBytes?: number;
}

/** RecordingService plus `export` (copy to a user-chosen path) and the directory it uses. */
export interface RecordingStore extends RecordingService {
  /**
   * Writes recording `id` to the absolute path `dest` (a new file, mode 0600; replaced if it exists). `redact`
   * writes a redacted copy (for sharing) unless it already is. Returns `dest`.
   */
  export(id: string, dest: string, opts?: { redact?: boolean }): Promise<string>;
  /** `<root>/.dart_tool/flutter_intercept/recordings`, or undefined without a project. */
  dir(): string | undefined;
  /** `ReplayOptions` carrying the recording's `name` (for `setReplay`); `matchTemplates` default true. */
  replayOptions(rec: Recording, fallback: ReplayOptions['fallback'], matchTemplates?: boolean): ReplayOptions;
}

export class RecordingError extends Error {
  readonly name = 'RecordingError';
}

/**
 * Finished exchanges from the app a recording keeps: plain HTTP, WebSocket (cleanly closed upgrade, status 101) and
 * SSE (CONTRACTS §14.5) — not tunnels, vm-profile captures, browser-internal, unfinished or failed ones.
 */
export function isRecordable(e: Exchange): boolean {
  if (e.kind && e.kind !== 'websocket' && e.kind !== 'sse') return false;
  if (e.kind === 'websocket' && e.status !== 101) return false;
  return (
    e.captured !== 'vm-profile' &&
    !e.browserInternal &&
    (e.state === 'completed' || e.state === 'mocked') &&
    Number.isInteger(e.status)
  );
}

/** A file-name safe slug of `name` (≤ 60 chars), `recording` when nothing is left. */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'recording';
}

/**
 * The fields a recording keeps (no stack traces, pause state, errors, LAN marks); WebSocket / SSE frames within the
 * proxy's caps. `redact`: secrets redacted like agent views, frames included (CONTRACTS §14.5).
 */
export function recordedExchange(e: Exchange, redact = false): Exchange {
  const src = redact ? redactExchange(e) : e;
  const out = pick(src);
  if (e.kind === 'websocket' || e.kind === 'sse') {
    out.kind = e.kind;
    const frames = (e.frames ?? []).map(redact ? redactFrame : copyFrame);
    const capped = capFrames(frames, e.framesDropped ?? 0);
    out.frames = capped.frames;
    if (capped.dropped) out.framesDropped = capped.dropped;
    // SSE keeps no response body (the events are the record); WebSocket has none
    delete out.responseBody;
    if (e.kind === 'websocket') delete out.requestBody;
  }
  return out;
}

function pick(e: Exchange): Exchange {
  return {
    id: e.id,
    startedAt: e.startedAt,
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    method: e.method,
    url: e.url,
    requestHeaders: e.requestHeaders ?? {},
    ...(e.requestBody ? { requestBody: e.requestBody } : {}),
    status: e.status,
    responseHeaders: e.responseHeaders ?? {},
    ...(e.responseBody ? { responseBody: e.responseBody } : {}),
    state: e.state,
    ...(e.matchedRuleId ? { matchedRuleId: e.matchedRuleId } : {}),
    ...(e.simulated ? { simulated: e.simulated } : {}),
    ...(e.initiator ? { initiator: e.initiator } : {}),
    ...(e.graphql ? { graphql: e.graphql } : {}),
  };
}

/** CONTRACTS §14.5 `RecordingMeta.streams` / `frames`: WebSocket / SSE exchanges and their frames; {} when none. */
export function streamCounts(entries: readonly Exchange[]): { streams?: number; frames?: number } {
  let streams = 0;
  let frames = 0;
  for (const e of entries) {
    if (e.kind !== 'websocket' && e.kind !== 'sse') continue;
    streams++;
    frames += e.frames?.length ?? 0;
  }
  return streams ? { streams, frames } : {};
}

const mb = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.ceil(n / 1024)} KB`);

/** The file text (metadata on line 1; `streams` / `frames` only when it holds WebSocket / SSE exchanges). Throws RecordingError beyond `maxBytes`. */
export function serializeRecording(meta: Omit<RecordingMeta, 'path'>, entries: Exchange[], maxBytes: number): string {
  const head = JSON.stringify({
    version: recordingVersionFor(entries),
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    exchanges: entries.length,
    redacted: meta.redacted,
    ...streamCounts(entries),
  });
  const parts = [`${head.slice(0, -1)},\n"entries":[\n`];
  let size = Buffer.byteLength(parts[0]);
  entries.forEach((e, i) => {
    const line = JSON.stringify(e) + (i < entries.length - 1 ? ',\n' : '\n');
    size += Buffer.byteLength(line);
    if (size > maxBytes) {
      throw new RecordingError(`Recording too large: more than ${mb(maxBytes)}. Save fewer exchanges (filter by URL or a shorter time range).`);
    }
    parts.push(line);
  });
  parts.push(']}\n');
  return parts.join('');
}

/** Metadata from a file's first line, or undefined when the head isn't in the expected form. */
export function parseHead(head: string): Omit<RecordingMeta, 'id' | 'path'> | undefined {
  const nl = head.indexOf('\n');
  if (nl <= 0) return undefined;
  const line = head.slice(0, nl).trimEnd();
  if (!line.endsWith(',')) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(`${line.slice(0, -1)}}`);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (!SUPPORTED_RECORDING_VERSIONS.includes(d.version as number) || typeof d.redacted !== 'boolean') return undefined;
  if (typeof d.createdAt !== 'number' || !Number.isFinite(d.createdAt) || d.createdAt < 0) return undefined;
  if (!Number.isInteger(d.exchanges) || (d.exchanges as number) < 0 || (d.exchanges as number) > MAX_ENTRIES) return undefined;
  let name: string;
  try {
    name = validName(d.name);
  } catch {
    return undefined;
  }
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (d.streams !== undefined && (!count(d.streams) || (d.streams as number) > (d.exchanges as number))) return undefined;
  if (d.frames !== undefined && !count(d.frames)) return undefined;
  return {
    name,
    createdAt: d.createdAt,
    exchanges: d.exchanges as number,
    redacted: d.redacted,
    ...(d.streams ? { streams: d.streams as number, frames: (d.frames as number | undefined) ?? 0 } : {}),
  };
}

const isNotFound = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const CACHE_MAX_BYTES = 50 * 1024 * 1024;
const CACHE_ENTRIES = 2;

export function createRecordingService(deps: RecordingServiceDeps): RecordingStore {
  const fs = deps.fs ?? nodeRecordingFs;
  const now = deps.now ?? Date.now;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_RECORDING_BYTES;
  const components = RECORDINGS_DIR.split(path.sep);

  const lstatOrUndefined = async (p: string) => {
    try {
      return await fs.lstat(p);
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  };
  const gitFs: GitignoreFs = {
    async kind(p) {
      const st = await lstatOrUndefined(p);
      if (!st) return undefined;
      return st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
    },
    readFile: (p) => fs.readFile(p),
  };

  const dir = (): string | undefined => {
    const root = deps.root();
    return root ? path.join(root, RECORDINGS_DIR) : undefined;
  };

  /**
   * REVIEW-6 #9: the real recordings directory, checked component by component: no symlinks, only directories, and
   * its real path is `<realpath(root)>/.dart_tool/flutter_intercept/recordings`. Missing components are created
   * one by one (`create`), or the result is undefined.
   */
  async function safeDir(create: boolean): Promise<string | undefined> {
    const root = deps.root();
    if (!root) throw new RecordingError('No Flutter project is open: recordings are saved in the project.');
    let rootReal: string;
    try {
      rootReal = await fs.realpath(root);
    } catch (e) {
      if (isNotFound(e)) throw new RecordingError(`The project folder ${root} does not exist.`);
      throw e;
    }
    let cur = rootReal;
    for (let i = 0; i < components.length; i++) {
      const p = path.join(cur, components[i]);
      const rel = components.slice(0, i + 1).join('/');
      let st = await lstatOrUndefined(p);
      if (!st) {
        if (!create) return undefined;
        try {
          // `.dart_tool` with the default mode (Flutter's own folder); ours private
          await fs.mkdir(p, i === 0 ? {} : { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
        }
        st = await lstatOrUndefined(p);
        if (!st) throw new RecordingError(`Could not create ${rel}.`);
      }
      if (st.isSymbolicLink()) {
        throw new RecordingError(`Refusing to use ${rel}: it is a symbolic link, and recordings (which may hold tokens) must stay inside the project.`);
      }
      if (!st.isDirectory()) throw new RecordingError(`Refusing to use ${rel}: it is not a folder.`);
      cur = p;
    }
    const real = await fs.realpath(cur);
    if (real !== path.join(rootReal, RECORDINGS_DIR)) throw new RecordingError(`Refusing to use ${components.join('/')}: it resolves outside the project.`);
    return real;
  }

  const fileOf = (d: string, id: string): string => {
    if (!isValidId(id)) throw new RecordingError(`Unknown recording ${JSON.stringify(String(id).slice(0, 80))}.`);
    return path.join(d, `${id}.json`);
  };

  /** Writes `text` to `file` via a temp file in the same directory and a rename. */
  async function atomicWrite(file: string, text: string): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeNew(tmp, text, 0o600);
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async function regularFile(file: string): Promise<{ size: number; mtimeMs?: number } | undefined> {
    const st = await lstatOrUndefined(file);
    return st && st.isFile() && !st.isSymbolicLink() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined;
  }

  // REVIEW-6 #12: agents may diff the same recordings repeatedly — keep the last few loads (small files only).
  const cache = new Map<string, { size: number; mtimeMs: number; rec: Recording }>();
  const diffCache = new WeakMap<Recording, WeakMap<Recording, RecordingDiffEntry[]>>();

  async function readRecording(file: string, id: string): Promise<Recording> {
    const st = await regularFile(file);
    if (!st) throw new RecordingError(`Recording "${id}" not found.`);
    if (st.size > maxBytes) throw new RecordingError(`Recording "${id}" is too large (${mb(st.size)}; the limit is ${mb(maxBytes)}).`);
    const hit = cache.get(file);
    if (hit && st.mtimeMs !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.rec;
    const text = await fs.readFile(file);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new RecordingError(`Recording "${id}" is not valid JSON.`);
    }
    let rec: Recording;
    try {
      rec = validateRecording(data, id, file);
    } catch (e) {
      if (e instanceof RecordingFormatError) throw new RecordingError(`Recording "${id}" is invalid: ${e.message}.`);
      throw e;
    }
    cache.delete(file);
    if (st.mtimeMs !== undefined && st.size <= CACHE_MAX_BYTES) {
      cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, rec });
      while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    }
    return rec;
  }

  async function uniqueId(d: string, base: string): Promise<string> {
    const existing = new Set(await fs.readdir(d));
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base.slice(0, 70)}-${n}`;
      if (!existing.has(`${id}.json`)) return id;
    }
  }

  const notIgnored = (where: string, hint: string) =>
    new RecordingError(
      `Not saved: ${where} is not ignored by git, so an unredacted recording (real tokens and response bodies) could be committed. ${hint}`,
    );

  const store: RecordingStore = {
    dir,

    async list() {
      let d: string | undefined;
      try {
        d = await safeDir(false);
      } catch {
        return []; // no project, or an unsafe layout (save / load explain why)
      }
      if (!d) return [];
      let names: string[];
      try {
        names = await fs.readdir(d);
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
      const out: RecordingMeta[] = [];
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        const id = n.slice(0, -5);
        if (!isValidId(id)) continue;
        const file = path.join(d, n);
        try {
          const st = await regularFile(file);
          if (!st) continue;
          const head = parseHead(await fs.readHead(file, HEAD_BYTES));
          if (head) {
            out.push({ id, path: file, ...head });
            continue;
          }
          // Reformatted by hand: read and validate the whole file.
          const rec = await readRecording(file, id);
          out.push({ id, name: rec.name, createdAt: rec.createdAt, exchanges: rec.exchanges, path: file, redacted: rec.redacted, ...streamCounts(rec.entries) });
        } catch {
          // unreadable or invalid: not listed (load() reports why)
        }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    },

    async save(name, exchanges, opts) {
      if (!deps.root()) throw new RecordingError('No Flutter project is open: recordings are saved in the project.');
      let checkedName: string;
      try {
        checkedName = validName(typeof name === 'string' ? name.trim() : name);
      } catch (e) {
        throw new RecordingError(`Recording ${(e as Error).message}.`);
      }
      const redacted = opts?.redact === true;
      const entries: Exchange[] = [];
      for (const e of exchanges) {
        if (!isRecordable(e)) continue;
        const kept = recordedExchange(e, redacted);
        try {
          entries.push(validEntry(JSON.parse(JSON.stringify(kept)), 'entry'));
        } catch {
          // something load() would refuse (e.g. a non-http URL): left out
        }
      }
      if (!entries.length) throw new RecordingError('Nothing to save: no finished HTTP, WebSocket or SSE exchanges (open streams, failed requests and native-client traffic are not recorded).');
      if (entries.length > MAX_ENTRIES) throw new RecordingError(`Too many exchanges (${entries.length}; the limit is ${MAX_ENTRIES}).`);
      entries.sort((a, b) => a.startedAt - b.startedAt);
      const meta: Omit<RecordingMeta, 'path'> = { id: '', name: checkedName, createdAt: now(), exchanges: entries.length, redacted, ...streamCounts(entries) };
      const d = (await safeDir(true))!;
      meta.id = await uniqueId(d, slugify(checkedName));
      const file = fileOf(d, meta.id);
      const text = serializeRecording(meta, entries, maxBytes);
      if (!redacted && (await gitIgnoreStatus(file, gitFs)) === 'not-ignored') {
        throw notIgnored(components.join('/'), 'Save it redacted, or add ".dart_tool/" to the project\'s .gitignore (Flutter\'s default).');
      }
      await atomicWrite(file, text);
      cache.delete(file);
      return { ...meta, path: file };
    },

    async load(id) {
      fileOf('', id); // the id first: never touch the file system for a bad one
      const d = await safeDir(false);
      if (!d) throw new RecordingError(`Recording "${id}" not found.`);
      return readRecording(fileOf(d, id), id);
    },

    async remove(id) {
      fileOf('', id);
      const d = await safeDir(false);
      if (!d) return;
      const file = fileOf(d, id);
      cache.delete(file);
      const st = await lstatOrUndefined(file);
      if (!st) return;
      if (!st.isFile() && !st.isSymbolicLink()) throw new RecordingError(`Recording "${id}" is not a file.`);
      await fs.unlink(file);
    },

    async export(id, dest, opts) {
      if (typeof dest !== 'string' || !path.isAbsolute(dest)) throw new RecordingError('Export path must be absolute.');
      const rec = await store.load(id);
      const redact = opts?.redact === true && !rec.redacted;
      // REVIEW-6 #9: write into the real parent folder; never through a symlink at the destination
      let parent: string;
      try {
        parent = await fs.realpath(path.dirname(dest));
      } catch (e) {
        if (isNotFound(e)) throw new RecordingError(`Export folder ${path.dirname(dest)} does not exist.`);
        throw e;
      }
      if (!(await fs.lstat(parent)).isDirectory()) throw new RecordingError(`${path.dirname(dest)} is not a folder.`);
      const target = path.join(parent, path.basename(dest));
      const existing = await lstatOrUndefined(target);
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new RecordingError(`Refusing to overwrite ${dest}: it is not a regular file.`);
      if (!(rec.redacted || redact) && (await gitIgnoreStatus(target, gitFs)) === 'not-ignored') {
        throw notIgnored(dest, 'Export it redacted, or choose a folder outside the repository.');
      }
      const entries = redact ? rec.entries.map((e) => recordedExchange(e, true)) : rec.entries;
      const text = serializeRecording({ id: rec.id, name: rec.name, createdAt: rec.createdAt, exchanges: entries.length, redacted: rec.redacted || redact }, entries, maxBytes);
      await atomicWrite(target, text);
      return target;
    },

    toReplay,
    replayOptions: replayOptionsFor,
    diff(a, b) {
      let inner = diffCache.get(a);
      let d = inner?.get(b);
      if (!d) {
        d = diff(a, b);
        if (!inner) diffCache.set(a, (inner = new WeakMap()));
        inner.set(b, d);
      }
      return d.map((x) => ({ ...x }));
    },
    diffText,
  };
  return store;
}
