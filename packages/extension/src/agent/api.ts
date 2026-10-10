/**
 * The single implementation of the agent tools (CONTRACTS §8). The MCP server and the VS Code
 * language model tools only translate to `call(tool, input)`. No `vscode` import: everything it
 * needs comes in through `AgentApiDeps` (wired by extension.ts).
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Body, Exchange, Matcher, ReplayEntry, ReplayOptions, RequestEdit, ResponseEdit, Rule, RuleAction, SendRequest, StackFrame } from '@flutter-intercept/proxy';
import { describeProfile, NETWORK_PRESETS, presetProfile, type NetworkPresetId, type NetworkProfile } from '@flutter-intercept/proxy/network';
import { compileMatcher } from '@flutter-intercept/proxy/rules';
import { toSnippet } from '../codegen/snippets';
import type { CodegenService } from '../codegen/types';
import type { ContractResult, ContractService } from '../contract/types';
import type { AuthAnalysis } from '../analysis/types';
import type { RecordingService } from '../recordings/types';
import type { ExportResult, ToOpenApi, ToPostman } from '../export/types';
import type { Screenshot, ScreenshotTarget } from '../screenshot/types';
import { checkMapTarget, expireTokenRule, fixtureApi, isRecordable, readOnlyReason, sanitizeSendHeaders, tunnelReason, validateEdit, validateRule } from '../ui/controller';
import type { SessionWarning } from '../ui/protocol';
import { buildHar, writeExportFile, writeHar } from './har';
import { pathError, select } from './paths';
import { corsPolicyShort, urlGlobHasHost } from './corsPolicy';
import { isSensitiveField, isSensitiveHeader, REDACTED, redactBody, redactBodyText, redactLogLine, redactFrameText, redactHeaders, redactQueryString, redactSecretValues, redactText, redactUrl } from './redact';
import { parsePath, type PathSegment } from '@flutter-intercept/proxy/jsonpath';
import {
  contractForAgent,
  decodeJson,
  decodeSample,
  defaultFixtureName,
  defaultModelName,
  FINAL_STATES,
  looksJson,
  MAX_FIXTURES,
  modelSamples,
  redactExchange,
  redactJsonValue,
  routeOf,
  testPackageFor,
} from './samples';
import { MAX_DIFF_ENTRIES, parseToolInput, ToolInput, TRIGGER_WINDOW_MS } from './schema';
import { bodyShape } from './shape';
import { AgentAccess, AgentTools, AgentToolError, AppLauncher, isWriteTool, TOOL_IMAGES, ToolImage, ToolName, ToolResult } from './types';

export const AGENT_RULE_PREFIX = '[agent] ';
export { FINAL_STATES };
/** assert_traffic: at most this many failure texts in all, and JSON failure texts per exchange. */
export const MAX_ASSERT_FAILURES = 50;
export const MAX_JSON_FAILURES_PER_EXCHANGE = 10;
/** get_frames: total characters of frame text in one result (further frames → `more`, page with `next`). */
export const MAX_FRAME_RESULT_CHARS = 200_000;

type Frame = NonNullable<Exchange['frames']>[number];

/** True when `path` selects something BELOW a sensitive key (a redacted field), e.g. `$.session.id`. */
function insideRedacted(path: string): boolean {
  let segs: PathSegment[];
  try {
    segs = parsePath(path);
  } catch {
    return false; // reported as an invalid path by select()
  }
  return segs.slice(0, -1).some((s) => 'key' in s && isSensitiveField(s.key));
}

/** The throttle fields that are set (CONTRACTS §9.2; §14.4 `uploadKbps`). */
function throttleFields(t: { latencyMs?: number; kbps?: number; uploadKbps?: number; dropRate?: number }): { latencyMs?: number; kbps?: number; uploadKbps?: number; dropRate?: number } {
  return {
    ...(t.latencyMs !== undefined ? { latencyMs: t.latencyMs } : {}),
    ...(t.kbps !== undefined ? { kbps: t.kbps } : {}),
    ...(t.uploadKbps !== undefined ? { uploadKbps: t.uploadKbps } : {}),
    ...(t.dropRate !== undefined ? { dropRate: t.dropRate } : {}),
  };
}

/** CONTRACTS §14.5: a recording's WebSocket / SSE stream and frame counts, when it has any. */
function streamCounts(m: { streams?: number; frames?: number }): { streams?: number; frames?: number } {
  return {
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
    resume(id: string, edit?: RequestEdit | ResponseEdit): void;
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
}

/** take_screenshot: requests that started this long before the screenshot are listed with it. */
export const SCREENSHOT_RECENT_MS = 5000;
export const SCREENSHOT_RECENT_MAX = 10;
/** take_screenshot: larger images are saved but not sent inline. */
export const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

/** Loopback targets agents may map to (CONTRACTS §12.7). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * REVIEW-6 #4: headers agents may not set with add_rewrite (request or response): redirects and refreshes, cookies,
 * the browser's security policy (CSP, CORS), and the forwarding / override headers servers use to build links
 * (reset-link poisoning) or pick the method.
 */
export const AGENT_REWRITE_FORBIDDEN =
  /^(location|refresh|set-cookie|set-cookie2|content-security-policy(-report-only)?|access-control-.*|x-forwarded-.*|forwarded|host|x-host|x-original-url|x-rewrite-url|x-original-host|x-http-method-override|x-http-method|x-method-override)$/i;
/** REVIEW-6 #4: content types a browser runs (Flutter Web's debug Chrome trusts our CA): agents can't serve them. */
const ACTIVE_CONTENT = /html|javascript|ecmascript|svg|xhtml/i;
const LOOKS_HTML = /^\s*(<!doctype\s+html|<html|<head|<body|<script|<svg|<iframe)/i;
const SCRIPTISH = /<\s*(script|iframe|object|embed|base|meta|link|form)\b|javascript:|\bon[a-z]+\s*=/i;

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

type StatusFilter = number | '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'error' | undefined;

function statusMatches(e: Exchange, s: StatusFilter): boolean {
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

type ExchangeFilter = {
  url?: string;
  method?: string;
  status?: StatusFilter;
  sinceMs?: number;
  kind?: 'http' | 'websocket' | 'sse' | 'tunnel';
  graphqlOperation?: string;
  /** CONTRACTS §11.3: the web browser's own traffic is excluded unless true. */
  includeBrowserInternal?: boolean;
};

/**
 * Compiles an agent filter once per tool call (REVIEW-4 #11). The URL glob is matched against `view(e.url)`,
 * the URL as the agent sees it (redacted when redaction is on), so a filter can't be used as an oracle for
 * redacted query values (REVIEW-4 #1).
 */
function compileFilter(f: ExchangeFilter, view: (url: string) => string): (e: Exchange) => boolean {
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

function bodyBytes(b: Body | undefined): number | undefined {
  if (!b) return undefined;
  return b.encoding === 'base64' ? Buffer.from(b.text, 'base64').length : Buffer.byteLength(b.text, 'utf8');
}

export class AgentApi implements AgentTools {
  private readonly listeners = new Set<(e: { tool: ToolName; at: number; ok: boolean }) => void>();
  /** Time captured just before the latest launch_app/hot_restart triggered through this API. */
  private lastTriggerAt?: number;

  constructor(private readonly deps: AgentApiDeps) {}

  get access(): AgentAccess {
    return this.deps.getSettings().access;
  }

  onDidCall(listener: (e: { tool: ToolName; at: number; ok: boolean }) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async call(tool: ToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    let ok = false;
    try {
      const access = this.access;
      if (access === 'off') throw new AgentToolError('Flutter Intercept agent access is off (setting flutterIntercept.agent.access).', 'access');
      if (isWriteTool(tool) && access !== 'readWrite') {
        throw new AgentToolError(`"${tool}" changes app traffic or sessions, but agent access is read-only (setting flutterIntercept.agent.access).`, 'access');
      }
      let parsed: unknown;
      try {
        parsed = parseToolInput(tool, input);
      } catch (e) {
        throw new AgentToolError((e as Error).message, 'invalid');
      }
      const result = await this.dispatch(tool, parsed, signal);
      ok = true;
      return result;
    } catch (e) {
      if (e instanceof AgentToolError) throw e;
      throw new AgentToolError(`${tool} failed: ${(e as Error)?.message ?? String(e)}`, 'internal');
    } finally {
      const ev = { tool, at: this.now(), ok };
      for (const l of this.listeners) {
        try {
          l(ev);
        } catch {
          // a listener must never break a tool call
        }
      }
    }
  }

  // ------------------------------------------------------------------ dispatch

  private dispatch(tool: ToolName, input: unknown, signal?: AbortSignal): Promise<ToolResult> | ToolResult {
    switch (tool) {
      case 'get_status':
        return this.getStatus();
      case 'list_requests':
        return this.listRequests(input as ToolInput<'list_requests'>);
      case 'get_request':
        return this.getRequest(input as ToolInput<'get_request'>);
      case 'wait_for_request':
        return this.waitForRequest(input as ToolInput<'wait_for_request'>, signal);
      case 'list_paused':
        return this.listPaused();
      case 'list_rules':
        return { rules: this.deps.host.getRules().map((r) => this.ruleView(r)) };
      case 'export_har':
        return this.exportHar(input as ToolInput<'export_har'>);
      case 'add_mock':
        return this.addMock(input as ToolInput<'add_mock'>);
      case 'add_block':
        return this.addBlock(input as ToolInput<'add_block'>);
      case 'add_breakpoint':
        return this.addBreakpoint(input as ToolInput<'add_breakpoint'>);
      case 'remove_rule':
        return this.removeRule(input as ToolInput<'remove_rule'>);
      case 'resume_request':
        return this.resume(input as ToolInput<'resume_request'>);
      case 'abort_request':
        return this.abortRequest(input as ToolInput<'abort_request'>);
      case 'clear_requests':
        return this.clearRequests();
      case 'launch_app': {
        const i = input as ToolInput<'launch_app'>;
        return this.triggered(() => this.deps.launcher.launch({ deviceId: i.deviceId, program: i.program, flutterMode: i.flutterMode }));
      }
      case 'stop_app':
        return this.deps.launcher.stop((input as ToolInput<'stop_app'>).sessionId);
      case 'hot_restart':
        return this.triggered(() => this.deps.launcher.hotRestart((input as ToolInput<'hot_restart'>).sessionId));
      case 'get_request_source':
        return this.getRequestSource(input as ToolInput<'get_request_source'>);
      case 'get_body_shape':
        return this.getBodyShape(input as ToolInput<'get_body_shape'>);
      case 'simulate_network':
        return this.simulateNetwork(input as ToolInput<'simulate_network'>);
      case 'resend_request':
        return this.resendRequest(input as ToolInput<'resend_request'>);
      case 'check_contract':
        return this.checkContract(input as ToolInput<'check_contract'>);
      case 'generate_model':
        return this.generateModel(input as ToolInput<'generate_model'>);
      case 'generate_fixture_test':
        return this.generateFixtureTest(input as ToolInput<'generate_fixture_test'>);
      case 'assert_traffic':
        return this.assertTraffic(input as ToolInput<'assert_traffic'>, signal);
      case 'add_mutation':
        return this.addMutation(input as ToolInput<'add_mutation'>);
      case 'get_frames':
        return this.getFrames(input as ToolInput<'get_frames'>);
      case 'add_cors_rule':
        return this.addCorsRule(input as ToolInput<'add_cors_rule'>);
      // CONTRACTS §12.7
      case 'list_recordings':
        return this.listRecordings();
      case 'diff_recordings':
        return this.diffRecordings(input as ToolInput<'diff_recordings'>);
      case 'get_auth_flows':
        return this.getAuthFlows(input as ToolInput<'get_auth_flows'>);
      case 'save_recording':
        return this.saveRecording(input as ToolInput<'save_recording'>);
      case 'replay_recording':
        return this.replayRecording(input as ToolInput<'replay_recording'>);
      case 'add_sequence':
        return this.addSequence(input as ToolInput<'add_sequence'>);
      case 'expire_token':
        return this.expireToken(input as ToolInput<'expire_token'>);
      case 'add_map_remote':
        return this.addMapRemote(input as ToolInput<'add_map_remote'>);
      case 'add_rewrite':
        return this.addRewrite(input as ToolInput<'add_rewrite'>);
      // CONTRACTS §13.8
      case 'export_openapi':
        return this.exportSpec('openapi', input as ToolInput<'export_openapi'>);
      case 'export_postman':
        return this.exportSpec('postman', input as ToolInput<'export_postman'>);
      case 'take_screenshot':
        return this.takeScreenshot(input as ToolInput<'take_screenshot'>);
      default:
        throw new AgentToolError(`unknown tool ${String(tool)}`, 'invalid');
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Runs a launch/restart and records the time captured just BEFORE it was triggered, so a following
   * wait_for_request also sees requests the app sent before the wait began (the restarted app is fast).
   */
  private async triggered(run: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
    const sinceMs = this.now();
    const result = await run();
    this.lastTriggerAt = sinceMs;
    return { ...result, sinceMs };
  }

  /** wait_for_request's default `sinceMs`: the latest trigger if within TRIGGER_WINDOW_MS, else now. */
  private defaultSince(): number {
    const now = this.now();
    return this.lastTriggerAt !== undefined && now - this.lastTriggerAt <= TRIGGER_WINDOW_MS ? this.lastTriggerAt : now;
  }

  private get redact(): boolean {
    return this.deps.getSettings().redactSecrets;
  }

  // ------------------------------------------------------------------ views

  private url(u: string): string {
    return this.redact ? redactUrl(u) : u;
  }

  /** Free text that may embed URLs or tokens (`error`, `cors.problem`): REVIEW-5 #5. */
  private text(t: string): string {
    return this.redact ? redactText(t) : t;
  }

  /** An exchange filter for this call (compiled once; matches the agent's view of the URL). */
  private filter(f: ExchangeFilter): (e: Exchange) => boolean {
    const view = this.redact ? redactUrl : (u: string) => u;
    return compileFilter(f, view);
  }

  private bodyView(b: Body | undefined, headers: Exchange['requestHeaders'] | undefined, maxChars: number): Record<string, unknown> | undefined {
    if (!b) return undefined;
    // CONTRACTS §14.6: a binary multipart/form-data body is shown parsed (fields redacted, files summarised).
    if (b.encoding === 'base64' && this.redact) {
      const parsed = redactBody(b, headers);
      if (parsed.encoding === 'utf8') {
        const cut = parsed.text.length > maxChars;
        return { text: cut ? parsed.text.slice(0, maxChars) : parsed.text, multipart: true, ...(cut || b.truncated ? { truncated: true } : {}), ...(cut ? { totalChars: parsed.text.length } : {}) };
      }
    }
    if (b.encoding === 'base64') {
      const n = Buffer.from(b.text, 'base64').length;
      return { text: `[binary ${n} bytes]`, binary: true, bytes: n, ...(b.truncated ? { truncated: true } : {}) };
    }
    const text = this.redact ? redactBodyText(b.text, headers) : b.text;
    const cut = text.length > maxChars;
    return { text: cut ? text.slice(0, maxChars) : text, ...(cut || b.truncated ? { truncated: true } : {}), ...(cut ? { totalChars: text.length } : {}) };
  }

  private summary(e: Exchange): Record<string, unknown> {
    return {
      id: e.id,
      method: e.method,
      url: this.url(e.url),
      ...(e.status !== undefined ? { status: e.status } : {}),
      state: e.state,
      ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      startedAt: e.startedAt,
      ...(e.responseBody ? { responseBytes: bodyBytes(e.responseBody) } : {}),
      ...(e.matchedRuleId ? { matchedRuleId: e.matchedRuleId } : {}),
      ...(e.initiator ? { initiator: e.initiator } : {}),
      ...(e.simulated ? { simulated: e.simulated } : {}),
      // CONTRACTS §11.5
      ...(e.kind ? { kind: e.kind } : {}),
      ...(e.graphql?.operationName ? { graphqlOperation: e.graphql.operationName } : {}),
      ...(e.cors?.problem ? { corsProblem: true } : {}),
      ...(e.captured ? { captured: e.captured } : {}),
      ...(e.browserInternal ? { browserInternal: true } : {}),
      // CONTRACTS §14.2 / §14.3
      ...(e.kind === 'tunnel' ? { notDecrypted: true, ...(e.tunnelBytes ? { bytesSent: e.tunnelBytes.sent, bytesReceived: e.tunnelBytes.received } : {}) } : {}),
      ...(e.clientCertificate ? { clientCertificate: e.clientCertificate } : {}),
    };
  }

  private detail(e: Exchange, includeBodies: boolean, maxBodyChars: number): Record<string, unknown> {
    const reqH = this.redact ? redactHeaders(e.requestHeaders) : e.requestHeaders;
    const resH = this.redact ? redactHeaders(e.responseHeaders) : e.responseHeaders;
    return {
      ...this.summary(e),
      requestHeaders: reqH ?? {},
      ...(resH ? { responseHeaders: resH } : {}),
      ...(includeBodies && e.requestBody ? { requestBody: this.bodyView(e.requestBody, e.requestHeaders, maxBodyChars) } : {}),
      ...(includeBodies && e.responseBody ? { responseBody: this.bodyView(e.responseBody, e.responseHeaders, maxBodyChars) } : {}),
      ...(e.pausedAt ? { pausedAt: e.pausedAt } : {}),
      ...(e.pauseDeadline ? { pauseDeadline: e.pauseDeadline } : {}),
      ...(e.error ? { error: this.text(e.error) } : {}),
      ...(e.resentFrom ? { resentFrom: e.resentFrom } : {}),
      ...(e.source?.frames?.length ? { hasSource: true } : {}),
      // CONTRACTS §11.5: frames are read with get_frames.
      ...(e.kind === 'websocket' || e.kind === 'sse' ? { frameCount: e.frames?.length ?? 0 } : {}),
      // CONTRACTS §14.2: a passed-through TLS connection has no request / response to show — say why.
      ...(e.kind === 'tunnel' ? { tunnel: { notDecrypted: tunnelReason(e), bytesSent: e.tunnelBytes?.sent ?? 0, bytesReceived: e.tunnelBytes?.received ?? 0 } } : {}),
      ...(e.framesDropped ? { framesDropped: e.framesDropped } : {}),
      ...(e.graphql ? { graphql: { ...e.graphql } } : {}),
      ...(e.cors ? { cors: { ...e.cors, ...(e.cors.problem ? { problem: this.text(e.cors.problem) } : {}) } } : {}),
      ...(e.captured ? { captured: e.captured, readOnly: readOnlyReason(e) } : {}),
      // CONTRACTS §13.2 / §13.4: scriptLog is free text from the user's script: redacted like bodies.
      ...(e.timings ? { timings: { ...e.timings } } : {}),
      ...(e.scriptLog?.length ? { scriptLog: e.scriptLog.map((l) => (this.redact ? redactLogLine(String(l)) : String(l))) } : {}),
    };
  }

  // ------------------------------------------------------------------ read tools

  private getStatus(): ToolResult {
    const all = this.deps.host.getExchanges();
    const s = this.deps.getSettings();
    return {
      proxyRunning: this.deps.host.running,
      ...(this.deps.host.port !== undefined ? { port: this.deps.host.port } : {}),
      interceptEnabled: s.interceptEnabled,
      sessions: this.deps.launcher.sessions(),
      pausedCount: all.filter((e) => e.state === 'paused-request' || e.state === 'paused-response').length,
      exchangeCount: all.length,
      agentAccess: s.access,
      networkProfile: this.profileView(this.deps.host.networkProfile ?? { kind: 'none' }),
      // REVIEW-5 #6: what list / wait / assert hide by default.
      browserInternalHidden: all.filter((e) => e.browserInternal).length,
      warnings: (this.deps.host.warnings ?? []).map((w) => ({ kind: w.kind, text: w.text, ...(w.sessionId ? { sessionId: w.sessionId } : {}) })),
      // CONTRACTS §12
      ...this.replayView(),
      sharedRules: this.deps.host.getRules().filter((r) => r.shared).length,
      // REVIEW-6 #1: pass-through traffic goes via this proxy (host:port only); §14.6 where the setting came from.
      ...(this.deps.host.upstreamProxyInfo
        ? {
            upstreamProxy: this.deps.host.upstreamProxyInfo.display,
            ...(this.deps.host.upstreamProxyInfo.ignoreCertErrors ? { upstreamProxyInsecure: true } : {}),
            ...(this.deps.host.upstreamProxySource ? { upstreamProxySource: this.deps.host.upstreamProxySource } : {}),
          }
        : {}),
      ...this.tlsView(),
    };
  }

  /** CONTRACTS §14.2 / §14.3: passthrough hosts and client certificates — host patterns and problems only. */
  private tlsView(): Record<string, unknown> {
    const hosts = this.deps.host.tlsPassthrough ?? [];
    const certs = this.deps.host.clientCertificateStatus ?? [];
    return {
      ...(hosts.length ? { tlsPassthrough: [...hosts] } : {}),
      ...(certs.length
        ? {
            clientCertificates: certs.map((c) => ({
              host: c.host,
              loaded: !c.problem,
              ...(c.problem ? { problem: this.redact ? redactText(c.problem) : c.problem } : {}),
            })),
          }
        : {}),
    };
  }

  private replayView(): { replaying?: Record<string, unknown> } {
    const r = this.deps.host.replay;
    return r ? { replaying: { ...(r.id !== undefined ? { id: r.id } : {}), name: r.recording, fallback: r.fallback } } : {};
  }

  /**
   * A rule as agents see it: with redaction on, credential-carrying header values in mock headers and rewrite
   * setHeaders read "[redacted]" and a map target is shown like a redacted URL (shared rules may carry them).
   */
  private ruleView(rule: Rule): Rule {
    // CONTRACTS §13.4: agents never see a script's code (whatever the redaction setting).
    if (rule.action?.kind === 'script') {
      const { file } = rule.action;
      rule = { ...rule, action: { kind: 'script', ...(file !== undefined ? { file } : {}) } as RuleAction };
    }
    if (!this.redact) return rule;
    const headers = (h: Record<string, string> | undefined) =>
      h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, isSensitiveHeader(k) ? REDACTED : redactSecretValues(v, true)])) : h;
    const spec = <T extends { setHeaders?: Record<string, string>; replaceBody?: { find: string; replace: string; all?: boolean }[] }>(s: T | undefined): T | undefined =>
      s
        ? {
            ...s,
            ...(s.setHeaders ? { setHeaders: headers(s.setHeaders) } : {}),
            ...(s.replaceBody ? { replaceBody: s.replaceBody.map((r) => ({ ...r, find: redactSecretValues(r.find, true), replace: redactSecretValues(r.replace, true) })) } : {}),
          }
        : s;
    const action = (a: RuleAction | { kind: 'passthrough' }): RuleAction | { kind: 'passthrough' } => {
      switch (a.kind) {
        case 'mock':
          return a.headers ? { ...a, headers: headers(a.headers) } : a;
        case 'mapRemote':
          return { ...a, to: redactUrl(a.to) };
        case 'rewrite':
          return { ...a, ...(a.request ? { request: spec(a.request) } : {}), ...(a.response ? { response: spec(a.response) } : {}) };
        case 'sequence':
          return { ...a, steps: a.steps.map((s) => ({ ...s, action: action(s.action) as typeof s.action })) };
        default:
          return a;
      }
    };
    return { ...rule, action: action(rule.action) as RuleAction };
  }

  private listRequests(i: ToolInput<'list_requests'>): ToolResult {
    const keep = this.filter(i as ExchangeFilter);
    const matched = this.deps.host
      .getExchanges()
      .filter((e) => keep(e) && (i.state === undefined || e.state === i.state) && (i.slowerThanMs === undefined || (e.durationMs !== undefined && e.durationMs > i.slowerThanMs)))
      .sort((a, b) => b.startedAt - a.startedAt);
    return { items: matched.slice(0, i.limit).map((e) => this.summary(e)), total: matched.length };
  }

  private find(id: string): Exchange {
    const e = this.deps.host.getExchanges().find((x) => x.id === id);
    if (!e) throw new AgentToolError(`no recorded exchange with id "${id}" (it may have been cleared or evicted)`, 'not_found');
    return e;
  }

  private getRequest(i: ToolInput<'get_request'>): ToolResult {
    const e = this.find(i.id);
    const view = this.detail(e, i.includeBodies, i.maxBodyChars);
    if (i.snippet) view.snippet = this.redactedSnippet(e, i.snippet, i.maxBodyChars);
    return view;
  }

  /** CONTRACTS §9.5: the snippet is built from the redacted view (secrets stay "[redacted]"). */
  private redactedSnippet(e: Exchange, format: NonNullable<ToolInput<'get_request'>['snippet']>, maxChars: number): string {
    const headers = (this.redact ? redactHeaders(e.requestHeaders) : e.requestHeaders) ?? {};
    let body: Body | undefined = e.requestBody;
    if (body && body.encoding === 'utf8') {
      const text = this.redact ? redactBodyText(body.text, e.requestHeaders) : body.text;
      const cut = text.length > maxChars;
      body = { text: cut ? text.slice(0, maxChars) : text, encoding: 'utf8', ...(cut || body.truncated ? { truncated: true } : {}) };
    }
    return toSnippet({ method: e.method, url: this.url(e.url), headers, ...(body ? { body } : {}) }, format);
  }

  private listPaused(): ToolResult {
    const items = this.deps.host
      .getExchanges()
      .filter((e) => e.state === 'paused-request' || e.state === 'paused-response')
      .map((e) => ({
        ...this.summary(e),
        phase: e.state === 'paused-request' ? 'request' : 'response',
        ...(e.pausedAt ? { pausedAt: e.pausedAt } : {}),
        ...(e.pauseDeadline ? { pauseDeadline: e.pauseDeadline } : {}),
      }));
    return { items };
  }

  /**
   * First exchange matching url/method/status that STARTED at or after `sinceMs` and has reached a
   * final state. Already-recorded ones are checked first (oldest wins), then 'exchange' events are
   * awaited — no polling. Resolves `{timedOut:true}` at the timeout; rejects on abort. Never hangs.
   */
  private waitForRequest(i: ToolInput<'wait_for_request'>, signal?: AbortSignal): Promise<ToolResult> {
    const since = i.sinceMs === undefined ? this.defaultSince() : i.sinceMs === 'now' ? this.now() : i.sinceMs;
    const f = { url: i.url, method: i.method, status: i.status as StatusFilter, sinceMs: since, includeBrowserInternal: i.includeBrowserInternal };
    const keep = this.filter(f);
    const hit = (e: Exchange) => FINAL_STATES.has(e.state) && keep(e);
    const view = (e: Exchange) => ({ timedOut: false, sinceMs: since, ...this.detail(e, i.includeBodies, 20_000) });
    if (signal?.aborted) return Promise.reject(new AgentToolError('wait_for_request was cancelled', 'state'));

    return new Promise<ToolResult>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        this.deps.host.off('exchange', onExchange);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onExchange = (e: Exchange) => {
        if (hit(e)) finish(() => resolve(view(e)));
      };
      const onAbort = () => finish(() => reject(new AgentToolError('wait_for_request was cancelled', 'state')));
      // Subscribe before scanning so an exchange finishing in between is not missed.
      this.deps.host.on('exchange', onExchange);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(() => resolve({ timedOut: true, waitedMs: i.timeoutMs, sinceMs: since })), i.timeoutMs);
      const recorded = this.deps.host
        .getExchanges()
        .filter(hit)
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (recorded) finish(() => resolve(view(recorded)));
    });
  }

  private async exportHar(i: ToolInput<'export_har'>): Promise<ToolResult> {
    const root = this.deps.projectRoot();
    if (!root) throw new AgentToolError('no workspace folder is open to export into', 'state');
    const list = this.deps.host.getExchanges().filter(this.filter({ url: i.url, method: i.method, sinceMs: i.sinceMs, includeBrowserInternal: i.includeBrowserInternal }));
    const har = buildHar(list, { redact: this.redact, creatorVersion: this.deps.version });
    const file = await writeHar(root, har, new Date(this.now()));
    return { path: file, entries: list.length, redacted: this.redact };
  }

  // ------------------------------------------------------------------ write tools

  private newId(): string {
    return this.deps.newRuleId?.() ?? `agent_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private label(name: string | undefined, fallback: string): string {
    const n = (name ?? '').trim() || fallback;
    return n.startsWith(AGENT_RULE_PREFIX) ? n : `${AGENT_RULE_PREFIX}${n}`;
  }

  /** A rule matcher from an agent's url / method / graphqlOperation. */
  private match(i: { url: string; method?: string; graphqlOperation?: string }): Matcher {
    return { url: i.url, ...(i.method ? { method: i.method.toUpperCase() } : {}), ...(i.graphqlOperation ? { graphqlOperation: i.graphqlOperation } : {}) };
  }

  /** Validates with the host's rule validation and inserts the rule FIRST (it wins). */
  private insertRule(rule: Rule): ToolResult {
    // CONTRACTS §13.4: agents can't create scripts (no tool builds one; refused here as well).
    if (hasScript(rule)) throw new AgentToolError('agents cannot add or change script rules; the user writes scripts in the Flutter Intercept panel', 'access');
    const probed = sensitiveQueryProbe(rule.match.url);
    if (probed) {
      throw new AgentToolError(
        `the url pattern pins the value of the query parameter "${probed}", which agents only see redacted; use * for its value (e.g. "${probed}=*")`,
        'invalid',
      );
    }
    let valid: Rule;
    try {
      valid = validateRule(rule);
    } catch (e) {
      throw new AgentToolError((e as Error).message, 'invalid');
    }
    this.deps.applyRules([valid, ...this.deps.host.getRules()]);
    return { ruleId: valid.id };
  }

  private addMock(i: ToolInput<'add_mock'>): ToolResult {
    const isJson = typeof i.body !== 'string';
    const headers: Record<string, string> = { ...(i.headers ?? {}) };
    if (isJson && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    const why = agentMockRefusal(i.url, i.status, headers, isJson ? '' : (i.body as string));
    if (why) throw new AgentToolError(`add_mock refused: ${why}`, 'invalid');
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `mock ${i.method ?? '*'} ${i.url}${opLabel(i)} → ${i.status}`),
      match: this.match(i),
      action: {
        kind: 'mock',
        status: i.status,
        ...(Object.keys(headers).length ? { headers } : {}),
        body: isJson ? JSON.stringify(i.body) : (i.body as string),
        ...(i.delayMs !== undefined ? { delayMs: i.delayMs } : {}),
      },
      ...this.spending(i),
    });
  }

  private addBlock(i: ToolInput<'add_block'>): ToolResult {
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `block ${i.method ?? '*'} ${i.url}${opLabel(i)}`),
      match: this.match(i),
      action: i.mode === 'reset' ? { kind: 'block', mode: 'reset' } : { kind: 'block', mode: 'status', status: i.status },
      ...this.spending(i),
    });
  }

  private addBreakpoint(i: ToolInput<'add_breakpoint'>): ToolResult {
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `break ${i.phase} ${i.method ?? '*'} ${i.url}${opLabel(i)}`),
      match: this.match(i),
      action: { kind: 'breakpoint', phase: i.phase },
      ...this.spending(i),
    });
  }

  private removeRule(i: ToolInput<'remove_rule'>): ToolResult {
    const rules = this.deps.host.getRules();
    if (rules.find((r) => r.id === i.ruleId)?.shared) {
      throw new AgentToolError(
        `rule "${i.ruleId}" is a shared rule from .vscode/flutter-intercept.json (committed with the project); agents can't change that file — ask the user to edit it or un-share the rule in the Flutter Intercept panel`,
        'invalid',
      );
    }
    const next = rules.filter((r) => r.id !== i.ruleId);
    if (next.length === rules.length) return { removed: false };
    this.deps.applyRules(next);
    return { removed: true };
  }

  private pausedOrThrow(id: string): Exchange {
    const e = this.find(id);
    if (e.state !== 'paused-request' && e.state !== 'paused-response') {
      throw new AgentToolError(`exchange "${id}" is not paused (state: ${e.state})`, 'state');
    }
    return e;
  }

  private resume(i: ToolInput<'resume_request'>): ToolResult {
    const e = this.pausedOrThrow(i.id);
    let edit: RequestEdit | ResponseEdit | undefined;
    try {
      edit = validateEdit(i.edit, e.state === 'paused-request' ? 'request' : 'response');
      this.deps.host.resume(i.id, edit);
    } catch (err) {
      throw new AgentToolError((err as Error).message, 'invalid');
    }
    return { resumed: true };
  }

  private abortRequest(i: ToolInput<'abort_request'>): ToolResult {
    this.pausedOrThrow(i.id);
    this.deps.host.abort(i.id);
    return { aborted: true };
  }

  private clearRequests(): ToolResult {
    const before = this.deps.host.getExchanges().length;
    this.deps.clear();
    const after = this.deps.host.getExchanges().length;
    return { cleared: Math.max(0, before - after) };
  }

  // ------------------------------------------------------------------ v0.3.0 (CONTRACTS §9.5)

  /** `times` / `ttlMs` → the rule's spending fields. */
  private spending(i: { times?: number; ttlMs?: number }): Pick<Rule, 'times' | 'expiresAt'> {
    return { ...(i.times !== undefined ? { times: i.times } : {}), ...(i.ttlMs !== undefined ? { expiresAt: this.now() + i.ttlMs } : {}) };
  }

  private profileView(p: NetworkProfile): Record<string, unknown> {
    return { ...p, label: describeProfile(p) };
  }

  /**
   * A frame for agents (REVIEW-3 #4): never an absolute path. `path` is project-relative; `uri` is kept for
   * `package:` / `dart:` / SDK URIs, becomes "<project>/<path>" for a `file:` inside the project, and
   * "<outside project>" for any other URI (absolute `file:` URIs would reveal user names and folders).
   */
  private frameView(f: StackFrame | ResolvedFrame, root: string | undefined): Record<string, unknown> {
    const r = f as Partial<ResolvedFrame>;
    const relTo = (abs: string): string | undefined => {
      if (!root || !path.isAbsolute(abs)) return undefined;
      const p = path.relative(root, abs);
      return p && !p.startsWith('..') && !path.isAbsolute(p) ? p.split(path.sep).join('/') : undefined;
    };
    let rel: string | undefined;
    if (r.path) rel = path.isAbsolute(r.path) ? relTo(r.path) : r.path.startsWith('..') ? undefined : r.path.split(path.sep).join('/');
    let uri: string;
    if (/^(package|dart|org-dartlang-sdk):/.test(f.uri)) uri = f.uri;
    else {
      if (!rel && f.uri.startsWith('file:')) {
        try {
          rel = relTo(fileURLToPath(f.uri));
        } catch {
          // not a local file URI
        }
      }
      uri = rel && f.uri.startsWith('file:') ? `<project>/${rel}` : OUTSIDE_PROJECT;
    }
    return {
      fn: f.fn,
      uri,
      ...(rel ? { path: rel } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.column !== undefined ? { column: f.column } : {}),
      ...(typeof r.inProject === 'boolean' ? { inProject: r.inProject } : {}),
      ...(f.afterAsyncGap ? { afterAsyncGap: true } : {}),
    };
  }

  private async getRequestSource(i: ToolInput<'get_request_source'>): Promise<ToolResult> {
    const e = this.find(i.id);
    const src = e.source;
    if (!src?.frames?.length) {
      return {
        available: false,
        reason: e.initiator
          ? `this request was sent by ${e.initiator === 'agent' ? 'an agent (resend_request)' : 'the editor'}, not by the app`
          : 'no stack trace has arrived for this request: source capture may be off (setting flutterIntercept.captureSource), the app may have been launched by an older Flutter Intercept, or the trace is still on its way (retry in a moment)',
      };
    }
    const app = src.appFrame !== undefined && src.appFrame >= 0 && src.appFrame < src.frames.length ? src.appFrame : undefined;
    const upto = Math.max(i.maxFrames, app !== undefined ? app + 1 : 0);
    let frames: (StackFrame | ResolvedFrame)[] = src.frames.slice(0, upto);
    if (this.deps.resolveFrames) {
      try {
        const resolved = await this.deps.resolveFrames(frames);
        if (Array.isArray(resolved) && resolved.length === frames.length) frames = resolved;
      } catch {
        // unresolved frames are still useful
      }
    }
    const root = this.deps.projectRoot();
    const views = frames.map((f) => this.frameView(f, root));
    const appView = app !== undefined ? (({ inProject: _i, afterAsyncGap: _a, ...rest }) => rest)(views[app]) : undefined;
    return {
      available: true,
      ...(appView ? { appFrame: appView, appFrameIndex: app } : {}),
      frames: views.slice(0, i.maxFrames),
      totalFrames: src.frames.length,
    };
  }

  private getBodyShape(i: ToolInput<'get_body_shape'>): ToolResult {
    const e = this.find(i.id);
    const body = i.which === 'request' ? e.requestBody : e.responseBody;
    const headers = i.which === 'request' ? e.requestHeaders : e.responseHeaders;
    const ctRaw = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    const contentType = Array.isArray(ctRaw) ? ctRaw[0] : ctRaw;
    const base = { ...(contentType ? { contentType } : {}), bytes: bodyBytes(body) ?? 0 };
    if (!body) {
      const pending = i.which === 'response' && !FINAL_STATES.has(e.state);
      return { ...base, shape: null, reason: pending ? `the response has not arrived yet (state ${e.state})` : `the ${i.which} has no body` };
    }
    if (body.encoding === 'base64') return { ...base, shape: null, reason: `the ${i.which} body is binary` };
    const r = bodyShape(body.text, { maxDepth: i.maxDepth, bodyTruncated: body.truncated });
    return { ...base, shape: r.shape, ...(r.truncated ? { truncated: true } : {}), ...(r.reason ? { reason: r.reason } : {}) };
  }

  private simulateNetwork(i: ToolInput<'simulate_network'>): ToolResult {
    const custom = i.latencyMs !== undefined || i.kbps !== undefined || i.uploadKbps !== undefined || i.dropRate !== undefined;
    const bad = (m: string) => new AgentToolError(m, 'invalid');
    if (i.fault && i.profile) throw bad('pass either profile or fault, not both');
    if (!i.fault && !i.profile) throw bad('profile is required (or fault together with a url)');
    if (custom && i.profile !== 'custom') throw bad('latencyMs, kbps, uploadKbps and dropRate are only used with profile "custom"');
    if (i.profile === 'custom' && !custom) throw bad('profile "custom" needs latencyMs, kbps, uploadKbps and/or dropRate');

    if (i.url === undefined) {
      if (i.fault) throw bad('fault needs a url; to make every request fail use profile "offline"');
      if (i.method !== undefined || i.graphqlOperation !== undefined || i.times !== undefined || i.ttlMs !== undefined || i.name !== undefined) {
        throw bad('method, graphqlOperation, times, ttlMs and name only apply together with a url (a rule for matching requests)');
      }
      const p: NetworkProfile =
        i.profile === 'none' || i.profile === 'offline'
          ? { kind: i.profile }
          : i.profile === 'custom'
            ? { kind: 'throttle', ...throttleFields(i) }
            : presetProfile(i.profile as NetworkPresetId);
      if (!this.deps.host.setNetworkProfile) throw new AgentToolError('this version of the proxy cannot simulate network conditions', 'state');
      try {
        this.deps.host.setNetworkProfile(p);
      } catch (err) {
        throw new AgentToolError((err as Error).message, 'state');
      }
      return { profile: this.profileView(p) };
    }

    if (i.profile === 'none') throw bad('profile "none" with a url changes nothing: remove the rule with remove_rule, or omit url to restore the global profile');
    let action: RuleAction;
    let what: string;
    if (i.fault || i.profile === 'offline') {
      const fault = i.fault ?? 'dns';
      action = { kind: 'fault', fault };
      what = i.fault ? `fault ${fault}` : 'offline';
    } else if (i.profile === 'custom') {
      action = { kind: 'throttle', ...throttleFields(i) };
      what = describeProfile({ ...action, kind: 'throttle' });
    } else {
      const preset = NETWORK_PRESETS.find((x) => x.id === i.profile)!;
      action = { kind: 'throttle', ...throttleFields(preset) };
      what = preset.label;
    }
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `${what} ${i.method ?? '*'} ${i.url}${opLabel(i)}`),
      match: this.match({ ...i, url: i.url }),
      action,
      ...this.spending(i),
    });
  }

  /**
   * REVIEW-3 #1 / CONTRACTS §9.5: only an app exchange that reached the real server unchanged may be resent:
   * no `initiator`, `completed`, no `matchedRuleId` (mock/block/fault/throttle/breakpoint, incl. a paused-then-
   * edited request), not from the LAN listener (`viaLan`: `send` uses the loopback listener, which has neither
   * the §7 SSRF guard nor would it keep the 10.0.2.2 meaning), and not a synthetic lan-… or tls-… record.
   * Returns why not, or undefined when allowed.
   */
  private resendRefusal(e: Exchange): string | undefined {
    const ro = readOnlyReason(e);
    if (ro) return `exchange "${e.id}": ${ro}`;
    if (e.kind === 'websocket') return `exchange "${e.id}" is a WebSocket connection; only plain HTTP requests can be resent`;
    if (e.kind === 'sse') return `exchange "${e.id}" is a server-sent event stream; resending it would hold a stream open, so only plain HTTP requests can be resent`;
    if (e.kind === 'tunnel') return `exchange "${e.id}" is a TLS connection passed through without decryption (flutterIntercept.tlsPassthrough); its request was never seen, so it can't be resent`;
    if (e.initiator) return `exchange "${e.id}" was itself sent by ${e.initiator === 'agent' ? 'an agent' : 'the editor'}; resend the app's original request instead`;
    if (/^(lan|tls)-/.test(e.id)) return `exchange "${e.id}" is a connection-level record (refused LAN or TLS connection), not a request that reached a server`;
    if (e.viaLan) return `exchange "${e.id}" came from a physical device over the LAN; resending it from this computer would bypass the LAN safeguards`;
    if (e.matchedRuleId) return `exchange "${e.id}" was handled by rule "${e.matchedRuleId}" (mock, block, fault, throttle or breakpoint), so it did not reach the server unchanged`;
    if (e.state !== 'completed') return `exchange "${e.id}" did not complete against the real server (state: ${e.state})`;
    try {
      const u = new URL(e.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return `exchange "${e.id}" is not an http(s) request`;
    } catch {
      return `exchange "${e.id}" has no absolute URL`;
    }
    return undefined;
  }

  private async resendRequest(i: ToolInput<'resend_request'>): Promise<ToolResult> {
    const e = this.find(i.id);
    const why = this.resendRefusal(e);
    if (why) throw new AgentToolError(`resend_request refused: ${why}.`, 'invalid');
    if (!this.deps.host.send) throw new AgentToolError('this version of the proxy cannot send requests', 'state');
    let edit: RequestEdit | undefined;
    try {
      edit = validateEdit(i.edit, 'request') as RequestEdit | undefined;
    } catch (err) {
      throw new AgentToolError((err as Error).message, 'invalid');
    }
    const original = new URL(e.url);
    let url = e.url;
    if (edit?.url !== undefined) {
      const target = new URL(edit.url); // validateEdit: absolute http(s)
      // Same origin only (scheme, host, port; WHATWG-normalised): the original credentials go nowhere else.
      if (target.origin !== original.origin || target.username || target.password) {
        throw new AgentToolError(
          `resend_request refused: edit.url must keep the original origin ${original.origin} (only path and query may change); got ${target.username || target.password ? 'a URL with user info' : target.origin}.`,
          'invalid',
        );
      }
      // Send the normalised form of exactly what was checked (no parser differential downstream).
      const sent = new URL(restoreRedactedQuery(edit.url, e.url));
      if (sent.origin !== original.origin) throw new AgentToolError(`resend_request refused: edit.url must keep the original origin ${original.origin}.`, 'invalid');
      url = sent.href;
    }
    let body: string | undefined;
    if (edit?.body !== undefined) body = edit.body;
    else if (e.requestBody) {
      if (e.requestBody.encoding === 'base64') throw new AgentToolError('the original request body is binary and cannot be resent as is; pass edit.body', 'invalid');
      if (e.requestBody.truncated) throw new AgentToolError('the original request body was truncated when recorded; pass edit.body', 'invalid');
      body = e.requestBody.text;
    }
    const headers = sanitizeSendHeaders(edit?.headers !== undefined ? restoreRedactedHeaders(edit.headers, e.requestHeaders) : e.requestHeaders);
    const sinceMs = this.now();
    let id: string;
    try {
      ({ id } = await this.deps.host.send({
        method: (edit?.method ?? e.method).toUpperCase(),
        url,
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        initiator: 'agent',
        resentFrom: e.id,
      }));
    } catch (err) {
      throw new AgentToolError(`could not send the request: ${(err as Error).message}`, 'state');
    }
    return { id, sinceMs };
  }

  // ------------------------------------------------------------------ v0.4.0 (CONTRACTS §10.6)

  private codegenOrThrow(): CodegenService {
    if (!this.deps.codegen) throw new AgentToolError('code generation is not available in this build of Flutter Intercept', 'state');
    return this.deps.codegen;
  }

  private template(): (p: string) => string {
    const cg = this.codegenOrThrow();
    return (p) => cg.routeTemplate(p);
  }

  private async checkContract(i: ToolInput<'check_contract'>): Promise<ToolResult> {
    const svc = this.deps.contract;
    if (!svc) throw new AgentToolError('contract checking is not available in this build of Flutter Intercept', 'state');
    let targets: Exchange[];
    if (i.id !== undefined) {
      if (i.url !== undefined || i.method !== undefined || i.sinceMs !== undefined) throw new AgentToolError('pass either id, or url/method/sinceMs', 'invalid');
      targets = [this.find(i.id)];
    } else {
      const keep = this.filter({ url: i.url, method: i.method, sinceMs: i.sinceMs });
      targets = this.deps.host
        .getExchanges()
        .filter((e) => FINAL_STATES.has(e.state) && looksJson(e) && keep(e))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, i.limit);
    }
    const root = this.deps.projectRoot();
    const results: Record<string, unknown>[] = [];
    for (const e of targets) {
      let r: ContractResult;
      if (!FINAL_STATES.has(e.state)) {
        r = { exchangeId: e.id, checked: false, via: 'none', violations: [], reason: `the response has not arrived yet (state ${e.state})` };
      } else {
        const cached = i.model === undefined ? this.deps.contractResult?.(e.id) : undefined;
        try {
          r = cached ?? (await svc.check(e, i.model !== undefined ? { model: i.model } : undefined));
        } catch (err) {
          r = { exchangeId: e.id, checked: false, via: 'none', violations: [], reason: `the check failed: ${(err as Error)?.message ?? String(err)}` };
        }
      }
      results.push(contractForAgent(r, { root, exchange: e, redact: this.redact }));
    }
    const errors = results.reduce((n, r) => n + (r.errors as number), 0);
    return {
      results,
      checked: results.filter((r) => r.checked).length,
      errors,
      ...(targets.length ? {} : { note: 'no finished JSON response matched; make the app call the endpoint first (or check list_requests)' }),
    };
  }

  private async generateModel(i: ToolInput<'generate_model'>): Promise<ToolResult> {
    if ((i.id === undefined) === (i.url === undefined)) throw new AgentToolError('pass id or url (exactly one)', 'invalid');
    const cg = this.codegenOrThrow();
    const template = this.template();
    const all = this.deps.host.getExchanges();
    let target: Exchange;
    if (i.id !== undefined) target = this.find(i.id);
    else {
      const keep = this.filter({ url: i.url });
      const hit = all
        .filter((e) => FINAL_STATES.has(e.state) && decodeJson(e.responseBody).ok && keep(e))
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!hit) throw new AgentToolError(`no finished JSON response matches ${i.url}; make the app call it first`, 'not_found');
      target = hit;
    }
    // decodeSample keeps `1.0` a double (JsonDouble) so the models get `double`, not `int`.
    const json = decodeSample(target.responseBody);
    if (!json.ok) throw new AgentToolError(`exchange "${target.id}" has no usable JSON response: ${json.reason}`, 'invalid');
    const route = routeOf(target, template);
    const samples = modelSamples(all, target, template).flatMap((s) => {
      const d = decodeSample(s.responseBody);
      return d.ok ? [this.redact ? redactJsonValue(d.value) : d.value] : [];
    });
    const root = this.deps.projectRoot();
    const style = i.style ?? (root ? cg.detectModelStyle(root) : 'plain');
    const files = cg.generateModels({
      samples: samples.length ? samples : [this.redact ? redactJsonValue(json.value) : json.value],
      rootName: i.name ?? defaultModelName(route.template),
      style,
      source: `${target.method.toUpperCase()} ${route.origin}${route.template}`,
    });
    return { files, samples: Math.max(1, samples.length), route: `${target.method.toUpperCase()} ${route.template}`, style };
  }

  private async generateFixtureTest(i: ToolInput<'generate_fixture_test'>): Promise<ToolResult> {
    if ((i.ids === undefined) === (i.url === undefined)) throw new AgentToolError('pass ids or url (exactly one)', 'invalid');
    const cg = this.codegenOrThrow();
    let exchanges: Exchange[];
    if (i.ids) {
      exchanges = [...new Set(i.ids)].map((id) => this.find(id));
      const unfinished = exchanges.find((e) => !FINAL_STATES.has(e.state) || e.status === undefined);
      if (unfinished) throw new AgentToolError(`exchange "${unfinished.id}" has no finished response (state ${unfinished.state})`, 'invalid');
    } else {
      const keep = this.filter({ url: i.url });
      exchanges = this.deps.host
        .getExchanges()
        .filter((e) => FINAL_STATES.has(e.state) && e.status !== undefined && keep(e))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_FIXTURES);
      if (!exchanges.length) throw new AgentToolError(`no finished request matches ${i.url}; make the app call it first`, 'not_found');
    }
    const route = routeOf(exchanges[0], this.template());
    const root = this.deps.projectRoot();
    const style = i.style ?? (root ? cg.detectFixtureStyle(root) : 'mock_client');
    const pkg = this.deps.appPackageName?.();
    const api = style === 'mocktail' ? await fixtureApi(this.deps.contract, exchanges, root, pkg) : undefined;
    const testPackage = testPackageFor(root);
    // Fixtures are meant to be committed: always the redacted view, whatever the setting (CONTRACTS §10.6).
    const files = cg.generateFixtureTest({
      exchanges: exchanges.map(redactExchange),
      style,
      name: i.name ?? defaultFixtureName(exchanges[0].method, route.template),
      ...(pkg ? { packageName: pkg } : {}),
      ...(api ? { api } : {}),
      ...(testPackage ? { testPackage } : {}),
    });
    return { files, exchanges: exchanges.length, style, ...(api ? { mocks: api.className } : {}), redacted: true };
  }

  /** assert_traffic's default `sinceMs`: the latest launch/restart if within TRIGGER_WINDOW_MS, else all recorded traffic. */
  private assertSince(): number {
    return this.lastTriggerAt !== undefined && this.now() - this.lastTriggerAt <= TRIGGER_WINDOW_MS ? this.lastTriggerAt : 0;
  }

  /**
   * Waits (event-driven, at most withinMs) until the count/presence/order expectations can hold, then evaluates
   * every expectation once. With an upper bound (count.max / exact) the whole window is observed, unless it is
   * already exceeded. Never hangs: a timer always settles it; cancellation rejects.
   */
  private assertTraffic(i: ToolInput<'assert_traffic'>, signal?: AbortSignal): Promise<ToolResult> {
    const x = i.expect;
    const c = x.count;
    if (c) {
      if (c.exact !== undefined && (c.min !== undefined || c.max !== undefined)) throw new AgentToolError('expect.count: use exact alone, or min and/or max', 'invalid');
      if (c.min !== undefined && c.max !== undefined && c.min > c.max) throw new AgentToolError('expect.count: min is greater than max', 'invalid');
    }
    (x.json ?? []).forEach((a, n) => {
      const bad = pathError(a.path);
      if (bad) throw new AgentToolError(`expect.json[${n}]: ${bad}`, 'invalid');
      if (a.exists === false && (a.equals !== undefined || a.type !== undefined)) throw new AgentToolError(`expect.json[${n}]: exists:false cannot be combined with equals or type`, 'invalid');
    });
    const since = i.sinceMs ?? this.assertSince();
    // Compiled once per call (REVIEW-4 #11), matched against the agent's view of the URL (#1).
    const keep = this.filter({ url: i.url, method: i.method, sinceMs: since, includeBrowserInternal: i.includeBrowserInternal });
    const order = x.order?.map((glob) => ({ glob, test: compileMatcher({ url: glob }) }));
    const internal = i.includeBrowserInternal === true;
    const upper = c?.exact ?? c?.max;
    const need = c ? (c.exact ?? c.min ?? 0) : 1;
    const start = this.now();
    const count = () => this.deps.host.getExchanges().filter((e) => FINAL_STATES.has(e.state) && keep(e)).length;
    const ready = (): boolean => {
      const n = count();
      if (upper !== undefined) return n > upper; // exceeded: no point waiting
      return n >= need && (!order || this.orderFailure(order, since, internal) === undefined);
    };
    const evaluate = () => this.evaluateAssert(i, since, Math.max(0, this.now() - start), keep, order);
    if (signal?.aborted) return Promise.reject(new AgentToolError('assert_traffic was cancelled', 'state'));
    if (i.withinMs === 0) return Promise.resolve().then(evaluate);

    return new Promise<ToolResult>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        this.deps.host.off('exchange', onExchange);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const settle = () =>
        finish(() => {
          try {
            resolve(evaluate());
          } catch (e) {
            reject(e);
          }
        });
      const onExchange = (e: Exchange) => {
        if (FINAL_STATES.has(e.state) && ready()) settle();
      };
      const onAbort = () => finish(() => reject(new AgentToolError('assert_traffic was cancelled', 'state')));
      this.deps.host.on('exchange', onExchange);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(settle, i.withinMs);
      if (ready()) settle();
    });
  }

  /** Why `order` does not hold among the finished exchanges since `since`, or undefined when it does. */
  private orderFailure(order: { glob: string; test: (method: string, url: string) => boolean }[], since: number, includeBrowserInternal = false): string | undefined {
    const done = this.deps.host
      .getExchanges()
      .filter((e) => FINAL_STATES.has(e.state) && e.startedAt >= since && (includeBrowserInternal || !e.browserInternal))
      .sort((a, b) => a.startedAt - b.startedAt);
    let after = -Infinity;
    let prev: string | undefined;
    const view = this.redact ? redactUrl : (u: string) => u;
    for (const { glob, test } of order) {
      const hit = done.find((e) => e.startedAt > after && test(e.method, view(e.url)));
      if (!hit) return `order: no request matching ${JSON.stringify(glob)} ${prev !== undefined ? `started after the one matching ${JSON.stringify(prev)}` : 'was recorded'}`;
      after = hit.startedAt;
      prev = glob;
    }
    return undefined;
  }

  private evaluateAssert(
    i: ToolInput<'assert_traffic'>,
    since: number,
    waitedMs: number,
    keep: (e: Exchange) => boolean,
    order: { glob: string; test: (method: string, url: string) => boolean }[] | undefined,
  ): ToolResult {
    const x = i.expect;
    const all = this.deps.host.getExchanges();
    const m = all.filter((e) => FINAL_STATES.has(e.state) && keep(e)).sort((a, b) => a.startedAt - b.startedAt);
    const inFlight = all.filter((e) => !FINAL_STATES.has(e.state) && keep(e)).length;
    const failures: string[] = [];
    const label = (e: Exchange) => `${e.id} (${e.method} ${this.url(e.url)})`;
    const what = `${i.method ? `${i.method.toUpperCase()} ` : ''}${i.url}`;
    const flight = inFlight ? ` (${inFlight} more still in flight)` : '';
    const sinceText = since > 0 ? ` since ${new Date(since).toISOString()}` : '';

    const c = x.count;
    const n = m.length;
    if (c) {
      if (c.exact !== undefined && n !== c.exact) failures.push(`count: expected exactly ${c.exact} request(s) matching ${what}${sinceText}, got ${n}${flight}`);
      if (c.min !== undefined && n < c.min) failures.push(`count: expected at least ${c.min} request(s) matching ${what}${sinceText}, got ${n}${flight}`);
      if (c.max !== undefined && n > c.max) failures.push(`count: expected at most ${c.max} request(s) matching ${what}${sinceText}, got ${n}`);
    } else if (!n) failures.push(`no finished request matched ${what}${sinceText}${flight}`);

    if (order) {
      const why = this.orderFailure(order, since, i.includeBrowserInternal === true);
      if (why) failures.push(why);
    }
    for (const e of m) {
      if (x.status !== undefined && !statusMatches(e, x.status as StatusFilter)) {
        failures.push(`${label(e)}: ${e.status !== undefined ? `status ${e.status}` : `no status (state ${e.state})`}, expected ${x.status}`);
      }
      if (x.maxDurationMs !== undefined && !(e.durationMs !== undefined && e.durationMs <= x.maxDurationMs)) {
        failures.push(`${label(e)}: ${e.durationMs !== undefined ? `took ${e.durationMs} ms` : 'duration unknown'}, expected at most ${x.maxDurationMs} ms`);
      }
      if (x.json?.length) this.jsonFailures(e, x.json, label(e), failures);
      if (failures.length > MAX_ASSERT_FAILURES) break;
    }
    const extra = failures.length - MAX_ASSERT_FAILURES;
    const shown = extra > 0 ? [...failures.slice(0, MAX_ASSERT_FAILURES), `… and more failures (stopped after ${MAX_ASSERT_FAILURES})`] : failures;
    return {
      pass: failures.length === 0,
      matched: n,
      ids: m.slice(-20).map((e) => e.id),
      ...(inFlight ? { inFlight } : {}),
      sinceMs: since,
      ...(i.withinMs ? { waitedMs } : {}),
      failures: shown,
    };
  }

  /**
   * json assertions on one exchange (REVIEW-4 #7/#8). With redaction on, EVERY assertion is evaluated on the
   * redacted view (what get_request shows: a sensitive field is just the string "[redacted]"), and a path that
   * goes below a sensitive key fails with "is inside a redacted field" without being evaluated. So neither the
   * pass/fail nor the texts reveal values, keys or counts under a redacted field. Failure texts carry paths,
   * types and sizes, never values. At most MAX_JSON_FAILURES_PER_EXCHANGE texts per exchange.
   */
  private jsonFailures(e: Exchange, asserts: NonNullable<ToolInput<'assert_traffic'>['expect']['json']>, label: string, out: string[]): void {
    const d = decodeJson(e.responseBody);
    if (!d.ok) {
      out.push(`${label}: cannot check JSON paths: ${e.responseBody ? `the response ${d.reason.replace(/^the body/, 'body')}` : 'no response body'}`);
      return;
    }
    const root = this.redact ? redactJsonValue(d.value) : d.value;
    let left = MAX_JSON_FAILURES_PER_EXCHANGE;
    const push = (text: string): boolean => {
      if (left <= 0) return false;
      left--;
      out.push(left === 0 ? `${text} (further JSON failures of ${e.id} omitted)` : text);
      return left > 0;
    };
    const sel = (p: string) => {
      try {
        return select(root, p);
      } catch (err) {
        throw new AgentToolError(`invalid JSON path ${JSON.stringify(p)}: ${(err as Error)?.message ?? String(err)}`, 'invalid');
      }
    };
    for (const a of asserts) {
      if (left <= 0) return;
      if (this.redact && insideRedacted(a.path)) {
        push(`${label}: ${a.path} is inside a redacted field (secrets cannot be asserted; check the field itself with exists)`);
        continue;
      }
      const got = sel(a.path);
      const exists = a.exists ?? (a.equals === undefined && a.type === undefined ? true : undefined);
      if (exists === false) {
        if (got.length) push(`${label}: ${a.path} is present (${got.length} value${got.length === 1 ? '' : 's'}), expected it to be absent`);
        continue;
      }
      if (!got.length) {
        push(`${label}: ${a.path} not found${a.type ? ` (expected ${a.type})` : a.equals !== undefined ? ' (expected a value)' : ''}`);
        continue;
      }
      if (a.type) {
        for (const s of got) if (!typeMatches(s.value, a.type) && !push(`${label}: ${s.path} is ${jsonType(s.value)}, expected ${a.type}`)) return;
      }
      if (a.equals !== undefined) {
        for (const s of got) if (!jsonEqual(s.value, a.equals) && !push(`${label}: ${s.path} does not equal the expected value (it is ${describeValue(s.value)})`)) return;
      }
    }
  }

  private addMutation(i: ToolInput<'add_mutation'>): ToolResult {
    const ops = i.ops.map((o) => ({ path: o.path, op: o.op, ...(o.value !== undefined ? { value: o.value } : {}), ...(o.valueJson !== undefined ? { valueJson: o.valueJson } : {}) }));
    const summary = ops.map((o) => `${o.op} ${o.path}`).join(', ');
    const fallback = `mutate ${i.method ?? '*'} ${i.url}${opLabel(i)}: ${summary}`;
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, fallback.length > 300 ? `${fallback.slice(0, 299)}…` : fallback),
      match: this.match(i),
      action: { kind: 'mutate', ops },
      ...this.spending(i),
    });
  }

  // ------------------------------------------------------------------ v0.5.0 (CONTRACTS §11.5)

  /** One frame as agents see it: redacted text (cut at maxChars), binary summarised, absolute `index`. */
  private wsFrameView(f: Frame, index: number, maxChars: number): Record<string, unknown> {
    let text: string | undefined;
    let binary = false;
    if (f.base64 !== undefined && f.text === undefined) {
      text = `[binary ${f.size} bytes]`;
      binary = true;
    } else if (f.text !== undefined) {
      text = this.redact ? redactFrameText(f.text) : f.text;
    }
    const cut = text !== undefined && !binary && text.length > maxChars;
    return {
      index,
      dir: f.dir,
      at: f.at,
      kind: f.kind,
      size: f.size,
      ...(text !== undefined ? { text: cut ? text.slice(0, maxChars) : text } : {}),
      ...(binary ? { binary: true } : {}),
      ...(cut || f.truncated ? { truncated: true } : {}),
      ...(cut ? { textChars: text!.length } : {}),
      ...(f.event !== undefined ? { event: f.event } : {}),
      ...(f.id !== undefined ? { id: this.redact ? redactSecretValues(f.id, true) : f.id } : {}),
      ...(f.closeCode !== undefined ? { closeCode: f.closeCode } : {}),
    };
  }

  /**
   * get_frames: frames of a WebSocket / SSE exchange, oldest first. Indexes are absolute (`framesDropped` +
   * position), so `since` = the previous `next` keeps paging correct while old frames are dropped.
   */
  private getFrames(i: ToolInput<'get_frames'>): ToolResult {
    const e = this.find(i.id);
    if (!e.kind) {
      throw new AgentToolError(`exchange "${e.id}" is a plain HTTP request, not a WebSocket or SSE stream; read it with get_request`, 'invalid');
    }
    if (e.kind === 'tunnel') {
      throw new AgentToolError(`exchange "${e.id}" is a TLS connection passed through without decryption (flutterIntercept.tlsPassthrough): it has no messages to read; get_request shows its byte counts`, 'invalid');
    }
    const frames = e.frames ?? [];
    const dropped = e.framesDropped ?? 0;
    const total = dropped + frames.length;
    const from = Math.max(i.since ?? dropped, dropped);
    const out: Record<string, unknown>[] = [];
    let chars = 0;
    let next = from;
    for (let n = from - dropped; n < frames.length && out.length < i.limit; n++) {
      const view = this.wsFrameView(frames[n], dropped + n, i.maxChars);
      const len = typeof view.text === 'string' ? view.text.length : 0;
      if (out.length && chars + len > MAX_FRAME_RESULT_CHARS) break;
      chars += len;
      out.push(view);
      next = dropped + n + 1;
    }
    return {
      id: e.id,
      kind: e.kind,
      state: e.state,
      frames: out,
      next,
      total,
      ...(dropped ? { dropped } : {}),
      ...(i.since !== undefined && i.since < dropped ? { skipped: dropped - i.since, note: `frames ${i.since}-${dropped - 1} were dropped (only the newest are kept)` } : {}),
      more: next < total,
      ...(e.state === 'pending' ? { open: true } : {}),
    };
  }

  private addCorsRule(i: ToolInput<'add_cors_rule'>): ToolResult {
    if (i.allowOrigin === '*' && i.allowCredentials) {
      throw new AgentToolError('allowOrigin "*" cannot be combined with allowCredentials (browsers reject it); name the origin instead (e.g. "http://localhost:5000")', 'invalid');
    }
    // REVIEW-5 #3: never a match-all CORS rule.
    if (!urlGlobHasHost(i.url)) {
      throw new AgentToolError(`add_cors_rule needs a url with a host, e.g. "https://api.example.com/*" (got ${JSON.stringify(i.url.slice(0, 100))}): a CORS rule for every site would let any page in the debug browser read them`, 'invalid');
    }
    // The policy is always part of the name, also with a custom one (REVIEW-5 #3).
    const policy = `[CORS dev only: ${corsPolicyShort(i.allowOrigin, i.allowCredentials)}]`;
    const base = (i.name ?? '').trim() || `${i.method ?? '*'} ${i.url}`;
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(undefined, `${base} ${policy}`),
      match: this.match(i),
      action: { kind: 'cors', ...(i.allowOrigin !== undefined ? { allowOrigin: i.allowOrigin } : {}), ...(i.allowCredentials !== undefined ? { allowCredentials: i.allowCredentials } : {}) },
      ...this.spending(i),
    });
  }

  // ------------------------------------------------------------------ v0.6.0 (CONTRACTS §12.7)

  private recordingsOrThrow(): RecordingService {
    if (!this.deps.recordings) throw new AgentToolError('recordings are not available (no Flutter project folder is open)', 'state');
    return this.deps.recordings;
  }

  private async loadRecording(id: string) {
    try {
      return await this.recordingsOrThrow().load(id);
    } catch (e) {
      if (e instanceof AgentToolError) throw e;
      throw new AgentToolError(`no recording "${id}" (see list_recordings): ${(e as Error)?.message ?? String(e)}`, 'not_found');
    }
  }

  private changed(): void {
    try {
      this.deps.recordingsChanged?.();
    } catch {
      // the panel refresh never breaks a tool call
    }
  }

  /** A path inside the project as project-relative, otherwise undefined (never an absolute path, REVIEW-3 #4). */
  private projectPath(p: string | undefined): string | undefined {
    const root = this.deps.projectRoot();
    if (!p || !root) return undefined;
    const rel = path.relative(root, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
  }

  private async listRecordings(): Promise<ToolResult> {
    const list = await this.recordingsOrThrow().list();
    return {
      recordings: list.map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt, exchanges: m.exchanges, redacted: m.redacted, ...streamCounts(m) })),
      ...this.replayView(),
    };
  }

  private async saveRecording(i: ToolInput<'save_recording'>): Promise<ToolResult> {
    const svc = this.recordingsOrThrow();
    const keep = this.filter({ url: i.url, sinceMs: i.sinceMs });
    const list = this.deps.host.getExchanges().filter((e) => isRecordable(e) && keep(e));
    if (!list.length) {
      throw new AgentToolError(`no finished HTTP request, WebSocket or SSE stream${i.url ? ` matches ${i.url}` : ' is recorded'}${i.sinceMs !== undefined ? ' since sinceMs' : ''} (open connections, TLS tunnels and native-client traffic are not recorded)`, 'not_found');
    }
    // Agents save redacted unless they ask otherwise (the user's panel default is unredacted).
    const meta = await svc.save(i.name, list, { redact: i.redact });
    this.changed();
    const where = this.projectPath(meta.path);
    return { id: meta.id, name: meta.name, exchanges: meta.exchanges, redacted: meta.redacted, ...streamCounts(meta), ...(where ? { path: where } : {}) };
  }

  private async replayRecording(i: ToolInput<'replay_recording'>): Promise<ToolResult> {
    const host = this.deps.host;
    if (!host.setReplay) throw new AgentToolError('this version of the proxy cannot replay recordings', 'state');
    if (i.id === undefined) {
      const was = host.replay;
      host.setReplay(undefined);
      this.changed();
      return { replaying: false, ...(was ? { stopped: was.recording } : {}) };
    }
    const svc = this.recordingsOrThrow();
    const rec = await this.loadRecording(i.id);
    const entries = svc.toReplay(rec);
    if (!entries.length) throw new AgentToolError(`recording "${rec.id}" has no responses to replay`, 'invalid');
    try {
      host.setReplay(entries, { fallback: i.fallback, matchTemplates: true }, { id: rec.id, name: rec.name });
    } catch (e) {
      throw new AgentToolError((e as Error).message, 'state');
    }
    this.changed();
    return {
      replaying: true,
      id: rec.id,
      name: rec.name,
      entries: entries.length,
      fallback: i.fallback,
      ...(rec.redacted ? { note: 'this recording was saved redacted: replayed secrets (tokens, cookies) read "[redacted]"' } : {}),
    };
  }

  /** Details are always redacted (CONTRACTS §12.7), whatever the setting. */
  private async diffRecordings(i: ToolInput<'diff_recordings'>): Promise<ToolResult> {
    if (i.a === i.b) throw new AgentToolError('pass two different recordings', 'invalid');
    const svc = this.recordingsOrThrow();
    const [a, b] = [await this.loadRecording(i.a), await this.loadRecording(i.b)];
    const all = svc.diff(a, b);
    const entries = all.slice(0, MAX_DIFF_ENTRIES).map((d) => ({ route: redactText(d.route), change: d.change, detail: redactText(d.detail) }));
    return {
      a: { id: a.id, name: a.name, exchanges: a.exchanges },
      b: { id: b.id, name: b.name, exchanges: b.exchanges },
      entries,
      total: all.length,
      ...(all.length > entries.length ? { more: all.length - entries.length } : {}),
      ...(all.length ? {} : { note: 'no differences by route, status, JSON shape, body values, call counts or timing' }),
    };
  }

  private getAuthFlows(i: ToolInput<'get_auth_flows'>): ToolResult {
    if (!this.deps.analyzeAuth) throw new AgentToolError('auth-flow analysis is not available in this build of Flutter Intercept', 'state');
    const keep = this.filter({ sinceMs: i.sinceMs });
    const list = this.deps.host.getExchanges().filter(keep);
    const byId = new Map(list.map((e) => [e.id, e]));
    let flows: AuthAnalysis['flows'];
    try {
      flows = this.deps.analyzeAuth(list).flows;
    } catch (e) {
      throw new AgentToolError(`auth-flow analysis failed: ${(e as Error)?.message ?? String(e)}`, 'internal');
    }
    const shown = flows.slice(-50);
    return {
      flows: shown.map((f) => ({
        steps: f.steps.map((s) => {
          const e = byId.get(s.exchangeId);
          return {
            exchangeId: s.exchangeId,
            role: s.role,
            at: s.at,
            ...(e ? { method: e.method, url: this.url(e.url), ...(e.status !== undefined ? { status: e.status } : {}) } : {}),
          };
        }),
        ...(f.stampede ? { stampede: f.stampede } : {}),
        ...(f.problem ? { problem: this.text(f.problem) } : {}),
      })),
      total: flows.length,
      ...(flows.length ? {} : { note: 'no 401/403 followed by a refresh call was recorded; expire_token makes the next request(s) get 401' }),
    };
  }

  private addSequence(i: ToolInput<'add_sequence'>): ToolResult {
    const steps = i.steps.map((st, n) => {
      const count = st.count !== undefined ? { count: st.count } : {};
      switch (st.kind) {
        case 'mock': {
          const isJson = st.body !== undefined && typeof st.body !== 'string';
          const headers: Record<string, string> = { ...(st.headers ?? {}) };
          if (isJson && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
          const body = st.body === undefined ? '' : isJson ? JSON.stringify(st.body) : (st.body as string);
          const why = agentMockRefusal(i.url, st.status, headers, isJson ? '' : body);
          if (why) throw new AgentToolError(`add_sequence refused (step ${n + 1}): ${why}`, 'invalid');
          return { action: { kind: 'mock' as const, status: st.status, ...(Object.keys(headers).length ? { headers } : {}), body, ...(st.delayMs !== undefined ? { delayMs: st.delayMs } : {}) }, ...count };
        }
        case 'block':
          return { action: st.mode === 'reset' ? { kind: 'block' as const, mode: 'reset' as const } : { kind: 'block' as const, mode: 'status' as const, status: st.status }, ...count };
        case 'fault':
          return { action: { kind: 'fault' as const, fault: st.fault }, ...count };
        case 'throttle':
          return {
            action: { kind: 'throttle' as const, ...throttleFields(st) },
            ...count,
          };
        default:
          return { action: { kind: 'passthrough' as const }, ...count };
      }
    });
    const summary = i.steps.map((st) => `${st.kind === 'mock' ? st.status : st.kind}${st.count && st.count > 1 ? `×${st.count}` : ''}`).join(' → ');
    const fallback = `sequence ${i.method ?? '*'} ${i.url}${opLabel(i)}: ${summary}`;
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, fallback.length > 300 ? `${fallback.slice(0, 299)}…` : fallback),
      match: this.match(i),
      action: { kind: 'sequence', steps, then: i.then },
    });
  }

  private expireToken(i: ToolInput<'expire_token'>): ToolResult {
    let rule: Rule;
    try {
      rule = expireTokenRule(this.newId(), i.url, i.count, { namePrefix: AGENT_RULE_PREFIX });
    } catch (e) {
      throw new AgentToolError((e as Error).message, 'invalid');
    }
    return { ...this.insertRule(rule), count: i.count, match: rule.match.url };
  }

  /** CONTRACTS §12.7: agents may only map to loopback targets (local backends), and never match-all. */
  private addMapRemote(i: ToolInput<'add_map_remote'>): ToolResult {
    if (!urlGlobHasHost(i.url)) {
      throw new AgentToolError(`add_map_remote needs a url with a host, e.g. "https://api.example.com/*" (got ${JSON.stringify(i.url.slice(0, 100))})`, 'invalid');
    }
    let to: URL;
    try {
      to = checkMapTarget(i.to, 'to');
    } catch (e) {
      throw new AgentToolError((e as Error).message, 'invalid');
    }
    if (!LOOPBACK_HOSTS.has(to.hostname.toLowerCase())) {
      throw new AgentToolError(
        `agents can only map requests to a local server (localhost, 127.0.0.1 or [::1]); got ${JSON.stringify(to.hostname.slice(0, 100))}. Mapping to another host can be set up by the user in the Flutter Intercept panel.`,
        'invalid',
      );
    }
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(undefined, `map ${i.method ?? '*'} ${i.url} → ${to.origin}`),
      match: this.match(i),
      action: { kind: 'mapRemote', to: i.to },
    });
  }

  /**
   * CONTRACTS §12.7: no request headers whose names match the redaction rules (an agent must not inject or replace
   * credentials), no "[redacted]" values, and — while redaction is on — no body find/replace: a conditional
   * replacement is an oracle for redacted values (a matching `find` changes what the agent then sees).
   */
  private addRewrite(i: ToolInput<'add_rewrite'>): ToolResult {
    const bad = (m: string) => new AgentToolError(m, 'invalid');
    if (!urlGlobHasHost(i.url)) throw bad(`add_rewrite needs a url with a host, e.g. "https://api.example.com/*" (got ${JSON.stringify(i.url.slice(0, 100))})`);
    if (!i.request && !i.response) throw bad('pass request and/or response changes');
    const hasRedacted = (v: string) => v.includes(REDACTED) || v.includes(encodeURIComponent(REDACTED));
    for (const [side, spec] of [['request', i.request], ['response', i.response]] as const) {
      if (!spec) continue;
      for (const [name, value] of Object.entries(spec.setHeaders ?? {})) {
        if (side === 'request' && isSensitiveHeader(name)) {
          throw bad(`request.setHeaders: "${name}" carries credentials, which agents can't set (they only see them redacted); the user can add such a rewrite in the panel`);
        }
        if (AGENT_REWRITE_FORBIDDEN.test(name.trim())) {
          throw bad(`${side}.setHeaders: agents can't set "${name}" (redirect, cookie, browser security policy or forwarding headers); the user can add such a rewrite in the panel`);
        }
        if (side === 'response' && name.trim().toLowerCase() === 'content-type' && ACTIVE_CONTENT.test(value)) {
          throw bad(`response.setHeaders: content-type "${value.slice(0, 100)}" is refused for agents: a browser would run it (HTML, JavaScript or SVG)`);
        }
        if (hasRedacted(value)) throw bad(`${side}.setHeaders "${name}": "[redacted]" is a placeholder, not a value`);
      }
      if (spec.replaceBody?.length) {
        if (side === 'request') {
          throw bad('request.replaceBody is not available to agents: changing what the real server receives (callback URLs, e-mail addresses, amounts) needs the user; use resend_request with an edited body to try a different payload');
        }
        if (spec.replaceBody.some((r) => SCRIPTISH.test(r.replace))) throw bad('response.replaceBody: the replacement looks like markup or script, which agents may not inject');
        if (this.redact) {
          throw bad(`${side}.replaceBody is not available to agents while secrets are redacted (a find/replace could reveal redacted values); use add_mutation to change JSON fields`);
        }
        for (const r of spec.replaceBody) if (hasRedacted(r.find) || hasRedacted(r.replace)) throw bad(`${side}.replaceBody: "[redacted]" is a placeholder, not a value`);
      }
    }
    const strip = <T extends object>(o: T | undefined): T | undefined => (o && Object.keys(o).length ? o : undefined);
    const request = strip(i.request);
    const response = strip(i.response);
    if (!request && !response) throw bad('pass request and/or response changes');
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `rewrite ${i.method ?? '*'} ${i.url}${opLabel(i)}`),
      match: this.match(i),
      action: { kind: 'rewrite', ...(request ? { request } : {}), ...(response ? { response } : {}) },
      ...this.spending(i),
    });
  }

  // ------------------------------------------------------------------ v0.7.0 (CONTRACTS §13.8)

  /** The document title / file name base: the given title, else the app's pubspec name, else the folder name. */
  private projectTitle(root: string): string {
    return this.deps.appPackageName?.() || path.basename(root) || 'Flutter app';
  }

  /** export_openapi / export_postman: redacted per setting, written under .dart_tool/flutter_intercept/exports/. */
  private async exportSpec(format: 'openapi' | 'postman', i: ToolInput<'export_openapi'>): Promise<ToolResult> {
    const build = format === 'openapi' ? this.deps.exporters?.openapi : this.deps.exporters?.postman;
    if (!build) throw new AgentToolError(`${format === 'openapi' ? 'OpenAPI' : 'Postman'} export is not available in this build of Flutter Intercept`, 'state');
    const root = this.deps.projectRoot();
    if (!root) throw new AgentToolError('no workspace folder is open to export into', 'state');
    const keep = this.filter({ url: i.url, method: i.method, sinceMs: i.sinceMs, includeBrowserInternal: i.includeBrowserInternal });
    const list = this.deps.host.getExchanges().filter(keep);
    let r: ExportResult;
    try {
      r = build(list, { title: i.title ?? this.projectTitle(root), redact: this.redact });
    } catch (e) {
      throw new AgentToolError(`the ${format} export failed: ${(e as Error)?.message ?? String(e)}`, 'internal');
    }
    if (!r.exchanges) {
      throw new AgentToolError(`no finished HTTP request${i.url ? ` matches ${i.url}` : ' is recorded'}${i.sinceMs !== undefined ? ' since sinceMs' : ''}; make the app call the API first (WebSocket, SSE and browser-internal traffic is not exported)`, 'not_found');
    }
    const file = await writeExportFile(root, r.text, format === 'openapi' ? '.openapi.json' : '.postman_collection.json', new Date(this.now()));
    return { path: file, exchanges: r.exchanges, routes: r.routes, notes: r.notes.slice(0, 50).map((n) => this.text(String(n))), redacted: this.redact };
  }

  /**
   * take_screenshot (CONTRACTS §13.8): allowed under read-only access (the front doors confirm every call), refused
   * when `flutterIntercept.agent.screenshots` is off. The PNG travels as an image part (TOOL_IMAGES), the JSON
   * names the file and the requests that started in the SCREENSHOT_RECENT_MS before it (redacted summaries).
   */
  private async takeScreenshot(i: ToolInput<'take_screenshot'>): Promise<ToolResult> {
    if (this.deps.getSettings().screenshots === false) {
      throw new AgentToolError('screenshots are turned off for agents (setting flutterIntercept.agent.screenshots)', 'access');
    }
    if (!this.deps.takeScreenshot) throw new AgentToolError('screenshots are not available in this build of Flutter Intercept', 'state');
    const sessions = this.deps.launcher.sessions();
    let session: (typeof sessions)[number] | undefined;
    if (i.sessionId !== undefined) {
      session = sessions.find((s) => s.id === i.sessionId);
      if (!session) throw new AgentToolError(`no intercepted debug session "${i.sessionId}" (get_status lists them)`, 'not_found');
    } else if (sessions.length === 1) {
      session = sessions[0];
    } else if (!sessions.length) {
      throw new AgentToolError('no app is running: start it with launch_app first', 'state');
    } else {
      throw new AgentToolError(`${sessions.length} apps are running; pass sessionId (one of ${sessions.map((s) => s.id).slice(0, 10).join(', ')})`, 'invalid');
    }
    const root = this.deps.projectRoot();
    if (!root) throw new AgentToolError('no workspace folder is open to save the screenshot into', 'state');
    let shot: Screenshot;
    try {
      shot = await this.deps.takeScreenshot({ sessionId: session.id, ...(session.deviceId ? { deviceId: session.deviceId } : {}), projectRoot: root });
    } catch (e) {
      throw new AgentToolError(`take_screenshot: ${this.text((e as Error)?.message ?? String(e))}`, 'state');
    }
    const at = Number.isFinite(shot.takenAt) ? shot.takenAt : this.now();
    const recent = this.deps.host
      .getExchanges()
      .filter((e) => !e.browserInternal && e.startedAt >= at - SCREENSHOT_RECENT_MS && e.startedAt <= at)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, SCREENSHOT_RECENT_MAX)
      .map((e) => this.summary(e));
    const bytes = shot.png?.length ?? 0;
    const inline = bytes > 0 && bytes <= MAX_SCREENSHOT_BYTES;
    const result: ToolResult = {
      path: shot.path,
      ...(shot.width !== undefined ? { width: shot.width } : {}),
      ...(shot.height !== undefined ? { height: shot.height } : {}),
      takenAt: at,
      method: shot.method,
      bytes,
      sessionId: session.id,
      ...(session.deviceId ? { deviceId: session.deviceId } : {}),
      recentRequests: recent,
      ...(inline ? {} : { note: bytes ? 'the image is too large to send inline; open the file at path' : 'the screenshot is empty' }),
    };
    if (inline) {
      const images: ToolImage[] = [{ data: shot.png.toString('base64'), mimeType: 'image/png' }];
      Object.defineProperty(result, TOOL_IMAGES, { value: images, enumerable: false });
    }
    return result;
  }
}

/** Does this rule (or a sequence step) run a script? */
function hasScript(rule: Rule): boolean {
  const a = rule.action as RuleAction | undefined;
  if (!a) return false;
  if (a.kind === 'script') return true;
  return a.kind === 'sequence' && (a.steps ?? []).some((s) => (s.action as { kind?: string })?.kind === 'script');
}

/** " (GraphQL GetUser)" for rule names. */
function opLabel(i: { graphqlOperation?: string }): string {
  return i.graphqlOperation ? ` (GraphQL ${i.graphqlOperation})` : '';
}

const isRedacted = (v: string) => v === REDACTED || v === encodeURIComponent(REDACTED);

/** JSON type name as assert_traffic uses it ("integer" is also a "number"). */
function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string, boolean, object
}

function typeMatches(v: unknown, want: string): boolean {
  const t = jsonType(v);
  return t === want || (want === 'number' && t === 'integer');
}

/** A value described without revealing it (assert_traffic failure texts). */
function describeValue(v: unknown): string {
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

export function createAgentApi(deps: AgentApiDeps): AgentApi {
  return new AgentApi(deps);
}
