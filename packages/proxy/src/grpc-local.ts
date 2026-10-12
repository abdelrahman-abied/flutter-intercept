// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import * as http2 from 'http2';
import { grpcMessageHash } from './replay';
import { MAX_REPLAY_GAP_MS } from './replay-stream';
import { encodeGrpcMessage, frameMessage, messageFrame } from './grpc';
import type { Frame, RuleAction } from './types';
import type { FlowFault, GrpcCall } from './flow-types';
import { BLOCK_BODY, HTTP_TOKEN, FAULT_LABELS, sleep, REPLAY_GRPC_DROPPED } from './proxy-util';
import type { ProxyContext } from './proxy-context';

/** gRPC calls answered by the proxy itself: block, fault, grpcMock, replay. */
export class GrpcLocal {
  constructor(private readonly px: ProxyContext) {}

  /**
   * Answer with a trailers-only response (the status in the one HEADERS frame) and end the exchange in `state`.
   * After response headers (relay failures mid-response) the trailers end the response instead.
   */
  grpcStatusOnly(call: GrpcCall, code: number, message: string, state: 'blocked' | 'error' | 'mocked' | 'completed', error?: string): void {
    const { ex, info, stream } = call;
    const status: Record<string, string> = { 'grpc-status': String(code), ...(message ? { 'grpc-message': encodeGrpcMessage(message) } : {}) };
    call.localReset = true;
    try {
      if (!stream.destroyed && !stream.closed && !stream.headersSent) {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', ...status }, { endStream: true });
        this.px.grpc.grpcEndRequestSide(call);
        ex.status = 200;
        ex.responseHeaders = { 'content-type': 'application/grpc', ...status };
        info.trailersOnly = true;
      }
    } catch {
      /* the app is gone */
    }
    info.statusCode = code;
    if (message) info.statusMessage = message;
    if (!call.isLive()) return;
    if (state === 'error') return this.px.book.fail(ex, error ?? message);
    if (error) ex.error = error;
    this.px.book.finish(ex, state);
  }

  async grpcBlock(call: GrpcCall, a: Extract<RuleAction, { kind: 'block' }>): Promise<void> {
    this.px.grpc.drainGrpcRequest(call);
    if (a.mode === 'reset') {
      this.px.grpc.grpcReset(call, http2.constants.NGHTTP2_INTERNAL_ERROR);
      if (call.isLive()) this.px.book.finish(call.ex, 'blocked');
      return;
    }
    this.grpcStatusOnly(call, 14, BLOCK_BODY, 'blocked');
  }

  /**
   * Faults on a gRPC call (the truncate fault is the relay's): reset → RST_STREAM INTERNAL_ERROR; dns → UNAVAILABLE
   * "DNS lookup failed"; drop (throttle drop rate) → UNAVAILABLE after the latency; timeout → no answer until the app
   * gives up (or breakpointTimeoutMs, then RST_STREAM CANCEL). The exchange ends 'blocked'.
   */
  async grpcFault(call: GrpcCall, fault: FlowFault): Promise<void> {
    const { ex, flow } = call;
    this.px.grpc.drainGrpcRequest(call);
    if (fault === 'reset') {
      this.px.grpc.grpcReset(call, http2.constants.NGHTTP2_INTERNAL_ERROR);
      if (call.isLive()) this.px.book.finish(ex, 'blocked');
      return;
    }
    if (fault === 'dns') return this.grpcStatusOnly(call, 14, 'DNS lookup failed', 'blocked');
    if (fault === 'drop') {
      if (!(await this.px.edits.latency(ex, flow)) || !call.isLive()) return;
      return this.grpcStatusOnly(call, 14, 'Flutter Intercept: dropped (simulated network)', 'blocked');
    }
    if (fault === 'timeout') {
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
      if (!call.isLive()) return;
      const secs = ((Date.now() - ex.startedAt) / 1000).toFixed(1);
      ex.simulated = appLeft ? `${FAULT_LABELS.timeout} (the app gave up after ${secs} s)` : `${FAULT_LABELS.timeout} (reset after ${secs} s)`;
      if (!appLeft) this.px.grpc.grpcReset(call, http2.constants.NGHTTP2_CANCEL);
      this.px.book.finish(ex, 'blocked');
    }
  }

  /** grpcMock: after `delayMs`, `headers`, each message `gapMs` apart, then the status (CONTRACTS §16.2). */
  async grpcMock(call: GrpcCall, a: Extract<RuleAction, { kind: 'grpcMock' }>): Promise<void> {
    const messages = (a.messages ?? []).map((m) => Buffer.from(String(m), 'base64'));
    const gap = a.gapMs && a.gapMs > 0 ? a.gapMs : 0;
    this.px.grpc.drainGrpcRequest(call);
    await this.grpcAnswer(call, {
      code: a.code ?? 0,
      message: a.message,
      messages,
      gaps: messages.map((_, i) => (i === 0 ? 0 : gap)),
      headers: a.headers,
      trailers: a.trailers,
      delayMs: a.delayMs,
    });
  }

  /**
   * CONTRACTS §17.4: a recorded call answers like a grpcMock — its response headers (minus pseudo / content-type /
   * status / encoding), its response messages (sent uncompressed, recorded gaps capped at 5 s), its status and
   * trailers. When several recorded calls share the path and carry a requestHash, the first request message picks one.
   */
  async grpcReplay(call: GrpcCall): Promise<void> {
    const store = this.px.replayStore;
    let firstFrame: ((f: Frame | undefined) => void) | undefined;
    const first = new Promise<Frame | undefined>((r) => (firstFrame = r));
    let seen = false;
    this.px.grpc.drainGrpcRequest(call, (f) => {
      if (f.dir === 'send' && !seen) {
        seen = true;
        firstFrame?.(f);
      }
    });
    call.req.once('end', () => setTimeout(() => firstFrame?.(undefined), 50)); // the last frame may still be decompressing
    call.stream.once('close', () => firstFrame?.(undefined));
    let hit = store?.lookupGrpc(call.req.url, 'unknown', false);
    if (hit === 'needs-body') {
      const f = await first;
      if (!call.isLive()) return;
      const hash = f ? grpcMessageHash(Buffer.from(f.base64 ?? '', 'base64')) : undefined;
      hit = store?.lookupGrpc(call.req.url, { hash }, true);
    } else if (hit) hit = store?.lookupGrpc(call.req.url, 'unknown', true);
    if (!hit || hit === 'needs-body') return this.grpcStatusOnly(call, 14, 'Flutter Intercept: not in the recording', 'error', 'Not in the recording.');
    const e = hit.entry;
    const frames = (e.frames ?? []).filter((f) => f.kind === 'message' && f.dir === 'receive' && !f.dropped);
    const clean = (h: Record<string, string | string[]> | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(h ?? {})) {
        const lk = k.toLowerCase();
        const val = Array.isArray(v) ? v.join(', ') : v;
        if (!HTTP_TOKEN.test(lk) || lk.startsWith(':') || REPLAY_GRPC_DROPPED.has(lk) || typeof val !== 'string' || /[\r\n\0]/.test(val)) continue;
        out[lk] = val;
      }
      return out;
    };
    await this.grpcAnswer(call, {
      code: e.grpc?.code ?? 0,
      message: e.grpc?.message,
      messages: frames.map((f) => Buffer.from(f.base64 ?? '', 'base64')),
      gaps: frames.map((f, i) => (i === 0 ? 0 : Math.min(MAX_REPLAY_GAP_MS, Math.max(0, f.at - frames[i - 1].at)))),
      headers: clean(e.headers),
      trailers: clean(e.grpc?.trailers),
    });
  }

  /**
   * A local answer (grpcMock, replay): after `delayMs`, response headers (`content-type: application/grpc` +
   * `headers`), each message after its gap, then the status trailers. A non-zero code without messages is
   * trailers-only. Never waits for the app to half-close (bidi).
   */
  async grpcAnswer(
    call: GrpcCall,
    a: { code: number; message?: string; messages: Buffer[]; gaps: number[]; headers?: Record<string, string>; trailers?: Record<string, string>; delayMs?: number },
  ): Promise<void> {
    const { ex, info, stream } = call;
    const open = () => call.isLive() && !stream.closed && !stream.destroyed;
    if (a.delayMs && a.delayMs > 0) {
      const from = performance.now();
      await sleep(a.delayMs);
      if (call.isLive()) this.px.book.addPhase(ex, 'delayMs', performance.now() - from);
      if (!open()) return;
    }
    const code = a.code;
    const messages = a.messages;
    const lower = (h: Record<string, string> | undefined) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const headers: Record<string, string> = { 'content-type': 'application/grpc', ...lower(a.headers) };
    const trailers: Record<string, string> = {
      'grpc-status': String(code),
      ...(a.message ? { 'grpc-message': encodeGrpcMessage(a.message) } : {}),
      ...lower(a.trailers),
    };
    info.statusCode = code;
    if (a.message) info.statusMessage = a.message;
    if (code !== 0 && !messages.length) {
      call.localReset = true;
      stream.respond({ ':status': 200, ...headers, ...trailers }, { endStream: true });
      this.px.grpc.grpcEndRequestSide(call);
      ex.status = 200;
      ex.responseHeaders = { ...headers, ...trailers };
      info.trailersOnly = true;
      this.px.book.finish(ex, 'mocked');
      return;
    }
    stream.removeAllListeners('wantTrailers'); // the compatibility response's own (it would send empty trailers)
    stream.on('wantTrailers', () => {
      call.localReset = true;
      try {
        stream.sendTrailers(trailers);
        this.px.grpc.grpcEndRequestSide(call);
      } catch {
        /* gone */
      }
      if (!call.isLive()) return;
      ex.responseTrailers = { ...trailers };
      this.px.book.finish(ex, 'mocked');
    });
    stream.respond({ ':status': 200, ...headers }, { waitForTrailers: true });
    ex.status = 200;
    ex.responseHeaders = { ...headers };
    this.px.book.emitChange(ex);
    for (let i = 0; i < messages.length; i++) {
      if (a.gaps[i] > 0) await sleep(a.gaps[i]);
      if (!open()) return;
      const m = messages[i];
      const ok = stream.write(frameMessage(m));
      info.messagesReceived++;
      this.px.book.addFrame(ex, messageFrame('receive', { compressed: false, size: m.length, kept: m, complete: true }, Date.now(), true));
      if (!ok) await new Promise<void>((r) => (stream.once('drain', r), stream.once('close', r)));
    }
    if (open()) stream.end();
  }
}
