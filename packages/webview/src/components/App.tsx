import { useEffect, useMemo, useReducer, useRef } from 'preact/hooks';
import { AppContext, useApp } from '../context';
import type { Host } from '../host';
import type { HostMsg, Status } from '../protocol';
import { agentLine } from '../util';
import { FALLBACK_LABEL, pendingApprovalText, INSECURE_TITLE, SHARED_FILE, UPSTREAM_TITLE } from '../scenarios';
import {
  filterExchanges, findExchange, hasActiveFilters, hiddenBrowserCount, initialState, isProfileActive, pausedCount, profileLabel, reducer,
  toPersisted, visibleWarnings, type Persisted, type State,
} from '../state';
import { Button, useNow } from './bits';
import { DetailPane } from './DetailPane';
import { Composer } from './Editors';
import { Icon } from './Icon';
import { AuthFlowsView } from './AuthFlowsView';
import { RecordingsView } from './RecordingsView';
import { RulesView } from './RulesView';
import { Toolbar } from './Toolbar';
import { TrafficList } from './TrafficList';

const NOTICE_MS = 8000;
const SHORT_NOTICE_MS = 2500;
const PERSIST_MS = 300;
const LAN_TITLE =
  'A physical iPhone can\'t reach this Mac\'s loopback, so the proxy also listens on this LAN address while an ' +
  'iPhone debug session runs. It only accepts the app that holds this session\'s secret token (anything else gets ' +
  '407), and it closes when the last iPhone session ends. Everything else stays on 127.0.0.1.';

function init(host: Host): State {
  const s = initialState();
  let persisted: Persisted | undefined;
  try { persisted = host.getState<Persisted>(); } catch { /* ignore */ }
  return persisted ? reducer(s, { type: 'restore', persisted }) : s;
}

export function App({ host }: { host: Host }) {
  const [state, dispatch] = useReducer(reducer, host, init);

  // Host messages are batched per task tick so a burst of 'exchange' updates renders once.
  useEffect(() => {
    let queue: HostMsg[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const msgs = queue;
      queue = [];
      if (msgs.length) dispatch({ type: 'host', msgs });
    };
    const off = host.onMessage((m) => {
      queue.push(m);
      if (timer === undefined) timer = setTimeout(flush, 0);
    });
    host.post({ type: 'ready' });
    return () => { off(); if (timer !== undefined) clearTimeout(timer); };
  }, [host]);

  const { filters, view, detailTab, selectedId, splitPct, drafts, editingRuleId, composer, dismissedWarnings } = state;
  // Debounced: drafts can hold multi-MB bodies and change on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      try { host.setState(toPersisted(state)); } catch { /* state too large etc. — non-critical */ }
    }, PERSIST_MS);
    return () => clearTimeout(t);
  }, [filters, view, detailTab, selectedId, splitPct, drafts, editingRuleId, composer, dismissedWarnings]);

  const ctx = useMemo(() => ({ state, dispatch, post: host.post }), [state, host]);

  return (
    <AppContext.Provider value={ctx}>
      <div class="app">
        <Toolbar />
        <HostErrorBar />
        <NoticeBar />
        <ReplayBar />
        <SharedRulesBanner />
        <WarningsBar />
        <main class="content">
          {state.view === 'traffic' ? <TrafficView />
            : state.view === 'rules' ? <RulesView />
            : state.view === 'recordings' ? <RecordingsView />
            : <AuthFlowsView />}
        </main>
        <StatusLine />
      </div>
    </AppContext.Provider>
  );
}

function TrafficView() {
  const { state, dispatch } = useApp();
  const list = useMemo(() => filterExchanges(state.exchanges, state.filters, state.contracts), [state.exchanges, state.filters, state.contracts]);
  const selected = state.selectedId ? findExchange(state, state.selectedId) : undefined;
  const composing = !!state.composer?.open;
  const detailRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  if (!state.exchanges.length && !composing) return <EmptyState />;

  const startDrag = (e: PointerEvent) => {
    const root = rootRef.current;
    if (!root) return;
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    const vertical = getComputedStyle(root).flexDirection === 'column';
    const onMove = (ev: PointerEvent) => {
      const pct = vertical
        ? ((ev.clientY - rect.top) / rect.height) * 100
        : ((ev.clientX - rect.left) / rect.width) * 100;
      dispatch({ type: 'setSplit', pct });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    // --split is set through CSSOM (Preact assigns style objects via element.style),
    // which a strict style-src CSP allows; no style="" attributes are ever parsed.
    <div ref={rootRef} class={`traffic${selected || composing ? ' has-detail' : ''}`} style={{ '--split': `${state.splitPct}%` }}>
      <div class="list-pane">
        {list.length ? (
          <TrafficList list={list} onOpen={() => detailRef.current?.focus()} />
        ) : (
          <EmptyList />
        )}
      </div>
      {(selected || composing) && (
        <>
          <div class="splitter" role="separator" aria-orientation="vertical" aria-valuenow={Math.round(state.splitPct)}
            aria-valuemin={20} aria-valuemax={80} aria-label="Resize list and details" tabIndex={0}
            title="Drag (or focus and use arrow keys) to resize" onPointerDown={startDrag}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -5 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 5 : 0;
              if (d) { e.preventDefault(); dispatch({ type: 'setSplit', pct: state.splitPct + d }); }
            }} />
          {composing ? <Composer /> : <DetailPane ex={selected!} paneRef={detailRef} />}
        </>
      )}
    </div>
  );
}

function EmptyList() {
  const { state, dispatch } = useApp();
  const hidden = hiddenBrowserCount(state.exchanges, state.filters);
  const filtered = hasActiveFilters(state.filters);
  return (
    <div class="empty small">
      <p>
        {filtered ? 'No exchanges match the filters.' : 'Only browser traffic so far.'}
        {hidden > 0 && ` ${hidden} browser-internal exchange${hidden === 1 ? ' is' : 's are'} hidden.`}
      </p>
      {filtered && <Button onClick={() => dispatch({ type: 'clearFilters' })}>Clear filters</Button>}
      {hidden > 0 && <Button onClick={() => dispatch({ type: 'setFilters', patch: { showBrowser: true } })}>Show browser traffic</Button>}
    </div>
  );
}

function EmptyState() {
  const { state } = useApp();
  const { status, connected } = state;
  return (
    <div class="empty">
      <h2>No traffic yet</h2>
      <p class="lead">Press <kbd>F5</kbd> to run your Flutter app — traffic appears here.</p>
      <p class="muted">
        No code changes needed: Flutter Intercept routes the app's <code>dart:io</code> HTTP (Dio, http, HttpClient) through
        a local proxy while you debug.
      </p>
      <p class="muted">
        {!connected
          ? 'Connecting to the extension…'
          : status.proxyRunning
            ? `Proxy listening on port ${status.port ?? '?'} · ${status.sessions} debug session${status.sessions === 1 ? '' : 's'}.`
            : 'The proxy starts with your first Flutter debug session.'}
      </p>
      {connected && !status.interceptEnabled && (
        <p class="msg warn">Interception is off — turn it on in the toolbar, then restart the app (F5).</p>
      )}
    </div>
  );
}

function StatusLine() {
  const { state } = useApp();
  const { status, exchanges, filters, connected, contracts } = state;
  const shown = useMemo(() => filterExchanges(exchanges, filters, contracts).length, [exchanges, filters, contracts]);
  const paused = pausedCount(exchanges);
  return (
    <footer class="statusline" role="status" aria-live="polite">
      <span class={`dot ${status.proxyRunning ? 'running' : 'stopped'}`} aria-hidden="true" />
      <span>{!connected ? 'Connecting…' : status.proxyRunning ? `Proxy :${status.port ?? '?'}` : 'Proxy stopped'}</span>
      <span>{status.sessions} session{status.sessions === 1 ? '' : 's'}</span>
      <span>Intercept {status.interceptEnabled ? 'on' : 'off'}</span>
      <span>
        {exchanges.length} exchange{exchanges.length === 1 ? '' : 's'}
        {hasActiveFilters(filters) || shown !== exchanges.length ? ` (${shown} shown)` : ''}
      </span>
      {paused > 0 && <span class="warn-text">{paused} paused</span>}
      {isProfileActive(status.networkProfile) && (
        <span class="net-status" title="Network profile applied to everything this app sends through the proxy. Change it in the toolbar.">
          Network: {profileLabel(status.networkProfile)}
        </span>
      )}
      {status.lan && (
        <span class="lan-open" title={LAN_TITLE}>
          LAN open for iPhone · {status.lan.host}:{status.lan.port}
        </span>
      )}
      {status.upstreamProxy && (
        <span class="upstream-status" title={UPSTREAM_TITLE(status.upstreamProxy)}>
          via upstream proxy {status.upstreamProxy}
          {status.upstreamProxyInsecure && <span class="insecure" title={INSECURE_TITLE}> · certificate checks OFF</span>}
        </span>
      )}
      {status.replay && (
        <span class="replay-status" title={`Answering requests from the recording “${status.replay.recording}”; unmatched requests ${FALLBACK_LABEL[status.replay.fallback]}.`}>
          Replaying {status.replay.recording}
        </span>
      )}
      {status.agent && <AgentStatusItem agent={status.agent} />}
    </footer>
  );
}

function AgentStatusItem({ agent }: { agent: NonNullable<Status['agent']> }) {
  const now = useNow(!!agent.lastCall);
  const line = agentLine(agent, now);
  return <span class={`agent-status agent-${line.kind}`} title={line.title}>{line.text}</span>;
}

function NoticeBar() {
  const { state, dispatch, post } = useApp();
  const n = state.notice;
  useEffect(() => {
    if (!n) return;
    const t = setTimeout(() => dispatch({ type: 'notice' }), n.short ? SHORT_NOTICE_MS : NOTICE_MS);
    return () => clearTimeout(t);
  }, [n?.id]);
  if (!n) return null;
  return (
    <div class="notice" role="status">
      <span>{n.text}</span>
      {n.undoRules && (
        <button type="button" class="link" onClick={() => {
          dispatch({ type: 'setRules', rules: n.undoRules! });
          post({ type: 'setRules', rules: n.undoRules! });
          dispatch({ type: 'notice' });
        }}>Undo</button>
      )}
      <span class="spacer" />
      <Button kind="icon" title="Dismiss" onClick={() => dispatch({ type: 'notice' })}><Icon name="close" /></Button>
    </div>
  );
}

const WARNING_TITLE: Record<string, string> = {
  'background-isolate': 'HttpOverrides is set per isolate: requests made from a background isolate (compute(), Isolate.run, a worker) bypass the proxy.',
  'native-client': 'Native HTTP clients (cupertino_http, cronet_http, ok_http) don\'t use dart:io, so they bypass the proxy. Their requests are shown from the app\'s HTTP profile, read-only.',
  'web': 'Flutter Web: the browser talks to the proxy directly.',
};

/** CONTRACTS §11: session warnings (background isolates, native clients, web), dismissable per id. */
function WarningsBar() {
  const { state, dispatch } = useApp();
  const list = visibleWarnings(state);
  if (!list.length) return null;
  return (
    <div class="warnings" role="status" aria-label="Session warnings">
      {list.map((w) => (
        <div key={w.id} class={`warning-banner wk-${w.kind}`} title={WARNING_TITLE[w.kind]}>
          <span class="warning-icon" aria-hidden="true">⚠</span>
          <span class="warning-text">{w.text}</span>
          <span class="spacer" />
          <Button kind="icon" title="Dismiss this warning" onClick={() => dispatch({ type: 'dismissWarning', id: w.id })}><Icon name="close" /></Button>
        </div>
      ))}
    </div>
  );
}

/** CONTRACTS §12.4: replay mode is easy to forget — a clear bar with Stop while it is on. */
export function ReplayBar() {
  const { state, post } = useApp();
  const r = state.status.replay;
  if (!r) return null;
  return (
    <div class="replay-bar" role="status" aria-label="Replay">
      <Icon name="play" />
      <span class="replay-text">
        <strong>Replaying “{r.recording}”</strong> — matching requests are answered from the recording (rules still win);
        unmatched requests {FALLBACK_LABEL[r.fallback]}.
      </span>
      <span class="spacer" />
      <Button kind="primary" title="Stop replaying: requests go to the real server again" onClick={() => post({ type: 'replayRecording' })}>
        <Icon name="stop" /> Stop replay
      </Button>
    </div>
  );
}

/**
 * CONTRACTS §12.1 approval gate: shared rules that map traffic to another host or set request headers are held
 * back until the user approves this file content. Approving asks once more, naming the file.
 */
export function SharedRulesBanner() {
  const { state, post } = useApp();
  const sr = state.status.sharedRules;
  if (!sr || sr.pendingApproval <= 0) return null;
  const file = sr.file ?? SHARED_FILE;
  return (
    <div class="approval-banner" role="alert" aria-label="Shared rules awaiting approval">
      <div class="approval-line">
        <span class="warning-icon" aria-hidden="true">⚠</span>
        <span class="approval-text">{pendingApprovalText(sr)}</span>
        <span class="spacer" />
        <Button onClick={() => post({ type: 'openSharedRules' })} title={`Open ${file} in the editor`}>Review file</Button>
        <Button kind="primary" onClick={() => post({ type: 'approveSharedRules' })}
          title={`Run the held-back rules for this content of ${file} (VS Code asks to confirm; a later change to the file asks again)`}>
          Approve…
        </Button>
      </div>
      {sr.pending && sr.pending.length > 0 && (
        <ul class="approval-list" aria-label="Held-back rules">
          {sr.pending.map((p, i) => <li key={i}><strong>{p.name}</strong> — {p.reason}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Host-reported errors (e.g. a rejected edit): shown, never blocking. */
function HostErrorBar() {
  const { state, dispatch } = useApp();
  const errs = state.hostErrors;
  if (!errs.length) return null;
  const last = errs[errs.length - 1];
  return (
    <div class="host-error" role="alert">
      <span class="host-error-text">{last.message}</span>
      {errs.length > 1 && <span class="muted">(+{errs.length - 1} earlier)</span>}
      <span class="spacer" />
      <Button kind="icon" title="Dismiss errors" onClick={() => dispatch({ type: 'dismissErrors' })}><Icon name="close" /></Button>
    </div>
  );
}
