import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { prepareLan } from '../../src/debug/lanPrepare';
import { kindFromId } from '../../src/iosDevices';
import {
  IosUsbToolingChecker,
  IPROXY_REL,
  machOArchs,
  needsRosettaWarning,
  parseDevicectl,
  resolveFlutterSdk,
  ROSETTA_RUNTIME,
  rosettaWarningText,
  UsbToolingFacts,
} from '../../src/iosUsbTooling';

// ---- fixture Mach-O headers -------------------------------------------------------------
/** Thin 64-bit Mach-O header (little-endian), as on disk. */
function thin(cputype: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cputype, 4);
  b.writeUInt32LE(3, 8); // subtype
  b.writeUInt32LE(2, 12); // MH_EXECUTE
  return b;
}
/** Fat (universal) header: big-endian, 20-byte fat_arch entries (fat64: 32 bytes). */
function fat(cputypes: number[], fat64 = false): Buffer {
  const size = fat64 ? 32 : 20;
  const b = Buffer.alloc(8 + cputypes.length * size);
  b.writeUInt32BE(fat64 ? 0xcafebabf : 0xcafebabe, 0);
  b.writeUInt32BE(cputypes.length, 4);
  cputypes.forEach((c, i) => b.writeUInt32BE(c, 8 + i * size));
  return b;
}
const X86_64 = 0x01000007;
const ARM64 = 0x0100000c;

describe('Mach-O header parsing', () => {
  it('thin x86_64 / thin arm64 / fat universal / fat64 / not Mach-O', () => {
    expect(machOArchs(thin(X86_64))).toEqual(['x86_64']);
    expect(machOArchs(thin(ARM64))).toEqual(['arm64']);
    expect(machOArchs(fat([X86_64, ARM64]))).toEqual(['x86_64', 'arm64']);
    expect(machOArchs(fat([X86_64], true))).toEqual(['x86_64']);
    expect(machOArchs(Buffer.from('#!/bin/sh\necho hi\n'))).toBeUndefined();
    // 0xcafebabe is also the Java class-file magic: an implausible arch count is rejected
    const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]);
    expect(machOArchs(javaClass)).toBeUndefined();
  });

  it("matches the real Flutter 3.47 iproxy on this machine when present (x86_64-only)", () => {
    const real = path.join(process.env.HOME ?? '', 'Documents', 'flutter', IPROXY_REL);
    if (!fs.existsSync(real)) return;
    const head = fs.readFileSync(real).subarray(0, 4096);
    expect(machOArchs(head)).toEqual(['x86_64']);
  });
});

// ---- devicectl transport --------------------------------------------------------------
const PHONE = '00008110-000A1B2C3D4E5F60';
const devicectlJson = (transportType: string) =>
  JSON.stringify({
    result: {
      devices: [
        { hardwareProperties: { udid: PHONE, reality: 'physical', platform: 'iOS' }, connectionProperties: { transportType, tunnelState: 'connected' } },
        { hardwareProperties: { udid: '5A3F2C1E-7B4D-4E8A-9C6B-1D2E3F4A5B6C', reality: 'simulated' }, connectionProperties: { transportType: 'sameMachine' } },
      ],
    },
  });

describe('devicectl transport', () => {
  it('wired → usb, localNetwork → network, simulators ignored', () => {
    expect(parseDevicectl(devicectlJson('wired')).get(PHONE)).toBe('usb');
    expect(parseDevicectl(devicectlJson('localNetwork')).get(PHONE)).toBe('network');
    expect(parseDevicectl(devicectlJson('localNetwork')).size).toBe(1);
    expect(parseDevicectl('garbage').size).toBe(0);
  });
});

// ---- the checker -----------------------------------------------------------------------
function checker(opts: { rosettaExit: 'ok' | 'badcpu' | 'missing-arch'; runtimeFile?: boolean; iproxy?: Buffer; transport?: string; platform?: NodeJS.Platform; arch?: string }) {
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === 'arch') {
      if (opts.rosettaExit === 'ok') return { stdout: '', stderr: '' };
      if (opts.rosettaExit === 'badcpu') throw Object.assign(new Error('Command failed: arch -x86_64 /usr/bin/true\narch: posix_spawnp: /usr/bin/true: Bad CPU type in executable\n'), { stderr: 'arch: posix_spawnp: /usr/bin/true: Bad CPU type in executable\n' });
      throw Object.assign(new Error('spawn arch ENOENT'), { code: 'ENOENT' });
    }
    if (file === 'xcrun' && args[0] === 'devicectl') {
      if (!opts.transport) throw new Error('devicectl: not found');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected ${file}`);
  });
  const c = new IosUsbToolingChecker({
    exec,
    platform: opts.platform ?? 'darwin',
    arch: opts.arch ?? 'arm64',
    readHead: () => opts.iproxy,
    exists: (f) => f === ROSETTA_RUNTIME && !!opts.runtimeFile,
    readFile: () => devicectlJson(opts.transport ?? 'wired'),
  });
  return { c, exec };
}

describe('IosUsbToolingChecker', () => {
  it('USB + x86_64-only iproxy + no Rosetta → warning', async () => {
    const { c } = checker({ rosettaExit: 'badcpu', iproxy: thin(X86_64), transport: 'wired' });
    const f = await c.check(PHONE, '/sdk');
    expect(f).toMatchObject({ rosetta: false, iproxyArchs: ['x86_64'], transport: 'usb', iproxyPath: path.join('/sdk', IPROXY_REL) });
    expect(needsRosettaWarning(f)).toBe(true);
    expect(rosettaWarningText(f!)).toMatch(/^Flutter's iPhone USB tools \(iproxy\) need Rosetta on Apple Silicon/);
    expect(rosettaWarningText(f!)).toContain('sudo softwareupdate --install-rosetta --agree-to-license');
    expect(rosettaWarningText(f!)).toContain('Connect via network');
  });

  it.each<[string, Parameters<typeof checker>[0]]>([
    ['Rosetta installed', { rosettaExit: 'ok', iproxy: thin(X86_64), transport: 'wired' }],
    ['Wi-Fi paired iPhone (no iproxy)', { rosettaExit: 'badcpu', iproxy: thin(X86_64), transport: 'localNetwork' }],
    ['arm64 iproxy (future Flutter)', { rosettaExit: 'badcpu', iproxy: thin(ARM64), transport: 'wired' }],
    ['universal iproxy', { rosettaExit: 'badcpu', iproxy: fat([X86_64, ARM64]), transport: 'wired' }],
    ['iproxy not downloaded yet', { rosettaExit: 'badcpu', iproxy: undefined, transport: 'wired' }],
  ])('no warning: %s', async (_n, o) => {
    const { c } = checker(o);
    expect(needsRosettaWarning(await c.check(PHONE, '/sdk'))).toBe(false);
  });

  it('not Apple Silicon / not macOS → nothing to check', async () => {
    expect(await checker({ rosettaExit: 'badcpu', iproxy: thin(X86_64), arch: 'x64' }).c.check(PHONE, '/sdk')).toBeUndefined();
    expect(await checker({ rosettaExit: 'badcpu', iproxy: thin(X86_64), platform: 'linux' }).c.check(PHONE, '/sdk')).toBeUndefined();
  });

  it('unknown transport (devicectl unavailable) still warns, phrased conditionally', async () => {
    const { c } = checker({ rosettaExit: 'badcpu', iproxy: thin(X86_64), transport: undefined });
    const f = await c.check(PHONE, '/sdk');
    expect(f?.transport).toBe('unknown');
    expect(needsRosettaWarning(f)).toBe(true);
    expect(rosettaWarningText(f!)).toMatch(/^If your iPhone is connected by USB: /);
  });

  it('`arch` unusable → falls back to the Rosetta runtime file', async () => {
    expect((await checker({ rosettaExit: 'missing-arch', runtimeFile: true, iproxy: thin(X86_64) }).c.check(PHONE, '/sdk'))?.rosetta).toBe(true);
    expect((await checker({ rosettaExit: 'missing-arch', runtimeFile: false, iproxy: thin(X86_64) }).c.check(PHONE, '/sdk'))?.rosetta).toBe(false);
  });

  it('caches: Rosetta, devicectl and the iproxy header are read once per check window', async () => {
    const { c, exec } = checker({ rosettaExit: 'badcpu', iproxy: thin(X86_64), transport: 'wired' });
    await c.check(PHONE, '/sdk');
    await c.check(PHONE, '/sdk');
    expect(exec.mock.calls.filter(([f]) => f === 'arch')).toHaveLength(1);
    expect(exec.mock.calls.filter(([f]) => f === 'xcrun')).toHaveLength(1);
  });
});

describe('resolveFlutterSdk', () => {
  it('prefers Dart-Code / setting, then FLUTTER_ROOT, then `which flutter` through symlinks', async () => {
    const exists = (p: string) => p === '/dc/flutter/bin' || p === '/env/flutter/bin';
    expect(await resolveFlutterSdk(['/dc/flutter'], { exists, env: {} })).toBe('/dc/flutter');
    expect(await resolveFlutterSdk([undefined], { exists, env: { FLUTTER_ROOT: '/env/flutter' } })).toBe('/env/flutter');
    const viaWhich = await resolveFlutterSdk([undefined], {
      exists: () => false,
      env: {},
      exec: async () => ({ stdout: '/usr/local/bin/flutter\n', stderr: '' }),
      realpath: () => '/Users/me/flutter/bin/flutter',
    });
    expect(viaWhich).toBe('/Users/me/flutter');
    expect(await resolveFlutterSdk([], { exists: () => false, env: {}, exec: async () => Promise.reject(new Error('no')) })).toBeUndefined();
  });
});

describe('physical-iOS launch path', () => {
  const lanDeps = (before: (id: string, sdk?: string) => unknown) => ({
    classify: async (id: string | undefined) => kindFromId(id),
    address: async () => ({ address: '192.168.1.23', iface: 'en0' }),
    open: async (host: string) => ({ host, port: 9400, token: 't' }),
    beforePhysicalLaunch: before,
  });

  it('runs the diagnosis before continuing, for USB and Wi-Fi alike (no transport assumption), never blocking long', async () => {
    const seen: [string, string | undefined][] = [];
    const r = await prepareLan(lanDeps((id, sdk) => void seen.push([id, sdk])), PHONE, () => undefined, '/sdk');
    expect(seen).toEqual([[PHONE, '/sdk']]);
    expect(r.lan).toBeTruthy(); // LAN mode proceeds regardless of the transport

    const t0 = Date.now();
    const slow = await prepareLan(lanDeps(() => new Promise(() => undefined)), PHONE, () => undefined);
    expect(Date.now() - t0).toBeLessThan(3500); // bounded at 3 s
    expect(slow.lan).toBeTruthy();

    const throwing = await prepareLan(lanDeps(() => { throw new Error('boom'); }), PHONE, () => undefined);
    expect(throwing.lan).toBeTruthy();
  }, 10_000);

  it('simulators / Android never run it', async () => {
    const before = vi.fn();
    await prepareLan(lanDeps(before), '5A3F2C1E-7B4D-4E8A-9C6B-1D2E3F4A5B6C', () => undefined);
    await prepareLan(lanDeps(before), 'emulator-5554', () => undefined);
    expect(before).not.toHaveBeenCalled();
  });
});

// keep the type import used
export type _F = UsbToolingFacts;
