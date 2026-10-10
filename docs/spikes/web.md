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
- No DIRECT fallback: Chrome's `--proxy-server` has none, and the fallback list syntax needs a comma (see 6).
  If the proxy stops while a web session runs, the page loses network until relaunch. The extension only
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
