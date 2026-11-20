// A flow module of InterceptProxy (QUALITY-1 Q1): the `handler` action (CONTRACTS §22.1, stateful mocks). The host
// registers a function per handler id; a matching request is answered with what it computes.

import type { HeaderBag } from './body';
import { HANDLER_TIMEOUT_DEFAULT_MS, HANDLER_TIMEOUT_MAX_MS } from './rules';
import { scriptBodyText, scriptHeaders, scriptStatus } from './script';
import { flattenLine, sleep } from './proxy-util';
import type { Body, Exchange, HandlerRequest, HandlerResponse, RequestHandler } from './types';
import type { CallbackRequestResult, Flow, HandlerAction } from './flow-types';
import type { ProxyContext } from './proxy-context';

/** At most this many handler calls wait for an answer at once; more are answered 503. */
export const HANDLER_MAX_IN_FLIGHT = 256;
/** A handler's `delayMs` is at most this. */
export const HANDLER_DELAY_MAX_MS = 60_000;
/** A handler's `note` (one line) and an error message are at most this many characters. */
const LINE_MAX_CHARS = 300;
/** `Exchange.simulated` of an answer the handler computed. */
export const STATEFUL_MOCK_LABEL = 'Stateful mock';

/** Tests only: a smaller in-flight cap. */
export const handlerTesting: { maxInFlight?: number } = {};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One line (no control or bidi characters: flattenLine), at most `max` characters. */
function oneLine(text: string, max = LINE_MAX_CHARS): string {
  const t = flattenLine(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The rule's timeout: an integer 1–60 000 ms, else the default (setRules refuses invalid ones anyway). */
export function handlerTimeoutMs(a: HandlerAction): number {
  const t = a.timeoutMs;
  return Number.isInteger(t) && (t as number) >= 1 && (t as number) <= HANDLER_TIMEOUT_MAX_MS ? (t as number) : HANDLER_TIMEOUT_DEFAULT_MS;
}

/**
 * A handler's answer, validated like a script's `respond` (status 100–599, header names / values, body ≤ 5 MB) plus
 * `delayMs` 0–60 000. `note` is made one line ≤ 300 characters (a long note never fails the request). Throws a readable
 * message. What only the wire refuses (a 1xx status, header text outside Latin-1) fails when answered (`localAnswer`).
 */
export function readHandlerResult(v: unknown): Required<Pick<HandlerResponse, 'status' | 'body'>> & {
  headers: Record<string, string | string[]>;
  delayMs: number;
  note?: string;
} {
  if (!isObject(v)) throw new Error(`the answer must be an object or undefined, got ${v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v}`);
  const status = scriptStatus(v.status, 'answer');
  const headers = v.headers === undefined ? {} : scriptHeaders(v.headers, 'answer');
  const body = v.body === undefined || v.body === null ? '' : scriptBodyText(v.body, 'answer');
  let delayMs = 0;
  if (v.delayMs !== undefined) {
    const d = v.delayMs;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d > HANDLER_DELAY_MAX_MS) {
      throw new Error(`answer.delayMs must be a number 0–${HANDLER_DELAY_MAX_MS}, got ${JSON.stringify(d)}`);
    }
    delayMs = Math.round(d);
  }
  let note: string | undefined;
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== 'string') throw new Error('answer.note must be text');
    note = oneLine(v.note) || undefined;
  }
  return { status, headers, body, delayMs, ...(note ? { note } : {}) };
}

/**
 * CONTRACTS §24 (amends §22.1): a handler may return this instead of an answer → the rule's `fallback` example is
 * answered quietly (no "had no answer" note; `note`, made one line ≤ 300 characters, is added when given). A rule
 * without a fallback → 502, as for `undefined`.
 */
export type { HandlerFallback } from './types';

/**
 * The quiet-fallback request (`{ fallback: true, note? }`) with its note made one line, or undefined when `v` is not one
 * (`fallback` absent or not `true`: read as an answer). A non-text note throws, as on an answer.
 */
export function readHandlerFallback(v: unknown): { note?: string } | undefined {
  if (!isObject(v) || v.fallback !== true) return undefined;
  if (v.note === undefined || v.note === null) return {};
  if (typeof v.note !== 'string') throw new Error('answer.note must be text');
  const note = oneLine(v.note);
  return note ? { note } : {};
}

/** What a call ended with. */
type Outcome = { kind: 'value'; value: unknown } | { kind: 'error'; message: string } | { kind: 'aborted' };

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** Copies, so a handler changing its input can't change the recorded exchange. */
function headersCopy(h: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}

export class HandlerFlow {
  private readonly handlers = new Map<string, RequestHandler>();
  /** Calls waiting for their handler, by exchange id: aborted when the app leaves or the proxy stops. */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly px: ProxyContext) {}

  /** Registers (fn) or removes (undefined). */
  set(id: string, fn: RequestHandler | undefined): void {
    if (typeof id !== 'string') return;
    if (typeof fn === 'function') this.handlers.set(id, fn);
    else this.handlers.delete(id);
  }

  /** Number of registered handlers (tests / status). */
  get size(): number {
    return this.handlers.size;
  }

  /** stop(): every handler removed, every waiting call's signal aborted. */
  clear(): void {
    this.handlers.clear();
    for (const c of [...this.inFlight.values()]) c.abort(new Error('Proxy stopped'));
    this.inFlight.clear();
  }

  /** The app closed the connection: the waiting call's signal aborts (its result is dropped). */
  clientGone(exchangeId: string): void {
    this.inFlight.get(exchangeId)?.abort(new Error('The app closed the connection'));
  }

  /** onRequest for a `handler` rule. The exchange is not tracked yet. */
  async answer(ex: Exchange, flow: Flow, action: HandlerAction, body: Body | undefined): Promise<CallbackRequestResult> {
    const ruleId = flow.rule?.id ?? '';
    const failure = (message: string) => ({ response: this.px.edits.localFailure(ex, oneLine(`Handler ${ruleId}: ${message}`)) });
    ex.simulated = STATEFUL_MOCK_LABEL;
    this.px.book.track(ex, flow);
    const fn = this.handlers.get(action.handlerId);
    if (!fn) return this.fallback(ex, ruleId, action, 'No stateful mock is running for this rule; answered from the example.', failure, 'no stateful mock is registered');

    const cap = handlerTesting.maxInFlight ?? HANDLER_MAX_IN_FLIGHT;
    if (this.inFlight.size >= cap) {
      this.px.book.addNote(ex, `More than ${cap} stateful mock answers were in flight; answered 503 (try again).`);
      const error = oneLine(`Handler ${ruleId}: busy (more than ${cap} answers in flight)`);
      return { response: this.px.edits.localFailure(ex, error, 503, { 'retry-after': '1' }) };
    }

    const input: HandlerRequest = {
      exchangeId: ex.id,
      ruleId,
      method: ex.method,
      url: ex.url,
      headers: headersCopy(ex.requestHeaders),
      ...(body ? { body: { ...body } } : {}),
    };
    const timeoutMs = handlerTimeoutMs(action);
    const ctrl = new AbortController();
    this.inFlight.set(ex.id, ctrl);
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let outcome: Outcome;
    try {
      const aborted = new Promise<Outcome>((resolve) => {
        ctrl.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
        timer = setTimeout(() => {
          timedOut = true;
          ctrl.abort(new Error(`timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref?.();
      });
      let called: unknown;
      try {
        called = fn(input, ctrl.signal);
      } catch (e) {
        called = Promise.reject(e);
      }
      const settled = Promise.resolve(called).then(
        (value): Outcome => ({ kind: 'value', value }),
        (e): Outcome => ({ kind: 'error', message: messageOf(e) }),
      );
      outcome = await Promise.race([settled, aborted]);
    } finally {
      clearTimeout(timer);
      if (this.inFlight.get(ex.id) === ctrl) this.inFlight.delete(ex.id);
    }

    // The app left (or the proxy stopped): the result is dropped (what the host changed stands, like a real server).
    if (this.px.book.live.get(ex.id)?.ex !== ex || ex.state !== 'pending') return { response: 'close' };
    if (outcome.kind === 'aborted') {
      if (timedOut) return failure(`timed out after ${timeoutMs} ms`);
      return { response: 'close' };
    }
    if (outcome.kind === 'error') return failure(outcome.message);
    if (outcome.value === undefined) {
      return this.fallback(ex, ruleId, action, 'The stateful mock had no answer; answered from the example.', failure, 'no answer, and the rule has no example to fall back to');
    }
    let quiet: { note?: string } | undefined;
    try {
      quiet = readHandlerFallback(outcome.value);
    } catch (e) {
      return failure((e as Error).message);
    }
    if (quiet) return this.fallback(ex, ruleId, action, quiet.note, failure, 'asked for the example, and the rule has no example to fall back to');
    let answer: ReturnType<typeof readHandlerResult>;
    try {
      answer = readHandlerResult(outcome.value);
    } catch (e) {
      return failure((e as Error).message);
    }
    if (answer.note) this.px.book.addNote(ex, answer.note);
    if (!(await this.delay(ex, answer.delayMs))) return { response: 'close' };
    const failed = (why: string) => oneLine(`Handler ${ruleId}: answer ${why}`);
    return { response: await this.px.edits.localAnswer(ex, answer.status, { ...answer.headers } as HeaderBag, answer.body, failed) };
  }

  /** The rule's `fallback` mock (with the note, when there is one), or a 502 without one. */
  private async fallback(
    ex: Exchange,
    ruleId: string,
    action: HandlerAction,
    note: string | undefined,
    failure: (message: string) => CallbackRequestResult,
    missing: string,
  ): Promise<CallbackRequestResult> {
    const fb = action.fallback;
    if (!fb || typeof fb !== 'object') return failure(missing);
    delete ex.simulated; // the example, as a plain mock (0.15 behaviour)
    if (note) this.px.book.addNote(ex, note);
    if (!(await this.delay(ex, fb.delayMs ?? 0))) return { response: 'close' };
    const failed = (why: string) => oneLine(`Handler ${ruleId}: fallback ${why}`);
    return { response: await this.px.edits.localAnswer(ex, fb.status, { ...(fb.headers ?? {}) }, fb.body ?? '', failed) };
  }

  /** Waits `ms` (counted as delayMs); false when the app left meanwhile. */
  private async delay(ex: Exchange, ms: number): Promise<boolean> {
    if (!(ms > 0)) return true;
    const from = performance.now();
    await sleep(ms);
    this.px.book.addPhase(ex, 'delayMs', performance.now() - from);
    return this.px.book.live.get(ex.id)?.ex === ex && ex.state === 'pending';
  }
}
