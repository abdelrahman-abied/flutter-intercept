import type * as http from 'http';
import type * as stream from 'stream';
import { BODY_CAP_BYTES } from './body';

/*
 * Bounded, passive body capture + a bounded response-breakpoint buffer, via two wrapped mockttp
 * (CommonJS, writable) exports. Both degrade safely if mockttp's layout changes (see `active`).
 *
 * 1. request-utils#trackResponse — called once per HTTP request with the raw ServerResponse
 *    (whose `.req` is the request, already carrying mockttp's `id`). We wrap:
 *    - the request's `emit`, to see 'data'/'end' WITHOUT adding a listener (adding one would put
 *      the stream in flowing mode before mockttp reads it, losing data);
 *    - the tracked response's `write`/`end`, to see the bytes sent to the app and its completion.
 *    Only the first BODY_CAP_BYTES of each direction are kept; totals are counted.
 * 2. buffer-utils#streamToBuffer — mockttp calls it WITHOUT a size limit only to buffer an upstream
 *    response for beforeResponse (our response breakpoints). We cap that at
 *    RESPONSE_PAUSE_LIMIT_BYTES: above it the upstream is destroyed and the app gets a 502 that says
 *    why, instead of the extension host buffering an arbitrarily large body.
 */

export const RESPONSE_PAUSE_LIMIT_BYTES = 32 * 1024 * 1024;

export interface Capture {
  chunks: Buffer[];
  captured: number;
  total: number;
  ended: boolean;
}

export interface Tap {
  id: string;
  req: Capture;
  res: Capture;
  response: http.ServerResponse & { tags?: string[]; getHeaders(): http.OutgoingHttpHeaders };
  onRequestEnd?: () => void;
  /** finished = response fully written; false = connection closed first. Called once. */
  onResponseDone?: (finished: boolean) => void;
}

const taps = new Map<string, Tap>();
let tapHook: boolean | undefined;
let limitHook: boolean | undefined;

const newCapture = (): Capture => ({ chunks: [], captured: 0, total: 0, ended: false });

function add(c: Capture, chunk: unknown, encoding?: unknown): void {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
  const buf = Buffer.isBuffer(chunk)
    ? chunk
    : typeof chunk === 'string'
      ? Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : undefined;
  if (!buf) return;
  c.total += buf.length;
  if (c.captured < BODY_CAP_BYTES) {
    const take = buf.subarray(0, BODY_CAP_BYTES - c.captured);
    // Copy: the chunk may be a slice of a pooled buffer that gets reused.
    c.chunks.push(Buffer.from(take));
    c.captured += take.length;
  }
}

export function captured(c: Capture): Buffer {
  return Buffer.concat(c.chunks, c.captured);
}

/** True when `captured(c)` is the whole body. */
export function isComplete(c: Capture): boolean {
  return c.ended && c.total <= BODY_CAP_BYTES;
}

export function getTap(id: string): Tap | undefined {
  return taps.get(id);
}

function installTapHook(): boolean {
  if (tapHook !== undefined) return tapHook;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('mockttp/dist/util/request-utils') as { trackResponse: (...a: unknown[]) => unknown };
    const original = mod.trackResponse;
    if (typeof original !== 'function') return (tapHook = false);
    mod.trackResponse = function patchedTrackResponse(this: unknown, ...args: unknown[]) {
      const tracked = original.apply(this, args) as Tap['response'];
      try {
        const raw = args[0] as http.ServerResponse;
        const req = raw?.req as (http.IncomingMessage & { id?: string }) | undefined;
        if (req?.id && tracked) attach(req.id, req, raw, tracked);
      } catch {
        /* never break mockttp's request handling */
      }
      return tracked;
    };
    return (tapHook = true);
  } catch {
    return (tapHook = false);
  }
}

function attach(id: string, req: http.IncomingMessage, raw: http.ServerResponse, tracked: Tap['response']): void {
  const tap: Tap = { id, req: newCapture(), res: newCapture(), response: tracked };
  taps.set(id, tap);

  const reqEmit = req.emit;
  req.emit = function (this: http.IncomingMessage, event: string | symbol, ...a: unknown[]) {
    if (event === 'data') add(tap.req, a[0]);
    else if (event === 'end' && !tap.req.ended) {
      tap.req.ended = true;
      tap.onRequestEnd?.();
    }
    return reqEmit.call(this, event, ...a);
  } as typeof req.emit;

  const write = tracked.write;
  tracked.write = function (this: unknown, chunk: unknown, enc?: unknown, cb?: unknown) {
    add(tap.res, chunk, enc);
    return (write as (...x: unknown[]) => boolean).call(this, chunk, enc, cb);
  } as typeof tracked.write;
  const end = tracked.end;
  tracked.end = function (this: unknown, chunk?: unknown, enc?: unknown, cb?: unknown) {
    add(tap.res, chunk, enc);
    return (end as (...x: unknown[]) => unknown).call(this, chunk, enc, cb);
  } as typeof tracked.end;

  let done = false;
  raw.once('finish', () => {
    tap.res.ended = true;
    if (!done) {
      done = true;
      tap.onResponseDone?.(true);
    }
  });
  raw.once('close', () => {
    if (!done) {
      done = true;
      tap.onResponseDone?.(false);
    }
    // Let in-flight async readers finish with the data, then forget the tap.
    setImmediate(() => taps.delete(id));
  });
}

function installLimitHook(): boolean {
  if (limitHook !== undefined) return limitHook;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('mockttp/dist/util/buffer-utils') as {
      streamToBuffer: (input: stream.Readable, maxSize?: number) => Promise<Buffer>;
    };
    const original = mod.streamToBuffer;
    if (typeof original !== 'function') return (limitHook = false);
    mod.streamToBuffer = function patchedStreamToBuffer(this: unknown, input: stream.Readable, maxSize?: number) {
      if (maxSize !== undefined) return original.call(this, input, maxSize);
      return limitedStreamToBuffer(input, RESPONSE_PAUSE_LIMIT_BYTES);
    } as typeof mod.streamToBuffer;
    return (limitHook = true);
  } catch {
    return (limitHook = false);
  }
}

function limitedStreamToBuffer(input: stream.Readable, limit: number): Promise<Buffer> {
  const p = new Promise<Buffer>((resolve, reject) => {
    if (input.readableEnded) return resolve(Buffer.alloc(0));
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.off('aborted', onAborted);
    };
    const onData = (d: Buffer) => {
      size += d.length;
      chunks.push(d);
      if (size > limit) {
        cleanup();
        chunks.length = 0;
        input.destroy();
        const mb = Math.round(limit / 1024 / 1024);
        const e = Object.assign(
          new Error(
            `Flutter Intercept: the response is larger than ${mb} MB, too large to hold at a response breakpoint. ` +
              'It was failed instead of buffered; narrow the breakpoint rule to pause it.',
          ),
          { code: 'E_FI_RESPONSE_TOO_LARGE', statusCode: 502, statusMessage: 'Response too large to pause' },
        );
        reject(e);
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onAborted = () => {
      cleanup();
      reject(new Error('Aborted'));
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.once('aborted', onAborted);
  });
  // mockttp's BufferInProgress shape, in case any caller peeks at it.
  return Object.assign(p, { currentChunks: [] as Buffer[], events: new (require('events').EventEmitter)() });
}

/** Install both hooks; returns which are active. */
export function installTaps(): { taps: boolean; responseLimit: boolean } {
  return { taps: installTapHook(), responseLimit: installLimitHook() };
}
