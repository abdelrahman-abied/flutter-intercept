import type { Ref } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Exchange } from '../protocol';
import { clientGaveUp, describeAction, findExchange, initiatorLabel, isAgentRule, ruleDisplayName } from '../state';
import { formatBytes, formatDuration, formatTime, fullFrameLocation, isFrameworkFrame, isPaused, shortFrameLocation } from '../util';
import { normalizePath } from '../jsonpath';
import { useExchangeActions, type ExchangeActions } from './actions';
import { ContractSection } from './ContractSection';
import { AgentBadge, Button, CoverageBadges, MenuButton, PauseTimer, StateBadge, StatusText } from './bits';
import { CORS_DEV_NOTE, isNative, NATIVE_READ_ONLY, requestOrigin, routeGlob, sentCookies } from '../coverage';
import { frameTotal, hasFrames } from '../frames';
import { FramesView } from './FramesView';
import { expireTokenError, expireTokenLabel } from '../scenarios';
import { PauseEditor } from './Editors';
import { Icon } from './Icon';
import { BodyView, HeadersTable, type TreeFieldActions } from './Viewers';
import { ADDED_PHASES, hasTimings, PHASE_LABEL, PHASE_TITLE, phaseClass, phaseRows } from '../timing';
import { scriptErrorLine } from '../scripts';
import {
  clientCertTitle, isTunnel, matchingPassthrough, TLS_PASSTHROUGH_SETTING, TUNNEL_LABEL, tunnelBytesText, tunnelTarget,
} from '../connection';

const PAUSE_TEXT = {
  'paused-request': 'Paused before the request reaches the server. Edit it and resume, or abort.',
  'paused-response': 'Paused before the app receives the response. Edit it and resume, or abort.',
} as const;

export function DetailPane({ ex, paneRef }: { ex: Exchange; paneRef?: Ref<HTMLElement> }) {
  const { state, dispatch } = useApp();
  const framed = hasFrames(ex);
  const tunnel = isTunnel(ex);
  // CONTRACTS §14.2: a tunnel has no request / response to show — one "Tunnel" tab (on the `request` slot) + Timing.
  const tab = tunnel ? (state.detailTab === 'timing' ? 'timing' : 'request')
    : state.detailTab === 'messages' && !framed ? 'response' : state.detailTab;
  const tabs = tunnel ? (['request', 'timing'] as const)
    : framed ? (['request', 'response', 'messages', 'timing'] as const) : (['request', 'response', 'timing'] as const);
  const gaveUp = clientGaveUp(state, ex);
  const rule = ex.matchedRuleId ? state.rules.find((r) => r.id === ex.matchedRuleId) : undefined;
  const ruleIndex = rule ? state.rules.indexOf(rule) : -1;
  const actions = useExchangeActions(ex);
  const create = actions.createRule;
  const sentBy = initiatorLabel(ex);
  const original = ex.resentFrom ? findExchange(state, ex.resentFrom) : undefined;
  const [expiring, setExpiring] = useState(false);

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
          <CoverageBadges ex={ex} />
          {ex.clientCertificate && (
            <span class="badge cert-badge" title={clientCertTitle(ex.clientCertificate)}>client certificate: {ex.clientCertificate}</span>
          )}
          <span class="spacer" />
          <Button kind="icon" title="Close details (Esc)" onClick={() => dispatch({ type: 'select', id: undefined })}>
            <Icon name="close" />
          </Button>
        </div>
        <div class="detail-actions">
          <Button onClick={() => create('mock')} disabled={!!actions.off.mock}
            title={actions.off.mock ?? 'Create a mock rule from this exchange (the response becomes the mock)'}>Mock this</Button>
          <Button onClick={() => create('block')} disabled={!!actions.off.block}
            title={actions.off.block ?? 'Create a rule that blocks requests like this one'}>Block this</Button>
          <Button onClick={() => create('breakpoint')} disabled={!!actions.off.breakpoint}
            title={actions.off.breakpoint ?? 'Create a breakpoint rule that pauses requests like this one'}>Break on this</Button>
          <Button onClick={() => setExpiring(!expiring)} pressed={expiring} disabled={!!actions.off.expire}
            title={actions.off.expire ?? 'Make the next request(s) like this one get 401 token_expired — test how the app refreshes its token'}>
            Expire token…
          </Button>
          <span class="sep" aria-hidden="true" />
          <MenuButton label="Copy request as" title={actions.off.copy ?? 'Copy this request as code (cURL, Dart http, Dio)'} items={actions.copyItems}
            disabled={!!actions.off.copy}>
            <Icon name="copy" /> Copy as… <Icon name="chevronDown" />
          </MenuButton>
          <Button onClick={actions.resend} disabled={!!actions.resendDisabled}
            title={actions.resendDisabled ?? 'Send this request again through the proxy, unchanged'}>
            Resend
          </Button>
          <Button onClick={actions.editAndResend} disabled={!!actions.off.edit}
            title={actions.off.edit ?? 'Edit method, URL, headers or body, then send it through the proxy'}>
            <Icon name="edit" /> Edit and resend
          </Button>
          <MenuButton label="Generate" title={tunnel ? actions.off.generate : 'Generate a Dart model or a test fixture from this exchange'}
            items={actions.generateItems} disabled={tunnel}>
            Generate… <Icon name="chevronDown" />
          </MenuButton>
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
        {expiring && !actions.off.expire && (
          <ExpireTokenForm key={ex.id} url={ex.url} onCancel={() => setExpiring(false)}
            onSubmit={(url, count) => { setExpiring(false); actions.expireToken(url, count); }} />
        )}
        {ex.source && <SourceSection ex={ex} onOpen={actions.openSource} />}
        {isNative(ex) && (
          <div class="msg info native-note" role="note">
            <span class="badge mini native-badge">native</span> {NATIVE_READ_ONLY}
          </div>
        )}
        {tunnel && (
          <div class="msg info tunnel-note" role="note">
            <Icon name="lock" /> {TUNNEL_LABEL}: the app's TLS went straight to the server, so there are no headers or bodies
            to show, and no rule applies except Block.
          </div>
        )}
        {ex.cors && (ex.cors.problem || ex.cors.preflight || ex.cors.patched) && (
          <CorsSection ex={ex} onAddRule={isNative(ex) ? undefined : actions.addCorsRule} />
        )}
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
        {ex.scriptLog && ex.scriptLog.length > 0 && <ScriptLog key={ex.id} ex={ex} />}
      </header>

      <div class="tabs" role="tablist" aria-label="Message">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" class="tab" aria-selected={tab === t}
            onClick={() => dispatch({ type: 'setDetailTab', tab: t })}>
            {t === 'request' ? (tunnel ? 'Tunnel' : 'Request') : t === 'response' ? 'Response' : t === 'timing' ? 'Timing'
              : `${ex.kind === 'sse' ? 'Events' : 'Messages'} (${frameTotal(ex)})`}
            {t === 'messages' && ex.state === 'pending' && <span class="tab-dot live" title="Open — live" />}
            {((t === 'request' && ex.state === 'paused-request') || (t === 'response' && ex.state === 'paused-response')) && (
              <span class="tab-dot" title="Paused here" />
            )}
          </button>
        ))}
      </div>

      <div class="tab-body" role="tabpanel">
        {tab === 'request' ? (tunnel ? <TunnelTab ex={ex} /> : <RequestTab ex={ex} />)
          : tab === 'messages' ? <FramesView key={ex.id} ex={ex} />
          : tab === 'timing' ? <TimingSection ex={ex} />
          : <ResponseTab ex={ex} actions={actions} />}
      </div>
    </section>
  );
}

/**
 * CONTRACTS §13.2 "Timing": one row per known phase (bar on the exchange's own time axis + ms), reused connection,
 * breakpoint / added delay marked as added by the tool, and the total. Without timings: the total only.
 */
export function TimingSection({ ex }: { ex: Exchange }) {
  const rows = phaseRows(ex.timings);
  const total = ex.durationMs;
  const running = total === undefined && (ex.state === 'pending' || isPaused(ex));
  const sum = rows.reduce((n, r) => n + r.ms, 0);
  const scale = Math.max(total ?? 0, sum, 1);
  const other = total !== undefined && rows.length ? total - sum : 0;
  const pct = (n: number) => `${Math.round((n / scale) * 10000) / 100}%`;
  return (
    <div class="timing" aria-label="Timing">
      <div class="timing-facts muted">
        Started {formatTime(ex.startedAt)}
        {ex.timings?.reused && <> · <span class="badge mini reused-badge" title={PHASE_TITLE.connect}>reused connection</span></>}
      </div>
      {hasTimings(ex) ? (
        <table class="timing-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.phase} class={`timing-row${ADDED_PHASES.has(r.phase) ? ' added' : ''}`} title={PHASE_TITLE[r.phase]}>
                <th scope="row">
                  <span class={`swatch ${phaseClass(r.phase)}`} aria-hidden="true" />
                  {PHASE_LABEL[r.phase]}
                  {ADDED_PHASES.has(r.phase) && <span class="added-note"> — {r.phase === 'paused' ? 'by you' : 'simulated'}</span>}
                </th>
                <td class="timing-track">
                  <span class={`timing-bar ${phaseClass(r.phase)}`} style={{ left: pct(r.offset), width: r.ms > 0 ? pct(r.ms) : '1px' }} />
                </td>
                <td class="timing-ms">{formatDuration(r.ms)}</td>
              </tr>
            ))}
            {other > 0 && (
              <tr class="timing-row other" title="Time the phases above don't cover (proxy work between phases)">
                <th scope="row"><span class="swatch ph-other" aria-hidden="true" />Other</th>
                <td class="timing-track"><span class="timing-bar ph-other" style={{ left: pct(sum), width: pct(other) }} /></td>
                <td class="timing-ms">{formatDuration(other)}</td>
              </tr>
            )}
            {ex.timings?.reused && !rows.some((r) => r.phase === 'dns' || r.phase === 'connect' || r.phase === 'tls') && (
              <tr class="timing-row reused">
                <th scope="row"><span class="swatch" aria-hidden="true" />Connection</th>
                <td class="timing-track muted" colSpan={2}>reused from the pool — no DNS, connect or TLS</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr class="timing-total">
              <th scope="row">Total</th>
              <td />
              <td class="timing-ms">{total !== undefined ? formatDuration(total) : running ? 'in progress…' : '—'}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <div class="timing-none">
          <div><strong>Total</strong> {total !== undefined ? formatDuration(total) : running ? 'in progress…' : '—'}</div>
          <div class="hint">No phase timings for this exchange{running ? ' yet' : ''}.</div>
        </div>
      )}
    </div>
  );
}

/**
 * CONTRACTS §14.2: a TLS passthrough tunnel — what it is, why it isn't decrypted, and how to undo it
 * (`flutterIntercept.tlsPassthrough`).
 */
export function TunnelTab({ ex }: { ex: Exchange }) {
  const { state } = useApp();
  const { host, port } = tunnelTarget(ex);
  const pattern = matchingPassthrough(ex, state.status.tlsPassthrough);
  const b = ex.tunnelBytes;
  return (
    <div class="tunnel pad" aria-label="TLS passthrough">
      <table class="kv tunnel-facts">
        <tbody>
          <tr><th scope="row">Server</th><td class="mono">{host}:{port}</td></tr>
          <tr><th scope="row">Sent by the app</th><td>{b ? formatBytes(b.sent) : '—'}</td></tr>
          <tr><th scope="row">Received</th><td>{b ? formatBytes(b.received) : '—'}</td></tr>
          <tr><th scope="row">State</th><td>{ex.state === 'pending' ? 'open' : ex.state === 'error' ? `failed${ex.error ? `: ${ex.error}` : ''}` : ex.state === 'blocked' ? 'blocked by a rule' : 'closed'}</td></tr>
        </tbody>
      </table>
      <p class="hint">{tunnelBytesText(ex)}.</p>
      <h4 class="section-title">Why it isn't decrypted</h4>
      <p>
        {pattern ? <><code>{host}</code> matches <code>{pattern}</code> in </> : <><code>{host}</code> is listed in </>}
        the <code>{TLS_PASSTHROUGH_SETTING}</code> setting, so the proxy tunnelled the connection to the server without
        decrypting it — for hosts whose certificate the app pins itself (Dio <code>validateCertificate</code>, native
        pinning), which would otherwise refuse the proxy's certificate.
      </p>
      <p class="muted">
        Only the timing up to the tunnel opening and the encrypted byte counts are known. Mock, breakpoint, rewrite and
        script rules never apply; a Block rule (or a fault) on this host still does.
      </p>
      <h4 class="section-title">To see this traffic</h4>
      <p>
        Remove {pattern ? <code>{pattern}</code> : 'the host'} from <code>{TLS_PASSTHROUGH_SETTING}</code> (Settings →
        Flutter Intercept). New connections are then decrypted and listed as normal requests — restart the app if it keeps
        an open connection. The app's own certificate pinning must allow the proxy's CA for that to work.
      </p>
    </div>
  );
}

/** CONTRACTS §13.4: what the script rule logged (`context.log`), its error line highlighted. */
export function ScriptLog({ ex }: { ex: Exchange }) {
  const log = ex.scriptLog!;
  const errLine = scriptErrorLine(ex);
  return (
    <details class="script-log" open={errLine >= 0 || undefined} aria-label="Script log">
      <summary>Script log <span class="muted">({log.length} line{log.length === 1 ? '' : 's'})</span></summary>
      <ol class="script-lines code">
        {log.map((line, i) => (
          <li key={i} class={i === errLine ? 'script-error' : undefined} title={i === errLine ? 'The script failed: the app got 502' : undefined}>{line}</li>
        ))}
      </ol>
    </details>
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

const MOCKED_NOTE = 'This response came from a mock rule, not the server — edit the mock instead.';

function ResponseTab({ ex, actions }: { ex: Exchange; actions: ExchangeActions }) {
  const { state } = useApp();
  const result = state.contracts[ex.id];
  const fields = useMemo<TreeFieldActions>(() => {
    const marks = new Map<string, { severity: 'error' | 'warning'; message: string }>();
    for (const v of result?.violations ?? []) {
      const k = normalizePath(v.path);
      if (!marks.has(k) || v.severity === 'error') marks.set(k, { severity: v.severity, message: v.message });
    }
    const disabled = isNative(ex) ? NATIVE_READ_ONLY : ex.state === 'mocked' ? MOCKED_NOTE : undefined;
    return { mutate: actions.mutateField, marks, disabled };
  }, [result, ex.id, ex.state, ex.captured]);
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
      <ContractSection ex={ex} result={result} onPick={actions.pickModel} onOpen={actions.openViolation} />
      <h4 class="section-title">Headers</h4>
      <HeadersTable headers={ex.responseHeaders} />
      <h4 class="section-title">Body</h4>
      <BodyView body={ex.responseBody} headers={ex.responseHeaders} fields={fields} />
    </>
  );
}

/**
 * CONTRACTS §11.3: why a browser would block this (Flutter Web), with the dev-only CORS rule. The rule is added
 * after a confirmation that names the origin and the route; credentials are off unless ticked (REVIEW-5 #3).
 */
export function CorsSection({ ex, onAddRule }: { ex: Exchange; onAddRule?: (credentials: boolean) => void }) {
  const c = ex.cors!;
  const origin = requestOrigin(ex);
  const [confirming, setConfirming] = useState(false);
  const [credentials, setCredentials] = useState(false);
  return (
    <div class={`msg ${c.problem ? 'error' : 'info'} cors`} aria-label="CORS">
      <div class="cors-line">
        <strong>CORS</strong>
        {c.preflight && <span class="badge mini cors-pre" title="The browser sends an OPTIONS preflight before the real request">preflight</span>}
        {c.problem ? <span class="cors-problem">{c.problem}</span> : <span>Looks fine for {origin ?? 'this origin'}.</span>}
      </div>
      {c.preflight && <div class="hint">This is the browser's preflight (OPTIONS) for {origin ?? 'a cross-origin request'}.</div>}
      {c.patched && <div class="hint">Patched by Flutter Intercept: the proxy answered or added the CORS headers itself (a mock / CORS rule).</div>}
      {c.problem && onAddRule && !confirming && (
        <div class="cors-actions">
          <Button onClick={() => setConfirming(true)} disabled={!origin}
            title={origin ? `Insert a rule first that lets ${origin} read this route's responses. ${CORS_DEV_NOTE}` : 'The request has no Origin header to allow'}>
            Add CORS rule (dev only)
          </Button>
          <span class="hint">{CORS_DEV_NOTE}</span>
        </div>
      )}
      {c.problem && onAddRule && confirming && origin && (
        <div class="cors-confirm" role="group" aria-label="Add CORS rule">
          <div>
            Allow <code>{origin}</code> to read responses from <code>{routeGlob(ex.url)}</code> (any method, preflights
            answered by the proxy). Only this origin — no other website.
          </div>
          <label class="check">
            <input type="checkbox" checked={credentials} onChange={() => setCredentials(!credentials)} />
            Allow credentials (cookies){sentCookies(ex) ? ' — this request sent cookies' : ''}
          </label>
          <div class="hint">{CORS_DEV_NOTE}</div>
          <div class="cors-actions">
            <Button kind="primary" onClick={() => { setConfirming(false); onAddRule(credentials); }}>
              Add rule{credentials ? ' with credentials' : ''}
            </Button>
            <Button onClick={() => { setConfirming(false); setCredentials(false); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * CONTRACTS §12.3 "Expire token" preset: the host adds a rule (first) that answers the next `count` requests to
 * `url` with 401 {"error":"token_expired"}, then lets them through — the app's refresh shows up under Auth.
 */
export function ExpireTokenForm({ url: initialUrl, onSubmit, onCancel }: {
  url: string; onSubmit: (url: string, count: number) => void; onCancel: () => void;
}) {
  const [url, setUrl] = useState(() => routeGlob(initialUrl));
  const [count, setCount] = useState('1');
  const error = expireTokenError(url, count);
  const n = Number(count.trim());
  return (
    <form class="expire-token" aria-label="Expire token"
      onSubmit={(e) => { e.preventDefault(); if (!error) onSubmit(url.trim(), n); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}>
      <div class="field-row">
        <label class="field grow">
          <span>Requests to</span>
          <input class="mono" value={url} spellcheck={false} aria-invalid={!url.trim()}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field small-field">
          <span>How many</span>
          <input value={count} inputMode="numeric" aria-label="Number of requests that get 401" aria-invalid={!!error && !!url.trim()}
            onInput={(e) => setCount((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      {error
        ? <div class="msg error">{error}</div>
        : <div class="hint">Glob on the full URL. Then: {expireTokenLabel(url.trim(), n)} Widen it (e.g. <code>https://api.example.com/*</code>) to expire every call.</div>}
      <div class="re-actions">
        <Button kind="primary" type="submit" disabled={!!error}>Expire token</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
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
