import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../context';
import { FILTER_HINT, parseFilter } from '../filter';
import type { NetworkProfile } from '../protocol';
import {
  checkThrottle, customProfile, hasActiveFilters, isProfileActive, pausedCount, PROFILE_CHOICES, profileChoice,
  profileForChoice, profileLabel, throttleFieldsOf, type ProfileChoice, type ThrottleFields,
} from '../state';
import { STATUS_CLASSES } from '../util';
import { Button } from './bits';
import { Icon } from './Icon';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function Toolbar() {
  const { state, dispatch, post } = useApp();
  const { filters, status, view } = state;
  const paused = pausedCount(state.exchanges);
  const filterErrors = parseFilter(filters.text).errors;

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
          </div>
          {hasActiveFilters(filters) && (
            <Button kind="icon" title="Clear filters" onClick={() => dispatch({ type: 'clearFilters' })}>
              <Icon name="close" />
            </Button>
          )}
        </>
      )}

      <span class="sep" aria-hidden="true" />
      <NetworkPicker profile={status.networkProfile} onSet={(profile) => post({ type: 'setNetworkProfile', profile })} />

      <span class="spacer" />
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
        ? `Network profile: ${profileLabel(profile)}. Applies to everything this app sends through the proxy (mocks and blocks still answer as set).`
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
            <option key={c.value} value={c.value}>
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
      <input ref={key === 'latencyMs' ? first : undefined} value={f[key]} inputMode="numeric" placeholder={placeholder}
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
        {field('kbps', 'Bandwidth (kbps)', 'unlimited')}
        {field('dropPct', 'Fail (%)', '0')}
      </div>
      {Object.values(check.errors).map((m) => <div key={m} class="msg error">{m}</div>)}
      <div class="re-actions">
        <Button kind="primary" type="submit" disabled={Object.keys(check.errors).length > 0}>Apply</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
