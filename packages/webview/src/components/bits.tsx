import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Exchange, ExchangeState } from '../protocol';
import { isPaused, pauseClock, statusClassOf } from '../util';

const STATE_LABEL: Record<ExchangeState, string> = {
  'pending': 'pending',
  'paused-request': 'paused req',
  'paused-response': 'paused res',
  'completed': '',
  'mocked': 'mocked',
  'blocked': 'blocked',
  'aborted': 'aborted',
  'error': 'error',
};

const STATE_TITLE: Partial<Record<ExchangeState, string>> = {
  'paused-request': 'Paused before the request is sent to the server',
  'paused-response': 'Paused before the app receives the response',
  'mocked': 'Answered by a mock rule — the server was not contacted',
  'blocked': 'Blocked by a rule — the server was not contacted',
  'aborted': 'Aborted from the breakpoint editor',
};

export function StateBadge({ ex, gaveUp }: { ex: Pick<Exchange, 'state' | 'error'>; gaveUp?: boolean }) {
  if (gaveUp) {
    return (
      <span class="badge state state-error state-gave-up" title={`${ex.error ?? 'Client closed the connection while paused'} — it can no longer be resumed`}>
        gave up
      </span>
    );
  }
  const label = STATE_LABEL[ex.state];
  if (!label) return null;
  return (
    <span class={`badge state state-${ex.state}`} title={ex.error ?? STATE_TITLE[ex.state] ?? ex.state}>
      {label}
    </span>
  );
}

export function StatusText({ ex }: { ex: Pick<Exchange, 'state' | 'status'> }) {
  const cls = statusClassOf(ex) ?? 'none';
  const text = ex.status ?? (ex.state === 'error' || ex.state === 'aborted' || ex.state === 'blocked' ? '✕' : '…');
  return <span class={`status sc-${cls}`}>{text}</span>;
}

export function Button(props: {
  children: ComponentChildren;
  onClick?: () => void;
  kind?: 'primary' | 'secondary' | 'icon' | 'danger';
  title?: string;
  disabled?: boolean;
  pressed?: boolean;
  class?: string;
  type?: 'button' | 'submit';
}) {
  const kind = props.kind ?? 'secondary';
  return (
    <button
      type={props.type ?? 'button'}
      class={`btn btn-${kind}${props.class ? ' ' + props.class : ''}`}
      title={props.title}
      aria-label={kind === 'icon' ? props.title : undefined}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** Marks rules created through the Agent API ("[agent] …" names). */
export function AgentBadge({ title }: { title?: string }) {
  return <span class="badge agent-badge" title={title ?? 'Created by an AI agent'}>agent</span>;
}

/** Re-renders every `ms` while `active`; returns the current time. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return active ? now : Date.now();
}

/** "4:32" until the proxy auto-resumes a paused exchange (verbose: "auto-resumes in 4:32"). */
export function PauseTimer({ ex, verbose }: { ex: Pick<Exchange, 'state' | 'pausedAt' | 'pauseDeadline'>; verbose?: boolean }) {
  const now = useNow(isPaused(ex));
  const c = pauseClock(ex, now);
  if (!c) return null;
  const text = verbose
    ? ex.pauseDeadline !== undefined
      ? c.label === '0:00' ? 'auto-resuming unedited…' : `auto-resumes in ${c.label}`
      : `paused for ${c.label}`
    : c.label;
  return <span class={`countdown${c.urgent ? ' urgent' : ''}`} title={c.title}>{text}</span>;
}

// ---------------------------------------------------------------- menus

export interface MenuItem { label: string; onSelect: () => void; disabled?: boolean; title?: string; separatorBefore?: boolean }

/**
 * Keyboard-accessible menu (role=menu): focuses the first enabled item, ↑/↓/Home/End move, Enter/Space
 * activate, Escape/Tab close. A pointer-down outside closes it. `at` positions it (context menu) through
 * CSSOM, which the strict style-src CSP allows.
 */
export function MenuList({ items, onClose, label, at }: {
  items: MenuItem[]; onClose: (restoreFocus: boolean) => void; label: string; at?: { x: number; y: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
  useLayoutEffect(() => {
    enabled()[0]?.focus();
    const onDown = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(false); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);
  // Keep a context menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !at || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  }, [at?.x, at?.y]);
  const onKeyDown = (e: KeyboardEvent) => {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    switch (e.key) {
      case 'ArrowDown': next = (i + 1) % list.length; break;
      case 'ArrowUp': next = (i - 1 + list.length) % list.length; break;
      case 'Home': next = 0; break;
      case 'End': next = list.length - 1; break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); onClose(true); return;
      case 'Tab': onClose(false); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    list[next]?.focus();
  };
  return (
    <div ref={ref} class={`menu${at ? ' context' : ''}`} role="menu" aria-label={label} onKeyDown={onKeyDown}
      style={at ? { left: `${at.x}px`, top: `${at.y}px` } : undefined}>
      {items.map((it) => (
        <Fragment key={it.label}>
          {it.separatorBefore && <div class="menu-sep" role="separator" />}
          <button type="button" role="menuitem" class="menu-item" disabled={it.disabled} title={it.title}
            onClick={() => { onClose(true); it.onSelect(); }}>
            {it.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/** A button that opens a MenuList below it. */
export function MenuButton({ label, title, items, children, class: cls }: {
  label: string; title?: string; items: MenuItem[]; children: ComponentChildren; class?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <span class={`menu-anchor${cls ? ' ' + cls : ''}`}>
      <button ref={btn} type="button" class="btn btn-secondary" title={title} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        {children}
      </button>
      {open && (
        <MenuList label={label} items={items} onClose={(restore) => { setOpen(false); if (restore) btn.current?.focus(); }} />
      )}
    </span>
  );
}
