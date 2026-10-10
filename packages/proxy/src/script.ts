import { Worker } from 'worker_threads';
import { createHash } from 'crypto';
import { BODY_CAP_BYTES } from './body';
import { MAX_SCRIPT_BYTES } from './rules';
import type { Body, ScriptRequest, ScriptResponse } from './types';

/*
 * JavaScript scripting hooks (CONTRACTS §13.4). Trusted code, NOT a security sandbox: the limits below keep a
 * buggy script (a loop, a runaway allocation) from hanging or crashing the extension host, and keep Node's
 * powers (require, process, timers, fetch, import()) out of reach of ordinary script code.
 *
 * - One worker thread per InterceptProxy, created from source (`eval: true`: nothing extra to bundle), started on
 *   the first hook call and terminated when no script rule is left; 64 MB old space.
 * - Each script runs in its own `vm` context (only plain JS builtins; no eval / new Function / WebAssembly),
 *   compiled once per rule + code. Nothing from the worker's own realm is reachable from a context: inputs go
 *   in as a JSON string, results come out as a JSON string (parsed and validated here).
 * - Hooks are synchronous; every load / call has a 200 ms vm timeout. Calls go to the worker one at a time; a
 *   1 s watchdog per call terminates the worker (it is restarted on the next call) if a timeout didn't stop it.
 *   At most 100 calls wait, each at most 2 s. No FinalizationRegistry / WeakRef (callbacks between calls, outside
 *   the timeout), SharedArrayBuffer / Atomics or WebAssembly in a context; binary data (outside the 64 MB heap
 *   limit) is checked after every call: over 64 MB, the call fails and the worker is restarted (REVIEW-7 #3).
 */

/** Per call (and per script load): the vm timeout. */
export const SCRIPT_CALL_TIMEOUT_MS = 200;
/** No answer from the worker within this → terminate it (restarted on the next call). */
export const SCRIPT_WATCHDOG_MS = 1000;
/** Bodies larger than this (or binary) reach a script as `bodyOmitted`. */
export const SCRIPT_BODY_MAX_BYTES = 1024 * 1024;
export const SCRIPT_LOG_MAX_LINES = 20;
export const SCRIPT_LOG_MAX_CHARS = 500;
const SCRIPT_OLD_SPACE_MB = 64;
/** Memory outside the V8 heap (ArrayBuffer / typed-array backing stores) a worker may hold above its start. */
export const SCRIPT_EXTERNAL_MAX_BYTES = 64 * 1024 * 1024;
/** Calls waiting for the worker; more fail at once. */
export const SCRIPT_QUEUE_MAX = 100;
/** A call that waited this long for the worker fails (the engine is busy). */
export const SCRIPT_QUEUE_WAIT_MS = 2000;

/** Inside each context, before the user's code: the invoker, with the builtins it needs captured first. */
const BOOTSTRAP = String.raw`(function () {
  'use strict';
  var G = globalThis;
  var parse = JSON.parse, stringify = JSON.stringify, Str = String, ErrorCtor = Error;
  var defineProperty = Object.defineProperty;
  var MAX_LINES = ${SCRIPT_LOG_MAX_LINES}, MAX_CHARS = ${SCRIPT_LOG_MAX_CHARS};
  var state = { lines: [] };
  function fmt(v) {
    try {
      if (typeof v === 'string') return v;
      if (v === undefined) return 'undefined';
      if (typeof v === 'function') return '[function]';
      if (typeof v === 'bigint' || typeof v === 'symbol') return Str(v);
      if (v instanceof ErrorCtor) return v.name + ': ' + v.message;
      var s = stringify(v);
      return s === undefined ? Str(v) : s;
    } catch (e) {
      try { return Str(v); } catch (e2) { return '[unprintable]'; }
    }
  }
  function describe(e) {
    try {
      if (e !== null && typeof e === 'object' && typeof e.message === 'string') return (e.name ? e.name + ': ' : '') + e.message;
      return 'threw ' + fmt(e);
    } catch (x) {
      return 'threw an unprintable value';
    }
  }
  function invoke() {
    var input = parse(G.__fi_input);
    G.__fi_input = undefined;
    var lines = (state.lines = []);
    var context = {
      ruleId: input.ruleId,
      exchangeId: input.exchangeId,
      log: function () {
        if (lines.length >= MAX_LINES) return;
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
        lines.push(parts.join(' ').slice(0, MAX_CHARS));
      }
    };
    var name = input.hook;
    var fn = name === 'onRequest'
      ? (typeof onRequest === 'function' ? onRequest : undefined)
      : (typeof onResponse === 'function' ? onResponse : undefined);
    if (!fn) return stringify({ lines: lines, missing: true });
    var result;
    try {
      result = name === 'onRequest' ? fn(input.args[0], context) : fn(input.args[0], input.args[1], context);
    } catch (e) {
      return stringify({ lines: lines, error: describe(e) });
    }
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
      return stringify({ lines: lines, error: name + ' returned a Promise; hooks must be synchronous (no async / await)' });
    }
    if (result === undefined || result === null) return stringify({ lines: lines });
    var out;
    try {
      out = stringify(result);
    } catch (e) {
      return stringify({ lines: lines, error: name + ' returned a value that is not JSON (' + describe(e) + ')' });
    }
    if (out === undefined) return stringify({ lines: lines, error: name + ' returned a ' + typeof result + ', not an object' });
    return stringify({ lines: lines, out: out });
  }
  // No code outside the timed calls (registry callbacks are platform tasks that run between calls) and no memory the
  // heap limit doesn't see (WebAssembly.Memory works without code generation; shared buffers are external too).
  ['FinalizationRegistry', 'WeakRef', 'SharedArrayBuffer', 'Atomics', 'WebAssembly'].forEach(function (n) {
    try { delete G[n]; } catch (e) { /* ignore */ }
  });
  defineProperty(G, '__fi_invoke', { value: invoke });
  defineProperty(G, '__fi_state', { value: state });
})();`;

const WORKER_SOURCE = String.raw`'use strict';
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const TIMEOUT = workerData.timeoutMs;
const EXTERNAL_MAX = workerData.externalMax;
const externalBase = process.memoryUsage().external;
// Typed arrays / ArrayBuffers live outside the heap that resourceLimits caps: checked after every load and call.
const overMemory = () => process.memoryUsage().external - externalBase > EXTERNAL_MAX;
const reply = (msg) => parentPort.postMessage(overMemory() ? { ...msg, overMemory: true } : msg);
const MAX_LINES = ${SCRIPT_LOG_MAX_LINES};
const boot = new vm.Script(workerData.bootstrap, { filename: 'flutter-intercept-runtime.js' });
const call = new vm.Script('__fi_invoke()', { filename: 'flutter-intercept-call.js' });
const scripts = new Map();
const timedOut = (e) => e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
function describe(e) {
  try {
    if (e && typeof e.message === 'string') return (e.name ? e.name + ': ' : '') + e.message;
    return String(e);
  } catch (x) {
    return 'unknown error';
  }
}
function load(key, code, filename) {
  const ctx = vm.createContext(Object.create(null), {
    name: filename,
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  boot.runInContext(ctx);
  try {
    new vm.Script(code, { filename }).runInContext(ctx, { timeout: TIMEOUT });
    scripts.set(key, { ctx });
  } catch (e) {
    scripts.set(key, { error: timedOut(e) ? 'loading the script timed out after ' + TIMEOUT + ' ms' : describe(e) });
  }
}
function linesOf(ctx) {
  try {
    const l = ctx.__fi_state.lines;
    const out = [];
    for (let i = 0; i < l.length && i < MAX_LINES; i++) out.push(String(l[i]));
    return out;
  } catch (e) {
    return [];
  }
}
parentPort.on('message', (m) => {
  if (m.type === 'forget') {
    for (const k of m.keys) scripts.delete(k);
    return;
  }
  if (m.type !== 'call') return;
  let s = scripts.get(m.key);
  if (!s) {
    if (typeof m.code !== 'string') return reply({ id: m.id, error: 'the script is not loaded' });
    load(m.key, m.code, m.filename);
    s = scripts.get(m.key);
  }
  if (s.error) return reply({ id: m.id, error: s.error, lines: [] });
  try {
    s.ctx.__fi_input = m.input;
    const out = call.runInContext(s.ctx, { timeout: TIMEOUT });
    reply({ id: m.id, result: String(out) });
  } catch (e) {
    const error = timedOut(e) ? m.hook + ' timed out after ' + TIMEOUT + ' ms' : describe(e);
    reply({ id: m.id, error, lines: linesOf(s.ctx) });
  }
});`;

/** What a hook call produced. `error` = it threw / timed out / returned something invalid; lines are kept. */
export interface ScriptOutcome {
  lines: string[];
  error?: string;
  /** The hook isn't defined by the script. */
  missing?: boolean;
  /** The parsed return value (undefined = unchanged). */
  value?: unknown;
}

export interface ScriptRunnerOptions {
  callTimeoutMs?: number;
  watchdogMs?: number;
  externalMaxBytes?: number;
  maxQueue?: number;
  queueWaitMs?: number;
}

interface Call {
  id: number;
  key: string;
  code: string;
  filename: string;
  hook: 'onRequest' | 'onResponse';
  input: string;
  resolve: (o: ScriptOutcome) => void;
  /** Fails the call if it is still waiting at SCRIPT_QUEUE_WAIT_MS. */
  deadline?: NodeJS.Timeout;
}

type Reply = { id: number; result?: string; error?: string; lines?: string[]; overMemory?: boolean };

const keyOf = (ruleId: string, code: string) => `${ruleId}\0${createHash('sha1').update(code).digest('hex')}`;

/** The worker and its call queue (one call in flight at a time). */
export class ScriptRunner {
  private worker?: Worker;
  /** Script keys the current worker has loaded (it gets the code with the first call). */
  private loaded = new Set<string>();
  private readonly queue: Call[] = [];
  private current?: { call: Call; timer: NodeJS.Timeout };
  private nextId = 1;
  /** Keys of the script rules currently set. */
  private keys = new Set<string>();
  private readonly callTimeoutMs: number;
  private readonly watchdogMs: number;
  private readonly externalMaxBytes: number;
  private readonly maxQueue: number;
  private readonly queueWaitMs: number;

  constructor(opts: ScriptRunnerOptions = {}) {
    this.callTimeoutMs = opts.callTimeoutMs ?? SCRIPT_CALL_TIMEOUT_MS;
    this.watchdogMs = opts.watchdogMs ?? SCRIPT_WATCHDOG_MS;
    this.externalMaxBytes = opts.externalMaxBytes ?? SCRIPT_EXTERNAL_MAX_BYTES;
    this.maxQueue = opts.maxQueue ?? SCRIPT_QUEUE_MAX;
    this.queueWaitMs = opts.queueWaitMs ?? SCRIPT_QUEUE_WAIT_MS;
  }

  /** The worker thread is running. */
  get running(): boolean {
    return !!this.worker;
  }

  /**
   * The script rules now set (id + code): compiled scripts of the others are dropped; with none left the worker is
   * terminated (once its queue is empty).
   */
  setScripts(scripts: Array<{ ruleId: string; code: string }>): void {
    const keys = new Set(scripts.map((s) => keyOf(s.ruleId, String(s.code ?? ''))));
    const gone = [...this.loaded].filter((k) => !keys.has(k));
    this.keys = keys;
    if (gone.length && this.worker) {
      for (const k of gone) this.loaded.delete(k);
      this.worker.postMessage({ type: 'forget', keys: gone });
    }
    this.stopIfIdle();
  }

  /** Terminate the worker; queued and running calls end with an error. */
  stop(): void {
    const pending = [...(this.current ? [this.current.call] : []), ...this.queue.splice(0)];
    if (this.current) clearTimeout(this.current.timer);
    this.current = undefined;
    this.kill();
    for (const c of pending) {
      clearTimeout(c.deadline);
      c.resolve({ lines: [], error: 'the script engine stopped' });
    }
  }

  /** Run a hook. Never rejects: failures come back as `error`. */
  run(
    ruleId: string,
    ruleName: string,
    code: string,
    hook: 'onRequest' | 'onResponse',
    args: unknown[],
    ctx: { ruleId: string; exchangeId: string },
  ): Promise<ScriptOutcome> {
    if (typeof code !== 'string' || !code.trim()) return Promise.resolve({ lines: [], error: 'the script has no code' });
    if (utf8Bytes(code) > MAX_SCRIPT_BYTES) return Promise.resolve({ lines: [], error: `the script is larger than ${MAX_SCRIPT_BYTES / 1024} KB` });
    let input: string;
    try {
      input = JSON.stringify({ hook, args, ruleId: ctx.ruleId, exchangeId: ctx.exchangeId });
    } catch (e) {
      return Promise.resolve({ lines: [], error: `could not pass the input (${(e as Error).message})` });
    }
    const filename = `script ${ruleName.replace(/[^\w .()-]/g, '_').slice(0, 80) || ruleId}.js`;
    // Bounded waiting (REVIEW-7 #3): one call runs at a time, so a flood of matching requests must not pile up.
    if (this.queue.length >= this.maxQueue) {
      return Promise.resolve({ lines: [], error: `too many requests waiting for the script engine (${this.maxQueue})` });
    }
    return new Promise((resolve) => {
      const call: Call = { id: this.nextId++, key: keyOf(ruleId, code), code, filename, hook, input, resolve };
      call.deadline = setTimeout(() => {
        const i = this.queue.indexOf(call);
        if (i < 0) return;
        this.queue.splice(i, 1);
        resolve({ lines: [], error: `waited more than ${this.queueWaitMs / 1000} s for the script engine (busy)` });
      }, this.queueWaitMs);
      this.queue.push(call);
      this.pump();
    });
  }

  private pump(): void {
    if (this.current) return;
    const call = this.queue.shift();
    if (!call) return this.stopIfIdle();
    clearTimeout(call.deadline);
    const worker = this.ensureWorker();
    if (!worker) {
      call.resolve({ lines: [], error: 'the script engine could not start' });
      return this.pump();
    }
    const timer = setTimeout(() => this.watchdog(call), this.watchdogMs);
    this.current = { call, timer };
    const first = !this.loaded.has(call.key);
    this.loaded.add(call.key);
    worker.postMessage({
      type: 'call',
      id: call.id,
      key: call.key,
      hook: call.hook,
      input: call.input,
      filename: call.filename,
      ...(first ? { code: call.code } : {}),
    });
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) return this.worker;
    let w: Worker;
    try {
      w = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { bootstrap: BOOTSTRAP, timeoutMs: this.callTimeoutMs, externalMax: this.externalMaxBytes },
        resourceLimits: { maxOldGenerationSizeMb: SCRIPT_OLD_SPACE_MB },
      });
    } catch {
      return undefined;
    }
    w.unref();
    w.on('message', (m: Reply) => {
      if (this.worker !== w) return;
      this.onReply(m);
    });
    // Out of memory (resourceLimits) or a crash: fail the call in flight; the next call starts a new worker.
    w.on('error', (e) => {
      if (this.worker === w) this.lost(`the script engine failed (${e.message})`);
    });
    w.on('exit', () => {
      if (this.worker === w) this.lost('the script engine exited');
    });
    this.worker = w;
    this.loaded = new Set();
    return w;
  }

  private onReply(m: Reply): void {
    const cur = this.current;
    if (!cur || cur.call.id !== m.id) return;
    clearTimeout(cur.timer);
    this.current = undefined;
    if (m.overMemory) {
      // Binary data the heap limit doesn't cover: drop the worker (and its memory); the call fails.
      this.kill();
      const out = parseReply(m);
      const mb = Math.round(this.externalMaxBytes / 1024 / 1024);
      cur.call.resolve({ lines: out.lines, error: `the script holds more than ${mb} MB of binary data (typed arrays / ArrayBuffers); the script engine was restarted` });
    } else cur.call.resolve(parseReply(m));
    this.pump();
  }

  private watchdog(call: Call): void {
    if (this.current?.call !== call) return;
    this.current = undefined;
    this.kill();
    call.resolve({ lines: [], error: `${call.hook} did not finish within ${this.watchdogMs / 1000} s; the script engine was restarted` });
    this.pump();
  }

  private lost(why: string): void {
    const cur = this.current;
    this.current = undefined;
    this.kill();
    if (cur) {
      clearTimeout(cur.timer);
      cur.call.resolve({ lines: [], error: why });
    }
    this.pump();
  }

  private kill(): void {
    const w = this.worker;
    this.worker = undefined;
    this.loaded = new Set();
    if (w) void w.terminate().catch(() => undefined);
  }

  private stopIfIdle(): void {
    if (!this.keys.size && !this.current && !this.queue.length) this.kill();
  }
}

function parseReply(m: { result?: string; error?: string; lines?: string[] }): ScriptOutcome {
  const lines = (Array.isArray(m.lines) ? m.lines : []).slice(0, SCRIPT_LOG_MAX_LINES).map((l) => String(l).slice(0, SCRIPT_LOG_MAX_CHARS));
  if (m.error !== undefined) return { lines, error: String(m.error) };
  try {
    const r = JSON.parse(String(m.result)) as { lines?: unknown; error?: string; missing?: boolean; out?: string };
    const got = (Array.isArray(r.lines) ? r.lines : []).slice(0, SCRIPT_LOG_MAX_LINES).map((l) => String(l).slice(0, SCRIPT_LOG_MAX_CHARS));
    if (r.error !== undefined) return { lines: got, error: String(r.error) };
    if (r.missing) return { lines: got, missing: true };
    return { lines: got, ...(r.out !== undefined ? { value: JSON.parse(r.out) } : {}) };
  } catch (e) {
    return { lines, error: `unreadable result (${(e as Error).message})` };
  }
}

// ---------------------------------------------------------------- inputs and results

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** A body as a script sees it: decoded text ≤ 1 MB, else omitted (binary / larger / cut). Empty = absent. */
export function scriptBody(b: Body | undefined): { body?: string; bodyOmitted?: true } {
  if (!b || b.text === '') return {};
  if (b.encoding !== 'utf8' || b.truncated || utf8Bytes(b.text) > SCRIPT_BODY_MAX_BYTES) return { bodyOmitted: true };
  return { body: b.text };
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validated header set (string values; finite numbers are accepted as text). Throws a readable message. */
function scriptHeaders(v: unknown, where: string): Record<string, string | string[]> {
  if (!isObject(v)) throw new Error(`${where}.headers must be an object`);
  const out: Record<string, string | string[]> = {};
  const text = (x: unknown, name: string): string => {
    const s = typeof x === 'number' && Number.isFinite(x) ? String(x) : x;
    if (typeof s !== 'string' || /[\r\n\0]/.test(s)) throw new Error(`${where}.headers["${name}"] has an invalid value`);
    return s;
  };
  for (const [k, raw] of Object.entries(v)) {
    if (!HTTP_TOKEN.test(k)) throw new Error(`${where}.headers has an invalid header name: ${JSON.stringify(k).slice(0, 100)}`);
    if (raw === undefined || raw === null) continue;
    out[k] = Array.isArray(raw) ? raw.map((x) => text(x, k)) : text(raw, k);
  }
  return out;
}

function scriptBodyText(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where}.body must be a string`);
  if (utf8Bytes(v) > BODY_CAP_BYTES) throw new Error(`${where}.body is larger than ${BODY_CAP_BYTES / 1024 / 1024} MB`);
  return v;
}

function scriptStatus(v: unknown, where: string): number {
  if (!Number.isInteger(v) || (v as number) < 100 || (v as number) > 599) throw new Error(`${where}.status must be an integer 100–599, got ${JSON.stringify(v)}`);
  return v as number;
}

/** What onRequest asked for. Throws a readable message on an invalid value. */
export type RequestOutcome =
  | { kind: 'forward'; method?: string; url?: string; headers?: Record<string, string | string[]>; body?: string }
  | { kind: 'respond'; status: number; headers: Record<string, string | string[]>; body: string };

export function readRequestResult(v: unknown): RequestOutcome {
  if (!isObject(v)) throw new Error(`onRequest must return an object or undefined, got ${Array.isArray(v) ? 'an array' : typeof v}`);
  if ('response' in v) {
    const r = v.response;
    if (!isObject(r)) throw new Error('onRequest: response must be an object');
    return {
      kind: 'respond',
      status: r.status === undefined ? 200 : scriptStatus(r.status, 'response'),
      headers: r.headers === undefined ? {} : scriptHeaders(r.headers, 'response'),
      body: r.body === undefined || r.body === null ? '' : scriptBodyText(r.body, 'response'),
    };
  }
  const out: RequestOutcome = { kind: 'forward' };
  if (v.method !== undefined) {
    if (typeof v.method !== 'string' || !HTTP_TOKEN.test(v.method) || v.method.toUpperCase() === 'CONNECT') {
      throw new Error(`request.method is invalid: ${JSON.stringify(v.method)}`);
    }
    out.method = v.method.toUpperCase();
  }
  if (v.url !== undefined) {
    let u: URL;
    try {
      u = new URL(String(v.url));
    } catch {
      throw new Error(`request.url is not a URL: ${JSON.stringify(v.url).slice(0, 200)}`);
    }
    if (typeof v.url !== 'string' || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new Error(`request.url must be http(s)://, got ${JSON.stringify(v.url).slice(0, 200)}`);
    out.url = u.href;
  }
  if (v.headers !== undefined) out.headers = scriptHeaders(v.headers, 'request');
  if (v.body !== undefined && v.body !== null) out.body = scriptBodyText(v.body, 'request');
  return out;
}

/** What onResponse asked for (fields absent = unchanged). Throws a readable message on an invalid value. */
export function readResponseResult(v: unknown): { status?: number; headers?: Record<string, string | string[]>; body?: string } {
  if (!isObject(v)) throw new Error(`onResponse must return an object or undefined, got ${Array.isArray(v) ? 'an array' : typeof v}`);
  return {
    ...(v.status !== undefined ? { status: scriptStatus(v.status, 'response') } : {}),
    ...(v.headers !== undefined ? { headers: scriptHeaders(v.headers, 'response') } : {}),
    ...(v.body !== undefined && v.body !== null ? { body: scriptBodyText(v.body, 'response') } : {}),
  };
}

/** Same header set, same order (a script that spread the input back changed nothing). */
export function sameHeaders(a: Record<string, string | string[]>, b: Record<string, string | string[]>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Build the hook inputs. */
export function scriptRequestOf(method: string, url: string, headers: Record<string, string | string[]>, body: Body | undefined): ScriptRequest {
  return { method, url, headers: { ...headers }, ...scriptBody(body) };
}

export function scriptResponseOf(status: number, headers: Record<string, string | string[]>, body: Body | undefined): ScriptResponse {
  return { status, headers: { ...headers }, ...scriptBody(body) };
}

/**
 * Could the script define onResponse? Decided from the source text when the request is routed (synchronously,
 * before anything runs): when it mentions `onResponse`, the response is buffered for the hook.
 */
export function mentionsOnResponse(code: unknown): boolean {
  return typeof code === 'string' && /\bonResponse\b/.test(code);
}
