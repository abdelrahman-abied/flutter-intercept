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
