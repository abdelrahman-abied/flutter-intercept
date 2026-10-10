/**
 * Auth-flow analysis (CONTRACTS §12.3). Pure: exchanges in, flows out.
 *
 * A flow is one token expiry: the 401 / 403 responses of requests sent with the old token, the refresh call(s)
 * that followed, and the retried request(s). The exchanges are replayed as a timeline of events (a response
 * arriving, a refresh starting / finishing, a request starting) so concurrent, interleaved traffic groups by the
 * expiry moment rather than by list order:
 *
 * - **unauthorized**: a 401 / 403 from a non-auth endpoint. It joins the open flow when the request was sent
 *   before that flow's token renewal (the first successful refresh finished) — the in-flight requests that all
 *   fail at once — or, while nothing has been renewed yet, when it ends within `refreshWindowMs` of the first
 *   401. Otherwise it starts a new flow.
 * - **refresh**: a GET / POST whose path has a segment matching /(refresh|token|oauth|auth)/i (not `author…`,
 *   not logout), a body carrying a refresh token (`grant_type=refresh_token`, `"refresh_token"`), or a GraphQL
 *   operation named like one, starting after the flow's first 401 and within `refreshWindowMs` of its last one.
 * - **retry**: a later request with the same method + URL + request body as one of the flow's 401s, started after
 *   that 401 arrived, once the flow has a refresh, within `retryWindowMs`.
 *
 * `stampede` = ≥ 2 refresh calls starting within `windowMs` (2 s) of the expiry (a plain Dio `Interceptor`
 * refreshing once per failed request instead of a `QueuedInterceptor` / shared refresh future). `problem` = no
 * refresh, a failed refresh, a request that was never retried after a successful refresh, or a retry that got
 * 401 / 403 again. A flow made only of 403s with no refresh is ordinary "forbidden", not an expiry: not reported.
 */
import type { Exchange } from '@flutter-intercept/proxy';
import { redactUrl } from '../agent/redact';
import { routeTemplate } from '../codegen/route';
import { requestBodyHash } from '../recordings/replay';
import type { AuthAnalysis, AuthFlow, AuthFlowStep } from './types';

export interface AuthAnalysisOptions {
  /** Refresh calls this close to the expiry count towards a stampede. Default 2000. */
  windowMs?: number;
  /** How long after a 401 a refresh call (or another 401, before any renewal) still belongs to it. Default 10 000. */
  refreshWindowMs?: number;
  /** How long after its 401 a request may be retried. Default 30 000. */
  retryWindowMs?: number;
}

export const STAMPEDE_WINDOW_MS = 2000;

const AUTH_WORD = /(refresh|token|oauth|auth)/i;
const NOT_AUTH_SEGMENT = /^(author|logout|log-out|signout|sign-out)/i;
const SESSION_SEGMENT = /^(login|log-in|signin|sign-in|signup|sign-up|register|sessions?|logout|log-out|signout|sign-out)$/i;
const REFRESH_BODY = /grant_type=refresh_token|"refresh_?token"\s*:|"refreshToken"\s*:/i;

function segments(url: string): string[] {
  let p = url;
  try {
    p = new URL(url).pathname;
  } catch {
    p = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/[?#].*$/s, '');
  }
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** A token refresh / re-auth call (see the module comment). */
export function isRefreshCall(e: Exchange): boolean {
  const m = e.method.toUpperCase();
  if (m !== 'POST' && m !== 'GET') return false;
  const segs = segments(e.url);
  if (segs.some((s) => /^(logout|log-out|signout|sign-out)$/i.test(s))) return false;
  if (segs.some((s) => !NOT_AUTH_SEGMENT.test(s) && AUTH_WORD.test(s))) return true;
  if (e.graphql?.operationName && /refresh|token/i.test(e.graphql.operationName)) return true;
  const body = e.requestBody?.encoding === 'utf8' ? e.requestBody.text : '';
  return body.length <= 64 * 1024 && REFRESH_BODY.test(body);
}

/** Refresh calls and session endpoints (login, logout, …): their 401s are not token expiries. */
export function isAuthEndpoint(e: Exchange): boolean {
  return isRefreshCall(e) || segments(e.url).some((s) => SESSION_SEGMENT.test(s));
}

const isUnauthorized = (e: Exchange) => e.status === 401 || e.status === 403;
const isOk = (e: Exchange) => typeof e.status === 'number' && e.status >= 200 && e.status < 300;

interface X {
  e: Exchange;
  start: number;
  end: number;
  key: string;
  order: number;
}

interface Episode {
  unauthorized: X[];
  refreshes: X[];
  retries: Map<X, X>; // unauthorized → its retry
  retryFailures: X[];
  firstEnd: number;
  lastActivity: number;
  renewedAt?: number;
  pending: Map<string, X[]>; // request key → unauthorized not yet retried
}

type EvKind = 'unauth' | 'refreshEnd' | 'refreshStart' | 'start';
const RANK: Record<EvKind, number> = { unauth: 0, refreshEnd: 1, refreshStart: 2, start: 3 };

interface Ev {
  t: number;
  rank: number;
  order: number;
  kind: EvKind;
  x: X;
}

function label(e: Exchange): string {
  let path = routeTemplate(e.url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '') || '/';
  path = redactUrl(path);
  return `${e.method.toUpperCase()} ${path}`;
}

function listOf(items: string[], max = 3): string {
  const uniq = [...new Set(items)];
  return uniq.length > max ? `${uniq.slice(0, max).join(', ')} and ${uniq.length - max} more` : uniq.join(', ');
}

const statusText = (e: Exchange) => (typeof e.status === 'number' ? `HTTP ${e.status}` : 'no response');

const ROLE_ORDER: Record<AuthFlowStep['role'], number> = { unauthorized: 0, refresh: 1, retry: 2, other: 3 };

function toFlow(ep: Episode, windowMs: number): AuthFlow | undefined {
  if (!ep.refreshes.length && ep.unauthorized.every((u) => u.e.status === 403)) return undefined;
  const steps: (AuthFlowStep & { order: number })[] = [
    ...ep.unauthorized.map((u) => ({ exchangeId: u.e.id, role: 'unauthorized' as const, at: u.end, order: u.order })),
    ...ep.refreshes.map((r) => ({ exchangeId: r.e.id, role: 'refresh' as const, at: r.start, order: r.order })),
    ...[...ep.retries.values()].map((r) => ({ exchangeId: r.e.id, role: 'retry' as const, at: r.start, order: r.order })),
  ];
  steps.sort((a, b) => a.at - b.at || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.order - b.order);
  const flow: AuthFlow = { steps: steps.map(({ exchangeId, role, at }) => ({ exchangeId, role, at })) };

  const early = ep.refreshes.filter((r) => r.start - ep.firstEnd <= windowMs).length;
  if (early >= 2) flow.stampede = { refreshCalls: early, windowMs };

  const problems: string[] = [];
  const first = ep.unauthorized[0].e;
  if (!ep.refreshes.length) {
    problems.push(`no refresh call followed the ${first.status} on ${label(first)}`);
  } else {
    const failed = ep.refreshes.filter((r) => !isOk(r.e));
    if (failed.length === ep.refreshes.length) {
      problems.push(`the refresh failed (${listOf(failed.map((r) => statusText(r.e)))})`);
    } else if (failed.length) {
      problems.push(`${failed.length} of ${ep.refreshes.length} refresh calls failed (${listOf(failed.map((r) => statusText(r.e)))})`);
    }
    if (ep.renewedAt !== undefined) {
      if (ep.retryFailures.length) {
        problems.push(`the retry of ${listOf(ep.retryFailures.map((r) => label(r.e)))} got ${listOf(ep.retryFailures.map((r) => String(r.e.status)))} again`);
      }
      const missing = ep.unauthorized.filter((u) => !ep.retries.has(u));
      if (missing.length) problems.push(`${listOf(missing.map((u) => label(u.e)))} ${missing.length === 1 ? 'was' : 'were'} not retried after the refresh`);
    }
  }
  if (problems.length) flow.problem = problems.join('; ');
  return flow;
}

/** Token-expiry flows in `exchanges` (any order), oldest first. */
export function analyzeAuth(exchanges: readonly Exchange[], opts: AuthAnalysisOptions = {}): AuthAnalysis {
  const windowMs = opts.windowMs ?? STAMPEDE_WINDOW_MS;
  const refreshWindowMs = opts.refreshWindowMs ?? 10_000;
  const retryWindowMs = opts.retryWindowMs ?? 30_000;

  const events: Ev[] = [];
  // REVIEW-6 #12: request bodies are hashed only for method + URL pairs that got a 401 / 403 (retry candidates).
  const unauthorizedTargets = new Set<string>();
  for (const e of exchanges) if (e && isUnauthorized(e)) unauthorizedTargets.add(`${e.method.toUpperCase()} ${e.url}`);
  let order = 0;
  for (const e of exchanges) {
    if (!e || e.kind || e.browserInternal || typeof e.startedAt !== 'number' || !Number.isFinite(e.startedAt)) continue;
    const dur = typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs > 0 ? e.durationMs : 0;
    const x: X = { e, start: e.startedAt, end: e.startedAt + dur, key: '', order: order++ };
    // a zero-length exchange's end must still come after its start
    const endRank = (k: EvKind) => RANK[k] + (dur > 0 ? 0 : 10);
    if (isRefreshCall(e)) {
      events.push({ t: x.start, rank: RANK.refreshStart, order: x.order, kind: 'refreshStart', x });
      if (e.status !== undefined || e.state === 'error' || e.state === 'aborted') events.push({ t: x.end, rank: endRank('refreshEnd'), order: x.order, kind: 'refreshEnd', x });
    } else if (!isAuthEndpoint(e)) {
      const target = `${e.method.toUpperCase()} ${e.url}`;
      x.key = unauthorizedTargets.has(target) ? `${target} ${requestBodyHash(e.requestBody) ?? ''}` : target;
      events.push({ t: x.start, rank: RANK.start, order: x.order, kind: 'start', x });
      if (isUnauthorized(e)) events.push({ t: x.end, rank: endRank('unauth'), order: x.order, kind: 'unauth', x });
    }
  }
  events.sort((a, b) => a.t - b.t || a.rank - b.rank || a.order - b.order);

  // Episodes are finalised after the whole timeline: a retry's own 401 may arrive after a newer expiry began.
  const episodes: Episode[] = [];
  const retryOf = new Map<X, Episode>();
  let ep: Episode | undefined;
  const close = () => {
    if (ep) episodes.push(ep);
    ep = undefined;
  };

  for (const ev of events) {
    const x = ev.x;
    switch (ev.kind) {
      case 'start': {
        if (!ep || !ep.refreshes.length) break;
        const q = ep.pending.get(x.key);
        const i = q ? q.findIndex((u) => u !== x && u.end <= x.start && x.start - u.end <= retryWindowMs) : -1;
        if (q && i !== -1) {
          const [u] = q.splice(i, 1);
          ep.retries.set(u, x);
          retryOf.set(x, ep);
          ep.lastActivity = Math.max(ep.lastActivity, x.start);
        }
        break;
      }
      case 'unauth': {
        const owner = retryOf.get(x);
        if (owner) {
          owner.retryFailures.push(x);
          owner.lastActivity = Math.max(owner.lastActivity, x.end);
          // a refresh → retry loop stays one flow: the next attempt is a retry of this one
          const q = owner.pending.get(x.key);
          if (q) q.push(x);
          else owner.pending.set(x.key, [x]);
          break;
        }
        const joins = ep && (ep.renewedAt !== undefined ? x.start < ep.renewedAt : x.end - ep.firstEnd <= refreshWindowMs);
        if (!ep || !joins) {
          close();
          ep = { unauthorized: [], refreshes: [], retries: new Map(), retryFailures: [], firstEnd: x.end, lastActivity: x.end, pending: new Map() };
        }
        const cur = ep!;
        cur.unauthorized.push(x);
        cur.lastActivity = Math.max(cur.lastActivity, x.end);
        const q = cur.pending.get(x.key);
        if (q) q.push(x);
        else cur.pending.set(x.key, [x]);
        break;
      }
      case 'refreshStart': {
        if (ep && x.start >= ep.firstEnd && x.start - ep.lastActivity <= refreshWindowMs) {
          ep.refreshes.push(x);
          ep.lastActivity = Math.max(ep.lastActivity, x.start);
        }
        break;
      }
      case 'refreshEnd': {
        if (ep && ep.refreshes.includes(x)) {
          if (isOk(x.e) && ep.renewedAt === undefined) ep.renewedAt = x.end;
          ep.lastActivity = Math.max(ep.lastActivity, x.end);
        }
        break;
      }
    }
  }
  close();
  const flows: AuthFlow[] = [];
  for (const e of episodes) {
    const f = toFlow(e, windowMs);
    if (f) flows.push(f);
  }
  return { flows };
}
