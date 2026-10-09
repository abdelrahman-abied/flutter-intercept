import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { generateCACertificate } from 'mockttp';
import { InterceptProxy, type Exchange, type ExchangeState, type InterceptProxyOptions } from '../src';

export interface Upstream {
  httpUrl: string;
  httpsUrl: string;
  hits: string[]; // "METHOD path" per request received
  /** TCP connections accepted by the upstream servers. */
  connections: { http: number; https: number };
  close(): Promise<void>;
}

const handler: (hits: string[]) => http.RequestListener = (hits) => async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  const u = new URL(req.url ?? '/', 'http://x');
  hits.push(`${req.method} ${u.pathname}`);
  const q = (k: string) => u.searchParams.get(k);
  switch (u.pathname) {
    case '/echo': {
      const out = JSON.stringify({ method: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end(out);
      return;
    }
    case '/count':
      res.writeHead(200, { 'content-type': 'text/plain' }).end(String(Buffer.concat(chunks).length));
      return;
    case '/json':
      res.writeHead(200, { 'content-type': 'application/json', 'x-up': '1' }).end('{"hello":"world"}');
      return;
    case '/gzip': {
      const z = zlib.gzipSync(Buffer.from('hello gzip world', 'utf8'));
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': z.length }).end(z);
      return;
    }
    case '/br': {
      const z = zlib.brotliCompressSync(Buffer.from('hello br world', 'utf8'));
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' }).end(z); // chunked
      return;
    }
    case '/binary':
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80]));
      return;
    case '/big': {
      const size = Number(q('size') ?? 1024);
      res.writeHead(200, { 'content-type': 'text/plain' }).end(Buffer.alloc(size, 'a'));
      return;
    }
    case '/stream': {
      // SSE-style: first event now, second after `ms`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), Number(q('ms') ?? 500));
      return;
    }
    case '/slow':
      setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('slow done'), Number(q('ms') ?? 100));
      return;
    default:
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
};

let selfSigned: Promise<{ key: string; cert: string }> | undefined;
export function selfSignedCert() {
  selfSigned ??= generateCACertificate({ subject: { commonName: 'localhost' } });
  return selfSigned;
}

export async function startUpstream(host = '127.0.0.1'): Promise<Upstream> {
  const hits: string[] = [];
  const h = http.createServer(handler(hits));
  const { key, cert } = await selfSignedCert();
  const s = https.createServer({ key, cert }, handler(hits));
  const connections = { http: 0, https: 0 };
  h.on('connection', () => connections.http++);
  s.on('connection', () => connections.https++);
  h.listen(0, host);
  s.listen(0, host);
  await Promise.all([once(h, 'listening'), once(s, 'listening')]);
  return {
    httpUrl: `http://${host}:${(h.address() as AddressInfo).port}`,
    httpsUrl: `https://${host}:${(s.address() as AddressInfo).port}`,
    hits,
    connections,
    async close() {
      h.closeAllConnections();
      s.closeAllConnections();
      await Promise.all([new Promise((r) => h.close(r)), new Promise((r) => s.close(r))]);
    },
  };
}

export async function startProxy(opts: Partial<InterceptProxyOptions> = {}) {
  const proxy = new InterceptProxy({ port: 0, ignoreUpstreamCertErrors: true, ...opts });
  await proxy.start();
  return proxy;
}

export interface ClientResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

export interface ClientOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

/** A Node HTTP/1.1 client going through the proxy: absolute-URI for http, CONNECT for https. */
/** Like viaProxy but resolves with the time (ms) the first body chunk arrived, plus the full body. */
export async function firstChunkViaProxy(proxyPort: number, url: string): Promise<{ firstChunkMs: number; totalMs: number; text: string }> {
  const t0 = Date.now();
  let first = -1;
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: u.host }, agent: false });
    req.on('error', reject);
    req.on('response', (res) => {
      let text = '';
      res.on('data', (c: Buffer) => {
        if (first < 0) first = Date.now() - t0;
        text += c.toString();
      });
      res.on('end', () => resolve({ firstChunkMs: first, totalMs: Date.now() - t0, text }));
    });
    req.end();
  });
}

export async function viaProxy(proxyPort: number, url: string, o: ClientOptions = {}): Promise<ClientResponse> {
  const u = new URL(url);
  const method = o.method ?? 'GET';
  const headers: Record<string, string | number> = { host: u.host, ...(o.headers ?? {}) };
  if (o.body !== undefined) headers['content-length'] = Buffer.byteLength(o.body);

  let req: http.ClientRequest;
  if (u.protocol === 'http:') {
    req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers, agent: false });
  } else {
    const connect = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${u.hostname}:${u.port || 443}`,
      agent: false,
    });
    connect.end();
    const [res, socket] = (await once(connect, 'connect')) as [http.IncomingMessage, import('net').Socket];
    if (res.statusCode !== 200) throw new Error(`CONNECT failed: ${res.statusCode}`);
    const tlsSocket = tls.connect({ socket, servername: 'localhost', rejectUnauthorized: false });
    req = http.request({ method, path: u.pathname + u.search, headers, createConnection: () => tlsSocket });
  }

  return new Promise<ClientResponse>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    if (o.timeoutMs) {
      timer = setTimeout(() => {
        req.destroy(new Error('client timeout'));
      }, o.timeoutMs);
    }
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.end(o.body);
  });
}

/** Resolve with the first 'exchange' snapshot that satisfies `pred`. */
export function nextExchange(
  proxy: InterceptProxy,
  pred: (e: Exchange) => boolean,
  timeoutMs = 10_000,
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      proxy.off('exchange', on);
      reject(new Error('timed out waiting for exchange'));
    }, timeoutMs);
    const on = (e: Exchange) => {
      if (pred(e)) {
        clearTimeout(t);
        proxy.off('exchange', on);
        resolve(e);
      }
    };
    proxy.on('exchange', on);
  });
}

export const inState = (state: ExchangeState, urlPart?: string) => (e: Exchange) =>
  e.state === state && (urlPart === undefined || e.url.includes(urlPart));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plain pass-through exchanges are completed from mockttp's async 'response' event, which can
 * land a few ms after the client has the whole body. Wait until nothing is 'pending'.
 */
export async function settled(proxy: InterceptProxy, timeoutMs = 3000): Promise<Exchange[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const all = proxy.getExchanges();
    if (!all.some((e) => e.state === 'pending') || Date.now() > until) return all;
    await sleep(5);
  }
}
