/**
 * The single implementation of the agent tools (CONTRACTS §8). The MCP server and the VS Code
 * language model tools only translate to `call(tool, input)`. No `vscode` import: everything it
 * needs comes in through `AgentApiDeps` (wired by extension.ts).
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Body, Exchange, RequestEdit, ResponseEdit, Rule, RuleAction, SendRequest, StackFrame } from '@flutter-intercept/proxy';
import { describeProfile, NETWORK_PRESETS, presetProfile, type NetworkPresetId, type NetworkProfile } from '@flutter-intercept/proxy/network';
import { matches } from '@flutter-intercept/proxy/rules';
import { toSnippet } from '../codegen/snippets';
import { sanitizeSendHeaders, validateEdit, validateRule } from '../ui/controller';
import { buildHar, writeHar } from './har';
import { REDACTED, redactBodyText, redactHeaders, redactUrl } from './redact';
import { parseToolInput, ToolInput, TRIGGER_WINDOW_MS } from './schema';
import { bodyShape } from './shape';
import { AgentAccess, AgentTools, AgentToolError, AppLauncher, isWriteTool, ToolName, ToolResult } from './types';

export const AGENT_RULE_PREFIX = '[agent] ';
export const FINAL_STATES = new Set<Exchange['state']>(['completed', 'mocked', 'blocked', 'aborted', 'error']);

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
  /** Live settings: `flutterIntercept.agent.access`, `...agent.redactSecrets`, `flutterIntercept.enabled`. */
  getSettings(): { access: AgentAccess; redactSecrets: boolean; interceptEnabled: boolean };
  /** launch_app / stop_app / hot_restart and the session list for get_status (launch.ts). */
  launcher: AppLauncher;
  /** Project root for export_har (the workspace folder of the Flutter app); undefined = none open. */
  projectRoot(): string | undefined;
  /** Extension version for the HAR creator field. */
  version?: string;
  newRuleId?(): string;
  now?(): number;
}

type StatusFilter = number | '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'error' | undefined;

function statusMatches(e: Exchange, s: StatusFilter): boolean {
  if (s === undefined) return true;
  if (s === 'error') return e.state === 'error' || e.state === 'aborted';
  if (typeof s === 'number') return e.status === s;
  return e.status !== undefined && Math.floor(e.status / 100) === Number(s[0]);
}

function exchangeMatches(e: Exchange, f: { url?: string; method?: string; status?: StatusFilter; sinceMs?: number }): boolean {
  if (f.sinceMs !== undefined && e.startedAt < f.sinceMs) return false;
  if (f.url !== undefined && !matches({ url: f.url, method: f.method }, e.method, e.url)) return false;
  if (f.url === undefined && f.method !== undefined && e.method.toUpperCase() !== f.method.toUpperCase()) return false;
  return statusMatches(e, f.status);
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
        return { rules: this.deps.host.getRules() };
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

  private bodyView(b: Body | undefined, headers: Exchange['requestHeaders'] | undefined, maxChars: number): Record<string, unknown> | undefined {
    if (!b) return undefined;
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
      ...(e.error ? { error: e.error } : {}),
      ...(e.resentFrom ? { resentFrom: e.resentFrom } : {}),
      ...(e.source?.frames?.length ? { hasSource: true } : {}),
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
    };
  }

  private listRequests(i: ToolInput<'list_requests'>): ToolResult {
    const matched = this.deps.host
      .getExchanges()
      .filter((e) => exchangeMatches(e, i) && (i.state === undefined || e.state === i.state))
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
    const f = { url: i.url, method: i.method, status: i.status as StatusFilter, sinceMs: since };
    const hit = (e: Exchange) => FINAL_STATES.has(e.state) && exchangeMatches(e, f);
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
    const list = this.deps.host.getExchanges().filter((e) => exchangeMatches(e, { url: i.url, method: i.method, sinceMs: i.sinceMs }));
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

  /** Validates with the host's rule validation and inserts the rule FIRST (it wins). */
  private insertRule(rule: Rule): ToolResult {
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
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `mock ${i.method ?? '*'} ${i.url} → ${i.status}`),
      match: { url: i.url, ...(i.method ? { method: i.method.toUpperCase() } : {}) },
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
      name: this.label(i.name, `block ${i.method ?? '*'} ${i.url}`),
      match: { url: i.url, ...(i.method ? { method: i.method.toUpperCase() } : {}) },
      action: i.mode === 'reset' ? { kind: 'block', mode: 'reset' } : { kind: 'block', mode: 'status', status: i.status },
      ...this.spending(i),
    });
  }

  private addBreakpoint(i: ToolInput<'add_breakpoint'>): ToolResult {
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `break ${i.phase} ${i.method ?? '*'} ${i.url}`),
      match: { url: i.url, ...(i.method ? { method: i.method.toUpperCase() } : {}) },
      action: { kind: 'breakpoint', phase: i.phase },
      ...this.spending(i),
    });
  }

  private removeRule(i: ToolInput<'remove_rule'>): ToolResult {
    const rules = this.deps.host.getRules();
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
    const custom = i.latencyMs !== undefined || i.kbps !== undefined || i.dropRate !== undefined;
    const bad = (m: string) => new AgentToolError(m, 'invalid');
    if (i.fault && i.profile) throw bad('pass either profile or fault, not both');
    if (!i.fault && !i.profile) throw bad('profile is required (or fault together with a url)');
    if (custom && i.profile !== 'custom') throw bad('latencyMs, kbps and dropRate are only used with profile "custom"');
    if (i.profile === 'custom' && !custom) throw bad('profile "custom" needs latencyMs, kbps and/or dropRate');

    if (i.url === undefined) {
      if (i.fault) throw bad('fault needs a url; to make every request fail use profile "offline"');
      if (i.method !== undefined || i.times !== undefined || i.ttlMs !== undefined || i.name !== undefined) {
        throw bad('method, times, ttlMs and name only apply together with a url (a rule for matching requests)');
      }
      const p: NetworkProfile =
        i.profile === 'none' || i.profile === 'offline'
          ? { kind: i.profile }
          : i.profile === 'custom'
            ? { kind: 'throttle', ...(i.latencyMs !== undefined ? { latencyMs: i.latencyMs } : {}), ...(i.kbps !== undefined ? { kbps: i.kbps } : {}), ...(i.dropRate !== undefined ? { dropRate: i.dropRate } : {}) }
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
      action = { kind: 'throttle', ...(i.latencyMs !== undefined ? { latencyMs: i.latencyMs } : {}), ...(i.kbps !== undefined ? { kbps: i.kbps } : {}), ...(i.dropRate !== undefined ? { dropRate: i.dropRate } : {}) };
      what = describeProfile({ ...action, kind: 'throttle' });
    } else {
      const preset = NETWORK_PRESETS.find((x) => x.id === i.profile)!;
      action = { kind: 'throttle', latencyMs: preset.latencyMs, ...(preset.kbps !== undefined ? { kbps: preset.kbps } : {}), ...(preset.dropRate !== undefined ? { dropRate: preset.dropRate } : {}) };
      what = preset.label;
    }
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `${what} ${i.method ?? '*'} ${i.url}`),
      match: { url: i.url, ...(i.method ? { method: i.method.toUpperCase() } : {}) },
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
}

const isRedacted = (v: string) => v === REDACTED || v === encodeURIComponent(REDACTED);

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
    if (eq === -1 || !isRedacted(part.slice(eq + 1))) return part;
    const key = part.slice(0, eq);
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
