# Changelog

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
