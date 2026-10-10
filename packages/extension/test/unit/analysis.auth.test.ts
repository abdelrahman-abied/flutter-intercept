import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { analyzeAuth, isAuthEndpoint, isRefreshCall } from '../../src/analysis/auth';

const API = 'https://api.example.com';
const T = 1_760_000_000_000;

/** One exchange: `at` / `end` in ms relative to T. */
function x(id: string, method: string, path: string, at: number, end: number, status: number | undefined, extra: Partial<Exchange> = {}): Exchange {
  return {
    id,
    startedAt: T + at,
    durationMs: end - at,
    method,
    url: path.startsWith('http') ? path : `${API}${path}`,
    requestHeaders: {},
    ...(status !== undefined ? { status } : {}),
    responseHeaders: {},
    state: status === undefined ? 'error' : 'completed',
    ...extra,
  };
}
const refresh = (id: string, at: number, end: number, status = 200) =>
  x(id, 'POST', '/auth/refresh', at, end, status, { requestBody: { text: '{"refresh_token":"r"}', encoding: 'utf8' } });

const roles = (f: { steps: { exchangeId: string; role: string }[] }) => f.steps.map((s) => `${s.role}:${s.exchangeId}`);

/**
 * Dio QueuedInterceptor done right: the screen fires three requests with an expired token; the first 401 makes the
 * interceptor refresh (others queue behind it), then each failed request is retried once with the new token.
 * Unrelated traffic (config, images) keeps flowing in between.
 */
const queuedTrace: Exchange[] = [
  x('cfg', 'GET', '/config', 0, 30, 200),
  x('me', 'GET', '/me', 5, 120, 401),
  x('feed', 'GET', '/feed?page=1', 6, 130, 401),
  x('notif', 'GET', '/notifications', 8, 140, 401),
  x('img', 'GET', 'https://cdn.example.com/a.png', 100, 400, 200),
  refresh('r1', 125, 380),
  x('me2', 'GET', '/me', 385, 470, 200),
  x('feed2', 'GET', '/feed?page=1', 386, 500, 200),
  x('notif2', 'GET', '/notifications', 387, 450, 200),
  x('later', 'GET', '/me', 5000, 5100, 200),
];

/**
 * A plain Dio `Interceptor`: every 401 starts its own refresh. The server rotates refresh tokens, so the second
 * and third refresh calls fail; the retries still succeed with the first new token.
 */
const stampedeTrace: Exchange[] = [
  x('me', 'GET', '/me', 0, 100, 401),
  x('feed', 'GET', '/feed', 2, 110, 401),
  x('notif', 'GET', '/notifications', 3, 115, 401),
  refresh('r1', 102, 300),
  refresh('r2', 112, 310, 401),
  refresh('r3', 117, 320, 401),
  x('me2', 'GET', '/me', 305, 400, 200),
  x('feed2', 'GET', '/feed', 312, 400, 200),
  x('notif2', 'GET', '/notifications', 322, 400, 200),
];

describe('classification', () => {
  it('recognises refresh calls and auth endpoints', () => {
    const r = (method: string, url: string, extra: Partial<Exchange> = {}) => isRefreshCall(x('a', method, url, 0, 1, 200, extra));
    expect(r('POST', '/auth/refresh')).toBe(true);
    expect(r('POST', '/oauth/token')).toBe(true);
    expect(r('POST', 'https://securetoken.googleapis.com/v1/token?key=k')).toBe(true);
    expect(r('POST', '/v1/accessToken')).toBe(true);
    expect(r('POST', '/session', { requestBody: { text: 'grant_type=refresh_token&refresh_token=x', encoding: 'utf8' } })).toBe(true);
    expect(r('POST', '/graphql', { graphql: { operationName: 'RefreshSession' } })).toBe(true);
    expect(r('GET', '/authors/1')).toBe(false);
    expect(r('POST', '/auth/logout')).toBe(false);
    expect(r('PUT', '/auth/refresh')).toBe(false);
    expect(r('GET', '/feed')).toBe(false);
    expect(isAuthEndpoint(x('a', 'POST', '/login', 0, 1, 401))).toBe(true);
    expect(isAuthEndpoint(x('a', 'GET', '/me', 0, 1, 401))).toBe(false);
  });
});

describe('analyzeAuth', () => {
  it('QueuedInterceptor: one expiry, one refresh, every request retried — no stampede, no problem', () => {
    const { flows } = analyzeAuth(queuedTrace);
    expect(flows).toHaveLength(1);
    const f = flows[0];
    expect(roles(f)).toEqual(['unauthorized:me', 'refresh:r1', 'unauthorized:feed', 'unauthorized:notif', 'retry:me2', 'retry:feed2', 'retry:notif2']);
    expect(f.steps[0].at).toBe(T + 120); // a 401 is placed when its response arrived
    expect(f.stampede).toBeUndefined();
    expect(f.problem).toBeUndefined();
  });

  it('is independent of the input order', () => {
    const shuffled = [...queuedTrace].reverse();
    expect(analyzeAuth(shuffled)).toEqual(analyzeAuth(queuedTrace));
  });

  it('plain Interceptor: three refresh calls for one expiry is a stampede; rotated refresh tokens fail', () => {
    const { flows } = analyzeAuth(stampedeTrace);
    expect(flows).toHaveLength(1);
    const f = flows[0];
    expect(f.stampede).toEqual({ refreshCalls: 3, windowMs: 2000 });
    expect(roles(f).filter((r) => r.startsWith('refresh'))).toEqual(['refresh:r1', 'refresh:r2', 'refresh:r3']);
    expect(roles(f).filter((r) => r.startsWith('retry'))).toEqual(['retry:me2', 'retry:feed2', 'retry:notif2']);
    expect(f.problem).toBe('2 of 3 refresh calls failed (HTTP 401)');
  });

  it('stampede counts only refresh calls within the window', () => {
    // refresh calls start 2, 12 and 17 ms after the first 401 arrived
    const { flows } = analyzeAuth(stampedeTrace, { windowMs: 15 });
    expect(flows[0].stampede).toEqual({ refreshCalls: 2, windowMs: 15 });
    expect(analyzeAuth(stampedeTrace, { windowMs: 5 }).flows[0].stampede).toBeUndefined();
  });

  it('the retry gets 401 again (interceptor did not update the header), and loops', () => {
    const { flows } = analyzeAuth([
      x('me', 'GET', '/me', 0, 100, 401),
      refresh('r1', 105, 200),
      x('me2', 'GET', '/me', 205, 300, 401),
      refresh('r2', 305, 400),
      x('me3', 'GET', '/me', 405, 500, 401),
    ]);
    expect(flows).toHaveLength(1);
    expect(roles(flows[0])).toEqual(['unauthorized:me', 'refresh:r1', 'retry:me2', 'refresh:r2', 'retry:me3']);
    expect(flows[0].problem).toBe('the retry of GET /me got 401 again');
  });

  it('the request is never retried after a successful refresh', () => {
    const { flows } = analyzeAuth([x('me', 'GET', '/me', 0, 100, 401), x('feed', 'GET', '/feed/42', 1, 100, 401), refresh('r1', 105, 200), x('me2', 'GET', '/me', 210, 300, 200)]);
    expect(flows[0].problem).toBe('GET /feed/{id} was not retried after the refresh');
  });

  it('no refresh at all after a 401', () => {
    const { flows } = analyzeAuth([x('me', 'GET', '/me', 0, 100, 401), x('other', 'GET', '/feed', 200, 300, 200)]);
    expect(flows).toHaveLength(1);
    expect(roles(flows[0])).toEqual(['unauthorized:me']);
    expect(flows[0].problem).toBe('no refresh call followed the 401 on GET /me');
  });

  it('a failed refresh is the problem (no complaint about missing retries: the app logs out)', () => {
    const { flows } = analyzeAuth([x('me', 'GET', '/me', 0, 100, 401), refresh('r1', 105, 200, 400), x('login', 'GET', '/login-screen-config', 300, 350, 200)]);
    expect(flows[0].problem).toBe('the refresh failed (HTTP 400)');
    const noResponse = analyzeAuth([x('me', 'GET', '/me', 0, 100, 401), x('r1', 'POST', '/oauth/token', 105, 5000, undefined)]);
    expect(noResponse.flows[0].problem).toBe('the refresh failed (no response)');
  });

  it('a 403 without a refresh is plain "forbidden", not a flow; 401s on login endpoints are not expiries', () => {
    expect(analyzeAuth([x('adm', 'GET', '/admin', 0, 50, 403)]).flows).toEqual([]);
    expect(analyzeAuth([x('login', 'POST', '/login', 0, 50, 401)]).flows).toEqual([]);
    const withRefresh = analyzeAuth([x('adm', 'GET', '/admin', 0, 50, 403), refresh('r1', 60, 100), x('adm2', 'GET', '/admin', 110, 150, 200)]);
    expect(roles(withRefresh.flows[0])).toEqual(['unauthorized:adm', 'refresh:r1', 'retry:adm2']);
  });

  it('a proactive refresh without a 401 is not a flow', () => {
    expect(analyzeAuth([refresh('r1', 0, 100), x('me', 'GET', '/me', 110, 200, 200)]).flows).toEqual([]);
  });

  it('separates two expiries an hour apart', () => {
    const hour = 3_600_000;
    const { flows } = analyzeAuth([
      ...queuedTrace,
      x('me-b', 'GET', '/me', hour, hour + 100, 401),
      refresh('r-b', hour + 105, hour + 200),
      x('me-b2', 'GET', '/me', hour + 205, hour + 300, 200),
    ]);
    expect(flows).toHaveLength(2);
    expect(roles(flows[1])).toEqual(['unauthorized:me-b', 'refresh:r-b', 'retry:me-b2']);
    expect(flows.every((f) => !f.problem && !f.stampede)).toBe(true);
  });

  it('a slow in-flight request sent with the old token joins the expiry even after the renewal', () => {
    const { flows } = analyzeAuth([
      x('me', 'GET', '/me', 0, 100, 401),
      x('upload', 'POST', '/upload', 50, 900, 401, { requestBody: { text: 'data', encoding: 'utf8' } }),
      refresh('r1', 105, 200),
      x('me2', 'GET', '/me', 205, 300, 200),
      x('upload2', 'POST', '/upload', 905, 1500, 200, { requestBody: { text: 'data', encoding: 'utf8' } }),
    ]);
    expect(flows).toHaveLength(1);
    expect(roles(flows[0])).toEqual(['unauthorized:me', 'refresh:r1', 'retry:me2', 'unauthorized:upload', 'retry:upload2']);
    expect(flows[0].problem).toBeUndefined();
  });

  it('a 401 for a request sent after the renewal starts a new flow; parallel duplicates are not retries', () => {
    const { flows } = analyzeAuth([
      x('a1', 'GET', '/me', 0, 100, 401),
      x('a1b', 'GET', '/me', 10, 105, 401), // two widgets asked for /me at once
      refresh('r1', 110, 200),
      x('a2', 'GET', '/me', 210, 300, 200),
      x('a2b', 'GET', '/me', 211, 300, 200),
      x('b1', 'GET', '/orders', 400, 450, 401), // the new token is already rejected
    ]);
    expect(flows).toHaveLength(2);
    expect(roles(flows[0])).toEqual(['unauthorized:a1', 'unauthorized:a1b', 'refresh:r1', 'retry:a2', 'retry:a2b']);
    expect(roles(flows[1])).toEqual(['unauthorized:b1']);
  });

  it('ignores WebSocket / SSE / browser-internal exchanges and bad times', () => {
    expect(
      analyzeAuth([
        x('ws', 'GET', '/socket', 0, 10, 401, { kind: 'websocket' }),
        x('bi', 'GET', '/x', 0, 10, 401, { browserInternal: true }),
        { ...x('nan', 'GET', '/me', 0, 10, 401), startedAt: Number.NaN },
      ]).flows,
    ).toEqual([]);
  });

  it('handles zero-length exchanges and large traces quickly', () => {
    const z = analyzeAuth([x('me', 'GET', '/me', 0, 0, 401), refresh('r1', 1, 1), x('me2', 'GET', '/me', 2, 2, 200)]);
    expect(roles(z.flows[0])).toEqual(['unauthorized:me', 'refresh:r1', 'retry:me2']);
    const big: Exchange[] = [];
    for (let i = 0; i < 2000; i++) {
      const t = i * 60_000;
      big.push(x(`u${i}`, 'GET', `/items/${i}`, t, t + 50, 401), refresh(`r${i}`, t + 55, t + 100), x(`v${i}`, 'GET', `/items/${i}`, t + 105, t + 150, 200));
      for (let j = 0; j < 20; j++) big.push(x(`n${i}-${j}`, 'GET', `/noise/${j}`, t + j, t + j + 30, 200));
    }
    const started = Date.now();
    const { flows } = analyzeAuth(big);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(flows).toHaveLength(2000);
    expect(flows.every((f) => f.steps.length === 3 && !f.problem)).toBe(true);
  });
});
