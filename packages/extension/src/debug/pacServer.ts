/**
 * Flutter Web DIRECT fallback (CONTRACTS §14.7, docs/spikes/web.md "v0.8.0"): a tiny loopback HTTP server that serves
 * the PAC script the debug Chrome/Edge loads through `--proxy-pac-url=http://127.0.0.1:<pacPort>/flutter-intercept-<port>.pac`.
 *
 * Why a server: flutter_tools splits `--web-browser-flag` values on commas, so neither a `data:` PAC URL nor a
 * `--proxy-server=a,direct://` list survives; Chrome ignores `file://` PAC URLs (measured), and the proxy itself answers a
 * direct GET with a 500 (mockttp passthrough loop). The script returns `PROXY 127.0.0.1:<port>; DIRECT`, so when the proxy
 * stops mid-session the page keeps its network (DIRECT) instead of failing every request.
 *
 * vscode-free. Loopback only (binds 127.0.0.1, checks Host), GET/HEAD only, no request bodies, serves a script only for
 * the proxy port that is current right now (anything else 404 → Chrome goes DIRECT on its next PAC fetch).
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

export const PAC_HOST = '127.0.0.1';
const PAC_PATH = /^\/flutter-intercept-(\d{1,5})\.pac$/;

/**
 * The PAC script for a proxy port: loopback (dev server, DWDS, DevTools) DIRECT, everything else through the proxy and
 * DIRECT when it is unreachable. Port only: nothing secret, nothing user-controlled.
 */
export function pacScript(proxyPort: number): string {
  if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) throw new Error(`bad proxy port ${proxyPort}`);
  return [
    'function FindProxyForURL(url, host) {',
    '  if (host === "localhost" || dnsDomainIs(host, ".localhost") || host === "::1" || host === "[::1]" || shExpMatch(host, "127.*")) return "DIRECT";',
    `  return "PROXY ${PAC_HOST}:${proxyPort}; DIRECT";`,
    '}',
    '',
  ].join('\n');
}

/** What the provider needs: the PAC URL for a proxy port, or undefined (then it falls back to `--proxy-server`). */
export interface WebPacSource {
  urlFor(proxyPort: number): Promise<string | undefined>;
}

export interface PacServerOptions {
  /** The proxy port in use right now (undefined while the proxy is stopped): only its script is served. */
  currentPort(): number | undefined;
  log?(msg: string): void;
}

export class PacServer implements WebPacSource {
  private server?: http.Server;
  private listening?: Promise<number>;
  private disposed = false;

  constructor(private readonly opts: PacServerOptions) {}

  /** The PAC server's own port once listening. */
  get port(): number | undefined {
    const a = this.server?.address() as AddressInfo | null | undefined;
    return a && typeof a === 'object' ? a.port : undefined;
  }

  /** Starts the server once (random loopback port) and returns the PAC URL for `proxyPort`. Rejects if it can't listen. */
  async urlFor(proxyPort: number): Promise<string> {
    pacScript(proxyPort); // validates
    const port = await this.listen();
    return `http://${PAC_HOST}:${port}/flutter-intercept-${proxyPort}.pac`;
  }

  private listen(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error('PAC server disposed'));
    if (this.listening) return this.listening;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 50;
    this.server = server;
    this.listening = new Promise<number>((resolve, reject) => {
      server.once('error', (e) => {
        this.listening = undefined;
        this.server = undefined;
        reject(e);
      });
      server.listen(0, PAC_HOST, () => {
        server.unref(); // never keeps the extension host alive
        const port = (server.address() as AddressInfo).port;
        this.opts.log?.(`Flutter Web PAC server on ${PAC_HOST}:${port}`);
        resolve(port);
      });
    });
    return this.listening;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const send = (status: number, body = '', type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    // DNS-rebinding hygiene: only requests addressed to the loopback literal we handed out.
    if (req.headers.host !== `${PAC_HOST}:${this.port}`) return send(403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405);
    const m = PAC_PATH.exec((req.url ?? '').split('?')[0]);
    const port = m ? Number(m[1]) : NaN;
    const current = this.opts.currentPort();
    if (!m || current === undefined || port !== current) return send(404);
    send(200, pacScript(port), 'application/x-ns-proxy-autoconfig');
  }

  dispose(): void {
    this.disposed = true;
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = undefined;
    this.listening = undefined;
  }
}
