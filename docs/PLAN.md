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

## v0.2.0 — Agent API (2026-10-09)
Goal: AI agents (Copilot agent mode, Claude Code, Cursor) use Flutter Intercept as well as developers.
Contract: CONTRACTS §8. Parallel owners (disjoint files; each module exports `register(context, deps)`,
the lead wires `extension.ts` + `package.json`):
| Agent | Owns |
|---|---|
| B core | `src/agent/{api,schema,redact,har}.ts` + tests — the single implementation |
| C MCP | `src/agent/mcp/**` + tests — server, auth, registration, connectAgent command |
| A tools+launch | `src/agent/lmTools.ts`, `src/agent/launch.ts` + tests; device e2e of launch_app/hot_restart |
| D docs+UI | `src/agent/instructions.ts`, webview agent indicator/badges, README "Use with AI agents" |

## v0.3.0 — "Where did this come from?" (started 2026-10-09, branch `feature/0.3.0`)
Contract: CONTRACTS §9 (types already in code). Plan: ROADMAP §6. Same rules as before: disjoint files, no
`npm install`, random ports in tests (8899 is for device runs), findings in `docs/spikes/<topic>.md`, contract
change requests go there too — only the lead edits CONTRACTS.md, extension.ts, package.json (extension), README.
| Agent | WPs | Owns |
|---|---|---|
| P proxy | WP1 trace sink + header strip + `source.ts`, WP3 `send()`, WP5 throttle/fault + profiles, WP6 rewrite, WP7 rule spending | `packages/proxy/**` (except `network.ts`, `types.ts`: lead) · `docs/spikes/faults.md` |
| E entry + source | WP1 template v4 + Dio spike, source resolver/open, demo app scenarios | `src/entry/**`, `src/source/**`, `test/unit/{generator,source*}.test.ts`, `scripts/e2e/**`, `samples/demo_app/lib/**`, `test/integration/suite/devices.ts`, `docs/spikes/template-v4.md` |
| H host + agent | WP2 snippets, WP3/5 host messages, WP7 agent tools, all new agent tools | `src/agent/**`, `src/codegen/**`, `src/ui/{controller,view}.ts`, `src/proxyHost.ts`, their unit tests, `test/integration/suite/agent.ts` |
| W webview | WP4 search, WP2 copy menu, WP3 composer, WP1 "Open source", WP5 profile picker + rule editor, WP7 times/ttl | `packages/webview/**` (except `protocol.ts`: lead) |
| lead | contract, wiring, packaging | CONTRACTS, PLAN, `extension.ts`, extension `package.json`, README/CHANGELOG, device E2E, security review of trace channel + rewrite |

## v0.4.0 — "Your models vs the real API" (started 2026-10-09, branch `feature/0.4.0`)
Contract: CONTRACTS §10 (types already in code). Same rules as v0.3.0.
| Agent | Owns |
|---|---|
| P proxy | `mutate` action, `jsonpath.ts` (implement the stub) — `packages/proxy/**` except `types.ts`/`network.ts` |
| C contract | `src/contract/**` except `types.ts` (parser, indexes, mapping, checker, diagnostics, service), its tests; demo app models + Retrofit API + committed `*.g.dart` (`samples/demo_app/**` except the iOS project file) |
| G codegen | `src/codegen/**` except `types.ts` and `snippets.ts` (models, fixtures, routeTemplate, service), its tests |
| H host + agent | `src/agent/**` (new tools, MCP resources + prompts), `src/ui/controller.ts`, `src/proxyHost.ts`, their tests, `test/integration/suite/agent.ts` |
| W webview | `packages/webview/**` except `protocol.ts` |
| lead | contract, `extension.ts`, extension `package.json`, docs, device E2E, review |

## v0.5.0 — Coverage (started 2026-10-10, branch `feature/0.5.0`)
Contract: CONTRACTS §11. Same rules as before.
| Agent | Owns |
|---|---|
| P proxy | WebSocket/SSE recording, GraphQL detection + `graphqlOperation` matching, CORS diagnosis + preflight + `cors` action, `record()/update()` — `packages/proxy/**` except `types.ts`/`network.ts` |
| B web | Flutter Web spike + `src/debug/**` web path, `src/ca.ts` (SPKI helper), new `samples/web_app/**`, a `web` integration suite (`test/integration/suite/web.ts` + its runTest.ts hook), docs/spikes/web.md |
| V vm | VM service spike + `src/vm/**` (isolate warnings, native-client profile import), its tests, `samples/demo_app/{lib,pubspec.yaml}` scenarios (WebSocket, SSE, GraphQL, a native client, a background isolate), docs/spikes/vm-service.md |
| H host + agent | `src/agent/**`, `src/ui/controller.ts`, `src/proxyHost.ts`, their tests, `test/integration/suite/agent.ts` |
| W webview | `packages/webview/**` except `protocol.ts` |
| lead | contract, `extension.ts`, extension `package.json`, docs, device E2E, review |

## v0.6.0 — Teams & scenarios (started 2026-10-10, branch `feature/0.6.0`)
Contract: CONTRACTS §12. Same rules as before.
| Agent | Owns |
|---|---|
| P proxy | `sequence`, `mapRemote`, `rewrite`, `setReplay`, `upstreamProxy` — `packages/proxy/**` except `types.ts`/`network.ts` |
| S shared rules | `src/rules/**` (shared file, approval gate, bodyFile), its tests |
| R recordings | `src/recordings/**`, `src/analysis/**`, their tests |
| H host + agent | `src/agent/**`, `src/ui/controller.ts`, `src/proxyHost.ts`, their tests, `test/integration/suite/agent.ts` |
| W webview | `packages/webview/**` except `protocol.ts` |
| lead | contract, `extension.ts`, extension `package.json`, docs, E2E, review |

## v0.7.0 — Later / considered (started 2026-10-10, branch `feature/0.7.0`)
Contract: CONTRACTS §13. Same rules as before (disjoint files, no `npm install`, random ports, findings and
contract change requests in `docs/spikes/<topic>.md`).
| Agent | Owns |
|---|---|
| P proxy | timings, `script` action + worker runner (`src/script.ts`) — `packages/proxy/**` except `types.ts`/`network.ts` |
| S rules | `src/rules/**`: `script.file` resolution, approval of shared scripts, script templates; its tests |
| E export + notify | `src/export/**`, `src/notify/**` (pure + injected-deps glue), their tests |
| V vm + screenshot | background-isolate interception spike, `src/vm/**`, `src/entry/**` (template v5), `src/screenshot/**`, their tests, `samples/demo_app/lib/**`, `test/integration/suite/devices.ts`, docs/spikes/{background-isolates,screenshot}.md |
| C cli | `packages/cli/**` (except `src/types.ts`), docs/spikes/ci.md |
| H host + agent | `src/agent/**` (new tools, Windsurf, HAR timings, script views), `src/ui/controller.ts`, `src/proxyHost.ts`, their tests, `test/integration/suite/agent.ts` |
| W webview | `packages/webview/**` except `protocol.ts` |
| lead | contract, types, `extension.ts`, extension `package.json`, `src/ui/view.ts` + new `src/ui/panel.ts` (own window), Open VSX, docs, E2E, review |

### v0.7.0 status (2026-10-10)
Built and verified: unit tests (proxy 389, webview 385, extension 1534, cli 79) and the integration suites on the
packaged VSIX — default 42/42, agent 17/17 (macOS + Android emulator), devices 23/23 (Android emulator, iOS
simulator, macOS), web 6/6. Independent review: docs/REVIEW-7.md, all 14 findings fixed. Merged into `main` locally
(0.3.0 → 0.7.0 in one fast-forward) for the Marketplace release; push, Open VSX and Marketplace publishing are the
owner's steps. Next: docs/ROADMAP.md §4 "Next / considered" (proposed 0.8.0).

## v0.8.0 — Next / considered (started 2026-10-10, branch `feature/0.8.0`)
Contract: CONTRACTS §14. Same rules as before.
| Agent | Owns |
|---|---|
| P proxy | TLS passthrough, mTLS, upload / WebSocket throttling, idle pool + retry, WS/SSE replay — `packages/proxy/**` except `types.ts`/`network.ts` |
| C cli | GitHub Action (`action.yml` at the repo root), physical iPhones in CI, npm-ready package — `packages/cli/**` except `src/types.ts` |
| V vm + native | native-clients spike, isolates profile/spawnUri spike, bypass detection, iPhone screenshots — `src/vm/**`, `src/screenshot/**`, `src/adb.ts`, `src/iosDevices.ts`, `samples/demo_app/lib/**`, `test/integration/suite/devices.ts`, spike docs |
| B web | PAC fallback, web-server notice, web screenshots via CDP — `src/debug/**`, `samples/web_app/**`, `test/integration/suite/web.ts`, docs/spikes/web.md |
| R recordings + export | WS/SSE recordings, diff, `toReplay`; OpenAPI `securitySchemes` — `src/recordings/**`, `src/export/**` |
| H host + agent | `http.proxy` default, client certificates (files, secret storage), passthrough setting, multipart redaction, agent tool updates — `src/agent/**`, `src/ui/controller.ts`, `src/proxyHost.ts` |
| W webview | tunnels, cert / passthrough status, upload throttle fields, WS/SSE recordings UI — `packages/webview/**` except `protocol.ts` |
| lead | contract, types, `extension.ts`, extension `package.json`, docs, E2E, review |

### v0.8.0 status (2026-10-10)
Built and verified: unit tests (proxy 425, webview 415, extension 1714, cli 113) and the integration suites on the
packaged VSIX — default 42/42, agent 19/19 (macOS + Android emulator), devices 24/24 (Android emulator, iOS simulator,
macOS), web 8/8. Independent review: docs/REVIEW-8.md, all findings fixed or documented. Not verified on hardware: a
physical iPhone in CI mode and iPhone screenshots via `devicectl` (no device connected), Edge.

