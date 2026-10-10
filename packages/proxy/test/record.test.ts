// record() / update() (CONTRACTS §11.4): read-only exchanges from outside the proxy (native clients read from
// the app's HTTP profile): stored, evictable, emitted, never routed or matched against rules.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy } from '../src';
import { settled, startProxy, startUpstream, viaProxy, type Upstream } from './helpers';

let up: Upstream;
let proxy: InterceptProxy;
beforeAll(async () => {
  up = await startUpstream();
});
afterAll(async () => {
  await up.close();
});
beforeEach(async () => {
  proxy = await startProxy();
});
afterEach(async () => {
  await proxy.stop();
});

const native = (o: Partial<Exchange> = {}): Omit<Exchange, 'id'> => ({
  startedAt: 1_700_000_000_000,
  method: 'GET',
  url: 'https://api.example.com/native',
  requestHeaders: { 'user-agent': 'cupertino_http' },
  state: 'pending',
  ...o,
});

describe('record / update', () => {
  it('stores and emits a vm-profile record, then updates it', async () => {
    const events: Exchange[] = [];
    proxy.on('exchange', (e) => events.push(e));
    const id = proxy.record(native());
    expect(id).toMatch(/^rec-/);
    expect(events.at(-1)).toMatchObject({ id, captured: 'vm-profile', state: 'pending', url: 'https://api.example.com/native' });
    expect(proxy.update(id, { state: 'completed', status: 200, durationMs: 42, responseBody: { text: '{"a":1}', encoding: 'utf8' } })).toBe(true);
    expect(events.at(-1)).toMatchObject({ id, state: 'completed', status: 200, durationMs: 42, captured: 'vm-profile', responseBody: { text: '{"a":1}' } });
    // undefined removes a field; id can't change
    expect(proxy.update(id, { durationMs: undefined, id: 'other' } as Partial<Exchange>)).toBe(true);
    const stored = proxy.getExchanges().find((e) => e.id === id)!;
    expect(stored.durationMs).toBeUndefined();
    expect(proxy.getExchanges().find((e) => e.id === 'other')).toBeUndefined();
  });

  it('caps bodies and frames, copies headers', () => {
    const headers = { a: ['1', '2'] };
    const id = proxy.record(
      native({
        requestHeaders: headers,
        responseBody: { text: 'x'.repeat(6 * 1024 * 1024), encoding: 'utf8' },
        frames: Array.from({ length: 600 }, (_, i) => ({ dir: 'receive' as const, at: i, kind: 'text' as const, text: `f${i}`, size: 2 })),
      }),
    );
    headers.a.push('3');
    const ex = proxy.getExchanges().find((e) => e.id === id)!;
    expect(ex.requestHeaders.a).toEqual(['1', '2']);
    expect(ex.responseBody).toMatchObject({ truncated: true });
    expect(ex.responseBody!.text).toHaveLength(5 * 1024 * 1024);
    expect(ex.frames).toHaveLength(500);
    expect(ex.frames![0].text).toBe('f100');
    expect(ex.framesDropped).toBe(100);
  });

  it('records are evictable (ring buffer) and update() on an evicted / unknown / proxy id is a no-op', async () => {
    await proxy.stop();
    proxy = await startProxy({ maxExchanges: 2 });
    const removed: string[] = [];
    proxy.on('removed', (ids) => removed.push(...ids));
    const a = proxy.record(native({ state: 'completed' }));
    proxy.record(native());
    proxy.record(native());
    expect(removed).toEqual([a]);
    expect(proxy.update(a, { status: 1 })).toBe(false);
    expect(proxy.update('nope', { status: 1 })).toBe(false);
    await viaProxy(proxy.port, `${up.httpUrl}/json`);
    const [real] = (await settled(proxy)).filter((e) => !e.captured);
    expect(proxy.update(real.id, { status: 999 })).toBe(false); // proxy-owned exchanges are not editable
  });

  it('rules never apply to records and they are never CORS-diagnosed', () => {
    proxy.setRules([{ id: 'b', enabled: true, times: 1, match: { url: '*' }, action: { kind: 'block', mode: 'status' } }]);
    let hits = 0;
    proxy.on('rule-hit', () => hits++);
    const id = proxy.record(native({ requestHeaders: { origin: 'http://localhost:5000' }, status: 200, responseHeaders: {}, state: 'completed' }));
    const ex = proxy.getExchanges().find((e) => e.id === id)!;
    expect(ex.matchedRuleId).toBeUndefined();
    expect(ex.cors).toBeUndefined();
    expect(hits).toBe(0);
  });

  it('rejects records without method / url', () => {
    expect(() => proxy.record({ url: 'x' } as Omit<Exchange, 'id'>)).toThrow(/method and url/);
  });
});
