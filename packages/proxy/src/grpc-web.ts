// gRPC-Web (CONTRACTS §19.1): Flutter Web's GrpcWebClientChannel through the browser. The call stays an HTTP/1.1 flow;
// this module reads its bodies as gRPC: 5-byte prefixed frames, a trailer frame (flag 0x80, HTTP/1-style lines), and
// for the `-text` variants base64 bodies, possibly in several separately padded base64 chunks. Bounded like §16.
import * as zlib from 'zlib';
import { FRAME_PAYLOAD_CAP } from './frames';
import { decodeGrpcMessage, encodeGrpcMessage, frameMessage, type GrpcWireMessage } from './grpc';

export type GrpcWebVariant = 'binary' | 'text';

/** `application/grpc-web`, `+proto` → binary; `application/grpc-web-text`, `+proto` → text; else undefined. */
export function grpcWebVariant(ct: string | string[] | undefined): GrpcWebVariant | undefined {
  const v = (Array.isArray(ct) ? ct[0] : ct ?? '').split(';')[0].trim().toLowerCase();
  if (v === 'application/grpc-web' || v === 'application/grpc-web+proto') return 'binary';
  if (v === 'application/grpc-web-text' || v === 'application/grpc-web-text+proto') return 'text';
  return undefined;
}

/** Trailer bytes kept per call (the trailer frame is a few lines). */
export const GRPC_WEB_TRAILER_KEEP_BYTES = 16 * 1024;
/** Decoded output of an HTTP content-encoding (gzip / br / deflate) read per response, then parsing stops. */
export const GRPC_WEB_DECODE_CAP_BYTES = 64 * 1024 * 1024;

/**
 * Incremental base64 decoder for `-text` bodies: whitespace ignored, decoded in whole 4-character groups, and a group
 * with padding ends a base64 segment (the next chunk may start a new one). Invalid characters → `onBad`.
 */
export class Base64Stream {
  private pending = '';
  private broken = false;
  constructor(
    private readonly out: (b: Buffer) => void,
    private readonly onBad: (why: string) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.broken) return;
    let s = this.pending + chunk.toString('latin1').replace(/\s+/g, '');
    if (/[^A-Za-z0-9+/=_-]/.test(s)) {
      this.broken = true;
      this.onBad('the -text body is not base64');
      return;
    }
    for (;;) {
      const eq = s.indexOf('=');
      if (eq >= 0) {
        const end = Math.floor(eq / 4) * 4 + 4; // the group with the first padding character ends the segment
        if (s.length < end) break;
        this.out(Buffer.from(s.slice(0, end), 'base64'));
        s = s.slice(end).replace(/^=+/, ''); // a second '=' of "==" may sit in the group already consumed
        continue;
      }
      const whole = s.length - (s.length % 4);
      if (whole) this.out(Buffer.from(s.slice(0, whole), 'base64'));
      s = s.slice(whole);
      break;
    }
    if (s.length > 1024) {
      this.broken = true;
      this.onBad('the -text body is not base64');
      return;
    }
    this.pending = s;
  }

  /** At the end: a leftover that isn't a whole group. */
  end(): void {
    if (!this.broken && this.pending.length) this.onBad('the -text body ended inside a base64 group');
  }
}

/**
 * gRPC-Web frame parser: [flags][len BE32][payload]. Flag 0x00 / 0x01 = a message (uncompressed / compressed), 0x80 =
 * the trailer frame. Message payloads are kept up to 64 KB (or 256 KB compressed, for the §16.8 prefix decompression)
 * and counted past that; trailers up to GRPC_WEB_TRAILER_KEEP_BYTES. Anything else stops parsing (`onBad`).
 */
export class GrpcWebFrameParser {
  private header = Buffer.alloc(5);
  private fill = 0;
  private remaining = -1;
  private flags = 0;
  private size = 0;
  private parts: Buffer[] = [];
  private kept = 0;
  private keep = 0;
  private broken = false;

  constructor(
    private readonly o: {
      onMessage: (m: GrpcWireMessage) => void;
      onTrailers: (raw: Buffer) => void;
      onBad: (why: string) => void;
      compressedKeep: number;
    },
  ) {}

  push(chunk: Buffer): void {
    let off = 0;
    while (!this.broken && off < chunk.length) {
      if (this.remaining < 0) {
        const take = Math.min(5 - this.fill, chunk.length - off);
        chunk.copy(this.header, this.fill, off, off + take);
        this.fill += take;
        off += take;
        if (this.fill < 5) return;
        this.fill = 0;
        this.flags = this.header[0];
        if (this.flags !== 0x00 && this.flags !== 0x01 && this.flags !== 0x80) {
          this.broken = true;
          this.o.onBad(`not gRPC-Web framing (flags 0x${this.flags.toString(16).padStart(2, '0')})`);
          return;
        }
        this.size = this.header.readUInt32BE(1);
        this.remaining = this.size;
        this.parts = [];
        this.kept = 0;
        this.keep = this.flags === 0x80 ? Math.min(this.size, GRPC_WEB_TRAILER_KEEP_BYTES) : Math.min(this.size, this.flags === 0x01 ? this.o.compressedKeep : FRAME_PAYLOAD_CAP);
        if (this.remaining === 0) this.emit();
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - off);
      const want = this.keep - this.kept;
      if (want > 0) {
        const part = chunk.subarray(off, off + Math.min(want, take));
        this.parts.push(Buffer.from(part));
        this.kept += part.length;
      }
      off += take;
      this.remaining -= take;
      if (this.remaining === 0) this.emit();
    }
  }

  /** The body ended: inside a frame = truncated. */
  end(): void {
    if (!this.broken && (this.remaining > 0 || this.fill > 0)) this.o.onBad('the body ended inside a gRPC-Web frame');
  }

  private emit(): void {
    const kept = Buffer.concat(this.parts, this.kept);
    this.parts = [];
    this.remaining = -1;
    try {
      if (this.flags === 0x80) this.o.onTrailers(kept);
      else this.o.onMessage({ compressed: this.flags === 0x01, size: this.size, kept, complete: kept.length === this.size });
    } catch {
      /* recording never breaks the flow */
    }
  }
}

/** The trailer frame's `name: value` lines (names lower-cased; repeated names become a list). */
export function parseGrpcWebTrailers(raw: Buffer): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of raw.toString('latin1').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(k)) continue;
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

/** `grpc-status` / `grpc-message` of a header or trailer set. */
export function grpcStatusOf(h: Record<string, string | string[] | undefined>): { code?: number; message?: string } {
  const s = h['grpc-status'];
  const v = (Array.isArray(s) ? s[0] : s)?.trim();
  const code = v && /^\d{1,10}$/.test(v) ? Number(v) : undefined;
  const message = decodeGrpcMessage(h['grpc-message']);
  return { ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) };
}

/**
 * Reads one gRPC-Web call from the bytes the proxy sees: request body, response head, response body (all optional,
 * any chunking). HTTP content-encodings of the response (gzip / br / deflate) are decoded streaming, bounded.
 */
export class GrpcWebRecorder {
  private req?: { feed: (b: Buffer) => void; end: () => void };
  private res?: { feed: (b: Buffer) => void; end: () => void };
  private decoded = 0;

  constructor(
    private readonly variant: GrpcWebVariant,
    private readonly o: {
      onMessage: (dir: 'send' | 'receive', m: GrpcWireMessage) => void;
      onTrailers: (t: Record<string, string | string[]>) => void;
      onProblem: (text: string) => void;
      compressedKeep: number;
    },
  ) {}

  requestData(b: Buffer): void {
    (this.req ??= this.reader('send', this.variant)).feed(b);
  }

  requestEnd(): void {
    this.req?.end();
  }

  /** The response head: its own variant (the content-type it carries) and HTTP content-encoding. */
  responseHead(headers: Record<string, string | string[]>): void {
    const variant = grpcWebVariant(headers['content-type']) ?? this.variant;
    const enc = String(headers['content-encoding'] ?? '').trim().toLowerCase();
    const r = this.reader('receive', variant);
    if (!enc || enc === 'identity') {
      this.res = r;
      return;
    }
    const z = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : undefined;
    if (!z) {
      this.o.onProblem(`The response body is ${enc}-encoded; its gRPC-Web frames were not read.`);
      this.res = { feed: () => undefined, end: () => undefined };
      return;
    }
    z.on('data', (d: Buffer) => {
      this.decoded += d.length;
      if (this.decoded > GRPC_WEB_DECODE_CAP_BYTES) {
        this.o.onProblem(`Only the first ${GRPC_WEB_DECODE_CAP_BYTES / 1024 / 1024} MB of the decoded response were read.`);
        z.removeAllListeners('data');
        z.destroy();
        return;
      }
      r.feed(d);
    });
    z.on('error', () => this.o.onProblem(`The response body could not be ${enc}-decoded.`));
    z.on('end', () => r.end());
    this.res = { feed: (b) => void (z.destroyed || z.write(b)), end: () => void (z.destroyed || z.end()) };
  }

  responseData(b: Buffer): void {
    (this.res ??= this.reader('receive', this.variant)).feed(b);
  }

  responseEnd(): void {
    this.res?.end();
  }

  private reader(dir: 'send' | 'receive', variant: GrpcWebVariant): { feed: (b: Buffer) => void; end: () => void } {
    const bad = (why: string) => this.o.onProblem(`gRPC-Web ${dir === 'send' ? 'request' : 'response'}: ${why}; its remaining frames were not read.`);
    const frames = new GrpcWebFrameParser({
      onMessage: (m) => this.o.onMessage(dir, m),
      onTrailers: (raw) => {
        if (dir === 'receive') this.o.onTrailers(parseGrpcWebTrailers(raw));
      },
      onBad: bad,
      compressedKeep: this.o.compressedKeep,
    });
    if (variant === 'binary') return { feed: (b) => frames.push(b), end: () => frames.end() };
    const b64 = new Base64Stream((b) => frames.push(b), bad);
    return {
      feed: (b) => b64.push(b),
      end: () => {
        b64.end();
        frames.end();
      },
    };
  }
}

/**
 * A gRPC-Web answer body (grpcMock): message frames (uncompressed), then the trailer frame with the status and the
 * custom trailers; base64 for the `-text` variant.
 */
export function grpcWebBody(variant: GrpcWebVariant, messages: Buffer[], code: number, message: string | undefined, trailers: Record<string, string>): Buffer {
  const lines = [`grpc-status: ${code}`, ...(message ? [`grpc-message: ${encodeGrpcMessage(message)}`] : []), ...Object.entries(trailers).map(([k, v]) => `${k.toLowerCase()}: ${v}`)];
  const t = Buffer.from(lines.join('\r\n') + '\r\n', 'latin1');
  const head = Buffer.alloc(5);
  head[0] = 0x80;
  head.writeUInt32BE(t.length, 1);
  const body = Buffer.concat([...messages.map((m) => frameMessage(m)), head, t]);
  return variant === 'text' ? Buffer.from(body.toString('base64'), 'latin1') : body;
}

/** The response content-type for a variant (with +proto like grpc-web clients send). */
export function grpcWebContentType(variant: GrpcWebVariant): string {
  return variant === 'text' ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto';
}

/** Headers a browser needs to read a gRPC-Web answer cross-origin (the status lives in headers for trailers-only). */
export const GRPC_WEB_EXPOSE_HEADERS = 'grpc-status, grpc-message, grpc-status-details-bin';
