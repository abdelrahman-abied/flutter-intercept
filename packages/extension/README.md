# Flutter Intercept

**View, pause, edit, block and mock your Flutter app's HTTP traffic, right inside VS Code.**
You add no code to your app and there's nothing to set up: install the extension, press **F5** as usual,
and the traffic shows up.

![Traffic panel: live list of requests with a JSON response open](media/screenshots/traffic-dark.png)

- Works with **Dio**, **package:http** and plain **`HttpClient`**, which covers anything built on `dart:io`.
- HTTPS works too, and you don't install a certificate on the device, simulator or Mac.
- Your app's code is never changed. Nothing is added to `pubspec.yaml`, and `flutter build` / CI never see the
  tool.

## How it works

1. When you start a Flutter (or Dart) debug session, Flutter Intercept writes a small launcher to
   `.dart_tool/flutter_intercept/entry_<name>.dart` and runs that instead of `lib/main.dart` (or your flavor
   target). Flutter's default `.gitignore` already ignores `.dart_tool/`.
2. The launcher installs `HttpOverrides`, which send every `HttpClient` to a proxy on your machine
   (`PROXY <host>:<port>; DIRECT`), and makes the app trust that proxy's certificate authority. It then
   calls your real `main()`.
3. A man-in-the-middle proxy inside the extension records each exchange and applies your rules. The panel at the
   bottom of VS Code shows the traffic.
4. If the proxy isn't reachable, requests go `DIRECT` and the app keeps working. Builds made outside VS Code
   (`flutter build`, `flutter run` in a terminal, CI) are untouched.

## Features

**Live traffic list**
- Every request shows its method, status, host, path, time, size and state (paused, mocked, blocked, error).
- Filter by URL text, method, status class (2xx–5xx, errors) or paused only. The text box also takes filters:
  `m:POST`, `s:4xx`, `s:error`, `t:json`, `body:"token"`, `h:authorization`, `state:mocked`, `src:login_page.dart`
  (prefix any of them with `-` to exclude).
- Keyboard navigation and a resizable detail pane.

**Where a request came from**
- The detail pane shows the line of your code that made the request (for example
  `CatalogApi.fetchAlbum  lib/api/catalog_api.dart:37`). **Open source** jumps there; expand it for the whole
  stack. Works with `package:http`, `HttpClient` and Dio (including interceptors).
- In profile builds Dio requests get no call site, and columns are missing (AOT stacks are shorter).
- Turn it off with `flutterIntercept.captureSource`.

**Model check: your models vs the real API**
- Every JSON response is checked against your json_serializable / freezed models — the generated
  `_$UserFromJson` in `*.g.dart`, which is exactly what runs on it.
- A field that would make `fromJson` throw (a `null` in a non-nullable field, a string where an `int` belongs,
  an unknown enum value) is shown on the request and as an error on that field in your model file.
- Requests are matched to models through Retrofit / Chopper declarations or the call stack; pick one yourself
  with **Check against a model…**. Turn it off with `flutterIntercept.contractCheck`.

**Break a field on purpose**
- Right-click a field in a response: **Make null in next responses**, **Remove from next responses** or
  **Change value…**. Or add a **Mutate JSON** rule. The real response reaches your app with that change.

**Generate code**
- **Generate Dart model** (freezed, json_serializable or plain, matching your project) from every recorded
  sample of a route, and **Generate test fixture** (JSON fixtures + a http_mock_adapter / MockClient / mocktail
  test). Both open as unsaved editors.

**WebSockets, SSE and GraphQL**
- WebSocket connections and Server-Sent Events streams are recorded message by message, live, in a **Messages**
  tab. Block and fault rules work on sockets.
- GraphQL requests show their operation name; filter with `op:getUser` and match rules to one operation.

**Team rules and scenarios**
- **Share** moves a rule into `.vscode/flutter-intercept.json`, committed with your project, so the whole team
  gets it. Shared rules run before personal ones. Rules from the repo that could redirect or alter your traffic
  wait until you approve them.
- Mock bodies can live in a file (**From a file in the workspace**) that you edit like any other.
- **Sequence** rules answer successive requests differently, for example "500 twice, then the real server".
- **Expire token…** gives the next request(s) a 401. The **Auth** tab shows each 401 → refresh → retry timeline
  and warns about refresh stampedes.

**Record, replay and reroute**
- **Recordings**: save the traffic, replay it as mocks (requests not in the recording go to the real server or
  fail like offline), and diff two recordings.
- **Map remote** sends matching requests to another server (staging, a local backend) while the app keeps its
  URLs. **Rewrite** changes headers, status or body text of real requests and responses.
- `flutterIntercept.upstreamProxy` chains Flutter Intercept to Charles, Burp or a corporate proxy.

**Timing, scripts and exports**
- A **Waterfall** column shows where each request's time went: DNS, connect, TLS, sending, waiting for the server
  and downloading, plus time held at a breakpoint or added by a simulated network. The **Timing** tab has the numbers
  and says when a connection was reused.
- **Script (JS)** rules run your own JavaScript on matching traffic: change a request before it leaves, change a
  response before the app gets it, or answer locally. Scripts run isolated, with a time limit, and log to the request.
- **Export…** turns recorded traffic into an **OpenAPI 3.1** document, a **Postman collection** or a HAR file, with
  secrets redacted unless you choose otherwise.
- A notification tells you when a request fails while the panel is hidden (`flutterIntercept.notifications`).
- **Open in new window** moves the traffic view into a window of its own, for a second screen.
- `flutter-intercept test` runs your integration tests through the proxy in CI, with shared rules, replay and
  traffic assertions ([CI mode](#run-integration-tests-through-flutter-intercept-in-ci)).

**Copy and resend**
- **Copy as cURL**, **Copy as Dart (http)** or **Copy as Dio** from the detail pane or a row's right-click menu.
- **Resend** a request unchanged, or **Edit and resend** it. The new request is listed with a link to the original.

**Request and response details**
- Headers and bodies. gzip/deflate/br are decoded, JSON shows as a collapsible tree, binary bodies show their
  size, and images get a preview.

**Breakpoints**
- Pause a request before it reaches the server, or a response before your app receives it.
- Edit the method, URL, headers and body (request) or the status, headers and body (response), then
  **Resume with edits**, **Resume unchanged** or **Abort**.
- JSON bodies are validated as you type.
- A countdown shows when an untouched breakpoint auto-resumes (after 5 minutes).

![Paused response with an editable JSON body and Resume/Abort actions](media/screenshots/paused-response-dark.png)

**Mock and block**
- Answer requests with a mock (status, headers, body, optional delay) or block them (connection reset or an
  error status). Neither contacts the server.
- **Mock this**, **Block this** and **Break on this** turn any recorded exchange into a rule in one click. The
  new rule goes to the top, and a mock opens in the editor so you can change its body.

![“Mock this” creates a rule from the response and opens it for editing](media/screenshots/mock-this-dark.png)

**Bad networks**
- The toolbar's network picker slows down or cuts off the app you're debugging (not your Mac): **Offline**,
  **Slow 3G**, **Fast 3G**, **Flaky (20% fail)** or **Custom** latency, bandwidth and failure rate. The status line
  shows it while it's on.
- **Throttle** and **Fault** rules do the same for one endpoint. Faults: connection reset, timeout (the request
  is held until your app gives up), response cut off half-way, and failed lookup (the connection closes without a
  response).

**Rules**
- Each rule matches on method plus URL. The URL is a glob such as `https://api.example.com/users/*` or a
  `/regex/`. Regexes that could take very long on a long URL (nested repeats like `(.+)+`, backreferences) are
  refused and the rule shows as invalid; AI agents can only use globs.
- Rules run top to bottom and the first enabled match wins. The list shows which rules are shadowed by an
  earlier one.
- Reorder, enable/disable, delete with undo. Personal rules are saved per workspace; shared rules live in
  `.vscode/flutter-intercept.json`.
- A rule can apply to **only the first N requests** or **expire** after a time; it removes itself afterwards.

![Rules tab: ordered rules with enable toggles and match counts](media/screenshots/rules-dark.png)

**Status bar**
- `Intercept: on/off` toggles interception for new sessions. It shows `· LAN` while an iPhone session runs.
- A pause counter appears while exchanges are waiting at a breakpoint.

The panel has four tabs: **Traffic**, **Rules**, **Recordings** and **Auth**. It follows your VS Code theme: light,
dark and high contrast.

![Traffic panel in a light theme](media/screenshots/traffic-light.png)

## Devices

| Target | What happens |
|---|---|
| **Android emulator** | The app reaches the proxy at `10.0.2.2`. No setup. |
| **Android physical device** (via adb) | Flutter Intercept runs `adb reverse` for the proxy port and removes it when the last session ends. adb is found through `ANDROID_HOME`/`ANDROID_SDK_ROOT`, the default SDK location, or `PATH`. |
| **iOS simulator** | Uses `localhost`. No setup. |
| **macOS desktop** | Uses `localhost`. The app needs the `com.apple.security.network.client` entitlement, which any macOS app that already does networking has. |
| **Plain Dart programs** (`bin/main.dart`) | Intercepted the same way. |
| **iPhone** (physical) | Supported, after some one-time setup; see [iPhone](#iphone) below. Verified over Wi-Fi. On Apple Silicon Macs, a USB connection also needs Rosetta. |
| **Flutter web** | Chrome launched from VS Code: Chrome gets Flutter Intercept as its proxy (see [Flutter Web](#flutter-web)). The `web-server` device isn't intercepted. |

Hot reload, hot restart, flavors (`lib/main_dev.dart` etc.) and `--profile` keep working through the generated
entry. **Release launches** (`flutterMode: "release"` or `--release`) are never intercepted. They run your
normal entry point.

## iPhone

A physical iPhone can't reach your Mac's `localhost`. So while an iPhone debug session runs, and only then:
- The proxy also listens on your Mac's Wi-Fi/LAN IPv4 address.
- The status bar shows `Intercept: on · LAN`, and the Traffic panel shows `LAN open for iPhone · <ip>:<port>`.

The LAN listener is protected:
- **Secret token.** Each opening gets a fresh random token, which only the app launched in that session
  receives (as a build define). Requests without it get `407` and the connection is closed. The token never appears in the
  UI or the extension's log.
- **No access to your Mac.** Requests from the phone aimed at the Mac itself (its own addresses,
  `localhost`, link-local) are refused with `403`.
- **Locked to your iPhone.** The listener only accepts the first device that connects with the token, and the
  status tooltip shows `locked to <ip>`.
- **Private networks only.** It only listens on a private (RFC 1918) address: `10.x`, `172.16–31.x` or `192.168.x`.
- **Closes automatically.** The listener closes when the last iPhone session ends, or as soon as your Mac's
  network changes (new address, or a different Wi-Fi/router). After a network change, relaunch the iPhone session.
  Everything else stays on `127.0.0.1`.

Verified on an iPhone 16 Pro Max (iOS 27) over Wi-Fi, in debug and profile mode.

**One-time setup**

1. **Xcode → Settings → Accounts**: add the Apple Account of your signing team, and select that team for the
   app (automatic signing works).
2. **On the iPhone**, the first time you install an app signed by your account: Settings → General → VPN &
   Device Management → your developer certificate → **Trust**.
3. **On the iPhone**, when the app first starts: allow it to **find and connect to devices on your local
   network**.
4. **On the Mac**, the first time the LAN listener opens: allow **Visual Studio Code** to accept incoming
   network connections. Also allow Local Network access for VS Code if macOS asks.

Flutter Intercept reminds you of steps 3 and 4 once.

**Good to know**

- **Network.** The iPhone must be on the **same Wi-Fi** as the Mac, and unlocked while the app installs and
  launches. If your Mac has no private Wi-Fi/Ethernet IPv4 address (none at all, a public address, or carrier-grade
  NAT `100.64.x`), the session runs without interception and you get a warning.
- **Use a trusted Wi-Fi.** The token travels unencrypted inside the proxy request. On shared or public Wi-Fi,
  others on the network may be able to observe it.
- **Apple Silicon Macs and USB.** Flutter's bundled `iproxy`, which a USB iPhone needs, is x86_64-only. So a USB
  iPhone needs **Rosetta**: `sudo softwareupdate --install-rosetta --agree-to-license`.
  - The alternative is to pair the iPhone over Wi-Fi (Xcode → Window → Devices and Simulators → **Connect via
    network**). Wireless runs don't use `iproxy`.
  - Flutter Intercept warns you before launching on a USB iPhone when Rosetta is missing.
- **Stale token.** If a build launched with an old token keeps running after the listener was reopened,
  its HTTPS goes direct (not intercepted) and plain `http://` requests get `407`. Relaunch the session to fix
  it. The extension keeps the token stable while any iPhone session is alive.
- **Free signing teams.** A personal (free) team's provisioning profile expires after **7 days**. Rebuild to
  renew it.
- **Wireless launches are slower.** The first debug launch over Wi-Fi can take around 40 s to install and start.

## Use with AI agents

AI coding agents can use Flutter Intercept the way you do. They can run the app, watch its requests, check what was
sent, and fake server responses to test error states. This works with GitHub Copilot (agent mode), Claude Code,
Cursor, Windsurf, and any client that speaks MCP (Model Context Protocol).

| What the agent can do | Tool |
| --- | --- |
| See whether the proxy and app sessions are running | `get_status` |
| List recent requests (filter by URL, method, status, state) | `list_requests` |
| Read one request in full (headers, bodies, timing phases, script log, error) | `get_request` |
| Wait until the app makes a matching request (with a timeout) | `wait_for_request` |
| See requests paused at a breakpoint | `list_paused` |
| List the rules in priority order | `list_rules` |
| Answer matching requests with a mock (status, headers, body, delay) | `add_mock` |
| Block matching requests | `add_block` |
| Pause matching requests or responses | `add_breakpoint` |
| Remove a rule | `remove_rule` |
| Resume a paused request, optionally with edits, or abort it | `resume_request`, `abort_request` |
| Clear the recorded traffic | `clear_requests` |
| Save the traffic as a HAR file in `.dart_tool/flutter_intercept/exports/` | `export_har` |
| Launch the app through Dart-Code, stop it, or hot-restart it | `launch_app`, `stop_app`, `hot_restart` |
| Find the file and line that sent a request | `get_request_source` |
| See the structure of a large JSON body without reading it | `get_body_shape` |
| Slow down or cut off the network (everything, or one URL) | `simulate_network` |
| Send a recorded request again, optionally edited (same server only) | `resend_request` |
| Check responses against your Dart models | `check_contract` |
| Generate a Dart model or a fixture test from recorded traffic | `generate_model`, `generate_fixture_test` |
| Check traffic with pass/fail expectations (status, count, order, JSON paths, duration) | `assert_traffic` |
| Change fields in real JSON responses (null, remove, set) | `add_mutation` |
| Read WebSocket messages and SSE events | `get_frames` |
| Add CORS headers to a real API while developing (Flutter Web) | `add_cors_rule` |
| Save, list, replay or compare traffic recordings | `save_recording`, `list_recordings`, `replay_recording`, `diff_recordings` |
| Answer successive requests differently (fail twice, then succeed) | `add_sequence` |
| Make the next requests get 401, and read the token refresh flows | `expire_token`, `get_auth_flows` |
| Send matching requests to a local server (agents: local targets only) | `add_map_remote` |
| Change headers, status or body text of real requests and responses | `add_rewrite` |
| Write the traffic as an OpenAPI 3.1 file or a Postman collection | `export_openapi`, `export_postman` |
| Take a screenshot of the running app, with the requests just before it (asks you first) | `take_screenshot` |

Over MCP there are also resources (`intercept://exchange/{id}`, `intercept://paused`, `intercept://rules`,
`intercept://contract/{id}`) and prompts (`debug-failing-request`, `test-error-states`, `verify-change`,
`build-api-layer-from-traffic`).

`get_request` can also return the request as a cURL, Dart http or Dio snippet. `add_mock`, `add_block` and
`add_breakpoint` take `times` and `ttlMs`, so rules an agent adds can clean themselves up.

In VS Code the tools are named `flutter_intercept_<tool>`; over MCP they use the names above.

### Connecting

- **GitHub Copilot (agent mode in VS Code):** nothing to set up. The tools are available as soon as the extension
  is installed.
- **Claude Code, Cursor, Windsurf and other MCP clients:**
  1. Run **Flutter Intercept: Connect AI Agent** and pick your client.
  2. The command copies the setup to the clipboard: the `claude mcp add …` command for Claude Code, an
     `mcp.json` snippet for Cursor, an `mcp_config.json` snippet for Windsurf, or the URL and header for other
     clients.
  3. Paste it into your client. The command never writes config files itself.
- **The MCP server** runs at `http://127.0.0.1:<port>/mcp` (default port 47823) and accepts only local
  connections that carry its secret token.

### Access, confirmations and secrets

- **Access level.** `flutterIntercept.agent.access` decides what agents may do:
  - `readWrite` (the default);
  - `readOnly`: agents can look, but changes are refused;
  - `off`: nothing is exposed.
- **Confirmations.** Every tool that changes something asks you to confirm in the client: adding or removing
  rules, resuming or aborting requests, clearing traffic, and launching, stopping or restarting the app.
- **Secret redaction.** With `flutterIntercept.agent.redactSecrets` on (the default), agents see `[redacted]`
  instead of:
  - authorization, cookie and token-like headers;
  - password, token, key and session fields in URLs and JSON bodies.

  Redaction only affects what agents read. Your app always receives the real values.
- **What agents never see:** Flutter Intercept's CA key, the iPhone LAN token, or the MCP token.
- **Agent rules are marked.** Rules an agent creates are named `[agent] …`. They get an **agent** badge in the
  rules list and on the requests they match.
- **The status line** shows whether an agent is connected and its last tool call, for example
  `Agent: connected · last: wait_for_request 3s ago`.

### Teach your agent the workflow

Run **Flutter Intercept: Add AI Agent Instructions** and pick `AGENTS.md`, `CLAUDE.md` and/or
`.github/copilot-instructions.md`. It adds a short section that tells agents:
- to verify changes against real traffic: launch the app, then `wait_for_request`, then `get_request`;
- to test error states with mocks;
- to clean up the rules they add.

The section sits between `<!-- flutter-intercept:start -->` and `<!-- flutter-intercept:end -->` markers.
Running the command again updates it in place, and the rest of the file is left alone.

### Example prompts

- "Run the app and check that the login request sends the email and password."
- "Make the products endpoint return 500 and check that the error UI shows up, then remove the mock."
- "Mock the feed endpoint with a 10-second delay and check the loading state."
- "Pause the next checkout request, change the quantity to 3, and resume it."

## Flutter Web

Run your web app on **Chrome** from VS Code as usual. The Chrome that `flutter run` starts uses Flutter
Intercept as its proxy and trusts only its CA (pinned by key); your everyday browser is not touched.

- Browser requests show CORS problems ("No Access-Control-Allow-Origin header…"). Mocks answer their own
  preflights. **Add CORS rule (dev only)** adds the CORS headers to a real API's responses while you develop —
  your server still needs the right CORS setup for production.
- Chrome's own background requests are hidden; **Show browser traffic** shows them.
- Everything you open in that debug Chrome window goes through the proxy and is recorded (like any site you
  browse there), so keep it to your app. Launches that use your own Chrome profile (`--user-data-dir`) are not
  intercepted.
- Not intercepted: the `web-server` device (you open the page in your own browser) and release builds.

## Tutorials

Short, hands-on walkthroughs, one per feature. Each one says what you'll do, the exact steps, what you should
see, and a tip. The examples use public test APIs such as `jsonplaceholder.typicode.com`; swap in your own
endpoints.

**Getting started**

1. [Run your app with interception](#run-your-app-with-interception)
2. [Read the traffic list and request details](#read-the-traffic-list-and-request-details)
3. [Find requests with filters and search](#find-requests-with-filters-and-search)

**Change what your app sends and receives**

4. [Pause and edit a request or response](#pause-and-edit-a-request-or-response)
5. [Mock a response](#mock-a-response)
6. [Block a request](#block-a-request)
7. [Organize your rules](#organize-your-rules)
8. [Make a rule remove itself](#make-a-rule-remove-itself)

**Debug a request**

9. [Jump from a request to the code that sent it](#jump-from-a-request-to-the-code-that-sent-it)
10. [Copy a request as cURL, Dart or Dio](#copy-a-request-as-curl-dart-or-dio)
11. [Resend a request, or edit it and resend](#resend-a-request-or-edit-it-and-resend)

**Bad networks**

12. [Simulate a slow, flaky or offline network](#simulate-a-slow-flaky-or-offline-network)
13. [Slow down or break a single endpoint](#slow-down-or-break-a-single-endpoint)

**Your models vs the real API**

14. [Check responses against your models](#check-responses-against-your-models)
15. [Break a field on purpose](#break-a-field-on-purpose)
16. [Generate a Dart model from traffic](#generate-a-dart-model-from-traffic)
17. [Generate a fixture test](#generate-a-fixture-test)

**Web, sockets and GraphQL**

18. [Run a Flutter Web app in Chrome](#run-a-flutter-web-app-in-chrome)
19. [Get past CORS errors while you develop](#get-past-cors-errors-while-you-develop)
20. [Watch WebSocket messages and SSE events](#watch-websocket-messages-and-sse-events)
21. [Work with GraphQL operations](#work-with-graphql-operations)
22. [See requests from native clients and background isolates](#see-requests-from-native-clients-and-background-isolates)

**Team rules and scenarios**

23. [Share rules with your team](#share-rules-with-your-team)
24. [Approve rules that came from the repo](#approve-rules-that-came-from-the-repo)
25. [Keep a mock body in a file](#keep-a-mock-body-in-a-file)
26. [Answer successive requests differently](#answer-successive-requests-differently)
27. [Test token refresh with Expire token](#test-token-refresh-with-expire-token)

**Record, replay and reroute**

28. [Record traffic and replay it](#record-traffic-and-replay-it)
29. [Compare two recordings](#compare-two-recordings)
30. [Send requests to another server](#send-requests-to-another-server)
31. [Change headers, status or body text](#change-headers-status-or-body-text)
32. [Chain to Charles, Burp or a corporate proxy](#chain-to-charles-burp-or-a-corporate-proxy)

**Timing, scripts, exports and CI**

33. [Open the traffic view in its own window](#open-the-traffic-view-in-its-own-window)
34. [See where a request's time went](#see-where-a-requests-time-went)
35. [Change requests and responses with a script](#change-requests-and-responses-with-a-script)
36. [Export traffic as OpenAPI or Postman](#export-traffic-as-openapi-or-postman)
37. [Get notified when requests fail](#get-notified-when-requests-fail)
38. [Run integration tests through Flutter Intercept in CI](#run-integration-tests-through-flutter-intercept-in-ci)

**Devices**

39. [Run on an Android emulator or phone](#run-on-an-android-emulator-or-phone)
40. [Run on the iOS simulator or macOS](#run-on-the-ios-simulator-or-macos)
41. [Run on a physical iPhone](#run-on-a-physical-iphone)
42. [Call a server on your Mac from the app](#call-a-server-on-your-mac-from-the-app)

**AI agents**

43. [Connect an AI agent](#connect-an-ai-agent)
44. [Teach your agent the workflow and give it tasks](#teach-your-agent-the-workflow-and-give-it-tasks)
45. [Control what agents can see and do](#control-what-agents-can-see-and-do)
46. [Let agents check models and verify changes](#let-agents-check-models-and-verify-changes)
47. [Let agents read sockets, GraphQL and CORS](#let-agents-read-sockets-graphql-and-cors)
48. [Let agents record, replay and run scenarios](#let-agents-record-replay-and-run-scenarios)
49. [Let agents export, time and take screenshots](#let-agents-export-time-and-take-screenshots)

### Run your app with interception

You'll install the extension and see your app's requests in VS Code.

1. Install **Flutter Intercept** from the Marketplace (in Cursor, Windsurf or VSCodium: from Open VSX). The Dart
   extension it needs is installed with it.
2. Open your Flutter project, pick a device in the status bar, and press **F5**, as you always do.
3. The **Traffic** panel opens at the bottom of VS Code on the first intercepted session.

**You should see:** each request your app makes appear as a row, and `Intercept: on` in the status bar.

**Tip:** click `Intercept: on` (status bar or panel toolbar) to turn interception off; it applies from the next
launch. If F5 isn't picked up, run **Flutter Intercept: Debug with Intercept** from the Command Palette.

### Read the traffic list and request details

You'll inspect what your app sent and what the server answered.

1. Each row shows **Method**, **Status**, **Host**, **Path**, **Time**, **Size** and **State** (paused,
   mocked, blocked, error).
2. Click a row, or move with the arrow keys, **Home**, **End**, **Page Up** and **Page Down**. Press **Enter** to
   move focus into the details and **Esc** to close them.
3. Switch between the **Request** and **Response** tabs. Each shows **Headers** and **Body**.
4. Drag the splitter between the list and the details to resize them.

**You should see:** JSON as a collapsible tree, compressed bodies already decoded, and a preview for images.

**Tip:** right-click a row (or press **Shift+F10**) for the same actions as the detail pane. **Clear traffic** in
the toolbar empties the list; requests still in flight stay.

### Find requests with filters and search

You'll narrow a busy list down to the requests you care about.

1. Type in the **Filter** box: plain words match the URL, for example `todos`.
2. Add filters, separated by spaces:
   - `m:POST` (method), `s:404`, `s:4xx` or `s:error` (status);
   - `t:json` (also `html`, `image`, `text`, `xml`, `binary`, `other`);
   - `body:token` or `body:"a phrase"`, `h:authorization` or `h:name=value`;
   - `state:paused` (also `mocked`, `blocked`, `error`, `simulated`, `resent`), `src:login_page.dart`;
   - `contract:error` (also `warning`, `ok`, `unchecked`): the [model check](#check-responses-against-your-models);
   - `kind:ws` (also `sse`, `http`), `op:getUser` (GraphQL), `cors:problem` (also `ok`, `preflight`, `patched`),
     `captured:native`, `browser:internal` (or `app`).
3. Put `-` in front of any word or filter to exclude it, for example `-s:2xx`.
4. Or use the toolbar: **All methods**, the **2xx** to **5xx** and **err** toggles, and **paused only**.

**You should see:** the status line shows how many exchanges are listed and how many are shown.

**Tip:** hover the filter box for the syntax; an invalid filter is marked and explained there. **Clear filters**
(next to the toggles) resets everything.

### Pause and edit a request or response

You'll stop a request before it reaches the server (or a response before the app gets it) and change it.

1. Select a request, for example `GET https://jsonplaceholder.typicode.com/users/1`, and click
   **Break on this**. This pauses its *responses*.
2. Trigger the request again in your app.
3. The row shows as paused, the toolbar shows **1 paused**, and the details open on a banner with a countdown.
4. Edit the status, headers or body (for a paused request: method, URL, headers and body). JSON is checked as
   you type; **Format** tidies it and **Go to error** finds a mistake.
5. Click **Resume with edits**, **Resume unchanged** or **Abort**.

**You should see:** your app receive the edited response. **Abort** gives it a network error.

**Tip:** to pause requests instead, open the rule in **Rules** and pick **Pause request** or **Both**. An
untouched breakpoint resumes by itself after 5 minutes, but your app's own timeout may fire first; the exchange
is then marked as given up.

### Mock a response

You'll make your app receive a response you wrote, without calling the server.

1. Select a request, for example `GET .../todos/1`, and click **Mock this**.
2. The **Rules** tab opens with the new mock in the editor, pre-filled with the real response.
3. Change **Status**, **Delay (ms)**, **Headers** or **Body**, for example `"completed": true`, then **Save**.
4. Trigger the request again in your app.

**You should see:** the row marked as mocked, with a link to the rule that answered it. The server isn't
contacted.

**Tip:** to start from scratch, open **Rules** → **Add rule** → **Mock response**. A `500` with an empty body
and a 3000 ms delay is a quick way to test error and loading states.

### Block a request

You'll make a request fail, to check how your app handles errors.

1. Select a request and click **Block this**. The rule answers with status `403` and goes to the top of
   **Rules**.
2. To simulate a network error instead, edit the rule and pick **Connection reset (app sees a network error)**,
   or keep **Respond with status** with another code.
3. Trigger the request again.

**You should see:** the row marked as blocked, and your app's error handling run.

**Tip:** untick the rule's checkbox to let requests through again without deleting it.

### Organize your rules

You'll control which rule applies when several match.

1. Open the **Rules** tab. Rules run top to bottom, and the **first enabled rule that matches wins**.
2. Click **Add rule**. Fill in **Method** (empty = any) and **URL**: a glob such as
   `https://jsonplaceholder.typicode.com/users/*`, or a `/regex/` such as `/\/users\/\d+$/`.
3. The editor shows how many listed exchanges the rule matches. Pick an **Action** and click **Add rule**.
4. Reorder by dragging, with **Move up** / **Move down**, or with **Alt+↑** / **Alt+↓**.
5. Use the checkbox to enable or disable a rule, **Edit** to change it, and **Delete** to remove it.

**You should see:** each rule's match count, and a warning when an earlier rule takes some of its matches.

**Tip:** a delete can be undone with **Undo** in the notice that appears. Personal rules are saved per workspace;
to give a rule to your team, [share it](#share-rules-with-your-team).

### Make a rule remove itself

You'll add a temporary mock that can't linger after a test.

1. Open a rule in the editor (or **Add rule**) and find **Lifetime**.
2. Set **Only first N requests**, for example `1` to fail just the next call and test a retry.
3. Or set **Expires in** with **seconds**, **minutes** or **hours**.
4. **Save**.

**You should see:** a badge on the rule with what's left. The rule is removed once it is spent or expired.

**Tip:** rules added by AI agents can do the same (`times`, `ttlMs`), so their mocks clean themselves up too.

### Jump from a request to the code that sent it

You'll find the line of your code behind a request.

1. Select a request. Under the title, **Called from** shows the function and file, for example
   `CatalogApi.fetchAlbum  lib/api/catalog_api.dart:37`.
2. Click **Open source** to open that line in the editor.
3. Click **All frames** to see the whole stack; click any frame to open it. SDK and library frames are dimmed.

**You should see:** works for `package:http`, `HttpClient` and Dio, including interceptors.

**Tip:** filter by file with `src:catalog_api.dart`. In profile builds Dio requests have no call site. Turn
recording off with `flutterIntercept.captureSource`.

### Copy a request as cURL, Dart or Dio

You'll reproduce a request outside the app.

1. Select a request and open **Copy as…** in the detail pane (or right-click the row).
2. Pick **Copy as cURL**, **Copy as Dart (http)** or **Copy as Dio**.

**You should see:** a short "Copied as …" notice; paste the snippet into a terminal, a test or a bug report.

**Tip:** the snippet contains real headers, including auth tokens. Check it before sharing.

### Resend a request, or edit it and resend

You'll replay a request without touching the app.

1. Select a finished request, for example `POST https://jsonplaceholder.typicode.com/todos`.
2. Click **Resend** to send it again unchanged.
3. Or click **Edit and resend**, change the method, URL, headers or body, and click **Send**
   (**Ctrl/Cmd+Enter**).

**You should see:** a new row marked **resent**, selected once recorded, with a link back to the original.

**Tip:** resent requests go through the proxy like app traffic, so your rules and the network profile apply.
**Resend** is disabled for binary or truncated bodies; use **Edit and resend**.

### Simulate a slow, flaky or offline network

You'll check how your app behaves on a bad connection.

1. In the panel toolbar, open **Network**.
2. Pick **Offline**, **Slow 3G**, **Fast 3G** or **Flaky (20% fail)**.
3. Or pick **Custom…**, fill in **Latency (ms)**, **Bandwidth (kbps)** and **Fail (%)**, and click **Apply**.

**You should see:** the picker highlighted, `Network: …` in the status line, and affected rows marked **sim**.

**Tip:** only the app you're debugging is affected, not your Mac. Mocks and blocks still answer as set. Pick
**No throttling** to switch it off; it's easy to forget.

### Slow down or break a single endpoint

You'll make one endpoint slow or failing while the rest of the app stays normal.

1. In **Rules**, click **Add rule** and set the URL, for example `https://jsonplaceholder.typicode.com/posts*`.
2. For a slow endpoint, pick **Throttle** and set **Latency (ms)**, **Bandwidth (kbps)** or **Fail (%)**.
3. For a failure, pick **Fault** and one of: **Connection reset**, **Timeout (never answered)**,
   **Truncated response** or **DNS failure (host lookup)**.
4. Click **Add rule** and trigger the request.

**You should see:** the row marked **simulated**, with what was applied in the detail pane.

**Tip:** **Timeout** holds the request until your app gives up, so it tests your client timeout. Throttling
doesn't slow uploads or WebSockets.

### Check responses against your models

You'll find the field of a real response that would make your `fromJson` throw.

1. Use json_serializable or freezed models with their generated `*.g.dart` files. Nothing else to set up.
2. Run the app, select a JSON response such as `GET https://jsonplaceholder.typicode.com/users/3`, and open
   **Response**.
3. **Model check** names the model and how it was found (a Retrofit or Chopper declaration, or the call site),
   then says **matches the model** or lists the errors and warnings.
4. Click a problem to open that field in your model file.
5. Wrong model, or none? Click **Check against a model…** (or **Check against a different model…**) and pick a
   class, a `List<…>`, **Don't check this route** or **Forget my choice (map automatically)**.

**You should see:** a **model** badge on rows with problems, the field marked in the JSON tree, and the error on
the field in your model file, for example
`email is null in GET /users/1 → type 'Null' is not a subtype of type 'String' in type cast`.

**Tip:** filter with `contract:error` (or `warning`, `ok`, `unchecked`). Turn it off with
`flutterIntercept.contractCheck`.

### Break a field on purpose

You'll let the real response through with one field changed, to reproduce a crash and test your fix.

1. Select a JSON response and open **Response**.
2. Right-click a field in the JSON tree (or move to it with the arrow keys and press **Shift+F10**).
3. Pick **Make null in next responses** or **Remove from next responses**.
4. Or pick **Change value…**, type a JSON value such as `"42"`, `1.0` or `[]`, and click
   **Apply to next responses**.
5. Inside a list, **Make null in every item** and **Remove from every item** change that field in all items.
6. Trigger the request again.

**You should see:** a "Rule added: …" notice with **Undo**, and your app receiving the changed field.

**Tip:** the change applies until you disable or delete the rule in **Rules**. There it's a **Mutate JSON** rule:
add more paths with **+ Add change**. Numbers keep their exact form (`1.0` stays a double). **Copy JSON path**
copies a field's path. A mocked response can't be changed this way; edit the mock instead.

### Generate a Dart model from traffic

You'll turn real responses into model classes.

1. Make the app call the endpoint a few times, ideally with different data.
2. Select one of the responses and click **Generate…** → **Generate Dart model** (also in the row's right-click
   menu).
3. The model opens in a new, unsaved editor. Save it in your project; for freezed or json_serializable, run
   `dart run build_runner build`.

**You should see:** every recorded response of that route merged into one model, in your project's style
(freezed, json_serializable or plain). Fields seen only sometimes are optional; fields seen as `null` are
nullable; nested objects get their own classes.

**Tip:** the more varied the samples, the better the nullability. The item is disabled for non-JSON responses.

### Generate a fixture test

You'll turn a recorded request into a test that doesn't need the server.

1. Select a finished request and click **Generate…** → **Generate test fixture**.
2. The JSON fixture and a test open in new editors. Save them under `test/`.
3. Adjust the test to call your repository or service and check what matters.

**You should see:** a test that uses http_mock_adapter (Dio), `package:http`'s `MockClient` or mocktail for a
Retrofit interface, depending on your project's dev dependencies.

**Tip:** secrets in the recorded traffic are always redacted in fixtures. Check the rest of the data before you
commit them.

### Run a Flutter Web app in Chrome

You'll intercept a web build the same way as a mobile one.

1. Pick **Chrome** as the device and press **F5**.
2. Flutter Intercept starts that Chrome with itself as the proxy, trusting only its own CA. Your everyday
   browser isn't touched.
3. Use the app in the Chrome window that opens.

**You should see:** the app's requests in the list. Chrome's own background requests are hidden; click
**Show browser traffic** in the toolbar (it shows how many are hidden) to see them, or filter with
`browser:internal`.

**Tip:** everything you open in that debug Chrome window is recorded, so keep it to your app. The `web-server`
device and launches with your own Chrome profile (`--user-data-dir`) aren't intercepted. Turn web interception
off with `flutterIntercept.web.enabled`. More in [Flutter Web](#flutter-web).

### Get past CORS errors while you develop

You'll see why the browser blocks a request and unblock it for local development.

1. Run your web app in Chrome and trigger a call to an API without the right CORS headers.
2. The row gets a **CORS** badge. Select it: the **CORS** section says why a browser blocks it, for example a
   missing `Access-Control-Allow-Origin` header.
3. Click **Add CORS rule (dev only)**, check the origin and route it names, tick
   **Allow credentials (cookies)** only if you need them, and click **Add rule**.
4. Trigger the request again.

**You should see:** a "CORS rule added first: …" notice with **Undo**, the request going through, and the section
saying it was patched by Flutter Intercept.

**Tip:** this only helps during development: your server's CORS setup isn't fixed, and a production build is
still blocked. Find problems with `cors:problem`. Mocks answer their own preflights. In **Rules**, the action is
**CORS (dev only)** with an **Allow origin** field.

### Watch WebSocket messages and SSE events

You'll follow a live socket or event stream message by message.

1. Run an app that opens a WebSocket (`dart:io` `WebSocket` or a package on top of it) or reads a Server-Sent
   Events stream, for example `wss://echo.websocket.org`.
2. Its row has a **WS** or **SSE** badge, and the size column counts messages.
3. Select it and open **Messages (N)** (**Events (N)** for SSE). New messages appear while it shows **live**.
4. Filter with words (`-word` excludes) and, for WebSockets, **All**, **↑ Sent** or **↓ Received**.
5. Click a message to see it; switch **Pretty** / **Raw**, or copy it.

**You should see:** sent and received counts, and how the connection closed (for example "Closed by the server").

**Tip:** filter the list with `kind:ws` or `kind:sse`. Block and **Fault** rules work on sockets, so you can test
reconnects; mocks and resend don't. Each message keeps up to 64 KB; older ones are dropped on long connections.

### Work with GraphQL operations

You'll tell GraphQL requests apart on a shared `/graphql` endpoint.

1. Run an app that sends GraphQL, for example `POST https://countries.trevorblades.com/graphql` with the
   operation `CountryByCode`.
2. Each row shows its operation, such as **GQL CountryByCode**.
3. Filter with `op:CountryByCode` (case-insensitive, matches the start of the name; separate several with
   commas).
4. Click **Mock this**, **Block this** or **Break on this** on one operation.

**You should see:** a rule that matches only that operation; its **op** badge in **Rules** shows the name.

**Tip:** for a rule on a GraphQL URL, the editor's **GraphQL operation** field suggests the operations seen so
far. Names are exact and case-sensitive; leave it empty for any operation.

### See requests from native clients and background isolates

You'll see requests made outside your app's main isolate, and find the ones Flutter Intercept can't intercept.

1. Run an app in a debug session that makes requests in `compute`, `Isolate.run` or `Isolate.spawn`.
2. Those requests appear in the list like any other; rules, breakpoints and mocks apply to them.
3. Run an app that uses `cupertino_http`, `cronet_http` or another native client: its requests appear marked
   **native**, read from the app's HTTP profile in debug and profile mode.
4. A banner names what isn't intercepted (a native client, or a background isolate in profile mode or one started
   with `Isolate.spawnUri`); close it with **Dismiss this warning**.

**You should see:** background-isolate requests in the list. Native requests show what the HTTP profile recorded,
with **Mock this**, **Block this**, **Break on this** and resend disabled: they never went through the proxy.

**Tip:** Flutter Intercept sets up each new isolate as it starts, in debug sessions only. Set
`flutterIntercept.backgroundIsolates` to `warn` to leave isolates alone and only be told about them. Filter native
requests with `captured:native`; turn that listing off with `flutterIntercept.nativeClients`.

### Share rules with your team

You'll commit a rule with the project so everyone who pulls it gets the same mock.

1. In **Rules**, click **Share** on a personal rule.
2. Read the confirmation: the rule moves into `.vscode/flutter-intercept.json`, which is committed with your code.
   Click **Share**.
3. Commit `.vscode/flutter-intercept.json` (and any mock body files it uses).

**You should see:** the rule marked **shared**, above your personal rules. "N shared rules from
`.vscode/flutter-intercept.json` run first" heads the list.

**Tip:** shared rules are read-only in the panel: **View** instead of **Edit**, and their enable box and delete are
disabled. Change them in the file, or click **Unshare** to make one personal again. A rule holding something that looks like a real
token, password or key isn't shared; replace it with a placeholder such as `test-token`.

### Approve rules that came from the repo

You'll decide which shared rules may change where your app's requests go.

1. Pull a project whose `.vscode/flutter-intercept.json` has rules that could redirect or alter your traffic.
2. A banner at the top of the panel says how many shared rules are held back, and lists each one with the reason.
3. Click **Review file** to read `.vscode/flutter-intercept.json`.
4. Click **Approve…**. VS Code lists the held rules again; click **Approve** only if you trust who wrote them.

**You should see:** the banner go away and the approved rules run.

**Tip:** rules are held back when they send requests to another server (Map Remote to a non-local host), change
request headers or bodies, answer with a redirect, HTML or JavaScript, set cookies or CORS headers, or change the
page's Content-Security-Policy. Approval is per rule and per machine: if someone changes the rule later, it's held
again. Rules you share yourself count as approved.

### Keep a mock body in a file

You'll edit a large mock body in a normal editor tab and share it through git.

1. Open a mock rule (or **Add rule** → **Mock response**). Under **Body**, pick **From a file in the workspace**.
2. Keep the suggested path under `.vscode/flutter-intercept/mocks/`, or type another workspace-relative path.
3. Click **Create file…** to write the current body there, then **Create file**. Or **Open file** if it exists.
4. **Save** the rule and edit the file like any other.

**You should see:** the mock answer with the file's content. Changes apply as soon as you save the file.

**Tip:** a body copied from real traffic can hold live tokens. The editor warns when the body looks like it contains
one, and a file with something that looks like a real credential isn't written. A missing file skips the rule
and shows a problem.

### Answer successive requests differently

You'll make the first calls fail and later ones succeed, to test retries and recovery.

1. **Add rule**, set the URL (for example `https://jsonplaceholder.typicode.com/todos/*`) and pick **Sequence**.
2. Under **Steps**, set step 1 to **Mock response** with status `500` and `×` `2` requests.
3. **+ Add step**, then pick **Real server** (or **Block**, **Fault**, **Throttle** and more).
4. Under **After the last step**, pick **Keep answering with the last step**, **Go to the real server** or
   **Start again from step 1**.
5. Check the **Requests get:** preview, then **Add rule**.

**You should see:** the first two requests get 500 and the third reaches the server.

**Tip:** the count restarts whenever you change the rule. A sequence can't contain breakpoints.

### Test token refresh with Expire token

You'll fake an expired access token and watch how your app refreshes it.

1. Select an authenticated request in **Traffic** and click **Expire token…**.
2. Check **Requests to** (a glob; widen it, for example `https://api.example.com/*`, to expire every call) and
   **How many**, then click **Expire token**.
3. Use the app so it calls the API again.
4. Open the **Auth** tab.

**You should see:** a timeline per expiry: **Unauthorized**, **Refresh**, **Retry**, with timings. Click a step to
jump to it in **Traffic**.

**Tip:** a **stampede** warning means several refresh calls went out for one expiry, usually one per failed request.
Share a single in-flight refresh (one `Future`, or Dio's `QueuedInterceptor`). The **Auth** tab counts flows that
need attention.

### Record traffic and replay it

You'll save a session and later run the app against it, even offline.

1. Run the app through the flow you want, then open **Recordings** and click **Save current traffic**.
2. Name it. Tick **Redact secrets (Authorization, cookies, tokens)** if you'll share it; a replay then answers
   with `[redacted]`. Click **Save N exchanges**.
3. Later, click **Replay…** on the recording. Under **Requests not in the recording**, pick
   **Go to the real server** or **Fail like offline** (demo mode), then **Start replay**.
4. Click **Stop replay** in the bar at the top (or **Stop** on the recording) when you're done.

**You should see:** a "Replaying …" bar while it's on, and replayed rows marked as simulated.

**Tip:** recordings live in `.dart_tool/flutter_intercept/recordings/`, which git ignores by default. An
unredacted recording is refused where git would track it. Only finished HTTP exchanges are saved, not WebSocket,
SSE or native-client traffic. Your rules still apply before the recording.

### Compare two recordings

You'll see what a backend or app change did to the traffic.

1. Save a recording before the change and another after it.
2. In **Recordings**, tick both and click **Diff selected**.

**You should see:** a diff editor showing routes added or removed, status changes, JSON shape changes, call counts
and responses that got much slower.

**Tip:** **Clear selection** unticks both. To delete a recording, click its delete icon and confirm with
**Delete**; the file is removed from disk.

### Send requests to another server

You'll point the app at staging or a local backend without changing its URLs.

1. **Add rule**, set the URL (for example `https://api.example.com/*`) and pick **Map remote**.
2. In **Forward to**, enter an origin (`http://localhost:8080`) or a URL prefix
   (`https://staging.example.com/api`). The rest of the path and the query are kept.
3. Tick **Keep the original Host header** only if the target needs it, then **Add rule**.

**You should see:** the requests answered by the target, with a "Mapped to …" note, while the app still shows the
original URL. The target's certificate is checked as usual.

**Tip:** requests keep their headers, tokens included, so map only to servers you trust; the editor warns for
non-local targets. AI agents can only map to local servers (`localhost`, `127.0.0.1`, `::1`).

### Change headers, status or body text

You'll tweak real requests or responses without mocking them.

1. **Add rule**, set the URL and pick **Rewrite**.
2. Under **Request**: **Set headers**, **Remove headers** (comma separated) or **Replace in body**.
3. Under **Response**: a new **Status**, headers to set or remove, and body replacements.
4. **+ Add replacement** for more; tick **all** to replace every occurrence. Then **Add rule**.

**You should see:** the real server's answer with your changes, for example a feature-flag header added.

**Tip:** body replacements are plain text, not regexes (up to 20); binary bodies are left alone.

### Chain to Charles, Burp or a corporate proxy

You'll send Flutter Intercept's outgoing traffic through another proxy.

1. Open your **user** settings (not workspace settings) and set `flutterIntercept.upstreamProxy`, for example
   `http://127.0.0.1:8888`.
2. If that proxy decrypts HTTPS itself (Charles, Burp), also turn on
   `flutterIntercept.upstreamProxyIgnoreCertErrors`.

**You should see:** "via upstream proxy 127.0.0.1:8888" in the panel. With certificate checks off, it adds
"certificate checks OFF".

**Tip:** VS Code's own `http.proxy` setting doesn't apply to your app's traffic; use this setting instead. Only the
user setting counts, so a cloned repo can't reroute your traffic. Requests to `localhost` and the
emulator aliases go direct. Turn certificate checks off only for a proxy you run yourself.

### Open the traffic view in its own window

You'll move the traffic view to a second screen while the code stays in the main window.

1. In the panel's title bar, click **Open Traffic in New Window** (or run it from the Command Palette).
2. Drag the new window to another screen.

**You should see:** the same traffic, rules and recordings in a window of its own, with the request list and the
details side by side when it's wide enough.

**Tip:** **Open Traffic in Editor** opens it as an editor tab instead. Both copies stay in sync with the bottom
panel. Moving editors to a new window needs VS Code 1.85 or newer; older versions keep the tab.

### See where a request's time went

You'll find out whether a slow request waits on the network, the server or the download.

1. Make sure **Waterfall** is on in the panel toolbar.
2. Look at the **Waterfall** column: each bar sits where the request started and is split into phases. Hover it for
   the numbers.
3. Select a request and open the **Timing** tab.

**You should see:** rows for DNS, connect, TLS, sending, waiting (time to first byte) and downloading, plus time held
at a breakpoint or added by a simulated network, and the total. A reused connection is marked, with no DNS, connect
or TLS.

**Tip:** a long **waiting** phase is the server; long DNS, connect or TLS on every request means connections aren't
reused. Mocked requests only show the delay you set. HAR exports carry the same timings.

### Change requests and responses with a script

You'll write a few lines of JavaScript that change traffic in ways a rule can't.

1. **Add rule**, set the URL (for example `https://jsonplaceholder.typicode.com/todos/*`) and pick **Script (JS)**.
2. Click **Start from the template**, or write your own:

   ```js
   function onRequest(request, context) {
     request.headers['x-debug'] = '1';
     return request;
   }

   function onResponse(response, request, context) {
     const body = JSON.parse(response.body);
     body.title = body.title.toUpperCase();
     context.log('changed', request.url);
     return { ...response, body: JSON.stringify(body) };
   }
   ```

3. Click **Add rule** and use the app.

**You should see:** the changed traffic, and the script's log lines in the request's **Script log**.

**Tip:** `onRequest` can also return `{ response: { status, headers, body } }` to answer without contacting the
server. Hooks must finish quickly (200 ms) and can't use timers, the network, files or `require`. If a script
throws, the app gets a 502 and the log shows why. To share a script, pick **Edit script in a file**: shared
scripts wait for your approval, like other rules that change traffic. AI agents can't add, change or read scripts.

### Export traffic as OpenAPI or Postman

You'll turn what your app actually sent and received into an API description or a collection.

1. Use the app so the requests you want are in the list. Filter the list to export only some of them.
2. Click **Export…** in the toolbar and pick **OpenAPI 3.1**, **Postman collection** or **HAR**.
3. Choose **Redact secrets (recommended)** or **Keep values**, then where to save the file.

**You should see:** a file with one path per route (`/users/{id}`), its query parameters, and request and response
schemas inferred from every sample, with examples.

**Tip:** the commands **Export Traffic as OpenAPI** and **Export Traffic as Postman Collection** do the same from
the Command Palette. Keep values only for files that stay on your machine.

### Get notified when requests fail

You'll hear about failing requests even when the traffic panel is closed.

1. Close or hide the panel and use the app.
2. When a request fails (a network error or a 5xx), a notification names it.
3. Click **Show** to open the panel at that request, or **Turn off** to stop the notifications.

**You should see:** at most one notification every 10 seconds; failures in between are grouped
("3 requests failed — latest: …").

**Tip:** set `flutterIntercept.notifications` to `all` to include 4xx responses, or `off`. Failures you caused
yourself (mocks, blocks, faults, offline) are never reported.

### Run integration tests through Flutter Intercept in CI

You'll run `integration_test` on a device or CI runner with your shared rules and check the traffic.

1. Build the runner from this repository: `npm ci && npm run build`, then use
   `node packages/cli/dist/cli.js`.
2. From your Flutter project, run:

   ```bash
   node <repo>/packages/cli/dist/cli.js test integration_test/app_test.dart -d macos \
     --har build/traffic.har --assert test/traffic.expect.json --junit build/traffic.xml
   ```

3. Optional: `--replay <recording>` answers from a recording, `--network-profile slow-3g` slows the network,
   `--no-rules` ignores `.vscode/flutter-intercept.json`.

**You should see:** the normal `flutter test` output, then a summary of the traffic and the assertions. The exit
code is non-zero if a test or an assertion failed.

**Tip:** shared rules that need approval in the editor are skipped unless you pass `--approve-shared-rules`.
The expectations file is a list of `assert_traffic` checks, for example
`[{"url": "*/todos/*", "expect": {"status": 200}}]`. Works on macOS, Android emulators and phones, and
iOS simulators; not on physical iPhones or the web. See `packages/cli/README.md`.

### Run on an Android emulator or phone

You'll intercept an Android build.

1. **Emulator:** pick it and press **F5**. The app reaches the proxy at `10.0.2.2`; nothing to set up.
2. **Phone:** connect it over USB with USB debugging on, pick it and press **F5**. Flutter Intercept runs
   `adb reverse` for the proxy port and removes it when the last session ends.

**You should see:** traffic in the panel, the same as on any other target.

**Tip:** for phones, `adb` must be found through `ANDROID_HOME` / `ANDROID_SDK_ROOT`, the default SDK location,
or `PATH`. Hot reload, hot restart, flavors and `--profile` keep working; release launches are never
intercepted.

### Run on the iOS simulator or macOS

You'll intercept an Apple build that runs on your Mac.

1. **iOS simulator:** pick it and press **F5**. The app uses `localhost`; nothing to set up.
2. **macOS desktop:** pick **macOS** and press **F5**.

**You should see:** traffic in the panel, including HTTPS, with no certificate installed anywhere.

**Tip:** a macOS app needs the `com.apple.security.network.client` entitlement (in
`macos/Runner/DebugProfile.entitlements`). Any macOS app that already makes network calls has it.

### Run on a physical iPhone

You'll intercept an app running on your own iPhone over Wi-Fi.

1. Do the [one-time setup](#iphone): signing team in Xcode, trust the developer certificate on the phone.
2. Put the iPhone on the **same Wi-Fi** as your Mac, unlock it, pick it and press **F5**.
3. When the app starts, allow it to **find and connect to devices on your local network**.
4. On the Mac, allow **Visual Studio Code** to accept incoming connections the first time you're asked.

**You should see:** `Intercept: on · LAN` in the status bar and `LAN open for iPhone · <ip>:<port>` in the
panel's status line. The listener is protected by a per-session token and locks to your phone.

**Tip:** use a trusted Wi-Fi. After a network change the listener closes; relaunch the session. On Apple Silicon,
a USB iPhone needs Rosetta, or pair the phone over Wi-Fi.

### Call a server on your Mac from the app

You'll reach a backend running on your Mac, for example `http://localhost:8787`.

1. Start your local server.
2. In the app, use `http://10.0.2.2:8787/...` on the Android emulator, or `http://localhost:8787/...` on the
   iOS simulator, macOS or an Android phone.
3. Press **F5** and trigger the request.

**You should see:** the request in the list, answered by the server on your Mac.

**Tip:** `10.0.2.2` / `10.0.3.2` are sent to your Mac's `localhost` by `flutterIntercept.rewriteLocalhost` (on
by default). This never applies to a physical iPhone: requests aimed at your Mac are refused there.

### Connect an AI agent

You'll let an AI coding agent see and drive your app's traffic.

1. **GitHub Copilot (agent mode in VS Code):** nothing to set up. Open Chat in agent mode; the
   Flutter Intercept tools are listed in its tools picker. You can name one in a prompt, for example
   `#interceptListRequests`.
2. **Claude Code, Cursor, Windsurf, Gemini CLI or another MCP client:** run **Flutter Intercept: Connect AI
   Agent** and pick the client. The setup is copied to the clipboard; paste it into the client (for Windsurf, into
   `mcp_config.json`).
3. For Claude Code you can click **Add to Claude Code now** instead of pasting.

**You should see:** the panel's status line show the agent as connected, and its last tool call.

**Tip:** the copied setup contains your access token. Treat it like a password: don't commit or share it.
Inside Cursor, the server is also registered automatically.

### Teach your agent the workflow and give it tasks

You'll tell the agent how to use Flutter Intercept, then ask it to test something.

1. Run **Flutter Intercept: Add AI Agent Instructions** and pick `AGENTS.md`, `CLAUDE.md` and/or
   `.github/copilot-instructions.md`.
2. Ask the agent, for example:
   - "Run the app and check that the `POST /todos` request sends a JSON body with a title."
   - "Make `GET /users/1` return 500 once, check the error UI, then remove the mock."
   - "Where in the code is the album request sent?"
   - "Put the app on Slow 3G and check the loading state."
3. Approve the agent's changes when its client asks.

**You should see:** rules the agent adds named `[agent] …` with an **agent** badge, and its requests in the list.

**Tip:** running the command again updates the section in place. Ask agents to use `times` or `ttlMs` so their
rules clean themselves up.

### Control what agents can see and do

You'll choose how much access agents get.

1. Open your **user** settings (workspace settings are ignored for these) and search for
   `flutterIntercept.agent`.
2. Set `flutterIntercept.agent.access` to `readWrite` (default), `readOnly` (look, don't change) or `off`.
3. Keep `flutterIntercept.agent.redactSecrets` on to show agents `[redacted]` instead of auth headers, cookies,
   tokens, passwords and keys.

**You should see:** with `readOnly`, change requests refused; with redaction on, secrets hidden in everything
agents read, including HAR exports and code snippets.

**Tip:** redaction only affects what agents read; your app always gets the real values. Agents never see the CA
key, the iPhone LAN token or the MCP token.

### Let agents check models and verify changes

You'll have an agent debug a parsing error, break fields, write models and tests, and check its own work.

1. [Connect your agent](#connect-an-ai-agent), then run **Flutter Intercept: Add AI Agent Instructions** again
   to pick up the new tools.
2. Ask, for example:
   - "The profile screen fails with `type 'Null' is not a subtype of type 'String'`. Which field and model?"
     (`check_contract`)
   - "Make `email` null in the next `/users/*` response and check the app shows a fallback." (`add_mutation`)
   - "Generate a model for `GET /users/{id}` and a fixture test for it." (`generate_model`,
     `generate_fixture_test`)
   - "After my change, check that the app requests `/users/3` with a 200 and a string `$.email`."
     (`assert_traffic`)
3. MCP clients that support prompts also get ready-made ones: `debug-failing-request`, `test-error-states`,
   `verify-change` and `build-api-layer-from-traffic`. In Claude Code they're slash commands, such as
   `/mcp__flutter-intercept__verify-change`.

**You should see:** a pass/fail answer from `assert_traffic`, and generated files that the agent writes into your
project itself (the tools only return them).

**Tip:** agents match URLs with globs only (`*/users/*`), never regexes.

### Let agents read sockets, GraphQL and CORS

You'll have an agent work with the 0.5.0 traffic types.

1. [Connect your agent](#connect-an-ai-agent), then run **Flutter Intercept: Add AI Agent Instructions** again
   to pick up the new tools.
2. Ask, for example:
   - "Open the chat screen and check the WebSocket messages the app sends after login." (`get_frames`)
   - "List the GraphQL `CountryByCode` requests and mock that operation with an error." (`list_requests`,
     `add_mock` with a GraphQL operation)
   - "The web build fails with a CORS error on the API. Unblock it for local development." (`add_cors_rule`)
   - "Are any requests escaping the proxy?" (`get_status` reports background-isolate and native-client warnings)
3. Approve the changes when the client asks.

**You should see:** messages and events with secrets redacted, and rules scoped to one GraphQL operation.

**Tip:** agents don't see Chrome's own background requests unless they ask for them. A CORS rule an agent adds
allows only local pages and no credentials, unless it names an origin or asks for credentials.

### Let agents record, replay and run scenarios

You'll have an agent set up test scenarios and compare traffic for you.

1. [Connect your agent](#connect-an-ai-agent), then run **Flutter Intercept: Add AI Agent Instructions** again
   to pick up the new tools.
2. Ask, for example:
   - "Save a recording, then after my change save another and tell me what changed." (`save_recording`,
     `diff_recordings`)
   - "Replay the 'checkout' recording with everything else failing like offline." (`replay_recording`)
   - "Fail `GET /todos/*` twice with 500, then let it through, and check the retry." (`add_sequence`)
   - "Expire the token once and check the app refreshes it only once." (`expire_token`, `get_auth_flows`)
   - "Send `/api/*` to my local server on port 8080." (`add_map_remote`)
   - "Add `x-feature-beta: on` to requests to `/api/*`." (`add_rewrite`)
3. Approve the changes when the client asks.

**You should see:** the agent's rules named `[agent] …` in **Rules**, and a "Replaying …" bar while it replays.

**Tip:** agents save recordings redacted unless they ask otherwise, may only map to local servers, and can't set
request headers that carry credentials. Ask them to stop replaying and remove their rules when done.

### Let agents export, time and take screenshots

You'll have an agent document your API, chase slow requests and look at the screen.

1. [Connect your agent](#connect-an-ai-agent), then run **Flutter Intercept: Add AI Agent Instructions** again
   to pick up the new tools.
2. Ask, for example:
   - "Write an OpenAPI file for the requests the app made." (`export_openapi`)
   - "Give me a Postman collection of the checkout flow." (`export_postman`)
   - "Which requests took longer than a second, and where did the time go?" (`list_requests` with
     `slowerThanMs`, `get_request` timings)
   - "Open the profile screen and show me what it looks like." (`take_screenshot`)
3. Approve each screenshot when the client asks.

**You should see:** export files under `.dart_tool/flutter_intercept/exports/`, and screenshots under
`.dart_tool/flutter_intercept/screenshots/` with the requests made just before each one.

**Tip:** screenshots can show personal data on screen; turn them off with `flutterIntercept.agent.screenshots`.
Exports follow `flutterIntercept.agent.redactSecrets`.

## Settings and commands

| Setting | Default | Description |
|---|---|---|
| `flutterIntercept.enabled` | `true` | Route the HTTP traffic of Dart/Flutter debug sessions through Flutter Intercept. When off, sessions launch untouched. |
| `flutterIntercept.port` | `8899` | Port of the local proxy. If it's busy, the next free port up to 8999 is used. A change applies at the next launch when no intercepted session is running. |
| `flutterIntercept.agent.access` | `readWrite` | What AI agents may do: `readWrite`, `readOnly` or `off`. See [Use with AI agents](#use-with-ai-agents). |
| `flutterIntercept.agent.redactSecrets` | `true` | Show secrets (auth headers, cookies, tokens, passwords) to agents as `[redacted]`. |
| `flutterIntercept.agent.screenshots` | `true` | Let agents take screenshots of the running app (`take_screenshot`); each one asks for your confirmation. |
| `flutterIntercept.captureSource` | `true` | Record which line of your code made each request (see [Where a request came from](#features)). Applies at the next launch. Flutter sessions only: plain Dart programs can't take the setting (the Dart VM rejects `--dart-define`) and always record. |
| `flutterIntercept.web.enabled` | `true` | Intercept Flutter Web apps launched in Chrome from VS Code. |
| `flutterIntercept.nativeClients` | `profile` | List requests of native HTTP clients (cupertino_http, cronet_http) read-only from the app's HTTP profile, or `off`. |
| `flutterIntercept.backgroundIsolates` | `intercept` | Requests from background isolates (`compute`, `Isolate.run`, `Isolate.spawn`) go through Flutter Intercept too, in debug sessions. `warn` only tells you about them. |
| `flutterIntercept.notifications` | `errors` | Notify when the app's requests fail while the panel is hidden: `errors` (network errors, 5xx), `all` (also 4xx) or `off`. |
| `flutterIntercept.contractCheck` | `true` | Check JSON responses against your json_serializable / freezed models and show fields that would make `fromJson` throw. |
| `flutterIntercept.rewriteLocalhost` | `true` | Requests to `10.0.2.2` / `10.0.3.2` (the emulator's names for your Mac) go to your Mac's `localhost`. Never applies to iPhones. |
| `flutterIntercept.agent.mcpPort` | `47823` | Port of the local MCP server for agents. If it's busy, the next free port is used. |
| `flutterIntercept.upstreamProxy` | empty | Send intercepted traffic on through another HTTP proxy, such as Charles or Burp at `http://127.0.0.1:8888`, or a corporate proxy. Empty = connect to servers directly. Requests to `localhost` and the emulator aliases always go direct. |
| `flutterIntercept.upstreamProxyIgnoreCertErrors` | `false` | Accept any certificate from servers reached through the upstream proxy. Only for a proxy that decrypts HTTPS itself (Charles, Burp). The panel shows "certificate checks OFF" while it's on. |

`flutterIntercept.upstreamProxy`, `flutterIntercept.upstreamProxyIgnoreCertErrors` and the `flutterIntercept.agent.*`
settings are read from your **user** settings only. A workspace's `.vscode/settings.json` can't set them, so a
cloned project can't reroute your traffic or widen agent access.

| Command | What it does |
|---|---|
| **Flutter Intercept: Open Traffic Panel** | Shows the Traffic panel. It also opens by itself on the first intercepted session. |
| **Flutter Intercept: Open Traffic in Editor** | Opens the traffic view as an editor tab. |
| **Flutter Intercept: Open Traffic in New Window** | Opens the traffic view in a window of its own (VS Code 1.85+). |
| **Flutter Intercept: Export Traffic as OpenAPI** / **as Postman Collection** | Writes the recorded traffic to an OpenAPI 3.1 file or a Postman collection. |
| **Flutter Intercept: Toggle Interception** | Same as clicking `Intercept: on/off` in the status bar. |
| **Flutter Intercept: Clear Traffic** | Clears the list. Requests still in flight stay. |
| **Flutter Intercept: Debug with Intercept** | Starts an intercepted debug session directly. A fallback if F5 isn't picked up. |
| **Flutter Intercept: Connect AI Agent** | Copies the setup for Claude Code, Cursor, Windsurf, Gemini CLI or another MCP client to the clipboard. |
| **Flutter Intercept: Add AI Agent Instructions** | Adds or updates the Flutter Intercept section in `AGENTS.md`, `CLAUDE.md` or `.github/copilot-instructions.md`. |

## Limitations

What isn't intercepted, or behaves differently while intercepting:

- **Flutter web**: only on Chrome launched from VS Code (not the `web-server` device). There is no direct
  fallback: if the proxy stops, the page loses network until you restart the session.
- **Native HTTP stacks**: `cronet_http`, `cupertino_http`, `native_dio_adapter` bypass `dart:io`. Their requests
  are listed read-only (from the app's HTTP profile) but can't be mocked, paused or blocked.
- **Background isolates**: intercepted in debug sessions only. In profile mode, and for isolates started with
  `Isolate.spawnUri`, their requests go direct and a banner tells you. Requests from very short-lived isolates may
  have no source line.
- **Apps that install their own `HttpOverrides` zone** (`HttpOverrides.runWithHttpOverrides` or `runZoned`
  around their code): the inner zone wins.
  - Setting `HttpOverrides.global` is fine: your overrides still apply underneath.
  - Setting `findProxy` on a client is also fine: Flutter Intercept ignores the assignment and prints a note.
- **Dio `validateCertificate` pinning**: Dio checks the certificate it receives, which is the proxy's, so those
  requests fail with `bad certificate` while intercepting. Turn interception off to test pinning.
- **mTLS (client certificates)**: the proxy can't present your app's client certificate to the server.
- **A custom `connectionFactory`** that ignores the proxy host and port bypasses the proxy.
- **Throttling** doesn't slow down uploads or WebSocket messages. On WebSockets only block and fault rules apply (to the connection); mocks, breakpoints and mutations pass sockets through.
- **Long breakpoints and client timeouts**: if your app's own timeout fires while a request is paused (for
  example Dio's `receiveTimeout`), the app gives up. The exchange is then marked "gave up" and can't be resumed.
  Raise the timeout in debug builds if you need long pauses.
- **Recordings** hold finished HTTP exchanges only: WebSocket, SSE and native-client traffic isn't saved or
  replayed.
- **Rewrite** body replacements are plain text (no regexes, up to 20 per body); binary bodies are left untouched.
- **Shared rules** that could redirect or alter your traffic, and every shared script, don't run on a machine until
  they're approved there.
- **Scripts** are synchronous, get 200 ms per call and no timers, network, files or modules. Bodies over 1 MB or
  binary bodies reach them as omitted. They don't apply to WebSockets.
- **Screenshots** capture Flutter's own content (not the status bar or native dialogs) when taken through the debug
  connection; on macOS desktop, web and physical iPhones they need that connection.
- **What the panel keeps**: bodies are shown up to 5 MB, after which they're marked truncated. Recorded traffic
  is cleared when the window reloads; rules are kept.

## Security

- **Loopback only, except during iPhone sessions.** The proxy listens on `127.0.0.1`. Only while a physical
  iPhone session runs does it also listen on your Mac's private LAN address. That listener requires the session's
  secret token, locks to the first device that connects with it, and refuses requests aimed at the Mac itself.
  It closes when the session ends or the network changes (see [iPhone](#iphone)).
  - **Use it on a trusted Wi-Fi.** On shared or public Wi-Fi, others may observe the token.
  - **The token reaches disk.** It is a build define, so `flutter_tools` writes it into
    `ios/Flutter/Generated.xcconfig` and `ios/Flutter/flutter_export_environment.sh` (both gitignored by default)
    and into the debug app. It is only usable while that session's listener is open, and only from the device it
    locked to.
- **AI agent access is local and gated.** The MCP server for agents listens on `127.0.0.1` only.
  - Every request must carry a secret token, which is kept in VS Code's secret storage. Requests from browsers
    (an `Origin` header or a foreign `Host`) are refused.
  - Changes need your confirmation, and `flutterIntercept.agent.access` can make access read-only or turn it off.
  - Secrets are redacted in everything agents read. See [Use with AI agents](#use-with-ai-agents).
- **Rules from a repository can't silently reroute your app.** Shared rules in `.vscode/flutter-intercept.json`
  that send requests to another server, change request headers or bodies, redirect, serve HTML or JavaScript, or
  set cookies or CORS headers are held until you approve them; a changed rule is held again. Sharing refuses
  rules and mock body files that look like they hold real credentials.
- **Routing settings are yours.** The upstream proxy and agent settings are read from user settings only, and AI
  agents can only map requests to local servers.
- **Recordings stay on your machine.** They're saved in `.dart_tool/flutter_intercept/recordings/`; an
  unredacted recording is refused where git would track it.
- **Only sessions you launch from VS Code** while interception is on.
  - It doesn't attach to running apps.
  - It leaves test runs alone. Flutter Web is intercepted only on the Chrome and Edge devices, through the
    browser that `flutter` starts with its own temporary profile. The `web-server` device and launches that
    open Chrome on your own profile (`--user-data-dir`) are left alone.
  - It never intercepts release launches.
- **The app trusts one certificate authority.** It doesn't accept arbitrary certificates.
  - On first use the extension creates a CA unique to your installation. It's stored in VS Code's extension
    storage on your Mac, readable only by your user.
  - The generated launcher makes the app trust that CA in intercepted sessions. Nothing is installed in any
    system trust store.
  - If the proxy isn't reachable, the `DIRECT` fallback keeps normal TLS verification.
- **Your own pinning:**
  - While the proxy is up, pinning via `badCertificateCallback` or `SecurityContext(withTrustedRoots: false)`
    doesn't block interception.
  - With the proxy down, your pinning behaves exactly as without the tool.
  - Dio `validateCertificate` pinning still fails while intercepting (see Limitations).
- **The real server's certificate is still verified.** By default the proxy checks it, so a bad certificate
  upstream still fails, and the app gets a `502` that carries the error.

## Requirements

- VS Code 1.90 or newer.
- The [Dart extension](https://marketplace.visualstudio.com/items?itemName=Dart-Code.dart-code)
  (`Dart-Code.dart-code`). It's installed automatically as a dependency, and it's what F5 runs.
- A Flutter SDK (or Dart SDK for console apps). The generated launcher is tested with Dart 3.0 to 3.13
  (Flutter 3.10 and newer).
- For Android physical devices: `adb` (part of the Android SDK platform-tools).
- For iPhones: Xcode with a signing team (see [iPhone](#iphone)).
