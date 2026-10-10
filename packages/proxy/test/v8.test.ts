// v0.8.0 (CONTRACTS §14): TLS passthrough, mTLS client certificates, upload / WebSocket / SSE throttling, WebSocket and
// SSE replay, idle pooled connections + the reused-socket retry, noProxy.
import { execFile, execFileSync } from 'child_process';
import { createHash, X509Certificate } from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, Frame, InterceptProxy, ReplayEntry, Rule } from '../src';
import { loadClientCertificate } from '../src';
import { matchesHostPattern, parseHostPattern } from '../src/hosts';
import { poolTesting } from '../src/idle';
import { lanIPv4Addresses, lanTesting } from '../src/lan';
import { MAX_REPLAY_GAP_MS, sseSchedule, wsScript } from '../src/replay-stream';
import { AppDataFinder } from '../src/tls-records';
import { bypassesProxy, createUpstreamAgents, parseNoProxy, parseUpstreamProxy } from '../src/upstream-proxy';
import { nextExchange, selfSignedCert, settled, sleep, startProxy, startTinyProxy, startUpstream, viaProxy, type Upstream } from './helpers';

const rule = (id: string, url: string, action: Rule['action'], extra: Partial<Rule> = {}): Rule => ({ id, enabled: true, match: { url }, action, ...extra });
const KEEP_ALIVE = { connection: 'keep-alive' };
const isTunnel = (e: Exchange) => e.kind === 'tunnel';
const finishedTunnel = (e: Exchange) => e.kind === 'tunnel' && e.state !== 'pending';

/** The newest exchange matching `pred`, already there or the next one to arrive. */
function waitFor(proxy: InterceptProxy, pred: (e: Exchange) => boolean, timeoutMs = 10_000): Promise<Exchange> {
  const have = [...proxy.getExchanges()].reverse().find(pred);
  return have ? Promise.resolve(have) : nextExchange(proxy, pred, timeoutMs);
}

/** A TLS server with its own (not the proxy's) certificate: answers `GET /hello` with "real server". */
async function startTlsServer(opts: https.ServerOptions = {}) {
  const { key, cert } = await selfSignedCert();
  const hits: string[] = [];
  const server = https.createServer({ key, cert, ...opts }, (req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const peer = (req.socket as tls.TLSSocket).getPeerCertificate?.();
    const who = peer && peer.subject ? String(peer.subject.CN ?? '') : '';
    res.writeHead(200, { 'content-type': 'text/plain' }).end(req.url === '/whoami' ? who || 'anonymous' : 'real server');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    fingerprint: new X509Certificate(cert).fingerprint256,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** CONNECT through the proxy, TLS inside; returns the TLS socket and the server certificate's fingerprint. */
async function tunnel(proxyPort: number, target: string, servername?: string): Promise<{ status: number; tls?: tls.TLSSocket; fingerprint?: string; raw: net.Socket }> {
  const c = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target, agent: false });
  c.end();
  const [res, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
  if (res.statusCode !== 200) return { status: res.statusCode ?? 0, raw };
  const t = tls.connect({ socket: raw, rejectUnauthorized: false, ...(servername ? { servername } : {}) });
  await once(t, 'secureConnect');
  return { status: 200, tls: t, fingerprint: t.getPeerCertificate().fingerprint256, raw };
}

/** One HTTP/1.1 request over an established socket: the response text, or the error code. */
function requestOver(socket: tls.TLSSocket, p = '/hello', headers: Record<string, string> = {}): Promise<{ status?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request({ path: p, headers: { host: 'x', ...headers }, createConnection: () => socket }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

// ---------------------------------------------------------------- unit

describe('host patterns, TLS record finder, replay schedule, noProxy (unit)', () => {
  it('host patterns: globs, ports, IPv6, refusals', () => {
    const p = parseHostPattern('*.Bank.example');
    expect(matchesHostPattern(p, 'api.bank.example', 443)).toBe(true);
    expect(matchesHostPattern(p, 'a.b.BANK.example.', 8443)).toBe(true);
    expect(matchesHostPattern(p, 'bank.example', 443)).toBe(false);
    expect(matchesHostPattern(p, 'evilbank.example', 443)).toBe(false);
    const q = parseHostPattern('api.example.com:8443');
    expect(matchesHostPattern(q, 'api.example.com', 8443)).toBe(true);
    expect(matchesHostPattern(q, 'api.example.com', 443)).toBe(false);
    expect(matchesHostPattern(parseHostPattern('[::1]:443'), '[::1]', 443)).toBe(true);
    expect(matchesHostPattern(parseHostPattern('10.0.0.*'), '10.0.0.7', 443)).toBe(true);
    for (const bad of ['', '*', 'a b', 'https://x.com', 'x.com:99999', 'x.com:abc']) expect(() => parseHostPattern(bad), bad).toThrow();
  });

  it('AppDataFinder: TLS 1.3 (CCS, Finished, then the request), TLS 1.2, split headers, not TLS', () => {
    const rec = (type: number, len: number) => Buffer.concat([Buffer.from([type, 3, 3, len >> 8, len & 255]), Buffer.alloc(len, 1)]);
    const hello = rec(22, 300);
    const t13 = Buffer.concat([hello, rec(20, 1), rec(23, 53), rec(23, 100)]);
    expect(new AppDataFinder().push(t13)).toBe(hello.length + 6 + 58);
    const t12 = Buffer.concat([hello, rec(22, 70), rec(20, 1), rec(22, 40), rec(23, 100)]);
    expect(new AppDataFinder().push(t12)).toBe(t12.length - 105);
    // the same TLS 1.3 stream, one byte at a time
    const f = new AppDataFinder();
    let at = -1;
    for (let i = 0; i < t13.length && at < 0; i++) if (f.push(t13.subarray(i, i + 1)) >= 0) at = i;
    expect(at).toBe(hello.length + 6 + 58 + 4); // found once the record header is complete
    expect(new AppDataFinder().push(Buffer.from('GET / HTTP/1.1\r\n'))).toBe(0);
  });

  it('replay schedules: gaps kept up to 5 s, negative gaps clamped, keyed to client messages', () => {
    const ev = (at: number, text: string): Frame => ({ dir: 'receive', at, kind: 'event', text, size: text.length });
    expect(sseSchedule([ev(1000, 'a'), ev(1300, 'b'), ev(60_000, 'c'), ev(50_000, 'd')]).map((s) => s.delayMs)).toEqual([0, 300, MAX_REPLAY_GAP_MS, 0]);
    const f = (dir: Frame['dir'], at: number, text: string, kind: Frame['kind'] = 'text'): Frame => ({ dir, at, kind, text, size: text.length });
    const s = wsScript([f('receive', 0, 'hi'), f('receive', 50, 'again'), f('send', 100, 'q1'), f('receive', 400, 'a1'), f('send', 500, 'q2'), f('receive', 20_000, 'a2'), { dir: 'receive', at: 20_100, kind: 'close', size: 2, closeCode: 1000 }, f('receive', 20_200, 'never')]);
    expect(s.opening.map((x) => [x.delayMs, x.frame.text])).toEqual([[0, 'hi'], [50, 'again']]);
    expect(s.replies.map((r) => r.map((x) => [x.delayMs, x.frame.kind]))).toEqual([[[300, 'text']], [[MAX_REPLAY_GAP_MS, 'text'], [100, 'close']]]);
  });

  it('noProxy entries: host, *.suffix, *, IPs, ports', () => {
    const spec = parseUpstreamProxy({ url: 'http://127.0.0.1:3128', noProxy: ['intranet.corp', '*.local.test', '10.1.2.3', '[::1]:8080', 'api.x:8443'] });
    expect(bypassesProxy(spec, 'intranet.corp', 443)).toBe(true);
    expect(bypassesProxy(spec, 'a.b.local.test', 80)).toBe(true);
    expect(bypassesProxy(spec, 'local.test', 80)).toBe(false);
    expect(bypassesProxy(spec, '10.1.2.3', 1)).toBe(true);
    expect(bypassesProxy(spec, '[::1]', 8080)).toBe(true);
    expect(bypassesProxy(spec, 'api.x', 443)).toBe(false);
    expect(bypassesProxy(spec, 'example.com', 443)).toBe(false);
    expect(bypassesProxy(parseUpstreamProxy({ url: 'http://p:1', noProxy: ['*'] }), 'anything', 1)).toBe(true);
    expect(() => parseNoProxy(['bad host!'])).toThrow(/invalid noProxy/);
  });
});

// ---------------------------------------------------------------- TLS passthrough

describe('TLS passthrough (CONTRACTS §14.2)', () => {
  let srv: Awaited<ReturnType<typeof startTlsServer>>;
  let proxy: InterceptProxy;
  beforeEach(async () => {
    srv = await startTlsServer();
    proxy = await startProxy({ tlsPassthrough: ['127.0.0.1'] });
  });
  afterEach(async () => {
    await proxy.stop();
    await srv.close();
  });

  it("the app sees the server's real certificate; one tunnel exchange with byte counts, no bodies", async () => {
    expect(proxy.tlsPassthrough).toEqual(['127.0.0.1']);
    expect(proxy.tlsPassthroughAvailable).toBe(true);
    const t = await tunnel(proxy.port, `127.0.0.1:${srv.port}`);
    expect(t.status).toBe(200);
    expect(t.fingerprint).toBe(srv.fingerprint); // not a certificate minted by the proxy
    const open = proxy.getExchanges().find(isTunnel)!;
    expect(open).toMatchObject({ state: 'pending', method: 'CONNECT', url: `https://127.0.0.1:${srv.port}/` });
    expect(open.status).toBeUndefined();
    expect(await requestOver(t.tls!)).toEqual({ status: 200, body: 'real server' });
    t.tls!.end();
    const ex = await waitFor(proxy, finishedTunnel);
    expect(ex.state).toBe('completed');
    expect(ex.tunnelBytes!.sent).toBeGreaterThan(200);
    expect(ex.tunnelBytes!.received).toBeGreaterThan(200);
    expect(ex.requestBody).toBeUndefined();
    expect(ex.responseBody).toBeUndefined();
    expect(Number.isInteger(ex.timings?.connectMs)).toBe(true);
    expect(srv.hits).toEqual(['GET /hello']);
    // Only that host: everything else is still intercepted (the proxy's own certificate).
    proxy.setTlsPassthrough([]);
    const mitm = await tunnel(proxy.port, `127.0.0.1:${srv.port}`, 'localhost');
    expect(mitm.fingerprint).not.toBe(srv.fingerprint);
    mitm.tls!.destroy();
  });

  it('tunnelBytes update while the tunnel is open (coalesced events)', async () => {
    const t = await tunnel(proxy.port, `127.0.0.1:${srv.port}`);
    const seen = nextExchange(proxy, (e) => isTunnel(e) && e.state === 'pending' && (e.tunnelBytes?.received ?? 0) > 2000);
    expect(await requestOver(t.tls!, '/hello', { connection: 'keep-alive' })).toMatchObject({ status: 200 });
    expect((await seen).tunnelBytes!.sent).toBeGreaterThan(0);
    t.tls!.destroy();
  });

  it('a block rule made from the tunnel resets it after the TLS handshake (no DIRECT fallback); the server never sees the request', async () => {
    proxy.setRules([rule('b', `https://127.0.0.1:${srv.port}/*`, { kind: 'block', mode: 'status', status: 403 })]);
    const t = await tunnel(proxy.port, `127.0.0.1:${srv.port}`);
    expect(t.status).toBe(200); // the CONNECT and the handshake succeed…
    expect(t.fingerprint).toBe(srv.fingerprint);
    const r = await requestOver(t.tls!); // …the request fails
    expect(r.error).toBeDefined();
    const ex = await waitFor(proxy, finishedTunnel);
    expect(ex).toMatchObject({ state: 'blocked', matchedRuleId: 'b' });
    expect(ex.error).toMatch(/can't be answered inside an undecrypted tunnel/);
    expect(srv.hits).toEqual([]);
  });

  it('faults: dns closes after the handshake; mock rules do not apply (noted, passed through)', async () => {
    proxy.setRules([rule('f', 'https://127.0.0.1*', { kind: 'fault', fault: 'dns' }, { match: { url: 'https://127.0.0.1*', method: 'CONNECT' } })]);
    const t = await tunnel(proxy.port, `127.0.0.1:${srv.port}`);
    expect((await requestOver(t.tls!)).error).toBeDefined();
    expect(await waitFor(proxy, finishedTunnel)).toMatchObject({ state: 'blocked', simulated: 'Fault: DNS failure' });
    proxy.setRules([rule('m', '*', { kind: 'mock', status: 200, body: 'mocked' })]);
    const t2 = await tunnel(proxy.port, `127.0.0.1:${srv.port}`);
    expect(await requestOver(t2.tls!)).toEqual({ status: 200, body: 'real server' });
    t2.tls!.destroy();
    const ex = await waitFor(proxy, (e) => finishedTunnel(e) && e.matchedRuleId !== 'f');
    expect(ex.matchedRuleId).toBeUndefined();
    expect(ex.error).toMatch(/does not apply to TLS passthrough tunnels/);
  });

  it('an unreachable server: 502 on the CONNECT, exchange error', async () => {
    const dead = net.createServer();
    dead.listen(0, '127.0.0.1');
    await once(dead, 'listening');
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const t = await tunnel(proxy.port, `127.0.0.1:${port}`);
    expect(t.status).toBe(502);
    t.raw.destroy();
    expect(await waitFor(proxy, finishedTunnel)).toMatchObject({ state: 'error', status: 502 });
  });

  it('throttle profile: latency before the tunnel opens, simulated label', async () => {
    proxy.setNetworkProfile({ kind: 'throttle', latencyMs: 250, kbps: 2000, uploadKbps: 500 });
    const t0 = Date.now();
    const t = await tunnel(proxy.port, `127.0.0.1:${srv.port}`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    expect(await requestOver(t.tls!)).toMatchObject({ status: 200 });
    t.tls!.destroy();
    const ex = await waitFor(proxy, finishedTunnel);
    expect(ex.simulated).toBe('+250 ms, 2000 kbps, 500 kbps up');
    expect(ex.timings?.delayMs).toBeGreaterThanOrEqual(240);
  });

  it('chains through the upstream proxy with CONNECT (and noProxy hosts go direct)', async () => {
    const tiny = await startTinyProxy();
    try {
      proxy.setTlsPassthrough(['*.example.invalid']);
      proxy.setUpstreamProxy({ url: tiny.url });
      const t = await tunnel(proxy.port, `tls.example.invalid:${srv.port}`);
      expect(t.fingerprint).toBe(srv.fingerprint);
      expect(await requestOver(t.tls!)).toMatchObject({ status: 200 });
      t.tls!.destroy();
      expect(tiny.seen).toEqual([`CONNECT tls.example.invalid:${srv.port}`]);
      // noProxy: direct (and that name doesn't resolve without the tiny proxy → 502)
      proxy.setUpstreamProxy({ url: tiny.url, noProxy: ['*.example.invalid'] });
      const d = await tunnel(proxy.port, `tls.example.invalid:${srv.port}`);
      expect(d.status).toBe(502);
      d.raw.destroy();
      expect(tiny.seen).toHaveLength(1);
    } finally {
      proxy.setUpstreamProxy(undefined);
      await tiny.close();
    }
  });

  it('invalid patterns throw and change nothing', () => {
    expect(() => proxy.setTlsPassthrough(['ok.example', 'not a host'])).toThrow(/TLS passthrough/);
    expect(proxy.tlsPassthrough).toEqual(['127.0.0.1']);
  });
});

const LAN_IP = lanIPv4Addresses()[0];
const TOKEN = 'k3Jr7QW1yFv0dE2s9pX8aB4cN6mZ5tLhGqUoRiYeWnA';
const AUTH = `Basic ${Buffer.from(`flutter-intercept:${TOKEN}`).toString('base64')}`;

describe.skipIf(!LAN_IP)('TLS passthrough from LAN clients (CONTRACTS §7 guard)', () => {
  let srv: Awaited<ReturnType<typeof startTlsServer>>;
  let lanSrv: https.Server;
  let lanPort: number;
  let proxy: InterceptProxy;
  let lanProxyPort: number;
  let checks: number;
  let allowFirstOnly: boolean;
  beforeEach(async () => {
    srv = await startTlsServer(); // loopback: forbidden for LAN clients
    const { key, cert } = await selfSignedCert();
    lanSrv = https.createServer({ key, cert }, (_q, r) => r.writeHead(200).end('lan server'));
    lanSrv.listen(0, LAN_IP);
    await once(lanSrv, 'listening');
    lanPort = (lanSrv.address() as AddressInfo).port;
    checks = 0;
    allowFirstOnly = false;
    lanTesting.allowTarget = (ip, port) => {
      if (ip !== LAN_IP || port !== lanPort) return false;
      checks++;
      return !allowFirstOnly || checks === 1;
    };
    proxy = await startProxy({ tlsPassthrough: [LAN_IP!, '127.0.0.1'] });
    lanProxyPort = (await proxy.openLan({ host: LAN_IP!, token: TOKEN })).port;
  });
  afterEach(async () => {
    await proxy.stop();
    await srv.close();
    lanSrv.closeAllConnections();
    await new Promise((r) => lanSrv.close(r));
    delete lanTesting.allowTarget;
  });

  const lanConnect = async (target: string) => {
    const c = http.request({ host: LAN_IP, port: lanProxyPort, method: 'CONNECT', path: target, headers: { 'proxy-authorization': AUTH }, agent: false });
    c.end();
    const [res, socket] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
    return { status: res.statusCode, socket };
  };

  it('an allowed target tunnels; the token is not recorded; viaLan set', async () => {
    const r = await lanConnect(`${LAN_IP}:${lanPort}`);
    expect(r.status).toBe(200);
    const t = tls.connect({ socket: r.socket, rejectUnauthorized: false });
    await once(t, 'secureConnect');
    expect(await requestOver(t)).toEqual({ status: 200, body: 'lan server' });
    t.destroy();
    const ex = await waitFor(proxy, finishedTunnel);
    expect(ex).toMatchObject({ viaLan: true, state: 'completed' });
    expect(JSON.stringify(ex)).not.toContain(TOKEN);
    expect(JSON.stringify(ex)).not.toContain(AUTH.slice(6));
  });

  it('a loopback target is refused (403, never tunnelled)', async () => {
    const r = await lanConnect(`127.0.0.1:${srv.port}`);
    expect(r.status).toBe(403);
    r.socket.destroy();
    expect(srv.hits).toEqual([]);
  });

  it('DNS rebinding: the address is checked again when the tunnel connects', async () => {
    allowFirstOnly = true; // the gate's check passes, the tunnel's own check doesn't
    const r = await lanConnect(`${LAN_IP}:${lanPort}`);
    expect(r.status).toBe(403);
    r.socket.destroy();
    const ex = await waitFor(proxy, finishedTunnel);
    expect(ex).toMatchObject({ state: 'error', status: 403, viaLan: true });
    expect(checks).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------- mTLS

function openssl(args: string[], cwd: string): boolean {
  try {
    execFileSync('openssl', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-mtls-'));
fs.writeFileSync(path.join(certDir, 'ext.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n[ext]\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n');
const haveCerts =
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '2', '-subj', '/CN=fi-test-client', '-extensions', 'ext', '-config', 'ext.cnf'], certDir) &&
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other.pem', '-out', 'othercert.pem', '-days', '2', '-subj', '/CN=other', '-extensions', 'ext', '-config', 'ext.cnf'], certDir) &&
  openssl(['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-passout', 'pass:s3cret-pass', '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-out', 'client.pfx'], certDir);

describe.skipIf(!haveCerts)('mTLS client certificates (CONTRACTS §14.3)', () => {
  let srv: Awaited<ReturnType<typeof startTlsServer>>;
  let proxy: InterceptProxy;
  const read = (f: string) => fs.readFileSync(path.join(certDir, f));
  afterAll(() => fs.rmSync(certDir, { recursive: true, force: true }));
  beforeEach(async () => {
    srv = await startTlsServer({ requestCert: true, rejectUnauthorized: true, ca: [read('cert.pem')] });
    proxy = await startProxy();
  });
  afterEach(async () => {
    await proxy.stop();
    await srv.close();
  });

  it('no certificate: the server refuses the handshake (502)', async () => {
    const r = await viaProxy(proxy.port, `https://127.0.0.1:${srv.port}/whoami`);
    expect(r.status).toBe(502);
    expect((await settled(proxy)).at(-1)?.clientCertificate).toBeUndefined();
  });

  it('PKCS#12 with passphrase: presented, recorded as the pattern, no key material anywhere', async () => {
    const status = proxy.setClientCertificates([{ host: '127.0.0.1', pfx: read('client.pfx'), passphrase: 's3cret-pass' }]);
    expect(status).toEqual([{ host: '127.0.0.1' }]);
    const r = await viaProxy(proxy.port, `https://127.0.0.1:${srv.port}/whoami`);
    expect(r).toMatchObject({ status: 200, text: 'fi-test-client' });
    const ex = (await settled(proxy)).at(-1)!;
    expect(ex.clientCertificate).toBe('127.0.0.1');
    const all = JSON.stringify([proxy.getExchanges(), proxy.clientCertificates]);
    expect(all).not.toContain('s3cret-pass');
    expect(all).not.toContain(read('client.pfx').toString('base64').slice(0, 40));
    expect(all).not.toContain('PRIVATE KEY');
  });

  it('PEM cert + key; a port-specific pattern for another port is not used; the first match wins', async () => {
    proxy.setClientCertificates([
      { host: `127.0.0.1:${srv.port === 1 ? 2 : 1}`, cert: read('othercert.pem').toString(), key: read('other.pem').toString() },
      { host: '127.0.0.*', cert: read('cert.pem').toString(), key: read('key.pem').toString() },
    ]);
    const r = await viaProxy(proxy.port, `https://127.0.0.1:${srv.port}/whoami`);
    expect(r).toMatchObject({ status: 200, text: 'fi-test-client' });
    expect((await settled(proxy)).at(-1)?.clientCertificate).toBe('127.0.0.*');
  });

  it('problems are reported per entry in words, and those entries are skipped', () => {
    const status = proxy.setClientCertificates([
      { host: 'a.example', pfx: read('client.pfx'), passphrase: 'wrong' },
      { host: 'b.example', cert: read('cert.pem').toString(), key: read('other.pem').toString() },
      { host: 'c.example', cert: read('cert.pem').toString(), key: 'garbage' },
      { host: 'not a host', pfx: read('client.pfx'), passphrase: 's3cret-pass' },
      { host: 'e.example' },
      { host: 'ok.example', pfx: read('client.pfx'), passphrase: 's3cret-pass' },
    ]);
    expect(status.map((s) => s.host)).toEqual(['a.example', 'b.example', 'c.example', 'not a host', 'e.example', 'ok.example']);
    expect(status[0].problem).toMatch(/wrong passphrase/);
    expect(status[1].problem).toMatch(/does not belong to the certificate/);
    expect(status[2].problem).toMatch(/not valid PEM|Could not/);
    expect(status[3].problem).toMatch(/Invalid host/);
    expect(status[4].problem).toMatch(/No certificate/);
    expect(status[5].problem).toBeUndefined();
    for (const s of status) {
      expect(s.problem ?? '').not.toContain('s3cret-pass');
      expect(s.problem ?? '').not.toContain('BEGIN');
    }
    expect(loadClientCertificate({ host: 'x.example', pfx: read('client.pfx'), passphrase: 's3cret-pass' }).problem).toBeUndefined();
  });
});

// ---------------------------------------------------------------- throttling

describe('upload, WebSocket and SSE throttling (CONTRACTS §14.4)', () => {
  let up: Upstream;
  let proxy: InterceptProxy;
  beforeAll(async () => {
    up = await startUpstream();
  });
  afterAll(async () => {
    await up.close();
  });
  beforeEach(async () => {
    proxy = await startProxy();
  });
  afterEach(async () => {
    await proxy.stop();
  });

  it('a throttle rule with uploadKbps paces the request body to the server', async () => {
    const body = Buffer.alloc(16 * 1024, 'u'); // 16 KB at 64 kbps (8 KB/s) ≈ 2 s
    const fast0 = Date.now();
    expect((await viaProxy(proxy.port, `${up.httpUrl}/count`, { method: 'POST', body })).text).toBe('16384');
    const fast = Date.now() - fast0;
    proxy.setRules([rule('t', `${up.httpUrl}/count*`, { kind: 'throttle', uploadKbps: 64 })]);
    const t0 = Date.now();
    expect((await viaProxy(proxy.port, `${up.httpUrl}/count`, { method: 'POST', body })).text).toBe('16384');
    const slow = Date.now() - t0;
    expect(slow).toBeGreaterThanOrEqual(1700);
    expect(fast).toBeLessThan(1000);
    const ex = (await settled(proxy)).at(-1)!;
    expect(ex.simulated).toBe('64 kbps up');
    expect(ex.timings?.sendMs).toBeGreaterThanOrEqual(1500);
  });

  it('the network profile uploadKbps paces HTTPS uploads too', async () => {
    proxy.setNetworkProfile({ kind: 'throttle', uploadKbps: 64 });
    expect(proxy.networkProfile).toEqual({ kind: 'throttle', uploadKbps: 64 });
    const t0 = Date.now();
    expect((await viaProxy(proxy.port, `${up.httpsUrl}/count`, { method: 'POST', body: Buffer.alloc(12 * 1024, 'u') })).text).toBe('12288');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1200);
  });

  it('SSE: every event arrives latency late, gaps kept (not added up)', async () => {
    proxy.setRules([rule('t', `${up.httpUrl}/stream*`, { kind: 'throttle', latencyMs: 300 })]);
    const t0 = Date.now();
    const times: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `${up.httpUrl}/stream?ms=400`, headers: { host: new URL(up.httpUrl).host }, agent: false }, (res) => {
        res.on('data', () => times.push(Date.now() - t0));
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end();
    });
    // request latency 300 + event latency 300 = ~600 for the first, the second ~400 later
    expect(times[0]).toBeGreaterThanOrEqual(550);
    expect(times.at(-1)! - times[0]).toBeGreaterThanOrEqual(350);
    expect(times.at(-1)! - times[0]).toBeLessThan(700);
  });

  describe('WebSocket frames', () => {
    let wsHttp: http.Server;
    let wsUrl: string;
    beforeAll(async () => {
      wsHttp = http.createServer();
      const wss = new WebSocketServer({ server: wsHttp });
      wss.on('connection', (ws) => {
        ws.on('message', (d, bin) => {
          const t = (d as Buffer).toString();
          if (!bin && t === 'big') return ws.send(Buffer.alloc(10_000, 1));
          ws.send(d, { binary: bin });
        });
      });
      wsHttp.listen(0, '127.0.0.1');
      await once(wsHttp, 'listening');
      wsUrl = `ws://127.0.0.1:${(wsHttp.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      wsHttp.closeAllConnections();
      await new Promise((r) => wsHttp.close(r));
    });

    const open = async (url: string) => {
      const ws = new WebSocket(url, { createConnection: () => net.connect(proxy.port, '127.0.0.1') } as WebSocket.ClientOptions);
      ws.on('error', () => undefined);
      await once(ws, 'open');
      return ws;
    };
    const roundTrip = async (ws: WebSocket, msg: string) => {
      const t0 = Date.now();
      ws.send(msg);
      const [d] = (await once(ws, 'message')) as [Buffer];
      return { ms: Date.now() - t0, size: d.length };
    };

    it('latency applies to each direction (a throttle rule on the ws:// URL)', async () => {
      proxy.setRules([rule('t', `${wsUrl}/*`, { kind: 'throttle', latencyMs: 250 })]);
      const ws = await open(`${wsUrl}/x`);
      const r1 = await roundTrip(ws, 'hello');
      expect(r1.ms).toBeGreaterThanOrEqual(480);
      const r2 = await roundTrip(ws, 'again');
      expect(r2.ms).toBeGreaterThanOrEqual(480);
      expect(r2.ms).toBeLessThan(1500);
      const done = nextExchange(proxy, (e) => e.kind === 'websocket' && e.state !== 'pending');
      ws.close();
      const ex = await done;
      expect(ex).toMatchObject({ state: 'completed', matchedRuleId: 't', simulated: '+250 ms' });
      expect(ex.frames!.filter((f) => f.kind === 'text').length).toBe(4);
    });

    it('download bandwidth paces server messages (profile)', async () => {
      proxy.setNetworkProfile({ kind: 'throttle', kbps: 40 }); // 10 KB at 5 KB/s ≈ 2 s
      const ws = await open(`${wsUrl}/y`);
      const r = await roundTrip(ws, 'big');
      expect(r.size).toBe(10_000);
      expect(r.ms).toBeGreaterThanOrEqual(1800);
      ws.close();
    });
  });
});

// ---------------------------------------------------------------- WebSocket / SSE replay

describe('WebSocket / SSE replay (CONTRACTS §14.5)', () => {
  let up: Upstream;
  let proxy: InterceptProxy;
  beforeAll(async () => {
    up = await startUpstream();
  });
  afterAll(async () => {
    await up.close();
  });
  beforeEach(async () => {
    proxy = await startProxy();
  });
  afterEach(async () => {
    await proxy.stop();
  });

  const T = 1_700_000_000_000;
  const text = (dir: Frame['dir'], at: number, t: string): Frame => ({ dir, at: T + at, kind: 'text', text: t, size: t.length });

  it('WebSocket: a scripted server keyed to the app’s messages, timing kept, closed like the recording; nothing is contacted', async () => {
    const entry: ReplayEntry = {
      kind: 'websocket',
      method: 'GET',
      url: 'ws://127.0.0.1:1/chat',
      status: 101,
      headers: { 'sec-websocket-protocol': 'chat.v1' },
      frames: [
        text('receive', 0, 'hello'),
        text('send', 100, 'question'),
        text('receive', 350, 'answer'),
        text('receive', 650, 'more'),
        { dir: 'receive', at: T + 700, kind: 'binary', size: 4, truncated: true }, // redacted: zeros of the size
        text('send', 1000, 'bye'),
        { dir: 'receive', at: T + 1100, kind: 'close', size: 6, closeCode: 4001, text: 'done' },
      ],
    };
    expect(proxy.setReplay([entry], { fallback: 'fail', name: 'chat' })).toBe(1);
    const got: Array<[number, string]> = [];
    const t0 = Date.now();
    const ws = new WebSocket('ws://127.0.0.1:1/chat', ['chat.v1', 'other'], { createConnection: () => net.connect(proxy.port, '127.0.0.1') } as WebSocket.ClientOptions);
    ws.on('message', (d, bin) => got.push([Date.now() - t0, bin ? `bin:${(d as Buffer).length}:${(d as Buffer)[0]}` : (d as Buffer).toString()]));
    await once(ws, 'open');
    expect(ws.protocol).toBe('chat.v1');
    await sleep(200);
    expect(got.map((g) => g[1])).toEqual(['hello']);
    const asked = Date.now() - t0;
    ws.send('anything'); // keyed by order, not content
    await sleep(800);
    expect(got.map((g) => g[1])).toEqual(['hello', 'answer', 'more', 'bin:4:0']);
    expect(got[1][0] - asked).toBeGreaterThanOrEqual(200); // 250 ms after the message in the recording
    expect(got[2][0] - got[1][0]).toBeGreaterThanOrEqual(250);
    const closed = once(ws, 'close');
    ws.send('bye');
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(4001);
    expect(reason.toString()).toBe('done');
    const ex = await waitFor(proxy, (e) => e.kind === 'websocket' && e.state !== 'pending');
    expect(ex).toMatchObject({ state: 'mocked', status: 101, simulated: 'Replayed from chat' });
    expect(ex.frames!.map((f) => `${f.dir}:${f.kind}`)).toEqual(['receive:text', 'send:text', 'receive:text', 'receive:text', 'receive:binary', 'send:text', 'receive:close']);
  });

  it('SSE: the recorded head and events at their recorded gaps', async () => {
    const entry: ReplayEntry = {
      kind: 'sse',
      method: 'GET',
      url: 'http://127.0.0.1:1/events',
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-rec': '1' },
      frames: [
        { dir: 'receive', at: T, kind: 'event', text: 'first', size: 5 },
        { dir: 'receive', at: T + 400, kind: 'event', text: 'second\nline', size: 11, event: 'tick', id: '2' },
      ],
    };
    proxy.setReplay([entry], { fallback: 'fail', name: 'feed' });
    const t0 = Date.now();
    const chunks: Array<[number, string]> = [];
    const head = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: entry.url, headers: { host: '127.0.0.1:1' }, agent: false }, (res) => {
        res.on('data', (d: Buffer) => chunks.push([Date.now() - t0, d.toString()]));
        res.on('end', () => resolve(res));
      });
      req.on('error', reject);
      req.end();
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers['x-rec']).toBe('1');
    const all = chunks.map((c) => c[1]).join('');
    expect(all).toBe('data: first\n\nevent: tick\nid: 2\ndata: second\ndata: line\n\n');
    expect(chunks.at(-1)![0] - chunks[0][0]).toBeGreaterThanOrEqual(350);
    const ex = (await settled(proxy)).at(-1)!;
    expect(ex).toMatchObject({ state: 'mocked', kind: 'sse', simulated: 'Replayed from feed' });
    expect(ex.frames!.map((f) => f.text)).toEqual(['first', 'second\nline']);
  });

  it('SSE POST streams are told apart by the request body; a miss passes through', async () => {
    const hash = createHash('sha256').update('q=1').digest('hex');
    proxy.setReplay(
      [
        {
          kind: 'sse',
          method: 'POST',
          url: `${up.httpUrl}/stream`,
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          requestBodyHash: hash,
          frames: [{ dir: 'receive', at: T, kind: 'event', text: 'replayed', size: 8 }],
        },
      ],
      { fallback: 'passthrough' },
    );
    const hit = await viaProxy(proxy.port, `${up.httpUrl}/stream`, { method: 'POST', body: 'q=1' });
    expect(hit.text).toBe('data: replayed\n\n');
    const miss = await viaProxy(proxy.port, `${up.httpUrl}/stream?ms=10`, { method: 'POST', body: 'q=2' });
    expect(miss.text).toBe('data: one\n\ndata: two\n\n'); // the real server
    const all = await settled(proxy);
    expect(all.map((e) => e.state)).toEqual(['mocked', 'completed']);
  });
});

// ---------------------------------------------------------------- idle pool + retry

describe('idle pooled connections and the reused-socket retry (CONTRACTS §14.6)', () => {
  let server: http.Server;
  let base: string;
  let closedSockets: number;
  let seen: string[];
  let proxy: InterceptProxy;
  beforeEach(async () => {
    closedSockets = 0;
    seen = [];
    server = http.createServer({ keepAliveTimeout: 60_000 }, (req, res) => {
      const s = req.socket as net.Socket & { n?: number };
      s.n = (s.n ?? 0) + 1;
      seen.push(`${req.method} ${req.url} #${s.n}`);
      // /flaky: a reused connection is reset as soon as the request arrives (a server that dropped an idle socket).
      if (req.url === '/flaky' && s.n > 1) return void s.resetAndDestroy();
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'));
    });
    server.on('connection', (s) => s.on('close', () => closedSockets++));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await proxy?.stop();
    delete poolTesting.idleTimeoutMs;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('idle pooled sockets are closed after the idle timeout', async () => {
    poolTesting.idleTimeoutMs = 300;
    proxy = await startProxy();
    await viaProxy(proxy.port, `${base}/a`, { headers: KEEP_ALIVE });
    await sleep(100);
    expect(closedSockets).toBe(0); // pooled
    await sleep(700);
    expect(closedSockets).toBe(1);
  });

  it('GET on a reused socket that is reset before any response byte is retried once on a new connection', async () => {
    proxy = await startProxy();
    expect((await viaProxy(proxy.port, `${base}/a`, { headers: KEEP_ALIVE })).status).toBe(200);
    const r = await viaProxy(proxy.port, `${base}/flaky`, { headers: KEEP_ALIVE });
    expect(r).toMatchObject({ status: 200, text: 'ok' });
    expect(seen).toEqual(['GET /a #1', 'GET /flaky #2', 'GET /flaky #1']);
    const ex = (await settled(proxy)).at(-1)!;
    expect(ex.state).toBe('completed');
    expect(ex.timings?.reused).toBeUndefined();
    expect(Number.isInteger(ex.timings?.connectMs)).toBe(true);
  });

  it('POST is not retried (502, error)', async () => {
    proxy = await startProxy();
    await viaProxy(proxy.port, `${base}/a`, { headers: KEEP_ALIVE });
    const r = await viaProxy(proxy.port, `${base}/flaky`, { method: 'POST', body: 'x', headers: KEEP_ALIVE });
    expect(r.status).toBe(502);
    expect(seen).toEqual(['GET /a #1', 'POST /flaky #2']);
    expect((await settled(proxy)).at(-1)?.state).toBe('error');
  });
});

describe('noProxy on the upstream-proxy agents', () => {
  it('a noProxy host is connected directly; others go through the proxy', async () => {
    const up = await startUpstream();
    const tiny = await startTinyProxy();
    try {
      const spec = parseUpstreamProxy({ url: tiny.url, noProxy: ['direct.example.invalid'] });
      const agents = createUpstreamAgents(spec);
      const port = Number(new URL(up.httpUrl).port);
      const lookup = (_h: string, o: unknown, cb: (...a: unknown[]) => void) =>
        (o as { all?: boolean })?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
      const get = (host: string) =>
        new Promise<number>((resolve, reject) => {
          http
            .get({ host, port, path: '/json', agent: agents.http, lookup: lookup as never }, (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode ?? 0));
            })
            .on('error', reject);
        });
      expect(await get('direct.example.invalid')).toBe(200);
      expect(tiny.seen).toEqual([]);
      expect(await get('via.example.invalid')).toBe(200);
      expect(tiny.seen).toEqual([`GET http://via.example.invalid:${port}/json`]);
      agents.http.destroy();
    } finally {
      await tiny.close();
      await up.close();
    }
  });
});

// ---------------------------------------------------------------- a real dart:io client on a passthrough host

const haveDart = (() => {
  try {
    execFileSync('dart', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!haveDart)('TLS passthrough with a real dart:io HttpClient (PROXY …; DIRECT)', () => {
  let tmp: string;
  let exe: string;
  let srv: Awaited<ReturnType<typeof startTlsServer>>;
  let proxy: InterceptProxy;
  const run = (url: string) =>
    new Promise<{ phase: string; status: number | null; message: string }>((resolve, reject) => {
      execFile(exe, [String(proxy.port), url, '10000'], { timeout: 60_000 }, (err, stdout) => {
        try {
          resolve(JSON.parse(String(stdout).trim().split('\n').pop()!));
        } catch {
          reject(err ?? new Error(`bad output: ${stdout}`));
        }
      });
    });
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-passthrough-'));
    exe = path.join(tmp, process.platform === 'win32' ? 'fault_client.exe' : 'fault_client');
    execFileSync('dart', ['compile', 'exe', path.join(__dirname, 'fixtures', 'fault_client.dart'), '-o', exe], { stdio: 'pipe' });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(async () => {
    srv = await startTlsServer();
    proxy = await startProxy({ tlsPassthrough: ['127.0.0.1'] });
  });
  afterEach(async () => {
    await proxy.stop();
    await srv.close();
  });

  it('passes through; a block rule fails the request without Dart falling back to DIRECT', async () => {
    const url = `https://127.0.0.1:${srv.port}/hello`;
    expect(await run(url)).toMatchObject({ phase: 'done', status: 200 });
    expect(srv.hits).toEqual(['GET /hello']);
    expect((await waitFor(proxy, finishedTunnel)).state).toBe('completed');
    proxy.setRules([rule('b', `https://127.0.0.1:${srv.port}/*`, { kind: 'block', mode: 'reset' })]);
    const blocked = await run(url);
    expect(blocked.phase).toBe('close'); // failed at the request, after openUrl (CONNECT + TLS) succeeded
    expect(srv.hits).toEqual(['GET /hello']); // DIRECT would have reached the server
    expect((await waitFor(proxy, (e) => e.kind === 'tunnel' && e.state === 'blocked')).matchedRuleId).toBe('b');
  });
});
