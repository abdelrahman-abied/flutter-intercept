// Peak RSS growth while 400+ MB flow through the proxy (plain + breakpoint paths).
// Run after `npm run build`: node --expose-gc scripts/memory-large.cjs [sizeMB]
// Prints one JSON line per scenario; exit 1 if any byte count is wrong.
const http = require('http');
const { InterceptProxy } = require(process.env.PROXY_DIST || '../dist');

const MB = 1024 * 1024;
const SIZE = Number(process.argv[2] ?? 420) * MB;
const chunk = Buffer.alloc(MB, 'x');

function upstream() {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/download') {
      let left = Number(u.searchParams.get('size'));
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': left });
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          left -= n;
          if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return res.once('drain', pump);
        }
        res.end();
      };
      pump();
    } else {
      let n = 0;
      req.on('data', (d) => (n += d.length));
      req.on('end', () => res.end(String(n)));
    }
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

function download(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: u.host } }, (res) => {
      let n = 0;
      res.on('data', (d) => (n += d.length));
      res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    }).on('error', reject);
  });
}

function upload(proxyPort, url, size) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: url, headers: { host: u.host, 'content-length': size } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    let left = size;
    const pump = () => {
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        left -= n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

async function measure(name, fn) {
  global.gc?.();
  await new Promise((r) => setTimeout(r, 100));
  global.gc?.();
  const base = process.memoryUsage().rss;
  let peak = base;
  let peakExt = 0;
  const t = setInterval(() => {
    const m = process.memoryUsage();
    peak = Math.max(peak, m.rss);
    peakExt = Math.max(peakExt, m.external + m.arrayBuffers);
  }, 20);
  const t0 = Date.now();
  const result = await fn();
  clearInterval(t);
  peak = Math.max(peak, process.memoryUsage().rss);
  const out = { scenario: name, mb: SIZE / MB, ms: Date.now() - t0, peakRssGrowthMB: +((peak - base) / MB).toFixed(1), peakExternalMB: +(peakExt / MB).toFixed(1), ...result };
  global.gc?.();
  out.retainedAfterGcMB = +((process.memoryUsage().rss - base) / MB).toFixed(1);
  console.log(JSON.stringify(out));
  return out;
}

(async () => {
  const up = await upstream();
  const origin = `http://127.0.0.1:${up.address().port}`;
  const proxy = new InterceptProxy({ port: 0 });
  await proxy.start();
  const bad = [];
  const check = (cond, msg) => cond || bad.push(msg);

  // Reference: the same download without the proxy (client and origin share this process).
  const direct = (url) => new Promise((resolve, reject) => {
    http.get(url, (res) => { let n = 0; res.on('data', (d) => (n += d.length)); res.on('end', () => resolve({ status: res.statusCode, bytes: n })); }).on('error', reject);
  });
  await measure('reference: direct download, no proxy', () => direct(`${origin}/download?size=${SIZE}`));
  let r = await measure('plain download', () => download(proxy.port, `${origin}/download?size=${SIZE}`));
  check(r.bytes === SIZE, 'plain download bytes');
  r = await measure('plain upload', () => upload(proxy.port, `${origin}/sink`, SIZE));
  check(r.text === String(SIZE), 'plain upload bytes');

  proxy.setRules([{ id: 'bp', enabled: true, match: { url: '*/sink' }, action: { kind: 'breakpoint', phase: 'request' } }]);
  r = await measure('request-breakpoint upload (skipped: over limit)', () => upload(proxy.port, `${origin}/sink`, SIZE));
  check(r.text === String(SIZE), 'bp upload bytes');

  proxy.setRules([{ id: 'bp', enabled: true, match: { url: '*/download*' }, action: { kind: 'breakpoint', phase: 'response' } }]);
  r = await measure('response-breakpoint download (refused: over 32 MB)', () => download(proxy.port, `${origin}/download?size=${SIZE}`));
  check(r.status === 502, 'bp download 502');

  proxy.setRules([{ id: 'm', enabled: true, match: { url: '*/sink' }, action: { kind: 'mock', status: 200, body: 'mocked' } }]);
  r = await measure('mock with upload', () => upload(proxy.port, `${origin}/sink`, SIZE).catch((e) => ({ clientError: e.code })));

  const ex = proxy.getExchanges();
  console.log(JSON.stringify({ exchanges: ex.map((e) => [e.state, e.status, e.responseBody?.truncated ?? null, e.requestBody?.truncated ?? null]) }));
  await proxy.stop();
  up.close();
  if (bad.length) {
    console.error('FAILED', bad);
    process.exit(1);
  }
})();
