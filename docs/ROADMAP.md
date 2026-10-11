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
| WebSocket / SSE / gRPC | [devtools#2044](https://github.com/flutter/devtools/issues/2044) gRPC +26 (most-voted open Network request); web_socket_channel 11.4M/mo | ✅ WebSocket / SSE (0.5); ✅ gRPC (0.10, grpc-dart): full view for h2c and decrypt hosts, TLS by default metadata only |
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

### 0.7.0 — Later / considered (built 2026-10-10, CONTRACTS §13)
JS scripting hooks (Proxyman/mitmproxy style), timing waterfall, `take_screenshot` linked to exchanges,
headless/CI mode for `integration_test` (`packages/cli`), Postman / OpenAPI export, error notifications, Windsurf,
the panel in its own window, and background-isolate **interception** (0.5.0 shipped the warning only).
**Ops (not code):** publish on Open VSX (Cursor users can't install today) — packaging ready, the owner publishes.

### 0.8.0 — Next / considered (built 2026-10-10, CONTRACTS §14, docs/REVIEW-8.md)
Built in **0.8.0** (except: CLI not published to npm — owner; iOS-simulator native routing, profile-mode isolates and
`spawnUri` — documented as not feasible without app or Mac changes; Android Studio — later). Originally proposed: the GitHub Action, mockable native clients, WebSocket/SSE in recordings, and the small items
below. Same way of working: contract first, parallel owners, independent security review, README tutorials.

| Item | Why / today | Effort | Notes |
|---|---|---|---|
| **CLI on npm** | `npx flutter-intercept test` instead of `node packages/cli/dist/cli.js` | S | Owner decision (publishing). Package name, `bin`, README. |
| **GitHub Action** | CI users want one step, not a script | S | Wraps the CLI: caches the runner, uploads HAR / JUnit / recording as artifacts, fails on assertions. macOS + Android emulator examples. |
| **Physical iPhones in CI mode** | the CLI refuses them (LAN mode is editor-only) | M | Reuse the LAN listener + token + device lock outside VS Code; security review. |
| **Native clients: mock / block** | `cupertino_http` / `cronet_http` are listed read-only | L (spike) | Set the OS / emulator proxy for the app (Android `settings put global http_proxy`, iOS simulator proxy via the Mac) and trust the CA natively, or a package-level hook; debug only. |
| **WebSocket / SSE in recordings** | recordings keep finished HTTP only | M | Store frames, replay as a scripted server (timed frames), diff frame counts. |
| **Background isolates in profile mode / `Isolate.spawnUri`** | warning only today | M (spike) | No pause-at-start in profile; spawnUri runs another program without our entry. |
| **mTLS (client certificates)** | the proxy can't present the app's client certificate | M | User-supplied cert/key per host (user settings / secret storage), presented upstream. |
| **Dio `validateCertificate` pinning** | those requests fail while intercepting | S–M | Document a debug-only switch, or pin the proxy's leaf per host for the session. |
| **Flutter Web: DIRECT fallback, `web-server` device** | no fallback; web-server can't be intercepted | M (spike) | A service-worker or PAC-based route; or instructions for a manually started browser. |
| **Throttle uploads and WebSocket messages** | throttling only slows downloads | S–M | Throttling transform on the request stream and on frames. |
| **Screenshots on physical iPhones and the web** | need the debug connection there | S | `idevicescreenshot` when available; Chrome DevTools protocol for web sessions. |
| **Apps with their own `HttpOverrides` zone / `connectionFactory`** | the inner zone wins / the proxy is bypassed | M (spike) | Detect and warn with the exact call site; possibly wrap `runZoned` overrides. |
| **OpenAPI `securitySchemes`** | exports list auth headers but no schemes | S | Infer bearer / API key / basic from redacted header names. |
| **Multipart redaction** | multipart bodies are only partly redacted (pre-existing) | S | Parse parts; redact secret-named fields and file contents for agents. |
| **VS Code `http.proxy` as the default upstream** | since REVIEW-7 #14 the app's traffic ignores it | S | Owner decision: use it when `flutterIntercept.upstreamProxy` is empty (user settings only). |
| **Idle pooled connections** | keep-alive to real hosts is new inside VS Code (REVIEW-7 #14) | S | Watch item: idle timeout / retry on a stale socket if flaky failures appear. |
| **Android Studio plugin** | users asked | L | **Built in 0.9.0** (CONTRACTS §15, docs/REVIEW-9.md): Node sidecar + Kotlin plugin; the traffic view inside Android Studio through the Flutter plugin's embedded browser (JCEF in IntelliJ IDEA). |

### 0.10.0 — gRPC (built 2026-10-11, CONTRACTS §16, docs/REVIEW-10.md)
The last ❌ row of §2 ([devtools#2044](https://github.com/flutter/devtools/issues/2044)). Spikes: docs/spikes/grpc.md,
docs/spikes/template-v6.md. Owner decision: TLS gRPC with the app's default credentials is shown as metadata only (an
undecrypted tunnel), with no trust-store changes on any device.

| Item | Notes |
|---|---|
| **Zero-code capture** | Template v6: an `IOOverrides.global` `socketConnect` hook redirects only grpc-dart / connectrpc-h2c connects (stack frame filter) through a "silent" CONNECT; circuit breaker (3 tunnels in 2 s → direct 30 s, reported to the proxy and shown as a warning). |
| **Proxy** | mockttp `http2: 'fallback'`, own `node:http2` relay with pooled upstream sessions, framing and bounded gzip / deflate, trailers, cancel and deadlines. |
| **Schema from generated Dart** | `*.pbgrpc.dart` / `*.pb.dart` / `*.pbenum.dart` → methods, messages, enums; proto3 JSON decode, raw decode, encode, skeletons. No `.proto` files. |
| **UI** | gRPC rows (status name, streaming, counts), Messages tab (JSON / raw / hex / base64), trailers, `t:grpc` / `grpc:` filters, gRPC mock form, status banner. |
| **Rules** | `grpcMock`; block, fault, throttle, network profiles and sequences on gRPC; other actions never match gRPC calls. |
| **Settings and hosts** | `flutterIntercept.grpc.enabled` / `grpc.decryptHosts` in VS Code, the sidecar / plugin settings page, CLI `--no-grpc` / `--grpc-decrypt-host`, action inputs `grpc` / `grpc-decrypt-hosts`. |
| **Agents** | `add_grpc_mock`, `get_grpc_schema`, `kind: "grpc"`, `assert_traffic expect.grpcStatus`, decoded and redacted messages in `get_request` / `get_frames`; HAR `_grpc`. |

### 0.11.0 — gRPC parity (built 2026-10-11, CONTRACTS §17, docs/REVIEW-11.md)
The HTTP tools 0.10 left out for gRPC, plus `.proto` files as a schema source. Owner instruction: take every decision
in the project's interest. As built: docs/spikes/grpc.md "As built — proxy (0.11.0)".

| Item | Notes |
|---|---|
| **Message transform** | Replaces the relay's observer link only for a direction that has a hook; holds or rewrites whole messages (≤ 4 MB) with HTTP/2 flow control pushing back; replaced messages go out uncompressed. The fast path is unchanged. |
| **Breakpoints** | Each message both ways, plus the end of the call (status, trailers; trailers-only answers too). Edit as JSON (host-encoded with the schema) or base64, drop, change status / trailers, abort (RST_STREAM CANCEL). One pause at a time per call, own deadline per pause, ends with its call. |
| **Mutate** | `mutate` rules on response messages through the host codec (`setGrpcCodec`): decode → JSON path ops → encode; no schema or an encode error forwards the original with a note. ≤ 1 MB per message, 50 MB / 2 s of codec time per call. |
| **Recordings, replay, diff** | Format v3 with gRPC entries (frames, status, trailers, `requestHash`, `incomplete`). Replay like a grpcMock, same origin only, matched by path then first-request hash, else in order; redacted recordings keep no hash. Diff route `gRPC /pkg.Service/Method`: status, message counts, first response shape. |
| **`.proto` schema source** | Hand-written proto2 / proto3 / editions parser (linear, time-budgeted, name caps); imports by path suffix, built-in well-known types; generated Dart wins; workspace discovery with its own 2000-file cap. |
| **Agents** | `resume_request grpc`, `grpcPause` in `list_paused` / `get_request` (decoded, redacted, cached), `add_breakpoint` / `add_mutation` / recording tools on gRPC. |
| **Webview** | gRPC pause editor (message / status), Break on this and field mutate on gRPC, edited / dropped badges, gRPC counts in recordings. |
| **Security (REVIEW-11)** | One 64 MB budget for collected / queued / held gRPC bytes; pauses end with their call; bounded mutate decoding and cached held decodes; same-origin replay and LAN deny first; no request hash in redacted recordings; terminating, linear `.proto` naming and linking. |

### 0.12.0 — gRPC tools complete (built 2026-10-11, CONTRACTS §18, docs/REVIEW-12.md)
The last HTTP tools that skipped gRPC calls. After 0.12 every rule action applies to gRPC except `cors` (browser-only)
and `mock` (gRPC has `grpcMock`). As built: docs/spikes/grpc.md "As built — proxy (0.12.0)".

| Item | Notes |
|---|---|
| **Rewrite** | Request metadata, response headers, new `response.setTrailers` / `removeTrailers` (trailers-only answers too). Pseudo headers, `content-type`, `te`, `grpc-encoding` / `-accept-encoding` / `-status` / `-message` / `-timeout` refused; CR/LF refused; `-bin` values base64. `replaceBody` / `status` → note, metadata still applied. |
| **Scripts** | `onGrpcMessage` (`{path, dir, index, json?, base64, size}` → `{json}` / `{base64}` / `{drop}`) and `onGrpcStatus` (`{code?, message?, trailers?}`) on the 0.11 message transform, only when the script defines them. 200 ms per hook, ≤ 1 MB per message, ≤ 1000 messages per call; errors send the original and go to the script log. |
| **Map remote** | Upstream session to the mapped origin (h2c for `http`, TLS + ALPN h2 for `https`), `:authority` = new host unless `preserveHost`; LAN deny and client-certificate Origin checks on the mapped URL; "Mapped to <origin>". |
| **Resend / edit & resend** | `send()` with `grpc.messages`: own HTTP/2 call, uncompressed messages then half-close; ≤ 100 messages, 4 MB each, 16 MB total; `grpc-timeout: 60S` default. Rules and the network profile don't apply. Host encodes `messagesJson`; refused when a recorded request message was cut. LAN-recorded calls only with LAN mode on and through `lanTargetDenial`. |
| **Agents** | `resend_request` with `grpc.messagesJson` or `grpc.messages` (redacted values restored), `add_rewrite` trailers and gRPC validation, `add_map_remote` on gRPC (loopback only). |
| **Webview** | **More rules…** (rewrite / script / map remote for a route), trailers fields in the rewrite editor, gRPC notes per action, gRPC edit & resend composer, script templates with gRPC hooks. |

**Next / considered (gRPC follow-ups)**
- A gRPC-Web view (today plain HTTP rows without message decoding).
- connectrpc over TLS (its HTTP/2 transport uses `SecureSocket.connect`, which the hook can't see).
- Optional "trust the CA on the iOS simulator" (`simctl keychain add-root-cert`, removed at session end) for a full TLS
  view with default credentials: untested, touches the simulator's trust store, needs its own spike and security
  review (docs/spikes/grpc.md "Open decision"). Android needs a writable-system emulator: document only.
- A `grpcurl` snippet for gRPC calls in **Copy as…** and `get_request` (snippets are HTTP-only today).
- Rules (and the network profile) on resent gRPC calls; today a resent call goes straight to the server.

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
