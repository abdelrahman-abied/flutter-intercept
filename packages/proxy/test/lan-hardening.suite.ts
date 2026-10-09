// Imported by lan.test.ts so it runs in the same file (sequentially) as the other LAN socket tests:
// its 300-connection flood would otherwise starve their timing-based assertions.
// Review 2 (LAN-mode security) regressions: close race (#1), peer pinning + other-interface
// subnets (#2), slowloris / connection-flood DoS (#3).
import { execFile, execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InterceptProxy } from '../src';
import { forbiddenReason, LAN_MAX_PENDING_PER_IP, lanIPv4Addresses, lanTesting } from '../src/lan';
import { currentRoutes, parseNetstatRoutes, refreshRoutes, routesTesting } from '../src/routes';
import { startProxy, startUpstream, type Upstream } from './helpers';

const LAN_IP = lanIPv4Addresses()[0];
// A fresh token per test (beforeEach): a stray connection from an earlier test that lands on a
// new listener which reused its port can't authenticate (or pin a peer) there.
let TOKEN = '';
let AUTH = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
}

// ---------------------------------------------------------------- #2b subnets (unit, synthetic tables)

const iface = (address: string, cidr: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): os.NetworkInterfaceInfo =>
  ({ address, netmask: '', family, mac: '00:00:00:00:00:00', internal, cidr, ...(family === 'IPv6' ? { scopeid: 0 } : {}) }) as os.NetworkInterfaceInfo;

const TABLE: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
  lo0: [iface('127.0.0.1', '127.0.0.1/8', 'IPv4', true), iface('::1', '::1/128', 'IPv6', true)],
  en0: [iface('192.168.1.20', '192.168.1.20/24'), iface('2a02:1:2:3::5', '2a02:1:2:3::5/64', 'IPv6'), iface('fe80::1', 'fe80::1/64', 'IPv6')],
  utun3: [iface('100.101.1.2', '100.101.1.2/32')], // tailnet: peers are elsewhere in 100.64/10
  vnic0: [iface('10.211.55.2', '10.211.55.2/24')], // Parallels host-only
  bridge100: [iface('192.168.64.1', '192.168.64.1/24')], // vmnet / UTM
  utun4: [iface('203.0.113.1', '203.0.113.1/24')], // a VPN handing out PUBLIC space
};

const NETSTAT_HEAD = 'Routing tables\n\nInternet:\nDestination        Gateway            Flags               Netif Expire\n';
const V6_HEAD = '\nInternet6:\nDestination                             Gateway                                 Flags               Netif Expire\n';
// en0 = Wi-Fi (listener). Interface-scoped (I) routes must be ignored.
const BASE_V4 = [
  'default            192.168.1.1        UGScg                 en0',
  'default            100.101.1.1        UGScIg              utun3', // scoped: only for sockets bound to utun3
  '10.211.55/24       link#20            UC                  vnic0',
  '100.64/10          100.101.1.2        UGSc                utun3',
  '127                127.0.0.1          UCS                   lo0',
  '127.0.0.1          127.0.0.1          UH                    lo0',
  '169.254            link#15            UCS                   en0      !',
  '192.168.1          link#15            UCS                   en0      !',
  '192.168.1.50       be:b8:8e:4e:e1:bc  UHLWI                 en0    664',
  '192.168.64         link#22            UC              bridge100',
];
const BASE_V6 = [
  'default                                 fe80::1%en0                             UGcg                  en0',
  'default                                 fe80::%utun0                            UGcIg               utun0',
  '2a02:1:2:3::/64                         link#15                                 UC                    en0',
  'fd12:3456::/48                          fe80::1%utun9                           UGc                 utun9',
  'fe80::%en0/64                           link#15                                 UCI                   en0',
];
const routes = (v4: string[], v6: string[] = BASE_V6) => parseNetstatRoutes(NETSTAT_HEAD + v4.join('\n') + V6_HEAD + v6.join('\n'));

describe('forbiddenReason, route-based (unit, synthetic netstat + interface tables)', () => {
  const r = (ip: string, rt = routes(BASE_V4)) => forbiddenReason(ip, '192.168.1.20', TABLE, rt);

  it('parses netstat: classful shorthand, /n, host routes; skips interface-scoped routes', () => {
    const rt = routes(BASE_V4);
    expect(rt.lookup('192.168.1.77')).toBe('en0'); // "192.168.1" = /24
    expect(rt.lookup('127.5.5.5')).toBe('lo0'); // "127" = /8
    expect(rt.lookup('100.120.0.1')).toBe('utun3'); // 100.64/10
    expect(rt.lookup('8.8.8.8')).toBe('en0'); // the unscoped default, not utun3's scoped one
    expect(rt.lookup('2606:4700::1111')).toBe('en0');
    expect(rt.lookup('fd12:3456::9')).toBe('utun9');
  });

  it('a dev backend on a routed private network reached via the Wi-Fi gateway is ALLOWED', () => {
    expect(r('10.20.30.40')).toBeUndefined(); // via en0 default
    expect(r('172.20.1.1')).toBeUndefined();
    expect(r('192.168.1.50')).toBeUndefined(); // the Wi-Fi subnet
    expect(r('8.8.8.8')).toBeUndefined();
    expect(r('2a02:1:2:3::99')).toBeUndefined();
    expect(r('2606:4700::1111')).toBeUndefined();
  });

  it('VPN peers, VM and bridge networks (routed via other interfaces) are refused', () => {
    expect(r('100.64.0.5')).toMatch(/routed through utun3/); // tailnet peer, utun has only a /32 address
    expect(r('10.211.55.3')).toMatch(/routed through vnic0/);
    expect(r('192.168.64.2')).toMatch(/routed through bridge100/);
    expect(r('fd12:3456::1')).toMatch(/routed through utun9/);
    expect(r('100.101.1.2')).toMatch(/own interfaces/);
    expect(r('127.0.0.1')).toBe('loopback');
  });

  it('full-tunnel VPN (0/1 + 128.0/1 via utun): public addresses refused, the Wi-Fi subnet still allowed', () => {
    const full = routes([...BASE_V4, '0/1                100.101.1.1        UGSc                utun3', '128.0/1            100.101.1.1        UGSc                utun3']);
    expect(r('8.8.8.8', full)).toMatch(/routed through utun3/);
    expect(r('10.20.30.40', full)).toMatch(/routed through utun3/);
    expect(r('192.168.1.50', full)).toBeUndefined();
    // and the same with a plain unscoped default via utun
    const full2 = routes(['default            100.101.1.1        UGSc                utun3', ...BASE_V4.slice(1)]);
    expect(r('93.184.216.34', full2)).toMatch(/routed through utun3/);
    expect(r('192.168.1.50', full2)).toBeUndefined();
  });

  it('split tunnel (10/8 via utun): 10.x refused, the 192.168.1.x LAN allowed', () => {
    const split = routes([...BASE_V4, '10                 100.101.1.1        UGSc                utun3']);
    expect(r('10.20.30.40', split)).toMatch(/routed through utun3/);
    expect(r('10.211.55.3', split)).toMatch(/routed through vnic0/); // the longer prefix wins
    expect(r('192.168.1.50', split)).toBeUndefined();
  });

  it('no route at all is refused', () => {
    expect(r('8.8.8.8', routes(BASE_V4.slice(1)))).toMatch(/not routable/);
  });

  it('routing table unreadable → fail closed: only the Wi-Fi subnet and public addresses', () => {
    const f = (ip: string) => forbiddenReason(ip, '192.168.1.20', TABLE, null);
    expect(f('10.20.30.40')).toMatch(/private network/);
    expect(f('100.64.0.5')).toMatch(/private network/);
    expect(f('10.211.55.3')).toMatch(/subnet of vnic0/);
    expect(f('192.168.64.2')).toMatch(/subnet of bridge100/);
    expect(f('203.0.113.9')).toMatch(/subnet of utun4/);
    expect(f('fd12:3456::1')).toMatch(/private network/);
    expect(f('192.168.1.50')).toBeUndefined();
    expect(f('2a02:1:2:3::99')).toBeUndefined();
    expect(f('8.8.8.8')).toBeUndefined();
  });

  it('the system routing table: read on macOS; elsewhere unavailable, so the fail-closed fallback applies', async () => {
    await refreshRoutes();
    const t = currentRoutes();
    if (process.platform === 'darwin') {
      expect(t?.size ?? 0).toBeGreaterThan(0);
    } else {
      expect(t).toBeNull(); // e.g. ubuntu-latest in CI
      if (LAN_IP) {
        // with no table, a private target outside the listener's subnet is refused…
        expect(forbiddenReason('10.255.254.253', LAN_IP)).toMatch(/private network|subnet of/);
        // …while public space stays allowed
        expect(forbiddenReason('93.184.216.34', LAN_IP)).toBeUndefined();
      }
    }
  });

  it("this machine's real routing table: destinations routed via other interfaces are refused", async () => {
    if (!LAN_IP || process.platform !== 'darwin') return;
    await refreshRoutes();
    const text = execFileSync('/usr/sbin/netstat', ['-rn', '-f', 'inet']).toString();
    const rt = parseNetstatRoutes(text);
    const listenerIface = Object.entries(os.networkInterfaces()).find(([, l]) => l?.some((i) => i.address === LAN_IP))?.[0];
    let checked = 0;
    for (const line of text.split('\n')) {
      const c = line.trim().split(/\s+/);
      if (c.length < 4 || !/^\d+\.\d+\.\d+\.\d+$/.test(c[0]) || !c[2].includes('H') || c[2].includes('I')) continue;
      if (c[3] === listenerIface || c[3] === 'lo0' || rt.lookup(c[0]) !== c[3]) continue;
      expect(forbiddenReason(c[0], LAN_IP), `${c[0]} via ${c[3]}`).toBeDefined();
      if (++checked >= 50) break;
    }
    const parts = LAN_IP.split('.');
    parts[3] = parts[3] === '50' ? '51' : '50';
    expect(forbiddenReason(parts.join('.'), LAN_IP)).toBeUndefined(); // a Wi-Fi neighbour
    if (rt.lookup('8.8.8.8') === listenerIface) expect(forbiddenReason('8.8.8.8', LAN_IP)).toBeUndefined();
    console.log(`[routes] real table: ${rt.size} routes, ${checked} other-interface host routes refused`);
  });
});

// ---------------------------------------------------------------- socket tests

function rawRequest(port: number, data: string, idleMs = 400, localPortCb?: (p: number) => void): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = net.connect(port, LAN_IP!);
    let text = '';
    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (s.destroy(), resolve({ text, closed: false })), idleMs);
    };
    s.on('connect', () => {
      localPortCb?.(s.localPort!);
      s.write(data);
      arm();
    });
    s.on('data', (d) => ((text += d.toString('latin1')), arm()));
    s.on('close', () => (clearTimeout(timer), resolve({ text, closed: true })));
    s.on('error', () => undefined);
  });
}

describe.skipIf(!LAN_IP)(`LAN hardening on ${LAN_IP ?? '(no LAN IPv4)'}`, () => {
  let up: Upstream; // allowed upstream (test seam), on the LAN IP
  let secret: Upstream; // 127.0.0.1-only service a LAN client must never reach
  let proxy: InterceptProxy;
  let lanPort: number;
  let upPorts: Set<number>;

  // Fresh upstreams per test: requests a previous test left in flight (the close-race test
  // forwards thousands) must land on a CLOSED server, not on this test's hit counters.
  beforeEach(async () => {
    TOKEN = randomBytes(32).toString('base64url');
    AUTH = `Basic ${Buffer.from(`flutter-intercept:${TOKEN}`).toString('base64')}`;
    up = await startUpstream(LAN_IP);
    secret = await startUpstream();
    upPorts = new Set([Number(new URL(up.httpUrl).port), Number(new URL(up.httpsUrl).port)]);
    lanTesting.allowTarget = (ip, port) => ip === LAN_IP && upPorts.has(port);
    proxy = await startProxy();
    lanPort = (await proxy.openLan({ host: LAN_IP!, token: TOKEN })).port;
  });
  afterEach(async () => {
    await proxy.stop();
    await up.close();
    await secret.close();
    for (const k of Object.keys(lanTesting)) delete (lanTesting as Record<string, unknown>)[k];
  });

  /**
   * Deterministic fake peer IPs: the gate asks peerOf() at accept time, so map sockets in accept
   * order from a queue (connections are opened one at a time and each waits until it's taken).
   */
  function fakePeers() {
    const queue: string[] = [];
    const seen = new WeakMap<net.Socket, string>();
    lanTesting.peerOf = (s) => {
      if (!seen.has(s)) seen.set(s, queue.shift() ?? 'unexpected-peer');
      return seen.get(s);
    };
    return {
      /** rawRequest() as `ip`. */
      async as(ip: string, data: string, idleMs = 1000) {
        queue.push(ip);
        const r = rawRequest(lanPort, data, idleMs);
        await until(() => queue.length === 0, 2000);
        return r;
      },
      async connect(ip: string): Promise<net.Socket> {
        queue.push(ip);
        const s = net.connect(lanPort, LAN_IP!);
        s.on('error', () => undefined);
        await new Promise((r) => s.on('connect', r));
        await until(() => queue.length === 0, 2000);
        return s;
      },
    };
  }

  const secretUrl = () => `http://0.0.0.0:${new URL(secret.httpUrl).port}/after-close`;
  const plainGet = (url: string, auth = true) =>
    `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${auth ? `Proxy-Authorization: ${AUTH}\r\n` : ''}\r\n`;

  it('#1 close race: hammering connections during closeLan leaves no survivor that reaches a loopback service', async () => {
    const open: net.Socket[] = [];
    let stop = false;
    const request = plainGet(`${up.httpUrl}/json`); // fixed now: this test's token, this test's upstream
    const gen = setInterval(() => {
      if (stop) return;
      for (let i = 0; i < 5; i++) {
        const s = net.connect(lanPort, LAN_IP!);
        s.on('error', () => undefined);
        s.on('data', () => undefined); // keep reading, so a server-side close is noticed
        s.on('connect', () => s.write(request));
        open.push(s);
      }
    }, 1);
    await sleep(400);
    await proxy.closeLan();
    await sleep(200);
    stop = true;
    clearInterval(gen);
    await sleep(500);
    const survivors = open.filter((s) => !s.destroyed && !s.closed);
    const replies: string[] = [];
    for (const s of survivors) {
      s.on('data', (d) => replies.push(d.toString().split('\r\n')[0]));
      s.write(plainGet(secretUrl(), false)); // no token, loopback-only target
    }
    await sleep(800);
    console.log(`[race] opened ${open.length}, survivors ${survivors.length}, replies ${JSON.stringify([...new Set(replies)])}, secret hits ${secret.hits.length}`);
    expect(open.length).toBeGreaterThan(100); // CI runners are slower than a dev Mac
    expect(survivors.length).toBe(0);
    expect(secret.hits).toEqual([]);
    await Promise.all(open.map((s) => new Promise<void>((r) => (s.closed ? r() : (s.once('close', () => r()), s.destroy())))));
  }, 30_000);

  it('#1 guards are keyed on the socket: survivors of a closed gate get 407 / 403, never an upstream', async () => {
    lanTesting.keepSocketsOnClose = true; // simulate the old race: sockets outlive closeLan
    // an authenticated plain keep-alive socket and an authenticated CONNECT tunnel, opened before close
    const plain = net.connect(lanPort, LAN_IP!);
    let plainText = '';
    plain.on('data', (d) => (plainText += d));
    plain.on('error', () => undefined);
    await new Promise((r) => plain.on('connect', r));
    plain.write(plainGet(`${up.httpUrl}/json`));
    await until(() => plainText.includes('{"hello":"world"}'));
    expect(plainText).toMatch(/^HTTP\/1\.1 200/);

    const target = new URL(up.httpsUrl).host;
    const tunnel = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const c = http.request({ host: LAN_IP, port: lanPort, method: 'CONNECT', path: target, headers: { 'proxy-authorization': AUTH } });
      c.on('connect', (res, socket) => {
        if (res.statusCode !== 200) return reject(new Error(String(res.statusCode)));
        resolve(tls.connect({ socket, rejectUnauthorized: false, servername: 'localhost' }));
      });
      c.on('error', reject);
      c.end();
    });
    await new Promise((r) => tunnel.once('secureConnect', r));

    await proxy.closeLan();
    expect(proxy.lan).toBeUndefined();

    plainText = '';
    plain.write(plainGet(secretUrl(), false)); // no token
    await until(() => plainText.length > 0);
    expect(plainText).toMatch(/^HTTP\/1\.1 407/);

    let tunnelText = '';
    tunnel.on('data', (d) => (tunnelText += d));
    tunnel.on('error', () => undefined);
    tunnel.write(`GET /json HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    await until(() => tunnelText.length > 0);
    expect(tunnelText).toMatch(/^HTTP\/1\.1 (403|407)/);

    expect(secret.hits).toEqual([]);
    expect(up.hits).toEqual(['GET /json']); // only the request made before closeLan
    plain.destroy();
    tunnel.destroy();
  }, 20_000);

  it('#2a pins the first authenticated peer; another IP with the valid token gets 407; rotation re-pins', async () => {
    const peers = fakePeers();
    const pinned: string[] = [];
    proxy.on('lan-peer', (ip) => pinned.push(ip));
    expect(proxy.lanPeer).toBeUndefined();

    const asPeer = (ip: string, data: string) => peers.as(ip, data);
    expect((await asPeer('192.168.1.77', plainGet(`${up.httpUrl}/json?a`))).text).toMatch(/^HTTP\/1\.1 200/);
    expect(proxy.lanPeer).toBe('192.168.1.77');
    expect(pinned).toEqual(['192.168.1.77']);
    const other = await asPeer('192.168.1.66', plainGet(`${up.httpUrl}/json?b`));
    expect(other.text).toMatch(/^HTTP\/1\.1 407/);
    expect(other.closed).toBe(true);
    const otherConnect = await asPeer('192.168.1.66', `CONNECT ${new URL(up.httpsUrl).host} HTTP/1.1\r\nProxy-Authorization: ${AUTH}\r\n\r\n`);
    expect(otherConnect.text).toMatch(/^HTTP\/1\.1 407/);
    expect((await asPeer('192.168.1.77', plainGet(`${up.httpUrl}/json?c`))).text).toMatch(/^HTTP\/1\.1 200/);
    expect(up.hits).toEqual(['GET /json', 'GET /json']);

    const { port } = await proxy.openLan({ host: LAN_IP!, token: TOKEN }); // new token epoch
    lanPort = port;
    expect(proxy.lanPeer).toBeUndefined();
    expect((await asPeer('192.168.1.66', plainGet(`${up.httpUrl}/json?d`))).text).toMatch(/^HTTP\/1\.1 200/);
    expect(proxy.lanPeer).toBe('192.168.1.66');
  });

  it('route-based guard end to end: a target routed via another interface gets 403 without connecting', async () => {
    const listenerIface = Object.entries(os.networkInterfaces()).find(([, l]) => l?.some((i) => i.address === LAN_IP))?.[0] ?? 'en0';
    routesTesting.table = parseNetstatRoutes(
      NETSTAT_HEAD + `default 192.168.1.1 UGSc ${listenerIface}\n192.0.2/24 100.101.1.1 UGSc utun99\n`,
    );
    try {
      const r = await rawRequest(lanPort, plainGet('http://192.0.2.10:8080/api'), 1500);
      expect(r.text).toMatch(/^HTTP\/1\.1 403/);
      expect(r.text).toMatch(/routed through utun99/);
      const c = await rawRequest(lanPort, `CONNECT 192.0.2.10:443 HTTP/1.1\r\nProxy-Authorization: ${AUTH}\r\n\r\n`, 1500);
      expect(c.text).toMatch(/^HTTP\/1\.1 403/);
    } finally {
      delete routesTesting.table;
    }
  });

  it('a client paused right after connecting (debugger on a cold start) is still served after 15 s; a wrong token after the wait gets 407', async () => {
    const open = (): Promise<net.Socket> =>
      new Promise((resolve) => {
        const s = net.connect(lanPort, LAN_IP!);
        s.on('error', () => undefined);
        s.on('connect', () => resolve(s));
      });
    const [good, bad] = await Promise.all([open(), open()]);
    const read = (s: net.Socket) => {
      let t = '';
      let closed = false;
      s.on('data', (d) => (t += d));
      s.on('close', () => (closed = true));
      return () => ({ t, closed });
    };
    const g = read(good);
    const b = read(bad);
    await sleep(15_000); // silent: the isolate is paused before it writes the request head
    expect(g().closed).toBe(false);
    good.write(plainGet(`${up.httpUrl}/json`));
    bad.write(`GET ${up.httpUrl}/json HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from('flutter-intercept:wrong-wrong-wrong').toString('base64')}\r\n\r\n`);
    await until(() => g().t.includes('{"hello":"world"}') && b().closed, 5000);
    expect(g().t).toMatch(/^HTTP\/1\.1 200/);
    expect(b().t).toMatch(/^HTTP\/1\.1 407/);
    good.destroy();
    bad.destroy();
  }, 30_000);

  it('#3 slowloris: the head deadline is absolute (trickling bytes does not extend it)', async () => {
    lanTesting.headDeadlineMs = 500;
    const s = net.connect(lanPort, LAN_IP!);
    s.on('error', () => undefined);
    const t0 = Date.now();
    const closedAt = new Promise<number>((r) => s.on('close', () => r(Date.now() - t0)));
    s.on('connect', () => s.write('GET http://x/ HTTP/1.1\r\n'));
    const trickle = setInterval(() => !s.destroyed && s.write('X'), 100);
    const ms = await closedAt;
    clearInterval(trickle);
    expect(ms).toBeGreaterThanOrEqual(450);
    expect(ms).toBeLessThan(4000); // generous for loaded CI runners; without the fix it never closes
  });

  it('#3 two-phase deadline: a silent socket gets the long one; its first byte starts the short absolute one', async () => {
    lanTesting.headDeadlineMs = 300;
    lanTesting.silentDeadlineMs = 2000;
    const s = net.connect(lanPort, LAN_IP!);
    s.on('error', () => undefined);
    let closedAt = 0;
    const t0 = Date.now();
    s.on('close', () => (closedAt = Date.now()));
    await new Promise((r) => s.on('connect', r));
    await sleep(1000); // silent for longer than the head deadline: still open
    expect(closedAt).toBe(0);
    const firstByte = Date.now();
    s.write('G');
    const trickle = setInterval(() => !s.destroyed && s.write('E'), 50);
    await until(() => closedAt > 0, 3000);
    clearInterval(trickle);
    expect(closedAt - firstByte).toBeGreaterThanOrEqual(250);
    expect(closedAt - firstByte).toBeLessThan(3000);
    // and a socket that never sends anything is dropped at the silent deadline
    const quiet = net.connect(lanPort, LAN_IP!);
    quiet.on('error', () => undefined);
    const q0 = Date.now();
    const quietClosed = await new Promise<number>((r) => quiet.on('close', () => r(Date.now() - q0)));
    expect(quietClosed).toBeGreaterThanOrEqual(1900);
    expect(quietClosed).toBeLessThan(6000);
    expect(t0).toBeGreaterThan(0);
  }, 15_000);

  it(`#3 at most ${LAN_MAX_PENDING_PER_IP} unauthenticated heads per IP; the rest are dropped at accept`, async () => {
    const socks = Array.from({ length: LAN_MAX_PENDING_PER_IP + 8 }, () => {
      const s = net.connect(lanPort, LAN_IP!);
      s.on('error', () => undefined);
      return s;
    });
    // wait until every socket is settled (connected, or connected and then dropped by the gate)
    const gate = () => (proxy as unknown as { lanGate: { pendingPerIp: Map<string, number> } }).lanGate;
    await until(() => socks.filter((s) => s.closed).length >= 8 && socks.every((s) => s.closed || s.readyState === 'open'), 10_000);
    await until(() => [...gate().pendingPerIp.values()].reduce((a, b) => a + b, 0) === LAN_MAX_PENDING_PER_IP, 5000);
    await sleep(100);
    const alive = socks.filter((s) => !s.closed).length;
    expect(alive).toBe(LAN_MAX_PENDING_PER_IP);
    await Promise.all(socks.map((s) => new Promise<void>((r) => (s.closed ? r() : (s.once('close', () => r()), s.destroy())))));
    await until(() => gate().pendingPerIp.size === 0, 5000); // the gate has seen them go
    // once they are gone, an authenticated client gets through again
    expect((await rawRequest(lanPort, plainGet(`${up.httpUrl}/json`))).text).toMatch(/^HTTP\/1\.1 200/);
  });

  it('#3 a full gate evicts other hosts\' silent sockets so the pinned phone still gets in', async () => {
    const peers = fakePeers();
    const connect = (ip: string) => peers.connect(ip);
    const phoneGet = async () => {
      const s = await connect('192.168.1.77');
      let t = '';
      s.on('data', (d) => (t += d));
      s.write(plainGet(`${up.httpUrl}/json`));
      await until(() => t.includes('{"hello":"world"}'), 3000);
      s.destroy();
      return t;
    };
    expect(await phoneGet()).toMatch(/^HTTP\/1\.1 200/); // pins the phone
    const squat: net.Socket[] = [];
    for (let h = 0; h < 8; h++) for (let i = 0; i < 16; i++) squat.push(await connect(`192.168.0.${100 + h}`));
    await sleep(200);
    expect(squat.filter((s) => !s.destroyed && !s.closed).length).toBe(128); // the gate is full
    expect(await phoneGet()).toMatch(/^HTTP\/1\.1 200/);
    await sleep(100);
    expect(squat.filter((s) => s.closed).length).toBeGreaterThanOrEqual(1); // one squatter was evicted
    squat.forEach((s) => s.destroy());
  }, 30_000);

  it('#3 flood of 300 slow 64 KB heads (reviewer script): RSS bounded, proxy keeps serving', async () => {
    global.gc?.();
    const rss0 = process.memoryUsage().rss;
    let maxLag = 0;
    let last = process.hrtime.bigint();
    const lagTimer = setInterval(() => {
      const now = process.hrtime.bigint();
      maxLag = Math.max(maxLag, Number(now - last) / 1e6 - 10);
      last = now;
    }, 10);
    const out = await new Promise<string>((resolve) =>
      execFile(process.execPath, [path.join(__dirname, 'fixtures', 'lan_dos_client.cjs'), LAN_IP!, String(lanPort), '300', '4000'], (_e, so) => resolve(so)),
    );
    clearInterval(lagTimer);
    const grew = (process.memoryUsage().rss - rss0) / 1024 / 1024;
    console.log(`[dos] ${out.trim()} maxLag=${maxLag.toFixed(0)}ms rssGrowth=${grew.toFixed(1)}MB`);
    expect(grew).toBeLessThan(40); // reviewer measured +50 MB before; 16 heads × 64 KB is ~1 MB
    // Lag is environment-dependent (a bare accept+drop of the same burst costs 100–650 ms on a dev
    // Mac); this only guards against a pathological stall. RSS above is the real assertion.
    expect(maxLag).toBeLessThan(5000);
    // The proxy must recover and serve again. Not instantly: right after the flood the kernel's
    // accept queue can still be full (macOS somaxconn 128), so a new SYN is retransmitted after
    // 1 s, 2 s, 4 s… (measured on Node 22: first byte after 2.7–8 s). Retry for up to 20 s.
    let served = '';
    const deadline = Date.now() + 20_000;
    while (!served.startsWith('HTTP/1.1 200') && Date.now() < deadline) {
      served = (await rawRequest(lanPort, plainGet(`${up.httpUrl}/json`), 3000)).text;
    }
    expect(served).toMatch(/^HTTP\/1\.1 200/);
  }, 45_000);
});
