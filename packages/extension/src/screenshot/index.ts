/**
 * App screenshots for agents (CONTRACTS §13.8, docs/spikes/screenshot.md). vscode-free: the host passes
 * `callService` (src/vm `VmWatcherHandle.callService`), `exec` (argument arrays, no shell) and `log`.
 *
 * Order:
 * 1. VM service, through the session's debug adapter: the widget inspector's `ext.flutter.inspector.screenshot` of
 *    the root widget (renders the app's last frame in the framework, works with Impeller on Android, iOS simulator
 *    and macOS; Flutter content only — no system UI or platform views), then the engine's `_flutter.screenshot`
 *    (fails with Impeller: "Could not capture image screenshot", kept for Skia builds).
 * 2. The device's own tool: `adb -s <id> exec-out screencap -p` (Android), `xcrun simctl io <udid> screenshot`
 *    (iOS simulator); physical iPhones (CONTRACTS §14.7): `xcrun devicectl device capture screenshot` (Xcode's
 *    CoreDevice tool, Xcode 27+), then libimobiledevice's `idevicescreenshot` when it is installed (PATH, Homebrew).
 *    Flutter's bundled copy is not used: it is x86_64-only and needs Rosetta.
 * 3. Otherwise (macOS / Linux / Windows desktop, web): a clear "not supported" error.
 * Saved under `<project>/.dart_tool/flutter_intercept/screenshots/<timestamp>.png` (realpath-checked folders,
 * `wx`, ≤ 16 MB). App screens show personal data and one-time codes (REVIEW-7 #13): files 0600 in a 0700 folder,
 * only the newest `MAX_SCREENSHOTS` kept.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { locateAdb } from '../adb';
import { ensureDirInside } from '../agent/har';
import type { Screenshot, ScreenshotDeps, ScreenshotTarget, TakeScreenshot } from './types';

export type { Screenshot, ScreenshotDeps, ScreenshotTarget, TakeScreenshot } from './types';

export const SCREENSHOT_DIR = path.join('.dart_tool', 'flutter_intercept', 'screenshots');
export const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
/** Screenshots kept in the folder; older ones are deleted after each new one. */
export const MAX_SCREENSHOTS = 50;
/** Names we write (`<ISO timestamp with - for : and .>[-n].png`): the only files retention ever deletes. */
const SCREENSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d{1,4})?\.png$/;
/** Longest edge of a VM-service screenshot, px (the device's physical resolution when smaller). */
export const MAX_VM_EDGE = 2000;
const VM_CALL_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 20_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OBJECT_GROUP = 'flutter-intercept-screenshot';
/** Where `idevicescreenshot` may be when VS Code was started from the Dock (minimal PATH). */
const IDEVICE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
type Method = Screenshot['method'];

/** Thrown when neither the VM service nor a device tool can take one (the message says why). */
export class ScreenshotUnsupportedError extends Error {}

/** Width and height from the PNG IHDR chunk; undefined when `buf` is not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

export type DeviceKind = 'android' | 'ios-simulator' | 'ios-device' | 'desktop' | 'web' | 'unknown';

/**
 * What a Flutter device id is. Simulator UDIDs are UUIDs; physical iPhones use `00008xxx-<16 hex>` or 40 hex;
 * anything else that is a plausible adb serial (`emulator-5554`, `R58M…`, `192.168.1.5:5555`, mDNS names) is
 * treated as Android. Ids that could be read as an option (leading `-`) or contain odd characters are `unknown`.
 */
export function deviceKind(deviceId: string | undefined): DeviceKind {
  if (!deviceId) return 'unknown';
  const id = deviceId.trim();
  if (/^(macos|linux|windows)$/i.test(id)) return 'desktop';
  if (/^(chrome|edge|web-server|firefox|safari)$/i.test(id)) return 'web';
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(id)) return 'ios-simulator';
  if (/^[0-9A-F]{8}-[0-9A-F]{16}$/i.test(id) || /^[0-9a-f]{40}$/i.test(id)) return 'ios-device';
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return 'android';
  return 'unknown';
}

const kindLabel: Record<DeviceKind, string> = {
  android: 'this Android device',
  'ios-simulator': 'this iOS simulator',
  'ios-device': 'a physical iOS device',
  desktop: 'a desktop app',
  web: 'a web app',
  unknown: 'this device',
};

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function decodePng(b64: unknown, what: string): Buffer {
  if (typeof b64 !== 'string' || !b64) throw new Error(`${what}: no image`);
  if (b64.length > Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3) + 4) throw new Error(`${what}: image larger than 16 MB`);
  const png = Buffer.from(b64, 'base64');
  if (!pngSize(png)) throw new Error(`${what}: not a PNG`);
  return png;
}

/** The VM service route (Dart-Code `callService`). Throws with the reason when it can't. */
async function viaVmService(sessionId: string, callService: NonNullable<ScreenshotDeps['callService']>): Promise<Buffer> {
  const call = (method: string, params?: Record<string, unknown>) => withTimeout(Promise.resolve(callService(sessionId, method, params)), VM_CALL_TIMEOUT_MS, method);
  const vm = (await call('getVM')) as { isolates?: { id?: unknown; name?: unknown; isSystemIsolate?: unknown }[] } | undefined;
  const isolates = (Array.isArray(vm?.isolates) ? vm!.isolates : []).filter((i) => typeof i?.id === 'string' && i.isSystemIsolate !== true);
  const main = isolates.find((i) => i.name === 'main') ?? isolates[0];
  const errors: string[] = [];
  if (main) {
    const isolateId = main.id as string;
    let grouped = false;
    try {
      const root = (await call('ext.flutter.inspector.getRootWidget', { isolateId, objectGroup: OBJECT_GROUP })) as { result?: { valueId?: unknown } } | undefined;
      grouped = true;
      const id = root?.result?.valueId;
      if (typeof id !== 'string' || !/^[\w.:-]{1,100}$/.test(id)) throw new Error('no root widget (is the app running a frame?)');
      // At the root the image is in physical pixels: maxPixelRatio 1 keeps the device resolution, width / height cap it.
      const shot = (await call('ext.flutter.inspector.screenshot', {
        isolateId,
        id,
        width: String(MAX_VM_EDGE),
        height: String(MAX_VM_EDGE),
        maxPixelRatio: '1',
        margin: '0',
        debugPaint: 'false',
      })) as { result?: unknown } | undefined;
      return decodePng(shot?.result, 'ext.flutter.inspector.screenshot');
    } catch (e) {
      errors.push(errText(e));
    } finally {
      if (grouped) void call('ext.flutter.inspector.disposeGroup', { isolateId, objectGroup: OBJECT_GROUP }).catch(() => undefined);
    }
  } else {
    errors.push('no isolate');
  }
  try {
    const r = (await call('_flutter.screenshot')) as { screenshot?: unknown } | undefined;
    return decodePng(r?.screenshot, '_flutter.screenshot');
  } catch (e) {
    errors.push(errText(e));
  }
  throw new Error(errors.join('; '));
}

async function viaAdb(deviceId: string, deps: ScreenshotDeps, adb: string): Promise<Buffer> {
  const { stdout } = await deps.exec(adb, ['-s', deviceId, 'exec-out', 'screencap', '-p'], { timeoutMs: TOOL_TIMEOUT_MS, maxBuffer: MAX_SCREENSHOT_BYTES + 1 });
  const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (png.length > MAX_SCREENSHOT_BYTES) throw new Error('adb screencap: image larger than 16 MB');
  if (!pngSize(png)) throw new Error('adb screencap: not a PNG');
  return png;
}

async function viaSimctl(udid: string, deps: ScreenshotDeps): Promise<Buffer> {
  return inTempDir(async (tmp) => {
    const file = path.join(tmp, 'screenshot.png');
    await deps.exec('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', file], { timeoutMs: TOOL_TIMEOUT_MS });
    return readToolPng(file, 'simctl');
  });
}

/** Reads a PNG a tool wrote into `file` (regular file, ≤ 16 MB, PNG signature). */
async function readToolPng(file: string, what: string): Promise<Buffer> {
  const st = await fs.promises.lstat(file);
  if (!st.isFile()) throw new Error(`${what}: no screenshot file`);
  if (st.size > MAX_SCREENSHOT_BYTES) throw new Error(`${what}: image larger than 16 MB`);
  const png = await fs.promises.readFile(file);
  if (!pngSize(png)) throw new Error(`${what}: not a PNG`);
  return png;
}

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fi-shot-'));
  try {
    return await fn(tmp);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Physical iPhone through Xcode's CoreDevice (`devicectl device capture screenshot`, Xcode 27+). */
async function viaDevicectl(udid: string, deps: ScreenshotDeps): Promise<Buffer> {
  return inTempDir(async (tmp) => {
    const file = path.join(tmp, 'screenshot.png');
    await deps.exec('xcrun', ['devicectl', 'device', 'capture', 'screenshot', '--quiet', '--device', udid, '--destination', file], { timeoutMs: TOOL_TIMEOUT_MS });
    return readToolPng(file, 'devicectl');
  });
}

export interface LocateToolEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
}

/** `idevicescreenshot` on PATH or in the Homebrew folders; undefined when not installed (never Flutter's x86_64 copy). */
export function locateIdeviceScreenshot(le: LocateToolEnv = { env: process.env, platform: process.platform, exists: isFile }): string | undefined {
  if (le.platform === 'win32') return undefined;
  const dirs = [...(le.env.PATH ?? '').split(':').filter((d) => d && path.isAbsolute(d) && !/[/\\]bin[/\\]cache[/\\]artifacts[/\\]/.test(d)), ...IDEVICE_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, 'idevicescreenshot');
    if (le.exists(candidate)) return candidate;
  }
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Physical iPhone through libimobiledevice (needs the developer disk image mounted, as after any Xcode run). */
async function viaIdeviceScreenshot(udid: string, deps: ScreenshotDeps, tool: string): Promise<Buffer> {
  return inTempDir(async (tmp) => {
    const file = path.join(tmp, 'screenshot.png');
    await deps.exec(tool, ['-u', udid, file], { timeoutMs: TOOL_TIMEOUT_MS });
    return readToolPng(file, 'idevicescreenshot'); // old iOS versions answer TIFF: "not a PNG"
  });
}

/** Sort key: timestamp, then the same-millisecond counter (`x.png` = 1, `x-2.png` = 2, …). */
function screenshotOrder(name: string): [string, number] {
  const m = /^(.*?Z)(?:-(\d+))?\.png$/.exec(name);
  return m ? [m[1], m[2] ? Number(m[2]) : 1] : [name, 0];
}

/** Deletes all but the newest `keep` screenshots we wrote (regular files with our name pattern only). */
export async function pruneScreenshots(dir: string, keep: number = MAX_SCREENSHOTS): Promise<number> {
  const names = (await fs.promises.readdir(dir)).filter((n) => SCREENSHOT_NAME.test(n));
  names.sort((a, b) => {
    const [ta, na] = screenshotOrder(a);
    const [tb, nb] = screenshotOrder(b);
    return ta < tb ? -1 : ta > tb ? 1 : na - nb;
  });
  let removed = 0;
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    const file = path.join(dir, name);
    try {
      if (!(await fs.promises.lstat(file)).isFile()) continue;
      await fs.promises.unlink(file);
      removed++;
    } catch {
      /* gone meanwhile */
    }
  }
  return removed;
}

/**
 * Writes the PNG under `<projectRoot>/.dart_tool/flutter_intercept/screenshots/` (never replaces a file): mode 0600,
 * folder 0700, then keeps only the newest `MAX_SCREENSHOTS`.
 */
export async function saveScreenshot(projectRoot: string, png: Buffer, now: Date = new Date()): Promise<string> {
  if (png.length > MAX_SCREENSHOT_BYTES) throw new Error('screenshot larger than 16 MB');
  const dir = await ensureDirInside(projectRoot, SCREENSHOT_DIR);
  await fs.promises.chmod(dir, 0o700).catch(() => undefined); // best effort (no-op on Windows)
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stamp}.png` : `${stamp}-${n}.png`;
    try {
      await fs.promises.writeFile(path.join(dir, name), png, { flag: 'wx', mode: 0o600 });
      await pruneScreenshots(dir).catch(() => 0);
      return path.join(projectRoot, SCREENSHOT_DIR, name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw e;
    }
  }
}

export interface TakeScreenshotOptions {
  /** adb executable (default: `locateAdb()`, else `adb` on PATH). */
  adbPath?: string;
  /** `idevicescreenshot` (default: `locateIdeviceScreenshot()`); null = not installed (tests). */
  idevicePath?: string | null;
  /** Host platform (default `process.platform`): devicectl / idevicescreenshot only on macOS. */
  platform?: NodeJS.Platform;
  now?: () => Date;
}

export async function takeScreenshotWith(target: ScreenshotTarget, deps: ScreenshotDeps, opts: TakeScreenshotOptions = {}): Promise<Screenshot> {
  const now = opts.now ?? (() => new Date());
  const kind = deviceKind(target.deviceId);
  const deviceId = target.deviceId?.trim();
  const reasons: string[] = [];
  let png: Buffer | undefined;
  let method: Method | undefined;
  if (deps.callService) {
    try {
      png = await viaVmService(target.sessionId, deps.callService);
      method = 'vm-service';
    } catch (e) {
      reasons.push(`VM service: ${errText(e)}`);
      deps.log(`screenshot: VM service route failed (${errText(e)})`);
    }
  }
  if (!png && deviceId && kind === 'android') {
    try {
      png = await viaAdb(deviceId, deps, opts.adbPath ?? locateAdb() ?? 'adb');
      method = 'adb';
    } catch (e) {
      reasons.push(`adb: ${errText(e)}`);
    }
  } else if (!png && deviceId && kind === 'ios-simulator') {
    try {
      png = await viaSimctl(deviceId, deps);
      method = 'simctl';
    } catch (e) {
      reasons.push(`simctl: ${errText(e)}`);
    }
  } else if (!png && deviceId && kind === 'ios-device' && (opts.platform ?? process.platform) === 'darwin') {
    try {
      png = await viaDevicectl(deviceId, deps);
      method = 'devicectl';
    } catch (e) {
      reasons.push(`devicectl: ${errText(e)}`);
    }
    if (!png) {
      const tool = opts.idevicePath === null ? undefined : opts.idevicePath ?? locateIdeviceScreenshot();
      if (!tool) reasons.push('idevicescreenshot: not installed');
      else {
        try {
          png = await viaIdeviceScreenshot(deviceId, deps, tool);
          method = 'idevicescreenshot';
        } catch (e) {
          reasons.push(`idevicescreenshot: ${errText(e)}`);
        }
      }
    }
  }
  if (!png || !method) {
    const tool = kind === 'android' || kind === 'ios-simulator' || kind === 'ios-device';
    const why = reasons.length ? ` (${reasons.join('; ')})` : '';
    if (tool) throw new Error(`Could not take a screenshot of ${kindLabel[kind]}${why}.`);
    throw new ScreenshotUnsupportedError(
      `Screenshots of ${kindLabel[kind]} are not supported: only Android devices / emulators, iOS simulators and iPhones, or any app whose Flutter VM service can render one (debug sessions)${why}.`,
    );
  }
  const takenAt = now();
  const size = pngSize(png);
  const file = await saveScreenshot(target.projectRoot, png, takenAt);
  deps.log(`screenshot: ${method}, ${size ? `${size.width}×${size.height}, ` : ''}${png.length} bytes`);
  return { path: file, png, width: size?.width, height: size?.height, takenAt: takenAt.getTime(), method: method as Screenshot['method'] };
}

/** CONTRACTS §13.8 entry point. */
export const takeScreenshot: TakeScreenshot = (target, deps) => takeScreenshotWith(target, deps);
