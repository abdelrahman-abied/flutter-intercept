# Changelog

## 0.14.1

### What the server sees, and turning automatic passthrough off

- The **Add client certificate** popup has a third part, **What the server sees**: the server gets the same
  certificate, but the connection comes from Flutter Intercept instead of your app and looks a little different; most
  servers don't notice, some security systems do. Use a certificate you're allowed to use for testing, ideally with a
  development or staging server.
- A request that taught Flutter Intercept to pass a server through says that the server may have logged one refused
  connection from your computer (the first try, without the app's certificate).
- New setting `flutterIntercept.autoPassthrough` (default on). Off: Flutter Intercept never tries such a server on its
  own — no passthrough, no check — and those requests keep failing with the reason until you add the certificate.
- **Add client certificate…** is also offered on a request whose server needs the app's certificate when nothing was
  passed through (automatic passthrough off, or a rule of yours keeps the server decrypted).
- Agents: `get_status` shows `autoPassthrough`; `list_requests` / `get_request` show `needsClientCertificate`; HAR
  `_needsClientCertificate`.

## 0.14.0

### Apps with their own certificate (mTLS)

- **Servers that need the app's own certificate keep working.** When a server asks for a client certificate the proxy
  doesn't have (a TLS `certificate_required` alert, a handshake failure confirmed by a short probe that sees the
  server ask for a certificate, or nginx's "No required SSL certificate was sent"), the first request fails once with
  a clear explanation. From then on that server is passed through **without decryption**, so the app talks to it
  directly with its own certificate and key, which Flutter Intercept never sees. Its keep-alive connections are
  closed so the next request already goes direct. It lasts until the proxy stops, **Try decrypting again**, or a
  certificate is added for it.
- **Apps that reject the proxy's certificate** (their own trusted roots, pinning in the TLS handshake) are handled the
  same way for HTTPS, as 0.13 did for gRPC: that server is passed through for 10 minutes after a TLS alert, or after
  two rejected handshakes within a minute.
- Never automatic when a rule of yours targets that server (so mocks and breakpoints keep working), while a recording
  is replayed, or when a certificate is already configured for it (then the server rejected that certificate, and the
  request says so).
- **Add client certificate…** on such a request (the server is filled in), or from the new **Client certificates**
  item in the status line, or **Flutter Intercept: Add Client Certificate…** in the palette: choose a PKCS#12 file or
  a PEM certificate and key, type the passphrase, save. The popup explains why the certificate is needed and that it
  stays on your computer. The file stays where it is (its location goes to the user-level
  `flutterIntercept.clientCertificates`), the passphrase to VS Code's secret storage; the panel never sees the path.
  The same list removes certificates and lets passed-through servers be tried again. No settings.json editing.
- Passed-through rows say why ("This server needs the app's own certificate: passed through without decryption.").

### Agent API
- `get_status` shows `learnedPassthrough` (host, port, reason, until). `list_requests` / `get_request` show
  `learnedPassthrough` on the request that failed and on the passed-through tunnels; HAR `_learnedPassthrough`.
- Agents can't add, read or remove certificates, and can't make a server be tried again.

### Fixes
- The panel dropped the host's answer to "decode this gRPC message" (since 0.10): decoding a gRPC call on demand in
  the panel works again.

### Performance, quality and security
- **Performance** (docs/PERF-2.md): no measurable cost on HTTPS; a server that needs a client certificate is learned
  in about a fifth of a second with a single probe, then costs almost nothing per request (0.13 failed every request).
  Spare connections an app drops no longer count as pinning. The extension is smaller: 2.59 → 2.51 MB.
- **Quality** (docs/QUALITY-2.md): one shared module for learned-host keys and limits, client-certificate code out of
  activation, long functions split.
- **Security** (docs/REVIEW-14.md, all findings fixed): a server can only make the proxy learn its own address;
  pins are per device; removing a certificate is confirmed by VS Code; a failed save keeps the previous passphrase;
  certificate locations aren't copied by Settings Sync (`machine` scope).

## 0.13.0

### gRPC-Web, grpcurl and TLS gRPC on the iOS simulator

- **gRPC-Web shown as gRPC.** Flutter Web's `GrpcWebClientChannel` calls (`application/grpc-web`, `+proto` and
  `grpc-web-text`) are listed as gRPC calls with a **gRPC-Web** badge: the method, the gRPC status, the trailers
  (from the trailer frame or a trailers-only answer) and every message, decoded with the app's schema. Streamed
  responses are read as they arrive. Filter with `grpc:web`. **gRPC mock** rules answer them in gRPC-Web format, with
  CORS headers and a local preflight. **Block** answers `14 UNAVAILABLE`. Every other rule treats them as HTTP
  requests. Not yet for gRPC-Web: message-level breakpoints, Mutate JSON (passed through with a note), gRPC script
  hooks, and resend (refused).
- **Copy as grpcurl** on gRPC calls (HTTP/2 and gRPC-Web): `-plaintext` for h2c, the metadata without protocol
  headers, `-d` with the request message(s) as JSON when the schema decodes them, and `-import-path` / `-proto` when
  the method comes from a `.proto` file in the workspace (otherwise a note that the server needs reflection). TLS is
  always verified: never `-insecure`.
- **TLS gRPC on the iOS simulator, opt-in.** `flutterIntercept.grpc.trustOnSimulator` (user settings only, off by
  default) makes the session's booted iOS simulator trust the Flutter Intercept CA. TLS gRPC with default credentials
  is then decrypted with no app change. New commands: **Trust the CA on this iOS Simulator** and **Remove the CA from
  this iOS Simulator**.
  - Only that certificate is added (never the key), and only it is removed: at session end, when the setting goes
    off, when the proxy stops, or after a crash at the next start. A CA you trusted yourself is left in place.
  - Every TLS gRPC host is decrypted only while every running session is on a trusting simulator.
  - A host whose app rejects the proxy's certificate (a TLS alert, or two rejected handshakes within a minute) is
    passed through undecrypted for 10 minutes, with a note.
  - Physical iPhones, Android and macOS are never changed.
  - The panel's status line names the trusting simulators.
- **Notes.** Informational lines (a rule that didn't apply, a message too large to pause) are now notes on the
  exchange, shown in the details, in HAR exports (`_notes`) and to agents (`notes`). `error` is only set for real
  failures.

### Agent API
- `get_request` takes `snippet: "grpcurl"` for gRPC calls, built from the redacted view.
- gRPC-Web calls are `kind: "grpc"` with `grpc.web` (`"binary"` / `"text"`), also in HAR (`_grpc.web`).
  `add_grpc_mock` and `add_block` answer them, and `resend_request` refuses them.
- `get_status` shows `grpc.simulatorTrust` (the simulators and whether every TLS gRPC call is decrypted). No agent
  tool can add or remove the trust.
- `get_request` / `list_requests` return `notes`.

### Behaviour changes
- One set of rule checks for the panel, the rules file, agents and the proxy:
  - A Map Remote target with a `?query` is refused everywhere. Such a rule in a rules file now shows as invalid.
  - Sequences have at most 50 steps everywhere (the panel allowed 20).
  - Reserved gRPC metadata is checked more strictly, with one wording: invalid names, and connection headers in
    trailers and gRPC mock headers, are refused.
- A shared gRPC mock that sets cookies or `Access-Control-*` headers now waits for approval, like an HTTP mock.
- The script templates have one source (with the gRPC hooks), so a rule made from a request starts from the same
  template as one made in the editor.

### Performance
- Activation no longer loads the proxy: `require` of the extension ~124 → ~73 ms in the PERF-1 test build, and the
  bundle 2.77 → 2.53 MB (zod locales trimmed to English).
- Proxy: gRPC CPU per unary call −11%, server-streaming throughput +14%, HTTPS small responses −25% CPU per request.
  The exchange store no longer slows down when full, streamed messages are base64-encoded only when shown, and
  response bodies are no longer buffered twice. Details: docs/PERF-1.md.

### Quality
- The proxy is split into modules behind one context, and the extension's agent API, controller and webview state
  into smaller files. Reserved gRPC metadata, status names, limits and Map Remote checks come from one shared module
  (`@flutter-intercept/proxy/grpc-meta`). Every package type-checks in its tests. Details: docs/QUALITY-1.md.

### Security
- Independent review: docs/REVIEW-13.md (gRPC-Web, grpcurl and iOS simulator trust). The gRPC-Web reader is bounded
  by frames, decoded bytes and trailers, and its trailer maps are prototype-safe. Shared gRPC mock headers need
  approval. grpcurl never uses `-insecure`. Simulator trust ends with its session and when the setting goes off.
  Learned pins need a real certificate rejection and expire. The CLI's records live outside the project and are
  written symlink-safely.

## 0.12.0

### gRPC tools complete

- **Rewrite on gRPC calls.** Request metadata, response headers and, new, **Set trailers** / **Remove trailers**
  (custom metadata only). Pseudo headers, `content-type`, `te`, `grpc-encoding`, `grpc-accept-encoding`,
  `grpc-status`, `grpc-message` and `grpc-timeout` are refused, and `-bin` values must be base64. Body replacements
  and the status don't apply to gRPC: the metadata parts still apply, with a note.
- **Scripts on gRPC calls.** `onGrpcMessage(message, context)` sees every message both ways (`json` decoded with the
  app's schema, `base64`, `size`) and may return `{json}`, `{base64}` or `{drop: true}`; `onGrpcStatus(status,
  context)` may change the final code, `grpc-message` and trailers. HTTP hooks aren't called for gRPC and vice versa;
  a script without gRPC hooks lets gRPC calls through untouched. 200 ms per hook, messages up to 1 MB, at most 1000
  per call; a throw or an invalid return sends the original and logs the error. The script templates include both
  hooks.
- **Map Remote on gRPC calls.** A matching call goes to the mapped server over HTTP/2 (`http://` → h2c, `https://` →
  TLS), with `:authority` set to the new host unless **Keep the original Host header** is ticked, and a "Mapped to …"
  note.
- **Resend and Edit and resend for gRPC calls.** **Resend** sends the recorded request messages and metadata again;
  **Edit and resend** edits the method, metadata and messages (JSON encoded with the schema, or base64). The proxy
  opens its own HTTP/2 call: up to 100 messages (4 MB each, 16 MB in total), a 60 s deadline unless `grpc-timeout`
  is given, all messages sent then a half-close. Rules, the network profile and replay apply to resent gRPC calls, as for HTTP.
- **More rules…** on a request or gRPC call opens a new **Rewrite**, **Script** or **Map remote** rule for its route
  in the rule editor.
- Only CORS and HTTP **Mock response** rules don't apply to gRPC calls now.
- CLI: shared rewrite, script and Map Remote rules apply to gRPC calls; script hooks get messages as base64 only
  (the CLI reads no schema).

### Agent API
- `resend_request` resends gRPC calls: the recorded messages, or `grpc: {messagesJson | messages}`
  (`messagesJson` values seen as `[redacted]` keep their original value).
- `add_rewrite` changes gRPC metadata and takes `response.setTrailers` / `removeTrailers`.
- `add_map_remote` maps gRPC calls too (local targets only, as before).

### Security
- Independent review: docs/REVIEW-12.md.

## 0.11.0

### gRPC parity

- **Breakpoints on gRPC calls.** Each message pauses on its own (request: the messages the app sends; response: the
  messages the server sends, then the end of the call with its status and trailers). Edit a held message as JSON
  (when the schema decodes it) or base64, drop it, or abort the call; change the final status, `grpc-message` and
  trailers. One pause at a time per call, each with its own auto-resume deadline; the other direction keeps flowing.
  Edited and dropped messages are badged in **Messages**.
- **Mutate JSON on gRPC responses.** Paths apply to each response message decoded with the app's schema (proto3 JSON);
  right-click a field of a decoded response message to add one. Without a schema, or for messages over 1 MB, messages
  go through unchanged with a note.
- **Recordings, replay and diff include gRPC calls** (file format 3). Replay answers a recorded call like a gRPC mock
  (messages with their gaps, status, trailers), on the same origin only, told apart by the first request message (in
  recorded order for redacted recordings). Calls with a cut response message are saved as incomplete and not replayed.
  The diff reports status changes, message counts per direction and the JSON shape of the first response message.
- **`.proto` files as a schema source**: proto2, proto3 and editions files in the workspace folders are read next to
  the generated Dart, which wins when both define a message or method. `node_modules`, `build`, `.dart_tool`, `Pods`
  and `.git` are skipped.
- CLI: `--record` and `--replay` include gRPC calls. The CLI reads no schema, so Mutate JSON leaves gRPC messages
  unchanged there, and redacted copies replace their messages with zeros.
- Still not on gRPC: rewrite, scripts, CORS, Map Remote and resend.

### Agent API
- `add_breakpoint` and `add_mutation` apply to gRPC calls. `list_paused` and `get_request` show `grpcPause` (the held
  message decoded and redacted, or the held status and trailers). `resume_request` takes
  `grpc: {messageJson | message | drop}` or `grpc: {status, trailers}`; `messageJson` values seen as `[redacted]`
  keep their original value.
- `save_recording`, `replay_recording`, `diff_recordings` and `list_recordings` include gRPC calls.

### Security
- Independent review: docs/REVIEW-11.md. All held gRPC data (messages being collected, queued or paused) shares one
  64 MB budget, and a pause ends with its call. Mutate decoding is bounded per message and per call. gRPC replay
  answers only the origin a call was recorded from, and LAN clients get the LAN deny rule first. Redacted recordings
  keep no request hash. `.proto` parsing stays linear and bounded (name length and problem text caps, its own file
  cap).

## 0.10.0

### gRPC

- **gRPC calls are intercepted with no app code**: grpc-dart, and connectrpc's HTTP/2 transport over plain-text h2c.
  The generated entry (template v6) sends only their connections to the proxy, through an `IOOverrides` hook; every
  other socket goes direct.
- Each call is one row with its method, gRPC status, trailers, streaming and message counts. A **Messages** tab
  decodes every message to JSON with the app's own generated `*.pb.dart` code (no `.proto` files needed), or shows
  raw field numbers. New filters: `kind:grpc`, `t:grpc`, `grpc:<status>`.
- **gRPC mock** rules: status, `grpc-message`, messages as JSON (with a **Skeleton** of the response type) or base64,
  a delay, a gap between stream messages, extra headers and trailers. **Mock this** on a call starts from its real
  response.
- Block, fault (reset, timeout, truncate, DNS), throttle, network profiles and sequences apply to gRPC calls. Rules
  with other actions never match them.
- gRPC over TLS is listed as an undecrypted tunnel by default. `flutterIntercept.grpc.decryptHosts` decrypts the
  listed hosts for apps that trust the Flutter Intercept CA in debug builds; `flutterIntercept.grpc.enabled` turns
  gRPC interception off.
- When gRPC connections to a host keep closing, the app connects to it directly for 30 s, and a warning says so.
- HAR exports include gRPC calls, and failed gRPC calls trigger notifications. Recordings, OpenAPI and Postman
  skip them.
- CLI: `--grpc-decrypt-host <glob>` and `--no-grpc`; GitHub Action inputs `grpc` and `grpc-decrypt-hosts`.

### Agent API
- New `add_grpc_mock` (messages as JSON encoded with the app's schema, or base64) and `get_grpc_schema` (methods,
  fields, streaming, example JSON).
- `list_requests`, `wait_for_request` and `assert_traffic` take `kind: "grpc"`; `assert_traffic` checks
  `expect.grpcStatus`; `get_request` and `get_frames` return decoded messages with secret-named fields and credential
  metadata redacted; `get_status` reports gRPC and the schema.

### Security
- Independent review: docs/REVIEW-10.md. Blocked or failed TLS gRPC tunnels are held instead of closed, so blocks and
  the offline profile keep applying. Compressed messages are decompressed only as far as they are kept. The schema
  parser runs in linear time with a per-file budget. Agents never see absolute paths in schema problems, and
  `list_rules` redacts mock messages and bodies.

## 0.9.1

- Same version number as the Android Studio / IntelliJ plugin 0.9.1 (which fixed its Marketplace icon). No changes in VS Code.

## 0.9.0

- **Android Studio and IntelliJ IDEA**: a preview plugin with the same engine (packages/intellij). The traffic view's
  WebSocket mode used there doesn't change anything in VS Code.
- **Security**: "Create file" from the traffic view writes silently only under `.vscode/flutter-intercept/`, refuses
  build, platform and IDE configuration files, and asks before anything else. A physical iPhone's proxy credentials
  are passed to `flutter` in a private file instead of on the command line, so they no longer appear in logs.
  Independent review: docs/REVIEW-9.md.

## 0.8.0

### CI, pinned hosts, certificates and coverage

**CI**
- A **GitHub Action** (`uses: abdelrahman-abied/flutter-intercept@v0.8.0`) runs your integration tests through the
  proxy and uploads the HAR, JUnit report and recording as artifacts.
- CI mode works with **physical iPhones** on the same Wi-Fi (token-protected LAN listener, token never printed).
- The CLI is ready to publish to npm (`flutter-intercept-cli`).

**Pinned hosts and client certificates**
- **TLS passthrough** (`flutterIntercept.tlsPassthrough`): listed hosts are tunnelled without decryption, so the app's
  own certificate pinning (Dio `validateCertificate`, native) keeps working. Tunnels show bytes and can be blocked.
- **Client certificates** (`flutterIntercept.clientCertificates`): the proxy presents your certificate to servers that
  require mTLS. Passphrases live in VS Code's secret storage.

**Coverage**
- **WebSocket and SSE recordings**: streams are saved with their messages and replayed by a stand-in server; diffs
  compare message counts and types.
- **Upload throttling**: network profiles and throttle rules slow uploads, WebSocket messages and SSE events too.
- **Flutter Web keeps working if the proxy stops** (a PAC with a direct fallback), the `web-server` device gets a
  copyable Chrome command, and agents can take screenshots of web apps.
- **Native clients on Android emulators** can be routed through the proxy (`nativeClients: proxy`); **Save CA
  Certificate…** helps trust it in a debug network security config.
- A banner names hosts whose requests **bypass the proxy** (an `HttpOverrides` zone or a custom `connectionFactory`).
- Screenshots on physical iPhones (`devicectl`).

**Smaller things**
- VS Code's `http.proxy` (user settings) is used as the upstream proxy when `flutterIntercept.upstreamProxy` is empty.
- Idle upstream connections close after 30 s; a request that fails on a stale reused connection is retried once
  (safe methods only).
- OpenAPI exports describe the auth schemes seen (bearer, basic, API key); Postman collections set request auth.
- Multipart bodies are redacted for agents (secret fields, file parts summarised).

### Agent API
- `list_requests` / `get_request` cover tunnels (`kind: "tunnel"`), client-certificate use and upload throttling;
  `get_status` lists passthrough hosts and certificate problems; `save_recording` includes WebSocket and SSE.

## 0.7.0

### Timing, scripts, exports and more

**Timing waterfall**
- A **Waterfall** column in the traffic list and a **Timing** tab show where each request's time went: DNS,
  connect, TLS, sending, waiting for the server and downloading, plus time held at breakpoints or added by a
  simulated network. Reused connections are marked. HAR exports carry the same timings.

**JavaScript scripts**
- **Script (JS)** rules run `onRequest` / `onResponse` hooks on matching traffic: edit requests and responses, or
  answer locally. Scripts run in an isolated worker with a 200 ms limit per call and no access to files, the network
  or modules; their log lines show on the request. A script can live in a workspace file.
- Shared scripts from the repo wait for your approval, like other rules that change traffic. AI agents can't add,
  change or read scripts.

**Background isolates are intercepted**
- Requests from `compute`, `Isolate.run` and `Isolate.spawn` now go through Flutter Intercept in debug sessions:
  each new isolate is set up before it runs. `flutterIntercept.backgroundIsolates: "warn"` restores the old warning.

**Export to OpenAPI and Postman**
- **Export…** writes the recorded traffic as an OpenAPI 3.1 document (paths with parameters, schemas inferred from
  every sample, examples), a Postman collection or a HAR file. Secrets are redacted unless you choose to keep them.

**Notifications and windows**
- A notification tells you when the app's requests fail while the panel is hidden, with **Show** to jump to the
  request (`flutterIntercept.notifications`: `errors`, `all` or `off`).
- **Open Traffic in New Window** moves the traffic view into its own window; **Open Traffic in Editor** opens it as
  a tab.

**CI mode**
- `flutter-intercept test` (in `packages/cli`) runs integration tests through the proxy on macOS, Android and the iOS
  simulator, with shared rules, replay, network profiles, HAR and recording output, and traffic assertions with a
  JUnit report.

**Editors**
- Open VSX packaging, for Cursor, Windsurf and VSCodium. **Connect AI Agent** has a Windsurf entry.

### Fixes
- Inside VS Code, the proxy's own connections to servers were taken over by VS Code's proxy support. That disabled
  connection reuse, the connect-time address check for iPhone (LAN) traffic, `flutterIntercept.upstreamProxy` for
  remote servers, and the emulator's `10.0.2.2` → your Mac rewrite. They work again. Your app's traffic no longer
  follows VS Code's `http.proxy` setting; use `flutterIntercept.upstreamProxy` to chain to a proxy.

### Security
- Script files, personal or shared, run only with content you approved: created in the panel, saved in VS Code, or
  approved after review. The approval dialog shows the scripts.
- Notification text can't contain links; `flutterIntercept.notifications` is read from user settings only.
- Unredacted exports default to `.dart_tool/flutter_intercept/exports/` with private file permissions and a warning
  when git would track them. Independent review: docs/REVIEW-7.md.

### Agent API
- New tools: `export_openapi`, `export_postman`, `take_screenshot` (asks for confirmation; setting
  `flutterIntercept.agent.screenshots`).
- `get_request` returns timing phases and the script log (redacted); `list_requests` takes `slowerThanMs`.

## 0.6.0

### Teams and scenarios

**Shared rules in the repo**
- Rules can live in `.vscode/flutter-intercept.json` and be committed with your project; **Share** moves a rule there.
  Teammates get them on their next pull. Shared rules run before your personal ones and can't be edited by accident
  in the panel.
- Rules from the repo that could send your app's requests elsewhere or change what it receives (Map Remote to
  another host, request rewrites, redirects, HTML/JS responses, CORS) are held until you approve them, one by one,
  in a dialog that shows exactly what each does. A rule that changes later is held again.
- Mock bodies can come from a file (**Body from file**), edited like any other file. Secrets are refused when sharing
  or writing body files.

**Scenarios**
- **Sequence** rules answer successive requests differently: "first 500, then 200", "two timeouts, then the real
  server".
- **Expire token…** on a request: the next N calls get 401, then the real server — test your token refresh.
- The **Auth flows** view shows 401 → refresh → retry timelines and warns about refresh stampedes (several refresh
  calls for one expiry).

**Record and replay**
- **Recordings**: save the current traffic, replay it as mocks (fall back to the real server, or fail like offline
  for demo mode), and diff two recordings side by side (status, JSON shape, call count and timing changes).
  Recordings stay in `.dart_tool` and are refused unredacted where git would track them.

**Map Remote, rewrite, upstream proxy**
- **Map Remote** sends matching requests to another server (staging, a local backend) while the app keeps its URLs.
- **Rewrite** sets or removes headers, changes the status, or replaces text in bodies.
- `flutterIntercept.upstreamProxy` chains Flutter Intercept to Charles, Burp or a corporate proxy (user settings
  only; shown in the panel). Local traffic never goes through it.

### Agent API
- New tools: `save_recording`, `list_recordings`, `replay_recording`, `diff_recordings`, `add_sequence`,
  `expire_token`, `add_map_remote` (local servers only), `add_rewrite`, `get_auth_flows`.

### Security
- Settings that could route traffic or widen agent access (`upstreamProxy*`, `agent.*`) are read from your user
  settings only, never from a workspace's `.vscode/settings.json`.

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
