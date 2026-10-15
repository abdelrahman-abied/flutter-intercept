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
 *
 * CONTRACTS §14 (v0.8.0): `Status.upstreamProxySource` / `tlsPassthrough` / `clientCertificates` come from the host
 * (re-broadcast on its 'tlsPassthrough' / 'clientCertificates' events); tunnel exchanges (`kind: 'tunnel'`, TLS passed
 * through undecrypted) only get block rules and can't be resent; finished WebSocket / SSE exchanges are recordable.
 *
 * CONTRACTS §16.4 (v0.10.0): `decodeGrpc {id}` → `grpcDecoded` (schema decode of each message frame the panel holds,
 * else raw, hex ≤ 4 KB, skeletons of the method's types); `createRuleFromExchange` with `grpcMock` → a rule answering
 * with the call's response messages (`messagesJson` when the schema decodes them all, else base64 `messages`) and its
 * status; gRPC calls only get `grpcMock` and `block` rules from an exchange, are never resent nor recorded; HAR exports
 * include them (`_grpc`). `Status.grpc` from the host (decrypt hosts, self-check) and the injected schema service,
 * re-broadcast on the host's 'grpc' event and on schema changes. Types from src/ui/protocol.ts.
 *
 * CONTRACTS §20 (v0.14.0): `Status.learnedPassthrough` from the host (re-broadcast on its 'learnedPassthrough' event);
 * `chooseClientCertificateFile` → `clientCertificateFile`, `addClientCertificate` → `clientCertificateSaved`,
 * `removeClientCertificate` go through the injected `clientCertUi` (absent → `error`); file tokens are bound to the
 * view they were issued to. `forgetLearnedPassthrough` goes to the host. Never a path or the passphrase in a reply.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Exchange, GrpcEdit, ReplayEntry, ReplayOptions, RequestEdit, ResponseEdit, Rule, SendRequest } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
import { ruleFromExchange } from '@flutter-intercept/proxy/rules';
import { pathError } from '../agent/paths';
import { decodeSample, defaultFixtureName, FINAL_STATES, defaultModelName, fixtureSamples, isCheckable, modelSamples, redactExchange, routeOf, testPackageFor } from '../agent/samples';
import type { CodegenService, GeneratedFile } from '../codegen/types';
import type { ContractResult, ContractService } from '../contract/types';
import type { AuthAnalysis } from '../analysis/types';
import type { Recording, RecordingService } from '../recordings/types';
import type { SharedRulesService, SharedRulesState } from '../rules/types';
import type { ToOpenApi, ToPostman } from '../export/types';
import { buildHar, ensureDirInside, EXPORT_DIR, type HarGrpcDecoder } from '../agent/har';
import { decodeGrpcMessages, type GrpcDeps } from '../grpc/service';
import { gitIgnoreStatus, type GitignoreFs } from '../recordings/gitignore';
import { mapRemoteSelfProblem } from '../proxyHost';
import { createViewHandlers, type ViewHandlers } from './handlers';
import { LEARNED_SHOWN_MAX } from '@flutter-intercept/proxy/learned-meta';
import type { ClientCertUi } from './clientCertUi';
import type { AgentStatus, AuthFlowSummary, ContractSummary, ExportFormat, GrpcDecoded, GrpcStatus, HostMsg, SessionWarning, Status, ViewMsg } from './protocol';

export type { GrpcDecoded, GrpcDecodedMessage, GrpcStatus } from './protocol';
import { fail, validateNetworkProfile, validateRule, validateRules, expireTokenRule } from './validate';
import { authFlowSummaries, CONTRACT_OFF, contractSummary, isRecordable, isLiveStream, pendingView, readOnlyReason, recordingSummary, sameRules, sharedRulesStatus, uiExchange, UI_STREAM_UPDATE_MS, fixtureApi } from './views';
import { decodeGrpcForPanel } from './grpcHost';

// QUALITY-1 Q3: moved to ./validate, ./views and ./grpcHost; re-exported so existing imports keep working.
export { InvalidMessageError, MAX_MUTATE_OPS, validateRule, MAX_SEQUENCE_STEPS, MAX_REWRITE_HEADERS, MAX_REWRITE_REPLACEMENTS, MAX_REWRITE_REPLACE, MAX_REWRITE_TEXT_TOTAL, MAX_BODY_FILE_PATH, MAX_GRPC_MOCK_MESSAGES, MAX_GRPC_MOCK_BYTES, MAX_GRPC_MESSAGE_TEXT, validateGrpcEdit, checkBodyFile, MAX_SCRIPT_BYTES, checkScriptFile, MAX_BODY_FILE_BYTES, checkMapTarget, grpcRewriteProblem, expireTokenRule, validateRules, validateEdit, sanitizeSendHeaders, validateSendDraft, sanitizeGrpcSendHeaders, validateNetworkProfile } from './validate';
export { pendingView, isRecordable, recordingSummary, authFlowSummaries, sharedRulesStatus, contractSummary, fixtureApi, UI_MAX_FRAMES, UI_MAX_FRAME_CHARS, UI_STREAM_UPDATE_MS, uiFrameCost, uiExchange, readOnlyReason, tunnelBlockRule, tunnelReason, ruleFromExchangeErrorMessage, snippetFor } from './views';
export { UI_MAX_GRPC_JSON_CHARS, UI_MAX_PAUSED_JSON_CHARS, resolveGrpcEdit, grpcMockRuleFromExchange, GRPC_WEB_RESEND, grpcResendMessages, resolveSendGrpc } from './grpcHost';

export type Sink = (msg: HostMsg) => void;

/** CONTRACTS §20.2: how many learned passthrough hosts Status carries (the proxy keeps up to LEARNED_MAX). */
export const STATUS_MAX_LEARNED = LEARNED_SHOWN_MAX;
export { CLIENT_CERT_UI_MISSING } from './clientCertUi';

export interface ControllerHost {
  readonly running: boolean;
  readonly port: number | undefined;
  /** Open LAN listener (no token), CONTRACTS §7; `peer` = the device it is pinned to. */
  readonly lan?: { host: string; port: number; peer?: string };
  getExchanges(): Exchange[];
  getRules(): Rule[];
  setRules(rules: Rule[]): void;
  clear(): void;
  resume(id: string, edit?: RequestEdit | ResponseEdit | GrpcEdit): void;
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
  // CONTRACTS §14 (InterceptProxyHost). Optional on older hosts.
  /** §14.6: where the upstream proxy came from (`http.proxy` = VS Code's setting). */
  readonly upstreamProxySource?: 'flutterIntercept' | 'http.proxy';
  /** §14.2: hosts whose TLS is passed through undecrypted. */
  readonly tlsPassthrough?: string[];
  /** §14.3: host pattern + problem per configured client certificate (never paths or key material). */
  readonly clientCertificateStatus?: { host: string; problem?: string }[];
  /** Fire after the passthrough hosts / client certificates changed. */
  on(event: 'tlsPassthrough' | 'clientCertificates', l: (info: unknown) => void): unknown;
  // CONTRACTS §20.2 (InterceptProxyHost). Optional on older hosts.
  /** Hosts the proxy passes through on its own (the app's own client certificate, or it pins). */
  readonly learnedPassthrough?: NonNullable<Status['learnedPassthrough']>;
  /** Forget one learned `host:port` (none = all). */
  forgetLearnedPassthrough?(key?: string): void;
  /** Fires after the learned list changed. */
  on(event: 'learnedPassthrough', l: (list: unknown) => void): unknown;
  // CONTRACTS §16.4 (InterceptProxyHost). Optional on older hosts.
  /** Hosts whose TLS gRPC is decrypted. */
  readonly grpcDecryptHosts?: string[];
  /** The proxy's gRPC self-check failed (or the build has no gRPC support). */
  readonly grpcProblem?: string;
  /** Fires after the decrypt hosts or the self-check result changed. */
  on(event: 'grpc', l: (info: unknown) => void): unknown;
  /** CONTRACTS §16.8: drop the gRPC breaker warnings (called when the last debug session ends). */
  clearGrpcBreakerWarnings?(): void;
  /** CONTRACTS §19.3 (InterceptProxyHost.simulatorTrust): simulators that trust our CA, and decrypt-all. */
  readonly simulatorTrust?: NonNullable<Status['grpc']>['simulatorTrust'];
  /** REVIEW-12 #1 (InterceptProxyHost.ownListeners): the proxy's own ports / LAN address — Map Remote may not target them. */
  readonly ownListeners?: { ports: number[]; hosts: string[] };
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
  /** CONTRACTS §20.3: adding / removing client certificates from the panel. Absent → those messages answer with an `error`. */
  clientCertUi?: ClientCertUi;
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

  // ---- CONTRACTS §16.4 (v0.10.0). Optional: without it gRPC messages are shown raw only where possible.
  /** The gRPC schema service (src/grpc/service.ts `createGrpcSchemaService`); its `onDidChange` re-broadcasts status. */
  grpc?: GrpcDeps & { onDidChange?(listener: () => void): { dispose(): void } };
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
  /** @internal (handlers) */
  readonly contractResults = new Map<string, ContractResult>();
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

  /** @internal (handlers) CONTRACTS §20.3: client-certificate file tokens per view they were issued to (a token is bound to its panel). */
  readonly certTokens = new WeakMap<Sink, Set<string>>();

  /** QUALITY-1 Q3: the ViewMsg handlers (src/ui/handlers.ts). */
  private readonly handlers: ViewHandlers;

  constructor(/** @internal (handlers) */ readonly deps: ControllerDeps) {
    this.handlers = createViewHandlers(this);
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
    deps.host.on('tlsPassthrough', () => this.broadcastStatus());
    deps.host.on('clientCertificates', () => this.broadcastStatus());
    deps.host.on('learnedPassthrough', () => this.broadcastStatus());
    deps.host.on('grpc', () => this.broadcastStatus());
    this.grpcSub = deps.grpc?.onDidChange?.(() => this.broadcastStatus());
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
      ...this.tlsStatus(),
      ...this.grpcStatus(),
    };
  }

  /** CONTRACTS §16.4: `Status.grpc` (only with the gRPC schema service wired). */
  private grpcStatus(): { grpc?: GrpcStatus } {
    const g = this.deps.grpc;
    if (!g) return {};
    let enabled = true;
    let schema: GrpcStatus['schema'];
    try {
      enabled = g.enabled();
      const st = g.status();
      if (st) schema = { methods: st.methods, messages: st.messages, problems: st.problems.slice(0, 50) };
    } catch (e) {
      this.deps.log?.(`gRPC status failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const problem = this.deps.host.grpcProblem;
    const sim = this.deps.host.simulatorTrust;
    return {
      grpc: {
        enabled,
        decryptHosts: [...(this.deps.host.grpcDecryptHosts ?? [])],
        ...(problem ? { problem } : {}),
        ...(schema ? { schema } : {}),
        // CONTRACTS §19.3
        ...(sim ? { simulatorTrust: { devices: sim.devices.map((d) => ({ ...d })), decryptAll: sim.decryptAll === true } } : {}),
      },
    };
  }

  /** CONTRACTS §16.4: the panel's `decodeGrpc`: the messages it holds (uiExchange's frames), decoded (grpcHost.ts). */
  decodeGrpc(id: string): GrpcDecoded {
    return decodeGrpcForPanel(this.exchangeOrThrow(id), this.deps.grpc, this.deps.projectRoot?.());
  }

  /** REVIEW-6 #1: the upstream proxy (`host:port`) and whether its certificate checks are off; §14.6 its source. */
  private upstreamStatus(): Pick<Status, 'upstreamProxy' | 'upstreamProxyInsecure' | 'upstreamProxySource'> {
    const info = this.deps.host.upstreamProxyInfo;
    if (!info?.display) return {};
    const source = this.deps.host.upstreamProxySource;
    return {
      upstreamProxy: info.display,
      ...(info.ignoreCertErrors ? { upstreamProxyInsecure: true as const } : {}),
      ...(source === 'http.proxy' || source === 'flutterIntercept' ? { upstreamProxySource: source } : {}),
    };
  }

  /**
   * CONTRACTS §14.2 / §14.3 / §20.2: passthrough hosts, client-certificate status (host patterns + problems only) and
   * the hosts the proxy learned to pass through (at most STATUS_MAX_LEARNED).
   */
  private tlsStatus(): Pick<Status, 'tlsPassthrough' | 'clientCertificates' | 'learnedPassthrough'> {
    const hosts = this.deps.host.tlsPassthrough;
    const certs = this.deps.host.clientCertificateStatus;
    let learned: Status['learnedPassthrough'];
    try {
      learned = this.deps.host.learnedPassthrough;
    } catch (e) {
      this.deps.log?.(`learned passthrough list failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      ...(hosts?.length ? { tlsPassthrough: [...hosts] } : {}),
      ...(certs?.length ? { clientCertificates: certs.map((c) => ({ host: c.host, ...(c.problem ? { problem: c.problem } : {}) })) } : {}),
      ...(learned?.length
        ? {
            learnedPassthrough: learned
              .slice(0, STATUS_MAX_LEARNED)
              .map((l) => ({ host: l.host, port: l.port, reason: l.reason, ...(typeof l.until === 'number' ? { until: l.until } : {}) })),
          }
        : {}),
    };
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
    // CONTRACTS §16.8: breaker warnings belong to the sessions that saw them.
    if (n === 0) this.deps.host.clearGrpcBreakerWarnings?.();
    this.broadcastStatus();
  }

  broadcastStatus(): void {
    this.broadcast({ type: 'status', status: this.status() });
  }

  private grpcSub?: { dispose(): void };

  snapshot(): HostMsg {
    return { type: 'snapshot', exchanges: this.deps.host.getExchanges().map(uiExchange), rules: this.rulesView(), status: this.status() };
  }

  async handle(raw: unknown, reply: Sink): Promise<void> {
    const msg = raw as ViewMsg;
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    // QUALITY-1 Q3: one handler per message type (src/ui/handlers.ts); unknown types are ignored
    if (!Object.prototype.hasOwnProperty.call(this.handlers, msg.type)) return;
    const handler = this.handlers[msg.type] as (m: ViewMsg, reply: Sink) => Promise<void> | void;
    try {
      await handler(msg, reply);
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
      text = JSON.stringify(buildHar(list, { redact, creatorVersion: this.deps.version, grpcDecode: this.harGrpcDecoder() }), null, 2);
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

  /** CONTRACTS §16.4: decoded gRPC messages for HAR exports (redacted exports carry JSON, never raw bytes). */
  harGrpcDecoder(): HarGrpcDecoder | undefined {
    const g = this.deps.grpc;
    return g ? (e) => decodeGrpcMessages(e, g).messages.map((m) => (m.via === 'schema' ? m.json : undefined)) : undefined;
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
    // CONTRACTS §18.6 / REVIEW-12 #1: a Map Remote to the proxy's own port would loop (shared rules are filtered by the host)
    const own = this.deps.host.ownListeners;
    if (own) {
      for (const [i, r] of rules.entries()) {
        if (r.shared) continue;
        const targets = r.action.kind === 'mapRemote' ? [r.action.to] : r.action.kind === 'sequence' ? r.action.steps.flatMap((st) => (st.action.kind === 'mapRemote' ? [st.action.to] : [])) : [];
        for (const to of targets) {
          const why = mapRemoteSelfProblem(to, own);
          if (why) fail(`rule ${i + 1}`, why);
        }
      }
    }
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

  /** @internal (handlers) */
  recordingsOrThrow(): { recordings: RecordingService } {
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
  /** @internal (handlers) */
  async saveRecording(msg: { name?: unknown; ids?: unknown; redact?: unknown }): Promise<void> {
    const { recordings } = this.recordingsOrThrow();
    if (typeof msg.name !== 'string' || !msg.name.trim() || msg.name.length > 200) fail('saveRecording', 'name must be 1–200 characters');
    if (msg.redact !== undefined && typeof msg.redact !== 'boolean') fail('saveRecording', 'redact must be a boolean');
    let ids: Set<string> | undefined;
    if (msg.ids !== undefined) {
      if (!Array.isArray(msg.ids) || msg.ids.length > 100_000 || !msg.ids.every((x) => typeof x === 'string')) fail('saveRecording', 'ids must be a list of exchange ids');
      ids = new Set(msg.ids as string[]);
    }
    const list = this.deps.host.getExchanges().filter((e) => isRecordable(e) && (!ids || ids.has(e.id)));
    if (!list.length) throw new Error('There is no finished HTTP request, WebSocket or SSE stream to save (open connections, TLS tunnels and native-client traffic are not recorded).');
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

  /** @internal (handlers) */
  async deleteRecording(id: string): Promise<void> {
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
    this.grpcSub?.dispose();
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
  /** @internal (handlers) */
  maybeCheck(e: Exchange): void {
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

  /** @internal (handlers) */
  async pickModel(ex: Exchange): Promise<void> {
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

  /** @internal (handlers) */
  mutateField(ex: Exchange, msg: { path?: unknown; op?: unknown; value?: unknown; valueJson?: unknown }): void {
    const ro = readOnlyReason(ex);
    if (ro) throw new Error(`Can't change the next responses of this request: ${ro}.`);
    if (ex.kind === 'websocket' || ex.kind === 'sse') throw new Error(`Can't change fields of a ${ex.kind === 'sse' ? 'server-sent event stream' : 'WebSocket'}: mutation rules apply to JSON responses.`);
    // CONTRACTS §17.3: gRPC response messages are mutated through the schema (the proxy's codec); tunnels can't be.
    if (ex.kind === 'tunnel') throw new Error("Can't change fields of a passed-through TLS connection: it isn't decrypted.");
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

  /** @internal (handlers) */
  async generateModel(ex: Exchange): Promise<void> {
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

  /** @internal (handlers) */
  async generateFixture(ex: Exchange): Promise<void> {
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

  /** @internal (handlers) */
  exchangeOrThrow(id: string): Exchange {
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

  /** @internal (handlers) */
  newRuleId(): string {
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

  /** @internal (handlers) */
  flush(): void {
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

  /** @internal (handlers) */
  send(sink: Sink, msg: HostMsg): void {
    this.sentCounts[msg.type] = (this.sentCounts[msg.type] ?? 0) + 1;
    try {
      sink(msg);
    } catch (e) {
      this.deps.log?.(`postMessage failed: ${String(e)}`);
    }
  }
}
