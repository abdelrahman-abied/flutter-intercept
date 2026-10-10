# Changelog

## 0.5.0

### Coverage: Web, WebSockets, SSE, GraphQL, native clients

**Flutter Web**
- Apps launched in Chrome from VS Code are intercepted too: the Chrome that `flutter run` starts gets Flutter
  Intercept as its proxy and trusts only its CA. Your own browser is untouched. Setting `flutterIntercept.web.enabled`.
- CORS: browser requests show why they would be blocked. Mocks answer their own preflights and carry the CORS
  headers a browser needs. **Add CORS rule (dev only)** unblocks a real API while you develop.
- Chrome's own background requests are hidden by default (**Show browser traffic**).
- The `web-server` device can't be intercepted (you open the page in your own browser).

**WebSockets and Server-Sent Events**
- WebSocket connections are recorded with every message in both directions, and SSE streams with every event,
  live in a **Messages** tab (filter, JSON view, binary hex, close codes). Block and fault rules work on sockets.

**GraphQL**
- The operation name shows in the list (`GQL getUser`), filter with `op:getUser`, and rules can match one
  operation on a shared `/graphql` endpoint.

**Native HTTP clients and background isolates**
- Requests from `cupertino_http`, `cronet_http` and other `package:http_profile` clients bypass the proxy; they are
  now listed read-only (marked `native`) from the app's HTTP profile, in debug and profile mode. Setting
  `flutterIntercept.nativeClients`.
- When the app starts a background isolate (`compute`, `Isolate.run`), a banner says its requests aren't intercepted.

### Agent API
- New tools: `get_frames` (WebSocket messages / SSE events, redacted) and `add_cors_rule` (dev only).
- `list_requests` filters by `kind` and `graphqlOperation`; rule tools take `graphqlOperation`; `get_status`
  includes session warnings. Browser-internal traffic is excluded unless `includeBrowserInternal`.

## 0.4.0

### Your models vs the real API

**Model check**
- Every JSON response is checked against your json_serializable / freezed models, using the generated
  `_$UserFromJson` in `*.g.dart` (the code that actually runs on it), so renamed keys, nullability, defaults,
  enums, nested models and lists are exactly what your app expects.
- A field that would make `fromJson` throw shows as an error on that field in your model file, for example
  `email is null in GET /users/1 → type 'Null' is not a subtype of type 'String' in type cast`, and as a
  badge plus a **Model check** section on the request.
- Requests are matched to models through your Retrofit or Chopper API declarations, the call stack, or your
  own choice (**Check against a model…**). Filter with `contract:error`.
- Setting `flutterIntercept.contractCheck`.

**Break a field on purpose**
- Right-click any field in a response: **Make null in next responses**, **Remove from next responses** or
  **Change value…**. The real response arrives with that change, so you can reproduce the crash and test the fix.
  Numbers keep their exact form (`1.0` stays a double).
- New rule action **Mutate JSON** for the same, with several changes per rule.

**Generate code from traffic**
- **Generate Dart model** from a response: every recorded sample of that route is merged (fields seen only
  sometimes become optional, `null` makes them nullable), in your project's style (freezed, json_serializable
  or plain).
- **Generate test fixture**: the recorded responses as JSON fixtures plus a test using http_mock_adapter,
  `package:http` `MockClient` or mocktail of your Retrofit interface. Secrets are always redacted.

### Agent API
- New tools: `check_contract`, `generate_model`, `generate_fixture_test`, `assert_traffic` (pass/fail checks
  on status, count, order, JSON paths and duration) and `add_mutation`.
- MCP resources (`intercept://exchange/{id}`, `intercept://paused`, `intercept://rules`,
  `intercept://contract/{id}`) and prompts (`debug-failing-request`, `test-error-states`, `verify-change`,
  `build-api-layer-from-traffic`).

## 0.3.0

### Where did this request come from?

**Request → source line**
- Each request records where your code made it. The detail pane shows the call site (for example
  `CatalogApi.fetchAlbum  lib/api/catalog_api.dart:37`) and **Open source** jumps to that line. Expand it to see
  the whole stack; SDK and HTTP-library frames are dimmed.
- Works for `package:http`, `HttpClient` and Dio, including interceptors and `QueuedInterceptor`.
- Still no code in your app: the generated entry sends a short stack trace to the proxy over a side channel that
  only exists while the proxy is reachable. Turn it off with `flutterIntercept.captureSource`.

**Copy, resend, search**
- **Copy as cURL**, **Copy as Dart (http)** and **Copy as Dio** on any request (detail pane or right-click).
- **Resend** a request as it was, or **Edit and resend** it (method, URL, headers, body). The new request shows up
  in the list with a link to the original.
- Search with filters in the text box: `m:POST`, `s:4xx`, `s:error`, `t:json`, `body:"token"`, `h:authorization`,
  `state:mocked`, `src:login_page.dart`. Put `-` in front of any of them to exclude.

**Bad networks on demand**
- A network picker in the toolbar: **Offline**, **Slow 3G**, **Fast 3G**, **Flaky (20% fail)** or your own
  latency, bandwidth and failure rate. It only affects the app you're debugging, not your Mac.
- New rule actions: **Throttle** (latency, bandwidth, failure rate) and **Fault** (connection reset, timeout,
  response cut off half-way, failed lookup), for one endpoint at a time.
- Rules can stop on their own: **only the first N requests** or **expires in** a set time.

**localhost from the emulator**
- Requests to `10.0.2.2` / `10.0.3.2` (the emulator's names for your Mac) reach your Mac's `localhost` while
  intercepting, and `localhost` itself already does. Setting `flutterIntercept.rewriteLocalhost`.

### Agent API
- New tools: `get_request_source` (the file and line that sent a request), `get_body_shape` (the structure of a
  large JSON body in a few hundred tokens), `simulate_network` (a network profile, or a throttle / fault rule for
  one URL) and `resend_request` (only to servers the app already talked to).
- `get_request` can return the request as a cURL, Dart http or Dio snippet, built from the redacted view.
- `add_mock`, `add_block` and `add_breakpoint` take `times` and `ttlMs`, so an agent's rules clean themselves up.

## 0.2.0

### Agent API: AI agents can use Flutter Intercept

**Tools**
- Agents can read and drive Flutter Intercept:
  - read: `get_status`, `list_requests`, `get_request`, `wait_for_request`, `list_paused`, `list_rules`,
    `export_har`;
  - change: `add_mock`, `add_block`, `add_breakpoint`, `remove_rule`, `resume_request`, `abort_request`,
    `clear_requests`, `launch_app`, `stop_app`, `hot_restart`.
- **GitHub Copilot agent mode**: the tools are available as VS Code language model tools
  (`flutter_intercept_<tool>`).
- **Claude Code, Cursor and other MCP clients**: a local MCP server at `http://127.0.0.1:<port>/mcp`, protected
  by a secret token.

**Commands**
- **Connect AI agent** copies the client setup to the clipboard.
- **Add AI Agent Instructions** writes a short usage section into `AGENTS.md`, `CLAUDE.md` or
  `.github/copilot-instructions.md`. It updates the section in place between markers.

**Settings**
- `flutterIntercept.agent.access`: `readWrite`, `readOnly` or `off`.
- `flutterIntercept.agent.redactSecrets`: on by default.
- `flutterIntercept.agent.mcpPort`: default 47823.

**Safety**
- Every tool that changes something asks for confirmation.
- Secrets are redacted in everything agents read; the app still receives the real values.
- Agents never see the CA key, the iPhone LAN token or the MCP token.

**Traffic panel**
- The status line shows the agent's connection and last tool call.
- Rules created by agents (`[agent] …`) get an agent badge in the rules list and on the requests they match.

## 0.1.1

- Marketplace page: screenshots now load from the public GitHub repository.
- README cleanup.

## 0.1.0 — first public preview

### Getting started
- Press **F5** as usual. Dart/Flutter debug sessions are routed through a local intercepting proxy, with no code
  or dependency added to your app.
- The program is launched through a generated entry in `.dart_tool/flutter_intercept/`, which installs
  `HttpOverrides` and then calls your real `main()`.
- Supported targets:
  - Android emulator (`10.0.2.2`).
  - Android physical devices (automatic `adb reverse`, removed afterwards).
  - iOS simulator and macOS desktop (`localhost`).
  - Plain Dart programs.
  - **Physical iPhones** (verified over Wi-Fi, debug and profile): while an iPhone session runs, the proxy also
    listens on the Mac's private (RFC 1918) LAN address. The listener is gated by a per-session token, locked to
    the first device that connects, and closed when the session ends or the Mac's network changes.
- Flavor targets, hot reload, hot restart and `--profile` work. Release launches are never intercepted.
- If the proxy isn't reachable, requests fall back to `DIRECT`.

### Traffic panel
- A **Traffic** panel in the bottom panel lists every exchange live, with filters, keyboard navigation, header
  and body views, a JSON tree, binary/image bodies and decoded gzip/deflate/br.

### Breakpoints, mocks, blocks and rules
- **Breakpoints:** pause a request or a response, edit it (method, URL, headers, body or status), then resume
  or abort.
  - JSON bodies are validated as you type.
  - Untouched breakpoints auto-resume after 5 minutes, with a countdown.
  - Exchanges abandoned by the app's own timeout are marked "gave up".
- **Mock** (status, headers, body, delay) and **Block** (connection reset or status) rules, plus
  **Mock this / Block this / Break on this** on any recorded exchange.
- **Rules:** glob or `/regex/` URL matching plus method; the first enabled match wins.
  - The rules list can be reordered and shows match counts and shadowing.
  - Rules are saved per workspace.

### Status bar, commands and settings
- Status bar toggle `Intercept: on/off` (with `· LAN` during iPhone sessions), and a counter of paused
  exchanges.
- Warns before launching on a USB iPhone from an Apple Silicon Mac when Rosetta, which Flutter's `iproxy`
  needs, is missing.
- Commands: Open Traffic Panel, Toggle Interception, Clear Traffic, Debug with Intercept.
- Settings: `flutterIntercept.enabled`, `flutterIntercept.port` (default 8899, falls back to 8899–8999).

### Security
- The proxy binds `127.0.0.1`. The only exception is the iPhone LAN listener, which:
  - is open only during iPhone sessions;
  - requires the session's token;
  - refuses requests aimed at the Mac itself;
  - closes when the last iPhone session ends.
- The app trusts a CA unique to your installation instead of accepting any certificate, so the `DIRECT`
  fallback keeps normal TLS verification.
- The real server's certificate is still verified by default.
