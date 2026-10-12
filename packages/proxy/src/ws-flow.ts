// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import { requestInternals } from './mockttp-internals';
import { STATUS_CODES } from 'http';
import * as net from 'net';
import WebSocket from 'ws';
import { resetOrDestroy } from 'mockttp/dist/util/socket-util';
import type { OngoingRequest } from 'mockttp';
import { cleanHeaders, getHeader, type HeaderBag } from './body';
import { mapRemoteUrl } from './rules';
import { isShaped, LinkQueue, type LinkShape } from './pace';
import { closeFrame, payloadFrame } from './frames';
import { markProxySocket, WS_MAX_MESSAGE_BYTES } from './ws-limit';
import { lanGateOf } from './lan';
import { describeProfile } from './network';
import type { Exchange } from './types';
import type { Flow, StreamState, ThrottleProfile, WsLike, PacedWs } from './flow-types';
import { BLOCK_BODY, FAULT_LABELS, throttleLabel, profileLabel, toWsUrl, toBuffer, isTooBig } from './proxy-util';
import { rewritePairs } from './rewrite-flow';
import type { ProxyContext } from './proxy-context';

/**
 * REVIEW-8 #6: a throttled WebSocket direction may hold this many bytes waiting for the simulated link; beyond it the
 * sending side's socket is paused (TCP pushes back on the peer, as a real slow link would) until half of it drained.
 */
export const WS_THROTTLE_QUEUE_MAX = 8 * 1024 * 1024;

export const byteSize = (d: unknown): number =>
  typeof d === 'string' ? Buffer.byteLength(d) : Buffer.isBuffer(d) || d instanceof Uint8Array ? d.byteLength : d instanceof ArrayBuffer ? d.byteLength : Array.isArray(d) ? d.reduce((n: number, x) => n + byteSize(x), 0) : 0;

/**
 * CONTRACTS §14.4: deliver what is sent on a `ws` socket (`target`) through a LinkQueue (latency + bandwidth), in
 * order — messages, pings / pongs and the close. Anything due after the socket closed is dropped (its callback still
 * runs). `source` is the socket whose messages the pipe forwards to `target`: it is paused while the queue is over
 * WS_THROTTLE_QUEUE_MAX; without pause support the connection is closed (1013) with `onOverflow`'s note instead.
 */
export function paceWebSocket(target: unknown, shape: LinkShape, source: unknown, onOverflow: (note: string) => void): void {
  if (!isShaped(shape)) return;
  const ws = target as PacedWs;
  const src = source as PacedWs;
  const q = new LinkQueue(shape, { lowWater: WS_THROTTLE_QUEUE_MAX / 2 });
  const send = ws.send.bind(ws);
  const ping = ws.ping.bind(ws);
  const pong = ws.pong.bind(ws);
  const close = ws.close.bind(ws);
  const open = () => ws.readyState === WebSocket.OPEN;
  const cbOf = (...a: unknown[]) => a.find((x) => typeof x === 'function') as ((e?: Error) => void) | undefined;
  let paused = false;
  let overflowed = false;
  q.onDrain = () => {
    if (paused) {
      paused = false;
      src.resume?.();
    }
  };
  const check = () => {
    if (paused || overflowed || q.queuedBytes <= WS_THROTTLE_QUEUE_MAX) return;
    if (typeof src.pause === 'function' && typeof src.resume === 'function') {
      paused = true;
      src.pause();
      return;
    }
    overflowed = true;
    const mb = WS_THROTTLE_QUEUE_MAX / 1024 / 1024;
    onOverflow(`The throttled WebSocket fell more than ${mb} MB behind; the connection was closed (1013).`);
    q.close();
    try {
      close(1013, 'Throttle queue full');
      src.close(1013, 'Throttle queue full');
    } catch {
      /* already closing */
    }
  };
  ws.send = (data, opts, cb) => {
    q.push(byteSize(data), () => (open() ? send(data, opts, cb) : cbOf(opts, cb)?.()));
    check();
  };
  ws.ping = (data, mask, cb) => {
    q.push(byteSize(data), () => (open() ? ping(data, mask, cb) : cbOf(mask, cb)?.()));
    check();
  };
  ws.pong = (data, mask, cb) => {
    q.push(byteSize(data), () => (open() ? pong(data, mask, cb) : cbOf(mask, cb)?.()));
    check();
  };
  ws.close = (code, reason) =>
    q.push(2 + byteSize(reason), () => {
      try {
        close(code, reason);
      } catch {
        close();
      }
    });
  ws.once('close', () => {
    q.close();
    if (paused) src.resume?.();
  });
}

/** WebSocket upgrades: routing, recording, refusals, local answers and Map Remote. */
export class WsFlow {
  constructor(private readonly px: ProxyContext) {}

  // ---------------------------------------------------------------- WebSockets (CONTRACTS §11.1)

  /** Called by the WebSocket route matchers; decided (and recorded) once per upgrade. */
  decideWs(req: OngoingRequest): Flow {
    const known = this.px.book.flows.get(req.id);
    if (known) return known;
    const url = toWsUrl(req.url);
    const meta = this.px.reqMeta.get(req);
    const m = this.px.matchRule(req.method, url, { count: true, ws: true });
    const action = m.action;
    let flow: Flow = { route: 'ws-pass' };
    if (action?.kind === 'block') flow = { route: 'ws-local', rule: m.rule, action };
    else if (action?.kind === 'fault') flow = { route: 'ws-local', rule: m.rule, action, fault: action.fault, simulated: FAULT_LABELS[action.fault] };
    else if (this.px.profile.kind === 'offline') flow = { route: 'ws-local', rule: m.rule, fault: 'dns', simulated: describeProfile(this.px.profile) };
    else if (action?.kind === 'mapRemote') {
      // CONTRACTS §12.6: the upgrade goes to the mapped server (connectWsMapped); LAN clients keep the connect-time guard.
      try {
        const target = mapRemoteUrl(url, m.rule?.match.url ?? '', action.to);
        const t = new URL(target);
        const host = action.preserveHost ? (getHeader(req.headers as HeaderBag, 'host') ?? new URL(url).host) : t.host;
        flow = { route: 'ws-pass', rule: m.rule, action, map: { url: target, host }, originalUrl: url, simulated: `Mapped to ${t.origin}` };
      } catch (e) {
        flow = { route: 'ws-local', rule: m.rule, action, localError: `Map Remote rule: ${(e as Error).message}` };
      }
    } else if (!m.rule && this.px.replayStore) {
      // CONTRACTS §14.5: a recorded WebSocket for this URL answers as a scripted server.
      const store = this.px.replayStore;
      const hit = store.lookup('GET', url, {}, true);
      if (hit && hit !== 'needs-body' && hit.entry.kind === 'websocket') {
        flow = { route: 'ws-replay', replay: hit.entry, simulated: `Replayed from ${store.name ?? 'a recording'}` };
      } else if (store.fallback === 'fail') {
        flow = { route: 'ws-local', fault: 'dns', simulated: 'Not in the recording (replay: fail)' };
      }
    } else if (m.rule) flow.rule = m.rule;
    if (flow.route === 'ws-pass') {
      const refused = this.px.certRefusal(flow.map?.url ?? url, req.headers as HeaderBag);
      if (refused) flow = { route: 'ws-local', ...(m.rule ? { rule: m.rule } : {}), refused };
    }
    if (flow.route === 'ws-pass') {
      // CONTRACTS §14.4: a throttle rule (or the throttle profile) paces the frames, each direction (watchWebSocket).
      const t = action?.kind === 'throttle' ? action : this.px.profile.kind === 'throttle' ? this.px.profile : undefined;
      if (t) {
        const label = action?.kind === 'throttle' ? throttleLabel(action) : profileLabel(this.px.profile as ThrottleProfile);
        if ((t.latencyMs ?? 0) > 0 || (t.kbps ?? 0) > 0 || (t.uploadKbps ?? 0) > 0) {
          flow.throttle = { latencyMs: t.latencyMs, kbps: t.kbps, uploadKbps: t.uploadKbps };
          flow.simulated = flow.simulated ? `${label} · ${flow.simulated}` : label;
        }
        if (t.dropRate && t.dropRate > 0 && Math.random() < t.dropRate) {
          flow = { route: 'ws-local', rule: m.rule, fault: 'drop', simulated: `${label}: dropped` };
        }
      }
    }
    if (m.note) flow.note = m.note;
    if (meta?.traceId) flow.traceId = meta.traceId;
    const socket = requestInternals(req).socket;
    if (lanGateOf(socket)) flow.viaLan = true;
    if (socket && typeof socket === 'object') this.px.connRequest.set(socket, req.id);
    this.px.book.flows.set(req.id, flow);
    const ex = this.px.book.newExchange({ id: req.id, method: req.method, url, headers: req.headers as HeaderBag, timingEvents: req.timingEvents }, flow);
    delete ex.graphql;
    ex.kind = 'websocket';
    ex.frames = [];
    // An upgrade request is its head: complete now (CONTRACTS §13.2, phases up to the 101).
    flow.te = req.timingEvents;
    this.px.book.setRequestMs(ex, flow.te, performance.now());
    this.px.book.track(ex, flow);
    if (flow.route === 'ws-pass') {
      markProxySocket(requestInternals(req).socket); // app side gets the message size limit
      this.watchWebSocket(req, ex);
    }
    return flow;
  }

  /**
   * Frames straight from the two `ws` connections mockttp pipes together (its 'ws-upgrade' socket event,
   * which hands over the app-side WebSocket with `upstreamWebSocket` attached). Unlike mockttp's
   * websocket-message events this sees pings / pongs and which side closed first (and how), and records in
   * order without a setImmediate per message.
   */
  watchWebSocket(req: OngoingRequest, ex: Exchange): void {
    const socket = requestInternals(req).socket;
    if (socket) this.watchWsRefusal(socket, req.id);
    socket?.once('ws-upgrade', (ws: WsLike) => {
      const live = this.px.book.live.get(ex.id);
      if (!live || live.ex !== ex) return;
      const st: StreamState = (live.stream = { ...live.stream, wsDirect: true });
      const up = ws.upstreamWebSocket;
      const th = live.flow.throttle;
      if (th && up) {
        // Before mockttp's pipe starts (it is attached after this event): what the pipe sends to the app is paced
        // like a download, what it sends to the server like an upload.
        const note = (text: string) => {
          if (this.px.book.live.get(ex.id)?.ex === ex) this.px.book.addNote(ex, text);
        };
        paceWebSocket(ws, { latencyMs: th.latencyMs, kbps: th.kbps }, up, note);
        paceWebSocket(up, { latencyMs: th.latencyMs, kbps: th.uploadKbps }, ws, note);
      }
      ws.on('message', (data, isBinary) => this.px.book.addFrame(ex, payloadFrame('send', isBinary ? 'binary' : 'text', toBuffer(data))));
      ws.on('ping', (d) => this.px.book.addFrame(ex, payloadFrame('send', 'ping', toBuffer(d))));
      ws.on('pong', (d) => this.px.book.addFrame(ex, payloadFrame('send', 'pong', toBuffer(d))));
      // Over the size limit (ws-limit.ts): ws closes that side with 1009; close the other side with 1009 too
      // (mockttp's pipe would otherwise just drop it). Our listeners run before the pipe's.
      ws.on('error', (e) => {
        if (!isTooBig(e)) return;
        st.tooBig ??= 'send';
        try {
          up?.close(1009, 'Message too big');
        } catch {
          /* already closing */
        }
      });
      if (up) {
        up.on('error', (e) => {
          if (!isTooBig(e)) return;
          st.tooBig ??= 'receive';
          try {
            ws.close(1009, 'Message too big');
          } catch {
            /* already closing */
          }
        });
        up.on('message', (data, isBinary) => this.px.book.addFrame(ex, payloadFrame('receive', isBinary ? 'binary' : 'text', toBuffer(data))));
        up.on('ping', (d) => this.px.book.addFrame(ex, payloadFrame('receive', 'ping', toBuffer(d))));
        up.on('pong', (d) => this.px.book.addFrame(ex, payloadFrame('receive', 'pong', toBuffer(d))));
        up.once('close', (code, reason) => {
          st.serverClose ??= { code, reason: toBuffer(reason) };
        });
      }
      ws.once('close', (code, reason) => this.onWsClosed(ex, code, toBuffer(reason)));
    });
  }

  /** The app's side of the WebSocket closed: the exchange ends (the side that closed first decides how). */
  onWsClosed(ex: Exchange, appCode: number, appReason: Buffer): void {
    const live = this.px.book.live.get(ex.id);
    if (!live || live.ex !== ex) return;
    const tooBig = live.stream?.tooBig;
    if (tooBig) {
      return this.px.book.fail(
        ex,
        `A message from the ${tooBig === 'receive' ? 'server' : 'app'} was over the ${WS_MAX_MESSAGE_BYTES / 1024 / 1024} MB limit; ` +
          'the connection was closed (1009, message too big).',
      );
    }
    const server = live.stream?.serverClose;
    const [dir, code, reason] = server ? (['receive', server.code, server.reason] as const) : (['send', appCode, appReason] as const);
    if (code === 1006) {
      return this.px.book.fail(
        ex,
        dir === 'receive'
          ? "The server's connection ended without a close frame (abnormal closure, 1006)."
          : "The app's connection ended without a close frame (abnormal closure, 1006).",
      );
    }
    this.px.book.addFrame(ex, closeFrame(dir, code === 1005 ? undefined : code, reason));
    this.px.book.finish(ex, 'completed');
  }

  /** mockttp's 'websocket-accepted': the 101 and its headers. */
  onWsAccepted(res: { id?: string; statusCode?: number; headers?: Record<string, unknown> }): void {
    const live = res.id ? this.px.book.live.get(res.id) : undefined;
    if (!live || live.ex.kind !== 'websocket') return;
    const { ex } = live;
    ex.status = res.statusCode ?? 101;
    ex.responseHeaders = cleanHeaders((res.headers ?? {}) as HeaderBag);
    if (!live.stream?.wsDirect) this.px.book.addNote(ex, 'Frames are not recorded (incompatible mockttp version).');
    this.px.book.emitChange(ex);
  }

  /**
   * A refused upgrade: mockttp mirrors the server's non-101 answer onto the app's socket and closes it. The answer's
   * head is read from what is written to the socket (≤ 16 KB) when it closes without having upgraded.
   */
  watchWsRefusal(socket: net.Socket, id: string): void {
    const s = socket as unknown as { _write: (...a: unknown[]) => unknown };
    const original = s._write;
    if (typeof original !== 'function') return;
    let head = Buffer.alloc(0);
    let upgraded = false;
    s._write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
      if (!upgraded && head.length < 16 * 1024) head = Buffer.concat([head, toBuffer(chunk)]).subarray(0, 16 * 1024);
      return original.call(this, chunk, ...rest);
    };
    socket.once('ws-upgrade', () => {
      upgraded = true;
      head = Buffer.alloc(0);
    });
    socket.once('close', () => {
      if (upgraded || !head.length) return;
      const text = head.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      const lines = (end >= 0 ? text.slice(0, end) : text).split('\r\n');
      const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? '');
      if (!m) return;
      const headers: Record<string, string | string[]> = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        const v = line.slice(i + 1).trim();
        const prev = headers[k];
        headers[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      this.onWsRefused({ id, statusCode: Number(m[1]), statusMessage: m[2] ?? '', headers });
    });
  }

  /** A response other than 101 to a passed-through upgrade (the server refused it, or mockttp failed). */
  onWsRefused(res: { id?: string; statusCode?: number; statusMessage?: string; headers?: Record<string, unknown> }): void {
    const live = res.id ? this.px.book.live.get(res.id) : undefined;
    if (!live || live.ex.kind !== 'websocket' || live.flow.route !== 'ws-pass') return;
    const { ex } = live;
    ex.status = res.statusCode;
    ex.responseHeaders = cleanHeaders((res.headers ?? {}) as HeaderBag);
    this.px.book.fail(ex, `The WebSocket upgrade was refused: ${res.statusCode ?? '?'} ${res.statusMessage ?? ''}`.trim());
  }

  /** Block / fault rules and the offline profile on an upgrade: answered here, never forwarded. */
  async onWsLocal(req: OngoingRequest, socket: net.Socket): Promise<void> {
    const live = this.px.book.live.get(req.id);
    if (!live) {
      socket.destroy();
      return;
    }
    const { ex, flow } = live;
    const action = flow.action;
    const reset = () => resetOrDestroy(req as unknown as Parameters<typeof resetOrDestroy>[0]);
    if (flow.refused) {
      const body = Buffer.from(`Flutter Intercept: ${flow.refused}`, 'utf8');
      ex.status = 403;
      ex.error = flow.refused;
      this.px.book.finish(ex, 'blocked');
      socket.on('error', () => undefined);
      socket.end(
        Buffer.concat([
          Buffer.from(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`, 'latin1'),
          body,
        ]),
      );
      return;
    }
    if (flow.localError) {
      const body = Buffer.from(`Flutter Intercept: ${flow.localError}`, 'utf8');
      ex.status = 502;
      this.px.book.fail(ex, flow.localError);
      socket.on('error', () => undefined);
      socket.end(
        Buffer.concat([
          Buffer.from(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`, 'latin1'),
          body,
        ]),
      );
      return;
    }
    if (flow.fault === 'timeout') {
      const appLeft = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), this.px.breakpointTimeoutMs);
        timer.unref?.();
        const settle = (left: boolean) => {
          clearTimeout(timer);
          this.px.holds.delete(ex.id);
          resolve(left);
        };
        this.px.holds.set(ex.id, settle);
      });
      if (!this.px.book.live.has(ex.id)) {
        socket.destroy(); // proxy stopped
        return;
      }
      const s = ((Date.now() - ex.startedAt) / 1000).toFixed(1);
      ex.simulated = appLeft ? `${FAULT_LABELS.timeout} (the app gave up after ${s} s)` : `${FAULT_LABELS.timeout} (reset after ${s} s)`;
      this.px.book.finish(ex, 'blocked');
      if (!appLeft) reset();
      return;
    }
    if (flow.fault) {
      this.px.book.finish(ex, 'blocked');
      if (flow.fault === 'dns') {
        socket.end();
        socket.destroy();
      } else reset();
      return;
    }
    if (action?.kind === 'block' && action.mode === 'reset') {
      this.px.book.finish(ex, 'blocked');
      return reset();
    }
    const status = action?.kind === 'block' ? (action.status ?? 403) : 403;
    const body = Buffer.from(BLOCK_BODY, 'utf8');
    const headers = { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length), connection: 'close' };
    ex.status = status;
    ex.responseHeaders = { ...headers };
    ex.responseBody = { text: BLOCK_BODY, encoding: 'utf8' };
    this.px.book.finish(ex, 'blocked');
    const head = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Blocked'}\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')}\r\n\r\n`;
    socket.on('error', () => undefined);
    socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]));
  }

  /**
   * Map Remote for a WebSocket upgrade: mockttp's PassThroughWebSocketStep, but connected to the mapped target
   * (its connectUpstream takes the destination and URL explicitly; req.url is read-only for upgrades).
   */
  async connectWsMapped(step: any, req: OngoingRequest, socket: net.Socket, head: Buffer, options: unknown, map: { url: string; host: string }): Promise<void> {
    if (typeof step?.connectUpstream !== 'function' || typeof step?.initializeWsServer !== 'function') {
      const live = this.px.book.live.get(req.id);
      if (live) this.px.book.fail(live.ex, 'Map Remote could not be applied to this WebSocket (incompatible mockttp version).');
      socket.destroy();
      return;
    }
    step.initializeWsServer();
    const t = new URL(map.url);
    const destination = { hostname: t.hostname.replace(/^\[|\]$/g, ''), port: Number(t.port) || (t.protocol === 'wss:' ? 443 : 80) };
    const raw = requestInternals(req).rawHeaders;
    const rawHeaders = rewritePairs(Array.isArray(raw) ? raw.slice() : [], { remove: ['host'], set: [['Host', map.host]] });
    await step.connectUpstream(destination, map.url, req, rawHeaders, socket, head, options);
  }
}
