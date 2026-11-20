// @vitest-environment happy-dom
// CONTRACTS §22.13: the Data view of a 5 000-record resource renders capped (first page only), the first render of
// the Data view stays < 30 ms, and filtering (a keystroke, then the host's answer) stays < 50 ms.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { CollectionStatus, HostMsg, StoreResourceView, ViewMsg } from '../src/protocol';
import { storeColumns, STORE_VIEW_LIMITS } from '../src/store';
import { status } from './fixtures';

let root: HTMLElement;
let listener: ((m: HostMsg) => void) | undefined;
let posted: ViewMsg[] = [];

const host: Host = {
  post: (m) => { posted.push(m); },
  getState: <T,>() => ({ view: 'collections' }) as T,
  setState: () => {},
  onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const emit = async (...msgs: HostMsg[]) => {
  await act(async () => { for (const m of msgs) listener!(m); await tick(); });
};
const click = async (el: Element) => { await act(() => { (el as HTMLElement).click(); }); };
const button = (label: string | RegExp) =>
  Array.from(root.querySelectorAll('button')).find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')))!;

beforeEach(() => {
  posted = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const resources: StoreResourceView[] = Array.from({ length: 100 }, (_, i) => ({
  name: i === 0 ? 'users' : `resource${i}`, path: `/r${i}/:id`, idField: 'id', count: i === 0 ? 5000 : i,
  remembers: i % 7 !== 0 || i === 0, detected: true, ...(i % 11 === 0 ? { overridden: true as const } : {}),
}));
const big: CollectionStatus = {
  id: 'big', overrides: 0, name: 'Big API', file: 'api/big.openapi.json', format: 'openapi', enabled: true,
  unmatched: 'passthrough', endpoints: 400, mocked: 400, noExample: 0, generated: 0, off: 0, unresolved: [],
  origins: ['https://api.shop.example'], problems: [],
  store: { enabled: true, resources, snapshots: ['a', 'b'], changed: true, problems: [] },
};
const records = Array.from({ length: 5000 }, (_, i) => ({
  id: i + 1, name: `User ${i + 1}`, email: `user${i + 1}@example.com`, active: i % 2 === 0, score: i * 1.5,
  address: { city: 'London', zip: `${i}` }, tags: ['a', 'b'], createdAt: '2026-11-20T10:00:00Z', note: 'n'.repeat(200),
  extra1: 1, extra2: 2, extra3: 3,
}));

describe('remembered data at scale (CONTRACTS §22.13)', () => {
  it('columns for 5 000 records look at the first 50 only', () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) storeColumns(records, 'id');
    const ms = (performance.now() - t0) / 20;
    expect(storeColumns(records, 'id')).toHaveLength(STORE_VIEW_LIMITS.columns);
    expect(ms).toBeLessThan(2);
  });

  it('Data view first render < 30 ms; 5 000 records render capped; filtering < 50 ms', async () => {
    await act(() => { render(<App host={host} />, root); });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, collections: [big] } });
    await click(root.querySelector('.collection-title-btn')!);

    // warm-up (the first Data render compiles the component paths), then the median of five
    await click(button('Data'));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      await click(button('Requests'));
      const t0 = performance.now();
      await click(button('Data'));
      times.push(performance.now() - t0);
    }
    const dataMs = times.sort((a, b) => a - b)[2];
    expect(root.querySelectorAll('.store-res')).toHaveLength(100);

    await click(root.querySelector('[aria-label="Show the users records"]')!);
    const t1 = performance.now();
    await emit({ type: 'storeItems', id: 'big', resource: 'users', offset: 0, total: 5000, items: records });
    const tableMs = performance.now() - t1;
    expect(root.querySelectorAll('.store-table tbody tr')).toHaveLength(STORE_VIEW_LIMITS.rows);
    expect(root.querySelectorAll('.store-table thead th')).toHaveLength(STORE_VIEW_LIMITS.columns + 1);
    expect(button(/Show more/).textContent).toContain('4950 more');

    const input = root.querySelector<HTMLInputElement>('.store-filter')!;
    await act(() => { input.value = 'user4'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    const t2 = performance.now();
    await act(() => { input.value = 'user49'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    const keyMs = performance.now() - t2;

    await act(async () => { await tick(STORE_VIEW_LIMITS.filterDebounceMs + 50); });
    expect(posted.filter((m) => m.type === 'getStoreItems').at(-1)).toEqual({ type: 'getStoreItems', id: 'big', resource: 'users', offset: 0, filter: 'user49' });
    const matching = records.filter((r) => r.email.startsWith('user49'));
    const t3 = performance.now();
    await emit({ type: 'storeItems', id: 'big', resource: 'users', offset: 0, total: matching.length, items: matching });
    const answerMs = performance.now() - t3;
    expect(root.querySelectorAll('.store-table tbody tr')).toHaveLength(STORE_VIEW_LIMITS.rows);

    console.log(`[store perf] Data view ${dataMs.toFixed(1)} ms (100 resources); 5000-record table ${tableMs.toFixed(1)} ms; `
      + `filter keystroke ${keyMs.toFixed(1)} ms; filtered answer ${answerMs.toFixed(1)} ms`);
    expect(dataMs).toBeLessThan(30);
    expect(tableMs).toBeLessThan(50);
    expect(keyMs).toBeLessThan(50);
    expect(answerMs).toBeLessThan(50);
  });
});
