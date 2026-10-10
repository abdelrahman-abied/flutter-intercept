/**
 * VM service watcher for Dart debug sessions (CONTRACTS §11.4): background-isolate interception at isolate start
 * (§13.3, src/vm/isolates.ts) or warnings, and read-only import of native-client traffic (package:http_profile) from
 * the app's HTTP profile. Thin vscode layer over watcher.ts /
 * core.ts. Create it once at activation; listener order doesn't matter (it also learns a session from its custom
 * events, and only starts once Dart-Code sent `dart.debuggerUris`). docs/spikes/vm-service.md.
 */
import * as vscode from 'vscode';
import type { VmHostDeps, VmWatcher } from './types';
import type { NativeClientsMode } from './core';
import { createSessionWatcher } from './watcher';
import { defaultWebSocketCtor, type WebSocketCtor } from './transport';

export type { NativeClientsMode } from './core';

export interface CreateVmWatcherDeps extends VmHostDeps {
  /** `flutterIntercept.nativeClients`: "profile" (default) | "off". Read on every poll. */
  nativeClients(): NativeClientsMode;
  /** Optional: poll only while the panel or an agent is watching (entries are caught up afterwards). */
  isWatched?(): boolean;
  /** Whether a dart:io `proxyDetails` host:port is our proxy (background-isolate dedupe); absent = never. */
  isOurProxy?(host: string, port: number): boolean;
  /** Direct VM service WebSocket for profile mode; default: global WebSocket, else the bundled `ws`. null = off. */
  webSocket?: WebSocketCtor | null;
}

export interface VmWatcherHandle extends VmWatcher {
  dispose(): void;
  /**
   * VM service call through a Dart session's debug adapter (Dart-Code `callService`); fits
   * `ScreenshotDeps.callService` (src/screenshot). Works for any Dart debug session, attached or not.
   */
  callService(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** The same call for a `vscode.DebugSession` you already hold. */
export async function vmCallService(session: vscode.DebugSession, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const body: unknown = await session.customRequest('callService', { method, params: params ?? {} });
  if (body === undefined || body === null) throw new Error(`${method}: no answer from the debug adapter (profile mode?)`);
  return body;
}

export function createVmWatcher(deps: CreateVmWatcherDeps): VmWatcherHandle {
  const watcher = createSessionWatcher({
    ...deps,
    webSocket: deps.webSocket === null ? undefined : (deps.webSocket ?? defaultWebSocketCtor()),
  });
  const requestOf = (s: vscode.DebugSession) => (command: string, args: unknown) => s.customRequest(command, args);
  const subs: vscode.Disposable[] = [
    vscode.debug.onDidStartDebugSession((s) => {
      if (s.type === 'dart') watcher.sessionStarted(s.id, requestOf(s));
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
      if (e.session.type !== 'dart') return;
      watcher.customEvent(e.session.id, e.event, e.body, requestOf(e.session));
    }),
    vscode.debug.onDidTerminateDebugSession((s) => watcher.sessionEnded(s.id)),
  ];
  return {
    attach: (info) => watcher.attach(info),
    detach: (id) => watcher.detach(id),
    callService: (id, method, params) => watcher.callService(id, method, params),
    dispose: () => {
      for (const s of subs.splice(0)) s.dispose();
      watcher.dispose();
    },
  };
}
