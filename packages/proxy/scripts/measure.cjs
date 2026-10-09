// Measurements for docs/spikes/proxy.md. Run after `npm run build`:
//   node --expose-gc scripts/measure.cjs
const http = require('http');
const https = require('https');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateCACertificate } = require('mockttp');
const { InterceptProxy } = require('../dist');

const gc = () => { global.gc?.(); global.gc?.(); };
const mb = (b) => (b / 1024 / 1024).toFixed(1);

async function upstreams() {
  const payload = Buffer.alloc(100 * 1024, 'x');
  const h = (req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.startsWith('/big')) res.writeHead(200, { 'content-type': 'text/plain' }).end(payload);
      else res.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":"world"}');
    });
  };
  const ca = await generateCACertificate({ subject: { commonName: 'localhost' } });
  const a = http.createServer({ keepAlive: true }, h).listen(0, '127.0.0.1');
  const b = https.createServer({ key: ca.key, cert: ca.cert }, h).listen(0, '127.0.0.1');
  await Promise.all([new Promise((r) => a.on('listening', r)), new Promise((r) => b.on('listening', r))]);
  return { http: `http://127.0.0.1:${a.address().port}`, https: `https://127.0.0.1:${b.address().port}`, close: () => { a.closeAllConnections(); b.closeAllConnections(); a.close(); b.close(); } };
}

function nodeGet(url, proxyPort, agent) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = proxyPort
      ? { host: '127.0.0.1', port: proxyPort, path: url, headers: { host: u.host }, agent }
      : { host: u.hostname, port: u.port, path: u.pathname, agent };
    http.get(opts, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
}

function stats(arr) {
  const s = [...arr].sort((x, y) => x - y);
  const q = (p) => s[Math.round((s.length - 1) * p)];
  return { mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(3), p50: +q(0.5).toFixed(3), p90: +q(0.9).toFixed(3), p99: +q(0.99).toFixed(3) };
}

async function nodeLatency(up, proxy, n) {
  const out = {};
  for (const [label, port] of [['direct', 0], ['proxy', proxy.port]]) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await nodeGet(`${up.http}/json`, port, agent);
    const t = [];
    for (let i = 0; i < n; i++) {
      const s = process.hrtime.bigint();
      await nodeGet(`${up.http}/json`, port, agent);
      t.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    agent.destroy();
    out[label] = stats(t);
  }
  return out;
}

async function dartLatency(up, proxy, n) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-bench-'));
  const exe = path.join(tmp, 'bench');
  execFileSync('dart', ['compile', 'exe', path.join(__dirname, 'dart_bench.dart'), '-o', exe], { stdio: 'pipe' });
  // async: the upstream lives in this process, a sync exec would deadlock it
  const run = async (url, port) => {
    const out = (await execFileP(exe, [url, String(n), ...(port ? [String(port)] : [])])).stdout.trim().split('\n');
    const first = Number(out[0].split(' ')[1]);
    const s = JSON.parse(out[1]);
    return { first_ms: first, mean: +s.mean.toFixed(3), p50: s.p50, p90: s.p90, p99: s.p99 };
  };
  const res = {
    http_direct: await run(`${up.http}/json`), http_proxy: await run(`${up.http}/json`, proxy.port),
    https_direct: await run(`${up.https}/json`), https_proxy: await run(`${up.https}/json`, proxy.port),
  };
  fs.rmSync(tmp, { recursive: true, force: true });
  return res;
}

async function memory(up, maxExchanges, total) {
  const proxy = new InterceptProxy({ port: 0, maxExchanges, ignoreUpstreamCertErrors: true });
  await proxy.start();
  gc();
  const before = process.memoryUsage();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  for (let i = 0; i < total; i += 8) {
    await Promise.all(Array.from({ length: 8 }, () => nodeGet(`${up.http}/big`, proxy.port, agent)));
  }
  agent.destroy();
  gc();
  const after = process.memoryUsage();
  const stored = proxy.getExchanges().length;
  await proxy.stop();
  gc();
  const stopped = process.memoryUsage();
  return {
    maxExchanges, requests: total, stored, bodyKBEach: 100,
    heapDeltaMB: mb(after.heapUsed - before.heapUsed),
    rssDeltaMB: mb(after.rss - before.rss),
    heapAfterStopDeltaMB: mb(stopped.heapUsed - before.heapUsed),
  };
}

(async () => {
  const up = await upstreams();
  const t0 = Date.now();
  const proxy = new InterceptProxy({ port: 0, ignoreUpstreamCertErrors: true });
  await proxy.start();
  console.log('start_ms (incl. in-memory CA generation)', Date.now() - t0);
  const n = Number(process.env.N ?? 500);
  console.log('node keep-alive latency (ms)', JSON.stringify(await nodeLatency(up, proxy, n)));
  console.log('dart keep-alive latency (ms)', JSON.stringify(await dartLatency(up, proxy, n), null, 1));
  await proxy.stop();
  for (const m of [100, 1000]) console.log('memory', JSON.stringify(await memory(up, m, 2000)));
  up.close();
})().catch((e) => { console.error(e); process.exit(1); });
