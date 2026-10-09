/**
 * Routes CONTRACTS §4 messages between the webview(s) and the proxy host. No `vscode` import,
 * so it is unit-tested with a fake host.
 *
 * Host obligations (CONTRACTS §4, docs/spikes/webview.md): `snapshot` for every `ready`;
 * `rules` after `setRules` / `createRuleFromExchange` (new rule inserted FIRST); `cleared` then a
 * fresh `snapshot` after `clear` (the proxy keeps in-flight exchanges); `status` after
 * `setInterceptEnabled`; `removed` for evictions; `error` for failed actions.
 * `exchange` updates are coalesced per id and flushed every `throttleMs`.
 */
import type { Exchange, RequestEdit, ResponseEdit, Rule, RuleAction } from '@flutter-intercept/proxy';
import { ruleFromExchange } from '@flutter-intercept/proxy/rules';
import type { HostMsg, Status, ViewMsg } from './protocol';

export type Sink = (msg: HostMsg) => void;

export interface ControllerHost {
  readonly running: boolean;
  readonly port: number | undefined;
  /** Open LAN listener (no token), CONTRACTS §7; `peer` = the device it is pinned to. */
  readonly lan?: { host: string; port: number; peer?: string };
  getExchanges(): Exchange[];
  getRules(): Rule[];
  setRules(rules: Rule[]): void;
  clear(): void;
  resume(id: string, edit?: RequestEdit | ResponseEdit): void;
  abort(id: string): void;
  on(event: 'exchange', l: (e: Exchange) => void): unknown;
  on(event: 'removed', l: (ids: string[]) => void): unknown;
  on(event: 'state', l: (running: boolean) => void): unknown;
}

export interface ControllerDeps {
  host: ControllerHost;
  saveRules: (rules: Rule[]) => unknown;
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => Promise<unknown>;
  newRuleId?: () => string;
  throttleMs?: number;
  log?: (msg: string) => void;
}

const RULE_KINDS = new Set<RuleAction['kind']>(['mock', 'block', 'breakpoint']);

// ---------------------------------------------------------------------------------------------
// Host-side validation of everything the webview sends (review #7). The webview is ours, but
// the host must never persist or apply a malformed rule (a rule without `match` must not become
// match-all) nor forward an edit the proxy would turn into a broken response for the app.
// ---------------------------------------------------------------------------------------------

export class InvalidMessageError extends Error {}

const MAX_RULES = 1000;
const MAX_TEXT = 64 * 1024 * 1024; // bodies (well above the proxy's 5 MB body cap)
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // RFC 9110 token (header names, methods)

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(where: string, what: string): never {
  throw new InvalidMessageError(`${where}: ${what}`);
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(where, `unknown field "${k}"`);
}

function checkStatus(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 100 || v > 599) fail(where, 'status must be an integer 100–599');
  return v;
}

function checkHeaderValue(v: unknown, where: string): void {
  if (typeof v !== 'string') fail(where, 'header values must be strings');
  if (/[\r\n\0]/.test(v)) fail(where, 'header values must not contain CR, LF or NUL');
}

/** `Record<string, string>` (mock headers) or, with `multi`, `Record<string, string | string[]>` (edits). */
function checkHeaders(v: unknown, where: string, multi: boolean): void {
  if (!isObj(v)) fail(where, 'headers must be an object');
  for (const [name, value] of Object.entries(v)) {
    if (!TOKEN.test(name)) fail(where, `invalid header name "${name}"`);
    if (multi && Array.isArray(value)) value.forEach((x) => checkHeaderValue(x, `${where} "${name}"`));
    else checkHeaderValue(value, `${where} "${name}"`);
  }
}

function checkBody(v: unknown, where: string): void {
  if (typeof v !== 'string') fail(where, 'body must be a string');
  if (v.length > MAX_TEXT) fail(where, 'body is too large');
}

export function validateRule(raw: unknown, where = 'rule'): Rule {
  if (!isObj(raw)) fail(where, 'must be an object');
  onlyKeys(raw, ['id', 'enabled', 'name', 'match', 'action'], where);
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 200) fail(where, 'id must be a non-empty string');
  if (typeof raw.enabled !== 'boolean') fail(where, 'enabled must be a boolean');
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 500)) fail(where, 'name must be a string');
  const m = raw.match;
  if (!isObj(m)) fail(where, 'match is required (a rule without match would match everything)');
  onlyKeys(m, ['url', 'method'], `${where}.match`);
  if (typeof m.url !== 'string' || !m.url.trim() || m.url.length > 8192) fail(`${where}.match`, 'url must be a non-empty string (use "*" to match everything)');
  if (m.method !== undefined && (typeof m.method !== 'string' || (m.method !== '' && m.method !== '*' && !TOKEN.test(m.method)))) {
    fail(`${where}.match`, 'method must be an HTTP method name');
  }
  const a = raw.action;
  if (!isObj(a)) fail(where, 'action is required');
  const aw = `${where}.action`;
  switch (a.kind) {
    case 'mock':
      onlyKeys(a, ['kind', 'status', 'headers', 'body', 'delayMs'], aw);
      checkStatus(a.status, aw);
      if (a.headers !== undefined) checkHeaders(a.headers, aw, false);
      checkBody(a.body, aw);
      if (a.delayMs !== undefined && (typeof a.delayMs !== 'number' || !Number.isInteger(a.delayMs) || a.delayMs < 0 || a.delayMs > 600_000)) {
        fail(aw, 'delayMs must be an integer 0–600000');
      }
      break;
    case 'block':
      onlyKeys(a, ['kind', 'mode', 'status'], aw);
      if (a.mode !== 'reset' && a.mode !== 'status') fail(aw, 'mode must be "reset" or "status"');
      if (a.status !== undefined) checkStatus(a.status, aw);
      break;
    case 'breakpoint':
      onlyKeys(a, ['kind', 'phase'], aw);
      if (a.phase !== 'request' && a.phase !== 'response' && a.phase !== 'both') fail(aw, 'phase must be "request", "response" or "both"');
      break;
    default:
      fail(aw, `unknown kind ${JSON.stringify(a.kind)}`);
  }
  return raw as unknown as Rule;
}

export function validateRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) fail('setRules', 'rules must be an array');
  if (raw.length > MAX_RULES) fail('setRules', `at most ${MAX_RULES} rules`);
  const ids = new Set<string>();
  return raw.map((r, i) => {
    const rule = validateRule(r, `rule ${i + 1}`);
    if (ids.has(rule.id)) fail(`rule ${i + 1}`, `duplicate id "${rule.id}"`);
    ids.add(rule.id);
    return rule;
  });
}

/**
 * Validates a resume edit. `phase` (from the paused exchange) narrows the allowed fields:
 * a paused request accepts method/url/headers/body, a paused response status/headers/body.
 */
export function validateEdit(raw: unknown, phase?: 'request' | 'response'): RequestEdit | ResponseEdit | undefined {
  if (raw === undefined || raw === null) return undefined;
  const where = 'edit';
  if (!isObj(raw)) fail(where, 'must be an object');
  const allowed = phase === 'request' ? ['method', 'url', 'headers', 'body'] : phase === 'response' ? ['status', 'headers', 'body'] : ['method', 'url', 'status', 'headers', 'body'];
  onlyKeys(raw, allowed, where);
  if (raw.method !== undefined && (typeof raw.method !== 'string' || !TOKEN.test(raw.method))) fail(where, 'method must be an HTTP method name');
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string') fail(where, 'url must be a string');
    let u: URL;
    try {
      u = new URL(raw.url);
    } catch {
      fail(where, `url must be absolute: ${raw.url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(where, 'url must be http(s)');
  }
  if (raw.status !== undefined) checkStatus(raw.status, where);
  if (raw.headers !== undefined) checkHeaders(raw.headers, where, true);
  if (raw.body !== undefined) checkBody(raw.body, where);
  return raw as RequestEdit | ResponseEdit;
}

function checkId(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v) fail(where, 'id must be a non-empty string');
  return v;
}

/** Turns a ruleFromExchange failure (proxy's typed error for truncated/binary bodies, review #8) into user text. */
export function ruleFromExchangeErrorMessage(e: unknown, kind: string): string {
  const err = e as { code?: unknown; message?: unknown };
  const what = kind === 'mock' ? 'a mock rule' : `a ${kind} rule`;
  if (err?.code === 'truncated') return `Can't create ${what} from this exchange: its response body was truncated (too large to store), so the mock would be incomplete.`;
  if (err?.code === 'binary') return `Can't create ${what} from this exchange: its response body is binary, and mock bodies are text.`;
  const msg = typeof err?.message === 'string' && err.message ? err.message : String(e);
  return `Can't create ${what} from this exchange: ${msg}`;
}

export class InterceptController {
  private readonly sinks = new Set<Sink>();
  private readonly pending = new Map<string, Exchange>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly paused = new Set<string>();
  private sessions = 0;
  private pausedListeners: ((count: number) => void)[] = [];
  /** Test hook: every message sent, by type. */
  readonly sentCounts: Record<string, number> = {};
  readyCount = 0;

  constructor(private readonly deps: ControllerDeps) {
    deps.host.on('exchange', (e) => this.onExchange(e));
    deps.host.on('removed', (ids) => this.onRemoved(ids));
    // Start/stop/restart: the exchange list belongs to the proxy instance, so resend everything.
    deps.host.on('state', () => {
      this.pending.clear();
      this.recomputePaused(deps.host.getExchanges());
      this.broadcast(this.snapshot());
    });
  }

  attach(sink: Sink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  get pausedCount(): number {
    return this.paused.size;
  }

  onPausedCount(l: (count: number) => void): void {
    this.pausedListeners.push(l);
  }

  status(): Status {
    return {
      proxyRunning: this.deps.host.running,
      port: this.deps.host.port,
      interceptEnabled: this.deps.getEnabled(),
      sessions: this.sessions,
      ...(this.deps.host.lan
        ? { lan: { host: this.deps.host.lan.host, port: this.deps.host.lan.port, ...(this.deps.host.lan.peer ? { peer: this.deps.host.lan.peer } : {}) } }
        : {}),
    };
  }

  setSessions(n: number): void {
    if (n === this.sessions) return;
    this.sessions = n;
    this.broadcastStatus();
  }

  broadcastStatus(): void {
    this.broadcast({ type: 'status', status: this.status() });
  }

  snapshot(): HostMsg {
    return { type: 'snapshot', exchanges: this.deps.host.getExchanges(), rules: this.deps.host.getRules(), status: this.status() };
  }

  async handle(raw: unknown, reply: Sink): Promise<void> {
    const msg = raw as ViewMsg;
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    try {
      switch (msg.type) {
        case 'ready':
          this.readyCount++;
          this.flush();
          this.send(reply, this.snapshot());
          return;
        case 'resume': {
          const id = checkId(msg.id, 'resume');
          const ex = this.deps.host.getExchanges().find((e) => e.id === id);
          const phase = ex?.state === 'paused-request' ? 'request' : ex?.state === 'paused-response' ? 'response' : undefined;
          this.deps.host.resume(id, validateEdit(msg.edit, phase));
          return;
        }
        case 'abort':
          this.deps.host.abort(checkId(msg.id, 'abort'));
          return;
        case 'setRules':
          this.applyRules(msg.rules);
          return;
        case 'clear':
          this.clear();
          return;
        case 'setInterceptEnabled':
          if (typeof msg.enabled !== 'boolean') fail('setInterceptEnabled', 'enabled must be a boolean');
          await this.deps.setEnabled(msg.enabled);
          this.broadcastStatus();
          return;
        case 'createRuleFromExchange': {
          if (!RULE_KINDS.has(msg.action)) fail('createRuleFromExchange', `unknown rule action ${JSON.stringify(msg.action)}`);
          const id = checkId(msg.id, 'createRuleFromExchange');
          const ex = this.deps.host.getExchanges().find((e) => e.id === id);
          if (!ex) throw new Error('That exchange is no longer available.');
          let rule: Rule;
          try {
            rule = validateRule(ruleFromExchange(ex, msg.action, this.newRuleId()));
          } catch (e) {
            throw new Error(ruleFromExchangeErrorMessage(e, msg.action));
          }
          this.applyRules([rule, ...this.deps.host.getRules()]);
          return;
        }
        default:
          return;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log?.(`webview action ${msg.type} failed: ${message}`);
      this.send(reply, { type: 'error', message });
    }
  }

  /** Also used by the `flutterIntercept.clear` command. */
  clear(): void {
    this.deps.host.clear();
    this.pending.clear();
    this.recomputePaused(this.deps.host.getExchanges());
    this.broadcast({ type: 'cleared' });
    this.broadcast(this.snapshot());
  }

  /** Validates (throws InvalidMessageError, nothing applied or persisted), then applies + persists + broadcasts. */
  applyRules(input: Rule[]): void {
    const rules = validateRules(input);
    this.deps.host.setRules(rules);
    this.deps.saveRules(rules);
    this.broadcast({ type: 'rules', rules });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.sinks.clear();
  }

  private newRuleId(): string {
    return this.deps.newRuleId?.() ?? `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private onExchange(e: Exchange): void {
    const before = this.paused.size;
    if (e.state === 'paused-request' || e.state === 'paused-response') this.paused.add(e.id);
    else this.paused.delete(e.id);
    if (this.paused.size !== before) this.firePaused();
    this.pending.set(e.id, e);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.deps.throttleMs ?? 50);
  }

  private onRemoved(ids: string[]): void {
    this.flush();
    let changed = false;
    for (const id of ids) changed = this.paused.delete(id) || changed;
    if (changed) this.firePaused();
    this.broadcast({ type: 'removed', ids });
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const exchange of batch) this.broadcast({ type: 'exchange', exchange });
  }

  private recomputePaused(all: Exchange[]): void {
    const before = this.paused.size;
    this.paused.clear();
    for (const e of all) if (e.state === 'paused-request' || e.state === 'paused-response') this.paused.add(e.id);
    if (before !== this.paused.size) this.firePaused();
  }

  private firePaused(): void {
    for (const l of this.pausedListeners) l(this.paused.size);
  }

  private broadcast(msg: HostMsg): void {
    for (const s of this.sinks) this.send(s, msg);
  }

  private send(sink: Sink, msg: HostMsg): void {
    this.sentCounts[msg.type] = (this.sentCounts[msg.type] ?? 0) + 1;
    try {
      sink(msg);
    } catch (e) {
      this.deps.log?.(`postMessage failed: ${String(e)}`);
    }
  }
}
