// CONTRACTS §12.3: token-refresh flows the host found (401 → refresh → retry), with stampede warnings.
import { useApp } from '../context';
import type { AuthFlowSummary } from '../protocol';
import { flowRows, flowTitle, ROLE_LABEL, STAMPEDE_HINT, stampedeText } from '../scenarios';
import { findExchange } from '../state';
import { formatDuration, formatTime, splitUrl } from '../util';
import { StatusText } from './bits';

export function AuthFlowsView() {
  const { state } = useApp();
  const flows = state.authFlows;
  return (
    <div class="auth-view">
      <div class="rules-head">
        <span class="muted">
          How the app handles an expired token: the 401, the refresh call(s), and the retried request. Use “Expire token”
          on a request in Traffic to trigger one.
        </span>
      </div>
      {flows.length === 0 ? (
        <div class="empty small">
          <p>No token refresh seen yet.</p>
          <p class="muted">
            Select an authenticated request in Traffic and use “Expire token…”: its next call gets a 401, and the
            app's refresh and retry show up here.
          </p>
        </div>
      ) : (
        <ol class="auth-flows" aria-label="Auth flows">
          {flows.slice().reverse().map((f, i) => <FlowCard key={flows.length - i} flow={f} />)}
        </ol>
      )}
    </div>
  );
}

function FlowCard({ flow }: { flow: AuthFlowSummary }) {
  const { state, dispatch } = useApp();
  const find = (id: string) => findExchange(state, id);
  const rows = flowRows(flow, find);
  const first = rows.find((r) => r.ex)?.ex;
  const open = (id: string) => {
    dispatch({ type: 'setView', view: 'traffic' });
    dispatch({ type: 'select', id });
  };
  const bad = !!(flow.stampede || flow.problem);
  return (
    <li class={`auth-flow${bad ? ' has-problem' : ''}`}>
      <div class="af-head">
        <strong>{flowTitle(flow, find)}</strong>
        {first && <span class="muted">{formatTime(first.startedAt).slice(0, 8)}</span>}
        {flow.stampede && <span class="badge warn stampede-badge">stampede</span>}
        {!bad && <span class="badge ok-badge">ok</span>}
      </div>
      {flow.stampede && (
        <div class="msg warn stampede" role="note">
          <strong>⚠ {stampedeText(flow.stampede)}.</strong> {STAMPEDE_HINT}
        </div>
      )}
      {flow.problem && <div class="msg error af-problem">{flow.problem}</div>}
      <ol class="af-steps" aria-label="Timeline">
        {rows.map((r, i) => (
          <li key={i} class={`af-step role-${r.role}`}>
            <span class={`badge af-role role-${r.role}`}>{ROLE_LABEL[r.role]}</span>
            {r.ex ? (
              <button type="button" class="af-link" title={`Show ${r.ex.method} ${r.ex.url} in Traffic`} onClick={() => open(r.exchangeId)}>
                <span class="method">{r.ex.method}</span>
                <StatusText ex={r.ex} />
                <span class="af-path">{splitUrl(r.ex.url).path}</span>
                <span class="af-time muted">{r.offsetMs ? `+${formatDuration(r.offsetMs)}` : '0'}</span>
              </button>
            ) : (
              <span class="muted">exchange no longer listed</span>
            )}
          </li>
        ))}
      </ol>
    </li>
  );
}
