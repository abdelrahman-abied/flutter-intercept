import { EventEmitter } from 'events';
import { callbackMatcher, requestInternals, serverInternals } from './mockttp-internals';
import * as http from 'http';
import { STATUS_CODES } from 'http';
import { randomBytes, randomUUID } from 'crypto';
import * as net from 'net';
import * as os from 'os';
// Deep imports on purpose: mockttp's index also loads its admin server and remote client
// (express, GraphQL, body-parser, …), ~2 MB of bundle and ~100 ms of module init we never use.
import type * as mockttp from 'mockttp';
import { MockttpServer } from 'mockttp/dist/server/mockttp-server';
import { CallbackStep, PassThroughStep } from 'mockttp/dist/rules/requests/request-step-definitions';
import { StepLookup } from 'mockttp/dist/rules/requests/request-step-impls';
import {
  PassThroughWebSocketStep,
  RejectWebSocketStep,
} from 'mockttp/dist/rules/websockets/websocket-step-definitions';
import { Always } from 'mockttp/dist/rules/completion-checkers';
import type { RequestMatcher } from 'mockttp/dist/rules/matchers';
import type { CompletedRequest, OngoingRequest, TlsHandshakeFailure } from 'mockttp';
import {
  BODY_CAP_BYTES,
  cleanHeaders,
  decodeForDisplay,
  deleteHeader,
  frameBody,
  getHeader,
  type HeaderBag,
} from './body';
import {
  compileRules,
  grpcApplicable,
  grpcEditProblem,
  grpcMockProblem,
  isInvalidMatcher,
  mapRemoteUrl,
  pickSequenceStep,
  WEBSOCKET_ACTIONS,
  type CompiledRule,
} from './rules';
import { ReplayStore, requestBodyHash, type BodyKey } from './replay';
import {
  createUpstreamAgents,
  isLoopbackHost,
  parseUpstreamProxy,
  retireAgents,
  type UpstreamAgents,
  type UpstreamProxyConfig,
  type UpstreamProxySpec,
} from './upstream-proxy';
import { matchesHostPattern, normalizeHostname, parseHostPatterns, type HostPattern } from './hosts';
import {
  CONNECT_TIMEOUT_HEADER,
  encodeGrpcMessage,
  type GrpcBreakerEvent,
  GRPC_HOOK_CAP_BYTES,
  grpcHookTesting,
  SILENT_TUNNEL_HEADER,
} from './grpc';
import { GrpcSessionPool } from './grpc-upstream';
import { grpcWebContentType, grpcWebVariant } from './grpc-web';
import { grpcSelfCheck, type GrpcSupport } from './silent';
import { graphqlOperationNames } from './graphql';
import { allowedOrigin, CORS_RESPONSE_HEADERS, corsResponseHeaders, isCorsRequest, preflightMethod } from './cors';
import { DEFAULT_MAX_FRAMES } from './frames';
import { installWsLimit } from './ws-limit';
import { boundAddressMatches, rebindIfNeeded, runWithListenHost } from './listen-host';
import { createUpstreamPool, HOST_ALIASES, type UpstreamPool } from './upstream-pool';
import type { RequestPlan } from './upstream-request';
import { refreshRoutes } from './routes';
import { captured, getTap, installTaps, isComplete, RESPONSE_PAUSE_LIMIT_BYTES } from './taps';
import {
  checkLanRequest,
  LanGate,
  lanGateOf,
  lanIPv4Addresses,
  lanTargetDenial,
  lanTesting,
  normalizeIp,
  onComboConnection,
  refuse,
  resolveCheckedTarget,
  RESPONSE_407,
  SSRF_MARKER,
} from './lan';
import { describeProfile, NO_PROFILE, type NetworkProfile } from './network';
import {
  isTraceHost,
  isTraceUrl,
  parseTraceBody,
  TraceJoin,
  TRACE_BODY_MAX,
  TRACE_HEADER,
  TRACE_ID_RE,
  TRACE_PATH,
} from './trace';
import { mentionsOnResponse, ScriptRunner } from './script';
import type {
  ClientCertificate,
  Exchange,
  GrpcEdit,
  GrpcProxyCodec,
  InterceptProxyOptions,
  LearnedPassthrough,
  ReplayEntry,
  ReplayOptions,
  RequestEdit,
  ResponseEdit,
  Rule,
  RuleAction,
  SendRequest,
} from './types';
import { ExchangeStore } from './exchange-store';
import { GrpcRelay } from './grpc-relay';
import { GrpcLocal } from './grpc-local';
import { GrpcHooks } from './grpc-hooks';
import { GrpcWebFlow } from './grpc-web-flow';
import { ConnectFlow } from './connect-flow';
import { LearnFlow } from './learn-flow';
import { learnedKey, parseLearnedKey, patternNamesHost } from './learned';
import { WsFlow } from './ws-flow';
import { ReplayFlow } from './replay-flow';
import { HttpEdits } from './http-edits';
import { HttpTaps } from './http-taps';
import type {
  Applied,
  ScriptAction,
  CallbackRequestResult,
  CallbackResponseResult,
  CallbackResponseMessageResult,
  PassThroughResponse,
  Decision,
  Route,
  SendMeta,
  Flow,
  MatchOptions,
  MatchResult,
  ReqMeta,
  Paused,
  LoadedCert,
} from './flow-types';
import {
  DEFAULT_MAX_EXCHANGES,
  DEFAULT_BREAKPOINT_TIMEOUT_MS,
  DEFAULT_MAX_STORED_BODY_BYTES,
  BLOCK_BODY,
  SEND_HEADER,
  SEND_DROPPED_HEADERS,
  HTTP_TOKEN,
  MAX_TIMER_MS,
  TRACE_FLOW,
  DENIED_FLOW,
  FAULT_LABELS,
  throttleLabel,
  profileLabel,
  defaultCa,
  decodeFull,
  sleep,
  isEventStream,
  capitalize,
  isGrpcCall,
  hasRequestBody,
  bodyLimitReason,
  corsOptions,
  validateEdit,
  validateProfile,
  sequenceSig,
  needsResponseHook,
  HOP_HEADER,
  INTERNAL_TUNNEL_HEADER,
} from './proxy-util';
import {
  rewriteSets,
  rewriteHostOf,
  rewritePairs,
  pairValue,
  pairsToObject,
  rewriteFlow,
  rewriteLabel,
} from './rewrite-flow';
import { loadClientCertificate, isLoopbackOrigin, certRefusalText } from './client-certs';
import type { ProxyContext } from './proxy-context';

/** QUALITY-1 Q1: key of InterceptProxy's test-only accessor. @internal */
export const TEST_INTERNALS = Symbol.for('flutter-intercept.test-internals');

/** What `proxy[TEST_INTERNALS]()` exposes to tests. @internal */
export interface ProxyTestInternals {
  readonly grpcPool: GrpcSessionPool | undefined;
  readonly grpcWebCalls: Map<string, unknown>;
  readonly grpcHeld: number;
  readonly paused: Map<string, unknown>;
  readonly lanGate: LanGate | undefined;
  readonly rawServer: net.Server | undefined;
  /** CONTRACTS §19.3 / §20.1: learn a gRPC pin (`host:port` → until), as onTlsError does. */
  readonly pinnedHosts: { set(key: string, until: number): unknown };
  readonly decrypting: Map<string, { host: string; port: number; http?: true }>;
  readonly learn: LearnFlow;
  onTlsError(f: unknown): void;
}

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
  private readonly breakpointTimeoutMs: number;
  private server?: mockttp.Mockttp;
  private pool?: UpstreamPool;
  private _port = 0;
  private compiled: CompiledRule[] = [];
  private readonly paused = new Map<string, Paused>();
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
  /** A Flutter Web session is running: tag the browser's own requests (CONTRACTS §11.3). */
  private webSession = false;
  /** Sequence position per rule id, with the rule content it belongs to (CONTRACTS §12.3). */
  private readonly seq = new Map<string, { sig: string; n: number }>();
  /** Replay mode (CONTRACTS §12.4). */
  private replayStore?: ReplayStore;
  /** CONTRACTS §12.6: pass-through traffic goes via this HTTP proxy. */
  private upstreamSpec?: UpstreamProxySpec;
  /** Upstream-proxy agents for LAN sockets, per gate (they check the final target). */
  private readonly lanUpstream = new WeakMap<LanGate, UpstreamAgents>();
  /** CONTRACTS §13.2: the request each downstream connection is serving (for the upstream phase timings). */
  private readonly connRequest = new WeakMap<object, string>();
  /** CONTRACTS §13.4: the worker that runs script rules (started on the first hook call). */
  private readonly scripts = new ScriptRunner();
  /** CONTRACTS §14.2: hostname patterns whose CONNECTs are tunnelled undecrypted. */
  private passthrough: HostPattern[] = [];
  private passthroughProblems: string[] = [];
  /** The CONNECT hook is installed (start()). */
  private connectHook = false;
  /** CONTRACTS §14.3: usable client certificates (first match wins) and every configured one's status. */
  private certs: LoadedCert[] = [];
  private certStatus: { host: string; problem?: string }[] = [];
  /**
   * mockttp's `clientCertificateHostMap`, looked up as `map["host:port"] || map[host] || map["*"]` for every upstream
   * TLS connection (requests and WebSocket upgrades): answered from `certs` by pattern, so it follows
   * setClientCertificates. Only "host:port" keys resolve.
   */
  private readonly certMap: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => (typeof key === 'string' ? this.certOptions(key) : undefined),
  });
  /** CONTRACTS §16.2: TLS silent tunnels to these hosts are decrypted (MITM); the rest are passed through. */
  private grpcDecrypt: HostPattern[] = [];
  private grpcDecryptProblems: string[] = [];
  /** The startup self-check of what the gRPC relay and silent tunnels need (grpcSupport()). */
  private grpcCheck: GrpcSupport = grpcSelfCheck();
  /** Upstream HTTP/2 sessions of the gRPC relay (start() → stop()). */
  private grpcPool?: GrpcSessionPool;
  /** mockttp's combo server (silent tunnels are handed to it). */
  private rawServer?: net.Server;
  /** setRules: grpcMock rules refused for their headers / values (disabled, CONTRACTS §16.2). */
  private refused: { id: string; problem: string }[] = [];
  /** CONTRACTS §20.1: learned passthrough hosts (HTTP CONNECTs and gRPC silent tunnels). */
  private readonly learn: LearnFlow;
  /** CONTRACTS §19.3: decrypt every TLS silent gRPC tunnel (but tlsPassthrough / learned pinned hosts). */
  private grpcDecryptAllOn = false;
  /** CONTRACTS §18.6: this instance's hop marker (on every relayed / sent gRPC call; one arriving with it is a loop). */
  private readonly hopNonce = randomBytes(18).toString('base64url');
  /** QUALITY-1 Q1: the flow modules' view of this proxy (proxy-context.ts). */
  private readonly ctx: ProxyContext;
  private readonly book: ExchangeStore;
  private readonly grpc: GrpcRelay;
  private readonly grpcLocal: GrpcLocal;
  private readonly hooks: GrpcHooks;
  private readonly grpcWeb: GrpcWebFlow;
  private readonly connect: ConnectFlow;
  private readonly ws: WsFlow;
  private readonly replays: ReplayFlow;
  private readonly edits: HttpEdits;
  private readonly taps: HttpTaps;

  constructor(private readonly opts: InterceptProxyOptions) {
    super();
    this.ctx = this.makeContext();
    const mf = opts.maxFramesPerExchange ?? DEFAULT_MAX_FRAMES;
    this.book = new ExchangeStore(this.ctx, {
      maxExchanges: Math.max(1, Math.floor(opts.maxExchanges ?? DEFAULT_MAX_EXCHANGES)),
      maxStoredBodyBytes: opts.maxStoredBodyBytes ?? DEFAULT_MAX_STORED_BODY_BYTES,
      maxFrames: Number.isFinite(mf) ? Math.max(0, Math.floor(mf)) : DEFAULT_MAX_FRAMES,
    });
    this.grpc = new GrpcRelay(this.ctx);
    this.grpcLocal = new GrpcLocal(this.ctx);
    this.hooks = new GrpcHooks(this.ctx);
    this.grpcWeb = new GrpcWebFlow(this.ctx);
    this.connect = new ConnectFlow(this.ctx);
    this.learn = new LearnFlow(this.ctx);
    this.ws = new WsFlow(this.ctx);
    this.replays = new ReplayFlow(this.ctx);
    this.edits = new HttpEdits(this.ctx);
    this.taps = new HttpTaps(this.ctx);
    this.host = opts.host ?? '127.0.0.1';
    this.breakpointTimeoutMs = opts.breakpointTimeoutMs ?? DEFAULT_BREAKPOINT_TIMEOUT_MS;
    if (opts.upstreamProxy) this.upstreamSpec = parseUpstreamProxy(opts.upstreamProxy);
    if (opts.tlsPassthrough) this.setTlsPassthrough(opts.tlsPassthrough);
    if (opts.clientCertificates) this.setClientCertificates(opts.clientCertificates);
    if (opts.grpcDecryptHosts) this.setGrpcDecryptHosts(opts.grpcDecryptHosts);
    if (opts.grpcDecryptAll) this.grpcDecryptAllOn = true;
  }
  /** QUALITY-1 Q1: getters and delegates over the members the flow modules use. */
  private makeContext(): ProxyContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      addressIsSelf: (...a) => self.addressIsSelf(...a),
      get appPackages() {
        return self.appPackages;
      },
      get book() {
        return self.book;
      },
      get breakpointTimeoutMs() {
        return self.breakpointTimeoutMs;
      },
      certFor: (...a) => self.certFor(...a),
      certRefusal: (...a) => self.certRefusal(...a),
      get connectHook() {
        return self.connectHook;
      },
      set connectHook(v) {
        self.connectHook = v;
      },
      get connRequest() {
        return self.connRequest;
      },
      get edits() {
        return self.edits;
      },
      emit: (event, ...args) => self.emit(event, ...args),
      get grpc() {
        return self.grpc;
      },
      get grpcCheck() {
        return self.grpcCheck;
      },
      get grpcDecrypt() {
        return self.grpcDecrypt;
      },
      get grpcDecryptAllOn() {
        return self.grpcDecryptAllOn;
      },
      get grpcLocal() {
        return self.grpcLocal;
      },
      get grpcPool() {
        return self.grpcPool;
      },
      get grpcWeb() {
        return self.grpcWeb;
      },
      get holds() {
        return self.holds;
      },
      get hooks() {
        return self.hooks;
      },
      get hopNonce() {
        return self.hopNonce;
      },
      get host() {
        return self.host;
      },
      get lanGate() {
        return self.lanGate;
      },
      get learn() {
        return self.learn;
      },
      matchRule: (...a) => self.matchRule(...a),
      get opts() {
        return self.opts;
      },
      get passthrough() {
        return self.passthrough;
      },
      pause: (...a) => self.pause(...a),
      get paused() {
        return self.paused;
      },
      get port() {
        return self._port;
      },
      get profile() {
        return self.profile;
      },
      get rawServer() {
        return self.rawServer;
      },
      replayFlow: (...a) => self.replayFlow(...a),
      ruleNamingHost: (...a) => self.ruleNamingHost(...a),
      get replayStore() {
        return self.replayStore;
      },
      get reqMeta() {
        return self.reqMeta;
      },
      get scripts() {
        return self.scripts;
      },
      get sends() {
        return self.sends;
      },
      get server() {
        return self.server;
      },
      get taps() {
        return self.taps;
      },
      targetsSelf: (...a) => self.targetsSelf(...a),
      get traceJoin() {
        return self.traceJoin;
      },
      get upstreamSpec() {
        return self.upstreamSpec;
      },
      get webSession() {
        return self.webSession;
      },
    };
  }

  /**
   * QUALITY-1 Q1: the one supported way for tests to look inside (so moving internals between modules never breaks
   * them). Not part of the API.
   * @internal
   */
  [TEST_INTERNALS](): ProxyTestInternals {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get grpcPool() {
        return self.grpcPool;
      },
      get grpcWebCalls() {
        return self.grpcWeb.grpcWebCalls as Map<string, unknown>;
      },
      get grpcHeld() {
        return self.hooks.grpcHeld;
      },
      get paused() {
        return self.paused as Map<string, unknown>;
      },
      get lanGate() {
        return self.lanGate;
      },
      get rawServer() {
        return self.rawServer;
      },
      get pinnedHosts() {
        return {
          set: (key: string, until: number) => {
            const k = parseLearnedKey(key);
            if (k?.port !== undefined) self.learn.hosts.learn(k.host, k.port, 'pinned', { until, grpc: true });
          },
        };
      },
      get learn() {
        return self.learn;
      },
      get decrypting() {
        return self.connect.decrypting;
      },
      onTlsError: (f: unknown) => self.connect.onTlsError(f as TlsHandshakeFailure),
    };
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
      // CONTRACTS §16.2: HTTP/2 only for clients that don't offer HTTP/1.1 (gRPC offers [grpc-exp, h2]; Chrome, which
      // offers both, and dart:io, which offers none, keep HTTP/1.1), and for the h2c preface on silent tunnels.
      http2: 'fallback',
      recordTraffic: false, // we keep our own bounded store
      cors: false,
      suggestChanges: false,
      // Caps mockttp's in-flight body buffers. Safe ONLY because nothing reads a request body
      // before the passthrough starts streaming it (see docs/spikes/proxy.md, "Memory").
      maxBodySize: BODY_CAP_BYTES,
    });
    const pool = createUpstreamPool({ rewriteLocalhost: this.opts.rewriteLocalhost ?? true });
    pool.setRequestPlan((conn, target) => this.requestPlan(conn, target));
    const connection = {
      proxyConfig: pool.proxyConfig, // marks our rules for the shared upstream pool
      ignoreHostHttpsErrors: this.opts.ignoreUpstreamCertErrors ?? false,
      clientCertificateHostMap: this.certMap as never, // CONTRACTS §14.3
      // Upstream failure (refused, DNS, TLS, reset) → mockttp answers 502 with the error text;
      // the exchange is recorded as 'error'. The app never hangs on a dead upstream.
      simulateConnectionErrors: false,
    };
    const route = (r: Route): RequestMatcher =>
      callbackMatcher(
        'flutter-intercept-route',
        // Headers only: never waits for (or reads) the request body. Synchronous, except that a
        // throttled plain request resolves after its latency (the body waits, unread, meanwhile).
        (req: OngoingRequest) => {
          const flow = this.decide(req);
          if (flow.route !== r) return false;
          return flow.delay ?? true;
        },
        () => `routed to "${r}" by Flutter Intercept`,
      );
    // `Always` matters: without a completion checker mockttp prefers the LAST matching rule once a
    // rule has been used.
    // LAN mode, first rule: refuse LAN requests to this machine's own services (403). Async
    // matcher (DNS); for loopback clients it answers false synchronously.
    const lanDeny = callbackMatcher(
      'flutter-intercept-lan-deny',
      (req: OngoingRequest) => {
        if (this.unauthorized.has(req)) return false;
        if (isTraceUrl(req.url)) return false; // the trace sink: answered locally, nothing is contacted
        // Keyed on the socket: a socket some LAN gate accepted is guarded even after closeLan.
        const gate = lanGateOf(requestInternals(req).socket);
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
      () => 'LAN request to a local target (Flutter Intercept)',
    );
    const unauthorized = callbackMatcher(
      'flutter-intercept-lan-unauthorized',
      (req: OngoingRequest) => this.unauthorized.has(req),
      () => 'LAN request without valid proxy credentials (Flutter Intercept)',
    );
    // CONTRACTS §14.5: a replayed event stream is written by us, event by event (a beforeRequest answer is one body).
    // Same trick as the WebSocket steps below: an own `handle` replaces the step implementation's.
    const passthroughImpl = StepLookup.passthrough.fromDefinition(new PassThroughStep(connection));
    const replayStreamStep = Object.assign(new CallbackStep(() => ({ statusCode: 500 })), {
      handle: (req: OngoingRequest, res: http.ServerResponse, options: unknown) => this.replays.onReplayStream(req, res, passthroughImpl, options),
    });
    // CONTRACTS §16.2: the gRPC relay, same trick (the self-check verifies mockttp keeps an own `handle`).
    const grpcStep = Object.assign(new CallbackStep(() => ({ statusCode: 500 })), {
      handle: (req: OngoingRequest, res: http.ServerResponse) => this.grpc.onGrpc(req, res),
    });
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
        // CONTRACTS §16.2: gRPC calls, by our own HTTP/2 relay (never mockttp's passthrough). Before the LAN deny rule:
        // a refusal is answered in gRPC terms (UNAVAILABLE), and the relay's upstream sockets carry the same guard.
        matchers: [route('grpc')],
        completionChecker: new Always(),
        steps: [grpcStep],
      },
      {
        matchers: [lanDeny],
        completionChecker: new Always(),
        steps: [new CallbackStep((req) => this.onLanDenied(req))],
      },
      {
        matchers: [route('replay-stream')],
        completionChecker: new Always(),
        steps: [replayStreamStep],
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
      callbackMatcher(
        'flutter-intercept-ws-route',
        (req: OngoingRequest) => this.ws.decideWs(req).route === r,
        () => `websocket routed to "${r}" by Flutter Intercept`,
      );
    // A ws step whose handler is ours: mockttp builds the step from the definition's own properties
    // (Object.assign onto the impl prototype), so an own `handle` replaces the reject implementation.
    const localWsStep = Object.assign(new RejectWebSocketStep(500), {
      handle: (req: OngoingRequest, socket: net.Socket) => this.ws.onWsLocal(req, socket),
    });
    // Map Remote on an upgrade (CONTRACTS §12.6): mockttp makes req.url read-only for websockets, so the mapped
    // target is handed to the step's own connectUpstream (same agents, TLS options and recording hook).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const proxy = this;
    const passWsStep = Object.assign(new PassThroughWebSocketStep(connection), {
      handle: function (this: any, req: OngoingRequest, socket: net.Socket, head: Buffer, options: unknown) {
        const impl = Object.getPrototypeOf(this);
        const map = proxy.book.flows.get(req.id)?.map;
        if (!map) return impl.handle.call(this, req, socket, head, options);
        return proxy.ws.connectWsMapped(this, req, socket, head, options, map);
      },
    });
    const replayWsStep = Object.assign(new RejectWebSocketStep(500), {
      handle: (req: OngoingRequest, socket: net.Socket, head: Buffer) => this.replays.onWsReplay(req, socket, head),
    });
    await serverInternals(server).addWebSocketRules(
      { matchers: [wsRoute('ws-local')], completionChecker: new Always(), steps: [localWsStep] },
      { matchers: [wsRoute('ws-replay')], completionChecker: new Always(), steps: [replayWsStep] },
      { matchers: [wsRoute('ws-pass')], completionChecker: new Always(), steps: [passWsStep] },
    );
    // PERF-1 #4: no 'response' listener — it made mockttp buffer a second copy of every response body. The taps
    // write past mockttp's tracking stream (taps.ts), and refused WebSocket upgrades are read from the socket
    // (watchWebSocket).
    await server.on('websocket-accepted', (res) => this.ws.onWsAccepted(res));
    await server.on('abort', (req) => this.taps.onAbort(req.id, req.error?.message));
    await server.on('tls-client-error', (f) => this.connect.onTlsError(f));

    try {
      await runWithListenHost(this.host, () => server.start(this.opts.port));
      const raw = serverInternals(server).server;
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
      const ms = serverInternals(server);
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
      this.connect.installConnectHook(raw);
      this.rawServer = raw;
      this.grpcCheck = grpcSelfCheck({ connectHook: this.connectHook, server: raw });
      // LAN sockets get their gate's guarded agents — always, whether or not LAN mode is on now.
      pool.setLan({
        agentFor: (connection, protocol) => {
          const gate = lanGateOf(connection);
          if (!gate) return undefined;
          if (gate.closed) {
            throw Object.assign(new Error(`${SSRF_MARKER}: LAN mode is off.`), { statusCode: 403, statusMessage: 'Forbidden' });
          }
          const up = this.lanUpstreamAgents(gate);
          if (up) {
            if (protocol === 'https:') return up.https;
            if (protocol === 'http:' || protocol === undefined) return up.http;
            return up.ws(protocol === 'wss:');
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
    this.grpcPool = new GrpcSessionPool();
    this._port = server.port;
    // PERF-1 #6: mockttp reads `this.port` (getsockname) in preprocessRequest for every request; the port is fixed now.
    try {
      Object.defineProperty(server, 'port', { value: this._port, configurable: true });
    } catch {
      /* keep mockttp's getter */
    }
    if (this.upstreamSpec) {
      try {
        this.checkUpstreamLoop(this.upstreamSpec);
      } catch (e) {
        await this.stop();
        throw e;
      }
      pool.setUpstream(this.upstreamSpec);
    }
    this.sendAgent = new http.Agent({ keepAlive: true });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await this.closeLan();
    this.server = undefined;
    const paused = [...this.paused.values()];
    for (const { ex } of [...this.book.live.values()]) this.book.fail(ex, 'Proxy stopped');
    for (const p of paused) p.settle({ kind: 'gone' });
    for (const settle of [...this.holds.values()]) settle(false);
    for (const c of this.sendClients) c.destroy();
    this.sendClients.clear();
    for (const t of this.connect.tunnelSockets) t.destroy();
    this.connect.tunnelSockets.clear();
    this.scripts.stop();
    this.replays.wsReplayServer?.close();
    this.replays.wsReplayServer = undefined;
    await server.stop();
    this.pool?.destroy();
    this.pool = undefined;
    this.grpcPool?.destroyAll();
    this.grpcPool = undefined;
    this.learn.clear();
    this.connect.pinStrikes.clear();
    this.connect.decrypting.clear();
    this.rawServer = undefined;
    this.sendAgent?.destroy();
    this.sendAgent = undefined;
    this.book.flows.clear();
    this.clearExpiryTimers();
    this.traceJoin.clear();
    for (const st of this.book.emitState.values()) clearTimeout(st.timer);
    this.book.emitState.clear();
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
      const raw = serverInternals(server).server!;
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
    if (gate) this.grpcPool?.destroyGate(gate);
    const up = gate && this.lanUpstream.get(gate);
    if (up) {
      this.lanUpstream.delete(gate);
      up.http.destroy();
      up.https.destroy();
    }
  }

  private onLanDenied(req: CompletedRequest): mockttp.requestSteps.CallbackResponseResult {
    const reason = this.lanDenials.get(req.id) ?? `${SSRF_MARKER}.`;
    this.lanDenials.delete(req.id);
    // A plain-route exchange already exists (its tap records the 403 as 'error'); hooked routes
    // never reached their hooks, so record those here.
    if (!this.book.live.has(req.id)) {
      const url = this.book.flows.get(req.id)?.originalUrl ?? req.url;
      this.book.flows.delete(req.id);
      this.recordBlocked(req.method, url, reason);
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
    this.book.store.set(ex.id, ex);
    this.book.emitChange(ex);
  }

  /**
   * First enabled matching rule wins. Rules with an invalid /regex/ never match. Spending (CONTRACTS
   * §9.2): hit counts are keyed by rule id and survive setRules (dropped when the id disappears); a rule
   * whose `times` is used up or whose `expiresAt` passed no longer matches, and 'rule-spent' fires once
   * (again only if an update revives it and it is spent anew).
   */
  setRules(rules: Rule[]): void {
    // CONTRACTS §16.2: a grpcMock (also as a sequence step) with headers the proxy owns (pseudo headers, content-type,
    // grpc-status, grpc-message, hop-by-hop) or invalid values is refused: kept but never matched, listed in refusedRules.
    const refused: { id: string; problem: string }[] = [];
    const problemOf = (a: RuleAction | undefined): string | undefined => {
      if (a?.kind === 'grpcMock') return grpcMockProblem(a);
      if (a?.kind === 'sequence' && Array.isArray(a.steps)) {
        for (let i = 0; i < a.steps.length; i++) {
          const st = a.steps[i]?.action;
          const p = st?.kind === 'grpcMock' ? grpcMockProblem(st) : undefined;
          if (p) return `Sequence step ${i + 1}: ${p}`;
        }
      }
      return undefined;
    };
    // `used` is the host's display copy of our count: ignored, hit counts stay ours (keyed by id).
    this.compiled = compileRules(
      rules.map(({ used: _used, ...r }) => {
        const problem = problemOf(r.action);
        if (problem) refused.push({ id: r.id, problem });
        return { ...r, ...(problem ? { enabled: false } : {}), match: { ...r.match }, action: { ...r.action } } as Rule;
      }),
    );
    this.refused = refused;
    const ids = new Set(rules.map((r) => r.id));
    for (const id of [...this.hits.keys()]) if (!ids.has(id)) this.hits.delete(id);
    for (const id of [...this.spentFired]) if (!ids.has(id)) this.spentFired.delete(id);
    // Sequence positions (CONTRACTS §12.3) survive setRules unless the rule's match or action changed.
    const sigs = new Map<string, string>();
    for (const { rule } of this.compiled) if (rule.action?.kind === 'sequence') sigs.set(rule.id, sequenceSig(rule));
    for (const [id, st] of [...this.seq]) if (sigs.get(id) !== st.sig) this.seq.delete(id);
    const now = Date.now();
    for (const { rule } of this.compiled) {
      const reason = this.spentReason(rule, now);
      if (!reason) this.spentFired.delete(rule.id); // revived (times raised, expiry moved): may fire again
      else this.markSpent(rule.id, reason); // e.g. times lowered below the hits, or already expired
    }
    this.armExpiryTimers();
    // CONTRACTS §13.4: the worker runs while an enabled script rule exists.
    this.scripts.setScripts(
      this.compiled
        .filter(({ rule }) => rule.enabled && rule.action?.kind === 'script')
        .map(({ rule }) => ({ ruleId: rule.id, code: (rule.action as ScriptAction).code })),
    );
  }

  /** CONTRACTS §16.2: rules setRules refused (a grpcMock with headers the proxy owns, or invalid values); never matched. */
  get refusedRules(): { id: string; problem: string }[] {
    return this.refused.map((r) => ({ ...r }));
  }

  /** CONTRACTS §13.4: the script worker thread is running (status / tests). */
  get scriptWorkerRunning(): boolean {
    return this.scripts.running;
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
   * CONTRACTS §12.3: start sequence rules from their first step again (all, or the given rule ids). Positions
   * also reset when a rule's match or action changes in setRules.
   */
  resetSequences(ruleIds?: string[]): void {
    if (!ruleIds) this.seq.clear();
    else for (const id of ruleIds) this.seq.delete(id);
  }

  /**
   * CONTRACTS §12.4: answer requests from a recording (undefined = stop). Rules are checked first; a request no
   * rule matches is answered from the entries — exact method + URL (+ request body hash when the entry has one),
   * then, with `matchTemplates`, method + origin + path template — several responses for one key in order, then
   * the last repeats. Unmatched requests: `passthrough` (the real server) or `fail` (closed like the offline
   * profile's DNS fault). Replayed exchanges end `mocked` with `simulated: "Replayed from <name>"`. Invalid entries
   * are skipped; returns how many are used. Throws on invalid options. Applies to requests that arrive from now on.
   */
  setReplay(entries: ReplayEntry[] | undefined, opts?: ReplayOptions & { name?: string }): number {
    if (entries === undefined || entries === null) {
      this.replayStore = undefined;
      return 0;
    }
    if (!Array.isArray(entries)) throw new Error('Replay entries must be an array');
    const fallback = opts?.fallback ?? 'passthrough';
    if (fallback !== 'passthrough' && fallback !== 'fail') throw new Error(`Invalid replay fallback: ${String(fallback)}`);
    this.replayStore = new ReplayStore(entries, { ...opts, fallback });
    return this.replayStore.size;
  }

  /** Replay mode, if on. */
  get replay(): { name?: string; entries: number; fallback: ReplayOptions['fallback']; matchTemplates: boolean } | undefined {
    const r = this.replayStore;
    return r ? { ...(r.name ? { name: r.name } : {}), entries: r.size, fallback: r.fallback, matchTemplates: r.matchTemplates } : undefined;
  }

  /**
   * CONTRACTS §12.6: send pass-through traffic via another HTTP proxy (CONNECT for HTTPS / WebSockets), or
   * directly again (undefined). Requests in flight finish on their connections; new ones use the new setting.
   * Upstream TLS stays verified unless `ignoreCertErrors` (a MITM proxy such as Charles). LAN clients keep the §7
   * SSRF guard on the final target. Throws on an invalid URL or one that points at this proxy.
   */
  setUpstreamProxy(cfg: UpstreamProxyConfig | undefined): void {
    const spec = cfg ? parseUpstreamProxy(cfg) : undefined;
    if (spec && this.server) this.checkUpstreamLoop(spec);
    this.upstreamSpec = spec;
    this.pool?.setUpstream(spec);
  }

  /** `host:port` of the upstream proxy in use, for status lines (never credentials). */
  get upstreamProxyDisplay(): string | undefined {
    const s = this.upstreamSpec;
    return s ? s.label.replace(/^http:\/\//, '') : undefined;
  }

  /** The upstream proxy in use (`http://host:port`, never credentials), with its normalised noProxy entries. */
  get upstreamProxy(): { url: string; ignoreCertErrors: boolean; noProxy?: string[] } | undefined {
    const s = this.upstreamSpec;
    if (!s) return undefined;
    const noProxy = s.noProxy?.map((e) => `${e.host.startsWith('.') ? `*${e.host}` : net.isIPv6(e.host) ? `[${e.host}]` : e.host}${e.port !== undefined ? `:${e.port}` : ''}`);
    return { url: s.label, ignoreCertErrors: s.ignoreCertErrors, ...(noProxy?.length ? { noProxy } : {}) };
  }

  /**
   * CONTRACTS §14.2: CONNECTs to these hosts (host patterns, src/hosts.ts) are tunnelled to the real server
   * undecrypted: the app sees the server's own certificate (its pinning keeps working), each tunnel is one exchange
   * (`kind: 'tunnel'`, method CONNECT, url `https://host:port/`, `tunnelBytes`), no headers / bodies. Only block and
   * fault rules apply (after the TLS handshake, see src/tls-records.ts), plus the network profile. Refused entries
   * are dropped one by one and reported in `problems` (REVIEW-8 #4); the rest apply. Applies to CONNECTs from now on.
   */
  setTlsPassthrough(hosts: string[] | undefined): { hosts: string[]; problems: string[] } {
    const { patterns, problems } = parseHostPatterns(hosts);
    this.passthrough = patterns;
    // One sentence per refused entry, naming it (parseHostPattern's messages start with the quoted entry).
    this.passthroughProblems = problems.map((x) => (x.problem.startsWith('"') ? x.problem : `"${x.host.slice(0, 100)}": ${x.problem}`));
    return { hosts: patterns.map((p) => p.pattern), problems: this.passthroughProblems.slice() };
  }

  /** Why entries of the last setTlsPassthrough were refused (one sentence each, naming the entry). */
  get tlsPassthroughProblems(): string[] {
    return this.passthroughProblems.slice();
  }

  /** The TLS passthrough patterns in use. */
  get tlsPassthrough(): string[] {
    return this.passthrough.map((p) => p.pattern);
  }

  /**
   * CONTRACTS §16.2: TLS gRPC silent tunnels to these hosts (host patterns, same rules as setTlsPassthrough) are
   * decrypted — for apps that trust the Flutter Intercept CA in debug; other TLS silent tunnels are passed through
   * undecrypted (`grpcTunnel`). A tlsPassthrough host is never decrypted. Applies to tunnels opened from now on.
   */
  setGrpcDecryptHosts(hosts: string[] | undefined): { hosts: string[]; problems: string[] } {
    const { patterns, problems } = parseHostPatterns(hosts);
    this.grpcDecrypt = patterns;
    this.grpcDecryptProblems = problems.map((x) => (x.problem.startsWith('"') ? x.problem : `"${x.host.slice(0, 100)}": ${x.problem}`));
    return { hosts: patterns.map((p) => p.pattern), problems: this.grpcDecryptProblems.slice() };
  }

  /**
   * CONTRACTS §19.3: while an iOS simulator trusts the Flutter Intercept CA, decrypt TLS silent gRPC tunnels for every
   * host (except tlsPassthrough hosts and hosts learned to pin their certificate). Off = only grpcDecryptHosts.
   */
  setGrpcDecryptAll(on: boolean): void {
    // Turning decrypt-all on again starts over: hosts learned earlier get another chance (REVIEW-13 #6).
    if (on && !this.grpcDecryptAllOn) this.clearGrpcPinnedHosts();
    this.grpcDecryptAllOn = !!on;
  }

  /** CONTRACTS §19.3: forget every learned pinned host (they are decrypted again under decrypt-all). */
  clearGrpcPinnedHosts(): void {
    this.learn.hosts.forget((e) => !!e.grpc && e.reason === 'pinned');
    this.connect.pinStrikes.clear();
  }

  get grpcDecryptAll(): boolean {
    return this.grpcDecryptAllOn;
  }

  /** CONTRACTS §19.3: hosts learned on gRPC tunnels to pin their certificate (`host:port`, live ones). */
  get grpcPinnedHosts(): string[] {
    return this.learn.hosts.list().filter((e) => e.grpc && e.reason === 'pinned').map((e) => learnedKey(e.host, e.port));
  }

  /**
   * CONTRACTS §20.1: hosts passed through without decryption because the proxy learned it — the server wants the
   * app's own client certificate (`client-certificate`, until the proxy stops, it is forgotten, or a certificate is
   * configured for it) or the app rejects the proxy's certificate (`pinned`, GRPC_PIN_TTL_MS). Live entries only.
   */
  get learnedPassthrough(): LearnedPassthrough[] {
    return this.learn.hosts.list();
  }

  /**
   * CONTRACTS §20.1: forget learned hosts — `host:port` (`[v6]:port`; a bare host = every port), none = all. Their
   * next CONNECT is decrypted again. Emits 'learnedPassthrough' when something was forgotten.
   */
  forgetLearnedPassthrough(key?: string): void {
    if (key === undefined) {
      this.learn.hosts.clear();
      this.connect.pinStrikes.clear();
      return;
    }
    const k = parseLearnedKey(key);
    if (!k) return;
    this.learn.hosts.forget((e) => e.host === k.host && (k.port === undefined || e.port === k.port));
    for (const s of [...this.connect.pinStrikes.keys()]) {
      const p = parseLearnedKey(s);
      if (p && p.host === k.host && (k.port === undefined || p.port === k.port)) this.connect.pinStrikes.delete(s);
    }
  }

  /** The gRPC decrypt patterns in use. */
  get grpcDecryptHosts(): string[] {
    return this.grpcDecrypt.map((p) => p.pattern);
  }

  /** Why entries of the last setGrpcDecryptHosts were refused. */
  get grpcDecryptHostsProblems(): string[] {
    return this.grpcDecryptProblems.slice();
  }

  /**
   * CONTRACTS §18.6: does this URL point at this proxy's own listener (loopback / unspecified / emulator alias / this
   * machine's addresses, on the loopback or LAN listener port)? Hosts use it (or the pure `targetsProxy`) to refuse Map
   * Remote rules that would relay to the proxy.
   */
  targetsProxy(url: string): boolean {
    try {
      const u = new URL(url);
      return this.targetsSelf(u.hostname.replace(/^\[|\]$/g, ''), Number(u.port) || (u.protocol === 'https:' ? 443 : 80));
    } catch {
      return false;
    }
  }

  /** CONTRACTS §18.6: the connected address is this machine (loopback / unspecified / an interface) on one of our ports. */
  private addressIsSelf(ip: string, port: number): boolean {
    const ports = [this._port, this.lanGate?.address?.port].filter((p): p is number => !!p);
    if (!ports.includes(port)) return false;
    const a = normalizeIp(ip);
    if (isLoopbackHost(a) || a === '0.0.0.0' || a === '::') return true;
    for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (normalizeIp(i.address) === a) return true;
    return false;
  }

  private targetsSelf(hostIn: string, port: number): boolean {
    const ports = [this._port, this.lanGate?.address?.port].filter((p): p is number => !!p);
    if (!ports.includes(port)) return false;
    const h = normalizeIp(hostIn.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''));
    if (isLoopbackHost(h) || HOST_ALIASES[h] || h === '0.0.0.0' || h === '::') return true;
    if (h === normalizeIp(this.host) || h === this.lanGate?.address?.host) return true;
    return lanIPv4Addresses().includes(h);
  }

  /**
   * CONTRACTS §17.3: the protobuf codec mutate rules use on gRPC response messages (undefined = none: mutate rules then
   * forward messages unchanged with a note). Synchronous; called only for messages a mutate rule changes.
   */
  setGrpcCodec(codec?: GrpcProxyCodec): void {
    this.hooks.grpcCodec = codec && typeof codec.decode === 'function' && typeof codec.encode === 'function' ? codec : undefined;
  }

  /**
   * CONTRACTS §16.2: whether gRPC interception works with this mockttp (a startup self-check of the internals the
   * relay and silent tunnels use). Not ok: silent tunnels are passed through undecrypted and `problem` says why.
   */
  grpcSupport(): { ok: boolean; problem?: string } {
    return this.grpcCheck.ok ? { ok: true } : { ok: false, ...(this.grpcCheck.problem ? { problem: this.grpcCheck.problem } : {}) };
  }

  /** False only when mockttp's CONNECT handling could not be hooked (then passthrough hosts are intercepted as usual). */
  get tlsPassthroughAvailable(): boolean {
    return !this.server || this.connectHook;
  }

  /**
   * CONTRACTS §14.3: client certificates for upstream mTLS. The first entry whose `host` pattern (glob, optional
   * `:port`) matches the server is presented on every upstream TLS connection to it (requests and WebSocket upgrades,
   * through the pool, LAN-guarded and upstream-proxy agents alike; each certificate gets its own pooled connections).
   * Returns one status per entry, in order: `problem` set = not usable (bad pattern, unreadable PKCS#12 / PEM, wrong
   * passphrase, key not matching the certificate…) and skipped; the others are used. Never throws for a bad entry;
   * key material and passphrases never appear in problems, exchanges or events. Exchanges that presented one carry
   * `clientCertificate` = the pattern. Applies to connections opened from now on.
   */
  setClientCertificates(certs: ClientCertificate[] | undefined): { host: string; problem?: string }[] {
    if (certs !== undefined && certs !== null && !Array.isArray(certs)) throw new Error('Client certificates: expected a list');
    const loaded: LoadedCert[] = [];
    const status: { host: string; problem?: string }[] = [];
    for (const c of certs ?? []) {
      const r = loadClientCertificate(c);
      status.push(r.problem ? { host: r.host, problem: r.problem } : { host: r.host });
      if (r.cert) loaded.push(r.cert);
    }
    this.certs = loaded;
    this.certStatus = status;
    // CONTRACTS §20.1: a host that now has a certificate is decrypted again (the proxy presents it).
    if (loaded.length) this.learn.hosts.forget((e) => e.reason === 'client-certificate' && !!this.certFor(e.host, e.port));
    return status.map((x) => ({ ...x }));
  }

  /** Status of the configured client certificates (see setClientCertificates). */
  get clientCertificates(): { host: string; problem?: string }[] {
    return this.certStatus.map((x) => ({ ...x }));
  }

  private checkUpstreamLoop(spec: UpstreamProxySpec): void {
    // Normalised (REVIEW-6 #12): `localhost.`, `[::ffff:127.0.0.1]`, 127/8, ::1, 0.0.0.0 all mean this machine.
    const host = normalizeIp(spec.host.replace(/\.+$/, ''));
    const self = isLoopbackHost(spec.host) || host === this.lanGate?.address?.host || host === normalizeIp(this.host) || lanIPv4Addresses().includes(host);
    const ours = [this._port, this.lanGate?.address?.port].filter((p): p is number => !!p);
    if (self && ours.includes(spec.port)) {
      throw new Error(`Upstream proxy ${spec.label} is Flutter Intercept itself; that would loop`);
    }
  }

  /** Upstream-proxy agents for a LAN gate's sockets: the final target is resolved and checked before CONNECT. */
  private lanUpstreamAgents(gate: LanGate): UpstreamAgents | undefined {
    const spec = this.upstreamSpec;
    const have = this.lanUpstream.get(gate);
    if (have && have.spec === spec) return have;
    retireAgents(have);
    if (!spec) {
      this.lanUpstream.delete(gate);
      return undefined;
    }
    const agents = createUpstreamAgents(spec, (host, port) => {
      if (gate.closed) return Promise.reject(Object.assign(new Error(`${SSRF_MARKER}: LAN mode is off.`), { statusCode: 403 }));
      return resolveCheckedTarget(host, port, gate.host);
    });
    this.lanUpstream.set(gate, agents);
    return agents;
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
    if (r.grpc !== undefined) return this.grpc.sendGrpc(r, method, u, headers);
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
    return this.book.getExchanges();
  }

  /**
   * Store a read-only exchange that did not go through the proxy (CONTRACTS §11.4): e.g. a native client's
   * request read from the app's HTTP profile. `captured` defaults to 'vm-profile'. It is stored and evicted
   * like any other exchange and emits 'exchange', but is never routed, never matched against rules, never
   * CORS-diagnosed. Bodies are capped like recorded ones (5 MB of text), frames at maxFramesPerExchange.
   * Returns its id. Throws on a missing method / URL.
   */
  record(input: Omit<Exchange, 'id'>): string {
    return this.book.record(input);
  }

  /**
   * Change a record() exchange (a pending native request that completed, more frames…): fields in `patch`
   * replace the stored ones, `undefined` removes one; `id` can't change. Emits 'exchange'. Returns false (and
   * does nothing) for an id that is not a record or was evicted / cleared.
   */
  update(id: string, patch: Partial<Omit<Exchange, 'id'>>): boolean {
    return this.book.update(id, patch);
  }

  /**
   * Drops finished exchanges (no 'removed' event — the host sends 'cleared'). In-flight ones
   * (pending / paused) are kept: the app is still waiting and a paused one must stay resumable,
   * so the host should send a fresh snapshot (getExchanges()) after clearing.
   */
  clear(): void {
    this.book.clear();
  }

  /**
   * Resume a paused exchange, optionally with an edit (RequestEdit for paused-request,
   * ResponseEdit for paused-response). No-op if the id is not paused (already resumed, timed out,
   * or the client went away). Throws on an invalid edit (bad URL / status, or a body edit of a body
   * that is too large to have been shown in full), leaving it paused.
   */
  resume(id: string, edit?: RequestEdit | ResponseEdit | GrpcEdit): void {
    const p = this.paused.get(id);
    if (!p) return;
    const ex = this.book.live.get(id)?.ex;
    if (ex?.kind === 'grpc') {
      // CONTRACTS §17.2: a held message takes {message} / {drop}; the end of the call {status, trailers}.
      const kind = ex.grpcPause?.kind ?? 'message';
      const why = grpcEditProblem(kind, edit);
      if (why) throw new Error(why);
      const msg = (edit as GrpcEdit | undefined)?.message;
      if (msg !== undefined && Buffer.from(msg, 'base64').length > (grpcHookTesting.hookCap ?? GRPC_HOOK_CAP_BYTES)) {
        throw new Error('The replacement message is over 4 MB.');
      }
    } else if (edit) validateEdit(p.phase, edit as RequestEdit | ResponseEdit, ex);
    p.settle({ kind: 'resume', edit: edit as RequestEdit | ResponseEdit });
  }

  /** Abort a paused exchange: the client's connection is reset, state 'aborted'. No-op if not paused. */
  abort(id: string): void {
    this.paused.get(id)?.settle({ kind: 'abort' });
  }

  override on(event: 'exchange', listener: (e: Exchange) => void): this;
  override on(event: 'removed', listener: (ids: string[]) => void): this;
  override on(event: 'lan-peer', listener: (ip: string) => void): this;
  /** CONTRACTS §16.8: the app's gRPC connections to `authority` went direct for 30 s (the entry's breaker). */
  override on(event: 'grpcBreaker', listener: (e: GrpcBreakerEvent) => void): this;
  /** CONTRACTS §20.1: the learned passthrough hosts changed (the whole list, as `learnedPassthrough`). */
  override on(event: 'learnedPassthrough', listener: (list: LearnedPassthrough[]) => void): this;
  override on(event: 'rule-spent', listener: (ruleId: string, reason: 'times' | 'expired') => void): this;
  /** `step`: sequence rules only (CONTRACTS §12.3), 0-based index of the step that answered, -1 = after the steps. */
  override on(event: 'rule-hit', listener: (ruleId: string, used: number, step?: number) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  // ---------------------------------------------------------------- request → source

  /** Preprocessing: take x-fi-id / x-fi-send off the request (headers and raw headers) and remember them. */
  private takeInternalHeaders(req: OngoingRequest): void {
    const raw = requestInternals(req).rawHeaders;
    if (!Array.isArray(raw)) return;
    let traceId: string | undefined;
    let sendNonce: string | undefined;
    let hop: string | undefined;
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
      // CONTRACTS §16.2: the silent-tunnel headers mean something on a CONNECT only, and never go upstream.
      if (name === SILENT_TUNNEL_HEADER || name === CONNECT_TIMEOUT_HEADER || name === INTERNAL_TUNNEL_HEADER) return false;
      if (name === HOP_HEADER) {
        hop ??= String(pair[1]).trim();
        return false;
      }
      return true;
    });
    if (kept.length === raw.length) return;
    requestInternals(req).rawHeaders = kept;
    deleteHeader(req.headers as HeaderBag, TRACE_HEADER);
    deleteHeader(req.headers as HeaderBag, SEND_HEADER);
    deleteHeader(req.headers as HeaderBag, SILENT_TUNNEL_HEADER);
    deleteHeader(req.headers as HeaderBag, CONNECT_TIMEOUT_HEADER);
    deleteHeader(req.headers as HeaderBag, INTERNAL_TUNNEL_HEADER);
    deleteHeader(req.headers as HeaderBag, HOP_HEADER);
    const meta: ReqMeta = {};
    if (traceId && TRACE_ID_RE.test(traceId)) meta.traceId = traceId;
    if (sendNonce) meta.sendNonce = sendNonce;
    if (hop) meta.hop = hop;
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
            const ex = this.book.store.get(id);
            if (info && ex && !ex.source) {
              ex.source = info;
              this.book.emitChange(ex);
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
      if (o.grpc) {
        // CONTRACTS §16.2: other actions never match a gRPC call; the next rule is tried.
        if (op !== undefined) continue;
        if (!grpcApplicable(rule.action)) {
          const a = rule.action;
          const what = a?.kind === 'sequence' ? 'Sequence rule (a step that is not grpcMock, block, fault, throttle or passthrough)' : `${capitalize(String(a?.kind ?? 'unknown'))} rule`;
          note ??= `${what}${rule.name ? ` "${rule.name}"` : ''} does not apply to gRPC calls; the next rule was tried.`;
          continue;
        }
      } else if (rule.action?.kind === 'grpcMock' && !o.grpcWeb) continue; // gRPC (and gRPC-Web) calls only
      if (op !== undefined && !o.ignoreGraphql) {
        if (o.ws || o.tunnel) continue; // the operation of a subscription is inside the frames
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
      if (o.tunnel) {
        const a = rule.action;
        if ((a.kind !== 'block' && a.kind !== 'fault') || (a.kind === 'fault' && a.fault === 'truncate')) {
          const what = a.kind === 'fault' ? 'The truncate fault' : `${capitalize(a.kind)} rule`;
          note ??= `${what}${rule.name ? ` "${rule.name}"` : ''} does not apply to TLS passthrough tunnels (not decrypted); passed through.`;
          continue;
        }
      }
      if (o.ws) {
        const a = rule.action;
        if (!WEBSOCKET_ACTIONS.has(a.kind) || (a.kind === 'fault' && a.fault === 'truncate')) {
          const what = a.kind === 'fault' ? 'The truncate fault' : `${capitalize(a.kind)} rule`;
          note ??= `${what}${rule.name ? ` "${rule.name}"` : ''} does not apply to WebSocket connections; passed through.`;
          continue;
        }
      }
      // CONTRACTS §12.3: a sequence rule answers with its current step (the position advances when counted).
      let action: Applied;
      let step: number | undefined;
      if (rule.action?.kind === 'sequence') {
        let st = this.seq.get(rule.id);
        if (!st) this.seq.set(rule.id, (st = { sig: sequenceSig(rule), n: 0 }));
        const pick = pickSequenceStep(rule.action, st.n);
        if (o.count) st.n++;
        action = pick.action;
        step = pick.index;
        if (pick.invalid) note ??= pick.invalid;
        if (!o.grpc && !o.grpcWeb && action?.kind === 'grpcMock') {
          action = undefined;
          note ??= `Sequence step ${step + 1} (grpcMock) applies to gRPC calls only; the request was passed through.`;
        }
      } else {
        action = rule.action;
      }
      if (o.count && (rule.times !== undefined || step !== undefined)) {
        let used = this.seq.get(rule.id)?.n ?? 0;
        if (rule.times !== undefined) {
          used = (this.hits.get(rule.id) ?? 0) + 1;
          this.hits.set(rule.id, used);
          if (used >= rule.times) this.markSpent(rule.id, 'times');
        }
        const id = rule.id;
        // host shows "N of M left" (Rule.used); sequences also report the step (0-based, -1 = after the steps).
        if (step === undefined) process.nextTick(() => this.emit('rule-hit', id, used));
        else process.nextTick(() => this.emit('rule-hit', id, used, step));
      }
      return { rule, action, step, note };
    }
    return { note };
  }

  /** CONTRACTS §20.1: the first enabled, unspent rule whose URL pattern names `host` (patternNamesHost). */
  private ruleNamingHost(host: string, port: number): Rule | undefined {
    const now = Date.now();
    for (const { rule } of this.compiled) {
      if (rule.enabled && !this.spentReason(rule, now) && patternNamesHost(rule.match?.url ?? '', host, port)) return rule;
    }
    return undefined;
  }

  /** Could a rule from index `from` on (method + URL match) need the response hook? */
  private responseHookFrom(from: number, method: string, url: string, now: number): boolean {
    for (let i = from; i < this.compiled.length; i++) {
      const { rule, base } = this.compiled[i];
      if (!rule.enabled || this.spentReason(rule, now) || !base(method, url)) continue;
      if (needsResponseHook(rule.action)) return true;
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
    const since = ex.pausedAt;
    return decision.then((d) => {
      delete ex.pausedAt;
      delete ex.pauseDeadline;
      this.book.addPhase(ex, 'pausedMs', Date.now() - since);
      return d;
    });
  }

  // ---------------------------------------------------------------- routing

  /** Called (synchronously) by the route matchers of every rule; decided once per request. */
  private decide(req: OngoingRequest): Flow {
    const known = this.book.flows.get(req.id);
    if (known) return known;
    if (this.unauthorized.has(req)) return DENIED_FLOW; // never recorded
    if (isTraceUrl(req.url)) return TRACE_FLOW; // answered locally, never recorded, never throttled
    if (this.grpcCheck.ok && isGrpcCall(req)) return this.grpc.decideGrpc(req);
    const meta = this.reqMeta.get(req);
    const send = meta?.sendNonce ? this.sends.get(meta.sendNonce) : undefined;
    const headers = req.headers as HeaderBag;
    let flow: Flow | undefined;
    // CONTRACTS §11.3: a CORS preflight for a request a mock / block / cors rule would handle is answered
    // here (the rule isn't spent by it). Otherwise the OPTIONS request is matched like any other.
    const asked = preflightMethod(req.method, headers);
    // CONTRACTS §19.1: gRPC-Web (by content-type; a preflight for one asks for the x-grpc-web header).
    const web = grpcWebVariant(headers['content-type']);
    if (asked) {
      const askedWeb = /(^|,)\s*x-grpc-web\s*(,|$)/i.test(getHeader(headers, 'access-control-request-headers') ?? '');
      const pm = this.matchRule(asked, req.url, { count: false, ignoreGraphql: true, grpcWeb: askedWeb });
      const pre = pm.rule;
      const a = pm.action;
      if (pre && a && (a.kind === 'mock' || a.kind === 'block' || a.kind === 'cors' || a.kind === 'grpcMock')) {
        const o = a.kind === 'cors' ? corsOptions(a) : {};
        // Only for an origin the proxy may allow (loopback, or the cors rule's allowOrigin): otherwise the
        // server answers its own preflight (REVIEW-5 #3).
        if (allowedOrigin(headers, o)) flow = { route: 'h1', rule: pre, action: a, preflight: true, ...(a.kind === 'cors' ? { corsPatch: o } : {}) };
      }
    }
    if (!flow) {
      const m = this.matchRule(req.method, req.url, { count: true, headers, ...(web ? { grpcWeb: true } : {}) });
      if (m.deferred) flow = { route: m.needsResponseHook ? 'h2' : 'h1', deferred: true, ...(m.note ? { note: m.note } : {}) };
      else if (!m.rule && this.replayStore) {
        // CONTRACTS §12.4: rules first, then the recording.
        const body: BodyKey = !hasRequestBody(headers) ? {} : bodyLimitReason(headers) ? 'unreadable' : 'unknown';
        flow = this.replayFlow(req.method, req.url, headers, body, m.note);
      } else flow = this.flowFor(req.url, headers, m.rule, m.action, m.note, m.step);
    }
    // Map Remote / request-header rewrites change the request itself, before the LAN deny rule (next matcher) and
    // the passthrough read it: the SSRF guard then checks the MAPPED target.
    if ((flow.map || flow.rewrite?.request) && !flow.fault && !flow.localError) this.applyRequestSide(req, flow);
    const refused = this.forwards(flow) && !flow.deferred ? this.certRefusal(flow.map?.url ?? req.url, headers) : undefined;
    if (refused) flow = { route: 'h1', ...(flow.rule ? { rule: flow.rule } : {}), refused };
    if (meta?.traceId) flow.traceId = meta.traceId;
    if (send) flow.send = send;
    // Keyed on the socket, like every LAN guard (also for requests inside a LAN CONNECT tunnel).
    const socket = requestInternals(req).socket;
    if (lanGateOf(socket)) flow.viaLan = true;
    if (socket && typeof socket === 'object') this.connRequest.set(socket, req.id);
    // CONTRACTS §20.1: the app's keep-alive connections per server, closed when the server is learned.
    const dest = (req as { destination?: { hostname?: string; port?: number } }).destination;
    if (req.protocol === 'https' && dest?.hostname && dest.port && String(req.httpVersion).startsWith('1')) {
      this.learn.trackConnection(socket, normalizeHostname(dest.hostname), dest.port);
    }
    flow.te = requestInternals(req).timingEvents;
    const latency = flow.throttle?.latencyMs;
    if (flow.route === 'plain' && latency && latency > 0) {
      // Before forwarding, without reading the body: the route matcher waits on this.
      const from = performance.now();
      flow.delay = sleep(latency).then(() => {
        const live = this.book.live.get(req.id);
        if (live) this.book.addPhase(live.ex, 'delayMs', performance.now() - from);
        return !!live;
      });
    }

    if (web && !flow.preflight) {
      flow.grpcWeb = web;
      if (flow.action?.kind === 'mutate') {
        // Mutate edits JSON bodies: no effect on protobuf frames (CONTRACTS §19.1).
        const rule = flow.rule;
        flow = this.flowFor(req.url, headers, rule, undefined, 'Mutate rules edit JSON bodies; this gRPC-Web call was passed through unchanged.');
        flow.grpcWeb = web;
        if (meta?.traceId) flow.traceId = meta.traceId;
        if (send) flow.send = send;
        if (lanGateOf(socket)) flow.viaLan = true;
        flow.te = requestInternals(req).timingEvents;
      }
    }
    this.book.flows.set(req.id, flow);
    this.taps.wireTap(req, flow);
    if (flow.grpcWeb) this.grpcWeb.watchGrpcWeb(req, flow.grpcWeb);
    return flow;
  }

  /**
   * The flow for a chosen rule (or none) and the action it applies (a sequence rule's current step; undefined =
   * pass through): its route, plus the network profile and drop rate.
   */
  private flowFor(url: string, headers: HeaderBag, rule: Rule | undefined, action: Applied, note?: string, step?: number): Flow {
    let flow: Flow;
    let dropRate: number | undefined;
    if (!action) {
      flow = rule ? { route: 'plain', rule } : { route: 'plain' };
    } else if (action.kind === 'fault') {
      // truncate forwards and cuts the response (streaming route); the others never reach the server.
      flow = { route: action.fault === 'truncate' ? 'plain' : 'h1', rule, action, fault: action.fault, simulated: FAULT_LABELS[action.fault] };
    } else if (action.kind === 'throttle') {
      flow = { route: 'plain', rule, action, throttle: { latencyMs: action.latencyMs, kbps: action.kbps, uploadKbps: action.uploadKbps }, simulated: throttleLabel(action) };
      dropRate = action.dropRate;
    } else if (action.kind === 'cors') {
      // Streams like a pass-through; the taps patch the response head (CONTRACTS §11.3).
      flow = { route: 'plain', rule, action, corsPatch: corsOptions(action) };
    } else if (action.kind === 'mapRemote') {
      // Streams like a pass-through, to another server (CONTRACTS §12.6).
      try {
        const target = mapRemoteUrl(url, rule?.match.url ?? '', action.to);
        const t = new URL(target);
        const host = action.preserveHost ? (getHeader(headers, 'host') ?? new URL(url).host) : t.host;
        flow = { route: 'plain', rule, action, map: { url: target, host }, originalUrl: url, simulated: `Mapped to ${t.origin}` };
      } catch (e) {
        flow = { route: 'h1', rule, action, localError: `Map Remote rule${rule?.name ? ` "${rule.name}"` : ''}: ${(e as Error).message}` };
      }
    } else if (action.kind === 'rewrite') {
      const rw = rewriteFlow(action);
      let route: Route = rw.resBody ? 'h2' : rw.reqBody ? 'h1' : 'plain';
      let why: string | undefined;
      if ((rw.reqBody || rw.resBody) && (why = bodyLimitReason(headers))) {
        // A hooked route would buffer the request body: only headers / status are rewritten.
        rw.reqBody = rw.resBody = false;
        route = 'plain';
        note ??= `Rewrite rule: body replacement skipped: ${why} (headers and status were still rewritten).`;
      }
      flow = { route, rule, action, rewrite: rw, simulated: rewriteLabel(rw) };
    } else if (action.kind === 'script') {
      // CONTRACTS §13.4: hooked like a request breakpoint (onRequest gets the body), and buffered like a response
      // breakpoint when the script may define onResponse. A body that can't be held skips the script.
      const why = bodyLimitReason(headers);
      flow = why
        ? { route: 'plain', rule, note: `Script skipped: ${why}, so it was passed through unchanged.` }
        : { route: mentionsOnResponse(action.code) ? 'h2' : 'h1', rule, action };
    } else if (action.kind !== 'breakpoint' && action.kind !== 'mutate') {
      flow = { route: 'h1', rule, action };
    } else {
      // Breakpoints and mutate rules run on hooked routes, where mockttp buffers the request body
      // before forwarding it. Only do that when the size is known and small; mockttp would otherwise
      // drop data past maxBodySize. (The mutate rule's response side never needs this; its request does.)
      const what = action.kind === 'mutate' ? 'Mutate rule' : 'Breakpoint';
      const why = bodyLimitReason(headers);
      flow = why
        ? { route: 'plain', rule, note: `${what} skipped: ${why}, so it was passed through unedited.` }
        : { route: action.kind === 'breakpoint' && action.phase === 'request' ? 'h1' : 'h2', rule, action };
    }
    if (note && !flow.note) flow.note = note;

    // The network profile: everything that would reach the network (no rule, breakpoints, mutate, cors, map,
    // rewrite and throttle rules — whose own settings win over a throttle profile). Mock / block / fault answer as set.
    const k = action?.kind;
    const reachesNetwork =
      !action || k === 'breakpoint' || k === 'mutate' || k === 'throttle' || k === 'cors' || k === 'mapRemote' || k === 'rewrite' || k === 'script';
    const p = this.profile;
    if (reachesNetwork && !flow.localError && p.kind === 'offline') {
      flow = { route: 'h1', rule, fault: 'dns', simulated: describeProfile(p) };
      dropRate = undefined;
    } else if (reachesNetwork && !flow.localError && p.kind === 'throttle' && k !== 'throttle') {
      flow.throttle = { latencyMs: p.latencyMs, kbps: p.kbps, uploadKbps: p.uploadKbps };
      flow.simulated = flow.simulated ? `${profileLabel(p)} · ${flow.simulated}` : profileLabel(p);
      dropRate = p.dropRate;
    }
    if (dropRate && dropRate > 0 && Math.random() < dropRate) {
      // Reset instead (after the latency, like a flaky link), never forwarded.
      flow = { route: 'h1', rule, fault: 'drop', throttle: { latencyMs: flow.throttle?.latencyMs }, simulated: `${flow.simulated ?? 'Throttle'}: dropped` };
    }
    if (step !== undefined && rule?.action.kind === 'sequence') {
      flow.step = step;
      const n = rule.action.steps?.length ?? 0;
      const label = step < 0 ? 'Sequence done: passed through' : `Sequence step ${step + 1}/${n}`;
      flow.simulated = flow.simulated ? `${label} · ${flow.simulated}` : label;
    }
    return flow;
  }

  /** No rule matched while replaying (CONTRACTS §12.4): the recorded response, or the fallback. */
  private replayFlow(method: string, url: string, headers: HeaderBag, body: BodyKey, note?: string): Flow {
    const store = this.replayStore!;
    const hit = store.lookup(method, url, body, true);
    // CONTRACTS §14.5: recorded event streams are written event by event (route replay-stream, onReplayStream).
    if (hit === 'needs-body') return { route: store.hasStream(method, url) ? 'replay-stream' : 'h1', replay: 'deferred', ...(note ? { note } : {}) };
    if (hit && hit.entry.kind !== 'websocket') {
      return { route: hit.entry.kind === 'sse' ? 'replay-stream' : 'h1', replay: hit.entry, simulated: `Replayed from ${store.name ?? 'a recording'}`, ...(note ? { note } : {}) };
    }
    if (store.fallback === 'fail') {
      // Like the offline profile: closed without a response inside the tunnel, so dart:io has no DIRECT to fall back to.
      return { route: 'h1', fault: 'dns', simulated: `Not in the recording${store.name ? ` "${store.name}"` : ''} (replay: fail)`, ...(note ? { note } : {}) };
    }
    return this.flowFor(url, headers, undefined, undefined, note);
  }

  /**
   * Map Remote and request-header rewrites, applied to the request itself (decide(), synchronously, before the LAN
   * deny rule's matcher and before the passthrough reads method, URL, destination and headers). On hooked routes
   * the Host header is left to mockttp (it derives it from the URL) and onRequest returns a different one if needed.
   */
  private applyRequestSide(req: OngoingRequest, flow: Flow): void {
    const r = requestInternals(req);
    if (flow.map) {
      const t = new URL(flow.map.url);
      try {
        r.url = t.href;
        r.protocol = t.protocol.slice(0, -1);
        r.path = `${t.pathname}${t.search}`;
        r.destination = { hostname: t.hostname.replace(/^\[|\]$/g, ''), port: Number(t.port) || (t.protocol === 'https:' ? 443 : 80) };
      } catch {
        /* checked below */
      }
      if (r.url !== t.href) {
        flow.localError = 'Map Remote could not change the request target (incompatible mockttp version).';
        flow.route = 'h1';
        return;
      }
    }
    let pairs = (Array.isArray(r.rawHeaders) ? r.rawHeaders : []).slice();
    if (flow.rewrite?.request) pairs = rewritePairs(pairs, rewriteSets(flow.rewrite.request));
    const urlHost = new URL(r.url).host;
    const want = rewriteHostOf(flow.rewrite?.request) ?? flow.map?.host ?? pairValue(pairs, 'host') ?? urlHost;
    // Plain route: the raw headers are forwarded as they are. Hooked routes: mockttp sets Host from the URL unless
    // beforeRequest returns another one (onRequest does, from wantHost).
    const send = flow.route === 'plain' ? want : urlHost;
    if (flow.route !== 'plain' && want !== urlHost) flow.wantHost = want;
    if (pairValue(pairs, 'host') !== send) pairs = rewritePairs(pairs, { remove: ['host'], set: [['Host', send]] });
    r.rawHeaders = pairs;
    const obj = pairsToObject(pairs);
    for (const k of Object.keys(r.headers)) if (!(k in obj)) delete r.headers[k];
    Object.assign(r.headers, obj);
    flow.reqApplied = true;
  }

  // ---------------------------------------------------------------- hooked paths (h1 / h2)

  private async onRequest(req: CompletedRequest): Promise<CallbackRequestResult | void> {
    let flow = this.book.flows.get(req.id);
    if (!flow) {
      const m = this.matchRule(req.method, req.url, { count: false });
      flow = { route: 'h1', rule: m.rule, action: m.action };
    }
    const tap = getTap(req.id);
    // For breakpoints / deferred GraphQL rules the body is complete (≤ 5 MB); for mock/block it may be a capped prefix.
    const body = tap
      ? await decodeForDisplay(captured(tap.req), getHeader(req.headers, 'content-encoding'), isComplete(tap.req))
      : await decodeForDisplay(req.body.buffer, getHeader(req.headers, 'content-encoding'), true);
    const bodyKey = (): BodyKey => (body?.truncated ? 'unreadable' : { hash: requestBodyHash(body) });
    let resolved: Flow | undefined;
    if (flow.deferred) {
      // CONTRACTS §11.2: choose the rule now that the operation name can be read.
      const text = body && body.encoding === 'utf8' && !body.truncated ? body.text : undefined;
      const m = this.matchRule(req.method, req.url, { count: true, body: () => text, ...(flow.grpcWeb ? { grpcWeb: true } : {}) });
      const note = m.note ?? flow.note;
      resolved =
        !m.rule && this.replayStore
          ? this.replayFlow(req.method, req.url, req.headers as HeaderBag, bodyKey(), note)
          : this.flowFor(req.url, req.headers as HeaderBag, m.rule, m.action, note, m.step);
    } else if (flow.replay === 'deferred') {
      // CONTRACTS §12.4: the recording has responses for this URL that depend on the request body.
      resolved = this.replayFlow(req.method, req.url, req.headers as HeaderBag, bodyKey(), flow.note);
    }
    if (resolved) {
      flow.deferred = false;
      Object.assign(flow, {
        rule: resolved.rule,
        action: resolved.action,
        step: resolved.step,
        note: resolved.note,
        fault: resolved.fault,
        throttle: resolved.throttle,
        simulated: resolved.simulated,
        corsPatch: resolved.corsPatch,
        map: resolved.map,
        originalUrl: resolved.originalUrl,
        rewrite: resolved.rewrite,
        replay: resolved.replay === 'deferred' ? undefined : resolved.replay,
        localError: resolved.localError,
      });
      if (tap) this.taps.applyShaping(tap, flow);
      if (this.forwards(flow)) flow.refused = this.certRefusal(flow.map?.url ?? req.url, req.headers as HeaderBag);
    }
    const ex = this.book.newExchange(req, flow);
    this.book.setRequestBody(ex, body);
    flow.te ??= req.timingEvents;
    this.book.setRequestMs(ex, flow.te, flow.te?.bodyReceivedTimestamp ?? performance.now());
    const action = flow.action;

    if (flow.preflight) return this.edits.answerPreflight(req, ex, flow);

    if (flow.refused) {
      this.book.track(ex, flow);
      const headers: HeaderBag = { 'content-type': 'text/plain; charset=utf-8' };
      const text = `Flutter Intercept: ${flow.refused}`;
      ex.status = 403;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = { text, encoding: 'utf8' };
      ex.error = flow.refused;
      this.book.finish(ex, 'blocked');
      return { response: { statusCode: 403, statusMessage: STATUS_CODES[403], headers, rawBody: frameBody(Buffer.from(text, 'utf8'), headers) } };
    }

    if (flow.fault && flow.fault !== 'truncate') return this.edits.applyFault(ex, flow);

    if (flow.localError) {
      this.book.track(ex, flow);
      return { response: this.edits.localFailure(ex, flow.localError) };
    }

    if (flow.replay && flow.replay !== 'deferred') return this.replays.answerReplay(ex, flow, flow.replay);

    if (action?.kind === 'grpcMock' && flow.grpcWeb) return this.grpcWeb.answerGrpcWeb(ex, flow, action);

    if (action?.kind === 'mock') {
      this.book.track(ex, flow);
      if (action.delayMs && action.delayMs > 0) {
        const from = performance.now();
        await sleep(action.delayMs);
        this.book.addPhase(ex, 'delayMs', performance.now() - from);
        if (ex.state !== 'pending') return { response: 'close' }; // client left during the delay
      }
      const headers: HeaderBag = { ...(action.headers ?? {}) };
      this.edits.addCorsToLocalResponse(ex, headers);
      const decoded = Buffer.from(action.body ?? '', 'utf8');
      const rawBody = frameBody(decoded, headers);
      ex.status = action.status;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = await decodeForDisplay(decoded, undefined, true);
      if (isEventStream(getHeader(headers, 'content-type'))) this.taps.setSseFrames(ex, decoded);
      this.book.finish(ex, 'mocked');
      return {
        response: { statusCode: action.status, statusMessage: STATUS_CODES[action.status], headers, rawBody },
      };
    }

    if (action?.kind === 'block') {
      this.book.track(ex, flow);
      if (action.mode === 'reset') {
        this.book.finish(ex, 'blocked');
        return { response: 'reset' };
      }
      if (flow.grpcWeb) {
        // CONTRACTS §19.1: a gRPC-Web block answers trailers-only UNAVAILABLE (the browser client reads the status).
        const h: HeaderBag = { 'content-type': grpcWebContentType(flow.grpcWeb), 'grpc-status': '14', 'grpc-message': encodeGrpcMessage(BLOCK_BODY), 'content-length': '0' };
        this.grpcWeb.addGrpcWebCors(ex, h);
        ex.status = 200;
        ex.responseHeaders = cleanHeaders(h);
        if (ex.grpc) Object.assign(ex.grpc, { statusCode: 14, statusMessage: BLOCK_BODY, trailersOnly: true as const });
        this.book.finish(ex, 'blocked');
        return { response: { statusCode: 200, statusMessage: STATUS_CODES[200], headers: h, rawBody: Buffer.alloc(0) } };
      }
      const status = action.status ?? 403;
      const headers: HeaderBag = { 'content-type': 'text/plain; charset=utf-8' };
      this.edits.addCorsToLocalResponse(ex, headers);
      const decoded = Buffer.from(BLOCK_BODY, 'utf8');
      const rawBody = frameBody(decoded, headers);
      ex.status = status;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = { text: BLOCK_BODY, encoding: 'utf8' };
      this.book.finish(ex, 'blocked');
      return { response: { statusCode: status, statusMessage: STATUS_CODES[status], headers, rawBody } };
    }

    if (action?.kind === 'script') return this.edits.scriptRequest(req, ex, flow, action, body);

    if (action?.kind === 'breakpoint' && action.phase !== 'response') {
      const decision = this.pause(ex, 'request');
      this.book.track(ex, flow);
      const d = await decision;
      if (d.kind === 'abort') {
        this.book.finish(ex, 'aborted');
        return { response: 'reset' };
      }
      if (d.kind === 'gone') return { response: 'close' };
      const result = await this.edits.applyRequestEdit(req, ex, d.edit as RequestEdit | undefined);
      ex.state = 'pending';
      this.book.emitChange(ex);
      if (!(await this.edits.latency(ex, flow))) return { response: 'close' };
      return result;
    }

    this.book.track(ex, flow);
    if (!(await this.edits.latency(ex, flow))) return { response: 'close' };
    if (flow.map || flow.rewrite?.request || flow.wantHost) return this.edits.forwardChanges(req, ex, flow);
    return undefined;
  }

  private async onResponse(res: PassThroughResponse, req: CompletedRequest): Promise<CallbackResponseResult | void> {
    const live = this.book.live.get(res.id ?? req.id);
    if (!live) return undefined;
    const { ex, flow } = live;
    if (ex.state !== 'pending') return 'close'; // client already gone

    ex.status = res.statusCode;
    ex.responseHeaders = cleanHeaders(res.headers);
    // Complete upstream body, ≤ RESPONSE_PAUSE_LIMIT_BYTES (src/taps.ts); display capped at 5 MB.
    ex.responseBody = await decodeForDisplay(res.body.buffer, getHeader(res.headers, 'content-encoding'), true);

    let result: CallbackResponseMessageResult | undefined;
    const action = flow.action;
    if (action?.kind === 'breakpoint' && action.phase !== 'request') {
      const decision = this.pause(ex, 'response');
      this.book.emitChange(ex);
      const d = await decision;
      if (d.kind === 'abort') {
        this.book.finish(ex, 'aborted');
        return 'reset';
      }
      if (d.kind === 'gone') return 'close';
      result = await this.edits.applyResponseEdit(res, ex, d.edit as ResponseEdit | undefined);
    } else if (action?.kind === 'script') {
      const r = await this.edits.scriptResponse(res, ex, flow, action);
      if (r === 'close' || r === 'reset') return r;
      if (!this.book.live.has(ex.id)) return r; // failed: the 502 replaces the response
      result = r;
    } else if (action?.kind === 'mutate') {
      result = await this.edits.applyMutation(res, ex, action.ops);
      if (!this.book.live.has(ex.id) || ex.state !== 'pending') return 'close'; // the app left meanwhile
    } else if (flow.rewrite?.response) {
      result = await this.edits.applyRewriteResponse(res, ex, flow.rewrite);
      if (!this.book.live.has(ex.id) || ex.state !== 'pending') return 'close';
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
      this.taps.setSseFrames(ex, (await decodeFull(res.body)) ?? Buffer.alloc(0));
    }
    if (flow.fault === 'truncate') return result; // onTruncated finishes it once the cut happens
    this.book.finish(ex, 'completed');
    return result;
  }

  // ---------------------------------------------------------------- client certificates (CONTRACTS §14.3)

  /** The first usable certificate for a server. */
  private certFor(hostname: string, port: number): LoadedCert | undefined {
    return this.certs.find((c) => matchesHostPattern(c.pattern, hostname, port));
  }

  /** mockttp's clientCertificateHostMap lookup: "host:port" → TLS options (pfx / cert + key, passphrase). */
  private certOptions(key: string): LoadedCert['options'] | undefined {
    const i = key.lastIndexOf(':');
    if (i <= 0 || !/^\d+$/.test(key.slice(i + 1))) return undefined;
    return this.certFor(key.slice(0, i), Number(key.slice(i + 1)))?.options;
  }

  /** Does this flow (as decided so far) send the request to a server? */
  private forwards(flow: Flow): boolean {
    if (flow.fault || flow.localError || flow.preflight || flow.refused || flow.replay) return false;
    if (flow.route !== 'plain' && flow.route !== 'h1' && flow.route !== 'h2') return false;
    const k = flow.action?.kind;
    return k !== 'mock' && k !== 'block';
  }

  /**
   * REVIEW-8 #1: a client certificate is presented for the app's traffic only. A request to a certificate host that
   * carries an `Origin` other than a loopback one (http(s)://localhost / 127.0.0.1 / [::1], any port: the Flutter
   * Web dev server) comes from a web page — a third-party frame, an ad, another site open in the debug Chrome — and is
   * refused (403) before any upstream connection. Requests without `Origin` (dart:io, native) are the app's.
   */
  private certRefusal(url: string, headers: HeaderBag): string | undefined {
    if (!this.certs.length) return undefined;
    const origin = getHeader(headers, 'origin');
    if (origin === undefined || isLoopbackOrigin(origin)) return undefined;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'wss:') return undefined;
    const port = Number(u.port) || 443;
    return this.certFor(u.hostname, port) ? certRefusalText(u.hostname, origin) : undefined;
  }

  /**
   * The pool asks before each upstream request of our rules (upstream-pool.ts): phase timings, upload pacing
   * (CONTRACTS §14.4), and the client certificate the connection presents (CONTRACTS §14.3).
   */
  private requestPlan(connection: unknown, target: { protocol?: string; hostname?: string; port?: number }): RequestPlan | undefined {
    const id = connection && typeof connection === 'object' ? this.connRequest.get(connection) : undefined;
    if (!id) return undefined;
    const live = this.book.live.get(id);
    const flow = live?.flow ?? this.book.flows.get(id);
    if (live && (target.protocol === 'https:' || target.protocol === 'wss:') && target.hostname) {
      const c = this.certFor(target.hostname, Number(target.port) || 443);
      const origin = getHeader(live.ex.requestHeaders, 'origin');
      if (c && origin !== undefined && !isLoopbackOrigin(origin)) {
        // Backstop (REVIEW-8 #1): a request edited / scripted onto a certificate host after the flow was decided.
        throw Object.assign(new Error(certRefusalText(target.hostname, origin)), { statusCode: 403, statusMessage: 'Forbidden', fiRefuse: true });
      }
      if (c) live.ex.clientCertificate = c.host;
      else delete live.ex.clientCertificate;
    }
    const up = flow?.throttle?.uploadKbps;
    return { timings: (p) => this.book.addTimings(id, p), ...(up && up > 0 ? { uploadKbps: up } : {}) };
  }
}

export { RESPONSE_PAUSE_LIMIT_BYTES };

export { REQUEST_PAUSE_LIMIT_BYTES } from './proxy-util';
export { grpcPinTesting } from './connect-flow';
export { REWRITE_OUTPUT_MAX_BYTES, rewriteOutputBudget } from './rewrite-flow';
export { loadClientCertificate, isLoopbackOrigin } from './client-certs';
export { WS_THROTTLE_QUEUE_MAX } from './ws-flow';
