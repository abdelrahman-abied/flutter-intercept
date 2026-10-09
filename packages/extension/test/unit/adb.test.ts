import { describe, expect, it } from 'vitest';
import { adbReverse, Exec, locateAdb, parseAdbDevices, parseReverseList, ReverseTracker, withSoftTimeout } from '../../src/adb';

describe('locateAdb', () => {
  const base = { home: '/Users/me', platform: 'darwin' as NodeJS.Platform };
  it('prefers ANDROID_HOME, then ANDROID_SDK_ROOT, then the default SDK dir, then PATH', () => {
    const all = new Set(['/sdk1/platform-tools/adb', '/sdk2/platform-tools/adb', '/Users/me/Library/Android/sdk/platform-tools/adb', '/usr/local/bin/adb']);
    const exists = (p: string) => all.has(p);
    const env = { ANDROID_HOME: '/sdk1', ANDROID_SDK_ROOT: '/sdk2', PATH: '/usr/bin:/usr/local/bin' };
    expect(locateAdb({ ...base, env, exists })).toBe('/sdk1/platform-tools/adb');
    all.delete('/sdk1/platform-tools/adb');
    expect(locateAdb({ ...base, env, exists })).toBe('/sdk2/platform-tools/adb');
    all.delete('/sdk2/platform-tools/adb');
    expect(locateAdb({ ...base, env, exists })).toBe('/Users/me/Library/Android/sdk/platform-tools/adb');
    all.delete('/Users/me/Library/Android/sdk/platform-tools/adb');
    expect(locateAdb({ ...base, env, exists })).toBe('/usr/local/bin/adb');
    all.clear();
    expect(locateAdb({ ...base, env, exists })).toBeUndefined();
  });
});

describe('parseAdbDevices', () => {
  it('keeps only ready devices', () => {
    const out = 'List of devices attached\nemulator-5554\tdevice\nR58M\tunauthorized\nZY22\tdevice product:x model:y\n\n';
    expect(parseAdbDevices(out)).toEqual(['emulator-5554', 'ZY22']);
  });
});

describe('adbReverse', () => {
  const devicesOut = 'List of devices attached\nemulator-5554\tdevice\nZY22\tdevice\n';
  const recorder = () => {
    const calls: string[][] = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      if (args[0] === 'devices') return { stdout: devicesOut, stderr: '' };
      if (args[1] === 'ZY22') throw Object.assign(new Error('boom'), { stderr: 'error: device offline' });
      return { stdout: '', stderr: '' };
    };
    return { calls, exec };
  };

  it('reverses only the requested device', async () => {
    const { calls, exec } = recorder();
    const r = await adbReverse(9100, 'emulator-5554', { exec, adbPath: '/adb' });
    expect(r.reversed).toEqual(['emulator-5554']);
    expect(calls).toContainEqual(['-s', 'emulator-5554', 'reverse', 'tcp:9100', 'tcp:9100']);
  });

  it('reverses all Android devices when no deviceId, reporting failures without throwing', async () => {
    const { exec } = recorder();
    const r = await adbReverse(9100, undefined, { exec, adbPath: '/adb' });
    expect(r.reversed).toEqual(['emulator-5554']);
    expect(r.failed).toEqual([{ serial: 'ZY22', error: 'error: device offline' }]);
  });

  it('physicalOnly skips emulators when no device is given', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_f, args) => {
      calls.push(args);
      return { stdout: args[0] === 'devices' ? 'List of devices attached\nemulator-5554\tdevice\nR58M\tdevice\n' : '', stderr: '' };
    };
    const r = await adbReverse(9100, undefined, { exec, adbPath: '/adb', physicalOnly: true });
    expect(r.reversed).toEqual(['R58M']);
  });

  it('ignores non-Android device ids (iOS, macos)', async () => {
    const { calls, exec } = recorder();
    const r = await adbReverse(9100, '00008110-001A2B3C', { exec, adbPath: '/adb' });
    expect(r.reversed).toEqual([]);
    expect(calls.filter((c) => c.includes('reverse'))).toEqual([]);
  });

  it('never throws when adb is missing or broken', async () => {
    await expect(adbReverse(9100, undefined, { adbPath: null })).resolves.toMatchObject({ skipped: 'adb not found' });
    const broken: Exec = async () => {
      throw new Error('ENOENT');
    };
    await expect(adbReverse(9100, undefined, { exec: broken, adbPath: '/nope/adb' })).resolves.toMatchObject({ reversed: [] });
  });

  it('soft timeout does not block', async () => {
    const t0 = Date.now();
    const v = await withSoftTimeout(new Promise((r) => setTimeout(() => r(1), 1000)), 20);
    expect(v).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('ReverseTracker', () => {
  it('removes exactly the reverses it created', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_f, args) => {
      calls.push(args);
      return { stdout: args[0] === 'devices' ? 'List of devices attached\nR58M\tdevice\n' : '', stderr: '' };
    };
    const t = new ReverseTracker({ exec, adbPath: '/adb' });
    await t.reverse(9100, 'R58M');
    await t.reverse(9100, 'R58M');
    expect(t.size).toBe(1);
    expect(await t.removeAll()).toEqual(['R58M:9100']);
    expect(calls).toContainEqual(['-s', 'R58M', 'reverse', '--remove', 'tcp:9100']);
    expect(t.size).toBe(0);
    expect(await t.removeAll()).toEqual([]);
  });
});

describe('user-managed reverses and in-flight races (review #6)', () => {
  it('parses adb reverse --list', () => {
    expect(parseReverseList('host-23 tcp:8899 tcp:8899\nUsbFfs tcp:9000 tcp:9100\n\n')).toEqual([8899, 9000]);
    expect(parseReverseList('')).toEqual([]);
  });

  function fakeAdb(existing: Record<string, string[]>, delays: Record<string, number> = {}) {
    const calls: string[][] = [];
    const exec: Exec = async (_f, args) => {
      calls.push(args);
      if (args[0] === 'devices') return { stdout: `List of devices attached\n${Object.keys(existing).map((s) => `${s}\tdevice`).join('\n')}\n`, stderr: '' };
      const serial = args[1];
      if (args[2] === 'reverse' && args[3] === '--list') return { stdout: existing[serial].map((p) => `host-1 ${p} ${p}`).join('\n'), stderr: '' };
      if (args[2] === 'reverse' && args[3] !== '--remove') {
        await new Promise((r) => setTimeout(r, delays[serial] ?? 0));
        existing[serial].push(args[3]);
      }
      if (args[3] === '--remove') existing[serial] = existing[serial].filter((p) => p !== args[4]);
      return { stdout: '', stderr: '' };
    };
    return { calls, exec, existing };
  }

  it('never overwrites or removes a pre-existing reverse it did not create', async () => {
    const logs: string[] = [];
    const { calls, exec, existing } = fakeAdb({ R58M: ['tcp:9100'], P2: [] });
    const t = new ReverseTracker({ exec, adbPath: '/adb', log: (m) => logs.push(m) });
    const r = await t.reverse(9100, undefined);
    expect(r.userManaged).toEqual(['R58M']);
    expect(r.reversed).toEqual(['P2']);
    expect(calls).not.toContainEqual(['-s', 'R58M', 'reverse', 'tcp:9100', 'tcp:9100']);
    expect(logs.some((l) => /user-managed/.test(l))).toBe(true);
    expect(await t.removeAll()).toEqual(['P2:9100']);
    expect(existing.R58M).toEqual(['tcp:9100']); // user's reverse survives
    expect(calls).not.toContainEqual(['-s', 'R58M', 'reverse', '--remove', 'tcp:9100']);
  });

  it('recognises its own existing reverse (second session) without re-reversing or disowning it', async () => {
    const { calls, exec } = fakeAdb({ R58M: [] });
    const t = new ReverseTracker({ exec, adbPath: '/adb' });
    await t.reverse(9100, 'R58M');
    const second = await t.reverse(9100, 'R58M');
    expect(second.reversed).toEqual(['R58M']);
    expect(second.userManaged).toEqual([]);
    expect(calls.filter((c) => c[2] === 'reverse' && c[3] === 'tcp:9100')).toHaveLength(1);
    expect(await t.removeAll()).toEqual(['R58M:9100']);
  });

  it('removeAll waits for a reverse still in flight and removes it', async () => {
    const { exec, existing } = fakeAdb({ R58M: [] }, { R58M: 80 });
    const t = new ReverseTracker({ exec, adbPath: '/adb' });
    const pending = t.reverse(9100, 'R58M'); // session ends before this completes
    expect(t.pending).toBe(1);
    const removed = await t.removeAll();
    await pending;
    expect(removed).toEqual(['R58M:9100']);
    expect(existing.R58M).toEqual([]);
    expect(t.size).toBe(0);
  });

  it('reverses anyway when --list fails (old adb), and still tracks it', async () => {
    const exec: Exec = async (_f, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nR58M\tdevice\n', stderr: '' };
      if (args[3] === '--list') throw new Error('unknown option');
      return { stdout: '', stderr: '' };
    };
    const t = new ReverseTracker({ exec, adbPath: '/adb' });
    expect((await t.reverse(9100, 'R58M')).reversed).toEqual(['R58M']);
    expect(t.size).toBe(1);
  });
});
