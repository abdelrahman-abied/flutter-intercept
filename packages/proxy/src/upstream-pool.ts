import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import { createUpstreamAgents, retireAgents, type UpstreamAgents, type UpstreamProxySpec } from './upstream-proxy';
import { requestView, type RequestPlan } from './upstream-request';
import { keepAliveOptions } from './idle';

/*
 * Upstream connection pooling across client connections.
 *
 * Measured (docs/spikes/proxy.md): dart:io HttpClient never reuses a CONNECT tunnel — every HTTPS
 * request through a proxy opens a new TCP connection + CONNECT + TLS handshake to the proxy.
 * mockttp 4 pools upstream connections *per downstream connection* (http-agents.ts getAgent), so
 * every Dart HTTPS request also paid a fresh TLS handshake to the real server (1–2 extra RTTs on a
 * real network). We wrap mockttp's (CommonJS, writable) `getAgent` export and, for requests from
 * our own passthrough rules only, hand out one shared keep-alive agent pair per InterceptProxy.
 *
 * Our rules are recognised by their `proxyConfig`: each InterceptProxy passes a unique callback
 * (that always answers "no upstream proxy"), and getAgent receives it as `proxySettingSource`.
 * If the hook can't be installed the callback is harmless and mockttp's default pooling applies.
 *
 * rewriteLocalhost (CONTRACTS §9.2): the emulator aliases for the host machine (10.0.2.2 Android
 * emulator, 10.0.3.2 Genymotion) mean "this Mac" to the app; the proxy runs on that Mac, so our agents
 * connect those targets to 127.0.0.1 on the same port. Done at connect time only: the URL, the Host
 * header and the exchange keep what the app sent, and TLS still verifies the certificate against the
 * name the app asked for. Only our pooled (loopback-client) agents do this — LAN clients get their gate's
 * guarded agents first, so the §7 SSRF guard is unchanged.
 */

/** Emulator aliases for the host machine → the address our agents actually connect to. */
export const HOST_ALIASES: Readonly<Record<string, string>> = { '10.0.2.2': '127.0.0.1', '10.0.3.2': '127.0.0.1' };

function rewritten(options: any): any {
  const host = String(options?.host ?? options?.hostname ?? '');
  const to = HOST_ALIASES[host];
  if (!to) return options;
  const out = { ...options, host: to };
  if (options.hostname !== undefined) out.hostname = to;
  // Verify the upstream certificate against the name the app asked for, not 127.0.0.1.
  if (!out.servername && !options.checkServerIdentity) {
    out.checkServerIdentity = (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(host, cert);
  }
  return out;
}

class RewritingHttpAgent extends http.Agent {
  override createConnection(options: any, cb?: any): any {
    return (http.Agent.prototype as any).createConnection.call(this, rewritten(options), cb);
  }
}

class RewritingHttpsAgent extends https.Agent {
  override createConnection(options: any, cb?: any): any {
    return (https.Agent.prototype as any).createConnection.call(this, rewritten(options), cb);
  }
}

type ProxySettingCallback = (params: { hostname: string }) => undefined;

interface Pool {
  http: http.Agent;
  https: https.Agent;
  rewrite: boolean;
  /** Set while LAN mode is on: LAN-originated requests get SSRF-guarded agents. */
  lan?: LanUpstream;
  /** CONTRACTS §12.6: pass-through traffic goes via this HTTP proxy. */
  upstream?: UpstreamAgents;
  /**
   * What to do with the upstream request a downstream connection is about to make (timings, upload pacing), and a
   * chance to note its target (client certificates). Called once per upstream request.
   */
  plan?: RequestPlanLookup;
}

export type RequestPlanLookup = (connection: unknown, target: { protocol?: string; hostname?: string; port?: number }) => RequestPlan | undefined;

export interface LanUpstream {
  /**
   * Agent for a connection accepted by a LAN gate (SSRF-guarded), or undefined when the connection
   * isn't LAN. Throws when that gate has been closed: such a socket gets no upstream at all.
   */
  agentFor(connection: unknown, protocol: string | undefined): http.Agent | undefined;
}

const pools = new WeakMap<object, Pool>();
let hookInstalled: boolean | undefined;

interface GetAgentOptions {
  connection?: { destroyed?: boolean };
  protocol?: string;
  hostname?: string;
  port?: number;
  tryHttp2?: boolean;
  proxySettingSource?: unknown;
}

/** Agents handed out for our rules (pooled, LAN-guarded, upstream-proxy, timed views, one-off WebSocket agents). */
const ownAgents = new WeakSet<object>();
const BYPASS = Symbol.for('flutter-intercept.request-bypass');

type RequestFn = (...args: unknown[]) => http.ClientRequest;

type HttpModule = { request?: unknown; globalAgent?: unknown; __vscodeOriginal?: { request?: unknown } };

/**
 * VS Code's extension host patches `http` / `https` IN PLACE (`Object.assign` on Node's module objects, the
 * originals saved as `module.__vscodeOriginal`), and hands each extension a shallow copy of the patched module for
 * `require('http' | 'https')`. The patched `request()` swaps the caller's agent for its proxy-resolving agent
 * (`http.proxySupport`, default "override"; only `localhost` / `127.0.0.1` / host-less targets keep the caller's
 * agent). For mockttp's upstream requests that silently dropped every agent of ours: no shared pool, no LAN SSRF
 * re-check at connect time, no upstream proxy, no emulator alias rewrite, no timings (found by the v0.7.0
 * integration suite: real HTTPS requests had only `requestMs`). `node:http` is the same patched object, so it is
 * no way back to the original.
 *
 * Requests carrying one of OUR agents therefore go to Node's own `request()`; everything else still goes through
 * the patched one. Node's own: the editor's saved original (`__vscodeOriginal.request`), else `node:http(s)` when it
 * differs, else (a `request` not named like Node's) a ClientRequest built the way Node's request() builds it.
 * Installed once per module object; a no-op where `request` already is Node's (plain Node, the CLI, tests).
 */
export function bypassPatchedRequests(
  mods: { http?: HttpModule; https?: HttpModule },
  nodeMods: { http?: HttpModule; https?: HttpModule } = {},
): boolean {
  let changed = false;
  for (const k of ['http', 'https'] as const) {
    const mod = mods[k] as (HttpModule & { request?: RequestFn & { [BYPASS]?: true } }) | undefined;
    const patched = mod?.request;
    if (!mod || typeof patched !== 'function' || patched[BYPASS]) continue;
    const real = nativeRequest(k, mod, nodeMods[k]);
    if (!real || real === patched) continue;
    const request = function (this: unknown, ...args: unknown[]) {
      const opts = typeof args[0] === 'string' || args[0] instanceof URL ? args[1] : args[0];
      const agent = opts && typeof opts === 'object' ? (opts as { agent?: unknown }).agent : undefined;
      return agent && typeof agent === 'object' && ownAgents.has(agent) ? real.apply(this, args) : patched.apply(this, args);
    } as RequestFn & { [BYPASS]?: true };
    request[BYPASS] = true;
    try {
      mod.request = request;
      changed = true;
    } catch {
      /* read-only module object: leave it */
    }
  }
  return changed;
}

/** Node's own request() for `mod` (see bypassPatchedRequests), or undefined when `mod.request` already is it. */
function nativeRequest(k: 'http' | 'https', mod: HttpModule, nodeMod: HttpModule | undefined): RequestFn | undefined {
  const saved = mod.__vscodeOriginal?.request ?? nodeMod?.__vscodeOriginal?.request;
  if (typeof saved === 'function' && saved !== mod.request) return saved as RequestFn;
  if (typeof nodeMod?.request === 'function' && nodeMod.request !== mod.request) return nodeMod.request as RequestFn;
  if (typeof mod.request === 'function' && (mod.request as RequestFn).name === 'request') return undefined;
  // Patched, original unknown: what Node's request() does for an options object (url forms go to the patched one).
  const defaultAgent = k === 'https' ? https.globalAgent : undefined;
  const patched = mod.request as RequestFn;
  return function (...args: unknown[]) {
    const [o, cb] = args;
    if (!o || typeof o !== 'object' || o instanceof URL) return patched(...args);
    return new http.ClientRequest({ ...(o as object), ...(defaultAgent ? { _defaultAgent: defaultAgent } : {}) } as http.RequestOptions, cb as never);
  } as RequestFn;
}

async function pickAgent(
  self: unknown,
  original: (o: GetAgentOptions) => Promise<unknown>,
  pool: Pool | undefined,
  o: GetAgentOptions,
): Promise<unknown> {
  // LAN sockets (keyed on the socket, not on "LAN mode is on") only ever get guarded agents,
  // which check the address actually connected to (DNS rebinding).
  const lanAgent = pool?.lan?.agentFor(o.connection, o.protocol);
  if (lanAgent) return lanAgent;
  // An upstream proxy (CONTRACTS §12.6): every pooled request and upgrade goes through it.
  const up = pool?.upstream;
  if (up) {
    if (o.protocol === 'https:') return up.https;
    if (o.protocol === 'http:' || o.protocol === undefined) return up.http;
    if (o.protocol === 'ws:' || o.protocol === 'wss:') return up.ws(o.protocol === 'wss:');
  }
  if (pool && !o.tryHttp2 && !o.connection?.destroyed) {
    if (o.protocol === 'https:') return pool.https;
    if (o.protocol === 'http:' || o.protocol === undefined) return pool.http;
  }
  // Websocket upgrades to an emulator host alias: a fresh (unpooled) rewriting agent.
  if (pool?.rewrite && (o.protocol === 'ws:' || o.protocol === 'wss:') && o.hostname && HOST_ALIASES[o.hostname]) {
    return o.protocol === 'wss:' ? new RewritingHttpsAgent() : new RewritingHttpAgent();
  }
  return original.call(self, o); // ws/wss, dead connections, everything else
}

function installHook(): boolean {
  if (hookInstalled !== undefined) return hookInstalled;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('mockttp/dist/rules/http-agents') as {
      getAgent: (o: GetAgentOptions) => Promise<unknown>;
    };
    const original = mod.getAgent;
    if (typeof original !== 'function') return (hookInstalled = false);
    mod.getAgent = async function patchedGetAgent(this: unknown, o: GetAgentOptions) {
      const src = o?.proxySettingSource;
      const pool = src && typeof src === 'function' ? pools.get(src) : undefined;
      let agent = await pickAgent(this, original, pool, o);
      if (!pool) return agent;
      // mockttp answers `false` (no agent) for direct WebSocket upgrades; Node then makes a one-off agent. Same here,
      // so the upgrade carries an agent of ours (timed, and kept clear of the editor's request patch below).
      if (agent === false && (o.protocol === 'ws:' || o.protocol === 'wss:')) agent = o.protocol === 'wss:' ? new https.Agent() : new http.Agent();
      if (!agent || typeof agent !== 'object' || 'http2' in agent || !(agent instanceof http.Agent)) return agent;
      // Our rules only: a per-request view of the agent (upstream-request.ts): phase timings (CONTRACTS §13.2), upload
      // pacing (§14.4) and the reused-socket retry (§14.6).
      let plan: RequestPlan | undefined;
      try {
        plan = pool.plan?.(o?.connection, { protocol: o?.protocol, hostname: o?.hostname, port: o?.port });
      } catch {
        plan = undefined;
      }
      const out = requestView(agent, plan ?? {});
      ownAgents.add(out);
      return out;
    };
    // The editor's http / https patch (see bypassPatchedRequests). In plain Node nothing is patched: no-op.
    /* eslint-disable @typescript-eslint/no-require-imports */
    bypassPatchedRequests({ http: require('http'), https: require('https') }, { http: require('node:http'), https: require('node:https') });
    /* eslint-enable @typescript-eslint/no-require-imports */
    return (hookInstalled = true);
  } catch {
    return (hookInstalled = false);
  }
}

export interface UpstreamPool {
  /** Pass as the passthrough rule's `proxyConfig`. */
  proxyConfig: ProxySettingCallback;
  readonly active: boolean;
  setLan(lan: LanUpstream | undefined): void;
  /** Route pass-through traffic via an HTTP proxy (undefined = direct). Connections in use finish first. */
  setUpstream(spec: UpstreamProxySpec | undefined): void;
  readonly upstream: UpstreamProxySpec | undefined;
  /** The plan (timings, upload pacing) for the upstream request a downstream connection is about to make. */
  setRequestPlan(lookup: RequestPlanLookup | undefined): void;
  destroy(): void;
}

export function createUpstreamPool(opts: { rewriteLocalhost?: boolean } = {}): UpstreamPool {
  const active = installHook();
  const rewrite = opts.rewriteLocalhost ?? true;
  const pool: Pool = {
    http: rewrite ? new RewritingHttpAgent(keepAliveOptions()) : new http.Agent(keepAliveOptions()),
    https: rewrite ? new RewritingHttpsAgent(keepAliveOptions()) : new https.Agent(keepAliveOptions()),
    rewrite,
  };
  const proxyConfig: ProxySettingCallback = () => undefined;
  pools.set(proxyConfig, pool);
  return {
    proxyConfig,
    active,
    setLan(lan) {
      pool.lan = lan;
    },
    setUpstream(spec) {
      retireAgents(pool.upstream);
      pool.upstream = spec ? createUpstreamAgents(spec, undefined, rewrite ? (h) => HOST_ALIASES[h] : undefined) : undefined;
    },
    get upstream() {
      return pool.upstream?.spec;
    },
    setRequestPlan(lookup) {
      pool.plan = lookup;
    },
    destroy() {
      pools.delete(proxyConfig);
      pool.http.destroy();
      pool.https.destroy();
      if (pool.upstream) {
        pool.upstream.http.destroy();
        pool.upstream.https.destroy();
        pool.upstream = undefined;
      }
    },
  };
}
