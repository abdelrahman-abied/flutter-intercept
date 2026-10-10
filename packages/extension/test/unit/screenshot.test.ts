import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deviceKind,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS,
  pruneScreenshots,
  pngSize,
  saveScreenshot,
  SCREENSHOT_DIR,
  ScreenshotUnsupportedError,
  takeScreenshot,
  takeScreenshotWith,
  type ScreenshotDeps,
} from '../../src/screenshot';

/** A minimal valid PNG of w×h (one grey pixel row repeated). */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const NOW = new Date('2026-10-10T12:00:00.000Z');
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-shot-test-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

interface Fake extends ScreenshotDeps {
  calls: { method: string; params?: Record<string, unknown> }[];
  execs: { cmd: string; args: string[]; opts?: { timeoutMs?: number; maxBuffer?: number } }[];
  logs: string[];
}

function fake(over: { vm?: Record<string, (p?: Record<string, unknown>) => unknown>; exec?: (cmd: string, args: string[]) => Buffer | Error; noVm?: boolean } = {}): Fake {
  const calls: Fake['calls'] = [];
  const execs: Fake['execs'] = [];
  const logs: string[] = [];
  const vm: Record<string, (p?: Record<string, unknown>) => unknown> = {
    getVM: () => ({ isolates: [{ id: 'isolates/0', name: 'vm-service', isSystemIsolate: true }, { id: 'isolates/1', name: 'main', isSystemIsolate: false }] }),
    'ext.flutter.inspector.getRootWidget': () => ({ result: { valueId: 'inspector-0', description: '[root]' } }),
    'ext.flutter.inspector.screenshot': () => ({ result: png(920, 2000).toString('base64') }),
    'ext.flutter.inspector.disposeGroup': () => ({}),
    '_flutter.screenshot': () => new Error('_flutter.screenshot: (-32000) Could not capture image screenshot.'),
    ...over.vm,
  };
  return {
    calls,
    execs,
    logs,
    log: (m) => logs.push(m),
    callService: over.noVm
      ? undefined
      : async (_sid, method, params) => {
          calls.push({ method, params });
          const h = vm[method];
          if (!h) throw new Error(`Unknown method "${method}"`);
          const v = await h(params);
          if (v instanceof Error) throw v;
          return v;
        },
    exec: async (cmd, args, opts) => {
      execs.push({ cmd, args, opts });
      const r = over.exec ? over.exec(cmd, args) : new Error(`${cmd}: not found`);
      if (r instanceof Error) throw r;
      if (cmd === 'xcrun') fs.writeFileSync(args[args.length - 1], r);
      return { stdout: cmd === 'xcrun' ? Buffer.alloc(0) : r, stderr: '' };
    },
  };
}

describe('pngSize / deviceKind', () => {
  it('reads IHDR width and height; rejects non-PNGs', () => {
    expect(pngSize(png(1206, 2622))).toEqual({ width: 1206, height: 2622 });
    expect(pngSize(Buffer.from('not a png at all, really not'))).toBeUndefined();
    expect(pngSize(png(3, 3).subarray(0, 20))).toBeUndefined();
    const bad = png(3, 3);
    bad.write('IHDX', 12, 'latin1');
    expect(pngSize(bad)).toBeUndefined();
  });

  it('classifies Flutter device ids and refuses option-like or odd ones', () => {
    expect(deviceKind('emulator-5554')).toBe('android');
    expect(deviceKind('R58M12ABCDE')).toBe('android');
    expect(deviceKind('192.168.1.5:5555')).toBe('android');
    expect(deviceKind('adb-R58M12-abc._adb-tls-connect._tcp')).toBe('android');
    expect(deviceKind('11111111-2222-3333-4444-555555555555')).toBe('ios-simulator');
    expect(deviceKind('00008000-0000000000000000')).toBe('ios-device');
    expect(deviceKind('a'.repeat(40))).toBe('ios-device');
    expect(deviceKind('macos')).toBe('desktop');
    expect(deviceKind('chrome')).toBe('web');
    expect(deviceKind('web-server')).toBe('web');
    expect(deviceKind(undefined)).toBe('unknown');
    expect(deviceKind('-s')).toBe('unknown');
    expect(deviceKind('--help')).toBe('unknown');
    expect(deviceKind('emu; rm -rf /')).toBe('unknown');
    expect(deviceKind('x'.repeat(200))).toBe('unknown');
  });
});

describe('takeScreenshot (CONTRACTS §13.8)', () => {
  it('VM service first: the inspector screenshot of the root widget, saved under the project', async () => {
    const d = fake();
    const shot = await takeScreenshotWith({ sessionId: 's1', deviceId: 'emulator-5554', projectRoot: root }, d, { now: () => NOW });
    expect(shot.method).toBe('vm-service');
    expect([shot.width, shot.height]).toEqual([920, 2000]);
    expect(shot.takenAt).toBe(NOW.getTime());
    expect(shot.path).toBe(path.join(root, SCREENSHOT_DIR, '2026-10-10T12-00-00-000Z.png'));
    expect(fs.readFileSync(shot.path).equals(shot.png)).toBe(true);
    const screenshot = d.calls.find((c) => c.method === 'ext.flutter.inspector.screenshot')!;
    expect(screenshot.params).toEqual({ isolateId: 'isolates/1', id: 'inspector-0', width: '2000', height: '2000', maxPixelRatio: '1', margin: '0', debugPaint: 'false' });
    expect(d.calls.find((c) => c.method === 'ext.flutter.inspector.getRootWidget')!.params).toEqual({ isolateId: 'isolates/1', objectGroup: 'flutter-intercept-screenshot' });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.calls.map((c) => c.method)).toContain('ext.flutter.inspector.disposeGroup');
    expect(d.execs).toEqual([]);
  });

  it('a second screenshot in the same millisecond never replaces the first', async () => {
    const d = fake();
    const a = await takeScreenshotWith({ sessionId: 's', deviceId: 'macos', projectRoot: root }, d, { now: () => NOW });
    const b = await takeScreenshotWith({ sessionId: 's', deviceId: 'macos', projectRoot: root }, d, { now: () => NOW });
    expect(path.basename(b.path)).toBe('2026-10-10T12-00-00-000Z-2.png');
    expect(fs.existsSync(a.path)).toBe(true);
  });

  it('falls back to the engine _flutter.screenshot when the inspector route fails', async () => {
    const d = fake({
      vm: {
        'ext.flutter.inspector.getRootWidget': () => new Error('Unknown method "ext.flutter.inspector.getRootWidget"'),
        '_flutter.screenshot': () => ({ type: 'Screenshot', screenshot: png(800, 600).toString('base64') }),
      },
    });
    const shot = await takeScreenshotWith({ sessionId: 's', deviceId: 'macos', projectRoot: root }, d, { now: () => NOW });
    expect(shot.method).toBe('vm-service');
    expect([shot.width, shot.height]).toEqual([800, 600]);
  });

  it('Android: adb exec-out screencap with an argument array when the VM route fails', async () => {
    const d = fake({ vm: { getVM: () => new Error('no answer from the debug adapter (profile mode?)') }, exec: () => png(1080, 2400) });
    const shot = await takeScreenshotWith({ sessionId: 's', deviceId: 'emulator-5554', projectRoot: root }, d, { adbPath: '/sdk/platform-tools/adb', now: () => NOW });
    expect(shot.method).toBe('adb');
    expect([shot.width, shot.height]).toEqual([1080, 2400]);
    expect(d.execs).toEqual([{ cmd: '/sdk/platform-tools/adb', args: ['-s', 'emulator-5554', 'exec-out', 'screencap', '-p'], opts: { timeoutMs: 20000, maxBuffer: MAX_SCREENSHOT_BYTES + 1 } }]);
  });

  it('iOS simulator: simctl into a temp file, read back, temp removed', async () => {
    const d = fake({ noVm: true, exec: () => png(1206, 2622) });
    const shot = await takeScreenshotWith({ sessionId: 's', deviceId: '11111111-2222-3333-4444-555555555555', projectRoot: root }, d, { now: () => NOW });
    expect(shot.method).toBe('simctl');
    expect([shot.width, shot.height]).toEqual([1206, 2622]);
    const { cmd, args } = d.execs[0];
    expect(cmd).toBe('xcrun');
    expect(args.slice(0, 5)).toEqual(['simctl', 'io', '11111111-2222-3333-4444-555555555555', 'screenshot', '--type=png']);
    expect(fs.existsSync(path.dirname(args[5]))).toBe(false);
  });

  it('not a PNG from a tool → error, nothing saved', async () => {
    const d = fake({ noVm: true, exec: () => Buffer.from('error: device offline\n') });
    await expect(takeScreenshotWith({ sessionId: 's', deviceId: 'emulator-5554', projectRoot: root }, d, { adbPath: 'adb' })).rejects.toThrow(/Could not take a screenshot of this Android device \(adb: adb screencap: not a PNG\)/);
    expect(fs.existsSync(path.join(root, SCREENSHOT_DIR))).toBe(false);
  });

  it('an oversized image is refused', async () => {
    const big = Buffer.concat([png(10, 10), Buffer.alloc(MAX_SCREENSHOT_BYTES)]);
    const d = fake({ noVm: true, exec: () => big });
    await expect(takeScreenshotWith({ sessionId: 's', deviceId: 'emulator-5554', projectRoot: root }, d, { adbPath: 'adb' })).rejects.toThrow(/larger than 16 MB/);
    await expect(saveScreenshot(root, big)).rejects.toThrow(/larger than 16 MB/);
  });

  it('macOS / web / physical iOS without a working VM route: "not supported", no tool is run', async () => {
    for (const deviceId of ['macos', 'chrome', '00008000-0000000000000000', undefined]) {
      const d = fake({ vm: { getVM: () => new Error('no answer') }, exec: () => png(1, 1) });
      const p = takeScreenshotWith({ sessionId: 's', deviceId, projectRoot: root }, d);
      await expect(p).rejects.toBeInstanceOf(ScreenshotUnsupportedError);
      await expect(p).rejects.toThrow(/not supported/);
      expect(d.execs).toEqual([]);
    }
  });

  it('never passes an option-like device id to a tool', async () => {
    const d = fake({ noVm: true, exec: () => png(1, 1) });
    await expect(takeScreenshotWith({ sessionId: 's', deviceId: '-a', projectRoot: root }, d, { adbPath: 'adb' })).rejects.toBeInstanceOf(ScreenshotUnsupportedError);
    expect(d.execs).toEqual([]);
  });

  it('refuses a screenshots folder that is a symlink out of the project', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-shot-out-'));
    try {
      fs.mkdirSync(path.join(root, '.dart_tool', 'flutter_intercept'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, '.dart_tool', 'flutter_intercept', 'screenshots'));
      await expect(takeScreenshot({ sessionId: 's', deviceId: 'macos', projectRoot: root }, fake())).rejects.toThrow(/symbolic link/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('REVIEW-7 #13: files 0600 in a 0700 folder', async () => {
    const shot = await takeScreenshotWith({ sessionId: 's', deviceId: 'macos', projectRoot: root }, fake(), { now: () => NOW });
    if (process.platform !== 'win32') {
      expect(fs.statSync(shot.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(shot.path)).mode & 0o777).toBe(0o700);
    }
  });

  it('REVIEW-7 #13: keeps only the newest MAX_SCREENSHOTS of our own files', async () => {
    const dir = path.join(root, SCREENSHOT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString().replace(/[:.]/g, '-');
    for (let i = 0; i < MAX_SCREENSHOTS + 5; i++) fs.writeFileSync(path.join(dir, `${stamp(i)}.png`), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(dir, `${stamp(0)}-2.png`), 'x'); // same ms as the oldest, later
    const shot = await saveScreenshot(root, png(2, 2), new Date(Date.UTC(2026, 5, 1)));
    const left = fs.readdirSync(dir).sort();
    expect(left).toContain('notes.txt');
    expect(left).toContain(path.basename(shot));
    expect(left.filter((n) => n.endsWith('.png'))).toHaveLength(MAX_SCREENSHOTS);
    expect(left).not.toContain(`${stamp(0)}.png`);
    expect(left).not.toContain(`${stamp(0)}-2.png`);
    expect(left).not.toContain(`${stamp(5)}.png`);
    expect(left).toContain(`${stamp(7)}.png`);
    expect(await pruneScreenshots(dir, 3)).toBe(MAX_SCREENSHOTS - 3);
  });

  it('a VM answer that is not a PNG falls through to the device tool', async () => {
    const d = fake({ vm: { 'ext.flutter.inspector.screenshot': () => ({ result: Buffer.from('nope').toString('base64') }) }, exec: () => png(1080, 2400) });
    const shot = await takeScreenshotWith({ sessionId: 's', deviceId: 'emulator-5554', projectRoot: root }, d, { adbPath: 'adb' });
    expect(shot.method).toBe('adb');
    expect(d.logs.some((l) => /VM service route failed/.test(l) && /not a PNG/.test(l))).toBe(true);
  });
});
