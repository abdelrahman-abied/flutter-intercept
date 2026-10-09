import * as os from 'os';
import { describe, expect, it, vi } from 'vitest';
import type { HostMsg } from '../../src/ui/protocol';
import { EventEmitter } from 'events';
import { prepareLan } from '../../src/debug/lanPrepare';
import { kindFromId } from '../../src/iosDevices';
import { lanAddressForIphone } from '../../src/lanAddress';
import { LanNetworkWatcher, netFingerprint, networkChange, parseArpMac, parseGateway, type NetFingerprint } from '../../src/lanWatch';
import { InterceptProxyHost, type ProxyLike } from '../../src/proxyHost';
import { InterceptController } from '../../src/ui/controller';

const PHONE = '00008110-000A1B2C3D4E5F60';
const routeOut = (iface: string, gw = '192.168.1.1') =>
  `   route to: default\ndestination: default\n       mask: default\n    gateway: ${gw}\n  interface: ${iface}\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n`;
const ifacesWith = (map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([n, a]) => [n, [{ address: a, family: 'IPv4', internal: false }]])) as unknown as ReturnType<typeof os.networkInterfaces>;

describe('RFC 1918 required for LAN mode (review 2 #5)', () => {
  const run = (iface: string, ifaces: Record<string, string>) =>
    lanAddressForIphone({ platform: 'darwin', exec: async () => ({ stdout: routeOut(iface), stderr: '' }), interfaces: () => ifacesWith(ifaces) });

  it.each([
    ['10.0.0.5', true],
    ['172.16.4.2', true],
    ['172.31.255.1', true],
    ['192.168.1.23', true],
    ['172.32.0.1', false],
    ['100.64.3.7', false], // CGNAT
    ['8.8.8.8', false], // public
    ['11.0.0.1', false],
  ])('%s → allowed=%s', async (addr, ok) => {
    const r = await run('en0', { en0: addr });
    if (ok) expect(r).toEqual({ address: addr, iface: 'en0' });
    else expect(r).toMatchObject({ problem: expect.stringMatching(/not a private \(RFC 1918\) LAN address/) });
  });

  it('VPN owns the default route: fallback must also be RFC 1918', async () => {
    expect(await run('utun3', { utun3: '10.8.0.5', en0: '192.168.1.23' })).toEqual({ address: '192.168.1.23', iface: 'en0' });
    expect(await run('utun3', { utun3: '10.8.0.5', en0: '100.70.1.2' })).toBeUndefined(); // CGNAT Wi-Fi: refused
    expect(await run('utun3', { utun3: '10.8.0.5', en0: '81.2.3.4' })).toBeUndefined();
  });

  it('prepareLan refuses a non-private address with a clear problem and never opens', async () => {
    const open = vi.fn();
    const r = await prepareLan(
      { classify: async (id) => kindFromId(id), address: async () => ({ problem: "this Mac's network address 100.64.3.7 (en0) is not a private (RFC 1918) LAN address, so the proxy will not listen on it" }), open },
      PHONE,
      () => undefined,
    );
    expect(r).toMatchObject({ physicalIos: true, problem: expect.stringMatching(/RFC 1918/) });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('network change detection (review 2 #5)', () => {
  it('parses route gateway and arp MAC', () => {
    expect(parseGateway(routeOut('en0', '192.168.0.254'))).toBe('192.168.0.254');
    expect(parseArpMac('? (192.168.1.1) at 3c:84:6a:aa:bb:cc on en0 ifscope [ethernet]')).toBe('3c:84:6a:aa:bb:cc');
    expect(parseArpMac('? (192.168.1.1) at (incomplete) on en0 ifscope [ethernet]')).toBeUndefined();
  });

  it('netFingerprint: address from interfaces, gateway + MAC only for the listener interface', async () => {
    const exec = async (f: string) => ({ stdout: f === 'route' ? routeOut('en0') : '? (192.168.1.1) at 3c:84:6a:aa:bb:cc on en0', stderr: '' });
    expect(await netFingerprint('en0', { platform: 'darwin', exec, interfaces: () => ifacesWith({ en0: '192.168.1.23' }) })).toEqual({
      address: '192.168.1.23',
      gateway: '192.168.1.1',
      gatewayMac: '3c:84:6a:aa:bb:cc',
    });
    expect(await netFingerprint('en1', { platform: 'darwin', exec, interfaces: () => ifacesWith({ en1: '10.0.0.2' }) })).toEqual({ address: '10.0.0.2' });
    expect(await netFingerprint('en0', { platform: 'darwin', exec, interfaces: () => ifacesWith({}) })).toEqual({ address: undefined });
  });

  const base: NetFingerprint = { address: '192.168.1.23', gateway: '192.168.1.1', gatewayMac: 'aa:aa:aa:aa:aa:aa' };
  it.each<[string, NetFingerprint, RegExp | undefined]>([
    ['same network', base, undefined],
    ['interface gone', { address: undefined }, /went away/],
    ['address changed', { ...base, address: '192.168.1.40' }, /LAN address changed \(192\.168\.1\.23 → 192\.168\.1\.40\)/],
    ['same DHCP IP, different router (MAC)', { ...base, gatewayMac: 'bb:bb:bb:bb:bb:bb' }, /different network/],
    ['same IP, different gateway', { ...base, gateway: '192.168.1.254' }, /router changed/],
    ['gateway unreadable for a moment (not a change)', { address: '192.168.1.23' }, undefined],
  ])('%s', (_n, now, want) => {
    const r = networkChange('192.168.1.23', base, now);
    if (want) expect(r).toMatch(want);
    else expect(r).toBeUndefined();
  });

  function watcher(snaps: NetFingerprint[]) {
    const changes: string[] = [];
    let ticks = 0;
    let interval: (() => void) | undefined;
    let cleared = 0;
    const w = new LanNetworkWatcher({
      snapshot: async () => snaps.shift() ?? { address: '192.168.1.23' },
      onChange: (r) => changes.push(r),
      onTick: () => ticks++,
      setInterval: (fn) => ((interval = fn), 1),
      clearInterval: () => void cleared++,
    });
    return { w, changes, ticks: () => ticks, interval: () => interval, cleared: () => cleared };
  }

  it('address change while open → onChange once, polling stops', async () => {
    const t = watcher([base, base, { ...base, address: '10.1.1.9' }]);
    await t.w.start('192.168.1.23', 'en0');
    expect(t.w.active).toBe(true);
    await t.w.tick();
    expect(t.ticks()).toBe(1);
    await t.w.tick();
    expect(t.changes).toEqual(['this Mac\'s LAN address changed (192.168.1.23 → 10.1.1.9)']);
    expect(t.w.active).toBe(false);
    expect(t.cleared()).toBe(1);
    await t.w.tick();
    expect(t.changes).toHaveLength(1);
  });

  it('baseline that already disagrees with the listener host fires immediately', async () => {
    const t = watcher([{ address: '192.168.1.99' }]);
    await t.w.start('192.168.1.23', 'en0');
    expect(t.changes[0]).toMatch(/LAN address changed/);
  });

  it('a router signal read later becomes the baseline; then a router change is detected', async () => {
    const t = watcher([{ address: '192.168.1.23' }, base, { ...base, gatewayMac: 'cc:cc:cc:cc:cc:cc' }]);
    await t.w.start('192.168.1.23', 'en0');
    await t.w.tick(); // learns gateway + MAC
    expect(t.changes).toEqual([]);
    await t.w.tick();
    expect(t.changes[0]).toMatch(/different network/);
  });

  it('extension wiring contract: change → closeLan({forgetToken}) → new token even with a live session, no "rotated" warning', async () => {
    let lanOpen: { host: string; port: number } | undefined;
    const factory = (o: { port: number }): ProxyLike => ({
      start: async () => undefined,
      stop: async () => undefined,
      get port() {
        return o.port;
      },
      setRules: () => undefined,
      getExchanges: () => [],
      clear: () => undefined,
      resume: () => undefined,
      abort: () => undefined,
      on: () => undefined,
      openLan: async ({ host }) => (lanOpen = { host, port: o.port }),
      closeLan: async () => void (lanOpen = undefined),
    });
    const rotated = vi.fn();
    const h = new InterceptProxyHost({ getPort: () => 9500, factory, canReopenLan: () => false /* session live */, onLanTokenRotatedWhileLive: rotated });
    const first = await h.openLan('192.168.1.23');
    await h.closeLan({ forgetToken: true });
    expect(lanOpen).toBeUndefined();
    const second = await h.openLan('192.168.1.23');
    expect(second.token).not.toBe(first.token);
    expect(rotated).not.toHaveBeenCalled();
  });
});

describe('pinned peer in the status (review 2 #2)', () => {
  function hostWithPeer() {
    let peer: string | undefined;
    const factory = (o: { port: number }): ProxyLike => ({
      start: async () => undefined,
      stop: async () => undefined,
      get port() {
        return o.port;
      },
      setRules: () => undefined,
      getExchanges: () => [],
      clear: () => undefined,
      resume: () => undefined,
      abort: () => undefined,
      on: () => undefined,
      openLan: async ({ host }) => ({ host, port: o.port }),
      closeLan: async () => undefined,
      get lanPeer() {
        return peer;
      },
    });
    const logs: string[] = [];
    const h = new InterceptProxyHost({ getPort: () => 9600, factory, log: (m) => logs.push(m) });
    return { h, logs, setPeer: (p: string | undefined) => (peer = p) };
  }

  it('lan exposes {host, port, peer} once pinned; refreshLanPeer logs "LAN locked to" and emits once', async () => {
    const { h, logs, setPeer } = hostWithPeer();
    const events: unknown[] = [];
    h.on('lan', (l: unknown) => events.push(l));
    const opened = await h.openLan('192.168.1.23');
    expect(h.lan).toEqual({ host: '192.168.1.23', port: 9600 });
    h.refreshLanPeer();
    expect(events).toHaveLength(1); // only the open
    setPeer('192.168.1.57');
    h.refreshLanPeer();
    h.refreshLanPeer();
    expect(h.lan).toEqual({ host: '192.168.1.23', port: 9600, peer: '192.168.1.57' });
    expect(events).toHaveLength(2);
    expect(logs).toContain('LAN locked to 192.168.1.57');
    expect(logs.join('\n')).not.toContain(opened.token);
  });

  it('the webview Status carries lan.peer and never the token', async () => {
    const { h, setPeer } = hostWithPeer();
    const opened = await h.openLan('192.168.1.23');
    setPeer('192.168.1.57');
    const host = Object.assign(new EventEmitter(), {
      running: true,
      port: 9600,
      get lan() {
        return h.lan;
      },
      getExchanges: () => [],
      getRules: () => [],
      setRules: () => undefined,
      clear: () => undefined,
      resume: () => undefined,
      abort: () => undefined,
    });
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined });
    const replies: HostMsg[] = [];
    await c.handle({ type: 'ready' }, (m) => replies.push(m));
    const snap = replies[0] as Extract<HostMsg, { type: 'snapshot' }>;
    expect(snap.status.lan).toEqual({ host: '192.168.1.23', port: 9600, peer: '192.168.1.57' });
    expect(JSON.stringify(replies)).not.toContain(opened.token);
  });
});
