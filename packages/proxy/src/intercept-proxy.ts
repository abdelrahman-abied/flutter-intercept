import { EventEmitter } from 'events';
import { STATUS_CODES } from 'http';
import { randomUUID } from 'crypto';
import * as net from 'net';
// Deep imports on purpose: mockttp's index also loads its admin server and remote client
// (express, GraphQL, body-parser, …), ~2 MB of bundle and ~100 ms of module init we never use.
import type * as mockttp from 'mockttp';
import { MockttpServer } from 'mockttp/dist/server/mockttp-server';
import { generateCACertificate } from 'mockttp/dist/util/certificates';
import { CallbackStep, PassThroughStep } from 'mockttp/dist/rules/requests/request-step-definitions';
import { Always } from 'mockttp/dist/rules/completion-checkers';
import type { RequestMatcher } from 'mockttp/dist/rules/matchers';
import type { CompletedBody, CompletedRequest, OngoingRequest, TlsHandshakeFailure } from 'mockttp';

import {
  BODY_CAP_BYTES,
  cleanHeaders,
  decodeForDisplay,
  deleteHeader,
  frameBody,
  getHeader,
  normalizedEncoding,
  type HeaderBag,
} from './body';
import { compileRules, findRule, isInvalidMatcher, type CompiledRule } from './rules';
import { boundAddressMatches, rebindIfNeeded, runWithListenHost } from './listen-host';
import { createUpstreamPool, type UpstreamPool } from './upstream-pool';
import { refreshRoutes } from './routes';
import { captured, getTap, installTaps, isComplete, RESPONSE_PAUSE_LIMIT_BYTES, type Tap } from './taps';
import {
  checkLanRequest,
  LanGate,
  lanGateOf,
  lanIPv4Addresses,
  lanTargetDenial,
  lanTesting,
  onComboConnection,
  refuse,
  RESPONSE_407,
  SSRF_MARKER,
} from './lan';
import type { Body, Exchange, InterceptProxyOptions, RequestEdit, ResponseEdit, Rule } from './types';

type CallbackRequestResult = mockttp.requestSteps.CallbackRequestResult;
type CallbackResponseResult = mockttp.requestSteps.CallbackResponseResult;
type CallbackResponseMessageResult = mockttp.requestSteps.CallbackResponseMessageResult;
type PassThroughResponse = mockttp.requestSteps.PassThroughResponse;

type Decision =
  | { kind: 'resume'; edit?: RequestEdit | ResponseEdit }
  | { kind: 'abort' }
  | { kind: 'gone' }; // client disconnected or proxy stopped; exchange state already set

/**
 * Where a request goes inside mockttp, decided from method + URL + headers only (never the body):
 * - plain: streaming passthrough; recorded passively from the taps (bounded).
 * - h1: beforeRequest only (mock, block, request breakpoint). The response, if forwarded, streams.
 * - h2: beforeRequest + beforeResponse (response / both breakpoints); response buffered ≤ 32 MB.
 */
type Route = 'plain' | 'h1' | 'h2' | 'denied';

interface Flow {
  route: Route;
  rule?: Rule;
  /** Why a matching breakpoint was not applied (shown in Exchange.error on a non-error state). */
  note?: string;
}

interface Live {
  ex: Exchange;
  flow: Flow;
}

interface Paused {
  phase: 'request' | 'response';
  settle: (d: Decision) => void;
}

const DEFAULT_MAX_EXCHANGES = 1000;
const DEFAULT_BREAKPOINT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STORED_BODY_BYTES = 256 * 1024 * 1024;
const BLOCK_BODY = 'Blocked by Flutter Intercept';
const MB = 1024 * 1024;

/** Request bodies a request breakpoint may hold (and that can be edited). Same as the display cap. */
export const REQUEST_PAUSE_LIMIT_BYTES = BODY_CAP_BYTES;

let defaultCaPromise: Promise<{ key: string; cert: string }> | undefined;
function defaultCa(): Promise<{ key: string; cert: string }> {
  defaultCaPromise ??= generateCACertificate({
    subject: { commonName: 'Flutter Intercept CA (in-memory, do not trust)', organizationName: 'Flutter Intercept' },
  }).then((c) => ({ key: c.key, cert: c.cert }));
  return defaultCaPromise;
}

/** Full decode, for edits that must re-encode the original body (bounded by the pause limits). */
async function decodeFull(body: CompletedBody): Promise<Buffer> {
  try {
    return (await body.getDecodedBuffer()) ?? body.buffer;
  } catch {
    return body.buffer;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const bodySize = (e: Exchange) => (e.requestBody?.text.length ?? 0) + (e.responseBody?.text.length ?? 0);

/**
 * HTTP(S) MITM proxy that records every exchange and applies rules (CONTRACTS §3).
 *
 * Events: 'exchange' (Exchange) — full snapshot on every state change;
 *         'removed' (ids: string[]) — exchanges evicted from the ring buffer.
 *
 * Memory: pass-through traffic streams; only the first 5 MB of each body is kept for display
 * (src/taps.ts), and mockttp's own in-flight buffers are capped with `maxBodySize` (5 MB).
 * A request breakpoint holds at most 5 MB of request body (bigger or unknown-length bodies skip
 * the breakpoint, with a note); a response breakpoint holds at most 32 MB (bigger responses fail
 * with a 502 that says why).
 */
export class InterceptProxy extends EventEmitter {
  private readonly host: string;
  private readonly maxExchanges: number;
  private readonly maxStoredBodyBytes: number;
  private readonly breakpointTimeoutMs: number;
  private server?: mockttp.Mockttp;
  private pool?: UpstreamPool;
  private _port = 0;
  private compiled: CompiledRule[] = [];
  /** Ring buffer, insertion order = oldest first. */
  private readonly store = new Map<string, Exchange>();
  private readonly sizes = new Map<string, number>();
  private storedBytes = 0;
  /** In-flight exchanges (survive ring eviction and clear()). */
  private readonly live = new Map<string, Live>();
  private readonly paused = new Map<string, Paused>();
  /** Routing decision per request id, made once by the first matcher that asks. */
  private readonly flows = new Map<string, Flow>();
  /** LAN mode (CONTRACTS §7): token-gated second listener, only while a physical iOS session runs. */
  private lanGate?: LanGate;
  private lanOpening?: Promise<unknown>;
  private lanHooks = false;
  /** LAN plain requests that failed the per-request Proxy-Authorization check (answered 407 by rule, in order). */
  private readonly unauthorized = new WeakSet<object>();
  /** SSRF verdict per LAN request id (from the deny rule's matcher to its step). */
  private readonly lanDenials = new Map<string, string>();

  constructor(private readonly opts: InterceptProxyOptions) {
    super();
    this.host = opts.host ?? '127.0.0.1';
    this.maxExchanges = Math.max(1, Math.floor(opts.maxExchanges ?? DEFAULT_MAX_EXCHANGES));
    this.maxStoredBodyBytes = opts.maxStoredBodyBytes ?? DEFAULT_MAX_STORED_BODY_BYTES;
    this.breakpointTimeoutMs = opts.breakpointTimeoutMs ?? DEFAULT_BREAKPOINT_TIMEOUT_MS;
  }

  /** Actual port after start() (0 before). */
  get port(): number {
    return this._port;
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('InterceptProxy already started');
    const hooks = installTaps();
    if (!hooks.taps || !hooks.responseLimit) {
      // Without them recording / response breakpoints would be unbounded: refuse to run.
      throw new Error('Flutter Intercept: incompatible mockttp version (body capture hooks unavailable)');
    }
    const ca = this.opts.ca ?? (await defaultCa());
    const server: mockttp.Mockttp = new MockttpServer({
      https: { key: ca.key, cert: ca.cert },
      http2: false, // dart:io HttpClient is HTTP/1.1 only
      recordTraffic: false, // we keep our own bounded store
      cors: false,
      suggestChanges: false,
      // Caps mockttp's in-flight body buffers. Safe ONLY because nothing reads a request body
      // before the passthrough starts streaming it (see docs/spikes/proxy.md, "Memory").
      maxBodySize: BODY_CAP_BYTES,
    });
    const pool = createUpstreamPool();
    const connection = {
      proxyConfig: pool.proxyConfig, // marks our rules for the shared upstream pool
      ignoreHostHttpsErrors: this.opts.ignoreUpstreamCertErrors ?? false,
      // Upstream failure (refused, DNS, TLS, reset) → mockttp answers 502 with the error text;
      // the exchange is recorded as 'error'. The app never hangs on a dead upstream.
      simulateConnectionErrors: false,
    };
    const route = (r: Route): RequestMatcher =>
      ({
        type: 'flutter-intercept-route',
        // Synchronous, headers only: never waits for (or reads) the request body.
        matches: (req: OngoingRequest) => this.decide(req).route === r,
        explain: () => `routed to "${r}" by Flutter Intercept`,
        dispose: () => undefined,
        serialize: () => {
          throw new Error('not serializable');
        },
      }) as unknown as RequestMatcher;
    // `Always` matters: without a completion checker mockttp prefers the LAST matching rule once a
    // rule has been used.
    // LAN mode, first rule: refuse LAN requests to this machine's own services (403). Async
    // matcher (DNS); for loopback clients it answers false synchronously.
    const lanDeny = {
      type: 'flutter-intercept-lan-deny',
      matches: (req: OngoingRequest) => {
        if (this.unauthorized.has(req)) return false;
        // Keyed on the socket: a socket some LAN gate accepted is guarded even after closeLan.
        const gate = lanGateOf((req as unknown as { socket?: unknown }).socket);
        if (!gate) return false;
        if (gate.closed) {
          this.lanDenials.set(req.id, `${SSRF_MARKER}: LAN mode is off.`);
          return true;
        }
        return lanTargetDenial(req.url, gate.host).then((reason) => {
          if (reason) this.lanDenials.set(req.id, reason);
          return !!reason;
        });
      },
      explain: () => 'LAN request to a local target (Flutter Intercept)',
      dispose: () => undefined,
      serialize: () => {
        throw new Error('not serializable');
      },
    } as unknown as RequestMatcher;
    const unauthorized = {
      type: 'flutter-intercept-lan-unauthorized',
      matches: (req: OngoingRequest) => this.unauthorized.has(req),
      explain: () => 'LAN request without valid proxy credentials (Flutter Intercept)',
      dispose: () => undefined,
      serialize: () => {
        throw new Error('not serializable');
      },
    } as unknown as RequestMatcher;
    await server.addRequestRules(
      {
        matchers: [unauthorized],
        completionChecker: new Always(),
        steps: [
          new CallbackStep(() => ({
            statusCode: 407,
            statusMessage: 'Proxy Authentication Required',
            headers: { 'proxy-authenticate': 'Basic realm="proxy"', connection: 'close', 'content-length': '0' },
          })),
        ],
      },
      {
        matchers: [lanDeny],
        completionChecker: new Always(),
        steps: [new CallbackStep((req) => this.onLanDenied(req))],
      },
      {
        matchers: [route('h1')],
        completionChecker: new Always(),
        steps: [new PassThroughStep({ ...connection, beforeRequest: (req) => this.onRequest(req) })],
      },
      {
        matchers: [route('h2')],
        completionChecker: new Always(),
        steps: [
          new PassThroughStep({
            ...connection,
            beforeRequest: (req) => this.onRequest(req),
            beforeResponse: (res, req) => this.onResponse(res, req),
          }),
        ],
      },
      {
        matchers: [route('plain')],
        completionChecker: new Always(),
        steps: [new PassThroughStep(connection)],
      },
    );
    await server.forAnyWebSocket().always().thenPassThrough(connection); // kept working, not recorded
    // A 'response' listener makes mockttp consume (and, past maxBodySize, discard) its internal
    // copy of each response; without a consumer that copy would grow without bound. We record
    // from the taps instead, so the listener itself does nothing.
    await server.on('response', () => undefined);
    await server.on('abort', (req) => this.onAbort(req.id, req.error?.message));
    await server.on('tls-client-error', (f) => this.onTlsError(f));

    try {
      await runWithListenHost(this.host, () => server.start(this.opts.port));
      const raw = (server as unknown as { server?: net.Server }).server;
      if (!raw) throw new Error('Flutter Intercept: cannot verify the proxy bind address (mockttp internals changed)');
      await rebindIfNeeded(raw, this.host);
      const addr = raw.address();
      // Fail CLOSED: never run a MITM proxy on a wider interface than asked for.
      if (!boundAddressMatches(addr, this.host)) {
        const got = addr && typeof addr !== 'string' ? addr.address : String(addr);
        throw new Error(`Flutter Intercept: proxy bound to ${got} instead of ${this.host}; refusing to run`);
      }
      // LAN mode hooks (inert until openLan). Per-request Proxy-Authorization check for plain
      // keep-alive LAN connections: mockttp strips the header during preprocessing, so check first.
      const ms = server as unknown as { preprocessRequest?: (req: any, type: string, emitter: unknown) => unknown };
      const preprocess = ms.preprocessRequest;
      if (typeof preprocess === 'function') {
        ms.preprocessRequest = (req, type, emitter) => {
          if (checkLanRequest(req) === false) {
            if (type !== 'request') {
              refuse(req.socket, RESPONSE_407); // websocket upgrade: nothing can follow it anyway
              return null; // mockttp: "preprocessing failed, already handled"
            }
            // Answered 407 + close by the first rule, so earlier pipelined responses stay in order.
            this.unauthorized.add(req);
          }
          return preprocess.call(server, req, type, emitter);
        };
        this.lanHooks = true;
      }
      raw.on('connection', (s: net.Socket) => onComboConnection(s));
      // LAN sockets get their gate's guarded agents — always, whether or not LAN mode is on now.
      pool.setLan({
        agentFor: (connection, protocol) => {
          const gate = lanGateOf(connection);
          if (!gate) return undefined;
          if (gate.closed) {
            throw Object.assign(new Error(`${SSRF_MARKER}: LAN mode is off.`), { statusCode: 403, statusMessage: 'Forbidden' });
          }
          if (protocol === 'https:') return gate.agents.https;
          if (protocol === 'http:' || protocol === undefined) return gate.agents.http;
          return gate.wsAgent(protocol === 'wss:');
        },
      });
    } catch (e) {
      await server.stop().catch(() => undefined);
      pool.destroy();
      throw e;
    }
    this.server = server;
    this.pool = pool;
    this._port = server.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await this.closeLan();
    this.server = undefined;
    const paused = [...this.paused.values()];
    for (const { ex } of [...this.live.values()]) this.fail(ex, 'Proxy stopped');
    for (const p of paused) p.settle({ kind: 'gone' });
    await server.stop();
    this.pool?.destroy();
    this.pool = undefined;
    this.flows.clear();
    this._port = 0;
  }

  /**
   * The peer IP pinned by the first successful LAN authentication for the current token; other IPs
   * are refused (407) even with the right token. Re-pinned only when openLan rotates the token.
   * Event: 'lan-peer' (ip) when it is pinned.
   */
  get lanPeer(): string | undefined {
    return this.lanGate?.peer;
  }

  /** The LAN listener while LAN mode is on (CONTRACTS §7). */
  get lan(): { host: string; port: number } | undefined {
    const a = this.lanGate?.address;
    return a ? { ...a } : undefined;
  }

  /**
   * Also listen on one LAN IPv4 (physical iOS devices), token-gated and SSRF-guarded. The loopback
   * listener is unaffected. Re-opening replaces the previous LAN listener (and its token).
   * Throws, with nothing left listening, if the bound address isn't exactly `host`.
   */
  async openLan(opts: { host: string; token: string; port?: number }): Promise<{ host: string; port: number }> {
    const run = async () => {
      const server = this.server;
      if (!server) throw new Error('Flutter Intercept: start() the proxy before openLan()');
      const { host, token } = opts;
      if (!net.isIPv4(host) || host === '0.0.0.0' || host.startsWith('127.')) {
        throw new Error(`Flutter Intercept: openLan needs a concrete LAN IPv4 address, got "${host}"`);
      }
      if (!lanTesting.allowAnyHost && !lanIPv4Addresses().includes(host)) {
        throw new Error(`Flutter Intercept: ${host} is not an address of this machine's network interfaces`);
      }
      if (typeof token !== 'string' || token.length < 16) throw new Error('Flutter Intercept: LAN token too short');
      if (!this.lanHooks || !this.pool?.active) {
        // Without them per-request auth / the SSRF guard would be missing: fail closed.
        throw new Error('Flutter Intercept: incompatible mockttp version (LAN guards unavailable)');
      }
      await this.closeLan();
      const raw = (server as unknown as { server: net.Server }).server;
      const gate = new LanGate(token, host, {
        handoff: (socket) => raw.emit('connection', socket),
        onBlockedConnect: (target, reason) => this.recordBlocked('CONNECT', `https://${target}/`, reason),
        onPeerPinned: (ip) => this.emit('lan-peer', ip),
      });
      await refreshRoutes(); // the LAN SSRF guard is route-based; load the table before accepting
      const address = await gate.listen(opts.port ?? 0);
      this.lanGate = gate;
      return { ...address };
    };
    const p = (this.lanOpening ?? Promise.resolve()).catch(() => undefined).then(run);
    this.lanOpening = p;
    return p;
  }

  /** Stop listening on the LAN and drop every LAN connection. No-op if LAN mode is off. */
  async closeLan(): Promise<void> {
    const gate = this.lanGate;
    this.lanGate = undefined;
    await gate?.close();
  }

  private onLanDenied(req: CompletedRequest): mockttp.requestSteps.CallbackResponseResult {
    const reason = this.lanDenials.get(req.id) ?? `${SSRF_MARKER}.`;
    this.lanDenials.delete(req.id);
    // A plain-route exchange already exists (its tap records the 403 as 'error'); hooked routes
    // never reached their hooks, so record those here.
    if (!this.live.has(req.id)) {
      this.flows.delete(req.id);
      this.recordBlocked(req.method, req.url, reason);
    }
    return {
      statusCode: 403,
      statusMessage: 'Forbidden',
      headers: { 'content-type': 'text/plain; charset=utf-8', connection: 'close' },
      body: reason,
    };
  }

  private recordBlocked(method: string, url: string, reason: string): void {
    const ex: Exchange = {
      id: `lan-${randomUUID()}`,
      startedAt: Date.now(),
      durationMs: 0,
      method,
      url,
      requestHeaders: {},
      status: 403,
      state: 'error',
      error: reason,
    };
    this.store.set(ex.id, ex);
    this.emitChange(ex);
  }

  /** First enabled matching rule wins. Rules with an invalid /regex/ never match. */
  setRules(rules: Rule[]): void {
    this.compiled = compileRules(rules.map((r) => ({ ...r, match: { ...r.match }, action: { ...r.action } }) as Rule));
  }

  /** Utility for UIs: does this rule's matcher fail to compile? */
  static isInvalidRule(rule: Rule): boolean {
    return isInvalidMatcher(rule.match);
  }

  /** Oldest first. In-flight exchanges are always included. */
  getExchanges(): Exchange[] {
    return [...this.store.values()].map((e) => ({ ...e }));
  }

  /**
   * Drops finished exchanges (no 'removed' event — the host sends 'cleared'). In-flight ones
   * (pending / paused) are kept: the app is still waiting and a paused one must stay resumable,
   * so the host should send a fresh snapshot (getExchanges()) after clearing.
   */
  clear(): void {
    for (const id of [...this.store.keys()]) if (!this.live.has(id)) this.drop(id);
  }

  /**
   * Resume a paused exchange, optionally with an edit (RequestEdit for paused-request,
   * ResponseEdit for paused-response). No-op if the id is not paused (already resumed, timed out,
   * or the client went away). Throws on an invalid edit (bad URL / status, or a body edit of a body
   * that is too large to have been shown in full), leaving it paused.
   */
  resume(id: string, edit?: RequestEdit | ResponseEdit): void {
    const p = this.paused.get(id);
    if (!p) return;
    if (edit) validateEdit(p.phase, edit, this.live.get(id)?.ex);
    p.settle({ kind: 'resume', edit });
  }

  /** Abort a paused exchange: the client's connection is reset, state 'aborted'. No-op if not paused. */
  abort(id: string): void {
    this.paused.get(id)?.settle({ kind: 'abort' });
  }

  override on(event: 'exchange', listener: (e: Exchange) => void): this;
  override on(event: 'removed', listener: (ids: string[]) => void): this;
  override on(event: 'lan-peer', listener: (ip: string) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  // ---------------------------------------------------------------- store

  private emitChange(ex: Exchange): void {
    if (this.store.get(ex.id) === ex) {
      const size = bodySize(ex);
      this.storedBytes += size - (this.sizes.get(ex.id) ?? 0);
      this.sizes.set(ex.id, size);
    }
    this.emit('exchange', { ...ex });
    this.evict();
  }

  private drop(id: string): void {
    this.storedBytes -= this.sizes.get(id) ?? 0;
    this.sizes.delete(id);
    this.store.delete(id);
  }

  /** Evict oldest finished exchanges beyond maxExchanges / maxStoredBodyBytes; never in-flight ones. */
  private evict(): void {
    if (this.store.size <= this.maxExchanges && this.storedBytes <= this.maxStoredBodyBytes) return;
    const removed: string[] = [];
    for (const id of [...this.store.keys()]) {
      if (this.store.size <= this.maxExchanges && this.storedBytes <= this.maxStoredBodyBytes) break;
      if (this.live.has(id)) continue;
      this.drop(id);
      removed.push(id);
    }
    if (removed.length) this.emit('removed', removed);
  }

  private track(ex: Exchange, flow: Flow): void {
    this.live.set(ex.id, { ex, flow });
    this.store.set(ex.id, ex);
    this.emitChange(ex);
  }

  private finish(ex: Exchange, state: Exchange['state']): void {
    ex.state = state;
    ex.durationMs = Date.now() - ex.startedAt;
    delete ex.pausedAt;
    delete ex.pauseDeadline;
    this.live.delete(ex.id);
    this.flows.delete(ex.id);
    this.emitChange(ex);
  }

  private fail(ex: Exchange, error: string): void {
    ex.error = error;
    this.finish(ex, 'error');
  }

  /** Mark ex paused (caller emits) and wait for resume/abort/timeout/client-gone. */
  private pause(ex: Exchange, phase: 'request' | 'response'): Promise<Decision> {
    ex.state = phase === 'request' ? 'paused-request' : 'paused-response';
    ex.pausedAt = Date.now();
    ex.pauseDeadline = ex.pausedAt + this.breakpointTimeoutMs;
    const id = ex.id;
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => settle({ kind: 'resume' }), this.breakpointTimeoutMs);
      timer.unref?.();
      const settle = (d: Decision) => {
        if (this.paused.get(id)?.settle !== settle) return;
        clearTimeout(timer);
        this.paused.delete(id);
        resolve(d);
      };
      this.paused.set(id, { phase, settle });
    });
    return decision.then((d) => {
      delete ex.pausedAt;
      delete ex.pauseDeadline;
      return d;
    });
  }

  // ---------------------------------------------------------------- routing

  /** Called (synchronously) by the route matchers of every rule; decided once per request. */
  private decide(req: OngoingRequest): Flow {
    const known = this.flows.get(req.id);
    if (known) return known;
    if (this.unauthorized.has(req)) return { route: 'denied' }; // never recorded
    const rule = findRule(this.compiled, req.method, req.url);
    let flow: Flow;
    const action = rule?.action;
    if (!rule || !action) {
      flow = { route: 'plain' };
    } else if (action.kind !== 'breakpoint') {
      flow = { route: 'h1', rule };
    } else {
      // A breakpoint must buffer the request body before forwarding it. Only do that when the
      // size is known and small; mockttp would otherwise drop data past maxBodySize.
      const te = getHeader(req.headers, 'transfer-encoding');
      const cl = Number(getHeader(req.headers, 'content-length') ?? 0);
      if (te) {
        flow = { route: 'plain', rule, note: 'Breakpoint skipped: the request body is streamed (unknown length), so it was passed through unedited.' };
      } else if (cl > REQUEST_PAUSE_LIMIT_BYTES) {
        flow = {
          route: 'plain',
          rule,
          note: `Breakpoint skipped: the request body (${(cl / MB).toFixed(1)} MB) is over the ${REQUEST_PAUSE_LIMIT_BYTES / MB} MB pause limit, so it was passed through unedited.`,
        };
      } else {
        flow = { route: action.phase === 'request' ? 'h1' : 'h2', rule };
      }
    }
    this.flows.set(req.id, flow);
    this.wireTap(req, flow);
    return flow;
  }

  /** Record from the passive taps: request body, response completion (except finished h1/h2 hooks). */
  private wireTap(req: OngoingRequest, flow: Flow): void {
    const tap = getTap(req.id);
    if (flow.route === 'plain') {
      const ex: Exchange = {
        id: req.id,
        startedAt: req.timingEvents?.startTime ?? Date.now(),
        method: req.method,
        url: req.url,
        requestHeaders: cleanHeaders(req.headers),
        state: 'pending',
        ...(flow.rule ? { matchedRuleId: flow.rule.id } : {}),
        ...(flow.note ? { error: flow.note } : {}),
      };
      this.track(ex, flow);
    }
    if (!tap) return;
    tap.onRequestEnd = () => {
      const live = this.live.get(req.id);
      if (live && live.ex.state === 'pending' && live.flow.route === 'plain') {
        void this.requestBodyFromTap(tap, live.ex).then((b) => {
          if (!this.live.has(req.id)) return;
          live.ex.requestBody = b;
          this.emitChange(live.ex);
        });
      }
    };
    tap.onResponseDone = (finished) => void this.onResponseDone(tap, finished);
  }

  private requestBodyFromTap(tap: Tap, ex: Exchange): Promise<Body | undefined> {
    return decodeForDisplay(captured(tap.req), getHeader(ex.requestHeaders, 'content-encoding'), isComplete(tap.req));
  }

  /** The response to the app was fully written (or the connection closed first). */
  private async onResponseDone(tap: Tap, finished: boolean): Promise<void> {
    if (!finished) return; // the 'abort' event records it
    const live = this.live.get(tap.id);
    if (!live || live.ex.state !== 'pending') return; // hooks already finished it
    const { ex, flow } = live;
    const res = tap.response;
    const headers = res.getHeaders() as HeaderBag;
    ex.status = res.statusCode;
    ex.responseHeaders = cleanHeaders(headers);
    const [reqBody, resBody] = await Promise.all([
      ex.requestBody ? Promise.resolve(ex.requestBody) : this.requestBodyFromTap(tap, ex),
      decodeForDisplay(captured(tap.res), getHeader(headers, 'content-encoding'), isComplete(tap.res)),
    ]);
    if (!this.live.has(ex.id)) return; // finished meanwhile (e.g. proxy stopped)
    ex.requestBody = reqBody;
    ex.responseBody = resBody;
    const upstreamError = res.tags?.find((t) => t.startsWith('passthrough-error:'));
    const ssrf = res.statusCode === 403 && resBody?.encoding === 'utf8' && resBody.text.includes(SSRF_MARKER);
    if (ssrf) {
      this.fail(ex, resBody!.text.replace(/^Error: /, ''));
    } else if (upstreamError || flow.route === 'h2') {
      // h2 still pending here = beforeResponse never ran: upstream failure or response too large.
      this.fail(ex, (resBody?.encoding === 'utf8' && resBody.text) || upstreamError || `Failed with status ${res.statusCode}`);
    } else {
      this.finish(ex, 'completed');
    }
  }

  private onAbort(id: string, message: string | undefined): void {
    const live = this.live.get(id);
    this.flows.delete(id);
    if (!live) return; // finished (incl. our own block/abort resets) or unknown
    const { ex } = live;
    const paused = this.paused.get(id);
    this.fail(
      ex,
      paused
        ? `Client closed the connection while ${paused.phase === 'request' ? 'the request' : 'the response'} was paused (client timeout?)`
        : message || 'Connection aborted',
    );
    paused?.settle({ kind: 'gone' });
  }

  // ---------------------------------------------------------------- hooked paths (h1 / h2)

  private async onRequest(req: CompletedRequest): Promise<CallbackRequestResult | void> {
    const flow: Flow = this.flows.get(req.id) ?? { route: 'h1', rule: findRule(this.compiled, req.method, req.url) };
    const rule = flow.rule;
    const tap = getTap(req.id);
    const ex: Exchange = {
      id: req.id,
      startedAt: req.timingEvents?.startTime ?? Date.now(),
      method: req.method,
      url: req.url,
      requestHeaders: cleanHeaders(req.headers),
      state: 'pending',
      ...(rule ? { matchedRuleId: rule.id } : {}),
    };
    // For breakpoints the body is complete (≤ 5 MB); for mock/block it may be a capped prefix.
    ex.requestBody = tap
      ? await this.requestBodyFromTap(tap, ex)
      : await decodeForDisplay(req.body.buffer, getHeader(req.headers, 'content-encoding'), true);
    const action = rule?.action;

    if (action?.kind === 'mock') {
      this.track(ex, flow);
      if (action.delayMs && action.delayMs > 0) {
        await sleep(action.delayMs);
        if (ex.state !== 'pending') return { response: 'close' }; // client left during the delay
      }
      const headers: HeaderBag = { ...(action.headers ?? {}) };
      const decoded = Buffer.from(action.body ?? '', 'utf8');
      const rawBody = frameBody(decoded, headers);
      ex.status = action.status;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = await decodeForDisplay(decoded, undefined, true);
      this.finish(ex, 'mocked');
      return {
        response: { statusCode: action.status, statusMessage: STATUS_CODES[action.status], headers, rawBody },
      };
    }

    if (action?.kind === 'block') {
      this.track(ex, flow);
      if (action.mode === 'reset') {
        this.finish(ex, 'blocked');
        return { response: 'reset' };
      }
      const status = action.status ?? 403;
      const headers: HeaderBag = { 'content-type': 'text/plain; charset=utf-8' };
      const decoded = Buffer.from(BLOCK_BODY, 'utf8');
      const rawBody = frameBody(decoded, headers);
      ex.status = status;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = { text: BLOCK_BODY, encoding: 'utf8' };
      this.finish(ex, 'blocked');
      return { response: { statusCode: status, statusMessage: STATUS_CODES[status], headers, rawBody } };
    }

    if (action?.kind === 'breakpoint' && action.phase !== 'response') {
      const decision = this.pause(ex, 'request');
      this.track(ex, flow);
      const d = await decision;
      if (d.kind === 'abort') {
        this.finish(ex, 'aborted');
        return { response: 'reset' };
      }
      if (d.kind === 'gone') return { response: 'close' };
      const result = await this.applyRequestEdit(req, ex, d.edit as RequestEdit | undefined);
      ex.state = 'pending';
      this.emitChange(ex);
      return result;
    }

    this.track(ex, flow);
    return undefined;
  }

  private async onResponse(res: PassThroughResponse, req: CompletedRequest): Promise<CallbackResponseResult | void> {
    const live = this.live.get(res.id ?? req.id);
    if (!live) return undefined;
    const { ex, flow } = live;
    if (ex.state !== 'pending') return 'close'; // client already gone

    ex.status = res.statusCode;
    ex.responseHeaders = cleanHeaders(res.headers);
    // Complete upstream body, ≤ RESPONSE_PAUSE_LIMIT_BYTES (src/taps.ts); display capped at 5 MB.
    ex.responseBody = await decodeForDisplay(res.body.buffer, getHeader(res.headers, 'content-encoding'), true);

    let result: CallbackResponseMessageResult | undefined;
    const action = flow.rule?.action;
    if (action?.kind === 'breakpoint' && action.phase !== 'request') {
      const decision = this.pause(ex, 'response');
      this.emitChange(ex);
      const d = await decision;
      if (d.kind === 'abort') {
        this.finish(ex, 'aborted');
        return 'reset';
      }
      if (d.kind === 'gone') return 'close';
      result = await this.applyResponseEdit(res, ex, d.edit as ResponseEdit | undefined);
    }
    this.finish(ex, 'completed');
    return result;
  }

  private async applyRequestEdit(
    req: CompletedRequest,
    ex: Exchange,
    edit: RequestEdit | undefined,
  ): Promise<CallbackRequestResult | undefined> {
    if (!edit || isEmptyEdit(edit)) return undefined;
    const result: CallbackRequestResult = {};

    if (edit.method) {
      result.method = edit.method.toUpperCase();
      ex.method = result.method;
    }
    if (edit.url) {
      result.url = edit.url;
      ex.url = edit.url;
    }

    const originalHeaders: HeaderBag = { ...req.headers };
    const headers: HeaderBag = edit.headers ? copyHeaders(edit.headers) : { ...originalHeaders };
    // A Host header left over from the original request would pin the old virtual host when the
    // URL changes; drop it unless the user deliberately changed it, so mockttp derives it.
    const originalHost = getHeader(originalHeaders, 'host');
    if (getHeader(headers, 'host') === originalHost) deleteHeader(headers, 'host');

    const encodingChanged =
      normalizedEncoding(getHeader(headers, 'content-encoding')) !==
      normalizedEncoding(getHeader(originalHeaders, 'content-encoding'));

    let decodedBody: Buffer | undefined;
    if (edit.body !== undefined || encodingChanged) {
      // The request body here is complete and ≤ REQUEST_PAUSE_LIMIT_BYTES (see decide()).
      decodedBody = edit.body !== undefined ? Buffer.from(edit.body, 'utf8') : await decodeFull(req.body);
      result.rawBody = frameBody(decodedBody, headers);
    }
    if (edit.headers || decodedBody) result.headers = headers;

    if (result.headers) {
      const recorded: HeaderBag = { ...headers };
      if (!getHeader(recorded, 'host')) recorded.host = new URL(ex.url).host;
      ex.requestHeaders = cleanHeaders(recorded);
    }
    if (decodedBody) ex.requestBody = await decodeForDisplay(decodedBody, undefined, true);
    return result;
  }

  private async applyResponseEdit(
    res: PassThroughResponse,
    ex: Exchange,
    edit: ResponseEdit | undefined,
  ): Promise<CallbackResponseMessageResult | undefined> {
    if (!edit || isEmptyEdit(edit)) return undefined;
    const result: CallbackResponseMessageResult = {};

    if (edit.status !== undefined && edit.status !== res.statusCode) {
      result.statusCode = edit.status;
      result.statusMessage = STATUS_CODES[edit.status] ?? 'Unknown';
      ex.status = edit.status;
    }

    if (edit.body !== undefined || edit.headers) {
      // Re-frame whenever headers are replaced too: an edited header set can't be trusted to
      // still describe the original bytes (content-encoding, content-length, transfer-encoding).
      const headers: HeaderBag = edit.headers ? copyHeaders(edit.headers) : { ...res.headers };
      const sameEncoding =
        normalizedEncoding(getHeader(headers, 'content-encoding')) ===
        normalizedEncoding(getHeader(res.headers, 'content-encoding'));
      if (edit.body === undefined && sameEncoding) {
        // Headers only, same encoding: forward the original wire bytes, just fix the framing.
        result.rawBody = res.body.buffer;
        deleteHeader(headers, 'transfer-encoding');
        deleteHeader(headers, 'content-length');
        headers['content-length'] = String(res.body.buffer.length);
      } else {
        const decodedBody = edit.body !== undefined ? Buffer.from(edit.body, 'utf8') : await decodeFull(res.body);
        result.rawBody = frameBody(decodedBody, headers);
        if (edit.body !== undefined) ex.responseBody = await decodeForDisplay(decodedBody, undefined, true);
      }
      result.headers = headers;
      ex.responseHeaders = cleanHeaders(headers);
    }
    return result;
  }

  private onTlsError(f: TlsHandshakeFailure): void {
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
    this.store.set(ex.id, ex);
    this.emitChange(ex);
  }
}

export { RESPONSE_PAUSE_LIMIT_BYTES };

function copyHeaders(h: Record<string, string | string[]>): HeaderBag {
  const out: HeaderBag = {};
  for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? v.slice() : v;
  return out;
}

function isEmptyEdit(edit: RequestEdit | ResponseEdit): boolean {
  return Object.values(edit).every((v) => v === undefined);
}

function validateEdit(phase: 'request' | 'response', edit: RequestEdit | ResponseEdit, ex: Exchange | undefined): void {
  if (phase === 'request') {
    const e = edit as RequestEdit;
    if (e.url !== undefined) {
      let u: URL;
      try {
        u = new URL(e.url);
      } catch {
        throw new Error(`Invalid URL: ${e.url}`);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Unsupported URL scheme: ${u.protocol}`);
    }
    if (e.method !== undefined && !/^[A-Za-z]+$/.test(e.method)) throw new Error(`Invalid method: ${e.method}`);
    if (e.body !== undefined && ex?.requestBody?.truncated) {
      throw new Error('The request body is larger than 5 MB and was only shown in part; it cannot be edited (method, URL and headers can).');
    }
  } else {
    const e = edit as ResponseEdit;
    if (e.status !== undefined && (!Number.isInteger(e.status) || e.status < 100 || e.status > 999)) {
      throw new Error(`Invalid status: ${e.status}`);
    }
    if (e.body !== undefined && ex?.responseBody?.truncated) {
      throw new Error('The response body is larger than 5 MB and was only shown in part; it cannot be edited (status and headers can).');
    }
  }
}
