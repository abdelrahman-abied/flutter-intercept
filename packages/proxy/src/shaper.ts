import type * as http from 'http';

/*
 * Response shaping for throttle rules, network profiles and the `truncate` fault (CONTRACTS §9.2).
 *
 * It sits in the tap's wrappers of the tracked ServerResponse's write/end (src/taps.ts), i.e. on the
 * bytes going to the app, whatever produced them: a live upstream pipe (pass-through, request
 * breakpoints) or a single end(body) (response breakpoints). Nothing is buffered beyond what the
 * writer hands over before backpressure: write() returns false while chunks are queued and 'drain'
 * is emitted when the queue is empty, so a piped upstream is paused, not read ahead.
 *
 * mockttp checks `response.writableEnded` right after the upstream ends; with a paced queue the real
 * end() comes later, so `writableEnded` reads true from the moment end() was requested (instance
 * getter, removed again once the real end ran).
 */

/** Pacing granularity. Small enough to stream smoothly, large enough to keep timer churn low. */
const TICK_MS = 50;

export interface Shaping {
  /** Cap on the response body rate to the app, kbit/s (1 kbps = 125 bytes/s). */
  kbps?: number;
  /**
   * Cut the body mid-way, then close the connection (FIN): half of content-length when known, else half
   * of the first chunk. The status line and headers are flushed first unless the body is empty.
   */
  truncate?: boolean;
  /** Called once when the body was cut, with the body bytes delivered before the cut. */
  onTruncated?(delivered: number): void;
}

type Res = http.ServerResponse & { getHeaders(): http.OutgoingHttpHeaders };
type WriteFn = (chunk: Buffer, cb?: (e?: Error | null) => void) => boolean;
type EndFn = (cb?: () => void) => unknown;

interface Queued {
  buf: Buffer;
  cb?: (e?: Error | null) => void;
}

export class ResponseShaper {
  private readonly queue: Queued[] = [];
  private queuedBytes = 0;
  private delivered = 0;
  private cutAt?: number;
  private total = 0;
  private timer?: NodeJS.Timeout;
  private needDrain = false;
  private ending?: { cb?: () => void };
  private ended = false;
  private cut = false;
  private gone = false;
  private readonly bytesPerTick: number;

  constructor(
    private readonly res: Res,
    private readonly shaping: Shaping,
    /** Real write/end (bypassing the shaper), and a hook to record bytes actually delivered. */
    private readonly realWrite: WriteFn,
    private readonly realEnd: EndFn,
    private readonly onDelivered: (buf: Buffer) => void,
  ) {
    this.bytesPerTick =
      shaping.kbps && shaping.kbps > 0 ? Math.max(1, Math.floor((shaping.kbps * 125 * TICK_MS) / 1000)) : Infinity;
    res.once('close', () => {
      this.gone = true;
      this.stop();
    });
  }

  write(chunk: Buffer, cb?: (e?: Error | null) => void): boolean {
    if (this.cut || this.gone || this.ending) {
      // Swallowed: after a cut the rest of the upstream body is dropped (mockttp aborts the upstream
      // when the app's connection closes).
      if (cb) process.nextTick(cb);
      return true;
    }
    this.initCut(chunk.length);
    if (chunk.length) {
      this.queue.push({ buf: chunk, cb });
      this.queuedBytes += chunk.length;
    } else if (cb) process.nextTick(cb);
    this.pump();
    if (this.queuedBytes > 0) {
      this.needDrain = true;
      return false;
    }
    return true;
  }

  end(chunk: Buffer | undefined, cb?: () => void): void {
    if (this.ending || this.cut || this.gone) return;
    if (chunk?.length) {
      this.initCut(chunk.length);
      this.queue.push({ buf: chunk });
      this.queuedBytes += chunk.length;
    } else {
      this.initCut(0);
    }
    this.ending = { cb };
    // mockttp's handler checks writableEnded as soon as the upstream ended (see the header comment).
    Object.defineProperty(this.res, 'writableEnded', { configurable: true, get: () => true });
    this.pump();
  }

  private initCut(firstChunkLength: number): void {
    if (!this.shaping.truncate || this.cutAt !== undefined) return;
    const cl = Number(this.res.getHeaders()['content-length']);
    this.total = Number.isFinite(cl) && cl >= 0 ? cl : firstChunkLength;
    this.cutAt = Math.floor(this.total / 2);
  }

  private pump(): void {
    if (this.timer || this.ended || this.gone) return;
    let budget = this.bytesPerTick;
    // The real socket is backed up: let it drain, keep the pace.
    const blocked = (this.res as { writableNeedDrain?: boolean }).writableNeedDrain === true && this.bytesPerTick !== Infinity;
    while (!blocked && this.queue.length && budget > 0 && !this.cut) {
      const head = this.queue[0];
      let n = Math.min(head.buf.length, budget);
      if (this.cutAt !== undefined) n = Math.min(n, this.cutAt - this.delivered);
      if (n > 0) {
        const part = n === head.buf.length ? head.buf : head.buf.subarray(0, n);
        this.onDelivered(part);
        this.realWrite.call(this.res, part);
        this.delivered += n;
        budget -= n;
        this.queuedBytes -= n;
      }
      if (n === head.buf.length) {
        this.queue.shift();
        if (head.cb) process.nextTick(head.cb);
      } else if (n > 0) {
        head.buf = head.buf.subarray(n);
      }
      if (this.cutAt !== undefined && this.delivered >= this.cutAt && (this.queuedBytes > 0 || this.ending)) {
        this.doCut();
        return;
      }
    }
    if (this.cut) return;
    if (!this.queue.length) {
      if (this.needDrain) {
        this.needDrain = false;
        this.res.emit('drain');
      }
      if (this.ending) {
        if (this.cutAt !== undefined && this.cutAt === 0 && this.delivered === 0) return this.doCut(); // empty body
        this.finishEnd();
        return;
      }
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, TICK_MS);
  }

  private finishEnd(): void {
    this.ended = true;
    delete (this.res as unknown as Record<string, unknown>).writableEnded;
    this.realEnd.call(this.res, this.ending?.cb);
  }

  private doCut(): void {
    this.cut = true;
    const pending = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const q of pending) if (q.cb) process.nextTick(q.cb);
    this.stop();
    try {
      // Status line + headers go out with the first body byte; flush them if nothing was written yet
      // (and the body isn't empty), so the app sees a response that breaks off.
      if (this.delivered === 0 && this.total > 0) this.res.flushHeaders();
      this.shaping.onTruncated?.(this.delivered);
    } finally {
      // FIN after what was written, not RST: the bytes before the cut reach the app.
      this.res.socket?.end();
    }
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
