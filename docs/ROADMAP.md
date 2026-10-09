# Flutter Intercept — Roadmap

Status: 0.2.0 published (2026-10-09). This roadmap is built from three research passes done on
2026-10-09: competitors, Flutter developers' pain points (with demand numbers), and AI-agent needs plus a
feasibility read of this repo. Sources are linked inline and collected at the end.

## 1. Where we stand

**What only Flutter Intercept does today**
- Zero-code interception, including a **real iPhone with no CA install, system proxy or VPN**. Every proxy
  tool needs a certificate or a VPN; Proxyman's zero-code Flutter capture covers the Android emulator only.
- **The agent drives the whole loop**: launch the app → mock/fault → hot restart → wait for the request →
  check it. Proxyman's MCP server ([docs](https://docs.proxyman.com/mcp)) can create rules but cannot launch or
  restart the app.
- Mocking, editing and breakpoints inside the editor. DevTools' Network tab is read-only.

**What changed around us (don't build on stale assumptions)**
- Proxyman ships an MCP server for Claude Code / Codex / Cursor (~20 tools) and an agent skill → an
  agent API alone is no longer a differentiator.
- DevTools now has HAR export, Copy as cURL, WebSocket recording and native clients through
  `http_profile` ([docs](https://docs.flutter.dev/tools/devtools/network)) — still read-only.
- MCP 2026-07-28 deprecates Sampling, Roots and Logging, replaces `resources/subscribe` with
  `subscriptions/listen`, and moves elicitation to the input_required/retry pattern
  ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). Don't build on sampling.

**Our moat going forward:** code awareness (we run inside the app *and* inside the editor) + the agent
loop + zero-code on every device.

## 2. Evidence: what Flutter developers struggle with

| Pain | Demand signal | Status |
|---|---|---|
| Proxy / certificate setup | [SO 54285172](https://stackoverflow.com/q/54285172) 320K views; [flutter#26359](https://github.com/flutter/flutter/issues/26359) +67 open since 2019; proxy packages ≈48K downloads/mo | ✅ solved (core pitch) |
| JSON ↔ model crashes ("Null is not a subtype…") | SO 247K + 87K + 54K + 39K + 30K + 25K views; json_serializable 3.8M/mo, freezed 2.8M/mo | ❌ **no tool owns it** |
| Testing error / offline / slow states | "Failed host lookup" 321K views; [devtools#4139](https://github.com/flutter/devtools/issues/4139), [#4140](https://github.com/flutter/devtools/issues/4140) open; mocktail 3.6M/mo, http_mock_adapter 311K/mo | 🟡 mock + pause ship; no faults/profiles |
| Flutter Web CORS / XMLHttpRequest errors | SO 130K + 101K + 74K views; [flutter#46904](https://github.com/flutter/flutter/issues/46904) +49; DevTools doesn't cover web | ❌ gap |
| DevTools Network unreliable | [#368](https://github.com/flutter/devtools/issues/368) +125, [#1952](https://github.com/flutter/devtools/issues/1952) +54, regressions [#9203](https://github.com/flutter/devtools/issues/9203) (58 comments); open: body search [#7624](https://github.com/flutter/devtools/issues/7624), request origin [#7807](https://github.com/flutter/devtools/issues/7807) | 🟡 always-on capture beats it; no search / origin |
| Auth token refresh debugging | [SO 56740793](https://stackoverflow.com/q/56740793) 112K views; [dio#50](https://github.com/cfug/dio/issues/50) +28, [dio#590](https://github.com/cfug/dio/issues/590) +28 | ❌ |
| WebSocket / SSE / gRPC | [devtools#2044](https://github.com/flutter/devtools/issues/2044) gRPC +26 (most-voted open Network request); web_socket_channel 11.4M/mo | ❌ gap |
| Emulator → localhost, macOS entitlement, cleartext | SO 263K, 63K, 19K views | ❌ easy win |
| In-app inspectors that need code | pretty_dio_logger 320K/mo, talker_dio_logger 168K, alice 33K, chucker_flutter 21K… ≈575K/mo | the audience a zero-code tool converts |

## 3. How features are ranked

Score = **demand** (evidence above) × **uniqueness** (does a competitor already do it?) ÷ **effort**, with a
bonus when a feature also makes agents better. Feasibility comes from reading this repo, the Dart SDK,
flutter_tools and mockttp 4.6.3.

## 4. Releases

### 0.3.0 — "Where did this come from?" (source-aware + daily-driver parity)
| Feature | Why | Effort | Notes |
|---|---|---|---|
| **Request → source line** ⭐ unique | DevTools [#7807](https://github.com/flutter/devtools/issues/7807) open; no proxy tool can do it | M | Capture `StackTrace.current` in the entry's `_InterceptedHttpClient.open/openUrl`; tag the request with `x-fi-id` (stripped by the proxy via `transformRequest.updateHeaders`); ship frames out of band to `http://trace.flutter-intercept.invalid/` through the proxy (never resolves on DIRECT); map `package:` URIs via `.dart_tool/package_config.json`; pick the first frame outside dio/http/flutter. Spike: Dio's async gaps. Agent tool `get_request_source`. |
| **Copy as cURL / code snippet** | most common competitor feature; DevTools [#3042](https://github.com/flutter/devtools/issues/3042) +12 | S | From the HAR entry we already build; targets cURL, Dart http, Dio. Always the redacted view for agents. |
| **Edit & resend / repeat** | Proxyman, Charles, HTTP Toolkit, Fiddler, Flutter Net Inspector all have it | M | Send from the extension through mockttp so it lands in the list. |
| **Body search + filter language** | DevTools [#7624](https://github.com/flutter/devtools/issues/7624); Alice, HTTP Toolkit | S | DevTools-style `m:` `s:` `t:` + `body:` text search; webview only. |
| **Faults + network profiles** | DevTools [#4139](https://github.com/flutter/devtools/issues/4139); SO 321K "Failed host lookup" | S-M | New RuleAction `throttle {latencyMs, kbps?, dropRate?}` + `fault {reset|timeout|truncate|dns}`; global profiles Offline / Slow 3G / Flaky N%, scoped to this app (unlike Network Link Conditioner). Bandwidth needs a throttling Transform in `taps.ts`. Agent tool `simulate_network`. |
| **localhost rewrite** | SO 263K "Connection refused" | S | The proxy maps the app's `localhost`/`127.0.0.1` to the host machine (no `10.0.2.2` hacks). |
| **Agent ergonomics** | Claude Code caps tool output at 25k tokens ([docs](https://code.claude.com/docs/en/mcp)) | S | `get_body_shape` (JSON shape in ~300 tokens), `times` / `ttlMs` on `add_mock` (no forgotten cleanup), correct `idempotentHint` / `openWorldHint`. |

### 0.4.0 — "Your models vs the real API" (contract + codegen) ⭐ biggest unique bet
| Feature | Why | Effort | Notes |
|---|---|---|---|
| **Contract check against Dart models** ⭐ | ~480K SO views across the "is not a subtype" family; no tool owns it | M | **Parse `*.g.dart`, not the model**: `_$UserFromJson` is the exact wire contract (renamed keys, `as String?` nullability, nested `fromJson`, `$enumDecode`); freezed delegates to it. Regex / tree-sitter-dart (wasm) is enough. Map request → model by Retrofit/Chopper annotations, then the 0.3 stack trace, then a saved user choice. Diagnostics on the model field: "`avatar_url` is null in GET /users/42 → TypeError". New `src/contract/`. Agent tool `check_contract`. |
| **Null-ify / mutate a field** | reproduces those crashes on demand | S | Rule that nulls or retypes one JSON path in a real response. |
| **Generate Dart models from responses** | json_serializable/freezed user base | S | Merge every sample of a route template to infer optionality; emit freezed or json_serializable to match pubspec. |
| **Generate test fixtures from traffic** | mocktail 3.6M/mo, http_mock_adapter 311K/mo | S-M | `src/codegen/`: http_mock_adapter / `package:http/testing` MockClient / mocktail of the Retrofit interface; JSON under `test/fixtures/`; redacted always. Agent tool `generate_fixture_test`. |
| **MCP resources + prompts** | Claude Code `@`-mentions and `/` prompts | S-M | `intercept://exchange/{id}`, `intercept://paused`; prompts `debug-failing-request`, `test-error-states`, `verify-change`, `build-api-layer-from-traffic`; push via `subscriptions/listen`. |
| **`assert_traffic`** | replaces "read and eyeball" steps (Playwright's verify tools) | S | `{match, expect:{status,count,order,jsonPath,maxDurationMs}, withinMs}` → pass/fail + diff. |

### 0.5.0 — Coverage
| Feature | Why | Effort | Notes |
|---|---|---|---|
| **Flutter Web** | SO 300K+ views; DevTools doesn't cover it | M | No CDP needed: add `--web-browser-flag=--proxy-server=127.0.0.1:<port>` and `--ignore-certificate-errors-spki-list=<CA SPKI>` in `debug/rewrite.ts` (flutter_tools passes browser flags to its temp-profile Chrome). Proxy must answer CORS preflights for mocks. **CORS diagnoser** + dev-only "add CORS headers" rule. |
| **WebSocket + SSE recording** | web_socket_channel 11.4M/mo; LLM-streaming apps | M | Replace `forAnyWebSocket().thenPassThrough` with recording via mockttp `websocket-message-*` events (`frames[]` on Exchange, capped); SSE via `response-body-data` on `text/event-stream`. Changes CONTRACTS §3. |
| **GraphQL awareness** | Proxyman, Requestly, requests_inspector | S | Show `operationName`; match rules by operation. |
| **Native clients** (cupertino_http, cronet_http ≈570K/mo) | DevTools is ahead here | M | Read-only via `http_profile` over the VM service, and/or set the OS proxy automatically (Android emulator `settings put global http_proxy`). |
| **Background isolates** | [devtools#7019](https://github.com/flutter/devtools/issues/7019) | L (spike) | Confirmed not covered (HttpOverrides is per isolate). Path to spike: DDS `requirePermissionToResume(onPauseStart)` + `evaluate` the override in new isolates (debug only). Quick win now: warn on `IsolateStart`. |

### 0.6.0 — Teams & scenarios
- **Rules in the repo**: `.vscode/flutter-intercept.json`, shared through git; **file-backed Map Local**
  (mock body = a workspace file edited in a normal tab).
- **Scenarios & sequences**: "first call 500, then 200", **Expire token** (force 401 on next N calls),
  refresh-stampede warning, request → refresh → retry timeline.
- **Record → replay as mocks** (offline / demo mode) and **diff two flows / two recordings**
  (`vscode.diff`; agent tool `diff_recordings`).
- **Map Remote / header & body rewrite**, **upstream proxy chaining** (keep Charles / Burp in the loop).

### Later / considered
JS scripting hooks (Proxyman/mitmproxy style), timing waterfall, `take_screenshot` linked to exchanges,
headless/CI mode for `integration_test`, Postman / OpenAPI export, error notifications, Windsurf.
**Ops (not code):** publish on Open VSX (Cursor users can't install today).

## 5. Spikes and decisions before building
- Dio's async stack depth for request → source (0.3).
- `http_profile` over the VM service vs OS proxy for native clients (0.5).
- Dart-Code pausing spawned isolates on start; DAP names `dart.debuggerUris`, `callService` (0.5).
- CONTRACTS §3 changes: throttle/fault actions (0.3), WebSocket/SSE frames (0.5).
- Keep the entry dart:io-only (§1): the `.invalid`-host side channel avoids adding `dart:developer`.

## 6. Detailed plan — 0.3.0
Same way of working as 0.1/0.2: contracts first, then parallel owners with disjoint files; every feature
lands with unit tests and an agent-tool test; device E2E on Android emulator + iOS simulator + macOS;
one real Claude Code run at the end.

| Work package | Owner area | Contract change | Acceptance |
|---|---|---|---|
| WP1 Request → source | generator.ts (entry), proxy header strip + trace sink, webview "Open source", agent `get_request_source` | §1 template v4 (trace side channel), §3 `Exchange.source?` | Clicking a Dio and an http request opens the right `lib/` line on Android + iOS sim; header never reaches upstream; DIRECT leaks only an opaque id |
| WP2 cURL + snippets | extension codegen + webview menu + agent field | — | Copy as cURL reproduces the request (minus redacted secrets) |
| WP3 Edit & resend | proxy `send()`, webview composer | §3 `InterceptProxy.send()` | Resent request appears in the list, editable method/url/headers/body |
| WP4 Search & filters | webview only | — | `m:POST s:5xx body:"token"` works on 1000 exchanges < 50 ms |
| WP5 Faults + profiles | proxy actions + webview + agent `simulate_network` | §3 `throttle`, `fault` actions | Offline / Slow 3G / Flaky verified from the demo app; per-app only |
| WP6 localhost rewrite | proxy | §3 option | App calling `http://localhost:8080` on the emulator reaches the host's server |
| WP7 Agent ergonomics | agent core + MCP | §8 additions | `get_body_shape` < 1k tokens on a 1 MB body; `times`/`ttlMs` rules expire |

## Sources
Competitors: [Proxyman MCP](https://docs.proxyman.com/mcp) · [Proxyman Flutter](https://docs.proxyman.com/debug-devices/flutter) ·
[Proxyman emulator capture](https://proxyman.com/posts/Capture-https-flutter-android-emulator) ·
[Charles tools](https://www.charlesproxy.com/documentation/tools/) · [HTTP Toolkit](https://httptoolkit.com/docs/reference/view-page/) ·
[Requestly](https://requestly.com/products/web-debugger/) · [Fiddler Everywhere](https://www.telerik.com/fiddler/fiddler-everywhere) ·
[mitmproxy](https://docs.mitmproxy.org/stable/overview/features/) · [Mockoon](https://mockoon.com/features/) · [WireMock](https://wiremock.org/docs/) ·
[RocketSim](https://www.rocketsim.app/) · [Android Studio Network Inspector](https://developer.android.com/studio/debug/network-profiler) ·
[DevTools Network](https://docs.flutter.dev/tools/devtools/network) · [DevTools 2.38](https://docs.flutter.dev/tools/devtools/release-notes/release-notes-2.38.0).
Agents: [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) ·
[Chrome DevTools MCP tools](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md) · [Playwright MCP](https://playwright.dev/mcp/introduction) ·
[Dart MCP server](https://github.com/dart-lang/ai/tree/main/pkgs/dart_mcp_server).
Pain points: Stack Overflow and GitHub issue links inline in §2 (numbers pulled 2026-10-09).
