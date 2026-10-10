import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { keepAliveOptions } from './idle';
import { normalizeIp } from './lan';

/*
 * Chaining to another HTTP proxy (CONTRACTS §12.6: Charles, Burp, a corporate proxy). Our own agents, not
 * mockttp's proxyConfig: mockttp builds those from https-proxy-agent / pac-proxy-agent, which the extension
 * bundle stubs out (docs/spikes/proxy.md, "Bundle"), and its agents would bypass the shared upstream pool.
 *
 * - plain http: absolute-form requests (`GET http://host/path`) on keep-alive connections to the proxy;
 * - https: a CONNECT tunnel per upstream connection, then TLS to the real server *through* it (the usual
 *   verification: `rejectUnauthorized` as mockttp computed it; `ignoreCertErrors` turns it off — needed when the
 *   upstream proxy is itself a MITM like Charles);
 * - ws / wss upgrades: a CONNECT tunnel (no TLS / TLS).
 * A `guard` (LAN clients, CONTRACTS §7) checks the FINAL target before anything is sent; tunnels then CONNECT to
 * the exact IP that was checked, so the upstream proxy can't be steered elsewhere by DNS rebinding.
 */

export interface UpstreamProxyConfig {
  url: string;
  ignoreCertErrors?: boolean;
  /**
   * CONTRACTS §14.6: hosts that go direct instead (VS Code's `http.noProxy`): `host`, `*.suffix` (subdomains), `*`
   * (everything), IP literals (`[v6]` for IPv6), each optionally `:port`. Case-insensitive.
   */
  noProxy?: string[];
}

/** One parsed `noProxy` entry. */
export interface NoProxyEntry {
  /** Exact host, or a `.suffix` (from `*.suffix`), or '*' (any). */
  host: string;
  port?: number;
}

export interface UpstreamProxySpec {
  host: string;
  port: number;
  /** `Proxy-Authorization` value, from credentials in the URL. */
  auth?: string;
  ignoreCertErrors: boolean;
  /** `http://host:port` (no credentials), for messages. */
  label: string;
  /** Targets that bypass the upstream proxy (connect directly; LAN clients stay SSRF-guarded). */
  noProxy?: NoProxyEntry[];
}

/** Parse `noProxy` entries; throws a readable error on a malformed one. */
export function parseNoProxy(list: unknown): NoProxyEntry[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('Upstream proxy: noProxy must be a list of host names');
  const out: NoProxyEntry[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw new Error('Upstream proxy: noProxy entries must be strings');
    let e = raw.trim().toLowerCase();
    if (!e) continue;
    let port: number | undefined;
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(e);
    if (v6) {
      e = v6[1];
      if (v6[2] !== undefined) port = Number(v6[2]);
    } else if ((e.match(/:/g) ?? []).length === 1) {
      const i = e.indexOf(':');
      if (!/^\d+$/.test(e.slice(i + 1))) throw new Error(`Upstream proxy: invalid noProxy entry "${raw.slice(0, 100)}"`);
      port = Number(e.slice(i + 1));
      e = e.slice(0, i);
    }
    if (port !== undefined && (port < 1 || port > 65535)) throw new Error(`Upstream proxy: invalid noProxy port in "${raw.slice(0, 100)}"`);
    e = e.replace(/\.+$/, '');
    if (e.startsWith('*.')) e = e.slice(1);
    else if (e.startsWith('.')) e = e; // curl style ".example.com" = subdomains
    if (e !== '*' && !(net.isIP(e) || /^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(e))) {
      throw new Error(`Upstream proxy: invalid noProxy entry "${raw.slice(0, 100)}"`);
    }
    out.push({ host: net.isIP(e) ? normalizeIp(e) : e, ...(port !== undefined ? { port } : {}) });
  }
  return out;
}

/** Does `host:port` bypass the upstream proxy (noProxy)? */
export function bypassesProxy(spec: UpstreamProxySpec | undefined, hostIn: string, port: number): boolean {
  if (!spec?.noProxy?.length) return false;
  const raw = String(hostIn ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const host = net.isIP(raw) ? normalizeIp(raw) : raw;
  return spec.noProxy.some((e) => {
    if (e.port !== undefined && e.port !== port) return false;
    if (e.host === '*') return true;
    if (e.host.startsWith('.')) return host.endsWith(e.host);
    return host === e.host;
  });
}

/**
 * Resolves the address to connect to for an upstream target (an IP that passed the check), or rejects.
 * `undefined` = connect by name.
 */
export type TargetGuard = (host: string, port: number) => Promise<string | undefined>;

/** Validate `{url, ignoreCertErrors}`: `http://[user:pass@]host[:port]` only. Throws a readable error. */
export function parseUpstreamProxy(cfg: UpstreamProxyConfig): UpstreamProxySpec {
  if (!cfg || typeof cfg !== 'object' || typeof cfg.url !== 'string') throw new Error('Upstream proxy: expected { url: "http://host:port" }');
  let u: URL;
  try {
    u = new URL(cfg.url.trim());
  } catch {
    throw new Error(`Upstream proxy: not a URL: ${JSON.stringify(cfg.url).slice(0, 200)}`);
  }
  if (u.protocol !== 'http:') throw new Error(`Upstream proxy: only http:// proxies are supported, got ${u.protocol}`);
  if (!u.hostname) throw new Error('Upstream proxy: no host');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new Error('Upstream proxy: the URL must be just http://host:port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || 80;
  const user = safeDecode(u.username);
  const pass = safeDecode(u.password);
  return {
    host,
    port,
    ...(u.username || u.password ? { auth: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } : {}),
    ignoreCertErrors: cfg.ignoreCertErrors === true,
    label: `http://${u.host}`,
    ...(cfg.noProxy !== undefined ? { noProxy: parseNoProxy(cfg.noProxy) } : {}),
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Loopback (or "this machine") targets: `localhost`, `*.localhost`, a trailing-dot form, 127/8, ::1, the
 * IPv4-mapped forms of those, and the unspecified addresses. These never go through an upstream proxy
 * (REVIEW-6 #10, like NO_PROXY=localhost,127.0.0.0/8,::1), and an upstream proxy there on our port is a loop.
 */
export function isLoopbackHost(hostIn: string): boolean {
  const h = String(hostIn ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (!net.isIP(h)) return false;
  const ip = normalizeIp(h);
  if (net.isIPv4(ip)) return ip.startsWith('127.') || ip === '0.0.0.0';
  return /^(?:0{0,4}:){1,7}0{0,3}[01]$/.test(ip) || ip === '::';
}

const bracket = (h: string) => (net.isIPv6(h) ? `[${h}]` : h);
const CONNECT_HEAD_MAX = 16 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;

/** Open a CONNECT tunnel to `host:port` through the proxy. */
export function connectTunnel(p: UpstreamProxySpec, host: string, port: number, cb: (err: Error | null, socket?: net.Socket) => void): void {
  const target = `${bracket(host)}:${port}`;
  const socket = net.connect({ host: p.host, port: p.port });
  let buf = Buffer.alloc(0);
  let done = false;
  const finish = (err: Error | null, s?: net.Socket) => {
    if (done) return;
    done = true;
    socket.setTimeout(0);
    socket.off('data', onData);
    if (err) socket.destroy();
    cb(err, s);
  };
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buf.length > CONNECT_HEAD_MAX) finish(new Error(`The upstream proxy ${p.label} sent an oversized CONNECT response`));
      return;
    }
    const head = buf.subarray(0, end).toString('latin1');
    const m = /^HTTP\/1\.[01] (\d{3})(?: ([^\r\n]*))?/.exec(head);
    const status = m ? Number(m[1]) : 0;
    if (status < 200 || status > 299) {
      const why = m ? `${status} ${m[2] ?? ''}`.trim() : 'an invalid response';
      return finish(Object.assign(new Error(`The upstream proxy ${p.label} refused CONNECT ${target}: ${why}`), { code: 'E_FI_UPSTREAM_PROXY' }));
    }
    socket.pause();
    const rest = buf.subarray(end + 4);
    if (rest.length) socket.unshift(rest);
    finish(null, socket);
  };
  socket.on('data', onData);
  socket.once('error', (e) => finish(Object.assign(new Error(`The upstream proxy ${p.label} is unreachable (${(e as NodeJS.ErrnoException).code ?? e.message})`), { code: 'E_FI_UPSTREAM_PROXY' })));
  socket.once('close', () => finish(new Error(`The upstream proxy ${p.label} closed the connection during CONNECT ${target}`)));
  socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(new Error(`The upstream proxy ${p.label} did not answer CONNECT ${target}`)));
  socket.once('connect', () => {
    const auth = p.auth ? `Proxy-Authorization: ${p.auth}\r\n` : '';
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  });
}

function targetOf(options: any, defaultPort: number): { host: string; port: number } {
  const host = String(options?.hostname ?? options?.host ?? '').replace(/^\[|\]$/g, '');
  const port = Number(options?.port) || defaultPort;
  return { host, port };
}

/** Plain http through the proxy: absolute-form request line, pooled connections to the proxy. */
export class ProxiedHttpAgent extends http.Agent {
  constructor(
    private readonly spec: UpstreamProxySpec,
    opts: http.AgentOptions = {},
    private readonly guard?: TargetGuard,
    private readonly alias?: (host: string) => string | undefined,
  ) {
    super(opts);
  }

  addRequest(req: http.ClientRequest, options: any): void {
    const { host, port } = targetOf(options, 80);
    const add = (o: any) => (http.Agent.prototype as any).addRequest.call(this, req, o);
    const alias = this.alias?.(host);
    if (!this.guard && (alias || isLoopbackHost(host) || bypassesProxy(this.spec, host, port))) {
      // Loopback / emulator-alias / noProxy targets connect directly, never via the upstream proxy (REVIEW-6 #10).
      return add(alias ? { ...options, host: alias, hostname: alias } : options);
    }
    if (this.guard && bypassesProxy(this.spec, host, port)) {
      // noProxy for a LAN client: directly, to the address the guard checked.
      this.guard(host, port).then(
        (ip) => add(ip ? { ...options, host: ip, hostname: ip } : options),
        (e: Error) => (req as unknown as { onSocket(s: unknown, err: Error): void }).onSocket(undefined, e),
      );
      return;
    }
    const r = req as http.ClientRequest & {
      _header?: string | null;
      _headerSent?: boolean;
      outputData?: Array<{ data: unknown }>;
      outputSize?: number;
      path: string;
    };
    const path = r.path.startsWith('/') ? r.path : `/${r.path}`;
    // `connectHost` is the address the guard checked (LAN clients): the upstream proxy is given that IP, not the
    // name, so it can't resolve it again to something else (REVIEW-6 #11). The Host header keeps the name.
    const send = (connectHost: string) => {
      const absolute = `http://${bracket(connectHost)}${port === 80 ? '' : `:${port}`}${path}`;
      r.path = absolute;
      if (typeof r._header === 'string') {
        // Headers given as an array are rendered in the ClientRequest constructor, before addRequest; and once the
        // request has been written to (end() while the guard was still checking), the rendered head is already
        // queued in outputData, waiting for a socket. Rewrite the request line wherever it is.
        const was = r._header;
        const eol = was.indexOf('\r\n');
        const auth = this.spec.auth ? `Proxy-Authorization: ${this.spec.auth}\r\n` : '';
        r._header = `${r.method} ${absolute} HTTP/1.1\r\n${auth}${was.slice(eol + 2)}`;
        const first = r.outputData?.[0];
        if (r._headerSent && first && typeof first.data === 'string' && first.data.startsWith(was)) {
          first.data = r._header + first.data.slice(was.length);
          if (typeof r.outputSize === 'number') r.outputSize += r._header.length - was.length;
        } else if (r._headerSent) {
          return (req as unknown as { onSocket(s: unknown, err: Error): void }).onSocket(
            undefined,
            new Error('Flutter Intercept: could not address the request to the upstream proxy (incompatible Node version)'),
          );
        }
      } else {
        if (this.spec.auth) r.setHeader('proxy-authorization', this.spec.auth);
        if (!r.getHeader('host')) r.setHeader('host', `${bracket(host)}${port === 80 ? '' : `:${port}`}`);
      }
      const proxied = { ...options, host: this.spec.host, hostname: this.spec.host, port: this.spec.port, servername: undefined };
      delete proxied.lookup; // mockttp's lookup is for the target, the proxy's name resolves normally
      add(proxied);
    };
    if (!this.guard) return send(host);
    this.guard(host, port).then(
      (ip) => send(ip ?? host),
      // Like a failed createConnection in Node's own Agent: error + close on the request.
      (e: Error) => (req as unknown as { onSocket(s: unknown, err: Error): void }).onSocket(undefined, e),
    );
  }
}

/** https (and wss) through a CONNECT tunnel: TLS to the real server inside it. */
export class TunnelHttpsAgent extends https.Agent {
  constructor(
    private readonly spec: UpstreamProxySpec,
    opts: https.AgentOptions = {},
    private readonly guard?: TargetGuard,
    private readonly alias?: (host: string) => string | undefined,
  ) {
    super(opts);
  }

  override createConnection(options: any, cb?: any): any {
    const { host, port } = targetOf(options, 443);
    const alias = this.alias?.(host);
    if (!this.guard && (alias || isLoopbackHost(host) || bypassesProxy(this.spec, host, port))) {
      // Direct (REVIEW-6 #10, noProxy); an alias still verifies the certificate against the name the app used.
      const direct = { ...options, host: alias ?? host, hostname: alias ?? host };
      if (alias && !options.checkServerIdentity) direct.checkServerIdentity = (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(host, cert);
      return (https.Agent.prototype as any).createConnection.call(this, direct, cb);
    }
    if (this.guard && bypassesProxy(this.spec, host, port)) {
      // noProxy for a LAN client: TLS directly to the checked address, verified against the name.
      this.guard(host, port).then(
        (ip) => {
          const to = ip ?? host;
          const direct = { ...options, host: to, hostname: to };
          if (!direct.servername && !net.isIP(host)) direct.servername = host;
          if (!options.checkServerIdentity) direct.checkServerIdentity = (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(host, cert);
          let s: unknown;
          try {
            s = (https.Agent.prototype as any).createConnection.call(this, direct);
          } catch (e) {
            return cb?.(e);
          }
          cb?.(null, s);
        },
        (e: Error) => cb?.(e),
      );
      return undefined;
    }
    const open = (connectHost: string) =>
      connectTunnel(this.spec, connectHost, port, (err, socket) => {
        if (err || !socket) return cb?.(err ?? new Error('no tunnel'));
        const tlsOpts: tls.ConnectionOptions = { ...options, socket, host };
        delete (tlsOpts as any).port;
        delete (tlsOpts as any).lookup;
        if (!tlsOpts.servername && !net.isIP(host)) tlsOpts.servername = host;
        if (this.spec.ignoreCertErrors) tlsOpts.rejectUnauthorized = false;
        let t: tls.TLSSocket;
        try {
          t = tls.connect(tlsOpts);
        } catch (e) {
          socket.destroy();
          return cb?.(e);
        }
        socket.resume();
        cb?.(null, t);
      });
    const fallback = this.alias?.(host) ?? host;
    if (!this.guard) open(fallback);
    else this.guard(host, port).then((ip) => open(ip ?? fallback), (e: Error) => cb?.(e));
    return undefined;
  }
}

/** ws:// upgrades through a CONNECT tunnel (plain bytes inside it). */
export class TunnelHttpAgent extends http.Agent {
  constructor(
    private readonly spec: UpstreamProxySpec,
    opts: http.AgentOptions = {},
    private readonly guard?: TargetGuard,
    private readonly alias?: (host: string) => string | undefined,
  ) {
    super(opts);
  }

  override createConnection(options: any, cb?: any): any {
    const { host, port } = targetOf(options, 80);
    const alias = this.alias?.(host);
    if (!this.guard && (alias || isLoopbackHost(host) || bypassesProxy(this.spec, host, port))) {
      return (http.Agent.prototype as any).createConnection.call(this, { ...options, host: alias ?? host, hostname: alias ?? host }, cb);
    }
    if (this.guard && bypassesProxy(this.spec, host, port)) {
      this.guard(host, port).then(
        (ip) => {
          let s: unknown;
          try {
            s = (http.Agent.prototype as any).createConnection.call(this, { ...options, host: ip ?? host, hostname: ip ?? host });
          } catch (e) {
            return cb?.(e);
          }
          cb?.(null, s);
        },
        (e: Error) => cb?.(e),
      );
      return undefined;
    }
    const open = (connectHost: string) =>
      connectTunnel(this.spec, connectHost, port, (err, socket) => {
        if (err || !socket) return cb?.(err ?? new Error('no tunnel'));
        socket.resume();
        cb?.(null, socket);
      });
    const fallback = this.alias?.(host) ?? host;
    if (!this.guard) open(fallback);
    else this.guard(host, port).then((ip) => open(ip ?? fallback), (e: Error) => cb?.(e));
    return undefined;
  }
}

export interface UpstreamAgents {
  spec: UpstreamProxySpec;
  http: http.Agent;
  https: https.Agent;
  /** Fresh, unpooled agent for a WebSocket upgrade. */
  ws(secure: boolean): http.Agent;
}

export function createUpstreamAgents(spec: UpstreamProxySpec, guard?: TargetGuard, alias?: (host: string) => string | undefined): UpstreamAgents {
  return {
    spec,
    http: new ProxiedHttpAgent(spec, keepAliveOptions(), guard, alias),
    https: new TunnelHttpsAgent(spec, keepAliveOptions(), guard, alias),
    ws: (secure) => (secure ? new TunnelHttpsAgent(spec, {}, guard, alias) : new TunnelHttpAgent(spec, {}, guard, alias)),
  };
}

/**
 * Stop reusing an agent's connections without breaking requests in flight: idle sockets close now, busy ones
 * close when their request ends.
 */
export function retireAgents(a: UpstreamAgents | undefined): void {
  if (!a) return;
  for (const agent of [a.http, a.https]) {
    (agent as unknown as { keepSocketAlive: () => boolean }).keepSocketAlive = () => false;
    for (const list of Object.values(agent.freeSockets)) for (const s of list ?? []) s.destroy();
  }
}
