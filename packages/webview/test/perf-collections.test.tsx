// @vitest-environment happy-dom
// PERF-3 / §21.9: 2000 endpoints in one collection must filter (< 50 ms) and render without freezing.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterEndpoints } from '../src/collections';
import { driftedEndpoints, DRIFT_VIEW_LIMITS } from '../src/drift';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { CollectionEndpointView, CollectionStatus, HostMsg } from '../src/protocol';
import { status } from './fixtures';

let root: HTMLElement;
let listener: ((m: HostMsg) => void) | undefined;

const host: Host = {
  post: () => {},
  getState: <T,>() => ({ view: 'collections' }) as T,
  setState: () => {},
  onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const emit = async (...msgs: HostMsg[]) => {
  await act(async () => { for (const m of msgs) listener!(m); await tick(); });
};

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

function buildEndpoints(n: number): CollectionEndpointView[] {
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
  return Array.from({ length: n }, (_, i) => ({
    key: `${methods[i % methods.length]} https://api.shop.example/v1/r${Math.floor(i / 50)}/item_${i}`,
    method: methods[i % methods.length],
    name: `Operation ${i} ${i === 1999 ? 'needle-tail' : 'catalog'}`,
    folder: [`Group ${Math.floor(i / 50)}`],
    url: `https://api.shop.example/v1/r${Math.floor(i / 50)}/item_${i}`,
    examples: [
      { name: 'Success', status: 200 },
      { name: 'Not found', status: 404 },
    ],
  }));
}

const bigStatus: CollectionStatus = {
  id: 'big',
  overrides: 0,
  name: 'Big API',
  file: 'api/big.openapi.json',
  format: 'openapi',
  enabled: true,
  unmatched: 'passthrough',
  endpoints: 2000,
  mocked: 2000,
  noExample: 0,
  generated: 0,
  off: 0,
  unresolved: [],
  origins: ['https://api.shop.example'],
  problems: [],
};

function median(fn: () => void, runs = 7): number {
  fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)];
}

describe('collections at scale: 2000 endpoints (CONTRACTS §21.9)', () => {
  const endpoints = buildEndpoints(2000);

  it('filters 2000 endpoints in under 50 ms in happy-dom', () => {
    for (const q of ['', 'post', 'item_1999', 'needle-tail', 'delete r39 operation']) {
      const ms = median(() => {
        const res = filterEndpoints(endpoints, q);
        if (q === 'needle-tail') expect(res).toHaveLength(1);
        if (q === 'delete r39 operation') expect(res.length).toBeGreaterThan(0);
      });
      console.log(`[collections perf] filterEndpoints "${q}" (2000): ${ms.toFixed(2)} ms`);
      expect(ms, q).toBeLessThan(50);
    }
  });

  it('renders 2000 endpoints capped with Show more and filters smoothly on keystrokes (< 50 ms)', async () => {
    await act(() => { render(<App host={host} />, root); });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [bigStatus] } });
    await act(() => { root.querySelector<HTMLElement>('.collection-title-btn')!.click(); });

    const renderStart = performance.now();
    await emit({ type: 'collectionEndpoints', id: 'big', endpoints });
    const renderMs = performance.now() - renderStart;

    expect(root.querySelectorAll('.ep-item').length).toBe(100);
    const showMore = Array.from(root.querySelectorAll('button')).find((b) => /Show more/.test(b.textContent ?? ''))!;
    expect(showMore.textContent).toContain('1900 remaining');

    const input = root.querySelector<HTMLInputElement>('.collection-ep-filter')!;
    // Warm-up keystroke
    await act(() => { input.value = 'item_199'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    const filterStart = performance.now();
    await act(() => { input.value = 'needle-tail'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    const filterMs = performance.now() - filterStart;

    console.log(`[collections perf] initial 2000-endpoint capped render: ${renderMs.toFixed(1)} ms; UI filter keystroke: ${filterMs.toFixed(1)} ms`);
    expect(root.querySelectorAll('.ep-item').length).toBe(1);
    expect(root.querySelector('.ep-item')!.textContent).toContain('Operation 1999 needle-tail');
    expect(filterMs).toBeLessThan(50);

    // Clear filter and expand via Show more
    await act(() => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(root.querySelectorAll('.ep-item').length).toBe(100);
    await act(() => {
      const more = Array.from(root.querySelectorAll('button')).find((b) => /Show more/.test(b.textContent ?? ''))!;
      more.click();
    });
    expect(root.querySelectorAll('.ep-item').length).toBe(300);
  });
});

// CONTRACTS §23.3 / §24.2: every one of 2000 endpoints out of date (20 changes each) with examples chosen by the
// request's body — the rows stay capped, the "Out of date" list shows 20 endpoints, and opening it stays quick.
describe('2000 endpoints, all out of date (CONTRACTS §23.3)', () => {
  const endpoints: CollectionEndpointView[] = buildEndpoints(2000).map((ep) => ({
    ...ep,
    examples: [
      { name: 'Success', status: 200 },
      { name: 'Refused', status: 403, byBody: ['role', 'tenant', 'region', 'plan'] },
    ],
    drift: [{
      endpoint: ep.key, status: 200, samples: 5, since: 1_700_000_000_000,
      changes: Array.from({ length: 20 }, (_, j) => ({ kind: 'added' as const, path: `data.items[].field${j}`, to: 'string' })),
    }],
  }));
  const staleStatus: CollectionStatus = { ...bigStatus, drift: { endpoints: 2000, line: 'GET /v1/r0/item_0 now has data.items[].field0 (and 39999 more)' } };

  it('finds the out-of-date endpoints of 2000 in under 20 ms', () => {
    const ms = median(() => { expect(driftedEndpoints(endpoints)).toHaveLength(2000); });
    console.log(`[collections perf] driftedEndpoints (2000 × 20 changes): ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
  });

  it('rows and the "Out of date" list render capped; opening the list < 50 ms', async () => {
    await act(() => { render(<App host={host} />, root); });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [staleStatus] } });
    await act(() => { root.querySelector<HTMLElement>('.collection-title-btn')!.click(); });
    const t0 = performance.now();
    await emit({ type: 'collectionEndpoints', id: 'big', endpoints });
    const renderMs = performance.now() - t0;
    expect(root.querySelectorAll('.ep-item').length).toBe(100);
    expect(root.querySelectorAll('.ep-drift').length).toBe(100);
    expect(root.querySelectorAll('.ep-by-body').length).toBe(100);
    // closed by default: no change is rendered until asked for
    expect(root.querySelectorAll('.ood').length).toBe(0);

    const toggle = root.querySelector<HTMLElement>('.collection-drift > .link')!;
    const t1 = performance.now();
    await act(() => { toggle.click(); });
    const openMs = performance.now() - t1;
    expect(root.querySelectorAll('.ood-items > li').length).toBe(DRIFT_VIEW_LIMITS.endpoints);
    expect(root.querySelectorAll('.ood-changes li').length).toBe(DRIFT_VIEW_LIMITS.endpoints * DRIFT_VIEW_LIMITS.changes);
    expect(root.querySelector('.ood-foot')!.textContent).toContain('and 1980 more');
    console.log(`[collections perf] 2000 out-of-date endpoints: capped render ${renderMs.toFixed(1)} ms; opening "Out of date" ${openMs.toFixed(1)} ms`);
    expect(openMs).toBeLessThan(50);
  });
});
