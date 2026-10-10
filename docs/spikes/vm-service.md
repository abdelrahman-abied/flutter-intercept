# Spike: VM service access: background isolates and native clients (0.5.0, CONTRACTS §11.4)

Date: 2026-10-10. Flutter 3.47.6 / Dart 3.13.5, Dart-Code 3.144.0 (the integration VS Code), VM service protocol
4.21, dart:io service extension v4.0. Devices: Android emulator (API 36, arm64, debug), macOS desktop (debug +
profile). iOS simulator: `flutter build ios --simulator --debug` of the demo with cupertino_http succeeds; I did not
run it (cupertino_http uses the same NSURLSession code as macOS). Harnesses (scratch, not committed): a raw VM-service
probe over WebSocket, and a DAP client that drives `flutter debug_adapter` exactly like Dart-Code
(initialize → launch → configurationDone, custom requests and events). The final run fed the real
`src/vm/watcher.ts` from that DAP client.

## Verdict

| | Android emulator, debug | macOS, debug | macOS, profile |
|---|---|---|---|
| Reach the VM service via Dart-Code's DAP `callService` | ✅ | ✅ | ❌ (DAP has no VM connection) |
| Reach it directly (WebSocket to `dart.debuggerUris`) | ✅ | ✅ | ✅ |
| Background isolate seen, with its name | ✅ `demo_worker`, `demo_compute` | ✅ | ✅ (via WebSocket) |
| Native client in `ext.dart.io.getHttpProfile` | ✅ cronet_http | ✅ cupertino_http | ✅ cupertino_http |
| Native headers, status, timings | ✅ | ✅ | ✅ |
| Native bodies (`getHttpProfileRequest`) | ✅ | ✅ | ✅ |
| Tell apart dart:io requests that went through the proxy | ✅ `x-fi-id` (+ `proxyDetails` for https) | ✅ | ✅ |
| Capture a background isolate's own dart:io traffic | ❌ short-lived isolates exit before the next poll | ❌ | ❌ |

Implemented: DAP first (debug), direct WebSocket as the fallback (profile mode, or a Dart-Code without
`callService`), nothing when neither works. End-to-end with the real watcher (debug through DAP on Android + macOS,
profile through WebSocket on macOS): every native request was recorded once as `pending` and then updated to
`completed` with status, headers, duration and bodies (12 + 34 + 10 exchanges, no duplicates, including across a hot
restart). Both isolate warnings appeared; proxied dart:io traffic was never imported.

## 1. Reaching the VM service

**Dart-Code custom events** (`vscode.debug.onDidReceiveDebugSessionCustomEvent`, both the SDK DAP
`package:dds/src/dap/adapters/dart.dart` and Dart-Code's legacy adapter):
- `dart.debuggerUris {vmServiceUri}` — `ws://127.0.0.1:<port>/<auth-token>=/ws` (DDS). Sent once the app's VM
  service is up. The Flutter DAP sends it **in profile mode too**, though it doesn't connect a debugger
  (`flutter_adapter.dart`: `enableDebugger = … && !profileMode && !releaseMode`; `_connectDebugger` still calls
  `sendDebuggerUris`).
- `dart.serviceExtensionAdded {extensionRPC, isolateId}` — forwarded from the VM's `ServiceExtensionAdded` events
  **after** the DAP subscribed. That covers isolates started later (spawned, or the new main isolate after a hot
  restart) but **not** the main isolate at launch: its extensions registered before the DAP connected. No isolate
  names. The standard DAP `thread` events (one per isolate) aren't delivered to other extensions.
- `dart.serviceRegistered`, `flutter.appStart/appStarted`, `flutter.serviceExtensionStateChanged` (not needed).

**Custom request `callService {method, params}`** — SDK DAP: `vmService.callServiceExtension(method, args: params)`,
answers `response.json`. Legacy: `vmService.callMethod`, answers `result`. Plain VM methods work too (`getVM`,
`getIsolate`), not just `ext.*`. Latency 2–4 ms per call (`getVM` 4–30 ms). Errors reject the request with
the VM error text, e.g. `[Sentinel kind: Collected, valueAsString: <collected>] from ext.dart.io.getHttpProfile()`
for an isolate that exited.
**Profile mode:** the DAP has no `vmService`, so `callService` resolves with **no body** (it does not reject).
The watcher probes with `getVM`; when the answer has no `isolates` it falls back to the WebSocket.

**Direct WebSocket** (JSON-RPC 2.0, `streamListen {streamId:'Isolate'}`): works in debug and profile. DDS allows
several clients. Events come with isolate names: `IsolateStart`, `ServiceExtensionAdded` (the eight `ext.dart.io.*`
come right after `IsolateStart`, before `IsolateRunnable`), `IsolateExit`. The URI carries the auth token: the code
never logs it, and it only connects to loopback (`127.0.0.0/8`, `localhost`, `::1`). Flutter forwards device ports
to loopback, so the emulator and simulators qualify. WebSocket client: `globalThis.WebSocket` where it exists
(Node ≥ 22; VS Code 1.141 runs Node 24.21), otherwise the `ws` package. `ws` is **already in `dist/extension.js`**
(mockttp's WebSocket handlers pull it in: 14 `node_modules/ws/*` inputs in `dist/meta.json`), so this adds nothing
to the bundle and needs no `build.mjs` change. It isn't declared in `packages/extension/package.json`: it resolves
through hoisting from mockttp. **Requested:** add `"ws"` there (it is already in the lockfile).

Why DAP first: it's verified with Dart-Code's own connection, needs no second socket, and handles auth and remote
setups through Dart-Code. Isolate names need one `getIsolate` per new isolate (8–20 ms; spawned isolates lived at
least 250 ms in every run).

## 2. Isolates

- Main isolate: named `main` in Flutter and plain Dart. After a hot restart: `IsolateExit` of the old `main`, then
  `IsolateStart` of a new `main` (new id), dart:io extensions re-registered.
- Default names: `Isolate.run(f)` → `_RemoteRunner._remoteExecute`, `Isolate.run(f, debugName: 'x')` → `x`,
  `Isolate.spawn(work, …)` → `work` (the entry function), `compute(f, …)` → its `debugLabel`, which defaults to
  `callback.toString()` in debug (`Closure: (int) => … from Function '_todoInIsolate@…': static.`) and to
  `compute` in profile/release. The warning text shortens names past 60 characters.
- Every isolate registers the dart:io extensions, so `HttpClient.enableTimelineLogging` is **per isolate** like
  `HttpOverrides`. `ext.dart.io.httpEnableTimelineLogging` worked as soon as `ServiceExtensionAdded` arrived
  (1–15 ms; up to 515 ms once under load on macOS).
- Background-isolate HTTP: `demo_worker`/`demo_compute` ran their GET within ~250 ms and exited before the next
  1 s poll. Their profile dies with the isolate (`Collected` sentinel). The isolate-start race can't be won without
  pausing new isolates (Dart-Code already pauses them on start in debug and resumes them itself; the roadmap's DDS
  `requirePermissionToResume` path is still open). So: a **warning only**. A *long-lived* background isolate's
  dart:io traffic is imported (it never carries `x-fi-id`).

## 3. HTTP profile

`ext.dart.io.getHttpProfile {isolateId, updatedSince?}` → `{type:'HttpProfile', timestamp, requests:[@HttpProfileRequest]}`
(µs since epoch, **device clock**). Entries are refs: no bodies. `updatedSince` filters on each entry's last update
(`>=`). `timestamp` is taken before the list is built, so feeding it back as the next `updatedSince` loses
nothing. dart:io entries (`HttpProfiler`) and package:http_profile entries (`getHttpClientProfilingData()`) come in
one list.

**dart:io entries** (only while `HttpClient.enableTimelineLogging` is on, off by default):
- `id` = timeline task id (`-299097062`). `request` appears only once the request was sent, then `headers` (real
  lists), `proxyDetails {host, port}` when tunnelled through a proxy, `connectionInfo`, `contentLength`, …;
  `response` appears from the first response byte, with `endTime` once the body is done; `error` on either side.
- Through the proxy: every app request carries `x-fi-id` (template v4) and https requests also carry
  `proxyDetails`. **Plain `http://` through the proxy has no `proxyDetails`**, and with
  `flutterIntercept.captureSource` off there's no `x-fi-id` either, so such a request can't be told from DIRECT.
  Also present: `CONNECT //host:443` records (one per tunnel, `proxy=null`), the trace side channel
  (`POST https://trace.flutter-intercept.invalid/v1/traces`), and the WebSocket upgrade
  (`GET https://echo.websocket.org:0`, response 101, error `Socket has been detached`).
- Decision: **never import main-isolate dart:io entries** (they ran under our overrides; DIRECT happens only when
  the proxy is unreachable). Skip `CONNECT` everywhere. For a background isolate, wait until the request was sent,
  then import unless it has `x-fi-id` or `proxyDetails`.

**package:http_profile entries** (cupertino_http 3.1.0, cronet_http 1.10.0; ok_http 0.1.0 also reports through it):
- `id` = `from_package/<n>`, numbered per isolate from 1 (it **restarts at 1 after a hot restart**, so dedupe on
  `isolateId|id`). `request.headers` and `response.headers` are lists that package:http_profile **split on
  commas** (`date: ["Sat", "10 Oct 2026 06:47:31 GMT"]`), so the watcher joins them back with `", "`. Also
  `connectionInfo {package: 'package:cronet_http', client: 'CronetHttp'}` (used to name the client in the
  warning), `statusCode`, `reasonPhrase`, `redirects`, `startTime`/`endTime`. `response` is always present (an
  empty map before the response).
- Recorded only when profiling is on (`HttpClientRequestProfile.profilingEnabled` is
  `HttpClient.enableTimelineLogging`) and never in product builds. So a native request made **before** logging was
  enabled in that isolate is missed. In practice, in debug Dart-Code starts the app paused (`--start-paused`), so
  the main isolate is set up before user code runs. Every startup request was captured in all runs, profile mode
  included (the WebSocket connected ~0.3 s before the coverage batch). A request made in the first ~100 ms after a
  hot restart can be missed (re-enable took 60–100 ms).
- Bodies: `ext.dart.io.getHttpProfileRequest {isolateId, id}` (full `HttpProfileRequest`), with `requestBody` once
  the request ended and `responseBody` once the response ended, as **JSON arrays of byte numbers** (~4 JSON bytes
  per body byte). Bodies are what the client delivered: cronet and NSURLSession hand over decoded bytes while
  `content-encoding: gzip` stays in the headers. dart:io bodies are gunzipped by the watcher only if they start
  with the gzip magic.

**Cost** (with `updatedSince`): an idle poll took 1.9 ms on Android (WebSocket) and 2.5–3.6 ms via the DAP, and
returned ~1 KB. A detail call for a 300-byte body: 1–4 ms, 2–4 KB. Enabling timeline logging makes the app keep
**every** dart:io request with its bodies (and every http_profile entry) in memory until the isolate ends. That's
the same cost as an open DevTools Network tab. `clearHttpProfile` only clears the dart:io half and would also clear
DevTools' view, so the watcher doesn't call it. When `flutterIntercept.nativeClients` is switched to `off`, it
turns logging off again.

**Debug vs profile:** both work (profile only through the WebSocket). Release: no VM service, so nothing.

## 4. What was built (`packages/extension/src/vm/`)

- `profile.ts` (pure): entry classification (`import` / `skip` / `wait`), `toExchange` (method, url, headers,
  status, `startedAt`, `durationMs`, `state` `pending` → `completed` / `error`, `error`, `captured:'vm-profile'`),
  bodies (≤ 1 MB per side, utf8 or base64, `truncated`, gunzip of still-compressed bytes). No detail fetch when
  `contentLength` > 1 MB or the content-type is image/audio/video/font/octet-stream/zip/pdf/protobuf.
- `core.ts` (pure, one per session): learns isolates from `getVM` at start and from transport events. A warning
  goes out for every non-main isolate, once per name per session. The isolate counts as main when it's named
  `main`, or when it's the only isolate at start. Polling: 1 s, idle 2 s after 10 empty polls and 4 s after 30;
  errors back off ×2 up to 30 s; one `getHttpProfile` in flight per isolate (an isolate paused at a breakpoint
  answers on resume; calls time out after 5 s for the poll loop but stay "in flight"). A `Collected` / `Expired` /
  unknown-isolate error drops the isolate. Tracked keys are capped at 5000. When the transport closes, it stops.
- `transport.ts`: DAP transport (`callService`, `dart.serviceExtensionAdded` → `extension-added`) and WebSocket
  transport (JSON-RPC, `Isolate` stream → `isolate-start/exit`, `extension-added`). Both without vscode.
- `watcher.ts`: per-session bookkeeping and transport selection. A session starts once it is attached **and**
  either `dart.debuggerUris` or a `dart.serviceExtensionAdded` was seen. Selection order: DAP `getVM` probe (5 s),
  then the WebSocket (loopback only), else one log line and nothing. Detach, session end and dispose stop the
  watcher and clear the session's warnings.
- `index.ts`: `createVmWatcher(deps)`, which wires `vscode.debug.onDidStartDebugSession`,
  `onDidReceiveDebugSessionCustomEvent` and `onDidTerminateDebugSession` (sessions of type `dart` only) and returns
  `VmWatcher & Disposable`.

## 5. Wiring (lead, `extension.ts` + `package.json`)

```ts
import { createVmWatcher } from './vm';
const vm = createVmWatcher({
  record: (exs) => exs.map((ex) => proxy.record(ex)),          // InterceptProxy.record (§11.4); [] while no proxy runs
  update: (id, patch) => proxy.update(id, patch),
  setWarnings: (sessionId, ws) => { /* replace this session's entries in Status.warnings */ },
  log,
  nativeClients: () => vscode.workspace.getConfiguration('flutterIntercept').get<'profile' | 'off'>('nativeClients', 'profile'),
  // isWatched: () => panelVisible || mcpClients > 0,   // optional; entries are caught up when it turns true
});
context.subscriptions.push(vm);
// onDidStartDebugSession, after `intercepted.add(session.id)` (intercepted Dart/Flutter sessions only):
void vm.attach({ sessionId: session.id });
// onDidTerminateDebugSession: vm.detach(session.id)   (also done internally; harmless twice)
```
Attach as soon as the session starts. The watcher itself waits for `dart.debuggerUris`, and the order of the
`onDidStartDebugSession` listeners doesn't matter. Setting: `flutterIntercept.nativeClients`, enum
`["profile", "off"]`, default `"profile"`, description: "Show requests from native HTTP clients (cupertino_http,
cronet_http, ok_http) that bypass the proxy, read-only, from the app's HTTP profile (debug and profile mode).
Background-isolate warnings work either way."

## 6. Demo app (`samples/demo_app`)

A coverage batch runs after the first batch: `ws_echo`, `sse_events`, `gql_country`, `isolate_todo`,
`compute_todo`, and with `--dart-define=NATIVE_HTTP=true` also `native_get` / `native_post`. Use `COVERAGE=false`
to skip it and `COVERAGE_REPEAT_SECONDS=n` to repeat it (README). Everything was checked DIRECT on macOS:
`ws_echo 101 {"echoedText":true,"echoedBinary":true,…}`,
`sse_events 200 {"contentType":"text/event-stream","events":["server","request","time","time","time"]}`,
`gql_country 200 {"data":{"country":{…"Egypt"}}}`, both isolate results with `"overridesInIsolate":false`, and
`native_* 200/201`. Through `scripts/e2e/mitm_proxy.dart`, `ws_echo` and `sse_events` fail (that test proxy neither
upgrades WebSockets nor streams), as expected; the real proxy's WebSocket/SSE support is §11.1.
Android native client: **cronet_http 1.10.0 does not build with this app's AGP**
(`Namespace 'org.chromium.net' is used in multiple modules`: play-services-cronet 18.1.1 pulls `cronet-api` and
`cronet-shared`). `android.uniquePackageNames=false` in `android/gradle.properties` fixes it, so that line is
added (outside V's file list, flagged to the lead). ok_http 0.1.0 needs jni 0.10.1, which compiles against
android-31 and fails `checkDebugAarMetadata`. The packages are regular dependencies, so they are always built;
`NATIVE_HTTP` only gates their use. Lockfile side effect (pub resolution): `package_config` 3.0.0 → 2.2.0 and
`web_socket` 1.0.1 → 0.1.6 (transitive).

## REVIEW-5 follow-up (2026-10-10)

- #2: details (`getHttpProfileRequest`) are fetched only when the request length (contentLength / content-length,
  0 for a GET without either) and the response length are both known and ≤ 1 MB, and the response is textual
  (text/*, JSON, XML, JS, form, GraphQL, `+json` / `+xml`) or empty. Otherwise the exchange gets placeholder bodies
  `[body not imported: N bytes]` / `[body not imported: unknown length]` (`truncated: true`). Consequence: the
  cronet_http GET of the demo (chunked gzip, no length) is imported without its body; cupertino_http reports
  the length and keeps it.
- #7: `toExchange` validates every field: method `/^[A-Za-z]{1,16}$/`, http(s) URL ≤ 8 KB with control / bidi
  characters stripped (else the entry is dropped, one log line per session), ≤ 100 headers with token names ≤ 256,
  values ≤ 8 KB without control characters, ≤ 64 KB in total, status an integer 100–999, `startTime` finite and in
  the Date range (else now), error ≤ 1 KB.
- #12: ≤ 10 isolate warnings plus one "N more" summary, the native-client warning first, ≤ 5 client names,
  ≤ 1000 remembered names, ≤ 500 isolates (dead ones pruned on every tick and exit, whatever the setting), and
  the tracked-entry map is a hard-capped LRU (5000; pending entries are evicted too).
- #13: isolate and package names are sanitised (control / zero-width / bidi characters stripped, then outside a
  small character set replaced by `?`, ≤ 60 characters, quoted). Package names must match `package:[a-z][a-z0-9_]*`.
  Warning texts are ≤ 200 characters, and every log line is stripped of control characters.
- #14: main isolate = the only isolate at start (or the first named `main` then). Later, an isolate named `main`
  becomes main only when the previous main is gone (it answers `getIsolate` with a Collected / Expired
  sentinel: the hot-restart case, checked live). A background isolate named `main` gets a warning. `x-fi-id` no
  longer hides anything. A background dart:io entry is skipped only when `proxyDetails` names our proxy, through
  the new optional dep `isOurProxy(host, port)` (absent = import). The root library can't identify main:
  `Isolate.run` / `compute` / `spawn` isolates share the isolate group and its root library.
- #15: timeline logging is enabled in background isolates, and in the main isolate only when its `libraries` from
  `getIsolate` include `package:http_profile/…` (when the list is unknown, it is enabled). Checked live in debug:
  at start-paused the library list already contains it. On `stop()` (detach / session end / dispose) it is turned
  off again in every live isolate where it was turned on (best effort, before the transport closes).

## Requested contract changes

1. §11.4 "record entries that did NOT go through the proxy": refine to "package:http_profile entries, and dart:io
   entries of background isolates without `x-fi-id` / `proxyDetails`". Main-isolate dart:io entries are never
   imported: plain-http through the proxy is indistinguishable from DIRECT when source capture is off.
2. `VmHostDeps` gains (implemented as an extension in `src/vm/index.ts`): `nativeClients(): 'profile' | 'off'`, and
   optionally `isWatched?(): boolean` and `webSocket?: WebSocketCtor | null`.
3. Imported bodies are capped at 1 MB per side (the proxy cap is 5 MB): the profile ships bodies as JSON number
   arrays through the DAP.
4. `ws` as an explicit dependency of `packages/extension` (already bundled through mockttp).

## Open points

- Background-isolate interception (not just a warning) still needs the DDS `requirePermissionToResume` +
  `evaluate` spike (roadmap 0.5.0 row). Dart-Code itself pauses isolates on start in debug, so this needs care.
- Hot restart: native requests in the first ~100 ms of the new main isolate can be missed.
- iOS simulator / physical iPhone runs of `NATIVE_HTTP=true` belong to the device E2E (only the build was checked).
- Plain `dart` CLI sessions: same code path (main isolate is `main`); not run through Dart-Code here.
