// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import { requestInternals } from './mockttp-internals';
import * as http from 'http';
import { STATUS_CODES } from 'http';
import * as net from 'net';
import WebSocket from 'ws';
import type { OngoingRequest } from 'mockttp';
import {
  cleanHeaders,
  decodeForDisplay,
  decodeStrict,
  deleteHeader,
  frameBody,
  frameBodyAsync,
  getHeader,
  setHeader,
  type HeaderBag,
} from './body';
import { requestBodyHash, type BodyKey } from './replay';
import { framePayload, sseEventText, sseSchedule, wsScript, type TimedStep } from './replay-stream';
import { closeFrame, payloadFrame } from './frames';
import { WS_MAX_MESSAGE_BYTES } from './ws-limit';
import { getTap, RESPONSE_PAUSE_LIMIT_BYTES } from './taps';
import type { Exchange, Frame, ReplayEntry } from './types';
import type { CallbackRequestResult, Flow } from './flow-types';
import { HTTP_TOKEN, isEventStream, toBuffer, REPLAY_DROPPED_HEADERS } from './proxy-util';
import type { ProxyContext } from './proxy-context';

/** CONTRACTS §12.4 / §14.5: answers from a recording (HTTP, streams, WebSockets). */
export class ReplayFlow {
  /** CONTRACTS §14.5: answers replayed WebSocket upgrades; the subprotocol each recorded connection chose. */
  wsReplayServer?: WebSocket.Server;
  readonly wsReplayProtocols = new WeakMap<object, string>();

  constructor(private readonly px: ProxyContext) {}

  /** A replayed response (CONTRACTS §12.4): re-framed for the recorded headers, state 'mocked'. */
  async answerReplay(ex: Exchange, flow: Flow, entry: ReplayEntry): Promise<CallbackRequestResult> {
    this.px.book.track(ex, flow);
    const headers: HeaderBag = {};
    for (const [k, v] of Object.entries(entry.headers ?? {})) {
      if (!HTTP_TOKEN.test(k) || REPLAY_DROPPED_HEADERS.has(k.toLowerCase())) continue;
      const vals = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && !/[\r\n\0]/.test(x));
      if (vals.length) headers[k] = vals.length === 1 ? vals[0] : vals;
    }
    this.px.edits.addCorsToLocalResponse(ex, headers);
    const b = entry.body;
    const bytes = !b ? Buffer.alloc(0) : b.encoding === 'base64' ? Buffer.from(b.text, 'base64') : Buffer.from(b.text, 'utf8');
    let rawBody: Buffer;
    let decoded: Buffer = bytes;
    const enc = getHeader(headers, 'content-encoding');
    if (enc && bytes.length) {
      // A recorded body is normally decoded text, but encodings the recorder can't decode (zstd, stacked) were kept
      // as the wire bytes: send those as they are, encode the others.
      let wire = false;
      try {
        decoded = await decodeStrict(bytes, enc, RESPONSE_PAUSE_LIMIT_BYTES);
        wire = true;
      } catch {
        decoded = bytes;
      }
      if (wire) {
        rawBody = bytes;
        deleteHeader(headers, 'transfer-encoding');
        setHeader(headers, 'content-length', String(bytes.length));
      } else rawBody = await frameBodyAsync(bytes, headers);
    } else rawBody = frameBody(bytes, headers);
    ex.status = entry.status;
    ex.responseHeaders = cleanHeaders(headers);
    ex.responseBody = await decodeForDisplay(decoded, undefined, true);
    if (b?.truncated) this.px.book.addNote(ex, 'The recorded response body was cut at 5 MB; the app got that part only.');
    if (isEventStream(getHeader(headers, 'content-type'))) this.px.taps.setSseFrames(ex, decoded);
    this.px.book.finish(ex, 'mocked');
    return { response: { statusCode: entry.status, statusMessage: STATUS_CODES[entry.status], headers, rawBody } };
  }

  // ---------------------------------------------------------------- stream replay (CONTRACTS §14.5)

  /**
   * A recorded event stream, answered event by event at the recorded gaps (≤ 5 s). Entries whose request body
   * matters (POST streams) are chosen here, once the body is read; a non-stream answer is written whole, and a miss
   * follows the replay fallback (the real server, or closed like offline).
   */
  async onReplayStream(req: OngoingRequest, res: http.ServerResponse, passthrough: { handle(...a: unknown[]): Promise<unknown> }, options: unknown): Promise<void> {
    const flow = this.px.book.flows.get(req.id);
    if (!flow) {
      res.writeHead(502).end();
      return;
    }
    let entry = flow.replay;
    if (entry === 'deferred') {
      let key: BodyKey = 'unreadable';
      try {
        const buf: Buffer = await requestInternals(req).body!.asDecodedBuffer();
        const b = await decodeForDisplay(buf, undefined, true);
        key = b?.truncated ? 'unreadable' : { hash: requestBodyHash(b) };
      } catch {
        key = 'unreadable';
      }
      const r = this.px.replayFlow(req.method, req.url, req.headers as HeaderBag, key, flow.note);
      Object.assign(flow, { route: r.route, replay: r.replay, fault: r.fault, simulated: r.simulated, throttle: r.throttle, note: r.note });
      entry = r.replay === 'deferred' ? undefined : r.replay;
      if (!entry) {
        if (r.fault) {
          // replay fallback "fail": closed without a response, like the offline profile.
          const ex = this.px.book.newExchange(req, flow);
          this.px.book.track(ex, flow);
          this.px.book.finish(ex, 'blocked');
          res.socket?.end();
          return;
        }
        // Not in the recording: the real server, recorded like any pass-through.
        flow.route = 'plain';
        this.px.book.track(this.px.book.newExchange(req, flow), flow);
        const tap = getTap(req.id);
        if (tap) this.px.taps.applyShaping(tap, flow);
        await passthrough.handle(req, res, options);
        return;
      }
      if (entry.kind !== 'sse') {
        const ex = this.px.book.newExchange(req, flow);
        const out = await this.answerReplay(ex, flow, entry);
        const r2 = out.response as { statusCode: number; statusMessage?: string; headers: HeaderBag; rawBody: Buffer };
        res.writeHead(r2.statusCode, r2.statusMessage ?? '', r2.headers as http.OutgoingHttpHeaders);
        res.end(r2.rawBody);
        return;
      }
    }
    if (!entry) {
      res.writeHead(502).end();
      return;
    }
    const ex = this.px.book.newExchange(req, flow);
    this.px.book.setRequestMs(ex, requestInternals(req).timingEvents, performance.now());
    this.px.book.track(ex, flow);
    const headers: HeaderBag = {};
    for (const [k, v] of Object.entries(entry.headers ?? {})) {
      const lk = k.toLowerCase();
      if (!HTTP_TOKEN.test(k) || REPLAY_DROPPED_HEADERS.has(lk) || lk === 'content-encoding') continue;
      const vals = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && !/[\r\n\0]/.test(x));
      if (vals.length) headers[k] = vals.length === 1 ? vals[0] : vals;
    }
    if (!getHeader(headers, 'content-type')) headers['content-type'] = 'text/event-stream';
    if (!getHeader(headers, 'cache-control')) headers['cache-control'] = 'no-cache';
    this.px.edits.addCorsToLocalResponse(ex, headers);
    const steps = sseSchedule(entry.frames);
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let i = 0;
      res.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      // The taps see the head (an event stream: SSE recording, flushed at once) and every event written.
      res.writeHead(entry.status, STATUS_CODES[entry.status] ?? '', headers as http.OutgoingHttpHeaders);
      const next = () => {
        if (res.destroyed || res.writableEnded) return resolve();
        if (i >= steps.length) {
          res.end();
          return resolve();
        }
        const step = steps[i++];
        timer = setTimeout(() => {
          if (res.destroyed) return resolve();
          res.write(sseEventText(step.frame));
          next();
        }, step.delayMs);
      };
      next();
    });
  }

  /** A recorded WebSocket: accept the upgrade here and play the server's side (src/replay-stream.ts). */
  async onWsReplay(req: OngoingRequest, socket: net.Socket, head: Buffer): Promise<void> {
    const live = this.px.book.live.get(req.id);
    const entry = live?.flow.replay;
    if (!live || !entry || entry === 'deferred') {
      socket.destroy();
      return;
    }
    const { ex } = live;
    socket.on('error', () => undefined);
    let upgraded = false;
    socket.once('close', () => {
      if (!upgraded && this.px.book.live.get(ex.id)?.ex === ex) this.px.book.fail(ex, 'The replayed WebSocket upgrade was refused (an invalid upgrade request?).');
    });
    const protocol = getHeader((entry.headers ?? {}) as HeaderBag, 'sec-websocket-protocol')?.split(',')[0]?.trim();
    const wss = (this.wsReplayServer ??= new WebSocket.Server({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: WS_MAX_MESSAGE_BYTES,
      handleProtocols: (offered: Set<string>, request: unknown) => {
        const want = this.wsReplayProtocols.get(request as object);
        if (want && offered.has(want)) return want;
        return offered.values().next().value ?? false;
      },
    }));
    if (protocol) this.wsReplayProtocols.set(req as unknown as object, protocol);
    wss.handleUpgrade(req as unknown as http.IncomingMessage, socket, head, (ws) => {
      upgraded = true;
      this.runWsReplay(ex, entry, ws);
    });
  }

  runWsReplay(ex: Exchange, entry: ReplayEntry, ws: WebSocket): void {
    const isLive = () => this.px.book.live.get(ex.id)?.ex === ex;
    ex.status = 101;
    ex.responseHeaders = { upgrade: 'websocket', connection: 'Upgrade', ...(ws.protocol ? { 'sec-websocket-protocol': ws.protocol } : {}) };
    this.px.book.emitChange(ex);
    const script = wsScript(entry.frames);
    const timers = new Set<NodeJS.Timeout>();
    let closed = false;
    let closeSent = false;
    let chain = Promise.resolve();
    const wait = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(() => {
          timers.delete(t);
          r();
        }, ms);
        timers.add(t);
      });
    const send = (f: Frame) => {
      if (f.kind === 'close') {
        closeSent = true;
        const code = f.closeCode !== undefined && f.closeCode !== 1005 && f.closeCode !== 1006 ? f.closeCode : undefined;
        if (isLive()) this.px.book.addFrame(ex, closeFrame('receive', code, f.text));
        try {
          if (code !== undefined) ws.close(code, (f.text ?? '').slice(0, 120));
          else ws.close();
        } catch {
          ws.close();
        }
        return;
      }
      const { data, binary } = framePayload(f);
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      if (f.kind === 'ping') ws.ping(buf);
      else if (f.kind === 'pong') ws.pong(buf);
      else if (f.kind === 'text' || f.kind === 'binary') ws.send(data, { binary });
      else return;
      if (isLive()) this.px.book.addFrame(ex, payloadFrame('receive', f.kind, buf));
    };
    const play = (steps: TimedStep[]) => {
      chain = chain.then(async () => {
        for (const s of steps) {
          if (closed || closeSent) return;
          if (s.delayMs > 0) await wait(s.delayMs);
          if (closed || closeSent || ws.readyState !== WebSocket.OPEN) return;
          send(s.frame);
        }
      });
    };
    let messages = 0;
    ws.on('message', (data, isBinary) => {
      if (isLive()) this.px.book.addFrame(ex, payloadFrame('send', isBinary ? 'binary' : 'text', toBuffer(data)));
      const reply = script.replies[messages++];
      if (reply) play(reply);
    });
    ws.on('ping', (d) => isLive() && this.px.book.addFrame(ex, payloadFrame('send', 'ping', toBuffer(d))));
    ws.on('pong', (d) => isLive() && this.px.book.addFrame(ex, payloadFrame('send', 'pong', toBuffer(d))));
    ws.on('error', () => undefined);
    ws.once('close', (code, reason) => {
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (!isLive()) return;
      if (!closeSent) this.px.book.addFrame(ex, closeFrame('send', code === 1005 ? undefined : code, toBuffer(reason)));
      this.px.book.finish(ex, 'mocked');
    });
    play(script.opening);
  }
}
