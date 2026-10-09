// 420 MB down and up through the proxy must not grow RSS by anything near the body size.
// (Before the fix: +847 MB for the download, +383 MB for the upload; see docs/spikes/proxy.md.)
import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InterceptProxy } from '../src';
import { settled, startProxy } from './helpers';

const MB = 1024 * 1024;
const SIZE = 420 * MB;
const LIMIT_MB = 150; // generous: allocator noise; a buffered body alone would be 420+
const chunk = Buffer.alloc(MB, 'x');

let origin: http.Server;
let base: string;
let proxy: InterceptProxy;

function pumpTo(w: http.ServerResponse | http.ClientRequest, size: number, end: () => void) {
  let left = size;
  const pump = () => {
    while (left > 0) {
      const n = Math.min(left, chunk.length);
      left -= n;
      if (!w.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void w.once('drain', pump);
    }
    end();
  };
  pump();
}

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    if (req.url?.startsWith('/download')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': SIZE });
      pumpTo(res, SIZE, () => res.end());
    } else {
      let n = 0;
      req.on('data', (d: Buffer) => (n += d.length));
      req.on('end', () => res.end(String(n)));
    }
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  proxy = await startProxy();
});
afterAll(async () => {
  await proxy.stop();
  origin.closeAllConnections();
  await new Promise((r) => origin.close(r));
});

async function peakRssGrowth(fn: () => Promise<void>): Promise<number> {
  await new Promise((r) => setTimeout(r, 50));
  const start = process.memoryUsage().rss;
  let peak = start;
  const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 10);
  await fn();
  clearInterval(t);
  return (Math.max(peak, process.memoryUsage().rss) - start) / MB;
}

const get = (port: number | undefined, url: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const opts = port ? { host: '127.0.0.1', port, path: url, headers: { host: u.host } } : url;
    http
      .get(opts as http.RequestOptions, (res) => {
        let n = 0;
        res.on('data', (d: Buffer) => (n += d.length));
        res.on('end', () => resolve(n));
      })
      .on('error', reject);
  });

const post = (port: number, url: string) =>
  new Promise<string>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: url, headers: { host: u.host, 'content-length': SIZE } },
      (res) => {
        let t = '';
        res.on('data', (d) => (t += d));
        res.on('end', () => resolve(t));
      },
    );
    req.on('error', reject);
    pumpTo(req, SIZE, () => req.end());
  });

describe('bounded memory for large pass-through bodies', () => {
  it('warm-up reference: direct download without the proxy', async () => {
    expect(await get(undefined, `${base}/download`)).toBe(SIZE);
  }, 60_000);

  it(`420 MB download through the proxy: RSS growth < ${LIMIT_MB} MB, 5 MB preview recorded`, async () => {
    let bytes = 0;
    const growth = await peakRssGrowth(async () => {
      bytes = await get(proxy.port, `${base}/download`);
    });
    expect(bytes).toBe(SIZE);
    console.log(`[memory] download peak RSS growth ${growth.toFixed(1)} MB`);
    expect(growth).toBeLessThan(LIMIT_MB);
    const [ex] = (await settled(proxy)).slice(-1);
    expect(ex).toMatchObject({ state: 'completed', responseBody: { truncated: true } });
  }, 60_000);

  it(`420 MB upload through the proxy: RSS growth < ${LIMIT_MB} MB`, async () => {
    let text = '';
    const growth = await peakRssGrowth(async () => {
      text = await post(proxy.port, `${base}/upload`);
    });
    expect(text).toBe(String(SIZE));
    console.log(`[memory] upload peak RSS growth ${growth.toFixed(1)} MB`);
    expect(growth).toBeLessThan(LIMIT_MB);
  }, 60_000);
});
