import { EventEmitter } from 'events';
import * as http from 'http';
import { STATUS_CODES } from 'http';
import { randomUUID } from 'crypto';
import * as net from 'net';
// Deep imports on purpose: mockttp's index also loads its admin server and remote client
// (express, GraphQL, body-parser, …), ~2 MB of bundle and ~100 ms of module init we never use.
import type * as mockttp from 'mockttp';
import { MockttpServer } from 'mockttp/dist/server/mockttp-server';
import { generateCACertificate } from 'mockttp/dist/util/certificates';
import { CallbackStep, PassThroughStep } from 'mockttp/dist/rules/requests/request-step-definitions';
import { PassThroughWebSocketStep, RejectWebSocketStep } from 'mockttp/dist/rules/websockets/websocket-step-definitions';
import { Always } from 'mockttp/dist/rules/completion-checkers';
import { resetOrDestroy } from 'mockttp/dist/util/socket-util';
import type { RequestMatcher } from 'mockttp/dist/rules/matchers';
import type { CompletedBody, CompletedRequest, OngoingRequest, TlsHandshakeFailure } from 'mockttp';

import {
  BODY_CAP_BYTES,
  cleanHeaders,
  decodeForDisplay,
  deleteHeader,
  frameBody,
  frameBodyAsync,
  getHeader,
  normalizedEncoding,
  type HeaderBag,
} from './body';
import { compileRules, isInvalidMatcher, WEBSOCKET_ACTIONS, type CompiledRule } from './rules';
import { detectGraphql, graphqlOperationNames } from './graphql';
import {
  allowedOrigin,
  CORS_RESPONSE_HEADERS,
  corsResponseHeaders,
  diagnoseCors,
  hasAllowOrigin,
  isCorsRequest,
  preflightMethod,
  preflightResponseHeaders,
  type CorsOptions,
} from './cors';
import {
  closeFrame,
  DEFAULT_MAX_FRAMES,
  frameCost,
  LIVE_FRAME_FLOOR,
  MAX_FRAME_BYTES_PER_EXCHANGE,
  payloadFrame,
  sseFrame,
} from './frames';
import { SseParser, SseRecorder } from './sse';
import { isBrowserInternal } from './browser';
import { installWsLimit, markProxySocket, WS_MAX_MESSAGE_BYTES } from './ws-limit';
import { boundAddressMatches, rebindIfNeeded, runWithListenHost } from './listen-host';
import { createUpstreamPool, type UpstreamPool } from './upstream-pool';
import { refreshRoutes } from './routes';
import { captured, getTap, installTaps, isComplete, RESPONSE_PAUSE_LIMIT_BYTES, type HeadPatch, type Tap } from './taps';
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
import { describeProfile, NO_PROFILE, type NetworkProfile } from './network';
import { mutateBody } from './mutate';
import { isTraceHost, isTraceUrl, parseTraceBody, TraceJoin, TRACE_BODY_MAX, TRACE_HEADER, TRACE_ID_RE, TRACE_PATH } from './trace';
import type { Shaping } from './shaper';
import type {
  Body,
  Exchange,
  FaultKind,
  Frame,
  InterceptProxyOptions,
  MutateOp,
  RequestEdit,
  ResponseEdit,
  Rule,
  SendRequest,
} from './types';

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
 * - plain: streaming passthrough; recorded passively from the taps (bounded). Throttle latency is
 *   applied by the route matcher (before forwarding, nothing read); kbps / truncate by the taps.
 * - h1: beforeRequest only (mock, block, request breakpoint, and the reset / dns / timeout faults).
 *   The response, if forwarded, streams.
 * - h2: beforeRequest + beforeResponse (response / both breakpoints, mutate rules); response buffered ≤ 32 MB.
 * - trace: the trace sink (CONTRACTS §9.2), answered 204 locally, never recorded.
 * - ws-pass / ws-local: WebSocket upgrades (CONTRACTS §11.1), passed through and recorded frame by frame, or
 *   answered locally (block / fault rules, the offline profile).
 */
type Route = 'plain' | 'h1' | 'h2' | 'denied' | 'trace' | 'ws-pass' | 'ws-local';

/** A fault applied to a request: a fault rule, the `offline` profile ('dns'), or a throttle drop ('drop' = reset). */
type FlowFault = FaultKind | 'drop';

interface SendMeta {
  initiator: 'editor' | 'agent';
  resentFrom?: string;
  /** Resolves send() once the exchange is recorded. */
  recorded(id: string): void;
  done: boolean;
}

interface Flow {
  route: Route;
  rule?: Rule;
  /** Why a matching breakpoint / mutate rule was not applied (shown in Exchange.error on a non-error state). */
  note?: string;
  /** `x-fi-id` of the request (CONTRACTS §9.1), stripped from the headers. */
  traceId?: string;
  /** Set for requests made by send(). */
  send?: SendMeta;
  fault?: FlowFault;
  /** Throttle (a throttle rule, or the network profile) for a request that reaches the network. */
  throttle?: { latencyMs?: number; kbps?: number };
  /** Exchange.simulated. */
  simulated?: string;
  /** Plain route with latency: resolves when the request may be forwarded (false = the app left). */
  delay?: Promise<boolean>;
  /** The truncate fault cut the response; the exchange is finished by that path. */
  truncated?: boolean;
  /** The client came through the LAN listener (Exchange.viaLan). */
  viaLan?: boolean;
  /**
   * A rule with `graphqlOperation` needs the request body (CONTRACTS §11.2): routed like a request breakpoint
   * (h1, or h2 when a candidate rule needs the response hook) and the rule is chosen in beforeRequest.
   */
  deferred?: boolean;
  /** A CORS preflight answered locally because a mock / block / cors rule matches the request it asks about. */
  preflight?: boolean;
  /** A cors rule: add CORS headers to the real response (CONTRACTS §11.3). */
  corsPatch?: CorsOptions;
}

/** Recording state of a WebSocket / event stream. */
interface StreamState {
  sse?: SseRecorder;
  /** The 'ws-upgrade' hook attached to the connection (frames are recorded). */
  wsDirect?: boolean;
  /** The server's side closed first: its close code / reason. */
  serverClose?: { code: number; reason: Buffer };
  /** A message over WS_MAX_MESSAGE_BYTES (REVIEW-5 #1): from the server (receive) or the app (send). */
  tooBig?: Frame['dir'];
}

interface MatchOptions {
  /** Count the hit (rules with `times`). */
  count: boolean;
  /** Request headers (for the GraphQL body limits). */
  headers?: HeaderBag;
  /** The decoded request body, when known: GraphQL-scoped rules are decided with it. */
  body?: () => string | undefined;
  /** Treat GraphQL-scoped rules as matching on method + URL alone (preflights). */
  ignoreGraphql?: boolean;
  /** A WebSocket upgrade: only block / fault rules apply, GraphQL-scoped rules never do. */
  ws?: boolean;
}

interface MatchResult {
  rule?: Rule;
  /** A GraphQL-scoped rule needs the body to decide. */
  deferred?: boolean;
  /** …and some candidate from there on needs the response hook (response breakpoint / mutate). */
  needsResponseHook?: boolean;
  /** Why a matching rule was skipped (shown in Exchange.error on a non-error state). */
  note?: string;
}

interface ReqMeta {
  traceId?: string;
  sendNonce?: string;
}

interface Live {
  ex: Exchange;
  flow: Flow;
  stream?: StreamState;
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
/** Marks requests made by send(): `x-fi-send: <nonce>`, stripped like `x-fi-id`. */
const SEND_HEADER = 'x-fi-send';
/** Hop-by-hop / framing / internal headers a send() caller can't set (the proxy derives them). */
const SEND_DROPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'content-length',
  'te',
  'trailer',
  'upgrade',
  TRACE_HEADER,
  SEND_HEADER,
]);
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Node's setTimeout limit; longer rule expiries are re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const TRACE_FLOW: Flow = { route: 'trace' };
const DENIED_FLOW: Flow = { route: 'denied' };

const FAULT_LABELS: Record<FlowFault, string> = {
  reset: 'Fault: connection reset',
  timeout: 'Fault: timeout',
  truncate: 'Fault: truncated response',
  dns: 'Fault: DNS failure',
  drop: 'Dropped',
};

function throttleLabel(t: { latencyMs?: number; kbps?: number; dropRate?: number }): string {
  const label = describeProfile({ kind: 'throttle', ...t });
  return label === describeProfile(NO_PROFILE) ? 'Throttle' : label;
}

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

/** 'exchange' events for frames: at most one per exchange per this many ms (CONTRACTS §11.1). */
const FRAME_EMIT_INTERVAL_MS = 100;

const isEventStream = (contentType: string | undefined) =>
  (contentType ?? '').split(';')[0].trim().toLowerCase() === 'text/event-stream';

/** WebSocket upgrades are recorded (and matched) as ws:// / wss:// URLs. */
const toWsUrl = (url: string) => url.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s.toLowerCase()}://`);

const capitalize = (s: string) => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data ?? ''), 'utf8');
}

/** Minimal shape of the `ws` WebSocket objects mockttp hands over in its 'ws-upgrade' socket event. */
interface WsLike {
  on(event: 'message', l: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'ping' | 'pong', l: (data: Buffer) => void): unknown;
  on(event: 'error', l: (e: Error & { code?: string }) => void): unknown;
  once(event: 'close', l: (code: number, reason: Buffer) => void): unknown;
  close(code?: number, reason?: string): void;
  upstreamWebSocket?: WsLike;
}

const isTooBig = (e: { code?: string } | undefined) => e?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
/**
 * HTTP(S) MITM proxy that records every exchange and applies rules (CONTRACTS §3).
 *
 * Events: 'exchange' (Exchange) — full snapshot on every state change;
 *         'removed' (ids: string[]) — exchanges evicted from the ring buffer.
 *
 * Memory: pass-through traffic streams; only the first 5 MB of each body is kept for display
 * (src/taps.ts), and mockttp's own in-flight buffers are capped with `maxBodySize` (5 MB).
 * A request breakpoint holds at most 5 MB of request body (bigger or unknown-length bodies skip
 * the breakpoint, with a note); a response breakpoint or mutate rule holds at most 32 MB (bigger
 * responses fail with a 502 that says why).
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
  /** Internal headers taken off each request in preprocessing (x-fi-id, x-fi-send). */
  private readonly reqMeta = new WeakMap<object, ReqMeta>();
  /** Request → source (CONTRACTS §9.2). */
  private readonly traceJoin = new TraceJoin();
  private appPackages: string[] = [];
  /** send() requests in flight, by the nonce in their x-fi-send header. */
  private readonly sends = new Map<string, SendMeta>();
  private readonly sendClients = new Set<http.ClientRequest>();
  private sendAgent?: http.Agent;
  /** Rule spending (CONTRACTS §9.2): hits by rule id (rules with `times`), ids whose 'rule-spent' fired. */
  private readonly hits = new Map<string, number>();
  private readonly spentFired = new Set<string>();
  private expiryTimers: NodeJS.Timeout[] = [];
  private profile: NetworkProfile = NO_PROFILE;
  /** Faulted requests held unanswered ('timeout'): settle = the app left (true) or the hold ran out (false). */
  private readonly holds = new Map<string, (appLeft: boolean) => void>();
  private readonly maxFrames: number;
  /** Stored frame payload bytes per exchange (part of the body byte budget). */
  private readonly frameBytes = new Map<string, number>();
  /** Coalesced 'exchange' emits for frames: last emit time and the pending timer, per exchange. */
  private readonly emitState = new Map<string, { last: number; timer?: NodeJS.Timeout }>();
  /** Ids of read-only records added with record() (CONTRACTS §11.4). */
  private readonly records = new Set<string>();
  /** A Flutter Web session is running: tag the browser's own requests (CONTRACTS §11.3). */
  private webSession = false;

  constructor(private readonly opts: InterceptProxyOptions) {
    super();
    this.host = opts.host ?? '127.0.0.1';
    this.maxExchanges = Math.max(1, Math.floor(opts.maxExchanges ?? DEFAULT_MAX_EXCHANGES));
    this.maxStoredBodyBytes = opts.maxStoredBodyBytes ?? DEFAULT_MAX_STORED_BODY_BYTES;
    this.breakpointTimeoutMs = opts.breakpointTimeoutMs ?? DEFAULT_BREAKPOINT_TIMEOUT_MS;
    const mf = opts.maxFramesPerExchange ?? DEFAULT_MAX_FRAMES;
    this.maxFrames = Number.isFinite(mf) ? Math.max(0, Math.floor(mf)) : DEFAULT_MAX_FRAMES;
  }

  /** Actual port after start() (0 before). */
  get port(): number {
    return this._port;
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('InterceptProxy already started');
    const hooks = installTaps();
    if (!hooks.taps || !hooks.responseLimit || !installWsLimit()) {
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
    const pool = createUpstreamPool({ rewriteLocalhost: this.opts.rewriteLocalhost ?? true });
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
        // Headers only: never waits for (or reads) the request body. Synchronous, except that a
        // throttled plain request resolves after its latency (the body waits, unread, meanwhile).
        matches: (req: OngoingRequest) => {
          const flow = this.decide(req);
          if (flow.route !== r) return false;
          return flow.delay ?? true;
        },
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
        if (isTraceUrl(req.url)) return false; // the trace sink: answered locally, nothing is contacted
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
        // Before the LAN deny rule: an authorised LAN client may post traces (nothing is contacted).
        matchers: [route('trace')],
        completionChecker: new Always(),
        steps: [new CallbackStep((req) => this.onTrace(req))],
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
    // WebSocket upgrades (CONTRACTS §11.1): recorded; block / fault rules and the offline profile answer
    // locally, everything else passes through (frames recorded from the connection, see watchWebSocket).
    const wsRoute = (r: Route): RequestMatcher =>
      ({
        type: 'flutter-intercept-ws-route',
        matches: (req: OngoingRequest) => this.decideWs(req).route === r,
        explain: () => `websocket routed to "${r}" by Flutter Intercept`,
        dispose: () => undefined,
        serialize: () => {
          throw new Error('not serializable');
        },
      }) as unknown as RequestMatcher;
    // A ws step whose handler is ours: mockttp builds the step from the definition's own properties
    // (Object.assign onto the impl prototype), so an own `handle` replaces the reject implementation.
    const localWsStep = Object.assign(new RejectWebSocketStep(500), {
      handle: (req: OngoingRequest, socket: net.Socket) => this.onWsLocal(req, socket),
    });
    await (server as unknown as { addWebSocketRules: (...r: unknown[]) => Promise<unknown> }).addWebSocketRules(
      { matchers: [wsRoute('ws-local')], completionChecker: new Always(), steps: [localWsStep] },
      { matchers: [wsRoute('ws-pass')], completionChecker: new Always(), steps: [new PassThroughWebSocketStep(connection)] },
    );
    // A 'response' listener makes mockttp consume (and, past maxBodySize, discard) its internal
    // copy of each response; without a consumer that copy would grow without bound. We record
    // from the taps instead; the listener only handles refused WebSocket upgrades.
    await server.on('response', (res) => this.onWsRefused(res));
    await server.on('websocket-accepted', (res) => this.onWsAccepted(res));
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
      // The same hook takes the internal headers (x-fi-id, x-fi-send) off every request, before any
      // rule, recording or upstream sees them.
      const ms = server as unknown as { preprocessRequest?: (req: any, type: string, emitter: unknown) => unknown };
      const preprocess = ms.preprocessRequest;
      if (typeof preprocess !== 'function') {
        // Without it x-fi-id would reach real servers: fail closed.
        throw new Error('Flutter Intercept: incompatible mockttp version (request preprocessing hook unavailable)');
      }
      ms.preprocessRequest = (req, type, emitter) => {
        if (checkLanRequest(req) === false) {
          if (type !== 'request') {
            refuse(req.socket, RESPONSE_407); // websocket upgrade: nothing can follow it anyway
            return null; // mockttp: "preprocessing failed, already handled"
          }
          // Answered 407 + close by the first rule, so earlier pipelined responses stay in order.
          this.unauthorized.add(req);
        }
        const out = preprocess.call(server, req, type, emitter);
        if (out) this.takeInternalHeaders(out as OngoingRequest);
        return out;
      };
      this.lanHooks = true;
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
    this.sendAgent = new http.Agent({ keepAlive: true });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await this.closeLan();
    this.server = undefined;
    const paused = [...this.paused.values()];
    for (const { ex } of [...this.live.values()]) this.fail(ex, 'Proxy stopped');
    for (const p of paused) p.settle({ kind: 'gone' });
    for (const settle of [...this.holds.values()]) settle(false);
    for (const c of this.sendClients) c.destroy();
    this.sendClients.clear();
    await server.stop();
    this.pool?.destroy();
    this.pool = undefined;
    this.sendAgent?.destroy();
    this.sendAgent = undefined;
    this.flows.clear();
    this.clearExpiryTimers();
    this.traceJoin.clear();
    for (const st of this.emitState.values()) clearTimeout(st.timer);
    this.emitState.clear();
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
      viaLan: true, // only LAN clients are ever refused this way
    };
    this.store.set(ex.id, ex);
    this.emitChange(ex);
  }

  /**
   * First enabled matching rule wins. Rules with an invalid /regex/ never match. Spending (CONTRACTS
   * §9.2): hit counts are keyed by rule id and survive setRules (dropped when the id disappears); a rule
   * whose `times` is used up or whose `expiresAt` passed no longer matches, and 'rule-spent' fires once
   * (again only if an update revives it and it is spent anew).
   */
  setRules(rules: Rule[]): void {
    // `used` is the host's display copy of our count: ignored, hit counts stay ours (keyed by id).
    this.compiled = compileRules(
      rules.map(({ used: _used, ...r }) => ({ ...r, match: { ...r.match }, action: { ...r.action } }) as Rule),
    );
    const ids = new Set(rules.map((r) => r.id));
    for (const id of [...this.hits.keys()]) if (!ids.has(id)) this.hits.delete(id);
    for (const id of [...this.spentFired]) if (!ids.has(id)) this.spentFired.delete(id);
    const now = Date.now();
    for (const { rule } of this.compiled) {
      const reason = this.spentReason(rule, now);
      if (!reason) this.spentFired.delete(rule.id); // revived (times raised, expiry moved): may fire again
      else this.markSpent(rule.id, reason); // e.g. times lowered below the hits, or already expired
    }
    this.armExpiryTimers();
  }

  /**
   * CONTRACTS §11.3: while a web session runs, requests the browser makes for itself (`Sec-Fetch-Site: none`,
   * or neither Origin nor Referer to a Google browser-service host — src/browser.ts) are recorded with
   * `browserInternal: true`. Never a request with `Origin`. Applies to requests that arrive from now on.
   */
  setWebSessionActive(active: boolean): void {
    this.webSession = !!active;
  }

  /** App package names (pubspec `name`s) whose frames are the preferred `Exchange.source.appFrame`. */
  setAppPackages(names: string[]): void {
    this.appPackages = [...new Set((names ?? []).filter((n) => typeof n === 'string' && /^[A-Za-z0-9_]+$/.test(n)))];
  }

  /**
   * Global network profile (CONTRACTS §9.2): applies to everything that would reach the network
   * (pass-through, breakpoints, throttle rules, send); mock / block / fault rules still answer as
   * configured; the trace sink is never affected. Takes effect for requests that arrive from now on.
   */
  setNetworkProfile(p: NetworkProfile): void {
    this.profile = validateProfile(p);
  }

  get networkProfile(): NetworkProfile {
    return { ...this.profile };
  }

  /**
   * Send a request as if the app had (CONTRACTS §9.2): through the proxy's own loopback listener, so
   * rules and the network profile apply and it is recorded with `initiator` / `resentFrom`. Upstream
   * TLS stays strict. Resolves with the exchange id once it is recorded (before it completes); rejects
   * on an invalid method / URL / header, or if the request never reached the proxy.
   * `body` is decoded text, encoded per the given content-encoding like an edit; host, framing and
   * hop-by-hop headers are derived, not taken from `headers`.
   */
  async send(r: SendRequest): Promise<{ id: string }> {
    const agent = this.sendAgent;
    if (!this.server || !agent) throw new Error('Flutter Intercept: the proxy is not running');
    const method = String(r?.method ?? '').trim().toUpperCase();
    if (!HTTP_TOKEN.test(method) || method === 'CONNECT') throw new Error(`Invalid method: ${r?.method}`);
    let u: URL;
    try {
      u = new URL(String(r.url));
    } catch {
      throw new Error(`Invalid URL: ${r.url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Unsupported URL scheme: ${u.protocol}`);
    if (!u.hostname) throw new Error(`Invalid URL: ${r.url}`);
    if (u.username || u.password) throw new Error('Credentials in the URL are not supported; send an Authorization header');
    if (isTraceHost(u.hostname)) throw new Error(`Invalid URL: ${u.hostname} is internal to Flutter Intercept`);
    if (r.initiator !== 'editor' && r.initiator !== 'agent') throw new Error(`Invalid initiator: ${r.initiator}`);
    if (r.resentFrom !== undefined && typeof r.resentFrom !== 'string') throw new Error('Invalid resentFrom');

    const headers: HeaderBag = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) {
      if (!HTTP_TOKEN.test(k)) throw new Error(`Invalid header name: ${k}`);
      const values = Array.isArray(v) ? v : [v];
      for (const x of values) {
        if (typeof x !== 'string' || /[\r\n\0]/.test(x)) throw new Error(`Invalid value for header ${k}`);
      }
      if (SEND_DROPPED_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.slice() : v;
    }
    headers.host = u.host;
    const body = r.body !== undefined ? frameBody(Buffer.from(String(r.body), 'utf8'), headers) : undefined;
    const nonce = randomUUID();
    headers[SEND_HEADER] = nonce;
    const target = `${u.protocol}//${u.host}${u.pathname}${u.search}`;
    const host = this.host === '0.0.0.0' || this.host === '' ? '127.0.0.1' : this.host === '::' ? '::1' : this.host;

    return new Promise<{ id: string }>((resolve, reject) => {
      const meta: SendMeta = {
        initiator: r.initiator,
        ...(r.resentFrom !== undefined ? { resentFrom: r.resentFrom } : {}),
        done: false,
        recorded: (id) => {
          meta.done = true;
          this.sends.delete(nonce);
          resolve({ id });
        },
      };
      const failed = (why: string) => {
        if (meta.done) return;
        meta.done = true;
        this.sends.delete(nonce);
        reject(new Error(`Flutter Intercept: send failed (${why})`));
      };
      this.sends.set(nonce, meta);
      // Absolute-form request on a plain connection, also for https:// (mockttp forwards it over TLS).
      const req = http.request({ host, port: this._port, method, path: target, headers, agent, setHost: false });
      this.sendClients.add(req);
      const done = () => this.sendClients.delete(req);
      req.on('error', (e) => {
        done();
        failed(e.message);
      });
      req.on('response', (res) => {
        res.resume(); // the caller reads the recorded exchange, not this response
        res.on('close', () => {
          done();
          failed(`the request was not recorded (status ${res.statusCode})`);
        });
      });
      req.end(body);
    });
  }

  /** Utility for UIs: does this rule's matcher fail to compile? */
  static isInvalidRule(rule: Rule): boolean {
    return isInvalidMatcher(rule.match);
  }

  /** Oldest first. In-flight exchanges are always included. */
  getExchanges(): Exchange[] {
    return [...this.store.values()].map(snapshot);
  }

  /**
   * Store a read-only exchange that did not go through the proxy (CONTRACTS §11.4): e.g. a native client's
   * request read from the app's HTTP profile. `captured` defaults to 'vm-profile'. It is stored and evicted
   * like any other exchange and emits 'exchange', but is never routed, never matched against rules, never
   * CORS-diagnosed. Bodies are capped like recorded ones (5 MB of text), frames at maxFramesPerExchange.
   * Returns its id. Throws on a missing method / URL.
   */
  record(input: Omit<Exchange, 'id'>): string {
    if (!input || typeof input !== 'object') throw new Error('Invalid exchange');
    if (typeof input.method !== 'string' || !input.method || typeof input.url !== 'string' || !input.url) {
      throw new Error('Invalid exchange: method and url are required');
    }
    const id = `rec-${randomUUID()}`;
    const ex = {
      startedAt: Date.now(),
      requestHeaders: {},
      state: 'completed',
      ...sanitizeRecord(input as Partial<Exchange>, this.maxFrames),
      id,
    } as Exchange;
    ex.captured ??= 'vm-profile';
    this.records.add(id);
    this.store.set(id, ex);
    if (ex.frames) this.frameBytes.set(id, ex.frames.reduce((n, f) => n + frameCost(f), 0));
    this.emitChange(ex);
    return id;
  }

  /**
   * Change a record() exchange (a pending native request that completed, more frames…): fields in `patch`
   * replace the stored ones, `undefined` removes one; `id` can't change. Emits 'exchange'. Returns false (and
   * does nothing) for an id that is not a record or was evicted / cleared.
   */
  update(id: string, patch: Partial<Omit<Exchange, 'id'>>): boolean {
    const ex = this.records.has(id) ? this.store.get(id) : undefined;
    if (!ex) {
      this.records.delete(id);
      return false;
    }
    if (!patch || typeof patch !== 'object') return false;
    const clean = sanitizeRecord(patch as Partial<Exchange>, this.maxFrames);
    for (const k of Object.keys(patch)) {
      if (k === 'id') continue;
      const v = (clean as Record<string, unknown>)[k];
      if (v === undefined) delete (ex as unknown as Record<string, unknown>)[k];
      else (ex as unknown as Record<string, unknown>)[k] = v;
    }
    ex.captured ??= 'vm-profile';
    if ('frames' in patch) this.frameBytes.set(id, (ex.frames ?? []).reduce((n, f) => n + frameCost(f), 0));
    this.emitChange(ex);
    return true;
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
  override on(event: 'rule-spent', listener: (ruleId: string, reason: 'times' | 'expired') => void): this;
  override on(event: 'rule-hit', listener: (ruleId: string, used: number) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  // ---------------------------------------------------------------- store

  private emitChange(ex: Exchange): void {
    if (!ex.captured) {
      // CONTRACTS §11.3: browser requests (Origin) get a CORS diagnosis; `patched` is kept.
      const cors = diagnoseCors(ex);
      if (cors) ex.cors = cors;
      else delete ex.cors;
    }
    if (this.store.get(ex.id) === ex) {
      const size = bodySize(ex) + (this.frameBytes.get(ex.id) ?? 0);
      this.storedBytes += size - (this.sizes.get(ex.id) ?? 0);
      this.sizes.set(ex.id, size);
    }
    const st = this.emitState.get(ex.id);
    if (st) {
      clearTimeout(st.timer);
      st.timer = undefined;
      st.last = Date.now();
    }
    this.emit('exchange', snapshot(ex));
    this.evict();
  }

  /** Coalesced emit for frame updates: at most one 'exchange' per exchange per FRAME_EMIT_INTERVAL_MS. */
  private touch(ex: Exchange): void {
    let st = this.emitState.get(ex.id);
    if (!st) {
      st = { last: 0 };
      this.emitState.set(ex.id, st);
    }
    if (st.timer) return;
    const wait = st.last + FRAME_EMIT_INTERVAL_MS - Date.now();
    if (wait <= 0) return this.emitChange(ex);
    const state = st;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.store.get(ex.id) === ex || this.live.get(ex.id)?.ex === ex) this.emitChange(ex);
    }, wait);
    state.timer.unref?.();
  }

  /** Append a frame (WebSocket message / SSE event), keeping the newest maxFrames. */
  private addFrame(ex: Exchange, f: Frame): void {
    if (this.live.get(ex.id)?.ex !== ex) return; // finished: late frames are ignored
    const frames = (ex.frames ??= []);
    frames.push(f);
    let bytes = (this.frameBytes.get(ex.id) ?? 0) + frameCost(f);
    // Newest maxFrames, and at most MAX_FRAME_BYTES_PER_EXCHANGE of them (REVIEW-5 #4); always the newest one.
    while (frames.length > this.maxFrames || (bytes > MAX_FRAME_BYTES_PER_EXCHANGE && frames.length > 1)) {
      bytes -= frameCost(frames.shift()!);
      ex.framesDropped = (ex.framesDropped ?? 0) + 1;
    }
    this.frameBytes.set(ex.id, bytes);
    this.touch(ex);
  }

  /**
   * Over the store's byte budget: drop the oldest frames of open streams first (down to LIVE_FRAME_FLOOR each),
   * so heavy live WebSockets / SSE streams can't push every finished exchange out (REVIEW-5 #4).
   */
  private trimLiveFrames(): void {
    for (const { ex } of this.live.values()) {
      if (this.storedBytes <= this.maxStoredBodyBytes) return;
      const frames = ex.frames;
      if (!frames || frames.length <= LIVE_FRAME_FLOOR) continue;
      let freed = 0;
      let dropped = 0;
      while (frames.length > LIVE_FRAME_FLOOR && this.storedBytes - freed > this.maxStoredBodyBytes) {
        freed += frameCost(frames.shift()!);
        dropped++;
      }
      if (!dropped) continue;
      ex.framesDropped = (ex.framesDropped ?? 0) + dropped;
      this.frameBytes.set(ex.id, (this.frameBytes.get(ex.id) ?? 0) - freed);
      if (this.sizes.has(ex.id)) {
        this.sizes.set(ex.id, this.sizes.get(ex.id)! - freed);
        this.storedBytes -= freed;
      }
      // Not synchronously: evict() runs inside emitChange.
      queueMicrotask(() => {
        if (this.live.get(ex.id)?.ex === ex) this.touch(ex);
      });
    }
  }

  private drop(id: string): void {
    this.storedBytes -= this.sizes.get(id) ?? 0;
    this.sizes.delete(id);
    this.store.delete(id);
    this.frameBytes.delete(id);
    this.records.delete(id);
    const st = this.emitState.get(id);
    if (st) {
      clearTimeout(st.timer);
      this.emitState.delete(id);
    }
  }

  /** Evict oldest finished exchanges beyond maxExchanges / maxStoredBodyBytes; never in-flight ones. */
  private evict(): void {
    if (this.store.size <= this.maxExchanges && this.storedBytes <= this.maxStoredBodyBytes) return;
    if (this.storedBytes > this.maxStoredBodyBytes) this.trimLiveFrames();
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
    if (flow.traceId && !ex.source) {
      const info = this.traceJoin.exchange(flow.traceId, ex.id, this.appPackages);
      if (info) ex.source = info;
    }
    this.emitChange(ex);
    if (flow.send && !flow.send.done) flow.send.recorded(ex.id);
  }

  /** A new exchange for a request, with what the flow knows (rule, simulation, initiator). */
  private newExchange(req: { id: string; method: string; url: string; headers: HeaderBag; timingEvents?: { startTime?: number } }, flow: Flow): Exchange {
    return {
      id: req.id,
      startedAt: req.timingEvents?.startTime ?? Date.now(),
      method: req.method,
      url: req.url,
      requestHeaders: cleanHeaders(req.headers),
      state: 'pending',
      ...(flow.rule ? { matchedRuleId: flow.rule.id } : {}),
      ...(flow.note ? { error: flow.note } : {}),
      ...(flow.simulated ? { simulated: flow.simulated } : {}),
      ...(flow.send ? { initiator: flow.send.initiator } : {}),
      ...(flow.send?.resentFrom !== undefined ? { resentFrom: flow.send.resentFrom } : {}),
      ...(flow.viaLan ? { viaLan: true as const } : {}),
      ...graphqlOf(req.method, req.url, req.headers),
      ...(this.webSession && !flow.send && !flow.viaLan && !flow.traceId && isBrowserInternal(req.url, req.headers)
        ? { browserInternal: true as const }
        : {}),
    };
  }

  /** Set the request body (and, once it is known, `graphql`: CONTRACTS §11.2). */
  private setRequestBody(ex: Exchange, body: Body | undefined): void {
    ex.requestBody = body;
    const g = graphqlOf(ex.method, ex.url, ex.requestHeaders, body);
    if (g.graphql) ex.graphql = g.graphql;
    else delete ex.graphql;
  }

  // ---------------------------------------------------------------- request → source

  /** Preprocessing: take x-fi-id / x-fi-send off the request (headers and raw headers) and remember them. */
  private takeInternalHeaders(req: OngoingRequest): void {
    const raw = (req as unknown as { rawHeaders?: unknown }).rawHeaders;
    if (!Array.isArray(raw)) return;
    let traceId: string | undefined;
    let sendNonce: string | undefined;
    const kept = (raw as Array<[string, string]>).filter((pair) => {
      const name = String(pair?.[0] ?? '').toLowerCase();
      if (name === TRACE_HEADER) {
        traceId ??= String(pair[1]).trim();
        return false;
      }
      if (name === SEND_HEADER) {
        sendNonce ??= String(pair[1]).trim();
        return false;
      }
      return true;
    });
    if (kept.length === raw.length) return;
    (req as unknown as { rawHeaders: Array<[string, string]> }).rawHeaders = kept;
    deleteHeader(req.headers as HeaderBag, TRACE_HEADER);
    deleteHeader(req.headers as HeaderBag, SEND_HEADER);
    const meta: ReqMeta = {};
    if (traceId && TRACE_ID_RE.test(traceId)) meta.traceId = traceId;
    if (sendNonce) meta.sendNonce = sendNonce;
    this.reqMeta.set(req, meta);
  }

  /** The trace sink: 204 for anything sent to the trace host; POST /v1/traces bodies are joined. */
  private onTrace(req: CompletedRequest): mockttp.requestSteps.CallbackResponseResult {
    try {
      const path = new URL(req.url).pathname;
      const buf = req.body.buffer;
      // Content-encoded bodies are ignored: the entry never compresses, and it would be a bomb vector.
      if (req.method === 'POST' && path === TRACE_PATH && !getHeader(req.headers, 'content-encoding') && buf.length <= TRACE_BODY_MAX) {
        for (const t of parseTraceBody(buf)) {
          const { info, exchangeIds } = this.traceJoin.trace(t.id, t.stack, this.appPackages);
          for (const id of exchangeIds) {
            const ex = this.store.get(id);
            if (info && ex && !ex.source) {
              ex.source = info;
              this.emitChange(ex);
            }
          }
        }
      }
    } catch {
      /* bad input is ignored; the app always gets its 204 */
    }
    return { statusCode: 204, statusMessage: 'No Content' };
  }

  // ---------------------------------------------------------------- rule spending

  private spentReason(rule: Rule, now: number): 'times' | 'expired' | undefined {
    if (rule.times !== undefined && (this.hits.get(rule.id) ?? 0) >= rule.times) return 'times';
    if (rule.expiresAt !== undefined && now >= rule.expiresAt) return 'expired';
    return undefined;
  }

  private markSpent(id: string, reason: 'times' | 'expired'): void {
    if (this.spentFired.has(id)) return;
    this.spentFired.add(id);
    // Deferred: a listener that calls setRules must not re-enter rule matching.
    process.nextTick(() => this.emit('rule-spent', id, reason));
  }

  /**
   * First enabled, unspent, matching rule. `count`: this request uses it (decided once per request).
   * GraphQL-scoped rules (CONTRACTS §11.2) are decided from the URL for GET / body-less requests and from
   * `o.body` when given; otherwise the decision is deferred to beforeRequest (`deferred`), unless the body is
   * streamed or over the pause limit (then the rule is skipped with a note).
   */
  private matchRule(method: string, url: string, o: MatchOptions): MatchResult {
    const now = Date.now();
    let note: string | undefined;
    let names: string[] | undefined;
    for (let i = 0; i < this.compiled.length; i++) {
      const { rule, base, graphqlOperation: op } = this.compiled[i];
      if (!rule.enabled || this.spentReason(rule, now) || !base(method, url)) continue;
      if (op !== undefined && !o.ignoreGraphql) {
        if (o.ws) continue; // the operation of a subscription is inside the frames
        if (o.body) {
          names ??= graphqlOperationNames(method, url, o.body());
        } else if (!o.headers || !hasRequestBody(o.headers)) {
          names ??= graphqlOperationNames(method, url);
        } else {
          const why = bodyLimitReason(o.headers);
          if (why) {
            note ??= `GraphQL rule skipped: ${why}, so the operation name could not be read and the request was not matched against it.`;
            continue;
          }
          return { deferred: true, needsResponseHook: this.responseHookFrom(i, method, url, now), note };
        }
        if (!names.includes(op)) continue;
      }
      if (o.ws) {
        const a = rule.action;
        if (!WEBSOCKET_ACTIONS.has(a.kind) || (a.kind === 'fault' && a.fault === 'truncate')) {
          const what = a.kind === 'fault' ? 'The truncate fault' : `${capitalize(a.kind)} rule`;
          note ??= `${what}${rule.name ? ` "${rule.name}"` : ''} does not apply to WebSocket connections; passed through.`;
          continue;
        }
      }
      if (o.count && rule.times !== undefined) {
        const n = (this.hits.get(rule.id) ?? 0) + 1;
        this.hits.set(rule.id, n);
        const id = rule.id;
        process.nextTick(() => this.emit('rule-hit', id, n)); // host shows "N of M left" (Rule.used)
        if (n >= rule.times) this.markSpent(rule.id, 'times');
      }
      return { rule, note };
    }
    return { note };
  }

  /** Could a rule from index `from` on (method + URL match) need the response hook? */
  private responseHookFrom(from: number, method: string, url: string, now: number): boolean {
    for (let i = from; i < this.compiled.length; i++) {
      const { rule, base } = this.compiled[i];
      if (!rule.enabled || this.spentReason(rule, now) || !base(method, url)) continue;
      const a = rule.action;
      if (a.kind === 'mutate' || (a.kind === 'breakpoint' && a.phase !== 'request')) return true;
    }
    return false;
  }

  private clearExpiryTimers(): void {
    for (const t of this.expiryTimers) clearTimeout(t);
    this.expiryTimers = [];
  }

  /** 'rule-spent' for expiry fires on time even without traffic. */
  private armExpiryTimers(): void {
    this.clearExpiryTimers();
    const now = Date.now();
    for (const { rule } of this.compiled) {
      if (rule.expiresAt === undefined || this.spentFired.has(rule.id)) continue;
      const { id, expiresAt } = rule;
      const t = setTimeout(() => {
        const current = this.compiled.find((c) => c.rule.id === id)?.rule;
        if (!current || current.expiresAt !== expiresAt) return; // replaced meanwhile
        if (Date.now() >= expiresAt) this.markSpent(id, 'expired');
        else this.armExpiryTimers(); // beyond the timer range: re-arm
      }, Math.min(Math.max(0, expiresAt - now), MAX_TIMER_MS));
      t.unref?.();
      this.expiryTimers.push(t);
    }
  }

  private finish(ex: Exchange, state: Exchange['state']): void {
    ex.state = state;
    ex.durationMs = Date.now() - ex.startedAt;
    delete ex.pausedAt;
    delete ex.pauseDeadline;
    this.live.delete(ex.id);
    this.flows.delete(ex.id);
    this.emitChange(ex);
    this.emitState.delete(ex.id); // emitChange cleared its timer
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
    if (this.unauthorized.has(req)) return DENIED_FLOW; // never recorded
    if (isTraceUrl(req.url)) return TRACE_FLOW; // answered locally, never recorded, never throttled
    const meta = this.reqMeta.get(req);
    const send = meta?.sendNonce ? this.sends.get(meta.sendNonce) : undefined;
    const headers = req.headers as HeaderBag;
    let flow: Flow | undefined;
    // CONTRACTS §11.3: a CORS preflight for a request a mock / block / cors rule would handle is answered
    // here (the rule isn't spent by it). Otherwise the OPTIONS request is matched like any other.
    const asked = preflightMethod(req.method, headers);
    if (asked) {
      const pre = this.matchRule(asked, req.url, { count: false, ignoreGraphql: true }).rule;
      const a = pre?.action;
      if (pre && a && (a.kind === 'mock' || a.kind === 'block' || a.kind === 'cors')) {
        const o = a.kind === 'cors' ? corsOptions(a) : {};
        // Only for an origin the proxy may allow (loopback, or the cors rule's allowOrigin): otherwise the
        // server answers its own preflight (REVIEW-5 #3).
        if (allowedOrigin(headers, o)) flow = { route: 'h1', rule: pre, preflight: true, ...(a.kind === 'cors' ? { corsPatch: o } : {}) };
      }
    }
    if (!flow) {
      const m = this.matchRule(req.method, req.url, { count: true, headers });
      flow = m.deferred
        ? { route: m.needsResponseHook ? 'h2' : 'h1', deferred: true, ...(m.note ? { note: m.note } : {}) }
        : this.flowFor(headers, m.rule, m.note);
    }
    if (meta?.traceId) flow.traceId = meta.traceId;
    if (send) flow.send = send;
    // Keyed on the socket, like every LAN guard (also for requests inside a LAN CONNECT tunnel).
    if (lanGateOf((req as unknown as { socket?: unknown }).socket)) flow.viaLan = true;
    const latency = flow.throttle?.latencyMs;
    if (flow.route === 'plain' && latency && latency > 0) {
      // Before forwarding, without reading the body: the route matcher waits on this.
      flow.delay = sleep(latency).then(() => this.live.has(req.id));
    }

    this.flows.set(req.id, flow);
    this.wireTap(req, flow);
    return flow;
  }

  /** The flow for a chosen rule (or none): its route, plus the network profile and drop rate. */
  private flowFor(headers: HeaderBag, rule: Rule | undefined, note?: string): Flow {
    const action = rule?.action;
    let flow: Flow;
    let dropRate: number | undefined;
    if (!rule || !action) {
      flow = { route: 'plain' };
    } else if (action.kind === 'fault') {
      // truncate forwards and cuts the response (streaming route); the others never reach the server.
      flow = { route: action.fault === 'truncate' ? 'plain' : 'h1', rule, fault: action.fault, simulated: FAULT_LABELS[action.fault] };
    } else if (action.kind === 'throttle') {
      flow = { route: 'plain', rule, throttle: { latencyMs: action.latencyMs, kbps: action.kbps }, simulated: throttleLabel(action) };
      dropRate = action.dropRate;
    } else if (action.kind === 'cors') {
      // Streams like a pass-through; the taps patch the response head (CONTRACTS §11.3).
      flow = { route: 'plain', rule, corsPatch: corsOptions(action) };
    } else if (action.kind !== 'breakpoint' && action.kind !== 'mutate') {
      flow = { route: 'h1', rule };
    } else {
      // Breakpoints and mutate rules run on hooked routes, where mockttp buffers the request body
      // before forwarding it. Only do that when the size is known and small; mockttp would otherwise
      // drop data past maxBodySize. (The mutate rule's response side never needs this; its request does.)
      const what = action.kind === 'mutate' ? 'Mutate rule' : 'Breakpoint';
      const why = bodyLimitReason(headers);
      flow = why
        ? { route: 'plain', rule, note: `${what} skipped: ${why}, so it was passed through unedited.` }
        : { route: action.kind === 'breakpoint' && action.phase === 'request' ? 'h1' : 'h2', rule };
    }
    if (note && !flow.note) flow.note = note;

    // The network profile: everything that would reach the network (no rule, breakpoints, mutate, cors and
    // throttle rules — whose own settings win over a throttle profile). Mock / block / fault rules answer as set.
    const reachesNetwork =
      !action || action.kind === 'breakpoint' || action.kind === 'mutate' || action.kind === 'throttle' || action.kind === 'cors';
    const p = this.profile;
    if (reachesNetwork && p.kind === 'offline') {
      flow = { route: 'h1', rule, fault: 'dns', simulated: describeProfile(p) };
      dropRate = undefined;
    } else if (reachesNetwork && p.kind === 'throttle' && action?.kind !== 'throttle') {
      flow.throttle = { latencyMs: p.latencyMs, kbps: p.kbps };
      flow.simulated = describeProfile(p);
      dropRate = p.dropRate;
    }
    if (dropRate && dropRate > 0 && Math.random() < dropRate) {
      // Reset instead (after the latency, like a flaky link), never forwarded.
      flow = { route: 'h1', rule, fault: 'drop', throttle: { latencyMs: flow.throttle?.latencyMs }, simulated: `${flow.simulated ?? 'Throttle'}: dropped` };
    }
    return flow;
  }

  /** Record from the passive taps: request body, response completion (except finished h1/h2 hooks). */
  private wireTap(req: OngoingRequest, flow: Flow): void {
    const tap = getTap(req.id);
    if (flow.route === 'plain') this.track(this.newExchange(req, flow), flow);
    if (!tap) return;
    this.applyShaping(tap, flow);
    tap.onRequestEnd = () => {
      const live = this.live.get(req.id);
      if (live && live.ex.state === 'pending' && live.flow.route === 'plain') {
        void this.requestBodyFromTap(tap, live.ex).then((b) => {
          if (!this.live.has(req.id)) return;
          this.setRequestBody(live.ex, b);
          this.emitChange(live.ex);
        });
      }
    };
    tap.onResponseHead = (status, headers) => this.onResponseHead(tap, status, headers);
    tap.onResponseDone = (finished) => void this.onResponseDone(tap, finished);
  }

  /** kbps pacing / the truncate fault, applied by the taps to the response on its way to the app. */
  private applyShaping(tap: Tap, flow: Flow): void {
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
  private onResponseHead(tap: Tap, status: number, headers: Record<string, string | string[]>): HeadPatch | void {
    const live = this.live.get(tap.id);
    if (!live || live.ex.state !== 'pending') return;
    const { ex, flow } = live;
    let patch: HeadPatch | undefined;
    let shown = headers;
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
    if (isEventStream(getHeader(headers, 'content-type')) && status >= 200 && status < 300) {
      this.startSse(live, tap, status, shown);
      patch = { ...patch, flush: true };
    }
    return patch;
  }

  /** CONTRACTS §11.1: events are parsed from the bytes going to the app; no body copy is kept. */
  private startSse(live: Live, tap: Tap, status: number, headers: Record<string, string | string[]>): void {
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
      (e) => this.addFrame(ex, sseFrame(e)),
      (message) => {
        if (this.live.get(ex.id)?.ex !== ex) return;
        ex.error = message;
        this.touch(ex);
      },
    );
    live.stream = { ...live.stream, sse: rec };
    tap.onResponseData = (buf) => rec.push(buf);
    this.emitChange(ex);
  }

  /** The truncate fault cut the response: record what the app got, as 'blocked'. */
  private onTruncated(tap: Tap, flow: Flow): void {
    const live = this.live.get(tap.id);
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
      if (!this.live.has(ex.id)) return;
      this.setRequestBody(ex, reqBody);
      ex.responseBody = resBody;
      this.finish(ex, 'blocked');
    });
  }

  private requestBodyFromTap(tap: Tap, ex: Exchange): Promise<Body | undefined> {
    return decodeForDisplay(captured(tap.req), getHeader(ex.requestHeaders, 'content-encoding'), isComplete(tap.req));
  }

  /** The response to the app was fully written (or the connection closed first). */
  private async onResponseDone(tap: Tap, finished: boolean): Promise<void> {
    const live = this.live.get(tap.id);
    if (!finished) {
      // Usually the 'abort' event records it. A throttled response may still be trickling out after
      // mockttp considers the request handled, and then no 'abort' comes: record it here.
      if (live && tap.shaping && !live.flow.truncated && live.ex.state === 'pending') {
        this.fail(live.ex, 'The app closed the connection before the throttled response was complete');
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
    if (!this.live.has(ex.id)) return; // finished meanwhile (e.g. proxy stopped)
    this.setRequestBody(ex, reqBody);
    ex.responseBody = resBody;
    const upstreamError = res.tags?.find((t) => t.startsWith('passthrough-error:'));
    const ssrf = res.statusCode === 403 && resBody?.encoding === 'utf8' && resBody.text.includes(SSRF_MARKER);
    if (ssrf) {
      this.fail(ex, resBody!.text.replace(/^Error: /, ''));
    } else if (upstreamError || (flow.route === 'h2' && flow.fault !== 'truncate')) {
      // h2 still pending here = beforeResponse never ran: upstream failure or response too large.
      const cause = upstreamError?.slice('passthrough-error:'.length);
      this.fail(
        ex,
        (resBody?.encoding === 'utf8' && resBody.text) ||
          (cause ? `The connection to the server failed${live.stream?.sse ? ' mid-stream' : ''} (${cause}).` : `Failed with status ${res.statusCode}`),
      );
    } else {
      this.finish(ex, 'completed');
    }
  }

  private onAbort(id: string, message: string | undefined): void {
    const live = this.live.get(id);
    if (!live) {
      this.flows.delete(id);
      return; // finished (incl. our own block/abort resets) or unknown
    }
    const { ex, flow } = live;
    if (flow.truncated) return; // the truncate fault closed it; recorded by onTruncated
    const hold = this.holds.get(id);
    if (hold) return hold(true); // the timeout fault: the app gave up
    this.flows.delete(id);
    if (ex.kind === 'websocket') {
      // Before the upgrade (after it, the connection's own close events finish the exchange).
      return this.fail(ex, message || 'No WebSocket connection: the upgrade got no answer (server unreachable, a TLS error, or the app gave up).');
    }
    const sse = live.stream?.sse;
    if (sse) {
      // An event stream usually ends when the app stops listening: that is not an error.
      void sse.end().then(() => {
        if (this.live.get(id)?.ex !== ex) return;
        if (message) this.fail(ex, message);
        else {
          ex.error ??= 'The app closed the event stream.';
          this.finish(ex, 'completed');
        }
      });
      return;
    }
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
    const flow: Flow = this.flows.get(req.id) ?? { route: 'h1', rule: this.matchRule(req.method, req.url, { count: false }).rule };
    const tap = getTap(req.id);
    // For breakpoints / deferred GraphQL rules the body is complete (≤ 5 MB); for mock/block it may be a capped prefix.
    const body = tap
      ? await decodeForDisplay(captured(tap.req), getHeader(req.headers, 'content-encoding'), isComplete(tap.req))
      : await decodeForDisplay(req.body.buffer, getHeader(req.headers, 'content-encoding'), true);
    if (flow.deferred) {
      // CONTRACTS §11.2: choose the rule now that the operation name can be read.
      const text = body && body.encoding === 'utf8' && !body.truncated ? body.text : undefined;
      const m = this.matchRule(req.method, req.url, { count: true, body: () => text });
      const r = this.flowFor(req.headers as HeaderBag, m.rule, m.note ?? flow.note);
      flow.deferred = false;
      Object.assign(flow, {
        rule: r.rule,
        note: r.note,
        fault: r.fault,
        throttle: r.throttle,
        simulated: r.simulated,
        corsPatch: r.corsPatch,
      });
      if (tap) this.applyShaping(tap, flow);
    }
    const rule = flow.rule;
    const ex = this.newExchange(req, flow);
    this.setRequestBody(ex, body);
    const action = rule?.action;

    if (flow.preflight) return this.answerPreflight(req, ex, flow);

    if (flow.fault && flow.fault !== 'truncate') return this.applyFault(ex, flow);

    if (action?.kind === 'mock') {
      this.track(ex, flow);
      if (action.delayMs && action.delayMs > 0) {
        await sleep(action.delayMs);
        if (ex.state !== 'pending') return { response: 'close' }; // client left during the delay
      }
      const headers: HeaderBag = { ...(action.headers ?? {}) };
      this.addCorsToLocalResponse(ex, headers);
      const decoded = Buffer.from(action.body ?? '', 'utf8');
      const rawBody = frameBody(decoded, headers);
      ex.status = action.status;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = await decodeForDisplay(decoded, undefined, true);
      if (isEventStream(getHeader(headers, 'content-type'))) this.setSseFrames(ex, decoded);
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
      this.addCorsToLocalResponse(ex, headers);
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
      if (!(await this.latency(ex, flow))) return { response: 'close' };
      return result;
    }

    this.track(ex, flow);
    if (!(await this.latency(ex, flow))) return { response: 'close' };
    return undefined;
  }

  /** A CORS preflight answered locally for a mock / block / cors rule (CONTRACTS §11.3). */
  private answerPreflight(req: CompletedRequest, ex: Exchange, flow: Flow): CallbackRequestResult {
    this.track(ex, flow);
    const headers: HeaderBag = preflightResponseHeaders(req.headers as HeaderBag, flow.corsPatch ?? {}) ?? { 'content-length': '0' };
    ex.status = 204;
    ex.responseHeaders = cleanHeaders(headers);
    ex.cors = { preflight: true, patched: true };
    this.finish(ex, 'mocked');
    return { response: { statusCode: 204, statusMessage: STATUS_CODES[204], headers, rawBody: Buffer.alloc(0) } };
  }

  /** Mock / block answers to browser requests get Access-Control-Allow-Origin when they lack it. */
  private addCorsToLocalResponse(ex: Exchange, headers: HeaderBag): void {
    if (hasAllowOrigin(headers) || !isCorsRequest(ex.method, ex.url, ex.requestHeaders)) return;
    const vary = getHeader(headers, 'vary');
    const set = corsResponseHeaders(ex.requestHeaders, Object.keys(headers), vary); // loopback origins only
    if (!set) return;
    deleteHeader(headers, 'vary');
    Object.assign(headers, set);
    ex.cors = { ...ex.cors, patched: true };
  }

  /** A complete event-stream body (mock, buffered response) → frames. */
  private setSseFrames(ex: Exchange, decoded: Buffer): void {
    ex.kind = 'sse';
    const frames: Frame[] = [];
    let dropped = 0;
    const at = Date.now();
    let bytes = 0;
    const parser = new SseParser((e) => {
      const f = sseFrame(e, at);
      frames.push(f);
      bytes += frameCost(f);
      while (frames.length > this.maxFrames || (bytes > MAX_FRAME_BYTES_PER_EXCHANGE && frames.length > 1)) {
        bytes -= frameCost(frames.shift()!);
        dropped++;
      }
    });
    parser.pushBytes(decoded);
    parser.end();
    ex.frames = frames;
    if (dropped) ex.framesDropped = dropped;
    this.frameBytes.set(ex.id, bytes);
  }

  /** Throttle latency before forwarding on a hooked route. false = the exchange ended meanwhile. */
  private async latency(ex: Exchange, flow: Flow): Promise<boolean> {
    const ms = flow.throttle?.latencyMs;
    if (ms && ms > 0) await sleep(ms);
    return this.live.has(ex.id);
  }

  /**
   * reset / drop: RST after the tunnel is up; dns: close without a response (FIN); timeout: hold until
   * the app gives up (or breakpointTimeoutMs, then RST). Never at the CONNECT/TLS level, where dart:io
   * would fall back to DIRECT (docs/spikes/faults.md). The exchange ends 'blocked'.
   */
  private async applyFault(ex: Exchange, flow: Flow): Promise<CallbackRequestResult> {
    this.track(ex, flow);
    if (flow.fault === 'drop' && !(await this.latency(ex, flow))) return { response: 'close' };
    if (flow.fault === 'timeout') {
      const appLeft = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), this.breakpointTimeoutMs);
        timer.unref?.();
        const settle = (left: boolean) => {
          clearTimeout(timer);
          this.holds.delete(ex.id);
          resolve(left);
        };
        this.holds.set(ex.id, settle);
      });
      if (!this.live.has(ex.id)) return { response: 'close' }; // proxy stopped
      const s = ((Date.now() - ex.startedAt) / 1000).toFixed(1);
      ex.simulated = appLeft ? `${FAULT_LABELS.timeout} (the app gave up after ${s} s)` : `${FAULT_LABELS.timeout} (reset after ${s} s)`;
      this.finish(ex, 'blocked');
      return appLeft ? { response: 'close' } : { response: 'reset' };
    }
    if (!this.live.has(ex.id)) return { response: 'close' };
    this.finish(ex, 'blocked');
    return flow.fault === 'dns' ? { response: 'close' } : { response: 'reset' };
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
    } else if (action?.kind === 'mutate') {
      result = await this.applyMutation(res, ex, action.ops);
      if (!this.live.has(ex.id) || ex.state !== 'pending') return 'close'; // the app left meanwhile
    } else if (flow.corsPatch && isCorsRequest(ex.method, ex.url, ex.requestHeaders)) {
      // A GraphQL-scoped cors rule resolved on the buffered route: patch the head here.
      const set = corsResponseHeaders(ex.requestHeaders, Object.keys(res.headers), getHeader(res.headers, 'vary'), flow.corsPatch);
      if (set) {
        const headers: HeaderBag = { ...res.headers };
        for (const h of CORS_RESPONSE_HEADERS) deleteHeader(headers, h);
        Object.assign(headers, set);
        result = { headers };
        ex.responseHeaders = cleanHeaders(headers);
        ex.cors = { ...ex.cors, patched: true };
      }
    }
    if (isEventStream(getHeader(ex.responseHeaders ?? {}, 'content-type')) && ex.responseBody && !ex.responseBody.truncated) {
      // Buffered (h2) event stream: frames from the whole body.
      this.setSseFrames(ex, (await decodeFull(res.body)) ?? Buffer.alloc(0));
    }
    if (flow.fault === 'truncate') return result; // onTruncated finishes it once the cut happens
    this.finish(ex, 'completed');
    return result;
  }

  /**
   * The mutate rule (CONTRACTS §10.2): JSON ops on the complete upstream body, re-encoded and re-framed
   * like a body edit. Anything that can't be mutated is forwarded unchanged with a note in `error`.
   */
  private async applyMutation(res: PassThroughResponse, ex: Exchange, ops: MutateOp[]): Promise<CallbackResponseMessageResult | undefined> {
    const outcome = await mutateBody(res.body.buffer, getHeader(res.headers, 'content-encoding'), ops);
    if (outcome.kind === 'skipped') {
      ex.error = outcome.note;
      return undefined;
    }
    const headers: HeaderBag = { ...res.headers };
    // Integrity headers would no longer describe the body.
    for (const h of ['content-md5', 'digest', 'content-digest', 'repr-digest']) deleteHeader(headers, h);
    const rawBody = await frameBodyAsync(outcome.decoded, headers); // off the event loop (REVIEW-4 #4)
    ex.responseHeaders = cleanHeaders(headers);
    ex.responseBody = await decodeForDisplay(outcome.decoded, undefined, true);
    ex.simulated = ex.simulated ? `${ex.simulated} · ${outcome.label}` : outcome.label;
    if (outcome.unmatched.length) ex.error = `Mutate rule: nothing matched ${outcome.unmatched.join(', ')} (the other changes were applied).`;
    return { headers, rawBody };
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
    deleteHeader(headers, TRACE_HEADER); // never upstream, even if an edit adds it back
    deleteHeader(headers, SEND_HEADER);
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
    if (decodedBody) this.setRequestBody(ex, await decodeForDisplay(decodedBody, undefined, true));
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

  // ---------------------------------------------------------------- WebSockets (CONTRACTS §11.1)

  /** Called by the WebSocket route matchers; decided (and recorded) once per upgrade. */
  private decideWs(req: OngoingRequest): Flow {
    const known = this.flows.get(req.id);
    if (known) return known;
    const url = toWsUrl(req.url);
    const meta = this.reqMeta.get(req);
    const m = this.matchRule(req.method, url, { count: true, ws: true });
    const action = m.rule?.action;
    let flow: Flow = { route: 'ws-pass' };
    if (action?.kind === 'block') flow = { route: 'ws-local', rule: m.rule };
    else if (action?.kind === 'fault') flow = { route: 'ws-local', rule: m.rule, fault: action.fault, simulated: FAULT_LABELS[action.fault] };
    else if (this.profile.kind === 'offline') flow = { route: 'ws-local', fault: 'dns', simulated: describeProfile(this.profile) };
    if (m.note) flow.note = m.note;
    if (meta?.traceId) flow.traceId = meta.traceId;
    if (lanGateOf((req as unknown as { socket?: unknown }).socket)) flow.viaLan = true;
    this.flows.set(req.id, flow);
    const ex = this.newExchange({ id: req.id, method: req.method, url, headers: req.headers as HeaderBag, timingEvents: req.timingEvents }, flow);
    delete ex.graphql;
    ex.kind = 'websocket';
    ex.frames = [];
    this.track(ex, flow);
    if (flow.route === 'ws-pass') {
      markProxySocket((req as unknown as { socket?: object }).socket); // app side gets the message size limit
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
  private watchWebSocket(req: OngoingRequest, ex: Exchange): void {
    const socket = (req as unknown as { socket?: net.Socket }).socket;
    socket?.once('ws-upgrade', (ws: WsLike) => {
      const live = this.live.get(ex.id);
      if (!live || live.ex !== ex) return;
      const st: StreamState = (live.stream = { ...live.stream, wsDirect: true });
      const up = ws.upstreamWebSocket;
      ws.on('message', (data, isBinary) => this.addFrame(ex, payloadFrame('send', isBinary ? 'binary' : 'text', toBuffer(data))));
      ws.on('ping', (d) => this.addFrame(ex, payloadFrame('send', 'ping', toBuffer(d))));
      ws.on('pong', (d) => this.addFrame(ex, payloadFrame('send', 'pong', toBuffer(d))));
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
        up.on('message', (data, isBinary) => this.addFrame(ex, payloadFrame('receive', isBinary ? 'binary' : 'text', toBuffer(data))));
        up.on('ping', (d) => this.addFrame(ex, payloadFrame('receive', 'ping', toBuffer(d))));
        up.on('pong', (d) => this.addFrame(ex, payloadFrame('receive', 'pong', toBuffer(d))));
        up.once('close', (code, reason) => {
          st.serverClose ??= { code, reason: toBuffer(reason) };
        });
      }
      ws.once('close', (code, reason) => this.onWsClosed(ex, code, toBuffer(reason)));
    });
  }

  /** The app's side of the WebSocket closed: the exchange ends (the side that closed first decides how). */
  private onWsClosed(ex: Exchange, appCode: number, appReason: Buffer): void {
    const live = this.live.get(ex.id);
    if (!live || live.ex !== ex) return;
    const tooBig = live.stream?.tooBig;
    if (tooBig) {
      return this.fail(
        ex,
        `A message from the ${tooBig === 'receive' ? 'server' : 'app'} was over the ${WS_MAX_MESSAGE_BYTES / 1024 / 1024} MB limit; ` +
          'the connection was closed (1009, message too big).',
      );
    }
    const server = live.stream?.serverClose;
    const [dir, code, reason] = server ? (['receive', server.code, server.reason] as const) : (['send', appCode, appReason] as const);
    if (code === 1006) {
      return this.fail(
        ex,
        dir === 'receive'
          ? "The server's connection ended without a close frame (abnormal closure, 1006)."
          : "The app's connection ended without a close frame (abnormal closure, 1006).",
      );
    }
    this.addFrame(ex, closeFrame(dir, code === 1005 ? undefined : code, reason));
    this.finish(ex, 'completed');
  }

  /** mockttp's 'websocket-accepted': the 101 and its headers. */
  private onWsAccepted(res: { id?: string; statusCode?: number; headers?: Record<string, unknown> }): void {
    const live = res.id ? this.live.get(res.id) : undefined;
    if (!live || live.ex.kind !== 'websocket') return;
    const { ex } = live;
    ex.status = res.statusCode ?? 101;
    ex.responseHeaders = cleanHeaders((res.headers ?? {}) as HeaderBag);
    if (!live.stream?.wsDirect) ex.error = 'Frames are not recorded (incompatible mockttp version).';
    this.emitChange(ex);
  }

  /** A response other than 101 to a passed-through upgrade (the server refused it, or mockttp failed). */
  private onWsRefused(res: { id?: string; statusCode?: number; statusMessage?: string; headers?: Record<string, unknown> }): void {
    const live = res.id ? this.live.get(res.id) : undefined;
    if (!live || live.ex.kind !== 'websocket' || live.flow.route !== 'ws-pass') return;
    const { ex } = live;
    ex.status = res.statusCode;
    ex.responseHeaders = cleanHeaders((res.headers ?? {}) as HeaderBag);
    this.fail(ex, `The WebSocket upgrade was refused: ${res.statusCode ?? '?'} ${res.statusMessage ?? ''}`.trim());
  }

  /** Block / fault rules and the offline profile on an upgrade: answered here, never forwarded. */
  private async onWsLocal(req: OngoingRequest, socket: net.Socket): Promise<void> {
    const live = this.live.get(req.id);
    if (!live) {
      socket.destroy();
      return;
    }
    const { ex, flow } = live;
    const action = flow.rule?.action;
    const reset = () => resetOrDestroy(req as unknown as Parameters<typeof resetOrDestroy>[0]);
    if (flow.fault === 'timeout') {
      const appLeft = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), this.breakpointTimeoutMs);
        timer.unref?.();
        const settle = (left: boolean) => {
          clearTimeout(timer);
          this.holds.delete(ex.id);
          resolve(left);
        };
        this.holds.set(ex.id, settle);
      });
      if (!this.live.has(ex.id)) {
        socket.destroy(); // proxy stopped
        return;
      }
      const s = ((Date.now() - ex.startedAt) / 1000).toFixed(1);
      ex.simulated = appLeft ? `${FAULT_LABELS.timeout} (the app gave up after ${s} s)` : `${FAULT_LABELS.timeout} (reset after ${s} s)`;
      this.finish(ex, 'blocked');
      if (!appLeft) reset();
      return;
    }
    if (flow.fault) {
      this.finish(ex, 'blocked');
      if (flow.fault === 'dns') {
        socket.end();
        socket.destroy();
      } else reset();
      return;
    }
    if (action?.kind === 'block' && action.mode === 'reset') {
      this.finish(ex, 'blocked');
      return reset();
    }
    const status = action?.kind === 'block' ? (action.status ?? 403) : 403;
    const body = Buffer.from(BLOCK_BODY, 'utf8');
    const headers = { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length), connection: 'close' };
    ex.status = status;
    ex.responseHeaders = { ...headers };
    ex.responseBody = { text: BLOCK_BODY, encoding: 'utf8' };
    this.finish(ex, 'blocked');
    const head = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Blocked'}\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')}\r\n\r\n`;
    socket.on('error', () => undefined);
    socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]));
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

/** A copy for listeners / getExchanges (frames is the only array the proxy keeps appending to). */
function snapshot(ex: Exchange): Exchange {
  const copy = { ...ex };
  if (ex.frames) copy.frames = ex.frames.slice();
  return copy;
}

/** `{graphql}` for a request whose body (if any) is known; strict detection (CONTRACTS §11.2). */
function graphqlOf(method: string, url: string, headers: HeaderBag, body?: Body): { graphql?: Exchange['graphql'] } {
  const m = method.toUpperCase();
  let text: string | undefined;
  if (m !== 'GET' && m !== 'HEAD') {
    if (!body || body.encoding !== 'utf8' || body.truncated) return {};
    text = body.text;
  }
  const d = detectGraphql({ method, url, contentType: getHeader(headers, 'content-type') ?? '', body: text });
  return d ? { graphql: d.info } : {};
}

function hasRequestBody(headers: HeaderBag): boolean {
  return !!getHeader(headers, 'transfer-encoding') || Number(getHeader(headers, 'content-length') ?? 0) > 0;
}

/** Why a request body can't be held for a hooked route (streamed, or over the pause limit). */
function bodyLimitReason(headers: HeaderBag): string | undefined {
  if (getHeader(headers, 'transfer-encoding')) return 'the request body is streamed (unknown length)';
  const cl = Number(getHeader(headers, 'content-length') ?? 0);
  if (cl > REQUEST_PAUSE_LIMIT_BYTES) {
    return `the request body (${(cl / MB).toFixed(1)} MB) is over the ${REQUEST_PAUSE_LIMIT_BYTES / MB} MB pause limit`;
  }
  return undefined;
}

function corsOptions(a: { allowOrigin?: string; allowCredentials?: boolean }): CorsOptions {
  const o: CorsOptions = {};
  if (typeof a.allowOrigin === 'string' && a.allowOrigin.trim()) o.allowOrigin = a.allowOrigin.trim();
  if (typeof a.allowCredentials === 'boolean') o.allowCredentials = a.allowCredentials;
  return o;
}

function capBody(b: unknown): Body | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const { text, encoding, truncated } = b as Body;
  if (typeof text !== 'string') return undefined;
  const enc = encoding === 'base64' ? 'base64' : 'utf8';
  const cap = enc === 'base64' ? Math.ceil((BODY_CAP_BYTES * 4) / 3) : BODY_CAP_BYTES;
  if (text.length > cap) return { text: text.slice(0, cap), encoding: enc, truncated: true };
  return truncated ? { text, encoding: enc, truncated: true } : { text, encoding: enc };
}

/** Copy of a record() / update() input: headers copied, bodies capped, frames capped (newest kept). */
function sanitizeRecord(input: Partial<Exchange>, maxFrames: number): Partial<Exchange> {
  const out: Record<string, unknown> = { ...input };
  delete out.id;
  if ('requestHeaders' in input) out.requestHeaders = cleanHeaders((input.requestHeaders ?? {}) as HeaderBag);
  if ('responseHeaders' in input) out.responseHeaders = input.responseHeaders ? cleanHeaders(input.responseHeaders as HeaderBag) : undefined;
  if ('requestBody' in input) out.requestBody = capBody(input.requestBody);
  if ('responseBody' in input) out.responseBody = capBody(input.responseBody);
  if ('frames' in input) {
    const frames = Array.isArray(input.frames) ? input.frames.map((f) => ({ ...f })) : undefined;
    if (frames) {
      let bytes = frames.reduce((n, f) => n + frameCost(f), 0);
      let drop = 0;
      while (frames.length - drop > maxFrames || (bytes > MAX_FRAME_BYTES_PER_EXCHANGE && frames.length - drop > 1)) {
        bytes -= frameCost(frames[drop++]);
      }
      if (drop) {
        out.framesDropped = (input.framesDropped ?? 0) + drop;
        frames.splice(0, drop);
      }
    }
    out.frames = frames;
  }
  return out as Partial<Exchange>;
}

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

/** Validate and copy a NetworkProfile; throws on nonsense (negative latency, dropRate outside 0–1, …). */
function validateProfile(p: NetworkProfile): NetworkProfile {
  if (!p || typeof p !== 'object') throw new Error('Invalid network profile');
  if (p.kind === 'none' || p.kind === 'offline') return { kind: p.kind };
  if (p.kind !== 'throttle') throw new Error(`Invalid network profile kind: ${(p as { kind?: unknown }).kind}`);
  const num = (v: unknown, name: string, max: number): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new Error(`Invalid network profile ${name}: ${v}`);
    return v;
  };
  const latencyMs = num(p.latencyMs, 'latencyMs', 10 * 60 * 1000);
  const kbps = num(p.kbps, 'kbps', 10_000_000);
  const dropRate = num(p.dropRate, 'dropRate', 1);
  return {
    kind: 'throttle',
    ...(p.preset ? { preset: p.preset } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(kbps ? { kbps } : {}),
    ...(dropRate !== undefined ? { dropRate } : {}),
  };
}
