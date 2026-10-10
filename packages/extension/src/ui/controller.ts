/**
 * Routes CONTRACTS §4 messages between the webview(s) and the proxy host. No `vscode` import,
 * so it is unit-tested with a fake host.
 *
 * Host obligations (CONTRACTS §4, docs/spikes/webview.md): `snapshot` for every `ready`;
 * `rules` after `setRules` / `createRuleFromExchange` (new rule inserted FIRST); `cleared` then a
 * fresh `snapshot` after `clear` (the proxy keeps in-flight exchanges); `status` after
 * `setInterceptEnabled`; `removed` for evictions; `error` for failed actions.
 * `exchange` updates are coalesced per id and flushed every `throttleMs`.
 *
 * CONTRACTS §9.3/9.4: `sent` after `send`; `status` after `setNetworkProfile`; `openSource` / `copySnippet`
 * go through injected deps (no reply on success, `error` on failure); a `rule-spent` event from the host
 * removes that rule (persisted + `rules` broadcast).
 *
 * CONTRACTS §10.5: `rules` after `mutateField`; `contract` results (batched with `exchange` updates) for every
 * finished JSON exchange while checking is on, and for the current snapshot on `ready`; `pickModel`,
 * `openViolation`, `generateModel`, `generateFixture` go through injected deps (`error` on failure).
 */
import type { Exchange, RequestEdit, ResponseEdit, Rule, RuleAction, SendRequest } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
import { ruleFromExchange } from '@flutter-intercept/proxy/rules';
import { pathError } from '../agent/paths';
import { decodeJson, decodeSample, defaultFixtureName, FINAL_STATES, defaultModelName, fixtureApiFor, fixtureSamples, isCheckable, modelSamples, redactExchange, routeOf, testPackageFor } from '../agent/samples';
import { SNIPPET_FORMATS, toSnippet } from '../codegen/snippets';
import type { CodegenService, FixtureApi, GeneratedFile } from '../codegen/types';
import type { ContractResult, ContractService } from '../contract/types';
import type { AgentStatus, ContractSummary, HostMsg, SendDraft, SnippetFormat, Status, ViewMsg } from './protocol';

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
  /** CONTRACTS §9.2: a rule's `times` were used up or it expired. Optional on older hosts. */
  on(event: 'rule-spent', l: (ruleId: string, reason: 'times' | 'expired') => void): unknown;
  /** CONTRACTS §9.2: a rule with `times` matched; `used` = matches so far. Optional on older hosts. */
  on(event: 'rule-hit', l: (ruleId: string, used: number) => void): unknown;
  /** CONTRACTS §9.2 `send` (through the proxy, recorded with `initiator`). Optional: older proxy builds lack it. */
  send?(req: SendRequest): Promise<{ id: string }>;
  setNetworkProfile?(p: NetworkProfile): void;
  readonly networkProfile?: NetworkProfile;
}

export interface ControllerDeps {
  host: ControllerHost;
  saveRules: (rules: Rule[]) => unknown;
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => Promise<unknown>;
  newRuleId?: () => string;
  throttleMs?: number;
  log?: (msg: string) => void;
  /** CONTRACTS §8: what the status line shows about AI agents (never the MCP token). */
  getAgentStatus?: () => AgentStatus | undefined;
  /**
   * CONTRACTS §9.4: open `exchange.source.frames[frameIndex]` in an editor (src/source/open.ts). Rejects with a
   * user-readable message ("file not in the workspace", …), which the webview shows.
   */
  openSource?: (exchange: Exchange, frameIndex: number) => Promise<unknown>;
  /** Writes the user's clipboard (`vscode.env.clipboard.writeText`). */
  copyToClipboard?: (text: string) => Promise<unknown>;

  // ---- CONTRACTS §10 (v0.4.0). All optional: without them the matching features answer with an `error`.
  /** The contract checker (src/contract/service.ts). */
  contract?: ContractService;
  /** Setting `flutterIntercept.contractCheck` (default true). Call `recheckContracts()` when it changes. */
  contractCheckEnabled?: () => boolean;
  /** Every new contract result (the lead updates the diagnostics). */
  onContractResult?: (result: ContractResult) => void;
  /** Results dropped: exchanges evicted / cleared, proxy restarted, models changed, checking turned off. */
  onContractRemoved?: (exchangeIds: string[]) => void;
  /** Native model QuickPick for `pickModel`: a model name, undefined = "Don't check this route" (forget), null = cancelled. */
  pickModel?: (exchange: Exchange) => Promise<string | undefined | null>;
  /** Opens `file` (absolute) at the 1-based `line` (`openViolation`). */
  openLocation?: (file: string, line: number) => Promise<unknown>;
  /** Code generation (src/codegen/service.ts). */
  codegen?: CodegenService;
  /** Opens each generated file in an untitled editor. */
  openUntitled?: (files: GeneratedFile[]) => Promise<unknown>;
  /** The Flutter project's root (style detection). */
  projectRoot?: () => string | undefined;
  /** The app's pubspec `name` (fixture imports). */
  appPackageName?: () => string | undefined;
  /** Delay before queued checks start (default 150 ms) and how many run at once (default 2). */
  contractDebounceMs?: number;
  contractConcurrency?: number;
}

/** CONTRACTS §10.5: the panel's view of a contract result (no file paths). */
export function contractSummary(r: ContractResult): ContractSummary {
  return {
    id: r.exchangeId,
    checked: r.checked,
    ...(r.model ? { model: r.model } : {}),
    via: r.via,
    violations: r.violations.map((v) => ({ path: v.path, field: v.field, expected: v.expected, actual: v.actual, severity: v.severity, message: v.message })),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

const CONTRACT_OFF = 'Contract check is off (setting flutterIntercept.contractCheck).';

/**
 * CONTRACTS §10.4: the Retrofit/Chopper interface a mocktail fixture test mocks, from the contract service's
 * endpoint index. Undefined (the generator then falls back to MockClient) without a service or a match.
 */
export async function fixtureApi(
  contract: ContractService | undefined,
  exchanges: Exchange[],
  root: string | undefined,
  packageName: string | undefined,
  log?: (msg: string) => void,
): Promise<FixtureApi | undefined> {
  if (!contract) return undefined;
  try {
    const [endpoints, models] = await Promise.all([contract.endpoints(), contract.models()]);
    return fixtureApiFor(endpoints, exchanges, models, { root, packageName });
  } catch (e) {
    log?.(`fixture API lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Kinds `createRuleFromExchange` can build (throttle/fault rules come from the rule editor). */
const RULE_KINDS = new Set<RuleAction['kind']>(['mock', 'block', 'breakpoint']);
const FAULTS = new Set(['reset', 'timeout', 'truncate', 'dns']);
const PRESET_IDS = new Set(['slow-3g', 'fast-3g', 'flaky']);

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

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** latencyMs 0–600000 (integer), kbps 1–10 000 000, dropRate 0–1; each optional. */
function checkThrottle(a: Record<string, unknown>, where: string): void {
  if (a.latencyMs !== undefined && !isInt(a.latencyMs, 0, 600_000)) fail(where, 'latencyMs must be an integer 0–600000');
  if (a.kbps !== undefined && !isNum(a.kbps, 1, 10_000_000)) fail(where, 'kbps must be a number 1–10000000');
  if (a.dropRate !== undefined && !isNum(a.dropRate, 0, 1)) fail(where, 'dropRate must be a number 0–1');
}

function checkUrl(v: unknown, where: string): string {
  if (typeof v !== 'string') fail(where, 'url must be a string');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    fail(where, `url must be absolute: ${v}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(where, 'url must be http(s)');
  return v;
}

function checkBody(v: unknown, where: string): void {
  if (typeof v !== 'string') fail(where, 'body must be a string');
  if (v.length > MAX_TEXT) fail(where, 'body is too large');
}

export const MAX_MUTATE_OPS = 20;
const MAX_MUTATE_VALUE_CHARS = 1024 * 1024;
const MUTATE_OPS = new Set(['null', 'delete', 'set']);

/**
 * CONTRACTS §10.2: 1–20 ops; path valid (jsonpath.ts), op null|delete|set; `set` needs `value` (a JSON value) or
 * `valueJson` (JSON text, byte-exact, wins over `value`), each ≤ 1 MB.
 */
function checkMutateOps(ops: unknown, where: string): void {
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_MUTATE_OPS) fail(where, `ops must be a list of 1–${MAX_MUTATE_OPS} changes`);
  ops.forEach((op, i) => {
    const ow = `${where}.ops[${i}]`;
    if (!isObj(op)) fail(ow, 'must be an object');
    onlyKeys(op, ['path', 'op', 'value', 'valueJson'], ow);
    const bad = pathError(op.path);
    if (bad) fail(ow, bad);
    if (typeof op.op !== 'string' || !MUTATE_OPS.has(op.op)) fail(ow, 'op must be "null", "delete" or "set"');
    if (op.op !== 'set') {
      if (op.value !== undefined || op.valueJson !== undefined) fail(ow, `value / valueJson are only used with op "set"`);
      return;
    }
    if (op.valueJson !== undefined) {
      if (typeof op.valueJson !== 'string') fail(ow, 'valueJson must be a string of JSON text');
      if (op.valueJson.length > MAX_MUTATE_VALUE_CHARS) fail(ow, 'valueJson must be at most 1 MB');
      try {
        JSON.parse(op.valueJson);
      } catch {
        fail(ow, 'valueJson must be valid JSON text (e.g. "1.0", "12345678901234567890", "\\"text\\"")');
      }
    }
    if (op.value === undefined) {
      if (op.valueJson === undefined) fail(ow, 'op "set" needs a value (or valueJson)');
      return;
    }
    let text: string | undefined;
    try {
      text = JSON.stringify(op.value);
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string' || !isJsonValue(op.value)) fail(ow, 'value must be a JSON value (string, number, boolean, null, array or object)');
    if (text.length > MAX_MUTATE_VALUE_CHARS) fail(ow, 'value must be at most 1 MB as JSON');
  });
}

/** Plain JSON only: no functions, symbols, bigints, NaN/Infinity, class instances or cycles (depth ≤ 200). */
function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 200) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v as Record<string, unknown>).every((x) => isJsonValue(x, depth + 1));
  }
  return false;
}

export function validateRule(raw: unknown, where = 'rule'): Rule {
  if (!isObj(raw)) fail(where, 'must be an object');
  // `used` is display-only (CONTRACTS §9.2 rule-hit): accepted so the webview can round-trip rules, then dropped.
  onlyKeys(raw, ['id', 'enabled', 'name', 'match', 'action', 'times', 'expiresAt', 'used'], where);
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 200) fail(where, 'id must be a non-empty string');
  if (typeof raw.enabled !== 'boolean') fail(where, 'enabled must be a boolean');
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 500)) fail(where, 'name must be a string');
  if (raw.times !== undefined && !isInt(raw.times, 1, 1000)) fail(where, 'times must be an integer 1–1000');
  if (raw.expiresAt !== undefined && (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= 0)) {
    fail(where, 'expiresAt must be a time in epoch milliseconds');
  }
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
    case 'throttle':
      onlyKeys(a, ['kind', 'latencyMs', 'kbps', 'dropRate'], aw);
      checkThrottle(a, aw);
      break;
    case 'fault':
      onlyKeys(a, ['kind', 'fault'], aw);
      if (typeof a.fault !== 'string' || !FAULTS.has(a.fault)) fail(aw, 'fault must be "reset", "timeout", "truncate" or "dns"');
      break;
    case 'mutate':
      onlyKeys(a, ['kind', 'ops'], aw);
      checkMutateOps(a.ops, aw);
      break;
    default:
      fail(aw, `unknown kind ${JSON.stringify(a.kind)}`);
  }
  if ('used' in raw) {
    const { used: _used, ...rest } = raw;
    return rest as unknown as Rule;
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
  if (raw.url !== undefined) checkUrl(raw.url, where);
  if (raw.status !== undefined) checkStatus(raw.status, where);
  if (raw.headers !== undefined) checkHeaders(raw.headers, where, true);
  if (raw.body !== undefined) checkBody(raw.body, where);
  return raw as RequestEdit | ResponseEdit;
}

/** Headers `send` never forwards: framing the proxy recomputes, hop-by-hop, and the proxy's own credential. */
const SEND_DROPPED = new Set(['content-length', 'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'x-fi-id']);

/** Drops framing / hop-by-hop / proxy headers from a request about to be sent again. */
export function sanitizeSendHeaders(h: Record<string, string | string[]> | undefined): Record<string, string | string[]> | undefined {
  if (!h) return h;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (!SEND_DROPPED.has(k.toLowerCase()) && !k.startsWith(':')) out[k] = v;
  return out;
}

/** Validates the webview composer's request (CONTRACTS §9.3 `send`): method, absolute http(s) URL, headers, text body. */
export function validateSendDraft(raw: unknown): SendDraft {
  const where = 'send';
  if (!isObj(raw)) fail(where, 'request must be an object');
  onlyKeys(raw, ['method', 'url', 'headers', 'body'], where);
  if (typeof raw.method !== 'string' || !TOKEN.test(raw.method)) fail(where, 'method must be an HTTP method name');
  checkUrl(raw.url, where);
  if (raw.headers !== undefined) checkHeaders(raw.headers, where, true);
  if (raw.body !== undefined) checkBody(raw.body, where);
  return {
    method: raw.method.toUpperCase(),
    url: raw.url as string,
    ...(raw.headers !== undefined ? { headers: sanitizeSendHeaders(raw.headers as Record<string, string | string[]>) } : {}),
    ...(raw.body !== undefined ? { body: raw.body as string } : {}),
  };
}

/** Validates a network profile (CONTRACTS §9.2 network.ts). */
export function validateNetworkProfile(raw: unknown): NetworkProfile {
  const where = 'networkProfile';
  if (!isObj(raw)) fail(where, 'must be an object');
  switch (raw.kind) {
    case 'none':
    case 'offline':
      onlyKeys(raw, ['kind'], where);
      return { kind: raw.kind };
    case 'throttle':
      onlyKeys(raw, ['kind', 'preset', 'latencyMs', 'kbps', 'dropRate'], where);
      if (raw.preset !== undefined && (typeof raw.preset !== 'string' || !PRESET_IDS.has(raw.preset))) fail(where, 'preset must be "slow-3g", "fast-3g" or "flaky"');
      checkThrottle(raw, where);
      return raw as unknown as NetworkProfile;
    default:
      return fail(where, `unknown kind ${JSON.stringify(raw.kind)}`);
  }
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

/** The request of `ex` as a code snippet (unredacted: the caller decides what to redact). */
export function snippetFor(ex: Exchange, format: SnippetFormat): string {
  return toSnippet({ method: ex.method, url: ex.url, headers: ex.requestHeaders, ...(ex.requestBody ? { body: ex.requestBody } : {}) }, format);
}

export class InterceptController {
  private readonly sinks = new Set<Sink>();
  private readonly pending = new Map<string, Exchange>();
  /** Latest `rule-hit` count per rule id (display only: never persisted, never sent to the proxy). */
  private readonly used = new Map<string, number>();
  private rulesDirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly paused = new Set<string>();
  private sessions = 0;
  private pausedListeners: ((count: number) => void)[] = [];
  // CONTRACTS §10.5 contract checks: cached per exchange id, queued, run a few at a time.
  private readonly contractResults = new Map<string, ContractResult>();
  private readonly contractQueue = new Map<string, Exchange>();
  private readonly contractRunning = new Set<string>();
  private readonly pendingContract = new Map<string, ContractSummary>();
  private contractTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped whenever cached results become stale; results of older checks are dropped. */
  private contractGen = 0;
  private readonly modelsSub?: { dispose(): void };
  /** Test hook: every message sent, by type. */
  readonly sentCounts: Record<string, number> = {};
  readyCount = 0;

  constructor(private readonly deps: ControllerDeps) {
    deps.host.on('exchange', (e) => this.onExchange(e));
    deps.host.on('removed', (ids) => this.onRemoved(ids));
    // Start/stop/restart: the exchange list belongs to the proxy instance, so resend everything.
    deps.host.on('state', () => {
      this.pending.clear();
      this.rulesDirty = false;
      this.used.clear(); // hit counts belong to the proxy instance
      this.dropContracts(undefined);
      this.recomputePaused(deps.host.getExchanges());
      this.broadcast(this.snapshot());
    });
    deps.host.on('rule-spent', (ruleId) => this.onRuleSpent(ruleId));
    deps.host.on('rule-hit', (ruleId, used) => this.onRuleHit(ruleId, used));
    this.modelsSub = deps.contract?.onDidChangeModels(() => this.recheckContracts());
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
      ...(this.deps.getAgentStatus?.() ? { agent: this.deps.getAgentStatus() } : {}),
      ...(this.networkProfile() ? { networkProfile: this.networkProfile() } : {}),
    };
  }

  /** The active network profile, or undefined when none (CONTRACTS §9.3: omitted from Status). */
  private networkProfile(): NetworkProfile | undefined {
    const p = this.deps.host.networkProfile;
    return p && p.kind !== 'none' ? p : undefined;
  }

  /** Validates, applies and broadcasts `status` (webview `setNetworkProfile`; the agent API may use it too). */
  setNetworkProfile(raw: unknown): void {
    const p = validateNetworkProfile(raw);
    if (!this.deps.host.setNetworkProfile) throw new Error('This proxy build cannot simulate network conditions.');
    this.deps.host.setNetworkProfile(p);
    this.broadcastStatus();
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
    return { type: 'snapshot', exchanges: this.deps.host.getExchanges(), rules: this.rulesView(), status: this.status() };
  }

  async handle(raw: unknown, reply: Sink): Promise<void> {
    const msg = raw as ViewMsg;
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    try {
      switch (msg.type) {
        case 'ready': {
          this.readyCount++;
          this.flush();
          this.send(reply, this.snapshot());
          const current = this.deps.host.getExchanges();
          const results = current.flatMap((e) => {
            const r = this.contractResults.get(e.id);
            return r ? [contractSummary(r)] : [];
          });
          if (results.length) this.send(reply, { type: 'contract', results });
          for (const e of current) this.maybeCheck(e);
          return;
        }
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
        case 'send': {
          const request = validateSendDraft(msg.request);
          if (msg.resentFrom !== undefined) checkId(msg.resentFrom, 'send');
          if (!this.deps.host.send) throw new Error('This proxy build cannot send requests.');
          const { id } = await this.deps.host.send({ ...request, initiator: 'editor', ...(msg.resentFrom ? { resentFrom: msg.resentFrom } : {}) });
          this.send(reply, { type: 'sent', id });
          return;
        }
        case 'openSource': {
          const ex = this.exchangeOrThrow(checkId(msg.id, 'openSource'));
          const frames = ex.source?.frames ?? [];
          if (!frames.length) {
            throw new Error(
              ex.initiator
                ? 'No source for this request: it was sent from the editor or an agent, not by the app.'
                : 'No source for this request: its stack trace has not arrived (source capture may be off, or the app was launched before it was turned on).',
            );
          }
          const frame = msg.frame ?? ex.source?.appFrame;
          if (frame === undefined) throw new Error('No app call site was found in this request\'s stack trace. Pick a frame to open.');
          if (!isInt(frame, 0, frames.length - 1)) fail('openSource', `frame must be an index 0–${frames.length - 1}`);
          if (!this.deps.openSource) throw new Error('Opening source is not available in this editor.');
          await this.deps.openSource(ex, frame);
          return;
        }
        case 'copySnippet': {
          if (!SNIPPET_FORMATS.includes(msg.format)) fail('copySnippet', `unknown format ${JSON.stringify(msg.format)}`);
          const ex = this.exchangeOrThrow(checkId(msg.id, 'copySnippet'));
          if (!this.deps.copyToClipboard) throw new Error('Copying is not available in this editor.');
          // The user's own clipboard: unredacted (CONTRACTS §9.3).
          await this.deps.copyToClipboard(snippetFor(ex, msg.format));
          return;
        }
        case 'setNetworkProfile':
          this.setNetworkProfile(msg.profile);
          return;
        case 'pickModel':
          await this.pickModel(this.exchangeOrThrow(checkId(msg.id, 'pickModel')));
          return;
        case 'openViolation': {
          const id = checkId(msg.id, 'openViolation');
          const r = this.contractResults.get(id);
          if (!r) throw new Error('This request has no contract check result (yet).');
          if (!isInt(msg.index, 0, Math.max(0, r.violations.length - 1)) || !r.violations.length) fail('openViolation', 'index is out of range');
          const v = r.violations[msg.index];
          if (!v.file) throw new Error(`The source file of model ${v.model} is unknown.`);
          if (!this.deps.openLocation) throw new Error('Opening files is not available in this editor.');
          await this.deps.openLocation(v.file, v.line ?? 1);
          return;
        }
        case 'mutateField':
          this.mutateField(this.exchangeOrThrow(checkId(msg.id, 'mutateField')), msg);
          return;
        case 'generateModel':
          await this.generateModel(this.exchangeOrThrow(checkId(msg.id, 'generateModel')));
          return;
        case 'generateFixture':
          await this.generateFixture(this.exchangeOrThrow(checkId(msg.id, 'generateFixture')));
          return;
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
    const left = new Set(this.deps.host.getExchanges().map((e) => e.id));
    this.dropContracts([...this.contractResults.keys(), ...this.contractQueue.keys(), ...this.pendingContract.keys()].filter((id) => !left.has(id)));
    this.recomputePaused(this.deps.host.getExchanges());
    this.broadcast({ type: 'cleared' });
    this.broadcast(this.snapshot());
  }

  /** Validates (throws InvalidMessageError, nothing applied or persisted), then applies + persists + broadcasts. */
  applyRules(input: Rule[]): void {
    const rules = validateRules(input); // drops `used`
    this.deps.host.setRules(rules);
    this.deps.saveRules(rules);
    const ids = new Set(rules.map((r) => r.id));
    for (const id of [...this.used.keys()]) if (!ids.has(id)) this.used.delete(id);
    this.rulesDirty = false;
    this.broadcast({ type: 'rules', rules: this.rulesView() });
  }

  /** The host's rules with the latest `used` counts (CONTRACTS §9.2 rule-hit) for the webview. */
  rulesView(): Rule[] {
    const rules = this.deps.host.getRules();
    if (!this.used.size) return rules;
    return rules.map((r) => (this.used.has(r.id) ? { ...r, used: this.used.get(r.id) } : r));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.contractTimer) clearTimeout(this.contractTimer);
    this.contractTimer = undefined;
    this.contractQueue.clear();
    this.contractGen++;
    this.modelsSub?.dispose();
    this.sinks.clear();
  }

  // ------------------------------------------------------------------ CONTRACTS §10 (v0.4.0)

  /** The cached contract result of an exchange (also used by the agent API). */
  contractResult(id: string): ContractResult | undefined {
    return this.contractResults.get(id);
  }

  private get contractOn(): boolean {
    return !!this.deps.contract && (this.deps.contractCheckEnabled?.() ?? true);
  }

  /**
   * Drops every cached result (models changed, the user mapped a route, or the setting changed) and checks the
   * current exchanges again; with checking off, tells the panel the results are gone.
   */
  recheckContracts(): void {
    const ids = [...this.contractResults.keys()];
    this.contractGen++;
    this.contractQueue.clear();
    this.contractResults.clear();
    this.pendingContract.clear();
    if (ids.length) this.deps.onContractRemoved?.(ids);
    if (!this.contractOn) {
      if (ids.length) this.broadcast({ type: 'contract', results: ids.map((id) => ({ id, checked: false, via: 'none', violations: [], reason: CONTRACT_OFF })) });
      return;
    }
    for (const e of this.deps.host.getExchanges()) this.maybeCheck(e);
  }

  /** Forgets results (all with `undefined`) — eviction, clear, proxy restart. */
  private dropContracts(ids: string[] | undefined): void {
    const dropped: string[] = [];
    if (ids === undefined) {
      this.contractGen++;
      dropped.push(...this.contractResults.keys());
      this.contractResults.clear();
      this.contractQueue.clear();
      this.pendingContract.clear();
    } else {
      for (const id of new Set(ids)) {
        if (this.contractResults.delete(id)) dropped.push(id);
        this.contractQueue.delete(id);
        this.pendingContract.delete(id);
      }
    }
    if (dropped.length) this.deps.onContractRemoved?.(dropped);
  }

  /** Queues a finished JSON exchange for checking (once per id). */
  private maybeCheck(e: Exchange): void {
    if (!this.contractOn || !isCheckable(e)) return;
    if (this.contractResults.has(e.id) || this.contractRunning.has(e.id)) return;
    this.contractQueue.set(e.id, e);
    if (!this.contractTimer) this.contractTimer = setTimeout(() => this.pumpContracts(), this.deps.contractDebounceMs ?? 150);
  }

  private pumpContracts(): void {
    this.contractTimer = undefined;
    const limit = Math.max(1, this.deps.contractConcurrency ?? 2);
    while (this.contractRunning.size < limit && this.contractQueue.size) {
      const [id, e] = this.contractQueue.entries().next().value as [string, Exchange];
      this.contractQueue.delete(id);
      this.contractRunning.add(id);
      void this.runCheck(e, this.contractGen);
    }
  }

  private async runCheck(e: Exchange, gen: number, opts?: { model?: string }): Promise<ContractResult | undefined> {
    let result: ContractResult;
    try {
      result = await this.deps.contract!.check(e, opts);
    } catch (err) {
      result = { exchangeId: e.id, checked: false, via: 'none', violations: [], reason: `the check failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.contractRunning.delete(e.id);
    }
    try {
      if (gen !== this.contractGen || !this.deps.host.getExchanges().some((x) => x.id === e.id)) return undefined;
      this.contractResults.set(e.id, result);
      this.pendingContract.set(e.id, contractSummary(result));
      try {
        this.deps.onContractResult?.(result);
      } catch (err) {
        this.deps.log?.(`onContractResult failed: ${String(err)}`);
      }
      if (!this.timer) this.timer = setTimeout(() => this.flush(), this.deps.throttleMs ?? 50);
      return result;
    } finally {
      // Yield to the event loop between checks (REVIEW-4 #5): a re-check of many exchanges never runs as one microtask chain.
      if (this.contractQueue.size && !this.contractTimer) this.contractTimer = setTimeout(() => this.pumpContracts(), 0);
    }
  }

  private async pickModel(ex: Exchange): Promise<void> {
    if (!this.deps.contract) throw new Error('Contract checking is not available.');
    if (!this.deps.pickModel) throw new Error('Choosing a model is not available in this editor.');
    const choice = await this.deps.pickModel(ex);
    if (choice === null) return;
    await this.deps.contract.remember(ex, choice);
    // The choice applies to the whole route: every cached result may be stale.
    if (this.contractOn) {
      this.recheckContracts();
      return;
    }
    // Checking is off: still answer the user's explicit choice for this exchange.
    const r = await this.runCheck(ex, this.contractGen);
    if (r) this.flush();
  }

  private mutateField(ex: Exchange, msg: { path?: unknown; op?: unknown; value?: unknown; valueJson?: unknown }): void {
    if (typeof msg.op !== 'string' || !['null', 'delete', 'set'].includes(msg.op)) fail('mutateField', 'op must be "null", "delete" or "set"');
    const bad = pathError(msg.path);
    if (bad) fail('mutateField', bad);
    const op = msg.op as 'null' | 'delete' | 'set';
    // The proxy builds the match (and an empty mutate action) like every rule from an exchange; we fill the op.
    const base = ruleFromExchange(ex, 'mutate', this.newRuleId());
    let pathname = ex.url.split(/[?#]/)[0];
    try {
      pathname = new URL(ex.url).pathname;
    } catch {
      // keep the raw path
    }
    const setValue = op === 'set' ? { ...(msg.value !== undefined ? { value: msg.value } : {}), ...(msg.valueJson !== undefined ? { valueJson: msg.valueJson as string } : {}) } : {};
    const rule = validateRule({
      ...base,
      enabled: true,
      name: `${op} ${String(msg.path)} ${ex.method} ${pathname}`.slice(0, 500),
      action: { kind: 'mutate', ops: [{ path: msg.path as string, op, ...setValue }] },
    });
    this.applyRules([rule, ...this.deps.host.getRules()]);
  }

  private codegenOrThrow(): { codegen: CodegenService; open: (files: GeneratedFile[]) => Promise<unknown> } {
    if (!this.deps.codegen || !this.deps.openUntitled) throw new Error('Code generation is not available in this editor.');
    return { codegen: this.deps.codegen, open: this.deps.openUntitled };
  }

  private async generateModel(ex: Exchange): Promise<void> {
    const { codegen, open } = this.codegenOrThrow();
    const json = decodeSample(ex.responseBody);
    if (!json.ok) throw new Error(`Can't generate a model from this response: ${json.reason}.`);
    const template = (p: string) => codegen.routeTemplate(p);
    const route = routeOf(ex, template);
    const samples = modelSamples(this.deps.host.getExchanges(), ex, template).flatMap((s) => {
      const d = decodeSample(s.responseBody);
      return d.ok ? [d.value] : [];
    });
    const root = this.deps.projectRoot?.();
    const files = codegen.generateModels({
      samples: samples.length ? samples : [json.value],
      rootName: defaultModelName(route.template),
      style: root ? codegen.detectModelStyle(root) : 'plain',
      source: `${ex.method.toUpperCase()} ${route.origin}${route.template}`,
    });
    if (!files.length) throw new Error('No model could be generated from this response.');
    await open(files);
  }

  private async generateFixture(ex: Exchange): Promise<void> {
    const { codegen, open } = this.codegenOrThrow();
    if (ex.status === undefined || !FINAL_STATES.has(ex.state)) throw new Error('This request has no finished response to turn into a fixture.');
    const template = (p: string) => codegen.routeTemplate(p);
    const route = routeOf(ex, template);
    // Fixtures are committed to the repo: always the REDACTED view (CONTRACTS §10.1).
    const raw = fixtureSamples(this.deps.host.getExchanges(), ex, template);
    const root = this.deps.projectRoot?.();
    const pkg = this.deps.appPackageName?.();
    const style = root ? codegen.detectFixtureStyle(root) : 'mock_client';
    const api = style === 'mocktail' ? await fixtureApi(this.deps.contract, raw, root, pkg, this.deps.log) : undefined;
    const testPackage = testPackageFor(root);
    const files = codegen.generateFixtureTest({
      exchanges: raw.map(redactExchange),
      style,
      name: defaultFixtureName(ex.method, route.template),
      ...(pkg ? { packageName: pkg } : {}),
      ...(api ? { api } : {}),
      ...(testPackage ? { testPackage } : {}),
    });
    if (!files.length) throw new Error('No fixture could be generated from this request.');
    await open(files);
  }

  private exchangeOrThrow(id: string): Exchange {
    const ex = this.deps.host.getExchanges().find((e) => e.id === id);
    if (!ex) throw new Error('That exchange is no longer available.');
    return ex;
  }

  private onRuleHit(ruleId: string, used: number): void {
    if (typeof ruleId !== 'string' || typeof used !== 'number' || !Number.isFinite(used)) return;
    if (!this.deps.host.getRules().some((r) => r.id === ruleId) || this.used.get(ruleId) === used) return;
    this.used.set(ruleId, used);
    this.rulesDirty = true;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.deps.throttleMs ?? 50);
  }

  /** CONTRACTS §9.4: a spent rule (times used up / expired) is removed, persisted and broadcast. */
  private onRuleSpent(ruleId: string): void {
    const rules = this.deps.host.getRules();
    const next = rules.filter((r) => r.id !== ruleId);
    if (next.length === rules.length) return;
    this.used.delete(ruleId);
    try {
      this.applyRules(next);
      this.deps.log?.(`rule ${ruleId} spent: removed`);
    } catch (e) {
      this.deps.log?.(`removing spent rule ${ruleId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
    this.maybeCheck(e);
  }

  private onRemoved(ids: string[]): void {
    this.flush();
    this.dropContracts(ids);
    let changed = false;
    for (const id of ids) changed = this.paused.delete(id) || changed;
    if (changed) this.firePaused();
    this.broadcast({ type: 'removed', ids });
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.rulesDirty) {
      this.rulesDirty = false;
      this.broadcast({ type: 'rules', rules: this.rulesView() });
    }
    if (this.pending.size) {
      const batch = [...this.pending.values()];
      this.pending.clear();
      for (const exchange of batch) this.broadcast({ type: 'exchange', exchange });
    }
    // After the exchanges, so the panel already knows every id a result refers to.
    if (this.pendingContract.size) {
      const results = [...this.pendingContract.values()];
      this.pendingContract.clear();
      this.broadcast({ type: 'contract', results });
    }
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
