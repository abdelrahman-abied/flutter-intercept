// node:http2 gRPC test client / server (no @grpc/grpc-js): framing is [flag][len BE32][payload], status in trailers.
import { once } from 'events';
import * as http2 from 'http2';
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';

const C = http2.constants;

export const frame = (payload: Buffer | string, compressed = false): Buffer => {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const h = Buffer.alloc(5);
  h[0] = compressed ? 1 : 0;
  h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
};

/** Incremental message reader. */
export class Messages {
  private buf = Buffer.alloc(0);
  readonly list: { compressed: boolean; payload: Buffer }[] = [];
  constructor(private readonly onMessage?: (m: { compressed: boolean; payload: Buffer }) => void) {}
  push(c: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, c]) : c;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) return;
      const m = { compressed: this.buf[0] === 1, payload: Buffer.from(this.buf.subarray(5, 5 + len)) };
      this.buf = this.buf.subarray(5 + len);
      this.list.push(m);
      this.onMessage?.(m);
    }
  }
}

export interface GrpcServer {
  port: number;
  /** What the server saw: `call <path>`, `cancelled <path>`, `timeout <value>`, `meta <x-req-meta>`. */
  events: string[];
  /** TCP connections accepted. */
  connections: number;
  /** Request headers of each call, in order. */
  seen: http2.IncomingHttpHeaders[];
  close(): Promise<void>;
}

/** Echo service `t.Echo`: Unary, Fail, ServerStream, ClientStream, Bidi, Slow, Gzip, Reset. */
export async function startGrpcServer(opts: { tls?: { key: string; cert: string }; host?: string } = {}): Promise<GrpcServer> {
  const events: string[] = [];
  const seen: http2.IncomingHttpHeaders[] = [];
  const sockets = new Set<net.Socket>();
  const server = opts.tls ? http2.createSecureServer({ key: opts.tls.key, cert: opts.tls.cert }) : http2.createServer();
  let connections = 0;
  server.on('connection', (s: net.Socket) => {
    connections++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('stream', (stream, headers) => {
    const path = String(headers[':path']);
    events.push(`call ${path}`);
    seen.push(headers);
    if (headers['grpc-timeout']) events.push(`timeout ${headers['grpc-timeout']}`);
    if (headers['x-req-meta']) events.push(`meta ${headers['x-req-meta']}`);
    stream.on('error', () => undefined);
    let done = false;
    stream.once('close', () => {
      if (!done) events.push(`cancelled ${path}`);
    });
    const finish = (trailers: http2.OutgoingHttpHeaders = {}) => {
      done = true;
      stream.end();
      stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', ...trailers }));
    };
    const head = (extra: http2.OutgoingHttpHeaders = {}) => stream.respond({ ':status': 200, 'content-type': 'application/grpc', ...extra }, { waitForTrailers: true });
    const enc = headers['grpc-encoding'];
    const decode = (m: { compressed: boolean; payload: Buffer }) => (m.compressed && enc === 'gzip' ? zlib.gunzipSync(m.payload) : m.payload);
    const name = path.split('/').pop();
    if (name === 'ResetNow') {
      // Resets as soon as the call starts (before reading anything).
      done = true;
      stream.close(C.NGHTTP2_INTERNAL_ERROR);
      return;
    }
    if (name === 'Fail') {
      done = true;
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '14', 'grpc-message': 'upstream%20says%20no' }, { endStream: true });
      stream.resume();
      return;
    }
    if (name === 'Bidi') {
      head();
      const r = new Messages((m) => stream.write(frame(Buffer.concat([Buffer.from('bidi:'), decode(m)]))));
      stream.on('data', (c: Buffer) => r.push(c));
      stream.on('end', () => finish());
      return;
    }
    const r = new Messages();
    stream.on('data', (c: Buffer) => r.push(c));
    stream.on('end', () => {
      const msgs = r.list.map(decode);
      if (name === 'Unary') {
        head({ 'x-custom-header': 'head-v' });
        stream.write(frame(Buffer.concat([Buffer.from('echo:'), msgs[0] ?? Buffer.alloc(0)])));
        done = true;
        stream.end();
        stream.once('wantTrailers', () =>
          stream.sendTrailers({ 'grpc-status': '0', 'x-custom-trailer': 'trail-v', 'x-bin-bin': Buffer.from([1, 2, 3]).toString('base64') }),
        );
      } else if (name === 'ServerStream') {
        const n = Number(msgs[0]?.toString() || 5);
        head();
        let i = 0;
        const t = setInterval(() => {
          if (stream.closed || stream.destroyed) return clearInterval(t);
          stream.write(frame(`msg${i}`));
          if (++i >= n) {
            clearInterval(t);
            finish({ 'x-stream-trailer': 'done' });
          }
        }, 50);
      } else if (name === 'ClientStream') {
        head();
        stream.write(frame(msgs.map((m) => m.toString()).join('+')));
        finish();
      } else if (name === 'Slow') {
        const t = setTimeout(() => {
          head();
          stream.write(frame('late'));
          finish();
        }, 3000);
        stream.once('close', () => clearTimeout(t));
      } else if (name === 'Gzip') {
        head({ 'grpc-encoding': 'gzip' });
        stream.write(frame(zlib.gzipSync(Buffer.concat([Buffer.from('gz:'), msgs[0] ?? Buffer.alloc(0)])), true));
        finish();
      } else if (name === 'Reset') {
        head();
        stream.write(frame('one'), () => {
          done = true;
          stream.close(C.NGHTTP2_ENHANCE_YOUR_CALM);
        });
      } else {
        done = true;
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' }, { endStream: true });
      }
    });
  });
  server.listen(0, opts.host ?? '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    events,
    seen,
    get connections() {
      return connections;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** A socket to the proxy that already sent a silent CONNECT (no reply is read). */
export async function silentSocket(proxyPort: number, target: string, o: { headers?: Record<string, string>; host?: string } = {}): Promise<net.Socket> {
  const s = net.connect(proxyPort, o.host ?? '127.0.0.1');
  await once(s, 'connect');
  const extra = Object.entries(o.headers ?? {})
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nFlutter-Intercept-Tunnel: silent\r\n${extra}\r\n`);
  return s;
}

/** An h2c gRPC client session through a silent tunnel. */
export async function h2cSession(proxyPort: number, target: string, o: { headers?: Record<string, string>; host?: string } = {}): Promise<http2.ClientHttp2Session> {
  const sock = await silentSocket(proxyPort, target, o);
  const s = http2.connect(`http://${target}`, { createConnection: () => sock });
  s.on('error', () => undefined);
  return s;
}

/** A TLS gRPC client session through a silent tunnel (ALPN like grpc-dart). `ca` given = verify against it. */
export async function tlsSession(
  proxyPort: number,
  target: string,
  o: { ca?: string; servername?: string; headers?: Record<string, string> } = {},
): Promise<{ session: http2.ClientHttp2Session; socket: tls.TLSSocket }> {
  const sock = await silentSocket(proxyPort, target, o);
  const t = tls.connect({ socket: sock, servername: o.servername ?? 'localhost', ALPNProtocols: ['grpc-exp', 'h2'], ...(o.ca ? { ca: o.ca } : { rejectUnauthorized: false }) });
  await once(t, 'secureConnect');
  const s = http2.connect(`https://${target}`, { createConnection: () => t });
  s.on('error', () => undefined);
  return { session: s, socket: t };
}

export interface CallResult {
  status?: number;
  headers?: http2.IncomingHttpHeaders;
  trailersOnly?: boolean;
  messages: Buffer[];
  compressed: boolean[];
  trailers?: http2.IncomingHttpHeaders;
  grpcStatus?: number;
  grpcMessage?: string;
  rstCode?: number;
  /** ms since the call started, per message. */
  at: number[];
}

export interface CallOptions {
  metadata?: Record<string, string>;
  /** Sets grpc-timeout and cancels (RST_STREAM CANCEL) when it passes, like a client deadline. */
  deadlineMs?: number;
  /** Cancel after this many response messages. */
  cancelAfter?: number;
  gzip?: boolean;
  /** Keep the request open (bidi without half-close); the call ends when the server ends it. */
  keepOpen?: boolean;
  /** ms between request messages. */
  gapMs?: number;
}

/** One call: write `messages`, collect the response. Never rejects. */
export function grpcCall(session: http2.ClientHttp2Session, path: string, messages: (Buffer | string)[], o: CallOptions = {}): Promise<CallResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out: CallResult = { messages: [], compressed: [], at: [] };
    const req = session.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
      ...(o.gzip ? { 'grpc-encoding': 'gzip', 'grpc-accept-encoding': 'gzip' } : {}),
      ...(o.deadlineMs !== undefined ? { 'grpc-timeout': `${o.deadlineMs}m` } : {}),
      ...(o.metadata ?? {}),
    });
    req.on('error', () => undefined);
    let deadline: NodeJS.Timeout | undefined;
    if (o.deadlineMs !== undefined) deadline = setTimeout(() => req.close(C.NGHTTP2_CANCEL), o.deadlineMs);
    const reader = new Messages((m) => {
      out.messages.push(m.compressed ? zlib.gunzipSync(m.payload) : m.payload);
      out.compressed.push(m.compressed);
      out.at.push(Date.now() - t0);
      if (o.cancelAfter !== undefined && out.messages.length >= o.cancelAfter) req.close(C.NGHTTP2_CANCEL);
    });
    req.on('response', (h, flags) => {
      out.status = Number(h[':status']);
      out.headers = h;
      if (flags & C.NGHTTP2_FLAG_END_STREAM) {
        out.trailersOnly = true;
        if (h['grpc-status'] !== undefined) out.grpcStatus = Number(h['grpc-status']);
        if (h['grpc-message'] !== undefined) out.grpcMessage = String(h['grpc-message']);
      }
    });
    req.on('data', (c: Buffer) => reader.push(c));
    req.on('trailers', (t) => {
      out.trailers = t;
      if (t['grpc-status'] !== undefined) out.grpcStatus = Number(t['grpc-status']);
      if (t['grpc-message'] !== undefined) out.grpcMessage = String(t['grpc-message']);
    });
    req.on('close', () => {
      clearTimeout(deadline);
      out.rstCode = req.rstCode;
      resolve(out);
    });
    const msgs = messages.map((m) => (Buffer.isBuffer(m) ? m : Buffer.from(m, 'utf8')));
    const write = (m: Buffer) => req.write(o.gzip ? frame(zlib.gzipSync(m), true) : frame(m));
    if (!o.gapMs) {
      for (const m of msgs) write(m);
      if (!o.keepOpen) req.end();
      return;
    }
    let i = 0;
    const next = () => {
      if (req.closed) return;
      if (i >= msgs.length) {
        if (!o.keepOpen) req.end();
        return;
      }
      write(msgs[i++]);
      setTimeout(next, o.gapMs);
    };
    next();
  });
}
