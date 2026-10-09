/**
 * Apple Silicon + USB iPhone + no Rosetta: Flutter's own iOS USB tools (libimobiledevice's
 * `iproxy`, shipped in `<flutter>/bin/cache/artifacts/libusbmuxd/`) are x86_64-only in Flutter
 * 3.47, so `flutter run` installs and launches the app, then fails after ~60 s with
 * "The binary was built with the incorrect architecture" and the app hangs paused before main.
 * Not our bug, but we can warn BEFORE the launch. This module only diagnoses; it never blocks.
 *
 * Signals (all cheap, all cached):
 *  - Rosetta: `arch -x86_64 /usr/bin/true` (functional test; /usr/bin/true is universal; ~5 ms;
 *    exit 1 "Bad CPU type in executable" without Rosetta). If `arch` itself can't run, fall back
 *    to the presence of /Library/Apple/usr/libexec/oah/libRosettaRuntime.
 *  - iproxy architecture: Mach-O header of `<sdk>/bin/cache/artifacts/libusbmuxd/iproxy`
 *    (thin 0xfeedfacf + cputype, or fat 0xcafebabe/0xcafebabf with its arch table). No `file` dependency.
 *  - Transport: `xcrun devicectl list devices --json-output <tmp>` (~0.1 s):
 *    `connectionProperties.transportType` is `localNetwork` for Wi-Fi pairing, otherwise wired.
 */
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

// ------------------------------------------------------------------ Mach-O

const CPU: Record<number, string> = {
  0x7: 'i386',
  0x01000007: 'x86_64',
  0xc: 'arm',
  0x0100000c: 'arm64',
  0x0200000c: 'arm64_32',
};

/** Architectures of a Mach-O (thin or fat) from its first bytes; undefined if not Mach-O. */
export function machOArchs(buf: Buffer): string[] | undefined {
  if (buf.length < 8) return undefined;
  const le = buf.readUInt32LE(0);
  if (le === 0xfeedfacf || le === 0xfeedface) return [CPU[buf.readUInt32LE(4)] ?? `cpu:${buf.readUInt32LE(4).toString(16)}`];
  const be = buf.readUInt32BE(0);
  if (be === 0xfeedfacf || be === 0xfeedface) return [CPU[buf.readUInt32BE(4)] ?? `cpu:${buf.readUInt32BE(4).toString(16)}`];
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const n = buf.readUInt32BE(4);
    if (n === 0 || n > 20) return undefined; // 0xcafebabe is also a Java class file magic
    const size = be === 0xcafebabf ? 32 : 20;
    const archs: string[] = [];
    for (let i = 0; i < n; i++) {
      const off = 8 + i * size;
      if (off + 4 > buf.length) return undefined;
      const cpu = buf.readUInt32BE(off);
      archs.push(CPU[cpu] ?? `cpu:${cpu.toString(16)}`);
    }
    return archs;
  }
  return undefined;
}

export const IPROXY_REL = path.join('bin', 'cache', 'artifacts', 'libusbmuxd', 'iproxy');

// ------------------------------------------------------------------ devicectl

export type Transport = 'usb' | 'network' | 'unknown';

/** udid (upper case) → transport, from `devicectl list devices --json-output` JSON. */
export function parseDevicectl(json: string): Map<string, Transport> {
  const out = new Map<string, Transport>();
  try {
    const data = JSON.parse(json) as { result?: { devices?: { hardwareProperties?: { udid?: string; reality?: string }; connectionProperties?: { transportType?: string } }[] } };
    for (const d of data.result?.devices ?? []) {
      const udid = d.hardwareProperties?.udid;
      if (!udid || d.hardwareProperties?.reality === 'simulated') continue;
      const t = d.connectionProperties?.transportType;
      out.set(udid.toUpperCase(), t === 'localNetwork' ? 'network' : t === 'wired' ? 'usb' : 'unknown');
    }
  } catch {
    // unparsable → empty
  }
  return out;
}

// ------------------------------------------------------------------ the check

export interface UsbToolingFacts {
  arm64: boolean;
  rosetta: boolean | undefined;
  iproxyArchs: string[] | undefined;
  iproxyPath?: string;
  transport: Transport;
}

export interface UsbToolingDeps {
  exec?: Exec;
  platform?: NodeJS.Platform;
  arch?: string;
  readHead?: (file: string) => Buffer | undefined;
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
  now?: () => number;
}

export const ROSETTA_RUNTIME = '/Library/Apple/usr/libexec/oah/libRosettaRuntime';

export class IosUsbToolingChecker {
  private rosetta?: { value: boolean; at: number };
  private readonly iproxy = new Map<string, string[] | undefined>();
  private transports?: { map: Map<string, Transport>; at: number };

  constructor(private readonly deps: UsbToolingDeps = {}) {}

  private get exec(): Exec {
    return this.deps.exec ?? defaultExec;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async hasRosetta(): Promise<boolean> {
    // A positive answer is permanent; a negative one is re-checked after a minute (user may install it).
    if (this.rosetta && (this.rosetta.value || this.now() - this.rosetta.at < 60_000)) return this.rosetta.value;
    let value: boolean;
    try {
      await this.exec('arch', ['-x86_64', '/usr/bin/true'], 3000);
      value = true;
    } catch (e) {
      const msg = String((e as { stderr?: string; message?: string })?.stderr ?? (e as Error)?.message ?? e);
      // "Bad CPU type in executable" = definitely no Rosetta; anything else: fall back to the runtime file.
      value = /bad cpu type/i.test(msg) ? false : (this.deps.exists ?? fs.existsSync)(ROSETTA_RUNTIME);
    }
    this.rosetta = { value, at: this.now() };
    return value;
  }

  iproxyArchs(flutterSdk: string): { path: string; archs: string[] | undefined } {
    const file = path.join(flutterSdk, IPROXY_REL);
    if (!this.iproxy.has(file)) {
      const head = (this.deps.readHead ?? readHead)(file);
      this.iproxy.set(file, head ? machOArchs(head) : undefined);
    }
    return { path: file, archs: this.iproxy.get(file) };
  }

  async transport(udid: string): Promise<Transport> {
    if (!this.transports || this.now() - this.transports.at > 10_000) {
      const tmp = path.join(os.tmpdir(), `fi-devicectl-${crypto.randomBytes(6).toString('hex')}.json`);
      try {
        await this.exec('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmp], 5000);
        this.transports = { map: parseDevicectl((this.deps.readFile ?? ((f) => fs.readFileSync(f, 'utf8')))(tmp)), at: this.now() };
      } catch {
        this.transports = { map: new Map(), at: this.now() };
      } finally {
        fs.rm(tmp, { force: true }, () => undefined);
      }
    }
    return this.transports.map.get(udid.toUpperCase()) ?? 'unknown';
  }

  /**
   * Facts for a physical-iOS launch, or undefined when the problem cannot apply (not an
   * Apple Silicon Mac). Never throws.
   */
  async check(udid: string, flutterSdk: string | undefined): Promise<UsbToolingFacts | undefined> {
    if ((this.deps.platform ?? process.platform) !== 'darwin' || (this.deps.arch ?? os.arch()) !== 'arm64') return undefined;
    try {
      const [rosetta, transport] = await Promise.all([this.hasRosetta(), this.transport(udid)]);
      const ip = flutterSdk ? this.iproxyArchs(flutterSdk) : undefined;
      return { arm64: true, rosetta, iproxyArchs: ip?.archs, iproxyPath: ip?.path, transport };
    } catch {
      return undefined;
    }
  }
}

/** USB (or unknown transport) + x86_64-only iproxy + no Rosetta → the launch will hang. */
export function needsRosettaWarning(f: UsbToolingFacts | undefined): boolean {
  if (!f || f.rosetta !== false || f.transport === 'network') return false;
  const archs = f.iproxyArchs;
  return !!archs && archs.length > 0 && !archs.includes('arm64') && archs.every((a) => a === 'x86_64' || a === 'i386');
}

export const ROSETTA_INSTALL_COMMAND = 'sudo softwareupdate --install-rosetta --agree-to-license';

export function rosettaWarningText(f: UsbToolingFacts): string {
  const prefix = f.transport === 'usb' ? '' : 'If your iPhone is connected by USB: ';
  return (
    `${prefix}Flutter's iPhone USB tools (iproxy) need Rosetta on Apple Silicon, and Rosetta is not installed — ` +
    `the app would install and then hang before main. Either install Rosetta (\`${ROSETTA_INSTALL_COMMAND}\`) ` +
    `or connect the iPhone over Wi-Fi (Xcode → Window → Devices and Simulators → Connect via network).`
  );
}

function readHead(file: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Flutter SDK for a session: Dart-Code's resolved `flutterSdkPath` (set on the config when our hook
 * runs after Dart-Code), else the `dart.flutterSdkPath` setting, else FLUTTER_ROOT, else
 * `which flutter` (resolved through symlinks: <sdk>/bin/flutter).
 */
export async function resolveFlutterSdk(
  candidates: (string | undefined)[],
  opts: { exec?: Exec; realpath?: (p: string) => string; exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  const exists = opts.exists ?? fs.existsSync;
  for (const c of [...candidates, (opts.env ?? process.env).FLUTTER_ROOT]) if (c && exists(path.join(c, 'bin'))) return c;
  try {
    const { stdout } = await (opts.exec ?? defaultExec)('/usr/bin/which', ['flutter'], 2000);
    const bin = stdout.trim().split('\n')[0];
    if (!bin) return undefined;
    const real = (opts.realpath ?? fs.realpathSync)(bin);
    return path.dirname(path.dirname(real));
  } catch {
    return undefined;
  }
}
