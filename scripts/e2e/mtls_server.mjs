#!/usr/bin/env node
// CONTRACTS §20 e2e: an HTTPS server that requires a client certificate (mutual TLS), like the owner's Dio app's API.
//
//   node scripts/e2e/mtls_server.mjs [--port 48600] [--dir <out dir>] [--tls12]
//
// Generates (with the system `openssl`, macOS) a throwaway CA, a `localhost` server leaf, a client certificate
// (`client.pem` + `client.key`, and `client.p12` with passphrase `demo-pass`), all valid 30 days, into --dir (default:
// a new temp dir), then serves `GET /whoami` → `{"ok":true,"client":"<client CN>"}` only to clients presenting a
// certificate from that CA. Without one: TLS 1.3 → alert certificate_required; --tls12 → handshake failure.
// `GET /nginx` on a second port (--port + 1, `requestCert` optional) answers 400 "No required SSL certificate was sent"
// to clients without a certificate, as nginx does. Prints one JSON line: {"port", "nginxPort", "dir", "files"}.
// The demo app reads the client certificate and the CA through dart-defines (samples/demo_app/lib/mtls_demo.dart).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const port = Number(opt('--port', '48600'));
const dir = opt('--dir', undefined) ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fi-mtls-'));
const tls12 = args.includes('--tls12');
fs.mkdirSync(dir, { recursive: true });

const ssl = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
if (!fs.existsSync(path.join(dir, 'client.p12'))) {
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=Flutter Intercept e2e mTLS CA');
  fs.writeFileSync(path.join(dir, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
  ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '30', '-extfile', 'server.ext');
  fs.writeFileSync(path.join(dir, 'client.ext'), 'extendedKeyUsage=clientAuth\n');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=demo-app');
  ssl('x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '30', '-extfile', 'client.ext');
  ssl('pkcs12', '-export', '-in', 'client.pem', '-inkey', 'client.key', '-out', 'client.p12', '-passout', 'pass:demo-pass',
    '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'sha256');
}
const read = (f) => fs.readFileSync(path.join(dir, f));
const base = { key: read('server.key'), cert: read('server.pem'), ca: read('ca.pem'), ...(tls12 ? { maxVersion: 'TLSv1.2' } : {}) };

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const clientCn = (req) => req.socket.getPeerCertificate?.()?.subject?.CN;

const strict = https.createServer({ ...base, requestCert: true, rejectUnauthorized: true }, (req, res) => {
  if (req.url?.startsWith('/whoami')) json(res, 200, { ok: true, client: clientCn(req) });
  else json(res, 404, { ok: false });
});
const nginx = https.createServer({ ...base, requestCert: true, rejectUnauthorized: false }, (req, res) => {
  if (process.env.FI_MTLS_LOG) console.error(`nginx ${req.url} authorized=${req.socket.authorized} reused=${req.socket.isSessionReused()} cn=${clientCn(req) ?? '-'} peer=${req.socket.remotePort}`);
  if (!req.socket.authorized) {
    res.writeHead(400, { 'content-type': 'text/html' });
    res.end('<html><head><title>400 No required SSL certificate was sent</title></head><body><center><h1>400 Bad Request</h1></center><center>No required SSL certificate was sent</center></body></html>');
    return;
  }
  json(res, 200, { ok: true, client: clientCn(req) });
});
strict.listen(port, '127.0.0.1', () => {
  nginx.listen(port + 1, '127.0.0.1', () => {
    console.log(JSON.stringify({ port, nginxPort: port + 1, dir, files: { ca: 'ca.pem', p12: 'client.p12', passphrase: 'demo-pass', cert: 'client.pem', key: 'client.key' } }));
  });
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
