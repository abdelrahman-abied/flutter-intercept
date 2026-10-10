import * as net from 'net';
import { resolveCheckedTarget } from './lan';
import { isShaped, PacedStream, type LinkShape } from './pace';
import { elapsed, type TimingPatch } from './timing';
import { AppDataFinder } from './tls-records';
import { bypassesProxy, connectTunnel, isLoopbackHost, type UpstreamProxySpec } from './upstream-proxy';

/*
 * TLS passthrough tunnels (CONTRACTS §14.2): a CONNECT to a passthrough host is answered by us, not by mockttp,
 * and its bytes are relayed to the real server undecrypted (the app sees the server's own certificate, so its
 * pinning keeps working). docs/spikes/proxy-0.8.md has the hook and the rest of the design.
 *
 * The upstream connection is opened the same way our agents open theirs:
 * - LAN clients (CONTRACTS §7): the target is resolved and checked here (resolveCheckedTarget) and the connection
 *   goes to exactly that IP — directly, or as the CONNECT target through the upstream proxy — so neither DNS
 *   rebinding nor the upstream proxy's own resolution can reach a forbidden address.
 * - loopback clients: emulator host aliases (10.0.2.2 / 10.0.3.2) connect to 127.0.0.1; loopback / alias targets
 *   never go through the upstream proxy (REVIEW-6 #10); everything else does when one is set (CONTRACTS §12.6).
 */

export const TUNNEL_CONNECT_TIMEOUT_MS = 30_000;

export interface TunnelUpstream {
  host: string;
  port: number;
  /** LAN client: the listener address for the SSRF guard, and whether its gate is closed. */
  lan?: { listenerHost: string; closed(): boolean };
  upstream?: UpstreamProxySpec;
  /** Loopback clients: emulator alias → address (rewriteLocalhost). */
  alias?: (host: string) => string | undefined;
  timings: (p: TimingPatch) => void;
}

/** Open the raw TCP connection to the real server (or through the upstream proxy). Rejects with a readable error. */
export async function openTunnelUpstream(o: TunnelUpstream): Promise<net.Socket> {
  const t0 = performance.now();
  let host = o.host;
  if (o.lan) {
    if (o.lan.closed()) throw Object.assign(new Error('LAN mode is off.'), { statusCode: 403 });
    host = await resolveCheckedTarget(o.host, o.port, o.lan.listenerHost); // SsrfError → 403
    if (!net.isIP(o.host)) o.timings({ dnsMs: elapsed(t0) });
    if (o.lan.closed()) throw Object.assign(new Error('LAN mode is off.'), { statusCode: 403 });
  }
  const alias = o.lan ? undefined : o.alias?.(o.host);
  if (o.upstream && !alias && (o.lan || !isLoopbackHost(o.host)) && !bypassesProxy(o.upstream, o.host, o.port)) {
    const spec = o.upstream;
    const from = performance.now();
    return new Promise((resolve, reject) => {
      connectTunnel(spec, host, o.port, (err, socket) => {
        if (err || !socket) return reject(err ?? new Error('no tunnel'));
        o.timings({ connectMs: elapsed(from) });
        socket.resume();
        resolve(socket);
      });
    });
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: alias ?? host, port: o.port });
    let attempt: number | undefined;
    let lookedUp: number | undefined;
    const timer = setTimeout(() => fail(new Error(`no connection to ${o.host}:${o.port} within ${TUNNEL_CONNECT_TIMEOUT_MS / 1000} s`)), TUNNEL_CONNECT_TIMEOUT_MS);
    const fail = (e: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    };
    socket.once('lookup', (err) => {
      if (err) return;
      lookedUp = performance.now();
      o.timings({ dnsMs: elapsed(t0, lookedUp) });
    });
    socket.once('connectionAttempt', () => {
      attempt ??= performance.now();
    });
    socket.once('error', fail);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', fail);
      o.timings({ connectMs: elapsed(attempt ?? lookedUp ?? t0) });
      resolve(socket);
    });
  });
}

export interface RelayOptions {
  app: net.Socket;
  server: net.Socket;
  /** Bytes the app sent after its CONNECT head (normally none). */
  head: Buffer;
  /** Throttle per direction (network profile): app → server, server → app. */
  up?: LinkShape;
  down?: LinkShape;
  /** Block / fault: called (once) when the app's first request record begins; app → server stops there. */
  onAppData?: () => void;
  onBytes(sent: number, received: number): void;
  /** Both sides are closed; `error` = what broke it, if anything did. */
  onClose(error?: string): void;
}

/** Relay bytes both ways, counting them, until either side closes. */
export function relay(o: RelayOptions): void {
  const { app, server } = o;
  let sent = 0;
  let received = 0;
  let error: string | undefined;
  let closed = 0;
  const onClosed = () => {
    if (++closed === 2) o.onClose(error);
  };
  app.once('close', onClosed);
  server.once('close', onClosed);
  app.on('error', (e: NodeJS.ErrnoException) => {
    error ??= `The app's connection failed (${e.code ?? e.message}).`;
    server.destroy();
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    error ??= `The connection to the server failed (${e.code ?? e.message}).`;
    app.destroy();
  });
  // The app gone = the tunnel is gone. The server closing cleanly ends the app's side through the pipe below (after
  // any paced bytes); closing with an error drops it at once.
  app.once('close', () => server.destroy());
  server.once('close', (hadError: boolean) => {
    if (hadError) app.destroy();
  });
  // A client that never closes its side after our FIN doesn't keep the socket forever.
  app.once('finish', () => setTimeout(() => app.destroy(), 5000).unref());
  server.setNoDelay?.(true);

  // server → app (pipe passes the server's FIN on)
  const toApp = isShaped(o.down) ? new PacedStream(o.down) : undefined;
  server.on('data', (d: Buffer) => {
    received += d.length;
    o.onBytes(sent, received);
  });
  if (toApp) {
    toApp.on('error', () => app.destroy());
    server.pipe(toApp).pipe(app);
  } else server.pipe(app);

  // app → server, optionally cut at the first request record
  let cut = false;
  const finder = o.onAppData ? new AppDataFinder() : undefined;
  const toServer = isShaped(o.up) ? new PacedStream(o.up) : undefined;
  toServer?.on('error', () => server.destroy());
  toServer?.pipe(server);
  const forward = (d: Buffer) => {
    if (!d.length) return;
    sent += d.length;
    o.onBytes(sent, received);
    if (toServer) {
      if (!toServer.write(d)) {
        app.pause();
        toServer.once('drain', () => app.resume());
      }
    } else if (!server.write(d)) {
      app.pause();
      server.once('drain', () => app.resume());
    }
  };
  const onData = (d: Buffer) => {
    if (cut) return;
    if (finder) {
      const at = finder.push(d);
      if (at >= 0) {
        cut = true;
        forward(d.subarray(0, at));
        app.off('data', onData);
        app.on('data', () => undefined); // keep reading (and discarding) until the action closes it
        o.onAppData!();
        return;
      }
    }
    forward(d);
  };
  app.on('data', onData);
  if (o.head.length) onData(o.head);
  app.once('end', () => {
    if (cut) return;
    if (toServer) toServer.end();
    else server.end();
  });
}
