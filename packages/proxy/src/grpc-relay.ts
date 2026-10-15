// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import { requestInternals } from './mockttp-internals';
import * as http from 'http';
import * as http2 from 'http2';
import type { Readable } from 'stream';
import { randomUUID } from 'crypto';
import * as net from 'net';
import * as tls from 'tls';
import type { OngoingRequest } from 'mockttp';
import { type HeaderBag } from './body';
import { mapRemoteUrl } from './rules';
import { viaUpstreamProxy } from './tunnel';
import { PacedStream } from './pace';
import {
  decodeGrpcMessage,
  encodeGrpcMessage,
  FirstMessageCut,
  forwardableHeaders,
  frameMessage,
  GRPC_CONNECT_TIMEOUT_MS,
  grpcEncodingOf,
  GrpcMessageParser,
  h2CodeName,
  GrpcFrameRecorder,
  GRPC_HOOK_CAP_BYTES,
  Observer,
  parseGrpcPath,
  parseGrpcStatus,
  parseGrpcTimeout,
  recordedHeaders,
} from './grpc';
import { GrpcSessionPool } from './grpc-upstream';
import {
  GRPC_SEND_DEADLINE_MS,
  GRPC_SEND_MAX_BYTES,
  GRPC_SEND_MAX_DEADLINE_MS,
  GRPC_SEND_MAX_MESSAGES,
} from './grpc-meta';
import { materializeFrame } from './frames';
import { HOST_ALIASES } from './upstream-pool';
import { getTap } from './taps';
import { findOnSocketChain, LanGate, lanGateOf, lanTargetDenial, SsrfError, SSRF_MARKER } from './lan';
import { describeProfile } from './network';
import { elapsed } from './timing';
import { mentionsGrpcHooks } from './script';
import type { Frame, GrpcInfo, Rule, SendRequest } from './types';
import type { Applied, Route, SendMeta, Flow, GrpcCall, SilentInfo } from './flow-types';
import { SILENT_INFO } from './flow-types';
import {
  SEND_HEADER,
  FAULT_LABELS,
  throttleLabel,
  profileLabel,
  defaultCa,
  capitalize,
  fiText,
  GRPC_LOOP_TEXT,
  INTERNAL_TUNNEL_HEADER,
  GRPC_SEND_DROPPED,
} from './proxy-util';
import { rewriteFlow } from './rewrite-flow';
import { normalizeHostname } from './hosts';
import { alertOf } from './learned';
import type { ProxyContext } from './proxy-context';

/** CONTRACTS §16.2: the gRPC relay (h2c / decrypted silent tunnels and send()). */
export class GrpcRelay {
  constructor(private readonly px: ProxyContext) {}

  /**
   * CONTRACTS §18.4 / §18.6: send a gRPC call (resend / edit & resend) exactly like the app would: through a silent
   * tunnel into this proxy's own listener (h2c, or TLS to our own MITM for https targets), so rules, breakpoints, the
   * network profile, replay, Map Remote and the LAN guard all apply, and the call is recorded with `initiator` /
   * `resentFrom`. Messages go uncompressed, then a half-close. A resend of a LAN client's call runs with that client's
   * LAN guards (LAN mode must be on); one whose original record is gone is refused. Resolves once recorded.
   */
  async sendGrpc(r: SendRequest, method: string, u: URL, headers: HeaderBag): Promise<{ id: string }> {
    const g = r.grpc as { messages?: unknown; messagesJson?: unknown };
    if (!g || typeof g !== 'object') throw new Error('grpc must be {messages}');
    if (g.messagesJson !== undefined) throw new Error('grpc.messagesJson must be encoded by the host (schema) into messages before send()');
    if (method !== 'POST') throw new Error('A gRPC call is sent with POST');
    const { method: rpc } = parseGrpcPath(u.pathname);
    if (!rpc || u.search) throw new Error(`Not a gRPC method URL (/package.Service/Method): ${u.pathname}`);
    if (!Array.isArray(g.messages)) throw new Error('grpc.messages must be a list of base64 messages');
    if (g.messages.length > GRPC_SEND_MAX_MESSAGES) throw new Error(`At most ${GRPC_SEND_MAX_MESSAGES} messages per call`);
    if (!this.px.grpcCheck.ok || !this.px.rawServer) throw new Error(`gRPC calls can't be sent: ${this.px.grpcCheck.problem ?? 'the proxy is not running'}`);
    const messages: Buffer[] = [];
    let total = 0;
    for (const [i, m] of g.messages.entries()) {
      if (typeof m !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(m)) throw new Error(`Message ${i + 1} is not base64`);
      const b = Buffer.from(m, 'base64');
      if (b.length > GRPC_HOOK_CAP_BYTES) throw new Error(`Message ${i + 1} is over ${GRPC_HOOK_CAP_BYTES / 1024 / 1024} MB`);
      total += b.length;
      if (total > GRPC_SEND_MAX_BYTES) throw new Error(`The messages are over ${GRPC_SEND_MAX_BYTES / 1024 / 1024} MB in total`);
      messages.push(b);
    }
    // A resend of a LAN client's call: only targets the LAN guard allows (CONTRACTS §18.5 / §18.6).
    let fromLan = false;
    if (r.resentFrom !== undefined) {
      const orig = this.px.book.store.get(r.resentFrom);
      if (!orig) throw new Error('The original call is no longer recorded, so it can\'t be resent (its LAN origin is unknown)');
      fromLan = orig.viaLan === true;
    }
    if (fromLan) {
      const gate = this.px.lanGate;
      if (!gate || gate.closed) throw new Error('This call came from a LAN client and LAN mode is off: it can only be resent while LAN mode is on');
      const denial = await lanTargetDenial(u.href, gate.host);
      if (denial) throw new Error(denial);
    }
    const meta: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (v === undefined || lk.startsWith(':') || GRPC_SEND_DROPPED.has(lk)) continue;
      meta[lk] = v;
    }
    const given = parseGrpcTimeout(meta['grpc-timeout']);
    const deadlineMs = Math.min(given ?? GRPC_SEND_DEADLINE_MS, GRPC_SEND_MAX_DEADLINE_MS);
    meta['grpc-timeout'] = given !== undefined && given <= GRPC_SEND_MAX_DEADLINE_MS ? String(meta['grpc-timeout']) : given === undefined ? '60S' : '1H';
    const tlsTarget = u.protocol === 'https:';
    const target = `${u.hostname.includes(':') ? `[${u.hostname.replace(/^\[|\]$/g, '')}]` : u.hostname}:${Number(u.port) || (tlsTarget ? 443 : 80)}`;
    const nonce = randomUUID();
    const ca = tlsTarget ? (this.px.opts.ca ?? (await defaultCa())).cert : undefined;
    return new Promise<{ id: string }>((resolve, reject) => {
      const sendMeta: SendMeta = {
        initiator: r.initiator,
        ...(r.resentFrom !== undefined ? { resentFrom: r.resentFrom } : {}),
        done: false,
        recorded: (id) => {
          sendMeta.done = true;
          this.px.sends.delete(nonce);
          resolve({ id });
        },
      };
      let session: http2.ClientHttp2Session | undefined;
      let sock: net.Socket | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        session?.destroy();
        sock?.destroy();
      };
      const failed = (why: string) => {
        if (!sendMeta.done) {
          sendMeta.done = true;
          this.px.sends.delete(nonce);
          reject(new Error(`Flutter Intercept: send failed (${why})`));
        }
        cleanup();
      };
      // The app-side deadline: the call is cancelled then (the exchange records it), plus a margin for the answer.
      const timer = setTimeout(() => failed('deadline'), deadlineMs + 5000);
      timer.unref?.();
      this.px.sends.set(nonce, sendMeta);
      const host = this.px.host === '0.0.0.0' || this.px.host === '' ? '127.0.0.1' : this.px.host === '::' ? '::1' : this.px.host;
      sock = net.connect(this.px.port, host);
      sock.on('error', (e) => failed(e.message));
      sock.once('connect', () => {
        const flags = [this.px.hopNonce, ...(tlsTarget ? ['tls'] : []), ...(fromLan ? ['lan'] : [])].join('; ');
        sock!.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nFlutter-Intercept-Tunnel: silent\r\n${INTERNAL_TUNNEL_HEADER}: ${flags}\r\n\r\n`);
        let conn: net.Socket = sock!;
        if (tlsTarget) {
          // To our own MITM over loopback: the hop is authenticated by the nonce, the real server is verified upstream.
          conn = tls.connect({ socket: sock!, ...(net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? {} : { servername: u.hostname }), ALPNProtocols: ['h2'], ca, rejectUnauthorized: false });
          conn.on('error', (e) => failed(e.message));
        }
        const s = http2.connect(`${u.protocol}//${target}`, { createConnection: () => conn });
        session = s;
        s.on('error', (e) => failed(e.message));
        const call = s.request({
          ...meta,
          ':method': 'POST',
          ':path': u.pathname,
          ':authority': u.host,
          'content-type': 'application/grpc',
          te: 'trailers',
          [SEND_HEADER]: nonce,
        });
        call.on('error', () => undefined);
        call.on('data', () => undefined); // the exchange records the answer
        call.once('close', () => {
          if (!sendMeta.done) failed('the call was not recorded');
          else cleanup();
        });
        const cancel = setTimeout(() => {
          if (!call.closed) call.close(http2.constants.NGHTTP2_CANCEL); // the deadline, like the app's own
        }, deadlineMs);
        cancel.unref?.();
        call.once('close', () => clearTimeout(cancel));
        for (const m of messages) call.write(frameMessage(m));
        call.end();
      });
    });
  }

  // ---------------------------------------------------------------- gRPC (CONTRACTS §16.2)

  /** A gRPC call's flow: the first applicable rule (or sequence step), the network profile. */
  decideGrpc(req: OngoingRequest): Flow {
    const meta0 = this.px.reqMeta.get(req);
    if (meta0?.hop !== undefined && meta0.hop === this.px.hopNonce) {
      // CONTRACTS §18.6: our own relayed call came back — refused, not recorded (the sending side records it).
      const loop: Flow = { route: 'grpc', loop: true };
      this.px.book.flows.set(req.id, loop);
      return loop;
    }
    const m = this.px.matchRule(req.method, req.url, { count: true, grpc: true });
    let flow = this.grpcFlowFor(req.url, m.rule, m.action, m.note, m.step);
    // REVIEW-10 #6 (REVIEW-8 #1): a web page's call to a client-certificate host is refused before any connection.
    const k = flow.action?.kind;
    const forwards =
      !flow.fault && !flow.replay && !flow.localError && (!k || k === 'throttle' || k === 'breakpoint' || k === 'mutate' || k === 'rewrite' || k === 'script' || k === 'mapRemote');
    const refused = forwards ? this.px.certRefusal(flow.map?.url ?? req.url, req.headers as HeaderBag) : undefined;
    if (refused) flow = { route: 'grpc', ...(m.rule ? { rule: m.rule } : {}), refused };
    const meta = this.px.reqMeta.get(req);
    if (meta?.traceId) flow.traceId = meta.traceId;
    // CONTRACTS §18.6: a call made by send() (its own silent tunnel into this listener): initiator / resentFrom.
    const send = meta?.sendNonce ? this.px.sends.get(meta.sendNonce) : undefined;
    if (send) flow.send = send;
    if (lanGateOf(requestInternals(req).socket)) flow.viaLan = true;
    flow.te = requestInternals(req).timingEvents;
    this.px.book.flows.set(req.id, flow);
    // Messages are recorded as frames by the relay: the taps keep no body copy.
    const tap = getTap(req.id);
    if (tap) {
      tap.req.skip = true;
      tap.res.skip = true;
    }
    return flow;
  }

  /** Like flowFor, for the actions that apply to gRPC: faults, throttle (+ the profile and its drop rate), block, grpcMock. */
  grpcFlowFor(url: string, rule: Rule | undefined, action: Applied, note?: string, step?: number): Flow {
    const store = this.px.replayStore;
    if (!rule && store?.lookupGrpc(url, 'unknown', false)) {
      // CONTRACTS §17.4: answered from the recording (like a grpcMock); the entry is chosen once the call starts.
      return { route: 'grpc', replay: 'deferred', simulated: `Replayed from ${store.name ?? 'a recording'}`, ...(note ? { note } : {}) };
    }
    let flow: Flow = { route: 'grpc', ...(rule ? { rule } : {}), ...(action ? { action } : {}) };
    let dropRate: number | undefined;
    if (action?.kind === 'fault') {
      flow.fault = action.fault;
      flow.simulated = FAULT_LABELS[action.fault];
    } else if (action?.kind === 'throttle') {
      flow.throttle = { latencyMs: action.latencyMs, kbps: action.kbps, uploadKbps: action.uploadKbps };
      flow.simulated = throttleLabel(action);
      dropRate = action.dropRate;
    } else if (action?.kind === 'rewrite') {
      // CONTRACTS §18.1: metadata only (bodies and status don't apply to protobuf calls; noted when set).
      flow.rewrite = rewriteFlow(action);
      flow.simulated = 'Rewritten: metadata';
      const r = action;
      if (flow.rewrite.reqBody || flow.rewrite.resBody || r.response?.status !== undefined) {
        flow.note = 'Rewrite rule: body replacements and the status don\'t apply to gRPC calls (use mutate or a script); its metadata changes were applied.';
      }
    } else if (action?.kind === 'mapRemote') {
      // CONTRACTS §18.3: the call goes to another server; the exchange keeps the app's URL.
      try {
        const target = mapRemoteUrl(url, rule?.match.url ?? '', action.to);
        const t = new URL(target);
        if (t.protocol !== 'http:' && t.protocol !== 'https:') throw new Error(`a gRPC call can only be mapped to http(s)://, got ${t.protocol}`);
        flow.map = { url: target, host: action.preserveHost ? '' : t.host };
        flow.originalUrl = url;
        flow.simulated = `Mapped to ${t.origin}`;
      } catch (e) {
        flow.localError = `Map Remote rule${rule?.name ? ` "${rule.name}"` : ''}: ${(e as Error).message}`;
      }
    }
    const k = action?.kind;
    const reachesNetwork = !action || k === 'throttle' || k === 'breakpoint' || k === 'mutate' || k === 'rewrite' || k === 'script' || k === 'mapRemote';
    const p = this.px.profile;
    if (flow.localError) {
      dropRate = undefined;
    } else if (reachesNetwork && p.kind === 'offline') {
      flow = { route: 'grpc', ...(rule ? { rule } : {}), fault: 'dns', simulated: describeProfile(p) };
      dropRate = undefined;
    } else if (!rule && store?.fallback === 'fail') {
      // Not in the recording (CONTRACTS §17.4): the "fail" fallback (offline demo) keeps it off the network.
      flow = { route: 'grpc', fault: 'dns', simulated: `Not in the recording${store.name ? ` "${store.name}"` : ''} (replay: fail)` };
      dropRate = undefined;
    } else if (reachesNetwork && p.kind === 'throttle' && action?.kind !== 'throttle') {
      flow.throttle = { latencyMs: p.latencyMs, kbps: p.kbps, uploadKbps: p.uploadKbps };
      flow.simulated = flow.simulated ? `${profileLabel(p)} · ${flow.simulated}` : profileLabel(p);
      dropRate = p.dropRate;
    }
    if (dropRate && dropRate > 0 && Math.random() < dropRate) {
      flow = { route: 'grpc', ...(rule ? { rule } : {}), fault: 'drop', throttle: { latencyMs: flow.throttle?.latencyMs }, simulated: `${flow.simulated ?? 'Throttle'}: dropped` };
    }
    if (step !== undefined && rule?.action.kind === 'sequence') {
      flow.step = step;
      const n = rule.action.steps?.length ?? 0;
      const label = step < 0 ? 'Sequence done: passed through' : `Sequence step ${step + 1}/${n}`;
      flow.simulated = flow.simulated ? `${label} · ${flow.simulated}` : label;
    }
    if (note && !flow.note) flow.note = note;
    return flow;
  }

  /**
   * mockttp step for gRPC calls (own `handle`): everything is written on the raw HTTP/2 stream (trailers-only answers,
   * trailers, RST codes and flow control survive), then mockttp's compatibility response is marked ended.
   */
  async onGrpc(req: OngoingRequest, res: http.ServerResponse): Promise<void> {
    const compat = res as unknown as { stream?: http2.ServerHttp2Stream; writableEnded?: boolean; end(): unknown };
    const stream = compat.stream;
    try {
      if (!stream) throw new Error('not an HTTP/2 stream');
      await this.runGrpc(req, stream);
    } catch (e) {
      const live = this.px.book.live.get(req.id);
      if (live) this.px.book.fail(live.ex, `The gRPC relay failed: ${(e as Error)?.message ?? String(e)}`);
      try {
        if (stream && !stream.destroyed) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      } catch {
        /* already gone */
      }
    } finally {
      this.px.book.flows.delete(req.id);
      // Ends mockttp's tracking of the compatibility response (a no-op on the closed stream), then marks it ended
      // (else mockttp reports "finished without ending the response").
      try {
        compat.end();
      } catch {
        /* closed */
      }
      if (!compat.writableEnded) {
        try {
          Object.defineProperty(res, 'writableEnded', { value: true, configurable: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Record the call and answer it per its flow; resolves when the app's stream is closed. */
  runGrpc(req: OngoingRequest, stream: http2.ServerHttp2Stream): Promise<void> {
    const flow = this.px.book.flows.get(req.id) ?? { route: 'grpc' as Route };
    if (flow.loop) {
      stream.on('error', () => undefined);
      req.on('error', () => undefined);
      req.resume();
      const done = new Promise<void>((resolve) => (stream.closed || stream.destroyed ? resolve() : stream.once('close', () => resolve())));
      try {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '14', 'grpc-message': encodeGrpcMessage(GRPC_LOOP_TEXT) }, { endStream: true });
        setImmediate(() => {
          if (!stream.closed && !stream.destroyed) stream.close(http2.constants.NGHTTP2_NO_ERROR);
        });
      } catch {
        /* gone */
      }
      return done;
    }
    const headers = req.headers as HeaderBag;
    let path = '/';
    try {
      path = new URL(req.url).pathname;
    } catch {
      /* keep / */
    }
    const { service, method } = parseGrpcPath(path);
    const ex = this.px.book.newExchange({ id: req.id, method: req.method, url: req.url, headers: recordedHeaders(headers), timingEvents: req.timingEvents }, flow);
    delete ex.graphql;
    delete ex.browserInternal;
    ex.kind = 'grpc';
    ex.frames = [];
    const reqEncoding = grpcEncodingOf(headers['grpc-encoding']);
    const deadlineMs = parseGrpcTimeout(headers['grpc-timeout']);
    const info: GrpcInfo = {
      service,
      method,
      messagesSent: 0,
      messagesReceived: 0,
      ...(reqEncoding ? { requestEncoding: reqEncoding } : {}),
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    };
    ex.grpc = info;
    this.px.book.track(ex, flow);
    const call: GrpcCall = { ex, info, flow, req, stream, isLive: () => this.px.book.live.get(ex.id)?.ex === ex };
    stream.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => {
      if (stream.closed || stream.destroyed) return resolve();
      stream.once('close', () => {
        this.onGrpcClosed(call);
        resolve();
      });
    });
    if (stream.closed || stream.destroyed) {
      this.onGrpcClosed(call);
      return closed;
    }
    let work: Promise<void>;
    const gate = lanGateOf(requestInternals(req).socket);
    if (gate) {
      // REVIEW-11 #7: like HTTP's LAN deny rule, before any local answer (mock, replay, block…): a LAN client's call to
      // this machine or its other networks is refused, in gRPC terms (UNAVAILABLE).
      // Map Remote (CONTRACTS §18.3): the mapped target is what gets checked.
      work = (gate.closed ? Promise.resolve(`${SSRF_MARKER}: LAN mode is off.`) : lanTargetDenial(flow.map?.url ?? req.url, gate.host)).then((reason) => {
        if (reason) {
          this.drainGrpcRequest(call);
          return this.px.grpcLocal.grpcStatusOnly(call, 14, fiText(reason), 'error', reason);
        }
        return this.grpcDispatch(call);
      });
    } else work = this.grpcDispatch(call);
    work.catch((e: unknown) => {
      if (call.isLive()) this.px.book.fail(ex, `The gRPC relay failed: ${(e as Error)?.message ?? String(e)}`);
      this.grpcReset(call, http2.constants.NGHTTP2_INTERNAL_ERROR);
    });
    return closed;
  }

  /** The answer per the call's flow: refusal, fault, block, mock, replay, or the relay. */
  grpcDispatch(call: GrpcCall): Promise<void> {
    const { flow } = call;
    const a = flow.action;
    if (!call.isLive()) return Promise.resolve();
    let work: Promise<void>;
    if (flow.refused) {
      this.drainGrpcRequest(call);
      this.px.grpcLocal.grpcStatusOnly(call, 14, fiText(flow.refused), 'blocked', flow.refused);
      work = Promise.resolve();
    } else if (flow.localError) {
      this.drainGrpcRequest(call);
      this.px.grpcLocal.grpcStatusOnly(call, 14, fiText(flow.localError), 'error', flow.localError);
      work = Promise.resolve();
    } else if (flow.fault === 'truncate') work = this.grpcRelay(call, true);
    else if (flow.fault) work = this.px.grpcLocal.grpcFault(call, flow.fault);
    else if (a?.kind === 'block') work = this.px.grpcLocal.grpcBlock(call, a);
    else if (a?.kind === 'grpcMock') work = this.px.grpcLocal.grpcMock(call, a);
    else if (flow.replay) work = this.px.grpcLocal.grpcReplay(call);
    else work = this.grpcRelay(call, false);
    return work;
  }

  /** Request messages of a call answered locally: read (and recorded) as they come. */
  drainGrpcRequest(call: GrpcCall, onFrame?: (f: Frame) => void): void {
    const parser = this.grpcRequestParser(call, onFrame).parser;
    call.req.on('data', (c: Buffer) => parser.push(c));
    call.req.once('end', () => {
      if (call.isLive()) this.px.book.setRequestMs(call.ex, call.flow.te, performance.now());
    });
    call.req.on('error', () => undefined);
  }

  /** Records one direction: a parser (counts + frames) and its recorder (also used by the hooks). */
  grpcRequestParser(call: GrpcCall, onFrame?: (f: Frame) => void): { parser: GrpcMessageParser; rec: GrpcFrameRecorder } {
    return this.grpcRecording(call, 'send', onFrame);
  }

  grpcRecording(call: GrpcCall, dir: Frame['dir'], onFrame?: (f: Frame) => void): { parser: GrpcMessageParser; rec: GrpcFrameRecorder } {
    const { info } = call;
    const rec = new GrpcFrameRecorder(
      dir,
      () => (dir === 'send' ? info.requestEncoding : info.responseEncoding),
      (f) => {
        this.px.book.addFrame(call.ex, f, true);
        if (onFrame) onFrame(materializeFrame(f));
      },
      true,
    );
    const parser = new GrpcMessageParser((m) => {
      if (!call.isLive()) return;
      if (dir === 'send') info.messagesSent++;
      else info.messagesReceived++;
      rec.push(m);
    });
    return { parser, rec };
  }

  /** The app's stream closed. Unless the call already ended, the app cancelled it (or its connection went away). */
  onGrpcClosed(call: GrpcCall): void {
    const { ex, stream, up } = call;
    if (up && !up.closed && !up.destroyed) {
      try {
        up.close(http2.constants.NGHTTP2_CANCEL); // RST_STREAM CANCEL upstream
      } catch {
        /* gone */
      }
    }
    for (const t of call.transforms ?? []) t.destroy();
    const hold = this.px.holds.get(ex.id);
    if (hold) return hold(true); // the timeout fault: the app gave up
    const paused = this.px.paused.get(ex.id);
    if (!call.isLive() || (call.localReset && !paused)) return;
    const code = stream.rstCode;
    const deadline = call.info.deadlineMs;
    const elapsedMs = Date.now() - ex.startedAt;
    ex.error =
      code === http2.constants.NGHTTP2_CANCEL
        ? deadline !== undefined && elapsedMs >= deadline - 50
          ? `The app cancelled the call when its deadline (${deadline} ms) passed.`
          : 'The app cancelled the call (RST_STREAM CANCEL).'
        : code
          ? `The app reset the stream (${h2CodeName(code)}).`
          : 'The app closed the connection before the call ended.';
    if (paused) ex.error = `${ex.error} (it was paused at a breakpoint)`;
    delete ex.grpcPause;
    this.px.book.finish(ex, 'aborted');
    paused?.settle({ kind: 'gone' });
  }

  /** Reset the app's stream (RST_STREAM `code`); its close is then ours, not the app's. */
  grpcReset(call: GrpcCall, code: number): void {
    call.localReset = true;
    try {
      if (!call.stream.destroyed && !call.stream.closed) call.stream.close(code);
    } catch {
      /* gone */
    }
  }

  /**
   * The response is complete but the app is still sending (client / bidi streaming): like gRPC servers, close the
   * stream with RST_STREAM NO_ERROR once the response is out (RFC 7540 §8.1), so the app's call can finish.
   */
  grpcEndRequestSide(call: GrpcCall): void {
    const { stream } = call;
    call.localReset = true;
    setImmediate(() => {
      try {
        if (!stream.closed && !stream.destroyed && !stream.state?.remoteClose) stream.close(http2.constants.NGHTTP2_NO_ERROR);
      } catch {
        /* gone */
      }
    });
  }

  // ---------------------------------------------------------------- gRPC breakpoints and mutate (CONTRACTS §17.1–17.3)

  /** A non-error note on the exchange (shown with it), once per text. */
  grpcNote(call: GrpcCall, text: string): void {
    this.px.book.addNote(call.ex, text);
  }

  /** abort(id) on a paused gRPC call: RST_STREAM CANCEL both ways. */
  grpcAbort(call: GrpcCall): void {
    const { ex, up } = call;
    call.localReset = true;
    try {
      if (up && !up.closed && !up.destroyed) up.close(http2.constants.NGHTTP2_CANCEL);
    } catch {
      /* gone */
    }
    this.grpcReset(call, http2.constants.NGHTTP2_CANCEL);
    if (call.isLive()) {
      ex.error = 'Aborted at a breakpoint.';
      this.px.book.finish(ex, 'aborted');
    }
  }

  /** Does upstream TLS to this server skip verification (ignoreUpstreamCertErrors, or a MITM upstream proxy's flag)? */
  grpcInsecure(host: string, port: number, gate: LanGate | undefined): boolean {
    const ig = this.px.opts.ignoreUpstreamCertErrors;
    if (ig === true) return true;
    if (Array.isArray(ig) && (ig.includes(host) || ig.includes(`${host}:${port}`))) return true;
    const up = this.px.upstreamSpec;
    const alias = (this.px.opts.rewriteLocalhost ?? true) && !gate ? (h: string) => HOST_ALIASES[h] : undefined;
    return !!up?.ignoreCertErrors && viaUpstreamProxy({ host, port, upstream: up, alias, ...(gate ? { lan: { listenerHost: gate.host, closed: () => gate.closed } } : {}) });
  }

  /**
   * The relay (spike grpc-relay.js): our own HTTP/2 stream to the server, raw stream API both ways, pipes for flow
   * control, a side parser recording every message. `truncate`: forward the response headers and first message,
   * then RST_STREAM INTERNAL_ERROR.
   */
  async grpcRelay(call: GrpcCall, truncate: boolean): Promise<void> {
    const { ex, info, flow, req, stream } = call;
    const C = http2.constants;
    const latency = flow.throttle?.latencyMs;
    if (latency && latency > 0) {
      if (!(await this.px.edits.latency(ex, flow)) || !call.isLive() || stream.closed) return;
    }
    let target: URL;
    try {
      target = new URL(flow.map?.url ?? req.url); // CONTRACTS §18.3: Map Remote's target
    } catch {
      return this.px.grpcLocal.grpcStatusOnly(call, 14, 'Flutter Intercept: invalid request URL', 'error', 'Invalid request URL');
    }
    const protocol = target.protocol === 'https:' ? 'https:' : 'http:';
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port) || (protocol === 'https:' ? 443 : 80);
    const socket = requestInternals(req).socket;
    const gate = lanGateOf(socket);
    const connectTimeoutMs = findOnSocketChain(socket, (o) => (o as Record<symbol, SilentInfo | undefined>)[SILENT_INFO]?.connectTimeoutMs) ?? GRPC_CONNECT_TIMEOUT_MS;
    if (this.px.targetsSelf(host, port)) {
      // CONTRACTS §18.6: the proxy's own listener (directly, a tunnel or Map Remote): it would relay to itself.
      return this.px.grpcLocal.grpcStatusOnly(call, 14, GRPC_LOOP_TEXT, 'error', GRPC_LOOP_TEXT);
    }
    const cert = protocol === 'https:' ? this.px.certFor(host, port) : undefined;
    if (cert) ex.clientCertificate = cert.host;
    const pool = this.px.grpcPool;
    let lease: Awaited<ReturnType<GrpcSessionPool['acquire']>>;
    try {
      if (!pool) throw new Error('the proxy is stopping');
      if (gate?.closed) throw new SsrfError(host, host, 'LAN mode is off');
      lease = await pool.acquire(
        {
          protocol,
          host,
          port,
          ...(gate ? { gate } : {}),
          upstream: this.px.upstreamSpec,
          ...(!gate && (this.px.opts.rewriteLocalhost ?? true) ? { alias: (h: string) => HOST_ALIASES[h] } : {}),
          rejectUnauthorized: !this.grpcInsecure(host, port, gate),
          ...(cert ? { cert: { pattern: cert.host, options: cert.options } } : {}),
          connectTimeoutMs,
          connectsToSelf: (ip, p) => this.px.addressIsSelf(ip, p),
        },
        (p) => this.px.book.addTimings(ex.id, p),
      );
    } catch (e) {
      if (!call.isLive()) return;
      const err = e as Error & { statusCode?: number; code?: string };
      if (err.code === 'E_FI_LOOP') return this.px.grpcLocal.grpcStatusOnly(call, 14, GRPC_LOOP_TEXT, 'error', GRPC_LOOP_TEXT);
      const forbidden = e instanceof SsrfError || err.statusCode === 403;
      if (!forbidden && protocol === 'https:' && (await this.grpcRefusal(call, err))) return;
      const label = net.isIPv6(host) ? `[${host}]` : host;
      const reason = forbidden
        ? e instanceof SsrfError
          ? err.message
          : `${SSRF_MARKER}: ${err.message}`
        : `Could not connect to ${label}:${port}: ${err.message}`;
      return this.px.grpcLocal.grpcStatusOnly(call, 14, fiText(reason), 'error', reason);
    }
    if (!call.isLive() || stream.closed || stream.destroyed) {
      lease.release();
      return;
    }
    const headers = req.headers as HeaderBag;
    const appAuthority = typeof headers[':authority'] === 'string' ? (headers[':authority'] as string) : target.host;
    // Map Remote: the new host unless preserveHost (CONTRACTS §18.3).
    const authority = flow.map ? flow.map.host || appAuthority : appAuthority;
    let sendHeaders = forwardableHeaders(headers);
    const rw = flow.action?.kind === 'rewrite' ? flow.action : undefined;
    if (rw?.request) {
      // CONTRACTS §18.1: request metadata.
      sendHeaders = this.px.hooks.grpcRewriteMeta(call, sendHeaders, rw.request.setHeaders, rw.request.removeHeaders, 'request');
      ex.requestHeaders = recordedHeaders(sendHeaders);
    }
    const upHeaders: http2.OutgoingHttpHeaders = {
      ...sendHeaders, // no marker of ours: real servers see only the app's metadata (CONTRACTS §18.6)
      ':method': req.method,
      ':path': `${target.pathname}${target.search}`,
      ':authority': authority,
      ':scheme': protocol.slice(0, -1),
    };
    let up: http2.ClientHttp2Stream;
    const sentAt = performance.now();
    try {
      up = lease.session.request(upHeaders);
    } catch (e) {
      lease.release();
      const reason = `Could not start the call on the server connection: ${(e as Error).message}`;
      return this.px.grpcLocal.grpcStatusOnly(call, 14, fiText(reason), 'error', reason);
    }
    lease.track(up);
    call.up = up;
    up.on('error', (e: Error & { code?: string }) => {
      call.upError ??= e;
    });

    // app → (record / hooks) → (upload pacing) → server; pipes carry HTTP/2 flow control both ways. Without a
    // breakpoint / mutate hook for a direction its link is the 0.10 observer (no per-message copies).
    const a = flow.action;
    const phase = a?.kind === 'breakpoint' ? a.phase : undefined;
    call.statusPause = phase === 'response' || phase === 'both';
    // CONTRACTS §18.2: a script's gRPC hooks (the hook path only when the code defines them).
    const scriptHooks = a?.kind === 'script' ? mentionsGrpcHooks(a.code) : { message: false, status: false };
    call.scriptStatus = scriptHooks.status;
    const hookSend = phase === 'request' || phase === 'both' || scriptHooks.message;
    const hookReceive = call.statusPause || a?.kind === 'mutate' || scriptHooks.message;
    const sendRec = this.grpcRecording(call, 'send');
    let upSrc: Readable = req.pipe(hookSend ? this.px.hooks.grpcTransform(call, 'send', sendRec) : new Observer((c) => sendRec.parser.push(c)));
    const upload = flow.throttle?.uploadKbps;
    if (upload && upload > 0) upSrc = upSrc.pipe(new PacedStream({ kbps: upload }));
    upSrc.pipe(up);
    req.once('end', () => {
      if (call.isLive()) this.px.book.setRequestMs(ex, flow.te, performance.now());
    });
    req.on('error', () => undefined);

    up.on('response', (h, flags) => {
      if (!call.isLive() || stream.closed || stream.destroyed) return;
      call.headAt = performance.now();
      this.px.book.addTimings(ex.id, { waitMs: elapsed(sentAt, call.headAt) });
      const status = Number(h[':status']) || 0;
      ex.status = status;
      ex.responseHeaders = recordedHeaders(h as HeaderBag);
      const enc = grpcEncodingOf(h['grpc-encoding']);
      if (enc) info.responseEncoding = enc;
      let resHeaders = forwardableHeaders(h as HeaderBag);
      if (rw?.response) {
        resHeaders = this.px.hooks.grpcRewriteMeta(call, resHeaders, rw.response.setHeaders, rw.response.removeHeaders, 'response');
        // A trailers-only answer carries the trailers in this one frame.
        if (flags & C.NGHTTP2_FLAG_END_STREAM) resHeaders = this.px.hooks.grpcRewriteMeta(call, resHeaders, rw.response.setTrailers, rw.response.removeTrailers, 'trailers');
        ex.responseHeaders = recordedHeaders(resHeaders);
      }
      const fwd: http2.OutgoingHttpHeaders = { ':status': status, ...resHeaders };
      if (flags & C.NGHTTP2_FLAG_END_STREAM) {
        // Trailers-only: the status stays in the one HEADERS frame (mockttp's passthrough loses END_STREAM here).
        info.trailersOnly = true;
        const code = parseGrpcStatus(h['grpc-status']);
        if (code !== undefined) info.statusCode = code;
        const msg = decodeGrpcMessage(h['grpc-message']);
        if (msg !== undefined) info.statusMessage = msg;
        const statusHook = call.statusPause || call.scriptStatus;
        if (!statusHook) call.localReset = true; // held: the app may still cancel meanwhile (REVIEW-11 #5)
        this.px.book.addTimings(ex.id, { receiveMs: 0 });
        void (async () => {
          let out = fwd;
          if (statusHook) {
            // CONTRACTS §17.2 / §18.2: a trailers-only answer is held / scripted as the end of the call too.
            const edited = call.statusPause ? await this.px.hooks.grpcStatusBreakpoint(call, resHeaders) : await this.px.hooks.grpcStatusScript(call, resHeaders);
            if (!edited) return;
            out = { ':status': status, ...resHeaders, ...edited.headers };
            for (const k of edited.removed) delete out[k];
            ex.responseHeaders = recordedHeaders(out as HeaderBag);
          }
          if (!call.isLive() || stream.closed || stream.destroyed) return;
          call.localReset = true;
          try {
            stream.respond(out, { endStream: true });
            this.grpcEndRequestSide(call);
          } catch {
            /* the app left */
          }
          if (!call.isLive()) return;
          // Our own relay answered (a name that resolves to this machine): the loop, recorded on this one exchange.
          if (msg === GRPC_LOOP_TEXT) return this.px.book.fail(ex, GRPC_LOOP_TEXT);
          this.px.book.finish(ex, truncate ? 'blocked' : 'completed');
        })();
        return;
      }
      stream.removeAllListeners('wantTrailers'); // the compatibility response's own (ERR_HTTP2_TRAILERS_ALREADY_SENT)
      stream.on('wantTrailers', () => void this.sendGrpcTrailers(call));
      try {
        stream.respond(fwd, { waitForTrailers: true });
      } catch {
        return;
      }
      this.px.book.emitChange(ex);
      const recvRec = this.grpcRecording(call, 'receive');
      const resParser = recvRec.parser;
      if (truncate) {
        const cut = new FirstMessageCut();
        up.on('data', (c: Buffer) => {
          if (cut.done) return;
          const r = cut.push(c);
          resParser.push(r.forward);
          if (!r.cut) {
            if (r.forward.length) stream.write(r.forward);
            return;
          }
          call.localReset = true;
          try {
            up.close(C.NGHTTP2_CANCEL);
          } catch {
            /* gone */
          }
          stream.write(r.forward, () => this.grpcReset(call, C.NGHTTP2_INTERNAL_ERROR));
          if (call.isLive()) this.px.book.finish(ex, 'blocked');
        });
        up.once('end', () => {
          if (!cut.done && !stream.closed) stream.end();
        });
        return;
      }
      let tail: Readable = up.pipe(hookReceive ? this.px.hooks.grpcTransform(call, 'receive', recvRec) : new Observer((c) => resParser.push(c)));
      const kbps = flow.throttle?.kbps;
      if (kbps && kbps > 0) tail = tail.pipe(new PacedStream({ kbps }));
      call.respTail = tail;
      tail.pipe(stream);
    });
    up.on('trailers', (t) => {
      call.upTrailers = t;
      ex.responseTrailers = recordedHeaders(t as HeaderBag);
      const code = parseGrpcStatus(t['grpc-status']);
      if (code !== undefined) info.statusCode = code;
      const msg = decodeGrpcMessage(t['grpc-message']);
      if (msg !== undefined) info.statusMessage = msg;
      if (call.headAt !== undefined) this.px.book.addTimings(ex.id, { receiveMs: elapsed(call.headAt) });
    });
    up.once('close', () => this.onGrpcUpstreamClosed(call));
  }

  /** The app's response body ended: the server's trailers (or a failure status, or none) end it. */
  async sendGrpcTrailers(call: GrpcCall): Promise<void> {
    const { ex, stream } = call;
    const rwr = call.flow.action?.kind === 'rewrite' ? call.flow.action.response : undefined;
    if (call.upTrailers && (rwr?.setTrailers || rwr?.removeTrailers)) {
      // CONTRACTS §18.1: custom trailers.
      const next = this.px.hooks.grpcRewriteMeta(call, forwardableHeaders(call.upTrailers as HeaderBag), rwr.setTrailers, rwr.removeTrailers, 'trailers');
      call.upTrailers = next as http2.IncomingHttpHeaders;
      ex.responseTrailers = recordedHeaders(next);
    }
    if (call.upTrailers && (call.statusPause || call.scriptStatus)) {
      // CONTRACTS §17.2 / §18.2: the end of the call is held / scripted after the last response message.
      const edited = call.statusPause ? await this.px.hooks.grpcStatusBreakpoint(call, call.upTrailers as HeaderBag) : await this.px.hooks.grpcStatusScript(call, call.upTrailers as HeaderBag);
      if (!edited) return;
      const next: Record<string, string | string[]> = { ...forwardableHeaders(call.upTrailers as HeaderBag), ...edited.headers };
      for (const k of edited.removed) delete next[k];
      call.upTrailers = next as http2.IncomingHttpHeaders;
      ex.responseTrailers = recordedHeaders(next);
    }
    const t: http2.OutgoingHttpHeaders = call.upTrailers ? forwardableHeaders(call.upTrailers as HeaderBag) : (call.failTrailers ?? {});
    call.localReset = true;
    try {
      stream.sendTrailers(t);
      this.grpcEndRequestSide(call);
    } catch {
      /* gone */
    }
    if (!call.isLive()) return;
    if (call.upTrailers) return this.px.book.finish(ex, 'completed');
    if (call.failTrailers) {
      ex.responseTrailers = { ...call.failTrailers };
      call.info.statusCode = 14;
      call.info.statusMessage = decodeGrpcMessage(call.failTrailers['grpc-message']);
      return this.px.book.fail(ex, call.failReason ?? 'The connection to the server failed.');
    }
    this.px.book.fail(ex, 'The server ended the response without trailers (no gRPC status).');
  }

  /**
   * CONTRACTS §20.1: a TLS alert from the server of a decrypted gRPC call (TLS 1.2: opening the session; TLS 1.3: on
   * the first stream). A configured certificate that was rejected, or a server that wants the app's own certificate
   * (learned: the app's next silent tunnel to it is passed through; its HTTP/2 connection is closed gracefully, so it
   * opens one). True = the call was answered (UNAVAILABLE with the verdict).
   */
  async grpcRefusal(call: GrpcCall, err: Error & { code?: string }): Promise<boolean> {
    const alert = alertOf(err);
    if (alert === undefined) return false;
    let u: URL;
    try {
      u = new URL(call.flow.map?.url ?? call.req.url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    const v = await this.px.learn.verdict({
      host: normalizeHostname(u.hostname),
      port: Number(u.port) || 443,
      alert,
      socket: requestInternals(call.req).socket,
      grpc: true,
      ...(call.ex.clientCertificate ? { certPattern: call.ex.clientCertificate } : {}),
      ...(call.flow.send || call.flow.map ? { noLearn: true } : {}),
    });
    if (!v || !call.isLive() || call.stream.closed || call.stream.headersSent) return false;
    if (v.learned) call.ex.learnedPassthrough = v.learned;
    this.px.grpcLocal.grpcStatusOnly(call, 14, fiText(v.error), 'error', v.error);
    if (v.learned) {
      try {
        call.stream.session?.close();
      } catch {
        /* gone */
      }
    }
    return true;
  }

  /** The server's stream closed: unless its trailers came, map the failure for the app (UNAVAILABLE or its reset). */
  onGrpcUpstreamClosed(call: GrpcCall): void {
    const { ex, stream, up } = call;
    if (!up || !call.isLive() || call.upTrailers || call.localReset || stream.closed || stream.destroyed) return;
    const err = call.upError;
    const code = up.rstCode;
    const peerReset = !!code && code !== http2.constants.NGHTTP2_NO_ERROR && (!err || err.code === 'ERR_HTTP2_STREAM_ERROR');
    if (!err && !peerReset) return; // ended without trailers: the pipe ends the app's response (sendGrpcTrailers)
    const reason = peerReset ? `the server reset the stream (${h2CodeName(code)})` : `the connection to the server failed (${err?.message ?? 'closed'})`;
    if (!stream.headersSent) {
      const unavailable = () => this.px.grpcLocal.grpcStatusOnly(call, 14, fiText(reason), 'error', `${capitalize(reason)}.`);
      // CONTRACTS §20.1: a TLS alert that ended the connection (TLS 1.3 refuses a missing certificate after the handshake).
      if (!peerReset && alertOf(err) !== undefined) {
        void this.grpcRefusal(call, err!).then((done) => {
          if (!done && call.isLive() && !stream.closed && !stream.headersSent) unavailable();
        });
        return;
      }
      return unavailable();
    }
    if (peerReset) {
      // Mid-response: the same reset for the app (code preserved).
      this.grpcReset(call, code!);
      return this.px.book.fail(ex, `${capitalize(reason)}.`);
    }
    // The server's connection failed mid-response: end the app's response with UNAVAILABLE.
    call.failTrailers = { 'grpc-status': '14', 'grpc-message': encodeGrpcMessage(fiText(reason)) };
    call.failReason = `${capitalize(reason)}.`;
    try {
      call.respTail?.unpipe(stream);
      stream.end();
    } catch {
      this.grpcReset(call, http2.constants.NGHTTP2_INTERNAL_ERROR);
      this.px.book.fail(ex, call.failReason);
    }
  }
}
