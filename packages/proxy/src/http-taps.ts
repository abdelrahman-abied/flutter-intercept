// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import type { OngoingRequest } from 'mockttp';
import { cleanHeaders, decodeForDisplay, getHeader, type HeaderBag } from './body';
import { CORS_RESPONSE_HEADERS, corsResponseHeaders, isCorsRequest } from './cors';
import { frameCost, MAX_FRAME_BYTES_PER_EXCHANGE, sseFrame } from './frames';
import { SseParser, SseRecorder } from './sse';
import { captured, getTap, isComplete, type HeadPatch, type Tap } from './taps';
import { SSRF_MARKER } from './lan';
import type { Shaping } from './shaper';
import type { Body, Exchange, Frame } from './types';
import type { Flow, Live } from './flow-types';
import { isEventStream } from './proxy-util';
import { rewriteSets, validRewriteStatus } from './rewrite-flow';
import { CERT_REFUSAL_MARKER } from './client-certs';
import { normalizeHostname } from './hosts';
import { alertOfTags, NGINX_NO_CERT_TEXT } from './learned';
import type { UpstreamRefusal } from './learn-flow';
import type { ProxyContext } from './proxy-context';

/** Recording a pass-through HTTP exchange from its taps: head, body, SSE, truncation, shaping. */
export class HttpTaps {
  constructor(private readonly px: ProxyContext) {}

  /** Record from the passive taps: request body, response completion (except finished h1/h2 hooks). */
  wireTap(req: OngoingRequest, flow: Flow): void {
    const tap = getTap(req.id);
    if (flow.route === 'plain') this.px.book.track(this.px.book.newExchange(req, flow), flow);
    if (!tap) return;
    this.applyShaping(tap, flow);
    tap.onRequestEnd = () => {
      const live = this.px.book.live.get(req.id);
      if (live) this.px.book.setRequestMs(live.ex, live.flow.te, performance.now());
      if (live && live.ex.state === 'pending' && live.flow.route === 'plain') {
        void this.requestBodyFromTap(tap, live.ex).then((b) => {
          if (!this.px.book.live.has(req.id)) return;
          this.px.book.setRequestBody(live.ex, b);
          this.px.book.emitChange(live.ex);
        });
      }
    };
    tap.onResponseHead = (status, headers) => this.onResponseHead(tap, status, headers);
    tap.onResponseDone = (finished) => void this.onResponseDone(tap, finished);
  }

  /** kbps pacing / the truncate fault, applied by the taps to the response on its way to the app. */
  applyShaping(tap: Tap, flow: Flow): void {
    const kbps = flow.throttle?.kbps;
    if ((kbps && kbps > 0) || flow.fault === 'truncate') {
      const shaping: Shaping = {};
      if (kbps && kbps > 0) shaping.kbps = kbps;
      if (flow.fault === 'truncate') {
        shaping.truncate = true;
        shaping.onTruncated = () => this.onTruncated(tap, flow);
      }
      tap.shaping = shaping;
    }
  }

  /**
   * The response head is about to go to the app (streaming routes; hooked routes are finished by then).
   * A cors rule patches it (CONTRACTS §11.3); an event stream starts SSE recording and is flushed at once.
   */
  onResponseHead(tap: Tap, status: number, headers: Record<string, string | string[]>): HeadPatch | void {
    const live = this.px.book.live.get(tap.id);
    if (!live || live.ex.state !== 'pending') return;
    const { ex, flow } = live;
    let patch: HeadPatch | undefined;
    let shown = headers;
    if (this.watchRefusal(live, tap, status, headers)) patch = { set: { connection: 'close' } };
    if (flow.corsPatch && isCorsRequest(ex.method, ex.url, ex.requestHeaders)) {
      const vary = getHeader(headers, 'vary');
      const set = corsResponseHeaders(ex.requestHeaders, Object.keys(headers), vary, flow.corsPatch);
      if (set) {
        patch = { remove: CORS_RESPONSE_HEADERS, set };
        shown = { ...headers };
        for (const h of CORS_RESPONSE_HEADERS) delete shown[h];
        Object.assign(shown, set);
        ex.cors = { ...ex.cors, patched: true };
      }
    }
    // A rewrite rule's response status / headers on a streaming route (CONTRACTS §12.6; buffered ones: onResponse).
    const rr = flow.rewrite?.response;
    if (rr && !flow.rewrite!.resBody) {
      const sets = rewriteSets(rr, true);
      if (sets.remove.length || sets.set.length) {
        const set: Record<string, string> = {};
        for (const [k, v] of Object.entries(patch?.set ?? {})) if (!sets.remove.includes(k.toLowerCase())) set[k] = v;
        for (const [k, v] of sets.set) set[k] = v;
        patch = { ...patch, remove: [...(patch?.remove ?? []), ...sets.remove], set };
        shown = Object.fromEntries(Object.entries(shown).filter(([k]) => !sets.remove.includes(k.toLowerCase())));
        Object.assign(shown, Object.fromEntries(sets.set.map(([k, v]) => [k.toLowerCase(), v])));
      }
      if (rr.status !== undefined && validRewriteStatus(rr.status)) {
        patch = { ...patch, status: rr.status };
        status = rr.status;
      }
    }
    if (isEventStream(getHeader(shown, 'content-type')) && status >= 200 && status < 300) {
      this.startSse(live, tap, status, shown);
      patch = { ...patch, flush: true };
    }
    return patch;
  }

  /**
   * CONTRACTS §20.1, at the response head: a 502 for a TLS alert from the server starts the verdict (a probe may
   * run meanwhile); an HTTPS 400 page may be nginx's "No required SSL certificate was sent" (read at the end). True =
   * the app's HTTP/1 connection should close after this response (its next request opens a new CONNECT).
   */
  watchRefusal(live: Live, tap: Tap, status: number, headers: Record<string, string | string[]>): boolean {
    const { flow } = live;
    if (status !== 502 && status !== 400) return false;
    const f = this.refusal(live, tap);
    if (!f) return false;
    if (status === 502) {
      f.alert = alertOfTags(tap.response.tags);
      if (f.alert === undefined) return false;
      flow.learn = this.px.learn.verdict(f);
    } else {
      // nginx's page is text/html. The page is read at the end (a configured certificate's rejection is explained too).
      if (!/^\s*text\/html\b/i.test(getHeader(headers, 'content-type') ?? '')) return false;
      f.nginx = true;
      if (f.noLearn && !f.certPattern) return false;
      flow.maybeNginx = true;
      // REVIEW-14 #6: close the app's connection only for a host that may be learned (no configured certificate, no
      // rule naming it, no replay); an API's HTML 400 elsewhere keeps its connection.
      if (this.px.learn.keepDecrypted(f.host, f.port)) return false;
    }
    const h2 = (tap.response as { req?: { httpVersionMajor?: number } }).req?.httpVersionMajor === 2;
    return !h2 && this.px.learn.mayTeach(f);
  }

  /** The upstream server of a decrypted HTTPS exchange, as a refusal to judge (undefined: not one). */
  refusal(live: Live, tap: Tap): UpstreamRefusal | undefined {
    const { ex, flow } = live;
    if (!ex.url.startsWith('https://')) return undefined;
    let host: string;
    let port: number;
    try {
      const u = new URL(ex.url);
      host = normalizeHostname(u.hostname);
      port = Number(u.port) || 443;
    } catch {
      return undefined;
    }
    // REVIEW-14 #1: learn only when the request names the server the connection goes to (the CONNECT target, which the
    // app's next CONNECT is matched on). A CONNECT to an IP whose Host / SNI names another host teaches nothing.
    const sameServer = !!flow.dest && flow.dest.host === host && flow.dest.port === port;
    return {
      host,
      port,
      socket: tap.socket,
      ...(ex.clientCertificate ? { certPattern: ex.clientCertificate } : {}),
      // send / resend and Map Remote aren't the app's own connection to this host: explained, never learned.
      ...(flow.send || flow.map || !sameServer ? { noLearn: true } : {}),
    };
  }

  /** CONTRACTS §20.1: the verdict on a refusal, applied to the failed exchange (true = it was). */
  async applyRefusal(live: Live, tap: Tap): Promise<boolean> {
    const { ex, flow } = live;
    let pending = flow.learn;
    if (!pending && flow.maybeNginx && ex.status === 400 && ex.responseBody?.encoding === 'utf8' && ex.responseBody.text.includes(NGINX_NO_CERT_TEXT)) {
      const f = this.refusal(live, tap);
      if (f) pending = this.px.learn.verdict({ ...f, nginx: true });
    }
    if (!pending) return false;
    const v = await pending;
    if (!v || !this.px.book.live.has(ex.id)) return false;
    if (v.learned) {
      ex.learnedPassthrough = v.learned;
      this.px.learn.closeIdle(v.learned.host, v.learned.port);
      // An HTTP/2 app connection: no new streams on it, the ones running finish (GOAWAY).
      (tap.response as { stream?: { session?: { close(): void } } }).stream?.session?.close();
    }
    this.px.book.fail(ex, v.error);
    return true;
  }

  /** CONTRACTS §11.1: events are parsed from the bytes going to the app; no body copy is kept. */
  startSse(live: Live, tap: Tap, status: number, headers: Record<string, string | string[]>): void {
    const { ex } = live;
    ex.kind = 'sse';
    ex.frames ??= [];
    ex.status = status;
    ex.responseHeaders = cleanHeaders(headers);
    tap.res.skip = true;
    tap.res.chunks = [];
    tap.res.captured = 0;
    const rec = new SseRecorder(
      getHeader(headers, 'content-encoding'),
      (e) => this.px.book.addFrame(ex, sseFrame(e)),
      (message) => {
        if (this.px.book.live.get(ex.id)?.ex !== ex) return;
        this.px.book.addNote(ex, message);
        this.px.book.touch(ex);
      },
    );
    live.stream = { ...live.stream, sse: rec };
    tap.onResponseData = (buf) => rec.push(buf);
    // CONTRACTS §14.4: every event arrives `latencyMs` late (the shaper starts with the first body byte).
    const latency = live.flow.throttle?.latencyMs;
    if (latency && latency > 0) tap.shaping = { ...tap.shaping, latencyMs: latency };
    this.px.book.emitChange(ex);
  }

  /** The truncate fault cut the response: record what the app got, as 'blocked'. */
  onTruncated(tap: Tap, flow: Flow): void {
    const live = this.px.book.live.get(tap.id);
    if (!live) return;
    flow.truncated = true;
    const { ex } = live;
    const headers = tap.response.getHeaders() as HeaderBag;
    ex.status = tap.response.statusCode;
    ex.responseHeaders = cleanHeaders(headers);
    // Taken synchronously (the tap is dropped once the connection closes).
    const reqRaw = captured(tap.req);
    const reqComplete = isComplete(tap.req);
    const resRaw = captured(tap.res);
    void Promise.all([
      ex.requestBody ? Promise.resolve(ex.requestBody) : decodeForDisplay(reqRaw, getHeader(ex.requestHeaders, 'content-encoding'), reqComplete),
      live.stream?.sse ? Promise.resolve(undefined) : decodeForDisplay(resRaw, getHeader(headers, 'content-encoding'), false),
      live.stream?.sse?.end(),
    ]).then(([reqBody, resBody]) => {
      if (!this.px.book.live.has(ex.id)) return;
      this.px.book.setRequestBody(ex, reqBody);
      ex.responseBody = resBody;
      this.px.book.finish(ex, 'blocked');
    });
  }

  requestBodyFromTap(tap: Tap, ex: Exchange): Promise<Body | undefined> {
    return decodeForDisplay(captured(tap.req), getHeader(ex.requestHeaders, 'content-encoding'), isComplete(tap.req));
  }

  /** The response to the app was fully written (or the connection closed first). */
  async onResponseDone(tap: Tap, finished: boolean): Promise<void> {
    const live = this.px.book.live.get(tap.id);
    if (!finished) {
      // Usually the 'abort' event records it. A throttled response may still be trickling out after
      // mockttp considers the request handled, and then no 'abort' comes: record it here.
      if (live && tap.shaping && !live.flow.truncated && live.ex.state === 'pending') {
        this.px.book.fail(live.ex, 'The app closed the connection before the throttled response was complete');
      }
      return;
    }
    if (!live || live.ex.state !== 'pending' || live.flow.truncated) return; // hooks already finished it
    const { ex, flow } = live;
    const res = tap.response;
    const headers = res.getHeaders() as HeaderBag;
    ex.status = res.statusCode;
    if (!live.stream?.sse) ex.responseHeaders = cleanHeaders(headers); // SSE: recorded (maybe CORS-patched) at the head
    const sse = live.stream?.sse;
    const [reqBody, resBody] = await Promise.all([
      ex.requestBody ? Promise.resolve(ex.requestBody) : this.requestBodyFromTap(tap, ex),
      sse ? Promise.resolve(undefined) : decodeForDisplay(captured(tap.res), getHeader(headers, 'content-encoding'), isComplete(tap.res)),
      sse?.end(),
    ]);
    if (!this.px.book.live.has(ex.id)) return; // finished meanwhile (e.g. proxy stopped)
    this.px.book.setRequestBody(ex, reqBody);
    ex.responseBody = resBody;
    if (flow.learn || flow.maybeNginx) {
      if (await this.applyRefusal(live, tap)) return;
      if (!this.px.book.live.has(ex.id)) return; // finished while a probe ran
    }
    const upstreamError = res.tags?.find((t) => t.startsWith('passthrough-error:'));
    const ssrf = res.statusCode === 403 && resBody?.encoding === 'utf8' && resBody.text.includes(SSRF_MARKER);
    const certRefused = res.statusCode === 403 && resBody?.encoding === 'utf8' && resBody.text.includes(CERT_REFUSAL_MARKER);
    if (ssrf) {
      this.px.book.fail(ex, resBody!.text.replace(/^Error: /, ''));
    } else if (certRefused) {
      // REVIEW-8 #1 backstop (requestPlan): refused before any upstream connection.
      ex.error = resBody!.text.replace(/^Error: /, '');
      delete ex.clientCertificate;
      this.px.book.finish(ex, 'blocked');
    } else if (upstreamError || (flow.route === 'h2' && flow.fault !== 'truncate')) {
      // h2 still pending here = beforeResponse never ran: upstream failure or response too large.
      const cause = upstreamError?.slice('passthrough-error:'.length);
      this.px.book.fail(
        ex,
        (resBody?.encoding === 'utf8' && resBody.text) ||
          (cause ? `The connection to the server failed${live.stream?.sse ? ' mid-stream' : ''} (${cause}).` : `Failed with status ${res.statusCode}`),
      );
    } else {
      this.px.book.finish(ex, flow.route === 'replay-stream' ? 'mocked' : 'completed');
    }
  }

  onAbort(id: string, message: string | undefined): void {
    const live = this.px.book.live.get(id);
    if (!live) {
      this.px.book.flows.delete(id);
      return; // finished (incl. our own block/abort resets) or unknown
    }
    const { ex, flow } = live;
    if (flow.truncated) return; // the truncate fault closed it; recorded by onTruncated
    if (ex.kind === 'grpc') return; // the relay records its own end (stream close)
    const hold = this.px.holds.get(id);
    if (hold) return hold(true); // the timeout fault: the app gave up
    this.px.book.flows.delete(id);
    if (ex.kind === 'websocket') {
      // Before the upgrade (after it, the connection's own close events finish the exchange).
      return this.px.book.fail(ex, message || 'No WebSocket connection: the upgrade got no answer (server unreachable, a TLS error, or the app gave up).');
    }
    const sse = live.stream?.sse;
    if (sse) {
      // An event stream usually ends when the app stops listening: that is not an error.
      void sse.end().then(() => {
        if (this.px.book.live.get(id)?.ex !== ex) return;
        if (message && live.flow.route !== 'replay-stream') this.px.book.fail(ex, message);
        else {
          this.px.book.addNote(ex, 'The app closed the event stream.');
          this.px.book.finish(ex, live.flow.route === 'replay-stream' ? 'mocked' : 'completed');
        }
      });
      return;
    }
    const paused = this.px.paused.get(id);
    this.px.book.fail(
      ex,
      paused
        ? `Client closed the connection while ${paused.phase === 'request' ? 'the request' : 'the response'} was paused (client timeout?)`
        : message || 'Connection aborted',
    );
    paused?.settle({ kind: 'gone' });
  }

  /** A complete event-stream body (mock, buffered response) → frames. */
  setSseFrames(ex: Exchange, decoded: Buffer): void {
    ex.kind = 'sse';
    const frames: Frame[] = [];
    let dropped = 0;
    const at = Date.now();
    let bytes = 0;
    const parser = new SseParser((e) => {
      const f = sseFrame(e, at);
      frames.push(f);
      bytes += frameCost(f);
      while (frames.length > this.px.book.maxFrames || (bytes > MAX_FRAME_BYTES_PER_EXCHANGE && frames.length > 1)) {
        bytes -= frameCost(frames.shift()!);
        dropped++;
      }
    });
    parser.pushBytes(decoded);
    parser.end();
    ex.frames = frames;
    if (dropped) ex.framesDropped = dropped;
    this.px.book.frameBytes.set(ex.id, bytes);
  }
}
