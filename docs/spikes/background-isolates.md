# Spike: background-isolate interception (0.7.0, CONTRACTS §13.3)

Date: 2026-10-10. Flutter 3.47.6 / Dart 3.13.5, DDS 5.4.0 (flutter_tools' DAP), VM service protocol 4.21.
Devices: Android emulator (API 36, arm64, debug), an iPhone 17 Pro simulator (iOS 26.2, debug), macOS desktop
(debug), plus a plain Dart CLI program through `dart debug_adapter`. Harness (scratch, not committed): a Node DAP
client that drives `flutter debug_adapter` / `dart debug_adapter` like Dart-Code (initialize → launch →
configurationDone), runs `scripts/e2e/mitm_proxy.dart --ca` as the proxy, generates the entry with
`scripts/e2e/gen_entry.sh` (`FI_TEMPLATE=v5`), and opens its own VM-service WebSocket to the URI of the
`dart.debuggerUris` event. The demo's coverage batch makes one GET each from `Isolate.run` (`demo_worker`),
`compute` (`demo_compute`) and `Isolate.spawn` (`demo_spawn`, new in 0.7.0); each reports
`HttpOverrides.current != null` as `overridesInIsolate`.

## Verdict: works, reliably, on every device tried

| | Android emulator | iOS simulator | macOS | plain Dart |
|---|---|---|---|---|
| New isolates start paused (PauseStart) in a debug session | ✅ | ✅ | ✅ | ✅ |
| Held by our DDS client until we approve | ✅ | ✅ | ✅ | ✅ |
| `invoke` of `flutterInterceptInstall` at PauseStart | ✅ | ✅ | ✅ | ✅ |
| `Isolate.run` / `compute` / `Isolate.spawn` requests through the proxy | ✅ all three | ✅ | ✅ | ✅ (`Isolate.run`) |
| … again after a hot restart | ✅ | ✅ | ✅ | n/a |
| Time held by us (getIsolate + invoke + readyToResume) | 21–92 ms | 14–22 ms | 14–27 ms | 2–4 ms |
| `Isolate.spawnUri` | ⚠️ another program: not installable (warning) | – | – | ✅ detected, resumed |

Every intercepted isolate request showed up at the proxy with its `x-fi-id` header
(`PROXY_REQ GET …/todos/2 … fi=c70cf61e1c206f9e-1`), and the app printed `"overridesInIsolate":true` for
`isolate_todo`, `compute_todo` and `spawn_todo`, on the first batch, after a hot restart and on every repeat
(`COVERAGE_REPEAT_SECONDS=25`). Without our client (`observe` mode) the same three printed `false`.

**No added latency.** The DAP itself releases a new isolate ~270–330 ms after its PauseStart on the emulator
(it configures breakpoints and exception modes first), and our hold finishes well before that. The isolate
requests took 440–480 ms intercepted vs 600 ms in the un-intercepted run (network noise). On the simulator and
macOS, the whole request took 200–410 ms.

## How it works

1. **Isolates pause at start.** The Flutter DAP launches debug sessions with `--start-paused`, so every isolate
   (spawned ones too: it is a VM flag) pauses at start. The DAP's `IsolateManager` handles PauseStart by configuring
   the isolate and calling DDS `readyToResume` (not `resume`).
2. **DDS resume permissions are per client.** DDS (`isolate_manager.dart`) resumes a paused-at-start isolate only
   when every client that called `requirePermissionToResume {onPauseStart: true}` has called `readyToResume` for
   it. The DAP is one such client. A second client (ours) is a second approval DDS waits for. `resume` would
   bypass all of that (it counts as user-initiated). The DAP's own `callService` connection can't be used: its
   approval is the DAP's.
3. **Our client** (`src/vm/isolates.ts`): a direct WebSocket to the `dart.debuggerUris` URI (loopback only, like
   the profile-mode transport), `streamListen Debug` (**mandatory**: if it fails, other than "already subscribed",
   the connection is closed before any permission is taken; REVIEW-7 #4), `setClientName "Flutter Intercept"`,
   `requirePermissionToResume {onPauseStart: true}`, then a **scan**: `getVM` + `getIsolate` per isolate, and every
   isolate already at PauseStart is handled as if its event had just arrived. The scan repeats every 2 s as a
   safety net for a missed event (an isolate seen running is not asked again: PauseStart only happens before it
   first runs).
4. **Per PauseStart:** `getIsolate` → if its `rootLib.uri` is a generated entry (`/.dart_tool/flutter_intercept/entry_*.dart`;
   `Isolate.run` / `compute` / `spawn` isolates share the isolate group and so the root library), `invoke`
   `{targetId: rootLib.id, selector: 'flutterInterceptInstall', argumentIds: [], disableBreakpoints: true}`, then
   `readyToResume`. `invoke` calls the function directly. `evaluate('flutterInterceptInstall()')` works too but
   compiles an expression through the frontend server first (18–124 ms on the emulator instead of 8–36 ms).
   The main isolate (launch, hot restart) is installed like the others: no name checks, so an `Isolate.spawn(…,
   debugName: 'main')` is intercepted too (REVIEW-7 #13). This is safe because the install is idempotent: the
   entry's `main` then finds `_installed` and wraps the app in the same overrides object as before.
5. **Template v5** adds to the entry (and nothing else, `test/unit/generator.test.ts` checks the diff against v4):

   ```dart
   _FlutterInterceptOverrides? _installed;

   _FlutterInterceptOverrides _install() {
     final existing = _installed;
     if (existing != null) return existing;
     _trustCa(SecurityContext.defaultContext);
     final overrides = _FlutterInterceptOverrides(HttpOverrides.current);
     HttpOverrides.global = overrides;
     return _installed = overrides;
   }

   @pragma('vm:entry-point')
   void flutterInterceptInstall() {
     _install();
   }
   ```

   `main` now starts with `final overrides = _install();` (same statements as v4, moved). In a background isolate
   the overrides are `HttpOverrides.global` only: there is no zone to wrap (we don't call the isolate's entry
   function), so an isolate that sets its own `HttpOverrides.global` replaces ours, and the Dio zone chain
   (template v4 traces) isn't there. Requests still get their `x-fi-id`; a short-lived `compute` / `Isolate.run`
   isolate usually exits before the 100 ms trace flush, so those requests may have no source.

## Never leaving an isolate paused

Measured failure modes, and what the code does:
- **Launch race (found in the first run).** With `requirePermissionToResume` but no scan, the main isolate, which
  was already paused at start when we connected, waited for an approval that never came: the app showed nothing,
  and the session ended after ~50 s. The scan after taking the permission fixes it. If the scan fails, the
  connection is closed.
- **Closing our client releases everything.** A test mode held `demo_spawn` without approving, then closed the
  WebSocket after 3 s: DDS resumed it at once (`maybeResumeAfterClientChange`), `spawn_todo` finished in 3316 ms
  (`overridesInIsolate: false`), and later isolates ran normally under the DAP alone.
- **Budget:** each isolate is approved at the latest **2 s** after its PauseStart, whatever the VM answers
  (reported as failed, so the warning shows). If `readyToResume` itself fails (anything but a Collected
  sentinel), the connection is closed. Errors in `getIsolate` / `invoke`, an `@Error` result (e.g. a v4 entry
  without the function: `NoSuchMethodError`), or a non-entry root library all end in `readyToResume`.
- **No DDS** (`requirePermissionToResume` unknown): one log line, the connection is closed, and the v0.5.0
  warnings stay.
- **No Debug stream** (`streamListen` fails): the permission is never taken, so nothing is held; the connection
  is closed (REVIEW-7 #4).
- **Missed PauseStart event**: the 2 s sweep finds the isolate and handles it with the usual budget. Three failing
  sweeps in a row close the connection.
- Detach, session end and dispose close the connection.

## Cases

- **`Isolate.spawnUri`**: another program, another isolate group. Its root library is the other program's, so it
  isn't installed (`not-entry`), it's resumed at once, and the warning stays. Checked in plain Dart (Flutter
  doesn't support `spawnUri`). Calling `invoke` there anyway answers
  `@Error … NoSuchMethodError: No top-level method 'flutterInterceptInstall' declared`.
- **Profile mode / Run Without Debugging**: isolates don't pause at start, so nothing is installed and the
  warning stays. In profile mode the client still connects and takes the permission, but DDS never asks it.
- **Isolates started before our client connected** (the client connects ~20 ms after `dart.debuggerUris`, while the
  main isolate is still paused at start, so in practice none): not installed, warning.
- **Plain Dart sessions**: same mechanism (DDS via `dart debug_adapter`). Note that DDS demands a "user" resume for
  isolates paused at start when the VM was started with `--pause-isolates-on-start` by someone other than the DAP;
  the DAP turns that off (`requireUserPermissionToResume {onPauseStart: false}`), and the real-VM unit test does
  the same.
- **Dedupe**: installed isolates count as "main" for the HTTP-profile import (their dart:io traffic went through
  the proxy; plain-http requests have no `proxyDetails` and would otherwise be imported twice), and get HTTP
  timeline logging only when they loaded `package:http_profile`.

## What was built

- `scripts/e2e/templates/entry_v5.dart.tmpl` = `ENTRY_TEMPLATE` (`src/entry/generator.ts`).
- `src/vm/isolates.ts` (vscode-free): `createIsolateInstaller(sessionId, deps)` → `start(transport)`,
  `status(isolateId, waitMs?)`, `stop()`, `active`, `stats`.
- `src/vm/transport.ts`: `connectWsTransport(…, {streams})`, event `pause-start` (Debug stream).
- `src/vm/watcher.ts`: starts the installer as soon as the session is attached and the VM-service URI is known,
  when `backgroundIsolates()` is `"intercept"` (read then; absent = `"intercept"`); the installer re-reads the
  setting for every isolate (`"warn"` → approve at once). `src/vm/core.ts` asks the installer about each new
  background isolate (waiting up to 500 ms, since the DAP's `serviceExtensionAdded` can arrive before our
  PauseStart): `installed` → no warning (the log has one line per isolate name).
- Tests: `test/unit/vm.isolates.test.ts` (fake DDS: order, budget, failures, races), `vm.isolates.real.test.ts`
  (real `dart run --pause-isolates-on-start` + DDS: `Isolate.run` and `Isolate.spawn` get the overrides,
  `spawnUri` doesn't, the program runs to completion), `vm.core.test.ts`, `vm.transport.test.ts`,
  `generator.test.ts`, and the device suite's check I.

## Requested contract changes

1. §13.3: "no-op without the define" → **always mirrors `main`**: the proxy address is the dart-define, else the
   entry's baked default (plain Dart sessions take no dart-defines). The function is only ever called by our VM
   client in an intercepted session.
2. §13.3 / §1: paste template v5 (`scripts/e2e/templates/entry_v5.dart.tmpl`) into CONTRACTS §1. The generator
   test checks §1 verbatim once it contains `flutterInterceptInstall`.
3. `VmHostDeps.backgroundIsolates` absent = `"intercept"` (the setting's default). The host should pass the
   setting: `backgroundIsolates: () => cfg.get('backgroundIsolates', 'intercept') === 'warn' ? 'warn' : 'intercept'`.
4. The 0.5.0 agent integration check (`suite/agent.ts`, "the background isolates are named") expects
   `background-isolate` warnings for `demo_worker` / `demo_compute`. With `"intercept"` there are none: that
   check should set `flutterIntercept.backgroundIsolates` to `"warn"` first, or expect no warning.
