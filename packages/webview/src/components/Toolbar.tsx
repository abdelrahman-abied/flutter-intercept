import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp } from '../context';
import { FILTER_HINT, parseFilter } from '../filter';
import type { NetworkProfile } from '../protocol';
import {
  checkThrottle, customProfile, filterExchanges, hasActiveFilters, hiddenBrowserCount, isProfileActive, pausedCount, PROFILE_CHOICES, profileChoice,
  profileDetails, profileForChoice, profileLabel, throttleFieldsOf, type ProfileChoice, type ThrottleFields,
} from '../state';
import { STATUS_CLASSES } from '../util';
import { authAlerts, INSECURE_TITLE } from '../scenarios';
import { fromVsCodeProxy, upstreamLabel, upstreamTitle } from '../connection';
import { EXPORT_FORMATS, EXPORT_LABEL, EXPORT_TITLE, exportScope } from '../exporting';
import { Button, MenuButton, type MenuItem } from './bits';
import { Icon } from './Icon';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function Toolbar() {
  const { state, dispatch, post } = useApp();
  const { filters, status, view } = state;
  const paused = pausedCount(state.exchanges);
  const filterErrors = parseFilter(filters.text).errors;
  const browserHidden = hiddenBrowserCount(state.exchanges, filters);
  const alerts = authAlerts(state.authFlows);
  const anyBrowser = filters.showBrowser || browserHidden > 0 || state.exchanges.some((e) => e.browserInternal);

  return (
    <div class="toolbar" role="toolbar" aria-label="Flutter Intercept">
      <div class="seg" role="tablist" aria-label="View">
        <button type="button" role="tab" class="seg-btn" aria-selected={view === 'traffic'}
          onClick={() => dispatch({ type: 'setView', view: 'traffic' })}>
          Traffic
        </button>
        <button type="button" role="tab" class="seg-btn" aria-selected={view === 'rules'}
          onClick={() => dispatch({ type: 'setView', view: 'rules' })}>
          Rules{state.rules.length ? <span class="count">{state.rules.filter((r) => r.enabled).length}/{state.rules.length}</span> : null}
        </button>
        <button type="button" role="tab" class="seg-btn" aria-selected={view === 'recordings'}
          title={status.replay ? `Replaying “${status.replay.recording}”` : 'Save, replay and compare traffic'}
          onClick={() => dispatch({ type: 'setView', view: 'recordings' })}>
          Recordings
          {status.replay
            ? <span class="count replay-count" aria-label="replaying">▶</span>
            : state.recordings.length ? <span class="count">{state.recordings.length}</span> : null}
        </button>
        <button type="button" role="tab" class="seg-btn" aria-selected={view === 'auth'}
          title={alerts ? `${alerts} token refresh flow${alerts === 1 ? '' : 's'} need attention (stampede or failed retry)` : 'Token refresh flows (401 → refresh → retry)'}
          onClick={() => dispatch({ type: 'setView', view: 'auth' })}>
          Auth
          {alerts ? <span class="count warn-count">{alerts}</span> : state.authFlows.length ? <span class="count">{state.authFlows.length}</span> : null}
        </button>
      </div>

      <button
        type="button"
        class={`intercept-toggle ${status.interceptEnabled ? 'on' : 'off'}`}
        aria-pressed={status.interceptEnabled}
        title={status.interceptEnabled
          ? 'Interception is on: Flutter debug sessions are routed through the proxy. Click to turn off.'
          : 'Interception is off: the next debug session runs without the proxy. Click to turn on.'}
        onClick={() => post({ type: 'setInterceptEnabled', enabled: !status.interceptEnabled })}
      >
        <span class="dot" aria-hidden="true" />
        Intercept {status.interceptEnabled ? 'on' : 'off'}
      </button>

      <Button kind="icon" title="Clear traffic" onClick={() => post({ type: 'clear' })} disabled={!state.exchanges.length}>
        <Icon name="clear" />
      </Button>

      {view === 'traffic' && (
        <>
          <span class="sep" aria-hidden="true" />
          <input
            class="filter-text"
            type="search"
            placeholder="Filter: url m:POST s:4xx t:json body:token -word"
            aria-label="Filter"
            title={filterErrors.length ? `${filterErrors.join('\n')}\n\n${FILTER_HINT}` : FILTER_HINT}
            aria-invalid={filterErrors.length > 0}
            aria-description={FILTER_HINT}
            spellcheck={false}
            value={filters.text}
            onInput={(e) => dispatch({ type: 'setFilters', patch: { text: (e.target as HTMLInputElement).value } })}
          />
          <select
            class="filter-method"
            aria-label="Filter by method"
            value={filters.method}
            onChange={(e) => dispatch({ type: 'setFilters', patch: { method: (e.target as HTMLSelectElement).value } })}
          >
            <option value="">All methods</option>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <div class="toggles" role="group" aria-label="Filter by status">
            {STATUS_CLASSES.map((c) => (
              <button key={c} type="button" class={`toggle sc-${c}`} aria-pressed={filters.statusClasses.includes(c)}
                title={c === 'error' ? 'Network errors, aborted and blocked (reset) exchanges' : `Status ${c}`}
                onClick={() => dispatch({ type: 'toggleStatusClass', cls: c })}>
                {c === 'error' ? 'err' : c}
              </button>
            ))}
            <button type="button" class="toggle" aria-pressed={filters.pausedOnly} title="Show paused exchanges only"
              onClick={() => dispatch({ type: 'setFilters', patch: { pausedOnly: !filters.pausedOnly } })}>
              paused only
            </button>
            {anyBrowser && (
              <button type="button" class="toggle browser-toggle" aria-pressed={filters.showBrowser}
                title={'Flutter Web: the browser\'s own requests (updates, sync, safe browsing…) are not the app\'s and are hidden by default. ' +
                  (filters.showBrowser ? 'Click to hide them.' : `${browserHidden} hidden — click to show them.`)}
                onClick={() => dispatch({ type: 'setFilters', patch: { showBrowser: !filters.showBrowser } })}>
                Show browser traffic{browserHidden > 0 && <span class="count">{browserHidden}</span>}
              </button>
            )}
          </div>
          {hasActiveFilters(filters) && (
            <Button kind="icon" title="Clear filters" onClick={() => dispatch({ type: 'clearFilters' })}>
              <Icon name="close" />
            </Button>
          )}
          <button type="button" class="toggle wf-toggle" aria-pressed={state.showWaterfall}
            title={state.showWaterfall ? 'Hide the timing waterfall column' : 'Show the timing waterfall column (DNS, connect, TLS, wait, download)'}
            onClick={() => dispatch({ type: 'toggleWaterfall' })}>
            <Icon name="timing" /> Waterfall
          </button>
        </>
      )}

      <span class="sep" aria-hidden="true" />
      <NetworkPicker profile={status.networkProfile} onSet={(profile) => post({ type: 'setNetworkProfile', profile })} />

      {status.upstreamProxy && (
        <span class={`upstream-chip${status.upstreamProxyInsecure ? ' insecure' : ''}${fromVsCodeProxy(status) ? ' vscode-proxy' : ''}`}
          title={status.upstreamProxyInsecure ? `${upstreamTitle(status)}\n\n${INSECURE_TITLE}` : upstreamTitle(status)}>
          <span class="dot" aria-hidden="true" />{upstreamLabel(status)}
          {status.upstreamProxyInsecure && <strong class="insecure-text"> · certificate checks OFF</strong>}
        </span>
      )}
      <span class="spacer" />
      <ExportMenu />
      <Button kind="icon" title={inEditor()
        ? 'Move Flutter Intercept to its own window'
        : 'Open Flutter Intercept in its own window (an editor tab you can move to another screen)'}
        onClick={() => post({ type: 'openInNewWindow' })}>
        <Icon name="window" />
      </Button>
      {paused > 0 && (
        <button type="button" class="paused-alert" onClick={() => dispatch({ type: 'showPaused' })}
          title="Exchanges are waiting at a breakpoint. The app is blocked until you resume or abort them. Click to jump to the next one.">
          <Icon name="pause" />
          {paused} paused
        </button>
      )}
    </div>
  );
}

/** The view is an editor tab / its own window (CONTRACTS §13.1): the host adds `fi-panel` only in the panel. */
export function inEditor(): boolean {
  return typeof document !== 'undefined' && !document.body.classList.contains('fi-panel') && !document.body.classList.contains('fi-sidebar');
}

/**
 * CONTRACTS §13.5 "Export…": OpenAPI / Postman / HAR. While the list is filtered, only the HTTP exchanges it shows are
 * exported (their ids go along); otherwise the host exports every HTTP exchange shown. The host asks about redaction
 * and where to save, then answers `exported` (a notice).
 */
export function ExportMenu() {
  const { state, post } = useApp();
  const scope = useMemo(
    () => exportScope(filterExchanges(state.exchanges, state.filters, state.contracts), hasActiveFilters(state.filters)),
    [state.exchanges, state.filters, state.contracts],
  );
  const none = scope.count === 0;
  const what = scope.filtered
    ? `the ${scope.count} HTTP exchange${scope.count === 1 ? '' : 's'} the filter shows`
    : `all ${scope.count} HTTP exchange${scope.count === 1 ? '' : 's'}`;
  const items: MenuItem[] = EXPORT_FORMATS.map((format) => ({
    label: `${EXPORT_LABEL[format]}…`,
    title: none ? 'No HTTP exchanges to export' : `${EXPORT_TITLE[format]}. Exports ${what}.`,
    disabled: none,
    onSelect: () => post(scope.ids ? { type: 'export', format, ids: scope.ids } : { type: 'export', format }),
  }));
  return (
    <MenuButton label="Export" class="export-menu" items={items}
      title={none ? 'Export traffic as OpenAPI, Postman or HAR — no HTTP exchanges yet' : `Export ${what} as OpenAPI, Postman or HAR`}>
      <Icon name="export" /> Export{scope.filtered ? ` (${scope.count})` : ''}… <Icon name="chevronDown" />
    </MenuButton>
  );
}

/**
 * Global network profile (CONTRACTS §9.3 setNetworkProfile). Reflects status.networkProfile, and is
 * clearly highlighted while active — a throttled app is easy to forget about.
 */
export function NetworkPicker({ profile, onSet }: { profile?: NetworkProfile; onSet: (p: NetworkProfile) => void }) {
  const choice = profileChoice(profile);
  const active = isProfileActive(profile);
  const [custom, setCustom] = useState(false);
  return (
    <span class={`net-picker${active ? ' active' : ''}`}>
      <label class="net-label" title={active
        ? `Network profile: ${profileLabel(profile)}${profileDetails(profile) !== profileLabel(profile) ? ` (${profileDetails(profile)})` : ''}. ` +
          'Applies to everything this app sends through the proxy (mocks and blocks still answer as set).'
        : 'Simulate a slow, flaky or offline network for this app only'}>
        {active && <span class="dot" aria-hidden="true" />}
        Network
        <select aria-label="Network profile" value={choice}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value as ProfileChoice;
            if (v === 'custom') setCustom(true);
            else { setCustom(false); onSet(profileForChoice(v)); }
          }}>
          {PROFILE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}
              title={c.value !== 'custom' && c.value !== 'none' && c.value !== 'offline' ? profileDetails(profileForChoice(c.value)) : undefined}>
              {c.value === 'custom' && choice === 'custom' ? `Custom: ${profileLabel(profile)}` : c.label}
            </option>
          ))}
        </select>
      </label>
      {choice === 'custom' && !custom && (
        <Button kind="icon" title="Edit the custom profile" onClick={() => setCustom(true)}><Icon name="edit" /></Button>
      )}
      {custom && (
        <CustomProfileForm initial={profile?.kind === 'throttle' ? throttleFieldsOf(profile) : { latencyMs: '300', kbps: '800', dropPct: '' }}
          onApply={(p) => { setCustom(false); onSet(p); }} onCancel={() => setCustom(false)} />
      )}
    </span>
  );
}

function CustomProfileForm({ initial, onApply, onCancel }: {
  initial: ThrottleFields; onApply: (p: NetworkProfile) => void; onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const first = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => first.current?.focus(), []);
  const check = checkThrottle(f);
  const field = (key: keyof ThrottleFields, label: string, placeholder: string) => (
    <label class="field small-field">
      <span>{label}</span>
      <input ref={key === 'latencyMs' ? first : undefined} value={f[key] ?? ''} inputMode="numeric" placeholder={placeholder}
        aria-invalid={!!check.errors[key]} title={check.errors[key]}
        onInput={(e) => setF({ ...f, [key]: (e.target as HTMLInputElement).value })} />
    </label>
  );
  const apply = () => { const p = customProfile(f); if (p) onApply(p); };
  return (
    <form class="net-custom" role="dialog" aria-label="Custom network profile"
      onSubmit={(e) => { e.preventDefault(); apply(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}>
      <div class="field-row">
        {field('latencyMs', 'Latency (ms)', '0')}
        {field('kbps', 'Download (kbps)', 'unlimited')}
        {field('uploadKbps', 'Upload (kbps)', 'unlimited')}
        {field('dropPct', 'Fail (%)', '0')}
      </div>
      <div class="hint">Upload paces request bodies and the messages the app sends; download paces responses. Empty = unlimited.</div>
      {Object.values(check.errors).map((m) => <div key={m} class="msg error">{m}</div>)}
      <div class="re-actions">
        <Button kind="primary" type="submit" disabled={Object.keys(check.errors).length > 0}>Apply</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
