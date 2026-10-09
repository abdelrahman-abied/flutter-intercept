// Runs the proxy from a bundle built with EXACTLY the extension's esbuild options + stubs
// (build.mjs --smoke), in plain Node. Proves the minified bundle keeps both mockttp patches
// (listen-host, upstream-pool) and that no stubbed module is hit on our code paths.
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { InterceptProxy, type Exchange } from '@flutter-intercept/proxy';

function fail(msg: string): never {
  console.error(`[bundle-smoke] FAIL ${msg}`);
  process.exit(1);
}

async function viaTunnel(proxyPort: number, target: string, path: string): Promise<number> {
  const c = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
  c.end();
  const sock = await new Promise<net.Socket>((r, j) => c.on('connect', (_res, s) => r(s)).on('error', j));
  const t = tls.connect({ socket: sock, rejectUnauthorized: false });
  return new Promise((resolve, reject) => {
    http
      .get({ path, headers: { host: target, connection: 'keep-alive' }, createConnection: () => t }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

(async () => {
  const t0 = Date.now();
  const proxy = new InterceptProxy({ port: 0, ignoreUpstreamCertErrors: true });
  await proxy.start();
  const startMs = Date.now() - t0;

  const raw = (proxy as any).server.server as net.Server;
  const addr = raw.address() as net.AddressInfo;
  if (addr.address !== '127.0.0.1') fail(`listen-host patch lost: bound to ${addr.address}`);
  if (!(proxy as any).pool?.active) fail('upstream-pool patch lost: getAgent hook inactive');

  // Self-signed HTTPS origin, cert from the proxy's own (bundled) CA generator path.
  const { generateCACertificate } = require('mockttp/dist/util/certificates');
  const { key, cert } = await generateCACertificate({ subject: { commonName: 'localhost' } });
  let upstreamConns = 0;
  const origin = https.createServer({ key, cert }, (_q, r) => r.end('ok'));
  origin.on('connection', () => upstreamConns++);
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  const target = `127.0.0.1:${(origin.address() as net.AddressInfo).port}`;

  for (let i = 0; i < 5; i++) {
    const s = await viaTunnel(proxy.port, target, `/n${i}`);
    if (s !== 200) fail(`HTTPS pass-through status ${s}`);
  }
  if (upstreamConns !== 1) fail(`expected 1 pooled upstream connection for 5 tunnels, got ${upstreamConns}`);

  // Mock and upstream failure (502) through the bundle.
  proxy.setRules([{ id: 'm', enabled: true, match: { url: '*/mocked' }, action: { kind: 'mock', status: 201, body: 'M' } }]);
  const get = (url: string) =>
    new Promise<number>((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port: proxy.port, path: url, headers: { host: new URL(url).host } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        })
        .on('error', reject),
    );
  if ((await get('http://127.0.0.1:1/mocked')) !== 201) fail('mock');
  if ((await get('http://127.0.0.1:1/dead')) !== 502) fail('upstream failure should be 502');
  await new Promise((r) => setTimeout(r, 50));
  const states = proxy.getExchanges().map((e: Exchange) => e.state);
  if (states.filter((s) => s === 'completed').length !== 5 || !states.includes('mocked') || !states.includes('error')) {
    fail(`unexpected states ${JSON.stringify(states)}`);
  }

  await proxy.stop();
  origin.close();
  console.log(`[bundle-smoke] ok: bound ${addr.address}, pool active, 5 tunnels -> ${upstreamConns} upstream conn, mock + 502 ok, start ${startMs} ms`);
})().catch((e) => fail(String(e?.stack ?? e)));
