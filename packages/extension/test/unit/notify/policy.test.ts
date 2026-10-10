import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { createNotifyPolicy, describeOutcome, describeRequest, isExcluded, isFailure, normalizeLevel } from '../../../src/notify/policy';

let seq = 0;
function ex(over: Partial<Exchange> = {}): Exchange {
  return {
    id: `n${++seq}`,
    startedAt: 0,
    method: 'GET',
    url: 'https://api.example.com/users/42?token=abc',
    requestHeaders: {},
    status: 500,
    state: 'completed',
    ...over,
  };
}

describe('what counts', () => {
  it.each<[string, Partial<Exchange>, boolean]>([
    ['a real 500', {}, false],
    ['an editor send', { initiator: 'editor' }, true],
    ['an agent send', { initiator: 'agent' }, true],
    ['browser-internal', { browserInternal: true }, true],
    ['a mock', { state: 'mocked', matchedRuleId: 'r1' }, true],
    ['a block', { state: 'blocked', status: 403, matchedRuleId: 'r1' }, true],
    ['a replay', { state: 'mocked', simulated: 'Replayed from login' }, true],
    ['a scripted local answer', { state: 'mocked', matchedRuleId: 'r2', scriptLog: ['hi'] }, true],
    ['a fault rule', { state: 'error', status: undefined, simulated: 'Fault: connection reset' }, true],
    ['a timeout fault', { state: 'error', status: undefined, simulated: 'Fault: timeout (reset after 30 s)' }, true],
    ['a throttle drop', { state: 'error', status: undefined, simulated: 'Slow 3G: dropped' }, true],
    ['offline', { state: 'error', status: undefined, simulated: 'Offline' }, true],
    ['replay fail', { state: 'error', status: undefined, simulated: 'Not in the recording "x" (replay: fail)' }, true],
    ['a rewrite that set the status', { simulated: 'Rewritten: status 503, response body' }, true],
    ['a real error under a throttle', { state: 'error', status: undefined, simulated: 'Slow 3G' }, false],
    ['a real 500 through Map Remote', { simulated: 'Mapped to http://localhost:3000' }, false],
    ['a real 500 with a rewritten request header', { simulated: 'Rewritten: request headers' }, false],
    ['a vm-profile capture', { captured: 'vm-profile' }, false],
  ])('%s → excluded=%s', (_label, over, excluded) => expect(isExcluded(ex(over))).toBe(excluded));

  it('failures per level', () => {
    expect(isFailure(ex({ status: 500 }), 'errors')).toBe(true);
    expect(isFailure(ex({ status: 503 }), 'all')).toBe(true);
    expect(isFailure(ex({ status: 404 }), 'errors')).toBe(false);
    expect(isFailure(ex({ status: 404 }), 'all')).toBe(true);
    expect(isFailure(ex({ status: 302 }), 'all')).toBe(false);
    expect(isFailure(ex({ state: 'error', status: undefined }), 'errors')).toBe(true);
    expect(isFailure(ex({ status: 500 }), 'off')).toBe(false);
  });

  it('normalizes the setting', () => {
    expect(normalizeLevel('all')).toBe('all');
    expect(normalizeLevel('off')).toBe('off');
    expect(normalizeLevel(undefined)).toBe('errors');
    expect(normalizeLevel('loud')).toBe('errors');
  });
});

describe('text', () => {
  it('method + path only (no host, no query), reason phrase', () => {
    expect(describeRequest(ex())).toBe('GET /users/42');
    expect(describeOutcome(ex())).toBe('500 Internal Server Error');
    expect(describeOutcome(ex({ status: 599 }))).toBe('599');
  });

  it('credential path segments are redacted; GraphQL operation named', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
    expect(describeRequest(ex({ url: `https://x.dev/reset/${jwt}` }))).toBe('GET /reset/[redacted]');
    expect(describeRequest(ex({ method: 'post', url: 'https://x.dev/graphql', graphql: { operationName: 'GetUser' } }))).toBe('POST /graphql (GetUser)');
  });

  it('errors: URLs lose their query, credentials are redacted, long messages are cut', () => {
    const e = ex({ state: 'error', status: undefined, error: 'SocketException: Connection refused, uri = https://api.example.com/users/42?token=s3cr3t' });
    const text = describeOutcome(e);
    expect(text).toBe('SocketException: Connection refused, uri = https://api.example.com/users/42');
    expect(describeOutcome(ex({ state: 'error', status: undefined, error: 'Bearer abcdefghijklmnop1234 rejected' }))).toBe('Bearer [redacted] rejected');
    expect(describeOutcome(ex({ state: 'error', status: undefined, error: 'x'.repeat(500) }))).toHaveLength(120);
    expect(describeOutcome(ex({ state: 'error', status: undefined }))).toBe('error');
  });
});

describe('REVIEW-7 #2: no Markdown links from untrusted text', () => {
  const noLink = (t: string) => {
    expect(t).not.toContain('](');
    expect(t.replace(/\[redacted\]/g, '')).not.toMatch(/[[\]`\\]/);
  };

  it('a notification for `/[x](command:foo)` contains no `](`', () => {
    const p = createNotifyPolicy({ level: 'errors' });
    const n = p.onExchange(ex({ url: 'https://evil.example/[x](command:foo)' }), 0, false)!;
    noLink(n.text);
    expect(n.text).toBe('GET /%5Bx%5D%28command:foo%29 failed: 500 Internal Server Error');
  });

  it.each([
    'https://evil.example/[Details](file:///Users/me/.aws/credentials)',
    'https://evil.example/Session%20expired.%20[Sign_in_again](command:workbench.action.reloadWindow)',
    'https://evil.example/a%5Bb%5D%28c%29/%60code%60/back%5Cslash',
    'https://evil.example/[eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl](command:foo)',
  ])('path %s', (url) => noLink(createNotifyPolicy({ level: 'errors' }).onExchange(ex({ url }), 0, false)!.text));

  it('GraphQL operation names', () => {
    const n = createNotifyPolicy({ level: 'errors' }).onExchange(ex({ url: 'https://x.dev/graphql', graphql: { operationName: '[Open](command:git.push)`x`\\' } }), 0, false)!;
    noLink(n.text);
    expect(n.text).toContain('(［Open］（command:git.push）ˋxˋ⧵)');
  });

  it('error messages (single and grouped notices)', () => {
    const p = createNotifyPolicy({ level: 'errors', windowMs: 10_000 });
    const bad = (msg: string) => ex({ state: 'error', status: undefined, error: msg });
    const first = p.onExchange(bad('Server says: [Sign in again](command:workbench.action.reloadWindow)'), 0, false)!;
    noLink(first.text);
    expect(first.text).toContain('［Sign in again］（command:workbench.action.reloadWindow）');
    p.onExchange(bad('x'), 1, false);
    p.onExchange(bad('see [docs](https://evil.example) `a` \\ b'), 2, false);
    noLink(p.flush(10_000, false)!.text);
  });
});

describe('createNotifyPolicy', () => {
  it('one failure → a notice right away, naming the exchange', () => {
    const p = createNotifyPolicy({ level: 'errors' });
    const e = ex();
    expect(p.onExchange(e, 1000, false)).toEqual({ text: 'GET /users/42 failed: 500 Internal Server Error', exchangeId: e.id, count: 1 });
  });

  it('each exchange once, and only when it reaches a final state', () => {
    const p = createNotifyPolicy({ level: 'errors', windowMs: 0 });
    const e = ex({ state: 'pending', status: undefined });
    expect(p.onExchange(e, 1, false)).toBeUndefined();
    expect(p.onExchange({ ...e, state: 'paused-response', status: 500 }, 2, false)).toBeUndefined();
    expect(p.onExchange({ ...e, state: 'completed', status: 500 }, 3, false)?.count).toBe(1);
    expect(p.onExchange({ ...e, state: 'completed', status: 500 }, 4, false)).toBeUndefined();
    // a success that is updated later never becomes a failure notice
    const ok = ex({ status: 200 });
    expect(p.onExchange(ok, 5, false)).toBeUndefined();
    expect(p.onExchange({ ...ok, status: 500 }, 6, false)).toBeUndefined();
  });

  it('groups failures inside the window into the next flush', () => {
    const p = createNotifyPolicy({ level: 'errors', windowMs: 10_000 });
    expect(p.onExchange(ex(), 0, false)?.count).toBe(1);
    expect(p.nextFlushAt()).toBeUndefined();
    expect(p.onExchange(ex({ url: 'https://a.dev/a' }), 1000, false)).toBeUndefined();
    expect(p.onExchange(ex({ url: 'https://a.dev/b' }), 2000, false)).toBeUndefined();
    const last = ex({ url: 'https://a.dev/users/7', status: 502 });
    expect(p.onExchange(last, 3000, false)).toBeUndefined();
    expect(p.nextFlushAt()).toBe(10_000);
    expect(p.flush(9_999, false)).toBeUndefined();
    expect(p.flush(10_000, false)).toEqual({ text: '3 requests failed — latest: GET /users/7 → 502 Bad Gateway', exchangeId: last.id, count: 3 });
    expect(p.flush(30_000, false)).toBeUndefined();
    expect(p.nextFlushAt()).toBeUndefined();
    // the flush opened a new window
    expect(p.onExchange(ex(), 15_000, false)).toBeUndefined();
    expect(p.flush(20_000, false)?.count).toBe(1);
  });

  it('a failure after the window has passed is merged with the waiting ones and shown at once', () => {
    const p = createNotifyPolicy({ level: 'errors', windowMs: 10_000 });
    p.onExchange(ex(), 0, false);
    p.onExchange(ex(), 5_000, false);
    expect(p.onExchange(ex(), 12_000, false)?.count).toBe(2);
  });

  it('a single grouped failure reads like a single one', () => {
    const p = createNotifyPolicy({ level: 'errors', windowMs: 10_000 });
    p.onExchange(ex(), 0, false);
    p.onExchange(ex({ url: 'https://a.dev/x', status: 503 }), 1, false);
    expect(p.flush(10_000, false)?.text).toBe('GET /x failed: 503 Service Unavailable');
  });

  it('suppressed while the panel is visible (not queued either)', () => {
    const p = createNotifyPolicy({ level: 'errors', windowMs: 10_000 });
    expect(p.onExchange(ex(), 0, true)).toBeUndefined();
    expect(p.flush(20_000, false)).toBeUndefined();
    // queued while hidden, then the panel shows: the group is dropped
    p.onExchange(ex(), 20_000, false);
    p.onExchange(ex(), 21_000, false);
    expect(p.flush(30_000, true)).toBeUndefined();
    expect(p.flush(40_000, false)).toBeUndefined();
    // a failure while visible drops the waiting group too
    p.onExchange(ex(), 41_000, false);
    p.onExchange(ex(), 42_000, false);
    p.onExchange(ex(), 43_000, true);
    expect(p.flush(60_000, false)).toBeUndefined();
  });

  it('levels: off shows nothing, all adds 4xx, setLevel applies (off drops the waiting group)', () => {
    const p = createNotifyPolicy({ level: 'off' });
    expect(p.onExchange(ex(), 0, false)).toBeUndefined();
    p.setLevel('errors');
    expect(p.onExchange(ex({ status: 404 }), 0, false)).toBeUndefined();
    p.setLevel('all');
    expect(p.onExchange(ex({ status: 404 }), 0, false)?.text).toBe('GET /users/42 failed: 404 Not Found');
    p.onExchange(ex({ status: 401 }), 1, false);
    p.setLevel('off');
    expect(p.flush(60_000, false)).toBeUndefined();
  });

  it('excluded traffic is ignored', () => {
    const p = createNotifyPolicy({ level: 'all' });
    expect(p.onExchange(ex({ state: 'mocked', matchedRuleId: 'r' }), 0, false)).toBeUndefined();
    expect(p.onExchange(ex({ initiator: 'agent' }), 0, false)).toBeUndefined();
    expect(p.onExchange(ex({ state: 'error', status: undefined, simulated: 'Fault: DNS failure' }), 0, false)).toBeUndefined();
    expect(p.onExchange(ex(), 0, false)?.count).toBe(1);
  });
});
