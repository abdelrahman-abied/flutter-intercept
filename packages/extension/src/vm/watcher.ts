/**
 * Session bookkeeping for the VM watcher, vscode-free: which sessions are attached, their DAP request function
 * and VM service URI (from Dart-Code's `dart.debuggerUris` event), transport selection, start/stop.
 * src/vm/index.ts feeds it from `vscode.debug` events.
 */
import type { VmSessionInfo, VmWatcher } from './types';
import { createVmSessionCore, type VmCoreDeps, type VmSessionCore } from './core';
import { createIsolateInstaller, type IsolateInstaller } from './isolates';
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

export interface VmWatcherDeps extends Omit<VmCoreDeps, 'nativeRouted' | 'nativeRouteFailed'> {
  /** CONTRACTS §14.7: the host routes this session's native clients through the proxy (Android emulator global proxy). */
  nativeRouted?(sessionId: string): boolean;
  /** CONTRACTS §14.7: a routed native client of this session rejected the proxy's certificate: stop routing it. */
  nativeRouteFailed?(sessionId: string, client: string | undefined): void;
  /** WebSocket constructor for the direct transport (profile mode, background-isolate install); undefined = DAP only. */
  webSocket?: WebSocketCtor;
  /** Per-isolate budget of the background-isolate installer, ms (tests). */
  isolateBudgetMs?: number;
}

/** How long the core waits for the installer to have seen an isolate it learnt about from the DAP. */
const INSTALL_STATUS_WAIT_MS = 500;

export interface SessionFeed {
  /** A Dart debug session started (or any of its custom events arrived first). */
  sessionStarted(sessionId: string, request: DapRequest): void;
  /** Every Dart-Code custom event of a session. */
  customEvent(sessionId: string, event: string, body: unknown, request?: DapRequest): void;
  sessionEnded(sessionId: string): void;
  /**
   * A VM service method / extension through the session's Dart-Code debug adapter (`callService`), e.g. for
   * screenshots (src/screenshot). Rejects for an unknown session, or when the adapter answered without a body
   * (profile mode: no VM connection in the DAP).
   */
  callService(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
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
  /** CONTRACTS §13.3: our own DDS client holding new isolates at start to install the entry's overrides. */
  installer?: IsolateInstaller;
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

  /**
   * CONTRACTS §13.3 (docs/spikes/background-isolates.md): started as soon as the VM service URI is known, in
   * parallel with the transport probe, when `backgroundIsolates` is "intercept" at that point. Needs the direct
   * WebSocket (DDS resume permissions are per client: the DAP's own connection can't be used). In profile mode
   * isolates never pause at start, so it simply never installs (the warnings stay).
   */
  function maybeStartInstaller(sessionId: string): void {
    const e = entries.get(sessionId);
    if (!e || disposed || !e.attached || e.installer || !e.vmServiceUri || !deps.webSocket) return;
    let mode: 'intercept' | 'warn' = 'intercept';
    try {
      mode = deps.backgroundIsolates?.() === 'warn' ? 'warn' : 'intercept';
    } catch {
      mode = 'warn';
    }
    if (mode !== 'intercept') return;
    const uri = toWsUri(e.vmServiceUri);
    if (!isLoopbackWsUri(uri)) return; // logged by the transport selection
    const installer = createIsolateInstaller(sessionId, {
      log: deps.log,
      backgroundIsolates: deps.backgroundIsolates,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
      budgetMs: deps.isolateBudgetMs,
    });
    e.installer = installer;
    const ws = deps.webSocket;
    void (async () => {
      let t: VmTransport;
      try {
        // The installer subscribes to the Debug stream itself (mandatory before it takes resume permissions).
        t = await connectWsTransport(uri, ws, { timeoutMs: PROBE_TIMEOUT_MS, streams: [] });
      } catch (err) {
        deps.log(`vm[${sessionId.slice(0, 8)}]: background isolates can't be intercepted (VM service WebSocket: ${String((err as Error)?.message ?? err).slice(0, 160)})`);
        if (e.installer === installer) e.installer = undefined;
        installer.stop();
        return;
      }
      if (e.installer !== installer || !e.attached || disposed) {
        t.close();
        return;
      }
      if (await installer.start(t)) deps.log(`vm[${sessionId.slice(0, 8)}]: background isolates: installing the entry's overrides at isolate start`);
    })();
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
      const { nativeRouted, nativeRouteFailed, ...coreDeps } = deps;
      e.core = createVmSessionCore(sessionId, {
        ...coreDeps,
        nativeRouted: nativeRouted ? () => nativeRouted(sessionId) : undefined,
        nativeRouteFailed: nativeRouteFailed ? (client) => nativeRouteFailed(sessionId, client) : undefined,
        installStatus: (isolateId) => (e.installer ? e.installer.status(isolateId, INSTALL_STATUS_WAIT_MS) : Promise.resolve(undefined)),
      });
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
    e.installer?.stop();
    e.core = undefined;
    e.transport = undefined;
    e.dap = undefined;
    e.installer = undefined;
  }

  return {
    async attach(info: VmSessionInfo): Promise<void> {
      if (disposed) return;
      const e = entry(info.sessionId);
      e.attached = true;
      if (info.vmServiceUri) e.vmServiceUri = info.vmServiceUri;
      maybeStartInstaller(info.sessionId);
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
        maybeStartInstaller(sessionId);
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
    async callService(sessionId, method, params) {
      const request = entries.get(sessionId)?.request;
      if (!request) throw new Error('not a running Dart debug session');
      const body = await request('callService', { method, params: params ?? {} });
      if (body === undefined || body === null) throw new Error(`${method}: no answer from the debug adapter (profile mode?)`);
      return body;
    },
  };
}
