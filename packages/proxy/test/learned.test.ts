// v0.14.0 (CONTRACTS §20.1): learned passthrough — servers that want the app's own client certificate (TLS 1.3
// certificate_required, TLS 1.2 handshake_failure confirmed by a probe, nginx's 400) and apps that pin their certificate
// on plain HTTPS CONNECTs; the exclusions, the API and event, and the cost of a CONNECT with a full map.
import { execFileSync } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as http2 from 'http2';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { X509Certificate } from 'crypto';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy, LearnedPassthrough, Rule } from '../src';
import {
  alertOf,
  alertOfTags,
  CertRequestFinder,
  clientKeyOf,
  LEARNED_MAX,
  LEARNED_PER_CLIENT,
  LOOPBACK_CLIENT,
  LearnedHosts,
  parseLearnedKey,
  patternNamesHost,
  probeCertificateRequest,
  probeTesting,
} from '../src/learned';
import { grpcPinTesting, TEST_INTERNALS } from '../src/intercept-proxy';
import { GRPC_PIN_TTL_MS } from '../src/connect-flow';
import { nextExchange, notesOf, selfSignedCert, sleep, startProxy, startTinyProxy } from './helpers';
import { grpcCall, silentSocket } from './grpc-helpers';

function waitFor(proxy: InterceptProxy, pred: (e: Exchange) => boolean, timeoutMs = 10_000): Promise<Exchange> {
  const have = [...proxy.getExchanges()].reverse().find(pred);
  return have ? Promise.resolve(have) : nextExchange(proxy, pred, timeoutMs);
}

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-learned-'));
function openssl(args: string[]): boolean {
  try {
    execFileSync('openssl', args, { cwd: certDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
fs.writeFileSync(path.join(certDir, 'ext.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n[ext]\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n');
const haveCerts =
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '2', '-subj', '/CN=fi-app-client', '-extensions', 'ext', '-config', 'ext.cnf']) &&
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other.pem', '-out', 'othercert.pem', '-days', '2', '-subj', '/CN=other', '-extensions', 'ext', '-config', 'ext.cnf']);
const read = (f: string) => fs.readFileSync(path.join(certDir, f), 'utf8');
afterAll(() => fs.rmSync(certDir, { recursive: true, force: true }));

const NGINX_PAGE =
  '<html>\r\n<head><title>400 No required SSL certificate was sent</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n' +
  '<center>No required SSL certificate was sent</center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

/**
 * An mTLS server (its own certificate; trusts the app's client certificate). `mode`: `reject` = requestCert +
 * rejectUnauthorized (TLS alerts); `nginx` = asks, accepts none, but answers /secure with nginx's 400 page without one.
 * `/whoami` names the client certificate's CN; `/ok` always answers.
 */
async function startMtlsServer(o: { mode: 'reject' | 'nginx'; maxVersion?: tls.SecureVersion; trust?: string }) {
  const { key, cert } = await selfSignedCert();
  const handshakes: string[] = [];
  const server = https.createServer(
    { key, cert, requestCert: true, rejectUnauthorized: o.mode === 'reject', ca: [o.trust ?? read('cert.pem')], ...(o.maxVersion ? { maxVersion: o.maxVersion } : {}) },
    (req, res) => {
      const s = req.socket as tls.TLSSocket;
      const cn = s.authorized ? String(s.getPeerCertificate().subject?.CN ?? '') : '';
      if (req.url === '/secure' && !s.authorized) return void res.writeHead(400, { 'content-type': 'text/html' }).end(NGINX_PAGE);
      res.writeHead(200, { 'content-type': 'text/plain' }).end(req.url === '/whoami' || req.url === '/secure' ? cn || 'anonymous' : 'ok');
    },
  );
  server.on('secureConnection', (s: tls.TLSSocket) => handshakes.push(s.authorized ? 'cert' : 'none'));
  server.on('tlsClientError', () => handshakes.push('refused'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    handshakes,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** An HTTPS keep-alive agent that goes through the proxy like an app: a CONNECT per connection, then TLS inside it. */
function proxiedAgent(proxyPort: number, own: tls.ConnectionOptions = {}, maxSockets = 1) {
  const connects: string[] = [];
  const sockets: tls.TLSSocket[] = [];
  const agent = new https.Agent({ keepAlive: true, maxSockets });
  (agent as unknown as { createConnection: unknown }).createConnection = (opts: { host: string; port: number }, cb: (e: Error | null, s?: net.Socket) => void) => {
    const c = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${opts.host}:${opts.port}`, agent: false });
    c.once('connect', (res, sock: net.Socket) => {
      connects.push(String(res.statusCode));
      if (res.statusCode !== 200) return cb(new Error(`CONNECT ${res.statusCode}`));
      // The app trusts both the proxy's CA (debug) and the server: no verification here, its own certificate offered.
      const t = tls.connect({ socket: sock, servername: 'localhost', rejectUnauthorized: false, ...own });
      sockets.push(t);
      t.once('secureConnect', () => cb(null, t));
      t.once('error', (e) => cb(e));
    });
    c.once('error', (e) => cb(e));
    c.end();
  };
  return { agent, connects, sockets };
}

function get(agent: https.Agent, port: number, p: string): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: p, agent }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * REVIEW-14 #1: a CONNECT to `ip:port`, then TLS with SNI `name` and a request with `Host: name` (an attacker's own
 * server by IP, posing as another host). The response status and headers.
 */
async function connectByIpAs(proxyPort: number, ip: string, port: number, name: string, p = '/secure'): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const c = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${ip}:${port}`, agent: false });
  c.end();
  const [, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
  const t = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false });
  await once(t, 'secureConnect');
  return new Promise((resolve, reject) => {
    const r = http.request({ createConnection: () => t, path: p, headers: { host: name, connection: 'keep-alive' } }, (res) => {
      res.resume();
      res.on('end', () => {
        t.destroy();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

const failed = (e: Exchange) => e.kind !== 'tunnel' && e.state === 'error';
const learnedText = (cause: string, host: string) =>
  `This server needs the app's own client certificate (${cause}). From now on ${host} is passed through without decryption, so the app talks to it directly with its own certificate. To see these requests, add the certificate in the Flutter Intercept panel (Add client certificate…).`;
const rule = (id: string, url: string, extra: Partial<Rule> = {}): Rule => ({ id, enabled: true, match: { url }, action: { kind: 'throttle', latencyMs: 1 }, ...extra });

// ---------------------------------------------------------------- pure parts

describe('learned passthrough: helpers', () => {
  it('a rule names a host only by a host part (globs, ports, IPv6; not `*`, regexes or patterns without a scheme)', () => {
    expect(patternNamesHost('https://api.example.com/*', 'api.example.com', 443)).toBe(true);
    expect(patternNamesHost('https://API.example.com/v1', 'api.example.com', 8443)).toBe(true);
    expect(patternNamesHost('https://*.example.com/*', 'api.example.com', 443)).toBe(true);
    expect(patternNamesHost('https://api.example.com:8443/*', 'api.example.com', 443)).toBe(false);
    expect(patternNamesHost('https://api.example.com:8443/*', 'api.example.com', 8443)).toBe(true);
    expect(patternNamesHost('*://api.example.com:*', 'api.example.com', 1)).toBe(true);
    expect(patternNamesHost('https://[::1]:8443/*', '::1', 8443)).toBe(true);
    expect(patternNamesHost('https://other.example.com/*', 'api.example.com', 443)).toBe(false);
    for (const p of ['*', 'https://*/*', '*/v1/*', '/api\\.example\\.com/', '']) expect(patternNamesHost(p, 'api.example.com', 443)).toBe(false);
  });

  it('keys, alerts', () => {
    expect(parseLearnedKey('API.example.com:8443')).toEqual({ host: 'api.example.com', port: 8443 });
    expect(parseLearnedKey('[::1]:443')).toEqual({ host: '::1', port: 443 });
    expect(parseLearnedKey('::1')).toEqual({ host: '::1' });
    expect(parseLearnedKey('api.example.com')).toEqual({ host: 'api.example.com' });
    expect(parseLearnedKey('a:b:c:99999')).toBeUndefined();
    expect(alertOf({ code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', message: 'x' })).toBe(116);
    expect(alertOf({ code: 'EPROTO', message: 'write EPROTO …:ssl/tls alert handshake failure:…:SSL alert number 40' })).toBe(40);
    expect(alertOf({ code: 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE' })).toBe(42);
    expect(alertOf({ code: 'ECONNRESET', message: 'socket hang up' })).toBeUndefined();
    expect(alertOfTags(['passthrough-error:EPROTO', 'passthrough-tls-error:ssl-alert-40'])).toBe(40);
  });

  it('the map: live entries, expiry, a client-certificate entry outlives a pin, the cap', () => {
    let changes = 0;
    const m = new LearnedHosts(() => changes++);
    expect(m.learn('a.test', 443, 'client-certificate')).toBe(true);
    expect(m.learn('a.test', 443, 'pinned', { until: Date.now() + 1000 })).toBe(true);
    expect(m.lookup('a.test', 443, LOOPBACK_CLIENT)?.reason).toBe('client-certificate');
    expect(m.learn('b.test', 443, 'pinned', { until: Date.now() - 1 })).toBe(true);
    expect(m.lookup('b.test', 443, LOOPBACK_CLIENT)).toBeUndefined();
    // full of client-certificate entries taught by other clients: refused
    for (let i = 0; m.size < LEARNED_MAX; i++) m.learn(`h${i}.test`, 443, 'client-certificate', { by: `192.0.2.${i % 8}` });
    expect(m.learn('full.test', 443, 'client-certificate')).toBe(false);
    m.forget((e) => e.host === 'h0.test');
    expect(m.learn('full.test', 443, 'client-certificate')).toBe(true);
    expect(m.list().length).toBe(LEARNED_MAX);
    expect(changes).toBeGreaterThan(LEARNED_MAX);
    // PERF-2 #3: re-learning a host with the same values (a burst of failures) is not a change (no event, no Status).
    const before = changes;
    for (let i = 0; i < 20; i++) expect(m.learn('full.test', 443, 'client-certificate')).toBe(true);
    expect(changes).toBe(before);
    m.learn('full.test', 443, 'client-certificate', { grpc: true });
    expect(changes).toBe(before + 1);
  });

  it('REVIEW-14 #2: pins are per client; one client at its limit loses its own oldest entries; a full map drops pins first', () => {
    const m = new LearnedHosts(() => undefined);
    const until = Date.now() + 60_000;
    m.learn('api.test', 443, 'pinned', { until, by: '192.0.2.7' });
    expect(m.lookup('api.test', 443, '192.0.2.7')?.reason).toBe('pinned');
    expect(m.lookup('api.test', 443, LOOPBACK_CLIENT)).toBeUndefined();
    m.learn('api.test', 443, 'pinned', { until: until + 1, by: LOOPBACK_CLIENT });
    expect(m.list()).toEqual([{ host: 'api.test', port: 443, reason: 'pinned', until: until + 1 }]); // one row per host:port
    // a flood from one client: its own oldest entries go; the other client's stay
    for (let i = 0; i < LEARNED_PER_CLIENT + 50; i++) m.learn(`f${i}.test`, 443, 'pinned', { until, by: '192.0.2.66' });
    expect(m.lookup('f0.test', 443, '192.0.2.66')).toBeUndefined();
    expect(m.lookup(`f${LEARNED_PER_CLIENT + 49}.test`, 443, '192.0.2.66')).toBeDefined();
    expect(m.lookup('api.test', 443, '192.0.2.7')).toBeDefined();
    expect(m.lookup('api.test', 443, LOOPBACK_CLIENT)).toBeDefined();
    // a map full of pins still learns a client-certificate host (the oldest pin goes)
    for (let c = 0; m.size < LEARNED_MAX; c++) for (let i = 0; i < LEARNED_PER_CLIENT && m.size < LEARNED_MAX; i++) m.learn(`p${c}-${i}.test`, 443, 'pinned', { until, by: `198.51.100.${c}` });
    expect(m.learn('mtls.test', 443, 'client-certificate', { by: '203.0.113.1' })).toBe(true);
    expect(m.size).toBe(LEARNED_MAX);
    expect(clientKeyOf('::ffff:127.0.0.1')).toBe(LOOPBACK_CLIENT);
    expect(clientKeyOf('::1')).toBe(LOOPBACK_CLIENT);
    expect(clientKeyOf('::ffff:192.0.2.5')).toBe('192.0.2.5');
  });

  it('REVIEW-14 #6: an expired pin leaves with an event', async () => {
    let changes = 0;
    const m = new LearnedHosts(() => changes++);
    m.learn('api.test', 443, 'pinned', { until: Date.now() + 50 });
    expect(changes).toBe(1);
    await sleep(120);
    expect(changes).toBe(2);
    expect(m.size).toBe(0);
  });

  it('CertRequestFinder reads handshake messages across records and stops at ServerHelloDone / alerts', () => {
    const rec = (type: number, body: Buffer) => Buffer.concat([Buffer.from([type, 3, 3, body.length >> 8, body.length & 255]), body]);
    const msg = (t: number, len: number) => Buffer.concat([Buffer.from([t, 0, len >> 8, len & 255]), Buffer.alloc(len, 7)]);
    const flight = Buffer.concat([msg(2, 70), msg(11, 300), msg(13, 20), msg(14, 0)]);
    const f = new CertRequestFinder();
    // split mid-message and mid-record
    const records = Buffer.concat([rec(22, flight.subarray(0, 100)), rec(22, flight.subarray(100))]);
    expect(f.push(records.subarray(0, 50))).toBeUndefined();
    expect(f.push(records.subarray(50))).toBe(true);
    const g = new CertRequestFinder();
    expect(g.push(rec(22, Buffer.concat([msg(2, 70), msg(11, 300), msg(14, 0)])))).toBe(false);
    expect(new CertRequestFinder().push(rec(21, Buffer.from([2, 40])))).toBe(false);
    expect(new CertRequestFinder().push(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'))).toBe(false);
  });
});

// ---------------------------------------------------------------- probe

describe.skipIf(!haveCerts)('the CertificateRequest probe', () => {
  it('sees a TLS 1.2 or 1.3 server ask for a certificate; a server that does not, a LAN-forbidden target and a dead port are no', async () => {
    const asks = await startMtlsServer({ mode: 'reject' });
    const asks12 = await startMtlsServer({ mode: 'reject', maxVersion: 'TLSv1.2' });
    const { key, cert } = await selfSignedCert();
    const plain = https.createServer({ key, cert }, (_q, r) => r.end('x'));
    plain.listen(0, '127.0.0.1');
    await once(plain, 'listening');
    try {
      expect(await probeCertificateRequest({ host: '127.0.0.1', port: asks12.port })).toBe(true);
      expect(await probeCertificateRequest({ host: '127.0.0.1', port: asks.port })).toBe(true); // TLS 1.2 offered: the server's 1.2 flight
      expect(await probeCertificateRequest({ host: '127.0.0.1', port: (plain.address() as AddressInfo).port })).toBe(false);
      // a LAN client's probe can't reach this machine (the CONNECT guard)
      expect(await probeCertificateRequest({ host: '127.0.0.1', port: asks12.port, lan: { listenerHost: '192.0.2.1', closed: () => false } })).toBe(false);
      const dead = net.createServer();
      dead.listen(0, '127.0.0.1');
      await once(dead, 'listening');
      const deadPort = (dead.address() as AddressInfo).port;
      dead.close();
      expect(await probeCertificateRequest({ host: '127.0.0.1', port: deadPort })).toBe(false);
      // the server never sees a certificate or application data from the probe (its handshake never completes)
      expect(asks12.handshakes.filter((h) => h === 'cert' || h === 'none')).toEqual([]);
    } finally {
      await asks.close();
      await asks12.close();
      plain.closeAllConnections();
      plain.close();
    }
  });

  it('times out on a server that never answers (≤ the limit)', async () => {
    const quiet = net.createServer((s) => s.on('data', () => undefined));
    quiet.listen(0, '127.0.0.1');
    await once(quiet, 'listening');
    const t0 = Date.now();
    expect(await probeCertificateRequest({ host: '127.0.0.1', port: (quiet.address() as AddressInfo).port }, 300)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    quiet.close();
  });
});

// ---------------------------------------------------------------- client-certificate

describe.skipIf(!haveCerts)('client-certificate: learned, then the app talks to the server with its own certificate', () => {
  let proxy: InterceptProxy;
  let events: LearnedPassthrough[][];
  beforeEach(async () => {
    proxy = await startProxy();
    events = [];
    proxy.on('learnedPassthrough', (l) => events.push(l));
  });
  afterEach(async () => {
    await proxy.stop();
  });

  for (const v of ['TLSv1.3', 'TLSv1.2'] as const) {
    it(`${v}: the failed request says why (Connection: close), the next one opens a passed-through tunnel and gets 200 with the app's certificate`, async () => {
      const srv = await startMtlsServer({ mode: 'reject', maxVersion: v });
      const app = proxiedAgent(proxy.port, { cert: read('cert.pem'), key: read('key.pem') });
      try {
        const first = await get(app.agent, srv.port, '/whoami');
        expect(first.status).toBe(502);
        expect(first.headers.connection).toBe('close');
        const ex = await waitFor(proxy, (e) => failed(e) && !!e.learnedPassthrough);
        const cause = v === 'TLSv1.3' ? 'TLS alert certificate_required' : 'TLS alert handshake_failure; the server asks for a client certificate';
        expect(ex.error).toBe(learnedText(cause, `127.0.0.1:${srv.port}`));
        expect(ex.learnedPassthrough).toEqual({ reason: 'client-certificate', host: '127.0.0.1', port: srv.port });
        expect(proxy.learnedPassthrough).toEqual([{ host: '127.0.0.1', port: srv.port, reason: 'client-certificate' }]);
        await sleep(20);
        expect(events.at(-1)).toEqual(proxy.learnedPassthrough);

        const second = await get(app.agent, srv.port, '/whoami');
        expect(second).toMatchObject({ status: 200, text: 'fi-app-client' });
        expect(app.connects).toEqual(['200', '200']); // a new CONNECT: the first connection was closed
        const tunnel = await waitFor(proxy, (e) => e.kind === 'tunnel' && !!e.learnedPassthrough);
        expect(tunnel).toMatchObject({ method: 'CONNECT', url: `https://127.0.0.1:${srv.port}/`, learnedPassthrough: { reason: 'client-certificate', host: '127.0.0.1', port: srv.port } });
        expect(notesOf(tunnel)).toBe("This server needs the app's own certificate: passed through without decryption.");
        expect(srv.handshakes).toContain('cert');
        // forget → decrypted again (fails again, learned again)
        proxy.forgetLearnedPassthrough(`127.0.0.1:${srv.port}`);
        expect(proxy.learnedPassthrough).toEqual([]);
        app.agent.destroy();
        const again = proxiedAgent(proxy.port, { cert: read('cert.pem'), key: read('key.pem') });
        expect((await get(again.agent, srv.port, '/whoami')).status).toBe(502);
        again.agent.destroy();
        await waitFor(proxy, (e) => failed(e) && !!e.learnedPassthrough && e.id !== ex.id);
        expect(proxy.learnedPassthrough.length).toBe(1);
      } finally {
        app.agent.destroy();
        await srv.close();
      }
    });
  }

  it("nginx's 400: learned at once, the app gets the server's own 400 with Connection: close; its other idle connections are closed", async () => {
    const srv = await startMtlsServer({ mode: 'nginx' });
    const app = proxiedAgent(proxy.port, { cert: read('cert.pem'), key: read('key.pem') }, 2);
    try {
      // two keep-alive connections, both idle
      expect((await Promise.all([get(app.agent, srv.port, '/ok'), get(app.agent, srv.port, '/ok')])).map((r) => r.status)).toEqual([200, 200]);
      expect(app.sockets.length).toBe(2);
      const closed = app.sockets.map((s) => once(s, 'close'));
      const r = await get(app.agent, srv.port, '/secure');
      expect(r.status).toBe(400);
      expect(r.text).toBe(NGINX_PAGE);
      expect(r.headers.connection).toBe('close');
      const ex = await waitFor(proxy, (e) => failed(e) && !!e.learnedPassthrough);
      expect(ex.status).toBe(400);
      expect(ex.error).toBe(learnedText('HTTP 400 "No required SSL certificate was sent"', `127.0.0.1:${srv.port}`));
      await Promise.all(closed); // the other idle connection too
      const ok = await get(app.agent, srv.port, '/secure');
      expect(ok).toMatchObject({ status: 200, text: 'fi-app-client' });
      expect(app.connects.length).toBe(3);
    } finally {
      app.agent.destroy();
      await srv.close();
    }
  });

  it('an HTTPS 400 that is not the nginx page teaches nothing (an API error keeps its connection)', async () => {
    const { key, cert } = await selfSignedCert();
    const api = https.createServer({ key, cert }, (_q, res) => res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad"}'));
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const app = proxiedAgent(proxy.port);
    try {
      const port = (api.address() as AddressInfo).port;
      const r = await get(app.agent, port, '/x');
      expect(r.status).toBe(400);
      expect(r.headers.connection).not.toBe('close');
      await get(app.agent, port, '/x');
      expect(app.connects.length).toBe(1);
      expect(proxy.learnedPassthrough).toEqual([]);
    } finally {
      app.agent.destroy();
      api.closeAllConnections();
      api.close();
    }
  });

  it('configuring a certificate for a learned host forgets it: decrypted again, the proxy presents it', async () => {
    const srv = await startMtlsServer({ mode: 'reject' });
    try {
      const app = proxiedAgent(proxy.port);
      expect((await get(app.agent, srv.port, '/whoami')).status).toBe(502);
      app.agent.destroy();
      expect(proxy.learnedPassthrough.length).toBe(1);
      proxy.setClientCertificates([{ host: 'other.example.test', cert: read('othercert.pem'), key: read('other.pem') }]);
      expect(proxy.learnedPassthrough.length).toBe(1); // not for this host
      proxy.setClientCertificates([{ host: '127.0.0.1', cert: read('cert.pem'), key: read('key.pem') }]);
      expect(proxy.learnedPassthrough).toEqual([]);
      const app2 = proxiedAgent(proxy.port);
      expect(await get(app2.agent, srv.port, '/whoami')).toMatchObject({ status: 200, text: 'fi-app-client' });
      app2.agent.destroy();
      const ex = await waitFor(proxy, (e) => e.state === 'completed');
      expect(ex.clientCertificate).toBe('127.0.0.1');
    } finally {
      await srv.close();
    }
  });

  it('a configured certificate the server rejects with an alert: says so, nothing learned, no probe', async () => {
    // A server that refuses every handshake with bad_certificate (42), as OpenSSL-verifying servers do for a wrong one.
    const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x2a]);
    const bad = net.createServer((s) => s.once('data', () => s.end(alert)));
    bad.listen(0, '127.0.0.1');
    await once(bad, 'listening');
    let probes = 0;
    probeTesting.probe = async () => (probes++, true);
    try {
      proxy.setClientCertificates([{ host: '127.0.0.1', cert: read('othercert.pem'), key: read('other.pem') }]);
      const app = proxiedAgent(proxy.port);
      const r = await get(app.agent, (bad.address() as AddressInfo).port, '/x');
      app.agent.destroy();
      expect(r.status).toBe(502);
      expect(r.headers.connection).not.toBe('close');
      const ex = await waitFor(proxy, (e) => failed(e) && /configured for/.test(e.error ?? ''));
      expect(ex.error).toBe('The server rejected the client certificate configured for 127.0.0.1 (bad_certificate).');
      expect(ex.learnedPassthrough).toBeUndefined();
      expect(proxy.learnedPassthrough).toEqual([]);
      expect(probes).toBe(0);
    } finally {
      delete probeTesting.probe;
      bad.close();
    }
  });

  it('never learned while a rule names the host (it stays decrypted, the error says so) or a recording is replayed', async () => {
    const srv = await startMtlsServer({ mode: 'reject' });
    try {
      proxy.setRules([rule('r1', `https://127.0.0.1:${srv.port}/*`, { name: 'slow api' })]);
      const app = proxiedAgent(proxy.port);
      expect((await get(app.agent, srv.port, '/whoami')).status).toBe(502);
      app.agent.destroy();
      const ex = await waitFor(proxy, (e) => failed(e) && /stays decrypted/.test(e.error ?? ''));
      expect(ex.error).toBe(
        `This server needs the app's own client certificate (TLS alert certificate_required). The enabled rule "slow api" targets 127.0.0.1:${srv.port}, so 127.0.0.1:${srv.port} stays decrypted for the rules to work. To make these requests work, add the certificate in the Flutter Intercept panel (Add client certificate…).`,
      );
      expect(proxy.learnedPassthrough).toEqual([]);
      // a rule without a host part (any host) doesn't keep it decrypted
      proxy.setRules([rule('r2', '*')]);
      proxy.setReplay([{ method: 'GET', url: 'https://elsewhere.example/x', status: 200, headers: {} }]);
      const app2 = proxiedAgent(proxy.port);
      expect((await get(app2.agent, srv.port, '/whoami')).status).toBe(502);
      app2.agent.destroy();
      await waitFor(proxy, (e) => failed(e) && /A recording is being replayed/.test(e.error ?? ''));
      expect(proxy.learnedPassthrough).toEqual([]);
      proxy.setReplay(undefined);
      const app3 = proxiedAgent(proxy.port);
      expect((await get(app3.agent, srv.port, '/whoami')).status).toBe(502);
      app3.agent.destroy();
      expect(proxy.learnedPassthrough.length).toBe(1);
      // learned, then a rule names the host: its CONNECTs are decrypted again (the rule answers them)
      proxy.setRules([{ id: 'm', enabled: true, match: { url: `https://127.0.0.1:${srv.port}/*` }, action: { kind: 'mock', status: 200, body: 'mocked' } }]);
      const app4 = proxiedAgent(proxy.port);
      expect(await get(app4.agent, srv.port, '/whoami')).toMatchObject({ status: 200, text: 'mocked' });
      app4.agent.destroy();
    } finally {
      await srv.close();
    }
  });

  it('handshake_failure without a CertificateRequest: no learning; one probe per host:port for many failures', async () => {
    // A "server" that answers every ClientHello with a handshake_failure alert.
    const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]);
    const bad = net.createServer((s) => s.once('data', () => s.end(alert)));
    bad.listen(0, '127.0.0.1');
    await once(bad, 'listening');
    const port = (bad.address() as AddressInfo).port;
    let probes = 0;
    probeTesting.probe = async (t) => {
      probes++;
      return probeCertificateRequest(t);
    };
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, async () => {
          const app = proxiedAgent(proxy.port);
          try {
            return (await get(app.agent, port, '/x')).status;
          } finally {
            app.agent.destroy();
          }
        }),
      );
      expect(results.every((s) => s === 502)).toBe(true);
      await sleep(100);
      expect(probes).toBe(1);
      expect(proxy.learnedPassthrough).toEqual([]);
      const ex = proxy.getExchanges().filter(failed);
      expect(ex.length).toBe(12);
      for (const e of ex) expect(e.error).toMatch(/handshake failure/);
      // A later failure there reuses the probe's answer (PROBE_NEGATIVE_MS).
      const app = proxiedAgent(proxy.port);
      try {
        expect((await get(app.agent, port, '/x')).status).toBe(502);
      } finally {
        app.agent.destroy();
      }
      expect(probes).toBe(1);
    } finally {
      delete probeTesting.probe;
      bad.close();
    }
  });

  it('PERF-2 #2: a probe that said yes is reused — with the map full, repeated failures start no new probes', async () => {
    const srv = await startMtlsServer({ mode: 'reject', maxVersion: 'TLSv1.2' });
    let probes = 0;
    probeTesting.probe = async (t) => {
      probes++;
      return probeCertificateRequest(t);
    };
    const hosts = proxy[TEST_INTERNALS]().learn.hosts;
    // full of client-certificate hosts that other clients taught
    for (let i = 0; i < LEARNED_MAX; i++) hosts.learn(`h${i}.example.test`, 443, 'client-certificate', { by: `192.0.2.${i % 8}` });
    try {
      for (let i = 0; i < 4; i++) {
        const app = proxiedAgent(proxy.port);
        expect((await get(app.agent, srv.port, '/whoami')).status).toBe(502);
        app.agent.destroy();
      }
      await waitFor(proxy, (e) => failed(e) && /hosts are passed through already/.test(e.error ?? ''));
      expect(probes).toBe(1);
      expect(hosts.size).toBe(LEARNED_MAX);
    } finally {
      delete probeTesting.probe;
      await srv.close();
    }
  });

  it('the probe goes through the upstream proxy when one is set', async () => {
    const srv = await startMtlsServer({ mode: 'reject', maxVersion: 'TLSv1.2' });
    const up = await startTinyProxy();
    await proxy.stop();
    proxy = await startProxy({ upstreamProxy: { url: up.url } });
    try {
      const app = proxiedAgent(proxy.port, { cert: read('cert.pem'), key: read('key.pem') });
      const name = `mtls.example.invalid:${srv.port}`;
      const r = await new Promise<number>((resolve, reject) => {
        const req = https.request({ host: 'mtls.example.invalid', port: srv.port, path: '/whoami', agent: app.agent }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      expect(r).toBe(502);
      await waitFor(proxy, (e) => failed(e) && !!e.learnedPassthrough);
      // the request's own connection and the probe: both CONNECTs through the upstream proxy
      expect(up.seen.filter((s) => s === `CONNECT ${name}`).length).toBe(2);
      app.agent.destroy();
    } finally {
      await up.close();
      await srv.close();
    }
  });

  it('REVIEW-14 #1: a CONNECT to an IP whose Host / SNI names another host teaches nothing (alert 116 and the nginx 400)', async () => {
    for (const mode of ['reject', 'nginx'] as const) {
      const srv = await startMtlsServer({ mode });
      try {
        const r = await connectByIpAs(proxy.port, '127.0.0.1', srv.port, 'api.victim.example');
        expect(r.status).toBe(mode === 'reject' ? 502 : 400);
        expect(r.headers.connection).not.toBe('close');
        const ex = await waitFor(proxy, (e) => e.kind !== 'tunnel' && e.state !== 'pending' && e.url.startsWith('https://api.victim.example'));
        expect(ex.url).toBe(`https://api.victim.example:${srv.port}/secure`);
        expect(ex.learnedPassthrough).toBeUndefined();
        expect(ex.error ?? '').not.toMatch(/needs the app's own client certificate/); // today's text
        await sleep(50);
        expect(proxy.learnedPassthrough).toEqual([]);
        // the real app's CONNECT to that name stays decrypted
        expect(proxy[TEST_INTERNALS]().learn.forConnect('api.victim.example', srv.port, LOOPBACK_CLIENT)).toBeUndefined();
      } finally {
        await srv.close();
      }
    }
  });

  it('REVIEW-14 #1: an app that connects by IP (Host = the IP) is learned under the IP its next CONNECT uses', async () => {
    const srv = await startMtlsServer({ mode: 'reject' });
    try {
      const r = await connectByIpAs(proxy.port, '127.0.0.1', srv.port, `127.0.0.1:${srv.port}`, '/whoami');
      expect(r.status).toBe(502);
      expect(r.headers.connection).toBe('close');
      expect(proxy.learnedPassthrough).toEqual([{ host: '127.0.0.1', port: srv.port, reason: 'client-certificate' }]);
      const app = proxiedAgent(proxy.port, { cert: read('cert.pem'), key: read('key.pem') });
      expect(await get(app.agent, srv.port, '/whoami')).toMatchObject({ status: 200, text: 'fi-app-client' });
      app.agent.destroy();
    } finally {
      await srv.close();
    }
  });

  it("REVIEW-14 #6: an HTML 400 closes the app's connection only for a host that may be learned", async () => {
    const { key, cert } = await selfSignedCert();
    const html = https.createServer({ key, cert }, (req, res) =>
      req.url === '/bare' ? res.writeHead(400).end('bad') : res.writeHead(400, { 'content-type': 'text/html' }).end('<p>bad</p>'),
    );
    html.listen(0, '127.0.0.1');
    await once(html, 'listening');
    const port = (html.address() as AddressInfo).port;
    try {
      const one = async (p: string) => {
        const app = proxiedAgent(proxy.port);
        const r = await get(app.agent, port, p);
        app.agent.destroy();
        return r.headers.connection;
      };
      expect(await one('/page')).toBe('close'); // may be nginx's page: read at the end
      expect(await one('/bare')).not.toBe('close'); // no content type: not nginx
      proxy.setRules([rule('r', `https://127.0.0.1:${port}/other/*`)]);
      expect(await one('/page')).not.toBe('close'); // a rule names the host: never learned
      proxy.setRules([]);
      proxy.setClientCertificates([{ host: '127.0.0.1', cert: read('cert.pem'), key: read('key.pem') }]);
      expect(await one('/page')).not.toBe('close'); // a configured certificate: never learned
      expect(proxy.learnedPassthrough).toEqual([]);
    } finally {
      html.closeAllConnections();
      html.close();
    }
  });

  it('stop() forgets everything', async () => {
    const srv = await startMtlsServer({ mode: 'reject' });
    const app = proxiedAgent(proxy.port);
    await get(app.agent, srv.port, '/whoami');
    app.agent.destroy();
    expect(proxy.learnedPassthrough.length).toBe(1);
    await proxy.stop();
    expect(proxy.learnedPassthrough).toEqual([]);
    await srv.close();
  });
});

// ---------------------------------------------------------------- gRPC

describe('the probe cap', () => {
  it('REVIEW-14 #6: probes that hang in an upstream proxy count toward the 4-at-once cap until their work ends (≤ 5 s)', async () => {
    const seen: net.Socket[] = [];
    const hang = net.createServer((s) => {
      seen.push(s);
      s.on('data', () => undefined); // reads the CONNECT, never answers
    });
    hang.listen(0, '127.0.0.1');
    await once(hang, 'listening');
    const proxy = await startProxy({ upstreamProxy: { url: `http://127.0.0.1:${(hang.address() as AddressInfo).port}` } });
    try {
      const learn = proxy[TEST_INTERNALS]().learn;
      const t0 = Date.now();
      const all = Promise.all(Array.from({ length: 6 }, (_, i) => learn.verdict({ host: `h${i}.example.invalid`, port: 443, alert: 40 })));
      await sleep(300);
      expect(seen.length).toBe(4);
      expect(await all).toEqual(Array(6).fill(undefined));
      expect(Date.now() - t0).toBeLessThan(7000);
      await sleep(100);
      expect(seen.every((s) => s.destroyed || s.readableEnded)).toBe(true); // the upstream deadline closed them
      // slots are free again
      const again = learn.verdict({ host: 'h9.example.invalid', port: 443, alert: 40 });
      await sleep(300);
      expect(seen.length).toBe(5);
      await again;
    } finally {
      await proxy.stop();
      for (const s of seen) s.destroy();
      hang.close();
    }
  }, 20_000);
});

describe.skipIf(!haveCerts)('client-certificate on a decrypted gRPC call', () => {
  for (const v of ['TLSv1.3', 'TLSv1.2'] as const) {
    it(`${v} on the relay: UNAVAILABLE with the reason, learned; the next silent tunnel is passed through`, async () => {
      const { key, cert } = await selfSignedCert();
      const server = http2.createSecureServer({ key, cert, requestCert: true, rejectUnauthorized: true, ca: [read('cert.pem')], maxVersion: v });
      server.on('stream', (stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
      });
      server.on('error', () => undefined);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as AddressInfo).port;
      const target = `127.0.0.1:${port}`;
      const proxy = await startProxy({ grpcDecryptAll: true });
      try {
        const open = async (own: tls.ConnectionOptions) => {
          const sock = await silentSocket(proxy.port, target);
          const t = tls.connect({ socket: sock, servername: 'localhost', ALPNProtocols: ['h2'], rejectUnauthorized: false, ...own });
          await once(t, 'secureConnect');
          const s = http2.connect(`https://${target}`, { createConnection: () => t });
          s.on('error', () => undefined);
          return s;
        };
        const s1 = await open({});
        const closed = once(s1, 'close');
        const r = await grpcCall(s1, '/t.Svc/M', ['x']);
        expect(r.grpcStatus).toBe(14);
        const ex = await waitFor(proxy, (e) => e.kind === 'grpc' && e.state === 'error');
        expect(ex.error).toBe(learnedText(v === 'TLSv1.3' ? 'TLS alert certificate_required' : 'TLS alert handshake_failure; the server asks for a client certificate', target));
        expect(ex.learnedPassthrough).toEqual({ reason: 'client-certificate', host: '127.0.0.1', port });
        expect(proxy.learnedPassthrough).toEqual([{ host: '127.0.0.1', port, reason: 'client-certificate', grpc: true }]);
        await closed; // the app's connection was closed gracefully (GOAWAY)
        const s2 = await open({ cert: read('cert.pem'), key: read('key.pem') });
        expect((await grpcCall(s2, '/t.Svc/M', ['x'])).grpcStatus).toBe(0);
        s2.destroy();
        const tunnel = await waitFor(proxy, (e) => e.kind === 'tunnel' && !!e.learnedPassthrough);
        expect(notesOf(tunnel)).toBe("This server needs the app's own certificate: passed through without decryption.");
        // decrypt-all turned on again keeps client-certificate entries (it resets gRPC pins only)
        proxy.setGrpcDecryptAll(false);
        proxy.setGrpcDecryptAll(true);
        expect(proxy.learnedPassthrough.length).toBe(1);
        expect(proxy.grpcPinnedHosts).toEqual([]);
      } finally {
        await proxy.stop();
        server.close();
      }
    });
  }

  it('REVIEW-14 #1: a silent tunnel to an IP whose :authority names another host teaches nothing', async () => {
    const { key, cert } = await selfSignedCert();
    const server = http2.createSecureServer({ key, cert, requestCert: true, rejectUnauthorized: true, ca: [read('cert.pem')] });
    server.on('error', () => undefined);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const proxy = await startProxy({ grpcDecryptAll: true });
    try {
      const sock = await silentSocket(proxy.port, `127.0.0.1:${port}`);
      const t = tls.connect({ socket: sock, servername: 'localhost', ALPNProtocols: ['h2'], rejectUnauthorized: false });
      await once(t, 'secureConnect');
      const s = http2.connect(`https://localhost:${port}`, { createConnection: () => t });
      s.on('error', () => undefined);
      const r = await grpcCall(s, '/t.Svc/M', ['x']);
      expect(r.grpcStatus).toBe(14);
      const ex = await waitFor(proxy, (e) => e.kind === 'grpc' && e.state === 'error');
      expect(ex.learnedPassthrough).toBeUndefined();
      expect(proxy.learnedPassthrough).toEqual([]);
      s.destroy();
    } finally {
      await proxy.stop();
      server.close();
    }
  });
});

// ---------------------------------------------------------------- pinned (HTTP)

describe('pinned: an app that rejects the proxy certificate on an HTTPS CONNECT', () => {
  let proxy: InterceptProxy;
  let srvPort: number;
  let srv: https.Server;
  beforeEach(async () => {
    const { key, cert } = await selfSignedCert();
    srv = https.createServer({ key, cert }, (_q, r) => r.end('real'));
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    srvPort = (srv.address() as AddressInfo).port;
    proxy = await startProxy();
  });
  afterEach(async () => {
    await proxy.stop();
    srv.closeAllConnections();
    srv.close();
  });

  /** A CONNECT, then a TLS client that verifies (it doesn't trust the proxy's CA): it sends an alert. */
  async function verifyingClient(): Promise<string> {
    const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${srvPort}`, agent: false });
    c.end();
    const [, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
    const t = tls.connect({ socket: raw, servername: 'localhost' });
    return new Promise((resolve) => {
      t.once('secureConnect', () => {
        resolve(t.getPeerCertificate().subject?.CN ?? '');
        t.destroy();
      });
      t.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
  }

  /** A client that drops the connection right after the proxy's certificate (dart:io's way, no alert). */
  async function droppingClient(): Promise<void> {
    const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${srvPort}`, agent: false });
    c.end();
    const [, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
    const t = tls.connect({ socket: raw, servername: 'localhost', rejectUnauthorized: false });
    await once(t, 'secureConnect');
    t.destroy();
  }

  it('an alert pins at once (10 minutes); the next CONNECT is a passed-through tunnel with the note', async () => {
    // A client that sends an alert (OpenSSL, browsers; Node and dart:io just close): the failure mockttp reports for a
    // CONNECT whose handshake we watch.
    expect(await verifyingClient()).toBe('SELF_SIGNED_CERT_IN_CHAIN'); // (Node: a close, the first strike)
    const p = proxy[TEST_INTERNALS]();
    p.decrypting.set('127.0.0.1:40001', { host: '127.0.0.1', port: srvPort, http: true });
    p.onTlsError({ failureCause: 'cert-rejected', remoteIpAddress: '127.0.0.1', remotePort: 40001, timingEvents: {} });
    const ex = await waitFor(proxy, (e) => !!e.learnedPassthrough && e.state === 'error');
    expect(ex.error).toBe(`127.0.0.1:${srvPort} pins its certificate: passed through without decryption from now on, for 10 minutes (the app rejected the Flutter Intercept certificate).`);
    expect(ex.learnedPassthrough).toEqual({ reason: 'pinned', host: '127.0.0.1', port: srvPort });
    const [entry] = proxy.learnedPassthrough;
    expect(entry).toMatchObject({ host: '127.0.0.1', port: srvPort, reason: 'pinned' });
    expect(entry.grpc).toBeUndefined();
    expect(entry.until! - Date.now()).toBeGreaterThan(GRPC_PIN_TTL_MS - 5000);
    expect(proxy.grpcPinnedHosts).toEqual([]); // not a gRPC pin
    // passed through: the real server's own certificate reaches the client
    const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${srvPort}`, agent: false });
    c.end();
    const [res, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
    expect(res.statusCode).toBe(200);
    const t = tls.connect({ socket: raw, servername: 'localhost', rejectUnauthorized: false });
    await once(t, 'secureConnect');
    expect(t.getPeerCertificate().fingerprint256).toBe(new X509Certificate((await selfSignedCert()).cert).fingerprint256);
    t.destroy();
    const tunnel = await waitFor(proxy, (e) => e.kind === 'tunnel' && e.state === 'completed' && !!e.learnedPassthrough);
    expect(notesOf(tunnel)).toBe(`127.0.0.1 pins its certificate: passed through without decryption.`);
    expect(tunnel.learnedPassthrough).toEqual({ reason: 'pinned', host: '127.0.0.1', port: srvPort });
  });

  it('§20.6: no HTTPS pins while the host routes native clients (setHttpPinLearning(false)); turning it off forgets HTTPS pins', async () => {
    const p = proxy[TEST_INTERNALS]();
    p.decrypting.set('127.0.0.1:40002', { host: '127.0.0.1', port: srvPort, http: true });
    p.onTlsError({ failureCause: 'cert-rejected', remoteIpAddress: '127.0.0.1', remotePort: 40002, timingEvents: {} });
    await waitFor(proxy, (e) => !!e.learnedPassthrough && e.state === 'error');
    expect(proxy.learnedPassthrough.map((e) => e.reason)).toEqual(['pinned']);
    proxy.setHttpPinLearning(false);
    expect(proxy.httpPinLearning).toBe(false);
    expect(proxy.learnedPassthrough).toEqual([]); // forgotten
    p.decrypting.set('127.0.0.1:40003', { host: '127.0.0.1', port: srvPort, http: true });
    p.onTlsError({ failureCause: 'cert-rejected', remoteIpAddress: '127.0.0.1', remotePort: 40003, timingEvents: {} });
    // The pre-0.14 record: the rejection is reported, nothing is learned.
    const ex = await waitFor(proxy, (e) => e.state === 'error' && /The app probably rejects the proxy's certificate/.test(String(e.error)));
    expect(ex.learnedPassthrough).toBeUndefined();
    expect(proxy.learnedPassthrough).toEqual([]);
    proxy.setHttpPinLearning(true);
    p.decrypting.set('127.0.0.1:40004', { host: '127.0.0.1', port: srvPort, http: true });
    p.onTlsError({ failureCause: 'cert-rejected', remoteIpAddress: '127.0.0.1', remotePort: 40004, timingEvents: {} });
    for (let i = 0; i < 100 && proxy.learnedPassthrough.length !== 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(proxy.learnedPassthrough.map((e) => e.reason)).toEqual(['pinned']); // learning again
  });

  it('a close in the handshake counts twice within a minute; pins expire; a rule naming the host keeps it decrypted', async () => {
    grpcPinTesting.ttlMs = 300;
    try {
      await droppingClient();
      await waitFor(proxy, (e) => /If it happens again within a minute/.test(e.error ?? ''));
      expect(proxy.learnedPassthrough).toEqual([]);
      await droppingClient();
      await waitFor(proxy, (e) => !!e.learnedPassthrough);
      expect(proxy.learnedPassthrough.map((e) => e.reason)).toEqual(['pinned']);
      await sleep(400);
      expect(proxy.learnedPassthrough).toEqual([]); // expired: decrypted again
      proxy.setRules([rule('r', `https://127.0.0.1:${srvPort}/*`)]);
      await droppingClient();
      await droppingClient();
      const ex = await waitFor(proxy, (e) => /stays decrypted/.test(e.error ?? ''));
      expect(ex.error).toMatch(/The enabled rule r targets/);
      expect(proxy.learnedPassthrough).toEqual([]);
    } finally {
      delete grpcPinTesting.ttlMs;
    }
  });

  it('PERF-2 #1: an app that completed a decrypted request drops spare connections without pinning the host', async () => {
    // An app that trusts the proxy's CA makes a request over a decrypted CONNECT and keeps the connection open…
    const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${srvPort}`, agent: false });
    c.end();
    const [, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
    const t = tls.connect({ socket: raw, servername: 'localhost', rejectUnauthorized: false });
    await once(t, 'secureConnect');
    let got = '';
    t.on('data', (d: Buffer) => (got += d.toString('latin1')));
    t.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${srvPort}\r\n\r\n`);
    for (let i = 0; i < 200 && !got.includes('real'); i++) await sleep(10);
    expect(got).toContain('real');
    // …its connection is no longer watched for a failed handshake (no entry per busy connection)…
    expect(proxy[TEST_INTERNALS]().decrypting.size).toBe(0);
    // …then drops two spare connections right after their handshakes (a pool trimming, a cancelled request): that is
    // not a pin (an app that pins never completes a decrypted request), so the host stays decrypted.
    await droppingClient();
    await droppingClient();
    await waitFor(proxy, (e) => e.method === 'CONNECT' && /TLS handshake with the app failed/.test(e.error ?? ''));
    await sleep(300);
    expect(proxy.learnedPassthrough).toEqual([]);
    expect(proxy.getExchanges().filter((e) => e.method === 'CONNECT' && e.state === 'error').length).toBe(2);
    t.destroy();
  });

  it("REVIEW-14 #2: another client's pin doesn't pass the app's CONNECTs through", async () => {
    const p = proxy[TEST_INTERNALS]();
    p.decrypting.set('192.0.2.9:40001', { host: '127.0.0.1', port: srvPort, http: true });
    p.onTlsError({ failureCause: 'cert-rejected', remoteIpAddress: '192.0.2.9', remotePort: 40001, timingEvents: {} });
    await waitFor(proxy, (e) => !!e.learnedPassthrough);
    expect(proxy.learnedPassthrough.map((e) => e.reason)).toEqual(['pinned']);
    expect(p.learn.forConnect('127.0.0.1', srvPort, '192.0.2.9')?.reason).toBe('pinned');
    expect(p.learn.forConnect('127.0.0.1', srvPort, LOOPBACK_CLIENT)).toBeUndefined();
    // the app (loopback) still gets the proxy's certificate: decrypted
    const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${srvPort}`, agent: false });
    c.end();
    const [, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
    const t = tls.connect({ socket: raw, servername: 'localhost', rejectUnauthorized: false });
    await once(t, 'secureConnect');
    expect(t.getPeerCertificate().fingerprint256).not.toBe(new X509Certificate((await selfSignedCert()).cert).fingerprint256);
    t.destroy();
  });

  it('REVIEW-14 #2: a handshake dropped before the proxy sent its certificate is no strike', async () => {
    // What mockttp reports for both is `reset`; the client's connection tells them apart: a client that destroys its
    // socket right after its ClientHello leaves ~19 bytes written to it (the CONNECT answer) when it wins the race,
    // ~3.5 KB once our TLS flight went out (measured).
    const p = proxy[TEST_INTERNALS]();
    const fail = (port: number, written: number) => {
      p.decrypting.set(`127.0.0.1:${port}`, { host: '127.0.0.1', port: srvPort, http: true, socket: { bytesWritten: written } as net.Socket, sent0: 0 });
      p.onTlsError({ failureCause: 'reset', remoteIpAddress: '127.0.0.1', remotePort: port, timingEvents: {} });
    };
    fail(40001, 19);
    fail(40002, 19);
    fail(40003, 19);
    await sleep(20);
    expect(proxy.learnedPassthrough).toEqual([]);
    expect(proxy.getExchanges().some((e) => /If it happens again/.test(e.error ?? ''))).toBe(false);
    fail(40004, 3545);
    fail(40005, 3545);
    await waitFor(proxy, (e) => !!e.learnedPassthrough);
    expect(proxy.learnedPassthrough.map((e) => e.reason)).toEqual(['pinned']);
  });

  it('REVIEW-14 #2: 1000 stale single strikes do not stop close-based learning for a new host', async () => {
    const strikes = (proxy as unknown as { connect: { pinStrikes: Map<string, { n: number; first: number }> } }).connect.pinStrikes;
    for (let i = 0; i < 1000; i++) strikes.set(`192.0.2.1|h${i}.example.test:443`, { n: 1, first: Date.now() - 120_000 });
    await droppingClient();
    await droppingClient();
    await waitFor(proxy, (e) => !!e.learnedPassthrough);
    expect(proxy.learnedPassthrough.map((e) => e.host)).toEqual(['127.0.0.1']);
    expect(strikes.size).toBeLessThan(1000);
  });

  it('REVIEW-14 #6: a pin yields to a rule added after it', async () => {
    const p = proxy[TEST_INTERNALS]();
    p.learn.hosts.learn('127.0.0.1', srvPort, 'pinned', { until: Date.now() + 60_000, by: LOOPBACK_CLIENT });
    const fingerprint = async () => {
      const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${srvPort}`, agent: false });
      c.end();
      const [, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
      const t = tls.connect({ socket: raw, servername: 'localhost', rejectUnauthorized: false });
      await once(t, 'secureConnect');
      const f = t.getPeerCertificate().fingerprint256;
      t.destroy();
      return f;
    };
    const real = new X509Certificate((await selfSignedCert()).cert).fingerprint256;
    expect(await fingerprint()).toBe(real); // passed through
    proxy.setRules([rule('r', `https://127.0.0.1:${srvPort}/*`)]);
    expect(await fingerprint()).not.toBe(real); // decrypted: the rule applies
  });

  it('the 0.13 gRPC views stay views: grpcPinnedHosts, clearGrpcPinnedHosts, setGrpcDecryptAll reset gRPC pins only', () => {
    const p = proxy[TEST_INTERNALS]();
    p.pinnedHosts.set('grpc.example.test:443', Date.now() + 60_000);
    p.learn.hosts.learn('web.example.test', 443, 'pinned', { until: Date.now() + 60_000 });
    p.learn.hosts.learn('mtls.example.test', 443, 'client-certificate');
    expect(proxy.grpcPinnedHosts).toEqual(['grpc.example.test:443']);
    proxy.clearGrpcPinnedHosts();
    expect(proxy.grpcPinnedHosts).toEqual([]);
    expect(proxy.learnedPassthrough.map((e) => e.host)).toEqual(['web.example.test', 'mtls.example.test']);
    p.pinnedHosts.set('grpc.example.test:443', Date.now() + 60_000);
    proxy.setGrpcDecryptAll(true);
    expect(proxy.learnedPassthrough.map((e) => e.host)).toEqual(['web.example.test', 'mtls.example.test']);
    proxy.forgetLearnedPassthrough('web.example.test');
    expect(proxy.learnedPassthrough.map((e) => e.host)).toEqual(['mtls.example.test']);
    proxy.forgetLearnedPassthrough();
    expect(proxy.learnedPassthrough).toEqual([]);
  });
});

// ---------------------------------------------------------------- automatic passthrough off (CONTRACTS §20.7)

describe.skipIf(!haveCerts)('§20.7: automatic passthrough off; needsClientCertificate', () => {
  const offText = (cause: string) =>
    `This server needs the app's own client certificate (${cause}). Automatic passthrough is off (flutterIntercept.autoPassthrough), so its requests keep failing through Flutter Intercept: add the certificate in the Flutter Intercept panel (Add client certificate…), or turn it on.`;
  let proxy: InterceptProxy;
  let probes = 0;
  beforeEach(async () => {
    probes = 0;
    probeTesting.probe = async (t) => {
      probes++;
      return probeCertificateRequest(t);
    };
    proxy = await startProxy({ autoPassthrough: false });
  });
  afterEach(async () => {
    delete probeTesting.probe;
    await proxy.stop();
  });

  it('the option and the setter (default on)', async () => {
    expect(proxy.autoPassthrough).toBe(false);
    const other = await startProxy();
    expect(other.autoPassthrough).toBe(true);
    other.setAutoPassthrough(false);
    expect(other.autoPassthrough).toBe(false);
    await other.stop();
  });

  it('TLS 1.3 certificate_required: says what the server wants, nothing learned, no Connection: close; the next request fails the same way', async () => {
    const srv = await startMtlsServer({ mode: 'reject' });
    const app = proxiedAgent(proxy.port, { cert: read('cert.pem'), key: read('key.pem') });
    try {
      const first = await get(app.agent, srv.port, '/whoami');
      expect(first.status).toBe(502);
      expect(first.headers.connection).not.toBe('close');
      const ex = await waitFor(proxy, (e) => failed(e) && !!e.needsClientCertificate);
      expect(ex.error).toBe(offText('TLS alert certificate_required'));
      expect(ex.needsClientCertificate).toEqual({ host: '127.0.0.1', port: srv.port });
      expect(ex.learnedPassthrough).toBeUndefined();
      expect(proxy.learnedPassthrough).toEqual([]);
      expect((await get(app.agent, srv.port, '/whoami')).status).toBe(502);
      expect(proxy.getExchanges().some((e) => e.kind === 'tunnel')).toBe(false);
    } finally {
      app.agent.destroy();
      await srv.close();
    }
  });

  it('TLS 1.2 handshake_failure: no probe, the "may need" text, needsClientCertificate set', async () => {
    const srv = await startMtlsServer({ mode: 'reject', maxVersion: 'TLSv1.2' });
    const app = proxiedAgent(proxy.port);
    try {
      expect((await get(app.agent, srv.port, '/whoami')).status).toBe(502);
      const ex = await waitFor(proxy, (e) => failed(e) && !!e.needsClientCertificate);
      expect(ex.error).toBe(
        "The server ended the TLS handshake (handshake_failure); it may need the app's own client certificate. Automatic passthrough is off, so Flutter Intercept didn't check: add the certificate in the panel (Add client certificate…) if it needs one.",
      );
      expect(ex.needsClientCertificate).toEqual({ host: '127.0.0.1', port: srv.port });
      expect(probes).toBe(0);
      expect(srv.handshakes.filter((h) => h === 'refused').length).toBe(1); // only the request's own connection
      expect(proxy.learnedPassthrough).toEqual([]);
    } finally {
      app.agent.destroy();
      await srv.close();
    }
  });

  it("nginx's 400: the server's own 400, no Connection: close, the off text", async () => {
    const srv = await startMtlsServer({ mode: 'nginx' });
    const app = proxiedAgent(proxy.port);
    try {
      const r = await get(app.agent, srv.port, '/secure');
      expect(r.status).toBe(400);
      expect(r.headers.connection).not.toBe('close');
      const ex = await waitFor(proxy, (e) => failed(e) && !!e.needsClientCertificate);
      expect(ex.error).toBe(offText('HTTP 400 "No required SSL certificate was sent"'));
      expect(proxy.learnedPassthrough).toEqual([]);
    } finally {
      app.agent.destroy();
      await srv.close();
    }
  });

  it('on: needsClientCertificate on a learned request and on one a rule keeps decrypted; not for a rejected configured certificate', async () => {
    proxy.setAutoPassthrough(true);
    const srv = await startMtlsServer({ mode: 'reject' });
    try {
      proxy.setRules([rule('r', `https://127.0.0.1:${srv.port}/*`)]);
      let app = proxiedAgent(proxy.port);
      await get(app.agent, srv.port, '/whoami');
      app.agent.destroy();
      const kept = await waitFor(proxy, (e) => failed(e) && /stays decrypted/.test(e.error ?? ''));
      expect(kept.needsClientCertificate).toEqual({ host: '127.0.0.1', port: srv.port });
      expect(kept.learnedPassthrough).toBeUndefined();
      proxy.setRules([]);
      app = proxiedAgent(proxy.port);
      await get(app.agent, srv.port, '/whoami');
      app.agent.destroy();
      const learned = await waitFor(proxy, (e) => failed(e) && !!e.learnedPassthrough);
      expect(learned.needsClientCertificate).toEqual({ host: '127.0.0.1', port: srv.port });
    } finally {
      await srv.close();
    }
    // a configured certificate the server rejects: says so, no needsClientCertificate
    const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x2a]);
    const bad = net.createServer((s) => s.once('data', () => s.end(alert)));
    bad.listen(0, '127.0.0.1');
    await once(bad, 'listening');
    try {
      proxy.setClientCertificates([{ host: '127.0.0.1', cert: read('othercert.pem'), key: read('other.pem') }]);
      const app = proxiedAgent(proxy.port);
      await get(app.agent, (bad.address() as AddressInfo).port, '/x');
      app.agent.destroy();
      const ex = await waitFor(proxy, (e) => failed(e) && /configured for/.test(e.error ?? ''));
      expect(ex.needsClientCertificate).toBeUndefined();
    } finally {
      bad.close();
    }
  });

  it('turning it off forgets everything but gRPC pins; HTTPS pins are not learned while off, gRPC pins under decrypt-all are', async () => {
    proxy.setAutoPassthrough(true);
    const p = proxy[TEST_INTERNALS]();
    const until = Date.now() + 60_000;
    p.learn.hosts.learn('mtls.example.test', 443, 'client-certificate');
    p.learn.hosts.learn('web.example.test', 443, 'pinned', { until });
    p.pinnedHosts.set('grpc.example.test:443', until);
    const events: LearnedPassthrough[][] = [];
    proxy.on('learnedPassthrough', (l) => events.push(l));
    proxy.setAutoPassthrough(false);
    expect(proxy.learnedPassthrough.map((e) => e.host)).toEqual(['grpc.example.test']);
    await sleep(10);
    expect(events.at(-1)?.map((e) => e.host)).toEqual(['grpc.example.test']);
    // an HTTPS CONNECT the app rejects (an alert): the generic record, no pin, although setHttpPinLearning is on
    expect(proxy.httpPinLearning).toBe(true);
    p.decrypting.set('127.0.0.1:40011', { host: 'web2.example.test', port: 443, http: true });
    p.onTlsError({ failureCause: 'cert-rejected', remoteIpAddress: '127.0.0.1', remotePort: 40011, timingEvents: {} });
    await waitFor(proxy, (e) => e.state === 'error' && /The app probably rejects the proxy's certificate/.test(String(e.error)));
    // a decrypted silent gRPC tunnel the app rejects: pinned as in 0.13
    p.decrypting.set('127.0.0.1:40012', { host: 'grpc2.example.test', port: 443 });
    p.onTlsError({ failureCause: 'cert-rejected', remoteIpAddress: '127.0.0.1', remotePort: 40012, timingEvents: {} });
    expect(proxy.grpcPinnedHosts.sort()).toEqual(['grpc.example.test:443', 'grpc2.example.test:443']);
    expect(proxy.learnedPassthrough.some((e) => e.host === 'web2.example.test')).toBe(false);
  });

  it('gRPC: certificate_required on the relay while off: UNAVAILABLE with the off text, needsClientCertificate, nothing learned', async () => {
    const { key, cert } = await selfSignedCert();
    const server = http2.createSecureServer({ key, cert, requestCert: true, rejectUnauthorized: true, ca: [read('cert.pem')] });
    server.on('error', () => undefined);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const target = `127.0.0.1:${port}`;
    proxy.setGrpcDecryptAll(true);
    try {
      const sock = await silentSocket(proxy.port, target);
      const t = tls.connect({ socket: sock, servername: 'localhost', ALPNProtocols: ['h2'], rejectUnauthorized: false });
      await once(t, 'secureConnect');
      const s = http2.connect(`https://${target}`, { createConnection: () => t });
      s.on('error', () => undefined);
      expect((await grpcCall(s, '/t.Svc/M', ['x'])).grpcStatus).toBe(14);
      const ex = await waitFor(proxy, (e) => e.kind === 'grpc' && e.state === 'error');
      expect(ex.error).toBe(offText('TLS alert certificate_required'));
      expect(ex.needsClientCertificate).toEqual({ host: '127.0.0.1', port });
      expect(ex.learnedPassthrough).toBeUndefined();
      expect(proxy.learnedPassthrough).toEqual([]);
      expect(s.closed).toBe(false); // the app's connection wasn't closed
      s.destroy();
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------- performance (CONTRACTS §20.4)

describe('performance', () => {
  it('a CONNECT costs the same with 1000 learned hosts as with none (O(1) lookup)', async () => {
    const { key, cert } = await selfSignedCert();
    const srv = https.createServer({ key, cert }, (_q, r) => r.end('x'));
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const port = (srv.address() as AddressInfo).port;
    const proxy = await startProxy();
    try {
      /** N CONNECTs answered by mockttp (decrypted; their TLS never starts), timed end to end. */
      const round = async (n: number) => {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${port}`, agent: false });
          c.end();
          const [, raw] = (await once(c, 'connect')) as [http.IncomingMessage, net.Socket];
          raw.destroy();
        }
        return (performance.now() - t0) / n;
      };
      const lookups = (n: number) => {
        const learn = proxy[TEST_INTERNALS]().learn;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) learn.forConnect('api.example.test', 443 + (i & 7), LOOPBACK_CLIENT);
        return ((performance.now() - t0) * 1000) / n;
      };
      await round(50); // warm up
      const emptyMs = Math.min(await round(200), await round(200));
      const emptyUs = lookups(200_000);
      const hosts = proxy[TEST_INTERNALS]().learn.hosts;
      for (let i = 0; i < LEARNED_MAX; i++) hosts.learn(`h${i}.example.test`, 443, i % 2 ? 'client-certificate' : 'pinned', { by: `192.0.2.${i % 8}`, ...(i % 2 ? {} : { until: Date.now() + 60_000 }) });
      expect(hosts.size).toBe(LEARNED_MAX);
      const fullMs = Math.min(await round(200), await round(200));
      const fullUs = lookups(200_000);
      console.log(`CONNECT (decrypted) per request: ${emptyMs.toFixed(3)} ms empty, ${fullMs.toFixed(3)} ms with ${LEARNED_MAX} learned; lookup ${emptyUs.toFixed(3)} µs vs ${fullUs.toFixed(3)} µs`);
      expect(fullMs).toBeLessThan(emptyMs * 1.5 + 0.2);
      expect(fullUs).toBeLessThan(emptyUs * 3 + 0.5);
    } finally {
      await proxy.stop();
      srv.closeAllConnections();
      srv.close();
    }
  }, 60_000);
});
