// @vitest-environment happy-dom
// v0.9.0 (CONTRACTS §15.1): the WebSocket host used in Android Studio / IntelliJ — connect, `ready` on every
// (re)connect, backoff, the bounded outgoing queue, message dispatch, sessionStorage persistence — and the VS Code
// host staying exactly as it was when acquireVsCodeApi exists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffMs, createHost, scrubTokenFromAddressBar, createWebSocketHost, wsUrl, WS_BACKOFF_MAX_MS, WS_QUEUE_MAX, WS_STATE_KEY, type ConnectionState,
} from '../src/host';
import type { HostMsg } from '../src/protocol';

const URL_ = 'ws://127.0.0.1:43210/ws?t=secret-token';

class FakeSocket {
  static all: FakeSocket[] = [];
  static get last() { return FakeSocket.all[FakeSocket.all.length - 1]; }
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(data); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({} as CloseEvent); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.({} as Event); }
  drop() { this.readyState = 3; this.onerror?.({} as Event); this.onclose?.({} as CloseEvent); }
  receive(data: unknown) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent); }
  get msgs() { return this.sent.map((s) => JSON.parse(s)); }
}

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

const mk = (storage: ReturnType<typeof memStorage> | null = memStorage()) =>
  createWebSocketHost(URL_, { WebSocket: FakeSocket as unknown as new (u: string) => WebSocket, storage });

beforeEach(() => { FakeSocket.all = []; vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  delete (window as { __FI_WS__?: string }).__FI_WS__;
  delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
});

describe('WebSocket host: connect and ready', () => {
  it('connects to the page URL and sends ready once open', () => {
    const h = mk();
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.last.url).toBe(URL_);
    expect(h.state).toBe('connecting');
    h.post({ type: 'ready' });                     // the App posts ready before the socket opens
    expect(FakeSocket.last.sent).toEqual([]);
    FakeSocket.last.open();
    expect(h.state).toBe('open');
    expect(FakeSocket.last.msgs).toEqual([{ type: 'ready' }]);
  });

  it('does not send ready on connect before the app asked for it (no snapshot to a missing listener)', () => {
    const h = mk();
    FakeSocket.last.open();
    expect(FakeSocket.last.sent).toEqual([]);
    h.post({ type: 'ready' });                     // posted while open: sent straight away
    expect(FakeSocket.last.msgs).toEqual([{ type: 'ready' }]);
  });

  it('re-sends exactly one ready on every reconnect', () => {
    const h = mk();
    h.post({ type: 'ready' });
    FakeSocket.last.open();
    FakeSocket.last.drop();
    expect(h.state).toBe('reconnecting');
    vi.advanceTimersByTime(backoffMs(0));
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.last.open();
    expect(h.state).toBe('open');
    expect(FakeSocket.last.msgs).toEqual([{ type: 'ready' }]);
  });
});

describe('WebSocket host: reconnect with backoff', () => {
  it('backs off 250 ms doubling, capped at 5 s, and resets after a successful connect', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
    expect(WS_BACKOFF_MAX_MS).toBe(5000);
    mk();
    FakeSocket.last.drop();                        // never opened: the sidecar isn't up yet
    vi.advanceTimersByTime(249);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.last.drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    for (let i = 0; i < 10; i++) { FakeSocket.last.drop(); vi.advanceTimersByTime(5000); }
    expect(FakeSocket.all).toHaveLength(13);       // capped: one attempt per 5 s at most
    FakeSocket.last.open();
    FakeSocket.last.drop();
    vi.advanceTimersByTime(250);                   // reset after the successful connect
    expect(FakeSocket.all).toHaveLength(14);
  });

  it('reports connection states to listeners (current state first) and reconnectNow skips the wait', () => {
    const h = mk();
    const seen: ConnectionState[] = [];
    const off = h.onConnection((s) => seen.push(s));
    FakeSocket.last.open();
    FakeSocket.last.drop();
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(backoffMs(i)); FakeSocket.last.drop(); }
    const n = FakeSocket.all.length;
    h.reconnectNow();
    expect(FakeSocket.all).toHaveLength(n + 1);
    FakeSocket.last.open();
    expect(seen).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    off();
    FakeSocket.last.drop();
    expect(seen).toHaveLength(4);
  });

  it('a constructor that throws (bad URL) is retried, and close() stops for good', () => {
    let fail = true;
    class Throwing extends FakeSocket { constructor(u: string) { if (fail) throw new Error('boom'); super(u); } }
    const h = createWebSocketHost(URL_, { WebSocket: Throwing as unknown as new (u: string) => WebSocket, storage: null });
    expect(h.state).toBe('reconnecting');
    fail = false;
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(1);
    h.close();
    expect(FakeSocket.last.readyState).toBe(3);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    h.post({ type: 'clear' });                     // ignored after close
  });
});

describe('WebSocket host: outgoing queue', () => {
  it('queues messages while disconnected and flushes them in order after ready', () => {
    const h = mk();
    h.post({ type: 'ready' });
    h.post({ type: 'clear' });
    h.post({ type: 'setInterceptEnabled', enabled: false });
    FakeSocket.last.open();
    expect(FakeSocket.last.msgs).toEqual([{ type: 'ready' }, { type: 'clear' }, { type: 'setInterceptEnabled', enabled: false }]);
    FakeSocket.last.drop();
    h.post({ type: 'abort', id: 'x1' });
    vi.advanceTimersByTime(250);
    FakeSocket.last.open();
    expect(FakeSocket.last.msgs).toEqual([{ type: 'ready' }, { type: 'abort', id: 'x1' }]);
  });

  it('is bounded: the oldest messages are dropped', () => {
    const h = mk();
    for (let i = 0; i < WS_QUEUE_MAX + 50; i++) h.post({ type: 'abort', id: `a${i}` });
    h.post({ type: 'ready' });
    h.post({ type: 'ready' });                     // ready is never queued twice
    FakeSocket.last.open();
    const msgs = FakeSocket.last.msgs;
    expect(msgs).toHaveLength(WS_QUEUE_MAX + 1);
    expect(msgs[0]).toEqual({ type: 'ready' });
    expect(msgs[1]).toEqual({ type: 'abort', id: 'a50' });
    expect(msgs[msgs.length - 1]).toEqual({ type: 'abort', id: `a${WS_QUEUE_MAX + 49}` });
  });

  it('sends immediately while open', () => {
    const h = mk();
    FakeSocket.last.open();
    h.post({ type: 'clear' });
    expect(FakeSocket.last.msgs).toEqual([{ type: 'clear' }]);
  });
});

describe('WebSocket host: incoming messages', () => {
  it('dispatches HostMsg JSON to every listener and ignores junk', () => {
    const h = mk();
    const a: HostMsg[] = [];
    const b: HostMsg[] = [];
    h.onMessage((m) => a.push(m));
    const offB = h.onMessage((m) => b.push(m));
    FakeSocket.last.open();
    FakeSocket.last.receive({ type: 'cleared' });
    FakeSocket.last.receive('not json');
    FakeSocket.last.receive({ type: 'evil' });
    FakeSocket.last.receive(42);
    offB();
    FakeSocket.last.receive({ type: 'removed', ids: ['1'] });
    expect(a).toEqual([{ type: 'cleared' }, { type: 'removed', ids: ['1'] }]);
    expect(b).toEqual([{ type: 'cleared' }]);
  });

  it('ignores messages from a socket that was replaced', () => {
    const h = mk();
    const got: HostMsg[] = [];
    h.onMessage((m) => got.push(m));
    const first = FakeSocket.last;
    first.drop();
    h.reconnectNow();
    first.receive({ type: 'cleared' });
    expect(got).toEqual([]);
  });
});

describe('WebSocket host: persistence', () => {
  it('uses the given storage under one key, tolerating junk and quota errors', () => {
    const st = memStorage();
    const h = mk(st);
    expect(h.getState()).toBeUndefined();
    h.setState({ view: 'rules' });
    expect(JSON.parse(st.m.get(WS_STATE_KEY)!)).toEqual({ view: 'rules' });
    expect(h.getState()).toEqual({ view: 'rules' });
    st.m.set(WS_STATE_KEY, '{nope');
    expect(h.getState()).toBeUndefined();
    const full = createWebSocketHost(URL_, {
      WebSocket: FakeSocket as unknown as new (u: string) => WebSocket,
      storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } },
    });
    expect(() => full.setState({ a: 1 })).not.toThrow();
    expect(full.getState()).toBeUndefined();
  });

  it('defaults to sessionStorage', () => {
    sessionStorage.removeItem(WS_STATE_KEY);
    const h = createWebSocketHost(URL_, { WebSocket: FakeSocket as unknown as new (u: string) => WebSocket });
    h.setState({ splitPct: 40 });
    expect(JSON.parse(sessionStorage.getItem(WS_STATE_KEY)!)).toEqual({ splitPct: 40 });
    expect(h.getState()).toEqual({ splitPct: 40 });
  });
});

describe('createHost: picking the transport', () => {
  it('uses the WebSocket when acquireVsCodeApi is absent and the page set __FI_WS__', () => {
    const orig = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
    try {
      window.__FI_WS__ = URL_;
      expect(wsUrl()).toBe(URL_);
      const h = createHost();
      expect(typeof h.onConnection).toBe('function');
      expect(FakeSocket.last.url).toBe(URL_);
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = orig;
    }
  });

  it('keeps the VS Code host when acquireVsCodeApi exists, even with __FI_WS__ set', async () => {
    const posted: unknown[] = [];
    let saved: unknown = { view: 'rules' };
    const api = { postMessage: (m: unknown) => posted.push(m), getState: () => saved, setState: (s: unknown) => { saved = s; } };
    const acquire = vi.fn(() => api);
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = acquire;
    window.__FI_WS__ = URL_;
    expect(wsUrl()).toBeUndefined();
    const h = createHost();
    expect(h.onConnection).toBeUndefined();
    expect(FakeSocket.all).toHaveLength(0);
    h.post({ type: 'ready' });
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(h.getState()).toEqual({ view: 'rules' });
    h.setState({ view: 'traffic' });
    expect(saved).toEqual({ view: 'traffic' });
    const got: HostMsg[] = [];
    const off = h.onMessage((m) => got.push(m));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'cleared' } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'nope' } }));
    off();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'cleared' } }));
    expect(got).toEqual([{ type: 'cleared' }]);
    createHost();
    expect(acquire).toHaveBeenCalledTimes(1);      // still memoised: acquireVsCodeApi may only be called once
  });

  it('without either, wsUrl is undefined', () => {
    expect(wsUrl()).toBeUndefined();
  });
});

describe('scrubTokenFromAddressBar (standalone mode, system browser)', () => {
  it('removes only the t parameter, keeping path, other parameters and hash, without storing it', () => {
    history.replaceState(null, '', '/ui/index.html?a=1&t=secret-token&b=2#frag');
    // Node's own (flag-gated) localStorage can shadow happy-dom's as undefined: check whichever stores exist.
    const stores = [window.sessionStorage, window.localStorage].filter((x): x is Storage => !!x);
    for (const st of stores) st.clear();
    scrubTokenFromAddressBar();
    expect(location.pathname).toBe('/ui/index.html');
    expect(location.search).toBe('?a=1&b=2');
    expect(location.hash).toBe('#frag');
    expect(location.href).not.toMatch(/secret-token/);
    const stored = stores.flatMap((s) => Object.keys(s).map((k) => s.getItem(k)));
    expect(stored.join()).not.toMatch(/secret-token/);
  });

  it('leaves the URL alone when there is no t parameter, and drops a lone ?t=', () => {
    history.replaceState(null, '', '/?x=1#h');
    const spy = vi.spyOn(history, 'replaceState');
    scrubTokenFromAddressBar();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    history.replaceState(null, '', '/?t=abc');
    scrubTokenFromAddressBar();
    expect(location.pathname + location.search + location.hash).toBe('/');
  });
});
