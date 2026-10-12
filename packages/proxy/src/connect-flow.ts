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
import type { Exchange } from './types';
import type { FlowFault, Flow, MatchResult, SilentInfo } from './flow-types';
import { SILENT_INFO } from './flow-types';
import { FAULT_LABELS, profileLabel, sleep, clipNote, INTERNAL_TUNNEL_HEADER } from './proxy-util';
import type { ProxyContext } from './proxy-context';

/** REVIEW-13 #6: two handshakes closed without an alert within this window pin a host (dart:io sends no alert). */
export const PIN_STRIKE_WINDOW_MS = 60_000;

/** REVIEW-13 #6: a learned pin lasts this long (then the host is tried decrypted again). */
export const GRPC_PIN_TTL_MS = 10 * 60 * 1000;

/** Test seam: a shorter pin lifetime. Never set outside tests. */
export const grpcPinTesting: { ttlMs?: number } = {};

/** CONNECT handling: silent tunnels, TLS passthrough, decrypted gRPC tunnels and learned pins. */
export class ConnectFlow {
  /** Upstream sockets of open passthrough tunnels (destroyed by stop()). */
  readonly tunnelSockets = new Set<net.Socket>();
  /** CONTRACTS §19.3: `host:port`s whose app rejected our certificate on a decrypted silent tunnel (until stop()). */
  readonly pinnedHosts = new Map<string, number>();
 // host:port → expiry (epoch ms)
  /** Handshakes the app closed without an alert, per host:port (dart:io rejects that way): count + first time. */
  readonly pinStrikes = new Map<string, { n: number; first: number }>();
  /** Decrypted (MITM) silent TLS tunnels in their handshake: client `address:port` → the CONNECT target. */
  readonly decrypting = new Map<string, { host: string; port: number }>();
  /** CONTRACTS §16.8: when each authority's breaker report was last emitted. */
  readonly breakerSeen = new Map<string, number>();

  constructor(private readonly px: ProxyContext) {}

  /** Is `host:port` a learned pinned host right now (pins expire after GRPC_PIN_TTL_MS)? */
  isPinned(key: string): boolean {
    const until = this.pinnedHosts.get(key);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.pinnedHosts.delete(key);
    return false;
  }

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
   * A silent CONNECT (CONTRACTS §16.2) or a CONNECT to a passthrough host: handled here (true), else mockttp answers
   * it (false). The marker counts on HTTP/1 CONNECTs only (an HTTP/2 CONNECT arrives with a response object).
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
    if (!this.px.passthrough.length || !(socket instanceof net.Socket) || socket instanceof tls.TLSSocket) return false;
    const t = splitHostPort(req.url ?? '');
    if (!t) return false;
    const host = normalizeHostname(t.host);
    if (!host || !this.px.passthrough.some((p) => matchesHostPattern(p, host, t.port))) return false;
    void this.runTunnel(req, socket, head ?? Buffer.alloc(0), host, t.port).catch(() => socket.destroy());
    return true;
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
    const pinKey = `${host}:${t.port}`;
    const pinned = kind === 'tls' && !forceDecrypt && this.isPinned(pinKey);
    const decrypt =
      forceDecrypt ||
      kind === 'h2c' ||
      (!pinned &&
        (this.px.grpcDecryptAllOn || this.px.grpcDecrypt.some((p) => matchesHostPattern(p, host, t.port))) &&
        !this.px.passthrough.some((p) => matchesHostPattern(p, host, t.port)));
    const raw = this.px.rawServer;
    if (decrypt && this.px.grpcCheck.ok && raw && this.px.server) {
      if (kind === 'tls' && !forceDecrypt) this.watchDecryptHandshake(socket, host, t.port);
      if (injectSilentTunnel(raw, socket, target, head.length ? head : undefined)) return;
    }
    const note = pinned
      ? `${host} pins its certificate; passed through undecrypted.`
      : decrypt && !this.px.grpcCheck.ok
        ? (this.px.grpcCheck.problem ?? 'gRPC interception is unavailable; passed through undecrypted.')
        : undefined;
    await this.runTunnel(req, socket, head, host, t.port, { silent: true, plain: kind === 'h2c', connectTimeoutMs: info.connectTimeoutMs, ...(note ? { note } : {}) });
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
   * CONTRACTS §19.3: remember a decrypted silent TLS tunnel until its handshake is done, so a handshake the app fails
   * (it pins its own certificate) teaches the proxy to pass that host through from then on (one failed connection).
   */
  watchDecryptHandshake(socket: net.Socket, host: string, port: number): void {
    const key = `${normalizeIp(socket.remoteAddress ?? '')}:${socket.remotePort}`;
    if (this.decrypting.size >= 1000) return;
    this.decrypting.set(key, { host, port });
    const forget = () => {
      if (this.decrypting.get(key)?.host === host) this.decrypting.delete(key);
    };
    // mockttp reports a failed handshake after the socket closed: keep the entry a little longer than that.
    socket.once('close', () => setTimeout(forget, 5000).unref?.());
    setTimeout(forget, 60_000).unref?.();
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
    if (silent?.note) note = note ? `${silent.note} ${note}` : silent.note;
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
    // CONTRACTS §19.3: the app failed our certificate on a decrypted silent gRPC tunnel: it pins; pass it through now.
    const key = `${normalizeIp(String(f.remoteIpAddress ?? ''))}:${f.remotePort}`;
    const silent = this.decrypting.get(key);
    if (silent) {
      this.decrypting.delete(key);
      const pinKey = `${silent.host}:${silent.port}`;
      const label = net.isIPv6(silent.host) ? `[${silent.host}]` : silent.host;
      // REVIEW-13 #6: a pin needs the app's rejection of our certificate. A TLS alert (cert-rejected) is one at once.
      // dart:io (BoringSSL) sends no alert: it closes right after our certificate (mockttp: reset / closed), which a
      // kill mid-handshake can look like — so that counts only when it happens twice for the host within 60 s.
      // A host the user listed in grpcDecryptHosts is never auto-pinned.
      const alert = f.failureCause === 'cert-rejected';
      const closedEarly = f.failureCause === 'reset' || f.failureCause === 'closed';
      let strikes = 0;
      if (closedEarly) {
        const now = Date.now();
        const prev = this.pinStrikes.get(pinKey);
        const st = prev && now - prev.first < PIN_STRIKE_WINDOW_MS ? { n: prev.n + 1, first: prev.first } : { n: 1, first: now };
        if (this.pinStrikes.size < 1000 || prev) this.pinStrikes.set(pinKey, st);
        strikes = st.n;
      }
      const rejected = alert || strikes >= 2;
      const explicit = this.px.grpcDecrypt.some((p) => matchesHostPattern(p, silent.host, silent.port));
      let error: string;
      if (explicit && (alert || closedEarly)) {
        error = `The app ended the TLS handshake for ${silent.host} (${f.failureCause}); it may pin its own certificate. The host is in grpcDecryptHosts, so it stays decrypted — remove it there if the app pins.`;
      } else if (!rejected) {
        error = closedEarly
          ? `The app closed the TLS handshake for ${silent.host} (${f.failureCause}). If it happens again within a minute, the host is passed through undecrypted (it probably pins its certificate).`
          : `TLS handshake with the app failed (${f.failureCause}) for ${silent.host}; not a certificate rejection, so the host stays decrypted.`;
      } else {
        this.pinStrikes.delete(pinKey);
        if (this.pinnedHosts.size >= 1000) for (const k of [...this.pinnedHosts.keys()]) this.isPinned(k); // drop expired
        if (this.pinnedHosts.size < 1000) this.pinnedHosts.set(pinKey, Date.now() + (grpcPinTesting.ttlMs ?? GRPC_PIN_TTL_MS));
        error = `${silent.host} pins its certificate; passed through undecrypted from now on (the app rejected the Flutter Intercept certificate).`;
      }
      const ex: Exchange = {
        id: `tls-${randomUUID()}`,
        startedAt: f.timingEvents?.startTime ?? Date.now(),
        method: 'CONNECT',
        url: `https://${label}:${silent.port}/`,
        requestHeaders: {},
        state: 'error',
        kind: 'tunnel',
        grpcTunnel: true,
        error,
      };
      this.px.book.store.set(ex.id, ex);
      this.px.book.emitChange(ex);
      return;
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
}
