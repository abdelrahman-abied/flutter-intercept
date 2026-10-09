import * as http from 'http';
import * as https from 'https';

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
 */

type ProxySettingCallback = (params: { hostname: string }) => undefined;

interface Pool {
  http: http.Agent;
  https: https.Agent;
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

export function createUpstreamPool(): UpstreamPool {
  const active = installHook();
  const pool: Pool = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
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
