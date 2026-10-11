/**
 * Traffic UI server (CONTRACTS §15.1, §15.2, §15.4): loopback only, random port. The UI opens in JCEF (IntelliJ IDEA)
 * or, in Android Studio (no JCEF), in the system browser, so the address-bar URL must be harmless in history:
 *
 *   GET /?t=<one-time token>  issued by `issueUrl()` (plugin `uiUrl` / `init`): 32 random bytes, valid 60 s, single use.
 *                             Exchanged for a session cookie (`HttpOnly; SameSite=Strict; Path=/`, random per browser
 *                             session) and a 302 to `/`. Used / expired / unknown → 403 "open it again from the IDE".
 *   GET /                     the webview page (CSP of §4 + `connect-src ws://127.0.0.1:<port>`) — needs the cookie
 *   GET /webview.js|webview.css|theme.css   the bundle and the IDE theme stylesheet — need the cookie
 *   GET /ws                   WebSocket upgrade carrying HostMsg / ViewMsg JSON (one message per frame) — needs the
 *                             cookie or `?t=<ws token>` (embedded in the page as `window.__FI_WS__`, never in the
 *                             address bar; one per sidecar run)
 *
 * Every request also needs `Host: 127.0.0.1:<port>` exactly and either no `Origin` or exactly
 * `http://127.0.0.1:<port>` (the WebSocket upgrade must carry that Origin); anything else → 403. Only GET/HEAD.
 * Responses are `no-store`, `nosniff`, `Referrer-Policy: no-referrer` and `frame-ancestors 'none'`. Tokens and
 * cookies are never logged.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { themeCss, vscodeBodyClass, type IdeTheme } from './theme';

export const UI_HOST = '127.0.0.1';
const MAX_CLIENTS = 16;
const MAX_WS_PAYLOAD = 16 * 1024 * 1024;
/** A client that can't keep up (this much unsent) is dropped; it reconnects and gets a fresh snapshot. */
const MAX_BUFFERED = 64 * 1024 * 1024;

/** What a connected view talks to (the InterceptController). */
export interface UiController {
  attach(sink: (msg: unknown) => void): () => void;
  handle(raw: unknown, reply: (msg: unknown) => void): Promise<void>;
}

export interface UiServerOptions {
  controller: UiController;
  /** Folder holding webview.js and webview.css. */
  webviewDir: string;
  theme(): IdeTheme;
  log?(msg: string): void;
  /** Tests: a fixed WebSocket token. */
  token?: string;
  /** Tests: clock (ms). */
  now?(): number;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenOk(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const ONE_TIME_TTL_MS = 60_000;
const MAX_ONE_TIME = 64;
const MAX_SESSIONS = 64;

/** The 403 page for a used, expired or unknown link. */
export const EXPIRED_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer"><title>Flutter Intercept</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2em;">
<p>This Flutter Intercept link was already used or has expired.</p>
<p>Open the traffic view again from the IDE (Flutter Intercept tool window → Open Traffic in Browser).</p>
</body></html>`;

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function nonce(): string {
  return randomBytes(24).toString('base64url');
}

export function contentSecurityPolicy(origin: string, n: string): string {
  const ws = origin.replace(/^http:/, 'ws:');
  return [
    "default-src 'none'",
    `style-src ${origin}`,
    `script-src 'nonce-${n}'`,
    `img-src ${origin} data:`,
    `font-src ${origin}`,
    `connect-src ${ws}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The page. `__FI_WS__` is set by a nonce'd script before webview.js runs. */
export function pageHtml(args: { origin: string; wsToken: string; nonce: string; theme: IdeTheme }): string {
  const { origin, wsToken, nonce: n, theme } = args;
  const wsUrl = `${origin.replace(/^http:/, 'ws:')}/ws?t=${encodeURIComponent(wsToken)}`;
  const bodyClass = ['fi-ide', theme === 'light' ? '' : 'ide-dark', vscodeBodyClass(theme)].filter(Boolean).join(' ');
  return `<!DOCTYPE html>
<html lang="en" data-fi-theme="${theme}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(origin, n)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <link rel="stylesheet" href="${origin}/theme.css">
  <link rel="stylesheet" href="${origin}/webview.css">
  <title>Flutter Intercept</title>
</head>
<body class="${bodyClass}">
  <div id="root"></div>
  <script nonce="${n}">window.__FI_WS__ = ${JSON.stringify(wsUrl)};</script>
  <script nonce="${n}" src="${origin}/webview.js"></script>
</body>
</html>`;
}

export class UiServer {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  /** The WebSocket token embedded in the page (`__FI_WS__`). A secret: never log it. */
  readonly token: string;
  private readonly oneTime = new Map<string, number>(); // token → expiry
  private readonly sessions = new Set<string>();
  private readonly now: () => number;
  private origin = '';
  private assets = new Map<string, { body: Buffer; type: string }>();

  constructor(private readonly o: UiServerOptions) {
    this.token = o.token ?? newToken();
    this.now = o.now ?? Date.now;
  }

  private get cookieName(): string {
    return `fi_session_${this.port ?? 0}`;
  }

  /** A fresh one-time URL `http://127.0.0.1:<port>/?t=<token>` (60 s, single use). A secret until used: never log it. */
  issueUrl(): string {
    const now = this.now();
    for (const [t, exp] of this.oneTime) if (exp <= now) this.oneTime.delete(t);
    while (this.oneTime.size >= MAX_ONE_TIME) this.oneTime.delete(this.oneTime.keys().next().value as string);
    const t = newToken();
    this.oneTime.set(t, now + ONE_TIME_TTL_MS);
    return `${this.origin}/?t=${t}`;
  }

  /** Consumes a one-time token; true when it was valid. */
  private redeem(t: string | null): boolean {
    if (!t) return false;
    let hit: string | undefined;
    for (const k of this.oneTime.keys()) if (tokenOk(t, k)) hit = k;
    if (!hit) return false;
    const exp = this.oneTime.get(hit)!;
    this.oneTime.delete(hit);
    return exp > this.now();
  }

  private hasSession(req: http.IncomingMessage): boolean {
    const v = cookieValue(req.headers.cookie, this.cookieName);
    if (!v) return false;
    for (const s of this.sessions) if (tokenOk(v, s)) return true;
    return false;
  }

  private newSession(): string {
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.values().next().value as string);
    const id = newToken();
    this.sessions.add(id);
    return id;
  }

  get port(): number | undefined {
    const a = this.server?.address() as AddressInfo | null | undefined;
    return a && typeof a === 'object' ? a.port : undefined;
  }


  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<string> {
    this.loadAssets();
    const server = http.createServer((req, res) => this.handle(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.maxHeadersCount = 100;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, UI_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address() as AddressInfo;
    if (addr.address !== UI_HOST) {
      server.close();
      throw new Error(`UI server bound to ${addr.address}, not ${UI_HOST}`);
    }
    this.server = server;
    this.origin = `http://${UI_HOST}:${addr.port}`;
    this.o.log?.(`traffic UI server on ${UI_HOST}:${addr.port}`);
    return this.issueUrl();
  }

  /** Sends a raw JSON message to every connected view. */
  broadcast(msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) this.send(ws, text);
  }

  async close(): Promise<void> {
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.wss?.close();
    const s = this.server;
    this.server = undefined;
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private loadAssets(): void {
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(this.o.webviewDir, f));
      } catch {
        this.o.log?.(`traffic UI: ${f} is missing from ${this.o.webviewDir}`);
        return Buffer.from(f.endsWith('.js') ? 'document.body.textContent = "Flutter Intercept: the traffic UI bundle is missing.";' : '');
      }
    };
    this.assets.set('/webview.js', { body: read('webview.js'), type: 'text/javascript; charset=utf-8' });
    this.assets.set('/webview.css', { body: read('webview.css'), type: 'text/css; charset=utf-8' });
  }

  /** Host and Origin checks shared by HTTP and the upgrade. Returns the parsed URL, or undefined (refused). */
  private check(req: http.IncomingMessage, requireOrigin: boolean): URL | undefined {
    const port = this.port;
    if (!port || req.headers.host !== `${UI_HOST}:${port}`) return undefined;
    const origin = req.headers.origin;
    if (origin !== undefined ? origin !== this.origin : requireOrigin) return undefined;
    try {
      return new URL(req.url ?? '/', this.origin);
    } catch {
      return undefined;
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const base: Record<string, string> = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    };
    const send = (status: number, body: string | Buffer = '', type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) => {
      const buf = typeof body === 'string' ? Buffer.from(body) : body;
      res.writeHead(status, { ...base, 'content-type': type, 'content-length': String(buf.length), ...extra });
      res.end(req.method === 'HEAD' ? undefined : buf);
    };
    const u = this.check(req, false);
    if (!u) return send(403, 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed', undefined, { allow: 'GET, HEAD' });
    const p = u.pathname;
    if (u.searchParams.has('t')) {
      // CONTRACTS §15.4: one-time link → session cookie → clean URL.
      if (p !== '/' || !this.redeem(u.searchParams.get('t'))) return send(403, EXPIRED_PAGE, 'text/html; charset=utf-8');
      const cookie = `${this.cookieName}=${this.newSession()}; HttpOnly; SameSite=Strict; Path=/`;
      return send(302, '', 'text/plain; charset=utf-8', { location: '/', 'set-cookie': cookie });
    }
    if (!this.hasSession(req)) return send(403, EXPIRED_PAGE, 'text/html; charset=utf-8');
    if (p === '/' || p === '/index.html') {
      const n = nonce();
      const csp = contentSecurityPolicy(this.origin, n);
      return send(200, pageHtml({ origin: this.origin, wsToken: this.token, nonce: n, theme: this.o.theme() }), 'text/html; charset=utf-8', {
        'content-security-policy': csp,
      });
    }
    if (p === '/theme.css') return send(200, themeCss(), 'text/css; charset=utf-8');
    const asset = this.assets.get(p);
    if (asset) return send(200, asset.body, asset.type);
    send(404, 'Not Found');
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const u = this.check(req, true);
    if (!u || u.pathname !== '/ws' || !(this.hasSession(req) || tokenOk(u.searchParams.get('t'), this.token))) return refuse(403, 'Forbidden');
    if (this.clients.size >= MAX_CLIENTS) return refuse(503, 'Service Unavailable');
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.connected(ws));
  }

  private send(ws: WebSocket, text: string): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      this.o.log?.('traffic UI: a view fell too far behind; disconnecting it (it reconnects with a fresh snapshot)');
      ws.terminate();
      return;
    }
    ws.send(text);
  }

  private connected(ws: WebSocket): void {
    this.clients.add(ws);
    const sink = (msg: unknown) => {
      let text: string;
      try {
        text = JSON.stringify(msg);
      } catch (e) {
        this.o.log?.(`traffic UI: could not serialise ${String((msg as { type?: unknown })?.type)}: ${(e as Error).message}`);
        return;
      }
      this.send(ws, text);
    };
    const detach = this.o.controller.attach(sink);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if ((msg as { type?: unknown }).type === 'openInNewWindow') return; // VS Code only
      void this.o.controller.handle(msg, sink).catch((e: unknown) => this.o.log?.(`traffic UI: message failed: ${(e as Error)?.message ?? e}`));
    });
    const gone = () => {
      detach();
      this.clients.delete(ws);
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }
}
