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
 */
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import type { Exchange, InterceptProxyOptions, Rule } from '@flutter-intercept/proxy';

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
}

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
}

/**
 * Events: 'exchange' (Exchange), 'removed' (string[]), 'state' (running: boolean),
 * 'lan' ({host, port} | undefined — never the token).
 * Rules are kept here so they survive restarts and apply from the first request.
 */
export class InterceptProxyHost extends EventEmitter implements ProxyHost {
  private proxy?: ProxyLike;
  private starting?: Promise<number>;
  private rules: Rule[] = [];
  /** The configured port the running proxy was started for. */
  private configuredAtStart?: number;
  private lanState?: LanOpening;
  /** Token of the most recent opening, kept after closeLan so live sessions' apps stay valid. */
  private lastLanToken?: string;
  private lastLanPeer?: string;
  /** The token was dropped on purpose (network change): issuing a new one is expected, not a surprise. */
  private lanTokenForgotten = false;
  private lanBusy: Promise<unknown> = Promise.resolve();

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
      const proxy = this.opts.factory({ port, host: this.opts.host ?? '127.0.0.1', ...(ca ? { ca } : {}) });
      try {
        await proxy.start();
      } catch (e) {
        lastError = e;
        if (isAddrInUse(e)) continue;
        throw e;
      }
      proxy.setRules(this.rules);
      proxy.on('exchange', (e) => this.emit('exchange', e));
      proxy.on('removed', (ids) => this.emit('removed', ids));
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

  setRules(rules: Rule[]): void {
    this.rules = rules;
    this.proxy?.setRules(rules);
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

  abort(id: string): void {
    this.proxy?.abort(id);
  }
}
