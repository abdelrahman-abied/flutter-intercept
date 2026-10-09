# Developing Flutter Intercept

To contribute, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Repo layout

| Path | What |
| --- | --- |
| `packages/proxy` | `@flutter-intercept/proxy`: the MITM proxy, rules and exchange store, built on mockttp. Its subpath `/rules` is dependency-free and shared with the webview. |
| `packages/webview` | Preact UI bundle (`dist/webview.js` and `dist/webview.css`): traffic list, detail view, pause editor, rules. |
| `packages/extension` | The VS Code extension: debug provider, entry generator, devices (adb, iPhone LAN mode), proxy host, panel, status bar, `.vsix` packaging. |
| `samples/demo_app` | A Flutter app using plain Dio and package:http, with **no tool code**. Used by the device checks. |
| `scripts/e2e` | Device end-to-end checks (`run_device.sh`), entry templates, a test MITM proxy, the SDK compatibility harness. |
| `docs/` | This guide, plan, contracts, reviews, spike reports (see [Docs](#docs)). |

## Prerequisites

| What | Needed for |
| --- | --- |
| **Node.js 22+** (npm workspaces) | Everything. |
| **Dart SDK** on `PATH` (stable; the Flutter SDK includes it) | Proxy and extension unit tests: some compile and run real Dart programs. |
| **VS Code** with **Dart-Code** installed | The integration suites. |
| **Flutter SDK** | Integration and device suites. |
| **Android SDK** (`adb`, an emulator) and/or **Xcode** (simulator; a signing team for physical iPhones) | Device end-to-end checks. |

## Build and test

```bash
npm ci                 # once, at the repo root (npm workspaces)
npm run build          # builds every package in order: proxy → webview → extension
npm test               # unit tests of every package
```

Build order matters:

- The webview imports `@flutter-intercept/proxy/rules` from `packages/proxy/dist`.
- The extension bundles the proxy and copies `packages/webview/dist/*`.

The root `npm run build` builds them in the right order.

**Per package** (run inside the package directory):

| Package | Command | What it does |
| --- | --- | --- |
| `packages/proxy` | `npm run build` | `tsc` → `dist/` (with `.d.ts`). |
| | `npm test` | vitest; some tests compile and drive a real Dart client. |
| `packages/webview` | `npm run build` | esbuild → `dist/webview.js` + `dist/webview.css` (minified). |
| | `npm test` | `tsc` typecheck, then vitest (state, util, lossless JSON, components with happy-dom). |
| | `npm run dev` | Browser dev harness with a fake host at `http://127.0.0.1:5178/dev/index.html`. |
| `packages/extension` | `npm run typecheck` | `tsc --noEmit`. |
| | `npm test` | vitest unit tests; some run real `dart`. |
| | `npm run build` | esbuild → `dist/extension.js`, copies the webview dist. Needs proxy and webview built first. |
| | `npm run test:bundle` | Smoke-tests the bundled extension (the mockttp patches survive bundling). |
| | `npm run package` | `vsce` → `flutter-intercept.vsix`. |

The webview dev harness takes URL params (documented at the top of `packages/webview/dev/fake-host.ts`):

| Param | What it does |
| --- | --- |
| `?theme=vscode-light` | Light theme. |
| `?stream=0` | No new traffic after load. |
| `?seed=10` | Reproducible traffic. |
| `?bare=1` | Hides the dev bar, for screenshots. |
| `?lan=1` | Starts with the iPhone LAN listener shown as open. |

## Integration and device suites (opt-in)

```bash
cd packages/extension
npm run test:integration   # downloads VS Code into .vscode-test/, runs the Dart (+ macOS Flutter) suites with Dart-Code
npm run test:vsix          # build + package + the same suites against the packaged .vsix
```

- The suites copy Dart-Code from your normal VS Code into the test instance.
- They use a throwaway user-data-dir and never touch your profile.

Environment variables:

| Variable | What it does |
| --- | --- |
| `FI_SUITE=dart\|flutter\|devices` | Which suites to run. |
| `FI_RUNS` | How many times each Dart scenario runs. |
| `FI_FLUTTER_RUNS` | How many Flutter runs. |
| `FI_VSCODE_VERSION` | Which VS Code version to download. |
| `FI_VSIX=<file>` | Run against a packaged `.vsix`. |
| `FI_DEVICES=<ids>` | Comma-separated device ids for the device suite (required by it). |
| `FI_ALLOW_PHYSICAL_IOS=1` | A physical iPhone needs this **and** its id in `FI_DEVICES`. |

**Device suite:** the packaged extension on real targets.

```bash
npm run build && npm run package && node build.mjs --tests
FI_VSIX=flutter-intercept.vsix FI_SUITE=devices FI_DEVICES=emulator-5554,<ios-sim-udid> node dist-test/runTest.js
```

**Device checks without VS Code:** `scripts/e2e/run_device.sh` uses a test MITM proxy and `samples/demo_app`.

```bash
scripts/e2e/run_device.sh <deviceId> [options]          # no args prints usage
scripts/e2e/run_device.sh emulator-5554                  # Android emulator (adb reverse)
scripts/e2e/run_device.sh emulator-5554 --emulator-host  # Android emulator via 10.0.2.2
scripts/e2e/run_device.sh <ios-simulator-udid> --attack  # iOS simulator + self-signed attack server
scripts/e2e/run_device.sh <iphone-udid> --lan <mac-lan-ipv4> --attack [--profile]   # physical iPhone (LAN mode)
```

What the script needs:

- A booted device listed by `flutter devices`.
- A Flutter SDK on `PATH`.
- `adb` for Android.
- Internet access: the demo calls jsonplaceholder.typicode.com and httpbin.org.

It uses port 8899 by default, and exit code 0 means every check passed.

## Docs

| Doc | What it covers |
| --- | --- |
| [`PLAN.md`](PLAN.md) | Goals, architecture, phases, known limits. |
| [`CONTRACTS.md`](CONTRACTS.md) | **The source of truth between packages**: generated entry, ports and hosts, proxy API, webview messages, settings, LAN mode. |
| [`REVIEW-1.md`](REVIEW-1.md) | Independent review: findings and fix plan. |
| [`REVIEW-2.md`](REVIEW-2.md) | Independent review: iPhone LAN-mode security. |
| [`spikes/`](spikes/) | Measured findings: `device.md`, `extension.md`, `iphone.md`, `proxy.md`, `template-v2.md`, `template-v3.md`, `webview.md`. |

## License

[MIT](../LICENSE) © Abdulrahman Obaid
