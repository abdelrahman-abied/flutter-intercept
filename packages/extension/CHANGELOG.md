# Changelog

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
