# Spike: Flutter run integration in Android Studio / IntelliJ (0.9.0, CONTRACTS §15.1)

Date: 2026-10-11. Android Studio 2026.2 (AI-262.9437.185, JBR 25), Flutter plugin 97.0.0, Dart plugin 510.0.0,
Flutter 3.47.7. Devices: Android emulator `emulator-5554` (API 36, arm64), macOS desktop. Evidence below comes from
`javap -c` on the Flutter plugin jar and the platform jars, real `flutter run --machine` launches, the plugin test
suite (`RunIntegrationTest`, real Flutter plugin classes inside a test IDE) and a sandboxed Android Studio started
with the plugin (see "Real IDE run").

## Verdict

**Automatic hook: a `ProgramRunner` registered `order="first"` in front of the Flutter plugin's own runner.** It takes
Run / Debug / Android Profiler launches of `io.flutter.run.SdkRunConfig`, asks the sidecar (`prepareLaunch`, in a
background task, bounded), and hands the Flutter runner a **copy** of the run configuration whose additional args are
the sidecar's args plus `--target=<generated entry>`. The user's saved configuration is only read. The entrypoint
field (`filePath`) is not touched: `flutter run` takes an explicit `--target` over the positional entrypoint the
Flutter plugin appends, so every IDE-side use of the main file (validation, module lookup, console filters, analysis
issues) still sees `lib/main.dart`.

Plus a manual path that works even if another plugin's runner wins: **Run → "Run / Debug with Flutter Intercept"**
(launches the selected Flutter configuration through our runner explicitly). No run-configuration-level toggle is
needed: the automatic hook is reliable, and on/off is the user's Flutter Intercept setting.

| | Result |
|---|---|
| `--target` in the additional args wins over the plugin's positional `lib/main.dart` | ✅ emulator and macOS: isolate root library = our entry (VM service `getIsolate`) |
| Flutter plugin builds the patched command line from the copy | ✅ `RunIntegrationTest.testFlutterPluginBuildsThePatchedCommandLine` (real `FlutterSdk.flutterRun`) |
| Same, launched on a device; `sessionStarted` (with VM service URI) / `sessionEnded` | ✅ emulator 20 s, macOS 13 s (`testPatchedLaunchRunsTheEntryOnADevice`) |
| Saved configuration untouched; one copy per configuration reused | ✅ `testPatchedEnvironmentNeverTouchesTheSavedConfiguration` |
| Our runner is ordered before `FlutterRunner`; mirrors its `canRun`; never takes attach | ✅ `testRunnerIsRegisteredBeforeFlutters` |
| Release (Flutter's "Run in release mode" action or `--release` in args) | never intercepted ✅ test |
| Device kind from the plugin's selected `FlutterDevice` | ✅ mapping from measured daemon fields (below) |
| Full IDE path in a real Android Studio (run configuration → our runner → sidecar `prepareLaunch` → Flutter runner → `sessionStarted`) | ✅ macOS, Run and Debug ("Real IDE run") |
| Fail-open when the sidecar can't start | ✅ same IDE: one log line, app launched with the plain `lib/main.dart` command |

## How the Flutter plugin launches (javap, plugin 97.0.0)

- `FlutterRunner extends LaunchState.Runner<SdkRunConfig>` (`GenericProgramRunner`), id `"FlutterRunner"`,
  registered `<programRunner implementation="io.flutter.run.FlutterRunner"/>` (no id/order). `canRun`: executor
  `Run`, `Debug` or `Android Profiler`; a configured Dart SDK; a Flutter SDK; not while the same config's app is
  starting/reloading.
- `GenericProgramRunner.execute(env)` → `env.getState()` → `SdkRunConfig.getState(executor, env)`: copies `fields`,
  `checkRunnable`, `MainFile.verify(fields.filePath)` (needs the file in VFS/PSI, a `main()`, inside the project's
  base directories and a pub root), then `new LaunchState(env, appDir, mainFile, this, callback)`.
- `LaunchState.Runner.doExecute`: if `LaunchState.getRunningAppProcess(runConfig)` finds a live process **for the same
  configuration instance** (`ProcessHandler` user data `FLUTTER_RUN_CONFIG_KEY`, compared with `==`) on the same
  device and mode, and `identicalCommands(app.command, runConfig.getCommand(env, device))`, it hot-restarts instead
  of relaunching; otherwise it stops the old app and calls `LaunchState.launch(env)`.
- `LaunchState.launch`: `DeviceService.getInstance(project).getSelectedDevice()` (the device the app runs on), then
  `createApp(device)` → `SdkRunConfig.getCommand(env, device)` → `fields.copy().createFlutterSdkRunCommand(project,
  RunMode.fromEnv(env), FlutterLaunchMode.fromEnv(env), device, firstRun)` → `FlutterSdk.flutterRun(...)`:

  ```
  flutter run --machine [--verbose] [--track-widget-creation] --device-id=<id> [--start-paused]
              [--profile|--release] <additionalArgs…> [--flavor=<f>] [--dart-define=flutter.inspector.structuredErrors=true]
              [--devtools-server-address=…] <main file relative to the pub root>
  ```
  (working directory = pub root; `--start-paused` in Debug **and** Run mode, except the `web-server` device; the
  plugin resumes the isolate itself). `additionalArgs` is parsed with `ParametersListUtil.parse(s, false, false, true)`.
- Modes: `RunMode.fromEnv` = executor id (`Run` → RUN, `Debug` → DEBUG, `Android Profiler` → PROFILE);
  `FlutterLaunchMode.fromEnv` = env user data, set to RELEASE / PROFILE by the plugin's own "Run in Flutter
  release/profile mode" actions (`RunFlutterAction`: `RunConfiguration.clone()`, patch the clone's additional args,
  `ExecutionEnvironmentBuilder.create(executor, clone)`, `FlutterLaunchMode.addToEnvironment`, `ProgramRunnerUtil
  .executeConfiguration`). **The plugin itself launches patched clones**: our approach follows its own pattern.
- `FlutterApp` (`FlutterApp.fromProcess(handler)`): `getConnector().getWebSocketUrl()` = the `app.debugPort` wsUri once
  the state is STARTED; `addStateListener(FlutterAppListener.stateChanged)`. The plugin does not handle
  `app.webLaunchUrl`; it is on the process's stdout (`flutter_tools` `web_device.dart` emits it from `startApp`,
  before `app.started`).
- `build/last_build_run.json` (written by `SdkRunConfig.getState`) records only `--preview-dart-2` /
  `--track-widget-creation` from the command: our defines (which hold the LAN token on physical iPhones) are not
  written to disk by the plugin.
- No extension point in the Flutter plugin for launch args; `RunConfigurationExtension` is Java-only
  (`JavaRunConfigurationBase`) and `SdkRunConfig` never calls it.

## Candidates

| Candidate | Verdict |
|---|---|
| `ExecutionListener.processStartScheduled` patching the configuration | ✗ there is no setter for `env.runProfile`; patching the saved configuration in place and restoring it later leaves a window in which the IDE can save it (workspace.xml) and the editor shows it. Violates "never modified". |
| `RunConfigurationExtension`-style hook | ✗ none exists for Flutter configurations. |
| Replace `fields.filePath` with the generated entry | works in principle (`MainFile.verify` accepts `.dart_tool/…`: `BaseProjectDirectories.contains`), but needs a VFS refresh, a PSI parse of the entry, and changes what the plugin treats as the main file. `--target` needs none of that. |
| **Own `ProgramRunner`, `order="first"`, delegating a patched copy to `FlutterRunner`** | ✓ chosen. Automatic, one launch only, same executors/UI, before-run tasks unchanged. |
| Own action "Run/Debug with Flutter Intercept" | ✓ shipped as the manual path (uses the same runner explicitly). |

## `--target` precedence (measured)

flutter_tools `FlutterCommand.targetFile`: `if (argResults.wasParsed('target')) return target; … rest.first`. Driven
exactly like the plugin (`flutter run --machine --track-widget-creation --device-id=<id> <args> lib/main.dart`, with
`--target=.dart_tool/<entry>.dart` in the args), the VM service reported the main isolate's `rootLib` as the entry:

```
macOS:          app.start macos debug → app.debugPort → app.started → ISOLATE main rootLib=…/demo_app/.dart_tool/fi_spike/entry.dart (15 s)
emulator-5554:  app.start emulator-5554 debug → … → ISOLATE main rootLib=…/demo_app/.dart_tool/fi_spike/entry.dart (38 s)
```
and through the test with the real generated entry (`entry_lib__main.dart` from the entry generator) and the Flutter
plugin's own `FlutterSdk.flutterRun` command line:
```
flutter --no-color run --machine --track-widget-creation --device-id=emulator-5554 --start-paused --dart-define=USER=1
  --dart-define=SPACED=a b --dart-define=FLUTTER_INTERCEPT_PROXY=10.0.2.2:8899
  --target=.dart_tool/flutter_intercept/entry_lib__main.dart lib/main.dart
root libraries: …/.dart_tool/flutter_intercept/entry_lib__main.dart      (emulator 20 s, macOS 13 s, both passed)
```

## Device kind (measured `flutter daemon` `device.added`)

| id | platform | platformType | emulator | → `DeviceKind` |
|---|---|---|---|---|
| emulator-5554 | android-arm64 | android | true | android-emulator |
| macos | darwin | macos | false | macos |
| chrome | web-javascript | web | false | web |

`FlutterDevice` exposes these (`deviceId()`, `platform()`, `platformType()`, `emulator()`). iOS: platformType `ios`,
`emulator` true for simulators. Unknown → `other`. `emulator-<n>` ids count as emulators even without the flag.

## Design (as built, `packages/intellij/src/main/kotlin/dev/flutterintercept/run/`)

- `InterceptFlutterRunner` (`ProgramRunner`, id `FlutterInterceptRunner`): `canRun` = executor in {Run, Debug,
  Android Profiler}, `SdkRunConfig` but not `SdkAttachConfig`, and `FlutterRunner.canRun` on the copy we last launched
  for that configuration (so the plugin's "app is starting" check still sees the running app). `execute` →
  `InterceptLaunchService.launch`; any internal error → `FlutterRunner.execute(env)` unchanged.
- `InterceptLaunchService` (light project service):
  1. EDT, cheap: `describe` → `LaunchRequest` (program = a `-t/--target` the user already passes, else `filePath`;
     project root = nearest `pubspec.yaml`; device + kind from `DeviceService.getSelectedDevice()`; mode from
     `FlutterLaunchMode` / `RunMode` / `--release` / `--profile`; the user's args). Release, attach, no device, no
     entrypoint → unchanged.
  2. `Task.Backgroundable` "Flutter Intercept: preparing launch" (cancellable): `prepareLaunch` on a pooled thread,
     hard deadline 12 s (the sidecar's own budget is 10 s), cancellation → unchanged. A second start of the same
     configuration while one is being prepared is ignored (the platform's own "starting" guard only begins later).
  3. EDT: `Skip` → unchanged; `Rewrite` → the generated entry must exist → copy of the configuration
     (`SdkRunConfig.clone()`, kept per configuration in a `WeakHashMap` so the plugin's identity-based "same config →
     hot restart" keeps working), fresh `SdkFields` with `additionalArgs = sidecar args (they replace the user's) +
     --target=<entry relative to the pub root>` (no `--target` when the program is unchanged, i.e. Flutter Web), a
     new `ExecutionEnvironment` via `ExecutionEnvironmentBuilder(env).runProfile(copy)` (same settings, executor,
     target, user data, **runner = ours**, so the toolbar's Rerun prepares again), then `FlutterRunner.execute`. If
     that throws, the configuration runs unchanged; if that throws too, the platform's error reporting.
  4. Unchanged path: the user's configuration (also when a rerun hands us our old copy), our launch marker cleared.
  - One log line per decision in idea.log: `Flutter Intercept: <config> on <device> (<kind>, <mode>) runs <entry>`
    or `Flutter Intercept: not intercepting <config>: <reason>` (repeated identical reasons go to debug level). The
    args, the VM service URI and the LAN token are never logged.
- `SessionWatcher`: subscribed to `ExecutionManager.EXECUTION_TOPIC`; for a process whose environment carries our
  launch marker it reads stdout (`DaemonEvents`: `app.debugPort` wsUri, `app.webLaunchUrl` url, `app.started`) and
  the plugin's `FlutterApp` state as a second trigger. `sessionStarted(launchId, sessionId, deviceId, vmServiceUri,
  webLaunchUrl)` once the app has started; `sessionEnded(sessionId)` on process termination. A launch whose process
  dies before `app.started`, and a "same config again" that the plugin turns into a hot restart, send nothing more.
  Sidecar calls run on a pooled thread.
- `RunWithInterceptAction` / `DebugWithInterceptAction` (Run menu): selected Flutter configuration →
  `ExecutionEnvironmentBuilder(project, executor).runnerAndSettings(ourRunner, settings)` →
  `ProgramRunnerUtil.executeConfiguration` (before-run tasks, "stop running instance?" as usual).

### Registrations (`META-INF/flutter-intercept-run.xml`, included by plugin.xml)

```xml
<extensions defaultExtensionNs="com.intellij">
    <programRunner id="flutterInterceptRunner" order="first" implementation="dev.flutterintercept.run.InterceptFlutterRunner"/>
</extensions>
<actions>
    <action id="FlutterIntercept.RunWithIntercept" class="dev.flutterintercept.run.RunWithInterceptAction" text="Run with Flutter Intercept" icon="AllIcons.Actions.Execute">
        <add-to-group group-id="RunMenu" anchor="last"/>
    </action>
    <action id="FlutterIntercept.DebugWithIntercept" class="dev.flutterintercept.run.DebugWithInterceptAction" text="Debug with Flutter Intercept" icon="AllIcons.Actions.StartDebugger">
        <add-to-group group-id="RunMenu" anchor="last"/>
    </action>
</actions>
```
`InterceptLaunchService` is a light service (`@Service`), no registration. Requires `<depends>io.flutter</depends>`
and `<depends>Dart</depends>` (plugin.xml has both).

## Tests

`packages/intellij/src/test/kotlin/dev/flutterintercept/run/`: `RunArgsTest` (pure: arg parsing/quoting round trip,
target forms, modes, device kinds, daemon events) and `RunIntegrationTest` (test IDE with the real Flutter/Dart
plugins). The device test runs only when asked:

```
cd packages/intellij
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
FI_RUN_DEVICE=emulator-5554 FI_RUN_APP=<pub-get'd copy of samples/demo_app with .dart_tool/flutter_intercept/entry_lib__main.dart> \
  ./gradlew test --tests 'dev.flutterintercept.run.RunIntegrationTest.testPatchedLaunchRunsTheEntryOnADevice'
```
(`FI_RUN_DEVICE=macos` for the desktop; the Flutter SDK comes from `FLUTTER_ROOT` or PATH.)

## Real IDE run

Android Studio 2026.2 started from the plugin's sandbox (`./gradlew prepareSandbox`, then the installed
`studio` binary with `STUDIO_VM_OPTIONS` = the stock `studio.vmoptions` plus `-Didea.config.path / system.path /
plugins.path / log.path` in a scratch folder and `-Dflutter.intercept.sidecar=<repo>/packages/sidecar/dist/sidecar.js`)
on a pub-get'd copy of `samples/demo_app` with its `main.dart` run configuration. The launch was triggered without
clicks by the bundled Performance Testing plugin (`-Dtestscript.filename=<script>`):

```
%waitForSmart
%runConfiguration -mode=TILL_STARTED|-configurationName=main.dart|-failureExpected=false|-debug=false   (then -debug=true)
```
(`-Didea.trust.all.projects=true -Djb.consents.confirmation.enabled=false -Ddisable.android.first.run=true`, and the
application property `com.google.gct.login2.ui.StartupSignInDialog.shownVersion=9999.9` in `options/other.xml`,
otherwise Android Studio's Google sign-in dialog blocks startup.) idea.log, selected device = macOS:

```
05:01:18,625 %runConfiguration -mode=TILL_STARTED|-configurationName=main.dart|…
05:01:18,983 SidecarProcess - Started the Flutter Intercept sidecar (Node v26.4.0)
05:01:19,326 [sidecar] [prepareLaunch] macos device=macos program main.dart -> .dart_tool/flutter_intercept/entry_lib__main.dart (proxy localhost:8899, sha 26ebbb11f1a8)
05:01:19,346 InterceptLaunchService - Flutter Intercept: main.dart on macos (macos, debug) runs …/demo_app/.dart_tool/flutter_intercept/entry_lib__main.dart
05:01:19,359 FlutterApp - flutter [--no-color, run, --machine, --track-widget-creation, --device-id=macos, --start-paused,
             --dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=26ebbb11f1a8, --dart-define=FLUTTER_INTERCEPT_PROXY=localhost:8899,
             --target=.dart_tool/flutter_intercept/entry_lib__main.dart, --dart-define=flutter.inspector.structuredErrors=true, --devtools-server-address=…, lib/main.dart]
05:01:36,781 [sidecar] session started: macos device=macos proxyHost=localhost
05:01:36,791 [sidecar] vm[…]: watching via the VM service WebSocket
05:01:38,334 [sidecar] vm[…]: requests from background isolate "demo_worker" go through the proxy (overrides installed at isolate start)
```
Prepare took 0.7 s including the sidecar's first start (CA generation, proxy start). The first attempt, before the
sidecar property was set, showed the fail-open path:
`Flutter Intercept: not intercepting main.dart: The Flutter Intercept sidecar is missing from the plugin. Reinstall the plugin.`
followed by the Flutter plugin's normal command (`… --start-paused, …, lib/main.dart`). The saved
`.idea/runConfigurations/main_dart.xml` kept only its `filePath`.

**Found for K:** in that sandbox the sidecar *was* at `<plugins>/flutter-intercept-intellij/sidecar/sidecar.js`, but
`SidecarProcess.sidecarScript()` did not find it (it derives the plugin folder from
`protectionDomain.codeSource`); `runIde` hides this because it passes `-Dflutter.intercept.sidecar`. Suggest
`PluginManagerCore.getPlugin(PluginId.getId("dev.flutterintercept"))?.pluginPath`.

Not covered by the IDE run: the Android emulator (the Flutter plugin picks the selected device itself and keeps no
setting a script can preset; the emulator is covered by the device test above, which uses the Flutter plugin's own
command builder), physical devices, the Run menu actions (thin wrapper over the same runner), Rerun / "same config
again → hot restart", Android Profiler.

### Manual check for the owner

1. `npm run build -w @flutter-intercept/sidecar`, then `cd packages/intellij && ./gradlew runIde`.
2. Open `samples/demo_app`, pick the emulator in the Flutter device selector, press Run (and Debug).
3. Help → Show Log: `Flutter Intercept: main.dart on emulator-5554 (android-emulator, debug) runs …/entry_lib__main.dart`;
   the Run console shows `Launching .dart_tool/flutter_intercept/entry_lib__main.dart on …`; traffic appears in the
   Flutter Intercept tool window. Run → Edit Configurations: the configuration's additional args are unchanged.
4. Press Run again while the app runs: hot restart (Flutter's behaviour), no second instance. Stop: session ends.
5. Turn interception off (Tools → Flutter Intercept → Toggle) and Run: `not intercepting main.dart: …`, plain launch.
6. "Run in Flutter Release Mode" (Flutter menu): `not intercepting main.dart: release build: never intercepted`.

## LAN token in the launch args (REVIEW-9 #7)

The physical-iPhone define `FLUTTER_INTERCEPT_PROXY=flutter-intercept:<token>@<lanIp>:<port>` is visible in two places,
because the Flutter plugin echoes the full `flutter run` command line:

- **idea.log, INFO, logger `io.flutter.run.daemon.FlutterApp`.** `FlutterApp.start` calls
  `LOG.info(project + " (" + mode + ")")` and then `LOG.info(command.toString())` unconditionally, with no settings
  check (javap). Seen in the sandbox: `INFO - io.flutter.run.daemon.FlutterApp - …/flutter [--no-color, run, …,
  --dart-define=FLUTTER_INTERCEPT_PROXY=localhost:8899, …]`. "Collect Logs and Diagnostic Data" attaches idea.log to
  bug reports.
- **The Run console, first line.** The handler is `MostlySilentColoredProcessHandler` (an `OSProcessHandler`).
  `BaseOSProcessHandler.startNotify()` sends `getCommandLineForLog()` (the full command string) as `SYSTEM` text.
  `DaemonConsoleView.print` passes every non-`NORMAL_OUTPUT` type straight through, and
  `LaunchState.setUpConsoleAndActions` attaches the console before the platform calls `startNotify`. (Established from
  the bytecode; there is no screenshot, because the Performance Testing script stops after `%runConfiguration` on a
  `RunConfigurationCommand` NPE.)
- **Verbose mode.** With the Flutter setting "verbose logging" on, `flutter run --verbose` also prints the build
  invocations, defines included.

Nothing on our side can filter the plugin's logger or console without hacks (for example raising the
`io.flutter.run.daemon.FlutterApp` log level around a launch would not cover the console).

**Fix that keeps the entry template unchanged (verified):** pass the LAN address through `--dart-define-from-file`.
`String.fromEnvironment` reads those values exactly like `--dart-define`. On macOS:
`flutter run … --dart-define-from-file=.dart_tool/fi_spike/defines.json --target=…` with
`{"FLUTTER_INTERCEPT_PROXY":"flutter-intercept:TESTTOKEN@192.0.2.1:9"}` (file mode 0600). A VM-service `evaluate` of the
entry's `const String.fromEnvironment('FLUTTER_INTERCEPT_PROXY')` returned
`flutter-intercept:TESTTOKEN@192.0.2.1:9`. idea.log and the console then show only the file path.

**Remaining exposure, whichever way the define is passed:** flutter_tools writes every define, base64-encoded, into
`DART_DEFINES` in the app's generated build files. Measured: `macos/Flutter/ephemeral/Flutter-Generated.xcconfig`,
`flutter_export_environment.sh` and `flutter_native_integration.env` held the test token. For iOS the files are
`ios/Flutter/Generated.xcconfig` and `flutter_export_environment.sh`. Flutter's templates gitignore these files, and the
next build overwrites them. The VS Code host has the same exposure today. The token is only valid while the LAN
listener is open (it is new per opening), so a leaked copy is dead after the session.
