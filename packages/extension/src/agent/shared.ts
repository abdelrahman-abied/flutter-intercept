/**
 * Shared pieces of the agent API (QUALITY-1 Q5): its dependencies, the rule safety checks agents get, filters and
 * small helpers used by the tool modules (src/agent/tools/*) and the views. No vscode.
 */
import type { Body, Exchange, GrpcEdit, LearnedPassthrough, ReplayEntry, ReplayOptions, RequestEdit, ResponseEdit, Rule, RuleAction, SendRequest, StackFrame } from '@flutter-intercept/proxy';
import { type NetworkProfile } from '@flutter-intercept/proxy/network';
import { compileMatcher } from '@flutter-intercept/proxy/rules';
import type { CodegenService } from '../codegen/types';
import type { ContractResult, ContractService } from '../contract/types';
import type { AuthAnalysis } from '../analysis/types';
import type { RecordingService } from '../recordings/types';
import type { ToOpenApi, ToPostman } from '../export/types';
import type { Screenshot, ScreenshotTarget } from '../screenshot/types';
import type { SessionWarning } from '../ui/protocol';
import { isSensitiveField, REDACTED, redactQueryString } from './redact';
import { type GrpcDeps } from '../grpc/service';
import type { GrpcMethod, ProtoFieldType } from '../grpc/types';
import { parsePath, type PathSegment } from '@flutter-intercept/proxy/jsonpath';
import { FINAL_STATES } from './samples';
import { AgentAccess, AppLauncher } from './types';
export const AGENT_RULE_PREFIX = '[agent] ';
export { FINAL_STATES };
/** assert_traffic: at most this many failure texts in all, and JSON failure texts per exchange. */
export const MAX_ASSERT_FAILURES = 50;
export const MAX_JSON_FAILURES_PER_EXCHANGE = 10;
/** get_frames: total characters of frame text in one result (further frames → `more`, page with `next`). */
export const MAX_FRAME_RESULT_CHARS = 200_000;
/** CONTRACTS §16.4: get_request on a gRPC call — the first this many messages each way, at most this much JSON. */
export const GRPC_MESSAGES_PER_DIR = 20;
export const MAX_GRPC_MESSAGES_JSON = 64 * 1024;

export type Frame = NonNullable<Exchange['frames']>[number];

/** True when `path` selects something BELOW a sensitive key (a redacted field), e.g. `$.session.id`. */
export function insideRedacted(path: string): boolean {
  let segs: PathSegment[];
  try {
    segs = parsePath(path);
  } catch {
    return false; // reported as an invalid path by select()
  }
  return segs.slice(0, -1).some((s) => 'key' in s && isSensitiveField(s.key));
}

/** The throttle fields that are set (CONTRACTS §9.2; §14.4 `uploadKbps`). */
export function throttleFields(t: { latencyMs?: number; kbps?: number; uploadKbps?: number; dropRate?: number }): { latencyMs?: number; kbps?: number; uploadKbps?: number; dropRate?: number } {
  return {
    ...(t.latencyMs !== undefined ? { latencyMs: t.latencyMs } : {}),
    ...(t.kbps !== undefined ? { kbps: t.kbps } : {}),
    ...(t.uploadKbps !== undefined ? { uploadKbps: t.uploadKbps } : {}),
    ...(t.dropRate !== undefined ? { dropRate: t.dropRate } : {}),
  };
}

/** CONTRACTS §14.5: a recording's WebSocket / SSE stream and frame counts, when it has any. */
export function streamCounts(m: { streams?: number; frames?: number; grpc?: number }): { streams?: number; frames?: number; grpc?: number } {
  return {
    ...(typeof m.grpc === 'number' && m.grpc > 0 ? { grpc: m.grpc } : {}),
    ...(typeof m.streams === 'number' && m.streams > 0 ? { streams: m.streams } : {}),
    ...(typeof m.frames === 'number' && m.frames > 0 ? { frames: m.frames } : {}),
  };
}

/** CONTRACTS §9.4 (src/source/resolve.ts): a stack frame resolved to a file. `path` may be absolute. */
export type ResolvedFrame = StackFrame & { path?: string; inProject: boolean };
/** get_request_source's `uri` for frames outside the project that are not package/SDK URIs. */
export const OUTSIDE_PROJECT = '<outside project>';

/** What the agent API needs from the extension. */
export interface AgentApiDeps {
  /** The proxy host (InterceptProxyHost): exchanges, rules, resume/abort, and its 'exchange' event. */
  host: {
    readonly running: boolean;
    readonly port: number | undefined;
    getExchanges(): Exchange[];
    getRules(): Rule[];
    resume(id: string, edit?: RequestEdit | ResponseEdit | GrpcEdit): void;
    abort(id: string): void;
    on(event: 'exchange', listener: (e: Exchange) => void): unknown;
    off(event: 'exchange', listener: (e: Exchange) => void): unknown;
    // CONTRACTS §9.2 (InterceptProxyHost). Optional: older builds degrade to a clear tool error.
    send?(req: SendRequest): Promise<{ id: string }>;
    setNetworkProfile?(p: NetworkProfile): void;
    readonly networkProfile?: NetworkProfile;
    /** CONTRACTS §11.4 (InterceptProxyHost.warnings): traffic that is not intercepted. Optional on older builds. */
    readonly warnings?: SessionWarning[];
    // CONTRACTS §12.4 (InterceptProxyHost). Optional: without them replay_recording answers a clear error.
    readonly replay?: { id?: string; recording: string; fallback: 'passthrough' | 'fail' };
    setReplay?(entries: ReplayEntry[] | undefined, opts?: ReplayOptions, meta?: { id?: string; name: string }): void;
    /** REVIEW-6 #1 (InterceptProxyHost.upstreamProxyInfo): `host:port` of the upstream proxy, never credentials. */
    readonly upstreamProxyInfo?: { display: string; ignoreCertErrors: boolean };
    // CONTRACTS §14 (InterceptProxyHost). Optional on older builds.
    /** §14.6: `http.proxy` = the upstream proxy is VS Code's own setting (ours is empty). */
    readonly upstreamProxySource?: 'flutterIntercept' | 'http.proxy';
    /** §14.2: hostname globs whose TLS is passed through undecrypted. */
    readonly tlsPassthrough?: string[];
    /** §14.3: host pattern + problem per configured client certificate (never paths or key material). */
    readonly clientCertificateStatus?: { host: string; problem?: string }[];
    /** §20.2: hosts the proxy passes through on its own (read-only for agents: they can't forget them). */
    readonly learnedPassthrough?: Omit<LearnedPassthrough, 'grpc'>[];
    /** §20.7: false = servers are never passed through on their own (`flutterIntercept.autoPassthrough`). */
    readonly autoPassthrough?: boolean;
    // CONTRACTS §16.4 (InterceptProxyHost). Optional on older builds.
    readonly grpcDecryptHosts?: string[];
    readonly grpcProblem?: string;
    /** CONTRACTS §19.3 (InterceptProxyHost.simulatorTrust). */
    readonly simulatorTrust?: { devices: { udid: string; name?: string; state: string; problem?: string }[]; decryptAll: boolean };
    /** REVIEW-12 #1 (InterceptProxyHost.ownListeners). */
    readonly ownListeners?: { ports: number[]; hosts: string[] };
  };
  /**
   * CONTRACTS §9.4: resolves `package:` / `file:` frames to files (src/source/resolve.ts `resolveFrames` bound
   * to the project roots). Absolute paths inside `projectRoot()` are reported project-relative; others are
   * omitted. Without it, get_request_source returns the raw frames.
   */
  resolveFrames?(frames: StackFrame[]): ResolvedFrame[] | Promise<ResolvedFrame[]>;
  /** Controller-level rule update (validates, persists, broadcasts `rules` to the UI): `controller.applyRules`. */
  applyRules(rules: Rule[]): void;
  /** Controller-level clear (broadcasts `cleared` + snapshot): `controller.clear`. */
  clear(): void;
  /**
   * Live settings: `flutterIntercept.agent.access`, `...agent.redactSecrets`, `flutterIntercept.enabled`, and
   * (CONTRACTS §13.8) `...agent.screenshots` (absent = true).
   */
  getSettings(): { access: AgentAccess; redactSecrets: boolean; interceptEnabled: boolean; screenshots?: boolean };
  /** launch_app / stop_app / hot_restart and the session list for get_status (launch.ts). */
  launcher: AppLauncher;
  /** Project root for export_har (the workspace folder of the Flutter app); undefined = none open. */
  projectRoot(): string | undefined;
  /** Extension version for the HAR creator field. */
  version?: string;
  newRuleId?(): string;
  now?(): number;
  // ---- CONTRACTS §10.6 (v0.4.0). Optional: without them the tools answer with a clear "not available" error.
  /** The contract checker (src/contract/service.ts). */
  contract?: ContractService;
  /** The controller's cached result for an exchange (`controller.contractResult(id)`), reused when no model is forced. */
  contractResult?(id: string): ContractResult | undefined;
  /** Code generation (src/codegen/service.ts). */
  codegen?: CodegenService;
  /** The app's pubspec `name` (fixture imports). */
  appPackageName?(): string | undefined;
  // ---- CONTRACTS §12.7 (v0.6.0). Optional: without them the tools answer with a clear "not available" error.
  /** Recordings (src/recordings/store.ts). */
  recordings?: RecordingService;
  /** A recording was saved or replay started/stopped: `controller.refreshRecordings()` (the panel's list). */
  recordingsChanged?(): void;
  /** Auth-flow analysis (src/analysis/auth.ts `analyzeAuth`). */
  analyzeAuth?(exchanges: Exchange[]): AuthAnalysis;
  // ---- CONTRACTS §13.8 (v0.7.0). Optional: without them the tools answer with a clear "not available" error.
  /** OpenAPI / Postman builders (src/export/**, pure). */
  exporters?: { openapi?: ToOpenApi; postman?: ToPostman };
  /** Takes a screenshot of a session's device (src/screenshot/** `takeScreenshot` bound to its deps). */
  takeScreenshot?(target: ScreenshotTarget): Promise<Screenshot>;
  // ---- CONTRACTS §16.4 (v0.10.0). Optional: without it gRPC messages are shown raw and the gRPC tools say why.
  /** The gRPC schema service (src/grpc/service.ts). */
  grpc?: GrpcDeps;
}

/** take_screenshot: requests that started this long before the screenshot are listed with it. */
export const SCREENSHOT_RECENT_MS = 5000;
export const SCREENSHOT_RECENT_MAX = 10;
/** take_screenshot: larger images are saved but not sent inline. */
export const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

/** Loopback targets agents may map to (CONTRACTS §12.7). */
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * REVIEW-6 #4: headers agents may not set with add_rewrite (request or response): redirects and refreshes, cookies,
 * the browser's security policy (CSP, CORS), and the forwarding / override headers servers use to build links
 * (reset-link poisoning) or pick the method.
 */
export const AGENT_REWRITE_FORBIDDEN =
  /^(location|refresh|set-cookie|set-cookie2|content-security-policy(-report-only)?|access-control-.*|x-forwarded-.*|forwarded|host|x-host|x-original-url|x-rewrite-url|x-original-host|x-http-method-override|x-http-method|x-method-override)$/i;
/** REVIEW-6 #4: content types a browser runs (Flutter Web's debug Chrome trusts our CA): agents can't serve them. */
export const ACTIVE_CONTENT = /html|javascript|ecmascript|svg|xhtml/i;
export const LOOKS_HTML = /^\s*(<!doctype\s+html|<html|<head|<body|<script|<svg|<iframe)/i;
export const SCRIPTISH = /<\s*(script|iframe|object|embed|base|meta|link|form)\b|javascript:|\bon[a-z]+\s*=/i;

/** `https://api.example.com` for a glob whose scheme and host are literal, else undefined. */
export function globOrigin(glob: string): string | undefined {
  const m = /^(https?):\/\/([^/?#]+)/i.exec(glob.trim());
  if (!m || m[2].includes('*')) return undefined;
  try {
    return new URL(`${m[1]}://${m[2]}`).origin;
  } catch {
    return undefined;
  }
}

/**
 * REVIEW-6 #4: why an agent mock (or mock step) must not be served, or undefined. HTML / JavaScript / SVG content
 * (by content-type, or an untyped body that looks like HTML) is refused; a 3xx `Location` must stay on the match URL's
 * own origin (relative locations do) or go to loopback — dart:io follows redirects and re-sends custom credential
 * headers and the query to the new host.
 */
export function agentMockRefusal(matchUrl: string, status: number, headers: Record<string, string> | undefined, body: string): string | undefined {
  const get = (name: string) => Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
  const ct = get('content-type');
  if (ct !== undefined && ACTIVE_CONTENT.test(ct)) return `content-type "${ct.slice(0, 100)}" is refused for agents: a browser would run it (HTML, JavaScript or SVG)`;
  if (ct === undefined && LOOKS_HTML.test(body)) return 'the body looks like HTML; agents can only mock data responses (set a content-type such as application/json or text/plain)';
  if (status >= 300 && status <= 399) {
    const loc = get('location');
    if (loc !== undefined) {
      const base = globOrigin(matchUrl) ?? 'https://same-origin.invalid';
      let target: URL;
      try {
        target = new URL(loc.trim(), base);
      } catch {
        return `location "${loc.slice(0, 100)}" is not a valid URL`;
      }
      const sameOrigin = target.origin === new URL(base).origin;
      const loopback = (target.protocol === 'http:' || target.protocol === 'https:') && LOOPBACK_HOSTS.has(target.hostname.toLowerCase());
      if (!sameOrigin && !loopback) {
        return `a ${status} redirect to ${target.protocol === 'http:' || target.protocol === 'https:' ? target.origin : JSON.stringify(loc.slice(0, 100))} is refused for agents: redirects must stay on the request's own origin${globOrigin(matchUrl) ? ` (${globOrigin(matchUrl)})` : ' (use a relative location, or a url with a literal host)'} or go to localhost`;
      }
    }
  }
  return undefined;
}

export type StatusFilter = number | '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'error' | undefined;

export function statusMatches(e: Exchange, s: StatusFilter): boolean {
  if (s === undefined) return true;
  if (s === 'error') return e.state === 'error' || e.state === 'aborted';
  if (typeof s === 'number') return e.status === s;
  return e.status !== undefined && Math.floor(e.status / 100) === Number(s[0]);
}

/**
 * REVIEW-4 #1: a rule pattern that fixes the value of a sensitive query parameter (`*access_token=a*`) would let
 * an agent recover the redacted value through `matchedRuleId`. Returns the parameter name, or undefined.
 */
export function sensitiveQueryProbe(pattern: string): string | undefined {
  for (const m of pattern.matchAll(/(?:^|[?&*])([^?&=*#/]+)=([^&#]*)/g)) {
    let key = m[1];
    try {
      key = decodeURIComponent(key.replace(/\+/g, ' '));
    } catch {
      // keep raw
    }
    if (isSensitiveField(key) && m[2] !== '' && !m[2].startsWith('*')) return key;
  }
  return undefined;
}

export type ExchangeFilter = {
  url?: string;
  method?: string;
  status?: StatusFilter;
  sinceMs?: number;
  kind?: 'http' | 'websocket' | 'sse' | 'tunnel' | 'grpc';
  graphqlOperation?: string;
  /** CONTRACTS §11.3: the web browser's own traffic is excluded unless true. */
  includeBrowserInternal?: boolean;
};

/**
 * Compiles an agent filter once per tool call (REVIEW-4 #11). The URL glob is matched against `view(e.url)`,
 * the URL as the agent sees it (redacted when redaction is on), so a filter can't be used as an oracle for
 * redacted query values (REVIEW-4 #1).
 */
export function compileFilter(f: ExchangeFilter, view: (url: string) => string): (e: Exchange) => boolean {
  const url = f.url !== undefined ? compileMatcher({ url: f.url, method: f.method }) : undefined;
  const method = f.method?.toUpperCase();
  return (e) => {
    if (e.browserInternal && !f.includeBrowserInternal) return false;
    if (f.sinceMs !== undefined && e.startedAt < f.sinceMs) return false;
    if (url && !url(e.method, view(e.url))) return false;
    if (!url && method !== undefined && e.method.toUpperCase() !== method) return false;
    if (f.kind !== undefined && (e.kind ?? 'http') !== f.kind) return false;
    if (f.graphqlOperation !== undefined && e.graphql?.operationName !== f.graphqlOperation) return false;
    return statusMatches(e, f.status);
  };
}

export function bodyBytes(b: Body | undefined): number | undefined {
  if (!b) return undefined;
  return b.encoding === 'base64' ? Buffer.from(b.text, 'base64').length : Buffer.byteLength(b.text, 'utf8');
}


/** "unary", "server streaming", "client streaming" or "bidi streaming". */
export function streamingLabel(m: Pick<GrpcMethod, 'clientStreaming' | 'serverStreaming'>): string {
  return m.clientStreaming && m.serverStreaming ? 'bidi streaming' : m.serverStreaming ? 'server streaming' : m.clientStreaming ? 'client streaming' : 'unary';
}

/** A protobuf field type as text: `string`, `shop.v1.Item`, `enum shop.v1.Color`, `map<string, shop.v1.Item>`. */
export function protoTypeLabel(t: ProtoFieldType): string {
  switch (t.kind) {
    case 'scalar':
      return t.scalar;
    case 'enum':
      return `enum ${t.type}`;
    case 'message':
      return t.type;
    case 'map':
      return `map<${t.key}, ${protoTypeLabel(t.value)}>`;
    default:
      return 'unknown';
  }
}

/** Does this rule (or a sequence step) run a script? */
export function hasScript(rule: Rule): boolean {
  const a = rule.action as RuleAction | undefined;
  if (!a) return false;
  if (a.kind === 'script') return true;
  return a.kind === 'sequence' && (a.steps ?? []).some((s) => (s.action as { kind?: string })?.kind === 'script');
}

/** " (GraphQL GetUser)" for rule names. */
export function opLabel(i: { graphqlOperation?: string }): string {
  return i.graphqlOperation ? ` (GraphQL ${i.graphqlOperation})` : '';
}

export const isRedacted = (v: string) => v === REDACTED || v === encodeURIComponent(REDACTED);

/** JSON type name as assert_traffic uses it ("integer" is also a "number"). */
export function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string, boolean, object
}

export function typeMatches(v: unknown, want: string): boolean {
  const t = jsonType(v);
  return t === want || (want === 'number' && t === 'integer');
}

/** A value described without revealing it (assert_traffic failure texts). */
export function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array of ${v.length} item${v.length === 1 ? '' : 's'}`;
  switch (typeof v) {
    case 'string':
      return `a string of ${v.length} character${v.length === 1 ? '' : 's'}`;
    case 'number':
      return Number.isInteger(v) ? 'an integer' : 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return `an object with ${Object.keys(v as object).length} key${Object.keys(v as object).length === 1 ? '' : 's'}`;
    default:
      return typeof v;
  }
}

/** Structural JSON equality (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * An agent's JSON with every "[redacted]" string put back to `orig`'s value at the same path (the secret goes on
 * unchanged; the agent never learns it). Depth ≤ 64.
 */
export function restoreRedactedJson(v: unknown, orig: unknown, depth = 0): unknown {
  if (depth > 64) return v;
  if (v === REDACTED && orig !== undefined) return orig;
  if (Array.isArray(v)) return v.map((x, i) => restoreRedactedJson(x, Array.isArray(orig) ? orig[i] : undefined, depth + 1));
  if (v && typeof v === 'object') {
    const o = orig && typeof orig === 'object' && !Array.isArray(orig) ? (orig as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      Object.defineProperty(out, k, { value: restoreRedactedJson(x, Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

/** Header values the agent only saw as "[redacted]" get their original value back (dropped if there was none). */
export function restoreRedactedHeaders(edit: Record<string, string | string[]>, original: Record<string, string | string[]>): Record<string, string | string[]> {
  const byLower = new Map(Object.entries(original).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(edit)) {
    const all = Array.isArray(v) ? v : [v];
    if (all.length && all.every(isRedacted)) {
      const orig = byLower.get(k.toLowerCase());
      if (orig !== undefined) out[k] = orig;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Query parameters the agent only saw as "[redacted]" get the original URL's raw value back. */
export function restoreRedactedQuery(url: string, original: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hash = url.indexOf('#', q);
  const query = hash === -1 ? url.slice(q + 1) : url.slice(q + 1, hash);
  const tail = hash === -1 ? '' : url.slice(hash);
  const oq = original.indexOf('?');
  const origParts = oq === -1 ? [] : original.slice(oq + 1).split('#')[0].split('&');
  const used = new Set<number>();
  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return part;
    const key = part.slice(0, eq);
    if (!isRedacted(part.slice(eq + 1))) {
      // A value redacted only inside (GraphQL ?variables= JSON, ?query= document): the agent passed back exactly
      // what it saw → the original value.
      if (!part.includes(encodeURIComponent(REDACTED)) && !part.includes(REDACTED)) return part;
      const idx = origParts.findIndex((p, n) => !used.has(n) && p.startsWith(`${key}=`) && redactQueryString(p) === part);
      if (idx === -1) return part;
      used.add(idx);
      return origParts[idx];
    }
    const idx = origParts.findIndex((p, n) => !used.has(n) && p.startsWith(`${key}=`));
    if (idx === -1) return part;
    used.add(idx);
    return origParts[idx];
  });
  return `${url.slice(0, q + 1)}${parts.join('&')}${tail}`;
}
