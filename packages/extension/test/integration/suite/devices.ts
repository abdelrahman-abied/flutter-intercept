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
 *     them, and no §14.7 `bypass` warning; §13.8: src/screenshot through Dart-Code's callService (VM service) and through the device tool.
 *  J. Android emulator, CONTRACTS §14.7 (docs/spikes/native-proxy.md): APP_ZONE_OVERRIDES=true + NATIVE_HTTP=true.
 *     Bypass detection: the extension's own VM watcher shows `bypass` warnings for the app's own-zone HttpClient
 *     hosts. Native routing (src/adb.ts AndroidGlobalProxy + a src/vm watcher with nativeClients "proxy", built
 *     here so the check doesn't depend on the host wiring): cronet goes to the proxy, rejects its CA (the demo has
 *     no debug network_security_config), the core reports the trust failure, routing is released and
 *     `http_proxy` is back to its previous value. `FI_DEVICES_ONLY=J` runs only this check.
 *  K. CONTRACTS §16 (template v6, gRPC): scripts/e2e/grpc_server on the host (h2c + TLS, self-signed) and the
 *     demo's gRPC batch (GRPC_PORT / GRPC_TLS_PORT defines, lib/grpc_demo.dart). K1: unary, server / client /
 *     bidi streaming and a NOT_FOUND call are recorded as `kind: "grpc"` with their status and message counts,
 *     the Isolate.run call too (installed at isolate start), the TLS call as an undecrypted `grpcTunnel`; a
 *     `grpcMock` rule (code 14) answers GetOrder after a hot restart. K2: `flutterIntercept.grpc.enabled: false`
 *     → `FLUTTER_INTERCEPT_GRPC=0` define, the calls work direct and nothing gRPC is recorded.
 *     `FI_DEVICES_ONLY=K` runs only this check; `FI_GRPC_PORT` picks the server port (default: a free one).
 *  L. CONTRACTS §19.3, booted iOS simulator only and only with FI_SIM_TRUST=1 (it changes the simulator's trust
 *     store for the session): `flutterIntercept.grpc.trustOnSimulator: true` → the CA's row is in the simulator's
 *     TrustStore while the session runs, the demo's TLS call (GRPC_TLS_PORT; its onBadCertificate accepts only the
 *     real server, so it succeeds only through OS trust) is recorded decrypted (`kind: "grpc"`, status 0, messages
 *     both ways); after the session ends the row is gone (or still there when it pre-existed) and the setting is
 *     restored. `FI_DEVICES_ONLY=L` runs only this check.
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
import { execFile, execFileSync, spawn } from 'child_process';
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
import { createVmWatcher, vmCallService } from '../../../src/vm';
import { AndroidGlobalProxy } from '../../../src/adb';
import { caFingerprint, defaultExec as simExec, IosSimTrust, nodeFs, parseSimulators, readTrustRow, SQLITE3, trustStorePath, XCRUN } from '../../../src/iosSimTrust';
import type { SessionWarning } from '../../../src/ui/protocol';
import { activateBoth, freePort, freePortPair, outputOf, registerOutputTracker, RunOutcome, sleep, startSession, stopSession, waitFor } from './helpers';

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
    .filter((l) => /DEMO_(START|RESULT|BATCH|GRPC)|\[flutter_intercept\]|Restarted application|Launching|Built /.test(l))
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

    // ---- J. bypass detection + native clients through the proxy (§14.7) ----
    if (isEmu && (!process.env.FI_DEVICES_ONLY || process.env.FI_DEVICES_ONLY === 'J')) await checkJ(dev, tag);
    if (process.env.FI_DEVICES_ONLY === 'J') continue;

    // ---- K. gRPC (§16, template v6) ----
    if (!physicalIos && (!process.env.FI_DEVICES_ONLY || process.env.FI_DEVICES_ONLY === 'K')) await checkK(dev, tag);
    if (process.env.FI_DEVICES_ONLY === 'K') continue;

    // ---- L. iOS simulator CA trust (§19.3): opt-in twice (FI_SIM_TRUST=1 and a simulator id) ----
    if (kindFromId(dev) === 'ios-simulator' && process.env.FI_SIM_TRUST === '1' && (!process.env.FI_DEVICES_ONLY || process.env.FI_DEVICES_ONLY === 'L')) await checkL(dev, tag);
    if (process.env.FI_DEVICES_ONLY === 'L') continue;

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
        // §14.7: nothing in a normal intercepted session bypasses the proxy (no false positives).
        const bypassed = (api.controller.status().warnings ?? []).filter((w) => w.kind === 'bypass' && w.sessionId === s.id);
        if (bypassed.length) failures.push(`bypass warnings in an intercepted session: ${bypassed.map((w) => w.text).join(' | ')}`);
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

  async function checkJ(dev: string, tag: string) {
    const name = `DEV ${tag} J bypass warnings + native clients routed (Android global proxy)`;
    const t0 = Date.now();
    const failures: string[] = [];
    const notes: string[] = [];
    const adb = (...args: string[]) => execFileSync('adb', ['-s', dev, ...args], { encoding: 'utf8' }).trim();
    const before = adb('shell', 'settings', 'get', 'global', 'http_proxy');
    const key = 'suite-J';
    const gp = new AndroidGlobalProxy({ log: (m) => notes.push(m) });
    const routeFailures: (string | undefined)[] = [];
    const ownWarnings = new Map<string, SessionWarning[]>();
    const watcher = createVmWatcher({
      record: () => [],
      update: () => undefined,
      setWarnings: (sid, w) => ownWarnings.set(sid, w),
      log: () => undefined,
      nativeClients: () => 'proxy',
      backgroundIsolates: () => 'warn', // the extension's own watcher installs; this one only reads
      nativeRouted: () => gp.isRouted(key),
      nativeRouteFailed: (_sid, client) => {
        routeFailures.push(client);
        void gp.release(key);
      },
    });
    let session: vscode.DebugSession | undefined;
    try {
      const applied = await gp.apply(key, dev, api.proxyHost.port || port);
      if (!applied.applied) failures.push(`global proxy not applied: ${JSON.stringify(applied)}`);
      notes.push(`http_proxy during: ${adb('shell', 'settings', 'get', 'global', 'http_proxy')}`);
      session = await launch(`FI-D J ${tag}`, dev, { toolArgs: ['--dart-define=APP_ZONE_OVERRIDES=true', '--dart-define=NATIVE_HTTP=true'] });
      void watcher.attach({ sessionId: session.id });
      const s = session;
      await waitFor(() => (/DEMO_COVERAGE done/.test(outputOf(s)) ? true : undefined), 600_000, 250);
      await sleep(4000);
      const res = demoResults(outputOf(s));
      const bypass = (api.controller.status().warnings ?? []).filter((w) => w.kind === 'bypass' && w.sessionId === s.id);
      if (!bypass.some((w) => /jsonplaceholder\.typicode\.com bypass the proxy: an HttpOverrides zone/.test(w.text))) {
        failures.push(`no bypass warning for jsonplaceholder.typicode.com: ${bypass.map((w) => w.text).join(' | ') || 'none'}`);
      }
      notes.push(`bypass hosts: ${bypass.map((w) => /Requests to (\S+)/.exec(w.text)?.[1]).join(',')}`);
      const ng = res.native_get;
      if (!ng || ng.status !== 'ERR' || !/CERT_AUTHORITY_INVALID/.test(ng.body)) failures.push(`native_get through the proxy should fail the CA check: ${ng ? `${ng.status} ${ng.body.slice(0, 120)}` : 'no result'}`);
      if (!routeFailures.includes('cronet_http')) failures.push(`trust failure not reported (${JSON.stringify(routeFailures)})`);
      const route = (ownWarnings.get(s.id) ?? []).find((w) => w.id === `native-route:${s.id}`);
      if (!route || !/^cronet_http rejected the proxy's certificate/.test(route.text)) failures.push(`route warning: ${route?.text ?? 'none'}`);
      await waitFor(() => (gp.isRouted(key) ? undefined : true), 10_000).catch(() => failures.push('routing not released after the trust failure'));
      const after = adb('shell', 'settings', 'get', 'global', 'http_proxy');
      if (after !== before) failures.push(`http_proxy ${after} after release (was ${before})`);
      if (adb('shell', 'settings', 'get', 'global', 'global_http_proxy_host') !== '' && before === 'null') failures.push('ConnectivityService global proxy still set');
    } catch (e) {
      failures.push(`exception: ${(e as Error).message}`);
    } finally {
      watcher.dispose();
      await gp.releaseAll();
      if (session) await stopSession(session).catch(() => false);
      await sleep(1500);
      const end = adb('shell', 'settings', 'get', 'global', 'http_proxy');
      if (end !== before) failures.push(`http_proxy ${end} at the end (was ${before})`);
    }
    check(name, failures, t0, { mode: notes.filter((n) => !/^native proxy:/.test(n)).join(' ') });
  }

  /** scripts/e2e/grpc_server on 127.0.0.1 / ::1: h2c on `port`, TLS (self-signed, minted at start) on `port + 1`. */
  async function startGrpcServer(grpcPort: number): Promise<{ stop: () => void; log: () => string }> {
    const dir = path.resolve(root, '..', '..', 'scripts', 'e2e', 'grpc_server');
    execFileSync('dart', ['pub', 'get'], { cwd: dir, stdio: 'pipe', timeout: 180_000 });
    const p = spawn('dart', ['run', 'bin/server.dart', '--port', String(grpcPort), '--tls-port', String(grpcPort + 1)], { cwd: dir });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    await waitFor(() => (/GRPC_SERVER_READY/.test(out) ? true : undefined), 120_000, 200).catch(() => {
      p.kill();
      throw new Error(`gRPC server did not start: ${out.slice(-400)}`);
    });
    return { stop: () => p.kill(), log: () => out };
  }

  async function checkK(dev: string, tag: string) {
    const grpcPort = Number(process.env.FI_GRPC_PORT) || (await freePortPair());
    const svc = '/demo.orders.v1.OrderService/';
    const defines = [`--dart-define=GRPC_PORT=${grpcPort}`, `--dart-define=GRPC_TLS_PORT=${grpcPort + 1}`, '--dart-define=COVERAGE=false'];
    const waitGrpc = async (s: vscode.DebugSession, from: number) => {
      await waitFor(() => (/DEMO_GRPC done/.test(outputOf(s).slice(from)) ? true : undefined), 600_000, 250);
      await sleep(500);
      return outputOf(s).slice(from);
    };
    const grpcCalls = (since: number) => api.getExchanges().filter((e) => e.startedAt >= since && e.kind === 'grpc' && e.url.includes(`:${grpcPort}${svc}`));
    let server: { stop: () => void; log: () => string } | undefined;
    try {
      server = await startGrpcServer(grpcPort);
    } catch (e) {
      check(`DEV ${tag} K gRPC`, [`exception: ${(e as Error).message}`], Date.now());
      return;
    }
    try {
      // ---- K1: intercepted ----
      let t0 = Date.now();
      let failures: string[] = [];
      let session: vscode.DebugSession | undefined;
      let since = Date.now();
      try {
        await api.setRules([]);
        session = await launch(`FI-D K1 ${tag}`, dev, { toolArgs: defines });
        const args = (session.configuration.toolArgs ?? []) as string[];
        if (args.some((a) => a.startsWith('--dart-define=FLUTTER_INTERCEPT_GRPC='))) failures.push(`gRPC define although enabled: ${args.join(' ')}`);
        const text = await waitGrpc(session, 0);
        const res = demoResults(text);
        const ok = (label: string, re: RegExp) => {
          const r = res[label];
          if (!r || !re.test(`${r.status} ${r.body}`)) failures.push(`${label}: ${r ? `${r.status} ${r.body.slice(0, 160)}` : 'no DEMO_RESULT'}`);
        };
        ok('grpc_unary', /^0 .*"status":"ORDER_STATUS_SHIPPED"/);
        ok('grpc_stream', /^0 .*"events":\["1:ORDER_STATUS_PENDING","2:ORDER_STATUS_SHIPPED","3:ORDER_STATUS_DELIVERED"\]/);
        ok('grpc_client_stream', /^0 .*"count":3,"quantity":6/);
        ok('grpc_bidi', /^0 .*"replies":\["echo: hello 1","echo: hello 2","echo: hello 3"\]/);
        ok('grpc_missing', /^ERR .*code: 5/);
        ok('grpc_tls', /^0 .*"status":"ORDER_STATUS_SHIPPED"/);
        ok('grpc_isolate', /^0 .*"overridesInIsolate":true/);
        const calls = grpcCalls(since);
        const byMethod = (m: string) => calls.filter((e) => e.url.endsWith(svc + m) && e.state === 'completed');
        const getOrders = byMethod('GetOrder');
        if (!getOrders.some((e) => e.grpc?.statusCode === 0 && e.grpc.messagesReceived === 1)) failures.push(`GetOrder OK not recorded (${calls.map((e) => `${e.url} ${e.state} ${e.grpc?.statusCode}`).join(', ') || 'no gRPC exchanges'})`);
        if (!getOrders.some((e) => e.grpc?.statusCode === 5)) failures.push('GetOrder NOT_FOUND not recorded with grpc-status 5');
        if (getOrders.filter((e) => e.grpc?.statusCode === 0).length < 2) failures.push('the Isolate.run GetOrder was not recorded');
        if (!byMethod('WatchOrders').some((e) => e.grpc?.statusCode === 0 && e.grpc.messagesReceived === 3)) failures.push('WatchOrders: no completed call with 3 messages received');
        if (!byMethod('UploadItems').some((e) => e.grpc?.statusCode === 0 && e.grpc.messagesSent === 3)) failures.push('UploadItems: no completed call with 3 messages sent');
        if (!byMethod('Chat').some((e) => e.grpc?.statusCode === 0 && e.grpc.messagesSent === 3 && e.grpc.messagesReceived === 3)) failures.push('Chat: no completed call with 3 messages each way');
        for (const e of calls) if (e.method !== 'POST') failures.push(`gRPC exchange method ${e.method}`);
        const tunnels = api.getExchanges().filter((e) => e.startedAt >= since && e.kind === 'tunnel' && e.grpcTunnel && e.url.includes(`:${grpcPort + 1}`));
        if (!tunnels.length) failures.push(`TLS call not recorded as a grpcTunnel (${api.getExchanges().filter((e) => e.startedAt >= since && e.url.includes(`:${grpcPort + 1}`)).map((e) => `${e.kind} ${e.url}`).join(', ') || 'nothing'})`);
        check(`DEV ${tag} K1 gRPC recorded (h2c calls, streaming, status, isolate, TLS tunnel)`, failures, t0, { output: evidence(text), mode: `grpc=${calls.length} tunnels=${tunnels.length}` });

        // grpcMock + hot restart
        t0 = Date.now();
        failures = [];
        await api.setRules([{ id: 'grpc-mock', enabled: true, match: { method: 'POST', url: `*${svc}GetOrder` }, action: { kind: 'grpcMock', code: 14, message: 'mocked by suite' } }]);
        const from = outputOf(session).length;
        since = Date.now();
        await session.customRequest('hotRestart');
        const text2 = await waitGrpc(session, from);
        const r = demoResults(text2).grpc_unary;
        if (!r || r.status !== 'ERR' || !/code: 14/.test(r.body) || !/mocked by suite/.test(r.body)) failures.push(`grpc_unary after the mock: ${r ? `${r.status} ${r.body.slice(0, 160)}` : 'no DEMO_RESULT'}`);
        const mocked = grpcCalls(since).filter((e) => e.url.endsWith(svc + 'GetOrder') && e.grpc?.statusCode === 14);
        if (!mocked.length) failures.push('mocked GetOrder not recorded with grpc-status 14');
        const stream = demoResults(text2).grpc_stream;
        if (!stream || stream.status !== '0') failures.push(`grpc_stream (not mocked) after the restart: ${stream ? stream.status : 'none'}`);
        check(`DEV ${tag} K1 grpcMock (code 14) after hot restart`, failures, t0, { output: evidence(text2), mode: `mocked=${mocked.length}` });
      } catch (e) {
        check(`DEV ${tag} K1 gRPC`, [...failures, `exception: ${(e as Error).message}`], t0);
      } finally {
        await api.setRules([]);
        if (session) await stopSession(session).catch(() => false);
        await sleep(1500);
      }

      // ---- K2: grpc.enabled=false ----
      t0 = Date.now();
      failures = [];
      session = undefined;
      await cfg.update('grpc.enabled', false, vscode.ConfigurationTarget.Global);
      try {
        since = Date.now();
        session = await launch(`FI-D K2 ${tag}`, dev, { toolArgs: defines });
        const args = (session.configuration.toolArgs ?? []) as string[];
        const def = args.filter((a) => a.startsWith('--dart-define=FLUTTER_INTERCEPT_GRPC='));
        if (def.length !== 1 || def[0] !== '--dart-define=FLUTTER_INTERCEPT_GRPC=0') failures.push(`gRPC define ${JSON.stringify(def)}`);
        const text = await waitGrpc(session, 0);
        const res = demoResults(text);
        for (const l of ['grpc_unary', 'grpc_stream', 'grpc_client_stream', 'grpc_bidi', 'grpc_tls', 'grpc_isolate']) {
          if (res[l]?.status !== '0') failures.push(`${l}: ${res[l] ? `${res[l].status} ${res[l].body.slice(0, 120)}` : 'no DEMO_RESULT'}`);
        }
        const recorded = api.getExchanges().filter((e) => e.startedAt >= since && (e.kind === 'grpc' || e.grpcTunnel || e.url.includes(`:${grpcPort}`) || e.url.includes(`:${grpcPort + 1}`)));
        if (recorded.length) failures.push(`${recorded.length} gRPC exchange(s) recorded although gRPC is off: ${recorded.map((e) => e.url).join(', ')}`);
        check(`DEV ${tag} K2 grpc.enabled=false: direct, nothing recorded`, failures, t0, { output: evidence(text) });
      } catch (e) {
        check(`DEV ${tag} K2 grpc.enabled=false`, [...failures, `exception: ${(e as Error).message}`], t0);
      } finally {
        await cfg.update('grpc.enabled', undefined, vscode.ConfigurationTarget.Global);
        if (session) await stopSession(session).catch(() => false);
        await sleep(1500);
      }
    } finally {
      server.stop();
    }
  }

  /** CONTRACTS §19.3: trust on a booted iOS simulator → TLS gRPC decrypted; the row removed again at session end. */
  async function checkL(dev: string, tag: string) {
    const name = `DEV ${tag} L simulator CA trust: TLS gRPC decrypted, trust removed at session end`;
    const t0 = Date.now();
    const failures: string[] = [];
    const notes: string[] = [];
    const udid = dev.toUpperCase();
    let session: vscode.DebugSession | undefined;
    let server: { stop: () => void; log: () => string } | undefined;
    let store: string | undefined;
    let sha: string | undefined;
    let preExisting = false;
    let text = '';
    const rowPresent = async () => {
      const r = await readTrustRow(simExec, nodeFs, store!, sha!);
      if ('problem' in r) throw new Error(r.problem);
      return r.present;
    };
    try {
      // Read-only "before" state, with the setting still off: the CA (from the entry the provider writes) and its row.
      await cfg.update('grpc.trustOnSimulator', undefined, vscode.ConfigurationTarget.Global);
      await api.prepare(folder, { type: 'dart', request: 'launch', name: `FI-D L prepare ${tag}`, deviceId: dev });
      const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(fs.readFileSync(entry, 'utf8'))?.[0];
      const fp = caFingerprint(pem);
      if ('problem' in fp) throw new Error(`CA from the entry: ${fp.problem}`);
      sha = fp.sha256;
      if (!(await new IosSimTrust({ caCertPem: fp.certPem, heartbeatMs: 0 }).isSimulator(udid))) throw new Error(`${dev} is not a booted iOS simulator`);
      const sim = parseSimulators((await simExec(XCRUN, ['simctl', 'list', 'devices', '-j'], 10_000)).stdout).find((d) => d.udid === udid);
      if (!sim?.dataPath) throw new Error('no dataPath for the simulator');
      store = trustStorePath(sim.dataPath);
      preExisting = await rowPresent();
      notes.push(`preExisting=${preExisting}`);

      const grpcPort = Number(process.env.FI_GRPC_PORT) || (await freePortPair());
      server = await startGrpcServer(grpcPort);
      await api.setRules([]);
      await cfg.update('grpc.trustOnSimulator', true, vscode.ConfigurationTarget.Global);
      const since = Date.now();
      session = await launch(`FI-D L ${tag}`, dev, { toolArgs: [`--dart-define=GRPC_PORT=${grpcPort}`, `--dart-define=GRPC_TLS_PORT=${grpcPort + 1}`, '--dart-define=COVERAGE=false'] });
      // The trust is added right after the session starts (asynchronously): give it a few seconds.
      let trusted = false;
      for (const end = Date.now() + 15_000; !trusted && Date.now() < end; await sleep(250)) trusted = await rowPresent();
      if (!trusted) failures.push('the CA is not in the simulator trust store during the session');
      const s = session;
      await waitFor(() => (/DEMO_GRPC done/.test(outputOf(s)) ? true : undefined), 600_000, 250);
      await sleep(500);
      text = outputOf(s);
      const tls = demoResults(text).grpc_tls;
      const tlsUrl = `:${grpcPort + 1}/demo.orders.v1.OrderService/GetOrder`;
      // Decrypted = the proxy read the call (a gRPC exchange with the app's request message), not a tunnel. The e2e
      // server's certificate is self-signed (the app accepts it itself); the proxy verifies upstream certificates, so
      // the decrypted call then fails upstream with a certificate error — a documented limit (docs: TLS gRPC on the
      // iOS simulator). Either the call succeeded, or it failed exactly that way.
      const decrypted = api.getExchanges().filter((e) => e.startedAt >= since && e.kind === 'grpc' && e.url.includes(tlsUrl));
      const ok = decrypted.filter(
        (e) => !!e.grpc && (e.grpc.statusCode === 0 ? e.grpc.messagesSent >= 1 && e.grpc.messagesReceived >= 1 : /certificate/i.test(`${e.grpc.statusMessage ?? ''} ${e.error ?? ''}`)),
      );
      if (tls && !ok.length) notes.push(`grpc_tls: ${tls.status} ${tls.body.slice(0, 120)}`);
      if (!ok.length) {
        const seen = api.getExchanges().filter((e) => e.startedAt >= since && e.url.includes(`:${grpcPort + 1}`));
        failures.push(`TLS GetOrder not recorded decrypted (a gRPC exchange, not a tunnel): ${seen.map((e) => `${e.kind} ${e.url} ${e.state} ${e.grpc?.statusCode ?? ''} ${e.error ?? ''}`).join(', ') || 'nothing recorded'}`);
      }
      notes.push(`decrypted=${ok.length}`);

      // Session end → our row removed (a pre-existing one stays).
      await stopSession(session).catch(() => false);
      session = undefined;
      const want = preExisting;
      let settled = false; // (waitFor is synchronous)
      for (const end = Date.now() + 20_000; !settled && Date.now() < end; await sleep(500)) settled = (await rowPresent()) === want;
      if (!settled) failures.push(preExisting ? 'a pre-existing trust row was removed' : 'the CA is still trusted after the session ended');
    } catch (e) {
      failures.push(`exception: ${(e as Error).message}`);
    } finally {
      if (session) await stopSession(session).catch(() => false);
      server?.stop();
      await cfg.update('grpc.trustOnSimulator', undefined, vscode.ConfigurationTarget.Global);
      if (cfg.inspect('grpc.trustOnSimulator')?.globalValue !== undefined) failures.push('flutterIntercept.grpc.trustOnSimulator not restored');
      // Never leave the developer's simulator changed: if our row survived (a failure above), delete exactly it.
      if (store && sha && !preExisting && (await rowPresent().catch(() => false))) {
        await simExec(SQLITE3, ['-bail', '-cmd', '.timeout 5000', store, `DELETE FROM tsettings WHERE sha256 = x'${sha}';`], 10_000).catch((e: unknown) => failures.push(`cleanup failed: ${String(e)}`));
        notes.push('cleanup: removed the row left behind');
      }
      await sleep(1500);
    }
    check(name, failures, t0, { output: evidence(text), mode: notes.join(' ') });
  }

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
