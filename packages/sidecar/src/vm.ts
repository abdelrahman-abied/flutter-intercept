/**
 * VM service access for sessions the plugin reports (CONTRACTS §11.4, §13.3, §14.7): there is no Dart-Code debug
 * adapter here, so everything goes over a direct WebSocket to the `vmServiceUri` the plugin passes in
 * `sessionStarted` (loopback only; the URI embeds an auth token and is never logged). Background-isolate interception
 * or warnings, native-client capture from the HTTP profile and bypass detection come from the extension's
 * session watcher (packages/extension/src/vm/watcher.ts) with its WebSocket transport; screenshots use
 * `callService` below.
 */
import { createSessionWatcher, type VmWatcherDeps } from '../../extension/src/vm/watcher';
import { connectWsTransport, defaultWebSocketCtor, isLoopbackWsUri, toWsUri, type WebSocketCtor } from '../../extension/src/vm/transport';
import type { VmWatcher } from '../../extension/src/vm/types';

export interface SidecarVm extends VmWatcher {
  /** A VM service method / extension for a session (screenshots). Rejects when the session has no usable URI. */
  callService(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export function createSidecarVm(deps: Omit<VmWatcherDeps, 'webSocket'> & { webSocket?: WebSocketCtor | null }): SidecarVm {
  const ws = deps.webSocket === null ? undefined : (deps.webSocket ?? defaultWebSocketCtor());
  const watcher = createSessionWatcher({ ...deps, webSocket: ws });
  const uris = new Map<string, string>();
  return {
    async attach(info) {
      if (info.vmServiceUri) uris.set(info.sessionId, info.vmServiceUri);
      await watcher.attach(info);
    },
    detach(id) {
      uris.delete(id);
      watcher.sessionEnded(id);
    },
    dispose() {
      uris.clear();
      watcher.dispose();
    },
    async callService(sessionId, method, params) {
      const uri = uris.get(sessionId);
      if (!uri) throw new Error('the IDE did not report a VM service for this session');
      if (!ws) throw new Error('no WebSocket implementation available');
      const wsUri = toWsUri(uri);
      if (!isLoopbackWsUri(wsUri)) throw new Error('the VM service is not on loopback');
      const t = await connectWsTransport(wsUri, ws, { timeoutMs: 5000, streams: [] });
      try {
        return await t.call(method, params ?? {});
      } finally {
        t.close();
      }
    },
  };
}
