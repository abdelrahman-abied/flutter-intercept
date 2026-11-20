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
 */
import { createHash } from 'crypto';
import * as path from 'path';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { compileRules, findRule, type CompiledRule } from '@flutter-intercept/proxy/rules';
import { pathTemplate } from '../contract/mapping';
import { cleanLine, limitAnswer, LIMIT_REASONS, type LimitReason } from './limit';
import { checkWorkspaceFile, decodeWorkspaceFile, type RulesFs, type WorkspaceFileSpec } from '../rules/bodyFile';
import type { FolderCollectionLinks, MementoLike } from '../rules/core';
import { parseJsonc } from '../rules/jsonc';
import { relativePath } from './link';
import { displayPath, toRules } from './toRules';
import { isYamlFile, parseYaml } from './yaml';
import {
  COLLECTION_LIMITS,
  LINK_ID,
  type CollectionLink,
  type CollectionVars,
  type DetectFormat,
  type MockEndpoint,
  type ParseOpenApi,
  type ParsePostman,
  type ParsePostmanEnvironment,
  type ParsedCollection,
  type PostmanCollectionVariables,
  type SanitisePostman,
  type ToRulesStats,
  type CollectionRuleMeta,
  COLLECTION_RULE_PREFIX,
} from './types';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus } from '../ui/protocol';

export const ENABLED_KEY = 'flutterIntercept.collectionsEnabled';
/** CONTRACTS §21.15: `{ [folder\0id]: { selected?: {key: name}, off?: {key: boolean}, unmatched? } }`. */
export const OVERLAY_KEY = 'flutterIntercept.collectionsOverlay';
/** CONTRACTS §21.16: `{ [folder\0id]: approval hashes[] }` (the last few kept, so switching branches back is free). */
export const APPROVALS_KEY = 'flutterIntercept.collectionsApproved';
const MAX_APPROVALS_PER_COLLECTION = 5;
/** CONTRACTS §21.15 #4: entries per `seen` list, and how many recent exchanges are looked at. */
const MAX_SEEN = 20;
const MAX_SEEN_EXCHANGES = 5000;
export const COLLECTIONS_DIR = '.vscode/flutter-intercept/collections';
export const MAX_PROBLEMS = 50;
const VARIABLE_NAME = /^[A-Za-z0-9_.$-]{1,100}$/;
/** REVIEW-15 #8: what a variable used as a server may hold — `https://host[:port][/path]` or `host[:port]`, no userinfo. */
const ORIGIN_VALUE = /^(?:https?:\/\/)?(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?:\/[^\s?#@]*)?$/;
const MAX_VARIABLE_VALUE = 2048;

const COLLECTION_FILE_SPEC: WorkspaceFileSpec = { what: 'collection file', maxBytes: COLLECTION_LIMITS.fileBytes, maxLabel: '20 MB' };
const ENVIRONMENT_FILE_SPEC: WorkspaceFileSpec = { what: 'environment file', maxBytes: 5 * 1024 * 1024, maxLabel: '5 MB' };

/** The parsers (M1, M2), injected so this core doesn't depend on them directly. */
export interface CollectionParsers {
  detectFormat: DetectFormat;
  parsePostman: ParsePostman;
  postmanCollectionVariables: PostmanCollectionVariables;
  parsePostmanEnvironment: ParsePostmanEnvironment;
  mergeCollectionVars(link: Readonly<Record<string, string>>, environment: ReadonlyMap<string, string>, collection: ReadonlyMap<string, string>): CollectionVars;
  parseOpenApi: ParseOpenApi;
  sanitisePostman: SanitisePostman;
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

interface ParseResult {
  key: string;
  parsed: ParsedCollection;
  /** Names of credentials the Postman file holds (sanitisePostman `removed`). */
  credentials: string[];
  /** sha256 of the collection and environment files' text (CONTRACTS §21.16 approval). */
  contentHash: string;
  /** Environment values (never exposed: only used to show `{{name}}` where a value appears in a path). */
  envValues: ReadonlyMap<string, string>;
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
  meta: Map<string, CollectionRuleMeta>;
  /** Rule id → header names taken out (limited answers, CONTRACTS §21.16). */
  limited: Map<string, string[]>;
  limitReasons: LimitReason[];
  /** Every endpoint as rules (none off, passthrough), for `seen` and `request` lookups; built on first use. */
  matcher?: { compiled: CompiledRule[]; meta: Map<string, CollectionRuleMeta> };
  /** Exchange id → how it relates to this collection (`seen`), cleared with the rules. */
  seenCache: Map<string, { kind: 'none' | 'not-in' | 'no-example'; key: string }>;
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

export class MockCollectionsCore {
  private entries: Entry[] = [];
  private fileProblemList: string[] = [];
  private cache = new Map<string, ParseResult>();
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
    for (const folder of this.deps.links()) {
      fileProblems.push(...folder.problems);
      for (const link of folder.links) {
        if (seen.has(link.id)) {
          fileProblems.push(`${folder.label}: collection "${link.id}" is also linked in another workspace folder (skipped)`);
          continue;
        }
        seen.add(link.id);
        const prev = previous.get(`${folder.folderPath}\0${link.id}`);
        const entry: Entry = { link, folderPath: folder.folderPath, label: folder.label, good: prev?.good, loadProblems: [], rules: [], ruleProblems: [], meta: new Map(), limited: new Map(), limitReasons: [], seenCache: new Map() };
        await this.load(entry);
        if (entry.good) usedKeys.add(entry.good.key);
        this.buildRules(entry);
        next.push(entry);
      }
    }
    for (const k of [...this.cache.keys()]) if (!usedKeys.has(k)) this.cache.delete(k);
    this.entries = next;
    this.fileProblemList = fileProblems;
    return this.signature() !== before;
  }

  private async readFile(rel: string, folderPath: string, spec: WorkspaceFileSpec): Promise<FileRead & { text?: string }> {
    const st = await checkWorkspaceFile(rel, folderPath, this.deps.workspaceRoots(), this.deps.fs, spec);
    this.deps.watchFile?.(st.real);
    return st;
  }

  private async load(entry: Entry): Promise<void> {
    const { link, folderPath } = entry;
    const { fs, parsers } = this.deps;
    let col: FileRead;
    let env: FileRead | undefined;
    try {
      col = await this.readFile(link.file, folderPath, COLLECTION_FILE_SPEC);
      if (link.environment) env = await this.readFile(link.environment, folderPath, ENVIRONMENT_FILE_SPEC);
    } catch (e) {
      this.keepOrFail(entry, (e as Error).message);
      return;
    }
    const key = JSON.stringify([col.real, col.size, col.mtimeMs, env?.real, env?.size, env?.mtimeMs, link.variables]);
    const cached = this.cache.get(key);
    if (cached) {
      entry.good = cached;
      return;
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
      if (env && link.environment) {
        const envText = decodeWorkspaceFile(await fs.readFile(env.real), link.environment, ENVIRONMENT_FILE_SPEC);
        hash.update(envText);
        const er = parseJsonText(envText, link.environment);
        if (er.problem !== undefined) return this.keepOrFail(entry, er.problem);
        const pe = parsers.parsePostmanEnvironment(er.value);
        envValues = pe.values;
        entry.loadProblems.push(...pe.problems.map((p) => `${link.environment}: ${p}`));
      }
    } catch (e) {
      this.keepOrFail(entry, (e as Error).message);
      return;
    }
    const detected = parsers.detectFormat(doc);
    if (!detected.format) {
      this.keepOrFail(entry, `${link.file}: ${detected.problem ?? 'not a Postman collection or an OpenAPI 3 document'}`);
      return;
    }
    let parsed: ParsedCollection;
    let credentials: string[] = [];
    try {
      if (detected.format === 'postman') {
        const vars = parsers.mergeCollectionVars(link.variables, envValues, parsers.postmanCollectionVariables(doc));
        parsed = parsers.parsePostman(doc, vars);
        credentials = parsers.sanitisePostman(doc).removed;
      } else {
        parsed = parsers.parseOpenApi(doc, parsers.mergeCollectionVars(link.variables, envValues, new Map()));
      }
    } catch (e) {
      // the parsers never throw by contract; a bug there must not take the panel down
      this.deps.log?.(`collection ${link.id}: parser failed: ${(e as Error).message}`);
      this.keepOrFail(entry, `${link.file}: couldn't be read (an internal error; see the Flutter Intercept log)`);
      return;
    }
    const result: ParseResult = { key, parsed, credentials, contentHash: hash.digest('hex'), envValues };
    this.cache.set(key, result);
    entry.good = result;
  }

  private keepOrFail(entry: Entry, problem: string): void {
    entry.loadProblems.push(entry.good ? `${problem} — using the last good version` : problem);
  }

  private buildRules(entry: Entry): void {
    const parsed = entry.good?.parsed;
    entry.matcher = undefined;
    entry.seenCache = new Map();
    entry.limited = new Map();
    entry.limitReasons = [];
    if (!parsed) {
      entry.rules = [];
      entry.stats = undefined;
      entry.ruleProblems = [];
      entry.meta = new Map();
      return;
    }
    const eff = this.effective(entry);
    const r = toRules(parsed, { id: entry.link.id, name: parsed.name || entry.link.id, selected: eff.selected, off: eff.off, unmatched: eff.unmatched });
    entry.stats = r.stats;
    entry.ruleProblems = r.problems;
    entry.meta = r.meta;
    // CONTRACTS §21.16: limited answers until this exact collection (files + URL variables) is approved
    if (this.isApproved(entry)) {
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
    entry.limitReasons = LIMIT_REASONS.filter((x) => reasons.has(x));
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
    if (!e.limited.size) return undefined;
    const origins = new Set<string>();
    for (const ep of e.good?.parsed.endpoints ?? []) if (ep.origin) origins.add(ep.origin);
    return { name: cleanLine(e.good?.parsed.name || e.link.id, 200), reasons: e.limitReasons, answers: e.limited.size, origins: [...origins].slice(0, 10) };
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
      const problems = [...e.loadProblems, ...(parsed?.problems ?? []), ...e.ruleProblems];
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
        ...(e.limited.size ? { limited: { reasons: [...e.limitReasons], answers: e.limited.size } } : {}),
        ...(withSeen && this.deps.exchanges ? { seen: this.seen(e, origins) } : {}),
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
      return { id: e.link.id, name: cleanLine(e.good?.parsed.name || e.link.id, 200), ...m, ...(limited ? { limited } : {}) };
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
    return (e.good?.parsed.endpoints ?? []).map((ep) => {
      const url = ep.origin ? `${ep.origin}${mask(displayPath(ep))}` : ep.key.slice(ep.key.indexOf(' ') + 1).replace(/ #\d+$/, '');
      const sel = eff.selected[ep.key];
      const overridden = (overlay.selected && ep.key in overlay.selected) || (overlay.off && ep.key in overlay.off);
      return {
        key: ep.key,
        method: ep.method,
        name: cut(ep.name),
        folder: ep.folder.map((f) => cut(f)),
        url,
        examples: ep.examples.map((x) => ({ name: cut(x.name), status: x.status, ...(x.generated ? { generated: true as const } : {}), ...(x.query ? { query: x.query } : {}) })),
        ...(sel !== undefined && ep.examples.some((x) => x.name === sel) ? { selected: sel } : {}),
        ...(off.has(ep.key) ? { off: true as const } : {}),
        ...(ep.unresolved.length ? { unresolved: ep.unresolved } : {}),
        ...(overridden ? { overridden: true as const } : {}),
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
      await this.reloadNow();
    });
  }

  /**
   * Links a collection that is already inside the workspace (`file`, `environment`: workspace-relative, checked).
   * The id comes from the collection's name. Resolves to the new id.
   */
  addLink(pick: { file: string; environment?: string; folderPath?: string }): Promise<{ id: string }> {
    return this.serial(async () => {
      const folderPath = pick.folderPath ?? (await this.deps.primaryFolderPath());
      if (!folderPath) throw new Error('Open the Flutter project folder to mock from a collection');
      const file = relativePath(pick.file);
      if (!file) throw new Error('The collection must be a file inside the workspace');
      // REVIEW-15 #4: the link is committed; a file in a build-output folder (gitignored in Flutter projects, e.g. an
      // agent's export under .dart_tool/) would be missing for everyone else
      if (/^(?:\.dart_tool|build)\//.test(file) || (pick.environment !== undefined && /^(?:\.dart_tool|build)\//.test(relativePath(pick.environment) ?? ''))) {
        throw new Error(`${file.startsWith('.dart_tool') || file.startsWith('build') ? file : pick.environment} is in a build folder that isn't committed: move it into the project (e.g. api/) first`);
      }
      const environment = pick.environment === undefined ? undefined : relativePath(pick.environment);
      if (pick.environment !== undefined && !environment) throw new Error('The environment must be a file inside the workspace');
      const name = await this.peekName(file, folderPath);
      const folders = this.deps.links();
      const all = folders.flatMap((f) => f.links);
      if (all.length >= COLLECTION_LIMITS.linksPerFile) throw new Error(`At most ${COLLECTION_LIMITS.linksPerFile} collections can be linked`);
      const existing = all.find((l) => l.file === file);
      if (existing) throw new Error(`${file} is already linked (collection "${existing.id}")`);
      const id = slugId(name ?? path.basename(file).replace(/\.(postman_collection\.)?(json|ya?ml)$/i, ''), new Set(all.map((l) => l.id)));
      if (!LINK_ID.test(id)) throw new Error('No usable name for the collection');
      const link: CollectionLink = { id, file, ...(environment ? { environment } : {}), variables: {}, enabled: true, unmatched: 'passthrough', selected: {}, off: [] };
      const mine = folders.find((f) => f.folderPath === folderPath)?.links ?? [];
      await this.deps.saveLinks(folderPath, [...mine, link]);
      await this.reloadNow();
      return { id };
    });
  }

  /** Reads and checks a collection file inside the workspace; its name (Postman `info.name`, OpenAPI `info.title`). */
  private async peekName(rel: string, folderPath: string): Promise<string | undefined> {
    const st = await checkWorkspaceFile(rel, folderPath, this.deps.workspaceRoots(), this.deps.fs, COLLECTION_FILE_SPEC);
    const text = decodeWorkspaceFile(await this.deps.fs.readFile(st.real), rel, COLLECTION_FILE_SPEC);
    const r = isYamlFile(rel) ? parseYaml(text, rel) : parseJsonText(text, rel);
    if (r.problem !== undefined) throw new Error(r.problem);
    const detected = this.deps.parsers.detectFormat(r.value);
    if (!detected.format) throw new Error(`${rel}: ${detected.problem ?? 'not a Postman collection or an OpenAPI 3 document'}`);
    const info = (r.value as { info?: { name?: unknown; title?: unknown } }).info;
    const name = detected.format === 'postman' ? info?.name : info?.title;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
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
      const yaml = isYamlFile(fileName);
      const r = yaml ? parseYaml(text, fileName) : parseJsonText(text, fileName);
      if (r.problem !== undefined) throw new Error(r.problem);
      const detected = this.deps.parsers.detectFormat(r.value);
      if (!detected.format) throw new Error(`${fileName}: ${detected.problem ?? 'not a Postman collection or an OpenAPI 3 document'}`);
      let out = text;
      let removed: string[] = [];
      if (mode === 'sanitised' && detected.format === 'postman') {
        const s = this.deps.parsers.sanitisePostman(r.value);
        out = `${JSON.stringify(s.doc, null, 2)}\n`;
        removed = s.removed;
      }
      const stem = slugId(fileName.replace(/\.(postman_collection\.)?(json|ya?ml)$/i, ''), new Set());
      const ext = yaml && out === text ? (/\.yml$/i.test(fileName) ? 'yml' : 'yaml') : 'json';
      // REVIEW-15 #8: a name already in the folder is never replaced — a dangling symlink included (stat follows links)
      const taken = await this.namesIn(path.join(folderPath, COLLECTIONS_DIR));
      let rel = `${COLLECTIONS_DIR}/${stem}.${ext}`;
      for (let n = 2; taken.has(path.basename(rel)) || (await this.exists(path.join(folderPath, rel))); n++) rel = `${COLLECTIONS_DIR}/${stem}-${n}.${ext}`;
      await this.deps.writeWorkspaceFile(folderPath, rel, out);
      return { file: rel, removed };
    });
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

  /** The format of a document read by the IDE (for the copy question), or undefined when it is neither. */
  formatOf(text: string, fileName: string): 'postman' | 'openapi' | undefined {
    const r = isYamlFile(fileName) ? parseYaml(text, fileName) : parseJsonText(text, fileName);
    return r.problem === undefined ? this.deps.parsers.detectFormat(r.value).format : undefined;
  }

  /** Names of URL variables a collection still needs (for the import prompt). */
  unresolved(id: string): string[] {
    return this.state().find((s) => s.id === id)?.unresolved ?? [];
  }
}
