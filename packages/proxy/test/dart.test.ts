// Drives the proxy with a REAL dart:io HttpClient (test/fixtures/dart_client.dart), configured
// like the generated entry: findProxy 'PROXY 127.0.0.1:<port>; DIRECT' + badCertificateCallback.
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InterceptProxy, Rule } from '../src';
import { inState, nextExchange, settled, startProxy, startUpstream, type Upstream } from './helpers';

const FIXTURE = path.join(__dirname, 'fixtures', 'dart_client.dart');
let exe: string;
let tmp: string;
let up: Upstream;
let proxy: InterceptProxy;

interface DartResult {
  code: number;
  status?: number;
  body: string;
  error?: string;
  stdout: string;
}

function parse(code: number, stdout: string): DartResult {
  const nl = stdout.indexOf('\n');
  const first = nl === -1 ? stdout : stdout.slice(0, nl);
  const rest = nl === -1 ? '' : stdout.slice(nl + 1);
  if (first.startsWith('STATUS ')) return { code, status: Number(first.slice(7)), body: rest, stdout };
  return { code, body: '', error: first.replace(/^ERROR /, ''), stdout };
}

function dart(args: string[], env: NodeJS.ProcessEnv = {}, cmd = exe): Promise<DartResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 60_000 }, (err, stdout) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve(parse(typeof code === 'number' ? code : 1, stdout));
    });
  });
}

const run = (url: string, method = 'GET', body = '', timeoutMs?: number, env?: NodeJS.ProcessEnv) =>
  dart([String(proxy.port), url, method, body, ...(timeoutMs ? [String(timeoutMs)] : [])], env);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-dart-'));
  exe = path.join(tmp, process.platform === 'win32' ? 'dart_client.exe' : 'dart_client');
  // Compile once: `dart run` re-compiles on every invocation (~1 s each).
  execFileSync('dart', ['compile', 'exe', FIXTURE, '-o', exe], { stdio: 'pipe' });
  up = await startUpstream();
});
afterAll(async () => {
  await up?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  proxy = await startProxy();
  up.hits.length = 0;
});
afterEach(async () => {
  await proxy.stop();
});

describe('real Dart HttpClient through the proxy', () => {
  it('`dart run <file> <proxyPort> <url>` usage works', async () => {
    const r = await dart(['run', FIXTURE, String(proxy.port), `${up.httpsUrl}/json`], {}, 'dart');
    expect(r).toMatchObject({ code: 0, status: 200, body: '{"hello":"world"}' });
    expect((await settled(proxy))[0]).toMatchObject({ state: 'completed', url: `${up.httpsUrl}/json` });
  }, 60_000);

  it('HTTPS pass-through is recorded', async () => {
    const r = await run(`${up.httpsUrl}/json`);
    expect(r).toMatchObject({ code: 0, status: 200, body: '{"hello":"world"}' });
    const [ex] = (await settled(proxy));
    expect(ex).toMatchObject({
      method: 'GET',
      url: `${up.httpsUrl}/json`,
      state: 'completed',
      status: 200,
      responseBody: { text: '{"hello":"world"}', encoding: 'utf8' },
    });
    expect(ex.requestHeaders['user-agent']).toMatch(/Dart/);
  });

  it('Dart opens a new tunnel per HTTPS request, but upstream TLS connections are reused', async () => {
    const before = up.connections.https;
    for (let i = 0; i < 3; i++) expect((await run(`${up.httpsUrl}/json`)).status).toBe(200);
    expect(up.connections.https - before).toBe(1);
  });

  it('HTTPS gzip pass-through: Dart auto-decompresses, proxy shows decoded text', async () => {
    const r = await run(`${up.httpsUrl}/gzip`);
    expect(r).toMatchObject({ status: 200, body: 'hello gzip world' });
    expect((await settled(proxy))[0].responseBody?.text).toBe('hello gzip world');
  });

  it('response breakpoint: the edited body arrives (plain and gzip)', async () => {
    proxy.setRules([{ id: 'bp', enabled: true, match: { url: '*' }, action: { kind: 'breakpoint', phase: 'response' } }]);
    for (const p of ['/json', '/gzip']) {
      const paused = nextExchange(proxy, inState('paused-response', p));
      const resP = run(`${up.httpsUrl}${p}`);
      const ex = await paused;
      proxy.resume(ex.id, { body: `{"edited":"${p} ✓"}` });
      const r = await resP;
      expect(r).toMatchObject({ code: 0, status: 200, body: `{"edited":"${p} ✓"}` });
    }
  });

  it('mock: Dart gets the mock, server never contacted', async () => {
    proxy.setRules([
      { id: 'm', enabled: true, match: { method: 'GET', url: '*/users/*' }, action: { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":1,"name":"Mock"}' } },
    ]);
    const r = await run(`${up.httpsUrl}/users/1`);
    expect(r).toMatchObject({ code: 0, status: 200, body: '{"id":1,"name":"Mock"}' });
    expect(up.hits).toEqual([]);
    expect((await settled(proxy))[0].state).toBe('mocked');
  });

  it('block (status): Dart gets the status, server never contacted', async () => {
    proxy.setRules([{ id: 'b', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'status', status: 503 } }]);
    const r = await run(`${up.httpsUrl}/json`);
    expect(r).toMatchObject({ code: 0, status: 503 });
    expect(up.hits).toEqual([]);
  });

  it('block (reset): Dart sees a connection error', async () => {
    proxy.setRules([{ id: 'b', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }]);
    for (const base of [up.httpsUrl, up.httpUrl]) {
      const r = await run(`${base}/json`);
      expect(r.code).toBe(2);
      expect(r.error).toMatch(/HttpException|SocketException|Connection (reset|closed)/);
    }
    expect(up.hits).toEqual([]);
    expect((await settled(proxy)).map((e) => e.state)).toEqual(['blocked', 'blocked']);
  });

  it('request breakpoint: edited URL and body reach the server', async () => {
    proxy.setRules([{ id: 'bp', enabled: true, match: { method: 'POST', url: '*/json' }, action: { kind: 'breakpoint', phase: 'request' } }]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = run(`${up.httpsUrl}/json`, 'POST', 'original');
    const ex = await paused;
    expect(ex.requestBody?.text).toBe('original');
    proxy.resume(ex.id, { url: `${up.httpsUrl}/echo?from=breakpoint`, body: 'edited ✓' });
    const r = await resP;
    expect(r.status).toBe(200);
    const echo = JSON.parse(r.body);
    expect(echo).toMatchObject({ method: 'POST', path: '/echo?from=breakpoint', body: 'edited ✓' });
    expect(echo.headers['content-length']).toBe(String(Buffer.byteLength('edited ✓')));
    expect(up.hits).toEqual(['POST /echo']);
  });

  it('request abort: Dart sees a connection error', async () => {
    proxy.setRules([{ id: 'bp', enabled: true, match: { url: '*' }, action: { kind: 'breakpoint', phase: 'request' } } satisfies Rule]);
    const paused = nextExchange(proxy, inState('paused-request'));
    const resP = run(`${up.httpsUrl}/json`);
    proxy.abort((await paused).id);
    const r = await resP;
    expect(r.code).toBe(2);
    expect(up.hits).toEqual([]);
  });

  it('client timeout while paused (Dio receiveTimeout analogue): proxy survives a late resume', async () => {
    proxy.setRules([{ id: 'bp', enabled: true, match: { url: '*/json' }, action: { kind: 'breakpoint', phase: 'response' } }]);
    const paused = nextExchange(proxy, inState('paused-response'));
    const resP = run(`${up.httpsUrl}/json`, 'GET', '', 1000);
    const ex = await paused;
    const errored = nextExchange(proxy, (e) => e.id === ex.id && e.state === 'error');
    const r = await resP;
    expect(r.error).toMatch(/TimeoutException/);
    expect((await errored).error).toMatch(/paused/);
    proxy.resume(ex.id, { body: 'too late' }); // no-op, must not throw or crash
    const again = await run(`${up.httpsUrl}/echo`);
    expect(again.status).toBe(200);
  });

  it('app that pins / rejects the proxy certificate shows up as a TLS error exchange', async () => {
    const errored = nextExchange(proxy, inState('error'));
    const r = await run(`${up.httpsUrl}/json`, 'GET', '', undefined, { DART_CLIENT_STRICT_TLS: '1' });
    expect(r.code).toBe(2);
    expect(r.error).toMatch(/HandshakeException|CERTIFICATE/i);
    const ex = await errored;
    expect(ex).toMatchObject({ method: 'CONNECT', state: 'error' });
    expect(ex.error).toMatch(/TLS handshake/);
  });
});
