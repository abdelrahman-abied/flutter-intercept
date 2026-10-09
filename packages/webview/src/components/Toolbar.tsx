import { useApp } from '../context';
import { hasActiveFilters, pausedCount } from '../state';
import { STATUS_CLASSES } from '../util';
import { Button } from './bits';
import { Icon } from './Icon';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function Toolbar() {
  const { state, dispatch, post } = useApp();
  const { filters, status, view } = state;
  const paused = pausedCount(state.exchanges);

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
            placeholder="Filter URL (-term excludes)"
            aria-label="Filter by URL"
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
