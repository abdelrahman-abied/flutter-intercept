/**
 * Web suite (FI_SUITE=web, CONTRACTS §11.3): samples/web_app (Dio browser adapter + package:http, no tool
 * code) launched on the `chrome` device through the real extension and Dart-Code, exactly like F5.
 * Headless Chrome by default (`--web-browser-flag=--headless=new` in the user's toolArgs, which also proves our
 * flags coexist with the user's); FI_WEB_HEADFUL=1 shows the window.
 *
 *  A. launch: program NOT rewritten (lib/main.dart), exactly one proxy + one SPKI browser flag, host 127.0.0.1;
 *     every app request recorded by the proxy with its status (HTTPS MITM accepted by Chrome through the CA's
 *     SPKI pin alone), each with the app's `Origin`; the dev server / DWDS on loopback NOT recorded;
 *     a breakpoint in lib/main.dart is hit and resumed (Dart-Code debugging works through the proxy).
 *  B. CORS diagnosis (proxy, CONTRACTS §11.3): preflights flagged; the Wikipedia call (no ACAO) has `cors.problem`.
 *  C. rules + hot restart: a mock on GET /users/2 (sent with a custom header → preflight) answers the
 *     preflight itself and the app gets the mocked body; a `cors` rule makes the CORS-refused call readable.
 *  D. reloaded order (our hook before Dart-Code's): same launch result.
 *  E. flutterIntercept.web.enabled=false: no flags, app works, nothing recorded.
 *  F. web-server device: not intercepted, with the one-time notice reason.
 *  v0.8.0 (CONTRACTS §14.7), in the A-C session:
 *  G. web screenshot: `Page.captureScreenshot` over CDP on the debug Chrome's port (`--web-browser-debug-port` we add).
 *  H. DIRECT fallback: the proxy is stopped mid-session; after a hot restart every call still works (PAC
 *     `PROXY 127.0.0.1:<port>; DIRECT`) and nothing is recorded; the proxy is started again afterwards.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { Exchange } from '@flutter-intercept/proxy';
import { webBrowserDebugPortOf } from '../../../src/debug/rewrite';
import { captureWebPng } from '../../../src/web/screenshot';
import { activateBoth, freePort, outputOf, registerOutputTracker, RunOutcome, sleep, startSession, stopSession, waitFor } from './helpers';

const JP = 'https://jsonplaceholder.typicode.com';
const WIKI = 'https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json';
const REQUESTS = {
  http_todo: [{ method: 'GET', url: `${JP}/todos/1` }],
  dio_user: [{ method: 'GET', url: `${JP}/users/1` }],
  dio_post: [{ method: 'OPTIONS', url: `${JP}/posts` }, { method: 'POST', url: `${JP}/posts` }],
  http_post: [{ method: 'OPTIONS', url: `${JP}/todos` }, { method: 'POST', url: `${JP}/todos` }],
  dio_profile: [{ method: 'OPTIONS', url: `${JP}/users/2` }, { method: 'GET', url: `${JP}/users/2` }],
  cors_blocked: [{ method: 'GET', url: WIKI }],
} as const;
type Label = keyof typeof REQUESTS;
const LABELS = Object.keys(REQUESTS) as Label[];

interface WebResult { status: string; body: string }

function webResults(text: string): Record<string, WebResult> {
  const out: Record<string, WebResult> = {};
  const re = /WEB_RESULT (\w+) (\S+) ms=\d+ ?(.*)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out[m[1]] = { status: m[2], body: m[3] };
  return out;
}

const header = (h: Record<string, string | string[]> | undefined, name: string): string | undefined => {
  const v = Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(v) ? v[0] : v;
};
const sameUrl = (e: Exchange, method: string, url: string) => e.method === method && e.url.replace(/^(https?:\/\/[^/]+):(443|80)\//, '$1/') === url;
const evidence = (text: string) => text.split(/\r?\n/).filter((l) => /WEB_(START|RESULT|BATCH)|Launching|Restarted application|Debug service/.test(l)).join('\n');

/** Debug-adapter `stopped` events per session (breakpoint check). */
const stops = new Map<string, { reason: string; threadId: number }[]>();
let stopTracker = false;
function registerStopTracker(): void {
  if (stopTracker) return;
  stopTracker = true;
  vscode.debug.registerDebugAdapterTrackerFactory('dart', {
    createDebugAdapterTracker(session) {
      return {
        onDidSendMessage(m: any) {
          if (m?.type === 'event' && m.event === 'stopped') {
            stops.set(session.id, [...(stops.get(session.id) ?? []), { reason: m.body?.reason, threadId: m.body?.threadId }]);
          }
        },
      };
    },
  });
}

export async function runWebSuite(): Promise<RunOutcome[]> {
  const results: RunOutcome[] = [];
  registerOutputTracker();
  registerStopTracker();
  const { api } = await activateBoth();
  const port = await freePort(); // never 8899
  const cfg = vscode.workspace.getConfiguration('flutterIntercept');
  await cfg.update('port', port, vscode.ConfigurationTarget.Global);
  await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  await cfg.update('web.enabled', true, vscode.ConfigurationTarget.Global);
  api.setRules([]);
  const folder = vscode.workspace.workspaceFolders![0];
  const root = folder.uri.fsPath;
  const main = path.join(root, 'lib', 'main.dart');
  const userArgs = process.env.FI_WEB_HEADFUL === '1' ? [] : ['--web-browser-flag=--headless=new'];
  console.log(`[suite] web: proxy port setting :${port} workspace ${root} ${userArgs.length ? 'headless' : 'headful'}`);
  await sleep(10_000); // the Flutter daemon discovers devices

  function check(name: string, failures: string[], t0: number, extra: Partial<RunOutcome> = {}) {
    const out: RunOutcome = { name, output: '', proxyHits: [], failures, ms: Date.now() - t0, ...extra };
    results.push(out);
    console.log(`[suite] ${failures.length ? 'FAIL' : 'ok  '} ${name} (${out.ms} ms)${out.mode ? ` ${out.mode}` : ''}${failures.length ? `\n         ${failures.join('\n         ')}` : ''}`);
  }

  async function launch(name: string, extra: Record<string, unknown> = {}) {
    const config: vscode.DebugConfiguration = { type: 'dart', request: 'launch', name, program: 'lib/main.dart', deviceId: 'chrome', suppressPrompts: true, toolArgs: [...userArgs], ...extra };
    for (let attempt = 1; ; attempt++) {
      try {
        return await startSession(folder, config, 180_000);
      } catch (e) {
        if (attempt >= 3 || !String(e).includes('startDebugging returned false')) throw e;
        console.log(`[suite] ${name}: device not ready, retrying in 10 s`);
        await sleep(10_000);
      }
    }
  }

  async function waitBatch(session: vscode.DebugSession, from: number, timeoutMs = 240_000): Promise<string> {
    await waitFor(() => (/WEB_BATCH done/.test(outputOf(session).slice(from)) ? true : undefined), timeoutMs, 250);
    await sleep(1500); // the proxy finishes recording (response bodies) after the app printed
    return outputOf(session).slice(from);
  }

  /** The final config the debug adapter got: program untouched + exactly our two flags. */
  function checkConfig(c: vscode.DebugConfiguration, failures: string[]) {
    if (c.program !== main) failures.push(`program ${c.program} != ${main} (web sessions are never rewritten)`);
    if (c.flutterInterceptProxyHost !== '127.0.0.1') failures.push(`proxy host ${c.flutterInterceptProxyHost}`);
    if (c.flutterInterceptPort !== api.proxyHost.port) failures.push(`port ${c.flutterInterceptPort} != proxy ${api.proxyHost.port}`);
    if (c.debuggerType !== 2) failures.push(`debuggerType ${c.debuggerType} (want Flutter 2)`);
    const args = (c.toolArgs ?? []) as string[];
    const proxy = args.filter((a) => /^--web-browser-flag=--proxy-(server|pac-url)=/.test(a));
    const pin = args.filter((a) => a.startsWith('--web-browser-flag=--ignore-certificate-errors-spki-list='));
    // v0.8.0: a loopback PAC URL (DIRECT fallback) for this proxy port.
    const pac = new RegExp(`^--web-browser-flag=--proxy-pac-url=http://127\\.0\\.0\\.1:\\d+/flutter-intercept-${api.proxyHost.port}\\.pac$`);
    if (proxy.length !== 1 || !pac.test(proxy[0])) failures.push(`proxy flags ${JSON.stringify(proxy)}`);
    if (args.filter((a) => a.startsWith('--web-browser-debug-port=')).length !== 1 || !webBrowserDebugPortOf(c)) failures.push(`debug port flag missing: ${args.join(' ')}`);
    if (pin.length !== 1 || !/=[A-Za-z0-9+/]{43}=$/.test(pin[0])) failures.push(`SPKI flags ${JSON.stringify(pin)}`);
    if (args.some((a) => a.includes('FLUTTER_INTERCEPT_'))) failures.push(`entry defines on a web session: ${args.join(' ')}`);
    for (const a of userArgs) if (!args.includes(a)) failures.push(`user toolArg ${a} lost`);
  }

  /** Every request of the batch recorded (status, Origin); results printed by the app. */
  function checkBatch(text: string, since: number, failures: string[], want: Partial<Record<Label, (r: WebResult) => string | undefined>>): Exchange[] {
    const res = webResults(text);
    for (const l of LABELS) {
      const r = res[l];
      if (!r) { failures.push(`${l}: no WEB_RESULT line`); continue; }
      const bad = want[l]?.(r);
      if (bad) failures.push(`${l}: ${bad}`);
    }
    const recorded = api.getExchanges().filter((e) => e.startedAt >= since);
    for (const l of LABELS) {
      for (const { method, url } of REQUESTS[l]) {
        const e = recorded.find((x) => sameUrl(x, method, url));
        if (!e) { failures.push(`${l}: ${method} ${url} not recorded`); continue; }
        if (typeof e.status !== 'number') failures.push(`${l}: ${method} recorded without status (state ${e.state} ${e.error ?? ''})`);
        if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(header(e.requestHeaders, 'origin') ?? '')) failures.push(`${l}: ${method} Origin ${header(e.requestHeaders, 'origin')}`);
      }
    }
    const loopback = recorded.filter((e) => /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(e.url));
    if (loopback.length) failures.push(`loopback traffic went through the proxy (dev server/DWDS must stay direct): ${loopback.map((e) => e.url).slice(0, 3).join(', ')}`);
    return recorded;
  }

  const ok = (status: string) => (r: WebResult) => (r.status === status ? undefined : `${r.status} ${r.body.slice(0, 160)}`);
  const real = { http_todo: ok('200'), dio_user: ok('200'), dio_post: ok('201'), http_post: ok('201'), dio_profile: ok('200'), cors_blocked: ok('ERR') };

  // ---- A. launch + B. CORS diagnosis + C. rules after hot restart ----
  let session: vscode.DebugSession | undefined;
  let t0 = Date.now();
  let failures: string[] = [];
  let since = Date.now();
  // Breakpoint on the batch's last line (hit after every request of the first batch).
  const bpLine = (await vscode.workspace.openTextDocument(main)).getText().split(/\r?\n/).findIndex((l) => l.includes("print('WEB_BATCH done"));
  const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(main), new vscode.Position(bpLine, 0)));
  vscode.debug.addBreakpoints([bp]);
  try {
    session = await launch('FI-W natural');
    const id = session.id;
    const stop = await waitFor(() => stops.get(id)?.find((s) => s.reason === 'breakpoint'), 240_000, 250).catch(() => undefined);
    if (!stop) failures.push(`breakpoint at lib/main.dart:${bpLine + 1} not hit`);
    vscode.debug.removeBreakpoints([bp]);
    if (stop) await session.customRequest('continue', { threadId: stop.threadId });
    const text = await waitBatch(session, 0);
    checkConfig(session.configuration, failures);
    const recorded = checkBatch(text, since, failures, real);
    check('FI-W A launch on chrome (flags, all requests recorded, breakpoint)', failures, t0, {
      output: evidence(text),
      proxyHits: recorded.map((e) => `${e.state} ${e.status ?? '-'} ${e.method} ${e.url}`),
      mode: `exchanges=${recorded.length} breakpoint=${stop ? 'hit' : 'missed'}`,
    });

    // B. CORS diagnosis on what A recorded.
    t0 = Date.now();
    failures = [];
    const find = (method: string, url: string) => recorded.find((x) => sameUrl(x, method, url));
    for (const [m, u] of [['OPTIONS', `${JP}/posts`], ['OPTIONS', `${JP}/todos`], ['OPTIONS', `${JP}/users/2`]]) {
      if (!find(m, u)?.cors?.preflight) failures.push(`${m} ${u}: cors.preflight not set (${JSON.stringify(find(m, u)?.cors)})`);
    }
    const wiki = find('GET', WIKI);
    if (!wiki?.cors?.problem) failures.push(`Wikipedia (no ACAO): cors.problem not set (${JSON.stringify(wiki?.cors)}, status ${wiki?.status})`);
    for (const [m, u] of [['GET', `${JP}/todos/1`], ['POST', `${JP}/posts`]]) if (find(m, u)?.cors?.problem) failures.push(`${m} ${u}: unexpected cors.problem ${find(m, u)?.cors?.problem}`);
    check('FI-W B CORS diagnosis (preflights flagged, refused call explained)', failures, t0, { mode: `wiki.cors=${JSON.stringify(wiki?.cors)}` });

    // C. mock + cors rules, hot restart.
    t0 = Date.now();
    failures = [];
    api.setRules([
      { id: 'web-mock', enabled: true, match: { method: 'GET', url: `${JP}/users/2` }, action: { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{"mocked":"web"}' } },
      { id: 'web-cors', enabled: true, match: { url: 'https://en.wikipedia.org/w/api.php*' }, action: { kind: 'cors' } },
    ]);
    // Chrome caches preflights (5 s when the server sends no Access-Control-Max-Age, as jsonplaceholder):
    // wait it out, or the restarted batch reuses A's real preflights and the mock's preflight answer is never asked.
    await sleep(6000);
    const from = outputOf(session).length;
    since = Date.now();
    await session.customRequest('hotRestart');
    const text2 = await waitBatch(session, from);
    if (!/WEB_START/.test(text2)) failures.push('no WEB_START after hot restart');
    const recorded2 = checkBatch(text2, since, failures, {
      ...real,
      dio_profile: (r) => (r.status === '200' && r.body.includes('"mocked":"web"') ? undefined : `mock not seen by the app (preflight?): ${r.status} ${r.body.slice(0, 160)}`),
      cors_blocked: (r) => (r.status === '200' ? undefined : `cors rule did not unblock: ${r.status} ${r.body.slice(0, 160)}`),
    });
    const pre = recorded2.find((e) => sameUrl(e, 'OPTIONS', `${JP}/users/2`));
    const got = recorded2.find((e) => sameUrl(e, 'GET', `${JP}/users/2`));
    const origin = header(got?.requestHeaders, 'origin');
    if (pre?.status !== 204 || header(pre?.responseHeaders, 'access-control-allow-origin') !== origin) failures.push(`mock preflight: ${pre?.status} ACAO=${header(pre?.responseHeaders, 'access-control-allow-origin')} (want 204, ${origin})`);
    if (got?.state !== 'mocked' || header(got?.responseHeaders, 'access-control-allow-origin') !== origin) failures.push(`mocked GET: state ${got?.state} ACAO=${header(got?.responseHeaders, 'access-control-allow-origin')}`);
    check('FI-W C mock answers the preflight + cors rule, after hot restart', failures, t0, {
      output: evidence(text2),
      proxyHits: recorded2.map((e) => `${e.state} ${e.status ?? '-'} ${e.method} ${e.url}`),
    });

    // G. web screenshot over CDP (loopback, the debug port the provider gave the browser).
    t0 = Date.now();
    failures = [];
    let shotInfo = '';
    try {
      const png = await captureWebPng(webBrowserDebugPortOf(session.configuration) ?? 0);
      shotInfo = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)} ${png.length} bytes`;
      if (png.length < 1000) failures.push(`tiny screenshot ${shotInfo}`);
    } catch (e) {
      failures.push(`screenshot: ${(e as Error).message}`);
    }
    check('FI-W G web screenshot over CDP', failures, t0, { mode: shotInfo });

    // H. DIRECT fallback: stop the proxy mid-session, hot restart, the app keeps its network.
    t0 = Date.now();
    failures = [];
    api.setRules([]);
    await api.proxyHost.stop();
    await sleep(1000);
    const from3 = outputOf(session).length;
    since = Date.now();
    await session.customRequest('hotRestart');
    const text3 = await waitBatch(session, from3);
    const res3 = webResults(text3);
    for (const [l, want] of Object.entries({ http_todo: '200', dio_user: '200', dio_post: '201', http_post: '201', dio_profile: '200' })) {
      if (res3[l]?.status !== want) failures.push(`${l} with the proxy stopped: ${res3[l]?.status} ${res3[l]?.body?.slice(0, 120)} (want ${want}, DIRECT)`);
    }
    const leaked = api.getExchanges().filter((e) => e.startedAt >= since && e.url.startsWith(JP));
    if (leaked.length) failures.push(`${leaked.length} requests recorded while the proxy was stopped`);
    await api.proxyHost.start();
    check('FI-W H DIRECT fallback (proxy stopped mid-session, hot restart)', failures, t0, { output: evidence(text3) });
  } catch (e) {
    check('FI-W A-H', [...failures, `exception: ${(e as Error).message}`], t0, { output: session ? evidence(outputOf(session)) : '' });
  } finally {
    vscode.debug.removeBreakpoints([bp]);
    api.setRules([]);
    if (session) await stopSession(session);
  }

  // ---- D. reloaded order: our hook runs before Dart-Code's ----
  console.log('[suite] executing _dart.reloadExtension (Dart-Code in-process restart)');
  await vscode.commands.executeCommand('_dart.reloadExtension', 'flutter-intercept-test');
  await sleep(15_000);
  t0 = Date.now();
  failures = [];
  session = undefined;
  try {
    const before = api.events.length;
    since = Date.now();
    session = await launch('FI-W reloaded');
    const text = await waitBatch(session, 0);
    const ev = api.events.slice(before).find((e) => e.hook === 'resolveDebugConfigurationWithSubstitutedVariables');
    checkConfig(session.configuration, failures);
    checkBatch(text, since, failures, real);
    check('FI-W D reloaded (our hook before Dart-Code)', failures, t0, { output: evidence(text), dartCodeRanFirst: ev?.dartCodeRanFirst, mode: `${ev?.mode} dartCodeRanFirst=${ev?.dartCodeRanFirst}` });
  } catch (e) {
    check('FI-W D reloaded', [...failures, `exception: ${(e as Error).message}`], t0);
  } finally {
    if (session) await stopSession(session);
  }

  // ---- E. web interception off ----
  t0 = Date.now();
  failures = [];
  session = undefined;
  await cfg.update('web.enabled', false, vscode.ConfigurationTarget.Global);
  try {
    since = Date.now();
    session = await launch('FI-W off');
    const text = await waitBatch(session, 0);
    const c = session.configuration;
    if ((c.toolArgs ?? []).some((a: string) => /proxy-server|proxy-pac-url|spki-list|web-browser-debug-port/.test(a))) failures.push(`browser flags present: ${c.toolArgs}`);
    if (c.flutterInterceptPort !== undefined) failures.push('flutterInterceptPort set');
    const res = webResults(text);
    if (res.http_todo?.status !== '200') failures.push(`app without interception: http_todo ${res.http_todo?.status}`);
    const hits = api.getExchanges().filter((e) => e.startedAt >= since && e.url.startsWith(JP));
    if (hits.length) failures.push(`${hits.length} requests recorded with web interception off`);
    check('FI-W E flutterIntercept.web.enabled=false', failures, t0, { output: evidence(text) });
  } catch (e) {
    check('FI-W E web off', [...failures, `exception: ${(e as Error).message}`], t0);
  } finally {
    if (session) await stopSession(session);
    await cfg.update('web.enabled', true, vscode.ConfigurationTarget.Global);
  }

  // ---- F. web-server: not intercepted (no launch needed: the eager path decides) ----
  t0 = Date.now();
  failures = [];
  try {
    const before = api.events.length;
    const c = await api.prepare(folder, { type: 'dart', request: 'launch', name: 'FI-W web-server', program: 'lib/main.dart', deviceId: 'web-server' });
    if ((c.toolArgs ?? []).length || c.flutterInterceptPort !== undefined || !String(c.program).endsWith('lib/main.dart')) failures.push(`config changed: ${JSON.stringify(c)}`);
    const ev = api.events.slice(before).pop();
    if (ev?.result !== 'skip' || !/web-server device/.test(ev.reason ?? '')) failures.push(`event ${JSON.stringify(ev)}`);
    check('FI-W F web-server skipped with a reason', failures, t0, { mode: ev?.reason });
  } catch (e) {
    check('FI-W F web-server', [...failures, `exception: ${(e as Error).message}`], t0);
  }
  return results;
}
