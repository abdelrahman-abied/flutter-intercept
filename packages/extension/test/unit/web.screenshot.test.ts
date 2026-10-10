/**
 * Flutter Web screenshots over CDP (CONTRACTS §13.8, §14.7, REVIEW-8 #10) against a fake DevTools endpoint on
 * 127.0.0.1: the browser comes from the process list (this session's flags) and must own the listener; only the app's
 * page is captured; loopback-only URLs; PNG checks; saving.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer } = require('ws') as typeof import('ws');
import type { Exec } from '../../src/web/browsers';
import { appPage, captureWebPng, loopbackOrigin, webLaunchUrlOf, webScreenshot } from '../../src/web/screenshot';

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const APP = 'http://localhost:5000/';
const PIN = 'M5zrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqQxw=';
const FLAGS = ['--web-browser-flag=--proxy-pac-url=http://127.0.0.1:7000/flutter-intercept-9123.pac', `--web-browser-flag=--ignore-certificate-errors-spki-list=${PIN}`];
let server: http.Server;
let port: number;
let psOut = '';
let listenerPid = 4242;
const calls: string[][] = [];
const exec: Exec = async (cmd, args) => {
  calls.push([cmd, ...args]);
  if (cmd === 'ps') return { stdout: Buffer.from(psOut), stderr: '' };
  if (cmd === 'lsof') {
    const pid = args[args.indexOf('-p') + 1];
    if (Number(pid) === listenerPid && args.includes(`-iTCP:${port}`)) return { stdout: Buffer.from(`${pid}\n`), stderr: '' };
    throw Object.assign(new Error('exit 1'), { code: 1 });
  }
  throw new Error(`unexpected ${cmd}`);
};
const base = () => ({ exec, platform: 'darwin' as NodeJS.Platform, uid: 501 });
let targets: unknown = [];
let reply: (msg: { id: number; method: string; params: unknown }) => unknown;
const seen: { path?: string; method?: string; params?: unknown; origin?: string }[] = [];
let project: string;
const chromeLine = (pid: number, uid: number, extra = '') =>
  `${pid} ${uid} /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/var/folders/x/T/flutter_tools.Ab12/flutter_tools_chrome_device.Cd34 ` +
  `--remote-debugging-port=${port} --disable-extensions --headless=new ${FLAGS.map((f) => f.slice('--web-browser-flag='.length)).join(' ')}${extra} http://localhost:5000\n`;

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
beforeEach(() => {
  psOut = `  1 0 /sbin/launchd\n${chromeLine(4242, 501)}4243 501 /Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper --type=renderer --user-data-dir=/x/flutter_tools_chrome_device.Cd34 --remote-debugging-port=${port}\n`;
  listenerPid = 4242;
  calls.length = 0;
  targets = [
    { id: 'MAIL', type: 'page', url: 'https://mail.example.com/' },
    { id: 'PAGE1', type: 'page', url: 'http://localhost:5000/#/home', webSocketDebuggerUrl: 'ws://evil.example:1/devtools/page/PAGE1' },
  ];
  reply = (m) => ({ id: m.id, result: { data: png(800, 600).toString('base64') } });
  seen.length = 0;
});
afterAll(() => {
  server.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('helpers', () => {
  it('webLaunchUrlOf reads flutter_tools app.webLaunchUrl forwarded by the debug adapter (loopback only)', () => {
    const ev = (url: unknown, event = 'app.webLaunchUrl') => ({ event: 'flutter.forwardedEvent', body: { event, params: { url, launched: true } } });
    expect(webLaunchUrlOf(ev('http://localhost:5000'))).toBe('http://localhost:5000');
    expect(webLaunchUrlOf(ev('http://192.168.1.2:5000'))).toBeUndefined();
    expect(webLaunchUrlOf(ev('http://localhost:5000', 'app.warning'))).toBeUndefined();
    expect(webLaunchUrlOf({ event: 'dart.debuggerUris', body: {} })).toBeUndefined();
    expect(webLaunchUrlOf(undefined)).toBeUndefined();
  });
  it('loopbackOrigin / appPage: only the app origin, never another tab, safe ids', () => {
    expect(loopbackOrigin('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080');
    expect(loopbackOrigin('http://127.evil.example/')).toBeUndefined();
    expect(loopbackOrigin('chrome://newtab')).toBeUndefined();
    const o = 'http://localhost:5000';
    expect(appPage([{ id: 'a', type: 'page', url: 'https://example.com/' }, { id: 'b', type: 'page', url: 'http://localhost:5001/' }], o)).toBeUndefined();
    expect(appPage([{ id: 'w', type: 'service_worker', url: 'http://localhost:5000/sw.js' }, { id: 'p', type: 'page', url: 'http://localhost:5000/#/' }], o)?.id).toBe('p');
    expect(appPage([{ id: '../x', type: 'page', url: 'http://localhost:5000/' }], o)).toBeUndefined();
  });
});

describe('captureWebPng / webScreenshot', () => {
  it('verified browser, the app page only, WebSocket rebuilt on 127.0.0.1 (advertised host ignored), no Origin', async () => {
    const shot = await captureWebPng(APP, FLAGS, base());
    expect(shot.readUInt32BE(16)).toBe(800);
    expect(seen.map((s) => s.path).filter(Boolean)).toEqual(['/json/list', '/devtools/page/PAGE1']);
    expect(seen.find((s) => s.path === '/devtools/page/PAGE1')?.origin).toBeUndefined();
    expect(seen.find((s) => s.method)).toMatchObject({ method: 'Page.captureScreenshot', params: { format: 'png' } });
    expect(calls).toEqual([
      ['ps', '-A', '-ww', '-o', 'pid=,uid=,args='],
      ['lsof', '-nP', '-a', '-p', '4242', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
    ]);
  });

  it('REVIEW-8 #10: a port held by another process is never talked to', async () => {
    listenerPid = 9999; // someone else bound the port before Chrome
    await expect(captureWebPng(APP, FLAGS, base())).rejects.toThrow(/not held by the browser itself/);
    expect(seen.length).toBe(0);
  });

  it("only this session's browser (its flags), this user's, the browser process (not --type= children)", async () => {
    await expect(captureWebPng(APP, ['--web-browser-flag=--proxy-pac-url=http://127.0.0.1:1/flutter-intercept-2.pac'], base())).rejects.toThrow(/no debug browser .* for this session/);
    await expect(captureWebPng(APP, FLAGS, { ...base(), uid: 777 })).rejects.toThrow(/no debug browser/);
    await expect(captureWebPng(APP, [], base())).rejects.toThrow(/browser flags/);
    psOut = `${chromeLine(4242, 501).replace('flutter_tools_chrome_device', 'my_profile')}`;
    await expect(captureWebPng(APP, FLAGS, base())).rejects.toThrow(/no debug browser/);
    expect(seen.length).toBe(0);
  });

  it('no fallback to other tabs: only unrelated pages → error', async () => {
    targets = [{ id: 'MAIL', type: 'page', url: 'https://mail.example.com/' }, { id: 'X', type: 'page', url: 'http://localhost:5999/' }];
    await expect(captureWebPng(APP, FLAGS, base())).rejects.toThrow(/\(http:\/\/localhost:5000\) is not open/);
  });

  it('saves it like other screenshots; method devtools', async () => {
    const logs: string[] = [];
    const s = await webScreenshot(
      { sessionId: 's1', deviceId: 'chrome', projectRoot: project },
      { ...base(), appUrl: (id) => (id === 's1' ? APP : undefined), webFlags: () => FLAGS, log: (m) => logs.push(m), now: () => new Date('2026-10-10T10:00:00.000Z') },
    );
    expect(s).toMatchObject({ method: 'devtools', width: 800, height: 600, takenAt: Date.parse('2026-10-10T10:00:00.000Z') });
    expect(s.path).toBe(path.join(project, '.dart_tool', 'flutter_intercept', 'screenshots', '2026-10-10T10-00-00-000Z.png'));
    expect(fs.readFileSync(s.path).equals(s.png)).toBe(true);
    expect(logs.at(-1)).toMatch(/devtools, 800×600/);
  });

  it('clear errors: no app URL, CDP error, not a PNG, non-loopback app URL, lsof missing', async () => {
    const t = { sessionId: 's', deviceId: 'chrome', projectRoot: project };
    await expect(webScreenshot(t, { ...base(), appUrl: () => undefined, webFlags: () => FLAGS, log: () => undefined })).rejects.toThrow(/URL is not known yet/);
    reply = (m) => ({ id: m.id, error: { message: 'Not attached' } });
    await expect(captureWebPng(APP, FLAGS, base())).rejects.toThrow(/Page.captureScreenshot: Not attached/);
    reply = (m) => ({ id: m.id, result: { data: Buffer.from('GIF89a').toString('base64') } });
    await expect(captureWebPng(APP, FLAGS, base())).rejects.toThrow(/not a PNG/);
    await expect(captureWebPng('http://192.168.1.2:5000/', FLAGS, base())).rejects.toThrow(/not a loopback/);
    const noLsof: Exec = async (cmd, args) => {
      if (cmd === 'lsof') throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
      return exec(cmd, args);
    };
    await expect(captureWebPng(APP, FLAGS, { ...base(), exec: noLsof })).rejects.toThrow(/lsof is not available/);
  });

  it('never connects anywhere but 127.0.0.1', async () => {
    const urls: string[] = [];
    await expect(
      captureWebPng(APP, FLAGS, {
        ...base(),
        getJson: async (u) => (urls.push(u), [{ id: 'Z', type: 'page', url: APP, webSocketDebuggerUrl: 'ws://192.168.1.2:9222/devtools/page/Z' }]),
        webSocket: (u) => {
          urls.push(u);
          throw new Error('stop');
        },
      }),
    ).rejects.toThrow('stop');
    expect(urls).toEqual([`http://127.0.0.1:${port}/json/list`, `ws://127.0.0.1:${port}/devtools/page/Z`]);
  });
});
