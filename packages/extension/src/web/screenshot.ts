/**
 * Flutter Web screenshots (CONTRACTS §13.8, §14.7): `Page.captureScreenshot` over the Chrome DevTools Protocol of the
 * debug Chrome/Edge flutter_tools started. The provider gives that browser a known remote-debugging port
 * (`--web-browser-debug-port`, src/debug/rewrite.ts `webBrowserDebugPortOf`); we connect to it on 127.0.0.1 only.
 *
 * Loopback only: the target list comes from `http://127.0.0.1:<port>/json/list`, and the WebSocket URL is rebuilt as
 * `ws://127.0.0.1:<port>/devtools/page/<id>` from a validated id — the host in the browser's `webSocketDebuggerUrl` is
 * never used. vscode-free; uses the `ws` package (already a dependency) unless a `webSocket` factory is injected.
 */
import * as http from 'http';
import { MAX_SCREENSHOT_BYTES, pngSize, saveScreenshot } from '../screenshot';
import type { Screenshot, ScreenshotTarget } from '../screenshot/types';

export const DEVTOOLS_HOST = '127.0.0.1';
const LIST_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 15_000;
const MAX_LIST_BYTES = 1024 * 1024;
/** base64 of a 16 MB PNG plus the JSON envelope. */
const MAX_MESSAGE_BYTES = Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 64 * 1024;

/** Minimal WebSocket surface (the `ws` package, or a test fake). */
export interface CdpSocket {
  on(event: 'open', l: () => void): unknown;
  on(event: 'message', l: (data: unknown) => void): unknown;
  on(event: 'error', l: (e: Error) => void): unknown;
  on(event: 'close', l: () => void): unknown;
  send(data: string): void;
  close(): void;
}

export interface WebScreenshotDeps {
  /** The session's browser remote-debugging port: `webBrowserDebugPortOf(session.configuration)`. */
  devToolsPort(sessionId: string): number | undefined | Promise<number | undefined>;
  log(msg: string): void;
  /** Test seams. */
  getJson?(url: string): Promise<unknown>;
  webSocket?(url: string): CdpSocket;
  now?(): Date;
}

/** `Screenshot` with the CDP method (CONTRACTS §13.8 `method` gains `'devtools'`). */
export type WebScreenshot = Omit<Screenshot, 'method'> & { method: 'devtools' };

export interface CdpTarget {
  id: string;
  type?: string;
  url?: string;
}

function isLoopbackHttp(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(u.hostname));
  } catch {
    return false;
  }
}

/**
 * The page to capture: a `page` target whose id is safe to put in a URL; the app on a loopback origin first (the dev
 * server), else any other http(s) page (e.g. `--web-hostname` on a LAN address). DevTools / chrome:// pages never.
 */
export function pickTarget(list: unknown): CdpTarget | undefined {
  const pages = (Array.isArray(list) ? list : [])
    .filter((t): t is CdpTarget => !!t && typeof t === 'object' && typeof (t as CdpTarget).id === 'string')
    .filter((t) => t.type === 'page' && /^[A-Za-z0-9_-]{1,128}$/.test(t.id));
  return pages.find((t) => isLoopbackHttp(t.url)) ?? pages.find((t) => typeof t.url === 'string' && /^https?:\/\//i.test(t.url));
}

function checkPort(port: unknown): number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('no browser debug port for this session');
  return port;
}

/** GET a JSON document from 127.0.0.1 only (≤ 1 MB, 5 s). */
export function getLoopbackJson(url: string): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== 'http:' || u.hostname !== DEVTOOLS_HOST) return Promise.reject(new Error('DevTools endpoint must be http://127.0.0.1'));
  return new Promise((resolve, reject) => {
    const req = http.get({ host: DEVTOOLS_HOST, port: Number(u.port), path: u.pathname + u.search, timeout: LIST_TIMEOUT_MS, headers: { host: `${DEVTOOLS_HOST}:${u.port}` } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`DevTools /json/list: HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_LIST_BYTES) {
          req.destroy(new Error('DevTools /json/list: response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('DevTools /json/list: not JSON'));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('DevTools /json/list: timeout')));
    req.on('error', reject);
  });
}

function defaultWebSocket(url: string): CdpSocket {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const WS = require('ws') as new (url: string, opts: Record<string, unknown>) => CdpSocket;
  // No Origin header (Chrome only checks --remote-allow-origins when one is sent); no redirects; bounded messages.
  return new WS(url, { maxPayload: MAX_MESSAGE_BYTES, followRedirects: false, perMessageDeflate: false, handshakeTimeout: LIST_TIMEOUT_MS });
}

function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

/** One CDP call on a fresh connection to the page; resolves with `result`. */
function cdpCall(socket: CdpSocket, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err: Error | undefined, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`${method}: timeout (is the browser window minimized or the tab hidden?)`)), timeoutMs);
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on('message', (data) => {
      let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        msg = JSON.parse(messageText(data));
      } catch {
        return;
      }
      if (msg.id !== 1) return; // events
      if (msg.error) finish(new Error(`${method}: ${String(msg.error.message ?? 'error').slice(0, 200)}`));
      else finish(undefined, (msg.result && typeof msg.result === 'object' ? msg.result : {}) as Record<string, unknown>);
    });
    socket.on('error', (e) => finish(new Error(`DevTools connection: ${e.message}`)));
    socket.on('close', () => finish(new Error('DevTools connection closed')));
  });
}

/** PNG of the app's page in the browser listening for DevTools on 127.0.0.1:`port`. */
export async function captureWebPng(port: number, deps: Pick<WebScreenshotDeps, 'getJson' | 'webSocket'> = {}): Promise<Buffer> {
  checkPort(port);
  const list = await (deps.getJson ?? getLoopbackJson)(`http://${DEVTOOLS_HOST}:${port}/json/list`);
  const target = pickTarget(list);
  if (!target) throw new Error('no app page in the debug browser');
  const socket = (deps.webSocket ?? defaultWebSocket)(`ws://${DEVTOOLS_HOST}:${port}/devtools/page/${target.id}`);
  const result = await cdpCall(socket, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, CAPTURE_TIMEOUT_MS);
  const b64 = result.data;
  if (typeof b64 !== 'string' || !b64) throw new Error('Page.captureScreenshot: no image');
  if (b64.length > Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 4) throw new Error('Page.captureScreenshot: image larger than 16 MB');
  const png = Buffer.from(b64, 'base64');
  if (!pngSize(png)) throw new Error('Page.captureScreenshot: not a PNG');
  return png;
}

/**
 * CONTRACTS §13.8 for Flutter Web sessions (`deviceKind(target.deviceId) === 'web'`): captures the app's page over CDP
 * and saves it like every other screenshot (`saveScreenshot`, 0600 under `.dart_tool/flutter_intercept/screenshots/`).
 */
export async function webScreenshot(target: ScreenshotTarget, deps: WebScreenshotDeps): Promise<WebScreenshot> {
  const port = await deps.devToolsPort(target.sessionId);
  if (port === undefined) {
    throw new Error(
      'Could not take a screenshot of this web app: its browser has no known debug port (only Chrome / Edge sessions started with Flutter Intercept on).',
    );
  }
  let png: Buffer;
  try {
    png = await captureWebPng(checkPort(port), deps);
  } catch (e) {
    const why = String((e as Error)?.message ?? e).replace(/[\r\n\t]+/g, ' ').slice(0, 300);
    throw new Error(`Could not take a screenshot of this web app (${why}).`);
  }
  const takenAt = (deps.now ?? (() => new Date()))();
  const size = pngSize(png);
  const file = await saveScreenshot(target.projectRoot, png, takenAt);
  deps.log(`screenshot: devtools, ${size ? `${size.width}×${size.height}, ` : ''}${png.length} bytes`);
  return { path: file, png, width: size?.width, height: size?.height, takenAt: takenAt.getTime(), method: 'devtools' };
}
