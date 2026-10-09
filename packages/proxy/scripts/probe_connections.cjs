// Counts upstream vs downstream connections for N dart:io requests through the proxy (HTTP and HTTPS).
// Run after `npm run build`: node scripts/probe_connections.cjs
const https = require('https'); const http = require('http'); const { execFile } = require('child_process'); const path=require('path');
const { generateCACertificate } = require('mockttp'); const { InterceptProxy } = require('../dist');
const run = (args) => new Promise((res, rej) => execFile('dart', ['run', path.join(__dirname,'dart_bench.dart'), ...args], (e, out) => { e ? rej(e) : res(out.trim().split('\n').pop()); }));
(async () => {
  const ca = await generateCACertificate({ subject: { commonName: 'localhost' } });
  const p = new InterceptProxy({ port: 0, ignoreUpstreamCertErrors: true }); await p.start();
  let downstream = 0; p['server'].server.on('connection', () => downstream++);
  for (const kind of ['http', 'https']) {
    let conns = 0, reqs = 0, hdr;
    const h = (q, r) => { reqs++; hdr = q.headers; r.end('ok'); };
    const s = kind === 'https' ? https.createServer({ key: ca.key, cert: ca.cert }, h) : http.createServer(h);
    s.on('connection', () => conns++);
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    downstream = 0;
    const out = await run([`${kind}://127.0.0.1:${s.address().port}/`, '30', String(p.port)]);
    console.log(kind, { reqs, upstreamConnections: conns, downstreamConnections: downstream, lastHeaders: hdr, out });
    s.close();
  }
  await p.stop();
})();
