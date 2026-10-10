/**
 * Error notifications glue (CONTRACTS §13.6). No `vscode` import: the host passes a vscode-shaped deps object,
 * so this stays unit-testable. Wiring in extension.ts (sketch):
 *
 *   const notifications = registerNotifications({
 *     showMessage: (text, ...buttons) => vscode.window.showWarningMessage(`Flutter Intercept: ${text}`, ...buttons),
 *     reveal: (id) => revealPanelAndSelect(id),                  // reveal the view, post `select {id}`
 *     turnOff: () => cfg().update('notifications', 'off', vscode.ConfigurationTarget.Global),
 *     getLevel: () => cfg().get('notifications'),
 *     isPanelVisible: () => anyPanelVisible() && vscode.window.state.focused,
 *   });
 *   proxyHost.onExchange((e) => notifications.onExchange(e));
 *   vscode.workspace.onDidChangeConfiguration((ev) => {
 *     if (ev.affectsConfiguration('flutterIntercept.notifications')) notifications.refreshLevel();
 *   });
 *   context.subscriptions.push(notifications);
 */
import type { Exchange } from '@flutter-intercept/proxy';
import type { Notice, NotifyLevel } from './types';
import { createNotifyPolicy, normalizeLevel, type TimedNotifyPolicy } from './policy';

export type { Notice, NotifyLevel, NotifyPolicy, NotifyPolicyOptions } from './types';
export { createNotifyPolicy, describeOutcome, describeRequest, isExcluded, isFailure, normalizeLevel } from './policy';
export type { TimedNotifyPolicy } from './policy';

export const SHOW = 'Show';
export const TURN_OFF = 'Turn off';

export interface NotifyDeps {
  /** Shows the notice with buttons; resolves to the clicked button (undefined when dismissed). */
  showMessage(text: string, ...buttons: string[]): PromiseLike<string | undefined>;
  /** Reveals the panel and selects the exchange (host → view `select {id}`). */
  reveal(exchangeId: string): void | PromiseLike<unknown>;
  /** Sets `flutterIntercept.notifications` to "off" in user settings. */
  turnOff(): void | PromiseLike<unknown>;
  /** The current `flutterIntercept.notifications` value (unknown values mean "errors"). */
  getLevel(): unknown;
  /** True while a panel copy is visible and the VS Code window is focused. */
  isPanelVisible(): boolean;
  /** Defaults to Date.now. */
  now?(): number;
  /** Defaults to the global timers. */
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Default 10 000 ms. */
  windowMs?: number;
  /** Errors from showing / acting on a notice (default: ignored). */
  onError?(err: unknown): void;
}

export interface Notifications {
  /** Feed every exchange update (new and changed). */
  onExchange(e: Exchange): void;
  /** Re-reads the level (call on configuration changes). */
  refreshLevel(): void;
  dispose(): void;
}

export function registerNotifications(deps: NotifyDeps): Notifications {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const report = (err: unknown) => {
    try {
      deps.onError?.(err);
    } catch {
      // never throw into the event source
    }
  };
  const readLevel = (): NotifyLevel => {
    try {
      return normalizeLevel(deps.getLevel());
    } catch (err) {
      report(err);
      return 'errors';
    }
  };
  const visible = (): boolean => {
    try {
      return deps.isPanelVisible();
    } catch (err) {
      report(err);
      return false;
    }
  };

  const policy: TimedNotifyPolicy = createNotifyPolicy({ level: readLevel(), windowMs: deps.windowMs });
  let timer: unknown;
  let disposed = false;

  const show = (n: Notice) => {
    let p: PromiseLike<string | undefined>;
    try {
      p = deps.showMessage(n.text, SHOW, TURN_OFF);
    } catch (err) {
      report(err);
      return;
    }
    Promise.resolve(p).then(
      async (choice) => {
        if (disposed) return;
        if (choice === SHOW) await deps.reveal(n.exchangeId);
        else if (choice === TURN_OFF) {
          policy.setLevel('off');
          await deps.turnOff();
        }
      },
      report,
    ).then(undefined, report);
  };

  const schedule = () => {
    if (disposed || timer !== undefined) return;
    const at = policy.nextFlushAt();
    if (at === undefined) return;
    timer = setTimer(() => {
      timer = undefined;
      if (disposed) return;
      const n = policy.flush(now(), visible());
      if (n) show(n);
      schedule(); // still waiting (clock skew, or the window moved): try again
    }, Math.max(0, at - now()));
  };

  return {
    onExchange(e) {
      if (disposed) return;
      try {
        const n = policy.onExchange(e, now(), visible());
        if (n) show(n);
        schedule();
      } catch (err) {
        report(err);
      }
    },
    refreshLevel() {
      policy.setLevel(readLevel());
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
