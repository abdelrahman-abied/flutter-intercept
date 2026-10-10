import * as http from 'http';
import { shapeUpload } from './pace';
import { hasUpgradeHeader, watchRequest, type TimingSink } from './timing';

/*
 * What the pool does to each upstream request of our rules (upstream-pool.ts hands out a per-request view of the
 * chosen agent: prototype = the agent, own `addRequest` only, so sockets, keep-alive and the free list stay with the
 * real agent):
 * - timings (CONTRACTS §13.2, src/timing.ts);
 * - upload pacing (CONTRACTS §14.4 `uploadKbps`, src/pace.ts);
 * - one retry on a fresh connection (CONTRACTS §14.6) when a REUSED keep-alive socket fails before any response
 *   byte with ECONNRESET / EPIPE — the server closed an idle connection just as we picked it. Idempotent methods
 *   only (RFC 9110: GET, HEAD, OPTIONS, TRACE, PUT, DELETE), and only once the whole request was handed to us (body
 *   ≤ 1 MB, kept for the resend). The replacement request goes through the same view (timings, pacing), on a new
 *   connection (the free sockets of that pool key are dropped first: they are as stale as the one that failed), and
 *   its events are re-emitted on the original request, which is what mockttp holds; errors of the dead original
 *   are swallowed from then on.
 */

export interface RequestPlan {
  timings?: TimingSink;
  /** Pace the request body to the server (kbit/s). */
  uploadKbps?: number;
}

export const RETRY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']);
export const RETRY_BODY_MAX = 1024 * 1024;
const RETRY_CODES = new Set(['ECONNRESET', 'EPIPE']);

type AddRequest = (req: http.ClientRequest, options: unknown) => unknown;

/** A per-request view of `agent` applying `plan` (and the reused-socket retry) to each request it carries. */
export function requestView<A extends http.Agent>(agent: A, plan: RequestPlan): A {
  const view: A = Object.create(agent, {
    addRequest: {
      value(req: http.ClientRequest, options: unknown) {
        try {
          prepare(agent, view, req, (options ?? {}) as RequestOptions, plan);
        } catch {
          /* never break the request over timing / pacing / retry bookkeeping */
        }
        return (agent as unknown as { addRequest: AddRequest }).addRequest(req, options);
      },
    },
  });
  return view;
}

interface RequestOptions {
  method?: string;
  headers?: unknown;
  [k: string]: unknown;
}

function prepare(agent: http.Agent, view: http.Agent, req: http.ClientRequest, options: RequestOptions, plan: RequestPlan): void {
  const upgrade = hasUpgradeHeader(options.headers);
  const watch = plan.timings ? watchRequest(req, plan.timings, upgrade) : undefined;
  if (plan.uploadKbps && plan.uploadKbps > 0 && !upgrade) shapeUpload(req, plan.uploadKbps);
  const method = String(options.method ?? 'GET').toUpperCase();
  if (!upgrade && RETRY_METHODS.has(method)) armRetry(agent, view, req, options, plan, () => watch?.cancel());
}

type Fn = (...a: unknown[]) => unknown;

function armRetry(agent: http.Agent, view: http.Agent, req: http.ClientRequest, options: RequestOptions, plan: RequestPlan, cancelTimings: () => void): void {
  const r = req as unknown as Record<string, Fn>;
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  let ended = false;
  let gotBytes = false;
  let callerDestroyed = false;
  let retried = false;
  let replacement: http.ClientRequest | undefined;
  const write = r.write as Fn;
  const end = r.end as Fn;
  const destroy = r.destroy as Fn;
  const emit = r.emit as Fn;

  const capture = (chunk: unknown, enc: unknown) => {
    if (tooBig || chunk === undefined || chunk === null || typeof chunk === 'function') return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8')
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined;
    if (!buf) return;
    size += buf.length;
    if (size > RETRY_BODY_MAX) {
      tooBig = true;
      chunks.length = 0;
    } else chunks.push(Buffer.from(buf));
  };
  r.write = function (this: unknown, chunk: unknown, enc?: unknown, cb?: unknown) {
    capture(chunk, enc);
    return write.call(this, chunk, enc, cb);
  };
  r.end = function (this: unknown, chunk?: unknown, enc?: unknown, cb?: unknown) {
    capture(chunk, enc);
    ended = true;
    return end.call(this, chunk, enc, cb);
  };
  r.destroy = function (this: unknown, err?: unknown) {
    callerDestroyed = true;
    replacement?.destroy(err as Error | undefined);
    return destroy.call(this, err);
  };
  req.once('socket', (socket) => {
    const onBytes = () => {
      gotBytes = true;
    };
    socket.once('data', onBytes);
    const off = () => socket.off('data', onBytes);
    req.once('response', off);
    req.once('close', off);
  });

  const shouldRetry = (e: unknown) =>
    req.reusedSocket && !gotBytes && !(req as unknown as { res?: unknown }).res && ended && !tooBig && !callerDestroyed && RETRY_CODES.has(String((e as { code?: unknown })?.code));

  r.emit = function (this: unknown, event: unknown, ...args: unknown[]) {
    if (event === 'error') {
      if (retried) return true; // the dead original: the replacement reports
      if (shouldRetry(args[0])) {
        retried = true;
        resend();
        return true;
      }
    }
    return emit.call(this, event, ...args);
  };

  const resend = () => {
    cancelTimings();
    try {
      const name = (agent as unknown as { getName(o: unknown): string }).getName(options);
      for (const s of agent.freeSockets[name] ?? []) s.destroy();
    } catch {
      /* only an optimisation */
    }
    plan.timings?.({ reused: undefined });
    let next: http.ClientRequest;
    try {
      next = new http.ClientRequest({ ...(options as http.RequestOptions), agent: view });
    } catch (e) {
      emit.call(req, 'error', e);
      return;
    }
    replacement = next;
    next.on('response', (res) => emit.call(req, 'response', res));
    next.on('information', (info) => emit.call(req, 'information', info));
    next.on('error', (e) => emit.call(req, 'error', e));
    if (callerDestroyed) next.destroy();
    else next.end(size ? Buffer.concat(chunks, size) : undefined);
  };
}
