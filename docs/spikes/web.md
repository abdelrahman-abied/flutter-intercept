# Spike B — Flutter Web through the proxy (v0.5.0)

Agent B, 2026-10-10. Flutter 3.47.6 (stable), Chrome 154 (macOS arm64), VS Code 1.141.0 (test-electron),
Dart-Code 3.144.0, the real proxy (`packages/proxy/dist` `InterceptProxy`) with a CA from mockttp's
`generateCACertificate` (2048-bit, as `src/ca.ts` makes it). Contract: CONTRACTS §11.3.
Sample: `samples/web_app` (Dio browser adapter + package:http `BrowserClient`, no tool code).

## Verdict

**GO with exactly two browser flags**, added to the session's `toolArgs` (never `program`):

```
--web-browser-flag=--proxy-server=http://127.0.0.1:<port>
--web-browser-flag=--ignore-certificate-errors-spki-list=<base64(sha256(SPKI DER of the install CA))>
```

- The **CA's** SPKI pin is enough: Chrome accepts every per-host leaf the proxy signs with that CA (the flag
  matches any key in the verified chain, not only the leaf). No `--ignore-certificate-errors`, no imported
  CA, no persistent profile.
- Scope of the trust: only the Chrome process flutter_tools starts for this run, which always has its own
  `--user-data-dir` (a temp profile, or the user's `--web-browser-flag=--user-data-dir=…`); Chrome ignores the
  SPKI flag without a user-data-dir. The user's normal Chrome is never affected. Only certificates chaining to
  this install's CA key (0600, never leaves the machine) are accepted; everything else is verified as usual.
- Loopback **stays bypassed** (Chrome's default since M72, no flag): the dev server, DWDS, the debug service
  and DevTools run on `localhost`/`127.0.0.1` and never touch the proxy. Measured: 0 loopback exchanges.
- `-d web-server`: flutter does not start the browser → we can't set its proxy → **skip** with a reason the host
  shows once. `edge`: same `ChromiumLauncher` and the same `webBrowserFlags` in flutter_tools (Windows only;
  not runnable here — code-read only).
- Debugging is unaffected: breakpoints, hot restart, DevTools URL all work (DWDS is on loopback).

## Evidence (manual runs, `flutter run` in a terminal)

Proxy: `node proxy.cjs` (real `InterceptProxy({port: 0, ca})`, prints `PORT` + `PIN` and every finished exchange).
Pin cross-check (identical):

```
$ openssl x509 -in ca.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
M5zr…qQxw=          # = crypto.X509Certificate(cert).publicKey.export({type:'spki',format:'der'}) → sha256 → base64
```

Run (`samples/web_app`):

```
flutter run -d chrome --web-browser-flag=--headless=new \
  --web-browser-flag=--proxy-server=http://127.0.0.1:$PORT \
  --web-browser-flag=--ignore-certificate-errors-spki-list=$PIN
```

| # | Flags | Result |
|---|---|---|
| 1 | proxy + CA pin | App up (launch → first `WEB_START` ≈ 20 s warm, headless). All 6 calls behave as without the proxy: `http_todo 200`, `dio_user 200`, `dio_post 201`, `http_post 201`, `dio_profile 200`, `cors_blocked ERR (ClientException: Failed to fetch)`. Proxy recorded every request **and every preflight**: `GET todos/1 200`, `GET users/1 200`, `OPTIONS posts 204` + `POST posts 201`, `OPTIONS todos 204` + `POST todos 201`, `OPTIONS users/2 204` + `GET users/2 200`, `GET wikipedia 200` (the browser then blocked it: no ACAO). Each with `Origin: http://localhost:<devport>`, `sec-fetch-site: cross-site`. |
| 2 | proxy only (control) | **The app does not even start**: CanvasKit (`www.gstatic.com/flutter-canvaskit/…`) and fonts are fetched cross-origin through the proxy, Chrome rejects the leaf (`TLS handshake … cert-rejected` ×3), no `WEB_START` in 120 s. ⇒ the two flags are all-or-nothing; the provider never adds one without the other. |
| 3 | 1 + mock rule on `GET users/2` (proxy **before** P's CORS work) | Preflight went upstream (204 from the real server), mocked GET had no `access-control-allow-origin` → browser blocked it: `dio_profile ERR connectionError … XMLHttpRequest onError`. ⇒ the proxy **must** answer preflights and add ACAO for mocks (CONTRACTS §11.3, P). |
| 4 | 1, then `R` (hot restart) | `Restarted application in 203ms`; the new batch is recorded again (GETs now `304`: the browser HTTP cache revalidates — expected, not ours). Interception survives hot restart without anything to redo. |
| 5 | 1 + `--disable-background-networking --disable-component-update --disable-sync --no-pings --disable-domain-reliability --disable-client-side-phishing-detection --metrics-recording-only` | Chrome's own traffic is **not** reduced (see "Noise"). Not adopted. |
| 6 | 5 + `--disable-features=A,B,…` | Chrome failed to launch: **flutter_tools splits `--web-browser-flag` values on commas** (`--disable-features=OptimizationHints MediaRouter …` became separate args, "Multiple targets are not supported in headless mode"). ⇒ our values must never contain a comma (asserted in code: port + base64 pin). Also rules out a `PROXY …, DIRECT` fallback list and `data:` PAC URLs. |

## Noise: Chrome's own requests

The temp-profile Chrome makes ~15–25 requests of its own in the first minute (`update.googleapis.com`,
`clients2.google.com/time`, `android.clients.google.com/c2dm|checkin`, `optimizationguide-pa.googleapis.com`,
`clientservices.googleapis.com/chrome-variations`, `accounts.google.com/ListAccounts`, `edgedl.me.gvt1.com`),
and none of the "disable" flags above remove them. They are cleanly distinguishable from the app's:

| | `Origin` | `sec-fetch-site` |
|---|---|---|
| App (fetch/XHR, CanvasKit, fonts) | `http://localhost:<devport>` | `cross-site` |
| Chrome itself | absent (once `https://www.google.com`) | `none` or absent |

Requested (proxy/webview/lead): for exchanges from a web session, tag requests with `sec-fetch-site: none` or
with no `Origin` and no `Referer` as browser-internal and hide them by default (a filter token to show them).
Without it the list starts with Google update traffic on every web launch.

## Other observations

- CanvasKit (`canvaskit.wasm`, ~7 MB) and the Roboto font are app traffic through the proxy on every cold start
  (MITM'd, recorded). No measurable start-up penalty in these runs (≈ 20 s either way, dominated by DDC).
- No DIRECT fallback (v0.5.0): Chrome's `--proxy-server` has none, and the fallback list syntax needs a comma (see 6).
  If the proxy stops while a web session runs, the page loses network until relaunch. **Fixed in v0.8.0** with a
  loopback PAC server (section "v0.8.0" below). The extension only
  restarts the proxy when no intercepted session is live, so web sessions must count as intercepted sessions
  (they do: `flutterInterceptOriginalProgram` is set).
- `--release` web runs are skipped like every release launch (consistency; nothing is baked into a web build,
  so this could be relaxed later).
- `--web-hostname=<non-loopback>` (dev server on a LAN address) would send the dev server/DWDS through the
  proxy (not loopback any more). Not handled; open point (a `--proxy-bypass-list=<host>` flag would fix it).

- REVIEW-5 #10: a user `--web-browser-flag=--user-data-dir=…` (toolArgs or `dart.flutter*AdditionalArgs`) makes
  flutter_tools start Chrome on that (real, persistent) profile instead of a temp one, so the launch is **not**
  intercepted (`skip {webUserProfile}`, one-time notice via `PrepareDeps.webUserProfileSkipped`). `--profile-directory`
  alone only picks a profile inside flutter's temp user-data-dir and stays intercepted. Not detectable: a
  `CHROME_EXECUTABLE` wrapper script that adds its own `--user-data-dir`.

## Implementation (`packages/extension/src/debug/**`, `src/ca.ts`)

- `ca.ts` `spkiPin(certPem)` — pure; unit-tested against openssl's pipeline above.
- `rewrite.ts`: web devices (`chrome`, `edge`; explicit `deviceId` or Dart-Code's selected device) take
  `webSession()`: no entry, `program` untouched (restored if a mobile rerun carried our entry), our dart-defines
  removed, the two flags appended. The exact added args are stored in `flutterInterceptWebFlags` and only those
  are removed on re-resolve / when interception or `web.enabled` is off (`restore`); `flutterInterceptWeb: true`,
  `flutterInterceptProxyHost: "127.0.0.1"`, `flutterInterceptPort`, `flutterInterceptOriginalProgram` recorded.
  The user's own browser proxy flag (`--proxy-server`, `--proxy-pac-url`, `--no-proxy-server`,
  `--proxy-auto-detect`, in toolArgs or `dart.flutter*AdditionalArgs`) wins → skip. `web-server` (or any
  other `web*` id) → skip with `webServer: true`.
- `provider.ts`: the first pass returns `skip {needsCa}` for a web launch (no CA yet) → the provider starts the
  proxy, loads the CA and resolves again; `PrepareDeps.webServerSkipped(message)` for the one-time notice;
  setting `flutterIntercept.web.enabled` (default true) read with the others.

## Integration suite (`FI_SUITE=web`)

`test/integration/suite/web.ts` — real VS Code + Dart-Code, `samples/web_app` on `chrome` (headless by default,
`FI_WEB_HEADFUL=1` to watch): A launch (config + every request recorded with status + Origin, no loopback
exchange, a breakpoint hit and resumed), B CORS diagnosis, C mock answers the preflight + `cors` rule after hot
restart, D reloaded provider order, E `web.enabled=false`, F `web-server` skipped.

Command: `cd packages/extension && node build.mjs --tests && FI_SUITE=web node dist-test/runTest.js`

Result (2026-10-10, with agent P's CORS work in `packages/proxy/dist`): **6/6 passed** (second run; the first
run failed only C because Chrome reused A's cached real preflights — 5 s default without
`Access-Control-Max-Age` — the suite now waits 6 s before the hot restart).

```
[suite] ok   FI-W A launch on chrome (flags, all requests recorded, breakpoint) (19658 ms) exchanges=22 breakpoint=hit
[suite] ok   FI-W B CORS diagnosis (preflights flagged, refused call explained) wiki.cors={"problem":"No Access-Control-Allow-Origin header: the browser blocks the response for http://localhost:50704."}
[suite] ok   FI-W C mock answers the preflight + cors rule, after hot restart (9999 ms)
[suite] ok   FI-W D reloaded (our hook before Dart-Code) (19660 ms) web dartCodeRanFirst=false
[suite] ok   FI-W E flutterIntercept.web.enabled=false (19178 ms)
[suite] ok   FI-W F web-server skipped with a reason (5 ms)
[suite] web: 6/6 runs passed
```

C, app output and what the proxy recorded after the hot restart (A recorded the same 9 requests, all `completed`):

```
WEB_RESULT dio_profile 200 ms=31 {"mocked":"web"}
WEB_RESULT cors_blocked 200 ms=393 {"batchcomplete":"","query":{"general":{"mainpage":"Main Page",…
mocked    204 OPTIONS https://jsonplaceholder.typicode.com/users/2
mocked    200 GET     https://jsonplaceholder.typicode.com/users/2
completed 200 GET     https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json   (cors rule)
```

`exchanges=22` in A = the 9 app requests + CanvasKit/fonts + Chrome's own traffic (see "Noise").

## Requested contract changes

- §4b: add `flutterInterceptWeb` (true on web sessions) and `flutterInterceptWebFlags` (the toolArgs we added).
- §11.3: browser-internal request tagging (see "Noise").

---

# v0.8.0 — DIRECT fallback, web-server notice, web screenshots (CONTRACTS §14.7)

Agent B, 2026-10-10. Same machine: Flutter 3.47.6, Chrome 154.0.8037.98 (macOS arm64), the real `InterceptProxy`
(`packages/proxy/dist`) with a mockttp CA. Throwaway harnesses (session scratchpad, not in the repo): a proxy child, a
temp-profile headless Chrome driven over CDP (navigate `https://example.com`, `fetch` jsonplaceholder, loopback fetches,
stop the proxy, fetch again, restart the proxy on the same port), and `flutter run -d chrome` on `samples/web_app`.

## Verdict: GO with a PAC URL served by the extension on loopback

```
--web-browser-flag=--proxy-pac-url=http://127.0.0.1:<pacPort>/flutter-intercept-<proxyPort>.pac
--web-browser-flag=--ignore-certificate-errors-spki-list=<pin>          (unchanged)
--web-browser-debug-port=<free loopback port>                           (new: web screenshots)
```

The script: loopback (`localhost`, `*.localhost`, `127.*`, `::1`) → `DIRECT`; everything else →
`PROXY 127.0.0.1:<proxyPort>; DIRECT`.

| PAC source | Chrome honours it | Proxy up | Proxy stopped | Verdict |
|---|---|---|---|---|
| `--proxy-server=http://127.0.0.1:P` (v0.5.0, control) | — | all intercepted | `ERR_PROXY_CONNECTION_FAILED`, every fetch fails | no fallback |
| `--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,…` | **yes** (Chrome direct) | all intercepted | everything works DIRECT | **unusable**: a data URL needs a comma and flutter_tools splits `--web-browser-flag` values on commas (package:args 2.7.0 `splitCommas: true`, `parser.dart:342` `value.split(',')`, no escaping; v0.5.0 run 6) |
| `--proxy-pac-url=file:///…/proxy.pac` | **no**: nothing reached the proxy, all DIRECT | — | — | Chrome ignores file:// PAC |
| `--proxy-pac-url=http://127.0.0.1:P/…pac` (the proxy itself) | fetch → mockttp `500 Passthrough loop detected` → Chrome uses DIRECT for everything | nothing intercepted | DIRECT | would need a proxy (agent P) route; and if the proxy is down the PAC fetch fails anyway |
| **`--proxy-pac-url=http://127.0.0.1:<own port>/…pac`** (separate loopback server) | **yes**, fetched once at start (3 GETs) | all intercepted, loopback not | everything works DIRECT | **shipped** |

Evidence, separate PAC server (CDP harness):

```
[0.6s] PAC fetched /proxy.pac  (x3)
[5.3s] proxy up   https://jsonplaceholder.typicode.com/todos/1 -> HTTP 200   (recorded by the proxy, Origin https://example.com)
[5.3s] loopback   http://127.0.0.1:<lo>/x, http://localhost:<lo>/y -> HTTP 200 (not recorded)
--- stopping proxy
[7.5s] proxy DOWN https://jsonplaceholder.typicode.com/todos/2 -> HTTP 200
[10.3s] navigate https://example.org/ -> ok
[10.7s] proxy DOWN https://httpbin.org/get -> HTTP 200
```

Through flutter_tools (`flutter run -d chrome --web-browser-flag=--headless=new --web-browser-flag=--proxy-pac-url=<PacServer URL>
--web-browser-flag=--ignore-certificate-errors-spki-list=<pin> --web-browser-debug-port=<p>`, the real `PacServer` bundled from
`src/debug/pacServer.ts`): the URL survives the comma split; launch → `WEB_START` 17.5 s; all 6 results as before
(`http_todo 200`, `dio_user 200`, `dio_post 201`, `http_post 201`, `dio_profile 200`, `cors_blocked ERR`); the proxy recorded
CanvasKit, the font, all 9 app requests + 3 preflights with `Origin: http://localhost:<devport>`, no loopback. Then the proxy
was killed and `R` (hot restart): **the same 6 results** (`http_todo 200 ms=413` …), the proxy (stopped) recorded 0.

### Trade-off measured: Chrome remembers a dead proxy for ~5 minutes

After the proxy comes back on the **same** port, Chrome keeps going DIRECT until its bad-proxy retry expires: probes every
20 s were not intercepted from 1.4 s to 307 s, intercepted again at 328 s (Chrome's 5-minute proxy retry delay). So a
proxy crash/restart during a web session means up to ~5 min of **unrecorded** (but working) traffic, instead of v0.5.0's
broken network. The extension only restarts the proxy on purpose when no intercepted session is live; relaunch the web
session to be intercepted immediately. If the proxy comes back on another port, the PAC server serves 404 for the old port
(Chrome's next PAC fetch → DIRECT) — never a stale `PROXY` line for a port someone else might own.

### Rules kept (REVIEW-5)
- Only the temp-profile browser flutter_tools starts gets the flags; `--user-data-dir` launches stay skipped (#10).
- The SPKI pin is still only for this install's CA; the PAC changes routing, not trust.
- The user's own `--proxy-pac-url` / `--proxy-server` / `--no-proxy-server` / `--proxy-auto-detect` still wins (skip).
- Re-resolve strips exactly the recorded `flutterInterceptWebFlags` (now including the PAC flag and the debug-port flag).

### Implementation
- `src/debug/pacServer.ts` — `pacScript(port)`, `PacServer` (binds 127.0.0.1:0, `unref`'d, Host must be
  `127.0.0.1:<pacPort>` else 403, GET/HEAD only, serves `/flutter-intercept-<port>.pac` only while `currentPort()` is that
  port, else 404; `no-store`). Not served by the proxy: a crash of the proxy must not take the PAC down with it.
- `rewrite.ts` — `webInterceptFlags(port, pin, {pacUrl, debugPort})`, `isOurPacUrl` (loopback, `.pac`, no comma),
  `webDebugPortArg`, `webBrowserDebugPortOf(config)`; `RewriteContext.webPacUrl` / `webDebugPort`. No PAC URL → the
  v0.5.0 `--proxy-server` flag (graceful). The user's own `--web-browser-debug-port` is kept and used.
- `provider.ts` — for web launches (first pass `needsCa`, or the status-bar device is a web device): PAC URL from
  `PrepareDeps.webPac` (default: one lazily started `PacServer` per deps object, serving the port `proxyHost.start()` returned
  while `proxyHost.running`) and a free loopback port (`PrepareDeps.freePort`, default the OS); each bounded to 2 s and
  falling back (logged) without failing the launch.
- Edge: same `ChromiumLauncher` flags in flutter_tools (Windows only); not runnable here, code-read only.

## web-server device: one-time notice with the manual flags (never automatic)

`src/debug/webServerNotice.ts` `createWebServerNotice(deps)` is the `PrepareDeps.webServerSkipped` handler. First call:
information message "<reason> To intercept it anyway, open the app in a separate Chrome started with Flutter Intercept's
proxy flags (a fresh throwaway profile, never your own)." + button **Copy Chrome Command**. Only on click: start the
proxy (`deps.proxy()`), create a fresh `flutter-intercept-chrome-*` dir in the OS temp dir, copy e.g.

```
open -na "Google Chrome" --args --user-data-dir=/var/folders/…/flutter-intercept-chrome-Ab12 \
  --proxy-server=http://127.0.0.1:<port> --ignore-certificate-errors-spki-list=<pin> --no-first-run --no-default-browser-check
```

(`google-chrome …` on Linux, `start "" chrome …` on Windows). `--proxy-server` (not the PAC URL) on purpose: that browser is
the user's and may outlive the extension host. Chrome honours the SPKI pin only with an explicit `--user-data-dir`, so the
fresh profile is both required and the REVIEW-5 #10 guarantee. Nothing is ever run by us.

## Web screenshots over CDP

flutter_tools starts Chrome with `--remote-debugging-port=<findFreePort()>` unless `--web-browser-debug-port` is given
(`chrome.dart` `launch`, `web_device.dart:146`); the port is not exposed by DWDS or the daemon. So the provider passes
`--web-browser-debug-port=<free loopback port>` (recorded and stripped like the browser flags) and
`webBrowserDebugPortOf(session.configuration)` reads it back (ours or the user's own).

`src/web/screenshot.ts`: `GET http://127.0.0.1:<port>/json/list` (≤ 1 MB, 5 s) → the `page` target on a loopback origin
(the dev server; else any http(s) page; never devtools:// / chrome://; id `[A-Za-z0-9_-]{1,128}`) → WebSocket rebuilt as
`ws://127.0.0.1:<port>/devtools/page/<id>` (the advertised `webSocketDebuggerUrl` host is never used; no Origin header, so
Chrome's `--remote-allow-origins` check does not apply; `maxPayload` ~21 MB) → `Page.captureScreenshot {format: png,
fromSurface: true}` (15 s) → PNG checked (IHDR, ≤ 16 MB) → `saveScreenshot` (0600, `.dart_tool/flutter_intercept/screenshots/`).
Measured in the flutter run above: 54 638 bytes, 756×413 (headless window), the sample's text rendered.

## Integration suite (`FI_SUITE=web`), v0.8.0 additions
A now expects the PAC flag + the debug-port flag; **G** captures a screenshot over CDP from the A–C session; **H** stops the
proxy mid-session, hot-restarts, expects every call to still work and nothing recorded, then starts the proxy again.

Command: `cd packages/extension && node build.mjs && npm run package && node build.mjs --tests && FI_VSIX=flutter-intercept.vsix FI_SUITE=web node dist-test/runTest.js`

Result (2026-10-10, packaged VSIX, random proxy port): **8/8 passed** (first run).

```
[suite] ok   FI-W A launch on chrome (flags, all requests recorded, breakpoint) (46744 ms) exchanges=21 breakpoint=hit
[suite] ok   FI-W B CORS diagnosis (preflights flagged, refused call explained) (0 ms)
[suite] ok   FI-W C mock answers the preflight + cors rule, after hot restart (9488 ms)
[suite] ok   FI-W G web screenshot over CDP (33 ms) 756x413 49479 bytes
[suite] ok   FI-W H DIRECT fallback (proxy stopped mid-session, hot restart) (11939 ms)
[suite] ok   FI-W D reloaded (our hook before Dart-Code) (21676 ms) web dartCodeRanFirst=false
[suite] ok   FI-W E flutterIntercept.web.enabled=false (21146 ms)
[suite] ok   FI-W F web-server skipped with a reason (1 ms)
[suite] web: 8/8 runs passed
```

Side note: on a headless hot restart the framework sometimes prints a debug assertion
(`org-dartlang-sdk:///lib/_engine/engine/window.dart:99:12`) before restarting. It happened in the manual run with the
proxy stopped. It has nothing to do with networking, and the restarted batch then completed normally.
