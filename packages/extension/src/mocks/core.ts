/**
 * Mock from a collection — the host core (CONTRACTS §21.6, §21.7). No `vscode` import: the fs, the workspace
 * roots, workspaceState, the links in the shared file (and their writer) and the parsers are injected
 * (src/mocks/service.ts wires them to VS Code; the sidecar and the CLI can reuse it).
 *
 * - Links come from `.vscode/flutter-intercept.json` (`collections`, read by src/rules/core.ts). Their files are read
 *   only inside the workspace (realpath, `checkWorkspaceFile`), ≤ 20 MB, UTF-8; YAML through `parseYaml`.
 * - Parsing is cached by the files' size + mtime and the link fields that change the parse; a file that becomes
 *   unreadable or broken keeps the last good parse for the session, with the problem shown.
 * - `enabled` has a personal override in workspaceState. CONTRACTS §21.15: `selected`, `off` and `unmatched` have a
 *   personal overlay too (scope 'me', the default); scope 'team' writes the shared file; URL variables are always the
 *   team's.
 * - CONTRACTS §21.16: until the user approves a collection (hash of its files and URL variables), answers that shared
 *   mocks would need approval for are served limited (`limit.ts`). Only the IDE can approve; agents can't.
 * - Environment values resolve URL variables only: they are never part of `state()`, `endpoints()`, problems or
 *   logs (only variable names are; a value used in a path is shown as `{{name}}`).
 * - Every problem line goes through `cleanLine` (REVIEW-15 #7).
 * - CONTRACTS §24: more sources (Swagger 2.0, Insomnia, a Bruno folder walked from its `bruno.json`), and one answer
 *   pipeline per request a `handler` rule matched: auth gate → query example → body example → store → default example
 *   → dynamic values → limited headers. Sessions (`AuthSessions`) live here, per link, in memory only; request bodies
 *   are read to choose an example or to find the login name and never leave this file.
 */
import { createHash } from 'crypto';
import { constants as fsConstants, promises as fsPromises } from 'fs';
import * as path from 'path';
import type { Exchange, HandlerFallback, HandlerRequest, HandlerResponse, RequestHandler, Rule } from '@flutter-intercept/proxy';
import { compileMatcher, compileRules, findRule, type CompiledRule } from '@flutter-intercept/proxy/rules';
import { prettyJson } from '../codegen/json';
import { reasonPhrase } from '../export/common';
import { pathTemplate } from '../contract/mapping';
import { cleanLine, isLimitedHeader, limitAnswer, limitHeaders, LIMIT_REASONS, type LimitReason } from './limit';
import { checkWorkspaceFile, decodeWorkspaceFile, type RulesFs, type WorkspaceFileSpec } from '../rules/bodyFile';
import type { FolderCollectionLinks, MementoLike } from '../rules/core';
import { parseJsonc } from '../rules/jsonc';
import { checkResourceOverride, environmentName, ID_FIELD, isBrunoLinkFile, isDynamicMode, isTtlSeconds, relativePath, type StoreAuthLink, type StoreSettingsLink } from './link';
import { cleanHeaders, cutMiddle, defaultExample, displayPath, is2xx, isJsonAnswer, toRules, type PipelineRuleMeta, type PipelineRulesOptions } from './toRules';
import { collectionFromTraffic, TrafficSanitiser } from './fromTraffic';
import { DriftTracker, driftSummary, endpointLabel } from './drift';
import { insertBefore, locate, mergeExample, parseJsonTree, postmanExamplePath, spliceValue, type JsonNode } from './splice';
import { looksLikeCredential } from './snapshot';
import { withoutSecretFields } from './secrets';
import {
  AuthSessions,
  DEFAULT_TTL_SECONDS,
  defaultProtect,
  detectAuth,
  isProtected,
  isRefreshGrant,
  loginIdentifier,
  refreshTokenOf,
  unauthorizedExample,
  UNAUTHORIZED_BODY,
  type AuthEndpoints,
} from './auth';
import { buildBodyMatchers, chooseByBody, MATCH_REQUEST_BYTES, parseBodyForMatch, type BodyMatcher } from './bodyMatch';
import { brunoLimits, type BrunoFile } from './bruno';
import { hasPlaceholders, renderDynamic, type DynamicContext, type DynamicMode } from './dynamic';
import type { SourceOptions, SourceParsed } from './viaPostman';
import { detectResources, maskPathSegments } from './resources';
import { ResourceStore } from './store';
import { parseSnapshot, snapshotText } from './snapshot';
import { isYamlFile, parseYaml } from './yaml';
import {
  COLLECTION_LIMITS,
  LINK_ID,
  type CollectionLink,
  type CollectionVars,
  type DetectFormat,
  type MockEndpoint,
  type MockExample,
  type ParseOpenApi,
  type ParsePostman,
  type ParsePostmanEnvironment,
  type ParsedCollection,
  type PostmanCollectionVariables,
  type SanitisePostman,
  type ToRulesStats,
  type CollectionRuleMeta,
  COLLECTION_RULE_PREFIX,
  SNAPSHOT_NAME,
  SNAPSHOTS_DIR,
  STORE_LIMITS,
  type CollectionFormat,
  type Resource,
  type ResourceOverride,
  type StoreLink,
  type StoreOp,
} from './types';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus, DriftChange, DriftView, StoreAuthStatus, StoreOpView, StorePatch, StoreResourceView, StoreStatus } from '../ui/protocol';

export const ENABLED_KEY = 'flutterIntercept.collectionsEnabled';
/** CONTRACTS §21.15: `{ [folder\0id]: { selected?: {key: name}, off?: {key: boolean}, unmatched? } }`. */
export const OVERLAY_KEY = 'flutterIntercept.collectionsOverlay';
/** CONTRACTS §21.16: `{ [folder\0id]: approval hashes[] }` (the last few kept, so switching branches back is free). */
export const APPROVALS_KEY = 'flutterIntercept.collectionsApproved';
const MAX_APPROVALS_PER_COLLECTION = 5;
/** CONTRACTS §22.7: `{ [folder\0id]: { enabled?, snapshot?: name | null, resources?: {name: {off?, idField?}} } }`. */
export const STORES_OVERLAY_KEY = 'flutterIntercept.storesOverlay';
/** CONTRACTS §22.10: records per `storeItems` page. */
export const STORE_PAGE = 200;
const MAX_STORE_PROBLEMS = 20;
const SNAPSHOT_FILE_SPEC: WorkspaceFileSpec = { what: 'snapshot', maxBytes: STORE_LIMITS.snapshotBytes, maxLabel: '32 MB' };
const ITEM_OPS: ReadonlySet<StoreOp> = new Set(['get', 'replace', 'patch', 'delete']);
const WRITE_OPS: ReadonlySet<StoreOp> = new Set(['create', 'replace', 'patch', 'delete']);
/** Thrown by `storeSnapshot` hosts when the user cancels the name prompt (nothing to report). */
export class SnapshotCancelled extends Error {}
/** CONTRACTS §21.15 #4: entries per `seen` list, and how many recent exchanges are looked at. */
const MAX_SEEN = 20;
const MAX_SEEN_EXCHANGES = 5000;
export const COLLECTIONS_DIR = '.vscode/flutter-intercept/collections';
/** CONTRACTS §23.3: `{ [folder\0id\0endpoint\0status]: fingerprint }` — findings the user chose to ignore. */
export const DRIFT_IGNORED_KEY = 'flutterIntercept.driftIgnored';
/** CONTRACTS §23.3: queue debounce and batch size. */
export const DRIFT_DEBOUNCE_MS = 500;
export const DRIFT_PER_TICK = 50;
/** PERF-5 #4: a tick's batch runs in slices of about this long, so a burst of big answers never blocks the host long. */
export const DRIFT_SLICE_MS = 10;
/** Answers larger than this are not compared (§23.3: a JSON response ≤ 1 MB). */
const DRIFT_MAX_BODY = 1024 * 1024;
const MAX_DRIFT_QUEUE = 1000;
const MAX_DRIFT_DONE = 10_000;
const MAX_DRIFT_LATEST = 5000;
const MAX_DRIFT_IGNORED = 2000;
/** CONTRACTS §23.2: what an empty source is told. */
export const NOTHING_RECORDED = "No answer from a real server was recorded to make a fake backend from. Run the app against the real server first";
export const MAX_PROBLEMS = 50;
const VARIABLE_NAME = /^[A-Za-z0-9_.$-]{1,100}$/;
/** REVIEW-15 #8: what a variable used as a server may hold — `https://host[:port][/path]` or `host[:port]`, no userinfo. */
const ORIGIN_VALUE = /^(?:https?:\/\/)?(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?:\/[^\s?#@]*)?$/;
const MAX_VARIABLE_VALUE = 2048;

const COLLECTION_FILE_SPEC: WorkspaceFileSpec = { what: 'collection file', maxBytes: COLLECTION_LIMITS.fileBytes, maxLabel: '20 MB' };
const ENVIRONMENT_FILE_SPEC: WorkspaceFileSpec = { what: 'environment file', maxBytes: 5 * 1024 * 1024, maxLabel: '5 MB' };
/** What a file that is none of the supported formats is told. */
export const NOT_A_COLLECTION = 'not a Postman collection, an OpenAPI 3 or Swagger 2.0 document, an Insomnia export or a Bruno collection (bruno.json)';
/** CONTRACTS §24.4: directory entries looked at while walking a Bruno folder (files of every kind, before filtering). */
export const BRUNO_MAX_ENTRIES = 20_000;
const BRUNO_FILE_SPEC: WorkspaceFileSpec = { what: 'Bruno file', maxBytes: brunoLimits.totalBytes, maxLabel: '20 MB' };
/** PERF-5 #3: Bruno files stat-ed and read at a time (results still taken in order, so every limit and check is as before). */
const BRUNO_IO_WINDOW = 16;
/** PERF-5 #3: `readWalked` did not read a file because the Bruno budget (20 MB in all) is spent. */
const OVER_BUDGET: unique symbol = Symbol('over budget');

/**
 * PERF-5 #3: `fn` over `items`, at most `window` started and not yet taken; yields the results in input order. A
 * consumer that stops early (a limit throws) leaves at most `window - 1` started calls, whose rejections are ignored.
 */
async function* inOrder<T, R>(items: readonly T[], window: number, fn: (item: T) => Promise<R>): AsyncGenerator<R> {
  const started: Promise<R>[] = [];
  let next = 0;
  const fill = (): void => {
    while (next < items.length && started.length < window) {
      const p = fn(items[next++]);
      p.catch(() => undefined);
      started.push(p);
    }
  };
  fill();
  while (started.length) {
    const r = await started.shift()!;
    fill();
    yield r;
  }
}
/** CONTRACTS §24.1: the notes on answers of the auth gate (the panel reads them; nothing is added to them). */
export const AUTH_NOTES = { noToken: 'auth: 401 no token', expired: 'auth: 401 expired', signedIn: 'auth: signed in', refreshed: 'auth: refreshed' } as const;
/** A header value a rendered answer may carry (as a rule's: no CR / LF / NUL; bounded). */
const BAD_HEADER_VALUE = /[\r\n\0]/;
const MAX_HEADER_VALUE = 8192;
/** Field names shown per example chosen by body (§24.2). */
const MAX_BODY_FIELDS = 32;

/** The parsers (M1, M2), injected so this core doesn't depend on them directly. */
export interface CollectionParsers {
  detectFormat: DetectFormat;
  parsePostman: ParsePostman;
  postmanCollectionVariables: PostmanCollectionVariables;
  parsePostmanEnvironment: ParsePostmanEnvironment;
  mergeCollectionVars(link: Readonly<Record<string, string>>, environment: ReadonlyMap<string, string>, collection: ReadonlyMap<string, string>): CollectionVars;
  parseOpenApi: ParseOpenApi;
  sanitisePostman: SanitisePostman;
  // CONTRACTS §24.4 (optional: a host without them says the format isn't supported there)
  parseSwagger2Doc?: ParseOpenApi;
  parseInsomniaDoc?(doc: unknown, opts?: SourceOptions): SourceParsed;
  parseBruno?(files: readonly BrunoFile[], opts?: SourceOptions): SourceParsed;
}

export interface MockCollectionsCoreDeps {
  /** The links of every shared file (src/rules/core.ts `collectionLinks()`). */
  links(): FolderCollectionLinks[];
  /** Writes one folder's `collections` (src/rules/core.ts `saveCollections`). */
  saveLinks(folderPath: string, links: CollectionLink[]): Promise<void>;
  /** The folder new links go to. */
  primaryFolderPath(): Promise<string | undefined>;
  /** Atomic write of a workspace file (src/rules/core.ts `writeWorkspaceFile`). */
  writeWorkspaceFile(folderPath: string, rel: string, text: string): Promise<void>;
  /** All workspace folder paths (files must resolve inside one of them). */
  workspaceRoots(): string[];
  fs: RulesFs;
  memento: MementoLike;
  parsers: CollectionParsers;
  newRuleId(): string;
  log?(msg: string): void;
  /** Called with the absolute path of every collection / environment file in use, so it can be watched. */
  watchFile?(abs: string): void;
  /** CONTRACTS §21.15 #4: this session's exchanges (for `seen`). */
  exchanges?(): readonly Exchange[];
  /** REVIEW-15 #8: hosts (`host` or `host:port`) passed through without decryption — their requests aren't mocked. */
  passthroughHosts?(): string[];
  /**
   * CONTRACTS §22.9: registers (fn) / removes (undefined) the proxy handler `collection:<linkId>`
   * (`ProxyHost.setHandler`). Absent → no stateful mocks: exactly the 0.15 rules.
   */
  setHandler?(id: string, fn: RequestHandler | undefined): void;
  /** CONTRACTS §22.7: writes (or removes) the `stores` entry of a collection (src/rules/core.ts `saveStore`). Absent → scope 'team' is refused. */
  saveStore?(folderPath: string, collection: string, entry: StoreLink | undefined): Promise<void>;
  /** A store's data changed (the app, a patch, a snapshot, a reset); `resource` undefined = possibly several. */
  onStoreChange?(id: string, resource: string | undefined): void;
  /** Watch `<folder>/.vscode/flutter-intercept/snapshots/<linkId>/*.json` (reload on a change). */
  watchSnapshots?(folderPath: string, linkId: string): void;
  /** CONTRACTS §24.4: called with every directory of a linked Bruno collection (any change inside reloads). */
  watchFolder?(abs: string): void;
  /** CONTRACTS §24.9: the number of signed-in sessions of a collection changed (the panel's count follows). */
  onAuthChange?(id: string): void;
  /** CONTRACTS §24.1: the clock of the sessions (ms since the epoch); default `Date.now`. */
  now?(): number;
  /** CONTRACTS §24.3: this host's default mode ('random' in the IDE, 'seeded' in the CLI) and the seed of 'seeded'. */
  dynamic?: { mode?: DynamicMode; seed?: number };
  // ---- CONTRACTS §23 (part 2)
  /** §23.2: a saved recording's exchanges (`mockFromTraffic` from a recording). Absent → only the session. */
  loadRecording?(id: string): Promise<readonly Exchange[]>;
  /** §23.1 / §23.3: the user's rule `ruleId` only throttled the request (it still reached the real server). */
  isThrottleOnlyRule?(ruleId: string): boolean;
  /** §23.3: setting `flutterIntercept.collectionDrift` (absent = on). Off → nothing is tracked, no drift fields. */
  driftEnabled?(): boolean;
  /** §23.3: the drift findings changed (after a debounced batch, an ignore, or the setting). */
  onDriftChange?(): void;
  /** §23.3: how long finished exchanges wait before they are looked at (default 500 ms). */
  driftDebounceMs?: number;
  /** PERF-5 #4: how long one slice of a tick may run (default `DRIFT_SLICE_MS`; tests with fake timers: `Infinity`). */
  driftSliceMs?: number;
}

/** CONTRACTS §22.7: this user's store settings for one collection. `snapshot: null` = start from the seed. */
interface StoreOverlay {
  enabled?: boolean;
  snapshot?: string | null;
  resources?: Record<string, ResourceOverride>;
  /** CONTRACTS §24.1 (never `login` / `refresh`: those are the team's, in the file). */
  auth?: { enabled?: boolean; ttlSeconds?: number; protect?: 'declared' | 'all' };
  /** CONTRACTS §24.3 */
  dynamic?: DynamicMode;
}

/** The store settings in effect (the overlay over the shared file's entry). */
interface StoreSettings {
  enabled: boolean;
  snapshot?: string;
  resources: Record<string, ResourceOverride>;
  auth: { enabled: boolean; ttlSeconds: number; protect?: 'declared' | 'all'; login?: string; refresh?: string };
  dynamic: DynamicMode;
}

/** CONTRACTS §24.1: the auth simulation of one collection, as of the last rebuild. */
interface AuthRuntime {
  /** A login request was found (or named in the settings). */
  available: boolean;
  /** On in the settings and available. */
  enabled: boolean;
  endpoints: AuthEndpoints;
  protect: 'declared' | 'all';
  ttlSeconds: number;
  /** Endpoint keys behind the gate (protected requests and login / refresh / logout); empty when off. */
  gated: Set<string>;
  problems: string[];
}

/** What is derived from a parse for the answer pipeline (§24), built on first use and kept with the parse. */
interface Pipe {
  byKey: Map<string, MockEndpoint>;
  /** §24.2: endpoint key → matchers (only endpoints that have some). */
  matchers: Map<string, BodyMatcher[]>;
  bodyProblems: string[];
  auth: AuthEndpoints & { problems: string[] };
  protect: 'declared' | 'all';
  /** §24.3: some example holds a `{{$…}}` value. */
  hasDynamic: boolean;
}

/** CONTRACTS §24: what the pipeline answered an exchange with, when it isn't the rule's own example. */
export interface PipelineAnswerView {
  /** The example that answered (chosen by the request body, or the 401 example of the auth gate). */
  example?: string;
  byBody?: true;
  auth?: 'signed in' | 'refreshed' | '401 no token' | '401 expired';
}

interface Overlay {
  selected?: Record<string, string>;
  off?: Record<string, boolean>;
  unmatched?: 'passthrough' | 'fail';
}

/** What `describeRule` says about an exchange a collection rule answered (CONTRACTS §21.15 #2). */
export interface CollectionAnswer extends CollectionRuleMeta {
  id: string;
  name: string;
  /** Header names taken out until the collection is approved (CONTRACTS §21.16). */
  limited?: string[];
}

interface FileRead {
  real: string;
  size: number;
  mtimeMs: number;
}

/** A file the Bruno walk found; `dev` / `ino` when the fs reports them (REVIEW-16 #15g). */
type WalkedFile = FileRead & { rel: string; dev?: number; ino?: number };

interface ParseResult {
  key: string;
  parsed: ParsedCollection;
  /** Names of credentials the Postman file holds (sanitisePostman `removed`). */
  credentials: string[];
  /** sha256 of the collection and environment files' text (CONTRACTS §21.16 approval). */
  contentHash: string;
  /** Environment values (never exposed: only used to show `{{name}}` where a value appears in a path). */
  envValues: ReadonlyMap<string, string>;
  /** CONTRACTS §24.3: link variables + the collection's own — what `{{name}}` in an answer may be filled with (never environment values). */
  dynVars: ReadonlyMap<string, string>;
  /** CONTRACTS §24.4: the environments an Insomnia / Bruno collection offers (names only). */
  environments?: string[];
  pipe?: Pipe;
  /** CONTRACTS §24.3: the endpoints with their dynamic values filled in once, per link id (seeds of the store). */
  seeds?: Map<string, MockEndpoint[]>;
}

interface Entry {
  link: CollectionLink;
  folderPath: string;
  label: string;
  /** Last good parse (kept while the file is broken). */
  good?: ParseResult;
  /** Problems of this load (file unreadable, broken JSON, …). */
  loadProblems: string[];
  rules: Rule[];
  stats?: ToRulesStats;
  ruleProblems: string[];
  meta: Map<string, PipelineRuleMeta>;
  /** Rule id → header names taken out (limited answers, CONTRACTS §21.16). */
  limited: Map<string, string[]>;
  /** Limited answers that aren't a rule's own example (chosen by body, the 401 of the auth gate). */
  limitedExtra: number;
  limitReasons: LimitReason[];
  /** Every endpoint as rules (none off, passthrough), for `seen` and `request` lookups; built on first use. */
  matcher?: { compiled: CompiledRule[]; meta: Map<string, CollectionRuleMeta> };
  /** Exchange id → how it relates to this collection (`seen`), cleared with the rules. */
  seenCache: Map<string, { kind: 'none' | 'not-in' | 'no-example'; key: string }>;
  // ---- CONTRACTS §22.9 (stateful mocks)
  /** The shared file's `stores` entry for this link. */
  storeLink?: StoreSettingsLink;
  // ---- CONTRACTS §24
  auth?: AuthRuntime;
  dynamicMode: DynamicMode;
  /** Every resource found (also the ones turned off), keyed by the parse and the id-field overrides. */
  detection?: { key: string; resources: Resource[]; problems: string[] };
  store?: ResourceStore;
  /** What the store was built from (parse, id fields, starting snapshot). */
  storeKey?: string;
  /** Problems of building the store (the starting snapshot). */
  storeProblems: string[];
  /** Problems of the last data change (records skipped), until the next one. */
  dataProblems: string[];
  /** Snapshot names saved for this collection (sorted, ≤ 50). */
  snapshots: string[];
  /** Whether the collection is approved (CONTRACTS §21.16), as of the last rebuild. */
  approved: boolean;
}

function capProblems(list: string[]): string[] {
  const unique = [...new Set(list.map((p) => cleanLine(p)).filter(Boolean))];
  if (unique.length <= MAX_PROBLEMS) return unique;
  return [...unique.slice(0, MAX_PROBLEMS - 1), `… and ${unique.length - (MAX_PROBLEMS - 1)} more problems`];
}

/** `JSON.parse` with a problem that gives the position only (never text from the file: it may hold credentials). */
export function parseJsonText(text: string, label: string): { value?: unknown; problem?: string } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { value: JSON.parse(src) };
  } catch {
    // V8's message may quote the file; the position comes from our own scanner (src/rules/jsonc.ts), nothing else
    const at = /^line \d+, column \d+/.exec(parseJsonc(src).error ?? '');
    return { problem: at ? `${label} ${at[0]}: not valid JSON` : `${label}: not valid JSON` };
  }
}

/** `Shop API` → `shop-api` (`[a-z0-9-]{1,40}`), unique among `taken`. */
export function slugId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34)
      .replace(/-+$/, '') || 'collection';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

const cut = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function formatLabel(f: CollectionFormat): string {
  return f === 'postman' ? 'Postman' : f === 'openapi' ? 'OpenAPI' : f === 'swagger' ? 'Swagger 2.0' : f === 'insomnia' ? 'Insomnia' : 'Bruno';
}

/** CONTRACTS §24.4: what the Insomnia / Bruno readers get from the link (its variables, the environment by name). */
function sourceOptions(link: Pick<CollectionLink, 'variables' | 'environment'>): SourceOptions {
  return { variables: link.variables, ...(link.environment ? { environment: link.environment } : {}) };
}

/** CONTRACTS §24.3: link `variables` over the collection's own; never environment values. */
function dynamicVars(link: Pick<CollectionLink, 'variables'>, own: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of own) if (typeof v === 'string' && v !== '') out.set(k, v);
  for (const [k, v] of Object.entries(link.variables)) if (typeof v === 'string' && v !== '') out.set(k, v);
  return out;
}

/** FNV-1a, 32 bits: a stable seed from text. */
function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A request header by name (the proxy passes them as the app sent them; the first value of a repeated one). */
function headerOf(headers: HandlerRequest['headers'] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    const one = Array.isArray(v) ? v[0] : v;
    return typeof one === 'string' ? one : undefined;
  }
  return undefined;
}

const JSON_HEADERS = (): Record<string, string> => ({ 'content-type': 'application/json; charset=utf-8' });

export class MockCollectionsCore {
  private entries: Entry[] = [];
  private fileProblemList: string[] = [];
  private cache = new Map<string, ParseResult>();
  /** Collection file (real path, size, mtime) → its format, so a reload knows what `environment` means before reading. */
  private formats = new Map<string, CollectionFormat>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MockCollectionsCoreDeps) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------------ loading

  /** Re-reads every link's files (cached) and rebuilds the rules. Resolves to whether anything changed. */
  reload(): Promise<boolean> {
    return this.serial(() => this.reloadNow());
  }

  private async reloadNow(): Promise<boolean> {
    const before = this.signature();
    const previous = new Map(this.entries.map((e) => [`${e.folderPath}\0${e.link.id}`, e]));
    const next: Entry[] = [];
    const fileProblems: string[] = [];
    const seen = new Set<string>();
    const usedKeys = new Set<string>();
    this.usedFormats = new Set();
    for (const folder of this.deps.links()) {
      fileProblems.push(...folder.problems);
      for (const link of folder.links) {
        if (seen.has(link.id)) {
          fileProblems.push(`${folder.label}: collection "${link.id}" is also linked in another workspace folder (skipped)`);
          continue;
        }
        seen.add(link.id);
        const prev = previous.get(`${folder.folderPath}\0${link.id}`);
        const entry: Entry = {
          link,
          folderPath: folder.folderPath,
          label: folder.label,
          good: prev?.good,
          loadProblems: [],
          rules: [],
          ruleProblems: [],
          meta: new Map(),
          limited: new Map(),
          limitedExtra: 0,
          limitReasons: [],
          seenCache: new Map(),
          storeLink: folder.stores?.find((x) => x.collection === link.id),
          dynamicMode: 'random',
          storeProblems: [],
          dataProblems: prev?.dataProblems ?? [],
          snapshots: [],
          approved: false,
        };
        await this.load(entry);
        if (entry.good) usedKeys.add(entry.good.key);
        // CONTRACTS §23.3: what was observed was compared with the old examples
        if (prev?.good?.key !== entry.good?.key) this.forgetDrift(link.id);
        await this.prepareStore(entry, prev);
        this.buildRules(entry);
        next.push(entry);
      }
    }
    for (const k of [...this.cache.keys()]) if (!usedKeys.has(k)) this.cache.delete(k);
    for (const k of [...this.formats.keys()]) if (!this.usedFormats.has(k)) this.formats.delete(k);
    for (const id of new Set([...previous.values()].map((e) => e.link.id))) if (!next.some((e) => e.link.id === id)) this.forgetDrift(id);
    this.entries = next;
    this.fileProblemList = fileProblems;
    this.pruneSessions();
    this.syncHandlers();
    return this.signature() !== before;
  }

  private async readFile(rel: string, folderPath: string, spec: WorkspaceFileSpec): Promise<FileRead & { text?: string }> {
    const st = await checkWorkspaceFile(rel, folderPath, this.deps.workspaceRoots(), this.deps.fs, spec);
    this.deps.watchFile?.(st.real);
    return st;
  }

  private usedFormats = new Set<string>();

  private async load(entry: Entry): Promise<void> {
    const { link, folderPath } = entry;
    const { fs, parsers } = this.deps;
    // CONTRACTS §24.4: a Bruno collection is the folder next to its bruno.json
    if (isBrunoLinkFile(link.file)) return this.loadBruno(entry);
    let col: FileRead;
    let env: FileRead | undefined;
    try {
      col = await this.readFile(link.file, folderPath, COLLECTION_FILE_SPEC);
    } catch (e) {
      this.keepOrFail(entry, (e as Error).message);
      return;
    }
    // `environment` is a file for Postman / OpenAPI / Swagger and a name inside the file for Insomnia: the format
    // (remembered per file version) says which
    const statKey = JSON.stringify([col.real, col.size, col.mtimeMs]);
    this.usedFormats.add(statKey);
    let format = this.formats.get(statKey);
    const statEnvironment = async (): Promise<boolean> => {
      if (!link.environment || format === 'insomnia') return true;
      try {
        env = await this.readFile(link.environment, folderPath, ENVIRONMENT_FILE_SPEC);
        return true;
      } catch (e) {
        this.keepOrFail(entry, (e as Error).message);
        return false;
      }
    };
    const keyOf = () => JSON.stringify([col.real, col.size, col.mtimeMs, env?.real, env?.size, env?.mtimeMs, link.variables, env ? null : link.environment ?? null]);
    if (format) {
      if (!(await statEnvironment())) return;
      const cached = this.cache.get(keyOf());
      if (cached) {
        entry.good = cached;
        return;
      }
    }
    let doc: unknown;
    let envValues = new Map<string, string>();
    const hash = createHash('sha256');
    try {
      const text = decodeWorkspaceFile(await fs.readFile(col.real), link.file, COLLECTION_FILE_SPEC);
      hash.update(text).update('\0');
      const r = isYamlFile(link.file) ? parseYaml(text, link.file) : parseJsonText(text, link.file);
      if (r.problem !== undefined) return this.keepOrFail(entry, r.problem);
      doc = r.value;
    } catch (e) {
      this.keepOrFail(entry, (e as Error).message);
      return;
    }
    const detected = parsers.detectFormat(doc);
    if (!detected.format) {
      this.keepOrFail(entry, `${link.file}: ${detected.problem ?? NOT_A_COLLECTION}`);
      return;
    }
    if (!format) {
      format = detected.format;
      this.formats.set(statKey, format);
      if (!(await statEnvironment())) return;
    }
    const key = keyOf();
    try {
      if (env && link.environment) {
        const envText = decodeWorkspaceFile(await fs.readFile(env.real), link.environment, ENVIRONMENT_FILE_SPEC);
        hash.update(envText);
        const er = parseJsonText(envText, link.environment);
        if (er.problem !== undefined) return this.keepOrFail(entry, er.problem);
        const pe = parsers.parsePostmanEnvironment(er.value);
        envValues = pe.values;
        entry.loadProblems.push(...pe.problems.map((p) => `${link.environment}: ${p}`));
      } else if (link.environment) {
        // an environment chosen by name changes the servers: part of what an approval is for (§21.16)
        hash.update(`environment:${link.environment}`);
      }
    } catch (e) {
      this.keepOrFail(entry, (e as Error).message);
      return;
    }
    let parsed: ParsedCollection;
    let credentials: string[] = [];
    let own: ReadonlyMap<string, string> = new Map();
    let environments: string[] | undefined;
    try {
      const fileVars = () => parsers.mergeCollectionVars(link.variables, envValues, new Map());
      if (format === 'postman') {
        own = parsers.postmanCollectionVariables(doc);
        parsed = parsers.parsePostman(doc, parsers.mergeCollectionVars(link.variables, envValues, own));
        credentials = parsers.sanitisePostman(doc).removed;
      } else if (format === 'openapi') {
        parsed = parsers.parseOpenApi(doc, fileVars());
      } else if (format === 'swagger' && parsers.parseSwagger2Doc) {
        parsed = parsers.parseSwagger2Doc(doc, fileVars());
      } else if (format === 'insomnia' && parsers.parseInsomniaDoc) {
        const src = parsers.parseInsomniaDoc(doc, sourceOptions(link));
        // REVIEW-16 #9: the chosen sub-environment's values stay on the host, for masking only
        let srcEnv: ReadonlyMap<string, string> | undefined;
        ({ environments, envValues: srcEnv, ...parsed } = src);
        if (srcEnv) envValues = new Map(srcEnv);
      } else {
        this.keepOrFail(entry, `${link.file}: ${formatLabel(format)} files can't be read here`);
        return;
      }
    } catch (e) {
      // the parsers never throw by contract; a bug there must not take the panel down
      this.deps.log?.(`collection ${link.id}: parser failed: ${(e as Error).message}`);
      this.keepOrFail(entry, `${link.file}: couldn't be read (an internal error; see the Flutter Intercept log)`);
      return;
    }
    const result: ParseResult = { key, parsed, credentials, contentHash: hash.digest('hex'), envValues, dynVars: dynamicVars(link, own), ...(environments ? { environments } : {}) };
    this.cache.set(key, result);
    entry.good = result;
  }

  /**
   * CONTRACTS §24.4: the files of the Bruno collection whose `bruno.json` is `rel` — `bruno.json` and every `.bru`
   * below its folder. Realpath-checked (the folder inside the workspace, no symbolic link anywhere below it), hidden
   * folders and `node_modules` skipped, within `brunoLimits` (≤ 2 000 files, depth ≤ 32, ≤ 20 MB): past a limit the
   * collection is refused, never read in part. Nothing is read here but directory listings and sizes.
   */
  private async walkBruno(rel: string, folderPath: string): Promise<{ root: string; files: WalkedFile[]; dirs: string[]; problems: string[] }> {
    const { fs } = this.deps;
    const top = await this.readFile(rel, folderPath, BRUNO_FILE_SPEC);
    const root = path.dirname(top.real);
    // the link itself must not go through a symbolic link either (`readFile` only checked where it resolves)
    let plain: string;
    try {
      plain = path.join(fs.realpathSync(folderPath), ...rel.split('/'));
    } catch {
      throw new Error('The workspace folder is no longer there');
    }
    if (plain !== top.real) throw new Error(`${rel} goes through a symbolic link; a Bruno collection is only read as plain files in the project`);
    const files: WalkedFile[] = [{ ...top, rel: 'bruno.json' }];
    const dirs = [root];
    const problems: string[] = [];
    let total = top.size;
    let visited = 0;
    let links = 0;
    const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }];
    while (queue.length) {
      const dir = queue.shift()!;
      let entries: Awaited<ReturnType<RulesFs['readdir']>>;
      try {
        entries = await fs.readdir(dir.abs);
      } catch {
        problems.push(`${dir.rel || 'The collection folder'} can't be read`);
        continue;
      }
      entries = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const bru: { abs: string; relPath: string }[] = [];
      for (const ent of entries) {
        if (++visited > BRUNO_MAX_ENTRIES) throw new Error(`${rel}: its folder holds more than ${BRUNO_MAX_ENTRIES} files and folders (not read as a Bruno collection)`);
        const name = ent.name;
        if (name.startsWith('.') || name === 'node_modules') continue;
        const isDir = ent.isDirectory();
        if (dir.rel === '' && name === 'bruno.json') continue; // already listed
        const abs = path.join(dir.abs, name);
        const relPath = dir.rel ? `${dir.rel}/${name}` : name;
        let real: string;
        try {
          real = fs.realpathSync(abs);
        } catch {
          continue; // gone, or a dangling link
        }
        if (real !== abs) {
          // a symbolic link (to a file or a folder, inside or outside the project): never followed
          if (links++ < 5) problems.push(`${relPath} is a symbolic link (not read)`);
          continue;
        }
        if (isDir) {
          if (dir.depth + 1 > brunoLimits.depth) throw new Error(`${rel}: folders are nested deeper than ${brunoLimits.depth} (not read)`);
          dirs.push(abs);
          queue.push({ abs, rel: relPath, depth: dir.depth + 1 });
          continue;
        }
        if (!/\.bru$/i.test(name)) continue; // only request files are ever read (never .env, scripts, data files)
        bru.push({ abs, relPath });
      }
      // PERF-5 #3: this folder's request files stat-ed a few at a time, taken in name order as before
      const stats = inOrder(bru, BRUNO_IO_WINDOW, async (c) => {
        try {
          return { c, st: await fs.stat(c.abs) };
        } catch {
          return { c, st: undefined };
        }
      });
      for await (const { c, st } of stats) {
        const { abs, relPath } = c;
        if (!st?.isFile()) continue;
        if (files.length >= brunoLimits.files) throw new Error(`${rel}: more than ${brunoLimits.files} request files in the collection folder (not read)`);
        total += st.size;
        if (total > brunoLimits.totalBytes) throw new Error(`${rel}: the collection's files are larger than 20 MB in all (not read)`);
        // REVIEW-16 #15g: the file's identity on disk (when the fs reports one), so the read can check it is this file
        const id = st as { dev?: unknown; ino?: unknown };
        const onDisk = typeof id.dev === 'number' && typeof id.ino === 'number' ? { dev: id.dev, ino: id.ino } : {};
        files.push({ real: abs, size: st.size, mtimeMs: st.mtimeMs, rel: relPath, ...onDisk });
      }
    }
    if (links > 5) problems.push(`… and ${links - 5} more symbolic links (not read)`);
    return { root, files, dirs, problems };
  }

  /** CONTRACTS §24.4: walks, reads (cached by a hash of paths, sizes and mtimes) and parses a Bruno collection. */
  private async readBruno(link: Pick<CollectionLink, 'file' | 'environment' | 'variables'>, folderPath: string, watch: boolean): Promise<ParseResult> {
    const { fs, parsers } = this.deps;
    if (!parsers.parseBruno) throw new Error(`${link.file}: Bruno collections can't be read here`);
    const walked = await this.walkBruno(link.file, folderPath);
    if (watch) for (const d of walked.dirs) this.deps.watchFolder?.(d);
    const listing = createHash('sha256').update(JSON.stringify(walked.files.map((f) => [f.rel, f.size, f.mtimeMs]))).digest('hex');
    const key = JSON.stringify(['bruno', walked.root, listing, walked.problems, link.variables, link.environment ?? null]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const hash = createHash('sha256');
    const files: BrunoFile[] = [];
    const problems = [...walked.problems];
    let total = 0;
    // PERF-5 #3: read a few at a time, each through its checked descriptor; taken in walk order as before
    // PERF-5 #3: reads run side by side, so each one first takes its size from the 20 MB budget (never 16 × 20 MB held)
    let reserved = 0;
    const reserve = (n: number): boolean => (reserved += n) <= brunoLimits.totalBytes;
    const tooLarge = () => new Error(`${link.file}: the collection's files are larger than 20 MB in all (not read)`);
    for await (const { f, bytes } of inOrder(walked.files, BRUNO_IO_WINDOW, async (f): Promise<{ f: WalkedFile; bytes: Uint8Array | undefined | typeof OVER_BUDGET }> => ({ f, bytes: await this.readWalked(f, reserve) }))) {
      if (bytes === OVER_BUDGET) throw tooLarge();
      if (!bytes) {
        problems.push(`${f.rel} changed while the collection was read (skipped)`);
        continue;
      }
      total += bytes.byteLength;
      if (total > brunoLimits.totalBytes) throw tooLarge();
      let text: string;
      try {
        text = decodeWorkspaceFile(bytes, f.rel, BRUNO_FILE_SPEC);
      } catch {
        problems.push(`${f.rel} is not UTF-8 text (skipped)`);
        continue;
      }
      hash.update(f.rel).update('\0').update(text).update('\0');
      files.push({ path: f.rel, text });
    }
    if (link.environment) hash.update(`environment:${link.environment}`);
    let src: SourceParsed;
    try {
      src = parsers.parseBruno(files, sourceOptions(link));
    } catch (e) {
      this.deps.log?.(`collection ${link.file}: parser failed: ${(e as Error).message}`);
      throw new Error(`${link.file}: couldn't be read (an internal error; see the Flutter Intercept log)`);
    }
    // REVIEW-16 #9: `environments/<name>.bru` values stay on the host, for masking only
    const { environments, envValues, ...parsed } = src;
    return { key, parsed: { ...parsed, problems: [...problems, ...parsed.problems] }, credentials: [], contentHash: hash.digest('hex'), envValues: new Map(envValues ?? []), dynVars: dynamicVars(link, new Map()), environments };
  }

  /**
   * REVIEW-16 #15g: a walked file, read through the descriptor that is checked — opened without following a
   * symbolic link (and without waiting on a pipe), then `fstat`: still a regular file, the same device and inode the
   * walk saw. Undefined when it is no longer that file. An fs that reports no identity (in-memory, virtual) is read
   * as before.
   */
  private async readWalked(f: WalkedFile, reserve?: (bytes: number) => boolean): Promise<Uint8Array | undefined | typeof OVER_BUDGET> {
    if (f.dev === undefined || f.ino === undefined) return this.deps.fs.readFile(f.real);
    let h: Awaited<ReturnType<typeof fsPromises.open>>;
    try {
      h = await fsPromises.open(f.real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    } catch {
      return undefined; // gone, or now a symbolic link
    }
    try {
      const st = await h.stat();
      if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino || st.size > brunoLimits.totalBytes) return undefined;
      if (reserve && !reserve(st.size)) return OVER_BUDGET;
      return await h.readFile();
    } finally {
      await h.close().catch(() => undefined);
    }
  }

  private async loadBruno(entry: Entry): Promise<void> {
    try {
      const result = await this.readBruno(entry.link, entry.folderPath, true);
      this.cache.set(result.key, result);
      entry.good = result;
    } catch (e) {
      this.keepOrFail(entry, (e as Error).message);
    }
  }

  private keepOrFail(entry: Entry, problem: string): void {
    entry.loadProblems.push(entry.good ? `${problem} — using the last good version` : problem);
  }

  private buildRules(entry: Entry): void {
    const parsed = entry.good?.parsed;
    entry.approved = this.isApproved(entry);
    entry.matcher = undefined;
    entry.seenCache = new Map();
    entry.limited = new Map();
    entry.limitedExtra = 0;
    entry.limitReasons = [];
    if (!parsed) {
      entry.rules = [];
      entry.stats = undefined;
      entry.ruleProblems = [];
      entry.meta = new Map();
      entry.auth = undefined;
      return;
    }
    const eff = this.effective(entry);
    // CONTRACTS §22.6: the resources that remember are answered by the store (handler rules)
    const set = this.storeSettings(entry);
    const handlerId = `${COLLECTION_RULE_PREFIX}${entry.link.id}`;
    const stateful = entry.store && entry.detection
      ? { handlerId, resources: entry.detection.resources.filter((x) => set.resources[x.name]?.off !== true) }
      : undefined;
    // CONTRACTS §24: the auth gate, examples by body and dynamic values need the handler too (only on a handler host)
    entry.dynamicMode = set.dynamic;
    entry.auth = undefined;
    let pipeline: PipelineRulesOptions | undefined;
    const pipe = this.deps.setHandler ? this.pipeOf(entry.good!) : undefined;
    if (pipe) {
      entry.auth = this.authRuntime(parsed, set, pipe);
      pipeline = { handlerId, ...(entry.auth.enabled ? { auth: entry.auth.gated } : {}), body: new Set(pipe.matchers.keys()), vars: entry.good!.dynVars };
    }
    const r = toRules(parsed, { id: entry.link.id, name: parsed.name || entry.link.id, selected: eff.selected, off: eff.off, unmatched: eff.unmatched, ...(stateful ? { stateful } : {}), ...(pipeline ? { pipeline } : {}) });
    entry.stats = r.stats;
    entry.ruleProblems = r.problems;
    entry.meta = r.meta;
    entry.limitedExtra = 0;
    // CONTRACTS §21.16: limited answers until this exact collection (files + URL variables) is approved
    if (entry.approved) {
      entry.rules = r.rules;
      return;
    }
    const reasons = new Set<LimitReason>();
    entry.rules = r.rules.map((rule) => {
      const l = limitAnswer(rule);
      if (!l) return rule;
      entry.limited.set(rule.id, l.removed);
      for (const x of l.reasons) reasons.add(x);
      return l.rule;
    });
    // §24: answers the pipeline can give besides a rule's own example are limited at answer time; count them here so
    // "Review & approve" shows up for them too
    if (pipe) {
      const counted = new Set<MockExample>();
      const count = (x: MockExample | undefined) => {
        if (!x || counted.has(x)) return;
        counted.add(x);
        const l = limitHeaders(x.status, cleanHeaders(x.headers, []), x.body);
        if (!l.reasons.length && !l.removed.length) return;
        entry.limitedExtra++;
        for (const reason of l.reasons) reasons.add(reason);
      };
      const loginEp = entry.auth?.endpoints.login !== undefined ? pipe.byKey.get(entry.auth.endpoints.login) : undefined;
      for (const m of r.meta.values()) {
        const ep = m.endpoint !== undefined ? pipe.byKey.get(m.endpoint) : undefined;
        if (!ep || !m.needs) continue;
        if (m.needs.body) for (const bm of pipe.matchers.get(ep.key) ?? []) if (bm.example !== m.example) count(ep.examples.find((x) => x.name === bm.example));
        if (m.needs.auth) {
          const x = unauthorizedExample(ep, loginEp);
          if (x && x.name !== m.example) count(x);
        }
      }
    }
    entry.limitReasons = LIMIT_REASONS.filter((x) => reasons.has(x));
  }

  // ------------------------------------------------------------------ the answer pipeline's inputs (CONTRACTS §24)

  /** Endpoint lookup, body matchers (§24.2) and the detected auth requests (§24.1) of a parse; built once per parse. */
  private pipeOf(good: ParseResult): Pipe {
    if (good.pipe) return good.pipe;
    const endpoints = good.parsed.endpoints;
    const byKey = new Map<string, MockEndpoint>();
    const matchers = new Map<string, BodyMatcher[]>();
    const bodyProblems: string[] = [];
    for (const ep of endpoints) {
      if (!byKey.has(ep.key)) byKey.set(ep.key, ep);
      if (!ep.examples.some((x) => x.request)) continue;
      try {
        const b = buildBodyMatchers(ep);
        if (b.matchers.length) matchers.set(ep.key, b.matchers);
        bodyProblems.push(...b.problems);
      } catch (e) {
        this.deps.log?.(`collection: examples by body of ${ep.method} ${displayPath(ep)} failed: ${(e as Error).message}`);
      }
    }
    let auth: AuthEndpoints & { problems: string[] } = { problems: [] };
    let protect: 'declared' | 'all' = 'all';
    try {
      auth = detectAuth(endpoints);
      protect = defaultProtect(endpoints);
    } catch (e) {
      this.deps.log?.(`collection: auth detection failed: ${(e as Error).message}`);
    }
    const dynamicIn = (t: unknown) => typeof t === 'string' && t.includes('{{$');
    const hasDynamic = endpoints.some((ep) => ep.examples.some((x) => dynamicIn(x.body) || Object.values(x.headers ?? {}).some(dynamicIn)));
    return (good.pipe = { byKey, matchers, bodyProblems: bodyProblems.slice(0, MAX_PROBLEMS), auth, protect, hasDynamic });
  }

  /** CONTRACTS §24.1: off unless a login request is found **and** the settings turn it on. */
  private authRuntime(parsed: ParsedCollection, set: StoreSettings, pipe: Pipe): AuthRuntime {
    const problems = [...pipe.auth.problems];
    const endpoints: AuthEndpoints = {
      ...(pipe.auth.login !== undefined ? { login: pipe.auth.login } : {}),
      ...(pipe.auth.refresh !== undefined ? { refresh: pipe.auth.refresh } : {}),
      ...(pipe.auth.logout !== undefined ? { logout: pipe.auth.logout } : {}),
    };
    for (const k of ['login', 'refresh'] as const) {
      const want = set.auth[k];
      if (want === undefined) continue;
      if (pipe.byKey.has(want)) endpoints[k] = want;
      else problems.push(`auth.${k} in the settings names a request that isn't in the collection (${endpoints[k] !== undefined ? 'the detected one is used' : 'ignored'}).`);
    }
    const available = endpoints.login !== undefined;
    const enabled = available && set.auth.enabled;
    if (set.auth.enabled && !available) problems.push('Sign-in simulation is on, but the collection has no login request (a POST ending in /login, /signin, /token, …).');
    const protect = set.auth.protect ?? pipe.protect;
    // CONTRACTS §24.9
    if (protect === 'declared' && pipe.protect === 'all') problems.push('The collection marks no request as needing a token, so none is checked. Choose all.');
    const gated = new Set<string>();
    if (enabled) {
      for (const ep of parsed.endpoints) {
        if (ep.key === endpoints.login || ep.key === endpoints.refresh || ep.key === endpoints.logout || isProtected(ep, protect, endpoints)) gated.add(ep.key);
      }
    }
    return { available, enabled, endpoints, protect, ttlSeconds: set.auth.ttlSeconds, gated, problems: problems.map((x) => cleanLine(x)) };
  }

  /**
   * CONTRACTS §24.3: the endpoints as the store is seeded from them — dynamic values in example bodies filled in
   * once, seeded by the link id (stable ids across reloads and restarts). The same array when nothing is dynamic.
   */
  private seedEndpoints(entry: Entry): MockEndpoint[] {
    const good = entry.good!;
    const cached = good.seeds?.get(entry.link.id);
    if (cached) return cached;
    const endpoints = good.parsed.endpoints;
    let out = endpoints;
    if (endpoints.some((ep) => ep.examples.some((x) => hasPlaceholders(x.body)))) {
      out = endpoints.map((ep) => {
        if (!ep.examples.some((x) => hasPlaceholders(x.body))) return ep;
        return {
          ...ep,
          examples: ep.examples.map((x, i) => {
            if (!hasPlaceholders(x.body)) return x;
            const body = renderDynamic(x.body, { mode: 'seeded', seed: seedOf(`${entry.link.id}\0${ep.key}\0${i}`), vars: good.dynVars, json: isJsonAnswer(x.headers, x.body) }).text;
            return body === x.body ? x : { ...x, body };
          }),
        };
      });
    }
    (good.seeds ??= new Map()).set(entry.link.id, out);
    return out;
  }

  // ------------------------------------------------------------------ overlay (CONTRACTS §21.15 #1)

  private overlays(): Record<string, Overlay> {
    const v = this.deps.memento.get<unknown>(OVERLAY_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Overlay>) : {};
  }

  private overlayOf(e: Pick<Entry, 'folderPath' | 'link'>): Overlay {
    const o = this.overlays()[this.overrideKey(e)];
    return o && typeof o === 'object' ? o : {};
  }

  /** The values in effect for this user: the overlay over the shared file's. */
  private effective(e: Entry): { selected: Record<string, string>; off: string[]; unmatched: 'passthrough' | 'fail' } {
    const o = this.overlayOf(e);
    const selected: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(e.link.selected)) selected[k] = v;
    for (const [k, v] of Object.entries(o.selected ?? {})) if (typeof v === 'string') selected[k] = v;
    const off = new Set(e.link.off);
    for (const [k, v] of Object.entries(o.off ?? {})) {
      if (v === true) off.add(k);
      else if (v === false) off.delete(k);
    }
    const unmatched = o.unmatched === 'fail' || o.unmatched === 'passthrough' ? o.unmatched : e.link.unmatched;
    return { selected, off: [...off], unmatched };
  }

  private overrideCount(e: Entry): number {
    const o = this.overlayOf(e);
    return Object.keys(o.selected ?? {}).length + Object.keys(o.off ?? {}).length + (o.unmatched ? 1 : 0);
  }

  private async writeOverlay(e: Entry, change: (o: Overlay) => Overlay): Promise<void> {
    const all = { ...this.overlays() };
    const k = this.overrideKey(e);
    const next = change({ selected: { ...(all[k]?.selected ?? {}) }, off: { ...(all[k]?.off ?? {}) }, ...(all[k]?.unmatched ? { unmatched: all[k].unmatched } : {}) });
    const empty = !Object.keys(next.selected ?? {}).length && !Object.keys(next.off ?? {}).length && !next.unmatched;
    if (empty) delete all[k];
    else all[k] = next;
    await this.deps.memento.update(OVERLAY_KEY, all);
  }

  // ------------------------------------------------------------------ approval (CONTRACTS §21.16)

  private approvalHash(e: Entry): string | undefined {
    if (!e.good) return undefined;
    const vars = Object.keys(e.link.variables).sort().map((k) => [k, e.link.variables[k]]);
    return createHash('sha256').update(JSON.stringify([e.folderPath, e.link.id, e.good.contentHash, vars])).digest('hex');
  }

  private approvals(): Record<string, string[]> {
    const v = this.deps.memento.get<unknown>(APPROVALS_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string[]>) : {};
  }

  private isApproved(e: Entry): boolean {
    const h = this.approvalHash(e);
    const list = this.approvals()[this.overrideKey(e)];
    return !!h && Array.isArray(list) && list.includes(h);
  }

  /** What approving `id` would allow (for the IDE's prompt); undefined when nothing is limited. */
  approvalSummary(id: string): { name: string; reasons: LimitReason[]; answers: number; origins: string[] } | undefined {
    const e = this.entry(id);
    const answers = e.limited.size + e.limitedExtra;
    if (!answers) return undefined;
    const origins = new Set<string>();
    for (const ep of e.good?.parsed.endpoints ?? []) if (ep.origin) origins.add(ep.origin);
    return { name: cleanLine(e.good?.parsed.name || e.link.id, 200), reasons: e.limitReasons, answers, origins: [...origins].slice(0, 10) };
  }

  /**
   * Approves the collection as it is now (files + URL variables). Only the IDE calls this, after asking the user
   * (src/mocks/service.ts); no agent tool reaches it.
   */
  approve(id: string): Promise<void> {
    return this.serial(async () => {
      const e = this.entry(id);
      const h = this.approvalHash(e);
      if (!h) throw new Error(`"${e.link.id}" can't be approved until its file can be read`);
      const all = { ...this.approvals() };
      const k = this.overrideKey(e);
      all[k] = [...(all[k] ?? []).filter((x) => x !== h), h].slice(-MAX_APPROVALS_PER_COLLECTION);
      await this.deps.memento.update(APPROVALS_KEY, all);
      await this.reloadNow();
    });
  }

  private signature(): string {
    return JSON.stringify([this.state(false), this.rules().map((r) => [r.id, r.match, r.action]), this.fileProblemList]);
  }

  // ------------------------------------------------------------------ reading

  private enabledOverrides(): Record<string, boolean> {
    const v = this.deps.memento.get<unknown>(ENABLED_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
  }

  private overrideKey(e: Pick<Entry, 'folderPath' | 'link'>): string {
    return `${e.folderPath}\0${e.link.id}`;
  }

  private isEnabled(e: Entry): boolean {
    const o = this.enabledOverrides()[this.overrideKey(e)];
    return typeof o === 'boolean' ? o : e.link.enabled;
  }

  /** Problems of the shared files' `collections` entries themselves (shown with the shared-rules problems). */
  fileProblems(): string[] {
    return capProblems(this.fileProblemList);
  }

  /** `withSeen` false: without `seen` (change detection; `seen` changes with traffic, not with the collection). */
  state(withSeen = true): CollectionStatus[] {
    const passthrough = (this.deps.passthroughHosts?.() ?? []).map((h) => h.toLowerCase());
    return this.entries.map((e) => {
      const parsed = e.good?.parsed;
      const stats = e.stats;
      const unresolved = new Set<string>();
      const origins = new Set<string>();
      for (const ep of parsed?.endpoints ?? []) {
        for (const u of ep.unresolved) unresolved.add(u);
        if (ep.origin) origins.add(ep.origin);
      }
      // §24.2: why an example can't be chosen by the request body (field names only), on a handler host
      const bodyProblems = this.deps.setHandler && e.good ? this.pipeOf(e.good).bodyProblems : [];
      const problems = [...e.loadProblems, ...(parsed?.problems ?? []), ...e.ruleProblems, ...bodyProblems];
      // REVIEW-15 #8: a host passed through without decryption never reaches the collection's rules
      for (const o of origins) {
        let u: URL;
        try {
          u = new URL(o);
        } catch {
          continue;
        }
        const port = u.port || (u.protocol === 'https:' ? '443' : '80');
        if (passthrough.includes(u.hostname) || passthrough.includes(`${u.hostname}:${port}`)) {
          problems.unshift(`Requests to ${u.host} are passed through without decryption (the app's own certificate or pinning), so this collection can't answer them.`);
        }
      }
      const drift = e.good ? driftSummary(this.driftViews(e)) : undefined;
      if (e.good?.credentials.length) {
        problems.unshift(
          `${e.link.file} holds credentials (${e.good.credentials.slice(0, 5).map((c) => cut(c, 60)).join(', ')}${e.good.credentials.length > 5 ? ', …' : ''}). Don't commit it as it is: import it again and choose "Copy without credentials".`,
        );
      }
      return {
        id: e.link.id,
        name: cut(parsed?.name || e.link.id),
        file: e.link.file,
        ...(parsed ? { format: parsed.format } : {}),
        enabled: this.isEnabled(e),
        unmatched: this.effective(e).unmatched,
        endpoints: stats?.endpoints ?? 0,
        mocked: stats?.mocked ?? 0,
        noExample: stats?.noExample ?? 0,
        generated: stats?.generated ?? 0,
        off: stats?.off ?? 0,
        unresolved: [...unresolved],
        origins: [...origins],
        problems: capProblems(problems),
        overrides: this.overrideCount(e),
        ...(e.limited.size + e.limitedExtra ? { limited: { reasons: [...e.limitReasons], answers: e.limited.size + e.limitedExtra } } : {}),
        ...(withSeen && this.deps.exchanges ? { seen: this.seen(e, origins) } : {}),
        ...(this.storeAvailable(e) ? { store: this.storeStatusOf(e) } : {}),
        ...(drift ? { drift } : {}),
      };
    });
  }

  // ------------------------------------------------------------------ traffic (CONTRACTS §21.15 #2–#4)

  /** Every endpoint as a rule (none off, passthrough), with meta: which endpoint a request belongs to. */
  private matcherOf(e: Entry): NonNullable<Entry['matcher']> {
    if (e.matcher) return e.matcher;
    const parsed = e.good?.parsed;
    if (!parsed) return (e.matcher = { compiled: [], meta: new Map() });
    const r = toRules(parsed, { id: e.link.id, name: parsed.name || e.link.id, selected: {}, off: [], unmatched: 'passthrough' });
    return (e.matcher = { compiled: compileRules(r.rules), meta: r.meta });
  }

  private seen(e: Entry, origins: Set<string>): NonNullable<CollectionStatus['seen']> {
    const notIn = new Map<string, { method: string; path: string; count: number }>();
    const noExample = new Map<string, number>();
    if (!origins.size) return { notInCollection: [], noExample: [] };
    const all = this.deps.exchanges?.() ?? [];
    const prefix = `${COLLECTION_RULE_PREFIX}${e.link.id}:`;
    for (const ex of all.slice(-MAX_SEEN_EXCHANGES)) {
      let c = e.seenCache.get(ex.id);
      if (!c) {
        c = this.classify(e, ex, origins, prefix);
        if (ex.state !== 'pending' && ex.state !== 'paused-request' && ex.state !== 'paused-response') e.seenCache.set(ex.id, c);
      }
      if (c.kind === 'no-example') noExample.set(c.key, (noExample.get(c.key) ?? 0) + 1);
      else if (c.kind === 'not-in') {
        const n = notIn.get(c.key);
        if (n) n.count++;
        else {
          const [method, ...rest] = c.key.split(' ');
          notIn.set(c.key, { method, path: rest.join(' '), count: 1 });
        }
      }
    }
    if (e.seenCache.size > MAX_SEEN_EXCHANGES * 2) e.seenCache = new Map();
    const top = <T extends { count: number }>(xs: T[]) => xs.sort((a, b) => b.count - a.count).slice(0, MAX_SEEN);
    return {
      notInCollection: top([...notIn.values()]),
      noExample: top([...noExample].map(([endpoint, count]) => ({ endpoint, count }))),
    };
  }

  private classify(e: Entry, ex: Exchange, origins: Set<string>, prefix: string): { kind: 'none' | 'not-in' | 'no-example'; key: string } {
    const none = { kind: 'none' as const, key: '' };
    if (ex.kind === 'tunnel' || ex.kind === 'grpc') return none;
    let u: URL;
    try {
      u = new URL(ex.url);
    } catch {
      return none;
    }
    if (!origins.has(`${u.protocol}//${u.host}`.toLowerCase())) return none;
    const notIn = { kind: 'not-in' as const, key: `${ex.method.toUpperCase()} ${pathTemplate(u.pathname)}` };
    if (ex.matchedRuleId?.startsWith(prefix)) {
      const m = e.meta.get(ex.matchedRuleId);
      if (m?.noExample && m.endpoint) return { kind: 'no-example', key: m.endpoint };
      return m?.unmatched ? notIn : none;
    }
    if (ex.matchedRuleId) return none; // a rule of the user's answered it
    return findRule(this.matcherOf(e).compiled, ex.method, ex.url) ? none : notIn;
  }

  /** CONTRACTS §21.15 #2: which collection endpoint / example answered, for an exchange's `matchedRuleId`. */
  describeRule(ruleId: string | undefined): CollectionAnswer | undefined {
    if (!ruleId?.startsWith(COLLECTION_RULE_PREFIX)) return undefined;
    for (const e of this.entries) {
      const m = e.meta.get(ruleId);
      if (!m) continue;
      const limited = e.limited.get(ruleId);
      // `needs` / `query` are the handler's own business
      const { needs: _needs, query: _query, ...shown } = m;
      return { id: e.link.id, name: cleanLine(e.good?.parsed.name || e.link.id, 200), ...shown, ...(limited ? { limited } : {}) };
    }
    return undefined;
  }

  /**
   * CONTRACTS §21.15 #3: the endpoint key of collection `id` for a request the agent saw — the one that answered it,
   * else the one whose rule matches its method and URL. Throws a readable error when the collection has none.
   */
  endpointForRequest(id: string, ex: Pick<Exchange, 'method' | 'url' | 'matchedRuleId'>): string {
    const e = this.entry(id);
    const answered = ex.matchedRuleId ? e.meta.get(ex.matchedRuleId)?.endpoint : undefined;
    if (answered) return answered;
    const { compiled, meta } = this.matcherOf(e);
    const hit = findRule(compiled, ex.method, ex.url);
    const key = hit ? meta.get(hit.id)?.endpoint : undefined;
    if (!key) throw new Error(`${ex.method} ${cleanLine(ex.url.replace(/[?#].*$/s, ''), 200)} is not in collection "${e.link.id}"`);
    return key;
  }

  /** The rules of every enabled collection, in file order (CONTRACTS §21.5). */
  rules(): Rule[] {
    return this.entries.filter((e) => this.isEnabled(e)).flatMap((e) => e.rules);
  }

  private entry(id: string): Entry {
    const e = this.entries.find((x) => x.link.id === id);
    if (!e) throw new Error(`No collection "${cut(String(id), 60)}" is linked`);
    return e;
  }

  private endpointOf(e: Entry, key: string): MockEndpoint {
    const ep = e.good?.parsed.endpoints.find((x) => x.key === key);
    if (!ep) throw new Error(`The collection "${e.link.id}" has no request "${cut(String(key), 120)}"`);
    return ep;
  }

  endpoints(id: string): CollectionEndpointView[] {
    const e = this.entry(id);
    const eff = this.effective(e);
    const off = new Set(eff.off);
    const overlay = this.overlayOf(e);
    // REVIEW-15 #5: an environment value that ends up in a path is shown as {{name}}, never as its value
    const env = [...(e.good?.envValues ?? new Map<string, string>())].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
    const mask = (p: string) => env.reduce((acc, [name, v]) => acc.split(v).join(`{{${name}}}`), p);
    const matchers = this.deps.setHandler && e.good ? this.pipeOf(e.good).matchers : undefined;
    const drift = this.driftViews(e);
    return (e.good?.parsed.endpoints ?? []).map((ep) => {
      const epDrift = drift.filter((v) => v.endpoint === ep.key);
      // CONTRACTS §24.2: the request-body fields an example is chosen by (names only; a body never leaves the host)
      const fields = new Map<string, string[]>();
      for (const m of matchers?.get(ep.key) ?? []) if (!fields.has(m.example)) fields.set(m.example, m.fields.slice(0, MAX_BODY_FIELDS).map((f) => cleanLine(f, 100)));
      const url = ep.origin ? `${ep.origin}${mask(displayPath(ep))}` : ep.key.slice(ep.key.indexOf(' ') + 1).replace(/ #\d+$/, '');
      const sel = eff.selected[ep.key];
      const overridden = (overlay.selected && ep.key in overlay.selected) || (overlay.off && ep.key in overlay.off);
      return {
        key: ep.key,
        method: ep.method,
        name: cut(ep.name),
        folder: ep.folder.map((f) => cut(f)),
        url,
        examples: ep.examples.map((x) => ({
          name: cut(x.name),
          status: x.status,
          ...(x.generated ? { generated: true as const } : {}),
          ...(x.query ? { query: x.query } : {}),
          ...(fields.has(x.name) ? { byBody: fields.get(x.name)! } : {}),
        })),
        ...(sel !== undefined && ep.examples.some((x) => x.name === sel) ? { selected: sel } : {}),
        ...(off.has(ep.key) ? { off: true as const } : {}),
        ...(ep.unresolved.length ? { unresolved: ep.unresolved } : {}),
        ...(overridden ? { overridden: true as const } : {}),
        ...(epDrift.length ? { drift: epDrift } : {}),
      };
    });
  }

  example(id: string, endpoint: string, name: string): { status: number; headers: Record<string, string>; body: string; truncated?: true } {
    const e = this.entry(id);
    const ep = this.endpointOf(e, endpoint);
    const x = ep.examples.find((y) => y.name === name);
    if (!x) throw new Error(`The request "${cut(endpoint, 120)}" has no example "${cut(String(name), 120)}"`);
    const max = COLLECTION_LIMITS.panelBodyBytes;
    const bytes = new TextEncoder().encode(x.body);
    if (bytes.byteLength <= max) return { status: x.status, headers: { ...x.headers }, body: x.body };
    const body = new TextDecoder().decode(bytes.subarray(0, max)).replace(/�$/, '');
    return { status: x.status, headers: { ...x.headers }, body, truncated: true };
  }

  /** A personal, editable copy of what answers `endpoint` now ("Edit as a rule"), with a new id. */
  toRule(id: string, endpoint: string): Rule {
    const e = this.entry(id);
    const ep = this.endpointOf(e, endpoint);
    const parsed = e.good!.parsed;
    const one: ParsedCollection = { ...parsed, endpoints: [ep] };
    const { rules } = toRules(one, { id: e.link.id, name: parsed.name || e.link.id, selected: this.effective(e).selected, off: [], unmatched: 'passthrough' });
    const base = rules[rules.length - 1];
    if (!base) throw new Error(`"${cut(endpoint, 120)}" can't be mocked yet: ${ep.unresolved.length ? `set ${ep.unresolved.join(', ')} first` : 'its URL is not usable'}`);
    // CONTRACTS §24.3: a rule is a fixed answer — dynamic values are filled in once, and the name says so
    if (this.deps.setHandler && base.action.kind === 'mock') {
      const a = base.action;
      const r = this.render(e, { headers: a.headers ?? {}, body: a.body });
      if (r.changed) return { ...base, id: this.deps.newRuleId(), name: cutMiddle(`${base.name ?? ''} · dynamic values filled in once`), action: { ...a, headers: r.headers, body: r.body } };
    }
    return { ...base, id: this.deps.newRuleId() };
  }

  // ------------------------------------------------------------------ changing

  private async writeLink(e: Entry, change: (l: CollectionLink) => CollectionLink): Promise<void> {
    const folder = this.deps.links().find((f) => f.folderPath === e.folderPath);
    const links = folder?.links ?? [];
    if (!links.some((l) => l.id === e.link.id)) throw new Error(`The collection "${e.link.id}" is no longer in ${e.label}`);
    await this.deps.saveLinks(
      e.folderPath,
      links.map((l) => (l.id === e.link.id ? change(l) : l)),
    );
  }

  /**
   * CONTRACTS §21.7 / §21.15: one or more changes. `enabled` is personal; `example`, `off` and `unmatched` go to this
   * user's overlay (`scope` 'me', the default) or to the shared file (`scope` 'team', which also clears the same
   * entries from the overlay); `variable` always goes to the shared file. `reset` clears the overlay (all of it, or
   * one endpoint's) and can't be combined with other changes.
   */
  update(id: string, patch: CollectionPatch): Promise<void> {
    return this.serial(async () => {
      const e = this.entry(id);
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch must be an object');
      const keys = Object.keys(patch);
      const known = ['enabled', 'unmatched', 'variable', 'example', 'off', 'scope', 'reset', 'endpoint'];
      if (!keys.length) throw new Error('patch is empty');
      const unknown = keys.find((k) => !known.includes(k));
      if (unknown) throw new Error(`patch: unknown field "${cut(unknown, 40)}"`);
      if (patch.scope !== undefined && patch.scope !== 'me' && patch.scope !== 'team') throw new Error('scope must be "me" or "team"');
      const scope = patch.scope ?? 'me';
      if (patch.reset !== undefined) {
        if (patch.reset !== true) throw new Error('reset must be true');
        if (scope !== 'me') throw new Error('reset clears your own changes: it takes scope "me"');
        if (keys.some((k) => !['reset', 'scope', 'endpoint'].includes(k))) throw new Error('reset can\'t be combined with other changes');
        if (patch.endpoint !== undefined) {
          if (typeof patch.endpoint !== 'string') throw new Error('endpoint must be a request key');
          this.endpointOf(e, patch.endpoint);
        }
        const one = patch.endpoint;
        await this.writeOverlay(e, (o) => {
          if (one === undefined) return {};
          delete o.selected?.[one];
          delete o.off?.[one];
          return o;
        });
        await this.reloadNow();
        return;
      }
      if (patch.endpoint !== undefined) throw new Error('endpoint is only used with reset');
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('enabled must be true or false');
      if (patch.unmatched !== undefined && patch.unmatched !== 'passthrough' && patch.unmatched !== 'fail') throw new Error('unmatched must be "passthrough" or "fail"');
      const v = patch.variable;
      if (v !== undefined) {
        if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !VARIABLE_NAME.test(v.name)) throw new Error('variable.name must be a variable name such as "baseUrl"');
        if (typeof v.value !== 'string' || v.value.length > MAX_VARIABLE_VALUE || /[\r\n\0]/.test(v.value)) throw new Error(`variable.value must be one line of text (at most ${MAX_VARIABLE_VALUE} characters)`);
        // REVIEW-15 #8: a variable that stands for a server must be a plain http(s) URL or host name (no credentials)
        if (v.value !== '' && this.isOriginVariable(e, v.name) && !ORIGIN_VALUE.test(v.value.trim())) {
          throw new Error(`{{${v.name}}} stands for a server: use an http:// or https:// URL such as https://api.example.com (no user name or password)`);
        }
      }
      const x = patch.example;
      if (x !== undefined) {
        if (!x || typeof x !== 'object' || typeof x.endpoint !== 'string' || typeof x.name !== 'string') throw new Error('example must be {endpoint, name}');
        const ep = this.endpointOf(e, x.endpoint);
        if (!ep.examples.some((y) => y.name === x.name)) throw new Error(`The request "${cut(x.endpoint, 120)}" has no example "${cut(x.name, 120)}"`);
      }
      const o = patch.off;
      if (o !== undefined) {
        if (!o || typeof o !== 'object' || typeof o.endpoint !== 'string' || typeof o.off !== 'boolean') throw new Error('off must be {endpoint, off}');
        this.endpointOf(e, o.endpoint);
      }

      if (patch.enabled !== undefined) {
        const all = { ...this.enabledOverrides() };
        const k = this.overrideKey(e);
        if (patch.enabled === e.link.enabled) delete all[k];
        else all[k] = patch.enabled;
        await this.deps.memento.update(ENABLED_KEY, all);
      }
      const personal = scope === 'me' && (patch.unmatched !== undefined || x !== undefined || o !== undefined);
      if (personal) {
        await this.writeOverlay(e, (ov) => {
          if (patch.unmatched !== undefined) ov.unmatched = patch.unmatched;
          if (x) (ov.selected ??= {})[x.endpoint] = x.name;
          if (o) (ov.off ??= {})[o.endpoint] = o.off;
          return ov;
        });
      }
      const team = (scope === 'team' && (patch.unmatched !== undefined || x !== undefined || o !== undefined)) || v !== undefined;
      if (team) {
        await this.writeLink(e, (l) => {
          const n: CollectionLink = { ...l, variables: { ...l.variables }, selected: { ...l.selected }, off: [...l.off] };
          if (scope === 'team') {
            if (patch.unmatched !== undefined) n.unmatched = patch.unmatched;
            if (x) n.selected[x.endpoint] = x.name;
            if (o) n.off = o.off ? [...new Set([...n.off, o.endpoint])] : n.off.filter((k) => k !== o.endpoint);
          }
          if (v) {
            if (v.value === '') delete n.variables[v.name];
            else n.variables[v.name] = v.value.trim();
          }
          return n;
        });
        if (scope === 'team' && (patch.unmatched !== undefined || x || o)) {
          // "Save for the team": the shared value now is the user's; drop the same entries from their overlay
          await this.writeOverlay(e, (ov) => {
            if (patch.unmatched !== undefined) delete ov.unmatched;
            if (x) delete ov.selected?.[x.endpoint];
            if (o) delete ov.off?.[o.endpoint];
            return ov;
          });
        }
      }
      await this.reloadNow();
    });
  }

  /** Whether `{{name}}` is used in the server part of any request URL of the collection. */
  private isOriginVariable(e: Entry, name: string): boolean {
    const needle = `{{${name}}}`;
    for (const ep of e.good?.parsed.endpoints ?? []) {
      if (ep.unresolved.includes(name)) return true;
      const tpl = ep.key.slice(ep.key.indexOf(' ') + 1);
      const at = tpl.indexOf(needle);
      if (at < 0) continue;
      const before = tpl.slice(0, at);
      if (before === '' || /^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(before)) return true;
    }
    return false;
  }

  /** Removes the link (never the collection file) and its personal override. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const e = this.entry(id);
      const folder = this.deps.links().find((f) => f.folderPath === e.folderPath);
      await this.deps.saveLinks(
        e.folderPath,
        (folder?.links ?? []).filter((l) => l.id !== id),
      );
      const k = this.overrideKey(e);
      const all = { ...this.enabledOverrides() };
      if (k in all) {
        delete all[k];
        await this.deps.memento.update(ENABLED_KEY, all);
      }
      const overlays = { ...this.overlays() };
      if (k in overlays) {
        delete overlays[k];
        await this.deps.memento.update(OVERLAY_KEY, overlays);
      }
      const stores = { ...this.storeOverlays() };
      if (k in stores) {
        delete stores[k];
        await this.deps.memento.update(STORES_OVERLAY_KEY, stores);
      }
      await this.reloadNow();
    });
  }

  /**
   * Links a collection that is already inside the workspace (`file`: workspace-relative, checked; `environment`: a
   * workspace-relative Postman environment file, or — CONTRACTS §24.4 — the name of an environment of an Insomnia /
   * Bruno collection). The id comes from the collection's name. Resolves to the new id.
   */
  addLink(pick: { file: string; environment?: string; folderPath?: string; unmatched?: 'passthrough' | 'fail' }): Promise<{ id: string }> {
    return this.serial(async () => {
      const folderPath = pick.folderPath ?? (await this.deps.primaryFolderPath());
      if (!folderPath) throw new Error('Open the Flutter project folder to mock from a collection');
      const file = relativePath(pick.file);
      if (!file) throw new Error('The collection must be a file inside the workspace');
      // REVIEW-15 #4: the link is committed; a file in a build-output folder (gitignored in Flutter projects, e.g. an
      // agent's export under .dart_tool/) would be missing for everyone else
      const built = (p: string) => /^(?:\.dart_tool|build)\//.test(p);
      if (built(file)) throw new Error(`${file} is in a build folder that isn't committed: move it into the project (e.g. api/) first`);
      const peek = await this.peekFile(file, folderPath);
      let environment: string | undefined;
      if (pick.environment !== undefined) {
        if (peek.format === 'insomnia' || peek.format === 'bruno') {
          // by name, and only one the collection has (never guessed)
          environment = environmentName(pick.environment);
          if (!environment || !peek.environments.includes(environment)) {
            throw new Error(`"${cut(String(pick.environment), 60)}" is not an environment of this ${formatLabel(peek.format)} collection${peek.environments.length ? `; it has: ${peek.environments.slice(0, 20).map((n) => cleanLine(n, 60)).join(', ')}` : ' (it has none)'}`);
          }
        } else {
          environment = relativePath(pick.environment);
          if (!environment) throw new Error('The environment must be a file inside the workspace');
          if (built(environment)) throw new Error(`${environment} is in a build folder that isn't committed: move it into the project (e.g. api/) first`);
        }
      }
      const folders = this.deps.links();
      const all = folders.flatMap((f) => f.links);
      if (all.length >= COLLECTION_LIMITS.linksPerFile) throw new Error(`At most ${COLLECTION_LIMITS.linksPerFile} collections can be linked`);
      const existing = all.find((l) => l.file === file);
      if (existing) throw new Error(`${file} is already linked (collection "${existing.id}")`);
      const fallbackName = peek.format === 'bruno' ? path.basename(path.dirname(`/${file}`)) || 'bruno' : path.basename(file).replace(/\.(postman_collection\.)?(json|ya?ml)$/i, '');
      const id = slugId(peek.name ?? fallbackName, new Set(all.map((l) => l.id)));
      if (!LINK_ID.test(id)) throw new Error('No usable name for the collection');
      if (pick.unmatched !== undefined && pick.unmatched !== 'passthrough' && pick.unmatched !== 'fail') throw new Error('unmatched must be "passthrough" or "fail"');
      const link: CollectionLink = { id, file, ...(environment ? { environment } : {}), variables: {}, enabled: true, unmatched: pick.unmatched ?? 'passthrough', selected: {}, off: [] };
      const mine = folders.find((f) => f.folderPath === folderPath)?.links ?? [];
      await this.deps.saveLinks(folderPath, [...mine, link]);
      await this.reloadNow();
      return { id };
    });
  }

  /**
   * Reads and checks a collection inside the workspace: its format, its name (Postman `info.name`, OpenAPI / Swagger
   * `info.title`, the Insomnia workspace, Bruno's `bruno.json`) and — CONTRACTS §24.4 — the environments an Insomnia
   * or Bruno collection offers (names only).
   */
  private async peekFile(rel: string, folderPath: string): Promise<{ format: CollectionFormat; name?: string; environments: string[] }> {
    const { parsers } = this.deps;
    const named = (n: unknown) => (typeof n === 'string' && n.trim() ? n.trim() : undefined);
    if (isBrunoLinkFile(rel)) {
      const r = await this.readBruno({ file: rel, variables: {} }, folderPath, false);
      return { format: 'bruno', name: named(r.parsed.name), environments: r.environments ?? [] };
    }
    const st = await checkWorkspaceFile(rel, folderPath, this.deps.workspaceRoots(), this.deps.fs, COLLECTION_FILE_SPEC);
    const text = decodeWorkspaceFile(await this.deps.fs.readFile(st.real), rel, COLLECTION_FILE_SPEC);
    const r = isYamlFile(rel) ? parseYaml(text, rel) : parseJsonText(text, rel);
    if (r.problem !== undefined) throw new Error(r.problem);
    const detected = parsers.detectFormat(r.value);
    if (!detected.format) throw new Error(`${rel}: ${detected.problem ?? NOT_A_COLLECTION}`);
    if (detected.format === 'insomnia') {
      if (!parsers.parseInsomniaDoc) throw new Error(`${rel}: Insomnia files can't be read here`);
      const src = parsers.parseInsomniaDoc(r.value, {});
      return { format: 'insomnia', name: named(src.name), environments: src.environments };
    }
    const info = (r.value as { info?: { name?: unknown; title?: unknown } }).info;
    return { format: detected.format, name: named(detected.format === 'postman' ? info?.name : info?.title), environments: [] };
  }

  /**
   * CONTRACTS §24.4: the environments a collection file inside the workspace offers by name (Insomnia, Bruno; empty for
   * the other formats), for the import prompt. Never their values.
   */
  environmentsOf(file: string, folderPath?: string): Promise<string[]> {
    return this.serial(async () => {
      const folder = folderPath ?? (await this.deps.primaryFolderPath());
      const rel = relativePath(file);
      if (!folder || !rel) return [];
      return (await this.peekFile(rel, folder)).environments;
    });
  }

  /**
   * "Copy into the workspace" (§21.6): writes `text` (a collection read from outside the workspace by the IDE) to
   * `.vscode/flutter-intercept/collections/<slug>.<ext>` in the primary folder — a Postman collection without
   * credentials when `mode` is `sanitised` — never over an existing file. Resolves to the workspace-relative path.
   */
  copyIn(text: string, fileName: string, mode: 'sanitised' | 'as-is'): Promise<{ file: string; removed: string[] }> {
    return this.serial(async () => {
      const folderPath = await this.deps.primaryFolderPath();
      if (!folderPath) throw new Error('Open the Flutter project folder to mock from a collection');
      if (new TextEncoder().encode(text).byteLength > COLLECTION_LIMITS.fileBytes) throw new Error(`${fileName} is larger than 20 MB`);
      if (isBrunoLinkFile(fileName)) throw new Error(copyRefusal(fileName, 'bruno'));
      const yaml = isYamlFile(fileName);
      const r = yaml ? parseYaml(text, fileName) : parseJsonText(text, fileName);
      if (r.problem !== undefined) throw new Error(r.problem);
      const detected = this.deps.parsers.detectFormat(r.value);
      if (!detected.format) throw new Error(`${fileName}: ${detected.problem ?? NOT_A_COLLECTION}`);
      // CONTRACTS §24.4: a copy without credentials can't be made for these formats yet, so they are never copied in
      if (detected.format !== 'postman' && detected.format !== 'openapi') throw new Error(copyRefusal(fileName, detected.format));
      let out = text;
      let removed: string[] = [];
      if (mode === 'sanitised' && detected.format === 'postman') {
        const s = this.deps.parsers.sanitisePostman(r.value);
        out = `${JSON.stringify(s.doc, null, 2)}\n`;
        removed = s.removed;
      }
      const stem = slugId(fileName.replace(/\.(postman_collection\.)?(json|ya?ml)$/i, ''), new Set());
      const ext = yaml && out === text ? (/\.yml$/i.test(fileName) ? 'yml' : 'yaml') : 'json';
      const rel = await this.freeCollectionPath(folderPath, stem, ext);
      await this.deps.writeWorkspaceFile(folderPath, rel, out);
      return { file: rel, removed };
    });
  }

  /** `.vscode/flutter-intercept/collections/<stem>.<ext>`, or `<stem>-2`, `-3`, … when the name is taken. */
  private async freeCollectionPath(folderPath: string, stem: string, ext: string): Promise<string> {
    // REVIEW-15 #8: a name already in the folder is never replaced — a dangling symlink included (stat follows links)
    const taken = await this.namesIn(path.join(folderPath, COLLECTIONS_DIR));
    let rel = `${COLLECTIONS_DIR}/${stem}.${ext}`;
    for (let n = 2; taken.has(path.basename(rel)) || (await this.exists(path.join(folderPath, rel))); n++) rel = `${COLLECTIONS_DIR}/${stem}-${n}.${ext}`;
    return rel;
  }

  private async namesIn(dir: string): Promise<Set<string>> {
    try {
      return new Set((await this.deps.fs.readdir(dir)).map((d) => d.name));
    } catch {
      return new Set();
    }
  }

  private async exists(abs: string): Promise<boolean> {
    try {
      await this.deps.fs.stat(abs);
      return true;
    } catch {
      return false;
    }
  }

  /** The format of a document read by the IDE (for the copy question), or undefined when it is none of them. */
  formatOf(text: string, fileName: string): CollectionFormat | undefined {
    if (isBrunoLinkFile(fileName)) return 'bruno';
    const r = isYamlFile(fileName) ? parseYaml(text, fileName) : parseJsonText(text, fileName);
    return r.problem === undefined ? this.deps.parsers.detectFormat(r.value).format : undefined;
  }

  /** Names of URL variables a collection still needs (for the import prompt). */
  unresolved(id: string): string[] {
    return this.state().find((s) => s.id === id)?.unresolved ?? [];
  }

  // ------------------------------------------------------------------ stateful mocks (CONTRACTS §22)

  /** Exchange id → the store operation that answered it (the last `STORE_LIMITS.exchangeOps`). */
  private ops = new Map<string, StoreOpView>();
  /** Handler ids registered with the proxy host. */
  private handlers = new Set<string>();
  // ---- CONTRACTS §24
  /** Sessions per link (`folder\0id`), in memory only: never in the store, dumps, snapshots or any output but a count. */
  private sessions = new Map<string, AuthSessions>();
  /** One line per link when sessions were dropped at the cap (shown with the auth problems). */
  private authNotes = new Map<string, string>();
  /** Answers rendered per link in 'seeded' mode (the n-th answer of a run always gets the same values). */
  private renderSeq = new Map<string, number>();
  /** Exchange id → what the pipeline answered with when it isn't the rule's own example (the last 5 000). */
  private answers = new Map<string, PipelineAnswerView>();

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private storeOverlays(): Record<string, StoreOverlay> {
    const v = this.deps.memento.get<unknown>(STORES_OVERLAY_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, StoreOverlay>) : {};
  }

  private storeOverlayOf(e: Pick<Entry, 'folderPath' | 'link'>): StoreOverlay {
    const o = this.storeOverlays()[this.overrideKey(e)];
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  }

  /** The store settings in effect for this user: the overlay over the shared file's entry. */
  private storeSettings(e: Entry): StoreSettings {
    const file = e.storeLink;
    const o = this.storeOverlayOf(e);
    const resources: Record<string, ResourceOverride> = Object.create(null);
    for (const src of [file?.resources ?? {}, o.resources && typeof o.resources === 'object' ? o.resources : {}]) {
      for (const [name, v] of Object.entries(src)) {
        const c = checkResourceOverride(v);
        if (c.value) resources[name] = { ...resources[name], ...c.value };
      }
    }
    const snap = 'snapshot' in o && (o.snapshot === null || (typeof o.snapshot === 'string' && SNAPSHOT_NAME.test(o.snapshot))) ? o.snapshot : file?.snapshot;
    const enabled = typeof o.enabled === 'boolean' ? o.enabled : file?.enabled ?? true;
    // CONTRACTS §24.1 / §24.3: the same overlay rules; `login` / `refresh` are the file's only
    const fa: StoreAuthLink = file?.auth ?? {};
    const oa = o.auth && typeof o.auth === 'object' && !Array.isArray(o.auth) ? o.auth : {};
    const protect = oa.protect === 'declared' || oa.protect === 'all' ? oa.protect : fa.protect;
    const auth: StoreSettings['auth'] = {
      enabled: typeof oa.enabled === 'boolean' ? oa.enabled : fa.enabled ?? false,
      ttlSeconds: isTtlSeconds(oa.ttlSeconds) ? oa.ttlSeconds : fa.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      ...(protect ? { protect } : {}),
      ...(fa.login !== undefined ? { login: fa.login } : {}),
      ...(fa.refresh !== undefined ? { refresh: fa.refresh } : {}),
    };
    const dynamic = isDynamicMode(o.dynamic) ? o.dynamic : file?.dynamic ?? this.defaultDynamic();
    return { enabled, ...(snap ? { snapshot: snap } : {}), resources, auth, dynamic };
  }

  /** CONTRACTS §24.3: 'random' in the IDE; a host (the CLI) may default to 'seeded'. */
  private defaultDynamic(): DynamicMode {
    return isDynamicMode(this.deps.dynamic?.mode) ? this.deps.dynamic!.mode! : 'random';
  }

  /** A store can run: a handler host, a parsed collection that is on for this user. */
  private storeAvailable(e: Entry): boolean {
    return !!this.deps.setHandler && !!e.good;
  }

  /**
   * Detection (cached by the parse and the id-field overrides, never with `off`: turned-off resources are still
   * listed) and the store: kept while the parse, the id fields, `enabled` and the starting snapshot stay the same.
   */
  private async prepareStore(entry: Entry, prev: Entry | undefined): Promise<void> {
    const parsed = entry.good?.parsed;
    entry.store = undefined;
    entry.storeKey = undefined;
    entry.detection = undefined;
    if (!parsed || !this.storeAvailable(entry)) return;
    this.deps.watchSnapshots?.(entry.folderPath, entry.link.id);
    entry.snapshots = await this.listSnapshots(entry);
    const set = this.storeSettings(entry);
    const ids: Record<string, ResourceOverride> = Object.create(null);
    for (const name of Object.keys(set.resources).sort()) if (set.resources[name].idField) ids[name] = { idField: set.resources[name].idField };
    const dkey = JSON.stringify([entry.good!.key, Object.entries(ids)]);
    if (prev?.detection?.key === dkey) entry.detection = prev.detection;
    else {
      let r: { resources: Resource[]; problems: string[] };
      try {
        // REVIEW-16 #8: resource names never hold an environment value (they reach notes, agents, snapshot files)
        r = detectResources(this.seedEndpoints(entry), ids, { envValues: entry.good!.envValues });
      } catch (e) {
        this.deps.log?.(`collection ${entry.link.id}: resource detection failed: ${(e as Error).message}`);
        r = { resources: [], problems: ['Resources could not be read from this collection.'] };
      }
      entry.detection = { key: dkey, resources: r.resources, problems: r.problems.map((p) => cleanLine(p)) };
    }
    if (!set.enabled || !this.isEnabled(entry) || !entry.detection.resources.length) {
      entry.dataProblems = [];
      return;
    }
    const skey = JSON.stringify([dkey, set.snapshot ?? null]);
    if (prev?.store && prev.storeKey === skey) {
      entry.store = prev.store;
      entry.storeKey = skey;
      entry.storeProblems = prev.storeProblems;
      return;
    }
    // §24.3: seeds with their dynamic values filled in once (stable ids)
    const store = new ResourceStore(entry.detection.resources, this.seedEndpoints(entry), { envValues: entry.good!.envValues });
    entry.dataProblems = [];
    if (set.snapshot) {
      try {
        const snap = await this.readSnapshot(entry, set.snapshot);
        entry.storeProblems = store.load(snap, { asStart: true }).map((p) => cleanLine(`Snapshot "${set.snapshot}": ${p}`));
      } catch (e) {
        entry.storeProblems = [cleanLine(`${(e as Error).message}; the data starts from the collection's examples`)];
      }
    } else entry.storeProblems = [];
    entry.store = store;
    entry.storeKey = skey;
    if (prev?.store) this.deps.onStoreChange?.(entry.link.id, undefined);
  }

  /** One proxy handler per link that has a `handler` rule (a store, the auth gate, examples by body, dynamic values); the others are removed. */
  private syncHandlers(): void {
    const set = this.deps.setHandler;
    if (!set) return;
    const want = new Set(this.entries.filter((e) => this.isEnabled(e) && e.rules.some((r) => r.action.kind === 'handler')).map((e) => `${COLLECTION_RULE_PREFIX}${e.link.id}`));
    for (const id of this.handlers) if (!want.has(id)) set(id, undefined);
    for (const id of want) {
      if (this.handlers.has(id)) continue;
      const linkId = id.slice(COLLECTION_RULE_PREFIX.length);
      set(id, (req) => this.handle(linkId, req));
    }
    this.handlers = want;
  }

  // ------------------------------------------------------------------ sessions and rendering (CONTRACTS §24.1, §24.3)

  private sessionsOf(e: Entry): AuthSessions {
    const k = this.overrideKey(e);
    let s = this.sessions.get(k);
    if (!s) this.sessions.set(k, (s = new AuthSessions()));
    return s;
  }

  /** Sessions end with what they belong to: the link removed or off for this user, auth simulation off or gone. */
  private pruneSessions(): void {
    for (const k of [...this.sessions.keys()]) {
      const e = this.entries.find((x) => this.overrideKey(x) === k);
      if (e?.auth?.enabled && this.isEnabled(e)) continue;
      this.sessions.get(k)?.clear();
      this.sessions.delete(k);
      this.authNotes.delete(k);
    }
    for (const k of [...this.renderSeq.keys()]) if (!this.entries.some((x) => this.overrideKey(x) === k)) this.renderSeq.delete(k);
  }

  private clearSessions(e: Entry): void {
    const k = this.overrideKey(e);
    this.sessions.get(k)?.clear();
    this.sessions.delete(k);
    this.authNotes.delete(k);
    this.renderSeq.delete(k);
  }

  /** The values one answer is rendered with: one seed per answer in 'seeded' mode, the host's clock in 'random'. */
  private dynamicContext(e: Entry): Omit<DynamicContext, 'json'> {
    const vars = e.good?.dynVars ?? new Map<string, string>();
    const mode = e.dynamicMode;
    if (mode === 'seeded') {
      const k = this.overrideKey(e);
      const n = this.renderSeq.get(k) ?? 0;
      this.renderSeq.set(k, n + 1);
      const base = Number.isFinite(this.deps.dynamic?.seed) ? Number(this.deps.dynamic!.seed) : 0;
      return { mode, seed: (seedOf(e.link.id) + base + n) >>> 0, vars };
    }
    return mode === 'random' ? { mode, vars, nowMs: this.now() } : { mode, vars };
  }

  /**
   * CONTRACTS §24.3: an example as it is answered now — dynamic values and the link's / collection's `{{variables}}`
   * filled into the body and into header values an approval is not about. `changed` false = exactly as written.
   */
  private render(e: Entry, x: Pick<MockExample, 'headers' | 'body'>): { headers: Record<string, string>; body: string; changed: boolean } {
    const headers = cleanHeaders(x.headers, []);
    let body = x.body;
    let changed = false;
    let ctx: Omit<DynamicContext, 'json'> | undefined;
    const context = (json: boolean): DynamicContext => ({ ...(ctx ??= this.dynamicContext(e)), json });
    if (hasPlaceholders(body)) {
      const r = renderDynamic(body, context(isJsonAnswer(headers, body)));
      if (r.text !== body) {
        body = r.text;
        changed = true;
      }
    }
    for (const [k, v] of Object.entries(headers)) {
      if (isLimitedHeader(k) || !hasPlaceholders(v)) continue;
      const text = renderDynamic(v, context(false)).text;
      if (text === v || text.length > MAX_HEADER_VALUE || BAD_HEADER_VALUE.test(text)) continue;
      Object.defineProperty(headers, k, { value: text, enumerable: true, writable: true, configurable: true });
      changed = true;
    }
    return { headers, body, changed };
  }

  private remember<T>(map: Map<string, T>, exchangeId: string | undefined, value: T): void {
    if (exchangeId === undefined) return;
    map.delete(exchangeId);
    map.set(exchangeId, value);
    if (map.size > STORE_LIMITS.exchangeOps) map.delete(map.keys().next().value as string);
  }

  /** An example as the pipeline answers it: rendered, limited until the collection is approved. `quiet`: the rule's own example — as written, the proxy answers its fallback. */
  private exampleAnswer(e: Entry, x: MockExample, note: string | undefined, quiet: boolean): HandlerResponse | HandlerFallback {
    const r = this.render(e, x);
    if (quiet && !r.changed) return { fallback: true, ...(note ? { note } : {}) };
    const headers = e.approved ? r.headers : limitHeaders(x.status, r.headers, r.body).headers;
    return { status: x.status, headers, body: r.body, ...(note ? { note } : {}) };
  }

  /** CONTRACTS §24.1: the endpoint's 401 example, else the login request's, else `{"error":"unauthorized"}`. */
  private unauthorized(e: Entry, ep: MockEndpoint, loginEp: MockEndpoint | undefined, exchangeId: string | undefined, why: 'noToken' | 'expired'): HandlerResponse | HandlerFallback {
    const note = why === 'expired' ? AUTH_NOTES.expired : AUTH_NOTES.noToken;
    const found = unauthorizedExample(ep, loginEp);
    const x = found && typeof found.body === 'string' ? found : undefined;
    this.remember(this.answers, exchangeId, { auth: why === 'expired' ? '401 expired' : '401 no token', ...(x ? { example: x.name } : {}) });
    if (x) return this.exampleAnswer(e, x, note, false);
    return { status: 401, headers: JSON_HEADERS(), body: UNAUTHORIZED_BODY, note };
  }

  /**
   * REVIEW-16 #4: a JSON request body without its secret-named fields (`password`, `pass`, `token`, `otp` … at any
   * depth, `secrets.ts`) before the store keeps it, so no password sent to any endpoint is kept, listed, snapshotted
   * or answered back. Other bodies (not JSON, truncated, nothing secret) are passed as they are.
   */
  private static withoutSecretBodyFields(body: { text: string; truncated?: boolean } | undefined): { text: string; truncated?: boolean } | undefined {
    if (!body || body.truncated || body.text.length > STORE_LIMITS.recordBytes * 2 || !/[{[]/.test(body.text)) return body;
    let value: unknown;
    try {
      value = JSON.parse(body.text) as unknown;
    } catch {
      return body;
    }
    if (value === null || typeof value !== 'object') return body;
    const removed = new Set<string>();
    const next = withoutSecretFields(value, removed);
    return removed.size ? { text: JSON.stringify(next) } : body;
  }

  /**
   * CONTRACTS §22.9 / §24: a request a `handler` rule of collection `id` matched. One pipeline: auth gate → query
   * example → body example → store → default example → dynamic values → limited headers. `{fallback: true}` → the proxy
   * answers the rule's own example quietly (nothing needed rendering); undefined → the same with a note, e.g. when the
   * store was just dropped.
   *
   * The request body is read here to choose an example (§24.2), for the store, and for the login name (allow-listed
   * fields only, §24.1); it is never logged, kept or put in a note.
   */
  handle(id: string, req: HandlerRequest): HandlerResponse | HandlerFallback | undefined {
    const e = this.entries.find((x) => x.link.id === id);
    if (!e || !e.good || !req || typeof req.ruleId !== 'string') return undefined;
    const m = e.meta.get(req.ruleId);
    const pipe = this.pipeOf(e.good);
    const ep = m?.endpoint !== undefined ? pipe.byKey.get(m.endpoint) : undefined;
    if (!m || !ep) return undefined;
    // a rule that is no handler rule any more (the store or the gate was just turned off): the proxy answers its example
    if (!m.needs && !m.op && m.resource === undefined) return undefined;
    const exchangeId = typeof req.exchangeId === 'string' ? req.exchangeId : undefined;
    const contentType = headerOf(req.headers, 'content-type');
    let body: { text: string; truncated?: boolean } | undefined;
    if (req.body) {
      const text = req.body.encoding === 'base64' ? Buffer.from(req.body.text, 'base64').toString('utf8') : req.body.text;
      body = { text, ...(req.body.truncated ? { truncated: true } : {}) };
    }
    let parsedBody: { value?: unknown } | undefined;
    const parsed = (): unknown => (parsedBody ??= body && !body.truncated && body.text.length <= MATCH_REQUEST_BYTES ? parseBodyForMatch(body.text, contentType) : {}).value;
    let pickedByBody: MockExample | undefined | null = null;
    const byBody = (): MockExample | undefined => {
      if (pickedByBody !== null) return pickedByBody;
      const matchers = m.needs?.body ? pipe.matchers.get(ep.key) : undefined;
      const name = matchers && body && !body.truncated ? chooseByBody(matchers, body.text, contentType) : undefined;
      const x = name !== undefined ? ep.examples.find((y) => y.name === name) : undefined;
      return (pickedByBody = x && Number.isInteger(x.status) && x.status >= 100 && x.status <= 599 && typeof x.body === 'string' ? x : undefined);
    };

    // ---- 1. auth gate (§24.1)
    const auth = e.auth?.enabled && m.needs?.auth ? e.auth : undefined;
    if (auth) {
      const sessions = this.sessionsOf(e);
      const now = this.now();
      const authorization = headerOf(req.headers, 'authorization');
      const loginEp = auth.endpoints.login !== undefined ? pipe.byKey.get(auth.endpoints.login) : undefined;
      const isLogin = ep.key === auth.endpoints.login;
      const isRefresh = ep.key === auth.endpoints.refresh;
      if (isLogin || isRefresh) {
        // any request is accepted — no password is read, kept or compared. A body example that matches and is not a
        // success ("Wrong password") answers instead, in the body-example step below.
        const chosen = byBody();
        if (!chosen || is2xx(chosen)) {
          const refreshing = isRefresh && (!isLogin || isRefreshGrant(parsed()));
          const template = chosen ?? ep.examples.find(is2xx) ?? (refreshing ? loginEp?.examples.find(is2xx) : undefined);
          if (template && typeof template.body === 'string') {
            const r = this.render(e, template);
            let result: { body: string; note?: string } | undefined;
            if (refreshing) {
              const token = refreshTokenOf(parsed()) ?? /^\s*bearer\s+(\S{1,4096})\s*$/i.exec(authorization ?? '')?.[1];
              result = token !== undefined ? sessions.refresh(token, r.body, e.dynamicMode, auth.ttlSeconds, now) : undefined;
              if (!result) return this.unauthorized(e, ep, loginEp, exchangeId, 'noToken');
            } else {
              // only the login name (allow-listed field names) is looked at, and only its hash is used
              result = sessions.login(r.body, e.dynamicMode, auth.ttlSeconds, now, loginIdentifier(parsed()));
            }
            if (result.note) this.authNotes.set(this.overrideKey(e), cleanLine(result.note));
            this.remember(this.answers, exchangeId, { auth: refreshing ? 'refreshed' : 'signed in', ...(template.name !== m.example ? { example: template.name } : {}) });
            this.deps.onAuthChange?.(id);
            const headers = e.approved ? r.headers : limitHeaders(template.status, r.headers, result.body).headers;
            return { status: template.status, headers, body: result.body, note: refreshing ? AUTH_NOTES.refreshed : AUTH_NOTES.signedIn };
          }
          // no success example to follow: the example answers and nobody is signed in
        }
      } else if (ep.key === auth.endpoints.logout) {
        if (sessions.logout(authorization)) this.deps.onAuthChange?.(id);
      } else {
        const check = sessions.check(authorization, now);
        if (check !== 'ok') return this.unauthorized(e, ep, loginEp, exchangeId, check === 'expired' ? 'expired' : 'noToken');
      }
    }

    // ---- 2. query example (§21.5): the rule's own example
    const own = m.example !== undefined ? ep.examples.find((y) => y.name === m.example) : undefined;
    if (m.query) return own ? this.exampleAnswer(e, own, undefined, true) : { fallback: true };

    // ---- 3. body example (§24.2). On a resource that remembers, only an error example on a create beats the store.
    const chosen = byBody();
    if (chosen && chosen !== own && (!m.op || (m.op === 'create' && !is2xx(chosen)))) {
      this.remember(this.answers, exchangeId, { example: chosen.name, byBody: true });
      return this.exampleAnswer(e, chosen, cleanLine(`example: ${chosen.name} (by body)`, 200), false);
    }

    // ---- 4. store (§22). REVIEW-16 #4: a sign-in request (the login / refresh request, detected or named in the
    // settings) is never a store op, also with sign-in simulation off: it answers by its examples as in 0.15, so the
    // password it carries is never kept, listed or answered back
    const authEps = e.auth?.endpoints ?? pipe.auth;
    const signIn = ep.key === authEps.login || ep.key === authEps.refresh;
    if ((m.resource !== undefined || m.op) && !signIn) {
      const store = e.store;
      const res = m.resource !== undefined ? e.detection?.resources.find((r) => r.name === m.resource) : undefined;
      if (!store || !m.op || !res) return undefined;
      let u: URL;
      try {
        u = new URL(req.url);
      } catch {
        return undefined;
      }
      const pattern = ITEM_OPS.has(m.op) ? [...res.listPath, { param: res.itemParam }] : res.listPath;
      const segs = u.pathname.split('/').filter((x) => x !== '');
      const params: Record<string, string> = Object.create(null);
      pattern.forEach((p, i) => {
        if (typeof p === 'string' || segs[i] === undefined) return;
        let v = segs[i];
        try {
          v = decodeURIComponent(v);
        } catch {
          // not valid percent-encoding: the value as sent
        }
        params[p.param] = v;
      });
      const query = [...u.searchParams].slice(0, 100) as [string, string][];
      const kept = m.op === 'create' || m.op === 'replace' || m.op === 'patch' ? MockCollectionsCore.withoutSecretBodyFields(body) : body;
      const a = store.handle({ resource: res.name, op: m.op, params, query, ...(kept ? { body: kept } : {}), ...(contentType !== undefined ? { contentType } : {}) });
      // CONTRACTS §21.16: limited until the collection is approved
      const headers = e.approved ? a.headers : limitHeaders(a.status, a.headers, a.body).headers;
      this.remember(this.ops, exchangeId, { resource: res.name, op: m.op, ...(a.itemId !== undefined ? { itemId: a.itemId } : {}) });
      if (WRITE_OPS.has(m.op)) this.deps.onStoreChange?.(id, res.name);
      return { status: a.status, headers, body: a.body, note: a.note };
    }

    // ---- 5. default example, with its dynamic values (§24.3)
    return own ? this.exampleAnswer(e, own, undefined, true) : { fallback: true };
  }

  /** CONTRACTS §24: what the pipeline answered an exchange with when it isn't the rule's own example (the last 5 000). */
  answerOf(exchangeId: string): PipelineAnswerView | undefined {
    const v = this.answers.get(exchangeId);
    return v ? { ...v } : undefined;
  }

  /**
   * CONTRACTS §24.1: every access token of collection `id` expires now (refresh tokens stay, so the app's refresh path
   * can be tested). Resolves to how many were still valid. Throws when auth simulation isn't on for it.
   */
  expireSessions(id: string): number {
    const e = this.entry(id);
    if (!e.auth?.enabled || !this.isEnabled(e)) throw new Error(`Sign-in simulation isn't on for "${e.link.id}"`);
    return this.sessions.get(this.overrideKey(e))?.expireAll(this.now()) ?? 0;
  }

  /**
   * CONTRACTS §24.1 (agents' `expire_token`): the collection with auth simulation on that answers `url` (a URL or URL
   * glob with a literal scheme and host), or undefined.
   */
  authCollectionFor(url: string): string | undefined {
    const m = /^(https?):\/\/([^/?#*]+)(?=[/?#]|$)/i.exec(String(url).trim());
    if (!m) return undefined;
    let origin: string;
    try {
      origin = new URL(`${m[1]}://${m[2]}`).origin.toLowerCase();
    } catch {
      return undefined;
    }
    for (const e of this.entries) {
      if (!e.auth?.enabled || !this.isEnabled(e)) continue;
      if ((e.good?.parsed.endpoints ?? []).some((ep) => ep.origin !== undefined && e.auth!.gated.has(ep.key) && ep.origin.toLowerCase() === origin)) return e.link.id;
    }
    return undefined;
  }

  /** CONTRACTS §22.9: which store operation answered an exchange (the last 5 000). */
  storeOpOf(exchangeId: string): StoreOpView | undefined {
    const v = this.ops.get(exchangeId);
    return v ? { ...v } : undefined;
  }

  /** The proxy stopped: every store is dropped (and built again from its seed or starting snapshot). */
  dropStores(): Promise<void> {
    return this.serial(async () => {
      const had = this.entries.filter((e) => e.store);
      for (const e of this.entries) {
        e.store = undefined;
        e.storeKey = undefined;
        e.dataProblems = [];
      }
      // §24.1: sessions end with the proxy
      for (const s of this.sessions.values()) s.clear();
      this.sessions.clear();
      this.authNotes.clear();
      this.renderSeq.clear();
      this.answers.clear();
      this.ops.clear();
      await this.reloadNow();
      for (const e of had) this.deps.onStoreChange?.(e.link.id, undefined);
    });
  }

  private storeStatusOf(e: Entry): StoreStatus {
    const set = this.storeSettings(e);
    const overlay = this.storeOverlayOf(e);
    const counts = e.store?.counts() ?? {};
    const storeProblems = e.store?.problems ?? [];
    const resources: StoreResourceView[] = (e.detection?.resources ?? []).map((r) => {
      const own = overlay.resources?.[r.name];
      const problem = [...storeProblems, ...e.dataProblems].find((p) => p.startsWith(`${r.name}:`));
      return {
        name: r.name,
        path: displayPath({ path: maskPathSegments([...r.listPath, { param: r.itemParam }], e.good?.envValues) }),
        idField: r.idField,
        count: counts[r.name] ?? 0,
        remembers: set.resources[r.name]?.off !== true,
        detected: r.detected === true,
        ...(own && typeof own === 'object' && Object.keys(own).length ? { overridden: true as const } : {}),
        ...(r.generatedSeed ? { generatedSeed: true as const } : {}),
        ...(problem ? { problem: cleanLine(problem) } : {}),
      };
    });
    const problems = [...new Set([...(e.detection?.problems ?? []), ...e.storeProblems, ...storeProblems, ...e.dataProblems].map((p) => cleanLine(p)).filter(Boolean))];
    return {
      enabled: set.enabled,
      resources,
      snapshots: [...e.snapshots],
      ...(set.snapshot ? { startsFrom: set.snapshot } : {}),
      changed: !!e.store?.changed,
      ...(Object.keys(overlay).length ? { overridden: true as const } : {}),
      problems: problems.length > MAX_STORE_PROBLEMS ? [...problems.slice(0, MAX_STORE_PROBLEMS - 1), `… and ${problems.length - MAX_STORE_PROBLEMS + 1} more problems`] : problems,
      auth: this.authStatusOf(e, set),
      // CONTRACTS §24.9: only when the collection has `{{$…}}` values
      ...(e.good && this.pipeOf(e.good).hasDynamic ? { dynamic: set.dynamic } : {}),
    };
  }

  /** CONTRACTS §24.1: settings and a count of sessions — never a token, a login name or a password. */
  private authStatusOf(e: Entry, set: StoreSettings): StoreAuthStatus {
    const a = e.auth;
    const k = this.overrideKey(e);
    const note = this.authNotes.get(k);
    return {
      available: !!a?.available,
      enabled: !!a?.enabled,
      ...(a?.endpoints.login !== undefined ? { login: a.endpoints.login } : {}),
      ...(a?.endpoints.refresh !== undefined ? { refresh: a.endpoints.refresh } : {}),
      ttlSeconds: a?.ttlSeconds ?? set.auth.ttlSeconds,
      protect: a?.protect ?? set.auth.protect ?? 'all',
      sessions: a?.enabled ? this.sessions.get(k)?.count ?? 0 : 0,
      problems: [...(a?.problems ?? []), ...(note ? [note] : [])].slice(0, MAX_STORE_PROBLEMS),
    };
  }

  /**
   * CONTRACTS §22.9: the store of collection `id` (counts only). Throws for an unknown collection; undefined when this
   * host has no stateful mocks or the collection can't be read.
   */
  storeStatus(id: string): StoreStatus | undefined {
    const e = this.entry(id);
    return this.storeAvailable(e) ? this.storeStatusOf(e) : undefined;
  }

  private runningStore(e: Entry): ResourceStore {
    if (!this.storeAvailable(e)) throw new Error(`Stateful mocks aren't available for "${e.link.id}" here`);
    if (!e.store) {
      const why = !this.isEnabled(e) ? 'the collection is off for you' : !e.detection?.resources.length ? 'no resource was found in it' : 'remembering data is turned off for it';
      throw new Error(`"${e.link.id}" doesn't remember data right now (${why})`);
    }
    return e.store;
  }

  private resourceOf(e: Entry, name: unknown): Resource {
    const r = typeof name === 'string' ? e.detection?.resources.find((x) => x.name === name) : undefined;
    if (!r) throw new Error(`no such resource "${cut(String(name), 100)}" in collection "${e.link.id}"`);
    return r;
  }

  /** CONTRACTS §22.9: records of one resource (every parent's, unless `scope`), plain JSON. */
  storeItems(id: string, resource: string, opts: { offset?: number; limit?: number; filter?: string; scope?: Record<string, string> } = {}): { total: number; items: unknown[]; truncated?: true } {
    const e = this.entry(id);
    const r = this.resourceOf(e, resource);
    const store = this.runningStore(e);
    return store.items(r.name, {
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(typeof opts.filter === 'string' && opts.filter ? { filter: opts.filter.slice(0, 200) } : {}),
      ...(opts.scope && typeof opts.scope === 'object' ? { scope: opts.scope } : {}),
    });
  }

  /**
   * CONTRACTS §22.7 / §22.10: settings (`enabled`, `remembers`, `idField`, `startsFrom`; `scope` 'me' = this user's
   * overlay, 'team' = the shared file) and data (`put`, `remove`, `replace`, `generate`; never a file). `reset: 'data'`
   * puts the data back (one resource, or all), `reset: 'settings'` clears this user's overlay (one resource's, or all).
   * Re-sending what is already in effect changes nothing. Resolves to whether the settings (and so the rules) changed.
   */
  updateStore(id: string, patch: StorePatch): Promise<boolean> {
    return this.serial(async () => {
      const e = this.entry(id);
      if (!this.storeAvailable(e)) throw new Error(`Stateful mocks aren't available for "${e.link.id}" here`);
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch must be an object');
      const p = patch as Record<string, unknown>;
      const known = ['resource', 'enabled', 'remembers', 'idField', 'put', 'remove', 'replace', 'generate', 'startsFrom', 'scope', 'reset', 'auth', 'dynamic'];
      const keys = Object.keys(p).filter((k) => p[k] !== undefined);
      if (!keys.length) throw new Error('patch is empty');
      const unknown = keys.find((k) => !known.includes(k));
      if (unknown) throw new Error(`patch: unknown field "${cut(unknown, 40)}"`);
      if (p.scope !== undefined && p.scope !== 'me' && p.scope !== 'team') throw new Error('scope must be "me" or "team"');
      const scope = (p.scope as 'me' | 'team' | undefined) ?? 'me';
      const res = p.resource !== undefined ? this.resourceOf(e, p.resource) : undefined;

      if (p.reset !== undefined) {
        if (p.reset !== 'data' && p.reset !== 'settings') throw new Error('reset must be "data" or "settings"');
        if (keys.some((k) => !['reset', 'resource', 'scope'].includes(k))) throw new Error("reset can't be combined with other changes");
        if (p.reset === 'data') {
          // §24.1: resetting everything signs everyone out too (a collection may have sessions and no resources)
          const signedOut = !res && !!e.auth?.enabled;
          if (signedOut) this.clearSessions(e);
          if (!signedOut || e.store) {
            const store = this.runningStore(e);
            store.reset(res?.name);
          }
          e.dataProblems = [];
          this.deps.onStoreChange?.(e.link.id, res?.name);
          if (signedOut) this.deps.onAuthChange?.(e.link.id);
          return false;
        }
        if (scope !== 'me') throw new Error('reset clears your own settings: it takes scope "me"');
        const changed = await this.writeStoreOverlay(e, (o) => {
          if (!res) return {};
          if (o.resources) delete o.resources[res.name];
          return o;
        });
        if (changed) await this.reloadNow();
        return changed;
      }

      // ---- settings
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new Error('enabled must be true or false');
      if (p.remembers !== undefined && typeof p.remembers !== 'boolean') throw new Error('remembers must be true or false');
      if (p.idField !== undefined && (typeof p.idField !== 'string' || !ID_FIELD.test(p.idField) || p.idField === '__proto__')) throw new Error('idField must be a field name (1–100 characters)');
      if ((p.remembers !== undefined || p.idField !== undefined) && !res) throw new Error('remembers and idField need resource');
      if (p.startsFrom !== undefined && p.startsFrom !== null) {
        if (typeof p.startsFrom !== 'string' || !SNAPSHOT_NAME.test(p.startsFrom)) throw new Error('startsFrom must be a snapshot name (1–40 lower-case letters, digits or "-") or null');
        if (!e.snapshots.includes(p.startsFrom)) throw new Error(`no such snapshot "${p.startsFrom}" in collection "${e.link.id}"`);
      }
      // ---- CONTRACTS §24.1 / §24.3: sign-in simulation and dynamic values (settings; `auth.expire` is a data change)
      let authSet: { enabled?: boolean; ttlSeconds?: number; protect?: 'declared' | 'all' } | undefined;
      let expire = false;
      if (p.auth !== undefined) {
        const a = p.auth as Record<string, unknown> | null;
        if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('auth must be an object such as {enabled: true}');
        const bad = Object.keys(a).find((k) => !['enabled', 'ttlSeconds', 'protect', 'expire'].includes(k));
        if (bad) throw new Error(`auth: unknown field "${cut(bad, 40)}" (a password or token is never set here)`);
        if (a.enabled !== undefined && typeof a.enabled !== 'boolean') throw new Error('auth.enabled must be true or false');
        if (a.ttlSeconds !== undefined && !isTtlSeconds(a.ttlSeconds)) throw new Error('auth.ttlSeconds must be a whole number of seconds, 60–86400');
        if (a.protect !== undefined && a.protect !== 'declared' && a.protect !== 'all') throw new Error('auth.protect must be "declared" or "all"');
        if (a.expire !== undefined && a.expire !== 'all') throw new Error('auth.expire must be "all"');
        if (a.enabled === true && !e.auth?.available && !this.storeSettings(e).auth.enabled) {
          throw new Error(`No login request was found in "${e.link.id}" (a POST ending in /login, /signin, /token, …): sign-in simulation needs one`);
        }
        expire = a.expire === 'all';
        const one = {
          ...(a.enabled !== undefined ? { enabled: a.enabled as boolean } : {}),
          ...(a.ttlSeconds !== undefined ? { ttlSeconds: a.ttlSeconds as number } : {}),
          ...(a.protect !== undefined ? { protect: a.protect as 'declared' | 'all' } : {}),
        };
        if (Object.keys(one).length) authSet = one;
        else if (!expire) throw new Error('auth is empty: pass enabled, ttlSeconds, protect or expire');
      }
      if (p.dynamic !== undefined && !isDynamicMode(p.dynamic)) throw new Error('dynamic must be "random", "seeded" or "fixed"');
      // ---- data
      const dataKeys = ['put', 'remove', 'replace', 'generate'].filter((k) => p[k] !== undefined);
      if (expire) dataKeys.push('auth.expire');
      if (dataKeys.length > 1) throw new Error(`one data change at a time (${dataKeys.join(', ')})`);
      if (dataKeys.length && !res && !expire) throw new Error(`${dataKeys[0]} needs resource`);
      // checked before anything is written: expiring needs sign-in simulation on, now or by this very patch
      if (expire && !(authSet?.enabled ?? (e.auth?.enabled && this.isEnabled(e)))) throw new Error(`Sign-in simulation isn't on for "${e.link.id}"`);
      if (p.put !== undefined && (!p.put || typeof p.put !== 'object' || Array.isArray(p.put) || !('item' in (p.put as object)))) throw new Error('put must be {item}');
      if (p.remove !== undefined) {
        const r = p.remove as { itemId?: unknown } | null;
        if (!r || typeof r !== 'object' || typeof r.itemId !== 'string' || !r.itemId || r.itemId.length > COLLECTION_LIMITS.paramChars) throw new Error('remove must be {itemId} (at most 100 characters)');
      }
      if (p.replace !== undefined && (!Array.isArray(p.replace) || p.replace.length > STORE_LIMITS.recordsPerResource)) throw new Error(`replace must be a list of at most ${STORE_LIMITS.recordsPerResource} records`);
      if (p.generate !== undefined) {
        const g = p.generate as { count?: unknown } | null;
        if (!g || typeof g !== 'object' || !Number.isInteger(g.count) || (g.count as number) < 1 || (g.count as number) > STORE_LIMITS.generateCount) throw new Error(`generate must be {count} (1–${STORE_LIMITS.generateCount})`);
      }

      let settingsChanged = false;
      const settings = p.enabled !== undefined || p.remembers !== undefined || p.idField !== undefined || p.startsFrom !== undefined || authSet !== undefined || p.dynamic !== undefined;
      if (settings) {
        const apply = (o: StoreOverlay | StoreSettingsLink): void => {
          if (p.enabled !== undefined) o.enabled = p.enabled as boolean;
          if (authSet) o.auth = { ...(o.auth ?? {}), ...authSet };
          if (p.dynamic !== undefined) o.dynamic = p.dynamic as DynamicMode;
          if (p.startsFrom !== undefined) o.snapshot = p.startsFrom as string | null as string;
          if (res && (p.remembers !== undefined || p.idField !== undefined)) {
            const all: Record<string, ResourceOverride> = { ...(o.resources ?? {}) };
            const one: ResourceOverride = { ...(all[res.name] ?? {}) };
            if (p.remembers !== undefined) one.off = !(p.remembers as boolean);
            if (p.idField !== undefined) one.idField = p.idField as string;
            all[res.name] = one;
            o.resources = all;
          }
        };
        if (scope === 'me') {
          settingsChanged = await this.writeStoreOverlay(e, (o) => {
            apply(o);
            return o;
          });
        } else {
          if (!this.deps.saveStore) throw new Error("Saving data settings for the team isn't available here");
          const before = e.storeLink;
          const next: StoreSettingsLink = {
            collection: e.link.id,
            ...(before?.enabled !== undefined ? { enabled: before.enabled } : {}),
            ...(before?.snapshot ? { snapshot: before.snapshot } : {}),
            ...(before?.resources ? { resources: { ...before.resources } } : {}),
            ...(before?.auth ? { auth: { ...before.auth } } : {}),
            ...(before?.dynamic !== undefined ? { dynamic: before.dynamic } : {}),
          };
          apply(next);
          if (next.snapshot === null) delete next.snapshot;
          if (next.enabled === true) delete next.enabled;
          // "Save for the team" sends the values in effect: one that is only the default isn't written
          if (next.auth && before?.auth?.protect === undefined && e.good && next.auth.protect === this.pipeOf(e.good).protect) delete next.auth.protect;
          if (before?.dynamic === undefined && next.dynamic === this.defaultDynamic()) delete next.dynamic;
          if (next.resources) {
            for (const [n, v] of Object.entries(next.resources)) {
              const c: ResourceOverride = { ...(v.idField !== undefined ? { idField: v.idField } : {}), ...(v.off === true ? { off: true } : {}) };
              if (Object.keys(c).length) next.resources[n] = c;
              else delete next.resources[n];
            }
            if (!Object.keys(next.resources).length) delete next.resources;
          }
          if (JSON.stringify(normStoreLink(next)) !== JSON.stringify(normStoreLink(before ?? { collection: e.link.id }))) {
            await this.deps.saveStore(e.folderPath, e.link.id, next);
            e.storeLink = next;
            settingsChanged = true;
          }
          // "Save for the team": the shared value now is the user's; drop the same entries from their overlay
          const dropped = await this.writeStoreOverlay(e, (o) => {
            if (p.enabled !== undefined) delete o.enabled;
            if (p.startsFrom !== undefined) delete o.snapshot;
            if (p.dynamic !== undefined) delete o.dynamic;
            if (authSet && o.auth) {
              const mine = { ...o.auth };
              for (const k of Object.keys(authSet) as (keyof typeof authSet)[]) delete mine[k];
              if (Object.keys(mine).length) o.auth = mine;
              else delete o.auth;
            }
            if (res && o.resources?.[res.name]) {
              const one = { ...o.resources[res.name] };
              if (p.remembers !== undefined) delete one.off;
              if (p.idField !== undefined) delete one.idField;
              if (Object.keys(one).length) o.resources[res.name] = one;
              else delete o.resources[res.name];
            }
            return o;
          });
          settingsChanged ||= dropped;
        }
        if (settingsChanged) await this.reloadNow();
      }

      if (dataKeys.length && res) {
        const store = this.runningStore(e);
        let problems: string[] = [];
        if (p.put !== undefined) {
          problems = store.put(res.name, (p.put as { item: unknown }).item);
          if (problems.length) throw new Error(cleanLine(problems[0]));
        } else if (p.remove !== undefined) {
          const itemId = (p.remove as { itemId: string }).itemId;
          if (!store.remove(res.name, itemId)) throw new Error(`${res.name}: record ${cut(itemId, 60)} not found`);
        } else if (p.replace !== undefined) {
          problems = store.replace(res.name, p.replace as unknown[]);
        } else if (p.generate !== undefined) {
          problems = store.generate(res.name, (p.generate as { count: number }).count);
          if (problems.length) {
            this.deps.onStoreChange?.(e.link.id, res.name);
            throw new Error(cleanLine(problems[0]));
          }
        }
        e.dataProblems = problems.slice(0, MAX_STORE_PROBLEMS).map((x) => cleanLine(x));
        this.deps.onStoreChange?.(e.link.id, res.name);
      }
      if (expire) {
        // `e` may be stale after a settings change in the same patch
        this.expireSessions(e.link.id);
        this.deps.onAuthChange?.(e.link.id);
      }
      return settingsChanged;
    });
  }

  /** Changes this user's store overlay of `e`; resolves to whether it changed. */
  private async writeStoreOverlay(e: Entry, change: (o: StoreOverlay) => StoreOverlay): Promise<boolean> {
    const all = { ...this.storeOverlays() };
    const k = this.overrideKey(e);
    const cur = all[k] && typeof all[k] === 'object' ? all[k] : {};
    const next = change({ ...cur, ...(cur.resources ? { resources: { ...cur.resources } } : {}), ...(cur.auth && typeof cur.auth === 'object' ? { auth: { ...cur.auth } } : {}) });
    // a personal value equal to the team's is no override (as `enabled` of a collection, §21.14)
    const file = e.storeLink;
    if (next.enabled !== undefined && next.enabled === (file?.enabled ?? true)) delete next.enabled;
    if (next.dynamic !== undefined && next.dynamic === (file?.dynamic ?? this.defaultDynamic())) delete next.dynamic;
    if (next.auth) {
      const a = { ...next.auth };
      if (a.enabled !== undefined && a.enabled === (file?.auth?.enabled ?? false)) delete a.enabled;
      if (a.ttlSeconds !== undefined && a.ttlSeconds === (file?.auth?.ttlSeconds ?? DEFAULT_TTL_SECONDS)) delete a.ttlSeconds;
      if (a.protect !== undefined && a.protect === (file?.auth?.protect ?? (e.good ? this.pipeOf(e.good).protect : undefined))) delete a.protect;
      if (Object.keys(a).length) next.auth = a;
      else delete next.auth;
    }
    if ('snapshot' in next && (next.snapshot ?? undefined) === file?.snapshot) delete next.snapshot;
    for (const [n, v] of Object.entries(next.resources ?? {})) {
      if (!v || typeof v !== 'object') continue;
      const one = { ...v };
      if (one.off !== undefined && one.off === (file?.resources?.[n]?.off === true)) delete one.off;
      if (one.idField !== undefined && one.idField === file?.resources?.[n]?.idField) delete one.idField;
      next.resources![n] = one;
    }
    if (next.resources) {
      for (const n of Object.keys(next.resources)) if (!next.resources[n] || !Object.keys(next.resources[n]).length) delete next.resources[n];
      if (!Object.keys(next.resources).length) delete next.resources;
    }
    if (JSON.stringify(normOverlay(next)) === JSON.stringify(normOverlay(cur))) return false;
    if (!Object.keys(next).length) delete all[k];
    else all[k] = next;
    await this.deps.memento.update(STORES_OVERLAY_KEY, all);
    return true;
  }

  // ------------------------------------------------------------------ snapshots (CONTRACTS §22.8)

  private snapshotRel(e: Entry, name: string): string {
    if (!LINK_ID.test(e.link.id) || typeof name !== 'string' || !SNAPSHOT_NAME.test(name)) throw new Error('A snapshot name is 1–40 lower-case letters, digits or "-", such as "checkout"');
    return `${SNAPSHOTS_DIR}/${e.link.id}/${name}.json`;
  }

  /**
   * §21.6 / REVIEW-15 #4 checks for a snapshot location: inside the folder, not under `.dart_tool/` or `build/`, and no
   * existing part of the path (the file included) is a symbolic link that resolves elsewhere. Resolves to the absolute
   * path and whether the file exists.
   */
  private checkSnapshotPath(e: Entry, rel: string): { abs: string; exists: boolean } {
    const { fs } = this.deps;
    const norm = relativePath(rel);
    if (!norm || norm !== rel || /^(?:\.dart_tool|build)\//.test(norm)) throw new Error(`${cut(rel, 120)} can't be used for a snapshot`);
    const folder = e.folderPath;
    let realFolder: string;
    try {
      realFolder = fs.realpathSync(folder);
    } catch {
      throw new Error('The workspace folder is no longer there');
    }
    let cur = folder;
    let real = realFolder;
    let exists = true;
    for (const part of norm.split('/')) {
      cur = path.join(cur, part);
      const expected = path.join(real, part);
      try {
        real = fs.realpathSync(cur);
      } catch {
        exists = false;
        break;
      }
      // a symbolic link anywhere on the way (the file too) is refused, wherever it points
      if (real !== expected) throw new Error(`${cut(rel, 120)} goes through a symbolic link; snapshots are only read and written as plain files in the project`);
    }
    if (exists && !within(real, realFolder)) throw new Error(`${cut(rel, 120)} is outside the workspace folder`);
    return { abs: path.join(folder, norm), exists };
  }

  private async listSnapshots(e: Entry): Promise<string[]> {
    const dir = `${SNAPSHOTS_DIR}/${e.link.id}`;
    try {
      const { abs, exists } = this.checkSnapshotPath(e, dir);
      if (!exists) return [];
      const names = (await this.deps.fs.readdir(abs))
        .filter((d) => !d.isDirectory() && d.name.endsWith('.json'))
        .map((d) => d.name.slice(0, -5))
        .filter((n) => SNAPSHOT_NAME.test(n))
        .sort();
      return names.slice(0, STORE_LIMITS.snapshotsPerCollection);
    } catch {
      return [];
    }
  }

  private async readSnapshot(e: Entry, name: string): Promise<NonNullable<ReturnType<typeof parseSnapshot>['snapshot']>> {
    const rel = this.snapshotRel(e, name);
    const { exists } = this.checkSnapshotPath(e, rel);
    if (!exists) throw new Error(`no such snapshot "${name}" in collection "${e.link.id}" (not found)`);
    const st = await checkWorkspaceFile(rel, e.folderPath, [e.folderPath], this.deps.fs, SNAPSHOT_FILE_SPEC);
    const text = decodeWorkspaceFile(await this.deps.fs.readFile(st.real), rel, SNAPSHOT_FILE_SPEC);
    const parsed = parseSnapshot(text);
    if (!parsed.snapshot) throw new Error(`Snapshot "${name}" can't be used: ${parsed.problems[0] ?? 'not a snapshot'}`);
    return parsed.snapshot;
  }

  /**
   * CONTRACTS §22.8: `save` writes the data (redacted) to `.vscode/flutter-intercept/snapshots/<id>/<name>.json`
   * (replacing a snapshot of that name); `load` replaces the data of the resources the snapshot names; `delete`
   * removes the file. `path` is workspace-relative.
   */
  storeSnapshot(id: string, action: 'save' | 'load' | 'delete', name: string): Promise<{ path: string; resources: number; records: number; blanked?: string[] }> {
    return this.serial(async () => {
      const e = this.entry(id);
      if (!this.storeAvailable(e)) throw new Error(`Stateful mocks aren't available for "${e.link.id}" here`);
      if (action !== 'save' && action !== 'load' && action !== 'delete') throw new Error('action must be "save", "load" or "delete"');
      const rel = this.snapshotRel(e, name);
      if (action === 'save') {
        const store = this.runningStore(e);
        const { exists } = this.checkSnapshotPath(e, rel);
        if (!exists && (await this.listSnapshots(e)).length >= STORE_LIMITS.snapshotsPerCollection) {
          throw new Error(`At most ${STORE_LIMITS.snapshotsPerCollection} snapshots per collection: delete one first`);
        }
        const dump = { ...store.dump(), collection: e.link.id };
        const { text, blanked } = snapshotText(dump, e.good?.parsed.endpoints);
        if (Buffer.byteLength(text, 'utf8') > STORE_LIMITS.snapshotBytes) throw new Error('The data is larger than 32 MB: not saved');
        await this.deps.writeWorkspaceFile(e.folderPath, rel, text);
        e.snapshots = await this.listSnapshots(e);
        const counts = countSnapshot(dump.resources);
        return { path: rel, ...counts, ...(blanked.length ? { blanked } : {}) };
      }
      if (action === 'load') {
        const store = this.runningStore(e);
        const snap = await this.readSnapshot(e, name);
        const problems = store.load(snap);
        e.dataProblems = problems.slice(0, MAX_STORE_PROBLEMS).map((p) => cleanLine(`Snapshot "${name}": ${p}`));
        this.deps.onStoreChange?.(e.link.id, undefined);
        const known = new Set((e.detection?.resources ?? []).map((r) => r.name));
        const applied = Object.fromEntries(Object.entries(snap.resources).filter(([n]) => known.has(n)));
        return { path: rel, ...countSnapshot(applied) };
      }
      const { abs, exists } = this.checkSnapshotPath(e, rel);
      if (!exists) throw new Error(`no such snapshot "${name}" in collection "${e.link.id}"`);
      await this.deps.fs.unlink(abs);
      e.snapshots = await this.listSnapshots(e);
      return { path: rel, resources: 0, records: 0 };
    });
  }

  // ------------------------------------------------------------------ Record → Mock (CONTRACTS §23.1, §23.2)

  private throttleOnly(): (ruleId: string) => boolean {
    const f = this.deps.isThrottleOnlyRule;
    return (ruleId) => {
      try {
        return f?.(ruleId) === true;
      } catch {
        return false;
      }
    };
  }

  /** The exchanges of a source: this session's (since a time, matching a URL glob) or a saved recording's. */
  private async trafficOf(source: TrafficSource): Promise<readonly Exchange[]> {
    if (!source || typeof source !== 'object') throw new Error('source must be the session or a recording');
    if ('recording' in source) {
      if (typeof source.recording !== 'string' || !source.recording) throw new Error('recording must be a recording id');
      if (!this.deps.loadRecording) throw new Error("Recordings aren't available here");
      return (await this.deps.loadRecording(source.recording)) ?? [];
    }
    const s = source.session && typeof source.session === 'object' ? source.session : {};
    let list = this.deps.exchanges?.() ?? [];
    if (s.sinceMs !== undefined) {
      if (typeof s.sinceMs !== 'number' || !Number.isFinite(s.sinceMs)) throw new Error('sinceMs must be a time in ms');
      list = list.filter((e) => e.startedAt >= s.sinceMs!);
    }
    if (s.url !== undefined) {
      if (typeof s.url !== 'string' || !s.url || s.url.length > 8192) throw new Error('url must be a URL glob');
      const m = compileMatcher({ url: s.url });
      list = list.filter((e) => m(e.method, e.url));
    }
    return list;
  }

  /**
   * §23.2: the servers that answered in a source (for the origins choice): requests per origin, JSON answers, and
   * whether it is preselected (it answered JSON and isn't a known third-party service). Most requests first.
   */
  async trafficOrigins(source: TrafficSource): Promise<TrafficOrigin[]> {
    return trafficOriginsOf(await this.trafficOf(source), this.throttleOnly());
  }

  /**
   * §23.1 / §23.2: a collection built from real answers, written through `copyIn(…, 'sanitised')` to
   * `.vscode/flutter-intercept/collections/<slug>.json` (never over a file) and linked with `unmatched`. `dryRun`
   * returns the same without writing anything. Refused when nothing qualifies.
   */
  async mockFromTraffic(req: MockFromTrafficRequest): Promise<MockFromTrafficResult> {
    if (!req || typeof req !== 'object') throw new Error('Nothing to make a collection from');
    if (req.unmatched !== undefined && req.unmatched !== 'passthrough' && req.unmatched !== 'fail') throw new Error('unmatched must be "passthrough" or "fail"');
    const exchanges = await this.trafficOf(req.source);
    const throttle = this.throttleOnly();
    const all = trafficOriginsOf(exchanges, throttle);
    if (!all.length) throw new Error(NOTHING_RECORDED);
    let origins: string[];
    if (req.origins !== undefined) {
      if (!Array.isArray(req.origins) || !req.origins.length || req.origins.length > 50) throw new Error('origins must list 1–50 servers');
      const known = new Map(all.map((o) => [o.origin, o]));
      origins = [];
      for (const raw of req.origins) {
        const o = originOf(typeof raw === 'string' ? raw : '');
        if (!o || !known.has(o)) {
          throw new Error(
            `${cleanLine(String(raw), 120)} didn't answer in this traffic; servers that did: ${all
              .slice(0, 10)
              .map((x) => x.origin)
              .join(', ')}`,
          );
        }
        if (!origins.includes(o)) origins.push(o);
      }
    } else {
      origins = all.filter((o) => o.preselected).map((o) => o.origin);
      if (!origins.length) origins = all.filter((o) => !o.thirdParty).map((o) => o.origin);
      if (!origins.length) throw new Error(NOTHING_RECORDED);
    }
    const name = req.name === undefined ? defaultTrafficName(origins) : cleanLine(String(req.name), 100);
    if (!name) throw new Error('name must not be empty');
    const r = collectionFromTraffic(exchanges, {
      name,
      origins,
      ...(req.unmatched ? { unmatched: req.unmatched } : {}),
      replacePersonalData: req.replacePersonalData !== false,
      isThrottleOnlyRule: throttle,
    });
    if (!r.endpoints) {
      throw new Error(`${NOTHING_RECORDED}${r.skipped.length ? ` (skipped: ${r.skipped.slice(0, 4).map((x) => cleanLine(x, 80)).join(', ')})` : ''}`);
    }
    const folderPath = await this.deps.primaryFolderPath();
    if (!folderPath) throw new Error('Open the Flutter project folder to mock from traffic');
    const linked = this.deps.links().flatMap((f) => f.links);
    if (linked.length >= COLLECTION_LIMITS.linksPerFile) throw new Error(`At most ${COLLECTION_LIMITS.linksPerFile} collections can be linked`);
    const stem = slugId(name, new Set());
    const base = { endpoints: r.endpoints, examples: r.examples, skipped: r.skipped.map((x) => cleanLine(x, 200)) };
    if (req.dryRun) {
      return {
        id: slugId(name, new Set(linked.map((l) => l.id))),
        file: await this.freeCollectionPath(folderPath, stem, 'json'),
        ...base,
        resources: this.resourcesOfText(r.text),
        removed: r.removed.map((x) => cleanLine(x, 120)),
        dryRun: true,
      };
    }
    const copied = await this.copyIn(r.text, `${name}.json`, 'sanitised');
    let id: string;
    try {
      ({ id } = await this.addLink({ file: copied.file, folderPath, unmatched: req.unmatched ?? 'passthrough' }));
    } catch (e) {
      throw new Error(`${copied.file} was written but couldn't be linked: ${(e as Error).message}`);
    }
    const s = this.state(false).find((x) => x.id === id);
    const resources = s?.store ? s.store.resources.filter((x) => x.remembers).map((x) => x.name) : this.resourcesOfText(r.text);
    this.deps.log?.(`collections: made "${id}" from traffic (${r.endpoints} requests, ${r.examples} examples)`);
    return {
      id,
      file: copied.file,
      ...base,
      resources,
      removed: [...new Set([...r.removed, ...copied.removed])].map((x) => cleanLine(x, 120)),
      ...(s?.limited ? { limited: s.limited } : {}),
    };
  }

  /** The resources a collection text would remember (dry run, or a host without stores). Names only. */
  private resourcesOfText(text: string): string[] {
    try {
      const { parsers } = this.deps;
      const doc = JSON.parse(text) as unknown;
      const parsed = parsers.parsePostman(doc, parsers.mergeCollectionVars({}, new Map(), parsers.postmanCollectionVariables(doc)));
      return detectResources(parsed.endpoints, {}).resources.map((x) => x.name);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ drift (CONTRACTS §23.3)

  private driftTracker?: DriftTracker;
  /** Exchanges waiting to be looked at (debounced; ≤ DRIFT_PER_TICK per tick). */
  private driftQueue: Exchange[] = [];
  /** Exchange ids already looked at (classification once per exchange, like `seen`). */
  private driftDone = new Set<string>();
  private driftTimer?: ReturnType<typeof setTimeout>;
  private driftResume?: ReturnType<typeof setImmediate>;
  /** PERF-5 #4: what is left of the newest sliced tick (the head of the queue); the pending resume takes this many. */
  private driftLeft = 0;
  /** `link\0endpoint\0status` → the newest qualifying exchange (Update example takes its body). */
  private driftLatest = new Map<string, string>();

  private driftOn(): boolean {
    try {
      return this.deps.driftEnabled?.() !== false;
    } catch {
      return true;
    }
  }

  private driftIgnoredMap(): Record<string, string> {
    const v = this.deps.memento.get<unknown>(DRIFT_IGNORED_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  }

  private get drift(): DriftTracker {
    this.driftTracker ??= new DriftTracker({ now: () => this.now(), ignored: Object.values(this.driftIgnoredMap()).filter((x) => typeof x === 'string') });
    return this.driftTracker;
  }

  private forgetDrift(linkId: string): void {
    this.driftTracker?.forget(linkId);
    const prefix = `${linkId}\0`;
    for (const k of [...this.driftLatest.keys()]) if (k.startsWith(prefix)) this.driftLatest.delete(k);
  }

  /** §23.3: a finished exchange (the proxy's `exchange` event); looked at after a debounce, once per exchange. */
  observeExchange(ex: Exchange): void {
    if (!ex || ex.state !== 'completed' || typeof ex.status !== 'number' || !this.driftOn()) return;
    if (this.driftDone.has(ex.id)) return;
    this.driftDone.add(ex.id);
    if (this.driftDone.size > MAX_DRIFT_DONE) for (const id of [...this.driftDone].slice(0, MAX_DRIFT_DONE / 2)) this.driftDone.delete(id);
    if (!this.entries.some((e) => e.good)) return;
    this.driftQueue.push(ex);
    if (this.driftQueue.length > MAX_DRIFT_QUEUE) this.driftQueue.splice(0, this.driftQueue.length - MAX_DRIFT_QUEUE);
    this.scheduleDrift();
  }

  private scheduleDrift(): void {
    if (this.driftTimer) return;
    this.driftTimer = setTimeout(() => {
      this.driftTimer = undefined;
      this.flushDrift(DRIFT_PER_TICK, this.driftSliceMs());
    }, this.deps.driftDebounceMs ?? DRIFT_DEBOUNCE_MS);
    (this.driftTimer as { unref?: () => void }).unref?.();
  }

  private driftSliceMs(): number {
    return this.deps.driftSliceMs ?? DRIFT_SLICE_MS;
  }

  /**
   * PERF-5 #4: the rest of a tick's batch, on the next turn of the event loop (no new debounce). A tick that ran while a
   * resume was waiting took the older rest from the head of the queue first, so the newest count is the one to take.
   */
  private resumeDrift(left: number, sliceMs: number): void {
    this.driftLeft = left;
    if (this.driftResume) return;
    this.driftResume = setImmediate(() => {
      this.driftResume = undefined;
      const n = this.driftLeft;
      this.driftLeft = 0;
      if (n > 0) this.flushDrift(n, sliceMs);
    });
    (this.driftResume as { unref?: () => void }).unref?.();
  }

  /** Cancels waiting drift work: the debounce, a sliced tick's rest and the queue (the setting off, the host disposed). */
  stopDrift(): void {
    this.driftQueue = [];
    if (this.driftTimer) clearTimeout(this.driftTimer);
    this.driftTimer = undefined;
    if (this.driftResume) clearImmediate(this.driftResume);
    this.driftResume = undefined;
    this.driftLeft = 0;
  }

  /**
   * Looks at up to `max` queued exchanges (the debounce timer calls it; tests too). PERF-5 #4: with `sliceMs`, stops
   * once that much time has gone (after at least one exchange) and leaves the rest of the batch at the head of the
   * queue for `resumeDrift`; without it (tests, agents) the whole batch runs now, as before.
   */
  flushDrift(max = DRIFT_PER_TICK, sliceMs = Infinity): void {
    const batch = this.driftQueue.splice(0, max);
    if (this.driftQueue.length) this.scheduleDrift();
    if (!batch.length || !this.driftOn()) return;
    const before = this.driftSignature();
    const started = performance.now();
    let done = 0;
    for (const ex of batch) {
      if (done > 0 && performance.now() - started >= sliceMs) break;
      done++;
      try {
        this.observeOne(ex);
      } catch (e) {
        this.deps.log?.(`collections: drift check failed: ${cleanLine((e as Error).message, 200)}`);
      }
    }
    if (done < batch.length) {
      this.driftQueue.unshift(...batch.slice(done));
      this.resumeDrift(batch.length - done, sliceMs);
    } else {
      // the whole batch ran, and it began at the head: a rest a resume was waiting for is in it
      this.driftLeft = 0;
    }
    if (this.driftSignature() !== before) this.deps.onDriftChange?.();
  }

  private driftSignature(): string {
    return JSON.stringify(this.entries.map((e) => this.driftTracker?.findings(e.link.id).map((v) => [v.endpoint, v.status, v.changes]) ?? []));
  }

  /** One finished exchange against every linked collection whose servers it went to (§23.3 "Qualify"). */
  private observeOne(ex: Exchange): void {
    if (ex.kind || ex.browserInternal || ex.method.toUpperCase() === 'OPTIONS') return;
    if (ex.matchedRuleId && !this.throttleOnly()(ex.matchedRuleId)) return; // mocked, or changed by a rule
    const status = ex.status!;
    if (status < 200 || status > 599 || (status >= 300 && status < 400)) return;
    const b = ex.responseBody;
    if (!b || b.encoding !== 'utf8' || b.truncated || b.text.length > DRIFT_MAX_BODY || Buffer.byteLength(b.text, 'utf8') > DRIFT_MAX_BODY) return;
    if (!isJsonAnswer(singleHeaders(ex.responseHeaders), b.text)) return;
    let u: URL;
    try {
      u = new URL(ex.url);
    } catch {
      return;
    }
    const origin = `${u.protocol}//${u.host}`.toLowerCase();
    for (const e of this.entries) {
      const parsed = e.good?.parsed;
      if (!parsed || !parsed.endpoints.some((ep) => ep.origin === origin)) continue;
      const { compiled, meta } = this.matcherOf(e);
      const hit = findRule(compiled, ex.method, ex.url);
      const key = hit ? meta.get(hit.id)?.endpoint : undefined;
      const ep = key !== undefined ? parsed.endpoints.find((x) => x.key === key) : undefined;
      if (!ep) continue;
      const x = this.driftExampleFor(e, ep, status, u);
      if (x === null) continue; // an example of that status that isn't JSON: nothing to compare
      this.drift.observe({ linkId: e.link.id, endpoint: ep.key, status, body: b.text }, x ? { status, body: x.body, ...(x.generated ? { generated: true } : {}) } : undefined);
      const k = `${e.link.id}\0${ep.key}\0${status}`;
      this.driftLatest.delete(k);
      this.driftLatest.set(k, ex.id);
      while (this.driftLatest.size > MAX_DRIFT_LATEST) this.driftLatest.delete(this.driftLatest.keys().next().value!);
    }
  }

  /**
   * The example an answer is compared with: of that status and JSON, the one its query chooses, else the default
   * (when it has that status), else the first. Undefined: the endpoint has no example of that status; null: it has
   * one, but not JSON.
   */
  private driftExampleFor(e: Entry, ep: MockEndpoint, status: number, u: URL): MockExample | undefined | null {
    const same = ep.examples.filter((x) => x.status === status);
    if (!same.length) return undefined;
    const json = same.filter((x) => isJsonAnswer(x.headers, x.body));
    if (!json.length) return null;
    const byQuery = json.find((x) => x.query && Object.keys(x.query).length && Object.entries(x.query).every(([k, v]) => u.searchParams.get(k) === v));
    if (byQuery) return byQuery;
    const def = defaultExample(ep, this.effective(e).selected[ep.key])?.example;
    if (def && json.includes(def)) return def;
    return json.find((x) => !x.query) ?? json[0];
  }

  /** The findings of one collection as the panel and agents see them (paths and kinds only). */
  private driftViews(e: Entry): DriftView[] {
    if (!this.driftTracker || !this.driftOn()) return [];
    return this.driftTracker.findings(e.link.id).map((v) => ({ ...v, changes: v.changes.map(safeDriftChange) }));
  }

  /** CONTRACTS §23.3 / §23.5: the drift findings of a collection (empty when the setting is off). */
  driftOf(id: string): DriftView[] {
    return this.driftViews(this.entry(id));
  }

  /** §23.3: the setting changed; off drops everything observed. */
  refreshDrift(): void {
    if (this.driftOn()) return;
    const had = this.driftSignature();
    this.driftTracker = undefined;
    this.stopDrift();
    this.driftLatest.clear();
    if (had !== this.driftSignature()) this.deps.onDriftChange?.();
  }

  /**
   * §23.3 / §24.9: hides the current findings — all of a collection, one endpoint's, or one status of it — until their
   * set of changes differs (workspaceState `flutterIntercept.driftIgnored`). Resolves to how many were hidden.
   */
  ignoreDrift(id: string, endpoint?: string, status?: number): Promise<number> {
    return this.serial(async () => {
      const e = this.entry(id);
      if (status !== undefined && endpoint === undefined) throw new Error('status needs an endpoint');
      if (status !== undefined && !Number.isInteger(status)) throw new Error('status must be an HTTP status');
      const t = this.driftTracker;
      const views = (t?.findings(id) ?? []).filter((v) => (endpoint === undefined || v.endpoint === endpoint) && (status === undefined || v.status === status));
      if (!views.length || !t) return 0;
      const map: Record<string, string> = { ...this.driftIgnoredMap() };
      for (const v of views) {
        const fp = t.fingerprint(id, v.endpoint, v.status);
        if (!fp) continue;
        t.ignore(fp);
        const k = `${e.folderPath}\0${id}\0${v.endpoint}\0${v.status}`;
        delete map[k]; // most recent last
        map[k] = fp;
      }
      const keys = Object.keys(map);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DRIFT_IGNORED))) delete map[k];
      await this.deps.memento.update(DRIFT_IGNORED_KEY, map);
      this.deps.onDriftChange?.();
      return views.length;
    });
  }

  // ------------------------------------------------------------------ Update example (CONTRACTS §23.4)

  /** The collection file's text as it is on disk (BOM kept), and where to write it back. */
  private async collectionText(e: Entry): Promise<{ text: string; rel: string | undefined }> {
    const st = await checkWorkspaceFile(e.link.file, e.folderPath, this.deps.workspaceRoots(), this.deps.fs, COLLECTION_FILE_SPEC);
    const bytes = await this.deps.fs.readFile(st.real);
    const text = decodeWorkspaceFile(bytes, e.link.file, COLLECTION_FILE_SPEC);
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let rel: string | undefined;
    try {
      const root = this.deps.fs.realpathSync(e.folderPath);
      const r = path.relative(root, st.real);
      rel = r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : undefined;
    } catch {
      rel = undefined;
    }
    return { text: bom ? `﻿${text}` : text, rel };
  }

  /**
   * §23.4: what "Update example" would change — merge (the example's own values, with the drift changes applied from
   * the newest server answer, sanitised as §23.1) or add (the newest answer as a new example before the old one).
   * Postman and OpenAPI JSON files get `edit` (every other byte unchanged); OpenAPI YAML, generated examples and other
   * formats get `copyOnly` (the new example to copy). Refused: no answer in this session, `merge` on a status the
   * endpoint has no example for (§24.9), nothing to merge.
   */
  exampleUpdate(id: string, endpoint: string, status: number, mode: 'merge' | 'add' = 'merge'): Promise<ExampleUpdate> {
    return this.serial(async () => {
      const e = this.entry(id);
      const parsed = e.good?.parsed;
      if (!parsed) throw new Error(`The collection "${e.link.id}" can't be read now`);
      if (mode !== 'merge' && mode !== 'add') throw new Error('mode must be "merge" or "add"');
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('status must be an HTTP status');
      const ep = this.endpointOf(e, endpoint);
      const label = `${endpointLabel(ep.key)} (${status})`;
      const exId = this.driftLatest.get(`${e.link.id}\0${ep.key}\0${status}`);
      const ex = exId !== undefined ? (this.deps.exchanges?.() ?? []).find((x) => x.id === exId) : undefined;
      const sample = ex?.responseBody?.encoding === 'utf8' && !ex.responseBody.truncated ? ex.responseBody.text : undefined;
      if (!ex || sample === undefined) throw new Error(`No answer of the server for ${cleanLine(label, 200)} is in this session: let the app call it again, then update the example.`);
      let u: URL;
      try {
        u = new URL(ex.url);
      } catch {
        throw new Error(`No answer of the server for ${cleanLine(label, 200)} is in this session.`);
      }
      const existing = this.driftExampleFor(e, ep, status, u);
      if (mode === 'merge' && !existing) {
        throw new Error(`${cleanLine(label, 200)} has no ${existing === null ? 'JSON ' : ''}example to merge into: add the server's answer as a new example instead.`);
      }
      const changes = (this.driftTracker?.findings(e.link.id) ?? []).find((v) => v.endpoint === ep.key && v.status === status)?.changes ?? [];
      if (mode === 'merge' && !changes.some((c) => c.kind !== 'status')) throw new Error(`Nothing to update: the server's answers for ${cleanLine(label, 200)} match the example.`);
      // §23.1 sanitising before anything is merged or written. REVIEW-16 #3: a BOM / XSSI guard is read past; an
      // answer that still isn't one JSON value (NDJSON, JSONP, too deep, NaN …) is never put in an example
      const read = new TrafficSanitiser(true).readBody(sample, false, true);
      if (read.kind !== 'json' || read.json === undefined) {
        throw new Error(`The server's answer for ${cleanLine(label, 200)} isn't plain JSON, so it isn't put in an example (a credential in it could be missed).`);
      }
      const fresh = read.json;
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const base = { id: e.link.id, endpoint: ep.key, status, mode, file: e.link.file, format: parsed.format, changes: changes.map(safeDriftChange) };
      const copy = (example: string, oldBody: string | undefined, newBody: string, why: string): ExampleUpdate => ({ ...base, example, ...(oldBody !== undefined ? { oldBody } : {}), newBody, copyOnly: why });
      const addName = (taken: string[], stem: string) => {
        let n = stem;
        for (let k = 2; taken.includes(n); k++) n = `${stem} (${k})`;
        return n;
      };
      const mergedFrom = (oldBody: string) => mergeExample(oldBody, fresh, changes);
      // formats and examples that aren't edited here
      const yaml = isYamlFile(e.link.file);
      const editable = (parsed.format === 'postman' || parsed.format === 'openapi') && !yaml && !isBrunoLinkFile(e.link.file);
      if (mode === 'merge' && existing?.generated) return copy(existing.name, existing.body, mergedFrom(existing.body), 'the example is generated from the schema');
      if (!editable) {
        const why = yaml ? 'OpenAPI YAML files are not edited here' : `${formatLabel(parsed.format)} files are not edited here`;
        return mode === 'merge' && existing ? copy(existing.name, existing.body, mergedFrom(existing.body), why) : copy(addName(ep.examples.map((x) => x.name), `${status} (from the server, ${day})`), undefined, fresh, why);
      }
      const { text, rel } = await this.collectionText(e);
      const hash = createHash('sha256').update(text).digest('hex');
      const tree = parseJsonTree(text);
      const edit = (after: string | undefined) => (after !== undefined && rel ? { folderPath: e.folderPath, rel, before: text, after, hash } : undefined);
      const notFound = 'the example was not found in the file as written';
      if (parsed.format === 'postman') {
        if (mode === 'merge') {
          const at = postmanExamplePath(text, ep.key, existing!.name);
          const node = at && tree.root ? locate(tree.root, [...at, 'body'])?.node : undefined;
          if (!at || node?.type !== 'string') return copy(existing!.name, existing!.body, mergedFrom(existing!.body), notFound);
          const newBody = mergedFrom(node.value);
          const r = spliceValue(text, [...at, 'body'], { string: newBody });
          const ed = edit(r.text);
          return ed ? { ...base, example: existing!.name, oldBody: node.value, newBody, edit: ed } : copy(existing!.name, node.value, newBody, r.problem ?? notFound);
        }
        const name = addName(ep.examples.map((x) => x.name), `${status} (from the server, ${day})`);
        const before = existing ?? ep.examples.find((x) => x.status === status) ?? ep.examples[0];
        const at = before ? postmanExamplePath(text, ep.key, before.name) : undefined;
        if (!at) return copy(name, undefined, fresh, before ? notFound : 'the request has no example to add it next to');
        const entry = `{"name":${JSON.stringify(name)},"status":${JSON.stringify(reasonPhrase(status))},"code":${status},"_postman_previewlanguage":"json","header":[{"key":"Content-Type","value":"application/json"}],"body":${JSON.stringify(fresh)}}`;
        const r = insertBefore(text, at, { json: entry });
        const ed = edit(r.text);
        return ed ? { ...base, example: name, newBody: fresh, edit: ed } : copy(name, undefined, fresh, r.problem ?? notFound);
      }
      // OpenAPI JSON: paths[<template>][<method>].responses[<code>].content[<media>].example | examples[k].value
      const opPath = ['paths', ep.key.slice(ep.key.indexOf(' ') + 1).replace(/ #\d+$/, ''), ep.method.toLowerCase(), 'responses'];
      const responses = tree.root ? locate(tree.root, opPath)?.node : undefined;
      if (mode === 'merge') {
        const x = existing!;
        const dot = x.name.indexOf(' · ');
        const code = dot >= 0 ? x.name.slice(0, dot) : x.name;
        const exKey = dot >= 0 ? x.name.slice(dot + 3) : undefined;
        const target = responses ? openApiExamplePath(responses, [...opPath, code], exKey) : undefined;
        const node = target && tree.root ? locate(tree.root, target)?.node : undefined;
        if (!target || !node) return copy(x.name, x.body, mergedFrom(x.body), notFound);
        const oldBody = text.slice(node.start, node.end);
        const newBody = mergedFrom(oldBody);
        const r = spliceValue(text, target, { json: newBody });
        const ed = edit(r.text);
        return ed ? { ...base, example: x.name, oldBody, newBody, edit: ed } : copy(x.name, oldBody, newBody, r.problem ?? notFound);
      }
      const key = addName(
        ep.examples.filter((x) => x.status === status).map((x) => x.name.slice(x.name.indexOf(' · ') + 3)),
        `from the server, ${day}`,
      );
      const shownName = `${status} · ${key}`;
      const examples = responses ? openApiExamplesMap(responses, [...opPath, String(status)]) : undefined;
      if (!examples) return copy(shownName, undefined, fresh, 'the response has no named examples to add it to');
      const entry = `{"summary":${JSON.stringify(`${status} (from the server, ${day})`)},"value":${fresh}}`;
      const r = insertBefore(text, [...examples.path, examples.first], { json: entry, key });
      const ed = edit(r.text);
      return ed ? { ...base, example: shownName, newBody: fresh, edit: ed } : copy(shownName, undefined, fresh, r.problem ?? notFound);
    });
  }

  /**
   * §23.4: writes a previewed update — refused when the file changed since the preview (its hash), or when the update
   * is copy-only. The collection reloads (its remembered data restarts; approval follows the new content).
   */
  applyExampleUpdate(u: ExampleUpdate): Promise<void> {
    return this.serial(async () => {
      if (!u?.edit) throw new Error(`${cleanLine(String(u?.file ?? 'This file'), 200)} isn't edited here: copy the updated example instead`);
      const e = this.entry(u.id);
      if (e.folderPath !== u.edit.folderPath || e.link.file !== u.file) throw new Error('The collection changed since the preview; nothing was written');
      const { text } = await this.collectionText(e);
      if (createHash('sha256').update(text).digest('hex') !== u.edit.hash) {
        throw new Error(`${cleanLine(u.file, 200)} changed since the preview; nothing was written. Open the update again to see the change as it is now.`);
      }
      await this.deps.writeWorkspaceFile(u.edit.folderPath, u.edit.rel, u.edit.after);
      this.deps.log?.(`collections: updated example "${cleanLine(u.example, 120)}" of ${cleanLine(u.file, 200)} (${u.mode})`);
      await this.reloadNow();
    });
  }
}

/**
 * CONTRACTS §24.4: why a Swagger / Insomnia file or a Bruno folder outside the project isn't copied in (a copy without
 * credentials can't be made for them in this release, and a Bruno collection is a whole folder).
 */
export function copyRefusal(fileName: string, format: CollectionFormat): string {
  const shown = cleanLine(fileName, 120);
  if (format === 'bruno') return `${shown} is outside the project. A Bruno collection is a folder: put the folder in the project (e.g. api/), then choose its bruno.json.`;
  return `${shown} is outside the project. Put the ${formatLabel(format)} file in the project (e.g. api/) and choose it there: a copy without credentials can't be made for this format yet.`;
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resources and records in a snapshot's `resources`. */
function countSnapshot(resources: Record<string, { records: unknown[] }[]>): { resources: number; records: number } {
  let records = 0;
  for (const list of Object.values(resources)) for (const s of list) records += Array.isArray(s.records) ? s.records.length : 0;
  return { resources: Object.keys(resources).length, records };
}

/** Comparable form of a shared `stores` entry (defaults dropped, keys sorted). */
function normStoreLink(l: StoreSettingsLink): unknown {
  const res = l.resources ?? {};
  const a = l.auth ?? {};
  return [
    l.enabled === false ? false : true,
    l.snapshot ?? null,
    Object.keys(res).sort().map((n) => [n, res[n].idField ?? null, res[n].off === true]),
    [a.enabled === true, a.ttlSeconds ?? DEFAULT_TTL_SECONDS, a.protect ?? null, a.login ?? null, a.refresh ?? null],
    l.dynamic ?? null,
  ];
}

/** Comparable form of a store overlay. */
function normOverlay(o: StoreOverlay): unknown {
  const res = o.resources ?? {};
  const a = o.auth ?? {};
  return [
    o.enabled ?? null,
    'snapshot' in o ? o.snapshot ?? null : '-',
    Object.keys(res).sort().map((n) => [n, res[n].idField ?? null, res[n].off ?? null]),
    [a.enabled ?? null, a.ttlSeconds ?? null, a.protect ?? null],
    o.dynamic ?? null,
  ];
}

// ------------------------------------------------------------------ CONTRACTS §23 (part 2): types and pure helpers

/** §23.2: where the traffic comes from — this session (since a time, matching a URL glob) or a saved recording. */
export type TrafficSource = { session: { sinceMs?: number; url?: string } } | { recording: string };

export interface MockFromTrafficRequest {
  source: TrafficSource;
  /** Default "<host> (recorded)" of the busiest chosen server. */
  name?: string;
  /** Default: the servers that answered JSON, known third-party services left out. */
  origins?: string[];
  unmatched?: 'passthrough' | 'fail';
  /** Default true. */
  replacePersonalData?: boolean;
  /** Everything but writing. */
  dryRun?: boolean;
}

export interface MockFromTrafficResult {
  id: string;
  /** Workspace-relative. */
  file: string;
  endpoints: number;
  examples: number;
  /** Resources that remember (names). */
  resources: string[];
  skipped: string[];
  /** Field / header names and kinds of data, never values. */
  removed: string[];
  limited?: { reasons: string[]; answers: number };
  dryRun?: true;
}

/** §23.2: one server of a traffic source, for the origins choice. */
export interface TrafficOrigin {
  origin: string;
  requests: number;
  /** Answers with a JSON body. */
  json: number;
  thirdParty: boolean;
  preselected: boolean;
}

/** §23.4: a previewed "Update example". `edit` absent → copy only (`copyOnly` says why). */
export interface ExampleUpdate {
  id: string;
  endpoint: string;
  status: number;
  mode: 'merge' | 'add';
  /** The collection file, workspace-relative (as linked). */
  file: string;
  format: CollectionFormat;
  /** The example changed (merge) or added (add), as the panel names it. */
  example: string;
  /** Merge: the example's body as written before. */
  oldBody?: string;
  /** The new example body (sanitised as §23.1). */
  newBody: string;
  changes: DriftChange[];
  edit?: { folderPath: string; rel: string; before: string; after: string; hash: string };
  copyOnly?: string;
}

/** Hosts of services an app talks to that aren't its own backend (left unselected in the origins choice). */
const THIRD_PARTY =
  /(?:^|\.)(?:googleapis\.com|google-analytics\.com|googletagmanager\.com|googleadservices\.com|doubleclick\.net|gstatic\.com|firebaseio\.com|firebaseapp\.com|app-measurement\.com|crashlytics\.com|sentry\.io|bugsnag\.com|datadoghq\.(?:com|eu)|newrelic\.com|nr-data\.net|segment\.(?:io|com)|mixpanel\.com|amplitude\.com|branch\.io|app\.link|appsflyer\.com|adjust\.com|onesignal\.com|facebook\.com|facebook\.net|fbcdn\.net|launchdarkly\.com|revenuecat\.com|intercom\.io|braze\.com|appcenter\.ms|cloudinary\.com|gravatar\.com)$/i;

/** `scheme://host[:port]`, lower-case, default port dropped; undefined when it isn't an http(s) URL. */
function originOf(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/** §23.1 "taken" in short: a real server answered (no rule answered it; a throttle-only rule is fine). */
function isRealAnswer(e: Exchange, throttleOnly: (ruleId: string) => boolean): boolean {
  if (e.state !== 'completed' || typeof e.status !== 'number' || e.kind || e.browserInternal) return false;
  if (e.matchedRuleId && !throttleOnly(e.matchedRuleId)) return false;
  return e.method.toUpperCase() !== 'OPTIONS';
}

export function trafficOriginsOf(exchanges: readonly Exchange[], throttleOnly: (ruleId: string) => boolean): TrafficOrigin[] {
  const by = new Map<string, TrafficOrigin>();
  for (const e of exchanges) {
    if (!isRealAnswer(e, throttleOnly)) continue;
    const o = originOf(e.url);
    if (!o) continue;
    let x = by.get(o);
    if (!x) {
      const host = new URL(o).hostname;
      by.set(o, (x = { origin: o, requests: 0, json: 0, thirdParty: THIRD_PARTY.test(host), preselected: false }));
    }
    x.requests++;
    const b = e.responseBody;
    if (b && b.encoding === 'utf8' && isJsonAnswer(singleHeaders(e.responseHeaders), b.text)) x.json++;
  }
  for (const x of by.values()) x.preselected = x.json > 0 && !x.thirdParty;
  return [...by.values()].sort((a, b) => b.requests - a.requests || (a.origin < b.origin ? -1 : 1));
}

/** "api.shop.example (recorded)": the first chosen server (they come busiest first). */
function defaultTrafficName(origins: readonly string[]): string {
  let host = 'Server';
  try {
    host = new URL(origins[0]).host;
  } catch {
    // keep the fallback
  }
  return `${host} (recorded)`;
}

/** Response headers with one value each (`content-type` is what matters here). */
function singleHeaders(h: Exchange['responseHeaders']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === 'string') out[k] = one;
  }
  return out;
}

const DRIFT_KINDS: ReadonlySet<string> = new Set(['bool', 'int', 'double', 'string', 'list', 'object', 'mixed', 'null']);

/**
 * A drift change as it leaves the host: paths (field names, never values) with any segment that looks like data
 * (an e-mail, a phone number, a credential — keys of a map) shown as `*`; `from` / `to` only the kind names (§24.9)
 * or, for `status`, the code.
 */
function safeDriftChange(c: DriftChange): DriftChange {
  const seg = (s: string) => (s.includes('@') || /^\+?\d[\d ()-]{6,}$/.test(s) || looksLikeCredential(s) ? '*' : s);
  const pathShown = c.path
    .split(/(?<!\\)\./)
    .map((part) => {
      const m = /^(.*?)((?:\[\])*)$/.exec(part)!;
      return `${seg(m[1])}${m[2]}`;
    })
    .join('.');
  const kind = (v: string | undefined) => (v === undefined ? undefined : c.kind === 'status' ? (/^\d{3}$/.test(v) ? v : undefined) : DRIFT_KINDS.has(v) ? v : undefined);
  const from = kind(c.from);
  const to = kind(c.to);
  return { kind: c.kind, path: pathShown, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/** The JSON media type objects of a response (`content[mt]`), with their paths. */
function jsonMediaTypes(responses: JsonNode, responsePath: (string | number)[]): { node: JsonNode; path: (string | number)[] }[] {
  const code = responsePath[responsePath.length - 1] as string;
  const res = locate(responses, [code])?.node;
  const content = res ? locate(res, ['content'])?.node : undefined;
  if (content?.type !== 'object') return [];
  return content.members
    .filter((m) => m.value.type === 'object' && /json/i.test(m.key))
    .map((m) => ({ node: m.value, path: [...responsePath, 'content', m.key] }));
}

/** OpenAPI: where an example's value is — `examples[exKey].value` or the media type's `example`. */
function openApiExamplePath(responses: JsonNode, responsePath: (string | number)[], exKey: string | undefined): (string | number)[] | undefined {
  for (const mt of jsonMediaTypes(responses, responsePath)) {
    if (exKey !== undefined) {
      const v = locate(mt.node, ['examples', exKey, 'value']);
      if (v) return [...mt.path, 'examples', exKey, 'value'];
    } else if (locate(mt.node, ['example'])) return [...mt.path, 'example'];
  }
  return undefined;
}

/** OpenAPI: a JSON media type's named `examples` map of a response, and its first key (to insert before). */
function openApiExamplesMap(responses: JsonNode, responsePath: (string | number)[]): { path: (string | number)[]; first: string } | undefined {
  for (const mt of jsonMediaTypes(responses, responsePath)) {
    const ex = locate(mt.node, ['examples'])?.node;
    if (ex?.type === 'object' && ex.members.length) return { path: [...mt.path, 'examples'], first: ex.members[0].key };
  }
  return undefined;
}

const MAX_DIFF_LINES = 2000;
const MAX_DIFF_CHARS = 20_000;

/** JSON re-indented (literals kept), else the text as it is. */
function readable(text: string): string {
  try {
    return prettyJson(text);
  } catch {
    return text;
  }
}

/** A unified line diff (3 lines of context); past MAX_DIFF_LINES the whole text is shown as replaced. */
export function lineDiff(a: readonly string[], b: readonly string[], context = 3): string[] {
  const n = a.length;
  const m = b.length;
  type Op = { t: ' ' | '-' | '+'; s: string };
  let ops: Op[];
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) ops = [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  else {
    // LCS table from the end
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ t: ' ', s: a[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push({ t: '-', s: a[i++] });
      else ops.push({ t: '+', s: b[j++] });
    }
    while (i < n) ops.push({ t: '-', s: a[i++] });
    while (j < m) ops.push({ t: '+', s: b[j++] });
  }
  // hunks: changed lines with `context` lines around them
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const out: string[] = [];
  let ai = 1;
  let bi = 1;
  for (let k = 0; k < ops.length; ) {
    if (!keep[k]) {
      if (ops[k].t !== '+') ai++;
      if (ops[k].t !== '-') bi++;
      k++;
      continue;
    }
    let end = k;
    while (end < ops.length && keep[end]) end++;
    const hunk = ops.slice(k, end);
    const al = hunk.filter((o) => o.t !== '+').length;
    const bl = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${ai},${al} +${bi},${bl} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    ai += al;
    bi += bl;
    k = end;
  }
  return out;
}

/**
 * §23.5: the text agents get for `update_collection_example` — the example before and after, as a unified diff of
 * the readable (re-indented) bodies. `view` redacts a body the way the agent sees it. Never the rest of the file.
 */
export function exampleDiff(u: ExampleUpdate, view: (body: string) => string = (b) => b, endpointShown = u.endpoint): string {
  const before = u.mode === 'merge' && u.oldBody !== undefined ? readable(view(u.oldBody)) : '';
  const after = readable(view(u.newBody));
  const split = (t: string) => (t === '' ? [] : t.replace(/\r\n/g, '\n').split('\n'));
  const head = [
    `--- ${u.file} · ${endpointShown} · ${u.mode === 'merge' ? `example "${u.example}"` : `(no example "${u.example}" yet)`}`,
    `+++ ${u.file} · ${endpointShown} · ${u.mode === 'merge' ? `example "${u.example}", merged with the server's answer` : `new example "${u.example}" (the server's answer)`}`,
  ];
  const text = [...head, ...lineDiff(split(before), split(after))].join('\n');
  return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS - 1)}…` : text;
}
