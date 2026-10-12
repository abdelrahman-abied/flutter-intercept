/**
 * The state and helpers every agent tool uses (QUALITY-1 Q5): settings-dependent views of URLs and text, filters,
 * rule insertion, lookups. Tools get an AgentViews (views.ts), which extends this.
 */
import * as os from 'os';
import * as path from 'path';
import type { Exchange, Matcher, Rule } from '@flutter-intercept/proxy';
import type { CodegenService } from '../codegen/types';
import type { RecordingService } from '../recordings/types';
import { GRPC_WEB_RESEND, readOnlyReason, validateRule } from '../ui/controller';
import { redactText, redactUrl } from './redact';
import { scrubAbsolutePaths, type GrpcDeps } from '../grpc/service';
import type { GrpcSchema } from '../grpc/types';
import { TRIGGER_WINDOW_MS } from './schema';
import { AgentToolError, ToolResult } from './types';
import { AGENT_RULE_PREFIX, sensitiveQueryProbe, compileFilter, hasScript } from './shared';
import type { AgentApiDeps, ExchangeFilter } from './shared';

export class AgentContext {
  /** Time captured just before the latest launch_app/hot_restart triggered through this API. */
  lastTriggerAt?: number;

  constructor(readonly deps: AgentApiDeps) {}

  now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Runs a launch/restart and records the time captured just BEFORE it was triggered, so a following
   * wait_for_request also sees requests the app sent before the wait began (the restarted app is fast).
   */
  async triggered(run: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
    const sinceMs = this.now();
    const result = await run();
    this.lastTriggerAt = sinceMs;
    return { ...result, sinceMs };
  }

  /** wait_for_request's default `sinceMs`: the latest trigger if within TRIGGER_WINDOW_MS, else now. */
  defaultSince(): number {
    const now = this.now();
    return this.lastTriggerAt !== undefined && now - this.lastTriggerAt <= TRIGGER_WINDOW_MS ? this.lastTriggerAt : now;
  }

  get redact(): boolean {
    return this.deps.getSettings().redactSecrets;
  }

  // ------------------------------------------------------------------ views

  url(u: string): string {
    return this.redact ? redactUrl(u) : u;
  }

  /** Free text that may embed URLs or tokens (`error`, `cors.problem`): REVIEW-5 #5. */
  text(t: string): string {
    return this.redact ? redactText(t) : t;
  }

  /** An exchange filter for this call (compiled once; matches the agent's view of the URL). */
  filter(f: ExchangeFilter): (e: Exchange) => boolean {
    const view = this.redact ? redactUrl : (u: string) => u;
    return compileFilter(f, view);
  }

  /** The schema service's current schema, if gRPC support is on and a schema was found. */
  grpcSchema(): GrpcSchema | undefined {
    const g = this.deps.grpc;
    try {
      return g && g.enabled() ? g.schema() : undefined;
    } catch {
      return undefined;
    }
  }

  /** REVIEW-10 #4: a problem / error text for agents — absolute paths become project-relative (or a base name). */
  scrub(t: string): string {
    const root = this.deps.projectRoot();
    let home = '';
    try {
      home = os.homedir();
    } catch {
      home = '';
    }
    return this.text(scrubAbsolutePaths(String(t), (abs) => this.projectPath(abs) ?? (path.basename(abs) || '…'), [root ?? '', home]));
  }

  find(id: string): Exchange {
    const e = this.deps.host.getExchanges().find((x) => x.id === id);
    if (!e) throw new AgentToolError(`no recorded exchange with id "${id}" (it may have been cleared or evicted)`, 'not_found');
    return e;
  }

  newId(): string {
    return this.deps.newRuleId?.() ?? `agent_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  label(name: string | undefined, fallback: string): string {
    const n = (name ?? '').trim() || fallback;
    return n.startsWith(AGENT_RULE_PREFIX) ? n : `${AGENT_RULE_PREFIX}${n}`;
  }

  /** A rule matcher from an agent's url / method / graphqlOperation. */
  match(i: { url: string; method?: string; graphqlOperation?: string }): Matcher {
    return { url: i.url, ...(i.method ? { method: i.method.toUpperCase() } : {}), ...(i.graphqlOperation ? { graphqlOperation: i.graphqlOperation } : {}) };
  }

  /** Validates with the host's rule validation and inserts the rule FIRST (it wins). */
  insertRule(rule: Rule): ToolResult {
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

  pausedOrThrow(id: string): Exchange {
    const e = this.find(id);
    if (e.state !== 'paused-request' && e.state !== 'paused-response') {
      throw new AgentToolError(`exchange "${id}" is not paused (state: ${e.state})`, 'state');
    }
    return e;
  }

  /** `times` / `ttlMs` → the rule's spending fields. */
  spending(i: { times?: number; ttlMs?: number }): Pick<Rule, 'times' | 'expiresAt'> {
    return { ...(i.times !== undefined ? { times: i.times } : {}), ...(i.ttlMs !== undefined ? { expiresAt: this.now() + i.ttlMs } : {}) };
  }

  /**
   * REVIEW-3 #1 / CONTRACTS §9.5: only an app exchange that reached the real server unchanged may be resent:
   * no `initiator`, `completed`, no `matchedRuleId` (mock/block/fault/throttle/breakpoint, incl. a paused-then-
   * edited request), not from the LAN listener (`viaLan`: `send` uses the loopback listener, which has neither
   * the §7 SSRF guard nor would it keep the 10.0.2.2 meaning), and not a synthetic lan-… or tls-… record.
   * Returns why not, or undefined when allowed.
   */
  resendRefusal(e: Exchange): string | undefined {
    const ro = readOnlyReason(e);
    if (ro) return `exchange "${e.id}": ${ro}`;
    if (e.kind === 'websocket') return `exchange "${e.id}" is a WebSocket connection; only plain HTTP requests can be resent`;
    if (e.kind === 'sse') return `exchange "${e.id}" is a server-sent event stream; resending it would hold a stream open, so only plain HTTP requests can be resent`;
    if (e.kind === 'tunnel') return `exchange "${e.id}" is a TLS connection passed through without decryption (flutterIntercept.tlsPassthrough); its request was never seen, so it can't be resent`;
    if (e.grpc?.web) return `exchange "${e.id}": ${GRPC_WEB_RESEND.replace(/\.$/, '').replace(/^R/, 'r')}`;
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

  codegenOrThrow(): CodegenService {
    if (!this.deps.codegen) throw new AgentToolError('code generation is not available in this build of Flutter Intercept', 'state');
    return this.deps.codegen;
  }

  template(): (p: string) => string {
    const cg = this.codegenOrThrow();
    return (p) => cg.routeTemplate(p);
  }

  recordingsOrThrow(): RecordingService {
    if (!this.deps.recordings) throw new AgentToolError('recordings are not available (no Flutter project folder is open)', 'state');
    return this.deps.recordings;
  }

  async loadRecording(id: string) {
    try {
      return await this.recordingsOrThrow().load(id);
    } catch (e) {
      if (e instanceof AgentToolError) throw e;
      throw new AgentToolError(`no recording "${id}" (see list_recordings): ${(e as Error)?.message ?? String(e)}`, 'not_found');
    }
  }

  changed(): void {
    try {
      this.deps.recordingsChanged?.();
    } catch {
      // the panel refresh never breaks a tool call
    }
  }

  /** A path inside the project as project-relative, otherwise undefined (never an absolute path, REVIEW-3 #4). */
  projectPath(p: string | undefined): string | undefined {
    const root = this.deps.projectRoot();
    if (!p || !root) return undefined;
    const rel = path.relative(root, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
  }

  /** gRPC deps, or a readable tool error when gRPC support is missing or off. */
  grpcOrThrow(): GrpcDeps {
    const g = this.deps.grpc;
    if (!g) throw new AgentToolError('gRPC support is not available in this build of Flutter Intercept', 'state');
    if (!g.enabled()) throw new AgentToolError('gRPC support is off (setting flutterIntercept.grpc.enabled)', 'state');
    return g;
  }
}
