/** The reducer: UI actions (host messages are applied by ./hostMsg). Split out of ../state.ts (QUALITY-1 Q6). */
import { togglePick } from '../scenarios';
import { isPaused } from '../util';
import { blankComposer, composerFromExchange } from './composer';
import { type Action, DETAIL_TABS, type Draft, EMPTY_FILTERS, NEW_RULE, type State, VIEWS } from './core';
import { currentDraft } from './drafts';
import { filterExchanges, findExchange } from './filtering';
import { applyHostMsg } from './hostMsg';
import { hideComposer, notice, omit, tabFor, tabForSelect } from './internal';

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
        view: p.view && VIEWS.includes(p.view) ? p.view : state.view,
        detailTab: p.detailTab && DETAIL_TABS.includes(p.detailTab) ? p.detailTab : state.detailTab,
        selectedId: p.selectedId ?? state.selectedId,
        splitPct: p.splitPct ?? state.splitPct,
        drafts: p.drafts ?? state.drafts,
        editingRuleId: p.editingRuleId ?? state.editingRuleId,
        composer: p.composer ? { ...p.composer, sending: false } : state.composer,
        dismissedWarnings: Array.isArray(p.dismissedWarnings) ? p.dismissedWarnings.filter((x) => typeof x === 'string') : state.dismissedWarnings,
        showWaterfall: typeof p.showWaterfall === 'boolean' ? p.showWaterfall : state.showWaterfall,
      };
    }

    case 'select': {
      const ex = action.id ? findExchange(state, action.id) : undefined;
      return { ...state, selectedId: ex?.id, detailTab: tabForSelect(ex, state.detailTab), composer: hideComposer(state.composer) };
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
      return { ...state, selectedId: ex.id, detailTab: tabForSelect(ex, state.detailTab), composer: hideComposer(state.composer) };
    }

    case 'setFilters':
      return { ...state, filters: { ...state.filters, ...action.patch } };

    case 'toggleStatusClass': {
      const cur = state.filters.statusClasses;
      const statusClasses = cur.includes(action.cls) ? cur.filter((c) => c !== action.cls) : [...cur, action.cls];
      return { ...state, filters: { ...state.filters, statusClasses } };
    }

    case 'clearFilters':
      // "Show browser traffic" is a view preference, not a filter: it survives clearing.
      return { ...state, filters: { ...EMPTY_FILTERS, showBrowser: state.filters.showBrowser } };

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
        filters: visible ? state.filters : { ...EMPTY_FILTERS, pausedOnly: true, showBrowser: state.filters.showBrowser || !!ex.browserInternal },
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
      return { ...state, editingRuleId: action.id, view: action.id ? 'rules' : state.view, ruleTemplate: undefined };

    case 'newRuleFrom':
      return { ...state, editingRuleId: NEW_RULE, view: 'rules', ruleTemplate: action.rule };

    case 'patchGrpcComposer':
      if (!state.composer?.grpc) return state;
      return { ...state, composer: { ...state.composer, grpc: { ...state.composer.grpc, ...action.patch } } };

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
      return { ...state, view: 'traffic', composer: ex ? composerFromExchange(ex, state.grpcDecoded[ex.id]) : blankComposer() };
    }

    case 'patchComposer':
      if (!state.composer) return state;
      return { ...state, composer: { ...state.composer, draft: { ...state.composer.draft, ...action.patch } } };

    case 'closeComposer':
      return { ...state, composer: action.discard ? undefined : hideComposer(state.composer) };

    case 'composerSending':
      return state.composer ? { ...state, composer: { ...state.composer, sending: true } } : state;

    case 'dismissWarning':
      if (state.dismissedWarnings.includes(action.id)) return state;
      return { ...state, dismissedWarnings: [...state.dismissedWarnings, action.id] };

    case 'pickRecording':
      if (!state.recordings.some((r) => r.id === action.id)) return state;
      return { ...state, recordingPicks: togglePick(state.recordingPicks, action.id) };

    case 'clearRecordingPicks':
      return state.recordingPicks.length ? { ...state, recordingPicks: [] } : state;

    case 'toggleWaterfall':
      return { ...state, showWaterfall: !state.showWaterfall };

    case 'openCertDialog':
      return { ...state, certDialog: { id: (state.certDialog?.id ?? 0) + 1, host: action.host, files: {} } };

    case 'closeCertDialog':
      return state.certDialog ? { ...state, certDialog: undefined } : state;

    case 'certPicking':
      return state.certDialog ? { ...state, certDialog: { ...state.certDialog, picking: action.role, problem: undefined } } : state;

    case 'certSaving':
      return state.certDialog ? { ...state, certDialog: { ...state.certDialog, saving: action.host, problem: undefined } } : state;

    case 'grpcRequested': {
      const prev = state.grpcDecoded[action.id];
      return {
        ...state,
        // The previous answer stays on screen until the new one arrives.
        grpcDecoded: { ...state.grpcDecoded, [action.id]: { ...prev, key: action.key, base: action.base, requestedAt: action.at } },
      };
    }
  }
}
