// A size limit for WebSocket messages through the proxy (REVIEW-5 #1). mockttp creates the upstream side with
// `maxPayload: 0` (and a PerMessageDeflate without a limit), so one small compressed message from a server can
// inflate to gigabytes inside the extension host; the app side keeps ws's 100 MiB default. We wrap the `ws`
// WebSocket#setSocket (the one `ws` in the tree, also in the bundle) and, for the proxy's two kinds of sockets
// only, cap the receiver's maxPayload and every negotiated extension's _maxPayload (permessage-deflate checks it
// while inflating). An oversized message makes ws close that side with 1009; the proxy closes the other side
// with 1009 too and records the exchange as an error.
//   - app side: the upgrade socket of a request routed by the proxy (markProxySocket, from the route matcher);
//   - server side: mockttp's createWebSocketFromStream signature (client mode, maxPayload 0,
//     allowSynchronousEvents, skipUTF8Validation) — nothing else in the extension builds sockets that way.

export const WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const marked = new WeakSet<object>();
let hook: boolean | undefined;

/** The app-side socket of a WebSocket upgrade the proxy handles. */
export function markProxySocket(socket: object | undefined): void {
  if (socket) marked.add(socket);
}

const limit = (n: unknown) => (typeof n !== 'number' || n <= 0 || n > WS_MAX_MESSAGE_BYTES ? WS_MAX_MESSAGE_BYTES : n);

interface SetSocketOptions {
  maxPayload?: number;
  allowSynchronousEvents?: boolean;
  skipUTF8Validation?: boolean;
}

/** Install the wrapper once; false = `ws` isn't where expected (start() refuses to run then). */
export function installWsLimit(): boolean {
  if (hook !== undefined) return hook;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WS = require('ws') as { prototype?: Record<string, unknown> };
    const proto = WS?.prototype;
    const original = proto?.setSocket as ((...a: unknown[]) => unknown) | undefined;
    if (!proto || typeof original !== 'function') return (hook = false);
    proto.setSocket = function patchedSetSocket(this: { _isServer?: boolean; _extensions?: Record<string, unknown> }, socket: object, head: unknown, options?: SetSocketOptions) {
      try {
        const o = options ?? {};
        const mockttpUpstream = this._isServer === false && o.maxPayload === 0 && o.allowSynchronousEvents === true && o.skipUTF8Validation === true;
        if (mockttpUpstream || marked.has(socket)) {
          options = { ...o, maxPayload: limit(o.maxPayload) };
          for (const ext of Object.values(this._extensions ?? {})) {
            if (ext && typeof ext === 'object' && '_maxPayload' in ext) {
              (ext as { _maxPayload: number })._maxPayload = limit((ext as { _maxPayload: number })._maxPayload);
            }
          }
        }
      } catch {
        /* never break the connection over the limit itself */
      }
      return original.call(this, socket, head, options);
    };
    return (hook = true);
  } catch {
    return (hook = false);
  }
}
