# Spike — template v4: request → source

Date 2026-10-09 · Flutter 3.47.6 / Dart 3.13.5 (+ Dart 3.0.0 / 3.3.0 / 3.6.0 / 3.9.0) · Agent E · CONTRACTS §9.1

## Verdict: **works — with a zone chain for Dio (debug only)**

| Client | `StackTrace.current` in `openUrl` (sync only) | + zone chain (v4) |
|---|---|---|
| `package:http` — `http.get`, `Client.post` | ✅ app call site on the stack (frame 3–6) | ✅ same |
| raw `HttpClient` | ✅ frame 0 after the entry's own frames | ✅ same |
| Dio — plain `dio.get` | ❌ **no app frame**: the stack ends in `DioMixin._dispatchRequest` / `DioMixin.fetch.<anonymous closure>` / `_observeInterceptorCallback` | ✅ `dioPlainCallSite` |
| Dio + async `InterceptorsWrapper` | ❌ same | ✅ |
| Dio + `QueuedInterceptorsWrapper` (+ `LogInterceptor`) | ❌ same | ✅ |
| Dio + custom async `Transformer` | ❌ same | ✅ |
| Dio called from a `Timer` callback | ❌ same | ✅ the closure inside the timer callback |

Even plain Dio with no interceptors loses the call site. Dio sends every request through its
interceptor pipeline, which is built from `Future.then` and `Completer`s. The VM's awaiter-stack
unwinding cannot follow those, so the stack at `openUrl` stops inside Dio.

Capturing the stack synchronously is therefore not enough for the most common client. v4 adds an
inline zone chain, like `package:stack_trace`'s `Chain.capture` but much smaller and written in the
entry, with no dependency:
- It runs only in **debug/JIT** sessions. It is off in profile builds; release builds are never
  intercepted.
- It is off when tracing is off (`FLUTTER_INTERCEPT_TRACE=0`).

The zone chain costs about **+1.2–1.7 µs per `await` or `Future.then`** in debug: +1.25 µs in the
VM, +1.4 µs on the iOS simulator, +1.7 µs on the Android emulator. Everything else in v4 is
per-request and small:
- In the VM it adds +0.05–0.3 ms per request on a sub-millisecond loopback request.
- On devices it is not measurable on the emulator, and +0.2–0.25 ms on the iOS simulator against a
  local server.

That is acceptable in debug, where JIT and asserts already dominate. Profile builds pay only the
sync capture. `FLUTTER_INTERCEPT_TRACE=0` costs nothing.

## How v4 works (diff from v3)

1. **Every request-opening member is traced.** The 14 members are `open`, `openUrl`, and
   `get` through `headUrl`. Each one is wrapped as `_traced(_client.<member>(…))`. `_traced` runs
   synchronously in the app's call and does four things:
   - It captures `StackTrace.current` and the current zone chain.
   - It makes an id `<16 hex from Random.secure() per isolate start>-<counter base36>`, for example
     `8177dff37f294e6e-1a`. The id matches `/^[A-Za-z0-9_-]{8,64}$/` and gets a new prefix after
     every hot restart.
   - It queues the trace.
   - It returns `request.then((r) { r.headers.set('x-fi-id', id); return r; })`.
2. **Side channel.** A root-zone `Timer` flushes the queue about 100 ms after the first queued
   trace. It sends `POST https://trace.flutter-intercept.invalid/v1/traces` with
   `{"traces":[{"id","stack"}]}`, at most 50 traces per POST. The rules for that POST:
   - **Dedicated client.** It is a plain `HttpClient` created under an empty `HttpOverrides`, so
     it is neither the app's client nor wrapped, and it is never traced.
   - **Proxy only.** Its `findProxy` returns `'PROXY $_proxyAddress'`, with **no `; DIRECT`**.
   - **One connection** (`maxConnectionsPerHost = 1`, REVIEW-3 #5): batches queue behind each other
     instead of competing with the app for the proxy's per-client (LAN per-IP) connection budget.
   - **Errors are swallowed.** The first failure prints one note:
     `[flutter_intercept] request sources are unavailable (could not reach the intercept proxy: …)`.
   - **Connection lifetime.** Flutter apps (`bool.fromEnvironment('dart.library.ui')`) keep the
     connection for the next batch. Plain Dart programs close the client as soon as nothing is
     queued or in flight, so they never wait 15 s for an idle keep-alive connection. Measured: the
     proxy-down VM run exits in 0.6 s.
   - **Bounded queue.** It holds at most 1000 traces; the oldest is dropped first.
3. **Zone chain** (debug only:
   `_traceEnabled && !bool.fromEnvironment('dart.vm.profile') && !bool.fromEnvironment('dart.vm.product')`).
   The app's `main` runs in `runZoned(…, zoneSpecification: …)` inside the existing overrides zone.
   - `registerUnaryCallback` (every `then` and every `await`) records `StackTrace.current` plus up
     to 9 earlier registration stacks (newest first) as a fixed-size list. There are no parent
     pointers, so the chain does not grow in polling loops.
   - `registerCallback` (microtasks and timers) and `registerBinaryCallback` (error handlers) do
     not capture a stack of their own. They keep the chain that was current when they were
     registered.
   - Why skip those two: each `await` registers a unary callback, a binary callback and a
     microtask. Capturing only the unary one cut the measured cost from 2.8 to 1.6 µs per async
     call in the VM, and every Dio, http and Timer call site was still found.
   - A retry made from `onError` still leads back to the app's call.
   - A global `_currentChain` is set while a wrapped callback runs.
4. **Stack text (lean).** Each segment is the VM `StackTrace.toString()` with frames from `dart:`
   libraries and frames from the generated entry removed. Those frames are event-loop and zone
   plumbing, never a call site. The original `#n` lines are kept, so numbering has gaps, and
   `<asynchronous suspension>` markers between kept frames stay.
   - Segments are joined with stack_trace's `===== asynchronous gap ===========================` line.
   - Only whole segments are added, up to 16 000 chars.
   - Effect on devices: an average of **1.0 KB** per trace (max 1.4 KB) instead of 3–8 KB.
   - Effect on the app frame: for Dio it is at frame index 9 instead of about 45, safely inside
     the proxy's 30-frame window. The proxy's `toSourceInfo` also handles the unfiltered format.
5. `FLUTTER_INTERCEPT_TRACE=0` turns everything off: no header, no queue, no zone, no side channel.
   Verified in the VM unit test: no `x-fi-id`, 0 POSTs.

Example: the Dio + 2-interceptor request on the iOS simulator, as the proxy receives it:

```
#2      IOHttpClientAdapter._fetch (package:dio/src/adapters/io_adapter.dart:80:34)
#3      IOHttpClientAdapter.fetch (package:dio/src/adapters/io_adapter.dart:71:12)
#4      DioMixin._dispatchRequest (package:dio/src/dio_mixin.dart:607:27)
===== asynchronous gap ===========================
#3      DioMixin._dispatchRequest (package:dio/src/dio_mixin.dart:605:22)
#4      DioMixin.fetch.<anonymous closure> (package:dio/src/dio_mixin.dart:554:31)
#5      DioMixin.fetch.requestInterceptorWrapper.<anonymous closure>.<anonymous closure> (package:dio/src/dio_mixin.dart:441:32)
===== asynchronous gap ===========================
#7      DioMixin.fetch.requestInterceptorWrapper.<anonymous closure> (package:dio/src/dio_mixin.dart:439:13)
===== asynchronous gap ===========================
#4      DioMixin.fetch (package:dio/src/dio_mixin.dart:547:21)
#5      DioMixin.request (package:dio/src/dio_mixin.dart:414:12)
#6      DioMixin.get (package:dio/src/dio_mixin.dart:71:12)
#7      CatalogApi.fetchAlbum (package:demo_app/api/catalog_api.dart:37:12)
#8      catalogAlbum.<anonymous closure> (package:demo_app/demo.dart:186:32)
...
#14     main (package:demo_app/main.dart:3:16)
```

## Results

### Dart VM (scratch harness: `dio` 5.11.1 + `http`; the test proxy `scripts/e2e/mitm_proxy.dart` logs `PROXY_TRACE`)

The first app frame is the call site in every case, on every SDK:

| SDK | dio plain | dio + interceptor | dio + Queued | dio + transformer | http.get | http Client.post | raw | from Timer |
|---|---|---|---|---|---|---|---|---|
| 3.0.0 (dio 5.11.1, http 1.1.0) | ✅ idx 9 | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 6 | ✅ 3 | ✅ 0 | ✅ 9 |
| 3.3.0 (same) | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 6 | ✅ 3 | ✅ 0 | ✅ 9 |
| 3.6.0 (http 1.6.0) | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 6 | ✅ 3 | ✅ 0 | ✅ 9 |
| 3.9.0 | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 6 | ✅ 3 | ✅ 0 | ✅ 9 |
| 3.13.5 | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 9 | ✅ 6 | ✅ 3 | ✅ 0 | ✅ 9 |

`idx` is the frame index of the app frame in the lean stack. Without the chain, Dio has no app frame
on any SDK.

### Devices (`scripts/e2e/run_device.sh <dev> --port <p> --entry-dir <dir>`, template v4)

Both runs: **ALL PASSED**. Each run covers interception, mock, block, gzip and plain http, then hot
restart, then the proxy-down DIRECT fallback.

Source checks (first `package:demo_app` frame of the trace for each request), identical before and after hot restart:

| Request | Android emulator (API 36.1, `adb reverse`) | iOS simulator (iPhone 17 Pro, iOS 26.2) |
|---|---|---|
| http POST `OrdersApi.createOrder` | ✅ `api/orders_api.dart:15:20` | ✅ same |
| http GET (`_httpGet`) | ✅ `demo.dart:70:63` | ✅ |
| Dio + `DemoClientHeaderInterceptor` + `DemoAuthInterceptor` (QueuedInterceptor) `CatalogApi.fetchAlbum` | ✅ `api/catalog_api.dart:37:12` | ✅ |
| Dio GET `dioUser` | ✅ `demo.dart:135:28` | ✅ |
| Dio POST `dioPost` | ✅ `demo.dart:146:28` | ✅ |
| new id prefix after hot restart | ✅ 2 prefixes | ✅ |
| proxy down | ✅ app works DIRECT, one note per isolate run | ✅ |

The final template was re-run on both devices and passed. These runs counted every request against
its trace:
- `run_device.sh` runs (18 requests each): no request without a trace.
- Bench runs: 400 of 400 requests, once the script waited for the last batch.

**Android profile (AOT), `--profile --emulator-host`.** Interception, mock, block and gzip pass, and
traces arrive. The http call sites are found, with a line but **no column**, because AOT stacks
print `orders_api.dart:15`. The chain is off in profile, as designed, so Dio requests show only
Dio frames (`DioMixin.fetch.<anonymous closure>`, `_observeInterceptorCallback`). Profile stacks
are symbolic, not `#00 abs …`, because profile builds are not obfuscated.

The extension-level device suite (`test/integration/suite/devices.ts`) now asserts the same through
the real proxy: `Exchange.source.appFrame`, resolution to the workspace file, no `x-fi-id` upstream,
and `captureSource=false`. See "Device integration" below.

## Cost

### Dart VM (Dart 3.13.5 JIT, Apple silicon)

Loopback upstream (~0.7 ms per request) through the Dart test proxy on the same machine; 300
sequential requests per client; 3 alternating repetitions (the first repetition is warm-up and was
discarded). `scratchpad ab2.sh`:

| Entry | async call (`await` in a fresh async fn) | `Future.then` | Dio req | http req | process CPU (900 req) |
|---|---|---|---|---|---|
| v3 | 220–230 ns | 335–353 ns | 826–827 µs | 679–718 µs | 1.65–1.66 s |
| v4, `FLUTTER_INTERCEPT_TRACE=0` | 220–224 ns | 339–353 ns | 827–907 µs | 681–715 µs | 1.65–1.72 s |
| v4 sync only (`-Ddart.vm.profile=true`, = profile builds) | 220–225 ns | 333–346 ns | 990–1027 µs | 733–751 µs | 1.68–1.73 s |
| **v4 (debug: + chain)** | **1452–1571 ns** | **1414–1535 ns** | 1115–1132 µs | 793–869 µs | 1.84–1.90 s |
| *rejected draft: chain also capturing timers/microtasks* | *2595–2677 ns* | *2553–2562 ns* | *1334–1427 µs* | *926–963 µs* | *1.97–2.00 s* |

What the table shows:
- `TRACE=0` costs nothing.
- Sync tracing costs about +170 µs per Dio request and +50 µs per http request. That covers the
  capture, the stringify and the POST, plus the test proxy logging every trace on the same CPU. In
  the app itself it is `StackTrace.current` (about 0.8 µs) plus `toString` (about 3 µs) plus a share
  of the batch POST.
- The chain adds about +1.25 µs per async suspension or `then`. That is about +0.1–0.3 ms per
  request on loopback, and +12 % process CPU for a run that does nothing but 900 back-to-back
  requests.
- Against real network requests (50–500 ms) all of this is noise. Requests that wait on a timer
  (`dio_queued`, about 9 ms) showed no difference.

### Devices (debug, temporary bench target)

The bench target ran 3 rounds × 100k calls, then 2 × 100 sequential requests per client to
`scripts/e2e/host_server.dart` through the test proxy. Request times are medians, with the
warm-up round first.

| | Android emulator v3 | Android emulator **v4** | iOS simulator v3 | iOS simulator **v4** |
|---|---|---|---|---|
| async call (`await`), steady rounds | 270–298 ns | **1 978–2 204 ns** | 253–256 ns | **1 598–1 674 ns** |
| `Future.then` | 298–502 ns | **1 817–2 427 ns** | 248–261 ns | **1 407–1 563 ns** |
| Dio request, median | 2.34 / 2.82 ms | 2.09–2.21 / 2.37–2.41 ms | 1.28 / 0.91 ms | 1.31–1.36 / 1.17–1.19 ms |
| http request, median | 2.17–2.38 / 2.20–2.32 ms | 1.79–2.15 / 2.04–2.19 ms | 0.84 / 0.72 ms | 0.91–0.92 / 0.95–0.96 ms |
| traces received | 0 | 400 / 400 (the last batch arrives ≤ 0.6 s after the last request) | 0 | 400 / 400 |

Each v3 and v4 configuration ran twice per device. The rejected capture-everything draft measured
3.6 µs per `await` on the emulator and 2.9 µs on the simulator.

Over the real network (jsonplaceholder through the test proxy) the medians varied by ±100 ms
between runs in both directions, so they cannot show this overhead.

## Compatibility

`scripts/e2e/compat/run_compat.sh` (now default `FI_TEMPLATE=v4`; also counts the `PROXY_TRACE`
lines with an app frame). It uses the dart:io harness (2.12 syntax) and the full case list from v2/v3:

| SDK | language 2.12 | language 3.0 |
|---|---|---|
| 3.0.0 | ✅ failures=0, traces=15, with_app_frame=15 | ✅ same |
| 3.3.0 | ✅ | ✅ |
| 3.6.0 | ✅ | ✅ |
| 3.9.0 | ✅ | ✅ |
| 3.13.5 | ✅ | ✅ |

The new code uses only language-2.12 features:
- `Random.secure` (`dart:math`), with a fallback to `Random(seed)` if it is unsupported.
- `ZoneSpecification` with generic handler tear-offs.
- `Zone.root.createTimer` and `HttpOverrides.runWithHttpOverrides<HttpClient>`.
- `late`-free globals.

It uses no records and no wildcards. `dart analyze` is clean on every generated entry.

## Unit tests (`packages/extension/test/unit/generator.test.ts`)

- **Static.** All 14 request-opening members are `_traced(_client.<m>(…))`. Imports are exactly
  `dart:async`, `dart:convert`, `dart:io` and `dart:math`. The header name, URL and define are
  present. Only the app's `_proxy` has `; DIRECT`; the trace client uses `'PROXY $_proxyAddress'`.
  The chain is gated on `dart.vm.profile` and `dart.vm.product`. The template contains no wildcard
  or record syntax. `ENTRY_TEMPLATE` is identical to `scripts/e2e/templates/entry_v4.dart.tmpl`
  and to the "Contract text" block below. The CONTRACTS §1 comparison is skipped until §1 contains
  `x-fi-id`, then it is enforced again.
- **Real Dart with a mockttp proxy** that signs with the install CA and answers the trace host:
  - Both requests carry distinct, well-formed `x-fi-id`s.
  - The posted traces cover exactly those ids. The sync stack names `directCall (…fetch.dart:6:`.
  - A request opened in a `.then` callback names `afterAsyncGap (…fetch.dart:13:`, which is only
    reachable through the chain (`===== asynchronous gap`).
  - Content type is JSON, at most 50 traces per POST, each stack at most 16 000 chars.
  - Id prefixes differ between runs.
  - `-DFLUTTER_INTERCEPT_TRACE=0`: no header and no POST.
  - Proxy down: the app works DIRECT, exactly one note is printed, and the program exits in under
    10 s (measured 0.6 s).

## Demo app scenarios (`samples/demo_app/lib/`, no tool code)

| Label | Call site | What it is for |
|---|---|---|
| `catalog_album` | `CatalogApi.fetchAlbum` in `lib/api/catalog_api.dart` | Dio through `DemoClientHeaderInterceptor` (sync) and `DemoAuthInterceptor` (`QueuedInterceptor`, async token): the hard case for source capture |
| `orders_create` | `OrdersApi.createOrder` in `lib/api/orders_api.dart` | package:http `Client.post` with a JSON body and an `idempotency-key`: the request worth resending (jsonplaceholder answers 201 with the created item) |
| `local_health` | `fetchLocalHealth` in `lib/api/local_api.dart` | only with `--dart-define=LOCAL_PORT=<n>`: `GET http://10.0.2.2:<n>/health` on the Android emulator, `http://localhost:<n>/health` elsewhere (`LOCAL_HOST` overrides). This is the localhost-rewrite check (CONTRACTS §9.2) |

All three are in the startup batch (`local_health` only when `LOCAL_PORT` is set) and have buttons
in the UI. The existing labels, URLs and modes are unchanged. Two refactors were made:
- Dio's adapter and options are now built by `_dioAdapter()` and `_dioOptions()`, so the new
  catalog client uses the same pinning and findProxy modes.
- package:http calls share one `_httpClient`.

`flutter analyze`: no issues.

**Host server for `local_health`.** `dart run scripts/e2e/host_server.dart --port 8787` binds
127.0.0.1 only and answers JSON. Run the app with `--dart-define=LOCAL_PORT=8787`.
- On the Android emulator, the request reaches the server only through the proxy's
  `10.0.2.2 → 127.0.0.1` rewrite. Without the proxy, the emulator's own alias is used.
- On the iOS simulator, `localhost` already is the Mac.
- On a physical Android device, use `LOCAL_HOST=localhost` plus `adb reverse tcp:8787 tcp:8787`.

The demo README (not owned by this agent) should get these lines (lead).

## Device integration (`test/integration/suite/devices.ts`)

These checks were added to the existing A–G steps:
- **A (launch) and B (after hot restart).** `checkSources` waits up to 20 s for the
  `catalog_album` (Dio + interceptors) and `orders_create` (http) exchanges to carry `source`.
  - The `appFrame` must be `package:demo_app/api/catalog_api.dart` / `orders_api.dart`.
  - Its line must equal the line of the call in the demo source. The test looks it up by
    content, so it survives edits.
  - Its `fn` must start with `CatalogApi.fetchAlbum` / `OrdersApi.createOrder`.
  - `resolveFrames` must map it to `<workspace>/lib/api/…dart` with `inProject`.
  - No recorded exchange has `x-fi-id` in `requestHeaders`.
  - httpbin's echo of the request headers it received (`http_gzip`, `http_plain`) has no `X-Fi-Id`.
- **H (new).** `flutterIntercept.captureSource=false`: the session carries exactly
  `--dart-define=FLUTTER_INTERCEPT_TRACE=0` and no exchange gets a source.

`catalog_album` and `orders_create` were added to the suite's URL table, so every step checks that
they are recorded and return 2xx.

**Run against the real proxy** (agent P's trace sink, header strip and `Exchange.source`), using the
source tree build:
`FI_SUITE=devices FI_DEVICES=emulator-5554,<iOS simulator> node dist-test/runTest.js`. Result:
**14/14 runs passed**.
- Android: A–H, including profile and release.
- iOS simulator: A–E and H.
- A and B report `catalog_album=CatalogApi.fetchAlbum@api/catalog_api.dart:37` and
  `orders_create=OrdersApi.createOrder@api/orders_api.dart:15` on both devices.

## Notes / residual limits

- **Library-internal timers.** A library that schedules a `Timer` or microtask synchronously from
  the app's call, and later opens the request from its own closure without any `then` in between,
  loses the call site, because timers do not capture. Debouncers written in app code are not
  affected: the app's closure is on the sync stack.
- **Profile builds** capture the sync stack only. package:http and raw `HttpClient` call sites are
  found; Dio requests get Dio frames and no app frame. To change that, the lead could make the
  chain a setting.
- **When the proxy is down,** requests still carry the opaque `x-fi-id` to the real server. This
  is by contract: nothing else leaves the device, because `.invalid` never resolves and the trace
  client has no DIRECT.
- **App zones.** If the app wraps its code in its own zone, our chain is the parent, so it keeps
  working. If the app replaces callbacks with its own `registerCallback` hooks, our capture still
  runs, because zone hooks delegate to the parent.
- **Background isolates** are not intercepted, as before.
- **`run_device.sh` fix.** A pre-existing race in `run_device.sh` is fixed: the log file now
  exists before `flutter run`'s redirect waits on the fifo, which had made `wait_batch` skip
  waiting on a fast iOS run.
- **Temporary files.** The bench target `lib/zz_trace_bench.dart` was temporary and was deleted.
  It was never committed.

## Requested contract changes (§9.1)

1. Replace the §1 template with the text below. The `generator.test.ts` contract check turns back
   on automatically once §1 contains `x-fi-id`.
2. §9.1 stack text should read: "lean VM format: frames of `dart:` libraries and of the generated
   entry are dropped (original `#n` numbering kept), `<asynchronous suspension>` kept between kept
   frames. In debug/JIT sessions, earlier registration stacks follow, separated by
   `===== asynchronous gap ===========================` (whole segments, at most 10, total ≤ 16 000
   chars). In profile, only the synchronous stack."
3. §9.1 should note the zone: "debug/JIT only (`dart.vm.profile` / `dart.vm.product` false), the
   app's `main` runs in a `runZoned` with `registerCallback` / `registerUnaryCallback` /
   `registerBinaryCallback` hooks inside the overrides zone."
4. §9.1 should note that the failure note text is
   `[flutter_intercept] request sources are unavailable (could not reach the intercept proxy: <error>)`,
   printed once per isolate run.

## Contract text for §1

```dart
// GENERATED by Flutter Intercept. Do not edit. Safe to delete.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import '{{TARGET_IMPORT}}' as target; // package:<app>/<path> when under lib/, else relative

// Flutter sessions pass --dart-define=FLUTTER_INTERCEPT_PROXY=<host:port> (device dependent);
// the default serves plain Dart sessions, which run on the host and take no dart-define.
const _proxyAddress = String.fromEnvironment('FLUTTER_INTERCEPT_PROXY', defaultValue: 'localhost:{{PROXY_PORT}}');
const _proxy = 'PROXY $_proxyAddress; DIRECT';

String _findProxy(Uri url) => _proxy;

// Request -> source (CONTRACTS §9.1). Each request carries an opaque `x-fi-id` header; the stack
// captured when the app opened it goes to the proxy out of band (never upstream). Flutter sessions
// pass --dart-define=FLUTTER_INTERCEPT_TRACE=0 when the user turned it off.
const _traceEnabled = String.fromEnvironment('FLUTTER_INTERCEPT_TRACE') != '0';
// Libraries such as Dio open the connection several async hops after the app's call, so the stack at
// that point no longer shows it. In debug (JIT) sessions the app runs in a zone that remembers where
// each callback was registered (like package:stack_trace's Chain.capture); never in profile builds.
const _traceChains = _traceEnabled && !bool.fromEnvironment('dart.vm.profile') && !bool.fromEnvironment('dart.vm.product');
const _traceHeader = 'x-fi-id';
// `.invalid` never resolves and the side channel has no `; DIRECT`: stacks only ever reach the proxy.
final Uri _traceUrl = Uri.parse('https://trace.flutter-intercept.invalid/v1/traces');
const _traceMaxChars = 16000;
const _traceBatch = 50;
const _traceQueueLimit = 1000;
// Flutter apps keep the side channel's connection for the next batch; plain Dart programs close it.
const _flutterApp = bool.fromEnvironment('dart.library.ui');

// Random per isolate start (so ids stay unique across hot restarts) + a counter.
final String _tracePrefix = () {
  Random random;
  try {
    random = Random.secure();
  } catch (_) {
    random = Random(DateTime.now().microsecondsSinceEpoch);
  }
  final buffer = StringBuffer();
  for (var i = 0; i < 16; i++) {
    buffer.write(random.nextInt(16).toRadixString(16));
  }
  return buffer.toString();
}();
int _traceCount = 0;

class _PendingTrace {
  _PendingTrace(this.id, this.stack, this.chain);
  final String id;
  final StackTrace stack;
  final List<StackTrace>? chain;

  /// The VM stack, then (whole) earlier registrations in package:stack_trace's Chain format.
  String format() {
    var out = _lean('$stack');
    final c = chain;
    if (c != null) {
      for (final t in c) {
        final segment = _lean('$t');
        if (segment.isEmpty) continue;
        final next = '$out$_chainGap\n$segment';
        if (next.length > _traceMaxChars) break;
        out = next;
      }
    }
    return out.length > _traceMaxChars ? out.substring(0, _traceMaxChars) : out;
  }
}

/// VM stack lines without frames of `dart:` libraries and of this file (event loop and zone
/// plumbing, never the app's call site); `<asynchronous suspension>` markers between kept frames stay.
String _lean(String trace) {
  final out = StringBuffer();
  var suspended = false;
  for (final line in trace.split('\n')) {
    if (line.isEmpty) continue;
    if (line == '<asynchronous suspension>') {
      suspended = true;
      continue;
    }
    if (line.contains('(dart:') || (line.contains('/.dart_tool/') && line.contains('/entry_'))) continue;
    if (suspended && out.isNotEmpty) out.write('<asynchronous suspension>\n');
    suspended = false;
    out.write('$line\n');
  }
  return out.toString();
}

const _chainDepth = 10;
const _chainGap = '===== asynchronous gap ===========================';
// Registration stacks of the callback running now, newest first (null outside the chain zone).
List<StackTrace>? _currentChain;

List<StackTrace> _chainHere() {
  final parent = _currentChain;
  final out = <StackTrace>[StackTrace.current];
  if (parent != null) {
    for (var i = 0; i < parent.length && out.length < _chainDepth; i++) {
      out.add(parent[i]);
    }
  }
  return out;
}

// Microtasks and timers keep the chain they were scheduled under without a capture of their own: they
// are scheduled at least once per `await`, which would double the cost, and the code that schedules
// one from the app's call already registered a `then` (captured below) or runs the app's own closure.
ZoneCallback<R> _registerCallback<R>(Zone self, ZoneDelegate parent, Zone zone, R Function() f) {
  final chain = _currentChain;
  final g = parent.registerCallback<R>(zone, f);
  if (chain == null) return g;
  return () {
    final previous = _currentChain;
    _currentChain = chain;
    try {
      return g();
    } finally {
      _currentChain = previous;
    }
  };
}

ZoneUnaryCallback<R, T> _registerUnaryCallback<R, T>(Zone self, ZoneDelegate parent, Zone zone, R Function(T) f) {
  final chain = _chainHere();
  final g = parent.registerUnaryCallback<R, T>(zone, f);
  return (T a) {
    final previous = _currentChain;
    _currentChain = chain;
    try {
      return g(a);
    } finally {
      _currentChain = previous;
    }
  };
}

// Error handlers keep the chain they were registered under without a capture of their own (half the
// cost of an `await`); a retry from an error handler still leads back to the app's call.
ZoneBinaryCallback<R, T1, T2> _registerBinaryCallback<R, T1, T2>(
    Zone self, ZoneDelegate parent, Zone zone, R Function(T1, T2) f) {
  final chain = _currentChain;
  final g = parent.registerBinaryCallback<R, T1, T2>(zone, f);
  if (chain == null) return g;
  return (T1 a, T2 b) {
    final previous = _currentChain;
    _currentChain = chain;
    try {
      return g(a, b);
    } finally {
      _currentChain = previous;
    }
  };
}

final List<_PendingTrace> _pendingTraces = <_PendingTrace>[];
Timer? _traceTimer;
int _tracePosts = 0;
HttpClient? _traceClient;
bool _traceFailed = false;

/// Tags a request the app is opening with an id and queues the app's stack for the proxy.
/// Must be called synchronously from the HttpClient member the app called.
Future<HttpClientRequest> _traced(Future<HttpClientRequest> request) {
  if (!_traceEnabled) return request;
  final stack = StackTrace.current;
  _traceCount++;
  final id = '$_tracePrefix-${_traceCount.toRadixString(36)}';
  if (_pendingTraces.length >= _traceQueueLimit) _pendingTraces.removeAt(0);
  _pendingTraces.add(_PendingTrace(id, stack, _currentChain));
  _traceTimer ??= Zone.root.createTimer(const Duration(milliseconds: 100), _flushTraces);
  return request.then((HttpClientRequest r) {
    try {
      r.headers.set(_traceHeader, id);
    } catch (_) {
      // Headers already sent or immutable: this request just has no source.
    }
    return r;
  });
}

void _flushTraces() {
  _traceTimer = null;
  while (_pendingTraces.isNotEmpty) {
    final n = _pendingTraces.length < _traceBatch ? _pendingTraces.length : _traceBatch;
    final batch = _pendingTraces.sublist(0, n);
    _pendingTraces.removeRange(0, n);
    _postTraces(batch);
  }
}

class _UntracedOverrides extends HttpOverrides {}

Future<void> _postTraces(List<_PendingTrace> batch) async {
  _tracePosts++;
  try {
    // A plain dart:io client (not the app's, not wrapped, never traced) that may only use the proxy, over
    // one connection so batches never compete with the app for the proxy's per-client connection budget.
    final client = _traceClient ??=
        HttpOverrides.runWithHttpOverrides<HttpClient>(() => HttpClient(), _UntracedOverrides())
          ..findProxy = ((Uri url) => 'PROXY $_proxyAddress')
          ..maxConnectionsPerHost = 1;
    final traces = <Map<String, String>>[];
    for (final t in batch) {
      traces.add(<String, String>{'id': t.id, 'stack': t.format()});
    }
    final body = utf8.encode(jsonEncode(<String, Object>{'traces': traces}));
    final request = await client.postUrl(_traceUrl);
    request.headers.contentType = ContentType.json;
    request.contentLength = body.length;
    request.add(body);
    final response = await request.close();
    await response.drain<void>();
  } catch (e) {
    if (!_traceFailed) {
      _traceFailed = true;
      _note('request sources are unavailable (could not reach the intercept proxy: $e)');
    }
  } finally {
    _tracePosts--;
    // An idle keep-alive connection would hold a plain Dart program open for 15 s.
    if (!_flutterApp && _tracePosts == 0 && _pendingTraces.isEmpty && _traceTimer == null) {
      _traceClient?.close();
      _traceClient = null;
    }
  }
}

// Certificate of this machine's Flutter Intercept CA (its private key never leaves the
// development machine). It is *trusted* in addition to the normal roots, so the proxy's
// per-host certificates pass ordinary chain + hostname verification, and DIRECT traffic
// (proxy unreachable) is verified exactly as without Flutter Intercept.
const _caCertificate = r'''
{{CA_CERT_PEM}}''';

final Expando<bool> _trustedContexts = Expando<bool>();
void _trustCa(SecurityContext context) {
  if (_trustedContexts[context] == true) return;
  _trustedContexts[context] = true;
  try {
    context.setTrustedCertificatesBytes(utf8.encode(_caCertificate));
  } catch (e) {
    // Already present (e.g. CERT_ALREADY_IN_HASH_TABLE) is fine. Otherwise interception of
    // this context's HTTPS fails closed: the TLS handshake fails and Dart falls back to DIRECT.
    if (!'$e'.contains('ALREADY')) _note('could not trust the Flutter Intercept CA: $e');
  }
}

final Set<String> _noted = <String>{};
void _note(String message) {
  if (_noted.add(message)) print('[flutter_intercept] $message');
}

class _FlutterInterceptOverrides extends HttpOverrides {
  _FlutterInterceptOverrides(this._previous);
  final HttpOverrides? _previous;
  bool _creating = false;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    // Re-entered from a delegate that calls HttpClient() itself: give it a
    // plain client; the outer call configures and wraps it.
    if (_creating) return super.createHttpClient(context);
    _trustCa(context ?? SecurityContext.defaultContext);
    // Our zone value shadows any HttpOverrides.global the app installs later;
    // delegate to it so the app's own overrides still apply underneath ours.
    final global = Zone.root.run(() => HttpOverrides.current);
    final delegate = (global != null && !identical(global, this)) ? global : _previous;
    HttpClient client;
    if (delegate != null) {
      _creating = true;
      try {
        client = delegate.createHttpClient(context);
      } finally {
        _creating = false;
      }
    } else {
      client = super.createHttpClient(context);
    }
    if (client is _InterceptedHttpClient) return client;
    client.findProxy = _findProxy;
    return _InterceptedHttpClient(client);
  }
}

/// Forwards every member to the real client, except that app assignments to
/// `findProxy` made after creation (Charles-style snippets,
/// findProxyFromEnvironment) are ignored so traffic stays on the proxy.
/// `badCertificateCallback` is the app's own (forwarded): it is never consulted
/// for proxy certificates, which are trusted, and keeps its meaning on DIRECT.
/// Callback setters take `dynamic` so their exact function types can never
/// mismatch the SDK; members added by future SDKs reach `noSuchMethod`.
class _InterceptedHttpClient implements HttpClient {
  _InterceptedHttpClient(this._client);
  final HttpClient _client;

  @override
  set findProxy(dynamic f) {
    if (f != null) _note('ignored app findProxy (requests stay on the intercept proxy)');
  }

  @override
  set badCertificateCallback(dynamic callback) => _client.badCertificateCallback = callback;

  @override
  set connectionFactory(dynamic f) {
    if (f != null) _note('app set connectionFactory: its connections may bypass the intercept proxy');
    _client.connectionFactory = f;
  }

  @override
  Duration get idleTimeout => _client.idleTimeout;
  @override
  set idleTimeout(Duration value) => _client.idleTimeout = value;
  @override
  Duration? get connectionTimeout => _client.connectionTimeout;
  @override
  set connectionTimeout(Duration? value) => _client.connectionTimeout = value;
  @override
  int? get maxConnectionsPerHost => _client.maxConnectionsPerHost;
  @override
  set maxConnectionsPerHost(int? value) => _client.maxConnectionsPerHost = value;
  @override
  bool get autoUncompress => _client.autoUncompress;
  @override
  set autoUncompress(bool value) => _client.autoUncompress = value;
  @override
  String? get userAgent => _client.userAgent;
  @override
  set userAgent(String? value) => _client.userAgent = value;

  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) =>
      _traced(_client.open(method, host, port, path));
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) => _traced(_client.openUrl(method, url));
  @override
  Future<HttpClientRequest> get(String host, int port, String path) => _traced(_client.get(host, port, path));
  @override
  Future<HttpClientRequest> getUrl(Uri url) => _traced(_client.getUrl(url));
  @override
  Future<HttpClientRequest> post(String host, int port, String path) => _traced(_client.post(host, port, path));
  @override
  Future<HttpClientRequest> postUrl(Uri url) => _traced(_client.postUrl(url));
  @override
  Future<HttpClientRequest> put(String host, int port, String path) => _traced(_client.put(host, port, path));
  @override
  Future<HttpClientRequest> putUrl(Uri url) => _traced(_client.putUrl(url));
  @override
  Future<HttpClientRequest> delete(String host, int port, String path) =>
      _traced(_client.delete(host, port, path));
  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => _traced(_client.deleteUrl(url));
  @override
  Future<HttpClientRequest> patch(String host, int port, String path) =>
      _traced(_client.patch(host, port, path));
  @override
  Future<HttpClientRequest> patchUrl(Uri url) => _traced(_client.patchUrl(url));
  @override
  Future<HttpClientRequest> head(String host, int port, String path) => _traced(_client.head(host, port, path));
  @override
  Future<HttpClientRequest> headUrl(Uri url) => _traced(_client.headUrl(url));

  @override
  set authenticate(dynamic f) => _client.authenticate = f;
  @override
  void addCredentials(Uri url, String realm, HttpClientCredentials credentials) =>
      _client.addCredentials(url, realm, credentials);
  @override
  set authenticateProxy(dynamic f) => _client.authenticateProxy = f;
  @override
  void addProxyCredentials(String host, int port, String realm, HttpClientCredentials credentials) =>
      _client.addProxyCredentials(host, port, realm, credentials);
  @override
  set keyLog(dynamic callback) => _client.keyLog = callback;
  @override
  void close({bool force = false}) => _client.close(force: force);

  // Only reached for HttpClient members added by a future SDK (all members of
  // Dart 3.0-3.13 are forwarded above). Setters are dropped (the app keeps
  // working with the SDK default); getters/methods cannot be forwarded.
  @override
  dynamic noSuchMethod(Invocation invocation) {
    _note('HttpClient member ${invocation.memberName} is not supported by this Flutter Intercept version'
        '${invocation.isSetter ? ' (assignment ignored)' : ''}');
    if (invocation.isSetter) return null;
    return super.noSuchMethod(invocation);
  }
}

Future<void> main(List<String> args) async {
  _trustCa(SecurityContext.defaultContext);
  final overrides = _FlutterInterceptOverrides(HttpOverrides.current);
  HttpOverrides.global = overrides;
  // Zone value wins over a later `HttpOverrides.global = ...` inside the app.
  await HttpOverrides.runWithHttpOverrides(() {
    if (!_traceChains) return _runTarget(args);
    return runZoned(() => _runTarget(args),
        zoneSpecification: ZoneSpecification(
            registerCallback: _registerCallback,
            registerUnaryCallback: _registerUnaryCallback,
            registerBinaryCallback: _registerBinaryCallback));
  }, overrides);
}

Future<void> _runTarget(List<String> args) async {
  // Works for `void main()`, `Future<void> main() async` and `main(List<String>)`.
  final dynamic entry = target.main;
  final dynamic result = entry is Function(List<String>) ? entry(args) : entry();
  if (result is Future) await result;
}
```
