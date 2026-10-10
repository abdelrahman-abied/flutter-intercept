import { EventEmitter } from 'events';
import * as http from 'http';
import { STATUS_CODES } from 'http';
import { randomUUID } from 'crypto';
import * as net from 'net';
import * as tls from 'tls';
// Deep imports on purpose: mockttp's index also loads its admin server and remote client
// (express, GraphQL, body-parser, …), ~2 MB of bundle and ~100 ms of module init we never use.
import type * as mockttp from 'mockttp';
import { MockttpServer } from 'mockttp/dist/server/mockttp-server';
import { generateCACertificate } from 'mockttp/dist/util/certificates';
import { CallbackStep, PassThroughStep } from 'mockttp/dist/rules/requests/request-step-definitions';
import { StepLookup } from 'mockttp/dist/rules/requests/request-step-impls';
import WebSocket from 'ws';
import { PassThroughWebSocketStep, RejectWebSocketStep } from 'mockttp/dist/rules/websockets/websocket-step-definitions';
import { Always } from 'mockttp/dist/rules/completion-checkers';
import { resetOrDestroy } from 'mockttp/dist/util/socket-util';
import type { RequestMatcher } from 'mockttp/dist/rules/matchers';
import type { CompletedBody, CompletedRequest, OngoingRequest, TlsHandshakeFailure } from 'mockttp';

import { isUtf8 } from 'buffer';
import {
  BODY_CAP_BYTES,
  cleanHeaders,
  decodeForDisplay,
  decodeStrict,
  deleteHeader,
  frameBody,
  frameBodyAsync,
  getHeader,
  normalizedEncoding,
  setHeader,
  type HeaderBag,
} from './body';
import {
  compileRules,
  isInvalidMatcher,
  mapRemoteUrl,
  MAX_BODY_REPLACEMENTS,
  pickSequenceStep,
  WEBSOCKET_ACTIONS,
  type CompiledRule,
} from './rules';
import { ReplayStore, requestBodyHash, type BodyKey } from './replay';
import { framePayload, sseEventText, sseSchedule, wsScript, type TimedStep } from './replay-stream';
import { createUpstreamAgents, isLoopbackHost, parseUpstreamProxy, retireAgents, type UpstreamAgents, type UpstreamProxyConfig, type UpstreamProxySpec } from './upstream-proxy';
import { matchesHostPattern, normalizeHostname, parseHostPattern, parseHostPatterns, splitHostPort, type HostPattern } from './hosts';
import { openTunnelUpstream, relay } from './tunnel';
import { isShaped, LinkQueue, type LinkShape } from './pace';
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
import { createUpstreamPool, HOST_ALIASES, type UpstreamPool } from './upstream-pool';
import type { RequestPlan } from './upstream-request';
import { refreshRoutes } from './routes';
import { captured, getTap, installTaps, isComplete, RESPONSE_PAUSE_LIMIT_BYTES, type HeadPatch, type Tap } from './taps';
import {
  checkLanRequest,
  LanGate,
  lanGateOf,
  lanIPv4Addresses,
  lanTargetDenial,
  lanTesting,
  normalizeIp,
  onComboConnection,
  lanConnectAllowed,
  refuse,
  resolveCheckedTarget,
  RESPONSE_407,
  SsrfError,
  SSRF_MARKER,
} from './lan';
import { describeProfile, NO_PROFILE, type NetworkProfile } from './network';
import { mutateBody } from './mutate';
import { isTraceHost, isTraceUrl, parseTraceBody, TraceJoin, TRACE_BODY_MAX, TRACE_HEADER, TRACE_ID_RE, TRACE_PATH } from './trace';
import type { Shaping } from './shaper';
import { elapsed, type TimingPatch, type TimingSink } from './timing';
import {
  mentionsOnResponse,
  readRequestResult,
  readResponseResult,
  sameHeaders,
  scriptRequestOf,
  scriptResponseOf,
  ScriptRunner,
  SCRIPT_LOG_MAX_CHARS,
  SCRIPT_LOG_MAX_LINES,
  type RequestOutcome,
  type ScriptOutcome,
} from './script';
import type {
  Body,
  ClientCertificate,
  Exchange,
  FaultKind,
  Frame,
  InterceptProxyOptions,
  MutateOp,
  ReplayEntry,
  ReplayOptions,
  RequestEdit,
  ResponseEdit,
  RewriteSpec,
  Rule,
  RuleAction,
  SendRequest,
} from './types';

/** The action a request gets: the rule's, or the current sequence step's (undefined = pass through). */
type Applied = Exclude<RuleAction, { kind: 'sequence' }> | undefined;
type RewriteAction = Extract<RuleAction, { kind: 'rewrite' }>;
type ScriptAction = Extract<RuleAction, { kind: 'script' }>;

interface RewriteFlow {
  request?: RewriteSpec;
  response?: RewriteSpec & { status?: number };
  /** Body replacements to apply (false when the body can't be held: streamed / too large). */
  reqBody: boolean;
  resBody: boolean;
}

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
type Route = 'plain' | 'h1' | 'h2' | 'denied' | 'trace' | 'ws-pass' | 'ws-local' | 'replay-stream' | 'ws-replay' | 'tunnel';

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
  throttle?: { latencyMs?: number; kbps?: number; uploadKbps?: number };
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
  // CONTRACTS §12 (v0.6.0)
  /** The action applied: the rule's, or the current sequence step's; undefined = pass through. */
  action?: Applied;
  /** Sequence rules: the step that answers (0-based; -1 = after the steps, passed through). */
  step?: number;
  /** The URL the app asked for, when Map Remote sends the request elsewhere (recorded as the exchange URL). */
  originalUrl?: string;
  /** Map Remote: the URL the request goes to and the Host header it carries. */
  map?: { url: string; host: string };
  rewrite?: RewriteFlow;
  /** Map / request-header rewrites were applied to the request in decide() (else onRequest applies them). */
  reqApplied?: boolean;
  /** Replay: the recorded response to answer with, or 'deferred' (the request body hash is needed first). */
  replay?: ReplayEntry | 'deferred';
  /** Answer 502 with this text (e.g. an unusable Map Remote target). */
  localError?: string;
  /** REVIEW-8 #1: answer 403 with this text — a web page's request to a client-certificate host. */
  refused?: string;
  /** Hooked routes: the Host header to send when it isn't the URL's (preserveHost, a rewritten Host). */
  wantHost?: string;
  /** mockttp's timing events of the request (CONTRACTS §13.2 `requestMs`). */
  te?: RequestTimingEvents;
}

/** The part of mockttp's TimingEvents we read (high-resolution `performance.now()` timestamps). */
interface RequestTimingEvents {
  startTimestamp?: number;
  bodyReceivedTimestamp?: number;
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
  /** A WebSocket upgrade: only block / fault / throttle / mapRemote rules apply, GraphQL-scoped rules never do. */
  ws?: boolean;
  /** A TLS passthrough CONNECT (CONTRACTS §14.2): only block and fault rules apply. */
  tunnel?: boolean;
}

interface MatchResult {
  rule?: Rule;
  /** The action for this request (a sequence rule's current step); undefined = pass through. */
  action?: Applied;
  /** Sequence rules: the step (see Flow.step). */
  step?: number;
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

type ThrottleProfile = Extract<NetworkProfile, { kind: 'throttle' }>;

function throttleLabel(t: { latencyMs?: number; kbps?: number; dropRate?: number; uploadKbps?: number }): string {
  const label = withUpload(describeProfile({ kind: 'throttle', latencyMs: t.latencyMs, kbps: t.kbps, dropRate: t.dropRate }), t.uploadKbps);
  return label === describeProfile(NO_PROFILE) ? 'Throttle' : label;
}

/** describeProfile, plus the upload rate for custom profiles ("+300 ms, 800 kbps, 200 kbps up"). */
function profileLabel(p: ThrottleProfile): string {
  return p.preset ? describeProfile(p) : withUpload(describeProfile(p), p.uploadKbps);
}

function withUpload(label: string, uploadKbps: number | undefined): string {
  if (!uploadKbps || uploadKbps <= 0) return label;
  const up = `${uploadKbps} kbps up`;
  return label === describeProfile(NO_PROFILE) ? up : `${label}, ${up}`;
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
  /** Upstream sockets of open passthrough tunnels (destroyed by stop()). */
  private readonly tunnelSockets = new Set<net.Socket>();
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
  /** CONTRACTS §14.5: answers replayed WebSocket upgrades; the subprotocol each recorded connection chose. */
  private wsReplayServer?: WebSocket.Server;
  private readonly wsReplayProtocols = new WeakMap<object, string>();

  constructor(private readonly opts: InterceptProxyOptions) {
    super();
    this.host = opts.host ?? '127.0.0.1';
    this.maxExchanges = Math.max(1, Math.floor(opts.maxExchanges ?? DEFAULT_MAX_EXCHANGES));
    this.maxStoredBodyBytes = opts.maxStoredBodyBytes ?? DEFAULT_MAX_STORED_BODY_BYTES;
    this.breakpointTimeoutMs = opts.breakpointTimeoutMs ?? DEFAULT_BREAKPOINT_TIMEOUT_MS;
    const mf = opts.maxFramesPerExchange ?? DEFAULT_MAX_FRAMES;
    this.maxFrames = Number.isFinite(mf) ? Math.max(0, Math.floor(mf)) : DEFAULT_MAX_FRAMES;
    if (opts.upstreamProxy) this.upstreamSpec = parseUpstreamProxy(opts.upstreamProxy);
    if (opts.tlsPassthrough) this.setTlsPassthrough(opts.tlsPassthrough);
    if (opts.clientCertificates) this.setClientCertificates(opts.clientCertificates);
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
    // CONTRACTS §14.5: a replayed event stream is written by us, event by event (a beforeRequest answer is one body).
    // Same trick as the WebSocket steps below: an own `handle` replaces the step implementation's.
    const passthroughImpl = StepLookup.passthrough.fromDefinition(new PassThroughStep(connection));
    const replayStreamStep = Object.assign(new CallbackStep(() => ({ statusCode: 500 })), {
      handle: (req: OngoingRequest, res: http.ServerResponse, options: unknown) => this.onReplayStream(req, res, passthroughImpl, options),
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
    // Map Remote on an upgrade (CONTRACTS §12.6): mockttp makes req.url read-only for websockets, so the mapped
    // target is handed to the step's own connectUpstream (same agents, TLS options and recording hook).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const proxy = this;
    const passWsStep = Object.assign(new PassThroughWebSocketStep(connection), {
      handle: function (this: any, req: OngoingRequest, socket: net.Socket, head: Buffer, options: unknown) {
        const impl = Object.getPrototypeOf(this);
        const map = proxy.flows.get(req.id)?.map;
        if (!map) return impl.handle.call(this, req, socket, head, options);
        return proxy.connectWsMapped(this, req, socket, head, options, map);
      },
    });
    const replayWsStep = Object.assign(new RejectWebSocketStep(500), {
      handle: (req: OngoingRequest, socket: net.Socket, head: Buffer) => this.onWsReplay(req, socket, head),
    });
    await (server as unknown as { addWebSocketRules: (...r: unknown[]) => Promise<unknown> }).addWebSocketRules(
      { matchers: [wsRoute('ws-local')], completionChecker: new Always(), steps: [localWsStep] },
      { matchers: [wsRoute('ws-replay')], completionChecker: new Always(), steps: [replayWsStep] },
      { matchers: [wsRoute('ws-pass')], completionChecker: new Always(), steps: [passWsStep] },
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
      this.installConnectHook(raw);
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
    this._port = server.port;
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
    for (const { ex } of [...this.live.values()]) this.fail(ex, 'Proxy stopped');
    for (const p of paused) p.settle({ kind: 'gone' });
    for (const settle of [...this.holds.values()]) settle(false);
    for (const c of this.sendClients) c.destroy();
    this.sendClients.clear();
    for (const t of this.tunnelSockets) t.destroy();
    this.tunnelSockets.clear();
    this.scripts.stop();
    this.wsReplayServer?.close();
    this.wsReplayServer = undefined;
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
    if (!this.live.has(req.id)) {
      const url = this.flows.get(req.id)?.originalUrl ?? req.url;
      this.flows.delete(req.id);
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
  /** `step`: sequence rules only (CONTRACTS §12.3), 0-based index of the step that answered, -1 = after the steps. */
  override on(event: 'rule-hit', listener: (ruleId: string, used: number, step?: number) => void): this;
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
    // Map Remote: the exchange keeps the URL the app asked for (CONTRACTS §12.6); `simulated` names the target.
    const url = flow.originalUrl ?? req.url;
    return {
      id: req.id,
      startedAt: req.timingEvents?.startTime ?? Date.now(),
      method: req.method,
      url,
      requestHeaders: cleanHeaders(req.headers),
      state: 'pending',
      ...(flow.rule ? { matchedRuleId: flow.rule.id } : {}),
      ...(flow.note ? { error: flow.note } : {}),
      ...(flow.simulated ? { simulated: flow.simulated } : {}),
      ...(flow.send ? { initiator: flow.send.initiator } : {}),
      ...(flow.send?.resentFrom !== undefined ? { resentFrom: flow.send.resentFrom } : {}),
      ...(flow.viaLan ? { viaLan: true as const } : {}),
      ...graphqlOf(req.method, url, req.headers),
      ...(this.webSession && !flow.send && !flow.viaLan && !flow.traceId && isBrowserInternal(url, req.headers)
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

  // ---------------------------------------------------------------- timings (CONTRACTS §13.2)

  /**
   * Upstream phases from the pooled agents (src/timing.ts). A live exchange carries them with its next 'exchange'
   * event (no event per phase); one that already finished gets an event of its own.
   */
  private addTimings(id: string, patch: TimingPatch): void {
    const live = this.live.get(id);
    const ex = live?.ex ?? this.store.get(id);
    if (!ex || ex.captured || !Object.keys(patch).length) return;
    ex.timings = { ...ex.timings, ...patch };
    if (!live) this.emitChange(ex);
  }

  /** Add to an accumulated phase (breakpoint holds, delays). Integer ms ≥ 0. */
  private addPhase(ex: Exchange, key: 'pausedMs' | 'delayMs', ms: number): void {
    const add = Math.max(0, Math.round(ms));
    ex.timings = { ...ex.timings, [key]: (ex.timings?.[key] ?? 0) + add };
  }

  /** `requestMs` (start → the whole request received), once known; never overwritten. */
  private setRequestMs(ex: Exchange, te: RequestTimingEvents | undefined, end?: number): void {
    if (ex.timings?.requestMs !== undefined || te?.startTimestamp === undefined) return;
    const at = end ?? te.bodyReceivedTimestamp;
    if (at === undefined) return;
    ex.timings = { ...ex.timings, requestMs: elapsed(te.startTimestamp, at) };
  }

  /** The timing sink for the request a downstream connection is serving (upstream-pool.ts). */
  private timingSink(connection: unknown): TimingSink | undefined {
    const id = connection && typeof connection === 'object' ? this.connRequest.get(connection) : undefined;
    return id ? (p) => this.addTimings(id, p) : undefined;
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

  private finish(ex: Exchange, state: Exchange['state']): void {
    const live = this.live.get(ex.id);
    if (live?.ex === ex) this.setRequestMs(ex, live.flow.te);
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
    const since = ex.pausedAt;
    return decision.then((d) => {
      delete ex.pausedAt;
      delete ex.pauseDeadline;
      this.addPhase(ex, 'pausedMs', Date.now() - since);
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
      const pm = this.matchRule(asked, req.url, { count: false, ignoreGraphql: true });
      const pre = pm.rule;
      const a = pm.action;
      if (pre && a && (a.kind === 'mock' || a.kind === 'block' || a.kind === 'cors')) {
        const o = a.kind === 'cors' ? corsOptions(a) : {};
        // Only for an origin the proxy may allow (loopback, or the cors rule's allowOrigin): otherwise the
        // server answers its own preflight (REVIEW-5 #3).
        if (allowedOrigin(headers, o)) flow = { route: 'h1', rule: pre, action: a, preflight: true, ...(a.kind === 'cors' ? { corsPatch: o } : {}) };
      }
    }
    if (!flow) {
      const m = this.matchRule(req.method, req.url, { count: true, headers });
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
    const socket = (req as unknown as { socket?: unknown }).socket;
    if (lanGateOf(socket)) flow.viaLan = true;
    if (socket && typeof socket === 'object') this.connRequest.set(socket, req.id);
    flow.te = (req as unknown as { timingEvents?: RequestTimingEvents }).timingEvents;
    const latency = flow.throttle?.latencyMs;
    if (flow.route === 'plain' && latency && latency > 0) {
      // Before forwarding, without reading the body: the route matcher waits on this.
      const from = performance.now();
      flow.delay = sleep(latency).then(() => {
        const live = this.live.get(req.id);
        if (live) this.addPhase(live.ex, 'delayMs', performance.now() - from);
        return !!live;
      });
    }

    this.flows.set(req.id, flow);
    this.wireTap(req, flow);
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
    const r = req as unknown as {
      url: string;
      protocol: string;
      path: string;
      destination: { hostname: string; port: number };
      rawHeaders: Array<[string, string]>;
      headers: HeaderBag;
    };
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

  /** Record from the passive taps: request body, response completion (except finished h1/h2 hooks). */
  private wireTap(req: OngoingRequest, flow: Flow): void {
    const tap = getTap(req.id);
    if (flow.route === 'plain') this.track(this.newExchange(req, flow), flow);
    if (!tap) return;
    this.applyShaping(tap, flow);
    tap.onRequestEnd = () => {
      const live = this.live.get(req.id);
      if (live) this.setRequestMs(live.ex, live.flow.te, performance.now());
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
    // CONTRACTS §14.4: every event arrives `latencyMs` late (the shaper starts with the first body byte).
    const latency = live.flow.throttle?.latencyMs;
    if (latency && latency > 0) tap.shaping = { ...tap.shaping, latencyMs: latency };
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
    const certRefused = res.statusCode === 403 && resBody?.encoding === 'utf8' && resBody.text.includes(CERT_REFUSAL_MARKER);
    if (ssrf) {
      this.fail(ex, resBody!.text.replace(/^Error: /, ''));
    } else if (certRefused) {
      // REVIEW-8 #1 backstop (requestPlan): refused before any upstream connection.
      ex.error = resBody!.text.replace(/^Error: /, '');
      delete ex.clientCertificate;
      this.finish(ex, 'blocked');
    } else if (upstreamError || (flow.route === 'h2' && flow.fault !== 'truncate')) {
      // h2 still pending here = beforeResponse never ran: upstream failure or response too large.
      const cause = upstreamError?.slice('passthrough-error:'.length);
      this.fail(
        ex,
        (resBody?.encoding === 'utf8' && resBody.text) ||
          (cause ? `The connection to the server failed${live.stream?.sse ? ' mid-stream' : ''} (${cause}).` : `Failed with status ${res.statusCode}`),
      );
    } else {
      this.finish(ex, flow.route === 'replay-stream' ? 'mocked' : 'completed');
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
        if (message && live.flow.route !== 'replay-stream') this.fail(ex, message);
        else {
          ex.error ??= 'The app closed the event stream.';
          this.finish(ex, live.flow.route === 'replay-stream' ? 'mocked' : 'completed');
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
    let flow = this.flows.get(req.id);
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
      const m = this.matchRule(req.method, req.url, { count: true, body: () => text });
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
      if (tap) this.applyShaping(tap, flow);
      if (this.forwards(flow)) flow.refused = this.certRefusal(flow.map?.url ?? req.url, req.headers as HeaderBag);
    }
    const ex = this.newExchange(req, flow);
    this.setRequestBody(ex, body);
    flow.te ??= req.timingEvents;
    this.setRequestMs(ex, flow.te, flow.te?.bodyReceivedTimestamp ?? performance.now());
    const action = flow.action;

    if (flow.preflight) return this.answerPreflight(req, ex, flow);

    if (flow.refused) {
      this.track(ex, flow);
      const headers: HeaderBag = { 'content-type': 'text/plain; charset=utf-8' };
      const text = `Flutter Intercept: ${flow.refused}`;
      ex.status = 403;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = { text, encoding: 'utf8' };
      ex.error = flow.refused;
      this.finish(ex, 'blocked');
      return { response: { statusCode: 403, statusMessage: STATUS_CODES[403], headers, rawBody: frameBody(Buffer.from(text, 'utf8'), headers) } };
    }

    if (flow.fault && flow.fault !== 'truncate') return this.applyFault(ex, flow);

    if (flow.localError) {
      this.track(ex, flow);
      return { response: this.localFailure(ex, flow.localError) };
    }

    if (flow.replay && flow.replay !== 'deferred') return this.answerReplay(ex, flow, flow.replay);

    if (action?.kind === 'mock') {
      this.track(ex, flow);
      if (action.delayMs && action.delayMs > 0) {
        const from = performance.now();
        await sleep(action.delayMs);
        this.addPhase(ex, 'delayMs', performance.now() - from);
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

    if (action?.kind === 'script') return this.scriptRequest(req, ex, flow, action, body);

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
    if (flow.map || flow.rewrite?.request || flow.wantHost) return this.forwardChanges(req, ex, flow, body);
    return undefined;
  }

  /** A 502 answered by the proxy (`Flutter Intercept: <error>`); the exchange ends 'error' with `error`. */
  private localFailure(ex: Exchange, error: string): CallbackResponseMessageResult & { statusCode: number } {
    const text = `Flutter Intercept: ${error}`;
    const headers: HeaderBag = { 'content-type': 'text/plain; charset=utf-8' };
    const rawBody = frameBody(Buffer.from(text, 'utf8'), headers);
    ex.status = 502;
    ex.responseHeaders = cleanHeaders(headers);
    ex.responseBody = { text, encoding: 'utf8' };
    this.fail(ex, error);
    return { statusCode: 502, statusMessage: STATUS_CODES[502], headers, rawBody };
  }

  // ---------------------------------------------------------------- script rules (CONTRACTS §13.4)

  /** Run a hook of the flow's script rule; its log lines go to `scriptLog`. */
  private async runScript(ex: Exchange, flow: Flow, action: ScriptAction, hook: 'onRequest' | 'onResponse', args: unknown[]): Promise<ScriptOutcome> {
    const rule = flow.rule;
    const id = rule?.id ?? '';
    const out = await this.scripts.run(id, rule?.name || id, action.code, hook, args, { ruleId: id, exchangeId: ex.id });
    if (out.lines.length) ex.scriptLog = [...(ex.scriptLog ?? []), ...out.lines].slice(0, SCRIPT_LOG_MAX_LINES);
    return out;
  }

  /** "Script <rule name>: <message>", also added as the last scriptLog line (room is made for it). */
  private scriptError(ex: Exchange, flow: Flow, message: string): string {
    const text = `Script ${flow.rule?.name || flow.rule?.id || ''}: ${message}`.slice(0, 2 * SCRIPT_LOG_MAX_CHARS);
    ex.scriptLog = [...(ex.scriptLog ?? []).slice(0, SCRIPT_LOG_MAX_LINES - 1), text.slice(0, SCRIPT_LOG_MAX_CHARS)];
    return text;
  }

  /**
   * onRequest: forward unchanged (undefined), forward the edited request (re-framed like a request edit), or answer
   * locally (`{response}`, like a mock: state 'mocked'). A throw, timeout or invalid result → 502, state 'error'.
   */
  private async scriptRequest(
    req: CompletedRequest,
    ex: Exchange,
    flow: Flow,
    action: ScriptAction,
    body: Body | undefined,
  ): Promise<CallbackRequestResult | undefined> {
    this.track(ex, flow);
    const input = scriptRequestOf(ex.method, ex.url, ex.requestHeaders, body);
    const out = await this.runScript(ex, flow, action, 'onRequest', [input]);
    if (this.live.get(ex.id)?.ex !== ex || ex.state !== 'pending') return { response: 'close' }; // the app left
    let plan: RequestOutcome | undefined;
    let error = out.error;
    if (error === undefined && out.value !== undefined) {
      try {
        plan = readRequestResult(out.value);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (error !== undefined) return { response: this.localFailure(ex, this.scriptError(ex, flow, error)) };
    if (plan?.kind === 'respond') {
      const headers: HeaderBag = { ...plan.headers };
      this.addCorsToLocalResponse(ex, headers);
      const decoded = Buffer.from(plan.body, 'utf8');
      const rawBody = frameBody(decoded, headers);
      ex.status = plan.status;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = await decodeForDisplay(decoded, undefined, true);
      if (isEventStream(getHeader(headers, 'content-type'))) this.setSseFrames(ex, decoded);
      this.finish(ex, 'mocked');
      return { response: { statusCode: plan.status, statusMessage: STATUS_CODES[plan.status] ?? 'Unknown', headers, rawBody } };
    }
    let result: CallbackRequestResult | undefined;
    if (plan) {
      const edit: RequestEdit = {};
      if (plan.method !== undefined && plan.method !== ex.method) edit.method = plan.method;
      if (plan.url !== undefined && plan.url !== ex.url) edit.url = plan.url;
      if (plan.headers && !sameHeaders(plan.headers, input.headers)) edit.headers = plan.headers;
      if (plan.body !== undefined && plan.body !== input.body) edit.body = plan.body;
      result = await this.applyRequestEdit(req, ex, edit);
    }
    if (!(await this.latency(ex, flow))) return { response: 'close' };
    return result;
  }

  /** onResponse: the response unchanged or edited (re-framed like a response edit); failures → 502. */
  private async scriptResponse(
    res: PassThroughResponse,
    ex: Exchange,
    flow: Flow,
    action: ScriptAction,
  ): Promise<CallbackResponseResult | undefined> {
    const input = scriptResponseOf(res.statusCode, ex.responseHeaders ?? {}, ex.responseBody);
    const request = scriptRequestOf(ex.method, ex.url, ex.requestHeaders, ex.requestBody);
    const out = await this.runScript(ex, flow, action, 'onResponse', [input, request]);
    if (this.live.get(ex.id)?.ex !== ex || ex.state !== 'pending') return 'close';
    let edit: ResponseEdit | undefined;
    let error = out.error;
    if (error === undefined && out.value !== undefined) {
      try {
        const r = readResponseResult(out.value);
        edit = {};
        if (r.status !== undefined && r.status !== res.statusCode) edit.status = r.status;
        if (r.headers && !sameHeaders(r.headers, input.headers)) edit.headers = r.headers;
        if (r.body !== undefined && r.body !== input.body) edit.body = r.body;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (error !== undefined) return this.localFailure(ex, this.scriptError(ex, flow, error));
    return this.applyResponseEdit(res, ex, edit);
  }

  /**
   * Map Remote / rewrite on a hooked route (CONTRACTS §12.6): what decide() couldn't do — a rule chosen only now
   * (GraphQL scope), a Host header other than the URL's, request body replacements.
   */
  private async forwardChanges(req: CompletedRequest, ex: Exchange, flow: Flow, body: Body | undefined): Promise<CallbackRequestResult | undefined> {
    const result: CallbackRequestResult = {};
    let headers: HeaderBag | undefined;
    let urlHost = new URL(req.url).host;
    if (!flow.reqApplied) {
      // Decided in beforeRequest: nothing was applied to the request yet.
      if (flow.map) {
        if (flow.viaLan) {
          // The LAN deny rule saw the original URL: check the mapped target now (CONTRACTS §7).
          const gate = lanGateOf((req as unknown as { socket?: unknown }).socket);
          const reason = await lanTargetDenial(flow.map.url, gate?.host);
          if (reason || !gate || gate.closed) {
            const text = reason ?? `${SSRF_MARKER}: LAN mode is off.`;
            ex.status = 403;
            ex.responseBody = { text, encoding: 'utf8' };
            this.fail(ex, text);
            return { response: { statusCode: 403, statusMessage: 'Forbidden', headers: { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }, body: text } };
          }
        }
        result.url = flow.map.url;
        urlHost = new URL(flow.map.url).host;
      }
      let pairs = Object.entries(req.headers as HeaderBag).flatMap(([k, v]) =>
        v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]),
      );
      if (flow.rewrite?.request) pairs = rewritePairs(pairs, rewriteSets(flow.rewrite.request));
      headers = pairsToObject(pairs);
      const want = rewriteHostOf(flow.rewrite?.request) ?? flow.map?.host ?? urlHost;
      if (want !== urlHost) flow.wantHost = want;
    }
    if (flow.wantHost) {
      headers ??= { ...(req.headers as HeaderBag) };
      setHeader(headers, 'host', flow.wantHost);
    }
    const replace = flow.rewrite?.reqBody ? flow.rewrite.request?.replaceBody : undefined;
    if (replace?.length) {
      headers ??= { ...(req.headers as HeaderBag) };
      const out = await replaceInBody(req.body.buffer, getHeader(headers, 'content-encoding'), replace);
      if (out.kind === 'skipped') ex.error = `Rewrite rule: request body not changed: ${out.reason}; it was forwarded unchanged.`;
      else {
        result.rawBody = frameBody(out.decoded, headers);
        this.setRequestBody(ex, await decodeForDisplay(out.decoded, undefined, true));
        if (out.unmatched) ex.error = `Rewrite rule: ${out.unmatched} request body replacement(s) found nothing.`;
      }
    }
    if (headers) {
      if (getHeader(headers, 'host') === urlHost) deleteHeader(headers, 'host'); // mockttp derives it from the URL
      result.headers = headers;
      const recorded: HeaderBag = { ...headers };
      if (!getHeader(recorded, 'host')) recorded.host = urlHost;
      ex.requestHeaders = cleanHeaders(recorded);
      this.emitChange(ex);
    }
    return Object.keys(result).length ? result : undefined;
  }

  /** A replayed response (CONTRACTS §12.4): re-framed for the recorded headers, state 'mocked'. */
  private async answerReplay(ex: Exchange, flow: Flow, entry: ReplayEntry): Promise<CallbackRequestResult> {
    this.track(ex, flow);
    const headers: HeaderBag = {};
    for (const [k, v] of Object.entries(entry.headers ?? {})) {
      if (!HTTP_TOKEN.test(k) || REPLAY_DROPPED_HEADERS.has(k.toLowerCase())) continue;
      const vals = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && !/[\r\n\0]/.test(x));
      if (vals.length) headers[k] = vals.length === 1 ? vals[0] : vals;
    }
    this.addCorsToLocalResponse(ex, headers);
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
    if (b?.truncated) ex.error = 'The recorded response body was cut at 5 MB; the app got that part only.';
    if (isEventStream(getHeader(headers, 'content-type'))) this.setSseFrames(ex, decoded);
    this.finish(ex, 'mocked');
    return { response: { statusCode: entry.status, statusMessage: STATUS_CODES[entry.status], headers, rawBody } };
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
    if (ms && ms > 0) {
      const from = performance.now();
      await sleep(ms);
      if (this.live.get(ex.id)?.ex === ex) this.addPhase(ex, 'delayMs', performance.now() - from);
    }
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
    const action = flow.action;
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
    } else if (action?.kind === 'script') {
      const r = await this.scriptResponse(res, ex, flow, action);
      if (r === 'close' || r === 'reset') return r;
      if (!this.live.has(ex.id)) return r; // failed: the 502 replaces the response
      result = r;
    } else if (action?.kind === 'mutate') {
      result = await this.applyMutation(res, ex, action.ops);
      if (!this.live.has(ex.id) || ex.state !== 'pending') return 'close'; // the app left meanwhile
    } else if (flow.rewrite?.response) {
      result = await this.applyRewriteResponse(res, ex, flow.rewrite);
      if (!this.live.has(ex.id) || ex.state !== 'pending') return 'close';
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

  /** A rewrite rule on a buffered response (CONTRACTS §12.6): status, headers, literal body replacements. */
  private async applyRewriteResponse(res: PassThroughResponse, ex: Exchange, rw: RewriteFlow): Promise<CallbackResponseMessageResult | undefined> {
    const spec = rw.response!;
    const result: CallbackResponseMessageResult = {};
    if (spec.status !== undefined && validRewriteStatus(spec.status) && spec.status !== res.statusCode) {
      result.statusCode = spec.status;
      result.statusMessage = STATUS_CODES[spec.status] ?? 'Unknown';
      ex.status = spec.status;
    }
    const sets = rewriteSets(spec, true);
    const replace = rw.resBody ? spec.replaceBody : undefined;
    if (!sets.remove.length && !sets.set.length && !replace?.length) return Object.keys(result).length ? result : undefined;
    const headers = pairsToObject(rewritePairs(headerPairs(res.headers as HeaderBag), sets));
    let rawBody: Buffer = res.body.buffer;
    if (replace?.length) {
      const out = await replaceInBody(res.body.buffer, getHeader(res.headers as HeaderBag, 'content-encoding'), replace);
      if (out.kind === 'skipped') ex.error = `Rewrite rule: response body not changed: ${out.reason}; it was forwarded unchanged.`;
      else {
        for (const h of ['content-md5', 'digest', 'content-digest', 'repr-digest']) deleteHeader(headers, h);
        rawBody = await frameBodyAsync(out.decoded, headers);
        ex.responseBody = await decodeForDisplay(out.decoded, undefined, true);
        if (out.unmatched) ex.error = `Rewrite rule: ${out.unmatched} response body replacement(s) found nothing.`;
      }
    }
    if (rawBody === res.body.buffer) {
      deleteHeader(headers, 'transfer-encoding');
      setHeader(headers, 'content-length', String(rawBody.length));
    }
    result.headers = headers;
    result.rawBody = rawBody;
    ex.responseHeaders = cleanHeaders(headers);
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
    const action = m.action;
    let flow: Flow = { route: 'ws-pass' };
    if (action?.kind === 'block') flow = { route: 'ws-local', rule: m.rule, action };
    else if (action?.kind === 'fault') flow = { route: 'ws-local', rule: m.rule, action, fault: action.fault, simulated: FAULT_LABELS[action.fault] };
    else if (this.profile.kind === 'offline') flow = { route: 'ws-local', rule: m.rule, fault: 'dns', simulated: describeProfile(this.profile) };
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
    } else if (!m.rule && this.replayStore) {
      // CONTRACTS §14.5: a recorded WebSocket for this URL answers as a scripted server.
      const store = this.replayStore;
      const hit = store.lookup('GET', url, {}, true);
      if (hit && hit !== 'needs-body' && hit.entry.kind === 'websocket') {
        flow = { route: 'ws-replay', replay: hit.entry, simulated: `Replayed from ${store.name ?? 'a recording'}` };
      } else if (store.fallback === 'fail') {
        flow = { route: 'ws-local', fault: 'dns', simulated: 'Not in the recording (replay: fail)' };
      }
    } else if (m.rule) flow.rule = m.rule;
    if (flow.route === 'ws-pass') {
      const refused = this.certRefusal(flow.map?.url ?? url, req.headers as HeaderBag);
      if (refused) flow = { route: 'ws-local', ...(m.rule ? { rule: m.rule } : {}), refused };
    }
    if (flow.route === 'ws-pass') {
      // CONTRACTS §14.4: a throttle rule (or the throttle profile) paces the frames, each direction (watchWebSocket).
      const t = action?.kind === 'throttle' ? action : this.profile.kind === 'throttle' ? this.profile : undefined;
      if (t) {
        const label = action?.kind === 'throttle' ? throttleLabel(action) : profileLabel(this.profile as ThrottleProfile);
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
    const socket = (req as unknown as { socket?: unknown }).socket;
    if (lanGateOf(socket)) flow.viaLan = true;
    if (socket && typeof socket === 'object') this.connRequest.set(socket, req.id);
    this.flows.set(req.id, flow);
    const ex = this.newExchange({ id: req.id, method: req.method, url, headers: req.headers as HeaderBag, timingEvents: req.timingEvents }, flow);
    delete ex.graphql;
    ex.kind = 'websocket';
    ex.frames = [];
    // An upgrade request is its head: complete now (CONTRACTS §13.2, phases up to the 101).
    flow.te = req.timingEvents;
    this.setRequestMs(ex, flow.te, performance.now());
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
      const th = live.flow.throttle;
      if (th && up) {
        // Before mockttp's pipe starts (it is attached after this event): what the pipe sends to the app is paced
        // like a download, what it sends to the server like an upload.
        const note = (text: string) => {
          if (this.live.get(ex.id)?.ex === ex) ex.error = text;
        };
        paceWebSocket(ws, { latencyMs: th.latencyMs, kbps: th.kbps }, up, note);
        paceWebSocket(up, { latencyMs: th.latencyMs, kbps: th.uploadKbps }, ws, note);
      }
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
    const action = flow.action;
    const reset = () => resetOrDestroy(req as unknown as Parameters<typeof resetOrDestroy>[0]);
    if (flow.refused) {
      const body = Buffer.from(`Flutter Intercept: ${flow.refused}`, 'utf8');
      ex.status = 403;
      ex.error = flow.refused;
      this.finish(ex, 'blocked');
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
      this.fail(ex, flow.localError);
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

  /**
   * Map Remote for a WebSocket upgrade: mockttp's PassThroughWebSocketStep, but connected to the mapped target
   * (its connectUpstream takes the destination and URL explicitly; req.url is read-only for upgrades).
   */
  private async connectWsMapped(step: any, req: OngoingRequest, socket: net.Socket, head: Buffer, options: unknown, map: { url: string; host: string }): Promise<void> {
    if (typeof step?.connectUpstream !== 'function' || typeof step?.initializeWsServer !== 'function') {
      const live = this.live.get(req.id);
      if (live) this.fail(live.ex, 'Map Remote could not be applied to this WebSocket (incompatible mockttp version).');
      socket.destroy();
      return;
    }
    step.initializeWsServer();
    const t = new URL(map.url);
    const destination = { hostname: t.hostname.replace(/^\[|\]$/g, ''), port: Number(t.port) || (t.protocol === 'wss:' ? 443 : 80) };
    const raw = (req as unknown as { rawHeaders: Array<[string, string]> }).rawHeaders;
    const rawHeaders = rewritePairs(Array.isArray(raw) ? raw.slice() : [], { remove: ['host'], set: [['Host', map.host]] });
    await step.connectUpstream(destination, map.url, req, rawHeaders, socket, head, options);
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
    const live = this.live.get(id);
    const flow = live?.flow ?? this.flows.get(id);
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
    return { timings: (p) => this.addTimings(id, p), ...(up && up > 0 ? { uploadKbps: up } : {}) };
  }

  // ---------------------------------------------------------------- TLS passthrough (CONTRACTS §14.2)

  /**
   * Take over CONNECT handling: mockttp's combo server answers every CONNECT itself ('connect' listener in
   * http-combo-server.js: "200", then the socket goes back in as a new connection to be MITM'd). We remove its
   * listener(s) from the server (httpolyglot mirrors listeners onto its sub-servers, so removing from the outer server
   * removes them everywhere) and install one that tunnels passthrough hosts and hands everything else to mockttp's.
   * LAN clients reach this too: the LAN gate hands authenticated sockets to the same server.
   */
  private installConnectHook(raw: net.Server): void {
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
    this.connectHook = true;
  }

  /** A CONNECT to a passthrough host: tunnel it (true), else mockttp handles it (false). */
  private onConnect(req: http.IncomingMessage, socket: unknown, head: Buffer | undefined): boolean {
    if (!this.passthrough.length || !(socket instanceof net.Socket) || socket instanceof tls.TLSSocket) return false;
    const t = splitHostPort(req.url ?? '');
    if (!t) return false;
    const host = normalizeHostname(t.host);
    if (!host || !this.passthrough.some((p) => matchesHostPattern(p, host, t.port))) return false;
    void this.runTunnel(req, socket, head ?? Buffer.alloc(0), host, t.port).catch(() => socket.destroy());
    return true;
  }

  private async runTunnel(req: http.IncomingMessage, socket: net.Socket, head: Buffer, host: string, port: number): Promise<void> {
    socket.on('error', () => undefined);
    if (!lanConnectAllowed(socket)) {
      socket.destroy();
      return;
    }
    const gate = lanGateOf(socket);
    const label = net.isIPv6(host) ? `[${host}]` : host;
    const url = `https://${label}:${port}/`;
    // Rules: block and fault only. Matched as method CONNECT on the tunnel's own URL (a rule made from a tunnel,
    // `https://host:port/*`), and on `https://host/` for port 443 so a rule written for the site applies too.
    let m: MatchResult = {};
    let note: string | undefined;
    for (const u of port === 443 ? [url, `https://${label}/`] : [url]) {
      const probe = this.matchRule('CONNECT', u, { count: false, tunnel: true });
      note ??= probe.note;
      if (probe.rule) {
        m = this.matchRule('CONNECT', u, { count: true, tunnel: true });
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
    const p = this.profile;
    if (a?.kind === 'block') {
      cut = 'reset';
      if (a.mode === 'status') note ??= "A block with a status can't be answered inside an undecrypted tunnel; the connection was reset after the TLS handshake instead.";
    } else if (a?.kind === 'fault') {
      cut = a.fault;
      simulated = FAULT_LABELS[a.fault];
    } else if (p.kind === 'offline') {
      cut = 'dns';
      simulated = describeProfile(p);
    } else if (!m.rule && this.replayStore?.fallback === 'fail') {
      cut = 'dns';
      simulated = `Not in the recording${this.replayStore.name ? ` "${this.replayStore.name}"` : ''} (replay: fail)`;
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
    const requestHeaders = cleanHeaders(req.headers as HeaderBag);
    delete requestHeaders['proxy-authorization']; // the LAN token
    const ex: Exchange = {
      id: `tunnel-${randomUUID()}`,
      startedAt: Date.now(),
      method: 'CONNECT',
      url,
      requestHeaders,
      state: 'pending',
      kind: 'tunnel',
      tunnelBytes: { sent: 0, received: 0 },
      ...(m.rule ? { matchedRuleId: m.rule.id } : {}),
      ...(note ? { error: note } : {}),
      ...(simulated ? { simulated } : {}),
      ...(gate ? { viaLan: true as const } : {}),
    };
    this.track(ex, flow);
    const isLive = () => this.live.get(ex.id)?.ex === ex;
    let relaying = false;
    socket.once('close', () => {
      if (!relaying && isLive()) this.fail(ex, 'The app closed the connection before the tunnel was open.');
    });
    if (latency > 0) {
      const from = performance.now();
      await sleep(latency);
      if (!isLive()) return;
      this.addPhase(ex, 'delayMs', performance.now() - from);
    }
    let server: net.Socket;
    try {
      server = await openTunnelUpstream({
        host,
        port,
        ...(gate ? { lan: { listenerHost: gate.host, closed: () => gate.closed } } : {}),
        upstream: this.upstreamSpec,
        ...((this.opts.rewriteLocalhost ?? true) ? { alias: (h: string) => HOST_ALIASES[h] } : {}),
        timings: (t) => this.addTimings(ex.id, t),
      });
    } catch (e) {
      if (!isLive()) return;
      const forbidden = e instanceof SsrfError || (e as { statusCode?: number }).statusCode === 403;
      const message = e instanceof SsrfError ? e.message : forbidden ? `${SSRF_MARKER}: ${(e as Error).message}` : `Could not open the tunnel to ${label}:${port}: ${(e as Error).message}`;
      ex.status = forbidden ? 403 : 502;
      this.fail(ex, message);
      refuse(socket, `HTTP/1.1 ${ex.status} ${STATUS_CODES[ex.status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (socket.destroyed || !isLive()) {
      server.destroy();
      return;
    }
    this.tunnelSockets.add(server);
    server.once('close', () => this.tunnelSockets.delete(server));
    relaying = true;
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    this.emitChange(ex);
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
        this.touch(ex);
      },
      onClose: (error) => {
        if (!isLive()) return;
        if (error) this.fail(ex, error);
        else this.finish(ex, 'completed');
      },
    });
  }

  /** A block / fault on a passthrough tunnel, at the app's first request record (after the TLS handshake). */
  private cutTunnel(ex: Exchange, socket: net.Socket, server: net.Socket, fault: FlowFault): void {
    server.destroy();
    if (this.live.get(ex.id)?.ex !== ex) return void socket.destroy();
    if (fault === 'timeout') {
      const settle = (appLeft: boolean) => {
        if (this.holds.get(ex.id) !== settle) return;
        clearTimeout(timer);
        this.holds.delete(ex.id);
        if (this.live.get(ex.id)?.ex !== ex) return void socket.destroy();
        const secs = ((Date.now() - ex.startedAt) / 1000).toFixed(1);
        ex.simulated = appLeft ? `${FAULT_LABELS.timeout} (the app gave up after ${secs} s)` : `${FAULT_LABELS.timeout} (reset after ${secs} s)`;
        this.finish(ex, 'blocked');
        if (!appLeft) resetOrDestroy(socket as never);
      };
      const timer = setTimeout(() => settle(false), this.breakpointTimeoutMs);
      timer.unref?.();
      this.holds.set(ex.id, settle);
      socket.once('close', () => settle(true));
      return;
    }
    this.finish(ex, 'blocked');
    if (fault === 'dns') socket.end();
    else resetOrDestroy(socket as never);
  }

  // ---------------------------------------------------------------- stream replay (CONTRACTS §14.5)

  /**
   * A recorded event stream, answered event by event at the recorded gaps (≤ 5 s). Entries whose request body
   * matters (POST streams) are chosen here, once the body is read; a non-stream answer is written whole, and a miss
   * follows the replay fallback (the real server, or closed like offline).
   */
  private async onReplayStream(req: OngoingRequest, res: http.ServerResponse, passthrough: { handle(...a: unknown[]): Promise<unknown> }, options: unknown): Promise<void> {
    const flow = this.flows.get(req.id);
    if (!flow) {
      res.writeHead(502).end();
      return;
    }
    let entry = flow.replay;
    if (entry === 'deferred') {
      let key: BodyKey = 'unreadable';
      try {
        const buf: Buffer = await (req as unknown as { body: { asDecodedBuffer(): Promise<Buffer> } }).body.asDecodedBuffer();
        const b = await decodeForDisplay(buf, undefined, true);
        key = b?.truncated ? 'unreadable' : { hash: requestBodyHash(b) };
      } catch {
        key = 'unreadable';
      }
      const r = this.replayFlow(req.method, req.url, req.headers as HeaderBag, key, flow.note);
      Object.assign(flow, { route: r.route, replay: r.replay, fault: r.fault, simulated: r.simulated, throttle: r.throttle, note: r.note });
      entry = r.replay === 'deferred' ? undefined : r.replay;
      if (!entry) {
        if (r.fault) {
          // replay fallback "fail": closed without a response, like the offline profile.
          const ex = this.newExchange(req, flow);
          this.track(ex, flow);
          this.finish(ex, 'blocked');
          res.socket?.end();
          return;
        }
        // Not in the recording: the real server, recorded like any pass-through.
        flow.route = 'plain';
        this.track(this.newExchange(req, flow), flow);
        const tap = getTap(req.id);
        if (tap) this.applyShaping(tap, flow);
        await passthrough.handle(req, res, options);
        return;
      }
      if (entry.kind !== 'sse') {
        const ex = this.newExchange(req, flow);
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
    const ex = this.newExchange(req, flow);
    this.setRequestMs(ex, (req as unknown as { timingEvents?: RequestTimingEvents }).timingEvents, performance.now());
    this.track(ex, flow);
    const headers: HeaderBag = {};
    for (const [k, v] of Object.entries(entry.headers ?? {})) {
      const lk = k.toLowerCase();
      if (!HTTP_TOKEN.test(k) || REPLAY_DROPPED_HEADERS.has(lk) || lk === 'content-encoding') continue;
      const vals = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && !/[\r\n\0]/.test(x));
      if (vals.length) headers[k] = vals.length === 1 ? vals[0] : vals;
    }
    if (!getHeader(headers, 'content-type')) headers['content-type'] = 'text/event-stream';
    if (!getHeader(headers, 'cache-control')) headers['cache-control'] = 'no-cache';
    this.addCorsToLocalResponse(ex, headers);
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
  private async onWsReplay(req: OngoingRequest, socket: net.Socket, head: Buffer): Promise<void> {
    const live = this.live.get(req.id);
    const entry = live?.flow.replay;
    if (!live || !entry || entry === 'deferred') {
      socket.destroy();
      return;
    }
    const { ex } = live;
    socket.on('error', () => undefined);
    let upgraded = false;
    socket.once('close', () => {
      if (!upgraded && this.live.get(ex.id)?.ex === ex) this.fail(ex, 'The replayed WebSocket upgrade was refused (an invalid upgrade request?).');
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

  private runWsReplay(ex: Exchange, entry: ReplayEntry, ws: WebSocket): void {
    const isLive = () => this.live.get(ex.id)?.ex === ex;
    ex.status = 101;
    ex.responseHeaders = { upgrade: 'websocket', connection: 'Upgrade', ...(ws.protocol ? { 'sec-websocket-protocol': ws.protocol } : {}) };
    this.emitChange(ex);
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
        if (isLive()) this.addFrame(ex, closeFrame('receive', code, f.text));
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
      if (isLive()) this.addFrame(ex, payloadFrame('receive', f.kind, buf));
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
      if (isLive()) this.addFrame(ex, payloadFrame('send', isBinary ? 'binary' : 'text', toBuffer(data)));
      const reply = script.replies[messages++];
      if (reply) play(reply);
    });
    ws.on('ping', (d) => isLive() && this.addFrame(ex, payloadFrame('send', 'ping', toBuffer(d))));
    ws.on('pong', (d) => isLive() && this.addFrame(ex, payloadFrame('send', 'pong', toBuffer(d))));
    ws.on('error', () => undefined);
    ws.once('close', (code, reason) => {
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (!isLive()) return;
      if (!closeSent) this.addFrame(ex, closeFrame('send', code === 1005 ? undefined : code, toBuffer(reason)));
      this.finish(ex, 'mocked');
    });
    play(script.opening);
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
  if (ex.timings) copy.timings = { ...ex.timings };
  if (ex.scriptLog) copy.scriptLog = ex.scriptLog.slice();
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
  if ('timings' in input) out.timings = cleanTimings(input.timings);
  if ('scriptLog' in input) {
    out.scriptLog = Array.isArray(input.scriptLog)
      ? input.scriptLog.slice(0, SCRIPT_LOG_MAX_LINES).map((l) => String(l).slice(0, SCRIPT_LOG_MAX_CHARS))
      : undefined;
  }
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

const TIMING_FIELDS = ['requestMs', 'pausedMs', 'delayMs', 'dnsMs', 'connectMs', 'tlsMs', 'sendMs', 'waitMs', 'receiveMs'] as const;

/** A record()'s timings (e.g. from the VM HTTP profile): known phases only, integer ms ≥ 0; undefined when none. */
function cleanTimings(t: unknown): Exchange['timings'] {
  if (!t || typeof t !== 'object') return undefined;
  const src = t as Record<string, unknown>;
  const out: NonNullable<Exchange['timings']> = {};
  for (const k of TIMING_FIELDS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.round(v);
  }
  if (src.reused === true) out.reused = true;
  return Object.keys(out).length ? out : undefined;
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
  const uploadKbps = num(p.uploadKbps, 'uploadKbps', 10_000_000);
  return {
    kind: 'throttle',
    ...(p.preset ? { preset: p.preset } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(kbps ? { kbps } : {}),
    ...(dropRate !== undefined ? { dropRate } : {}),
    ...(uploadKbps ? { uploadKbps } : {}),
  };
}

// ---------------------------------------------------------------- v0.6.0 helpers (CONTRACTS §12)

/** Identity of a sequence rule's content: its position resets when this changes. */
function sequenceSig(rule: Rule): string {
  try {
    return JSON.stringify([rule.match, rule.action]);
  } catch {
    return String(Math.random());
  }
}

/** Could this action need the buffered response hook (h2)? */
function needsResponseHook(a: RuleAction | undefined): boolean {
  if (!a) return false;
  if (a.kind === 'mutate' || (a.kind === 'breakpoint' && a.phase !== 'request')) return true;
  if (a.kind === 'rewrite') return !!a.response?.replaceBody?.length;
  if (a.kind === 'script') return mentionsOnResponse(a.code);
  if (a.kind === 'sequence') return (a.steps ?? []).some((s) => s?.action?.kind !== 'passthrough' && needsResponseHook(s?.action as RuleAction));
  return false;
}

/** Headers a rewrite can't set or remove: framing, hop-by-hop and internal ones (the proxy manages them). */
const REWRITE_SKIPPED = new Set([
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'host', // request: handled with Map Remote's Host logic (rewriteHostOf)
  TRACE_HEADER,
  SEND_HEADER,
]);

/** Headers a replayed response doesn't carry over: the proxy frames the body itself. */
const REPLAY_DROPPED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'trailer', 'upgrade']);

interface HeaderSets {
  /** Lower-case names removed (set names are removed too, before being added). */
  remove: string[];
  set: Array<[string, string]>;
}

const validHeaderValue = (v: unknown): v is string => typeof v === 'string' && !/[\r\n\0]/.test(v);

/** The valid header changes of a RewriteSpec (invalid names / values and managed headers are ignored). */
function rewriteSets(spec: RewriteSpec | undefined, _response = false): HeaderSets {
  const remove = new Set<string>();
  const set: Array<[string, string]> = [];
  for (const n of spec?.removeHeaders ?? []) {
    const l = String(n).trim().toLowerCase();
    if (HTTP_TOKEN.test(l) && !REWRITE_SKIPPED.has(l)) remove.add(l);
  }
  for (const [k, v] of Object.entries(spec?.setHeaders ?? {})) {
    const l = k.trim().toLowerCase();
    if (!HTTP_TOKEN.test(l) || REWRITE_SKIPPED.has(l) || !validHeaderValue(v)) continue;
    set.push([k.trim(), v]);
  }
  return { remove: [...remove], set };
}

/** A Host header set by a request rewrite (CONTRACTS §12.6), if valid. */
function rewriteHostOf(spec: RewriteSpec | undefined): string | undefined {
  for (const [k, v] of Object.entries(spec?.setHeaders ?? {})) {
    if (k.trim().toLowerCase() === 'host' && validHeaderValue(v) && v.trim()) return v.trim();
  }
  return undefined;
}

function rewritePairs(pairs: Array<[string, string]>, sets: HeaderSets): Array<[string, string]> {
  const drop = new Set([...sets.remove, ...sets.set.map(([k]) => k.toLowerCase())]);
  const out = pairs.filter(([k]) => !drop.has(String(k).toLowerCase()));
  for (const p of sets.set) out.push([p[0], p[1]]);
  return out;
}

function pairValue(pairs: Array<[string, string]>, name: string): string | undefined {
  return pairs.find(([k]) => String(k).toLowerCase() === name)?.[1];
}

function pairsToObject(pairs: Array<[string, string]>): HeaderBag {
  const out: HeaderBag = {};
  for (const [k, v] of pairs) {
    const l = String(k).toLowerCase();
    const prev = out[l];
    out[l] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

function headerPairs(h: HeaderBag): Array<[string, string]> {
  return Object.entries(h).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string])));
}

const validRewriteStatus = (s: unknown): s is number => Number.isInteger(s) && (s as number) >= 200 && (s as number) <= 599;

function rewriteFlow(a: RewriteAction): RewriteFlow {
  const ok = (r: RewriteSpec['replaceBody']) => (r ?? []).some((x) => typeof x?.find === 'string' && x.find !== '');
  return {
    ...(a.request ? { request: a.request } : {}),
    ...(a.response ? { response: a.response } : {}),
    reqBody: ok(a.request?.replaceBody),
    resBody: ok(a.response?.replaceBody),
  };
}

function rewriteLabel(rw: RewriteFlow): string {
  const parts: string[] = [];
  const rq = rw.request;
  const rs = rw.response;
  if (rq && (rewriteSets(rq).remove.length || rewriteSets(rq).set.length || rewriteHostOf(rq))) parts.push('request headers');
  if (rw.reqBody) parts.push('request body');
  if (rs?.status !== undefined && validRewriteStatus(rs.status)) parts.push(`status ${rs.status}`);
  if (rs && (rewriteSets(rs, true).remove.length || rewriteSets(rs, true).set.length)) parts.push('response headers');
  if (rw.resBody) parts.push('response body');
  return parts.length ? `Rewritten: ${parts.join(', ')}` : 'Rewrite (nothing to change)';
}

type ReplaceOutcome = { kind: 'skipped'; reason: string } | { kind: 'done'; decoded: Buffer; unmatched: number };

/** Most a body replacement may produce (REVIEW-6 #3), whatever the input. */
export const REWRITE_OUTPUT_MAX_BYTES = 64 * MB;

/** The output budget for a body of `input` bytes: ≤ 64 MB and ≤ max(4 × input, input + 1 MB). */
export function rewriteOutputBudget(input: number): number {
  return Math.min(REWRITE_OUTPUT_MAX_BYTES, Math.max(4 * input, input + MB));
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Literal find / replace on a complete body's decoded UTF-8 text (≤ MAX_BODY_REPLACEMENTS, in order). Bounded
 * (REVIEW-6 #3): before each replacement the result size is computed from the occurrences (counting stops as soon
 * as it would pass the budget), and a body that would grow past `rewriteOutputBudget` is left unchanged. Yields to
 * the event loop between replacements.
 */
async function replaceInBody(raw: Buffer, contentEncoding: string | undefined, list: NonNullable<RewriteSpec['replaceBody']>): Promise<ReplaceOutcome> {
  let decoded: Buffer;
  try {
    decoded = await decodeStrict(raw, contentEncoding, RESPONSE_PAUSE_LIMIT_BYTES);
  } catch (e) {
    return { kind: 'skipped', reason: `it could not be decoded (${(e as Error).message})` };
  }
  if (!isUtf8(decoded)) return { kind: 'skipped', reason: 'it is not UTF-8 text' };
  const budget = rewriteOutputBudget(decoded.length);
  const bom = decoded.length >= 3 && decoded[0] === 0xef && decoded[1] === 0xbb && decoded[2] === 0xbf;
  let text = decoded.subarray(bom ? 3 : 0).toString('utf8');
  let bytes = decoded.length;
  let unmatched = 0;
  for (const r of list.slice(0, MAX_BODY_REPLACEMENTS)) {
    if (typeof r?.find !== 'string' || r.find === '' || typeof r.replace !== 'string') continue;
    await yieldToLoop();
    const growth = Buffer.byteLength(r.replace, 'utf8') - Buffer.byteLength(r.find, 'utf8');
    let count = 0;
    for (let at = text.indexOf(r.find); at >= 0; at = text.indexOf(r.find, at + r.find.length)) {
      count++;
      if (growth > 0 && bytes + count * growth > budget) {
        return {
          kind: 'skipped',
          reason:
            `the replacements would make it larger than ${(budget / MB).toFixed(1)} MB ` +
            `(at most 4 × its size or +1 MB, and never over ${REWRITE_OUTPUT_MAX_BYTES / MB} MB)`,
        };
      }
      if (!r.all) break;
    }
    if (!count) {
      unmatched++;
      continue;
    }
    text = r.all ? text.split(r.find).join(r.replace) : text.replace(r.find, () => r.replace);
    bytes += count * growth;
  }
  const out = Buffer.from(text, 'utf8');
  return { kind: 'done', decoded: bom ? Buffer.concat([decoded.subarray(0, 3), out]) : out, unmatched };
}

// ---------------------------------------------------------------- v0.8.0 helpers (CONTRACTS §14)

/** A usable client certificate (CONTRACTS §14.3). `options` go into the upstream TLS options; never logged. */
interface LoadedCert {
  pattern: HostPattern;
  /** The pattern as configured (Exchange.clientCertificate). */
  host: string;
  options: { pfx?: Buffer; cert?: string; key?: string; passphrase?: string };
}

/** Validate one configured certificate by building a TLS context from it. Problems never quote key material. */
export function loadClientCertificate(c: ClientCertificate): { host: string; cert?: LoadedCert; problem?: string } {
  const host = c && typeof c === 'object' && typeof c.host === 'string' ? c.host.trim() : '';
  if (!c || typeof c !== 'object') return { host, problem: 'Not a certificate entry.' };
  let pattern: HostPattern;
  try {
    pattern = parseHostPattern(c.host);
  } catch (e) {
    return { host, problem: `Invalid host: ${(e as Error).message}.` };
  }
  const hasPfx = c.pfx !== undefined && c.pfx !== null;
  const hasPem = c.cert !== undefined || c.key !== undefined;
  if (hasPfx && hasPem) return { host, problem: 'Give either a PKCS#12 file (pfx) or a PEM certificate and key, not both.' };
  if (!hasPfx && !hasPem) return { host, problem: 'No certificate: give a PKCS#12 file (pfx) or a PEM certificate and key.' };
  if (c.passphrase !== undefined && typeof c.passphrase !== 'string') return { host, problem: 'The passphrase must be text.' };
  const options: LoadedCert['options'] = {};
  if (hasPfx) {
    if (!(c.pfx instanceof Uint8Array) || !c.pfx.length) return { host, problem: 'The PKCS#12 file is empty or not binary data.' };
    options.pfx = Buffer.from(c.pfx);
  } else {
    if (typeof c.cert !== 'string' || !c.cert.trim()) return { host, problem: 'The PEM certificate is missing.' };
    if (typeof c.key !== 'string' || !c.key.trim()) return { host, problem: 'The PEM private key is missing.' };
    options.cert = c.cert;
    options.key = c.key;
  }
  if (c.passphrase) options.passphrase = c.passphrase;
  try {
    tls.createSecureContext(options);
  } catch (e) {
    return { host, problem: certProblem(e, hasPfx) };
  }
  return { host, cert: { pattern, host: pattern.pattern, options } };
}

/** OpenSSL's error, in words (codes stripped; it never contains the key or passphrase, but is cut short anyway). */
function certProblem(e: unknown, pfx: boolean): string {
  const raw = String((e as Error)?.message ?? e);
  const what = pfx ? 'PKCS#12 file' : 'PEM certificate / key';
  if (/mac verify failure/i.test(raw)) return `Could not open the ${what}: wrong passphrase (or a damaged file).`;
  if (/bad decrypt|bad password|interrupted or cancelled/i.test(raw)) return `Could not decrypt the private key: wrong or missing passphrase.`;
  if (/key values mismatch/i.test(raw)) return 'The private key does not belong to the certificate.';
  if (/unsupported/i.test(raw) && pfx) {
    return 'Unsupported PKCS#12 encryption (a legacy algorithm such as RC2-40); export it again with AES (openssl pkcs12 -export -keypbe AES-256-CBC -certpbe AES-256-CBC).';
  }
  if (/no start line|PEM routines|bad base64|DECODER routines/i.test(raw)) return `Could not read the ${what}: not valid PEM.`;
  if (/not enough data|wrong tag|asn1|header too long/i.test(raw)) return `Could not read the ${what}: not a valid file.`;
  const clean = raw.replace(/error:[0-9A-Fa-f]+:[^:]*:[^:]*:/g, '').trim().slice(0, 200);
  return `Could not load the ${what}: ${clean || 'unknown error'}.`;
}

interface PacedWs {
  readyState: number;
  send(data: unknown, opts?: unknown, cb?: unknown): void;
  ping(data?: unknown, mask?: unknown, cb?: unknown): void;
  pong(data?: unknown, mask?: unknown, cb?: unknown): void;
  close(code?: number, reason?: unknown): void;
  pause?(): void;
  resume?(): void;
  once(event: 'close', l: () => void): unknown;
}

/**
 * REVIEW-8 #6: a throttled WebSocket direction may hold this many bytes waiting for the simulated link; beyond it the
 * sending side's socket is paused (TCP pushes back on the peer, as a real slow link would) until half of it drained.
 */
export const WS_THROTTLE_QUEUE_MAX = 8 * 1024 * 1024;

const byteSize = (d: unknown): number =>
  typeof d === 'string' ? Buffer.byteLength(d) : Buffer.isBuffer(d) || d instanceof Uint8Array ? d.byteLength : d instanceof ArrayBuffer ? d.byteLength : Array.isArray(d) ? d.reduce((n: number, x) => n + byteSize(x), 0) : 0;

/**
 * CONTRACTS §14.4: deliver what is sent on a `ws` socket (`target`) through a LinkQueue (latency + bandwidth), in
 * order — messages, pings / pongs and the close. Anything due after the socket closed is dropped (its callback still
 * runs). `source` is the socket whose messages the pipe forwards to `target`: it is paused while the queue is over
 * WS_THROTTLE_QUEUE_MAX; without pause support the connection is closed (1013) with `onOverflow`'s note instead.
 */
function paceWebSocket(target: unknown, shape: LinkShape, source: unknown, onOverflow: (note: string) => void): void {
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

/** `http(s)://localhost | 127.0.0.1 | [::1]` with any port: the Flutter Web dev server's own origin. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

const CERT_REFUSAL_MARKER = 'Refused: a client certificate is configured';

function certRefusalText(host: string, origin: string): string {
  return (
    `${CERT_REFUSAL_MARKER} for ${host.replace(/^\[|\]$/g, '')}, and this request comes from a web page ` +
    `(Origin ${String(origin).slice(0, 200)}), not the app. Client certificates are only presented for the app's own requests.`
  );
}
