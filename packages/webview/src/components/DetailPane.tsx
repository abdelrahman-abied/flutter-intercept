import type { Ref } from 'preact';
import { useApp } from '../context';
import type { Exchange, RuleAction } from '../protocol';
import { clientGaveUp, describeAction, isAgentRule, ruleDisplayName } from '../state';
import { formatDuration, formatTime, isPaused } from '../util';
import { AgentBadge, Button, PauseTimer, StateBadge, StatusText } from './bits';
import { PauseEditor } from './Editors';
import { Icon } from './Icon';
import { BodyView, HeadersTable } from './Viewers';

const PAUSE_TEXT = {
  'paused-request': 'Paused before the request reaches the server. Edit it and resume, or abort.',
  'paused-response': 'Paused before the app receives the response. Edit it and resume, or abort.',
} as const;

export function DetailPane({ ex, paneRef }: { ex: Exchange; paneRef?: Ref<HTMLElement> }) {
  const { state, dispatch, post } = useApp();
  const tab = state.detailTab;
  const gaveUp = clientGaveUp(state, ex);
  const rule = ex.matchedRuleId ? state.rules.find((r) => r.id === ex.matchedRuleId) : undefined;
  const ruleIndex = rule ? state.rules.indexOf(rule) : -1;
  const create = (action: RuleAction['kind']) => {
    dispatch({ type: 'awaitRule', kind: action });
    post({ type: 'createRuleFromExchange', id: ex.id, action });
  };

  return (
    <section class="detail" ref={paneRef} tabIndex={-1} aria-label="Exchange details"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,textarea,select')) {
          dispatch({ type: 'select', id: undefined });
        }
      }}>
      <header class="detail-head">
        <div class="detail-title">
          <span class="method">{ex.method}</span>
          <StatusText ex={ex} />
          <span class="url" title={ex.url}>{ex.url}</span>
          <StateBadge ex={ex} gaveUp={gaveUp} />
          <span class="spacer" />
          <Button kind="icon" title="Close details (Esc)" onClick={() => dispatch({ type: 'select', id: undefined })}>
            <Icon name="close" />
          </Button>
        </div>
        <div class="detail-actions">
          <Button onClick={() => create('mock')} title="Create a mock rule from this exchange (the response becomes the mock)">Mock this</Button>
          <Button onClick={() => create('block')} title="Create a rule that blocks requests like this one">Block this</Button>
          <Button onClick={() => create('breakpoint')} title="Create a breakpoint rule that pauses requests like this one">Break on this</Button>
          <span class="detail-facts">
            {formatTime(ex.startedAt)}
            {ex.durationMs !== undefined && ` · ${formatDuration(ex.durationMs)}`}
            {rule && (
              <>
                {' · '}
                {isAgentRule(rule) && <AgentBadge title="This exchange matched a rule created by an AI agent" />}
                <button type="button" class="link" onClick={() => dispatch({ type: 'editRule', id: rule.id })}>
                  rule #{ruleIndex + 1} “{ruleDisplayName(rule)}”
                </button>
                {` (${describeAction(rule.action)})`}
              </>
            )}
            {!rule && ex.matchedRuleId && ' · matched a rule that no longer exists'}
          </span>
        </div>
        {isPaused(ex) && (
          <div class="pause-banner" role="status">
            <Icon name="pause" />
            <span>{PAUSE_TEXT[ex.state as keyof typeof PAUSE_TEXT]}</span>
            <span class="spacer" />
            <PauseTimer ex={ex} verbose />
          </div>
        )}
        {gaveUp ? (
          <div class="msg error gave-up" role="alert">
            <strong>The app gave up while this exchange was paused.</strong> It closed the connection — usually its own
            timeout (e.g. Dio <code>receiveTimeout</code> / <code>connectTimeout</code>) firing during the breakpoint.
            This exchange can no longer be resumed or edited; a late resume is ignored by the proxy.
            Raise the client timeout in debug builds, or resume sooner.
            {ex.error && <div class="detail-error-raw">{ex.error}</div>}
          </div>
        ) : (
          ex.error && <div class="msg error">{ex.error}</div>
        )}
      </header>

      <div class="tabs" role="tablist" aria-label="Message">
        {(['request', 'response'] as const).map((t) => (
          <button key={t} type="button" role="tab" class="tab" aria-selected={tab === t}
            onClick={() => dispatch({ type: 'setDetailTab', tab: t })}>
            {t === 'request' ? 'Request' : 'Response'}
            {((t === 'request' && ex.state === 'paused-request') || (t === 'response' && ex.state === 'paused-response')) && (
              <span class="tab-dot" title="Paused here" />
            )}
          </button>
        ))}
      </div>

      <div class="tab-body" role="tabpanel">
        {tab === 'request' ? <RequestTab ex={ex} /> : <ResponseTab ex={ex} />}
      </div>
    </section>
  );
}

function RequestTab({ ex }: { ex: Exchange }) {
  if (ex.state === 'paused-request') return <PauseEditor key={ex.id + ex.state} ex={ex} />;
  return (
    <>
      <h4 class="section-title">Headers</h4>
      <HeadersTable headers={ex.requestHeaders} />
      <h4 class="section-title">Body</h4>
      <BodyView body={ex.requestBody} headers={ex.requestHeaders} />
    </>
  );
}

function ResponseTab({ ex }: { ex: Exchange }) {
  if (ex.state === 'paused-response') return <PauseEditor key={ex.id + ex.state} ex={ex} />;
  if (ex.status === undefined) {
    const why: Record<string, string> = {
      'pending': 'Waiting for the server…',
      'paused-request': 'The request is paused — resume it to get a response.',
      'aborted': 'Aborted — the app received a connection reset.',
      'blocked': 'Blocked by a rule — the app received a connection reset.',
      'error': `No response: ${ex.error ?? 'network error'}`,
    };
    return <div class="muted pad">{why[ex.state] ?? 'No response.'}</div>;
  }
  return (
    <>
      <h4 class="section-title">Headers</h4>
      <HeadersTable headers={ex.responseHeaders} />
      <h4 class="section-title">Body</h4>
      <BodyView body={ex.responseBody} headers={ex.responseHeaders} />
    </>
  );
}
