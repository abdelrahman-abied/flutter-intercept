import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareLan, type LanDeps } from '../../src/debug/lanPrepare';
import { HOST_KEY, LAN_KEY, lanProxyAddress, MARKER_KEY, PROXY_DEFINE, rewriteDebugConfig, RewriteContext } from '../../src/debug/rewrite';
import { IosDeviceClassifier, kindFromId, parseSimctl } from '../../src/iosDevices';
import { defaultRouteIPv4, ipv4Of, isPrivateIPv4, parseIpRouteDefault, parseRouteGetDefault } from '../../src/lanAddress';
import { LanLifecycle } from '../../src/lanLifecycle';
import { InterceptProxyHost, newLanToken, type ProxyLike } from '../../src/proxyHost';

const PHONE = '00008110-000A1B2C3D4E5F60';
const OLD_PHONE = '2b6f0cc904d137be2e1730235f5664094b831186';
const SIM = '5A3F2C1E-7B4D-4E8A-9C6B-1D2E3F4A5B6C';

// ---------------------------------------------------------------- detection
describe('physical iOS detection', () => {
  it.each([
    [PHONE, 'ios-physical'],
    [OLD_PHONE, 'ios-physical'],
    [SIM, 'ios-simulator'],
    ['emulator-5554', 'other'],
    ['R58M123ABC', 'other'],
    ['macos', 'other'],
    ['chrome', 'other'],
    ['web-server', 'other'],
    ['linux', 'other'],
    [undefined, 'other'],
  ])('%s → %s', (id, kind) => expect(kindFromId(id)).toBe(kind));

  const simctlJson = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [{ udid: SIM, name: 'iPhone 17 Pro' }] } });

  it('parses simctl JSON', () => {
    expect(parseSimctl(simctlJson)).toEqual(new Set([SIM]));
    expect(parseSimctl('not json')).toEqual(new Set());
  });

  it('a simulator is never physical; simctl is cached; non-darwin uses the format', async () => {
    const exec = vi.fn(async () => ({ stdout: simctlJson, stderr: '' }));
    let now = 0;
    const c = new IosDeviceClassifier({ exec, platform: 'darwin', now: () => now, refreshMs: 30_000 });
    expect(await c.classify(SIM)).toBe('ios-simulator');
    expect(await c.classify(PHONE)).toBe('ios-physical');
    expect(await c.classify('emulator-5554')).toBe('other');
    expect(exec).toHaveBeenCalledTimes(1);
    now = 40_000;
    expect(await c.classify(PHONE)).toBe('ios-physical');
    expect(exec).toHaveBeenCalledTimes(2);
    const linux = new IosDeviceClassifier({ exec: vi.fn(), platform: 'linux' });
    expect(await linux.classify(PHONE)).toBe('ios-physical');
  });

  it('simctl listing an id with a physical shape wins (cross-check)', async () => {
    const weird = '00008140-0000000000000001';
    const exec = async () => ({ stdout: JSON.stringify({ devices: { r: [{ udid: weird }] } }), stderr: '' });
    expect(await new IosDeviceClassifier({ exec, platform: 'darwin' }).classify(weird)).toBe('ios-simulator');
  });

  it('falls back to the id format when simctl fails or hangs', async () => {
    const logs: string[] = [];
    const failing = new IosDeviceClassifier({ exec: async () => Promise.reject(new Error('xcrun: error')), platform: 'darwin', log: (m) => logs.push(m) });
    expect(await failing.classify(PHONE)).toBe('ios-physical');
    expect(logs.join()).toMatch(/simctl unavailable/);
  });
});

// ---------------------------------------------------------------- LAN address
describe('LAN address (default-route interface)', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.23', family: 'IPv4', internal: false },
    ],
    en5: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
    utun3: [{ address: '10.8.0.5', family: 'IPv4', internal: false }],
  } as unknown as ReturnType<typeof os.networkInterfaces>;
  const routeOut = (iface: string) => `   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: ${iface}\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n`;

  it('parses route / ip outputs', () => {
    expect(parseRouteGetDefault(routeOut('en0'))).toBe('en0');
    expect(parseRouteGetDefault('route: writing to routing socket: not in table')).toBeUndefined();
    expect(parseIpRouteDefault('default via 192.168.1.1 dev wlan0 proto dhcp metric 600\n')).toBe('wlan0');
    expect(ipv4Of(ifaces, 'en0')).toBe('192.168.1.23');
    expect(ipv4Of(ifaces, 'en5')).toBeUndefined(); // link-local only
    expect(isPrivateIPv4('172.20.1.1')).toBe(true);
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
  });

  it('macOS: IPv4 of the default-route interface', async () => {
    const r = await defaultRouteIPv4({ platform: 'darwin', exec: async () => ({ stdout: routeOut('en0'), stderr: '' }), interfaces: () => ifaces });
    expect(r).toEqual({ address: '192.168.1.23', iface: 'en0' });
  });

  it('no default route (no Wi-Fi) → undefined', async () => {
    const r = await defaultRouteIPv4({ platform: 'darwin', exec: async () => Promise.reject(new Error('not in table')), interfaces: () => ifaces });
    expect(r).toBeUndefined();
    const noV4 = await defaultRouteIPv4({ platform: 'darwin', exec: async () => ({ stdout: routeOut('en5'), stderr: '' }), interfaces: () => ifaces });
    expect(noV4).toBeUndefined();
  });

  it('full-tunnel VPN owns the default route → first en* with a private IPv4', async () => {
    const r = await defaultRouteIPv4({ platform: 'darwin', exec: async () => ({ stdout: routeOut('utun3'), stderr: '' }), interfaces: () => ifaces });
    expect(r).toEqual({ address: '192.168.1.23', iface: 'en0' });
  });

  it('linux uses ip route', async () => {
    const r = await defaultRouteIPv4({
      platform: 'linux',
      exec: async (f, a) => ({ stdout: f === 'ip' && a.includes('default') ? 'default via 10.0.0.1 dev wlan0\n' : '', stderr: '' }),
      interfaces: () => ({ wlan0: [{ address: '10.0.0.9', family: 'IPv4', internal: false }] }) as never,
    });
    expect(r).toEqual({ address: '10.0.0.9', iface: 'wlan0' });
  });
});

// ---------------------------------------------------------------- proxy host LAN lifecycle
function fakeProxy(log: string[]) {
  return (o: { port: number }) => {
    let lan: { host: string; port: number } | undefined;
    const p: ProxyLike = {
      start: async () => void log.push(`start ${o.port}`),
      stop: async () => void log.push('stop'),
      get port() {
        return o.port;
      },
      setRules: () => undefined,
      getExchanges: () => [],
      clear: () => undefined,
      resume: () => undefined,
      abort: () => undefined,
      on: () => undefined,
      openLan: async ({ host, token }) => {
        log.push(`openLan ${host} tokenLen=${token.length}`);
        lan = { host, port: o.port };
        return lan;
      },
      closeLan: async () => {
        log.push('closeLan');
        lan = undefined;
      },
      get lan() {
        return lan;
      },
    };
    return p;
  };
}

describe('InterceptProxyHost LAN mode', () => {
  it('token: 32 random bytes, base64url, new each time', () => {
    const a = newLanToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(newLanToken()).not.toBe(a);
  });

  it('opens once (concurrent launches share it), reuses the token, closes, reopens with a new token', async () => {
    const log: string[] = [];
    const hostLogs: string[] = [];
    const lanEvents: unknown[] = [];
    const h = new InterceptProxyHost({ getPort: () => 9301, factory: fakeProxy(log), log: (m) => hostLogs.push(m) });
    h.on('lan', (l: unknown) => lanEvents.push(l));
    const [a, b] = await Promise.all([h.openLan('192.168.1.23'), h.openLan('192.168.1.23')]);
    expect(a.token).toBe(b.token);
    expect(log).toEqual(['start 9301', 'openLan 192.168.1.23 tokenLen=43']);
    expect(h.lan).toEqual({ host: '192.168.1.23', port: 9301 });
    expect(Object.values(h.lan!)).not.toContain(a.token);
    await h.closeLan();
    expect(h.lan).toBeUndefined();
    const c = await h.openLan('192.168.1.23');
    expect(c.token).not.toBe(a.token);
    expect(lanEvents).toEqual([{ host: '192.168.1.23', port: 9301 }, undefined, { host: '192.168.1.23', port: 9301 }]);
    // stop() closes the LAN listener too
    await h.stop();
    expect(h.lan).toBeUndefined();
    expect(log.slice(-2)).toEqual(['closeLan', 'stop']);
    // the token never reaches the log
    for (const t of [a.token, c.token]) expect(hostLogs.join('\n')).not.toContain(t);
  });

  it('a changed LAN address reopens only when no iPhone session is live', async () => {
    const log: string[] = [];
    let live = true;
    const h = new InterceptProxyHost({ getPort: () => 9302, factory: fakeProxy(log), canReopenLan: () => !live });
    const first = await h.openLan('192.168.1.23');
    expect(await h.openLan('10.0.0.7')).toEqual(first); // live session keeps the old listener
    live = false;
    const moved = await h.openLan('10.0.0.7');
    expect(moved.host).toBe('10.0.0.7');
    expect(moved.token).not.toBe(first.token);
    expect(log.filter((l) => l.startsWith('openLan') || l === 'closeLan')).toEqual(['openLan 192.168.1.23 tokenLen=43', 'closeLan', 'openLan 10.0.0.7 tokenLen=43']);
  });

  it('keeps the token while an iPhone session launched with it is alive (stale token → 407 on plain http)', async () => {
    let live = false;
    let rotatedWhileLive = 0;
    const h = new InterceptProxyHost({ getPort: () => 9304, factory: fakeProxy([]), canReopenLan: () => !live, onLanTokenRotatedWhileLive: () => rotatedWhileLive++ });
    const first = await h.openLan('192.168.1.23');
    live = true; // the app on the iPhone was built with first.token
    await h.closeLan(); // e.g. the listener was closed/recycled while the session runs
    const again = await h.openLan('192.168.1.23');
    expect(again.token).toBe(first.token);
    expect(rotatedWhileLive).toBe(0);
    live = false; // no session alive: rotation is safe
    await h.closeLan();
    const fresh = await h.openLan('192.168.1.23');
    expect(fresh.token).not.toBe(first.token);
  });

  it('a proxy build without LAN support rejects clearly', async () => {
    const factory = (o: { port: number }) => {
      const p = fakeProxy([])(o) as Partial<ProxyLike>;
      delete p.openLan;
      return p as ProxyLike;
    };
    const h = new InterceptProxyHost({ getPort: () => 9303, factory });
    await expect(h.openLan('192.168.1.23')).rejects.toThrow(/does not support LAN mode/);
  });
});

describe('LanLifecycle', () => {
  function setup() {
    const closes: number[] = [];
    const timers: { fn: () => void; ms: number; cleared?: boolean }[] = [];
    const life = new LanLifecycle({
      closeLan: async () => void closes.push(1),
      graceMs: 1000,
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => void ((t as { cleared?: boolean }).cleared = true),
    });
    return { life, closes, timers };
  }

  it('closes when the last iPhone session ends (also for crashes: terminate is the only signal)', () => {
    const { life, closes } = setup();
    life.opened();
    life.started('s1');
    life.opened(); // second launch while s1 live: no grace timer
    life.started('s2');
    expect(life.ended('s1')).toBe(false);
    expect(closes).toEqual([]);
    expect(life.ended('s2')).toBe(true);
    expect(closes).toEqual([1]);
    expect(life.ended('unrelated')).toBe(false);
  });

  it('grace timer closes a listener whose launch never became a session', () => {
    const { life, closes, timers } = setup();
    life.opened();
    expect(timers).toHaveLength(1);
    timers[0].fn();
    expect(closes).toEqual([1]);
  });

  it('a session starting cancels the grace timer', () => {
    const { life, closes, timers } = setup();
    life.opened();
    life.started('s1');
    expect(timers[0].cleared).toBe(true);
    expect(closes).toEqual([]);
  });
});

// ---------------------------------------------------------------- launch preparation + define composition
describe('prepareLan', () => {
  const lanDeps = (over: Partial<LanDeps> = {}): LanDeps => ({
    classify: async (id) => kindFromId(id),
    address: async () => ({ address: '192.168.1.23', iface: 'en0' }),
    open: async (host) => ({ host, port: 9400, token: 'T0KEN_secret-xyz' }),
    ...over,
  });

  it('opens the LAN listener only for a physical iPhone', async () => {
    const opened: unknown[] = [];
    const deps = lanDeps({ opened: (l) => opened.push(l) });
    expect(await prepareLan(deps, SIM, () => undefined)).toEqual({ physicalIos: false });
    expect(await prepareLan(deps, 'emulator-5554', () => undefined)).toEqual({ physicalIos: false });
    expect(await prepareLan(deps, undefined, () => undefined)).toEqual({ physicalIos: false });
    const logs: string[] = [];
    const r = await prepareLan(deps, PHONE, (m) => logs.push(m));
    expect(r).toEqual({ physicalIos: true, lan: { host: '192.168.1.23', port: 9400, token: 'T0KEN_secret-xyz' } });
    expect(opened).toEqual([{ host: '192.168.1.23', port: 9400, iface: 'en0' }]);
    expect(logs.join()).not.toContain('T0KEN');
  });

  it('no LAN address / open failure → physicalIos without lan + a problem', async () => {
    const none = await prepareLan(lanDeps({ address: async () => undefined }), PHONE, () => undefined);
    expect(none).toMatchObject({ physicalIos: true, problem: expect.stringMatching(/no Wi-Fi\/Ethernet IPv4/) });
    expect(none.lan).toBeUndefined();
    const fails = await prepareLan(lanDeps({ open: async () => Promise.reject(new Error('EADDRNOTAVAIL')) }), PHONE, () => undefined);
    expect(fails).toMatchObject({ physicalIos: true, problem: expect.stringMatching(/EADDRNOTAVAIL/) });
  });
});

describe('rewrite for a physical iPhone', () => {
  let app: string;
  beforeAll(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-lan-'));
    fs.mkdirSync(path.join(app, 'lib'));
    fs.writeFileSync(path.join(app, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.writeFileSync(path.join(app, 'lib', 'main.dart'), 'void main() {}');
  });
  afterAll(() => fs.rmSync(app, { recursive: true, force: true }));
  const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd';
  const lan = { host: '192.168.1.23', port: 9400, token: TOKEN };
  const ctx = (over: Partial<RewriteContext> = {}): RewriteContext => ({
    enabled: true,
    caCertPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    proxyPort: 8899,
    folder: app,
    workspaceFolders: [app],
    ...over,
  });
  const resolved = () => ({ type: 'dart', request: 'launch', program: path.join(app, 'lib', 'main.dart'), cwd: app, debuggerType: 2, toolEnv: {}, deviceId: PHONE, toolArgs: ['-d', PHONE] });
  const proxyDefines = (args: unknown) => (args as string[]).filter((a) => a.includes(`${PROXY_DEFINE}=`));

  it('composes FLUTTER_INTERCEPT_PROXY=flutter-intercept:<token>@<lanIp>:<port>; the token is only in toolArgs', () => {
    const r = rewriteDebugConfig(resolved(), ctx({ physicalIos: true, lan }));
    if (r.kind !== 'rewrite') throw new Error(r.kind);
    expect(proxyDefines(r.config.toolArgs)).toEqual([`--dart-define=${PROXY_DEFINE}=flutter-intercept:${TOKEN}@192.168.1.23:9400`]);
    expect(lanProxyAddress(lan)).toBe(`flutter-intercept:${TOKEN}@192.168.1.23:9400`);
    expect(r.config[HOST_KEY]).toBe('192.168.1.23');
    expect(r.config[MARKER_KEY]).toBe(9400);
    expect(r.config[LAN_KEY]).toBe(true);
    expect(r.proxyHost).toBe('192.168.1.23');
    expect(r.lan).toBe(true);
    expect(r.needsAdbReverse).toBe(false);
    const { toolArgs: _t, ...rest } = r.config;
    expect(JSON.stringify(rest)).not.toContain(TOKEN);
    expect(JSON.stringify(r.plan)).not.toContain(TOKEN); // the entry file never holds it
  });

  it('re-resolve keeps a single proxy define (new token replaces the old)', () => {
    const r1 = rewriteDebugConfig(resolved(), ctx({ physicalIos: true, lan }));
    if (r1.kind !== 'rewrite') throw new Error(r1.kind);
    const lan2 = { ...lan, token: 'second_token' };
    const r2 = rewriteDebugConfig(r1.config, ctx({ physicalIos: true, lan: lan2 }));
    if (r2.kind !== 'rewrite') throw new Error(r2.kind);
    expect(proxyDefines(r2.config.toolArgs)).toEqual([`--dart-define=${PROXY_DEFINE}=flutter-intercept:second_token@192.168.1.23:9400`]);
    expect((r2.config.toolArgs as string[]).join(' ')).not.toContain(TOKEN);
  });

  it('physical iPhone without a LAN address → not intercepted (noLan); a rewritten config is restored', () => {
    const skip = rewriteDebugConfig(resolved(), ctx({ physicalIos: true }));
    expect(skip).toMatchObject({ kind: 'skip', noLan: true });
    const r1 = rewriteDebugConfig(resolved(), ctx({ physicalIos: true, lan }));
    if (r1.kind !== 'rewrite') throw new Error(r1.kind);
    const back = rewriteDebugConfig(r1.config, ctx({ physicalIos: true }));
    if (back.kind !== 'restore') throw new Error(back.kind);
    expect(back.config.program).toBe(path.join(app, 'lib', 'main.dart'));
    expect(back.config[LAN_KEY]).toBeUndefined();
    expect(JSON.stringify(back.config)).not.toContain(TOKEN);
  });

  it('simulator / non-LAN sessions are unchanged (localhost, no LAN key)', () => {
    const r = rewriteDebugConfig({ ...resolved(), deviceId: SIM, toolArgs: ['-d', SIM] }, ctx());
    if (r.kind !== 'rewrite') throw new Error(r.kind);
    expect(r.config[HOST_KEY]).toBe('localhost');
    expect(r.config[LAN_KEY]).toBeUndefined();
    expect(proxyDefines(r.config.toolArgs)).toEqual([`--dart-define=${PROXY_DEFINE}=localhost:8899`]);
  });
});
