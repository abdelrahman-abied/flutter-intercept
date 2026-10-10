/**
 * Flutter Web DIRECT fallback (CONTRACTS §14.7): the loopback PAC server and its script.
 */
import * as http from 'http';
import * as vm from 'vm';
import { afterEach, describe, expect, it } from 'vitest';
import { PacServer, pacScript } from '../../src/debug/pacServer';

function findProxy(script: string, url: string, host: string): string {
  const sandbox: Record<string, unknown> = {
    dnsDomainIs: (h: string, d: string) => h.endsWith(d),
  };
  vm.runInNewContext(script, sandbox);
  return (sandbox.FindProxyForURL as (u: string, h: string) => string)(url, host);
}

function get(port: number, path: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body, type: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('pacScript', () => {
  it('loopback DIRECT, everything else through the proxy with DIRECT fallback', () => {
    const s = pacScript(9123);
    // The script travels over HTTP (commas are fine there); only the flag value must be comma-free (rewrite tests).
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(findProxy(s, `http://${host}:5000/`, host)).toBe('DIRECT');
    // REVIEW-8 #3: DNS names that merely start with 127. are proxied (only IP literals go DIRECT).
    for (const host of ['jsonplaceholder.typicode.com', 'www.gstatic.com', '10.0.0.2', 'localhost.example.com', '127.evil.example', '127.0.0.1.evil.example', '127.0.0.1x', 'x127.0.0.1']) {
      expect(findProxy(s, `https://${host}/`, host)).toBe('PROXY 127.0.0.1:9123; DIRECT');
    }
  });
  it('rejects bad ports', () => {
    for (const p of [0, -1, 65536, 1.5, NaN]) expect(() => pacScript(p)).toThrow();
  });
});

describe('PacServer', () => {
  let server: PacServer | undefined;
  afterEach(() => server?.dispose());

  it('serves the current port only, loopback Host only, GET/HEAD only', async () => {
    let current: number | undefined = 9123;
    server = new PacServer({ currentPort: () => current });
    const url = await server.urlFor(9123);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/flutter-intercept-9123\.pac$/);
    expect(await server.urlFor(9123)).toBe(url); // one listener
    const port = server.port!;
    const ok = await get(port, '/flutter-intercept-9123.pac');
    expect(ok).toMatchObject({ status: 200, type: 'application/x-ns-proxy-autoconfig' });
    expect(ok.body).toBe(pacScript(9123));
    expect((await get(port, '/flutter-intercept-9123.pac', { method: 'HEAD' })).status).toBe(200);
    expect((await get(port, '/flutter-intercept-9124.pac')).status).toBe(404);
    expect((await get(port, '/other')).status).toBe(404);
    expect((await get(port, '/flutter-intercept-9123.pac', { method: 'POST' })).status).toBe(405);
    expect((await get(port, '/flutter-intercept-9123.pac', { host: `evil.example:${port}` })).status).toBe(403);
    expect((await get(port, '/flutter-intercept-9123.pac', { host: `localhost:${port}` })).status).toBe(403);
    current = undefined; // proxy stopped → Chrome's next PAC fetch fails → DIRECT
    expect((await get(port, '/flutter-intercept-9123.pac')).status).toBe(404);
    current = 9200; // restarted elsewhere: the old script is not served any more
    expect((await get(port, '/flutter-intercept-9123.pac')).status).toBe(404);
    expect((await get(port, '/flutter-intercept-9200.pac')).status).toBe(200);
  });

  it('listens on loopback only and refuses after dispose', async () => {
    server = new PacServer({ currentPort: () => 1 });
    await server.urlFor(1);
    expect(server.port).toBeGreaterThan(0);
    server.dispose();
    await expect(server.urlFor(1)).rejects.toThrow(/disposed/);
    await expect(new PacServer({ currentPort: () => 1 }).urlFor(0)).rejects.toThrow(/bad proxy port/);
  });
});
