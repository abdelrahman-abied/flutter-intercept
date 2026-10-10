# flutter-intercept (headless / CI)

Runs your Flutter integration tests through the Flutter Intercept proxy without VS Code. It applies the
shared rules from your repository, can replay a recording or simulate a slow network, and checks the traffic
against expectations. Like the extension, it changes no app code: a generated entry point routes the app's
`dart:io` traffic (Dio, package:http, `HttpClient`) through a proxy on 127.0.0.1.

Use it as a [GitHub Action](#github-action), or build it from this repository and run the bundle with Node 18
or later (not published to npm yet):

```sh
npm install && npm run build          # at the repository root
node packages/cli/dist/cli.js --help
```

## Usage

```sh
flutter-intercept test [targets…] [options] [-- flutter args]
flutter-intercept run  [targets…] [options] [-- flutter args]
```

`test` runs `flutter test <target> -d <device>` through the proxy. Targets are test files or directories and
default to `integration_test/`. Your app needs `integration_test: {sdk: flutter}` in `dev_dependencies`, like any
Flutter integration test.

`run` starts the proxy, generates the entry for each target (default `lib/main.dart`), prints the
`flutter run -t … --dart-define=…` command to use, and stops on Ctrl-C. Use it for `flutter drive` setups or a
manual session.

```sh
# Integration tests on the Android emulator, with a HAR, assertions and a JUnit report
node packages/cli/dist/cli.js test -d emulator-5554 \
  --har build/traffic.har --assert ci/expect.json --junit build/traffic-junit.xml

# One test on macOS, answered from a recording, failing on any request that isn't in it
node packages/cli/dist/cli.js test integration_test/login_test.dart -d macos \
  --replay login --replay-fallback fail

# Flavors and other flutter options go after --
node packages/cli/dist/cli.js test -d macos --network-profile slow-3g -- --flavor dev
```

| Option | |
|---|---|
| `-d, --device <id>` | Flutter device id. Without it, the only connected device is used. |
| `-p, --project <dir>` | Flutter project root (default: nearest `pubspec.yaml` from the current directory). |
| `--port <n>` | Proxy port (default: a free port). |
| `--rules <file>` / `--no-rules` | Shared rules file (default: `.vscode/flutter-intercept.json` when present). |
| `--approve-shared-rules` | Also apply rules that need approval in the editor. |
| `--replay <id\|file>` | Answer requests from a recording (an id in `.dart_tool/flutter_intercept/recordings`, or a path). |
| `--replay-fallback passthrough\|fail` | What unmatched requests do while replaying (default `passthrough`). |
| `--network-profile <id>` | `offline`, `slow-3g`, `fast-3g` or `flaky`. |
| `--har <file>` | Write a HAR of the run. Secrets are redacted unless you pass `--no-redact`. |
| `--record <name\|file>` | Save the run as a recording: a name goes to the project's recordings, a `.json` path is written there. |
| `--assert <file>` | Check expectations (below). Any failure makes the exit code 1. |
| `--junit <file>` | Write the assertion results as JUnit XML. |
| `--no-redact` | Keep secrets in the HAR and in assertion messages. |
| `--flutter <path>` | Flutter executable (default: `$FLUTTER_ROOT/bin/flutter`, else `flutter` on `PATH`). |

**How each device reaches the proxy:** Android emulators (`emulator-*`) use `10.0.2.2`. Physical Android devices
get an `adb reverse`, which is removed afterwards. macOS and iOS simulators use `localhost`. Physical iPhones use a
token-protected listener on the Mac's LAN address ([below](#physical-iphones)).

**Exit code:** flutter's exit code when flutter fails. Otherwise 1 when an assertion failed, else 0. A usage or
setup error exits with 2 before anything runs. An interrupted `test` exits with 130 (Ctrl-C) or 143 (SIGTERM).

## Shared rules

The CLI reads the same `.vscode/flutter-intercept.json` the extension uses. It looks in the project root and, inside
a git repository, in the folders above it up to the repository root. It applies rules the way the editor does,
including mock bodies from files. It refuses a rules file that other users could change (in a world-writable
folder, or owned by another user), and it prints user `--dart-define` values as `***`.

Some rules need approval in the editor before they apply: Map Remote to a non-local host, rewrites of request
headers, and every script rule. The CLI skips those and prints why, for example:

```
[flutter-intercept] rules: skipped (needs approval; pass --approve-shared-rules to apply): Rule "Staging" (any method https://api.example.com/*): sends the app's requests to https://staging.example.com instead of the real server
```

Pass `--approve-shared-rules` in a pipeline you control to apply them anyway. Breakpoint rules are always off,
because nobody can resume a paused request in a headless run. A `--rules` file must be inside the repository (or
the project).

## Expectations

`--assert` takes a JSON array of [`assert_traffic`](https://github.com/abdelrahman-abied/flutter-intercept/blob/main/packages/extension/README.md) inputs, the same check that agents use.
Each item may also have a `name`:

```json
[
  {
    "name": "profile loads",
    "url": "https://api.example.com/users/*",
    "method": "GET",
    "expect": { "status": 200, "count": { "min": 1 }, "json": [{ "path": "$.name", "type": "string" }] }
  },
  {
    "name": "login before profile",
    "url": "https://api.example.com/*",
    "expect": { "order": ["*/login", "*/users/*"], "maxDurationMs": 2000 }
  }
]
```

`expect` supports `status` (a code, `"2xx"`…`"5xx"` or `"error"`), `count` (`min` / `max` / `exact`; the default is
at least one), `order` (URL globs that must have been requested in that order), `json` (`{path, exists | equals |
type}` on every matched response) and `maxDurationMs`. The check runs after flutter exits, against everything
recorded during the run. The file is validated first, so a typo fails before the build starts.

## GitHub Action

The repository root is a composite action. It builds the CLI from the action's own checkout (only the locked
dependencies are installed, nothing else comes from npm), runs `flutter-intercept test`, uploads the HAR, the JUnit
report and a recording written to a path with `actions/upload-artifact`, and fails the step when flutter fails or
an expectation fails. The runner needs Node.js 18 or later on `PATH` (GitHub-hosted runners have it) and Flutter.

```yaml
name: integration
on:
  push:
  pull_request:

jobs:
  macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v7
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
      - uses: abdelrahman-abied/flutter-intercept@v0.8.0
        with:
          device: macos
          har: build/traffic.har
          assert: ci/expect.json
          junit: build/traffic-junit.xml
          artifact-name: traffic-macos

  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
      - name: Start an Android emulator
        run: |
          sdk="$ANDROID_HOME/cmdline-tools/latest/bin"
          image="system-images;android-34;google_apis;x86_64"
          yes | "$sdk/sdkmanager" --licenses > /dev/null
          "$sdk/sdkmanager" "emulator" "platform-tools" "$image" > /dev/null
          echo no | "$sdk/avdmanager" create avd --name ci --package "$image"
          nohup "$ANDROID_HOME/emulator/emulator" -avd ci -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect > /dev/null 2>&1 &
          "$ANDROID_HOME/platform-tools/adb" wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
      - uses: abdelrahman-abied/flutter-intercept@v0.8.0
        with:
          device: emulator-5554
          targets: integration_test/app_test.dart
          network-profile: fast-3g
          har: build/traffic.har
          assert: ci/expect.json
          junit: build/traffic-junit.xml
          artifact-name: traffic-android
```

If you already use `reactivecircus/android-emulator-runner`: it stops the emulator when its own step ends, so run
the CLI inside its `script` and upload the files yourself:

```yaml
name: integration-android
on:
  pull_request:

jobs:
  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
      - name: Build flutter-intercept
        run: |
          git clone --depth 1 --branch v0.8.0 https://github.com/abdelrahman-abied/flutter-intercept "$RUNNER_TEMP/fi"
          cd "$RUNNER_TEMP/fi"
          npm ci --no-audit --no-fund --ignore-scripts
          npm run build --workspace packages/proxy
          npm run build --workspace packages/cli
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          arch: x86_64
          script: node "$RUNNER_TEMP/fi/packages/cli/dist/cli.js" test -d emulator-5554 --har build/traffic.har --assert ci/expect.json --junit build/traffic-junit.xml
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: traffic-android
          path: build/traffic*
```

| Input | |
|---|---|
| `working-directory` | Flutter project root (default `.`). The other paths are relative to it. |
| `device` | Flutter device id. Empty: the only connected device. |
| `targets` | Test files or directories, one per line or space-separated (default `integration_test/`). |
| `har`, `junit` | Output paths; uploaded. The HAR is redacted. `junit` needs `assert`. |
| `record` | A `.json` path is written and uploaded (not redacted: replay needs the real bodies); a name is saved in the project's recordings. |
| `assert` | Expectations file. A failed expectation fails the step (exit code 1). |
| `replay`, `replay-fallback` | Answer from a recording; `passthrough` (default) or `fail` for unmatched requests. |
| `network-profile` | `offline`, `slow-3g`, `fast-3g` or `flaky`. |
| `rules` | Shared rules file; empty = `.vscode/flutter-intercept.json` when present; `none` = no rules. |
| `approve-shared-rules` | `true` applies rules that need approval in the editor. Only in pipelines you control. |
| `flutter-args` | Extra `flutter test` arguments, one per line or space-separated (no shell quoting). |
| `artifact-name` | Artifact name (default `flutter-intercept`). Make it unique per job, for example per matrix entry. |
| `upload-artifacts` | `false` skips the upload. |

Outputs: `exit-code`, and the absolute paths `har`, `junit`, `record`.

## Physical iPhones

`test -d <iPhone UDID>` works on a Mac runner with a connected iPhone (a self-hosted runner). An iPhone can't
reach the Mac's loopback address, so for the length of the run the proxy also listens on the Mac's LAN address:

- only the IPv4 of the interface that carries the default route, and only a private (RFC 1918) one. Without one
  the run is refused (exit code 2);
- every request must carry a token that is new for each run (32 random bytes). The token is passed to the app in
  the `FLUTTER_INTERCEPT_PROXY` define and is never printed: the logged command shows
  `flutter-intercept:***@<address>:<port>`. Don't pass `-v` to flutter, because verbose builds print define values;
- the first device that connects with the token is the only one accepted, and LAN clients can't reach this Mac's
  own services (localhost, its other addresses) through the proxy;
- the listener closes when the run ends, also on Ctrl-C.

Before the first CI run, allow two things by hand: on macOS, incoming connections for `node` if the application
firewall is on; on the iPhone, the app's Local Network access (iOS asks on the app's first run, and nobody can
answer that prompt in CI). The iPhone and the Mac must be on the same, trusted network. `run` refuses physical
iPhones, because it would have to print the token.

## npm

`packages/cli` is ready to publish as `flutter-intercept-cli` (not published yet). The package holds only the
bundled `dist/cli.js` (no runtime dependencies), this README and the license, and `prepublishOnly` builds it.
Once it is published:

```sh
npx flutter-intercept-cli test -d macos --har build/traffic.har
```

## Limits

- Flutter Web devices are not supported. Physical iPhones work with `test` only (see above).
- Only `dart:io` traffic goes through the proxy. Native HTTP stacks (cupertino_http, cronet_http) and platform
  views are not seen: the editor's VM-service capture isn't available in a headless run.
- Run one CLI at a time per project: the generated files under `.dart_tool/flutter_intercept/` and
  `integration_test/.flutter_intercept/` are shared.
- The run's certificate authority lives in a temporary directory, only the generated entry trusts it, and it is
  deleted when the run ends. Nothing is installed on the device or the machine.
