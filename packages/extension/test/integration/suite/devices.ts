/**
 * Device suite (opt-in: FI_DEVICES=emulator-5554,<ios-sim-udid>,...): the shipped product on real
 * Flutter mobile targets. Workspace = samples/demo_app (plain Dio + package:http, no tool code).
 * Each launch is what F5 does: a Dart-Code launch config with only `deviceId` (no program).
 *
 * Per device:
 *  A. launch: entry + proxy host (emulator → 10.0.2.2, no adb reverse; others → localhost) + SHA define;
 *     the whole demo batch (Dio, http, HTTPS, gzip, plain http) recorded and printed unchanged.
 *  B. rules (mock / block / response breakpoint resumed with an edited body) + hot restart:
 *     the restarted app's batch prints the changed results → interception survives hot restart.
 *  C. stop → no adb reverse left for our port.
 *  D. APP_FINDPROXY=charles (app sets its own findProxy) → still intercepted + the v2 note.
 *  E. flutterIntercept.enabled=false → lib/main.dart launched directly, app works, nothing recorded.
 *  F. Android only: flutterMode=profile → intercepted.
 *  G. Android only: flutterMode=release → NOT intercepted (program untouched, app works, nothing recorded).
 *  H. flutterIntercept.captureSource=false → FLUTTER_INTERCEPT_TRACE=0 define, no exchange gets a source.
 *  I. (in A's session) CONTRACTS §13.3: the coverage batch's requests from Isolate.run / compute / Isolate.spawn
 *     isolates go through the proxy (template v5 installed at isolate start), no background-isolate warning for
 *     them; §13.8: src/screenshot through Dart-Code's callService (VM service) and through the device tool.
 *
 * Request → source (CONTRACTS §9, template v4), in A and after the hot restart in B: a Dio request made
 * through interceptors (CatalogApi.fetchAlbum) and a package:http request (OrdersApi.createOrder) carry
 * `source.appFrame` = their call site in lib/ (file + line looked up in the demo's source, resolved to the
 * workspace file by src/source/resolve.ts), `x-fi-id` is in no recorded request, and httpbin's echo of the
 * request headers it received (http_gzip, http_plain) shows the upstream never saw it.
 *
 * Physical iPhone (CONTRACTS §7, LAN mode) — double opt-in: FI_DEVICES=<udid> AND FI_ALLOW_PHYSICAL_IOS=1.
 *  A also asserts host = the Mac's default-route IPv4, a single `FLUTTER_INTERCEPT_PROXY=flutter-intercept:<token>@<lanIp>:<port>`
 *    define (token only there), `flutterInterceptLan`, the LAN listener open and shown in Status;
 *  C asserts the LAN listener closes after the last iPhone session; F/G (profile/release) run too.
 */
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Exchange } from '@flutter-intercept/proxy';
import type { HostMsg } from '../../../src/ui/protocol';
import { kindFromId } from '../../../src/iosDevices';
import { defaultRouteIPv4 } from '../../../src/lanAddress';
import { resolveFrames } from '../../../src/source/resolve';
import { takeScreenshot, type ScreenshotDeps } from '../../../src/screenshot';
import { vmCallService } from '../../../src/vm';
import { activateBoth, freePort, outputOf, registerOutputTracker, RunOutcome, sleep, startSession, stopSession, waitFor } from './helpers';

const JP = 'https://jsonplaceholder.typicode.com';
const URLS = {
  dio_user: { method: 'GET', url: `${JP}/users/1` },
  http_todo: { method: 'GET', url: `${JP}/todos/1` },
  dio_post: { method: 'POST', url: `${JP}/posts` },
  http_gzip: { method: 'GET', url: 'https://httpbin.org/gzip' },
  http_plain: { method: 'GET', url: 'http://httpbin.org/get?plain=1' },
  dio_user2: { method: 'GET', url: `${JP}/users/2` },
  http_comment: { method: 'GET', url: `${JP}/comments/1` },
  catalog_album: { method: 'GET', url: `${JP}/albums/1` },
  orders_create: { method: 'POST', url: `${JP}/todos` },
} as const;
type Label = keyof typeof URLS;
const NET_LABELS = Object.keys(URLS) as Label[];

interface DemoResult { status: string; body: string }

/** Call sites in samples/demo_app/lib whose requests must carry `source.appFrame` (CONTRACTS §9). */
const SOURCE_SITES = {
  // Dio through a sync and a QueuedInterceptor: the connection opens several async hops after the call.
  catalog_album: { file: 'api/catalog_api.dart', needle: "_dio.get<Object?>('https://jsonplaceholder.typicode.com/albums/", fn: 'CatalogApi.fetchAlbum' },
  // package:http with a long-lived Client.
  orders_create: { file: 'api/orders_api.dart', needle: 'return _client.post(', fn: 'OrdersApi.createOrder' },
} as const;

/** 1-based line of the first line of lib/<file> containing `needle`. */
function lineOf(root: string, file: string, needle: string): number {
  const lines = fs.readFileSync(path.join(root, 'lib', ...file.split('/')), 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${needle} not found in lib/${file}`);
  return i + 1;
}

const hasHeader = (headers: Record<string, unknown> | undefined, name: string) =>
  Object.keys(headers ?? {}).some((h) => h.toLowerCase() === name);

/** The app's own evidence lines (kept in results-devices.json). */
const evidence = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((l) => /DEMO_(START|RESULT|BATCH)|\[flutter_intercept\]|Restarted application|Launching|Built /.test(l))
    .join('\n');

/** DEMO_RESULT lines (last one per label) in `text`. */
function demoResults(text: string): Record<string, DemoResult> {
  const out: Record<string, DemoResult> = {};
  const re = /DEMO_RESULT (\w+) (\S+) ms=\d+ ?(.*)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out[m[1]] = { status: m[2], body: m[3] };
  return out;
}

const sameUrl = (e: Exchange, method: string, url: string) => e.method === method && e.url.replace(/^(https?:\/\/[^/]+):(443|80)\//, '$1/') === url;

function adbPath(): string {
  return path.join(process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library', 'Android', 'sdk'), 'platform-tools', 'adb');
}

function adbDevices(): string[] {
  try {
    return execFileSync(adbPath(), ['devices'], { encoding: 'utf8', timeout: 10_000 })
      .split('\n')
      .map((l) => /^(\S+)\s+device\b/.exec(l.trim())?.[1])
      .filter((x): x is string => !!x && x !== 'List');
  } catch {
    return [];
  }
}

function adbReverseList(serial: string): string {
  try {
    return execFileSync(adbPath(), ['-s', serial, 'reverse', '--list'], { encoding: 'utf8', timeout: 10_000 });
  } catch (e) {
    return `adb failed: ${String(e)}`;
  }
}

// samples/demo_app declares INTERNET only in its debug/profile manifests (Flutter's default
// template), so a release build cannot resolve hosts. For release we accept that specific
// failure: the check is "program untouched, nothing recorded, app ran".
const releaseOk = (r: DemoResult) =>
  /^2\d\d$/.test(r.status) || (r.status === 'ERR' && /Failed host lookup/.test(r.body)) ? undefined : `${r.status} ${r.body.slice(0, 120)}`;
const releaseWant = Object.fromEntries(NET_LABELS.map((l) => [l, releaseOk])) as Record<Label, (r: DemoResult) => string | undefined>;

export async function runDevicesSuite(): Promise<RunOutcome[]> {
  const devices = (process.env.FI_DEVICES ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  const results: RunOutcome[] = [];
  registerOutputTracker();
  const { api } = await activateBoth();
  const port = await freePort(); // never 8899
  const cfg = vscode.workspace.getConfiguration('flutterIntercept');
  await cfg.update('port', port, vscode.ConfigurationTarget.Global);
  await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  const folder = vscode.workspace.workspaceFolders![0];
  const root = folder.uri.fsPath;
  const entry = path.join(root, '.dart_tool', 'flutter_intercept', 'entry_lib__main.dart');
  const reply = (_m: HostMsg) => undefined;
  console.log(`[suite] devices ${devices.join(', ')} proxy port setting :${port} workspace ${root}`);
  if (api.getRules().length) throw new Error(`fresh profile has rules: ${JSON.stringify(api.getRules())}`);

  // Let the Flutter daemon discover devices (Dart-Code waits only 5 s for a deviceId).
  await sleep(15_000);

  function check(name: string, failures: string[], t0: number, extra: Partial<RunOutcome> = {}) {
    const out: RunOutcome = { name, output: '', proxyHits: [], failures, ms: Date.now() - t0, ...extra };
    results.push(out);
    console.log(`[suite] ${failures.length ? 'FAIL' : 'ok  '} ${name} (${out.ms} ms)${out.mode ? ` ${out.mode}` : ''}${failures.length ? `\n         ${failures.join('\n         ')}` : ''}`);
  }

  async function launch(name: string, deviceId: string, extra: Record<string, unknown> = {}) {
    const config: vscode.DebugConfiguration = { type: 'dart', request: 'launch', name, deviceId, ...extra };
    for (let attempt = 1; ; attempt++) {
      try {
        return await startSession(folder, config, 120_000);
      } catch (e) {
        if (attempt >= 3 || !String(e).includes('startDebugging returned false')) throw e;
        console.log(`[suite] ${name}: device not ready, retrying in 10 s`);
        await sleep(10_000);
      }
    }
  }

  /** Waits until the session printed `DEMO_BATCH done` `count` times after `from` chars. */
  async function waitBatch(session: vscode.DebugSession, from: number, timeoutMs: number): Promise<string> {
    await waitFor(() => (/DEMO_BATCH done/.test(outputOf(session).slice(from)) ? true : undefined), timeoutMs, 250);
    await sleep(300);
    return outputOf(session).slice(from);
  }

  /**
   * CONTRACTS §9: the Dio + http call sites resolve to their lib/ file and line; `x-fi-id` never reaches the
   * upstream (httpbin echoes the headers it got) nor the recorded request headers.
   */
  async function checkSources(since: number, failures: string[]): Promise<string> {
    const found: string[] = [];
    for (const [label, site] of Object.entries(SOURCE_SITES) as [keyof typeof SOURCE_SITES, (typeof SOURCE_SITES)[keyof typeof SOURCE_SITES]][]) {
      const { method, url } = URLS[label];
      let ex: Exchange;
      try {
        // The trace is posted ~100 ms after the request; both arrival orders are matched by the proxy.
        ex = await waitFor(() => api.getExchanges().find((e) => e.startedAt >= since && sameUrl(e, method, url) && e.source), 20_000, 200);
      } catch {
        const e = api.getExchanges().find((x) => x.startedAt >= since && sameUrl(x, method, url));
        failures.push(`${label}: no source on the exchange (${e ? `recorded, state ${e.state}` : 'not recorded'})`);
        continue;
      }
      const src = ex.source!;
      const frame = src.appFrame === undefined ? undefined : src.frames[src.appFrame];
      const wantUri = `package:demo_app/${site.file}`;
      const wantLine = lineOf(root, site.file, site.needle);
      if (!frame) {
        failures.push(`${label}: source has no appFrame: ${src.frames.slice(0, 6).map((f) => `${f.fn} ${f.uri}:${f.line}`).join(' | ')}`);
        continue;
      }
      if (frame.uri !== wantUri || frame.line !== wantLine || !frame.fn.startsWith(site.fn)) {
        failures.push(`${label}: appFrame ${frame.fn} ${frame.uri}:${frame.line}:${frame.column} != ${site.fn} ${wantUri}:${wantLine}`);
      }
      const [resolved] = resolveFrames([frame], [root]);
      const wantPath = path.join(root, 'lib', ...site.file.split('/'));
      if (resolved.path !== wantPath || !resolved.inProject) failures.push(`${label}: resolved to ${resolved.path} inProject=${resolved.inProject}, want ${wantPath}`);
      found.push(`${label}=${frame.fn}@${site.file}:${frame.line}`);
    }
    const recorded = api.getExchanges().filter((e) => e.startedAt >= since);
    const leaked = recorded.filter((e) => hasHeader(e.requestHeaders, 'x-fi-id'));
    if (leaked.length) failures.push(`x-fi-id in recorded request headers: ${leaked.map((e) => e.url).join(', ')}`);
    for (const label of ['http_gzip', 'http_plain'] as const) {
      const e = recorded.find((x) => sameUrl(x, URLS[label].method, URLS[label].url));
      let echoed: Record<string, unknown> | undefined;
      try {
        echoed = (JSON.parse(e?.responseBody?.text ?? '') as { headers?: Record<string, unknown> }).headers;
      } catch {
        echoed = undefined;
      }
      if (!echoed) failures.push(`${label}: no httpbin header echo to check (${(e?.responseBody?.text ?? '<no body>').slice(0, 80)})`);
      else if (hasHeader(echoed, 'x-fi-id')) failures.push(`${label}: the upstream received x-fi-id`);
    }
    return found.join(' ');
  }

  /** Checks that every network label printed `want` (default 2xx) and was recorded since `since`. */
  function checkBatch(text: string, since: number, expectRecorded: boolean, failures: string[], want: Partial<Record<Label, (r: DemoResult) => string | undefined>> = {}) {
    const res = demoResults(text);
    const recorded = api.getExchanges().filter((e) => e.startedAt >= since);
    for (const label of NET_LABELS) {
      const r = res[label];
      if (!r) {
        failures.push(`${label}: no DEMO_RESULT line`);
        continue;
      }
      const custom = want[label];
      const problem = custom ? custom(r) : /^2\d\d$/.test(r.status) ? undefined : `status ${r.status} ${r.body.slice(0, 120)}`;
      if (problem) failures.push(`${label}: ${problem}`);
      const { method, url } = URLS[label];
      const ex = recorded.filter((e) => sameUrl(e, method, url));
      if (expectRecorded && ex.length === 0) failures.push(`${label}: not recorded by the proxy`);
      if (!expectRecorded && ex.length > 0) failures.push(`${label}: recorded although interception is off`);
    }
    if (res.prefs?.status !== '200') failures.push(`prefs: ${JSON.stringify(res.prefs)}`);
    return { res, recorded };
  }

  for (const [i, dev] of devices.entries()) {
    const isEmu = /^emulator-\d+$/.test(dev);
    const isAndroid = isEmu || adbDevices().includes(dev);
    const tag = `${dev.slice(0, 13)}#${i + 1}`;
    // Physical iPhone (CONTRACTS §7, LAN mode): double opt-in, it runs on the user's own phone.
    const physicalIos = kindFromId(dev) === 'ios-physical';
    if (physicalIos && process.env.FI_ALLOW_PHYSICAL_IOS !== '1') {
      check(`DEV ${tag} physical iOS`, ['physical iPhone in FI_DEVICES but FI_ALLOW_PHYSICAL_IOS=1 is not set: skipped'], Date.now());
      continue;
    }
    const lanIp = physicalIos ? (await defaultRouteIPv4())?.address : undefined;
    const wantHost = physicalIos ? lanIp ?? '(no LAN address)' : isEmu ? '10.0.2.2' : 'localhost';
    await api.setRules([]);

    // ---- A. launch like F5 (deviceId only) ----
    let session: vscode.DebugSession | undefined;
    let t0 = Date.now();
    let failures: string[] = [];
    let since = Date.now();
    try {
      session = await launch(`FI-D A ${tag}`, dev);
      const c = session.configuration;
      if (c.program !== entry) failures.push(`program ${c.program}`);
      if (c.flutterInterceptOriginalProgram !== path.join(root, 'lib', 'main.dart')) failures.push(`original ${c.flutterInterceptOriginalProgram}`);
      if (c.flutterInterceptProxyHost !== wantHost) failures.push(`proxy host ${c.flutterInterceptProxyHost} != ${wantHost}`);
      if (c.debuggerType !== 2) failures.push(`debuggerType ${c.debuggerType}`);
      const sha = ((c.toolArgs ?? []) as string[]).filter((a) => a.startsWith('--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA='));
      if (sha.length !== 1) failures.push(`sha defines ${JSON.stringify(sha)}`);
      const proxyDefine = ((c.toolArgs ?? []) as string[]).filter((a) => a.startsWith('--dart-define=FLUTTER_INTERCEPT_PROXY='));
      if (physicalIos) {
        // flutter-intercept:<43-char base64url token>@<lanIp>:<port>; the token appears nowhere else.
        const re = new RegExp(`^--dart-define=FLUTTER_INTERCEPT_PROXY=flutter-intercept:([A-Za-z0-9_-]{43})@${(lanIp ?? '').replace(/\./g, '\\.')}:${c.flutterInterceptPort}$`);
        const m = proxyDefine.length === 1 ? re.exec(proxyDefine[0]) : null;
        if (!m) failures.push(`LAN proxy define has the wrong shape (${proxyDefine.length} define(s))`);
        else {
          const { toolArgs: _t, ...rest } = c;
          if (JSON.stringify(rest).includes(m[1])) failures.push('token leaked outside toolArgs');
        }
        if (c.flutterInterceptLan !== true) failures.push('flutterInterceptLan not set');
        if (api.proxyHost.lan?.host !== lanIp) failures.push(`LAN listener ${JSON.stringify(api.proxyHost.lan)} != ${lanIp}`);
        if (api.controller.status().lan?.host !== lanIp) failures.push('status does not show the LAN listener');
      } else if (proxyDefine.length !== 1 || proxyDefine[0] !== `--dart-define=FLUTTER_INTERCEPT_PROXY=${wantHost}:${c.flutterInterceptPort}`) {
        failures.push(`proxy define ${JSON.stringify(proxyDefine)}`);
      }
      const text = await waitBatch(session, 0, 600_000);
      const { recorded } = checkBatch(text, since, true, failures);
      const gz = recorded.find((e) => sameUrl(e, 'GET', URLS.http_gzip.url));
      const enc = String(gz?.responseHeaders?.['content-encoding'] ?? '');
      if (!gz || !/gzip/.test(enc) || !/"gzipped": ?true/.test(gz.responseBody?.text ?? '')) failures.push(`gzip exchange: enc=${enc} body=${gz?.responseBody?.text?.slice(0, 80)}`);
      const plain = recorded.find((e) => e.url.startsWith('http://httpbin.org/get'));
      if (!plain) failures.push('plain http not recorded');
      const sources = await checkSources(since, failures);
      if (isAndroid) {
        const list = adbReverseList(dev);
        if (list.includes(`tcp:${api.proxyHost.port}`)) failures.push(`adb reverse exists for an emulator: ${list.trim()}`);
      }
      check(`DEV ${tag} A launch (F5, deviceId only)`, failures, t0, { output: evidence(text), mode: `host=${c.flutterInterceptProxyHost} port=${c.flutterInterceptPort} exchanges=${recorded.length} ${sources}` });
    } catch (e) {
      check(`DEV ${tag} A launch (F5, deviceId only)`, [...failures, `exception: ${(e as Error).message}`], t0);
    }

    // ---- I. background isolates intercepted (§13.3) + screenshots (§13.8) ----
    if (session && !physicalIos) {
      t0 = Date.now();
      failures = [];
      const s = session;
      const notes: string[] = [];
      try {
        await waitFor(() => (/DEMO_COVERAGE done/.test(outputOf(s)) ? true : undefined), 180_000, 250);
        await sleep(500);
        const res = demoResults(outputOf(s));
        const isoUrls: Record<string, string> = { isolate_todo: `${JP}/todos/2`, compute_todo: `${JP}/todos/3`, spawn_todo: `${JP}/todos/4` };
        for (const [label, url] of Object.entries(isoUrls)) {
          const r = res[label];
          if (!r || r.status !== '200' || !r.body.includes('"overridesInIsolate":true')) failures.push(`${label}: ${r ? `${r.status} ${r.body.slice(0, 120)}` : 'no DEMO_RESULT'}`);
          const ex = api.getExchanges().filter((e) => e.startedAt >= since && sameUrl(e, 'GET', url));
          if (!ex.some((e) => e.captured !== 'vm-profile' && e.state === 'completed')) failures.push(`${label}: not recorded by the proxy (${ex.map((e) => `${e.state}/${e.captured ?? 'proxy'}`).join(', ') || 'nothing'})`);
          if (ex.some((e) => e.captured === 'vm-profile')) failures.push(`${label}: also imported from the HTTP profile (duplicate)`);
        }
        const warned = (api.controller.status().warnings ?? []).filter((w) => w.kind === 'background-isolate' && /demo_(worker|compute|spawn)/.test(w.text));
        if (warned.length) failures.push(`background-isolate warnings although intercepted: ${warned.map((w) => w.text).join(' | ')}`);
        // Screenshots: VM service through Dart-Code, then the device tool alone.
        const exec: ScreenshotDeps['exec'] = (cmd, args, opts) =>
          new Promise((resolve, reject) =>
            execFile(cmd, args, { encoding: 'buffer', timeout: opts?.timeoutMs ?? 20_000, maxBuffer: opts?.maxBuffer ?? 32 * 1024 * 1024 }, (err, stdout, stderr) =>
              err ? reject(err) : resolve({ stdout, stderr: String(stderr) }),
            ),
          );
        const log = (m: string) => notes.push(m);
        const vmShot = await takeScreenshot({ sessionId: s.id, deviceId: dev, projectRoot: root }, { callService: (_id, m, p) => vmCallService(s, m, p), exec, log });
        if (vmShot.method !== 'vm-service' || !vmShot.width || !vmShot.height || !fs.existsSync(vmShot.path)) failures.push(`VM screenshot: ${vmShot.method} ${vmShot.width}x${vmShot.height}`);
        if (!vmShot.path.startsWith(path.join(root, '.dart_tool', 'flutter_intercept', 'screenshots') + path.sep)) failures.push(`screenshot saved at ${vmShot.path}`);
        notes.push(`vm ${vmShot.width}x${vmShot.height} ${vmShot.png.length}B`);
        fs.rmSync(vmShot.path, { force: true });
        if (isAndroid || kindFromId(dev) === 'ios-simulator') {
          const toolShot = await takeScreenshot({ sessionId: s.id, deviceId: dev, projectRoot: root }, { exec, log });
          if (toolShot.method !== (isAndroid ? 'adb' : 'simctl') || !toolShot.width) failures.push(`tool screenshot: ${toolShot.method} ${toolShot.width}x${toolShot.height}`);
          notes.push(`${toolShot.method} ${toolShot.width}x${toolShot.height} ${toolShot.png.length}B`);
          fs.rmSync(toolShot.path, { force: true });
        }
        check(`DEV ${tag} I background isolates intercepted + screenshots`, failures, t0, { output: evidence(outputOf(s)).split('\n').filter((l) => /_todo/.test(l)).join('\n'), mode: notes.filter((n) => !/^screenshot:/.test(n)).join(' ') });
      } catch (e) {
        check(`DEV ${tag} I background isolates intercepted + screenshots`, [...failures, `exception: ${(e as Error).message}`], t0);
      }
    }

    // ---- B. rules + hot restart ----
    if (session) {
      t0 = Date.now();
      failures = [];
      try {
        api.setRules([
          { id: 'dev-mock', enabled: true, match: { method: 'GET', url: `${JP}*/users/2*` }, action: { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{"mocked":true}' } },
          { id: 'dev-block', enabled: true, match: { url: `${JP}*/comments/1*` }, action: { kind: 'block', mode: 'status', status: 403 } },
          { id: 'dev-bp', enabled: true, match: { method: 'GET', url: `${JP}*/todos/1*` }, action: { kind: 'breakpoint', phase: 'response' } },
        ]);
        const from = outputOf(session).length;
        since = Date.now();
        await session.customRequest('hotRestart');
        const paused = await waitFor(
          () => api.getExchanges().find((e) => e.startedAt >= since && e.state === 'paused-response' && sameUrl(e, 'GET', URLS.http_todo.url)),
          120_000,
          100,
        );
        const pausedCount = api.controller.pausedCount;
        await api.controller.handle({ type: 'resume', id: paused.id, edit: { body: '{"edited":true}' } }, reply);
        const text = await waitBatch(session, from, 120_000);
        if (!/DEMO_START/.test(text)) failures.push('no DEMO_START after hot restart');
        if (!/Restarted application/.test(text)) failures.push('no "Restarted application" line');
        const { recorded } = checkBatch(text, since, true, failures, {
          dio_user2: (r) => (r.status === '200' && r.body.includes('"mocked":true') ? undefined : `mock not applied: ${r.status} ${r.body}`),
          http_comment: (r) => (r.status === '403' && /Blocked by Flutter Intercept/.test(r.body) ? undefined : `block not applied: ${r.status} ${r.body}`),
          http_todo: (r) => (r.status === '200' && r.body.includes('"edited":true') ? undefined : `edit not applied: ${r.status} ${r.body}`),
        });
        const st = (l: Label) => recorded.find((e) => sameUrl(e, URLS[l].method, URLS[l].url))?.state;
        if (st('dio_user2') !== 'mocked') failures.push(`dio_user2 state ${st('dio_user2')}`);
        if (st('http_comment') !== 'blocked') failures.push(`http_comment state ${st('http_comment')}`);
        if (pausedCount < 1) failures.push(`paused count while paused = ${pausedCount}`);
        const sources = await checkSources(since, failures);
        check(`DEV ${tag} B mock+block+breakpoint edit after hot restart`, failures, t0, { output: evidence(text), mode: `pausedCount=${pausedCount} exchanges=${recorded.length} ${sources}` });
      } catch (e) {
        check(`DEV ${tag} B mock+block+breakpoint edit after hot restart`, [...failures, `exception: ${(e as Error).message}`], t0);
      }
      api.setRules([]);

      // ---- C. stop ----
      t0 = Date.now();
      failures = [];
      const stopped = await stopSession(session);
      if (!stopped) failures.push('session did not terminate');
      await sleep(1500);
      if (physicalIos) {
        await waitFor(() => (api.proxyHost.lan ? undefined : true), 10_000).catch(() => failures.push(`LAN listener still open after the last iPhone session: ${JSON.stringify(api.proxyHost.lan)}`));
      }
      if (isAndroid) {
        const list = adbReverseList(dev);
        if (list.includes(`tcp:${api.proxyHost.port}`)) failures.push(`adb reverse left behind: ${list.trim()}`);
      }
      check(`DEV ${tag} C stop leaves no adb reverse${physicalIos ? ' / closes the LAN listener' : ''}`, failures, t0);
    }

    // ---- D. APP_FINDPROXY=charles ----
    await runSimple(`DEV ${tag} D APP_FINDPROXY=charles still intercepted`, dev, { toolArgs: ['--dart-define=APP_FINDPROXY=charles'] }, true, (text, f) => {
      if (!/\[flutter_intercept\] ignored app findProxy/.test(text)) f.push('missing "[flutter_intercept] ignored app findProxy" note');
      if (!/findProxy=charles/.test(text)) f.push('app did not run in charles mode');
    });

    // ---- H. captureSource=false: no x-fi-id, no traces, no source ----
    const hStart = Date.now();
    await cfg.update('captureSource', false, vscode.ConfigurationTarget.Global);
    await runSimple(`DEV ${tag} H captureSource=false: no request sources`, dev, {}, true, (_t, f, c) => {
      const trace = ((c.toolArgs ?? []) as string[]).filter((a) => a.startsWith('--dart-define=FLUTTER_INTERCEPT_TRACE='));
      if (trace.length !== 1 || trace[0] !== '--dart-define=FLUTTER_INTERCEPT_TRACE=0') f.push(`trace define ${JSON.stringify(trace)}`);
      const withSource = api.getExchanges().filter((e) => e.startedAt >= hStart && e.source);
      if (withSource.length) f.push(`${withSource.length} exchange(s) got a source although capture is off`);
    });
    await cfg.update('captureSource', undefined, vscode.ConfigurationTarget.Global);

    // ---- E. interception off ----
    await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
    await runSimple(`DEV ${tag} E enabled=false launches lib/main.dart directly`, dev, {}, false, (_t, f, c) => {
      if (c.program !== path.join(root, 'lib', 'main.dart')) f.push(`program ${c.program}`);
      if (c.flutterInterceptOriginalProgram) f.push('config still carries flutterInterceptOriginalProgram');
    });
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);

    // ---- F/G. profile + release (Android and physical iOS; simulators have neither) ----
    if ((isAndroid || physicalIos) && i === devices.findIndex((d) => d === dev)) {
      await runSimple(`DEV ${tag} F flutterMode=profile`, dev, { flutterMode: 'profile' }, true, (text, f, c) => {
        if (c.program !== entry) f.push(`program ${c.program}`);
        if (!/profile/i.test(text)) f.push('no profile-mode build output');
      });
      // ---- G. release is never intercepted (template v2 relaxes certificate checks) ----
      await runSimple(`DEV ${tag} G flutterMode=release NOT intercepted`, dev, { flutterMode: 'release' }, false, (text, f, c) => {
        if (c.program !== path.join(root, 'lib', 'main.dart')) f.push(`program ${c.program}`);
        if (c.flutterInterceptOriginalProgram) f.push('config carries flutterInterceptOriginalProgram');
        if (((c.toolArgs ?? []) as string[]).some((a) => a.includes('FLUTTER_INTERCEPT_ENTRY_SHA'))) f.push('SHA define added');
        if (!/release/i.test(text)) f.push('no release-mode build output');
      }, releaseWant, physicalIos);
    }
  }
  return results;

  async function runSimple(
    name: string,
    dev: string,
    extra: Record<string, unknown>,
    intercept: boolean,
    more: (text: string, failures: string[], conf: vscode.DebugConfiguration) => void,
    want: Partial<Record<Label, (r: DemoResult) => string | undefined>> = {},
    // iOS release builds don't forward print() to the debug console, so there is no DEMO_BATCH line to
    // wait for: wait for the release build, give the app time to make its requests, then only check that
    // nothing was rewritten or recorded.
    silentApp = false,
  ) {
    const t0 = Date.now();
    const failures: string[] = [];
    let session: vscode.DebugSession | undefined;
    try {
      await api.setRules([]);
      const since = Date.now();
      session = await launch(name.replace(/^DEV /, 'FI-D '), dev, extra);
      let text: string;
      let recorded: Exchange[];
      if (silentApp && !intercept) {
        const s = session;
        await waitFor(() => (/release/i.test(outputOf(s)) ? true : undefined), 900_000, 500);
        await sleep(30_000);
        text = outputOf(s);
        recorded = api.getExchanges().filter((e) => e.startedAt >= since);
        if (recorded.length) failures.push(`${recorded.length} exchange(s) recorded although release is never intercepted`);
      } else {
        text = await waitBatch(session, 0, 900_000);
        ({ recorded } = checkBatch(text, since, intercept, failures, want));
      }
      more(text, failures, session.configuration);
      check(name, failures, t0, { output: evidence(text), mode: `program=${path.relative(root, session.configuration.program)} exchanges=${recorded.length}` });
    } catch (e) {
      check(name, [...failures, `exception: ${(e as Error).message}`], t0);
    } finally {
      if (session) await stopSession(session).catch(() => false);
      await sleep(1500);
    }
  }
}
