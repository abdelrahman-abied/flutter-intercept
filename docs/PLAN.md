# Flutter Intercept — Plan

A VSCode extension that lets a Flutter developer **view, pause, edit, block and mock**
the app's HTTP traffic with **zero code in the app** and **zero configuration**:
install the extension, press F5 as usual, traffic shows up.

## How it works

```
F5 (Dart-Code debug session, type "dart")
  │
  ▼
our DebugConfigurationProvider('dart')
  ├─ reads the original `program` (default lib/main.dart, flavors respected)
  ├─ generates <project>/.dart_tool/flutter_intercept/entry_<name>.dart  (dart:io only)
  ├─ rewrites `program` → generated entry
  └─ Android device → `adb -s <id> reverse tcp:<port> tcp:<port>`
  │
  ▼
generated entry: HttpOverrides (findProxy 'PROXY host:port; DIRECT', trusts only the
                 per-install CA — template v3) then calls the app's real main()
  │
  ▼
MITM proxy inside the extension (mockttp) → rules engine → webview UI
```

Proven in a Dart VM spike (2026-10-08): HTTPS response edited by the proxy reached a
plain Dio app; with the proxy down, `; DIRECT` fell back to the real server.

## Repo layout

| Path | Owner | What |
|---|---|---|
| `packages/proxy` | Agent C | TS library: MITM proxy + rules + exchange store (mockttp) |
| `packages/webview` | Agent D | Preact UI bundle: traffic list, detail, pause editor, rules |
| `packages/extension` | Agent B | VSCode extension: debug provider, entry generation, devices, wiring |
| `samples/demo_app` | Agent A | Flutter app with plain Dio + http, flavors, **no tool code** |
| `scripts/e2e` | Agent A, then integration | Device/simulator end-to-end scripts |
| `docs/CONTRACTS.md` | lead | Interfaces every agent codes against — change only via lead |
| `docs/spikes/*.md` | each agent | Findings, measured results, open issues |

## Phases

### Phase 0 — scaffold (lead) ✅
Monorepo (npm workspaces), deps pre-installed, PLAN + CONTRACTS. Agents must NOT run
`npm install` at the root concurrently; ask the lead if a new dependency is needed.

### Phase 1 — parallel (4 agents)
A ✅ works with changes (docs/spikes/device.md) — template + hosts updated in CONTRACTS.
B ✅ GO — F5 takeover is order-independent, 36/36 real VSCode + Dart-Code runs (docs/spikes/extension.md).
C ✅ mockttp enough for all 5 actions, 64 tests incl. real Dart client (docs/spikes/proxy.md).
D ✅ UI built, 76 tests, not yet inside a real webview (docs/spikes/webview.md).
| Agent | Goal | Gate it answers |
|---|---|---|
| A device | demo app + hand-written entry; run `flutter run -t .dart_tool/flutter_intercept/entry_main.dart` on Android emulator (adb reverse) and iOS simulator through a test proxy; verify hot restart, `; DIRECT`, flavor target, zone override vs app replacing `HttpOverrides.global` | Does `-t` into `.dart_tool/` work on real Flutter targets? |
| B extension | provider + entry generator + adb reverse + status-bar toggle; integration test with real VSCode + Dart-Code proving the FINAL launched config uses our entry (ordering of providers) | Can we reliably take over F5? |
| C proxy | `InterceptProxy` per CONTRACTS: capture, request/response breakpoints with resume/edit/abort, mock, block, rule matching, gzip; tests with a real Dart `HttpClient` client | Is mockttp enough for all 5 actions? |
| D webview | UI against the message protocol with a fake host | — |

### Phase 2 — integration (lead + 1–2 agents)
Wire proxy + webview into the extension; rules persistence (workspaceState);
edge cases: `main(List<String>)`, targets outside `lib/`, iOS physical device LAN IP,
several concurrent sessions, port in use, paused request vs app `receiveTimeout`.

### Phase 3 — E2E + package
`@vscode/test-electron` session that launches the demo app on the Android emulator and
iOS simulator through the extension and asserts edited/blocked/mocked responses.
`vsce package` → `.vsix`. README. Code review.

Publishing to VS Code Marketplace / Open VSX needs the user's publisher accounts —
**user decision, not done by agents.**

## Fallbacks if a gate fails
- `.dart_tool/` rejected as `-t` target → hidden project dir `.flutter_intercept/` (needs a gitignore line — tell the user).
- Provider ordering unreliable → own command "Debug with Intercept" that calls
  `vscode.debug.startDebugging` with the rewritten config (F5 no longer automatic).

## Known limits (by design)
Flutter Web (no dart:io), native adapters (cronet/cupertino/native_dio_adapter),
background isolates, Dio `validateCertificate` pinning, mTLS client certificates, an app `connectionFactory` that ignores the proxy,
apps that wrap their code in their own `HttpOverrides.runWithHttpOverrides`/`runZoned` overrides zone,
(app `findProxy` assignments are neutralised by the wrapper client; since template v3 the entry trusts only the per-install CA — no accept-any callback — so DIRECT fallback keeps normal TLS verification; see docs/REVIEW-1.md, docs/spikes/template-v3.md.)
