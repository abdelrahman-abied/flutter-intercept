/**
 * Error notifications (CONTRACTS §13.6). Shared types, lead-owned. Implemented in src/notify/** (policy pure;
 * the vscode glue takes injected deps).
 */
import type { Exchange } from '@flutter-intercept/proxy';

/** Setting `flutterIntercept.notifications`. */
export type NotifyLevel = 'off' | 'errors' | 'all';

export interface Notice {
  /** One sentence, e.g. "GET /users/42 failed: 500 Internal Server Error" or "3 requests failed (latest: …)". */
  text: string;
  /** The exchange "Show" selects (the latest one in a group). */
  exchangeId: string;
  /** How many failures this notice covers. */
  count: number;
}

export interface NotifyPolicyOptions {
  level: NotifyLevel;
  /** At most one notice per window; failures inside it are grouped into the next notice. Default 10 000 ms. */
  windowMs?: number;
}

export interface NotifyPolicy {
  /** Feed every exchange update; returns a notice to show now, if any. Each exchange counts once. */
  onExchange(e: Exchange, now: number, panelVisible: boolean): Notice | undefined;
  /** Grouped failures waiting for the window to pass; call on a timer. */
  flush(now: number, panelVisible: boolean): Notice | undefined;
  setLevel(level: NotifyLevel): void;
}
