// LAN mode (CONTRACTS §7): token gate, SSRF guard, fail-closed bind.
// Socket-level tests need a real LAN IPv4 on this machine (skipped otherwise); unit tests always run.
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InterceptProxy, Rule } from '../src';
import {
  forbiddenReason,
  guardedLookup,
  GuardedHttpAgent,
  lanIPv4Addresses,
  lanTesting,
  normalizeIp,
  proxyAuthOk,
  SsrfError,
} from '../src/lan';
import { inState, nextExchange, settled, startProxy, startUpstream, type Upstream } from './helpers';

const LAN_IP = lanIPv4Addresses()[0];
const TOKEN = 'k3Jr7QW1yFv0dE2s9pX8aB4cN6mZ5tLhGqUoRiYeWnA'; // 43 chars, like base64url(32 bytes)
const auth = (token = TOKEN, user = 'flutter-intercept') =>
  `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

// ---------------------------------------------------------------- unit

describe('LAN helpers (unit)', () => {
  it('proxyAuthOk: exact user + token only', () => {
    expect(proxyAuthOk(auth(), TOKEN)).toBe(true);
    expect(proxyAuthOk(auth().replace('Basic', 'basic'), TOKEN)).toBe(true);
    expect(proxyAuthOk(undefined, TOKEN)).toBe(false);
    expect(proxyAuthOk('', TOKEN)).toBe(false);
    expect(proxyAuthOk(auth('wrong'), TOKEN)).toBe(false);
    expect(proxyAuthOk(auth(TOKEN, 'someone'), TOKEN)).toBe(false);
    expect(proxyAuthOk(auth(TOKEN + 'x'), TOKEN)).toBe(false);
    expect(proxyAuthOk(`Bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(proxyAuthOk([auth(), auth()], TOKEN)).toBe(false); // repeated header
  });

  it('normalizeIp folds IPv4-mapped IPv6 and zone ids', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('[::FFFF:7f00:1]')).toBe('127.0.0.1');
    expect(normalizeIp('fe80::1%en0')).toBe('fe80::1');
  });

  it('forbiddenReason: loopback, unspecified, link-local, own interfaces', () => {
    for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(forbiddenReason(ip)).toBe('loopback');
    }
    for (const ip of ['0.0.0.0', '0.1.2.3', '::']) expect(forbiddenReason(ip)).toBe('unspecified');
    for (const ip of ['169.254.1.1', '169.254.169.254', 'fe80::1', 'febf::1']) expect(forbiddenReason(ip)).toBe('link-local');
    for (const ip of lanIPv4Addresses()) expect(forbiddenReason(ip)).toMatch(/own interfaces/);
    for (const ip of Object.values(os.networkInterfaces()).flat()) expect(forbiddenReason(ip!.address)).toBeDefined();
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '10.123.45.67']) {
      if (!lanIPv4Addresses().includes(ip)) expect(forbiddenReason(ip)).toBeUndefined();
    }
  });

  it('guardedLookup rejects a name that (re)resolves to a forbidden address at connect time', async () => {
    const rebinding = (_h: string, o: any, cb: any) =>
      o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    for (const all of [false, true]) {
      const err = await new Promise<unknown>((r) => guardedLookup(rebinding, 443)('evil.example', { all }, (e: unknown) => r(e)));
      expect(err).toBeInstanceOf(SsrfError);
    }
    const fine = (_h: string, _o: any, cb: any) => cb(null, '93.184.216.34', 4);
    const res = await new Promise<unknown[]>((r) => guardedLookup(fine, 443)('ok.example', {}, (...a: unknown[]) => r(a)));
    expect(res).toEqual([null, '93.184.216.34', 4]);
  });

  it('GuardedHttpAgent refuses IP-literal forbidden targets without connecting', async () => {
    const agent = new GuardedHttpAgent();
    const err = await new Promise<unknown>((resolve) => {
      http.get({ host: '127.0.0.1', port: 9, agent }, () => resolve(undefined)).on('error', resolve);
    });
    expect(err).toBeInstanceOf(SsrfError);
    agent.destroy();
  });
});

// ---------------------------------------------------------------- sockets

interface RawResult {
  text: string;
  closed: boolean;
}

/** Write raw bytes, read until the peer closes (or `idleMs` of silence). */
function raw(host: string, port: number, chunks: string[], idleMs = 1000): Promise<RawResult> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    let text = '';
    let closed = false;
    let timer: NodeJS.Timeout;
    const done = () => resolve({ text, closed });
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        s.destroy();
        done();
      }, idleMs);
    };
    s.on('connect', () => {
      for (const c of chunks) s.write(c);
      arm();
    });
    s.on('data', (d) => {
      text += d.toString('latin1');
      arm();
    });
    s.on('close', () => {
      closed = true;
      clearTimeout(timer);
      done();
    });
    s.on('error', () => undefined);
  });
}

const get = (url: string, extra = '') => `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${extra}\r\n`;
const connect = (target: string, extra = '') => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`;
const authLine = (v = auth()) => `Proxy-Authorization: ${v}\r\n`;

/** A request through the LAN listener with Node's client (absolute URI, with credentials). */
function lanGet(port: number, url: string, token = TOKEN): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: LAN_IP, port, path: url, headers: { host: new URL(url).host, 'proxy-authorization': auth(token) }, agent: false },
        (res) => {
          let t = '';
          res.on('data', (d) => (t += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
        },
      )
      .on('error', reject);
  });
}

describe.skipIf(!LAN_IP)(`LAN mode on ${LAN_IP ?? '(no LAN IPv4)'}`, () => {
  let up: Upstream; // upstream on the LAN IP, exempted from the SSRF guard by the test seam
  let loopUp: Upstream; // the same kind of upstream on loopback, for the loopback listener
  let other: Upstream; // a live local service (loopback) the LAN must NOT reach
  let otherLan: Upstream; // a live service on the LAN IP the LAN must NOT reach
  let proxy: InterceptProxy;
  let lanPort: number;
  let allowed: Set<number>;

  // Fresh upstreams per test, so nothing a previous test left in flight can touch these counters.
  beforeEach(async () => {
    up = await startUpstream(LAN_IP);
    loopUp = await startUpstream();
    other = await startUpstream();
    otherLan = await startUpstream(LAN_IP);
    allowed = new Set([Number(new URL(up.httpUrl).port), Number(new URL(up.httpsUrl).port)]);
    // Only `up` (on this machine's LAN IP) is exempt; everything else local stays forbidden.
    lanTesting.allowTarget = (ip, port) => ip === LAN_IP && allowed.has(port);
    proxy = await startProxy();
    lanPort = (await proxy.openLan({ host: LAN_IP!, token: TOKEN })).port;
  });
  afterEach(async () => {
    await proxy.stop();
    await Promise.all([up.close(), loopUp.close(), other.close(), otherLan.close()]);
    delete lanTesting.allowTarget;
    delete lanTesting.bindHostOverride;
  });

  it('binds exactly the LAN IPv4; loopback keeps working without a token; closeLan really closes', async () => {
    expect(proxy.lan).toEqual({ host: LAN_IP, port: lanPort });
    expect(lanPort).not.toBe(8899);
    const loop = await raw('127.0.0.1', proxy.port, [get(`${loopUp.httpUrl}/json`)]);
    expect(loop.text).toMatch(/^HTTP\/1\.1 200/);
    // the LAN port is not open on loopback
    const lo = await raw('127.0.0.1', lanPort, [get(`${up.httpUrl}/json`, authLine())]);
    expect(lo.text).toBe('');
    await proxy.closeLan();
    expect(proxy.lan).toBeUndefined();
    const after = await raw(LAN_IP!, lanPort, [get(`${up.httpUrl}/json`, authLine())]);
    expect(after).toEqual({ text: '', closed: true });
    // loopback unaffected by closeLan
    expect((await raw('127.0.0.1', proxy.port, [get(`${loopUp.httpUrl}/json`)])).text).toMatch(/^HTTP\/1\.1 200/);
  });

  it('407 + close for missing / wrong credentials, plain and CONNECT, with no detail', async () => {
    const target = new URL(up.httpsUrl).host;
    const cases = [
      [get(`${up.httpUrl}/json`)],
      [get(`${up.httpUrl}/json`, authLine(auth('wrong-token-wrong-token')))],
      [get(`${up.httpUrl}/json`, authLine(auth(TOKEN, 'admin')))],
      [connect(target)],
      [connect(target, authLine(auth('wrong-token-wrong-token')))],
    ];
    for (const c of cases) {
      const r = await raw(LAN_IP!, lanPort, c);
      expect(r.closed).toBe(true);
      expect(r.text).toMatch(/^HTTP\/1\.1 407 Proxy Authentication Required\r\n/);
      expect(r.text).not.toMatch(/token|flutter|intercept/i);
      expect(r.text.endsWith('\r\n\r\n')).toBe(true); // empty body
    }
    expect(up.hits).toEqual([]);
    expect(proxy.getExchanges()).toEqual([]); // unauthenticated junk is not recorded
  });

  it('checks EVERY request on a keep-alive connection', async () => {
    const r = await raw(LAN_IP!, lanPort, [get(`${up.httpUrl}/json`, authLine()), get(`${up.httpUrl}/json?second=1`)]);
    expect(r.text).toMatch(/^HTTP\/1\.1 200/);
    expect(r.text).toMatch(/HTTP\/1\.1 407 Proxy Authentication Required/);
    expect(r.closed).toBe(true);
    expect(up.hits).toEqual(['GET /json']);
  });

  it('a CONNECT after plain requests on the same connection is torn down before anything is tunnelled', async () => {
    // mockttp answers CONNECT itself ("200"), so the gate can only close the connection right after.
    const target = new URL(up.httpsUrl).host;
    const r = await raw(LAN_IP!, lanPort, [get(`${up.httpUrl}/json`, authLine()), connect(target, authLine()), 'GET /json HTTP/1.1\r\nHost: x\r\n\r\n']);
    expect(r.closed).toBe(true);
    expect(up.hits.filter((h) => h === 'GET /json').length).toBeLessThanOrEqual(1);
  });

  it('right token: plain request is intercepted and the credentials are not forwarded upstream', async () => {
    const r = await lanGet(lanPort, `${up.httpUrl}/echo`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).headers['proxy-authorization']).toBeUndefined();
    const [ex] = await settled(proxy);
    expect(ex).toMatchObject({ state: 'completed', url: `${up.httpUrl}/echo` });
  });

  it('mutate rule (v0.4.0): applies to LAN clients; the SSRF guard still refuses local targets first', async () => {
    proxy.setRules([{ id: 'mut', enabled: true, match: { url: '*' }, action: { kind: 'mutate', ops: [{ path: '$.hello', op: 'null' }] } }]);
    const r = await lanGet(lanPort, `${up.httpUrl}/json`);
    expect(r).toEqual({ status: 200, text: '{"hello":null}' });
    const denied = await lanGet(lanPort, `http://127.0.0.1:${new URL(other.httpUrl).port}/json`);
    expect(denied.status).toBe(403);
    expect(other.hits).toEqual([]);
    const ex = await settled(proxy);
    expect(ex.map((e) => [e.state, e.viaLan, e.simulated])).toEqual([
      ['completed', true, 'Mutated: $.hello → null'],
      ['error', true, undefined],
    ]);
  });

  it('SSRF: loopback, localhost, ::1, the LAN IP itself and link-local are refused (403, recorded as error)', async () => {
    const otherPort = new URL(other.httpUrl).port;
    const targets = [
      `http://127.0.0.1:${otherPort}/`,
      `http://localhost:${otherPort}/`,
      `http://[::1]:${otherPort}/`,
      `http://${LAN_IP}:${new URL(otherLan.httpUrl).port}/`,
      `http://${LAN_IP}:${lanPort}/`, // the proxy itself
      `http://169.254.169.254/latest/meta-data/`,
      `http://0.0.0.0:${otherPort}/`,
    ];
    for (const url of targets) {
      const r = await lanGet(lanPort, url);
      expect(r.status, url).toBe(403);
      expect(r.text).toMatch(/blocked a LAN client's request/);
    }
    expect(other.hits).toEqual([]);
    expect(otherLan.hits).toEqual([]);
    const ex = await settled(proxy);
    expect(ex.map((e) => e.state)).toEqual(targets.map(() => 'error'));
    expect(ex[1].error).toMatch(/localhost \(127\.0\.0\.1\): loopback/);
  });

  it('SSRF: CONNECT to a local target is refused before tunnelling (403, recorded)', async () => {
    const r = await raw(LAN_IP!, lanPort, [connect(`127.0.0.1:${new URL(other.httpsUrl).port}`, authLine())]);
    expect(r.text).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(r.closed).toBe(true);
    const [ex] = proxy.getExchanges();
    expect(ex).toMatchObject({ method: 'CONNECT', state: 'error', status: 403 });
  });

  it('SSRF: inside an allowed tunnel, a request whose Host points at a local service is refused', async () => {
    const allowedTarget = new URL(up.httpsUrl).host;
    const forbiddenHost = `127.0.0.1:${new URL(other.httpsUrl).port}`; // and mockttp would map it to LAN_IP
    const text = await new Promise<string>((resolve, reject) => {
      const c = http.request({ host: LAN_IP, port: lanPort, method: 'CONNECT', path: allowedTarget, headers: { 'proxy-authorization': auth() } });
      c.on('connect', (res, socket) => {
        if (res.statusCode !== 200) return reject(new Error(`CONNECT ${res.statusCode}`));
        const t = tls.connect({ socket, rejectUnauthorized: false, servername: 'localhost' });
        http
          .get({ path: '/json', headers: { host: forbiddenHost }, createConnection: () => t }, (r) => {
            let b = '';
            r.on('data', (d) => (b += d));
            r.on('end', () => resolve(`${r.statusCode} ${b}`));
          })
          .on('error', reject);
      });
      c.on('error', reject);
      c.end();
    });
    expect(text).toMatch(/^403 .*blocked a LAN client's request/);
    expect(other.hits).toEqual([]);
  });

  it('bind fails CLOSED: a listener that ends up on another address is closed and openLan throws', async () => {
    await proxy.closeLan();
    lanTesting.bindHostOverride = '0.0.0.0';
    await expect(proxy.openLan({ host: LAN_IP!, token: TOKEN, port: lanPort })).rejects.toThrow(
      /LAN listener bound to 0\.0\.0\.0 instead of .*refusing to run/,
    );
    expect(proxy.lan).toBeUndefined();
    expect((await raw('127.0.0.1', lanPort, ['x'])).text).toBe('');
    const probe = await new Promise<boolean>((r) => {
      const s = net.connect(lanPort, '127.0.0.1');
      s.on('connect', () => (s.destroy(), r(true)));
      s.on('error', () => r(false));
    });
    expect(probe).toBe(false);
  });

  it('openLan validates host and token', async () => {
    for (const host of ['0.0.0.0', '127.0.0.1', '::', 'localhost', '203.0.113.7']) {
      await expect(proxy.openLan({ host, token: TOKEN })).rejects.toThrow();
    }
    await expect(proxy.openLan({ host: LAN_IP!, token: 'short' })).rejects.toThrow(/token/);
  });

  it('re-opening rotates the token', async () => {
    const { port } = await proxy.openLan({ host: LAN_IP!, token: 'A'.repeat(43) });
    expect((await raw(LAN_IP!, port, [get(`${up.httpUrl}/json`, authLine())])).text).toMatch(/^HTTP\/1\.1 407/);
    expect((await lanGet(port, `${up.httpUrl}/json`, 'A'.repeat(43))).status).toBe(200);
  });

  // ------------------------------------------------------------ v0.3.0: trace sink, rewriteLocalhost

  /** CONNECT through the LAN listener (with `authorization`), then one request inside the TLS tunnel. */
  const inTunnel = (target: string, req: { method?: string; path: string; host?: string; body?: string }, authorization = auth()) =>
    new Promise<string>((resolve, reject) => {
      const c = http.request({ host: LAN_IP, port: lanPort, method: 'CONNECT', path: target, headers: { 'proxy-authorization': authorization } });
      c.on('connect', (res, socket) => {
        if (res.statusCode !== 200) return resolve(`CONNECT ${res.statusCode}`);
        const name = target.split(':')[0];
        const t = tls.connect({ socket, rejectUnauthorized: false, servername: net.isIP(name) ? 'localhost' : name });
        const r = http.request(
          { method: req.method ?? 'GET', path: req.path, headers: { host: req.host ?? target, 'content-type': 'application/json' }, createConnection: () => t },
          (rs) => {
            let b = '';
            rs.on('data', (d) => (b += d));
            rs.on('end', () => resolve(`${rs.statusCode} ${b}`));
          },
        );
        r.on('error', reject);
        r.end(req.body);
      });
      c.on('error', reject);
      c.end();
    });

  const STACK = '#0      Api.load (package:lan_app/api.dart:7:3)';

  it('trace sink: an authorised LAN client posts traces over HTTPS (CONNECT) and plain HTTP; they join', async () => {
    proxy.setAppPackages(['lan_app']);
    const body = JSON.stringify({ traces: [{ id: 'lan-trace-https', stack: STACK }] });
    expect(await inTunnel('trace.flutter-intercept.invalid:443', { method: 'POST', path: '/v1/traces', body })).toBe('204 ');
    const plain = JSON.stringify({ traces: [{ id: 'lan-trace-plain', stack: STACK }] });
    const r = await raw(LAN_IP!, lanPort, [
      `POST http://trace.flutter-intercept.invalid/v1/traces HTTP/1.1\r\nHost: trace.flutter-intercept.invalid\r\n${authLine()}Content-Length: ${plain.length}\r\n\r\n${plain}`,
    ]);
    expect(r.text).toMatch(/^HTTP\/1\.1 204/);
    for (const id of ['lan-trace-https', 'lan-trace-plain']) {
      const g = await raw(LAN_IP!, lanPort, [get(`${up.httpUrl}/json?${id}`, `${authLine()}x-fi-id: ${id}\r\n`)]);
      expect(g.text).toMatch(/^HTTP\/1\.1 200/);
    }
    const ex = await settled(proxy);
    expect(ex).toHaveLength(2); // the trace posts are not recorded
    for (const e of ex) expect(e.source?.frames[e.source.appFrame!]).toMatchObject({ fn: 'Api.load', uri: 'package:lan_app/api.dart' });
    expect(up.hits.length).toBe(2);
  });

  it('trace sink: unauthorised LAN clients still get 407 (plain and CONNECT), nothing is ingested', async () => {
    const body = JSON.stringify({ traces: [{ id: 'unauth-trace-1', stack: STACK }] });
    const plain = await raw(LAN_IP!, lanPort, [
      `POST http://trace.flutter-intercept.invalid/v1/traces HTTP/1.1\r\nHost: trace.flutter-intercept.invalid\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    ]);
    expect(plain.text).toMatch(/^HTTP\/1\.1 407/);
    expect(await inTunnel('trace.flutter-intercept.invalid:443', { method: 'POST', path: '/v1/traces', body }, auth('wrong-token-wrong-token'))).toBe(
      'CONNECT 407',
    );
    await lanGet(lanPort, `${up.httpUrl}/json`); // fine, but without a trace to join
    const g = await raw(LAN_IP!, lanPort, [get(`${up.httpUrl}/json?x`, `${authLine()}x-fi-id: unauth-trace-1\r\n`)]);
    expect(g.text).toMatch(/^HTTP\/1\.1 200/);
    for (const e of await settled(proxy)) expect(e.source).toBeUndefined();
  });

  it('trace sink exemption reaches nothing else: inside a tunnel to it, an absolute-form request to a local service is 403', async () => {
    const otherUrl = `http://127.0.0.1:${new URL(other.httpUrl).port}/json`;
    const text = await inTunnel('trace.flutter-intercept.invalid:443', { path: otherUrl });
    expect(text).toMatch(/^403 .*blocked a LAN client's request/); // the per-request SSRF rule still applies
    expect(other.hits).toEqual([]);
  });

  it('viaLan: set on every LAN exchange (plain, in a CONNECT tunnel, SSRF refusals), never on loopback ones', async () => {
    expect((await lanGet(lanPort, `${up.httpUrl}/json?plain`)).status).toBe(200);
    expect(await inTunnel(new URL(up.httpsUrl).host, { path: '/json?tunnel' })).toMatch(/^200 /);
    expect((await lanGet(lanPort, `http://127.0.0.1:${new URL(other.httpUrl).port}/`)).status).toBe(403);
    expect((await raw(LAN_IP!, lanPort, [connect(`127.0.0.1:${new URL(other.httpsUrl).port}`, authLine())])).text).toMatch(/^HTTP\/1\.1 403/);
    expect((await raw('127.0.0.1', proxy.port, [get(`${loopUp.httpUrl}/json?loopback`)])).text).toMatch(/^HTTP\/1\.1 200/);
    const all = await settled(proxy);
    expect(all).toHaveLength(5);
    for (const e of all) expect(e.viaLan, `${e.method} ${e.url}`).toBe(e.url.includes('loopback') ? undefined : true);
  });

  it('rewriteLocalhost does not apply to LAN clients (10.0.2.2 is never turned into this machine)', async () => {
    const port = new URL(loopUp.httpUrl).port;
    const r = await raw(LAN_IP!, lanPort, [get(`http://10.0.2.2:${port}/json`, authLine())], 1500);
    expect(r.text).not.toMatch(/^HTTP\/1\.1 200/);
    expect(loopUp.hits).toEqual([]);
    // the same request from loopback IS rewritten
    expect((await raw('127.0.0.1', proxy.port, [get(`http://10.0.2.2:${port}/json`)])).text).toMatch(/^HTTP\/1\.1 200/);
    expect(loopUp.hits).toEqual(['GET /json']);
  });

  describe('real dart:io client via `PROXY flutter-intercept:<token>@<lanIp>:<port>`', () => {
    let exe: string;
    let tmp: string;
    beforeAll(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-dart-lan-'));
      exe = path.join(tmp, 'dart_client');
      execFileSync('dart', ['compile', 'exe', path.join(__dirname, 'fixtures', 'dart_client.dart'), '-o', exe], { stdio: 'pipe' });
    }, 120_000);
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

    // No `; DIRECT` fallback here: a refused request must not silently go direct from this machine.
    const dart = (url: string, token = TOKEN) =>
      new Promise<{ code: number; out: string }>((resolve) =>
        execFile(
          exe,
          ['0', url],
          { env: { ...process.env, DART_CLIENT_PROXY: `flutter-intercept:${token}@${LAN_IP}:${lanPort}`, DART_CLIENT_NO_DIRECT: '1' } },
          (err, out) => resolve({ code: err ? 2 : 0, out }),
        ),
      );

    it('HTTPS and HTTP are intercepted end to end; a response breakpoint edit arrives', async () => {
      expect(await dart(`${up.httpsUrl}/json`)).toMatchObject({ code: 0, out: 'STATUS 200\n{"hello":"world"}' });
      expect(await dart(`${up.httpUrl}/json`)).toMatchObject({ code: 0, out: 'STATUS 200\n{"hello":"world"}' });
      proxy.setRules([{ id: 'bp', enabled: true, match: { url: '*/json' }, action: { kind: 'breakpoint', phase: 'response' } } satisfies Rule]);
      const paused = nextExchange(proxy, inState('paused-response'));
      const resP = dart(`${up.httpsUrl}/json`);
      proxy.resume((await paused).id, { body: '{"via":"lan"}' });
      expect(await resP).toMatchObject({ code: 0, out: 'STATUS 200\n{"via":"lan"}' });
      const states = (await settled(proxy)).map((e) => e.state);
      expect(states).toEqual(['completed', 'completed', 'completed']);
    }, 60_000);

    it('wrong token: the Dart client gets 407, nothing reaches the server', async () => {
      const r = await dart(`${up.httpUrl}/json`, 'wrong-token-wrong-token-wrong');
      expect(r.out).toMatch(/^STATUS 407|^ERROR/);
      const r2 = await dart(`${up.httpsUrl}/json`, 'wrong-token-wrong-token-wrong');
      expect(r2.out).toMatch(/^STATUS 407|^ERROR/);
      expect(r2.out).not.toMatch(/hello/);
      expect(up.hits).toEqual([]);
    }, 60_000);

    it('SSRF from the Dart client: https://localhost:<other> is refused', async () => {
      for (const url of [`https://localhost:${new URL(other.httpsUrl).port}/json`, `http://127.0.0.1:${new URL(other.httpUrl).port}/json`]) {
        const r = await dart(url);
        expect(r.out, url).toMatch(/^STATUS 403|^ERROR/);
      }
      expect(other.hits).toEqual([]);
    }, 60_000);
  });
});

// Review 2 regressions, run after the tests above (same file → sequential).
import './lan-hardening.suite';
