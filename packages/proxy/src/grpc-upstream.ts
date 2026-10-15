import * as http2 from 'http2';
import * as net from 'net';
import * as tls from 'tls';
import { GRPC_SESSION_IDLE_MS } from './grpc';
import type { LanGate } from './lan';
import { openTunnelUpstream } from './tunnel';
import { elapsed, type TimingSink } from './timing';
import type { UpstreamProxySpec } from './upstream-proxy';
import { bracketHost } from './learned-meta';

/*
 * Upstream HTTP/2 sessions for the gRPC relay (CONTRACTS §16.2). node:http2 is not one of the modules VS Code
 * patches, so nothing here depends on the editor's proxy support: the socket under every session comes from
 * openTunnelUpstream (tunnel.ts) — the LAN SSRF guard (resolved and checked, DNS-rebinding safe), the upstream proxy
 * (CONNECT), the emulator aliases — and TLS is ours (ALPN h2, certificate verification unless
 * ignoreUpstreamCertErrors, client certificates). `http:` targets speak h2c with prior knowledge.
 *
 * Pooling: one key per origin, LAN gate (sessions are never shared across gates or with loopback clients), TLS
 * verification, client certificate and upstream proxy. A session takes streams up to the server's
 * SETTINGS_MAX_CONCURRENT_STREAMS (then another session is opened), leaves the pool on GOAWAY (its streams finish),
 * and is closed after GRPC_SESSION_IDLE_MS without streams.
 */

export interface GrpcSessionRequest {
  protocol: 'http:' | 'https:';
  /** Hostname (no brackets) and port of the server. */
  host: string;
  port: number;
  /** LAN client (CONTRACTS §7): the gate whose SSRF guard applies; its sessions are its own. */
  gate?: LanGate;
  upstream?: UpstreamProxySpec;
  /** Loopback clients: emulator alias → address (rewriteLocalhost). */
  alias?: (host: string) => string | undefined;
  /** https: verify the server certificate (false = ignoreUpstreamCertErrors). */
  rejectUnauthorized: boolean;
  /** mTLS (CONTRACTS §14.3): the TLS options of the certificate and the pattern naming it (pool key). */
  cert?: { pattern: string; options: tls.ConnectionOptions };
  /** Opening a session (TCP / CONNECT / TLS / h2 preface) gives up after this long. */
  connectTimeoutMs: number;
  /**
   * CONTRACTS §18.6: is the address the socket actually connected to one of the proxy's own listeners? (A name that
   * resolves to this machine on our port.) Then the session is refused with an error whose code is `E_FI_LOOP`.
   */
  connectsToSelf?: (ip: string, port: number) => boolean;
}

export interface GrpcLease {
  session: http2.ClientHttp2Session;
  /** An existing session (no connection phases). */
  reused: boolean;
  /** Count this stream on the session until it closes. */
  track(stream: http2.ClientHttp2Stream): void;
  /** Give the slot back without a stream (request() threw). */
  release(): void;
}

interface Entry {
  key: string;
  gate?: LanGate;
  session: http2.ClientHttp2Session;
  active: number;
  draining: boolean;
  idle?: NodeJS.Timeout;
}

/** Test seam: a shorter idle timeout. Never set outside tests. */
export const grpcPoolTesting: { idleMs?: number } = {};


export class GrpcSessionPool {
  private readonly entries = new Map<string, Entry[]>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly gateIds = new WeakMap<object, number>();
  private nextGateId = 1;
  private stopped = false;

  /** Sessions open right now (tests / status). */
  get size(): number {
    let n = 0;
    for (const list of this.entries.values()) n += list.length;
    return n;
  }

  async acquire(r: GrpcSessionRequest, timings: TimingSink): Promise<GrpcLease> {
    if (this.stopped) throw new Error('the proxy is stopping');
    const key = this.keyOf(r);
    const have = this.pick(key);
    if (have) {
      timings({ reused: true });
      return this.lease(have, true);
    }
    let p = this.pending.get(key);
    const shared = !!p;
    if (!p) {
      p = this.open(r, key, timings);
      this.pending.set(key, p);
      const clear = () => {
        if (this.pending.get(key) === p) this.pending.delete(key);
      };
      p.then(clear, clear);
    }
    const e = await p;
    if (shared) timings({ reused: true });
    if (e.session.closed || e.session.destroyed) throw new Error('the connection to the server closed');
    return this.lease(e, shared);
  }

  /** Close every session of a LAN gate (closeLan). */
  destroyGate(gate: LanGate): void {
    for (const [key, list] of [...this.entries]) {
      for (const e of list) if (e.gate === gate) e.session.destroy();
      if (!list.length) this.entries.delete(key);
    }
  }

  destroyAll(): void {
    this.stopped = true;
    for (const list of [...this.entries.values()]) for (const e of [...list]) e.session.destroy();
    this.entries.clear();
  }

  private keyOf(r: GrpcSessionRequest): string {
    let gate = 0;
    if (r.gate) {
      gate = this.gateIds.get(r.gate) ?? 0;
      if (!gate) this.gateIds.set(r.gate, (gate = this.nextGateId++));
    }
    const tlsKey = r.protocol === 'https:' ? `${r.rejectUnauthorized ? 'verify' : 'insecure'}|${r.cert?.pattern ?? ''}` : '';
    return `${gate}|${r.protocol}//${bracketHost(r.host)}:${r.port}|${tlsKey}|${r.upstream?.label ?? ''}|${r.alias?.(r.host) ?? ''}`;
  }

  private pick(key: string): Entry | undefined {
    const list = this.entries.get(key);
    if (!list) return undefined;
    for (const e of list) {
      if (e.draining || e.session.closed || e.session.destroyed) continue;
      const max = e.session.remoteSettings?.maxConcurrentStreams ?? 100;
      if (e.active < max) return e;
    }
    return undefined;
  }

  private lease(e: Entry, reused: boolean): GrpcLease {
    e.active++;
    if (e.idle) {
      clearTimeout(e.idle);
      e.idle = undefined;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      e.active = Math.max(0, e.active - 1);
      if (e.active === 0 && !e.session.closed && !e.session.destroyed) {
        e.idle = setTimeout(() => {
          if (e.active === 0) e.session.close();
        }, grpcPoolTesting.idleMs ?? GRPC_SESSION_IDLE_MS);
        e.idle.unref?.();
      }
    };
    return {
      session: e.session,
      reused,
      track: (stream) => stream.once('close', release),
      release,
    };
  }

  private remove(e: Entry): void {
    const list = this.entries.get(e.key);
    if (!list) return;
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.entries.delete(e.key);
  }

  private async open(r: GrpcSessionRequest, key: string, timings: TimingSink): Promise<Entry> {
    const label = `${bracketHost(r.host)}:${r.port}`;
    let raw: net.Socket | undefined;
    let secure: tls.TLSSocket | undefined;
    let session: http2.ClientHttp2Session | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`no connection to ${label} within ${Math.round(r.connectTimeoutMs / 100) / 10} s`));
      }, r.connectTimeoutMs);
    });
    const work = (async () => {
      raw = await openTunnelUpstream({
        host: r.host,
        port: r.port,
        ...(r.gate ? { lan: { listenerHost: r.gate.host, closed: () => r.gate!.closed } } : {}),
        upstream: r.upstream,
        alias: r.alias,
        timings,
        timeoutMs: r.connectTimeoutMs,
      });
      if (timedOut || this.stopped) throw new Error('cancelled');
      if (r.connectsToSelf && raw.remoteAddress && raw.remotePort && r.connectsToSelf(raw.remoteAddress, raw.remotePort)) {
        throw Object.assign(new Error(`${label} is Flutter Intercept itself`), { code: 'E_FI_LOOP' });
      }
      let sock: net.Socket = raw;
      if (r.protocol === 'https:') {
        const from = performance.now();
        const t = tls.connect({
          ...(r.cert?.options ?? {}),
          socket: raw,
          host: r.host,
          ...(net.isIP(r.host) ? {} : { servername: r.host }),
          ALPNProtocols: ['h2'],
          rejectUnauthorized: r.rejectUnauthorized,
        });
        secure = t;
        await new Promise<void>((resolve, reject) => {
          t.once('secureConnect', () => resolve());
          t.once('error', reject);
        });
        timings({ tlsMs: elapsed(from) });
        if (t.alpnProtocol !== 'h2') throw new Error(`${label} did not agree to HTTP/2 (ALPN: ${t.alpnProtocol || 'none'})`);
        sock = t;
      }
      const s = http2.connect(`${r.protocol}//${label}`, { createConnection: () => sock });
      session = s;
      await new Promise<void>((resolve, reject) => {
        s.once('connect', () => resolve());
        s.once('error', reject);
        s.once('close', () => reject(new Error(`${label} closed the connection`)));
      });
      return s;
    })();
    let s: http2.ClientHttp2Session;
    try {
      s = await Promise.race([work, deadline]);
    } catch (e) {
      // Whatever got opened goes away, also when it completes after the deadline.
      work.then(
        (late) => late.destroy(),
        () => undefined,
      );
      session?.destroy();
      secure?.destroy();
      raw?.destroy();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (this.stopped) {
      s.destroy();
      throw new Error('the proxy is stopping');
    }
    const e: Entry = { key, session: s, active: 0, draining: false, ...(r.gate ? { gate: r.gate } : {}) };
    s.on('error', () => undefined); // streams see their own errors
    s.on('goaway', () => {
      e.draining = true;
      this.remove(e);
    });
    s.once('close', () => {
      if (e.idle) clearTimeout(e.idle);
      this.remove(e);
    });
    const list = this.entries.get(key) ?? [];
    list.push(e);
    this.entries.set(key, list);
    return e;
  }
}
