// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import * as net from 'net';
import { matchesHostPattern, normalizeHostname } from './hosts';
import { lanGateOf } from './lan';
import {
  CERT_ALERTS,
  clientKeyOf,
  hostLabel,
  LEARNED_MAX,
  LearnedHosts,
  learnedKey,
  NGINX_NO_CERT_TEXT,
  PROBE_MAX_AT_ONCE,
  PROBE_NEGATIVE_MS,
  PROBED_MAX,
  probeCertificateRequest,
  probeTesting,
  type ProbeTarget,
} from './learned';
import { requestInternals } from './mockttp-internals';
import { HOST_ALIASES } from './upstream-pool';
import type { LearnedPassthrough } from './types';
import type { ProxyContext } from './proxy-context';

/** What a decrypted request's upstream failure looked like (CONTRACTS §20.1 "client-certificate"). */
export interface UpstreamRefusal {
  /** The server the request names (bare host, port). Learned only when it is the CONNECT target (else `noLearn`). */
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
  /**
   * Explain, never learn: the request isn't the app's own CONNECT traffic (send / resend, Map Remote), or the server
   * the proxy connected to isn't the one the request names (REVIEW-14 #1: a CONNECT to an IP with another Host / SNI).
   */
  noLearn?: boolean;
}

/** The failed exchange's error, and what was learned from it. */
export interface LearnVerdict {
  error: string;
  learned?: { reason: 'client-certificate'; host: string; port: number };
  /** CONTRACTS §20.7: the proxy concluded the server wants the app's client certificate (Exchange.needsClientCertificate). */
  needs?: { host: string; port: number };
}

const ADD_CERT = 'add the certificate in the Flutter Intercept panel (Add client certificate…)';

/** A server: bare host (lower case, IPv6 without brackets) and port. */
export interface ServerKey {
  host: string;
  port: number;
}

/**
 * REVIEW-14 #1: the server a request's connection goes to — inside a CONNECT tunnel, the CONNECT target (before Map
 * Remote changes the URL). Learning keys on it, never on the Host / `:authority` / SNI name.
 */
export function connectTargetOf(req: object): ServerKey | undefined {
  const d = requestInternals(req).destination as Partial<{ hostname: string; port: number }> | undefined;
  const host = d?.hostname ? normalizeHostname(d.hostname) : '';
  return host && d?.port ? { host, port: d.port } : undefined;
}

/** The server an `https:` URL names (port 443 by default); undefined for another scheme or a URL that doesn't parse. */
export function httpsServerOf(url: string): ServerKey | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:') return undefined;
  return { host: normalizeHostname(u.hostname), port: Number(u.port) || 443 };
}

/** REVIEW-14 #1: does the request name the server its connection goes to (same host and port)? */
export function isSameServer(named: ServerKey, dest: ServerKey | undefined): boolean {
  return !!dest && dest.host === named.host && dest.port === named.port;
}

/** Learned passthrough (CONTRACTS §20.1): the map, its exclusions, the probe, and the app's idle connections. */
export class LearnFlow {
  readonly hosts: LearnedHosts;
  /** Probes in flight per host:port (shared by every failure that waits for one). */
  private readonly probing = new Map<string, Promise<boolean>>();
  /** Probes whose work hasn't ended yet (the cap). */
  private busy = 0;
  /**
   * host:port → the last probe's answer and when (PERF-2 #2: reused within PROBE_NEGATIVE_MS, both ways — failures
   * that arrive after a probe said yes don't start another one, which matters once the map is full).
   */
  private readonly probed = new Map<string, { yes: boolean; at: number }>();
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
   * The learned entry a CONNECT from `client` (clientKeyOf) to `host:port` is passed through for: a `client-certificate`
   * entry, or that client's own pin. O(1) for hosts not learned. An entry yields while a recording is replayed or a
   * rule names the host (REVIEW-14 #6: rules added after it too), so they answer it.
   */
  forConnect(host: string, port: number, client: string): LearnedPassthrough | undefined {
    const e = this.hosts.lookup(host, port, client);
    if (!e) return undefined;
    return this.keepDecrypted(host, port) ? undefined : e;
  }

  /** Response-head time: might this failure teach the host (then the app's connection is closed after it)? */
  mayTeach(f: UpstreamRefusal): boolean {
    return this.px.autoPassthrough && !f.certPattern && !f.noLearn && (!!f.nginx || f.alert === 116 || f.alert === 40 || f.alert === 42);
  }

  /** The last probe's answer for `host:port` while it is fresh (PROBE_NEGATIVE_MS). */
  private recentProbe(key: string): { yes: boolean; at: number } | undefined {
    const r = this.probed.get(key);
    return r && Date.now() - r.at < PROBE_NEGATIVE_MS ? r : undefined;
  }

  /**
   * CONTRACTS §20.1: what an upstream refusal means. A configured certificate that was rejected says so; a demand for
   * the app's own certificate (alert 116 or the nginx 400 at once, 40 / 42 once a probe sees a CertificateRequest)
   * learns `host:port` unless it must stay decrypted. Undefined = nothing to say (the error stays as it was).
   */
  async verdict(f: UpstreamRefusal): Promise<LearnVerdict | undefined> {
    const label = hostLabel(f.host, f.port);
    if (f.certPattern) {
      const why = f.nginx ? NGINX_NO_CERT_TEXT : f.alert !== undefined ? CERT_ALERTS[f.alert] : undefined;
      return why ? { error: `The server rejected the client certificate configured for ${f.certPattern} (${why}).` } : undefined;
    }
    if (f.noLearn) return undefined;
    const needs = { host: f.host, port: f.port };
    let cause: string;
    if (f.alert === 116) cause = 'TLS alert certificate_required';
    else if (f.nginx) cause = `HTTP 400 "${NGINX_NO_CERT_TEXT}"`;
    else if ((f.alert === 40 || f.alert === 42) && !this.px.autoPassthrough) {
      // §20.7: no probe while automatic passthrough is off, so the refusal can't be confirmed.
      return {
        error: `The server ended the TLS handshake (${CERT_ALERTS[f.alert]}); it may need the app's own client certificate. Automatic passthrough is off, so Flutter Intercept didn't check: add the certificate in the panel (Add client certificate…) if it needs one.`,
        needs,
      };
    } else if (f.alert === 40 || f.alert === 42) {
      if (this.keepDecrypted(f.host, f.port, { grpc: f.grpc })) return undefined; // no probe for a host that can't be learned
      if (!(await this.probe(f))) return undefined;
      cause = `TLS alert ${CERT_ALERTS[f.alert]}; the server asks for a client certificate`;
    } else return undefined;
    const says = `This server needs the app's own client certificate (${cause}).`;
    if (!this.px.autoPassthrough) {
      return {
        error: `${says} Automatic passthrough is off (flutterIntercept.autoPassthrough), so its requests keep failing through Flutter Intercept: ${ADD_CERT}, or turn it on.`,
        needs,
      };
    }
    const kept = this.keepDecrypted(f.host, f.port, { grpc: f.grpc });
    if (kept) {
      const rules = kept.startsWith('The enabled rule') ? ' for the rules to work' : '';
      return { error: `${says} ${kept}, so ${label} stays decrypted${rules}. To make these requests work, ${ADD_CERT}.`, needs };
    }
    const by = clientKeyOf((f.socket as { remoteAddress?: string } | undefined)?.remoteAddress);
    if (!this.hosts.learn(f.host, f.port, 'client-certificate', { by, ...(f.grpc ? { grpc: true } : {}) })) {
      return { error: `${says} ${LEARNED_MAX} hosts are passed through already, so ${label} stays decrypted. To make these requests work, ${ADD_CERT}.`, needs };
    }
    return {
      error:
        `${says} From now on ${label} is passed through without decryption, ` +
        `so the app talks to it directly with its own certificate. To see these requests, ${ADD_CERT}.`,
      learned: { reason: 'client-certificate', host: f.host, port: f.port },
      needs,
    };
  }

  /**
   * One probe per host:port at a time, ≤ PROBE_MAX_AT_ONCE in all — counted until the probe's work has ended, not just
   * its answer (REVIEW-14 #6) — and its answer is reused for PROBE_NEGATIVE_MS.
   */
  private probe(f: UpstreamRefusal): Promise<boolean> {
    const key = learnedKey(f.host, f.port);
    const running = this.probing.get(key);
    if (running) return running;
    const recent = this.recentProbe(key);
    if (recent) return Promise.resolve(recent.yes);
    if (this.busy >= PROBE_MAX_AT_ONCE || this.px.targetsSelf(f.host, f.port)) return Promise.resolve(false);
    const gate = lanGateOf(f.socket);
    if (gate?.closed) return Promise.resolve(false);
    const target: ProbeTarget = {
      host: f.host,
      port: f.port,
      ...(gate ? { lan: { listenerHost: gate.host, closed: () => gate.closed } } : {}),
      upstream: this.px.upstreamSpec,
      ...(!gate && (this.px.opts.rewriteLocalhost ?? true) ? { alias: (h: string) => HOST_ALIASES[h] } : {}),
    };
    this.busy++;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      this.busy--;
    };
    const run = probeTesting.probe ? probeTesting.probe(target).finally(done) : probeCertificateRequest(target, undefined, done);
    const p = run
      .catch(() => false)
      .then((yes) => {
        this.probing.delete(key);
        const now = Date.now();
        if (this.probed.size >= PROBED_MAX && !this.probed.has(key)) {
          for (const [k, r] of this.probed) if (now - r.at >= PROBE_NEGATIVE_MS) this.probed.delete(k);
        }
        if (this.probed.size < PROBED_MAX || this.probed.has(key)) this.probed.set(key, { yes, at: now });
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
    this.probed.clear();
    this.conns.clear();
  }
}
