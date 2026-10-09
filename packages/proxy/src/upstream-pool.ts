import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';

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
}

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
      // LAN sockets (keyed on the socket, not on "LAN mode is on") only ever get guarded agents,
      // which check the address actually connected to (DNS rebinding).
      const lanAgent = pool?.lan?.agentFor(o.connection, o.protocol);
      if (lanAgent) return lanAgent;
      if (pool && !o.tryHttp2 && !o.connection?.destroyed) {
        if (o.protocol === 'https:') return pool.https;
        if (o.protocol === 'http:' || o.protocol === undefined) return pool.http;
      }
      // Websocket upgrades to an emulator host alias: a fresh (unpooled) rewriting agent.
      if (pool?.rewrite && (o.protocol === 'ws:' || o.protocol === 'wss:') && o.hostname && HOST_ALIASES[o.hostname]) {
        return o.protocol === 'wss:' ? new RewritingHttpsAgent() : new RewritingHttpAgent();
      }
      return original.call(this, o); // ws/wss, dead connections, everything else
    };
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
  destroy(): void;
}

export function createUpstreamPool(opts: { rewriteLocalhost?: boolean } = {}): UpstreamPool {
  const active = installHook();
  const rewrite = opts.rewriteLocalhost ?? true;
  const pool: Pool = {
    http: rewrite ? new RewritingHttpAgent({ keepAlive: true }) : new http.Agent({ keepAlive: true }),
    https: rewrite ? new RewritingHttpsAgent({ keepAlive: true }) : new https.Agent({ keepAlive: true }),
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
    destroy() {
      pools.delete(proxyConfig);
      pool.http.destroy();
      pool.https.destroy();
    },
  };
}
