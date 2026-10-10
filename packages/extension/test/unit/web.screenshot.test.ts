/**
 * Flutter Web screenshots over CDP (CONTRACTS §13.8, §14.7) against a fake DevTools endpoint on 127.0.0.1:
 * target choice, loopback-only URLs, PNG checks, saving.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer } = require('ws') as typeof import('ws');
import { captureWebPng, pickTarget, webScreenshot } from '../../src/web/screenshot';

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

let server: http.Server;
let port: number;
let targets: unknown = [];
let reply: (msg: { id: number; method: string; params: unknown }) => unknown = (m) => ({ id: m.id, result: { data: png(800, 600).toString('base64') } });
const seen: { path?: string; method?: string; params?: unknown; origin?: string }[] = [];
let project: string;

beforeAll(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-webshot-'));
  server = http.createServer((req, res) => {
    seen.push({ path: req.url });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(targets));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    seen.push({ path: req.url, origin: req.headers.origin });
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      seen.push({ method: msg.method, params: msg.params });
      ws.send(JSON.stringify({ method: 'Page.frameNavigated', params: {} })); // events are skipped
      const r = reply(msg);
      if (r) ws.send(JSON.stringify(r));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('pickTarget', () => {
  it('the app page on loopback first, never devtools or unsafe ids', () => {
    expect(pickTarget([
      { id: 'a', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
      { id: 'b', type: 'service_worker', url: 'http://localhost:5000/sw.js' },
      { id: 'c', type: 'page', url: 'https://example.com/' },
      { id: 'd', type: 'page', url: 'http://localhost:5000/#/' },
    ])?.id).toBe('d');
    expect(pickTarget([{ id: 'c', type: 'page', url: 'https://example.com/' }])?.id).toBe('c');
    expect(pickTarget([{ id: '../x', type: 'page', url: 'http://localhost:1/' }])).toBeUndefined();
    expect(pickTarget([{ id: 'x', type: 'page', url: 'chrome://newtab/' }])).toBeUndefined();
    expect(pickTarget({})).toBeUndefined();
  });
});

describe('captureWebPng / webScreenshot', () => {
  it('rebuilds the WebSocket URL on 127.0.0.1 (ignores the advertised host), no Origin, captures a PNG', async () => {
    seen.length = 0;
    targets = [{ id: 'PAGE1', type: 'page', url: 'http://localhost:5000/', webSocketDebuggerUrl: 'ws://evil.example:1/devtools/page/PAGE1' }];
    const shot = await captureWebPng(port);
    expect(shot.readUInt32BE(16)).toBe(800);
    expect(seen[0].path).toBe('/json/list');
    expect(seen[1]).toEqual({ path: '/devtools/page/PAGE1', origin: undefined });
    expect(seen[2]).toMatchObject({ method: 'Page.captureScreenshot', params: { format: 'png' } });
  });

  it('saves it like other screenshots; method devtools', async () => {
    targets = [{ id: 'P', type: 'page', url: 'http://127.0.0.1:5000/' }];
    const logs: string[] = [];
    const s = await webScreenshot({ sessionId: 's1', deviceId: 'chrome', projectRoot: project }, { devToolsPort: (id) => (id === 's1' ? port : undefined), log: (m) => logs.push(m), now: () => new Date('2026-10-10T10:00:00.000Z') });
    expect(s).toMatchObject({ method: 'devtools', width: 800, height: 600, takenAt: Date.parse('2026-10-10T10:00:00.000Z') });
    expect(s.path).toBe(path.join(project, '.dart_tool', 'flutter_intercept', 'screenshots', '2026-10-10T10-00-00-000Z.png'));
    expect(fs.readFileSync(s.path).equals(s.png)).toBe(true);
    expect(logs.at(-1)).toMatch(/devtools, 800×600/);
  });

  it('clear errors: no port, no page, CDP error, not a PNG', async () => {
    const t = { sessionId: 's', deviceId: 'chrome', projectRoot: project };
    await expect(webScreenshot(t, { devToolsPort: () => undefined, log: () => undefined })).rejects.toThrow(/no known debug port/);
    targets = [];
    await expect(webScreenshot(t, { devToolsPort: () => port, log: () => undefined })).rejects.toThrow(/no app page in the debug browser/);
    targets = [{ id: 'P', type: 'page', url: 'http://localhost:1/' }];
    reply = (m) => ({ id: m.id, error: { message: 'Not attached' } });
    await expect(captureWebPng(port)).rejects.toThrow(/Page.captureScreenshot: Not attached/);
    reply = (m) => ({ id: m.id, result: { data: Buffer.from('GIF89a').toString('base64') } });
    await expect(captureWebPng(port)).rejects.toThrow(/not a PNG/);
    await expect(captureWebPng(0)).rejects.toThrow(/debug port/);
  });

  it('never connects anywhere but 127.0.0.1', async () => {
    const urls: string[] = [];
    await expect(
      captureWebPng(port, {
        getJson: async (u) => (urls.push(u), [{ id: 'Z', type: 'page', url: 'http://localhost:1/', webSocketDebuggerUrl: 'ws://192.168.1.2:9222/devtools/page/Z' }]),
        webSocket: (u) => {
          urls.push(u);
          throw new Error('stop');
        },
      }),
    ).rejects.toThrow('stop');
    expect(urls).toEqual([`http://127.0.0.1:${port}/json/list`, `ws://127.0.0.1:${port}/devtools/page/Z`]);
  });
});
