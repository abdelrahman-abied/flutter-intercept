// Types from docs/CONTRACTS.md §3. Keep in sync with the contract.

export type BodyEncoding = 'utf8' | 'base64';

/** Decompressed body for display. Capped at 5 MB (`truncated` set when cut). */
export interface Body {
  text: string;
  encoding: BodyEncoding;
  truncated?: boolean;
}

export type ExchangeState =
  | 'pending'
  | 'paused-request'
  | 'paused-response'
  | 'completed'
  | 'mocked'
  | 'blocked'
  | 'aborted'
  | 'error';

export interface Exchange {
  id: string;
  startedAt: number; // epoch ms
  durationMs?: number;
  method: string;
  url: string; // absolute, https://host/path?query
  requestHeaders: Record<string, string | string[]>;
  requestBody?: Body;
  status?: number;
  responseHeaders?: Record<string, string | string[]>;
  responseBody?: Body;
  state: ExchangeState;
  pausedAt?: number; // epoch ms, set while paused-*
  pauseDeadline?: number; // epoch ms when breakpointTimeoutMs auto-resumes
  matchedRuleId?: string;
  error?: string;
  /** CONTRACTS §9.2: the app call site, once the entry's trace and the request meet. */
  source?: SourceInfo;
  /** Who sent it when not the app (CONTRACTS §9.2 `send`). */
  initiator?: 'editor' | 'agent';
  /** Id of the exchange this one was resent from. */
  resentFrom?: string;
  /** Set when the client came through the LAN listener (physical iPhone, CONTRACTS §7). */
  viaLan?: true;
  // CONTRACTS §11 (v0.5.0)
  /** absent = plain HTTP. websocket = an upgraded connection; sse = a text/event-stream response. */
  kind?: 'websocket' | 'sse';
  /** WebSocket messages / SSE events, oldest first; the newest `maxFramesPerExchange` are kept. */
  frames?: Frame[];
  /** Frames dropped (oldest) beyond the cap. */
  framesDropped?: number;
  /** Detected GraphQL operation (POST JSON `{query, operationName}`, GET `?query=`, persisted-query extensions). */
  graphql?: GraphqlInfo;
  /** CORS diagnosis for browser requests (they carry `Origin`): Flutter Web. */
  cors?: CorsInfo;
  /** How it was captured. absent = through the proxy. `vm-profile` = read-only, from the app's HTTP profile
   * (native clients such as cupertino_http / cronet_http that bypass the proxy); rules never apply to it. */
  captured?: 'vm-profile';
  /** Flutter Web: the browser's own traffic (updates, GCM, optimization guide), not the app's — hidden by default. */
  browserInternal?: true;
  /** Human label when a throttle / fault / network profile affected it (e.g. "Slow 3G: +400 ms, 400 kbps"). */
  simulated?: string;
}

export interface Frame {
  dir: 'send' | 'receive';         // send = app → server
  at: number;                      // epoch ms
  kind: 'text' | 'binary' | 'ping' | 'pong' | 'close' | 'event'; // event = one SSE event
  text?: string;                   // text / event data, ≤ 64 KB (then `truncated`)
  base64?: string;                 // binary, ≤ 64 KB
  size: number;                    // full payload bytes
  truncated?: true;
  event?: string;                  // SSE `event:` name
  id?: string;                     // SSE `id:`
  closeCode?: number;              // close frames
}

export interface GraphqlInfo {
  operationName?: string;
  operationType?: 'query' | 'mutation' | 'subscription';
  persisted?: true;                // persisted-query hash, no query text
  batch?: number;                  // batched array: number of operations (the fields describe the first)
}

export interface CorsInfo {
  preflight?: true;                // this exchange IS an OPTIONS preflight
  /** Why a browser would block it (absent = looks fine), e.g. "no Access-Control-Allow-Origin for http://localhost:5000". */
  problem?: string;
  /** Set when the proxy answered or patched CORS itself (a mock's preflight, a `cors` rule). */
  patched?: true;
}

/** One parsed Dart stack frame. `line`/`column` are 1-based as Dart prints them. */
export interface StackFrame {
  fn: string;
  uri: string; // package:app/x.dart, file:///…, dart:async, …
  line?: number;
  column?: number;
  /** An `<asynchronous suspension>` / async gap precedes this frame. */
  afterAsyncGap?: boolean;
}

export interface SourceInfo {
  frames: StackFrame[]; // ≤ 30
  appFrame?: number; // index into frames of the app's call site
}

export interface Matcher {
  /** Case-insensitive; undefined (or '' / '*') = any. */
  method?: string;
  /** Glob on the full URL ("*" = any chars, case-sensitive), or /regex/flags. */
  url: string;
  /** CONTRACTS §11: also require this GraphQL operation name (exact, case-sensitive). */
  graphqlOperation?: string;
}

export type RuleAction =
  | { kind: 'mock'; status: number; headers?: Record<string, string>; body: string; delayMs?: number }
  | { kind: 'block'; mode: 'reset' | 'status'; status?: number } // reset = connection reset
  | { kind: 'breakpoint'; phase: 'request' | 'response' | 'both' }
  // CONTRACTS §9.2. throttle passes through to the real server, slowed; dropRate 0–1 = share reset instead.
  | { kind: 'throttle'; latencyMs?: number; kbps?: number; dropRate?: number }
  | { kind: 'fault'; fault: FaultKind }
  // CONTRACTS §10.2: the real response, with JSON fields changed (reproduce "Null is not a subtype…").
  | { kind: 'mutate'; ops: MutateOp[] }
  // CONTRACTS §11: pass through, but answer CORS preflights locally and add CORS headers to the response
  // (development only — the real server's CORS policy is NOT fixed by this).
  | { kind: 'cors'; allowOrigin?: string; allowCredentials?: boolean };

/**
 * One change to a JSON response body. `path` is the JSON path subset of `@flutter-intercept/proxy/jsonpath`
 * (`$.user.avatar_url`, `$.items[0].id`, `$.items[*].price`, `$['odd key']`). `set` = replace with `value`
 * (any JSON, e.g. `"42"` to retype a number as a string); `null` = set to null; `delete` = remove the key /
 * array element.
 */
export interface MutateOp {
  path: string;
  op: 'null' | 'delete' | 'set';
  value?: unknown;
  /**
   * For `set`: the new value as JSON text, written into the body byte-exact (`1.0` stays a double for Dart,
   * ints past 2^53 stay exact). Wins over `value` when both are present; must parse as JSON.
   */
  valueJson?: string;
}

export type FaultKind = 'reset' | 'timeout' | 'truncate' | 'dns';

export interface Rule {
  id: string;
  enabled: boolean;
  name?: string;
  match: Matcher;
  action: RuleAction;
  /** Applies to the first N matching requests, then is spent (CONTRACTS §9.2). */
  times?: number;
  /** Epoch ms after which the rule is spent. */
  expiresAt?: number;
  /** Read-only, set by the host for rules with `times`: matching requests so far. Never persisted; ignored by setRules. */
  used?: number;
}

/** CONTRACTS §9.2 `InterceptProxy.send`. */
export interface SendRequest {
  method: string;
  url: string;
  headers?: Record<string, string | string[]>;
  body?: string;
  initiator: 'editor' | 'agent';
  resentFrom?: string;
}

// `headers`, when present, REPLACES the whole header set. `body` is the decoded text;
// the proxy re-encodes per content-encoding and recomputes content-length.
export interface RequestEdit {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
}

export interface ResponseEdit {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string;
}

export interface InterceptProxyOptions {
  port: number; // 0 = pick a free port
  host?: string; // default 127.0.0.1
  maxExchanges?: number; // ring buffer, default 1000
  breakpointTimeoutMs?: number; // auto-resume unedited after this, default 5 min
  ca?: { key: string; cert: string }; // PEM; generated in memory if absent
  /**
   * Extension to the contract (requested). Skip upstream certificate verification for all
   * hosts (true) or the listed hostnames. Default false: the proxy verifies real servers, so
   * the app does not silently lose TLS verification because it trusts the proxy.
   */
  ignoreUpstreamCertErrors?: boolean | string[];
  /**
   * Extension to the contract (requested). Byte budget for bodies kept in the ring buffer
   * (display text, request + response); oldest finished exchanges are evicted beyond it.
   * Default 256 MB.
   */
  maxStoredBodyBytes?: number;
  /**
   * CONTRACTS §9.2. Loopback clients only: connect 10.0.2.2 / 10.0.3.2 targets (emulator aliases for the
   * host) to 127.0.0.1. Default true. LAN clients keep the §7 SSRF guard.
   */
  rewriteLocalhost?: boolean;
  /** CONTRACTS §11: keep at most this many frames per WebSocket / SSE exchange (newest kept). Default 500. */
  maxFramesPerExchange?: number;
}
