import type * as http from 'http';
import type { Timings } from './types';

/*
 * Upstream phase timings (CONTRACTS §13.2), observed on the requests our pooled agents carry.
 *
 * mockttp asks `getAgent` (upstream-pool.ts) for an agent right before it creates the upstream request, with the
 * downstream connection it serves. The pool hands back a thin per-request view of the real agent (prototype =
 * the agent, own `addRequest` only), so the ClientRequest is seen while every socket, keep-alive and free-list
 * decision stays with the real agent. From the request and its socket:
 * - new socket: `dnsMs` (created → 'lookup'; absent for an IP target), `connectMs` (first connection attempt, or
 *   the lookup, → 'connect'), `tlsMs` ('connect' → 'secureConnect'). A phase is reported only when both of its ends were seen: a TLS socket over an
 *   upstream proxy's CONNECT tunnel never emits 'connect', so it has no `tlsMs` (never guessed);
 * - reused socket (`req.reusedSocket`): `reused: true`, no connection phases;
 * - `sendMs`: socket ready (connected / handshake done / handed out of the pool) → the request fully written
 *   ('finish', never before ready); `waitMs`: → response headers (or the 101 of a WebSocket upgrade);
 *   `receiveMs`: → the response's last byte ('end').
 * Values are integer ms ≥ 0, pushed to the sink as soon as each phase is known (the sink stores them without an
 * 'exchange' event of their own; the next state change carries them).
 */

export type TimingPatch = Partial<Timings>;
export type TimingSink = (patch: TimingPatch) => void;

const now = () => performance.now();

/** Integer ms ≥ 0 between two high-resolution timestamps. */
export const elapsed = (from: number, to: number = now()): number => Math.max(0, Math.round(to - from));

/** A per-request view of `agent` whose requests report their phases to `sink`. */
export function timedAgent<A extends http.Agent>(agent: A, sink: TimingSink): A {
  return Object.create(agent, {
    addRequest: {
      value(req: http.ClientRequest, options: unknown) {
        try {
          watchRequest(req, sink, hasUpgradeHeader((options as { headers?: unknown } | undefined)?.headers));
        } catch {
          /* timing must never break the request */
        }
        return (agent as unknown as { addRequest: (r: unknown, o: unknown) => unknown }).addRequest(req, options);
      },
    },
  }) as A;
}

/** Request options' headers (object, flat array or pairs) include `Upgrade`. */
export function hasUpgradeHeader(h: unknown): boolean {
  if (Array.isArray(h)) {
    if (h.length && Array.isArray(h[0])) return h.some((p) => String(p?.[0]).toLowerCase() === 'upgrade');
    for (let i = 0; i < h.length; i += 2) if (String(h[i]).toLowerCase() === 'upgrade') return true;
    return false;
  }
  return !!h && typeof h === 'object' && Object.keys(h).some((k) => k.toLowerCase() === 'upgrade');
}

/** Watch one upstream request; `cancel()` stops reporting (a retried request reports from its replacement). */
export function watchRequest(req: http.ClientRequest, sink: TimingSink, upgrade: boolean): { cancel(): void } {
  const created = now();
  let ready: number | undefined;
  let finished: number | undefined;
  let cancelled = false;
  const emit = (p: TimingPatch) => {
    if (cancelled) return;
    try {
      sink(p);
    } catch {
      /* ignore */
    }
  };
  req.prependOnceListener('socket', (socket) => {
    if (req.reusedSocket) {
      ready = now();
      emit({ reused: true });
      return;
    }
    let lookedUp: number | undefined;
    let connected: number | undefined;
    const tlsSocket = (socket as { encrypted?: boolean }).encrypted === true;
    if (!socket.connecting) {
      // Already connected (a socket handed over by a custom createConnection, e.g. through a tunnel).
      if (!tlsSocket || (socket as { _secureEstablished?: boolean })._secureEstablished) ready = now();
    } else {
      socket.once('lookup', (err: Error | null) => {
        if (err) return;
        lookedUp = now();
        emit({ dnsMs: elapsed(created, lookedUp) });
      });
      // Node ≥ 20.12: when the TCP connect itself starts (agents that resolve the name themselves, e.g. the LAN
      // guard, connect to an IP and emit no 'lookup'; their own DNS time then stays out of connectMs).
      let attempt: number | undefined;
      socket.once('connectionAttempt', () => {
        attempt = now();
      });
      socket.once('connect', () => {
        connected = now();
        emit({ connectMs: elapsed(attempt ?? lookedUp ?? created, connected) });
        if (!tlsSocket) ready = connected;
      });
    }
    if (tlsSocket && ready === undefined) {
      socket.once('secureConnect', () => {
        const at = now();
        if (connected !== undefined) emit({ tlsMs: elapsed(connected, at) });
        ready = at;
      });
    }
  });
  req.once('finish', () => {
    finished = now();
  });
  /** Response head (or 101): send / wait, when the socket's readiness was seen. Returns the head time. */
  const onHead = (): number => {
    const at = now();
    if (ready !== undefined) {
      const sent = Math.max(ready, Math.min(finished ?? at, at));
      emit({ sendMs: elapsed(ready, sent), waitMs: elapsed(sent, at) });
    }
    return at;
  };
  req.prependOnceListener('response', (res: http.IncomingMessage) => {
    const head = onHead();
    res.prependOnceListener('end', () => emit({ receiveMs: elapsed(head) }));
  });
  // Only on upgrade requests: an 'upgrade' listener changes how Node treats a 101 answer.
  if (upgrade) req.prependOnceListener('upgrade', () => void onHead());
  return {
    cancel() {
      cancelled = true;
    },
  };
}
