// Protobuf wire-format primitives (CONTRACTS §16.3): varints, fixed-width numbers, base64, UTF-8. Pure.

/** Hard limits shared by the decoders and the encoder. */
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_FIELDS = 100_000;
export const MAX_DEPTH = 32;

/** A decoding failure with a plain-words reason (caught by the public entry points). */
export class WireError extends Error {}

export type WireType = 0 | 1 | 2 | 5;

const TWO_32 = 4294967296;

/** Sequential reader over `buf[pos, end)`. Every method throws WireError on truncated / malformed input. */
export class Reader {
  constructor(
    readonly buf: Uint8Array,
    public pos: number,
    readonly end: number,
  ) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  /** Reads a varint as two unsigned 32-bit halves. */
  varint(): [lo: number, hi: number] {
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new WireError(`truncated varint at byte ${this.pos}`);
      const b = this.buf[this.pos++];
      if (i < 4) lo |= (b & 0x7f) << (7 * i);
      else if (i === 4) {
        lo |= (b & 0x0f) << 28;
        hi |= (b & 0x7f) >> 4;
      } else hi |= (b & 0x7f) << (7 * i - 32);
      if ((b & 0x80) === 0) return [lo >>> 0, hi >>> 0];
    }
    throw new WireError(`varint longer than 10 bytes at byte ${this.pos}`);
  }

  /** A varint that must fit a non-negative JS integer (tags and lengths). */
  uvarint(): number {
    const [lo, hi] = this.varint();
    const v = hi * TWO_32 + lo;
    if (!Number.isSafeInteger(v)) throw new WireError(`length out of range at byte ${this.pos}`);
    return v;
  }

  fixed32(): number {
    if (this.pos + 4 > this.end) throw new WireError(`truncated 32-bit value at byte ${this.pos}`);
    const b = this.buf;
    const p = this.pos;
    this.pos += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }

  fixed64(): [lo: number, hi: number] {
    const lo = this.fixed32();
    const hi = this.fixed32();
    return [lo, hi];
  }

  /** `[start, end)` of a length-delimited payload; advances past it. */
  bytesRange(): [number, number] {
    const len = this.uvarint();
    if (len > this.end - this.pos) throw new WireError(`length ${len} runs past the end at byte ${this.pos}`);
    const start = this.pos;
    this.pos += len;
    return [start, this.pos];
  }

  /** Skips one value of the given wire type (groups are refused). */
  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        return;
      case 1:
        this.fixed64();
        return;
      case 2:
        this.bytesRange();
        return;
      case 5:
        this.fixed32();
        return;
      case 3:
      case 4:
        throw new WireError('uses proto2 groups, which are not supported');
      default:
        throw new WireError(`invalid wire type ${wireType} at byte ${this.pos}`);
    }
  }

  /** Reads a tag; returns [fieldNumber, wireType]. */
  tag(): [number, number] {
    const at = this.pos;
    const t = this.uvarint();
    const field = Math.floor(t / 8);
    const wt = t & 7;
    if (field < 1 || field > 536870911) throw new WireError(`invalid field number ${field} at byte ${at}`);
    if (wt === 6 || wt === 7) throw new WireError(`invalid wire type ${wt} at byte ${at}`);
    return [field, wt];
  }
}

// ---------------------------------------------------------------------------------------------
// Number conversions

export const u64 = (lo: number, hi: number): bigint => (BigInt(hi) << 32n) | BigInt(lo);
export const i64 = (lo: number, hi: number): bigint => BigInt.asIntN(64, u64(lo, hi));
export const zigzag32 = (lo: number): number => (lo >>> 1) ^ -(lo & 1);
export const zigzag64 = (lo: number, hi: number): bigint => {
  const n = u64(lo, hi);
  return (n >> 1n) ^ -(n & 1n);
};

const f32 = new DataView(new ArrayBuffer(8));

export function float32FromBits(bits: number): number {
  f32.setUint32(0, bits, true);
  return f32.getFloat32(0, true);
}

export function float64FromBits(lo: number, hi: number): number {
  f32.setUint32(0, lo, true);
  f32.setUint32(4, hi, true);
  return f32.getFloat64(0, true);
}

/** Shortest decimal that reads back as the same float32 (what other runtimes print: 1.1, not 1.100000023841858). */
export function shortestFloat32(v: number): number {
  if (!Number.isFinite(v) || v === 0 || Number.isInteger(v)) return v;
  for (let p = 1; p <= 9; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.fround(s) === v) return s;
  }
  return v;
}

/** Proto3 JSON for a double / float: numbers, or "NaN" / "Infinity" / "-Infinity". */
export function jsonFloat(v: number): number | string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return v;
}

// ---------------------------------------------------------------------------------------------
// Writer

/** Growable byte buffer. */
export class Writer {
  private buf = new Uint8Array(64);
  len = 0;

  constructor(private readonly limit = MAX_INPUT_BYTES) {}

  private ensure(n: number): void {
    const need = this.len + n;
    if (need > this.limit) throw new WireError(`message larger than ${this.limit} bytes`);
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  /** Unsigned varint from a non-negative safe integer. */
  uvarint(v: number): void {
    while (v >= 0x80) {
      this.byte((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.byte(v);
  }

  /** Varint of the 64-bit two's-complement pattern of `v`. */
  varint64(v: bigint): void {
    let n = BigInt.asUintN(64, v);
    while (n >= 0x80n) {
      this.byte(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    this.byte(Number(n));
  }

  /** int32 / enum: negative values are sign-extended to 10 bytes. */
  varint32(v: number): void {
    if (v >= 0) this.uvarint(v);
    else this.varint64(BigInt(v));
  }

  tag(field: number, wt: WireType): void {
    this.uvarint(field * 8 + wt);
  }

  fixed32(v: number): void {
    this.ensure(4);
    const b = this.buf;
    const p = this.len;
    b[p] = v & 0xff;
    b[p + 1] = (v >>> 8) & 0xff;
    b[p + 2] = (v >>> 16) & 0xff;
    b[p + 3] = (v >>> 24) & 0xff;
    this.len += 4;
  }

  fixed64(v: bigint): void {
    const n = BigInt.asUintN(64, v);
    this.fixed32(Number(n & 0xffffffffn));
    this.fixed32(Number(n >> 32n));
  }

  float(v: number): void {
    f32.setFloat32(0, v, true);
    this.fixed32(f32.getUint32(0, true));
  }

  double(v: number): void {
    f32.setFloat64(0, v, true);
    this.fixed32(f32.getUint32(0, true));
    this.fixed32(f32.getUint32(4, true));
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ---------------------------------------------------------------------------------------------
// base64 + UTF-8

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; // URL-safe alphabet accepted too
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function toBase64(b: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

/** Standard or URL-safe base64, padding optional; undefined when it isn't base64. */
export function fromBase64(s: string): Uint8Array | undefined {
  const clean = s.replace(/[\s=]+$/g, '').replace(/\s+/g, '');
  if (clean.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_REV[c] : -1;
    if (v < 0) return undefined;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Lenient = new TextDecoder('utf-8');
const utf8Enc = new TextEncoder();

export const utf8Encode = (s: string): Uint8Array => utf8Enc.encode(s);

/** Decodes UTF-8, replacing invalid sequences (string fields are shown even when malformed). */
export const utf8Decode = (b: Uint8Array): string => utf8Lenient.decode(b);

/** Valid UTF-8 text without control characters (tab / newline / carriage return allowed); else undefined. */
export function printableUtf8(b: Uint8Array): string | undefined {
  let s: string;
  try {
    s = utf8Strict.decode(b);
  } catch {
    return undefined;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f) || c === 0xfffd) return undefined;
  }
  return s;
}
