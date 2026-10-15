// CONTRACTS §20.1: learned passthrough hosts — one map for HTTP CONNECTs and gRPC silent tunnels — and how a server's
// demand for a client certificate is recognised (TLS alerts, the nginx 400, a CertificateRequest probe).

import * as net from 'net';
import * as tls from 'tls';
import { Duplex } from 'stream';
import { normalizeHostname } from './hosts';
import { openTunnelUpstream, type TunnelUpstream } from './tunnel';
import type { LearnedPassthrough, LearnedPassthroughReason } from './types';

/** At most this many learned hosts (expired ones are dropped first; then nothing new is learned). */
export const LEARNED_MAX = 1000;
/** A probe gives up after this long (connect, upstream proxy and the server's first flight). */
export const PROBE_TIMEOUT_MS = 5000;
/** Probes running at once, over all hosts. */
export const PROBE_MAX_AT_ONCE = 4;
/** A probe's answer is reused for that host:port within this window (a negative one: no new probe until then). */
export const PROBE_NEGATIVE_MS = 60_000;

/** nginx's answer (`ssl_verify_client on`) to a request without a client certificate. */
export const NGINX_NO_CERT_TEXT = 'No required SSL certificate was sent';

/** TLS alerts that refuse a (missing) client certificate, by number. */
export const CERT_ALERTS: Record<number, string> = {
  40: 'handshake_failure',
  42: 'bad_certificate',
  43: 'unsupported_certificate',
  44: 'certificate_revoked',
  45: 'certificate_expired',
  46: 'certificate_unknown',
  48: 'unknown_ca',
  49: 'access_denied',
  116: 'certificate_required',
};

/** The learned map's key (and the 0.13 gRPC pin key): bare host (IPv6 without brackets), port. */
export const learnedKey = (host: string, port: number): string => `${host}:${port}`;

/** `host` for 443, else `host:port` (IPv6 in brackets): how messages name a learned host. */
export function hostLabel(host: string, port: number): string {
  const h = net.isIPv6(host) ? `[${host}]` : host;
  return port === 443 ? h : `${h}:${port}`;
}

/** `host:port` / `[v6]:port` / `host` (any port) → the host and the port, if given. */
export function parseLearnedKey(key: string): { host: string; port?: number } | undefined {
  const s = String(key ?? '').trim();
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? (net.isIPv6(s) ? [s, s, undefined] : /^([^:[\]]+)(?::(\d+))?$/.exec(s));
  if (!m) return undefined;
  const host = normalizeHostname(m[1]);
  const port = m[2] !== undefined ? Number(m[2]) : undefined;
  if (!host || (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535))) return undefined;
  return port === undefined ? { host } : { host, port };
}

/**
 * The map itself. Lookups are O(1); an expired entry is dropped when it is looked up (or when the map is full).
 * `changed` runs after every change made here (learn / forget / clear), not on a silent expiry.
 */
export class LearnedHosts {
  private readonly map = new Map<string, LearnedPassthrough>();

  constructor(private readonly changed: () => void) {}

  get size(): number {
    return this.map.size;
  }

  /** The live entry for `host:port` (learnedKey). */
  get(key: string): LearnedPassthrough | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.until === undefined || Date.now() < e.until) return e;
    this.map.delete(key);
    return undefined;
  }

  /**
   * Learn (or renew) a host. A `client-certificate` entry is never replaced by a `pinned` one (it outlives it).
   * False = the map is full of live entries.
   */
  learn(host: string, port: number, reason: LearnedPassthroughReason, o: { until?: number; grpc?: boolean } = {}): boolean {
    const key = learnedKey(host, port);
    const have = this.get(key);
    if (have?.reason === 'client-certificate' && reason === 'pinned') return true;
    if (!have && this.map.size >= LEARNED_MAX) {
      this.dropExpired();
      if (this.map.size >= LEARNED_MAX) return false;
    }
    const next: LearnedPassthrough = { host, port, reason, ...(o.until !== undefined ? { until: o.until } : {}), ...(o.grpc ? { grpc: true as const } : {}) };
    this.map.set(key, next);
    // PERF-2 #3: renewing an entry with the same values (every failure of a burst re-learns the host) is no change.
    if (!have || have.reason !== next.reason || have.until !== next.until || !!have.grpc !== !!next.grpc) this.changed();
    return true;
  }

  /** Forget the entries `pred` picks; true if any went. */
  forget(pred: (e: LearnedPassthrough) => boolean): boolean {
    let n = 0;
    for (const [k, e] of this.map) {
      if (pred(e)) {
        this.map.delete(k);
        n++;
      }
    }
    if (n) this.changed();
    return n > 0;
  }

  clear(): void {
    if (!this.map.size) return;
    this.map.clear();
    this.changed();
  }

  /** Live entries, oldest first (copies). */
  list(): LearnedPassthrough[] {
    this.dropExpired();
    return [...this.map.values()].map((e) => ({ ...e }));
  }

  private dropExpired(): void {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.until !== undefined && now >= e.until) this.map.delete(k);
  }
}

/** The TLS alert number in an upstream error (`SSL alert number N`, or Node's ERR_SSL_*_ALERT_* code). */
export function alertOf(e: { code?: unknown; message?: unknown } | undefined): number | undefined {
  if (!e) return undefined;
  const m = /SSL alert number (\d+)/.exec(String(e.message ?? ''));
  if (m) return Number(m[1]);
  const code = String(e.code ?? '');
  if (/ALERT_CERTIFICATE_REQUIRED$/.test(code)) return 116;
  if (/ALERT_HANDSHAKE_FAILURE$/.test(code)) return 40;
  if (/ALERT_BAD_CERTIFICATE$/.test(code)) return 42;
  return undefined;
}

/** The TLS alert in mockttp's tags for a failed passthrough (`passthrough-tls-error:ssl-alert-N`). */
export function alertOfTags(tags: readonly string[] | undefined): number | undefined {
  for (const t of tags ?? []) {
    const m = /^passthrough-tls-error:ssl-alert-(\d+)$/.exec(t);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Does a rule's URL pattern name this host (CONTRACTS §20.1 exclusion)? Only a glob with a scheme (`…://host/…`) has
 * a host part; one made of `*` alone (any host), a pattern without `://` and a /regex/ don't name a host. The host part
 * may carry a port (`:8443`, `:*`); without one any port matches. Case-insensitive.
 */
export function patternNamesHost(pattern: string, host: string, port: number): boolean {
  const p = String(pattern ?? '').trim();
  if (p.startsWith('/')) return false;
  const at = p.indexOf('://');
  if (at < 0) return false;
  const rest = p.slice(at + 3);
  const end = rest.search(/[/?#]/);
  let part = (end < 0 ? rest : rest.slice(0, end)).toLowerCase();
  if (!part || /^\*+$/.test(part)) return false;
  let portPart: string | undefined;
  const v6 = /^(\[[^\]]*\])(?::([\d*]+))?$/.exec(part);
  if (v6) {
    part = v6[1].slice(1, -1);
    portPart = v6[2];
  } else {
    const m = /^(.*):([\d*]+)$/.exec(part);
    if (m) {
      part = m[1];
      portPart = m[2];
    }
  }
  if (!part || /^\*+$/.test(part)) return false;
  if (portPart !== undefined && !glob(portPart, String(port))) return false;
  return glob(part, host.toLowerCase());
}

/** `*` = any characters (linear: indexOf between the literal parts). */
function glob(p: string, s: string): boolean {
  const parts = p.split('*');
  if (parts.length === 1) return p === s;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (s.length < first.length + last.length || !s.startsWith(first) || !s.endsWith(last)) return false;
  let pos = first.length;
  const end = s.length - last.length;
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const i = s.indexOf(part, pos);
    if (i < 0 || i + part.length > end) return false;
    pos = i + part.length;
  }
  return true;
}

/**
 * Reads a server's first TLS 1.2 flight (plaintext handshake records) and says whether it asks for a client
 * certificate: true = a CertificateRequest (13); false = the flight ended without one (ServerHelloDone, 14), an
 * alert, encrypted records or something that isn't TLS; undefined = need more bytes.
 */
export class CertRequestFinder {
  private rec: Buffer = Buffer.alloc(0);
  private hs: Buffer = Buffer.alloc(0);
  private seen = 0;

  push(d: Buffer): boolean | undefined {
    this.seen += d.length;
    if (this.seen > 256 * 1024) return false;
    this.rec = this.rec.length ? Buffer.concat([this.rec, d]) : d;
    while (this.rec.length >= 5) {
      const type = this.rec[0];
      const len = this.rec.readUInt16BE(3);
      if (this.rec[1] !== 3 || len > 18_432) return false;
      if (this.rec.length < 5 + len) return undefined;
      const frag = this.rec.subarray(5, 5 + len);
      this.rec = this.rec.subarray(5 + len);
      if (type !== 22) return false; // alert (21), change_cipher_spec (20), application data (23)
      this.hs = this.hs.length ? Buffer.concat([this.hs, frag]) : frag;
      while (this.hs.length >= 4) {
        const msg = this.hs[0];
        if (msg === 13) return true;
        if (msg === 14) return false;
        const ml = this.hs.readUIntBE(1, 3);
        if (this.hs.length < 4 + ml) break;
        this.hs = this.hs.subarray(4 + ml);
      }
    }
    return undefined;
  }
}

export type ProbeTarget = Pick<TunnelUpstream, 'host' | 'port' | 'lan' | 'upstream' | 'alias'>;

/**
 * Does `host:port` ask for a client certificate? A TLS 1.2 ClientHello, opened like a passthrough tunnel's upstream
 * connection (LAN guard, upstream proxy, emulator aliases: never a target a CONNECT couldn't reach); the server's
 * first flight is read before the TLS stack sees it, and the connection is dropped as soon as it decides — before
 * the client answers, so no certificate (not even an empty one), no key exchange and no application data are sent.
 * False on any failure or after `timeoutMs`.
 */
export async function probeCertificateRequest(t: ProbeTarget, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  let raw: net.Socket | undefined;
  let secure: tls.TLSSocket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let over = false;
  const cleanup = () => {
    over = true;
    clearTimeout(timer);
    secure?.destroy();
    raw?.destroy();
  };
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const work = (async (): Promise<boolean> => {
    raw = await openTunnelUpstream({ ...t, timings: () => undefined, timeoutMs });
    if (over) {
      raw.destroy(); // opened after the deadline
      return false;
    }
    const sock = raw;
    sock.on('error', () => undefined);
    return await new Promise<boolean>((resolve) => {
      const finder = new CertRequestFinder();
      const pipe = new Duplex({
        read() {
          sock.resume();
        },
        write(chunk: Buffer, _enc, cb) {
          if (over) return cb();
          sock.write(chunk, () => cb());
        },
      });
      sock.on('data', (d: Buffer) => {
        const verdict = finder.push(d);
        if (verdict !== undefined) return resolve(verdict); // never handed to the TLS stack
        if (!pipe.push(d)) sock.pause();
      });
      sock.once('close', () => resolve(false));
      const host = t.host;
      secure = tls.connect({
        socket: pipe,
        ...(net.isIP(host) ? {} : { servername: host }),
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      });
      secure.on('error', () => resolve(false));
    });
  })().catch(() => false);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    cleanup();
  }
}

/** Test seam: replace the probe. Never set outside tests. */
export const probeTesting: { probe?: (t: ProbeTarget) => Promise<boolean> } = {};
