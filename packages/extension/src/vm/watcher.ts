/**
 * Session bookkeeping for the VM watcher, vscode-free: which sessions are attached, their DAP request function
 * and VM service URI (from Dart-Code's `dart.debuggerUris` event), transport selection, start/stop.
 * src/vm/index.ts feeds it from `vscode.debug` events.
 */
import type { VmSessionInfo, VmWatcher } from './types';
import { createVmSessionCore, type VmCoreDeps, type VmSessionCore } from './core';
import {
  connectWsTransport,
  createDapTransport,
  isLoopbackWsUri,
  toWsUri,
  type DapTransport,
  type VmTransport,
  type WebSocketCtor,
} from './transport';

export type DapRequest = (command: string, args: unknown) => PromiseLike<unknown>;

export interface VmWatcherDeps extends VmCoreDeps {
  /** WebSocket constructor for the direct transport (profile mode); undefined = DAP only. */
  webSocket?: WebSocketCtor;
}

export interface SessionFeed {
  /** A Dart debug session started (or any of its custom events arrived first). */
  sessionStarted(sessionId: string, request: DapRequest): void;
  /** Every Dart-Code custom event of a session. */
  customEvent(sessionId: string, event: string, body: unknown, request?: DapRequest): void;
  sessionEnded(sessionId: string): void;
}

interface Entry {
  request?: DapRequest;
  vmServiceUri?: string;
  /** The DAP announced a service extension: its VM connection is up. */
  dapUp?: boolean;
  attached: boolean;
  starting?: boolean;
  core?: VmSessionCore;
  transport?: VmTransport;
  dap?: DapTransport;
}

const PROBE_TIMEOUT_MS = 5000;

function withTimeout<T>(p: PromiseLike<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: timeout`)), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function createSessionWatcher(deps: VmWatcherDeps): VmWatcher & SessionFeed {
  const entries = new Map<string, Entry>();
  let disposed = false;
  const entry = (id: string): Entry => {
    let e = entries.get(id);
    if (!e) entries.set(id, (e = { attached: false }));
    return e;
  };

  async function selectTransport(sessionId: string, e: Entry): Promise<VmTransport | undefined> {
    if (e.request) {
      const request = e.request;
      const dap = createDapTransport((c, a) => request(c, a));
      try {
        const vm = (await withTimeout(dap.call('getVM'), PROBE_TIMEOUT_MS, 'callService getVM')) as { isolates?: unknown } | undefined;
        if (vm && typeof vm === 'object' && Array.isArray(vm.isolates)) {
          e.dap = dap;
          return dap;
        }
        deps.log(`vm[${sessionId.slice(0, 8)}]: Dart-Code's callService gave no VM (profile mode?)`);
      } catch (err) {
        deps.log(`vm[${sessionId.slice(0, 8)}]: Dart-Code's callService unavailable: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      }
      dap.close();
    }
    if (e.vmServiceUri && deps.webSocket) {
      const uri = toWsUri(e.vmServiceUri);
      if (!isLoopbackWsUri(uri)) {
        deps.log(`vm[${sessionId.slice(0, 8)}]: VM service is not on loopback; not connecting`);
        return undefined;
      }
      try {
        return await connectWsTransport(uri, deps.webSocket, { timeoutMs: PROBE_TIMEOUT_MS });
      } catch (err) {
        deps.log(`vm[${sessionId.slice(0, 8)}]: VM service WebSocket failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      }
    }
    return undefined;
  }

  async function maybeStart(sessionId: string): Promise<void> {
    const e = entries.get(sessionId);
    if (!e || disposed || !e.attached || e.core || e.starting) return;
    if (!e.vmServiceUri && !e.dapUp) return; // the VM service isn't up yet: wait for dart.debuggerUris
    e.starting = true;
    try {
      const transport = await selectTransport(sessionId, e);
      if (!transport) {
        deps.log(`vm[${sessionId.slice(0, 8)}]: no VM service access: background-isolate warnings and native-client capture are off for this session`);
        return;
      }
      if (!e.attached || disposed || entries.get(sessionId) !== e) {
        transport.close();
        return;
      }
      e.transport = transport;
      e.core = createVmSessionCore(sessionId, deps);
      deps.log(`vm[${sessionId.slice(0, 8)}]: watching via ${transport.kind === 'dap' ? "Dart-Code's debug adapter" : 'the VM service WebSocket'}`);
      await e.core.start(transport);
    } catch (err) {
      deps.log(`vm[${sessionId.slice(0, 8)}]: start failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    } finally {
      e.starting = false;
    }
  }

  function detach(sessionId: string): void {
    const e = entries.get(sessionId);
    if (!e) return;
    const wasAttached = e.attached;
    e.attached = false;
    if (e.core) e.core.stop();
    else if (wasAttached) deps.setWarnings(sessionId, []);
    e.transport?.close();
    e.core = undefined;
    e.transport = undefined;
    e.dap = undefined;
  }

  return {
    async attach(info: VmSessionInfo): Promise<void> {
      if (disposed) return;
      const e = entry(info.sessionId);
      e.attached = true;
      if (info.vmServiceUri) e.vmServiceUri = info.vmServiceUri;
      await maybeStart(info.sessionId);
    },
    detach,
    dispose(): void {
      disposed = true;
      for (const id of [...entries.keys()]) detach(id);
      entries.clear();
    },
    sessionStarted(sessionId, request) {
      if (disposed) return;
      entry(sessionId).request ??= request;
    },
    customEvent(sessionId, event, body, request) {
      if (disposed) return;
      const e = entry(sessionId);
      if (request) e.request ??= request;
      if (event === 'dart.debuggerUris') {
        const uri = (body as { vmServiceUri?: unknown } | undefined)?.vmServiceUri;
        if (typeof uri === 'string' && uri) e.vmServiceUri = uri;
        void maybeStart(sessionId);
      } else if (event === 'dart.serviceExtensionAdded') {
        e.dap?.handleCustomEvent(event, body);
        if (!e.dapUp) {
          e.dapUp = true;
          void maybeStart(sessionId);
        }
      }
    },
    sessionEnded(sessionId) {
      detach(sessionId);
      entries.delete(sessionId);
    },
  };
}
