/**
 * Bundle smoke: builds dist/sidecar.js, starts it as the plugin would (`node sidecar.js`, JSON lines on stdio), runs
 * init, loads the traffic UI page and its assets, opens the UI WebSocket and gets a snapshot, then shuts it down.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const root = path.join(__dirname, '..');
const bundle = path.join(root, 'dist', 'sidecar.js');

function get(url: string, cookie?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, cookie ? { headers: { cookie } } : {}, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
      .on('error', reject);
  });
}

describe('dist/sidecar.js', () => {
  let child: ChildProcessWithoutNullStreams;
  let tmp: string;
  const lines: any[] = [];
  let stderr = '';
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  const next = (pred: (m: any) => boolean, ms = 20_000) =>
    new Promise<any>((resolve, reject) => {
      const hit = lines.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timeout; stderr:\n${stderr}`)), ms);
      waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'pipe' });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-bundle-'));
    child = spawn(process.execPath, [bundle], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)); // every stdout line must be protocol JSON
        buf = buf.slice(nl + 1);
        lines.push(msg);
        for (const w of [...waiters]) if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  }, 120_000);

  afterAll(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('never requires vscode and ships the webview', () => {
    const code = fs.readFileSync(bundle, 'utf8');
    expect(code).not.toMatch(/require\(\s*["']vscode["']\s*\)/);
    expect(fs.existsSync(path.join(root, 'dist', 'webview', 'webview.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist', 'webview', 'webview.css'))).toBe(true);
  });

  it('init → UI page → WebSocket snapshot → shutdown', async () => {
    send({
      id: 1,
      method: 'init',
      params: {
        dataDir: path.join(tmp, 'data'),
        workspaceFolders: [tmp],
        settings: { enabled: true, port: 0, agent: { access: 'readOnly', redactSecrets: true, screenshots: false, mcpPort: 0 } },
        theme: 'dark',
        ide: { name: 'Test IDE', version: '1', pluginVersion: '0.9.0' },
      },
    });
    const r = await next((m) => m.id === 1);
    expect(r.error).toBeUndefined();
    const { uiUrl, mcpUrl, version } = r.result;
    expect(version).toBe(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    expect(mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const token = new URL(uiUrl).searchParams.get('t')!;
    expect(lines.some((m) => m.event === 'ready')).toBe(true);

    // CONTRACTS §15.4: one-time URL → cookie + redirect; the URL is dead afterwards
    const first = await get(uiUrl);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/');
    const cookie = (first.headers['set-cookie'] as string[])[0].split(';')[0];
    expect((await get(uiUrl)).status).toBe(403);
    const origin = new URL(uiUrl).origin;
    const page = await get(`${origin}/`, cookie);
    expect(page.status).toBe(200);
    expect(page.body).toContain('class="fi-ide ide-dark vscode-dark"');
    const wsUrl = /window\.__FI_WS__ = "([^"]+)"/.exec(page.body)![1];
    const js = await get(`${origin}/webview.js`, cookie);
    expect(js.status).toBe(200);
    expect(js.body.length).toBeGreaterThan(10_000);
    expect((await get(`${origin}/webview.js`)).status).toBe(403);

    const ws = new WebSocket(wsUrl, { origin });
    const snapshot = await new Promise<any>((resolve, reject) => {
      ws.once('error', reject);
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'snapshot') resolve(m);
      });
      ws.once('open', () => ws.send(JSON.stringify({ type: 'ready' })));
    });
    send({ id: 3, method: 'uiUrl' });
    expect((await next((m) => m.id === 3)).result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/);
    expect(snapshot.status).toMatchObject({ proxyRunning: false, interceptEnabled: true, sessions: 0, agent: { access: 'readOnly' } });
    expect(Array.isArray(snapshot.exchanges)).toBe(true);
    ws.close();

    expect(stderr).not.toContain(token);
    send({ id: 2, method: 'shutdown' });
    await next((m) => m.id === 2);
    const code = await new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', (c) => resolve(c))));
    expect(code).toBe(0);
  }, 60_000);
});
