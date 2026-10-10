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
- Reorder, enable/disable, delete with undo. Rules are saved per workspace.
- A rule can apply to **only the first N requests** or **expire** after a time; it removes itself afterwards.

![Rules tab: ordered rules with enable toggles and match counts](media/screenshots/rules-dark.png)

**Status bar**
- `Intercept: on/off` toggles interception for new sessions. It shows `· LAN` while an iPhone session runs.
- A pause counter appears while exchanges are waiting at a breakpoint.

The panel follows your VS Code theme: light, dark and high contrast.

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
| **Flutter web** | Not supported (no `dart:io`). The session is left untouched. |

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
Cursor, and any client that speaks MCP (Model Context Protocol).

| What the agent can do | Tool |
| --- | --- |
| See whether the proxy and app sessions are running | `get_status` |
| List recent requests (filter by URL, method, status, state) | `list_requests` |
| Read one request in full (headers, bodies, timings, error) | `get_request` |
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

Over MCP there are also resources (`intercept://exchange/{id}`, `intercept://paused`, `intercept://rules`,
`intercept://contract/{id}`) and prompts (`debug-failing-request`, `test-error-states`, `verify-change`,
`build-api-layer-from-traffic`).

`get_request` can also return the request as a cURL, Dart http or Dio snippet. `add_mock`, `add_block` and
`add_breakpoint` take `times` and `ttlMs`, so rules an agent adds can clean themselves up.

In VS Code the tools are named `flutter_intercept_<tool>`; over MCP they use the names above.

### Connecting

- **GitHub Copilot (agent mode in VS Code):** nothing to set up. The tools are available as soon as the extension
  is installed.
- **Claude Code, Cursor and other MCP clients:**
  1. Run **Flutter Intercept: Connect AI agent** and pick your client.
  2. The command copies the setup to the clipboard: the `claude mcp add …` command for Claude Code, an
     `mcp.json` snippet for Cursor, or the URL and header for other clients.
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

**Devices**

14. [Run on an Android emulator or phone](#run-on-an-android-emulator-or-phone)
15. [Run on the iOS simulator or macOS](#run-on-the-ios-simulator-or-macos)
16. [Run on a physical iPhone](#run-on-a-physical-iphone)
17. [Call a server on your Mac from the app](#call-a-server-on-your-mac-from-the-app)

**AI agents**

18. [Connect an AI agent](#connect-an-ai-agent)
19. [Teach your agent the workflow and give it tasks](#teach-your-agent-the-workflow-and-give-it-tasks)
20. [Control what agents can see and do](#control-what-agents-can-see-and-do)

### Run your app with interception

You'll install the extension and see your app's requests in VS Code.

1. Install **Flutter Intercept** from the Marketplace. VS Code also installs the Dart extension it needs.
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
   - `state:paused` (also `mocked`, `blocked`, `error`, `simulated`, `resent`), `src:login_page.dart`.
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

**Tip:** a delete can be undone with **Undo** in the notice that appears. Rules are saved per workspace.

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
2. **Claude Code, Cursor, Gemini CLI or another MCP client:** run **Flutter Intercept: Connect AI Agent** and pick
   the client. The setup is copied to the clipboard; paste it into the client.
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

1. Open Settings and search for `flutterIntercept.agent`.
2. Set `flutterIntercept.agent.access` to `readWrite` (default), `readOnly` (look, don't change) or `off`.
3. Keep `flutterIntercept.agent.redactSecrets` on to show agents `[redacted]` instead of auth headers, cookies,
   tokens, passwords and keys.

**You should see:** with `readOnly`, change requests refused; with redaction on, secrets hidden in everything
agents read, including HAR exports and code snippets.

**Tip:** redaction only affects what agents read; your app always gets the real values. Agents never see the CA
key, the iPhone LAN token or the MCP token.

## Settings and commands

| Setting | Default | Description |
|---|---|---|
| `flutterIntercept.enabled` | `true` | Route the HTTP traffic of Dart/Flutter debug sessions through Flutter Intercept. When off, sessions launch untouched. |
| `flutterIntercept.port` | `8899` | Port of the local proxy. If it's busy, the next free port up to 8999 is used. A change applies at the next launch when no intercepted session is running. |
| `flutterIntercept.agent.access` | `readWrite` | What AI agents may do: `readWrite`, `readOnly` or `off`. See [Use with AI agents](#use-with-ai-agents). |
| `flutterIntercept.agent.redactSecrets` | `true` | Show secrets (auth headers, cookies, tokens, passwords) to agents as `[redacted]`. |
| `flutterIntercept.captureSource` | `true` | Record which line of your code made each request (see [Where a request came from](#features)). Applies at the next launch. Flutter sessions only: plain Dart programs can't take the setting (the Dart VM rejects `--dart-define`) and always record. |
| `flutterIntercept.contractCheck` | `true` | Check JSON responses against your json_serializable / freezed models and show fields that would make `fromJson` throw. |
| `flutterIntercept.rewriteLocalhost` | `true` | Requests to `10.0.2.2` / `10.0.3.2` (the emulator's names for your Mac) go to your Mac's `localhost`. Never applies to iPhones. |
| `flutterIntercept.agent.mcpPort` | `47823` | Port of the local MCP server for agents. If it's busy, the next free port is used. |

| Command | What it does |
|---|---|
| **Flutter Intercept: Open Traffic Panel** | Shows the Traffic panel. It also opens by itself on the first intercepted session. |
| **Flutter Intercept: Toggle Interception** | Same as clicking `Intercept: on/off` in the status bar. |
| **Flutter Intercept: Clear Traffic** | Clears the list. Requests still in flight stay. |
| **Flutter Intercept: Debug with Intercept** | Starts an intercepted debug session directly. A fallback if F5 isn't picked up. |
| **Flutter Intercept: Connect AI agent** | Copies the setup for Claude Code, Cursor or another MCP client to the clipboard. |
| **Flutter Intercept: Add AI Agent Instructions** | Adds or updates the Flutter Intercept section in `AGENTS.md`, `CLAUDE.md` or `.github/copilot-instructions.md`. |

## Limitations

What isn't intercepted, or behaves differently while intercepting:

- **Flutter web**: it has no `dart:io`.
- **Native HTTP stacks**: `cronet_http`, `cupertino_http`, `native_dio_adapter`. They bypass `dart:io`.
- **Background isolates** (`compute`, `Isolate.spawn`): `HttpOverrides` apply per isolate, so clients created
  there go direct.
- **Apps that install their own `HttpOverrides` zone** (`HttpOverrides.runWithHttpOverrides` or `runZoned`
  around their code): the inner zone wins.
  - Setting `HttpOverrides.global` is fine: your overrides still apply underneath.
  - Setting `findProxy` on a client is also fine: Flutter Intercept ignores the assignment and prints a note.
- **Dio `validateCertificate` pinning**: Dio checks the certificate it receives, which is the proxy's, so those
  requests fail with `bad certificate` while intercepting. Turn interception off to test pinning.
- **mTLS (client certificates)**: the proxy can't present your app's client certificate to the server.
- **A custom `connectionFactory`** that ignores the proxy host and port bypasses the proxy.
- **Throttling and faults** don't slow down uploads and don't apply to WebSockets.
- **Long breakpoints and client timeouts**: if your app's own timeout fires while a request is paused (for
  example Dio's `receiveTimeout`), the app gives up. The exchange is then marked "gave up" and can't be resumed.
  Raise the timeout in debug builds if you need long pauses.
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
- **Only sessions you launch from VS Code** while interception is on.
  - It doesn't attach to running apps.
  - It leaves test runs and web sessions alone.
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
