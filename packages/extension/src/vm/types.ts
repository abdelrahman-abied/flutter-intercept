/**
 * VM service access for a running Dart/Flutter debug session (CONTRACTS §11.4). Shared types, lead-owned.
 * Implemented in src/vm/** (spike first: Dart-Code's DAP `callService` custom request vs a direct VM service
 * WebSocket from the `dart.debuggerUris` event).
 */
import type { Exchange } from '@flutter-intercept/proxy';

export interface VmSessionInfo {
  sessionId: string;   // vscode.DebugSession.id
  vmServiceUri?: string; // never logged with its auth token path segment
}

/** What the VM layer needs from the host. */
export interface VmHostDeps {
  /** Adds read-only exchanges captured from the app's HTTP profile (InterceptProxy.record). Returns their ids. */
  record(exchanges: Omit<Exchange, 'id'>[]): string[];
  /** Updates a previously recorded exchange (e.g. the response arrived). */
  update(id: string, patch: Partial<Exchange>): void;
  /** Session warnings for Status.warnings (replace the full set for this session). */
  setWarnings(sessionId: string, warnings: import('../ui/protocol').SessionWarning[]): void;
  log(msg: string): void;
  /**
   * CONTRACTS §13.3: setting `flutterIntercept.backgroundIsolates` — `"intercept"` installs the entry's overrides in
   * new isolates of intercepted sessions (debug mode); `"warn"` only warns (v0.5.0 behaviour). Read on each isolate.
   */
  backgroundIsolates?(): 'intercept' | 'warn';
}

export interface VmWatcher {
  /** Start watching a debug session (called once the session runs our entry, or any Dart session for isolates). */
  attach(session: VmSessionInfo): Promise<void>;
  detach(sessionId: string): void;
  dispose(): void;
}
