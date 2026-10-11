/**
 * Newline-delimited JSON RPC between the IDE plugin and the sidecar (types.ts header, CONTRACTS §15).
 *
 *   request  {id, method, params?}   either direction (plugin ids > 0, sidecar ids < 0)
 *   response {id, result?, error?: {message, code?}}
 *   event    {event, data?}          sidecar → plugin only
 *
 * Framing is defensive: chunks are split on '\n' (a trailing '\r' is dropped), blank lines are ignored, a line longer
 * than `maxLineBytes` is discarded up to its newline, and a line that is not a JSON object is logged by shape only
 * (never its content: it may carry a token). Responses to unknown ids are ignored. Requests the handler doesn't know
 * answer `{error: {code: 'unknown_method'}}`.
 */
import type { Readable, Writable } from 'stream';

export interface RpcError {
  message: string;
  code?: string;
}

/** Thrown by handlers to answer with a specific error code. */
export class RpcFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

export type RequestHandler = (method: string, params: unknown) => unknown;

export interface RpcPeerOptions {
  input: Readable;
  output: Writable;
  /** Handles requests from the other side; its result (or a promise of it) is the response. */
  onRequest: RequestHandler;
  /** Human log lines (never message contents). */
  log?: (line: string) => void;
  /** Called once when the input ends or closes (the IDE went away). */
  onClose?: () => void;
  /** Default 32 MiB. */
  maxLineBytes?: number;
  /** Default timeout of outgoing requests, ms (0 = none). Default 0: UI requests wait for the user. */
  requestTimeoutMs?: number;
}

const DEFAULT_MAX_LINE = 32 * 1024 * 1024;

export class RpcPeer {
  private buf = '';
  private discarding = false;
  private nextId = -1;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private readonly maxLine: number;

  constructor(private readonly o: RpcPeerOptions) {
    this.maxLine = o.maxLineBytes ?? DEFAULT_MAX_LINE;
    o.input.setEncoding?.('utf8');
    o.input.on('data', (chunk: string | Buffer) => this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    const close = () => this.close();
    o.input.on('end', close);
    o.input.on('close', close);
    o.input.on('error', (e: Error) => {
      this.log(`stdin error: ${e.message}`);
      close();
    });
    o.output.on?.('error', (e: Error) => {
      this.log(`stdout error: ${e.message}`);
      close();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Sends a request to the other side; resolves with its `result`, rejects with its `error`. */
  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcFailure('the IDE connection is closed', 'closed'));
    const id = this.nextId--;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.o.requestTimeoutMs ?? 0;
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = {
        resolve: (v) => resolve(v as T),
        reject,
      };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcFailure(`${method}: no answer from the IDE within ${timeoutMs} ms`, 'timeout'));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** Sends an event (sidecar → plugin). */
  event(event: string, data?: unknown): void {
    if (this.closed) return;
    this.write({ event, ...(data === undefined ? {} : { data }) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcFailure('the IDE connection closed', 'closed'));
    }
    this.pending.clear();
    this.o.onClose?.();
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private write(msg: unknown): void {
    let line: string;
    try {
      line = JSON.stringify(msg);
    } catch (e) {
      this.log(`rpc: could not serialise an outgoing message: ${(e as Error).message}`);
      return;
    }
    // JSON.stringify never emits a raw newline (they're escaped inside strings), so one message = one line.
    this.o.output.write(`${line}\n`);
  }

  private onData(chunk: string): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', start);
      if (nl < 0) {
        const rest = chunk.slice(start);
        if (this.discarding) return;
        if (this.buf.length + rest.length > this.maxLine) {
          this.log(`rpc: dropped an incoming line longer than ${this.maxLine} bytes`);
          this.buf = '';
          this.discarding = true;
          return;
        }
        this.buf += rest;
        return;
      }
      const part = chunk.slice(start, nl);
      start = nl + 1;
      if (this.discarding) {
        this.discarding = false;
        this.buf = '';
        continue;
      }
      const line = this.buf + part;
      this.buf = '';
      if (line.length > this.maxLine) {
        this.log(`rpc: dropped an incoming line longer than ${this.maxLine} bytes`);
        continue;
      }
      this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`rpc: ignored a line that is not JSON (${line.length} chars)`);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.log('rpc: ignored a message that is not a JSON object');
      return;
    }
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (typeof m.method === 'string') {
      if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id)) {
        this.log(`rpc: ignored request ${m.method.slice(0, 60)} without a numeric id`);
        return;
      }
      void this.handleRequest(m.id, m.method, m.params);
      return;
    }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return; // late answer to a timed-out request, or not ours
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error !== undefined && m.error !== null) {
        const err = m.error as { message?: unknown; code?: unknown };
        p.reject(new RpcFailure(typeof err.message === 'string' ? err.message : 'request failed', typeof err.code === 'string' ? err.code : undefined));
      } else p.resolve(m.result === undefined ? null : m.result);
      return;
    }
    this.log('rpc: ignored a message without method or id');
  }

  private async handleRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.o.onRequest(method, params);
      if (!this.closed) this.write({ id, result: result === undefined ? null : result });
    } catch (e) {
      const err: RpcError = {
        message: e instanceof Error ? e.message : String(e),
        ...(e instanceof RpcFailure && e.code ? { code: e.code } : {}),
      };
      if (!(e instanceof RpcFailure)) this.log(`rpc: ${method.slice(0, 60)} failed: ${err.message.slice(0, 300)}`);
      if (!this.closed) this.write({ id, error: err });
    }
  }
}
