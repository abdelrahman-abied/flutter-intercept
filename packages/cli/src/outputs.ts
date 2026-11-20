/**
 * Files a run reads and writes: `--replay` (a recording by id or path), `--har`, `--record`, `--junit`. Reuses the
 * extension's HAR builder and recording store / validation (CONTRACTS §8, §12.4).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Exchange, ReplayEntry, ReplayOptions } from '@flutter-intercept/proxy';
import { buildHar } from '../../extension/src/agent/har';
import { MockCollectionsCore } from '../../extension/src/mocks/core';
import { collectionParsers } from '../../extension/src/mocks/parsers';
import type { RulesFs } from '../../extension/src/rules/bodyFile';
import type { FolderCollectionLinks, MementoLike } from '../../extension/src/rules/core';
import { createRecordingService, recordedExchange, serializeRecording, slugify, DEFAULT_MAX_RECORDING_BYTES } from '../../extension/src/recordings/store';
import { replayOptionsFor, toReplay } from '../../extension/src/recordings/replay';
import { validateRecording } from '../../extension/src/recordings/validate';
import type { Recording } from '../../extension/src/recordings/types';

/** True when `value` names a file rather than a recording id / name (has a path separator or ends in .json). */
export function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.json$/i.test(value);
}

/** Writes `text` to `file` (parent directories created), replacing it; mode 0600 for files that may hold secrets. */
export function writeOutput(file: string, text: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // REVIEW-7 #13: an unpredictable temp name created exclusively (never through a planted link); rename replaces a
  // link at `file` itself instead of writing through it.
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode, flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export interface LoadedReplay {
  name: string;
  entries: ReplayEntry[];
  options: ReplayOptions;
}

/** Loads `--replay`: a file path, else a recording id (or name) in the project's recordings. */
export async function loadReplay(value: string, projectRoot: string, cwd: string, fallback: ReplayOptions['fallback']): Promise<LoadedReplay> {
  let rec: Recording;
  const asPath = path.resolve(cwd, value);
  if (looksLikePath(value) || fs.existsSync(asPath)) {
    let data: unknown;
    try {
      const st = fs.statSync(asPath);
      if (!st.isFile()) throw new Error('not a regular file');
      if (st.size > DEFAULT_MAX_RECORDING_BYTES) throw new Error('larger than 200 MB');
      data = JSON.parse(fs.readFileSync(asPath, 'utf8'));
    } catch (e) {
      throw new Error(`recording ${value}: ${(e as Error).message}`);
    }
    const id = slugify(path.basename(asPath, path.extname(asPath))).replace(/^-+|-+$/g, '') || 'recording';
    try {
      rec = validateRecording(data, id, asPath);
    } catch (e) {
      throw new Error(`recording ${value}: ${(e as Error).message}`);
    }
  } else {
    const store = createRecordingService({ root: () => projectRoot });
    const list = await store.list();
    const meta = list.find((m) => m.id === value) ?? list.find((m) => m.name === value) ?? list.find((m) => m.id === slugify(value));
    if (!meta) {
      const known = list.map((m) => m.id).slice(0, 20).join(', ');
      throw new Error(`recording "${value}" not found in .dart_tool/flutter_intercept/recordings${known ? ` (have: ${known})` : ' (none saved yet)'}`);
    }
    rec = await store.load(meta.id);
  }
  const entries = toReplay(rec);
  if (!entries.length) throw new Error(`recording ${value} has no replayable exchanges`);
  return { name: rec.name, entries, options: replayOptionsFor(rec, fallback) };
}

/** `--har`: HAR 1.2 of the run, redacted unless `redact` is false. Returns the number of entries. */
export function writeHarFile(file: string, exchanges: Exchange[], opts: { redact: boolean; version?: string }): number {
  const har = buildHar(exchanges, { redact: opts.redact, ...(opts.version ? { creatorVersion: opts.version } : {}) });
  writeOutput(file, JSON.stringify(har, null, 2) + '\n', opts.redact ? 0o644 : 0o600);
  const log = (har as { log?: { entries?: unknown[] } }).log;
  return Array.isArray(log?.entries) ? log.entries.length : exchanges.length;
}

/**
 * `--record`: a path (ends in .json / has a separator) gets the recording file written there; a name saves it in
 * the project's recordings (listed by the editor, replayable with `--replay <id>`). Unredacted like the editor's
 * default (replay needs the real bodies). Returns where it went and how many exchanges it holds.
 */
export async function writeRecording(value: string, exchanges: Exchange[], projectRoot: string, cwd: string, now = Date.now()): Promise<{ path: string; exchanges: number; id?: string }> {
  const store = createRecordingService({ root: () => projectRoot, now: () => now });
  if (!looksLikePath(value)) {
    const meta = await store.save(value, exchanges, { redact: false });
    return { path: meta.path, exchanges: meta.exchanges, id: meta.id };
  }
  // Same content as the editor writes: saved through the store, exported to the path, the project copy removed.
  const file = path.resolve(cwd, value);
  const meta = await store.save(path.basename(file, path.extname(file)) || 'recording', exchanges, { redact: false });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await store.export(meta.id, file);
  } finally {
    await store.remove(meta.id).catch(() => undefined);
  }
  return { path: file, exchanges: meta.exchanges };
}

/**
 * A redacted copy of the recording file `src` at `dest` (REVIEW-8 #2: what the GitHub Action uploads; the unredacted
 * file stays local). Secrets are redacted like agent views, WebSocket / SSE frames included. Replaying the copy misses
 * requests whose bodies held secrets (their hashes differ). Returns the number of exchanges.
 */
export function writeRedactedRecordingCopy(src: string, dest: string): number {
  const st = fs.statSync(src);
  if (!st.isFile()) throw new Error(`${src} is not a regular file`);
  if (st.size > DEFAULT_MAX_RECORDING_BYTES) throw new Error(`${src} is larger than 200 MB`);
  const id = slugify(path.basename(src, path.extname(src))).replace(/^-+|-+$/g, '') || 'recording';
  const rec = validateRecording(JSON.parse(fs.readFileSync(src, 'utf8')), id, src);
  const entries = rec.redacted ? rec.entries : rec.entries.map((e) => recordedExchange(e, true));
  const text = serializeRecording({ id: rec.id, name: rec.name, createdAt: rec.createdAt, exchanges: entries.length, redacted: true }, entries, DEFAULT_MAX_RECORDING_BYTES);
  writeOutput(dest, text);
  return entries.length;
}

export interface RecordedCollectionOutput {
  path: string;
  endpoints: number;
  examples: number;
  skipped: string[];
  removed: string[];
}

/**
 * CONTRACTS §23.1 / §23.6: builds a Postman v2.1 collection from the run's traffic through the shared
 * `MockCollectionsCore.mockFromTraffic` (`unmatched: 'passthrough'`, personal data replaced) and writes it to
 * `<projectRoot>/.vscode/flutter-intercept/collections/<slug>.json`, never overwriting an existing file (`-2`, `-3`, …).
 */
export async function writeRecordedCollection(
  name: string,
  exchanges: readonly Exchange[],
  projectRoot: string,
  opts: { isThrottleOnlyRule?: (ruleId: string) => boolean } = {},
): Promise<RecordedCollectionOutput> {
  const root = path.resolve(projectRoot);
  const nodeFs: RulesFs = {
    readFile: (p) => fs.promises.readFile(p),
    writeFile: (p, data) => fs.promises.writeFile(p, data, 'utf8'),
    rename: (a, b) => fs.promises.rename(a, b),
    unlink: (p) => fs.promises.unlink(p),
    mkdir: async (p) => {
      await fs.promises.mkdir(p, { recursive: true });
    },
    stat: (p) => fs.promises.stat(p),
    readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
    realpathSync: (p) => fs.realpathSync.native(p),
  };
  const mem = new Map<string, unknown>();
  const memento: MementoLike = {
    get: <T>(key: string) => mem.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      mem.set(key, value);
    },
  };
  let links: FolderCollectionLinks[] = [];
  let rid = 0;
  const core = new MockCollectionsCore({
    links: () => links,
    // CLI writes the collection file only (keeps `.vscode/flutter-intercept.json` untouched during headless runs).
    saveLinks: async (folderPath, next) => {
      links = [{ folderPath, label: path.basename(folderPath), links: next, problems: [] }];
    },
    primaryFolderPath: async () => root,
    writeWorkspaceFile: async (folderPath, rel, text) => {
      const abs = path.join(folderPath, ...rel.split('/'));
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      // REVIEW-15 #8: exclusive create never overwrites an existing file or writes through a planted symlink.
      await fs.promises.writeFile(abs, text, { flag: 'wx', mode: 0o644 });
    },
    workspaceRoots: () => [root],
    fs: nodeFs,
    memento,
    parsers: collectionParsers,
    newRuleId: () => `cli_rec_${++rid}`,
    exchanges: () => exchanges,
    ...(opts.isThrottleOnlyRule ? { isThrottleOnlyRule: opts.isThrottleOnlyRule } : {}),
  });
  const built = await core.mockFromTraffic({
    source: { session: {} },
    name,
    unmatched: 'passthrough',
  });
  return {
    path: path.join(root, ...built.file.split('/')),
    endpoints: built.endpoints,
    examples: built.examples,
    skipped: built.skipped,
    removed: built.removed,
  };
}
