/**
 * Agent tools: assert (QUALITY-1 Q5: split out of api.ts). Each handler gets the shared AgentViews and its parsed input.
 */
import type { Exchange } from '@flutter-intercept/proxy';
import { compileMatcher } from '@flutter-intercept/proxy/rules';
import { pathError, select } from '../paths';
import { redactUrl } from '../redact';
import { GRPC_CODE_NAMES, grpcCodeName } from '../../grpc/service';
import { decodeJson, FINAL_STATES, redactJsonValue } from '../samples';
import { ToolInput, TRIGGER_WINDOW_MS } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import { MAX_ASSERT_FAILURES, MAX_JSON_FAILURES_PER_EXCHANGE, insideRedacted, statusMatches, jsonType, typeMatches, describeValue, jsonEqual } from '../shared';
import type { StatusFilter } from '../shared';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';

/** assert_traffic's default `sinceMs`: the latest launch/restart if within TRIGGER_WINDOW_MS, else all recorded traffic. */
export function assertSince(ag: AgentViews): number {
  return ag.lastTriggerAt !== undefined && ag.now() - ag.lastTriggerAt <= TRIGGER_WINDOW_MS ? ag.lastTriggerAt : 0;
}


/**
 * Waits (event-driven, at most withinMs) until the count/presence/order expectations can hold, then evaluates
 * every expectation once. With an upper bound (count.max / exact) the whole window is observed, unless it is
 * already exceeded. Never hangs: a timer always settles it; cancellation rejects.
 */
export function assertTraffic(ag: AgentViews, i: ToolInput<'assert_traffic'>, signal?: AbortSignal): Promise<ToolResult> {
  const x = i.expect;
  const c = x.count;
  if (c) {
    if (c.exact !== undefined && (c.min !== undefined || c.max !== undefined)) throw new AgentToolError('expect.count: use exact alone, or min and/or max', 'invalid');
    if (c.min !== undefined && c.max !== undefined && c.min > c.max) throw new AgentToolError('expect.count: min is greater than max', 'invalid');
  }
  (x.json ?? []).forEach((a, n) => {
    const bad = pathError(a.path);
    if (bad) throw new AgentToolError(`expect.json[${n}]: ${bad}`, 'invalid');
    if (a.exists === false && (a.equals !== undefined || a.type !== undefined)) throw new AgentToolError(`expect.json[${n}]: exists:false cannot be combined with equals or type`, 'invalid');
  });
  const since = i.sinceMs ?? assertSince(ag);
  // Compiled once per call (REVIEW-4 #11), matched against the agent's view of the URL (#1).
  const keep = ag.filter({ url: i.url, method: i.method, sinceMs: since, includeBrowserInternal: i.includeBrowserInternal, kind: i.kind });
  const order = x.order?.map((glob) => ({ glob, test: compileMatcher({ url: glob }) }));
  const internal = i.includeBrowserInternal === true;
  const upper = c?.exact ?? c?.max;
  const need = c ? (c.exact ?? c.min ?? 0) : 1;
  const start = ag.now();
  const count = () => ag.deps.host.getExchanges().filter((e) => FINAL_STATES.has(e.state) && keep(e)).length;
  const ready = (): boolean => {
    const n = count();
    if (upper !== undefined) return n > upper; // exceeded: no point waiting
    return n >= need && (!order || orderFailure(ag, order, since, internal) === undefined);
  };
  const evaluate = () => evaluateAssert(ag, i, since, Math.max(0, ag.now() - start), keep, order);
  if (signal?.aborted) return Promise.reject(new AgentToolError('assert_traffic was cancelled', 'state'));
  if (i.withinMs === 0) return Promise.resolve().then(evaluate);

  return new Promise<ToolResult>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      ag.deps.host.off('exchange', onExchange);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const settle = () =>
      finish(() => {
        try {
          resolve(evaluate());
        } catch (e) {
          reject(e);
        }
      });
    const onExchange = (e: Exchange) => {
      if (FINAL_STATES.has(e.state) && ready()) settle();
    };
    const onAbort = () => finish(() => reject(new AgentToolError('assert_traffic was cancelled', 'state')));
    ag.deps.host.on('exchange', onExchange);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(settle, i.withinMs);
    if (ready()) settle();
  });
}


/** Why `order` does not hold among the finished exchanges since `since`, or undefined when it does. */
export function orderFailure(ag: AgentViews, order: { glob: string; test: (method: string, url: string) => boolean }[], since: number, includeBrowserInternal = false): string | undefined {
  const done = ag.deps.host
    .getExchanges()
    .filter((e) => FINAL_STATES.has(e.state) && e.startedAt >= since && (includeBrowserInternal || !e.browserInternal))
    .sort((a, b) => a.startedAt - b.startedAt);
  let after = -Infinity;
  let prev: string | undefined;
  const view = ag.redact ? redactUrl : (u: string) => u;
  for (const { glob, test } of order) {
    const hit = done.find((e) => e.startedAt > after && test(e.method, view(e.url)));
    if (!hit) return `order: no request matching ${JSON.stringify(glob)} ${prev !== undefined ? `started after the one matching ${JSON.stringify(prev)}` : 'was recorded'}`;
    after = hit.startedAt;
    prev = glob;
  }
  return undefined;
}


export function evaluateAssert(ag: AgentViews, 
  i: ToolInput<'assert_traffic'>,
  since: number,
  waitedMs: number,
  keep: (e: Exchange) => boolean,
  order: { glob: string; test: (method: string, url: string) => boolean }[] | undefined,
): ToolResult {
  const x = i.expect;
  const all = ag.deps.host.getExchanges();
  const m = all.filter((e) => FINAL_STATES.has(e.state) && keep(e)).sort((a, b) => a.startedAt - b.startedAt);
  const inFlight = all.filter((e) => !FINAL_STATES.has(e.state) && keep(e)).length;
  const failures: string[] = [];
  const label = (e: Exchange) => `${e.id} (${e.method} ${ag.url(e.url)})`;
  const what = `${i.method ? `${i.method.toUpperCase()} ` : ''}${i.url}`;
  const flight = inFlight ? ` (${inFlight} more still in flight)` : '';
  const sinceText = since > 0 ? ` since ${new Date(since).toISOString()}` : '';

  const c = x.count;
  const n = m.length;
  if (c) {
    if (c.exact !== undefined && n !== c.exact) failures.push(`count: expected exactly ${c.exact} request(s) matching ${what}${sinceText}, got ${n}${flight}`);
    if (c.min !== undefined && n < c.min) failures.push(`count: expected at least ${c.min} request(s) matching ${what}${sinceText}, got ${n}${flight}`);
    if (c.max !== undefined && n > c.max) failures.push(`count: expected at most ${c.max} request(s) matching ${what}${sinceText}, got ${n}`);
  } else if (!n) failures.push(`no finished request matched ${what}${sinceText}${flight}`);

  if (order) {
    const why = orderFailure(ag, order, since, i.includeBrowserInternal === true);
    if (why) failures.push(why);
  }
  for (const e of m) {
    if (x.status !== undefined && !statusMatches(e, x.status as StatusFilter)) {
      failures.push(`${label(e)}: ${e.status !== undefined ? `status ${e.status}` : `no status (state ${e.state})`}, expected ${x.status}`);
    }
    if (x.maxDurationMs !== undefined && !(e.durationMs !== undefined && e.durationMs <= x.maxDurationMs)) {
      failures.push(`${label(e)}: ${e.durationMs !== undefined ? `took ${e.durationMs} ms` : 'duration unknown'}, expected at most ${x.maxDurationMs} ms`);
    }
    if (x.json?.length) jsonFailures(ag, e, x.json, label(e), failures);
    if (x.grpcStatus !== undefined) {
      const want = typeof x.grpcStatus === 'string' ? GRPC_CODE_NAMES.indexOf(x.grpcStatus as (typeof GRPC_CODE_NAMES)[number]) : x.grpcStatus;
      const wantText = `${want} (${grpcCodeName(want)})`;
      if (e.kind !== 'grpc') failures.push(`${label(e)}: not a gRPC call (kind ${e.kind ?? 'http'}), expected gRPC status ${wantText}`);
      else if (e.grpc?.statusCode !== want) {
        const got = e.grpc?.statusCode;
        failures.push(`${label(e)}: ${got !== undefined ? `gRPC status ${got} (${grpcCodeName(got)})` : `no gRPC status (state ${e.state})`}, expected ${wantText}`);
      }
    }
    if (failures.length > MAX_ASSERT_FAILURES) break;
  }
  const extra = failures.length - MAX_ASSERT_FAILURES;
  const shown = extra > 0 ? [...failures.slice(0, MAX_ASSERT_FAILURES), `… and more failures (stopped after ${MAX_ASSERT_FAILURES})`] : failures;
  return {
    pass: failures.length === 0,
    matched: n,
    ids: m.slice(-20).map((e) => e.id),
    ...(inFlight ? { inFlight } : {}),
    sinceMs: since,
    ...(i.withinMs ? { waitedMs } : {}),
    failures: shown,
  };
}


/**
 * json assertions on one exchange (REVIEW-4 #7/#8). With redaction on, EVERY assertion is evaluated on the
 * redacted view (what get_request shows: a sensitive field is just the string "[redacted]"), and a path that
 * goes below a sensitive key fails with "is inside a redacted field" without being evaluated. So neither the
 * pass/fail nor the texts reveal values, keys or counts under a redacted field. Failure texts carry paths,
 * types and sizes, never values. At most MAX_JSON_FAILURES_PER_EXCHANGE texts per exchange.
 */
export function jsonFailures(ag: AgentViews, e: Exchange, asserts: NonNullable<ToolInput<'assert_traffic'>['expect']['json']>, label: string, out: string[]): void {
  const d = decodeJson(e.responseBody);
  if (!d.ok) {
    out.push(`${label}: cannot check JSON paths: ${e.responseBody ? `the response ${d.reason.replace(/^the body/, 'body')}` : 'no response body'}`);
    return;
  }
  const root = ag.redact ? redactJsonValue(d.value) : d.value;
  let left = MAX_JSON_FAILURES_PER_EXCHANGE;
  const push = (text: string): boolean => {
    if (left <= 0) return false;
    left--;
    out.push(left === 0 ? `${text} (further JSON failures of ${e.id} omitted)` : text);
    return left > 0;
  };
  const sel = (p: string) => {
    try {
      return select(root, p);
    } catch (err) {
      throw new AgentToolError(`invalid JSON path ${JSON.stringify(p)}: ${(err as Error)?.message ?? String(err)}`, 'invalid');
    }
  };
  for (const a of asserts) {
    if (left <= 0) return;
    if (ag.redact && insideRedacted(a.path)) {
      push(`${label}: ${a.path} is inside a redacted field (secrets cannot be asserted; check the field itself with exists)`);
      continue;
    }
    const got = sel(a.path);
    const exists = a.exists ?? (a.equals === undefined && a.type === undefined ? true : undefined);
    if (exists === false) {
      if (got.length) push(`${label}: ${a.path} is present (${got.length} value${got.length === 1 ? '' : 's'}), expected it to be absent`);
      continue;
    }
    if (!got.length) {
      push(`${label}: ${a.path} not found${a.type ? ` (expected ${a.type})` : a.equals !== undefined ? ' (expected a value)' : ''}`);
      continue;
    }
    if (a.type) {
      for (const s of got) if (!typeMatches(s.value, a.type) && !push(`${label}: ${s.path} is ${jsonType(s.value)}, expected ${a.type}`)) return;
    }
    if (a.equals !== undefined) {
      for (const s of got) if (!jsonEqual(s.value, a.equals) && !push(`${label}: ${s.path} does not equal the expected value (it is ${describeValue(s.value)})`)) return;
    }
  }
}

export const assertTools: ToolHandlers = {
  assert_traffic: (ag, i, signal) => assertTraffic(ag, i, signal),
};
