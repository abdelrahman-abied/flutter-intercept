import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Exchange } from '../protocol';
import { clientGaveUp, findExchange, initiatorLabel, isAgentRule, ruleDisplayName } from '../state';
import type { ContractSummary, Rule } from '../protocol';
import { contractBadgeTitle, contractStatus } from '../contract';
import { bodyByteLength, formatBytes, formatDuration, isPaused, shortFrameLocation, splitUrl } from '../util';
import { useExchangeActions } from './actions';
import { AgentBadge, CoverageBadges, MenuList, PauseTimer, StateBadge, StatusText } from './bits';
import { frameTotal, hasFrames } from '../frames';
import { isTunnel, tunnelBytesShort, tunnelBytesText, tunnelTitle } from '../connection';
import { barGeometry, phaseClass, timeRange, timingTooltip, type TimeRange } from '../timing';

export const ROW_HEIGHT = 22;
const OVERSCAN = 8;
/** Used before the first layout (and in DOM-less tests) where clientHeight is 0. */
const FALLBACK_VIEWPORT = 600;

/**
 * Virtualised list: only the rows in (or near) the viewport are in the DOM, so 1000
 * exchanges cost the same as 40. Fixed row height keeps the math trivial.
 */
export function TrafficList({ list, onOpen }: { list: Exchange[]; onOpen: () => void }) {
  const { state, dispatch } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const followTail = useRef(true);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | undefined>();

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep following new traffic while scrolled to the bottom (like a log).
  useLayoutEffect(() => {
    const el = ref.current!;
    if (followTail.current && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
  }, [list.length]);

  // Keyboard selection (and the host's `select`, via revealSeq) scrolls the row into view.
  useLayoutEffect(() => {
    const el = ref.current!;
    const i = state.selectedId ? list.findIndex((e) => e.id === state.selectedId) : -1;
    if (i < 0 || !el.clientHeight) return;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [state.selectedId, state.revealSeq]);

  const onScroll = () => {
    const el = ref.current!;
    followTail.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT / 2;
    setScrollTop(el.scrollTop);
  };

  const pageRows = Math.max(1, Math.floor((height || FALLBACK_VIEWPORT) / ROW_HEIGHT) - 1);
  const selectIndex = (i: number) => {
    const ex = list[Math.max(0, Math.min(list.length - 1, i))];
    if (ex) dispatch({ type: 'select', id: ex.id });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const cur = state.selectedId ? list.findIndex((x) => x.id === state.selectedId) : -1;
    switch (e.key) {
      case 'ArrowDown': dispatch({ type: 'move', to: 'next' }); break;
      case 'ArrowUp': dispatch({ type: 'move', to: 'prev' }); break;
      case 'Home': dispatch({ type: 'move', to: 'first' }); break;
      case 'End': dispatch({ type: 'move', to: 'last' }); break;
      case 'PageDown': selectIndex(cur + pageRows); break;
      case 'PageUp': selectIndex(cur < 0 ? 0 : cur - pageRows); break;
      case 'Enter': if (state.selectedId) onOpen(); break;
      case 'Escape': dispatch({ type: 'select', id: undefined }); break;
      case 'ContextMenu': openMenuForSelection(); break;
      case 'F10':
        if (!e.shiftKey) return;
        openMenuForSelection();
        break;
      default: return;
    }
    e.preventDefault();
  };

  // Shift+F10 / the context-menu key open the menu at the selected row.
  const openMenuForSelection = () => {
    const el = ref.current!;
    const i = state.selectedId ? list.findIndex((x) => x.id === state.selectedId) : -1;
    if (i < 0) return;
    const r = el.getBoundingClientRect();
    setMenu({ id: list[i].id, x: r.left + 24, y: r.top + (i + 1) * ROW_HEIGHT - el.scrollTop });
  };
  const menuEx = menu ? findExchange(state, menu.id) : undefined;

  const vh = height || FALLBACK_VIEWPORT;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(list.length, Math.ceil((scrollTop + vh) / ROW_HEIGHT) + OVERSCAN);
  // Matched-rule chips: only agent rules are marked in the row (the detail pane names every rule).
  const agentRules = new Map<string, Rule>();
  for (const r of state.rules) if (isAgentRule(r)) agentRules.set(r.id, r);
  // Waterfall (CONTRACTS §13.2): bars are placed on the time span of the rows in view, in % (no DOM measuring).
  const wf = state.showWaterfall;
  const now = Date.now();
  const range = wf
    ? timeRange(list.slice(Math.floor(scrollTop / ROW_HEIGHT), Math.min(list.length, Math.ceil((scrollTop + vh) / ROW_HEIGHT))), now)
    : undefined;
  const rows: JSX.Element[] = [];
  for (let i = start; i < end; i++) {
    const ex = list[i];
    rows.push(<Row key={ex.id} ex={ex} selected={ex.id === state.selectedId} gaveUp={clientGaveUp(state, ex)} range={range} now={now}
      agentRule={ex.matchedRuleId ? agentRules.get(ex.matchedRuleId) : undefined} contract={state.contracts[ex.id]}
      onSelect={() => dispatch({ type: 'select', id: ex.id })} onOpen={onOpen}
      onMenu={(x, y) => { dispatch({ type: 'select', id: ex.id }); setMenu({ id: ex.id, x, y }); }} />);
  }

  return (
    <div class={`list${wf ? ' wf' : ''}`}>
      <div class="list-head cols" aria-hidden="true">
        <span class="c-method">Method</span>
        <span class="c-status">Status</span>
        <span class="c-host">Host</span>
        <span class="c-path">Path</span>
        <span class="c-dur">Time</span>
        <span class="c-size">Size</span>
        <span class="c-state">State</span>
        {wf && <span class="c-wf">Waterfall{range && <span class="wf-span"> · {formatDuration(range.end - range.start)}</span>}</span>}
      </div>
      <div
        ref={ref}
        class="list-scroll"
        tabIndex={0}
        role="listbox"
        aria-label="HTTP exchanges"
        aria-activedescendant={state.selectedId ? `ex-${state.selectedId}` : undefined}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        aria-keyshortcuts="Shift+F10"
      >
        <div class="list-spacer" style={{ height: `${list.length * ROW_HEIGHT}px` }}>
          <div class="list-window" style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
            {rows}
          </div>
        </div>
      </div>
      {menu && menuEx && (
        <RowMenu ex={menuEx} at={menu} onClose={(restore) => { setMenu(undefined); if (restore) ref.current?.focus(); }} />
      )}
    </div>
  );
}

function RowMenu({ ex, at, onClose }: { ex: Exchange; at: { x: number; y: number }; onClose: (restore: boolean) => void }) {
  const actions = useExchangeActions(ex);
  return <MenuList label={`Actions for ${ex.method} ${ex.url}`} items={actions.menuItems} at={at} onClose={onClose} />;
}

/** One waterfall bar: offset + width on the range, split into phase segments (CSSOM styles: CSP-safe). */
export function WaterfallBar({ ex, range, now }: { ex: Exchange; range: TimeRange; now: number }) {
  const g = barGeometry(ex, range, now);
  return (
    <span class="wf-track">
      <span class={`wf-bar${g.running ? ' running' : ''}`} style={{ left: `${g.left}%`, width: `${g.width}%` }}>
        {g.segments.map((s, i) => <span key={i} class={`wf-seg ${phaseClass(s.phase)}`} style={{ width: `${s.pct}%` }} />)}
      </span>
    </span>
  );
}

function Row({ ex, selected, gaveUp, agentRule, contract, range, now, onSelect, onOpen, onMenu }: {
  ex: Exchange; selected: boolean; gaveUp: boolean; agentRule?: Rule; contract?: ContractSummary; range?: TimeRange; now: number;
  onSelect: () => void; onOpen: () => void; onMenu: (x: number, y: number) => void;
}) {
  const sentBy = initiatorLabel(ex);
  const app = ex.source?.appFrame !== undefined ? ex.source.frames[ex.source.appFrame] : undefined;
  const { host, path } = splitUrl(ex.url);
  const size = bodyByteLength(ex.responseBody);
  const cs = contractStatus(contract);
  return (
    <div
      id={`ex-${ex.id}`}
      role="option"
      aria-selected={selected}
      class={`row cols st-${ex.state}${selected ? ' selected' : ''}${isTunnel(ex) ? ' tunnel-row' : ''}`}
      onClick={onSelect}
      onDblClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
    >
      <span class="c-method">{ex.method}</span>
      <span class="c-status"><StatusText ex={ex} /></span>
      <span class="c-host" title={host}>{host}</span>
      <span class="c-path" title={isTunnel(ex) ? tunnelTitle(ex) : app ? `${ex.url}\nCalled from ${app.fn} (${shortFrameLocation(app)})` : ex.url}>
        <CoverageBadges ex={ex} mini />{path}
      </span>
      <span class="c-dur">{isPaused(ex) ? <PauseTimer ex={ex} /> : formatDuration(ex.durationMs)}</span>
      {isTunnel(ex)
        ? <span class="c-size tunnel-bytes" title={tunnelBytesText(ex)}>{tunnelBytesShort(ex)}</span>
        : hasFrames(ex)
        ? <span class="c-size" title={`${frameTotal(ex)} ${ex.kind === 'sse' ? 'events' : 'messages'}`}>{frameTotal(ex)} msg</span>
        : <span class="c-size">{formatBytes(size)}{ex.responseBody?.truncated ? '+' : ''}</span>}
      <span class="c-state">
        <StateBadge ex={ex} gaveUp={gaveUp} />
        {agentRule && <AgentBadge title={`Matched agent rule “${ruleDisplayName(agentRule)}”`} />}
        {sentBy && <span class="badge mini sent-badge" title={sentBy}>{ex.resentFrom ? 'resent' : 'sent'}</span>}
        {ex.simulated && <span class="badge mini sim-badge" title={`Simulated: ${ex.simulated}`}>sim</span>}
        {(cs === 'error' || cs === 'warning') && (
          <span class={`badge mini contract-badge cb-${cs}`} title={contractBadgeTitle(contract!)}>model</span>
        )}
      </span>
      {range && <span class="c-wf" title={timingTooltip(ex)}><WaterfallBar ex={ex} range={range} now={now} /></span>}
    </div>
  );
}
