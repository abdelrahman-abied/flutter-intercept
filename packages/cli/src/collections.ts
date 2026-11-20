/**
 * Collections for a headless CLI run (CONTRACTS §21.11, §22.11, §24): runs the host's own `MockCollectionsCore`
 * headless over the shared rules file's collections (skipped under `--no-rules`) plus any `--collection <file>`
 * arguments, so every format (Postman, OpenAPI 3, Swagger 2.0, Insomnia v4/v5, Bruno `bruno.json`) and the full
 * answer pipeline (auth gate → query example → body example → store → default example → dynamic values) behave
 * identically to the IDE.
 *
 * Environment and variable values resolve URL variables only and never appear in problems or logs.
 */
import * as path from 'path';
import type { RequestHandler, Rule } from '@flutter-intercept/proxy';
import { compileMatcher } from '@flutter-intercept/proxy/rules';
import { checkWorkspaceFile, decodeWorkspaceFile, type RulesFs, type WorkspaceFileSpec } from '../../extension/src/rules/bodyFile';
import type { FolderCollectionLinks, MementoLike } from '../../extension/src/rules/core';
import { MAX_PROBLEMS, MockCollectionsCore, NOT_A_COLLECTION, parseJsonText, slugId } from '../../extension/src/mocks/core';
import { isBrunoLinkFile, type StoreSettingsLink } from '../../extension/src/mocks/link';
import { collectionParsers } from '../../extension/src/mocks/parsers';
import { parseSnapshot } from '../../extension/src/mocks/snapshot';
import {
  COLLECTION_LIMITS,
  COLLECTION_RULE_PREFIX,
  SNAPSHOT_NAME,
  SNAPSHOTS_DIR,
  STORE_LIMITS,
  type CollectionFormat,
  type CollectionLink,
} from '../../extension/src/mocks/types';
import { isYamlFile, parseYaml } from '../../extension/src/mocks/yaml';
import { readOnlyRulesFs } from './rules';
import { storeHandlerId, tally, type CollectionStore, type StoreChanges } from './stores';

const COLLECTION_FILE_SPEC: WorkspaceFileSpec = { what: 'collection file', maxBytes: COLLECTION_LIMITS.fileBytes, maxLabel: '20 MB' };
const ENVIRONMENT_FILE_SPEC: WorkspaceFileSpec = { what: 'environment file', maxBytes: 5 * 1024 * 1024, maxLabel: '5 MB' };
const SNAPSHOT_FILE_SPEC: WorkspaceFileSpec = { what: 'snapshot', maxBytes: STORE_LIMITS.snapshotBytes, maxLabel: '32 MB' };

/** CONTRACTS §22.11: stateful mocks in a headless run. */
export interface CollectionStoreOptions {
  /** `--collection-snapshot`: a snapshot name (looked up for every collection) or a snapshot file path. */
  snapshot?: string;
  /** The folder whose `.vscode/flutter-intercept/snapshots/` holds the snapshots of `--collection` files. */
  folder: string;
}

export interface LoadCollectionsOptions {
  /** Links from the shared rules file (omitted when `--no-rules` or no file). */
  sharedLinks?: FolderCollectionLinks[];
  /** CLI `--collection <file>` paths (resolved against `cwd`, in order). */
  files?: string[];
  /** CLI `--collection-env`: Postman environment file, or environment name for Insomnia / Bruno (CONTRACTS §24.4). */
  envFile?: string;
  /** CLI `--collection-var name=value` overrides. */
  vars?: Readonly<Record<string, string>>;
  /** CLI `--collection-unmatched passthrough|fail` override. */
  unmatched?: 'passthrough' | 'fail';
  /** CONTRACTS §22.11: resources remember what the app sends. Absent (`--no-collection-store`) → 0.15 behaviour. */
  store?: CollectionStoreOptions;
  /** CONTRACTS §24.3: `--collection-seed <n>` (default 1 in seeded mode). */
  seed?: number;
  /** CONTRACTS §24.3: `--collection-dynamic random|seeded|fixed` (CLI default: `'seeded'`). */
  dynamic?: 'random' | 'seeded' | 'fixed';
  /** CONTRACTS §24.1: `--collection-auth`: turn sign-in simulation on for collections with a login request. */
  auth?: boolean;
  /** CONTRACTS §24.1: `--collection-auth-ttl <60-86400>`: sign-in session TTL in seconds. */
  authTtl?: number;
  /** CONTRACTS §24.1 / §24.3: injected clock (ms since epoch) for deterministic tests. */
  now?: () => number;
  cwd: string;
  fs?: RulesFs;
}

export interface LoadedCollectionSummary {
  id: string;
  name: string;
  file: string;
  format?: CollectionFormat;
  unmatched: 'passthrough' | 'fail';
  endpoints: number;
  mocked: number;
  noExample: number;
  unresolved: string[];
  /** CONTRACTS §24.1: true when sign-in simulation is active for this collection. */
  auth: boolean;
  /** CONTRACTS §24.1: active sign-in session count for this collection. */
  sessions(): number;
}

export interface LoadedCollectionAuth {
  id: string;
  name: string;
  sessions(): number;
}

export interface LoadedCollections {
  /** Mock, handler and unmatched-fail block rules of every active collection, in order (CONTRACTS §21.5, §24). */
  rules: Rule[];
  collections: LoadedCollectionSummary[];
  /** One line per problem (parse issues, invalid links, loose globs, …). */
  problems: string[];
  /** CONTRACTS §22.11: one store per collection with remembered resources. */
  stores: CollectionStore[];
  /** CONTRACTS §22.1 / §24: every proxy handler registered by the core (store, auth, body match, dynamic values). */
  handlers: Map<string, RequestHandler>;
  /** CONTRACTS §24.1: collections with sign-in simulation on and their live session counts. */
  auth: LoadedCollectionAuth[];
}

class MemoryMemento implements MementoLike {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function capProblems(list: string[]): string[] {
  const unique = [...new Set(list)];
  if (unique.length <= MAX_PROBLEMS) return unique;
  return [...unique.slice(0, MAX_PROBLEMS - 1), `… and ${unique.length - (MAX_PROBLEMS - 1)} more problems`];
}

function toVarsObj(record: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!record || typeof record !== 'object') return out;
  for (const k of Object.keys(record)) {
    const v = Object.getOwnPropertyDescriptor(record, k)?.value as unknown;
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

function mergeLinkVars(base: Readonly<Record<string, string>>, override: Readonly<Record<string, string>>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const k of Object.keys(base)) {
    const v = Object.getOwnPropertyDescriptor(base, k)?.value as unknown;
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  for (const k of Object.keys(override)) {
    const v = Object.getOwnPropertyDescriptor(override, k)?.value as unknown;
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/** Reads an explicit CLI file path (not restricted to the workspace root, like `--replay` and `--assert`). */
async function readCliFile(raw: string, cwd: string, files: RulesFs, spec: WorkspaceFileSpec): Promise<{ text: string; abs: string; real: string }> {
  const abs = path.resolve(cwd, raw);
  let st: Awaited<ReturnType<RulesFs['stat']>>;
  try {
    st = await files.stat(abs);
  } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') throw new Error(`${spec.what} ${raw} not found`);
    throw new Error(`${spec.what} ${raw} can't be read (${errno(e) ?? (e as Error).message})`);
  }
  if (!st.isFile()) throw new Error(`${spec.what} ${raw} is not a regular file`);
  if (st.size > spec.maxBytes) throw new Error(`${spec.what} ${raw} is larger than ${spec.maxLabel}`);
  const real = files.realpathSync(abs);
  return { text: decodeWorkspaceFile(await files.readFile(real), raw, spec), abs, real };
}

function parseDoc(text: string, label: string): { value?: unknown; problem?: string } {
  return isYamlFile(label) ? parseYaml(text, label) : parseJsonText(text, label);
}

/** Serialises a Postman environment map into Postman environment JSON (values stay inside envValues, never dynVars). */
function toPostmanEnvJson(values: ReadonlyMap<string, string>): Buffer {
  const entries = [...values.entries()].map(([key, value]) => ({ key, value, enabled: true }));
  return Buffer.from(JSON.stringify({ name: 'cli', _postman_variable_scope: 'environment', values: entries }), 'utf8');
}

/**
 * Virtual file overlay on top of a read-only `RulesFs`: lets `MockCollectionsCore` read merged CLI environment files
 * and validated CLI snapshots through its normal workspace path checks without touching disk or bypassing symlinks.
 */
class VirtualRulesFs {
  private readonly files = new Map<string, { real: string; data: Buffer }>();
  private readonly dirs = new Map<string, string>();
  readonly fs: RulesFs;

  constructor(private readonly base: RulesFs) {
    this.fs = {
      ...base,
      readFile: async (p) => {
        const hit = this.files.get(path.resolve(p));
        return hit ? hit.data : base.readFile(p);
      },
      stat: async (p) => {
        const hit = this.files.get(path.resolve(p));
        return hit ? { isFile: () => true, isDirectory: () => false, size: hit.data.byteLength, mtimeMs: 1 } : base.stat(p);
      },
      realpathSync: (p) => {
        const abs = path.resolve(p);
        const hit = this.files.get(abs);
        if (hit) return hit.real;
        try {
          return base.realpathSync(p);
        } catch (e) {
          const dir = this.dirs.get(abs);
          if (dir) return dir;
          throw e;
        }
      },
    };
  }

  /** Registers virtual bytes at `<folder>/<rel>` (both raw and canonical folder paths resolve to the canonical path). */
  add(folder: string, rel: string, data: Buffer): void {
    const rawFolder = path.resolve(folder);
    const realFolder = this.base.realpathSync(rawFolder);
    const parts = rel.split('/');
    const rawFile = path.join(rawFolder, ...parts);
    const realFile = path.join(realFolder, ...parts);
    this.files.set(rawFile, { real: realFile, data });
    this.files.set(realFile, { real: realFile, data });
    let curRaw = rawFolder;
    let curReal = realFolder;
    for (let i = 0; i < parts.length - 1; i++) {
      curRaw = path.join(curRaw, parts[i]);
      curReal = path.join(curReal, parts[i]);
      this.dirs.set(curRaw, curReal);
      this.dirs.set(curReal, curReal);
    }
  }
}

/** The text of `<folder>/.vscode/flutter-intercept/snapshots/<id>/<name>.json` (§22.8 path checks), or undefined when missing. */
async function readNamedSnapshot(folder: string, id: string, name: string, files: RulesFs): Promise<{ text: string; rel: string } | undefined> {
  const rel = `${SNAPSHOTS_DIR}/${id}/${name}.json`;
  let real: string;
  try {
    real = (await checkWorkspaceFile(rel, folder, [folder], files, SNAPSHOT_FILE_SPEC)).real;
  } catch (e) {
    if (/ not found$/.test(errorText(e))) return undefined;
    throw e;
  }
  return { text: decodeWorkspaceFile(await files.readFile(real), rel, SNAPSHOT_FILE_SPEC), rel };
}

interface CliCollectionInfo {
  id: string;
  rawFile: string;
  folderPath: string;
  rel: string;
  format: CollectionFormat;
  name?: string;
}

/** Resolves a `--collection` CLI argument: a file (Postman, OpenAPI, Swagger, Insomnia, `bruno.json`) or a Bruno folder. */
async function inspectCliCollection(rawFile: string, cwd: string, files: RulesFs, seenIds: ReadonlySet<string>): Promise<CliCollectionInfo> {
  let abs = path.resolve(cwd, rawFile);
  let label = rawFile;
  let st: Awaited<ReturnType<RulesFs['stat']>>;
  try {
    st = await files.stat(abs);
  } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') throw new Error(`collection file ${rawFile} not found`);
    throw new Error(`collection file ${rawFile} can't be read (${errno(e) ?? (e as Error).message})`);
  }
  if (!st.isFile()) {
    // Allow passing a Bruno collection folder directly (e.g. `api/shop-bruno/` → `api/shop-bruno/bruno.json`).
    const brunoCandidate = path.join(abs, 'bruno.json');
    let brunoSt: Awaited<ReturnType<RulesFs['stat']>> | undefined;
    try {
      brunoSt = await files.stat(brunoCandidate);
    } catch {
      brunoSt = undefined;
    }
    if (brunoSt?.isFile()) {
      abs = brunoCandidate;
      st = brunoSt;
      label = path.join(rawFile, 'bruno.json');
    } else {
      throw new Error(`collection file ${rawFile} is not a regular file`);
    }
  }
  if (st.size > COLLECTION_LIMITS.fileBytes) throw new Error(`collection file ${label} is larger than 20 MB`);
  if (isBrunoLinkFile(path.basename(abs))) {
    // CONTRACTS §24.10: a symlinked bruno.json is refused (Bruno collections are only read as plain files).
    const folderPath = files.realpathSync(path.dirname(abs));
    const rel = path.basename(abs);
    const real = files.realpathSync(abs);
    if (path.join(folderPath, rel) !== real) {
      throw new Error(`${label} goes through a symbolic link; a Bruno collection is only read as plain files in the project`);
    }
    const text = decodeWorkspaceFile(await files.readFile(real), label, COLLECTION_FILE_SPEC);
    const r = parseJsonText(text, label);
    const brunoName =
      r.problem === undefined && r.value && typeof r.value === 'object' && typeof (r.value as { name?: unknown }).name === 'string'
        ? (r.value as { name: string }).name.trim()
        : undefined;
    const id = slugId(brunoName || path.basename(folderPath) || 'bruno', seenIds);
    return { id, rawFile: label, folderPath, rel, format: 'bruno', name: brunoName };
  }
  const real = files.realpathSync(abs);
  const folderPath = path.dirname(real);
  const rel = path.basename(real);
  const text = decodeWorkspaceFile(await files.readFile(real), label, COLLECTION_FILE_SPEC);

  const r = parseDoc(text, label);
  if (r.problem !== undefined) throw new Error(r.problem);
  const detected = collectionParsers.detectFormat(r.value);
  if (!detected.format) throw new Error(`${label}: ${detected.problem ?? NOT_A_COLLECTION}`);
  let name: string | undefined;
  const doc = r.value as { name?: unknown; info?: { name?: unknown; title?: unknown } };
  if (detected.format === 'insomnia') {
    const src = collectionParsers.parseInsomniaDoc?.(r.value, {});
    name = src?.name?.trim() || (typeof doc.name === 'string' ? doc.name.trim() : undefined);
  } else {
    const raw = detected.format === 'postman' ? doc.info?.name : doc.info?.title;
    if (typeof raw === 'string' && raw.trim()) name = raw.trim();
  }
  const stem = path.basename(rel).replace(/\.(postman_collection\.)?(json|ya?ml)$/i, '');
  const id = slugId(name || stem, seenIds);
  return { id, rawFile: label, folderPath, rel, format: detected.format, name };
}

/** Detects whether a shared-file collection link is Insomnia or Bruno (so `--collection-env` knows file vs name). */
async function sniffSharedFormat(link: CollectionLink, folderPath: string, files: RulesFs): Promise<CollectionFormat | undefined> {
  if (isBrunoLinkFile(link.file)) return 'bruno';
  try {
    const st = await checkWorkspaceFile(link.file, folderPath, [folderPath], files, COLLECTION_FILE_SPEC);
    const text = decodeWorkspaceFile(await files.readFile(st.real), link.file, COLLECTION_FILE_SPEC);
    const r = parseDoc(text, link.file);
    if (r.problem !== undefined) return undefined;
    return collectionParsers.detectFormat(r.value).format;
  } catch {
    return undefined;
  }
}

interface TrackedCollection {
  id: string;
  fileLabel: string;
  isCli: boolean;
  entryFolder: string;
  snapFolder: string;
  sharedSnapshot?: string;
  storeLink: StoreSettingsLink;
}

export async function loadCollections(o: LoadCollectionsOptions): Promise<LoadedCollections> {
  const baseFs = o.fs ?? readOnlyRulesFs;
  const vfs = new VirtualRulesFs(baseFs);
  const cliVars = toVarsObj(o.vars);
  const sharedLinks = o.sharedLinks ?? [];
  const cliFiles = o.files ?? [];
  const extraProblems: string[] = [];

  // 1. Inventory shared links + inspect explicit `--collection` CLI inputs (fail fast on missing / invalid CLI files).
  const seenIds = new Set<string>();
  let total = 0;
  const activeShared: { folder: FolderCollectionLinks; link: CollectionLink; storeLink?: StoreSettingsLink; format?: CollectionFormat }[] = [];

  for (const folder of sharedLinks) {
    extraProblems.push(...folder.problems);
    const storeMap = new Map<string, StoreSettingsLink>();
    for (const sl of (folder.stores ?? []) as StoreSettingsLink[]) {
      if (!storeMap.has(sl.collection)) storeMap.set(sl.collection, sl);
    }
    for (const link of folder.links) {
      if (seenIds.has(link.id)) {
        extraProblems.push(`${folder.label}: collection "${link.id}" is also linked in another workspace folder (skipped)`);
        continue;
      }
      seenIds.add(link.id);
      if (!link.enabled) continue;
      if (++total > COLLECTION_LIMITS.linksPerFile) {
        extraProblems.push(`at most ${COLLECTION_LIMITS.linksPerFile} collections can be loaded (skipped "${link.id}")`);
        continue;
      }
      const format = await sniffSharedFormat(link, folder.folderPath, baseFs);
      activeShared.push({ folder, link, storeLink: storeMap.get(link.id), format });
    }
  }

  const cliInfos: CliCollectionInfo[] = [];
  for (const rawFile of cliFiles) {
    if (++total > COLLECTION_LIMITS.linksPerFile) {
      throw new Error(`at most ${COLLECTION_LIMITS.linksPerFile} collections can be loaded`);
    }
    const info = await inspectCliCollection(rawFile, o.cwd, baseFs, seenIds);
    seenIds.add(info.id);
    cliInfos.push(info);
  }

  // 2. CONTRACTS §24.4: `--collection-env` is a Postman environment file for Postman / OpenAPI / Swagger,
  //    or an environment name for Insomnia / Bruno.
  const allFormats: (CollectionFormat | undefined)[] = [...activeShared.map((s) => s.format), ...cliInfos.map((c) => c.format)];
  const hasNamedEnvFormat = allFormats.some((f) => f === 'insomnia' || f === 'bruno');
  const hasFileEnvFormat = allFormats.some((f) => f !== 'insomnia' && f !== 'bruno');
  let cliEnvValues: Map<string, string> | undefined;
  let cliEnvName: string | undefined;
  if (o.envFile !== undefined) {
    if (hasFileEnvFormat || !hasNamedEnvFormat) {
      const env = await readCliFile(o.envFile, o.cwd, baseFs, ENVIRONMENT_FILE_SPEC);
      const parsedEnv = parseJsonText(env.text, o.envFile);
      if (parsedEnv.problem !== undefined) throw new Error(parsedEnv.problem);
      const pe = collectionParsers.parsePostmanEnvironment(parsedEnv.value);
      cliEnvValues = pe.values;
      extraProblems.push(...pe.problems.map((p) => `${o.envFile}: ${p}`));
    } else {
      cliEnvName = o.envFile;
    }
  }

  // 3. Build synthetic `FolderCollectionLinks[]` for `MockCollectionsCore` (applying CLI vars, env, unmatched, store/dynamic/auth-ttl).
  const synthFolders: FolderCollectionLinks[] = [];
  const roots = new Set<string>();
  const tracked = new Map<string, TrackedCollection>();

  const makeStoreLink = (id: string, base?: StoreSettingsLink): StoreSettingsLink => {
    const next: StoreSettingsLink = {
      collection: id,
      ...(base?.enabled !== undefined ? { enabled: base.enabled } : {}),
      ...(base?.resources ? { resources: { ...base.resources } } : {}),
      ...(base?.auth ? { auth: { ...base.auth } } : {}),
      ...(base?.dynamic !== undefined ? { dynamic: base.dynamic } : {}),
    };
    if (!o.store) next.enabled = false;
    if (o.dynamic !== undefined) next.dynamic = o.dynamic;
    else if (o.seed !== undefined) next.dynamic = 'seeded';
    if (o.authTtl !== undefined) next.auth = { ...(next.auth ?? {}), ttlSeconds: o.authTtl };
    return next;
  };

  // Group shared links back by folderPath
  const byFolder = new Map<string, { label: string; links: CollectionLink[]; stores: StoreSettingsLink[] }>();
  for (const item of activeShared) {
    const folderPath = item.folder.folderPath;
    roots.add(folderPath);
    let bucket = byFolder.get(folderPath);
    if (!bucket) {
      bucket = { label: item.folder.label, links: [], stores: [] };
      byFolder.set(folderPath, bucket);
    }
    let envField = item.link.environment;
    if (item.format === 'insomnia' || item.format === 'bruno') {
      if (cliEnvName !== undefined) envField = cliEnvName;
    } else if (cliEnvValues) {
      // Merge `--collection-env` over `link.environment` (priority: cliEnv > linkEnv), kept inside envValues (never dynVars).
      const merged = new Map<string, string>();
      if (item.link.environment) {
        try {
          const st = await checkWorkspaceFile(item.link.environment, folderPath, [folderPath], baseFs, ENVIRONMENT_FILE_SPEC);
          const envText = decodeWorkspaceFile(await baseFs.readFile(st.real), item.link.environment, ENVIRONMENT_FILE_SPEC);
          const er = parseJsonText(envText, item.link.environment);
          if (er.problem !== undefined) {
            extraProblems.push(er.problem);
            continue;
          }
          const pe = collectionParsers.parsePostmanEnvironment(er.value);
          for (const [k, v] of pe.values) merged.set(k, v);
          extraProblems.push(...pe.problems.map((p) => `${item.link.environment}: ${p}`));
        } catch (e) {
          extraProblems.push(errorText(e));
          continue;
        }
      }
      for (const [k, v] of cliEnvValues) merged.set(k, v);
      const virtRel = `.vscode/flutter-intercept/__cli-env-${item.link.id}.json`;
      vfs.add(folderPath, virtRel, toPostmanEnvJson(merged));
      envField = virtRel;
    }

    const linkCopy: CollectionLink = {
      ...item.link,
      ...(envField !== undefined ? { environment: envField } : {}),
      variables: mergeLinkVars(item.link.variables, cliVars),
      unmatched: o.unmatched ?? item.link.unmatched,
    };
    const sl = makeStoreLink(item.link.id, item.storeLink);
    bucket.links.push(linkCopy);
    bucket.stores.push(sl);
    tracked.set(item.link.id, {
      id: item.link.id,
      fileLabel: item.link.file,
      isCli: false,
      entryFolder: folderPath,
      snapFolder: folderPath,
      sharedSnapshot: item.storeLink?.snapshot,
      storeLink: sl,
    });
  }
  for (const [folderPath, b] of byFolder) {
    synthFolders.push({ folderPath, label: b.label, links: b.links, stores: b.stores, problems: [] });
  }

  for (const info of cliInfos) {
    roots.add(info.folderPath);
    let envField: string | undefined;
    if (info.format === 'insomnia' || info.format === 'bruno') {
      if (cliEnvName !== undefined) envField = cliEnvName;
    } else if (cliEnvValues) {
      const virtRel = `__cli-env-${info.id}.json`;
      vfs.add(info.folderPath, virtRel, toPostmanEnvJson(cliEnvValues));
      envField = virtRel;
    }
    const link: CollectionLink = {
      id: info.id,
      file: info.rel,
      ...(envField !== undefined ? { environment: envField } : {}),
      variables: { ...cliVars },
      enabled: true,
      unmatched: o.unmatched ?? 'passthrough',
      selected: {},
      off: [],
    };
    const sl = makeStoreLink(info.id);
    synthFolders.push({ folderPath: info.folderPath, label: info.rawFile, links: [link], stores: [sl], problems: [] });
    tracked.set(info.id, {
      id: info.id,
      fileLabel: info.rawFile,
      isCli: true,
      entryFolder: info.folderPath,
      snapFolder: o.store?.folder ?? o.cwd,
      storeLink: sl,
    });
  }

  if (!tracked.size) {
    if (o.store?.snapshot !== undefined) {
      throw new Error('--collection-snapshot: no collection in this run has resources that remember data');
    }
    if (o.auth) {
      throw new Error('--collection-auth: no collection is loaded');
    }
    return { rules: [], collections: [], problems: capProblems(extraProblems), stores: [], handlers: new Map(), auth: [] };
  }

  // 4. Run `MockCollectionsCore` headless (CONTRACTS §24: one answer pipeline, seeded dynamic values by default).
  const rawHandlers = new Map<string, RequestHandler>();
  let rid = 0;
  const core = new MockCollectionsCore({
    links: () => synthFolders,
    saveLinks: async () => undefined,
    primaryFolderPath: async () => o.store?.folder ?? o.cwd,
    writeWorkspaceFile: async () => undefined,
    workspaceRoots: () => [...roots],
    fs: vfs.fs,
    memento: new MemoryMemento(),
    parsers: collectionParsers,
    newRuleId: () => `cli_col_${++rid}`,
    setHandler: (id, fn) => {
      if (fn) rawHandlers.set(id, fn);
      else rawHandlers.delete(id);
    },
    ...(o.now ? { now: o.now } : {}),
    dynamic: { mode: o.dynamic ?? 'seeded', seed: o.seed ?? 1 },
  });

  await core.reload();

  // CONTRACTS §22.17: CLI never limits answers (approve every loaded collection in the in-memory memento).
  for (const st of core.state(false)) {
    if (core.approvalSummary(st.id)) await core.approve(st.id);
  }

  // Fail fast for explicit `--collection` files that failed to load (e.g. broken Bruno folder), and unresolved vars + fail.
  for (const st of core.state(false)) {
    const tr = tracked.get(st.id);
    if (tr?.isCli && !st.format && st.problems.length) {
      throw new Error(st.problems[0]);
    }
    if (st.unmatched === 'fail' && st.unresolved.length) {
      throw new Error(
        `collection "${st.name}" has unresolved URL variable(s) (${st.unresolved.map((u) => `{{${u}}}`).join(', ')}) with unmatched=fail: set them with --collection-var name=value or --collection-env <file>`,
      );
    }
  }

  // 5. CONTRACTS §24.1: `--collection-auth` turns sign-in simulation on (setup error if no login request is found).
  if (o.auth) {
    const statuses = core.state(false);
    const available = statuses.filter((s) => s.store?.auth?.available === true);
    if (!available.length) {
      const names = statuses.map((s) => `"${s.name}"`).join(', ');
      throw new Error(`--collection-auth: No login request was found in ${names} (a POST ending in /login, /signin, /token, …): sign-in simulation needs one`);
    }
    for (const s of available) {
      await core.updateStore(s.id, {
        auth: { enabled: true, ...(o.authTtl !== undefined ? { ttlSeconds: o.authTtl } : {}) },
        scope: 'me',
      });
    }
  }

  // 6. CONTRACTS §22.8 / §22.11: starting snapshots (`--collection-snapshot` or shared `stores[].snapshot`).
  const startsFromByCol = new Map<string, string>();
  const strictSnapshotCols = new Map<string, string>();
  const statefulCols = core
    .state(false)
    .filter((s) => s.store?.enabled && s.store.resources.some((r) => r.remembers))
    .map((s) => ({ status: s, tr: tracked.get(s.id)! }));

  if (o.store?.snapshot !== undefined) {
    const arg = o.store.snapshot;
    if (!statefulCols.length) {
      throw new Error('--collection-snapshot: no collection in this run has resources that remember data');
    }
    if (SNAPSHOT_NAME.test(arg)) {
      let used = 0;
      for (const { status, tr } of statefulCols) {
        const found = await readNamedSnapshot(tr.snapFolder, status.id, arg, baseFs);
        if (!found) {
          extraProblems.push(`"${status.name}" has no snapshot "${arg}" (${SNAPSHOTS_DIR}/${status.id}/${arg}.json); it starts from its examples`);
          continue;
        }
        const parsed = parseSnapshot(found.text);
        if (!parsed.snapshot) throw new Error(`${found.rel}: ${parsed.problems[0] ?? "it isn't a snapshot"}`);
        if (path.resolve(tr.entryFolder) !== path.resolve(tr.snapFolder)) {
          vfs.add(tr.entryFolder, `${SNAPSHOTS_DIR}/${status.id}/${arg}.json`, Buffer.from(found.text, 'utf8'));
        }
        tr.storeLink.snapshot = arg;
        startsFromByCol.set(status.id, found.rel);
        strictSnapshotCols.set(status.id, found.rel);
        used++;
      }
      if (!used) {
        throw new Error(
          `--collection-snapshot: snapshot "${arg}" not found (looked for ${statefulCols.map(({ status }) => `${SNAPSHOTS_DIR}/${status.id}/${arg}.json`).join(', ')})`,
        );
      }
      await core.reload();
    } else {
      const file = await readCliFile(arg, o.cwd, baseFs, SNAPSHOT_FILE_SPEC);
      const parsed = parseSnapshot(file.text);
      if (!parsed.snapshot) throw new Error(`${arg}: ${parsed.problems[0] ?? "it isn't a snapshot"}`);
      const saved = parsed.snapshot.collection;
      const target = statefulCols.find(({ status }) => status.id === saved) ?? (statefulCols.length === 1 ? statefulCols[0] : undefined);
      if (!target) {
        throw new Error(
          `--collection-snapshot ${arg}: it was saved for "${saved}", which isn't loaded (collections that remember data: ${statefulCols.map(({ status }) => status.id).join(', ')})`,
        );
      }
      if (target.status.id !== saved) {
        extraProblems.push(`${arg}: saved for "${saved}", loaded into "${target.status.name}"`);
      }
      const virtName = 'cli-snapshot';
      vfs.add(target.tr.entryFolder, `${SNAPSHOTS_DIR}/${target.status.id}/${virtName}.json`, Buffer.from(file.text, 'utf8'));
      target.tr.storeLink.snapshot = virtName;
      startsFromByCol.set(target.status.id, arg);
      strictSnapshotCols.set(target.status.id, arg);
      await core.reload();
    }
    // Check that strict snapshots loaded without record-level errors (unknown resources ending in `(skipped)` are non-fatal).
    for (const [colId, label] of strictSnapshotCols) {
      const storeProblems = core.storeStatus(colId)?.problems ?? [];
      const snapErr = storeProblems.find((p) => p.startsWith('Snapshot "') && !p.endsWith('(skipped)'));
      if (snapErr) throw new Error(`${label}: ${snapErr}`);
    }
  } else if (o.store) {
    // Non-strict shared-file `stores[].snapshot`.
    let needReload = false;
    for (const { status, tr } of statefulCols) {
      const snap = tr.sharedSnapshot;
      if (!snap) continue;
      let found: { text: string; rel: string } | undefined;
      try {
        found = await readNamedSnapshot(tr.snapFolder, status.id, snap, baseFs);
      } catch (e) {
        extraProblems.push(`${errorText(e)}; "${status.name}" starts from its examples`);
        continue;
      }
      if (!found) {
        extraProblems.push(`snapshot "${snap}" of "${status.name}" not found (${SNAPSHOTS_DIR}/${status.id}/${snap}.json); it starts from its examples`);
        continue;
      }
      const parsed = parseSnapshot(found.text);
      if (!parsed.snapshot) {
        extraProblems.push(`${found.rel}: ${parsed.problems[0] ?? "it isn't a snapshot"}; "${status.name}" starts from its examples`);
        continue;
      }
      tr.storeLink.snapshot = snap;
      startsFromByCol.set(status.id, found.rel);
      needReload = true;
    }
    if (needReload) await core.reload();
  }

  // Re-approve after any reload caused by snapshot / auth updates (keeps CLI answers unlimited).
  for (const st of core.state(false)) {
    if (core.approvalSummary(st.id)) await core.approve(st.id);
  }

  // 7. Collect final rules, wrapped handlers (with store-write tallying), stores, auth and summaries.
  const rules = core.rules();
  const ruleMatchers = new Map(rules.map((r) => [r.id, compileMatcher(r.match)]));
  const changesByCol = new Map<string, Map<string, StoreChanges>>();
  const handlers = new Map<string, RequestHandler>();
  let callSeq = 0;

  for (const [handlerId, fn] of rawHandlers) {
    const linkId = handlerId.slice(COLLECTION_RULE_PREFIX.length);
    const changes = new Map<string, StoreChanges>();
    changesByCol.set(linkId, changes);
    handlers.set(handlerId, async (req, signal) => {
      const matcher = ruleMatchers.get(req.ruleId);
      if (!matcher || !matcher(req.method, req.url)) return undefined;
      const seqId = `${req.exchangeId}#${++callSeq}`;
      const res = await fn({ ...req, exchangeId: seqId }, signal);
      if (res && !('fallback' in res)) {
        const op = core.storeOpOf(seqId);
        if (op) tally(changes, op, res);
      }
      return res;
    });
  }

  const finalStates = core.state(false);
  const collections: LoadedCollectionSummary[] = [];
  const stores: CollectionStore[] = [];
  const auth: LoadedCollectionAuth[] = [];
  const allProblems = [...extraProblems, ...core.fileProblems()];

  for (const s of finalStates) {
    const tr = tracked.get(s.id);
    if (!s.format) {
      allProblems.push(...s.problems);
      continue;
    }
    const authOn = s.store?.auth?.enabled === true;
    const sessionsFn = () => core.storeStatus(s.id)?.auth?.sessions ?? 0;
    collections.push({
      id: s.id,
      name: s.name,
      file: tr?.fileLabel ?? s.file,
      format: s.format,
      unmatched: s.unmatched,
      endpoints: s.endpoints,
      mocked: s.mocked,
      noExample: s.noExample,
      unresolved: s.unresolved,
      auth: authOn,
      sessions: sessionsFn,
    });
    allProblems.push(...s.problems);
    if (s.store?.problems.length) allProblems.push(...s.store.problems);
    if (s.store?.auth?.problems.length) allProblems.push(...s.store.auth.problems);

    const activeResources = s.store?.enabled ? s.store.resources.filter((r) => r.remembers) : [];
    const handlerId = storeHandlerId(s.id);
    const handler = handlers.get(handlerId);
    if (activeResources.length && handler) {
      const startsFrom = startsFromByCol.get(s.id);
      stores.push({
        id: s.id,
        name: s.name,
        handlerId,
        resources: activeResources.map((r) => ({ name: r.name })),
        counts: () => Object.fromEntries((core.storeStatus(s.id)?.resources ?? []).map((r) => [r.name, r.count])),
        handler,
        changes: changesByCol.get(s.id) ?? new Map(),
        ...(startsFrom ? { startsFrom } : {}),
      });
    }
    if (authOn) {
      auth.push({
        id: s.id,
        name: s.name,
        sessions: sessionsFn,
      });
    }
  }

  return { rules, collections, problems: capProblems(allProblems), stores, handlers, auth };
}
