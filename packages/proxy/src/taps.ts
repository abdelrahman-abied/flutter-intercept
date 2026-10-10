import type * as http from 'http';
import { STATUS_CODES } from 'http';
import type * as stream from 'stream';
import { BODY_CAP_BYTES } from './body';
import { ResponseShaper, type Shaping } from './shaper';

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
 *    When the flow sets `shaping` (throttle / network profile / truncate fault), the response bytes go
 *    through a ResponseShaper (src/shaper.ts) on their way to the app, and only delivered bytes are kept.
 * 2. buffer-utils#streamToBuffer — mockttp calls it WITHOUT a size limit only to buffer an upstream
 *    response for beforeResponse (our response breakpoints and mutate rules). We cap that at
 *    RESPONSE_PAUSE_LIMIT_BYTES: above it the upstream is destroyed and the app gets a 502 that says
 *    why, instead of the extension host buffering an arbitrarily large body.
 */

export const RESPONSE_PAUSE_LIMIT_BYTES = 32 * 1024 * 1024;

export interface Capture {
  chunks: Buffer[];
  captured: number;
  total: number;
  ended: boolean;
  /** Count bytes only, keep none (SSE: the events are recorded as frames instead). */
  skip?: boolean;
}

/** What the response-head hook may change before the head is written. */
export interface HeadPatch {
  /** Headers removed (case-insensitive) and then set. */
  remove?: string[];
  set?: Record<string, string>;
  /** Send the head now instead of with the first body chunk (event streams: the app sees it at once). */
  flush?: boolean;
  /** Replace the status (and its reason phrase): a rewrite rule (CONTRACTS §12.6). */
  status?: number;
}

export interface Tap {
  id: string;
  req: Capture;
  res: Capture;
  response: http.ServerResponse & { tags?: string[]; getHeaders(): http.OutgoingHttpHeaders };
  onRequestEnd?: () => void;
  /** finished = response fully written; false = connection closed first. Called once. */
  onResponseDone?: (finished: boolean) => void;
  /** Set by the flow before the first response byte: pace and/or cut the body to the app. */
  shaping?: Shaping;
  /**
   * Called once, when the response head is about to be written, with the status and the headers
   * (lower-cased names). May patch the headers (CORS) or ask for an early flush (SSE).
   */
  onResponseHead?: (status: number, headers: Record<string, string | string[]>) => HeadPatch | void;
  /** Each response chunk as it goes to the app (after shaping). */
  onResponseData?: (buf: Buffer) => void;
}

const taps = new Map<string, Tap>();
let tapHook: boolean | undefined;
let limitHook: boolean | undefined;

const newCapture = (): Capture => ({ chunks: [], captured: 0, total: 0, ended: false });

function toBuffer(chunk: unknown, encoding?: unknown): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return undefined;
  return Buffer.isBuffer(chunk)
    ? chunk
    : typeof chunk === 'string'
      ? Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : undefined;
}

function add(c: Capture, chunk: unknown, encoding?: unknown): Buffer | undefined {
  const buf = toBuffer(chunk, encoding);
  if (!buf) return undefined;
  c.total += buf.length;
  if (!c.skip && c.captured < BODY_CAP_BYTES) {
    const take = buf.subarray(0, BODY_CAP_BYTES - c.captured);
    // Copy: the chunk may be a slice of a pooled buffer that gets reused.
    c.chunks.push(Buffer.from(take));
    c.captured += take.length;
  }
  return buf;
}

type FlatHeaders = string[];

/** Header view (lower-cased names) of writeHead's argument plus headers already set with setHeader. */
function headView(res: http.ServerResponse, arg: unknown): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null) return;
    const name = k.toLowerCase();
    const vals = Array.isArray(v) ? v.map(String) : [String(v)];
    const prev = out[name];
    const all = prev === undefined ? vals : [...(Array.isArray(prev) ? prev : [prev]), ...vals];
    out[name] = all.length === 1 ? all[0] : all;
  };
  for (const [k, v] of Object.entries(res.getHeaders())) put(k, v);
  if (Array.isArray(arg)) {
    if (arg.length && Array.isArray(arg[0])) for (const [k, v] of arg as Array<[string, string]>) put(k, v);
    else for (let i = 0; i + 1 < arg.length; i += 2) put(String(arg[i]), arg[i + 1]);
  } else if (arg && typeof arg === 'object') {
    for (const [k, v] of Object.entries(arg as Record<string, unknown>)) put(k, v);
  }
  return out;
}

/** Apply a HeadPatch to writeHead's headers argument (and to headers set with setHeader). */
function patchHeadArg(res: http.ServerResponse, arg: unknown, patch: HeadPatch): unknown {
  const drop = new Set([...(patch.remove ?? []), ...Object.keys(patch.set ?? {})].map((n) => n.toLowerCase()));
  for (const name of res.getHeaderNames()) if (drop.has(name.toLowerCase())) res.removeHeader(name);
  const set = Object.entries(patch.set ?? {});
  if (Array.isArray(arg)) {
    if (arg.length && Array.isArray(arg[0])) {
      const pairs = (arg as Array<[string, string]>).filter(([k]) => !drop.has(String(k).toLowerCase()));
      return [...pairs, ...set];
    }
    const flat: FlatHeaders = [];
    for (let i = 0; i + 1 < arg.length; i += 2) if (!drop.has(String(arg[i]).toLowerCase())) flat.push(arg[i], arg[i + 1]);
    for (const [k, v] of set) flat.push(k, v);
    return flat;
  }
  if (arg && typeof arg === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg as Record<string, unknown>)) if (!drop.has(k.toLowerCase())) obj[k] = v;
    for (const [k, v] of set) obj[k] = v;
    return obj;
  }
  for (const [k, v] of set) res.setHeader(k, v);
  return arg;
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

  const addRes = (chunk: unknown, enc?: unknown) => {
    const buf = add(tap.res, chunk, enc);
    if (buf?.length && tap.onResponseData) {
      try {
        tap.onResponseData(buf);
      } catch {
        /* recording must never break the response */
      }
    }
  };
  const writeHead = tracked.writeHead;
  let headSeen = false;
  tracked.writeHead = function (this: http.ServerResponse, ...a: unknown[]) {
    let flush = false;
    if (!headSeen && tap.onResponseHead) {
      headSeen = true;
      try {
        // writeHead(status, [statusMessage], [headers])
        const hi = typeof a[1] === 'string' ? 2 : 1;
        const patch = tap.onResponseHead(Number(a[0]), headView(this, a[hi]));
        if (patch) {
          if (patch.remove?.length || (patch.set && Object.keys(patch.set).length)) {
            const patched = patchHeadArg(this, a[hi], patch);
            if (a.length > hi || patched !== undefined) a[hi] = patched;
          }
          flush = !!patch.flush;
          if (patch.status !== undefined) {
            a[0] = patch.status;
            if (typeof a[1] === 'string') a[1] = STATUS_CODES[patch.status] ?? 'Unknown';
          }
        }
      } catch {
        /* never break the response */
      }
    }
    const r = (writeHead as (...x: unknown[]) => unknown).apply(this, a);
    if (flush) {
      try {
        this.flushHeaders();
      } catch {
        /* ignore */
      }
    }
    return r;
  } as typeof tracked.writeHead;

  const write = tracked.write;
  const end = tracked.end;
  let shaper: ResponseShaper | undefined;
  const shaped = (): ResponseShaper | undefined => {
    if (!tap.shaping) return undefined;
    shaper ??= new ResponseShaper(
      tracked,
      tap.shaping,
      write as unknown as (chunk: Buffer) => boolean,
      end as unknown as (cb?: () => void) => unknown,
      (buf) => addRes(buf),
    );
    return shaper;
  };
  tracked.write = function (this: unknown, chunk: unknown, enc?: unknown, cb?: unknown) {
    const sh = shaped();
    if (sh) {
      const buf = toBuffer(chunk, enc);
      const callback = typeof enc === 'function' ? enc : cb;
      return sh.write(buf ?? Buffer.alloc(0), callback as ((e?: Error | null) => void) | undefined);
    }
    addRes(chunk, enc);
    return (write as (...x: unknown[]) => boolean).call(this, chunk, enc, cb);
  } as typeof tracked.write;
  tracked.end = function (this: unknown, chunk?: unknown, enc?: unknown, cb?: unknown) {
    const sh = shaped();
    if (sh) {
      const callback = [chunk, enc, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
      sh.end(typeof chunk === 'function' ? undefined : toBuffer(chunk, enc), callback);
      return this;
    }
    if (typeof chunk !== 'function') addRes(chunk, enc);
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
            `Flutter Intercept: the response is larger than ${mb} MB, too large to hold at a response breakpoint ` +
              'or for a mutate rule. It was failed instead of buffered; narrow the rule so it skips this response.',
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
