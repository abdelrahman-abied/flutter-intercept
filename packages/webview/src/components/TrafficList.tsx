import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Exchange } from '../protocol';
import { clientGaveUp, isAgentRule, ruleDisplayName } from '../state';
import type { Rule } from '../protocol';
import { bodyByteLength, formatBytes, formatDuration, isPaused, splitUrl } from '../util';
import { AgentBadge, PauseTimer, StateBadge, StatusText } from './bits';

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

  // Keyboard selection scrolls the row into view.
  useLayoutEffect(() => {
    const el = ref.current!;
    const i = state.selectedId ? list.findIndex((e) => e.id === state.selectedId) : -1;
    if (i < 0 || !el.clientHeight) return;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [state.selectedId]);

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
      default: return;
    }
    e.preventDefault();
  };

  const vh = height || FALLBACK_VIEWPORT;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(list.length, Math.ceil((scrollTop + vh) / ROW_HEIGHT) + OVERSCAN);
  // Matched-rule chips: only agent rules are marked in the row (the detail pane names every rule).
  const agentRules = new Map<string, Rule>();
  for (const r of state.rules) if (isAgentRule(r)) agentRules.set(r.id, r);
  const rows: JSX.Element[] = [];
  for (let i = start; i < end; i++) {
    const ex = list[i];
    rows.push(<Row key={ex.id} ex={ex} selected={ex.id === state.selectedId} gaveUp={clientGaveUp(state, ex)}
      agentRule={ex.matchedRuleId ? agentRules.get(ex.matchedRuleId) : undefined}
      onSelect={() => dispatch({ type: 'select', id: ex.id })} onOpen={onOpen} />);
  }

  return (
    <div class="list">
      <div class="list-head cols" aria-hidden="true">
        <span class="c-method">Method</span>
        <span class="c-status">Status</span>
        <span class="c-host">Host</span>
        <span class="c-path">Path</span>
        <span class="c-dur">Time</span>
        <span class="c-size">Size</span>
        <span class="c-state">State</span>
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
      >
        <div class="list-spacer" style={{ height: `${list.length * ROW_HEIGHT}px` }}>
          <div class="list-window" style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
            {rows}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ ex, selected, gaveUp, agentRule, onSelect, onOpen }: {
  ex: Exchange; selected: boolean; gaveUp: boolean; agentRule?: Rule; onSelect: () => void; onOpen: () => void;
}) {
  const { host, path } = splitUrl(ex.url);
  const size = bodyByteLength(ex.responseBody);
  return (
    <div
      id={`ex-${ex.id}`}
      role="option"
      aria-selected={selected}
      class={`row cols st-${ex.state}${selected ? ' selected' : ''}`}
      onClick={onSelect}
      onDblClick={onOpen}
    >
      <span class="c-method">{ex.method}</span>
      <span class="c-status"><StatusText ex={ex} /></span>
      <span class="c-host" title={host}>{host}</span>
      <span class="c-path" title={ex.url}>{path}</span>
      <span class="c-dur">{isPaused(ex) ? <PauseTimer ex={ex} /> : formatDuration(ex.durationMs)}</span>
      <span class="c-size">{formatBytes(size)}{ex.responseBody?.truncated ? '+' : ''}</span>
      <span class="c-state">
        <StateBadge ex={ex} gaveUp={gaveUp} />
        {agentRule && <AgentBadge title={`Matched agent rule “${ruleDisplayName(agentRule)}”`} />}
      </span>
    </div>
  );
}
