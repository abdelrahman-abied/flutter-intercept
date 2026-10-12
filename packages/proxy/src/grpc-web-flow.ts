// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import { STATUS_CODES } from 'http';
import type { OngoingRequest } from 'mockttp';
import { cleanHeaders, getHeader, type HeaderBag } from './body';
import {
  encodeGrpcMessage,
  grpcEncodingOf,
  GrpcFrameRecorder,
  GRPC_COMPRESSED_KEEP_BYTES,
  parseGrpcPath,
  parseGrpcTimeout,
} from './grpc';
import {
  GRPC_WEB_EXPOSE_HEADERS,
  grpcStatusOf,
  grpcWebBody,
  grpcWebContentType,
  GrpcWebRecorder,
  type GrpcWebVariant,
} from './grpc-web';
import { getTap } from './taps';
import type { Exchange, Frame, RuleAction } from './types';
import type { CallbackRequestResult, Flow, GrpcWebState } from './flow-types';
import { sleep } from './proxy-util';
import type { ProxyContext } from './proxy-context';

/** REVIEW-13 #1: work bounds of the passive gRPC-Web reader (per call and direction). */
export const GRPC_WEB_RECORD_FRAMES = 1000;

export const GRPC_WEB_DECOMPRESS_MESSAGES = 100;

/** After the response ended: at most this long to finish reading / decompressing before the call is forgotten. */
export const GRPC_WEB_FORGET_MS = 2000;

/** CONTRACTS §19.1: a gRPC-Web exchange is shown as a gRPC call. */
export function grpcWebExchangeFields(url: string, headers: HeaderBag, web: GrpcWebVariant): Partial<Exchange> {
  let path = '/';
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep / */
  }
  const { service, method } = parseGrpcPath(path);
  const deadlineMs = parseGrpcTimeout(headers['grpc-timeout']);
  return {
    kind: 'grpc',
    frames: [],
    grpc: { service, method, messagesSent: 0, messagesReceived: 0, web, ...(deadlineMs !== undefined ? { deadlineMs } : {}) },
  };
}

/** CONTRACTS §19.1: the passive gRPC-Web reader and grpcMock answers for gRPC-Web. */
export class GrpcWebFlow {
  /** CONTRACTS §19.1: gRPC-Web calls being read (by request id). */
  readonly grpcWebCalls = new Map<string, GrpcWebState>();

  constructor(private readonly px: ProxyContext) {}

  // ---------------------------------------------------------------- gRPC-Web (CONTRACTS §19.1)

  /**
   * Read a gRPC-Web call's bodies from the taps as they pass (any route), into frames / trailers on its exchange.
   * Bounded by work (REVIEW-13 #1): ≤ GRPC_WEB_RECORD_FRAMES recorded frames and ≤ GRPC_WEB_DECOMPRESS_MESSAGES
   * decompressed messages per direction, the rest counted from frame headers; the reader stops at its frame / decode
   * caps and is stopped (decoders destroyed, nothing queued) once the call is forgotten.
   */
  watchGrpcWeb(req: OngoingRequest, variant: GrpcWebVariant): void {
    const tap = getTap(req.id);
    if (!tap) return;
    const id = req.id;
    tap.req.skip = true; // frames instead of a raw body copy
    tap.res.skip = true;
    const st: GrpcWebState = {
      sent: 0,
      received: 0,
      recorded: { send: 0, receive: 0 },
      compressed: { send: 0, receive: 0 },
      queue: [],
      notes: [],
      reqEnc: grpcEncodingOf((req.headers as HeaderBag)['grpc-encoding']),
    } as unknown as GrpcWebState;
    const sink = (f: Frame) => {
      if (st.forgotten) return; // never queue for a call that is gone
      st.queue.push(f);
      this.scheduleGrpcWebSync(id, st);
    };
    const recs = {
      send: new GrpcFrameRecorder('send', () => st.reqEnc, sink, true),
      receive: new GrpcFrameRecorder('receive', () => st.resEnc, sink, true),
    };
    const note = (text: string) => {
      if (!st.notes.includes(text) && st.notes.length < 10) st.notes.push(text);
      this.scheduleGrpcWebSync(id, st);
    };
    st.rec = new GrpcWebRecorder(variant, {
      onMessage: (dir, m) => {
        if (st.forgotten) return;
        if (dir === 'send') st.sent++;
        else st.received++;
        if (st.recorded[dir] >= GRPC_WEB_RECORD_FRAMES) {
          if (st.recorded[dir] === GRPC_WEB_RECORD_FRAMES) note(`Only the first ${GRPC_WEB_RECORD_FRAMES} messages each way were recorded; later ones were counted.`);
          st.recorded[dir]++;
          return this.scheduleGrpcWebSync(id, st);
        }
        st.recorded[dir]++;
        // Decompression work is bounded per call too: later compressed messages are recorded without a payload.
        const decompress = !m.compressed || st.compressed[dir]++ < GRPC_WEB_DECOMPRESS_MESSAGES;
        recs[dir].push(decompress ? m : { ...m, kept: Buffer.alloc(0), complete: false });
      },
      onTrailers: (t) => {
        if (st.forgotten) return;
        st.trailers = t;
        this.scheduleGrpcWebSync(id, st);
      },
      onProblem: note,
      compressedKeep: GRPC_COMPRESSED_KEEP_BYTES,
    });
    this.grpcWebCalls.set(id, st);
    tap.onRequestData = (b) => st.rec.requestData(b);
    const reqEnd = tap.onRequestEnd;
    tap.onRequestEnd = () => {
      st.rec.requestEnd();
      reqEnd?.();
    };
    tap.onHeadSeen = (_status, h) => {
      st.resEnc = grpcEncodingOf(h['grpc-encoding']);
      const s = grpcStatusOf(h);
      if (s.code !== undefined) st.headStatus = s; // trailers-only (status in the headers)
      st.rec.responseHead(h);
      this.scheduleGrpcWebSync(id, st);
    };
    tap.onResponseData = (b) => st.rec.responseData(b);
    const done = tap.onResponseDone;
    tap.onResponseDone = (finished) => {
      done?.(finished);
      st.rec.requestEnd();
      if (finished) st.rec.responseEnd();
      else st.rec.stop(); // aborted: release the decoders and buffers now
      // The rest of the body is read (bounded, at most GRPC_WEB_FORGET_MS), late frames join the stored exchange,
      // then the call is forgotten and its reader stopped.
      const deadline = sleep(GRPC_WEB_FORGET_MS);
      void Promise.race([st.rec.done, deadline])
        .then(() => Promise.race([Promise.all([recs.send.idle(), recs.receive.idle()]), deadline]))
        .then(() => {
          st.rec.stop();
          this.syncGrpcWeb(id);
          st.forgotten = true;
          st.queue.length = 0;
          this.grpcWebCalls.delete(id);
        });
    };
  }

  /** One sync per tick for a call (REVIEW-13 #1: never one exchange event per frame). */
  scheduleGrpcWebSync(id: string, st: GrpcWebState): void {
    if (st.syncScheduled || st.forgotten) return;
    st.syncScheduled = true;
    setImmediate(() => {
      st.syncScheduled = false;
      this.syncGrpcWeb(id);
    });
  }

  /** Move what the reader found onto the exchange (once it exists: hooked routes create it after the body). */
  syncGrpcWeb(id: string): void {
    const st = this.grpcWebCalls.get(id);
    const live = this.px.book.live.get(id);
    const ex = live?.ex ?? this.px.book.store.get(id);
    if (!st) return;
    if (!ex || !ex.grpc) {
      if (st.forgotten) st.queue.length = 0;
      return;
    }
    const frames = st.queue.splice(0);
    for (const f of frames) this.px.book.addFrame(ex, f, true);
    const g = ex.grpc;
    g.messagesSent = Math.max(g.messagesSent, st.sent);
    g.messagesReceived = Math.max(g.messagesReceived, st.received);
    if (st.reqEnc) g.requestEncoding = st.reqEnc;
    if (st.resEnc) g.responseEncoding = st.resEnc;
    const status = st.trailers ? grpcStatusOf(st.trailers) : st.headStatus;
    if (st.trailers) ex.responseTrailers = { ...st.trailers };
    if (status?.code !== undefined) {
      g.statusCode = status.code;
      if (status.message !== undefined) g.statusMessage = status.message;
      if (!st.trailers && st.headStatus) g.trailersOnly = true;
    }
    for (const n of st.notes) this.px.book.addNote(ex, n);
    st.notes.length = 0;
    this.px.book.touch(ex);
  }

  /** CORS for a local gRPC-Web answer (like other mocks), plus the gRPC status headers exposed to the page. */
  addGrpcWebCors(ex: Exchange, headers: HeaderBag): void {
    this.px.edits.addCorsToLocalResponse(ex, headers);
    if (getHeader(headers, 'access-control-allow-origin') && !getHeader(headers, 'access-control-expose-headers')) {
      headers['access-control-expose-headers'] = GRPC_WEB_EXPOSE_HEADERS;
    }
  }

  /** CONTRACTS §19.1: grpcMock for a gRPC-Web call: HTTP 200, the request's variant, frames, then the trailer frame. */
  async answerGrpcWeb(ex: Exchange, flow: Flow, a: Extract<RuleAction, { kind: 'grpcMock' }>): Promise<CallbackRequestResult> {
    this.px.book.track(ex, flow);
    if (a.delayMs && a.delayMs > 0) {
      const from = performance.now();
      await sleep(a.delayMs);
      this.px.book.addPhase(ex, 'delayMs', performance.now() - from);
      if (ex.state !== 'pending') return { response: 'close' };
    }
    const variant = flow.grpcWeb!;
    const code = a.code ?? 0;
    const messages = (a.messages ?? []).map((m) => Buffer.from(String(m), 'base64'));
    const custom = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const trailers = Object.fromEntries(Object.entries(a.trailers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const headers: HeaderBag = { ...custom, 'content-type': grpcWebContentType(variant) };
    let body: Buffer;
    if (code !== 0 && !messages.length) {
      // Trailers-only: the status in the headers, no body.
      Object.assign(headers, trailers, { 'grpc-status': String(code), ...(a.message ? { 'grpc-message': encodeGrpcMessage(a.message) } : {}) });
      body = Buffer.alloc(0);
    } else body = grpcWebBody(variant, messages, code, a.message, trailers);
    if (a.gapMs) this.px.book.addNote(ex, 'gapMs doesn\'t apply to gRPC-Web mocks (one response body); the messages were sent together.');
    this.addGrpcWebCors(ex, headers);
    headers['content-length'] = String(body.length);
    ex.status = 200;
    ex.responseHeaders = cleanHeaders(headers);
    if (ex.grpc) {
      ex.grpc.statusCode = code;
      if (a.message) ex.grpc.statusMessage = a.message;
    }
    this.px.book.finish(ex, 'mocked');
    return { response: { statusCode: 200, statusMessage: STATUS_CODES[200], headers, rawBody: body } };
  }
}
