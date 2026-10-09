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
}

export interface Matcher {
  /** Case-insensitive; undefined (or '' / '*') = any. */
  method?: string;
  /** Glob on the full URL ("*" = any chars, case-sensitive), or /regex/flags. */
  url: string;
}

export type RuleAction =
  | { kind: 'mock'; status: number; headers?: Record<string, string>; body: string; delayMs?: number }
  | { kind: 'block'; mode: 'reset' | 'status'; status?: number } // reset = connection reset
  | { kind: 'breakpoint'; phase: 'request' | 'response' | 'both' };

export interface Rule {
  id: string;
  enabled: boolean;
  name?: string;
  match: Matcher;
  action: RuleAction;
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
}
