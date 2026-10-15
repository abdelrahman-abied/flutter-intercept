/** Applying host messages (CONTRACTS §4) to the state. Split out of ../state.ts (QUALITY-1 Q6). */
import { EXPORT_LABEL } from '../exporting';
import { hasMessagesTab } from '../frames';
import { type GrpcDecodeEntry, grpcPauseKey } from '../grpc';
import type { Exchange, HostMsg, Status } from '../protocol';
import { sortRecordings } from '../scenarios';
import { isPaused } from '../util';
import { type Draft, EMPTY_FILTERS, MAX_HOST_ERRORS, NEW_RULE, type State } from './core';
import { draftKindFor } from './drafts';
import { filterExchanges, findExchange } from './filtering';
import { hideComposer, nextErrorId, notice, omit, pick, tabFor, tabForSelect } from './internal';
import { describeAction, ruleLabel } from './rules';

/** Dismissed ids the host no longer reports are forgotten (the list can't grow without bound). */
export function pruneDismissed(dismissed: string[], status: Status): string[] {
  if (!dismissed.length) return dismissed;
  const live = new Set((status.warnings ?? []).map((w) => w.id));
  const kept = dismissed.filter((id) => live.has(id));
  return kept.length === dismissed.length ? dismissed : kept;
}

/** Warnings to show as banners: reported by the host and not dismissed. */
export function visibleWarnings(state: Pick<State, 'status' | 'dismissedWarnings'>): NonNullable<Status['warnings']> {
  const w = state.status.warnings ?? [];
  if (!w.length || !state.dismissedWarnings.length) return w;
  return w.filter((x) => !state.dismissedWarnings.includes(x.id));
}


/** Select `id` (a request the host just sent) and close the composer that sent it. */
function selectSent(state: State, id: string): State {
  const composer = state.composer?.sending ? undefined : state.composer;
  if (!state.exchanges.some((e) => e.id === id)) return { ...state, pendingSelectId: id, composer };
  return { ...state, pendingSelectId: undefined, selectedId: id, detailTab: 'response', view: 'traffic', composer };
}

export function applyHostMsg(state: State, msg: HostMsg): State {
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
        dismissedWarnings: pruneDismissed(state.dismissedWarnings, msg.status),
        drafts: pruneDrafts(state.drafts, byId),
        resolving: {},
        gaveUp: pick(state.gaveUp, byId),
        contracts: pick(state.contracts, byId),
        grpcDecoded: pick(state.grpcDecoded, byId),
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
        if (next.detailTab === 'messages' && !hasMessagesTab(byId.get(next.selectedId)!)) next.detailTab = 'response';
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
      // A gRPC call pauses again in the same phase (the next message): a new pause unlocks the editor too.
      if (state.resolving[ex.id] && (!isPaused(ex) || idx < 0 || state.exchanges[idx].state !== ex.state
        || grpcPauseKey(state.exchanges[idx]) !== grpcPauseKey(ex))) {
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
          } else if (state.awaitingRule.kind === 'mock' || state.awaitingRule.kind === 'grpcMock') {
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
      return { ...state, status: msg.status, dismissedWarnings: pruneDismissed(state.dismissedWarnings, msg.status) };

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
        grpcDecoded: drop(state.grpcDecoded),
        selectedId: state.selectedId && gone.has(state.selectedId) ? undefined : state.selectedId,
      };
    }

    case 'error':
      // Non-blocking. Unlock any "Sent — waiting…" editor: a rejected resume leaves the exchange paused.
      return {
        ...state,
        hostErrors: [...state.hostErrors, { id: nextErrorId(), message: msg.message }].slice(-MAX_HOST_ERRORS),
        resolving: {},
        composer: state.composer?.sending ? { ...state.composer, sending: false } : state.composer,
        // e.g. "Adding client certificates isn't available here.": the popup stops waiting (and shows it inline).
        certDialog: state.certDialog && (state.certDialog.saving || state.certDialog.picking)
          ? { ...state.certDialog, saving: undefined, picking: undefined, problem: msg.message }
          : state.certDialog,
      };

    case 'cleared':
      return { ...state, exchanges: [], drafts: {}, resolving: {}, gaveUp: {}, contracts: {}, authFlows: [], grpcDecoded: {}, selectedId: undefined };

    case 'recordings': {
      const recordings = sortRecordings(msg.recordings);
      const picks = state.recordingPicks.filter((id) => recordings.some((r) => r.id === id));
      return { ...state, recordings, recordingPicks: picks.length === state.recordingPicks.length ? state.recordingPicks : picks };
    }

    case 'authFlows':
      return { ...state, authFlows: msg.flows };

    case 'select':
      return revealExchange(state, msg.id);

    case 'exported':
      return { ...state, notice: notice(`Exported ${EXPORT_LABEL[msg.format] ?? msg.format} to ${msg.path}`) };

    case 'clientCertificateFile': {
      // CONTRACTS §20.3: only the popup that asked uses the token (a late answer after Cancel is dropped; it expires).
      const d = state.certDialog;
      if (!d || d.picking !== msg.role) return state;
      if (msg.file) return { ...state, certDialog: { ...d, picking: undefined, problem: undefined, files: { ...d.files, [msg.role]: msg.file } } };
      return { ...state, certDialog: { ...d, picking: undefined, problem: msg.problem } }; // no file, no problem = cancelled
    }

    case 'clientCertificateSaved': {
      const d = state.certDialog;
      const ours = !!d?.saving && d.saving.toLowerCase() === msg.host.toLowerCase();
      if (msg.problem) {
        // The popup stays open with the problem inline; with no popup waiting, it is a notice.
        if (ours) return { ...state, certDialog: { ...d!, saving: undefined, problem: msg.problem } };
        return { ...state, notice: notice(`Client certificate for ${msg.host} not saved: ${msg.problem}`) };
      }
      return {
        ...state,
        certDialog: ours ? undefined : d,
        notice: notice(`Client certificate saved for ${msg.host}. New connections to it are decrypted and shown.`),
      };
    }

    case 'grpcDecoded': {
      // Answers are kept only for exchanges still listed; the answer is for the version last asked for.
      if (!findExchange(state, msg.id)) return state;
      const prev = state.grpcDecoded[msg.id];
      const entry: GrpcDecodeEntry = prev
        ? { ...prev, decoded: msg.decoded, answeredKey: prev.key, answeredBase: prev.base }
        : { key: '', base: 0, requestedAt: 0, decoded: msg.decoded, answeredKey: '', answeredBase: 0 };
      return { ...state, grpcDecoded: { ...state.grpcDecoded, [msg.id]: entry } };
    }
  }
}

/**
 * CONTRACTS §13.6 `select` (a notification's "Show"): open the traffic view on that exchange with its details. Filters
 * that hide it are cleared (with a note); an exchange no longer listed gets a note instead.
 */
function revealExchange(state: State, id: string): State {
  const ex = findExchange(state, id);
  if (!ex) return { ...state, notice: notice('That request is no longer listed (cleared, or dropped from the history).') };
  const visible = filterExchanges(state.exchanges, state.filters, state.contracts).some((e) => e.id === id);
  const next: State = {
    ...state,
    view: 'traffic',
    selectedId: ex.id,
    detailTab: tabForSelect(ex, state.detailTab),
    composer: hideComposer(state.composer),
    revealSeq: state.revealSeq + 1,
  };
  if (!visible) {
    next.filters = { ...EMPTY_FILTERS, showBrowser: state.filters.showBrowser || !!ex.browserInternal };
    next.notice = notice('Filters cleared to show the request.', undefined, true);
  }
  return next;
}



/**
 * The app closed the connection while this exchange sat at a breakpoint (usually its own
 * receive/connect timeout). The proxy records it as 'error' and ignores any late resume.
 */
export function clientGaveUp(state: Pick<State, 'gaveUp'>, ex: Exchange): boolean {
  if (ex.state !== 'error') return false;
  return !!state.gaveUp[ex.id] || /closed the connection while .* paused/i.test(ex.error ?? '');
}

export function pruneDrafts(drafts: Record<string, Draft>, byId: Map<string, Exchange>): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const [id, d] of Object.entries(drafts)) {
    const ex = byId.get(id);
    if (ex && draftKindFor(ex) === d.kind) out[id] = d;
  }
  return out;
}
