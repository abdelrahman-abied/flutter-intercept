import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PAGE_IDLE_MS, PAGE_UNUSED_MS, UiServer, type UiController } from '../src/uiServer';

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

function req(port: number, p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

function connect(url: string, origin: string | undefined): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('UiServer', () => {
  let dir: string;
  let server: UiServer;
  let port: number;
  let origin: string;
  let clock = 1_000_000;
  const handled: unknown[] = [];
  const sinks = new Set<(m: unknown) => void>();
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
  /** Redeems a fresh one-time URL; returns the page and its WebSocket URL. */
  const openPage = async () => {
    const u = new URL(server.issueUrl());
    const page = await req(port, u.pathname + u.search);
    const ws = /window\.__FI_WS__ = "([^"]+)"/.exec(page.body)?.[1];
    return { page, ws: ws!, oneTime: u.pathname + u.search };
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-ui-'));
    fs.writeFileSync(path.join(dir, 'webview.js'), 'console.log("bundle")');
    fs.writeFileSync(path.join(dir, 'webview.css'), 'body{}');
    handled.length = 0;
    sinks.clear();
    server = new UiServer({ controller, webviewDir: dir, theme: () => 'high-contrast', now: () => clock });
    const url = await server.start();
    port = server.port!;
    origin = `http://127.0.0.1:${port}`;
    expect(url).toMatch(new RegExp(`^${origin}/\\?t=[A-Za-z0-9_-]{43}$`));
  });
  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a one-time URL serves the page directly (no cookie, no redirect), once, within 60 s', async () => {
    const { page, oneTime } = await openPage();
    expect(page.status).toBe(200);
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.headers['x-frame-options']).toBe('DENY');
    const again = await req(port, oneTime);
    expect(again.status).toBe(403);
    expect(again.body).toContain('Open the traffic view again from the IDE');
    const late = new URL(server.issueUrl());
    clock += 60_001;
    expect((await req(port, late.pathname + late.search)).status).toBe(403);
    expect((await req(port, '/')).status).toBe(403); // a reload
    expect((await req(port, `/?t=${'B'.repeat(43)}`)).status).toBe(403);
  });

  it('only GET redeems a one-time token (HEAD and others never consume it)', async () => {
    const u = new URL(server.issueUrl());
    expect((await req(port, u.pathname + u.search, {}, 'HEAD')).status).toBe(405);
    expect((await req(port, u.pathname + u.search, {}, 'POST')).status).toBe(405);
    expect((await req(port, u.pathname + u.search)).status).toBe(200);
  });

  it('serves the page with CSP, a per-page WebSocket secret and IDE body classes; assets are public', async () => {
    const { page: r, ws: wsA } = await openPage();
    const csp = r.headers['content-security-policy'] as string;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(csp).toBe(
      `default-src 'none'; style-src ${origin}; script-src 'nonce-${nonce}'; img-src ${origin} data:; font-src ${origin}; connect-src ws://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(r.body).toContain(`content="${csp}"`);
    expect(wsA).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${port}/ws\\?t=[A-Za-z0-9_-]{43}$`));
    expect(r.body).toContain(`<script nonce="${nonce}">window.__FI_WS__ = "${wsA}";</script>`);
    expect(r.body.indexOf('__FI_WS__')).toBeLessThan(r.body.indexOf('webview.js'));
    expect(r.body).toMatch(/<body class="fi-ide ide-dark vscode-high-contrast">\s*<div id="root"><\/div>/);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    const { ws: wsB } = await openPage();
    expect(wsB).not.toBe(wsA); // two page loads, two secrets
    const js = await req(port, '/webview.js');
    expect(js.body).toBe('console.log("bundle")');
    expect(js.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect((await req(port, '/webview.css')).headers['content-type']).toContain('text/css');
    expect((await req(port, '/theme.css')).body).toContain('--vscode-editor-background');
    expect((await req(port, '/nope')).status).toBe(404);
  });

  it('refuses a foreign Host or Origin', async () => {
    expect((await req(port, '/webview.js', { host: `localhost:${port}` })).status).toBe(403);
    expect((await req(port, '/webview.js', { host: `evil.example:${port}` })).status).toBe(403);
    expect((await req(port, '/webview.js', { origin: 'http://127.0.0.1:9999' })).status).toBe(403);
    expect((await req(port, '/webview.js', { origin })).status).toBe(200);
    const u = new URL(server.issueUrl());
    expect((await req(port, u.pathname + u.search, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await req(port, u.pathname + u.search)).status).toBe(200); // the refused request didn't consume it
  });

  it('upgrades /ws only with a live page secret and the UI Origin, then relays JSON', async () => {
    const { ws: wsUrl } = await openPage();
    await expect(connect(wsUrl, undefined)).rejects.toThrow('403');
    await expect(connect(wsUrl, 'http://evil.example')).rejects.toThrow('403');
    await expect(connect(`ws://127.0.0.1:${port}/ws?t=${'C'.repeat(43)}`, origin)).rejects.toThrow('403');
    await expect(connect(`ws://127.0.0.1:${port}/ws`, origin)).rejects.toThrow('403');
    await expect(connect(wsUrl.replace('/ws?', '/other?'), origin)).rejects.toThrow('403');
    const ws = await connect(wsUrl, origin);
    const got: unknown[] = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: 'ready' }));
    ws.send(JSON.stringify({ type: 'openInNewWindow' }));
    ws.send('not json');
    await tick();
    for (const s of sinks) s({ type: 'cleared' });
    await tick();
    expect(handled).toEqual([{ type: 'ready' }]);
    expect(got).toEqual([{ type: 'snapshot', exchanges: [], rules: [], status: { proxyRunning: false, interceptEnabled: true, sessions: 0 } }, { type: 'cleared' }]);
    ws.close();
    await tick();
    expect(server.clientCount).toBe(0);
    expect(sinks.size).toBe(0);
  });

  it('revokes a page secret 30 s after its last socket closed, or 60 s after the load when unused', async () => {
    const a = await openPage();
    const ws = await connect(a.ws, origin);
    clock += PAGE_UNUSED_MS * 5; // open sockets keep it alive
    (await connect(a.ws, origin)).close(); // a second socket of the same page
    ws.close();
    await tick();
    clock += PAGE_IDLE_MS - 1_000;
    (await connect(a.ws, origin)).close(); // a reconnect within the backoff
    await tick();
    clock += PAGE_IDLE_MS + 1;
    await expect(connect(a.ws, origin)).rejects.toThrow('403');

    const b = await openPage();
    clock += PAGE_UNUSED_MS + 1;
    await expect(connect(b.ws, origin)).rejects.toThrow('403');

    const c = await openPage();
    await server.close();
    expect(server.pageCount).toBe(0);
    void c;
  });
});
