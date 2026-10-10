/**
 * Shared rules service core (CONTRACTS §12.1–12.2). No `vscode` import: the fs, the workspace folders, the memento
 * and the body-file watcher are injected (src/rules/service.ts wires them to VS Code).
 *
 * Location: `.vscode/flutter-intercept.json` in every workspace folder holding a Flutter project (a pubspec.yaml at
 * its root or one level down), in folder order; with no such folder, the first workspace folder. The first of them
 * is the primary folder (ids `shared:<id>`; personal rules' body files and newly shared rules go there); further
 * folders' rules get ids `shared@<folder name>:<id>` and run after the primary folder's, in folder order.
 *
 * Broken file → the last good rules of that file stay in effect and the problem is shown; deleted file → its rules
 * are gone.
 *
 * Approval (REVIEW-6 #2/#6): per RULE, never per file. A gated rule (policy.ts `approvalReasons`) is active only when
 * the hash of that rule — its canonical content (stable key order, `enabled` excluded), its file id and its folder —
 * is in the folder's approved set in workspaceState. Changing a rule revokes exactly that rule; entries that were
 * skipped (duplicates, past the limit, unknown kinds) are never approved implicitly: when they become valid they are
 * new hashes, so pending. Hashes of rules no longer in a (readable) file are pruned. The user's own personal rules
 * being shared are approved as they are written.
 */
import * as path from 'path';
import type { Rule } from '@flutter-intercept/proxy';
import type { SharedRulesState } from './types';
import {
  BodyFileError,
  bodyFileActions,
  bodyFileExtension,
  bodyFileLocation,
  bodyFileStem,
  bodyFileSyntaxError,
  checkBodyFile,
  decodeBodyFile,
  MAX_BODY_FILE_BYTES,
  MOCKS_DIR,
  RulesFs,
} from './bodyFile';
import {
  canonicalJson,
  contentHash,
  isSharedRuleId,
  MAX_SHARED_FILE_BYTES,
  namespaceId,
  ParsedSharedFile,
  parseSharedFile,
  serializeSharedFile,
  SHARED_FILE,
  splitSharedId,
  toFileRule,
  ValidateRule,
} from './file';
import { approvalReason, approvalReasons, bodyFileSecretProblem, matchLabel, ruleLabel, secretProblem } from './policy';

/** workspaceState: `{ [folder path]: approved rule hashes[] }`. */
export const APPROVALS_KEY = 'flutterIntercept.sharedRulesApprovedRules';

/** The approval unit: one rule's canonical content (without `enabled`), its file id and its folder. */
export function ruleApprovalHash(folderPath: string, fileId: string, rule: Rule): string {
  const { enabled: _enabled, ...content } = toFileRule(rule, fileId);
  return contentHash({ folder: folderPath, id: fileId, rule: content });
}

export interface PendingSnapshot {
  /** Identifies exactly this set of held rules; pass it to `approvePending`. */
  hash: string;
  items: { folder: string; name: string; match: string; reason: string }[];
}

export interface WorkspaceFolderInfo {
  name: string;
  /** Absolute path. */
  path: string;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface SharedRulesCoreDeps {
  /** All workspace folders, in order. */
  folders(): WorkspaceFolderInfo[];
  fs: RulesFs;
  /** The host's rule validator (`validateRule` of src/ui/controller.ts); throws a readable Error. */
  validateRule: ValidateRule;
  /** workspaceState: approvals by content hash. */
  memento: MementoLike;
  log?(msg: string): void;
  /** Called for every body file a rule refers to (resolved or not yet existing), so it can be watched. */
  watchBodyFile?(folder: string, rel: string): void;
}

interface Folder {
  info: WorkspaceFolderInfo;
  /** '' for the primary folder, else the (deduplicated) folder name. */
  key: string;
  file: string; // absolute
  /** Workspace-relative label used in problems and `state.file`. */
  label: string;
}

interface FolderState {
  folder: Folder;
  exists: boolean;
  /** Last good parse (kept while the file is broken). */
  good?: ParsedSharedFile;
  /** Set while the file on disk is broken / unreadable. */
  problem?: string;
}

interface PreparedWrite {
  folder: Folder;
  text: string;
  hash: string;
  /** Rule hashes to approve once written (the user's own personal rules being shared). */
  approve: string[];
  unchanged: boolean;
  hadComments: boolean;
}

export interface SharedRulesStatus {
  file?: string;
  count: number;
  problems: string[];
  pendingApproval: number;
}

const emptyState = (): SharedRulesState => ({ rules: [], problems: [], pendingApproval: [] });

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Shared rules first, then personal ones (a personal rule can't reuse a shared id: such a one is dropped). */
export function mergeRules(shared: Rule[], personal: Rule[]): Rule[] {
  const ids = new Set(shared.map((r) => r.id));
  return [...shared, ...personal.filter((r) => !ids.has(r.id) && !isSharedRuleId(r.id))];
}

/** A personal copy of a shared rule ("unshare"): the file id, no `shared` flag. */
export function toPersonalRule(rule: Rule): Rule {
  const { shared: _shared, ...rest } = rule;
  return { ...rest, id: rule.id.replace(/^shared(@[^:]*)?:/, '') };
}

export class SharedRulesCore {
  private folderStates: FolderState[] = [];
  private current: SharedRulesState = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private bodyCache = new Map<string, { size: number; mtimeMs: number; text: string }>();
  /** Held rules (id → folder + approval hash), from the last recompute. */
  private pendingInfo = new Map<string, { folder: Folder; hash: string }>();

  constructor(private readonly deps: SharedRulesCoreDeps) {}

  state(): SharedRulesState {
    return this.current;
  }

  /** For `Status.sharedRules`: undefined when there is no file and nothing to report. */
  status(): SharedRulesStatus | undefined {
    const s = this.current;
    if (!s.file && !s.problems.length) return undefined;
    return { file: s.file, count: s.rules.length, problems: s.problems, pendingApproval: s.pendingApproval.length };
  }

  /**
   * The rules awaiting approval, as shown to the user (names, match patterns and reasons sanitised: no control or
   * bidi characters, quoted, capped), and a hash identifying exactly this set for `approvePending`.
   */
  pendingSnapshot(): PendingSnapshot {
    const items: PendingSnapshot['items'] = [];
    const hashes: string[] = [];
    for (const r of this.current.pendingApproval) {
      const info = this.pendingInfo.get(r.id);
      if (!info) continue;
      hashes.push(info.hash);
      items.push({ folder: info.folder.label, name: ruleLabel(r), match: matchLabel(r), reason: approvalReasons(r).join('; ') });
    }
    return { hash: contentHash(hashes.sort()), items };
  }

  /** One readable line per held rule: `Rule "Staging" (GET https://api.example.com/*): sends … [file]`. */
  pendingReasons(): string[] {
    const multi = this.folderStates.length > 1;
    return this.pendingSnapshot().items.map((i) => `Rule ${i.name} (${i.match}): ${i.reason}${multi ? ` [${i.folder}]` : ''}`);
  }

  /** Every valid shared rule in file order (active and awaiting approval): the base for a `save` that edits one rule. */
  fileRules(): Rule[] {
    return this.folderStates.flatMap((f) => (f.good?.entries ?? []).filter((e) => e.rule).map((e) => e.rule!));
  }

  /** Files currently in use (absolute path + label), primary first. */
  files(): { path: string; label: string; folder: string }[] {
    return this.folderStates.filter((f) => f.exists).map((f) => ({ path: f.folder.file, label: f.folder.label, folder: f.folder.info.path }));
  }

  /** Absolute paths of the workspace folders whose file is used (watch these). */
  async candidateFolders(): Promise<WorkspaceFolderInfo[]> {
    return (await this.computeFolders()).map((f) => f.info);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async hasPubspec(dir: string): Promise<boolean> {
    try {
      return (await this.deps.fs.stat(path.join(dir, 'pubspec.yaml'))).isFile();
    } catch {
      return false;
    }
  }

  private async computeFolders(): Promise<Folder[]> {
    const all = this.deps.folders();
    const picked: WorkspaceFolderInfo[] = [];
    for (const f of all) {
      let flutter = await this.hasPubspec(f.path);
      if (!flutter) {
        try {
          for (const child of await this.deps.fs.readdir(f.path)) {
            if (child.isDirectory() && !child.name.startsWith('.') && (await this.hasPubspec(path.join(f.path, child.name)))) {
              flutter = true;
              break;
            }
          }
        } catch {
          // unreadable folder
        }
      }
      if (flutter) picked.push(f);
    }
    if (!picked.length && all.length) picked.push(all[0]);
    const used = new Set<string>();
    const multi = all.length > 1;
    return picked.map((info, i) => {
      let key = '';
      if (i > 0) {
        key = info.name || 'folder';
        for (let n = 2; used.has(key); n++) key = `${info.name}#${n}`;
        used.add(key);
      }
      return { info, key, file: path.join(info.path, SHARED_FILE), label: multi ? `${info.name}/${SHARED_FILE}` : SHARED_FILE };
    });
  }

  private approvals(): Record<string, string[]> {
    const v = this.deps.memento.get<unknown>(APPROVALS_KEY);
    const out: Record<string, string[]> = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, list] of Object.entries(v)) if (Array.isArray(list)) out[k] = list.filter((x): x is string => typeof x === 'string');
    }
    return out;
  }

  private approvedSet(folder: Folder): Set<string> {
    return new Set(this.approvals()[folder.info.path] ?? []);
  }

  /** Hashes of the gated valid rules of a parse. */
  private gatedHashes(folder: Folder, parsed: ParsedSharedFile): Map<string, string> {
    const out = new Map<string, string>(); // fileId → hash
    for (const e of parsed.entries) {
      if (e.rule && e.fileId !== undefined && approvalReason(e.rule)) out.set(e.fileId, ruleApprovalHash(folder.info.path, e.fileId, e.rule));
    }
    return out;
  }

  /** Reads one folder's file. `missing` when it doesn't exist; throws a readable Error when unreadable/unsafe. */
  private async readFile(folder: Folder): Promise<{ missing: true } | { missing: false; text: string }> {
    const { fs } = this.deps;
    let st: Awaited<ReturnType<RulesFs['stat']>>;
    try {
      st = await fs.stat(folder.file);
    } catch (e) {
      if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') return { missing: true };
      throw new Error(`${folder.label}: can't be read (${errno(e) ?? (e as Error).message})`);
    }
    let real: string;
    let root: string;
    try {
      real = fs.realpathSync(folder.file);
      root = fs.realpathSync(folder.info.path);
    } catch {
      return { missing: true };
    }
    if (!within(real, root)) throw new Error(`${folder.label}: points outside the workspace folder (symbolic link); ignored`);
    if (!st.isFile()) throw new Error(`${folder.label}: is not a regular file`);
    if (st.size > MAX_SHARED_FILE_BYTES) throw new Error(`${folder.label}: larger than 5 MB; ignored`);
    const bytes = await fs.readFile(real);
    if (bytes.byteLength > MAX_SHARED_FILE_BYTES) throw new Error(`${folder.label}: larger than 5 MB; ignored`);
    try {
      return { missing: false, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      throw new Error(`${folder.label}: is not UTF-8 text`);
    }
  }

  private parse(folder: Folder, text: string) {
    return parseSharedFile(text, { label: folder.label, folderKey: folder.key, validateRule: this.deps.validateRule });
  }

  /** Re-reads every file (watcher events, folder changes). Resolves to whether the state changed. */
  reload(): Promise<boolean> {
    return this.serial(() => this.reloadNow());
  }

  private async reloadNow(): Promise<boolean> {
    const folders = await this.computeFolders();
    const previous = new Map(this.folderStates.map((s) => [s.folder.file, s]));
    const next: FolderState[] = [];
    const approvals = this.approvals();
    let approvalsChanged = false;
    for (const folder of folders) {
      const prev = previous.get(folder.file);
      const st: FolderState = { folder, exists: false, good: prev?.good };
      try {
        const r = await this.readFile(folder);
        if (r.missing) {
          st.good = undefined;
        } else {
          st.exists = true;
          const parsed = this.parse(folder, r.text);
          if (parsed.ok) {
            st.good = parsed;
            const approved = approvals[folder.info.path];
            if (approved) {
              // rules that changed or left the file lose their approval
              const present = new Set(this.gatedHashes(folder, parsed).values());
              const kept = approved.filter((h) => present.has(h));
              if (kept.length !== approved.length) {
                if (kept.length) approvals[folder.info.path] = kept;
                else delete approvals[folder.info.path];
                approvalsChanged = true;
              }
            }
          } else {
            st.problem = parsed.problem;
          }
        }
      } catch (e) {
        st.exists = true;
        st.problem = (e as Error).message;
      }
      if (st.problem && st.good) st.problem += ' — using the last good version of the file';
      next.push(st);
    }
    if (approvalsChanged) await this.deps.memento.update(APPROVALS_KEY, approvals);
    this.folderStates = next;
    return this.recompute();
  }

  private recompute(): boolean {
    const s: SharedRulesState = emptyState();
    const labels: string[] = [];
    this.pendingInfo = new Map();
    for (const fs of this.folderStates) {
      if (fs.exists) labels.push(fs.folder.label);
      if (fs.problem) s.problems.push(fs.problem);
      const good = fs.good;
      if (!good) continue;
      s.problems.push(...good.problems);
      const approved = this.approvedSet(fs.folder);
      const gated = this.gatedHashes(fs.folder, good);
      for (const e of good.entries) {
        if (!e.rule) continue;
        const hash = e.fileId !== undefined ? gated.get(e.fileId) : undefined;
        if (hash !== undefined && !approved.has(hash)) {
          s.pendingApproval.push(e.rule);
          this.pendingInfo.set(e.rule.id, { folder: fs.folder, hash });
        } else s.rules.push(e.rule);
      }
    }
    if (labels.length) s.file = labels.join(', ');
    const changed = canonicalJson(s) !== canonicalJson(this.current);
    this.current = s;
    return changed;
  }

  // ------------------------------------------------------------------ approval

  /**
   * Approves exactly the held rules of `snapshotHash` (from `pendingSnapshot()` when the prompt was built). Refuses
   * with a readable Error when the held set changed since (the file changed while the user was deciding). Without a
   * hash: the rules held right now.
   */
  approvePending(snapshotHash?: string): Promise<boolean> {
    return this.serial(async () => {
      if (snapshotHash !== undefined && snapshotHash !== this.pendingSnapshot().hash) {
        throw new Error('The shared rules changed while you were deciding. Nothing was approved; review them again.');
      }
      const approvals = this.approvals();
      for (const { folder, hash } of this.pendingInfo.values()) {
        const list = approvals[folder.info.path] ?? [];
        if (!list.includes(hash)) list.push(hash);
        approvals[folder.info.path] = list;
      }
      await this.deps.memento.update(APPROVALS_KEY, approvals);
      return this.recompute();
    });
  }

  // ------------------------------------------------------------------ writing

  private folderOf(id: string): FolderState | undefined {
    if (!isSharedRuleId(id)) return this.folderStates[0];
    const split = splitSharedId(id, this.folderStates.map((f) => f.folder.key).filter(Boolean));
    return split ? this.folderStates.find((f) => f.folder.key === split.folderKey) : undefined;
  }

  private fileIdOf(id: string): string {
    return splitSharedId(id, this.folderStates.map((f) => f.folder.key).filter(Boolean))?.fileId ?? id;
  }

  /** Fresh parse of a folder's file for a write; throws when the file is broken (never overwrite the user's edit). */
  private async freshParse(folder: Folder): Promise<ParsedSharedFile | undefined> {
    const r = await this.readFile(folder);
    if (r.missing) return undefined;
    const parsed = this.parse(folder, r.text);
    if (!parsed.ok) throw new Error(`Fix ${folder.label} first: ${parsed.problem.replace(`${folder.label} `, '').replace(/^: /, '')}`);
    return parsed;
  }

  private async bodyTexts(folder: Folder, rules: Rule[]): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    for (const r of rules) {
      for (const a of bodyFileActions(r)) {
        try {
          texts.set(a.bodyFile, await this.readBodyFile(a.bodyFile, folder.info.path));
        } catch {
          // unreadable: its content isn't committed by this save either way
        }
      }
    }
    return texts;
  }

  /** File ids of the rules in `fresh` that await approval (gated, and that exact rule not approved). */
  private pendingFileIds(folder: Folder, fresh: ParsedSharedFile | undefined): Set<string> {
    const out = new Set<string>();
    if (!fresh) return out;
    const approved = this.approvedSet(folder);
    for (const [fileId, hash] of this.gatedHashes(folder, fresh)) if (!approved.has(hash)) out.add(fileId);
    return out;
  }

  /**
   * Prepares `rules` (in order) as the folder's new file content. Entries the caller can't change through a save
   * stay exactly as they are, at their positions: invalid / unknown entries (a teammate's newer rule kinds) and rules
   * awaiting approval — a pending rule passed in `rules` is ignored (only `removeShared` / editing the file changes
   * it). `drop` = file id of a pending rule to remove (`removeShared`). Throws (nothing written) for secrets, invalid
   * rules, duplicate ids. `personal` = ids of rules from the user's personal list (trusted for the approval gate).
   */
  private async prepareFolder(fs: FolderState, fresh: ParsedSharedFile | undefined, rules: Rule[], personal: Set<string>, drop?: string): Promise<PreparedWrite> {
    const folder = fs.folder;
    const pending = this.pendingFileIds(folder, fresh);
    if (drop !== undefined) pending.delete(drop);
    rules = rules.filter((r) => personal.has(r.id) || !pending.has(this.fileIdOf(r.id)));
    const written = rules.map((r) => toFileRule(r, this.fileIdOf(r.id)));
    const fileIds = new Set<string>();
    for (const [i, o] of written.entries()) {
      const id = o.id as string;
      if (fileIds.has(id) || pending.has(id)) throw new Error(`Not saved: two shared rules have the id "${id}"`);
      fileIds.add(id);
      // validate exactly what will be read back
      const back = this.parse(folder, JSON.stringify({ version: 1, rules: [o] }));
      if (!back.ok || !back.entries[0]?.rule) {
        const why = back.ok ? back.problems[0] ?? 'invalid' : back.problem;
        throw new Error(`Not saved: ${why.replace(/^.*? line \d+: /, '').replace(/ \(skipped\)$/, '').replace(/^rule 1\b/, `rule ${i + 1}`)}`);
      }
    }
    const texts = await this.bodyTexts(folder, rules);
    for (const r of rules) {
      const secret = secretProblem(r, (p) => texts.get(p));
      if (secret) throw new Error(secret);
    }
    const out: unknown[] = [...written];
    for (const [i, e] of (fresh?.entries ?? []).entries()) {
      const isPending = !!e.rule && e.fileId !== undefined && pending.has(e.fileId);
      const isInvalid = !e.rule && !(e.fileId !== undefined && fileIds.has(e.fileId));
      if (isPending || isInvalid) out.splice(Math.min(i, out.length), 0, e.raw);
    }
    const text = serializeSharedFile(out, fresh);
    const hash = contentHash(JSON.parse(text));
    // Only the user's own (personal) gated rules are approved by a write; edited shared rules get new hashes (pending)
    // and carried-over entries are never approved implicitly.
    const approve = rules.filter((r) => personal.has(r.id) && approvalReason(r)).map((r) => ruleApprovalHash(folder.info.path, this.fileIdOf(r.id), r));
    return { folder, text, hash, approve, unchanged: fresh?.hash === hash, hadComments: !!fresh?.hadComments };
  }

  private async commit(w: PreparedWrite): Promise<void> {
    if (w.unchanged) return; // same content: keep the user's formatting
    if (w.hadComments) this.deps.log?.(`shared rules: comments in ${w.folder.label} are not kept when Flutter Intercept writes it`);
    await this.atomicWrite(w.folder, w.text);
    if (w.approve.length) {
      const approvals = this.approvals();
      approvals[w.folder.info.path] = [...new Set([...(approvals[w.folder.info.path] ?? []), ...w.approve])];
      await this.deps.memento.update(APPROVALS_KEY, approvals);
    }
  }

  /** Creates `dir` (inside `root`) one level at a time, never through a symlink that leaves `root`. */
  private async ensureDirInside(dir: string, root: string): Promise<void> {
    const { fs } = this.deps;
    const realRoot = fs.realpathSync(root);
    let cur = root;
    for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      let real: string;
      try {
        real = fs.realpathSync(cur);
      } catch {
        await fs.mkdir(cur);
        real = fs.realpathSync(cur);
      }
      if (!within(real, realRoot)) throw new Error(`${path.relative(root, cur)} points outside the workspace folder (symbolic link); not written`);
    }
  }

  private async atomicWrite(folder: Folder, text: string, target = folder.file): Promise<void> {
    const { fs } = this.deps;
    await this.ensureDirInside(path.dirname(target), folder.info.path);
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    await fs.writeFile(tmp, text);
    try {
      await fs.rename(tmp, target);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Writes exactly `rules` (shared ones, possibly with namespaced ids, plus personal rules being shared) to the
   * file(s): namespaced ids go back to their folder's file, everything else to the primary folder's. Refuses (throws
   * a readable Error) when a file on disk is broken, a rule is invalid, or a value looks like a secret.
   * Rules awaiting approval and invalid entries always stay as they are, at their positions (omitting them doesn't
   * remove them; use `removeShared`). Callers should pass `fileRules()` or `state().rules` modified.
   */
  save(rules: Rule[]): Promise<void> {
    return this.serial(async () => {
      if (!this.folderStates.length) await this.reloadNow();
      if (!this.folderStates.length) throw new Error('Open the Flutter project folder to share rules');
      const byFolder = new Map<FolderState, Rule[]>(this.folderStates.map((f) => [f, []]));
      const personal = new Set<string>();
      for (const r of rules) {
        const f = this.folderOf(r.id);
        if (!f) throw new Error(`Not saved: rule ${ruleLabel(r)} belongs to a workspace folder that is no longer open`);
        if (!r.shared && !isSharedRuleId(r.id)) personal.add(r.id);
        byFolder.get(f)!.push(r);
      }
      // prepare every folder first, then write: a refusal leaves all files untouched
      const writes: PreparedWrite[] = [];
      for (const [f, list] of byFolder) {
        const fresh = await this.freshParse(f.folder);
        if (!fresh && !list.length) continue;
        writes.push(await this.prepareFolder(f, fresh, list, personal));
      }
      for (const w of writes) await this.commit(w);
      await this.reloadNow();
    });
  }

  /** Moves a personal rule into the primary folder's file (a new id when its id is taken). Returns the shared rule. */
  share(rule: Rule): Promise<Rule> {
    return this.serial(async () => {
      if (rule.shared || isSharedRuleId(rule.id)) throw new Error(`Rule ${ruleLabel(rule)} is already shared`);
      if (!this.folderStates.length) await this.reloadNow();
      const f = this.folderStates[0];
      if (!f) throw new Error('Open the Flutter project folder to share rules');
      const fresh = await this.freshParse(f.folder);
      const existing = (fresh?.entries ?? []).filter((e) => e.rule).map((e) => e.rule!);
      const taken = new Set((fresh?.entries ?? []).map((e) => e.fileId).filter((x): x is string => x !== undefined));
      let fileId = rule.id;
      for (let n = 2; taken.has(fileId); n++) fileId = `${rule.id}-${n}`;
      const { used: _used, expiresAt: _expires, ...clean } = rule;
      const added: Rule = { ...clean, id: fileId };
      await this.commit(await this.prepareFolder(f, fresh, [...existing, added], new Set([fileId])));
      await this.reloadNow();
      const id = namespaceId(fileId, f.folder.key);
      const result = [...this.current.rules, ...this.current.pendingApproval].find((r) => r.id === id);
      if (!result) throw new Error(`Rule ${ruleLabel(rule)} was written to ${f.folder.label} but could not be read back`);
      return result;
    });
  }

  /** Removes a shared rule from its file and returns it as a personal rule (the caller adds it to the personal list). */
  unshare(id: string): Promise<Rule> {
    return this.serial(async () => {
      const f = this.folderOf(id);
      if (!f || !isSharedRuleId(id)) throw new Error('Not a shared rule');
      if (this.current.pendingApproval.some((r) => r.id === id)) {
        throw new Error('This shared rule waits for approval: approve the shared rules first, or edit the file');
      }
      const fresh = await this.freshParse(f.folder);
      const fileId = this.fileIdOf(id);
      const entry = fresh?.entries.find((e) => e.rule && e.fileId === fileId);
      if (!fresh || !entry?.rule) throw new Error(`The rule is no longer in ${f.folder.label}`);
      const rest = fresh.entries.filter((e) => e.rule && e !== entry).map((e) => e.rule!);
      await this.commit(await this.prepareFolder(f, fresh, rest, new Set()));
      await this.reloadNow();
      return toPersonalRule(entry.rule);
    });
  }

  /** Deletes a shared rule from its file — also one awaiting approval (the only way besides editing the file). */
  removeShared(id: string): Promise<void> {
    return this.serial(async () => {
      const f = this.folderOf(id);
      if (!f || !isSharedRuleId(id)) throw new Error('Not a shared rule');
      const fresh = await this.freshParse(f.folder);
      const fileId = this.fileIdOf(id);
      const entry = fresh?.entries.find((e) => e.rule && e.fileId === fileId);
      if (!fresh || !entry) throw new Error(`The rule is no longer in ${f.folder.label}`);
      const rest = fresh.entries.filter((e) => e.rule && e !== entry).map((e) => e.rule!);
      await this.commit(await this.prepareFolder(f, fresh, rest, new Set(), fileId));
      await this.reloadNow();
    });
  }

  // ------------------------------------------------------------------ body files

  private workspaceRoots(): string[] {
    return this.deps.folders().map((f) => f.path);
  }

  /** Folder a rule's body file is relative to: its shared file's folder, else the primary folder. */
  folderPathFor(ruleId: string | undefined): string | undefined {
    if (ruleId !== undefined) {
      const f = this.folderOf(ruleId);
      if (f) return f.folder.info.path;
    }
    return this.folderStates[0]?.folder.info.path ?? this.deps.folders()[0]?.path;
  }

  /** Reads a body file (checks in bodyFile.ts); cached by size + mtime. Throws BodyFileError. */
  async readBodyFile(rel: string, folder: string | undefined = this.folderPathFor(undefined)): Promise<string> {
    if (!folder) throw new BodyFileError('Open the Flutter project folder to use body files');
    const syntax = bodyFileSyntaxError(rel);
    if (!syntax && within(bodyFileLocation(rel, folder), folder)) this.deps.watchBodyFile?.(folder, rel.replace(/\\/g, '/'));
    const { real, size, mtimeMs } = await checkBodyFile(rel, folder, this.workspaceRoots(), this.deps.fs);
    const cached = this.bodyCache.get(real);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.text;
    const bytes = await this.deps.fs.readFile(real);
    // the path must still resolve to the same place after reading (a symlink swapped in between)
    let again: string | undefined;
    try {
      again = this.deps.fs.realpathSync(real);
    } catch {
      again = undefined;
    }
    if (again !== real) throw new BodyFileError(`body file ${rel} changed while it was read; try again`);
    const text = decodeBodyFile(bytes, rel);
    this.bodyCache.set(real, { size, mtimeMs, text });
    if (this.bodyCache.size > 256) this.bodyCache.delete(this.bodyCache.keys().next().value as string);
    return text;
  }

  /** Forget cached body texts (a watcher saw a change). */
  invalidateBodyFile(): void {
    this.bodyCache.clear();
  }

  /**
   * `rules` with every `mock.bodyFile` (also in sequence steps) read into `body`. A rule whose body file can't be
   * used is left out, with a problem line. Call before `proxyHost.setRules`, and again on `onDidChangeBodyFile`.
   */
  async resolveBodies(rules: Rule[]): Promise<{ rules: Rule[]; problems: string[] }> {
    const out: Rule[] = [];
    const problems: string[] = [];
    for (const r of rules) {
      const actions = bodyFileActions(r);
      if (!actions.length) {
        out.push(r);
        continue;
      }
      const copy = structuredClone(r);
      try {
        for (const a of bodyFileActions(copy)) a.body = await this.readBodyFile(a.bodyFile, this.folderPathFor(r.id));
        out.push(copy);
      } catch (e) {
        problems.push(`Rule ${ruleLabel(r)} is off: ${(e as Error).message}`);
      }
    }
    return { rules: out, problems };
  }

  /**
   * "Edit body in a file": writes `text` to `.vscode/flutter-intercept/mocks/<name>.json|.txt` in the rule's folder
   * (never overwriting an existing file) and returns the folder-relative path to put in `mock.bodyFile`.
   */
  async createBodyFile(rule: Rule, text: string): Promise<string> {
    const folderPath = this.folderPathFor(rule.id);
    if (!folderPath) throw new Error('Open the Flutter project folder to keep mock bodies in files');
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_FILE_BYTES) throw new Error('The body is larger than 5 MB');
    const secret = bodyFileSecretProblem(text); // REVIEW-6 #5: files under .vscode/ get committed
    if (secret) throw new Error(secret);
    const folder: Folder = { info: { name: path.basename(folderPath), path: folderPath }, key: '', file: '', label: '' };
    const dir = path.join(folderPath, MOCKS_DIR);
    await this.ensureDirInside(dir, folderPath);
    const stem = bodyFileStem(rule);
    const ext = bodyFileExtension(text);
    let name = `${stem}${ext}`;
    for (let n = 2; await this.exists(path.join(dir, name)); n++) {
      if (n > 1000) throw new Error('Too many body files with this name');
      name = `${stem}-${n}${ext}`;
    }
    await this.atomicWrite(folder, text, path.join(dir, name));
    const rel = `${MOCKS_DIR}/${name}`;
    this.deps.watchBodyFile?.(folderPath, rel);
    return rel;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await this.deps.fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Why `text` must not be written to a body file (looks like it holds a credential), or undefined. */
  checkBodyFileContent(text: string): string | undefined {
    return bodyFileSecretProblem(text);
  }

  /** Absolute path a body file reference points at (unchecked; for "open the file" commands use readBodyFile first). */
  bodyFilePath(rel: string, ruleId?: string): string | undefined {
    const folder = this.folderPathFor(ruleId);
    return folder && !bodyFileSyntaxError(rel) ? bodyFileLocation(rel, folder) : undefined;
  }
}
