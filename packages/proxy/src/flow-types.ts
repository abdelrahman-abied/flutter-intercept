// Types shared by the proxy and its flow modules (per-request routing, live exchanges, gRPC calls).

import * as http2 from 'http2';
import type { Readable } from 'stream';
import type * as mockttp from 'mockttp';
import type { OngoingRequest } from 'mockttp';
import { type HeaderBag } from './body';
import { type HostPattern } from './hosts';
import { GrpcMessageTransform } from './grpc';
import { GrpcWebRecorder, type GrpcWebVariant } from './grpc-web';
import { type CorsOptions } from './cors';
import { SseRecorder } from './sse';
import type { LearnVerdict } from './learn-flow';
import { type NetworkProfile } from './network';
import type {
  Exchange,
  FaultKind,
  Frame,
  GrpcInfo,
  ReplayEntry,
  RequestEdit,
  ResponseEdit,
  RewriteSpec,
  Rule,
  RuleAction,
} from './types';

/** The action a request gets: the rule's, or the current sequence step's (undefined = pass through). */
export type Applied = Exclude<RuleAction, { kind: 'sequence' }> | undefined;

export type RewriteAction = Extract<RuleAction, { kind: 'rewrite' }>;

export type ScriptAction = Extract<RuleAction, { kind: 'script' }>;

export interface RewriteFlow {
  request?: RewriteSpec;
  response?: RewriteSpec & { status?: number };
  /** Body replacements to apply (false when the body can't be held: streamed / too large). */
  reqBody: boolean;
  resBody: boolean;
}

export type CallbackRequestResult = mockttp.requestSteps.CallbackRequestResult;

export type CallbackResponseResult = mockttp.requestSteps.CallbackResponseResult;

export type CallbackResponseMessageResult = mockttp.requestSteps.CallbackResponseMessageResult;

export type PassThroughResponse = mockttp.requestSteps.PassThroughResponse;

export type Decision =
  | { kind: 'resume'; edit?: RequestEdit | ResponseEdit }
  | { kind: 'abort' }
  | { kind: 'gone' };
 // client disconnected or proxy stopped; exchange state already set

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
export type Route = 'plain' | 'h1' | 'h2' | 'denied' | 'trace' | 'ws-pass' | 'ws-local' | 'replay-stream' | 'ws-replay' | 'tunnel' | 'grpc';

/** A fault applied to a request: a fault rule, the `offline` profile ('dns'), or a throttle drop ('drop' = reset). */
export type FlowFault = FaultKind | 'drop';

export interface SendMeta {
  initiator: 'editor' | 'agent';
  resentFrom?: string;
  /** Resolves send() once the exchange is recorded. */
  recorded(id: string): void;
  done: boolean;
}

export interface Flow {
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
  /** CONTRACTS §18.6: a gRPC call that came back from our own relay: answered 14, never recorded. */
  loop?: boolean;
  /** CONTRACTS §19.1: a gRPC-Web call (an HTTP flow shown as gRPC). */
  grpcWeb?: GrpcWebVariant;
  /** REVIEW-8 #1: answer 403 with this text — a web page's request to a client-certificate host. */
  refused?: string;
  /** Hooked routes: the Host header to send when it isn't the URL's (preserveHost, a rewritten Host). */
  wantHost?: string;
  /** mockttp's timing events of the request (CONTRACTS §13.2 `requestMs`). */
  te?: RequestTimingEvents;
  /** CONTRACTS §20.1: the verdict on an upstream refusal (started at the response head; a probe may be running). */
  learn?: Promise<LearnVerdict | undefined>;
  /** CONTRACTS §20.1: an HTTPS 400 page that may be nginx's "No required SSL certificate was sent". */
  maybeNginx?: boolean;
  /** REVIEW-14 #1: the server the app's connection goes to (the CONNECT target), for HTTPS requests. */
  dest?: { host: string; port: number };
}

/** The part of mockttp's TimingEvents we read (high-resolution `performance.now()` timestamps). */
export interface RequestTimingEvents {
  startTimestamp?: number;
  bodyReceivedTimestamp?: number;
}

/** Recording state of a WebSocket / event stream. */
export interface StreamState {
  sse?: SseRecorder;
  /** The 'ws-upgrade' hook attached to the connection (frames are recorded). */
  wsDirect?: boolean;
  /** The server's side closed first: its close code / reason. */
  serverClose?: { code: number; reason: Buffer };
  /** A message over WS_MAX_MESSAGE_BYTES (REVIEW-5 #1): from the server (receive) or the app (send). */
  tooBig?: Frame['dir'];
}

export interface MatchOptions {
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
  /** A gRPC call (CONTRACTS §16.2): only grpcMock, block, fault, throttle and sequences of those apply. */
  grpc?: boolean;
  /** A gRPC-Web call (CONTRACTS §19.1): an HTTP request for which grpcMock rules apply too. */
  grpcWeb?: boolean;
}

export interface MatchResult {
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

export interface ReqMeta {
  traceId?: string;
  sendNonce?: string;
  /** CONTRACTS §18.6: the hop marker a gRPC call arrived with (one of ours = a loop). */
  hop?: string;
}

export interface Live {
  ex: Exchange;
  flow: Flow;
  stream?: StreamState;
}

export interface Paused {
  phase: 'request' | 'response';
  settle: (d: Decision) => void;
}

/** One gRPC call through the relay / a local answer (CONTRACTS §16.2). */
export interface GrpcCall {
  ex: Exchange;
  info: GrpcInfo;
  flow: Flow;
  req: OngoingRequest;
  /** The app's stream. */
  stream: http2.ServerHttp2Stream;
  /** The server's stream (relay). */
  up?: http2.ClientHttp2Stream;
  upError?: Error & { code?: string };
  /** The server's trailers, once they arrived. */
  upTrailers?: http2.IncomingHttpHeaders;
  /** Trailers to end the app's response with when the server's connection failed mid-response. */
  failTrailers?: Record<string, string>;
  failReason?: string;
  /** The last stream piped into the app's stream (unpiped on a failure). */
  respTail?: Readable;
  /** The proxy reset / ended the app's stream itself: its close is not the app leaving. */
  localReset?: boolean;
  /** Response headers time (receiveMs). */
  headAt?: number;
  /** CONTRACTS §17.2: pauses of this call, one at a time (a message per direction, then the end). */
  pauseChain?: Promise<unknown>;
  /** A response-phase breakpoint: the end of the call (its status) is paused too. */
  statusPause?: boolean;
  /** Hooked links (destroyed with the call, releasing their budget). */
  transforms?: GrpcMessageTransform[];
  /** CONTRACTS §18.2: the script's gRPC hooks for this call, and how many messages it has seen. */
  scriptStatus?: boolean;
  scriptCalls?: number;
  /** REVIEW-11 #6: codec work spent on this call by mutate (bytes decoded, ms). */
  mutateBytes?: number;
  mutateMs?: number;
  mutateStopped?: boolean;
  isLive(): boolean;
}

/** On a silent tunnel's raw socket: what its CONNECT said (CONTRACTS §16.2). */
export const SILENT_INFO = Symbol('flutter-intercept.silent-tunnel');

export interface SilentInfo {
  connectTimeoutMs: number;
}

export type ThrottleProfile = Extract<NetworkProfile, { kind: 'throttle' }>;

/** Minimal shape of the `ws` WebSocket objects mockttp hands over in its 'ws-upgrade' socket event. */
export interface WsLike {
  on(event: 'message', l: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'ping' | 'pong', l: (data: Buffer) => void): unknown;
  on(event: 'error', l: (e: Error & { code?: string }) => void): unknown;
  once(event: 'close', l: (code: number, reason: Buffer) => void): unknown;
  close(code?: number, reason?: string): void;
  upstreamWebSocket?: WsLike;
}

/** CONTRACTS §19.1: what the reader of one gRPC-Web call collected (moved onto the exchange by syncGrpcWeb). */
export interface GrpcWebState {
  rec: GrpcWebRecorder;
  sent: number;
  received: number;
  /** Frames recorded / compressed messages decompressed, per direction. */
  recorded: Record<Frame['dir'], number>;
  compressed: Record<Frame['dir'], number>;
  /** The call is forgotten: nothing more is queued. */
  forgotten?: boolean;
  syncScheduled?: boolean;
  queue: Frame[];
  notes: string[];
  reqEnc?: string;
  resEnc?: string;
  trailers?: Record<string, string | string[]>;
  headStatus?: { code?: number; message?: string };
}

export interface HeaderSets {
  /** Lower-case names removed (set names are removed too, before being added). */
  remove: string[];
  set: Array<[string, string]>;
}

export type ReplaceOutcome = { kind: 'skipped'; reason: string } | { kind: 'done'; decoded: Buffer; unmatched: number };

// ---------------------------------------------------------------- v0.8.0 helpers (CONTRACTS §14)

/** A usable client certificate (CONTRACTS §14.3). `options` go into the upstream TLS options; never logged. */
export interface LoadedCert {
  pattern: HostPattern;
  /** The pattern as configured (Exchange.clientCertificate). */
  host: string;
  options: { pfx?: Buffer; cert?: string; key?: string; passphrase?: string };
}

export interface PacedWs {
  readyState: number;
  send(data: unknown, opts?: unknown, cb?: unknown): void;
  ping(data?: unknown, mask?: unknown, cb?: unknown): void;
  pong(data?: unknown, mask?: unknown, cb?: unknown): void;
  close(code?: number, reason?: unknown): void;
  pause?(): void;
  resume?(): void;
  once(event: 'close', l: () => void): unknown;
}

