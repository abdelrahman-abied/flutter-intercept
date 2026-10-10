import { isUtf8 } from 'buffer';
import * as zlib from 'zlib';
import type { Body, BodyEncoding } from './types';

export const BODY_CAP_BYTES = 5 * 1024 * 1024;

export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Convert decoded bytes to a display Body (undefined for an empty, complete body).
 * `incomplete`: the bytes are only a prefix of the real body (capture limit hit).
 */
export function bufferToBody(buf: Buffer | undefined, cap = BODY_CAP_BYTES, incomplete = false): Body | undefined {
  if (!buf || buf.length === 0) return incomplete ? { text: '', encoding: 'utf8', truncated: true } : undefined;
  let slice = buf;
  const truncated = buf.length > cap || incomplete;
  if (buf.length > cap) slice = buf.subarray(0, cap);

  if (isUtf8(slice)) return mk(slice.toString('utf8'), 'utf8', truncated);
  if (truncated) {
    // The cut may have split a multi-byte character; retry without the partial tail.
    for (let i = 1; i <= 3 && i < slice.length; i++) {
      const s = slice.subarray(0, slice.length - i);
      if (isUtf8(s)) return mk(s.toString('utf8'), 'utf8', true);
    }
  }
  return mk(slice.toString('base64'), 'base64', truncated);
}

function mk(text: string, encoding: BodyEncoding, truncated: boolean): Body {
  return truncated ? { text, encoding, truncated } : { text, encoding };
}

// ---------- headers (case-insensitive helpers) ----------

export function getHeader(h: HeaderBag, name: string): string | undefined {
  const lname = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lname && v !== undefined) return Array.isArray(v) ? v.join(', ') : v;
  }
  return undefined;
}

export function deleteHeader(h: HeaderBag, name: string): void {
  const lname = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lname) delete h[k];
}

export function setHeader(h: HeaderBag, name: string, value: string): void {
  deleteHeader(h, name);
  h[name] = value;
}

/** Strip undefined values and copy arrays, giving the contract's header shape. */
export function cleanHeaders(h: HeaderBag): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

// ---------- content-encoding ----------

function encodingList(contentEncoding: string | undefined): string[] {
  if (!contentEncoding) return [];
  return contentEncoding
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '' && s !== 'identity');
}

export function normalizedEncoding(contentEncoding: string | undefined): string {
  return encodingList(contentEncoding).join(',');
}

/**
 * Encode `buf` with the given Content-Encoding (applied in order). Returns undefined when an
 * encoding is not supported, in which case the caller should drop the header and send identity.
 */
export function encodeBody(buf: Buffer, contentEncoding: string | undefined): Buffer | undefined {
  let out = buf;
  for (const enc of encodingList(contentEncoding)) {
    switch (enc) {
      case 'gzip':
      case 'x-gzip':
        out = zlib.gzipSync(out);
        break;
      case 'deflate':
        out = zlib.deflateSync(out);
        break;
      case 'br':
        out = zlib.brotliCompressSync(out);
        break;
      case 'zstd': {
        const z = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
        if (!z) return undefined;
        out = z(out);
        break;
      }
      default:
        return undefined;
    }
  }
  return out;
}

/**
 * Produce a correctly framed body for `headers` (mutated): encodes per Content-Encoding (dropping
 * the header when unsupported), sets an exact Content-Length and removes Transfer-Encoding.
 */
export function frameBody(decoded: Buffer, headers: HeaderBag): Buffer {
  let encoded = encodeBody(decoded, getHeader(headers, 'content-encoding'));
  if (encoded === undefined) {
    deleteHeader(headers, 'content-encoding');
    encoded = decoded;
  }
  deleteHeader(headers, 'transfer-encoding');
  setHeader(headers, 'content-length', String(encoded.length));
  return encoded;
}

// ---------- bounded decoding for display ----------

type Decoder = () => zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;

const DECODERS: Record<string, Decoder> = {
  gzip: () => zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  'x-gzip': () => zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  deflate: () => zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  br: () => zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }),
};

/**
 * Decompress at most `limit` output bytes. Tolerates a truncated input (the capture may be a
 * prefix of the body) and bounds the output (no decompression bombs). Resolves undefined when the
 * data can't be decoded at all.
 */
function inflatePrefix(raw: Buffer, make: Decoder, limit: number): Promise<{ buf: Buffer; overflow: boolean } | undefined> {
  return new Promise((resolve) => {
    const z = make();
    const out: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (overflow: boolean, failed = false) => {
      if (settled) return;
      settled = true;
      z.removeAllListeners('data');
      z.destroy();
      if (failed && size === 0) resolve(undefined);
      else resolve({ buf: Buffer.concat(out), overflow });
    };
    z.on('data', (c: Buffer) => {
      out.push(c);
      size += c.length;
      if (size > limit) done(true);
    });
    z.on('end', () => done(false));
    z.on('error', () => done(false, true));
    z.end(raw);
  });
}

/**
 * Display body from raw (wire) bytes. `rawComplete` = false when `raw` is only the captured
 * prefix of a larger body. Decoded output is capped at `cap`.
 */
export async function decodeForDisplay(
  raw: Buffer,
  contentEncoding: string | undefined,
  rawComplete: boolean,
  cap = BODY_CAP_BYTES,
): Promise<Body | undefined> {
  const encs = encodingList(contentEncoding);
  if (encs.length === 0 || raw.length === 0) return bufferToBody(raw, cap, !rawComplete);
  const make = encs.length === 1 ? DECODERS[encs[0]] : undefined;
  if (!make) return bufferToBody(raw, cap, !rawComplete); // zstd, stacked encodings: raw bytes
  const decoded = await inflatePrefix(raw, make, cap);
  if (!decoded) return bufferToBody(raw, cap, !rawComplete);
  return bufferToBody(decoded.buf, cap, !rawComplete || decoded.overflow);
}

// ---------- strict, bounded full decoding (mutate rules) ----------

type StrictDecoder = () => import('stream').Transform;

function strictDecoder(enc: string): StrictDecoder | undefined {
  switch (enc) {
    case 'gzip':
    case 'x-gzip':
      return () => zlib.createGunzip();
    case 'deflate':
      return () => zlib.createInflate();
    case 'br':
      return () => zlib.createBrotliDecompress();
    case 'zstd': {
      const make = (zlib as unknown as { createZstdDecompress?: () => import('stream').Transform }).createZstdDecompress;
      return make ? () => make() : undefined;
    }
    default:
      return undefined;
  }
}

function inflateAll(raw: Buffer, make: StrictDecoder, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = make();
    const out: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (e?: Error) => {
      if (settled) return;
      settled = true;
      z.removeAllListeners('data');
      z.destroy();
      if (e) reject(e);
      else resolve(Buffer.concat(out, size));
    };
    z.on('data', (c: Buffer) => {
      out.push(c);
      size += c.length;
      if (size > limit) done(Object.assign(new Error(`larger than ${Math.round(limit / 1024 / 1024)} MB decoded`), { code: 'E_FI_TOO_LARGE' }));
    });
    z.on('end', () => done());
    z.on('error', (e: Error) => done(e));
    z.end(raw);
  });
}

/**
 * Decode a COMPLETE body per Content-Encoding (stacked encodings undone in reverse order). Unlike
 * decodeForDisplay it fails on corrupt or truncated data and on output past `limit` (error code
 * 'E_FI_TOO_LARGE'), and on an unsupported encoding. `deflate` also accepts raw deflate.
 */
export async function decodeStrict(raw: Buffer, contentEncoding: string | undefined, limit: number): Promise<Buffer> {
  let buf = raw;
  for (const enc of encodingList(contentEncoding).reverse()) {
    const make = strictDecoder(enc);
    if (!make) throw new Error(`unsupported content-encoding "${enc}"`);
    try {
      buf = await inflateAll(buf, make, limit);
    } catch (e) {
      if (enc !== 'deflate' || (e as { code?: string }).code === 'E_FI_TOO_LARGE') throw e;
      buf = await inflateAll(buf, () => zlib.createInflateRaw(), limit);
    }
  }
  if (buf.length > limit) {
    throw Object.assign(new Error(`larger than ${Math.round(limit / 1024 / 1024)} MB`), { code: 'E_FI_TOO_LARGE' });
  }
  return buf;
}

// ---------- async re-encoding (mutate rules, REVIEW-4 #4) ----------

type AsyncCodec = (buf: Buffer, cb: (e: Error | null, out: Buffer) => void) => void;

function asyncEncoder(enc: string): AsyncCodec | undefined {
  switch (enc) {
    case 'gzip':
    case 'x-gzip':
      return (b, cb) => zlib.gzip(b, cb);
    case 'deflate':
      return (b, cb) => zlib.deflate(b, cb);
    case 'br':
      // Quality 4, not the default 11: 11 took 17 s for 18 MB (REVIEW-4 #4); 4 is close in size, ~100× faster.
      return (b, cb) => zlib.brotliCompress(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }, cb);
    case 'zstd': {
      const z = (zlib as unknown as { zstdCompress?: (b: Buffer, cb: (e: Error | null, out: Buffer) => void) => void }).zstdCompress;
      return z ? (b, cb) => z(b, cb) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Like frameBody, but compresses on libuv's thread pool (zlib async APIs) instead of the event loop,
 * brotli at quality 4. Unsupported encodings: the header is dropped and identity is sent.
 */
export async function frameBodyAsync(decoded: Buffer, headers: HeaderBag): Promise<Buffer> {
  let out: Buffer | undefined = decoded;
  for (const enc of encodingList(getHeader(headers, 'content-encoding'))) {
    const codec = asyncEncoder(enc);
    if (!codec) {
      out = undefined;
      break;
    }
    const input: Buffer = out!;
    out = await new Promise<Buffer>((resolve, reject) => codec(input, (e, b) => (e ? reject(e) : resolve(b))));
  }
  if (out === undefined) {
    deleteHeader(headers, 'content-encoding');
    out = decoded;
  }
  deleteHeader(headers, 'transfer-encoding');
  setHeader(headers, 'content-length', String(out.length));
  return out;
}
