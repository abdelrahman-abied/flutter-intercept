// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import * as http from 'http';
import { STATUS_CODES } from 'http';
import { randomUUID } from 'crypto';
import * as net from 'net';
import * as tls from 'tls';
import { resetOrDestroy } from 'mockttp/dist/util/socket-util';
import type { TlsHandshakeFailure } from 'mockttp';
import { cleanHeaders, type HeaderBag } from './body';
import { isLoopbackHost } from './upstream-proxy';
import { matchesHostPattern, normalizeHostname, splitHostPort } from './hosts';
import { openTunnelUpstream, relay } from './tunnel';
import { type LinkShape } from './pace';
import {
  classifyFirstBytes,
  CONNECT_TIMEOUT_HEADER,
  GRPC_BREAKER_EVENT,
  GRPC_BREAKER_WINDOW_MS,
  type GrpcBreakerEvent,
  parseConnectTimeout,
  SILENT_FIRST_BYTE_MS,
  SILENT_TUNNEL_HEADER,
} from './grpc';
import { injectSilentTunnel } from './silent';
import { HOST_ALIASES } from './upstream-pool';
import {
  adoptAsLanSocket,
  tunnelMarker,
  lanGateOf,
  normalizeIp,
  lanConnectAllowed,
  refuse,
  SOCKET_SELF,
  SsrfError,
  SSRF_MARKER,
} from './lan';
import { describeProfile } from './network';
import { clientKeyOf, hostLabel } from './learned';
import { bracketHost, pinKey } from './learned-meta';
import type { Exchange, LearnedPassthrough } from './types';
import type { FlowFault, Flow, MatchResult, SilentInfo } from './flow-types';
import { SILENT_INFO } from './flow-types';
import { FAULT_LABELS, profileLabel, sleep, clipNote, INTERNAL_TUNNEL_HEADER } from './proxy-util';
import type { ProxyContext } from './proxy-context';

/**
 * REVIEW-13 #6 / REVIEW-14 #2: two handshakes one client closed without an alert within this window pin the host for that
 * client (dart:io sends no alert); a client that completed a decrypted request to the host within it gets no strikes.
 */
export const PIN_STRIKE_WINDOW_MS = 60_000;

/** REVIEW-13 #6 / CONTRACTS §20.1: a learned pin lasts this long (then the host is tried decrypted again). */
export const GRPC_PIN_TTL_MS = 10 * 60 * 1000;

/** Decrypted handshakes watched at once. */
const WATCH_MAX = 1000;
/** A watched connection that never carried a request is forgotten after this long (swept when the map is full). */
const WATCH_MAX_AGE_MS = 60_000;

/**
 * REVIEW-14 #2: a close / reset counts as a pin strike only once the proxy's TLS flight (with its certificate) went to
 * the client — more than this many bytes on the client's connection since the watch began (the CONNECT answer is ~20).
 */
const CERT_SENT_BYTES = 512;
/** Pin strikes and "accepted" marks kept at once (expired ones are swept when full). */
const STRIKES_MAX = 1000;

/** Test seam: a shorter pin lifetime. Never set outside tests. */
export const grpcPinTesting: { ttlMs?: number } = {};

/** A decrypted TLS connection watched in its handshake (ConnectFlow.decrypting): the CONNECT target and how it started. */
export interface WatchedHandshake {
  host: string;
  port: number;
  /** An HTTP CONNECT mockttp answers (CONTRACTS §20.1); absent = a silent gRPC tunnel (§19.3). */
  http?: true;
  /** When the watch began (swept after WATCH_MAX_AGE_MS when the map is full). */
  at?: number;
  socket?: net.Socket;
  /** REVIEW-14 #2: bytes written to the client when the watch began (did our certificate reach it?). */
  sent0?: number;
}

/** The server a failed handshake was for; `grpc` = a silent gRPC tunnel (0.13 texts), else an HTTP CONNECT. */
interface PinTarget {
  host: string;
  port: number;
  grpc: boolean;
}

/** What pinVerdict records: the exchange's error, and the learned pin if there is one. */
interface PinOutcome {
  error: string;
  learned?: Exchange['learnedPassthrough'];
}

/** The client side of a connection as `address:port` (the decrypting map's key; mockttp's TLS failures carry the same). */
function peerKey(address: unknown, port: unknown): string {
  return `${normalizeIp(String(address ?? ''))}:${port}`;
}

/** The note on a tunnel passed through because of a learned entry (CONTRACTS §20.1; gRPC pins keep the 0.13 text). */
function learnedNote(e: LearnedPassthrough, host: string): string {
  if (e.reason === 'client-certificate') return "This server needs the app's own certificate: passed through without decryption.";
  return e.grpc ? `${host} pins its certificate; passed through undecrypted.` : `${host} pins its certificate: passed through without decryption.`;
}

/** CONNECT handling: silent tunnels, TLS passthrough, decrypted gRPC tunnels and learned passthrough (pins). */
export class ConnectFlow {
  /** Upstream sockets of open passthrough tunnels (destroyed by stop()). */
  readonly tunnelSockets = new Set<net.Socket>();
  /**
   * Handshakes closed without an alert (dart:io rejects that way), per client and host:port (`client|host:port`,
   * REVIEW-14 #2): count + first time.
   */
  readonly pinStrikes = new Map<string, { n: number; first: number }>();
  /**
   * Decrypted (MITM) TLS tunnels in their handshake: client `address:port` → the CONNECT target (CONTRACTS §19.3:
   * silent gRPC tunnels; §20.1: HTTP CONNECTs mockttp answers, `http`).
   */
  readonly decrypting = new Map<string, WatchedHandshake>();
  /**
   * PERF-2 #1: `client|host:port` → when that client last sent a request over a decrypted connection to it, i.e. it accepted the
   * proxy's certificate there. A handshake closed without an alert (a connection pool dropping a spare connection, a
   * cancelled request) is then not a pin strike: an app that pins never completes a decrypted request.
   */
  readonly accepted = new Map<string, number>();
  /** Connections already seen by handshakeWorked (one check per connection, not per request). */
  private readonly worked = new WeakSet<object>();
  /** CONTRACTS §16.8: when each authority's breaker report was last emitted. */
  readonly breakerSeen = new Map<string, number>();

  constructor(private readonly px: ProxyContext) {}

  // ---------------------------------------------------------------- TLS passthrough (CONTRACTS §14.2)

  /**
   * Take over CONNECT handling: mockttp's combo server answers every CONNECT itself ('connect' listener in
   * http-combo-server.js: "200", then the socket goes back in as a new connection to be MITM'd). We remove its
   * listener(s) from the server (httpolyglot mirrors listeners onto its sub-servers, so removing from the outer server
   * removes them everywhere) and install one that tunnels passthrough hosts and hands everything else to mockttp's.
   * LAN clients reach this too: the LAN gate hands authenticated sockets to the same server.
   */
  installConnectHook(raw: net.Server): void {
    const original = raw.listeners('connect') as Array<(...a: unknown[]) => void>;
    if (!original.length) return;
    for (const l of original) raw.removeListener('connect', l);
    raw.on('connect', (req: http.IncomingMessage, socket: unknown, head: Buffer) => {
      let handled = false;
      try {
        handled = this.onConnect(req, socket, head);
      } catch {
        handled = false;
      }
      if (!handled) for (const l of original) l.call(raw, req, socket, head);
    });
    this.px.connectHook = true;
  }

  /**
   * A silent CONNECT (CONTRACTS §16.2) or a CONNECT to a passthrough or learned host (§14.2, §20.1): handled here
   * (true), else mockttp answers it (false) and its handshake is watched for a pin. The marker counts on HTTP/1
   * CONNECTs only (an HTTP/2 CONNECT arrives with a response object).
   */
  onConnect(req: http.IncomingMessage, socket: unknown, head: Buffer | undefined): boolean {
    const marker = socket instanceof net.Socket ? tunnelMarker(req.headers[SILENT_TUNNEL_HEADER]) : undefined;
    if (marker === 'breaker') {
      this.onBreakerReport(req, socket as net.Socket);
      return true;
    }
    if (marker === 'silent') {
      void this.runSilent(req, socket as net.Socket, head ?? Buffer.alloc(0)).catch(() => (socket as net.Socket).destroy());
      return true;
    }
    if (!(socket instanceof net.Socket) || socket instanceof tls.TLSSocket) return false;
    const t = splitHostPort(req.url ?? '');
    if (!t) return false;
    const host = normalizeHostname(t.host);
    if (!host) return false;
    if (this.px.passthrough.length && this.px.passthrough.some((p) => matchesHostPattern(p, host, t.port))) {
      void this.runTunnel(req, socket, head ?? Buffer.alloc(0), host, t.port).catch(() => socket.destroy());
      return true;
    }
    const learned = this.px.learn.forConnect(host, t.port, clientKeyOf(socket.remoteAddress));
    if (learned) {
      const extra = { note: learnedNote(learned, host), learned };
      void this.runTunnel(req, socket, head ?? Buffer.alloc(0), host, t.port, undefined, extra).catch(() => socket.destroy());
      return true;
    }
    this.watchDecryptHandshake(socket, host, t.port, true);
    return false;
  }

  /**
   * CONTRACTS §16.2: a silent CONNECT from the entry's gRPC hook. Nothing is ever written back; the first payload byte
   * decides: the h2c preface (and TLS to a grpcDecryptHosts host) → mockttp, as if it had answered the CONNECT; other
   * TLS → a passthrough tunnel (`grpcTunnel`); anything else → closed and recorded. LAN sockets were checked by
   * their gate (token, pinned peer, SSRF pre-check; refusals there are closes too).
   */
  async runSilent(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    socket.on('error', () => undefined);
    if (!lanConnectAllowed(socket)) {
      socket.destroy();
      return;
    }
    const target = req.url ?? '';
    const t = splitHostPort(target);
    const host = t ? normalizeHostname(t.host) : '';
    if (!t || !host) {
      this.recordSilentFailure(target, 'The silent tunnel named no valid host:port; it was closed.', socket);
      socket.destroy();
      return;
    }
    const info: SilentInfo = { connectTimeoutMs: parseConnectTimeout(req.headers[CONNECT_TIMEOUT_HEADER]) };
    const marks = socket as unknown as Record<symbol, unknown>;
    marks[SILENT_INFO] = info;
    marks[SOCKET_SELF] ??= socket;
    const first = head.length ? head : await this.firstBytes(socket);
    if (!first) {
      socket.destroy(); // closed (or silent) before the first byte: nothing happened
      return;
    }
    // CONTRACTS §18.6: send()'s own tunnel (this instance's nonce, from loopback only): always decrypted, and a resend of a
    // LAN client's call gets that client's LAN guards.
    const internal = String(req.headers[INTERNAL_TUNNEL_HEADER] ?? '').split(';').map((x) => x.trim());
    let forceDecrypt = false;
    if (internal[0]) {
      const ok = internal[0] === this.px.hopNonce && !lanGateOf(socket) && isLoopbackHost(normalizeIp(socket.remoteAddress ?? ''));
      if (!ok) {
        socket.destroy();
        return;
      }
      if (internal.includes('lan')) {
        const g = this.px.lanGate;
        if (!g || g.closed) {
          socket.destroy();
          return;
        }
        adoptAsLanSocket(socket, g);
      }
      forceDecrypt = true;
    }
    const kind = classifyFirstBytes(first);
    if (kind === 'other') {
      this.recordSilentFailure(target, 'Not HTTP/2 or TLS inside the silent tunnel; it was closed.', socket);
      socket.destroy();
      return;
    }
    const explicit = this.px.grpcDecrypt.some((p) => matchesHostPattern(p, host, t.port));
    const listed = this.px.passthrough.some((p) => matchesHostPattern(p, host, t.port));
    // CONTRACTS §20.1: under decrypt-all, a learned host (a pin, or a server that wants the app's own certificate) is
    // passed through; a grpcDecryptHosts host never is.
    const learned = kind === 'tls' && !forceDecrypt && this.px.grpcDecryptAllOn && !explicit && !listed ? this.px.learn.forConnect(host, t.port, clientKeyOf(socket.remoteAddress)) : undefined;
    const decrypt = forceDecrypt || kind === 'h2c' || (!learned && (this.px.grpcDecryptAllOn || explicit) && !listed);
    const raw = this.px.rawServer;
    if (decrypt && this.px.grpcCheck.ok && raw && this.px.server) {
      if (kind === 'tls' && !forceDecrypt) this.watchDecryptHandshake(socket, host, t.port, false);
      if (injectSilentTunnel(raw, socket, target, head.length ? head : undefined)) return;
    }
    const note = learned
      ? learnedNote(learned, host)
      : decrypt && !this.px.grpcCheck.ok
        ? (this.px.grpcCheck.problem ?? 'gRPC interception is unavailable; passed through undecrypted.')
        : undefined;
    await this.runTunnel(
      req,
      socket,
      head,
      host,
      t.port,
      { silent: true, plain: kind === 'h2c', connectTimeoutMs: info.connectTimeoutMs, ...(note ? { note } : {}) },
      learned ? { learned } : undefined,
    );
  }

  /**
   * CONTRACTS §16.8: the entry's breaker sent an authority direct for 30 s. Never answered, no exchange; the
   * 'grpcBreaker' event at most once per authority per GRPC_BREAKER_WINDOW_MS. LAN sockets passed their gate (token,
   * pinned peer, target check; refusals there are silent).
   */
  onBreakerReport(req: http.IncomingMessage, socket: net.Socket): void {
    socket.on('error', () => undefined);
    const allowed = lanConnectAllowed(socket);
    const viaLan = !!lanGateOf(socket);
    socket.destroy();
    if (!allowed) return;
    const t = splitHostPort(req.url ?? '');
    const host = t ? normalizeHostname(t.host) : '';
    if (!t || !host || host.length > 253) return;
    const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${t.port}`;
    const now = Date.now();
    const last = this.breakerSeen.get(authority);
    if (last !== undefined && now - last < GRPC_BREAKER_WINDOW_MS) return;
    if (this.breakerSeen.size >= 1000) {
      for (const [k, at] of this.breakerSeen) if (now - at >= GRPC_BREAKER_WINDOW_MS) this.breakerSeen.delete(k);
      if (this.breakerSeen.size >= 1000) return; // a flood of distinct authorities: drop
    }
    this.breakerSeen.set(authority, now);
    const event: GrpcBreakerEvent = { authority, viaLan };
    process.nextTick(() => this.px.emit(GRPC_BREAKER_EVENT, event));
  }

  /**
   * CONTRACTS §19.3 / §20.1: remember a decrypted TLS tunnel (a silent gRPC one, or an HTTP CONNECT mockttp answers)
   * until its handshake is done, so a handshake the app fails (it pins its own certificate) teaches the proxy to pass
   * that host through from then on.
   */
  watchDecryptHandshake(socket: net.Socket, host: string, port: number, http: boolean): void {
    const key = peerKey(socket.remoteAddress, socket.remotePort);
    const now = Date.now();
    if (this.decrypting.size >= WATCH_MAX) {
      // PERF-2 #1: entries of connections that stay open unused leave after WATCH_MAX_AGE_MS (one sweep when full,
      // instead of a timer per connection).
      for (const [k, e] of this.decrypting) if (now - (e.at ?? now) >= WATCH_MAX_AGE_MS) this.decrypting.delete(k);
      if (this.decrypting.size >= WATCH_MAX) return;
    }
    // REVIEW-14 #2: what had been written to the client when the watch began (did our certificate reach it?).
    const entry: WatchedHandshake = { host, port, ...(http ? { http: true as const } : {}), at: now, socket, sent0: socket.bytesWritten };
    this.decrypting.set(key, entry);
    // mockttp reports a failed handshake after the socket closed: keep the entry a little longer than that. A
    // connection that carried a request has left the map already (handshakeWorked): no timer for it.
    socket.once('close', () => {
      if (this.decrypting.get(key) !== entry) return;
      setTimeout(() => {
        if (this.decrypting.get(key) === entry) this.decrypting.delete(key);
      }, 5000).unref?.();
    });
  }

  /**
   * PERF-2 #1: a request arrived over a decrypted TLS connection (HTTP/1, HTTP/2 or gRPC) to `host:port`: its handshake
   * worked. The connection is no longer watched (a later close isn't a failed handshake), and the app is known to
   * accept the proxy's certificate for that server (pinVerdict). Once per connection.
   */
  handshakeWorked(socket: unknown, host: string, port: number): void {
    if (!socket || typeof socket !== 'object' || this.worked.has(socket)) return;
    this.worked.add(socket);
    const s = socket as { remoteAddress?: string; remotePort?: number };
    if (this.decrypting.size) {
      const key = peerKey(s.remoteAddress, s.remotePort);
      const w = this.decrypting.get(key);
      if (w && w.host === host && w.port === port) this.decrypting.delete(key);
    }
    const hp = pinKey(clientKeyOf(s.remoteAddress), host, port);
    this.pinStrikes.delete(hp);
    const now = Date.now();
    if (!this.accepted.has(hp) && this.accepted.size >= STRIKES_MAX) {
      for (const [k, at] of this.accepted) if (now - at >= PIN_STRIKE_WINDOW_MS) this.accepted.delete(k);
      if (this.accepted.size >= STRIKES_MAX) return;
    }
    this.accepted.set(hp, now);
  }

  /** The first payload chunk of a silent tunnel, put back into the socket (undefined: closed or nothing in time). */
  firstBytes(socket: net.Socket): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (b?: Buffer) => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('end', onGone);
        socket.off('close', onGone);
        resolve(b);
      };
      const onData = (d: Buffer) => {
        socket.pause();
        socket.unshift(d);
        // Like node's http server after a CONNECT: no flowing mode until the next reader attaches.
        (socket as unknown as { readableFlowing: boolean | null }).readableFlowing = null;
        done(d);
      };
      const onGone = () => done(undefined);
      timer = setTimeout(onGone, SILENT_FIRST_BYTE_MS);
      timer.unref?.();
      socket.on('data', onData);
      socket.once('end', onGone);
      socket.once('close', onGone);
    });
  }

  /** A silent tunnel that could not be used: one 'error' tunnel exchange (CONTRACTS §16.2). */
  recordSilentFailure(target: string, error: string, socket: net.Socket): void {
    const t = splitHostPort(target);
    const label = t ? (net.isIPv6(t.host) ? `[${t.host}]` : t.host) : 'unknown-host';
    const ex: Exchange = {
      id: `tunnel-${randomUUID()}`,
      startedAt: Date.now(),
      durationMs: 0,
      method: 'CONNECT',
      url: `https://${label}${t ? `:${t.port}` : ''}/`,
      requestHeaders: {},
      state: 'error',
      error,
      kind: 'tunnel',
      grpcTunnel: true,
      ...(lanGateOf(socket) ? { viaLan: true as const } : {}),
    };
    this.px.book.store.set(ex.id, ex);
    this.px.book.emitChange(ex);
  }

  async runTunnel(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    host: string,
    port: number,
    silent?: { silent: true; plain: boolean; connectTimeoutMs: number; note?: string },
    extra?: { note?: string; learned?: LearnedPassthrough },
  ): Promise<void> {
    socket.on('error', () => undefined);
    if (!lanConnectAllowed(socket)) {
      socket.destroy();
      return;
    }
    const gate = lanGateOf(socket);
    const label = net.isIPv6(host) ? `[${host}]` : host;
    const url = `${silent?.plain ? 'http' : 'https'}://${label}:${port}/`;
    // Rules: block and fault only. Matched as method CONNECT on the tunnel's own URL (a rule made from a tunnel,
    // `https://host:port/*`), and on `https://host/` for port 443 so a rule written for the site applies too.
    let m: MatchResult = {};
    let note: string | undefined;
    for (const u of port === 443 ? [url, `https://${label}/`] : [url]) {
      const probe = this.px.matchRule('CONNECT', u, { count: false, tunnel: true });
      note ??= probe.note;
      if (probe.rule) {
        m = this.px.matchRule('CONNECT', u, { count: true, tunnel: true });
        break;
      }
    }
    const flow: Flow = { route: 'tunnel', ...(m.rule ? { rule: m.rule } : {}), ...(gate ? { viaLan: true } : {}) };
    const a = m.action;
    let cut: FlowFault | undefined;
    let simulated: string | undefined;
    let up: LinkShape | undefined;
    let down: LinkShape | undefined;
    let latency = 0;
    const p = this.px.profile;
    if (a?.kind === 'block') {
      cut = 'reset';
      if (silent) simulated = 'Blocked';
      else if (a.mode === 'status') note ??= "A block with a status can't be answered inside an undecrypted tunnel; the connection was reset after the TLS handshake instead.";
    } else if (a?.kind === 'fault') {
      cut = a.fault;
      simulated = FAULT_LABELS[a.fault];
    } else if (p.kind === 'offline') {
      cut = 'dns';
      simulated = describeProfile(p);
    } else if (!m.rule && this.px.replayStore?.fallback === 'fail') {
      cut = 'dns';
      simulated = `Not in the recording${this.px.replayStore.name ? ` "${this.px.replayStore.name}"` : ''} (replay: fail)`;
    } else if (p.kind === 'throttle') {
      simulated = profileLabel(p);
      latency = p.latencyMs ?? 0;
      down = { latencyMs: p.latencyMs, kbps: p.kbps };
      up = { latencyMs: p.latencyMs, kbps: p.uploadKbps };
      if (p.dropRate && p.dropRate > 0 && Math.random() < p.dropRate) {
        cut = 'drop';
        simulated = `${simulated}: dropped`;
      }
    }
    if (cut) flow.fault = cut;
    const first = silent?.note ?? extra?.note;
    if (first) note = note ? `${first} ${note}` : first;
    const learned = extra?.learned;
    const requestHeaders = cleanHeaders(req.headers as HeaderBag);
    delete requestHeaders['proxy-authorization']; // the LAN token
    delete requestHeaders[SILENT_TUNNEL_HEADER];
    delete requestHeaders[CONNECT_TIMEOUT_HEADER];
    const ex: Exchange = {
      id: `tunnel-${randomUUID()}`,
      startedAt: Date.now(),
      method: 'CONNECT',
      url,
      requestHeaders,
      state: 'pending',
      kind: 'tunnel',
      tunnelBytes: { sent: 0, received: 0 },
      ...(silent ? { grpcTunnel: true as const } : {}),
      ...(m.rule ? { matchedRuleId: m.rule.id } : {}),
      ...(note ? { notes: [clipNote(note)] } : {}),
      ...(simulated ? { simulated } : {}),
      ...(gate ? { viaLan: true as const } : {}),
      ...(learned ? { learnedPassthrough: { reason: learned.reason, host: learned.host, port: learned.port } } : {}),
    };
    this.px.book.track(ex, flow);
    // CONTRACTS §16.8 (REVIEW-10 #1): a cut silent tunnel is held, never closed — a close looks like a lost connection
    // to grpc-dart, which reconnects at once until the entry's breaker sends it direct (around every rule).
    if (silent && cut) return this.holdSilentTunnel(ex, socket);
    const isLive = () => this.px.book.live.get(ex.id)?.ex === ex;
    let relaying = false;
    socket.once('close', () => {
      if (!relaying && isLive()) this.px.book.fail(ex, 'The app closed the connection before the tunnel was open.');
    });
    if (latency > 0) {
      const from = performance.now();
      await sleep(latency);
      if (!isLive()) return;
      this.px.book.addPhase(ex, 'delayMs', performance.now() - from);
    }
    let server: net.Socket;
    try {
      server = await openTunnelUpstream({
        host,
        port,
        ...(gate ? { lan: { listenerHost: gate.host, closed: () => gate.closed } } : {}),
        upstream: this.px.upstreamSpec,
        ...((this.px.opts.rewriteLocalhost ?? true) ? { alias: (h: string) => HOST_ALIASES[h] } : {}),
        timings: (t) => this.px.book.addTimings(ex.id, t),
        ...(silent ? { timeoutMs: silent.connectTimeoutMs } : {}),
      });
    } catch (e) {
      if (!isLive()) return;
      const forbidden = e instanceof SsrfError || (e as { statusCode?: number }).statusCode === 403;
      const message = e instanceof SsrfError ? e.message : forbidden ? `${SSRF_MARKER}: ${(e as Error).message}` : `Could not open the tunnel to ${label}:${port}: ${(e as Error).message}`;
      ex.status = forbidden ? 403 : 502;
      this.px.book.fail(ex, message);
      // A silent tunnel's app never reads a reply: close (the entry's breaker handles a storm).
      if (silent) socket.destroy();
      else refuse(socket, `HTTP/1.1 ${ex.status} ${STATUS_CODES[ex.status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (socket.destroyed || !isLive()) {
      server.destroy();
      return;
    }
    this.tunnelSockets.add(server);
    server.once('close', () => this.tunnelSockets.delete(server));
    relaying = true;
    if (!silent) socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    this.px.book.emitChange(ex);
    relay({
      app: socket,
      server,
      head,
      up,
      down,
      ...(cut ? { onAppData: () => this.cutTunnel(ex, socket, server, cut!) } : {}),
      onBytes: (sent, received) => {
        if (!isLive()) return;
        ex.tunnelBytes = { sent, received };
        this.px.book.touch(ex);
      },
      onClose: (error) => {
        if (!isLive()) return;
        if (error) this.px.book.fail(ex, error);
        else this.px.book.finish(ex, 'completed');
      },
    });
  }

  /**
   * CONTRACTS §16.8: a silent passthrough tunnel that a block, a fault, the offline profile, `replay: fail` or a drop
   * cuts: nothing is relayed and the server is never contacted; the app's socket stays open (its bytes are read and
   * dropped) until the app closes it or breakpointTimeoutMs passes (then reset). To the app: an unreachable network.
   */
  holdSilentTunnel(ex: Exchange, socket: net.Socket): void {
    socket.on('data', () => undefined);
    const label = ex.simulated ?? 'Held';
    const settle = (appLeft: boolean) => {
      if (this.px.holds.get(ex.id) !== settle) return;
      clearTimeout(timer);
      this.px.holds.delete(ex.id);
      if (this.px.book.live.get(ex.id)?.ex !== ex) return void socket.destroy(); // proxy stopped
      const secs = ((Date.now() - ex.startedAt) / 1000).toFixed(1);
      ex.simulated = `${label} (held without an answer; ${appLeft ? `the app gave up after ${secs} s` : `reset after ${secs} s`})`;
      this.px.book.finish(ex, 'blocked');
      if (!appLeft) resetOrDestroy(socket as never);
    };
    const timer = setTimeout(() => settle(false), this.px.breakpointTimeoutMs);
    timer.unref?.();
    this.px.holds.set(ex.id, settle);
    socket.once('close', () => settle(true));
    if (socket.destroyed) settle(true);
  }

  /** A block / fault on a passthrough tunnel, at the app's first request record (after the TLS handshake). */
  cutTunnel(ex: Exchange, socket: net.Socket, server: net.Socket, fault: FlowFault): void {
    server.destroy();
    if (this.px.book.live.get(ex.id)?.ex !== ex) return void socket.destroy();
    if (fault === 'timeout') {
      const settle = (appLeft: boolean) => {
        if (this.px.holds.get(ex.id) !== settle) return;
        clearTimeout(timer);
        this.px.holds.delete(ex.id);
        if (this.px.book.live.get(ex.id)?.ex !== ex) return void socket.destroy();
        const secs = ((Date.now() - ex.startedAt) / 1000).toFixed(1);
        ex.simulated = appLeft ? `${FAULT_LABELS.timeout} (the app gave up after ${secs} s)` : `${FAULT_LABELS.timeout} (reset after ${secs} s)`;
        this.px.book.finish(ex, 'blocked');
        if (!appLeft) resetOrDestroy(socket as never);
      };
      const timer = setTimeout(() => settle(false), this.px.breakpointTimeoutMs);
      timer.unref?.();
      this.px.holds.set(ex.id, settle);
      socket.once('close', () => settle(true));
      return;
    }
    this.px.book.finish(ex, 'blocked');
    if (fault === 'dns') socket.end();
    else resetOrDestroy(socket as never);
  }

  onTlsError(f: TlsHandshakeFailure): void {
    // CONTRACTS §19.3 / §20.1: the app failed our certificate on a decrypted tunnel we watch: it may pin.
    const key = peerKey(f.remoteIpAddress, f.remotePort);
    const watched = this.decrypting.get(key);
    if (watched) {
      this.decrypting.delete(key);
      const ex = this.pinVerdict(watched, f);
      if (ex) {
        this.px.book.store.set(ex.id, ex);
        this.px.book.emitChange(ex);
        return;
      }
    }
    const host = f.tlsMetadata?.sniHostname ?? f.destination?.hostname ?? 'unknown-host';
    const port = f.destination?.port;
    const ex: Exchange = {
      id: `tls-${randomUUID()}`,
      startedAt: f.timingEvents?.startTime ?? Date.now(),
      method: 'CONNECT',
      url: `https://${host}${port && port !== 443 ? `:${port}` : ''}/`,
      requestHeaders: {},
      state: 'error',
      error:
        `TLS handshake with the app failed (${f.failureCause}). The app probably rejects the proxy's ` +
        `certificate (certificate pinning or its own badCertificateCallback).`,
    };
    this.px.book.store.set(ex.id, ex);
    this.px.book.emitChange(ex);
  }

  /**
   * REVIEW-13 #6 / CONTRACTS §20.1: a pin needs the app's rejection of our certificate. A TLS alert (cert-rejected) is
   * one at once. dart:io (BoringSSL) sends no alert: it closes right after our certificate (mockttp: reset / closed),
   * which a kill mid-handshake can look like — so that counts only when it happens twice for the host within
   * PIN_STRIKE_WINDOW_MS. Never learned for a grpcDecryptHosts host (gRPC), while a recording is replayed, or when an
   * enabled rule names the host. Returns the exchange that records the failed handshake; undefined = onTlsError's
   * generic record (HTTP: not a rejection of our certificate).
   *
   * REVIEW-14 #2: strikes and pins are per client (clientKeyOf: the LAN device, or loopback), so another app on the
   * device can't pin hosts for the Flutter app; and a handshake dropped before our certificate was sent is no strike.
   */
  pinVerdict(watched: WatchedHandshake, f: TlsHandshakeFailure): Exchange | undefined {
    const w: PinTarget = { host: watched.host, port: watched.port, grpc: !watched.http };
    if (!w.grpc && !this.px.httpPinLearning) return undefined; // §20.6: native routing on: the generic record, as before 0.14
    const client = clientKeyOf(String(f.remoteIpAddress ?? ''));
    const key = pinKey(client, w.host, w.port);
    const alert = f.failureCause === 'cert-rejected';
    const served = !watched.socket || watched.socket.bytesWritten - (watched.sent0 ?? 0) > CERT_SENT_BYTES;
    const closed = (f.failureCause === 'reset' || f.failureCause === 'closed') && served;
    // PERF-2 #1: the app completed a decrypted request to this server within the window: it accepts the proxy's
    // certificate, so a handshake it drops (a spare pool connection, a cancelled request) is no pin strike.
    const at = this.accepted.get(key);
    const acceptsUs = at !== undefined && Date.now() - at < PIN_STRIKE_WINDOW_MS;
    if (closed && acceptsUs && !w.grpc) return undefined; // HTTP: the generic record, as before 0.14
    const closedEarly = closed && !acceptsUs;
    const strikes = closedEarly ? this.strike(key) : 0;
    const rejected = alert || strikes >= 2;
    const explicit = w.grpc && this.px.grpcDecrypt.some((p) => matchesHostPattern(p, w.host, w.port));
    const kept = explicit ? undefined : this.px.learn.keepDecrypted(w.host, w.port);
    let outcome: PinOutcome;
    if (explicit && (alert || closedEarly)) {
      outcome = { error: `The app ended the TLS handshake for ${w.host} (${f.failureCause}); it may pin its own certificate. The host is in grpcDecryptHosts, so it stays decrypted — remove it there if the app pins.` };
    } else if (!rejected) {
      if (!w.grpc && !closedEarly) return undefined; // HTTP: not a rejection of our certificate (the generic record)
      outcome = {
        error: closedEarly
          ? w.grpc
            ? `The app closed the TLS handshake for ${w.host} (${f.failureCause}). If it happens again within a minute, the host is passed through undecrypted (it probably pins its certificate).`
            : `The app closed the TLS handshake for ${hostLabel(w.host, w.port)} (${f.failureCause}). If it happens again within a minute, ${hostLabel(w.host, w.port)} is passed through without decryption (the app probably pins its certificate).`
          : `TLS handshake with the app failed (${f.failureCause}) for ${w.host}; not a certificate rejection, so the host stays decrypted.`,
      };
    } else {
      this.pinStrikes.delete(key);
      outcome = kept
        ? { error: `The app rejected the Flutter Intercept certificate for ${hostLabel(w.host, w.port)} (${f.failureCause}); it probably pins its own. ${kept}, so it stays decrypted.` }
        : this.learnPin(w, client);
    }
    return {
      id: `tls-${randomUUID()}`,
      startedAt: f.timingEvents?.startTime ?? Date.now(),
      method: 'CONNECT',
      url: `https://${bracketHost(w.host)}:${w.port}/`,
      requestHeaders: {},
      state: 'error',
      kind: 'tunnel',
      ...(w.grpc ? { grpcTunnel: true as const } : {}),
      error: outcome.error,
      ...(outcome.learned ? { learnedPassthrough: outcome.learned } : {}),
    };
  }

  /** REVIEW-13 #6: one close / reset strike for `key` (pinKey); the client's strikes for the host within the window. */
  private strike(key: string): number {
    const now = Date.now();
    const prev = this.pinStrikes.get(key);
    const st = prev && now - prev.first < PIN_STRIKE_WINDOW_MS ? { n: prev.n + 1, first: prev.first } : { n: 1, first: now };
    if (!prev && this.pinStrikes.size >= STRIKES_MAX) {
      // REVIEW-14 #2: old strikes leave (one sweep when full), so stale ones never switch close-based learning off.
      for (const [k, v] of this.pinStrikes) if (now - v.first >= PIN_STRIKE_WINDOW_MS) this.pinStrikes.delete(k);
    }
    if (this.pinStrikes.size < STRIKES_MAX || prev) this.pinStrikes.set(key, st);
    return st.n;
  }

  /** The app rejected our certificate for `w`: pin it for `client` (GRPC_PIN_TTL_MS), and the record's text. */
  private learnPin(w: PinTarget, client: string): PinOutcome {
    const ttl = grpcPinTesting.ttlMs ?? GRPC_PIN_TTL_MS;
    const ok = this.px.learn.hosts.learn(w.host, w.port, 'pinned', { until: Date.now() + ttl, by: client, ...(w.grpc ? { grpc: true } : {}) });
    if (!ok) {
      return { error: `${hostLabel(w.host, w.port)} pins its certificate (the app rejected the Flutter Intercept certificate), but too many hosts are passed through already; it stays decrypted.` };
    }
    return {
      error: w.grpc
        ? `${w.host} pins its certificate; passed through undecrypted from now on (the app rejected the Flutter Intercept certificate).`
        : `${hostLabel(w.host, w.port)} pins its certificate: passed through without decryption from now on, for ${Math.round(ttl / 60_000)} minutes (the app rejected the Flutter Intercept certificate).`,
      learned: { reason: 'pinned', host: w.host, port: w.port },
    };
  }
}
