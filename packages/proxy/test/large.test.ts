// Large bodies (over the 5 MB display cap / pause limits): the app must still get every byte,
// and breakpoints have explicit limits with a clear outcome above them.
import * as http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InterceptProxy, Rule } from '../src';
import { inState, nextExchange, settled, startProxy, startUpstream, viaProxy, type Upstream } from './helpers';

const MB = 1024 * 1024;
const BIG = 40 * MB;
let up: Upstream;
let proxy: InterceptProxy;

const bp = (phase: 'request' | 'response', url: string): Rule => ({
  id: `bp-${phase}`,
  enabled: true,
  match: { url },
  action: { kind: 'breakpoint', phase },
});

beforeAll(async () => {
  up = await startUpstream();
  proxy = await startProxy();
});
afterAll(async () => {
  await proxy.stop();
  await up.close();
});
beforeEach(() => {
  proxy.setRules([]);
  proxy.clear();
});

describe('large bodies', () => {
  it('plain pass-through: full download, recorded as truncated 5 MB preview', async () => {
    const r = await viaProxy(proxy.port, `${up.httpUrl}/big?size=${BIG}`);
    expect(r.body.length).toBe(BIG);
    const [ex] = (await settled(proxy)).slice(-1);
    expect(ex.state).toBe('completed');
    expect(ex.responseBody?.truncated).toBe(true);
    expect(ex.responseBody?.text.length).toBe(5 * MB);
  });

  it('plain pass-through: full upload, request preview truncated', async () => {
    const r = await viaProxy(proxy.port, `${up.httpUrl}/count`, { method: 'POST', body: Buffer.alloc(BIG, 'u') });
    expect(r.text).toBe(String(BIG));
    const [ex] = (await settled(proxy)).slice(-1);
    expect(ex.requestBody?.truncated).toBe(true);
    expect(ex.requestBody?.text.length).toBe(5 * MB);
  });

  it('request breakpoint + body over 5 MB: skipped with a note, full upload reaches the server', async () => {
    proxy.setRules([bp('request', '*/count')]);
    const r = await viaProxy(proxy.port, `${up.httpUrl}/count`, { method: 'POST', body: Buffer.alloc(BIG, 'u') });
    expect(r.text).toBe(String(BIG));
    const [ex] = (await settled(proxy)).slice(-1);
    expect(ex).toMatchObject({ state: 'completed', matchedRuleId: 'bp-request' });
    expect(ex.error).toMatch(/Breakpoint skipped.*over the 5 MB pause limit/);
  });

  it('request breakpoint + streamed (chunked) body: skipped with a note', async () => {
    proxy.setRules([bp('request', '*/count')]);
    const u = new URL(`${up.httpUrl}/count`);
    const text = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: u.href, headers: { host: u.host } }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve(t));
      });
      req.on('error', reject);
      req.write('abc');
      req.end('def'); // no content-length → chunked
    });
    expect(text).toBe('6');
    const [ex] = (await settled(proxy)).slice(-1);
    expect(ex.error).toMatch(/streamed \(unknown length\)/);
  });

  it('response breakpoint + 10 MB response: pauses, body edit refused, header edit delivers every byte', async () => {
    proxy.setRules([bp('response', '*/big*')]);
    const size = 10 * MB;
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = viaProxy(proxy.port, `${up.httpUrl}/big?size=${size}`);
    const ex = await paused;
    expect(ex.responseBody?.truncated).toBe(true);
    expect(() => proxy.resume(ex.id, { body: 'x' })).toThrow(/larger than 5 MB/);
    proxy.resume(ex.id, { headers: { ...(ex.responseHeaders as Record<string, string>), 'x-edited': '1' } });
    const r = await resP;
    expect(r.headers['x-edited']).toBe('1');
    expect(r.body.length).toBe(size);
  });

  it('response breakpoint + response over 32 MB: 502 that says why, exchange error, never buffered', async () => {
    proxy.setRules([bp('response', '*/big*')]);
    const errored = nextExchange(proxy, inState('error'));
    const r = await viaProxy(proxy.port, `${up.httpUrl}/big?size=${BIG}`);
    expect(r.status).toBe(502);
    expect(r.text).toMatch(/larger than 32 MB/);
    expect((await errored).error).toMatch(/larger than 32 MB/);
  });

  it('mock with a 40 MB upload: answered, not buffered', async () => {
    proxy.setRules([{ id: 'm', enabled: true, match: { url: '*/count' }, action: { kind: 'mock', status: 200, body: 'mocked' } }]);
    const before = up.hits.length;
    const r = await viaProxy(proxy.port, `${up.httpUrl}/count`, { method: 'POST', body: Buffer.alloc(BIG, 'u') }).catch((e) => e);
    // The mock may answer before the upload finishes; either outcome is fine for the client.
    if (!(r instanceof Error)) expect(r.text).toBe('mocked');
    expect(up.hits.length).toBe(before); // never forwarded
  });
});
