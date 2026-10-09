import type { Ref } from 'preact';
import { useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Exchange } from '../protocol';
import { canResend, clientGaveUp, describeAction, findExchange, initiatorLabel, isAgentRule, ruleDisplayName } from '../state';
import { formatDuration, formatTime, fullFrameLocation, isFrameworkFrame, isPaused, shortFrameLocation } from '../util';
import { useExchangeActions } from './actions';
import { AgentBadge, Button, MenuButton, PauseTimer, StateBadge, StatusText } from './bits';
import { PauseEditor } from './Editors';
import { Icon } from './Icon';
import { BodyView, HeadersTable } from './Viewers';

const PAUSE_TEXT = {
  'paused-request': 'Paused before the request reaches the server. Edit it and resume, or abort.',
  'paused-response': 'Paused before the app receives the response. Edit it and resume, or abort.',
} as const;

export function DetailPane({ ex, paneRef }: { ex: Exchange; paneRef?: Ref<HTMLElement> }) {
  const { state, dispatch } = useApp();
  const tab = state.detailTab;
  const gaveUp = clientGaveUp(state, ex);
  const rule = ex.matchedRuleId ? state.rules.find((r) => r.id === ex.matchedRuleId) : undefined;
  const ruleIndex = rule ? state.rules.indexOf(rule) : -1;
  const actions = useExchangeActions(ex);
  const create = actions.createRule;
  const sentBy = initiatorLabel(ex);
  const original = ex.resentFrom ? findExchange(state, ex.resentFrom) : undefined;

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
          <span class="sep" aria-hidden="true" />
          <MenuButton label="Copy request as" title="Copy this request as code (cURL, Dart http, Dio)" items={actions.copyItems}>
            <Icon name="copy" /> Copy as… <Icon name="chevronDown" />
          </MenuButton>
          <Button onClick={actions.resend} disabled={!!actions.resendDisabled}
            title={actions.resendDisabled ?? 'Send this request again through the proxy, unchanged'}>
            Resend
          </Button>
          <Button onClick={actions.editAndResend} disabled={!canResend(ex)}
            title={canResend(ex) ? 'Edit method, URL, headers or body, then send it through the proxy' : 'Wait until the exchange has finished'}>
            <Icon name="edit" /> Edit and resend
          </Button>
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
            {sentBy && (
              <>
                {' · '}
                <span class="badge sent-badge">{ex.initiator === 'agent' ? 'agent' : 'editor'}</span>{' '}
                {sentBy}
                {ex.resentFrom && (original
                  ? <> from <button type="button" class="link" onClick={() => dispatch({ type: 'select', id: original.id })}
                      title={`${original.method} ${original.url}`}>the original</button></>
                  : ' from an exchange no longer listed')}
              </>
            )}
            {ex.simulated && (
              <>
                {' · '}
                <span class="badge sim-badge" title="A throttle / fault rule or the network profile affected this exchange">simulated</span>{' '}
                {ex.simulated}
              </>
            )}
          </span>
        </div>
        {ex.source && <SourceSection ex={ex} onOpen={actions.openSource} />}
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

/** The app call site (CONTRACTS §9.2 Exchange.source) with "Open source" and the full frame list. */
export function SourceSection({ ex, onOpen }: { ex: Exchange; onOpen: (frame?: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const src = ex.source!;
  const app = src.appFrame !== undefined ? src.frames[src.appFrame] : undefined;
  return (
    <div class="source" aria-label="Request source">
      <div class="source-line">
        <span class="muted">Called from</span>
        {app ? (
          <>
            <code class="source-fn" title={fullFrameLocation(app)}>{app.fn || '<anonymous>'}</code>
            <span class="source-loc" title={fullFrameLocation(app)}>{shortFrameLocation(app)}</span>
            <Button onClick={() => onOpen(src.appFrame)} title={`Open ${fullFrameLocation(app)} in the editor`}>Open source</Button>
          </>
        ) : (
          <span class="muted">no app frame found (only SDK / library frames)</span>
        )}
        {src.frames.length > 0 && (
          <button type="button" class="link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Hide' : 'All'} frames ({src.frames.length})
          </button>
        )}
      </div>
      {expanded && (
        <ol class="frames" aria-label="Stack frames">
          {src.frames.map((f, i) => (
            <li key={i} class={`frame${isFrameworkFrame(f) ? ' framework' : ''}${i === src.appFrame ? ' app' : ''}`}>
              {f.afterAsyncGap && <div class="async-gap" role="separator">‹asynchronous gap›</div>}
              <button type="button" class="frame-btn" title={`Open ${fullFrameLocation(f)}`} onClick={() => onOpen(i)}>
                <span class="frame-fn">{f.fn || '<anonymous>'}</span>
                <span class="frame-loc">{shortFrameLocation(f)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
