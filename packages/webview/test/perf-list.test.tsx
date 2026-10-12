// @vitest-environment happy-dom
// QUALITY-1 / PERF-1: the traffic list at 10 000 exchanges. Machine-independent budgets — ratios against 1 000 and DOM
// structure — instead of absolute times: filtering is linear (≤ 20× for 10× the rows), and the virtualised list renders
// the same number of rows whatever the history size (render time within 4× of 1 000).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, HostMsg } from '../src/protocol';
import { EMPTY_FILTERS, filterExchanges } from '../src/state';
import { status } from './fixtures';

let root: HTMLElement;
let listener: ((m: HostMsg) => void) | undefined;
const host: Host = {
  post: () => {}, getState: () => undefined, setState: () => {},
  onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const T0 = 1_700_000_000_000;
/** A realistic mix: JSON GET/POST, some errors, some gRPC calls. */
function traffic(n: number): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i < n; i++) {
    const grpc = i % 10 === 0;
    out.push({
      id: `x${i}`, startedAt: T0 + i * 7, durationMs: 20 + (i % 50), state: i % 97 === 0 ? 'error' : 'completed',
      method: grpc || i % 3 === 0 ? 'POST' : 'GET',
      url: grpc ? `http://10.0.2.2:50051/shop.v1.Catalog/Get${i % 13}` : `https://api.shop.example.com/v1/products/${i}?page=${i % 9}`,
      requestHeaders: { accept: 'application/json', 'x-request-id': `r-${i}` },
      status: i % 97 === 0 ? undefined : i % 11 === 0 ? 500 : 200,
      responseHeaders: { 'content-type': grpc ? 'application/grpc' : 'application/json' },
      responseBody: grpc ? undefined : { text: `{"id":${i},"name":"product ${i}","tags":["a","b"]${i % 50 === 0 ? ',"needle":true' : ''}}`, encoding: 'utf8' },
      ...(grpc ? { kind: 'grpc' as const, grpc: { service: 'shop.v1.Catalog', method: `Get${i % 13}`, statusCode: i % 20 === 0 ? 14 : 0, messagesSent: 1, messagesReceived: 1 } } : {}),
    });
  }
  return out;
}

/** Median of `runs` timings of `fn` (after one warm-up run). */
function median(fn: () => void, runs = 7): number {
  fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return Math.max(t[Math.floor(runs / 2)], 0.05); // floor: sub-50 µs timings are noise
}

describe('traffic list at 10 000 exchanges (PERF-1)', () => {
  const small = traffic(1000);
  const large = traffic(10_000);
  const filters = ['', 'products', 'm:POST s:5xx', 'body:needle', 't:grpc grpc:unavailable', '-page=3 h:x-request-id'];

  it('filtering is linear: ≤ 20× the 1 000-row time for 10× the rows, for every filter shape', () => {
    for (const text of filters) {
      const f = { ...EMPTY_FILTERS, text };
      const a = median(() => filterExchanges(small, f));
      const b = median(() => filterExchanges(large, f));
      console.log(`[list perf] filter "${text}": 1k ${a.toFixed(2)} ms, 10k ${b.toFixed(2)} ms (×${(b / a).toFixed(1)})`);
      expect(b / a, text).toBeLessThan(20);
    }
  });

  it('render is virtualised: the same rows in the DOM, and a snapshot of 10 000 renders within 4× of 1 000', async () => {
    const renderSnapshot = async (list: Exchange[]) => {
      await act(() => { render(<App host={host} />, root); });
      const s = performance.now();
      await act(async () => { listener!({ type: 'snapshot', exchanges: list, rules: [], status }); await tick(); });
      const ms = performance.now() - s;
      const rows = root.querySelectorAll('.row').length;
      render(null, root);
      return { ms, rows };
    };
    await renderSnapshot(small); // warm-up (JIT, module init)
    const a = [await renderSnapshot(small), await renderSnapshot(small), await renderSnapshot(small)].sort((x, y) => x.ms - y.ms)[1];
    const b = [await renderSnapshot(large), await renderSnapshot(large), await renderSnapshot(large)].sort((x, y) => x.ms - y.ms)[1];
    console.log(`[list perf] snapshot render: 1k ${a.ms.toFixed(1)} ms (${a.rows} rows), 10k ${b.ms.toFixed(1)} ms (${b.rows} rows)`);
    expect(b.rows).toBe(a.rows);
    expect(b.rows).toBeLessThan(80);
    expect(b.ms / Math.max(a.ms, 1)).toBeLessThan(4);
  });

  it('typing in the filter box at 10 000 rows: within 20× of 1 000', async () => {
    const typeAt = async (list: Exchange[]) => {
      await act(() => { render(<App host={host} />, root); });
      await act(async () => { listener!({ type: 'snapshot', exchanges: list, rules: [], status }); await tick(); });
      const input = root.querySelector('input.filter-text') as HTMLInputElement;
      const times: number[] = [];
      for (const v of ['p', 'pr', 'products', 'products m:POST', 'products m:POST s:5xx']) {
        const s = performance.now();
        await act(() => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); });
        times.push(performance.now() - s);
      }
      render(null, root);
      return times.sort((x, y) => x - y)[2];
    };
    await typeAt(small);
    const a = await typeAt(small);
    const b = await typeAt(large);
    console.log(`[list perf] keystroke: 1k ${a.toFixed(1)} ms, 10k ${b.toFixed(1)} ms`);
    expect(b / Math.max(a, 1)).toBeLessThan(20);
  });
});
