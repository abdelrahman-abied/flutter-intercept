# Spike A — device: does the generated entry intercept on real Flutter targets?

Date 2026-10-08 · Flutter 3.47.6 / Dart 3.13 · Agent A

## Verdict: **works with changes**

`flutter run -t .dart_tool/flutter_intercept/entry_<name>.dart` is accepted on both the
Android emulator and the iOS simulator. With no change to the app's code, all dart:io
traffic (Dio, package:http, HTTPS and plain http://, gzip) went through the proxy and was
edited, mocked and blocked. Hot reload, hot restart, a flavor target and `--profile` all
work.

Three things have to change before this can ship:

1. **The CONTRACTS §1 template does not compile** for the most common app shape, `void main()`.
   `await target.main();` gives `Error: This expression has type 'void' and can't be used.`
   (Xcode `kernel_snapshot_program failed`). Fix: call `main` dynamically at runtime. This
   also means the generator no longer has to work out the signature of `main`.
2. **On Android the entry can be stale.** Flutter's build system drops every path that
   contains `.dart_tool` from the depfile it gives to Gradle
   (`flutter_tools/lib/src/build_system/build_system.dart` ~l.694: *"We also remove files
   under .dart_tool"*). If the entry is rewritten but the target and defines stay the same,
   Gradle treats the build as up to date and the **first launch runs the OLD entry**.
   Measured: wrote `ENTRY_VERSION B` and the app printed `ENTRY_VERSION A`. Fix: pass
   `--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=<sha1(entry)[:12]>`. Keeping `.dart_tool/`
   is fine. iOS is not affected because Xcode's Flutter script phase runs every build.
3. **An app's own `HttpOverrides.global` was silently dropped.** Our zone value shadows the
   global the app sets later, so the app's overrides never ran (UA tag lost). Interception
   still worked. Fix: delegate at client-creation time to the live global
   (`Zone.root.run(() => HttpOverrides.current)`).

## Results

Device logs are `DEMO_RESULT <label> <status> ms=<n> <body>` lines from the app.
`_intercepted:true` and `name:"EDITED BY TOOL"` are inserted by the proxy.
Proxy lines are `PROXY_*`.

| Check | Android emulator (API 36.1, arm64, `adb reverse`) | iOS simulator (iPhone 17 Pro, iOS 26.2) |
|---|---|---|
| (g) `-t .dart_tool/...` accepted | ✅ `Launching .dart_tool/flutter_intercept/entry_main.dart on sdk gphone64 arm64 in debug mode...`, no target-related warning | ✅ same, no warning |
| (g) template as written | ❌ compile error with `void main()` (same CFE error, both platforms) | ❌ `entry_main.dart:26:18: Error: This expression has type 'void' and can't be used.` |
| (a) Dio GET edited | ✅ `dio_user 200 {"_intercepted":true,"id":1,"name":"EDITED BY TOOL",...` | ✅ same |
| (a) package:http GET edited | ✅ `http_todo 200 {"_intercepted":true,"userId":1,...` | ✅ |
| (a) Dio POST edited | ✅ `dio_post 201 {"_intercepted":true,"title":"hello",...,"id":101}` | ✅ |
| (a) plain `http://` | ✅ `http_plain 200 {"_intercepted":true,"args":{"plain":"1"}...` | ✅ |
| mock / block (proxy rules) | ✅ `dio_user2 200 {"mocked":true,...}` · `http_comment 403 {"blocked":true}` | ✅ |
| (b) gzip | ✅ upstream gzip decoded by the proxy, edited, re-gzipped (`PROXY_EDIT 200 GET https://httpbin.org/gzip gzip=true bytes=204`). App decoded it: `http_gzip 200 {"_intercepted":true,"gzipped":true,...}` | ✅ |
| plugin (shared_preferences) through the outside-`lib/` entry | ✅ `prefs 200 {"launches":N}` | ✅ |
| (g) hot reload | ✅ `Reloaded 1 of 990 libraries in 329ms`. A tap after the reload was still intercepted (gesture callbacks run in our zone) | ✅ `Reloaded 1 of 990 libraries in 206ms` |
| (c) hot restart (`R` via fifo) | ✅ `Restarted application in 2,205ms`, then the full batch was intercepted again | ✅ `Restarted application in 396ms`, all intercepted |
| (d) proxy stopped, adb reverse **removed** | ✅ all 200/201 DIRECT. Batch timings match direct (dio_user 165–225 ms, gzip ~790 ms) → fallback cost not measurable (connection refused is immediate) | n/a |
| (d) proxy stopped, adb reverse **still set** | ⚠️ HTTPS falls back to DIRECT (dio_user 200 in 470 ms), but **plain http fails**: `http_plain ERR ms=80 ClientException: Connection closed before full header was received` | n/a |
| (d) proxy stopped (iOS) | n/a | ✅ all DIRECT (dio_user 200 in 655 ms, real `"name":"Leanne Graham"`), no errors, no noticeable delay |
| (d) proxy back up | ✅ the next batch was intercepted at once, including Dio's reused `HttpClient` (Dart keeps proxied and direct connections in separate pools) | — |
| (e) flavor `lib/main_dev.dart` | ✅ `DEMO_START flavor=dev` + all intercepted (debug, and profile below) | ✅ `DEMO_START flavor=dev` + all intercepted (also via run_device.sh) |
| (f) app sets `HttpOverrides.global` — template as written | ⚠️ intercepted, but the app's override was ignored: `ua="Dart/3.13 (dart:io)"` | ⚠️ same |
| (f) app sets `HttpOverrides.global` — corrected template | ✅ intercepted **and** the app's override applies: `PROXY_REQ ... ua="demo-app-own-overrides"` | ✅ `http_gzip 200 {"_intercepted":true,...,"ua":"demo-app-own-overrides"}` |
| (f') app wraps runApp in its own `runWithHttpOverrides` zone | ❌ not intercepted (the inner zone wins, and there is no hook for it). Known limit | ❌ same |
| Entry rewritten between sessions | ❌ stale entry on the first launch (`wrote=B ran=A`, Gradle 1.2 s). ✅ with the SHA dart-define (`wrote=H ran=H`), and still no rebuild when nothing changed (Gradle 917 ms) | ✅ never stale (`wrote=D ran=D`) |
| (h) `flutter run --profile` | ✅ `assembleProfile`, flavor main_dev, all intercepted (AOT, so the dynamic `main` dispatch survives tree-shaking) | not run (sim has no profile mode) |
| Emulator alias `PROXY 10.0.2.2:<port>` with no adb reverse | ✅ all intercepted. With the proxy down **plain http also falls back** (`http_plain 200` direct) | n/a |

All of the above can be re-run with `scripts/e2e/run_device.sh` (24 assertions per debug run, 10 for `--profile`):

```
run_device.sh 5A3F2C1E-…                                               → ALL PASSED (iOS, main, debug)
run_device.sh 5A3F2C1E-… --target lib/main_dev.dart --dart-define APP_SETS_OVERRIDES=true → ALL PASSED
run_device.sh emulator-5554                                            → ALL PASSED (Android, main, debug)
run_device.sh emulator-5554 --target lib/main_dev.dart --profile --emulator-host → ALL PASSED
```

## Template correction (exact diff against CONTRACTS §1)

```diff
@@ class _FlutterInterceptOverrides extends HttpOverrides {
   _FlutterInterceptOverrides(this._previous);
   final HttpOverrides? _previous;
+  bool _creating = false;
 
   @override
   HttpClient createHttpClient(SecurityContext? context) {
-    final client = _previous?.createHttpClient(context) ?? super.createHttpClient(context);
+    // Our zone value shadows any HttpOverrides.global the app installs later;
+    // delegate to it so the app's own overrides still apply underneath ours.
+    final global = Zone.root.run(() => HttpOverrides.current);
+    final delegate = (global != null && !identical(global, this)) ? global : _previous;
+    final HttpClient client;
+    if (delegate != null && !_creating) {
+      _creating = true; // guards delegates that call HttpClient() themselves
+      try {
+        client = delegate.createHttpClient(context);
+      } finally {
+        _creating = false;
+      }
+    } else {
+      client = super.createHttpClient(context);
+    }
     return client
       ..findProxy = ((_) => _proxy)
       ..badCertificateCallback = ((_, __, ___) => true);
@@ Future<void> main(List<String> args) async {
   HttpOverrides.global = overrides;
   // Zone value wins over a later `HttpOverrides.global = ...` inside the app.
   await HttpOverrides.runWithHttpOverrides(() async {
-    {{CALL_MAIN}} // `await target.main();` or `await target.main(args);`
+    // Works for `void main()`, `Future<void> main() async` and `main(List<String>)`.
+    final dynamic entry = target.main;
+    final dynamic result = entry is Function(List<String>) ? entry(args) : entry();
+    if (result is Future) await result;
   }, overrides);
 }
```

- `{{CALL_MAIN}}` goes away. The generator only fills `TARGET_IMPORT`, `PROXY_HOST` and `PROXY_PORT`.
- The recursion guard was checked in the Dart VM: a global whose `createHttpClient` calls
  `HttpClient()` again gives `recursive`, with no stack overflow. A plain global gives
  `plain`. With no global you get the default client.
- `(_, __, ___)` is kept on purpose (only an `unnecessary_underscores` info lint). The
  entry inherits the app's language version, so it must not use `_` wildcards (Dart ≥3.7)
  or records.
- The reference generator is `scripts/e2e/gen_entry.sh` (bash, for the e2e only; Agent B
  owns the real one). It uses `package:<name>/…` for targets under `lib/`. For other
  targets it uses a relative `../../<target>`, which has not been tried on a device.

## Requested contract changes

1. **§1 template** — replace it with the corrected version above (`CALL_MAIN` placeholder removed).
2. **§1 launch args** — the provider must add
   `--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=<first 12 hex of sha1(entry file bytes)>` to
   `toolArgs` every session. Without it, Android Gradle builds (debug, profile and release)
   can bundle a stale entry when only the entry's contents changed: a new port, a new
   template version, or a new host. The path can stay in `.dart_tool/`. The fallback
   `.flutter_intercept/` also fixed the stale build (measured `wrote=F ran=F`), but it needs
   a gitignore line, so I'd rather use the define.
3. **§2 hosts** — for an **Android emulator** (serial `emulator-*`), use
   `PROXY_HOST=10.0.2.2` with no `adb reverse` (measured working). Physical Android keeps
   `localhost` + `adb reverse`. Reason: if `adb reverse` outlives the proxy (VS Code
   crash, session ended without cleanup), every **plain-http** request fails with
   `Connection closed before full header was received`. HTTPS still falls back.
   `10.0.2.2` gets a real "connection refused" and falls back cleanly.
4. **§2 lifecycle** — after `adb reverse` (physical devices), the extension must run
   `adb -s <id> reverse --remove tcp:<port>` when the proxy stops or the last session
   ends, for the reason in 3.
5. **Known limits (PLAN)** — add: an app that installs its **own zone** with
   `HttpOverrides.runWithHttpOverrides`/`runZoned` around its code is not intercepted.
   Also add: code that sets `findProxy` on the client itself after creation (for example
   in Dio's `IOHttpClientAdapter.createHttpClient`) overrides ours.

## Open issues / notes for integration

- Fallback timing: when nothing is listening, `; DIRECT` adds no measurable time on either
  platform (connection refused on loopback). Not measured: a proxy that accepts but never
  answers (for example a hung extension host). Dart would then wait for the connect
  timeout, and Dio's default has none.
- Each new `HttpClient` picks up interception at creation time. Clients created before
  `main`, or in another isolate (`compute`, background isolates), are not covered. That is
  already a known limit.
- The demo `samples/demo_app/.gitignore` ignores `.dart_tool/`, so the hand-written
  entries are not committed. Regenerate them with
  `scripts/e2e/gen_entry.sh samples/demo_app lib/main.dart localhost 8899`.
- Running two `flutter run`s on the same project at once (iOS and Android) worked during
  this spike, with separate `.dart_tool/flutter_build/<hash>` dirs per target and defines.
- Not covered: physical iOS (LAN IP / `0.0.0.0` bind), physical Android, targets outside
  `lib/`, and macOS/desktop.

## Files

- `samples/demo_app/` — app with no tool code (`lib/demo.dart`, `lib/main.dart`, `lib/main_dev.dart`)
- `samples/demo_app/.dart_tool/flutter_intercept/entry_main.dart`, `entry_main_dev.dart` — corrected entries (gitignored)
- `scripts/e2e/mitm_proxy.dart` — test MITM proxy: port arg, edit/mock/block, gzip-aware, `PROXY_*` log lines
- `scripts/e2e/gen_entry.sh` — writes an entry from the corrected template
- `scripts/e2e/run_device.sh` — non-interactive device check, exits non-zero on failure
