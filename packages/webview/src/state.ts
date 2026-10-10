/**
 * Pure UI state: one reducer, no DOM, no postMessage. Everything here is unit-tested.
 * Side effects (posting ViewMsg to the host) live in the components / app shell.
 */
import type {
  ContractSummary, Exchange, HostMsg, NetworkProfile, RequestEdit, ResponseEdit, Rule, RuleAction, SendDraft, SnippetFormat, Status,
} from './protocol';
import type { FaultKind, MutateOp } from '@flutter-intercept/proxy/types';
import { compileMatcher, matches } from '@flutter-intercept/proxy/rules';
import { describeProfile, NETWORK_PRESETS, presetProfile, type NetworkPresetId } from '@flutter-intercept/proxy/network';
import { matchesFilter, parseFilter } from './filter';
import { checkPath } from './jsonpath';
import {
  describeMatcherUrl, formatRemaining, headerValue, isAbsoluteUrl, isJsonContentType, isPaused, newId, statusClassOf,
  validateJson, type Headers, type JsonCheck, type StatusClass,
} from './util';

/** Host `error` messages kept for the banner (newest last). */
export const MAX_HOST_ERRORS = 5;

export type View = 'traffic' | 'rules';
export type DetailTab = 'request' | 'response';

export interface Filters {
  text: string;                 // whitespace-separated terms matched against the URL, "-term" excludes
  method: string;               // '' = any
  statusClasses: StatusClass[]; // empty = any
  pausedOnly: boolean;
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
}
export interface HostError { id: number; message: string }

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
}

export const NEW_RULE = '__new__';

export const EMPTY_FILTERS: Filters = { text: '', method: '', statusClasses: [], pausedOnly: false };

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
  };
}

/** The part of State worth keeping across webview reloads (vscode.setState). */
export type Persisted = Pick<State, 'filters' | 'view' | 'detailTab' | 'selectedId' | 'splitPct' | 'drafts' | 'editingRuleId' | 'composer'>;
export function toPersisted(s: State): Persisted {
  return {
    filters: s.filters, view: s.view, detailTab: s.detailTab, selectedId: s.selectedId, splitPct: s.splitPct,
    drafts: s.drafts, editingRuleId: s.editingRuleId, composer: s.composer,
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
  | { type: 'composerSending' };

let noticeSeq = 0;
let errorSeq = 0;
const notice = (text: string, undoRules?: Rule[], short?: boolean): Notice => ({ id: ++noticeSeq, text, undoRules, short });

// ---------------------------------------------------------------- reducer

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'host':
      return action.msgs.reduce(applyHostMsg, state);

    case 'restore': {
      const p = action.persisted;
      return {
        ...state,
        filters: p.filters ? { ...EMPTY_FILTERS, ...p.filters } : state.filters,
        view: p.view ?? state.view,
        detailTab: p.detailTab ?? state.detailTab,
        selectedId: p.selectedId ?? state.selectedId,
        splitPct: p.splitPct ?? state.splitPct,
        drafts: p.drafts ?? state.drafts,
        editingRuleId: p.editingRuleId ?? state.editingRuleId,
        composer: p.composer ? { ...p.composer, sending: false } : state.composer,
      };
    }

    case 'select': {
      const ex = action.id ? findExchange(state, action.id) : undefined;
      return { ...state, selectedId: ex?.id, detailTab: tabFor(ex, state.detailTab), composer: hideComposer(state.composer) };
    }

    case 'move': {
      const list = filterExchanges(state.exchanges, state.filters, state.contracts);
      if (!list.length) return state;
      const cur = state.selectedId ? list.findIndex((e) => e.id === state.selectedId) : -1;
      let idx: number;
      switch (action.to) {
        case 'first': idx = 0; break;
        case 'last': idx = list.length - 1; break;
        case 'next': idx = cur < 0 ? 0 : Math.min(cur + 1, list.length - 1); break;
        case 'prev': idx = cur < 0 ? list.length - 1 : Math.max(cur - 1, 0); break;
      }
      const ex = list[idx];
      return { ...state, selectedId: ex.id, detailTab: tabFor(ex, state.detailTab), composer: hideComposer(state.composer) };
    }

    case 'setFilters':
      return { ...state, filters: { ...state.filters, ...action.patch } };

    case 'toggleStatusClass': {
      const cur = state.filters.statusClasses;
      const statusClasses = cur.includes(action.cls) ? cur.filter((c) => c !== action.cls) : [...cur, action.cls];
      return { ...state, filters: { ...state.filters, statusClasses } };
    }

    case 'clearFilters':
      return { ...state, filters: EMPTY_FILTERS };

    case 'showPaused': {
      // Jump to the next paused exchange after the current selection (wrapping).
      const paused = state.exchanges.filter(isPaused);
      if (!paused.length) return state;
      const cur = paused.findIndex((e) => e.id === state.selectedId);
      const ex = paused[(cur + 1) % paused.length];
      const visible = filterExchanges(state.exchanges, state.filters, state.contracts).some((e) => e.id === ex.id);
      return {
        ...state,
        view: 'traffic',
        selectedId: ex.id,
        detailTab: tabFor(ex, state.detailTab),
        filters: visible ? state.filters : { ...EMPTY_FILTERS, pausedOnly: true },
      };
    }

    case 'setView':
      return { ...state, view: action.view };

    case 'setDetailTab':
      return { ...state, detailTab: action.tab };

    case 'setDraft':
      return { ...state, drafts: { ...state.drafts, [action.id]: action.draft } };

    case 'patchDraft': {
      // Merge into the *current* draft (not a render-time copy) so back-to-back edits compose.
      const ex = findExchange(state, action.id);
      const cur = ex && currentDraft(state, ex);
      if (!cur) return state;
      return { ...state, drafts: { ...state.drafts, [action.id]: { ...cur, ...action.patch } as Draft } };
    }

    case 'discardDraft':
      return { ...state, drafts: omit(state.drafts, action.id) };

    case 'resolving':
      // The draft is kept: if the host rejects the edit (an 'error' message), the user can fix it.
      // It is dropped once the exchange leaves this paused phase.
      return { ...state, resolving: { ...state.resolving, [action.id]: true } };

    case 'setRules': {
      const next = { ...state, rules: action.rules };
      if (state.editingRuleId && state.editingRuleId !== NEW_RULE && !action.rules.some((r) => r.id === state.editingRuleId)) {
        next.editingRuleId = undefined;
      }
      if (action.notice) next.notice = notice(action.notice, action.undoable ? state.rules : undefined);
      return next;
    }

    case 'editRule':
      return { ...state, editingRuleId: action.id, view: action.id ? 'rules' : state.view };

    case 'awaitRule':
      return { ...state, awaitingRule: { kind: action.kind, knownIds: state.rules.map((r) => r.id), label: action.label } };

    case 'notice':
      return { ...state, notice: action.text ? notice(action.text, undefined, action.short) : undefined };

    case 'dismissErrors':
      return { ...state, hostErrors: [] };

    case 'setSplit':
      return { ...state, splitPct: Math.max(20, Math.min(80, action.pct)) };

    case 'openComposer': {
      // Reopening on the same exchange keeps the hidden draft; another exchange (or a blank one) starts fresh.
      const cur = state.composer;
      if (cur && cur.resentFrom === action.id && !cur.sending) {
        return { ...state, view: 'traffic', composer: { ...cur, open: true } };
      }
      const ex = action.id ? findExchange(state, action.id) : undefined;
      if (action.id && !ex) return state;
      return { ...state, view: 'traffic', composer: ex ? composerFromExchange(ex) : blankComposer() };
    }

    case 'patchComposer':
      if (!state.composer) return state;
      return { ...state, composer: { ...state.composer, draft: { ...state.composer.draft, ...action.patch } } };

    case 'closeComposer':
      return { ...state, composer: action.discard ? undefined : hideComposer(state.composer) };

    case 'composerSending':
      return state.composer ? { ...state, composer: { ...state.composer, sending: true } } : state;
  }
}

function hideComposer(c: Composer | undefined): Composer | undefined {
  if (!c || !c.open) return c;
  return { ...c, open: false };
}

/** Select `id` (a request the host just sent) and close the composer that sent it. */
function selectSent(state: State, id: string): State {
  const composer = state.composer?.sending ? undefined : state.composer;
  if (!state.exchanges.some((e) => e.id === id)) return { ...state, pendingSelectId: id, composer };
  return { ...state, pendingSelectId: undefined, selectedId: id, detailTab: 'response', view: 'traffic', composer };
}

function applyHostMsg(state: State, msg: HostMsg): State {
  switch (msg.type) {
    case 'snapshot': {
      const exchanges = msg.exchanges;
      const byId = new Map(exchanges.map((e) => [e.id, e]));
      const next: State = {
        ...state,
        connected: true,
        exchanges,
        rules: msg.rules,
        status: msg.status,
        drafts: pruneDrafts(state.drafts, byId),
        resolving: {},
        gaveUp: pick(state.gaveUp, byId),
        contracts: pick(state.contracts, byId),
      };
      if (state.editingRuleId && state.editingRuleId !== NEW_RULE && !msg.rules.some((r) => r.id === state.editingRuleId)) {
        next.editingRuleId = undefined;
      }
      if (state.selectedId && !byId.has(state.selectedId)) next.selectedId = undefined;
      if (state.pendingSelectId && byId.has(state.pendingSelectId)) {
        next.selectedId = state.pendingSelectId;
        next.pendingSelectId = undefined;
      }
      if (next.selectedId) {
        next.detailTab = tabFor(byId.get(next.selectedId), state.detailTab);
      } else {
        // Something is waiting at a breakpoint: show it rather than an unselected list.
        const paused = exchanges.find(isPaused);
        if (paused) {
          next.selectedId = paused.id;
          next.detailTab = tabFor(paused, state.detailTab);
        }
      }
      return next;
    }

    case 'exchange': {
      const ex = msg.exchange;
      let idx = -1;
      for (let k = state.exchanges.length - 1; k >= 0; k--) {
        if (state.exchanges[k].id === ex.id) { idx = k; break; }
      }
      let exchanges: Exchange[];
      let next: State = state;
      if (idx >= 0) {
        exchanges = state.exchanges.slice();
        exchanges[idx] = ex;
      } else {
        // No cap here: the proxy's ring buffer decides, and tells us via 'removed'.
        exchanges = [...state.exchanges, ex];
      }
      next = { ...next, exchanges };
      if (idx >= 0 && isPaused(state.exchanges[idx]) && ex.state === 'error') {
        next.gaveUp = { ...state.gaveUp, [ex.id]: true };
      }

      // Drafts / resolving flags only make sense while paused in the same phase.
      const draft = state.drafts[ex.id];
      if (draft && draftKindFor(ex) !== draft.kind) next.drafts = omit(state.drafts, ex.id);
      if (state.resolving[ex.id] && (!isPaused(ex) || idx < 0 || state.exchanges[idx].state !== ex.state)) {
        next.resolving = omit(state.resolving, ex.id);
      }

      if (isPaused(ex)) {
        const wasPausedSame = idx >= 0 && state.exchanges[idx].state === ex.state;
        if (!state.selectedId && !wasPausedSame) {
          // Nothing selected: bring the newly paused exchange into view.
          next.selectedId = ex.id;
          next.detailTab = tabFor(ex, state.detailTab);
        } else if (state.selectedId === ex.id && !wasPausedSame) {
          next.detailTab = tabFor(ex, state.detailTab);
        }
      }
      if (state.pendingSelectId === ex.id) {
        next.pendingSelectId = undefined;
        next.selectedId = ex.id;
        next.detailTab = tabFor(ex, 'response');
        next.composer = hideComposer(next.composer);
      }
      if (next.selectedId && !exchanges.some((e) => e.id === next.selectedId)) next.selectedId = undefined;
      return next;
    }

    case 'sent':
      return selectSent(state, msg.id);

    case 'rules': {
      const next: State = { ...state, rules: msg.rules };
      if (state.editingRuleId && state.editingRuleId !== NEW_RULE && !msg.rules.some((r) => r.id === state.editingRuleId)) {
        next.editingRuleId = undefined;
      }
      if (state.awaitingRule) {
        const created = msg.rules.find((r) => !state.awaitingRule!.knownIds.includes(r.id));
        if (created) {
          next.awaitingRule = undefined;
          const label = describeAction(created.action);
          if (state.awaitingRule.label) {
            // mutateField: the host inserted it first; Undo restores the list without it.
            next.notice = notice(`Rule added: ${state.awaitingRule.label}`, msg.rules.filter((r) => r.id !== created.id));
          } else if (state.awaitingRule.kind === 'mock') {
            // A mock is only useful once its body is edited: open it straight away.
            next.view = 'rules';
            next.editingRuleId = created.id;
            next.notice = notice(`Created rule “${ruleLabel(created)}” (${label}). Edit the mock below.`);
          } else {
            next.notice = notice(`Created rule “${ruleLabel(created)}” (${label}).`);
          }
        }
      }
      return next;
    }

    case 'status':
      return { ...state, status: msg.status };

    case 'contract': {
      if (!msg.results.length) return state;
      const contracts = { ...state.contracts };
      for (const r of msg.results) contracts[r.id] = r;
      return { ...state, contracts };
    }

    case 'removed': {
      if (!msg.ids.length) return state;
      const gone = new Set(msg.ids);
      const exchanges = state.exchanges.filter((e) => !gone.has(e.id));
      if (exchanges.length === state.exchanges.length) return state;
      const drop = <T,>(rec: Record<string, T>) => {
        let out = rec;
        for (const id of msg.ids) out = omit(out, id);
        return out;
      };
      return {
        ...state,
        exchanges,
        drafts: drop(state.drafts),
        resolving: drop(state.resolving),
        gaveUp: drop(state.gaveUp),
        contracts: drop(state.contracts),
        selectedId: state.selectedId && gone.has(state.selectedId) ? undefined : state.selectedId,
      };
    }

    case 'error':
      // Non-blocking. Unlock any "Sent — waiting…" editor: a rejected resume leaves the exchange paused.
      return {
        ...state,
        hostErrors: [...state.hostErrors, { id: ++errorSeq, message: msg.message }].slice(-MAX_HOST_ERRORS),
        resolving: {},
        composer: state.composer?.sending ? { ...state.composer, sending: false } : state.composer,
      };

    case 'cleared':
      return { ...state, exchanges: [], drafts: {}, resolving: {}, gaveUp: {}, contracts: {}, selectedId: undefined };
  }
}

function pick<T>(rec: Record<string, T>, keep: Map<string, unknown>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) if (keep.has(k)) out[k] = v;
  return out;
}

/**
 * The app closed the connection while this exchange sat at a breakpoint (usually its own
 * receive/connect timeout). The proxy records it as 'error' and ignores any late resume.
 */
export function clientGaveUp(state: Pick<State, 'gaveUp'>, ex: Exchange): boolean {
  if (ex.state !== 'error') return false;
  return !!state.gaveUp[ex.id] || /closed the connection while .* paused/i.test(ex.error ?? '');
}

function pruneDrafts(drafts: Record<string, Draft>, byId: Map<string, Exchange>): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const [id, d] of Object.entries(drafts)) {
    const ex = byId.get(id);
    if (ex && draftKindFor(ex) === d.kind) out[id] = d;
  }
  return out;
}

function tabFor(ex: Exchange | undefined, current: DetailTab): DetailTab {
  if (ex?.state === 'paused-response') return 'response';
  if (ex?.state === 'paused-request') return 'request';
  return current;
}

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _, ...rest } = rec;
  return rest;
}

export function findExchange(state: Pick<State, 'exchanges'>, id: string): Exchange | undefined {
  for (let k = state.exchanges.length - 1; k >= 0; k--) if (state.exchanges[k].id === id) return state.exchanges[k];
  return undefined;
}

export function pausedCount(exchanges: Exchange[]): number {
  let n = 0;
  for (const e of exchanges) if (isPaused(e)) n++;
  return n;
}

// ---------------------------------------------------------------- filtering

export function hasActiveFilters(f: Filters): boolean {
  return !!f.text.trim() || !!f.method || f.statusClasses.length > 0 || f.pausedOnly;
}

/**
 * The text box speaks the filter language in ./filter (free words match the URL, m: s: t: body: h: state:
 * src:, -negation); it is AND-ed with the method / status-class / paused-only controls.
 */
export function filterExchanges(exchanges: Exchange[], f: Filters, contracts?: Record<string, ContractSummary>): Exchange[] {
  if (!hasActiveFilters(f)) return exchanges;
  const parsed = parseFilter(f.text);
  const method = f.method.toUpperCase();
  return exchanges.filter((e) => {
    if (f.pausedOnly && !isPaused(e)) return false;
    if (method && e.method.toUpperCase() !== method) return false;
    if (f.statusClasses.length) {
      const c = statusClassOf(e);
      if (!c || !f.statusClasses.includes(c)) return false;
    }
    return parsed.empty || matchesFilter(e, parsed, { contracts });
  });
}

// ---------------------------------------------------------------- paused-exchange drafts

export function draftKindFor(ex: Exchange): Draft['kind'] | undefined {
  return ex.state === 'paused-request' ? 'request' : ex.state === 'paused-response' ? 'response' : undefined;
}

export function headersToRows(h: Headers | undefined): HeaderRow[] {
  const rows: HeaderRow[] = [];
  for (const [name, v] of Object.entries(h ?? {})) {
    if (Array.isArray(v)) for (const x of v) rows.push({ name, value: x });
    else rows.push({ name, value: v });
  }
  return rows;
}

/**
 * Rows → edit headers (the full replacement set). Empty names are dropped; a name that
 * appears on several rows (case-insensitively) becomes a string[] in row order — never joined,
 * so Set-Cookie and friends survive.
 */
export function rowsToRecord(rows: HeaderRow[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const canonical = new Map<string, string>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const key = canonical.get(name.toLowerCase());
    if (key === undefined) {
      canonical.set(name.toLowerCase(), name);
      out[name] = r.value;
    } else {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, r.value] : [prev, r.value];
    }
  }
  return out;
}

/** Mock rule headers are Record<string, string> in the contract: repeated names are joined. */
export function rowsToFlatRecord(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rowsToRecord(rows))) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** One line per (lower-cased name, value); value order within a name is kept. */
function normalizedHeaders(h: Record<string, string | string[]>): string {
  return Object.entries(h)
    .map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v : [v]] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([k, vs]) => vs.map((v) => `${k}:${v}`))
    .join('\n');
}

export function headersChanged(original: Headers | undefined, rows: HeaderRow[]): boolean {
  return normalizedHeaders(original ?? {}) !== normalizedHeaders(rowsToRecord(rows));
}

/** Body editing is only safe for complete UTF-8 bodies (or no body at all). */
export function isBodyEditable(body: Exchange['requestBody']): boolean {
  return !body || (body.encoding === 'utf8' && !body.truncated);
}

export function draftFromExchange(ex: Exchange): Draft | undefined {
  if (ex.state === 'paused-request') {
    return {
      kind: 'request',
      method: ex.method,
      url: ex.url,
      headers: headersToRows(ex.requestHeaders),
      body: ex.requestBody?.encoding === 'utf8' ? ex.requestBody.text : '',
    };
  }
  if (ex.state === 'paused-response') {
    return {
      kind: 'response',
      status: ex.status !== undefined ? String(ex.status) : '',
      headers: headersToRows(ex.responseHeaders),
      body: ex.responseBody?.encoding === 'utf8' ? ex.responseBody.text : '',
    };
  }
  return undefined;
}

/** The draft the editor shows: the user's draft if it matches the paused phase, else a fresh one. */
export function currentDraft(state: Pick<State, 'drafts'>, ex: Exchange): Draft | undefined {
  const d = state.drafts[ex.id];
  return d && d.kind === draftKindFor(ex) ? d : draftFromExchange(ex);
}

/** Only the fields that differ from the paused request; undefined when nothing changed. */
export function computeRequestEdit(ex: Exchange, d: RequestDraft): RequestEdit | undefined {
  const edit: RequestEdit = {};
  const method = d.method.trim().toUpperCase();
  if (method && method !== ex.method.toUpperCase()) edit.method = method;
  const url = d.url.trim();
  if (url && url !== ex.url) edit.url = url;
  if (headersChanged(ex.requestHeaders, d.headers)) edit.headers = rowsToRecord(d.headers);
  if (isBodyEditable(ex.requestBody) && d.body !== (ex.requestBody?.text ?? '')) edit.body = d.body;
  return Object.keys(edit).length ? edit : undefined;
}

export function computeResponseEdit(ex: Exchange, d: ResponseDraft): ResponseEdit | undefined {
  const edit: ResponseEdit = {};
  const status = Number(d.status.trim());
  if (d.status.trim() && Number.isInteger(status) && status !== ex.status) edit.status = status;
  if (headersChanged(ex.responseHeaders, d.headers)) edit.headers = rowsToRecord(d.headers);
  if (isBodyEditable(ex.responseBody) && d.body !== (ex.responseBody?.text ?? '')) edit.body = d.body;
  return Object.keys(edit).length ? edit : undefined;
}

export function computeEdit(ex: Exchange, d: Draft): RequestEdit | ResponseEdit | undefined {
  return d.kind === 'request' ? computeRequestEdit(ex, d) : computeResponseEdit(ex, d);
}

export interface DraftValidation {
  errors: string[];       // hard errors: block "Resume with edits"
  json?: JsonCheck;       // set when the body is declared JSON; invalid → needs confirmation
}

export function validateDraft(d: Draft): DraftValidation {
  const errors: string[] = [];
  if (d.kind === 'request') {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(d.method.trim())) errors.push('Method must be a single HTTP token, e.g. GET');
    if (!isAbsoluteUrl(d.url.trim())) errors.push('URL must be absolute (http:// or https://)');
  } else {
    const s = Number(d.status.trim());
    if (!Number.isInteger(s) || s < 100 || s > 599) errors.push('Status must be an integer 100–599');
  }
  for (const r of d.headers) {
    if (r.name.trim() && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(r.name.trim())) errors.push(`Invalid header name “${r.name}”`);
  }
  const ct = headerValue(rowsToRecord(d.headers), 'content-type');
  const json = isJsonContentType(ct) && d.body.trim() ? validateJson(d.body) : undefined;
  return { errors, json };
}

// ---------------------------------------------------------------- edit & resend (CONTRACTS §9.3 `send`)

/** A finished exchange can be resent (not pending, not waiting at a breakpoint). */
export function canResend(ex: Pick<Exchange, 'state'>): boolean {
  return ex.state !== 'pending' && !isPaused(ex);
}

/** Why the original request body can't be reproduced as text, if it can't. */
export function unsendableBody(ex: Pick<Exchange, 'requestBody'>): string | undefined {
  const b = ex.requestBody;
  if (!b) return undefined;
  if (b.encoding === 'base64') return 'The original body is binary and can\'t be resent as text — it is not included.';
  if (b.truncated) return 'The original body was truncated at 5 MB — it is not included.';
  return undefined;
}

export function composerFromExchange(ex: Exchange): Composer {
  const bodyNote = unsendableBody(ex);
  const text = !bodyNote && ex.requestBody ? ex.requestBody.text : '';
  return {
    resentFrom: ex.id,
    draft: { kind: 'request', method: ex.method, url: ex.url, headers: headersToRows(ex.requestHeaders), body: text },
    bodyNote,
    originalBody: bodyNote ? undefined : text,
    open: true,
    sending: false,
  };
}

export function blankComposer(): Composer {
  return { draft: { kind: 'request', method: 'GET', url: 'https://', headers: [], body: '' }, open: true, sending: false };
}

/**
 * The `send` request for a composer draft. content-length is dropped whenever the body differs from the
 * original (or the original body is unknown) so a stale length never reaches the server; a Host header that
 * doesn't match the URL is dropped too.
 */
export function composeSend(c: Pick<Composer, 'draft' | 'originalBody'>): SendDraft {
  const d = c.draft;
  const req: SendDraft = { method: d.method.trim().toUpperCase(), url: d.url.trim() };
  let rows = d.headers.filter((r) => r.name.trim());
  const bodyChanged = c.originalBody === undefined || d.body !== c.originalBody;
  if (bodyChanged) rows = rows.filter((r) => r.name.trim().toLowerCase() !== 'content-length');
  // A copied Host header that no longer matches the (edited) URL would send the request to the wrong virtual host.
  let urlHost: string | undefined;
  try { urlHost = new URL(req.url).host.toLowerCase(); } catch { /* validated elsewhere */ }
  rows = rows.filter((r) => r.name.trim().toLowerCase() !== 'host' || r.value.trim().toLowerCase() === urlHost);
  if (rows.length) req.headers = rowsToRecord(rows);
  if (d.body !== '') req.body = d.body;
  return req;
}

/** One-click "Resend": the recorded request as is. undefined when its body can't be reproduced. */
export function resendRequest(ex: Exchange): SendDraft | undefined {
  if (!canResend(ex) || unsendableBody(ex)) return undefined;
  const req: SendDraft = { method: ex.method, url: ex.url };
  if (Object.keys(ex.requestHeaders).length) req.headers = ex.requestHeaders;
  if (ex.requestBody?.text) req.body = ex.requestBody.text;
  return req;
}

/** Who sent an exchange that the app didn't (list badge + detail line). */
export function initiatorLabel(ex: Pick<Exchange, 'initiator' | 'resentFrom'>): string | undefined {
  if (!ex.initiator && !ex.resentFrom) return undefined;
  const who = ex.initiator === 'agent' ? 'an AI agent' : 'the editor';
  return ex.resentFrom ? `Resent by ${who}` : `Sent by ${who}`;
}

export const SNIPPET_LABEL: Record<SnippetFormat, string> = { curl: 'cURL', dart_http: 'Dart (http)', dio: 'Dio' };
export const SNIPPET_FORMATS: readonly SnippetFormat[] = ['curl', 'dart_http', 'dio'];

// ---------------------------------------------------------------- network profile (CONTRACTS §9.3)

export type ProfileChoice = 'none' | 'offline' | NetworkPresetId | 'custom';

export const PROFILE_CHOICES: readonly { value: ProfileChoice; label: string }[] = [
  { value: 'none', label: 'No throttling' },
  { value: 'offline', label: 'Offline' },
  ...NETWORK_PRESETS.map((p) => ({ value: p.id as ProfileChoice, label: p.label })),
  { value: 'custom', label: 'Custom…' },
];

export function profileChoice(p: NetworkProfile | undefined): ProfileChoice {
  if (!p || p.kind === 'none') return 'none';
  if (p.kind === 'offline') return 'offline';
  if (p.preset && NETWORK_PRESETS.some((x) => x.id === p.preset)) return p.preset;
  return 'custom';
}

/** Profile for a non-custom choice. */
export function profileForChoice(c: Exclude<ProfileChoice, 'custom'>): NetworkProfile {
  if (c === 'none') return { kind: 'none' };
  if (c === 'offline') return { kind: 'offline' };
  return presetProfile(c);
}

export function isProfileActive(p: NetworkProfile | undefined): boolean {
  return !!p && p.kind !== 'none';
}

export function profileLabel(p: NetworkProfile | undefined): string {
  return describeProfile(p ?? { kind: 'none' });
}

export interface ThrottleFields { latencyMs: string; kbps: string; dropPct: string }
export interface ThrottleCheck {
  errors: Partial<Record<keyof ThrottleFields | 'all', string>>;
  value: { latencyMs?: number; kbps?: number; dropRate?: number };
}

const isInt = (s: string) => /^\d+$/.test(s.trim());

/** Latency 0–60 000 ms, bandwidth 1–1 000 000 kbps (empty = unlimited), failure 0–100 %. At least one set. */
export function checkThrottle(f: ThrottleFields): ThrottleCheck {
  const errors: ThrottleCheck['errors'] = {};
  const value: ThrottleCheck['value'] = {};
  const lat = f.latencyMs.trim();
  if (lat) {
    if (!isInt(lat) || +lat > 60_000) errors.latencyMs = '0–60000 ms';
    else if (+lat > 0) value.latencyMs = +lat;
  }
  const kbps = f.kbps.trim();
  if (kbps) {
    if (!isInt(kbps) || +kbps < 1 || +kbps > 1_000_000) errors.kbps = '1–1000000 kbps (empty = unlimited)';
    else value.kbps = +kbps;
  }
  const drop = f.dropPct.trim();
  if (drop) {
    const n = Number(drop);
    if (!/^\d+(\.\d+)?$/.test(drop) || n > 100) errors.dropPct = '0–100 %';
    else if (n > 0) value.dropRate = Math.round(n * 100) / 10_000;
  }
  if (!Object.keys(errors).length && !Object.keys(value).length) errors.all = 'Set a latency, a bandwidth limit or a failure rate.';
  return { errors, value };
}

export function throttleFieldsOf(v: { latencyMs?: number; kbps?: number; dropRate?: number } | undefined): ThrottleFields {
  return {
    latencyMs: v?.latencyMs ? String(v.latencyMs) : '',
    kbps: v?.kbps ? String(v.kbps) : '',
    dropPct: v?.dropRate ? String(Math.round(v.dropRate * 10_000) / 100) : '',
  };
}

export function customProfile(f: ThrottleFields): NetworkProfile | undefined {
  const c = checkThrottle(f);
  if (Object.keys(c.errors).length) return undefined;
  return { kind: 'throttle', ...c.value };
}

// ---------------------------------------------------------------- rules

export function moveRule(rules: Rule[], from: number, to: number): Rule[] {
  if (from < 0 || from >= rules.length || to < 0 || to >= rules.length || from === to) return rules;
  const out = rules.slice();
  const [r] = out.splice(from, 1);
  out.splice(to, 0, r);
  return out;
}

export function toggleRule(rules: Rule[], id: string): Rule[] {
  return rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
}

export function deleteRule(rules: Rule[], id: string): Rule[] {
  return rules.filter((r) => r.id !== id);
}

export function upsertRule(rules: Rule[], rule: Rule): Rule[] {
  const i = rules.findIndex((r) => r.id === rule.id);
  if (i < 0) return [...rules, rule];
  const out = rules.slice();
  out[i] = rule;
  return out;
}

/** Index of the rule that would handle `ex` (first enabled match wins), or -1. */
export function winningRuleIndex(rules: Rule[], ex: Pick<Exchange, 'method' | 'url'>): number {
  return rules.findIndex((r) => r.enabled && matches(r.match, ex.method, ex.url));
}

export interface RuleStat { matches: number; wins: number }

/**
 * For each rule: how many current exchanges it matches, and how many it would actually
 * handle given "first enabled match wins". matches > wins means an earlier rule shadows it.
 * Disabled rules still report `matches` (wins is 0) so the user can preview them.
 */
export function ruleStats(rules: Rule[], exchanges: Exchange[]): RuleStat[] {
  // compileMatcher is the proxy's own matcher (same module as `matches`), compiled once per rule.
  const compiled = rules.map((r) => ({ test: compileMatcher(r.match), enabled: r.enabled }));
  const stats = rules.map(() => ({ matches: 0, wins: 0 }));
  for (const ex of exchanges) {
    let won = false;
    for (let i = 0; i < compiled.length; i++) {
      const c = compiled[i];
      if (!c.test(ex.method, ex.url)) continue;
      stats[i].matches++;
      if (c.enabled && !won) { stats[i].wins++; won = true; }
    }
  }
  return stats;
}

/** How many exchanges a matcher matches (rule editor preview). */
export function countMatches(m: Rule['match'], exchanges: Exchange[]): number {
  const test = compileMatcher(m);
  let n = 0;
  for (const e of exchanges) if (test(e.method, e.url)) n++;
  return n;
}

export const FAULT_LABEL: Record<FaultKind, string> = {
  reset: 'connection reset',
  timeout: 'timeout (never answered)',
  truncate: 'truncated response',
  dns: 'DNS failure (host lookup)',
};

export function describeAction(a: RuleAction): string {
  switch (a.kind) {
    case 'mock': return `Mock ${a.status}${a.delayMs ? ` after ${a.delayMs} ms` : ''}`;
    case 'block': return a.mode === 'reset' ? 'Block (connection reset)' : `Block with ${a.status ?? 403}`;
    case 'breakpoint': return a.phase === 'both' ? 'Break on request + response' : `Break on ${a.phase}`;
    case 'throttle': return `Throttle (${describeProfile({ kind: 'throttle', latencyMs: a.latencyMs, kbps: a.kbps, dropRate: a.dropRate })})`;
    case 'fault': return `Fault: ${FAULT_LABEL[a.fault]}`;
    case 'mutate': return `Mutate: ${describeMutateOps(a.ops)}`;
  }
}

const MAX_VALUE_TEXT = 40;

const shortText = (t: string) => (t.length > MAX_VALUE_TEXT ? `${t.slice(0, MAX_VALUE_TEXT - 1)}…` : t);

/** JSON text of a `set` value, shortened for one-line labels. */
export function shortJson(v: unknown): string {
  let t: string;
  try { t = JSON.stringify(v) ?? 'undefined'; } catch { t = String(v); }
  return shortText(t);
}

/** "$.avatar_url → null", "$.id removed", "$.age = \"42\"". */
export function describeMutateOp(op: MutateOp): string {
  if (op.op === 'null') return `${op.path} → null`;
  if (op.op === 'delete') return `${op.path} removed`;
  return `${op.path} = ${op.valueJson !== undefined ? shortText(op.valueJson) : shortJson(op.value)}`;
}

/** The first two ops, then "+N more". */
export function describeMutateOps(ops: MutateOp[]): string {
  if (!ops.length) return 'no changes';
  const head = ops.slice(0, 2).map(describeMutateOp).join(', ');
  return ops.length > 2 ? `${head} +${ops.length - 2} more` : head;
}

/** How often a rule was used, judged from the exchanges listed (the proxy keeps the real count). */
export function ruleHits(rule: Pick<Rule, 'id'>, exchanges: Exchange[]): number {
  let n = 0;
  for (const e of exchanges) if (e.matchedRuleId === rule.id) n++;
  return n;
}

/** "2 of 3 left · expires in 4m 10s" for rules with `times` / `expiresAt`; undefined otherwise. */
export function ruleBudget(rule: Pick<Rule, 'times' | 'expiresAt'>, hits: number, now: number): { text: string; spent: boolean } | undefined {
  const parts: string[] = [];
  let spent = false;
  if (rule.times !== undefined) {
    const left = Math.max(0, rule.times - hits);
    if (!left) spent = true;
    parts.push(`${left} of ${rule.times} left`);
  }
  if (rule.expiresAt !== undefined) {
    const ms = rule.expiresAt - now;
    if (ms <= 0) { spent = true; parts.push('expired'); }
    else parts.push(`expires in ${formatRemaining(ms)}`);
  }
  return parts.length ? { text: parts.join(' · '), spent } : undefined;
}

export function ruleLabel(r: Rule): string {
  return r.name?.trim() || `${r.match.method ? r.match.method.toUpperCase() + ' ' : ''}${r.match.url}`;
}

/** Rules created through the Agent API are named "[agent] …" (CONTRACTS §8). */
export const AGENT_RULE_PREFIX = '[agent] ';
export function isAgentRule(r: Pick<Rule, 'name'> | undefined): boolean {
  return !!r?.name?.startsWith(AGENT_RULE_PREFIX);
}

/** Label without the "[agent] " prefix (the UI shows an agent badge instead). */
export function ruleDisplayName(r: Rule): string {
  if (!isAgentRule(r)) return ruleLabel(r);
  const rest = r.name!.slice(AGENT_RULE_PREFIX.length).trim();
  return rest || `${r.match.method ? r.match.method.toUpperCase() + ' ' : ''}${r.match.url}`;
}

export interface RuleForm {
  id: string;
  isNew: boolean;
  enabled: boolean;
  name: string;
  method: string;               // '' = any
  url: string;
  kind: RuleAction['kind'];
  mockStatus: string;
  mockHeaders: HeaderRow[];
  mockBody: string;
  mockDelayMs: string;
  blockMode: 'reset' | 'status';
  blockStatus: string;
  phase: 'request' | 'response' | 'both';
  throttle: ThrottleFields;
  fault: FaultKind;
  mutateOps: MutateRow[];
  times: string;                // '' = unlimited; 1–1000
  expiresIn: string;            // '' = never
  expiresUnit: ExpiryUnit;
  /** The rule's current expiresAt, kept as is until the user edits the "Expires in" field. */
  keepExpiresAt?: number;
}

/** One `mutate` op as the editor holds it: `value` is JSON text (used for `set` only). */
export interface MutateRow { path: string; op: MutateOp['op']; value: string }

export type ExpiryUnit = 's' | 'm' | 'h';
export const EXPIRY_UNIT_MS: Record<ExpiryUnit, number> = { s: 1000, m: 60_000, h: 3_600_000 };
export const MAX_EXPIRY_MS = 24 * 3_600_000;

export function ruleToForm(rule?: Rule, now = Date.now()): RuleForm {
  const f: RuleForm = {
    id: rule?.id ?? newId('rule'),
    isNew: !rule,
    enabled: rule?.enabled ?? true,
    name: rule?.name ?? '',
    method: rule?.match.method?.toUpperCase() ?? '',
    url: rule?.match.url ?? '',
    kind: rule?.action.kind ?? 'mock',
    mockStatus: '200',
    mockHeaders: [{ name: 'content-type', value: 'application/json' }],
    mockBody: '{\n  \n}',
    mockDelayMs: '',
    blockMode: 'reset',
    blockStatus: '403',
    phase: 'both',
    throttle: { latencyMs: '400', kbps: '', dropPct: '' },
    fault: 'reset',
    mutateOps: [{ path: '', op: 'null', value: '' }],
    times: rule?.times !== undefined ? String(rule.times) : '',
    expiresIn: '',
    expiresUnit: 'm',
  };
  if (rule?.expiresAt !== undefined) {
    f.keepExpiresAt = rule.expiresAt;
    const left = rule.expiresAt - now;
    if (left > 0) f.expiresIn = String(Math.max(1, Math.ceil(left / 60_000)));
  }
  const a = rule?.action;
  if (a?.kind === 'mock') {
    f.mockStatus = String(a.status);
    f.mockHeaders = headersToRows(a.headers);
    f.mockBody = a.body;
    f.mockDelayMs = a.delayMs ? String(a.delayMs) : '';
  } else if (a?.kind === 'block') {
    f.blockMode = a.mode;
    if (a.status !== undefined) f.blockStatus = String(a.status);
  } else if (a?.kind === 'breakpoint') {
    f.phase = a.phase;
  } else if (a?.kind === 'throttle') {
    f.throttle = throttleFieldsOf(a);
  } else if (a?.kind === 'fault') {
    f.fault = a.fault;
  } else if (a?.kind === 'mutate') {
    // valueJson (byte-exact text) wins over value, like on the proxy.
    f.mutateOps = a.ops.map((o) => ({ path: o.path, op: o.op, value: o.op === 'set' ? o.valueJson ?? jsonText(o.value) : '' }));
  }
  return f;
}

export type RuleFormField =
  | 'url' | 'method' | 'mockStatus' | 'mockDelayMs' | 'blockStatus' | 'mockHeaders'
  | 'latencyMs' | 'kbps' | 'dropPct' | 'throttle' | 'times' | 'expiresIn' | 'mutate';

export interface RuleFormValidation {
  errors: Partial<Record<RuleFormField, string>>;
  urlHint: string;
  json?: JsonCheck;
  /** Per mutate row: what is wrong with it (path or value), if anything. */
  opErrors?: (string | undefined)[];
}

const isStatus = (s: string) => /^\d{3}$/.test(s.trim()) && +s >= 100 && +s <= 599;

export function validateRuleForm(f: RuleForm): RuleFormValidation {
  const errors: RuleFormValidation['errors'] = {};
  let urlHint = 'Glob on the full URL — * matches any characters, e.g. https://api.example.com/users/*';
  const url = f.url.trim();
  if (!url) errors.url = 'Required. Use * to match every URL.';
  else {
    const p = describeMatcherUrl(url);
    if (p.kind === 'any') urlHint = 'Matches every URL.';
    else if (p.kind === 'regex') {
      if (p.error) errors.url = `Invalid regular expression: ${p.error}`;
      else urlHint = `Regular expression /${p.source}/${p.flags} tested against the full URL (g/y flags ignored)`;
    } else if (!url.includes('*') && !/^https?:\/\//i.test(url)) {
      urlHint = 'Glob without * must equal the full URL (scheme included). Add * to match a prefix or part.';
    } else {
      urlHint = 'Case-sensitive glob on the full URL — * matches any characters, including /.';
    }
  }
  if (f.method.trim() && !/^[A-Za-z]+$/.test(f.method.trim())) errors.method = 'Letters only, e.g. GET';
  let json: JsonCheck | undefined;
  if (f.kind === 'mock') {
    if (!isStatus(f.mockStatus)) errors.mockStatus = '100–599';
    if (f.mockDelayMs.trim() && !/^\d+$/.test(f.mockDelayMs.trim())) errors.mockDelayMs = 'Milliseconds, whole number';
    if (f.mockHeaders.some((r) => r.name.trim() && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(r.name.trim()))) {
      errors.mockHeaders = 'Invalid header name';
    }
    const ct = headerValue(rowsToRecord(f.mockHeaders), 'content-type');
    if (isJsonContentType(ct) && f.mockBody.trim()) json = validateJson(f.mockBody);
  } else if (f.kind === 'block' && f.blockMode === 'status' && !isStatus(f.blockStatus)) {
    errors.blockStatus = '100–599';
  } else if (f.kind === 'throttle') {
    const t = checkThrottle(f.throttle);
    if (t.errors.latencyMs) errors.latencyMs = t.errors.latencyMs;
    if (t.errors.kbps) errors.kbps = t.errors.kbps;
    if (t.errors.dropPct) errors.dropPct = t.errors.dropPct;
    if (t.errors.all) errors.throttle = t.errors.all;
  }
  let opErrors: (string | undefined)[] | undefined;
  if (f.kind === 'mutate') {
    opErrors = f.mutateOps.map(mutateRowError);
    const first = opErrors.findIndex(Boolean);
    if (!f.mutateOps.length) errors.mutate = 'Add at least one change.';
    else if (first >= 0) errors.mutate = `Change ${first + 1}: ${opErrors[first]}`;
  }
  const times = f.times.trim();
  if (times && (!isInt(times) || +times < 1 || +times > 1000)) errors.times = 'Whole number 1–1000 (empty = every request)';
  const exp = f.expiresIn.trim();
  if (exp && f.keepExpiresAt === undefined) {
    const ms = Number(exp) * EXPIRY_UNIT_MS[f.expiresUnit];
    if (!/^\d+(\.\d+)?$/.test(exp) || !(ms >= 1000) || ms > MAX_EXPIRY_MS) errors.expiresIn = 'Between 1 second and 24 hours (empty = never)';
  }
  return { errors, urlHint, json, opErrors };
}

/** Why a mutate row can't be saved, if it can't. */
export function mutateRowError(r: MutateRow): string | undefined {
  const p = checkPath(r.path);
  if (p) return `Path: ${p}`;
  if (r.op === 'set') {
    if (!r.value.trim()) return 'Value: enter JSON, e.g. "text", 42, null, {"a":1}';
    const j = validateJson(r.value);
    if (!j.ok) return `Value is not valid JSON (column ${j.column}): ${j.message}`;
  }
  return undefined;
}

/** JSON text for an editor field. */
export function jsonText(v: unknown): string {
  try { return JSON.stringify(v) ?? ''; } catch { return ''; }
}

export function formToRule(f: RuleForm, now = Date.now()): Rule {
  let action: RuleAction;
  if (f.kind === 'mock') {
    const headers = rowsToFlatRecord(f.mockHeaders);
    action = { kind: 'mock', status: Number(f.mockStatus), body: f.mockBody };
    if (Object.keys(headers).length) action.headers = headers;
    if (f.mockDelayMs.trim() && Number(f.mockDelayMs) > 0) action.delayMs = Number(f.mockDelayMs);
  } else if (f.kind === 'block') {
    action = f.blockMode === 'reset' ? { kind: 'block', mode: 'reset' } : { kind: 'block', mode: 'status', status: Number(f.blockStatus) };
  } else if (f.kind === 'throttle') {
    action = { kind: 'throttle', ...checkThrottle(f.throttle).value };
  } else if (f.kind === 'fault') {
    action = { kind: 'fault', fault: f.fault };
  } else if (f.kind === 'mutate') {
    action = {
      kind: 'mutate',
      // valueJson keeps the literal text (1.0 stays a double for Dart); value is for hosts without valueJson.
      ops: f.mutateOps.map((r): MutateOp => (r.op === 'set'
        ? { path: r.path.trim(), op: 'set', value: JSON.parse(r.value), valueJson: r.value.trim() }
        : { path: r.path.trim(), op: r.op })),
    };
  } else {
    action = { kind: 'breakpoint', phase: f.phase };
  }
  const rule: Rule = { id: f.id, enabled: f.enabled, match: { url: f.url.trim() }, action };
  if (f.name.trim()) rule.name = f.name.trim();
  if (f.method.trim()) rule.match.method = f.method.trim().toUpperCase();
  if (f.times.trim()) rule.times = Number(f.times.trim());
  if (f.keepExpiresAt !== undefined) rule.expiresAt = f.keepExpiresAt;
  else if (f.expiresIn.trim()) rule.expiresAt = now + Math.round(Number(f.expiresIn.trim()) * EXPIRY_UNIT_MS[f.expiresUnit]);
  return rule;
}
