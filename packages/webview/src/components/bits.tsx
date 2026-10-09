import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
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
