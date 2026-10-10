# Spike: native clients through the proxy, and bypass detection (0.8.0, CONTRACTS §14.7)

Date: 2026-10-10. Flutter 3.47.6 / Dart 3.13.5, Xcode 27.0. Devices: Android emulator (API 36, arm64, the
default Android Studio AVD: a Google Play image, `ro.debuggable=0`), an iPhone 17 Pro simulator, macOS desktop.
Demo: `samples/demo_app` with `--dart-define=NATIVE_HTTP=true` (cronet_http on Android, cupertino_http on Apple
platforms); new define `NATIVE_URL=<url>` points the native GET at another server (used for the CA test below).
Harnesses (scratch, not committed): `scripts/e2e/mitm_proxy.dart --ca` as the proxy, a small Node HTTPS server
with a leaf signed by that CA, `flutter run` / `xcrun simctl launch` driven from shell scripts.

## Verdict

| | Android emulator | iOS simulator |
|---|---|---|
| Route the platform HTTP stack to the proxy without app changes | ✅ `settings put global http_proxy 10.0.2.2:<port>`; cronet obeys it at once | ❌ only through the Mac's system proxy |
| … and revert it exactly | ✅ `put :0`, then `delete` (or the previous value) | – |
| Make the native stack trust our CA without app changes | ❌ (Play image: no root; user CAs need the Settings UI and are ignored without app config) | ✅ `xcrun simctl keychain <udid> add-root-cert` (revert: delete the row from the simulator's TrustStore) |
| Native HTTPS mockable end to end | ✅ only when the app's **debug** `network_security_config` trusts the CA | ❌ (no route) |

So no target works without touching the app or the Mac. **Shipped**: the Android emulator route, behind
`flutterIntercept.nativeClients: "proxy"` (explicit opt-in), debug sessions on `emulator-*` only, always reverted,
and turned off again on the first TLS trust failure. iOS simulator, physical devices and macOS stay on the
read-only `"profile"` import. **Documented only**: everything else below.

## Android emulator

### Routing (measured)

- `adb -s emulator-5554 shell settings put global http_proxy 10.0.2.2:<port>` while the demo ran: cronet's
  `native_get` / `native_post` arrived at the proxy as `CONNECT jsonplaceholder.typicode.com:443`. So did the
  system's own traffic (`CONNECT connectivitycheck.gstatic.com:443`): the setting is emulator-wide.
- dart:io is not affected (the generated entry sets `findProxy` itself; dart:io never reads Android's proxy).
- Without CA trust, cronet fails the handshake: `net::ERR_CERT_AUTHORITY_INVALID` (`cn_X509Util: Trust anchor for
  certification path not found`) in ~150–250 ms. The app's native requests break while routed, which is why the
  core watches for this and the host stops routing (see "What was built").
- With a scratch copy of the demo that adds a debug-only network security config (below), the same run gave
  `native_get 200` / `native_post 201`, both seen and forwarded by the proxy (`PROXY_REQ GET https://…/posts/1
  ua="…Cronet…"`). Requests then are ordinary proxy exchanges: rules, mocks, breakpoints apply.

### Reverting (measured)

`settings put global http_proxy <host:port>` makes ConnectivityService write `global_http_proxy_host/port`. A bare
`settings delete global http_proxy` **leaves that global proxy active** (`global_http_proxy_host=10.0.2.2`
afterwards), i.e. the emulator keeps sending traffic to a port nobody listens on. `put :0` clears it
(`global_http_proxy_host=` `global_http_proxy_port=0`); a following `delete` restores the original "unset" state
(`settings get` → `null`) without bringing the proxy back. So the revert is `put :0`, then `delete` when the key
was unset before, or `put <previous>`.

The setting is persisted in the emulator's userdata: if VS Code dies while routed, the emulator stays routed
across reboots. Hence every applied value is written to extension storage **before** the `put`, and repaired on the
next activation (or the next session on that emulator).

### CA trust (why it can't be automatic)

- System CA: needs root (`adb root` is refused on Play images; `ro.debuggable=0`) and, on Android 14+, a tmpfs
  mount over the Conscrypt APEX cacerts in every process namespace. `-writable-system` needs a non-Play image and a
  restart of the emulator. Too invasive: not done.
- User CA: since Android 11 a CA certificate can only be installed from Settings (Security → Encryption &
  credentials → Install a certificate → CA certificate); the installer intent refuses it. And apps targeting API 24+
  ignore user CAs unless their network security config says otherwise.
- So the app has to opt in, in its **debug** build only. Either of these (in `android/app/src/debug/`, so release
  builds are untouched; `debug-overrides` only apply to debuggable builds anyway):

  ```xml
  <!-- android/app/src/debug/res/xml/network_security_config.xml -->
  <network-security-config>
      <debug-overrides>
          <trust-anchors>
              <certificates src="user"/>                          <!-- the CA installed via Settings -->
              <certificates src="@raw/flutter_intercept_ca"/>     <!-- or a copy in res/raw -->
          </trust-anchors>
      </debug-overrides>
  </network-security-config>
  ```
  ```xml
  <!-- android/app/src/debug/AndroidManifest.xml -->
  <application android:networkSecurityConfig="@xml/network_security_config"/>
  ```
  Many apps already have the `src="user"` line for Charles / Proxyman. The CA is the per-install Flutter Intercept
  CA (extension global storage), so the user needs a way to get its PEM: **requested** a command (lead).
- Profile builds are not debuggable, so `debug-overrides` don't apply there: the route is for debug sessions only.

## iOS simulator

- **Trust works**: before `xcrun simctl keychain <udid> add-root-cert ca.pem`, cupertino_http's GET of
  `https://localhost:<port>/` (leaf signed by the test CA) failed with "The certificate for this server is
  invalid"; after it, `native_get 200 {"trusted":true}` (`CFNetwork/3860…` at the server). The certificate lands in
  `<device>/data/private/var/protected/trustd/private/TrustStore.sqlite3`, table `tsettings`, keyed by the SHA-256
  of the DER. `simctl keychain` has no remove action (`reset` wipes the whole keychain), but deleting that row
  while the simulator runs reverts it at once (the next launch failed the handshake again).
- **Routing doesn't**: the simulator has no proxy setting of its own. `configd_sim` mirrors the Mac's network
  configuration (proxies included), there is no `scutil` in the runtime, and `SIMCTL_CHILD_http_proxy` /
  `https_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` env vars were ignored by NSURLSession (both requests went direct, the
  proxy saw nothing). Changing the Mac's system proxy (`networksetup`) would route every app on the Mac, VS Code
  included: not done. Injecting a dylib (`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`) to set
  `connectionProxyDictionary` would work in principle but ships native code into the user's app process: not done.
- `"proxy"` on an iOS simulator therefore behaves like `"profile"` (read-only import).

## Physical devices, macOS

Out of scope for the route (spec: emulator / simulator only). A physical Android device could use
`localhost:<port>` + `adb reverse`, with the same CA problem; macOS has the same "system proxy only" problem as the
simulator.

## Bypass detection (CONTRACTS §14.7)

Main-isolate dart:io traffic runs under the entry's HttpOverrides, so in the HTTP profile it either carries
`proxyDetails` naming our proxy (https: always tunnelled) or is plain http (no `proxyDetails` even through the
proxy). Rules (`bypassVerdict`, src/vm/profile.ts), decided once the response ended:
- https without `proxyDetails` → bypass; cause "an HttpOverrides zone in the app … creates its own HttpClient"
  without `x-fi-id`, "a custom connectionFactory, or the proxy was unreachable (DIRECT fallback)" with it;
- `proxyDetails` naming another proxy → bypass ("the app's own HttpOverrides sends them to another proxy");
- plain http → the host's `proxySaw` (same method + URL among the proxy's own exchanges, ±120 s) decides; without
  it, a request lacking `x-fi-id` in a session whose requests carry it is a bypass; otherwise not reported;
- failed requests, CONNECT records, the trace channel host, package:http_profile entries: never reported.
One `SessionWarning {kind:'bypass'}` per host per session (≤ 10, then "N more hosts"), cleared with the session.

Cost: main-isolate HTTP logging keeps every request with its bodies in app memory (REVIEW-5 #15 limited it to apps
that load package:http_profile). Bypass detection therefore turns it on in the main isolate for the first
`BYPASS_WINDOW_MS` (60 s) after each main isolate starts (launch, hot restart), then off again (the isolate is
polled 10 s longer for responses still in flight). Apps that load package:http_profile keep logging on and get
detection for the whole session. A bypass that first happens later than 60 s after start in an app without native
clients is not reported.

Measured on the emulator (devices suite check J, `APP_ZONE_OVERRIDES=true`, the app's own
`HttpOverrides.runWithHttpOverrides` around `runApp`): warnings for `jsonplaceholder.typicode.com`, `httpbin.org`,
`echo.websocket.org` (SSE), `countries.trevorblades.com`; and none in the normal intercepted session (check I),
including plain http, the WebSocket upgrade and SSE through the proxy.

## What was built

- `src/adb.ts`: `AndroidGlobalProxy` — `apply(sessionId, serial, port)`, `release(sessionId)`, `releaseAll()`,
  `recover()`, `isRouted(sessionId)`, `routed`; `GlobalProxyStore`, `GlobalProxyRecord`, `parseSettingValue`,
  `EMULATOR_HOST_ALIAS`. Emulators (`emulator-<n>`) only, reference-counted per emulator, operations serialized,
  argument arrays (no shell). Never touches a proxy someone else set (`http_proxy` other than unset / `:0`, or a
  `global_http_proxy_host` / `global_proxy_pac_url` from a device policy); on release, leaves a value that changed
  meanwhile alone. Stored records are validated (`emulator-\d+`, `10.0.2.2:<port>`) before use.
- `src/vm/core.ts`: `NativeClientsMode` gains `"proxy"`. While `nativeRouted()` is true, finished native entries are
  not imported (they are proxy exchanges); failed ones are, and a TLS trust failure (`isTrustError`) calls
  `nativeRouteFailed(client)` once and shows "cronet_http rejected the proxy's certificate: the app needs a debug
  network_security_config trusting the Flutter Intercept CA. Routing is off for this session." While routed, a
  `native-client` warning says so. Bypass detection as above (`BYPASS_WINDOW_MS`, optional `now`,
  `bypassWindowMs`, `proxySaw` deps).
- `src/vm/watcher.ts` / `index.ts`: session-scoped `nativeRouted(sessionId)`, `nativeRouteFailed(sessionId, client)`,
  `proxySaw(q)` on `CreateVmWatcherDeps`; re-exports `matchesProxyExchange`, `BypassQuery`, `BYPASS_WINDOW_MS`.
- REVIEW-8 #7: records carry `owner` (random per instance), `pid` and `heartbeat` (refreshed every 30 s while
  routed, `tick()`); `recover()` and `apply()` leave a record alone while its owner lives (pid alive and heartbeat
  ≤ 2 min old), so another VS Code window can't revert a live session's emulator. `isRouted()` re-reads
  `http_proxy` at most every 10 s (and the heartbeat every 30 s): a route reverted or replaced by someone else is
  dropped, and the core then imports native entries again; while routed, a finished native entry that `proxySaw`
  says the proxy never recorded is imported too.
- Tests: `test/unit/adb.globalProxy.test.ts` (fake settings provider with ConnectivityService semantics),
  `test/unit/vm.bypass.test.ts` (fake profiles: verdicts, texts, window, caps, routed mode, trust failure),
  devices suite check J (and a no-false-positive assertion in I).

## Host wiring (lead, extension.ts)

```ts
import { AndroidGlobalProxy } from './adb';
import { matchesProxyExchange } from './vm';
const nativeRoutes = new AndroidGlobalProxy({ log, store: {
  get: () => context.globalState.get('flutterIntercept.emulatorProxies', []),
  set: (r) => context.globalState.update('flutterIntercept.emulatorProxies', r),
} });
void nativeRoutes.recover();                                   // repairs a crashed run
context.subscriptions.push({ dispose: () => void nativeRoutes.releaseAll() });   // also call it in deactivate()
const nativeMode = () => { const v = cfg().get<string>('nativeClients', 'profile'); return v === 'off' ? 'off' : v === 'proxy' ? 'proxy' : 'profile'; };
const vm = createVmWatcher({
  ...,
  nativeClients: nativeMode,
  nativeRouted: (sid) => nativeRoutes.isRouted(sid),
  nativeRouteFailed: (sid) => void nativeRoutes.release(sid),
  proxySaw: (q) => proxyHost.getExchanges().some((x) => matchesProxyExchange(x, q)),
});
// onDidStartDebugSession (intercepted dart:io sessions), after vm.attach:
if (nativeMode() === 'proxy' && /^emulator-\d+$/.test(deviceId ?? '') && (conf.flutterMode ?? 'debug') === 'debug')
  void nativeRoutes.apply(session.id, deviceId, port);
// onDidTerminateDebugSession: void nativeRoutes.release(session.id);
// proxy stopped while routed: void nativeRoutes.releaseAll();
```

Apply at session start (before the app is built and launched): cronet picks the proxy up immediately either way.

## Open points

- A command to save the CA certificate (PEM) for the app's `res/raw` / the emulator's Settings install.
- The emulator's own system traffic goes to the proxy while routed (Play services, connectivity check). It should
  fail the TLS handshake against our CA; whether mockttp lists those as exchanges or only as TLS client errors was
  not checked.
- iOS simulator routing stays open (only Mac-wide or injection-based options exist).
