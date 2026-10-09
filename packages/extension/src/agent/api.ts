/**
 * The single implementation of the agent tools (CONTRACTS §8). The MCP server and the VS Code
 * language model tools only translate to `call(tool, input)`. No `vscode` import: everything it
 * needs comes in through `AgentApiDeps` (wired by extension.ts).
 */
import type { Body, Exchange, RequestEdit, ResponseEdit, Rule } from '@flutter-intercept/proxy';
import { matches } from '@flutter-intercept/proxy/rules';
import { validateEdit, validateRule } from '../ui/controller';
import { buildHar, writeHar } from './har';
import { redactBodyText, redactHeaders, redactUrl } from './redact';
import { parseToolInput, ToolInput, TRIGGER_WINDOW_MS } from './schema';
import { AgentAccess, AgentTools, AgentToolError, AppLauncher, isWriteTool, ToolName, ToolResult } from './types';

export const AGENT_RULE_PREFIX = '[agent] ';
export const FINAL_STATES = new Set<Exchange['state']>(['completed', 'mocked', 'blocked', 'aborted', 'error']);

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
  };
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
    return this.detail(this.find(i.id), i.includeBodies, i.maxBodyChars);
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
    });
  }

  private addBlock(i: ToolInput<'add_block'>): ToolResult {
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `block ${i.method ?? '*'} ${i.url}`),
      match: { url: i.url, ...(i.method ? { method: i.method.toUpperCase() } : {}) },
      action: i.mode === 'reset' ? { kind: 'block', mode: 'reset' } : { kind: 'block', mode: 'status', status: i.status },
    });
  }

  private addBreakpoint(i: ToolInput<'add_breakpoint'>): ToolResult {
    return this.insertRule({
      id: this.newId(),
      enabled: true,
      name: this.label(i.name, `break ${i.phase} ${i.method ?? '*'} ${i.url}`),
      match: { url: i.url, ...(i.method ? { method: i.method.toUpperCase() } : {}) },
      action: { kind: 'breakpoint', phase: i.phase },
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
}

export function createAgentApi(deps: AgentApiDeps): AgentApi {
  return new AgentApi(deps);
}
