/** Core state types, the initial state, persistence and the Action union. Split out of ../state.ts (QUALITY-1 Q6). */
import type { GrpcDecodeEntry } from '../grpc';
import type { AuthFlowSummary, ClientCertFileRole, ContractSummary, Exchange, HostMsg, RecordingSummary, Rule, RuleAction, Status } from '../protocol';
import type { StatusClass } from '../util';

export const MAX_HOST_ERRORS = 5;

/** CONTRACTS §12.7 adds Recordings and Auth flows. */
export type View = 'traffic' | 'rules' | 'recordings' | 'auth';
export const VIEWS: readonly View[] = ['traffic', 'rules', 'recordings', 'auth'];
/**
 * `messages` = WebSocket messages / SSE events (CONTRACTS §11.5), only for exchanges with a `kind`;
 * `timing` = the phase breakdown (CONTRACTS §13.2).
 */
export type DetailTab = 'request' | 'response' | 'messages' | 'timing';
export const DETAIL_TABS: readonly DetailTab[] = ['request', 'response', 'messages', 'timing'];

export interface Filters {
  text: string;                 // whitespace-separated terms matched against the URL, "-term" excludes
  method: string;               // '' = any
  statusClasses: StatusClass[]; // empty = any
  pausedOnly: boolean;
  /** CONTRACTS §11.3: show the browser's own traffic (Exchange.browserInternal); hidden by default. */
  showBrowser: boolean;
}

export interface HeaderRow { name: string; value: string }

export interface RequestDraft { kind: 'request'; method: string; url: string; headers: HeaderRow[]; body: string }
export interface ResponseDraft { kind: 'response'; status: string; headers: HeaderRow[]; body: string }
export type Draft = RequestDraft | ResponseDraft;

export interface Notice { id: number; text: string; undoRules?: Rule[]; short?: boolean }

/** "Edit and resend" composer (CONTRACTS §9.3 `send`). Hidden (open=false) keeps the draft for reopening. */
export interface Composer {
  resentFrom?: string;
  draft: RequestDraft;
  /** The original body could not be copied (binary or truncated): it is not part of the draft. */
  bodyNote?: string;
  /** Original request body text, to detect a body change (content-length is then dropped). */
  originalBody?: string;
  open: boolean;
  sending: boolean;
  /** CONTRACTS §18.4: resending a gRPC call — its request messages instead of a body. */
  grpc?: GrpcComposer;
}

/** The request messages of a gRPC "Edit and resend": JSON per message when the schema decodes them, else base64. */
export interface GrpcComposer {
  mode: 'json' | 'base64';
  /** One JSON text per message (from the host's decode); absent when the schema doesn't decode every message. */
  json?: string[];
  base64: string[];
  /** Why some recorded messages can't be copied as they were (cut at 64 KB, not kept). */
  note?: string;
}
export interface HostError { id: number; message: string }

/**
 * CONTRACTS §20.3: the open "Add client certificate" popup — the parts host answers change. Never persisted (not in
 * Persisted) and never holds a path or the passphrase: the passphrase lives only in the popup's own field, and a file is
 * a one-use token plus its base name.
 */
export interface CertDialog {
  /** Bumped on every open: the popup remounts with a fresh host field. */
  id: number;
  /** Host prefill. */
  host: string;
  files: Partial<Record<ClientCertFileRole, { token: string; name: string }>>;
  /** A file picker is open for this role (the host answers `clientCertificateFile`). */
  picking?: ClientCertFileRole;
  /** `addClientCertificate` sent for this host; waiting for `clientCertificateSaved`. */
  saving?: string;
  /** The host's answer: a file couldn't be used, or nothing was saved (wrong passphrase, key doesn't match…). */
  problem?: string;
}

export interface State {
  exchanges: Exchange[];        // arrival order (oldest first)
  rules: Rule[];
  status: Status;
  connected: boolean;           // a snapshot has arrived
  filters: Filters;
  selectedId?: string;
  view: View;
  detailTab: DetailTab;
  drafts: Record<string, Draft>;        // only for paused exchanges the user has touched
  resolving: Record<string, true>;      // resume/abort sent, waiting for the host's update
  gaveUp: Record<string, true>;         // seen paused, then turned 'error': the client hung up
  hostErrors: HostError[];              // non-blocking banner
  editingRuleId?: string;               // rule id, or NEW_RULE
  /** A rule the host is about to create (createRuleFromExchange / mutateField); `label` = the notice text. */
  awaitingRule?: { kind: RuleAction['kind']; knownIds: string[]; label?: string };
  /** Contract-check results by exchange id (CONTRACTS §10.5); dropped with the exchange. */
  contracts: Record<string, ContractSummary>;
  notice?: Notice;
  splitPct: number;                     // list width in the side-by-side layout
  composer?: Composer;
  /** Host said `sent` before the new exchange arrived: select it when it does. */
  pendingSelectId?: string;
  /** SessionWarning ids the user dismissed (CONTRACTS §11); pruned to the warnings the host still reports. */
  dismissedWarnings: string[];
  /** CONTRACTS §12.7: saved recordings (newest first) and the (at most two) picked for a diff. */
  recordings: RecordingSummary[];
  recordingPicks: string[];
  /** CONTRACTS §12.3: 401 → refresh → retry flows found by the host. */
  authFlows: AuthFlowSummary[];
  /** CONTRACTS §13.2: the waterfall column in the traffic list (a view preference, remembered). */
  showWaterfall: boolean;
  /** Bumped when the host asks to show an exchange (`select`): the list scrolls to it even if already selected. */
  revealSeq: number;
  /** CONTRACTS §16.4: `decodeGrpc` requests and the host's `grpcDecoded` answers, by exchange id. */
  grpcDecoded: Record<string, GrpcDecodeEntry>;
  /** A new rule prefilled from an exchange ("Rewrite / Script / Map remote for this…"), opened unsaved in the editor. */
  ruleTemplate?: Rule;
  /** CONTRACTS §20.3: the "Add client certificate" popup, while open. */
  certDialog?: CertDialog;
}

export const NEW_RULE = '__new__';

export const EMPTY_FILTERS: Filters = { text: '', method: '', statusClasses: [], pausedOnly: false, showBrowser: false };

export function initialState(): State {
  return {
    exchanges: [],
    rules: [],
    status: { proxyRunning: false, interceptEnabled: true, sessions: 0 },
    connected: false,
    filters: EMPTY_FILTERS,
    view: 'traffic',
    detailTab: 'request',
    drafts: {},
    resolving: {},
    gaveUp: {},
    hostErrors: [],
    splitPct: 55,
    contracts: {},
    dismissedWarnings: [],
    recordings: [],
    recordingPicks: [],
    authFlows: [],
    showWaterfall: true,
    revealSeq: 0,
    grpcDecoded: {},
  };
}

/** The part of State worth keeping across webview reloads (vscode.setState). */
export type Persisted = Pick<State,
  'filters' | 'view' | 'detailTab' | 'selectedId' | 'splitPct' | 'drafts' | 'editingRuleId' | 'composer' | 'dismissedWarnings' | 'showWaterfall'>;
export function toPersisted(s: State): Persisted {
  return {
    filters: s.filters, view: s.view, detailTab: s.detailTab, selectedId: s.selectedId, splitPct: s.splitPct,
    drafts: s.drafts, editingRuleId: s.editingRuleId, composer: s.composer, dismissedWarnings: s.dismissedWarnings,
    showWaterfall: s.showWaterfall,
  };
}

export type Action =
  | { type: 'host'; msgs: HostMsg[] }
  | { type: 'restore'; persisted: Partial<Persisted> }
  | { type: 'select'; id?: string }
  | { type: 'move'; to: 'next' | 'prev' | 'first' | 'last' }
  | { type: 'setFilters'; patch: Partial<Filters> }
  | { type: 'toggleStatusClass'; cls: StatusClass }
  | { type: 'clearFilters' }
  | { type: 'showPaused' }
  | { type: 'setView'; view: View }
  | { type: 'setDetailTab'; tab: DetailTab }
  | { type: 'setDraft'; id: string; draft: Draft }
  | { type: 'patchDraft'; id: string; patch: Partial<RequestDraft> | Partial<ResponseDraft> }
  | { type: 'discardDraft'; id: string }
  | { type: 'resolving'; id: string }
  | { type: 'setRules'; rules: Rule[]; notice?: string; undoable?: boolean }
  | { type: 'editRule'; id?: string }
  | { type: 'awaitRule'; kind: RuleAction['kind']; label?: string }
  | { type: 'notice'; text?: string; short?: boolean }
  | { type: 'dismissErrors' }
  | { type: 'setSplit'; pct: number }
  | { type: 'openComposer'; id?: string }
  | { type: 'patchComposer'; patch: Partial<RequestDraft> }
  | { type: 'closeComposer'; discard?: boolean }
  | { type: 'composerSending' }
  | { type: 'dismissWarning'; id: string }
  | { type: 'pickRecording'; id: string }
  | { type: 'clearRecordingPicks' }
  | { type: 'toggleWaterfall' }
  /** CONTRACTS §16.4: the panel posted `decodeGrpc` for this version of the exchange. */
  | { type: 'grpcRequested'; id: string; key: string; base: number; at: number }
  /** Open the rule editor on a new, unsaved rule prefilled from an exchange (CONTRACTS §18). */
  | { type: 'newRuleFrom'; rule: Rule }
  /** CONTRACTS §18.4: the gRPC part of "Edit and resend". */
  | { type: 'patchGrpcComposer'; patch: Partial<GrpcComposer> }
  /** CONTRACTS §20.3: the "Add client certificate" popup (host = prefill, '' = empty). */
  | { type: 'openCertDialog'; host: string }
  | { type: 'closeCertDialog' }
  /** `chooseClientCertificateFile` posted for this role. */
  | { type: 'certPicking'; role: ClientCertFileRole }
  /** `addClientCertificate` posted for this host. */
  | { type: 'certSaving'; host: string };
