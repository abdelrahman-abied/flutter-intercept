# Contributing to Flutter Intercept

Thanks for helping! Bug reports, device reports and pull requests are all welcome. By taking part you agree to
the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately: see [SECURITY.md](SECURITY.md).

## Setup

You need the prerequisites listed in the [development guide](docs/DEVELOPMENT.md#prerequisites): at least
Node.js 22+ and a Dart SDK on `PATH`.

```bash
git clone https://github.com/abdelrahman-abied/flutter-intercept.git
cd flutter-intercept
npm ci                 # npm workspaces: packages/proxy, packages/webview, packages/extension
npm run build          # proxy → webview → extension (order matters)
npm test               # unit tests of every package
```

To try your build in VS Code:
1. Package it with `npm run package -w flutter-intercept`.
2. Install the result with `code --install-extension packages/extension/flutter-intercept.vsix`.
3. Open a Flutter project and press F5.

You can also open `packages/extension` in VS Code and run it in an Extension Development Host.

For UI work, `npm run dev -w @flutter-intercept/webview` serves the traffic panel with a fake host in your
browser, at `http://127.0.0.1:5178/dev/index.html`.

## Contracts first

The three packages talk to each other only through the interfaces in **[`docs/CONTRACTS.md`](docs/CONTRACTS.md)**,
the source of truth between packages. It covers:
- the generated Dart entry;
- ports and hosts per device;
- the proxy API;
- the extension ↔ webview messages;
- settings and commands;
- iPhone LAN mode.

If your change crosses a package boundary:

1. **Update `docs/CONTRACTS.md` first**, in the same pull request, and explain why in the description.
2. Update each side of the interface to match. Duplicated types (for example the webview's message types)
   must not drift from the contract.
3. If you measured something (devices, Flutter versions, security behaviour), record it in the relevant
   `docs/spikes/*.md`: what you ran, on what, and the result. Keep "verified" and "inferred" apart.

Background reading: [`docs/PLAN.md`](docs/PLAN.md) (architecture and known limits), and the reviews
[`docs/REVIEW-1.md`](docs/REVIEW-1.md) and [`docs/REVIEW-2.md`](docs/REVIEW-2.md).

## Tests that must pass

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs these on Ubuntu and macOS. Run them locally
before opening a PR:

```bash
npm ci
npm run build
npm test                                   # proxy + webview (typecheck included) + extension unit tests
npm run test:bundle -w flutter-intercept   # the bundled extension still works (mockttp patches survive bundling)
npm run package -w flutter-intercept       # the .vsix still packages
```

Add or adjust tests with your change:
- **Pure logic** (rules, edit diffs, entry generation, LAN/address logic, message validation) gets unit tests
  in the package's `test/` directory.
- **Anything the app runs** (the generated entry, the proxy's TLS and trust behaviour): prefer tests that run a
  real Dart program. The existing proxy and extension suites show how.
- **Webview changes**: keep `src/state.ts` pure and test it. Add a component test (happy-dom) for new UI
  behaviour.

### Integration and device suites

These aren't run in CI, but run them when you touch the debug provider, entry generation or device handling:

```bash
cd packages/extension
npm run test:integration          # real VS Code + Dart-Code (Dart suite; Flutter suite on macOS)
npm run test:vsix                 # the same, against the packaged .vsix
```

To run the device suite against the packaged extension:

```bash
npm run build && npm run package && node build.mjs --tests
FI_VSIX=flutter-intercept.vsix FI_SUITE=devices FI_DEVICES=<id>[,<id>...] node dist-test/runTest.js
```

- A physical iPhone needs a double opt-in: its id in `FI_DEVICES` **and** `FI_ALLOW_PHYSICAL_IOS=1`.
- To check a device without VS Code, use `scripts/e2e/run_device.sh <deviceId> [options]` (no arguments
  prints the options). It runs `samples/demo_app` through a test proxy and exits non-zero on failure.

Mention in your PR which devices you ran on: Android emulator or phone, iOS simulator, iPhone over USB or
Wi-Fi, macOS.

## Never commit personal or secret data

Before committing, check your diff, including test fixtures, logs pasted into docs, and Xcode project files.
Never commit any of these:
- **Apple signing team IDs** (`DEVELOPMENT_TEAM` in `project.pbxproj`). Set your team locally in Xcode and
  leave the change unstaged.
- **Device identifiers**: iPhone/simulator UDIDs, Android serials of physical devices. Use placeholders such as
  `<iphone-udid>`.
- **Proxy tokens** (`FLUTTER_INTERCEPT_PROXY=…` values), CA private keys, or `.vsix` files you built.
- **Personal data**: email addresses, Apple IDs, home LAN addresses. Use `192.168.1.x`-style examples.

## Commits and pull requests

- Keep each PR focused on one change, with tests. Small PRs get reviewed faster.
- Commit messages: an imperative summary line (for example `Proxy: refuse LAN targets routed via utun`), then a
  body that explains *why* when it isn't obvious.
- Prefix the summary with the area when it helps: `Proxy:`, `Webview:`, `Extension:`, `Docs:`, `e2e:`.
- Describe user-visible changes in the PR, and update `packages/extension/README.md` or `CHANGELOG.md` when
  behaviour or settings change.
- Fill in the pull request template. In particular, list what you tested and on which devices.
- Don't run `npm install` to add dependencies casually. Keep the extension bundle small, and explain any new
  dependency in the PR.
