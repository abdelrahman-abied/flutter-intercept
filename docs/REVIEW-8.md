# Review 8: v0.8.0 security (independent, `feature/0.8.0` at 33db934) — findings and fix plan

Scope: everything since `main` (`git diff main..HEAD -- . ':!samples/demo_app/ios' ':!package-lock.json'`). That covers:
- TLS passthrough: `proxy/src/{tunnel,tls-records,hosts}.ts`, the replaced `connect` listener and `runTunnel` in
  `intercept-proxy.ts`, `lan.ts` `lanConnectAllowed`;
- mTLS: `certMap`, `requestPlan`, `loadClientCertificate`, `extension/src/ui/clientCerts.ts`;
- upstream: `noProxy` (`upstream-proxy.ts`), idle sockets and retry (`idle.ts`, `upstream-request.ts`,
  `upstream-pool.ts`), VS Code `http.proxy` (`proxyHost.ts`, `extension.ts`);
- throttling (`pace.ts`, WebSocket pacing) and WebSocket / SSE replay (`replay-stream.ts`, `onReplayStream`,
  `onWsReplay`), recordings v2 (`recordings/{frames,validate,store,replay,diff}.ts`);
- web: `debug/{pacServer,rewrite,provider,webServerNotice}.ts`, `web/screenshot.ts`;
- native / vm: `adb.ts` `AndroidGlobalProxy`, `vm/{core,profile}.ts` bypass detection, iPhone screenshots
  (`screenshot/index.ts`);
- agent API (`api.ts`, `redact.ts` multipart, `har.ts`, `schema.ts`), exports (`export/{security,postman,openapi}.ts`);
- the CLI and the GitHub Action (`action.yml`, `cli/src/{action,lan,run,command,devices}.ts`, `build.mjs`, `package.json`);
- the webview (`connection.ts` and the components).

The working tree also changes `packages/extension/{README,CHANGELOG}.md`, which I read, and the demo's
`project.pbxproj` (local signing, which must stay uncommitted). Spec: CONTRACTS §14 incl. §14.8, earlier guarantees
§7, §8, §12.1.

I read the code and ran throwaway probes in the session scratchpad (esbuild bundles of the real modules, outside the
repo; Node 26):
- `parseHostPattern` / `matchesHostPattern`, `normalizeCertHost` and `normalizeTlsPassthrough` on wildcard patterns;
- `AppDataFinder` on a TLS 1.3 record sequence with 0-RTT early data, and on a normal 1-RTT one.

I also read mockttp 4.6.3:
- `getUpstreamTlsOptions`: the `clientCertificateHostMap` lookup;
- the WebSocket pipe (`outSocket.send`, no backpressure);
- httpolyglot's listener mirroring.

And flutter_tools' Chrome launcher in the local SDK (`--remote-debugging-port`, no `--remote-allow-origins`).

I did not run the unit, integration, device or CLI suites, and did not build or launch anything.

Threat model as in REVIEW-1 to REVIEW-7:
- a malicious cloned repo (trusted workspace);
- a malicious or prompt-injected agent that only has our tools;
- a malicious app under debug;
- a hostile server or web page (including any page in the Flutter Web debug Chrome);
- other local users;
- new: malicious PR / workflow inputs for the GitHub Action.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | LOW-MED | **A configured client certificate works for anyone who can reach the proxy, not just the app.** The proxy presents it for every upstream TLS connection to a matching host, whoever made the request. That includes any local process or other local user (the loopback proxy has no authentication), any app on the Android emulator (10.0.2.2) and **every page open in the Flutter Web debug Chrome**. Chrome itself would ask the user to choose a certificate. A third-party page can then `POST` to the mTLS API with the user's identity, and read the response when the API sends `Access-Control-Allow-Origin: *` (no browser credentials are involved). | P + H + lead |
| 2 | LOW-MED | **The GitHub Action uploads unredacted recordings as workflow artifacts.** `record: <path>.json` is written with `redact: false` (`outputs.ts:97`) and passed to `actions/upload-artifact` (`action.ts:113`). Anyone with read access to the repository can download it, which on a public repo means any signed-in user, for the retention period. It holds Authorization headers, cookies, tokens and test-account passwords. §14.8 drops a `no-redact` input so that artifacts stay redacted, but `record` gets around that. | C + lead |
| 3 | LOW | **The PAC sends `127.*` host *names* DIRECT.** `shExpMatch(host, "127.*")` (`pacServer.ts:27`) matches `127.x.attacker.example`. The app's own web code or any page in the debug Chrome can use such a name to send requests around the proxy. They are not recorded, are not visible to agents, and blocks, mocks, the offline profile and `replay: fail` don't apply. `--proxy-server` (0.7.0) only bypassed real loopback addresses. | B |
| 4 | LOW | **`*` in a host pattern also matches attacker-registrable names.** `10.0.0.*` matches `10.0.0.1.evil.example` and `api.corp.*` matches `api.corp.evil.example`. Both are accepted for `clientCertificates`, so the certificate is presented to a server the attacker owns, which receives the certificate (identity disclosure). For `tlsPassthrough`, which a repo may set, `*.*` gets past the "bare `*` refused" rule and turns off decryption for every host: the user's mocks, breakpoints and replay are skipped. The host accepts `*`, but the proxy refuses it, and then the whole list is not applied. **Probe** below. | P + H |
| 5 | LOW | **TLS 1.3 early data gets past the block / fault cut on passthrough hosts.** `AppDataFinder` treats the first type-23 record after the ClientHello as the client's Finished. With 0-RTT, that record is the early data: the app's first request. It is forwarded to the real server before the cut. **Probe:** ClientHello + early data + Finished + data → 330 bytes forwarded (ClientHello 205 + early-data record 125). | P |
| 6 | LOW | **WebSocket throttling has no backpressure.** `paceWebSocket` queues every message in a `LinkQueue` with no limit (`pace.ts:59`), and mockttp's pipe calls `send()` for every upstream message. When the server sends faster than the throttle rate, extension-host memory grows without bound. Example: a 1 MB/s feed under Slow 3G (50 KB/s) adds about 950 KB/s, roughly 570 MB after 10 minutes. The tunnel and HTTP paths do have backpressure. | P |
| 7 | LOW | **Emulator routing state is shared between windows and never re-checked.** `recover()` (`adb.ts:356`) runs on every activation. It reverts every stored record that its own window didn't apply, including a live session's in another VS Code window. Meanwhile `isRouted()` keeps returning true from local state, so the vm core stops importing that app's finished native requests (`core.ts:573`). Those requests now go direct, so they disappear from the panel and from agents with no warning. | V + lead |
| 8 | LOW | **A repo can turn on `nativeClients: "proxy"`.** The setting is window-scoped, so a cloned repo's `.vscode/settings.json` can set the emulator-wide global proxy for every debug session. All the other emulator apps' traffic then goes through the proxy: their plain HTTP is recorded and visible to agents, and their HTTPS breaks. Routing only stops on a TLS failure in *this* app. After a crash it stays until the next activation. | lead |
| 9 | LOW | **Client-certificate paths in user settings resolve inside whatever repo is open.** A relative path is looked up in "the first workspace folder where the file exists" (`clientCerts.ts:128`). A cloned repo (or an earlier folder of a multi-root workspace) can ship its own `certs/client.p12` or PEM pair at that path. The user's requests then authenticate as the attacker's identity, and the user's stored passphrase is tried on the repo's file. | H |
| 10 | LOW | **A local user can claim the debug Chrome's DevTools port first.** `--web-browser-debug-port` is chosen when the launch is resolved (`provider.ts:93`), and other users can read it from `flutter run`'s command line with `ps`. It stays free for the whole web build. A local user who binds it first becomes the "browser" for DWDS and for `take_screenshot`, and can hand agents a PNG of their choosing. Also, `pickTarget` falls back to any http(s) tab, so a screenshot can show another site open in that Chrome. | B |
| 11 | LOW | **Passthrough hosts receive `x-fi-id`.** The entry tags every dart:io request (`generator.ts:191`). Inside an undecrypted tunnel the proxy can't remove the header, so pinned hosts (banks, payment APIs) get `x-fi-id: <16 random hex per isolate>-<counter>`, which identifies the session. This breaks §8 "x-fi-id is removed before anything goes upstream (every route)". Strict WAFs may also reject the unknown header. | lead + P |
| 12 | INFO | Smaller items: the action pins `upload-artifact` by tag and its artifact paths are globs; the CI LAN token is not `::add-mask::`ed; the README puts the CA in `res/raw` (committed); the "restored even after a crash" wording; dropped `http.noProxy` entries are not reported; host validators reject `uploadKbps`; WebSocket subprotocol tokens; agents' unredacted saves now include frames. | various |

## Details

### 1 (LOW-MED) A client certificate works for anyone who can reach the proxy

What the code does:
- `intercept-proxy.ts:536` passes `certMap` as mockttp's `clientCertificateHostMap`.
- mockttp's `getUpstreamTlsOptions` looks it up as `map["host:port"]` for every upstream TLS connection: requests,
  WebSocket upgrades, h2. `certOptions` (`:3019`) answers from the host pattern only. Nothing looks at who made the
  request: no session, initiator, `Origin` or `Sec-Fetch-Site`.

The key file is protected by file permissions, and its passphrase by the OS keychain (secret storage). The proxy
decrypts the key and then uses it on behalf of:
- **Other local users and processes:**
  `curl -k -x http://127.0.0.1:<port> https://api.corp.example/admin/...` authenticates as the developer. The loopback
  proxy has always been open to local clients. Until now that gave them nothing beyond their own network access.
- **Emulator / simulator apps:** any app on the emulator reaches `10.0.2.2:<port>`. With #8, the whole emulator is
  routed.
- **Flutter Web:** every page in the debug Chrome goes through the proxy. That includes third-party iframes and ads in
  the app, and any other site the user opens in that window. The README's tip ("everything you open in that debug
  Chrome window is recorded") shows that users do this.
  - A `fetch(..., {method: 'POST', mode: 'no-cors'})` to the mTLS host runs with the user's identity (a CSRF-style
    write).
  - The browser sees no credentials, so `Access-Control-Allow-Origin: *`, which is common on APIs, also lets the page
    read the response.
  - Without Flutter Intercept, Chrome would show its certificate picker.

Agents can't redirect traffic to another host (`add_map_remote` is loopback-only, `add_rewrite` forbids `Location`),
so they can't steer the certificate elsewhere.

**Fix (P + H + lead):**
- Web sessions: present certificates only for requests from the app's own origin (`Origin` absent or the dev server's
  loopback origin, `Sec-Fetch-Site` `same-origin` / `none`). Refuse other cross-site browser requests to a
  certificate host with 403 and a note. Allowing them could be a user setting.
  - mockttp's lookup has no request context. The simplest implementation is to refuse in the flow decision, before
    any upstream connection is made, so pooled certificate connections are never shared with such requests.
- Loopback: a per-install proxy credential for certificate hosts. The generated entry already controls `findProxy`
  (`PROXY user:token@127.0.0.1:<port>`, as in LAN mode). Require it on CONNECTs and plain requests whose target matches
  a certificate pattern. For emulator clients, the same token reaches the app through the define.
- At minimum, document it next to the setting: "while the proxy runs, local programs and pages in the debug browser
  can use this certificate".
- Tests:
  - a CONNECT to a certificate host without the token is refused;
  - a web-session request with `Origin: https://evil.example` is refused;
  - the app's own requests still present the certificate.

### 2 (LOW-MED) The GitHub Action uploads unredacted recordings as artifacts

What the code does:
- `cli/src/action.ts:113` puts a `record` value that looks like a path into `artifacts`.
- `action.yml:126-133` uploads it.
- `cli/src/outputs.ts:97` saves it with `redact: false`. The README says "not redacted: replay needs the real bodies".

The HAR is always redacted, and §14.8 drops the `no-redact` input on purpose. The recording carries the same secrets
unredacted:
- `Authorization` / `Cookie` headers;
- login bodies (test-account passwords);
- tokens in responses;
- API keys from `--dart-define` secrets that the app sends.

`upload-artifact` makes it downloadable by anyone with read access. On a public repository that is any signed-in
GitHub user, for 90 days by default. Fork PRs can't read secrets, but push / scheduled workflows run with real staging
credentials.

**Fix (C + lead):**
- Don't upload a recording unless a new input `upload-recording: true` is set. When it is, add a `::warning::` that
  the artifact contains credentials.
- Or redact recordings written by the action by default, with a `record-redact: false` input. Replaying a redacted
  recording misses POSTs whose request bodies had secrets (hash mismatch), so document that.
- README: say plainly that a `record` path artifact contains live credentials.
- Test: with `record: build/run.json` and default inputs, `artifacts` contains only the HAR and JUnit report (or the
  file is redacted).

### 3 (LOW) The PAC sends `127.*` host names DIRECT

`pacServer.ts:27` returns DIRECT for `shExpMatch(host, "127.*")`. PAC `shExpMatch` is a shell glob over the host
*string*, so `127.anything.attacker.example` (a normal DNS name) goes DIRECT too. Before 0.8.0, `--proxy-server` relied
on Chrome's implicit loopback bypass, which only matches IP literals and `localhost` / `*.localhost`.

Who can do it:
- the Flutter Web app's own code, including packages and SDKs: a "malicious app under debug";
- any page open in the debug Chrome.

They can send requests the panel never shows, agents never see, and rules never touch. That includes blocks, the
offline profile, `replay: fail` and recordings.

**Fix (B):**
- Match IP literals only: `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)`. PAC scripts are JavaScript.
- Keep `localhost` / `.localhost` / `::1` / `[::1]`.
- Test: `FindProxyForURL('https://127.evil.example/', '127.evil.example')` returns the proxy.

### 4 (LOW) `*` in host patterns matches attacker-registrable names

Probe (real `parseHostPattern`, `normalizeCertHost`, `normalizeTlsPassthrough`):

```
proxy pattern 10.0.0.* vs 10.0.0.1.evil.example => true | host-side cert host: 10.0.0.*
proxy pattern api.corp.* vs api.corp.evil.example => true | host-side cert host: api.corp.*
proxy pattern *.* vs www.anything.com => true | host-side cert host: *.*
proxy pattern *.com vs bank.com => true
passthrough setting ["*","*.*"] => {"hosts":["*","*.*"],"problems":[]}
proxy rejects *: "*" matches every host; list the hosts instead
```

- **Client certificates:** a user who writes `10.0.0.*` (internal IPs) or `api.corp.*` (several TLDs) also presents
  the certificate to names an attacker can register and get a valid certificate for.
  - Who can trigger it: a hostile server (redirect), a page in the debug Chrome, or the app.
  - What the attacker learns: the certificate and the identity in it (name, e-mail, org). The key stays safe: the
    TLS 1.3 / EMS signature is bound to the attacker's own handshake.
- **TLS passthrough** (window scope by design): a repo's `["*.*"]` passes the bare-`*` check and turns off decryption
  for every host.
  - It stays within "only reduces decryption".
  - But the user's own mocks, breakpoints and replay entries are skipped with a note per exchange. A mock that keeps a
    test away from a real endpoint (payments) then lets the request through.
- **The validators disagree:** `normalizeTlsPassthrough` accepts bare `*` (its comment even lists it). The proxy then
  throws, and `applyTlsPassthrough` keeps the *previous* list with only a log line, so the panel shows hosts that are
  not in effect.

**Fix (P + H):**
- `*` matches within one label only (no dots), except a leading `*.` (any subdomains).
- Reject patterns whose last label is a wildcard, and patterns with fewer than two literal labels (`*.*`, `*.com`,
  `*-*`). IP patterns stay literal or CIDR (`10.0.0.0/24`).
- The host normalizer and `parseHostPattern` share one implementation. A refused entry is dropped on its own; the
  rest of the list still applies.
- Status shows where `tlsPassthrough` comes from: workspace or user.

### 5 (LOW) TLS 1.3 early data gets past the cut

`tls-records.ts:65-67`: in the TLS 1.3 path, the first type-23 record is taken as the client Finished. With 0-RTT, the
client sends `ClientHello`, then early-data records (type 23, the first request), then `EndOfEarlyData` + `Finished`
(type 23). `relay` forwards everything before the offset `push` returns, so the early-data record reaches the real
server, which may act on it (that is what 0-RTT is for).

Probe:

```
0-RTT: cut offset 330 (ClientHello 205 + early-data record 125)
1-RTT 1.3 (CH, CCS, Finished, App): cut at 276, as expected
```

Who sends 0-RTT: dart:io doesn't enable early data. Chrome (Flutter Web) and native stacks can, on session resumption,
for safe methods. When they do:
- a block or `fault` rule lets one request through;
- so do `offline` and `replay: fail` on a passthrough host.

Separately, as documented, a block still makes the full DNS / TCP / TLS handshake with the real server (SNI, client
IP).

**Fix (P):**
- Track whether the ClientHello offers `early_data`: parse the extensions of the first record (bounded, ≤ 16 KB).
- If it does, cut at the first type-23 record. Early data is never needed when the connection is being blocked.
- Or, for blocks / faults, strip the `early_data` extension. That changes the transcript, so cutting is simpler.
- Test: a ClientHello with `early_data` followed by a type-23 record is cut before that record.

### 6 (LOW) WebSocket throttling has no backpressure

What the code does:
- `paceWebSocket` (`intercept-proxy.ts:3867`) wraps `send` / `ping` / `pong` / `close` with `LinkQueue.push`.
- `LinkQueue.push` (`pace.ts:59`) has no size limit.
- mockttp pipes each upstream message with `outSocket.send(msg, …)`, which has no backpressure either.

Unthrottled, the loopback app drains quickly. Throttled, items wait `size × 8 / kbps` each, and the server keeps
sending. Examples:
- A market-data / chat feed of 1 MB/s under the Slow 3G preset (400 kbps) grows by about 950 KB/s.
- A shared throttle rule (ungated) at `kbps: 1` delivers 125 B/s.

Everything waits in the extension host. A real slow link would push back on the server through TCP.

**Fix (P):**
- When a direction's `queuedBytes` passes a cap (e.g. 16 MB), pause the source socket (`ws._socket.pause()` on the
  sending side) until the queue drains below the high-water mark.
- Or close the connection with 1009 / 1013 and a note ("throttled WebSocket fell more than 16 MB behind").
- Test: 64 MB pushed through a 400 kbps throttle keeps RSS growth under 32 MB.

### 7 (LOW) Emulator routing state is shared between windows and never re-checked

- `context.globalState` (`flutterIntercept.emulatorProxies`) is shared by every window, and the extension activates
  in every window with a `pubspec.yaml`.
- `recover()` (`adb.ts:356-371`) reverts each stored record unless *this* process's `active` has it. It has no idea
  whether another window is using it.
- Window A's `isRouted()` (`:320`) is local state only. After window B's activation reverts the emulator, A still
  reports routed.
- `core.ts:573` therefore drops A's finished, successful native entries ("came through the proxy"). Since the proxy
  never saw them, they are gone from the panel, from `list_requests` and from recordings.

The same blind spot appears whenever anything else changes `http_proxy` mid-session: the user, a script, Android
Studio.

**Fix (V + lead):**
- Store an owner with each record: extension-host session id + pid + heartbeat time. `recover()` reverts only records
  whose owner is gone (pid dead, or heartbeat older than e.g. 2 min).
- `isRouted()` re-reads `http_proxy` (≤ 1/30 s) and drops the route when it no longer has our value.
- Independently, when routed, import finished native entries that `proxySaw` says the proxy didn't record, the same
  dedupe as bypass detection, instead of trusting `routed()`.
- Test: two `AndroidGlobalProxy` instances on one store; the second one's `recover()` leaves the first one's live
  record alone.

### 8 (LOW) A repo can turn on `nativeClients: "proxy"`

- `package.json`: `flutterIntercept.nativeClients` has no `scope` (window).
- `extension.ts:106` reads the merged value. "profile" / "off" were harmless; "proxy" changes **emulator-wide** state
  (`settings put global http_proxy`).

With a repo's `.vscode/settings.json`, every debug session on an emulator routes every app on it through the proxy
(Play services, Chrome, other apps under test):
- their plain-HTTP requests are recorded and visible to agents (redacted, but URLs and bodies);
- their HTTPS fails (they don't trust the CA) and shows as TLS errors with host names.

Routing only stops on a trust failure in *this* app's HTTP profile. A crash leaves the emulator pointing at a closed
port until the next activation.

**Fix (lead):** give `nativeClients` `"scope": "application"` and read it with `inspect().globalValue`, like the
agent settings. Or keep window scope for `profile` / `off` and honour `proxy` only from user settings.

### 9 (LOW) Client-certificate paths resolve inside the open repo

`clientCerts.ts:103-138`: a relative `pfx` / `cert` / `key` path is tried in each workspace folder in order, and the
first that exists wins. The `inside()` check keeps the file in *that* folder, but the folder is the repo.

A user-level entry such as `{"host": "api.corp.example", "pfx": "certs/dev.p12"}` therefore applies to every
workspace. A cloned repo with `certs/dev.p12` supplies the certificate, with no passphrase or with a known one:
- The user's app then authenticates to the real API as the attacker's identity. Data the user creates lands in the
  attacker's account, the mTLS analogue of login CSRF.
- The user's stored passphrase is also tried on the repo's file.

In a multi-root workspace, an earlier folder shadows the user's file in a later one.

**Fix (H):**
- Since the setting is user-only, accept absolute and `~/` paths only.
- Or require `${workspaceFolder:<name>}/…` and refuse git-tracked certificate files (`gitIgnoreStatus`) unless the
  user confirms once per file hash.
- Test: a relative path that exists in a workspace folder is refused with a problem.

### 10 (LOW) The debug Chrome's DevTools port can be claimed first

- `provider.ts:93` picks a free loopback port when the launch is resolved and passes
  `--web-browser-debug-port=<n>`.
- flutter_tools only starts Chrome after the web build, often tens of seconds later.
- The port number is visible to every local user in `flutter run`'s argv (`ps`).

A local user who binds `127.0.0.1:<n>` in that window gets two things:
- Chrome can't open its DevTools server, and flutter_tools / DWDS connect to the impostor instead.
- `take_screenshot` (`web/screenshot.ts`) asks the impostor for `/json/list` and captures whatever PNG it returns. The
  image is saved and handed to agents, a channel for image-borne instructions.

flutter_tools' own `findFreePort` has the same race, but only for milliseconds.

Also, `pickTarget` (`:68`) falls back to *any* http(s) page when no loopback page exists. The confirmation says "the
running app", so a screenshot can show webmail or another site open in that window.

**Fix (B):**
- Don't pin the port. After launch, read it from the profile Chrome writes (`DevToolsActivePort` in the
  `--user-data-dir` flutter_tools creates), or from Dart-Code's debug events.
- Or check after launch that the listener belongs to the browser process: `/json/version` `webSocketDebuggerUrl` +
  `DevToolsActivePort`.
- Capture only a page whose origin is the session's app URL (Dart-Code's `webLaunchUrl`), never "any http(s) page".

### 11 (LOW) Passthrough hosts receive `x-fi-id`

`generator.ts:191` sets `x-fi-id` on every request the app opens (source capture is on by default). Inside a
passthrough tunnel the request is encrypted end to end:
- the proxy can't strip the header, so the pinned server receives it;
- the matching trace is posted and then expires unused.

§8 (CONTRACTS l. 817) promises the header is "removed before anything goes upstream (every route, incl. edits and
`send`)". REVIEW-3 accepted the leak only for the DIRECT fallback, when the proxy is gone. Here it happens for every
request to a pinned host during a normal session. The id is random per isolate start plus a counter, so it links the
requests of one debug session. It also tells the server the app is being intercepted, and a strict API gateway may
reject the header.

**Fix (lead + P):**
- Pass the passthrough patterns to the entry (a dart-define, or the trace channel's answer) and skip tagging matching
  hosts. Pinned hosts then have no source link, which is acceptable.
- Or at least document it in §14.2 and the setting description.

### 12 (INFO)
- **Action supply chain and paths:**
  - `actions/upload-artifact@v7` is pinned by tag. Consider a commit SHA, or say why a first-party tag is acceptable.
  - The `artifacts` output is passed to `upload-artifact` `path`, which accepts globs and `!` patterns. `har: "**"`
    uploads the working directory. Workflow authors control that, so INFO. Reject `*`, `?`, `!` and `..` in output
    paths.
- **CI LAN token:** it is printed masked by our own code, but flutter's build-failure output or `-v` can include
  `DART_DEFINES`.
  - Emit `::add-mask::<token>` (and the base64 of `flutter-intercept:<token>`) at the start of a LAN run, so GitHub
    masks it in every log line.
  - On a self-hosted iPhone runner, `pull_request` from forks runs untrusted code on that machine anyway. The README
    could say "don't run fork PRs on the device runner".
- **README "Route native clients":**
  - It puts `flutter_intercept_ca.pem` in `res/raw/` (main source set, committed). Teammates' debug builds then trust
    *this developer's* CA, whose key is on that developer's machine. Suggest `src/debug/res/raw/` and not committing
    it, or a per-developer gitignored file.
  - "restores it afterwards, even after a crash" is only true at the next activation with the emulator connected.
- **`http.noProxy`:** CIDR ranges and `<local>` are dropped silently (`normalizeNoProxy`), so those hosts go *through*
  the corporate proxy. Log what was dropped.
- **`uploadKbps`:** `validateRule` (`onlyKeys` at `controller.ts:652`) and the profile validator (`:915`) reject
  `uploadKbps`, so §14.4 `throttle.uploadKbps` rules and custom upload profiles can't be set from the panel or a shared
  file (presets only). Functional, not security.
- **`Sec-WebSocket-Protocol`:** values used as bearer carriers (`access_token, <opaque>`) are not redacted when they
  aren't JWTs. This is pre-existing for headers, and now also in redacted recordings.
- **Agents' `save_recording redact: false`:** it now writes WebSocket / SSE frames unredacted too, the same accepted
  design as REVIEW-6 (confirmation names it). Agents with file access can read the file.
- **`idevicescreenshot`:** it is taken from `PATH` / `/usr/local/bin` (admin-writable on Intel Macs). That is the same
  class as `adb` / `xcrun`, and pre-existing.
- **`emulator-*` serials:** they come from the shared adb server (port 5037). On a multi-user Mac, one user's
  `adb devices` can list another user's emulators. Pre-existing (`adb reverse`); the native routing only acts on the
  session's own `deviceId`.

## Checked, fine
- **Passthrough tunnels:**
  - LAN clients:
    - a closed gate's socket and a CONNECT after plain keep-alive requests are refused (`lanConnectAllowed`);
    - the target is resolved and checked (`resolveCheckedTarget`), then connected to by exact IP: directly, as the
      upstream proxy's CONNECT target, or directly for `noProxy`. DNS rebinding and the upstream proxy's own resolution
      can't reach forbidden addresses;
    - plaintext CONNECTs inside a mockttp tunnel hit the same guard via `lanGateOf`.
  - Loopback clients: emulator aliases and loopback targets never go through the upstream proxy.
  - Parsing and hand-off:
    - CONNECTs on TLS sockets and h2 CONNECTs go back to mockttp;
    - `splitHostPort` + Node's strict parser leave no CR/LF/space in the target, so nothing can be injected into the
      upstream CONNECT line;
    - only patterns matching the target are tunnelled.
  - Exchanges: `proxy-authorization` (LAN token) is removed from the tunnel's recorded headers.
  - Lifetime and limits: there is a 30 s connect timeout; `stop()` destroys tunnels; the client-FIN timer is 5 s; LAN
    tunnels count against the gate's per-IP limits.
  - Rules: mock / rewrite / script / mapRemote / breakpoint / throttle rules and `fault: truncate` never apply to a
    tunnel (noted, passed through). Only block and the other faults cut it.
  - The listener hook: httpolyglot mirrors `removeListener` to its sub-servers, so mockttp's handler is removed
    everywhere and called only for non-passthrough CONNECTs.
  - The repo-settable `tlsPassthrough` only removes decryption. The app's TLS is then verified by the app against the
    system roots plus our CA (the entry uses `setTrustedCertificatesBytes`, no `badCertificateCallback`), so nothing
    becomes *less* verified. See #4 for `*.*`.
- **mTLS key material:**
  - `clientCertificates` is application-scoped and read via `inspect().globalValue`.
  - Files: realpath; inside the folder for relative paths; regular file; ≤ 1 MB; opened
    `O_RDONLY|O_NONBLOCK|O_NOFOLLOW` and re-checked on the descriptor (dev / ino); bounded read. FIFOs and swaps are
    refused.
  - Problems are path-free sentences.
  - Passphrases are in secret storage (`password: true` input) and never in Status, events, logs, agents, HAR,
    recordings or the webview. `Exchange.clientCertificate` is the pattern only.
  - Proxy-side `certProblem` strips OpenSSL codes and isn't surfaced (the host's status is used).
  - Each certificate gets its own pooled connections (Node's agent key includes `pfx` / `cert` / `key`).
- **Upstream:**
  - `http.proxy` / `http.noProxy` are read from `globalValue`. A workspace can only set `http.proxySupport: off`
    (direct).
  - Credentials never reach Status or logs: `upstreamDisplay` shows host:port, and the host-side check runs before the
    proxy's URL-echoing parser.
  - `https://` / `socks://` proxies give a problem and traffic goes direct. `proxyStrictSSL` doesn't relax checks.
  - A loop to ourselves is caught at start, and the proxy goes direct.
- **Retry:**
  - GET / HEAD / OPTIONS / TRACE / PUT / DELETE only;
  - only on a reused socket, before any response byte, with ECONNRESET / EPIPE, after `end()`, body ≤ 1 MB, and not
    after the caller destroyed the request;
  - the free sockets of that key are dropped first, so the replacement normally gets a fresh connection (and a
    fresh socket never qualifies for another retry);
  - the TLS options (client certificate) are carried in `options`.
- **Replay robustness:**
  - recordings are rebuilt from checked fields: kinds per exchange kind, ≤ 500 frames, ≤ 8 MB cost, real base64,
    close codes 1000–4999, event / id without CR/LF/NUL;
  - version 1 files can't hold streams; unknown versions are refused;
  - the proxy re-checks `kind` vs `ws(s)://` and status 101;
  - SSE header names are tokens without CR/LF, and event / id lines are sanitised;
  - gaps ≤ 5 s; redacted binary frames are ≤ 64 KB of zeros;
  - WebSocket replay: `maxPayload` caps, invalid close codes fall back to a plain close, and timers are cleared on
    close;
  - LAN replays never connect upstream.
- **Recordings and redaction:**
  - `recordedExchange(redact)` redacts headers, URLs and bodies (multipart included), and frames via `redactFrame`
    (text redacted, SSE ids as values, binary payloads dropped);
  - tunnels, vm-profile captures and unopened WebSockets are not recorded.
- **Multipart redaction:** boundary per RFC 2046; ≤ 5 MB; ≤ 1000 parts; a delimiter must be followed by a line end
  (otherwise the text rules apply); `name*=` handled; file parts are summarised; secret-named fields are redacted;
  other part headers are redacted like headers; nested multipart is summarised; truncated bodies are marked. Binary
  (base64) multipart bodies are parsed in `get_request`, HAR and recordings.
- **Exports:** `securitySchemes` come from names only. Postman credential variables are empty with redaction on, the
  URL comes from `redactUrl`, and the credential header / query is removed from the request.
- **Agent API:**
  - tunnel and `clientCertificate` fields carry patterns / byte counts only;
  - `get_status` client-certificate problems go through `redactText`;
  - tunnels can't be resent or read as frames;
  - no new write tools;
  - `add_map_remote` stays loopback-only, so agents can't steer a certificate.
- **PacServer:** binds 127.0.0.1; exact `Host` check; GET / HEAD only; 5 s header / request timeouts; serves only the
  current port's script (no secrets); `nosniff` / `no-store`. Pages can't read it cross-origin.
- **CDP from pages:** flutter_tools passes no `--remote-allow-origins`, so a page's WebSocket to the DevTools port is
  refused by Origin, and `/json` responses have no CORS headers. Screenshots connect to 127.0.0.1 only, rebuild the WS
  URL from a validated id (never the browser's host), use `followRedirects: false`, check the PNG and cap size.
- **Web-server notice:** nothing runs automatically. The proxy starts and the CA loads only on click. The temp profile
  comes from `mkdtemp` (0700); profile paths with quotes / `$` / `%` are refused; POSIX single-quoting is used.
- **Emulator routing:**
  - `emulator-<n>` serials only, debug mode only, port 1–65535;
  - `execFile` argument arrays;
  - `previous` is only ever `null` or `:0` from the device (stored records are validated), so nothing device-supplied
    is re-sent to `adb shell`;
  - it never overwrites a non-empty proxy or a policy proxy, and never reverts a value that changed;
  - writes are persisted before `put`.
- **Save CA Certificate…** writes `ca.get().cert` (public part only) to a path the user picks.
- **Bypass detection:**
  - VM data is type-checked;
  - hosts in warnings are limited to `[A-Za-z0-9.:[\]_-]` and 100 characters (no `](`, so no notification links);
  - ≤ 10 warnings + summary, ≤ 1000 hosts;
  - main-isolate entries are never imported;
  - logging is off again after the 60 s window.
- **iPhone screenshots:** the UDID comes from the session (`deviceKind`, no leading `-`); `execFile` with arrays;
  output goes into a fresh `mkdtemp`; `lstat` regular file, ≤ 16 MB, PNG check; files 0600 in a 0700 folder.
  Flutter's x86_64 copy is skipped.
- **CLI / Action:**
  - inputs reach the CLI only as `FI_INPUT_*` env (no `${{ }}` in `run:`); `working-directory` / `artifact-name` are
    `with:` / step fields, not script;
  - value inputs are single-line `--flag=value`; targets can't start with `-`;
  - `$GITHUB_OUTPUT` uses a random heredoc delimiter, and paths with CR/LF are refused; workflow-command data is
    escaped;
  - `npm ci --ignore-scripts` uses the action's lockfile;
  - the HAR is redacted (no `no-redact` input);
  - LAN: private default-route IPv4 only; 256-bit per-run token; peer pinning; token masked in printed commands;
    `Proxy-Authorization` stripped before any output; listener closed in `finally` (and by process exit); `run -d
    <iPhone>` refused;
  - npm package: `files: [dist/cli.js]`, external source map (not packed, no `sourceMappingURL`), no dependencies.
- **Webview:** new fields are rendered as text (Preact escaping), and tunnel actions are limited to Block.
- **Personal data:** the diff has no real UDIDs, team ids, LAN IPs or e-mails. Fixtures are synthetic
  (`00008000-0000…`, `192.168.1.20`, `*.example`). The demo's `project.pbxproj` change stays uncommitted.

## Fix plan
- **P + H + lead:** #1: refuse third-party browser requests to certificate hosts; a loopback proxy credential for
  certificate hosts (entry `findProxy` with `user:token@`); document the residual.
- **C + lead:** #2: don't upload recordings by default (`upload-recording` input + warning), or redact them; README.
  #12: `::add-mask::` the LAN token; reject glob characters in artifact paths.
- **B:** #3: PAC loopback check on IP literals only. #10: discover the DevTools port after launch (or verify the
  owner), and capture only the app's page.
- **P + H:** #4: one shared host-pattern parser; label-bounded `*`; refuse wildcard TLDs, `*.*`, `*.com`; drop bad
  entries individually; show where passthrough comes from.
- **P:** #5: detect `early_data` and cut at the first type-23 record. #6: cap / pause throttled WebSocket queues.
- **V + lead:** #7: owner + heartbeat on emulator records; `isRouted` re-checks `http_proxy`; import routed entries
  the proxy didn't see.
- **lead:** #8: `nativeClients` user-only (or `proxy` honoured from user settings only). #11 (+ P): don't tag
  passthrough hosts with `x-fi-id`, or document it. #12: README CA placement and crash wording.
- **H:** #9: absolute / `~/` certificate paths only, or tracked-file confirmation. #12: report dropped `noProxy`
  entries.
- **Before release, add tests:**
  - a CONNECT to a certificate host without the loopback credential is refused; a web request with a foreign `Origin`
    to a certificate host is refused;
  - an action run with `record: build/run.json` doesn't upload it by default (or it is redacted);
  - the PAC script proxies `127.evil.example`;
  - `10.0.0.*` doesn't match `10.0.0.1.evil.example`; `*.*` and `*.com` are refused by both validators;
  - a ClientHello with `early_data` + one type-23 record is cut before that record;
  - a throttled WebSocket fed 64 MB stays under 32 MB of RSS growth;
  - a second `AndroidGlobalProxy` on the same store doesn't revert a live record;
  - a workspace `nativeClients: "proxy"` doesn't route;
  - a relative `pfx` path is refused;
  - a passthrough host's request has no `x-fi-id`, if fixed in the entry.

## Status (2026-10-10)

Fixed in `feature/0.8.0`:
- **#1** requests to a client-certificate host with a non-loopback `Origin` (web pages in the debug Chrome) are refused
  (403, `blocked`) before any upstream connection, re-checked after breakpoints / scripts; residual documented in the
  README Security section (other local processes, other emulator apps) (P, lead).
- **#2** the action never uploads the unredacted recording; `upload-recording: true` uploads a redacted copy with a
  warning (C).
- **#3** the PAC sends DIRECT only `localhost`, `*.localhost`, `[::1]` and real `127.x.x.x` literals (B).
- **#4** one host-pattern parser (`@flutter-intercept/proxy/hosts`): `*` stays within a label (a leading `*.` = any
  depth); `*`, `*.*`, `*.com`-like, wildcard last labels and wildcard IPs refused; bad entries dropped one by one and
  reported; host and proxy share it (P, H).
- **#5** a ClientHello offering TLS 1.3 early data (or unparseable) is cut at the first application-data record (P).
- **#6** throttled WebSocket queues capped at 8 MB per direction with backpressure (`ws.pause()`), else close 1013 (P).
- **#7** emulator routing records carry owner, pid and heartbeat; `recover()` / `apply()` leave other windows' live
  records alone; `isRouted()` re-checks the emulator; routed entries the proxy missed are imported (V).
- **#8** `nativeClients: "proxy"` is honoured from user settings only (lead).
- **#9** client-certificate paths must be absolute or `~/` (H).
- **#10** no pinned `--web-browser-debug-port`: web screenshots find the session's own Chrome by process (same user,
  the session's recorded flags), use its port only if that pid owns the listener, and capture only the page whose
  origin is the app's `webLaunchUrl` (B).
- **#11** documented (README Security): passthrough hosts receive the opaque per-session `x-fi-id` tag.
- **#12** CI: LAN token `::add-mask::`ed, glob characters refused in artifact paths (C); README: CA in the debug source
  set, accurate crash wording (lead, V); dropped `http.noProxy` entries reported, `uploadKbps` accepted by validators (H).
