import type { HostMsg, ViewMsg } from './protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  // Injected by VSCode into webviews (and by dev/fake-host.ts in the browser harness).
  function acquireVsCodeApi(): VsCodeApi;
  interface Window {
    /** CONTRACTS §15.1: set by the sidecar's UI page (Android Studio / IntelliJ) — `ws://127.0.0.1:<port>/ws?t=<token>`. */
    __FI_WS__?: string;
  }
}

export interface Host {
  post(msg: ViewMsg): void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
  /** Subscribe to host → webview messages. Returns an unsubscribe function. */
  onMessage(listener: (msg: HostMsg) => void): () => void;
  /**
   * Transport state (WebSocket host only, CONTRACTS §15.1). The VS Code host has no connection to lose, so it doesn't
   * implement this. Listeners get the current state immediately. Returns an unsubscribe function.
   */
  onConnection?(listener: (state: ConnectionState) => void): () => void;
  /** WebSocket host only: skip the backoff wait and reconnect now. */
  reconnectNow?(): void;
}

/** `connecting` = first attempt, `open` = connected, `reconnecting` = lost (or never reached) and retrying. */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

const HOST_TYPES = new Set(['snapshot', 'exchange', 'rules', 'status', 'removed', 'error', 'cleared', 'sent', 'contract', 'recordings', 'authFlows', 'select', 'exported']);

export function isHostMsg(data: unknown): data is HostMsg {
  return typeof data === 'object' && data !== null && HOST_TYPES.has((data as { type?: unknown }).type as string);
}

let api: VsCodeApi | undefined;

/** acquireVsCodeApi may only be called once per webview, so it is memoised here. */
export function createVsCodeHost(): Host {
  if (!api) {
    api = typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : { postMessage: (m) => console.debug('[flutter-intercept] → host', m), getState: () => undefined, setState: () => {} };
  }
  const a = api;
  return {
    post: (msg) => a.postMessage(msg),
    getState: <T,>() => (a.getState() as T | undefined) ?? undefined,
    setState: (s) => a.setState(s),
    onMessage(listener) {
      const h = (ev: MessageEvent) => { if (isHostMsg(ev.data)) listener(ev.data); };
      window.addEventListener('message', h);
      return () => window.removeEventListener('message', h);
    },
  };
}

/**
 * Picks the transport (CONTRACTS §15.1): the VS Code webview API when present (unchanged behaviour), otherwise the
 * sidecar's WebSocket when the page set `window.__FI_WS__` (Android Studio / IntelliJ JCEF), otherwise the logging stub.
 */
export function createHost(): Host {
  if (typeof acquireVsCodeApi === 'function') return createVsCodeHost();
  const url = wsUrl();
  return url ? createWebSocketHost(url) : createVsCodeHost();
}

/** The sidecar WebSocket URL when running standalone (no VS Code API), else undefined. */
export function wsUrl(): string | undefined {
  if (typeof acquireVsCodeApi === 'function' || typeof window === 'undefined') return undefined;
  const u = window.__FI_WS__;
  return typeof u === 'string' && u ? u : undefined;
}

/**
 * Standalone mode (the UI may open in the system browser): drops the `t` (token) query parameter from the address bar
 * with history.replaceState, keeping the path, the other parameters and the hash, so the token doesn't linger in the
 * visible URL or the history entry. The token is never stored; the WebSocket URL comes from `window.__FI_WS__`.
 */
export function scrubTokenFromAddressBar(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has('t')) return;
    u.searchParams.delete('t');
    history.replaceState(history.state, '', `${u.pathname}${u.search}${u.hash}`);
  } catch { /* opaque or odd URL: leave it */ }
}

// ---------------------------------------------------------------- WebSocket transport (CONTRACTS §15.1)

export const WS_STATE_KEY = 'flutterIntercept.webviewState';
/** Outgoing messages kept while disconnected; the oldest are dropped beyond this (the host re-sends a snapshot anyway). */
export const WS_QUEUE_MAX = 200;
export const WS_BACKOFF_MIN_MS = 250;
export const WS_BACKOFF_MAX_MS = 5000;

/** Delay before reconnect attempt `n` (0-based): 250 ms doubling, capped at 5 s. */
export function backoffMs(attempt: number): number {
  return Math.min(WS_BACKOFF_MAX_MS, WS_BACKOFF_MIN_MS * 2 ** Math.min(attempt, 16));
}

type WsCtor = new (url: string) => WebSocket;

export interface WebSocketHostOptions {
  /** Injected in tests; defaults to the global WebSocket. */
  WebSocket?: WsCtor;
  /** Injected in tests; defaults to sessionStorage (absent / throwing storage just disables persistence). */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export interface WebSocketHost extends Host {
  onConnection(listener: (state: ConnectionState) => void): () => void;
  reconnectNow(): void;
  /** Stops for good (closes the socket, no more reconnects). */
  close(): void;
  readonly state: ConnectionState;
}

const OPEN = 1;

/**
 * HostMsg / ViewMsg as JSON text frames over the sidecar's WebSocket, with the same semantics as the VS Code host:
 * `ready` is (re)sent on every connect once the app asked for it (the sidecar answers with a snapshot, so a reconnect
 * resyncs everything); other messages posted while disconnected are queued (bounded) and flushed in order on connect;
 * reconnects back off 250 ms → 5 s. UI state persists in sessionStorage. The URL carries the session token: it is
 * never logged.
 */
export function createWebSocketHost(url: string, opts: WebSocketHostOptions = {}): WebSocketHost {
  const Ctor: WsCtor | undefined = opts.WebSocket ?? (typeof WebSocket === 'function' ? WebSocket : undefined);
  let storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined = opts.storage;
  if (storage === undefined) {
    try { storage = typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { storage = null; }
  }
  const messageListeners = new Set<(msg: HostMsg) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let queue: string[] = [];
  let readyRequested = false;
  let ws: WebSocket | undefined;
  let state: ConnectionState = 'connecting';
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const setState = (s: ConnectionState) => {
    if (s === state) return;
    state = s;
    for (const l of [...stateListeners]) l(s);
  };

  const sendNow = (data: string): boolean => {
    if (!ws || ws.readyState !== OPEN) return false;
    try { ws.send(data); return true; } catch { return false; }
  };

  const enqueue = (data: string) => {
    queue.push(data);
    if (queue.length > WS_QUEUE_MAX) queue.splice(0, queue.length - WS_QUEUE_MAX);
  };

  const schedule = () => {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; connect(); }, backoffMs(attempt));
    attempt++;
  };

  const lost = (sock: WebSocket) => {
    if (sock !== ws) return; // a stale socket replaced by reconnectNow()
    ws = undefined;
    if (closed) return;
    setState('reconnecting');
    schedule();
  };

  function connect() {
    if (closed) return;
    if (!Ctor) { setState('reconnecting'); return; }
    let sock: WebSocket;
    try {
      sock = new Ctor(url);
    } catch {
      setState('reconnecting');
      schedule();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (sock !== ws) return;
      attempt = 0;
      const pending = queue;
      queue = [];
      if (readyRequested) sendNow(JSON.stringify({ type: 'ready' } satisfies ViewMsg));
      for (let i = 0; i < pending.length; i++) {
        if (!sendNow(pending[i])) { queue = pending.slice(i).concat(queue); break; }
      }
      setState('open');
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (sock !== ws || typeof ev.data !== 'string') return;
      let data: unknown;
      try { data = JSON.parse(ev.data); } catch { return; }
      if (!isHostMsg(data)) return;
      for (const l of [...messageListeners]) l(data);
    };
    sock.onclose = () => lost(sock);
    sock.onerror = () => { /* a close event follows */ };
  }

  const host: WebSocketHost = {
    get state() { return state; },
    post(msg) {
      if (closed) return;
      if (msg.type === 'ready') {
        // Sent on every (re)connect from now on; never queued, so a reconnect sends exactly one.
        readyRequested = true;
        sendNow(JSON.stringify(msg));
        return;
      }
      const data = JSON.stringify(msg);
      if (!sendNow(data)) enqueue(data);
    },
    getState<T>() {
      try {
        const raw = storage?.getItem(WS_STATE_KEY);
        return raw ? (JSON.parse(raw) as T) : undefined;
      } catch { return undefined; }
    },
    setState(s) {
      try { storage?.setItem(WS_STATE_KEY, JSON.stringify(s)); } catch { /* quota / disabled storage: non-critical */ }
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => { messageListeners.delete(listener); };
    },
    onConnection(listener) {
      stateListeners.add(listener);
      listener(state);
      return () => { stateListeners.delete(listener); };
    },
    reconnectNow() {
      if (closed || state === 'open') return;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      const old = ws;
      ws = undefined;
      if (old) { try { old.close(); } catch { /* ignore */ } }
      connect();
    },
    close() {
      closed = true;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      const old = ws;
      ws = undefined;
      if (old) { try { old.close(); } catch { /* ignore */ } }
    },
  };
  connect();
  return host;
}
