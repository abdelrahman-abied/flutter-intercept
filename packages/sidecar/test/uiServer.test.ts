import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { UiServer, type UiController } from '../src/uiServer';

const TOKEN = 'A'.repeat(43);

function get(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(url: string, origin: string | undefined, cookie?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { ...(origin ? { origin } : {}), ...(cookie ? { headers: { cookie } } : {}) });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

describe('UiServer', () => {
  let dir: string;
  let server: UiServer;
  let port: number;
  let origin: string;
  let clock = 1_000_000;
  let cookie: string;
  const handled: unknown[] = [];
  const controller: UiController = {
    attach: (sink) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    handle: async (raw, reply) => {
      handled.push(raw);
      if ((raw as { type: string }).type === 'ready') reply({ type: 'snapshot', exchanges: [], rules: [], status: { proxyRunning: false, interceptEnabled: true, sessions: 0 } });
    },
  };
  const sinks = new Set<(m: unknown) => void>();

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-ui-'));
    fs.writeFileSync(path.join(dir, 'webview.js'), 'console.log("bundle")');
    fs.writeFileSync(path.join(dir, 'webview.css'), 'body{}');
    handled.length = 0;
    sinks.clear();
    server = new UiServer({ controller, webviewDir: dir, theme: () => 'high-contrast', token: TOKEN, now: () => clock });
    const url = await server.start();
    port = server.port!;
    origin = `http://127.0.0.1:${port}`;
    expect(url).toMatch(new RegExp(`^${origin}/\\?t=[A-Za-z0-9_-]{43}$`));
    const r = await get(port, new URL(url).pathname + new URL(url).search);
    expect(r.status).toBe(302);
    cookie = (r.headers['set-cookie'] as string[])[0].split(';')[0];
  });
  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exchanges a one-time URL for an HttpOnly SameSite=Strict cookie and a redirect to /', async () => {
    const url = new URL(server.issueUrl());
    const r = await get(port, url.pathname + url.search);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    const set = (r.headers['set-cookie'] as string[])[0];
    expect(set).toMatch(new RegExp(`^fi_session_${port}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`));
    expect(set.split(';')[0]).not.toBe(cookie); // one session per browser
    // single use
    const again = await get(port, url.pathname + url.search);
    expect(again.status).toBe(403);
    expect(again.body).toContain('Open the traffic view again from the IDE');
    // expired after 60 s
    const late = new URL(server.issueUrl());
    clock += 60_001;
    expect((await get(port, late.pathname + late.search)).status).toBe(403);
    // unknown, wrong path, the WebSocket token
    expect((await get(port, `/?t=${'B'.repeat(43)}`)).status).toBe(403);
    expect((await get(port, `/?t=${TOKEN}`)).status).toBe(403);
    const other = new URL(server.issueUrl());
    expect((await get(port, `/webview.js${other.search}`)).status).toBe(403);
  });

  it('serves the page with CSP, the WebSocket URL, IDE body classes and the assets (cookie only)', async () => {
    const r = await get(port, '/', { cookie });
    expect(r.status).toBe(200);
    const csp = r.headers['content-security-policy'] as string;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(csp).toBe(
      `default-src 'none'; style-src ${origin}; script-src 'nonce-${nonce}'; img-src ${origin} data:; font-src ${origin}; connect-src ws://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(r.body).toContain(`content="${csp}"`);
    expect(r.body).toContain(`<script nonce="${nonce}">window.__FI_WS__ = "ws://127.0.0.1:${port}/ws?t=${TOKEN}";</script>`);
    expect(r.body.indexOf('__FI_WS__')).toBeLessThan(r.body.indexOf('webview.js'));
    expect(r.body).toContain(`src="${origin}/webview.js"`);
    expect(r.body).toMatch(/<body class="fi-ide ide-dark vscode-high-contrast">\s*<div id="root"><\/div>/);
    expect(r.body).toContain('data-fi-theme="high-contrast"');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await get(port, '/webview.js', { cookie })).body).toBe('console.log("bundle")');
    expect((await get(port, '/webview.css', { cookie })).headers['content-type']).toContain('text/css');
    expect((await get(port, '/theme.css', { cookie })).body).toContain('--vscode-editor-background');
    expect((await get(port, '/nope', { cookie })).status).toBe(404);
  });

  it('refuses requests without a session, with a foreign Host or Origin', async () => {
    expect((await get(port, '/')).status).toBe(403);
    expect((await get(port, '/webview.js')).status).toBe(403);
    expect((await get(port, '/', { cookie: `fi_session_${port}=${'C'.repeat(43)}` })).status).toBe(403);
    expect((await get(port, '/', { cookie: `fi_session_1=${cookie.split('=')[1]}` })).status).toBe(403);
    expect((await get(port, '/', { cookie, host: `localhost:${port}` })).status).toBe(403);
    expect((await get(port, '/', { cookie, host: `evil.example:${port}` })).status).toBe(403);
    expect((await get(port, '/', { cookie, origin: 'http://evil.example' })).status).toBe(403);
    expect((await get(port, '/', { cookie, origin })).status).toBe(200);
  });

  it('upgrades /ws only with token and the UI Origin, then relays HostMsg / ViewMsg JSON', async () => {
    const wsUrl = `ws://127.0.0.1:${port}/ws?t=${TOKEN}`;
    await expect(connect(wsUrl, undefined)).rejects.toThrow('403');
    await expect(connect(wsUrl, 'http://evil.example')).rejects.toThrow('403');
    await expect(connect(`ws://127.0.0.1:${port}/ws?t=bad`, origin)).rejects.toThrow('403');
    await expect(connect(`ws://127.0.0.1:${port}/other?t=${TOKEN}`, origin)).rejects.toThrow('403');
    // the cookie alone (same-origin page) also works, but never without the Origin
    (await connect(`ws://127.0.0.1:${port}/ws`, origin, cookie)).close();
    await expect(connect(`ws://127.0.0.1:${port}/ws`, undefined, cookie)).rejects.toThrow('403');
    await expect(connect(`ws://127.0.0.1:${port}/ws`, origin)).rejects.toThrow('403');
    await new Promise((r) => setTimeout(r, 50));
    const ws = await connect(wsUrl, origin);
    const got: unknown[] = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: 'ready' }));
    ws.send(JSON.stringify({ type: 'openInNewWindow' }));
    ws.send('not json');
    await new Promise((r) => setTimeout(r, 50));
    for (const s of sinks) s({ type: 'cleared' });
    await new Promise((r) => setTimeout(r, 50));
    expect(handled).toEqual([{ type: 'ready' }]);
    expect(got).toEqual([{ type: 'snapshot', exchanges: [], rules: [], status: { proxyRunning: false, interceptEnabled: true, sessions: 0 } }, { type: 'cleared' }]);
    expect(server.clientCount).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.clientCount).toBe(0);
    expect(sinks.size).toBe(0);
  });
});
