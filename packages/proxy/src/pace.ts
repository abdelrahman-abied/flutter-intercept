import type * as http from 'http';
import { Transform, type TransformCallback } from 'stream';

/*
 * Link simulation for throttling (CONTRACTS §14.4): a one-way link with a latency and a bandwidth.
 *
 * Everything sent over a direction goes through one FIFO. An item that arrives at `t` can start
 * transmitting at `t + latency`, but not before the previous item finished (the link is busy); it is
 * delivered when its transmission ends: `start + bytes × 8 / kbps` ms. So latency never accumulates
 * across items (two events sent 10 ms apart arrive 10 ms apart, both `latency` late), and bandwidth
 * queues them like a real link does. Byte streams are cut into ~50 ms pieces so they flow smoothly;
 * WebSocket messages and close frames are whole items (a message is delivered at once, after its
 * transmission time).
 */

/** Byte streams are delivered in pieces of about this many ms of transmission. */
const PIECE_MS = 50;
/** A writer may queue this much before it is held back (backpressure). */
export const PACE_HIGH_WATER = 64 * 1024;

export interface LinkShape {
  latencyMs?: number;
  kbps?: number;
}

export const isShaped = (s: LinkShape | undefined): s is LinkShape => !!s && ((s.latencyMs ?? 0) > 0 || (s.kbps ?? 0) > 0);

interface Item {
  at: number;
  size: number;
  run: () => void;
}

export class LinkQueue {
  private readonly items: Item[] = [];
  private busyUntil = 0;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private bytes = 0;
  private readonly latency: number;
  private readonly kbps: number;
  /** Called after every delivery that leaves the queue at or below `lowWater` bytes (default PACE_HIGH_WATER). */
  onDrain?: () => void;
  private readonly lowWater: number;

  constructor(shape: LinkShape, opts: { lowWater?: number } = {}) {
    this.latency = Math.max(0, shape.latencyMs ?? 0);
    this.kbps = Math.max(0, shape.kbps ?? 0);
    this.lowWater = opts.lowWater ?? PACE_HIGH_WATER;
  }

  get queuedBytes(): number {
    return this.bytes;
  }

  get idle(): boolean {
    return this.items.length === 0;
  }

  /** Queue one whole item of `size` bytes; `run` delivers it. */
  push(size: number, run: () => void): void {
    if (this.closed) return;
    const now = performance.now();
    const start = Math.max(now + this.latency, this.busyUntil);
    const end = start + (this.kbps > 0 ? (size * 8) / this.kbps : 0);
    this.busyUntil = end;
    this.items.push({ at: end, size, run });
    this.bytes += size;
    this.schedule();
  }

  /** Queue bytes, delivered in pieces; `done` after the last piece. */
  pushBytes(buf: Buffer, deliver: (piece: Buffer) => void, done?: () => void): void {
    if (!buf.length) {
      this.push(0, () => done?.());
      return;
    }
    const piece = this.kbps > 0 ? Math.max(1, Math.floor((this.kbps * 125 * PIECE_MS) / 1000)) : buf.length;
    for (let off = 0; off < buf.length; off += piece) {
      const part = buf.subarray(off, Math.min(buf.length, off + piece));
      const last = off + piece >= buf.length;
      this.push(part.length, () => {
        deliver(part);
        if (last) done?.();
      });
    }
  }

  /** Stop: nothing more is delivered. */
  close(): void {
    this.closed = true;
    this.items.length = 0;
    this.bytes = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer || this.closed || !this.items.length) return;
    const wait = Math.max(0, this.items[0].at - performance.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const now = performance.now();
    while (!this.closed && this.items.length && this.items[0].at <= now + 1) {
      const it = this.items.shift()!;
      this.bytes -= it.size;
      try {
        it.run();
      } catch {
        /* a delivery must never stop the queue */
      }
      if (this.bytes <= this.lowWater) this.onDrain?.();
    }
    this.schedule();
  }
}

/** A Transform that delivers its bytes through a LinkQueue (used for passthrough tunnels). */
export class PacedStream extends Transform {
  private readonly q: LinkQueue;
  private held?: TransformCallback;
  private flushing?: TransformCallback;

  constructor(shape: LinkShape) {
    super();
    this.q = new LinkQueue(shape);
    this.q.onDrain = () => this.release();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.q.pushBytes(chunk, (p) => this.push(p), () => this.maybeFlushed());
    if (this.q.queuedBytes > PACE_HIGH_WATER) this.held = cb;
    else cb();
  }

  override _flush(cb: TransformCallback): void {
    this.flushing = cb;
    this.maybeFlushed();
  }

  override _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    this.q.close();
    cb(err);
  }

  private release(): void {
    const cb = this.held;
    this.held = undefined;
    cb?.();
  }

  private maybeFlushed(): void {
    if (this.flushing && this.q.idle) {
      const cb = this.flushing;
      this.flushing = undefined;
      cb();
    }
  }
}

type WriteFn = (chunk: unknown, enc?: unknown, cb?: unknown) => boolean;
type EndFn = (chunk?: unknown, enc?: unknown, cb?: unknown) => unknown;

function asBuffer(chunk: unknown, enc?: unknown): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return undefined;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return undefined;
}

/**
 * Pace a request body to the server (CONTRACTS §14.4 `uploadKbps`): wraps the ClientRequest's write / end. Writes
 * return false while more than PACE_HIGH_WATER bytes wait (a piped body is paused, not read ahead), 'drain' follows
 * when the queue is low again; the real end() runs after the last byte was written.
 */
export function shapeUpload(req: http.ClientRequest, kbps: number): void {
  const q = new LinkQueue({ kbps });
  const write = req.write as unknown as WriteFn;
  const end = req.end as unknown as EndFn;
  let needDrain = false;
  let ending = false;
  q.onDrain = () => {
    if (needDrain) {
      needDrain = false;
      req.emit('drain');
    }
  };
  const gone = () => q.close();
  req.once('close', gone);
  req.once('error', gone);
  (req as unknown as { write: WriteFn }).write = function (chunk, enc, cb) {
    const callback = (typeof enc === 'function' ? enc : cb) as ((e?: Error | null) => void) | undefined;
    const buf = asBuffer(chunk, enc);
    if (!buf || ending) {
      if (callback) process.nextTick(callback);
      return true;
    }
    q.pushBytes(buf, (p) => write.call(req, p), callback ? () => callback() : undefined);
    if (q.queuedBytes > PACE_HIGH_WATER) {
      needDrain = true;
      return false;
    }
    return true;
  };
  (req as unknown as { end: EndFn }).end = function (chunk, enc, cb) {
    if (ending) return req;
    ending = true;
    const callback = [chunk, enc, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
    const buf = asBuffer(chunk, enc);
    const finish = () => {
      end.call(req, callback);
    };
    if (buf?.length) q.pushBytes(buf, (p) => write.call(req, p), finish);
    else if (q.idle) finish();
    else q.push(0, finish);
    return req;
  };
}
