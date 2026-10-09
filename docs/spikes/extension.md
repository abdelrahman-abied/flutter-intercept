# Spike B — extension: taking over F5

Agent B, 2026-10-08. VS Code 1.141.0 (test-electron, stable), Dart-Code 3.144.0 (copied from
`~/.vscode/extensions` into `packages/extension/.vscode-test/extensions`), Dart 3.13.5,
Flutter 3.47.6, macOS arm64.

## Verdict

**GO, with one condition built in.** The final launched configuration reliably uses our
generated entry, but **not** because of provider ordering. Ordering is *not* reliable: Dart-Code
re-registers its provider during its in-process "silent restart" and our hook then runs
**before** Dart-Code's. The provider is therefore written to be order-independent (it detects
which side of Dart-Code it is on and pins `debuggerType` when it is first). Measured in real VS
Code with the real Dart-Code, in both orders:

| Suite | Order | Runs | Final `program` is our entry | Proxy got the request | App output intact | Debugger |
|---|---|---|---|---|---|---|
| Dart CLI (5 scenarios × 5) | natural (we run after Dart-Code) | 25 | 25/25 | 25/25 | 25/25 | Dart (0) |
| Dart CLI (5 scenarios × 5) | reloaded (we run before Dart-Code) | 25 | 25/25 | 25/25 | 25/25 | Dart (0) |
| Dart CLI | interception off | 1 | untouched, as expected | 0 hits, as expected | yes | Dart (0) |
| Flutter app on the macOS device | natural | 1 + 2 + 2 | 5/5 | 5/5 | 5/5 | **Flutter (2)** |
| Flutter app on the macOS device | reloaded | 1 + 2 + 2 | 5/5 | 5/5 | 5/5 | **Flutter (2)** |
| Flutter, control (entry launched directly, no pinning) | — | 3 | — | — | — | **Dart (0)**: the hazard is real |

There were 0 failures across all runs: 51 + 31 + 21 + 31 Dart sessions and 3 + 5 + 5 Flutter sessions. The last
full run (31 Dart + 5 Flutter) uses the **updated CONTRACTS §1 template** (dynamic `target.main`)
and also asserts that the final Flutter config's `toolArgs` carry exactly one
`--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=<sha1 of the launched entry file>`, and that
`flutterInterceptProxyHost` is `localhost` (macOS device). The fallback command from PLAN.md is
implemented too (`flutterIntercept.debugWithIntercept`) and covered by the `eager-command-path`
scenario, but F5 does not need it.

## Evidence

`npm run test:integration` (`FI_RUNS=5` run, Dart suite; excerpt, Dart-Code's DTD noise removed):

```
[suite] Dart-Code 3.144.0 active=true; ours active=true
[suite] ok   FI natural program-bin-main #1 (725 ms) dartCodeRanFirst=true mode=after program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=0 proxyHits=1
[suite] ok   FI natural no-program-default #1 (684 ms) dartCodeRanFirst=true mode=after program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=0 proxyHits=1
[suite] ok   FI natural program-noargs-async #1 (589 ms) dartCodeRanFirst=true mode=after program=.dart_tool/flutter_intercept/entry_noargs.dart debuggerType=0 proxyHits=1
[suite] ok   FI natural program-lib-void-async #1 (606 ms) dartCodeRanFirst=true mode=after program=.dart_tool/flutter_intercept/entry_app_main.dart debuggerType=0 proxyHits=1
[suite] ok   FI natural eager-command-path #1 (684 ms) dartCodeRanFirst=true mode=already program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=0 proxyHits=1
...
[suite] ok   FI disabled program-bin-main #1 (544 ms) dartCodeRanFirst=true mode=flutterIntercept.enabled is false program=bin/main.dart debuggerType=0 proxyHits=0
[suite] executing _dart.reloadExtension (Dart-Code in-process restart)
[suite] ok   FI reloaded program-bin-main #1 (654 ms) dartCodeRanFirst=false mode=before program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=0 proxyHits=1
[suite] ok   FI reloaded no-program-default #1 (696 ms) dartCodeRanFirst=false mode=before program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=0 proxyHits=1
...
[suite] ok   FI reloaded eager-command-path #5 (590 ms) dartCodeRanFirst=false mode=already program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=0 proxyHits=1
[suite] 51/51 runs passed
```

Flutter suite (real `flutter run` of a Flutter app on the `macos` device):

```
[suite] ok   FI-F natural #1 (24761 ms) dartCodeRanFirst=true mode=after program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=2 proxyHits=1
[suite] ok   FI-F control-unpinned (78 ms) dartCodeRanFirst=undefined mode=control program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=0 proxyHits=0
[suite] executing _dart.reloadExtension (Dart-Code in-process restart)
[suite] ok   FI-F reloaded #1 (14908 ms) dartCodeRanFirst=false mode=before program=.dart_tool/flutter_intercept/entry_main.dart debuggerType=2 proxyHits=1
[suite] flutter: 3/3 runs passed
```

Session output of a Flutter run (DAP `output` events):

```
Launching .dart_tool/flutter_intercept/entry_main.dart on macOS in debug mode...
flutter: FIXTURE_RESPONSE[flutter] status=200 via=yes body=hello-from-origin /hello?run=FI-F%20natural%20%231
flutter: FIXTURE_DONE[flutter]
```

`via=yes` is a header only the test proxy adds, so the response reached the app *through* the
proxy. Each run uses a unique URL, and the proxy saw exactly that URL once.

What each run asserts (`test/integration/suite/dart.ts`, `flutter.ts`):
(a) `session.configuration.program` from `onDidStartDebugSession` (the config the debug adapter
received) is `<fixture>/.dart_tool/flutter_intercept/entry_<name>.dart`, and
`flutterInterceptOriginalProgram` is the real target; (b) the test's Node proxy (a random
port fed in through `flutterIntercept.port`) logged the run's unique URL exactly once; (c) the
program's own stdout line is present and unaltered, plus its `FIXTURE_DONE` line. For Flutter
it also asserts `debuggerType === 2`.

Dart scenarios: `program: bin/main.dart` (`void main(List<String>)`, sync, request finishes after
main returns); **no program** (Dart-Code infers `bin/main.dart`); `${workspaceFolder}/bin/noargs.dart`
(`Future<void> main() async`, env var); `lib/app_main.dart` (`void main() async`, imported as
`package:dart_cli/app_main.dart`, must not be awaited); the eager "Debug with Intercept" path.

## Why ordering is not safe (VS Code + Dart-Code source)

### VS Code chains providers in registration order, in two separate passes

From the shipped workbench bundle
(`.vscode-test/vscode-darwin-arm64-1.141.0/.../out/vs/workbench/workbench.desktop.main.js`):

```js
registerDebugConfigurationProvider(o){return this.configProviders.push(o), ...}
async resolveConfigurationByProviders(o,e,t,i){let n=async(c,l)=>{c!=="*"&&await this.adapterManager.activateDebuggers("onDebugResolve",c);
  for(let u of this.configProviders)u.type===c&&u.resolveDebugConfiguration&&l&&(l=await u.resolveDebugConfiguration(o,l,i));return l}, ...}
async resolveDebugConfigurationWithSubstitutedVariables(o,e,t,i){let n=this.configProviders.filter(a=>a.type===e&&...)
  .concat(this.configProviders.filter(a=>a.type==="*"&&...)), r=t; return await s1t(n.map(a=>async()=>{r&&(r=await a.resolveDebugConfigurationWithSubstitutedVariables(o,r,i))})),r}
// debugService: g = await resolveConfigurationByProviders(...); l = await this.substituteVariables(c,g);
//               l = await resolveDebugConfigurationWithSubstitutedVariables(...)
```

So the order is: every `resolveDebugConfiguration` (registration order) → variable substitution
→ every `resolveDebugConfigurationWithSubstitutedVariables` (registration order, `*` last). Each
provider receives the previous one's output. Registration order = activation order. A
disposed and re-registered provider moves to the **end** of the array.

### Dart-Code does everything in its *substituted* hook

`~/.vscode/extensions/dart-code.dart-code-3.144.0/out/dist/extension.js`:

- `resolveDebugConfiguration` (16074–16079) only sets `dartCodeDebugSessionID`, `type` and `request`.
- `resolveDebugConfigurationWithSubstitutedVariables` (16098–16278) does the real work:
  - 16122: strips `?query` from `program` (test selection), keeps it in `programQuery`.
  - 16127 → `configureProgramAndCwd` (16426–16520): makes `cwd`/`program` absolute; if `program` is
    missing, `guessBestEntryPoint` (16493) uses the **open editor** when it is a valid entry file
    (`bin/`, `tool/`, `test_driver/`, `lib/main.dart`, tests), else `lib/main.dart`, `bin/main.dart`,
    `bin/<folder>.dart`; sets `projectRootPath` (16500) and picks `cwd` = the best project root.
  - 16137 → `selectDebuggerType` (16350–16424): **honours an explicit `debuggerType`**
    (16351, numbers or case-insensitive names). Otherwise, 16369:
    `if (firstPathSegment === "bin" || firstPathSegment === "tool" || firstPathSegment === ".dart_tool")`
    → **Dart**. Otherwise Flutter if the pubspec references flutter. **A program under
    `.dart_tool/` is classified as a plain Dart VM program**, so an unpinned rewritten Flutter config would
    be launched with `dart` instead of `flutter run`. The Flutter control run measures exactly
    this (`debuggerType=0`).
  - 16195 `prepareLaunchDevice` / device picker. 16239 → `setupDebugConfig`: 16582 sets
    `deviceId`/`deviceName` (Flutter only), 16591 `toolEnv`, `toolArgs` (`-d <deviceId>` at 16694;
    the program is **not** in `toolArgs`: the DAP passes `program` as `-t`, which is why swapping
    `program` after Dart-Code still takes effect), `dartSdkPath`, `flutterSdkPath`, `omitTargetFlag`.
  - 16265 sets the numeric `debuggerType`; 16273 stashes a copy in `LastDebugSession` (for
    "Rerun last debug session") **before** later providers run.
- 15498 `createDebugAdapterDescriptor` chooses the Dart or the Flutter DAP from
  `session.configuration.debuggerType` alone.

### The order flips at runtime: Dart-Code's silent restart

`activate` registers `_dart.reloadExtension` (12240–12247): `deactivate(true)`, dispose all
subscriptions (this includes the debug provider), then `activate(context, true)` again, which
re-registers the provider (12520). This happens **without a window reload**. VS Code then appends it after ours.
Triggers, all in the same file:
- **"Dart: Restart Analysis Server"** (`dart.restartAnalysisServer`, 6906–6918): no prompt, direct.
- Workspace-folder changes that add or remove the first Flutter project (12679), changes to the
  restart-requiring settings (12821; `getSettingsThatRequireRestart`, e.g. `dart.sdkPath`,
  `dart.flutterSdkPath`, `closingLabels`, `showMainCodeLens`): `promptToReloadExtension` without
  a prompt reloads immediately (20783–20806).
- Flutter upgrade, SDK version file change, analyzer/daemon crashes, Flutter project added (13464).

The test triggers it with `_dart.reloadExtension` and measures the flip: `dartCodeRanFirst`
goes from `true` (every natural run) to `false` (every reloaded run).

`extensionDependencies: ["Dart-Code.dart-code"]` makes the *initial* order deterministic: we
activate after Dart-Code's `activate()` resolved, so we register after it. It does not cover
the restart.

### How the provider handles both orders (`src/debug/rewrite.ts`)

Everything is done in our `resolveDebugConfigurationWithSubstitutedVariables`. Our
`resolveDebugConfiguration` returns the config untouched, for two reasons: variables like
`${workspaceFolder}` are not substituted yet, and a missing program is filled in later by
Dart-Code.

- **after** (Dart-Code ran first: numeric `debuggerType` + `toolEnv` + absolute `program`): swap
  `program` only. The `deviceId`, `cwd` and `debuggerType` values Dart-Code computed stay unchanged.
- **before** (Dart-Code not yet run): resolve `program`/`cwd` the way Dart-Code does (relative to
  `cwd`/folder; default from the open entry file, `lib/main.dart`, `bin/main.dart`,
  `bin/<folder>.dart`), then swap `program`, set `cwd` if it is missing, and **pin `debuggerType`** to
  the type Dart-Code would have chosen for the *original* program (`bin`/`tool` → Dart; Flutter
  pubspec → Flutter; `web/` → skip). Dart-Code then honours the pin (16351).
- **already** (program is our entry, for example the eager command, a provider called twice, or Dart-Code's
  "rerun last session" stash): regenerate the entry from `flutterInterceptOriginalProgram`
  (the port may have changed) and do not wrap it again.
- **restore**: when interception does not apply but the config points at our entry (rerun after
  turning interception off), put the original program back.

Fields added to the launch config: `flutterInterceptOriginalProgram`, `flutterInterceptPort`,
`flutterInterceptProxyHost`; plus the `FLUTTER_INTERCEPT_ENTRY_SHA` define in `toolArgs` (Flutter).

No-ops: setting off; `request: attach`; web devices (`chrome`, `edge`, `web*`, the same rule as Dart-Code's
`isWebDevice`); test entry points (`test/`, `integration_test/`, `test_driver/`, `*_test.dart`,
test folders); `program?query`; `--name`/`--pname` filters; `debuggerType` set to a test or web type; Dart
web programs (`web/` without Flutter); `omitTargetFlag` (Bazel-style launches never pass `program`);
programs that do not exist (Dart-Code reports them). Any exception → launch unmodified.

## Entry generator (`src/entry/generator.ts`), aligned with the updated CONTRACTS §1/§2

- **Template**: CONTRACTS §1 verbatim (`ENTRY_TEMPLATE`). A unit test reads `docs/CONTRACTS.md` and
  fails if the two drift. Only `TARGET_IMPORT`, `PROXY_HOST` and `PROXY_PORT` are filled. The earlier
  main-signature parser was **removed**: the template now calls `target.main` dynamically. My
  measurement agreed with Agent A's: `await target.main()` on `void main()` does not compile
  (`use_of_void_result`). The template has no `_` wildcards or records; it is compiled by unit tests
  under a `sdk: ^3.0.0` package (language 3.0).
- **Project root**: nearest `pubspec.yaml` above the program; otherwise the `cwd`/workspace folder (the
  import is then relative). Package name from top-level `name:`. Flutter detection uses the same rule
  as Dart-Code (`flutter`, `flutter_test` or `sky_engine` in `dependencies` or `dev_dependencies`).
- **`TARGET_IMPORT`**: `package:<name>/<path-under-lib>` (URI-encoded per segment) for programs under
  `lib/`, so the same library is never loaded twice under two URIs. Otherwise a relative URI from
  `.dart_tool/flutter_intercept/` (`../../bin/main.dart`), or `file:///` across Windows drives.
- **File**: `<root>/.dart_tool/flutter_intercept/entry_<basename>.dart` (non-identifier chars → `_`),
  written only when the content changed.
- **`FLUTTER_INTERCEPT_ENTRY_SHA`**: `sha1(entry bytes)[:12]`. For **Flutter** sessions the provider puts
  `--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=<sha>` in `toolArgs` on every session, replacing any existing
  define in either the `--dart-define=K=V` or the `--dart-define K=V` form, so it is never duplicated. Both
  orders work: after Dart-Code we append to the `toolArgs` it built; before Dart-Code, its `buildToolArgs`
  starts from `debugConfig.toolArgs`. **Not added for plain Dart programs**, because the Dart VM rejects it
  (`dart --dart-define=A=1 x.dart` → `Setting VM flags failed: Unrecognized flags: dart_define`, measured).
  "restore" strips it.
- **Unit tests** compile and **run** generated entries with the real Dart SDK for 8 main shapes: `void`,
  `void async`, `Future<void>(args)`, untyped `main(args)`, re-exported via `export`, optional `[args]`,
  an app that reassigns `HttpOverrides.global`, and `bin/` with a relative import.

## Proxy host per device (CONTRACTS §2)

The host depends on the device, so it is chosen from the best device id available when the
entry is generated:

| Situation | Device id used | `PROXY_HOST` | adb |
|---|---|---|---|
| after Dart-Code (Flutter) | `config.deviceId` (Dart-Code set it, 16582) | `emulator-*` → `10.0.2.2`, else `localhost` | reverse only when `localhost` |
| before Dart-Code, `deviceId` in launch.json | that id | same rule | same |
| before Dart-Code, no `deviceId` | Dart-Code's **selected device** via the command `flutter.getSelectedDeviceId` (extension.js 12387). This is what `prepareLaunchDevice` uses by default (16288). | same rule | same |
| before Dart-Code, no device selected (Dart-Code will show its picker) | unknown | `localhost` | reverse on **every** connected Android device (emulators too, since the entry says localhost), then again at session start on the chosen `deviceId` |
| plain Dart program (host VM) | n/a | `localhost` | none |

- `flutterInterceptProxyHost` is stored in the launch config. At `onDidStartDebugSession`: if the entry
  says `localhost`, reverse the final device. If it says `10.0.2.2` but the session is not on an
  emulator (the user picked a different device in the picker), log a warning. The traffic then falls back to `DIRECT`,
  so the app still works but is not intercepted.
- iOS physical device (LAN IP, proxy on `0.0.0.0`) is **not implemented**. `RewriteContext.proxyHost`
  is the override hook, and the device-kind detection is Phase 2.

## Android: adb (`src/adb.ts`)

- adb lookup: `$ANDROID_HOME/platform-tools`, `$ANDROID_SDK_ROOT/platform-tools`, the OS default SDK
  (`~/Library/Android/sdk`, `~/Android/Sdk`, `%LOCALAPPDATA%\Android\Sdk`), then `PATH`.
- `adb devices`, then `adb -s <serial> reverse tcp:<port> tcp:<port>` only for serials adb lists in
  state `device`. Ids it does not list (iOS, `macos`, `chrome`) are ignored.
- `ReverseTracker` records every reverse we created. When the **last intercepted session ends**
  (`onDidTerminateDebugSession`) and on `deactivate`, it runs `adb -s <id> reverse --remove tcp:<port>`
  for exactly those reverses, never anyone else's. Phase 2: call `removeAll()` from `ProxyHost.stop()` as well.
- Never throws. The launch waits at most 3 s (`withSoftTimeout`). A missing adb returns at once.
- A reverse made at resolve time for a launch that then fails to start stays until the next intercepted
  session ends or the extension deactivates.

## Implemented

- `package.json` contributes: `flutterIntercept.enabled`, `flutterIntercept.port`; commands
  `openPanel` (stub message), `toggle`, `clear` (stub), `debugWithIntercept` (fallback);
  activation `onDebugResolve:dart`, `workspaceContains:pubspec.yaml`, `workspaceContains:*/pubspec.yaml`;
  `extensionDependencies: ["Dart-Code.dart-code"]`; `publisher: "TBD"`.
- Status bar `$(radio-tower) Intercept: on|off`, which toggles the setting (in whichever scope defines it).
- `ProxyHost` seam (`src/proxyHost.ts`): `start(): Promise<port>`, `stop()`, `running`; stub
  `ConfiguredPortProxyHost` returns the configured port. The provider calls `start()` before
  generating, so the real proxy's actual port (8899–8999 fallback) ends up in the entry.
- `activate()` returns `FlutterInterceptApi { events, prepare(folder, config), proxyHost }`.
- Output channel "Flutter Intercept" logs each decision (mode, device, proxy host, entry, import, SHA, adb).

## How to run

- `npm run build` → `dist/extension.js` (esbuild, cjs, `vscode` external).
- `npm test` → vitest unit tests (54, about 5 s, including real `dart analyze`/`dart run` of generated entries).
- `npm run test:integration` → downloads VS Code stable into `.vscode-test/`, copies Dart-Code into
  `.vscode-test/extensions/`, uses a throwaway `--user-data-dir` in `$TMPDIR`, runs the Dart suite
  and (macOS) the Flutter suite on the `macos` desktop device. Env: `FI_SUITE=dart|flutter|dart,flutter`,
  `FI_RUNS` (Dart repeats, default 3), `FI_FLUTTER_RUNS` (default 1), `FI_VSCODE_VERSION`.
  The runner strips `ELECTRON_RUN_AS_NODE` and `VSCODE_*` from the environment: when it is launched from a
  VS Code terminal, these turn the test VS Code into plain Node or could attach it to the user's
  running instance. The user's real VS Code profile is never touched.

## Open issues

1. **Basename collisions**: `lib/main.dart` and `bin/main.dart` (or `lib/a/main.dart`) both map
   to `entry_main.dart`. Two *concurrent* sessions of different targets with the same basename
   in one project would overwrite each other's entry. Proposed fix: `entry_<basename>.dart` for
   `lib/` targets and `entry_<dir>_<basename>.dart` otherwise (needs a contract change).
2. **Before-mode default program**: in the reversed order, when `program` is missing we mirror
   `guessBestEntryPoint`, including the open-editor rule. The `example/` fallback and
   `dart.projectSearchDepth`-style multi-project heuristics are not mirrored. If we find no program, we skip
   and the session runs **un-intercepted** (Dart-Code still launches it or reports the error).
3. **Before mode pins `debuggerType`**. With an explicit type, Dart-Code's `selectDebuggerType` returns
   `projectRoot: undefined`, which is only used as a hint for the device picker. It does not change behaviour, but it is a difference.
4. **"Rerun last debug session"** in the reversed order replays a stash that already points at our
   entry: this is handled by the "already" and "restore" modes (unit-tested, not integration-tested).
5. **Flutter on Android/iOS through F5** is not covered here (Agent A's gate). Measured here: Flutter
   on the **macOS desktop** device builds and runs `-t .dart_tool/flutter_intercept/entry_main.dart`,
   and `PROXY localhost:<port>` reaches a proxy bound to `127.0.0.1` (Dart falls back from `::1`).
   A fresh macOS app needs `com.apple.security.network.client` in its entitlements to make *any*
   outgoing connection (the test fixture adds it). Real apps that do HTTP already have it.
6. Dart-Code logs "DTD connection is unavailable" stack traces in the test profile. This is noise and not
   related to us.
7. Stubbed until Phase 2: the real `InterceptProxy` behind `ProxyHost`, the webview for `openPanel`,
   `clear`, the status `sessions` count, and starting/stopping the proxy with sessions.
8. @vscode/test-electron 2.5.2 expects `Contents/MacOS/Electron`, but VS Code 1.141 ships
   `Contents/MacOS/Code`. The runner falls back to it.
9. **The Android paths are unit-tested only**: the `10.0.2.2`/emulator rule, reverse on physical devices, and
   `--remove` when the last session ends. The integration suites deliberately ran on the `macos` device
   so that they never touched the emulator Agent A was using (`emulator-5554`). Two stray reverses from my
   first test runs (random ports, from before the Dart-VM no-adb rule) were removed by hand. Agent A's
   `tcp:8899` was intact when I last touched the emulator. Its later absence was not caused by this code:
   it only removes reverses that `ReverseTracker` recorded.
10. `extensionDependencies` on `Dart-Code.dart-code` means Marketplace installs pull in Dart-Code.
   That suits a Flutter tool, but it is the lead's call.

## Requested contract changes

(The earlier CALL_MAIN request is moot: the lead's updated §1 already removed `{{CALL_MAIN}}`.)

1. **§1 SHA define, Flutter only**: "every session" cannot include plain Dart (VM) programs. The VM
   aborts on `--dart-define` (measured). Proposed wording: "...to `toolArgs` of Flutter sessions".
2. **§1**: document the launch-config fields the extension adds: `flutterInterceptOriginalProgram`,
   `flutterInterceptPort` and `flutterInterceptProxyHost`. Also document that before Dart-Code the extension pins `debuggerType`
   (`"Flutter"`/`"Dart"`), because Dart-Code classifies any program under `.dart_tool/` as plain Dart
   (extension.js 16369; measured by the control run).
3. **§1 file name**: see open issue 1. Disambiguate targets that are not under `lib/`.
4. **§2, unknown device at resolve time**: documented above (selected device via
   `flutter.getSelectedDeviceId`, else `localhost` plus reverse on all Android devices and repair at session
   start). Please confirm or adopt.
5. **New §6, extension ↔ proxy seam** for Phase 2:
   `interface ProxyHost { start(): Promise<number>; stop(): Promise<void>; readonly running: boolean }`.
   `start()` is idempotent and resolves with the actual port (after the 8899–8999 fallback). `stop()` should
   also trigger `ReverseTracker.removeAll()`.
6. **§5**: add the command `flutterIntercept.debugWithIntercept` ("Debug with Intercept"; it rewrites
   eagerly and works in any provider order).

---

# Phase 2: integration (real proxy, webview, packaging)

## What's wired

| Piece | Where | Notes |
|---|---|---|
| `ProxyHost` (§6) around `InterceptProxy` | `src/proxyHost.ts` (`InterceptProxyHost`) | Starts **lazily** on the first intercepted resolve; the provider awaits `start()` so the port is known before the entry is generated. Concurrent `start()` calls share one promise. It tries the configured port, then the next free one (up to +100, so 8899–8999 by default). Binds `127.0.0.1`. Rules are held by the host, so they apply from the first request and survive restarts. `stop()` stops the proxy and **removes our adb reverses**. It runs on `deactivate`. Events: `exchange`, `removed`, `state`. |
| Lazy proxy module | `src/extension.ts` factory | `require('@flutter-intercept/proxy')` runs inside the factory. mockttp's module init (≈150 ms) happens on the first intercepted launch, not at activation. Loading the 4.3 MB bundle takes ≈47 ms. |
| Message routing (§4) | `src/ui/controller.ts` (`InterceptController`, no `vscode` import, unit-tested) | <ul><li>`ready` → `snapshot` (every time).</li><li>`setRules` → persists to `workspaceState['flutterIntercept.rules']` and broadcasts `rules`.</li><li>`createRuleFromExchange` → `ruleFromExchange` from `@flutter-intercept/proxy/rules`; the new rule is inserted **first**, then `rules` is sent.</li><li>`clear` → `cleared` plus a fresh `snapshot` (in-flight exchanges are kept).</li><li>`setInterceptEnabled` → updates the setting (in whichever scope defines it) and sends `status`.</li><li>`resume`/`abort` → forwarded to the proxy; an invalid edit is answered with `error`. Unknown exchange → `error`.</li><li>`removed` is forwarded. `status` is sent on proxy start/stop, session count changes and setting changes.</li><li>`exchange` updates are **coalesced per id and flushed every 50 ms**. Pending updates are flushed before a `snapshot` or `removed` so ordering holds.</li></ul> |
| Webview | `src/ui/view.ts` (`TrafficViewProvider`) | A `WebviewView` (`flutterIntercept.traffic`) in a **bottom-panel** container (`viewsContainers.panel` → `flutterIntercept`, icon `media/traffic.svg`). It uses D's HTML template and CSP verbatim, with a 32-char nonce per render, `localResourceRoots = dist/webview`, the `fi-panel` body class and `retainContextWhenHidden`. `flutterIntercept.openPanel` focuses it. The first intercepted session reveals it with `preserveFocus`: it uses `view.show(true)` if the view is resolved, otherwise `<viewId>.focus` with `{ preserveFocus: true }` (VS Code's `registerFocusViewAction` accepts that argument). |
| Status bar | `src/extension.ts` | `$(radio-tower) Intercept: on/off` toggles the setting. A second item, `$(debug-pause) N` with a warning background, is shown only while N > 0 and focuses the panel. |
| Entry naming (§1) | `entryNameFor` | `lib/**/x.dart` → `entry_x.dart`; otherwise the project-relative path with `/`→`__` (`bin/main.dart` → `entry_bin__main.dart`); outside the project → basename. |
| Unknown device (§4b) | provider + `adbReverse({physicalOnly})` | Physical Android devices only; an emulator chosen later is repaired at session start. |
| Packaging | `build.mjs`, `.vscodeignore` | esbuild bundles proxy + mockttp, minified with `keepNames`. Externals: `vscode`, `tls-impersonate`, `brotli-wasm`, `zstd-codec`, `bufferutil`, `utf-8-validate`; all are optional or lazy and loaded in try/catch or only on Node builds without zlib brotli/zstd. The build copies `packages/webview/dist/*` → `dist/webview/` and fails with a clear message if proxy or webview isn't built. |

### The mockttp patches survive the bundle (measured, minified bundle)
- `listen-host`: the listening socket is `{"address":"127.0.0.1","family":"IPv4"}`.
- `upstream-pool`: `pool.active === true`. **5 CONNECT tunnels → 1 upstream TLS connection** to a local
  HTTPS origin (a scratch smoke test bundled with the same esbuild options as the extension).

## vsce / .vsix

`npm run package` runs `vsce package --no-dependencies --allow-missing-repository --skip-license -o flutter-intercept.vsix`.
- vsce's complaints without the flags: `A 'repository' field is missing` and `LICENSE ... not found`. Each is
  an interactive y/N prompt, which is why the script passes the flags. It also prints "`dist/extension.js` is large (4.29 MB)".
  `publisher: "TBD"` is accepted for packaging; publishing would need a real publisher. There is no README yet
  (vsce did not block on it).
- **Size: 1.33 MB (1,397,238 bytes), 7 files**: `package.json`, `media/traffic.svg`, `dist/extension.js` (4.29 MB
  unpacked), `dist/webview/webview.js` (68 KB), `dist/webview/webview.css` (21 KB). No source maps, no node_modules.
- **The .vsix works**: `FI_VSIX=flutter-intercept.vsix node dist-test/runTest.js` unzips the package and runs
  both integration suites against it as the extension (instead of the source tree). See the results below.
- The largest bundle contributors are listed below. All of them are dead weight for us (mockttp's admin server, GraphQL and PAC
  support) and are candidates for trimming later:

  | Package | Size |
  |---|---|
  | `@tootallnate/quickjs-emscripten` (PAC) | 651 KB |
  | body-parser | 492 KB |
  | raw-body | 486 KB |
  | graphql | 272 KB |
  | mockttp | 221 KB |
  | express | 170 KB |

## Integration tests with the REAL proxy (`npm run test:integration`)

Dart suite (`test/integration/suite/dart.ts`). The proxy port is a random free port set through
`flutterIntercept.port`, never 8899. Before the first session the suite asserts that the proxy is **not** running
and the view is **not** resolved (lazy start).

```
[suite] ok   FI natural program-bin-main #1 (928 ms) dartCodeRanFirst=true mode=after program=.dart_tool/flutter_intercept/entry_bin__main.dart debuggerType=0 exchanges=completed
[suite] ok   FI webview live session (909 ms) ... exchanges=completed
[suite] ok   FI webview reveal+ready+snapshot (1110 ms) mode=resolves=1 ready=1 sent={"snapshot":1,"status":3,"exchange":2}
...
[suite] ok   FI action mock (740 ms) ... exchanges=mocked
[suite] ok   FI action breakpoint+edit (779 ms) ... exchanges=completed
[suite] ok   FI action block (753 ms) ... exchanges=blocked
[suite] ok   FI action create-rule (before) (757 ms) ... exchanges=completed
[suite] ok   FI action create-rule (rule) (0 ms)
[suite] ok   FI action create-rule (after) (742 ms) ... exchanges=blocked
[suite] ok   FI disabled program-bin-main (750 ms) mode=flutterIntercept.enabled is false program=bin/main.dart exchanges=
[suite] executing _dart.reloadExtension (Dart-Code in-process restart)
[suite] ok   FI reloaded program-bin-main #1 (764 ms) dartCodeRanFirst=false mode=before ... exchanges=completed
...
[suite] dart: 29/29 runs passed
```

What each action run asserts, based on the fixture's own stdout (a plain `dart:io` client):
- **Mock** (rule set through the same path as the webview's `setRules`): the app prints
  `status=200 ... body=MOCKED-BODY`, the exchange is `mocked`, and the origin was **not** contacted (origin hit counter).
- **Response breakpoint**: the test waits for `paused-response` and checks the paused body is the real origin body and that
  `controller.pausedCount === 1` (which drives the status bar). It then sends `{type:'resume', edit:{status:299, body:'EDITED-BODY'}}` through
  `controller.handle`, the webview message path. The app prints `status=299 ... body=EDITED-BODY`, and the paused count returns to 0.
- **Block**: the app prints `status=403 ... body=Blocked by Flutter Intercept`, and the exchange is `blocked`.
- **createRuleFromExchange(block)** on a recorded exchange: the rule is inserted first as `<origin>/cr/item*`, with no `error`
  reply. The same URL then gets 403.
- **Webview**:
  - The first intercepted session **revealed** the panel (`resolveCount=1`).
  - The real `webview.js` ran under the CSP and posted `ready` (`readyCount=1`), and the host sent a `snapshot`.
  - A later session pushed `exchange` messages to the view.
  - The hook is the controller's `readyCount` and `sentCounts`, exposed through the activate() API (`api.controller`, `api.view`).
- The F5 takeover scenarios from Phase 1 still pass in both provider orders, now asserting that the real proxy recorded the
  request (`exchanges=completed`) and that the response passed through unchanged (`via=none body=hello-from-origin ...`).

Results by run:

| Run | Dart | Flutter (macOS) |
|---|---|---|
| Source tree | 29/29 | — |
| **Packaged `.vsix`**, first run | 19/19 | 2/3 (see below) |
| **Packaged `.vsix`** after the lazy-require change | 29/29 | 5/5 |

Every Flutter run asserts the following:
- program = `entry_main.dart`
- `debuggerType` 2
- one `FLUTTER_INTERCEPT_ENTRY_SHA` define equal to the launched entry's sha1
- proxy host `localhost`
- the real proxy recorded the request
- the app printed the origin's body

The suite ran on the macOS desktop device only. The emulator and simulator were not used; the only adb command run was a read-only `adb devices`.

**The one Flutter failure (packaged run 1, `FI-F reloaded #1`) is unexplained and did not reproduce.**
- What happened: the proxy answered that run's request as `mocked`, with the *previous* run's response body.
- What that rule must have been: it matches exactly `ruleFromExchange(<natural #1 exchange>, 'mock')`, which is the webview's **"Mock this"** button. Nothing in the test or extension calls `createRuleFromExchange('mock')`. The panel had just been auto-revealed in a visible test VS Code window on a shared machine, so a stray click on the selected exchange is the likely cause. That is unconfirmed.
- Diagnostics added: the Flutter suite now asserts that the rule list is empty before and after each run and prints the rules and message counters if it isn't.
- The rerun from the same `.vsix` passed 5/5.

Test API exported from `activate()`: `events`, `prepare`, `proxyHost`, `controller`, `view`,
`getExchanges()`, `setRules()` (same path as the webview's `setRules`), `getRules()`.

Unit tests: **67 passing**. New ones:
- `controller.test.ts` (10): snapshot per ready, 50 ms coalescing, paused count, setRules persistence, rule-first insert,
  error replies, clear → cleared + snapshot, status after toggle, removed, garbage input.
- `proxyHost.test.ts` (2), with the **real** InterceptProxy: lazy and idempotent start, busy port → next port, a rule set before
  start applies (mock), record, and stop → onStop (adb cleanup); plus a clean failure when the range is exhausted.
- Naming and `physicalOnly` cases in the generator and adb tests.

## Phase 2 open issues

1. **Port change while running**: changing `flutterIntercept.port` while the proxy runs has no effect until the window reloads
   (the proxy is never restarted under a live session). It could restart when there are no sessions.
2. **The proxy keeps running after the last session**, so the traffic list stays browsable. It stops only on deactivate.
   Exchanges are lost on reload, while rules persist.
3. **Bundle weight**: the 4.3 MB bundle is mostly mockttp's unused admin/GraphQL/PAC stack. Aliasing `pac-proxy-agent`, graphql and
   express to stubs could probably halve it. That would need care because mockttp imports them at module load.
4. **Webview checked by protocol only**: the integration test proves resolve → `ready` → `snapshot` → `exchange` in a real VS Code. The visuals,
   theme variables and focus behaviour still need a look by a human, and CSP violations aren't captured (the page
   would not post `ready` if the script were blocked, so script CSP is covered; style CSP is not).
5. **mockttp writes `console.error`** on upstream failures. In the extension host it lands in the extension-host log, not our
   output channel.
6. **Reveal on first session** uses `<viewId>.focus` with `{preserveFocus:true}` when the view was never resolved. On VS Code builds
   older than the arg-taking focus action this would take focus. It was verified on 1.141.
7. **No marketplace readiness**: there is no README, LICENSE or repository yet, and the publisher is `TBD`.

## Requested contract changes (Phase 2)

1. **§6**: document that `start()` tries the configured port and then up to +100 (i.e. 8899–8999 for the default), and that
   rules live on the host (`setRules` before `start` applies).
2. **§4**: document that the host coalesces `exchange` messages (≤ one per id per 50 ms) and flushes them before `snapshot` and `removed`.

---

# Phase 3: device E2E through the packaged extension

## Verdict

**The shipped product works end to end on real Flutter mobile targets with zero configuration.**

- Every run used the packaged `flutter-intercept.vsix` (unzipped and loaded as the extension), the real Dart-Code 3.144 and VS Code 1.141.
- The workspace was `samples/demo_app`, which uses plain Dio + package:http and has no tool code.
- Each launch was exactly what F5 does: a Dart-Code launch config containing only `deviceId`, with no program.
- **All checks passed on the Android emulator (run 5 times) and on the iOS simulator (run 2 times).**
- One release-check failure in the first device run was caused by the sample app, not the extension (see "Bugs found").

## How to run

```bash
cd packages/extension
npm run build && npm run package && node build.mjs --tests
FI_VSIX=flutter-intercept.vsix FI_SUITE=devices \
  FI_DEVICES=emulator-5554,5A3F2C1E-7B4D-4E8A-9C6B-1D2E3F4A5B6C node dist-test/runTest.js
```

- The `devices` suite is opt-in: `FI_DEVICES` is required.
- It opens `samples/demo_app` in place, so the Gradle and Xcode caches stay warm.
- The proxy port is random (never 8899).
- Each check's app output lines (DEMO_*, `[flutter_intercept]`, Launching, Restarted) are kept in `.vscode-test/results-devices.json`.

## Results (device × check)

| Check | Android emulator `emulator-5554` (API 36) | iOS simulator iPhone 17 Pro `5A3F2C1E…` (iOS 26.2) |
|---|---|---|
| **A** F5 with `deviceId` only → `program` = `.dart_tool/flutter_intercept/entry_main.dart`, original `lib/main.dart`, `debuggerType` 2, exactly one `FLUTTER_INTERCEPT_ENTRY_SHA` define | ✅ ×5 | ✅ ×2 |
| **A** proxy host | ✅ `10.0.2.2`, **no adb reverse** for our port (`adb reverse --list` empty) | ✅ `localhost` |
| **A** whole batch recorded and printed unchanged: Dio GET, http GET, Dio POST (201), HTTPS, plain `http://`, gzip (recorded with `content-encoding: gzip` and a decoded body containing `"gzipped": true`), plugin call | ✅ 7/7 exchanges ×5 | ✅ 7/7 ×2 |
| **B** mock `users/2` → app prints `dio_user2 200 {"mocked":true}` | ✅ ×5 | ✅ ×2 |
| **B** block `comments/1` → `http_comment 403 … Blocked by Flutter Intercept` | ✅ ×5 | ✅ ×2 |
| **B** response breakpoint `todos/1` (paused count = 1), resumed with an edited body through the webview message path → `http_todo 200 {"edited":true}` | ✅ ×5 | ✅ ×2 |
| **B** hot restart (Dart-Code's `hotRestart` custom request) keeps interception: the whole post-restart batch is recorded | ✅ ×5 (`Restarted application in 547ms`) | ✅ ×2 (`Restarted application in 267ms`) |
| **C** stop the session → no adb reverse left for our port | ✅ ×5 | ✅ (n/a: no adb) |
| **D** `APP_FINDPROXY=charles` (app sets `findProxy = 'PROXY 127.0.0.1:8888'`) → still intercepted, and the output shows `[flutter_intercept] ignored app findProxy (requests stay on the intercept proxy)` | ✅ ×5 | ✅ ×2 |
| **E** `flutterIntercept.enabled=false` → next F5 launches `lib/main.dart` directly, the app works (all 2xx), nothing recorded | ✅ ×5 | ✅ ×2 |
| **F** `flutterMode: "profile"` → intercepted (7/7 recorded) | ✅ ×4 | n/a (simulator has no profile mode) |
| **G** `flutterMode: "release"` → **not** intercepted: program `lib/main.dart`, no SHA define, nothing recorded, and the app ran (`Launching lib/main.dart … in release mode`) | ✅ ×2 (1 earlier failure, explained below) | n/a (simulator has no release mode) |

Regression after these changes (from the same `.vsix`): Dart suite 29/29 and Flutter (macOS) 3/3. Unit tests 74/74.
`test:bundle` OK.

Evidence (`results-devices.json`, emulator run 2, after the hot restart with the mock, block and breakpoint rules active):

```
Restarted application in 547ms.
I/flutter (18453): DEMO_RESULT http_comment 403 ms=352 Blocked by Flutter Intercept
I/flutter (18453): DEMO_RESULT dio_user2 200 ms=375 {"mocked":true}
I/flutter (18453): DEMO_RESULT http_todo 200 ms=641 {"edited":true}
I/flutter (18453): DEMO_RESULT dio_post 201 ms=704 {"title":"hello","body":"from demo","userId":1,"id":101}
I/flutter (18453): DEMO_RESULT http_gzip 200 ms=911 {"gzipped":true,"method":"GET",...}
```

iOS simulator, charles mode:

```
Launching .dart_tool/flutter_intercept/entry_main.dart on iPhone 17 Pro in debug mode...
flutter: [flutter_intercept] ignored app findProxy (requests stay on the intercept proxy)
flutter: DEMO_RESULT dio_user 200 ms=605 {"id":1,"name":"Leanne Graham",...}
```

## Bugs found and fixed (packages/extension)

1. **Release builds were intercepted** (reported by the lead).
   - Why it matters: template v2 relaxes certificate checks, so a release build must never be rewritten silently.
   - Fix: `isReleaseLaunch` skips the launch for any of `flutterMode: "release"` (any case), `--release` in `toolArgs`, or `--release` in Dart-Code's `dart.flutterAdditionalArgs` / `dart.flutterRunAdditionalArgs` settings. The settings matter in the "before Dart-Code" order, before Dart-Code has merged them into `toolArgs`.
   - If a release relaunch still carries our entry (for example a re-run of the last session), the original program is restored.
   - Covered by unit tests and by device check G. Profile stays intercepted (check F).
2. **`flutterIntercept.port` changes were ignored until reload** (my Phase 2 open issue).
   - Fix: when the configured port differs from the one the running proxy was started for and no intercepted session is live, the next launch restarts the proxy on the new port.
   - The webview then gets a fresh `snapshot`: the controller re-sends the snapshot on every proxy start or stop.
   - Unit-tested.
3. **Stray rules**: each run uses a fresh `--user-data-dir`, so workspace-state rules cannot leak between runs. Every suite now asserts this at start. The Flutter suite also asserts an empty rule list around each launch, and the device suite clears rules before each launch.
   - The Phase 2 mock rule therefore came from inside that run. It matched `ruleFromExchange(..., 'mock')` exactly, which is what the webview's "Mock this" button produces. It has not happened again in any run since (all suites, all devices).

**Not ours: `samples/demo_app` release builds have no network on Android.** The app declares `android.permission.INTERNET` only in `src/debug` and `src/profile` (Flutter's template default), not in `src/main`. The first G run failed for that reason (`Failed host lookup`), even though the extension behaved correctly: program untouched, nothing recorded.
- Check G now accepts exactly that failure.
- Agent A / lead: add `<uses-permission android:name="android.permission.INTERNET"/>` to `samples/demo_app/android/app/src/main/AndroidManifest.xml` if release builds of the demo should reach the network.

## Also in this phase

- `version` is 0.1.0, to match CHANGELOG.md.
- `.vscodeignore` excludes `media/screenshots/**`.
  - vsix size: **293 KB, 9 files** (before: 1.77 MB / 13 files with screenshots; 1.33 MB in Phase 2 before C's bundle shrink).
- `npm run package` adds `--no-rewrite-relative-links`. vsce otherwise fails because the README has relative images and package.json has no `repository`; the user still needs to decide between a repository field and `--baseImagesUrl`.
- New harness helpers: `startSession`, `stopSession` and `outputOf` (long-lived sessions); `FI_DEVICES` is passed through `runTest`.

## Phase 3 open issues

1. **Physical devices are untested**:
   - Android physical (the `localhost` + `adb reverse` + `--remove` path) is covered by unit tests only.
   - iOS physical needs a LAN IP and a `0.0.0.0` listener, which is not implemented.
2. **Breakpoint timing vs. app timeouts**: the device check resumes within about 1 s. A real user pausing longer than Dio's `receiveTimeout` (20 s in the demo) makes the app time out first; that is shown in the UI per Agent C/D.
3. **Release skip is silent**: the provider only logs the reason to the output channel. A one-time notification ("release builds are not intercepted") could help users who wonder why traffic is missing.
4. **External services**: the device suite depends on the internet (jsonplaceholder.typicode.com, httpbin.org). An outage shows up as `ERR` lines, not as extension failures.

---

# Review-1 fixes (#6, #7, #8 host side), Agent B

- **#6 adb races and user-managed reverses** (`src/adb.ts`).
  - Before reversing a port on a serial, `adb -s <id> reverse --list` is checked. If that port is already reversed and `ReverseTracker` didn't create it, it is left alone: not overwritten, never removed. This is logged as "user-managed" in the output channel. If it is already reversed by us (a second session), it is kept and not re-run. If `--list` fails (old adb), the reverse goes ahead.
  - `ReverseTracker` tracks in-flight reverses. `removeAll()` waits for them first, so a reverse that completes after the session ended is still removed.
- **#7 webview message validation** (`src/ui/controller.ts`: `validateRule`, `validateRules`, `validateEdit`).
  - Every host-bound message is schema-checked. Invalid input gets an `error` reply, and nothing is applied, persisted or forwarded.
  - Rule checks: `id` is a non-empty string; `enabled` is a boolean; `match` is **required** with a non-empty `url` (`"*"` is the explicit match-all) and an optional `method` token; unknown fields are rejected.
  - Action checks (a discriminated union): mock `status` is an integer 100–599, `body` is a string, `headers` are `Record<string,string>` with token names and no CR/LF/NUL, `delayMs` is an integer 0–600000; block `mode` is `reset`/`status` with an optional status; breakpoint `phase` is `request`/`response`/`both`. Duplicate ids and more than 1000 rules are rejected.
  - Edit checks: `headers` are `Record<string, string|string[]>`, `body` is a string, `status` is an integer 100–599, `url` is absolute http(s), `method` is a token. Checks are phase-aware: a paused request can't take `status`, a paused response can't take `url`/`method`.
  - `setInterceptEnabled` needs a boolean. `applyRules` (also used by the test API) always validates.
- **#8 host side**: any throw from `ruleFromExchange` (the proxy's typed error with code `truncated`/`binary`, or anything else) is caught. The webview gets an `error` reply such as "Can't create a mock rule from this exchange: its response body is binary, and mock bodies are text." The generated rule is validated before it is added.
- Unit tests: `adb.test.ts` 14 and `controller.test.ts` 56. `npm test` in packages/extension: 125/125.
- **Still open, needs a change in A's file `src/extension.ts`**: persisted rules from `workspaceState` are loaded without validation (`proxyHost.setRules(context.workspaceState.get(RULES_KEY) ?? [])`). They should go through `validateRules` (exported from `ui/controller.ts`), with the error logged and `[]` used on failure.

---

# LAN mode for physical iOS (CONTRACTS §7), extension side

## Physical-iOS detection (`src/iosDevices.ts`)

The device is the config's `deviceId`. In the "before Dart-Code" order it is instead Dart-Code's selected device (`flutter.getSelectedDeviceId`).

1. **UDID shape** (instant), which is the Flutter device id for iOS:

   | Shape | Kind | Example |
   |---|---|---|
   | 8 hex `-` 16 hex | physical, A12+ | `00008110-000A1B2C3D4E5F60` |
   | 40 hex | physical, older | |
   | RFC 4122 UUID 8-4-4-4-12 | simulator | `5A3F2C1E-C957-…` |

   Android serials, `macos`, `chrome`, `web-server`, `linux` and `windows` match neither physical shape.
2. **Cross-check** with `xcrun simctl list devices --json` (local, ~0.1–0.3 s): an id that simctl lists is always a simulator.
   - The list is cached and refreshed at most every 30 s, with a 3 s timeout.
   - Without Xcode the shape decides.
   - The whole classification is bounded at 4 s on the launch path.
3. `flutter devices --machine` (`emulator:false`, `targetPlatform:ios`) is deliberately **not** used on the launch path because it takes seconds (wireless discovery).

## LAN address (`src/lanAddress.ts`)

- macOS: `route -n get default` → `interface:` → `os.networkInterfaces()` IPv4 (non-internal, not 169.254). Linux: `ip -4 route show default`.
- A VPN tunnel (`utun`/`ipsec`/`ppp`/`tun`/`wg`) holding the default route is skipped for the first `en`/`eth`/`wl` interface with a private IPv4.
- **No address**: the session is not intercepted (`skip`, `noLan`; an already-rewritten config is restored), and the user sees the warning "…has no Wi-Fi/Ethernet IPv4 address … runs without interception".

## Launch (`src/debug/lanPrepare.ts`, `provider.ts`, `rewrite.ts`)

- Physical iOS → `proxyHost.openLan(lanIp)` is awaited before the config is returned.
- The proxy define is `FLUTTER_INTERCEPT_PROXY=flutter-intercept:<token>@<lanIp>:<port>`. There is always exactly one: re-resolve replaces it.
- Config fields:
  - `flutterInterceptProxyHost` = LAN IP;
  - `flutterInterceptPort` = LAN port;
  - `flutterInterceptLan: true`.

  **The token lives only in that toolArgs define.** It is never in other config fields, never in the entry file, never in our log or the UI. Unit tests assert all of this.
- Residual exposure: the define is in `flutter run`'s process arguments on the Mac, and in Dart-Code's own debug log when our hook runs before Dart-Code.
- Physical iOS devices never get `adb reverse`.

## Listener lifecycle (`proxyHost.ts`, `lanLifecycle.ts`)

- **Token**: 32 random bytes, base64url.
  - Concurrent launches share one opening. A same-address re-resolve reuses it.
  - **The token stays stable while any iPhone session launched with it is alive.** It survives a close/reopen in that time: the lead's measurement shows a stale token makes plain-http requests return 407 instead of falling back DIRECT, and hot restart doesn't change dart-defines.
  - It rotates only when no iPhone session is live. If it ever had to rotate while one is live, the user is told to relaunch.
- **Address change**: the listener moves to a new LAN address only when no iPhone session is live.
- **Closing**:
  - `closeLan` runs when the last iPhone session ends. `onDidTerminateDebugSession` also covers crashed and killed apps.
  - A 15-minute grace timer covers a launch that never became a session (failed build, cancelled picker).
  - `proxyHost.stop()` (proxy restart, deactivate) closes it too.
  - If the timer closed it during an extremely long build, it is reopened at session start with the same token.
- **Session started on an iPhone without LAN** (device chosen after resolution): the user gets a warning to relaunch.

## UI

- Status bar: `Intercept: on · LAN`, with the tooltip "LAN open for iPhone on <ip>:<port> …".
- The webview `Status` gets an optional `lan: {host, port}`. The webview has to render it (Agent D); requested contract change §4.
- **One-time notice** (`globalState`, "Don't show again"): macOS may ask whether VS Code may accept incoming connections, and iOS asks the app for Local Network access. Both must be allowed. The notice is never awaited and never blocks a launch.

## Tests

- **Unit**: `test/unit/lan.test.ts` (33) plus a controller status test; `npm test` 172/172. They cover:
  - detection shapes, simctl cross-check, caching and fallback;
  - route/ip parsing, the no-LAN and VPN cases;
  - the token format;
  - open once / concurrent share / reuse / close / reopen with a new token, and the stable token while a session is live;
  - address change only when idle, stop closing the listener, the log never holding the token;
  - lifecycle: last session, grace timer, timer cancelled by start;
  - define composition and single-define replacement, the token only in toolArgs, no-LAN skip/restore, simulator unchanged.
- **Integration**: the Dart suite passed 19/19 after the change.
- **Device scenario**: opt-in in `test/integration/suite/devices.ts`:
  `FI_DEVICES=<udid> FI_ALLOW_PHYSICAL_IOS=1 FI_SUITE=devices FI_VSIX=… node dist-test/runTest.js`.
  It asserts the LAN host, the define shape, that the token never leaks, the listener being open with Status showing it, the listener closing after stop, plus checks B, D, E, F and G. Not run yet (devices belong to A; scheduled by the lead).

## Requested contract change

- **§4 Status**: add `lan?: { host: string; port: number }` (the token is never included).

## Apple Silicon + USB iPhone + no Rosetta warning (`src/iosUsbTooling.ts`)

Flutter 3.47's `bin/cache/artifacts/libusbmuxd/iproxy` (and the libimobiledevice tools) are x86_64-only. Without Rosetta, a USB iPhone launch installs, then hangs about 60 s later (Agent A, measured). For a physical-iOS launch on darwin/arm64, the extension now checks three things *before* the launch continues:

| Check | How | Cost |
|---|---|---|
| Rosetta | `arch -x86_64 /usr/bin/true`. Exit 0 means Rosetta; "Bad CPU type in executable" means none (measured on this Mac). If `arch` can't run, the presence of `/Library/Apple/usr/libexec/oah/libRosettaRuntime` decides. A positive answer is cached permanently; a negative one is re-checked after 60 s. | ~5 ms |
| iproxy architecture | Reads the Mach-O header of `<flutterSdk>/bin/cache/artifacts/libusbmuxd/iproxy`: thin `0xfeedfacf` + cputype (`0x01000007` x86_64, `0x0100000c` arm64), or fat `0xcafebabe`/`0xcafebabf` with its arch table. No `file` dependency. SDK: Dart-Code's `flutterSdkPath`, else `dart.flutterSdkPath`, else `FLUTTER_ROOT`, else `which flutter` through symlinks. | cached per SDK |
| Transport | `xcrun devicectl list devices --json-output <tmp>`, `connectionProperties.transportType`: `wired` → USB, `localNetwork` → Wi-Fi. Cached 10 s. | ~0.1 s |

- **When it warns**: Rosetta is absent, iproxy has no arm64 slice, and the transport is USB or unknown. The warning (wording conditional when the transport is unknown) offers "Copy install command" (`sudo softwareupdate --install-rosetta --agree-to-license`; we never run sudo), "Open Xcode" (then Window → Devices and Simulators → Connect via network) and "Don't show again".
- **Never blocking**: the diagnosis is bounded at 3 s and the message is not awaited.
- **Wi-Fi-paired iPhones** get no warning (no iproxy involved), and nothing in the physical-iOS/LAN path assumes USB.
- **Real-machine check**: Rosetta absent, iproxy `x86_64`, the iPhone on `network` → no warning (correct), 100 ms.
- **Tests**: `test/unit/iosUsbTooling.test.ts` (16): fixture headers (thin x86_64, thin arm64, fat universal, fat64, Java-class false positive, plus the real Flutter iproxy when present); devicectl parsing; warn and no-warn matrices; non-arm64 and non-macOS; the `arch` fallback; caching; SDK resolution; the launch path bounded at 3 s, throwing hooks tolerated, simulators and Android excluded.

## Review 2 fixes, extension side (#5, #2, #4)

- **#5 RFC 1918 only** (`lanAddressForIphone`).
  - The LAN listener opens only on a private IPv4 (`10/8`, `172.16/12`, `192.168/16`).
  - A public or CGNAT (`100.64/10`) default-route address is refused with a clear warning; the session runs without interception.
  - The VPN-default-route fallback also requires RFC 1918.
- **#5 follow the network** (`src/lanWatch.ts`). While the listener is open, a 5 s poll checks three things: the interface's IPv4 from `os.networkInterfaces()` (no process); the default gateway on that interface (`route -n get default`); and the gateway's MAC (`arp -n <gw>`).
  - Triggers: the address disappears, the address changes, or the router changes (the same DHCP IP on another network shows up as a different gateway MAC).
  - Effect: the listener is closed with `closeLan({ forgetToken: true })`, so the next opening gets a new token even if the old app is still running (it would be pinned to a now-wrong peer anyway). The user sees "your Mac's network changed — relaunch the iPhone session".
  - Signals that can't be read for a moment are not treated as a change.
  - The automatic reopen at session start was removed. It now warns to relaunch instead, so a listener never reappears on a network it wasn't opened for.
- **#2 pinned peer**.
  - When C's `lanPeer` is set, `proxyHost.lan` becomes `{host, port, peer}`, the log says `LAN locked to <peer>` (refreshed on each 5 s tick), and the status tooltip says "locked to <peer>".
  - The webview `Status.lan` gains `peer?: string`.
  - The one-time LAN notice now adds: use a trusted Wi-Fi; on shared or public Wi-Fi others may observe the session token.
- **#4** README (iPhone + Security) and CHANGELOG: the shared/public Wi-Fi caveat; the token reaching disk (`ios/Flutter/Generated.xcconfig`, `flutter_export_environment.sh`, the debug app), and that it is only usable while that session's listener is open and only from the device it locked to; RFC 1918 only; closing on network change.
- **Tests**: `test/unit/lanSecurity.test.ts` (24). `npm test`: 212/212. They cover:
  - an RFC 1918 matrix including 172.32/CGNAT/public, the VPN fallback with CGNAT or public Wi-Fi refused, and `prepareLan` never opening on a refusal;
  - route/arp parsing, fingerprint scoping, and the change matrix (gone, address changed, router MAC or IP changed, unreadable signal ≠ change);
  - the watcher firing once and stopping, an immediate mismatch, and a late-learned baseline;
  - `forgetToken` giving a new token without a spurious "rotated" warning;
  - the peer in `lan`/Status with a single "LAN locked to" log, and the token never appearing in Status or logs.
