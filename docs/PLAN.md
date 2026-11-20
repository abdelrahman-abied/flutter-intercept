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


## v0.9.0 — Android Studio / IntelliJ plugin (started 2026-10-11, branch `feature/0.9.0`)
Contract: CONTRACTS §15. Same rules as before.
| Agent | Owns |
|---|---|
| S sidecar | `packages/sidecar/**` except `src/types.ts` |
| K plugin core | `packages/intellij/**` except `src/main/kotlin/dev/flutterintercept/run/**` and `api/SidecarApi.kt` |
| R run integration | `packages/intellij/src/main/kotlin/dev/flutterintercept/run/**`, docs/spikes/intellij-run.md |
| W webview | `packages/webview/**` except `protocol.ts` (standalone WebSocket host, IDE theme) |
| lead | contract, types, `api/SidecarApi.kt`, docs, integration, review |

### v0.9.0 status (2026-10-11)
Both editors from one code base: VS Code extension 0.9.0 and the Android Studio / IntelliJ plugin 0.9.0 (sidecar +
Kotlin plugin). Verified: unit tests (proxy 425, webview 442, extension 1723, cli 113, sidecar 38, plugin 95), VS Code
integration suites on the packaged VSIX (default 42/42, agent 19/19, devices 24/24, web 8/8), the plugin in a real
Android Studio 2026.2 sandbox installed from the built zip (launch prepared and intercepted on macOS, traffic shown
inside the IDE through the Flutter plugin's embedded browser), `verifyPlugin` Compatible. Independent review:
docs/REVIEW-9.md, all findings fixed. Not verified on hardware: the plugin on the Android emulator inside the IDE,
JCEF in IntelliJ IDEA, physical iPhones.



## v0.10.0 — gRPC (started 2026-10-11, branch `feature/0.10.0`)
Contract: CONTRACTS §16. Spike: docs/spikes/grpc.md. Owner decision: TLS gRPC with default credentials = metadata only
(undecrypted tunnel); full view for h2c and `flutterIntercept.grpc.decryptHosts`.
| Agent | Owns |
|---|---|
| P proxy | silent tunnels, `http2: 'fallback'`, gRPC relay + upstream sessions, framing / gzip, gRPC rules (`grpcMock`, block, faults, throttle, sequence), self-check, `setGrpcDecryptHosts` — `packages/proxy/**` except `types.ts` |
| D dart entry | template v6 (`IOOverrides` hook, silent CONNECT, breaker), golden tests, demo gRPC screen + test server, device runs — `packages/extension/src/entry/**`, `samples/demo_app/**` (never `ios/Runner.xcodeproj/project.pbxproj`), `scripts/e2e/**`, `test/integration/suite/devices.ts`, docs/spikes/template-v6.md |
| S schema | `.pbgrpc.dart` / `.pb.dart` / `.pbenum.dart` parser, decode / raw decode / encode / skeleton — `packages/extension/src/grpc/**` except `types.ts` |
| H host + agent | settings → proxy, schema service, controller `decodeGrpc` / grpcMock from exchange, agent tools + redaction, HAR export, notify policy — `src/agent/**`, `src/ui/controller.ts`, `src/proxyHost.ts`, `src/export/**`, `src/notify/**`, `test/integration/suite/agent.ts` |
| W webview | gRPC rows, Messages tab, trailers, filter, grpcMock rule form, status banner — `packages/webview/**` except `protocol.ts` |
| lead | contract, types, `extension.ts`, extension `package.json` (settings, languageModelTools), sidecar / plugin / CLI settings, docs, E2E, review |

### v0.10.0 status (2026-10-11)
gRPC in both editors and the CLI: VS Code extension 0.10.0, the Android Studio / IntelliJ plugin 0.10.0 (preview),
CLI `--grpc-decrypt-host` / `--no-grpc` and the action inputs `grpc` / `grpc-decrypt-hosts`. Verified: unit tests
(proxy 477, webview 490, extension 1966, cli 114, sidecar 38, plugin 95); VS Code integration suites on the packaged
VSIX — default 42/42, agent 21/21 (macOS + Android emulator, incl. the gRPC case), devices: every check passed on the
Android emulator, an iOS 26.5 simulator and macOS, incl. the new gRPC case K (K1: calls recorded, a `grpcMock` answers
after a hot restart; K2: `grpc.enabled: false` → direct), web 8/8; `verifyPlugin` Compatible with Android Studio
2026.2. Template v6 validated on Dart 3.0 / 3.3 / 3.13.5 and language versions 2.12 / 3.0 (docs/spikes/template-v6.md).
Independent review: docs/REVIEW-10.md, all findings fixed (CONTRACTS §16.8). End-to-end check of REVIEW-10 #1 on the
Android emulator: with the offline profile the h2c calls got `14 UNAVAILABLE`, and the TLS call was held until its
15 s deadline with no connection reaching the server. Device runs on the busy machine showed the known
`stop_app: Canceled` flake once; reruns alone passed. Not verified: a physical iPhone, connectrpc against a real app,
mTLS on gRPC upstreams, IPv6 targets, Edge.


## v0.11.0 — gRPC parity (started 2026-10-11, branch `feature/0.11.0`)
Contract: CONTRACTS §17. Owner instruction: take every decision in the project's interest.
| Agent | Owns |
|---|---|
| P proxy | message transform, gRPC breakpoints + edits, mutate via the injected codec, gRPC replay, `setGrpcCodec` — `packages/proxy/**` except `types.ts` |
| S schema | `.proto` parser + linking into the shared schema, `source` — `packages/extension/src/grpc/**` except `types.ts`, `service.ts`, `discovery.ts` |
| H host + agents + recordings | codec injection, `resume` with `GrpcEdit`, `decodeGrpc.paused`, `.proto` discovery, recordings v3 / replay / diff, agent tools — `src/agent/**`, `src/ui/controller.ts`, `src/proxyHost.ts`, `src/recordings/**`, `src/grpc/service.ts` + `discovery.ts`, `test/integration/suite/agent.ts` |
| W webview | gRPC pause editor, breakpoint / mutate on gRPC, recordings counts — `packages/webview/**` except `protocol.ts` |
| lead | contract, types, `extension.ts`, sidecar, CLI, docs, E2E, review |

### v0.11.0 status (2026-10-11)
gRPC parity: breakpoints with message / status edits, mutate on response messages (host codec), recordings v3 with
gRPC, same-origin replay and diff, `.proto` files as a schema source. Verified: unit tests (proxy 498, webview 506,
extension 2038, cli 114, sidecar 38, plugin 95), VS Code integration suites on the packaged VSIX — default 42/42, web
8/8, devices 20/20 (iOS 26.5 simulator and macOS, incl. the gRPC case K), agent 12/12 checks on macOS incl. the gRPC
case (breakpoint edit seen by the app, mutate seen, record → replay codes 0/5/0; one run ended with the known
`stop_app: Canceled`), `verifyPlugin` Compatible. Independent review: docs/REVIEW-11.md, all findings fixed. During the
runs the machine lost its internet connection once and the Android emulator hung (adb unresponsive); its agent and
device cases were not rerun for 0.11 (0.10 passed them). Not verified: Android emulator for 0.11, physical iPhone,
connectrpc against a real app, mTLS on gRPC upstreams, IPv6 targets, Edge.


## v0.12.0 — gRPC tools complete (started 2026-10-11, branch `feature/0.12.0`)
Contract: CONTRACTS §18. Owner instruction: take every decision in the project's interest; multi-agent.
| Agent | Owns |
|---|---|
| P proxy | rewrite metadata / trailers, gRPC script hooks, map remote upstream, `send` for gRPC, `grpcApplicable` — `packages/proxy/**` except `types.ts` |
| H host + agents | rule validation + shared-rule approval for gRPC rewrites / scripts / map remote, resend / edit & resend (messagesJson encoding), script template with gRPC hooks, agent tools — `src/agent/**`, `src/ui/controller.ts`, `src/proxyHost.ts`, `src/rules/**`, `src/grpc/service.ts`, their tests, `test/integration/suite/agent.ts` |
| W webview | rewrite trailers fields, scripts / map remote / resend / edit & resend on gRPC rows, notes removed — `packages/webview/**` except `protocol.ts` |
| lead | contract, types, wiring, docs, E2E, review |

### v0.12.0 status (2026-10-11)
gRPC tools complete: rewrite of gRPC metadata and trailers, script hooks `onGrpcMessage` / `onGrpcStatus`, map remote
for gRPC, resend / edit & resend of gRPC calls (rules, the network profile and replay apply). Verified: unit tests (proxy
517, webview 519, extension 2056, cli 114, sidecar 38, plugin 95), VS Code integration suites on the packaged VSIX —
default 42/42, agent 12/12 on macOS incl. the gRPC case (rewrite seen by the app, resend decoded OK), web 8/8, devices
20/20 (iOS 26.5 simulator and macOS); `verifyPlugin` Compatible. Independent review: docs/REVIEW-12.md, all findings
fixed (MED: gRPC relay loops — own listeners and resolved addresses refused; no marker reaches real servers; the
external-forwarder loop stays a documented limit). Not verified: Android emulator for 0.11/0.12, physical iPhone,
connectrpc against a real app, mTLS on gRPC upstreams, IPv6 targets, Edge.


## v0.13.0 — gRPC-Web, grpcurl, iOS simulator trust (started 2026-10-12, branch `feature/0.13.0`)
Contract: CONTRACTS §19. Owner instruction: take every decision in the project's interest; multi-agent.
| Agent | Owns |
|---|---|
| P proxy | gRPC-Web detection, frame / trailer-frame parsing (binary + text), grpcMock / block in gRPC-Web format — `packages/proxy/**` except `types.ts` |
| H host + agents | grpcurl snippet (`src/codegen/**`), agents (`snippet: "grpcurl"`, gRPC-Web in get_request / list / HAR), controller — `src/agent/**`, `src/codegen/**`, `src/ui/controller.ts`, `src/export/**` |
| W webview | gRPC-Web badge, Copy as grpcurl, CORS hints for gRPC-Web — `packages/webview/**` except `protocol.ts` |
| T trust spike | iOS simulator CA trust feasibility — docs/spikes/ios-sim-trust.md (then design + owner) |
| lead | contract, types, wiring, docs, E2E, review |
| T trust (0.13 part 2) | `packages/extension/src/iosSimTrust.ts` + its tests (fake exec / fs), integration check in `test/integration/suite/devices.ts` (iOS simulator only) |

### v0.13.0 status (2026-10-12)
gRPC-Web shown as gRPC (grpcMock / block in gRPC-Web format), Copy as grpcurl, opt-in iOS simulator CA trust with
decrypt-all and learned pin fallback, plus a performance and code-quality pass (docs/PERF-1.md, docs/QUALITY-1.md):
activation no longer loads the proxy, bundle 2.77 → 2.53 MB, gRPC CPU per call −11%, streaming +14%, HTTPS small −25%;
intercept-proxy.ts 6546 → 2115 lines (modules behind ProxyContext), agent api.ts 2584 → 100, controller.ts 2554 →
1182, webview state.ts split; one shared node-free `grpc-meta` module for rules and limits; typecheck in every package's
tests; a protocol drift test (it caught `Status.lan.peer` missing in the webview copy). Verified: unit tests (proxy 541,
webview 540, extension 2103, cli 115, sidecar 38, plugin 95), VS Code integration suites on the packaged VSIX — default
42/42, agent 12/12 on macOS incl. gRPC, web 8/8, devices 20/21 on the iOS 26.5 simulator and macOS incl. the new
simulator-trust check L (CA added, TLS gRPC decrypted, only our row removed at session end; the one failure was
httpbin.org answering HTML for a moment), `verifyPlugin` Compatible. Independent review: docs/REVIEW-13.md (two parts),
all findings fixed. Known limit: once decrypted, a development server with a self-signed certificate fails upstream (the
proxy verifies certificates); a setting for that needs the owner's decision. Not verified: Android emulator for
0.11–0.13, physical iPhone, connectrpc against a real app, mTLS on gRPC upstreams, IPv6 targets, Edge.

## v0.14.0 — Apps with their own certificate (started 2026-10-15, branch `feature/0.14.0`)
Contract: CONTRACTS §20. Owner request: an mTLS app (Dio with a client certificate) must keep working through the
extension (learned passthrough), and the user can add the certificate from the panel to see those requests.
| Agent | Owns |
|---|---|
| P proxy | learned passthrough map (HTTP + gRPC), detection (alerts, probe, nginx 400), `Connection: close`, exclusions, API + event — `packages/proxy/**` except `types.ts` / `index.ts` |
| H host + agents | `createClientCertUi` + VS Code platform, controller messages, Status, agents / HAR, settings / commands — `packages/extension/**` except `src/ui/protocol.ts` |
| W webview | banner on such requests, Add client certificate popup (with the "why / stays on your computer" text), certificates + learned hosts list — `packages/webview/**` except `src/protocol.ts` |
| I plugin | sidecar wiring of `createClientCertUi` (ui-requests), IntelliJ FileChooser / settings / PasswordSafe, Status — `packages/sidecar/**`, `packages/intellij/**` |
| lead | contract, types, wiring, e2e mTLS server + integration check, docs, review |

### v0.14.0 status (2026-10-15)
Apps with their own certificate: a server that asks for the app's client certificate (TLS alert 116, 40 / 42 confirmed
by a TLS 1.2 probe, nginx's 400) is passed through without decryption after one failed request, so the app keeps
working with its own certificate; apps that reject the proxy's certificate on HTTPS are pinned per client for 10
minutes (as gRPC in 0.13). **Add client certificate…** from the request, the status-line list or the palette (VS Code
and Android Studio): native file picker (tokens; the panel never sees a path), passphrase in secret storage /
PasswordSafe, user-level `machine`-scoped setting, removal confirmed by the IDE. Agents see `learnedPassthrough`, can't
touch certificates. Review docs/REVIEW-14.md (two Low-Medium, three Low, all fixed), docs/PERF-2.md (no HTTPS
regression; false pins from spare connections fixed; bundle 2.59 → 2.51 MB, budget 2.55 MB), docs/QUALITY-2.md
(shared `learned-meta` module). The Android devices suite found one regression, fixed before release: no HTTPS pin
learning while an emulator's native clients are routed (§20.6).
Verified: unit tests (proxy 584, webview 567, extension 2147, cli 115, sidecar 50, plugin 106), VS Code integration on
the packaged VSIX — default 42/42, agent 13/13 on macOS incl. gRPC and the new mTLS check (demo Dio app with a client
certificate against `scripts/e2e/mtls_server.mjs`: first call fails once, then 200 with the app's own certificate;
after adding the certificate the calls are decrypted), web 8/8, devices on the iOS 26.5 simulator + macOS 19/21 and
the Android emulator 11/13 (every failure an external host timing out or resetting — jsonplaceholder also timed out
with no proxy at all during the run), `verifyPlugin` Compatible. Not verified: physical iPhone, a real customer mTLS
API, IPv6 targets, nginx 400 on buffered routes.

### v0.14.1 status (2026-10-15)
Owner request after 0.14.0: tell the developer what the server sees, and let automatic passthrough be turned off
(CONTRACTS §20.7). The popup gained *What the server sees*; a learned request says the server may have logged one
refused attempt; `flutterIntercept.autoPassthrough` / the plugin checkbox (default on) — off: no learning, no probe, the
requests keep failing with the reason, **Add client certificate…** still offered through `needsClientCertificate`. The
agent suite's new step found a real bug, fixed: after a certificate was removed, a server could still resume a TLS
session opened with it inside VS Code — a certificate change now retires kept-alive upstream connections and TLS
sessions (HTTP, upstream proxy, LAN, gRPC). Verified: unit tests (proxy 592, webview 574, extension 2155, cli 115,
sidecar 52, plugin 106), VS Code default 42/42, agent 12/12 on macOS incl. the three-step mTLS check (passed through →
decrypted with the added certificate → setting off: every call fails with the reason; the test server logged a fresh,
unauthenticated session after removal), `verifyPlugin` Compatible.

## v0.15.0 — Mock from a collection (planned 2026-11-19; WP0 done 2026-11-19)
Contract: CONTRACTS §21. Owner request: a developer with no test server imports a Postman collection (or an OpenAPI
3 document) and every request in it is answered from its saved examples. No proxy change: the host turns a
collection into `mock` rules.

WP0 (lead, before the owners start): the types in code (`src/mocks/types.ts`, both `protocol.ts`), the `collections`
key in `rules/file.ts`' reader / writer, two fixture collections (Postman v2.1 with folders, variables, several
examples; OpenAPI 3.1 with `$ref`s and no examples), the YAML bundle check (§21.3), the host-case check (§21.5).

| Agent | Owns |
|---|---|
| M1 Postman | `src/mocks/postman.ts`, `environment.ts`, `sanitise.ts` + tests — pure (§21.1, §21.2, §21.6 sanitise) |
| M2 OpenAPI | `src/mocks/openapi.ts`, `generate.ts` (+ YAML loading if WP0 allows it) + tests — pure (§21.3, §21.4) |
| M3 rules | `src/mocks/toRules.ts` + tests, incl. a fuzz test of the regex builder — pure (§21.5) |
| H host + agents | `src/mocks/core.ts`, `service.ts`, controller messages, command + `package.json` contributions, `agent/tools/collections.ts`, schema, instructions — `packages/extension/**` except `src/mocks/{postman,environment,sanitise,openapi,generate,toRules,types}.ts` and `src/ui/protocol.ts` |
| W webview | Collections section, endpoint list, example picker, 501 banner, empty state — `packages/webview/**` except `src/protocol.ts` |
| I plugin + CLI | sidecar wiring, IntelliJ file chooser / confirmations, CLI flags — `packages/sidecar/**`, `packages/intellij/**`, `packages/cli/**` |
| lead | contract, WP0, wiring, demo screen + e2e (the demo app against a collection with **no** server running), README tutorial, REVIEW-15, PERF-3 |

Order: WP0 → M1, M2, M3, W in parallel (M3 and W work from the fixtures and types) → H → I → lead's e2e, review,
performance. M1–M3 and W touch no file outside their own list.

Acceptance:
- The demo app, with its API host unreachable, shows real screens from the fixture collection on the Android
  emulator, the iOS simulator and macOS; switching `POST /login` to the "Wrong password" example changes what the
  app shows after a hot restart, from the panel and from an agent.
- A request with no example gets the 501 and the banner; an endpoint that isn't in the collection reaches the real
  server, and fails once the collection is switched to `fail`.
- Editing the collection file updates the answers without a restart; a teammate's personal "off" leaves the shared
  file untouched.
- An OpenAPI document with no examples gives bodies the app's generated models parse (checked with §10's contract
  check on the demo models).
- The environment file's values appear nowhere in the panel's messages, agent results, logs or exports (test).

### v0.15.0 WP0 status (2026-11-19)
Done (CONTRACTS §21.13): types, link parsing / writing, protocol types with placeholders, fixtures with the expected
parser output. The contract's regex was corrected (the first draft would have been refused by the proxy's
`isSafeRegexSource`). Owner decision: YAML supported (`js-yaml` 4.3.2, lazy, `src/mocks/yaml.ts`), bundle budget
raised on purpose to 2.65 MB until PERF-3 measures it. Verified: unit tests (extension 2179, webview 574),
typecheck of extension, webview, sidecar and CLI. M1, M2, M3 and W can start.

### v0.15.0 M3 status (2026-11-19, lead)
`src/mocks/toRules.ts` + `test/unit/mocks.toRules.test.ts` (34 tests: both fixtures through the real proxy matcher,
`validateRule` on every rule, query examples, selection fallback, off / fail, hostile segments, glob fallback, a
deterministic fuzz of 600 endpoints and a timing check). A one-off fuzz of 90 000 random endpoints: 0 unsafe or
invalid regexes, 0 missed matches, worst 0.53 ms per lookup. Found by the fuzz and fixed in the contract (§21.5):
clients percent-encode different characters, so special characters in literals match either form.

### v0.15.0 H status (2026-11-19, lead)
Host, controller, command, agent tools and parser wiring done (CONTRACTS §21.14). Tests: `mocks.core.test.ts` (27),
`controller.v0150.test.ts` (15, incl. the three §21.8 decisions), `agent/api.v0150.test.ts` (11); MCP / instructions
expectations updated. Verified: extension typecheck and 2266 unit tests (M1/M2 test files excluded while they're in
progress), sidecar 52, CLI typecheck, bundle smoke (47 MCP tools). Budget raised to 2.70 MB (measured 2.66 MB).
Not done here: unit tests of the VS Code layer `src/mocks/service.ts` (dialogs, watchers) — covered by the e2e step;
the sidecar / plugin / CLI wiring is owner I's.

### v0.15.0 status after M1, M2, W, H (2026-11-19)
- M1 (Postman) and M2 (OpenAPI) done after one review round each: M1's sanitised copy kept request-body passwords
  (contract gap, §21.6 now covers request bodies); M2 crashed on a 50 000-deep `allOf` / `oneOf` / `anyOf` chain
  (every step down now counts toward the depth limit). Both re-checked with the lead's hostile inputs.
- W (panel) done with the three §21.8 decisions. H (host + agents) done: core, VS Code service, proxy order,
  controller and handlers, command, five agent tools (§21.14). Bundle 2 661 835 bytes; budget raised to 2.70 MB until
  PERF-3 (js-yaml's unused writer, ~10 KB, can be aliased out).
- Verified: extension 2322 tests, webview 599, protocol drift, bundle smoke (47 agent tools).
- Next: I (sidecar + plugin + CLI), then the lead's e2e on devices, REVIEW-15, PERF-3, README tutorial.

### v0.15.0 PERF-3 (2026-11-19, lead)
docs/PERF-3.md: +0.034 ms per request at 500 endpoints (budget 0.05: met), linear (+0.125 ms at 2 000); parsing the
largest allowed collection ≈ 27 ms + 8 ms rules + 5 ms compile; js-yaml's writer removed from the bundle (shim checked
by the bundle smoke test); bundle 2 652 908 bytes, budget lowered to 2 675 000; activation +2.9 ms.

### v0.15.0 I status and REVIEW-15 (2026-11-19)
- I (sidecar + plugin + CLI) done: sidecar 60 tests, CLI 122, plugin 111 (fresh run on Android Studio's JBR 25:
  `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew test --rerun --offline`).
  `verifyPlugin` not run yet (release step).
- REVIEW-15 (docs/REVIEW-15.md): 2 MED, 4 LOW-MED, 1 LOW, INFO. #3 fixed by the lead (no glob fallback, whole-literal
  encodings, plain hosts / methods only). #1 / #4 redesigned for UX in §21.16 (limited answers until one approval
  per collection). M1 / M2 fix rounds briefed (`.vscode/agent-tasks/m1-fix-review15.md`, `m2-fix-review15.md`).

### v0.15.0 status after REVIEW-15 fixes (2026-11-19)
Every REVIEW-15 finding fixed (docs/REVIEW-15.md "Fixes"). §21.15 (agent-friendly) and §21.16 (limited answers until one
approval, UX-first) built; W2 (panel) done by the lead. Verified: extension 2361,
webview 614, sidecar 60, CLI 122, plugin 111 (JBR 25), bundle 2 678 420 / 2 700 000, smoke incl. YAML. Left before
release: run the integration suites (default, agent incl. the new collection step, devices), the real Claude Code run,
README tutorial + changelog, version bump, `verifyPlugin`.

### v0.15.0 release verification (2026-11-20)
README tutorials, changelogs and the 0.15.0 bump done. On the packaged VSIX: default 42/42; agent 12/12 incl. the
collection step (import, example by request id, reset, `seen`, no diff in the team file); devices 30/30 — Android
emulator (emulator-5554), iOS 27.0 simulator (iPhone 18 Pro) and macOS; real Claude Code 2/2 (mock task $0.27, the new
collection task $0.32: 200 from the collection, 404 after switching the example, nothing written to the team file);
`verifyPlugin` Compatible with AI-262. Found and fixed during the runs:
- `stop_app: Canceled` (the flake noted since 0.10) failed both Claude runs: VS Code rejects `stopDebugging` when the
  session ends while being stopped. `launch.ts` now treats the rejection as an error only if the session didn't end
  (two unit tests); extension 2363 tests. Claude and agent suites rerun on the fixed VSIX.
- The demo app needed AGP 9.1.1 (the installed Flutter refuses 9.1.0), so every Android case timed out;
  `samples/demo_app/android/settings.gradle.kts` bumped.
- The iOS simulator's CoreSimulator service hung (`simctl terminate` never returned, ~8 h); restarting the service fixed
  it. Harness gap, not a product bug: the devices suite waits 10 minutes per case when the app can't build or the
  simulator hangs — worth a fail-fast check.
- `verifyPlugin` needs network once to fetch the Plugin Verifier (`--offline` fails).
Not verified: physical iPhone / Android device, Cursor and other editors for 0.15.


## v0.16.0 — Stateful mocks: a fake backend that remembers (planned 2026-11-20)

Owner request: after 0.15.0 the app's create → list flows still fail (a collection answers fixed examples). The
collection's REST resources remember what the app sends. Owner decisions: resources detected automatically and
editable; data in memory, seeded from the examples, Reset; optional named snapshots in the repo. Contract:
docs/CONTRACTS.md §22 (the only proxy change is the `handler` action, §22.1).

| WP | Owner area (disjoint files) | Contract | Depends on |
|---|---|---|---|
| WP0 (lead, done) | research (4 parallel agents, §22.12); CONTRACTS §22; types: proxy `types.ts` (`handler`, `HandlerRequest/Response`, `RequestHandler`, `setHandler` stub), `mocks/types.ts` (`SchemaHints`, `Resource`, `StoreLink`, `StoreSnapshot`, `STORE_LIMITS`), both `protocol.ts` (`StoreStatus`, `StorePatch`, messages), stubs in `ui/handlers.ts`, webview `host.ts` / `hostMsg.ts` / `rules.ts` / `ruleForm.ts` | §22 | — |
| P — proxy | `packages/proxy/**` except `types.ts` / `index.ts` | §22.1 | WP0 |
| S — store core | `extension/src/mocks/{resources,store,snapshot}.ts` (new), `mocks/openapi.ts` (`schemaHints`), their tests | §22.2–§22.5, §22.8 format | WP0 |
| W — panel | `packages/webview/**` except `protocol.ts` | §22.10, §22.11 panel | WP0 |
| H — host | `mocks/{core,toRules,service,link}.ts`, `rules/{core,file,service}.ts`, `proxyHost.ts`, `ui/{controller,handlers,validate}.ts`, `extension.ts` | §22.6, §22.7, §22.9 | P, S |
| A — agents | `agent/**`, `package.json` (`languageModelTools`), `test/bundle/smoke.ts`, integration `suite/agent.ts`, `suite/claude.ts` | §22.11 agents | H |
| C — CLI + plugin | `packages/cli/**`, `packages/sidecar/**`, `packages/intellij/**` | §22.11 CLI / plugin | H |
| Lead | REVIEW-16 (independent), PERF-4, devices e2e, README tutorial, changelog, version | §22.13 | all |

Scope change (owner, 2026-11-20): 0.16.0 also ships part 2 (Record → Mock, drift detection; CONTRACTS §23) and part 3
(auth simulation, example by request body, dynamic values, Swagger 2.0 / Insomnia / Bruno, proxy index for big
collections; CONTRACTS §24), plus the devices-suite fail-fast fix. Not planned: physical iPhones in CI (risk). Parts
are built in order (they share `src/mocks/**`), released together: one REVIEW-16, one PERF-4, one device run.

### v0.16.0 status (2026-11-20, in progress)
- Done: WP0 (CONTRACTS §22), P (proxy `handler`, 610 proxy tests), S (detection, store, snapshots; extension 2416
  tests at that point), W (panel Data view; webview 656 tests), T (device suite fails fast: `suite/deviceGuard.ts`,
  bounded start / stop in `suite/helpers.ts`; the 8-hour hang was flutter's `simctl terminate` with no timeout behind
  an awaited `stopDebugging`). Contracts for part 2 (§23) and part 3 (§24) written; auth simulation in its light form
  only (owner decision).
- Running: H (host), A (agents), C (CLI + sidecar), E (rule index + quiet fallback), D (Swagger 2 / Insomnia / Bruno
  parsers), V (dynamic values, body match, light auth).
- Next: wire part 3 into the host, build part 2 (after H), REVIEW-16, PERF-4, device run, README, changelog, version.

### v0.16.0 — plan for what is left (2026-11-20)

Built so far: part 1 complete (P, S, W, H, A, C, T); part 3 modules (V: dynamic values, body match, light auth; D:
Swagger 2.0 / Insomnia / Bruno readers; E: proxy rule index + quiet fallback). Protocol types for parts 2 and 3 are
in both `protocol.ts` copies. Steps below run in this order; steps in the same row group run in parallel (disjoint
files).

| # | Step | Owner area | Depends on | Done when |
|---|---|---|---|---|
| 1a | **R2** part 2 modules: `fromTraffic.ts`, `drift.ts`, `splice.ts` | new files in `extension/src/mocks` | — (running) | its unit tests; output parses through `parsePostman` |
| 1b | **X3** part 3 host wiring: new sources load, answer pipeline (auth → query → body → store → default → dynamic → limit), settings, agent tools (`set_store.auth`, `expire_token`) | `extension/src/mocks/{core,toRules,service,link,limit,detect,parsers}.ts`, `ui/*`, `agent/**` | V, D, E (running) | extension unit tests, bundle smoke, sidecar + CLI tests |
| 1c | **W23** panel for parts 2 and 3 | `packages/webview` | protocol types (running) | webview tests, drift test |
| 1d | **E2** path trie in the rule index (same-host misses: 0.085 ms → target ≤ 0.01 ms at 2 500 rules) | `packages/proxy` | E | the property test (indexed = linear) extended to the trie; suite green in both modes; bench |
| 2 | **X2** part 2 host wiring: `mockFromTraffic` (IDE dialogs, copy-in, link), drift tracker on real traffic, Update example (diff preview, hash check, splice), agent tools `mock_from_traffic`, `update_collection_example` (52 tools) | same host files as X3 | R2, X3 | unit tests; no secret or personal value in a generated file (planted-values test) |
| 3 | **C23** CLI + sidecar + plugin for parts 2 and 3: `--record-collection`, `--collection-seed`, new formats, Bruno folder chooser, auth / drift through the shared core | `packages/cli`, `packages/sidecar`, `packages/intellij` | X2, X3 | CLI / sidecar tests; plugin tests (JBR 25) |
| 4 | Demo app: `GET /todos` in the batch (so the suites see a list answered by the store), a login + refresh call for the auth check | `samples/demo_app` (lead) | — | `flutter analyze`, builds on Android / iOS / macOS |
| 5a | **REVIEW-16** independent security review: `handler` action, store + snapshots, light auth, Record → Mock sanitising, Update example writes, the three new readers, agent outputs | read-only reviewer | 2, 3 | docs/REVIEW-16.md |
| 5b | **PERF-4**: rule index + trie, store hit cost, drift per exchange, parsing the new formats, activation, final bundle budget (measured + 20 KB) | lead | 2, 3 | docs/PERF-4.md, `build.mjs` budget |
| 6 | Fix every REVIEW-16 / PERF-4 finding (fix rounds per owner area) | per finding | 5 | "Fixes" table in REVIEW-16 |
| 7 | Integration on the packaged VSIX: default suite, agent suite (v0.16.0 steps), devices (Android emulator, iOS simulator, macOS — with the fail-fast guard), `verifyPlugin`; screenshots of the new panel states (dark / light / high contrast) | lead | 6 | all green; evidence in the session scratchpad |
| 8 | Real Claude Code run, 3 tasks (mock, collection, store) — **costs credit: ask the owner first** | lead | 7 | 3/3 |
| 9 | README tutorials (remembered data, fake backend from a session, out-of-date collection, sign-in, new sources), changelogs (extension, plugin, CLI), ROADMAP / PLAN status, version 0.16.0 in every package | lead | 7 | docs review |
| 10 | Commit (repo author, no attribution, `project.pbxproj` left out), then **ask the owner** before push and before publishing (VS Code Marketplace, JetBrains, Open VSX — owner tokens) | lead + owner | 8, 9 | — |

Steps 3 and 4 have ready briefs for a second coding agent (local, not committed): the demo app can start at any
time; step 3 only after steps 1b and 2. Security-sensitive steps (2, 5a, 6) and all verification stay with the lead.

Out of 0.16.0: physical iPhones in CI (risk), auth that checks passwords (risk), Bruno OpenCollection YAML,
sanitised copies of Swagger / Insomnia files from outside the project.
Not verified by this plan: a physical iPhone / Android device, Cursor and other editors.

- Step 4 done (2026-11-20, second coding agent, reviewed by the lead): the demo batch ends with `GET /todos`
  (`DEMO_RESULT todos_list status=… count=…`), and `--dart-define=FI_DEMO_AUTH=1` adds a sign-in round (`auth_login`,
  `auth_get`, `auth_refresh`, `auth_get2`; no token or password logged); panel buttons for both. `flutter analyze`: only
  the 3 existing infos; 15 new Dart unit tests; `flutter build macos --debug` builds. No suite counts requests exactly,
  so the extra `GET /todos` doesn't change existing checks.

### v0.16.0 status (2026-11-20, before the verification run)
- All parts built and wired (extension, webview, proxy, CLI, sidecar, plugin); REVIEW-16 15/15 fixed (docs/REVIEW-16.md
  "Fixes"); PERF-4 done (docs/PERF-4.md; budget 2 990 000, measured 2 965 016); versions 0.16.0 (extension, CLI,
  sidecar, plugin); README tutorials / changelogs drafted by the second coding agent and checked by the lead against
  the code (CLI flags, plugin settings, size line; every internal anchor resolves).
- Unit tests: extension ~2 830, proxy 637, webview 726, CLI 144, sidecar 72, plugin 113 (JBR 25) — all passing.
- Running: default + agent suites on the packaged VSIX, devices (Android emulator, iOS 27 simulator, macOS) with the
  fail-fast guard, real Claude Code (mock, collection, store), `verifyPlugin`.

### v0.16.0 release verification (2026-11-20)
On the packaged VSIX: default 42/42; agent 13/13 (incl. the v0.16.0 store step: the app's POST remembered, get_store,
set_store, generate, shape, reset, snapshots, read-only; and the app's own `GET /todos` after emptying holds only the
record it created next); devices — Android emulator and iOS 27 simulator every case, macOS 10/10 (run alone; in the
combined run its screenshot case timed out on the VM service while the emulator and the simulator were still up —
machine load, passed alone twice); real Claude Code 3/3 (mock $0.69, collection $0.38, store $0.38; the store task
needed a rerun after the fix below); `verifyPlugin` Compatible with AI-262. Found and fixed during the runs:
- `hot_restart` waited on Dart-Code with no limit (the real Claude store task hung 300 s on macOS): now 60 s with a
  clear error (`launch.ts`, unit test).
- The agent suite's v0.16.0 step resent a request the collection had answered (the tool refuses that by design):
  it now reads the demo app's own `GET /todos`.
- A REVIEW-16 #2 timing test (200 ms for 5 MB) failed once under load: bound 1 s (the quadratic version took 45 s).
- The first combined run lost the network for a moment (`verifyPlugin`: "Network is unreachable"; iOS sources missing):
  the rerun on a stable network passed.
Screenshots: `media/screenshots/remembered-data-dark.png`, `out-of-date-dark.png` (README tutorials); the Collections
tab's subtitle now names every source. Not verified: a physical iPhone / Android device, Cursor and other editors.
