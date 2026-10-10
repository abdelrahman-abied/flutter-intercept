/**
 * Routes CONTRACTS §4 messages between the webview(s) and the proxy host. No `vscode` import,
 * so it is unit-tested with a fake host.
 *
 * Host obligations (CONTRACTS §4, docs/spikes/webview.md): `snapshot` for every `ready`;
 * `rules` after `setRules` / `createRuleFromExchange` (new rule inserted FIRST); `cleared` then a
 * fresh `snapshot` after `clear` (the proxy keeps in-flight exchanges); `status` after
 * `setInterceptEnabled`; `removed` for evictions; `error` for failed actions.
 * `exchange` updates are coalesced per id and flushed every `throttleMs`.
 *
 * CONTRACTS §9.3/9.4: `sent` after `send`; `status` after `setNetworkProfile`; `openSource` / `copySnippet`
 * go through injected deps (no reply on success, `error` on failure); a `rule-spent` event from the host
 * removes that rule (persisted + `rules` broadcast).
 *
 * CONTRACTS §10.5: `rules` after `mutateField`; `contract` results (batched with `exchange` updates) for every
 * finished JSON exchange while checking is on, and for the current snapshot on `ready`; `pickModel`,
 * `openViolation`, `generateModel`, `generateFixture` go through injected deps (`error` on failure).
 *
 * CONTRACTS §11: `status` (with `warnings`) after every host 'warnings' event; rules can't be made from read-only
 * `captured: 'vm-profile'` exchanges (nor resent); WebSocket exchanges only get block rules (ws(s):// patterns
 * only block / fault). WebSocket/SSE
 * exchanges are sent to the panel with at most UI_MAX_FRAMES newest frames (and UI_MAX_FRAME_CHARS of payload);
 * the rest is folded into `framesDropped` (the agent API reads the host's full list).
 *
 * CONTRACTS §12.7 (v0.6.0): the host's rule list is `[...shared, ...personal]` (`setSharedRules` replaces the
 * shared part, which comes from SharedRulesService); `saveRules` persists the personal rules only, and changes to
 * shared rules from the panel (edit, remove, `shareRule`) are written through the injected shared service.
 * `approveSharedRules`, `saveRecording` / `replayRecording` / `diffRecordings` / `deleteRecording` (injected
 * RecordingService + `openDiff`), `expireToken` (preset rule inserted first). `recordings` is broadcast after every
 * change and sent on `ready`; `authFlows` (injected `analyzeAuth`) at most every `authDebounceMs` (1 s) after
 * exchange changes while a panel is attached, and on `ready`. `Status.replay` / `Status.sharedRules` come from the
 * host / the shared service.
 *
 * CONTRACTS §13 (v0.7.0): `script` rule actions are validated here (the proxy host reads `script.file` into `code`);
 * `export {format, ids?}` asks redact-or-keep every time (injected `pickOne`), then a save dialog, writes the file and
 * replies `exported`; `openScriptFile` (like `openBodyFile`, `.js` only) and `openInNewWindow` go through injected deps;
 * `select(id)` (a notification's "Show") posts `select` to every attached view.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Exchange, ReplayEntry, ReplayOptions, RequestEdit, ResponseEdit, Rule, RuleAction, SendRequest } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
import { ruleFromExchange, ruleProblem } from '@flutter-intercept/proxy/rules';
import { pathError } from '../agent/paths';
import { decodeJson, decodeSample, defaultFixtureName, FINAL_STATES, defaultModelName, fixtureApiFor, fixtureSamples, isCheckable, modelSamples, redactExchange, routeOf, testPackageFor } from '../agent/samples';
import { SNIPPET_FORMATS, toSnippet } from '../codegen/snippets';
import type { CodegenService, FixtureApi, GeneratedFile } from '../codegen/types';
import type { ContractResult, ContractService } from '../contract/types';
import type { AuthAnalysis } from '../analysis/types';
import type { Recording, RecordingMeta, RecordingService } from '../recordings/types';
import type { SharedRulesService, SharedRulesState } from '../rules/types';
import type { ToOpenApi, ToPostman } from '../export/types';
import { scriptFileOf, scriptFileSyntaxError, scriptTemplate } from '../rules/scriptFile';
import { buildHar, ensureDirInside, EXPORT_DIR } from '../agent/har';
import { gitIgnoreStatus, type GitignoreFs } from '../recordings/gitignore';
import type { AgentStatus, AuthFlowSummary, ContractSummary, ExportFormat, HostMsg, RecordingSummary, SendDraft, SessionWarning, SnippetFormat, Status, ViewMsg } from './protocol';

export type Sink = (msg: HostMsg) => void;

export interface ControllerHost {
  readonly running: boolean;
  readonly port: number | undefined;
  /** Open LAN listener (no token), CONTRACTS §7; `peer` = the device it is pinned to. */
  readonly lan?: { host: string; port: number; peer?: string };
  getExchanges(): Exchange[];
  getRules(): Rule[];
  setRules(rules: Rule[]): void;
  clear(): void;
  resume(id: string, edit?: RequestEdit | ResponseEdit): void;
  abort(id: string): void;
  on(event: 'exchange', l: (e: Exchange) => void): unknown;
  on(event: 'removed', l: (ids: string[]) => void): unknown;
  on(event: 'state', l: (running: boolean) => void): unknown;
  /** CONTRACTS §9.2: a rule's `times` were used up or it expired. Optional on older hosts. */
  on(event: 'rule-spent', l: (ruleId: string, reason: 'times' | 'expired') => void): unknown;
  /** CONTRACTS §9.2: a rule with `times` matched; `used` = matches so far. Optional on older hosts. */
  on(event: 'rule-hit', l: (ruleId: string, used: number) => void): unknown;
  /** CONTRACTS §9.2 `send` (through the proxy, recorded with `initiator`). Optional: older proxy builds lack it. */
  send?(req: SendRequest): Promise<{ id: string }>;
  setNetworkProfile?(p: NetworkProfile): void;
  readonly networkProfile?: NetworkProfile;
  /** CONTRACTS §11.4: the current session warnings (InterceptProxyHost.warnings). Optional on older hosts. */
  readonly warnings?: SessionWarning[];
  /** Fires after every change of `warnings`. */
  on(event: 'warnings', l: (warnings: SessionWarning[]) => void): unknown;
  // CONTRACTS §12.4 (InterceptProxyHost). Optional: without them replay answers with an `error`.
  readonly replay?: { id?: string; recording: string; fallback: 'passthrough' | 'fail' };
  setReplay?(entries: ReplayEntry[] | undefined, opts?: ReplayOptions, meta?: { id?: string; name: string }): void;
  /** Fires after every replay start / stop. */
  on(event: 'replay', l: (state: unknown) => void): unknown;
  /** REVIEW-6 #1 (InterceptProxyHost.upstreamProxyInfo): `host:port` of the upstream proxy in use (never credentials). */
  readonly upstreamProxyInfo?: { display: string; ignoreCertErrors: boolean };
  /** Fires after the upstream proxy changed. */
  on(event: 'upstream', l: (info: unknown) => void): unknown;
}

/**
 * CONTRACTS §12.1: what the controller needs of SharedRulesService. `save` keeps held-back (pending) and invalid
 * entries at their file positions; `removeShared` deletes one entry (the only way to delete a pending one);
 * `pendingReasons` gives one line per held-back rule (`Rule "Staging" sends the app's requests to …`).
 */
export type SharedRulesDeps = Pick<SharedRulesService, 'state' | 'save' | 'approvePending'> & {
  removeShared?(id: string): Promise<void>;
  pendingReasons?(): string[];
};

/** `Rule "Name" reason…` → {name, reason}; other lines keep the whole text as the reason. At most 50, each capped. */
export function pendingView(lines: readonly string[] | undefined): { name: string; reason: string }[] {
  return (lines ?? []).slice(0, 50).flatMap((line) => {
    if (typeof line !== 'string' || !line.trim()) return [];
    const m = /^Rule "((?:[^"\\]|\\.)*)"\s+([\s\S]+)$/.exec(line.trim());
    const name = m ? m[1] : 'Shared rule';
    const reason = (m ? m[2] : line.trim()).replace(/[\r\n]+/g, ' ');
    return [{ name: name.slice(0, 200), reason: reason.slice(0, 500) }];
  });
}

export interface ControllerDeps {
  host: ControllerHost;
  saveRules: (rules: Rule[]) => unknown;
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => Promise<unknown>;
  newRuleId?: () => string;
  throttleMs?: number;
  log?: (msg: string) => void;
  /** CONTRACTS §8: what the status line shows about AI agents (never the MCP token). */
  getAgentStatus?: () => AgentStatus | undefined;
  /**
   * CONTRACTS §9.4: open `exchange.source.frames[frameIndex]` in an editor (src/source/open.ts). Rejects with a
   * user-readable message ("file not in the workspace", …), which the webview shows.
   */
  openSource?: (exchange: Exchange, frameIndex: number) => Promise<unknown>;
  /** Writes the user's clipboard (`vscode.env.clipboard.writeText`). */
  copyToClipboard?: (text: string) => Promise<unknown>;

  // ---- CONTRACTS §10 (v0.4.0). All optional: without them the matching features answer with an `error`.
  /** The contract checker (src/contract/service.ts). */
  contract?: ContractService;
  /** Setting `flutterIntercept.contractCheck` (default true). Call `recheckContracts()` when it changes. */
  contractCheckEnabled?: () => boolean;
  /** Every new contract result (the lead updates the diagnostics). */
  onContractResult?: (result: ContractResult) => void;
  /** Results dropped: exchanges evicted / cleared, proxy restarted, models changed, checking turned off. */
  onContractRemoved?: (exchangeIds: string[]) => void;
  /** Native model QuickPick for `pickModel`: a model name, undefined = "Don't check this route" (forget), null = cancelled. */
  pickModel?: (exchange: Exchange) => Promise<string | undefined | null>;
  /** Opens `file` (absolute) at the 1-based `line` (`openViolation`). */
  openLocation?: (file: string, line: number) => Promise<unknown>;
  /** Code generation (src/codegen/service.ts). */
  codegen?: CodegenService;
  /** Opens each generated file in an untitled editor. */
  openUntitled?: (files: GeneratedFile[]) => Promise<unknown>;
  /** The Flutter project's root (style detection). */
  projectRoot?: () => string | undefined;
  /** The app's pubspec `name` (fixture imports). */
  appPackageName?: () => string | undefined;
  /** Delay before queued checks start (default 150 ms) and how many run at once (default 2). */
  contractDebounceMs?: number;
  contractConcurrency?: number;
  /** REVIEW-5 #4: min ms between panel updates of one open WebSocket / SSE exchange (default UI_STREAM_UPDATE_MS). */
  streamUpdateMs?: number;

  // ---- CONTRACTS §12 (v0.6.0). All optional: without them the matching messages answer with an `error`.
  /** Shared rules (src/rules/**): file state, writes, approval. The lead also calls `setSharedRules` on every change. */
  shared?: SharedRulesDeps;
  /** Recordings (src/recordings/**). */
  recordings?: RecordingService;
  /** Opens a side-by-side diff of two recordings (`vscode.diff` over `RecordingService.diffText`). */
  openDiff?: (a: Recording, b: Recording) => Promise<unknown>;
  /** Auth-flow analysis (src/analysis/**, pure). */
  analyzeAuth?: (exchanges: Exchange[]) => AuthAnalysis;
  /** Min ms between `authFlows` pushes (default 1000). */
  authDebounceMs?: number;
  /** Opens `.vscode/flutter-intercept.json` (creating it when missing is up to the implementation). */
  openSharedRules?: () => Promise<unknown>;
  /**
   * Opens a workspace-relative mock body file; with `create`, creates it with that content when missing (never
   * overwrites). REVIEW-7 #6: `ruleId` = resolve in that rule's workspace folder (a shared rule's own folder).
   */
  openBodyFile?: (path: string, create?: { content: string }, ruleId?: string) => Promise<unknown>;

  // ---- CONTRACTS §13 (v0.7.0). All optional: without them the matching messages answer with an `error`.
  /** OpenAPI / Postman builders (src/export/**, pure). HAR is built here (src/agent/har.ts). */
  exporters?: { openapi?: ToOpenApi; postman?: ToPostman };
  /** A QuickPick of plain labels (`vscode.window.showQuickPick`); undefined = cancelled. */
  pickOne?: (items: string[], placeHolder: string) => Promise<string | undefined>;
  /** Save dialog (`vscode.window.showSaveDialog`) starting at `defaultPath`; resolves the chosen absolute path. */
  showSaveDialog?: (defaultPath: string, format: ExportFormat) => Promise<string | undefined>;
  /**
   * Writes an export the user chose to save. `private` (REVIEW-7 #9: values kept) = owner-only (0600). Default:
   * fs.promises.writeFile + chmod.
   */
  writeFile?: (file: string, text: string, opts: { private: boolean }) => Promise<unknown>;
  /** REVIEW-7 #9: a modal warning with one confirming button; resolves true when it was clicked. */
  confirmWarning?: (message: string, button: string) => Promise<boolean>;
  /** Reads for the "would git commit this file?" check (default: the real file system). */
  gitFs?: GitignoreFs;
  /** Extension version (HAR creator). */
  version?: string;
  /**
   * Opens a workspace-relative `.js` script file (inside the workspace only); with `create`, creates it with that
   * content — and fails when the file already exists (REVIEW-7 #1; the error reaches the view). REVIEW-7 #6:
   * `ruleId` = resolve in that rule's workspace folder.
   */
  openScriptFile?: (path: string, create?: { content: string }, ruleId?: string) => Promise<unknown>;
  /** Opens the panel as an editor in its own window (src/ui/panel.ts `openInNewWindow`). */
  openInNewWindow?: () => unknown;
}

/** CONTRACTS §13.5: the redaction choice offered on every export from the panel / commands. */
export const EXPORT_REDACT = 'Redact secrets (recommended)';
export const EXPORT_KEEP = 'Keep values';
/** CONTRACTS §13.5: default file name suffix per format. */
export const EXPORT_SUFFIX: Record<ExportFormat, string> = { openapi: '.openapi.json', postman: '.postman_collection.json', har: '.har' };
const EXPORT_FORMATS = new Set<ExportFormat>(['openapi', 'postman', 'har']);
/** REVIEW-7 #9: asked when an export with live values would land in a file git would commit. */
export const EXPORT_GIT_WARNING = 'This file would be committed with live credentials: it is inside a git repository and not ignored. Save it there anyway?';
export const EXPORT_GIT_CONFIRM = 'Save Anyway';

const nodeGitFs: GitignoreFs = {
  async kind(p) {
    try {
      const st = await fs.promises.lstat(p);
      return st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
    } catch {
      return undefined;
    }
  },
  readFile: (p) => fs.promises.readFile(p, 'utf8'),
};

/** The real path of `file` (it need not exist yet): its folder's real path + its name. */
async function realTarget(file: string): Promise<string> {
  try {
    return path.join(await fs.promises.realpath(path.dirname(file)), path.basename(file));
  } catch {
    return path.resolve(file);
  }
}

async function writeExport(file: string, text: string, opts: { private: boolean }): Promise<void> {
  await fs.promises.writeFile(file, text, { encoding: 'utf8', ...(opts.private ? { mode: 0o600 } : {}) });
  if (opts.private) await fs.promises.chmod(file, 0o600); // `mode` only applies to a new file
}

/** REVIEW-7 #6: an optional rule id on a view message. */
function checkRuleId(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v || v.length > 200) fail(where, 'ruleId must be a rule id');
  return v;
}

/** CONTRACTS §12.4: the exchanges a recording keeps — finished plain HTTP traffic the app made through the proxy. */
export function isRecordable(e: Exchange): boolean {
  return FINAL_STATES.has(e.state) && !e.kind && e.captured !== 'vm-profile' && !e.browserInternal;
}

export function recordingSummary(m: RecordingMeta): RecordingSummary {
  return { id: m.id, name: m.name, createdAt: m.createdAt, exchanges: m.exchanges, redacted: m.redacted };
}

export function authFlowSummaries(a: AuthAnalysis | undefined): AuthFlowSummary[] {
  return (a?.flows ?? []).map((f) => ({
    steps: f.steps.map((s) => ({ exchangeId: s.exchangeId, role: s.role })),
    ...(f.stampede ? { stampede: { refreshCalls: f.stampede.refreshCalls, windowMs: f.stampede.windowMs } } : {}),
    ...(f.problem ? { problem: f.problem } : {}),
  }));
}

/** Status.sharedRules from the service state (omitted when there is neither a file nor anything to say). */
export function sharedRulesStatus(s: SharedRulesState | undefined): Status['sharedRules'] {
  if (!s) return undefined;
  if (!s.file && !s.rules.length && !s.problems.length && !s.pendingApproval.length) return undefined;
  return { ...(s.file ? { file: s.file } : {}), count: s.rules.length, problems: s.problems.slice(0, 50), pendingApproval: s.pendingApproval.length };
}

/** Deep JSON equality, object key order ignored (`used` is display-only and ignored). */
function sameRules(a: Rule[], b: Rule[]): boolean {
  const norm = (r: Rule) => {
    const { used: _u, ...rest } = r;
    return rest;
  };
  return a.length === b.length && a.every((r, i) => deepEqual(norm(r), norm(b[i])));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** CONTRACTS §10.5: the panel's view of a contract result (no file paths). */
export function contractSummary(r: ContractResult): ContractSummary {
  return {
    id: r.exchangeId,
    checked: r.checked,
    ...(r.model ? { model: r.model } : {}),
    via: r.via,
    violations: r.violations.map((v) => ({ path: v.path, field: v.field, expected: v.expected, actual: v.actual, severity: v.severity, message: v.message })),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

const CONTRACT_OFF = 'Contract check is off (setting flutterIntercept.contractCheck).';

/**
 * CONTRACTS §10.4: the Retrofit/Chopper interface a mocktail fixture test mocks, from the contract service's
 * endpoint index. Undefined (the generator then falls back to MockClient) without a service or a match.
 */
export async function fixtureApi(
  contract: ContractService | undefined,
  exchanges: Exchange[],
  root: string | undefined,
  packageName: string | undefined,
  log?: (msg: string) => void,
): Promise<FixtureApi | undefined> {
  if (!contract) return undefined;
  try {
    const [endpoints, models] = await Promise.all([contract.endpoints(), contract.models()]);
    return fixtureApiFor(endpoints, exchanges, models, { root, packageName });
  } catch (e) {
    log?.(`fixture API lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Kinds `createRuleFromExchange` can build (throttle/fault rules come from the rule editor). */
const RULE_KINDS = new Set<RuleAction['kind']>(['mock', 'block', 'breakpoint']);
const FAULTS = new Set(['reset', 'timeout', 'truncate', 'dns']);
const PRESET_IDS = new Set(['slow-3g', 'fast-3g', 'flaky']);

/** CONTRACTS §11: what the panel gets of a WebSocket / SSE exchange's frames (the newest; the rest is counted). */
export const UI_MAX_FRAMES = 200;
export const UI_MAX_FRAME_CHARS = 2_000_000;
/** REVIEW-5 #4: an open WebSocket / SSE exchange updates the panel at most every this many ms (≤ 2×/s). */
export const UI_STREAM_UPDATE_MS = 500;

type Frame = NonNullable<Exchange['frames']>[number];

/** A frame's weight, as the proxy counts it (packages/proxy/src/frames.ts `frameCost`, not exported). */
export function uiFrameCost(f: Frame): number {
  return (f.text?.length ?? 0) + (f.base64?.length ?? 0) + (f.event?.length ?? 0) + (f.id?.length ?? 0) + 32;
}

/** A WebSocket / SSE exchange that is still open (its frames keep changing). */
function isLiveStream(e: Exchange): boolean {
  return !!e.kind && e.state === 'pending';
}

/**
 * The exchange as sent to the webview: at most UI_MAX_FRAMES newest frames and UI_MAX_FRAME_CHARS of frame
 * payload (text, base64, SSE event name and id: `uiFrameCost`), the older ones added to `framesDropped`. Other exchanges are returned as is.
 */
export function uiExchange(e: Exchange): Exchange {
  const frames = e.frames;
  if (!frames || !frames.length) return e;
  let keep = 0;
  let chars = 0;
  for (let i = frames.length - 1; i >= 0 && keep < UI_MAX_FRAMES; i--) {
    const n = uiFrameCost(frames[i]);
    if (keep > 0 && chars + n > UI_MAX_FRAME_CHARS) break;
    chars += n;
    keep++;
  }
  if (keep === frames.length) return e;
  return { ...e, frames: frames.slice(frames.length - keep), framesDropped: (e.framesDropped ?? 0) + (frames.length - keep) };
}

/** CONTRACTS §11.4: why a rule / resend can't be based on this exchange, or undefined. */
export function readOnlyReason(e: Exchange): string | undefined {
  if (e.captured === 'vm-profile') {
    return "this request was made by a native HTTP client (read from the app's HTTP profile); it never went through the proxy, so rules can't change it and it can't be resent from here";
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Host-side validation of everything the webview sends (review #7). The webview is ours, but
// the host must never persist or apply a malformed rule (a rule without `match` must not become
// match-all) nor forward an edit the proxy would turn into a broken response for the app.
// ---------------------------------------------------------------------------------------------

export class InvalidMessageError extends Error {}

const MAX_RULES = 1000;
const MAX_TEXT = 64 * 1024 * 1024; // bodies (well above the proxy's 5 MB body cap)
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // RFC 9110 token (header names, methods)

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(where: string, what: string): never {
  throw new InvalidMessageError(`${where}: ${what}`);
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(where, `unknown field "${k}"`);
}

function checkStatus(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 100 || v > 599) fail(where, 'status must be an integer 100–599');
  return v;
}

function checkHeaderValue(v: unknown, where: string): void {
  if (typeof v !== 'string') fail(where, 'header values must be strings');
  if (/[\r\n\0]/.test(v)) fail(where, 'header values must not contain CR, LF or NUL');
}

/** `Record<string, string>` (mock headers) or, with `multi`, `Record<string, string | string[]>` (edits). */
function checkHeaders(v: unknown, where: string, multi: boolean): void {
  if (!isObj(v)) fail(where, 'headers must be an object');
  for (const [name, value] of Object.entries(v)) {
    if (!TOKEN.test(name)) fail(where, `invalid header name "${name}"`);
    if (multi && Array.isArray(value)) value.forEach((x) => checkHeaderValue(x, `${where} "${name}"`));
    else checkHeaderValue(value, `${where} "${name}"`);
  }
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** latencyMs 0–600000 (integer), kbps 1–10 000 000, dropRate 0–1; each optional. */
function checkThrottle(a: Record<string, unknown>, where: string): void {
  if (a.latencyMs !== undefined && !isInt(a.latencyMs, 0, 600_000)) fail(where, 'latencyMs must be an integer 0–600000');
  if (a.kbps !== undefined && !isNum(a.kbps, 1, 10_000_000)) fail(where, 'kbps must be a number 1–10000000');
  if (a.dropRate !== undefined && !isNum(a.dropRate, 0, 1)) fail(where, 'dropRate must be a number 0–1');
}

function checkUrl(v: unknown, where: string): string {
  if (typeof v !== 'string') fail(where, 'url must be a string');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    fail(where, `url must be absolute: ${v}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(where, 'url must be http(s)');
  return v;
}

function checkBody(v: unknown, where: string): void {
  if (typeof v !== 'string') fail(where, 'body must be a string');
  if (v.length > MAX_TEXT) fail(where, 'body is too large');
}

export const MAX_MUTATE_OPS = 20;
const MAX_MUTATE_VALUE_CHARS = 1024 * 1024;
const MUTATE_OPS = new Set(['null', 'delete', 'set']);

/**
 * CONTRACTS §10.2: 1–20 ops; path valid (jsonpath.ts), op null|delete|set; `set` needs `value` (a JSON value) or
 * `valueJson` (JSON text, byte-exact, wins over `value`), each ≤ 1 MB.
 */
function checkMutateOps(ops: unknown, where: string): void {
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_MUTATE_OPS) fail(where, `ops must be a list of 1–${MAX_MUTATE_OPS} changes`);
  ops.forEach((op, i) => {
    const ow = `${where}.ops[${i}]`;
    if (!isObj(op)) fail(ow, 'must be an object');
    onlyKeys(op, ['path', 'op', 'value', 'valueJson'], ow);
    const bad = pathError(op.path);
    if (bad) fail(ow, bad);
    if (typeof op.op !== 'string' || !MUTATE_OPS.has(op.op)) fail(ow, 'op must be "null", "delete" or "set"');
    if (op.op !== 'set') {
      if (op.value !== undefined || op.valueJson !== undefined) fail(ow, `value / valueJson are only used with op "set"`);
      return;
    }
    if (op.valueJson !== undefined) {
      if (typeof op.valueJson !== 'string') fail(ow, 'valueJson must be a string of JSON text');
      if (op.valueJson.length > MAX_MUTATE_VALUE_CHARS) fail(ow, 'valueJson must be at most 1 MB');
      try {
        JSON.parse(op.valueJson);
      } catch {
        fail(ow, 'valueJson must be valid JSON text (e.g. "1.0", "12345678901234567890", "\\"text\\"")');
      }
    }
    if (op.value === undefined) {
      if (op.valueJson === undefined) fail(ow, 'op "set" needs a value (or valueJson)');
      return;
    }
    let text: string | undefined;
    try {
      text = JSON.stringify(op.value);
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string' || !isJsonValue(op.value)) fail(ow, 'value must be a JSON value (string, number, boolean, null, array or object)');
    if (text.length > MAX_MUTATE_VALUE_CHARS) fail(ow, 'value must be at most 1 MB as JSON');
  });
}

/** Plain JSON only: no functions, symbols, bigints, NaN/Infinity, class instances or cycles (depth ≤ 200). */
function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 200) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v as Record<string, unknown>).every((x) => isJsonValue(x, depth + 1));
  }
  return false;
}

export function validateRule(raw: unknown, where = 'rule'): Rule {
  if (!isObj(raw)) fail(where, 'must be an object');
  // `used` is display-only (CONTRACTS §9.2 rule-hit): accepted so the webview can round-trip rules, then dropped.
  onlyKeys(raw, ['id', 'enabled', 'name', 'match', 'action', 'times', 'expiresAt', 'used', 'shared'], where);
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 200) fail(where, 'id must be a non-empty string');
  if (typeof raw.enabled !== 'boolean') fail(where, 'enabled must be a boolean');
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 500)) fail(where, 'name must be a string');
  if (raw.times !== undefined && !isInt(raw.times, 1, 1000)) fail(where, 'times must be an integer 1–1000');
  if (raw.expiresAt !== undefined && (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= 0)) {
    fail(where, 'expiresAt must be a time in epoch milliseconds');
  }
  // CONTRACTS §12.1: set by the shared-rules service (rules from .vscode/flutter-intercept.json).
  if (raw.shared !== undefined && raw.shared !== true) fail(where, 'shared must be true or absent');
  const m = raw.match;
  if (!isObj(m)) fail(where, 'match is required (a rule without match would match everything)');
  onlyKeys(m, ['url', 'method', 'graphqlOperation'], `${where}.match`);
  if (typeof m.url !== 'string' || !m.url.trim() || m.url.length > 8192) fail(`${where}.match`, 'url must be a non-empty string (use "*" to match everything)');
  if (m.method !== undefined && (typeof m.method !== 'string' || (m.method !== '' && m.method !== '*' && !TOKEN.test(m.method)))) {
    fail(`${where}.match`, 'method must be an HTTP method name');
  }
  if (m.graphqlOperation !== undefined && (typeof m.graphqlOperation !== 'string' || m.graphqlOperation.length > 200 || !GRAPHQL_NAME.test(m.graphqlOperation))) {
    fail(`${where}.match`, 'graphqlOperation must be a GraphQL operation name (letters, digits, _; not starting with a digit; at most 200)');
  }
  const action = validateAction(raw.action, `${where}.action`, false);
  const out: Record<string, unknown> = { ...raw, action };
  delete out.used;
  // CONTRACTS §11.1 / REVIEW-5 #16: refuse rules the proxy can never apply (e.g. a mock or a truncate fault on a
  // ws:// URL, a GraphQL operation on a WebSocket upgrade, a script on a WebSocket). CONTRACTS §13.4: a script whose
  // `file` supplies the code is checked as if it had code (the host reads the file before the proxy gets it).
  const probe =
    action.kind === 'script' && action.file !== undefined && !action.code.trim() ? { ...out, action: { ...action, code: '/* read from file */' } } : out;
  const problem = ruleProblem(probe as unknown as Rule);
  if (problem) fail(where, problem);
  return out as unknown as Rule;
}

/** CONTRACTS §12.3: sequence limits. */
export const MAX_SEQUENCE_STEPS = 50;
/** CONTRACTS §12.6: rewrite limits. */
export const MAX_REWRITE_HEADERS = 50;
export const MAX_REWRITE_REPLACEMENTS = 20;
const MAX_REWRITE_FIND = 10 * 1024;
/** REVIEW-6 #3: each replacement text, and all find + replace texts of one rule together (the proxy also caps the output). */
export const MAX_REWRITE_REPLACE = 64 * 1024;
export const MAX_REWRITE_TEXT_TOTAL = 256 * 1024;
/** CONTRACTS §12.2: `mock.bodyFile` length. */
export const MAX_BODY_FILE_PATH = 300;
const SEQUENCE_THEN = new Set(['last', 'passthrough', 'loop']);
/** Headers a rewrite may not set on the request: framing and hop-by-hop ones the proxy owns, and the proxy's credential. */
const REWRITE_REQUEST_FORBIDDEN = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'x-fi-id']);
const REWRITE_RESPONSE_FORBIDDEN = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade']);

/**
 * One rule action. Inside a sequence step (`inStep`), `{kind:'passthrough'}` is allowed and `breakpoint` /
 * `sequence` are not (CONTRACTS §12.3). Returns a copy (mock `body` defaults to "" when `bodyFile` is given).
 */
function validateAction(a: unknown, aw: string, inStep: boolean): RuleAction {
  if (!isObj(a)) fail(aw.replace(/\.action$/, ''), 'action is required');
  switch (a.kind) {
    case 'mock': {
      onlyKeys(a, ['kind', 'status', 'headers', 'body', 'delayMs', 'bodyFile'], aw);
      checkStatus(a.status, aw);
      if (a.headers !== undefined) checkHeaders(a.headers, aw, false);
      if (a.bodyFile !== undefined) checkBodyFile(a.bodyFile, aw);
      if (a.body !== undefined || a.bodyFile === undefined) checkBody(a.body, aw);
      if (a.delayMs !== undefined && (typeof a.delayMs !== 'number' || !Number.isInteger(a.delayMs) || a.delayMs < 0 || a.delayMs > 600_000)) {
        fail(aw, 'delayMs must be an integer 0–600000');
      }
      return { ...a, body: (a.body as string | undefined) ?? '' } as RuleAction;
    }
    case 'block':
      onlyKeys(a, ['kind', 'mode', 'status'], aw);
      if (a.mode !== 'reset' && a.mode !== 'status') fail(aw, 'mode must be "reset" or "status"');
      if (a.status !== undefined) checkStatus(a.status, aw);
      break;
    case 'breakpoint':
      if (inStep) fail(aw, 'a sequence step cannot be a breakpoint');
      onlyKeys(a, ['kind', 'phase'], aw);
      if (a.phase !== 'request' && a.phase !== 'response' && a.phase !== 'both') fail(aw, 'phase must be "request", "response" or "both"');
      break;
    case 'throttle':
      onlyKeys(a, ['kind', 'latencyMs', 'kbps', 'dropRate'], aw);
      checkThrottle(a, aw);
      break;
    case 'fault':
      onlyKeys(a, ['kind', 'fault'], aw);
      if (typeof a.fault !== 'string' || !FAULTS.has(a.fault)) fail(aw, 'fault must be "reset", "timeout", "truncate" or "dns"');
      break;
    case 'mutate':
      onlyKeys(a, ['kind', 'ops'], aw);
      checkMutateOps(a.ops, aw);
      break;
    case 'cors':
      onlyKeys(a, ['kind', 'allowOrigin', 'allowCredentials'], aw);
      if (typeof a.allowOrigin === 'string' && a.allowOrigin.trim().toLowerCase() === 'null') {
        fail(aw, 'allowOrigin "null" is refused: sandboxed frames and file pages send it, so it would let any of them read the responses');
      }
      if (a.allowOrigin !== undefined && !isAllowOrigin(a.allowOrigin)) {
        fail(aw, 'allowOrigin must be "*" or one origin such as "http://localhost:5000" (at most 500 characters, no spaces or commas)');
      }
      if (a.allowCredentials !== undefined && typeof a.allowCredentials !== 'boolean') fail(aw, 'allowCredentials must be a boolean');
      if (a.allowOrigin === '*' && a.allowCredentials === true) {
        fail(aw, 'allowOrigin "*" cannot be combined with allowCredentials: browsers reject credentials with a wildcard origin (omit allowOrigin to echo the request\'s Origin)');
      }
      break;
    case 'passthrough':
      if (!inStep) fail(aw, '"passthrough" is only a sequence step (a rule that changes nothing)');
      onlyKeys(a, ['kind'], aw);
      break;
    case 'sequence': {
      if (inStep) fail(aw, 'a sequence step cannot be another sequence');
      onlyKeys(a, ['kind', 'steps', 'then'], aw);
      if (!Array.isArray(a.steps) || a.steps.length < 1 || a.steps.length > MAX_SEQUENCE_STEPS) fail(aw, `steps must be a list of 1–${MAX_SEQUENCE_STEPS} steps`);
      if (a.then !== undefined && (typeof a.then !== 'string' || !SEQUENCE_THEN.has(a.then))) fail(aw, 'then must be "last", "passthrough" or "loop"');
      const steps = a.steps.map((step, i) => {
        const sw = `${aw}.steps[${i}]`;
        if (!isObj(step)) fail(sw, 'must be an object {action, count?}');
        onlyKeys(step, ['action', 'count'], sw);
        if (step.count !== undefined && !isInt(step.count, 1, 1000)) fail(sw, 'count must be an integer 1–1000');
        return { ...step, action: validateAction(step.action, `${sw}.action`, true) };
      });
      return { ...a, steps } as unknown as RuleAction;
    }
    case 'mapRemote': {
      onlyKeys(a, ['kind', 'to', 'preserveHost'], aw);
      checkMapTarget(a.to, aw);
      if (a.preserveHost !== undefined && typeof a.preserveHost !== 'boolean') fail(aw, 'preserveHost must be a boolean');
      break;
    }
    case 'rewrite': {
      onlyKeys(a, ['kind', 'request', 'response'], aw);
      if (a.request === undefined && a.response === undefined) fail(aw, 'a rewrite needs request and/or response changes');
      let text = 0;
      if (a.request !== undefined) text += checkRewriteSpec(a.request, `${aw}.request`, 'request');
      if (a.response !== undefined) text += checkRewriteSpec(a.response, `${aw}.response`, 'response');
      if (text > MAX_REWRITE_TEXT_TOTAL) fail(aw, 'the find and replace texts of one rewrite must total at most 256 KB');
      break;
    }
    case 'script': {
      // CONTRACTS §13.4: never inside a sequence; `code` may be empty when `file` supplies it (read by the host).
      if (inStep) fail(aw, 'a sequence step cannot be a script');
      onlyKeys(a, ['kind', 'code', 'file'], aw);
      if (a.file !== undefined) checkScriptFile(a.file, aw);
      if (a.code !== undefined && typeof a.code !== 'string') fail(aw, 'code must be a string (the JavaScript source)');
      if (a.code === undefined && a.file === undefined) fail(aw, 'a script needs code or a file');
      if (a.file === undefined && typeof a.code === 'string' && !a.code.trim()) fail(aw, 'a script needs code (define onRequest and / or onResponse) or a file');
      if (typeof a.code === 'string' && Buffer.byteLength(a.code, 'utf8') > MAX_SCRIPT_BYTES) fail(aw, 'code must be at most 256 KB');
      return { ...a, code: (a.code as string | undefined) ?? '' } as RuleAction;
    }
    default:
      fail(aw, `unknown kind ${JSON.stringify(a.kind)}`);
  }
  return { ...a } as unknown as RuleAction;
}

/** CONTRACTS §12.2: a workspace-relative path: no absolute path, drive, `..` segment or control characters; ≤ 300. */
export function checkBodyFile(v: unknown, where: string, field = 'bodyFile'): string {
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_BODY_FILE_PATH) fail(where, `${field} must be a workspace-relative path (1–${MAX_BODY_FILE_PATH} characters)`);
  if (/[\0-\x1f]/.test(v)) fail(where, `${field} must not contain control characters`);
  if (/^[\\/]/.test(v) || /^[A-Za-z]:/.test(v) || /^~/.test(v)) fail(where, `${field} must be relative to the workspace folder (no absolute path)`);
  if (v.split(/[\\/]+/).some((seg) => seg === '..')) fail(where, `${field} must stay inside the workspace (no ".." segments)`);
  return v;
}

/** CONTRACTS §13.4: the most a script (inline code or a new script file) may hold. */
export const MAX_SCRIPT_BYTES = 256 * 1024;

/**
 * CONTRACTS §13.4: `script.file` = a workspace-relative `.js` path (no absolute path, `..`, control characters; the
 * shared-rules service's `scriptFileSyntaxError`). The disk checks (inside the workspace, ≤ 256 KB) happen on read.
 */
export function checkScriptFile(v: unknown, where: string, field = 'file'): string {
  const p = checkBodyFile(v, where, field);
  const bad = scriptFileSyntaxError(p);
  if (bad) fail(where, `${field} ${bad}`);
  return p;
}

/** CONTRACTS §12.2: the most a new body file may hold (the proxy's body cap). */
export const MAX_BODY_FILE_BYTES = 5 * 1024 * 1024;

/** CONTRACTS §12.6: `mapRemote.to` = absolute http(s) origin or URL prefix, no credentials, no fragment. */
export function checkMapTarget(v: unknown, where = 'mapRemote'): URL {
  if (typeof v !== 'string' || !v.trim() || v.length > 2048) fail(where, 'to must be an absolute http(s) URL such as "https://staging.example.com" (at most 2048 characters)');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    fail(where, `to must be an absolute http(s) URL: ${v.slice(0, 200)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(where, 'to must be an http(s) URL');
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(v)) fail(where, 'to must not contain user info (user:password@)');
  if (v.includes('#')) fail(where, 'to must not contain a fragment (#…)');
  if (/[\s\0]/.test(v)) fail(where, 'to must not contain whitespace');
  if (v.includes('\\')) fail(where, 'to must not contain backslashes');
  return u;
}

/** Validates one side of a rewrite; returns the total length of its find + replace texts. */
function checkRewriteSpec(raw: unknown, where: string, side: 'request' | 'response'): number {
  if (!isObj(raw)) fail(where, 'must be an object');
  onlyKeys(raw, side === 'response' ? ['setHeaders', 'removeHeaders', 'replaceBody', 'status'] : ['setHeaders', 'removeHeaders', 'replaceBody'], where);
  if (side === 'response' && raw.status !== undefined) checkStatus(raw.status, where);
  const forbidden = side === 'request' ? REWRITE_REQUEST_FORBIDDEN : REWRITE_RESPONSE_FORBIDDEN;
  let headers = 0;
  if (raw.setHeaders !== undefined) {
    checkHeaders(raw.setHeaders, `${where}.setHeaders`, false);
    for (const name of Object.keys(raw.setHeaders as object)) {
      if (forbidden.has(name.toLowerCase())) fail(`${where}.setHeaders`, `"${name}" can't be set by a rewrite (the proxy manages it)`);
      headers++;
    }
  }
  if (raw.removeHeaders !== undefined) {
    if (!Array.isArray(raw.removeHeaders)) fail(where, 'removeHeaders must be a list of header names');
    for (const name of raw.removeHeaders) {
      if (typeof name !== 'string' || !TOKEN.test(name)) fail(`${where}.removeHeaders`, `invalid header name ${JSON.stringify(name)}`);
      headers++;
    }
  }
  if (headers > MAX_REWRITE_HEADERS) fail(where, `at most ${MAX_REWRITE_HEADERS} headers per side`);
  if (raw.replaceBody !== undefined) {
    if (!Array.isArray(raw.replaceBody) || raw.replaceBody.length > MAX_REWRITE_REPLACEMENTS) fail(where, `replaceBody must be a list of at most ${MAX_REWRITE_REPLACEMENTS} replacements`);
    raw.replaceBody.forEach((r, i) => {
      const rw = `${where}.replaceBody[${i}]`;
      if (!isObj(r)) fail(rw, 'must be an object {find, replace, all?}');
      onlyKeys(r, ['find', 'replace', 'all'], rw);
      if (typeof r.find !== 'string' || !r.find || r.find.length > MAX_REWRITE_FIND) fail(rw, 'find must be non-empty text of at most 10 KB');
      if (typeof r.replace !== 'string' || r.replace.length > MAX_REWRITE_REPLACE) fail(rw, 'replace must be text of at most 64 KB');
      if (r.all !== undefined && typeof r.all !== 'boolean') fail(rw, 'all must be a boolean');
    });
    return (raw.replaceBody as { find: string; replace: string }[]).reduce((n, r) => n + r.find.length + r.replace.length, 0);
  }
  return 0;
}

/**
 * CONTRACTS §12.3 "Expire token" preset: the next `count` matching requests get 401 {"error":"token_expired"},
 * then the real server answers. `url` is used as the rule's glob; an absolute URL without `*` becomes
 * origin + path + `*` (its query, which may hold secrets, is dropped).
 */
export function expireTokenRule(id: string, url: string, count: number, opts: { method?: string; namePrefix?: string } = {}): Rule {
  if (typeof url !== 'string' || !url.trim() || url.length > 8192) fail('expireToken', 'url must be a non-empty URL or URL glob');
  if (!isInt(count, 1, 1000)) fail('expireToken', 'count must be an integer 1–1000');
  let pattern = url.trim();
  if (!pattern.includes('*')) {
    try {
      const u = new URL(pattern);
      if (u.protocol === 'http:' || u.protocol === 'https:') pattern = `${u.origin}${u.pathname}*`;
    } catch {
      // a glob without * — used as is
    }
  }
  return {
    id,
    enabled: true,
    name: `${opts.namePrefix ?? ''}Expire token: ${opts.method ? `${opts.method.toUpperCase()} ` : ''}${pattern}`.slice(0, 500),
    match: { url: pattern, ...(opts.method ? { method: opts.method.toUpperCase() } : {}) },
    action: {
      kind: 'sequence',
      steps: [
        { action: { kind: 'mock', status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"token_expired"}' }, count },
        { action: { kind: 'passthrough' } },
      ],
      then: 'last',
    },
  };
}

/** GraphQL Name (spec §2.1.9). */
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** `*`, or one serialized origin / token-ish value: printable, no whitespace or commas (a header value), ≤ 500. */
function isAllowOrigin(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 500 && /^[\x21-\x7e]+$/.test(v) && !v.includes(',');
}

export function validateRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) fail('setRules', 'rules must be an array');
  if (raw.length > MAX_RULES) fail('setRules', `at most ${MAX_RULES} rules`);
  const ids = new Set<string>();
  return raw.map((r, i) => {
    const rule = validateRule(r, `rule ${i + 1}`);
    if (ids.has(rule.id)) fail(`rule ${i + 1}`, `duplicate id "${rule.id}"`);
    ids.add(rule.id);
    return rule;
  });
}

/**
 * Validates a resume edit. `phase` (from the paused exchange) narrows the allowed fields:
 * a paused request accepts method/url/headers/body, a paused response status/headers/body.
 */
export function validateEdit(raw: unknown, phase?: 'request' | 'response'): RequestEdit | ResponseEdit | undefined {
  if (raw === undefined || raw === null) return undefined;
  const where = 'edit';
  if (!isObj(raw)) fail(where, 'must be an object');
  const allowed = phase === 'request' ? ['method', 'url', 'headers', 'body'] : phase === 'response' ? ['status', 'headers', 'body'] : ['method', 'url', 'status', 'headers', 'body'];
  onlyKeys(raw, allowed, where);
  if (raw.method !== undefined && (typeof raw.method !== 'string' || !TOKEN.test(raw.method))) fail(where, 'method must be an HTTP method name');
  if (raw.url !== undefined) checkUrl(raw.url, where);
  if (raw.status !== undefined) checkStatus(raw.status, where);
  if (raw.headers !== undefined) checkHeaders(raw.headers, where, true);
  if (raw.body !== undefined) checkBody(raw.body, where);
  return raw as RequestEdit | ResponseEdit;
}

/** Headers `send` never forwards: framing the proxy recomputes, hop-by-hop, and the proxy's own credential. */
const SEND_DROPPED = new Set(['content-length', 'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'x-fi-id']);

/** Drops framing / hop-by-hop / proxy headers from a request about to be sent again. */
export function sanitizeSendHeaders(h: Record<string, string | string[]> | undefined): Record<string, string | string[]> | undefined {
  if (!h) return h;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (!SEND_DROPPED.has(k.toLowerCase()) && !k.startsWith(':')) out[k] = v;
  return out;
}

/** Validates the webview composer's request (CONTRACTS §9.3 `send`): method, absolute http(s) URL, headers, text body. */
export function validateSendDraft(raw: unknown): SendDraft {
  const where = 'send';
  if (!isObj(raw)) fail(where, 'request must be an object');
  onlyKeys(raw, ['method', 'url', 'headers', 'body'], where);
  if (typeof raw.method !== 'string' || !TOKEN.test(raw.method)) fail(where, 'method must be an HTTP method name');
  checkUrl(raw.url, where);
  if (raw.headers !== undefined) checkHeaders(raw.headers, where, true);
  if (raw.body !== undefined) checkBody(raw.body, where);
  return {
    method: raw.method.toUpperCase(),
    url: raw.url as string,
    ...(raw.headers !== undefined ? { headers: sanitizeSendHeaders(raw.headers as Record<string, string | string[]>) } : {}),
    ...(raw.body !== undefined ? { body: raw.body as string } : {}),
  };
}

/** Validates a network profile (CONTRACTS §9.2 network.ts). */
export function validateNetworkProfile(raw: unknown): NetworkProfile {
  const where = 'networkProfile';
  if (!isObj(raw)) fail(where, 'must be an object');
  switch (raw.kind) {
    case 'none':
    case 'offline':
      onlyKeys(raw, ['kind'], where);
      return { kind: raw.kind };
    case 'throttle':
      onlyKeys(raw, ['kind', 'preset', 'latencyMs', 'kbps', 'dropRate'], where);
      if (raw.preset !== undefined && (typeof raw.preset !== 'string' || !PRESET_IDS.has(raw.preset))) fail(where, 'preset must be "slow-3g", "fast-3g" or "flaky"');
      checkThrottle(raw, where);
      return raw as unknown as NetworkProfile;
    default:
      return fail(where, `unknown kind ${JSON.stringify(raw.kind)}`);
  }
}

function checkId(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v) fail(where, 'id must be a non-empty string');
  return v;
}

/** Turns a ruleFromExchange failure (proxy's typed error for truncated/binary bodies, review #8) into user text. */
export function ruleFromExchangeErrorMessage(e: unknown, kind: string): string {
  const err = e as { code?: unknown; message?: unknown };
  const what = kind === 'mock' ? 'a mock rule' : `a ${kind} rule`;
  if (err?.code === 'truncated') return `Can't create ${what} from this exchange: its response body was truncated (too large to store), so the mock would be incomplete.`;
  if (err?.code === 'binary') return `Can't create ${what} from this exchange: its response body is binary, and mock bodies are text.`;
  const msg = typeof err?.message === 'string' && err.message ? err.message : String(e);
  return `Can't create ${what} from this exchange: ${msg}`;
}

/** The request of `ex` as a code snippet (unredacted: the caller decides what to redact). */
export function snippetFor(ex: Exchange, format: SnippetFormat): string {
  return toSnippet({ method: ex.method, url: ex.url, headers: ex.requestHeaders, ...(ex.requestBody ? { body: ex.requestBody } : {}) }, format);
}

export class InterceptController {
  private readonly sinks = new Set<Sink>();
  private readonly pending = new Map<string, Exchange>();
  /** When each open stream was last sent to the panel (REVIEW-5 #4). */
  private readonly streamSentAt = new Map<string, number>();
  /** Latest `rule-hit` count per rule id (display only: never persisted, never sent to the proxy). */
  private readonly used = new Map<string, number>();
  private rulesDirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDue = 0;
  private readonly paused = new Set<string>();
  private sessions = 0;
  private pausedListeners: ((count: number) => void)[] = [];
  // CONTRACTS §10.5 contract checks: cached per exchange id, queued, run a few at a time.
  private readonly contractResults = new Map<string, ContractResult>();
  private readonly contractQueue = new Map<string, Exchange>();
  private readonly contractRunning = new Set<string>();
  private readonly pendingContract = new Map<string, ContractSummary>();
  private contractTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped whenever cached results become stale; results of older checks are dropped. */
  private contractGen = 0;
  private readonly modelsSub?: { dispose(): void };
  // CONTRACTS §12.3 auth flows: pushed at most every authDebounceMs while a panel is attached.
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAuthFlows = '';
  /** Test hook: every message sent, by type. */
  readonly sentCounts: Record<string, number> = {};
  readyCount = 0;

  constructor(private readonly deps: ControllerDeps) {
    deps.host.on('exchange', (e) => this.onExchange(e));
    deps.host.on('removed', (ids) => this.onRemoved(ids));
    // Start/stop/restart: the exchange list belongs to the proxy instance, so resend everything.
    deps.host.on('state', () => {
      this.pending.clear();
      this.streamSentAt.clear();
      this.rulesDirty = false;
      this.used.clear(); // hit counts belong to the proxy instance
      this.dropContracts(undefined);
      this.recomputePaused(deps.host.getExchanges());
      this.broadcast(this.snapshot());
      this.scheduleAuthFlows();
    });
    deps.host.on('rule-spent', (ruleId) => this.onRuleSpent(ruleId));
    deps.host.on('rule-hit', (ruleId, used) => this.onRuleHit(ruleId, used));
    deps.host.on('warnings', () => this.broadcastStatus());
    deps.host.on('replay', () => this.broadcastStatus());
    deps.host.on('upstream', () => this.broadcastStatus());
    this.modelsSub = deps.contract?.onDidChangeModels(() => this.recheckContracts());
  }

  attach(sink: Sink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  get pausedCount(): number {
    return this.paused.size;
  }

  onPausedCount(l: (count: number) => void): void {
    this.pausedListeners.push(l);
  }

  status(): Status {
    return {
      proxyRunning: this.deps.host.running,
      port: this.deps.host.port,
      interceptEnabled: this.deps.getEnabled(),
      sessions: this.sessions,
      ...(this.deps.host.lan
        ? { lan: { host: this.deps.host.lan.host, port: this.deps.host.lan.port, ...(this.deps.host.lan.peer ? { peer: this.deps.host.lan.peer } : {}) } }
        : {}),
      ...(this.deps.getAgentStatus?.() ? { agent: this.deps.getAgentStatus() } : {}),
      ...(this.networkProfile() ? { networkProfile: this.networkProfile() } : {}),
      ...(this.deps.host.warnings?.length ? { warnings: this.deps.host.warnings } : {}),
      ...this.replayStatus(),
      ...this.sharedStatus(),
      ...this.upstreamStatus(),
    };
  }

  /** REVIEW-6 #1: the upstream proxy (`host:port`) and whether its certificate checks are off. */
  private upstreamStatus(): Pick<Status, 'upstreamProxy' | 'upstreamProxyInsecure'> {
    const info = this.deps.host.upstreamProxyInfo;
    if (!info?.display) return {};
    return { upstreamProxy: info.display, ...(info.ignoreCertErrors ? { upstreamProxyInsecure: true as const } : {}) };
  }

  private replayStatus(): Pick<Status, 'replay'> {
    const r = this.deps.host.replay;
    return r ? { replay: { recording: r.recording, fallback: r.fallback === 'fail' ? 'fail' : 'passthrough' } } : {};
  }

  private sharedStatus(): Pick<Status, 'sharedRules'> {
    let st: SharedRulesState | undefined;
    try {
      st = this.deps.shared?.state();
    } catch (e) {
      this.deps.log?.(`shared rules state failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const s = sharedRulesStatus(st);
    if (!s) return {};
    if (s.pendingApproval > 0 && this.deps.shared?.pendingReasons) {
      try {
        const pending = pendingView(this.deps.shared.pendingReasons());
        if (pending.length) s.pending = pending;
      } catch (e) {
        this.deps.log?.(`shared rules pendingReasons failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { sharedRules: s };
  }

  /** The active network profile, or undefined when none (CONTRACTS §9.3: omitted from Status). */
  private networkProfile(): NetworkProfile | undefined {
    const p = this.deps.host.networkProfile;
    return p && p.kind !== 'none' ? p : undefined;
  }

  /** Validates, applies and broadcasts `status` (webview `setNetworkProfile`; the agent API may use it too). */
  setNetworkProfile(raw: unknown): void {
    const p = validateNetworkProfile(raw);
    if (!this.deps.host.setNetworkProfile) throw new Error('This proxy build cannot simulate network conditions.');
    this.deps.host.setNetworkProfile(p);
    this.broadcastStatus();
  }

  setSessions(n: number): void {
    if (n === this.sessions) return;
    this.sessions = n;
    this.broadcastStatus();
  }

  broadcastStatus(): void {
    this.broadcast({ type: 'status', status: this.status() });
  }

  snapshot(): HostMsg {
    return { type: 'snapshot', exchanges: this.deps.host.getExchanges().map(uiExchange), rules: this.rulesView(), status: this.status() };
  }

  async handle(raw: unknown, reply: Sink): Promise<void> {
    const msg = raw as ViewMsg;
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    try {
      switch (msg.type) {
        case 'ready': {
          this.readyCount++;
          this.flush();
          this.send(reply, this.snapshot());
          const current = this.deps.host.getExchanges();
          const results = current.flatMap((e) => {
            const r = this.contractResults.get(e.id);
            return r ? [contractSummary(r)] : [];
          });
          if (results.length) this.send(reply, { type: 'contract', results });
          for (const e of current) this.maybeCheck(e);
          if (this.deps.analyzeAuth) this.send(reply, { type: 'authFlows', flows: this.authFlows() });
          if (this.deps.recordings) {
            try {
              this.send(reply, { type: 'recordings', recordings: (await this.deps.recordings.list()).map(recordingSummary) });
            } catch (e) {
              this.deps.log?.(`listing recordings failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          return;
        }
        case 'resume': {
          const id = checkId(msg.id, 'resume');
          const ex = this.deps.host.getExchanges().find((e) => e.id === id);
          const phase = ex?.state === 'paused-request' ? 'request' : ex?.state === 'paused-response' ? 'response' : undefined;
          this.deps.host.resume(id, validateEdit(msg.edit, phase));
          return;
        }
        case 'abort':
          this.deps.host.abort(checkId(msg.id, 'abort'));
          return;
        case 'setRules':
          this.applyRules(msg.rules);
          return;
        case 'clear':
          this.clear();
          return;
        case 'setInterceptEnabled':
          if (typeof msg.enabled !== 'boolean') fail('setInterceptEnabled', 'enabled must be a boolean');
          await this.deps.setEnabled(msg.enabled);
          this.broadcastStatus();
          return;
        case 'createRuleFromExchange': {
          if (!RULE_KINDS.has(msg.action)) fail('createRuleFromExchange', `unknown rule action ${JSON.stringify(msg.action)}`);
          const id = checkId(msg.id, 'createRuleFromExchange');
          const ex = this.deps.host.getExchanges().find((e) => e.id === id);
          if (!ex) throw new Error('That exchange is no longer available.');
          const ro = readOnlyReason(ex);
          if (ro) throw new Error(`Can't create a rule from this request: ${ro}.`);
          if (ex.kind === 'websocket' && msg.action !== 'block') {
            throw new Error(`Can't create ${msg.action === 'mock' ? 'a mock' : 'a breakpoint'} rule from a WebSocket: WebSocket connections can only be blocked (or failed with a fault rule).`);
          }
          let rule: Rule;
          try {
            rule = validateRule(ruleFromExchange(ex, msg.action, this.newRuleId()));
          } catch (e) {
            throw new Error(ruleFromExchangeErrorMessage(e, msg.action));
          }
          this.applyRules([rule, ...this.deps.host.getRules()]);
          return;
        }
        case 'send': {
          const request = validateSendDraft(msg.request);
          if (msg.resentFrom !== undefined) {
            const fromId = checkId(msg.resentFrom, 'send');
            const from = this.deps.host.getExchanges().find((e) => e.id === fromId);
            const ro = from && readOnlyReason(from);
            if (ro) throw new Error(`Can't resend this request: ${ro}.`);
          }
          if (!this.deps.host.send) throw new Error('This proxy build cannot send requests.');
          const { id } = await this.deps.host.send({ ...request, initiator: 'editor', ...(msg.resentFrom ? { resentFrom: msg.resentFrom } : {}) });
          this.send(reply, { type: 'sent', id });
          return;
        }
        case 'openSource': {
          const ex = this.exchangeOrThrow(checkId(msg.id, 'openSource'));
          const frames = ex.source?.frames ?? [];
          if (!frames.length) {
            throw new Error(
              ex.initiator
                ? 'No source for this request: it was sent from the editor or an agent, not by the app.'
                : 'No source for this request: its stack trace has not arrived (source capture may be off, or the app was launched before it was turned on).',
            );
          }
          const frame = msg.frame ?? ex.source?.appFrame;
          if (frame === undefined) throw new Error('No app call site was found in this request\'s stack trace. Pick a frame to open.');
          if (!isInt(frame, 0, frames.length - 1)) fail('openSource', `frame must be an index 0–${frames.length - 1}`);
          if (!this.deps.openSource) throw new Error('Opening source is not available in this editor.');
          await this.deps.openSource(ex, frame);
          return;
        }
        case 'copySnippet': {
          if (!SNIPPET_FORMATS.includes(msg.format)) fail('copySnippet', `unknown format ${JSON.stringify(msg.format)}`);
          const ex = this.exchangeOrThrow(checkId(msg.id, 'copySnippet'));
          if (!this.deps.copyToClipboard) throw new Error('Copying is not available in this editor.');
          // The user's own clipboard: unredacted (CONTRACTS §9.3).
          await this.deps.copyToClipboard(snippetFor(ex, msg.format));
          return;
        }
        case 'setNetworkProfile':
          this.setNetworkProfile(msg.profile);
          return;
        case 'pickModel':
          await this.pickModel(this.exchangeOrThrow(checkId(msg.id, 'pickModel')));
          return;
        case 'openViolation': {
          const id = checkId(msg.id, 'openViolation');
          const r = this.contractResults.get(id);
          if (!r) throw new Error('This request has no contract check result (yet).');
          if (!isInt(msg.index, 0, Math.max(0, r.violations.length - 1)) || !r.violations.length) fail('openViolation', 'index is out of range');
          const v = r.violations[msg.index];
          if (!v.file) throw new Error(`The source file of model ${v.model} is unknown.`);
          if (!this.deps.openLocation) throw new Error('Opening files is not available in this editor.');
          await this.deps.openLocation(v.file, v.line ?? 1);
          return;
        }
        case 'mutateField':
          this.mutateField(this.exchangeOrThrow(checkId(msg.id, 'mutateField')), msg);
          return;
        case 'generateModel':
          await this.generateModel(this.exchangeOrThrow(checkId(msg.id, 'generateModel')));
          return;
        case 'generateFixture':
          await this.generateFixture(this.exchangeOrThrow(checkId(msg.id, 'generateFixture')));
          return;
        // ---- CONTRACTS §12.7
        case 'shareRule':
          if (typeof msg.shared !== 'boolean') fail('shareRule', 'shared must be a boolean');
          await this.shareRule(checkId(msg.id, 'shareRule'), msg.shared);
          return;
        case 'approveSharedRules':
          await this.approveSharedRules();
          return;
        case 'openSharedRules':
          if (!this.deps.openSharedRules) throw new Error('Shared rules need a workspace folder (.vscode/flutter-intercept.json).');
          await this.deps.openSharedRules();
          return;
        case 'openBodyFile': {
          const p = checkBodyFile(msg.path, 'openBodyFile', 'path');
          let create: { content: string } | undefined;
          if (msg.create !== undefined) {
            if (!isObj(msg.create)) fail('openBodyFile', 'create must be an object {content}');
            onlyKeys(msg.create, ['content'], 'openBodyFile.create');
            const content = msg.create.content;
            if (typeof content !== 'string') fail('openBodyFile', 'create.content must be a string');
            if (Buffer.byteLength(content, 'utf8') > MAX_BODY_FILE_BYTES) fail('openBodyFile', 'create.content must be at most 5 MB');
            create = { content };
          }
          const ruleId = checkRuleId(msg.ruleId, 'openBodyFile');
          if (!this.deps.openBodyFile) throw new Error('Opening body files is not available in this editor.');
          await this.deps.openBodyFile(p, create, ruleId);
          return;
        }
        case 'saveRecording':
          await this.saveRecording(msg);
          return;
        case 'replayRecording':
          await this.replayRecording(msg.id === undefined ? undefined : checkId(msg.id, 'replayRecording'), msg.fallback);
          return;
        case 'diffRecordings': {
          const { recordings } = this.recordingsOrThrow();
          if (!this.deps.openDiff) throw new Error('Comparing recordings is not available in this editor.');
          const a = checkId(msg.a, 'diffRecordings');
          const b = checkId(msg.b, 'diffRecordings');
          if (a === b) fail('diffRecordings', 'pick two different recordings');
          const [ra, rb] = await Promise.all([recordings.load(a), recordings.load(b)]);
          await this.deps.openDiff(ra, rb);
          return;
        }
        case 'deleteRecording':
          await this.deleteRecording(checkId(msg.id, 'deleteRecording'));
          return;
        case 'expireToken':
          this.expireToken(msg.url, msg.count);
          return;
        // ---- CONTRACTS §13.7
        case 'export': {
          const file = await this.exportTraffic(msg.format, msg.ids);
          if (file) this.send(reply, { type: 'exported', format: msg.format, path: file });
          return;
        }
        case 'openScriptFile': {
          const p = checkScriptFile(msg.path, 'openScriptFile', 'path');
          const ruleId = checkRuleId(msg.ruleId, 'openScriptFile');
          let create: { content: string } | undefined;
          if (msg.create !== undefined) {
            if (!isObj(msg.create)) fail('openScriptFile', 'create must be an object {content}');
            onlyKeys(msg.create, ['content'], 'openScriptFile.create');
            const content = msg.create.content;
            if (typeof content !== 'string') fail('openScriptFile', 'create.content must be a string');
            if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) fail('openScriptFile', 'create.content must be at most 256 KB');
            // Empty content: the starter template, naming the rule that uses this file (if one does).
            const owner = this.deps.host.getRules().find((r) => (ruleId !== undefined ? r.id === ruleId : scriptFileOf(r) === p));
            create = { content: content.trim() ? content : scriptTemplate(owner) };
          }
          if (!this.deps.openScriptFile) throw new Error('Opening script files is not available in this editor.');
          await this.deps.openScriptFile(p, create, ruleId);
          return;
        }
        case 'openInNewWindow':
          if (!this.deps.openInNewWindow) throw new Error('Opening the traffic view in a new window is not available in this editor.');
          await this.deps.openInNewWindow();
          return;
        default:
          return;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log?.(`webview action ${msg.type} failed: ${message}`);
      this.send(reply, { type: 'error', message });
    }
  }

  /**
   * CONTRACTS §13.6: focus one exchange in every attached view (a notification's "Show"). Pending updates are flushed
   * first so the views know the exchange.
   */
  select(id: string): void {
    if (typeof id !== 'string' || !id) return;
    this.flush();
    this.broadcast({ type: 'select', id });
  }

  /**
   * CONTRACTS §13.5: exports the given exchanges (default: every finished one except the browser's own) as OpenAPI,
   * Postman or HAR. Asks "Redact secrets (recommended)" / "Keep values" every time, then where to save (default
   * `<project>/<name><suffix>`), writes the file and resolves its path; undefined when the user cancelled. Also used by
   * the `flutterIntercept.exportOpenApi` / `exportPostman` commands. Throws a readable Error otherwise.
   */
  async exportTraffic(format: unknown, ids?: unknown): Promise<string | undefined> {
    if (typeof format !== 'string' || !EXPORT_FORMATS.has(format as ExportFormat)) fail('export', `unknown format ${JSON.stringify(format)}`);
    const fmt = format as ExportFormat;
    let pick: Set<string> | undefined;
    if (ids !== undefined) {
      if (!Array.isArray(ids) || ids.length > 100_000 || !ids.every((x) => typeof x === 'string')) fail('export', 'ids must be a list of exchange ids');
      pick = new Set(ids as string[]);
    }
    const builder = fmt === 'openapi' ? this.deps.exporters?.openapi : fmt === 'postman' ? this.deps.exporters?.postman : undefined;
    if (fmt !== 'har' && !builder) throw new Error(`${fmt === 'openapi' ? 'OpenAPI' : 'Postman'} export is not available in this build.`);
    if (!this.deps.pickOne || !this.deps.showSaveDialog) throw new Error('Exporting is not available in this editor.');
    // Default: every finished exchange the app made, without the browser's own; OpenAPI / Postman also skip
    // WebSocket / SSE (the exporters do too), HAR keeps their frames.
    const list = this.deps.host
      .getExchanges()
      .filter((e) => (pick ? pick.has(e.id) : FINAL_STATES.has(e.state) && !e.browserInternal && (fmt === 'har' || !e.kind)));
    if (!list.length) throw new Error('There is no recorded traffic to export.');

    const choice = await this.deps.pickOne([EXPORT_REDACT, EXPORT_KEEP], 'Secrets in the export (Authorization, cookies, tokens, passwords)');
    if (choice === undefined) return undefined;
    const redact = choice !== EXPORT_KEEP;
    const root = this.deps.projectRoot?.();
    const title = this.deps.appPackageName?.() || (root ? path.basename(root) : '') || 'Flutter app';
    let text: string;
    if (fmt === 'har') {
      text = JSON.stringify(buildHar(list, { redact, creatorVersion: this.deps.version }), null, 2);
    } else {
      const r = builder!(list, { title, redact });
      if (!r.exchanges) throw new Error(`Nothing to export as ${fmt === 'openapi' ? 'OpenAPI' : 'Postman'}: no finished HTTP request (WebSocket and SSE traffic is skipped).`);
      text = r.text;
    }
    const name = `${title.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'traffic'}${EXPORT_SUFFIX[fmt]}`;
    // REVIEW-7 #9: live values default to the project's (ignored) .dart_tool/flutter_intercept/exports/ folder.
    let folder = root;
    if (root && !redact) {
      try {
        folder = await ensureDirInside(root, EXPORT_DIR);
      } catch (e) {
        this.deps.log?.(`export folder unavailable, offering the project folder: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const file = await this.deps.showSaveDialog(folder ? path.join(folder, name) : name, fmt);
    if (!file) return undefined;
    if (!redact && (await gitIgnoreStatus(await realTarget(file), this.deps.gitFs ?? nodeGitFs)) === 'not-ignored') {
      if (!this.deps.confirmWarning) throw new Error('Not saved: this file would be committed with live credentials (it is inside a git repository and not ignored). Choose another place or redact secrets.');
      if (!(await this.deps.confirmWarning(EXPORT_GIT_WARNING, EXPORT_GIT_CONFIRM))) return undefined;
    }
    await (this.deps.writeFile ?? writeExport)(file, text, { private: !redact });
    return file;
  }

  /** Also used by the `flutterIntercept.clear` command. */
  clear(): void {
    this.deps.host.clear();
    this.pending.clear();
    this.streamSentAt.clear();
    const left = new Set(this.deps.host.getExchanges().map((e) => e.id));
    this.dropContracts([...this.contractResults.keys(), ...this.contractQueue.keys(), ...this.pendingContract.keys()].filter((id) => !left.has(id)));
    this.recomputePaused(this.deps.host.getExchanges());
    this.broadcast({ type: 'cleared' });
    this.broadcast(this.snapshot());
    this.scheduleAuthFlows();
  }

  /**
   * Validates (throws InvalidMessageError, nothing applied or persisted), then applies + persists + broadcasts.
   * CONTRACTS §12.1: `input` may hold the shared rules (`shared: true`) too, as the panel shows them. The personal
   * ones are applied after the current shared ones and persisted; when the shared ones differ from the current
   * shared list (edited or removed in the panel), the new list is written to the shared file (asynchronously:
   * the shared part changes when the service reports the new file; a failed write is reported as an `error`).
   */
  applyRules(input: Rule[]): void {
    const rules = validateRules(input); // drops `used`
    const personal = rules.filter((r) => !r.shared);
    const sharedIn = rules.filter((r) => r.shared);
    const current = this.sharedRules();
    const sharedChanged = !sameRules(sharedIn, current);
    if (sharedChanged && !this.deps.shared) fail('setRules', 'shared rules come from .vscode/flutter-intercept.json and cannot be changed here');
    this.setEffective(current, personal);
    this.deps.saveRules(personal);
    if (sharedChanged) void this.writeShared(sharedIn).catch((e: unknown) => this.reportError('saving the shared rules', e));
  }

  /** The shared rules (CONTRACTS §12.1) in the host's list. */
  sharedRules(): Rule[] {
    return this.deps.host.getRules().filter((r) => r.shared);
  }

  /** The user's own rules (persisted in workspaceState). */
  personalRules(): Rule[] {
    return this.deps.host.getRules().filter((r) => !r.shared);
  }

  /**
   * CONTRACTS §12.1: the shared rules changed (SharedRulesService.onDidChange / initial state): the proxy gets
   * `[...shared, ...personal]`. Not persisted (they live in the file). A shared rule whose id is already used is
   * skipped (logged). Broadcasts `rules` and `status` (shared-rules state).
   */
  setSharedRules(rules: Rule[]): void {
    const personal = this.personalRules();
    const taken = new Set(personal.map((r) => r.id));
    const shared: Rule[] = [];
    for (const r of Array.isArray(rules) ? rules : []) {
      if (!r || typeof r.id !== 'string') continue;
      if (taken.has(r.id)) {
        this.deps.log?.(`shared rule "${r.id}" skipped: another rule has the same id`);
        continue;
      }
      taken.add(r.id);
      const { used: _u, ...rest } = r;
      shared.push({ ...rest, shared: true });
    }
    this.setEffective(shared, personal);
    this.broadcastStatus();
  }

  /** Applies `[...shared, ...personal]` to the host and broadcasts `rules`. */
  private setEffective(shared: Rule[], personal: Rule[]): void {
    const rules = [...shared, ...personal.map((r) => (r.shared ? (({ shared: _s, ...rest }) => rest)(r) : r))];
    this.deps.host.setRules(rules);
    const ids = new Set(rules.map((r) => r.id));
    for (const id of [...this.used.keys()]) if (!ids.has(id)) this.used.delete(id);
    this.rulesDirty = false;
    this.broadcast({ type: 'rules', rules: this.rulesView() });
  }

  private sharedOrThrow(): SharedRulesDeps {
    if (!this.deps.shared) throw new Error('Shared rules need a workspace folder (.vscode/flutter-intercept.json).');
    return this.deps.shared;
  }

  /**
   * Makes the file's approved rules `rules` (the service keeps held-back and invalid entries where they are).
   * Rules no longer in `rules` are deleted with `removeShared` when the service has it; then, if anything else
   * changed (edits, order, additions), the list is saved. Finally the shared part is refreshed from the service.
   */
  private async writeShared(rules: Rule[]): Promise<void> {
    const svc = this.sharedOrThrow();
    const ids = new Set(rules.map((r) => r.id));
    const removed = this.sharedRules().filter((r) => !ids.has(r.id));
    if (svc.removeShared && removed.length) {
      for (const r of removed) await svc.removeShared(r.id);
      this.setSharedRules(svc.state().rules);
      if (sameRules(rules, this.sharedRules())) return;
    }
    await svc.save(rules.map((r) => ({ ...r, shared: true as const })));
    this.setSharedRules(svc.state().rules);
  }

  /** CONTRACTS §12.7 `shareRule`: moves a personal rule into the shared file (same id), or a shared one back (new id). */
  async shareRule(id: string, shared: boolean): Promise<void> {
    this.sharedOrThrow();
    if (shared) {
      const personal = this.personalRules();
      const idx = personal.findIndex((r) => r.id === id);
      if (idx < 0) {
        if (this.sharedRules().some((r) => r.id === id)) return; // already shared
        throw new Error('That rule no longer exists.');
      }
      const rule = personal[idx];
      const rest = personal.filter((r) => r.id !== id);
      // Out of the personal list first, so the file's copy never collides with it.
      this.setEffective(this.sharedRules(), rest);
      this.deps.saveRules(rest);
      try {
        await this.writeShared([...this.sharedRules(), { ...rule, shared: true }]);
      } catch (e) {
        const back = this.personalRules();
        back.splice(Math.min(idx, back.length), 0, rule);
        this.setEffective(this.sharedRules(), back);
        this.deps.saveRules(back);
        throw e;
      }
      return;
    }
    const current = this.sharedRules();
    const rule = current.find((r) => r.id === id);
    if (!rule) {
      if (this.personalRules().some((r) => r.id === id)) return; // already personal
      throw new Error('That rule no longer exists.');
    }
    await this.writeShared(current.filter((r) => r.id !== id));
    const { shared: _s, used: _u, ...copy } = rule;
    const personal = [{ ...copy, id: this.newRuleId() } as Rule, ...this.personalRules()];
    this.setEffective(this.sharedRules(), personal);
    this.deps.saveRules(personal);
  }

  /** CONTRACTS §12.1: the user approved the held-back shared rules of the current file content. */
  async approveSharedRules(): Promise<void> {
    const svc = this.sharedOrThrow();
    await svc.approvePending();
    this.setSharedRules(svc.state().rules);
  }

  // ------------------------------------------------------------------ CONTRACTS §12.4 recordings, §12.3 presets

  private recordingsOrThrow(): { recordings: RecordingService } {
    if (!this.deps.recordings) throw new Error('Recordings are not available (open the Flutter project folder).');
    return { recordings: this.deps.recordings };
  }

  /** Lists the recordings and broadcasts `recordings` (after every change; the agent API calls it too). */
  async refreshRecordings(): Promise<void> {
    if (!this.deps.recordings) return;
    try {
      const list = await this.deps.recordings.list();
      this.broadcast({ type: 'recordings', recordings: list.map(recordingSummary) });
    } catch (e) {
      this.deps.log?.(`listing recordings failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** `saveRecording`: the finished HTTP exchanges shown (or the given ids). Unredacted unless `redact` (the user's own file). */
  private async saveRecording(msg: { name?: unknown; ids?: unknown; redact?: unknown }): Promise<void> {
    const { recordings } = this.recordingsOrThrow();
    if (typeof msg.name !== 'string' || !msg.name.trim() || msg.name.length > 200) fail('saveRecording', 'name must be 1–200 characters');
    if (msg.redact !== undefined && typeof msg.redact !== 'boolean') fail('saveRecording', 'redact must be a boolean');
    let ids: Set<string> | undefined;
    if (msg.ids !== undefined) {
      if (!Array.isArray(msg.ids) || msg.ids.length > 100_000 || !msg.ids.every((x) => typeof x === 'string')) fail('saveRecording', 'ids must be a list of exchange ids');
      ids = new Set(msg.ids as string[]);
    }
    const list = this.deps.host.getExchanges().filter((e) => isRecordable(e) && (!ids || ids.has(e.id)));
    if (!list.length) throw new Error('There is no finished HTTP request to save (WebSocket, SSE and native-client traffic is not recorded).');
    await recordings.save(msg.name.trim(), list, { redact: msg.redact === true });
    await this.refreshRecordings();
  }

  /** `replayRecording`: id = start answering from that recording; undefined = stop. */
  async replayRecording(id: string | undefined, fallback: unknown): Promise<void> {
    if (fallback !== undefined && fallback !== 'passthrough' && fallback !== 'fail') fail('replayRecording', 'fallback must be "passthrough" or "fail"');
    if (!this.deps.host.setReplay) throw new Error('This proxy build cannot replay recordings.');
    if (id === undefined) {
      this.deps.host.setReplay(undefined);
      this.broadcastStatus();
      return;
    }
    const { recordings } = this.recordingsOrThrow();
    const rec = await recordings.load(id);
    const entries = recordings.toReplay(rec);
    if (!entries.length) throw new Error(`Recording "${rec.name}" has no responses to replay.`);
    this.deps.host.setReplay(entries, { fallback: fallback === 'fail' ? 'fail' : 'passthrough', matchTemplates: true }, { id: rec.id, name: rec.name });
    this.broadcastStatus();
  }

  private async deleteRecording(id: string): Promise<void> {
    const { recordings } = this.recordingsOrThrow();
    if (this.deps.host.replay?.id === id) this.deps.host.setReplay?.(undefined);
    await recordings.remove(id);
    await this.refreshRecordings();
    this.broadcastStatus();
  }

  /** CONTRACTS §12.3 "Expire token" preset, inserted FIRST among the personal rules. */
  expireToken(url: unknown, count: unknown): Rule {
    if (typeof url !== 'string') fail('expireToken', 'url must be a string');
    const rule = validateRule(expireTokenRule(this.newRuleId(), url, count as number));
    this.applyRules([...this.sharedRules(), rule, ...this.personalRules()]);
    return rule;
  }

  // ------------------------------------------------------------------ CONTRACTS §12.3 auth flows

  /** The current auth flows (empty without an analyzer or when it fails). */
  authFlows(): AuthFlowSummary[] {
    if (!this.deps.analyzeAuth) return [];
    try {
      const flows = authFlowSummaries(this.deps.analyzeAuth(this.deps.host.getExchanges()));
      this.lastAuthFlows = JSON.stringify(flows);
      return flows;
    } catch (e) {
      this.deps.log?.(`auth analysis failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  private scheduleAuthFlows(): void {
    if (!this.deps.analyzeAuth || !this.sinks.size || this.authTimer) return;
    this.authTimer = setTimeout(() => {
      this.authTimer = undefined;
      if (!this.sinks.size) return;
      const before = this.lastAuthFlows;
      const flows = this.authFlows();
      if (JSON.stringify(flows) !== before) this.broadcast({ type: 'authFlows', flows });
    }, this.deps.authDebounceMs ?? 1000);
  }

  private reportError(what: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.deps.log?.(`${what} failed: ${message}`);
    this.broadcast({ type: 'error', message });
  }

  /** The host's rules with the latest `used` counts (CONTRACTS §9.2 rule-hit) for the webview. */
  rulesView(): Rule[] {
    const rules = this.deps.host.getRules();
    if (!this.used.size) return rules;
    return rules.map((r) => (this.used.has(r.id) ? { ...r, used: this.used.get(r.id) } : r));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.contractTimer) clearTimeout(this.contractTimer);
    this.contractTimer = undefined;
    this.contractQueue.clear();
    this.contractGen++;
    this.modelsSub?.dispose();
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.sinks.clear();
  }

  // ------------------------------------------------------------------ CONTRACTS §10 (v0.4.0)

  /** The cached contract result of an exchange (also used by the agent API). */
  contractResult(id: string): ContractResult | undefined {
    return this.contractResults.get(id);
  }

  private get contractOn(): boolean {
    return !!this.deps.contract && (this.deps.contractCheckEnabled?.() ?? true);
  }

  /**
   * Drops every cached result (models changed, the user mapped a route, or the setting changed) and checks the
   * current exchanges again; with checking off, tells the panel the results are gone.
   */
  recheckContracts(): void {
    const ids = [...this.contractResults.keys()];
    this.contractGen++;
    this.contractQueue.clear();
    this.contractResults.clear();
    this.pendingContract.clear();
    if (ids.length) this.deps.onContractRemoved?.(ids);
    if (!this.contractOn) {
      if (ids.length) this.broadcast({ type: 'contract', results: ids.map((id) => ({ id, checked: false, via: 'none', violations: [], reason: CONTRACT_OFF })) });
      return;
    }
    for (const e of this.deps.host.getExchanges()) this.maybeCheck(e);
  }

  /** Forgets results (all with `undefined`) — eviction, clear, proxy restart. */
  private dropContracts(ids: string[] | undefined): void {
    const dropped: string[] = [];
    if (ids === undefined) {
      this.contractGen++;
      dropped.push(...this.contractResults.keys());
      this.contractResults.clear();
      this.contractQueue.clear();
      this.pendingContract.clear();
    } else {
      for (const id of new Set(ids)) {
        if (this.contractResults.delete(id)) dropped.push(id);
        this.contractQueue.delete(id);
        this.pendingContract.delete(id);
      }
    }
    if (dropped.length) this.deps.onContractRemoved?.(dropped);
  }

  /** Queues a finished JSON exchange for checking (once per id). */
  private maybeCheck(e: Exchange): void {
    if (!this.contractOn || !isCheckable(e)) return;
    if (this.contractResults.has(e.id) || this.contractRunning.has(e.id)) return;
    this.contractQueue.set(e.id, e);
    if (!this.contractTimer) this.contractTimer = setTimeout(() => this.pumpContracts(), this.deps.contractDebounceMs ?? 150);
  }

  private pumpContracts(): void {
    this.contractTimer = undefined;
    const limit = Math.max(1, this.deps.contractConcurrency ?? 2);
    while (this.contractRunning.size < limit && this.contractQueue.size) {
      const [id, e] = this.contractQueue.entries().next().value as [string, Exchange];
      this.contractQueue.delete(id);
      this.contractRunning.add(id);
      void this.runCheck(e, this.contractGen);
    }
  }

  private async runCheck(e: Exchange, gen: number, opts?: { model?: string }): Promise<ContractResult | undefined> {
    let result: ContractResult;
    try {
      result = await this.deps.contract!.check(e, opts);
    } catch (err) {
      result = { exchangeId: e.id, checked: false, via: 'none', violations: [], reason: `the check failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.contractRunning.delete(e.id);
    }
    try {
      if (gen !== this.contractGen || !this.deps.host.getExchanges().some((x) => x.id === e.id)) return undefined;
      this.contractResults.set(e.id, result);
      this.pendingContract.set(e.id, contractSummary(result));
      try {
        this.deps.onContractResult?.(result);
      } catch (err) {
        this.deps.log?.(`onContractResult failed: ${String(err)}`);
      }
      this.scheduleFlush(this.deps.throttleMs ?? 50);
      return result;
    } finally {
      // Yield to the event loop between checks (REVIEW-4 #5): a re-check of many exchanges never runs as one microtask chain.
      if (this.contractQueue.size && !this.contractTimer) this.contractTimer = setTimeout(() => this.pumpContracts(), 0);
    }
  }

  private async pickModel(ex: Exchange): Promise<void> {
    if (!this.deps.contract) throw new Error('Contract checking is not available.');
    if (!this.deps.pickModel) throw new Error('Choosing a model is not available in this editor.');
    const choice = await this.deps.pickModel(ex);
    if (choice === null) return;
    await this.deps.contract.remember(ex, choice);
    // The choice applies to the whole route: every cached result may be stale.
    if (this.contractOn) {
      this.recheckContracts();
      return;
    }
    // Checking is off: still answer the user's explicit choice for this exchange.
    const r = await this.runCheck(ex, this.contractGen);
    if (r) this.flush();
  }

  private mutateField(ex: Exchange, msg: { path?: unknown; op?: unknown; value?: unknown; valueJson?: unknown }): void {
    const ro = readOnlyReason(ex);
    if (ro) throw new Error(`Can't change the next responses of this request: ${ro}.`);
    if (ex.kind === 'websocket' || ex.kind === 'sse') throw new Error(`Can't change fields of a ${ex.kind === 'sse' ? 'server-sent event stream' : 'WebSocket'}: mutation rules apply to JSON responses.`);
    if (typeof msg.op !== 'string' || !['null', 'delete', 'set'].includes(msg.op)) fail('mutateField', 'op must be "null", "delete" or "set"');
    const bad = pathError(msg.path);
    if (bad) fail('mutateField', bad);
    const op = msg.op as 'null' | 'delete' | 'set';
    // The proxy builds the match (and an empty mutate action) like every rule from an exchange; we fill the op.
    const base = ruleFromExchange(ex, 'mutate', this.newRuleId());
    let pathname = ex.url.split(/[?#]/)[0];
    try {
      pathname = new URL(ex.url).pathname;
    } catch {
      // keep the raw path
    }
    const setValue = op === 'set' ? { ...(msg.value !== undefined ? { value: msg.value } : {}), ...(msg.valueJson !== undefined ? { valueJson: msg.valueJson as string } : {}) } : {};
    const rule = validateRule({
      ...base,
      enabled: true,
      name: `${op} ${String(msg.path)} ${ex.method} ${pathname}`.slice(0, 500),
      action: { kind: 'mutate', ops: [{ path: msg.path as string, op, ...setValue }] },
    });
    this.applyRules([rule, ...this.deps.host.getRules()]);
  }

  private codegenOrThrow(): { codegen: CodegenService; open: (files: GeneratedFile[]) => Promise<unknown> } {
    if (!this.deps.codegen || !this.deps.openUntitled) throw new Error('Code generation is not available in this editor.');
    return { codegen: this.deps.codegen, open: this.deps.openUntitled };
  }

  private async generateModel(ex: Exchange): Promise<void> {
    const { codegen, open } = this.codegenOrThrow();
    const json = decodeSample(ex.responseBody);
    if (!json.ok) throw new Error(`Can't generate a model from this response: ${json.reason}.`);
    const template = (p: string) => codegen.routeTemplate(p);
    const route = routeOf(ex, template);
    const samples = modelSamples(this.deps.host.getExchanges(), ex, template).flatMap((s) => {
      const d = decodeSample(s.responseBody);
      return d.ok ? [d.value] : [];
    });
    const root = this.deps.projectRoot?.();
    const files = codegen.generateModels({
      samples: samples.length ? samples : [json.value],
      rootName: defaultModelName(route.template),
      style: root ? codegen.detectModelStyle(root) : 'plain',
      source: `${ex.method.toUpperCase()} ${route.origin}${route.template}`,
    });
    if (!files.length) throw new Error('No model could be generated from this response.');
    await open(files);
  }

  private async generateFixture(ex: Exchange): Promise<void> {
    const { codegen, open } = this.codegenOrThrow();
    if (ex.status === undefined || !FINAL_STATES.has(ex.state)) throw new Error('This request has no finished response to turn into a fixture.');
    const template = (p: string) => codegen.routeTemplate(p);
    const route = routeOf(ex, template);
    // Fixtures are committed to the repo: always the REDACTED view (CONTRACTS §10.1).
    const raw = fixtureSamples(this.deps.host.getExchanges(), ex, template);
    const root = this.deps.projectRoot?.();
    const pkg = this.deps.appPackageName?.();
    const style = root ? codegen.detectFixtureStyle(root) : 'mock_client';
    const api = style === 'mocktail' ? await fixtureApi(this.deps.contract, raw, root, pkg, this.deps.log) : undefined;
    const testPackage = testPackageFor(root);
    const files = codegen.generateFixtureTest({
      exchanges: raw.map(redactExchange),
      style,
      name: defaultFixtureName(ex.method, route.template),
      ...(pkg ? { packageName: pkg } : {}),
      ...(api ? { api } : {}),
      ...(testPackage ? { testPackage } : {}),
    });
    if (!files.length) throw new Error('No fixture could be generated from this request.');
    await open(files);
  }

  private exchangeOrThrow(id: string): Exchange {
    const ex = this.deps.host.getExchanges().find((e) => e.id === id);
    if (!ex) throw new Error('That exchange is no longer available.');
    return ex;
  }

  private onRuleHit(ruleId: string, used: number): void {
    if (typeof ruleId !== 'string' || typeof used !== 'number' || !Number.isFinite(used)) return;
    if (!this.deps.host.getRules().some((r) => r.id === ruleId) || this.used.get(ruleId) === used) return;
    this.used.set(ruleId, used);
    this.rulesDirty = true;
    this.scheduleFlush(this.deps.throttleMs ?? 50);
  }

  /** CONTRACTS §9.4: a spent rule (times used up / expired) is removed, persisted and broadcast. */
  private onRuleSpent(ruleId: string): void {
    const rules = this.deps.host.getRules();
    const next = rules.filter((r) => r.id !== ruleId);
    if (next.length === rules.length) return;
    this.used.delete(ruleId);
    if (rules.find((r) => r.id === ruleId)?.shared) {
      // A shared rule stays in the file: it is only dropped for this session.
      this.setEffective(this.sharedRules().filter((r) => r.id !== ruleId), this.personalRules());
      this.deps.log?.(`shared rule ${ruleId} spent: inactive until the shared file changes`);
      return;
    }
    try {
      this.applyRules(next);
      this.deps.log?.(`rule ${ruleId} spent: removed`);
    } catch (e) {
      this.deps.log?.(`removing spent rule ${ruleId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private newRuleId(): string {
    return this.deps.newRuleId?.() ?? `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private onExchange(e: Exchange): void {
    const before = this.paused.size;
    if (e.state === 'paused-request' || e.state === 'paused-response') this.paused.add(e.id);
    else this.paused.delete(e.id);
    if (this.paused.size !== before) this.firePaused();
    this.pending.set(e.id, e);
    this.scheduleFlush(this.deps.throttleMs ?? 50);
    this.maybeCheck(e);
    if (FINAL_STATES.has(e.state)) this.scheduleAuthFlows();
  }

  private onRemoved(ids: string[]): void {
    for (const id of ids) {
      this.pending.delete(id);
      this.streamSentAt.delete(id);
    }
    this.flush();
    this.dropContracts(ids);
    let changed = false;
    for (const id of ids) changed = this.paused.delete(id) || changed;
    if (changed) this.firePaused();
    this.broadcast({ type: 'removed', ids });
    this.scheduleAuthFlows();
  }

  /** Flush within `ms`: keeps an earlier timer, replaces a later one (a held stream must not delay other updates). */
  private scheduleFlush(ms: number): void {
    const due = Date.now() + ms;
    if (this.timer && this.timerDue <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => this.flush(), ms);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.rulesDirty) {
      this.rulesDirty = false;
      this.broadcast({ type: 'rules', rules: this.rulesView() });
    }
    if (this.pending.size) {
      const batch = [...this.pending.values()];
      this.pending.clear();
      const now = Date.now();
      const every = this.deps.streamUpdateMs ?? UI_STREAM_UPDATE_MS;
      let wait = Infinity;
      for (const exchange of batch) {
        if (isLiveStream(exchange)) {
          // Open streams: at most one update per `every` ms; the latest state waits for its turn.
          const last = this.streamSentAt.get(exchange.id);
          if (last !== undefined && now - last < every) {
            this.pending.set(exchange.id, exchange);
            wait = Math.min(wait, last + every - now);
            continue;
          }
          this.streamSentAt.set(exchange.id, now);
        } else this.streamSentAt.delete(exchange.id); // finished: sent at once
        this.broadcast({ type: 'exchange', exchange: uiExchange(exchange) });
      }
      if (wait !== Infinity) this.scheduleFlush(Math.max(1, wait));
    }
    // After the exchanges, so the panel already knows every id a result refers to.
    if (this.pendingContract.size) {
      const results = [...this.pendingContract.values()];
      this.pendingContract.clear();
      this.broadcast({ type: 'contract', results });
    }
  }

  private recomputePaused(all: Exchange[]): void {
    const before = this.paused.size;
    this.paused.clear();
    for (const e of all) if (e.state === 'paused-request' || e.state === 'paused-response') this.paused.add(e.id);
    if (before !== this.paused.size) this.firePaused();
  }

  private firePaused(): void {
    for (const l of this.pausedListeners) l(this.paused.size);
  }

  private broadcast(msg: HostMsg): void {
    for (const s of this.sinks) this.send(s, msg);
  }

  private send(sink: Sink, msg: HostMsg): void {
    this.sentCounts[msg.type] = (this.sentCounts[msg.type] ?? 0) + 1;
    try {
      sink(msg);
    } catch (e) {
      this.deps.log?.(`postMessage failed: ${String(e)}`);
    }
  }
}
