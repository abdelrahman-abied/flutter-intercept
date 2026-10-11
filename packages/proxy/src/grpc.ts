// gRPC over HTTP/2 (CONTRACTS §16.2): wire helpers shared by the relay, the mocks and the silent-tunnel takeover.
// Dependency-free except node's zlib / stream; bounded everywhere (frames keep ≤ 64 KB, decompression is capped).
import * as zlib from 'zlib';
import { Transform, type TransformCallback } from 'stream';
import type { Frame } from './types';
import { FRAME_PAYLOAD_CAP } from './frames';

/** The marker header of a silent CONNECT (CONTRACTS §16.1), and the entry's connect timeout header. */
export const SILENT_TUNNEL_HEADER = 'flutter-intercept-tunnel';
export const CONNECT_TIMEOUT_HEADER = 'flutter-intercept-connect-timeout';
/** CONTRACTS §16.8: the event a breaker report emits on InterceptProxy, at most once per authority per window. */
export const GRPC_BREAKER_EVENT = 'grpcBreaker';
export const GRPC_BREAKER_WINDOW_MS = 60_000;
export interface GrpcBreakerEvent {
  /** `host:port` (IPv6 in brackets, host lower-cased) the app connected to directly for 30 s. */
  authority: string;
  /** The report came through the LAN listener (a physical device). */
  viaLan: boolean;
}
/** Upstream connect timeout for gRPC sessions and silent passthrough tunnels: default and maximum (ms). */
export const GRPC_CONNECT_TIMEOUT_MS = 30_000;
export const GRPC_CONNECT_TIMEOUT_MAX_MS = 60_000;
/** A silent tunnel whose first payload byte never comes is closed after this long. */
export const SILENT_FIRST_BYTE_MS = 30_000;
/**
 * CONTRACTS §16.8 (REVIEW-10 #3): of a compressed message only this prefix is kept, and only it is decompressed
 * (streaming, stopping after FRAME_PAYLOAD_CAP + 1 bytes of output), never the whole message.
 */
export const GRPC_COMPRESSED_KEEP_BYTES = 256 * 1024;
/** Idle upstream HTTP/2 sessions are closed after this long (CONTRACTS §16.2, like the HTTP pool). */
export const GRPC_SESSION_IDLE_MS = 30_000;

/** gRPC status code names (for messages and labels). */
export const GRPC_CODE_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;

/** `application/grpc`, `application/grpc+proto`, `application/grpc;…` — not `application/grpc-web…`. */
export function isGrpcContentType(ct: string | string[] | undefined): boolean {
  const v = (Array.isArray(ct) ? ct[0] : ct ?? '').trim().toLowerCase();
  return /^application\/grpc(?:\+[^;\s]*)?\s*(?:;.*)?$/.test(v);
}

/** `/pkg.Service/Method` → service `pkg.Service`, method `Method` (anything else: the path as the service). */
export function parseGrpcPath(path: string): { service: string; method: string } {
  const p = String(path ?? '').split('?')[0];
  const m = /^\/([^/]+)\/([^/]+)$/.exec(p);
  if (m) return { service: safeDecode(m[1]), method: safeDecode(m[2]) };
  return { service: p.replace(/^\//, ''), method: '' };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const TIMEOUT_UNIT_MS: Record<string, number> = { H: 3_600_000, M: 60_000, S: 1000, m: 1, u: 0.001, n: 0.000001 };

/** `grpc-timeout` (`100m`, `5S`, …; at most 8 digits) → ms, or undefined when absent / invalid. */
export function parseGrpcTimeout(v: string | string[] | undefined): number | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  const m = s ? /^(\d{1,8})([HMSmun])$/.exec(s) : null;
  if (!m) return undefined;
  return Math.round(Number(m[1]) * TIMEOUT_UNIT_MS[m[2]]);
}

/** `Flutter-Intercept-Connect-Timeout: <ms>` → ms within (0, max]; default otherwise. */
export function parseConnectTimeout(v: string | string[] | undefined): number {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  if (!s || !/^\d{1,9}$/.test(s)) return GRPC_CONNECT_TIMEOUT_MS;
  const n = Number(s);
  if (n <= 0) return GRPC_CONNECT_TIMEOUT_MS;
  return Math.min(n, GRPC_CONNECT_TIMEOUT_MAX_MS);
}

/** gRPC's `grpc-message` encoding: UTF-8, every byte outside 0x20–0x7E (and `%`) as `%XX`. */
export function encodeGrpcMessage(text: string): string {
  let out = '';
  for (const b of Buffer.from(String(text ?? ''), 'utf8')) {
    out += b >= 0x20 && b <= 0x7e && b !== 0x25 ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Percent-decode a `grpc-message` (invalid escapes are kept as they are). */
export function decodeGrpcMessage(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25 && i + 2 < s.length && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c < 0x80) bytes.push(c);
    else for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Parse `grpc-status` (a non-negative integer) or undefined. */
export function parseGrpcStatus(v: string | string[] | undefined): number | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s && /^\d{1,10}$/.test(s) ? Number(s) : undefined;
}

/** `grpc-encoding` when it is not identity (lower-cased). */
export function grpcEncodingOf(v: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase();
  return s && s !== 'identity' ? s : undefined;
}

/** One length-prefixed message: [compressed flag][length BE32][payload]. */
export function frameMessage(payload: Buffer, compressed = false): Buffer {
  const h = Buffer.alloc(5);
  h[0] = compressed ? 1 : 0;
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

/** A parsed message: the bytes kept (a prefix unless `complete`), its wire size, the compressed flag. */
export interface GrpcWireMessage {
  compressed: boolean;
  /** Payload bytes on the wire. */
  size: number;
  /** Kept bytes: the whole payload when `complete`, else a prefix. */
  kept: Buffer;
  complete: boolean;
}

/**
 * Incremental parser of a gRPC message stream. Never holds more than one message's kept prefix (≤ 64 KB, or
 * GRPC_COMPRESSED_KEEP_BYTES for a compressed message, which must be whole to decompress); the rest of a large
 * message is only counted. Malformed input (a bad flag byte) stops parsing for the rest of the stream.
 */
export class GrpcMessageParser {
  private header = Buffer.alloc(5);
  private headerFill = 0;
  private remaining = -1;
  private size = 0;
  private compressed = false;
  private parts: Buffer[] = [];
  private keptBytes = 0;
  private keepLimit = 0;
  private broken = false;

  constructor(private readonly onMessage: (m: GrpcWireMessage) => void) {}

  push(chunk: Buffer): void {
    if (this.broken || !chunk?.length) return;
    let off = 0;
    while (off < chunk.length) {
      if (this.remaining < 0) {
        const take = Math.min(5 - this.headerFill, chunk.length - off);
        chunk.copy(this.header, this.headerFill, off, off + take);
        this.headerFill += take;
        off += take;
        if (this.headerFill < 5) return;
        const flag = this.header[0];
        if (flag !== 0 && flag !== 1) {
          this.broken = true;
          return;
        }
        this.compressed = flag === 1;
        this.size = this.header.readUInt32BE(1);
        this.remaining = this.size;
        this.headerFill = 0;
        this.parts = [];
        this.keptBytes = 0;
        this.keepLimit = Math.min(this.size, this.compressed ? GRPC_COMPRESSED_KEEP_BYTES : FRAME_PAYLOAD_CAP);
        if (this.remaining === 0) this.emit();
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - off);
      const want = this.keepLimit - this.keptBytes;
      if (want > 0) {
        const keep = chunk.subarray(off, off + Math.min(want, take));
        this.parts.push(Buffer.from(keep));
        this.keptBytes += keep.length;
      }
      off += take;
      this.remaining -= take;
      if (this.remaining === 0) this.emit();
    }
  }

  private emit(): void {
    const kept = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.keptBytes);
    this.parts = [];
    this.remaining = -1;
    const m: GrpcWireMessage = { compressed: this.compressed, size: this.size, kept, complete: kept.length === this.size };
    try {
      this.onMessage(m);
    } catch {
      /* recording must never break the relay */
    }
  }
}

/**
 * A message as a Frame (`kind: 'message'`), synchronously: `base64` of the first 64 KB of the payload, `size` the
 * full (wire) size. Compressed messages get no payload here (see GrpcFrameRecorder, which decompresses gzip / deflate
 * prefixes off the event loop); unknown encodings stay that way: `compressed`, `truncated`, no payload.
 */
export function messageFrame(dir: Frame['dir'], m: GrpcWireMessage, at = Date.now()): Frame {
  const f: Frame = { dir, at, kind: 'message', size: m.size };
  if (m.compressed) {
    f.compressed = true;
    if (m.size > 0) f.truncated = true;
    return f;
  }
  const data = m.kept.subarray(0, FRAME_PAYLOAD_CAP);
  if (data.length) f.base64 = data.toString('base64');
  if (m.size > data.length) f.truncated = true;
  return f;
}

/**
 * Decompress (gzip / deflate) the start of `input`, streaming in zlib's thread pool, stopping once more than `cap`
 * bytes came out. `complete` = the whole stream decompressed within the cap. undefined = nothing could be decoded.
 */
export function decompressPrefix(input: Buffer, encoding: 'gzip' | 'deflate', cap = FRAME_PAYLOAD_CAP): Promise<{ data: Buffer; complete: boolean } | undefined> {
  return new Promise((resolve) => {
    const z = encoding === 'gzip' ? zlib.createGunzip({ chunkSize: cap + 1024 }) : zlib.createInflate({ chunkSize: cap + 1024 });
    const parts: Buffer[] = [];
    let n = 0;
    let done = false;
    const finish = (complete: boolean) => {
      if (done) return;
      done = true;
      z.removeAllListeners('data');
      z.on('error', () => undefined);
      z.destroy();
      const data = Buffer.concat(parts, n);
      resolve(!data.length && !complete ? undefined : { data: data.subarray(0, cap), complete: complete && n <= cap });
    };
    z.on('data', (d: Buffer) => {
      parts.push(d);
      n += d.length;
      if (n > cap) finish(false);
    });
    z.once('end', () => finish(true));
    z.once('error', () => finish(false));
    z.end(input);
  });
}

/**
 * Turns one direction's messages into frames, in order (CONTRACTS §16.8). Uncompressed messages are framed at once;
 * gzip / deflate ones are decompressed asynchronously from their kept prefix (≤ GRPC_COMPRESSED_KEEP_BYTES of input,
 * ≤ 64 KB + 1 of output): exact `size` when the whole message decompressed within that, else `sizeUnknown` with the
 * wire size. Frames reach `sink` in message order.
 */
export class GrpcFrameRecorder {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    private readonly dir: Frame['dir'],
    private readonly encoding: () => string | undefined,
    private readonly sink: (f: Frame) => void,
  ) {}

  push(m: GrpcWireMessage): void {
    const at = Date.now();
    const enc = this.encoding();
    if (!m.compressed || (enc !== 'gzip' && enc !== 'deflate') || !m.kept.length) {
      const f = messageFrame(this.dir, m, at);
      if (!this.pending) return this.deliver(f);
      this.tail = this.tail.then(() => this.deliver(f));
      return;
    }
    this.pending++;
    const work = decompressPrefix(m.kept, enc);
    this.tail = this.tail.then(async () => {
      const r = await work;
      this.pending--;
      const f: Frame = { dir: this.dir, at, kind: 'message', size: m.size, compressed: true };
      if (r?.data.length) f.base64 = r.data.toString('base64');
      if (r?.complete && m.complete) f.size = r.data.length;
      else {
        f.sizeUnknown = true;
        f.truncated = true;
      }
      this.deliver(f);
    });
  }

  /** Resolves when every frame pushed so far was delivered. */
  idle(): Promise<void> {
    return this.tail;
  }

  private deliver(f: Frame): void {
    try {
      this.sink(f);
    } catch {
      /* recording never breaks the relay */
    }
  }
}

/** Hop-by-hop / connection-specific headers HTTP/2 must not carry (node refuses them). */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'http2-settings', 'proxy-authorization']);

/** Headers to forward on HTTP/2: no pseudo headers, no hop-by-hop ones, nothing internal to Flutter Intercept. */
export function forwardableHeaders(h: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const lk = k.toLowerCase();
    if (v === undefined || lk.startsWith(':') || HOP_BY_HOP.has(lk) || lk.startsWith('flutter-intercept-') || lk === 'x-fi-id' || lk === 'x-fi-send') continue;
    if (lk === 'te' && String(v).toLowerCase() !== 'trailers') continue;
    out[lk] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

/** Headers as recorded on an exchange: no pseudo headers. */
export function recordedHeaders(h: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (v === undefined || k.startsWith(':')) continue;
    out[k] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

/** First payload bytes of a silent tunnel: h2c preface, a TLS record, need more bytes, or something else. */
const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1');
export function classifyFirstBytes(b: Buffer): 'h2c' | 'tls' | 'other' {
  if (!b.length) return 'other';
  if (b[0] === 0x16) return 'tls';
  const n = Math.min(b.length, H2_PREFACE.length);
  return b.subarray(0, n).equals(H2_PREFACE.subarray(0, n)) ? 'h2c' : 'other';
}

/**
 * The truncate fault on a gRPC response: passes bytes until the end of the first message, then calls `onCut` (the
 * caller resets the stream once those bytes are written).
 */
export class FirstMessageCut {
  private header = Buffer.alloc(5);
  private fill = 0;
  private remaining = -1;
  done = false;

  /** The part of `chunk` to forward, and whether the first message ended in it. */
  push(chunk: Buffer): { forward: Buffer; cut: boolean } {
    if (this.done) return { forward: Buffer.alloc(0), cut: false };
    let off = 0;
    while (off < chunk.length) {
      if (this.remaining < 0) {
        const take = Math.min(5 - this.fill, chunk.length - off);
        chunk.copy(this.header, this.fill, off, off + take);
        this.fill += take;
        off += take;
        if (this.fill < 5) break;
        this.remaining = this.header.readUInt32BE(1);
      }
      const take = Math.min(this.remaining, chunk.length - off);
      off += take;
      this.remaining -= take;
      if (this.remaining === 0) {
        this.done = true;
        return { forward: chunk.subarray(0, off), cut: true };
      }
    }
    return { forward: chunk, cut: false };
  }
}

/** A pass-through Transform that shows each chunk to `see` (recording in a pipe, without a second reader). */
export class Observer extends Transform {
  constructor(private readonly see: (b: Buffer) => void) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    try {
      this.see(chunk);
    } catch {
      /* observing never breaks the stream */
    }
    cb(null, chunk);
  }
}

const H2_CODES = [
  'NO_ERROR',
  'PROTOCOL_ERROR',
  'INTERNAL_ERROR',
  'FLOW_CONTROL_ERROR',
  'SETTINGS_TIMEOUT',
  'STREAM_CLOSED',
  'FRAME_SIZE_ERROR',
  'REFUSED_STREAM',
  'CANCEL',
  'COMPRESSION_ERROR',
  'CONNECT_ERROR',
  'ENHANCE_YOUR_CALM',
  'INADEQUATE_SECURITY',
  'HTTP_1_1_REQUIRED',
];

/** An HTTP/2 error code in words (`CANCEL`, `INTERNAL_ERROR`, or `code 42`). */
export function h2CodeName(code: number | undefined): string {
  return code !== undefined && H2_CODES[code] ? H2_CODES[code] : `code ${code}`;
}
