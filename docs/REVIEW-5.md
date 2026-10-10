# Review 5: v0.5.0 security (independent, `feature/0.5.0` working tree on 468367a) — findings and fix plan

Scope: WebSocket / SSE recording (`proxy/src/{intercept-proxy,frames,sse,taps}.ts`), GraphQL (`graphql.ts`, rule
routing, agent redaction), CORS (`cors.ts`, mock / block / `cors` action, `add_cors_rule`), Flutter Web
(`debug/rewrite.ts`, `ca.ts` SPKI pin, `browser.ts`), the VM service (`src/vm/**`), the new agent tools and
redaction, and the controller / webview. I read the code and ran throwaway probes (esbuild bundles of the real
modules in the session scratchpad, outside the repo): a real `InterceptProxy` against hand-made WebSocket
upstreams, a LAN-listener WebSocket SSRF probe, SSE and GraphQL timing scripts, redaction probes, and probes of the
VM profile mapping and the controller's frame budget. Single test files passed:
- webview `frames` / `state-v5` / `components-v5`: 64 tests;
- extension `vm.*`: 38 tests.

I did not run the integration, device or web suites.

Threat model as in REVIEW-1 to REVIEW-4. Also in scope here: the servers the app talks to (WebSocket / SSE peers),
pages loaded in the debug Chrome, and data the app puts into its own HTTP profile. "Agent" means a possibly
prompt-injected agent that has only our tools. READ tools need no confirmation.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MED | WebSocket pass-through has no message size limit upstream (mockttp `maxPayload: 0`, permessage-deflate included). One compressed server message of about 2 MB inflates to 2 GB inside the extension host: **+3.6 GB RSS**. A little more crashes it. No rule or setting is needed. This predates 0.5.0, but 0.5.0 now owns this path. | P |
| 2 | MED | VM profile import: the 1 MB body cap is applied only after the whole body is in memory. `getHttpProfileRequest` returns bodies as JSON number arrays (~4 bytes of JSON per byte). Requests of any size, and responses of unknown length, are fetched. | V |
| 3 | LOW-MED | CORS is wider than it looks. By default the `cors` action, mock / block answers and local preflights **reflect any Origin (incl. `null`) and send `Allow-Credentials: true`**. The `add_cors_rule` confirmation and rule name mention credentials only when `allowCredentials: true`. With a broad URL, any page in the debug Chrome can read credentialed API responses, and private-network preflights are approved. Local preflights also cover every GraphQL operation and are cached for 600 s after the rule is gone. | P + H |
| 4 | LOW-MED | Frame memory and panel budget. SSE `event:` / `id:` are each kept up to 64 KB. The panel budget ignores them: **26 MB per update** for one stream, re-sent at up to 10 Hz. Frames of open streams count toward the 256 MB store budget but can't be evicted, so a few heavy streams make the store evict **every finished exchange**. Every update re-sends the whole frame window. | P + W/H |
| 5 | LOW-MED | Imported (`vm-profile`) URLs and errors get past agent redaction: `user:pass@` and `#fragment` are kept verbatim by `redactUrl`, and `e.error` (dart:io `HttpException … uri = <full url>`) is never redacted. | H |
| 6 | LOW | `browserInternal` tagging hides traffic from **any** proxy client while a web session runs: `Sec-Fetch-Site: none` set by dart:io, a LAN iPhone or a hostile package. Agents' list / wait / assert tools exclude it by default. | P |
| 7 | LOW | VM import doesn't validate metadata: no caps on URL, method, headers or error, bidi methods pass, `NaN` status is kept. A non-finite `startTime` makes `buildHar` throw, which breaks **every** HAR export while that exchange is stored. | V (+ H for HAR) |
| 8 | LOW | Agent redaction gaps. A JWT anywhere in a JSON `query` document turns off argument redaction for that document (`password: "pw"` stays in clear). Also missed: list values, `$var` default values, `\r`-terminated comments, and tokens carried in `Sec-WebSocket-Protocol`. | H |
| 9 | LOW | GraphQL `operationName` is neither validated nor capped. Look-alike names (zero-width characters) show as `GQL getUser`, but a rule for `getUser` never matches and "Mock this" fails. Names of any length go out in agent summaries. | P |
| 10 | LOW | Flutter Web: the SPKI pin and the proxy are added even when the user passes their own `--web-browser-flag=--user-data-dir=…`. Their real Chrome profile then runs MITM-trusted and fully recorded (agent-readable, redacted). | B |
| 11 | LOW | SSE decoding has no cap on inflated bytes. A gzip bomb of tiny events costs about 13 s of extension-host CPU per GB, with memory bounded, while the server sends about 1 MB/s. | P |
| 12 | LOW | VM bookkeeping grows without bound: isolate warnings are quadratic, and 50 isolate names push out the native-client warning. Pending `tracked` entries are never evicted. Dead isolates are not pruned while `nativeClients` is off. | V |
| 13 | LOW | App- and server-controlled text in tool-written prose: isolate / package names (raw newlines in the output channel; bidi characters in `get_status` warnings), and unquoted, uncapped `Access-Control-*` values in `cors.problem`. | V + P |
| 14 | LOW | VM heuristics can be spoofed: a background isolate named `main`, any `proxyDetails` (Charles, a corporate proxy), or an `x-fi-id` header on a package entry hides traffic from import. | V |
| 15 | LOW | VM cost in the app: HTTP timeline logging is turned on in every isolate, including main, and never turned off. Polling isn't gated (`isWatched` is not passed). | V + lead |
| 16 | LOW | The controller doesn't call `ruleProblem()`: `ws://… fault:truncate` and `ws://… + graphqlOperation` rules are accepted and are silently dead. | H |
| 17 | INFO | Smaller items: the VM watcher is never attached; HAR has raw binary frames; the WebSocket SSRF error text is generic; every JSON upload is parsed for GraphQL; UI nits. | various |

## Details

### 1 (MED) WebSocket messages from the server are unbounded (permessage-deflate bomb)
`node_modules/mockttp/dist/rules/websockets/websocket-step-impls.js:139-149, 300-325`. The upstream side is created
with `createWebSocketFromStream(…, {maxPayload: 0})`, and its `PerMessageDeflate({}, false)` also has no
`maxPayload`, so `ws` 8.22 inflates and buffers a whole message with no limit. The app side (`WebSocket.Server`)
keeps ws's 100 MiB default. Our recorder (`intercept-proxy.ts:1874` `watchWebSocket` → `payloadFrame`) keeps
only 64 KB and adds no copy. The size problem is in the pipe itself.

Probe (`wsbomb.js`): a raw upstream answers the upgrade with `permessage-deflate` and sends one RSV1 binary frame;
the app client does not negotiate compression.

| Compressed on the wire | Message | Proxy process |
|---|---|---|
| 261 KB | 256 MB | delivered in 0.4 s, **+795 MB** RSS peak |
| 2.1 MB | 2 GB | **+3.6 GB** RSS, then `write EINVAL` and the app connection died (1006) |

A few MB more passes Node's buffer limit or the machine's memory, and that kills the extension host and every
extension in it. Any WebSocket server the app connects to can do this: a hostile or compromised backend, or a
third-party realtime service. It needs no rule and no click. Without compression the server would have to send
the bytes for real, but the result is the same. This path was already there through
`forAnyWebSocket().thenPassThrough` before 0.5.0. 0.5.0 makes WebSockets a first-class recorded path, so this is
the time to bound it.

**Fix (P):**
- Cap upstream messages, e.g. at 64 MiB, below the downstream 100 MiB. mockttp hard-codes 0, so wrap
  `require('ws').prototype.setSocket` (one `ws` instance in the tree; check this at start-up the way the taps
  check their hooks). For a client-mode socket with `maxPayload === 0`, set `options.maxPayload` and the
  `_maxPayload` of each negotiated extension. Then ws closes with 1009 and the exchange fails with a clear error.
- Alternatively, set `up._receiver._maxPayload` and `up._extensions['permessage-deflate']._maxPayload` in the
  `ws-upgrade` handler. That is too late for frames already in `upgradeHead`, so prefer the wrapper.
- Test: the 2 MB deflate bomb gives an `error` exchange (1009) and RSS stays under +200 MB.

### 2 (MED) VM profile bodies are fully transferred before the 1 MB cap
`packages/extension/src/vm/profile.ts:153-158` (`shouldFetchBodies`) checks only the **response** `contentLength`,
and only when it is a number, plus a binary content-type deny-list. `core.ts:339` then calls
`getHttpProfileRequest`, which serialises both bodies as JSON arrays of numbers. `toBody` (`profile.ts:162`)
slices at 1 MB only after JSON parsing, at about 8 bytes per body byte in a JS array.

Probe: a POST with a 500 MB request body and `application/json` → fetch. A response with length -1 and
`application/x-tar` → fetch.

Scenario: a legitimate 200 MB upload with cupertino_http, or a big chunked download. A hostile package can trigger
it on purpose through `package:http_profile`.
- DAP path: the message goes adapter → workbench → extension host (OOM / freeze).
- Profile-mode WebSocket path: `ws` closes at 100 MiB and the watcher stops for the session.

**Fix (V):**
- Fetch details only when **both** sides have a known length ≤ 1 MB: the request `contentLength` /
  `content-length`, and the response `contentLength ≥ 0`.
- Use an allow-list of textual types instead of the binary deny-list. Otherwise record the exchange without
  bodies ("body not imported: N bytes / unknown length").

### 3 (LOW-MED) CORS: reflected origins, credentials by default, and preflights broader than the rule
- `packages/proxy/src/cors.ts:173-179`:
  - `allowOriginFor` = `allowOrigin` || **the request's Origin** || `*`, and `requestOrigin` accepts `null`.
  - `credentialsFor` = `acao !== '*' && (allowCredentials ?? true)`, so credentials are **on by default**.
- `:186-203`: the preflight answer also echoes `Access-Control-Allow-Private-Network: true`.
- Used by:
  - the `cors` action (`intercept-proxy.ts` `onResponseHead`);
  - every mock / block-status answer (`addCorsToLocalResponse`, `:1625`);
  - every local preflight (`:1247`).
- Agent side: `add_cors_rule` (`agent/api.ts` `addCorsRule`) and the confirmation (`lmTools.ts:296`) add
  " + credentials" / "and `Access-Control-Allow-Credentials: true`" only when `allowCredentials === true`. The
  default rule therefore sends credentials while the user approves text that doesn't say so.

Scenarios in the debug Chrome. flutter_tools' Chrome often opens other pages: `url_launcher` opens tabs in the
same browser, and OAuth flows navigate away.
- A `cors` rule `*/api/*` (or an agent's `add_cors_rule {url:'*'}`, a valid glob) means
  `fetch('https://api.example.com/me', {credentials:'include'})` from **any** site in that browser, or from a
  sandboxed `null`-origin frame, gets `ACAO: <its origin>` + `ACAC: true` and reads the user's authenticated data.
  With `*`, the same-origin policy is effectively off for that browser, and private-network (192.168.x) preflights
  are approved. Mocks are lower impact (the content is the user's), but they get the same headers.
- Preflights are matched on the *asked* method with `ignoreGraphql: true`. A GraphQL-scoped mock therefore makes
  the proxy answer the preflight for **every** operation on that URL. The real server then receives non-simple
  requests (custom headers, PUT / DELETE) that its own preflight would have stopped. A real CORS failure for the
  other operations disappears while the rule exists.
- `max-age 600`: Chrome reuses the approved preflight for up to 10 minutes **after** the rule is removed or spent,
  which hides the real server's CORS problem during exactly the time the user is checking the fix.

This is a dev-only feature the user asked for. The issue is that its reach (any origin, credentials, every
operation, after removal) is wider than what the UI and the confirmation describe.

**Fix:**
- P:
  - Default `allowOrigin` to the web session's own origin(s): the dev-server origin(s) flutter_tools serves (the
    host knows the session; else accept only `http(s)://localhost|127.0.0.1|[::1]:*`). Never reflect `null` or a
    non-loopback origin unless the rule names it.
  - Make credentials default to false, or default to true only for the session origin.
  - Echo the private-network opt-in only when the rule's URL is a private address the user named.
  - For GraphQL-scoped rules, forward the preflight upstream and patch the answer only when the upstream refuses
    it, with a note on the exchange.
  - Use `max-age` ≤ 5 s.
- H:
  - The confirmation and rule name must state the effective origin and the credentials setting ("any website open
    in the debug browser can read these responses with its cookies" when reflecting).
  - Refuse `add_cors_rule` with `url` `*` / `*://*` (no host).

### 4 (LOW-MED) Frame memory: SSE names, the panel budget, eviction, and full re-sends
- `packages/proxy/src/sse.ts:46, 126-130`: `event` and `id` are whole field lines up to `maxLine` (64 KB + 64)
  each. `frameCost` counts them (131 KB per frame), so one open stream holds about 65 MB (500 frames).
- `packages/extension/src/ui/controller.ts:157-170` (`uiExchange`) budgets only `text + base64`. A stream of
  `event: <64 KB>\nid: <64 KB>\ndata: d\n\n` passes all 200 frames to the panel: 26.2 MB of JSON per update, re-posted
  at up to 10 Hz while the stream is open (proxy coalescing, `touch`). That is about 260 MB/s of postMessage and
  structured clone, which freezes the panel and loads the host. Even with the 2 MB budget working, every update
  re-sends the whole window for every open WebSocket / SSE exchange (K sockets × 20 MB/s).
- `intercept-proxy.ts:990-1000` (`evict`): frames of open exchanges count toward `maxStoredBodyBytes`, but live
  exchanges are never evicted. Four such streams (or about six WebSockets of 64 KB binary frames, 43 MB each) push
  the store over 256 MB. From then on, every `emitChange` evicts **all** finished exchanges, so the app's other
  traffic disappears from the panel and from agents right after it completes. The full key scan also runs on every
  frame emit.

**Fix:**
- P:
  - Cap SSE `event` at about 256 characters and `id` at about 1 KB (with `truncated`).
  - Add a per-exchange frame **byte** cap (e.g. 8 MB, oldest dropped), as well as the count cap.
  - Keep live frame bytes in a separate budget that drops old frames of live streams instead of evicting finished
    exchanges.
- H:
  - `uiExchange` uses `frameCost`.
- H / W:
  - Send frame deltas (`{id, framesFrom, frames}`), or send frames only for the selected exchange, with counts in
    list updates.

### 5 (LOW-MED) Imported URLs and errors get past agent redaction
`packages/extension/src/agent/redact.ts:217-229`: `redactUrl` keeps `scheme://authority` verbatim, including
`user:password@`, and returns the fragment raw. Proxied URLs never carry either. VM-profile URIs can: dart:io
profiles `uri.toString()`. Probe: `https://user:hunter2@api.example.com/p#access_token=SECRETabc123` comes back
unchanged. Also, `e.error` goes to agents and HAR unredacted (`api.ts:372`, `har.ts:131`), and dart:io errors embed
`uri = <full url>` with its query.

**Fix (H):**
- `redactUrl`: replace the userinfo password with `[redacted]`, and redact the fragment like a query.
- Run errors through `redactSecretValues` plus URL-in-text redaction (or always, for `captured` exchanges).

### 6 (LOW) `browserInternal` can hide any client's traffic
`packages/proxy/src/browser.ts:42-53`, applied at `intercept-proxy.ts:1029` to **every** request while a web session
runs (`!flow.send` is the only exclusion). `Sec-Fetch-Site: none` is enough. Browsers never let page JS set it, but
dart:io can, and so can:
- a concurrent mobile session;
- a LAN iPhone;
- any local process using the loopback proxy;
- a hostile package.

Such requests are hidden in the panel by default (the toolbar shows a count). Agents' `list_requests` /
`wait_for_request` / `assert_traffic` / `export_har` drop them unless `includeBrowserInternal: true`, and
`get_status` gives no hint.

**Fix (P):**
- Never tag `viaLan` requests, or requests that carried `x-fi-id` (decide before stripping it).
- Tag `Sec-Fetch-Site: none` only together with a browser User-Agent, or a `BROWSER_SERVICE_HOSTS` host.
- H: add `hiddenBrowserInternal: n` to `get_status`.

### 7 (LOW) VM import: no validation of metadata
`vm/profile.ts:98-141` (`toExchange` / `toHeaders`) → `proxyHost.record` → `sanitizeRecord`
(`intercept-proxy.ts:2064`) → `cleanHeaders`. Nothing caps or checks URL, method, header count or size, status or
error. Probe:
- a 5 MB header value is kept;
- the method `GET‮txt.exe` is accepted;
- `statusCode: NaN` is kept;
- `startTime: "x"` / `1e30` gives `startedAt: NaN`, and `buildHar` then throws "Invalid time value"
  (`har.ts:88`), so **every** HAR export (panel and `export_har`) fails while that exchange is stored.

The store's byte budget counts only bodies and frames.

**Fix:**
- V: in `toExchange`:
  - method `/^[A-Za-z]{1,16}$/`;
  - URL ≤ 8 KB, http(s), with C0 / C1 / bidi stripped;
  - ≤ 100 headers, names as tokens ≤ 256, values ≤ 8 KB, ≤ 64 KB in total;
  - status an integer 100–999;
  - `startTime` finite and in the Date range, else now;
  - error ≤ 1 KB.
- H: `buildHar` skips or clamps invalid times.

### 8 (LOW) Agent redaction gaps (GraphQL, frames, WebSocket headers)
Probes against `redact.ts`:
- `redact.ts:360`: `if (key === 'query' && cleaned === decoded) cleaned = redactGraphqlDocument(decoded)`. When
  the document contains a JWT, `redactSecretValues` changes it, so the argument pass is **skipped**:
  `{"query":"mutation { login(password: \"pw\", t: \"eyJ…\") }"}` →
  `password: \"pw\"` in clear. Fix: always run `redactGraphqlDocument(cleaned)`.
- `redactGraphqlDocument`:
  - list values after a sensitive name (`tokens: ["a","b"]`) are kept;
  - variable default values (`$password: String = "hunter2"`) are kept;
  - comments end only at `\n`, so `#c\rlogin(password: "x")` is skipped as comment, although GraphQL ends
    comments at `\r` too (the proxy's own scanner does).
- `Sec-WebSocket-Protocol` carries tokens in common setups: `access_token, <token>`, and Kubernetes'
  `base64url.bearer.authorization.k8s.io.<token>`. Neither the name nor the whole value matches, so both pass.
- Frames: text that is JSON-in-a-string (ActionCable `identifier`), `password: x` lines with leading spaces, and
  urlencoded text frames pass. These match the existing body behaviour; INFO.

**Fix (H):**
- Always redact the document.
- In `redactGraphqlDocument`: keep `sensitive` across `[` / `]` and `=` after a sensitive variable, and end
  comments at `\r` too.
- Redact each element of `Sec-WebSocket-Protocol` that is an opaque token, or follows `access_token` / `bearer`
  (also in the 101's echo).

### 9 (LOW) GraphQL `operationName` is not validated
`packages/proxy/src/graphql.ts:204, 271`: any string, up to the body size, becomes `Exchange.graphql.operationName`.
Agent rule input is limited to `^[_A-Za-z][_0-9A-Za-z]*$` (≤ 200), so the two disagree:
- `"getUser​"` shows as `GQL getUser`, but a `getUser` rule never matches;
- "Mock this" (`ruleFromExchange`) produces a rule that the host's name check rejects;
- long names leave the byte budget and reach agent summaries (`api.ts:354`) unbounded.

**Fix (P):** keep `operationName` only when it is a GraphQL Name ≤ 200. Otherwise drop it, or store it escaped and
cut with an `invalidName` flag.

### 10 (LOW) Flutter Web: the pin also lands in the user's own profile
`packages/extension/src/debug/rewrite.ts:454-488` (`webSession`). It skips when the user already sets a browser
proxy (`isBrowserProxyFlag`), but not when they pass `--web-browser-flag=--user-data-dir=…`, a common way to keep
logins and extensions while debugging. Chromium takes the last `--user-data-dir`, so a real Chrome profile (when
Chrome isn't already running on it) is started with `--proxy-server` + `--ignore-certificate-errors-spki-list=<our
CA>`. Everything browsed in that window (mail, banking) is then MITM'd, recorded in the panel and readable by agents
(redacted). Chrome's own revocation and CT checks are replaced by Node's upstream verification. The temp-profile
case is fine (see "Checked").

**Fix (B):**
- When a user `--user-data-dir` flag is present, skip web interception with a one-time notice, or ask once.
- Mention in the README that every site opened in the debug Chrome is recorded.

### 11 (LOW) SSE inflate cost
`packages/proxy/src/sse.ts:169-228`: gzip / deflate / br are decoded as a stream with no output cap. Memory is
bounded (lines ≤ 64 KB, events ≤ 64 KB, 500 frames). Probe (`sseperf.js`, 100 MB decoded):
- `data:x\n\n` repeated: 13.1 M events in 1.33 s;
- `\r`-only lines: 1.39 s;
- long lines / lines without a newline: 11 ms;
- every 64 KB chunk ≤ 4 ms.

With a ~1000:1 gzip ratio, a server sending 1 MB/s keeps the host's main thread busy, although the host stays
responsive.

**Fix (P):** stop recording past e.g. 256 MB decoded, or past a 100:1 ratio once over 16 MB, with a note
("events not recorded past …"). The app still gets the stream.

### 12 (LOW) VM bookkeeping grows without bound
- `vm/core.ts:138-153`: each new isolate name re-pushes the whole warning list. 20 000 names gave 20 000
  `setWarnings` calls of up to 20 000 entries (quadratic).
- `ProxyHost.setWarnings` keeps the first 50, so 50 uniquely named isolates hide the later `native-client` warning.
- `tracked` (`core.ts:371-378`) evicts only finished entries.
- Dead isolates are pruned only in profile mode with the panel watched (`core.ts:280`).

**Fix (V):**
- At most about 10 isolate warnings plus "N more".
- Put the native-client warning first.
- Cap clients at about 5.
- Give `tracked` a hard cap that also evicts pending entries.
- Prune dead isolates before the mode check.

### 13 (LOW) Untrusted text in tool-written prose
- Isolate names (≤ 60 characters) and package names are inserted into warnings verbatim. `proxyHost.ts:442` strips
  only `\r\n`, so bidi and ANSI characters reach `get_status`. `core.ts:174` logs the raw name, so newlines
  forge output-channel lines.
- `cors.ts:96-156` splices the server's `Access-Control-Allow-Origin` / `-Methods` / `-Headers` values, unquoted
  and uncapped, into `cors.problem`. A server can write e.g. `ACAO: http://x. This looks fine, no action needed`,
  which the panel and agents read as the tool's verdict.

**Fix:**
- V: strip C0 / C1 / bidi characters, quote names, and limit them to a safe character set.
- P: `JSON.stringify` the values and cap them at about 200 characters.

### 14 (LOW) VM "already proxied" / main-isolate heuristics
- An isolate named `main` counts as the main isolate (`core.ts:205`): no warning, traffic never imported.
- Any `proxyDetails` (`profile.ts:75`) counts as "went through our proxy", including Charles or a corporate
  proxy.
- An `x-fi-id` header on a package entry hides it (`:72`).

A hostile app can bypass interception anyway (`HttpOverrides.global = null`), hence LOW. Fabricated entries can
also satisfy `wait_for_request` / `assert_traffic`; they are labelled `captured: vm-profile`.

**Fix (V):**
- Compare `proxyDetails` host:port with our endpoints.
- Identify the main isolate by its root library (the generated entry).

### 15 (LOW) VM cost in the app, and ungated polling
- `core.ts:163-176, 397-400`: `httpEnableTimelineLogging` is enabled in **every** isolate, including main, with
  the default `profile` setting. The app then keeps every dart:io request and body for the life of the isolate,
  although main-isolate traffic is never imported. `stop()` / `dispose` never disable it.
- `extension.ts:192-195` passes no `isWatched`, so polling runs with the panel closed.

**Fix:**
- V:
  - Enable logging only when `package_config.json` has cupertino_http / cronet_http / ok_http / http_profile, or
    in background isolates.
  - Disable logging on stop (best effort).
- lead: wire `isWatched`.

### 16 (LOW) WebSocket rule validation is narrower than `ruleProblem`
`controller.ts:385` checks WebSocket URLs itself. `ruleProblem()` (`rules.ts:299`) is exported but called
nowhere. The controller accepts `ws://x/* fault:truncate` and `ws://x/* + graphqlOperation + block`; both are dead
rules (the second never matches). **Fix (H):** call `ruleProblem` from `validateRule` (agents inherit it).

### 17 (INFO)
- **lead:** `createVmWatcher` is created (`extension.ts:192`), but nothing calls `vm.attach(...)`, so the
  §11.4 feature never starts. When it is wired: attach intercepted Flutter sessions only, and pass `isWatched`.
- **HAR:** `_webSocketMessages` writes binary frames as raw base64 even with redaction on. That matches how HAR
  treats base64 bodies, but `get_frames` shows `[binary N bytes]`. Consider the same summary in redacted HAR.
- **WebSocket over LAN:** the SSRF guard holds. Probe through a real LAN listener:
  - no token → 407;
  - `ws://127.0.0.1`, `ws://localhost` and `ws://<own LAN IP>` → refused by the guarded agent, upstream never
    reached;
  - `ws://10.0.2.2` → no rewrite.

  The exchange error then reads "the upgrade got no answer" instead of the SSRF reason, and mockttp prints the
  `SsrfError` to the console. Show the reason; add a LAN WebSocket case to `lan.test.ts`.
- **GraphQL detection** parses every JSON request body (≤ 5 MB) once more: about 25-30 ms for 5-7 MB, and twice
  when a GraphQL-scoped rule matches the URL. A cheap prefilter (`"query"` / `"persistedQuery"` substring) avoids
  most of it.
- **Webview:**
  - "the proxy keeps the newest N" can be the UI cap;
  - `ev-badge` has no max-width;
  - `cors:p` matches several statuses;
  - warning ids are de-duplicated before the 300-character cut (possible duplicate Preact keys);
  - `addCorsRule` posts the whole rule list (it can overwrite a rule an agent added at the same moment), like the
    rule editor.
- **Device clocks:** `startedAt` of imported exchanges comes from the device clock (skew affects `sinceMs`).

## Checked, fine
- **WebSocket / SSE recording:**
  - The app's socket is never touched: listeners are attached to mockttp's own `ws` pair in `ws-upgrade` (before
    its `connection` pipe), and recording errors can't reach the pipe.
  - Text / binary / ping / pong / close payloads are cut at 64 KB, at a UTF-8 boundary.
  - 500 frames per exchange; emits are coalesced to ≤ 1 per 100 ms and cleared on finish / drop / stop.
  - mockttp's `websocket-message-*` events are not subscribed, so no extra copies are kept.
  - `x-fi-id` / `x-fi-send` are stripped in preprocessing for upgrades too (tested).
  - LAN upgrades without the token get a 407 at preprocessing.
- **Rules on upgrades:**
  - Only block / fault (not truncate) and the offline profile apply, answered on the socket.
  - Everything else passes with a note, and `times` is not used.
  - GraphQL-scoped rules never match an upgrade.
  - `ws-local` writes a fixed head (validated status, constant headers).
- **SSE parsing:**
  - Spec-conformant (CR / LF / CRLF across chunks, BOM, split UTF-8).
  - Lines and data are bounded at 64 KB.
  - Linear on hostile input (above).
  - No response body copy is kept (`skip`).
  - Unsupported encodings are reported, not decoded.
  - The head is flushed so the app sees it at once.
- **GraphQL scanner:**
  - Linear on hostile 5-8 MB documents: deep or unbalanced braces, 1.7 M comments, escaped block strings,
    parentheses, fragments, unterminated names. 0.4-57 ms in every case.
  - Batches are capped at 100.
  - `?extensions=` is parsed only up to 64 KB.
- **GraphQL body routing:**
  - The route matcher stays headers-only (the 0.4.0 memory rule holds).
  - A GraphQL-scoped rule defers to h1 / h2 only for a known `content-length` ≤ 5 MB (= `BODY_CAP_BYTES`).
  - Streamed or larger bodies skip the rule with a note.
  - The deferred decision re-applies shaping, fault, throttle and cors.
  - Truncated or binary bodies never match.
- **CORS header injection:**
  - Reflected `Origin` / `Access-Control-Request-*` values come from Node-parsed request headers (no CR/LF), and
    outgoing headers are validated by Node.
  - User `allowOrigin` is printable ASCII, has no comma, is ≤ 500 characters, and `*` + credentials is refused
    (controller and agent).
  - Requests without `Origin` (dart:io) are never patched or diagnosed.
  - `vm-profile` and WebSocket exchanges are never diagnosed.
- **Flutter Web, default case:**
  - flutter_tools always passes its own temp `--user-data-dir`, and Chrome ignores the SPKI flag without one. Only
    certificates chaining to this install's CA are accepted, in that browser only.
  - Upstream TLS is still verified by the proxy (`ignoreUpstreamCertErrors` false).
  - Both flag values are comma-free (asserted).
  - Our exact entries are recorded in `WEB_FLAGS_KEY` and removed on re-resolve, restore, disable, release mode
    and the switch to a mobile device.
  - A user's own proxy flag wins (skip).
  - The `web-server` device is skipped with a notice.
  - Loopback stays DIRECT, so DWDS / DevTools are not proxied.
- **VM transport:**
  - Loopback-only by WHATWG parsing (`0x7f.1`, `127.1` and `2130706433` are fine; `evil.com#@127.0.0.1`,
    `127.0.0.1.nip.io` and `[::ffff:127.0.0.1]` are refused).
  - Remote URIs are not connected and not logged.
  - DAP events are accepted only from `dart` sessions.
  - No redirects or cookies.
  - The URI / token is never logged, shown or given to agents.
  - `callService` methods are constants; only the entry id (JSON-encoded) comes from the app.
  - Timers are cleared on halt / detach; one call in flight per isolate; back-off up to 30 s.
  - The dedupe key `isolateId|id` survives hot restart.
- **Read-only records:**
  - `ProxyHost.record` forces `captured`, and `update` re-adds it.
  - `toExchange` emits fixed fields only (no spoofed `initiator` / `matchedRuleId` / `source`).
  - Rules and CORS skip records.
  - Resend, mutate and rule-from-exchange are refused in the panel and for agents.
- **Agent tools:**
  - REVIEW-4 #1 / #2 hold for the new filters: `kind` is an enum and `graphqlOperation` is an exact,
    Name-validated string (no glob, no regex). URL globs still match the redacted URL (`ws(s)://` included).
  - `add_cors_rule` goes through `insertRule` (sensitive-query probe check, `validateRule`, `[agent]` prefix,
    first) and is annotated as WRITE.
  - `get_frames`:
    - redacts before cutting, uses absolute indexes, limit ≤ 500 and ≤ 200 000 characters per result;
    - binary → `[binary N bytes]`;
    - SSE ids are redacted by value;
    - errors on plain HTTP.
  - JSON frames are redacted structurally (graphql-ws `connection_init` `Authorization`, subscribe documents,
    Phoenix / Socket.IO objects); truncated JSON falls back to pair redaction; STOMP `passcode:` /
    `Authorization:` lines are redacted.
  - HAR `_webSocketMessages` / `_eventSourceMessages` text and ids are redacted the same way.
  - `get_status` warnings carry kind / text / sessionId only (no URI, no token).
  - Resend refuses `vm-profile`, WebSocket and SSE exchanges and stays same-origin.
  - `restoreRedactedQuery` restores an inner-redacted `?variables=` only on exact equality with the redacted
    original.
- **Webview:**
  - CSP unchanged (`default-src 'none'`, nonce scripts, no `unsafe-*`).
  - No HTML sinks, `href`, `eval` or `window.open` in the new code. Frame text, event names and close reasons
    render as text in their own cells.
  - Frame search uses `includes`, not a RegExp.
  - Pretty JSON runs only for one selected, non-truncated frame (linear formatter).
  - The hex dump decodes ≤ 344 base64 characters.
  - New filter tokens have fixed value lists.
  - Rule validation: `graphqlOperation` is a Name ≤ 200; `cors` takes only its two keys; `ws(s)://` rules allow
    block / fault only.
  - Warnings are sanitised host-side (known kinds, one line, ≤ 500 characters, ≤ 50 per session).

## Fix plan
- **P:**
  - #1: bound upstream WebSocket messages (wrap `ws` `setSocket` / set `_maxPayload` on receiver and deflate),
    with a 1009 → `error` exchange.
  - #3: default ACAO = the session origin (or loopback origins), never `null`; credentials not default-on;
    private-network opt-in only when named; GraphQL-scoped preflights forwarded and patched; `max-age` ≤ 5 s.
  - #4: cap SSE `event` / `id`; per-exchange frame byte cap; separate live-frame budget so live streams can't
    evict history.
  - #6: no `browserInternal` for `viaLan` / `x-fi-id` requests; `Sec-Fetch-Site: none` only with a browser UA or
    a service host.
  - #9: validate and cap `operationName`.
  - #11: decoded-bytes / ratio cap for SSE recording.
  - #13: quote and cap header values in `cors.problem`.
  - #17: show the SSRF reason on refused LAN upgrades; add a LAN WebSocket test; GraphQL prefilter.
- **V:**
  - #2: fetch bodies only for known lengths ≤ 1 MB on both sides (text allow-list).
  - #7: validate and cap imported metadata.
  - #12: cap warnings / clients / `tracked`; native-client warning first; prune dead isolates always.
  - #13: sanitise isolate and package names.
  - #14: match `proxyDetails` to our endpoints; main isolate by root library.
  - #15: enable timeline logging only where it is needed, and disable it on stop.
- **H:**
  - #3: CORS confirmation and rule name state the effective origin and credentials; refuse a host-less
    `add_cors_rule` URL.
  - #4: `uiExchange` uses `frameCost`; frame deltas or selected-only frames.
  - #5: `redactUrl` userinfo and fragment; redact `error`.
  - #6: hidden browser-internal count in `get_status`.
  - #7: `buildHar` tolerates invalid times.
  - #8: always redact GraphQL documents; lists / defaults / `\r` comments; `Sec-WebSocket-Protocol` tokens.
  - #16: `validateRule` calls `ruleProblem`.
- **B:**
  - #10: skip or ask when the user passes their own `--user-data-dir`.
- **W:**
  - #4 (with H): frame deltas.
  - #17 nits.
- **lead:**
  - #15 / #17: wire `vm.attach` for intercepted sessions, with `isWatched`.
- **Before release, add tests:**
  - a 2 MB permessage-deflate bomb is refused (1009) with RSS growth under 200 MB;
  - an SSE stream with 64 KB `event` / `id` stays within the UI budget, and finished exchanges survive four heavy
    open streams;
  - the default `cors` rule does not reflect `https://evil.example` / `null`, and a removed rule's preflight is not
    cached for minutes;
  - a dart:io request with `Sec-Fetch-Site: none` during a web session is not `browserInternal`;
  - `redactBodyText({"query":"… password: \"pw\" … eyJ…"})` hides `pw`;
  - an imported entry with a 500 MB request or an unknown response length is not body-fetched;
  - a `NaN` `startTime` does not break `export_har`;
  - a LAN `ws://127.0.0.1` upgrade is refused with the SSRF reason.

## Resolution (2026-10-10, before release)
| # | Status | Fix |
|---|---|---|
| 1 | fixed | WebSocket messages capped at 16 MB in both directions (compressed included) on the proxy's own sockets only (`src/ws-limit.ts`, wraps ws `setSocket`; start() refuses without the hook); oversize → 1009 both sides, exchange `error`. Reviewer's 255 KB → 256 MB case: +16 MB peak instead of +795 MB. |
| 2 | fixed | VM profile bodies fetched only when both lengths are known, ≤ 1 MB and textual; otherwise a `[body not imported: …]` placeholder. |
| 3 | fixed | Automatic CORS (mock/block answers, local preflights, `cors` rule without `allowOrigin`) reflects only loopback origins (localhost / 127.0.0.1 / [::1]); never `null` or other sites; no `Allow-Credentials` unless a rule sets it; max-age 5 s; private-network opt-in only for loopback. `add_cors_rule` refuses host-less URLs and names the origin policy in its name and confirmation; the panel's "Add CORS rule" confirms with the exact origin, credentials off by default. Residual (accepted): a GraphQL-scoped mock answers preflights for every operation on its URL (loopback origins only, 5 s). |
| 4 | fixed | SSE `event` ≤ 256 chars, `id` ≤ 1 KB; ≤ 8 MB of frames per exchange; open streams shed their oldest frames before finished exchanges are evicted; the panel budget counts event/id and open streams update it ≤ 2×/s; the webview caches derived frame text by frame identity. |
| 5 | fixed | `redactUrl` drops userinfo and secret fragments; `error`, `cors.problem` and HAR `_error` pass through `redactText` for agents. |
| 6 | fixed | `browserInternal` requires the Google browser-service host list; never LAN clients or requests with `x-fi-id`; `get_status.browserInternalHidden` shows how many are hidden. |
| 7 | fixed | Imported VM entries validated (method, URL, headers, status, times, error sizes); invalid ones dropped; HAR export robust to bad times. |
| 8 | fixed | GraphQL documents always redacted (a JWT no longer disables argument redaction); list values, variable defaults, `\r` comments; `Sec-WebSocket-Protocol` tokens redacted. |
| 9 | fixed | `operationName` kept only if it is a valid GraphQL Name ≤ 200 chars. |
| 10 | fixed | A web launch with the user's own `--user-data-dir` is not intercepted (no flags, notice once); README warns that everything opened in the debug Chrome is recorded. |
| 11 | fixed | SSE parsing stops after 64 MB of decoded stream (the app still gets all of it). |
| 12 | fixed | VM collections bounded (isolates 500, entries LRU 5000, warnings ≤ 10 + summary). |
| 13 | fixed | Untrusted names and values in warnings / `cors.problem` sanitised, quoted and capped. |
| 14 | fixed | Main-isolate detection no longer spoofable by name; proxied-traffic check uses `isOurProxy(host, port)`. |
| 15 | fixed | HTTP timeline logging only where needed and turned off again on detach / end / dispose. |
| 16 | fixed | The controller refuses rules that can never match (`ruleProblem()`), for the panel and agents. |
| 17 | fixed | HAR binary WebSocket frames summarised when redaction is on. |
| VM wiring | fixed | extension.ts attaches the VM watcher to every intercepted non-web session and detaches it on end. |
