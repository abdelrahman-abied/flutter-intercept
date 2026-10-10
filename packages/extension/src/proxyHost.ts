/**
 * CONTRACTS §6: the extension-side wrapper around `InterceptProxy` (packages/proxy).
 *
 * - Lazy: started by the debug provider on the first intercepted launch (the provider awaits
 *   `start()` because the port must be known before the entry is generated).
 * - Port: the configured port, else the next free one (up to 100 further, i.e. 8899–8999 for the
 *   default). Binds 127.0.0.1.
 * - `stop()` also removes every adb reverse we created.
 * - CA: the per-install CA from `getCa` (src/ca.ts) signs the proxy's leaf certificates; generated
 *   entries trust exactly that CA, so it must be the same object for every start.
 * - CONTRACTS §9.2/9.4: forwards `send`, the network profile and the app package names (all re-applied
 *   when the proxy restarts) and re-emits `rule-spent`. Every new proxy member is optional, so an older
 *   proxy build degrades to a clear "not supported" error instead of crashing.
 * - CONTRACTS §11.4: forwards `record` / `update` (read-only exchanges from the app's HTTP profile) and keeps the
 *   per-session `SessionWarning`s (`setWarnings`, `warnings`, event 'warnings'); `vmHostDeps()` hands both to
 *   the VM watcher (src/vm/**).
 * - CONTRACTS §12: forwards `setReplay` (state kept for `Status.replay`), `resetSequences` and the upstream proxy
 *   (all re-applied after a restart); resolves `mock.bodyFile` (also inside sequence steps) through an injected
 *   resolver before rules reach the proxy — a rule whose file can't be read is skipped and reported as a warning.
 * - CONTRACTS §13.4: resolves `script.file` into `code` the same way (injected `setScriptFileResolver`, i.e.
 *   SharedRulesService.resolveScriptFile); `refreshBodyFiles(path)` re-reads script files too. A script rule whose
 *   file can't be read (or, for a shared rule, isn't approved with these contents) never reaches the proxy (fail
 *   closed). Both resolvers get the rule id: a shared rule's files resolve in its own workspace folder.
 *   Timings (§13.2) need nothing here.
 */
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import type { Exchange, InterceptProxyOptions, ReplayEntry, ReplayOptions, Rule, RuleAction, SendRequest } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
import type { SessionWarning } from './ui/protocol';
import type { VmHostDeps } from './vm/types';

export interface ProxyHost {
  /** Starts the proxy if needed (idempotent) and resolves with the port actually listened on. */
  start(): Promise<number>;
  /** Stops the proxy and removes every adb reverse we created. */
  stop(): Promise<void>;
  readonly running: boolean;
}

/** The subset of InterceptProxy the host uses (lets tests inject a fake). */
export interface ProxyLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
  setRules(rules: Rule[]): void;
  getExchanges(): Exchange[];
  clear(): void;
  resume(id: string, edit?: unknown): void;
  abort(id: string): void;
  on(event: 'exchange', l: (e: Exchange) => void): unknown;
  on(event: 'removed', l: (ids: string[]) => void): unknown;
  // CONTRACTS §7 (LAN mode). Optional so an older proxy build degrades to "LAN unsupported".
  openLan?(opts: { host: string; token: string; port?: number }): Promise<{ host: string; port: number }>;
  closeLan?(): Promise<void>;
  readonly lan?: { host: string; port: number };
  /** Review 2 #2: the peer IP the LAN listener is pinned to (first authenticated device), if any. */
  readonly lanPeer?: string;
  // CONTRACTS §9.2. Optional: older proxy builds lack them.
  send?(req: SendRequest): Promise<{ id: string }>;
  setNetworkProfile?(p: NetworkProfile): void;
  setAppPackages?(names: string[]): void;
  on(event: 'rule-spent', l: (ruleId: string, reason: 'times' | 'expired') => void): unknown;
  on(event: 'rule-hit', l: (ruleId: string, used: number) => void): unknown;
  // CONTRACTS §11.4. Optional: older proxy builds can't hold read-only (VM profile) exchanges.
  record?(ex: Omit<Exchange, 'id'>): string;
  update?(id: string, patch: Partial<Exchange>): void;
  // CONTRACTS §11.3: while a web session runs, the browser's own traffic is marked `browserInternal`.
  setWebSessionActive?(active: boolean): void;
  // CONTRACTS §12. Optional: older proxy builds lack them. `name` (the recording's) is for `simulated` labels.
  setReplay?(entries: ReplayEntry[] | undefined, opts: ReplayOptions & { name?: string }): void;
  resetSequences?(): void;
  setUpstreamProxy?(cfg: UpstreamProxy | undefined): void;
  /** The upstream proxy in use (`http://host:port`, never credentials). */
  readonly upstreamProxy?: { url: string; ignoreCertErrors: boolean };
}

/** REVIEW-6 #1: `host:port` of an upstream proxy URL — never user info, path or query. */
export function upstreamDisplay(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return undefined;
  }
}

/** CONTRACTS §12.6: `InterceptProxyOptions.upstreamProxy`. */
export type UpstreamProxy = NonNullable<InterceptProxyOptions['upstreamProxy']>;

/** CONTRACTS §12.4: what is being replayed (`Status.replay` + the recording id). */
export interface ReplayState {
  id?: string;
  recording: string;
  fallback: ReplayOptions['fallback'];
  entries: number;
}

/** Validates the upstream proxy setting: `http://host:port` (no path, query or credentials in the log). */
export function checkUpstreamProxy(cfg: unknown): UpstreamProxy | undefined {
  if (cfg === undefined || cfg === null) return undefined;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('upstreamProxy must be an object {url, ignoreCertErrors?}');
  const { url, ignoreCertErrors } = cfg as Record<string, unknown>;
  if (typeof url !== 'string' || !url.trim()) throw new Error('upstreamProxy.url must be a URL such as http://127.0.0.1:8888');
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error('upstreamProxy.url must be a URL such as http://127.0.0.1:8888');
  }
  if (u.protocol !== 'http:') throw new Error('upstreamProxy.url must be an http:// proxy URL (HTTPS goes through it with CONNECT)');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new Error('upstreamProxy.url must be just http://host:port');
  if (ignoreCertErrors !== undefined && typeof ignoreCertErrors !== 'boolean') throw new Error('upstreamProxy.ignoreCertErrors must be a boolean');
  return { url: url.trim(), ...(ignoreCertErrors === true ? { ignoreCertErrors: true } : {}) };
}

/** Does this rule (or one of its sequence steps) take its mock body from a file? */
export function bodyFilesOf(rule: Rule): string[] {
  const out: string[] = [];
  const visit = (a: RuleAction | { kind: 'passthrough' }) => {
    if (a.kind === 'mock' && typeof a.bodyFile === 'string' && a.bodyFile) out.push(a.bodyFile);
    if (a.kind === 'sequence') for (const s of a.steps ?? []) visit(s.action as RuleAction);
  };
  if (rule.action) visit(rule.action);
  return out;
}

/** Reads a workspace-relative file for one rule (`ruleId`: a shared rule's file resolves in its own folder). */
export type FileResolver = (path: string, ruleId: string) => Promise<string>;

/** CONTRACTS §13.4: the script file of a `script` rule, if it has one. */
export function scriptFilesOf(rule: Rule): string[] {
  const a = rule.action as RuleAction | undefined;
  return a?.kind === 'script' && typeof a.file === 'string' && a.file ? [a.file] : [];
}

/** Every workspace file a rule reads (mock body files and script files). */
export function filesOf(rule: Rule): string[] {
  return [...bodyFilesOf(rule), ...scriptFilesOf(rule)];
}

/** CONTRACTS §11.4: bounds for what the VM layer may put into Status.warnings. */
export const MAX_WARNINGS_PER_SESSION = 50;
const MAX_WARNING_TEXT = 500;
const WARNING_KINDS = new Set<SessionWarning['kind']>(['background-isolate', 'native-client', 'web', 'other']);

const NO_PROFILE: NetworkProfile = { kind: 'none' };

/** An open LAN listener. `token` is a secret: never log it or show it. */
export interface LanOpening {
  host: string;
  port: number;
  token: string;
}

/** 32 random bytes, base64url (CONTRACTS §7). */
export function newLanToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export type ProxyFactory = (opts: InterceptProxyOptions) => ProxyLike;

export const PORT_FALLBACK_SPAN = 100;

function isAddrInUse(e: unknown): boolean {
  const any = e as { code?: string; message?: string };
  return any?.code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(String(any?.message ?? e));
}

export interface InterceptProxyHostOptions {
  getPort: () => number;
  factory: ProxyFactory;
  /** This install's CA (PEM key + cert). Without it the proxy would use an in-memory CA the entries do not trust. */
  getCa?: () => Promise<{ key: string; cert: string }>;
  /** Called by stop(): remove our adb reverses. */
  onStop?: () => Promise<unknown>;
  log?: (msg: string) => void;
  host?: string;
  /**
   * When the configured port changed since the proxy started, `start()` restarts it on the new
   * port if this returns true (the extension passes "no intercepted session is running").
   */
  canRestart?: () => boolean;
  /**
   * LAN mode: true while no physical-iOS session launched with the current token is alive. Only
   * then may the listener move to another address or the token rotate: a running app keeps the
   * token it was built with (hot restart doesn't change dart-defines), and with a stale token
   * dart:io plain-http requests get the 407 as their response instead of falling back DIRECT.
   */
  canReopenLan?: () => boolean;
  /** A new token had to be issued while an iPhone session is alive: the user must relaunch it. */
  onLanTokenRotatedWhileLive?: () => void;
  /** CONTRACTS §9.2 `rewriteLocalhost` (setting `flutterIntercept.rewriteLocalhost`), read at each proxy start. */
  rewriteLocalhost?: () => boolean;
}

/**
 * Events: 'exchange' (Exchange), 'removed' (string[]), 'state' (running: boolean),
 * 'lan' ({host, port} | undefined — never the token), 'rule-spent' (ruleId, reason), 'rule-hit' (ruleId, used),
 * 'warnings' (SessionWarning[], the full current list — after every change), 'replay' (ReplayState | undefined),
 * 'upstream' ({display, ignoreCertErrors} | undefined).
 * Rules, the network profile and the app package names are kept here so they survive restarts and
 * apply from the first request.
 */
export class InterceptProxyHost extends EventEmitter implements ProxyHost {
  private proxy?: ProxyLike;
  private starting?: Promise<number>;
  private rules: Rule[] = [];
  private profile: NetworkProfile = NO_PROFILE;
  private appPackages: string[] = [];
  /** The configured port the running proxy was started for. */
  private configuredAtStart?: number;
  private lanState?: LanOpening;
  /** Token of the most recent opening, kept after closeLan so live sessions' apps stay valid. */
  private lastLanToken?: string;
  private lastLanPeer?: string;
  /** The token was dropped on purpose (network change): issuing a new one is expected, not a surprise. */
  private lanTokenForgotten = false;
  private lanBusy: Promise<unknown> = Promise.resolve();
  /** CONTRACTS §11.4: warnings per debug session id (insertion order kept). */
  private readonly sessionWarnings = new Map<string, SessionWarning[]>();
  private recordUnsupportedLogged = false;
  private webSessionActive = false;
  // CONTRACTS §12
  /** What the proxy actually got: `rules` with file-backed bodies resolved (rules whose file failed are left out). */
  private proxyRules: Rule[] = [];
  private rulesGen = 0;
  private rulesApplied: Promise<void> = Promise.resolve();
  private bodyResolver?: FileResolver;
  private scriptResolver?: FileResolver;
  private bodyWarnings: SessionWarning[] = [];
  private replayState?: ReplayState & { list: ReplayEntry[]; opts: ReplayOptions };
  private upstream?: UpstreamProxy;

  constructor(private readonly opts: InterceptProxyHostOptions) {
    super();
  }

  get running(): boolean {
    return !!this.proxy;
  }

  get port(): number | undefined {
    return this.proxy?.port;
  }

  start(): Promise<number> {
    if (this.proxy && this.configuredAtStart !== this.opts.getPort() && (this.opts.canRestart?.() ?? false) && !this.starting) {
      this.opts.log?.(`flutterIntercept.port changed ${this.configuredAtStart} -> ${this.opts.getPort()}: restarting the proxy`);
      this.starting = this.stopNow()
        .then(() => this.doStart())
        .finally(() => {
          this.starting = undefined;
        });
      return this.starting;
    }
    if (this.proxy) return Promise.resolve(this.proxy.port);
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async doStart(): Promise<number> {
    const first = this.opts.getPort();
    this.configuredAtStart = first;
    const last = Math.min(first + PORT_FALLBACK_SPAN, 65535);
    let lastError: unknown;
    const ca = this.opts.getCa ? await this.opts.getCa() : undefined;
    for (let port = first; port <= last; port++) {
      const rewrite = this.opts.rewriteLocalhost?.();
      const proxy = this.opts.factory({
        port,
        host: this.opts.host ?? '127.0.0.1',
        ...(ca ? { ca } : {}),
        ...(rewrite !== undefined ? { rewriteLocalhost: rewrite } : {}),
        ...(this.upstream ? { upstreamProxy: this.upstream } : {}),
      });
      try {
        await proxy.start();
      } catch (e) {
        lastError = e;
        if (isAddrInUse(e)) continue;
        throw e;
      }
      proxy.setRules(this.proxyRules);
      if (this.upstream) proxy.setUpstreamProxy?.(this.upstream);
      this.applyReplay(proxy);
      if (this.profile.kind !== 'none') this.applyProfile(proxy); // a new proxy starts with none
      if (this.appPackages.length) proxy.setAppPackages?.(this.appPackages);
      if (this.webSessionActive) proxy.setWebSessionActive?.(true);
      proxy.on('exchange', (e) => this.emit('exchange', e));
      proxy.on('removed', (ids) => this.emit('removed', ids));
      proxy.on('rule-spent', (ruleId, reason) => this.emit('rule-spent', ruleId, reason));
      proxy.on('rule-hit', (ruleId, used) => this.emit('rule-hit', ruleId, used));
      this.proxy = proxy;
      this.opts.log?.(`proxy listening on ${this.opts.host ?? '127.0.0.1'}:${proxy.port}${port !== first ? ` (port ${first} busy)` : ''}`);
      this.emit('state', true);
      return proxy.port;
    }
    throw new Error(`no free proxy port in ${first}-${last}: ${String(lastError)}`);
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    await this.stopNow();
  }

  private async stopNow(): Promise<void> {
    const proxy = this.proxy;
    if (this.lanState) {
      this.lanState = undefined;
      await proxy?.closeLan?.().catch(() => undefined);
      this.emit('lan', undefined);
    }
    this.proxy = undefined;
    try {
      if (proxy) {
        await proxy.stop();
        this.opts.log?.('proxy stopped');
        this.emit('state', false);
      }
    } finally {
      await this.opts.onStop?.().catch(() => undefined);
    }
  }

  /** Host/port of the open LAN listener and the pinned peer, if any (never the token). */
  get lan(): { host: string; port: number; peer?: string } | undefined {
    if (!this.lanState) return undefined;
    const peer = this.proxy?.lanPeer;
    return { host: this.lanState.host, port: this.lanState.port, ...(peer ? { peer } : {}) };
  }

  /** Emits 'lan' (and logs) when the proxy pinned the LAN listener to a device. Cheap; call periodically. */
  refreshLanPeer(): void {
    const peer = this.lanState ? this.proxy?.lanPeer : undefined;
    if (peer === this.lastLanPeer) return;
    this.lastLanPeer = peer;
    if (peer) this.opts.log?.(`LAN locked to ${peer}`);
    this.emit('lan', this.lan);
  }

  /**
   * Opens (or reuses) the LAN listener on `host` with a fresh token per opening (CONTRACTS §7).
   * Starts the proxy if needed. Serialised: concurrent launches share one opening.
   */
  openLan(host: string): Promise<LanOpening> {
    const run = this.lanBusy.then(async () => {
      await this.start();
      const proxy = this.proxy;
      if (!proxy) throw new Error('proxy is not running');
      if (!proxy.openLan) throw new Error('this proxy build does not support LAN mode');
      if (this.lanState) {
        if (this.lanState.host === host) return this.lanState;
        if (!(this.opts.canReopenLan?.() ?? false)) {
          this.opts.log?.(`LAN address changed to ${host}, but a physical-iOS session still uses ${this.lanState.host}: keeping it`);
          return this.lanState;
        }
        await this.closeLanNow();
      }
      // Keep the token stable while any session launched with it may be alive; rotate only when none is.
      const sessionsLive = !(this.opts.canReopenLan?.() ?? true);
      const token = sessionsLive && this.lastLanToken ? this.lastLanToken : newLanToken();
      if (sessionsLive && this.lastLanToken !== undefined && token !== this.lastLanToken && !this.lanTokenForgotten) this.opts.onLanTokenRotatedWhileLive?.();
      this.lastLanToken = token;
      this.lanTokenForgotten = false;
      const bound = await proxy.openLan({ host, token });
      this.lanState = { host: bound.host, port: bound.port, token };
      this.opts.log?.(`LAN listener open on ${bound.host}:${bound.port} (token-protected)`);
      this.emit('lan', this.lan);
      return this.lanState;
    });
    this.lanBusy = run.catch(() => undefined);
    return run;
  }

  /**
   * Closes the LAN listener. `forgetToken` (network changed): the next opening gets a new token
   * even if an iPhone session is still alive — the old one may have been exposed on the old network,
   * and the proxy pins a token to the first peer, which will differ there.
   */
  closeLan(opts: { forgetToken?: boolean } = {}): Promise<void> {
    if (opts.forgetToken) {
      this.lastLanToken = undefined;
      this.lanTokenForgotten = true;
    }
    const run = this.lanBusy.then(() => this.closeLanNow());
    this.lanBusy = run.catch(() => undefined);
    return run;
  }

  private async closeLanNow(): Promise<void> {
    if (!this.lanState) return;
    this.lanState = undefined;
    this.lastLanPeer = undefined;
    try {
      await this.proxy?.closeLan?.();
      this.opts.log?.('LAN listener closed');
    } finally {
      this.emit('lan', undefined);
    }
  }

  /**
   * The rules as authored (what `getRules` returns, persisted and shown). The proxy gets them with every
   * `mock.bodyFile` resolved into `body` (CONTRACTS §12.2): synchronously when no rule uses a file, otherwise once
   * the files are read (`rulesReady()`); a rule whose file can't be read is left out and reported in `warnings`.
   */
  setRules(rules: Rule[]): void {
    this.rules = rules;
    this.applyRules();
  }

  /** Resolves when the latest `setRules` / body-file refresh reached the proxy. */
  rulesReady(): Promise<void> {
    return this.rulesApplied;
  }

  /** CONTRACTS §12.2: reads a workspace-relative body file (SharedRulesService.resolveBodyFile(path, ruleId)). */
  setBodyFileResolver(resolve: FileResolver | undefined): void {
    this.bodyResolver = resolve;
    if (this.rules.some((r) => bodyFilesOf(r).length)) this.applyRules();
  }

  /** CONTRACTS §13.4: reads a workspace-relative script file (SharedRulesService.resolveScriptFile(path, ruleId)). */
  setScriptFileResolver(resolve: FileResolver | undefined): void {
    this.scriptResolver = resolve;
    if (this.rules.some((r) => scriptFilesOf(r).length)) this.applyRules();
  }

  /** A body or script file changed (or every one, without `path`): re-reads the rules that use it. */
  refreshBodyFiles(path?: string): void {
    if (this.rules.some((r) => (path === undefined ? filesOf(r).length > 0 : filesOf(r).includes(path)))) this.applyRules();
  }

  private applyRules(): void {
    const gen = ++this.rulesGen;
    const rules = this.rules;
    if (!rules.some((r) => filesOf(r).length)) {
      this.proxyRules = rules;
      this.proxy?.setRules(rules);
      this.setBodyWarnings([]);
      this.rulesApplied = Promise.resolve();
      return;
    }
    this.rulesApplied = this.resolveBodies(rules).then(
      ({ resolved, problems }) => {
        if (gen !== this.rulesGen) return;
        this.proxyRules = resolved;
        this.proxy?.setRules(resolved);
        this.setBodyWarnings(problems);
      },
      (e: unknown) => this.opts.log?.(`applying rules failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  private async resolveBodies(rules: Rule[]): Promise<{ resolved: Rule[]; problems: SessionWarning[] }> {
    // Cached per rule + path: the same path may resolve differently per rule (a shared rule's own folder, approval).
    const cache = new Map<string, Promise<string>>();
    const read = (p: string, ruleId: string): Promise<string> => {
      if (!this.bodyResolver) return Promise.reject(new Error('file-backed mock bodies are not available'));
      const key = `${ruleId}\0${p}`;
      let r = cache.get(key);
      if (!r) cache.set(key, (r = this.bodyResolver(p, ruleId)));
      return r;
    };
    const readScript = (p: string, ruleId: string): Promise<string> =>
      this.scriptResolver ? this.scriptResolver(p, ruleId) : Promise.reject(new Error('script files are not available'));
    const resolveAction = async (a: RuleAction, ruleId: string): Promise<RuleAction> => {
      if (a.kind === 'script' && a.file) {
        const code = await readScript(a.file, ruleId);
        if (typeof code !== 'string') throw new Error(`script file ${a.file} is not text`);
        return { ...a, code };
      }
      if (a.kind === 'mock' && a.bodyFile) {
        const { bodyFile, ...rest } = a;
        const text = await read(bodyFile, ruleId);
        if (typeof text !== 'string') throw new Error(`body file ${bodyFile} is not text`);
        return { ...rest, body: text };
      }
      if (a.kind === 'sequence') {
        const steps = await Promise.all(a.steps.map(async (s) => (s.action.kind === 'mock' && s.action.bodyFile ? { ...s, action: (await resolveAction(s.action, ruleId)) as typeof s.action } : s)));
        return { ...a, steps };
      }
      return a;
    };
    const resolved: Rule[] = [];
    const problems: SessionWarning[] = [];
    for (const rule of rules) {
      if (!filesOf(rule).length) {
        resolved.push(rule);
        continue;
      }
      try {
        resolved.push({ ...rule, action: await resolveAction(rule.action, rule.id) });
      } catch (e) {
        const label = rule.name?.trim() || rule.id;
        const why = e instanceof Error ? e.message : String(e);
        const script = scriptFilesOf(rule).length > 0;
        problems.push({
          id: `${script ? 'scriptFile' : 'bodyFile'}:${rule.id}`,
          kind: 'other',
          text: `Rule "${label}" is skipped: its ${script ? 'script' : 'mock body'} file can't be used (${why}).`.replace(/[\r\n]+/g, ' ').slice(0, MAX_WARNING_TEXT),
        });
        this.opts.log?.(`rule ${rule.id} skipped: ${script ? 'script' : 'body'} file: ${why}`);
      }
    }
    return { resolved, problems };
  }

  private setBodyWarnings(list: SessionWarning[]): void {
    if (JSON.stringify(list) === JSON.stringify(this.bodyWarnings)) return;
    const before = JSON.stringify(this.warnings);
    this.bodyWarnings = list.slice(0, MAX_WARNINGS_PER_SESSION);
    const after = this.warnings;
    if (JSON.stringify(after) !== before) this.emit('warnings', after);
  }

  // ------------------------------------------------------------------ CONTRACTS §12.4 replay, §12.3, §12.6

  /** What is being replayed, if anything (never the entries). */
  get replay(): ReplayState | undefined {
    const r = this.replayState;
    return r ? { ...(r.id !== undefined ? { id: r.id } : {}), recording: r.recording, fallback: r.fallback, entries: r.entries } : undefined;
  }

  /**
   * Starts (entries) or stops (undefined) answering requests from a recording; kept and re-applied when the proxy
   * restarts. Throws when the running proxy build can't replay. Emits 'replay' with the new state.
   */
  setReplay(entries: ReplayEntry[] | undefined, opts: ReplayOptions = { fallback: 'passthrough' }, meta: { id?: string; name: string } = { name: 'recording' }): void {
    if (!entries) {
      const had = !!this.replayState;
      this.replayState = undefined;
      this.proxy?.setReplay?.(undefined, { fallback: 'passthrough' });
      if (had) this.emit('replay', undefined);
      return;
    }
    if (this.proxy && !this.proxy.setReplay) throw new Error('This proxy build cannot replay recordings.');
    const fallback = opts.fallback === 'fail' ? 'fail' : 'passthrough';
    this.replayState = {
      ...(meta.id !== undefined ? { id: meta.id } : {}),
      recording: meta.name,
      fallback,
      entries: entries.length,
      list: entries,
      opts: { fallback, ...(opts.matchTemplates !== undefined ? { matchTemplates: opts.matchTemplates } : {}) },
    };
    if (this.proxy) this.applyReplay(this.proxy);
    this.emit('replay', this.replay);
  }

  private applyReplay(proxy: ProxyLike): void {
    const r = this.replayState;
    if (!r) return;
    if (!proxy.setReplay) {
      this.opts.log?.('this proxy build cannot replay recordings: replay stopped');
      this.replayState = undefined;
      this.emit('replay', undefined);
      return;
    }
    proxy.setReplay(r.list, { ...r.opts, name: r.recording });
  }

  /** CONTRACTS §12.3: restart every sequence rule at its first step (no-op on older proxy builds). */
  resetSequences(): void {
    this.proxy?.resetSequences?.();
  }

  /** CONTRACTS §12.6: chain pass-through traffic to another proxy (undefined = direct). Kept across restarts. */
  setUpstreamProxy(cfg: UpstreamProxy | undefined): void {
    const next = checkUpstreamProxy(cfg);
    if (JSON.stringify(next) === JSON.stringify(this.upstream)) return;
    this.upstream = next;
    const proxy = this.proxy;
    if (proxy) {
      if (proxy.setUpstreamProxy) proxy.setUpstreamProxy(next);
      else this.opts.log?.('this proxy build cannot change the upstream proxy while running: it applies when the proxy restarts');
    }
    this.emit('upstream', this.upstreamProxyInfo);
  }

  get upstreamProxy(): UpstreamProxy | undefined {
    return this.upstream;
  }

  /**
   * REVIEW-6 #1: what Status / get_status show — `host:port` of the upstream proxy in use (what the running proxy
   * reports, else the stored setting), never credentials; `ignoreCertErrors` = upstream TLS checks are off.
   */
  get upstreamProxyInfo(): { display: string; ignoreCertErrors: boolean } | undefined {
    const live = this.proxy?.upstreamProxy;
    const src = live ?? (this.upstream ? { url: this.upstream.url, ignoreCertErrors: this.upstream.ignoreCertErrors === true } : undefined);
    const display = upstreamDisplay(src?.url);
    return src && display ? { display, ignoreCertErrors: src.ignoreCertErrors === true } : undefined;
  }

  /** `Status.upstreamProxy`: `host:port`, or undefined when traffic goes direct. */
  get upstreamProxyDisplay(): string | undefined {
    return this.upstreamProxyInfo?.display;
  }

  getRules(): Rule[] {
    return this.rules;
  }

  getExchanges(): Exchange[] {
    return this.proxy?.getExchanges() ?? [];
  }

  clear(): void {
    this.proxy?.clear();
  }

  resume(id: string, edit?: unknown): void {
    this.proxy?.resume(id, edit);
  }

  /**
   * CONTRACTS §9.2 `send`: starts the proxy if needed (the request goes through its loopback listener like
   * app traffic) and resolves with the new exchange id once it is recorded.
   */
  async send(req: SendRequest): Promise<{ id: string }> {
    await this.start();
    const proxy = this.proxy;
    if (!proxy) throw new Error('The proxy is not running.');
    if (!proxy.send) throw new Error('This proxy build cannot send requests.');
    return proxy.send(req);
  }

  /** The global network profile (session state, not persisted); re-applied after a proxy restart. */
  get networkProfile(): NetworkProfile {
    return this.profile;
  }

  setNetworkProfile(p: NetworkProfile): void {
    if (p.kind !== 'none' && this.proxy && !this.proxy.setNetworkProfile) throw new Error('This proxy build cannot simulate network conditions.');
    this.profile = p;
    if (this.proxy) this.applyProfile(this.proxy);
  }

  private applyProfile(proxy: ProxyLike): void {
    if (proxy.setNetworkProfile) proxy.setNetworkProfile(this.profile);
    else if (this.profile.kind !== 'none') this.opts.log?.('this proxy build cannot simulate network conditions: profile ignored');
  }

  /** App package names (pubspec `name`s) → the proxy prefers their frames as `appFrame`. */
  setAppPackages(names: string[]): void {
    this.appPackages = [...new Set(names.filter((n) => typeof n === 'string' && n.length > 0))];
    this.proxy?.setAppPackages?.(this.appPackages);
  }

  abort(id: string): void {
    this.proxy?.abort(id);
  }

  /**
   * CONTRACTS §11.3: whether a Flutter Web session is running (the proxy then marks the browser's own requests
   * `browserInternal`). Kept here and re-applied when the proxy (re)starts; a no-op on older proxy builds.
   */
  setWebSessionActive(active: boolean): void {
    this.webSessionActive = active === true;
    this.proxy?.setWebSessionActive?.(this.webSessionActive);
  }

  get webSession(): boolean {
    return this.webSessionActive;
  }

  // ------------------------------------------------------------------ CONTRACTS §11.4 (VM service)

  /**
   * Adds read-only exchanges (`captured: 'vm-profile'`) to the running proxy's list; returns their ids in order.
   * Nothing is recorded (empty result) while the proxy is stopped or when this proxy build can't record.
   */
  record(exchanges: Omit<Exchange, 'id'>[]): string[] {
    const proxy = this.proxy;
    if (!proxy || !exchanges.length) return [];
    if (!proxy.record) {
      if (!this.recordUnsupportedLogged) this.opts.log?.('this proxy build cannot record exchanges from the HTTP profile: native-client requests are not listed');
      this.recordUnsupportedLogged = true;
      return [];
    }
    const ids: string[] = [];
    for (const ex of exchanges) {
      try {
        // Always read-only: rules never apply to these (CONTRACTS §11.4).
        ids.push(proxy.record({ ...ex, captured: 'vm-profile' }));
      } catch (e) {
        this.opts.log?.(`recording a profile exchange failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return ids;
  }

  /** Updates a previously recorded exchange (no-op when it is gone or the proxy can't). `id` is never changed. */
  update(id: string, patch: Partial<Exchange>): void {
    const proxy = this.proxy;
    if (!proxy?.update) return;
    const { id: _id, ...rest } = patch;
    try {
      proxy.update(id, rest);
    } catch (e) {
      this.opts.log?.(`updating exchange ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Replaces the warnings of one debug session (an empty list clears them; call it when the session ends).
   * Malformed entries are dropped, texts are capped, at most MAX_WARNINGS_PER_SESSION per session.
   * Emits 'warnings' only when the visible list changed.
   */
  setWarnings(sessionId: string, warnings: SessionWarning[]): void {
    if (typeof sessionId !== 'string' || !sessionId) return;
    const clean: SessionWarning[] = [];
    const ids = new Set<string>();
    for (const w of Array.isArray(warnings) ? warnings : []) {
      if (!w || typeof w.id !== 'string' || !w.id || typeof w.text !== 'string' || !w.text.trim()) continue;
      if (ids.has(w.id)) continue;
      ids.add(w.id);
      clean.push({
        id: w.id.slice(0, 300),
        kind: WARNING_KINDS.has(w.kind) ? w.kind : 'other',
        text: w.text.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_WARNING_TEXT),
        sessionId,
      });
      if (clean.length >= MAX_WARNINGS_PER_SESSION) break;
    }
    const before = JSON.stringify(this.warnings);
    if (clean.length) this.sessionWarnings.set(sessionId, clean);
    else this.sessionWarnings.delete(sessionId);
    const after = this.warnings;
    if (JSON.stringify(after) !== before) this.emit('warnings', after);
  }

  /** Every session's warnings and the rules' body-file problems, deduplicated by id (first wins). */
  get warnings(): SessionWarning[] {
    const seen = new Set<string>();
    const out: SessionWarning[] = [];
    for (const list of [...this.sessionWarnings.values(), this.bodyWarnings]) {
      for (const w of list) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        out.push(w);
      }
    }
    return out;
  }

  /** The `VmHostDeps` the VM watcher needs (src/vm/types.ts), bound to this host. */
  vmHostDeps(log: (msg: string) => void = (m) => this.opts.log?.(m)): VmHostDeps {
    return {
      record: (exchanges) => this.record(exchanges),
      update: (id, patch) => this.update(id, patch),
      setWarnings: (sessionId, warnings) => this.setWarnings(sessionId, warnings),
      log,
    };
  }
}
