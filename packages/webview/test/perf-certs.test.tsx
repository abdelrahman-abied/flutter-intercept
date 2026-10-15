// @vitest-environment happy-dom
// PERF-2 (CONTRACTS §20.3): the client certificates / learned hosts list, its status line items and the banner, with
// large lists (up to the proxy's 1000 learned hosts and 50 certificates). Machine-independent budgets: ratios against
// small lists and DOM structure, not absolute times.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { Exchange, HostMsg, Status } from '../src/protocol';
import { status } from './fixtures';

let root: HTMLElement;
let listener: ((m: HostMsg) => void) | undefined;
const host: Host = {
  post: () => {}, getState: () => undefined, setState: () => {},
  onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const emit = async (m: HostMsg) => { await act(async () => { listener!(m); await tick(); }); };

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const T0 = Date.now();
function traffic(n: number): Exchange[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `x${i}`, startedAt: T0 - (n - i) * 10, durationMs: 20, state: 'completed' as const, method: 'GET',
    url: `https://api.shop.example.com/v1/products/${i}`, requestHeaders: { accept: 'application/json' }, status: 200,
    responseHeaders: { 'content-type': 'application/json' }, responseBody: { text: `{"id":${i}}`, encoding: 'utf8' as const },
  }));
}
function withLists(learned: number, certs: number): Status {
  return {
    ...status,
    learnedPassthrough: Array.from({ length: learned }, (_, i) => (i % 3 === 0
      ? { host: `pinned${i}.example.com`, port: 443, reason: 'pinned' as const, until: T0 + 600_000 }
      : { host: `mtls${i}.example.com`, port: i % 2 ? 443 : 8443, reason: 'client-certificate' as const })),
    clientCertificates: Array.from({ length: certs }, (_, i) => ({ host: `*.c${i}.example.com`, ...(i % 7 === 0 ? { problem: 'wrong passphrase' } : {}) })),
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('client certificates and learned hosts at scale (PERF-2)', () => {
  it('an exchange update costs the same with 1000 learned hosts and 50 certificates in Status', async () => {
    const updateCost = async (st: Status) => {
      await act(() => { render(<App host={host} />, root); });
      await emit({ type: 'snapshot', exchanges: traffic(1000), rules: [], status: st });
      const times: number[] = [];
      for (let i = 0; i < 15; i++) {
        const s = performance.now();
        await emit({ type: 'exchange', exchange: { ...traffic(1)[0], id: `new${i}`, startedAt: T0 + i } });
        times.push(performance.now() - s);
      }
      render(null, root);
      return median(times);
    };
    await updateCost(withLists(0, 0)); // warm-up
    const a = await updateCost(withLists(0, 0));
    const b = await updateCost(withLists(1000, 50));
    console.log(`[certs perf] exchange update: empty lists ${a.toFixed(2)} ms, 1000 learned + 50 certs ${b.toFixed(2)} ms`);
    expect(b / Math.max(a, 0.5)).toBeLessThan(2);
  });

  it('the open list renders linearly (≤ 15× for 10× the rows), and so does a Status update (or its clock tick) while open', async () => {
    const open = async (learned: number, certs: number) => {
      await act(() => { render(<App host={host} />, root); });
      await emit({ type: 'snapshot', exchanges: [], rules: [], status: withLists(learned, certs) });
      const s = performance.now();
      await act(() => { root.querySelector<HTMLElement>('.statusline .certs-toggle')!.click(); });
      const ms = performance.now() - s;
      const rows = root.querySelectorAll('.certs-panel li').length;
      // A status re-broadcast with the same lists (the host sends one on every learnedPassthrough event); the list's
      // once-a-second clock (pinned entries count down) costs the same re-render.
      const s2 = performance.now();
      await emit({ type: 'status', status: withLists(learned, certs) });
      const statusMs = performance.now() - s2;
      render(null, root);
      return { ms, rows, statusMs };
    };
    await open(20, 5);
    const a = [await open(20, 5), await open(20, 5), await open(20, 5)].sort((x, y) => x.ms - y.ms)[1];
    const b = [await open(200, 50), await open(200, 50), await open(200, 50)].sort((x, y) => x.ms - y.ms)[1];
    const c = [await open(1000, 50), await open(1000, 50), await open(1000, 50)].sort((x, y) => x.ms - y.ms)[1];
    console.log(`[certs perf] open list: 20+5 ${a.ms.toFixed(1)} ms (${a.rows} rows), 200+50 ${b.ms.toFixed(1)} ms (${b.rows} rows), 1000+50 ${c.ms.toFixed(1)} ms (${c.rows} rows); status re-render ${a.statusMs.toFixed(1)} / ${b.statusMs.toFixed(1)} / ${c.statusMs.toFixed(1)} ms`);
    expect(b.rows).toBe(250);
    expect(c.rows).toBe(1050);
    expect(b.ms / Math.max(a.ms, 1)).toBeLessThan(15);
    expect(b.statusMs / Math.max(a.statusMs, 1)).toBeLessThan(15);
  });
});
