# Review 10: v0.10.0 security (independent, `feature/0.10.0` at db4a1ee) — findings and fix plan

Scope: the gRPC work since the 0.9.2 plugin commit (`git diff 3098a65..HEAD`, demo signing excluded). That covers:
- the proxy: silent tunnels (`intercept-proxy.ts` `onConnect` / `runSilent` / `runTunnel`, `silent.ts`, `lan.ts`
  `isSilentMarker` / `SOCKET_SELF` / `findOnSocketChain`, `tunnel.ts`), the relay and its upstream sessions
  (`grpc.ts`, `grpc-upstream.ts`, `runGrpc` / `grpcRelay` / `grpcMock` / faults), `rules.ts` `grpcMockProblem`;
- the entry template v6 (`entry/generator.ts`, `scripts/e2e/templates/entry_v6.dart.tmpl`);
- the schema (`extension/src/grpc/**`: discovery, parser, linker, codec, service);
- the agent API (`api.ts` gRPC parts, `redact.ts` `redactGrpcMetadata`, `har.ts` `_grpc`, `schema.ts`, `lmTools.ts`);
- host wiring (`extension.ts`, `proxyHost.ts`, `ui/controller.ts`, `notify/policy.ts`, sidecar `host.ts` /
  `settings.ts`, CLI args, the IntelliJ settings page);
- the webview (`grpc.ts`, `GrpcViews.tsx`, `ActionEditor.tsx`, `RulesView.tsx`, `filter.ts`).

Spec: CONTRACTS §16 (esp. §16.7), earlier guarantees §7, §8, REVIEW-3 #4, REVIEW-8 #1. Spikes: docs/spikes/grpc.md
(incl. "As built — proxy"), docs/spikes/template-v6.md.

I read the code and mockttp 4.6.3's ALPN preference list and HTTP/2 passthrough (`http-combo-server.js`,
`request-step-impls.js`). Throwaway probes in the session scratchpad (outside the repo, Node 26):
- an esbuild bundle of the real `extension/src/grpc/index.ts`: parser timing on crafted files, schema problem texts,
  `__proto__` field / map key round trip, raw-decode worst cases;
- `proxy/dist/grpc.js` `messageFrame` on gzip bombs;
- an esbuild bundle of the real `InterceptProxy` + the repo's test helpers on a LAN listener (address below replaced by
  192.0.2.10): a silent CONNECT without credentials after an authenticated plain request on the same socket, and a
  gRPC call with a loopback `:authority` inside an authenticated h2c silent tunnel.

I did not run the unit, integration, device or CLI suites, start an IDE or touch devices.

Threat model as in REVIEW-1 to REVIEW-9: a malicious cloned repo (trusted workspace); a malicious or prompt-injected
agent that only has our tools; a malicious app under debug; hostile servers and web pages; other local users. New in
0.10.0: HTTP/2 is negotiated (h2c after a CONNECT, `h2`-only ALPN offers), and a "silent" CONNECT that is never
answered.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | LOW-MED | **Block rules, the offline profile and `replay: fail` stop applying to TLS gRPC within seconds.** On an undecrypted (default) TLS gRPC tunnel these are a close after the TLS handshake. grpc-dart reconnects at once after a connected-then-lost connection, three tunnels land within 2 s, and the entry's circuit breaker sends that authority **direct for 30 s**: the calls reach the real server, nothing is recorded, and only a debug-console line says so. Repeats every 30 s. | P + E + lead |
| 2 | LOW | **The `.pbgrpc.dart` parser is quadratic; a repo can freeze the extension host on activation.** `parseClientClass` scans back to the previous `=` for every `ClientMethod<…>(…)`. **Probe:** 1 MB crafted file → 8.0 s synchronous, 256 KB → 0.5 s (≈ 32 s per 2 MB file, minutes within the 50 MB cap). Runs on `workspaceContains:pubspec.yaml` activation, and again on every `*.pb*.dart` change. | S |
| 3 | LOW | **Every compressed gRPC message is gunzipped synchronously on the proxy's event loop (the extension host).** The 16 MB output cap bounds memory, not time. **Probe:** a 16 KB gzip message that inflates to 16 MB costs ≈ 4 ms. About 4 MB/s of such messages from a hostile server (or the app) saturates the extension host, and every extension in it stalls. | P |
| 4 | LOW | **Absolute paths of the app's files reach agents.** Schema problems are built from absolute paths (`/…/lib/gen/order.pb.dart: Order.total uses Money …`). They are returned unchanged by `get_status` (`grpc.schema.problems`) and `get_grpc_schema` (`problems`). This breaks REVIEW-3 #4 ("never an absolute path"), whatever the redaction setting. Unresolved imports are common, so this happens in normal use. | S + A |
| 5 | LOW | **`list_rules` shows a gRPC mock's `messages` (raw protobuf, base64) unredacted.** "Mock from this call" keeps a recorded response as base64 when the schema can't decode every message, and agents decode it trivially. `get_request` redacts the same message. (HTTP `mock.body` has the same pre-existing gap.) | A |
| 6 | INFO | Smaller items: no Origin check for client certificates on the gRPC relay (not reachable from browsers today); a `__proto__` field or map key is silently dropped from decoded JSON; status codes 17–999 are accepted by agents and the host but refused by the proxy; a doubled "Flutter Intercept:" prefix; the `add_grpc_mock` confirmation shows the raw `code`; raw-decoded messages are redacted by value only. | various |

## Details

### 1 (LOW-MED) Block rules, the offline profile and `replay: fail` stop applying to TLS gRPC within seconds

What the code does:
- `runTunnel` (`intercept-proxy.ts:4040–4176`) handles a silent TLS tunnel that isn't decrypted, which is the default
  for TLS gRPC (owner decision in §16). Different cases set a `cut`:
  - a block rule sets `cut = 'reset'` (`:4072`);
  - the offline profile and `replay: fail` set `cut = 'dns'` (`:4078`, `:4081`);
  - a throttle drop sets `cut = 'drop'`.
- `cutTunnel` (`:4178`) runs at the app's first application-data record, so after the TLS handshake. It destroys the
  upstream side and then `socket.end()`s or resets the app's side. Only the `timeout` fault holds the connection.
- To grpc-dart that is a connection that came up and was then lost. docs/spikes/grpc.md "Reconnect storm" measured
  215 reconnects in 5 s against an accept-and-drop server, with no backoff. template-v6.md saw the breaker trip on the
  same pattern (stale adb reverse).
- The entry's breaker (`generator.ts:497–505`): from the 4th connect to an authority with 3 tunnels in the last 2 s,
  that connect **and every connect for the next 30 s go `_grpcDirect`**, straight to the real server.

Scenario:
- The user (or an agent: `simulate_network {preset: "offline"}`, `add_block`) wants to see how the app behaves
  without its gRPC backend.
- The first call fails as expected. The channel reconnects and the breaker trips. The following calls succeed
  against production for 30 s, with no exchange in the panel. `assert_traffic` / `wait_for_request` see nothing
  either.
- The cycle repeats every 30 s. Offline demos (`replay: fail`, "keep it off the network", §12.4) leak gRPC calls the
  same way.
- Decrypted / h2c calls are not affected: there a block is a trailers-only `14` or `RST_STREAM`, and the connection
  stays up.

Evidence: code reading, plus the reconnect rate and breaker trip measured in the spikes. Not run on a device.

**Fix (P + E + lead):**
- In the proxy: never close a silent passthrough tunnel for a block, `dns` or `drop` cut. Hold it like the `timeout`
  fault: stop relaying, keep the app's socket open until the app closes it or `breakpointTimeoutMs` runs out. To the
  app that looks like an unreachable network, its deadline fires, and no reconnect storm follows.
  - Alternative: cut at the ClientHello, before the handshake completes. grpc-dart then sees a connect failure and
    uses its normal backoff. Measure it first.
- In the entry, defence in depth: when the breaker trips, the note should say that rules and network simulation don't
  apply to that authority for 30 s.
- Better still: the proxy reports breaker trips. The entry could send a silent CONNECT that only carries
  `Flutter-Intercept-Breaker: <authority>` and closes it at once. The proxy then records a warning exchange or
  session warning.
- Device test: Android emulator with TLS gRPC + the offline profile. No call reaches the server within 60 s.

### 2 (LOW) The `.pbgrpc.dart` parser is quadratic; a repo can freeze the extension host on activation

`parse.ts:501`, inside the `ClientMethod` loop:

```ts
let k = j - 1;
while (k > open && !isP(toks[k], '=')) k--;
```

Without a `=` between them, every occurrence scans back to the class start.

Probe: one `class XClient extends Client { ClientMethod<A, B>('/p.S/M0') … }` with n occurrences, through
`loadGrpcSchema`:

| n | Bytes | Time |
|---|---|---|
| 2 000 | 65 KB | 39 ms |
| 8 000 | 263 KB | 506 ms |
| 32 000 | 1.08 MB | 8 049 ms |

`schema.ts` also copies `messagesByBase` arrays and matches enums × sibling messages; that part is milder (8 000 + 8 000
in one file, 1.6 MB: 734 ms).

- The extension activates on `workspaceContains:pubspec.yaml`. `grpc.ready()` scans right away
  (`extension.ts`, `void grpc.ready()`), on the extension-host thread, and the file watcher re-runs it after every
  `*.pb*.dart` change.
- Discovery allows 2 MB per file and 50 MB in total, so a cloned repo with a few crafted `lib/x.pbgrpc.dart` files
  blocks the extension host for minutes, each time it is opened. The sidecar (IntelliJ) has the same loop.
- Denial of service only. It needs a trusted workspace: the extension doesn't declare `untrustedWorkspaces`, so it is
  disabled in Restricted Mode.

**Fix (S):**
- Remember the index of the last `=` (and its identifier) while walking forward, or bound the backward scan to a few
  tokens: generated code is `static final _$x = $grpc.ClientMethod<…>(`.
- Add a per-file token budget, for example skip a file after ~2 M tokens or 200 ms of parsing with a problem
  "too complex to read".
- Build `messagesByBase` with `push` and index the enum parents with a map.
- Optionally parse in a worker, or yield between files, so the extension host stays responsive.
- Test: the 1 MB file above loads in under 300 ms.

### 3 (LOW) Every compressed gRPC message is gunzipped synchronously on the proxy's event loop

`grpc.ts:223`: `messageFrame` calls `zlib.gunzipSync` / `inflateSync` with `maxOutputLength: 16 MB` for every
complete compressed message up to 4 MB, in both directions.
- Callers: the request parser (`intercept-proxy.ts:3395`) and the response parser (`:3737`).
- It runs for every message, even past the frame cap, although only the first 64 KB are kept.
- In VS Code the proxy runs inside the extension host (`proxyHost.ts`), so the main thread of every extension.

Probe (`proxy/dist/grpc.js`):
```
gzip of 16 MB − 1 zeros: 16 328 bytes → 4.1 ms per message (amplification ≈ 1 000×)
gzip of 64 MB zeros (over the cap, RangeError caught): 65 250 bytes → 3.8 ms per message
```

A hostile server the app talks to, or a malicious app, sends `grpc-encoding: gzip` messages like these. At ~4 MB/s
(easy on loopback or Wi-Fi) the event loop is fully busy decompressing: other traffic stalls, and so does the editor's
extension host. Legitimate large compressed streams cost the same (4 MB → 16 MB is tens of ms each).

**Fix (P):**
- Decompress only what is kept. Use a streaming `zlib.createGunzip()` / `createInflate()` fed the kept bytes, and stop
  after `FRAME_PAYLOAD_CAP + 1` bytes of output. When it stops early, record `size` as the wire size with a flag (for
  example `sizeUnknown: true`, or "≥ 64 KB" in the UI) instead of the full decompressed size.
- Or keep a per-exchange decompression budget (for example 64 MB of output, then compressed messages are only
  counted) and a global rate limit.
- Test: 1 000 bomb messages on one call take under 100 ms of event-loop time in total.

### 4 (LOW) Absolute paths of the app's files reach agents

Problem texts are built from `GrpcSourceFile.path`, which discovery fills with the absolute path:
- `schema.ts:178`, `:324`, `:333`, `:356`, `:365`;
- `parse.ts:254`, `:298`, `:303`;
- discovery's own `could not read ${label}: ${e.message}` (`discovery.ts:223`), where Node's error text carries the
  absolute path.

The service passes them on unchanged (`service.ts` `scanOnce`). The agent API returns them, after `redactText` only:
- `get_status` → `grpc.schema.problems` (`api.ts:732`);
- `get_grpc_schema` → `problems` (`api.ts:2111`).

Probe (`loadGrpcSchema` on one file with an unresolved import and a class without `BuilderInfo`):
```
"<abs>/app/lib/gen/order.pb.dart: couldn't read class Broken (no BuilderInfo)"
"<abs>/app/lib/gen/order.pb.dart: Order.total uses Money (from 'money.pb.dart'), which isn't among the loaded generated files; its contents are shown raw"
```

`<abs>` is the user's home folder in practice. REVIEW-3 #4 made "never an absolute path" a rule for everything agents
read. Message `file`s already follow it (`schemaFile`: project-relative or base name); problems don't.

**Fix (S + A):**
- Carry a display label in `GrpcSourceFile` (discovery already builds one: root-relative or `package:<name>/…`) and use
  it in every parser / linker problem.
- Map Node error texts to a code (`EACCES`, `ENOENT`) instead of the message.
- In `AgentApi`, scrub problems as a backstop: replace absolute paths with `projectPath(p) ?? basename(p)`.
- Test: no `get_status` / `get_grpc_schema` text contains the project root or the home folder.

### 5 (LOW) `list_rules` shows a gRPC mock's `messages` (raw protobuf, base64) unredacted

`ruleView` (`api.ts:789`) redacts a grpcMock's `headers`, `trailers` and `messagesJson`, but returns `messages`
unchanged.
- `grpcMockRuleFromExchange` (controller, "Mock from this call") stores a recorded response as base64 `messages`
  whenever the schema can't decode every message: no generated code in the workspace, an unknown method, or one raw
  message.
- Example: the user mocks a recorded `Login` / `RefreshToken` call. An agent calls `list_rules`, base64-decodes the
  message and reads the access token from the protobuf strings.
- `get_request` / `get_frames` / HAR show the same message redacted: by field name with a schema, and by value
  (JWT / opaque token) without one.
- HTTP `mock.body` has the same pre-existing gap (`case 'mock'` redacts headers only), which mocks made from captured
  responses also hit.

**Fix (A):**
- With redaction on, show each base64 message as the agent would see it in `get_request`:
  - decoded with the schema (the rule URL names the method) and passed through `redactJsonValue`;
  - else the raw decode, redacted by value;
  - else `"[binary N bytes]"`.
- Apply `redactBodyText` to `mock.body` the same way.
- Test: a grpcMock built from an exchange with a token-bearing message shows no token in `list_rules`.

### 6 (INFO) Smaller items

- **No Origin check for client certificates on the relay (REVIEW-8 #1).**
  - `decide()` routes gRPC to `decideGrpc` before `certRefusal`. `grpcRelay` presents `certFor(host)` for any caller.
  - Not reachable from web pages today:
    - mockttp's `fallback` ALPN list prefers `http/1.1`, and browsers always offer it;
    - browsers never speak h2c;
    - grpc-web (`application/grpc-web`) is not routed to the relay.
  - For HTTP the REVIEW-8 refusal is unchanged.
  - Defence in depth: call `certRefusal(req.url, headers)` in `decideGrpc` and answer `14`.
- **`__proto__` keys are silently dropped from decoded JSON** (`codec.ts:332` `obj[k] = x`, and `out[f.name]`).
  - A field named `__proto__` in the generated code, or a map key `__proto__` on the wire, sets the prototype of a
    fresh object instead of an own property.
  - Probe: no global pollution (`({}).polluted` stays undefined), but the entry disappears from the panel, agents and
    HAR. A hostile server can hide one map entry from the inspector.
  - Fix: `Object.defineProperty` (or `Object.create(null)` objects converted before JSON).
- **Status code range mismatch.** The agent schema (`schema.ts:70`) and `checkGrpcMock` (`controller.ts:779`) accept
  0–999, while the proxy's `grpcMockProblem` (`rules.ts:358`) refuses anything above 16. So `add_grpc_mock {code: 20}`
  reports success, but the rule is disabled in `refusedRules` and calls reach the server. Align on 0–16, or let the
  proxy accept any integer.
- **Doubled prefix:** an SSRF refusal on the relay reads
  `grpc-message: Flutter Intercept: Flutter Intercept: blocked a LAN client's request …` (`intercept-proxy.ts:3657`
  prepends the prefix to an `SsrfError` text that already has it). Seen in the probe.
- **The `add_grpc_mock` confirmation shows the raw `code`.** `grpcCodeText(i.code)` (`lmTools.ts:175`, `:445`) puts the
  raw input (≤ 40 chars, CR/LF removed) into a MarkdownString inside `**…**` without `code()`. Validation then rejects
  anything that isn't a code or name, so at worst a misleading prompt for a call that fails. Use `code()` or show only
  validated values.
- **Raw-decoded messages are redacted by value only.** Without a schema, keys are field numbers, so secret-named
  fields can't be recognised. A token stored as bytes or as a short string stays readable to agents. Worth one line in
  the tool descriptions ("without the app's generated code, redaction is by value only").

## Checked, fine

- **Silent tunnels, no auth bypass (§16.7):**
  - The LAN gate checks token + pinned peer and pre-checks the CONNECT target before anything reaches mockttp. The
    marker only turns 407 / 403 / 400 into a close.
  - Bad-token attempts are neither pinned nor recorded.
  - Probe: a silent CONNECT without credentials after an authenticated plain request on the same keep-alive socket is
    destroyed (`lanConnectAllowed`: state `plain`) and the server is never contacted.
  - The LAN listener only accepts an `HTTP/1.x` request line, so an unauthenticated peer can't open an h2c session
    directly.
  - Silent sockets stay in the gate's set and per-IP counts (caps), and the first-byte wait is 30 s.
- **The marker only means something on CONNECT:**
  - gate: `isConnect && isSilentMarker`;
  - `onConnect` sees HTTP/1 `connect` events only (an h2 CONNECT has a response object);
  - preprocessing strips both headers from every other request;
  - `forwardableHeaders` drops `flutter-intercept-*`, `proxy-authorization`, `x-fi-*`;
  - `runTunnel` records the CONNECT without `proxy-authorization` / marker / timeout;
  - `connectTunnel` builds its own CONNECT upstream.
- **Head and payload in one chunk:** node's parser hands the rest over as `head`. `firstBytes` puts bytes back with
  `unshift` and resets `readableFlowing`. Classification never reads past the first chunk.
- **Injected sockets keep their LAN gate:**
  - `SOCKET_SELF` and `session.socket` in `findOnSocketChain` reach the raw gate socket from HTTP/2 socket proxies,
    TLS sockets and `Http2Session`s;
  - `checkLanRequest`, the LAN deny rule and the guarded agents (`pickAgent` returns a guarded `http.Agent`, which
    turns off mockttp's http2-wrapper path) apply to non-gRPC h2;
  - probe: a gRPC call with `:authority 127.0.0.1:<port>` inside an authenticated h2c tunnel gets trailers-only `14`
    "blocked a LAN client's request …", and the loopback server sees no connection.
- **Upstream sessions:**
  - The pool key includes the LAN gate id, TLS verify flag, certificate pattern, upstream proxy and alias, so sessions
    are never shared across gates or with loopback clients.
  - `destroyGate` runs on `closeLan`, and the relay refuses when the gate is closed.
  - Every new session goes through `openTunnelUpstream`, which resolves and checks the address (DNS rebinding) and
    connects to that address.
  - TLS verifies the hostname (`servername`), not the resolved IP. Certificate options are spread first, so they can't
    override `rejectUnauthorized`.
  - The connect deadline covers TCP / CONNECT / TLS / preface, and anything that completes late is destroyed.
  - `Flutter-Intercept-Connect-Timeout` is digits only, at most 60 s.
- **Parsers bounded:**
  - `GrpcMessageParser` keeps ≤ 64 KB (≤ 4 MB compressed), counts the rest, and stops at a bad flag.
  - Decompression is capped at 16 MB (but see #3).
  - Raw decode is work-limited with depth 32. Probe: 64 KB worst cases in 3–5 ms.
  - Varints become 64-bit strings, and encode / decode depth is checked.
  - The parser tokenizes only and never evaluates (but see #2).
- **Discovery:** no symlinks; every read real-resolves inside its root or package root; UNC and remote
  `package_config` entries are refused; 5000 files / 2 MB / 50 MB / 300 k entries caps.
- **Redaction for agents:**
  - `redactGrpcMetadata`: names, credential values, every custom `-bin`;
  - decoded messages through `redactJsonValue`;
  - `statusMessage` through `redactText`;
  - redacted HAR carries no message bytes (`[binary N bytes]` when not decodable);
  - `get_frames` never returns raw bytes;
  - notifications run `neutralizeText` + `redactText`;
  - resend / replay refuse gRPC.
- **Agent writes:**
  - `add_grpc_mock` is a write tool (refused under `readOnly`, confirmation), while `get_grpc_schema` is read-only;
  - rules get the `[agent]` prefix;
  - ≤ 100 messages, ≤ 4 MB in total, `delayMs` / `gapMs` ≤ 600 s;
  - schema `file`s are project-relative or a base name.
- **grpcMock header validation, in the host (`checkGrpcMock`) and the proxy (`grpcMockProblem`):**
  - pseudo headers, `content-type`, `grpc-status` / `grpc-message`, hop-by-hop headers and `te` are refused;
  - header names must be tokens, and values can't contain CR / LF / NUL;
  - a refused rule is disabled, not dropped;
  - `grpc-message` is percent-encoded.
- **Decrypt hosts (workspace scope by design):**
  - same host-pattern parser as `tlsPassthrough`, and `tlsPassthrough` wins;
  - decryption only succeeds when the app trusts our CA, which grpc-dart's default credentials don't;
  - so a repo can at most make TLS gRPC fail its handshake (then the breaker goes direct), and can't expose traffic
    from apps that don't already accept our CA.
- **Entry v6:**
  - `Proxy-Authorization` is written only in the head sent to the proxy address;
  - no `_note` includes the define;
  - direct connects use the previous or plain overrides;
  - only grpc-dart / connectrpc frames are redirected, Unix sockets go direct;
  - installed on `IOOverrides.global` only;
  - a proxy that can't be reached → direct within the remaining timeout.
- **HTTP/2 exposure:**
  - h2 is reachable on loopback, after an authenticated LAN CONNECT, or with an h2-only ALPN offer;
  - browsers keep HTTP/1.1, so web pages can't reach the relay;
  - Node's nghttp2 carries the rapid-reset mitigations.
- **Webview:** no `innerHTML` / `href` / `dangerouslySetInnerHTML` sinks; decoded JSON, trailers and `statusMessage`
  are rendered as Preact text; CSP unchanged.
- **Settings / logs:**
  - `grpc.enabled` / `grpc.decryptHosts` are read from the normal scopes (window), and client certificates stay
    application-scope;
  - the schema log line has counts only;
  - the IntelliJ page and the CLI flags add host globs only.
