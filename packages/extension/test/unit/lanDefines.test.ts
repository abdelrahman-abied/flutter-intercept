/**
 * REVIEW-9: the physical-iPhone LAN token never goes on the command line. With a define-file path the rewrite passes
 * `--dart-define-from-file=<private 0600 file>` instead of `--dart-define=FLUTTER_INTERCEPT_PROXY=…:<token>@…`, strips
 * its own flag on re-resolve / restore, and the provider writes the file (outside the project) before launching.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
    get workspaceFolders() {
      return [{ uri: { fsPath: app, scheme: 'file' } }];
    },
  },
  window: { activeTextEditor: undefined },
  commands: { executeCommand: async () => undefined },
}));

import { cleanupLanDefines, LAN_DEFINES_DIR, newLanDefinesPath, removeLanDefines, writeLanDefines } from '../../src/debug/lanPrepare';
import { prepareLaunch, type PrepareDeps } from '../../src/debug/provider';
import { DEFINE_FROM_FILE, isOurDefinesFile, LAN_KEY, lanDefinesFileIn, PROXY_DEFINE, rewriteDebugConfig, SHA_DEFINE, stripDefines, withoutInterception, type RewriteContext } from '../../src/debug/rewrite';

const PHONE = '00008110-000A1B2C3D4E5F6A';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd';
let app: string;
let storage: string;

beforeAll(() => {
  app = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-landef-app-'));
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-landef-store-'));
  fs.mkdirSync(path.join(app, 'lib'));
  fs.writeFileSync(path.join(app, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.writeFileSync(path.join(app, 'lib', 'main.dart'), 'void main() {}');
});
afterAll(() => {
  fs.rmSync(app, { recursive: true, force: true });
  fs.rmSync(storage, { recursive: true, force: true });
});

const lan = { host: '192.168.1.23', port: 9400, token: TOKEN };
const ctx = (over: Partial<RewriteContext> = {}): RewriteContext => ({
  enabled: true,
  caCertPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  proxyPort: 8899,
  folder: app,
  workspaceFolders: [app],
  ...over,
});
const resolved = (toolArgs: string[] = ['-d', PHONE]) => ({ type: 'dart', request: 'launch', program: path.join(app, 'lib', 'main.dart'), cwd: app, debuggerType: 2, toolEnv: {}, deviceId: PHONE, toolArgs });

describe('LAN define file in the rewrite', () => {
  it('passes the token through --dart-define-from-file, never in toolArgs', () => {
    const file = newLanDefinesPath(storage);
    expect(isOurDefinesFile(file)).toBe(true);
    const r = rewriteDebugConfig(resolved(), ctx({ physicalIos: true, lan, lanDefinesFile: file }));
    if (r.kind !== 'rewrite') throw new Error(r.kind);
    const args = r.config.toolArgs as string[];
    expect(args).toContain(`${DEFINE_FROM_FILE}=${file}`);
    expect(args.some((a) => a.includes(`${PROXY_DEFINE}=`))).toBe(false);
    expect(JSON.stringify(r.config)).not.toContain(TOKEN);
    expect(r.lanDefines).toEqual({ path: file, content: `{"${PROXY_DEFINE}":"flutter-intercept:${TOKEN}@192.168.1.23:9400"}\n` });
    expect(r.config[LAN_KEY]).toBe(true);
    expect(lanDefinesFileIn(args)).toBe(file);
  });

  it('re-resolve replaces our file flag (both forms), keeps the user\'s own define files', () => {
    const old = newLanDefinesPath(storage);
    const mine = path.join(app, 'config', 'dev.json');
    const r1 = rewriteDebugConfig(resolved(['-d', PHONE, `${DEFINE_FROM_FILE}=${mine}`, DEFINE_FROM_FILE, old]), ctx({ physicalIos: true, lan, lanDefinesFile: newLanDefinesPath(storage) }));
    if (r1.kind !== 'rewrite') throw new Error(r1.kind);
    const args = r1.config.toolArgs as string[];
    expect(args).toContain(`${DEFINE_FROM_FILE}=${mine}`);
    expect(args).not.toContain(old);
    expect(args.filter((a) => a.startsWith(DEFINE_FROM_FILE) && isOurDefinesFile(a.split('=')[1]))).toHaveLength(1);
    expect(withoutInterception(r1.config).toolArgs).toEqual(['-d', PHONE, `${DEFINE_FROM_FILE}=${mine}`]);
    expect(stripDefines([`${DEFINE_FROM_FILE}=${old}`], [SHA_DEFINE])).toEqual([`${DEFINE_FROM_FILE}=${old}`]); // SHA-only strip leaves it
  });

  it('a file path that is not ours, or a non-LAN session, keeps the inline define', () => {
    const r = rewriteDebugConfig(resolved(), ctx({ physicalIos: true, lan, lanDefinesFile: path.join(storage, 'evil.json') }));
    if (r.kind !== 'rewrite') throw new Error(r.kind);
    expect((r.config.toolArgs as string[]).filter((a) => a.includes(`${PROXY_DEFINE}=`))).toHaveLength(1);
    expect(r.lanDefines).toBeUndefined();
    const sim = rewriteDebugConfig({ ...resolved(['-d', 'SIM']), deviceId: 'SIM' }, ctx({ lanDefinesFile: newLanDefinesPath(storage) }));
    if (sim.kind !== 'rewrite') throw new Error(sim.kind);
    expect(sim.config.toolArgs).toContain(`--dart-define=${PROXY_DEFINE}=localhost:8899`);
    expect(sim.lanDefines).toBeUndefined();
  });
});

describe('LAN define file helpers', () => {
  it('writes 0600 in a 0700 folder, never overwrites, removes only ours, sweeps at startup', async () => {
    const f = newLanDefinesPath(storage);
    expect(path.dirname(f)).toBe(path.join(path.resolve(storage), LAN_DEFINES_DIR));
    await writeLanDefines(f, '{"a":"b"}\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
    }
    await expect(writeLanDefines(f, 'x')).rejects.toThrow();
    await expect(writeLanDefines(path.join(storage, 'other.json'), 'x')).rejects.toThrow('not a Flutter Intercept LAN define file');
    const other = path.join(path.dirname(f), 'keep.txt');
    fs.writeFileSync(other, 'x');
    await removeLanDefines(other);
    expect(fs.existsSync(other)).toBe(true);
    await removeLanDefines(f);
    expect(fs.existsSync(f)).toBe(false);
    await writeLanDefines(newLanDefinesPath(storage), '{}');
    await writeLanDefines(newLanDefinesPath(storage), '{}');
    expect(await cleanupLanDefines(storage)).toBe(2);
    expect(fs.readdirSync(path.dirname(f))).toEqual(['keep.txt']);
    expect(await cleanupLanDefines(path.join(storage, 'missing'))).toBe(0);
  });
});

describe('provider: physical iPhone', () => {
  it('writes the define file in private storage (not the project) and puts only its path on the command line', async () => {
    const d: PrepareDeps = {
      proxyHost: { start: async () => 9123 } as unknown as PrepareDeps['proxyHost'],
      getCaCertPem: async () => '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      log: () => undefined,
      events: [],
      reverses: { reverse: async () => undefined } as unknown as PrepareDeps['reverses'],
      lan: { classify: async () => 'ios-physical', address: async () => ({ address: '192.168.1.23', iface: 'en0' }), open: async (host) => ({ host, port: 9400, token: TOKEN }) },
      lanDefinesDir: storage,
    };
    const config: any = resolved();
    await prepareLaunch(d, { uri: { fsPath: app, scheme: 'file' }, name: 'app', index: 0 } as any, config, 'command');
    const file = lanDefinesFileIn(config.toolArgs)!;
    expect(file.startsWith(path.join(path.resolve(storage), LAN_DEFINES_DIR))).toBe(true);
    expect(file.startsWith(app)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [PROXY_DEFINE]: `flutter-intercept:${TOKEN}@192.168.1.23:9400` });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    await removeLanDefines(file);
  });
});
