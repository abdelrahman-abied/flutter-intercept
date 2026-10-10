/**
 * Flutter Web screenshots (CONTRACTS §13.8, §14.7): `Page.captureScreenshot` over the Chrome DevTools Protocol of the
 * debug Chrome/Edge flutter_tools started — of the app's page only.
 *
 * Finding that browser without trusting a port we chose (REVIEW-8 #10): src/web/browsers.ts lists the browser processes
 * flutter_tools started with this session's own browser flags, and accepts a DevTools port only when the listener on it
 * belongs to that process. Of that browser we capture only a page whose origin is the session's app URL (flutter_tools'
 * `app.webLaunchUrl`, forwarded by the debug adapter as `flutter.forwardedEvent`) — never another tab.
 *
 * Loopback only: everything goes to http/ws://127.0.0.1:<port>; the host in the browser's own URLs is never used.
 * vscode-free; uses the `ws` package (already a dependency) unless a `webSocket` factory is injected.
 */
import * as http from 'http';
import { MAX_SCREENSHOT_BYTES, pngSize, saveScreenshot } from '../screenshot';
import type { Screenshot, ScreenshotTarget } from '../screenshot/types';
import { BrowserDiscoveryDeps, browserFlagValues, Exec, listDebugBrowsers, listenerBelongsTo } from './browsers';

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
  /** The session's app URL (`app.webLaunchUrl`): track it with `webLaunchUrlOf` on the debug adapter's custom events. */
  appUrl(sessionId: string): string | undefined | Promise<string | undefined>;
  /** The session's recorded browser flags: `session.configuration.flutterInterceptWebFlags`. */
  webFlags(sessionId: string): unknown;
  /** Runs a tool with an argument array, no shell (the same `exec` as ScreenshotDeps). */
  exec: Exec;
  log(msg: string): void;
  /** Test seams. */
  platform?: NodeJS.Platform;
  uid?: number | null;
  procRoot?: string;
  getJson?(url: string): Promise<unknown>;
  webSocket?(url: string): CdpSocket;
  now?(): Date;
}

type LocateDeps = Pick<WebScreenshotDeps, 'exec' | 'getJson' | 'platform' | 'uid' | 'procRoot'>;

/**
 * The app URL in a debug adapter custom event (`vscode.debug.onDidReceiveDebugSessionCustomEvent`): flutter_tools'
 * `app.webLaunchUrl` forwarded as `flutter.forwardedEvent {event, params: {url, launched}}`. Loopback http(s) only.
 */
export function webLaunchUrlOf(e: { event?: unknown; body?: unknown } | undefined): string | undefined {
  if (!e || e.event !== 'flutter.forwardedEvent') return undefined;
  const body = e.body as { event?: unknown; params?: { url?: unknown } } | undefined;
  if (body?.event !== 'app.webLaunchUrl' || typeof body.params?.url !== 'string') return undefined;
  return loopbackOrigin(body.params.url) ? body.params.url : undefined;
}

/** `Screenshot` with the CDP method (CONTRACTS §13.8 `method` gains `'devtools'`). */
export type WebScreenshot = Omit<Screenshot, 'method'> & { method: 'devtools' };

export interface CdpTarget {
  id: string;
  type?: string;
  url?: string;
}

/** `http(s)://localhost|127.x.x.x|[::1][:port]` origin of `url`, else undefined. */
export function loopbackOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.hostname !== 'localhost' && u.hostname !== '[::1]' && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(u.hostname)) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** The `page` target showing the app (`origin` = the app URL's origin); never any other tab. Safe ids only. */
export function appPage(list: unknown, origin: string): CdpTarget | undefined {
  return (Array.isArray(list) ? list : [])
    .filter((t): t is CdpTarget => !!t && typeof t === 'object' && typeof (t as CdpTarget).id === 'string')
    .find((t) => t.type === 'page' && /^[A-Za-z0-9_-]{1,128}$/.test(t.id) && loopbackOrigin(t.url) === origin);
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

/** The verified debug browser (pid, DevTools port) and app page for this session, or an error saying why not. */
export async function locateAppPage(appUrl: string, webFlags: unknown, deps: LocateDeps): Promise<{ port: number; page: CdpTarget }> {
  const origin = loopbackOrigin(appUrl);
  if (!origin) throw new Error('the app URL is not a loopback http(s) URL');
  const flags = browserFlagValues(webFlags);
  if (!flags.length) throw new Error('this session was not started with Flutter Intercept\'s browser flags');
  const disco: BrowserDiscoveryDeps = { exec: deps.exec, platform: deps.platform, procRoot: deps.procRoot, ...('uid' in deps ? { uid: deps.uid } : {}) };
  const browsers = await listDebugBrowsers(flags, disco);
  if (!browsers.length) throw new Error('no debug browser started by flutter_tools for this session was found');
  const getJson = deps.getJson ?? getLoopbackJson;
  let unverified = 0;
  for (const b of browsers) {
    // The DevTools listener must be that browser process (never a process that took the port first).
    if (!(await listenerBelongsTo(b.pid, b.port, disco))) {
      unverified++;
      continue;
    }
    try {
      const page = appPage(await getJson(`http://${DEVTOOLS_HOST}:${b.port}/json/list`), origin);
      if (page) return { port: b.port, page };
    } catch {
      /* browser gone */
    }
  }
  if (unverified === browsers.length) throw new Error("the debug browser's DevTools port is not held by the browser itself");
  throw new Error(`the app's page (${origin}) is not open in the debug browser`);
}

/** PNG of the app's page (`appUrl`) in the debug browser flutter_tools started with `webFlags`. */
export async function captureWebPng(appUrl: string, webFlags: unknown, deps: LocateDeps & Pick<WebScreenshotDeps, 'webSocket'>): Promise<Buffer> {
  const { port, page } = await locateAppPage(appUrl, webFlags, deps);
  checkPort(port);
  const socket = (deps.webSocket ?? defaultWebSocket)(`ws://${DEVTOOLS_HOST}:${port}/devtools/page/${page.id}`);
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
  const appUrl = await deps.appUrl(target.sessionId);
  if (!appUrl) {
    throw new Error("Could not take a screenshot of this web app: its URL is not known yet (Chrome / Edge sessions only, once the app has started).");
  }
  let png: Buffer;
  try {
    png = await captureWebPng(appUrl, await deps.webFlags(target.sessionId), deps);
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
