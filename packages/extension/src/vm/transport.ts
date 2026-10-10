/**
 * Two ways to reach a session's VM service (docs/spikes/vm-service.md), both without vscode imports:
 * - `dap`: Dart-Code's debug adapter custom request `callService {method, params}` (SDK DAP and Dart-Code's
 *   legacy adapter). Isolates are learnt from the `dart.serviceExtensionAdded` custom event (no names: the core
 *   asks `getIsolate`). Not available in profile mode: the Flutter DAP does not connect a debugger there.
 * - `ws`: a direct JSON-RPC WebSocket to the `vmServiceUri` of the `dart.debuggerUris` event (loopback only),
 *   streaming `Isolate` events (names included). Used when `dap` doesn't answer (profile mode).
 */

export type VmTransportEvent =
  | { kind: 'isolate-start'; isolateId: string; name?: string }
  | { kind: 'isolate-exit'; isolateId: string }
  | { kind: 'extension-added'; isolateId: string; rpc: string }
  /** `Debug` stream (only when subscribed, see `connectWsTransport` `streams`): an isolate paused at start. */
  | { kind: 'pause-start'; isolateId: string; name?: string }
  | { kind: 'closed' };

export interface VmTransport {
  readonly kind: 'dap' | 'ws';
  /** A VM service method or a service extension (`ext.*`, with `isolateId` in params). Rejects on errors. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (e: VmTransportEvent) => void): () => void;
  close(): void;
}

class Emitter {
  private listeners = new Set<(e: VmTransportEvent) => void>();
  on(l: (e: VmTransportEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: VmTransportEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* a listener's bug must not break the transport */
      }
    }
  }
}

/** DAP transport. `request` = `session.customRequest`; feed it the session's Dart-Code custom events. */
export interface DapTransport extends VmTransport {
  readonly kind: 'dap';
  /** Pass every custom event of the session (`vscode.debug.onDidReceiveDebugSessionCustomEvent`). */
  handleCustomEvent(event: string, body: unknown): void;
}

export function createDapTransport(request: (command: string, args: unknown) => PromiseLike<unknown>): DapTransport {
  const events = new Emitter();
  let closed = false;
  return {
    kind: 'dap',
    async call(method, params) {
      if (closed) throw new Error('transport closed');
      return await request('callService', { method, params: params ?? {} });
    },
    onEvent: (l) => events.on(l),
    handleCustomEvent(event, body) {
      if (closed || event !== 'dart.serviceExtensionAdded' || !body || typeof body !== 'object') return;
      const { extensionRPC, isolateId } = body as { extensionRPC?: unknown; isolateId?: unknown };
      if (typeof extensionRPC === 'string' && typeof isolateId === 'string') events.emit({ kind: 'extension-added', isolateId, rpc: extensionRPC });
    },
    close() {
      if (closed) return;
      closed = true;
      events.emit({ kind: 'closed' });
    },
  };
}

/** The subset of the WHATWG / `ws` WebSocket API used here. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

/** Only the local VM service / DDS (flutter forwards device ports to loopback). */
export function isLoopbackWsUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** http://host:port/token=/ → ws://host:port/token=/ws (the `dart.debuggerUris` event already sends ws:…/ws). */
export function toWsUri(uri: string): string {
  if (/^https?:/i.test(uri)) {
    const u = uri.replace(/^http/i, 'ws');
    return u.endsWith('/ws') ? u : `${u.replace(/\/+$/, '')}/ws`;
  }
  return uri;
}

/**
 * Opens the WebSocket, subscribes to `streams` (default the Isolate stream). Never logs the URI (it embeds the auth
 * token).
 */
export async function connectWsTransport(uri: string, Ctor: WebSocketCtor, opts: { timeoutMs?: number; streams?: ('Isolate' | 'Debug')[] } = {}): Promise<VmTransport> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const events = new Emitter();
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  let closed = false;
  const ws = new Ctor(toWsUri(uri));
  const fail = (why: string) => {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
    events.emit({ kind: 'closed' });
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('VM service WebSocket: connect timeout'));
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('VM service WebSocket: connection failed'));
    };
  });
  ws.onerror = () => fail('VM service WebSocket error');
  ws.onclose = () => fail('VM service WebSocket closed');
  ws.onmessage = (ev) => {
    let msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: string; data?: { details?: string } }; method?: string; params?: { streamId?: string; event?: Record<string, unknown> } };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(String(msg.id))) {
      const p = pending.get(String(msg.id))!;
      pending.delete(String(msg.id));
      if (msg.error) p.reject(Object.assign(new Error(msg.error.data?.details || msg.error.message || 'VM service error'), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'streamNotify' && msg.params?.streamId === 'Debug' && msg.params.event) {
      const e = msg.params.event as { kind?: string; isolate?: { id?: string; name?: string } };
      const isolateId = e.isolate?.id;
      if (e.kind === 'PauseStart' && typeof isolateId === 'string') events.emit({ kind: 'pause-start', isolateId, name: typeof e.isolate?.name === 'string' ? e.isolate.name : undefined });
      return;
    }
    if (msg.method === 'streamNotify' && msg.params?.streamId === 'Isolate' && msg.params.event) {
      const e = msg.params.event as { kind?: string; isolate?: { id?: string; name?: string }; extensionRPC?: string };
      const isolateId = e.isolate?.id;
      if (typeof isolateId !== 'string') return;
      if (e.kind === 'IsolateStart') events.emit({ kind: 'isolate-start', isolateId, name: typeof e.isolate?.name === 'string' ? e.isolate.name : undefined });
      else if (e.kind === 'IsolateExit') events.emit({ kind: 'isolate-exit', isolateId });
      else if (e.kind === 'ServiceExtensionAdded' && typeof e.extensionRPC === 'string') events.emit({ kind: 'extension-added', isolateId, rpc: e.extensionRPC });
    }
  };
  const transport: VmTransport = {
    kind: 'ws',
    call(method, params) {
      if (closed) return Promise.reject(new Error('transport closed'));
      const id = String(next++);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
        } catch (e) {
          pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    onEvent: (l) => events.on(l),
    close() {
      if (closed) return;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fail('transport closed');
    },
  };
  for (const streamId of opts.streams ?? ['Isolate']) {
    try {
      await transport.call('streamListen', { streamId });
    } catch {
      // "Stream already subscribed" is fine; otherwise there are no such events, but calls still work.
    }
  }
  return transport;
}

/** The global WebSocket (Node ≥ 22 / recent Electron), else the `ws` package bundled through mockttp. */
export function defaultWebSocketCtor(): WebSocketCtor | undefined {
  const g = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (typeof g === 'function') return g;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ws') as WebSocketCtor;
  } catch {
    return undefined;
  }
}
