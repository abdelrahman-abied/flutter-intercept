// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import * as net from 'net';
import { matchesHostPattern } from './hosts';
import { lanGateOf } from './lan';
import {
  CERT_ALERTS,
  hostLabel,
  LEARNED_MAX,
  LearnedHosts,
  learnedKey,
  PROBE_MAX_AT_ONCE,
  PROBE_NEGATIVE_MS,
  probeCertificateRequest,
  probeTesting,
  type ProbeTarget,
} from './learned';
import { HOST_ALIASES } from './upstream-pool';
import type { LearnedPassthrough } from './types';
import type { ProxyContext } from './proxy-context';

/** What a decrypted request's upstream failure looked like (CONTRACTS §20.1 "client-certificate"). */
export interface UpstreamRefusal {
  /** The server (bare host, port) the proxy connected to. */
  host: string;
  port: number;
  /** The TLS alert the server sent. */
  alert?: number;
  /** The server answered nginx's 400 "No required SSL certificate was sent". */
  nginx?: boolean;
  /** The connection presented this configured certificate (its pattern, Exchange.clientCertificate). */
  certPattern?: string;
  /** The app's connection (its LAN gate guards the probe). */
  socket?: unknown;
  /** Learned on a gRPC call (a silent tunnel's host). */
  grpc?: boolean;
  /** The request isn't the app's own CONNECT traffic (send / resend, Map Remote): explain, never learn. */
  noLearn?: boolean;
}

/** The failed exchange's error, and what was learned from it. */
export interface LearnVerdict {
  error: string;
  learned?: { reason: 'client-certificate'; host: string; port: number };
}

const ADD_CERT = 'add the certificate in the Flutter Intercept panel (Add client certificate…)';

/** Learned passthrough (CONTRACTS §20.1): the map, its exclusions, the probe, and the app's idle connections. */
export class LearnFlow {
  readonly hosts: LearnedHosts;
  /** Probes in flight per host:port (shared by every failure that waits for one). */
  private readonly probing = new Map<string, Promise<boolean>>();
  /** host:port whose probe found no CertificateRequest → when (not probed again within PROBE_NEGATIVE_MS). */
  private readonly negative = new Map<string, number>();
  /** The app's HTTP/1 connections that carried HTTPS requests, per host:port (until they close). */
  private readonly conns = new Map<string, Set<net.Socket>>();
  private readonly tracked = new WeakSet<object>();
  private emitScheduled = false;

  constructor(private readonly px: ProxyContext) {
    this.hosts = new LearnedHosts(() => this.scheduleEmit());
  }

  /** The 'learnedPassthrough' event, once per tick of changes. */
  private scheduleEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    process.nextTick(() => {
      this.emitScheduled = false;
      this.px.emit('learnedPassthrough', this.hosts.list());
    });
  }

  /**
   * Why `host:port` must stay decrypted (undefined = it may be passed through): a recording is replayed, an enabled
   * rule names the host, or (gRPC) the host is in grpcDecryptHosts. The text completes "…, so <host> stays decrypted".
   */
  keepDecrypted(host: string, port: number, o: { grpc?: boolean } = {}): string | undefined {
    const label = hostLabel(host, port);
    if (o.grpc && this.px.grpcDecrypt.some((p) => matchesHostPattern(p, host, port))) return `${label} is in grpcDecryptHosts`;
    if (this.px.replayStore) return 'A recording is being replayed';
    const rule = this.px.ruleNamingHost(host, port);
    if (rule) return `The enabled rule ${rule.name ? `"${rule.name.slice(0, 80)}"` : rule.id.slice(0, 80)} targets ${label}`;
    return undefined;
  }

  /**
   * The learned entry an HTTP CONNECT to `host:port` is passed through for (O(1) for hosts not learned). A
   * `client-certificate` entry yields while a recording is replayed or a rule names the host (they answer it).
   */
  forConnect(host: string, port: number): LearnedPassthrough | undefined {
    const e = this.hosts.get(learnedKey(host, port));
    if (!e || e.reason === 'pinned') return e;
    return this.keepDecrypted(host, port) ? undefined : e;
  }

  /** Response-head time: might this failure teach the host (then the app's connection is closed after it)? */
  mayTeach(f: UpstreamRefusal): boolean {
    return !f.certPattern && !f.noLearn && (!!f.nginx || f.alert === 116 || f.alert === 40 || f.alert === 42);
  }

  /**
   * CONTRACTS §20.1: what an upstream refusal means. A configured certificate that was rejected says so; a demand for
   * the app's own certificate (alert 116 or the nginx 400 at once, 40 / 42 once a probe sees a CertificateRequest)
   * learns `host:port` unless it must stay decrypted. Undefined = nothing to say (the error stays as it was).
   */
  async verdict(f: UpstreamRefusal): Promise<LearnVerdict | undefined> {
    const label = hostLabel(f.host, f.port);
    if (f.certPattern) {
      const why = f.nginx ? 'No required SSL certificate was sent' : f.alert !== undefined ? (CERT_ALERTS[f.alert] ?? undefined) : undefined;
      return why ? { error: `The server rejected the client certificate configured for ${f.certPattern} (${why}).` } : undefined;
    }
    if (f.noLearn) return undefined;
    let cause: string;
    if (f.alert === 116) cause = 'TLS alert certificate_required';
    else if (f.nginx) cause = 'HTTP 400 "No required SSL certificate was sent"';
    else if (f.alert === 40 || f.alert === 42) {
      if (this.keepDecrypted(f.host, f.port, { grpc: f.grpc })) return undefined; // no probe for a host that can't be learned
      if (!(await this.probe(f))) return undefined;
      cause = `TLS alert ${CERT_ALERTS[f.alert]}; the server asks for a client certificate`;
    } else return undefined;
    const kept = this.keepDecrypted(f.host, f.port, { grpc: f.grpc });
    if (kept) {
      const rules = kept.startsWith('The enabled rule') ? ' for the rules to work' : '';
      return { error: `This server needs the app's own client certificate (${cause}). ${kept}, so ${label} stays decrypted${rules}. To make these requests work, ${ADD_CERT}.` };
    }
    if (!this.hosts.learn(f.host, f.port, 'client-certificate', f.grpc ? { grpc: true } : {})) {
      return { error: `This server needs the app's own client certificate (${cause}). ${LEARNED_MAX} hosts are passed through already, so ${label} stays decrypted. To make these requests work, ${ADD_CERT}.` };
    }
    return {
      error:
        `This server needs the app's own client certificate (${cause}). From now on ${label} is passed through without decryption, ` +
        `so the app talks to it directly with its own certificate. To see these requests, ${ADD_CERT}.`,
      learned: { reason: 'client-certificate', host: f.host, port: f.port },
    };
  }

  /** One probe per host:port at a time, ≤ PROBE_MAX_AT_ONCE in all, none again soon after a negative one. */
  private probe(f: UpstreamRefusal): Promise<boolean> {
    const key = learnedKey(f.host, f.port);
    const running = this.probing.get(key);
    if (running) return running;
    const now = Date.now();
    const neg = this.negative.get(key);
    if (neg !== undefined && now - neg < PROBE_NEGATIVE_MS) return Promise.resolve(false);
    if (this.probing.size >= PROBE_MAX_AT_ONCE || this.px.targetsSelf(f.host, f.port)) return Promise.resolve(false);
    const gate = lanGateOf(f.socket);
    if (gate?.closed) return Promise.resolve(false);
    const target: ProbeTarget = {
      host: f.host,
      port: f.port,
      ...(gate ? { lan: { listenerHost: gate.host, closed: () => gate.closed } } : {}),
      upstream: this.px.upstreamSpec,
      ...(!gate && (this.px.opts.rewriteLocalhost ?? true) ? { alias: (h: string) => HOST_ALIASES[h] } : {}),
    };
    const p = (probeTesting.probe ?? probeCertificateRequest)(target)
      .catch(() => false)
      .then((yes) => {
        this.probing.delete(key);
        if (!yes) {
          if (this.negative.size >= 1000) for (const [k, at] of this.negative) if (now - at >= PROBE_NEGATIVE_MS) this.negative.delete(k);
          if (this.negative.size < 1000) this.negative.set(key, Date.now());
        }
        return yes;
      });
    this.probing.set(key, p);
    return p;
  }

  /** decide(): remember the app's HTTP/1 connection that carries an HTTPS request to `host:port`. */
  trackConnection(socket: unknown, host: string, port: number): void {
    if (!(socket instanceof net.Socket) || this.tracked.has(socket)) return;
    this.tracked.add(socket);
    const key = learnedKey(host, port);
    let set = this.conns.get(key);
    if (!set) this.conns.set(key, (set = new Set()));
    set.add(socket);
    socket.once('close', () => {
      const s = this.conns.get(key);
      if (!s) return;
      s.delete(socket);
      if (!s.size) this.conns.delete(key);
    });
  }

  /**
   * Close the app's idle keep-alive connections to `host:port` (no response in progress), so its next request opens a
   * new CONNECT — which is then passed through. Busy ones close after their response (`Connection: close` there).
   */
  closeIdle(host: string, port: number): void {
    const set = this.conns.get(learnedKey(host, port));
    if (!set) return;
    for (const s of [...set]) {
      const msg = (s as unknown as { _httpMessage?: { finished?: boolean } | null })._httpMessage;
      if (msg && !msg.finished) continue;
      // end(), not destroy(): a response just finished may still be in the socket's buffer.
      s.end();
      setTimeout(() => s.destroy(), 2000).unref?.();
    }
  }

  /** stop(): forget everything. */
  clear(): void {
    this.hosts.clear();
    this.probing.clear();
    this.negative.clear();
    this.conns.clear();
  }
}
