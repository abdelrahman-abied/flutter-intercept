import type { HostMsg, ViewMsg } from './protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  // Injected by VSCode into webviews (and by dev/fake-host.ts in the browser harness).
  function acquireVsCodeApi(): VsCodeApi;
}

export interface Host {
  post(msg: ViewMsg): void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
  /** Subscribe to host → webview messages. Returns an unsubscribe function. */
  onMessage(listener: (msg: HostMsg) => void): () => void;
}

const HOST_TYPES = new Set(['snapshot', 'exchange', 'rules', 'status', 'removed', 'error', 'cleared', 'sent', 'contract']);

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
