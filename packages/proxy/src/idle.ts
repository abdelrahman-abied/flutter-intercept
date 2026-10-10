// Idle pooled connections (CONTRACTS §14.6).

/**
 * CONTRACTS §14.6: pooled upstream sockets idle longer than this are closed (a server's shorter
 * `Keep-Alive: timeout=N` hint still wins, Node's keepSocketAlive). Applies to every keep-alive agent of ours: the
 * shared pool, LAN-guarded agents (lan.ts) and upstream-proxy agents (upstream-proxy.ts). In-use sockets only get
 * a 'timeout' event nobody acts on (Node's agent destroys free sockets only), so long responses are unaffected.
 */
export const IDLE_SOCKET_TIMEOUT_MS = 30_000;

/** Test seam: a shorter idle timeout for agents created from now on. Never set outside tests. */
export const poolTesting: { idleTimeoutMs?: number } = {};

/** Options for a keep-alive agent of ours. */
export function keepAliveOptions(): { keepAlive: true; timeout: number } {
  return { keepAlive: true, timeout: poolTesting.idleTimeoutMs ?? IDLE_SOCKET_TIMEOUT_MS };
}
