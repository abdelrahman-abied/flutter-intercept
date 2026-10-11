# Review 9: v0.9.0 security (independent, `feature/0.9.0` at 6e724df) — findings and fix plan

Scope: everything since `main` (`git diff main..HEAD -- . ':!samples/demo_app/ios' ':!package-lock.json'`). That covers:
- the sidecar (`packages/sidecar/src/**`): `uiServer.ts` (one-time URLs, session cookie, page, WebSocket), `host.ts`
  (composition, `ui.*` requests, approvals, launches, sessions, MCP), `rpc.ts`, `launch.ts`, `vm.ts`, `settings.ts`,
  `state.ts`, `sharedRules.ts`, `contract.ts`, `theme.ts`, `build.mjs`;
- the plugin core (`packages/intellij/.../{sidecar,core,ui,settings,toolwindow,actions,status}/**`): `SidecarProcess`,
  `NodeLocator`, `JsonLineRpc`, `UiRequestHandler`, `ConfirmDialog`, `PathGuard`, `Notifications`, `JcefBridge`,
  `InterceptToolWindow`, `InterceptSettings`, `ClientCertificates`, the actions, `plugin.xml`;
- the run integration (`run/**`, `flutter-intercept-run.xml`): `InterceptFlutterRunner`, `InterceptLaunchService`,
  `SessionWatcher`, `DaemonEvents`, `RunArgs`, the Run / Debug with Flutter Intercept actions;
- the webview's standalone mode (`webview/src/host.ts`, `main.tsx`, `App.tsx`, `Toolbar.tsx`).

The demo's `project.pbxproj` change (local signing) stays uncommitted. Spec: CONTRACTS §15 incl. §15.4, earlier
guarantees §7, §8, §12.1, REVIEW-6/7/8. Run integration: docs/spikes/intellij-run.md.

I read the code. I also ran:
- the sidecar's `test/uiServer.test.ts` (4/4 pass);
- a throwaway probe in the session scratchpad: an esbuild bundle of the real `uiServer.ts` plus a non-browser client
  (Node 26), outside the repo;
- a look inside the locally installed Flutter plugin jar (97.0.0), read only, to check how it logs launch command lines.
  The result was inconclusive, see #7.

I did not build, run Gradle, start an IDE, run Flutter or touch devices.

Threat model as in REVIEW-1 to REVIEW-8:
- a malicious cloned repo;
- a malicious or prompt-injected agent that only has our tools;
- a malicious app under debug;
- hostile servers and web pages;
- other local users and processes.

New in 0.9.0:
- **The traffic UI is now a loopback web origin.** In Android Studio it is the main path, opened in the user's everyday
  system browser.
- Any web page in that browser and any other service on `127.0.0.1` count as attackers.
- **Browsers do not isolate cookies by port** (RFC 6265 §8.5). Every `http://127.0.0.1:<any port>` shares the cookie
  jar, and same-site rules treat all those ports as one site.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MEDIUM | **The UI session cookie works as a long-lived bearer and isn't port-isolated.** `fi_session_<port>` is a host-only cookie for `127.0.0.1` with no lifetime, valid until the sidecar exits. The browser sends it to every `127.0.0.1` port it talks to: navigations, and same-site subresources from any page on `127.0.0.1:*`. Whoever listens there gets it, for example another local user's listener. With the cookie alone, a non-browser client fetches `/`, reads `__FI_WS__` (a token fixed for the whole sidecar run) and opens the WebSocket with a forged `Origin`. That is full control of the UI, and see #2 for what that gives. **Probe** below. | S + W + lead |
| 2 | LOW-MED | **A UI session can do anything up to code execution, and nothing in the IDE confirms it.** Every `ViewMsg` is privileged, and §15 makes the WebSocket the only gate. `openBodyFile {create}` writes up to 5 MB of chosen content at any project-relative path, creating folders. Example: `android/buildSrc/build.gradle`, which Gradle runs at the next sync or build. Inline personal scripts are "trusted code, not a sandbox" (`script.ts`). `send` goes out with the user's client certificates. The snapshot carries the full unredacted traffic. In VS Code only our own webview could reach these. In 0.9.0, any leak of #1 / #3 gives all of them. | S + lead |
| 3 | LOW-MED | **The one-time URL appears in other users' process lists while the browser launches.** `BrowserUtil.browse(url)` passes `http://127.0.0.1:<port>/?t=<token>` on a command line. On Linux, `xdg-open` and a cold-started browser keep it in `/proc/<pid>/cmdline`, readable by every local user, for the one to three seconds before the page loads. On macOS, `open` shows it briefly. A local user who polls `ps` can redeem it first. They get the session (#1, #2), and the user sees "already used" and simply opens the view again. | K (+ S) |
| 4 | LOW | **After a sidecar restart, the JCEF navigation guard still trusts the old origin.** `JcefBridge.create(…, init.uiOrigin, …)` is set up once per tool window, and the restarted sidecar listens on a new random port. Every later `loadFresh()` is then "external": `onBeforeBrowse` cancels it and sends the fresh one-time URL to the system browser. This happens on its own after each crash restart, in every open project window, while the tool window stays blank. It moves the UI into the browser (#1, #3) without the user asking, in IntelliJ IDEA where JCEF exists. | K |
| 5 | LOW | **The Node probe runs in the IDE's working directory, where version-manager shims pick the binary.** `nodeVersionOutput` (`NodeLocator.kt:102`) starts `<candidate> --version` with no working directory. The candidate list includes `~/.asdf/shims`, mise shims and Volta, which resolve the version from the current directory's `.tool-versions` / `mise.toml` / `package.json`. It also includes relative `PATH` entries, which resolve against the IDE's working directory. When the IDE is started from a cloned repo's directory (`studio.sh` / `idea .` on Linux), the repo chooses what runs. asdf's `nodejs path:<dir>` runs any binary. §15.2 says "Node path from settings only (never from the project)". The sidecar itself runs in the plugin directory, so only the probe is affected. | K |
| 6 | LOW | **The cookie can be shadowed or evicted, and a HEAD request burns a one-time link.** Any page or service on `127.0.0.1:*` can set `fi_session_<port>=x; Path=/ws` (sent first; `cookieValue` takes the first match) or flood the jar, which logs the user out. A HEAD request (link previews, prefetchers) redeems the token. Both are denial of service only, and the fix for #1 removes them. | S |
| 7 | INFO | Smaller items: web screenshots always fail (`webLaunchUrl` dropped); a new passphrase isn't applied; mismatched `unknown-method` / `unknown_method` codes; the MCP token is a plain file, not PasswordSafe; `dataDir` lives under the IDE's cache-like system path; LAN token in launch args (console / idea.log not verified); the dev system property `flutter.intercept.sidecar`; Enter means "Approve" in the approval dialog; browser extensions; no `X-Frame-Options`. | various |

## Details

### 1 (MEDIUM) The UI session cookie works as a long-lived bearer and isn't port-isolated

What the code does (`uiServer.ts`):
- `:282` redeems the one-time link and answers
  `Set-Cookie: fi_session_<port>=<32 random bytes>; HttpOnly; SameSite=Strict; Path=/`. It has no `Max-Age` and is
  host-only for `127.0.0.1`. The server keeps up to 64 sessions and never expires them before the sidecar exits.
- `:285` serves `/` to anyone who has that cookie. The page embeds `window.__FI_WS__ = "ws://…/ws?t=<token>"`
  (`:121`), and `this.token` is one value per sidecar run (`:140`).
- `:304`: the upgrade accepts the cookie **or** that token. The `Origin` / `Host` checks stop browsers, but a local
  non-browser client sends any headers it likes.

Probe (real `UiServer`, non-browser client):

```
redeem: 302 | Set-Cookie attributes: fi_session_58346=<value>; HttpOnly; SameSite=Strict; Path=/
GET / with only the cookie: 200 | page embeds __FI_WS__ token: true
WS with cookie + forged Origin: open; controller received [{"type":"setRules","rules":[]}]
WS with the page token only: open (token is fixed for the sidecar run, same value as server.token: true )
GET / with Origin http://127.0.0.1:9999: 403
```

How the cookie leaves the browser:
- Cookies ignore the port, and `SameSite` treats `http://127.0.0.1:A` and `http://127.0.0.1:B` as the same site.
- The browser therefore attaches the cookie to:
  - every top-level navigation to any `http://127.0.0.1:<port>` (typed, bookmarked, clicked in a terminal or the IDE
    console, opened by another app);
  - every subresource request to such a port from a page on `127.0.0.1:*`. That includes a Flutter Web app served on
    `127.0.0.1`, any local dev server, notebook or doc server, and a malicious repo's HTML opened through
    `python -m http.server`.
- Whoever listens on that port receives the header: another local user's process, or any service that logs request
  headers.
- `HttpOnly` only stops page JavaScript. Browser extensions with host access to `127.0.0.1` can read it too (#7).

What it gives: the cookie leads to the page, then to the WebSocket token, then to everything in #2, for as long as the
sidecar runs. That is usually the whole IDE session, and browser session restore keeps the cookie across browser
restarts. A web page alone can't do it: cross-site requests from the internet don't carry the Strict cookie, and
WebSockets from other origins are refused (403).

**Fix (S + W + lead), amends §15.4:**
- Drop the cookie. `GET /?t=<one-time>` answers `200` with the page itself, not a 302.
  - The used token left in history is worthless.
  - The webview already strips `?t=` with `replaceState`.
  - A reload shows the "open it again from the IDE" page. JCEF reloads already use `loadFresh()`.
- Serve `webview.js`, `webview.css` and `theme.css` without credentials. They are public bundle content; keep the
  `Host` check, CORP and `nosniff`.
- Mint a **per-page** WebSocket secret with each page, and accept upgrades only with it (no cookie path).
  - Revoke it when its page's last socket has been closed for more than about 30 s, so reconnects within the backoff
    still work.
  - One leaked secret then exposes one page, not the whole run.
- If a cookie is kept anyway: `Max-Age=60` and valid for one `/` load only, with the WebSocket token still per page.
- Tests:
  - `/` without a fresh one-time token → 403;
  - the WebSocket secret of page A no longer works after A has been gone for 30 s;
  - two page loads get different secrets;
  - no `Set-Cookie` header on any response.

### 2 (LOW-MED) A UI session can do anything up to code execution, and nothing in the IDE confirms it

The controller is unchanged from VS Code, where only our own webview could send `ViewMsg`s. Over the sidecar
WebSocket:
- **`openBodyFile` with `create`** (`controller.ts:1251` → `host.ts:832`):
  - `checkBodyFile` only refuses absolute paths and `..`;
  - `bodyFileSecretProblem` only refuses credentials in the content;
  - the host then creates the missing folders and `writeFileSync(abs, content, {flag: 'wx'})` (`:859`) anywhere in
    the project, up to 5 MB.
  - New files that run code with no further prompt: `android/buildSrc/build.gradle(.kts)` (Gradle compiles `buildSrc`
    on the next sync, and Android Studio syncs on its own), `pubspec_overrides.yaml` pointing a dependency at a path
    package with `hook/build.dart` (runs on the next `flutter run`), and `.vscode/tasks.json` for a teammate on VS
    Code.
- **Inline personal script rules** (`setRules`) run in the proxy's worker. `script.ts` says: "Trusted code, NOT a
  security sandbox". They see and rewrite every request, credentials included.
- **`send`** makes arbitrary requests through the proxy, including to mTLS hosts with the user's certificate.
- **`ready`** returns the full unredacted traffic: tokens, cookies, bodies.
- The rest asks first or stays bounded:
  - `export` / `saveRecording` go through IDE dialogs;
  - `openSource` / `openViolation` are limited by `checkSourcePath` and `PathGuard`;
  - shared-rule approval is an IDE modal (`ui.confirm`) that a browser can't click.

So any leak of #1 or #3, or a future XSS in the webview, which now runs in a normal browser profile, becomes code
execution as the user.

**Fix (S + lead), defence in depth:**
- `create` without a confirm only under `.vscode/flutter-intercept/` (the `mocks/` and `scripts/` folders). Anywhere
  else, ask first with `ui.confirm` (modal, in the IDE): "Create <path> in <project>?".
- Always refuse `.git/**`, `.idea/**`, `buildSrc/**`, `*.gradle*`, `pubspec*.yaml`, `analysis_options.yaml`,
  `build.yaml` and dotfiles outside `.vscode/flutter-intercept/`.
- Keep the IDE-side modals for everything that writes outside the project (already the case).
- Tests:
  - `openBodyFile {path: 'android/buildSrc/build.gradle', create}` → refused, or asks `ui.confirm` and writes nothing
    on Cancel;
  - `.vscode/flutter-intercept/mocks/x.json` → created as before.

### 3 (LOW-MED) The one-time URL appears in other users' process lists while the browser launches

`InterceptToolWindow.kt:130` calls `BrowserUtil.browse(url)` with the token URL. What happens next depends on the OS:
- **Linux:** `xdg-open <url>`, then `<browser> <url>`. When the browser is not already running, the URL stays in the
  browser's argv (`/proc/<pid>/cmdline`, world-readable unless `/proc` is mounted with `hidepid`) through the cold
  start, typically one to three seconds before the page is requested.
- **macOS:** `/usr/bin/open <url>` is visible for its short lifetime. LaunchServices then hands the URL over by Apple
  Event.
- **Windows:** other users can't read command lines without admin.

A local user who polls `ps` / `/proc` redeems the link first and holds a session (#1, #2). The victim sees the
"already used" page and simply clicks again. Single use and the 60 s lifetime don't help against this race.

**Fix (K + S):**
- Don't put the token on a command line. Do as Jupyter does:
  - write `open-<random>.html` (0600) into `dataDir` (0700); it carries the URL and does
    `location.replace(url)`, or auto-submits a `POST` form so the token never enters history;
  - browse `file://…/open-<random>.html`;
  - delete the file after 60 s.
  - This needs #1's cookieless flow. A Strict cookie set on a redirect that started cross-site from `file:` is not sent
    on the next hop.
- Also prefer JCEF wherever it exists (#4).
- Test: the URL `freshUiUrl` hands to the launcher contains no `t=`, and the redirect file is 0600 and removed.

### 4 (LOW) After a sidecar restart, the JCEF navigation guard still trusts the old origin

What the code does:
- `InterceptToolWindowPanel.showUi` creates the browser once (`InterceptToolWindow.kt:96`). `installNavigationGuard`
  captures `allowedOrigin` at that moment (`JcefBridge.kt:41`).
- On `ready` after a crash restart, `showUi` reuses the browser and calls `loadFresh()` with a URL on the **new**
  port.
- `onBeforeBrowse` also fires for `loadURL`. `isInternal` fails, so the guard returns `true` (cancel) and
  `openExternally(target)` runs `BrowserUtil.browse(<one-time URL>)`.

Result:
- every project window opens a browser tab by itself after each restart, and again on every theme change;
- the tool window stays blank.

That moves IntelliJ IDEA users onto the browser path (#1, #3) without asking.

**Fix (K):**
- Keep the allowed origin in a field the guard reads on each call, updated in `showUi`. Or dispose and recreate the
  browser when `init.uiOrigin` changes.
- Never hand the UI's own one-time URLs to `openExternally`: a URL starting with `http://127.0.0.1:<sidecar port>`
  stays internal or is dropped.
- Test: `isInternal` with an origin provider, and a `ready` with a new port keeps the navigation inside JCEF.

### 5 (LOW) The Node probe runs in the IDE's working directory

What the code does:
- `NodeLocator.searchDirs` lists the shell `PATH` entries first, then the usual install folders, including
  `~/.asdf/shims`, `~/.local/share/mise/shims` and `~/.volta/bin`.
- `nodeVersionOutput` (`:102`) runs `ProcessBuilder(node, "--version")` with no `directory()`, so it inherits the IDE
  process's working directory. That is `/` when started from the Dock, but **the repo** when started as
  `studio.sh .` / `idea .` / `idea.sh` from a shell in the clone.
- Shims resolve the version from that directory:
  - asdf `.tool-versions` accepts `nodejs path:<dir>` and runs `<dir>/bin/node`;
  - mise reads `.tool-versions` / `mise.toml`;
  - Volta reads `package.json` `volta.node` and downloads that version.
- A relative `PATH` entry such as `.` or `node_modules/.bin` gives `File(dir, "node")` relative to the same working
  directory.
- The sidecar itself runs with `directory(script.parentFile)`, so only the probe is affected. That is still code from
  the project running as the user, which §15.2 rules out.

**Fix (K):**
- Run the probe with `.directory(<plugin dir or user home>)`, the same as the sidecar.
- Skip relative `PATH` entries.
- For shim directories, resolve the real binary from a neutral directory (`asdf which node` / `mise which node` with
  cwd = home), or list shims after the real install folders.
- Tests:
  - `searchDirs` drops relative entries;
  - `nodeVersionOutput` is called with a fixed working directory (inject the process factory).

### 6 (LOW) The cookie can be shadowed or evicted, and a HEAD request burns a one-time link

- `cookieValue` returns the first `fi_session_<port>`.
  - Any `127.0.0.1:*` page (`document.cookie`) or service (`Set-Cookie`) can add `fi_session_<port>=x; Path=/ws`,
    which browsers send first.
  - Or it can overflow the per-host cookie limit and evict ours.
  - The user's page or WebSocket then fails with 403 until the view is opened again from the IDE.
- A `HEAD /?t=` (URL previews, prefetchers, security scanners) redeems and wastes the link.
- Both are denial of service only. #1's cookieless design removes the first. Redeem on `GET` only, and answer `HEAD`
  with 405, to fix the second.

### 7 (INFO)
- **Web screenshots:** `host.ts:507` passes `appUrl: () => undefined`. The plugin sends `webLaunchUrl` in
  `sessionStarted`, but the sidecar drops it, so `take_screenshot` on Flutter Web always fails. It fails closed, so not
  a security issue. Store `webLaunchUrl` per session, after `loopbackOrigin` validation, the way VS Code does.
- **Passphrase not applied:** `SetPassphraseAction` calls `pushSettings()`, but `applySettings` reloads certificates
  only when `clientCertificates` changed (`host.ts:685`). A new passphrase therefore takes effect only at the next
  restart or settings change. Add a `clientCertificatesChanged` request, or reload on `settings` when the plugin says
  so.
- **Error codes:** the plugin answers unknown requests with `unknown-method`; the sidecar checks `unknown_method`
  (`host.ts:662`). Align them.
- **MCP token storage:** a 0600 file in `dataDir` (`loadMcpToken`). VS Code keeps it in SecretStorage, and §15.2 puts
  passphrases in PasswordSafe. Acceptable (owner-only, next to the CA key), but say so in §15.2, or store it in
  PasswordSafe and pass it in `init`.
- **`dataDir` location:** `PathManager.getSystemPath()/flutter-intercept` is under `~/Library/Caches/…` on macOS.
  Cleaners, or a manual "delete IDE caches", remove the CA, so devices must trust a new one, plus the approvals and
  personal rules. Consider `getConfigPath()` (not synced by default) or document it.
- **LAN token in launch args:** on physical iPhones the patched args carry `user:token@ip:port`.
  - The spike checked `last_build_run.json`.
  - I couldn't confirm from the jar whether the Flutter plugin echoes the command line into the Run console or
    idea.log.
  - `ps` exposure is the same as in VS Code.
  - Check once in a sandbox and note it in §7.
- **`flutter.intercept.sidecar` system property:** it picks any `sidecar.js` (`SidecarProcess.kt`). Only user-level
  `.vmoptions` / `idea.properties` can set it, so INFO. Consider honouring it only in sandbox builds (`idea.is.internal`
  / a `runIde` marker).
- **Approval dialog default:** `ConfirmDialog` makes the first button (Approve) the default, so Enter approves.
  VS Code's modal behaves the same way, but consider making Cancel the default for shared-rule approval.
- **Browser extensions:** in the system browser, extensions with access to `127.0.0.1` / `<all_urls>` can read the page
  (traffic, WebSocket token) and the HttpOnly cookie (`chrome.cookies`). Mention it next to "Open Traffic in Browser";
  JCEF avoids it.
- **`X-Frame-Options`:** only CSP `frame-ancestors 'none'` is sent. That is enough for current Chromium / Firefox /
  Safari and JCEF. Adding `X-Frame-Options: DENY` is cheap.
- **`JsonLineRpc.readLine`:** unbounded, but the sidecar is a trusted peer (its own lines are capped at 32 MiB on its
  side).

## Checked, fine
- **UI server:**
  - It binds `127.0.0.1` (re-checked after listen) on a random port.
  - It refuses (403) any `Host` other than exactly `127.0.0.1:<port>`, which stops DNS rebinding.
  - It refuses (403) any `Origin` other than its own; the WebSocket must carry it.
  - It allows GET / HEAD only.
  - Header and request timeouts, a 100-header cap, 16 clients, a 16 MB frame cap, `perMessageDeflate` off, and slow
    views dropped at 64 MB buffered.
  - Tokens: 32 random bytes, compared with `timingSafeEqual`; one-time tokens are single use with a 60 s lifetime and
    64 at most. A wrong or expired token → 403 page.
  - Every response has `no-store`, `nosniff`, `Referrer-Policy: no-referrer` and CORP `same-origin`.
  - The page has a header CSP (nonce scripts, `default-src 'none'`, `connect-src` = own `ws:`, `frame-ancestors`,
    `form-action`, `base-uri` `'none'`).
  - Cross-port pages can't read the page (CORP, `nosniff`, CORS), frame it, or open the WebSocket (Origin).
  - Cross-site pages don't send the Strict cookie.
  - `openInNewWindow` is ignored.
  - Non-object and binary frames are dropped.
- **Webview standalone mode:**
  - It uses the WebSocket only when `__FI_WS__` is set and doesn't listen to `postMessage` there.
  - It accepts only known `HostMsg` types.
  - The token is never stored; `?t=` is scrubbed; state goes in `sessionStorage` (per origin, so per port).
  - There are no `href` / `innerHTML` sinks. Image previews are `data:` (scripts don't run in `<img>`).
- **stdio RPC (both sides):**
  - Newline framing; sidecar lines capped at 32 MiB with discard-to-newline; malformed lines logged by length only;
    ids split by sign; late answers ignored; stdout carries only the protocol (`console.*` goes to stderr).
  - The sidecar exits on stdin close, `shutdown`, or a signal (5 s force), undoing adb reverses, emulator proxies and
    the proxy.
- **Untrusted text in IDE UI:**
  - Notification content is HTML-escaped (`Notifications.escape`), and so is the `ConfirmDialog` message.
  - The approval detail is a read-only `JTextArea`. Popup items use `ColoredListCellRenderer` (no HTML), and popup
    titles never start with `<html>`.
  - Button labels are constants.
  - `ui.openUntitled` / `ui.diff` names are reduced to a base name, and binary file types fall back to plain text
    (`LightVirtualFile`, nothing on disk).
- **`ui.openFile`:** `PathGuard` matches `checkSourcePath` / `packageRootsFor` in VS Code: absolute, not UNC,
  realpath on both sides, roots = open projects' content roots plus the package roots from `package_config.json`. The
  sidecar checks first as well (`checkSourcePath`, `openWorkspaceFile`).
- **`ui.save` / exports:**
  - The user picks the target in an IDE dialog.
  - Unredacted exports into git-tracked folders still need `confirmWarning` (an IDE modal).
  - Save CA writes the public part only.
- **`secrets.clientCertPassphrase`:**
  - The sidecar asks only for the `clientCertificates` hosts of the application-level settings; projects, agents and
    the UI can't add hosts.
  - The answer is used to decrypt the key and never shown, logged or sent to the UI or agents.
  - The PasswordSafe key namespace is `flutterIntercept.clientCertificatePassphrase:<host>`.
  - Certificate paths must be absolute or `~/` (REVIEW-8 #9, shared loader).
- **Settings scope:**
  - Everything is application-level (`flutter-intercept.xml`). The plugin has no project overrides; `tlsPassthrough`
    and `nativeClients` are even stricter than VS Code's window scope.
  - The sidecar normalises every field (types, enums, bounded lists and lengths).
  - Agent access, redaction and screenshots come from those settings only.
- **Agent parity:**
  - `createAgentApi` gets the same dependencies as in VS Code (minus LM tools); the MCP server is shared code with its
    token in a 0600 file.
  - `launch_app` / `stop_app` / `hot_restart` refuse with a clear message.
  - Redaction, access levels and the loopback-only `add_map_remote` are unchanged.
  - Agent screenshots use the VM service only on a loopback URI (`isLoopbackWsUri`); web screenshots fail closed (#7).
- **Shared rules and scripts:**
  - The approval modal has the same content as VS Code (`ui.confirm` modal).
  - Approvals are bound to content hashes, so a different repo cloned at the same path isn't pre-approved.
  - `fileSaved` comes from `FileDocumentManagerListener.afterDocumentSaved`, which fires for document saves in the IDE
    only. External changes (git pull / checkout) reach the IDE through VFS refresh, not saves, so they hold the rule
    again.
  - `.js` and local files only.
  - Body / script files have exact-path watchers with caps.
- **LAN mode:** `prepareLan` / `LanLifecycle` / `LanNetworkWatcher` are the same as VS Code. Physical iPhones come
  from the Flutter daemon's `platformType` + `emulator`, and the LAN notice is shown. The token is never logged: the
  plugin logs launches without args, and the sidecar logs `proxyHost=LAN`.
- **Logs:**
  - The sidecar blanks the UI and MCP tokens in its own lines.
  - The plugin masks `t=` / `token=` / bearer / passphrase patterns in `log` events and stderr.
  - `InitResult.toString` hides URLs; the one-time URL and the VM-service URI are never logged.
  - Connect AI Agent copies its text (MCP token) to the clipboard only.
- **Process start:**
  - `NODE_OPTIONS` is removed; the sidecar's cwd is the plugin folder.
  - A configured `nodePath` must be absolute and executable and is the only candidate.
  - Node ≥ 18 is checked with a 5 s timeout.
  - `dataDir` is 0700, and the state, CA and MCP-token files are 0600 with atomic writes.
  - Restarts back off, at most 3 per 5 minutes.
- **Run integration:**
  - Release is never intercepted: by `FlutterLaunchMode`, the Profiler executor and `--release` in args, checked in
    both the plugin and the sidecar.
  - Attach configurations are skipped.
  - The patched copy is an in-memory `clone()` that is never added to `RunManager`. The original's `fields` are only
    read (`copyFields`). Reruns re-prepare.
  - The arguments go out as a list. `ParametersListUtil` join → parse round-trips quotes and spaces (`RunArgsTest`).
  - The generated entry must exist before launch. Every failure falls back to the user's unchanged configuration.
- **Daemon events:**
  - `DaemonEvents` reads only JSON-array lines whose top-level `event` is one of four names.
  - App output arrives wrapped in `app.log` events by flutter_tools, so the app can't fake `app.debugPort` /
    `app.webLaunchUrl` (the escaped quotes don't match, and the outer event is `app.log`; tested).
  - Even a fake URI only reaches the sidecar's loopback check, and `webLaunchUrl` is unused (#7).
  - Unterminated lines are capped at 1 MB.
  - `sessionStarted` needs a launch id the sidecar issued, and each id is used once.
- **Personal data:** the diff has no real UDIDs, team ids, LAN IPs, e-mails or tokens. Test fixtures are synthetic.
  The demo's `project.pbxproj` change stays uncommitted.

## Fix plan
- **S + W + lead:** #1, amending §15.4.
  - No session cookie: `/?t=<one-time>` serves the page directly.
  - Assets don't need credentials.
  - Per-page WebSocket secrets, revoked when their page is gone.
  - Webview: nothing changes except keeping the `replaceState` scrub.
- **S:** #6: `HEAD` never redeems. #7: keep `webLaunchUrl` for web screenshots; reload client certificates when the
  plugin reports a passphrase change; align error codes.
- **S + lead:** #2: creating files outside `.vscode/flutter-intercept/` needs an IDE-side `ui.confirm`; refuse build,
  VCS and IDE config paths.
- **K:**
  - #3: open the browser through a 0600 redirect file in `dataDir`, never with the token on a command line.
  - #4: the JCEF guard follows the current origin and never opens the UI's own URLs externally.
  - #5: fixed working directory for the Node probe; skip relative `PATH` entries; resolve shims from a neutral
    directory.
  - #7: the dev sidecar override only in sandbox builds; consider Cancel as the default for approval; note browser
    extensions on the "Open in Browser" panel.
- **lead:** #7: §15.2 / §15.4 wording (MCP token file, `dataDir` location, browser-extension residual); check once in a
  sandbox whether the Flutter plugin prints the launch command line (LAN token).
- **Before release, add tests:**
  - no `Set-Cookie` header; `/` without a fresh one-time token → 403; two page loads get different WebSocket secrets;
    a secret dies about 30 s after its page closes; `HEAD /?t=` doesn't consume the token;
  - `openBodyFile` creating `android/buildSrc/build.gradle` → refused or confirmed in the IDE, nothing written on
    Cancel;
  - the URL handed to the system-browser launcher contains no `t=`, and the redirect file is 0600 and deleted;
  - a `ready` with a new port keeps JCEF navigation internal and calls `BrowserUtil` 0 times;
  - `nodeVersionOutput` runs with a fixed working directory; relative `PATH` entries are skipped;
  - a passphrase change reloads certificates; web screenshots use the session's `webLaunchUrl`.

## Status (2026-10-11)

Fixed in `feature/0.9.0`:
- **#1** no cookie: a one-time `GET /?t=` serves the page directly with a per-page WebSocket secret (valid while its
  page is connected, 30 s after the last socket, 60 s if never used; ≤ 32 kept); `/` without a fresh token → 403 (S).
- **#2** "Create file" from the UI: silent only under `.vscode/flutter-intercept/`; build / platform / VCS / IDE / tool
  configuration refused; anything else asks with a modal naming the full path. One pure policy
  (`packages/extension/src/rules/createPolicy.ts`) used by the sidecar and the VS Code host (S, lead).
- **#3** "Open Traffic in Browser" opens a 0600 redirect file (deleted after 60 s), never the URL on a command line (K).
- **#4** the JCEF navigation guard follows the sidecar's current origin; reloads fetch a fresh one-time URL (K).
- **#5** Node checked and the sidecar started with `dataDir` as working directory, without `NODE_OPTIONS`; relative PATH
  entries ignored (K).
- **#6** only GET redeems a one-time token (HEAD / POST → 405) (S).
- **#7** web screenshots get `webLaunchUrl`; passphrase changes apply at once; error codes unified (`unknown_method`);
  `X-Frame-Options: DENY`; the MCP token lives in the IDE's password store (`secrets.get` / `secrets.set`, file only as
  a fallback); `dataDir` moved to the IDE config path (migrated once); the dev sidecar override needs
  `flutter.intercept.dev` in a sandbox; Cancel is the approval dialog's default; stdio lines capped at 16 MB (S, K).
- **LAN token in launch args** (found while checking #7): the Flutter plugin logs the full `flutter run` command
  (idea.log, Run console), so the physical-iPhone proxy value moves into a 0600 `--dart-define-from-file` JSON outside
  the project, removed when the LAN listener closes — in both hosts. Residual: flutter_tools still writes defines into
  gitignored generated build files (token valid only while that LAN listener is open).
